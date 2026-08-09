#!/usr/bin/env node

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const MACHO_64_MAGIC = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;

function findApplication(releaseDirectory) {
  const candidates = readdirSync(releaseDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(releaseDirectory, entry.name));
  if (candidates.length !== 1) {
    throw new Error(`Expected one .app in ${releaseDirectory}, found ${candidates.length}`);
  }
  return candidates[0];
}

function findExecutable(applicationPath) {
  const macosDirectory = join(applicationPath, "Contents", "MacOS");
  const candidates = readdirSync(macosDirectory)
    .map((name) => join(macosDirectory, name))
    .filter((candidate) => statSync(candidate).isFile());
  if (candidates.length !== 1) {
    throw new Error(`Expected one application executable in ${macosDirectory}, found ${candidates.length}`);
  }
  return candidates[0];
}

function verifyArm64MachO(executablePath) {
  const handle = openSync(executablePath, "r");
  try {
    const header = Buffer.alloc(8);
    if (readSync(handle, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Invalid Mach-O executable: ${executablePath}`);
    }
    if (header.readUInt32LE(0) !== MACHO_64_MAGIC) {
      throw new Error(`Expected a 64-bit little-endian Mach-O executable: ${executablePath}`);
    }
    if (header.readUInt32LE(4) !== CPU_TYPE_ARM64) {
      throw new Error(`Expected an arm64 Mach-O executable: ${executablePath}`);
    }
  } finally {
    closeSync(handle);
  }
}

export function verifyMacPackage(releaseDirectory) {
  const applicationPath = findApplication(resolve(releaseDirectory));
  const executablePath = findExecutable(applicationPath);
  verifyArm64MachO(executablePath);

  const resources = join(applicationPath, "Contents", "Resources");
  const appRoot = join(resources, "app");
  const requiredPaths = [
    join(appRoot, "electron", "main.js"),
    join(appRoot, "electron", "preload.js"),
    join(appRoot, "node_modules", "next", "dist", "bin", "next"),
    join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    join(appRoot, "node_modules", "undici", "package.json"),
    join(appRoot, ".next", "BUILD_ID"),
    join(appRoot, "public", "icon-mac.png"),
  ];
  const missing = requiredPaths.filter((candidate) => !existsSync(candidate));
  const bundledSkills = join(resources, "bundled-skills");
  if (!existsSync(bundledSkills) || !readdirSync(bundledSkills, { withFileTypes: true }).some((entry) => (
    entry.isDirectory() && existsSync(join(bundledSkills, entry.name, "SKILL.md"))
  ))) {
    missing.push(join(bundledSkills, "(no SKILL.md)"));
  }
  if (missing.length > 0) {
    throw new Error(`macOS package is incomplete:\n${missing.map((candidate) => `- ${candidate}`).join("\n")}`);
  }
  return { application: basename(applicationPath), executable: basename(executablePath), machine: "arm64" };
}

function parseReleaseDirectory(argv) {
  const raw = argv.find((argument) => argument.startsWith("--dir="));
  if (raw) return raw.slice("--dir=".length);
  const index = argv.indexOf("--dir");
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return join(PROJECT_ROOT, "release", "mac-arm64");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyMacPackage(parseReleaseDirectory(process.argv.slice(2)));
    console.log(`[verify-macos-package] OK ${result.application} / ${result.executable} (${result.machine})`);
  } catch (error) {
    console.error(`[verify-macos-package] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
