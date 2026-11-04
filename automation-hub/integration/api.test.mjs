import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { GET, POST } = await jiti.import("../../app/api/automations/route.ts");
const { initializeAutomationRuntime, validateAutomationCwd } = await jiti.import("@/lib/automation/runtime");
const { AutomationInputError } = await jiti.import("@/lib/automation/config");
const { allowFileRoot } = await jiti.import("@/lib/file-access");
const { trustProject } = await jiti.import("@/lib/project-trust");
const base = "http://127.0.0.1:30141/api/automations";
const controlKey = "fixture-internal-control-key-".repeat(3);
const makeConfig = (cwd, overrides = {}) => ({ version: 1, timezone: "UTC", rules: [{
  id: "rule-route", name: "Route fixture", cwd, prompt: "Read and report.", enabled: true, trigger: { kind: "manual" }, ...overrides,
}] });

function request(body, { method = "POST", headers = {}, raw = false, query = "" } = {}) {
  return new Request(base + query, {
    method,
    headers: { host: "127.0.0.1:30141", ...(method === "POST" && { "content-type": "application/json" }), ...headers },
    ...(method === "POST" && { body: raw ? body : JSON.stringify(body) }),
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-route-"));
  const dataDir = path.join(root, "hub");
  const cwd = path.join(root, "selected");
  const agentDir = path.join(root, "agent");
  const envNames = ["PI_CODING_AGENT_DIR", "PI_AUTOMATION_DESCRIPTOR", "PI_AUTOMATION_CONTROL_KEY", "PI_OFFLINE"];
  const globalNames = ["__piAutomationRuntime", "__piAdditionalAllowedRoots", "__piAllowedRootsCache", "__piSessionListCache", "__piSessionListPromise", "__piSessionPathCache", "__piPathToSessionIdCache", "__piSessionListGeneration", "__piSessionListPromiseGeneration"];
  const previousEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));
  const previousGlobals = new Map(globalNames.map((name) => [name, globalThis[name]]));
  let hub;
  t.after(async () => {
    const state = globalThis.__piAutomationRuntime;
    clearInterval(state?.timer);
    await state?.connecting;
    await state?.worker?.stop();
    await state?.writes?.catch(() => {});
    await hub?.close();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    for (const [name, value] of previousGlobals) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of globalNames) delete globalThis[name];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir);
  hub = await startHub({ dataDir });
  process.env.PI_AUTOMATION_DESCRIPTOR = path.join(dataDir, "descriptor.json");
  process.env.PI_AUTOMATION_CONTROL_KEY = controlKey;
  initializeAutomationRuntime();
  // Suspend before installing any enabled rules or enqueuing work: no default
  // provider can be reached, even if an interval or command calls tick().
  const suspended = await POST(request({ action: "suspend_worker" }, { headers: { "x-pi-automation-control": controlKey } }));
  assert.equal(suspended.status, 200);
  clearInterval(globalThis.__piAutomationRuntime.timer);
  globalThis.__piAutomationRuntime.timer = undefined;
  allowFileRoot(cwd);
  return {
    root, dataDir, cwd, agentDir,
    get hub() { return hub; },
    async restart() { await hub.close(); hub = await startHub({ dataDir }); },
    async snapshot() {
      const response = await GET(request(undefined, { method: "GET" }));
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

test("API rejects cross-origin, untrusted Host, non-JSON and oversized or malformed request bodies", { timeout: 10000 }, async () => {
  for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await GET(request(undefined, { method: "GET", headers }))).status, 403);
    assert.equal((await POST(request({ action: "save_config" }, { headers }))).status, 403);
  }
  assert.equal((await POST(request("{}", { raw: true, headers: { "content-type": "text/plain" } }))).status, 415);
  for (const body of ["{", "[]", "null", "5"]) assert.equal((await POST(request(body, { raw: true }))).status, 400);
  const oversized = await POST(request("x".repeat(1024 * 1024 + 1), { raw: true, headers: { "content-length": "1" } }));
  assert.equal(oversized.status, 413);
  for (const query of ["?why=0", "?why=-1", "?before=not-an-id", "?why=9007199254740992"]) {
    const response = await GET(request(undefined, { method: "GET", query }));
    assert.equal(response.status, 400, JSON.stringify({ query, response: await response.text() }));
  }
});

test("API classifies schema errors and dynamically validated cwd errors as input failures", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const invalidConfig = makeConfig(f.cwd, { timeoutMinutes: 0 });
  const response = await POST(request({ action: "save_config", config: invalidConfig }));
  assert.equal(response.status, 400, JSON.stringify({ case: "invalid-config", response: await response.text() }));
  const outside = path.join(f.root, "unselected");
  await mkdir(outside);
  await assert.rejects(validateAutomationCwd(outside), (error) => {
    assert.ok(error instanceof AutomationInputError, JSON.stringify({ case: "dynamic-cwd-error-type", cwd: outside,
      constructor: error?.constructor?.name, name: error?.name, message: error?.message, stack: error?.stack }));
    return true;
  });
});

test("internal suspend/resume requires the captured capability and does not leak it to snapshots", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(process.env.PI_AUTOMATION_DESCRIPTOR, undefined);
  assert.equal(process.env.PI_AUTOMATION_CONTROL_KEY, undefined);
  for (const action of ["suspend_worker", "resume_worker"]) {
    for (const key of [undefined, "wrong", "é".repeat(controlKey.length)]) {
      const response = await POST(request({ action }, { headers: key ? { "x-pi-automation-control": key } : {} }));
      assert.equal(response.status, 403);
    }
  }
  const resumed = await POST(request({ action: "resume_worker" }, { headers: { "x-pi-automation-control": controlKey } }));
  assert.equal(resumed.status, 200);
  const suspended = await POST(request({ action: "suspend_worker" }, { headers: { "x-pi-automation-control": controlKey } }));
  assert.equal(suspended.status, 200);
  const snapshot = await f.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.worker.suspended, true);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [controlKey, f.hub.descriptor.ownerKey, f.hub.descriptor.workerKey, f.hub.descriptor.sourceKey]) assert.equal(serialized.includes(secret), false);
  for (const field of ["ownerKey", "workerKey", "sourceKey", "controlKey", "descriptorPath"]) assert.equal(serialized.includes(`"${field}"`), false);
});

test("config saves validate real workspace boundaries and trust, preserve prior config after rejection, and survive restart/toggle", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  const linked = path.join(f.cwd, "escape");
  await mkdir(outside);
  await symlink(outside, linked, "junction");
  const save = (config) => POST(request({ action: "save_config", config }));
  assert.equal((await save(makeConfig(f.cwd))).status, 200);
  const initial = await f.snapshot();
  assert.equal(initial.config.rules[0].cwd, await realpath(f.cwd));
  for (const cwd of [outside, linked, path.join(f.cwd, "missing")]) {
    const response = await save(makeConfig(cwd));
    assert.equal(response.status, 400, JSON.stringify({ case: "invalid-cwd", cwd, response: await response.text() }));
    assert.equal((await f.snapshot()).config.rules[0].cwd, await realpath(f.cwd));
  }
  await mkdir(path.join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(path.join(f.cwd, ".pi", "extensions", "untrusted.ts"), "export default function () {}\n");
  const untrusted = await save(makeConfig(f.cwd));
  assert.equal(untrusted.status, 400, JSON.stringify({ case: "untrusted-cwd", cwd: f.cwd, response: await untrusted.text() }));
  assert.equal(trustProject(f.cwd, f.agentDir).trusted, true);
  assert.equal((await save(makeConfig(f.cwd, { name: "Trusted saved rule" }))).status, 200);
  const triggered = await POST(request({ action: "trigger", ruleId: "rule-route" }));
  assert.equal(triggered.status, 200);
  const queued = await triggered.json();
  assert.equal(queued.state.runs[0].state, "queued");
  assert.equal(queued.worker.suspended, true);
  assert.equal(queued.owner, null);
  const cancelled = await POST(request({ action: "cancel_rule", ruleId: "rule-route" }));
  assert.equal(cancelled.status, 200);
  const disabled = await cancelled.json();
  assert.equal(disabled.config.rules[0].enabled, false);
  assert.equal(disabled.state.runs[0].state, "cancelled");
  await f.restart();
  const persisted = await f.snapshot();
  assert.equal(persisted.config.rules[0].enabled, false);
  assert.equal(persisted.config.rules[0].name, "Trusted saved rule");
  assert.equal(persisted.state.runs[0].state, "cancelled");
  assert.equal(persisted.worker.suspended, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, "rules.json"), "utf8")).rules, []);
  assert.equal((await save(makeConfig(f.cwd, { name: "Enabled again" }))).status, 200);
  assert.equal((await f.snapshot()).config.rules[0].enabled, true);
});
