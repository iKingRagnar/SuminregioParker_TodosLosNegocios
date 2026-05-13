'use strict';

/**
 * lib/memo.js — Cache in-memory con TTL para endpoints pesados que consumen DuckDB.
 *
 * No reemplaza `daily-cache.js` (que es para Firebird con refresh 23h México).
 * Este es para queries DuckDB cuyo resultado no cambia dentro de N segundos.
 *
 * Uso:
 *   const memo = require('./lib/memo').create({ ttlMs: 300_000, max: 200 });
 *   app.get('/api/x', async (req, res) => {
 *     const data = await memo.wrap(req.originalUrl, async () => {
 *       return await all(snap, 'SELECT ...');
 *     });
 *     res.json(data);
 *   });
 *
 * Variantes:
 *   - `wrap(key, fn)` — devuelve la promesa, comparte in-flight para evitar
 *     stampede si 10 requests llegan al mismo tiempo.
 *   - `invalidate(key)` — borra una entrada.
 *   - `clear()` — borra todo (al subir un snapshot nuevo, p.ej.).
 *   - `stats()` — hit/miss counter.
 */

function create(opts) {
  const ttl = (opts && opts.ttlMs) || 5 * 60 * 1000;
  const max = (opts && opts.max) || 500;
  const store = new Map();   // key → { ts, value }
  const inFlight = new Map(); // key → Promise
  let hits = 0;
  let misses = 0;
  let evicted = 0;

  function isFresh(entry) {
    return entry && (Date.now() - entry.ts) < ttl;
  }

  function evictLRU() {
    // Map mantiene orden de inserción: el primer key es el más viejo.
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) {
      store.delete(firstKey);
      evicted++;
    }
  }

  async function wrap(key, fn) {
    const hit = store.get(key);
    if (isFresh(hit)) {
      // refresca su posición para LRU (mover al final del Map)
      store.delete(key);
      store.set(key, hit);
      hits++;
      return hit.value;
    }
    // Stampede protection: si ya hay request en vuelo, compartirlo.
    const pending = inFlight.get(key);
    if (pending) return pending;

    misses++;
    const p = (async () => {
      try {
        const value = await fn();
        store.set(key, { ts: Date.now(), value });
        while (store.size > max) evictLRU();
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  function invalidate(key) { store.delete(key); }
  function clear() { store.clear(); }
  function stats() {
    return {
      size: store.size,
      maxSize: max,
      ttlMs: ttl,
      hits, misses, evicted,
      hitRate: hits + misses > 0 ? +(hits / (hits + misses) * 100).toFixed(1) : null,
    };
  }

  return { wrap, invalidate, clear, stats };
}

module.exports = { create };
