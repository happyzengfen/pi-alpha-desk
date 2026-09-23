import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createToolFreePromptPolicy } = await jiti.import("./tool-free-prompt.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("tool-free requests keep an empty prompt across reloads and can re-enable tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-tool-free-"));
  const { policy, extension } = createToolFreePromptPolicy(true);
  let wrapper;
  try {
    const services = await createAgentSessionServices({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [extension],
      },
    });
    const model = services.modelRuntime.getModel("openai", "gpt-6-sol");
    assert.ok(model);
    await services.modelRuntime.setRuntimeApiKey("openai", "test-only-not-a-real-key");
    const { session } = await createAgentSessionFromServices({
      services, sessionManager: SessionManager.inMemory(root), model,
    });
    wrapper = new AgentSessionWrapper(session, root, policy);
    const requests = [];
    session.agent.streamFunction = (model, context) => {
      requests.push(structuredClone(context));
      const message = {
        role: "assistant", content: [{ type: "text", text: "OK" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    await session.bindExtensions({ mode: "rpc" });
    assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, "");
    await session.prompt("First request");
    assert.equal(requests.length, 1);
    assert.equal(getCurrentSystemPrompt(requests[0].messages), "");
    assert.deepEqual(getCurrentTools(requests[0].messages), []);

    await session.reload();
    await session.prompt("After reload");
    assert.equal(requests.length, 2);
    assert.equal(getCurrentSystemPrompt(requests[1].messages), "");
    assert.deepEqual(getCurrentTools(requests[1].messages), []);

    await wrapper.send({ type: "set_tools", toolNames: ["read"] });
    await session.prompt("Tools enabled again");
    assert.equal(requests.length, 3);
    assert.ok(getCurrentSystemPrompt(requests[2].messages).length > 0);
    assert.deepEqual(getCurrentTools(requests[2].messages).map((tool) => tool.name), ["read"]);
    assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, session.systemPrompt);

    await wrapper.send({ type: "set_tools", toolNames: [] });
    await session.prompt("Tools disabled again");
    assert.equal(requests.length, 4);
    assert.equal(getCurrentSystemPrompt(requests[3].messages), "");
    assert.deepEqual(getCurrentTools(requests[3].messages), []);
  } finally {
    wrapper?.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
