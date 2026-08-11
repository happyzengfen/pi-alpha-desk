import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyLinuxPackage } from "./verify-linux-package.mjs";

function makeFixture(t, { architecture = "x64", omit = null } = {}) {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-linux-package-"));
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  const appRoot = path.join(release, "resources", "app");
  const executable = path.join(release, "数字化AI助手");
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
    [".next/BUILD_ID", "build"],
    ["public/icon.png", "icon"],
  ];

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
  return release;
}

test("accepts complete Linux x64 and arm64 packages", (t) => {
  assert.equal(verifyLinuxPackage(makeFixture(t), "x64").machine, "x64");
  assert.equal(verifyLinuxPackage(makeFixture(t, { architecture: "arm64" }), "arm64").machine, "arm64");
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
