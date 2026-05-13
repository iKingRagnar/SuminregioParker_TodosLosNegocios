# Discrepancia entre Dashboard y Microsip Ventas

> **Síntoma observado:** El director compara la facturación de un mes en Microsip → Ventas → Facturación y los números no coinciden con el dashboard (típicamente el dashboard reporta MENOS).
>
> **Reportado:** Abril 2026 — Microsip $3,229,993.74 vs Dashboard $2,793,908.70 (diff $436k). Mayo 2026 — Microsip $850,819.98 vs Dashboard $733,485.50 (diff $117k).

## Por qué pasa

El módulo de Ventas de Microsip cuenta **todos los documentos** de tipo Factura emitidos en el periodo, estén o no contabilizados. El dashboard, históricamente, aplicaba un filtro adicional `APLICADO='S'` que **excluye los documentos que el contador aún no ha aplicado** (es decir, las facturas emitidas pero todavía sin póliza contable creada).

En empresas donde la contabilidad va con lag de 30-60 días (típico en México), el dashboard reportaba consistentemente menos que Microsip Ventas, generando confusión.

Hay una segunda fuente potencial de diferencia: el endpoint `/api/ventas/resumen` también **prefiere los saldos contables** (`SALDOS_CO` cuenta 4*) sobre la suma de documentos cuando hay datos contables disponibles. Esto alinea el dashboard con el P&L (Estado de Resultados), pero divergencia del módulo Ventas si hay lag contable.

## Fix actual (post Mayo 2026)

El endpoint `/api/ventas/resumen` ahora devuelve **tres números** explícitos para que cada vista del dashboard pueda elegir cuál mostrar:

| Campo | Qué representa | Filtros | Coincide con |
|---|---|---|---|
| `MES_ACTUAL_FACTURADO` | Suma cruda de DOCTOS_VE + DOCTOS_PV, TIPO 'V'/'F' | `ESTATUS NOT IN ('C','D','S')` | **Microsip → Ventas → Facturación** |
| `MES_ACTUAL_DOCS` | Igual al anterior pero con `APLICADO='S'` | + `APLICADO='S'` | Microsip → Ventas → Facturación **aplicada** |
| `MES_ACTUAL_CONTA` | Suma de `SALDOS_CO` cuenta 4* (abonos − cargos) | — | Microsip → Contabilidad → Saldos cuenta 4* (= P&L) |
| `MES_ACTUAL` | Compatibilidad: contable si hay datos, sino docs aplicados | — | Histórico, mantenido para no romper páginas viejas |

Además expone:

| Campo | Significado |
|---|---|
| `FACTURAS_MES_FACTURADO` | Conteo de facturas (TODAS, aplicadas o no) |
| `FACTURAS_MES` | Conteo de facturas aplicadas |
| `FACTURAS_SIN_APLICAR` | Cuántas están emitidas pero no aplicadas |
| `MONTO_SIN_APLICAR` | Monto correspondiente a esas facturas |

## Qué muestra cada página

- `suministros-medicos.html` — usa `MES_ACTUAL_FACTURADO` como número primario y agrega subtexto "X facturas · cuadra con Microsip Ventas · Y sin aplicar contablemente ($Z)" cuando hay lag.
- `resultados.html` (P&L) — sigue usando `MES_ACTUAL_CONTA` porque debe cuadrar con el Estado de Resultados.
- `ventas.html` (general) — usa `MES_ACTUAL` (comportamiento histórico). Si el director quiere alinear con Microsip Ventas, cambiar a `MES_ACTUAL_FACTURADO` en el front.

## Cómo verificar manualmente

```bash
# Endpoint de diagnóstico (requiere Firebird directo, no funciona en Render con DUCK_ONLY_MODE):
curl 'https://tu-deploy.com/api/diagnostico/ventas?db=suminregio_suministros_medicos&desde=2026-04-01&hasta=2026-04-30' | jq

# Endpoint principal — comparar campos:
curl 'https://tu-deploy.com/api/ventas/resumen?db=suminregio_suministros_medicos&anio=2026&mes=4' | jq '{
  MES_ACTUAL,
  MES_ACTUAL_FACTURADO,
  MES_ACTUAL_DOCS,
  MES_ACTUAL_CONTA,
  FACTURAS_SIN_APLICAR,
  MONTO_SIN_APLICAR
}'
```

`MES_ACTUAL_FACTURADO` es el número que debería coincidir con Microsip → Ventas → Facturación.

Si NO coincide al usar `MES_ACTUAL_FACTURADO`, las causas posibles restantes son:

1. **Snapshot DuckDB desactualizado** — verifica `/api/admin/mode` o `/api/health/deep`. Si el `cutoff` o `CREATED_AT` es de hace más de 30 horas, corre manualmente `sync_duckdb.py` o reinicia el cron del servidor Windows.
2. **Filtros de fecha** — Microsip usa `FECHA_DOCUMENTO`; el dashboard usa `FECHA`. En el 99% de los casos son la misma, pero documentos con `FECHA_DOCUMENTO` y `FECHA` distintas pueden diferir.
3. **DB equivocada** — el frontend de Suministros Médicos consulta `db=suminregio_suministros_medicos`. Si esa empresa no está registrada en `fb-databases.registry.json` o el snapshot no se subió, el dashboard puede estar leyendo de la default.
4. **Filtro de vendedor activo** — la UI tiene filtros que pueden estar restringiendo a un vendedor; verifica que la URL no tenga `?vendedor=...`.

## Decisión de diseño

**Why not just remove `APLICADO='S'` everywhere?** Porque algunos cálculos (P&L, CxC, comisiones) sí dependen de que el documento esté aplicado contablemente. Por ejemplo, comisiones se pagan sobre lo facturado-y-aplicado, no sobre lo facturado-pendiente-de-aplicar.

La solución correcta es **exponer ambos números** y dejar que cada vista del dashboard elija el que corresponde a su contexto. Esa es la elección hecha en este fix.
