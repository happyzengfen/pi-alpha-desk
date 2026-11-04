import { timingSafeEqual } from "crypto";
import { realpathSync } from "fs";
import { dirname } from "path";
import { AutomationInputError, compileAutomationRules, emptyAutomationConfig, parseAutomationConfig } from "./config";
import { AutomationHubError, automationHubClient, readAutomationConnection, type AutomationHubClient } from "./hub-client";
import { AutomationWorker } from "./worker";
import type { AutomationConfig, AutomationSnapshot, AutomationState } from "./types";

interface AutomationRuntime {
  descriptorPath?: string;
  controlKey?: string;
  hub?: AutomationHubClient;
  worker?: AutomationWorker;
  timer?: ReturnType<typeof setInterval>;
  connecting?: Promise<void>;
  suspended: boolean;
  reason?: string;
  writes: Promise<unknown>;
}

declare global { var __piAutomationRuntime: AutomationRuntime | undefined; }

function runtime(): AutomationRuntime {
  return globalThis.__piAutomationRuntime ??= { suspended: false, writes: Promise.resolve() };
}

export async function validateAutomationCwd(cwd: string) {
  // Disabled automation must not eagerly load the SDK or scan session history at server startup.
  const [{ getAllowedFileRoots }, { resolveAllowedNewSessionCwd }, { getProjectTrustStatus }, { getAgentDir }] = await Promise.all([
    import("../file-access"), import("../new-session-cwd"), import("../project-trust"), import("@earendil-works/pi-coding-agent"),
  ]);
  const resolved = resolveAllowedNewSessionCwd(cwd, await getAllowedFileRoots());
  if (!resolved) throw new AutomationInputError("Automation directory is outside the selected workspaces");
  if (!getProjectTrustStatus(resolved, getAgentDir()).trusted) throw new AutomationInputError("Trust the project before enabling automation");
  return resolved;
}

export function initializeAutomationRuntime() {
  const state = runtime();
  state.descriptorPath ??= process.env.PI_AUTOMATION_DESCRIPTOR;
  state.controlKey ??= process.env.PI_AUTOMATION_CONTROL_KEY;
  // Pi tools inherit the server environment. Capabilities must not follow them.
  delete process.env.PI_AUTOMATION_DESCRIPTOR;
  delete process.env.PI_AUTOMATION_CONTROL_KEY;
  if (state.descriptorPath && !state.timer) {
    state.timer = setInterval(() => { void refreshAutomationConnection().then(() => state.worker?.tick()).catch(() => {}); }, 1000);
    state.timer.unref();
    void refreshAutomationConnection();
  }
}

export async function refreshAutomationConnection() {
  const state = runtime();
  if (!state.descriptorPath || state.connecting) return state.connecting;
  state.connecting = (async () => {
    try {
      const connection = await readAutomationConnection(state.descriptorPath!);
      if (state.hub?.connection.instanceId === connection.instanceId) return;
      if (state.worker && !await state.worker.stop()) throw new Error("Previous automation execution is still stopping");
      const hub = automationHubClient(connection);
      await hub.verify();
      state.hub = hub;
      state.worker = new AutomationWorker(hub, state.descriptorPath!, { validateCwd: validateAutomationCwd });
      if (state.suspended) await state.worker.suspend();
      state.reason = undefined;
    } catch (error) {
      state.reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "automation-disabled" : "automation-unavailable";
      if (state.worker && !await state.worker.stop()) return;
      state.hub = undefined;
      state.worker = undefined;
    }
  })().finally(() => { state.connecting = undefined; });
  return state.connecting;
}

export function isAutomationControlAuthorized(request: Request) {
  const expected = runtime().controlKey;
  const given = request.headers.get("x-pi-automation-control");
  if (!expected || !given) return false;
  const expectedBytes = Buffer.from(expected);
  const givenBytes = Buffer.from(given);
  return expectedBytes.length === givenBytes.length && timingSafeEqual(expectedBytes, givenBytes);
}

async function connectedHub() {
  initializeAutomationRuntime();
  await refreshAutomationConnection();
  const hub = runtime().hub;
  if (!hub) throw new AutomationInputError("Automation is not connected. Enable it in the desktop app.");
  return hub;
}

export async function automationSnapshot(before?: number): Promise<AutomationSnapshot> {
  initializeAutomationRuntime();
  await refreshAutomationConnection();
  const local = runtime();
  if (!local.hub) return { available: false, reason: local.reason ?? "desktop-host-required", config: emptyAutomationConfig(), state: null,
    worker: local.worker?.status() ?? { suspended: local.suspended, activeRun: null } };
  try {
    const [metadata, state] = await Promise.all([
      local.hub.call<{ config: unknown; owner?: { run?: number } | null }>("/v1/desktop/status"),
      local.hub.call<AutomationState>(`/v1/state${before ? `?before=${before}` : ""}`),
    ]);
    return { available: true, instanceId: local.hub.connection.instanceId,
      config: metadata.config ? parseAutomationConfig(metadata.config) : emptyAutomationConfig(), state,
      worker: local.worker?.status() ?? { suspended: local.suspended, activeRun: null },
      owner: metadata.owner ? { run: metadata.owner.run } : null };
  } catch {
    return { available: false, reason: "automation-unavailable", config: emptyAutomationConfig(), state: null,
      worker: local.worker?.status() ?? { suspended: local.suspended, activeRun: null } };
  }
}

function serializeWrite<T>(work: () => Promise<T>): Promise<T> {
  const state = runtime();
  const next = state.writes.then(work, work);
  state.writes = next.catch(() => {});
  return next;
}

export class AutomationSessionChangeError extends Error {}

/** Pause durable continuations and drain their execution before touching JSONL. */
export async function withAutomationSessionPaused<T>(sessionId: string, sessionFile: string, change: () => T | Promise<T>): Promise<T> {
  const { isAutomationManagedSession, inspectAutomationSession, findAutomationBinding, saveAutomationBinding } = await import("./session-binding");
  const descriptorPath = runtime().descriptorPath ?? process.env.PI_AUTOMATION_DESCRIPTOR;
  const root = descriptorPath ? dirname(descriptorPath) : undefined;
  let binding;
  try { binding = root ? await findAutomationBinding(root, sessionId) : undefined; }
  catch { throw new AutomationSessionChangeError("The automation session binding cannot be read. Restore its private binding before changing this session."); }
  let managed: boolean;
  try { managed = Boolean(binding) || await isAutomationManagedSession(sessionFile); }
  catch { throw new AutomationSessionChangeError("The session cannot be read safely. Review its file before renaming or deleting it."); }
  if (!managed && !binding) return change();
  let inspected: ReturnType<typeof inspectAutomationSession>;
  try { inspected = inspectAutomationSession(sessionFile); }
  catch { throw new AutomationSessionChangeError("The managed session cannot be read safely. Review its file before renaming or deleting it."); }
  const blocked = "This managed session cannot be changed until its automation tasks are paused and execution has stopped. Enable Automation in the desktop app, then retry; reconcile any execution marked for review.";
  if (inspected.sessionId !== sessionId || !root) throw new AutomationSessionChangeError(blocked);
  if (binding) {
    const canonical = (file: string) => {
      const path = realpathSync.native(file);
      return process.platform === "win32" ? path.toLowerCase() : path;
    };
    try {
      if (binding.sessionId !== sessionId || canonical(binding.sessionFile) !== canonical(sessionFile)) throw new Error("Session binding mismatch");
    } catch { throw new AutomationSessionChangeError("The automation session binding changed. Restore the original session binding before renaming or deleting it."); }
  }
  return serializeWrite(async () => {
    try {
      const hub = await connectedHub();
      const metadata = await hub.call<{ config: unknown; owner: { run: number; session?: string | null } | null }>("/v1/desktop/status");
      const config = parseAutomationConfig(metadata.config);
      const state = await hub.call<AutomationState>("/v1/state");
      const hasRuleBindings = Array.isArray(binding?.ruleIds) && binding.ruleIds.length > 0 && binding.ruleIds.every((id) => typeof id === "string" && id.length > 0);
      const ruleIds = new Set<string>(hasRuleBindings ? binding!.ruleIds : []);
      for (const run of state.runs) if (run.session === sessionId) ruleIds.add(run.rule);
      // Legacy bindings do not prove the complete rule set. Only an already
      // fully paused configuration permits their file to be changed safely.
      if (!hasRuleBindings && config.rules.some((rule) => rule.enabled)) throw new AutomationSessionChangeError("This legacy managed session has no complete task binding. Pause all automation rules in the desktop app, reconcile any running execution, then retry.");
      const pausedReason = "The linked session was renamed or deleted. Its original tasks remain paused. Review completed work, then create a new rule to continue in a dedicated session.";
      const pauseBinding = async () => {
        const latest = await findAutomationBinding(root, sessionId);
        if (!latest) return;
        if (latest.ruleIds !== undefined && (!Array.isArray(latest.ruleIds) || latest.ruleIds.some((id) => typeof id !== "string" || !id))) throw new AutomationSessionChangeError(blocked);
        for (const id of latest.ruleIds ?? []) ruleIds.add(id);
        await saveAutomationBinding(root, { ...latest, ruleIds: [...ruleIds], pausedReason });
      };
      await pauseBinding();
      const disabled = new Set<string>();
      const disable = async () => {
        for (const id of ruleIds) {
          if (!disabled.has(id) && config.rules.some((rule) => rule.id === id)) {
            await hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId: id } });
            disabled.add(id);
          }
        }
      };
      await disable();
      const worker = runtime().worker;
      if (worker && !await worker.stopSession(sessionId, 8000, [...ruleIds])) throw new AutomationSessionChangeError(blocked);
      // A round already completing may have saved its binding while we paused.
      const pausedCount = ruleIds.size;
      await pauseBinding();
      await disable();
      if (ruleIds.size > pausedCount && worker && !await worker.stopSession(sessionId, 8000, [...ruleIds])) throw new AutomationSessionChangeError(blocked);
      const final = await hub.call<{ owner: { run: number; session?: string | null } | null }>("/v1/desktop/status");
      if (final.owner) {
        const finalState = await hub.call<AutomationState>("/v1/state");
        const owner = finalState.runs.find((run) => run.id === final.owner!.run);
        if (final.owner.session === sessionId || owner?.session === sessionId || (owner && ruleIds.has(owner.rule))) throw new AutomationSessionChangeError(blocked);
      }
      // A prior queued mutation or an external deletion during drain must not
      // let SessionManager.open recreate a file that is no longer this session.
      inspectAutomationSession(sessionFile, { sessionId, cwd: inspected.cwd });
    } catch (error) {
      if (error instanceof AutomationSessionChangeError) throw error;
      throw new AutomationSessionChangeError(blocked);
    }
    return change();
  });
}

export async function saveAutomationConfig(given: unknown) {
  return serializeWrite(async () => {
    const config = parseAutomationConfig(given);
    for (const rule of config.rules) if (rule.enabled) rule.cwd = await validateAutomationCwd(rule.cwd);
    const hub = await connectedHub();
    await hub.call("/v1/desktop/config", { method: "PUT", body: { config, rules: compileAutomationRules(config) } });
    await runtime().worker?.tick();
    return automationSnapshot();
  });
}

function positiveId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AutomationInputError("Invalid id");
  return Number(value);
}

export async function automationCommand(body: Record<string, unknown>, internal = false): Promise<unknown> {
  if (body.action === "suspend_worker" || body.action === "resume_worker") {
    if (!internal) throw new AutomationInputError("Internal automation control required");
    const state = runtime();
    state.suspended = body.action === "suspend_worker";
    if (state.suspended) return { stopped: await state.worker?.suspend() ?? true };
    await refreshAutomationConnection();
    await state.worker?.resume();
    return { resumed: true };
  }
  if (body.action === "save_config") return saveAutomationConfig(body.config);
  const hub = await connectedHub();
  if (body.action === "trigger") {
    if (typeof body.ruleId !== "string") throw new AutomationInputError("Invalid rule id");
    await hub.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: body.ruleId } });
  } else if (body.action === "cancel_rule") {
    if (typeof body.ruleId !== "string") throw new AutomationInputError("Invalid rule id");
    return serializeWrite(async () => {
      await hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId: body.ruleId } });
      await runtime().worker?.tick();
      return automationSnapshot();
    });
  } else if (body.action === "answer") {
    const id = positiveId(body.cardId);
    const answer = { ...(body.choice !== undefined && { choice: body.choice }), ...(body.text !== undefined && { text: body.text }),
      ...(body.expectedVersion !== undefined && { expectedVersion: positiveId(body.expectedVersion) }) };
    await hub.call(`/v1/cards/${id}/answer`, { method: "POST", body: answer });
  } else if (body.action === "resolve") {
    const id = positiveId(body.cardId);
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 4000) throw new AutomationInputError("A resolution reason is required");
    await hub.call(`/v1/cards/${id}/resolve`, { method: "POST", body: { reason: body.reason,
      ...(body.expectedVersion !== undefined && { expectedVersion: positiveId(body.expectedVersion) }) } });
  } else if (body.action === "reconcile") {
    const id = positiveId(body.runId);
    if (body.confirmedStopped !== true) throw new AutomationInputError("Confirm that the previous execution has stopped");
    await runtime().worker?.reconcile(id, { confirmedSessionReviewed: body.confirmedSessionReviewed === true });
  } else throw new AutomationInputError("Unknown automation action");
  await runtime().worker?.tick();
  return automationSnapshot();
}

export async function automationWhy(run: number) {
  return (await connectedHub()).call(`/v1/runs/${positiveId(run)}/why`);
}

export async function automationEventStream(request: Request): Promise<Response> {
  const hub = await connectedHub();
  const cursor = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,16}$/.test(cursor)) throw new AutomationInputError("Invalid event cursor");
  const upstream = await fetch(`${hub.connection.url}/v1/stream?after=${cursor}`, {
    headers: { authorization: `Bearer ${hub.connection.ownerKey}` }, signal: request.signal, redirect: "error",
  });
  if (!upstream.ok || !upstream.body) throw new Error("Automation event stream is unavailable");
  return new Response(upstream.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

export type { AutomationConfig };
// Consumers classify the same constructors used by this service, including
// when a host loader gives alias and relative module paths different identities.
export { AutomationInputError, AutomationHubError };
