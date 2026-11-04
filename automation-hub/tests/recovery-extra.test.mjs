import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startHub } from "../host/main.ts";
import { defaultRules } from "../host/runtime.ts";

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200 } = {}) {
  const response = await fetch(hub.descriptor.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function fixture(t, instant = "2026-11-04T00:00:00Z") {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-extra-"));
  const clock = { now: Date.parse(instant) };
  let hub = await startHub({ dataDir, now: () => clock.now });
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, clock,
    get hub() { return hub; },
    async restart() { await hub.close(); hub = await startHub({ dataDir, now: () => clock.now }); },
  };
}

async function configure(hub, cwd, { timezone = "UTC", cron, enabled = true } = {}) {
  const rule = { id: "rule-recovery", name: "Recovery fixture", cwd, prompt: "Report the fixture result.", enabled,
    trigger: cron ? { kind: "cron", cron } : { kind: "manual" }, timeoutMinutes: 5, maxDailyRuns: 25, emits: [] };
  const config = { version: 1, timezone, rules: [rule] };
  const rules = { ...defaultRules(timezone), rules: enabled ? [{ name: rule.id, cwd, to: "pi", prompt: rule.prompt,
    when: cron ? { cron } : { source: "desktop", types: [`desktop.run.${rule.id}`] } }] : [] };
  await http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules } });
}

const claim = (hub, name) => http(hub, `/v1/work?claim=${name}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey });
const result = (hub, job, body) => http(hub, `/v1/runs/${job.run}/result`, { key: job.token, method: "POST", body });
const scheduleEvents = (hub) => hub.runtime.db.prepare("SELECT * FROM events WHERE source='schedule' ORDER BY id").all();

test("offline full-directory restore preserves a pending receipt token through new keys and projection rebuild", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-hub-full-backup-"));
  const originalDir = join(root, "original");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  let original = await startHub({ dataDir: originalDir });
  let restored;
  t.after(async () => { await original?.close(); await restored?.close(); rmSync(root, { recursive: true, force: true }); });
  await configure(original, originalDir);
  await http(original, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-recovery", eventId: "before-backup" } });
  const job = (await claim(original, "backup-claim")).job;
  await http(original, `/v1/runs/${job.run}/started`, { key: job.token, method: "POST", body: { session: "backup-session" } });
  const receipt = { outcome: "done", session: "backup-session", summary: "Business completed before backup", ask: [{ key: "review", title: "Review restored result", text: "Choose once", options: ["Accept", "Revise"] }] };
  // This is the worker's durable outbox equivalent, not an executed model or a second task database.
  mkdirSync(join(originalDir, "worker"), { mode: 0o700 });
  writeFileSync(join(originalDir, "worker", `${job.run}.json`), JSON.stringify({ version: 1, claim: "backup-claim", job, stage: "result", result: receipt }), { mode: 0o600 });
  const oldDescriptor = original.descriptor;
  const master = readFileSync(join(originalDir, "master.key"), "utf8");
  await original.close();
  original = undefined;
  cpSync(originalDir, backupDir, { recursive: true });
  cpSync(backupDir, restoredDir, { recursive: true });
  const db = new DatabaseSync(join(restoredDir, "hub.db"));
  db.exec("UPDATE projection_meta SET format='force-offline-restore-rebuild'");
  db.close();
  restored = await startHub({ dataDir: restoredDir });
  assert.notEqual(restored.descriptor.instanceId, oldDescriptor.instanceId);
  assert.notEqual(restored.descriptor.ownerKey, oldDescriptor.ownerKey);
  assert.notEqual(restored.descriptor.workerKey, oldDescriptor.workerKey);
  assert.equal(readFileSync(join(restoredDir, "master.key"), "utf8"), master);
  const pending = JSON.parse(readFileSync(join(restoredDir, "worker", `${job.run}.json`), "utf8"));
  assert.equal((await http(restored, "/v1/desktop/status")).owner.run, job.run);
  assert.equal((await result(restored, pending.job, pending.result)).duplicate, undefined);
  assert.equal((await result(restored, pending.job, pending.result)).duplicate, true);
  const state = await http(restored, "/v1/state");
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].state, "done");
  assert.equal(state.cards.filter((card) => card.title === "Review restored result").length, 1);
  assert.equal((await http(restored, "/v1/desktop/status")).owner, null);
  const resultFacts = restored.runtime.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE json_extract(fact,'$.type')='finish'").get();
  assert.equal(resultFacts.n, 1);
});

test("new cron rules arm immediately and an offline interval coalesces missed ticks to the latest occurrence", async (t) => {
  const f = await fixture(t, "2026-11-01T00:55:00Z");
  await configure(f.hub, f.dataDir, { timezone: "Asia/Shanghai", cron: "0 9 * * *" });
  assert.equal(f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get()?.next_at,
    "2026-11-01T01:00:00.000Z", "activation must arm the first deadline without another unrelated event");
  f.clock.now = Date.parse("2026-11-04T03:17:00Z");
  await f.restart();
  const events = scheduleEvents(f.hub);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, "rule-recovery@2026-11-04T01:00:00.000Z");
  assert.equal(f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get().next_at, "2026-11-05T01:00:00.000Z");
  f.hub.runtime.execute("tick", []);
  assert.equal(scheduleEvents(f.hub).length, 1);
  const job = (await claim(f.hub, "coalesced")).job;
  assert.equal(job.context.events.length, 1);
  await result(f.hub, job, { outcome: "done", summary: "One catch-up run" });
  await f.restart();
  assert.equal((await http(f.hub, "/v1/state")).runs.length, 1);
  assert.equal(scheduleEvents(f.hub).length, 1);
});

test("cron skips a nonexistent DST wall time and fires the next real daily occurrence", async (t) => {
  const f = await fixture(t, "2026-03-07T07:31:00Z");
  await configure(f.hub, f.dataDir, { timezone: "America/New_York", cron: "30 2 * * *" });
  assert.equal(f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get()?.next_at, "2026-03-09T06:30:00.000Z");
  f.clock.now = Date.parse("2026-03-08T07:30:00Z");
  f.hub.runtime.execute("tick", []);
  assert.equal(scheduleEvents(f.hub).length, 0);
  f.clock.now = Date.parse("2026-03-09T06:30:00Z");
  f.hub.runtime.execute("tick", []);
  assert.equal(scheduleEvents(f.hub).length, 1);
  assert.equal(scheduleEvents(f.hub)[0].key, "rule-recovery@2026-03-09T06:30:00.000Z");
});

test("cron fires only at the first occurrence of a repeated DST wall time", async (t) => {
  const f = await fixture(t, "2026-11-01T04:59:00Z");
  await configure(f.hub, f.dataDir, { timezone: "America/New_York", cron: "30 1 * * *" });
  assert.equal(f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get()?.next_at, "2026-11-01T05:30:00.000Z");
  f.clock.now = Date.parse("2026-11-01T05:30:00Z");
  f.hub.runtime.execute("tick", []);
  const first = (await claim(f.hub, "fall-first")).job;
  await result(f.hub, first, { outcome: "done", summary: "First 01:30" });
  f.clock.now = Date.parse("2026-11-01T06:30:00Z");
  f.hub.runtime.execute("tick", []);
  assert.equal(scheduleEvents(f.hub).length, 1);
  assert.equal((await claim(f.hub, "fall-second")).job, null);
  assert.equal(f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get().next_at, "2026-11-02T06:30:00.000Z");
});

test("timezone edits, disable/re-enable, and cron edits replace obsolete deadlines", async (t) => {
  const f = await fixture(t, "2026-11-04T00:55:00Z");
  const next = () => f.hub.runtime.db.prepare("SELECT next_at FROM schedules WHERE rule='rule-recovery'").get()?.next_at;
  await configure(f.hub, f.dataDir, { timezone: "Asia/Shanghai", cron: "0 9 * * *" });
  assert.equal(next(), "2026-11-04T01:00:00.000Z");
  await configure(f.hub, f.dataDir, { timezone: "UTC", cron: "0 9 * * *" });
  assert.equal(next(), "2026-11-04T09:00:00.000Z");
  await configure(f.hub, f.dataDir, { timezone: "UTC", cron: "0 9 * * *", enabled: false });
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM projections WHERE collection='due' AND json_extract(data,'$.kind')='cron'").get().n, 0);
  f.clock.now = Date.parse("2026-11-07T10:00:00Z");
  await configure(f.hub, f.dataDir, { timezone: "UTC", cron: "0 9 * * *" });
  assert.equal(next(), "2026-11-08T09:00:00.000Z");
  assert.equal(scheduleEvents(f.hub).length, 0, "reenabling does not replay occurrences while the rule was disabled");
  await configure(f.hub, f.dataDir, { timezone: "UTC", cron: "15 11 * * *" });
  assert.equal(next(), "2026-11-07T11:15:00.000Z");
});

test("answer and later preserve chain hops, emitted hops cannot reset, and unauthorized emits have no effect", async (t) => {
  const f = await fixture(t);
  const rules = { ...defaultRules(), rules: [{ name: "rule-hop", cwd: f.dataDir, to: "pi", prompt: "Continue the fixture chain.",
    when: { source: "desktop", types: ["flow.*"] }, emits: { source: "desktop", types: ["flow.*"] } }] };
  await http(f.hub, "/v1/rules", { method: "PUT", body: rules });
  await http(f.hub, "/v1/events", { key: f.hub.descriptor.sourceKey, method: "POST", body: { id: "seed-hop-7", type: "flow.start", subject: "same-subject", hops: 7 } });
  const initial = (await claim(f.hub, "hop-initial")).job;
  await result(f.hub, initial, { outcome: "done", session: "hop-session", summary: "Waiting for a choice", ask: [{ key: "choice", title: "Continue?", text: "Choose", options: ["Yes", "No"] }] });
  const card = (await http(f.hub, "/v1/state")).cards.find((item) => item.kind === "ask");
  await http(f.hub, `/v1/cards/${card.id}/answer`, { method: "POST", body: { choice: 0, expectedVersion: card.version } });
  const answered = (await claim(f.hub, "hop-answer")).job;
  assert.equal(answered.context.events.find((event) => event.type === "card.answered").hops, 7);
  assert.equal(answered.session, "hop-session");
  await result(f.hub, answered, { outcome: "done", session: "hop-session", summary: "Review later", later: [{ key: "review", at: new Date(f.clock.now + 60_000).toISOString(), about: "Check the same chain" }] });
  assert.equal(f.hub.runtime.db.prepare("SELECT json_extract(data,'$.hops') AS hops FROM projections WHERE collection='timers' AND json_extract(data,'$.key')='review'").get().hops, 7);
  f.clock.now += 61_000;
  f.hub.runtime.execute("tick", []);
  const timed = (await claim(f.hub, "hop-timer")).job;
  assert.equal(timed.context.events.find((event) => event.type === "timer.due").hops, 7);
  assert.equal(timed.session, "hop-session");
  const accepted = await result(f.hub, timed, { outcome: "done", session: "hop-session", summary: "Emit one child", events: [
    { id: "child-hop-8", type: "flow.next", hops: 0 }, { id: "unauthorized", type: "forbidden.type", hops: 0 },
  ] });
  assert.equal(accepted.rejected.length, 1);
  assert.match(accepted.rejected[0].reason, /forbidden\.type/);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM events WHERE key='unauthorized'").get().n, 0);
  const eighth = (await claim(f.hub, "hop-eight")).job;
  assert.equal(eighth.context.events.find((event) => event.id === "child-hop-8").hops, 8);
  await result(f.hub, eighth, { outcome: "done", summary: "Exceed the hop limit", events: [{ id: "child-hop-9", type: "flow.next", hops: 0 }] });
  const blocked = f.hub.runtime.db.prepare("SELECT json_extract(data,'$.hops') AS hops,json_extract(data,'$.routed') AS routed FROM projections WHERE collection='events' AND json_extract(data,'$.key')='child-hop-9'").get();
  assert.equal(blocked.hops, 9);
  assert.deepEqual(JSON.parse(blocked.routed), []);
  assert.equal((await claim(f.hub, "hop-blocked")).job, null);
  assert.ok((await http(f.hub, "/v1/state")).cards.some((item) => item.title === "事件循环已停止"));
});
