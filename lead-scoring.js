'use strict';

/**
 * lead-scoring.js — Score de probabilidad de cierre por cotización
 *   GET /api/leads/scoring?db=...&dias=60  → cotizaciones abiertas con score
 *   GET /api/leads/conversion-rates?db=... → tasas históricas por vendedor/segmento
 *
 * Modelo (logístico simple sin libs externas, entrenado por reglas + estadística):
 *   features:
 *     - tasa histórica de cierre del vendedor      (peso fuerte)
 *     - cliente_segmento: Champions/Leales pesan más (basado en RFM-like)
 *     - dias desde emisión vs ciclo de cierre promedio (decae con tiempo)
 *     - monto vs ticket promedio del cliente (ratio razonable = más probable)
 *     - frecuencia de compra del cliente
 *
 *  Salida: score 0-100 + factores explicables ("por qué").
 */

const { makeHelpers } = require('./lib/snap-helper');
const memoLib = require('./lib/memo');

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);
  // Lead scoring corre 2-3 queries pesadas + lookup por vendedor. TTL 10 min.
  const memo = memoLib.create({ ttlMs: 10 * 60 * 1000, max: 100 });

  /**
   * Calcula tasa histórica de cierre por vendedor:
   *   cotizaciones (TIPO=C) últimos 6 meses con/sin factura del mismo cliente en los 30 días siguientes.
   */
  async function getVendedorRates(snap) {
    try {
      const rows = await all(snap, `
        WITH cotiz AS (
          SELECT DOCTO_VE_ID, CLIENTE_ID, VENDEDOR_ID, FECHA, IMPORTE_NETO
          FROM DOCTOS_VE
          WHERE TIPO_DOCTO = 'C'
            AND FECHA >= CURRENT_DATE - INTERVAL 180 DAY
            AND (ESTATUS IS NULL OR ESTATUS <> 'C')
        ),
        cerradas AS (
          SELECT c.DOCTO_VE_ID, c.VENDEDOR_ID,
                 EXISTS (
                   SELECT 1 FROM DOCTOS_VE f
                   WHERE f.CLIENTE_ID = c.CLIENTE_ID
                     AND f.TIPO_DOCTO IN ('F','R')
                     AND f.FECHA BETWEEN c.FECHA AND c.FECHA + INTERVAL 30 DAY
                     AND (f.ESTATUS IS NULL OR f.ESTATUS <> 'C')
                 ) AS cerro
          FROM cotiz c
        )
        SELECT VENDEDOR_ID,
               COUNT(*) AS total,
               SUM(CASE WHEN cerro THEN 1 ELSE 0 END) AS cerradas,
               AVG(CASE WHEN cerro THEN 1 ELSE 0 END) AS tasa
        FROM cerradas
        GROUP BY VENDEDOR_ID`);
      const m = new Map();
      rows.forEach((r) => m.set(r.VENDEDOR_ID, { total: +r.total, cerradas: +r.cerradas, tasa: +r.tasa || 0 }));
      return m;
    } catch (_) { return new Map(); }
  }

  async function getCicloPromedio(snap) {
    try {
      const r = await all(snap, `
        WITH pairs AS (
          SELECT c.CLIENTE_ID, c.FECHA AS f_coti,
                 (SELECT MIN(f.FECHA) FROM DOCTOS_VE f
                   WHERE f.CLIENTE_ID = c.CLIENTE_ID
                     AND f.TIPO_DOCTO IN ('F','R')
                     AND f.FECHA BETWEEN c.FECHA AND c.FECHA + INTERVAL 60 DAY) AS f_fact
          FROM DOCTOS_VE c
          WHERE c.TIPO_DOCTO = 'C' AND c.FECHA >= CURRENT_DATE - INTERVAL 180 DAY
        )
        SELECT AVG(DATE_DIFF('day', f_coti, f_fact)) AS dias_promedio
        FROM pairs WHERE f_fact IS NOT NULL`);
      const d = Number(r[0]?.dias_promedio);
      return isFinite(d) && d > 0 ? d : 12;
    } catch (_) { return 12; }
  }

  app.get('/api/leads/scoring', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const dias = Math.min(180, Math.max(7, parseInt(req.query.dias, 10) || 60));
    const memoKey = `scoring:${req.query.db || 'default'}:${dias}`;

    try {
      const cached = await memo.wrap(memoKey, () => Promise.all([
        getVendedorRates(snap),
        getCicloPromedio(snap),
        all(snap, `
          WITH abiertas AS (
            SELECT c.DOCTO_VE_ID, c.FOLIO, c.FECHA, c.IMPORTE_NETO,
                   c.CLIENTE_ID, c.VENDEDOR_ID,
                   EXISTS (
                     SELECT 1 FROM DOCTOS_VE f
                     WHERE f.CLIENTE_ID = c.CLIENTE_ID
                       AND f.TIPO_DOCTO IN ('F','R')
                       AND f.FECHA >= c.FECHA AND f.FECHA <= CURRENT_DATE
                       AND (f.ESTATUS IS NULL OR f.ESTATUS <> 'C')
                   ) AS facturada
            FROM DOCTOS_VE c
            WHERE c.TIPO_DOCTO = 'C'
              AND c.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
              AND (c.ESTATUS IS NULL OR c.ESTATUS <> 'C')
          ),
          historia AS (
            SELECT CLIENTE_ID,
                   AVG(IMPORTE_NETO) AS ticket_prom,
                   COUNT(*) AS freq_12m
            FROM DOCTOS_VE
            WHERE TIPO_DOCTO IN ('F','R')
              AND FECHA >= CURRENT_DATE - INTERVAL 365 DAY
              AND (ESTATUS IS NULL OR ESTATUS <> 'C')
            GROUP BY CLIENTE_ID
          )
          SELECT a.DOCTO_VE_ID, a.FOLIO, a.FECHA::VARCHAR AS fecha, a.IMPORTE_NETO,
                 a.CLIENTE_ID, cli.NOMBRE AS cliente,
                 a.VENDEDOR_ID, v.NOMBRE AS vendedor,
                 COALESCE(h.ticket_prom, 0) AS ticket_prom_cli,
                 COALESCE(h.freq_12m, 0) AS freq_12m_cli,
                 DATE_DIFF('day', a.FECHA, CURRENT_DATE) AS dias_abierta
          FROM abiertas a
          LEFT JOIN CLIENTES cli ON cli.CLIENTE_ID = a.CLIENTE_ID
          LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = a.VENDEDOR_ID
          LEFT JOIN historia h ON h.CLIENTE_ID = a.CLIENTE_ID
          WHERE NOT a.facturada
          ORDER BY a.IMPORTE_NETO DESC
          LIMIT 500`),
      ]));
      const [vendRates, cicloProm, cotizaciones] = cached;

      // Tasa global como fallback
      let tg = 0, tc = 0;
      vendRates.forEach((v) => { tg += v.total; tc += v.cerradas; });
      const tasaGlobal = tg > 0 ? tc / tg : 0.25;

      const items = cotizaciones.map((c) => {
        const vrate = vendRates.get(c.VENDEDOR_ID);
        const tasaVendedor = vrate && vrate.total >= 5 ? vrate.tasa : tasaGlobal;

        // Decay temporal: si lleva > ciclo*2 días, baja fuerte
        const dias_abierta = Math.max(0, Number(c.dias_abierta) || 0);
        const ciclo = cicloProm;
        let decay = 1;
        if (dias_abierta > ciclo * 3) decay = 0.15;
        else if (dias_abierta > ciclo * 2) decay = 0.40;
        else if (dias_abierta > ciclo) decay = 0.70;

        // Ratio monto/ticket: si está dentro de 0.3x – 3x del ticket habitual, +bonus
        const ticket = Number(c.ticket_prom_cli) || 0;
        const monto = Number(c.IMPORTE_NETO) || 0;
        let bonusMonto = 0;
        if (ticket > 0) {
          const ratio = monto / ticket;
          if (ratio >= 0.3 && ratio <= 3) bonusMonto = 0.10;
          else if (ratio > 3) bonusMonto = -0.10; // muy fuera de patrón
        }

        // Frecuencia del cliente: si compra 5+ veces al año, +bonus
        const freq = Number(c.freq_12m_cli) || 0;
        const bonusFreq = freq >= 12 ? 0.15 : freq >= 5 ? 0.08 : freq >= 1 ? 0.02 : -0.10;

        // Score base = tasaVendedor * decay + bonuses, clamped 0..1
        let p = tasaVendedor * decay + bonusMonto + bonusFreq;
        p = Math.max(0.02, Math.min(0.98, p));

        const score = Math.round(p * 100);
        let segmento = 'Frío';
        if (score >= 70) segmento = 'Caliente';
        else if (score >= 45) segmento = 'Tibio';

        return {
          ...c,
          probabilidad_cierre: +p.toFixed(3),
          score,
          segmento,
          factores: {
            tasa_vendedor: +tasaVendedor.toFixed(3),
            decay_temporal: +decay.toFixed(2),
            bonus_monto: +bonusMonto.toFixed(2),
            bonus_frecuencia: +bonusFreq.toFixed(2),
          },
        };
      });

      items.sort((a, b) => b.score - a.score);
      const valor_esperado = items.reduce((s, r) => s + r.probabilidad_cierre * (Number(r.IMPORTE_NETO) || 0), 0);

      res.json({
        ok: true,
        dias_analizados: dias,
        ciclo_promedio_dias: cicloProm,
        tasa_cierre_global: +tasaGlobal.toFixed(3),
        total_cotizaciones: items.length,
        monto_total: items.reduce((s, r) => s + (Number(r.IMPORTE_NETO) || 0), 0),
        valor_esperado_cerrar: Math.round(valor_esperado),
        items: items.slice(0, 300),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/leads/conversion-rates', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false });
    try {
      const m = await getVendedorRates(snap);
      const rows = [];
      m.forEach((v, id) => rows.push({ vendedor_id: id, ...v, tasa_pct: +(v.tasa * 100).toFixed(1) }));
      // Anexa nombre
      const ids = rows.map((r) => r.vendedor_id).filter((x) => x != null);
      if (ids.length) {
        try {
          const namedQ = `SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE VENDEDOR_ID IN (${ids.map(() => '?').join(',')})`;
          const named = await all(snap, namedQ, ids);
          const byId = new Map(named.map((n) => [n.VENDEDOR_ID, n.NOMBRE]));
          rows.forEach((r) => r.vendedor = byId.get(r.vendedor_id) || null);
        } catch (_) {}
      }
      rows.sort((a, b) => b.tasa - a.tasa);
      res.json({ ok: true, vendedores: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('lead-scoring', '✅ /api/leads/{scoring,conversion-rates}');
}

module.exports = { install };
