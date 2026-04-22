'use strict';

/**
 * business-intel.js — Endpoints específicos del negocio Microsip
 *   GET /api/bi/pipeline-cotizaciones?db=...   → funnel cotización→pedido→factura
 *   GET /api/bi/cashflow?dias=60&db=...        → proyección entradas/salidas
 *   GET /api/bi/comisiones?mes=YYYY-MM&db=...  → comisiones por vendedor
 *   GET /api/bi/margen-productos?min=15&db=... → productos con margen bajo el umbral
 *   GET /api/bi/rotacion-categorias?db=...     → rotación de inventario por categoría
 *   POST /api/bi/conciliacion-bancaria         → recibe movimientos bancarios, matchea con cobros
 */

function install(app, { duckSnaps, log }) {
  function getSnap(req) {
    const id = String((req.query && req.query.db) || (req.body && req.body.db) || 'default');
    const s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }
  function all(snap, sql, params) {
    return new Promise((res, rej) => snap.conn.all(sql, ...(params || []), (err, rows) => err ? rej(err) : res(rows || [])));
  }

  // ═══════════════════ Pipeline de cotizaciones (funnel) ══════════════════════
  app.get('/api/bi/pipeline-cotizaciones', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      // DOCTOS_VE con TIPO_DOCTO: C=Cotización, P=Pedido, F=Factura, R=Remisión
      const dias = Math.min(365, Math.max(7, parseInt(req.query.dias, 10) || 90));
      const rows = await all(snap, `
        SELECT TIPO_DOCTO,
               COUNT(*) AS docs,
               SUM(IMPORTE_NETO) AS monto,
               COUNT(DISTINCT CLIENTE_ID) AS clientes
        FROM DOCTOS_VE
        WHERE FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
          AND (ESTATUS IS NULL OR ESTATUS <> 'C')
        GROUP BY TIPO_DOCTO`);

      const map = {};
      rows.forEach((r) => { map[r.TIPO_DOCTO] = r; });

      const cotiz = Number((map['C'] || {}).monto) || 0;
      const ped   = Number((map['P'] || {}).monto) || 0;
      const fact  = Number((map['F'] || {}).monto) || 0;
      const rem   = Number((map['R'] || {}).monto) || 0;

      const facturado = fact + rem;
      const conv_cotiz_a_fact = cotiz > 0 ? (facturado / cotiz) * 100 : 0;
      const leak_cotiz = cotiz - facturado;

      res.json({
        ok: true, dias,
        funnel: {
          cotizaciones: { docs: (map['C'] || {}).docs || 0, monto: cotiz, clientes: (map['C'] || {}).clientes || 0 },
          pedidos:      { docs: (map['P'] || {}).docs || 0, monto: ped,   clientes: (map['P'] || {}).clientes || 0 },
          facturas:     { docs: (map['F'] || {}).docs || 0, monto: fact,  clientes: (map['F'] || {}).clientes || 0 },
          remisiones:   { docs: (map['R'] || {}).docs || 0, monto: rem,   clientes: (map['R'] || {}).clientes || 0 },
        },
        metricas: {
          conversion_cotiz_a_factura_pct: +conv_cotiz_a_fact.toFixed(1),
          leak_no_facturado_mxn: leak_cotiz,
          ticket_promedio_factura: (map['F'] || {}).docs > 0 ? fact / (map['F'] || {}).docs : 0,
        },
        raw: rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Cash flow projection ═══════════════════════════════════
  app.get('/api/bi/cashflow', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      const dias = Math.min(180, Math.max(7, parseInt(req.query.dias, 10) || 60));

      // Entradas: CXC por vencer en los próximos N días
      const entradas = await all(snap, `
        SELECT
          (CURRENT_DATE + INTERVAL 1 DAY * days_to_due) AS fecha_proyectada,
          SUM(imp) AS monto
        FROM (
          SELECT
            d.IMPORTE_NETO AS imp,
            DATE_DIFF('day', CURRENT_DATE, d.FECHA + INTERVAL '30' DAY) AS days_to_due
          FROM DOCTOS_CC d
          WHERE d.FECHA >= CURRENT_DATE - INTERVAL 90 DAY
            AND d.IMPORTE_NETO > 0
        )
        WHERE days_to_due BETWEEN 0 AND ${dias}
        GROUP BY days_to_due
        ORDER BY days_to_due`);

      // Promedio diario histórico (ventas 30d) — cuando no hay info específica
      const promedio = await all(snap, `
        SELECT AVG(daily) AS avg_ventas_dia
        FROM (
          SELECT FECHA, SUM(IMPORTE_NETO) AS daily
          FROM DOCTOS_VE
          WHERE FECHA >= CURRENT_DATE - INTERVAL 30 DAY
            AND (ESTATUS IS NULL OR ESTATUS <> 'C')
          GROUP BY FECHA
        )`);

      const avgDia = Number((promedio[0] || {}).avg_ventas_dia) || 0;
      const totalEntradas = entradas.reduce((s, r) => s + (Number(r.monto) || 0), 0);

      res.json({
        ok: true,
        dias_proyectados: dias,
        entradas_proyectadas: entradas,
        total_entradas_cxc: totalEntradas,
        venta_promedio_diaria_30d: avgDia,
        proyeccion_total_ventas: avgDia * dias,
        nota: 'Entradas basadas en CXC actual. Ventas proyectadas con promedio móvil 30d.',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Comisiones por vendedor ════════════════════════════════
  app.get('/api/bi/comisiones', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      const mesParam = String(req.query.mes || '').trim(); // YYYY-MM o vacío=mes actual
      const pct = Math.min(20, Math.max(0, parseFloat(req.query.pct) || 2.5)); // % comisión default 2.5%
      const mesSql = mesParam
        ? `DATE '${mesParam}-01'`
        : `date_trunc('month', CURRENT_DATE)`;

      const rows = await all(snap, `
        WITH ventas_mes AS (
          SELECT d.VENDEDOR_ID,
                 SUM(d.IMPORTE_NETO) AS ventas_brutas,
                 COUNT(*) AS docs
          FROM DOCTOS_VE d
          WHERE date_trunc('month', d.FECHA) = ${mesSql}
            AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C')
          GROUP BY d.VENDEDOR_ID
        ),
        cobrado_mes AS (
          SELECT i.CLIENTE_ID, SUM(-i.IMPORTE) AS cobrado
          FROM IMPORTES_DOCTOS_CC i
          WHERE date_trunc('month', i.FECHA) = ${mesSql}
            AND i.IMPORTE < 0
          GROUP BY i.CLIENTE_ID
        )
        SELECT v.NOMBRE AS vendedor,
               vm.VENDEDOR_ID,
               vm.ventas_brutas,
               vm.docs,
               (vm.ventas_brutas * ${pct} / 100) AS comision_estimada
        FROM ventas_mes vm
        LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = vm.VENDEDOR_ID
        ORDER BY vm.ventas_brutas DESC`);

      const totals = rows.reduce((acc, r) => ({
        ventas: acc.ventas + (Number(r.ventas_brutas) || 0),
        comision: acc.comision + (Number(r.comision_estimada) || 0),
      }), { ventas: 0, comision: 0 });

      res.json({ ok: true, mes: mesParam || new Date().toISOString().slice(0, 7), porcentaje: pct, vendedores: rows, totales: totals });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Margen por producto con alertas ═══════════════════════
  app.get('/api/bi/margen-productos', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      const minPct = parseFloat(req.query.min);
      const dias = Math.min(365, Math.max(7, parseInt(req.query.dias, 10) || 60));

      // Requiere COSTO_UNITARIO en DOCTOS_IN_DET y PRECIO_UNITARIO en DOCTOS_VE_DET
      const rows = await all(snap, `
        WITH ventas AS (
          SELECT d.ARTICULO_ID,
                 SUM(d.UNIDADES) AS u_vendidas,
                 SUM(d.PRECIO_TOTAL_NETO) AS total_vendido,
                 AVG(d.PRECIO_UNITARIO) AS precio_prom
          FROM DOCTOS_VE_DET d
          LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID
        ),
        costos AS (
          SELECT d.ARTICULO_ID, AVG(d.COSTO_UNITARIO) AS costo_prom
          FROM DOCTOS_IN_DET d
          LEFT JOIN DOCTOS_IN h ON h.DOCTO_IN_ID = d.DOCTO_IN_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND d.COSTO_UNITARIO > 0
          GROUP BY d.ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE, a.CLAVE,
               v.u_vendidas, v.total_vendido, v.precio_prom,
               c.costo_prom,
               CASE WHEN v.precio_prom > 0 AND c.costo_prom > 0
                    THEN ((v.precio_prom - c.costo_prom) / v.precio_prom) * 100
                    ELSE NULL END AS margen_pct
        FROM ventas v
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = v.ARTICULO_ID
        LEFT JOIN costos c    ON c.ARTICULO_ID = v.ARTICULO_ID
        WHERE c.costo_prom IS NOT NULL
        ${isFinite(minPct) ? `HAVING margen_pct < ${minPct}` : ''}
        ORDER BY margen_pct ASC NULLS LAST
        LIMIT 100`);

      res.json({ ok: true, umbral_pct: isFinite(minPct) ? minPct : null, productos: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Rotación de inventario por categoría ══════════════════
  app.get('/api/bi/rotacion-categorias', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      // Aprovecha columna CATEGORIA o LINEA si existe en ARTICULOS
      const cols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'ARTICULOS'`);
      const colNames = new Set(cols.map((c) => c.n));
      const categoriaCol =
        colNames.has('LINEA_ARTICULO_ID') ? 'LINEA_ARTICULO_ID' :
        colNames.has('CATEGORIA_ID') ? 'CATEGORIA_ID' :
        colNames.has('GRUPO_ARTICULO_ID') ? 'GRUPO_ARTICULO_ID' :
        null;
      if (!categoriaCol) return res.json({ ok: true, categorias: [], reason: 'Catálogo ARTICULOS sin columna de categoría/línea/grupo conocida' });

      const rows = await all(snap, `
        WITH consumo AS (
          SELECT a.${categoriaCol} AS categoria,
                 SUM(d.UNIDADES) AS unidades_vendidas,
                 SUM(d.PRECIO_TOTAL_NETO) AS total_venta
          FROM DOCTOS_VE_DET d
          LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
          LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 90 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY a.${categoriaCol}
        ),
        stock AS (
          SELECT a.${categoriaCol} AS categoria,
                 SUM(s.ENTRADAS_UNIDADES - s.SALIDAS_UNIDADES) AS stock_actual
          FROM SALDOS_IN s
          LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = s.ARTICULO_ID
          GROUP BY a.${categoriaCol}
        )
        SELECT c.categoria, c.unidades_vendidas, c.total_venta,
               s.stock_actual,
               CASE WHEN s.stock_actual > 0 THEN (c.unidades_vendidas / s.stock_actual) * (365.0 / 90.0) ELSE NULL END AS rotacion_anual
        FROM consumo c LEFT JOIN stock s USING (categoria)
        WHERE c.unidades_vendidas > 0
        ORDER BY rotacion_anual DESC NULLS LAST
        LIMIT 50`);

      res.json({ ok: true, categorias: rows, basada_en_columna: categoriaCol });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Conciliación bancaria ══════════════════════════════════
  app.post('/api/bi/conciliacion-bancaria', require('express').json({ limit: '2mb' }), async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });

    try {
      const body = req.body || {};
      const movs = Array.isArray(body.movimientos) ? body.movimientos : [];
      if (!movs.length) return res.status(400).json({ error: 'Falta body.movimientos[]' });

      // Traer cobros del periodo (últimos 90 días) desde IMPORTES_DOCTOS_CC con IMPORTE < 0
      const cobros = await all(snap, `
        SELECT DOCTO_CC_ID, FECHA::VARCHAR AS fecha, -IMPORTE AS monto, CLIENTE_ID
        FROM IMPORTES_DOCTOS_CC
        WHERE IMPORTE < 0
          AND FECHA >= CURRENT_DATE - INTERVAL 90 DAY`);

      // Match por monto y fecha ± 2 días
      const matched = [];
      const unmatchedBank = [];
      const unmatchedMicrosip = [...cobros];

      movs.forEach((mov) => {
        const fMov = new Date(mov.fecha).getTime();
        const idx = unmatchedMicrosip.findIndex((c) => {
          if (Math.abs(Number(c.monto) - Number(mov.monto)) > 0.5) return false;
          const fC = new Date(c.fecha).getTime();
          return Math.abs(fC - fMov) <= 2 * 86400_000;
        });
        if (idx >= 0) {
          matched.push({ banco: mov, microsip: unmatchedMicrosip[idx] });
          unmatchedMicrosip.splice(idx, 1);
        } else {
          unmatchedBank.push(mov);
        }
      });

      res.json({
        ok: true,
        resumen: {
          total_bank: movs.length,
          matched: matched.length,
          unmatched_bank: unmatchedBank.length,
          unmatched_microsip: unmatchedMicrosip.length,
        },
        matched, unmatchedBank,
        unmatchedMicrosip: unmatchedMicrosip.slice(0, 100),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('business-intel', '✅ /api/bi/* endpoints');
}

module.exports = { install };
