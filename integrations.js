'use strict';

/**
 * integrations.js — Integraciones externas
 *   POST /api/integrations/powerbi/refresh      → dispara refresh via PBI webhook
 *   GET  /api/integrations/sheets/export?tab=...→ export a Google Sheets (CSV downloadable)
 *   POST /api/integrations/zapier/webhook       → forward payload a Zapier/Make
 */

const https = require('https');
const http = require('http');

function postWebhook(url, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify(payload);
      const req = lib.request({
        method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (resp) => { resp.resume(); resp.on('end', () => resolve({ status: resp.statusCode })); });
      req.on('error', (e) => resolve({ error: e.message }));
      req.write(body); req.end();
    } catch (e) { resolve({ error: e.message }); }
  });
}

function install(app, { duckSnaps, log }) {
  const json = require('express').json();

  // ── Power BI: dispara refresh via webhook configurado ──────────────────────
  app.post('/api/integrations/powerbi/refresh', json, async (req, res) => {
    const url = process.env.POWERBI_REFRESH_WEBHOOK;
    if (!url) return res.status(503).json({ error: 'POWERBI_REFRESH_WEBHOOK no configurado' });
    const r = await postWebhook(url, {
      trigger: 'sumi-snapshot-updated',
      dbId: req.body.dbId || 'default',
      ts: new Date().toISOString(),
    });
    res.json({ ok: !r.error, ...r });
  });

  // ── Google Sheets (export CSV streaming) ────────────────────────────────────
  app.get('/api/integrations/sheets/export', async (req, res) => {
    const id = String(req.query.db || 'default');
    const tab = String(req.query.tab || 'ventas');
    const snap = duckSnaps.get(id);
    if (!snap || !snap.conn) return res.status(404).json({ error: 'Sin snapshot' });

    let sql;
    if (tab === 'ventas') sql = `SELECT FECHA, FOLIO, CLIENTE_ID, VENDEDOR_ID, IMPORTE_NETO FROM DOCTOS_VE WHERE FECHA >= CURRENT_DATE - INTERVAL 90 DAY ORDER BY FECHA DESC LIMIT 10000`;
    else if (tab === 'cxc') sql = `SELECT FECHA, FOLIO, CLIENTE_ID, IMPORTE_NETO FROM DOCTOS_CC WHERE FECHA >= CURRENT_DATE - INTERVAL 90 DAY LIMIT 10000`;
    else if (tab === 'clientes') sql = `SELECT CLIENTE_ID, NOMBRE FROM CLIENTES LIMIT 10000`;
    else return res.status(400).json({ error: 'tab debe ser ventas|cxc|clientes' });

    try {
      const rows = await new Promise((r, rj) => snap.conn.all(sql, (err, rs) => err ? rj(err) : r(rs || [])));
      const cols = rows.length ? Object.keys(rows[0]) : [];
      const csv = '\uFEFF' + [
        cols.join(','),
        ...rows.map((r) => cols.map((c) => {
          const v = r[c] == null ? '' : String(r[c]);
          return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',')),
      ].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${tab}_${id}_${Date.now()}.csv"`);
      res.end(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Zapier / Make webhook relay ─────────────────────────────────────────────
  app.post('/api/integrations/zapier/webhook', json, async (req, res) => {
    const url = process.env.ZAPIER_WEBHOOK_URL;
    if (!url) return res.status(503).json({ error: 'ZAPIER_WEBHOOK_URL no configurado' });
    const r = await postWebhook(url, req.body || {});
    res.json({ ok: !r.error, ...r });
  });

  log.info('integrations', '✅ Power BI refresh, Sheets export, Zapier relay');
}

module.exports = { install };
