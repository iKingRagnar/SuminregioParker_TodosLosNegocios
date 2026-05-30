'use strict';

/**
 * prob-pago.js — Score de probabilidad de pago por cliente
 *   GET /api/cxc/prob-pago?db=...&min=0           → score por cliente con CxC abierto
 *   GET /api/cxc/prob-pago/cliente?id=NN&db=...   → desglose explicable de un cliente
 *
 * Modelo (combinación de señales históricas, 0-100):
 *   - DSO histórico vs términos pactados   (peso fuerte)
 *   - % facturas pagadas a tiempo en 12m   (peso fuerte)
 *   - Edad promedio actual de su CxC       (negativo si > 30)
 *   - Concentración: si su saldo abierto es muy alto vs su ticket histórico → riesgo
 *   - Antigüedad como cliente              (clientes viejos confiables → bonus)
 */

const { makeHelpers } = require('./lib/snap-helper');
const memoLib = require('./lib/memo');

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);
  // prob-pago: 4 CTEs sobre histórico de pagos. TTL 15 min.
  const memo = memoLib.create({ ttlMs: 15 * 60 * 1000, max: 50 });

  async function computeScores(snap, minSaldo) {
    // Agregamos historia 12m + posición actual por cliente.
    // IMPORTES_DOCTOS_CC: IMPORTE>0 = cargo, IMPORTE<0 = pago/abono.
    return all(snap, `
      WITH cargos_12m AS (
        SELECT CLIENTE_ID, DOCTO_CC_ID, FECHA, IMPORTE AS monto_cargo
        FROM IMPORTES_DOCTOS_CC
        WHERE IMPORTE > 0
          AND FECHA >= CURRENT_DATE - INTERVAL 365 DAY
      ),
      pagos_12m AS (
        SELECT DOCTO_CC_ID, MIN(FECHA) AS f_primer_pago, SUM(-IMPORTE) AS total_pagado
        FROM IMPORTES_DOCTOS_CC
        WHERE IMPORTE < 0
          AND FECHA >= CURRENT_DATE - INTERVAL 365 DAY
        GROUP BY DOCTO_CC_ID
      ),
      pareados AS (
        SELECT c.CLIENTE_ID, c.DOCTO_CC_ID, c.FECHA AS f_cargo, c.monto_cargo,
               p.f_primer_pago,
               CASE WHEN p.f_primer_pago IS NULL THEN NULL
                    ELSE DATE_DIFF('day', c.FECHA, p.f_primer_pago) END AS dias_pago
        FROM cargos_12m c
        LEFT JOIN pagos_12m p ON p.DOCTO_CC_ID = c.DOCTO_CC_ID
      ),
      hist AS (
        SELECT CLIENTE_ID,
               COUNT(*) AS cargos_12m,
               AVG(dias_pago) AS dso,
               AVG(CASE WHEN dias_pago IS NULL THEN 0
                        WHEN dias_pago <= 30 THEN 1 ELSE 0 END) AS pct_a_tiempo,
               SUM(monto_cargo) AS gastado_12m,
               AVG(monto_cargo) AS ticket_prom
        FROM pareados
        GROUP BY CLIENTE_ID
      ),
      saldo_actual AS (
        -- WHERE FECHA acota el scan: facturas con saldo abierto >365 días son ya
        -- castigos contables; no aportan al score y disparaban FULL SCAN.
        SELECT CLIENTE_ID,
               SUM(IMPORTE) AS saldo_abierto,
               MAX(CASE WHEN IMPORTE > 0 THEN DATE_DIFF('day', FECHA, CURRENT_DATE) END) AS max_edad,
               AVG(CASE WHEN IMPORTE > 0 THEN DATE_DIFF('day', FECHA, CURRENT_DATE) END) AS edad_promedio
        FROM IMPORTES_DOCTOS_CC
        WHERE FECHA >= CURRENT_DATE - INTERVAL 730 DAY
        GROUP BY CLIENTE_ID
        HAVING SUM(IMPORTE) >= ${minSaldo}
      ),
      antiguedad AS (
        SELECT CLIENTE_ID, MIN(FECHA) AS primer_compra
        FROM DOCTOS_VE
        WHERE (ESTATUS IS NULL OR ESTATUS <> 'C')
        GROUP BY CLIENTE_ID
      )
      SELECT c.NOMBRE AS cliente, sa.CLIENTE_ID,
             sa.saldo_abierto, sa.max_edad, sa.edad_promedio,
             h.cargos_12m, h.dso, h.pct_a_tiempo, h.gastado_12m, h.ticket_prom,
             ant.primer_compra::VARCHAR AS antiguedad_desde
      FROM saldo_actual sa
      LEFT JOIN hist h        ON h.CLIENTE_ID = sa.CLIENTE_ID
      LEFT JOIN CLIENTES c    ON c.CLIENTE_ID = sa.CLIENTE_ID
      LEFT JOIN antiguedad ant ON ant.CLIENTE_ID = sa.CLIENTE_ID
      ORDER BY sa.saldo_abierto DESC`);
  }

  function scoreRow(r) {
    const dso = Number(r.dso);
    const pctAt = Number(r.pct_a_tiempo);
    const maxEdad = Number(r.max_edad) || 0;
    const saldo = Number(r.saldo_abierto) || 0;
    const ticket = Number(r.ticket_prom) || 0;
    const cargosN = Number(r.cargos_12m) || 0;
    const primer = r.antiguedad_desde ? new Date(r.antiguedad_desde) : null;
    const antMeses = primer ? Math.max(0, (Date.now() - primer.getTime()) / (30 * 86400_000)) : 0;

    // Empieza en 60 (neutral)
    let s = 60;
    const factores = {};

    // DSO: a tiempo (<30d) = +20; lento (>60d) = -25
    if (isFinite(dso) && cargosN >= 3) {
      if (dso <= 30) { s += 20; factores.dso = '+20 (DSO≤30d)'; }
      else if (dso <= 45) { s += 10; factores.dso = '+10 (DSO 30-45d)'; }
      else if (dso <= 60) { s -= 5; factores.dso = '-5 (DSO 45-60d)'; }
      else if (dso <= 90) { s -= 15; factores.dso = '-15 (DSO 60-90d)'; }
      else { s -= 25; factores.dso = '-25 (DSO >90d)'; }
    } else {
      factores.dso = 'sin historia';
    }

    // % pagados a tiempo
    if (isFinite(pctAt) && cargosN >= 3) {
      const bonus = Math.round((pctAt - 0.5) * 30); // -15..+15
      s += bonus;
      factores.pct_a_tiempo = (bonus >= 0 ? '+' : '') + bonus + ` (${Math.round(pctAt * 100)}% a tiempo)`;
    }

    // Edad CxC actual
    if (maxEdad > 90) { s -= 20; factores.edad = '-20 (>90d vencido)'; }
    else if (maxEdad > 60) { s -= 12; factores.edad = '-12 (>60d)'; }
    else if (maxEdad > 30) { s -= 5; factores.edad = '-5 (>30d)'; }
    else { factores.edad = '0 (vigente)'; }

    // Concentración: saldo abierto vs ticket promedio
    if (ticket > 0) {
      const ratio = saldo / ticket;
      if (ratio > 5) { s -= 10; factores.concentracion = '-10 (saldo > 5× ticket)'; }
      else if (ratio < 0.3) { factores.concentracion = '0 (bajo)'; }
    }

    // Antigüedad: clientes >24m = +5
    if (antMeses >= 24) { s += 5; factores.antiguedad = '+5 (≥2 años)'; }
    else if (antMeses < 3 && cargosN < 3) { s -= 5; factores.antiguedad = '-5 (cliente nuevo)'; }

    s = Math.max(0, Math.min(100, Math.round(s)));
    let grado = 'A';
    if (s < 30) grado = 'D';
    else if (s < 50) grado = 'C';
    else if (s < 70) grado = 'B';

    return { score: s, grado, factores };
  }

  app.get('/api/cxc/prob-pago', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const minSaldo = Math.max(0, parseFloat(req.query.min) || 0);
    const memoKey = `prob-pago:${req.query.db || 'default'}:${minSaldo}`;
    try {
      const rows = await memo.wrap(memoKey, () => computeScores(snap, minSaldo));
      const items = rows.map((r) => ({ ...r, ...scoreRow(r) }));
      const resumen = { A: 0, B: 0, C: 0, D: 0 };
      let saldoTotal = 0, saldoRiesgo = 0;
      items.forEach((it) => {
        resumen[it.grado] += 1;
        saldoTotal += Number(it.saldo_abierto) || 0;
        if (it.grado === 'C' || it.grado === 'D') saldoRiesgo += Number(it.saldo_abierto) || 0;
      });
      items.sort((a, b) => a.score - b.score); // peor primero (lo que el director quiere ver)
      res.json({
        ok: true,
        total_clientes: items.length,
        saldo_total: saldoTotal,
        saldo_en_riesgo: saldoRiesgo,
        por_grado: resumen,
        clientes: items.slice(0, 500),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/cxc/prob-pago/cliente', async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const id = parseInt(req.query.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Falta ?id=clienteId' });
    try {
      const rows = await computeScores(snap, 0);
      const found = rows.find((r) => Number(r.CLIENTE_ID) === id);
      if (!found) return res.json({ ok: false, reason: 'Cliente sin CxC abierto o sin historia' });
      const sc = scoreRow(found);
      res.json({ ok: true, cliente: found, ...sc });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('prob-pago', '✅ /api/cxc/prob-pago · /api/cxc/prob-pago/cliente');
}

module.exports = { install };
