'use strict';

/**
 * lib/error-tracker.js — Tracker de errores in-memory tipo Sentry-lite.
 *
 * El proyecto ya tiene `safe-catch.js` (ring buffer simple). Esto lo complementa
 * con **deduplicación por fingerprint** (mismo error repetido N veces se cuenta
 * como 1 issue con N ocurrencias) y métricas para que Prometheus exponga
 * "errores únicos" vs "ocurrencias totales".
 *
 * Sin dependencias externas. No envía a ningún servicio.
 *
 * Uso:
 *   const tracker = require('./lib/error-tracker').create({ max: 200 });
 *   try { ... } catch (e) { tracker.capture(e, { route: '/api/x', trace_id: 'abc' }); }
 *
 *   app.get('/api/admin/issues', (req, res) => res.json(tracker.issues()));
 */

const crypto = require('crypto');

function fingerprint(err, context = {}) {
  const name = (err && err.name) || 'Error';
  const msg = (err && err.message) || String(err);
  // Primera línea del stack que NO sea node_modules (firma del error real).
  // Removemos números de línea/columna del stack para que `new Error('x')` en
  // distintas líneas del mismo archivo dedupliquen al mismo issue.
  let firstAppLine = '';
  if (err && err.stack) {
    const lines = String(err.stack).split('\n');
    for (const line of lines) {
      if (line.includes(' at ') && !line.includes('node_modules') && !line.includes('node:internal')) {
        firstAppLine = line.trim()
          .replace(/:\d+:\d+\)?$/, ')')   // remueve :line:col del final
          .replace(/:\d+:\d+/g, '');       // y cualquiera intermedio
        break;
      }
    }
  }
  function normalize(s) {
    return String(s || '')
      .replace(/[a-f0-9]{8,}/g, '<hash>')
      .replace(/\d+/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const msgNorm = normalize(msg).slice(0, 200);
  const route = context.route || '';
  const key = [name, msgNorm, normalize(firstAppLine), route].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function create(opts = {}) {
  const MAX_ISSUES = opts.max || 200;
  const MAX_SAMPLES_PER_ISSUE = opts.maxSamples || 5;
  const issues = new Map(); // fingerprint → { firstSeen, lastSeen, count, samples, ... }

  function capture(err, context = {}) {
    const fp = fingerprint(err, context);
    let issue = issues.get(fp);
    if (!issue) {
      issue = {
        fingerprint: fp,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        count: 0,
        name: (err && err.name) || 'Error',
        message: (err && err.message) || String(err),
        samples: [],
        routes: new Set(),
      };
      issues.set(fp, issue);

      // Evict si excedemos: borrar el menos reciente
      if (issues.size > MAX_ISSUES) {
        let oldest = null;
        let oldestTs = Infinity;
        for (const [k, v] of issues) if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldest = k; }
        if (oldest) issues.delete(oldest);
      }
    }
    issue.count += 1;
    issue.lastSeen = Date.now();
    if (context.route) issue.routes.add(context.route);

    // Guarda hasta N samples (último error completo con context para debugging).
    if (issue.samples.length < MAX_SAMPLES_PER_ISSUE) {
      issue.samples.push({
        ts: new Date().toISOString(),
        stack: err && err.stack ? String(err.stack).slice(0, 2048) : null,
        context: { ...context },
      });
    }

    return fp;
  }

  function list(opts = {}) {
    const minCount = opts.minCount || 0;
    const since = opts.since || 0;
    const out = [];
    for (const issue of issues.values()) {
      if (issue.count < minCount) continue;
      if (issue.lastSeen < since) continue;
      out.push({
        fingerprint: issue.fingerprint,
        name: issue.name,
        message: issue.message,
        count: issue.count,
        firstSeen: new Date(issue.firstSeen).toISOString(),
        lastSeen: new Date(issue.lastSeen).toISOString(),
        routes: [...issue.routes],
        sampleCount: issue.samples.length,
      });
    }
    out.sort((a, b) => b.count - a.count);
    return out;
  }

  function get(fp) {
    return issues.get(fp) || null;
  }

  function clear() { issues.clear(); }

  function stats() {
    let total = 0;
    let last24hOccurrences = 0;
    let last24hIssues = 0;
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const issue of issues.values()) {
      total += issue.count;
      if (issue.lastSeen >= dayAgo) {
        last24hIssues += 1;
        last24hOccurrences += issue.count;
      }
    }
    return {
      uniqueIssues: issues.size,
      totalOccurrences: total,
      uniqueIssues_24h: last24hIssues,
      totalOccurrences_24h: last24hOccurrences,
    };
  }

  return { capture, list, get, clear, stats, fingerprint };
}

module.exports = { create };
