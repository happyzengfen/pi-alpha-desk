import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createMacEditMenuTemplate,
  handleMacEditShortcut,
} = require("./mac-edit-shortcuts.js");

function input(key, overrides = {}) {
  return {
    type: "keyDown",
    key,
    meta: true,
    control: false,
    alt: false,
    shift: false,
    isComposing: false,
    ...overrides,
  };
}

test("macOS Command shortcuts invoke the focused WebContents edit command", () => {
  const cases = [
    [input("c"), "copy"],
    [input("v"), "paste"],
    [input("x"), "cut"],
    [input("a"), "selectAll"],
    [input("z"), "undo"],
    [input("z", { shift: true }), "redo"],
  ];

  for (const [keyboardInput, expectedCommand] of cases) {
    const calls = [];
    const event = { preventDefault: () => calls.push("preventDefault") };
    const webContents = Object.fromEntries(
      ["copy", "paste", "cut", "selectAll", "undo", "redo"]
        .map((command) => [command, () => calls.push(command)]),
    );

    assert.equal(handleMacEditShortcut(event, keyboardInput, webContents, "darwin"), true);
    assert.deepEqual(calls, ["preventDefault", expectedCommand]);
  }
});

test("edit shortcut fallback ignores other platforms and modified input", () => {
  const calls = [];
  const event = { preventDefault: () => calls.push("preventDefault") };
  const webContents = { paste: () => calls.push("paste") };

  assert.equal(handleMacEditShortcut(event, input("v"), webContents, "win32"), false);
  assert.equal(handleMacEditShortcut(event, input("v", { type: "keyUp" }), webContents, "darwin"), false);
  assert.equal(handleMacEditShortcut(event, input("v", { alt: true }), webContents, "darwin"), false);
  assert.equal(handleMacEditShortcut(event, input("v", { isComposing: true }), webContents, "darwin"), false);
  assert.deepEqual(calls, []);
});

test("macOS application menu exposes standard editing roles", () => {
  const template = createMacEditMenuTemplate();
  const roles = template.flatMap((item) => [item.role, ...(item.submenu ?? []).map((entry) => entry.role)]);

  assert.deepEqual(
    ["appMenu", "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll"]
      .filter((role) => !roles.includes(role)),
    [],
  );
});
