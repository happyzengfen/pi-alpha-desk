/**
 * pdf-render-tool — 后端 PDF 页面渲染（node 环境，绕开浏览器兼容问题）
 *
 * 方案：用 pdfjs（legacy build，node 兼容）+ @napi-rs/canvas 把 PDF 每页渲染成 PNG，
 * 前端以 <img> 显示。兼容所有浏览器（纯图片），翻页=换图，缩放=CSS 尺寸。
 */
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import type { PDFDocumentProxy } from "pdfjs-dist";

const DEFAULT_SCALE = 1.5;

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(canvasAndContext: { canvas: { width: number; height: number } }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: { width: number; height: number } }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function loadDocument(filePath: string): Promise<PDFDocumentProxy> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  return getDocument({ data }).promise;
}

/**
 * 渲染指定页为 PNG。
 * @returns PNG buffer + 页数 + 渲染尺寸
 */
export async function renderPdfPage(
  filePath: string,
  pageNumber: number,
  scale = DEFAULT_SCALE,
): Promise<{ png: Buffer; pageCount: number; width: number; height: number }> {
  const doc = await loadDocument(filePath);
  try {
    const pageCount = doc.numPages;
    const pageIndex = Math.min(Math.max(1, pageNumber), pageCount);
    const page = await doc.getPage(pageIndex);
    const viewport = page.getViewport({ scale });
    const factory = new NodeCanvasFactory();
    const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const png = canvas.toBuffer("image/png");
    return { png, pageCount, width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) };
  } finally {
    await doc.destroy().catch(() => {});
  }
}
