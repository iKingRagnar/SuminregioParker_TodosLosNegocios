'use strict';

/**
 * lib/snap-helper.js — Helpers compartidos para módulos que consumen DuckDB.
 *
 * Antes vivían duplicados 14 veces en analytics-deep, business-intel, churn-detector,
 * compras-semanal, abc-xyz, lead-scoring, cross-sell, prob-pago, reorden-dinamico,
 * forecast-sku, catalog-cleanup, sat-diot, wa-inbound, etc.
 *
 * Uso:
 *   const { makeHelpers } = require('./lib/snap-helper');
 *   const { getSnap, all } = makeHelpers(duckSnaps);
 *
 *   app.get('/api/x', async (req, res) => {
 *     const snap = getSnap(req);
 *     if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
 *     const rows = await all(snap, 'SELECT ...');
 *     res.json({ ok: true, rows });
 *   });
 */

function makeHelpers(duckSnaps) {
  function getSnap(req) {
    const id = String(
      (req && req.query && req.query.db) ||
      (req && req.body && req.body.db) ||
      'default'
    );
    const s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }

  function all(snap, sql, params) {
    return new Promise((resolve, reject) => {
      const cb = (err, rows) => err ? reject(err) : resolve(rows || []);
      if (params && params.length) snap.conn.all(sql, ...params, cb);
      else snap.conn.all(sql, cb);
    });
  }

  // Variante para queries que pueden fallar — devuelve [] en vez de lanzar.
  async function allSafe(snap, sql, params) {
    try { return await all(snap, sql, params); }
    catch (_) { return []; }
  }

  return { getSnap, all, allSafe };
}

module.exports = { makeHelpers };
