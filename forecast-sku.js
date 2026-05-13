'use strict';

/**
 * forecast-sku.js — Forecast por SKU con estacionalidad mensual
 *   GET /api/forecast/sku?articulo=NN&db=...&meses=3
 *   GET /api/forecast/sku/batch?db=...&top=50          → forecast de los SKUs top
 *
 * Algoritmo: Naive estacional + Holt level smoothing
 *   1. Toma ventas mensuales de los últimos 24 meses.
 *   2. Calcula índice estacional por mes-del-año (1..12).
 *   3. Pronóstico = nivel actual × índice_estacional[mes_pronosticado]
 *   4. Si <12 meses de historia, hace forecast linear simple.
 *
 * Output: forecast mensual + intervalos de confianza (±1.96·σ).
 */

function install(app, { duckSnaps, log }) {
  function getSnap(req) {
    const id = String((req.query && req.query.db) || 'default');
    const s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }
  function all(snap, sql, params) {
    return new Promise((res, rej) => snap.conn.all(sql, ...(params || []), (err, rows) => err ? rej(err) : res(rows || [])));
  }

  /** Devuelve { mes: 'YYYY-MM', unidades, importe }. */
  function getMonthlySeries(snap, articuloId) {
    return all(snap, `
      SELECT date_trunc('month', h.FECHA)::DATE AS mes_date,
             strftime(date_trunc('month', h.FECHA), '%Y-%m') AS mes,
             SUM(d.UNIDADES) AS unidades,
             SUM(d.PRECIO_TOTAL_NETO) AS importe
      FROM DOCTOS_VE_DET d
      JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
      WHERE d.ARTICULO_ID = ?
        AND h.FECHA >= CURRENT_DATE - INTERVAL 24 MONTH
        AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
      GROUP BY 1
      ORDER BY 1`, [articuloId]);
  }

  function forecastSerie(serie, mesesAdelante) {
    if (!serie.length) return { historico: [], forecast: [], modelo: 'sin-datos' };
    const vals = serie.map((s) => Number(s.unidades) || 0);
    const N = vals.length;

    // EWMA para nivel actual
    const alpha = 0.4;
    let level = vals[0];
    for (let i = 1; i < N; i++) level = alpha * vals[i] + (1 - alpha) * level;

    // SD residual para CI
    const mean = vals.reduce((s, v) => s + v, 0) / N;
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / N);

    let modelo = 'ewma';
    let seasonal = null;

    if (N >= 12) {
      // Calcular factor estacional por mes-del-año (sumando los últimos 12-24)
      const sumByMonth = new Array(13).fill(0);
      const cntByMonth = new Array(13).fill(0);
      serie.forEach((row, i) => {
        const mNum = Number(String(row.mes).slice(5, 7));
        sumByMonth[mNum] += vals[i];
        cntByMonth[mNum] += 1;
      });
      seasonal = sumByMonth.map((s, i) => cntByMonth[i] > 0 ? s / cntByMonth[i] : 0);
      // Normaliza alrededor de 1.0
      const promGlobal = mean;
      if (promGlobal > 0) {
        seasonal = seasonal.map((v) => v / promGlobal);
      }
      modelo = 'naive-estacional + ewma';
    }

    const forecast = [];
    const today = new Date();
    for (let i = 1; i <= mesesAdelante; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      const mesNum = d.getMonth() + 1;
      const factor = seasonal ? seasonal[mesNum] : 1;
      const est = Math.max(0, level * factor);
      forecast.push({
        mes: d.toISOString().slice(0, 7),
        estimado: Math.round(est),
        ic_bajo: Math.max(0, Math.round(est - 1.96 * sd)),
        ic_alto: Math.round(est + 1.96 * sd),
        factor_estacional: seasonal ? +factor.toFixed(2) : 1,
      });
    }

    return {
      historico: serie.map((s, i) => ({ mes: s.mes, unidades: vals[i], importe: Number(s.importe) || 0 })),
      forecast,
      modelo,
      nivel_actual: +level.toFixed(2),
      sd_residual: +sd.toFixed(2),
      meses_historia: N,
    };
  }

  // ── Endpoint individual ────────────────────────────────────────────────────
  app.get('/api/forecast/sku', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const articuloId = parseInt(req.query.articulo, 10);
    if (!isFinite(articuloId)) return res.status(400).json({ error: 'Falta ?articulo=articuloId' });
    const meses = Math.min(12, Math.max(1, parseInt(req.query.meses, 10) || 3));

    try {
      const serie = await getMonthlySeries(snap, articuloId);
      const articulo = await all(snap, `SELECT NOMBRE, CLAVE FROM ARTICULOS WHERE ARTICULO_ID = ?`, [articuloId]);
      const result = forecastSerie(serie, meses);
      res.json({ ok: true, articulo_id: articuloId, articulo: articulo[0] || null, ...result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Batch: pronóstica los top-N por importe ────────────────────────────────
  app.get('/api/forecast/sku/batch', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const topN = Math.min(200, Math.max(5, parseInt(req.query.top, 10) || 50));
    const meses = Math.min(6, Math.max(1, parseInt(req.query.meses, 10) || 3));

    try {
      const topSkus = await all(snap, `
        SELECT d.ARTICULO_ID, a.NOMBRE, a.CLAVE, SUM(d.PRECIO_TOTAL_NETO) AS valor_12m
        FROM DOCTOS_VE_DET d
        JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
        WHERE h.FECHA >= CURRENT_DATE - INTERVAL 12 MONTH
          AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        GROUP BY d.ARTICULO_ID, a.NOMBRE, a.CLAVE
        ORDER BY valor_12m DESC
        LIMIT ${topN}`);

      const out = [];
      // Secuencial: forecast es barato pero los queries por SKU se acumulan.
      for (const sku of topSkus) {
        try {
          const serie = await getMonthlySeries(snap, sku.ARTICULO_ID);
          const r = forecastSerie(serie, meses);
          const total = r.forecast.reduce((s, x) => s + (x.estimado || 0), 0);
          out.push({
            articulo_id: sku.ARTICULO_ID,
            articulo: sku.NOMBRE,
            clave: sku.CLAVE,
            valor_12m: sku.valor_12m,
            modelo: r.modelo,
            forecast_total_unidades: total,
            forecast_proximos_meses: r.forecast.map((x) => x.estimado),
            ic_proximos_meses: r.forecast.map((x) => [x.ic_bajo, x.ic_alto]),
          });
        } catch (_) {}
      }
      res.json({ ok: true, top: topN, meses, items: out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('forecast-sku', '✅ /api/forecast/sku · /api/forecast/sku/batch');
}

module.exports = { install };
