param([switch]$Prod, [int]$ApiPort = 0, [int]$WebPort = 0)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$py = Join-Path $root "backend/.venv/Scripts/python.exe"
if (-not (Test-Path $py)) {
  Write-Host "Installation du backend..." -ForegroundColor Cyan
  python -m venv (Join-Path $root "backend/.venv")
  & $py -m pip install -q -e "$root/backend[dev]"
}
if (-not (Test-Path (Join-Path $root "frontend/node_modules"))) {
  Write-Host "Installation du frontend..." -ForegroundColor Cyan
  Push-Location (Join-Path $root "frontend"); npm install; Pop-Location
}
$uvicorn = Join-Path $root "backend/.venv/Scripts/uvicorn.exe"

# Plusieurs copies du projet (ex. C:\dev\skybox_cs et la copie 3D C:\dev\skybox_cs-3d) peuvent tourner en même temps :
# sans port imposé (-ApiPort / -WebPort), chacune prend le premier port libre à partir de 8000 (API) et 5173 (site).
function Test-PortFree([int]$port) { -not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Select-Port([int]$asked, [int]$from) {
  if ($asked) {
    if (-not (Test-PortFree $asked)) { throw "Le port $asked est déjà utilisé." }
    return $asked
  }
  $p = $from
  while (-not (Test-PortFree $p)) { $p++ }
  return $p
}
$ApiPort = Select-Port $ApiPort 8000
$env:SIGHTLINE_API_PORT = "$ApiPort"
# Les cookies ignorent le port : sur localhost, se connecter à une copie déconnecterait l'autre. Une copie de travail
# Git (.git y est un fichier, pas un dossier) prend donc son propre cookie de session ; la copie principale garde le sien.
if (Test-Path (Join-Path $root ".git") -PathType Leaf) {
  $env:SKYBOX_SESSION_COOKIE = "sl_session_" + ((Split-Path $root -Leaf) -replace '[^A-Za-z0-9_-]', '_')
} else {
  Remove-Item Env:SKYBOX_SESSION_COOKIE -ErrorAction SilentlyContinue
}

try {
  if ($Prod) {
    Push-Location (Join-Path $root "frontend"); npm run build; Pop-Location
    Start-Process "http://127.0.0.1:$ApiPort"
    Push-Location (Join-Path $root "backend"); & $uvicorn app.main:get_app --factory --host 127.0.0.1 --port $ApiPort; Pop-Location
    exit
  }
  $WebPort = Select-Port $WebPort 5173
  $env:SIGHTLINE_WEB_PORT = "$WebPort"
  $api = Start-Process -PassThru -NoNewWindow -WorkingDirectory (Join-Path $root "backend") -FilePath $uvicorn `
    -ArgumentList "app.main:get_app","--factory","--host","127.0.0.1","--port","$ApiPort"
  $web = Start-Process -PassThru -NoNewWindow -WorkingDirectory (Join-Path $root "frontend") -FilePath "npm.cmd" -ArgumentList "run","dev"
  Start-Sleep -Seconds 3
  Start-Process "http://localhost:$WebPort"
  Write-Host "$(Split-Path $root -Leaf) lancé : site http://localhost:$WebPort, API port $ApiPort. Ctrl+C pour arrêter." -ForegroundColor Green
  try { Wait-Process -Id $api.Id } finally {
    foreach ($p in @($api, $web)) { if ($p -and -not $p.HasExited) { taskkill /PID $p.Id /T /F | Out-Null } }
  }
} finally {
  # ne pas laisser ces réglages dans la console : un prochain lancement d'une autre copie les hériterait
  Remove-Item Env:SIGHTLINE_API_PORT, Env:SIGHTLINE_WEB_PORT, Env:SKYBOX_SESSION_COOKIE -ErrorAction SilentlyContinue
}
