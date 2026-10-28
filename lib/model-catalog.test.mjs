import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const { resolveVisibleModels, selectInitialModelScope } = await createJiti(import.meta.url).import("./model-scope.ts");
const modelId = "gpt-6.1-sol";
const providers = [
  ["openai", "openai-responses", openaiProvider],
  ["openai-codex", "openai-codex-responses", openaiCodexProvider],
  ["azure-openai-responses", "azure-openai-responses", azureOpenAIResponsesProvider],
];

for (const [providerId, api, createProvider] of providers) {
  test(`built-in ${providerId} catalog includes GPT-6.1 Sol capabilities`, () => {
    const model = createProvider().getModels().find((entry) => entry.id === modelId);
    assert.ok(model, `Missing built-in ${providerId}/${modelId}`);
    assert.equal(model.provider, providerId);
    assert.equal(model.api, api);
    assert.equal(model.name, "GPT-6.1 Sol");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.ok(model.contextWindow > 0);
    assert.ok(model.maxTokens > 0);
    const levels = getSupportedThinkingLevels(model);
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      assert.ok(levels.includes(level), `${providerId}/${modelId} must support ${level}`);
    }
  });

  test(`${providerId} GPT-6.1 Sol remains selectable when a desktop session is created`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("Model selection must not access the network"));
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-model-catalog-"));
    let session;
    try {
      const authPath = join(root, "auth.json");
      const modelsPath = join(root, "models.json");
      await writeFile(authPath, JSON.stringify({
        [providerId]: providerId === "openai-codex"
          ? { type: "oauth", access: "test-only-access", refresh: "test-only-refresh", expires: Date.now() + 3_600_000 }
          : { type: "api_key", key: "test-only-not-a-real-key" },
      }));
      await writeFile(modelsPath, "{}");
      const modelRuntime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
      assert.ok(modelRuntime.getModel(providerId, modelId), `Missing runtime ${providerId}/${modelId}`);
      const settingsManager = SettingsManager.inMemory({
        enabledModels: [`${providerId}/${modelId}:high`],
        retry: { enabled: false }, compaction: { enabled: false },
      });
      const services = await createAgentSessionServices({
        cwd: root, agentDir: root, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        },
      });
      const scope = await resolveVisibleModels(services.modelRuntime, settingsManager.getEnabledModels());
      assert.deepEqual(scope.visible.map((model) => `${model.provider}/${model.id}`), [`${providerId}/${modelId}`]);
      assert.deepEqual(scope.warnings, []);
      const initial = selectInitialModelScope(scope, { requestedModel: { provider: providerId, modelId } });
      assert.equal(initial.thinkingLevel, "high");
      ({ session } = await createAgentSessionFromServices({
        services, sessionManager: SessionManager.inMemory(root), tools: [], ...initial,
      }));
      assert.equal(session.model?.provider, providerId);
      assert.equal(session.model?.id, modelId);
      assert.equal(session.agent.state.thinkingLevel, "high");
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
