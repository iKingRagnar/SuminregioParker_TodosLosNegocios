'use strict';

const auth = require('../auth');
const usage = require('./usage-metrics');

const ALLOWED_TYPES = new Set(['page_enter', 'page_leave']);

function install(app) {
  app.post('/api/usage/track', (req, res) => {
    if (!req.user || !(req.user.email || req.user.id)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(401).json({ error: 'No autenticado', code: 'AUTH_REQUIRED' });
    }
    const body = req.body || {};
    const type = String(body.type || '');
    if (!ALLOWED_TYPES.has(type)) {
      return res.status(400).json({ error: 'type debe ser page_enter o page_leave', code: 'USAGE_BAD_TYPE' });
    }
    let durationMs = null;
    if (body.durationMs != null) {
      const n = parseInt(body.durationMs, 10);
      if (Number.isFinite(n)) durationMs = Math.min(86400000, Math.max(0, n));
    }
    usage.append({
      type,
      email: req.user.email,
      roles: req.user.roles || [],
      path: String(body.path || '').slice(0, 500),
      durationMs,
      tabId: String(body.tabId || '').slice(0, 80),
      ip: usage.clientIp(req),
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true });
  });

  app.get('/api/admin/usage-metrics', auth.requireRole('admin'), (req, res) => {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10) || 7));
    const data = usage.readRecent(days);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    return res.json(data);
  });
}

module.exports = { install };
