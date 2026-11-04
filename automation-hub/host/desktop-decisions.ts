import { decide } from "../upstream/kernel/decide.ts";
import { deadlines } from "../upstream/kernel/due.ts";
import { Conflict, InputError, NotFound } from "../upstream/kernel/errors.ts";
import { iso, rows, type Change, type Fact, type Row, type View } from "../upstream/kernel/evolve.ts";
import type { Environment } from "../upstream/kernel/credentials.ts";
import type { Rules } from "../upstream/kernel/rules.ts";
import { dayStart } from "../upstream/kernel/cron.ts";
import { configuration, eventsOf } from "../upstream/kernel/query.ts";

type DesktopRule = { id: string; enabled: boolean; trigger?: { kind: string; at?: string; cron?: string } };
type DesktopConfig = { version: 1; rules: DesktopRule[]; [key: string]: unknown };
const config = (view: View) => view.get("config", "desktop")?.value as DesktopConfig | undefined;
const generations = (view: View): Record<string, number> => view.get("config", "desktop-generations")?.value ?? {};
const countDay = (view: View, now: number) => iso(dayStart(now, config(view)?.timezone as string ?? configuration(view).timezone));
export function desktopStatus(view: View, now = Date.now()) {
  const counts = view.get("config", "desktop-counts");
  return { config: config(view) ?? null, owner: view.get("config", "desktop-owner") ?? null, dailyCounts: counts?.day === countDay(view, now) ? counts.value as Record<string, number> : {} };
}

export function desktopDecision(view: View, type: string, args: unknown[], now: number, environment: Environment): { facts: Fact[]; value: unknown } {
  if (type === "started") {
    const run = view.get("runs", Number(args[0]));
    if (run && (run.cancel_at !== null || (run.desktop_generation ?? 0) !== (generations(view)[run.rule] ?? 0))) throw new Conflict("This execution was cancelled before starting");
  }
  if (type === "answer" || type === "resolve") {
    const expected = type === "answer" ? (args[1] as { expectedVersion?: unknown } | undefined)?.expectedVersion : args[3];
    if (expected !== undefined) {
      if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw new InputError("Invalid expected card version");
      const card = view.get("cards", Number(args[0]));
      if (!card) throw new NotFound("No card");
      if (card.version !== expected) throw new Conflict("The card changed; refresh before answering");
    }
  }
  const changes: Change[] = [];
  const draft = view.fork();
  const set = (table: Change["table"], key: string | number, row: Row | null) => {
    const change = { table, key: String(key), row };
    changes.push(change);
    draft.set(table, String(key), row);
  };
  const put = (table: Change["table"], key: string | number, fields: Row) => set(table, key, { ...draft.get(table, key), ...fields });
  const generationOf = (rule: string) => generations(draft)[rule] ?? 0;
  const stale = (run: Row) => (run.desktop_generation ?? 0) !== generationOf(run.rule);
  const progress = (rule: string, record: Row) => put("config", "desktop-no-progress", { value: { ...draft.get("config", "desktop-no-progress")?.value, [rule]: record } });
  const cancelRule = (rule: string) => {
    const nextGeneration = generationOf(rule) + 1;
    put("config", "desktop-generations", { value: { ...generations(draft), [rule]: nextGeneration } });
    progress(rule, { generation: nextGeneration, signature: null, count: 0 });
    const definition = config(draft)?.rules.find((candidate) => candidate.id === rule);
    if (definition?.trigger?.kind === "once") put("config", "desktop-once", { value: { ...draft.get("config", "desktop-once")?.value, [rule]: `${nextGeneration}:${definition.trigger.at}` } });
    for (const run of rows(draft, "runs", { rule })) {
      if (run.state === "queued") put("runs", run.id, { state: "cancelled", finished_at: iso(now), summary: "Task cancelled", issued: null });
      if (["claimed", "unknown"].includes(run.state)) put("runs", run.id, { cancel_at: iso(now) });
    }
    for (const card of rows(draft, "cards", { rule, state: "open" })) put("cards", card.id, { state: "closed", result: "Task cancelled", closed_at: iso(now), version: card.version + 1 });
    for (const timer of rows(draft, "timers", { rule, event_id: null })) set("timers", timer.id, null);
  };
  const core = (command: string, input: unknown[]) => {
    const env: Environment = { ...environment, transformResult: (run, result) => stale(run)
      ? { outcome: "cancelled", summary: "Task cancelled", ...(result.session && { session: result.session }), ...(result.usage && { usage: result.usage }) }
      : result };
    const result = decide(draft, { type: command, args: input }, now, env);
    for (const fact of result.facts) for (const change of fact.changes) set(change.table, change.key, change.row);
    return result.value;
  };
  const disableRule = (ruleId: unknown) => {
    const current = config(draft);
    const rule = current?.rules.find((candidate) => candidate.id === ruleId);
    if (!current || !rule) throw new NotFound("No desktop rule");
    if (!rule.enabled) return;
    cancelRule(rule.id);
    const next = structuredClone(current);
    next.rules = next.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, enabled: false } : candidate);
    put("config", "desktop", { value: next });
    const compiled = structuredClone(configuration(draft));
    compiled.rules = compiled.rules.filter((candidate) => candidate.name !== rule.id);
    const usedAgents = new Set([...compiled.rules.map((candidate) => candidate.to), ...compiled.elsewhere.map((candidate) => candidate.to)]);
    for (const agentId of Object.keys(compiled.agents)) if (!usedAgents.has(agentId)) delete compiled.agents[agentId];
    core("rules", [compiled]);
  };
  const checkFollowUp = (runId: number, receipt: Row) => {
    const run = draft.get("runs", runId)!;
    if (stale(run) || !config(draft)?.rules.some((rule) => rule.id === run.rule && rule.enabled)) return;
    const events = eventsOf(draft, run.id);
    const fired = new Set(rows(draft, "timers", { rule: run.rule }).filter((timer) => timer.event_id !== null).map((timer) => timer.event_id));
    const later = (receipt.later ?? []).filter((timer: Row) => !timer.cancel && Date.parse(timer.at) > now);
    const onlyTimers = events.length > 0 && events.every((event) => event.type === "timer.due" && fired.has(event.id));
    const eligible = ["done", "nothing"].includes(run.state) && onlyTimers && later.length > 0
      && !receipt.ask?.length && !receipt.events?.length && !receipt.resolve?.length;
    const generation = generationOf(run.rule);
    if (!eligible) return progress(run.rule, { generation, signature: null, count: 0 });
    // Compare explicit follow-up instructions, never timestamps or inferred business meaning.
    const instructions = later.map((timer: Row) => ({ key: timer.key, about: timer.about })).sort((a: Row, b: Row) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const signature = JSON.stringify({ outcome: run.state, summary: run.summary ?? "", later: instructions });
    const previous = draft.get("config", "desktop-no-progress")?.value?.[run.rule];
    const count = previous?.generation === generation && previous.signature === signature ? previous.count + 1 : 1;
    progress(run.rule, { generation, signature, count });
    if (count < 3) return;
    disableRule(run.rule);
    core("createCard", [{ key: `desktop-no-progress:${run.rule}:${generation}`, kind: "notice", once: true, rule: run.rule, grp: run.grp, lane: run.lane, run: run.id,
      title: "Automation follow-ups need review", text: "Three timer follow-ups returned the same outcome, summary and next-check instructions. The rule was disabled. Review its session before enabling it again." }]);
  };
  let value: unknown;
  if (type === "desktopConfig") {
    const next = args[0] as DesktopConfig;
    const compiled = args[1] as Rules;
    if (!next || next.version !== 1 || !Array.isArray(next.rules) || next.rules.some((rule) => typeof rule.id !== "string" || typeof rule.enabled !== "boolean")) throw new InputError("Invalid desktop configuration");
    const prior = config(draft);
    for (const rule of prior?.rules ?? []) if (rule.enabled && !next.rules.some((candidate) => candidate.id === rule.id && candidate.enabled)) cancelRule(rule.id);
    for (const rule of prior?.rules ?? []) {
      const replacement = next.rules.find((candidate) => candidate.id === rule.id);
      if (rule.trigger?.kind === "once" && (replacement?.trigger?.kind !== "once" || replacement.trigger.at !== rule.trigger.at))
        for (const timer of rows(draft, "timers", { rule: rule.id, key: "desktop-once", event_id: null })) set("timers", timer.id, null);
    }
    const known = { ...generations(draft) };
    for (const rule of next.rules) {
      if (known[rule.id] === undefined) known[rule.id] = 1;
      else if (rule.enabled && !prior?.rules.some((previous) => previous.id === rule.id && previous.enabled)) known[rule.id] += 1;
      if (known[rule.id] !== generationOf(rule.id)) progress(rule.id, { generation: known[rule.id], signature: null, count: 0 });
    }
    put("config", "desktop-generations", { value: known });
    put("config", "desktop", { value: next });
    core("rules", [compiled]);
    for (const rule of next.rules) {
      const previous = prior?.rules.find((candidate) => candidate.id === rule.id);
      if (rule.enabled && rule.trigger?.kind === "cron" && (!previous?.enabled || previous.trigger?.kind !== "cron"
        || previous.trigger.cron !== rule.trigger.cron || prior?.timezone !== next.timezone)) set("schedules", rule.id, null);
    }
    const scheduled: Record<string, string> = { ...(draft.get("config", "desktop-once")?.value ?? {}) };
    for (const rule of next.rules) {
      if (!rule.enabled || rule.trigger?.kind !== "once") continue;
      const at = rule.trigger.at;
      if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) throw new InputError("Invalid one-time appointment");
      const occurrence = `${generationOf(rule.id)}:${at}`;
      if (scheduled[rule.id] === occurrence) continue;
      for (const timer of rows(draft, "timers", { rule: rule.id, key: "desktop-once", event_id: null })) set("timers", timer.id, null);
      const id = (draft.next.timers ?? 0) + 1;
      set("timers", id, { id, rule: rule.id, lane: "", key: "desktop-once", source: "desktop", at: new Date(at).toISOString(), about: "Desktop one-time appointment", session: null, hops: 0, event_id: null, created_at: iso(now) });
      scheduled[rule.id] = occurrence;
    }
    put("config", "desktop-once", { value: scheduled });
    // Installing a new cron must arm its first deadline without waiting for unrelated work.
    core("tick", []);
    value = { config: next };
  } else if (type === "desktopDisable") {
    disableRule(args[0]);
    value = { config: config(draft) };
  } else if (type === "desktopCancel") {
    const ruleId = args[0];
    if (typeof ruleId !== "string" || !config(draft)?.rules.some((rule) => rule.id === ruleId)) throw new NotFound("No desktop rule");
    cancelRule(ruleId);
    value = { ok: true };
  } else if (type === "desktopReconcile") {
    const [runId, confirmedStopped] = args;
    if (!Number.isSafeInteger(runId) || Number(runId) < 1) throw new InputError("Invalid run");
    if (confirmedStopped === true && draft.get("runs", Number(runId))?.desktop_reconciled === true) return { facts: [], value: { ok: true, duplicate: true } };
    const owner = draft.get("config", "desktop-owner");
    if (confirmedStopped !== true || !owner || owner.run !== runId) throw new Conflict("Confirm that the current resource owner has stopped");
    const run = draft.get("runs", owner.run);
    if (!run) throw new NotFound("No resource-owning run");
    cancelRule(run.rule);
    put("runs", run.id, { state: "cancelled", finished_at: iso(now), summary: "Owner confirmed execution stopped", issued: null, last_issued: null, cancel_at: null, desktop_reconciled: true });
    set("config", "desktop-owner", null);
    value = { ok: true };
  } else if (type === "claimNext") {
    const owner = draft.get("config", "desktop-owner");
    if (owner && (owner.worker !== args[0] || owner.claim !== args[1] || draft.get("runs", owner.run)?.state !== "claimed")) return { facts: [], value: null };
    value = core(type, args);
    if (value) {
      const job = value as { run: number; attempt: number; session: string | null; rule: { cwd: string } };
      const rule = draft.get("runs", job.run)!.rule;
      const definition = config(draft)?.rules.find((candidate) => candidate.id === rule && candidate.enabled);
      const desktopRule = owner ? owner.desktopRule : definition ? structuredClone(definition) : undefined;
      put("config", "desktop-owner", { run: job.run, attempt: job.attempt, claim: args[1], worker: args[0], session: job.session, cwd: job.rule.cwd, generation: generationOf(rule), acquiredAt: iso(now), ...(desktopRule && { desktopRule }) });
      if (desktopRule) value = { ...job, desktopRule };
      if (!owner) {
        const day = countDay(draft, now);
        const saved = draft.get("config", "desktop-counts");
        const counts = saved?.day === day ? saved.value : {};
        put("config", "desktop-counts", { day, value: { ...counts, [rule]: (counts[rule] ?? 0) + 1 } });
      }
    }
  } else {
    if (type === "cancel") {
      const run = draft.get("runs", Number(args[0]));
      if (!run) throw new NotFound("No run");
      cancelRule(run.rule);
      value = { ok: true };
    } else {
      value = core(type, args);
      if (type === "rules") core("tick", []);
    }
    const owner = draft.get("config", "desktop-owner");
    if (type === "started" && owner && owner.run === args[0]) put("config", "desktop-owner", { session: draft.get("runs", owner.run)?.session ?? owner.session });
    if (type === "finish" && owner?.run === args[0] && !(value as { duplicate?: boolean })?.duplicate) set("config", "desktop-owner", null);
    if (type === "finish" && !(value as { duplicate?: boolean })?.duplicate) checkFollowUp(Number(args[0]), args[2] as Row);
  }
  // New runs carry the task generation even when created by a card answer or due timer.
  for (const change of [...changes]) {
    if (change.table !== "runs" || !change.row || view.get("runs", change.key)) continue;
    const run = draft.get("runs", change.key)!;
    if (run.desktop_generation === undefined) put("runs", run.id, { desktop_generation: generationOf(run.rule) });
  }
  if (changes.length) {
    const due = deadlines(draft, now);
    for (const [key, row] of Object.entries(due)) if (JSON.stringify(draft.get("due", key)) !== JSON.stringify(row)) set("due", key, row);
    for (const row of rows(draft, "due")) if (!due[`${row.kind}:${row.key}`]) set("due", `${row.kind}:${row.key}`, null);
  }
  return { facts: changes.length ? [{ version: 1, seq: view.seq + 1, at: now, type, changes }] : [], value };
}
