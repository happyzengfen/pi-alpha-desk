#!/usr/bin/env node

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PE_MACHINES = {
  ia32: 0x014c,
  x64: 0x8664,
  arm64: 0xaa64,
};
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

function findNativeAddon(directory) {
  if (!existsSync(directory)) return undefined;
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findNativeAddon(path);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".node")) {
      return path;
    }
  }
  return undefined;
}

function findClipboardNativeModule(appNodeModules, architecture) {
  if (architecture === "ia32") return undefined;
  const packagePath = join(
    "@mariozechner",
    `clipboard-win32-${architecture}-msvc`,
    `clipboard.win32-${architecture}-msvc.node`,
  );
  const candidates = [
    join(appNodeModules, "@earendil-works", "pi-tui", "native", "win32", "prebuilds", `win32-${architecture}`, "win32-platform.node"),
    join(appNodeModules, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-tui", "native", "win32", "prebuilds", `win32-${architecture}`, "win32-platform.node"),
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

export function verifyWindowsPackage(unpackedDirectory, expectedArchitecture = "x64") {
  const root = resolve(unpackedDirectory);
  if (!existsSync(root)) throw new Error(`Windows unpacked directory not found: ${root}`);
  const expectedMachine = PE_MACHINES[expectedArchitecture];
  if (expectedMachine === undefined) {
    throw new Error(`Unsupported Windows architecture: ${expectedArchitecture}`);
  }

  const appNodeModules = join(root, "resources", "app", "node_modules");

  const executablePath = findProductExecutable(root);
  const machine = readPeMachine(executablePath);
  if (machine !== expectedMachine) {
    throw new Error(
      `Expected an ${expectedArchitecture} Windows executable (PE machine 0x${expectedMachine.toString(16)}), found 0x${machine.toString(16)}: ${executablePath}`,
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
    join(appNodeModules, "pdfjs-dist", "package.json"),
    join(appNodeModules, "pdfjs-dist", "legacy", "build", "pdf.mjs"),
    join(appNodeModules, "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
    join(appNodeModules, "pdfjs-dist", "cmaps", "GB-EUC-H.bcmap"),
    join(appNodeModules, "pdfjs-dist", "cmaps", "Adobe-GB1-UCS2.bcmap"),
    join(appNodeModules, "pdfjs-dist", "standard_fonts", "LiberationSans-Regular.ttf"),
    join(appNodeModules, "mammoth", "package.json"),
    join(appNodeModules, "jszip", "package.json"),
    join(appNodeModules, "@napi-rs", "canvas", "package.json"),
    join(root, "resources", "app", ".next", "BUILD_ID"),
    join(root, "resources", "app", "bundled-plugins", "manifest.json"),
    join(root, "resources", "app", "public", "icon.ico"),
  ];

  const missing = requiredPaths.filter((path) => !existsSync(path));
  const nativePackageDirectories = [];
  // Canvas has no ia32 prebuild; that package uses the browser PDF fallback.
  if (expectedArchitecture !== "ia32") {
    nativePackageDirectories.push(join(
      appNodeModules,
      "@napi-rs",
      `canvas-win32-${expectedArchitecture}-msvc`,
    ));
  }
  const sharpDirectory = join(appNodeModules, "sharp");
  if (existsSync(sharpDirectory)) {
    nativePackageDirectories.push(join(appNodeModules, "@img", `sharp-win32-${expectedArchitecture}`));
  }
  const nextSharpDirectory = join(appNodeModules, "next", "node_modules", "sharp");
  if (existsSync(nextSharpDirectory)) {
    nativePackageDirectories.push(join(
      appNodeModules,
      "next",
      "node_modules",
      "@img",
      `sharp-win32-${expectedArchitecture}`,
    ));
  }
  const keyringDirectory = join(appNodeModules, "@napi-rs", "keyring");
  if (existsSync(keyringDirectory)) {
    nativePackageDirectories.push(join(
      appNodeModules,
      "@napi-rs",
      `keyring-win32-${expectedArchitecture}-msvc`,
    ));
  }
  for (const directory of nativePackageDirectories) {
    const addon = findNativeAddon(directory);
    if (!addon) {
      missing.push(`${directory} (no native addon)`);
    } else {
      const addonMachine = readPeMachine(addon);
      if (addonMachine !== expectedMachine) {
        throw new Error(
          `Expected an ${expectedArchitecture} native addon (PE machine 0x${expectedMachine.toString(16)}), found 0x${addonMachine.toString(16)}: ${addon}`,
        );
      }
    }
  }
  const clipboardModule = findClipboardNativeModule(appNodeModules, expectedArchitecture);
  if (expectedArchitecture !== "ia32" && !clipboardModule) {
    missing.push(`Pi clipboard native helper (win32-${expectedArchitecture})`);
  } else if (clipboardModule?.endsWith("win32-platform.node") && readPeMachine(clipboardModule) !== expectedMachine) {
    throw new Error(`Expected an ${expectedArchitecture} Windows clipboard native helper: ${clipboardModule}`);
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
    machine: expectedArchitecture,
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

function parseArchitecture(argv) {
  const raw = argv.find((arg) => arg.startsWith("--arch="));
  if (raw) return raw.slice("--arch=".length);
  const archIndex = argv.indexOf("--arch");
  return archIndex !== -1 && argv[archIndex + 1] ? argv[archIndex + 1] : "x64";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const result = verifyWindowsPackage(parseUnpackedDirectory(args), parseArchitecture(args));
    console.log(`[verify-windows-package] OK ${result.executable} (${result.machine})`);
  } catch (error) {
    console.error(`[verify-windows-package] ERROR ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
