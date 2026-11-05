import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyMacPackage } from "./verify-macos-package.mjs";
import { AUTOMATION_REQUIRED_FILES, AUTOMATION_SUPERVISOR_FILES } from "./verify-automation-package.mjs";

function makeFixture(t, { machine = 0x0100000c, omit = null } = {}) {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mac-package-"));
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  const app = path.join(release, "运维数字化Ai助手.app");
  const appRoot = path.join(app, "Contents", "Resources", "app");
  const executable = path.join(app, "Contents", "MacOS", "运维数字化Ai助手");
  const required = [
    ["electron/main.js", "main"],
    ["electron/preload.js", "preload"],
    ["node_modules/next/dist/bin/next", "next"],
    ["node_modules/@earendil-works/pi-coding-agent/package.json", "{}"],
    ["node_modules/pi-subagents/package.json", "{}"],
    ["node_modules/pi-mcp-adapter/package.json", "{}"],
    ["node_modules/pi-web-access/package.json", "{}"],
    ["node_modules/@juicesharp/rpiv-ask-user-question/package.json", "{}"],
    ["node_modules/@narumitw/pi-goal/package.json", "{}"],
    ["node_modules/@e965/xlsx/package.json", "{}"],
    ["node_modules/unpdf/package.json", "{}"],
    ["node_modules/word-extractor/package.json", "{}"],
    ["node_modules/undici/package.json", "{}"],
    ["node_modules/pdfjs-dist/package.json", "{}"],
    ["node_modules/pdfjs-dist/legacy/build/pdf.mjs", "pdfjs"],
    ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "worker"],
    ["node_modules/pdfjs-dist/cmaps/GB-EUC-H.bcmap", "cmap"],
    ["node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap", "cmap"],
    ["node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf", "font"],
    ["node_modules/mammoth/package.json", "{}"],
    ["node_modules/jszip/package.json", "{}"],
    ["node_modules/@napi-rs/canvas/package.json", "{}"],
    [".next/BUILD_ID", "build"],
    ["bundled-plugins/manifest.json", "{}"],
    ["public/icon-mac.png", "icon"],
  ];
  required.push(...AUTOMATION_SUPERVISOR_FILES.map((file) => [file, "module.exports = {};\n"]));
  for (const file of AUTOMATION_REQUIRED_FILES) {
    const content = file === "build.json" ? JSON.stringify({ version: 1, sourceHash: "a".repeat(64) })
      : file === "package.json" ? JSON.stringify({ type: "module" })
        : file === "upstream/LICENSE" ? "MIT License\nCopyright (c) fixture\n"
          : file === "upstream/SOURCE.md" ? `Commit: \`${"b".repeat(40)}\`\n` : "export {};\n";
    required.push([`dist/automation-hub/${file}`, content]);
  }
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(machine, 4);
  fs.writeFileSync(executable, header);
  for (const [relative, contents] of required) {
    if (relative === omit) continue;
    const destination = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  const skill = path.join(app, "Contents", "Resources", "bundled-skills", "example", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: example\n---\n");
  fs.writeFileSync(path.join(path.dirname(path.dirname(skill)), "manifest.json"), "{}");
  return release;
}

test("accepts a complete macOS arm64 package", (t) => {
  const result = verifyMacPackage(makeFixture(t));
  assert.equal(result.machine, "arm64");
  assert.equal(result.automation.assets, "complete");
  assert.equal(result.automation.runtime, "not-probed");
});

test("rejects missing macOS automation supervisor, compiled host, SQL, contract and provenance", (t) => {
  for (const file of [...AUTOMATION_SUPERVISOR_FILES, ...AUTOMATION_REQUIRED_FILES.map((file) => `dist/automation-hub/${file}`)]) {
    assert.throws(() => verifyMacPackage(makeFixture(t, { omit: file })), (error) => error.message.includes(file.split("/").join(path.sep)));
  }
});

test("checks the compiled macOS automation import closure", (t) => {
  const release = makeFixture(t);
  fs.writeFileSync(path.join(release, "运维数字化Ai助手.app", "Contents", "Resources", "app", "dist", "automation-hub", "host", "main.mjs"), 'import "./missing.mjs";\n');
  assert.throws(() => verifyMacPackage(release), /Automation module is missing/);
});

test("accepts a complete macOS x64 package", (t) => {
  assert.equal(
    verifyMacPackage(makeFixture(t, { machine: 0x01000007 }), "x64").machine,
    "x64",
  );
});

test("rejects a non-arm64 application executable", (t) => {
  assert.throws(() => verifyMacPackage(makeFixture(t, { machine: 0x01000007 })), /arm64/);
});

test("rejects a non-x64 application executable", (t) => {
  assert.throws(() => verifyMacPackage(makeFixture(t), "x64"), /x64/);
});

test("reports missing runtime resources", (t) => {
  assert.throws(() => verifyMacPackage(makeFixture(t, { omit: ".next/BUILD_ID" })), /BUILD_ID/);
});

test("reports a missing bundled pi-subagents package", (t) => {
  assert.throws(
    () => verifyMacPackage(makeFixture(t, { omit: "node_modules/pi-subagents/package.json" })),
    /node_modules[/\\]pi-subagents[/\\]package\.json/,
  );
});

test("reports a missing PDF reader runtime", (t) => {
  assert.throws(
    () => verifyMacPackage(makeFixture(t, { omit: "node_modules/unpdf/package.json" })),
    /node_modules[/\\]unpdf[/\\]package\.json/,
  );
});

test("reports a missing Office reader runtime", (t) => {
  assert.throws(
    () => verifyMacPackage(makeFixture(t, { omit: "node_modules/@e965/xlsx/package.json" })),
    /node_modules[/\\]@e965[/\\]xlsx[/\\]package\.json/,
  );
});

test("reports missing PDF preview and Office preview resources", (t) => {
  for (const relative of [
    "node_modules/pdfjs-dist/package.json",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    "node_modules/pdfjs-dist/cmaps/GB-EUC-H.bcmap",
    "node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap",
    "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
    "node_modules/mammoth/package.json",
    "node_modules/jszip/package.json",
    "node_modules/@napi-rs/canvas/package.json",
  ]) {
    assert.throws(
      () => verifyMacPackage(makeFixture(t, { omit: relative })),
      (error) => error.message.includes(relative.split("/").join(path.sep)),
    );
  }
});
