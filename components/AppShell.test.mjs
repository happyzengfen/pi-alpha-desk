import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("fresh installs keep the project picker visible before a cwd is selected", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const sidebarStart = source.indexOf("<SessionSidebar");
  const sidebarEnd = source.indexOf("/>", sidebarStart);
  const sidebarProps = source.slice(sidebarStart, sidebarEnd);

  assert.notEqual(sidebarStart, -1);
  assert.notEqual(sidebarEnd, -1);
  assert.match(sidebarProps, /\n\s*showWorkspaceControls\s*$/);
  assert.doesNotMatch(sidebarProps, /showWorkspaceControls=\{Boolean\(/);
});
