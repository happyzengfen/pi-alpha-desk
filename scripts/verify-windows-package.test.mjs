import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { verifyWindowsPackage } from "./verify-windows-package.mjs";

const PRODUCT_EXECUTABLE = "数字化AI助手.exe";

async function writeFixtureFile(root, relativePath, contents = "fixture") {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function createPe(machine) {
  const buffer = Buffer.alloc(128);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(64, 0x3c);
  buffer.write("PE\0\0", 64, "ascii");
  buffer.writeUInt16LE(machine, 68);
  return buffer;
}

async function createValidPackage(root, machine = 0x8664) {
  await writeFixtureFile(root, PRODUCT_EXECUTABLE, createPe(machine));
  await writeFixtureFile(root, "resources/app/electron/main.js");
  await writeFixtureFile(root, "resources/app/electron/preload.js");
  await writeFixtureFile(root, "resources/app/node_modules/next/dist/bin/next");
  await writeFixtureFile(root, "resources/app/node_modules/@earendil-works/pi-coding-agent/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/pi-subagents/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/pi-mcp-adapter/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/pi-web-access/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/@juicesharp/rpiv-ask-user-question/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/@narumitw/pi-goal/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/@e965/xlsx/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/unpdf/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/word-extractor/package.json", "{}");
  await writeFixtureFile(root, "resources/app/node_modules/undici/package.json", "{}");
  await writeFixtureFile(root, "resources/app/.next/BUILD_ID");
  await writeFixtureFile(root, "resources/app/bundled-plugins/manifest.json", "{}");
  await writeFixtureFile(root, "resources/app/.next/node_modules/external-package/index.js");
  await writeFixtureFile(root, "resources/app/public/icon.ico");
  await writeFixtureFile(
    root,
    "resources/app/node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
  );
  await writeFixtureFile(root, "resources/bundled-skills/example/SKILL.md");
  await writeFixtureFile(root, "resources/bundled-skills/manifest.json", "{}");
}

test("accepts a complete Windows x64 package", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-win-package-"));
  try {
    await createValidPackage(root);
    const result = verifyWindowsPackage(root);
    assert.equal(result.executable, PRODUCT_EXECUTABLE);
    assert.equal(result.machine, "x64");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-x64 application executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-win-package-"));
  try {
    await createValidPackage(root, 0x014c);
    assert.throws(
      () => verifyWindowsPackage(root),
      /Expected an x64 Windows executable.*found 0x14c/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a hoisted Windows clipboard native module", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-win-package-"));
  try {
    await createValidPackage(root);
    await rm(join(
      root,
      "resources/app/node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner",
    ), { recursive: true, force: true });
    await writeFixtureFile(
      root,
      "resources/app/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
    );

    assert.equal(verifyWindowsPackage(root).machine, "x64");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports missing runtime resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-win-package-"));
  try {
    await createValidPackage(root);
    await rm(join(root, "resources", "bundled-skills"), { recursive: true, force: true });
    await rm(join(root, "resources", "app", ".next", "BUILD_ID"));
    await rm(join(root, "resources", "app", "node_modules", "pi-subagents"), { recursive: true, force: true });
    await rm(join(root, "resources", "app", "node_modules", "unpdf"), { recursive: true, force: true });
    await rm(join(root, "resources", "app", "node_modules", "@e965", "xlsx"), { recursive: true, force: true });

    assert.throws(
      () => verifyWindowsPackage(root),
      (error) => {
        assert.match(error.message, /Windows package is incomplete/);
        assert.match(error.message, /\.next[/\\]BUILD_ID/);
        assert.match(error.message, /node_modules[/\\]pi-subagents[/\\]package\.json/);
        assert.match(error.message, /node_modules[/\\]unpdf[/\\]package\.json/);
        assert.match(error.message, /node_modules[/\\]@e965[/\\]xlsx[/\\]package\.json/);
        assert.match(error.message, /resources[/\\]bundled-skills/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
