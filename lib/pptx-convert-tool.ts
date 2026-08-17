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
  [string]$ProgId = ""
)
$ErrorActionPreference = "Stop"
try {
  $resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
  $OutputPath = $OutputPath -replace "/", "\\"   # COM SaveAs rejects forward slashes
  $outDir = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
  $progIds = @()
  if ($ProgId) { $progIds += $ProgId }
  else { $progIds += "KWPP.Application"; $progIds += "PowerPoint.Application" }
  $app = $null
  $isNewInstance = $false
  foreach ($candidate in $progIds) {
    # 程序运行（用户可能正在使用）→ 复用已有实例，但绝不 Quit（不干扰用户会话）
    $procName = ""
    if ($candidate -like "KWPP*") { $procName = "wpp" } else { $procName = "POWERPNT" }
    $running = Get-Process -Name $procName -ErrorAction SilentlyContinue
    if ($running) {
      try {
        $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($candidate)
        $isNewInstance = $false
        break
      } catch { continue }
    }
    try { $app = New-Object -ComObject $candidate; $isNewInstance = $true; break } catch {}
  }
  if (-not $app) { throw "No usable COM (WPS/PowerPoint) found" }
  try {
    $presentation = $app.Presentations.Open($resolvedInput, $true, $false, $false)
    try {
      $presentation.SaveAs($OutputPath, [int]32)
    } finally {
      try { $presentation.Close() } catch {}
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

/** 检测可用的演示 COM（KWPP=WPS 优先，PowerPoint 其次），返回 ProgID 或 null。
 * 铁律：程序正在运行 = 用户可能正在使用 → 该 progId 不可用（绝不连接/Quit 用户实例）；
 * 仅当程序未运行时才新建实例探测（此时 Quit 安全，且不留残留进程）。 */
export function detectPresentationCom(): string | null {
  for (const progId of ["KWPP.Application", "PowerPoint.Application"]) {
    const procName = progId.startsWith("KWPP") ? "wpp" : "POWERPNT";
    const { stdout } = runPowerShell([
      "-Command",
      // 运行中 → 输出 INUSE（跳过，不碰用户实例）；未运行 → 新建探测后 Quit（安全）
      `if (Get-Process -Name ${procName} -ErrorAction SilentlyContinue) { Write-Output "INUSE"; exit 0 }
try { $w = New-Object -ComObject ${progId}; $v = $w.Version; $w.Quit(); Write-Output "OK:$v" } catch { Write-Output "NO" }`,
    ]);
    if (stdout.includes("OK:")) return progId;
  }
  return null;
}

/**
 * 确保 pptx 有对应的 PDF（转换 + 缓存）。
 * @returns { pdf } 成功；{ locked } 文件被其他程序占用（跳过转换）；null 无可用 COM。
 */
export async function ensurePptxPdf(
  pptxPath: string,
): Promise<{ pdf: string; stale?: boolean } | { locked: true } | null> {
  try {
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

    // 缓存命中且源文件未变化 → 直接返回
    if (fs.existsSync(pdfPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta.mtimeMs === Math.floor(stat.mtimeMs) && meta.size === stat.size) {
          return { pdf: pdfPath };
        }
      } catch { /* meta 缺失/损坏 → 重新转换 */ }
    }

    const progId = detectPresentationCom();
    if (!progId) {
      const legacy = findCachedPdf(pptxPath);
      if (legacy) return { pdf: legacy, stale: true };
      return null;
    }

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

    const { stdout } = runPowerShell(["-File", scriptPath, "-InputPath", inputCopy, "-OutputPath", pdfPath, "-ProgId", progId]);
    if (!stdout.includes("OK:")) {
      // 转换失败/被占用 → 有旧缓存则兜底返回（用户仍可看到上次预览），否则报占用/不可用
      const legacy = findCachedPdf(pptxPath);
      if (legacy) return { pdf: legacy, stale: true };
      if (stdout.includes("in use")) return { locked: true };
      return null;
    }
    if (fs.existsSync(pdfPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ mtimeMs: Math.floor(stat.mtimeMs), size: stat.size }));
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
