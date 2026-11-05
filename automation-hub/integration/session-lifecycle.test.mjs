import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";
import * as contract from "../upstream/worker/contract.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { PATCH, DELETE } = await jiti.import("../../app/api/sessions/[id]/route.ts");
const { initializeAutomationRuntime, refreshAutomationConnection } = await jiti.import("@/lib/automation/runtime");
const { cacheSessionPath } = await jiti.import("@/lib/session-reader");
const { parseAutomationConfig, compileAutomationRules } = await jiti.import("@/lib/automation/config");
const { AutomationWorker } = await jiti.import("@/lib/automation/worker");
const { AutomationCheckpoints } = await jiti.import("@/lib/automation/checkpoint");
const { inspectAutomationSession, saveAutomationBinding, findAutomationBinding, readAutomationBinding } = await jiti.import("@/lib/automation/session-binding");

function request(method, name = "Renamed fixture") {
  return new Request("http://127.0.0.1:30141/api/sessions/fixture", { method,
    ...(method === "PATCH" && { headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }),
  });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

async function fixture(t, connected = true) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-session-lifecycle-"));
  const cwd = path.join(root, "project");
  const dataDir = path.join(root, "hub");
  const envNames = ["PI_CODING_AGENT_DIR", "PI_AUTOMATION_DESCRIPTOR", "PI_AUTOMATION_CONTROL_KEY", "PI_OFFLINE"];
  const globalNames = ["__piAutomationRuntime", "__piSessionPathCache", "__piPathToSessionIdCache", "__piSessionListCache", "__piSessionListPromise", "__piSessionListGeneration", "__piSessionListPromiseGeneration"];
  const savedEnv = new Map(envNames.map((key) => [key, process.env[key]]));
  const savedGlobals = new Map(globalNames.map((key) => [key, globalThis[key]]));
  let hub;
  const releases = [];
  t.after(async () => {
    for (const release of releases) release();
    const state = globalThis.__piAutomationRuntime;
    clearInterval(state?.timer);
    await state?.connecting;
    await state?.worker?.stop();
    await state?.writes?.catch(() => {});
    await hub?.close();
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const [key, value] of savedGlobals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  for (const key of globalNames) delete globalThis[key];
  for (const key of envNames) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_OFFLINE = "1";
  await mkdir(cwd);
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  const clock = { now: Date.now() };
  if (connected) {
    hub = await startHub({ dataDir, now: () => clock.now });
    process.env.PI_AUTOMATION_DESCRIPTOR = path.join(dataDir, "descriptor.json");
    // Suspend before installing rules. No default executor may ever be reached.
    globalThis.__piAutomationRuntime = { suspended: true, writes: Promise.resolve() };
    initializeAutomationRuntime();
    await refreshAutomationConnection();
    clearInterval(globalThis.__piAutomationRuntime.timer);
  }
  const config = parseAutomationConfig({ version: 1, timezone: "UTC", rules: ["a", "b", "unrelated"].map((name) => ({
    id: `rule-${name}`, name: `Session ${name}`, cwd, enabled: true, prompt: "Return the fixture result.", trigger: { kind: "manual" },
  })) });
  const client = () => globalThis.__piAutomationRuntime.hub;
  const save = () => client().call("/v1/desktop/config", { method: "PUT", body: { config, rules: compileAutomationRules(config) } });
  if (connected) await save();
  let serial = 0;
  return {
    root, cwd, dataDir, clock, config, save, releases,
    get hub() { return hub; }, get client() { return client(); },
    async restart() { await hub.close(); hub = await startHub({ dataDir, now: () => clock.now }); await refreshAutomationConnection(); },
    async session(managed = true, ruleIds = ["rule-a"]) {
      const sessionId = randomUUID();
      const sessionFile = path.join(root, `${sessionId}.jsonl`);
      const timestamp = new Date(clock.now).toISOString();
      const entries = [{ type: "session", version: 3, id: sessionId, cwd, timestamp },
        ...(managed ? [{ type: "custom", id: "managed1", parentId: null, timestamp, customType: "desktop-automation-session", data: { version: 1 } }] : []),
        { type: "message", id: "user0001", parentId: managed ? "managed1" : null, timestamp, message: { role: "user", content: "Fixture conversation" } },
      ];
      await writeFile(sessionFile, entries.map(JSON.stringify).join("\n") + "\n");
      cacheSessionPath(sessionId, sessionFile);
      if (managed && connected) {
        await mkdir(path.join(dataDir, "sessions"), { recursive: true });
        await saveAutomationBinding(dataDir, { version: 1, sessionId, sessionFile, cwd, ruleIds, digest: inspectAutomationSession(sessionFile).digest, started: true });
      }
      return { sessionId, sessionFile };
    },
    async claim(rule = "a") {
      await client().call("/v1/desktop/trigger", { method: "POST", body: { ruleId: `rule-${rule}`, eventId: `lifecycle-${++serial}` } });
      return (await client().call(`/v1/work?claim=lifecycle-${++serial}&wait=0&running=&capacity=1`, { role: "worker" })).job;
    },
  };
}

test("ordinary sessions rename and delete without an automation connection", async (t) => {
  const f = await fixture(t, false);
  const session = await f.session(false);
  const renamed = await PATCH(request("PATCH"), params(session.sessionId));
  assert.equal(renamed.status, 200, await renamed.text());
  assert.ok((await readFile(session.sessionFile, "utf8")).includes("Renamed fixture"));
  assert.equal(globalThis.__piAutomationRuntime.hub, undefined);
  const deleted = await DELETE(request("DELETE"), params(session.sessionId));
  assert.equal(deleted.status, 200, await deleted.text());
  await assert.rejects(access(session.sessionFile), { code: "ENOENT" });
  const legacy = await f.session(false);
  const original = await readFile(legacy.sessionFile, "utf8");
  await writeFile(legacy.sessionFile, original.replace('"version":3', '"version":2'));
  const migrated = await PATCH(request("PATCH", "Legacy fixture"), params(legacy.sessionId));
  assert.equal(migrated.status, 200, await migrated.text());
  assert.ok((await readFile(legacy.sessionFile, "utf8")).includes("Legacy fixture"));
});

test("rename durably disables every bound rule, closes old cards and timers, and keeps a paused binding across restart", async (t) => {
  const f = await fixture(t);
  const session = await f.session(true, ["rule-a", "rule-b"]);
  const before = await findAutomationBinding(f.dataDir, session.sessionId);
  const cards = [];
  for (const rule of ["a", "b"]) {
    const job = await f.claim(rule);
    await f.client.call(`/v1/runs/${job.run}/result`, { method: "POST", token: job.token, body: { outcome: "done", session: session.sessionId, summary: "Wait for the old session",
      ask: [{ key: `choice-${rule}`, title: `Old ${rule}`, text: "Continue?", options: ["Yes", "No"] }],
      later: [{ key: `review-${rule}`, at: new Date(f.clock.now + 60_000).toISOString(), about: "Old review" }],
    } });
  }
  cards.push(...(await f.client.call("/v1/state")).cards);
  const renamed = await PATCH(request("PATCH"), params(session.sessionId));
  assert.equal(renamed.status, 200, await renamed.text());
  const paused = await findAutomationBinding(f.dataDir, session.sessionId);
  assert.ok(paused.pausedReason);
  assert.equal(paused.digest, before.digest, "rename must not silently adopt the changed transcript");
  assert.notEqual(inspectAutomationSession(session.sessionFile).digest, before.digest);
  await assert.rejects(readAutomationBinding(f.dataDir, session.sessionId));
  await f.restart();
  const persisted = (await f.client.call("/v1/desktop/config")).config;
  assert.equal(persisted.rules.find((rule) => rule.id === "rule-unrelated").enabled, true);
  assert.ok(persisted.rules.filter((rule) => rule.id !== "rule-unrelated").every((rule) => !rule.enabled));
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE event_id IS NULL").get().n, 0);
  assert.equal((await f.client.call("/v1/state")).cards.length, 0);
  await f.save();
  for (const card of cards) assert.equal((await f.client.call(`/v1/cards/${card.id}/answer`, { method: "POST", body: { choice: 0 } })).changed, false);
  f.clock.now += 120_000;
  f.hub.runtime.execute("tick", []);
  assert.equal((await f.client.call("/v1/work?claim=no-old-session&wait=0&running=&capacity=1", { role: "worker" })).job, null);
  assert.ok((await findAutomationBinding(f.dataDir, session.sessionId)).pausedReason);
});

test("delete waits for the actual related worker round to settle before removing JSONL", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const began = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.releases.push(() => release.resolve());
  const worker = new AutomationWorker(f.client, path.join(f.dataDir, "descriptor.json"), { contract, validateCwd: async (cwd) => cwd,
    execute: async (options) => {
      await options.onSession({ ...session, digest: inspectAutomationSession(session.sessionFile).digest });
      began.resolve();
      await new Promise((resolve) => { options.signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }); });
      await release.promise;
      throw new DOMException("Fixture stopped", "AbortError");
    },
  });
  await globalThis.__piAutomationRuntime.worker.stop();
  globalThis.__piAutomationRuntime.worker = worker;
  await f.client.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-a", eventId: "active-delete" } });
  await worker.tick();
  await began.promise;
  const original = await readFile(session.sessionFile, "utf8");
  let complete = false;
  const deleting = DELETE(request("DELETE"), params(session.sessionId)).then((response) => { complete = true; return response; });
  await aborted.promise;
  assert.equal(complete, false);
  assert.equal(await readFile(session.sessionFile, "utf8"), original);
  assert.equal((await f.client.call("/v1/desktop/config")).config.rules.find((rule) => rule.id === "rule-a").enabled, false);
  const previousWrite = globalThis.__piAutomationRuntime.writes;
  const renaming = PATCH(request("PATCH", "Must not resurrect"), params(session.sessionId));
  const deadline = Date.now() + 1000;
  while (globalThis.__piAutomationRuntime.writes === previousWrite && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(globalThis.__piAutomationRuntime.writes, previousWrite, "the rename is queued behind the draining delete");
  release.resolve();
  const deleted = await deleting;
  assert.equal(deleted.status, 200, await deleted.text());
  const blockedRename = await renaming;
  assert.equal(blockedRename.status, 409, await blockedRename.text());
  await assert.rejects(access(session.sessionFile), { code: "ENOENT" });
  assert.equal((await f.client.call("/v1/desktop/status")).owner, null);
  assert.equal((await new AutomationCheckpoints(path.join(f.dataDir, "worker")).list()).length, 0);
  assert.ok((await findAutomationBinding(f.dataDir, session.sessionId)).pausedReason);
});

test("managed session mutations fail closed without the hub and preserve bytes; malformed managed files are never opened for repair", async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const original = await readFile(session.sessionFile, "utf8");
  await f.hub.close();
  for (const method of ["PATCH", "DELETE"]) {
    const response = await (method === "PATCH" ? PATCH : DELETE)(request(method), params(session.sessionId));
    assert.equal(response.status, 409, await response.text());
    assert.equal(await readFile(session.sessionFile, "utf8"), original);
  }
  await writeFile(session.sessionFile, original + "{malformed\n");
  const malformed = await PATCH(request("PATCH"), params(session.sessionId));
  assert.equal(malformed.status, 409, await malformed.text());
  assert.equal(await readFile(session.sessionFile, "utf8"), original + "{malformed\n");
});

test("unknown execution is durably paused but keeps its session until explicit reconciliation", async (t) => {
  const f = await fixture(t);
  const session = await f.session();
  const job = await f.claim();
  await f.client.call(`/v1/runs/${job.run}/started`, { method: "POST", token: job.token, body: { session: session.sessionId } });
  const checkpoints = new AutomationCheckpoints(path.join(f.dataDir, "worker"));
  await checkpoints.save({ version: 1, claim: "unknown-lifecycle", job, stage: "running", ...session });
  f.clock.now += 301_000;
  f.hub.runtime.execute("heartbeat", ["pi-desktop", []]);
  f.hub.runtime.execute("sweep", []);
  assert.equal(f.hub.runtime.getView().get("runs", job.run).state, "unknown");
  const original = await readFile(session.sessionFile, "utf8");
  const response = await DELETE(request("DELETE"), params(session.sessionId));
  assert.equal(response.status, 409, await response.text());
  assert.equal(await readFile(session.sessionFile, "utf8"), original);
  assert.equal((await f.client.call("/v1/desktop/config")).config.rules.find((rule) => rule.id === "rule-a").enabled, false);
  await globalThis.__piAutomationRuntime.worker.reconcile(job.run);
  const deleted = await DELETE(request("DELETE"), params(session.sessionId));
  assert.equal(deleted.status, 200, await deleted.text());
  await assert.rejects(access(session.sessionFile), { code: "ENOENT" });
});
