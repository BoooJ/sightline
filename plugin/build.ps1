# Construit le plugin en 32 et 64 bits (Visual Studio 2022), lance les tests (CTest) et, avec -Package,
# fabrique build\sightline-comms.ts3_plugin (package.ini + plugins\sightline_comms_win32.dll + _win64.dll).
# Usage : pwsh plugin/build.ps1 [-Arch Win32|x64|all] [-Config Release|Debug] [-Package]
param([ValidateSet("Win32", "x64", "all")][string]$Arch = "all", [string]$Config = "Release", [switch]$Package)
$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$cmake = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -find "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" | Select-Object -First 1
if (-not $cmake) { throw "CMake de Visual Studio introuvable (charge de travail « Développement Desktop en C++ »)" }
$ctest = Join-Path (Split-Path $cmake) "ctest.exe"
if (-not (Test-Path (Join-Path $PSScriptRoot "third_party\opus\CMakeLists.txt"))) { & (Join-Path $PSScriptRoot "fetch_deps.ps1") }
if ($Package -and $Arch -ne "all") { throw "-Package demande les deux architectures (-Arch all)" }
$archs = if ($Arch -eq "all") { @("Win32", "x64") } else { @($Arch) }
foreach ($a in $archs) {
  $dir = Join-Path $PSScriptRoot ("build\" + $(if ($a -eq "Win32") { "win32" } else { "win64" }))
  & $cmake -S $PSScriptRoot -B $dir -G "Visual Studio 17 2022" -A $a | Out-Host
  if ($LASTEXITCODE) { throw "configuration $a" }
  & $cmake --build $dir --config $Config --parallel | Out-Host
  if ($LASTEXITCODE) { throw "compilation $a" }
  & $ctest --test-dir $dir -C $Config --output-on-failure | Out-Host
  if ($LASTEXITCODE) { throw "tests $a" }
}
if ($Package) {
  $stage = Join-Path $PSScriptRoot "build\package"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force (Join-Path $stage "plugins") | Out-Null
  Copy-Item (Join-Path $PSScriptRoot "package.ini") $stage
  Copy-Item (Join-Path $PSScriptRoot "build\win32\$Config\sightline_comms_win32.dll") (Join-Path $stage "plugins")
  Copy-Item (Join-Path $PSScriptRoot "build\win64\$Config\sightline_comms_win64.dll") (Join-Path $stage "plugins")
  $out = Join-Path $PSScriptRoot "build\sightline-comms.ts3_plugin"
  if (Test-Path $out) { Remove-Item -Force $out }
  Push-Location $stage
  try { & $cmake -E tar cf $out --format=zip package.ini plugins } finally { Pop-Location }
  if ($LASTEXITCODE) { throw "paquet" }
  & $cmake -E tar tf $out | Out-Host
  Write-Host "Paquet : $out"
}
