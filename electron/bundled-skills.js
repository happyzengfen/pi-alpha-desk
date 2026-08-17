"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BUNDLED_SKILL_MARKER = ".pi-alpha-desk-bundled.json";
const IGNORED_BUNDLED_SKILL_FILES = new Set([BUNDLED_SKILL_MARKER, ".DS_Store"]);
const LEGACY_BUNDLED_SKILL_HASHES = {
  // Skills bundled by 0.8.6-f, before managed skill updates existed.
  "guizang-ppt-skill": new Set(["a38eb67542b8651b69350a125fed4fc9c01a461dc2d67bb4911ce66c2eb246fa"]),
  pdf: new Set(["d108cf2b36355ab37eb5962933f4d09785ec002f3105c506129320209306b9d2"]),
  "windows-word-docx": new Set(["4c750df2a19d6d49c0f23174db8f86c8c116819a84033087607658c814d2e2e2"]),
};

function skillHash(skillRoot) {
  const hash = crypto.createHash("sha256");
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED_BUNDLED_SKILL_FILES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name).split(path.sep).join("/");
      hash.update(relativePath).update("\0");
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isSymbolicLink()) hash.update(`symlink:${fs.readlinkSync(absolutePath)}`);
      else if (entry.isFile()) hash.update(fs.readFileSync(absolutePath));
      hash.update("\0");
    }
  };
  visit(skillRoot);
  return hash.digest("hex");
}

function legacySkillHash(skillRoot) {
  return crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(skillRoot, "SKILL.md")))
    .digest("hex");
}

function existingSkillHash(skillRoot) {
  try {
    return skillHash(skillRoot);
  } catch {
    return undefined;
  }
}

function readInstalledHash(skillRoot) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(skillRoot, BUNDLED_SKILL_MARKER), "utf8"));
    return typeof marker.skillHash === "string" ? marker.skillHash : undefined;
  } catch {
    return undefined;
  }
}

function writeInstalledHash(skillRoot, hash) {
  fs.writeFileSync(
    path.join(skillRoot, BUNDLED_SKILL_MARKER),
    `${JSON.stringify({ version: 1, skillHash: hash })}\n`,
    "utf8",
  );
}

function resolveBundledSkillsTargetRoot({ homeDirectory, configuredAgentDir }) {
  let agentDirectory = configuredAgentDir?.trim();
  if (!agentDirectory) agentDirectory = path.join(homeDirectory, ".pi", "agent");
  else if (agentDirectory === "~") agentDirectory = homeDirectory;
  else if (agentDirectory.startsWith("~/") || agentDirectory.startsWith("~\\")) {
    agentDirectory = path.join(homeDirectory, agentDirectory.slice(2));
  } else {
    agentDirectory = path.resolve(agentDirectory);
  }
  return path.join(agentDirectory, "skills");
}

const SUMMARY_NAME = ".bundled-summary.json";

/** 读 target 侧同步标记（O(1)，不存在返回 null） */
function readSummary(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SUMMARY_NAME), "utf8"));
  } catch {
    return null;
  }
}

/** 写 target 侧同步标记（仅写 target，source 侧不落盘——打包目录保持干净） */
function writeSummary(dir, data) {
  try {
    fs.writeFileSync(path.join(dir, SUMMARY_NAME), JSON.stringify(data));
  } catch {
    // 目录只读等异常忽略
  }
}

/**
 * 打包资源直接使用 manifest 作为 O(1) 指纹；测试或开发目录没有
 * manifest 时回退到内容哈希。目录 mtime 不能代表子文件内容变化。
 */
function computeSourceFingerprint(sourceRoot) {
  const manifestPath = path.join(sourceRoot, "manifest.json");
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex");
  } catch {
    // Synthetic test fixtures and development directories may not have a manifest.
  }

  const parts = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
    parts.push(`${entry.name}:${skillHash(source)}`);
  }
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

async function installBundledSkills({ sourceRoot, targetRoot, logger = console }) {
  if (!fs.existsSync(sourceRoot)) return [];

  // 快速路径：source 指纹与 target 记录一致 → 已同步，跳过全量遍历（每次启动省 1-3s）
  const targetSummary = readSummary(targetRoot);
  const fingerprint = computeSourceFingerprint(sourceRoot);
  if (targetSummary?.installedSourceFingerprint === fingerprint) {
    return [];
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const results = [];

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    // 让出事件循环：install 与 startServer 并行时，避免全量复制/哈希阻塞服务就绪检测
    await new Promise((resolve) => setImmediate(resolve));

    if (!entry.isDirectory()) continue;

    const source = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;

    const target = path.join(targetRoot, entry.name);
    if (fs.existsSync(target)) {
      const currentHash = existingSkillHash(target);
      const installedHash = readInstalledHash(target);
      const isUnmodifiedManagedCopy = installedHash !== undefined && installedHash === currentHash;
      let isKnownLegacyCopy = false;
      try {
        isKnownLegacyCopy = LEGACY_BUNDLED_SKILL_HASHES[entry.name]?.has(legacySkillHash(target)) === true;
      } catch {
        // An existing non-skill directory belongs to the user and is preserved.
      }
      if (!isUnmodifiedManagedCopy && !isKnownLegacyCopy) {
        results.push({ name: entry.name, status: "preserved" });
        continue;
      }

      const sourceHash = skillHash(source);
      fs.cpSync(source, target, { recursive: true, force: true });
      writeInstalledHash(target, sourceHash);
      logger.info?.(`[Electron] Updated bundled skill: ${entry.name}`);
      results.push({ name: entry.name, status: "updated" });
      continue;
    }

    fs.cpSync(source, target, { recursive: true, errorOnExist: true });
    writeInstalledHash(target, skillHash(source));
    logger.info?.(`[Electron] Installed bundled skill: ${entry.name}`);
    results.push({ name: entry.name, status: "installed" });
  }

  // 同步完成：记录 target 侧已安装的 source 指纹，供下次启动快速路径使用
  writeSummary(targetRoot, { installedSourceFingerprint: fingerprint });
  return results;
}

module.exports = { installBundledSkills, resolveBundledSkillsTargetRoot, skillHash };
