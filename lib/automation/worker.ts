import { createHash, randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { statSync } from "fs";
import { dirname, join } from "path";
import type { PiAutomationRoundOptions, PiAutomationRoundResult } from "./pi-executor";
import { AutomationCheckpoints, writeAutomationPrivateFile, type AutomationCheckpoint } from "./checkpoint";
import { loadAutomationContract, type AutomationContract } from "./contract";
import { AutomationInputError, parseAutomationConfig, parseAutomationRule } from "./config";
import { AutomationHubError, type AutomationHubClient } from "./hub-client";
import { AutomationAuthenticationRequiredError, AutomationExecutionUncertainError, AutomationRoundFailedError, AutomationSessionOpenError } from "./execution-errors";
import { AutomationSessionChangedError, inspectAutomationSession, listAutomationBindings, readAutomationBinding, saveAutomationBinding, type AutomationSessionBinding } from "./session-binding";
import type { AutomationConfig, AutomationJob, AutomationRule, AutomationUsage } from "./types";

type Execute = (options: PiAutomationRoundOptions) => Promise<PiAutomationRoundResult>;
type WorkerDependencies = {
  execute?: Execute;
  contract?: AutomationContract;
  validateCwd: (cwd: string) => Promise<string>;
};
const AUTH_RECOVERY_TITLE = "Restore model authentication";
const AUTH_RECOVERY_OPTIONS = ["Authentication restored", "Pause this task"];

function addUsage(total: AutomationUsage, round: PiAutomationRoundResult["usage"]): AutomationUsage {
  return { input: (total.input ?? 0) + round.input, output: (total.output ?? 0) + round.output,
    cached: (total.cached ?? 0) + round.cacheRead, cost: (total.cost ?? 0) + round.cost };
}

export class AutomationWorker {
  private active: { run: number; sessionId?: string; controller: AbortController; done: Promise<void> } | null = null;
  private polling = false;
  private suspended = false;
  private stopped = false;
  private error: string | undefined;
  private recoveryRun: number | null = null;
  private claim = randomUUID();
  private checkpoints: AutomationCheckpoints;
  private root: string;
  private sessionAudits = new Map<string, { digest: string; mtimeMs: number; ctimeMs: number; size: number }>();

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

  async stopSession(sessionId: string, timeoutMs = 8000, ruleIds: string[] = []): Promise<boolean> {
    // Drain an in-flight claim before deciding which active run owns the rule.
    const deadline = Date.now() + timeoutMs;
    while (this.polling && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.polling) return false;
    const checkpoints = (await this.checkpoints.list()).filter((entry) => entry.sessionId === sessionId || entry.job.session === sessionId || ruleIds.includes(entry.job.rule.name));
    if (checkpoints.some((entry) => entry.stage === "running" && entry.job.run !== this.active?.run)) return false;
    const active = this.active;
    if (!active || (active.sessionId !== sessionId && !checkpoints.some((entry) => entry.job.run === active.run))) return true;
    active.controller.abort(new Error("The managed automation session is being changed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([active.done.then(() => true, () => false), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); })]);
      return settled && !(await this.checkpoints.list()).some((entry) => entry.job.run === active.run && entry.stage === "running");
    } finally { clearTimeout(timer); }
  }

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
      await this.auditSessions();
      const config = await this.config();
      if (!config) return;
      if (this.suspended) return;
      const claim = recovered?.claim ?? this.claim;
      const query = new URLSearchParams({ claim, wait: "0", running: recovered ? String(recovered.job.run) : "", capacity: "1" });
      const { job } = await this.hub.call<{ job: AutomationJob | null }>(`/v1/work?${query}`, { role: "worker" });
      if (!job) { this.error = undefined; return; }
      const checkpoint: AutomationCheckpoint = recovered ? { ...recovered, job } : { version: 1, claim, job, stage: "claimed" };
      await this.checkpoints.save(checkpoint);
      this.claim = randomUUID();
      const controller = new AbortController();
      const done = this.perform(checkpoint, config, controller);
      this.active = { run: job.run, ...(job.session && { sessionId: job.session }), controller, done };
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

  private async pauseBinding(binding: AutomationSessionBinding, reason: string) {
    await saveAutomationBinding(this.root, { ...binding, pausedReason: reason });
    const config = await this.config();
    for (const ruleId of binding.ruleIds) if (config?.rules.some((rule) => rule.id === ruleId && rule.enabled)) await this.hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId } });
    await this.hub.call("/v1/tell", { method: "POST", role: "source", body: { key: `session-changed-${binding.sessionId}`, text: reason } });
  }

  private async auditSessions() {
    const current = await this.config();
    for (const binding of await listAutomationBindings(this.root)) {
      if (binding.pausedReason) {
        for (const ruleId of binding.ruleIds ?? []) if (current?.rules.some((rule) => rule.id === ruleId && rule.enabled)) await this.hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId } });
        continue;
      }
      if (binding.version !== 1 || !binding.digest || !Array.isArray(binding.ruleIds) || typeof binding.started !== "boolean") {
        await this.pauseBinding({ ...binding, ruleIds: current?.rules.filter((rule) => rule.cwd === binding.cwd).map((rule) => rule.id) ?? [] },
          "The saved automation session has no verified execution binding. Its original tasks remain paused. Review completed work, then create a new rule to continue in a dedicated session.");
        continue;
      }
      if (!current?.rules.some((rule) => rule.enabled && binding.ruleIds.includes(rule.id))) continue;
      try {
        const stat = statSync(binding.sessionFile);
        const audited = this.sessionAudits.get(binding.sessionId);
        if (audited?.digest === binding.digest && stat.mtimeMs === audited.mtimeMs && stat.ctimeMs === audited.ctimeMs && stat.size === audited.size) continue;
      } catch { /* Strict validation records a durable session loss below. */ }
      try {
        const identity = inspectAutomationSession(binding.sessionFile, binding);
        this.sessionAudits.set(binding.sessionId, { digest: identity.digest, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, size: identity.size });
      }
      catch (error) {
        if (!(error instanceof AutomationSessionChangedError)) throw error;
        await this.pauseBinding(binding, error.message);
      }
    }
  }

  private async saveSession(session: { sessionId: string; sessionFile: string; digest?: string }, cwd: string, ruleId: string, started: boolean, fallbackUsed?: boolean) {
    if (!session.digest || !/^[a-f0-9]{64}$/.test(session.digest)) throw new AutomationSessionChangedError("The automation round did not provide a verified session snapshot. Its original tasks remain paused; review before continuing.");
    const identity = inspectAutomationSession(session.sessionFile, { sessionId: session.sessionId, cwd, digest: session.digest });
    const prior = (await listAutomationBindings(this.root)).find((entry) => entry.sessionId === session.sessionId);
    const binding: AutomationSessionBinding = { version: 1, sessionId: session.sessionId, sessionFile: session.sessionFile, cwd, digest: session.digest,
      ruleIds: [...new Set([...(prior?.ruleIds ?? []), ruleId])], started: started || prior?.started === true,
      ...((fallbackUsed || prior?.fallbackUsed) && { fallbackUsed: true }), ...(prior?.pausedReason && { pausedReason: prior.pausedReason }) };
    await mkdir(join(this.root, "sessions"), { recursive: true, mode: 0o700 });
    await saveAutomationBinding(this.root, binding);
    this.sessionAudits.set(session.sessionId, { digest: identity.digest, mtimeMs: identity.mtimeMs, ctimeMs: identity.ctimeMs, size: identity.size });
    return binding;
  }

  private async sessionFor(job: AutomationJob) {
    if (!job.session) return {};
    const saved = await readAutomationBinding(this.root, job.session);
    if (saved.cwd !== job.rule.cwd || !saved.ruleIds.includes(job.rule.name)) throw new AutomationSessionChangedError();
    inspectAutomationSession(saved.sessionFile, saved);
    return { sessionId: saved.sessionId, sessionFile: saved.sessionFile, sessionDigest: saved.digest };
  }

  private async perform(checkpoint: AutomationCheckpoint, config: AutomationConfig, controller: AbortController) {
    const { job } = checkpoint;
    let rule: AutomationRule | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let usage: AutomationUsage = {};
    let businessEnded = false;
    const saveFailureEvidence = async (error: unknown) => {
      const evidence = error instanceof AutomationRoundFailedError || error instanceof AutomationAuthenticationRequiredError ? error.session : undefined;
      if (evidence && rule) await this.saveSession(evidence, job.rule.cwd, rule.id, checkpoint.stage === "running", checkpoint.fallbackUsed);
    };
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
      const resume = await this.sessionFor(checkpoint.sessionId ? { ...job, session: checkpoint.sessionId } : job);
      const roundOptions: PiAutomationRoundOptions = {
        cwd, prompt: contract.promptFor(job, contextFile), ...resume,
        ...(rule.provider && rule.modelId && { model: { provider: rule.provider, modelId: rule.modelId } }),
        ...(rule.thinkingLevel && { thinkingLevel: rule.thinkingLevel }), signal: controller.signal,
        onPrepared: async (session) => {
          checkpoint.sessionId = session.sessionId;
          checkpoint.sessionFile = session.sessionFile;
          await this.saveSession(session, cwd, rule!.id, false, checkpoint.fallbackUsed);
          await this.checkpoints.save(checkpoint);
        },
        onSession: async (session) => {
          checkpoint.sessionId = session.sessionId;
          checkpoint.sessionFile = session.sessionFile;
          checkpoint.stage = "running";
          await this.checkpoints.save(checkpoint);
          if (this.active?.run === job.run) this.active.sessionId = session.sessionId;
          const saved = await this.saveSession(session, cwd, rule!.id, true, checkpoint.fallbackUsed);
          if (saved.pausedReason) throw new AutomationSessionChangedError(saved.pausedReason);
          await this.hub.call(`/v1/runs/${job.run}/started`, { method: "POST", token: job.token, body: { session: session.sessionId } });
          if (this.suspended || controller.signal.aborted) throw new DOMException("Automation cancelled", "AbortError");
        },
      };
      let round: PiAutomationRoundResult;
      try { round = await execute(roundOptions); }
      catch (error) {
        // A fresh session is safe only with durable proof that no prior attempt
        // using this unchanged session ever submitted a prompt.
        if (!(error instanceof AutomationSessionOpenError) || !resume.sessionId || checkpoint.fallbackUsed || checkpoint.stage !== "claimed") throw error;
        const binding = await readAutomationBinding(this.root, resume.sessionId);
        inspectAutomationSession(binding.sessionFile, binding);
        if (binding.started || binding.fallbackUsed) throw error;
        checkpoint.fallbackUsed = true;
        await this.checkpoints.save(checkpoint);
        await saveAutomationBinding(this.root, { ...binding, fallbackUsed: true });
        round = await execute({ ...roundOptions, sessionId: undefined, sessionFile: undefined, sessionDigest: undefined });
      }
      businessEnded = true;
      usage = addUsage(usage, round.usage);
      const original = contract.readMessage(round.text);
      const businessReceipt = () => ({ ...contract.resultFrom({ ...original, receipt: undefined, problem: undefined }, { session: round.sessionId, usage }).result,
        notice: [{ title: "Automation receipt needs review", text: "The business round ended, but its follow-up instructions could not be applied. Review the linked session before continuing.", key: `receipt-${job.run}` }] });
      // This conclusion must survive a crash or an uncertain tool-free repair.
      checkpoint.result = businessReceipt();
      await this.checkpoints.save(checkpoint);
      await this.saveSession(round, cwd, rule.id, true, checkpoint.fallbackUsed);
      let parsed = contract.resultFrom(original, { session: round.sessionId, usage });
      for (let repair = 0; parsed.problem && repair < 2 && !controller.signal.aborted; repair++) {
        try {
          round = await execute({ cwd, sessionId: round.sessionId, sessionFile: round.sessionFile, sessionDigest: round.digest,
            prompt: contract.repairPrompt(parsed.problem), repair: true, signal: controller.signal,
            ...(rule.provider && rule.modelId && { model: { provider: rule.provider, modelId: rule.modelId } }),
            ...(rule.thinkingLevel && { thinkingLevel: rule.thinkingLevel }) });
          usage = addUsage(usage, round.usage);
          checkpoint.result = businessReceipt();
          await this.checkpoints.save(checkpoint);
          await this.saveSession(round, cwd, rule.id, true, checkpoint.fallbackUsed);
          const repaired = contract.readMessage(round.text);
          parsed = contract.resultFrom({ ...repaired, outcome: original.outcome, summary: original.summary, error: original.error }, { session: round.sessionId, usage });
        } catch (error) {
          if (error instanceof AutomationExecutionUncertainError || error instanceof AutomationSessionChangedError) throw error;
          await saveFailureEvidence(error);
          // A startup failure with no SDK evidence is safe only if the last
          // accepted bytes are still unchanged. Never adopt a fresh hash here.
          if (!(error instanceof AutomationRoundFailedError) && !(error instanceof AutomationAuthenticationRequiredError && error.session)) {
            await this.sessionFor({ ...job, session: round.sessionId });
          }
          break;
        }
      }
      if (!parsed.problem) checkpoint.result = parsed.result;
    } catch (thrown) {
      let error = thrown;
      try { await saveFailureEvidence(error); } catch (changed) { error = changed; }
      const cancelled = !(error instanceof AutomationExecutionUncertainError) && !(businessEnded && error instanceof AutomationSessionChangedError)
        && (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"));
      if (!cancelled && error instanceof AutomationAuthenticationRequiredError && !businessEnded) {
        checkpoint.result = { outcome: "done", summary: "Automation is waiting for authentication recovery", ...((checkpoint.sessionId ?? job.session) && { session: checkpoint.sessionId ?? job.session! }),
          ask: [{ key: `desktop-auth:${createHash("sha256").update(error.provider).digest("hex")}`, title: AUTH_RECOVERY_TITLE, text: error.message,
            options: AUTH_RECOVERY_OPTIONS, about: `${error.status ? "The provider rejected this request before any tool started." : "No prompt was submitted for this round."} Recheck authentication or provider access, then continue the remaining work in the same session.` }] };
      } else if (!cancelled && error instanceof AutomationSessionChangedError) {
        const bindings = (await listAutomationBindings(this.root)).filter((entry) => entry.sessionId === (checkpoint.sessionId ?? job.session));
        if (bindings.length) for (const binding of bindings) await this.pauseBinding(binding, error.message);
        else {
          await this.hub.call("/v1/desktop/disable", { method: "POST", body: { ruleId: job.rule.name } });
          await this.hub.call("/v1/tell", { method: "POST", role: "source", body: { key: `session-changed-${job.run}`, text: error.message } });
        }
        if (!businessEnded) checkpoint.result = { outcome: "cancelled", summary: error.message, ...(job.session && { session: job.session }) };
      }
      if (!cancelled && ((businessEnded && (error instanceof AutomationExecutionUncertainError || error instanceof AutomationSessionChangedError))
        || (!businessEnded && !(error instanceof AutomationAuthenticationRequiredError) && !(error instanceof AutomationSessionChangedError)
          && (checkpoint.stage === "running" || error instanceof AutomationExecutionUncertainError)))) {
        // Nothing proves the side effects ended. Keep both durable ownership and
        // the original session; an ordinary retry could repeat completed work.
        this.error = "execution-needs-review";
        this.recoveryRun = job.run;
        checkpoint.stage = "running";
        await this.checkpoints.save(checkpoint);
        return;
      } else if (!checkpoint.result || cancelled) {
        checkpoint.result = {
          outcome: cancelled ? "cancelled" : "failed", ...(checkpoint.sessionId && { session: checkpoint.sessionId }),
          ...(Object.keys(usage).length && { usage }),
          ...(cancelled ? { summary: "Automation execution stopped" } : { error: (error instanceof Error ? error.message : "Automation execution failed").slice(0, 500) }),
        };
      }
    } finally { clearTimeout(timer); }
    checkpoint.stage = "result";
    await this.checkpoints.save(checkpoint);
    await this.deliver(checkpoint);
  }

  async reconcile(run: number, options: { confirmedSessionReviewed?: boolean } = {}) {
    if (this.active?.run === run) throw new Error("Automation is still executing");
    const checkpoint = (await this.checkpoints.list()).find((entry) => entry.job.run === run);
    if (checkpoint?.stage === "running" && checkpoint.sessionId && checkpoint.sessionFile) {
      const bindings = await listAutomationBindings(this.root);
      const binding = bindings.find((entry) => entry.sessionId === checkpoint.sessionId);
      const pausedBinding = { ...(binding ?? { version: 1 as const, sessionId: checkpoint.sessionId, sessionFile: checkpoint.sessionFile,
        cwd: checkpoint.job.rule.cwd, digest: "", started: true }),
        ruleIds: [...new Set([...(Array.isArray(binding?.ruleIds) ? binding.ruleIds : []), checkpoint.job.rule.name])] };
      if (binding?.pausedReason) await this.pauseBinding(pausedBinding, binding.pausedReason);
      else {
        let identity: ReturnType<typeof inspectAutomationSession> | undefined;
        try {
          if (!binding || binding.version !== 1 || !Array.isArray(binding.ruleIds) || typeof binding.started !== "boolean"
            || !binding.ruleIds.includes(checkpoint.job.rule.name) || binding.sessionFile !== checkpoint.sessionFile || binding.cwd !== checkpoint.job.rule.cwd) throw new AutomationSessionChangedError();
          identity = inspectAutomationSession(checkpoint.sessionFile, { sessionId: checkpoint.sessionId, cwd: checkpoint.job.rule.cwd });
        } catch (error) {
          if (!(error instanceof AutomationSessionChangedError)) throw error;
          // Stopping a lost session is distinct from adopting its file. Preserve
          // the pause before releasing the owner so it can be deleted safely.
          await this.pauseBinding(pausedBinding, error.message);
        }
        if (identity && binding && identity.digest !== binding.digest) {
          if (!options.confirmedSessionReviewed) throw new AutomationInputError("Review the original automation session and completed steps, then confirm session review before releasing this run.");
          // Durable before the hub acknowledgement: a lost response or crash
          // must not misclassify these explicitly reviewed bytes as an edit.
          await saveAutomationBinding(this.root, { ...binding, digest: identity.digest, reviewedRun: run, reviewedAt: new Date().toISOString() });
          this.sessionAudits.delete(binding.sessionId);
        }
      }
    }
    await this.hub.call("/v1/desktop/reconcile", { method: "POST", body: { run, confirmedStopped: true,
      ...(checkpoint?.stage === "running" && checkpoint.result && { completed: { token: checkpoint.job.token, result: checkpoint.result } }) } });
    await this.checkpoints.remove(run);
    await rm(join(this.checkpoints.directory, `${run}.context.json`), { force: true });
    this.error = undefined;
    this.recoveryRun = null;
  }
}
