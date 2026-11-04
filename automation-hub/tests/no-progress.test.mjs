import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return { ...defaultRules(config.timezone), rules: config.rules.filter((rule) => rule.enabled).map((rule) => ({ name: rule.id, cwd: rule.cwd, to: "pi", prompt: rule.prompt,
    when: rule.trigger.kind === "cron" ? { cron: rule.trigger.cron } : { source: "desktop", types: [`desktop.run.${rule.id}`] } })) };
}

async function fixture(t, trigger = { kind: "manual" }) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-progress-"));
  const clock = { now: Date.parse("2026-11-04T00:00:01Z") };
  let hub = await startHub({ dataDir, now: () => clock.now });
  let claim = 0;
  const config = { version: 1, timezone: "UTC", rules: [{ id: "rule-progress", name: "Progress fixture", cwd: dataDir, enabled: true, trigger, prompt: "Report the current state." }] };
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules: compiled(config) } });
  const finish = (job, receipt) => http(hub, `/v1/runs/${job.run}/result`, { method: "POST", key: job.token, body: receipt });
  return {
    clock, config,
    get hub() { return hub; },
    async restart() { await hub.close(); hub = await startHub({ dataDir, now: () => clock.now }); },
    finish,
    async next() { return (await http(hub, `/v1/work?claim=progress-${++claim}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey })).job; },
    async seed() {
      await http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-progress", eventId: `seed-${claim}` } });
      return this.next();
    },
    later(summary = "Still waiting", outcome = "done") {
      return { outcome, summary, session: "progress-session", later: [{ key: "review", about: "Check the same condition", at: new Date(clock.now + 60_000).toISOString() }] };
    },
    async due() {
      clock.now += 60_000;
      hub.runtime.execute("tick", []);
      return this.next();
    },
    record() { return hub.runtime.getView().get("config", "desktop-no-progress")?.value?.["rule-progress"]; },
    async enabled() { return (await http(hub, "/v1/desktop/config")).config.rules[0].enabled; },
    async notices() { return (await http(hub, "/v1/state")).cards.filter((card) => card.title === "Automation follow-ups need review"); },
  };
}

test("three unchanged timer follow-ups disable atomically, cancel their next timer and issue one notice", async (t) => {
  const f = await fixture(t);
  await f.finish(await f.seed(), f.later());
  assert.equal(f.record().count, 0, "the initial manual run does not count as a timer follow-up");
  for (let round = 1; round <= 2; round += 1) {
    const job = await f.due();
    assert.ok(job.context.events.every((event) => event.type === "timer.due"));
    const receipt = f.later();
    await f.finish(job, receipt);
    assert.equal(f.record().count, round);
    assert.equal((await f.finish(job, receipt)).duplicate, true);
    assert.equal(f.record().count, round, "duplicate receipts do not increment the sequence");
  }
  const third = await f.due();
  const receipt = f.later();
  await f.finish(third, receipt);
  assert.equal(await f.enabled(), false);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM timers WHERE event_id IS NULL").get().n, 0);
  assert.equal((await f.notices()).length, 1);
  assert.equal((await f.finish(third, receipt)).duplicate, true);
  assert.equal((await f.notices()).length, 1);
  f.clock.now += 3600_000;
  f.hub.runtime.execute("tick", []);
  assert.equal(await f.next(), null);
});

test("a changed summary resets the narrow signature sequence", async (t) => {
  const f = await fixture(t);
  await f.finish(await f.seed(), f.later());
  for (let index = 1; index <= 5; index += 1) {
    await f.finish(await f.due(), f.later(`Observed state ${index}`));
    assert.equal(f.record().count, 1);
  }
  assert.equal(await f.enabled(), true);
  assert.equal((await f.notices()).length, 0);
});

test("a cron event mixed into a due follow-up resets the sequence", async (t) => {
  const f = await fixture(t, { kind: "cron", cron: "0 * * * *" });
  await f.finish(await f.seed(), f.later());
  await f.finish(await f.due(), f.later());
  await f.finish(await f.due(), f.later());
  assert.equal(f.record().count, 2);
  f.clock.now = Date.parse("2026-11-04T01:00:00Z");
  f.hub.runtime.execute("tick", []);
  const mixed = await f.next();
  assert.ok(mixed.context.events.some((event) => event.type === "schedule.tick"));
  await f.finish(mixed, f.later());
  assert.equal(f.record().count, 0);
  await f.finish(await f.due(), f.later());
  assert.equal(f.record().count, 1);
  assert.equal(await f.enabled(), true);
  assert.equal((await f.notices()).length, 0);
});

test("asking and receiving a user answer reset the sequence without a false halt", async (t) => {
  const f = await fixture(t);
  await f.finish(await f.seed(), f.later());
  await f.finish(await f.due(), f.later());
  const question = await f.due();
  await f.finish(question, { outcome: "done", summary: "Need your decision", session: "progress-session", ask: [{ key: "decision", title: "Continue?", text: "Choose", options: ["Yes", "No"] }] });
  assert.equal(f.record().count, 0);
  const card = (await http(f.hub, "/v1/state")).cards.find((item) => item.kind === "ask");
  await http(f.hub, `/v1/cards/${card.id}/answer`, { method: "POST", body: { choice: 0, expectedVersion: card.version } });
  const answered = await f.next();
  assert.ok(answered.context.events.some((event) => event.type === "card.answered"));
  await f.finish(answered, f.later());
  assert.equal(f.record().count, 0);
  await f.finish(await f.due(), f.later());
  await f.finish(await f.due(), f.later());
  assert.equal(f.record().count, 2);
  assert.equal(await f.enabled(), true);
  assert.equal((await f.notices()).length, 0);
});

test("rebuild/restart preserves the sequence, while reenabling starts a new generation", async (t) => {
  const f = await fixture(t);
  await f.finish(await f.seed(), f.later());
  await f.finish(await f.due(), f.later());
  const second = await f.due();
  const secondReceipt = f.later();
  await f.finish(second, secondReceipt);
  const before = structuredClone(f.record());
  f.hub.runtime.db.exec("UPDATE projection_meta SET format='rebuild-no-progress-fixture'");
  await f.restart();
  assert.deepEqual(f.record(), before);
  assert.equal((await f.finish(second, secondReceipt)).duplicate, true);
  assert.equal(f.record().count, 2);
  await f.finish(await f.due(), f.later());
  assert.equal(await f.enabled(), false);
  const haltedGeneration = f.record().generation;
  await http(f.hub, "/v1/desktop/config", { method: "PUT", body: { config: f.config, rules: compiled(f.config) } });
  assert.equal(await f.enabled(), true);
  assert.ok(f.record().generation > haltedGeneration);
  assert.equal(f.record().count, 0);
  assert.equal(f.record().signature, null);
  await f.finish(await f.seed(), f.later());
  await f.finish(await f.due(), f.later());
  assert.equal(f.record().count, 1);
  assert.equal(await f.enabled(), true);
});
