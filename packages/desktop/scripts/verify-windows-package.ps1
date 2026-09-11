param(
  [string]$DistDir = (Join-Path $PSScriptRoot "..\dist")
)

$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Test-X64Pe([System.IO.FileInfo]$File) {
  $stream = [System.IO.File]::OpenRead($File.FullName)
  try {
    if ($stream.Length -lt 64) { return $false }
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { return $false }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadUInt32()
    if ($peOffset + 6 -gt $stream.Length) { return $false }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { return $false }
    return $reader.ReadUInt16() -eq 0x8664
  } finally {
    $stream.Dispose()
  }
}

$unpacked = @(Get-ChildItem -LiteralPath $DistDir -Directory | Where-Object {
  Test-Path -LiteralPath (Join-Path $_.FullName "omp-ui.exe")
})
Assert-True ($unpacked.Count -eq 1) "Expected exactly one unpacked Windows app, found $($unpacked.Count)"
Assert-True (Test-Path -LiteralPath (Join-Path $unpacked[0].FullName "omp-ui.exe")) "omp-ui.exe is missing"

$ptyRoot = Join-Path $unpacked[0].FullName "resources\app.asar.unpacked\node_modules\node-pty"
Assert-True (Test-Path -LiteralPath $ptyRoot -PathType Container) "Unpacked node-pty directory is missing: $ptyRoot"

$nativeModules = @(Get-ChildItem -LiteralPath $ptyRoot -Recurse -File -Filter "*.node")
Assert-True ($nativeModules.Count -gt 0) "No unpacked node-pty native modules found"
$x64Modules = @($nativeModules | Where-Object { Test-X64Pe $_ })
Assert-True ($x64Modules.Count -gt 0) "No x64 PE node-pty native module found"

$files = @(Get-ChildItem -LiteralPath $ptyRoot -Recurse -File)
foreach ($required in @("conpty.node", "conpty_console_list.node", "conpty.dll")) {
  Assert-True (($files | Where-Object Name -eq $required).Count -gt 0) "Missing ConPTY support file: $required"
}

Write-Host "Verified $($unpacked[0].FullName): omp-ui.exe and $($x64Modules.Count) x64 node-pty module(s) with ConPTY support"
