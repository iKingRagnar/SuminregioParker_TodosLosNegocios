'use strict';

/**
 * reorden-dinamico.js — Punto de reorden con stock de seguridad estadístico
 *   GET /api/inv/reorden?db=...&service_level=0.95&lead=15
 *
 * Fórmula:
 *   ROP (Reorder Point) = D̄·L + Z·σ_D·√L
 *     D̄  = demanda diaria promedio (últimos 180d, robusto)
 *     L   = lead time en días (por proveedor o default)
 *     σ_D = desv. estándar diaria
 *     Z   = z-score del nivel de servicio (0.95 → 1.645, 0.99 → 2.326)
 *
 *   EOQ (Economic Order Quantity):
 *     EOQ = √(2·D·S / H)
 *       D = demanda anual
 *       S = costo de ordenar (default $200 MXN, override por env REORDEN_S)
 *       H = costo de mantener inventario por unidad/año (default 25% del costo)
 *
 *   Stock máximo recomendado = ROP + EOQ
 *
 *  Lead time por proveedor: si la tabla PROVEEDORES tiene DIAS_ENTREGA, lo usa.
 *  Si no, usa LEAD env (default 15).
 */

const { makeHelpers } = require('./lib/snap-helper');
const memoLib = require('./lib/memo');

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);
  // La query base (demanda/stock/costos) sólo depende de la base de datos, no de
  // service_level/lead (que se aplican en el post-proceso JS). Memoizar evita
  // recorrer DOCTOS_VE_DET / SALDOS_IN / DOCTOS_IN_DET en cada request.
  const memo = memoLib.create({ ttlMs: 10 * 60 * 1000, max: 50 });

  // Z-score para niveles de servicio comunes
  function zForSL(sl) {
    if (sl >= 0.99) return 2.326;
    if (sl >= 0.975) return 1.960;
    if (sl >= 0.95) return 1.645;
    if (sl >= 0.90) return 1.282;
    return 1.0;
  }

  app.get('/api/inv/reorden', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const sl = Math.max(0.5, Math.min(0.999, parseFloat(req.query.service_level) || 0.95));
    const leadDefault = Math.max(1, Math.min(120, parseInt(req.query.lead, 10) || 15));
    const Z = zForSL(sl);
    const S_costo_orden = parseFloat(process.env.REORDEN_S) || 200;
    const H_pct = parseFloat(process.env.REORDEN_H_PCT) || 0.25;

    try {
      // Detecta si la tabla ARTICULOS tiene columna PROVEEDOR_PRINCIPAL_ID
      const cols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'ARTICULOS'`).catch(() => []);
      const colNames = new Set(cols.map((c) => c.n));
      const provCol = colNames.has('PROVEEDOR_PRINCIPAL_ID') ? 'PROVEEDOR_PRINCIPAL_ID'
        : colNames.has('PROVEEDOR_ID') ? 'PROVEEDOR_ID' : null;

      // Detecta tabla PROVEEDORES con DIAS_ENTREGA
      let proveedorJoin = '';
      let proveedorSelect = `${leadDefault}::INT AS lead_time`;
      if (provCol) {
        const provCols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'PROVEEDORES'`).catch(() => []);
        const provColNames = new Set(provCols.map((c) => c.n));
        if (provColNames.has('DIAS_ENTREGA')) {
          proveedorJoin = `LEFT JOIN PROVEEDORES prov ON prov.PROVEEDOR_ID = a.${provCol}`;
          proveedorSelect = `COALESCE(prov.DIAS_ENTREGA, ${leadDefault})::INT AS lead_time`;
        }
      }

      const rowsKey = `reorden-rows:${req.query.db || 'default'}`;
      const rows = await memo.wrap(rowsKey, () => all(snap, `
        WITH daily AS (
          SELECT d.ARTICULO_ID, h.FECHA, SUM(d.UNIDADES) AS u_dia
          FROM DOCTOS_VE_DET d
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 180 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID, h.FECHA
        ),
        stats AS (
          SELECT ARTICULO_ID,
                 AVG(u_dia) AS d_prom,
                 STDDEV_POP(u_dia) AS d_sd,
                 COUNT(*) AS dias_con_venta,
                 SUM(u_dia) AS total_180d
          FROM daily
          GROUP BY ARTICULO_ID
          HAVING SUM(u_dia) > 0
        ),
        stock AS (
          SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS existencia
          FROM SALDOS_IN GROUP BY ARTICULO_ID
        ),
        costos AS (
          SELECT d.ARTICULO_ID, AVG(d.COSTO_UNITARIO) AS costo_unit
          FROM DOCTOS_IN_DET d
          JOIN DOCTOS_IN h ON h.DOCTO_IN_ID = d.DOCTO_IN_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 365 DAY
            AND d.COSTO_UNITARIO > 0
          GROUP BY d.ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               s.d_prom, s.d_sd, s.dias_con_venta, s.total_180d,
               COALESCE(st.existencia, 0) AS existencia,
               c.costo_unit,
               ${proveedorSelect}
        FROM stats s
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = s.ARTICULO_ID
        LEFT JOIN stock st     ON st.ARTICULO_ID = s.ARTICULO_ID
        LEFT JOIN costos c     ON c.ARTICULO_ID = s.ARTICULO_ID
        ${proveedorJoin}
        ORDER BY s.total_180d DESC
        LIMIT 1000`));

      const items = rows.map((r) => {
        const D = Number(r.d_prom) || 0;
        const SD = Number(r.d_sd) || 0;
        const L = Number(r.lead_time) || leadDefault;
        const costo = Number(r.costo_unit) || 0;
        const existencia = Number(r.existencia) || 0;
        const demandaAnual = D * 365;

        const ss = Z * SD * Math.sqrt(L);                       // safety stock
        const rop = D * L + ss;                                  // reorder point
        const H = costo * H_pct;                                 // holding cost / unidad / año
        const eoq = H > 0 ? Math.sqrt(2 * demandaAnual * S_costo_orden / H) : (D * 30); // fallback 30d
        const stockMax = rop + eoq;
        const necesitaCompra = existencia < rop;
        const cantidadSugerida = necesitaCompra ? Math.max(eoq, rop - existencia) : 0;

        return {
          articulo_id: r.ARTICULO_ID,
          articulo: r.articulo,
          clave: r.CLAVE,
          lead_time: L,
          demanda_diaria_prom: +D.toFixed(2),
          demanda_diaria_sd: +SD.toFixed(2),
          coef_variacion: D > 0 ? +(SD / D).toFixed(2) : null,
          existencia,
          costo_unit: costo,
          safety_stock: Math.ceil(ss),
          reorder_point: Math.ceil(rop),
          eoq: Math.ceil(eoq),
          stock_maximo: Math.ceil(stockMax),
          necesita_compra: necesitaCompra,
          cantidad_sugerida: Math.ceil(cantidadSugerida),
          valor_sugerido: Math.ceil(cantidadSugerida * costo),
        };
      });

      const valorTotal = items.reduce((s, r) => s + (r.necesita_compra ? r.valor_sugerido : 0), 0);
      res.json({
        ok: true,
        config: { service_level: sl, z_score: Z, lead_default_dias: leadDefault, costo_ordenar: S_costo_orden, holding_pct: H_pct },
        total_skus: items.length,
        skus_a_reordenar: items.filter((r) => r.necesita_compra).length,
        valor_orden_total: valorTotal,
        items,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('reorden-dinamico', '✅ /api/inv/reorden');
}

module.exports = { install };
