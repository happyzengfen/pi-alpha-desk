import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("DOCX conversion does not SaveAs a document owned by the user", async () => {
  const source = await readFile(new URL("./docx-convert-tool.ts", import.meta.url), "utf8");

  assert.match(source, /ExportAsFixedFormat\(\$OutputPath, \[int\]17\)/);
  assert.match(source, /if \(-not \$openedFromDisk\) \{ throw \}/);
});

test("PPTX conversion exports user presentations without renaming them", async () => {
  const source = await readFile(new URL("./pptx-convert-tool.ts", import.meta.url), "utf8");
  assert.match(source, /ExportAsFixedFormat\(\$OutputPath, \[int\]2\)/);
  assert.match(source, /if \(-not \$openedFromDisk\) \{ throw \}/);
});

test("Office conversions match open documents by full path", async () => {
  for (const name of ["docx", "pptx"]) {
    const source = await readFile(new URL(`./${name}-convert-tool.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\$name -eq \$origName/);
    assert.match(source, /if \(\$fullName -eq \$origFull\)/);
  }
});

test("failed Office conversion preserves the last successful cached PDF", async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "pi-office-conversion-"));
  let failConversion = false;
  let exitFailureAfterExport = false;
  const run = t.mock.method(childProcess, "execFileSync", (_exe, args) => {
    const outputPath = args[args.indexOf("-OutputPath") + 1];
    // Office scripts remove their export destination before writing a new PDF.
    fs.rmSync(outputPath, { force: true });
    fs.writeFileSync(outputPath, failConversion ? "partial invalid PDF" : "%PDF test export");
    if (failConversion || exitFailureAfterExport) {
      const error = new Error("Office export failed");
      if (exitFailureAfterExport) error.stdout = `OK:${outputPath}`;
      throw error;
    }
    return `OK:${outputPath}`;
  });
  syncBuiltinESMExports();
  const previousDocxCache = process.env.DOCX_CACHE_DIR;
  const previousPptxCache = process.env.PPTX_CACHE_DIR;
  process.env.DOCX_CACHE_DIR = path.join(root, "docx-cache");
  process.env.PPTX_CACHE_DIR = path.join(root, "pptx-cache");
  try {
    const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
    const { ensureDocxPdf } = await jiti.import("./docx-convert-tool.ts");
    const { ensurePptxPdf } = await jiti.import("./pptx-convert-tool.ts");
    for (const [extension, convert] of [["docx", ensureDocxPdf], ["pptx", ensurePptxPdf]]) {
      failConversion = false;
      exitFailureAfterExport = false;
      const inputPath = path.join(root, `source.${extension}`);
      fs.writeFileSync(inputPath, "original office file");
      const first = await convert(inputPath);
      assert.ok(first && "pdf" in first);
      assert.equal(fs.readFileSync(first.pdf, "utf8"), "%PDF test export");
      const callsAfterExport = run.mock.callCount();
      assert.deepEqual(await convert(inputPath), first);
      assert.equal(run.mock.callCount(), callsAfterExport, "unchanged source uses cache");

      fs.appendFileSync(inputPath, " updated content");
      failConversion = true;
      const failed = await convert(inputPath);
      assert.deepEqual(failed, { pdf: first.pdf, stale: true });
      assert.equal(fs.readFileSync(first.pdf, "utf8"), "%PDF test export", "partial export never replaces cache");
      assert.doesNotMatch(fs.readdirSync(path.dirname(first.pdf)).join(" "), /pending\.pdf/);

      failConversion = false;
      exitFailureAfterExport = true;
      assert.deepEqual(await convert(inputPath), { pdf: first.pdf, stale: true }, "failed process is not cached even with an OK marker");

      exitFailureAfterExport = false;
      const refreshed = await convert(inputPath);
      assert.deepEqual(refreshed, { pdf: first.pdf });
      const callsAfterRefresh = run.mock.callCount();
      assert.deepEqual(await convert(inputPath), refreshed);
      assert.equal(run.mock.callCount(), callsAfterRefresh);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousDocxCache === undefined) delete process.env.DOCX_CACHE_DIR;
    else process.env.DOCX_CACHE_DIR = previousDocxCache;
    if (previousPptxCache === undefined) delete process.env.PPTX_CACHE_DIR;
    else process.env.PPTX_CACHE_DIR = previousPptxCache;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
