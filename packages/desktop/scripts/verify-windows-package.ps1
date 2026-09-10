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

# The embedded persistent host seed (issue #442 §10.1): one version directory
# holding the SEA, node-pty built for its ABI, the verifier payload, and the
# rendered Scheduled Task definition.
$version = node -p 'require("./packages/desktop/package.json").version'
$seed = Join-Path $unpacked[0].FullName "resources\host\$version"
Assert-True (Test-Path -LiteralPath $seed -PathType Container) "Embedded host seed is missing: $seed"
$hostExe = Get-Item -LiteralPath (Join-Path $seed "bin\omp-ui.exe")
Assert-True (Test-X64Pe $hostExe) "Embedded host executable is not an x64 PE: $($hostExe.FullName)"

$ptyRoot = Join-Path $seed "lib\node-pty"
Assert-True (Test-Path -LiteralPath $ptyRoot -PathType Container) "Embedded host node-pty directory is missing: $ptyRoot"
$nativeModules = @(Get-ChildItem -LiteralPath $ptyRoot -Recurse -File -Filter "*.node")
Assert-True ($nativeModules.Count -gt 0) "No embedded host node-pty native modules found"
$x64Modules = @($nativeModules | Where-Object { Test-X64Pe $_ })
Assert-True ($x64Modules.Count -gt 0) "No x64 PE node-pty native module found"
$files = @(Get-ChildItem -LiteralPath $ptyRoot -Recurse -File)
foreach ($required in @("conpty.node", "conpty_console_list.node", "conpty.dll")) {
  Assert-True (($files | Where-Object Name -eq $required).Count -gt 0) "Missing ConPTY support file: $required"
}

$manifestPath = Join-Path $seed "resources\plan-verifier\browser.manifest.json"
Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) "Embedded verifier browser manifest is missing: $manifestPath"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$browser = Join-Path (Split-Path -Parent $manifestPath) $manifest.executable
$actualSha = (Get-FileHash -LiteralPath $browser -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-True ($actualSha -eq $manifest.sha256) "Embedded verifier browser hash $actualSha differs from its manifest $($manifest.sha256)"
Assert-True (Test-Path -LiteralPath (Join-Path $seed "service\omp-ui-host.task.xml") -PathType Leaf) "Embedded Scheduled Task definition is missing"

Write-Host "Verified $($unpacked[0].FullName): omp-ui.exe, embedded host $version with $($x64Modules.Count) x64 node-pty module(s), ConPTY support, and verifier browser $($manifest.version)"
