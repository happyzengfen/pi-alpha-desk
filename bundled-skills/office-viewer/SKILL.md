---
name: office-viewer
description: Read and summarize local Word, Excel, CSV, TSV, and PDF files with Pi Alpha Desk's built-in document tools. Use when the user asks to inspect office documents or extract basic document and table data.
---

# Office Viewer

## Overview

Use Pi Alpha Desk's document-aware tools instead of treating binary Office files as plain text.

## When to Use

- Read `.doc` or `.docx` files.
- Inspect worksheets in `.xls` or `.xlsx` files.
- Read `.csv` or `.tsv` data as a table.
- Extract text from `.pdf` files.

## Process

1. Use `read_word` for Word documents and continue with `startCharacter` when needed.
2. Use `read_spreadsheet` for Excel, CSV, and TSV files. Select the requested sheet and paginate with `startRow`.
3. Use `read_pdf` for PDFs and paginate with `startPage`.
4. Preserve worksheet names, row numbers, formulas, units, dates, and headings when summarizing.
5. If a PDF page has no extractable text, report that it likely needs OCR.

## Boundaries

- Word extraction provides content, not exact page layout.
- Spreadsheet preview is limited to the first 300 rows and 60 columns per sheet; the reading tool can paginate beyond that.
- Password-protected or damaged files may require the original application.

## Verification

- Confirm the correct file and worksheet were read.
- State any truncated range and continue reading if the answer depends on omitted rows or pages.
