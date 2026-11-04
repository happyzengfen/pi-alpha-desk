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
const { inspectAutomationSession, saveAutomationBinding } = await jiti.import("./session-binding.ts");

function harness(prompt) {
  let subscriber;
  const calls = [];
  const stats = { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.1 };
  const inner = {
    sessionId: "managed-session", sessionFile: "/managed-session.jsonl",
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    sessionManager: { getSessionFile() { return ""; } },
    agent: {},
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
    await assert.rejects(fixture.wrapper.send({ type: "fork" }), /automation service/);
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

test("HTTP status observation preserves each supported adapter's fetch request, Response and existing callbacks", async () => {
  for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages", "google-generative-ai"]) {
    const input = new Request("http://127.0.0.1:9/fixture");
    const init = { method: "POST", headers: { "x-fixture": "unchanged" }, body: "fixture-body" };
    const response = new Response("fixture-response", { status: 200 });
    const context = { messages: [], tools: [] };
    const result = {};
    let calls = 0;
    const originalFetch = async (request, options) => { assert.equal(request, input); assert.equal(options, init); calls++; return response; };
    const options = { fetch: originalFetch, maxRetries: 0, headers: { "x-provider": "unchanged" } };
    let callbackCalls = 0;
    const originalCallback = async () => { callbackCalls++; };
    const originalStream = async (model, actualContext, actualOptions) => {
      assert.equal(actualContext, context);
      assert.equal(actualOptions.headers, options.headers);
      assert.equal(actualOptions.maxRetries, 0);
      if (api === "google-generative-ai") assert.equal(actualOptions, options, "Unsupported adapters receive their original options object");
      assert.equal(await actualOptions.fetch(input, init), response, "The status observer must return the same Response without consuming it");
      assert.equal(response.bodyUsed, false);
      await fixture.inner.agent.onResponse({ status: 200, headers: {} }, model);
      return result;
    };
    const fixture = harness(async (_inner, emit) => {
      assert.equal(await fixture.inner.agent.streamFunction({ api, provider: "fixture-provider" }, context, options), result);
      emit({ type: "message_end", message: { role: "assistant", content: "finished", stopReason: "stop" } });
    });
    fixture.inner.agent.streamFunction = originalStream;
    fixture.inner.agent.onResponse = originalCallback;
    try {
      await runPiAutomationRound(fixture.wrapper, { prompt: "inspect" });
      assert.equal(fixture.inner.agent.streamFunction, originalStream);
      assert.equal(fixture.inner.agent.onResponse, originalCallback);
      assert.equal(calls, 1);
      assert.equal(callbackCalls, 1);
      assert.equal(options.fetch, originalFetch);
    } finally { fixture.wrapper.destroy(); }
  }
});

test("Bedrock recovery uses only its structured numeric denial diagnostic before any tool starts", async () => {
  for (const [status, toolsStarted, recoverable] of [[401, false, true], [403, false, true], ["401", false, false], [401, true, false]]) {
    const fixture = harness(async (_inner, emit) => {
      if (toolsStarted) emit({ type: "tool_execution_start" });
      emit({ type: "message_end", message: { role: "assistant", provider: "amazon-bedrock", stopReason: "error", errorMessage: "Opaque provider error",
        diagnostics: [{ type: "bedrock_response_failure", details: { status } }] } });
    });
    try {
      await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "inspect" }), (error) => recoverable
        ? error.provider === "amazon-bedrock" && error.status === status
        : error.message === "Opaque provider error");
    } finally { fixture.wrapper.destroy(); }
  }
});

test("historical authentication denials cannot replace a later success or a settlement failure", async () => {
  for (const scenario of ["401-then-200", "401-then-success", "401-then-idle-error", "terminal-401"]) {
    const fixture = harness(async (_inner, emit) => {
      await fixture.inner.agent.onResponse({ status: 401, headers: {} }, { provider: "fixture" });
      if (scenario === "401-then-200") await fixture.inner.agent.onResponse({ status: 200, headers: {} }, { provider: "fixture" });
      emit({ type: "message_end", message: { role: "assistant", stopReason: scenario.includes("idle-error") || scenario === "terminal-401" ? "error" : "stop",
        content: "Recovered successfully", errorMessage: "Provider refused authentication" } });
    });
    if (scenario === "401-then-idle-error") fixture.inner.waitForIdle = async () => { throw new Error("Unknown idle settlement failure"); };
    try {
      if (scenario === "terminal-401") await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "inspect" }), (error) => error.provider === "fixture" && error.status === 401);
      else if (scenario === "401-then-idle-error") await assert.rejects(runPiAutomationRound(fixture.wrapper, { prompt: "inspect" }), /Unknown idle settlement failure/);
      else assert.equal((await runPiAutomationRound(fixture.wrapper, { prompt: "inspect" })).text, "Recovered successfully");
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
  await writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { original: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-only-key",
    models: ["original", "other-default"].map((id) => ({ id, name: "No-request checkpoint fixture", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
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
    const preparedId = wrapper.sessionId;
    const preparedFile = wrapper.sessionFile;
    const preparedBytes = await readFile(preparedFile, "utf8");
    assert.equal(preparedBytes.split("\n").filter(Boolean).map(JSON.parse).some((entry) => entry.type === "message"), false);
    await wrapper.shutdown();
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(originalSettings), defaultModel: "other-default" }));
    ({ session: wrapper } = await startRpcSession(preparedId, preparedFile, undefined));
    await wrapper.send({ type: "get_tools" });
    assert.equal(wrapper.inner.model.id, "original", "A prepared managed viewer keeps its model before the first user message");
    assert.equal(wrapper.inner.agent.state.thinkingLevel, "off");
    assert.equal(Object.hasOwn(wrapper.inner.sessionManager, "appendModelChange"), false);
    assert.equal(Object.hasOwn(wrapper.inner.sessionManager, "appendThinkingLevelChange"), false);
    assert.equal(await readFile(preparedFile, "utf8"), preparedBytes);
    await writeFile(settingsPath, originalSettings);
    await wrapper.inner.reload();
    assert.deepEqual(wrapper.inner.getActiveToolNames().sort(), [...AUTOMATION_TOOL_NAMES].sort());
    assert.deepEqual(wrapper.inner.resourceLoader.getSkills().skills, []);
    assert.deepEqual(wrapper.inner.resourceLoader.getExtensions().extensions, []);
    assert.deepEqual(wrapper.inner.resourceLoader.getAgentsFiles().agentsFiles, []);
    const repairSessionId = wrapper.sessionId;
    const repairSessionFile = wrapper.sessionFile;
    await wrapper.shutdown();
    ({ session: wrapper } = await startRpcSession(repairSessionId, repairSessionFile, cwd, { executionMode: "automation", automationRepair: true }));
    wrapper.inner.setActiveToolsByName([]);
    await wrapper.inner.reload();
    assert.deepEqual(wrapper.inner.getActiveToolNames(), [], "Repair reload keeps its empty tool allow-list");
    assert.deepEqual(wrapper.inner.resourceLoader.getSkills().skills, []);
    assert.deepEqual(wrapper.inner.resourceLoader.getExtensions().extensions, []);
    assert.deepEqual(wrapper.inner.resourceLoader.getAgentsFiles().agentsFiles, []);
    await wrapper.shutdown();
    ({ session: wrapper } = await startRpcSession(repairSessionId, repairSessionFile, cwd, { executionMode: "automation" }));
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
    await assert.rejects(startRpcSession(chat.getSessionId(), chatFile, cwd, { executionMode: "automation" }), /session was removed or changed/);
  } finally {
    await wrapper?.shutdown();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("the ordinary pre-open guard retains the SDK's versionless v1 migration", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-legacy-header-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_OFFLINE = "1";
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "legacy.jsonl");
  const legacy = JSON.stringify({ type: "session", id: "legacy-versionless", timestamp: new Date().toISOString(), cwd: root }) + "\n";
  await writeFile(file, legacy);
  const release = reserveAutomationCwd(root, () => false);
  try {
    await assert.rejects(startRpcSession("legacy-versionless", file, root), /Automation is using this working directory/);
    assert.equal(await readFile(file, "utf8"), legacy, "Resource ownership is checked before SDK migration writes");
  } finally { release(); }
  const { session } = await startRpcSession("legacy-versionless", file, root, { toolNames: [] });
  try {
    await session.send({ type: "get_tools" });
    assert.equal(JSON.parse((await readFile(file, "utf8")).split("\n")[0]).version, 3);
  } finally { await session.shutdown(); }
});

test("automation validates missing, empty and damaged session files before SDK open can rewrite them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-session-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "managed-validation";
  const file = path.join(root, "session.jsonl");
  const header = { type: "session", version: 3, id: sessionId, cwd: root, timestamp: new Date().toISOString() };
  const marker = { type: "custom", id: "marker", customType: "desktop-automation-session", data: { version: 1 } };
  for (const content of [undefined, "", "{broken}\n", JSON.stringify({ ...header, id: "different" }) + "\n" + JSON.stringify(marker) + "\n", JSON.stringify(header) + "\n" + JSON.stringify(marker) + "\n{broken-tail}\n", JSON.stringify(header) + "\n"] ) {
    if (content === undefined) await rm(file, { force: true });
    else await writeFile(file, content);
    await assert.rejects(startRpcSession(sessionId, file, root, { executionMode: "automation" }), /session was removed or changed/);
    if (content !== JSON.stringify(header) + "\n") {
      await assert.rejects(startRpcSession(sessionId, file, undefined), /session was removed or changed|header is missing or invalid/);
    }
    if (content === undefined) await assert.rejects(access(file), { code: "ENOENT" });
    else assert.equal(await readFile(file, "utf8"), content);
  }
  const previousRuntime = globalThis.__piAutomationRuntime;
  globalThis.__piAutomationRuntime = { descriptorPath: path.join(root, "descriptor.json") };
  try {
    await mkdir(path.join(root, "sessions"));
    await writeFile(file, [header, marker].map(JSON.stringify).join("\n") + "\n");
    await saveAutomationBinding(root, { version: 1, sessionId, sessionFile: file, cwd: root, ruleIds: ["rule-fixture"], digest: inspectAutomationSession(file).digest, started: true });
    const truncated = JSON.stringify(header) + "\n";
    await writeFile(file, truncated);
    await assert.rejects(startRpcSession(sessionId, file, undefined), /session was removed or changed/);
    assert.equal(await readFile(file, "utf8"), truncated, "A private binding still identifies a managed file after its marker was truncated");
  } finally { globalThis.__piAutomationRuntime = previousRuntime; }
});
