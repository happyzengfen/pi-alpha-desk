import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function sample(name, run, { iterations = 12, warmup = 2 } = {}) {
  for (let index = 0; index < warmup; index++) await run();
  const values = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await run();
    values.push(performance.now() - started);
  }
  return {
    name,
    samples: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    minMs: Number(Math.min(...values).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
  };
}

function makeSessionEntries(turns, payloadSize = 120) {
  const entries = [];
  let parentId = null;
  for (let index = 0; index < turns; index++) {
    const userId = `u${index}`;
    const assistantId = `a${index}`;
    entries.push({
      type: "message",
      id: userId,
      parentId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: `request ${index} ${"x".repeat(payloadSize)}` },
    });
    entries.push({
      type: "message",
      id: assistantId,
      parentId: userId,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        provider: "benchmark",
        model: "benchmark",
        content: [
          { type: "thinking", thinking: `reasoning ${"y".repeat(payloadSize)}` },
          { type: "text", text: `answer ${index} ${"z".repeat(payloadSize)}` },
        ],
      },
    });
    parentId = assistantId;
  }
  return entries;
}

function makeMarkdown(sectionCount) {
  return Array.from({ length: sectionCount }, (_, index) => [
    `## Section ${index}`,
    `Text with **bold**, [link](https://example.invalid/${index}) and math $x_${index}^2$.`,
    "```ts",
    `const value${index}: number = ${index};`,
    "```",
  ].join("\n\n")).join("\n\n");
}

function fileFixture(count) {
  return Array.from({ length: count }, (_, index) => (
    `packages/module-${String(index % 500).padStart(3, "0")}/src/component-${String(index).padStart(5, "0")}.tsx`
  ));
}

async function createGitFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-performance-git-"));
  await execFileAsync("git", ["-C", directory, "init", "-q"]);
  await execFileAsync("git", ["-C", directory, "config", "user.email", "benchmark@example.invalid"]);
  await execFileAsync("git", ["-C", directory, "config", "user.name", "Benchmark"]);
  for (let directoryIndex = 0; directoryIndex < 25; directoryIndex++) {
    const child = path.join(directory, `group-${directoryIndex}`);
    await mkdir(child);
    await Promise.all(Array.from({ length: 40 }, (_, fileIndex) => (
      writeFile(path.join(child, `file-${fileIndex}.txt`), `baseline ${directoryIndex}/${fileIndex}\n`)
    )));
  }
  await execFileAsync("git", ["-C", directory, "add", "."]);
  await execFileAsync("git", ["-C", directory, "commit", "-qm", "fixture"]);
  await Promise.all(Array.from({ length: 100 }, (_, index) => (
    writeFile(path.join(directory, `group-${index % 25}`, `file-${index % 40}.txt`), `changed ${index}\n`)
  )));
  return directory;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function measureElectronStartup() {
  if (process.platform !== "darwin" && process.platform !== "win32" && !process.env.DISPLAY) {
    return { skipped: "No desktop display is available." };
  }
  const electronPath = (await import("electron")).default;
  const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-web-performance-agent-"));
  const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-web-performance-user-data-"));
  const port = await availablePort();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(electronPath, [root], {
        cwd: root,
        env: {
          ...process.env,
          PORT: String(port),
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_WEB_BENCHMARK: "1",
          PI_WEB_BENCHMARK_USER_DATA: userDataDirectory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const metrics = [];
      let diagnostics = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Electron startup benchmark timed out. ${diagnostics.slice(-2000)}`));
      }, 120_000);
      const consume = (chunk) => {
        const text = chunk.toString();
        diagnostics = `${diagnostics}${text}`.slice(-8000);
        for (const line of text.split(/\r?\n/)) {
          const prefix = "PI_WEB_STARTUP_METRIC ";
          if (!line.startsWith(prefix)) continue;
          try { metrics.push(JSON.parse(line.slice(prefix.length))); } catch {}
        }
      };
      child.stdout.on("data", consume);
      child.stderr.on("data", consume);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        const interactive = metrics.find((item) => item.stage === "renderer-interactive");
        if (!interactive || code !== 0) {
          reject(new Error(`Electron benchmark exited ${code} without interactive metric. ${diagnostics.slice(-2000)}`));
          return;
        }
        resolve({ port, metrics });
      });
    });
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

async function runBaseline({ includeElectron = true } = {}) {
  const { buildSessionContext, getSessionEntries } = await jiti.import("../lib/session-reader.ts");
  const { buildEntriesFromFiles, filterFileEntries } = await jiti.import("../lib/file-fuzzy.ts");
  const { createStreamUpdateScheduler } = await jiti.import("../lib/stream-update-scheduler.ts");
  const { getGitStatus } = await jiti.import("../lib/git-changes.ts");
  const { MarkdownBody } = await jiti.import("../components/MarkdownBody.tsx");
  const { ToolCallBlock } = await jiti.import("../components/MessageView.tsx");
  const { I18nContext } = await jiti.import("../hooks/useI18n.tsx");

  const typicalEntries = makeSessionEntries(100);
  const longEntries = makeSessionEntries(2_500);
  const markdown = makeMarkdown(80);
  const files = fileFixture(50_000);
  const builtFileEntries = buildEntriesFromFiles(files);
  const i18n = { locale: "en", setLocale() {}, t: (key) => key, supportedLocales: [] };
  const renderMarkdown = (streaming) => renderToStaticMarkup(
    React.createElement(I18nContext.Provider, { value: i18n },
      React.createElement(MarkdownBody, { cwd: root, isStreaming: streaming, onOpenFile() {} }, markdown)),
  );
  const largeToolCall = { type: "toolCall", toolCallId: "benchmark-call", toolName: "read", input: { path: "/tmp/large.txt" } };
  const largeToolResult = {
    role: "toolResult",
    toolCallId: "benchmark-call",
    content: [{ type: "text", text: "tool output\n".repeat(400_000) }],
    isError: false,
    timestamp: Date.now(),
  };
  const renderLargeToolResult = () => renderToStaticMarkup(
    React.createElement(I18nContext.Provider, { value: i18n },
      React.createElement(ToolCallBlock, { block: largeToolCall, result: largeToolResult })),
  );

  const measurements = [];
  measurements.push(await sample("session-context-200-messages", () => buildSessionContext(typicalEntries)));
  measurements.push(await sample("session-context-5000-messages-deferred", () => (
    buildSessionContext(longEntries, undefined, { deferThinking: true, deferToolResultImages: true })
  ), { iterations: 8, warmup: 1 }));
  measurements.push(await sample("session-branch-switch-2500-messages", () => (
    buildSessionContext(longEntries, "a1249", { deferThinking: true, deferToolResultImages: true })
  ), { iterations: 8, warmup: 1 }));
  const sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-web-performance-session-"));
  const sessionPath = path.join(sessionDirectory, "benchmark.jsonl");
  fs.writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: "benchmark-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: root }),
    ...longEntries.map((entry) => JSON.stringify(entry)),
  ].join("\n"));
  try {
    measurements.push(await sample("session-jsonl-read-5000-messages", () => getSessionEntries(sessionPath), { iterations: 6, warmup: 1 }));
  } finally {
    await rm(sessionDirectory, { recursive: true, force: true });
  }
  measurements.push(await sample("markdown-80-sections-complete-initial-render", () => renderMarkdown(false), { iterations: 6, warmup: 1 }));
  measurements.push(await sample("markdown-80-sections-streaming-initial-render", () => renderMarkdown(true), { iterations: 6, warmup: 1 }));
  measurements.push(await sample("tool-result-4.8mb-collapsed", renderLargeToolResult, { iterations: 10, warmup: 1 }));
  measurements.push(await sample("file-index-build-50000", () => buildEntriesFromFiles(files), { iterations: 8, warmup: 1 }));
  measurements.push(await sample("file-index-search-50000", () => filterFileEntries(builtFileEntries, "component-042"), { iterations: 20, warmup: 2 }));
  measurements.push(await sample("stream-coalesce-100000-updates", () => {
    let commits = 0;
    const scheduler = createStreamUpdateScheduler(() => { commits++; }, {
      requestFrame: () => 1,
      cancelFrame() {},
    });
    for (let index = 0; index < 100_000; index++) scheduler.enqueue(index);
    scheduler.flush();
    scheduler.destroy();
    if (commits !== 1) throw new Error(`Expected one coalesced commit, received ${commits}`);
  }, { iterations: 10, warmup: 1 }));

  const gitFixture = await createGitFixture();
  try {
    measurements.push(await sample("git-status-1000-files-100-dirty", () => getGitStatus(gitFixture), { iterations: 5, warmup: 1 }));
  } finally {
    await rm(gitFixture, { recursive: true, force: true });
  }

  return {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      electron: JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version,
      next: JSON.parse(fs.readFileSync(path.join(root, "node_modules/next/package.json"), "utf8")).version,
    },
    fixture: {
      typicalMessages: typicalEntries.length,
      longMessages: longEntries.length,
      markdownSections: 80,
      indexedFiles: files.length,
      gitFiles: 1000,
      gitDirtyFiles: 100,
    },
    measurements,
    electronStartup: includeElectron ? await measureElectronStartup() : { skipped: "Disabled by --no-electron." },
  };
}

async function runSoak(minutes) {
  const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
  const entries = makeSessionEntries(500);
  const started = Date.now();
  const samples = [];
  let cycles = 0;
  while (Date.now() - started < minutes * 60_000) {
    for (let index = 0; index < 25; index++) buildSessionContext(entries, undefined, { deferThinking: true });
    cycles += 25;
    if (samples.length === 0 || Date.now() - samples.at(-1).at > 60_000) {
      const memory = process.memoryUsage();
      samples.push({ at: Date.now(), rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  global.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const finalMemory = process.memoryUsage();
  return { generatedAt: new Date().toISOString(), minutes, cycles, samples, finalMemory };
}

function parseArguments(argv) {
  const help = argv.includes("--help");
  const noElectron = argv.includes("--no-electron");
  const soak = argv.find((argument) => argument.startsWith("--soak-minutes="));
  const soakMinutes = soak ? Number(soak.slice("--soak-minutes=".length)) : null;
  if (soakMinutes !== null && (!Number.isFinite(soakMinutes) || soakMinutes <= 0)) {
    throw new Error("--soak-minutes must be a positive number");
  }
  return { help, noElectron, soakMinutes };
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log("Usage: node [--expose-gc] scripts/benchmark-desktop.mjs [--no-electron] [--soak-minutes=N]");
} else {
  const result = options.soakMinutes === null
    ? await runBaseline({ includeElectron: !options.noElectron })
    : await runSoak(options.soakMinutes);
  console.log(JSON.stringify(result, null, 2));
}
