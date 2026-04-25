# Smoke test local server on :7070 — valida que todos los endpoints
# críticos del dashboard devuelvan 200 + el shape que cada página espera.
$ErrorActionPreference = 'Continue'
$base = 'http://localhost:7070'
$anio = 2026
$mes = 3
$preset = 'mes_ant'

function Probe($path, $expect) {
  $url = "$base$path"
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 45
    $code = $r.StatusCode
    $body = $r.Content
    $summary = ''
    try {
      $json = $body | ConvertFrom-Json
      if ($json -is [System.Array]) {
        $summary = "array len=$($json.Length)"
        if ($json.Length -gt 0) {
          $keys = ($json[0].PSObject.Properties.Name -join ',')
          if ($keys.Length -gt 140) { $keys = $keys.Substring(0, 140) + '...' }
          $summary += " keys=[$keys]"
        }
      } else {
        $topKeys = ($json.PSObject.Properties.Name -join ',')
        if ($topKeys.Length -gt 140) { $topKeys = $topKeys.Substring(0, 140) + '...' }
        $summary = "obj keys=[$topKeys]"
      }
    } catch {
      $snippet = if ($body.Length -gt 100) { $body.Substring(0,100) } else { $body }
      $summary = "non-json: $snippet"
    }
    Write-Host ("[{0}] {1,-55} {2}" -f $code, $path, $summary)
  } catch {
    $msg = $_.Exception.Message
    if ($msg.Length -gt 80) { $msg = $msg.Substring(0,80) }
    Write-Host ("[ERR] {0,-55} {1}" -f $path, $msg)
  }
}

Write-Host "=== DIRECTOR ==="
Probe "/api/director/resumen?unidad=parker&anio=$anio&mes=$mes" "obj KPIs"
Probe "/api/director/vendedores?unidad=parker&anio=$anio&mes=$mes" "array vendedores"
Probe "/api/director/top-clientes?unidad=parker&anio=$anio&mes=$mes" "array top clientes"
Probe "/api/director/recientes?unidad=parker&anio=$anio&mes=$mes" "array recientes"
Probe "/api/director/ventas-diarias?unidad=parker&anio=$anio&mes=$mes" "array diarias"

Write-Host ""
Write-Host "=== P&L / RESULTADOS ==="
Probe "/api/resultados/pnl?unidad=parker&anio=$anio&mes=$mes&preset=$preset" "P&L completo"
Probe "/api/resultados/pnl-universe?unidad=parker&anio=$anio&mes=$mes" "universe"
Probe "/api/resultados/balance-general?unidad=parker&anio=$anio&mes=$mes" "balance"
Probe "/api/resultados/estado-sr?unidad=parker&anio=$anio&mes=$mes" "estado-sr"
Probe "/api/compare/temporal?unidad=parker&anio=$anio&mes=$mes&metrics=ventas_mes,cxc_total" "metrics"

Write-Host ""
Write-Host "=== INVENTARIO ==="
Probe "/api/inv/top-stock?unidad=parker&limite=10" "EXISTENCIA, VALOR_TOTAL"
Probe "/api/inv/bajo-minimo?unidad=parker&limite=10" "FALTANTE"
Probe "/api/inv/sin-movimiento?unidad=parker&dias=180&limite=10" "existencia, valor"
Probe "/api/inv/consumo-semanal?unidad=parker&dias=90&limite=10" "CONSUMO_SEMANAL_PROM"
Probe "/api/inv/consumo?unidad=parker&limite=10" "CONSUMO_DIARIO_PROM"
Probe "/api/inv/operacion-critica?unidad=parker" "bajo_minimo, sin_mov"
Probe "/api/inv/existencias?unidad=parker" "existencias"
Probe "/api/inv/resumen?unidad=parker" "resumen inventario"

Write-Host ""
Write-Host "=== COBRADAS ==="
Probe "/api/ventas/cobradas?unidad=parker&anio=$anio&mes=$mes" "obj {vendedores, totalCobrado}"
Probe "/api/ventas/cobradas-detalle?unidad=parker&anio=$anio&mes=$mes" "array detalle"
Probe "/api/ventas/cobradas-por-factura?unidad=parker&anio=$anio&mes=$mes" "array FECHA_FACTURA"

Write-Host ""
Write-Host "=== CLIENTES ==="
Probe "/api/clientes/inteligencia?unidad=parker&limite=20" "obj {ok, rows}"
Probe "/api/clientes/resumen-riesgo?unidad=parker" "obj con clientes y buckets"
Probe "/api/clientes/inactivos?unidad=parker&limite=20" "inactivos"
Probe "/api/clientes/comercial-atraso?unidad=parker&limite=20" "comercial atraso"

Write-Host ""
Write-Host "=== CXC ==="
Probe "/api/cxc/por-condicion?unidad=parker" "por condicion"
Probe "/api/cxc/historial-pagos?unidad=parker&anio=$anio&mes=$mes" "pagos"
Probe "/api/cxc/top-deudores?unidad=parker&limite=10" "deudores"
Probe "/api/cxc/vencidas?unidad=parker&limite=20" "vencidas"
Probe "/api/cxc/vigentes?unidad=parker&limite=20" "vigentes"
Probe "/api/cxc/resumen-aging?unidad=parker" "aging"

Write-Host ""
Write-Host "=== CAPITAL ==="
Probe "/api/capital/snapshot?unidad=parker" "cxc, cxp, inventario, bancos"

Write-Host ""
Write-Host "=== VENTAS ==="
Probe "/api/ventas/resumen?unidad=parker&anio=$anio&mes=$mes" "resumen"
Probe "/api/ventas/diarias?unidad=parker&anio=$anio&mes=$mes" "array diarias"
Probe "/api/ventas/mensuales?unidad=parker&anio=$anio" "mensuales"
Probe "/api/ventas/por-vendedor?unidad=parker&anio=$anio&mes=$mes" "por vendedor"
Probe "/api/ventas/top-clientes?unidad=parker&anio=$anio&mes=$mes&limite=10" "top clientes"
Probe "/api/ventas/recientes?unidad=parker&limite=10" "recientes"
Probe "/api/ventas/cumplimiento?unidad=parker&anio=$anio&mes=$mes" "cumplimiento"
Probe "/api/ventas/margen-lineas?unidad=parker&anio=$anio&mes=$mes" "margen lineas"
Probe "/api/ventas/cotizaciones/resumen?unidad=parker&anio=$anio&mes=$mes" "cotizaciones resumen"
Probe "/api/ventas/cotizaciones/diarias?unidad=parker&anio=$anio&mes=$mes" "cotizaciones diarias"
Probe "/api/ventas/por-vendedor/cotizaciones?unidad=parker&anio=$anio&mes=$mes" "vendedor/cotizaciones"
Probe "/api/ventas/vs-cotizaciones?unidad=parker&anio=$anio" "vs-cotizaciones"
