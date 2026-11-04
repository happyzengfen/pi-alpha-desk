"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowClockwise, Check, ClockClockwise, FolderOpen, Play, Plus, X } from "@phosphor-icons/react";
import { useI18n } from "@/hooks/useI18n";
import type { AutomationCard, AutomationConfig, AutomationRule, AutomationRun, AutomationSnapshot } from "@/lib/automation/types";

async function jsonRequest<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
  return data as T;
}

/** One shared view for the title-bar count and settings; execution stays on the server. */
export function useAutomations() {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await jsonRequest<AutomationSnapshot>("/api/automations");
      if (id === request.current) { setSnapshot(next); setError(null); }
      return next;
    } catch (failure) {
      if (id === request.current) setError(failure instanceof Error ? failure.message : String(failure));
      return null;
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", refresh);
      request.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (!snapshot?.available) return;
    const source = new EventSource("/api/automations/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 150);
    };
    source.addEventListener("fact", changed);
    source.addEventListener("refresh", changed);
    return () => { clearTimeout(timer); source.close(); };
  }, [snapshot?.available, snapshot?.instanceId, refresh]);
  const act = useCallback(async (body: Record<string, unknown>) => {
    try { await jsonRequest("/api/automations", body); }
    finally { await refresh(); }
  }, [refresh]);
  return { snapshot, loading, error, refresh, act };
}

export type AutomationView = ReturnType<typeof useAutomations>;
export type AutomationFocus = { cardId?: number; runId?: number };

const button: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 9px",
  border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)",
  cursor: "pointer", fontSize: 12,
};
const input: CSSProperties = {
  width: "100%", minWidth: 0, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6,
  color: "var(--text)", background: "var(--bg)", fontSize: 12,
};
const box: CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: 14, background: "var(--bg-panel)" };
const muted: CSSProperties = { fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" };

function localDateInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function AutomationPanel({ view, cwd, focus, onOpenSession }: {
  view: AutomationView;
  cwd: string | null;
  focus?: AutomationFocus | null;
  onOpenSession?: (session: string) => void;
}) {
  const { t, locale } = useI18n();
  const { snapshot, loading, error, refresh, act } = view;
  const [tab, setTab] = useState<"rules" | "inbox" | "history">(focus?.cardId ? "inbox" : focus?.runId || snapshot?.worker.recoveryRun != null ? "history" : "rules");
  const [host, setHost] = useState<AutomationHostStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationRule | null>(null);
  const [onceAt, setOnceAt] = useState("");
  const [timezoneDraft, setTimezoneDraft] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [olderRuns, setOlderRuns] = useState<AutomationRun[]>([]);
  const [olderCursor, setOlderCursor] = useState<number | null | undefined>();
  const [why, setWhy] = useState<{ runId: number; facts: unknown[] } | null>(null);
  const config = snapshot?.config;
  const available = snapshot?.available === true;
  const cards = snapshot?.state?.cards ?? [];
  const rules = config?.rules ?? [];
  const disabled = busy || !available;
  const date = (value: string | number) => new Date(value).toLocaleString(locale);

  useEffect(() => {
    let active = true;
    const update = () => {
      void window.piDesktop?.getAutomationStatus?.().then((next) => { if (active) setHost(next); }).catch(() => {});
    };
    update();
    const timer = setInterval(update, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [available]);
  useEffect(() => {
    if (focus?.cardId) setTab("inbox");
    else if (focus?.runId) setTab("history");
  }, [focus]);
  useEffect(() => {
    if (snapshot?.worker.recoveryRun != null && !focus?.cardId && !focus?.runId) setTab("history");
  }, [snapshot?.worker.recoveryRun, focus]);
  useEffect(() => {
    const id = focus?.cardId ? `automation-card-${focus.cardId}` : focus?.runId ? `automation-run-${focus.runId}` : null;
    if (!id) return;
    document.getElementById(id)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focus, tab, snapshot]);
  useEffect(() => { setOlderRuns([]); setOlderCursor(undefined); setWhy(null); }, [snapshot?.instanceId]);

  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setOperationError(null);
    try { await work(); }
    catch (failure) { setOperationError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  const mutate = (body: Record<string, unknown>) => perform(() => act(body));
  async function changeHost(enabled: boolean) {
    await perform(async () => {
      const previous = host;
      setHost((current) => current && { ...current, state: enabled ? "starting" : "stopping" });
      try {
        const next = await window.piDesktop?.setAutomationEnabled(enabled);
        if (next) setHost(next);
        await refresh();
      } catch (failure) { setHost(previous); throw failure; }
    });
  }
  async function saveConfig(next: AutomationConfig) {
    await act({ action: "save_config", config: next });
  }
  function editRule(rule?: AutomationRule) {
    const next: AutomationRule = rule ? { ...rule, emits: [...rule.emits] } : {
      id: `rule-${crypto.randomUUID()}`, name: "", cwd: cwd ?? "", prompt: "", enabled: false,
      trigger: { kind: "manual" }, timeoutMinutes: 15, maxDailyRuns: 25, emits: [],
    };
    setDraft(next);
    setOnceAt(next.trigger.kind === "once" ? localDateInput(next.trigger.at) : "");
    setRemoveId(null);
  }
  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !config) return;
    void perform(async () => {
      const directory = await jsonRequest<{ cwd: string }>("/api/cwd/validate", { cwd: draft.cwd });
      const next: AutomationRule = { ...draft, name: draft.name.trim(), prompt: draft.prompt.trim(), cwd: directory.cwd,
        ...(draft.trigger.kind === "once" && { trigger: { kind: "once", at: new Date(onceAt).toISOString() } }),
      };
      const exists = config.rules.some((rule) => rule.id === next.id);
      await saveConfig({ ...config, rules: exists ? config.rules.map((rule) => rule.id === next.id ? next : rule) : [...config.rules, next] });
      setDraft(null);
    });
  }
  async function selectDirectory() {
    await perform(async () => {
      const selected = await window.piDesktop?.selectDirectory();
      if (selected) setDraft((current) => current && { ...current, cwd: selected });
    });
  }
  const hostReason = host?.reason ?? snapshot?.reason;
  function reasonText() {
    if (hostReason === "external-server") return t("automation.externalServer");
    if (hostReason === "runtime-unavailable") return t("automation.runtimeUnavailable");
    if (hostReason === "worker-drain-failed") return t("automation.drainFailed");
    if (hostReason === "hub-not-installed") return t("automation.hostMissing");
    return t("automation.unavailable");
  }
  const runs = [...new Map([...olderRuns, ...(snapshot?.state?.runs ?? [])].map((run) => [run.id, run])).values()]
    .sort((a, b) => b.id - a.id);
  const cursor = olderCursor === undefined ? snapshot?.state?.nextBefore : olderCursor;
  const ruleName = (id: string) => rules.find((rule) => rule.id === id)?.name ?? t("automation.removedRule");
  const needsReview = (run: AutomationRun) => run.state === "unknown" || snapshot?.worker.recoveryRun === run.id;
  const recoveringRun = runs.find((run) => snapshot?.worker.recoveryRun === run.id && run.state !== "unknown");
  function runState(run: AutomationRun) {
    if (needsReview(run)) return t("automation.unknown");
    if (run.stopping) return t("automation.stopping");
    switch (run.state) {
      case "queued": return run.attempts > 0 ? t("automation.retrying") : t("automation.queued");
      case "claimed": return t("automation.running");
      case "done": return t("automation.roundComplete");
      case "nothing": return t("automation.noAction");
      case "unknown": return t("automation.unknown");
      case "cancelled": return t("automation.cancelled");
      default: return run.state;
    }
  }

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", color: "var(--text)" }}>
      <style>{`.automation-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.automation-fields label{display:flex;flex-direction:column;gap:5px;font-size:12px}.automation-wide{grid-column:1/-1}.automation-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.automation-control:disabled{opacity:.45;cursor:default}.automation-control:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:640px){.automation-fields{grid-template-columns:1fr}}`}</style>
      <header style={{ padding: "18px 22px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{t("automation.title")}</h1>
          <div className="automation-actions">
            {host && <button className="automation-control" style={button} disabled={busy || host.state === "starting" || host.state === "stopping"} onClick={() => void changeHost(!(host.enabled && host.state === "ready"))}>
              {host.state === "starting" ? t("automation.starting") : host.state === "stopping" ? t("automation.stopping") : host.enabled && host.state === "ready" ? t("automation.turnOff") : t("automation.turnOn")}
            </button>}
            <button className="automation-control" style={button} title={t("desktop.refresh")} aria-label={t("desktop.refresh")} disabled={busy} onClick={() => { setOperationError(null); void refresh(); }}><ArrowClockwise size={14} aria-hidden="true" /></button>
          </div>
        </div>
        <p style={{ ...muted, margin: "6px 0 0" }}>{t("automation.description")}</p>
        <p style={{ ...muted, margin: "6px 0 0", color: available ? "var(--accent-green)" : "var(--text-muted)" }} aria-live="polite">
          {loading ? t("desktop.loading") : available ? t("automation.connected") : host?.state === "starting" ? t("automation.starting") : host?.state === "stopping" ? t("automation.stopping") : reasonText()}
        </p>
        {host?.reason === "worker-drain-failed" && <p style={{ ...muted, color: "var(--accent-orange)" }}>{t("automation.drainFailed")}</p>}
        {!available && !host && !loading && <p style={muted}>{t("automation.openDesktop")}</p>}
      </header>

      {(operationError || error) && <div role="alert" style={{ margin: "12px 22px", padding: 10, border: "1px solid var(--accent-red)", borderRadius: 6, ...muted, color: "var(--accent-red)", overflowWrap: "anywhere" }}>{t("automation.actionFailed")}: {operationError ?? error}</div>}
      {snapshot?.worker.error && <p role="status" style={{ ...muted, margin: "12px 22px", color: "var(--accent-orange)" }}>{snapshot.worker.error === "execution-needs-review" ? t("automation.recoveryDescription") : snapshot.worker.error}</p>}
      <nav aria-label={t("automation.sections")} style={{ display: "flex", gap: 6, padding: "12px 22px", borderBottom: "1px solid var(--border)" }}>
        {(["rules", "inbox", "history"] as const).map((section) => <button key={section} className="automation-control" style={{ ...button, background: tab === section ? "var(--bg-selected)" : "var(--bg)" }} aria-pressed={tab === section} onClick={() => setTab(section)}>
          {section === "rules" ? t("automation.rules") : section === "inbox" ? t("automation.inbox") : t("automation.history")}
          {section === "inbox" && cards.length > 0 && <span style={{ color: "var(--accent)" }}>{cards.length}</span>}
        </button>)}
      </nav>

      <div style={{ padding: "16px 22px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
        {tab === "rules" && <>
          <form className="automation-actions" onSubmit={(event) => {
            event.preventDefault();
            if (config) void perform(async () => { await saveConfig({ ...config, timezone: timezoneDraft ?? config.timezone }); setTimezoneDraft(null); });
          }}>
            <label htmlFor="automation-timezone" style={muted}>{t("automation.timezone")}</label>
            <input id="automation-timezone" style={{ ...input, width: 190 }} value={timezoneDraft ?? config?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} onChange={(event) => setTimezoneDraft(event.target.value)} required disabled={disabled} />
            <button className="automation-control" type="submit" style={button} disabled={disabled || timezoneDraft === null}>{t("automation.save")}</button>
            <button className="automation-control" type="button" style={{ ...button, marginLeft: "auto" }} disabled={disabled} onClick={() => editRule()}><Plus size={14} aria-hidden="true" />{t("automation.addRule")}</button>
          </form>
          <p style={{ ...muted, margin: 0 }}>{t("automation.readOnly")}</p>
          {rules.length === 0 && !draft && <p style={muted}>{t("automation.noRules")}</p>}
          {rules.map((rule) => <article key={rule.id} style={box}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, flex: 1 }}>
                <input type="checkbox" checked={rule.enabled} disabled={disabled} onChange={(event) => {
                  if (config) void perform(() => saveConfig({ ...config, rules: config.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) }));
                }} aria-label={t("automation.enableRule", { name: rule.name })} />{rule.name}
              </label>
              <span style={muted}>{rule.enabled ? t("automation.enabled") : t("desktop.disabled")}</span>
              <div className="automation-actions">
                <button className="automation-control" style={button} disabled={disabled || !rule.enabled} onClick={() => void mutate({ action: "trigger", ruleId: rule.id })}><Play size={12} aria-hidden="true" />{t("automation.runNow")}</button>
                <button className="automation-control" style={button} disabled={disabled} onClick={() => editRule(rule)}>{t("automation.edit")}</button>
                <button className="automation-control" style={button} disabled={disabled} onClick={() => setRemoveId(rule.id)}>{t("desktop.remove")}</button>
              </div>
            </div>
            <p style={{ ...muted, margin: "6px 0 0", overflowWrap: "anywhere" }}>{rule.cwd}</p>
            <p style={{ ...muted, margin: "3px 0 0" }}>{rule.trigger.kind === "manual" ? t("automation.manual") : rule.trigger.kind === "cron" ? `${rule.trigger.cron} · ${config?.timezone}` : date(rule.trigger.at)}</p>
            {snapshot?.state?.lines.find((line) => line.id === rule.id)?.next && <p style={{ ...muted, margin: "3px 0 0" }}>{t("automation.nextRun", { time: date(snapshot.state.lines.find((line) => line.id === rule.id)!.next!) })}</p>}
            {removeId === rule.id && <div className="automation-actions" style={{ marginTop: 10 }}>
              <span style={muted}>{t("automation.removeRule", { name: rule.name })}</span>
              <button className="automation-control" style={{ ...button, color: "var(--accent-red)" }} disabled={disabled} onClick={() => {
                if (config) void perform(async () => { await saveConfig({ ...config, rules: config.rules.filter((item) => item.id !== rule.id) }); setRemoveId(null); if (draft?.id === rule.id) setDraft(null); });
              }}>{t("desktop.remove")}</button>
              <button className="automation-control" style={button} disabled={busy} onClick={() => setRemoveId(null)}>{t("desktop.cancel")}</button>
            </div>}
          </article>)}
          {draft && <form onSubmit={submitRule} style={box}>
            <h2 style={{ fontSize: 14, margin: "0 0 12px" }}>{rules.some((rule) => rule.id === draft.id) ? t("automation.editRule") : t("automation.addRule")}</h2>
            <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="automation-fields">
                <label className="automation-wide">{t("automation.name")}<input style={input} value={draft.name} maxLength={120} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="automation-wide">{t("automation.directory")}<span className="automation-actions" style={{ flexWrap: "nowrap" }}><input style={input} value={draft.cwd} required onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} />{host && <button type="button" className="automation-control" style={button} onClick={() => void selectDirectory()} title={t("desktop.selectFolder")} aria-label={t("desktop.selectFolder")}><FolderOpen size={15} aria-hidden="true" /></button>}</span><span style={muted}>{t("automation.directoryTrust")}</span></label>
                <label className="automation-wide">{t("automation.prompt")}<textarea style={{ ...input, minHeight: 110, resize: "vertical", lineHeight: 1.6 }} value={draft.prompt} maxLength={16_000} required onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label>
                <label>{t("automation.trigger")}<select style={input} value={draft.trigger.kind} onChange={(event) => setDraft({ ...draft, trigger: event.target.value === "cron" ? { kind: "cron", cron: "0 9 * * *" } : event.target.value === "once" ? { kind: "once", at: "" } : { kind: "manual" } })}><option value="manual">{t("automation.manual")}</option><option value="cron">{t("automation.cron")}</option><option value="once">{t("automation.once")}</option></select></label>
                {draft.trigger.kind === "cron" && <label>{t("automation.cronExpression")}<input style={input} value={draft.trigger.cron} required onChange={(event) => setDraft({ ...draft, trigger: { kind: "cron", cron: event.target.value } })} /></label>}
                {draft.trigger.kind === "once" && <label>{t("automation.onceTime")}<input type="datetime-local" style={input} value={onceAt} required onChange={(event) => setOnceAt(event.target.value)} /><span style={muted}>{t("automation.localTimezone", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}</span></label>}
                <label>{t("automation.timeout")}<input type="number" style={input} value={draft.timeoutMinutes} min={1} max={120} required onChange={(event) => setDraft({ ...draft, timeoutMinutes: Number(event.target.value) })} /></label>
                <label>{t("automation.dailyLimit")}<input type="number" style={input} value={draft.maxDailyRuns} min={1} max={1000} required onChange={(event) => setDraft({ ...draft, maxDailyRuns: Number(event.target.value) })} /></label>
                <label>{t("automation.provider")}<input style={input} value={draft.provider ?? ""} required={Boolean(draft.modelId)} onChange={(event) => setDraft({ ...draft, provider: event.target.value || undefined })} placeholder={t("automation.useDefault")} /></label>
                <label>{t("automation.model")}<input style={input} value={draft.modelId ?? ""} required={Boolean(draft.provider)} onChange={(event) => setDraft({ ...draft, modelId: event.target.value || undefined })} placeholder={t("automation.useDefault")} /></label>
              </div>
              <label style={{ ...muted, display: "flex", gap: 8, margin: "12px 0" }}><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{t("automation.enableAfterSave")}</label>
              <div className="automation-actions"><button className="automation-control" type="submit" style={{ ...button, background: "var(--accent)", color: "var(--bg)" }}><Check size={13} aria-hidden="true" />{t("automation.saveRule")}</button><button className="automation-control" type="button" style={button} onClick={() => setDraft(null)}>{t("desktop.cancel")}</button></div>
            </fieldset>
          </form>}
        </>}

        {tab === "inbox" && <>
          <p style={{ ...muted, margin: 0 }}>{t("automation.inboxDescription")}</p>
          {cards.length === 0 && <p style={muted}>{t("automation.noCards")}</p>}
          {cards.map((card) => <DecisionCard key={card.id} card={card} disabled={disabled} focused={focus?.cardId === card.id} onAction={mutate} />)}
          {!!snapshot?.state?.recentCards.length && <details style={muted}><summary>{t("automation.resolvedCards")}</summary>{snapshot.state.recentCards.map((card) => <p key={card.id}>#{card.id} · {card.title} · {t("automation.resolved")}</p>)}</details>}
        </>}

        {tab === "history" && <>
          {snapshot?.state && <p style={{ ...muted, margin: 0 }}>{t("automation.totals", { running: Math.max(0, snapshot.state.totals.running - Number(recoveringRun?.state === "claimed")), queued: Math.max(0, snapshot.state.totals.queued - Number(recoveringRun?.state === "queued")), unknown: snapshot.state.totals.unknown + Number(Boolean(recoveringRun)) })}</p>}
          {snapshot?.state?.spending?.today && <p style={{ ...muted, margin: 0 }}>{t("automation.todayUsage", { rounds: snapshot.state.spending.today.rounds, tokens: snapshot.state.spending.today.tokens, cost: snapshot.state.spending.today.cost.toFixed(4) })}{(snapshot.state.spending.today.missingTokens > 0 || snapshot.state.spending.today.missingCost > 0) && ` ${t("automation.usageMissing", { tokens: snapshot.state.spending.today.missingTokens, cost: snapshot.state.spending.today.missingCost })}`}</p>}
          {runs.length === 0 && <p style={muted}>{t("automation.noRuns")}</p>}
          {runs.map((run) => <article key={run.id} id={`automation-run-${run.id}`} style={{ ...box, borderColor: focus?.runId === run.id ? "var(--accent)" : "var(--border)" }}>
            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap" }}><strong style={{ fontSize: 13 }}>#{run.id} · {ruleName(run.rule)}</strong><span style={{ ...muted, color: needsReview(run) ? "var(--accent-orange)" : "var(--text-muted)" }}>{runState(run)}</span></div>
            <p style={{ ...muted, margin: "5px 0" }}>{date(run.createdAt)} · {t("automation.attempts", { count: run.attempts })}</p>
            <p style={{ ...muted, margin: "3px 0" }}>{t("automation.runUsage", { input: run.usage?.input ?? t("automation.usageUnknown"), output: run.usage?.output ?? t("automation.usageUnknown"), cost: typeof run.usage?.cost === "number" ? `$${run.usage.cost.toFixed(4)}` : t("automation.usageUnknown") })}</p>
            {run.summary && <p style={{ ...muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{run.summary}</p>}
            {run.error && <p style={{ ...muted, color: "var(--accent-orange)", overflowWrap: "anywhere" }}>{run.error}</p>}
            {run.events.map((event, index) => <p key={index} style={{ ...muted, margin: "3px 0" }}>{event.summary || (event.type.startsWith("desktop.run.") ? t("automation.manual") : event.type === "schedule.tick" ? t("automation.cron") : event.type === "timer.due" ? t("automation.followup") : event.type)}</p>)}
            <div className="automation-actions">
              {run.session && onOpenSession && <button className="automation-control" style={button} onClick={() => onOpenSession(run.session!)}>{t("automation.openSession")}</button>}
              <button className="automation-control" style={button} disabled={disabled} onClick={() => void perform(async () => { const data = await jsonRequest<{ facts: unknown[] }>(`/api/automations?why=${run.id}`); setWhy({ runId: run.id, facts: data.facts }); })}><ClockClockwise size={13} aria-hidden="true" />{t("automation.why")}</button>
              {["claimed", "queued", "unknown"].includes(run.state) && <button className="automation-control" style={button} disabled={disabled || run.stopping} onClick={() => void mutate({ action: "cancel_rule", ruleId: run.rule })}>{t("automation.cancelTask")}</button>}
              {needsReview(run) && <button className="automation-control" style={button} disabled={disabled} onClick={() => void mutate({ action: "reconcile", runId: run.id, confirmedStopped: true })}>{t("automation.confirmStopped")}</button>}
            </div>
            {needsReview(run) && <p style={{ ...muted, marginBottom: 0 }}>{snapshot?.worker.recoveryRun === run.id ? t("automation.recoveryDescription") : t("automation.unknownDescription")}</p>}
          </article>)}
          {cursor != null && <button className="automation-control" style={{ ...button, alignSelf: "flex-start" }} disabled={disabled} onClick={() => void perform(async () => {
            const older = await jsonRequest<AutomationSnapshot>(`/api/automations?before=${cursor}`);
            setOlderRuns((current) => [...current, ...(older.state?.runs ?? [])]);
            setOlderCursor(older.state?.nextBefore ?? null);
          })}>{t("automation.loadOlder")}</button>}
          {why && <section style={box}><div className="automation-actions" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 13 }}>{t("automation.whyRun", { id: why.runId })}</strong><button className="automation-control" style={button} aria-label={t("desktop.close")} onClick={() => setWhy(null)}><X size={13} aria-hidden="true" /></button></div><HistoryTimeline facts={why.facts} /></section>}
        </>}
      </div>
    </div>
  );
}

function DecisionCard({ card, disabled, focused, onAction }: {
  card: AutomationCard;
  disabled: boolean;
  focused: boolean;
  onAction: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  return <article id={`automation-card-${card.id}`} style={{ ...box, borderColor: focused ? "var(--accent)" : "var(--border)" }}>
    <strong style={{ fontSize: 13 }}>#{card.id} · {card.title}</strong>
    <p style={{ ...muted, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{card.text}</p>
    {card.kind === "ask" ? <>
      <div className="automation-actions">{card.options.map((option, choice) => <button className="automation-control" key={choice} style={{ ...button, borderColor: card.recommend === choice ? "var(--accent)" : "var(--border)" }} disabled={disabled} onClick={() => void onAction({ action: "answer", cardId: card.id, expectedVersion: card.version, choice })}>{option}{card.recommend === choice && <span style={muted}>{t("automation.recommended")}</span>}</button>)}</div>
      <form className="automation-actions" style={{ marginTop: 10 }} onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void onAction({ action: "answer", cardId: card.id, expectedVersion: card.version, text: answer.trim() }); }}>
        <label style={{ flex: 1, minWidth: 120 }}><span className="sr-only">{t("automation.yourAnswer")}</span><input style={input} value={answer} maxLength={4000} onChange={(event) => setAnswer(event.target.value)} placeholder={t("automation.yourAnswer")} disabled={disabled} required /></label>
        <button className="automation-control" type="submit" style={button} disabled={disabled || !answer.trim()}>{t("automation.sendAnswer")}</button>
      </form>
      <button type="button" className="automation-control" style={{ ...button, marginTop: 10 }} disabled={disabled} onClick={() => void onAction({ action: "resolve", cardId: card.id, expectedVersion: card.version, reason: t("automation.resolved") })}>{t("automation.closeQuestion")}</button>
    </> : <form className="automation-actions" onSubmit={(event) => { event.preventDefault(); void onAction({ action: "resolve", cardId: card.id, expectedVersion: card.version, reason: answer.trim() || t("automation.resolved") }); }}><label style={{ flex: 1 }}><span className="sr-only">{t("automation.resolutionNote")}</span><input style={input} value={answer} maxLength={4000} onChange={(event) => setAnswer(event.target.value)} placeholder={t("automation.resolutionNote")} disabled={disabled} /></label><button className="automation-control" type="submit" style={button} disabled={disabled}>{t("automation.resolve")}</button></form>}
  </article>;
}

function HistoryTimeline({ facts }: { facts: unknown[] }) {
  const { t, locale } = useI18n();
  function label(type: unknown) {
    switch (type) {
      case "rules": case "desktopConfig": return t("automation.factConfig");
      case "ingest": case "desktopTrigger": return t("automation.factEvent");
      case "claimNext": return t("automation.factClaim");
      case "started": return t("automation.factStarted");
      case "finish": return t("automation.factResult");
      case "answer": return t("automation.factAnswer");
      case "resolve": return t("automation.factResolve");
      case "cancel": return t("automation.factCancel");
      case "tick": return t("automation.factTime");
      case "heartbeat": return t("automation.factHeartbeat");
      case "sweep": return t("automation.factRecovery");
      default: return typeof type === "string" ? type : t("automation.factChange");
    }
  }
  return <ol style={{ ...muted, marginBottom: 0, paddingLeft: 20 }}>
    {facts.map((given, index) => {
      if (!given || typeof given !== "object") return null;
      const fact = given as Record<string, unknown>;
      const at = typeof fact.at === "number" || typeof fact.at === "string" ? new Date(fact.at).toLocaleString(locale) : "";
      return <li key={typeof fact.seq === "number" ? fact.seq : index} style={{ padding: "6px 0" }}>
        <span>{at} · {label(fact.type)}</span>
        <details><summary style={{ cursor: "pointer", fontSize: 11 }}>{t("automation.rawRecord")}</summary><pre style={{ maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 11 }}>{JSON.stringify(fact, null, 2)}</pre></details>
      </li>;
    })}
  </ol>;
}
