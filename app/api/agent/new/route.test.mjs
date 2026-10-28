import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { resolveAllowedNewSessionCwd } = await jiti.import("@/lib/new-session-cwd");

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-web-agent-new-"));
  const allowedRoot = path.join(root, "allowed");
  const allowedChild = path.join(allowedRoot, "child");
  const outsideDirectory = path.join(root, "outside");
  const file = path.join(root, "file.txt");
  mkdirSync(allowedChild, { recursive: true });
  mkdirSync(outsideDirectory);
  writeFileSync(file, "not a directory");
  return { root, allowedRoot, allowedChild, outsideDirectory, file };
}

test("accepts only real directories inside existing allowed roots", () => {
  const fixture = createFixture();
  try {
    const roots = new Set([fixture.allowedRoot]);
    assert.equal(resolveAllowedNewSessionCwd(fixture.allowedRoot, roots), realpathSync(fixture.allowedRoot));
    assert.equal(resolveAllowedNewSessionCwd(fixture.allowedChild, roots), realpathSync(fixture.allowedChild));
    assert.equal(resolveAllowedNewSessionCwd(fixture.outsideDirectory, roots), null);
    assert.equal(resolveAllowedNewSessionCwd(fixture.file, roots), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a directory link inside an allowed root when it resolves outside", () => {
  const fixture = createFixture();
  const linkedDirectory = path.join(fixture.allowedRoot, "outside-link");
  try {
    symlinkSync(fixture.outsideDirectory, linkedDirectory, "junction");
    assert.equal(resolveAllowedNewSessionCwd(linkedDirectory, new Set([fixture.allowedRoot])), null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("does not treat stale allowed roots as authorization", () => {
  const fixture = createFixture();
  try {
    assert.equal(
      resolveAllowedNewSessionCwd(fixture.outsideDirectory, new Set([path.join(fixture.root, "missing")])),
      null,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("new sessions default to full tools and preserve explicit tool presets", async () => {
  const fixture = createFixture();
  try {
    const { NextResponse } = await jiti.import("next/server");
    const security = await jiti.import("@/lib/request-security");
    const tools = await jiti.import("@/lib/tool-presets");
    const starts = [];
    const imports = {
      "next/server": { NextResponse },
      crypto: { randomUUID },
      "@/lib/file-access": { getAllowedFileRoots: async () => new Set([fixture.allowedRoot]) },
      "@/lib/new-session-cwd": { resolveAllowedNewSessionCwd },
      "@/lib/session-reader": { invalidateSessionListCache() {} },
      "@/lib/request-security": security,
      "@/lib/tool-presets": tools,
      "@/lib/rpc-manager": {
        async startRpcSession(...args) {
          starts.push(args);
          return { realSessionId: "new-session", session: { async send() { return {}; } } };
        },
      },
    };
    const compiled = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const testModule = { exports: {} };
    vm.runInNewContext(compiled, {
      module: testModule,
      exports: testModule.exports,
      require(name) {
        assert.ok(name in imports, `Unexpected route import: ${name}`);
        return imports[name];
      },
    });

    for (const toolNames of [undefined, [], tools.PRESET_DEFAULT, tools.PRESET_FULL]) {
      const response = await testModule.exports.POST(new Request("http://localhost/api/agent/new", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ cwd: fixture.allowedChild, type: "ensure_session", toolNames }),
      }));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).sessionId, "new-session");
      assert.ok(Array.isArray(starts.at(-1)[3].toolNames));
      assert.deepEqual([...starts.at(-1)[3].toolNames], toolNames ?? tools.PRESET_FULL);
    }
    assert.equal(starts.length, 4);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
