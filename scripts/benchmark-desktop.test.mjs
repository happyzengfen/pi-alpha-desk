import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("desktop benchmark exposes reproducible baseline and soak modes", async () => {
  const script = path.join(process.cwd(), "scripts", "benchmark-desktop.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, "--help"]);

  assert.match(stdout, /--no-electron/);
  assert.match(stdout, /--soak-minutes=N/);
});
