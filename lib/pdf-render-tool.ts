/**
 * pdf-render-tool — 后端 PDF 页面渲染（node 环境，绕开浏览器兼容问题）
 *
 * 方案：用 pdfjs（legacy build，node 兼容）+ @napi-rs/canvas 把 PDF 每页渲染成 PNG，
 * 前端以 <img> 显示。兼容所有浏览器（纯图片），翻页=换图，缩放=CSS 尺寸。
 *
 * 缓存（刷新提速核心）：
 *  - 页面图缓存：按 PDF 路径 + mtimeMs(毫秒) + size 为键，页面 PNG 落盘缓存。
 *    文件未变 → 直接命中返回（零解析、零渲染）；文件变了（如 PPT 重新转换导出）
 *    → 键变化 → 自动重新渲染，旧缓存自然失效。
 *  - 文档解析缓存：最近使用的 PDF 解析结果（30s 内复用），避免 N 页请求各自
 *    重新解析整个 PDF（串行解析 N 次 ≈ 每页多花 0.5-1s）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getPdfRuntime } from "./pdf-runtime";

const DEFAULT_SCALE = 1.5;
const PAGE_CACHE_ROOT = process.env.PDF_PAGE_CACHE_DIR ?? path.join(os.tmpdir(), "pi-alpha-desk-pdf-pages");
const DOC_CACHE_TTL_MS = 30_000;

export class PdfRendererUnavailableError extends Error {
  constructor() {
    super("Native PDF rendering is unavailable on this platform");
  }
}

async function loadDocument(filePath: string): Promise<PDFDocumentProxy> {
  const { pdfjs, options } = await getPdfRuntime();
  const data = new Uint8Array(fs.readFileSync(filePath));
  return pdfjs.getDocument({ data, ...options }).promise;
}

/** 文档解析缓存：同文件（mtime+size 未变）30 秒内复用同一解析结果 */
const docCache = new Map<string, { mtimeMs: number; size: number; ts: number; doc: PDFDocumentProxy }>();

function evictStaleDocs() {
  const now = Date.now();
  for (const [file, entry] of docCache) {
    if (now - entry.ts > DOC_CACHE_TTL_MS) {
      entry.doc.destroy().catch(() => {});
      docCache.delete(file);
    }
  }
}

async function loadDocumentCached(filePath: string): Promise<PDFDocumentProxy> {
  const stat = fs.statSync(filePath);
  const hit = docCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && Date.now() - hit.ts < DOC_CACHE_TTL_MS) {
    return hit.doc;
  }
  if (hit) {
    hit.doc.destroy().catch(() => {});
    docCache.delete(filePath);
  }
  const doc = await loadDocument(filePath);
  docCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, ts: Date.now(), doc });
  evictStaleDocs();
  return doc;
}

/** 页面图缓存键：渲染版本 + PDF 路径 + mtimeMs(毫秒) + size + scale */
function pageCacheDir(filePath: string, scale: number): { dir: string; mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    const key = crypto.createHash("sha256").update(`v2:${filePath}:${stat.mtimeMs}:${stat.size}:${scale}`).digest("hex").slice(0, 16);
    return { dir: path.join(PAGE_CACHE_ROOT, key), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * 渲染指定页为 PNG（带页面图缓存 + 文档解析缓存）。
 * @returns PNG buffer + 页数 + 渲染尺寸
 */
export async function renderPdfPage(
  filePath: string,
  pageNumber: number,
  scale = DEFAULT_SCALE,
): Promise<{ png: Buffer; pageCount: number; width: number; height: number }> {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new RangeError("Invalid PDF page number");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Invalid PDF scale");
  const cache = pageCacheDir(filePath, scale);
  const pagePng = cache ? path.join(cache.dir, `page-${pageNumber}.png`) : null;
  if (cache && pagePng) {
    const metaPath = path.join(cache.dir, `page-${pageNumber}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.mtimeMs === cache.mtimeMs && meta.size === cache.size && fs.existsSync(pagePng)) {
        // 页面图缓存命中：零解析、零渲染
        return { png: fs.readFileSync(pagePng), pageCount: meta.pageCount, width: meta.width, height: meta.height };
      }
    } catch { /* 缓存缺失/损坏 → 重新渲染 */ }
  }

  // Unsupported optional native addons must not prevent other file routes loading.
  const { createCanvas } = await import("@napi-rs/canvas").catch(() => {
    throw new PdfRendererUnavailableError();
  });
  const doc = await loadDocumentCached(filePath);
  const pageCount = doc.numPages;
  const pageIndex = Math.min(Math.max(1, pageNumber), pageCount);
  const page = await doc.getPage(pageIndex);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
  const png = canvas.toBuffer("image/png");
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);

  // 每页独立保存尺寸，避免混合页面大小的文档覆盖其它页的元数据。
  if (cache && pagePng) {
    try {
      fs.mkdirSync(cache.dir, { recursive: true });
      fs.writeFileSync(pagePng, png);
      fs.writeFileSync(
        path.join(cache.dir, `page-${pageNumber}.json`),
        JSON.stringify({ mtimeMs: cache.mtimeMs, size: cache.size, pageCount, width, height }),
      );
    } catch { /* 缓存写失败不影响返回 */ }
  }

  return { png, pageCount, width, height };
}
