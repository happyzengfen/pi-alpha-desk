"use strict";

const fs = require("fs");
const path = require("path");

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

function installBundledSkills({ sourceRoot, targetRoot, logger = console }) {
  if (!fs.existsSync(sourceRoot)) return [];

  fs.mkdirSync(targetRoot, { recursive: true });
  const results = [];

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const source = path.join(sourceRoot, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;

    const target = path.join(targetRoot, entry.name);
    if (fs.existsSync(target)) {
      results.push({ name: entry.name, status: "preserved" });
      continue;
    }

    fs.cpSync(source, target, { recursive: true, errorOnExist: true });
    logger.info?.(`[Electron] Installed bundled skill: ${entry.name}`);
    results.push({ name: entry.name, status: "installed" });
  }

  return results;
}

module.exports = { installBundledSkills, resolveBundledSkillsTargetRoot };
