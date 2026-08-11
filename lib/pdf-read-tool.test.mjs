import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createPdfReadTool, extractPdfText } = await createJiti(import.meta.url).import("./pdf-read-tool.ts");

function makePdf(pageTexts) {
  const pageObjectIds = pageTexts.map((_, index) => 3 + index);
  const contentObjectIds = pageTexts.map((_, index) => 3 + pageTexts.length + index);
  const fontObjectId = 3 + pageTexts.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
    ...pageTexts.map((_, index) => (
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`
    )),
    ...pageTexts.map((pageText) => {
      const stream = `BT /F1 12 Tf 72 720 Td (${pageText}) Tj ET`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

test("extracts selected PDF pages with continuation metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-pdf-"));
  const filePath = path.join(root, "report.pdf");
  try {
    await writeFile(filePath, makePdf(["First page text", "Second page text"]));
    const result = await extractPdfText(filePath, 1, 1);

    assert.deepEqual(result.details, { totalPages: 2, startPage: 1, endPage: 1 });
    assert.match(result.text, /First page text/);
    assert.doesNotMatch(result.text, /Second page text/);
    assert.match(result.text, /Use startPage=2 to continue/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_pdf resolves cwd-relative paths and returns paginated text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-pdf-tool-"));
  try {
    await writeFile(path.join(root, "manual.pdf"), makePdf(["Desktop PDF content"]));
    const tool = createPdfReadTool(root);
    const result = await tool.execute("call-1", { path: "manual.pdf" });

    assert.deepEqual(result.details, { totalPages: 1, startPage: 1, endPage: 1 });
    assert.match(result.content[0].text, /Desktop PDF content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_pdf rejects files that are not PDFs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-pdf-invalid-"));
  try {
    await writeFile(path.join(root, "fake.pdf"), "plain text", "utf8");
    const tool = createPdfReadTool(root);
    await assert.rejects(
      tool.execute("call-2", { path: "fake.pdf" }),
      /Unable to read PDF.*does not contain a PDF header/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
