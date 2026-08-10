import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const {
  BUNDLED_PI_PACKAGE_NAMES,
  getBundledPiPackageResourceLoaderOptions,
  hasConfiguredPiPackage,
  resolveBundledPiPackageRoot,
} = await createJiti(import.meta.url).import("./bundled-pi-packages.ts");

function settings(globalPackages = [], projectPackages = []) {
  return {
    getGlobalSettings: () => ({ packages: globalPackages }),
    getProjectSettings: () => ({ packages: projectPackages }),
  };
}

test("resolves bundled unscoped and scoped Pi package roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-packages-"));
  const subagentsRoot = path.join(root, "node_modules", "pi-subagents");
  const goalRoot = path.join(root, "node_modules", "@narumitw", "pi-goal");
  try {
    await mkdir(subagentsRoot, { recursive: true });
    await mkdir(goalRoot, { recursive: true });
    await writeFile(path.join(subagentsRoot, "package.json"), "{}", "utf8");
    await writeFile(path.join(goalRoot, "package.json"), "{}", "utf8");

    const searchRoots = [path.join(root, "nested", "server")];
    assert.equal(resolveBundledPiPackageRoot("pi-subagents", searchRoots), subagentsRoot);
    assert.equal(resolveBundledPiPackageRoot("@narumitw/pi-goal", searchRoots), goalRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads every bundled package that is not explicitly configured", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const options = getBundledPiPackageResourceLoaderOptions(
    settings(["npm:pi-subagents"], [{ source: "npm:@narumitw/pi-goal@0.50.0" }]),
    [projectRoot],
  );

  assert.equal(hasConfiguredPiPackage(settings(["npm:pi-subagents"]), "pi-subagents"), true);
  assert.deepEqual(
    options.additionalExtensionPaths.map((packageRoot) => path.basename(packageRoot)),
    ["pi-mcp-adapter", "pi-web-access", "rpiv-ask-user-question"],
  );
});

test("loads all bundled extensions and package resources through Pi", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-packages-loader-"));
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  try {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const options = getBundledPiPackageResourceLoaderOptions(settings(), [projectRoot]);
    assert.equal(options.additionalExtensionPaths.length, BUNDLED_PI_PACKAGE_NAMES.length);

    const loader = new DefaultResourceLoader({ cwd, agentDir, ...options });
    await loader.reload();

    const extensions = loader.getExtensions();
    const loadedPackages = new Set(extensions.extensions.map((extension) => {
      const packageRoot = options.additionalExtensionPaths.find((candidate) => (
        extension.resolvedPath.startsWith(candidate)
      ));
      return packageRoot && BUNDLED_PI_PACKAGE_NAMES.find((name) => packageRoot.endsWith(name));
    }));
    const tools = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
    const skills = loader.getSkills().skills.map((skill) => skill.name);

    assert.deepEqual(extensions.errors, []);
    assert.ok(BUNDLED_PI_PACKAGE_NAMES.every((packageName) => loadedPackages.has(packageName)));
    assert.ok(tools.includes("subagent"));
    assert.ok(tools.includes("subagent_wait"));
    assert.ok(skills.includes("pi-subagents"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
