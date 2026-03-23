/**
 * modules/notifier.js
 * Envía alertas por email (Outlook 365 SMTP) y WhatsApp (Twilio).
 * Soporta imágenes adjuntas (screenshots de dashboards) en el email.
 */
'use strict';

const nodemailer = require('nodemailer');
const twilio     = require('twilio');

function normEnv(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function csvList(v) {
  return String(normEnv(v) || '')
    .split(/[;,]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function boolFromEnv(v, defVal = false) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return !!defVal;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function getNotifierConfig() {
  const email = {
    host: normEnv(process.env.SMTP_HOST) || 'smtp.office365.com',
    port: +(normEnv(process.env.SMTP_PORT) || 587),
    secure: boolFromEnv(process.env.SMTP_SECURE, false),
    user: normEnv(process.env.SMTP_USER) || normEnv(process.env.EMAIL_USER) || '',
    from: normEnv(process.env.EMAIL_FROM) || normEnv(process.env.SMTP_USER) || normEnv(process.env.EMAIL_USER) || '',
    to: csvList(process.env.EMAIL_TO),
  };
  const whatsapp = {
    from: normEnv(process.env.TWILIO_WA_FROM) || '',
    to: csvList(process.env.ALERT_WA_TO),
    accountSid: normEnv(process.env.TWILIO_ACCOUNT_SID) || '',
  };
  const pass = normEnv(process.env.SMTP_PASS) || normEnv(process.env.EMAIL_PASS);
  const twilioToken = normEnv(process.env.TWILIO_AUTH_TOKEN);
  return {
    email: {
      ...email,
      enabled: !!(email.user && pass && email.to.length),
    },
    whatsapp: {
      ...whatsapp,
      enabled: !!(whatsapp.accountSid && twilioToken && whatsapp.from && whatsapp.to.length),
    },
  };
}

// ── Transporte SMTP Outlook 365 ───────────────────────────────────────────────
function getMailTransport() {
  const user = normEnv(process.env.SMTP_USER) || normEnv(process.env.EMAIL_USER);
  const pass = normEnv(process.env.SMTP_PASS) || normEnv(process.env.EMAIL_PASS);
  if (!user || !pass || pass.includes('xxxx xxxx')) {
    throw new Error('SMTP_USER/SMTP_PASS (o EMAIL_USER/EMAIL_PASS) no configurados en .env');
  }
  const host = normEnv(process.env.SMTP_HOST) || 'smtp.office365.com';
  const port = +(normEnv(process.env.SMTP_PORT) || 587);
  const secure = boolFromEnv(process.env.SMTP_SECURE, false);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
}

// ── Cliente Twilio WhatsApp ───────────────────────────────────────────────────
function getTwilioClient() {
  const sid   = normEnv(process.env.TWILIO_ACCOUNT_SID);
  const token = normEnv(process.env.TWILIO_AUTH_TOKEN);
  if (!sid || !token || sid.startsWith('ACxxxxxxx')) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN no configurados en .env');
  }
  return twilio(sid, token);
}

// ── Formatear número para display ────────────────────────────────────────────
const fmtM = n => {
  if (n == null || isNaN(+n)) return 'N/D';
  n = +n;
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('es-MX');
};
const fmtPct = n => (n == null || isNaN(+n)) ? 'N/D' : (+n).toFixed(1) + '%';

// ── Generar HTML del email de alerta ─────────────────────────────────────────
function buildAlertEmailHtml(alertData, screenshotCids) {
  const { empresa, fecha, alertas, kpis } = alertData;
  const { ventas, cxc, pnl } = kpis || {};
  const pub = process.env.SERVER_PUBLIC_URL || 'http://localhost:7000';

  // Función helper para badge de estatus
  const badge = (ok, txt) =>
    `<span style="background:${ok ? '#16a34a' : '#dc2626'};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">${txt}</span>`;

  const alertRows = (alertas || []).map(a =>
    `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b">${a.modulo}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b">${a.descripcion}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b">${badge(false, a.nivel || 'ALERTA')}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e293b;font-weight:700;color:${a.ok ? '#22c55e' : '#ef4444'}">${a.valor}</td>
    </tr>`
  ).join('');

  // Filas KPI ventas
  const v = ventas || {};
  const c = cxc || {};
  const p = pnl?.totales || {};

  const kpiHtml = `
    <table width="100%" style="border-collapse:collapse;margin-bottom:16px">
      <tr style="background:#0f172a">
        <th style="padding:10px 12px;text-align:left;color:#64748b;font-size:11px;font-weight:600">KPI</th>
        <th style="padding:10px 12px;text-align:right;color:#64748b;font-size:11px;font-weight:600">VALOR</th>
        <th style="padding:10px 12px;text-align:right;color:#64748b;font-size:11px;font-weight:600">META</th>
        <th style="padding:10px 12px;text-align:center;color:#64748b;font-size:11px;font-weight:600">ESTADO</th>
      </tr>
      <tr style="background:#1e293b">
        <td style="padding:8px 12px;color:#e2e8f0">Ventas Mes</td>
        <td style="padding:8px 12px;text-align:right;color:#f8fafc;font-weight:700">${fmtM(v.TOTAL_MES || v.VENTA_MES)}</td>
        <td style="padding:8px 12px;text-align:right;color:#94a3b8">${fmtM(v.META_MES || 0)}</td>
        <td style="padding:8px 12px;text-align:center">${badge((+(v.CUMPL_PCT || 0)) >= 80, fmtPct(v.CUMPL_PCT || 0))}</td>
      </tr>
      <tr style="background:#152032">
        <td style="padding:8px 12px;color:#e2e8f0">CXC Vencido</td>
        <td style="padding:8px 12px;text-align:right;color:#f8fafc;font-weight:700">${fmtM(c.VENCIDO)}</td>
        <td style="padding:8px 12px;text-align:right;color:#94a3b8">Saldo: ${fmtM(c.SALDO_TOTAL)}</td>
        <td style="padding:8px 12px;text-align:center">${
          (() => { const pv = c.SALDO_TOTAL > 0 ? (c.VENCIDO / c.SALDO_TOTAL * 100) : 0;
                   return badge(pv < 30, fmtPct(pv) + ' venc.'); })()
        }</td>
      </tr>
      <tr style="background:#1e293b">
        <td style="padding:8px 12px;color:#e2e8f0">Margen Bruto</td>
        <td style="padding:8px 12px;text-align:right;color:#f8fafc;font-weight:700">${fmtPct(p.MARGEN_BRUTO_PCT)}</td>
        <td style="padding:8px 12px;text-align:right;color:#94a3b8">Obj: &gt;25%</td>
        <td style="padding:8px 12px;text-align:center">${badge((+(p.MARGEN_BRUTO_PCT || 0)) >= 25, (+(p.MARGEN_BRUTO_PCT || 0)) >= 25 ? 'OK' : 'BAJO')}</td>
      </tr>
    </table>`;

  const screenshotHtmls = (screenshotCids || []).map((cid, i) =>
    `<div style="margin:12px 0">
      <p style="color:#64748b;font-size:11px;margin:4px 0">Captura ${i + 1}</p>
      <img src="cid:${cid}" style="width:100%;border-radius:8px;border:1px solid #334155" alt="Dashboard Screenshot"/>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a1628;font-family:Inter,Arial,sans-serif;color:#e2e8f0">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <!-- Header -->
  <div style="background:linear-gradient(135deg,#1e3a5f,#0f2540);border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid #1e3a5f">
    <div style="display:flex;align-items:center;gap:12px">
      <div style="background:#dc2626;border-radius:50%;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🔔</div>
      <div>
        <div style="font-size:18px;font-weight:700;color:#f8fafc">Alerta de KPIs — ${empresa}</div>
        <div style="font-size:12px;color:#64748b;margin-top:2px">${fecha} · Dashboard ERP Microsip</div>
      </div>
    </div>
  </div>

  <!-- Alertas activas -->
  ${alertas && alertas.length ? `
  <div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px;border-left:4px solid #dc2626">
    <div style="font-size:13px;font-weight:700;color:#f87171;margin-bottom:10px">⚠️ ${alertas.length} alerta(s) activa(s)</div>
    <table width="100%" style="border-collapse:collapse;font-size:12px">
      <tr style="background:#0f172a">
        <th style="padding:6px 12px;text-align:left;color:#64748b">Módulo</th>
        <th style="padding:6px 12px;text-align:left;color:#64748b">Descripción</th>
        <th style="padding:6px 12px;text-align:center;color:#64748b">Nivel</th>
        <th style="padding:6px 12px;text-align:right;color:#64748b">Valor</th>
      </tr>
      ${alertRows}
    </table>
  </div>` : `
  <div style="background:#14532d;border-radius:8px;padding:16px;margin-bottom:16px;border-left:4px solid #16a34a">
    <div style="font-size:13px;font-weight:700;color:#4ade80">✅ Todos los KPIs dentro de rango</div>
  </div>`}

  <!-- KPIs resumen -->
  <div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;color:#94a3b8;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Resumen KPIs</div>
    ${kpiHtml}
  </div>

  <!-- Screenshots -->
  ${screenshotHtmls ? `<div style="background:#1e293b;border-radius:8px;padding:16px;margin-bottom:16px">${screenshotHtmls}</div>` : ''}

  <!-- Links -->
  <div style="text-align:center;margin-top:20px">
    <a href="${pub}" style="background:#2563eb;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">Ver Dashboard →</a>
    <a href="${pub}/resultados.html" style="background:#0f172a;color:#94a3b8;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin-left:8px">Estado de Resultados</a>
  </div>
  <div style="text-align:center;margin-top:16px;font-size:10px;color:#334155">
    Generado automáticamente por el sistema de alertas de ${empresa}. Para dejar de recibir alertas, elimina EMAIL_TO del archivo .env del servidor.
  </div>
</div>
</body></html>`;
}

// ── Texto WhatsApp (emojis + datos clave) ─────────────────────────────────────
function buildWhatsAppText(alertData) {
  const { empresa, fecha, alertas, kpis } = alertData;
  const { ventas, cxc, pnl } = kpis || {};
  const v = ventas || {};
  const c = cxc || {};
  const p = pnl?.totales || {};

  const lines = [
    `🔔 *Alerta KPIs — ${empresa}*`,
    `📅 ${fecha}`,
    '',
  ];

  if (alertas && alertas.length) {
    lines.push(`⚠️ *${alertas.length} alerta(s) activa(s):*`);
    alertas.forEach(a => lines.push(`  • ${a.modulo}: ${a.descripcion} → ${a.valor}`));
    lines.push('');
  } else {
    lines.push('✅ Todos los KPIs dentro de rango');
    lines.push('');
  }

  lines.push('📊 *Resumen del día:*');
  if (v.TOTAL_MES != null || v.VENTA_MES != null)
    lines.push(`  • Ventas mes: ${fmtM(v.TOTAL_MES || v.VENTA_MES)} (${fmtPct(v.CUMPL_PCT)})`);
  if (c.SALDO_TOTAL != null)
    lines.push(`  • CXC: ${fmtM(c.SALDO_TOTAL)} (venc. ${fmtPct(c.SALDO_TOTAL > 0 ? c.VENCIDO / c.SALDO_TOTAL * 100 : 0)})`);
  if (p.MARGEN_BRUTO_PCT != null)
    lines.push(`  • Margen bruto: ${fmtPct(p.MARGEN_BRUTO_PCT)}`);

  lines.push('');
  lines.push(`🔗 Dashboard: ${process.env.SERVER_PUBLIC_URL || 'http://localhost:7000'}`);

  return lines.join('\n');
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * sendEmail({ alertData, screenshotBuffers? })
 * screenshotBuffers: array de { name, buffer } con imágenes PNG adjuntas inline
 */
async function sendEmail({ alertData, screenshotBuffers = [] }) {
  const transport = getMailTransport();
  const recipients = csvList(process.env.EMAIL_TO);
  if (!recipients.length) throw new Error('EMAIL_TO no configurado en .env');

  const cids = screenshotBuffers.map((_, i) => `screenshot${i}@dashboard`);
  const html = buildAlertEmailHtml(alertData, cids);

  const attachments = screenshotBuffers.map((s, i) => ({
    filename: s.name || `screenshot${i}.png`,
    content: s.buffer,
    cid: cids[i],
    contentType: 'image/png',
  }));

  const today = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  const hasAlerts = alertData.alertas && alertData.alertas.length > 0;

  const info = await transport.sendMail({
    from: normEnv(process.env.EMAIL_FROM) || normEnv(process.env.SMTP_USER) || normEnv(process.env.EMAIL_USER),
    to: recipients.join(', '),
    subject: `${hasAlerts ? '⚠️ ALERTA' : '✅ OK'} KPIs ${alertData.empresa} — ${today}`,
    html,
    attachments,
  });

  return { messageId: info.messageId, recipients };
}

/**
 * sendWhatsApp({ alertData })
 */
async function sendWhatsApp({ alertData }) {
  const client   = getTwilioClient();
  const from     = normEnv(process.env.TWILIO_WA_FROM);
  const toList   = csvList(process.env.ALERT_WA_TO);
  if (!toList.length) throw new Error('ALERT_WA_TO no configurado en .env');
  if (!from) throw new Error('TWILIO_WA_FROM no configurado en .env');

  const body = buildWhatsAppText(alertData);
  const results = [];
  for (const to of toList) {
    const msg = await client.messages.create({ from, to, body });
    results.push({ to, sid: msg.sid });
  }
  return results;
}

async function verifyChannels() {
  const cfg = getNotifierConfig();
  const out = {
    email: {
      configured: !!(cfg && cfg.email && cfg.email.enabled),
      host: (cfg && cfg.email && cfg.email.host) || '',
      port: (cfg && cfg.email && cfg.email.port) || 0,
      secure: !!(cfg && cfg.email && cfg.email.secure),
      user: (cfg && cfg.email && cfg.email.user) || '',
      to: (cfg && cfg.email && cfg.email.to) || [],
      ok: false,
      error: null,
    },
    whatsapp: {
      configured: !!(cfg && cfg.whatsapp && cfg.whatsapp.enabled),
      from: (cfg && cfg.whatsapp && cfg.whatsapp.from) || '',
      to: (cfg && cfg.whatsapp && cfg.whatsapp.to) || [],
      ok: false,
      error: null,
    },
  };
  if (out.email.configured) {
    try {
      const tr = getMailTransport();
      await tr.verify();
      out.email.ok = true;
    } catch (e) {
      out.email.error = e && e.message ? e.message : String(e);
    }
  }
  if (out.whatsapp.configured) {
    try {
      const cli = getTwilioClient();
      await cli.api.accounts((cfg.whatsapp.accountSid || '')).fetch();
      out.whatsapp.ok = true;
    } catch (e) {
      out.whatsapp.error = e && e.message ? e.message : String(e);
    }
  }
  return out;
}

/**
 * sendAlert({ alertData, screenshotBuffers?, channels? })
 * channels: ['email', 'whatsapp'] (default: ambos)
 */
async function sendAlert({ alertData, screenshotBuffers = [], channels = ['email', 'whatsapp'] }) {
  const cfg = getNotifierConfig();
  const results = {
    email: null,
    whatsapp: null,
    errors: [],
    targets: {
      email: cfg.email.to,
      whatsapp: cfg.whatsapp.to,
    },
  };

  if (channels.includes('email')) {
    try {
      results.email = await sendEmail({ alertData, screenshotBuffers });
    } catch (e) {
      results.errors.push({ channel: 'email', error: e.message });
      console.error('[notifier] Email error:', e.message);
    }
  }

  if (channels.includes('whatsapp')) {
    try {
      results.whatsapp = await sendWhatsApp({ alertData });
    } catch (e) {
      results.errors.push({ channel: 'whatsapp', error: e.message });
      console.error('[notifier] WhatsApp error:', e.message);
    }
  }

  return results;
}

module.exports = { sendAlert, sendEmail, sendWhatsApp, buildAlertEmailHtml, buildWhatsAppText, getNotifierConfig, verifyChannels };
