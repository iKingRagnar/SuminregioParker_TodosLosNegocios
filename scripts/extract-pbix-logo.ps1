# Extrae imágenes de un .pbix y copia la más grande a public/suminregio-logo-pbi.png (revisar si no es el logo).
# Uso (PowerShell, desde cualquier sitio):
#   .\scripts\extract-pbix-logo.ps1 -PbixPath "C:\ruta\Ventas.pbix"
param(
  [Parameter(Mandatory = $true)][string]$PbixPath
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $PbixPath)) {
  Write-Error "No existe el archivo: $PbixPath"
}
$repoRoot = Split-Path $PSScriptRoot -Parent
$publicDir = Join-Path $repoRoot "public"
$tmp = Join-Path $repoRoot ".tmp_pbix_extract"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "ventas.zip"
Copy-Item -LiteralPath $PbixPath -Destination $zip -Force
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp "pkg") -Force
$imgs = @(Get-ChildItem (Join-Path $tmp "pkg") -Recurse -Include *.png, *.jpg, *.jpeg -ErrorAction SilentlyContinue | Sort-Object Length -Descending)
if ($imgs.Count -eq 0) {
  Write-Warning "No se encontraron PNG/JPG dentro del pbix. El logo puede ir embebido en Layout (base64); exportalo manualmente desde Power BI."
  exit 1
}
Write-Host "Imágenes encontradas (primeras 15 por tamaño):"
$imgs | Select-Object -First 15 | ForEach-Object { Write-Host ("  {0} ({1} bytes)" -f $_.FullName, $_.Length) }
$pick = $imgs[0]
$ext = $pick.Extension.ToLowerInvariant()
$baseName = "suminregio-logo-pbi"
if ($ext -eq ".png") {
  $outFile = "$baseName.png"
}
elseif ($ext -eq ".jpg" -or $ext -eq ".jpeg") {
  $outFile = "$baseName.jpg"
}
else {
  $outFile = "$baseName$ext"
}
$out = Join-Path $publicDir $outFile
Copy-Item -LiteralPath $pick.FullName -Destination $out -Force
Write-Host ""
Write-Host "Copiado (mayor tamaño) -> $out"
Write-Host "Si no es el logo de portada, copia manualmente el PNG correcto desde la carpeta extraída:"
Write-Host "  $tmp\pkg"
