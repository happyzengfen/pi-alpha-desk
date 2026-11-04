import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { automationHubClient, readAutomationConnection } from "./hub-client";

type Reservation = { automation?: symbol; chats: Set<symbol> };
declare global { var __piAutomationResources: Map<string, Reservation> | undefined; }

export class AutomationResourceBusyError extends Error {}

export function canonicalResourceCwd(cwd: string): string {
  const windows = process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  let canonical = (windows ? path.win32 : path).resolve(cwd);
  try { canonical = realpathSync(canonical); } catch { /* Keep a stable key while a directory is unavailable. */ }
  return windows ? canonical.replaceAll("/", "\\").toLowerCase() : canonical;
}

function reservations() { return globalThis.__piAutomationResources ??= new Map(); }
function reservation(cwd: string) {
  const key = canonicalResourceCwd(cwd);
  let entry = reservations().get(key);
  if (!entry) { entry = { chats: new Set() }; reservations().set(key, entry); }
  return { key, entry };
}
function prune(key: string, entry: Reservation) {
  if (!entry.automation && !entry.chats.size && reservations().get(key) === entry) reservations().delete(key);
}

/** This check and reservation never yield to another request. */
export function reserveAutomationCwd(cwd: string, isBusy: () => boolean): () => void {
  const { key, entry } = reservation(cwd);
  if (entry.automation || entry.chats.size || isBusy()) {
    prune(key, entry);
    throw new AutomationResourceBusyError("The working directory is in use by another session");
  }
  const token = Symbol();
  entry.automation = token;
  return () => {
    if (entry.automation === token) delete entry.automation;
    prune(key, entry);
  };
}

function sameOwner(cwd: string, owner: unknown) {
  if (owner === null) return false;
  if (!owner || typeof owner !== "object" || typeof (owner as { cwd?: unknown }).cwd !== "string" || !(owner as { cwd: string }).cwd) {
    throw new AutomationResourceBusyError("Automation ownership is unavailable; review the workspace before continuing");
  }
  return canonicalResourceCwd((owner as { cwd: string }).cwd) === canonicalResourceCwd(cwd);
}

async function uncertainScope(directory: string, cwd: string): Promise<boolean> {
  const scopes = new Set<string>();
  let known = false;
  try {
    const rules = JSON.parse(await readFile(path.join(directory, "rules.json"), "utf8"));
    if (!Array.isArray(rules.rules)) throw new Error("Invalid saved rules");
    for (const rule of rules.rules) {
      if (typeof rule.cwd !== "string") throw new Error("Invalid saved directory");
      scopes.add(canonicalResourceCwd(rule.cwd));
    }
    known = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  try {
    for (const name of await readdir(path.join(directory, "worker"))) {
      if (!/^[1-9]\d*\.json$/.test(name)) continue;
      const checkpoint = JSON.parse(await readFile(path.join(directory, "worker", name), "utf8"));
      if (typeof checkpoint.job?.rule?.cwd !== "string") return true;
      scopes.add(canonicalResourceCwd(checkpoint.job.rule.cwd));
      known = true;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  return !known || scopes.size === 0 || scopes.has(canonicalResourceCwd(cwd));
}

/** Consult the durable owner even after wrapper/server memory has been lost. */
export async function assertNoAutomationOwner(cwd: string): Promise<void> {
  const state = globalThis.__piAutomationRuntime;
  const descriptor = state?.descriptorPath ?? process.env.PI_AUTOMATION_DESCRIPTOR;
  if (!descriptor && !state?.hub) return;
  let owner: unknown;
  try {
    const hub = descriptor ? automationHubClient(await readAutomationConnection(descriptor)) : state!.hub!;
    ({ owner } = await hub.call<{ owner: unknown }>("/v1/desktop/status"));
  } catch {
    const directory = descriptor ? path.dirname(descriptor) : undefined;
    const database = directory && path.join(directory, "hub.db");
    if (database && existsSync(database)) {
      try {
        // Read-only fallback: an unknown owner survives a lost sidecar/descriptor.
        // Do not initialize or migrate the hub from the web server.
        const { DatabaseSync } = await import(/* webpackIgnore: true */ "node:sqlite");
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          const row = db.prepare("SELECT data FROM projections WHERE collection='config' AND key='desktop-owner'").get();
          owner = row ? JSON.parse(String(row.data)) : null;
        } finally { db.close(); }
      } catch {
        if (!directory || await uncertainScope(directory, cwd)) throw new AutomationResourceBusyError("Automation ownership is unavailable; review the workspace before continuing");
        return;
      }
    } else {
      // A fresh, disabled installation has no durable work to protect.
      if (directory && !existsSync(path.join(directory, "rules.json")) && !existsSync(path.join(directory, "worker")) && !existsSync(descriptor!)) return;
      if (!directory || await uncertainScope(directory, cwd)) throw new AutomationResourceBusyError("Automation ownership is unavailable; review the workspace before continuing");
      return;
    }
  }
  if (sameOwner(cwd, owner)) throw new AutomationResourceBusyError("Automation owns this working directory; finish or reconcile its run before editing");
}

/** A provisional chat ticket closes the gap while durable ownership is checked. */
export function beginChatCwdUse(cwd: string): { check: () => Promise<void>; release: () => void } {
  const { key, entry } = reservation(cwd);
  if (entry.automation) throw new AutomationResourceBusyError("Automation is using this working directory");
  const token = Symbol();
  entry.chats.add(token);
  return {
    check: () => assertNoAutomationOwner(cwd),
    release() { entry.chats.delete(token); prune(key, entry); },
  };
}
