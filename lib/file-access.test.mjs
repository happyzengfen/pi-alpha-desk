import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { isFilePathAllowed } = await createJiti(import.meta.url).import("./file-access.ts");

test("file access rejects existing and not-yet-created paths through an escaping symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const allowedRoot = path.join(root, "allowed");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(allowedRoot);
  fs.mkdirSync(outsideRoot);
  fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret");
  fs.symlinkSync(outsideRoot, path.join(allowedRoot, "escape"), "dir");

  const roots = new Set([allowedRoot]);
  assert.equal(isFilePathAllowed(path.join(allowedRoot, "normal.txt"), roots), true);
  assert.equal(isFilePathAllowed(path.join(allowedRoot, "escape", "secret.txt"), roots), false);
  assert.equal(isFilePathAllowed(path.join(allowedRoot, "escape", "new.txt"), roots), false);
});

test("an explicitly allowed symlink root authorizes only its resolved subtree", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-root-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const selectedTarget = path.join(root, "selected-target");
  const selectedLink = path.join(root, "selected-link");
  const sibling = path.join(root, "sibling");
  fs.mkdirSync(selectedTarget);
  fs.mkdirSync(sibling);
  fs.symlinkSync(selectedTarget, selectedLink, "dir");

  const roots = new Set([selectedLink]);
  assert.equal(isFilePathAllowed(path.join(selectedLink, "file.txt"), roots), true);
  assert.equal(isFilePathAllowed(path.join(sibling, "file.txt"), roots), false);
});
