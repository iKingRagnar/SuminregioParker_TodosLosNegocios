'use strict';

/**
 * cross-sell.js — Recomendador "qué más venderle a cada cliente"
 *   GET /api/cross-sell/cliente?id=NN&db=...  → top productos a recomendar a ese cliente
 *   GET /api/cross-sell/articulo?id=NN&db=... → productos frecuentemente comprados junto a este SKU
 *   GET /api/cross-sell/global?db=...         → pares con mejor lift global (market basket)
 *
 * Algoritmo (sin libs externas):
 *   - Para cliente C: encuentra clientes con productos en común (top 50 similares por
 *     overlap de catálogo). Recomienda productos que esos similares compran y C no.
 *   - Para artículo A: pares (A,B) que aparecen en el mismo docto. Ordena por lift.
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

  // ═══════════════════ Recomendaciones por cliente ═══════════════════════════
  app.get('/api/cross-sell/cliente', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const clienteId = parseInt(req.query.id, 10);
    if (!isFinite(clienteId)) return res.status(400).json({ error: 'Falta ?id=clienteId' });
    const dias = Math.min(730, Math.max(60, parseInt(req.query.dias, 10) || 365));
    const topK = Math.min(50, Math.max(3, parseInt(req.query.top, 10) || 10));

    try {
      const rows = await all(snap, `
        WITH cli_articulos AS (
          SELECT DISTINCT h.CLIENTE_ID, d.ARTICULO_ID
          FROM DOCTOS_VE h
          JOIN DOCTOS_VE_DET d ON d.DOCTO_VE_ID = h.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        ),
        target AS (
          SELECT ARTICULO_ID FROM cli_articulos WHERE CLIENTE_ID = ?
        ),
        similares AS (
          SELECT c.CLIENTE_ID, COUNT(*) AS overlap
          FROM cli_articulos c
          JOIN target t ON t.ARTICULO_ID = c.ARTICULO_ID
          WHERE c.CLIENTE_ID <> ?
          GROUP BY c.CLIENTE_ID
          ORDER BY overlap DESC
          LIMIT 50
        ),
        candidatos AS (
          SELECT ca.ARTICULO_ID, COUNT(DISTINCT ca.CLIENTE_ID) AS clientes_similares,
                 SUM(s.overlap) AS afinidad
          FROM similares s
          JOIN cli_articulos ca ON ca.CLIENTE_ID = s.CLIENTE_ID
          LEFT JOIN target t    ON t.ARTICULO_ID = ca.ARTICULO_ID
          WHERE t.ARTICULO_ID IS NULL
          GROUP BY ca.ARTICULO_ID
        ),
        valor AS (
          SELECT d.ARTICULO_ID,
                 AVG(d.PRECIO_UNITARIO) AS precio_prom,
                 SUM(d.PRECIO_TOTAL_NETO) AS valor_90d
          FROM DOCTOS_VE_DET d
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 90 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               c.clientes_similares, c.afinidad,
               v.precio_prom, v.valor_90d
        FROM candidatos c
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = c.ARTICULO_ID
        LEFT JOIN valor v     ON v.ARTICULO_ID = c.ARTICULO_ID
        WHERE v.valor_90d > 0
        ORDER BY c.afinidad DESC, v.valor_90d DESC
        LIMIT ${topK}`, [clienteId, clienteId]);

      const cliente = await all(snap, `SELECT NOMBRE FROM CLIENTES WHERE CLIENTE_ID = ?`, [clienteId]);
      res.json({
        ok: true,
        cliente_id: clienteId,
        cliente: (cliente[0] && cliente[0].NOMBRE) || null,
        dias_historia: dias,
        recomendaciones: rows.map((r, i) => ({
          rank: i + 1,
          ...r,
          razon: `${r.clientes_similares} clientes similares lo compraron`,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Recomendaciones por artículo (basket) ═════════════════
  app.get('/api/cross-sell/articulo', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const articuloId = parseInt(req.query.id, 10);
    if (!isFinite(articuloId)) return res.status(400).json({ error: 'Falta ?id=articuloId' });
    const dias = Math.min(730, Math.max(60, parseInt(req.query.dias, 10) || 365));
    const topK = Math.min(50, Math.max(3, parseInt(req.query.top, 10) || 10));

    try {
      const rows = await all(snap, `
        WITH doctos_con_target AS (
          SELECT DISTINCT h.DOCTO_VE_ID
          FROM DOCTOS_VE h
          JOIN DOCTOS_VE_DET d ON d.DOCTO_VE_ID = h.DOCTO_VE_ID
          WHERE d.ARTICULO_ID = ?
            AND h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        ),
        co_articulos AS (
          SELECT d.ARTICULO_ID, COUNT(*) AS coocurrencias
          FROM doctos_con_target t
          JOIN DOCTOS_VE_DET d ON d.DOCTO_VE_ID = t.DOCTO_VE_ID
          WHERE d.ARTICULO_ID <> ?
          GROUP BY d.ARTICULO_ID
          HAVING COUNT(*) >= 2
        ),
        totales AS (
          SELECT d.ARTICULO_ID, COUNT(DISTINCT d.DOCTO_VE_ID) AS apariciones
          FROM DOCTOS_VE_DET d
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID
        ),
        target_total AS (
          SELECT COUNT(*) AS n FROM doctos_con_target
        ),
        univ AS (
          SELECT COUNT(DISTINCT h.DOCTO_VE_ID) AS n FROM DOCTOS_VE h
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               co.coocurrencias,
               t.apariciones,
               tt.n AS doctos_target,
               u.n AS doctos_total,
               -- lift = P(A∩B) / (P(A)·P(B))
               (co.coocurrencias::DOUBLE * u.n) / NULLIF(t.apariciones * tt.n, 0) AS lift,
               -- confidence = P(B|A) = co / target_total
               (co.coocurrencias::DOUBLE / NULLIF(tt.n, 0)) AS confidence
        FROM co_articulos co
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = co.ARTICULO_ID
        LEFT JOIN totales t   ON t.ARTICULO_ID = co.ARTICULO_ID
        CROSS JOIN target_total tt
        CROSS JOIN univ u
        WHERE t.apariciones > 0
        ORDER BY lift DESC, co.coocurrencias DESC
        LIMIT ${topK}`, [articuloId, articuloId]);

      const articulo = await all(snap, `SELECT NOMBRE, CLAVE FROM ARTICULOS WHERE ARTICULO_ID = ?`, [articuloId]);
      res.json({
        ok: true,
        articulo_id: articuloId,
        articulo: articulo[0] || null,
        relacionados: rows.map((r, i) => ({
          rank: i + 1,
          ...r,
          lift: Number(r.lift).toFixed(2),
          confidence_pct: r.confidence != null ? +(r.confidence * 100).toFixed(1) : null,
        })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Reglas globales ═══════════════════════════════════════
  app.get('/api/cross-sell/global', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const minSoporte = Math.max(5, parseInt(req.query.min_soporte, 10) || 10);

    try {
      const rows = await all(snap, `
        WITH pares AS (
          SELECT LEAST(a.ARTICULO_ID, b.ARTICULO_ID) AS a_id,
                 GREATEST(a.ARTICULO_ID, b.ARTICULO_ID) AS b_id,
                 COUNT(*) AS n
          FROM DOCTOS_VE_DET a
          JOIN DOCTOS_VE_DET b ON b.DOCTO_VE_ID = a.DOCTO_VE_ID AND a.ARTICULO_ID < b.ARTICULO_ID
          JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = a.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL 365 DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY 1, 2
          HAVING COUNT(*) >= ${minSoporte}
        )
        SELECT a.NOMBRE AS articulo_a, ar.CLAVE AS clave_a,
               b.NOMBRE AS articulo_b, br.CLAVE AS clave_b,
               p.n AS coocurrencias
        FROM pares p
        LEFT JOIN ARTICULOS a  ON a.ARTICULO_ID = p.a_id
        LEFT JOIN ARTICULOS ar ON ar.ARTICULO_ID = p.a_id
        LEFT JOIN ARTICULOS b  ON b.ARTICULO_ID = p.b_id
        LEFT JOIN ARTICULOS br ON br.ARTICULO_ID = p.b_id
        ORDER BY p.n DESC
        LIMIT 100`);
      res.json({ ok: true, min_soporte: minSoporte, pares: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('cross-sell', '✅ /api/cross-sell/{cliente,articulo,global}');
}

module.exports = { install };
