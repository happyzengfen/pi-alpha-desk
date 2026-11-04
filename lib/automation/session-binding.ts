import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { writeAutomationPrivateFile } from "./checkpoint";

export const AUTOMATION_SESSION_ENTRY = "desktop-automation-session";

/** Bytes verified against the live SDK, before asynchronous shutdown/hand-off. */
export interface AutomationSessionEvidence {
  sessionId: string;
  sessionFile: string;
  digest: string;
}

export class AutomationSessionChangedError extends Error {
  constructor(message = "The automation session was removed or changed. Its original tasks remain paused. Review completed work, then create a new rule to continue in a dedicated session.") { super(message); }
}

/** Classification only; ordinary legacy sessions remain the SDK's responsibility. */
export async function isAutomationManagedSession(file: string): Promise<boolean> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try { const entry = JSON.parse(line); if (entry?.type === "custom" && entry.customType === AUTOMATION_SESSION_ENTRY) return true; }
      catch { /* A damaged ordinary entry is not proof of managed ownership. */ }
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally { lines.close(); stream.destroy(); }
}

export interface AutomationSessionBinding {
  version: 1;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  ruleIds: string[];
  digest: string;
  started: boolean;
  fallbackUsed?: boolean;
  pausedReason?: string;
  reviewedRun?: number;
  reviewedAt?: string;
}

/** Validate before SDK open: an empty or malformed file must never be rewritten. */
export function inspectAutomationSession(file: string, expected?: { sessionId: string; cwd?: string; digest?: string }) {
  let content: string;
  try { content = readFileSync(file, "utf8"); } catch { throw new AutomationSessionChangedError(); }
  let entries: Record<string, unknown>[];
  try { entries = content.trim().split("\n").map((line) => JSON.parse(line)); } catch { throw new AutomationSessionChangedError(); }
  const header = entries[0];
  if (!header || header.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id
    || typeof header.cwd !== "string" || !header.cwd || entries.slice(1).some((entry) => !entry || typeof entry !== "object" || typeof entry.type !== "string" || entry.type === "session")) {
    throw new AutomationSessionChangedError();
  }
  const managed = entries.some((entry) => entry.type === "custom" && entry.customType === AUTOMATION_SESSION_ENTRY);
  const digest = createHash("sha256").update(content).digest("hex");
  let stat;
  try { stat = statSync(file); } catch { throw new AutomationSessionChangedError(); }
  if (expected && (!managed || header.id !== expected.sessionId || (expected.cwd && resolve(header.cwd) !== resolve(expected.cwd)) || (expected.digest && digest !== expected.digest))) {
    throw new AutomationSessionChangedError();
  }
  const modelEntry = entries.findLast((entry) => entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string");
  return { sessionId: header.id, cwd: header.cwd, managed, digest, entries, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size,
    ...(modelEntry && { model: { provider: modelEntry.provider as string, modelId: modelEntry.modelId as string } }) };
}

export function automationBindingPath(root: string, sessionId: string) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId)) throw new AutomationSessionChangedError();
  return join(root, "sessions", `${sessionId}.json`);
}

function bindingMetadata(value: unknown, sessionId: string): AutomationSessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationSessionChangedError("The private automation session binding is damaged. Restore its metadata before continuing.");
  const binding = value as AutomationSessionBinding;
  if (binding.sessionId !== sessionId || typeof binding.sessionFile !== "string" || !binding.sessionFile.trim() || typeof binding.cwd !== "string" || !binding.cwd.trim()) {
    throw new AutomationSessionChangedError("The private automation session binding is damaged. Restore its metadata before continuing.");
  }
  return binding;
}

export async function readAutomationBinding(root: string, sessionId: string): Promise<AutomationSessionBinding> {
  const value = await findAutomationBinding(root, sessionId);
  if (!value) throw new AutomationSessionChangedError();
  if (value.version !== 1 || value.sessionId !== sessionId || typeof value.sessionFile !== "string" || typeof value.cwd !== "string"
    || !Array.isArray(value.ruleIds) || !value.ruleIds.every((id) => typeof id === "string") || typeof value.started !== "boolean"
    || !/^[a-f0-9]{64}$/.test(value.digest) || value.pausedReason) throw new AutomationSessionChangedError(value.pausedReason);
  return value;
}

/** Mutation preflight also needs paused and pre-migration metadata by exact id. */
export async function findAutomationBinding(root: string, sessionId: string): Promise<AutomationSessionBinding | undefined> {
  try { return bindingMetadata(JSON.parse(await readFile(automationBindingPath(root, sessionId), "utf8")), sessionId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function listAutomationBindings(root: string): Promise<AutomationSessionBinding[]> {
  let names: string[];
  try { names = await readdir(join(root, "sessions")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(names.filter((name) => /^[a-zA-Z0-9-]{1,100}\.json$/.test(name)).map(async (name) => bindingMetadata(JSON.parse(await readFile(join(root, "sessions", name), "utf8")), name.slice(0, -5))));
}

export async function saveAutomationBinding(root: string, binding: AutomationSessionBinding) {
  await writeAutomationPrivateFile(automationBindingPath(root, binding.sessionId), binding);
}
