import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicPrivateFile } from "./runtime.ts";
import { listenHub } from "./server.ts";

export type HubDescriptor = {
  version: 1;
  instanceId: string;
  url: string;
  ownerKey: string;
  workerKey: string;
  sourceKey: string;
  pid: number;
  workerName: string;
  sourceName: string;
};

function owns(file: string, instanceId: string) {
  try { return JSON.parse(readFileSync(file, "utf8")).instanceId === instanceId; }
  catch { return false; }
}

function claimDataDirectory(dataDir: string, instanceId: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (lstatSync(dataDir).isSymbolicLink()) throw new Error("Automation data directory must not be a symlink");
  const lock = join(dataDir, "host.lock");
  if (existsSync(lock)) {
    if (lstatSync(lock).isSymbolicLink()) throw new Error("Automation lock must not be a symlink");
    const prior = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error("Automation lock is invalid; inspect the data directory");
    let alive = true;
    try { process.kill(prior.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) throw new Error("An automation hub already owns this data directory");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ instanceId, pid: process.pid })); }
  finally { closeSync(fd); }
  return () => { if (owns(lock, instanceId)) unlinkSync(lock); };
}

export async function startHub({ dataDir, descriptorFile = join(dataDir, "descriptor.json"), instanceId = randomUUID(), now }: {
  dataDir: string;
  descriptorFile?: string;
  instanceId?: string;
  now?: () => number;
}) {
  if (!isAbsolute(dataDir) || !isAbsolute(descriptorFile)) throw new Error("Automation paths must be absolute");
  for (const file of ["master.key", "hub.db", "hub.db-wal", "hub.db-shm", "rules.json"]) {
    const target = join(dataDir, file);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Automation ${file} must not be a symlink`);
  }
  const release = claimDataDirectory(dataDir, instanceId);
  let hub: Awaited<ReturnType<typeof listenHub>> | undefined;
  try {
    hub = await listenHub({ dataDir, instanceId, now });
    mkdirSync(dirname(descriptorFile), { recursive: true, mode: 0o700 });
    const descriptor: HubDescriptor = {
      version: 1, instanceId, url: hub.url, ...hub.runtime.keys, pid: process.pid,
      workerName: hub.runtime.workerName, sourceName: hub.runtime.sourceName,
    };
    atomicPrivateFile(descriptorFile, `${JSON.stringify(descriptor)}\n`);
    let closing: Promise<void> | undefined;
    return {
      descriptor, runtime: hub.runtime,
      close() {
        return closing ??= (async () => {
          try { await hub!.close(); }
          finally { if (owns(descriptorFile, instanceId)) unlinkSync(descriptorFile); release(); }
        })();
      },
    };
  } catch (error) {
    await hub?.close();
    release();
    throw error;
  }
}

async function main() {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!["--data-dir", "--descriptor", "--instance-id"].includes(name) || !value) throw new Error("Expected --data-dir ABS [--descriptor ABS] [--instance-id ID]");
    args.set(name, value);
  }
  const dataDir = args.get("--data-dir") ?? process.env.PI_AUTOMATION_HOME;
  if (!dataDir) throw new Error("Automation data directory is required");
  const hub = await startHub({
    dataDir,
    descriptorFile: args.get("--descriptor") ?? process.env.PI_AUTOMATION_DESCRIPTOR,
    instanceId: args.get("--instance-id"),
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await hub.close();
    if (process.connected) process.disconnect();
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
  if (process.connected) process.once("disconnect", () => { void stop(); });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Automation hub startup failed");
    process.exitCode = 1;
  });
}
