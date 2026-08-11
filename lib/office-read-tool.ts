import { defineTool } from "@earendil-works/pi-coding-agent";
import { realpath } from "fs/promises";
import path from "path";
import { Type } from "typebox";
import { extractSpreadsheetText, extractWordText } from "./office-files";

const WORD_CHUNK_SIZE = 40_000;
const MAX_SPREADSHEET_ROWS = 200;

function resolveToolPath(cwd: string, requestedPath: string): Promise<string> {
  return realpath(path.isAbsolute(requestedPath) ? requestedPath : path.resolve(cwd, requestedPath));
}

export function createWordReadTool(cwd: string) {
  return defineTool({
    name: "read_word",
    label: "read Word document",
    description: "Extract text from a local Microsoft Word .doc or .docx file. Use this instead of read for Word documents.",
    promptSnippet: "Extract text from Word documents",
    promptGuidelines: [
      "Use read_word instead of read for local .doc and .docx files.",
      "Use startCharacter to continue when a long document is returned in chunks.",
      "Text extraction does not preserve exact page layout; use the desktop preview when layout matters.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the Word file (relative or absolute)" }),
      startCharacter: Type.Optional(Type.Integer({
        description: "Character offset to start reading from",
        minimum: 0,
      })),
    }),
    async execute(_toolCallId, { path: requestedPath, startCharacter = 0 }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await resolveToolPath(cwd, requestedPath);
      if (![".doc", ".docx"].includes(path.extname(absolutePath).toLowerCase())) {
        throw new Error("read_word only supports .doc and .docx files");
      }
      try {
        const text = await extractWordText(absolutePath);
        if (signal?.aborted) throw new Error("Operation aborted");
        if (startCharacter > text.length) {
          throw new Error(`startCharacter ${startCharacter} is beyond the end of the document (${text.length} characters)`);
        }
        const endCharacter = Math.min(text.length, startCharacter + WORD_CHUNK_SIZE);
        const chunk = text.slice(startCharacter, endCharacter);
        const continuation = endCharacter < text.length
          ? `\n\n[Showing characters ${startCharacter}-${endCharacter} of ${text.length}. Use startCharacter=${endCharacter} to continue.]`
          : "";
        return {
          content: [{ type: "text", text: (chunk || "[Document contains no extractable text]") + continuation }],
          details: { totalCharacters: text.length, startCharacter, endCharacter },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read Word document "${requestedPath}": ${message}`);
      }
    },
  });
}

export function createSpreadsheetReadTool(cwd: string) {
  return defineTool({
    name: "read_spreadsheet",
    label: "read spreadsheet",
    description: "Read rows, values, and formulas from local .xlsx, .xls, .csv, or .tsv files. Supports worksheet selection and row pagination.",
    promptSnippet: "Read worksheet data from Excel and delimited files",
    promptGuidelines: [
      "Use read_spreadsheet instead of read for local .xlsx, .xls, .csv, and .tsv files.",
      "Select a worksheet by name and paginate large sheets with startRow.",
      "Preserve numeric, date, and formula meaning when summarizing spreadsheet data.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the spreadsheet file (relative or absolute)" }),
      sheet: Type.Optional(Type.String({ description: "Worksheet name; defaults to the first worksheet" })),
      startRow: Type.Optional(Type.Integer({ description: "First row to read (1-indexed)", minimum: 1 })),
      rowCount: Type.Optional(Type.Integer({
        description: `Number of rows to read (maximum ${MAX_SPREADSHEET_ROWS})`,
        minimum: 1,
        maximum: MAX_SPREADSHEET_ROWS,
      })),
    }),
    async execute(_toolCallId, { path: requestedPath, sheet, startRow = 1, rowCount = 100 }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = await resolveToolPath(cwd, requestedPath);
      if (![".xlsx", ".xls", ".csv", ".tsv"].includes(path.extname(absolutePath).toLowerCase())) {
        throw new Error("read_spreadsheet only supports .xlsx, .xls, .csv, and .tsv files");
      }
      try {
        const result = extractSpreadsheetText(absolutePath, sheet, startRow, rowCount);
        if (signal?.aborted) throw new Error("Operation aborted");
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read spreadsheet "${requestedPath}": ${message}`);
      }
    },
  });
}
