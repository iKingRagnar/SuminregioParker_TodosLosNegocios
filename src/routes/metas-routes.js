'use strict';

/**
 * src/routes/metas-routes.js — Endpoints de metas/objetivos.
 *
 * Extraído de server_corregido.js (refactor incremental por dominio). El
 * comportamiento es idéntico: las dependencias del server (helpers de DB,
 * wrapper get(), invalidación de cache) se inyectan vía install().
 *
 *   GET  /api/config/metas         → metas efectivas (default + overrides + derivadas)
 *   GET  /api/config/metas/schema  → esquema editable + overrides actuales
 *   POST /api/config/metas         → edita metas (admin), valida y persiste
 *   POST /api/config/metas/reset   → restaura estándar (admin)
 */

const express = require('express');
const metasConfig = require('../../lib/metas-config');
const auth = require('../auth');

/**
 * @param {object} deps
 *   app, get, query, normalizeDbQueryId, isAllDbs, mapPoolLimit,
 *   DATABASE_REGISTRY, getReqDbOpts, cacheInvalidate
 */
function install(deps) {
  const {
    app, get, query, normalizeDbQueryId, isAllDbs,
    mapPoolLimit, DATABASE_REGISTRY, getReqDbOpts, cacheInvalidate,
  } = deps;

  // Cache corto por base — sólo lo usan estos endpoints.
  const metasCache = new Map();

  get('/api/config/metas', async (req) => {
    const rawQ = normalizeDbQueryId(req && req.query && req.query.db) || 'default';
    const dbKey = String(rawQ).trim().toLowerCase() === '__all__' ? '__all__' : rawQ;
    const cacheHit = metasCache.get(dbKey);
    if (cacheHit && cacheHit.expireAt > Date.now()) return cacheHit.payload;

    const vendedorCountsSql = `
      SELECT COUNT(DISTINCT VENDEDOR_ID) AS NUM_VENDEDORES
      FROM DOCTOS_VE
      WHERE (
        (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
        OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
        OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
      )
      AND EXTRACT(YEAR  FROM FECHA) = EXTRACT(YEAR  FROM CURRENT_DATE)
      AND EXTRACT(MONTH FROM FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
    `;
    const activosSql = `SELECT COUNT(*) AS N FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N')`;

    async function vendedorCountsForDbo(dbo) {
      const [rows, activeRows] = await Promise.all([
        query(vendedorCountsSql, [], 30000, dbo).catch(() => [{ NUM_VENDEDORES: 0 }]),
        query(activosSql, [], 30000, dbo).catch(() => [{ N: 0 }]),
      ]);
      const numVConVenta = (rows[0] && rows[0].NUM_VENDEDORES) ? Number(rows[0].NUM_VENDEDORES) : 0;
      const numVActivos = (activeRows[0] && activeRows[0].N) ? Number(activeRows[0].N) : 0;
      return { numVConVenta, numVActivos };
    }

    let numVConVenta;
    let numVActivos;
    let numV;
    if (isAllDbs(req)) {
      const pairs = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
        try {
          return await vendedorCountsForDbo(entry.options);
        } catch (e) {
          return { numVConVenta: 0, numVActivos: 0 };
        }
      });
      numVConVenta = pairs.reduce((a, p) => a + (p.numVConVenta || 0), 0);
      numVActivos = pairs.reduce((a, p) => a + (p.numVActivos || 0), 0);
      const sumEffective = pairs.reduce(
        (acc, p) => acc + Math.max(p.numVActivos || 0, p.numVConVenta || 0),
        0,
      );
      numV = Math.max(sumEffective, 1);
    } else {
      const dbo = getReqDbOpts(req);
      const p = await vendedorCountsForDbo(dbo);
      numVConVenta = p.numVConVenta;
      numVActivos = p.numVActivos;
      numV = Math.max(numVActivos || 0, numVConVenta || 0, 1);
    }

    // Payload = metas base (default estándar + overrides de la empresa) + las
    // metas derivadas, calculadas en lib/metas-config (fuente única). Editar una
    // meta en /metas.html actualiza el archivo de overrides y se refleja aquí.
    const payload = metasConfig.buildPayload({ numV, numVActivos, numVConVenta });

    metasCache.set(dbKey, { expireAt: Date.now() + 60 * 1000, payload });
    return payload;
  });

  // ── Esquema de metas (para la UI editable) ────────────────────────────────
  get('/api/config/metas/schema', async () => {
    return { schema: metasConfig.SCHEMA, derivadas: metasConfig.DERIVED, overrides: metasConfig.loadOverrides() };
  });

  // ── Edición de metas (admin) — persiste overrides y refleja en todo el proyecto
  app.post('/api/config/metas', express.json(), auth.requireRole('admin'), (req, res) => {
    try {
      const result = metasConfig.validateMerge(req.body || {});
      if (!result.ok) return res.status(400).json({ ok: false, errors: result.errors });
      metasConfig.saveOverrides(result.overrides);
      metasCache.clear();                    // cache interno del endpoint
      cacheInvalidate('/api/config/metas');  // cache de ruta del wrapper get()
      return res.json({ ok: true, overrides: result.overrides, metas: metasConfig.buildPayload({ numV: 1 }) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Reset de metas a los valores estándar (admin) ─────────────────────────
  app.post('/api/config/metas/reset', auth.requireRole('admin'), (req, res) => {
    try {
      metasConfig.resetOverrides();
      metasCache.clear();
      cacheInvalidate('/api/config/metas');
      return res.json({ ok: true, overrides: {}, metas: metasConfig.buildPayload({ numV: 1 }) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { install };
