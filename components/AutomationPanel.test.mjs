import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { AutomationPanel } = await jiti.import("./AutomationPanel.tsx");
const { I18nContext } = await jiti.import("@/hooks/useI18n");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
const rule = {
  id: "rule-test", name: "Review project", cwd: "/project", prompt: "Review files", enabled: false,
  trigger: { kind: "manual" }, timeoutMinutes: 15, maxDailyRuns: 25, emits: [],
};
function snapshot(overrides = {}) {
  return {
    available: true, config: { version: 1, timezone: "Asia/Shanghai", rules: [rule] },
    state: { cards: [], recentCards: [], runs: [], lines: [], nextBefore: null, totals: { running: 0, queued: 0, unknown: 0 } },
    worker: { suspended: false, activeRun: null }, ...overrides,
  };
}
function render(value, focus) {
  return renderToStaticMarkup(React.createElement(I18nContext.Provider, {
    value: { locale: "en", t: (key, params = {}) => (enLocale.messages[key] ?? key).replace(/\{(\w+)\}/g, (match, name) => params[name] === undefined ? match : String(params[name])), setLocale() {}, supportedLocales: [] },
  }, React.createElement(AutomationPanel, {
    view: { snapshot: value, loading: false, error: null, refresh: async () => value, act: async () => {} },
    cwd: "/project", focus, onOpenSession() {},
  })));
}
function buttonWith(html, label) {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((button) => button.includes(label)) ?? "";
}

test("disabled rules cannot be manually run and disconnected mode disables mutation controls", () => {
  assert.match(buttonWith(render(snapshot()), "Run now"), /\bdisabled=/);
  const enabled = { ...rule, enabled: true };
  const available = snapshot({ config: { version: 1, timezone: "Asia/Shanghai", rules: [enabled] } });
  assert.doesNotMatch(buttonWith(render(available), "Run now"), /\bdisabled=/);
  const disconnected = render({ ...available, available: false });
  assert.match(buttonWith(disconnected, "Run now"), /\bdisabled=/);
  assert.match(buttonWith(disconnected, "New rule"), /\bdisabled=/);
  assert.match(disconnected, /Open the desktop app to enable automation/);
});

test("native card focus opens the persistent inbox and renders external content as text", () => {
  const value = snapshot();
  value.state.cards = [{ id: 3, version: 1, kind: "ask", state: "open", title: "<script>alert(1)</script>", text: "Choose <b>one</b>", options: ["First", "Second"], recommend: 0 }];
  const html = render(value, { cardId: 3 });
  assert.match(html, /id="automation-card-3"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<b>one<\/b>/);
  assert.match(buttonWith(html, "First"), /Recommended/);
  assert.match(html, /Your answer/);
  assert.match(html, /Answer and continue/);
});

test("history distinguishes unknown execution from completed and no-action rounds", () => {
  const value = snapshot();
  const run = { id: 1, rule: rule.id, attempts: 1, createdAt: "2026-11-04T01:00:00Z", state: "done", summary: "", error: "", events: [], session: "01234567-0123-0123-0123-012345678901", stopping: false };
  value.state.runs = [run, { ...run, id: 2, state: "unknown" }, { ...run, id: 3, state: "nothing" }];
  const html = render(value, { runId: 2 });
  assert.match(html, /Round complete/);
  assert.match(html, /No action needed this round/);
  assert.match(html, /Result needs verification/);
  assert.match(html, /Verified execution has stopped/);
  assert.match(html, /Check the linked session and completed actions first/);
  assert.match(html, /Open session/);
});

test("reported zero cost is distinct from missing usage and aggregate gaps remain visible", () => {
  const value = snapshot();
  const run = { id: 1, rule: rule.id, attempts: 0, createdAt: "2026-11-04T01:00:00Z", state: "done", summary: "", error: "", events: [], session: null, stopping: false };
  value.state.runs = [{ ...run, usage: null }, { ...run, id: 2, usage: { input: 100, output: 30, cost: 0 } }];
  value.state.spending = { today: { rounds: 2, tokens: 130, cost: 0, missingTokens: 1, missingCost: 1 } };
  const html = render(value, { runId: 2 });
  assert.match(html, /Model report: Unknown input \/ Unknown output tokens · Cost: Unknown/);
  assert.match(html, /Model report: 100 input \/ 30 output tokens · Cost: \$0\.0000/);
  assert.match(html, /Missing reports: tokens for 1 rounds, cost for 1 rounds/);
});

test("persisted claimed recovery opens history with a reachable confirmation even after reload", () => {
  const value = snapshot({ worker: { suspended: false, activeRun: null, recoveryRun: 7, error: "execution-needs-review" } });
  value.state.totals.running = 1;
  value.state.runs = [{ id: 7, rule: rule.id, attempts: 0, createdAt: "2026-11-04T01:00:00Z", claimedAt: "2026-11-04T01:00:01Z", state: "claimed", summary: "", error: "", events: [], session: "01234567-0123-0123-0123-012345678901", stopping: false, usage: null }];
  for (const restored of [value, JSON.parse(JSON.stringify(value))]) {
    const html = render(restored);
    const confirmation = buttonWith(html, "Verified execution has stopped");
    assert.notEqual(confirmation, "", "Recovery control must be visible without requiring hub unknown state or a saved UI tab");
    assert.doesNotMatch(confirmation, /\bdisabled=/);
    assert.match(html, /Result needs verification/);
    assert.match(html, /0 running · 0 queued · 1 need verification/);
    assert.match(html, /The previous execution has an unconfirmed result/);
    assert.doesNotMatch(html, /execution-needs-review/);
    assert.match(html, /Open session/);
  }
});

test("normal active claimed execution has no recovery confirmation", () => {
  const value = snapshot({ worker: { suspended: false, activeRun: 7, recoveryRun: null } });
  value.state.totals.running = 1;
  value.state.runs = [{ id: 7, rule: rule.id, attempts: 0, createdAt: "2026-11-04T01:00:00Z", state: "claimed", summary: "", error: "", events: [], session: null, stopping: false, usage: null }];
  const html = render(value, { runId: 7 });
  assert.match(html, /Running/);
  assert.match(html, /1 running · 0 queued · 0 need verification/);
  assert.equal(buttonWith(html, "Verified execution has stopped"), "");
  assert.doesNotMatch(html, /The previous execution has an unconfirmed result/);
});
