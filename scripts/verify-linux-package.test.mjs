import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyLinuxPackage } from "./verify-linux-package.mjs";
import { AUTOMATION_REQUIRED_FILES, AUTOMATION_SUPERVISOR_FILES } from "./verify-automation-package.mjs";

function makeFixture(t, { architecture = "x64", executableName = "运维数字化Ai助手", omit = null } = {}) {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-linux-package-"));
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  const appRoot = path.join(release, "resources", "app");
  const executable = path.join(release, executableName);
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
    ["public/icon.png", "icon"],
  ];
  required.push(...AUTOMATION_SUPERVISOR_FILES.map((file) => [file, "module.exports = {};\n"]));
  for (const file of AUTOMATION_REQUIRED_FILES) {
    const content = file === "build.json" ? JSON.stringify({ version: 1, sourceHash: "a".repeat(64) })
      : file === "package.json" ? JSON.stringify({ type: "module" })
        : file === "upstream/LICENSE" ? "MIT License\nCopyright (c) fixture\n"
          : file === "upstream/SOURCE.md" ? `Commit: \`${"b".repeat(40)}\`\n` : "export {};\n";
    required.push([`dist/automation-hub/${file}`, content]);
  }

  const header = Buffer.alloc(20);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(header);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(architecture === "arm64" ? 183 : 62, 18);
  fs.writeFileSync(executable, header);

  for (const [relative, contents] of required) {
    if (relative === omit) continue;
    const destination = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  const skill = path.join(release, "resources", "bundled-skills", "example", "SKILL.md");
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, "---\nname: example\n---\n");
  fs.writeFileSync(path.join(path.dirname(path.dirname(skill)), "manifest.json"), "{}");
  return release;
}

test("accepts complete Linux x64 and arm64 packages", (t) => {
  const result = verifyLinuxPackage(makeFixture(t), "x64");
  assert.equal(result.machine, "x64");
  assert.equal(result.automation.assets, "complete");
  assert.equal(result.automation.runtime, "not-probed");
  assert.equal(verifyLinuxPackage(makeFixture(t, { architecture: "arm64" }), "arm64").machine, "arm64");
});

test("rejects missing Linux automation supervisor, compiled host, SQL, contract and provenance", (t) => {
  for (const file of [...AUTOMATION_SUPERVISOR_FILES, ...AUTOMATION_REQUIRED_FILES.map((file) => `dist/automation-hub/${file}`)]) {
    assert.throws(() => verifyLinuxPackage(makeFixture(t, { omit: file })), (error) => error.message.includes(file.split("/").join(path.sep)));
  }
});

test("checks the compiled Linux automation import closure", (t) => {
  const release = makeFixture(t);
  fs.writeFileSync(path.join(release, "resources", "app", "dist", "automation-hub", "host", "main.mjs"), 'import "./missing.mjs";\n');
  assert.throws(() => verifyLinuxPackage(release), /Automation module is missing/);
});

test("accepts Electron Builder's package-name Linux executable", (t) => {
  assert.equal(
    verifyLinuxPackage(makeFixture(t, { executableName: "pi-alpha-desk" }), "x64").executable,
    "pi-alpha-desk",
  );
});

test("rejects a package for the wrong Linux architecture", (t) => {
  assert.throws(() => verifyLinuxPackage(makeFixture(t), "arm64"), /arm64/);
});

test("reports missing Linux runtime resources", (t) => {
  assert.throws(
    () => verifyLinuxPackage(makeFixture(t, { omit: "node_modules/unpdf/package.json" })),
    /node_modules[/\\]unpdf[/\\]package\.json/,
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
      () => verifyLinuxPackage(makeFixture(t, { omit: relative })),
      (error) => error.message.includes(relative.split("/").join(path.sep)),
    );
  }
});
