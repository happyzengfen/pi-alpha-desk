"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MIN_NODE_VERSION = [22, 19, 0];
const MAX_NATIVE_PROBES = 32;

function parseNodeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  return match ? match.slice(1, 4).map(Number) : null;
}

function isSupportedNodeVersion(value) {
  const version = parseNodeVersion(value);
  if (!version) return false;
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (version[index] > MIN_NODE_VERSION[index]) return true;
    if (version[index] < MIN_NODE_VERSION[index]) return false;
  }
  return true;
}

function addVersionedNodeCandidates(candidates, root, suffix) {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(root, entry.name, ...suffix));
    }
  } catch {
    // Optional version-manager directory.
  }
}

function collectNodeCandidates({ env, homeDirectory, platform }) {
  const executableName = platform === "win32" ? "node.exe" : "node";
  const candidates = [];
  if (env.PI_ALPHA_DESK_NODE) candidates.push(env.PI_ALPHA_DESK_NODE);

  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(directory, executableName));
  }

  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Programs", "nodejs", executableName));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "nodejs", executableName));
  } else {
    candidates.push(
      path.join(homeDirectory, ".local", "bin", executableName),
      path.join(homeDirectory, ".volta", "bin", executableName),
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/usr/bin/node",
    );
    addVersionedNodeCandidates(
      candidates,
      path.join(homeDirectory, ".local", "share", "fnm", "node-versions"),
      ["installation", "bin", executableName],
    );
    addVersionedNodeCandidates(
      candidates,
      path.join(homeDirectory, ".nvm", "versions", "node"),
      ["bin", executableName],
    );
    addVersionedNodeCandidates(
      candidates,
      path.join(homeDirectory, ".nodenv", "versions"),
      ["bin", executableName],
    );
    addVersionedNodeCandidates(
      candidates,
      path.join(homeDirectory, ".asdf", "installs", "nodejs"),
      ["bin", executableName],
    );
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || !fs.existsSync(candidate)) return false;
    let identity = path.resolve(candidate);
    try {
      identity = fs.realpathSync(candidate);
    } catch {
      // The existence check above is enough when realpath is unavailable.
    }
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function inspectNodeExecutable(executable, env) {
  const result = spawnSync(
    executable,
    ["-p", "JSON.stringify({version:process.version,modules:process.versions.modules,platform:process.platform,arch:process.arch})"],
    { encoding: "utf8", env, timeout: 5_000 },
  );
  if (result.status !== 0) return null;
  try {
    const inspection = JSON.parse(result.stdout.trim());
    return isSupportedNodeVersion(inspection.version) ? { executable, ...inspection } : null;
  } catch {
    return null;
  }
}

function isPlatformNativeAddon(filePath, platform, arch) {
  const normalized = filePath.split(path.sep).join("/").toLowerCase();
  if (normalized.includes("/build/release/")) return true;

  const platformNames = platform === "win32" ? ["win32", "windows"] : [platform];
  const archNames = arch === "arm64" ? ["arm64", "aarch64"] : [arch];
  return platformNames.some((platformName) => normalized.includes(platformName))
    && archNames.some((archName) => normalized.includes(archName));
}

function collectNativeAddonProbes(agentDir, platform, arch) {
  const nodeModulesRoot = path.join(agentDir, "npm", "node_modules");
  if (!fs.existsSync(nodeModulesRoot)) return [];

  const probes = [];
  const visit = (directory, depth) => {
    if (depth > 9 || probes.length >= MAX_NATIVE_PROBES) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (probes.length >= MAX_NATIVE_PROBES) break;
      if (entry.name === ".cache" || entry.name === ".git") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".node") && isPlatformNativeAddon(fullPath, platform, arch)) {
        probes.push(fullPath);
      }
    }
  };
  visit(nodeModulesRoot, 0);

  return probes.sort((left, right) => {
    const leftRelease = left.includes(`${path.sep}build${path.sep}Release${path.sep}`) ? 0 : 1;
    const rightRelease = right.includes(`${path.sep}build${path.sep}Release${path.sep}`) ? 0 : 1;
    return leftRelease - rightRelease || left.localeCompare(right);
  });
}

function probeNativeAddons(executable, probes, env) {
  if (probes.length === 0) return { loaded: 0, abiMismatches: 0 };
  const script = [
    "const paths=JSON.parse(process.env.PI_ALPHA_DESK_NATIVE_PROBES);",
    "let loaded=0,abiMismatches=0;",
    "for(const addonPath of paths){",
    "try{const addon={exports:{}};process.dlopen(addon,addonPath);loaded+=1;}",
    "catch(error){const message=String(error?.message??error);if(message.includes('NODE_MODULE_VERSION')||message.includes('different Node.js version'))abiMismatches+=1;}",
    "}",
    "console.log(JSON.stringify({loaded,abiMismatches}));",
  ].join("");
  const result = spawnSync(executable, ["-e", script], {
    encoding: "utf8",
    env: { ...env, PI_ALPHA_DESK_NATIVE_PROBES: JSON.stringify(probes) },
    timeout: 15_000,
  });
  if (result.status !== 0) return { loaded: 0, abiMismatches: Number.MAX_SAFE_INTEGER };
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { loaded: 0, abiMismatches: Number.MAX_SAFE_INTEGER };
  }
}

function selectNodeCandidate(candidates, embeddedNodeMajor) {
  return [...candidates].sort((left, right) => {
    if (left.abiMismatches !== right.abiMismatches) return left.abiMismatches - right.abiMismatches;
    if (left.loaded !== right.loaded) return right.loaded - left.loaded;
    const leftMajorDistance = Math.abs(parseNodeVersion(left.version)[0] - embeddedNodeMajor);
    const rightMajorDistance = Math.abs(parseNodeVersion(right.version)[0] - embeddedNodeMajor);
    return leftMajorDistance - rightMajorDistance || left.order - right.order;
  })[0];
}

function resolveServerNodeExecutable({
  env = process.env,
  homeDirectory,
  agentDir,
  platform = process.platform,
  arch = process.arch,
  embeddedNodeVersion = process.versions.node,
  logger = console,
}) {
  const candidates = collectNodeCandidates({ env, homeDirectory, platform });
  const probes = collectNativeAddonProbes(agentDir, platform, arch);
  const inspected = candidates
    .map((executable, order) => {
      const details = inspectNodeExecutable(executable, env);
      if (!details || details.platform !== platform || details.arch !== arch) return null;
      return { ...details, ...probeNativeAddons(executable, probes, env), order };
    })
    .filter(Boolean);

  const explicit = env.PI_ALPHA_DESK_NODE
    ? inspected.find((candidate) => path.resolve(candidate.executable) === path.resolve(env.PI_ALPHA_DESK_NODE))
    : null;
  const embeddedMajor = parseNodeVersion(embeddedNodeVersion)?.[0] ?? MIN_NODE_VERSION[0];
  const selected = explicit ?? selectNodeCandidate(inspected, embeddedMajor);
  if (!selected) return undefined;

  logger.info?.(
    `[Electron] Using standalone Node ${selected.version} (${selected.modules}) for the server: ${selected.executable}`,
  );
  return selected.executable;
}

function prependExecutableDirectory(env, executable) {
  if (!executable) return env;
  const directory = path.dirname(executable);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  return { ...env, [pathKey]: currentPath ? `${directory}${path.delimiter}${currentPath}` : directory };
}

module.exports = {
  collectNativeAddonProbes,
  collectNodeCandidates,
  isSupportedNodeVersion,
  prependExecutableDirectory,
  resolveServerNodeExecutable,
  selectNodeCandidate,
};
