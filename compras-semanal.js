'use strict';

/**
 * compras-semanal.js — Lista priorizada de compras + envío automático los lunes
 *   GET  /api/compras/lista?db=...&lead=15      → lista priorizada por urgencia × valor
 *   GET  /api/compras/preview?db=...            → HTML del reporte (preview)
 *   POST /api/compras/send { to, db?, lead? }   → envía email manual
 *
 * Cron: lunes a las COMPRAS_HOUR (default 7) si SMTP_HOST y COMPRAS_TO están configurados.
 */

const { makeHelpers } = require('./lib/snap-helper');
const { fmt, fmtUnits } = require('./lib/format');

function install(app, { duckSnaps, log }) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

  const { getSnap, all } = makeHelpers(duckSnaps);

  async function computeLista(snap, leadDays, limit) {
    // Hace match con la lógica de "/api/inv/consumo" del monolito pero más simple
    // y enfocado en priorizar por valor (consumo × precio promedio).
    return all(snap, `
      WITH consumo AS (
        SELECT d.ARTICULO_ID,
               SUM(d.UNIDADES) AS unidades_90d,
               SUM(d.PRECIO_TOTAL_NETO) AS valor_90d,
               AVG(d.PRECIO_UNITARIO) AS precio_prom,
               SUM(d.UNIDADES)::DOUBLE / 90.0 AS consumo_diario
        FROM DOCTOS_VE_DET d
        LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
        WHERE h.FECHA >= CURRENT_DATE - INTERVAL 90 DAY
          AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        GROUP BY d.ARTICULO_ID
        HAVING SUM(d.UNIDADES) > 0
      ),
      stock AS (
        SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS existencia
        FROM SALDOS_IN GROUP BY ARTICULO_ID
      )
      SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
             COALESCE(s.existencia, 0) AS existencia,
             c.consumo_diario,
             c.precio_prom,
             c.valor_90d,
             CASE WHEN c.consumo_diario > 0
                  THEN COALESCE(s.existencia, 0) / c.consumo_diario
                  ELSE NULL END AS dias_cobertura,
             GREATEST(0, CEIL(c.consumo_diario * ${leadDays * 2}) - COALESCE(s.existencia, 0)) AS sugerencia_compra,
             GREATEST(0, CEIL(c.consumo_diario * ${leadDays * 2}) - COALESCE(s.existencia, 0)) * c.precio_prom AS valor_compra
      FROM consumo c
      LEFT JOIN stock s ON s.ARTICULO_ID = c.ARTICULO_ID
      LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = c.ARTICULO_ID
      WHERE (COALESCE(s.existencia, 0) / NULLIF(c.consumo_diario, 0)) < ${leadDays * 1.5}
         OR COALESCE(s.existencia, 0) <= 0
      ORDER BY (CASE WHEN c.consumo_diario > 0 THEN COALESCE(s.existencia, 0)/c.consumo_diario ELSE 999 END) ASC,
               c.valor_90d DESC
      LIMIT ${limit}`);
  }

  function urgencia(row, leadDays) {
    const cov = Number(row.dias_cobertura);
    if (!isFinite(cov) || cov <= 0) return 'CRÍTICA';
    if (cov < leadDays / 2) return 'CRÍTICA';
    if (cov < leadDays) return 'ALTA';
    if (cov < leadDays * 1.5) return 'MEDIA';
    return 'BAJA';
  }

  function urgenciaColor(u) {
    return ({ 'CRÍTICA': '#DC2626', 'ALTA': '#EA580C', 'MEDIA': '#CA8A04', 'BAJA': '#16A34A' })[u] || '#64748B';
  }

  async function buildHTML(snap, leadDays) {
    const rows = await computeLista(snap, leadDays, 100);
    const totalCompra = rows.reduce((s, r) => s + (Number(r.valor_compra) || 0), 0);
    const dateStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const thS = 'padding:8px 10px;background:#1E293B;color:#fff;font-size:.72rem;text-transform:uppercase;font-weight:700;text-align:right;border:1px solid #334155';
    const tdS = 'padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);text-align:right;font-variant-numeric:tabular-nums;font-size:.85rem';
    const tdL = 'padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);font-weight:600;font-size:.85rem';

    const filas = rows.map((r) => {
      const u = urgencia(r, leadDays);
      return `<tr>
        <td style="${tdL}">${r.articulo || '—'}<div style="font-size:.7rem;color:#94A3B8">${r.CLAVE || ''}</div></td>
        <td style="${tdS}"><span style="background:${urgenciaColor(u)};color:#fff;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:700">${u}</span></td>
        <td style="${tdS}">${fmtUnits(r.existencia)}</td>
        <td style="${tdS}">${fmtUnits(r.consumo_diario)}/d</td>
        <td style="${tdS}">${r.dias_cobertura != null ? Math.round(r.dias_cobertura) + 'd' : '—'}</td>
        <td style="${tdS};font-weight:700">${fmtUnits(r.sugerencia_compra)}</td>
        <td style="${tdS};font-weight:700">${fmt(r.valor_compra)}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lista de compras semanal</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F6F8FB;color:#0F172A;padding:20px;max-width:920px;margin:0 auto">
<div style="background:#fff;border:1px solid rgba(230,168,0,.25);border-radius:16px;padding:28px;box-shadow:0 4px 12px -2px rgba(15,23,42,.06)">
  <h1 style="margin:0 0 4px 0;font-size:1.25rem">📦 Lista de compras priorizada — ${dateStr}</h1>
  <p style="margin:0 0 20px;color:#64748B;font-size:.82rem">Lead time: ${leadDays} días · Top ${rows.length} SKUs · Valor estimado: <strong>${fmt(totalCompra)}</strong></p>
  <table style="width:100%;border-collapse:collapse;font-size:.85rem">
    <thead><tr>
      <th style="${thS};text-align:left">Artículo</th>
      <th style="${thS}">Urgencia</th>
      <th style="${thS}">Stock</th>
      <th style="${thS}">Consumo</th>
      <th style="${thS}">Cobertura</th>
      <th style="${thS}">Sugerir</th>
      <th style="${thS}">Valor</th>
    </tr></thead>
    <tbody>${filas || '<tr><td colspan="7" style="' + tdL + '">Sin sugerencias de compra. Inventario sano.</td></tr>'}</tbody>
  </table>
  <p style="margin-top:24px;font-size:.72rem;color:#94A3B8;border-top:1px solid rgba(15,23,42,.08);padding-top:14px">Generado ${new Date().toLocaleString('es-MX')} · Lista basada en consumo 90d</p>
</div></body></html>`;
  }

  function getTransport() {
    if (!nodemailer || !process.env.SMTP_HOST) return null;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: String(process.env.SMTP_SECURE) === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }

  // ── Endpoints ───────────────────────────────────────────────────────────────
  app.get('/api/compras/lista', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const lead = Math.min(60, Math.max(3, parseInt(req.query.lead, 10) || 15));
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 100));
    try {
      const rows = await computeLista(snap, lead, limit);
      const enriched = rows.map((r) => ({ ...r, urgencia: urgencia(r, lead) }));
      const totalValor = enriched.reduce((s, r) => s + (Number(r.valor_compra) || 0), 0);
      const porUrgencia = enriched.reduce((acc, r) => {
        acc[r.urgencia] = (acc[r.urgencia] || 0) + 1;
        return acc;
      }, {});
      res.json({ ok: true, lead_dias: lead, total_items: enriched.length, valor_total: totalValor, por_urgencia: porUrgencia, items: enriched });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/compras/preview', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.status(503).send('Sin snapshot');
    const lead = Math.min(60, Math.max(3, parseInt(req.query.lead, 10) || 15));
    try {
      const html = await buildHTML(snap, lead);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (e) { res.status(500).send(e.message); }
  });

  app.post('/api/compras/send', require('express').json(), async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.status(503).json({ error: 'Sin snapshot' });
    const to = String(req.body && req.body.to || process.env.COMPRAS_TO || process.env.REPORT_TO || '').trim();
    if (!to) return res.status(400).json({ error: 'Falta destinatario (to)' });
    const lead = Math.min(60, Math.max(3, parseInt(req.body && req.body.lead, 10) || 15));
    const transport = getTransport();
    if (!transport) return res.status(503).json({ error: 'SMTP no configurado' });
    try {
      const html = await buildHTML(snap, lead);
      const info = await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to, subject: '📦 Lista de compras priorizada — Suminregio', html,
      });
      log && log.info && log.info('compras-email', 'enviado', { to, messageId: info.messageId });
      res.json({ ok: true, messageId: info.messageId });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Cron: lunes a la hora indicada ──────────────────────────────────────────
  const cronEnabled = String(process.env.COMPRAS_CRON || '1') !== '0';
  const recipients = (process.env.COMPRAS_TO || process.env.REPORT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const dbId = process.env.COMPRAS_DB || 'default';
  let hour = parseInt(process.env.COMPRAS_HOUR, 10);
  if (!isFinite(hour) || hour < 0 || hour > 23) hour = 7;
  const leadEnv = parseInt(process.env.COMPRAS_LEAD, 10);
  const leadDefault = isFinite(leadEnv) ? leadEnv : 15;

  if (cronEnabled && recipients.length && process.env.SMTP_HOST) {
    const scheduler = require('./lib/scheduler');
    if (log) scheduler.setLogger(log);
    scheduler.schedule({
      name: 'compras-lunes',
      hour,
      days: [1], // lunes
      run: async () => {
        const snap = duckSnaps.get(dbId);
        if (!snap || !snap.conn) return;
        const transport = getTransport();
        if (!transport) return;
        const html = await buildHTML(snap, leadDefault);
        await transport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: recipients.join(','),
          subject: '📦 Lista de compras semanal — ' + new Date().toLocaleDateString('es-MX'),
          html,
        });
        log && log.info && log.info('compras-cron', 'enviado lunes → ' + recipients.length);
      },
    });
  }

  log && log.info && log.info('compras-semanal', '✅ /api/compras/{lista,preview,send}');
}

module.exports = { install };
