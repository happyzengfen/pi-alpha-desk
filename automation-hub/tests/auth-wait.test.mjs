import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHub } from "../host/main.ts";
import { defaultRules } from "../host/runtime.ts";

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200 } = {}) {
  const response = await fetch(hub.descriptor.url + path, { method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function fixture(t, { cron = false, parallel = false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-auth-wait-"));
  const clock = { now: Date.parse("2026-11-04T00:00:01Z") };
  let hub = await startHub({ dataDir, now: () => clock.now });
  let serial = 0;
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const config = { version: 1, timezone: "UTC", rules: ["main", "healthy"].map((id) => ({
    id: `rule-${id}`, name: `Auth fixture ${id}`, cwd: dataDir, prompt: "Return the fixture result.", enabled: true,
    trigger: id === "main" && cron ? { kind: "cron", cron: "* * * * *" } : { kind: "manual" },
  })) };
  const save = () => http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules: {
    ...defaultRules("UTC"), rules: config.rules.filter((rule) => rule.enabled).map((rule) => ({
      name: rule.id, cwd: dataDir, to: "pi", prompt: rule.prompt,
      when: rule.trigger.kind === "cron" ? { cron: rule.trigger.cron } : { source: "desktop", types: [parallel && rule.id === "rule-main" ? "lane.event" : `desktop.run.${rule.id}`] },
      ...(parallel && rule.id === "rule-main" && { parallel: 2 }),
    })),
  } } });
  await save();
  return {
    clock, config, save,
    get hub() { return hub; },
    async restart(rebuild = false) {
      if (rebuild) hub.runtime.db.exec("UPDATE projection_meta SET format='auth-wait-rebuild'");
      await hub.close(); hub = await startHub({ dataDir, now: () => clock.now });
    },
    trigger: (id, eventId) => http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: `rule-${id}`, eventId } }),
    event: (id, subject) => http(hub, "/v1/events", { key: hub.descriptor.sourceKey, method: "POST", body: { id, type: "lane.event", subject } }),
    next: async (claim = `auth-wait-${++serial}`) => (await http(hub, `/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey })).job,
    finish: (job, body) => http(hub, `/v1/runs/${job.run}/result`, { key: job.token, method: "POST", body }),
    answer: (card, choice, expectedVersion = card.version, status = 200) => http(hub, `/v1/cards/${card.id}/answer`, { method: "POST", body: { choice, ...(expectedVersion !== null && { expectedVersion }) }, status }),
    async authCard() { return (await http(hub, "/v1/state")).cards.find((card) => card.title === "Restore model authentication"); },
    queued() { return hub.runtime.db.prepare("SELECT * FROM runs WHERE state='queued' ORDER BY id").all().map((row) => ({ ...row })); },
    linked(run) { return hub.runtime.db.prepare("SELECT e.* FROM run_events l JOIN events e ON e.id=l.event_id WHERE l.run_id=? ORDER BY e.id").all(run).map((row) => ({ ...row })); },
  };
}

const authentication = (session, later) => ({ outcome: "done", session, summary: "Authentication needs attention",
  ask: [{ key: "desktop-auth:fixture-provider", title: "Restore model authentication", text: "Restore the configured credentials, then choose.", options: ["Authentication restored", "Pause this task"] }],
  ...(later && { later }),
});

test("authentication wait retains manual and cron events through restart/rebuild, permits healthy rules, and resumes once with accumulated events", async (t) => {
  const f = await fixture(t, { cron: true });
  await f.trigger("main", "initial-auth");
  await f.finish(await f.next(), authentication("auth-original-session"));
  await f.trigger("main", "waiting-a");
  await f.trigger("main", "waiting-b");
  assert.equal((await f.trigger("main", "waiting-b")).duplicate, true);
  f.clock.now = Date.parse("2026-11-04T00:01:00Z");
  f.hub.runtime.execute("tick", []);
  const queued = f.queued();
  assert.equal(queued.length, 1);
  const accumulated = f.linked(queued[0].id);
  assert.equal(accumulated.length, 3);
  assert.equal(accumulated.filter((event) => event.type === "schedule.tick").length, 1);
  assert.equal(await f.next(), null);
  await f.restart(true);
  assert.deepEqual(f.queued(), queued);
  assert.deepEqual(f.linked(queued[0].id), accumulated, "no event is consumed or rewritten while awaiting authentication");
  assert.equal(await f.next(), null);
  await f.trigger("healthy", "healthy-during-auth-wait");
  const healthy = await f.next();
  assert.equal(healthy.rule.name, "rule-healthy");
  await f.finish(healthy, { outcome: "done", summary: "Other rule remains usable" });
  assert.equal(await f.next(), null);
  const card = await f.authCard();
  await f.answer(card, 0);
  const resumed = await f.next();
  assert.equal(resumed.rule.name, "rule-main");
  assert.equal(resumed.session, "auth-original-session");
  assert.deepEqual(resumed.context.events.map((event) => event.id), [...accumulated.map((event) => event.key), `card:${card.id}`]);
  assert.equal(resumed.context.answers.length, 1);
  assert.equal(resumed.context.answers[0].choice, 0);
  await f.finish(resumed, { outcome: "done", summary: "Accumulated events completed" });
  await f.restart(true);
  assert.equal(await f.next(), null);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE rule='rule-main' AND state='done'").get().n, 2);
});

test("Pause authentication answer disables atomically before an already queued event can be claimed and fences old timers", async (t) => {
  const f = await fixture(t);
  await f.trigger("main", "initial-auth");
  await f.finish(await f.next(), authentication("paused-auth-session", [{ key: "old-review", at: new Date(f.clock.now + 60_000).toISOString(), about: "Do not revive after pause" }]));
  await f.trigger("main", "queued-before-pause-answer");
  const pending = f.queued()[0];
  const originalEvents = f.linked(pending.id);
  assert.equal(await f.next(), null);
  const card = await f.authCard();
  await f.answer(card, 1, card.version + 1, 409);
  assert.equal((await http(f.hub, "/v1/desktop/config")).config.rules[0].enabled, true);
  const before = f.hub.runtime.db.prepare("SELECT MAX(seq) AS seq FROM facts").get().seq;
  assert.deepEqual(await f.answer(card, 1), { changed: true, state: "closed" });
  const facts = f.hub.runtime.db.prepare("SELECT fact FROM facts WHERE seq>?").all(before).map((row) => JSON.parse(row.fact));
  assert.equal(facts.length, 1, "answer, generation fence and queue cancellation commit as one durable fact");
  assert.equal(facts[0].type, "answer");
  assert.ok(facts[0].changes.some((change) => change.table === "config" && change.key === "desktop-generations"));
  assert.ok(facts[0].changes.some((change) => change.table === "runs" && change.row?.state === "cancelled"));
  assert.equal((await http(f.hub, "/v1/desktop/config")).config.rules[0].enabled, false);
  assert.equal(f.queued().length, 0);
  assert.deepEqual(f.linked(pending.id).slice(0, originalEvents.length), originalEvents);
  assert.equal(await f.next(), null);
  assert.equal((await f.answer(card, 1, null)).changed, false);
  await f.restart(true);
  await f.save();
  assert.equal((await f.answer(card, 0, null)).changed, false);
  f.clock.now += 120_000;
  f.hub.runtime.execute("tick", []);
  assert.equal(await f.next(), null, "re-enabling does not rearm the old timer or answer");
  await f.trigger("healthy", "healthy-after-auth-pause");
  const healthy = await f.next();
  assert.equal(healthy.rule.name, "rule-healthy");
  await f.finish(healthy, { outcome: "done", summary: "Unrelated rule still enabled" });
});

test("the authentication gate is scoped to the exact rule/thread and normal asks do not block claims", async (t) => {
  const f = await fixture(t, { parallel: true });
  await f.event("lane-a-initial", "lane-a");
  await f.finish(await f.next(), authentication("lane-a-session"));
  await f.event("lane-a-waiting", "lane-a");
  await f.event("lane-b-initial", "lane-b");
  const otherLane = await f.next();
  assert.equal(otherLane.context.events[0].subject, "lane-b");
  await f.finish(otherLane, { outcome: "done", session: "lane-b-session", summary: "Normal business question",
    ask: [{ key: "normal-business-question", title: "Restore model authentication", text: "A normal question with the same label", options: ["Authentication restored", "Pause this task"] }],
  });
  await f.event("lane-b-while-normal-ask", "lane-b");
  const normal = await f.next();
  assert.equal(normal.context.events[0].id, "lane-b-while-normal-ask");
  await f.finish(normal, { outcome: "done", summary: "Normal ask does not add an authentication barrier" });
  const normalCard = (await http(f.hub, "/v1/state")).cards.find((item) => item.text.startsWith("A normal question"));
  await f.answer(normalCard, 1);
  const businessAnswer = await f.next();
  assert.equal(businessAnswer.session, "lane-b-session");
  assert.equal(businessAnswer.context.answers[0].choice, 1);
  assert.equal((await http(f.hub, "/v1/desktop/config")).config.rules[0].enabled, true, "matching labels do not make an ordinary question an authentication pause");
  await f.finish(businessAnswer, { outcome: "done", summary: "Normal business answer completed" });
  assert.equal(await f.next(), null);
  const card = (await http(f.hub, "/v1/state")).cards.find((item) => item.rule === "rule-main" && item.text.startsWith("Restore the configured"));
  await f.answer(card, 0);
  const resumed = await f.next();
  assert.equal(resumed.session, "lane-a-session");
  assert.deepEqual(resumed.context.events.map((event) => event.id), ["lane-a-waiting", `card:${card.id}`]);
  await f.finish(resumed, { outcome: "done", summary: "Only lane A resumed" });
  assert.equal(await f.next(), null);
});
