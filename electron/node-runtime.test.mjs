import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  isSupportedNodeVersion,
  prependExecutableDirectory,
  selectNodeCandidate,
} = require("./node-runtime");

test("selects the Node runtime compatible with installed native addons", () => {
  const selected = selectNodeCandidate([
    { executable: "/node-22", version: "v22.22.3", loaded: 4, abiMismatches: 1, order: 0 },
    { executable: "/node-24", version: "v24.15.0", loaded: 5, abiMismatches: 0, order: 1 },
    { executable: "/node-26", version: "v26.0.0", loaded: 6, abiMismatches: 1, order: 2 },
  ], 24);

  assert.equal(selected.executable, "/node-24");
});

test("requires the Node version supported by the desktop server", () => {
  assert.equal(isSupportedNodeVersion("v22.18.0"), false);
  assert.equal(isSupportedNodeVersion("v22.19.0"), true);
  assert.equal(isSupportedNodeVersion("v24.0.0"), true);
});

test("prepends the selected Node bin directory for node, npm, and npx", () => {
  const env = prependExecutableDirectory({ PATH: "/usr/bin" }, "/runtime/bin/node");
  assert.equal(env.PATH, `/runtime/bin${path.delimiter}/usr/bin`);
});
