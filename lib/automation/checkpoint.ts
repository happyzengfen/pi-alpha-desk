import { mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import type { AutomationJob, AutomationResult } from "./types";

export interface AutomationCheckpoint {
  version: 1;
  claim: string;
  job: AutomationJob;
  stage: "claimed" | "running" | "result";
  sessionId?: string;
  sessionFile?: string;
  fallbackUsed?: boolean;
  result?: AutomationResult;
}

export async function writeAutomationPrivateFile(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx", flush: true });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export class AutomationCheckpoints {
  constructor(readonly directory: string) {}

  async initialize() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  private file(run: number) {
    if (!Number.isSafeInteger(run) || run < 1) throw new Error("Invalid run id");
    return join(this.directory, `${run}.json`);
  }

  async save(checkpoint: AutomationCheckpoint) {
    await this.initialize();
    await writeAutomationPrivateFile(this.file(checkpoint.job.run), checkpoint);
  }

  async list(): Promise<AutomationCheckpoint[]> {
    await this.initialize();
    const checkpoints = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[1-9]\d*\.json$/.test(name)) continue;
      const value = JSON.parse(await readFile(join(this.directory, name), "utf8")) as AutomationCheckpoint;
      if (value.version !== 1 || !value.claim || !value.job?.token || `${value.job.run}.json` !== name || !["claimed", "running", "result"].includes(value.stage)) {
        throw new Error("Invalid automation execution checkpoint; review before resuming");
      }
      checkpoints.push(value);
    }
    return checkpoints.sort((a, b) => a.job.run - b.job.run);
  }

  async remove(run: number) { await rm(this.file(run), { force: true }); }
}
