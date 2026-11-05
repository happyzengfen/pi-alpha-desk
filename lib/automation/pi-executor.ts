import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasBusyRpcSessionForCwd, startRpcSession, type AgentEvent, type AgentSessionWrapper } from "../rpc-manager";
import type { SessionStatsInfo } from "../pi-types";
import { resolveVisibleModels, selectInitialModelScope } from "../model-scope";
import { reserveAutomationCwd } from "./resource-guard";
import { AutomationSessionChangedError, inspectAutomationSession, type AutomationSessionEvidence } from "./session-binding";
import { AutomationAuthenticationRequiredError, AutomationExecutionUncertainError, AutomationRoundFailedError, AutomationSessionOpenError } from "./execution-errors";

export interface PiAutomationRoundOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  sessionFile?: string;
  sessionDigest?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  repair?: boolean;
  onPrepared?: (session: AutomationSessionEvidence) => void | Promise<void>;
  onSession?: (session: AutomationSessionEvidence) => void | Promise<void>;
}

export interface PiAutomationRoundResult {
  sessionId: string;
  sessionFile: string;
  digest?: string;
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };
  stopReason?: string;
}

function finite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
const OBSERVABLE_HTTP_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses", "anthropic-messages"]);

/** One durable-session round; extensions and scheduling are owned by the host. */
export async function runPiAutomationRound(
  session: AgentSessionWrapper,
  options: Pick<PiAutomationRoundOptions, "prompt" | "signal" | "repair"> & { beforePrompt?: () => void | Promise<void> },
): Promise<PiAutomationRoundResult> {
  const before = session.inner.getSessionStats();
  let assistant: { content?: unknown; stopReason?: string; errorMessage?: string; provider?: string; diagnostics?: { type?: string; details?: { status?: unknown } }[] } | undefined;
  let toolsStarted = false;
  let deniedProvider: string | undefined;
  let deniedStatus: 401 | 403 | undefined;
  const agent = session.inner.agent as unknown as Agent;
  const previousStream = agent.streamFunction;
  const previousOnResponse = agent.onResponse;
  const observeStatus = (status: number, provider: string) => {
    deniedProvider = status === 401 || status === 403 ? provider : undefined;
    deniedStatus = status === 401 || status === 403 ? status : undefined;
  };
  agent.onResponse = async (response, model) => {
    observeStatus(response.status, model.provider);
    await previousOnResponse?.(response, model);
  };
  // These HTTP adapters throw on rejected responses before onResponse is called.
  // Their documented fetch option lets this round observe the actual status.
  if (previousStream) agent.streamFunction = (model, context, streamOptions) => {
    // A new provider request includes the preceding tools' completed results.
    // Only a tool started since this request can make its denial uncertain.
    toolsStarted = false;
    deniedProvider = undefined;
    deniedStatus = undefined;
    if (!OBSERVABLE_HTTP_APIS.has(model.api)) return previousStream(model, context, streamOptions);
    const originalFetch = streamOptions?.fetch ?? globalThis.fetch;
    return previousStream(model, context, { ...streamOptions, fetch: async (input, init) => {
      const response = await originalFetch(input, init);
      observeStatus(response.status, model.provider);
      return response;
    } });
  };
  const unsubscribe = session.onEvent((event: AgentEvent) => {
    if (event.type === "tool_execution_start") toolsStarted = true;
    if (event.type !== "message_end") return;
    const message = event.message as typeof assistant & { role?: string };
    if (message?.role === "assistant") {
      assistant = message;
      if (message.stopReason !== "error") { deniedProvider = undefined; deniedStatus = undefined; }
      for (const diagnostic of message.diagnostics ?? []) {
        const status = diagnostic.details?.status;
        if (diagnostic.type === "bedrock_response_failure" && (status === 401 || status === 403)) {
          deniedProvider = message.provider ?? session.inner.model?.provider;
          deniedStatus = status;
        }
      }
    }
  });
  try {
    await session.runAutomationPrompt(options.prompt, options);
    if (assistant?.stopReason === "aborted") {
      const error = new Error("Automation round cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (assistant?.stopReason === "error" && deniedProvider && !toolsStarted) throw new AutomationAuthenticationRequiredError(deniedProvider, deniedStatus);
    if (assistant?.stopReason === "error") throw new Error(assistant.errorMessage || "Automation provider failed");
    if (!assistant) throw new Error("Automation round produced no assistant reply");
    const after: Omit<SessionStatsInfo, "sessionName"> = session.inner.getSessionStats();
    const usage = {
      input: finite(after.tokens.input - before.tokens.input),
      output: finite(after.tokens.output - before.tokens.output),
      cacheRead: finite(after.tokens.cacheRead - before.tokens.cacheRead),
      cacheWrite: finite(after.tokens.cacheWrite - before.tokens.cacheWrite),
      total: finite(after.tokens.total - before.tokens.total),
      cost: finite(after.cost - before.cost),
    };
    const text = typeof assistant.content === "string" ? assistant.content : Array.isArray(assistant.content)
      ? assistant.content.filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text).join("\n")
      : "";
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      text,
      usage,
      ...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}),
    };
  } finally {
    agent.streamFunction = previousStream;
    agent.onResponse = previousOnResponse;
    unsubscribe();
  }
}

export async function executePiAutomationRound(options: PiAutomationRoundOptions): Promise<PiAutomationRoundResult> {
  if (options.signal?.aborted) {
    const error = new Error("Automation round cancelled");
    error.name = "AbortError";
    throw error;
  }
  if (Boolean(options.sessionFile) !== Boolean(options.sessionId)) {
    throw new Error("Automation resume requires both sessionId and sessionFile");
  }
  const persisted = options.sessionFile && options.sessionId ? inspectAutomationSession(options.sessionFile, { sessionId: options.sessionId, cwd: options.cwd, digest: options.sessionDigest }) : undefined;
  const release = reserveAutomationCwd(options.cwd, () => hasBusyRpcSessionForCwd(options.cwd));
  let session: AgentSessionWrapper | undefined;
  try {
    const agentDir = getAgentDir();
    const settings = SettingsManager.create(options.cwd, agentDir);
    const requested = options.model ?? persisted?.model ?? (settings.getDefaultProvider() && settings.getDefaultModel()
      ? { provider: settings.getDefaultProvider()!, modelId: settings.getDefaultModel()! } : undefined);
    if (requested) {
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
      if (runtime.getModel(requested.provider, requested.modelId) && !await runtime.checkAuth(requested.provider)) throw new AutomationAuthenticationRequiredError(requested.provider);
    }
    try {
      if (options.sessionFile && options.sessionId) inspectAutomationSession(options.sessionFile, { sessionId: options.sessionId, cwd: options.cwd, digest: options.sessionDigest });
      ({ session } = await startRpcSession(
      options.sessionId ?? `__automation__${randomUUID()}`,
      options.sessionFile ?? "",
      options.cwd,
      {
        executionMode: "automation",
        automationRepair: Boolean(options.repair),
        ...(options.model ? { initialModel: options.model } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      },
      ));
    } catch (error) {
      // File identity was checked above. This failure precedes onSession/prompt.
      if (error instanceof AutomationSessionChangedError) throw error;
      if (options.sessionFile) throw new AutomationSessionOpenError(error);
      throw error;
    }
    const managed = session;
    if (options.sessionId && session.sessionId !== options.sessionId) throw new Error("Automation session ID does not match");
    if (session.isRunning() || session.inner.pendingMessageCount > 0) throw new Error("Automation session is busy");
    const assertCurrentSession = () => {
      const identity = inspectAutomationSession(managed.sessionFile, { sessionId: managed.sessionId, cwd: options.cwd });
      const expected = [managed.inner.sessionManager.getHeader(), ...managed.inner.sessionManager.getEntries()];
      if (JSON.stringify(identity.entries) !== JSON.stringify(expected)) throw new AutomationSessionChangedError();
      return identity;
    };
    const prepared = assertCurrentSession();
    await options.onPrepared?.({ sessionId: managed.sessionId, sessionFile: managed.sessionFile, digest: prepared.digest });
    let prefix: string | undefined;
    let result: PiAutomationRoundResult;
    try { result = await runPiAutomationRound(managed, {
      ...options,
      beforePrompt: async () => {
        // A read-only viewer may already have opened this managed session.
        // Revalidate the rule's model against the current scope before using it.
        await managed.inner.settingsManager.reload();
        const runtime = managed.inner.modelRuntime as unknown as ModelRuntime;
        const provider = options.model?.provider ?? managed.inner.model?.provider;
        if (provider && !await runtime.checkAuth(provider)) throw new AutomationAuthenticationRequiredError(provider);
        const requestedModel = options.model ?? (managed.inner.model && { provider: managed.inner.model.provider, modelId: managed.inner.model.id });
        if (requestedModel) {
          const scope = await resolveVisibleModels(
            managed.inner.modelRuntime as Parameters<typeof resolveVisibleModels>[0],
            managed.inner.settingsManager.getEnabledModels(),
          );
          const selection = selectInitialModelScope(scope, { requestedModel, thinkingLevel: options.thinkingLevel });
          if (selection.model && (managed.inner.model?.id !== selection.model.id || managed.inner.model.provider !== selection.model.provider)) {
            await managed.inner.setModel(selection.model);
          }
          if (selection.thinkingLevel) managed.inner.setThinkingLevel(selection.thinkingLevel);
        } else if (options.thinkingLevel) {
          managed.inner.setThinkingLevel(options.thinkingLevel);
        }
        const starting = assertCurrentSession();
        await options.onSession?.({ sessionId: managed.sessionId, sessionFile: managed.sessionFile, digest: starting.digest });
        assertCurrentSession();
        prefix = readFileSync(managed.sessionFile, "utf8");
      },
    }); } catch (error) {
      if (error instanceof AutomationSessionChangedError) throw error;
      const identity = assertCurrentSession();
      if (error instanceof AutomationAuthenticationRequiredError) throw new AutomationAuthenticationRequiredError(error.provider, error.status,
        { sessionId: managed.sessionId, sessionFile: managed.sessionFile, digest: identity.digest });
      throw new AutomationRoundFailedError(error, { sessionId: managed.sessionId, sessionFile: managed.sessionFile, digest: identity.digest });
    }
    const completed = assertCurrentSession();
    if (!readFileSync(managed.sessionFile, "utf8").startsWith(prefix ?? "")) {
      throw new AutomationSessionChangedError();
    }
    return { ...result, digest: completed.digest };
  } finally {
    // Waiting for a decision or a due date needs no live AgentSession.
    let shutdownError: unknown;
    try { await session?.shutdown(); } catch (error) { shutdownError = error; }
    const settled = !session || (!session.inner.isStreaming && !session.inner.isCompacting && !session.inner.isBashRunning && session.inner.pendingMessageCount === 0);
    if (settled) release();
    // An AbortSignal proves intent, not that a tool or provider has stopped.
    if (shutdownError || !settled) throw new AutomationExecutionUncertainError(shutdownError);
  }
}
