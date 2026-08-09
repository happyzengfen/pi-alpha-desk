import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const sourcePath = path.join(process.cwd(), "lib/file-watch-state.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const testModule = { exports: {} };
vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports });

const { didFileWatchSnapshotChange } = testModule.exports;

test("file watch snapshots ignore duplicate filesystem notifications", () => {
  const snapshot = { mtimeMs: 1234, size: 42 };
  assert.equal(didFileWatchSnapshotChange(snapshot, { ...snapshot }), false);
});

test("file watch snapshots detect content, deletion, and recreation changes", () => {
  const snapshot = { mtimeMs: 1234, size: 42 };
  assert.equal(didFileWatchSnapshotChange(snapshot, { mtimeMs: 1235, size: 42 }), true);
  assert.equal(didFileWatchSnapshotChange(snapshot, { mtimeMs: 1234, size: 43 }), true);
  assert.equal(didFileWatchSnapshotChange(snapshot, null), true);
  assert.equal(didFileWatchSnapshotChange(null, null), false);
  assert.equal(didFileWatchSnapshotChange(null, snapshot), true);
});
