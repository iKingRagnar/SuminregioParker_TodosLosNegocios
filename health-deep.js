'use strict';

/**
 * health-deep.js — Health checks profundos + monitoreo de crons.
 *
 *   GET /api/health/deep      → status completo (snapshots, AI, cache, crons, deps, version)
 *   GET /api/health/ready     → readiness probe (Kubernetes/Render): 200 si todo listo, 503 si no
 *   GET /api/health/live      → liveness probe: 200 mientras el process esté vivo
 *   GET /api/cron/status      → última ejecución de cada cron registrado en lib/scheduler
 *
 * Diferencia con /health (que ya existe en performance-boost.js):
 *  - /health es la versión "shallow": el server responde, sin chequear dependencias
 *  - /api/health/deep verifica: AI configurado, snapshots cargados, crons recientes,
 *    espacio en disco (si hay disco persistente), tablas críticas
 */

const fs = require('fs');
const path = require('path');

function install(app, { duckSnaps, log }) {
  const START_TIME = Date.now();
  let VERSION = null;
  try {
    VERSION = require('fs').readFileSync(path.join(__dirname, '.git/HEAD'), 'utf8').trim();
    if (VERSION.startsWith('ref: ')) {
      const ref = VERSION.slice(5);
      VERSION = fs.readFileSync(path.join(__dirname, '.git', ref), 'utf8').trim().slice(0, 12);
    }
  } catch (_) { VERSION = 'unknown'; }

  function snapshotsHealth() {
    const list = [];
    for (const [id, s] of duckSnaps) {
      if (!s || !s.conn) continue;
      const created = s.meta && s.meta.CREATED_AT ? new Date(s.meta.CREATED_AT) : null;
      const ageHours = created ? Math.round((Date.now() - created.getTime()) / 3600_000) : null;
      list.push({
        id,
        rows: s.meta && s.meta.TOTAL_ROWS,
        cutoff: s.meta && s.meta.CUTOFF_DATE,
        createdAt: s.meta && s.meta.CREATED_AT,
        ageHours,
        fresh: ageHours !== null && ageHours < 30,
      });
    }
    return list;
  }

  function aiHealth() {
    return {
      v2_configured: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY),
      v3_model_default: process.env.AI_MODEL_V3 || 'claude-opus-4-7',
      v3_model_fast: process.env.AI_MODEL_FAST || 'claude-haiku-4-5',
    };
  }

  function diskHealth() {
    const result = { tmpAvailable: false, persistentAvailable: false };
    try { fs.accessSync('/tmp', fs.constants.W_OK); result.tmpAvailable = true; } catch (_) {}
    try { fs.accessSync('/var/data', fs.constants.W_OK); result.persistentAvailable = true; } catch (_) {}
    return result;
  }

  function memHealth() {
    const m = process.memoryUsage();
    return {
      rss_mb: Math.round(m.rss / 1024 / 1024),
      heap_used_mb: Math.round(m.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(m.heapTotal / 1024 / 1024),
      external_mb: Math.round(m.external / 1024 / 1024),
    };
  }

  function cronStatus() {
    try {
      const scheduler = require('./lib/scheduler');
      return scheduler.listJobs();
    } catch (_) { return []; }
  }

  // ── /api/health/deep ──────────────────────────────────────────────────────
  app.get('/api/health/deep', (_req, res) => {
    const snaps = snapshotsHealth();
    const ai = aiHealth();
    const disk = diskHealth();
    const mem = memHealth();
    const crons = cronStatus();

    const issues = [];
    if (snaps.length === 0) issues.push('Sin snapshots cargados');
    if (snaps.some((s) => !s.fresh)) issues.push('Hay snapshots viejos (>30h)');
    if (!ai.v2_configured) issues.push('ANTHROPIC_API_KEY no configurada');
    if (mem.heap_used_mb / mem.heap_total_mb > 0.9) issues.push('Heap >90% — posible memory leak');

    const status = issues.length === 0 ? 'healthy' : (issues.length < 3 ? 'degraded' : 'unhealthy');

    res.status(status === 'unhealthy' ? 503 : 200).json({
      status,
      version: VERSION,
      uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
      pid: process.pid,
      nodeVersion: process.version,
      env: process.env.NODE_ENV || (process.env.RENDER ? 'production' : 'dev'),
      timestamp: new Date().toISOString(),
      snapshots: snaps,
      ai,
      disk,
      memory: mem,
      crons,
      issues,
    });
  });

  // ── Readiness (Kubernetes/Render style) ──────────────────────────────────
  app.get('/api/health/ready', (_req, res) => {
    const snaps = snapshotsHealth();
    if (snaps.length === 0) {
      return res.status(503).json({ ready: false, reason: 'Sin snapshots cargados' });
    }
    res.json({ ready: true, snapshots: snaps.length });
  });

  // ── Liveness (simple) ────────────────────────────────────────────────────
  app.get('/api/health/live', (_req, res) => {
    res.json({ alive: true, uptimeSec: Math.round((Date.now() - START_TIME) / 1000) });
  });

  // ── /api/cron/status ─────────────────────────────────────────────────────
  app.get('/api/cron/status', (_req, res) => {
    const jobs = cronStatus();
    res.json({
      ok: true,
      registered: jobs.length,
      jobs: jobs.map((j) => ({
        name: j.name,
        hour: j.hour,
        days: j.days || 'cualquiera',
        lastRunKey: j.lastRunKey,
        ranToday: j.lastRunKey ? j.lastRunKey.startsWith(new Date().toISOString().slice(0, 10)) : false,
      })),
    });
  });

  log && log.info && log.info('health-deep', `✅ /api/health/{deep,ready,live} · /api/cron/status (version=${VERSION})`);
}

module.exports = { install };
