'use strict';

/**
 * catalog-cleanup.js — Detección de inconsistencias en catálogos
 *   GET /api/catalogos/duplicados/articulos?db=...   → SKUs con nombre/clave casi idéntico
 *   GET /api/catalogos/duplicados/clientes?db=...    → clientes potencialmente duplicados
 *   GET /api/catalogos/precios-inconsistentes?db=... → SKUs con precio muy variable
 *   GET /api/catalogos/articulos-sin-venta?db=...    → SKUs sin movimiento en N días
 *   GET /api/catalogos/clientes-sin-rfc?db=...       → CFDI bloqueado por falta de RFC válido
 *
 * Sin libs externas. Usa SQL puro de DuckDB + heurísticas simples.
 */

function install(app, { duckSnaps, log }) {
  function getSnap(req) {
    const id = String((req.query && req.query.db) || 'default');
    const s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }
  function all(snap, sql, params) {
    return new Promise((res, rej) => snap.conn.all(sql, ...(params || []), (err, rows) => err ? rej(err) : res(rows || [])));
  }

  // Normaliza nombre: mayúsculas, sin acentos, sin caracteres especiales, sin números intermedios
  function norm(s) {
    return String(s || '')
      .toUpperCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ═══════════════════ Duplicados de artículos ═══════════════════════════════
  app.get('/api/catalogos/duplicados/articulos', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      const rows = await all(snap, `SELECT ARTICULO_ID, NOMBRE, CLAVE FROM ARTICULOS WHERE NOMBRE IS NOT NULL LIMIT 50000`);
      // Agrupa por nombre normalizado
      const byKey = new Map();
      rows.forEach((r) => {
        const k = norm(r.NOMBRE);
        if (k.length < 3) return;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
      });
      const grupos = [];
      byKey.forEach((items, k) => {
        if (items.length >= 2) grupos.push({ key: k, count: items.length, items: items.slice(0, 10) });
      });
      grupos.sort((a, b) => b.count - a.count);

      // Claves duplicadas (raro pero pasa)
      const claves = new Map();
      rows.forEach((r) => {
        if (!r.CLAVE) return;
        const cv = String(r.CLAVE).trim().toUpperCase();
        if (!claves.has(cv)) claves.set(cv, []);
        claves.get(cv).push({ ARTICULO_ID: r.ARTICULO_ID, NOMBRE: r.NOMBRE, CLAVE: r.CLAVE });
      });
      const claveDup = [];
      claves.forEach((items) => { if (items.length >= 2) claveDup.push(items); });

      res.json({
        ok: true,
        total_articulos: rows.length,
        grupos_nombre_similar: grupos.slice(0, 200),
        claves_duplicadas: claveDup.slice(0, 100),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Duplicados de clientes ════════════════════════════════
  app.get('/api/catalogos/duplicados/clientes', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      // Detecta columnas RFC, EMAIL, TELEFONO si existen
      const cols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'CLIENTES'`).catch(() => []);
      const colNames = new Set(cols.map((c) => c.n));
      const selectExtra = ['CLIENTE_ID', 'NOMBRE',
        colNames.has('RFC') ? 'RFC' : `NULL AS RFC`,
        colNames.has('EMAIL') ? 'EMAIL' : `NULL AS EMAIL`,
        colNames.has('TELEFONO1') ? 'TELEFONO1' : (colNames.has('TELEFONO') ? 'TELEFONO' : `NULL AS TELEFONO1`),
      ].join(', ');

      const rows = await all(snap, `SELECT ${selectExtra} FROM CLIENTES WHERE NOMBRE IS NOT NULL LIMIT 30000`);

      const byNombre = new Map();
      const byRFC = new Map();
      rows.forEach((r) => {
        const k = norm(r.NOMBRE);
        if (k.length >= 3) {
          if (!byNombre.has(k)) byNombre.set(k, []);
          byNombre.get(k).push(r);
        }
        if (r.RFC) {
          const rfc = String(r.RFC).trim().toUpperCase();
          if (rfc.length >= 12) {
            if (!byRFC.has(rfc)) byRFC.set(rfc, []);
            byRFC.get(rfc).push(r);
          }
        }
      });

      const dupNombre = [];
      byNombre.forEach((items, k) => { if (items.length >= 2) dupNombre.push({ key: k, items: items.slice(0, 10), count: items.length }); });
      dupNombre.sort((a, b) => b.count - a.count);

      const dupRFC = [];
      byRFC.forEach((items, rfc) => { if (items.length >= 2) dupRFC.push({ rfc, items: items.slice(0, 10), count: items.length }); });

      res.json({
        ok: true,
        total_clientes: rows.length,
        duplicados_por_nombre: dupNombre.slice(0, 200),
        duplicados_por_rfc: dupRFC,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Precios inconsistentes ════════════════════════════════
  app.get('/api/catalogos/precios-inconsistentes', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      // SKUs con CV > 0.3 en precio unitario (mismo SKU se cotiza a precios muy distintos)
      const rows = await all(snap, `
        WITH precios AS (
          SELECT d.ARTICULO_ID,
                 AVG(d.PRECIO_UNITARIO) AS precio_prom,
                 STDDEV_POP(d.PRECIO_UNITARIO) AS precio_sd,
                 MIN(d.PRECIO_UNITARIO) AS precio_min,
                 MAX(d.PRECIO_UNITARIO) AS precio_max,
                 COUNT(*) AS ventas_n
          FROM DOCTOS_VE_DET d
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 180 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
            AND d.PRECIO_UNITARIO > 0
          GROUP BY d.ARTICULO_ID
          HAVING COUNT(*) >= 5
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               p.precio_prom, p.precio_sd, p.precio_min, p.precio_max, p.ventas_n,
               (p.precio_sd / NULLIF(p.precio_prom, 0)) AS cv_precio,
               ((p.precio_max - p.precio_min) / NULLIF(p.precio_min, 0)) AS rango_relativo
        FROM precios p
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = p.ARTICULO_ID
        WHERE (p.precio_sd / NULLIF(p.precio_prom, 0)) > 0.3
        ORDER BY cv_precio DESC
        LIMIT 200`);
      res.json({ ok: true, total: rows.length, items: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Artículos sin venta ═══════════════════════════════════
  app.get('/api/catalogos/articulos-sin-venta', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const dias = Math.min(720, Math.max(30, parseInt(req.query.dias, 10) || 180));
    try {
      const rows = await all(snap, `
        WITH vendidos AS (
          SELECT DISTINCT d.ARTICULO_ID
          FROM DOCTOS_VE_DET d
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        ),
        stock AS (
          SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS existencia
          FROM SALDOS_IN GROUP BY ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               COALESCE(s.existencia, 0) AS existencia
        FROM ARTICULOS a
        LEFT JOIN stock s ON s.ARTICULO_ID = a.ARTICULO_ID
        WHERE a.ARTICULO_ID NOT IN (SELECT ARTICULO_ID FROM vendidos)
          AND COALESCE(s.existencia, 0) > 0
        ORDER BY COALESCE(s.existencia, 0) DESC
        LIMIT 500`);
      res.json({ ok: true, dias_umbral: dias, total: rows.length, items: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Clientes sin RFC válido ═══════════════════════════════
  app.get('/api/catalogos/clientes-sin-rfc', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      const cols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'CLIENTES'`).catch(() => []);
      const colNames = new Set(cols.map((c) => c.n));
      if (!colNames.has('RFC')) return res.json({ ok: true, total: 0, items: [], reason: 'Tabla CLIENTES sin columna RFC' });

      const rows = await all(snap, `
        SELECT c.CLIENTE_ID, c.NOMBRE, c.RFC,
               COUNT(d.DOCTO_VE_ID) AS facturas_12m,
               SUM(d.IMPORTE_NETO) AS ventas_12m
        FROM CLIENTES c
        LEFT JOIN DOCTOS_VE d ON d.CLIENTE_ID = c.CLIENTE_ID
          AND d.FECHA >= CURRENT_DATE - INTERVAL 365 DAY
          AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C')
        WHERE (c.RFC IS NULL OR TRIM(c.RFC) = '' OR LENGTH(TRIM(c.RFC)) < 12)
        GROUP BY c.CLIENTE_ID, c.NOMBRE, c.RFC
        HAVING SUM(d.IMPORTE_NETO) > 0
        ORDER BY ventas_12m DESC
        LIMIT 500`);

      // Valida formato SAT: persona física 13 chars, moral 12 chars
      const SAT_RX = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{2,3}$/;
      const items = rows.map((r) => ({
        ...r,
        razon: !r.RFC ? 'Sin RFC' :
               !SAT_RX.test(String(r.RFC).trim().toUpperCase()) ? 'Formato RFC inválido' :
               'RFC corto',
      }));

      res.json({ ok: true, total: items.length, items });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('catalog-cleanup', '✅ /api/catalogos/{duplicados/*, precios-inconsistentes, articulos-sin-venta, clientes-sin-rfc}');
}

module.exports = { install };
