import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import host from "./automation-host.js";

const { createAutomationSupervisor, notificationChanges, probeRuntime, resolveHubEntry, validDescriptor } = host;
const fixture = `
import fs from 'node:fs'; import http from 'node:http';
const arg=(name)=>process.argv[process.argv.indexOf(name)+1];
const descriptorPath=arg('--descriptor'), instanceId=arg('--instance-id');
let state={cards:[{id:1,state:'open'}],runs:[{id:1,state:'done'}]};
const server=http.createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer owner'){res.writeHead(401).end('{}');return;}
  if(req.url==='/healthz')res.end(JSON.stringify({ok:true,instanceId}));
  else if(req.url==='/v1/state')res.end(JSON.stringify(state));
  else if(req.url==='/test/state'){let body='';for await(const part of req)body+=part;state=JSON.parse(body);res.end('{}');}
  else res.writeHead(404).end('{}');
});
server.listen(0,'127.0.0.1',()=>{
  const descriptor={version:1,instanceId,url:'http://127.0.0.1:'+server.address().port,
    ownerKey:'owner',workerKey:'worker',sourceKey:'source',pid:process.pid,
    workerName:'pi-desktop',sourceName:'desktop',leaked:Boolean(process.env.PI_AUTOMATION_CONTROL_KEY||process.env.PI_AUTOMATION_DESCRIPTOR)};
  fs.writeFileSync(descriptorPath,JSON.stringify(descriptor),{mode:0o600});
});
process.on('disconnect',()=>server.close(()=>process.exit()));
process.on('SIGTERM',()=>server.close(()=>process.exit()));
`;

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-automation-host-"));
  const entry = path.join(directory, "hub.mjs");
  const descriptorPath = path.join(directory, "connection.json");
  await writeFile(entry, fixture);
  const supervisor = createAutomationSupervisor({
    appRoot: directory, dataDirectory: directory, descriptorPath, entry,
    candidates: [{ executable: process.execPath }], probe: async (candidate) => candidate,
    environment: { ...process.env, PI_AUTOMATION_CONTROL_KEY: "private-control", PI_AUTOMATION_DESCRIPTOR: "private-descriptor" },
    pollIntervalMs: 25, startTimeoutMs: 2_000, ...overrides,
  });
  t.after(async () => { await supervisor.stop({ force: true, timeoutMs: 150 }); await rm(directory, { recursive: true, force: true }); });
  return { supervisor, directory, descriptorPath };
}

async function eventually(check) {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Expected lifecycle transition did not occur");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("SQLite runtime probe validates the actual version, platform and architecture", async () => {
  const candidate = { executable: process.execPath };
  const result = await probeRuntime(candidate);
  if (Number(process.versions.node.split(".")[0]) >= 24) assert.equal(result?.executable, process.execPath);
  else assert.equal(result, null);
  assert.equal(await probeRuntime(candidate, { arch: "unsupported-test-architecture" }), null);
});

test("hub entry prefers the built sidecar and falls back to development source", async (t) => {
  const { directory } = await setup(t);
  const source = path.join(directory, "automation-hub", "host", "main.ts");
  const built = path.join(directory, "dist", "automation-hub", "host", "main.mjs");
  assert.equal(resolveHubEntry(directory), null);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "");
  assert.equal(resolveHubEntry(directory), source);
  await mkdir(path.dirname(built), { recursive: true });
  await writeFile(built, "");
  assert.equal(resolveHubEntry(directory), built);
});

test("descriptor handshake rejects a different instance, process or non-loopback destination", () => {
  const descriptor = { version: 1, instanceId: "one", pid: 123, url: "http://127.0.0.1:1234", ownerKey: "a", workerKey: "b", sourceKey: "c" };
  assert.equal(validDescriptor(descriptor, "one", 123), true);
  assert.equal(validDescriptor(descriptor, "two", 123), false);
  assert.equal(validDescriptor(descriptor, "one", 456), false);
  assert.equal(validDescriptor({ ...descriptor, url: "http://example.com:1234" }, "one", 123), false);
  assert.equal(validDescriptor({ ...descriptor, url: "http://secret@127.0.0.1:1234" }, "one", 123), false);
});

test("automation defaults off and never takes over an external development server", async (t) => {
  let probes = 0;
  const { supervisor } = await setup(t, { canStart: () => false, probe: async () => { probes += 1; } });
  assert.deepEqual(await supervisor.restore(), { enabled: false, state: "disabled" });
  assert.deepEqual(await supervisor.setEnabled(true), { enabled: false, state: "unavailable", reason: "external-server" });
  assert.equal(probes, 0);
});

test("owned hub starts once, resumes the worker, keeps credentials private and drains before stop", async (t) => {
  let resumed = 0;
  let drained = 0;
  const { supervisor, directory, descriptorPath } = await setup(t, {
    resumeWorker: async () => { resumed += 1; }, drainWorker: async () => { drained += 1; return { stopped: true }; },
  });
  const results = await Promise.all([supervisor.setEnabled(true), supervisor.setEnabled(true)]);
  assert.equal(results.every((status) => status.state === "ready" && status.enabled), true);
  assert.equal(resumed, 1);
  assert.equal(JSON.parse(await readFile(descriptorPath, "utf8")).leaked, false);
  assert.equal(JSON.parse(await readFile(path.join(directory, "preferences.json"), "utf8")).enabled, true);
  assert.deepEqual(await supervisor.setEnabled(false), { enabled: false, state: "disabled" });
  assert.equal(drained, 1);
  await assert.rejects(readFile(descriptorPath), { code: "ENOENT" });
});

test("failed worker drain leaves the hub available instead of killing uncertain execution", async (t) => {
  const { supervisor, descriptorPath } = await setup(t, { drainWorker: async () => ({ stopped: false }) });
  assert.equal((await supervisor.setEnabled(true)).state, "ready");
  assert.deepEqual(await supervisor.setEnabled(false), { enabled: true, state: "ready", reason: "worker-drain-failed" });
  assert.equal(JSON.parse(await readFile(descriptorPath, "utf8")).pid > 0, true);
});

test("saved opt-in survives application shutdown and can be restored", async (t) => {
  const { supervisor, directory } = await setup(t);
  await supervisor.setEnabled(true);
  await supervisor.stop({ force: true });
  const restored = createAutomationSupervisor({
    appRoot: directory, dataDirectory: directory, entry: path.join(directory, "hub.mjs"),
    candidates: [{ executable: process.execPath }], probe: async (candidate) => candidate,
  });
  t.after(() => restored.stop({ force: true }));
  assert.equal(restored.getStatus().enabled, true);
  assert.equal((await restored.restore()).state, "ready");
  await restored.setEnabled(false);
});

test("disable racing worker startup drains before terminating the owned hub", async (t) => {
  let resumeStarted = false;
  let releaseResume;
  let drained = false;
  const { supervisor } = await setup(t, {
    resumeWorker: () => { resumeStarted = true; return new Promise((resolve) => { releaseResume = resolve; }); },
    drainWorker: async () => { drained = true; return { stopped: true }; },
  });
  const enabling = supervisor.setEnabled(true);
  await eventually(() => resumeStarted);
  const disabling = supervisor.setEnabled(false);
  releaseResume();
  await enabling;
  assert.deepEqual(await disabling, { enabled: false, state: "disabled" });
  assert.equal(drained, true);
});

test("unexpected hub exit disables the feature and removes the stale owned descriptor", async (t) => {
  const { supervisor, descriptorPath } = await setup(t);
  await supervisor.setEnabled(true);
  const { pid } = JSON.parse(await readFile(descriptorPath, "utf8"));
  process.kill(pid, "SIGKILL");
  await eventually(() => supervisor.getStatus().state === "unavailable");
  assert.equal(supervisor.getStatus().reason, "hub-exited");
  await assert.rejects(readFile(descriptorPath), { code: "ENOENT" });
});

test("stopping removes only this host's descriptor", async (t) => {
  const { supervisor, descriptorPath } = await setup(t);
  await supervisor.setEnabled(true);
  const replacement = { instanceId: "another-owner" };
  await writeFile(descriptorPath, JSON.stringify(replacement));
  await supervisor.setEnabled(false);
  assert.deepEqual(JSON.parse(await readFile(descriptorPath, "utf8")), replacement);
});

test("notification baseline suppresses history and repeated states", () => {
  const initial = { cards: [{ id: 1, state: "open" }], runs: [{ id: 1, state: "done" }] };
  const baseline = notificationChanges(null, initial);
  assert.deepEqual(baseline.notifications, []);
  assert.deepEqual(notificationChanges(baseline.current, initial).notifications, []);
  const next = notificationChanges(baseline.current, {
    cards: [...initial.cards, { id: 2, state: "open" }],
    runs: [...initial.runs, { id: 2, state: "done" }, { id: 3, state: "unknown" }],
  });
  assert.deepEqual(next.notifications, [{ kind: "decision", cardId: 2 }, { kind: "complete", runId: 2 }, { kind: "failure", runId: 3 }]);
  assert.deepEqual(notificationChanges(next.current, { cards: [], runs: [{ id: 4, state: "nothing" }] }).notifications, []);
  const retry = notificationChanges(next.current, { cards: [], runs: [{ id: 5, state: "queued", attempts: 1, error: "retryable" }] });
  assert.deepEqual(retry.notifications, [{ kind: "failure", runId: 5 }]);
  assert.deepEqual(notificationChanges(retry.current, { cards: [], runs: [{ id: 5, state: "queued", attempts: 1, error: "retryable" }] }).notifications, []);
});

test("capability failure degrades the optional feature without starting a child", async (t) => {
  const { supervisor } = await setup(t, { probe: async () => null });
  assert.deepEqual(await supervisor.setEnabled(true), { enabled: false, state: "unavailable", reason: "runtime-unavailable" });
});
