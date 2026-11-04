"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const { collectNodeCandidates } = require("./node-runtime");

const execFileAsync = promisify(execFile);
const PROBE = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('BEGIN; CREATE TABLE probe(value TEXT);');db.prepare('INSERT INTO probe VALUES(?)').run('{"ok":1}');db.exec('COMMIT');if(db.prepare("SELECT json_extract(value, '$.ok') AS ok FROM probe").get().ok!==1)process.exit(1);db.close();console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch}));`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bounded(work, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([work, new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref();
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function childEnvironment(environment, embedded) {
  const clean = { ...environment };
  delete clean.PI_AUTOMATION_DESCRIPTOR;
  delete clean.PI_AUTOMATION_CONTROL_KEY;
  delete clean.ELECTRON_RUN_AS_NODE;
  if (embedded) clean.ELECTRON_RUN_AS_NODE = "1";
  return clean;
}

async function probeRuntime(candidate, { environment = process.env, platform = process.platform, arch = process.arch } = {}) {
  try {
    const { stdout } = await execFileAsync(candidate.executable, ["-e", PROBE], {
      env: childEnvironment(environment, candidate.embedded), timeout: 4_000, windowsHide: true, maxBuffer: 16_384,
    });
    const result = JSON.parse(stdout.trim());
    const major = Number(result.version.match(/^v(\d+)/)?.[1]);
    if (!(major >= 24) || result.platform !== platform || result.arch !== arch) return null;
    return { ...candidate, ...result };
  } catch {
    return null;
  }
}

function resolveHubEntry(appRoot) {
  return [
    path.join(appRoot, "dist", "automation-hub", "host", "main.mjs"),
    path.join(appRoot, "automation-hub", "host", "main.ts"),
  ].find((entry) => fs.existsSync(entry)) ?? null;
}

function validDescriptor(value, instanceId, pid) {
  if (!value || value.version !== 1 || value.instanceId !== instanceId || value.pid !== pid) return false;
  if (!["ownerKey", "workerKey", "sourceKey"].every((key) => typeof value[key] === "string" && value[key].length > 0)) return false;
  try {
    const url = new URL(value.url);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function requestJson(descriptor, endpoint) {
  const response = await fetch(new URL(endpoint, descriptor.url), {
    headers: { authorization: `Bearer ${descriptor.ownerKey}` }, signal: AbortSignal.timeout(2_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("automation-request-failed");
  return response.json();
}

function notificationChanges(previous, state) {
  const current = new Map();
  const notifications = [];
  for (const card of state.cards ?? []) {
    if (!Number.isSafeInteger(card.id) || card.id <= 0 || card.state !== "open") continue;
    const key = `card:${card.id}`;
    current.set(key, "open");
    if (previous && !previous.has(key)) notifications.push({ kind: "decision", cardId: card.id });
  }
  for (const run of state.runs ?? []) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0) continue;
    const key = `run:${run.id}`;
    const version = `${run.state}:${run.attempts ?? 0}`;
    current.set(key, version);
    if (!previous || previous.get(key) === version) continue;
    if (run.state === "done") notifications.push({ kind: "complete", runId: run.id });
    else if (run.state === "unknown" || (run.state === "queued" && run.attempts > 0 && run.error)) notifications.push({ kind: "failure", runId: run.id });
  }
  return { current, notifications };
}

function createAutomationSupervisor(options) {
  const { appRoot, dataDirectory, descriptorPath = path.join(dataDirectory, "connection.json"),
    homeDirectory, embeddedExecutable, environment = process.env, platform = process.platform, arch = process.arch,
    canStart = () => true, drainWorker, resumeWorker, onNotification = () => {}, onStatus = () => {} } = options;
  const preferencePath = path.join(dataDirectory, "preferences.json");
  let enabled = false;
  try { enabled = JSON.parse(fs.readFileSync(preferencePath, "utf8")).enabled === true; } catch { /* First launch is disabled. */ }
  let state = "disabled";
  let reason;
  let child = null;
  let descriptor = null;
  let instanceId = null;
  let notifications = null;
  let pollTimer = null;
  let polling = false;
  let starting = null;
  let desired = enabled;
  let stopping = null;

  const getStatus = () => ({ enabled, state, ...(reason ? { reason } : {}) });
  const update = (nextState, nextReason) => {
    state = nextState;
    reason = nextReason;
    onStatus(getStatus());
    return getStatus();
  };
  function savePreference(value) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${preferencePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ enabled: value }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, preferencePath);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* Already renamed. */ }
    }
    enabled = value;
  }
  function removeOwnedDescriptor() {
    try {
      if (JSON.parse(fs.readFileSync(descriptorPath, "utf8")).instanceId === instanceId) fs.unlinkSync(descriptorPath);
    } catch { /* A later host may own the descriptor. */ }
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    notifications = null;
  }
  async function poll() {
    if (polling || !descriptor || state !== "ready") return;
    polling = true;
    try {
      const changes = notificationChanges(notifications, await requestJson(descriptor, "/v1/state"));
      if (state !== "ready") return;
      notifications = changes.current;
      for (const notification of changes.notifications) onNotification(notification);
    } catch { /* Connectivity errors are surfaced by the worker; do not repeat notifications. */ }
    finally { polling = false; }
  }
  async function terminate(timeoutMs) {
    stopPolling();
    const owned = child;
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      const exited = new Promise((resolve) => owned.once("exit", resolve));
      // IPC disconnect requests the same graceful close on Windows and POSIX.
      if (owned.connected) owned.disconnect();
      else owned.kill();
      await bounded(exited, timeoutMs);
      if (owned.exitCode === null && owned.signalCode === null) {
        owned.kill("SIGKILL");
        await bounded(exited, 1_000);
      }
    }
    removeOwnedDescriptor();
    if (child === owned) child = null;
    descriptor = null;
  }
  async function start() {
    if (state === "ready") return getStatus();
    if (starting) return starting;
    if (!canStart()) return update("unavailable", "external-server");
    desired = true;
    starting = (async () => {
      update("starting");
      try {
        const entry = options.entry ?? resolveHubEntry(appRoot);
        if (!entry) return update("unavailable", "hub-not-installed");
        const candidates = options.candidates ?? [
          ...(environment.PI_ALPHA_DESK_AUTOMATION_NODE ? [{ executable: environment.PI_ALPHA_DESK_AUTOMATION_NODE }] : []),
          ...collectNodeCandidates({ env: environment, homeDirectory, platform }).map((executable) => ({ executable })),
          ...(embeddedExecutable ? [{ executable: embeddedExecutable, embedded: true }] : []),
        ];
        let runtime = null;
        for (const candidate of candidates) {
          if (!desired) return update("disabled");
          runtime = await (options.probe ?? probeRuntime)(candidate, { environment, platform, arch });
          if (runtime) break;
        }
        if (!desired) return update("disabled");
        if (!runtime) return update("unavailable", "runtime-unavailable");
        fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
        instanceId = randomUUID();
        const owned = spawn(runtime.executable, [entry, "--data-dir", dataDirectory, "--descriptor", descriptorPath, "--instance-id", instanceId], {
          cwd: appRoot, env: childEnvironment(environment, runtime.embedded), windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        child = owned;
        let failed = false;
        owned.on("error", () => { failed = true; });
        owned.on("exit", () => {
          failed = true;
          if (child !== owned) return;
          stopPolling();
          removeOwnedDescriptor();
          descriptor = null;
          child = null;
          if (state !== "stopping") update("unavailable", "hub-exited");
        });
        const deadline = Date.now() + (options.startTimeoutMs ?? 8_000);
        while (desired && !failed && Date.now() < deadline) {
          try {
            const candidate = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
            if (validDescriptor(candidate, instanceId, owned.pid)) {
              const health = await requestJson(candidate, "/healthz");
              if (health.ok === true && health.instanceId === instanceId && desired && !failed) {
                descriptor = candidate;
                notifications = notificationChanges(null, await requestJson(candidate, "/v1/state")).current;
                if (resumeWorker) await resumeWorker();
                if (!desired) return update("stopping");
                savePreference(true);
                update("ready");
                await poll();
                pollTimer = setInterval(poll, options.pollIntervalMs ?? 3_000);
                pollTimer.unref();
                return getStatus();
              }
            }
          } catch { /* Wait for the matching host's atomic descriptor and readiness. */ }
          await pause(75);
        }
        if (!desired) return update("stopping");
        await terminate(500);
        return update(desired ? "unavailable" : "disabled", desired ? "hub-start-failed" : undefined);
      } catch {
        await terminate(500);
        return update("unavailable", "hub-start-failed");
      }
    })().finally(() => { starting = null; });
    return starting;
  }
  async function stop({ timeoutMs = 3_000, force = false } = {}) {
    if (stopping) return stopping;
    desired = false;
    stopping = (async () => {
      if (starting) await starting;
      if (child && drainWorker) {
        try {
          const result = await bounded(drainWorker(), timeoutMs, { stopped: false });
          if (result?.stopped !== true && !force) {
            desired = true;
            return update("ready", "worker-drain-failed");
          }
        } catch {
          if (!force) {
            desired = true;
            return update("ready", "worker-drain-failed");
          }
        }
      }
      update("stopping");
      await terminate(Math.min(timeoutMs, 1_000));
      return update("disabled");
    })().finally(() => { stopping = null; });
    return stopping;
  }
  async function setEnabled(value) {
    if (typeof value !== "boolean") return getStatus();
    if (value) {
      if (stopping) await stopping;
      return start();
    }
    const status = await stop();
    if (status.state === "disabled") {
      try { savePreference(false); } catch { return update("unavailable", "preference-write-failed"); }
    }
    return getStatus();
  }
  return { getStatus, setEnabled, stop, restore: () => enabled ? start() : Promise.resolve(getStatus()) };
}

module.exports = { createAutomationSupervisor, notificationChanges, probeRuntime, resolveHubEntry, validDescriptor };
