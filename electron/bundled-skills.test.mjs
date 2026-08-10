import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { installBundledSkills, resolveBundledSkillsTargetRoot } = require("./bundled-skills.js");

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
  for (const skillName of ["guizang-ppt-skill", "windows-word-docx", "pdf"]) {
    await access(new URL(`../bundled-skills/${skillName}/SKILL.md`, import.meta.url));
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
