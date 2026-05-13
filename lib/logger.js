'use strict';

/**
 * lib/logger.js — Logger estructurado JSON con niveles + serializadores estables.
 *
 * Antes el proyecto usaba console.log/warn/error con prefijos manuales tipo
 * `log.info('module', 'msg', {...})`. Esto produce líneas humano-legibles pero
 * imposibles de parsear desde Loki/Datadog/etc.
 *
 * Este logger:
 *  - Emite JSON estructurado en producción (1 línea por evento)
 *  - Mantiene formato humano-legible en dev (NODE_ENV !== 'production')
 *  - Respeta LOG_LEVEL (debug|info|warn|error)
 *  - Trunca strings gigantes (PII / dumps) a 1KB por defecto
 *  - Redacta automáticamente headers tipo Authorization, Cookie, x-api-key
 *  - Backwards-compatible: la firma (module, msg, ...extras) ya existente sigue funcionando
 *
 * Uso:
 *   const log = require('./lib/logger').create();
 *   log.info('module', 'algo pasó', { extra: 1 });
 *   log.error('module', 'falló', e);  // serializa Error correctamente
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEYS = /^(authorization|cookie|x-api-key|x-twilio-signature|password|token|secret|api[_-]?key)$/i;
const MAX_STRING_LEN = parseInt(process.env.LOG_MAX_STR_LEN || '1024', 10);

function redact(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) + '…' : value;
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: process.env.LOG_INCLUDE_STACK !== '0' ? String(value.stack || '').slice(0, 4096) : undefined,
      code: value.code,
    };
  }
  if (Array.isArray(value)) {
    if (value.length > 50) return value.slice(0, 50).map((v) => redact(v, seen)).concat(['…+' + (value.length - 50)]);
    return value.map((v) => redact(v, seen));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (SENSITIVE_KEYS.test(k)) { out[k] = '***'; continue; }
    out[k] = redact(value[k], seen);
  }
  return out;
}

function create(opts = {}) {
  // opts.level es explícito y gana al env (env = default global; opts = override per-instance).
  const level = (opts.level || process.env.LOG_LEVEL || 'info').toLowerCase();
  const threshold = LEVELS[level] || LEVELS.info;
  const json = (opts.format || process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' || process.env.RENDER ? 'json' : 'text')).toLowerCase() === 'json';
  const baseFields = opts.base || {};

  function emit(lvl, mod, msg, extra) {
    if (LEVELS[lvl] < threshold) return;
    const event = {
      ts: new Date().toISOString(),
      level: lvl,
      module: mod,
      msg: typeof msg === 'string' ? msg : redact(msg),
      ...baseFields,
    };
    if (extra !== undefined) {
      if (extra && typeof extra === 'object' && !(extra instanceof Error)) {
        Object.assign(event, redact(extra));
      } else {
        event.detail = redact(extra);
      }
    }

    if (json) {
      const line = JSON.stringify(event);
      const out = lvl === 'error' ? process.stderr : process.stdout;
      out.write(line + '\n');
    } else {
      const colors = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
      const c = process.stdout.isTTY ? colors[lvl] || '' : '';
      const r = process.stdout.isTTY ? '\x1b[0m' : '';
      const detail = extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(redact(extra))) : '';
      const line = `${c}[${event.ts}] ${lvl.toUpperCase().padEnd(5)} [${mod}]${r} ${event.msg}${detail}`;
      const out = lvl === 'error' ? process.stderr : process.stdout;
      out.write(line + '\n');
    }
  }

  return {
    debug: (mod, msg, extra) => emit('debug', mod, msg, extra),
    info: (mod, msg, extra) => emit('info', mod, msg, extra),
    warn: (mod, msg, extra) => emit('warn', mod, msg, extra),
    error: (mod, msg, extra) => emit('error', mod, msg, extra),
    child: (extraBase) => create({ level, base: { ...baseFields, ...extraBase } }),
    level,
    format: json ? 'json' : 'text',
  };
}

module.exports = { create };
