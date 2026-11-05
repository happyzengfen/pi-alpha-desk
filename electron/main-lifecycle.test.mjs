import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");
const require = createRequire(new URL("./main.js", import.meta.url));

function lifecycle() {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => new Promise(() => {});
  const windows = [];
  const calls = { serverStarts: 0, supervisorStarts: 0 };
  class Window extends EventEmitter {
    constructor() {
      super();
      this.visible = true;
      this.minimized = false;
      this.operations = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    loadURL(url) { this.url = url; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    restore() { this.operations.push("restore"); this.minimized = false; this.visible = true; }
    show() { this.operations.push("show"); this.visible = true; }
    focus() { this.operations.push("focus"); }
    hide() { this.operations.push("hide"); this.visible = false; }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      assert.equal(prevented, true, "Normal close keeps the existing native window alive");
    }
  }
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const context = {
    require(name) {
      if (name === "electron") return { app, BrowserWindow: Window, ipcMain };
      if (name === "child_process") return { fork() { calls.serverStarts++; throw new Error("Unexpected server start"); } };
      if (name === "./automation-host") return { createAutomationSupervisor() { calls.supervisorStarts++; throw new Error("Unexpected supervisor start"); } };
      return require(name);
    },
    __dirname: fileURLToPath(new URL(".", import.meta.url)),
    process: { env: {}, platform: "darwin", resourcesPath: "/nonexistent-lifecycle-fixture" },
    performance,
    console,
    setTimeout,
    setImmediate,
  };
  vm.createContext(context, { microtaskMode: "afterEvaluate" });
  vm.runInContext(`${source}\n globalThis.lifecycle = {
    createWindow,
    setOwners(server, supervisor) { serverProcess = server; automationSupervisor = supervisor; },
    snapshot() { return { window: mainWindow, server: serverProcess, supervisor: automationSupervisor }; }
  };`, context);
  const server = {}, supervisor = {};
  context.lifecycle.setOwners(server, supervisor);
  return {
    app, windows, calls, server, supervisor, ...context.lifecycle,
    evaluate(script) { return vm.runInContext(script, context); },
  };
}

test("native activation restores the same window after close hides it, without restarting owned services", () => {
  const fixture = lifecycle();
  fixture.createWindow();
  const window = fixture.snapshot().window;
  window.close();
  assert.equal(window.visible, false);
  fixture.app.emit("activate");
  assert.equal(window.visible, true);
  assert.deepEqual(window.operations, ["hide", "show", "focus"]);
  assert.equal(fixture.snapshot().window, window);
  assert.equal(fixture.windows.length, 1);
  assert.equal(fixture.snapshot().server, fixture.server);
  assert.equal(fixture.snapshot().supervisor, fixture.supervisor);
  assert.deepEqual(fixture.calls, { serverStarts: 0, supervisorStarts: 0 });
});

test("native activation restores a minimized window and focuses an already visible window", () => {
  const fixture = lifecycle();
  fixture.createWindow();
  const window = fixture.snapshot().window;
  window.minimized = true;
  fixture.app.emit("activate");
  assert.deepEqual(window.operations, ["restore", "focus"]);
  window.operations.length = 0;
  fixture.app.emit("activate");
  assert.deepEqual(window.operations, ["focus"]);
  assert.equal(fixture.windows.length, 1);
  assert.deepEqual(fixture.calls, { serverStarts: 0, supervisorStarts: 0 });
});

test("native activation creates and loads a window only when none exists", () => {
  const fixture = lifecycle();
  fixture.app.emit("activate");
  assert.equal(fixture.windows.length, 1);
  assert.equal(fixture.snapshot().window.url, "http://127.0.0.1:30141");
  assert.equal(fixture.snapshot().server, fixture.server);
  assert.equal(fixture.snapshot().supervisor, fixture.supervisor);
  assert.deepEqual(fixture.calls, { serverStarts: 0, supervisorStarts: 0 });
});

test("native quit exits after a stopped automation host settles during the before-quit callback", async () => {
  const fixture = lifecycle();
  fixture.createWindow();
  const window = fixture.snapshot().window;
  let serverStops = 0;
  fixture.setOwners(
    { kill() { serverStops++; } },
    fixture.evaluate(`({
      stop(options) {
        this.options = options;
        this.calls = (this.calls ?? 0) + 1;
        return Promise.resolve();
      }
    })`),
  );
  let nativeQuitting = false;
  let windowsClosing = false;
  fixture.app.quit = () => {
    let prevented = false;
    fixture.app.nativeQuitEvent = { preventDefault() { prevented = true; } };
    // Electron drains native callback microtasks before committing cancellation.
    fixture.evaluate(`app.emit("before-quit", app.nativeQuitEvent)`);
    nativeQuitting = !prevented;
    if (nativeQuitting) windowsClosing = true;
  };

  fixture.app.quit();
  await new Promise(setImmediate);
  assert.equal(windowsClosing, true);
  window.emit("closed");
  fixture.app.emit("window-all-closed");
  assert.equal(nativeQuitting, true, "The native quit must survive the original cancelled callback");
  assert.equal(fixture.snapshot().window, null);
  assert.equal(serverStops, 1);
  assert.equal(fixture.snapshot().supervisor.calls, 1);
  assert.equal(fixture.snapshot().supervisor.options.timeoutMs, 2_500);
  assert.equal(fixture.snapshot().supervisor.options.force, true);
});

test("unexpected server exits surface diagnostics and quit instead of hiding the window", () => {
  const exitHandler = source.match(/serverProcess\.on\("exit",[\s\S]*?\n  \}\);/)?.[0] ?? "";

  assert.match(exitHandler, /if \(app\.isQuitting\) return;/);
  assert.match(exitHandler, /dialog\.showErrorBox\("Server Error", getStartupFailureMessage\(exitError\)\);/);
  assert.match(exitHandler, /app\.quit\(\);/);
  assert.doesNotMatch(exitHandler, /mainWindow\.close\(\)/);
});

test("renderer console diagnostics use the non-deprecated event-object listener shape", () => {
  assert.match(source, /on\("console-message", \(event, \.\.\.legacyArgs\) =>/);
});

test("startup failures include the server log path and recent output", () => {
  const formatter = source.match(/function getStartupFailureMessage\(error\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(formatter, /Server log:/);
  assert.match(formatter, /Last server output:/);
  assert.match(formatter, /serverLogPath/);
  assert.match(formatter, /serverLogTail/);
});

test("desktop server uses the selected standalone Node runtime and exposes its bin directory", () => {
  const startServer = source.match(/function startServer\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /resolveServerNodeExecutable\(\{/);
  assert.match(startServer, /prependExecutableDirectory\(baseEnv, serverNodeExecutable\)/);
  assert.match(startServer, /execPath: serverNodeExecutable/);
});

test("renderer crashes and load failures retain actionable diagnostics", () => {
  assert.match(source, /on\("render-process-gone"[\s\S]*?details\.reason[\s\S]*?details\.exitCode/);
  assert.match(source, /on\("did-fail-load"[\s\S]*?errorCode[\s\S]*?errorDescription[\s\S]*?validatedURL/);
});

test("benchmark instrumentation is local and opt-in", () => {
  assert.match(source, /process\.env\.PI_WEB_BENCHMARK !== "1"/);
  assert.match(source, /PI_WEB_STARTUP_METRIC/);
  assert.match(source, /Performance\.getMetrics/);
});
