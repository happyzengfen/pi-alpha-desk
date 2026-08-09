import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8");

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

test("renderer crashes and load failures retain actionable diagnostics", () => {
  assert.match(source, /on\("render-process-gone"[\s\S]*?details\.reason[\s\S]*?details\.exitCode/);
  assert.match(source, /on\("did-fail-load"[\s\S]*?errorCode[\s\S]*?errorDescription[\s\S]*?validatedURL/);
});

test("benchmark instrumentation is local and opt-in", () => {
  assert.match(source, /process\.env\.PI_WEB_BENCHMARK !== "1"/);
  assert.match(source, /PI_WEB_STARTUP_METRIC/);
  assert.match(source, /Performance\.getMetrics/);
});
