---
name: office-excel
description: "处理电子表格文件（.xlsx / .xlsm / .csv / .tsv）：创建新表格、读取和编辑已有表格、公式计算、多工作表、单元格样式（字体/填充/边框）、条件格式、数字格式、数据排序筛选分析。用户在需要制作报表、分析表格数据、整理数据、转换表格格式时使用。触发词：excel、xlsx、表格、报表、电子表格、sheet、数据透视。"
license: MIT
type: actionable
---

# Office Excel 处理（node 生态）

基于 **ExcelJS**（node 库，已随应用打包）读写 Excel 文件。纯 node 实现，无 Python 依赖，离线可用。

## 环境

- 依赖：`exceljs`（已随本 skill 自带，scripts/../node_modules，离线可用）
- 脚本：`scripts/excel-helper.mjs` 提供常用操作函数（创建/读取/编辑），可直接 import 使用，也可参考其写法自行编写脚本

## 核心能力

| 能力 | 支持 | 说明 |
| --- | --- | --- |
| 创建新表格 | ✅ | 多 sheet、列定义、数据写入 |
| 读取/编辑已有表格 | ✅ | 保留已有公式与格式（按单元格定位修改） |
| 公式 | ✅ | `=SUM(...)`、跨 sheet 引用 `'Sheet1'!A1`；**写公式而非硬编码结果** |
| 多工作表 | ✅ | 命名、顺序、跨表引用 |
| 样式 | ✅ | 字体（粗体/字号/颜色）、填充、边框、对齐、合并单元格 |
| 条件格式 | ✅ | cellIs / containsText 等规则 |
| 数字格式 | ✅ | `#,##0.00`、百分比、日期等 numFmt |
| 数据分析 | ✅ | 排序、筛选、统计公式（SUM/AVERAGE/COUNTIF...） |
| 图表 | ⚠️ **不支持**（ExcelJS 社区版限制） | **引导方案见下** |
| 图片插入 | ✅ | `workbook.addImage` + `worksheet.addImage` |

## 工作流

### 创建新表格
1. 明确需求：sheet 结构、列头、数据来源、公式、样式要求
2. 用 `excel-helper.mjs` 的 `createWorkbook(spec)` 或直接写 ExcelJS 脚本
3. 关键规范：
   - **用公式而非硬编码结果**（如 `B10 = '=SUM(B2:B9)'`）
   - 列头加粗；金额用数字格式 `#,##0.00`
   - 结果/假设用单元格注释或相邻单元格说明
4. 写入文件，验证：读回检查 sheet 数、公式、格式

### 读取/分析
- 用 `readWorkbook(path)` 遍历 sheet 与单元格
- 分析（求和/均值/计数/分组）用公式或代码计算，输出结论

### 编辑已有表格
- **先读取原文件，遵循其现有约定**（已有公式/样式不动，只改指定单元格）
- 找到指定输入区域（通常有颜色/字体标记），只写入那里

## ⚠️ 图表限制与引导（重要）

ExcelJS 社区版**不支持生成图表**。当用户需要图表时：
1. 正常生成完整数据表（含公式与样式）
2. 明确告知用户："图表需在 Excel/WPS 中手动插入：选中数据区域 → 插入 → 图表（柱状/折线/饼图等）"
3. 如用户需要的是**演示用图表**，建议改用 `office-pptx` skill（PPT 图表完整支持）

## 参考脚本用法

```bash
# 创建表格（按 JSON 规格）
node scripts/excel-helper.mjs create out.xlsx '{"sheets":[{"name":"销售","columns":["月份","销售额"],"rows":[["1月",120],["2月",150]]}]}'

# 读取表格全部内容（JSON 输出）
node scripts/excel-helper.mjs read 文件.xlsx
```

详见 `scripts/excel-helper.mjs` 内部注释。
