import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { installBundledSkills, resolveBundledSkillsTargetRoot, skillHash } = require("./bundled-skills.js");

test("resolves bundled skills into the active Pi agent directory", () => {
  const homeDirectory = path.resolve(path.sep, "users", "pi-user");
  const configuredAgentDirectory = path.resolve(path.sep, "custom", "agent");

  assert.equal(
    resolveBundledSkillsTargetRoot({ homeDirectory }),
    path.join(homeDirectory, ".pi", "agent", "skills"),
  );
  assert.equal(
    resolveBundledSkillsTargetRoot({ homeDirectory, configuredAgentDir: configuredAgentDirectory }),
    path.join(configuredAgentDirectory, "skills"),
  );
  assert.equal(
    resolveBundledSkillsTargetRoot({ homeDirectory, configuredAgentDir: "~/custom-agent" }),
    path.join(homeDirectory, "custom-agent", "skills"),
  );
});

test("packages the bundled skill directory as an Electron resource", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.ok(packageJson.build.extraResources.some(
    (entry) => entry.from === "bundled-skills" && entry.to === "bundled-skills",
  ));
});

test("includes the local office skills in desktop resources", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../bundled-skills/manifest.json", import.meta.url), "utf8"));

  assert.equal(manifest.appVersion, packageJson.version);
  assert.deepEqual(
    manifest.skills.map((skill) => skill.name),
    ["guizang-ppt-skill", "office-viewer", "pdf", "windows-word-docx"],
  );
  for (const skill of manifest.skills) {
    const skillRoot = fileURLToPath(new URL(`../bundled-skills/${skill.name}/`, import.meta.url));
    await access(path.join(skillRoot, "SKILL.md"));
    assert.equal(skill.contentHash, skillHash(skillRoot));
  }
});

test("ignores operating-system metadata when hashing bundled skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-bundled-skill-hash-"));

  try {
    await writeFile(path.join(root, "SKILL.md"), "stable skill", "utf8");
    const before = skillHash(root);
    await writeFile(path.join(root, ".DS_Store"), "local metadata", "utf8");
    assert.equal(skillHash(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installs bundled skills and preserves existing user copies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-bundled-skills-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");

  try {
    await mkdir(path.join(sourceRoot, "new-skill"), { recursive: true });
    await writeFile(path.join(sourceRoot, "new-skill", "SKILL.md"), "new bundled skill", "utf8");
    await mkdir(path.join(sourceRoot, "existing-skill"), { recursive: true });
    await writeFile(path.join(sourceRoot, "existing-skill", "SKILL.md"), "bundled version", "utf8");
    await mkdir(path.join(sourceRoot, "not-a-skill"), { recursive: true });
    await writeFile(path.join(sourceRoot, "not-a-skill", "README.md"), "ignore me", "utf8");

    await mkdir(path.join(targetRoot, "existing-skill"), { recursive: true });
    await writeFile(path.join(targetRoot, "existing-skill", "SKILL.md"), "user version", "utf8");

    const results = installBundledSkills({ sourceRoot, targetRoot, logger: { info() {} } });

    assert.deepEqual(results, [
      { name: "existing-skill", status: "preserved" },
      { name: "new-skill", status: "installed" },
    ]);
    assert.equal(await readFile(path.join(targetRoot, "existing-skill", "SKILL.md"), "utf8"), "user version");
    assert.equal(await readFile(path.join(targetRoot, "new-skill", "SKILL.md"), "utf8"), "new bundled skill");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates an unmodified app-managed skill and preserves later user edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-bundled-skill-update-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  const sourceSkill = path.join(sourceRoot, "managed-skill", "SKILL.md");
  const targetSkill = path.join(targetRoot, "managed-skill", "SKILL.md");
  const sourceAsset = path.join(sourceRoot, "managed-skill", "assets", "notes.txt");
  const targetAsset = path.join(targetRoot, "managed-skill", "assets", "notes.txt");

  try {
    await mkdir(path.dirname(sourceSkill), { recursive: true });
    await mkdir(path.dirname(sourceAsset), { recursive: true });
    await writeFile(sourceSkill, "version one", "utf8");
    await writeFile(sourceAsset, "asset one", "utf8");
    installBundledSkills({ sourceRoot, targetRoot, logger: { info() {} } });

    await writeFile(sourceSkill, "version two", "utf8");
    await writeFile(sourceAsset, "asset two", "utf8");
    assert.deepEqual(
      installBundledSkills({ sourceRoot, targetRoot, logger: { info() {} } }),
      [{ name: "managed-skill", status: "updated" }],
    );
    assert.equal(await readFile(targetSkill, "utf8"), "version two");
    assert.equal(await readFile(targetAsset, "utf8"), "asset two");

    await writeFile(targetAsset, "user customization", "utf8");
    await writeFile(sourceSkill, "version three", "utf8");
    await writeFile(sourceAsset, "asset three", "utf8");
    assert.deepEqual(
      installBundledSkills({ sourceRoot, targetRoot, logger: { info() {} } }),
      [{ name: "managed-skill", status: "preserved" }],
    );
    assert.equal(await readFile(targetSkill, "utf8"), "version two");
    assert.equal(await readFile(targetAsset, "utf8"), "user customization");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
