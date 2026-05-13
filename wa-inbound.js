'use strict';

/**
 * wa-inbound.js — Webhook entrante de WhatsApp (Twilio) → AI chat
 *   POST /api/wa/webhook   ← URL que se configura en Twilio Console (Sandbox o Sender)
 *   POST /api/wa/test      → simula un mensaje sin necesitar Twilio
 *
 * Flujo:
 *   1. Twilio recibe WhatsApp del vendedor → POST a /api/wa/webhook (form-urlencoded)
 *   2. Encolamos el mensaje en una sesión por número (memoria)
 *   3. Reusamos /api/ai/chat-v2 internamente
 *   4. Devolvemos TwiML <Response><Message>...</Message></Response> con la respuesta
 *
 * Comandos directos (sin IA, instantáneos):
 *   /ventas        → ventas del día
 *   /mes           → ventas del mes
 *   /cxc           → CxC total
 *   /churn         → top clientes en riesgo
 *   /compras       → lista priorizada lunes
 *   /reset         → reinicia memoria de sesión
 *
 * Mapeo de números a vendedores:
 *   WA_VENDEDORES_JSON='{"+5218112345678":"vendedor_id_o_nombre"}'
 *   Se usa para limitar la respuesta al scope del vendedor (si vendedor-scope está activo).
 */

const http = require('http');
const crypto = require('crypto');

function install(app, { duckSnaps, log }) {
  const express = require('express');
  const wa_vendedores = (() => {
    try { return JSON.parse(process.env.WA_VENDEDORES_JSON || '{}'); } catch (_) { return {}; }
  })();

  function normalizeNumber(s) {
    return String(s || '').replace(/^whatsapp:/i, '').replace(/\s/g, '');
  }

  /**
   * Valida firma X-Twilio-Signature según spec oficial de Twilio:
   * HMAC-SHA1(authToken, URL + sorted(key+value pairs)) → base64
   * https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  function verifyTwilioSignature(req) {
    const token = process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_TOKEN;
    if (!token) return { ok: false, reason: 'TWILIO_AUTH_TOKEN no configurado' };
    const signature = req.get('X-Twilio-Signature');
    if (!signature) return { ok: false, reason: 'falta X-Twilio-Signature' };
    const proto = req.get('X-Forwarded-Proto') || req.protocol || 'https';
    const host = req.get('X-Forwarded-Host') || req.get('Host');
    const url = `${proto}://${host}${req.originalUrl || req.url}`;
    const params = req.body || {};
    const keys = Object.keys(params).sort();
    let data = url;
    for (const k of keys) data += k + String(params[k]);
    const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
    try {
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return { ok: false, reason: 'firma no coincide' };
      return crypto.timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, reason: 'firma no coincide' };
    } catch (_) { return { ok: false, reason: 'firma inválida' }; }
  }
  function twiml(text) {
    const safe = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
  }

  function postLocal(path, payload) {
    return new Promise((resolve) => {
      const data = JSON.stringify(payload);
      const req = http.request({
        method: 'POST', hostname: '127.0.0.1', port: process.env.PORT || 7000, path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 25000,
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => buf += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (_) { resolve({ ok: false, raw: buf }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.write(data); req.end();
    });
  }

  function getLocal(path) {
    return new Promise((resolve) => {
      const req = http.request({
        method: 'GET', hostname: '127.0.0.1', port: process.env.PORT || 7000, path,
        timeout: 20000,
      }, (resp) => {
        let buf = '';
        resp.on('data', (c) => buf += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (_) { resolve({ ok: false, raw: buf }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      req.end();
    });
  }

  function fmtMx(n) {
    return '$' + Math.round(Number(n) || 0).toLocaleString('es-MX');
  }

  async function handleCommand(cmd, dbId) {
    // /help y /ayuda no requieren snapshot
    if (/^\/?help$/i.test(cmd) || /^\/?ayuda$/i.test(cmd) || cmd === '/' || cmd === '?') {
      return 'Comandos:\n/ventas — hoy\n/mes — mes actual\n/cxc — CxC total\n/top — top vendedores\n/churn — clientes en riesgo\n/compras — top compras urgentes\n/reset — limpiar memoria\nO pregunta libre y respondo con IA.';
    }
    const snap = duckSnaps.get(dbId);
    if (!snap || !snap.conn) return 'Sin datos cargados todavía. Intenta más tarde.';
    function q(sql) {
      return new Promise((r) => snap.conn.all(sql, (err, rows) => r(err ? [] : rows)));
    }

    if (/^\/?ventas?$/i.test(cmd)) {
      const r = await q(`SELECT SUM(IMPORTE_NETO) AS t, COUNT(*) AS n FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE AND (ESTATUS IS NULL OR ESTATUS <> 'C')`);
      return `📊 Ventas hoy: ${fmtMx(r[0]?.t)} (${r[0]?.n || 0} docs)`;
    }
    if (/^\/?mes$/i.test(cmd)) {
      const r = await q(`SELECT SUM(IMPORTE_NETO) AS t FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')`);
      return `📊 Ventas mes: ${fmtMx(r[0]?.t)}`;
    }
    if (/^\/?cxc$/i.test(cmd)) {
      const r = await q(`SELECT SUM(CASE WHEN IMPORTE>0 THEN IMPORTE ELSE 0 END) AS t FROM IMPORTES_DOCTOS_CC`);
      return `💰 CxC total: ${fmtMx(r[0]?.t)}`;
    }
    if (/^\/?churn$/i.test(cmd)) {
      const sum = await getLocal('/api/churn/summary?db=' + encodeURIComponent(dbId));
      if (!sum?.ok || !sum.top5?.length) return 'Sin clientes en riesgo significativo.';
      const lines = sum.top5.map((c, i) => `${i + 1}. ${c.cliente} · ${c.dias_sin_comprar}d sin comprar · score ${c.churn_score}`);
      return '🚨 Top 5 en riesgo:\n' + lines.join('\n');
    }
    if (/^\/?compras$/i.test(cmd)) {
      const lst = await getLocal('/api/compras/lista?db=' + encodeURIComponent(dbId) + '&limit=10');
      if (!lst?.ok || !lst.items?.length) return 'Sin compras urgentes.';
      const lines = lst.items.slice(0, 10).map((r, i) => `${i + 1}. ${r.articulo} · ${r.urgencia} · ${fmtMx(r.valor_compra)}`);
      return `📦 Top 10 compras (valor ${fmtMx(lst.valor_total)}):\n` + lines.join('\n');
    }
    if (/^\/?top$/i.test(cmd)) {
      const r = await q(`SELECT v.NOMBRE, SUM(d.IMPORTE_NETO) AS t FROM DOCTOS_VE d LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID=d.VENDEDOR_ID WHERE date_trunc('month', d.FECHA)=date_trunc('month', CURRENT_DATE) GROUP BY v.NOMBRE ORDER BY t DESC LIMIT 5`);
      return '🏆 Top vendedores mes:\n' + r.map((x, i) => `${i + 1}. ${x.NOMBRE} · ${fmtMx(x.t)}`).join('\n');
    }
    return null; // No es comando
  }

  // ── Webhook (form-urlencoded de Twilio) ────────────────────────────────────
  // Verificación de firma habilitada por default. Para desactivar SOLO en dev:
  //   WA_SKIP_SIGNATURE=1
  app.post('/api/wa/webhook', express.urlencoded({ extended: false }), async (req, res) => {
    if (String(process.env.WA_SKIP_SIGNATURE) !== '1') {
      const sig = verifyTwilioSignature(req);
      if (!sig.ok) {
        log && log.warn && log.warn('wa-inbound', 'firma inválida', { reason: sig.reason });
        return res.status(403).type('text/xml').send(twiml('Acceso denegado.'));
      }
    }

    const from = normalizeNumber(req.body && req.body.From);
    const body = String((req.body && req.body.Body) || '').trim();
    log && log.info && log.info('wa-inbound', 'msg', { from: from.replace(/.(?=.{4})/g, '*'), len: body.length });

    if (!from || !body) {
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      return res.send(twiml('No recibí mensaje. Escribe /help para comandos.'));
    }

    const dbId = process.env.WA_DEFAULT_DB || 'default';
    const sessionId = 'wa-' + from;

    try {
      // Comando primero
      const cmd = await handleCommand(body, dbId);
      if (cmd !== null) {
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        return res.send(twiml(cmd));
      }

      // Reset memoria
      if (/^\/?reset$/i.test(body)) {
        await fetch(`http://127.0.0.1:${process.env.PORT || 7000}/api/ai/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        return res.send(twiml('🧠 Memoria reiniciada.'));
      }

      // Pregunta libre → AI
      const ai = await postLocal('/api/ai/chat-v2', { sessionId, db: dbId, message: body });
      let reply = (ai && ai.reply) ? String(ai.reply) : '';
      if (!reply) {
        reply = (ai && ai.error) ? `AI sin respuesta: ${ai.error}. Usa /help para comandos directos.` : 'No pude responder. Usa /help.';
      }
      // WhatsApp tiene límite ~1600 chars
      if (reply.length > 1500) reply = reply.slice(0, 1500) + '…';
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.send(twiml(reply));
    } catch (e) {
      log && log.error && log.error('wa-inbound', e.message);
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.send(twiml('Error: ' + e.message));
    }
  });

  // ── Endpoint de prueba (JSON, sin Twilio) ──────────────────────────────────
  app.post('/api/wa/test', express.json(), async (req, res) => {
    const body = req.body || {};
    const message = String(body.message || '/help');
    const from = String(body.from || '+5218112345678');
    const dbId = String(body.db || process.env.WA_DEFAULT_DB || 'default');
    const sessionId = 'wa-' + from;
    try {
      const cmd = await handleCommand(message, dbId);
      if (cmd !== null) return res.json({ ok: true, reply: cmd, mode: 'command' });
      const ai = await postLocal('/api/ai/chat-v2', { sessionId, db: dbId, message });
      res.json({ ok: !!(ai && ai.reply), reply: (ai && ai.reply) || (ai && ai.error) || 'sin respuesta', mode: 'ai' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('wa-inbound', '✅ /api/wa/webhook · /api/wa/test');
}

module.exports = { install };
