import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { AUTOMATION_REQUIRED_FILES, AUTOMATION_SUPERVISOR_FILES, verifyAutomationPackage, verifyAutomationRuntime } from "./verify-automation-package.mjs";

async function asset(root, filename, contents) {
  const full = join(root, filename);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-automation-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const filename of AUTOMATION_REQUIRED_FILES) {
    const content = filename === "build.json" ? JSON.stringify({ version: 1, sourceHash: "a".repeat(64) })
      : filename === "package.json" ? JSON.stringify({ type: "module" })
        : filename === "upstream/LICENSE" ? "MIT License\nCopyright (c) fixture\n"
          : filename === "upstream/SOURCE.md" ? `Commit: \`${"b".repeat(40)}\`\n` : "export {};\n";
    await asset(root, `dist/automation-hub/${filename}`, content);
  }
  for (const filename of AUTOMATION_SUPERVISOR_FILES) await asset(root, filename, "module.exports = {};\n");
  return root;
}

test("verifies built app and direct hub assets without requiring an unused protocol schema", async (t) => {
  const root = await fixture(t);
  assert.equal(verifyAutomationPackage(root).sourceHash, "a".repeat(64));
  assert.equal(verifyAutomationPackage(join(root, "dist", "automation-hub")).upstreamCommit, "b".repeat(40));
  assert.equal(existsSync(join(root, "dist", "automation-hub", "upstream", "protocol", "schema.json")), false);
});

test("every required supervisor, SQL, provenance, receipt and host asset is checked", async (t) => {
  const root = await fixture(t);
  for (const filename of [...AUTOMATION_SUPERVISOR_FILES, ...AUTOMATION_REQUIRED_FILES.map((file) => `dist/automation-hub/${file}`)]) {
    const full = join(root, filename);
    const content = await readFile(full);
    await rm(full);
    assert.throws(() => verifyAutomationPackage(root), /incomplete/);
    await asset(root, filename, content);
  }
});

test("static import closure detects missing dependencies, TypeScript leftovers and external packages", async (t) => {
  const root = await fixture(t);
  await asset(root, "dist/automation-hub/host/main.mjs", 'import "../upstream/protocol/validate.mjs";\n');
  assert.throws(() => verifyAutomationPackage(root), /module is missing.*validate\.mjs/);
  await asset(root, "dist/automation-hub/upstream/protocol/validate.mjs", 'import { existsSync } from "node:fs"; export { existsSync };\n');
  assert.equal(verifyAutomationPackage(root).modules, 6);
  await asset(root, "dist/automation-hub/host/main.mjs", 'import "./runtime.ts";\n');
  assert.throws(() => verifyAutomationPackage(root), /not compiled/);
  await asset(root, "dist/automation-hub/host/main.mjs", 'import "unbundled-library";\n');
  assert.throws(() => verifyAutomationPackage(root), /external dependency/);
});

test("invalid build receipts and missing license provenance fail verification", async (t) => {
  const root = await fixture(t);
  await asset(root, "dist/automation-hub/build.json", JSON.stringify({ version: 1, sourceHash: "unknown" }));
  assert.throws(() => verifyAutomationPackage(root), /build receipt/);
  await asset(root, "dist/automation-hub/build.json", JSON.stringify({ version: 1, sourceHash: "a".repeat(64) }));
  await asset(root, "dist/automation-hub/upstream/LICENSE", "No retained license\n");
  assert.throws(() => verifyAutomationPackage(root), /provenance or MIT/);
});

test("an empty packaged supervisor cannot pass the asset check", async (t) => {
  const root = await fixture(t);
  await asset(root, "electron/automation-host.js", "");
  assert.throws(() => verifyAutomationPackage(root), /supervisor is empty/);
});

test("runtime verifier refuses a mismatched executable architecture instead of claiming unsupported degradation", async (t) => {
  const root = await fixture(t);
  await assert.rejects(verifyAutomationRuntime(root, { executable: process.execPath, arch: "not-the-current-architecture", expectUnsupported: true }), /architecture mismatch/);
});

test("a copied compiled package starts and stops through its own supervisor in the actual runtime", {
  timeout: 15000,
  skip: !existsSync(new URL("../dist/automation-hub/host/main.mjs", import.meta.url)),
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-automation-package-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(import.meta.dirname, "..");
  await cp(join(source, "dist", "automation-hub"), join(root, "dist", "automation-hub"), { recursive: true });
  for (const file of AUTOMATION_SUPERVISOR_FILES) await asset(root, file, await readFile(join(source, file)));
  const result = await verifyAutomationRuntime(root);
  if (Number(process.versions.node.split(".")[0]) >= 24) {
    assert.equal(result.supported, true);
    assert.equal(result.hubStarted, true);
  } else {
    assert.equal(result.supported, false);
    assert.equal(result.degraded, true);
  }
  assert.equal(result.platform, process.platform);
  assert.equal(result.arch, process.arch);
});
