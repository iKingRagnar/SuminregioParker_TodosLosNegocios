'use strict';

/**
 * collaboration.js — Notas compartidas, tareas, aprobaciones, audit log
 *   GET/POST/DELETE /api/collab/notes?key=...    → comentarios por KPI persistentes
 *   GET/POST/PATCH  /api/collab/tasks             → tareas/follow-ups
 *   GET/POST/PATCH  /api/collab/approvals         → flujo de aprobación
 *   GET/POST        /api/collab/audit             → log de eventos
 */

const store = require('./sumi-db');

function install(app, { log }) {
  const json = require('express').json();

  function audit(event, actor, details) {
    store.append('audit', { event, actor: actor || 'anon', details: details || null });
  }

  // ── Middleware: capturar actor desde header o body ──────────────────────────
  app.use('/api/collab', (req, _res, next) => {
    req.sumiActor = String(req.headers['x-sumi-user'] || (req.body && req.body._user) || 'anon');
    next();
  });

  // ── Notas compartidas por KPI key ───────────────────────────────────────────
  app.get('/api/collab/notes', (req, res) => {
    const key = String(req.query.key || '').trim();
    if (!key) return res.json({ ok: true, notes: store.readAll('notes') });
    res.json({ ok: true, notes: store.query('notes', { key }) });
  });

  app.post('/api/collab/notes', json, (req, res) => {
    const { key, text } = req.body || {};
    if (!key || !text) return res.status(400).json({ error: 'Falta key/text' });
    const row = store.append('notes', { key, text, actor: req.sumiActor });
    audit('note.create', req.sumiActor, { key, noteId: row.id });
    res.json({ ok: true, note: row });
  });

  app.delete('/api/collab/notes/:id', (req, res) => {
    store.remove('notes', req.params.id);
    audit('note.delete', req.sumiActor, { noteId: req.params.id });
    res.json({ ok: true });
  });

  // ── Tareas / follow-ups ─────────────────────────────────────────────────────
  app.get('/api/collab/tasks', (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.assignee) filter.assignee = req.query.assignee;
    res.json({ ok: true, tasks: store.query('tasks', Object.keys(filter).length ? filter : null) });
  });

  app.post('/api/collab/tasks', json, (req, res) => {
    const { title, assignee, due, relatedKey, priority } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Falta title' });
    const row = store.append('tasks', {
      title, assignee: assignee || null, due: due || null,
      relatedKey: relatedKey || null, priority: priority || 'normal',
      status: 'open', actor: req.sumiActor,
    });
    audit('task.create', req.sumiActor, { taskId: row.id, title });
    res.json({ ok: true, task: row });
  });

  app.patch('/api/collab/tasks/:id', json, (req, res) => {
    const patch = {};
    ['title', 'assignee', 'due', 'status', 'priority'].forEach((k) => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
    const row = store.update('tasks', req.params.id, patch);
    if (!row) return res.status(404).json({ error: 'No existe' });
    audit('task.update', req.sumiActor, { taskId: req.params.id, patch });
    res.json({ ok: true, task: row });
  });

  app.delete('/api/collab/tasks/:id', (req, res) => {
    store.remove('tasks', req.params.id);
    audit('task.delete', req.sumiActor, { taskId: req.params.id });
    res.json({ ok: true });
  });

  // ── Aprobaciones ────────────────────────────────────────────────────────────
  app.get('/api/collab/approvals', (req, res) => {
    const filter = req.query.status ? { status: req.query.status } : null;
    res.json({ ok: true, approvals: store.query('approvals', filter) });
  });

  app.post('/api/collab/approvals', json, (req, res) => {
    const { type, data, requester } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Falta type' });
    const row = store.append('approvals', {
      type, data: data || {}, requester: requester || req.sumiActor,
      status: 'pending', decidedBy: null, decidedAt: null,
    });
    audit('approval.request', req.sumiActor, { approvalId: row.id, type });
    res.json({ ok: true, approval: row });
  });

  app.patch('/api/collab/approvals/:id', json, (req, res) => {
    const { decision, reason } = req.body || {};
    if (!/^(approved|rejected)$/.test(String(decision))) {
      return res.status(400).json({ error: 'decision debe ser approved|rejected' });
    }
    const row = store.update('approvals', req.params.id, {
      status: decision, decidedBy: req.sumiActor, decidedAt: new Date().toISOString(),
      reason: reason || null,
    });
    if (!row) return res.status(404).json({ error: 'No existe' });
    audit('approval.decide', req.sumiActor, { approvalId: req.params.id, decision });
    res.json({ ok: true, approval: row });
  });

  // ── Audit log ───────────────────────────────────────────────────────────────
  app.get('/api/collab/audit', (req, res) => {
    const all = store.readAll('audit');
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 100));
    res.json({ ok: true, total: all.length, events: all.slice(-limit).reverse() });
  });

  log.info('collaboration', '✅ /api/collab/* (notes, tasks, approvals, audit) persistente en ' + store.DB_DIR);
}

module.exports = { install };
