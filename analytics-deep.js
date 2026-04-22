'use strict';

/**
 * analytics-deep.js — Análisis avanzado sobre DuckDB
 *   GET /api/analytics/rfm?db=...                → segmentación RFM de clientes
 *   GET /api/analytics/pareto?db=...&dim=cliente → pareto 80/20 (clientes|articulos)
 *   GET /api/analytics/clv?db=...                → Customer Lifetime Value estimado
 *   GET /api/compare/temporal?metrics=...        → MoM / YoY por métrica
 *   GET /api/search/global?q=...                 → búsqueda unificada
 *   POST /api/anomalies/check                    → ejecuta anomaly detection
 */

function install(app, { duckSnaps, log }) {
  function getSnap(req) {
    var id = String(req.query.db || 'default');
    var s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }
  function all(snap, sql, params) {
    return new Promise(function (res, rej) {
      snap.conn.all(sql, ...(params || []), function (err, rows) {
        err ? rej(err) : res(rows || []);
      });
    });
  }

  // ═══════════════════ RFM ═══════════════════════════════════════════════════
  app.get('/api/analytics/rfm', async function (req, res) {
    var snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });

    try {
      var rows = await all(snap, `
        WITH ventas_cli AS (
          SELECT
            CLIENTE_ID,
            MAX(FECHA) AS last_date,
            COUNT(*) AS freq,
            SUM(IMPORTE_NETO) AS monetary
          FROM DOCTOS_VE
          WHERE FECHA >= CURRENT_DATE - INTERVAL 365 DAY
            AND (ESTATUS IS NULL OR ESTATUS <> 'C')
          GROUP BY CLIENTE_ID
        ),
        scored AS (
          SELECT
            v.CLIENTE_ID, c.NOMBRE,
            DATE_DIFF('day', v.last_date, CURRENT_DATE) AS recency,
            v.freq, v.monetary,
            NTILE(5) OVER (ORDER BY DATE_DIFF('day', v.last_date, CURRENT_DATE) DESC) AS r_score,
            NTILE(5) OVER (ORDER BY v.freq)       AS f_score,
            NTILE(5) OVER (ORDER BY v.monetary)   AS m_score
          FROM ventas_cli v
          LEFT JOIN CLIENTES c ON c.CLIENTE_ID = v.CLIENTE_ID
        )
        SELECT
          CLIENTE_ID, NOMBRE, recency, freq, monetary,
          r_score, f_score, m_score,
          (r_score + f_score + m_score) AS rfm_total,
          CASE
            WHEN r_score >= 4 AND f_score >= 4 AND m_score >= 4 THEN 'Champions'
            WHEN r_score >= 3 AND f_score >= 4 THEN 'Leales'
            WHEN r_score >= 4 AND f_score <= 2 THEN 'Nuevos'
            WHEN r_score <= 2 AND f_score >= 4 THEN 'En Riesgo'
            WHEN r_score <= 2 AND m_score >= 4 THEN 'No puede perder'
            WHEN r_score = 1 AND f_score = 1 THEN 'Perdidos'
            ELSE 'Regulares'
          END AS segmento
        FROM scored
        ORDER BY rfm_total DESC
        LIMIT 500`);

      var segCount = {};
      rows.forEach(function (r) { segCount[r.segmento] = (segCount[r.segmento] || 0) + 1; });

      res.json({
        ok: true,
        total: rows.length,
        segmentos: segCount,
        clientes: rows,
        generado_en: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════ Pareto 80/20 ═══════════════════════════════════════════
  app.get('/api/analytics/pareto', async function (req, res) {
    var snap = getSnap(req);
    if (!snap) return res.json({ ok: false });
    var dim = String(req.query.dim || 'cliente');
    var days = Math.min(730, Math.max(7, parseInt(req.query.dias, 10) || 365));

    try {
      var sql;
      if (dim === 'articulo' || dim === 'articulos') {
        sql = `
          WITH base AS (
            SELECT a.ARTICULO_ID AS id, a.NOMBRE, a.CLAVE, SUM(d.PRECIO_TOTAL_NETO) AS total
            FROM DOCTOS_VE_DET d
            LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
            LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
            WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${days} DAY
              AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
            GROUP BY a.ARTICULO_ID, a.NOMBRE, a.CLAVE
            HAVING SUM(d.PRECIO_TOTAL_NETO) > 0
          ), cum AS (
            SELECT id, NOMBRE, CLAVE, total,
                   SUM(total) OVER (ORDER BY total DESC) AS cum_total,
                   SUM(total) OVER () AS grand
            FROM base
          )
          SELECT id, NOMBRE, CLAVE, total, cum_total, grand,
                 (cum_total * 100.0 / grand) AS pct_acum
          FROM cum ORDER BY total DESC LIMIT 200`;
      } else {
        sql = `
          WITH base AS (
            SELECT CLIENTE_ID AS id, SUM(IMPORTE_NETO) AS total
            FROM DOCTOS_VE
            WHERE FECHA >= CURRENT_DATE - INTERVAL ${days} DAY
              AND (ESTATUS IS NULL OR ESTATUS <> 'C')
            GROUP BY CLIENTE_ID
            HAVING SUM(IMPORTE_NETO) > 0
          ), cum AS (
            SELECT b.id, c.NOMBRE, b.total,
                   SUM(b.total) OVER (ORDER BY b.total DESC) AS cum_total,
                   SUM(b.total) OVER () AS grand
            FROM base b LEFT JOIN CLIENTES c ON c.CLIENTE_ID = b.id
          )
          SELECT id, NOMBRE, total, cum_total, grand,
                 (cum_total * 100.0 / grand) AS pct_acum
          FROM cum ORDER BY total DESC LIMIT 200`;
      }

      var rows = await all(snap, sql);
      // Encuentra N al 80%
      var idx80 = rows.findIndex(function (r) { return Number(r.pct_acum) >= 80; });
      res.json({
        ok: true, dim, days,
        total_entidades: rows.length,
        hasta_80pct: idx80 >= 0 ? idx80 + 1 : null,
        pct_concentrado: rows.length ? +((idx80 + 1) * 100 / rows.length).toFixed(1) : null,
        rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════ CLV (Customer Lifetime Value) ═════════════════════════
  app.get('/api/analytics/clv', async function (req, res) {
    var snap = getSnap(req);
    if (!snap) return res.json({ ok: false });
    try {
      var rows = await all(snap, `
        SELECT
          d.CLIENTE_ID AS id,
          c.NOMBRE,
          COUNT(DISTINCT d.DOCTO_VE_ID) AS pedidos_12m,
          SUM(d.IMPORTE_NETO) AS ingresos_12m,
          AVG(d.IMPORTE_NETO) AS ticket_promedio,
          DATE_DIFF('day', MIN(d.FECHA), MAX(d.FECHA)) AS lifespan_dias,
          -- CLV simple: (ticket × frecuencia) × 12 meses
          (AVG(d.IMPORTE_NETO) * (COUNT(DISTINCT d.DOCTO_VE_ID) / 12.0)) * 12 AS clv_estimado_12m
        FROM DOCTOS_VE d
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        WHERE d.FECHA >= CURRENT_DATE - INTERVAL 365 DAY
          AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C')
        GROUP BY d.CLIENTE_ID, c.NOMBRE
        HAVING SUM(d.IMPORTE_NETO) > 0
        ORDER BY clv_estimado_12m DESC
        LIMIT 200`);
      res.json({ ok: true, clientes: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════ Comparación temporal (MoM / YoY) ══════════════════════
  app.get('/api/compare/temporal', async function (req, res) {
    var snap = getSnap(req);
    if (!snap) return res.json({ ok: false });
    var metrics = String(req.query.metrics || 'ventas_mes').split(',').map(function (s) { return s.trim(); });

    try {
      var out = {};
      for (const m of metrics) {
        var sql;
        if (m === 'ventas_mes') {
          sql = `
            WITH cur AS (SELECT SUM(IMPORTE_NETO) AS v FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')),
                 prev_m AS (SELECT SUM(IMPORTE_NETO) AS v FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE - INTERVAL 1 MONTH) AND (ESTATUS IS NULL OR ESTATUS <> 'C')),
                 prev_y AS (SELECT SUM(IMPORTE_NETO) AS v FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE - INTERVAL 1 YEAR) AND (ESTATUS IS NULL OR ESTATUS <> 'C'))
            SELECT cur.v AS actual, prev_m.v AS mes_pasado, prev_y.v AS anio_pasado FROM cur, prev_m, prev_y`;
        } else if (m === 'cxc_total') {
          sql = `
            WITH cur AS (SELECT SUM(IMPORTE) AS v FROM IMPORTES_DOCTOS_CC WHERE IMPORTE > 0),
                 prev AS (SELECT SUM(IMPORTE) AS v FROM IMPORTES_DOCTOS_CC WHERE FECHA <= CURRENT_DATE - INTERVAL 30 DAY AND IMPORTE > 0)
            SELECT cur.v AS actual, prev.v AS mes_pasado, NULL::DOUBLE AS anio_pasado FROM cur, prev`;
        } else {
          out[m] = null;
          continue;
        }
        try {
          var rows = await all(snap, sql);
          out[m] = rows[0] || null;
        } catch (_) { out[m] = null; }
      }

      res.json({ ok: true, metrics: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════ Búsqueda global ═══════════════════════════════════════
  app.get('/api/search/global', async function (req, res) {
    var snap = getSnap(req);
    var q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: false, results: [] });
    if (!snap) return res.json({ ok: false, results: [], reason: 'Sin snapshot' });

    try {
      var qLike = '%' + q.toUpperCase() + '%';
      var isNumeric = /^\d+$/.test(q);

      // Paralelizamos 4 queries
      var [clientes, vendedores, articulos, docs] = await Promise.all([
        all(snap, `SELECT CLIENTE_ID AS id, NOMBRE FROM CLIENTES WHERE UPPER(NOMBRE) LIKE ? LIMIT 8`, [qLike]).catch(() => []),
        all(snap, `SELECT VENDEDOR_ID AS id, NOMBRE FROM VENDEDORES WHERE UPPER(NOMBRE) LIKE ? LIMIT 5`, [qLike]).catch(() => []),
        all(snap, `SELECT ARTICULO_ID AS id, NOMBRE, CLAVE FROM ARTICULOS WHERE UPPER(NOMBRE) LIKE ? OR UPPER(CLAVE) LIKE ? LIMIT 8`, [qLike, qLike]).catch(() => []),
        isNumeric
          ? all(snap, `SELECT DOCTO_CC_ID AS id, FOLIO, FECHA::VARCHAR AS fecha, IMPORTE_NETO FROM DOCTOS_CC WHERE TRIM(FOLIO) = ? OR CAST(DOCTO_CC_ID AS VARCHAR) = ? LIMIT 5`, [q, q]).catch(() => [])
          : Promise.resolve([]),
      ]);

      var results = [];
      clientes.forEach(function (c) {
        results.push({ type: 'Cliente', title: c.NOMBRE, sub: 'ID: ' + c.id, href: '/clientes.html?id=' + c.id });
      });
      vendedores.forEach(function (v) {
        results.push({ type: 'Vendedor', title: v.NOMBRE, sub: 'ID: ' + v.id, href: '/vendedores.html?id=' + v.id });
      });
      articulos.forEach(function (a) {
        results.push({ type: 'Artículo', title: a.NOMBRE, sub: 'Clave: ' + (a.CLAVE || a.id), href: '/inventario.html?id=' + a.id });
      });
      docs.forEach(function (d) {
        results.push({ type: 'CxC', title: 'Folio ' + d.FOLIO, sub: '$' + Math.round(d.IMPORTE_NETO).toLocaleString('es-MX') + ' · ' + d.fecha, href: '/cxc.html?folio=' + d.FOLIO });
      });

      res.json({ ok: true, q, results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════ Anomaly detection ═════════════════════════════════════
  app.get('/api/anomalies/check', async function (req, res) {
    var snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });

    try {
      // Ventas diarias: z-score vs promedio 30d
      var rows = await all(snap, `
        WITH diario AS (
          SELECT FECHA, SUM(IMPORTE_NETO) AS total
          FROM DOCTOS_VE
          WHERE FECHA >= CURRENT_DATE - INTERVAL 45 DAY
            AND (ESTATUS IS NULL OR ESTATUS <> 'C')
          GROUP BY FECHA
        ),
        stats AS (
          SELECT AVG(total) AS mean, STDDEV_POP(total) AS sd
          FROM diario WHERE FECHA < CURRENT_DATE - INTERVAL 1 DAY
        ),
        scored AS (
          SELECT d.FECHA, d.total, s.mean, s.sd,
                 CASE WHEN s.sd > 0 THEN (d.total - s.mean) / s.sd ELSE 0 END AS z
          FROM diario d, stats s
          WHERE d.FECHA >= CURRENT_DATE - INTERVAL 7 DAY
        )
        SELECT FECHA::VARCHAR AS fecha, total, mean, sd, z,
               CASE
                 WHEN z <= -2 THEN 'alerta: venta muy baja'
                 WHEN z >= 2  THEN 'positivo: venta muy alta'
                 ELSE 'normal'
               END AS flag
        FROM scored ORDER BY FECHA DESC`);

      var anomalies = rows.filter(function (r) { return r.flag !== 'normal'; });
      res.json({ ok: true, checked: rows.length, anomalies, evaluados: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  log && log.info && log.info('analytics-deep', '✅ /api/analytics/{rfm,pareto,clv} · /api/compare/temporal · /api/search/global · /api/anomalies/check');
}

module.exports = { install };
