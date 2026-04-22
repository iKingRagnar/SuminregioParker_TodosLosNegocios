'use strict';

/**
 * observability.js — Métricas propias del servidor
 *   GET /api/metrics       → requests/s, latencia p50/p95/p99, errores, por endpoint
 *   GET /api/metrics/slow  → top 20 endpoints más lentos
 *   GET /api/metrics/freshness → alerta si snapshots están viejos
 */

function install(app, { duckSnaps, log }) {
  const metrics = new Map(); // path → { count, sum, errors, samples: [] }

  const MAX_SAMPLES = 200;

  function rec(path, durationMs, isError) {
    if (!metrics.has(path)) metrics.set(path, { count: 0, sum: 0, errors: 0, samples: [] });
    const m = metrics.get(path);
    m.count++;
    m.sum += durationMs;
    if (isError) m.errors++;
    m.samples.push(durationMs);
    if (m.samples.length > MAX_SAMPLES) m.samples.shift();
  }

  // Middleware de timing
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    const t0 = Date.now();
    res.on('finish', () => {
      const d = Date.now() - t0;
      const key = req.method + ' ' + req.path.split('?')[0];
      rec(key, d, res.statusCode >= 500);
    });
    next();
  });

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p)];
  }

  app.get('/api/metrics', (_req, res) => {
    const out = [];
    for (const [path, m] of metrics) {
      out.push({
        path,
        count: m.count,
        errors: m.errors,
        error_rate_pct: m.count > 0 ? +((m.errors * 100) / m.count).toFixed(2) : 0,
        avg_ms: m.count > 0 ? +(m.sum / m.count).toFixed(1) : 0,
        p50_ms: percentile(m.samples, 0.5),
        p95_ms: percentile(m.samples, 0.95),
        p99_ms: percentile(m.samples, 0.99),
      });
    }
    out.sort((a, b) => b.count - a.count);
    res.json({
      ok: true,
      total_endpoints: out.length,
      total_requests: out.reduce((s, m) => s + m.count, 0),
      total_errors: out.reduce((s, m) => s + m.errors, 0),
      endpoints: out.slice(0, 100),
    });
  });

  app.get('/api/metrics/slow', (_req, res) => {
    const out = [];
    for (const [path, m] of metrics) {
      if (m.count < 3) continue; // ruido
      out.push({ path, count: m.count, avg_ms: +(m.sum / m.count).toFixed(1), p95_ms: percentile(m.samples, 0.95) });
    }
    out.sort((a, b) => b.p95_ms - a.p95_ms);
    res.json({ ok: true, top_slow: out.slice(0, 20) });
  });

  app.get('/api/metrics/freshness', (_req, res) => {
    const fs = require('fs');
    const warnHours = parseFloat(process.env.FRESHNESS_WARN_H) || 30;
    const alertHours = parseFloat(process.env.FRESHNESS_ALERT_H) || 48;
    const now = Date.now();
    const list = [];
    duckSnaps.forEach((snap, id) => {
      try {
        const st = fs.statSync(snap.path);
        const ageH = (now - st.mtime.getTime()) / 3600_000;
        let status = 'ok';
        if (ageH > alertHours) status = 'alert';
        else if (ageH > warnHours) status = 'warn';
        list.push({ dbId: id, ageHours: +ageH.toFixed(1), status, path: snap.path });
      } catch (_) {}
    });
    const anyAlert = list.some((s) => s.status === 'alert');
    res.json({ ok: !anyAlert, warnHours, alertHours, snapshots: list });
  });

  log.info('observability', '✅ /api/metrics, /api/metrics/slow, /api/metrics/freshness');
}

module.exports = { install };
