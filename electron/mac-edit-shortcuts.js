"use strict";

const EDIT_COMMAND_BY_KEY = Object.freeze({
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
});

function getMacEditCommand(input, platform = process.platform) {
  if (
    platform !== "darwin" ||
    input.type !== "keyDown" ||
    !input.meta ||
    input.control ||
    input.alt ||
    input.isComposing
  ) {
    return null;
  }

  const key = input.key.toLowerCase();
  if (key === "z") return input.shift ? "redo" : "undo";
  if (input.shift) return null;
  return EDIT_COMMAND_BY_KEY[key] ?? null;
}

function handleMacEditShortcut(event, input, webContents, platform = process.platform) {
  const command = getMacEditCommand(input, platform);
  if (!command || typeof webContents[command] !== "function") return false;

  event.preventDefault();
  webContents[command]();
  return true;
}

function createMacEditMenuTemplate() {
  return [
    { role: "appMenu" },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
  ];
}

module.exports = {
  createMacEditMenuTemplate,
  getMacEditCommand,
  handleMacEditShortcut,
};
