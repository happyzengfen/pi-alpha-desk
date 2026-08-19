import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("DOCX conversion does not SaveAs a document owned by the user", async () => {
  const source = await readFile(new URL("./docx-convert-tool.ts", import.meta.url), "utf8");

  assert.match(source, /ExportAsFixedFormat\(\$OutputPath, \[int\]17\)/);
  assert.match(source, /if \(-not \$openedFromDisk\) \{ throw \}/);
});
