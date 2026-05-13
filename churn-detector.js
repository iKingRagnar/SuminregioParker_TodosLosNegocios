'use strict';

/**
 * churn-detector.js — Detección de clientes en riesgo de irse + alerta proactiva
 *   GET  /api/churn/at-risk?db=...&dias=90     → lista priorizada de clientes en riesgo
 *   GET  /api/churn/summary?db=...             → conteo por segmento + monto en riesgo
 *   POST /api/churn/notify { to, db?, top? }   → envía lista por WhatsApp/Slack
 *
 * Reusa señales RFM: recencia alta + frecuencia/monetary que indican que ese
 * cliente sí compraba y dejó de hacerlo. No depende de /api/analytics/rfm
 * (consulta directa al snapshot) para no acoplarse al orden de install.
 */

const { makeHelpers } = require('./lib/snap-helper');

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);

  async function computeAtRisk(snap, diasGap, limit) {
    // Cliente "en riesgo" = compraba >=3 veces en el último año, pero llevan
    // más de diasGap sin comprar (siendo su brecha histórica promedio mucho menor).
    const rows = await all(snap, `
      WITH ventas_cli AS (
        SELECT CLIENTE_ID,
               MAX(FECHA) AS last_date,
               MIN(FECHA) AS first_date,
               COUNT(*) AS freq,
               SUM(IMPORTE_NETO) AS monetary,
               AVG(IMPORTE_NETO) AS ticket_promedio
        FROM DOCTOS_VE
        WHERE FECHA >= CURRENT_DATE - INTERVAL 365 DAY
          AND (ESTATUS IS NULL OR ESTATUS <> 'C')
        GROUP BY CLIENTE_ID
        HAVING COUNT(*) >= 3 AND SUM(IMPORTE_NETO) > 0
      ),
      con_gap AS (
        SELECT v.*,
               DATE_DIFF('day', v.last_date, CURRENT_DATE) AS dias_sin_comprar,
               CASE WHEN v.freq > 1
                    THEN DATE_DIFF('day', v.first_date, v.last_date)::DOUBLE / NULLIF(v.freq - 1, 0)
                    ELSE NULL END AS brecha_promedio_dias
        FROM ventas_cli v
      ),
      vendedor_ultimo AS (
        SELECT DISTINCT ON (CLIENTE_ID) CLIENTE_ID, VENDEDOR_ID
        FROM DOCTOS_VE
        WHERE FECHA >= CURRENT_DATE - INTERVAL 365 DAY
          AND (ESTATUS IS NULL OR ESTATUS <> 'C')
        ORDER BY CLIENTE_ID, FECHA DESC
      )
      SELECT c.NOMBRE AS cliente,
             g.CLIENTE_ID,
             g.last_date::VARCHAR AS ultima_compra,
             g.dias_sin_comprar,
             g.freq AS compras_12m,
             g.monetary AS gastado_12m,
             g.ticket_promedio,
             g.brecha_promedio_dias,
             v.NOMBRE AS vendedor,
             vu.VENDEDOR_ID,
             CASE
               WHEN g.brecha_promedio_dias IS NULL THEN g.dias_sin_comprar
               ELSE g.dias_sin_comprar / NULLIF(g.brecha_promedio_dias, 0)
             END AS factor_brecha
      FROM con_gap g
      LEFT JOIN CLIENTES c ON c.CLIENTE_ID = g.CLIENTE_ID
      LEFT JOIN vendedor_ultimo vu ON vu.CLIENTE_ID = g.CLIENTE_ID
      LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = vu.VENDEDOR_ID
      WHERE g.dias_sin_comprar >= ${diasGap}
      ORDER BY g.monetary DESC
      LIMIT ${limit}`);

    // Score 0-100: combina recencia, monto y qué tan fuera de patrón está
    return rows.map((r) => {
      const factor = Number(r.factor_brecha) || 1;
      const recBoost = Math.min(50, (Number(r.dias_sin_comprar) || 0) / 6);   // 0..50
      const factBoost = Math.min(30, factor * 10);                              // 0..30
      const monetBoost = Math.min(20, Math.log10(Math.max(1, Number(r.gastado_12m) || 0)) * 3); // 0..20
      const score = Math.round(Math.min(100, recBoost + factBoost + monetBoost));
      let segmento = 'Tibio';
      if (score >= 75) segmento = 'CRÍTICO';
      else if (score >= 55) segmento = 'En riesgo';
      else if (score >= 40) segmento = 'Vigilar';
      return { ...r, churn_score: score, segmento_churn: segmento };
    });
  }

  // ═══════════════════ Lista priorizada ════════════════════════════════════════
  app.get('/api/churn/at-risk', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const diasGap = Math.min(180, Math.max(15, parseInt(req.query.dias, 10) || 60));
    const limit = Math.min(500, Math.max(5, parseInt(req.query.limit, 10) || 100));
    try {
      const clientes = await computeAtRisk(snap, diasGap, limit);
      const monto_en_riesgo = clientes.reduce((s, r) => s + (Number(r.gastado_12m) || 0), 0);
      res.json({ ok: true, dias_umbral: diasGap, total: clientes.length, monto_en_riesgo, clientes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Resumen rápido ══════════════════════════════════════════
  app.get('/api/churn/summary', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      const clientes = await computeAtRisk(snap, 45, 500);
      const byseg = {};
      let montoTotal = 0;
      clientes.forEach((c) => {
        byseg[c.segmento_churn] = byseg[c.segmento_churn] || { count: 0, monto: 0 };
        byseg[c.segmento_churn].count += 1;
        byseg[c.segmento_churn].monto += Number(c.gastado_12m) || 0;
        montoTotal += Number(c.gastado_12m) || 0;
      });
      const top5 = clientes.slice().sort((a, b) => b.churn_score - a.churn_score).slice(0, 5);
      res.json({ ok: true, total: clientes.length, monto_en_riesgo_12m: montoTotal, por_segmento: byseg, top5 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Envío proactivo (WhatsApp / Slack) ══════════════════════
  app.post('/api/churn/notify', require('express').json(), async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.status(503).json({ error: 'Sin snapshot' });
    const body = req.body || {};
    const top = Math.min(20, Math.max(1, parseInt(body.top, 10) || 5));
    const channel = String(body.channel || 'whatsapp').toLowerCase();
    const to = body.to || process.env.ALERT_WA_TO || process.env.ALERT_WHATSAPP_TO;
    if (!to && channel !== 'slack') return res.status(400).json({ error: 'Falta destinatario (to) o ALERT_WA_TO' });

    try {
      const clientes = await computeAtRisk(snap, 45, 500);
      const ranked = clientes.slice().sort((a, b) => b.churn_score - a.churn_score).slice(0, top);
      if (!ranked.length) return res.json({ ok: true, sent: 0, reason: 'Sin clientes en riesgo' });

      const lines = ranked.map((r, i) => {
        const monto = '$' + Math.round(Number(r.gastado_12m) || 0).toLocaleString('es-MX');
        return `${i + 1}. ${r.cliente || '—'} · ${r.dias_sin_comprar}d sin comprar · ${monto}/año · score ${r.churn_score}`;
      });
      const header = `🚨 Clientes en riesgo de irse (top ${top})\n`;
      const message = header + lines.join('\n');

      // Reusa los endpoints existentes (no acoplarse a Twilio aquí)
      const base = `http://127.0.0.1:${process.env.PORT || 7000}`;
      const route = channel === 'slack' ? '/api/notify/slack' : '/api/notify/whatsapp';
      const payload = channel === 'slack' ? { text: message } : { to, message };

      const http = require('http');
      const data = JSON.stringify(payload);
      const result = await new Promise((resolve) => {
        const r = http.request({
          method: 'POST', hostname: '127.0.0.1', port: process.env.PORT || 7000, path: route,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (resp) => {
          let buf = '';
          resp.on('data', (c) => buf += c);
          resp.on('end', () => resolve({ status: resp.statusCode, body: buf }));
        });
        r.on('error', (e) => resolve({ error: e.message }));
        r.write(data); r.end();
      });

      res.json({ ok: !result.error, sent: ranked.length, channel, preview: message, downstream: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Cron diario (opcional) ══════════════════════════════════
  if (process.env.CHURN_ALERT_CRON === '1') {
    const hour = parseInt(process.env.CHURN_ALERT_HOUR, 10);
    const hh = isFinite(hour) && hour >= 0 && hour < 24 ? hour : 8;
    const scheduler = require('./lib/scheduler');
    if (log) scheduler.setLogger(log);
    scheduler.schedule({
      name: 'churn-alert',
      hour: hh,
      run: async () => {
        const snap = duckSnaps.get('default');
        if (!snap || !snap.conn) return;
        const clientes = await computeAtRisk(snap, 45, 500);
        const top = clientes.slice().sort((a, b) => b.churn_score - a.churn_score).slice(0, 10);
        if (!top.length) return;
        const lines = top.map((r, i) => {
          const monto = '$' + Math.round(Number(r.gastado_12m) || 0).toLocaleString('es-MX');
          return `${i + 1}. ${r.cliente || '—'} · ${r.dias_sin_comprar}d · ${monto}/año · score ${r.churn_score}`;
        });
        const message = `🚨 Churn diario — clientes en riesgo:\n${lines.join('\n')}`;
        const to = process.env.ALERT_WA_TO || process.env.ALERT_WHATSAPP_TO;
        if (to) {
          const http = require('http');
          const data = JSON.stringify({ to, message });
          const rq = http.request({
            method: 'POST', hostname: '127.0.0.1', port: process.env.PORT || 7000,
            path: '/api/notify/whatsapp',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          });
          rq.on('error', () => {});
          rq.write(data); rq.end();
        }
        log && log.info && log.info('churn-cron', 'enviado', { top: top.length });
      },
    });
  }

  log && log.info && log.info('churn-detector', '✅ /api/churn/{at-risk,summary,notify}');
}

module.exports = { install };
