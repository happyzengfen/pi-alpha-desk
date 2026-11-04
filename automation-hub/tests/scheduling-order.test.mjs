import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHub } from "../host/main.ts";
import { defaultRules } from "../host/runtime.ts";

const MINUTE = 60_000;

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200 } = {}) {
  const response = await fetch(hub.descriptor.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-order-"));
  const clock = { now: Date.parse("2026-11-04T00:00:00Z") };
  let hub = await startHub({ dataDir, now: () => clock.now });
  let serial = 0;
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const config = { version: 1, timezone: "UTC", rules: [{ id: "rule-order", name: "Ordering fixture", cwd: dataDir,
    enabled: true, trigger: { kind: "manual" }, prompt: "Return the fixture result." }] };
  const save = (enabled) => http(hub, "/v1/desktop/config", { method: "PUT", body: {
    config: { ...config, rules: [{ ...config.rules[0], enabled }] },
    rules: { ...defaultRules("UTC"), rules: enabled ? [{ name: "rule-order", cwd: dataDir, to: "pi", prompt: config.rules[0].prompt,
      when: { source: "desktop", types: ["desktop.run.rule-order"] } }] : [] },
  } });
  const next = async () => (await http(hub, `/v1/work?claim=order-${++serial}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey })).job;
  await save(true);
  return {
    clock, next, save,
    get hub() { return hub; },
    async restart() { await hub.close(); hub = await startHub({ dataDir, now: () => clock.now }); },
    async seed() {
      await http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-order", eventId: `event-${++serial}` } });
      return next();
    },
    finish: (job, body) => http(hub, `/v1/runs/${job.run}/result`, { method: "POST", key: job.token, body }),
    cancel: () => http(hub, "/v1/desktop/cancel", { method: "POST", body: { ruleId: "rule-order" } }),
    answer: (card) => http(hub, `/v1/cards/${card.id}/answer`, { method: "POST", body: { choice: 0 } }),
    tick(at) { clock.now = at; hub.runtime.execute("tick", []); },
    rows(table) { return hub.runtime.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row })); },
  };
}

for (const cancelled of [false, true]) {
  test(`an unexpired later key ${cancelled ? "can be cancelled after rescheduling" : "is rescheduled in place and fires once"} across restart`, async (t) => {
    const f = await fixture(t);
    const firstAt = f.clock.now + 10 * MINUTE;
    const changedAt = f.clock.now + 20 * MINUTE;
    await f.finish(await f.seed(), { outcome: "done", session: "first-session", summary: "First reservation", later: [{ key: "review", at: new Date(firstAt).toISOString(), about: "Original review" }] });
    const original = f.rows("timers")[0];
    f.clock.now += MINUTE;
    await f.finish(await f.seed(), { outcome: "done", session: "updated-session", summary: "Move review", later: [{ key: "review", at: new Date(changedAt).toISOString(), about: "Changed review" }] });
    const updated = f.rows("timers");
    assert.equal(updated.length, 1);
    assert.equal(updated[0].id, original.id);
    assert.equal(updated[0].at, new Date(changedAt).toISOString());
    assert.equal(updated[0].session, "updated-session");
    if (cancelled) {
      await f.finish(await f.seed(), { outcome: "done", summary: "Cancel only this review", later: [{ key: "review", cancel: true }] });
      assert.equal(f.rows("timers").length, 0);
    }
    await f.restart();
    f.tick(firstAt);
    assert.equal(await f.next(), null, "the obsolete deadline must not enqueue work");
    f.tick(changedAt);
    const due = await f.next();
    if (cancelled) assert.equal(due, null);
    else {
      assert.ok(due);
      assert.equal(due.session, "updated-session");
      assert.equal(due.context.timers[0].about, "Changed review");
      await f.finish(due, { outcome: "done", summary: "Review completed" });
    }
    await f.restart();
    f.tick(changedAt + 24 * 60 * MINUTE);
    assert.equal(await f.next(), null);
    const events = f.rows("events").filter((event) => event.type === "timer.due");
    assert.equal(events.length, cancelled ? 0 : 1, "restart and repeated ticks cannot refire a reservation");
  });
}

for (const source of ["timer", "answer"]) {
  for (const cancelFirst of [true, false]) {
    test(`cancel ${cancelFirst ? "before" : "after"} ${source} enqueue fences old continuations through a new generation and restart`, async (t) => {
      const f = await fixture(t);
      const seed = await f.seed();
      const dueAt = f.clock.now + MINUTE;
      await f.finish(seed, { outcome: "done", session: "old-session", summary: "Wait for a decision and timer",
        ask: [{ key: "choice", title: "Old choice", text: "Continue?", options: ["Yes", "No"] }],
        later: [{ key: "review", at: new Date(dueAt).toISOString(), about: "Old generation review" }],
      });
      const card = f.rows("cards").find((item) => item.kind === "ask");
      const oldGeneration = f.hub.runtime.getView().get("runs", seed.run).desktop_generation;
      const deliver = () => source === "timer" ? f.tick(dueAt) : f.answer(card);
      if (cancelFirst) await f.cancel();
      const outcome = await deliver();
      if (source === "answer") assert.equal(outcome.changed, !cancelFirst);
      if (!cancelFirst) {
        assert.equal(f.rows("runs").filter((run) => run.state === "queued").length, 1, "the first arrival really enqueues a continuation");
        await f.cancel();
      }
      assert.equal(f.rows("runs").filter((run) => run.state === "queued").length, 0);
      assert.equal(await f.next(), null);
      assert.equal(f.rows("timers").filter((timer) => timer.event_id === null).length, 0);
      const historicalRunCount = f.rows("runs").length;
      await f.save(false);
      await f.save(true);
      await f.restart();
      const fresh = await f.seed();
      assert.ok(f.hub.runtime.getView().get("runs", fresh.run).desktop_generation > oldGeneration);
      assert.equal(fresh.session, null);
      assert.equal(fresh.context.answers.length, 0, "the cancelled answer cannot leak into new work");
      await f.finish(fresh, { outcome: "done", summary: "New generation completed" });
      assert.equal((await f.answer(card)).changed, false);
      f.tick(dueAt + 60 * MINUTE);
      await f.restart();
      assert.equal(await f.next(), null);
      assert.equal(f.rows("runs").length, historicalRunCount + 1);
      assert.equal(f.rows("runs").find((run) => run.id === seed.run).state, "done", "cancelling follow-ups preserves the completed business history");
      assert.ok(f.rows("runs").filter((run) => run.id !== seed.run && run.id !== fresh.run).every((run) => run.state === "cancelled"));
    });
  }
}

test("real failed receipts retry at 5/10/20/40/60 minute backoff and stop after the tenth failure", async (t) => {
  const f = await fixture(t);
  let job = await f.seed();
  const runId = job.run;
  const expectedMinutes = [5, 10, 20, 40, 60, 60, 60, 60, 60];
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    assert.equal(job.run, runId);
    const failedAt = f.clock.now;
    const receipt = { outcome: "failed", error: `Fixture failure ${attempt}`, summary: "No business effect" };
    await f.finish(job, receipt);
    assert.equal((await f.finish(job, receipt)).duplicate, true);
    const run = f.rows("runs").find((item) => item.id === runId);
    assert.equal(run.attempts, attempt);
    assert.equal((await http(f.hub, "/v1/desktop/status")).owner, null);
    if (attempt === 10) {
      assert.equal(run.state, "cancelled");
      assert.match(run.summary, /10/);
      assert.ok(f.rows("cards").some((card) => card.key === `run:${runId}:stopped`));
      break;
    }
    const dueAt = failedAt + expectedMinutes[attempt - 1] * MINUTE;
    assert.equal(run.state, "queued");
    assert.equal(Date.parse(run.not_before), dueAt);
    f.tick(dueAt - 1);
    assert.equal(await f.next(), null, `attempt ${attempt + 1} cannot start early`);
    if (attempt === 4) await f.restart();
    f.tick(dueAt);
    job = await f.next();
    assert.ok(job, `attempt ${attempt + 1} becomes claimable exactly at its deadline`);
  }
  await f.restart();
  f.tick(f.clock.now + 7 * 24 * 60 * MINUTE);
  assert.equal(await f.next(), null);
  assert.equal(f.rows("runs").length, 1);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE json_extract(fact,'$.type')='finish'").get().n, 10);
});
