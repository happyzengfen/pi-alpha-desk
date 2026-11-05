#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const AUTOMATION_REQUIRED_FILES = [
  "host/main.mjs", "host/runtime.mjs", "host/server.mjs", "host/desktop-decisions.mjs",
  "upstream/kernel/schema.sql", "upstream/worker/contract.mjs", "upstream/LICENSE", "upstream/SOURCE.md",
  "package.json", "build.json",
];
export const AUTOMATION_SUPERVISOR_FILES = ["electron/automation-host.js", "electron/node-runtime.js"];

/** Verify the compiled closure, including the non-module files opened at runtime. */
export function verifyAutomationPackage(directory = PROJECT_ROOT) {
  const given = resolve(directory);
  const directHub = basename(given) === "automation-hub" || existsSync(join(given, "build.json"));
  const hubRoot = directHub ? given : join(given, "dist", "automation-hub");
  const appRoot = directHub ? resolve(hubRoot, "..", "..") : given;
  const missing = AUTOMATION_REQUIRED_FILES.filter((file) => !existsSync(join(hubRoot, file)));
  if (!directHub) missing.push(...AUTOMATION_SUPERVISOR_FILES.filter((file) => !existsSync(join(appRoot, file))));
  if (missing.length) throw new Error(`Automation package is incomplete: ${missing.join(", ")}`);
  for (const file of AUTOMATION_REQUIRED_FILES) {
    if (!statSync(join(hubRoot, file)).isFile() || statSync(join(hubRoot, file)).size === 0) throw new Error(`Automation asset is empty or not a file: ${file}`);
  }
  if (!directHub) for (const file of AUTOMATION_SUPERVISOR_FILES) {
    if (!statSync(join(appRoot, file)).isFile() || statSync(join(appRoot, file)).size === 0) throw new Error(`Automation supervisor is empty or not a file: ${file}`);
  }
  const build = JSON.parse(readFileSync(join(hubRoot, "build.json"), "utf8"));
  if (build.version !== 1 || !/^[a-f0-9]{64}$/.test(build.sourceHash)) throw new Error("Invalid automation build receipt");
  const pkg = JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8"));
  if (pkg.type !== "module") throw new Error("Automation package must use ES modules");
  const source = readFileSync(join(hubRoot, "upstream", "SOURCE.md"), "utf8");
  const upstreamCommit = source.match(/Commit:\s*`([a-f0-9]{40})`/)?.[1];
  if (!upstreamCommit || !/MIT License/.test(readFileSync(join(hubRoot, "upstream", "LICENSE"), "utf8"))) throw new Error("Automation upstream provenance or MIT notice is missing");
  const visited = new Set();
  function inspect(file) {
    const filename = resolve(hubRoot, file);
    const inside = relative(hubRoot, filename);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`Automation import escapes its package: ${file}`);
    if (visited.has(filename)) return;
    if (!existsSync(filename) || !statSync(filename).isFile()) throw new Error(`Automation module is missing: ${inside}`);
    visited.add(filename);
    const content = readFileSync(filename, "utf8");
    const imports = content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g);
    for (const [, specifier] of imports) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) throw new Error(`Automation runtime has an unexpected external dependency: ${specifier}`);
      if (!specifier.endsWith(".mjs")) throw new Error(`Automation module import is not compiled: ${specifier}`);
      inspect(relative(hubRoot, resolve(dirname(filename), specifier)));
    }
  }
  for (const file of AUTOMATION_REQUIRED_FILES.filter((file) => file.endsWith(".mjs"))) inspect(file);
  return { appRoot, hubRoot, modules: visited.size, sourceHash: build.sourceHash, upstreamCommit };
}

/** Probe an actual executable, then use its own packaged supervisor to boot the built hub. */
export async function verifyAutomationRuntime(directory = PROJECT_ROOT, {
  executable = process.execPath, embedded = false, platform = process.platform, arch = process.arch,
  expectUnsupported = false,
} = {}) {
  const assets = verifyAutomationPackage(directory);
  for (const file of AUTOMATION_SUPERVISOR_FILES) if (!existsSync(join(assets.appRoot, file))) throw new Error(`Automation supervisor is missing: ${file}`);
  const environment = { ...process.env };
  delete environment.PI_AUTOMATION_DESCRIPTOR;
  delete environment.PI_AUTOMATION_CONTROL_KEY;
  delete environment.ELECTRON_RUN_AS_NODE;
  if (embedded) environment.ELECTRON_RUN_AS_NODE = "1";
  const { stdout } = await execFileAsync(executable, ["-p", "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})"], {
    env: environment, timeout: 5000, windowsHide: true, maxBuffer: 16384,
  });
  const observed = JSON.parse(stdout.trim());
  if (observed.platform !== platform || observed.arch !== arch) throw new Error(`Automation runtime platform/architecture mismatch: expected ${platform}/${arch}, observed ${observed.platform}/${observed.arch}`);
  const host = require(join(assets.appRoot, "electron", "automation-host.js"));
  const candidate = { executable, embedded };
  const capability = await host.probeRuntime(candidate, { environment, platform, arch });
  if (expectUnsupported && capability) throw new Error("Expected automation degradation, but this runtime supports Node 24 SQLite");
  const dataDirectory = await mkdtemp(join(tmpdir(), "pi-automation-package-probe-"));
  const supervisor = host.createAutomationSupervisor({
    appRoot: assets.appRoot, entry: join(assets.hubRoot, "host", "main.mjs"), dataDirectory,
    homeDirectory: tmpdir(), candidates: [candidate], environment, platform, arch,
    startTimeoutMs: 8000,
  });
  try {
    const status = await supervisor.setEnabled(true);
    if (!capability) {
      if (status.state !== "unavailable" || status.reason !== "runtime-unavailable") throw new Error("Unsupported automation runtime did not degrade safely");
      return { supported: false, ...observed, reason: "runtime-unavailable", degraded: true };
    }
    if (status.state !== "ready") throw new Error(`Built automation hub failed its runtime startup probe: ${status.reason ?? status.state}`);
    await supervisor.setEnabled(false);
    if (supervisor.getStatus().state !== "disabled") throw new Error("Built automation hub did not stop cleanly");
    return { supported: true, ...observed, hubStarted: true };
  } finally {
    await supervisor.stop({ force: true, timeoutMs: 1000 });
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function argument(args, name, fallback) {
  const inline = args.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const directory = argument(args, "--dir", PROJECT_ROOT);
    const assets = verifyAutomationPackage(directory);
    const result = { assets: "complete", modules: assets.modules, sourceHash: assets.sourceHash, upstreamCommit: assets.upstreamCommit };
    if (args.includes("--probe")) {
      const embedded = args.includes("--electron") || args.includes("--embedded");
      const executable = argument(args, "--runtime", args.includes("--electron") ? require("electron") : process.execPath);
      result.runtime = await verifyAutomationRuntime(directory, {
        executable, embedded, platform: argument(args, "--platform", process.platform), arch: argument(args, "--arch", process.arch),
        expectUnsupported: args.includes("--expect-unsupported"),
      });
      if (!result.runtime.supported && !args.includes("--expect-unsupported")) throw new Error("Automation runtime is unavailable; Node 24 with SQLite is required");
    }
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[verify-automation-package] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
