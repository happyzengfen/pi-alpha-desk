import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { beginChatCwdUse, reserveAutomationCwd, canonicalResourceCwd, assertNoAutomationOwner } = await jiti.import("./resource-guard.ts");
const { AgentSessionWrapper, hasBusyRpcSessionForCwd, startRpcSession } = await jiti.import("../rpc-manager.ts");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-resource-guard-"));
  const previousRuntime = globalThis.__piAutomationRuntime;
  const previousResources = globalThis.__piAutomationResources;
  const previousDescriptor = process.env.PI_AUTOMATION_DESCRIPTOR;
  delete globalThis.__piAutomationRuntime;
  delete globalThis.__piAutomationResources;
  delete process.env.PI_AUTOMATION_DESCRIPTOR;
  t.after(async () => {
    globalThis.__piAutomationRuntime = previousRuntime;
    globalThis.__piAutomationResources = previousResources;
    if (previousDescriptor === undefined) delete process.env.PI_AUTOMATION_DESCRIPTOR;
    else process.env.PI_AUTOMATION_DESCRIPTOR = previousDescriptor;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function chat(cwd, prompt = async () => {}) {
  let subscriber;
  const calls = [];
  const inner = {
    sessionId: "ordinary-chat", sessionFile: "", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    subscribe(listener) { subscriber = listener; return () => {}; },
    prompt, setSessionName(name) { calls.push(name); },
    getAllTools() { return []; }, getActiveToolNames() { return []; },
    sessionManager: { getSessionFile() { return ""; } }, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, cwd);
  wrapper.start();
  return { wrapper, inner, calls, emit: (event) => subscriber(event) };
}

test("both synchronous acquisition orders fence the same directory and allow unrelated work", async (t) => {
  const root = await fixture(t);
  const first = beginChatCwdUse(root);
  // The chat has not awaited the durable owner check yet.
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/);
  await first.check();
  first.release();
  const release = reserveAutomationCwd(root, () => false);
  assert.throws(() => beginChatCwdUse(root), /Automation is using/);
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/);
  const elsewhere = beginChatCwdUse(path.join(root, "different"));
  await elsewhere.check();
  elsewhere.release();
  release();
  release();
  const after = beginChatCwdUse(root);
  await after.check();
  after.release();
});

test("canonical aliases use one reservation, including symlinks and Windows drive/case spelling", async (t) => {
  const root = await fixture(t);
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await mkdir(actual);
  await symlink(actual, linked, "junction");
  assert.equal(canonicalResourceCwd(actual), canonicalResourceCwd(linked));
  const release = reserveAutomationCwd(actual, () => false);
  assert.throws(() => beginChatCwdUse(linked), /Automation is using/);
  release();
  assert.equal(canonicalResourceCwd("C:\\Projects\\Desk"), canonicalResourceCwd("c:/projects/desk"));
  const windows = reserveAutomationCwd("C:\\Projects\\Desk", () => false);
  assert.throws(() => beginChatCwdUse("c:/PROJECTS/desk"), /Automation is using/);
  windows();
});

test("ordinary prompt keeps its directory ticket beyond POST acknowledgement until actual completion", async (t) => {
  const root = await fixture(t);
  const done = Promise.withResolvers();
  const lookup = Promise.withResolvers();
  globalThis.__piAutomationRuntime = { hub: { call: () => lookup.promise } };
  const fixtureChat = chat(root, () => done.promise);
  t.after(() => fixtureChat.wrapper.destroy());
  const sent = fixtureChat.wrapper.send({ type: "prompt", message: "inspect" });
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/, "provisional chat ticket exists before async owner lookup");
  lookup.resolve({ owner: null });
  await sent;
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/, "fire-and-forget prompt is still running");
  done.resolve();
  await new Promise(setImmediate);
  reserveAutomationCwd(root, () => false)();
});

test("durable active/unknown ownership blocks chat mutation but permits read-only viewing and another directory", async (t) => {
  const root = await fixture(t);
  const fixtureChat = chat(root);
  const unrelated = chat(path.join(root, "different"));
  t.after(() => { fixtureChat.wrapper.destroy(); unrelated.wrapper.destroy(); });
  for (const state of ["claimed", "unknown"]) {
    globalThis.__piAutomationRuntime = { hub: { call: async () => ({ owner: { run: 1, cwd: root, state } }) } };
    await assert.rejects(fixtureChat.wrapper.send({ type: "set_session_name", name: "blocked" }), /Automation owns/);
    assert.deepEqual(await fixtureChat.wrapper.send({ type: "get_tools" }), []);
    await unrelated.wrapper.send({ type: "set_session_name", name: "allowed" });
  }
  assert.deepEqual(fixtureChat.calls, []);
  assert.deepEqual(unrelated.calls, ["allowed", "allowed"]);
  globalThis.__piAutomationRuntime = { hub: { call: async () => ({ owner: null }) } };
  await fixtureChat.wrapper.send({ type: "set_session_name", name: "released" });
  assert.deepEqual(fixtureChat.calls, ["released"]);
});

test("automation's atomic busy check catches pre-existing wrappers and startup tracking", async (t) => {
  const root = await fixture(t);
  const oldSessions = globalThis.__piSessions;
  const oldStarting = globalThis.__piStartingSessionCwds;
  const fixtureChat = chat(root);
  globalThis.__piSessions = new Map([["ordinary-chat", fixtureChat.wrapper]]);
  t.after(() => { fixtureChat.wrapper.destroy(); globalThis.__piSessions = oldSessions; globalThis.__piStartingSessionCwds = oldStarting; });
  fixtureChat.inner.isStreaming = true;
  assert.throws(() => reserveAutomationCwd(root, () => hasBusyRpcSessionForCwd(root)), /in use/);
  fixtureChat.inner.isStreaming = false;
  globalThis.__piStartingSessionCwds = new Map([[canonicalResourceCwd(root), 1]]);
  assert.throws(() => reserveAutomationCwd(root, () => hasBusyRpcSessionForCwd(root)), /in use/);
  globalThis.__piStartingSessionCwds.clear();
  reserveAutomationCwd(root, () => hasBusyRpcSessionForCwd(root))();
});

test("connection uncertainty fences saved workspace scopes without blocking another workspace", async (t) => {
  const root = await fixture(t);
  const descriptorPath = path.join(root, "connection.json");
  const owned = path.join(root, "owned");
  const other = path.join(root, "other");
  await writeFile(path.join(root, "rules.json"), JSON.stringify({ rules: [{ cwd: owned }] }));
  globalThis.__piAutomationRuntime = { descriptorPath };
  await assert.rejects(assertNoAutomationOwner(owned), /ownership is unavailable/);
  await assertNoAutomationOwner(other);
  await mkdir(path.join(root, "worker"));
  await writeFile(path.join(root, "worker", "1.json"), JSON.stringify({ stage: "running", job: { rule: { cwd: other } } }));
  await assert.rejects(assertNoAutomationOwner(other), /ownership is unavailable/);
  await writeFile(path.join(root, "rules.json"), "{broken");
  await assert.rejects(assertNoAutomationOwner(path.join(root, "unknown")), /ownership is unavailable/);
});

test("ordinary shutdown keeps its directory fenced until cancellation actually settles", async (t) => {
  const root = await fixture(t);
  const completion = Promise.withResolvers();
  const abort = Promise.withResolvers();
  const fixtureChat = chat(root, () => completion.promise);
  fixtureChat.inner.clearQueue = () => ({ steering: [], followUp: [] });
  fixtureChat.inner.abortBash = () => {};
  fixtureChat.inner.abortCompaction = () => {};
  fixtureChat.inner.abort = async () => { await abort.promise; completion.resolve(); };
  fixtureChat.inner.extensionRunner = {};
  await fixtureChat.wrapper.send({ type: "prompt", message: "working" });
  const stopping = fixtureChat.wrapper.shutdown();
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/);
  abort.resolve();
  await stopping;
  reserveAutomationCwd(root, () => false)();
});

test("actual ordinary SDK resources include the tool gate for extension-driven calls", { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_OFFLINE = "1";
  let session;
  t.after(async () => {
    await session?.shutdown();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
  });
  ({ session } = await startRpcSession("__ordinary_resource_guard__", "", root));
  await session.send({ type: "get_commands" });
  const extension = session.inner.resourceLoader.getExtensions().extensions.find((entry) => entry.path === "<inline:desktop-chat-resource-guard>");
  assert.ok(extension);
  const [handler] = extension.handlers.get("tool_call");
  globalThis.__piAutomationRuntime = { hub: { call: async () => ({ owner: { run: 1, cwd: root } }) } };
  assert.equal((await handler({ toolName: "edit" }, {})).block, true);
  reserveAutomationCwd(root, () => false)();
  globalThis.__piAutomationRuntime = { hub: { call: async () => ({ owner: null }) } };
  assert.equal(await handler({ toolName: "edit" }, {}), undefined);
  assert.throws(() => reserveAutomationCwd(root, () => false), /in use/);
  await session.shutdown();
  reserveAutomationCwd(root, () => false)();
});
