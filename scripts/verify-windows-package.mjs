#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PE_MACHINE_AMD64 = 0x8664;
const BUNDLED_PI_PACKAGES = [
  ["pi-subagents"],
  ["pi-mcp-adapter"],
  ["pi-web-access"],
  ["@juicesharp", "rpiv-ask-user-question"],
  ["@narumitw", "pi-goal"],
];

function readPeMachine(executablePath) {
  const handle = openSync(executablePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    if (readSync(handle, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error(`Invalid PE executable: ${executablePath}`);
    }
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Missing MZ header: ${executablePath}`);
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (readSync(handle, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error(`Invalid PE header: ${executablePath}`);
    }
    if (peHeader.toString("ascii", 0, 4) !== "PE\0\0") {
      throw new Error(`Missing PE signature: ${executablePath}`);
    }
    return peHeader.readUInt16LE(4);
  } finally {
    closeSync(handle);
  }
}

function findProductExecutable(unpackedDirectory) {
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const preferredName = `${packageJson.build?.productName ?? packageJson.name}.exe`;
  const preferredPath = join(unpackedDirectory, preferredName);
  if (existsSync(preferredPath)) return preferredPath;

  const executables = readdirSync(unpackedDirectory)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .filter((name) => name.toLowerCase() !== "elevate.exe");
  if (executables.length !== 1) {
    throw new Error(`Expected one application executable in ${unpackedDirectory}, found ${executables.length}`);
  }
  return join(unpackedDirectory, executables[0]);
}

function hasDirectoryEntry(directory) {
  return existsSync(directory) && readdirSync(directory).length > 0;
}

function findClipboardNativeModule(appNodeModules) {
  const packagePath = join(
    "@mariozechner",
    "clipboard-win32-x64-msvc",
    "clipboard.win32-x64-msvc.node",
  );
  const candidates = [
    join(appNodeModules, packagePath),
    join(
      appNodeModules,
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      packagePath,
    ),
  ];
  return candidates.find((path) => existsSync(path));
}

export function verifyWindowsPackage(unpackedDirectory) {
  const root = resolve(unpackedDirectory);
  if (!existsSync(root)) throw new Error(`Windows unpacked directory not found: ${root}`);

  const appNodeModules = join(root, "resources", "app", "node_modules");

  const executablePath = findProductExecutable(root);
  const machine = readPeMachine(executablePath);
  if (machine !== PE_MACHINE_AMD64) {
    throw new Error(
      `Expected an x64 Windows executable (PE machine 0x8664), found 0x${machine.toString(16)}: ${executablePath}`,
    );
  }

  const requiredPaths = [
    join(root, "resources", "app", "electron", "main.js"),
    join(root, "resources", "app", "electron", "preload.js"),
    join(appNodeModules, "next", "dist", "bin", "next"),
    join(appNodeModules, "@earendil-works", "pi-coding-agent", "package.json"),
    ...BUNDLED_PI_PACKAGES.map((segments) => join(appNodeModules, ...segments, "package.json")),
    join(appNodeModules, "@e965", "xlsx", "package.json"),
    join(appNodeModules, "unpdf", "package.json"),
    join(appNodeModules, "word-extractor", "package.json"),
    join(appNodeModules, "undici", "package.json"),
    join(root, "resources", "app", ".next", "BUILD_ID"),
    join(root, "resources", "app", "bundled-plugins", "manifest.json"),
    join(root, "resources", "app", "public", "icon.ico"),
  ];

  const missing = requiredPaths.filter((path) => !existsSync(path));
  if (!findClipboardNativeModule(appNodeModules)) {
    missing.push(join(appNodeModules, "**", "clipboard.win32-x64-msvc.node"));
  }
  const nextExternalPackages = join(root, "resources", "app", ".next", "node_modules");
  if (existsSync(nextExternalPackages) && !hasDirectoryEntry(nextExternalPackages)) {
    missing.push(`${nextExternalPackages} (empty)`);
  }

  const bundledSkills = join(root, "resources", "bundled-skills");
  if (!existsSync(bundledSkills)) {
    missing.push(bundledSkills);
  } else {
    if (!existsSync(join(bundledSkills, "manifest.json"))) {
      missing.push(join(bundledSkills, "manifest.json"));
    }
    const hasSkillManifest = readdirSync(bundledSkills, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && existsSync(join(bundledSkills, entry.name, "SKILL.md")),
    );
    if (!hasSkillManifest) missing.push(`${bundledSkills} (no SKILL.md)`);
  }

  if (missing.length > 0) {
    throw new Error(`Windows package is incomplete:\n${missing.map((path) => `- ${path}`).join("\n")}`);
  }

  return {
    executable: basename(executablePath),
    machine: "x64",
    root,
  };
}

function parseUnpackedDirectory(argv) {
  const raw = argv.find((arg) => arg.startsWith("--dir="));
  if (raw) return raw.slice("--dir=".length);
  const dirIndex = argv.indexOf("--dir");
  if (dirIndex !== -1 && argv[dirIndex + 1]) return argv[dirIndex + 1];
  return join(PROJECT_ROOT, "release", "win-unpacked");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyWindowsPackage(parseUnpackedDirectory(process.argv.slice(2)));
    console.log(`[verify-windows-package] OK ${result.executable} (${result.machine})`);
  } catch (error) {
    console.error(`[verify-windows-package] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
