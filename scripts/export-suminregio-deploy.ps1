# Genera carpeta limpia para subir a GitHub / Render (sin respaldos ni node_modules).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "microsip-api_Beto\microsip-api\Cerebro Cursor\microsip-api (Del Remoto)"
$dst = Join-Path $root "suminregio-microsip-deploy"

if (-not (Test-Path $src)) {
  Write-Error "No existe la ruta origen: $src"
}

if (Test-Path $dst) {
  Remove-Item $dst -Recurse -Force
}
New-Item -ItemType Directory -Path $dst | Out-Null

$files = @(
  "server_corregido.js",
  "package.json",
  "package-lock.json",
  "filters.js",
  "nav.js",
  "AGENTS.md",
  ".env.example",
  ".gitignore"
)
foreach ($f in $files) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $dst $f) }
}

Copy-Item (Join-Path $src "public") (Join-Path $dst "public") -Recurse

$gh = Join-Path $src ".github"
if (Test-Path $gh) {
  Copy-Item $gh (Join-Path $dst ".github") -Recurse -Force
}

foreach ($docName in @("GITHUB-RUNNER-WINDOWS.md", "GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md")) {
  $p = Join-Path $src $docName
  if (Test-Path $p) { Copy-Item $p (Join-Path $dst $docName) }
}

$docSrc = Join-Path $PSScriptRoot "DEPLOY-RENDER.md"
$docDst = Join-Path $dst "DEPLOY-RENDER.md"
if (Test-Path $docSrc) { Copy-Item $docSrc $docDst }

Write-Host "Listo: $dst"
Get-ChildItem $dst -Recurse -File | Measure-Object | ForEach-Object { Write-Host ("Archivos: " + $_.Count) }
