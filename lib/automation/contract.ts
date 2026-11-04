import { existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type { AutomationJob, AutomationResult, AutomationUsage } from "./types";

export interface AutomationContract {
  promptFor(job: AutomationJob, contextFile: string): string;
  repairPrompt(problem: string): string;
  readMessage(text: string): { outcome: string; summary?: string; error?: string; problem?: string; receipt?: Record<string, unknown> };
  resultFrom(message: ReturnType<AutomationContract["readMessage"]>, extra: { session?: string; usage?: AutomationUsage }): { result: AutomationResult; problem?: string };
}

let loaded: Promise<AutomationContract> | undefined;

/** Keep the exact upstream wire contract without bundling SQLite into Next. */
export function loadAutomationContract(): Promise<AutomationContract> {
  return loaded ??= (async () => {
    const candidate = join(process.cwd(), "dist", "automation-hub", "upstream", "worker", "contract.mjs");
    if (!existsSync(candidate)) throw new Error("Automation runtime assets are missing; run npm run automation:build");
    return await import(/* webpackIgnore: true */ pathToFileURL(candidate).href) as AutomationContract;
  })().catch((error) => { loaded = undefined; throw error; });
}
