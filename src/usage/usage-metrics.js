'use strict';

/**
 * Métricas de uso internas (sin GA): eventos append-only JSONL.
 * Ver informes solo vía GET /api/admin/usage-metrics (rol admin).
 */

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = parseInt(process.env.USAGE_METRICS_MAX_BYTES || String(20 * 1024 * 1024), 10);

function dataPath() {
  const env = process.env.USAGE_METRICS_PATH;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(__dirname, '..', '..', 'data', 'usage-metrics.jsonl');
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function trimFileIfHuge(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= MAX_FILE_BYTES) return;
    const fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, st.size - MAX_FILE_BYTES);
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    const slice = nl >= 0 ? text.slice(nl + 1) : text;
    fs.writeFileSync(filePath, slice, 'utf8');
  } catch (_) {
    /* ignore */
  }
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

/**
 * @param {Record<string, unknown>} record
 */
function append(record) {
  const filePath = dataPath();
  try {
    ensureDir(filePath);
    trimFileIfHuge(filePath);
    const line = JSON.stringify({ ...record, _ts: Date.now() }) + '\n';
    fs.appendFile(filePath, line, () => {});
  } catch (e) {
    console.warn('[usage-metrics] append:', e.message);
  }
}

function recordLogin(req, user) {
  append({
    type: 'login',
    email: user.email,
    roles: user.roles,
    ip: clientIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 400),
  });
}

function recordLogout(req) {
  const u = req.user;
  if (!u || !u.email) return;
  append({
    type: 'logout',
    email: u.email,
    roles: u.roles || [],
    ip: clientIp(req),
  });
}

/**
 * @param {number} days
 */
function readRecent(days) {
  const cutoff = Date.now() - days * 86400000;
  const filePath = dataPath();
  if (!fs.existsSync(filePath)) {
    return { events: [], summary: { byUser: {} }, days, generatedAt: Date.now() };
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { events: [], summary: { byUser: {} }, days, error: e.message, generatedAt: Date.now() };
  }
  const lines = text.split('\n').filter(Boolean);
  /** @type {any[]} */
  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const ts = e._ts || 0;
      if (ts >= cutoff) events.push(e);
    } catch (_) {
      /* skip bad line */
    }
  }
  events.reverse();
  const summary = buildSummary(events);
  const maxOut = Math.min(5000, parseInt(process.env.USAGE_METRICS_ADMIN_MAX_EVENTS || '2500', 10));
  return {
    events: events.slice(0, maxOut),
    summary,
    days,
    totalMatched: events.length,
    generatedAt: Date.now(),
  };
}

/**
 * @param {any[]} events
 */
function buildSummary(events) {
  /** @type {Record<string, any>} */
  const byUser = {};
  for (const e of events) {
    const em = String(e.email || 'unknown').toLowerCase();
    if (!byUser[em]) {
      byUser[em] = {
        email: em,
        roles: e.roles || [],
        logins: 0,
        logouts: 0,
        lastLoginAt: null,
        pages: {},
      };
    }
    const row = byUser[em];
    if (Array.isArray(e.roles) && e.roles.length) row.roles = e.roles;

    if (e.type === 'login') {
      row.logins += 1;
      const ts = e._ts || 0;
      if (!row.lastLoginAt || ts > row.lastLoginAt) row.lastLoginAt = ts;
    }
    if (e.type === 'logout') row.logouts += 1;

    if (e.type === 'page_enter' && e.path) {
      const p = String(e.path).split('?')[0].slice(0, 200);
      if (!row.pages[p]) row.pages[p] = { enters: 0, leaves: 0, activeMs: 0 };
      row.pages[p].enters += 1;
    }
    if (e.type === 'page_leave' && e.path && Number.isFinite(e.durationMs) && e.durationMs > 0) {
      const p = String(e.path).split('?')[0].slice(0, 200);
      if (!row.pages[p]) row.pages[p] = { enters: 0, leaves: 0, activeMs: 0 };
      row.pages[p].leaves += 1;
      row.pages[p].activeMs += e.durationMs;
    }
  }
  return { byUser };
}

module.exports = {
  append,
  recordLogin,
  recordLogout,
  readRecent,
  buildSummary,
  clientIp,
  dataPath,
};
