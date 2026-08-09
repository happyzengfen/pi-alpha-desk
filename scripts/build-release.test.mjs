import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const BUILD_SCRIPT = new URL("./build-release.mjs", import.meta.url);

async function writeFakeCommand(binDirectory, name) {
  const source = `#!${process.execPath}\n`
    + `const fs = require("node:fs");\n`
    + `fs.appendFileSync(process.env.BUILD_RELEASE_CALL_LOG, JSON.stringify({ command: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + "\\n");\n`;
  const executable = join(binDirectory, name);
  await writeFile(executable, source);
  await chmod(executable, 0o755);

  const windowsLauncher = `@"${process.execPath}" "%~dp0${name}" %*\r\n`;
  await writeFile(`${executable}.cmd`, windowsLauncher);
}

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-build-release-")));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const callLog = join(root, "calls.jsonl");
  await mkdir(scripts, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(scripts, "build-release.mjs"), await readFile(BUILD_SCRIPT));
  await writeFile(join(root, "package.json"), JSON.stringify({
    version: "1.0.0",
    build: { productName: "Test App" },
    devDependencies: { electron: "1.0.0", "electron-builder": "1.0.0" },
  }));
  await Promise.all(["npm", "npx", "node"].map((name) => writeFakeCommand(bin, name)));
  return { root, bin, callLog };
}

test("builds and verifies the unpacked app before creating Windows installers", async () => {
  const fixture = await createFixture();
  try {
    const result = spawnSync(process.execPath, [
      join(fixture.root, "scripts", "build-release.mjs"),
      "--target=dir,nsis,portable",
      "--arch=x64",
      "--no-zip",
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_RELEASE_CALL_LOG: fixture.callLog,
        PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = (await readFile(fixture.callLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const builderCalls = calls.filter((call) => call.command === "npx");
    const unpackedDirectory = join(fixture.root, "release", "win-unpacked");

    assert.deepEqual(builderCalls, [
      {
        command: "npx",
        args: ["electron-builder", "--win", "dir", "--x64", "--publish", "never"],
      },
      {
        command: "npx",
        args: [
          "electron-builder", "--win", "nsis", "--prepackaged", unpackedDirectory,
          "--x64", "--publish", "never",
        ],
      },
      {
        command: "npx",
        args: [
          "electron-builder", "--win", "portable", "--prepackaged", unpackedDirectory,
          "--x64", "--publish", "never",
        ],
      },
    ]);

    const verifyIndex = calls.findIndex((call) =>
      call.command === "node" && call.args[0] === "scripts/verify-windows-package.mjs",
    );
    const nsisIndex = calls.findIndex((call) => call.command === "npx" && call.args.includes("nsis"));
    assert.ok(verifyIndex !== -1 && verifyIndex < nsisIndex);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an unsupported target before running build commands", async () => {
  const fixture = await createFixture();
  try {
    const result = spawnSync(process.execPath, [
      join(fixture.root, "scripts", "build-release.mjs"),
      "--target=dir,unknown",
      "--no-zip",
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_RELEASE_CALL_LOG: fixture.callLog,
        PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported Windows target list: dir,unknown/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
