'use strict';

/**
 * inv-catalogo.js — Catálogo COMPLETO de artículos (clave + nombre)
 *   GET /api/inv/catalogo?db=...&limit=50000&q=texto&con_existencia=1
 *
 * A diferencia de /api/inv/reorden, /api/inv/abc-xyz o /api/bi/margen-productos
 * (que sólo devuelven artículos con venta/movimiento y con LIMIT bajo), este
 * endpoint expone TODO el catálogo ARTICULOS — incluidos productos sin venta.
 *
 * Pensado para exportaciones (PDF/Excel) y para alimentar buscadores.
 * Sólo lectura. Sin auth (mismo criterio que /api/inv/reorden y /api/inv/abc-xyz).
 *
 * Respuesta:
 *   { ok: true, total: N, productos: [ { articulo_id, clave, nombre, [existencia] } ] }
 */

const { makeHelpers } = require('./lib/snap-helper');

function install(app, { duckSnaps, log }) {
  const { getSnap, all, allSafe } = makeHelpers(duckSnaps);

  app.get('/api/inv/catalogo', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });

    const limit = Math.max(1, Math.min(100000, parseInt(req.query.limit, 10) || 50000));
    const q = String(req.query.q || '').trim();
    const conExistencia = String(req.query.con_existencia || '') === '1';

    try {
      const where = ['NOMBRE IS NOT NULL'];
      const params = [];
      if (q) {
        where.push('(UPPER(NOMBRE) LIKE ? OR UPPER(CLAVE) LIKE ?)');
        const like = '%' + q.toUpperCase() + '%';
        params.push(like, like);
      }

      const rows = await all(snap, `
        SELECT ARTICULO_ID, CLAVE, NOMBRE
        FROM ARTICULOS
        WHERE ${where.join(' AND ')}
        ORDER BY CLAVE NULLS LAST, NOMBRE
        LIMIT ${limit}`, params);

      // Existencia opcional (best-effort: si la tabla SALDOS_IN no existe, no rompe)
      let stock = null;
      if (conExistencia) {
        const srows = await allSafe(snap, `
          SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS existencia
          FROM SALDOS_IN GROUP BY ARTICULO_ID`);
        stock = new Map(srows.map((r) => [r.ARTICULO_ID, Number(r.existencia) || 0]));
      }

      const productos = rows.map((r) => ({
        articulo_id: r.ARTICULO_ID,
        clave: r.CLAVE,
        nombre: r.NOMBRE,
        ...(stock ? { existencia: stock.get(r.ARTICULO_ID) || 0 } : {}),
      }));

      res.json({ ok: true, total: productos.length, productos });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  log && log.info && log.info('inv-catalogo', '✅ /api/inv/catalogo');
}

module.exports = { install };
