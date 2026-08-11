import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "bundled-plugins", "manifest.json");
const checkOnly = process.argv.includes("--check");

const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(projectRoot, "package-lock.json"), "utf8"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const names = manifest.plugins.map((plugin) => plugin.name);

assert.equal(new Set(names).size, names.length, "bundled-plugins/manifest.json contains duplicate package names");

const nextPlugins = await Promise.all(manifest.plugins.map(async (plugin) => {
  const dependencyVersion = packageJson.dependencies?.[plugin.name];
  const lockEntry = packageLock.packages?.[`node_modules/${plugin.name}`];
  assert.equal(typeof dependencyVersion, "string", `${plugin.name} must be a direct dependency`);
  assert.ok(lockEntry?.version, `${plugin.name} is missing from package-lock.json`);
  assert.equal(dependencyVersion, lockEntry.version, `${plugin.name} must use an exact bundled version`);

  const installedPackage = JSON.parse(await readFile(
    path.join(projectRoot, "node_modules", ...plugin.name.split("/"), "package.json"),
    "utf8",
  ));
  assert.equal(installedPackage.version, lockEntry.version, `${plugin.name} in node_modules is out of sync`);

  return {
    ...plugin,
    version: lockEntry.version,
    license: installedPackage.license ?? lockEntry.license ?? "UNKNOWN",
    integrity: lockEntry.integrity,
    description: installedPackage.description ?? "",
  };
}));

const nextManifest = { ...manifest, appVersion: packageJson.version, plugins: nextPlugins };
const nextText = `${JSON.stringify(nextManifest, null, 2)}\n`;
const currentText = await readFile(manifestPath, "utf8");

if (checkOnly) {
  assert.equal(currentText, nextText, "bundled-plugins/manifest.json is stale; run npm run plugins:manifest");
  console.log(`Bundled plugins manifest is current for ${packageJson.version}.`);
} else {
  await writeFile(manifestPath, nextText, "utf8");
  console.log(`Updated bundled plugins manifest for ${packageJson.version}.`);
}
