'use strict';

/**
 * sat-diot.js — Reportes SAT desde datos Microsip
 *   GET /api/sat/diot?mes=YYYY-MM&db=...           → JSON con renglones DIOT
 *   GET /api/sat/diot/txt?mes=YYYY-MM&db=...       → archivo .txt formato DIOT (pipe-delimited)
 *   GET /api/sat/proveedores-rfc-invalido?db=...   → proveedores con RFC mal capturado
 *   GET /api/sat/cfdi-emitidos?mes=YYYY-MM&db=...  → resumen de CFDIs emitidos (ventas)
 *
 * IMPORTANTE: el archivo DIOT oficial es generado por el SAT (DIM/DIOT) y este
 * endpoint produce un PRE-DIOT que sirve para validar, conciliar y exportar.
 * El formato .txt pipe-delimited es el que la mayoría de despachos contables
 * usan para preparar la DIOT. No reemplaza al validador oficial.
 *
 * Estructura por renglón (DIOT 2024+):
 *   TIPO_TERCERO|TIPO_OPERACION|RFC|NOMBRE_EXTRANJERO|PAIS|NACIONALIDAD|
 *   VAL_ACT_TAS16|IVA_PAG_NO_ACR|VAL_ACT_TAS8|VAL_ACT_IMPORT_TAS16|
 *   IVA_PAG_IMPORT_TAS16|VAL_ACT_IMPORT_TAS8|IVA_PAG_IMPORT_TAS8|
 *   VAL_ACT_IMPORT_EXENTO|VAL_ACT_TAS0|VAL_ACT_EXENTO|IVA_RET|IVA_DEV
 *
 * Para este pre-DIOT simplificado emitimos un subset suficiente:
 *   TIPO_TERCERO | TIPO_OPERACION | RFC | NOMBRE | TASA_16_BASE | IVA_TRASLADADO | TASA_0_BASE | EXENTO
 */

const { makeHelpers } = require('./lib/snap-helper');

// Auth: opcional (si dummy provider devuelve admin, no bloquea).
// En prod con session provider, requireRole asegura que datos fiscales
// no se expongan a roles "vendedor" o anónimos.
let requireRole = (_role) => (_req, _res, next) => next();
try { requireRole = require('./src/auth').requireRole; } catch (_) {}

function install(app, { duckSnaps, log }) {
  const { getSnap, all } = makeHelpers(duckSnaps);
  const fiscalRoles = requireRole(['admin', 'director', 'gerente']);

  const SAT_RX = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{2,3}$/;

  function tipoTerceroFromRFC(rfc) {
    const s = String(rfc || '').trim().toUpperCase();
    if (!s) return '85'; // 85 = otros (sin RFC válido nacional)
    if (!SAT_RX.test(s)) return '85';
    // 12 caracteres = persona moral, 13 = persona física
    return s.length === 12 ? '04' : '04'; // 04 = proveedor nacional
  }

  function validateMes(mes) {
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7); // mes anterior
    }
    return mes;
  }

  async function buildDiot(snap, mes) {
    // Microsip suele tener DOCTOS_CM (cuentas por pagar / compras) y DOCTOS_CP (recibidos)
    // Probamos varias rutas en orden de preferencia y devolvemos lo que encontremos.
    // Schema típico: DOCTOS_CM, DOCTOS_PV (proveedores), PROVEEDORES con RFC.
    const tables = await all(snap, `SELECT table_name AS n FROM information_schema.tables`).catch(() => []);
    const tableNames = new Set(tables.map((t) => t.n));

    // Intento 1: DOCTOS_CM (movimientos cuentas por pagar)
    if (tableNames.has('DOCTOS_CM') && tableNames.has('PROVEEDORES')) {
      try {
        const rows = await all(snap, `
          SELECT p.RFC,
                 p.NOMBRE AS proveedor,
                 SUM(CASE WHEN d.IMPUESTOS > 0 AND d.IMPORTE_NETO > 0
                          THEN d.IMPORTE_NETO ELSE 0 END) AS base_16,
                 SUM(CASE WHEN d.IMPUESTOS > 0 AND d.IMPORTE_NETO > 0
                          THEN d.IMPUESTOS ELSE 0 END) AS iva_traslado,
                 SUM(CASE WHEN d.IMPUESTOS = 0 AND d.IMPORTE_NETO > 0
                          THEN d.IMPORTE_NETO ELSE 0 END) AS base_0_o_exento,
                 COUNT(*) AS docs
          FROM DOCTOS_CM d
          LEFT JOIN PROVEEDORES p ON p.PROVEEDOR_ID = d.PROVEEDOR_ID
          WHERE strftime(d.FECHA, '%Y-%m') = ?
            AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C')
          GROUP BY p.RFC, p.NOMBRE
          HAVING SUM(d.IMPORTE_NETO) > 0
          ORDER BY base_16 DESC`, [mes]);
        return { source: 'DOCTOS_CM', rows };
      } catch (e) { log && log.warn && log.warn('sat-diot', 'DOCTOS_CM falló: ' + e.message); }
    }

    // Intento 2: DOCTOS_CP (Cuentas Pagar) variante
    if (tableNames.has('DOCTOS_CP') && tableNames.has('PROVEEDORES')) {
      try {
        const rows = await all(snap, `
          SELECT p.RFC,
                 p.NOMBRE AS proveedor,
                 SUM(d.IMPORTE_NETO) AS base_16,
                 SUM(COALESCE(d.IMPUESTOS, 0)) AS iva_traslado,
                 0 AS base_0_o_exento,
                 COUNT(*) AS docs
          FROM DOCTOS_CP d
          LEFT JOIN PROVEEDORES p ON p.PROVEEDOR_ID = d.PROVEEDOR_ID
          WHERE strftime(d.FECHA, '%Y-%m') = ?
            AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C')
            AND d.IMPORTE_NETO > 0
          GROUP BY p.RFC, p.NOMBRE
          ORDER BY base_16 DESC`, [mes]);
        return { source: 'DOCTOS_CP', rows };
      } catch (e) { log && log.warn && log.warn('sat-diot', 'DOCTOS_CP falló: ' + e.message); }
    }

    return { source: null, rows: [], reason: 'No se encontró tabla de compras (DOCTOS_CM/CP) en el snapshot' };
  }

  // ═══════════════════ DIOT JSON ═════════════════════════════════════════════
  app.get('/api/sat/diot', fiscalRoles, async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const mes = validateMes(req.query.mes);
    try {
      const { source, rows, reason } = await buildDiot(snap, mes);
      const renglones = rows.map((r) => {
        const rfc = String(r.RFC || '').trim().toUpperCase();
        const rfcValido = SAT_RX.test(rfc);
        return {
          tipo_tercero: tipoTerceroFromRFC(rfc),
          tipo_operacion: '85', // 85 = otros, ajustar según concepto
          rfc: rfc || 'SIN_RFC',
          proveedor: r.proveedor || '',
          base_iva_16: +(Number(r.base_16) || 0).toFixed(2),
          iva_acreditable: +(Number(r.iva_traslado) || 0).toFixed(2),
          base_tasa_0_o_exento: +(Number(r.base_0_o_exento) || 0).toFixed(2),
          docs: Number(r.docs) || 0,
          rfc_valido: rfcValido,
        };
      });
      const totales = renglones.reduce((acc, r) => ({
        base_iva_16: acc.base_iva_16 + r.base_iva_16,
        iva_acreditable: acc.iva_acreditable + r.iva_acreditable,
        base_tasa_0_o_exento: acc.base_tasa_0_o_exento + r.base_tasa_0_o_exento,
      }), { base_iva_16: 0, iva_acreditable: 0, base_tasa_0_o_exento: 0 });

      const sin_rfc = renglones.filter((r) => !r.rfc_valido);
      res.json({
        ok: true,
        mes,
        source,
        reason,
        total_proveedores: renglones.length,
        proveedores_sin_rfc_valido: sin_rfc.length,
        totales,
        renglones,
        advertencia: 'Este es un pre-DIOT generado a partir de datos Microsip. NO reemplaza al validador SAT oficial. Úsalo para conciliar antes de subirlo al DIM.',
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ DIOT TXT (pipe-delimited) ═════════════════════════════
  app.get('/api/sat/diot/txt', fiscalRoles, async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.status(503).send('Sin snapshot');
    const mes = validateMes(req.query.mes);
    try {
      const { rows } = await buildDiot(snap, mes);
      const lines = rows.map((r) => {
        const rfc = String(r.RFC || '').trim().toUpperCase();
        const tipo_tercero = tipoTerceroFromRFC(rfc);
        const base16 = Math.round(Number(r.base_16) || 0);
        const iva = Math.round(Number(r.iva_traslado) || 0);
        const exento = Math.round(Number(r.base_0_o_exento) || 0);
        // Formato simplificado pipe-delimited DIOT 2024 (campos clave)
        return [
          tipo_tercero,         // tipo tercero
          '85',                 // tipo operación
          rfc || '',            // RFC
          '',                   // nombre extranjero
          '',                   // país
          '',                   // nacionalidad
          base16,               // valor actos tasa 16%
          iva,                  // IVA pagado no acreditable (a confirmar con contador)
          0,                    // valor actos tasa 8%
          0, 0, 0, 0, 0,        // importación 16/8/exento
          0,                    // valor actos tasa 0%
          exento,               // valor actos exentos
          0,                    // IVA retenido
          0,                    // IVA devuelto
        ].join('|');
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="diot_${mes}.txt"`);
      res.send(lines.join('\n'));
    } catch (e) { res.status(500).send('Error: ' + e.message); }
  });

  // ═══════════════════ Proveedores con RFC inválido ══════════════════════════
  app.get('/api/sat/proveedores-rfc-invalido', fiscalRoles, async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    try {
      const tables = await all(snap, `SELECT table_name AS n FROM information_schema.tables`).catch(() => []);
      const tableNames = new Set(tables.map((t) => t.n));
      if (!tableNames.has('PROVEEDORES')) return res.json({ ok: true, total: 0, items: [], reason: 'Sin tabla PROVEEDORES' });

      const cols = await all(snap, `SELECT column_name AS n FROM information_schema.columns WHERE table_name = 'PROVEEDORES'`).catch(() => []);
      const colNames = new Set(cols.map((c) => c.n));
      if (!colNames.has('RFC')) return res.json({ ok: true, total: 0, items: [], reason: 'PROVEEDORES sin columna RFC' });

      const rows = await all(snap, `SELECT PROVEEDOR_ID, NOMBRE, RFC FROM PROVEEDORES WHERE NOMBRE IS NOT NULL LIMIT 5000`);
      const invalidos = rows.filter((r) => {
        const rfc = String(r.RFC || '').trim().toUpperCase();
        return !rfc || !SAT_RX.test(rfc);
      }).map((r) => ({
        ...r,
        razon: !r.RFC ? 'Sin RFC' : `Formato inválido (${r.RFC})`,
      }));

      res.json({ ok: true, total: invalidos.length, items: invalidos });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════ Resumen CFDIs emitidos (ventas) ═══════════════════════
  app.get('/api/sat/cfdi-emitidos', fiscalRoles, async (req, res) => {
    const snap = getSnap(req);
    if (!snap) return res.json({ ok: false, reason: 'Sin snapshot' });
    const mes = validateMes(req.query.mes);
    try {
      const rows = await all(snap, `
        SELECT TIPO_DOCTO,
               COUNT(*) AS docs,
               SUM(IMPORTE_NETO) AS importe_neto,
               SUM(COALESCE(IMPUESTOS, 0)) AS iva_trasladado
        FROM DOCTOS_VE
        WHERE strftime(FECHA, '%Y-%m') = ?
          AND (ESTATUS IS NULL OR ESTATUS <> 'C')
          AND TIPO_DOCTO IN ('F','R')
        GROUP BY TIPO_DOCTO`, [mes]);

      const totales = rows.reduce((acc, r) => ({
        docs: acc.docs + Number(r.docs),
        importe_neto: acc.importe_neto + (Number(r.importe_neto) || 0),
        iva_trasladado: acc.iva_trasladado + (Number(r.iva_trasladado) || 0),
      }), { docs: 0, importe_neto: 0, iva_trasladado: 0 });

      res.json({ ok: true, mes, por_tipo: rows, totales });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  log && log.info && log.info('sat-diot', '✅ /api/sat/{diot,diot/txt,proveedores-rfc-invalido,cfdi-emitidos}');
}

module.exports = { install };
