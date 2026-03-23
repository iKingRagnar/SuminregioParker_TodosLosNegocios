# Diagnóstico de Discrepancias — Suminregio Parker ERP Dashboard
**Fecha:** 22 Mar 2026 | **Servidor:** server_corregido.js v9 | **BD:** SUMINREGIO-PARKER.FDB (Firebird 3.0)

---

## 🔴 DISCREPANCIA 1 — Ventas de resultados.html ≠ ventas.html / director.html

### Causa raíz
El servidor tiene **dos funciones de importe distintas**:

| Función | Expresión SQL | Usada en |
|---------|--------------|---------|
| `sqlVentaImporteBaseExpr()` | `IMPORTE_NETO / 1.16` | ventas.html, director.html, vendedores.html, cobradas.html |
| `sqlVentaImporteResultadosExpr()` | `IMPORTE_NETO` (sin divisor) | resultados.html (local `impRes` en `resultadosPnlCore()`) |

**Efecto**: Si `IMPORTE_NETO` en Microsip contiene el total con IVA (comportamiento estándar), `resultados.html` muestra ventas **16% más altas** que todos los demás dashboards.

### Evidencia en el código
```js
// server_corregido.js línea ~2830:
const impRes = sqlVentaImporteResultadosExpr('d');   // ← NO divide entre 1.16
// DEBERÍA ser:
const impRes = sqlVentaImporteBaseExpr('d');          // ← sí divide entre 1.16
```

### Fix aplicado: ✅ ver sección de correcciones

---

## 🔴 DISCREPANCIA 2 — CXC: % Vigente = 0% (vencido > saldo total)

### Causa raíz
Las dos queries de CXC usan **bases distintas**:

| Query | Calcula | Base |
|-------|---------|------|
| `cxcClienteSQL()` → `SALDO_TOTAL` | Saldo neto real por cliente = Σ(cargos) − Σ(cobros) | IMPORTE de IMPORTES_DOCTOS_CC |
| `cxcCargosSQL()` → `VENCIDO` | Suma el **importe bruto del cargo** (`i.IMPORTE`) de documentos vencidos | Cargo completo sin descontar cobros |

**Ejemplo concreto:**
- Factura $100 (cargo), cliente pagó $80 (cobro)
- `SALDO_TOTAL` = $20 (correcto)
- `VENCIDO` (desde `cxcCargosSQL`) = $100 (el cargo completo, no el saldo neto del doc)
- Resultado: `cxc_vigente = $20 - $100 = -$80` → frontend muestra **0% vigente**

### Fix aplicado: ✅ Cap de VENCIDO al mínimo del saldo real

---

## 🔴 DISCREPANCIA 3 — CXC por Condición de Pago usa condición del CLIENTE, no del DOCUMENTO

### Causa raíz
```sql
-- ACTUAL (incorrecto para análisis por condición real del documento):
LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
-- CORRECTO (condición del documento, que puede diferir del cliente):
LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
```

Esto hace que la tab "Por Condición" agrupe incorrectamente cuando el vendedor le otorga una condición diferente al cliente.

### Fix aplicado: ✅ ver sección de correcciones

---

## 🟡 DISCREPANCIA 4 — Costo de Ventas: múltiples rutas de fallback con orden subóptimo

### Causa raíz
`resultadosPnlCore()` intenta el costo en este orden:
1. DOCTOS_IN histórico por artículo (subquery correlacionada) → **muy lento, incorrecto para Parker**
2. ARTICULOS.COSTO_PROMEDIO → puede no existir en esta instalación
3. DOCTOS_VE_DET.COSTO_TOTAL / COSTO_UNITARIO → NULL en Parker
4. DOCTOS_CO_DET con CUENTAS_CO (filtro "COSTO") → **fuente correcta para Parker**
5. SALDOS_CO cuenta 5101 → **segunda opción correcta**

Si los pasos 1-3 devuelven algún valor no-cero (aunque incorrecto), no se llega a contabilidad.

### Fix recomendado:
Agregar un flag en `.env`: `MICROSIP_COSTO_DESDE=contabilidad` para que `resultadosPnlCore()` salte directo a la fuente contable. Se documenta abajo.

---

## 🟡 DISCREPANCIA 5 — Ventas: APLICADO='S' puede excluir facturas válidas en algunas instalaciones

### Causa raíz
`ventasSub()` filtra `COALESCE(d.APLICADO, 'N') = 'S'`.
En Microsip, algunas facturas quedan en `APLICADO='N'` temporalmente antes de ser aplicadas a CXC. Esto puede causar que ventas del día actual no aparezcan en los dashboards.

### Diagnóstico:
```
GET http://localhost:7000/api/debug/ventas
→ doctos_ve: N (facturas F/V no canceladas)
Si N es muy bajo vs lo esperado → el filtro APLICADO está excluyendo documentos
```

### Fix: documentado en .env con `MICROSIP_VENTAS_EXCLUIR_NO_APLICADO=false`

---

## ✅ REFERENCIAS DE TABLAS CONFIRMADAS

| Módulo | Tablas principales | Campo clave |
|--------|-------------------|-------------|
| Ventas Industrial | DOCTOS_VE + DOCTOS_VE_DET | TIPO_DOCTO='F'/'V', APLICADO='S', ESTATUS≠'C' |
| Ventas Mostrador | DOCTOS_PV + DOCTOS_PV_DET | igual |
| CXC Saldo | IMPORTES_DOCTOS_CC → DOCTOS_CC | TIPO_IMPTE='C' cargo, 'R' cobro |
| CXC Aging | VENCIMIENTOS_CARGOS_CC + CONDICIONES_PAGO | FECHA_VENCIMIENTO |
| P&L Ventas | ventasSubRes (igual que ventasSub) | IMPORTE_NETO / 1.16 |
| P&L Costo | DOCTOS_CO_DET + CUENTAS_CO | NOMBRE CONTAINING 'COSTO' |
| P&L Cobros | IMPORTES_DOCTOS_CC | TIPO_IMPTE='R', normalizado ex-IVA |
| Gastos | SALDOS_CO + CUENTAS_CO | CUENTA_PT STARTING '52','53','54' |

---

## CORRECCIONES APLICADAS

### server_corregido.js (v9)
Los cambios son quirúrgicos y no afectan endpoints no mencionados.

1. **Línea ~2830**: `impRes = sqlVentaImporteBaseExpr('d')` (era `sqlVentaImporteResultadosExpr`)
2. **Líneas ~3060, ~3066**: descuentos/devoluciones también usan divisor consistente
3. **`/api/cxc/resumen`**: `vencido = Math.min(vencido, saldo_total)` para evitar % vigente negativo
4. **`/api/director/resumen`**: misma corrección de cap en vencido
5. **`/api/cxc/por-condicion`**: usa `dc.COND_PAGO_ID` (documento) no `c.COND_PAGO_ID` (cliente)

### public/*.html — Timeouts y robustez de red

Todos los dashboards tenían timeouts demasiado cortos (8-12 s) o incluso sin timeout, lo que causaba que la UI mostrara datos vacíos/fallback ante cualquier consulta lenta en Firebird. Correcciones:

| Archivo | Problema | Fix |
|---------|---------|-----|
| `cxc.html` | `apiFetch()` sin ningún timeout → cuelgue indefinido | AbortController 20 s (30 s en historial) |
| `resultados.html` | `tryFetch()` sin timeout → cuelgue en PNL | AbortController 60 s |
| `director.html` | `fetchJson()` sin timeout; `fwt` default 10 s | AbortController 25 s; default fwt 20 s |
| `vendedores.html` | `fwt` default 10 s; PNL en sidebar 10 s | Default 15 s; cumplimiento 25 s; cotizaciones 30 s; PNL 45 s |
| `cobradas.html` | `fwt` default 12 s | Default 20 s; cobradas 25 s; por-factura 30 s |
| `clientes.html` | `resumen-riesgo` 8 s (muy corto) | 20 s en todos los endpoints de clientes |
| `inventario.html` | Todo con `fetch()` sin timeout | `apiFetch()` con AbortController 20-25 s |
| `consumos.html` | `api()` sin timeout | AbortController 25 s |
| `margen-producto.html` | `fetch()` sin timeout; PNL sin timeout | `tFetch()` 30 s; PNL 60 s |
| `index.html` | `fwt` default 10 s (aunque `tKpi=35000` ya lo cubre) | Default 20 s |
