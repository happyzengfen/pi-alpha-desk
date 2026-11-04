import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, AUTOMATION_TOOL_NAMES, getRpcSession, startRpcSession } = await jiti.import("../rpc-manager.ts");
const { executePiAutomationRound, runPiAutomationRound } = await jiti.import("./pi-executor.ts");
const { beginChatCwdUse, reserveAutomationCwd } = await jiti.import("./resource-guard.ts");

function harness(prompt) {
  let subscriber;
  const calls = [];
  const stats = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.1 };
  const inner = {
    sessionId: "managed-session", sessionFile: "/managed-session.jsonl",
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    sessionManager: { getSessionFile() { return ""; } },
    subscribe(listener) { subscriber = listener; return () => {}; },
    getSessionStats() { return structuredClone(stats); },
    getActiveToolNames() { return [...AUTOMATION_TOOL_NAMES]; },
    setActiveToolsByName(names) { calls.push(["tools", names]); },
    async waitForIdle() { calls.push(["idle"]); },
    async prompt(message, options) { calls.push(["prompt", message, options]); await prompt?.(inner, emit, stats); },
    clearQueue() { calls.push(["clear"]); return { steering: [], followUp: [] }; },
    abortBash() { calls.push(["abort_bash"]); },
    abortCompaction() { calls.push(["abort_compaction"]); },
    async abort() { calls.push(["abort"]); },
    extensionRunner: {},
    dispose() {},
  };
  const emit = (event) => subscriber(event);
  const wrapper = new AgentSessionWrapper(inner, process.cwd(), undefined, "automation");
  wrapper.start();
  return { wrapper, inner, emit, calls, stats };
}

test("one round captures only its new final reply and usage and waits beyond agent_end", async () => {
  const idle = Promise.withResolvers();
  const fixture = harness(async (_inner, emit, stats) => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate" }] } });
    emit({ type: "agent_end" });
    emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [
      { type: "thinking", thinking: "private" }, { type: "text", text: "final receipt" },
    ] } });
    stats.tokens.input += 20;
    stats.tokens.output += 5;
    stats.tokens.total += 25;
    stats.cost += 0.2;
  });
  fixture.inner.waitForIdle = () => idle.promise;
  try {
    let completed = false;
    const result = runPiAutomationRound(fixture.wrapper, { prompt: "inspect" }).then((value) => { completed = true; return value; });
    await new Promise(setImmediate);
    assert.equal(completed, false);
    idle.resolve();
    const round = await result;
    assert.equal(round.text, "final receipt");
    assert.equal(round.usage.total, 25);
    assert.equal(round.usage.input, 20);
    assert.equal(round.usage.output, 5);
    assert.ok(Math.abs(round.usage.cost - 0.2) < 1e-10);
  } finally { fixture.wrapper.destroy(); }
});

test("repair disables tools for exactly one round, then restores read/search tools", async () => {
  const fixture = harness(async (_inner, emit) => {
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "{}" }] } });
  });
  try {
    await runPiAutomationRound(fixture.wrapper, { prompt: "repair the receipt only", repair: true });
    assert.deepEqual(fixture.calls.filter(([name]) => name === "tools"), [["tools", []], ["tools", [...AUTOMATION_TOOL_NAMES]]]);
    assert.deepEqual(fixture.calls.find(([name]) => name === "prompt")[2], { source: "rpc" });
  } finally { fixture.wrapper.destroy(); }
});

test("cancellation drains the queue and aborts model, bash, and compaction", async () => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const fixture = harness(async () => { started.resolve(); await pending.promise; });
  fixture.inner.abort = async () => { fixture.calls.push(["abort"]); pending.resolve(); };
  try {
    const round = runPiAutomationRound(fixture.wrapper, { prompt: "inspect", signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(round, { name: "AbortError" });
    for (const name of ["clear", "abort_bash", "abort_compaction", "abort"]) {
      assert.ok(fixture.calls.some(([call]) => call === name), name);
    }
    assert.equal(fixture.wrapper.isRunning(), false);
  } finally { fixture.wrapper.destroy(); }
});

test("a concurrent round, queued work, or direct chat mutation cannot enter a managed session", async () => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const fixture = harness(async (_inner, emit) => {
    started.resolve(); await pending.promise;
    emit({ type: "message_end", message: { role: "assistant", content: "done" } });
  });
  try {
    const round = runPiAutomationRound(fixture.wrapper, { prompt: "first" });
    await started.promise;
    await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "second" }), /busy/);
    await assert.rejects(fixture.wrapper.send({ type: "set_tools", toolNames: ["bash"] }), /automation service/);
    await assert.rejects(fixture.wrapper.send({ type: "prompt", message: "interactive" }), /automation service/);
    pending.resolve();
    await round;
    fixture.inner.pendingMessageCount = 1;
    await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "third" }), /busy/);
    assert.equal(fixture.calls.filter(([name]) => name === "prompt").length, 1);
  } finally { fixture.wrapper.destroy(); }
});

test("no assistant or a provider error cannot return an old successful reply", async () => {
  for (const message of [undefined, { role: "assistant", stopReason: "error", errorMessage: "provider failed" }]) {
    const fixture = harness(async (_inner, emit) => { if (message) emit({ type: "message_end", message }); });
    try {
      await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "inspect" }), message ? /provider failed/ : /no assistant/);
    } finally { fixture.wrapper.destroy(); }
  }
});

test("a failed durable checkpoint prevents the provider call and releases the busy claim", async () => {
  const fixture = harness();
  try {
    await assert.rejects(runPiAutomationRound(fixture.wrapper, {
      prompt: "never send",
      beforePrompt: async () => { throw new Error("checkpoint failed"); },
    }), /checkpoint failed/);
    assert.equal(fixture.calls.some(([name]) => name === "prompt"), false);
    assert.equal(fixture.wrapper.isRunning(), false);
  } finally { fixture.wrapper.destroy(); }
});

test("startup persists managed mode, avoids local extensions and default writes, and rejects chat adoption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-executor-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  const originalSettings = JSON.stringify({ defaultProvider: "original", defaultModel: "original", defaultThinkingLevel: "low" });
  await writeFile(settingsPath, originalSettings);
  const trapOutput = path.join(root, "extension-executed");
  const trapSource = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(trapOutput)}, "executed"); export default function () {}`;
  await writeFile(path.join(cwd, ".pi", "extensions", "trap.ts"), trapSource);
  await mkdir(path.join(process.env.PI_CODING_AGENT_DIR, "extensions"));
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "trap.ts"), trapSource);
  let wrapper;
  try {
    ({ session: wrapper } = await startRpcSession("__automation_test__", "", cwd, { executionMode: "automation", thinkingLevel: "high", toolNames: ["bash", "edit"] }));
    assert.equal(wrapper.executionMode, "automation");
    assert.deepEqual(wrapper.inner.getActiveToolNames().sort(), [...AUTOMATION_TOOL_NAMES].sort());
    assert.deepEqual(wrapper.inner.resourceLoader.getSkills().skills, []);
    assert.deepEqual(wrapper.inner.resourceLoader.getExtensions().extensions, []);
    await assert.rejects(access(trapOutput), { code: "ENOENT" });
    const sessionId = wrapper.sessionId;
    const sessionFile = wrapper.sessionFile;
    assert.match(await readFile(sessionFile, "utf8"), /desktop-automation-session/);
    assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
    await wrapper.shutdown();
    ({ session: wrapper } = await startRpcSession(sessionId, sessionFile, cwd));
    assert.equal(wrapper.executionMode, "automation");
    await wrapper.shutdown();
    wrapper = undefined;

    let called = false;
    await assert.rejects(executePiAutomationRound({ cwd, prompt: "never send", onSession: async ({ sessionFile: file }) => {
      called = true;
      assert.match(await readFile(file, "utf8"), /desktop-automation-session/);
      assert.throws(() => beginChatCwdUse(cwd), /Automation is using/);
      throw new Error("checkpoint failed");
    } }), /checkpoint failed/);
    assert.equal(called, true);
    const released = beginChatCwdUse(cwd);
    await released.check();
    released.release();

    const ordinary = beginChatCwdUse(cwd);
    await assert.rejects(executePiAutomationRound({ cwd, prompt: "must not start" }), /working directory is in use/);
    ordinary.release();
    reserveAutomationCwd(cwd, () => false)();

    const cleanup = Promise.withResolvers();
    const stopping = Promise.withResolvers();
    const closingRound = executePiAutomationRound({ cwd, prompt: "must not call a model", onSession: async ({ sessionId: id }) => {
      getRpcSession(id).inner.extensionRunner.emit = async () => { stopping.resolve(); await cleanup.promise; };
      throw new Error("fixture cancelled before provider call");
    } });
    await stopping.promise;
    assert.throws(() => beginChatCwdUse(cwd), /Automation is using/, "reservation remains held during SDK shutdown");
    cleanup.resolve();
    await assert.rejects(closingRound, /fixture cancelled/);
    const afterCleanup = beginChatCwdUse(cwd);
    await afterCleanup.check();
    afterCleanup.release();

    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const chat = SessionManager.create(cwd, path.join(root, "chat"));
    chat.appendCustomEntry("ordinary-chat", {});
    const chatFile = chat.getSessionFile();
    await mkdir(path.dirname(chatFile), { recursive: true });
    await writeFile(chatFile, [chat.getHeader(), ...chat.getEntries()].map(JSON.stringify).join("\n") + "\n");
    await assert.rejects(startRpcSession(chat.getSessionId(), chatFile, cwd, { executionMode: "automation" }), /Cannot adopt a chat session/);
  } finally {
    await wrapper?.shutdown();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
