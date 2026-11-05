import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";
import * as contract from "../upstream/worker/contract.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { AutomationWorker } = await jiti.import("../../lib/automation/worker.ts");
const { automationHubClient } = await jiti.import("../../lib/automation/hub-client.ts");
const { parseAutomationConfig, compileAutomationRules } = await jiti.import("../../lib/automation/config.ts");
const { AutomationCheckpoints } = await jiti.import("../../lib/automation/checkpoint.ts");
const { AutomationSessionOpenError } = await jiti.import("../../lib/automation/execution-errors.ts");
const { inspectAutomationSession, saveAutomationBinding, findAutomationBinding } = await jiti.import("../../lib/automation/session-binding.ts");
const { executePiAutomationRound } = await jiti.import("../../lib/automation/pi-executor.ts");
const { getRpcSession } = await jiti.import("../../lib/rpc-manager.ts");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const receipt = (value) => `Business round finished.\n\`\`\`agent-autoloop\n${JSON.stringify(value)}\n\`\`\``;
const ask = () => receipt({ ask: [{ key: "color", title: "Choose color", text: "Choose the final color.", options: ["Blue", "Green"], about: "Checks already passed. Confirm the chosen color only." }] });

async function idle(worker) {
  const deadline = Date.now() + 3000;
  while (worker.status().activeRun !== null && Date.now() < deadline) await sleep(5);
  assert.equal(worker.status().activeRun, null, JSON.stringify(worker.status()));
}

async function fixture(t, overrides = {}, hubOptions = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pi-automation-worker-"));
  const cwd = path.join(dataDir, "project");
  await mkdir(cwd);
  const hub = await startHub({ dataDir, ...hubOptions });
  const client = automationHubClient(hub.descriptor);
  const descriptorPath = path.join(dataDir, "descriptor.json");
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    await hub.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const config = parseAutomationConfig({ version: 1, timezone: "UTC", rules: [{
    id: "rule-fixture", name: "Fixture", cwd, prompt: "Read the context and report.", enabled: true,
    trigger: { kind: "manual" }, provider: "fixture-provider", modelId: "fixture-model", ...overrides,
  }] });
  await client.call("/v1/desktop/config", { method: "PUT", body: { config, rules: compileAutomationRules(config) } });
  return {
    dataDir, cwd, hub, client, descriptorPath, config,
    worker(execute, options = {}) {
      const worker = new AutomationWorker(options.client ?? client, descriptorPath, {
        execute, contract, validateCwd: async (given) => given, ...options.dependencies,
      });
      workers.push(worker);
      return worker;
    },
    trigger: (eventId = "fixture-event") => client.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-fixture", eventId } }),
    state: () => client.call("/v1/state"),
    checkpoints: new AutomationCheckpoints(path.join(dataDir, "worker")),
  };
}

async function executeRound(f, options, text = "Business done.") {
  const sessionId = options.sessionId ?? "fixture-session";
  const sessionFile = options.sessionFile ?? path.join(f.dataDir, `${sessionId}.jsonl`);
  if (!options.sessionFile) await writeFile(sessionFile, [
    { type: "session", version: 3, id: sessionId, cwd: f.cwd, timestamp: new Date().toISOString() },
    { type: "custom", id: "managed", parentId: null, timestamp: new Date().toISOString(), customType: "desktop-automation-session", data: { version: 1 } },
  ].map(JSON.stringify).join("\n") + "\n");
  const digest = inspectAutomationSession(sessionFile).digest;
  await options.onSession?.({ sessionId, sessionFile, digest });
  return { sessionId, sessionFile, digest, text, usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17, cost: 0.01 }, stopReason: "stop" };
}

async function contextOf(options) {
  const [, file] = options.prompt.match(/这一轮的资料在 (.+?)：events/);
  return JSON.parse(await readFile(file, "utf8"));
}

test("manual trigger through worker persists ask, answer resumes the same session, and duplicate ticks do not execute twice", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const release = Promise.withResolvers();
  const began = Promise.withResolvers();
  t.after(() => release.resolve());
  const calls = [];
  const worker = f.worker(async (options) => {
    calls.push(options);
    assert.equal(options.cwd, f.cwd);
    assert.deepEqual(options.model, { provider: "fixture-provider", modelId: "fixture-model" });
    const context = await contextOf(options);
    if (calls.length === 1) {
      const round = await executeRound(f, options, ask());
      assert.equal((await f.checkpoints.list())[0].stage, "running");
      assert.equal((await f.client.call("/v1/desktop/status")).owner.session, round.sessionId);
      began.resolve();
      await release.promise;
      return round;
    }
    assert.equal(options.sessionId, "fixture-session");
    assert.equal(options.sessionFile, path.join(f.dataDir, "fixture-session.jsonl"));
    assert.equal(context.answers[0].choice, 0);
    return executeRound(f, options, "Blue confirmed.");
  });
  assert.equal((await f.trigger()).duplicate, false);
  assert.equal((await f.trigger()).duplicate, true);
  await worker.tick();
  await began.promise;
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(calls.length, 1);
  release.resolve();
  await idle(worker);
  const waiting = await f.state();
  assert.equal(waiting.runs.length, 1);
  assert.equal(waiting.runs[0].state, "done");
  assert.equal(waiting.cards.length, 1);
  assert.equal(waiting.cards[0].title, "Choose color");
  await worker.tick();
  assert.equal(calls.length, 1);
  await f.client.call(`/v1/cards/${waiting.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  const complete = await f.state();
  assert.equal(calls.length, 2);
  assert.equal(complete.runs.length, 2);
  assert.ok(complete.runs.every((run) => run.state === "done"));
  assert.ok(complete.runs.some((run) => run.summary === "Blue confirmed."));
  assert.equal(complete.cards.length, 0);
  assert.deepEqual(await f.checkpoints.list(), []);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
});

for (const loss of ["before", "after"]) {
  test(`durable result outbox recovers a ${loss}-submission network loss without rerunning business`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    let dropped = false;
    const resultPosts = [];
    const unreliable = { ...f.client, async call(endpoint, options) {
      if (/\/result$/.test(endpoint)) {
        resultPosts.push(structuredClone(options.body));
        if (!dropped) {
          dropped = true;
          if (loss === "after") await f.client.call(endpoint, options);
          throw new Error("fixture lost the result response");
        }
      }
      return f.client.call(endpoint, options);
    } };
    const execute = async (options) => { calls++; return executeRound(f, options, ask()); };
    const original = f.worker(execute, { client: unreliable });
    await f.trigger();
    await original.tick();
    await idle(original);
    assert.equal(calls, 1);
    const pending = await f.checkpoints.list();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].stage, "result");
    assert.equal((await f.state()).cards.length, loss === "after" ? 1 : 0);
    await original.stop();
    const restarted = f.worker(execute);
    await restarted.tick();
    await idle(restarted);
    assert.equal(calls, 1);
    assert.deepEqual(await f.checkpoints.list(), []);
    const acknowledged = await f.state();
    assert.equal(acknowledged.runs[0].state, "done");
    assert.equal(acknowledged.cards.length, 1);
    assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
    assert.deepEqual(pending[0].result, resultPosts[0]);
    // Replay acknowledgement must clean the same private context as the normal path.
    await assert.rejects(access(path.join(f.dataDir, "worker", `${pending[0].job.run}.context.json`)), { code: "ENOENT" });
  });
}

test("an uncertain running checkpoint blocks execution until explicit reconcile confirms the owner stopped", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.trigger();
  const claim = "interrupted-claim";
  const { job } = await f.client.call(`/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { role: "worker" });
  await f.client.call(`/v1/runs/${job.run}/started`, { method: "POST", token: job.token, body: { session: "interrupted-session" } });
  await f.checkpoints.save({ version: 1, claim, job, stage: "running", sessionId: "interrupted-session", sessionFile: path.join(f.dataDir, "interrupted.jsonl") });
  const interruptedFile = path.join(f.dataDir, "interrupted.jsonl");
  await writeFile(interruptedFile, [
    { type: "session", version: 3, id: "interrupted-session", cwd: f.cwd, timestamp: new Date().toISOString() },
    { type: "custom", id: "managed", parentId: null, timestamp: new Date().toISOString(), customType: "desktop-automation-session", data: { version: 1 } },
  ].map(JSON.stringify).join("\n") + "\n");
  await mkdir(path.join(f.dataDir, "sessions"));
  await saveAutomationBinding(f.dataDir, { version: 1, sessionId: "interrupted-session", sessionFile: interruptedFile, cwd: f.cwd,
    ruleIds: ["rule-fixture"], digest: inspectAutomationSession(interruptedFile).digest, started: true });
  let calls = 0;
  const worker = f.worker(async (options) => { calls++; return executeRound(f, options); });
  await f.trigger("second-event");
  await worker.tick();
  await worker.tick();
  assert.equal(calls, 0);
  assert.equal(worker.status().error, "execution-needs-review");
  assert.equal(worker.status().recoveryRun, job.run);
  assert.equal((await f.client.call("/v1/desktop/status")).owner.run, job.run);
  await worker.reconcile(job.run);
  assert.deepEqual(await f.checkpoints.list(), []);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  await f.trigger("new-generation");
  await worker.tick();
  await idle(worker);
  assert.equal(calls, 1);
  assert.equal((await f.state()).runs.find((run) => run.id === job.run).state, "cancelled");
});

for (const stage of ["running", "result"]) {
  test(`hub-proven reconciliation finishes local ${stage} checkpoint cleanup after an acknowledgement crash`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await f.trigger();
    const claim = `reconciled-${stage}`;
    const { job } = await f.client.call(`/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { role: "worker" });
    await f.checkpoints.save({ version: 1, claim, job, stage,
      ...(stage === "result" && { result: { outcome: "done", summary: "Business ended before the acknowledgement crash" } }) });
    await f.client.call("/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: true } });
    let calls = 0;
    const worker = f.worker(async () => { calls++; throw new Error("Reconciled business must not run again"); });
    await worker.tick();
    assert.equal(calls, 0);
    assert.deepEqual(await f.checkpoints.list(), []);
    assert.equal(worker.status().recoveryRun, null);
    assert.notEqual(worker.status().error, "execution-needs-review");
    assert.equal((await f.state()).runs.find((run) => run.id === job.run).state, "cancelled");
  });
}

test("cancelled queued work, denied directories, and an exhausted daily budget never enter the model executor", { timeout: 10000 }, async (t) => {
  await t.test("cancel before claim", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const worker = f.worker(async (options) => { calls++; return executeRound(f, options); });
    await f.trigger();
    await f.client.call("/v1/desktop/cancel", { method: "POST", body: { ruleId: "rule-fixture" } });
    await worker.tick();
    assert.equal(calls, 0);
    assert.equal((await f.state()).runs[0].state, "cancelled");
  });
  await t.test("directory refusal", async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const worker = f.worker(async (options) => { calls++; return executeRound(f, options); }, {
      dependencies: { validateCwd: async () => { throw new Error("fixture directory denied"); } },
    });
    await f.trigger();
    await worker.tick();
    await idle(worker);
    assert.equal(calls, 0);
    assert.match((await f.state()).runs[0].error, /directory denied/);
    assert.deepEqual(await f.checkpoints.list(), []);
  });
  await t.test("daily budget", async (t) => {
    const f = await fixture(t, { maxDailyRuns: 1 });
    let calls = 0;
    const worker = f.worker(async (options) => { calls++; return executeRound(f, options); });
    await f.trigger("allowed");
    await worker.tick();
    await idle(worker);
    assert.equal(calls, 1);
    await f.trigger("over-limit");
    await worker.tick();
    await idle(worker);
    assert.equal(calls, 1);
    const state = await f.state();
    assert.equal(state.runs.filter((run) => run.state === "done").length, 1);
    assert.equal(state.runs.filter((run) => run.state === "cancelled").length, 1);
    assert.equal(state.cards.length, 0);
  });
});

test("cancelling active work reaches its AbortSignal and fences a late successful receipt", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  let observedAbort = false;
  const worker = f.worker(async (options) => {
    const result = await executeRound(f, options, ask());
    started.resolve();
    await new Promise((resolve) => options.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true }));
    return result;
  });
  await f.trigger();
  await worker.tick();
  await started.promise;
  await f.client.call("/v1/desktop/cancel", { method: "POST", body: { ruleId: "rule-fixture" } });
  await worker.tick();
  await idle(worker);
  assert.equal(observedAbort, true);
  const state = await f.state();
  assert.equal(state.runs[0].state, "cancelled");
  assert.equal(state.cards.length, 0);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.deepEqual((await readdir(path.join(f.dataDir, "worker"))).filter((file) => /\.json$/.test(file)), []);
});

test("a claimed checkpoint with no started side effect resumes its original claim exactly once", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.trigger();
  const claim = "preflight-interrupted";
  const { job } = await f.client.call(`/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { role: "worker" });
  await f.checkpoints.save({ version: 1, claim, job, stage: "claimed" });
  let calls = 0;
  const worker = f.worker(async (options) => { calls++; return executeRound(f, options); });
  await worker.tick();
  await idle(worker);
  await worker.tick();
  assert.equal(calls, 1);
  const state = await f.state();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.runs[0].attempts, 0);
  assert.equal((await f.client.call("/v1/desktop/status")).dailyCounts["rule-fixture"], 1);
  assert.deepEqual(await f.checkpoints.list(), []);
});

test("receipt repair stays in the same session, stops after two tool-free attempts, and preserves completed business", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const calls = [];
  const worker = f.worker(async (options) => {
    calls.push(options);
    if (calls.length > 1) {
      assert.equal(options.repair, true);
      assert.equal(options.sessionId, "fixture-session");
      assert.equal(options.sessionFile, path.join(f.dataDir, "fixture-session.jsonl"));
      assert.equal(options.onSession, undefined);
    }
    return executeRound(f, options, "Business completed.\n```agent-autoloop\n{broken}\n```");
  });
  await f.trigger();
  await worker.tick();
  await idle(worker);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((options) => !options.repair).length, 1);
  const state = await f.state();
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.runs[0].summary, "Business completed.");
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, "Automation receipt needs review");
  await worker.tick();
  assert.equal(calls.length, 3);
});

test("an unclassified failure after started retains its original session and owner until review", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const worker = f.worker(async (options) => {
    calls++;
    await executeRound(f, options);
    throw new Error("Unclassified SDK transport/shutdown failure");
  });
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const [checkpoint] = await f.checkpoints.list();
  assert.equal(checkpoint.stage, "running");
  assert.equal(checkpoint.sessionId, "fixture-session");
  assert.equal(checkpoint.result, undefined);
  assert.equal(worker.status().recoveryRun, checkpoint.job.run);
  assert.equal((await f.client.call("/v1/desktop/status")).owner.run, checkpoint.job.run);
  assert.equal((await f.state()).runs[0].state, "claimed");
  await worker.tick();
  await worker.tick();
  assert.equal(calls, 1);
  await worker.reconcile(checkpoint.job.run);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.deepEqual(await f.checkpoints.list(), []);
});

async function nativeProviderFixture(t, api = "openai-completions", hubOptions = {}) {
  const f = await fixture(t, {}, hubOptions);
  const agentDir = path.join(f.dataDir, "agent");
  const provider = "automation-worker-local-fixture";
  const modelId = "fixture-model";
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const requests = [];
  const failures = [];
  let text = ask();
  let httpStatus = 200;
  let opaqueError = false;
  let beforeResponse;
  let readOnceFile;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer fixture-only-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, modelId);
      requests.push(body);
      await beforeResponse?.();
      if (httpStatus !== 200) {
        response.writeHead(httpStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Fixture denies this credential", type: "authentication_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (opaqueError) { response.end(`data: ${JSON.stringify({ error: { message: "401 authentication error without a denied HTTP response", type: "fixture_error" } })}\n\n`); return; }
      if (api === "pi-messages") {
        const frame = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
        frame({ type: "start" });
        frame({ type: "text_start", contentIndex: 0 });
        frame({ type: "text_delta", contentIndex: 0, delta: text });
        frame({ type: "text_end", contentIndex: 0, content: text });
        frame({ type: "done", reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        response.end();
        return;
      }
      const frame = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `local-${requests.length}`, object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (readOnceFile && requests.length === 1) {
        frame({ role: "assistant", content: "" });
        frame({ tool_calls: [{ index: 0, id: "read-before-denial", type: "function", function: { name: "read", arguments: JSON.stringify({ path: readOnceFile }) } }] });
        frame({}, "tool_calls");
        httpStatus = 401;
        response.end("data: [DONE]\n\n");
        return;
      }
      frame({ role: "assistant", content: text });
      frame({}, "stop");
      response.end("data: [DONE]\n\n");
    } catch (error) { failures.push(error); response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: modelId,
    enabledModels: [`${provider}/${modelId}`], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: { api, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: modelId, name: "Local worker fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const credentials = (enabled) => writeFile(path.join(agentDir, "auth.json"), JSON.stringify(enabled ? { [provider]: { type: "api_key", key: "fixture-only-key" } } : {}));
  await credentials(true);
  f.config.rules[0].provider = provider;
  f.config.rules[0].modelId = modelId;
  await f.client.call("/v1/desktop/config", { method: "PUT", body: { config: f.config, rules: compileAutomationRules(f.config) } });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  return { ...f, agentDir, requests, failures, credentials, respond(value) { text = value; }, status(value) { httpStatus = value; }, opaqueError() { opaqueError = true; }, beforeResponse(callback) { beforeResponse = callback; }, readThenDeny(file) { readOnceFile = file; } };
}

test("real SDK authentication recovery creates durable asks without requests or duplicate prompts and resumes the same session", { timeout: 15000 }, async (t) => {
  let now = Date.parse("2026-11-04T12:00:00Z");
  const f = await nativeProviderFixture(t, "openai-completions", { now: () => now });
  const otherCwd = path.join(f.dataDir, "other-project");
  await mkdir(otherCwd);
  const modelsFile = path.join(f.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsFile, "utf8"));
  models.providers["automation-other-fixture"] = { ...models.providers["automation-worker-local-fixture"], apiKey: "fixture-only-key" };
  await writeFile(modelsFile, JSON.stringify(models));
  const settingsFile = path.join(f.agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  settings.enabledModels.push("automation-other-fixture/fixture-model");
  await writeFile(settingsFile, JSON.stringify(settings));
  f.config.rules.push({ ...f.config.rules[0], id: "rule-other", name: "Other task", cwd: otherCwd, provider: "automation-other-fixture" });
  await f.client.call("/v1/desktop/config", { method: "PUT", body: { config: f.config, rules: compileAutomationRules(f.config) } });
  const contexts = [];
  const execute = async (options) => { contexts.push(await contextOf(options)); return executePiAutomationRound(options); };
  await f.credentials(false);
  let worker = f.worker(execute);
  await f.trigger();
  await worker.tick();
  await idle(worker);
  let state = await f.state();
  assert.equal(f.requests.length, 0);
  assert.equal(state.cards.length, 1, JSON.stringify({ state, worker: worker.status(), checkpoints: await f.checkpoints.list() }));
  assert.equal(state.cards[0].title, "Restore model authentication");
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  await worker.stop();
  worker = f.worker(execute);
  await worker.tick();
  assert.equal((await f.state()).cards.length, 1, "Restart/poll does not create repeated recovery cards");
  assert.equal(f.requests.length, 0);
  f.config.rules[0].trigger = { kind: "cron", cron: "*/5 * * * *" };
  await f.client.call("/v1/desktop/config", { method: "PUT", body: { config: f.config, rules: compileAutomationRules(f.config) } });
  now += 5 * 60_000;
  f.hub.runtime.execute("tick", []);
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 0, "A due cron is retained while the authentication card remains open");
  f.config.rules[0].trigger = { kind: "manual" };
  await f.client.call("/v1/desktop/config", { method: "PUT", body: { config: f.config, rules: compileAutomationRules(f.config) } });
  await f.trigger("waiting-event-a");
  await f.trigger("waiting-event-b");
  f.respond("The unrelated task completed.");
  await f.client.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-other", eventId: "other-event" } });
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 1, "Only the unrelated healthy rule can run during authentication waiting");
  assert.ok((await f.state()).runs.some((run) => run.rule === "rule-other" && run.state === "done"));
  assert.equal((await f.state()).cards.length, 1);
  await f.credentials(true);
  await f.trigger("restored-before-answer");
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 1, "Restoring credentials alone does not bypass the open recovery decision");
  f.respond(ask());
  await f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  state = await f.state();
  assert.equal(f.requests.length, 2);
  assert.equal(state.cards[0].title, "Choose color");
  const resumedContext = contexts.findLast((context) => context.events.some((event) => event.id === "waiting-event-a"));
  assert.ok(resumedContext.events.some((event) => event.id === "waiting-event-b"));
  assert.ok(resumedContext.events.some((event) => event.id === "restored-before-answer"));
  assert.ok(resumedContext.events.some((event) => event.type === "schedule.tick"));
  assert.ok(resumedContext.answers.length > 0);
  const sessionId = state.runs.find((run) => run.rule === "rule-fixture" && run.session).session;
  const binding = await findAutomationBinding(f.dataDir, sessionId);
  assert.equal(binding.started, true);
  await f.credentials(false);
  await f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  state = await f.state();
  assert.equal(f.requests.length, 2);
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, "Restore model authentication");
  assert.equal(state.runs.find((run) => run.rule === "rule-fixture").session, sessionId);
  const before = (await readFile(binding.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(before.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 1);
  await worker.tick();
  assert.equal(f.requests.length, 2);
  await f.credentials(true);
  f.respond("Authentication restored; remaining work completed.");
  await f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  state = await f.state();
  assert.equal(f.requests.length, 3);
  assert.equal(state.runs.find((run) => run.rule === "rule-fixture").session, sessionId);
  assert.equal(state.runs.find((run) => run.rule === "rule-fixture").state, "done");
  assert.equal(state.cards.length, 0);
  const after = (await readFile(binding.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(after.filter((entry) => entry.type === "message" && entry.message.role === "user").length, 2);
  assert.deepEqual(f.failures, []);
});

for (const mutation of ["missing", "empty", "bad-header", "valid-edit"]) {
  test(`real SDK session ${mutation} disables its task and fences existing cards and timers without rewriting`, { timeout: 15000 }, async (t) => {
    const f = await nativeProviderFixture(t);
    f.respond(receipt({ ask: [{ key: "pending", title: "Pending choice", text: "Choose", options: ["Continue", "Stop"], about: "Continue remaining work" }],
      later: [{ key: "follow-up", at: new Date(Date.now() + 3600000).toISOString(), about: "Check remaining work" }] }));
    const worker = f.worker();
    await f.trigger();
    await worker.tick();
    await idle(worker);
    const state = await f.state();
    assert.equal(f.requests.length, 1, JSON.stringify({ state, worker: worker.status() }));
    assert.equal(state.cards.length, 1);
    const sessionId = state.runs[0].session;
    const binding = await findAutomationBinding(f.dataDir, sessionId);
    let content;
    if (mutation === "missing") await rm(binding.sessionFile);
    else {
      content = mutation === "empty" ? "" : mutation === "bad-header" ? "{broken}\n" : await readFile(binding.sessionFile, "utf8") + JSON.stringify({ type: "session_info", id: "external-edit", parentId: null, timestamp: new Date().toISOString(), name: "Changed outside automation" }) + "\n";
      await writeFile(binding.sessionFile, content);
    }
    await worker.tick();
    const changed = await f.state();
    assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
    assert.equal(changed.cards.length, 0);
    await assert.rejects(f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0, expectedVersion: state.cards[0].version } }));
    assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS count FROM projections WHERE collection='timers' AND json_extract(data,'$.rule')='rule-fixture' AND json_extract(data,'$.event_id') IS NULL").get().count, 0);
    await worker.tick();
    assert.equal(f.requests.length, 1);
    assert.ok((await findAutomationBinding(f.dataDir, sessionId)).pausedReason);
    if (mutation === "missing") await assert.rejects(access(binding.sessionFile), { code: "ENOENT" });
    else assert.equal(await readFile(binding.sessionFile, "utf8"), content);
    assert.deepEqual(f.failures, []);
  });
}

for (const api of ["openai-completions", "pi-messages"]) for (const status of [401, 403]) test(`a real ${api} provider ${status} waits for human recovery and resumes its original session without autonomous retry`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t, api);
  f.status(status);
  const worker = f.worker();
  await f.trigger();
  await worker.tick();
  await idle(worker);
  let state = await f.state();
  assert.equal(f.requests.length, 1);
  assert.equal(state.cards.length, 1, JSON.stringify({ state, worker: worker.status() }));
  assert.equal(state.cards[0].title, "Restore model authentication");
  const sessionId = state.runs[0].session;
  assert.ok(sessionId);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  await worker.tick();
  await worker.tick();
  assert.equal(f.requests.length, 1);
  f.status(200);
  f.respond("Provider access restored; completed the remaining work.");
  await f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  state = await f.state();
  assert.equal(f.requests.length, 2);
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.runs[0].session, sessionId);
  assert.equal(state.cards.length, 0);
  assert.deepEqual(f.failures, []);
});

test("a completed real read followed by provider 401 waits for authentication and resumes only the remaining work", { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  const source = path.join(f.cwd, "read-once.txt");
  await writeFile(source, "completed-read-marker");
  f.readThenDeny(source);
  const worker = f.worker();
  await f.trigger();
  await worker.tick();
  await idle(worker);
  let state = await f.state();
  assert.equal(f.requests.length, 2);
  assert.equal(state.cards.length, 1, JSON.stringify({ state, worker: worker.status() }));
  assert.equal(state.cards[0].title, "Restore model authentication");
  const sessionId = state.runs[0].session;
  const binding = await findAutomationBinding(f.dataDir, sessionId);
  const readEntries = async () => (await readFile(binding.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal((await readEntries()).filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 1);
  assert.ok(f.requests[1].messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("completed-read-marker")));
  await f.trigger("waiting-after-completed-read");
  await worker.tick();
  assert.equal(f.requests.length, 2);
  f.status(200);
  f.respond("Completed only the remaining work using the already-read result.");
  await f.client.call(`/v1/cards/${state.cards[0].id}/answer`, { method: "POST", body: { choice: 0 } });
  await worker.tick();
  await idle(worker);
  state = await f.state();
  assert.equal(f.requests.length, 3);
  assert.equal(state.runs[0].session, sessionId);
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.cards.length, 0);
  assert.ok(f.requests[2].messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("completed-read-marker")));
  assert.equal((await readEntries()).filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 1, "Recovery does not replay the completed read");
  assert.deepEqual(f.failures, []);
});

test("an external valid JSONL append during a real SDK round is paused instead of being accepted as its new digest", { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  const worker = f.worker();
  let changedFile;
  f.beforeResponse(async () => {
    const [checkpoint] = await f.checkpoints.list();
    changedFile = checkpoint.sessionFile;
    const content = await readFile(changedFile, "utf8");
    await writeFile(changedFile, content + JSON.stringify({ type: "session_info", id: "concurrent-external", parentId: null, timestamp: new Date().toISOString(), name: "External change during provider request" }) + "\n");
  });
  await f.trigger();
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
  assert.equal((await f.state()).runs[0].state, "cancelled");
  assert.match(await readFile(changedFile, "utf8"), /concurrent-external/);
  await worker.tick();
  assert.equal(f.requests.length, 1);
});

test("the authentication recovery pause choice disables its task without entering the provider", { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  await f.credentials(false);
  const worker = f.worker();
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const [card] = (await f.state()).cards;
  await f.trigger("queued-before-auth-pause");
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 0);
  await f.client.call(`/v1/cards/${card.id}/answer`, { method: "POST", body: { choice: 1 } });
  await worker.tick();
  await idle(worker);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
  assert.equal((await f.state()).cards.length, 0);
});

test("an opaque provider auth error remains uncertain instead of guessing from error text", { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  f.opaqueError();
  const worker = f.worker();
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const [checkpoint] = await f.checkpoints.list();
  assert.equal(checkpoint.stage, "running");
  assert.equal(worker.status().recoveryRun, checkpoint.job.run);
  assert.equal((await f.client.call("/v1/desktop/status")).owner.run, checkpoint.job.run);
  assert.equal((await f.state()).cards.length, 0);
  await worker.tick();
  assert.equal(f.requests.length, 1);
  await worker.reconcile(checkpoint.job.run);
  await worker.tick();
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, true, "Verified SDK append is not mistaken for an external edit after reconciliation");
});

test("fresh-session fallback requires durable never-started proof, is recorded before execution, and is used once", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.trigger();
  const claim = "prepared-before-crash";
  const { job } = await f.client.call(`/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { role: "worker" });
  const preparedId = "prepared-session";
  const preparedFile = path.join(f.dataDir, "prepared.jsonl");
  await writeFile(preparedFile, [
    { type: "session", version: 3, id: preparedId, cwd: f.cwd, timestamp: new Date().toISOString() },
    { type: "custom", id: "managed", parentId: null, timestamp: new Date().toISOString(), customType: "desktop-automation-session", data: { version: 1 } },
  ].map(JSON.stringify).join("\n") + "\n");
  await mkdir(path.join(f.dataDir, "sessions"));
  await saveAutomationBinding(f.dataDir, { version: 1, sessionId: preparedId, sessionFile: preparedFile, cwd: f.cwd, ruleIds: ["rule-fixture"],
    digest: inspectAutomationSession(preparedFile).digest, started: false });
  await f.checkpoints.save({ version: 1, claim, job, stage: "claimed", sessionId: preparedId, sessionFile: preparedFile });
  const calls = [];
  const worker = f.worker(async (options) => {
    calls.push(options);
    if (options.sessionId) throw new AutomationSessionOpenError(new Error("The unchanged prepared session cannot be opened"));
    assert.equal((await f.checkpoints.list())[0].fallbackUsed, true);
    assert.equal((await findAutomationBinding(f.dataDir, preparedId)).fallbackUsed, true);
    return executeRound(f, options);
  });
  await worker.tick();
  await idle(worker);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionId, preparedId);
  assert.equal(calls[1].sessionId, undefined);
  assert.equal((await f.state()).runs[0].state, "done");
  assert.equal((await findAutomationBinding(f.dataDir, "fixture-session")).fallbackUsed, true);
  await worker.tick();
  assert.equal(calls.length, 2);
});

for (const loss of ["before-ack", "after-ack"]) test(`reviewing a crash-left SDK append is explicit and survives ${loss} loss without a false session pause`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  f.respond("The SDK finished its business round before the process disappeared.");
  const interrupted = f.worker(async (options) => {
    await executePiAutomationRound(options);
    // The durable state is exactly the hard-kill window: SDK append is on disk,
    // running checkpoint remains, and no result/final digest was acknowledged.
    throw new Error("Process disappeared before its result checkpoint");
  });
  await f.trigger();
  await interrupted.tick();
  await idle(interrupted);
  const [checkpoint] = await f.checkpoints.list();
  assert.equal(checkpoint.stage, "running");
  const oldBinding = await findAutomationBinding(f.dataDir, checkpoint.sessionId);
  const bytes = await readFile(checkpoint.sessionFile, "utf8");
  const digest = inspectAutomationSession(checkpoint.sessionFile).digest;
  assert.notEqual(digest, oldBinding.digest);
  await interrupted.stop();
  let fail = true;
  const lossy = { ...f.client, async call(endpoint, options) {
    if (endpoint === "/v1/desktop/reconcile" && fail) {
      fail = false;
      if (loss === "after-ack") await f.client.call(endpoint, options);
      throw new Error("Fixture reconciliation acknowledgement loss");
    }
    return f.client.call(endpoint, options);
  } };
  const recovering = f.worker(undefined, { client: lossy });
  await recovering.tick();
  await assert.rejects(recovering.reconcile(checkpoint.job.run), /confirm session review/);
  assert.equal((await f.client.call("/v1/desktop/status")).owner.run, checkpoint.job.run);
  assert.deepEqual(await findAutomationBinding(f.dataDir, checkpoint.sessionId), oldBinding);
  assert.equal(await readFile(checkpoint.sessionFile, "utf8"), bytes);
  await assert.rejects(recovering.reconcile(checkpoint.job.run, { confirmedSessionReviewed: true }), /acknowledgement loss/);
  const reviewed = await findAutomationBinding(f.dataDir, checkpoint.sessionId);
  assert.equal(reviewed.digest, digest);
  assert.equal(reviewed.reviewedRun, checkpoint.job.run);
  assert.ok(Number.isFinite(Date.parse(reviewed.reviewedAt)));
  assert.equal(reviewed.pausedReason, undefined);
  assert.equal((await f.checkpoints.list())[0].stage, "running");
  await recovering.stop();
  const restarted = f.worker();
  await restarted.tick();
  if (loss === "before-ack") await restarted.reconcile(checkpoint.job.run);
  await restarted.tick();
  assert.deepEqual(await f.checkpoints.list(), []);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, true);
  assert.equal((await findAutomationBinding(f.dataDir, checkpoint.sessionId)).digest, digest);
  assert.equal(await readFile(checkpoint.sessionFile, "utf8"), bytes);
  f.respond("The new generation completed once after explicit review.");
  await f.trigger(`new-generation-${loss}`);
  await restarted.tick();
  await idle(restarted);
  assert.equal(f.requests.length, 2);
  assert.equal((await f.state()).runs[0].state, "done");
  assert.equal((await f.state()).runs.find((run) => run.id === checkpoint.job.run).state, "cancelled");
});

for (const damage of ["missing", "empty"]) test(`reconciling a ${damage} running session disables it before releasing ownership and never rebuilds it`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  const interrupted = f.worker(async (options) => { await executePiAutomationRound(options); throw new Error("Process interrupted before result persistence"); });
  await f.trigger();
  await interrupted.tick();
  await idle(interrupted);
  const [checkpoint] = await f.checkpoints.list();
  if (damage === "missing") await rm(checkpoint.sessionFile);
  else await writeFile(checkpoint.sessionFile, "");
  await interrupted.reconcile(checkpoint.job.run, { confirmedSessionReviewed: true });
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
  assert.ok((await findAutomationBinding(f.dataDir, checkpoint.sessionId)).pausedReason);
  if (damage === "missing") await assert.rejects(access(checkpoint.sessionFile), { code: "ENOENT" });
  else assert.equal(await readFile(checkpoint.sessionFile, "utf8"), "");
  await interrupted.tick();
  assert.equal(f.requests.length, 1);
});

const invalidBusinessReceipt = "Business completed once.\n```agent-autoloop\n{broken}\n```";

async function externalAppend(file, marker) {
  await writeFile(file, await readFile(file, "utf8") + JSON.stringify({ type: "session_info", id: marker, parentId: null,
    timestamp: new Date().toISOString(), name: marker }) + "\n");
}

function shutdownBarrier(session, action) {
  const runner = getRpcSession(session.sessionId).inner.extensionRunner;
  const original = runner.emit.bind(runner);
  runner.emit = async (event, ...args) => {
    if (event.type === "session_shutdown" && event.reason === "quit") await action(session);
    return original(event, ...args);
  };
}

for (const failure of ["401", "opaque"]) test(`a real repair ${failure} preserves one completed business round and accepts only its verified settled append`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  f.respond(invalidBusinessReceipt);
  f.beforeResponse(() => { if (f.requests.length === 2) { if (failure === "401") f.status(401); else f.opaqueError(); } });
  const calls = [];
  const worker = f.worker(async (options) => { calls.push(options); return executePiAutomationRound(options); });
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const state = await f.state();
  assert.equal(f.requests.length, 2);
  assert.equal(calls.filter((call) => !call.repair).length, 1);
  assert.equal(calls.filter((call) => call.repair).length, 1);
  assert.ok(!f.requests[1].tools?.length);
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.runs[0].summary, "Business completed once.");
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, "Automation receipt needs review");
  const binding = await findAutomationBinding(f.dataDir, state.runs[0].session);
  assert.equal(binding.digest, inspectAutomationSession(binding.sessionFile).digest);
  await worker.tick();
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, true);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.deepEqual(await f.checkpoints.list(), []);
  assert.equal(f.requests.length, 2);
});

for (const failure of ["success", "401", "opaque"]) test(`an external append during ${failure} shutdown is not adopted across the verified digest handoff`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  f.respond("Business completed before the shutdown barrier.");
  if (failure === "401") f.status(401);
  if (failure === "opaque") f.opaqueError();
  let snapshot;
  const worker = f.worker((options) => executePiAutomationRound({ ...options, onSession: async (session) => {
    snapshot = session;
    await options.onSession(session);
    shutdownBarrier(session, ({ sessionFile }) => externalAppend(sessionFile, `shutdown-${failure}`));
  } }));
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const binding = await findAutomationBinding(f.dataDir, snapshot.sessionId);
  assert.ok(binding.pausedReason);
  assert.notEqual(binding.digest, inspectAutomationSession(snapshot.sessionFile).digest);
  assert.match(await readFile(snapshot.sessionFile, "utf8"), new RegExp(`shutdown-${failure}`));
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
  assert.equal((await f.state()).cards.some((card) => card.title === "Restore model authentication"), false);
  if (failure === "success") {
    const [checkpoint] = await f.checkpoints.list();
    assert.equal(checkpoint.stage, "running");
    assert.equal(checkpoint.result.outcome, "done");
    assert.equal(checkpoint.result.summary, "Business completed before the shutdown barrier.");
    assert.equal((await f.client.call("/v1/desktop/status")).owner.run, checkpoint.job.run);
    assert.equal(worker.status().recoveryRun, checkpoint.job.run);
  } else assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal(f.requests.length, 1);
  await worker.tick();
  assert.equal(f.requests.length, 1);
});

for (const callback of ["onPrepared", "onSession"]) test(`the real ${callback} callback cannot adopt bytes changed after its verified snapshot`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  let snapshot;
  const worker = f.worker((options) => executePiAutomationRound({ ...options, [callback]: async (session) => {
    snapshot = session;
    await externalAppend(session.sessionFile, `changed-${callback}`);
    await options[callback](session);
  } }));
  await f.trigger();
  await worker.tick();
  await idle(worker);
  assert.ok(snapshot.digest);
  assert.notEqual(snapshot.digest, inspectAutomationSession(snapshot.sessionFile).digest);
  assert.equal((await f.client.call("/v1/desktop/status")).config.rules[0].enabled, false);
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal(f.requests.length, 0);
  const binding = await findAutomationBinding(f.dataDir, snapshot.sessionId);
  if (binding) assert.notEqual(binding.digest, inspectAutomationSession(snapshot.sessionFile).digest);
});

for (const failure of ["uncertain", "external-change"]) test(`a real ${failure} repair retains ownership and the original business conclusion until receipt-only reconciliation`, { timeout: 15000 }, async (t) => {
  const f = await nativeProviderFixture(t);
  f.respond(invalidBusinessReceipt);
  f.beforeResponse(() => { if (f.requests.length === 2) f.respond(receipt({})); });
  const calls = [];
  const worker = f.worker(async (options) => {
    calls.push(options);
    if (!options.repair) return executePiAutomationRound(options);
    return executePiAutomationRound({ ...options, onPrepared: async (session) => {
      shutdownBarrier(session, async ({ sessionFile }) => {
        if (failure === "uncertain") throw new Error("Fixture cannot confirm repair shutdown");
        await externalAppend(sessionFile, "external-repair-append");
      });
    } });
  });
  await f.trigger();
  await worker.tick();
  await idle(worker);
  const [checkpoint] = await f.checkpoints.list();
  assert.equal(checkpoint.stage, "running");
  assert.equal(checkpoint.result.outcome, "done");
  assert.equal(checkpoint.result.summary, "Business completed once.");
  assert.equal((await f.client.call("/v1/desktop/status")).owner.run, checkpoint.job.run);
  assert.equal(worker.status().recoveryRun, checkpoint.job.run);
  assert.equal(f.requests.length, 2);
  assert.equal(calls.filter((call) => !call.repair).length, 1);
  await worker.stop();
  const restarted = f.worker();
  await restarted.tick();
  assert.equal(f.requests.length, 2);
  await restarted.reconcile(checkpoint.job.run, { confirmedSessionReviewed: true });
  await restarted.tick();
  const state = await f.state();
  assert.equal(state.runs.find((run) => run.id === checkpoint.job.run).state, "done");
  assert.equal(state.runs.find((run) => run.id === checkpoint.job.run).summary, "Business completed once.");
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal(state.cards.some((card) => card.title === "Automation receipt needs review"), true);
  assert.deepEqual(await f.checkpoints.list(), []);
  assert.equal(f.requests.length, 2, "Reconciliation submits only the saved business receipt, never another model prompt");
});
