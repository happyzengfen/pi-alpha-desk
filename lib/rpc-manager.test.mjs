import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("RPC validates image arrays before sending prompt, steer, or follow-up commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const sendSource = source.slice(
    source.indexOf("  async send(command:"),
    source.indexOf("    switch (type) {", source.indexOf("  async send(command:")),
  );

  assert.match(sendSource, /type === "prompt" \|\| type === "steer" \|\| type === "follow_up"/);
  assert.match(sendSource, /validateAgentImages\(command\.images\)/);
});

test("an empty fork is persisted before its id is returned to the client", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-empty-fork-"));
  try {
    const cwd = join(root, "project");
    const sessionDir = join(root, "sessions");
    const sourceManager = SessionManager.create(cwd, sessionDir);
    const parentSessionFile = join(sessionDir, "parent.jsonl");
    const { createPersistedEmptyForkSession } = await jiti.import("./rpc-manager.ts");

    const result = createPersistedEmptyForkSession(sourceManager, parentSessionFile);
    const header = JSON.parse((await readFile(result.newSessionFile, "utf8")).trim());

    assert.equal(header.id, result.newSessionId);
    assert.equal(header.cwd, cwd);
    assert.equal(header.parentSession, parentSessionFile);
    assert.equal(SessionManager.open(result.newSessionFile, sessionDir).getSessionId(), result.newSessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain-text extension theme supports current pi background keys", async () => {
  const { PlainTextTheme } = await jiti.import("./rpc-manager.ts");
  const theme = new PlainTextTheme();

  assert.equal(theme.bg("selectedBg", "text"), "text");
  assert.equal(theme.bg("scrollbarThumb", "text"), "text");
});

test("custom extension UI receives the headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
  assert.match(customUiSource, /emitCustomUiRender/);
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("RPC startup opens an existing session once and uses its canonical cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const commandRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventsRoute = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  assert.match(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)\.some\(\(entry\) => entry\.type === "message"\)/);
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(commandRoute, /SessionManager\.open\(/);
  assert.doesNotMatch(eventsRoute, /SessionManager\.open\(/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");

  assert.match(source, /void this\.shutdown\(\)\.catch/);
  assert.match(source, /await this\.shutdown\(\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("a non-retrying provider error settles and aborts a stuck prompt", async () => {
  let subscriber;
  let abortCalls = 0;
  const emitted = [];
  let rejectPrompt;
  const prompt = new Promise((_resolve, reject) => {
    rejectPrompt = reject;
  });
  const inner = {
    sessionId: "session-id",
    sessionFile: "",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    subscribe(listener) {
      subscriber = listener;
      return () => {};
    },
    prompt() {
      return prompt;
    },
    async abort() {
      abortCalls += 1;
      this.isStreaming = false;
      rejectPrompt(new Error("Request aborted"));
    },
    sessionManager: {
      getSessionFile() { return ""; },
    },
    extensionRunner: {},
    dispose() {},
  };
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const wrapper = new AgentSessionWrapper(inner, process.cwd());
  wrapper.onEvent((event) => emitted.push(event));
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "hello" });
  subscriber({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "upstream failed" }],
  });
  await Promise.resolve();

  assert.equal(abortCalls, 1);
  assert.equal(wrapper.isRunning(), false);
  assert.equal(emitted.filter((event) => event.type === "prompt_done").length, 1);
  assert.equal(emitted.filter((event) => event.type === "prompt_error").length, 0);
  wrapper.destroy();
});

test("RPC session startup persists explicit preferences without replaying setters", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
});
