'use strict';

/**
 * lib/tracing.js — Request ID middleware + AsyncLocalStorage context.
 *
 * Propósito: cuando un usuario reporta "esto no jaló", queremos buscar TODOS
 * los logs de ese request en Loki/Datadog. Sin un ID común, debugging es
 * adivinar entre 100 líneas de log por timestamp.
 *
 * Provee:
 *   1. Middleware Express que asigna un request-id (X-Request-Id) por request,
 *      reutilizando el del cliente si vino del frontend (típico en
 *      service workers o agentes).
 *   2. AsyncLocalStorage para que cualquier código async dentro del request
 *      pueda obtener el ID sin pasarlo por parámetro.
 *   3. Helper para enriquecer logs automáticamente con el trace_id activo.
 *
 * Uso:
 *   const tracing = require('./lib/tracing').create({ log });
 *   app.use(tracing.middleware());
 *
 *   // Dentro de cualquier handler:
 *   const id = tracing.currentTraceId();
 *   // El logger ya pone trace_id automáticamente si se wrappea con
 *   //   tracing.wrapLogger(log)
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

function newId() {
  // 16 hex = 64 bits — suficiente para uniqueness práctica sin ser gigante en logs
  return crypto.randomBytes(8).toString('hex');
}

function create(opts = {}) {
  const log = opts.log;
  const store = new AsyncLocalStorage();
  const headerName = opts.headerName || 'x-request-id';

  function middleware() {
    return (req, res, next) => {
      // Acepta IDs del cliente (whitelist alphanumeric + dashes, max 64) o genera nuevo.
      let traceId = req.headers[headerName];
      if (typeof traceId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(traceId)) {
        // OK, reusar
      } else {
        traceId = newId();
      }
      res.setHeader('X-Request-Id', traceId);
      req.traceId = traceId;
      store.run({ traceId, startedAt: Date.now() }, () => next());
    };
  }

  function currentTraceId() {
    const ctx = store.getStore();
    return ctx ? ctx.traceId : null;
  }

  function currentContext() {
    return store.getStore() || null;
  }

  // Wrappea un logger existente para que automáticamente incluya trace_id.
  function wrapLogger(baseLog) {
    if (!baseLog) return baseLog;
    function wrap(method) {
      const orig = baseLog[method];
      if (typeof orig !== 'function') return orig;
      return function (mod, msg, extra) {
        const traceId = currentTraceId();
        if (traceId) {
          if (extra && typeof extra === 'object' && !(extra instanceof Error)) {
            extra = { ...extra, trace_id: traceId };
          } else if (extra === undefined) {
            extra = { trace_id: traceId };
          } else {
            extra = { trace_id: traceId, detail: extra };
          }
        }
        return orig.call(baseLog, mod, msg, extra);
      };
    }
    return {
      debug: wrap('debug'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
      child: baseLog.child,
      level: baseLog.level,
      format: baseLog.format,
    };
  }

  return { middleware, currentTraceId, currentContext, wrapLogger, newId };
}

module.exports = { create };
