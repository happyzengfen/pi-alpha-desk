import { lstat, readFile, realpath } from "fs/promises";
import { isAbsolute } from "path";
import type { AutomationConnection } from "./types";

export class AutomationHubError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function readAutomationConnection(file: string): Promise<AutomationConnection> {
  if (!isAbsolute(file)) throw new Error("Automation bridge path must be absolute");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("Invalid automation bridge");
  if (process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("Automation bridge permissions are not private");
  if (process.getuid && stat.uid !== process.getuid()) throw new Error("Automation bridge owner does not match");
  const data = JSON.parse(await readFile(await realpath(file), "utf8")) as AutomationConnection;
  if (data.version !== 1 || typeof data.instanceId !== "string" || !data.instanceId || !Number.isSafeInteger(data.pid)) throw new Error("Unsupported automation bridge");
  const url = new URL(data.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Automation hub must be loopback only");
  for (const field of ["ownerKey", "workerKey", "sourceKey"] as const) {
    if (typeof data[field] !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(data[field])) throw new Error("Invalid automation capability");
  }
  if (data.workerName !== "pi-desktop" || data.sourceName !== "desktop") throw new Error("Unexpected automation identity");
  return data;
}

export function automationHubClient(connection: AutomationConnection) {
  async function call<T>(path: string, options: { method?: string; body?: unknown; role?: "owner" | "worker" | "source"; token?: string; signal?: AbortSignal } = {}): Promise<T> {
    if (!path.startsWith("/v1/") && path !== "/healthz") throw new Error("Invalid hub API path");
    const key = options.token ?? connection[`${options.role ?? "owner"}Key`];
    const response = await fetch(new URL(path, connection.url), {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${key}`, ...(options.body !== undefined && { "content-type": "application/json" }) },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new AutomationHubError(response.status, body.error ?? `Automation hub returned ${response.status}`);
    return body;
  }
  return {
    connection,
    call,
    async verify() {
      const health = await call<{ ok: boolean; instanceId: string }>("/healthz");
      if (!health.ok || health.instanceId !== connection.instanceId) throw new Error("Automation hub instance mismatch");
    },
  };
}

export type AutomationHubClient = ReturnType<typeof automationHubClient>;
