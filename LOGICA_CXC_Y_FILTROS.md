# Lógica CxC (Vencido vs Vigente) y Filtros

**Referencia de tablas Microsip:** ver también `REFERENCIA_MICROSIP_FUENTES.md` (resumen a partir de *CUENTAS CONTABLES_FUENTES.xlsx*). CxC usa **DOCTOS_CC**, **IMPORTES_DOCTOS_CC** y **CONDICIONES_PAGO**.

---

## 1. Cuentas por cobrar: vencido vs vigente

En Microsip/Firebird la cartera se calcula así:

- **Saldo total por cliente** = Suma de cargos (facturas) − Suma de cobros (recibos), usando `IMPORTES_DOCTOS_CC` (y en tu servidor v9, solo `IMPORTE` + IVA según regla de negocio).
- **Vencido** = Parte del saldo cuya **fecha de vencimiento** ya pasó (hoy > fecha_vencimiento).
- **Vigente (por vencer)** = Parte del saldo cuya fecha de vencimiento aún no llega (hoy ≤ fecha_vencimiento).

### Fecha de vencimiento

Debe calcularse así (en el orden indicado):

1. Si existe **VENCIMIENTOS_CARGOS_CC.FECHA_VENCIMIENTO** para el documento, usarla.
2. Si no, **fallback**: `DOCTOS_CC.FECHA` + **CONDICIONES_PAGO.DIAS_PPAG** (días de crédito de la condición de pago del documento).

Así se respeta la **condición de pago** y el **tiempo transcurrido** desde la emisión.

### En el servidor (server_corregido.js)

- **cxcClienteSQL()**: saldo neto por cliente (C − R). No distingue vencido/vigente.
- **cxcCargosSQL()**: documentos de cargo con `FECHA_VENCIMIENTO` y `DIAS_VENCIDO = CURRENT_DATE - FECHA_VENCIMIENTO`.
- **/api/cxc/resumen**: debe devolver:
  - `SALDO_TOTAL` = suma de saldos netos por cliente.
  - `VENCIDO` = suma de saldo “vencido” (proporcional por documento según `DIAS_VENCIDO > 0`).
  - `POR_VENCER` = `SALDO_TOTAL - VENCIDO` (vigente).

Si casi todo aparece como vencido (ej. 93%), revisar:

1. Que **VENCIMIENTOS_CARGOS_CC** tenga fechas correctas, o que el fallback **DOCTOS_CC.FECHA + DIAS_PPAG** use la condición de pago del **documento** (o la del cliente si aplica).
2. Que **DIAS_PPAG** en **CONDICIONES_PAGO** no sea 0 para crédito (usar por ejemplo 30 si es “30 días”).
3. Que no se esté usando solo la fecha de emisión sin sumar los días de crédito.

### En el front (Director, CxC, Index)

- **Director**: muestra “X% vigente” = `(POR_VENCER / SALDO_TOTAL) * 100`. Si el API no manda `POR_VENCER`, ese valor será 0 y se verá 0% vigente.
- **Index**: “Cartera Total CxC” y “Cartera Vencida” usan el mismo `pVenc` (porcentaje vencido) para que el estado (Activa / Atención / Crítica) sea coherente entre tarjetas y tabla.

---

## 2. Filtros (año, mes, vendedor, fechas)

### Frontend (filters.js)

- **filterBuildQS()** devuelve: `anio`, `mes`, `desde`, `hasta`, `vendedor` según lo elegido en la barra.
- Cada página que use filtros debe:
  1. Incluir `<div id="filter-bar"></div>`.
  2. Cargar `filters.js`.
  3. Llamar **initFilters({ containerId: 'filter-bar', showVendedor: true, onChange: () => recargarDatos() })**.
  4. Construir las URLs con **buildApiUrl('/api/...')** (o el helper que use `filterBuildQS()`).

### Backend (server_corregido.js)

- **buildFiltros(req, alias)** lee `req.query`: `anio`, `mes`, `desde`, `hasta`, `vendedor`, `cliente`.
- Devuelve `{ sql, params, lookbackOverride }` para añadir al `WHERE` de las consultas.
- Los endpoints que deben respetar filtros incluyen:
  - **/api/ventas/resumen**
  - **/api/ventas/cumplimiento**
  - **/api/ventas/diarias**, **mensuales**, **por-vendedor**, **por-vendedor/cotizaciones**
  - **/api/cxc/resumen** (si aplica filtro por cliente)
  - **/api/director/resumen** (si se añade filtro por periodo)

Si **ningún filtro funciona**, comprobar:

1. Que en el HTML se llame **initFilters** y que **onChange** vuelva a pedir los datos (por ejemplo `loadAll()` o `loadData()`).
2. Que las peticiones usen **buildApiUrl** (o equivalente) para que la URL lleve `?anio=2025&mes=3&vendedor=2`, etc.
3. Que en el servidor cada ruta use **buildFiltros(req)** y aplique `f.sql` y `f.params` en la consulta correspondiente.

---

## 3. Resumen de cambios en HTML (ya aplicados)

| Página      | Cambios principales |
|------------|----------------------|
| **index**  | API base, barra de filtros, initFilters + buildApiUrl en loadAll, consistencia CxC e inventario (meta 15, statusCxc), texto sin `?` y con “—” donde no hay dato. |
| **resultados** | API base para que funcione con servidor/localhost. |
| **director**   | API base, % vigente seguro (evitar NaN), textos con · y tildes. |
| **cxc**       | API base. |
| **clientes**  | API base, timeouts en fwt, mensaje de error en heroSub. |
| **vendedores** | (ya corregido antes) API base, filtros, mensajes vacío/error. |

Si subes el **Excel de estructura de Microsip** o el **.pbix de Power BI**, se puede alinear aún más la lógica de CxC y los conceptos de los reportes con lo que ya tienes en el servidor y en los dashboards.
