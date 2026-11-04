import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession, hasBusyRpcSessionForCwd, AUTOMATION_TOOL_NAMES } = await jiti.import("../rpc-manager.ts");
const { reserveAutomationCwd } = await jiti.import("./resource-guard.ts");
const { inspectAutomationSession } = await jiti.import("./session-binding.ts");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-rpc-startup-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const environment = new Map(["PI_CODING_AGENT_DIR", "PI_AUTOMATION_DESCRIPTOR", "PI_AUTOMATION_CONTROL_KEY", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
  const globals = new Map(["__piSessions", "__piStartLocks", "__piStartingSessionCwds", "__piAutomationResources", "__piAutomationRuntime"].map((key) => [key, globalThis[key]]));
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled([...(globalThis.__piSessions?.values() ?? [])].map((session) => session.shutdown()));
    for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const [key, value] of globals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  for (const key of environment.keys()) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  globalThis.__piSessions = new Map();
  globalThis.__piStartLocks = new Map();
  globalThis.__piStartingSessionCwds = new Map();
  globalThis.__piAutomationResources = new Map();
  delete globalThis.__piAutomationRuntime;
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", packages: [] }));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused-local-fixture",
    models: [{ id: "fixture", name: "No model calls", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  return {
    root, cwd, releases,
    async transcript(managed = true, version = 3) {
      const id = randomUUID();
      const file = path.join(root, `${id}.jsonl`);
      const timestamp = new Date().toISOString();
      await writeFile(file, [
        { type: "session", version, id, cwd, timestamp },
        ...(managed ? [{ type: "custom", id: "managed1", parentId: null, timestamp, customType: "desktop-automation-session", data: { version: 1 } }] : []),
      ].map(JSON.stringify).join("\n") + "\n");
      return { id, file };
    },
  };
}

test("concurrent asynchronous viewer and ordinary preopens share one real SDK wrapper per id", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const created = await Promise.all(Array.from({ length: 4 }, () => startRpcSession("new-session-request", "", f.cwd, { executionMode: "automation" })));
  assert.equal(new Set(created.map((result) => result.realSessionId)).size, 1, "provisional ids must also share one SDK-created session");
  assert.equal(new Set(created.map((result) => result.session.inner)).size, 1);
  await created[0].session.shutdown();
  for (const managed of [true, false]) {
    const { id, file } = await f.transcript(managed);
    const results = await Promise.all(Array.from({ length: 4 }, () => startRpcSession(id, file, f.cwd, managed ? {} : { toolNames: [] })));
    assert.equal(new Set(results.map((result) => result.session)).size, 1);
    assert.equal(new Set(results.map((result) => result.session.inner)).size, 1);
    assert.equal(globalThis.__piSessions.get(id), results[0].session);
    assert.equal(globalThis.__piStartLocks.size, 0);
    assert.equal(hasBusyRpcSessionForCwd(f.cwd), false);
    await results[0].session.shutdown();
  }
});

test("ordinary preopen reserves cwd synchronously, and automation-first refuses before SDK legacy migration", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.transcript(false);
  const opening = startRpcSession(first.id, first.file, f.cwd, { toolNames: [] });
  assert.equal(globalThis.__piStartLocks.has(first.id), true, "the complete start promise is registered before the first yield");
  assert.equal(hasBusyRpcSessionForCwd(f.cwd), true);
  assert.throws(() => reserveAutomationCwd(f.cwd, () => hasBusyRpcSessionForCwd(f.cwd)), /in use/);
  await (await opening).session.shutdown();
  const second = await f.transcript(false, 2);
  const before = await readFile(second.file, "utf8");
  const release = reserveAutomationCwd(f.cwd, () => hasBusyRpcSessionForCwd(f.cwd));
  f.releases.push(release);
  await assert.rejects(startRpcSession(second.id, second.file, f.cwd, { toolNames: [] }), /Automation is using/);
  assert.equal(await readFile(second.file, "utf8"), before, "SDK open must not migrate a reserved ordinary file");
  assert.equal(globalThis.__piStartLocks.size, 0);
  assert.equal(globalThis.__piStartingSessionCwds.size, 0);
  release();
  const resumed = await startRpcSession(second.id, second.file, f.cwd, { toolNames: [] });
  assert.equal(resumed.session.executionMode, "chat");
  await resumed.session.shutdown();
  const available = reserveAutomationCwd(f.cwd, () => hasBusyRpcSessionForCwd(f.cwd));
  available();
});

test("repair and viewer startup switch idle SDK wrappers atomically and preserve the repair allow-list across reload", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { id, file } = await f.transcript();
  const [viewer, repair] = await Promise.all([
    startRpcSession(id, file, f.cwd),
    startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: true }),
  ]);
  assert.notEqual(viewer.session, repair.session);
  assert.equal(viewer.session.isAlive(), false);
  assert.equal(repair.session.automationRepair, true);
  assert.deepEqual(repair.session.inner.getActiveToolNames(), []);
  await repair.session.inner.reload();
  assert.deepEqual(repair.session.inner.getActiveToolNames(), []);
  const observed = await startRpcSession(id, file, f.cwd);
  assert.equal(observed.session, repair.session, "a read-only viewer observes the current immutable mode");
  const business = await startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: false });
  assert.notEqual(business.session, repair.session);
  assert.equal(repair.session.isAlive(), false);
  assert.equal(business.session.automationRepair, false);
  assert.deepEqual(business.session.inner.getActiveToolNames().sort(), [...AUTOMATION_TOOL_NAMES].sort());
  const [nextRepair, concurrentViewer] = await Promise.all([
    startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: true }),
    startRpcSession(id, file, f.cwd),
  ]);
  assert.equal(nextRepair.session, concurrentViewer.session);
  await nextRepair.session.inner.reload();
  assert.deepEqual(nextRepair.session.inner.getActiveToolNames(), []);
});

test("busy automation cannot switch modes and startup failures leave neither locks nor cwd tickets", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { id, file } = await f.transcript();
  const { session } = await startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: false });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.releases.push(() => release.resolve());
  const round = assert.rejects(session.runAutomationPrompt("Never submit this prompt", { beforePrompt: async () => {
    entered.resolve(); await release.promise; throw new Error("Fixture stops before any model call");
  } }), /Fixture stops/);
  await entered.promise;
  await assert.rejects(startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: true }), /busy/);
  assert.equal(session.isAlive(), true);
  release.resolve();
  await round;
  await session.shutdown();
  const descriptor = path.join(f.root, "hub", "descriptor.json");
  await mkdir(path.join(f.root, "hub", "sessions"), { recursive: true });
  const binding = path.join(f.root, "hub", "sessions", `${id}.json`);
  await writeFile(binding, "{invalid-binding");
  process.env.PI_AUTOMATION_DESCRIPTOR = descriptor;
  const failed = await Promise.allSettled([startRpcSession(id, file, f.cwd), startRpcSession(id, file, f.cwd)]);
  assert.ok(failed.every((result) => result.status === "rejected"));
  assert.equal(failed[0].reason, failed[1].reason, "both callers observed the same failed start promise");
  assert.equal(globalThis.__piStartLocks.size, 0);
  assert.equal(globalThis.__piStartingSessionCwds.size, 0);
  assert.equal(globalThis.__piAutomationResources.size, 0);
  assert.equal(hasBusyRpcSessionForCwd(f.cwd), false);
  await rm(binding);
  const retry = await startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: true });
  assert.equal(retry.session.automationRepair, true);
  assert.deepEqual(retry.session.inner.getActiveToolNames(), []);
});

test("a round claimed during asynchronous metadata lookup prevents idle mode replacement", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { id, file } = await f.transcript();
  const { session } = await startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: false });
  const hubRoot = path.join(f.root, "hub");
  await mkdir(path.join(hubRoot, "sessions"), { recursive: true });
  await writeFile(path.join(hubRoot, "sessions", `${id}.json`), JSON.stringify({
    version: 1, sessionId: id, sessionFile: file, cwd: f.cwd, ruleIds: [],
    digest: inspectAutomationSession(file).digest, started: true,
  }));
  process.env.PI_AUTOMATION_DESCRIPTOR = path.join(hubRoot, "descriptor.json");
  const switching = startRpcSession(id, file, f.cwd, { executionMode: "automation", automationRepair: true })
    .then((value) => ({ value }), (error) => ({ error }));
  // Enter the async binding lookup before the prior holder claims its round.
  await Promise.resolve();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.releases.push(() => release.resolve());
  const round = session.runAutomationPrompt("Never submit this prompt", { beforePrompt: async () => {
    entered.resolve(); await release.promise; throw new Error("Fixture stops before any model call");
  } }).then(() => null, (error) => error);
  await entered.promise;
  const result = await switching;
  assert.match(result.error?.message ?? "mode replacement was accepted", /busy/);
  assert.equal(session.isAlive(), true, "mode replacement must not abort the newly claimed round");
  assert.equal(session.isRunning(), true);
  assert.equal(globalThis.__piSessions.get(id), session);
  assert.deepEqual(session.inner.getActiveToolNames().sort(), [...AUTOMATION_TOOL_NAMES].sort());
  assert.equal(globalThis.__piStartLocks.size, 0);
  assert.equal(globalThis.__piStartingSessionCwds.size, 0);
  release.resolve();
  assert.match((await round)?.message ?? "", /Fixture stops/);
});

test("a real SDK wrapper rejects new rounds while graceful shutdown is awaiting extension emission", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { id, file } = await f.transcript();
  const { session } = await startRpcSession(id, file, f.cwd, { executionMode: "automation" });
  await session.send({ type: "get_commands" });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.releases.push(() => release.resolve());
  const runner = session.inner.extensionRunner;
  const emit = runner.emit.bind(runner);
  runner.emit = async (event) => {
    if (event.type === "session_shutdown") { entered.resolve(); await release.promise; }
    return emit(event);
  };
  const closing = session.shutdown();
  await entered.promise;
  assert.equal(session.isAlive(), true, "the SDK is still alive until its shutdown event settles");
  let promptEntered = false;
  await assert.rejects(session.runAutomationPrompt("Never submit this prompt", { beforePrompt: () => {
    promptEntered = true; throw new Error("Fixture stops before any model call");
  } }), /closed|closing/);
  assert.equal(promptEntered, false, "closing wrappers must reject before preparing another round");
  release.resolve();
  await closing;
  assert.equal(session.isAlive(), false);
});
