# pptx-to-pdf.ps1 - Export PPTX to PDF via COM automation (WPS Presentation / Microsoft PowerPoint)
# Usage:
#   powershell -File pptx-to-pdf.ps1 -InputPath <pptx> -OutputPath <pdf> [-ProgId KWPP.Application]
# ProgID order (default): KWPP.Application (WPS), then PowerPoint.Application (MS Office).
param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$ProgId = ""
)

$ErrorActionPreference = "Stop"
$log = $env:PPTX_CONVERT_LOG

function Write-Log($msg) {
  if ($log) { Add-Content -Path $log -Value $msg }
}

try {
  $resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
  $OutputPath = $OutputPath -replace "/", "\"  # COM SaveAs rejects forward slashes
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
      # ExportAsFixedFormat fails with int->Object binding on some hosts;
      # SaveAs(32 = ppSaveAsPDF) is the reliable path.
      $presentation.SaveAs($OutputPath, [int]32)
      Write-Log "Exported via SaveAs(32)"
    } finally {
      try { $presentation.Close() } catch {}
    }
  } finally {
    if ($isNewInstance) { try { $app.Quit() } catch {} }
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
  }

  if (-not (Test-Path -LiteralPath $OutputPath)) { throw "Export completed but PDF not found at output path" }
  Write-Output "OK:$OutputPath"
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
