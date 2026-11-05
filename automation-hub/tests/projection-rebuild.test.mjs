import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHub } from "../host/main.ts";
import { defaultRules } from "../host/runtime.ts";
import { digest } from "../upstream/kernel/credentials.ts";
import { TABLES } from "../upstream/kernel/evolve.ts";

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200 } = {}) {
  const response = await fetch(hub.descriptor.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function databaseSnapshot(db) {
  const read = (name) => db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map((row) => canonical(Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, ["data", "next"].includes(key) && typeof value === "string" ? JSON.parse(value) : value]),
  ))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const names = (type) => db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type).map((row) => row.name);
  const tables = Object.fromEntries(names("table").filter((name) => name !== "facts").map((name) => [name, read(name)]));
  const views = Object.fromEntries(names("view").map((name) => [name, read(name)]));
  // The immutable log is compared byte for byte, independently of normalization.
  const facts = db.prepare("SELECT seq,fact FROM facts ORDER BY seq").all().map((row) => ({ ...row }));
  return { tables, views, facts };
}

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-projection-"));
  const clock = { now: Date.parse("2026-11-04T00:00:00Z") };
  const hub = await startHub({ dataDir, now: () => clock.now });
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const config = { version: 1, timezone: "UTC", rules: ["main", "retry", "cancel", "unknown", "cron"].map((id) => ({
    id: `rule-${id}`, name: `Projection ${id}`, cwd: dataDir, enabled: true, prompt: `Report ${id}`,
    trigger: id === "cron" ? { kind: "cron", cron: "0 9 * * *" } : { kind: "manual" },
  })) };
  const save = () => http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules: {
    ...defaultRules("UTC"), channels: { fixture: { name: "Projection fixture" } },
    rules: config.rules.map((rule) => ({ name: rule.id, cwd: dataDir, to: "pi", prompt: rule.prompt,
      when: rule.trigger.kind === "cron" ? { cron: rule.trigger.cron } : { source: "desktop", types: [`desktop.run.${rule.id}`] },
    })),
  } } });
  await save();
  const channelKey = "fixture-channel-key-for-projection-rebuild";
  hub.runtime.execute("key", ["channel", "fixture", digest(channelKey)]);
  let serial = 0;
  const next = async () => (await http(hub, `/v1/work?claim=projection-${++serial}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey })).job;
  const seed = async (id) => {
    await http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: `rule-${id}`, eventId: `projection-${id}-${++serial}` } });
    return next();
  };
  const finish = (job, body) => http(hub, `/v1/runs/${job.run}/result`, { method: "POST", key: job.token, body });
  return { hub, clock, config, save, channelKey, next, seed, finish };
}

async function rebuildAndCompare(f, heldRun, phase) {
  const { hub } = f;
  const beforeState = await http(hub, "/v1/state");
  const beforeStatus = await http(hub, "/v1/desktop/status");
  const beforeWhy = await http(hub, `/v1/runs/${heldRun}/why`);
  const before = databaseSnapshot(hub.runtime.db);
  assert.deepEqual(Object.keys(before.tables), ["projection_meta", "projection_pending", "projection_refs", "projections"]);
  assert.ok(before.tables.projection_pending.length > 0, "a delivered card's newer version needs a persisted update");
  assert.ok(before.tables.projection_refs.length > 0);
  assert.ok(before.facts.length > 30);
  const represented = new Set(before.tables.projections.map((row) => row.collection));
  for (const table of TABLES) assert.ok(represented.has(table), `${phase}: ${table} must contain real fixture state`);
  // Simulate discarded/corrupted derived state. Changing the format makes the
  // actual runtime open path rebuild every projection exclusively from facts.
  hub.runtime.db.exec("DELETE FROM projections; DELETE FROM projection_refs; DELETE FROM projection_pending; UPDATE projection_meta SET format='fixture-full-rebuild',next='{}',seq=0");
  assert.equal(hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM projections").get().n, 0);
  hub.runtime.getView();
  const after = databaseSnapshot(hub.runtime.db);
  assert.deepEqual(after, before, `${phase}: all projection tables, SQL views and immutable facts are equivalent`);
  assert.deepEqual(await http(hub, "/v1/state"), beforeState);
  assert.deepEqual(await http(hub, "/v1/desktop/status"), beforeStatus);
  assert.deepEqual(await http(hub, `/v1/runs/${heldRun}/why`), beforeWhy);
}

test("full log rebuild restores every populated projection table and SQL view for claimed and unknown multi-state histories", async (t) => {
  const f = await fixture(t);
  const initial = await f.seed("main");
  await f.finish(initial, { outcome: "done", session: "projection-session", summary: "Initial business done", usage: { input: 100, output: 25, cost: 0.1 },
    ask: [
      { key: "completed", title: "Complete this choice", text: "Choose once", options: ["One", "Two"] },
      { key: "decided", title: "Keep this answer queued", text: "Choose next", options: ["One", "Two"] },
    ],
    notice: [{ key: "resolved", title: "Resolve this notice", text: "Review the result" }],
    later: [{ key: "review", at: new Date(f.clock.now + 3600_000).toISOString(), about: "Pending review" }],
  });
  const delivered = (await http(f.hub, "/v1/cards/next?wait=0", { key: f.channelKey })).card;
  assert.equal(delivered.title, "Complete this choice");
  await http(f.hub, `/v1/cards/${delivered.id}/delivered`, { key: f.channelKey, method: "POST", body: { version: delivered.version, ref: "fixture-message-ref" } });
  await http(f.hub, `/v1/cards/${delivered.id}/answer`, { method: "POST", body: { choice: 0, expectedVersion: delivered.version } });
  const continuation = await f.next();
  assert.equal(continuation.session, "projection-session");
  await f.finish(continuation, { outcome: "done", summary: "Answer completed", usage: { input: 20, output: 10, cost: 0.02 },
    notice: [{ key: "open", title: "Open notice", text: "Still needs review" }],
  });
  const state = await http(f.hub, "/v1/state");
  const resolved = state.cards.find((card) => card.title === "Resolve this notice");
  await http(f.hub, `/v1/cards/${resolved.id}/resolve`, { method: "POST", body: { reason: "Verified by fixture", expectedVersion: resolved.version } });
  const pendingUpdate = (await http(f.hub, "/v1/cards/next?wait=0", { key: f.channelKey })).card;
  assert.equal(pendingUpdate.id, delivered.id, "the closed card first needs its delivered message updated");
  const pendingAnswer = (await http(f.hub, "/v1/cards/next?wait=0", { key: f.channelKey })).card;
  assert.equal(pendingAnswer.title, "Keep this answer queued");
  await http(f.hub, `/v1/cards/${pendingAnswer.id}/failed`, { key: f.channelKey, method: "POST", body: { version: pendingAnswer.version, error: "Fixture delivery unavailable" } });
  const retry = await f.seed("retry");
  await f.finish(retry, { outcome: "failed", error: "Fixture retry pending" });
  await f.finish(await f.seed("main"), { outcome: "nothing", summary: "No change" });
  await http(f.hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-cancel", eventId: "cancel-before-claim" } });
  await http(f.hub, "/v1/desktop/cancel", { method: "POST", body: { ruleId: "rule-cancel" } });
  await http(f.hub, "/v1/events", { key: f.hub.descriptor.sourceKey, method: "POST", body: { id: "unrouted-event", type: "unmatched.type", subject: "retained-history" } });
  const held = await f.seed("unknown");
  await http(f.hub, `/v1/runs/${held.run}/started`, { key: held.token, method: "POST", body: { session: "held-original-session", link: "fixture://held-session" } });
  await http(f.hub, `/v1/cards/${pendingAnswer.id}/answer`, { method: "POST", body: { choice: 1, expectedVersion: pendingAnswer.version } });
  f.config.rules.find((rule) => rule.id === "rule-unknown").prompt = "New configuration saved after claim";
  await f.save();
  const runStates = new Set(f.hub.runtime.db.prepare("SELECT state FROM runs").all().map((run) => run.state));
  for (const state of ["done", "nothing", "queued", "cancelled", "claimed"]) assert.ok(runStates.has(state), state);
  const cardStates = new Set(f.hub.runtime.db.prepare("SELECT state FROM cards").all().map((card) => card.state));
  for (const state of ["open", "decided", "done", "closed"]) assert.ok(cardStates.has(state), state);
  assert.equal(f.hub.runtime.desktopStatus().owner.desktopRule.prompt, "Report unknown", "the owner keeps the claimed policy across configuration edits");
  await rebuildAndCompare(f, held.run, "claimed");
  f.clock.now += 301_000;
  f.hub.runtime.execute("heartbeat", ["pi-desktop", []]);
  f.hub.runtime.execute("sweep", []);
  assert.equal(f.hub.runtime.getView().get("runs", held.run).state, "unknown");
  await rebuildAndCompare(f, held.run, "unknown");
  assert.equal((await f.next()), null, "unknown ownership still blocks a new claim after complete rebuild");
  await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: { run: held.run, confirmedStopped: true } });
  assert.equal(f.hub.runtime.desktopStatus().owner, null);
});
