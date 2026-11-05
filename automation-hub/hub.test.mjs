import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startHub } from "./host/main.ts";
import { defaultRules } from "./host/runtime.ts";
import { parseRules } from "./upstream/protocol/rules.ts";

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-automation-hub-"));
  const clock = { now: Date.now() };
  let hub = await startHub({ dataDir, now: () => clock.now });
  t.after(async () => { await hub.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, clock,
    get hub() { return hub; },
    async restart() { await hub.close(); hub = await startHub({ dataDir, now: () => clock.now }); return hub; },
  };
}

async function http(hub, path, { key = hub.descriptor.ownerKey, method = "GET", body, status = 200, headers = {} } = {}) {
  const response = await fetch(hub.descriptor.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

function desktopConfig(cwd, extra = {}) {
  return { version: 1, timezone: "Asia/Shanghai", rules: [{ id: "rule-test", name: "Test", cwd, prompt: "Read the task and report.", enabled: true, trigger: { kind: "manual" }, ...extra }] };
}

function compiled(config) {
  return { ...defaultRules(config.timezone), rules: config.rules.filter((rule) => rule.enabled).map((rule) => ({
    name: rule.id, cwd: rule.cwd, to: "pi", prompt: rule.prompt,
    when: rule.trigger.kind === "cron" ? { cron: rule.trigger.cron } : { source: "desktop", types: [`desktop.run.${rule.id}`] },
    emits: { source: "desktop", types: ["desktop.child"] },
  })) };
}

const saveConfig = (hub, config) => http(hub, "/v1/desktop/config", { method: "PUT", body: { config, rules: compiled(config) } });
const trigger = (hub, eventId = "test-event") => http(hub, "/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-test", eventId } });
const work = (hub, claim = "test-claim") => http(hub, `/v1/work?claim=${claim}&wait=0&running=&capacity=1`, { key: hub.descriptor.workerKey });
const finish = (hub, job, body, status) => http(hub, `/v1/runs/${job.run}/result`, { key: job.token, method: "POST", body, status });

test("private descriptor, owner authentication and invalid config preserve durable rules", async (t) => {
  const f = await fixture(t);
  const { descriptor } = f.hub;
  const health = await http(f.hub, "/healthz", { key: "" });
  assert.equal(health.instanceId, descriptor.instanceId);
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, "descriptor.json"), "utf8")).ownerKey, descriptor.ownerKey);
  if (process.platform !== "win32") assert.equal(statSync(join(f.dataDir, "descriptor.json")).mode & 0o777, 0o600);
  await http(f.hub, "/v1/state", { key: descriptor.sourceKey, status: 401 });
  await http(f.hub, "/healthz", { headers: { origin: "https://example.com" }, status: 403 });
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  await http(f.hub, "/v1/desktop/config", { method: "PUT", body: { config: desktopConfig(f.dataDir), rules: {} }, status: 400 });
  assert.equal((await http(f.hub, "/v1/desktop/config")).config.rules.length, 1);
  await assert.rejects(startHub({ dataDir: f.dataDir }), /already owns/);
});

test("raw rules roundtrip, Windows absolute syntax and hostile event fields", async (t) => {
  const f = await fixture(t);
  const rules = { ...defaultRules(), rules: [{ name: "manual", cwd: f.dataDir, to: "pi", prompt: "Report", when: { source: "desktop", types: ["manual.run"] } }] };
  await http(f.hub, "/v1/rules", { method: "PUT", body: rules });
  const saved = (await http(f.hub, "/v1/rules")).rules;
  assert.equal(saved.sources.schedule, undefined);
  await http(f.hub, "/v1/rules", { method: "PUT", body: saved });
  for (const cwd of ["C:\\projects\\demo", "D:/projects/demo", "\\\\server\\share\\demo"]) {
    assert.doesNotThrow(() => parseRules(JSON.stringify({ ...rules, rules: [{ ...rules.rules[0], cwd }] }), Date.now(), "UTC"));
  }
  await http(f.hub, "/v1/events", { key: f.hub.descriptor.sourceKey, method: "POST", body: { id: "bad", type: "manual.run", cwd: "/other" }, status: 400 });
  assert.equal((await http(f.hub, "/v1/state")).runs.length, 0);
});

test("event/claim/receipt/card deduplication preserves original session across restart", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  assert.equal((await trigger(f.hub)).duplicate, false);
  assert.equal((await trigger(f.hub)).duplicate, true);
  const first = (await work(f.hub)).job;
  const replay = (await work(f.hub)).job;
  assert.equal(replay.run, first.run);
  assert.notEqual(replay.token, first.token);
  assert.equal((await http(f.hub, "/v1/desktop/status")).dailyCounts["rule-test"], 1);
  await finish(f.hub, first, { outcome: "done", summary: "Stale token" }, 401);
  await http(f.hub, `/v1/runs/${replay.run}/started`, { key: replay.token, method: "POST", body: { session: "pi-test-session" } });
  const result = { outcome: "done", session: "pi-test-session", summary: "Need a decision", ask: [{ key: "color", title: "Choose", text: "Pick a color", options: ["Blue", "Green"] }] };
  await finish(f.hub, replay, result);
  assert.equal((await finish(f.hub, replay, result)).duplicate, true);
  await finish(f.hub, replay, { ...result, summary: "Different body" }, 409);
  const state = await http(f.hub, "/v1/state");
  assert.equal(state.cards.length, 1);
  const card = state.cards[0].id;
  await f.restart();
  await http(f.hub, `/v1/cards/${card}/answer`, { method: "POST", body: { choice: 1 } });
  assert.equal((await http(f.hub, `/v1/cards/${card}/answer`, { method: "POST", body: { choice: 0 } })).changed, false);
  const resumed = (await work(f.hub, "resumed")).job;
  assert.equal((await http(f.hub, "/v1/desktop/status")).dailyCounts["rule-test"], 2);
  assert.equal(resumed.session, "pi-test-session");
  assert.equal(resumed.context.answers[0].choice, 1);
  await finish(f.hub, resumed, { outcome: "done", summary: "Chose Green" });
});

test("disable-before-result fences effects while receipt retries hash the original body", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  await trigger(f.hub);
  const job = (await work(f.hub)).job;
  await saveConfig(f.hub, desktopConfig(f.dataDir, { enabled: false }));
  await http(f.hub, `/v1/runs/${job.run}/started`, { key: job.token, method: "POST", body: { session: "must-not-start" }, status: 409 });
  const result = { outcome: "done", summary: "Late result", ask: [{ title: "Late ask", text: "Do this?", options: ["Yes", "No"] }], later: [{ key: "late", at: new Date(f.clock.now + 60_000).toISOString(), about: "Check" }], events: [{ id: "late-event", type: "desktop.child" }] };
  await finish(f.hub, job, result);
  assert.equal((await finish(f.hub, job, result)).duplicate, true);
  const state = await http(f.hub, "/v1/state");
  assert.equal(state.runs.find((run) => run.id === job.run).state, "cancelled");
  assert.equal(state.cards.some((card) => card.title === "Late ask"), false);
  assert.equal(f.hub.runtime.db.prepare("SELECT COUNT(*) AS n FROM timers").get().n, 0);
  assert.equal((await http(f.hub, "/v1/desktop/status")).owner, null);
});

test("result-before-disable retains history and prevents old card/timer continuations", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  await trigger(f.hub);
  const job = (await work(f.hub)).job;
  await finish(f.hub, job, { outcome: "done", summary: "Waiting", ask: [{ key: "review", title: "Review", text: "Proceed?", options: ["Yes", "No"] }], later: [{ key: "check", at: new Date(f.clock.now + 60_000).toISOString(), about: "Check" }] });
  const card = (await http(f.hub, "/v1/state")).cards[0].id;
  await saveConfig(f.hub, desktopConfig(f.dataDir, { enabled: false }));
  assert.equal((await http(f.hub, `/v1/cards/${card}/answer`, { method: "POST", body: { choice: 0 } })).changed, false);
  f.clock.now += 120_000;
  f.hub.runtime.execute("tick", []);
  assert.equal((await work(f.hub, "after-disable")).job, null);
  assert.equal((await http(f.hub, "/v1/state")).runs.find((run) => run.id === job.run).state, "done");
});

test("card versions fence stale answers and resolutions inside the decision transaction", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  await trigger(f.hub);
  const job = (await work(f.hub)).job;
  await finish(f.hub, job, { outcome: "done", summary: "Questions", ask: [{ title: "Choose", text: "Choose one", options: ["One", "Two"] }], notice: [{ title: "Check", text: "Please review" }] });
  const cards = (await http(f.hub, "/v1/state")).cards;
  const ask = cards.find((card) => card.kind === "ask");
  const notice = cards.find((card) => card.kind === "notice");
  await http(f.hub, `/v1/cards/${ask.id}/answer`, { method: "POST", body: { choice: 0, expectedVersion: ask.version } });
  await http(f.hub, `/v1/cards/${ask.id}/answer`, { method: "POST", body: { choice: 1, expectedVersion: ask.version }, status: 409 });
  assert.equal((await http(f.hub, `/v1/cards/${ask.id}/answer`, { method: "POST", body: { choice: 1 } })).changed, false);
  await http(f.hub, `/v1/cards/${notice.id}/resolve`, { method: "POST", body: { reason: "Verified", expectedVersion: notice.version } });
  await http(f.hub, `/v1/cards/${notice.id}/resolve`, { method: "POST", body: { reason: "Stale page", expectedVersion: notice.version }, status: 409 });
});

test("unknown holds global resources through rebuild/restart until confirmed stopped", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  await trigger(f.hub);
  const job = (await work(f.hub)).job;
  await trigger(f.hub, "second-event");
  f.clock.now += 301_000;
  f.hub.runtime.execute("heartbeat", ["pi-desktop", []]);
  f.hub.runtime.execute("sweep", []);
  assert.equal((await http(f.hub, "/v1/state")).runs.find((run) => run.id === job.run).state, "unknown");
  assert.equal((await work(f.hub, "new-claim")).job, null);
  assert.equal((await work(f.hub, "test-claim")).job, null);
  f.hub.runtime.db.exec("UPDATE projection_meta SET format='force-rebuild'");
  await f.restart();
  const status = await http(f.hub, "/v1/desktop/status");
  assert.equal(status.owner.run, job.run);
  assert.equal(status.config.rules[0].id, "rule-test");
  assert.equal((await work(f.hub, "after-restart")).job, null);
  await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: false }, status: 409 });
  await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: true } });
  await finish(f.hub, job, { outcome: "done", summary: "Too late" }, 401);
  await trigger(f.hub, "third-event");
  const newer = (await work(f.hub, "after-reconcile")).job;
  assert.ok(newer);
  const duplicate = await http(f.hub, "/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: true } });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await http(f.hub, "/v1/desktop/status")).owner.run, newer.run);
});

test("claims pin the exact desktop policy after config races and replay it across restart", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir, { provider: "old-provider", modelId: "old-model", timeoutMinutes: 5 }));
  const staleClientConfig = (await http(f.hub, "/v1/desktop/config")).config;
  await saveConfig(f.hub, desktopConfig(f.dataDir, { provider: "claimed-provider", modelId: "claimed-model", timeoutMinutes: 10 }));
  await trigger(f.hub);
  const first = (await work(f.hub)).job;
  assert.equal(staleClientConfig.rules[0].modelId, "old-model");
  assert.equal(first.desktopRule.modelId, "claimed-model");
  assert.equal(first.desktopRule.timeoutMinutes, 10);
  await saveConfig(f.hub, desktopConfig(f.dataDir, { provider: "later-provider", modelId: "later-model", timeoutMinutes: 20 }));
  const replay = (await work(f.hub)).job;
  assert.deepEqual(replay.desktopRule, first.desktopRule);
  await f.restart();
  const afterRestart = (await work(f.hub)).job;
  assert.deepEqual(afterRestart.desktopRule, first.desktopRule);
  assert.equal((await http(f.hub, "/v1/desktop/status")).owner.desktopRule.modelId, "claimed-model");
  await finish(f.hub, afterRestart, { outcome: "done", summary: "Pinned policy used" });
});

test("atomic rule disable preserves configuration edits committed after a stale client read", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir));
  const stale = (await http(f.hub, "/v1/desktop/config")).config;
  await trigger(f.hub);
  const job = (await work(f.hub)).job;
  const edited = structuredClone(stale);
  edited.rules[0].prompt = "New trusted prompt";
  edited.rules.push({ ...edited.rules[0], id: "rule-other", name: "Other newly saved rule", modelId: "new-model", provider: "new-provider" });
  await saveConfig(f.hub, edited);
  const disabled = await http(f.hub, "/v1/desktop/disable", { method: "POST", body: { ruleId: stale.rules[0].id } });
  assert.equal(disabled.config.rules[0].enabled, false);
  assert.equal(disabled.config.rules[0].prompt, "New trusted prompt");
  assert.deepEqual(disabled.config.rules[1], edited.rules[1]);
  await http(f.hub, `/v1/runs/${job.run}/started`, { key: job.token, method: "POST", body: { session: "disabled-session" }, status: 409 });
  await finish(f.hub, job, { outcome: "done", summary: "Late" });
  const again = await http(f.hub, "/v1/desktop/disable", { method: "POST", body: { ruleId: "rule-test" } });
  assert.deepEqual(again.config, disabled.config);
});

test("cron can be triggered manually and once appointments survive restart without repeating", async (t) => {
  const f = await fixture(t);
  await saveConfig(f.hub, desktopConfig(f.dataDir, { trigger: { kind: "cron", cron: "0 9 * * *" } }));
  await trigger(f.hub, "cron-manual");
  const cronJob = (await work(f.hub)).job;
  assert.ok(cronJob);
  await finish(f.hub, cronJob, { outcome: "done", summary: "Manual cron" });
  const once = desktopConfig(f.dataDir, { trigger: { kind: "once", at: new Date(f.clock.now + 60_000).toISOString() } });
  await saveConfig(f.hub, once);
  await f.restart();
  f.clock.now += 61_000;
  f.hub.runtime.execute("tick", []);
  const appointment = (await work(f.hub, "once")).job;
  assert.equal(appointment.context.timers[0].key, "desktop-once");
  await finish(f.hub, appointment, { outcome: "done", summary: "Appointment done" });
  await saveConfig(f.hub, once);
  await f.restart();
  f.hub.runtime.execute("tick", []);
  assert.equal((await work(f.hub, "once-again")).job, null);
});

test("cancelling a once appointment does not rearm on an unchanged config save", async (t) => {
  const f = await fixture(t);
  const once = desktopConfig(f.dataDir, { trigger: { kind: "once", at: new Date(f.clock.now + 60_000).toISOString() } });
  await saveConfig(f.hub, once);
  await http(f.hub, "/v1/desktop/cancel", { method: "POST", body: { ruleId: "rule-test" } });
  await saveConfig(f.hub, once);
  f.clock.now += 61_000;
  f.hub.runtime.execute("tick", []);
  assert.equal((await work(f.hub)).job, null);
  await saveConfig(f.hub, { ...once, rules: [{ ...once.rules[0], enabled: false }] });
  await saveConfig(f.hub, once);
  f.hub.runtime.execute("tick", []);
  assert.ok((await work(f.hub, "explicitly-reenabled")).job);
});

test("fact stream resumes from a cursor and never contains plaintext access keys", async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.hub.descriptor.url}/v1/stream?after=0`, { headers: { authorization: `Bearer ${f.hub.descriptor.ownerKey}` } });
  const reader = response.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  const cursor = Number(text.match(/id: (\d+)/)[1]);
  assert.ok(cursor > 0);
  assert.equal(text.includes(f.hub.descriptor.ownerKey), false);
  await reader.cancel();
  const resumed = await fetch(`${f.hub.descriptor.url}/v1/stream?after=${cursor}`, { headers: { authorization: `Bearer ${f.hub.descriptor.ownerKey}` } });
  const resumedReader = resumed.body.getReader();
  const next = new TextDecoder().decode((await resumedReader.read()).value);
  assert.ok(Number(next.match(/id: (\d+)/)[1]) > cursor);
  await resumedReader.cancel();
});

test("SIGKILL after an acknowledged claim preserves config and resource ownership", { timeout: 10_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-process-crash-"));
  const descriptorFile = join(dataDir, "descriptor.json");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./host/main.ts", import.meta.url)), "--data-dir", dataDir, "--descriptor", descriptorFile], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  let reopened;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await reopened?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  let descriptor;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { descriptor = JSON.parse(readFileSync(descriptorFile, "utf8")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(descriptor, "child produced its private startup descriptor");
  const remote = { descriptor };
  await saveConfig(remote, desktopConfig(dataDir));
  await trigger(remote, "before-crash");
  const job = (await work(remote)).job;
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
  assert.equal(output.includes(descriptor.ownerKey), false);
  reopened = await startHub({ dataDir });
  const state = await http(reopened, "/v1/state");
  assert.equal(state.runs.find((run) => run.id === job.run).state, "claimed");
  const status = await http(reopened, "/v1/desktop/status");
  assert.equal(status.owner.run, job.run);
  assert.equal(status.config.rules[0].id, "rule-test");
  assert.equal((await work(reopened, "post-crash")).job, null);
});

test("an IPC parent disconnect stops the owned sidecar and removes its descriptor", { timeout: 10_000 }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-ipc-close-"));
  const descriptorFile = join(dataDir, "descriptor.json");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./host/main.ts", import.meta.url)), "--data-dir", dataDir], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  });
  let descriptor;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { descriptor = JSON.parse(readFileSync(descriptorFile, "utf8")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(descriptor);
  const ended = once(child, "exit");
  child.disconnect();
  await ended;
  assert.equal(child.exitCode, 0);
  assert.throws(() => readFileSync(descriptorFile), { code: "ENOENT" });
});

test("POSIX SIGTERM closes a sidecar even while its parent IPC channel remains connected", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-hub-ipc-sigterm-"));
  const descriptorFile = join(dataDir, "descriptor.json");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./host/main.ts", import.meta.url)), "--data-dir", dataDir], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
  });
  let descriptor;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { descriptor = JSON.parse(readFileSync(descriptorFile, "utf8")); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(descriptor);
  assert.equal(child.connected, true);
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  await ended;
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.throws(() => readFileSync(descriptorFile), { code: "ENOENT" });
});
