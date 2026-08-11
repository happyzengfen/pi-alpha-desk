#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const ELF_MACHINES = {
  arm64: 183,
  x64: 62,
};
const BUNDLED_PI_PACKAGES = [
  ["pi-subagents"],
  ["pi-mcp-adapter"],
  ["pi-web-access"],
  ["@juicesharp", "rpiv-ask-user-question"],
  ["@narumitw", "pi-goal"],
];

function findProductExecutable(unpackedDirectory) {
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
  const preferredPath = join(unpackedDirectory, packageJson.build?.productName ?? packageJson.name);
  if (existsSync(preferredPath)) return preferredPath;

  const ignored = new Set(["chrome-sandbox", "chrome_crashpad_handler"]);
  const candidates = readdirSync(unpackedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !ignored.has(entry.name))
    .map((entry) => join(unpackedDirectory, entry.name))
    .filter((candidate) => (statSync(candidate).mode & 0o111) !== 0);
  if (candidates.length !== 1) {
    throw new Error(`Expected one application executable in ${unpackedDirectory}, found ${candidates.length}`);
  }
  return candidates[0];
}

function verifyElf(executablePath, expectedArchitecture) {
  const expectedMachine = ELF_MACHINES[expectedArchitecture];
  if (!expectedMachine) {
    throw new Error(`Unsupported Linux architecture: ${expectedArchitecture}`);
  }

  const handle = openSync(executablePath, "r");
  try {
    const header = Buffer.alloc(20);
    if (readSync(handle, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Invalid ELF executable: ${executablePath}`);
    }
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`Missing ELF signature: ${executablePath}`);
    }
    if (header[4] !== 2 || header[5] !== 1) {
      throw new Error(`Expected a 64-bit little-endian ELF executable: ${executablePath}`);
    }
    if (header.readUInt16LE(18) !== expectedMachine) {
      throw new Error(`Expected an ${expectedArchitecture} ELF executable: ${executablePath}`);
    }
  } finally {
    closeSync(handle);
  }
}

export function verifyLinuxPackage(unpackedDirectory, expectedArchitecture = "x64") {
  const root = resolve(unpackedDirectory);
  if (!existsSync(root)) throw new Error(`Linux unpacked directory not found: ${root}`);

  const executablePath = findProductExecutable(root);
  verifyElf(executablePath, expectedArchitecture);

  const appRoot = join(root, "resources", "app");
  const requiredPaths = [
    join(appRoot, "electron", "main.js"),
    join(appRoot, "electron", "preload.js"),
    join(appRoot, "node_modules", "next", "dist", "bin", "next"),
    join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    ...BUNDLED_PI_PACKAGES.map((segments) => join(appRoot, "node_modules", ...segments, "package.json")),
    join(appRoot, "node_modules", "@e965", "xlsx", "package.json"),
    join(appRoot, "node_modules", "unpdf", "package.json"),
    join(appRoot, "node_modules", "word-extractor", "package.json"),
    join(appRoot, "node_modules", "undici", "package.json"),
    join(appRoot, ".next", "BUILD_ID"),
    join(appRoot, "public", "icon.png"),
  ];
  const missing = requiredPaths.filter((candidate) => !existsSync(candidate));
  const bundledSkills = join(root, "resources", "bundled-skills");
  if (!existsSync(bundledSkills) || !readdirSync(bundledSkills, { withFileTypes: true }).some((entry) => (
    entry.isDirectory() && existsSync(join(bundledSkills, entry.name, "SKILL.md"))
  ))) {
    missing.push(join(bundledSkills, "(no SKILL.md)"));
  }
  if (missing.length > 0) {
    throw new Error(`Linux package is incomplete:\n${missing.map((candidate) => `- ${candidate}`).join("\n")}`);
  }

  return { executable: basename(executablePath), machine: expectedArchitecture, root };
}

function parseArgument(argv, name, fallback) {
  const raw = argv.find((argument) => argument.startsWith(`--${name}=`));
  if (raw) return raw.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  return fallback;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = verifyLinuxPackage(
      parseArgument(args, "dir", join(PROJECT_ROOT, "release", "linux-unpacked")),
      parseArgument(args, "arch", "x64"),
    );
    console.log(`[verify-linux-package] OK ${result.executable} (${result.machine})`);
  } catch (error) {
    console.error(`[verify-linux-package] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
