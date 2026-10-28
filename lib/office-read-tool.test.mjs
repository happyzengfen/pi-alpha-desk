import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "@e965/xlsx";
import JSZip from "jszip";
import { createJiti } from "jiti";

const {
  extractSpreadsheetText,
  extractWordText,
  renderSpreadsheetPreviewBody,
  renderPptxPreviewBody,
} = await createJiti(import.meta.url).import("./office-files.ts");
const {
  createSpreadsheetReadTool,
  createWordReadTool,
} = await createJiti(import.meta.url).import("./office-read-tool.ts");

async function writeWorkbook(filePath) {
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["Item", "Amount", "Formula"],
    ["Revenue", 1200, { t: "n", v: 1200, f: "B2" }],
    ["Cost", 450],
  ]);
  const unsafe = XLSX.utils.aoa_to_sheet([["<script>alert(1)</script>"]]);
  XLSX.utils.book_append_sheet(workbook, summary, "Summary");
  XLSX.utils.book_append_sheet(workbook, unsafe, "Unsafe & data");
  await writeFile(filePath, XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }));
}

test("extracts a selected worksheet range with formulas and continuation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-office-"));
  const filePath = path.join(root, "budget.xlsx");
  try {
    await writeWorkbook(filePath);
    const result = extractSpreadsheetText(filePath, "Summary", 1, 2);

    assert.equal(result.details.sheetName, "Summary");
    assert.equal(result.details.totalRows, 3);
    assert.match(result.text, /Workbook sheets: Summary, Unsafe & data/);
    assert.match(result.text, /Revenue\t1200\t1200 \[=B2\]/);
    assert.match(result.text, /Use startRow=3 to continue/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renders spreadsheet values as escaped, navigable HTML", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-office-html-"));
  const filePath = path.join(root, "budget.xlsx");
  try {
    await writeWorkbook(filePath);
    const html = renderSpreadsheetPreviewBody(filePath);

    assert.match(html, /href="#sheet-0"/);
    assert.match(html, /Unsafe &amp; data/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document tools resolve cwd-relative Word and spreadsheet paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-office-tools-"));
  const spreadsheetPath = path.join(root, "budget.xlsx");
  const wordPath = path.join(root, "memo.docx");
  try {
    await writeWorkbook(spreadsheetPath);
    await copyFile(
      new URL("../node_modules/mammoth/test/test-data/single-paragraph.docx", import.meta.url),
      wordPath,
    );

    const spreadsheetResult = await createSpreadsheetReadTool(root).execute(
      "spreadsheet-call",
      { path: "budget.xlsx", sheet: "Summary", startRow: 2, rowCount: 1 },
    );
    assert.match(spreadsheetResult.content[0].text, /Revenue/);

    assert.equal(await extractWordText(wordPath), "Walking on imported air");
    const wordResult = await createWordReadTool(root).execute("word-call", { path: "memo.docx" });
    assert.match(wordResult.content[0].text, /Walking on imported air/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads Excel UTF-16 delimited exports without corrupting text or identifiers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-office-utf16-"));
  try {
    const filePath = path.join(root, "export.tsv");
    await writeFile(filePath, "\ufeff姓名\t编号\n张三\t001234567890123456789\n", "utf16le");

    const result = extractSpreadsheetText(filePath);
    assert.match(result.text, /姓名\t编号/);
    assert.match(result.text, /张三\t001234567890123456789/);
    assert.match(renderSpreadsheetPreviewBody(filePath), /张三/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PPTX outline follows presentation order and decodes text before escaping HTML", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-office-pptx-"));
  try {
    const zip = new JSZip();
    zip.file("ppt/presentation.xml", '<p:presentation><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>');
    zip.file("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>');
    zip.file("ppt/slides/slide1.xml", '<a:t>A &amp; B &lt;script&gt; &#x4E2D;&#25991;</a:t>');
    zip.file("ppt/slides/slide2.xml", '<a:t xml:space="preserve">First &quot;slide&quot;</a:t>');
    const filePath = path.join(root, "reordered.pptx");
    await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

    const html = await renderPptxPreviewBody(filePath);
    assert.match(html, /第 1 页.*First &quot;slide&quot;/);
    assert.match(html, /第 2 页.*A &amp; B &lt;script&gt; 中文/);
    assert.ok(html.indexOf("First") < html.indexOf("A &amp; B"));
    assert.doesNotMatch(html, /&amp;amp;|&amp;lt;|<script>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
