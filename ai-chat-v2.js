'use strict';

/**
 * ai-chat-v2.js — Asistente conversacional con memoria
 * Usa @anthropic-ai/sdk (ya está en dependencies) + contexto de DuckDB.
 *
 * Endpoints:
 *   POST /api/ai/chat-v2    { messages, db?, sessionId? }
 *   GET  /api/ai/sessions   → lista conversaciones en memoria (últimas 20)
 *   DELETE /api/ai/sessions/:id
 *
 * Memoria: ring buffer en RAM, 20 sesiones, 30 msgs cada una.
 * Env: ANTHROPIC_API_KEY (o OPENAI_API_KEY compat si ANTHROPIC falta)
 */

function install(app, { duckSnaps, log }) {
  var Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }

  var client = null;
  if (Anthropic && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)) {
    try {
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
    } catch (e) { log.warn('ai-chat-v2', 'init error: ' + e.message); }
  }

  var sessions = new Map(); // sessionId → { createdAt, lastAt, messages, dbId }
  var MAX_SESSIONS = 20;
  var MAX_MSGS = 30;

  function getSnap(id) {
    var s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }

  function all(snap, sql) {
    return new Promise(function (res, rej) {
      snap.conn.all(sql, function (err, rows) { err ? rej(err) : res(rows || []); });
    });
  }

  /** Genera contexto de la empresa para el prompt del system */
  async function buildContext(dbId) {
    var snap = getSnap(dbId);
    if (!snap) return 'SIN SNAPSHOT: no hay datos cargados para ' + dbId;
    try {
      var [ventas, cxc, inv, clientes] = await Promise.all([
        all(snap, `SELECT SUM(IMPORTE_NETO) AS mes FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')`).catch(() => [{}]),
        all(snap, `SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total FROM IMPORTES_DOCTOS_CC`).catch(() => [{}]),
        all(snap, `SELECT COUNT(*) AS n FROM ARTICULOS`).catch(() => [{}]),
        all(snap, `SELECT COUNT(*) AS n FROM CLIENTES`).catch(() => [{}]),
      ]);
      return [
        'EMPRESA: ' + dbId,
        'VENTAS DEL MES: $' + Math.round((ventas[0] && ventas[0].mes) || 0).toLocaleString('es-MX'),
        'CXC TOTAL: $' + Math.round((cxc[0] && cxc[0].total) || 0).toLocaleString('es-MX'),
        'ARTÍCULOS EN CATÁLOGO: ' + ((inv[0] && inv[0].n) || 0),
        'CLIENTES: ' + ((clientes[0] && clientes[0].n) || 0),
        'FECHA ACTUAL: ' + new Date().toISOString().slice(0, 10),
      ].join('\n');
    } catch (e) { return 'Error contexto: ' + e.message; }
  }

  // ── Endpoint principal ──────────────────────────────────────────────────────
  app.post('/api/ai/chat-v2', require('express').json({ limit: '200kb' }), async function (req, res) {
    if (!client) {
      return res.status(503).json({
        error: 'AI no configurado',
        hint: 'Define ANTHROPIC_API_KEY en Render Env vars.',
      });
    }

    var body = req.body || {};
    var dbId = String(body.db || 'default');
    var sessionId = String(body.sessionId || 'anon-' + Date.now());
    var userMsg = String(body.message || '').trim();
    if (!userMsg && !Array.isArray(body.messages)) {
      return res.status(400).json({ error: 'Falta body.message o body.messages' });
    }

    // Recuperar o crear sesión
    var sess = sessions.get(sessionId);
    if (!sess) {
      sess = { createdAt: Date.now(), lastAt: Date.now(), messages: [], dbId };
      sessions.set(sessionId, sess);
      // Purge excedente
      if (sessions.size > MAX_SESSIONS) {
        var oldest = [...sessions.entries()].sort(function (a, b) { return a[1].lastAt - b[1].lastAt; })[0];
        if (oldest) sessions.delete(oldest[0]);
      }
    }
    sess.lastAt = Date.now();

    if (userMsg) sess.messages.push({ role: 'user', content: userMsg });
    else sess.messages = sess.messages.concat(body.messages);
    if (sess.messages.length > MAX_MSGS) sess.messages = sess.messages.slice(-MAX_MSGS);

    try {
      var ctx = await buildContext(dbId);
      var system = [
        'Eres el asistente de Suminregio Parker (empresa mexicana de suministros industriales).',
        'Respondes en español, conciso y profesional. Datos concretos, sin rodeos.',
        'Al citar cifras, usa formato mexicano (ej: $1,234,567).',
        'Si preguntan algo que requiere datos específicos, sugiere el endpoint o módulo.',
        '',
        'CONTEXTO ACTUAL:',
        ctx,
      ].join('\n');

      var response = await client.messages.create({
        model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: system,
        messages: sess.messages.map(function (m) { return { role: m.role, content: m.content }; }),
      });

      var reply = (response.content || []).map(function (c) { return c.text || ''; }).join('\n').trim();
      sess.messages.push({ role: 'assistant', content: reply });

      res.json({
        ok: true,
        sessionId,
        reply,
        usage: response.usage,
        model: response.model,
      });
    } catch (e) {
      log.error('ai-chat-v2', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ai/sessions', function (_req, res) {
    var list = [];
    sessions.forEach(function (s, id) {
      list.push({
        id, dbId: s.dbId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastAt: new Date(s.lastAt).toISOString(),
        msgCount: s.messages.length,
      });
    });
    list.sort(function (a, b) { return new Date(b.lastAt) - new Date(a.lastAt); });
    res.json({ ok: true, sessions: list });
  });

  app.delete('/api/ai/sessions/:id', function (req, res) {
    var existed = sessions.delete(req.params.id);
    res.json({ ok: true, existed });
  });

  log.info('ai-chat-v2', client ? '✅ con ANTHROPIC_API_KEY' : '⚠️  sin API key (endpoint responde 503)');
}

module.exports = { install };
