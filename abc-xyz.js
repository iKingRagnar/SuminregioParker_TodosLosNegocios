'use strict';

/**
 * abc-xyz.js — Clasificación ABC × XYZ del inventario
 *   GET /api/inv/abc-xyz?db=...&dias=180   → matriz cruzada
 *
 * ABC: peso por valor de venta (A=80%, B=15%, C=5%)
 * XYZ: variabilidad de demanda — coef. de variación (CV) sobre buckets semanales
 *   X = CV < 0.5  (estable, fácil de pronosticar)
 *   Y = 0.5..1.0  (variable)
 *   Z = > 1.0     (errático)
 *
 * Combinaciones útiles:
 *   AX = mantén stock alto + automatiza reorden (low risk, high value)
 *   AZ = vigilar manual, no overstock (high value, errático)
 *   CZ = candidato a liquidar (poco valor + errático)
 *   CX = mantén stock bajo, alta rotación esperada
 */

const { makeHelpers } = require('./lib/snap-helper');
const memoLib = require('./lib/memo');

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);
  // ABC-XYZ cruza window functions + variabilidad por semana sobre todo el snapshot.
  // Resultado solo cambia cuando hay snapshot nuevo (1×/día). TTL 15 min.
  const memo = memoLib.create({ ttlMs: 15 * 60 * 1000, max: 50 });

  app.get('/api/inv/abc-xyz', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const dias = Math.min(730, Math.max(60, parseInt(req.query.dias, 10) || 180));
    const memoKey = `abcxyz:${req.query.db || 'default'}:${dias}`;

    try {
      const rows = await memo.wrap(memoKey, () => all(snap, `
        WITH ventas_sku AS (
          SELECT d.ARTICULO_ID,
                 SUM(d.PRECIO_TOTAL_NETO) AS valor_total,
                 SUM(d.UNIDADES) AS unidades_total
          FROM DOCTOS_VE_DET d
          LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID
          HAVING SUM(d.PRECIO_TOTAL_NETO) > 0
        ),
        semanas AS (
          SELECT d.ARTICULO_ID,
                 date_trunc('week', h.FECHA) AS semana,
                 SUM(d.UNIDADES) AS u_sem
          FROM DOCTOS_VE_DET d
          LEFT JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
          WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
            AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
          GROUP BY d.ARTICULO_ID, date_trunc('week', h.FECHA)
        ),
        variabilidad AS (
          SELECT ARTICULO_ID,
                 AVG(u_sem) AS demanda_prom_sem,
                 STDDEV_POP(u_sem) AS sd_sem,
                 COUNT(*) AS semanas_con_venta,
                 CASE WHEN AVG(u_sem) > 0 THEN STDDEV_POP(u_sem) / AVG(u_sem) ELSE NULL END AS cv
          FROM semanas
          GROUP BY ARTICULO_ID
        ),
        clasif AS (
          SELECT v.ARTICULO_ID, v.valor_total, v.unidades_total,
                 var.demanda_prom_sem, var.cv, var.semanas_con_venta,
                 SUM(v.valor_total) OVER (ORDER BY v.valor_total DESC) AS valor_acumulado,
                 SUM(v.valor_total) OVER () AS gran_total
          FROM ventas_sku v
          LEFT JOIN variabilidad var ON var.ARTICULO_ID = v.ARTICULO_ID
        )
        SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
               c.valor_total, c.unidades_total,
               c.demanda_prom_sem, c.cv, c.semanas_con_venta,
               (c.valor_acumulado * 100.0 / c.gran_total) AS pct_acum
        FROM clasif c
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = c.ARTICULO_ID
        ORDER BY c.valor_total DESC`));

      const items = rows.map((r) => {
        const pct = Number(r.pct_acum) || 0;
        const cv = Number(r.cv);
        const abc = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
        let xyz = 'Z';
        if (isFinite(cv)) {
          if (cv < 0.5) xyz = 'X';
          else if (cv < 1.0) xyz = 'Y';
        } else {
          xyz = 'Z';
        }
        const clase = abc + xyz;
        const recomendacion = ({
          'AX': 'Stock alto + reorden automático',
          'AY': 'Stock alto con buffer extra',
          'AZ': 'Vigilancia manual, no overstockear',
          'BX': 'Reorden automático estándar',
          'BY': 'Buffer moderado',
          'BZ': 'Compra bajo demanda',
          'CX': 'Stock mínimo (alta rotación esperada)',
          'CY': 'Compra bajo demanda',
          'CZ': 'Candidato a liquidar o eliminar',
        })[clase] || '—';
        return { ...r, clase_abc: abc, clase_xyz: xyz, clase: clase, recomendacion };
      });

      // Resumen por matriz
      const matriz = {};
      let valorTotalGrupo = 0;
      items.forEach((it) => {
        matriz[it.clase] = matriz[it.clase] || { count: 0, valor: 0 };
        matriz[it.clase].count += 1;
        matriz[it.clase].valor += Number(it.valor_total) || 0;
        valorTotalGrupo += Number(it.valor_total) || 0;
      });

      res.json({
        ok: true,
        dias_analizados: dias,
        total_skus: items.length,
        valor_total: valorTotalGrupo,
        matriz,
        items: items.slice(0, 500),
      });
    } catch (e) {
      // Fallback: si DOCTO_VE_DET no enlaza con DOCTO_VE, intenta query alterna
      try {
        const rows2 = await all(snap, `
          WITH ventas_sku AS (
            SELECT d.ARTICULO_ID,
                   SUM(d.PRECIO_TOTAL_NETO) AS valor_total,
                   SUM(d.UNIDADES) AS unidades_total
            FROM DOCTOS_VE_DET d
            JOIN DOCTOS_VE h ON h.DOCTO_VE_ID = d.DOCTO_VE_ID
            WHERE h.FECHA >= CURRENT_DATE - INTERVAL ${dias} DAY
              AND (h.ESTATUS IS NULL OR h.ESTATUS <> 'C')
            GROUP BY d.ARTICULO_ID
            HAVING SUM(d.PRECIO_TOTAL_NETO) > 0
          )
          SELECT a.ARTICULO_ID, a.NOMBRE AS articulo, a.CLAVE,
                 v.valor_total, v.unidades_total
          FROM ventas_sku v
          LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = v.ARTICULO_ID
          ORDER BY v.valor_total DESC
          LIMIT 1000`);
        res.json({ ok: true, dias_analizados: dias, total_skus: rows2.length, items: rows2, advertencia: 'Modo simplificado (ABC sólo, sin XYZ): ' + e.message });
      } catch (e2) {
        res.status(500).json({ error: e.message });
      }
    }
  });

  log && log.info && log.info('abc-xyz', '✅ /api/inv/abc-xyz');
}

module.exports = { install };
