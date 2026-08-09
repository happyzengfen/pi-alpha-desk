#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_SOURCE = resolve(PROJECT_ROOT, "..", "pi");

const PACKAGES = [
  { directory: "packages/tui", name: "@earendil-works/pi-tui", build: "build" },
  { directory: "packages/ai", name: "@earendil-works/pi-ai", build: "build:offline" },
  { directory: "packages/agent", name: "@earendil-works/pi-agent-core", build: "build" },
  { directory: "packages/protocol", name: "@earendil-works/pi-protocol", build: "build" },
  { directory: "packages/client", name: "@earendil-works/pi-client", build: "build" },
  { directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent", build: "build" },
];

function printUsage() {
  console.log(`Usage: npm run pi:sync-local -- [options]

Builds local pi packages, creates commit-stamped snapshots, and installs them
without modifying pi-web-desktop's registry fallback dependencies or lockfile.

Options:
  --source <dir>       pi repository path (default: ${DEFAULT_SOURCE})
  --skip-install-deps  fail instead of installing missing pi build dependencies
  --verify             verify the currently installed local snapshot only
  --restore            reinstall the latest generated snapshot without rebuilding pi
  --os <platform>      npm target OS for --restore (for example win32)
  --cpu <arch>         npm target CPU for --restore (for example x64)
  --help               show this help
`);
}

function parseArgs() {
  const options = {
    source: DEFAULT_SOURCE,
    installDependencies: true,
    verifyOnly: false,
    restoreOnly: false,
    targetOs: undefined,
    targetCpu: undefined,
  };
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--source") {
      const value = args[++i];
      if (!value) throw new Error("--source requires a directory");
      options.source = resolve(value);
      continue;
    }
    if (arg === "--skip-install-deps") {
      options.installDependencies = false;
      continue;
    }
    if (arg === "--verify") {
      options.verifyOnly = true;
      continue;
    }
    if (arg === "--restore") {
      options.restoreOnly = true;
      continue;
    }
    if (arg === "--os") {
      const value = args[++i];
      if (!value) throw new Error("--os requires a platform");
      options.targetOs = value;
      continue;
    }
    if (arg === "--cpu") {
      const value = args[++i];
      if (!value) throw new Error("--cpu requires an architecture");
      options.targetCpu = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
  return result.stdout?.trim() ?? "";
}

function git(source, args) {
  return execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageSlug(name) {
  return name.slice(name.indexOf("/") + 1);
}

function packedPackageSlug(name) {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name;
}

function findPackedTarball(directory, packageName, version) {
  const prefix = `${packedPackageSlug(packageName)}-${version}.tgz`;
  const match = readdirSync(directory).find((file) => file === prefix);
  if (!match) throw new Error(`Packed tarball not found for ${packageName}@${version}`);
  return join(directory, match);
}

function rewriteLocalDependencies(packageJson, localVersions) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!packageJson[field]) continue;
    for (const [name, version] of localVersions) {
      if (name in packageJson[field]) packageJson[field][name] = version;
    }
  }
}

function validateSource(source) {
  const rootPackagePath = join(source, "package.json");
  if (!existsSync(rootPackagePath)) throw new Error(`pi package.json not found: ${rootPackagePath}`);
  const rootPackage = readJson(rootPackagePath);
  if (rootPackage.name !== "pi-monorepo") {
    throw new Error(`Expected pi-monorepo at ${source}, found ${rootPackage.name ?? "unnamed package"}`);
  }
  for (const pkg of PACKAGES) {
    const packagePath = join(source, pkg.directory, "package.json");
    if (!existsSync(packagePath)) throw new Error(`Required pi package not found: ${packagePath}`);
    const manifest = readJson(packagePath);
    if (manifest.name !== pkg.name) {
      throw new Error(`${packagePath} has name ${manifest.name}, expected ${pkg.name}`);
    }
  }
}

function installSourceDependencies(source, installDependencies) {
  if (existsSync(join(source, "node_modules"))) return;
  if (!installDependencies) {
    throw new Error(`pi dependencies are missing at ${join(source, "node_modules")}`);
  }
  run("npm", ["ci", "--ignore-scripts"], { cwd: source });
}

function buildPackages(source) {
  const modelDataPath = join(source, "packages", "ai", "src", "providers", "data", "amazon-bedrock.json");
  if (!existsSync(modelDataPath)) {
    run("npm", ["run", "hydrate:model-data"], { cwd: source });
  }
  for (const pkg of PACKAGES) {
    const cwd = join(source, pkg.directory);
    run("npm", ["run", "clean"], { cwd });
    run("npm", ["run", pkg.build], { cwd });
  }
}

function createSnapshotPackage(source, pkg, stagingRoot, snapshotVersion, sourceMetadata, localVersions) {
  const sourceDirectory = join(source, pkg.directory);
  const stagingDirectory = join(stagingRoot, packageSlug(pkg.name));
  cpSync(sourceDirectory, stagingDirectory, {
    recursive: true,
    filter: (entry) => basename(entry) !== "node_modules",
  });

  const packagePath = join(stagingDirectory, "package.json");
  const packageJson = readJson(packagePath);
  packageJson.version = snapshotVersion;
  rewriteLocalDependencies(packageJson, localVersions);
  packageJson.files = [...new Set([...(packageJson.files ?? []), "pi-local-source.json"])];
  if (pkg.name === "@earendil-works/pi-coding-agent") {
    const shrinkwrapPath = join(stagingDirectory, "npm-shrinkwrap.json");
    const shrinkwrap = readJson(shrinkwrapPath);
    shrinkwrap.version = snapshotVersion;
    shrinkwrap.packages[""].version = snapshotVersion;
    rewriteLocalDependencies(shrinkwrap.packages[""], localVersions);
    writeJson(shrinkwrapPath, shrinkwrap);
  }
  writeJson(packagePath, packageJson);
  writeJson(join(stagingDirectory, "pi-local-source.json"), {
    commit: sourceMetadata.commit,
    shortCommit: sourceMetadata.shortCommit,
    describe: sourceMetadata.describe,
    package: pkg.name,
    snapshotVersion,
  });
  return stagingDirectory;
}

function packSnapshots(source, outputDirectory, sourceMetadata) {
  const stagingRoot = mkdtempSync(join(tmpdir(), "pi-web-local-pi-"));
  const localVersions = new Map(
    PACKAGES.map((pkg) => [pkg.name, `${readJson(join(source, pkg.directory, "package.json")).version}+local.${sourceMetadata.shortCommit}`]),
  );
  const tarballs = [];

  try {
    mkdirSync(outputDirectory, { recursive: true });
    for (const pkg of PACKAGES) {
      const version = localVersions.get(pkg.name);
      const stagingDirectory = createSnapshotPackage(
        source,
        pkg,
        stagingRoot,
        version,
        sourceMetadata,
        localVersions,
      );
      run("npm", ["pack", "--ignore-scripts", "--pack-destination", outputDirectory], {
        cwd: stagingDirectory,
      });
      tarballs.push({
        name: pkg.name,
        version,
        path: findPackedTarball(outputDirectory, pkg.name, version),
      });
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return tarballs;
}

function installSnapshots(tarballs, options = {}) {
  const installRoot = join(PROJECT_ROOT, ".local-pi", "resolved-install");
  const stagedRoot = join(PROJECT_ROOT, ".local-pi", "installing");
  const backupRoot = join(PROJECT_ROOT, ".local-pi", "backup");
  const dependencies = Object.fromEntries(tarballs.map((entry) => [entry.name, `file:${entry.path}`]));
  try {
    rmSync(installRoot, { recursive: true, force: true });
    mkdirSync(installRoot, { recursive: true });
    writeJson(join(installRoot, "package.json"), {
      private: true,
      dependencies,
      overrides: dependencies,
    });
    const installArgs = [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--omit=dev",
      "--install-strategy=nested",
    ];
    if (options.targetOs) installArgs.push("--os", options.targetOs);
    if (options.targetCpu) installArgs.push("--cpu", options.targetCpu);
    run("npm", installArgs, { cwd: installRoot });

    rmSync(stagedRoot, { recursive: true, force: true });
    for (const entry of tarballs) {
      const installedDirectory = join(installRoot, "node_modules", ...entry.name.split("/"));
      const stagedDirectory = join(stagedRoot, ...entry.name.split("/"));
      mkdirSync(dirname(stagedDirectory), { recursive: true });
      cpSync(installedDirectory, stagedDirectory, { recursive: true });
    }

    rmSync(backupRoot, { recursive: true, force: true });
    const moved = [];
    try {
      for (const entry of tarballs) {
        const targetDirectory = join(PROJECT_ROOT, "node_modules", ...entry.name.split("/"));
        const backupDirectory = join(backupRoot, ...entry.name.split("/"));
        const stagedDirectory = join(stagedRoot, ...entry.name.split("/"));
        if (existsSync(targetDirectory)) {
          mkdirSync(dirname(backupDirectory), { recursive: true });
          renameSync(targetDirectory, backupDirectory);
        }
        mkdirSync(dirname(targetDirectory), { recursive: true });
        renameSync(stagedDirectory, targetDirectory);
        moved.push({ targetDirectory, backupDirectory });
      }
    } catch (error) {
      for (const { targetDirectory, backupDirectory } of moved.reverse()) {
        rmSync(targetDirectory, { recursive: true, force: true });
        if (existsSync(backupDirectory)) {
          mkdirSync(dirname(targetDirectory), { recursive: true });
          renameSync(backupDirectory, targetDirectory);
        }
      }
      throw error;
    }
  } finally {
    rmSync(stagedRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
}

function findLatestManifest() {
  const snapshotsRoot = join(PROJECT_ROOT, ".local-pi", "snapshots");
  if (!existsSync(snapshotsRoot)) throw new Error("No local pi snapshots found; run npm run pi:sync-local first");
  const manifests = readdirSync(snapshotsRoot)
    .map((directory) => join(snapshotsRoot, directory, "manifest.json"))
    .filter(existsSync)
    .sort((a, b) => readJson(b).generatedAt.localeCompare(readJson(a).generatedAt));
  if (manifests.length === 0) throw new Error("No local pi snapshot manifest found");
  return manifests[0];
}

function verifySnapshots(tarballs, commit) {
  for (const entry of tarballs) {
    const packageDirectory = join(PROJECT_ROOT, "node_modules", ...entry.name.split("/"));
    const packageJson = readJson(join(packageDirectory, "package.json"));
    const sourceMetadata = readJson(join(packageDirectory, "pi-local-source.json"));
    if (packageJson.version !== entry.version) {
      throw new Error(`${entry.name} resolved to ${packageJson.version}, expected ${entry.version}`);
    }
    if (sourceMetadata.commit !== commit) {
      throw new Error(`${entry.name} source commit is ${sourceMetadata.commit}, expected ${commit}`);
    }
    if (entry.sha256 && sha256(entry.path) !== entry.sha256) {
      throw new Error(`${entry.name} tarball checksum does not match manifest`);
    }
    if (entry.name in readJson(join(PROJECT_ROOT, "package.json")).dependencies) {
      try {
        run("npm", ["ls", entry.name, "--omit=dev", "--depth=0"], { cwd: PROJECT_ROOT });
      } catch {
        throw new Error(`${entry.name} is not resolvable from the project dependency tree`);
      }
    }
  }

  const nestedPiRoot = join(
    PROJECT_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
  );
  if (existsSync(nestedPiRoot)) {
    const nested = readdirSync(nestedPiRoot).filter((name) => name.startsWith("pi-"));
    if (nested.length > 0) {
      throw new Error(`Nested registry pi packages remain under pi-coding-agent: ${nested.join(", ")}`);
    }
  }
}

const options = parseArgs();
if (options.verifyOnly || options.restoreOnly) {
  const manifestPath = findLatestManifest();
  const manifest = readJson(manifestPath);
  const tarballs = manifest.packages.map((entry) => ({
    ...entry,
    path: join(dirname(manifestPath), entry.file),
  }));
  if (options.restoreOnly) {
    installSnapshots(tarballs, options);
  }
  verifySnapshots(tarballs, manifest.commit);
  console.log(`Local pi snapshot ${options.restoreOnly ? "restored and " : ""}verified: ${manifest.describe} (${manifest.commit})`);
  process.exit(0);
}

validateSource(options.source);

const status = git(options.source, ["status", "--porcelain"]);
if (status.length > 0) {
  throw new Error("pi source tree is dirty; commit or restore it before creating a reproducible snapshot");
}

const commit = git(options.source, ["rev-parse", "HEAD"]);
const shortCommit = commit.slice(0, 9);
const describe = git(options.source, ["describe", "--tags", "--always"]);
const branch = git(options.source, ["branch", "--show-current"]);
const generatedAt = new Date().toISOString();
const sourceMetadata = {
  sourcePath: options.source,
  commit,
  shortCommit,
  describe,
  branch,
  dirty: false,
  generatedAt,
};

installSourceDependencies(options.source, options.installDependencies);
buildPackages(options.source);
const statusAfterBuild = git(options.source, ["status", "--porcelain"]);
if (statusAfterBuild.length > 0) {
  throw new Error("pi build modified the source tree; restore it before creating a snapshot");
}

const snapshotDirectory = join(PROJECT_ROOT, ".local-pi", "snapshots", shortCommit);
rmSync(snapshotDirectory, { recursive: true, force: true });
mkdirSync(snapshotDirectory, { recursive: true });
const tarballs = packSnapshots(options.source, snapshotDirectory, sourceMetadata).map((entry) => ({
  ...entry,
  sha256: sha256(entry.path),
}));

writeJson(join(snapshotDirectory, "manifest.json"), {
  ...sourceMetadata,
  packages: tarballs.map((entry) => ({
    name: entry.name,
    version: entry.version,
    file: relative(snapshotDirectory, entry.path),
    sha256: entry.sha256,
  })),
});

installSnapshots(tarballs);
verifySnapshots(tarballs, commit);

console.log("\nLocal pi snapshot installed successfully:");
console.log(`  source: ${options.source}`);
console.log(`  commit: ${commit}`);
console.log(`  describe: ${describe}`);
console.log(`  artifacts: ${snapshotDirectory}`);
for (const entry of tarballs) console.log(`  ${entry.name}: ${entry.version}`);
