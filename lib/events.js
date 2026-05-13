'use strict';

/**
 * lib/events.js — Event bus global del proceso (EventEmitter singleton).
 *
 * Permite que módulos publiquen eventos sin acoplarse. Ejemplo principal:
 * snapshot.loaded — cuando se carga un .duckdb nuevo, los módulos que tienen
 * memo cache (analytics-deep, abc-xyz, etc.) escuchan y limpian.
 *
 * Eventos estándar:
 *   snapshot.loaded   { dbId, meta, path }
 *   snapshot.unloaded { dbId }
 *   cron.fired        { name, hour }
 *   ai.tool_called    { name, dbId, duration_ms }
 *
 * Uso:
 *   const events = require('./lib/events');
 *   events.on('snapshot.loaded', ({ dbId }) => memo.clear());
 *   events.emit('snapshot.loaded', { dbId: 'default', meta });
 */

const { EventEmitter } = require('events');

// Singleton — el módulo retorna SIEMPRE la misma instancia.
const bus = new EventEmitter();
// Subir el max para evitar warnings cuando muchos módulos escuchan el mismo evento.
bus.setMaxListeners(50);

module.exports = bus;
