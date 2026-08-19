import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("preview toolbar uses localized labels and skips image change polling", async () => {
  const source = await readFile(new URL("./PreviewToolbar.tsx", import.meta.url), "utf8");

  assert.match(source, /t\("desktop\.refresh"\)/);
  assert.match(source, /t\("desktop\.fitWidth"\)/);
  assert.match(source, /showRefresh \? filePath : null/);
  assert.doesNotMatch(source, />\s*适应宽度\s*</);
});

test("manual image zoom is not capped at the fitted container width", async () => {
  const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

  assert.match(source, /maxWidth: view\.fitWidth \? "100%" : "none"/);
});

test("Word previews fall back to the existing HTML renderer when COM conversion is unavailable", async () => {
  const fileViewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
  const pdfViewer = await readFile(new URL("./PdfViewer.tsx", import.meta.url), "utf8");

  assert.match(fileViewer, /onUnsupported=\{isWord \? handleWordPdfUnsupported : undefined\}/);
  assert.match(pdfViewer, /if \(onUnsupported\) \{\s*onUnsupported\(\);\s*return;/);
});
