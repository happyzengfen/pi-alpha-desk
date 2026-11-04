import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { hasBusyRpcSessionForCwd, startRpcSession, type AgentEvent, type AgentSessionWrapper } from "../rpc-manager";
import type { SessionStatsInfo } from "../pi-types";
import { resolveVisibleModels, selectInitialModelScope } from "../model-scope";
import { reserveAutomationCwd } from "./resource-guard";

export interface PiAutomationRoundOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  sessionFile?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  repair?: boolean;
  onSession?: (session: { sessionId: string; sessionFile: string }) => void | Promise<void>;
}

export interface PiAutomationRoundResult {
  sessionId: string;
  sessionFile: string;
  text: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };
  stopReason?: string;
}

function finite(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One durable-session round; extensions and scheduling are owned by the host. */
export async function runPiAutomationRound(
  session: AgentSessionWrapper,
  options: Pick<PiAutomationRoundOptions, "prompt" | "signal" | "repair"> & { beforePrompt?: () => void | Promise<void> },
): Promise<PiAutomationRoundResult> {
  const before = session.inner.getSessionStats();
  let assistant: { content?: unknown; stopReason?: string; errorMessage?: string } | undefined;
  const unsubscribe = session.onEvent((event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const message = event.message as typeof assistant & { role?: string };
    if (message?.role === "assistant") assistant = message;
  });
  try {
    await session.runAutomationPrompt(options.prompt, options);
    if (assistant?.stopReason === "aborted") {
      const error = new Error("Automation round cancelled");
      error.name = "AbortError";
      throw error;
    }
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
  const release = reserveAutomationCwd(options.cwd, () => hasBusyRpcSessionForCwd(options.cwd));
  let session: AgentSessionWrapper | undefined;
  try {
    ({ session } = await startRpcSession(
      options.sessionId ?? `__automation__${randomUUID()}`,
      options.sessionFile ?? "",
      options.cwd,
      {
        executionMode: "automation",
        ...(options.model ? { initialModel: options.model } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      },
    ));
    const managed = session;
    if (options.sessionId && session.sessionId !== options.sessionId) throw new Error("Automation session ID does not match");
    if (session.isRunning() || session.inner.pendingMessageCount > 0) throw new Error("Automation session is busy");
    return await runPiAutomationRound(managed, {
      ...options,
      beforePrompt: async () => {
        // A read-only viewer may already have opened this managed session.
        // Revalidate the rule's model against the current scope before using it.
        if (options.model) {
          const scope = await resolveVisibleModels(
            managed.inner.modelRuntime as Parameters<typeof resolveVisibleModels>[0],
            managed.inner.settingsManager.getEnabledModels(),
          );
          const selection = selectInitialModelScope(scope, { requestedModel: options.model, thinkingLevel: options.thinkingLevel });
          if (selection.model && (managed.inner.model?.id !== selection.model.id || managed.inner.model.provider !== selection.model.provider)) {
            await managed.inner.setModel(selection.model);
          }
          if (selection.thinkingLevel) managed.inner.setThinkingLevel(selection.thinkingLevel);
        } else if (options.thinkingLevel) {
          managed.inner.setThinkingLevel(options.thinkingLevel);
        }
        await options.onSession?.({ sessionId: managed.sessionId, sessionFile: managed.sessionFile });
      },
    });
  } finally {
    // Waiting for a decision or a due date needs no live AgentSession.
    try { await session?.shutdown(); } finally {
      // A failed abort must not grant another session access to a live tool.
      if (!session || (!session.inner.isStreaming && !session.inner.isCompacting && !session.inner.isBashRunning && session.inner.pendingMessageCount === 0)) release();
    }
  }
}
