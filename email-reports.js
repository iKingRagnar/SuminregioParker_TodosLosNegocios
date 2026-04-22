'use strict';

/**
 * email-reports.js — Reportes programados por email
 *   GET  /api/reports/preview?db=...  → HTML del reporte (para ver sin enviar)
 *   POST /api/reports/send            → envío manual { to, subject?, db? }
 *
 * Cron diario automático a las REPORT_HOUR (default 7am) si hay ENV:
 *   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
 *   REPORT_TO            (lista de emails separados por coma)
 *   REPORT_HOUR          (0-23, default 7)
 *   REPORT_DBS           (lista de dbIds, default 'default')
 *
 * Sin credenciales SMTP el cron no corre — los endpoints preview y send manual sí.
 */

function install(app, { duckSnaps, log }) {
  var nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

  function getSnap(id) {
    var s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }
  function all(snap, sql) {
    return new Promise(function (res, rej) {
      snap.conn.all(sql, function (err, rows) { err ? rej(err) : res(rows || []); });
    });
  }

  async function buildReportHTML(dbId) {
    var snap = getSnap(dbId);
    if (!snap) {
      return '<h2>Sin snapshot para ' + dbId + '</h2><p>Corre sync_duckdb.py para poblar datos.</p>';
    }
    try {
      var ventas    = await all(snap, "SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE - INTERVAL 1 DAY AND (ESTATUS IS NULL OR ESTATUS <> 'C')");
      var ventasMes = await all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')");
      var cxc       = await all(snap, "SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total FROM IMPORTES_DOCTOS_CC");
      var topCli    = await all(snap, `
        SELECT c.NOMBRE, SUM(d.IMPORTE_NETO) AS t
        FROM DOCTOS_VE d LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        WHERE d.FECHA >= CURRENT_DATE - INTERVAL 30 DAY
        GROUP BY c.NOMBRE ORDER BY t DESC LIMIT 5`);

      var fmt = function (n) {
        if (n == null) return '—';
        return '$' + Math.round(n).toLocaleString('es-MX');
      };

      return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Suminregio · Reporte diario</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F6F8FB;color:#0F172A;padding:20px;max-width:680px;margin:0 auto">
  <div style="background:#fff;border:1px solid rgba(230,168,0,.25);border-radius:16px;padding:28px;box-shadow:0 4px 12px -2px rgba(15,23,42,.06)">
    <h1 style="margin:0 0 4px 0;color:#0F172A">Reporte ejecutivo</h1>
    <p style="margin:0 0 24px 0;color:#64748B;font-size:.9rem">${dbId} · ${new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
      <div style="background:rgba(230,168,0,.05);border:1px solid rgba(230,168,0,.2);padding:12px 14px;border-radius:10px">
        <div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Ventas ayer</div>
        <div style="font-size:1.4rem;font-weight:700;color:#0F172A">${fmt(ventas[0] && ventas[0].total)}</div>
        <div style="font-size:.72rem;color:#94A3B8">${(ventas[0] && ventas[0].docs) || 0} docs</div>
      </div>
      <div style="background:rgba(230,168,0,.05);border:1px solid rgba(230,168,0,.2);padding:12px 14px;border-radius:10px">
        <div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Ventas mes</div>
        <div style="font-size:1.4rem;font-weight:700;color:#0F172A">${fmt(ventasMes[0] && ventasMes[0].total)}</div>
      </div>
      <div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);padding:12px 14px;border-radius:10px;grid-column:span 2">
        <div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">CxC total</div>
        <div style="font-size:1.6rem;font-weight:700;color:#B91C1C">${fmt(cxc[0] && cxc[0].total)}</div>
      </div>
    </div>

    <h3 style="margin-top:20px;color:#0F172A">Top 5 clientes (últimos 30 días)</h3>
    <table style="width:100%;border-collapse:collapse;font-size:.88rem">
      <thead><tr><th style="text-align:left;padding:8px 10px;background:rgba(230,168,0,.08);border-bottom:1px solid rgba(230,168,0,.2);color:#475569;font-size:.72rem;text-transform:uppercase">Cliente</th><th style="text-align:right;padding:8px 10px;background:rgba(230,168,0,.08);border-bottom:1px solid rgba(230,168,0,.2);color:#475569;font-size:.72rem;text-transform:uppercase">Total</th></tr></thead>
      <tbody>
        ${topCli.map(function (r) { return '<tr><td style="padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.06)">' + (r.NOMBRE || '—') + '</td><td style="padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.06);text-align:right;font-variant-numeric:tabular-nums">' + fmt(r.t) + '</td></tr>'; }).join('')}
      </tbody>
    </table>

    <p style="margin-top:24px;font-size:.75rem;color:#94A3B8;border-top:1px solid rgba(15,23,42,.08);padding-top:14px">
      Generado ${new Date().toLocaleString('es-MX')} · Suminregio Parker Dashboard
    </p>
  </div>
</body></html>`;
    } catch (e) {
      return '<h2>Error generando reporte</h2><pre>' + e.message + '</pre>';
    }
  }

  function getTransport() {
    if (!nodemailer) { log.warn('email', 'nodemailer no instalado'); return null; }
    if (!process.env.SMTP_HOST) return null;
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: String(process.env.SMTP_SECURE) === '1',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }

  // ── Endpoints ───────────────────────────────────────────────────────────────
  app.get('/api/reports/preview', async function (req, res) {
    var dbId = String(req.query.db || 'default');
    var html = await buildReportHTML(dbId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });

  app.post('/api/reports/send', require('express').json(), async function (req, res) {
    var to = String(req.body && req.body.to || process.env.REPORT_TO || '').trim();
    if (!to) return res.status(400).json({ error: 'Falta destinatario (to)' });
    var dbId = String(req.body && req.body.db || 'default');
    var subject = (req.body && req.body.subject) || 'Suminregio · Reporte ejecutivo';
    var transport = getTransport();
    if (!transport) return res.status(500).json({ error: 'SMTP no configurado (SMTP_HOST / SMTP_USER / SMTP_PASS)' });

    try {
      var html = await buildReportHTML(dbId);
      var info = await transport.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to, subject, html,
      });
      log.info('email', 'enviado', { to, messageId: info.messageId, dbId });
      res.json({ ok: true, messageId: info.messageId });
    } catch (e) {
      log.error('email', 'fallo al enviar', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Cron diario a REPORT_HOUR ───────────────────────────────────────────────
  var hour = parseInt(process.env.REPORT_HOUR, 10);
  if (!isFinite(hour) || hour < 0 || hour > 23) hour = 7;
  var recipients = (process.env.REPORT_TO || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  var dbs = (process.env.REPORT_DBS || 'default').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  if (recipients.length && process.env.SMTP_HOST) {
    // Cron simple: cada minuto chequea si es la hora
    var lastSent = null;
    setInterval(async function () {
      var now = new Date();
      var today = now.toISOString().slice(0, 10);
      if (lastSent === today) return;
      if (now.getHours() !== hour || now.getMinutes() >= 5) return;
      lastSent = today;
      var transport = getTransport();
      if (!transport) return;
      for (const db of dbs) {
        try {
          var html = await buildReportHTML(db);
          await transport.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: recipients.join(','),
            subject: '[' + db + '] Reporte diario — ' + today,
            html,
          });
          log.info('email-cron', 'enviado ' + db + ' → ' + recipients.length + ' destinatarios');
        } catch (e) {
          log.error('email-cron', 'fallo en ' + db, e.message);
        }
      }
    }, 60_000);
    log.info('email-cron', `programado diario ${hour}:00 → ${recipients.length} destinatarios, ${dbs.length} bases`);
  } else {
    log.info('email', 'cron deshabilitado (SMTP_HOST/REPORT_TO no configurados)');
  }
}

module.exports = { install };
