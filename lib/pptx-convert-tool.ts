/**
 * pptx-convert-tool — PPTX → PDF 转换（WPS/Office COM 自动化）
 *
 * 方案 A：用内网机器现成的 WPS 演示（KWPP.Application）或 Microsoft PowerPoint
 * （PowerPoint.Application）COM 把 pptx 导出为 PDF，再走 PDF 渲染管线预览。
 * 无可用 COM 时返回 null（上层回退大纲预览）。
 *
 * 缓存：按文件（大小+mtime）哈希缓存转换结果，避免重复转换。
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_ROOT = process.env.PPTX_CACHE_DIR ?? path.join(os.tmpdir(), "pi-alpha-desk-pptx-cache");
const PS_EXE = process.env.POWERSHELL_PATH ?? "powershell.exe";

/**
 * 内嵌 PowerShell 转换脚本（ASCII only——PowerShell 5.1 对无 BOM UTF-8 中文注释会解析出错）。
 * 运行时写入临时文件后执行，避免依赖打包目录中的脚本文件。
 */
const PPTX_TO_PDF_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$OriginalPath,
  [string]$ProgId = ""
)
$ErrorActionPreference = "Stop"
try {
  $resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
  $OutputPath = $OutputPath -replace "/", "\"
  $outDir = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
  $progIds = @()
  if ($ProgId) { $progIds += $ProgId }
  else { $progIds += "KWPP.Application"; $progIds += "PowerPoint.Application" }
  $app = $null
  $isNewInstance = $false
  foreach ($candidate in $progIds) {
    $procName = ""
    if ($candidate -like "KWPP*") { $procName = "wpp" } else { $procName = "POWERPNT" }
    $running = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($running) {
      # running (user may be using it) -> reuse the live instance, NEVER quit it
      try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($candidate); $isNewInstance = $false; break } catch { continue }
    }
    try { $app = New-Object -ComObject $candidate; $isNewInstance = $true; break } catch {}
  }
  if (-not $app) { throw "No usable COM (WPS/PowerPoint) found" }
  $presentation = $null
  $openedFromDisk = $false
  try {
    # Route B (memory direct): find the doc the user already has open and export it as-is.
    # Read-only export: never closes the user's document, never touches it.
    if ($OriginalPath) {
      $origName = Split-Path -Leaf $OriginalPath
      $origFull = (Resolve-Path -LiteralPath $OriginalPath).Path
      foreach ($p in $app.Presentations) {
        try { $fullName = $p.FullName; $name = $p.Name } catch { continue }
        if ($fullName -eq $origFull -or $name -eq $origName) { $presentation = $p; break }
      }
    }
    if (-not $presentation) {
      # Route A fallback: open the disk copy (read-only) and export it
      $presentation = $app.Presentations.Open($resolvedInput, $true, $false, $false)
      $openedFromDisk = $true
    }
    try {
      $presentation.SaveAs($OutputPath, [int]32)
    } finally {
      if ($openedFromDisk) { try { $presentation.Close() } catch {} }
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

/** 文件是否被锁定（只读探测：连读取都失败才算真正锁定）。
 * 放宽说明：PowerPoint/WPS 打开文件时通常允许其他程序读取（共享读），
 * 旧实现用 r+（读写）探测会误判"被占用"——改为 r（只读）探测，能读即可转换。 */
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
 * 确保 pptx 有对应的 PDF（转换 + 缓存）。
 * @returns { pdf } 成功；{ locked } 文件被其他程序占用（跳过转换）；null 无可用 COM。
 *
 * 链路（一次 PowerShell 完成探测+转换，省 1-2s）：
 *   1. 缓存命中（mtimeMs 毫秒级 + size 一致）→ 直接返回
 *   2. 未命中 → 复制磁盘副本 → 脚本内：运行中实例优先内存直出（路 B，
 *      拿到 PowerPoint 内存中的最新内容，即使保存后磁盘短暂锁定也不受影响），
 *      未匹配到打开文档则打开副本导出（路 A）
 *   3. 单飞锁：同一文件并发请求共享同一次转换，避免 N 页并发各转一次
 */
const inFlight = new Map<string, Promise<{ pdf: string; stale?: boolean } | { locked: true } | null>>();

export async function ensurePptxPdf(
  pptxPath: string,
): Promise<{ pdf: string; stale?: boolean } | { locked: true } | null> {
  // 文件真正被锁定（连读都不行，如正在保存）→ 不转换；有旧缓存则兜底返回
  if (isFileLocked(pptxPath)) {
    const legacy = findCachedPdf(pptxPath);
    if (legacy) return { pdf: legacy, stale: true };
    return { locked: true };
  }

  const stat = fs.statSync(pptxPath);
  // 固定 key（仅文件路径）：占用/失败时可用旧缓存兜底；mtime 变化由 meta 判断是否重转
  const key = crypto.createHash("sha256").update(pptxPath).digest("hex").slice(0, 16);
  const cacheDir = path.join(CACHE_ROOT, key);
  const pdfPath = path.join(cacheDir, "converted.pdf");
  const metaPath = path.join(cacheDir, "meta.json");

  // 缓存命中且源文件未变化 → 直接返回（mtimeMs 毫秒级比较：同秒保存也能识别变化）
  if (fs.existsSync(pdfPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.mtimeMs === stat.mtimeMs && meta.size === stat.size) {
        return { pdf: pdfPath };
      }
    } catch { /* meta 缺失/损坏 → 重新转换 */ }
  }

  // 单飞锁：同一文件同一时刻只允许一次转换，其余请求共享结果
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = doConvert(pptxPath, stat, cacheDir, pdfPath, metaPath);
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

async function doConvert(
  pptxPath: string,
  stat: { mtimeMs: number; size: number },
  cacheDir: string,
  pdfPath: string,
  metaPath: string,
): Promise<{ pdf: string; stale?: boolean } | { locked: true } | null> {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const scriptPath = path.join(cacheDir, "pptx-to-pdf.ps1");
    fs.writeFileSync(scriptPath, PPTX_TO_PDF_SCRIPT, "utf8");

    // 复制源文件到缓存副本：源文件可能正被 PowerPoint/WPS 打开（可读），
    // 转换脚本打开副本可避免与用户编辑中的文件交互
    const inputCopy = path.join(cacheDir, "input.pptx");
    try {
      fs.copyFileSync(pptxPath, inputCopy);
    } catch {
      const legacy = findCachedPdf(pptxPath);
      if (legacy) return { pdf: legacy, stale: true };
      return { locked: true };
    }

    // ProgId 留空 → 脚本内自探测（KWPP 优先、PowerPoint 其次；运行中复用实例）
    const { stdout } = runPowerShell([
      "-File", scriptPath,
      "-InputPath", inputCopy,
      "-OutputPath", pdfPath,
      "-OriginalPath", pptxPath,
    ]);
    if (!stdout.includes("OK:")) {
      // 转换失败/被占用 → 有旧缓存则兜底返回（用户仍可看到上次预览），否则报占用/不可用
      const legacy = findCachedPdf(pptxPath);
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


/** 查找该文件已存在的缓存 PDF（兜底用：占用/转换失败时返回旧预览） */
function findCachedPdf(pptxPath: string): string | null {
  try {
    const key = crypto.createHash("sha256").update(pptxPath).digest("hex").slice(0, 16);
    const pdfPath = path.join(CACHE_ROOT, key, "converted.pdf");
    return fs.existsSync(pdfPath) ? pdfPath : null;
  } catch {
    return null;
  }
}
