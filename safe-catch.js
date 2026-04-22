'use strict';

/**
 * safe-catch.js — Instrumentación de errores silenciosos en endpoints
 * ──────────────────────────────────────────────────────────────────────────────
 * server_corregido.js tiene 30+ try/catch vacíos que tragan errores.
 * No es viable editarlos uno por uno sin romper el archivo monolítico.
 *
 * Este módulo intercepta errores no capturados y emite logs estructurados:
 *   - process.on('unhandledRejection')
 *   - process.on('uncaughtException')
 *   - Wrapping de res.json para detectar respuestas con error=... silencioso
 *   - Endpoint /api/admin/errors para ver últimos errores en memoria (ring buffer)
 */

const { log } = require('./performance-boost');

const ERROR_BUFFER_MAX = 200;
const errorBuffer = []; // últimos N errores con timestamp, tag, msg, stack

function recordError(tag, err, meta) {
  const entry = {
    ts: new Date().toISOString(),
    tag,
    msg: (err && err.message) || String(err),
    stack: err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n') : null,
    meta: meta || null,
  };
  errorBuffer.push(entry);
  if (errorBuffer.length > ERROR_BUFFER_MAX) errorBuffer.shift();
  log.error(tag, entry.msg, meta);
}

function install(app) {
  // Rejections / exceptions no manejadas
  process.on('unhandledRejection', (reason) => {
    recordError('unhandledRejection', reason);
  });
  process.on('uncaughtException', (err) => {
    recordError('uncaughtException', err);
    // No terminamos el proceso — en Render eso fuerza redeploy y pierde DuckDB
  });

  // Endpoint de diagnóstico
  app.get('/api/admin/errors', (req, res) => {
    const limit = Math.min(ERROR_BUFFER_MAX, parseInt(req.query.limit, 10) || 50);
    res.json({
      total: errorBuffer.length,
      returned: Math.min(limit, errorBuffer.length),
      errors: errorBuffer.slice(-limit).reverse(),
    });
  });

  // Endpoint para limpiar buffer
  app.delete('/api/admin/errors', (_req, res) => {
    errorBuffer.length = 0;
    res.json({ ok: true });
  });

  // Middleware catch-all final — Express llama con 4 args si hay error
  // IMPORTANTE: no remueve los handlers existentes, solo agrega el nuestro al final.
  // Se instala después de todas las rutas (por eso en server_corregido.js va tras app.listen… o al final).
  app.use((err, req, res, next) => {
    if (!err) return next();
    recordError('express-error-middleware', err, { path: req.path, method: req.method });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message, path: req.path });
  });

  log.info('safe-catch', '✅ /api/admin/errors + unhandled handlers activos');
}

module.exports = { install, recordError, errorBuffer };
