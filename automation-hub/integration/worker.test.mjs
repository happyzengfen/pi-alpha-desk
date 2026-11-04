import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";
import * as contract from "../upstream/worker/contract.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { AutomationWorker } = await jiti.import("../../lib/automation/worker.ts");
const { automationHubClient } = await jiti.import("../../lib/automation/hub-client.ts");
const { parseAutomationConfig, compileAutomationRules } = await jiti.import("../../lib/automation/config.ts");
const { AutomationCheckpoints } = await jiti.import("../../lib/automation/checkpoint.ts");

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const receipt = (value) => `Business round finished.\n\`\`\`agent-autoloop\n${JSON.stringify(value)}\n\`\`\``;
const ask = () => receipt({ ask: [{ key: "color", title: "Choose color", text: "Choose the final color.", options: ["Blue", "Green"], about: "Checks already passed. Confirm the chosen color only." }] });

async function idle(worker) {
  const deadline = Date.now() + 3000;
  while (worker.status().activeRun !== null && Date.now() < deadline) await sleep(5);
  assert.equal(worker.status().activeRun, null, JSON.stringify(worker.status()));
}

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pi-automation-worker-"));
  const cwd = path.join(dataDir, "project");
  await mkdir(cwd);
  const hub = await startHub({ dataDir });
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
  if (!options.sessionFile) await writeFile(sessionFile, "fixture session\n");
  await options.onSession?.({ sessionId, sessionFile });
  return { sessionId, sessionFile, text, usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, total: 17, cost: 0.01 }, stopReason: "stop" };
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
