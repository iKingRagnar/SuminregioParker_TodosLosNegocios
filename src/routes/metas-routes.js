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
const http = require('http');
const metasConfig = require('../../lib/metas-config');
const auth = require('../auth');

// Fuentes de valor REAL por meta (sólo donde el dato es confiable).
//   source: endpoint a consultar · pick(body): extrae el valor real (mismas
//   unidades que la meta) o null si no hay dato.
const MEASURABLE = {
  META_MARGEN_BRUTO_PCT: {
    source: '/api/resultados/pnl',
    pick: (b) => {
      const t = (b && b.totales) || {};
      const ventas = Number(t.VENTAS_NETAS) || 0;
      // Sin costo capturado el margen "aparente" es ~100%: no es dato real → null.
      if (!b || !b.tiene_costo || ventas <= 0) return null;
      const pct = Number(t.MARGEN_BRUTO_PCT);
      if (!isFinite(pct)) return null;
      return pct > 1.5 ? pct / 100 : pct; // normaliza 0-100 → fracción
    },
  },
  META_CARTERA_VENCIDA_PCT: {
    source: '/api/cxc/resumen-aging',
    pick: (b) => {
      const r = (b && b.resumen) || b || {};
      const tot = Number(r.SALDO_TOTAL) || 0;
      return tot > 0 ? (Number(r.VENCIDO) || 0) / tot : null;
    },
  },
  META_CUMPLIMIENTO_PEDIDOS_PCT: {
    source: '/api/ventas/cumplimiento',
    pick: (b) => {
      const v = (b && b.kpis && b.kpis.pct_cumplimiento != null) ? b.kpis.pct_cumplimiento
        : (b && b.pct_cumplimiento != null ? b.pct_cumplimiento : null);
      if (v == null || !isFinite(Number(v))) return null;
      const n = Number(v);
      return n > 1.5 ? n / 100 : n; // normaliza 0-100 → fracción
    },
  },
  META_EFICIENCIA_COBRANZA_PCT: {
    source: '/api/ventas/cobradas',
    pick: (b) => {
      const fact = Number(b && b.totalFacturado) || 0;
      const cob = Number(b && b.totalCobrado) || 0;
      return fact > 0 ? cob / fact : null; // cobrado / facturado del periodo
    },
  },
};

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

  // ── Cumplimiento: META vs REAL (delta + % alcance) por KPI ────────────────
  // Centraliza la matemática: lee las metas EDITABLES y, donde hay dato real
  // confiable, calcula delta y % de cumplimiento. Editar una meta recalcula
  // todo automáticamente (esta respuesta usa las metas vigentes).
  function fetchLocalJson(path) {
    return new Promise((resolve) => {
      const port = process.env.PORT || 7000;
      const reqL = http.request({ method: 'GET', hostname: '127.0.0.1', port, path, timeout: 20000 }, (resp) => {
        let buf = '';
        resp.on('data', (c) => { buf += c; });
        resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
      });
      reqL.on('error', () => resolve(null));
      reqL.on('timeout', () => { reqL.destroy(); resolve(null); });
      reqL.end();
    });
  }

  get('/api/metas/cumplimiento', async (req) => {
    const db = (req && req.query && req.query.db) ? String(req.query.db) : 'default';
    const metas = metasConfig.buildPayload({ numV: 1 });
    const dbq = `?db=${encodeURIComponent(db)}`;

    // Trae cada fuente real una sola vez (varias metas pueden compartir fuente).
    const sources = [...new Set(Object.values(MEASURABLE).map((m) => m.source))];
    const bodies = {};
    await Promise.all(sources.map(async (s) => { bodies[s] = await fetchLocalJson(s + dbq); }));

    const items = metasConfig.SCHEMA.map((s) => {
      const meta = metas[s.key];
      const m = MEASURABLE[s.key];
      let real = null;
      if (m && bodies[m.source]) {
        try { real = m.pick(bodies[m.source]); } catch (_) { real = null; }
      }
      const c = metasConfig.cumplimiento(s.key, real, meta);
      return {
        key: s.key, label: s.label, group: s.group, kind: s.kind, dir: s.dir,
        meta: c.meta, real: c.real, delta: c.delta, pct: c.pct,
        alcanzada: c.alcanzada, medible: !!m,
      };
    });

    return { ok: true, db, items, personalizadas: !!metas.METAS_PERSONALIZADAS, generadoEn: new Date().toISOString() };
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
