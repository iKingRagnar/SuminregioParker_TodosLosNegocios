'use strict';

/**
 * notifications.js — Canal unificado de notificaciones
 *   POST /api/notify/whatsapp { to, message }   → Twilio WhatsApp
 *   POST /api/notify/sms      { to, message }   → Twilio SMS
 *   POST /api/notify/slack    { text, channel? } → Slack webhook
 *   POST /api/notify/push     { subscription, payload } → Web Push (VAPID)
 *   GET  /api/notify/push/vapid-public-key
 *   POST /api/notify/push/subscribe / unsubscribe
 *   POST /api/slack/command                     → handler de slash commands
 */

const store = require('./sumi-db');

function install(app, { duckSnaps, log }) {
  let twilio;
  try { twilio = require('twilio'); } catch (_) { twilio = null; }
  let webpush;
  try { webpush = require('web-push'); } catch (_) { webpush = null; }

  const tClient = (twilio && process.env.TWILIO_SID && process.env.TWILIO_TOKEN)
    ? twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN)
    : null;

  if (webpush && process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    try {
      webpush.setVapidDetails(
        process.env.VAPID_CONTACT || 'mailto:admin@suminregio.mx',
        process.env.VAPID_PUBLIC,
        process.env.VAPID_PRIVATE
      );
    } catch (e) { log.warn('notify', 'vapid setup: ' + e.message); }
  }

  // ── WhatsApp vía Twilio ────────────────────────────────────────────────────
  app.post('/api/notify/whatsapp', require('express').json(), async (req, res) => {
    if (!tClient) return res.status(503).json({ error: 'Twilio no configurado' });
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Falta to/message' });
    try {
      const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // sandbox default
      const msg = await tClient.messages.create({
        from,
        to: to.startsWith('whatsapp:') ? to : ('whatsapp:' + to),
        body: message,
      });
      log.info('notify-wa', 'enviado', { to, sid: msg.sid });
      res.json({ ok: true, sid: msg.sid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── SMS vía Twilio ─────────────────────────────────────────────────────────
  app.post('/api/notify/sms', require('express').json(), async (req, res) => {
    if (!tClient) return res.status(503).json({ error: 'Twilio no configurado' });
    const { to, message } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Falta to/message' });
    try {
      const msg = await tClient.messages.create({
        from: process.env.TWILIO_SMS_FROM,
        to, body: message,
      });
      res.json({ ok: true, sid: msg.sid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Slack webhook (incoming) ────────────────────────────────────────────────
  app.post('/api/notify/slack', require('express').json(), async (req, res) => {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) return res.status(503).json({ error: 'SLACK_WEBHOOK_URL no configurado' });
    const payload = { text: req.body.text, channel: req.body.channel };
    try {
      const https = require('https');
      const http = require('http');
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify(payload);
      const r = await new Promise((resolve) => {
        const rq = lib.request({
          method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (resp) => { resp.resume(); resp.on('end', () => resolve({ status: resp.statusCode })); });
        rq.on('error', (e) => resolve({ error: e.message }));
        rq.write(body); rq.end();
      });
      res.json({ ok: !r.error, ...r });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Slack slash command handler ─────────────────────────────────────────────
  app.post('/api/slack/command', require('express').urlencoded({ extended: false }), async (req, res) => {
    const text = String(req.body.text || '').trim().toLowerCase();
    const snap = duckSnaps.get('default');
    if (!snap || !snap.conn) return res.json({ response_type: 'ephemeral', text: 'Sin snapshot cargado' });

    function q(sql) {
      return new Promise((r) => snap.conn.all(sql, (err, rows) => r(err ? [] : rows)));
    }
    function fmt(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('es-MX'); }

    let reply;
    if (/^ventas[- ]?hoy$/.test(text)) {
      const r = await q(`SELECT SUM(IMPORTE_NETO) AS t, COUNT(*) AS n FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE AND (ESTATUS IS NULL OR ESTATUS <> 'C')`);
      reply = `*Ventas hoy:* ${fmt(r[0]?.t)} en ${r[0]?.n || 0} docs`;
    } else if (/^ventas[- ]?mes$/.test(text)) {
      const r = await q(`SELECT SUM(IMPORTE_NETO) AS t FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')`);
      reply = `*Ventas del mes:* ${fmt(r[0]?.t)}`;
    } else if (/^top[- ]?deudores$/.test(text)) {
      const r = await q(`SELECT c.NOMBRE, SUM(d.IMPORTE) AS s FROM IMPORTES_DOCTOS_CC d LEFT JOIN CLIENTES c ON c.CLIENTE_ID=d.CLIENTE_ID WHERE d.IMPORTE>0 GROUP BY c.NOMBRE ORDER BY s DESC LIMIT 5`);
      reply = '*Top deudores:*\n' + r.map((x, i) => `${i + 1}. ${x.NOMBRE} — ${fmt(x.s)}`).join('\n');
    } else if (/^cxc$/.test(text)) {
      const r = await q(`SELECT SUM(CASE WHEN IMPORTE>0 THEN IMPORTE ELSE 0 END) AS t FROM IMPORTES_DOCTOS_CC`);
      reply = `*CXC total:* ${fmt(r[0]?.t)}`;
    } else {
      reply = 'Comandos disponibles: `ventas-hoy`, `ventas-mes`, `top-deudores`, `cxc`';
    }
    res.json({ response_type: 'in_channel', text: reply });
  });

  // ── Web Push VAPID ──────────────────────────────────────────────────────────
  app.get('/api/notify/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC || null });
  });

  app.post('/api/notify/push/subscribe', require('express').json(), (req, res) => {
    const subscription = req.body && req.body.subscription;
    if (!subscription) return res.status(400).json({ error: 'Falta subscription' });
    const row = store.append('push_subscriptions', { subscription });
    res.json({ ok: true, id: row.id });
  });

  app.post('/api/notify/push/unsubscribe', require('express').json(), (req, res) => {
    const id = req.body && req.body.id;
    if (id) store.remove('push_subscriptions', id);
    res.json({ ok: true });
  });

  app.post('/api/notify/push/send', require('express').json(), async (req, res) => {
    if (!webpush || !process.env.VAPID_PRIVATE) {
      return res.status(503).json({ error: 'web-push no configurado' });
    }
    const payload = JSON.stringify(req.body.payload || { title: 'Suminregio', body: 'Notificación' });
    const subs = store.readAll('push_subscriptions');
    const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s.subscription, payload)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    res.json({ ok: true, sent: ok, failed: results.length - ok, total: results.length });
  });

  log.info('notifications', `twilio=${!!tClient} webpush=${!!webpush}`);
}

module.exports = { install };
