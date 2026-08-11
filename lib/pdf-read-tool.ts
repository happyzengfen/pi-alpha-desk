import { defineTool } from "@earendil-works/pi-coding-agent";
import { readFile, realpath } from "fs/promises";
import path from "path";
import { Type } from "typebox";
import { extractText, getDocumentProxy } from "unpdf";

const DEFAULT_PAGE_COUNT = 10;
const MAX_PAGE_COUNT = 20;

const readPdfSchema = Type.Object({
  path: Type.String({ description: "Path to the PDF file (relative or absolute)" }),
  startPage: Type.Optional(Type.Integer({
    description: "First page to read (1-indexed)",
    minimum: 1,
  })),
  pageCount: Type.Optional(Type.Integer({
    description: `Number of pages to read (maximum ${MAX_PAGE_COUNT})`,
    minimum: 1,
    maximum: MAX_PAGE_COUNT,
  })),
});

export interface PdfReadDetails {
  totalPages: number;
  startPage: number;
  endPage: number;
}

function hasPdfHeader(data: Buffer): boolean {
  return data.subarray(0, 1024).toString("latin1").includes("%PDF-");
}

function formatPdfPages(
  pages: string[],
  totalPages: number,
  startPage: number,
  endPage: number,
): string {
  const sections = pages.map((page, index) => {
    const text = page.trim();
    return `--- Page ${startPage + index} ---\n${text || "[No extractable text on this page]"}`;
  });
  const continuation = endPage < totalPages
    ? `\n\n[Showing pages ${startPage}-${endPage} of ${totalPages}. Use startPage=${endPage + 1} to continue.]`
    : "";
  return `[PDF document: ${totalPages} page${totalPages === 1 ? "" : "s"}]\n\n${sections.join("\n\n")}${continuation}`;
}

export async function extractPdfText(
  filePath: string,
  startPage = 1,
  pageCount = DEFAULT_PAGE_COUNT,
): Promise<{ text: string; details: PdfReadDetails }> {
  const data = await readFile(filePath);
  if (!hasPdfHeader(data)) throw new Error("File does not contain a PDF header");

  const pdf = await getDocumentProxy(Uint8Array.from(data));
  const extracted = await extractText(pdf);
  const pages = extracted.text;
  if (startPage > extracted.totalPages) {
    throw new Error(`startPage ${startPage} is beyond the end of the PDF (${extracted.totalPages} pages)`);
  }

  const endPage = Math.min(extracted.totalPages, startPage + pageCount - 1);
  const selectedPages = pages.slice(startPage - 1, endPage);
  return {
    text: formatPdfPages(selectedPages, extracted.totalPages, startPage, endPage),
    details: { totalPages: extracted.totalPages, startPage, endPage },
  };
}

export function createPdfReadTool(cwd: string) {
  return defineTool({
    name: "read_pdf",
    label: "read PDF",
    description: "Extract paginated text from a local PDF file. Use this instead of read for .pdf files. Reads 10 pages by default and supports page-by-page continuation for large documents.",
    promptSnippet: "Extract paginated text from PDF files",
    promptGuidelines: [
      "Use read_pdf instead of read for local PDF files.",
      "Read only the PDF page ranges needed for the task, and continue with startPage when the result reports more pages.",
      "If a page has no extractable text, treat it as image-based or scanned and use an available rendering or OCR workflow.",
    ],
    parameters: readPdfSchema,
    async execute(_toolCallId, { path: requestedPath, startPage = 1, pageCount = DEFAULT_PAGE_COUNT }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await realpath(path.isAbsolute(requestedPath)
        ? requestedPath
        : path.resolve(cwd, requestedPath));
      if (path.extname(absolutePath).toLowerCase() !== ".pdf") {
        throw new Error("read_pdf only supports .pdf files");
      }

      try {
        const result = await extractPdfText(absolutePath, startPage, pageCount);
        if (signal?.aborted) throw new Error("Operation aborted");
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read PDF "${requestedPath}": ${message}`);
      }
    },
  });
}
