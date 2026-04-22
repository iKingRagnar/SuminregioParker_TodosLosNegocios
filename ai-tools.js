'use strict';

/**
 * ai-tools.js — Tool-calling + forecasting sobre DuckDB
 * ──────────────────────────────────────────────────────────────────────────────
 * Endpoints:
 *   POST /api/ai/ask      { "q": "¿cuánto se vendió ayer?" }  → intenta mapear a una query
 *   GET  /api/forecast/ventas?dias=30       → proyección linear/EWMA de ventas diarias
 *   GET  /api/forecast/cxc?dias=30          → tendencia de cobranza
 *   GET  /api/forecast/inventario?articulo=ID → días hasta agotarse por consumo promedio
 *
 * Sin dependencias externas. Usa window functions de DuckDB para cálculos.
 */

function installAiTools(app, { duckSnaps, dbOptsToId, log }) {
  function getSnapFor(req) {
    try {
      const id = String(req.query.db || 'default');
      const snap = duckSnaps.get(id);
      return (snap && snap.conn) ? snap : null;
    } catch (_) { return null; }
  }

  function duckAll(snap, sql, params = []) {
    return new Promise((resolve, reject) => {
      snap.conn.all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
  }

  // ── Tool-calling rudimentario — patrones NL a SQL ────────────────────────────
  app.post('/api/ai/ask', require('express').json(), async (req, res) => {
    const snap = getSnapFor(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot para esa empresa' });
    const q = String((req.body && req.body.q) || '').toLowerCase().trim();
    if (!q) return res.status(400).json({ error: 'Falta parámetro q' });

    try {
      // Patrones simples, determinísticos (no LLM — instantáneos)
      let sql = null, label = null;
      if (/vend[ií]d[oa]\s+(ayer|el d[ií]a anterior)/.test(q)) {
        label = 'Ventas de ayer';
        sql = `SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs
               FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE - INTERVAL 1 DAY
                 AND (ESTATUS IS NULL OR ESTATUS <> 'C')`;
      } else if (/vend[ií]d[oa]\s+hoy/.test(q)) {
        label = 'Ventas de hoy';
        sql = `SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs
               FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE
                 AND (ESTATUS IS NULL OR ESTATUS <> 'C')`;
      } else if (/vend[ií]d[oa]\s+(este|el)\s+mes/.test(q)) {
        label = 'Ventas mes actual';
        sql = `SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs
               FROM DOCTOS_VE
               WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE)
                 AND (ESTATUS IS NULL OR ESTATUS <> 'C')`;
      } else if (/top\s+(clientes?|deudores?)/.test(q)) {
        label = 'Top deudores';
        sql = `SELECT c.NOMBRE, SUM(d.IMPORTE) AS saldo
               FROM IMPORTES_DOCTOS_CC d LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
               GROUP BY c.NOMBRE HAVING SUM(d.IMPORTE) > 0
               ORDER BY saldo DESC LIMIT 10`;
      } else if (/vendedores?\s+(top|mejores)/.test(q)) {
        label = 'Top vendedores mes';
        sql = `SELECT v.NOMBRE, SUM(d.IMPORTE_NETO) AS total
               FROM DOCTOS_VE d LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
               WHERE date_trunc('month', d.FECHA) = date_trunc('month', CURRENT_DATE)
               GROUP BY v.NOMBRE ORDER BY total DESC LIMIT 10`;
      } else if (/art[ií]culos?\s+(más|mas)\s+vendidos?/.test(q)) {
        label = 'Top artículos mes';
        sql = `SELECT a.NOMBRE, SUM(d.UNIDADES) AS unidades, SUM(d.PRECIO_TOTAL_NETO) AS total
               FROM DOCTOS_VE_DET d
               LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
               LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
               WHERE date_trunc('month', h.FECHA) = date_trunc('month', CURRENT_DATE)
               GROUP BY a.NOMBRE ORDER BY total DESC LIMIT 10`;
      } else {
        return res.json({
          ok: false,
          reason: 'No reconocí la pregunta.',
          hint: 'Prueba: "ventas de hoy", "ventas este mes", "top deudores", "vendedores top", "artículos más vendidos"',
        });
      }

      const rows = await duckAll(snap, sql);
      res.json({ ok: true, label, query: sql, rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Forecast ventas: proyección lineal + EWMA ────────────────────────────────
  app.get('/api/forecast/ventas', async (req, res) => {
    const snap = getSnapFor(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const dias = Math.min(180, Math.max(7, parseInt(req.query.dias, 10) || 30));

    try {
      // Serie de 90 días pasados para entrenar
      const serie = await duckAll(snap, `
        SELECT FECHA::VARCHAR AS fecha, SUM(IMPORTE_NETO) AS total
        FROM DOCTOS_VE
        WHERE FECHA >= CURRENT_DATE - INTERVAL 90 DAY
          AND FECHA <= CURRENT_DATE
          AND (ESTATUS IS NULL OR ESTATUS <> 'C')
        GROUP BY FECHA ORDER BY FECHA`);

      if (!serie.length) return res.json({ ok: true, forecast: [], reason: 'Sin datos históricos' });

      const vals = serie.map((r) => Number(r.total) || 0);
      const n = vals.length;

      // Regresión lineal simple: y = a + b*x
      const sumX = n * (n - 1) / 2;
      const sumY = vals.reduce((s, v) => s + v, 0);
      const sumXY = vals.reduce((s, v, i) => s + v * i, 0);
      const sumXX = vals.reduce((s, _, i) => s + i * i, 0);
      const b = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX || 1);
      const a = (sumY - b * sumX) / n;

      // EWMA con alpha=0.3 para suavizar
      const alpha = 0.3;
      let ew = vals[0];
      for (const v of vals) ew = alpha * v + (1 - alpha) * ew;

      // Forecast
      const today = new Date();
      const forecast = [];
      for (let i = 1; i <= dias; i++) {
        const d = new Date(today.getTime() + i * 86400_000);
        const linear = a + b * (n + i);
        // Blend: 60% linear trend + 40% EWMA level
        const val = Math.max(0, 0.6 * linear + 0.4 * ew);
        forecast.push({ fecha: d.toISOString().slice(0, 10), estimado: Math.round(val) });
      }

      const total = forecast.reduce((s, r) => s + r.estimado, 0);
      res.json({
        ok: true,
        historico: serie.slice(-30),
        forecast,
        total_estimado: total,
        modelo: { a, b, ewma_final: ew, samples: n, dias_proyectados: dias },
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Forecast inventario: días hasta agotarse ────────────────────────────────
  app.get('/api/forecast/inventario', async (req, res) => {
    const snap = getSnapFor(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });

    try {
      // Consumo promedio por artículo últimos 60 días + existencia actual
      const rows = await duckAll(snap, `
        WITH consumo AS (
          SELECT d.ARTICULO_ID,
                 SUM(d.UNIDADES)::DOUBLE / 60.0 AS consumo_diario
          FROM DOCTOS_VE_DET d
          LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 60 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID
        ),
        existencia AS (
          SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS stock
          FROM SALDOS_IN GROUP BY ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE, a.CLAVE,
               COALESCE(e.stock, 0) AS stock,
               COALESCE(c.consumo_diario, 0) AS consumo_diario,
               CASE WHEN c.consumo_diario > 0 THEN COALESCE(e.stock, 0) / c.consumo_diario ELSE NULL END AS dias_cobertura
        FROM ARTICULOS a
        LEFT JOIN existencia e ON e.ARTICULO_ID = a.ARTICULO_ID
        LEFT JOIN consumo    c ON c.ARTICULO_ID = a.ARTICULO_ID
        WHERE COALESCE(c.consumo_diario, 0) > 0
        ORDER BY dias_cobertura ASC
        LIMIT 50`);

      res.json({ ok: true, articulos: rows, generado_en: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  log.info('ai-tools', '✅ /api/ai/ask, /api/forecast/ventas, /api/forecast/inventario');
}

module.exports = { installAiTools };
