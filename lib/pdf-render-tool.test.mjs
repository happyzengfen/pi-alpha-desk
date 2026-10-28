import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PDFDocument, rgb } from "pdf-lib";

const run = promisify(execFile);
const readerUrl = new URL("./pdf-read-tool.ts", import.meta.url).href;
const rendererUrl = new URL("./pdf-render-tool.ts", import.meta.url).href;
const script = `
  import assert from "node:assert/strict";
  import { createJiti } from "jiti";
  const jiti = createJiti(${JSON.stringify(import.meta.url)});
  const { extractPdfText } = await jiti.import(${JSON.stringify(readerUrl)});
  const { renderPdfPage } = await jiti.import(${JSON.stringify(rendererUrl)});
  const [filePath, order] = process.argv.slice(1);
  async function read() {
    const result = await extractPdfText(filePath);
    assert.match(result.text, /PDF runtime regression/);
    assert.equal(result.details.totalPages, 1);
  }
  async function render() {
    const result = await renderPdfPage(filePath, 1);
    assert.equal(result.pageCount, 1);
    assert.equal(result.width, 150);
    assert.equal(result.height, 150);
    assert.equal(result.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const context = createCanvas(result.width, result.height).getContext("2d");
    context.drawImage(await loadImage(result.png), 0, 0);
    assert.deepEqual([...context.getImageData(75, 75, 1, 1).data], [255, 0, 0, 255]);
  }
  if (order === "read-first") {
    await read();
    await render();
  } else if (order === "render-first") {
    await render();
    await read();
  } else {
    await Promise.all([read(), read(), render()]);
  }
  await read();
`;

for (const order of ["read-first", "render-first", "concurrent"]) {
  test(`PDF text extraction and preview share a compatible runtime (${order})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-pdf-render-"));
    try {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([100, 100]);
      page.drawRectangle({ x: 25, y: 25, width: 50, height: 50, color: rgb(1, 0, 0) });
      page.drawText("PDF runtime regression", { x: 5, y: 90, size: 6 });
      const filePath = path.join(root, "report.pdf");
      await writeFile(filePath, await pdf.save());
      const result = await run(process.execPath, ["--input-type=module", "-e", script, filePath, order], {
        env: { ...process.env, PDF_PAGE_CACHE_DIR: path.join(root, "cache") },
        timeout: 30_000,
      });
      assert.equal(result.stderr, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("PDF preview renders standard fonts and caches each page size and scale independently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-pdf-render-cache-"));
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]).drawText("HELLO", { x: 5, y: 40, size: 20 });
    pdf.addPage([200, 100]);
    const filePath = path.join(root, "mixed-pages.pdf");
    await writeFile(filePath, await pdf.save());
    await run(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { createJiti } from "jiti";
      import { createCanvas, loadImage } from "@napi-rs/canvas";
      const { renderPdfPage } = await createJiti(${JSON.stringify(import.meta.url)}).import(${JSON.stringify(rendererUrl)});
      const filePath = process.argv[1];
      const first = await renderPdfPage(filePath, 1, 1);
      const context = createCanvas(100, 100).getContext("2d");
      context.drawImage(await loadImage(first.png), 0, 0);
      const pixels = context.getImageData(0, 0, 100, 100).data;
      let darkPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) darkPixels++;
      assert.ok(darkPixels > 100, "standard PDF text must render visibly");
      assert.deepEqual([first.width, first.height], [100, 100]);
      const second = await renderPdfPage(filePath, 2, 1);
      assert.deepEqual([second.width, second.height], [200, 100]);
      const cachedFirst = await renderPdfPage(filePath, 1, 1);
      assert.deepEqual([cachedFirst.width, cachedFirst.height], [100, 100]);
      const larger = await renderPdfPage(filePath, 1, 2);
      assert.deepEqual([larger.width, larger.height], [200, 200]);
    `, filePath], {
      env: { ...process.env, PDF_PAGE_CACHE_DIR: path.join(root, "cache") },
      timeout: 30_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
