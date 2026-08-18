import * as XLSX from "@e965/xlsx";
import WordExtractor from "word-extractor";
import fs from "fs";
import path from "path";
import type JSZipType from "jszip";

XLSX.set_fs(fs);

const DEFAULT_SPREADSHEET_ROWS = 100;
const MAX_SPREADSHEET_ROWS = 200;
const MAX_SPREADSHEET_COLUMNS = 100;
const PREVIEW_SPREADSHEET_ROWS = 300;
const PREVIEW_SPREADSHEET_COLUMNS = 60;

export interface SpreadsheetSliceDetails {
  sheetNames: string[];
  sheetName: string;
  startRow: number;
  endRow: number;
  totalRows: number;
  totalColumns: number;
  shownColumns: number;
}

function cellDisplayValue(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  const value = XLSX.utils.format_cell(cell);
  if (!cell.f) return value;
  return value ? `${value} [=${cell.f}]` : `=${cell.f}`;
}

function worksheetDimensions(worksheet: XLSX.WorkSheet): { rows: number; columns: number } {
  if (!worksheet["!ref"]) return { rows: 0, columns: 0 };
  const range = XLSX.utils.decode_range(worksheet["!ref"]);
  return { rows: range.e.r + 1, columns: range.e.c + 1 };
}

function worksheetRows(
  worksheet: XLSX.WorkSheet,
  startRow: number,
  rowCount: number,
  columnLimit = MAX_SPREADSHEET_COLUMNS,
): { rows: string[][]; totalRows: number; totalColumns: number; shownColumns: number; endRow: number } {
  const dimensions = worksheetDimensions(worksheet);
  const shownColumns = Math.min(dimensions.columns, columnLimit);
  const endRow = dimensions.rows === 0
    ? 0
    : Math.min(dimensions.rows, startRow + rowCount - 1);
  const rows: string[][] = [];

  for (let row = startRow - 1; row < endRow; row += 1) {
    const values: string[] = [];
    for (let column = 0; column < shownColumns; column += 1) {
      values.push(cellDisplayValue(worksheet[XLSX.utils.encode_cell({ r: row, c: column })]));
    }
    while (values.at(-1) === "") values.pop();
    rows.push(values);
  }

  return { rows, totalRows: dimensions.rows, totalColumns: dimensions.columns, shownColumns, endRow };
}

function loadWorkbook(filePath: string): XLSX.WorkBook {
  const isDelimited = /\.(csv|tsv)$/i.test(filePath);
  const options: XLSX.ParsingOptions = {
    cellDates: true,
    cellFormula: true,
    cellText: true,
  };
  // CSV/TSV：强制 UTF-8 解析；带 BOM 文件先剥离 BOM（否则 BOM 混入第一个单元格乱码）。
  if (isDelimited) {
    options.codepage = 65001;
    // 剥离 UTF-8 BOM：codepage 65001 会把 BOM 字节解码成 U+FEFF 混入第一个单元格（乱码）。
    // Excel 生成的带 BOM CSV 必须先剥离再按 UTF-8 解析——有/无 BOM 两种文件都兼容。
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return XLSX.read(buf.subarray(3), options);
      }
    } catch { /* 读取失败则回退 readFile 路径 */ }
    return XLSX.readFile(filePath, options);
  }
  return XLSX.readFile(filePath, options);
}

export function extractSpreadsheetText(
  filePath: string,
  requestedSheet?: string,
  startRow = 1,
  rowCount = DEFAULT_SPREADSHEET_ROWS,
): { text: string; details: SpreadsheetSliceDetails } {
  const workbook = loadWorkbook(filePath);
  if (workbook.SheetNames.length === 0) throw new Error("Workbook contains no worksheets");

  const sheetName = requestedSheet ?? workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`Worksheet "${sheetName}" was not found. Available worksheets: ${workbook.SheetNames.join(", ")}`);
  }

  const selected = worksheetRows(
    worksheet,
    startRow,
    Math.min(rowCount, MAX_SPREADSHEET_ROWS),
  );
  if (selected.totalRows > 0 && startRow > selected.totalRows) {
    throw new Error(`startRow ${startRow} is beyond the end of worksheet "${sheetName}" (${selected.totalRows} rows)`);
  }

  const body = selected.rows
    .map((row, index) => `${startRow + index}\t${row.join("\t")}`)
    .join("\n");
  const columnNotice = selected.totalColumns > selected.shownColumns
    ? `\n[Showing the first ${selected.shownColumns} of ${selected.totalColumns} columns.]`
    : "";
  const continuation = selected.endRow < selected.totalRows
    ? `\n[Showing rows ${startRow}-${selected.endRow} of ${selected.totalRows}. Use startRow=${selected.endRow + 1} to continue.]`
    : "";
  const text = [
    `[Workbook sheets: ${workbook.SheetNames.join(", ")}]`,
    `[Worksheet: ${sheetName}]`,
    body || "[Worksheet is empty]",
  ].join("\n\n") + columnNotice + continuation;

  return {
    text,
    details: {
      sheetNames: workbook.SheetNames,
      sheetName,
      startRow,
      endRow: selected.endRow,
      totalRows: selected.totalRows,
      totalColumns: selected.totalColumns,
      shownColumns: selected.shownColumns,
    },
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSpreadsheetPreviewBody(filePath: string): string {
  const workbook = loadWorkbook(filePath);
  if (workbook.SheetNames.length === 0) return "<p class=\"empty\">Workbook contains no worksheets.</p>";

  const navigation = workbook.SheetNames
    .map((name, index) => `<a href="#sheet-${index}">${escapeHtml(name)}</a>`)
    .join("");
  const sheets = workbook.SheetNames.map((name, sheetIndex) => {
    const worksheet = workbook.Sheets[name];
    const selected = worksheetRows(
      worksheet,
      1,
      PREVIEW_SPREADSHEET_ROWS,
      PREVIEW_SPREADSHEET_COLUMNS,
    );
    const columnCount = Math.max(1, selected.shownColumns);
    const header = Array.from({ length: columnCount }, (_, column) =>
      `<th>${escapeHtml(XLSX.utils.encode_col(column))}</th>`
    ).join("");
    const rows = selected.rows.map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_, column) =>
        `<td>${escapeHtml(row[column] ?? "")}</td>`
      ).join("");
      return `<tr><th class="row-number">${rowIndex + 1}</th>${cells}</tr>`;
    }).join("");
    const notices = [
      selected.totalRows > PREVIEW_SPREADSHEET_ROWS
        ? `Showing first ${PREVIEW_SPREADSHEET_ROWS} of ${selected.totalRows} rows.`
        : "",
      selected.totalColumns > PREVIEW_SPREADSHEET_COLUMNS
        ? `Showing first ${PREVIEW_SPREADSHEET_COLUMNS} of ${selected.totalColumns} columns.`
        : "",
    ].filter(Boolean).join(" ");

    return `<section id="sheet-${sheetIndex}">
      <h2>${escapeHtml(name)}</h2>
      ${selected.totalRows === 0
        ? "<p class=\"empty\">This worksheet is empty.</p>"
        : `<div class="sheet-table"><table><thead><tr><th class="corner"></th>${header}</tr></thead><tbody>${rows}</tbody></table></div>`}
      ${notices ? `<p class="notice">${escapeHtml(notices)}</p>` : ""}
    </section>`;
  }).join("");

  return `<nav class="sheet-nav">${navigation}</nav>${sheets}`;
}

/**
 * PPTX 预览：解包 zip，按页提取 slide XML 中的文本（<a:t>），生成大纲式 HTML。
 * 说明：pptx 的信息在文字里（标题/要点），大纲预览已满足阅读需求；
 * 版面还原（图表/图片位置）留待后续优化（当前为浅色文档样式）。
 */
export async function renderPptxPreviewBody(filePath: string): Promise<string> {
  const JSZip: typeof JSZipType = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number.parseInt(a.match(/slide(\d+)\.xml/)![1], 10);
      const nb = Number.parseInt(b.match(/slide(\d+)\.xml/)![1], 10);
      return na - nb;
    });
  if (slideNames.length === 0) {
    return '<p class="empty">No slides found in this presentation.</p>';
  }
  const sections: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async("string");
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
      .map((match) => match[1])
      .filter((text) => text.trim().length > 0);
    const pageNumber = name.match(/slide(\d+)\.xml/)![1];
    const items = texts.length
      ? texts.map((text) => `<li>${escapeHtml(text)}</li>`).join("")
      : '<p class="empty">（本页无文本内容）</p>';
    sections.push(`<section class="slide"><h2>第 ${pageNumber} 页</h2><ul>${items}</ul></section>`);
  }
  return sections.join("");
}

export async function extractWordText(filePath: string): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value.trim();
  }
  if (extension === ".doc") {
    const document = await new WordExtractor().extract(filePath);
    return [
      document.getHeaders({ includeFooters: false }),
      document.getBody(),
      document.getFootnotes(),
      document.getEndnotes(),
      document.getFooters(),
    ].map((section) => section.trim()).filter(Boolean).join("\n\n");
  }
  throw new Error("Word reader only supports .doc and .docx files");
}
