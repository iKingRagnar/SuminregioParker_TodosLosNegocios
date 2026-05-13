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

var { makeHelpers } = require('./lib/snap-helper');

function install(app, { duckSnaps, log }) {
  var nodemailer;
  try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }
  var { getSnap, all } = makeHelpers(duckSnaps);

  function fmt(n) {
    if (n == null || isNaN(+n)) return '—';
    return '$' + Math.round(+n).toLocaleString('es-MX');
  }
  function deltaPct(cur, prev) {
    if (!prev || +prev === 0) return '';
    var p = ((+cur - +prev) / Math.abs(+prev) * 100).toFixed(1);
    var col = +p >= 0 ? '#16A34A' : '#DC2626';
    return '<span style="color:' + col + ';font-weight:700;font-size:.78rem">' + (+p >= 0 ? '+' : '') + p + '%</span>';
  }
  var thS = 'padding:8px 10px;background:#1E293B;color:#fff;font-size:.72rem;text-transform:uppercase;font-weight:700;text-align:right;border:1px solid #334155';
  var tdS = 'padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);text-align:right;font-variant-numeric:tabular-nums;font-size:.88rem';
  var tdL = 'padding:8px 10px;border-bottom:1px solid rgba(15,23,42,.08);font-weight:600;font-size:.88rem';

  async function queryUnit(snap) {
    // Paralelizado: las 4 queries son independientes y se hacían seriales.
    var [ventasMes, ventasPrev, cxc, cxp] = await Promise.all([
      all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
      all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE - INTERVAL 1 MONTH) AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
      all(snap, "SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total FROM IMPORTES_DOCTOS_CC WHERE FECHA >= CURRENT_DATE - INTERVAL 730 DAY").catch(function () { return [{}]; }),
      all(snap, "SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total FROM IMPORTES_DOCTOS_CP WHERE FECHA >= CURRENT_DATE - INTERVAL 730 DAY").catch(function () { return [{}]; }),
    ]);
    return {
      ventasMes: (ventasMes[0] && +ventasMes[0].total) || 0,
      ventasPrev: (ventasPrev[0] && +ventasPrev[0].total) || 0,
      cxc: (cxc[0] && +cxc[0].total) || 0,
      cxp: (cxp[0] && +cxp[0].total) || 0,
    };
  }

  async function buildReportHTML(dbId) {
    var snap = getSnap(dbId);
    if (!snap) {
      return '<h2>Sin snapshot para ' + dbId + '</h2><p>Corre sync_duckdb.py para poblar datos.</p>';
    }
    try {
      // 4 queries para el snapshot principal en paralelo (antes seriales)
      var [ventas, ventasMes, cxc, topCli] = await Promise.all([
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE - INTERVAL 1 DAY AND (ESTATUS IS NULL OR ESTATUS <> 'C')"),
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')"),
        all(snap, "SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total FROM IMPORTES_DOCTOS_CC WHERE FECHA >= CURRENT_DATE - INTERVAL 730 DAY"),
        all(snap, "SELECT c.NOMBRE, SUM(d.IMPORTE_NETO) AS t FROM DOCTOS_VE d LEFT JOIN CLIENTES c ON c.CLIENTE_ID=d.CLIENTE_ID WHERE d.FECHA>=CURRENT_DATE-INTERVAL 30 DAY GROUP BY c.NOMBRE ORDER BY t DESC LIMIT 5"),
      ]);

      // Multi-unit comparison: cada queryUnit ya internamente es paralelo,
      // así que ejecutarlas en paralelo entre sí es seguro y reduce N empresas
      // de O(N) seriales a 1 batch.
      var allDbIds = Array.from(duckSnaps.keys());
      var unitResults = await Promise.all(allDbIds.map(function (uid) {
        var usnap = getSnap(uid);
        if (!usnap) return null;
        return queryUnit(usnap).then(function (ud) {
          return { label: String(uid).replace(/\.fdb$/i, '').replace(/_/g, ' '), mes: ud.ventasMes, prev: ud.ventasPrev, cxc: ud.cxc, cxp: ud.cxp };
        }).catch(function () { return null; });
      }));
      var unitRows = unitResults.filter(Boolean);
      var totalGrupo = unitRows.reduce(function (s, u) { return s + (u.mes || 0); }, 0);

      var dateStr = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      var mesNombre = new Date().toLocaleDateString('es-MX', { month: 'long' });

      var unitTable = '';
      if (unitRows.length > 1) {
        unitTable = '<h3 style="margin:24px 0 8px;color:#0F172A;font-size:.95rem">Mes en curso (' + mesNombre + ', acumulado vs misma fracción mes anterior)</h3>';
        unitTable += '<table style="width:100%;border-collapse:collapse;font-size:.85rem"><thead><tr><th style="' + thS + ';text-align:left">Unidad</th><th style="' + thS + '">' + mesNombre + '</th><th style="' + thS + '">mes anterior</th><th style="' + thS + '">Δ%</th></tr></thead><tbody>';
        var tMes = 0, tPrev = 0;
        unitRows.forEach(function (u) {
          tMes += u.mes; tPrev += u.prev;
          unitTable += '<tr><td style="' + tdL + '">' + u.label + '</td><td style="' + tdS + '">' + fmt(u.mes) + '</td><td style="' + tdS + '">' + fmt(u.prev) + '</td><td style="' + tdS + '">' + deltaPct(u.mes, u.prev) + '</td></tr>';
        });
        unitTable += '<tr style="background:rgba(230,168,0,.08);font-weight:700"><td style="' + tdL + '">TOTAL GRUPO</td><td style="' + tdS + ';font-weight:700">' + fmt(tMes) + '</td><td style="' + tdS + ';font-weight:700">' + fmt(tPrev) + '</td><td style="' + tdS + '">' + deltaPct(tMes, tPrev) + '</td></tr>';
        unitTable += '</tbody></table>';
      }

      var treasuryTable = '';
      if (unitRows.length > 0) {
        var hasAnyCxp = unitRows.some(function (u) { return u.cxp > 0; });
        treasuryTable = '<h3 style="margin:24px 0 8px;color:#0F172A;font-size:.95rem">Posición de tesorería</h3>';
        treasuryTable += '<table style="width:100%;border-collapse:collapse;font-size:.85rem"><thead><tr><th style="' + thS + ';text-align:left">Unidad</th><th style="' + thS + '">CxC</th>' + (hasAnyCxp ? '<th style="' + thS + '">CxP</th><th style="' + thS + '">Neta</th>' : '') + '</tr></thead><tbody>';
        unitRows.forEach(function (u) {
          var neta = u.cxc - u.cxp;
          var netaCol = neta >= 0 ? '#16A34A' : '#DC2626';
          treasuryTable += '<tr><td style="' + tdL + '">' + u.label + '</td><td style="' + tdS + '">' + fmt(u.cxc) + '</td>';
          if (hasAnyCxp) treasuryTable += '<td style="' + tdS + '">' + fmt(u.cxp) + '</td><td style="' + tdS + ';color:' + netaCol + ';font-weight:700">' + fmt(neta) + '</td>';
          treasuryTable += '</tr>';
        });
        treasuryTable += '</tbody></table>';
      }

      return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte diario grupo Suminregio</title></head>' +
'<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#F6F8FB;color:#0F172A;padding:20px;max-width:720px;margin:0 auto">' +
'<div style="background:#fff;border:1px solid rgba(230,168,0,.25);border-radius:16px;padding:28px;box-shadow:0 4px 12px -2px rgba(15,23,42,.06)">' +
  '<h1 style="margin:0 0 4px 0;color:#0F172A;font-size:1.25rem">Reporte diario grupo Suminregio — ' + dateStr + '</h1>' +
  '<p style="margin:0 0 20px;color:#64748B;font-size:.82rem">Suminregio AI &lt;notificaciones@suminregio.com&gt;</p>' +

  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">' +
    '<div style="background:rgba(230,168,0,.05);border:1px solid rgba(230,168,0,.2);padding:12px 14px;border-radius:10px">' +
      '<div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Ventas ayer</div>' +
      '<div style="font-size:1.4rem;font-weight:700;color:#0F172A">' + fmt(ventas[0] && ventas[0].total) + '</div>' +
      '<div style="font-size:.72rem;color:#94A3B8">' + ((ventas[0] && ventas[0].docs) || 0) + ' docs</div>' +
    '</div>' +
    '<div style="background:rgba(230,168,0,.05);border:1px solid rgba(230,168,0,.2);padding:12px 14px;border-radius:10px">' +
      '<div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">Ventas mes (acum.)</div>' +
      '<div style="font-size:1.4rem;font-weight:700;color:#0F172A">' + fmt(ventasMes[0] && ventasMes[0].total) + '</div>' +
    '</div>' +
    '<div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.2);padding:12px 14px;border-radius:10px;grid-column:span 2">' +
      '<div style="font-size:.7rem;color:#64748B;text-transform:uppercase;font-weight:700;letter-spacing:.05em">CxC total</div>' +
      '<div style="font-size:1.6rem;font-weight:700;color:#B91C1C">' + fmt(cxc[0] && cxc[0].total) + '</div>' +
    '</div>' +
  '</div>' +

  unitTable +
  treasuryTable +

  '<h3 style="margin:24px 0 8px;color:#0F172A;font-size:.95rem">Top 5 clientes (últimos 30 días)</h3>' +
  '<table style="width:100%;border-collapse:collapse;font-size:.85rem">' +
    '<thead><tr><th style="' + thS + ';text-align:left">Cliente</th><th style="' + thS + '">Total</th></tr></thead>' +
    '<tbody>' +
      topCli.map(function (r) { return '<tr><td style="' + tdL + '">' + (r.NOMBRE || '—') + '</td><td style="' + tdS + '">' + fmt(r.t) + '</td></tr>'; }).join('') +
    '</tbody>' +
  '</table>' +

  '<p style="margin-top:24px;font-size:.72rem;color:#94A3B8;border-top:1px solid rgba(15,23,42,.08);padding-top:14px">' +
    'Generado ' + new Date().toLocaleString('es-MX') + ' · Suminregio AI Dashboard' +
  '</p>' +
'</div></body></html>';
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
    var scheduler = require('./lib/scheduler');
    if (log) scheduler.setLogger(log);
    scheduler.schedule({
      name: 'email-diario',
      hour: hour,
      run: async function () {
        var transport = getTransport();
        if (!transport) return;
        var primaryDb = dbs[0] || 'default';
        var html = await buildReportHTML(primaryDb);
        var dateLabel = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        await transport.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: recipients.join(','),
          subject: 'Reporte diario grupo Suminregio — ' + dateLabel,
          html,
        });
        log.info('email-cron', 'enviado reporte grupo → ' + recipients.length + ' destinatarios');
      },
    });
  } else {
    log.info('email', 'cron deshabilitado (SMTP_HOST/REPORT_TO no configurados)');
  }
}

module.exports = { install };
