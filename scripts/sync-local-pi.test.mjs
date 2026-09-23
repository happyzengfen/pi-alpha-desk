import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const packageName = "@earendil-works/pi-coding-agent";
const installedCommit = "1111111111111111111111111111111111111111";
const newerCommit = "2222222222222222222222222222222222222222";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-snapshot-test-"));
  await mkdir(join(root, "scripts"));
  await cp(new URL("./sync-local-pi.mjs", import.meta.url), join(root, "scripts/sync-local-pi.mjs"));
  const sdk = join(root, "node_modules", packageName);
  await mkdir(sdk, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, dependencies: { [packageName]: "0.87.1" } }));
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: packageName, version: "0.87.1" }));
  await writeFile(join(sdk, "pi-local-source.json"), JSON.stringify({ commit: installedCommit }));
  for (const [commit, date] of [[installedCommit, "2026-09-22"], [newerCommit, "2026-09-23"]]) {
    const directory = join(root, ".local-pi", "snapshots", commit.slice(0, 9));
    await mkdir(directory, { recursive: true });
    const tarball = "test snapshot contents";
    await writeFile(join(directory, "sdk.tgz"), tarball);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      commit, describe: commit.slice(0, 9), generatedAt: date,
      packages: [{ name: packageName, version: "0.87.1", file: "sdk.tgz",
        sha256: createHash("sha256").update(tarball).digest("hex") }],
    }));
  }
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [join(root, "scripts/sync-local-pi.mjs"), ...args], { cwd: root, encoding: "utf8" });
}

test("verification uses the installed commit even when a newer snapshot is cached", async () => {
  const root = await fixture();
  try {
    const result = run(root, ["--verify"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(installedCommit));
    const mismatch = run(root, ["--verify", "--snapshot", newerCommit]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /source commit is .* expected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore rejects a corrupt snapshot before replacing installed packages", async () => {
  const root = await fixture();
  try {
    const installed = join(root, "node_modules", packageName, "pi-local-source.json");
    const before = await readFile(installed, "utf8");
    await writeFile(join(root, ".local-pi/snapshots", newerCommit.slice(0, 9), "sdk.tgz"), "corrupt");
    const result = run(root, ["--restore", "--snapshot", newerCommit]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum does not match/);
    assert.equal(await readFile(installed, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
