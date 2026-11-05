import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { executePiAutomationRound } = await jiti.import("./pi-executor.ts");
const { getRpcSession, startRpcSession, AUTOMATION_TOOL_NAMES } = await jiti.import("../rpc-manager.ts");
const { trustProject } = await jiti.import("../project-trust.ts");
const { promptFor, readMessage, resultFrom } = await jiti.import("../../automation-hub/upstream/worker/contract.ts");

test("native SDK streams read tools, persists an ask, and resumes the same session to done using only a local provider", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-native-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  const contextFile = path.join(cwd, "context.json");
  const answersFile = path.join(cwd, "answers.json");
  const trapOutput = path.join(root, "extension-executed");
  const provider = "automation-local-fixture";
  const modelId = "fixture-model";
  const previousEnvironment = new Map(["PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const requests = [];
  const failures = [];
  const events = [];
  const checkpoints = [];
  const askText = "已核实只读资料，等待选择。\n```agent-autoloop\n" + JSON.stringify({ ask: [{
    title: "选择交付颜色", text: "只读资料已核实，请选一种颜色。", options: ["蓝色", "绿色"],
    recommend: 0, key: "delivery-color", about: "资料已读取；回答后只需确认选择，不重做已完成的检查。",
  }] }) + "\n```";
  const doneText = "已按用户选择蓝色完成，只读验证通过。";

  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-only-key");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const index = requests.length;
      requests.push(body);
      assert.equal(body.model, modelId);
      assert.equal(body.stream, true);
      if (index === 4) assert.ok(!body.tools?.length, "The explicit repair round cannot advertise tools after reload");
      else {
        assert.deepEqual(body.tools.map((tool) => tool.function.name).sort(), [...AUTOMATION_TOOL_NAMES].sort());
        assert.ok(!body.tools.some((tool) => /goal|ask_user|subagent|bash|edit|write/.test(tool.function.name)));
      }
      assert.ok(index < 5, "Only four business requests and one explicit repair are allowed");
      if (index === 1) {
        assert.ok(body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("fixture-source-marker")));
      }
      if (index === 2) {
        assert.ok(body.messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("delivery-color")), "Resumed request contains the original ask");
      }
      if (index === 3) {
        assert.ok(body.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("fixture-answer-marker")));
      }

      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const frame = (delta, finishReason = null, usage) => response.write(`data: ${JSON.stringify({
        id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
      })}\n\n`);
      frame({ role: "assistant", content: "" });
      if (index === 0 || index === 2) {
        const filename = index === 0 ? contextFile : answersFile;
        const args = JSON.stringify({ path: filename });
        frame({ tool_calls: [{ index: 0, id: `read-${index}`, type: "function", function: { name: "read", arguments: args.slice(0, 8) } }] });
        await new Promise(setImmediate);
        frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] });
      } else {
        const text = index === 1 ? askText : doneText;
        const midpoint = Math.floor(text.length / 2);
        frame({ content: text.slice(0, midpoint) });
        await new Promise(setImmediate);
        frame({ content: text.slice(midpoint) });
      }
      frame({}, index === 0 || index === 2 ? "tool_calls" : "stop", {
        prompt_tokens: 100 + index, completion_tokens: 10 + index, total_tokens: 110 + index * 2,
      });
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  let first;
  let second;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    const trapSource = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(trapOutput)}, "executed"); export default function () {}`;
    await writeFile(path.join(agentDir, "extensions", "trap.ts"), trapSource);
    await writeFile(path.join(cwd, ".pi", "extensions", "trap.ts"), trapSource);
    const settings = JSON.stringify({
      defaultProvider: "unchanged-default", defaultModel: "unchanged-model", defaultThinkingLevel: "low",
      enabledModels: [`${provider}/${modelId}`], compaction: { enabled: false }, retry: { enabled: false },
      cacheWarming: { enabled: false },
    });
    const settingsFile = path.join(agentDir, "settings.json");
    await writeFile(settingsFile, settings);
    await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only-key",
      models: [modelId, "viewer-default"].map((id) => ({ id, name: "Offline integration fixture", reasoning: false, input: ["text"],
        contextWindow: 65536, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    } } }));
    await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ [provider]: { type: "api_key", key: "fixture-only-key" } }));
    assert.equal(trustProject(cwd, agentDir).trusted, true);
    const context = {
      events: [{ id: "fixture-event", source: "local", sourceName: "local", type: "fixture.start", subject: "fixture", summary: "fixture-source-marker", detail: "资料", link: "", receivedAt: "2026-11-04T00:00:00Z" }],
      answers: [], timers: [], waiting: [], open: [], decided: [],
    };
    await writeFile(contextFile, JSON.stringify(context));
    const job = { run: 1, token: "fixture", attempt: 1, rule: { name: "本地验证", cwd, prompt: "先读取资料，提出颜色问题，拿到回答后确认完成。" },
      agent: { id: "pi", name: "pi", use: "pi", access: "read-only" }, session: null, askFirst: ["颜色选择"], context };
    const onSession = async (checkpoint) => {
      checkpoints.push(checkpoint);
      assert.match(await readFile(checkpoint.sessionFile, "utf8"), /desktop-automation-session/);
      const wrapper = getRpcSession(checkpoint.sessionId);
      assert.equal(wrapper.executionMode, "automation");
      assert.deepEqual(wrapper.inner.resourceLoader.getExtensions().extensions, []);
      assert.deepEqual(wrapper.inner.getActiveToolNames().sort(), [...AUTOMATION_TOOL_NAMES].sort());
      wrapper.onEvent((event) => events.push(event));
    };
    first = await executePiAutomationRound({ cwd, prompt: promptFor(job, contextFile), model: { provider, modelId }, thinkingLevel: "off", onSession });
    assert.deepEqual(failures, []);
    assert.equal(first.text, askText);
    assert.equal(first.usage.total, 222);
    assert.equal(first.usage.cost, 0);
    const ask = resultFrom(readMessage(first.text), { session: first.sessionId });
    assert.equal(ask.problem, undefined);
    assert.equal(ask.result.ask[0].key, "delivery-color");
    assert.equal(getRpcSession(first.sessionId), undefined, "Waiting for a decision releases the live SDK session");
    assert.equal(requests.length, 2);
    const beforeView = await readFile(first.sessionFile, "utf8");
    await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(settings), defaultProvider: provider, defaultModel: "viewer-default", enabledModels: [`${provider}/*`] }));
    let viewer;
    try {
      ({ session: viewer } = await startRpcSession(first.sessionId, first.sessionFile, undefined));
      await viewer.send({ type: "get_tools" });
      assert.equal(viewer.inner.model.id, modelId, "A managed viewer retains its persisted rule model");
      assert.equal(await readFile(first.sessionFile, "utf8"), beforeView, "Read-only viewing must not change the execution binding digest");
      await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(settings), defaultProvider: provider, defaultModel: "viewer-default", enabledModels: [`${provider}/viewer-default`] }));
      let submitted = false;
      await assert.rejects(executePiAutomationRound({ cwd, sessionId: first.sessionId, sessionFile: first.sessionFile,
        prompt: "Must not call a model excluded from the updated scope", model: { provider, modelId }, onSession: () => { submitted = true; } }), /not available in the enabled scope/);
      assert.equal(submitted, false);
      assert.equal(requests.length, 2, "Reusing the viewer rechecks updated scope before any HTTP request");
      assert.equal(await readFile(first.sessionFile, "utf8"), beforeView);
    } finally { await viewer?.shutdown(); await writeFile(settingsFile, settings); }

    const answeredContext = { ...context, answers: [{ card: 1, title: "选择交付颜色", options: ["蓝色", "绿色"], choice: 0, text: "fixture-answer-marker", about: "使用蓝色，继续剩余步骤。", by: "fixture-user", at: "2026-11-04T00:01:00Z" }] };
    await writeFile(answersFile, JSON.stringify(answeredContext));
    second = await executePiAutomationRound({ cwd, sessionId: first.sessionId, sessionFile: first.sessionFile,
      prompt: promptFor({ ...job, run: 2, session: first.sessionId, context: answeredContext }, answersFile),
      model: { provider, modelId }, thinkingLevel: "off", onSession });
    assert.deepEqual(failures, []);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.sessionFile, first.sessionFile);
    assert.equal(second.text, doneText);
    assert.equal(second.usage.total, 230);
    assert.equal(resultFrom(readMessage(second.text), { session: second.sessionId }).result.outcome, "done");
    assert.equal(requests.length, 4);
    assert.equal(checkpoints.length, 2);
    assert.equal(getRpcSession(first.sessionId), undefined);
    assert.ok(events.filter((event) => event.type === "message_update").length >= 4, "SDK emitted real stream updates");
    assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 2);
    const entries = (await readFile(first.sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 2);
    assert.equal(entries.some((entry) => entry.customType === "goal-state"), false);
    assert.equal(await readFile(settingsFile, "utf8"), settings);
    await assert.rejects(access(trapOutput), { code: "ENOENT" });
    const repair = await executePiAutomationRound({ cwd, sessionId: first.sessionId, sessionFile: first.sessionFile,
      prompt: "Repair only the receipt formatting; do not repeat the completed business.", repair: true,
      model: { provider, modelId }, thinkingLevel: "off", onSession: async ({ sessionId }) => {
        const wrapper = getRpcSession(sessionId);
        assert.deepEqual(wrapper.inner.getActiveToolNames(), []);
        await wrapper.inner.reload();
        assert.deepEqual(wrapper.inner.getActiveToolNames(), []);
        assert.deepEqual(wrapper.inner.resourceLoader.getSkills().skills, []);
        assert.deepEqual(wrapper.inner.resourceLoader.getExtensions().extensions, []);
        assert.deepEqual(wrapper.inner.resourceLoader.getAgentsFiles().agentsFiles, []);
      } });
    assert.equal(repair.sessionId, first.sessionId);
    assert.equal(requests.length, 5);
    assert.deepEqual(failures, []);
    await assert.rejects(access(trapOutput), { code: "ENOENT" });
  } finally {
    for (const round of [first, second]) await getRpcSession(round?.sessionId)?.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
