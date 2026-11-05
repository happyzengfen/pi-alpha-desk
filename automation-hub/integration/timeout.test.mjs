import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";
import * as contract from "../upstream/worker/contract.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { AutomationWorker } = await jiti.import("../../lib/automation/worker.ts");
const { automationHubClient } = await jiti.import("../../lib/automation/hub-client.ts");
const { compileAutomationRules } = await jiti.import("../../lib/automation/config.ts");
const { AutomationCheckpoints } = await jiti.import("../../lib/automation/checkpoint.ts");
const { executePiAutomationRound } = await jiti.import("../../lib/automation/pi-executor.ts");
const { getRpcSession } = await jiti.import("../../lib/rpc-manager.ts");
const { reserveAutomationCwd, AutomationResourceBusyError } = await jiti.import("../../lib/automation/resource-guard.ts");

test("the configured round deadline aborts a real streaming SDK call and releases resources only after settlement", { timeout: 90000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-timeout-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const dataDir = path.join(root, "hub");
  const provider = "timeout-local-fixture";
  const modelId = "fixture-model";
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((name) => [name, process.env[name]]));
  const requested = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const settled = Promise.withResolvers();
  let calls = 0;
  let worker;
  let hub;
  let sessionId;
  let signal;
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-only-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, modelId);
      assert.equal(body.stream, true);
      calls++;
      assert.equal(calls, 1, "Timeout must not start a replacement provider call");
      response.on("close", () => disconnected.resolve());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "timeout-fixture", object: "chat.completion.chunk", created: 1, model: modelId,
        choices: [{ index: 0, delta: { role: "assistant", content: "Still streaming" }, finish_reason: null }] })}\n\n`);
      requested.resolve();
    } catch (error) {
      failures.push(error);
      requested.reject(error);
      response.destroy();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await worker?.stop();
    await getRpcSession(sessionId)?.shutdown();
    await hub?.close();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  await mkdir(agentDir);
  await mkdir(cwd);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ enabledModels: [`${provider}/${modelId}`],
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only-key",
    models: [{ id: modelId, name: "Local timeout fixture", reasoning: false, input: ["text"], contextWindow: 65536,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "fixture-only-key" } }));
  hub = await startHub({ dataDir });
  const client = automationHubClient(hub.descriptor);
  const config = { version: 1, timezone: "UTC", rules: [{ id: "rule-timeout", name: "Timeout", cwd,
    prompt: "Read and report.", enabled: true, trigger: { kind: "manual" }, provider, modelId,
    timeoutMinutes: 1, maxDailyRuns: 25, emits: [] }] };
  await client.call("/v1/desktop/config", { method: "PUT", body: { config, rules: compileAutomationRules(config) } });
  worker = new AutomationWorker(client, path.join(dataDir, "descriptor.json"), {
    contract, validateCwd: async (given) => given,
    execute: async (options) => {
      signal = options.signal;
      try {
        return await executePiAutomationRound({ ...options, onSession: async (session) => {
          sessionId = session.sessionId;
          await options.onSession(session);
        } });
      } finally { settled.resolve(); }
    },
  });
  await client.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-timeout", eventId: "timeout-event" } });
  const startedAt = performance.now();
  await worker.tick();
  await requested.promise;
  assert.equal(worker.status().activeRun, 1);
  assert.equal(signal.aborted, false);
  assert.ok(getRpcSession(sessionId).isRunning());
  assert.throws(() => reserveAutomationCwd(cwd, () => false), AutomationResourceBusyError);
  const aborted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  await delay(Math.max(0, 59_000 - (performance.now() - startedAt)));
  assert.equal(signal.aborted, false);
  await aborted;
  assert.ok(performance.now() - startedAt >= 59_000, "The full production deadline must elapse");
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.message, "Automation execution timed out");
  assert.equal(worker.status().activeRun, 1, "An aborted signal alone cannot release the active execution");
  await Promise.all([settled.promise, disconnected.promise]);
  assert.equal(await worker.suspend(), true);
  assert.equal(getRpcSession(sessionId), undefined);
  const release = reserveAutomationCwd(cwd, () => false);
  release();
  const state = await client.call("/v1/state");
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].state, "cancelled");
  assert.equal((await client.call("/v1/desktop/status")).owner, null);
  assert.deepEqual(await new AutomationCheckpoints(path.join(dataDir, "worker")).list(), []);
  assert.deepEqual(failures, []);
  assert.equal(calls, 1);
});
