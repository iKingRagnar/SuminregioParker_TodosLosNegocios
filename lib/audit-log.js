'use strict';

/**
 * lib/audit-log.js — Audit log persistente de acciones admin.
 *
 * Para acciones mutables (upload snapshot, rotate token, delete cache, etc.)
 * queremos saber QUIÉN, QUÉ, CUÁNDO, DESDE DÓNDE. Especialmente útil cuando
 * algo se rompe y hay que reconstruir qué pasó.
 *
 * Persiste en sumi-db (JSONL) para sobrevivir restart. Ring buffer 5000.
 *
 * Uso:
 *   const audit = require('./lib/audit-log').create();
 *   audit.log(req, 'snapshot.upload', { dbId, bytes });
 *
 *   app.get('/api/admin/audit', (_req, res) => res.json(audit.list({ limit: 100 })));
 */

const store = require('../sumi-db');

function create(opts = {}) {
  const TABLE = opts.table || 'audit_log';
  const MAX_ENTRIES = opts.max || 5000;

  function log(req, action, details = {}) {
    const user = req && req.user;
    const ip = req && ((req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || 'unknown');
    const entry = {
      ts: new Date().toISOString(),
      action: String(action),
      user_email: user ? user.email : null,
      user_roles: user ? user.roles : null,
      ip: typeof ip === 'string' ? ip.split(',')[0].trim() : 'unknown',
      method: req ? req.method : null,
      path: req ? req.path : null,
      trace_id: req ? req.traceId : null,
      details,
    };
    store.append(TABLE, entry);

    // Trim ring buffer si excede max
    try {
      const all = store.readAll(TABLE);
      if (all.length > MAX_ENTRIES) {
        const toRemove = all.length - MAX_ENTRIES;
        const sorted = all.slice().sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
        for (let i = 0; i < toRemove; i++) {
          store.remove(TABLE, sorted[i].id);
        }
      }
    } catch (_) { /* best-effort */ }

    return entry;
  }

  function list(opts = {}) {
    const limit = Math.min(1000, opts.limit || 100);
    const action = opts.action;
    const user = opts.user;
    const sinceMs = opts.sinceMs || 0;
    const rows = store.readAll(TABLE);
    return rows
      .filter((r) => {
        if (action && r.action !== action) return false;
        if (user && r.user_email !== user) return false;
        if (sinceMs && new Date(r.ts).getTime() < sinceMs) return false;
        return true;
      })
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, limit);
  }

  function stats() {
    const rows = store.readAll(TABLE);
    const byAction = {};
    const byUser = {};
    for (const r of rows) {
      byAction[r.action] = (byAction[r.action] || 0) + 1;
      if (r.user_email) byUser[r.user_email] = (byUser[r.user_email] || 0) + 1;
    }
    return {
      total: rows.length,
      uniqueActions: Object.keys(byAction).length,
      uniqueUsers: Object.keys(byUser).length,
      byAction,
      byUser,
    };
  }

  return { log, list, stats };
}

module.exports = { create };
