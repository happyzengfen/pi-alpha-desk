import { randomUUID } from "crypto";
import { mkdir, readFile, rm } from "fs/promises";
import { dirname, join } from "path";
import type { PiAutomationRoundOptions, PiAutomationRoundResult } from "./pi-executor";
import { AutomationCheckpoints, writeAutomationPrivateFile, type AutomationCheckpoint } from "./checkpoint";
import { loadAutomationContract, type AutomationContract } from "./contract";
import { parseAutomationConfig, parseAutomationRule } from "./config";
import { AutomationHubError, type AutomationHubClient } from "./hub-client";
import type { AutomationConfig, AutomationJob, AutomationRule, AutomationUsage } from "./types";

type Execute = (options: PiAutomationRoundOptions) => Promise<PiAutomationRoundResult>;
type WorkerDependencies = {
  execute?: Execute;
  contract?: AutomationContract;
  validateCwd: (cwd: string) => Promise<string>;
};

function addUsage(total: AutomationUsage, round: PiAutomationRoundResult["usage"]): AutomationUsage {
  return { input: (total.input ?? 0) + round.input, output: (total.output ?? 0) + round.output,
    cached: (total.cached ?? 0) + round.cacheRead, cost: (total.cost ?? 0) + round.cost };
}

export class AutomationWorker {
  private active: { run: number; controller: AbortController; done: Promise<void> } | null = null;
  private polling = false;
  private suspended = false;
  private stopped = false;
  private error: string | undefined;
  private recoveryRun: number | null = null;
  private claim = randomUUID();
  private checkpoints: AutomationCheckpoints;
  private root: string;

  constructor(readonly hub: AutomationHubClient, descriptorPath: string, private readonly dependencies: WorkerDependencies) {
    this.root = dirname(descriptorPath);
    this.checkpoints = new AutomationCheckpoints(join(this.root, "worker"));
  }

  status() { return { suspended: this.suspended, activeRun: this.active?.run ?? null, recoveryRun: this.recoveryRun, ...(this.error && { error: this.error }) }; }

  async resume() { this.suspended = false; this.stopped = false; this.error = undefined; await this.tick(); }

  async suspend(timeoutMs = 8000): Promise<boolean> {
    this.suspended = true;
    this.active?.controller.abort(new Error("Automation worker suspended"));
    const deadline = Date.now() + timeoutMs;
    while (this.polling && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    this.active?.controller.abort(new Error("Automation worker suspended"));
    const work = this.active?.done;
    if (!work) return !this.polling;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work.then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
    } finally { clearTimeout(timer); }
  }

  async stop() { const stopped = await this.suspend(); if (stopped) this.stopped = true; return stopped; }

  private async config(): Promise<AutomationConfig | null> {
    const { config } = await this.hub.call<{ config: unknown }>("/v1/desktop/config");
    return config ? parseAutomationConfig(config) : null;
  }

  async tick() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (this.active) {
        const query = new URLSearchParams({ claim: this.claim, wait: "0", running: String(this.active.run), capacity: "0" });
        const response = await this.hub.call<{ cancel: number[] }>(`/v1/work?${query}`, { role: "worker" });
        if (response.cancel.includes(this.active.run)) this.active.controller.abort(new Error("Automation cancelled"));
        return;
      }
      if (this.suspended) return;
      // Never claim new work until every durable result has been acknowledged.
      let recovered: AutomationCheckpoint | undefined;
      for (const checkpoint of await this.checkpoints.list()) {
        const proof = await this.hub.call<{ reconciled: boolean }>(`/v1/desktop/status?run=${checkpoint.job.run}`);
        if (proof.reconciled) {
          await rm(join(this.checkpoints.directory, `${checkpoint.job.run}.context.json`), { force: true });
          await this.checkpoints.remove(checkpoint.job.run);
          this.recoveryRun = null;
          continue;
        }
        if (checkpoint.stage === "result" && checkpoint.result) {
          await this.deliver(checkpoint);
        } else if (checkpoint.stage === "claimed") {
          recovered = checkpoint;
        } else {
          // A running checkpoint cannot prove whether the model/tools finished.
          this.error = "execution-needs-review";
          this.recoveryRun = checkpoint.job.run;
          const query = new URLSearchParams({ claim: this.claim, wait: "0", running: "", capacity: "0" });
          await this.hub.call(`/v1/work?${query}`, { role: "worker" });
          return;
        }
      }
      const config = await this.config();
      if (!config) return;
      if (this.suspended) return;
      const claim = recovered?.claim ?? this.claim;
      const query = new URLSearchParams({ claim, wait: "0", running: recovered ? String(recovered.job.run) : "", capacity: "1" });
      const { job } = await this.hub.call<{ job: AutomationJob | null }>(`/v1/work?${query}`, { role: "worker" });
      if (!job) { this.error = undefined; return; }
      const checkpoint: AutomationCheckpoint = { version: 1, claim, job, stage: "claimed" };
      await this.checkpoints.save(checkpoint);
      this.claim = randomUUID();
      const controller = new AbortController();
      const done = this.perform(checkpoint, config, controller);
      this.active = { run: job.run, controller, done };
      void done.catch((error) => { this.error = error instanceof Error ? error.message : "automation-execution-failed"; })
        .finally(() => { if (this.active?.run === job.run) this.active = null; });
    } catch (error) {
      this.error = error instanceof AutomationHubError ? `hub-${error.status}` : "automation-unavailable";
    } finally { this.polling = false; }
  }

  private async deliver(checkpoint: AutomationCheckpoint) {
    await this.hub.call(`/v1/runs/${checkpoint.job.run}/result`, { method: "POST", token: checkpoint.job.token, body: checkpoint.result });
    await rm(join(this.checkpoints.directory, `${checkpoint.job.run}.context.json`), { force: true });
    await this.checkpoints.remove(checkpoint.job.run);
    this.error = undefined;
  }

  private async sessionFor(job: AutomationJob) {
    if (!job.session) return {};
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(job.session)) throw new Error("Invalid automation session reference");
    try {
      const saved = JSON.parse(await readFile(join(this.root, "sessions", `${job.session}.json`), "utf8")) as { sessionId: string; sessionFile: string; cwd: string };
      if (saved.sessionId !== job.session || saved.cwd !== job.rule.cwd) throw new Error("Automation session binding mismatch");
      return { sessionId: saved.sessionId, sessionFile: saved.sessionFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { resolveSessionPath } = await import("../session-reader");
      const sessionFile = await resolveSessionPath(job.session);
      if (!sessionFile) return {}; // No work started in this attempt; one fresh fallback is safe.
      return { sessionId: job.session, sessionFile };
    }
  }

  private async perform(checkpoint: AutomationCheckpoint, config: AutomationConfig, controller: AbortController) {
    const { job } = checkpoint;
    let rule: AutomationRule | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let usage: AutomationUsage = {};
    const contextFile = join(this.checkpoints.directory, `${job.run}.context.json`);
    const execute: Execute = this.dependencies.execute ?? (async (options) => (await import("./pi-executor")).executePiAutomationRound(options));
    try {
      rule = job.desktopRule ? parseAutomationRule(job.desktopRule) : config.rules.find((entry) => entry.id === job.rule.name && entry.enabled);
      if (!rule) throw new Error("Automation rule is disabled or missing");
      if (!rule.enabled || rule.id !== job.rule.name || rule.prompt !== job.rule.prompt || rule.cwd !== job.rule.cwd) throw new Error("Automation claim configuration mismatch");
      if (this.suspended || controller.signal.aborted) throw new DOMException("Automation cancelled", "AbortError");
      const cwd = await this.dependencies.validateCwd(job.rule.cwd);
      if (cwd !== rule.cwd || cwd !== job.rule.cwd) throw new Error("Automation directory has changed");
      const status = await this.hub.call<{ dailyCounts?: Record<string, number> }>("/v1/desktop/status");
      if ((status.dailyCounts?.[rule.id] ?? 0) > rule.maxDailyRuns) {
        await this.hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId: rule.id } });
        await this.hub.call("/v1/tell", { method: "POST", role: "source", body: {
          key: `budget-${job.run}`, text: `Automation “${rule.name}” reached its daily execution limit and was disabled. Review the task before enabling it again.`,
        } });
        throw new DOMException("Daily automation run limit reached", "AbortError");
      }
      timer = setTimeout(() => controller.abort(new Error("Automation execution timed out")), rule.timeoutMinutes * 60_000);
      await writeAutomationPrivateFile(contextFile, job.context);
      const contract = this.dependencies.contract ?? await loadAutomationContract();
      const resume = await this.sessionFor(job);
      let round = await execute({
        cwd, prompt: contract.promptFor(job, contextFile), ...resume,
        ...(rule.provider && rule.modelId && { model: { provider: rule.provider, modelId: rule.modelId } }),
        ...(rule.thinkingLevel && { thinkingLevel: rule.thinkingLevel }), signal: controller.signal,
        onSession: async (session) => {
          checkpoint.sessionId = session.sessionId;
          checkpoint.sessionFile = session.sessionFile;
          checkpoint.stage = "running";
          await this.checkpoints.save(checkpoint);
          await mkdir(join(this.root, "sessions"), { recursive: true, mode: 0o700 });
          await writeAutomationPrivateFile(join(this.root, "sessions", `${session.sessionId}.json`), { ...session, cwd });
          await this.hub.call(`/v1/runs/${job.run}/started`, { method: "POST", token: job.token, body: { session: session.sessionId } });
          if (this.suspended || controller.signal.aborted) throw new DOMException("Automation cancelled", "AbortError");
        },
      });
      usage = addUsage(usage, round.usage);
      const original = contract.readMessage(round.text);
      let parsed = contract.resultFrom(original, { session: round.sessionId, usage });
      for (let repair = 0; parsed.problem && repair < 2 && !controller.signal.aborted; repair++) {
        try {
          round = await execute({ cwd, sessionId: round.sessionId, sessionFile: round.sessionFile,
            prompt: contract.repairPrompt(parsed.problem), repair: true, signal: controller.signal,
            ...(rule.provider && rule.modelId && { model: { provider: rule.provider, modelId: rule.modelId } }),
            ...(rule.thinkingLevel && { thinkingLevel: rule.thinkingLevel }) });
          usage = addUsage(usage, round.usage);
          const repaired = contract.readMessage(round.text);
          parsed = contract.resultFrom({ ...repaired, outcome: original.outcome, summary: original.summary, error: original.error }, { session: round.sessionId, usage });
        } catch { break; }
      }
      if (parsed.problem) {
        const base = contract.resultFrom({ ...original, receipt: undefined, problem: undefined }, { session: round.sessionId, usage }).result;
        // Receipt failure must not turn completed business into a retry.
        checkpoint.result = { ...base, notice: [{ title: "Automation receipt needs review", text: "The business round ended, but its follow-up instructions could not be applied. Review the linked session before continuing.", key: `receipt-${job.run}` }] };
      } else checkpoint.result = parsed.result;
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      checkpoint.result = {
        outcome: cancelled ? "cancelled" : "failed", ...(checkpoint.sessionId && { session: checkpoint.sessionId }),
        ...(Object.keys(usage).length && { usage }),
        ...(cancelled ? { summary: "Automation execution stopped" } : { error: (error instanceof Error ? error.message : "Automation execution failed").slice(0, 500) }),
      };
    } finally { clearTimeout(timer); }
    checkpoint.stage = "result";
    await this.checkpoints.save(checkpoint);
    await this.deliver(checkpoint);
  }

  async reconcile(run: number) {
    if (this.active?.run === run) throw new Error("Automation is still executing");
    await this.hub.call("/v1/desktop/reconcile", { method: "POST", body: { run, confirmedStopped: true } });
    await this.checkpoints.remove(run);
    await rm(join(this.checkpoints.directory, `${run}.context.json`), { force: true });
    this.error = undefined;
    this.recoveryRun = null;
  }
}
