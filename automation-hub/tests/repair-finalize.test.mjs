import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import test from "node:test";
import { startHub } from "../host/main.ts";
import { defaultRules } from "../host/runtime.ts";

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200 } = {}) {
  const response = await fetch(hub.descriptor.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

function compiled(config) {
  return { ...defaultRules(config.timezone), rules: config.rules.filter((rule) => rule.enabled).map((rule) => ({
    name: rule.id, group: rule.id, cwd: rule.cwd, to: "pi", prompt: rule.prompt,
    when: { source: "desktop", types: [`desktop.run.${rule.id}`] }, emits: { source: "desktop", types: ["business.followup"] },
  })) };
}

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-repair-finalize-"));
  const clock = { now: Date.parse("2026-11-05T00:00:00Z") };
  let hub = await startHub({ dataDir, now: () => clock.now });
  let claim = 0;
  const config = { version: 1, timezone: "UTC", rules: [{ id: "rule-repair", name: "Repair fixture", cwd: dataDir, enabled: true,
    trigger: { kind: "manual" }, prompt: "Report the completed business round." }] };
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const save = () => http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules: compiled(config) } });
  await save();
  return {
    clock, config, save,
    get hub() { return hub; },
    row(id) { return hub.runtime.getView().get("runs", id); },
    generation() { return hub.runtime.getView().get("config", "desktop-generations").value["rule-repair"]; },
    count(table) { return Number(hub.runtime.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n); },
    async next(sameClaim) { return (await http(hub, `/v1/work?claim=${sameClaim ?? `repair-${++claim}`}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey })).job; },
    async seed() {
      await http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-repair", eventId: `seed-${++claim}` } });
      return this.next();
    },
    async started(job, session = "repair-session") {
      await http(hub, `/v1/runs/${job.run}/started`, { method: "POST", key: job.token, body: { session } });
    },
    async unknown(job) {
      clock.now += 5 * 60_000 + 1;
      await http(hub, "/v1/work?claim=review-heartbeat&wait=0&running=&capacity=0", { key: hub.descriptor.workerKey });
      hub.runtime.execute("tick", []);
      assert.equal(this.row(job.run).state, "unknown");
    },
    finalize(job, result, options = {}) {
      return http(hub, "/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: true, completed: { token: job.token, result } }, ...options });
    },
    finish(job, result) { return http(hub, `/v1/runs/${job.run}/result`, { method: "POST", key: job.token, body: result }); },
    async restart() {
      hub.runtime.db.exec("UPDATE projection_meta SET format='rebuild-repair-finalize-fixture'");
      await hub.close();
      hub = await startHub({ dataDir, now: () => clock.now });
    },
  };
}

test("completed business finalization records base fields and applies only one controlled review notice", async (t) => {
  const f = await fixture(t);
  const existing = f.hub.runtime.execute("createCard", [{ kind: "notice", key: "existing", title: "Existing decision", text: "Keep open", rule: "rule-repair", grp: "rule-repair", source: "desktop" }]).card;
  const job = await f.seed();
  await f.started(job);
  const before = { runs: f.count("runs"), events: f.count("events"), generation: f.generation() };
  const result = { outcome: "done", summary: "Business already completed", session: "repair-session", usage: { input: 17, output: 9, cached: 3, cost: 0.25 },
    ask: [{ title: "Must not ask", text: "Never dispatch", options: ["A", "B"] }],
    later: [{ key: "must-not-schedule", at: "2026-11-05T00:01:00Z", about: "Never schedule" }],
    events: [{ id: "must-not-emit", type: "business.followup" }], resolve: [{ card: existing, reason: "Must not resolve" }],
    notice: [{ title: "Untrusted caller notice", text: "Must not use this text" }] };
  assert.deepEqual(await f.finalize(job, result), { ok: true });
  const row = f.row(job.run);
  assert.equal(row.state, "done");
  assert.equal(row.summary, result.summary);
  assert.equal(row.session, result.session);
  assert.deepEqual(JSON.parse(row.usage), result.usage);
  assert.deepEqual(row.desktop_completed_result, { outcome: result.outcome, summary: result.summary, session: result.session, usage: result.usage });
  assert.equal(row.desktop_reconciled, true);
  assert.equal(row.issued, null);
  assert.equal(f.hub.runtime.desktopStatus().owner, null);
  assert.equal(f.generation(), before.generation);
  assert.equal(f.count("runs"), before.runs);
  assert.equal(f.count("events"), before.events);
  assert.equal(f.count("timers"), 0);
  assert.equal(f.hub.runtime.getView().get("cards", existing).state, "open");
  const cards = (await http(f.hub, "/v1/state")).cards;
  assert.equal(cards.filter((card) => card.kind === "ask").length, 0);
  const notices = cards.filter((card) => card.title === "Automation receipt needs review");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /outcome done/);
  assert.match(notices[0].text, /will not be retried/);
  assert.ok(!JSON.stringify(f.hub.runtime.logAfter()).includes(job.token), "facts never persist the raw attempt token");
  const usage = row.usage;
  assert.equal((await f.finalize(job, result)).duplicate, true);
  assert.equal((await f.finish(job, result)).duplicate, true, "a late original result is also an idempotent acknowledgement");
  assert.equal(f.row(job.run).usage, usage);
  await f.restart();
  assert.equal((await f.finalize(job, result)).duplicate, true);
  assert.deepEqual(f.row(job.run).desktop_completed_result, row.desktop_completed_result);
  assert.equal((await http(f.hub, "/v1/state")).cards.filter((card) => card.title === "Automation receipt needs review").length, 1);
  f.clock.now += 24 * 3600_000;
  f.hub.runtime.execute("tick", []);
  assert.equal(await f.next(), null);
});

test("nothing with an empty summary remains a completed terminal outcome", async (t) => {
  const f = await fixture(t);
  const other = await f.seed();
  await f.finish(other, { outcome: "done", summary: "Earlier round", session: "other-session", later: [{ key: "existing-review", at: "2026-11-05T01:00:00Z", about: "Keep this preexisting appointment" }] });
  const otherCards = ["unknown", "failing"].map((kind) => f.hub.runtime.execute("createCard", [{ kind: "notice", key: `run:${other.run}:${kind}`,
    title: "Other round status", text: "Keep this card", rule: "rule-repair", run: other.run }]).card);
  const job = await f.seed();
  await f.started(job);
  await f.unknown(job);
  const ownFailing = f.hub.runtime.execute("createCard", [{ kind: "notice", key: `run:${job.run}:failing`, title: "This round was failing", text: "Now confirmed", rule: "rule-repair", run: job.run }]).card;
  const timers = f.hub.runtime.db.prepare("SELECT * FROM timers").all();
  const untouchedCards = otherCards.map((id) => structuredClone(f.hub.runtime.getView().get("cards", id)));
  const generation = f.generation();
  const result = { outcome: "nothing", summary: "", session: "repair-session", usage: { input: 0, output: 0, cost: 0 } };
  await f.finalize(job, result);
  assert.equal(f.row(job.run).state, "nothing");
  assert.equal(f.row(job.run).summary, "");
  assert.deepEqual(f.row(job.run).desktop_completed_result, result);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE state='open' AND key=?").get(`run:${job.run}:unknown`).n, 0);
  assert.equal(f.hub.runtime.getView().get("cards", ownFailing).state, "closed");
  assert.deepEqual(otherCards.map((id) => f.hub.runtime.getView().get("cards", id)), untouchedCards);
  assert.deepEqual(f.hub.runtime.db.prepare("SELECT * FROM timers").all(), timers);
  assert.equal(f.generation(), generation);
  assert.equal(await f.next(), null);
});

test("confirmed failed business preserves its failure and usage without entering the normal retry path", async (t) => {
  const f = await fixture(t);
  const job = await f.seed();
  await f.started(job);
  const result = { outcome: "failed", summary: "Business failed after one checked attempt", error: "Fixture business failure", session: "repair-session", usage: { input: 11, output: 4, cost: 0.1 } };
  await f.finalize(job, result);
  const row = f.row(job.run);
  assert.equal(row.state, "cancelled", "use the existing terminal presentation, with the original failure retained");
  assert.equal(row.error, result.error);
  assert.equal(row.summary, result.summary);
  assert.equal(row.session, result.session);
  assert.deepEqual(JSON.parse(row.usage), result.usage);
  assert.deepEqual(row.desktop_completed_result, result);
  assert.equal(row.attempts, 0);
  assert.ok(row.finished_at);
  const card = (await http(f.hub, "/v1/state")).cards.find((item) => item.title === "Automation receipt needs review");
  assert.match(card.text, /outcome failed/);
  f.clock.now += 48 * 3600_000;
  f.hub.runtime.execute("tick", []);
  assert.equal(await f.next(), null);
  assert.equal(f.count("runs"), 1);
});

test("owner authorization, original attempt token and protocol limits reject before changing the owner", async (t) => {
  const f = await fixture(t);
  const job = await f.seed();
  await f.started(job);
  const result = { outcome: "done", summary: "Checked", session: "repair-session" };
  const body = { run: job.run, confirmedStopped: true, completed: { token: job.token, result } };
  const owner = structuredClone(f.hub.runtime.desktopStatus().owner);
  const seq = f.hub.runtime.getView().seq;
  for (const [changed, status] of [
    [{ ...body, confirmedStopped: false }, 409],
    [{ ...body, completed: { token: "bad-token", result } }, 401],
    [{ ...body, completed: { token: "x".repeat(129), result } }, 400],
    [{ ...body, completed: { token: job.token, result: {} } }, 400],
    [{ ...body, completed: { token: job.token, result: { ...result, summary: "x".repeat(501) } } }, 400],
    [{ ...body, completed: { token: job.token, result: { ...result, events: Array.from({ length: 101 }, (_, n) => ({ id: `e-${n}`, type: "business.followup" })) } } }, 400],
    [{ ...body, completed: { token: job.token, result: { ...result, session: "wrong-session" } } }, 409],
  ]) await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: changed, status });
  const oversized = await new Promise((resolve, reject) => {
    // An oversized Content-Length is rejected before upload; do not race that early response with a 1 MiB fetch write.
    const outgoing = request(f.hub.descriptor.url + "/v1/desktop/reconcile", { method: "POST", headers: {
      authorization: `Bearer ${f.hub.descriptor.ownerKey}`, "content-type": "application/json", "content-length": 1024 * 1024 + 1,
    } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.equal(oversized, 413);
  await http(f.hub, "/v1/desktop/reconcile", { key: f.hub.descriptor.workerKey, method: "POST", body, status: 401 });
  assert.deepEqual(f.hub.runtime.desktopStatus().owner, owner);
  assert.equal(f.hub.runtime.getView().seq, seq);
  assert.equal(f.row(job.run).state, "claimed");
});

test("a retired attempt token cannot finalize a later attempt and usage is accounted once", async (t) => {
  const f = await fixture(t);
  const first = await f.seed();
  await f.finish(first, { outcome: "failed", error: "Ordinary retryable fixture failure", usage: { input: 2, output: 1 } });
  assert.equal(f.row(first.run).state, "queued", "normal failed results retain their existing retry behavior");
  f.clock.now += 5 * 60_000;
  f.hub.runtime.execute("tick", []);
  const second = await f.next();
  assert.equal(second.run, first.run);
  assert.equal(second.attempt, 2);
  await f.started(second);
  const result = { outcome: "done", summary: "Second attempt completed", session: "repair-session", usage: { input: 5, output: 3 } };
  await f.finalize(first, result, { status: 401 });
  await f.finalize(second, result);
  assert.deepEqual(JSON.parse(f.row(second.run).usage), { input: 7, output: 4 });
  assert.equal((await f.finalize(second, result)).duplicate, true);
  assert.deepEqual(JSON.parse(f.row(second.run).usage), { input: 7, output: 4 });
});

test("stale acknowledgement and conflicting completed bodies cannot change a newer owner or generation", async (t) => {
  const f = await fixture(t);
  const first = await f.seed();
  await f.started(first);
  const result = { outcome: "done", summary: "Original business done", session: "repair-session" };
  await f.finalize(first, result);
  const second = await f.seed();
  const owner = structuredClone(f.hub.runtime.desktopStatus().owner);
  const generation = f.generation();
  assert.equal((await f.finalize(first, result)).duplicate, true);
  await f.finalize(first, { ...result, summary: "Different conclusion" }, { status: 409 });
  await f.finalize(first, { ...result, notice: [{ title: "Changed payload", text: "Even stripped fields are fingerprinted" }] }, { status: 409 });
  await f.finalize({ ...first, token: "bad-token" }, result, { status: 401 });
  assert.equal((await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: { run: first.run, confirmedStopped: true } })).duplicate, true);
  assert.deepEqual(f.hub.runtime.desktopStatus().owner, owner);
  assert.equal(f.generation(), generation);
  assert.equal(f.row(second.run).state, "claimed");
});

test("disabled or replaced generations retain completed business without cancelling new queued work", async (t) => {
  for (const mode of ["disabled", "removed", "reenabled-and-changed"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    const old = await f.seed();
    await f.started(old);
    await http(f.hub, "/v1/desktop/disable", { method: "POST", body: { ruleId: "rule-repair" } });
    if (mode === "removed") { f.config.rules = []; await f.save(); }
    if (mode === "reenabled-and-changed") {
      f.config.rules[0].enabled = true;
      f.config.rules[0].prompt = "New generation prompt";
      await f.save();
      await http(f.hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-repair", eventId: "new-generation" } });
    }
    const generation = f.generation();
    await f.finalize(old, { outcome: "done", summary: "Old business confirmed complete", session: "repair-session", later: [{ key: "old-review", at: "2026-11-05T00:01:00Z", about: "Do not schedule" }] });
    assert.equal(f.row(old.run).state, "done");
    assert.equal(f.row(old.run).summary, "Old business confirmed complete");
    assert.equal(f.generation(), generation);
    assert.equal(f.count("timers"), 0);
    const next = await f.next();
    if (mode === "reenabled-and-changed") { assert.ok(next); assert.notEqual(next.run, old.run); assert.equal(next.rule.prompt, "New generation prompt"); }
    else assert.equal(next, null);
  });
});

test("disable racing with confirmed completion cannot erase the business conclusion", async (t) => {
  const f = await fixture(t);
  const job = await f.seed();
  await f.started(job);
  await Promise.all([
    f.finalize(job, { outcome: "nothing", summary: "Verified empty result", session: "repair-session" }),
    http(f.hub, "/v1/desktop/disable", { method: "POST", body: { ruleId: "rule-repair" } }),
  ]);
  assert.equal(f.row(job.run).state, "nothing");
  assert.equal(f.row(job.run).summary, "Verified empty result");
  assert.equal(f.hub.runtime.desktopStatus().owner, null);
  assert.equal(f.hub.runtime.desktopStatus().config.rules[0].enabled, false);
  assert.equal(f.count("runs"), 1);
  assert.equal(await f.next(), null);
});

test("ordinary unknown reconciliation remains compatible and cannot later adopt a completed body", async (t) => {
  const f = await fixture(t);
  const first = await f.seed();
  await f.started(first);
  await f.unknown(first);
  const body = { run: first.run, confirmedStopped: true };
  await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body });
  assert.equal(f.row(first.run).state, "cancelled");
  assert.equal(f.row(first.run).desktop_completed_result, undefined);
  const second = await f.seed();
  const owner = structuredClone(f.hub.runtime.desktopStatus().owner);
  assert.equal((await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body })).duplicate, true);
  await f.finalize(first, { outcome: "done", summary: "Too late to adopt" }, { status: 409 });
  assert.deepEqual(f.hub.runtime.desktopStatus().owner, owner);
  assert.equal(f.row(second.run).state, "claimed");
});
