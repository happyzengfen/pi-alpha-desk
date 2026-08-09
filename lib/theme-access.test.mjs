import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { isThemeSetNameSafe } = await createJiti(import.meta.url).import("./theme-access.ts");

test("theme HTTP names cannot contain filesystem paths", () => {
  assert.equal(isThemeSetNameSafe("gruvbox"), true);
  assert.equal(isThemeSetNameSafe("我的主题.json"), true);
  assert.equal(isThemeSetNameSafe("../models.json"), false);
  assert.equal(isThemeSetNameSafe("folder\\theme"), false);
  assert.equal(isThemeSetNameSafe(".."), false);
  assert.equal(isThemeSetNameSafe("theme\0name"), false);
});
