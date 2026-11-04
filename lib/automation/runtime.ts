import { timingSafeEqual } from "crypto";
import { AutomationInputError, compileAutomationRules, emptyAutomationConfig, parseAutomationConfig } from "./config";
import { automationHubClient, readAutomationConnection, type AutomationHubClient } from "./hub-client";
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
    await runtime().worker?.reconcile(id);
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
