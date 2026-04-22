'use strict';

/**
 * src/routes/ventas-example.js — Ejemplo de extracción del monolito
 *
 * Muestra cómo mover endpoints de server_corregido.js a módulos separados.
 * Este archivo NO se registra por default — es referencia para la migración gradual.
 *
 * Plan de migración (ver ARCHITECTURE.md):
 *   1. Extraer un módulo (ej. ventas) a src/routes/ventas.js
 *   2. Agregar require en server_corregido.js con flag env (ej. USE_NEW_VENTAS=1)
 *   3. Testear con el flag on, comparar contra monolito
 *   4. Cuando esté estable, eliminar el bloque viejo del monolito
 *   5. Repetir con cxc, inv, resultados, etc.
 *
 * Uso:
 *   const { install } = require('./src/routes/ventas-example');
 *   install(app, { query, getReqDbOpts, log });
 */

function install(app, { query, getReqDbOpts, log }) {
  // ── GET /api/ventas/resumen-v2 (ejemplo, no pisa /api/ventas/resumen original) ──
  app.get('/api/ventas/resumen-v2', async (req, res) => {
    const dbo = getReqDbOpts(req);
    try {
      const hoyRow = await query(
        `SELECT COALESCE(SUM(IMPORTE_NETO), 0) AS total
         FROM DOCTOS_VE
         WHERE FECHA = CURRENT_DATE
           AND (ESTATUS IS NULL OR ESTATUS <> 'C')`,
        [], 12000, dbo
      );
      const mesRow = await query(
        `SELECT COALESCE(SUM(IMPORTE_NETO), 0) AS total,
                COUNT(*) AS docs
         FROM DOCTOS_VE
         WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE)
           AND (ESTATUS IS NULL OR ESTATUS <> 'C')`,
        [], 12000, dbo
      );

      res.json({
        HOY:          Number(hoyRow[0]?.total) || 0,
        MES_ACTUAL:   Number(mesRow[0]?.total) || 0,
        FACTURAS_MES: Number(mesRow[0]?.docs) || 0,
        _source: 'ventas-example.js (extracted from monolith)',
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  log && log.info && log.info('routes-ventas', 'ejemplo extraído → /api/ventas/resumen-v2');
}

module.exports = { install };
