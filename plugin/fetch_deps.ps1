# Sources tierces du plugin, non suivies par git (cf. .gitignore), aux versions figées :
# SDK plugin TeamSpeak 3 (API 26, « all rights reserved » : jamais commité) et libopus 1.5.2 (BSD).
$ErrorActionPreference = "Stop"
$tp = Join-Path $PSScriptRoot "third_party"
New-Item -ItemType Directory -Force $tp | Out-Null

function Get-Dep([string]$name, [string]$url, [string]$ref) {
  $dir = Join-Path $tp $name
  if (-not (Test-Path (Join-Path $dir ".git"))) {
    git clone --quiet $url $dir
    if ($LASTEXITCODE) { throw "clone de $name impossible" }
  }
  git -C $dir fetch --quiet --tags origin
  git -C $dir -c advice.detachedHead=false checkout --quiet $ref
  if ($LASTEXITCODE) { throw "$name : version $ref introuvable" }
  Write-Host ("{0,-7} {1}" -f $name, (git -C $dir describe --tags --always))
}

Get-Dep "ts3sdk" "https://github.com/TeamSpeak-Systems/ts3client-pluginsdk.git" "4aa90a53aa150cbf81e13bc97e68c0431b26499f"
Get-Dep "opus" "https://github.com/xiph/opus.git" "v1.5.2"
