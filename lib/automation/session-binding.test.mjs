import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { findAutomationBinding, listAutomationBindings } = await createJiti(import.meta.url).import("./session-binding.ts");

test("damaged private metadata never downgrades a managed session to an absent binding", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "sessions"));
  const file = path.join(root, "sessions", "managed.json");
  const valid = { sessionId: "managed", sessionFile: path.join(root, "session.jsonl"), cwd: root };
  for (const value of [null, false, 7, "plain text", [], { ...valid, sessionId: "other" }, { ...valid, sessionFile: "" }, { ...valid, cwd: " " }]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(findAutomationBinding(root, "managed"), /binding is damaged/);
    await assert.rejects(listAutomationBindings(root), /binding is damaged/);
  }
});

test("legacy object bindings remain identifiable and only missing files are absent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-automation-binding-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await findAutomationBinding(root, "managed"), undefined);
  assert.deepEqual(await listAutomationBindings(root), []);
  await mkdir(path.join(root, "sessions"));
  const legacy = { sessionId: "managed", sessionFile: path.join(root, "session.jsonl"), cwd: root };
  await writeFile(path.join(root, "sessions", "managed.json"), JSON.stringify(legacy));
  assert.deepEqual(await findAutomationBinding(root, "managed"), legacy);
  assert.deepEqual(await listAutomationBindings(root), [legacy]);
});
