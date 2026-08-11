import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyMacPackage } from "./verify-macos-package.mjs";

function makeFixture(t, { machine = 0x0100000c, omit = null } = {}) {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mac-package-"));
  t.after(() => fs.rmSync(release, { recursive: true, force: true }));
  const app = path.join(release, "数字化AI助手.app");
  const appRoot = path.join(app, "Contents", "Resources", "app");
  const executable = path.join(app, "Contents", "MacOS", "数字化AI助手");
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
    ["public/icon-mac.png", "icon"],
  ];
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
  return release;
}

test("accepts a complete macOS arm64 package", (t) => {
  assert.equal(verifyMacPackage(makeFixture(t)).machine, "arm64");
});

test("rejects a non-arm64 application executable", (t) => {
  assert.throws(() => verifyMacPackage(makeFixture(t, { machine: 0x01000007 })), /arm64/);
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
