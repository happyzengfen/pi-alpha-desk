/**
 * docx-convert-tool — DOCX → PDF 转换（WPS/Office COM 自动化）
 *
 * 与 pptx-convert-tool 同构：用本机 WPS 文字（KWPS.Application）或 Microsoft Word
 * （Word.Application）COM 把 docx 导出为 PDF，再走 PDF 渲染管线预览。
 *
 * 保护铁律（与 PPT 版一致）：
 *  - 程序运行中 = 用户可能正在使用 → GetActiveObject 复用，绝不 Quit 用户实例
 *  - 内存直出：Documents 集合按路径/文件名匹配用户已打开的文档 → 直接导出
 *    （只读导出，不 Close 用户文档）；匹配失败才打开磁盘副本（路 A）
 *  - 缓存：固定 key（仅文件路径）+ meta.json（mtimeMs 毫秒级 + size）；
 *    失败/占用时返回旧缓存（stale）
 *  - 单飞锁：同一文件并发请求共享同一次转换
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CACHE_ROOT = process.env.DOCX_CACHE_DIR ?? path.join(os.tmpdir(), "pi-alpha-desk-docx-cache");
const PS_EXE = process.env.POWERSHELL_PATH ?? "powershell.exe";

/**
 * 内嵌 PowerShell 转换脚本（ASCII only——PowerShell 5.1 对无 BOM UTF-8 中文注释会解析出错）。
 * 路径分隔符用 [string][char]92（反斜杠字面量在编译链中会丢失——历史教训）。
 */
const DOCX_TO_PDF_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$OriginalPath,
  [string]$ProgId = ""
)
$ErrorActionPreference = "Stop"
try {
  $resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
  $OutputPath = $OutputPath -replace "/", [string][char]92
  $outDir = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
  $progIds = @()
  if ($ProgId) { $progIds += $ProgId }
  else { $progIds += "KWPS.Application"; $progIds += "Word.Application" }
  $app = $null
  $isNewInstance = $false
  foreach ($candidate in $progIds) {
    $procName = ""
    if ($candidate -like "KWPS*") { $procName = "wps" } else { $procName = "WINWORD" }
    $running = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($running) {
      # running (user may be using it) -> reuse the live instance, NEVER quit it
      try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($candidate); $isNewInstance = $false; break } catch { continue }
    }
    try { $app = New-Object -ComObject $candidate; $isNewInstance = $true; break } catch {}
  }
  if (-not $app) { throw "No usable COM (WPS/Word) found" }
  $document = $null
  $openedFromDisk = $false
  try {
    # Route B (memory direct): find the doc the user already has open and export it as-is.
    # Read-only export: never closes the user's document, never touches it.
    if ($OriginalPath) {
      $origName = Split-Path -Leaf $OriginalPath
      $origFull = (Resolve-Path -LiteralPath $OriginalPath).Path
      foreach ($d in $app.Documents) {
        try { $fullName = $d.FullName; $name = $d.Name } catch { continue }
        if ($fullName -eq $origFull -or $name -eq $origName) { $document = $d; break }
      }
    }
    if (-not $document) {
      # Route A fallback: open the disk copy (read-only) and export it
      $document = $app.Documents.Open($resolvedInput, $false, $true, $false)
      $openedFromDisk = $true
    }
    try {
      # 17 = wdFormatPDF
      $document.SaveAs($OutputPath, [int]17)
    } finally {
      if ($openedFromDisk) { try { $document.Close($false) } catch {} }
    }
  } finally {
    if ($isNewInstance) { try { $app.Quit() } catch {} }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
  }
  if (-not (Test-Path -LiteralPath $OutputPath)) { throw "Export completed but PDF not found" }
  Write-Output "OK:$OutputPath"
  exit 0
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
`;

function runPowerShell(args: string[]): { stdout: string; ok: boolean } {
  try {
    const stdout = execFileSync(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], {
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, ok: true };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`, ok: false };
  }
}

/** 文件是否被锁定（只读探测：连读取都失败才算真正锁定） */
function isFileLocked(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    fs.closeSync(fd);
    return false;
  } catch {
    return true;
  }
}

/**
 * 确保 docx 有对应的 PDF（转换 + 缓存）。
 * @returns { pdf } 成功；{ locked } 文件被其他程序占用；null 无可用 COM。
 */
const inFlight = new Map<string, Promise<{ pdf: string; stale?: boolean } | { locked: true } | null>>();

export async function ensureDocxPdf(
  docxPath: string,
): Promise<{ pdf: string; stale?: boolean } | { locked: true } | null> {
  if (isFileLocked(docxPath)) {
    const legacy = findCachedPdf(docxPath);
    if (legacy) return { pdf: legacy, stale: true };
    return { locked: true };
  }

  const stat = fs.statSync(docxPath);
  const key = crypto.createHash("sha256").update(docxPath).digest("hex").slice(0, 16);
  const cacheDir = path.join(CACHE_ROOT, key);
  const pdfPath = path.join(cacheDir, "converted.pdf");
  const metaPath = path.join(cacheDir, "meta.json");

  if (fs.existsSync(pdfPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.mtimeMs === stat.mtimeMs && meta.size === stat.size) {
        return { pdf: pdfPath };
      }
    } catch { /* meta 缺失/损坏 → 重新转换 */ }
  }

  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = doConvert(docxPath, stat, cacheDir, pdfPath, metaPath);
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

async function doConvert(
  docxPath: string,
  stat: { mtimeMs: number; size: number },
  cacheDir: string,
  pdfPath: string,
  metaPath: string,
): Promise<{ pdf: string; stale?: boolean } | { locked: true } | null> {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const scriptPath = path.join(cacheDir, "docx-to-pdf.ps1");
    fs.writeFileSync(scriptPath, DOCX_TO_PDF_SCRIPT, "utf8");

    // 副本名保留原扩展名（Word 按扩展名识别 .doc/.docx 格式）
    const inputCopy = path.join(cacheDir, `input${path.extname(docxPath).toLowerCase()}`);
    try {
      fs.copyFileSync(docxPath, inputCopy);
    } catch {
      const legacy = findCachedPdf(docxPath);
      if (legacy) return { pdf: legacy, stale: true };
      return { locked: true };
    }

    const { stdout } = runPowerShell([
      "-File", scriptPath,
      "-InputPath", inputCopy,
      "-OutputPath", pdfPath,
      "-OriginalPath", docxPath,
    ]);
    if (!stdout.includes("OK:")) {
      const legacy = findCachedPdf(docxPath);
      if (legacy) return { pdf: legacy, stale: true };
      if (stdout.includes("in use")) return { locked: true };
      return null;
    }
    if (fs.existsSync(pdfPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ mtimeMs: stat.mtimeMs, size: stat.size }));
      return { pdf: pdfPath };
    }
    return null;
  } catch {
    return null;
  }
}

/** 查找该文件已存在的缓存 PDF（兜底用） */
function findCachedPdf(docxPath: string): string | null {
  try {
    const key = crypto.createHash("sha256").update(docxPath).digest("hex").slice(0, 16);
    const pdfPath = path.join(CACHE_ROOT, key, "converted.pdf");
    return fs.existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  }
}
