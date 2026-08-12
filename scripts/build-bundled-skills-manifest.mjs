import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { skillHash } = require("../electron/bundled-skills.js");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(projectRoot, "bundled-skills");
const manifestPath = path.join(skillsRoot, "manifest.json");
const checkOnly = process.argv.includes("--check");

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifestNames = manifest.skills.map((skill) => skill.name).sort();

assert.deepEqual(
  manifestNames,
  skillDirectories,
  "bundled-skills/manifest.json must list every bundled skill directory exactly once",
);

const nextManifest = {
  ...manifest,
  appVersion: packageJson.version,
  skills: manifest.skills
    .map((skill) => ({
      ...skill,
      contentHash: skillHash(path.join(skillsRoot, skill.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name)),
};
const nextText = `${JSON.stringify(nextManifest, null, 2)}\n`;
const currentText = await readFile(manifestPath, "utf8");

if (checkOnly) {
  assert.equal(currentText, nextText, "bundled-skills/manifest.json is stale; run npm run skills:manifest");
  console.log(`Bundled skills manifest is current for ${packageJson.version}.`);
} else {
  await writeFile(manifestPath, nextText, "utf8");
  console.log(`Updated bundled skills manifest for ${packageJson.version}.`);
}
