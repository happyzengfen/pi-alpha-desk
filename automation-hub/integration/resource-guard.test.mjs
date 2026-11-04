import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { startHub } from "../host/main.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { "@": fileURLToPath(new URL("../../", import.meta.url)) } });
const { assertNoAutomationOwner } = await jiti.import("../../lib/automation/resource-guard.ts");
const { automationHubClient } = await jiti.import("../../lib/automation/hub-client.ts");
const { parseAutomationConfig, compileAutomationRules } = await jiti.import("../../lib/automation/config.ts");

test("claimed/unknown hub ownership survives memory loss, missing descriptor and restart, fencing only its canonical cwd", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-hub-resource-owner-"));
  const dataDir = path.join(root, "hub");
  const cwd = path.join(root, "project");
  const alias = path.join(root, "alias");
  const other = path.join(root, "other");
  const previousRuntime = globalThis.__piAutomationRuntime;
  const previousDescriptor = process.env.PI_AUTOMATION_DESCRIPTOR;
  const clock = { now: Date.now() };
  let hub;
  t.after(async () => {
    await hub?.close();
    globalThis.__piAutomationRuntime = previousRuntime;
    if (previousDescriptor === undefined) delete process.env.PI_AUTOMATION_DESCRIPTOR;
    else process.env.PI_AUTOMATION_DESCRIPTOR = previousDescriptor;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd, { recursive: true });
  await mkdir(other);
  await symlink(cwd, alias, "junction");
  delete process.env.PI_AUTOMATION_DESCRIPTOR;
  hub = await startHub({ dataDir, now: () => clock.now });
  let client = automationHubClient(hub.descriptor);
  globalThis.__piAutomationRuntime = { descriptorPath: path.join(dataDir, "descriptor.json") };
  const config = parseAutomationConfig({ version: 1, timezone: "UTC", rules: [{
    id: "rule-owner", name: "Owner", cwd, prompt: "Read only", enabled: true, trigger: { kind: "manual" },
  }] });
  await client.call("/v1/desktop/config", { method: "PUT", body: { config, rules: compileAutomationRules(config) } });
  await client.call("/v1/desktop/trigger", { method: "POST", body: { ruleId: "rule-owner", eventId: "owner-event" } });
  const { job } = await client.call("/v1/work?claim=owner-claim&wait=0&running=&capacity=1", { role: "worker" });
  await assert.rejects(assertNoAutomationOwner(cwd), /Automation owns/);
  await assert.rejects(assertNoAutomationOwner(alias), /Automation owns/);
  await assertNoAutomationOwner(other);
  clock.now += 301000;
  hub.runtime.execute("heartbeat", ["pi-desktop", []]);
  hub.runtime.execute("sweep", []);
  assert.equal((await client.call("/v1/state")).runs.find((run) => run.id === job.run).state, "unknown");

  await hub.close();
  hub = undefined;
  // No in-memory wrapper/worker or live sidecar remains. Read-only durable
  // projection fallback must still preserve the unknown owner's directory.
  await assert.rejects(assertNoAutomationOwner(cwd), /Automation owns/);
  await assertNoAutomationOwner(other);
  hub = await startHub({ dataDir, now: () => clock.now });
  client = automationHubClient(hub.descriptor);
  await assert.rejects(assertNoAutomationOwner(cwd), /Automation owns/);
  await client.call("/v1/desktop/reconcile", { method: "POST", body: { run: job.run, confirmedStopped: true } });
  await assertNoAutomationOwner(cwd);
  await hub.close();
  hub = undefined;
  await assertNoAutomationOwner(cwd);
});
