#!/usr/bin/env node
/**
 * excel-helper.mjs — Excel 常用操作封装（基于 exceljs，随应用打包）
 *
 * 用法：
 *   node excel-helper.mjs create <out.xlsx> '<spec JSON>'
 *   node excel-helper.mjs read   <file.xlsx> [sheetName]
 *
 * create 的 spec 结构：
 * {
 *   "sheets": [
 *     {
 *       "name": "销售",
 *       "columns": ["月份", "销售额"],          // 或 [{header,key,width}]
 *       "rows": [["1月", 120], ["2月", 150]],  // 数据行
 *       "formulas": [{"cell":"C2","formula":"=B2*0.1"}],  // 可选
 *       "styles": [{"cell":"A1","bold":true,"numFmt":"#,##0.00"}] // 可选
 *     }
 *   ]
 * }
 */
import ExcelJS from "exceljs";

/** 按规格创建 Excel 文件 */
export async function createWorkbook(spec, outPath) {
  const wb = new ExcelJS.Workbook();
  for (const s of spec.sheets ?? []) {
    const ws = wb.addWorksheet(s.name ?? "Sheet1");
    if (Array.isArray(s.columns) && s.columns.length && typeof s.columns[0] === "string") {
      ws.columns = s.columns.map((h) => ({ header: h, width: 14 }));
      // ws.columns 已自动写入表头行，不再手动 addRow
    } else if (Array.isArray(s.columns)) {
      ws.columns = s.columns;
    }
    for (const r of s.rows ?? []) ws.addRow(r);
    for (const f of s.formulas ?? []) {
      ws.getCell(f.cell).value = { formula: f.formula, result: f.result };
    }
    for (const st of s.styles ?? []) {
      const cell = ws.getCell(st.cell);
      if (st.bold) cell.font = { ...(cell.font ?? {}), bold: true };
      if (st.numFmt) cell.numFmt = st.numFmt;
      if (st.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: st.fill } };
      if (st.fontColor) cell.font = { ...(cell.font ?? {}), color: { argb: st.fontColor } };
    }
    if (s.conditionalFormatting) {
      ws.addConditionalFormatting(s.conditionalFormatting);
    }
  }
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** 读取 Excel 全部内容（JSON） */
export async function readWorkbook(filePath, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const out = [];
  const targets = sheetName ? [wb.getWorksheet(sheetName)] : wb.worksheets;
  for (const ws of targets) {
    if (!ws) continue;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = {};
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        cells[cell.address] =
          v && typeof v === "object" && "formula" in v ? { formula: v.formula, result: v.result } : v;
      });
      rows.push(cells);
    });
    out.push({ sheet: ws.name, rows });
  }
  return out;
}

// CLI 入口
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  if (cmd === "create") {
    const spec = JSON.parse(arg2 ?? "{}");
    await createWorkbook(spec, arg1);
    console.log(`✅ 已生成 ${arg1}`);
  } else if (cmd === "read") {
    const data = await readWorkbook(arg1, arg2);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.error("用法: excel-helper.mjs create|read <file> [spec|sheet]");
    process.exit(1);
  }
}
