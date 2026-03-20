'use strict';

/**
 * Suminregio Parker — API Server v9.0
 * ─────────────────────────────────────────────────────────────────────────────
 * FIXES v9 sobre v8:
 *  • cxcClienteSQL() — REVERTIDO a IMPORTES_DOCTOS_CC (user rechazó SALDOS_CC)
 *                      Ahora suma IMPORTE + COALESCE(IMPUESTO,0) para incluir IVA
 *  • cxcCargosSQL()  — Inner subquery REVERTIDA a IMPORTES_DOCTOS_CC (sin SALDOS_CC)
 *  • /api/debug/cxc  — Enriquecido: distribución TIPO_IMPTE, IMPORTE vs IMPORTE+IVA,
 *                      comparación DOCTOS_CC cargo sin registro en IMPORTES_DOCTOS_CC
 *  • Inventario: fixed EXISTENCIA_MINIMA → SQL_MINIMO_SUB join, UNIDAD_MEDIDA → UNIDAD_VENTA
 * FIXES v6 sobre v5:
 *  • CXC Balance: cxcClienteSQL() = saldo neto REAL por cliente (C - R groupado
 *                 por CLIENTE_ID). En Microsip, CARGO y RECIBO tienen diferentes
 *                 DOCTO_CC_ID, por lo que nunca se podía netear por documento.
 *  • cxcCargosSQL() = docs cargo de clientes con saldo pendiente (para aging)
 *  • /api/cxc/top-deudores  → usa cxcClienteSQL + cxcCargosSQL combinados
 *  • /api/cxc/historial     → usa cxcCargosSQL (CLIENTE_ID directo)
 *  • /api/cxc/por-condicion → usa cxcCargosSQL + CLIENTES.COND_PAGO_ID
 *  • /api/director/resumen  → CXC: cxcClienteSQL (saldo) + cxcCargosSQL (aging)
 *  • Static: express.static(__dirname) con charset=utf-8 (corrige ñ, á, etc.)
 * FIXES v5 sobre v4:
 *  • META_IDEAL corregida a 10% sobre base (antes 30%)
 *  • CXC Aging: usa VENCIMIENTOS_CARGOS_CC.FECHA_VENCIMIENTO para calcular
 *               días vencidos desde la fecha de vencimiento REAL del documento
 *               Fallback: DOCTOS_CC.FECHA + CONDICIONES_PAGO.DIAS_PPAG
 *  • Ventas: UNION ALL de DOCTOS_VE (Industrial) + DOCTOS_PV (Mostrador)
 *            Parámetro ?tipo=VE o ?tipo=PV para filtrar por fuente
 *  • Cotizaciones: solo DOCTOS_VE (PV no maneja cotizaciones)
 *  • Nuevos endpoints:
 *      /api/ventas/cobradas         Facturas cobradas por vendedor
 *      /api/ventas/margen           Margen por vendedor/mes (precio venta)
 *      /api/cxc/por-condicion       CXC agrupado por condición de pago
 *      /api/ventas/ranking-clientes Ranking clientes con saldo y condición
 *      /api/debug/pv                Diagnóstico DOCTOS_PV
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const Firebird = require('node-firebird');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 7000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Servir archivos estáticos — raíz del proyecto Y carpeta public/
const staticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  }
};
app.use(express.static(__dirname, staticOpts));                          // raíz
app.use(express.static(path.join(__dirname, 'public'), staticOpts));     // carpeta public/

// ── Configuración Firebird ────────────────────────────────────────────────────
const DB_OPTIONS = {
  host          : process.env.FB_HOST     || '127.0.0.1',
  port          : parseInt(process.env.FB_PORT) || 3050,
  database      : process.env.FB_DATABASE || 'C:/Microsip datos/SUMINREGIO-PARKER.FDB',
  user          : process.env.FB_USER     || 'SYSDBA',
  password      : process.env.FB_PASSWORD || 'masterkey',
  lowercase_keys: false,    // campos en MAYÚSCULAS
  charset       : 'UTF8',    // Firebird convierte WIN1252→UTF8 automáticamente
};

console.log('DB path:', DB_OPTIONS.database);

/**
 * Power BI / reportes suelen usar importe base sin IVA; en cabecera DOCTOS_VE/PV el campo
 * IMPORTE_NETO a veces viene con IVA acumulado. Por defecto se divide entre 1.16.
 * En .env: MICROSIP_VENTAS_SIN_IVA_DIVISOR=1 desactiva la división (IMPORTE_NETO tal cual).
 */
const _ivaDiv = parseFloat(process.env.MICROSIP_VENTAS_SIN_IVA_DIVISOR);
const VENTAS_SIN_IVA_DIVISOR = Number.isFinite(_ivaDiv) && _ivaDiv >= 0.0001 ? _ivaDiv : 1.16;

function sqlVentaImporteBaseExpr(alias = 'd') {
  const a = alias;
  if (VENTAS_SIN_IVA_DIVISOR <= 1.00001) {
    return `COALESCE(${a}.IMPORTE_NETO, 0)`;
  }
  return `(COALESCE(${a}.IMPORTE_NETO, 0) / CAST(${VENTAS_SIN_IVA_DIVISOR} AS DOUBLE PRECISION))`;
}

// ── Helper: ejecuta query → promesa ──────────────────────────────────────────
function query(sql, params = [], timeoutMs = parseInt(process.env.FB_QUERY_DEFAULT_MS || '45000', 10) || 45000) {
  const queryPromise = new Promise((resolve, reject) => {
    Firebird.attach(DB_OPTIONS, (err, db) => {
      if (err) return reject(err);
      db.query(sql, params, (err2, result) => {
        db.detach();
        if (err2) return reject(err2);
        resolve(result || []);
      });
    });
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout (${timeoutMs}ms)`)), timeoutMs)
  );
  return Promise.race([queryPromise, timeoutPromise]);
}

// ── Helper: ruta GET con manejo de errores ────────────────────────────────────
function get(routePath, handler) {
  app.get(routePath, async (req, res) => {
    try {
      const data = await handler(req);
      res.json(data);
    } catch (e) {
      console.error(`[ERROR] ${routePath} →`, e.message);
      res.status(500).json({ error: e.message, path: routePath });
    }
  });
}

// ── Helper: construye cláusulas WHERE para filtros de fecha/vendedor/cliente ─
// Soporta: anio, mes, dia, vendedor, cliente, desde (YYYY-MM-DD), hasta (YYYY-MM-DD)
// Retorna { sql, params, lookbackOverride }
// lookbackOverride: días desde 'desde' hasta hoy — para que los endpoints
//   con ventana fija (CURRENT_DATE - N) no corten los datos pedidos.
function buildFiltros(req, alias = 'd') {
  const conds  = [];
  const params = [];
  const { anio, mes, dia, vendedor, cliente } = req.query;
  let   { desde, hasta } = req.query;

  // Validar formato básico YYYY-MM-DD
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (desde && !reDate.test(desde)) desde = null;
  if (hasta && !reDate.test(hasta)) hasta = null;

  if (desde) { conds.push(`CAST(${alias}.FECHA AS DATE) >= CAST(? AS DATE)`); params.push(desde); }
  if (hasta) { conds.push(`CAST(${alias}.FECHA AS DATE) <= CAST(? AS DATE)`); params.push(hasta); }

  // anio/mes solo si no hay rango explícito
  if (!desde) {
    if (anio) { conds.push(`EXTRACT(YEAR  FROM ${alias}.FECHA) = ?`); params.push(parseInt(anio)); }
    if (mes)  { conds.push(`EXTRACT(MONTH FROM ${alias}.FECHA) = ?`); params.push(parseInt(mes)); }
  }
  if (dia)      { conds.push(`CAST(${alias}.FECHA AS DATE) = CAST(? AS DATE)`); params.push(dia); }
  if (vendedor) { conds.push(`${alias}.VENDEDOR_ID = ?`);  params.push(parseInt(vendedor)); }
  if (cliente)  { conds.push(`${alias}.CLIENTE_ID  = ?`);  params.push(parseInt(cliente)); }

  // Si hay desde, calcular cuántos días de lookback necesitamos
  let lookbackOverride = null;
  if (desde) {
    const daysAgo = Math.ceil((Date.now() - new Date(desde).getTime()) / 86400000);
    lookbackOverride = Math.max(daysAgo + 5, 31);
  }

  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params, lookbackOverride };
}

/** Cotizaciones: rango explícito en FECHA (evita EXTRACT en WHERE → índice usable en Firebird). */
// Firebird: si es muy bajo, el cliente recibe [] y parece "sin datos". Director ventas vuelve a buildFiltros (no reutilizar cotizacionesFechaWhere sobre UNION ventasSub — en algunos FB es lento/incorrecto).
const COTI_QUERY_MS = 55000;
const DIRECTOR_VENTAS_MS = 55000;
/** CXC (director e /api/cxc/resumen): el default 12s cortaba consultas reales en producción. */
const DIRECTOR_CXC_MS = 90000;
const CXC_RESUMEN_MS = 90000;
function cotizacionesFechaWhere(req) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  const qv = (k) => {
    const v = req.query[k];
    if (v == null) return null;
    return Array.isArray(v) ? v[0] : v;
  };
  let desde = qv('desde');
  let hasta = qv('hasta');
  if (desde && !reDate.test(String(desde))) desde = null;
  if (hasta && !reDate.test(String(hasta))) hasta = null;
  let desdeStr; let hastaStr;
  if (desde && hasta) {
    desdeStr = desde;
    hastaStr = hasta;
  } else {
    const anio = parseInt(qv('anio'), 10) || new Date().getFullYear();
    const mesRaw = qv('mes');
    const mes = mesRaw !== undefined && mesRaw !== '' && mesRaw !== null ? parseInt(mesRaw, 10) : NaN;
    if (mes >= 1 && mes <= 12) {
      desdeStr = `${anio}-${String(mes).padStart(2, '0')}-01`;
      const last = new Date(anio, mes, 0);
      hastaStr = `${anio}-${String(mes).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    } else {
      desdeStr = `${anio}-01-01`;
      hastaStr = `${anio}-12-31`;
    }
  }
  const conds = [];
  const params = [];
  conds.push(`CAST(d.FECHA AS DATE) >= CAST(? AS DATE)`);
  params.push(desdeStr);
  conds.push(`CAST(d.FECHA AS DATE) <= CAST(? AS DATE)`);
  params.push(hastaStr);
  const dia = qv('dia');
  if (dia && reDate.test(String(dia))) {
    conds.push(`CAST(d.FECHA AS DATE) = CAST(? AS DATE)`);
    params.push(String(dia));
  }
  const vend = qv('vendedor');
  if (vend !== null && vend !== '') {
    const vid = parseInt(vend, 10);
    if (!isNaN(vid)) {
      conds.push(`d.VENDEDOR_ID = ?`);
      params.push(vid);
    }
  }
  const cli = qv('cliente');
  if (cli !== null && cli !== '') {
    const cid = parseInt(cli, 10);
    if (!isNaN(cid)) {
      conds.push(`d.CLIENTE_ID = ?`);
      params.push(cid);
    }
  }
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VENTAS — MACRO SQL (UNION ALL DOCTOS_VE + DOCTOS_PV)
//  tipo: 'VE'=Industrial, 'PV'=Mostrador, ''=Todos
// ═══════════════════════════════════════════════════════════════════════════════

/** Lista de códigos separados por coma (solo dígitos) — para TIPO_DOCTO numérico en Microsip. */
function parseCommaNumericCodes(s) {
  if (!s || typeof s !== 'string') return [];
  return s
    .split(',')
    .map((x) => String(x).trim())
    .filter((x) => /^[0-9]+$/.test(x));
}

/** Primer carácter alfanumérico de TIPO_DOCTO (p. ej. 'FAC' → 'F'); evita perder filas si el CHAR viene relleno o el código es largo. */
function sqlExprTipoDoctoChar1(alias = 'd') {
  const a = alias;
  return `UPPER(COALESCE(NULLIF(TRIM(SUBSTRING(TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(40))) FROM 1 FOR 1)), ''), ''))`;
}

/** ESTATUS normalizado: vacío/NULL → 'N' (Firebird: NULL <> 'C' excluiría la fila). */
function sqlExprEstatusNorm(alias = 'd') {
  const a = alias;
  return `COALESCE(NULLIF(UPPER(TRIM(CAST(${a}.ESTATUS AS VARCHAR(10)))), ''), 'N')`;
}

/**
 * Modo **amplio** (default): cuenta ventas como documentos VE/PV **no cancelados**, excluyendo solo tipos **exactamente** `C`, `O` o `Q`.
 * No filtrar por primer letra (evita matar CON/COT/CRED/FAC…).
 * Modo **estricto**: `MICROSIP_VENTAS_FILTRO=estricto`
 */
function sqlWhereVentasAmplio(alias = 'd', opts = {}) {
  const a = alias;
  const e = sqlExprEstatusNorm(a);
  const t0 = sqlExprTipoDoctoChar1(a);
  const tipoStr = `TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(40)))`;
  const excluirT = String(process.env.MICROSIP_VENTAS_AMPLIO_EXCLUIR_T || '1').trim() !== '0';
  const estatusOk = excluirT ? `${e} NOT IN ('C', 'T')` : `${e} <> 'C'`;
  const extraCsv = String(process.env.MICROSIP_VENTAS_AMPLIO_EXCLUIR_TIPOS || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const extraNotIn = extraCsv.length
    ? ` AND ${tipoStr} NOT IN (${extraCsv.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(', ')})`
    : '';
  const sinR = opts.omitRemision
    ? ` AND NOT ((${a}.TIPO_DOCTO = 'R' OR ${t0} = 'R'))`
    : '';
  return `(
    ${estatusOk}
    AND NOT (${tipoStr} IN ('C', 'O', 'Q'))
    ${extraNotIn}
    ${sinR}
  )`;
}

/**
 * Documento de venta válido para KPIs — ver `sqlWhereVentasAmplio` vs estricto arriba.
 * @param {{ omitRemision?: boolean }} [opts]
 */
function sqlWhereVentasDocumentoValido(alias = 'd', opts = {}) {
  const modo = String(process.env.MICROSIP_VENTAS_FILTRO || 'amplio').trim().toLowerCase();
  if (modo !== 'estricto' && modo !== 'legacy' && modo !== 'fv') {
    return sqlWhereVentasAmplio(alias, opts);
  }
  const a = alias;
  const e = sqlExprEstatusNorm(a);
  const t0 = sqlExprTipoDoctoChar1(a);
  const incluirR =
    !opts.omitRemision && String(process.env.MICROSIP_VENTAS_INCLUIR_REM || '').trim() === '1';
  const partR = incluirR
    ? ` OR ((${a}.TIPO_DOCTO = 'R' OR ${t0} = 'R') AND ${e} <> 'C')`
    : '';
  const incluirNum = String(process.env.MICROSIP_VENTAS_INCLUIR_TIPO_NUMERICO ?? '1').trim() !== '0';
  const exclNum = parseCommaNumericCodes(process.env.MICROSIP_VENTAS_EXCLUIR_TIPOS_NUMERICOS || '');
  const exclSql = exclNum.length
    ? ` AND TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(40))) NOT IN (${exclNum.map((x) => `'${x}'`).join(', ')})`
    : '';
  const partNum = incluirNum
    ? ` OR (
    SUBSTRING(COALESCE(TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(40))), '') FROM 1 FOR 1) IN ('0','1','2','3','4','5','6','7','8','9')
    AND ${e} NOT IN ('C', 'T')
    ${exclSql}
  )`
    : '';
  return `(
    ((${a}.TIPO_DOCTO = 'F' OR ${t0} = 'F') AND ${e} <> 'C')
    OR ((${a}.TIPO_DOCTO = 'V' OR ${t0} = 'V') AND ${e} NOT IN ('C', 'T'))
    ${partR}
    ${partNum}
  )`;
}

/**
 * UNION ALL VE+PV — una fila por documento, **importe de cabecera** (IMPORTE_NETO + divisor IVA si aplica).
 * @param {string} tipo - 'VE', 'PV' o '' (todos)
 */
function ventasSub(tipo = '') {
  const imp = sqlVentaImporteBaseExpr('d');
  const wVe = sqlWhereVentasDocumentoValido('d');
  const wPv = sqlWhereVentasDocumentoValido('d');
  const ve = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.DOCTO_VE_ID,
      CAST(NULL AS INTEGER) AS DOCTO_PV_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    WHERE ${wVe}`;

  const pv = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    WHERE ${wPv}`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

/**
 * Subconsulta de consumo por unidades vendidas (VE + PV)
 * tipo: 'VE' | 'PV' | '' (ambos)
 */
function consumosSub(tipo = '') {
  const ve = `
    SELECT
      d.FECHA,
      COALESCE(det.UNIDADES, 0) AS UNIDADES,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE (
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
    )`;

  const pv = `
    SELECT
      d.FECHA,
      COALESCE(det.UNIDADES, 0) AS UNIDADES,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
    WHERE (
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
    )`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

// ── Filtro de tipo de ventas desde request ────────────────────────────────────
function getTipo(req) {
  const t = (req.query.tipo || '').toUpperCase();
  return t === 'VE' ? 'VE' : t === 'PV' ? 'PV' : '';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CXC — MACRO SQL con aging por fecha de vencimiento real
//  Usa VENCIMIENTOS_CARGOS_CC.FECHA_VENCIMIENTO
//  Fallback: DOCTOS_CC.FECHA + CONDICIONES_PAGO.DIAS_PPAG
// ═══════════════════════════════════════════════════════════════════════════════

// ── v10: Saldo neto por cliente — fórmula alineada al DAX Power BI ─────────────
// CARGO  (TIPO_IMPTE='C'): usa IMPORTE (base ex-IVA). El IVA se guarda en IMPUESTO
//                           pero NO se suma al cargo — así equiparamos con el cobro.
// COBRO  (TIPO_IMPTE='R'): normaliza a base ex-IVA:
//   · Si IMPUESTO > 0 el IMPORTE ya es ex-IVA   → usar IMPORTE
//   · Si IMPUESTO = 0 el pago incluye IVA 16%   → dividir entre 1.16
// Referencia DAX: Cobro = IF(IMPUESTO>0, IMPORTE, IMPORTE/1.16)
// Incluir Contado para que totales coincidan con Power BI. Para excluir Contado otra vez: usar las dos líneas siguientes y poner las actuales en ''.
// const CXC_EXCLUIR_CONTADO = ` AND (cp.NOMBRE IS NULL OR UPPER(TRIM(cp.NOMBRE)) <> 'CONTADO') `;
// const CXC_EXCLUIR_CONTADO_SUB = ` AND (cp2.NOMBRE IS NULL OR UPPER(TRIM(cp2.NOMBRE)) <> 'CONTADO') `;
const CXC_EXCLUIR_CONTADO = '';
const CXC_EXCLUIR_CONTADO_SUB = '';
function cxcClienteSQL() {
  return `(
    SELECT
      dc.CLIENTE_ID,
      SUM(CASE
        WHEN i.TIPO_IMPTE = 'C'
          THEN i.IMPORTE
        WHEN i.TIPO_IMPTE = 'R'
          THEN -(CASE WHEN COALESCE(i.IMPUESTO, 0) > 0
                      THEN i.IMPORTE
                      ELSE i.IMPORTE / 1.16 END)
        ELSE 0
      END) AS SALDO
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
    WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO}
    GROUP BY dc.CLIENTE_ID
    HAVING SUM(CASE
        WHEN i.TIPO_IMPTE = 'C'
          THEN i.IMPORTE
        WHEN i.TIPO_IMPTE = 'R'
          THEN -(CASE WHEN COALESCE(i.IMPUESTO, 0) > 0
                      THEN i.IMPORTE
                      ELSE i.IMPORTE / 1.16 END)
        ELSE 0
      END) > 0
  )`;
}

// ── v9: Documentos de CARGO para clientes que aún tienen saldo pendiente ─────
// Para aging y detalles por documento. Solo TIPO_IMPTE='C' y solo para
// clientes cuyo saldo neto (IMPORTES_DOCTOS_CC) > $1.
// NULLIF(DIAS_PPAG,0) evita vencimiento inmediato en crédito de 0 días.
function cxcCargosSQL() {
  return `(
    SELECT
      i.DOCTO_CC_ID,
      dc.CLIENTE_ID,
      dc.FOLIO,
      i.IMPORTE                                                       AS SALDO,
      CAST(COALESCE(
        MIN(vc.FECHA_VENCIMIENTO),
        CAST(dc.FECHA AS DATE) + CAST(COALESCE(NULLIF(cp.DIAS_PPAG, 0), 30) AS INTEGER)
      ) AS DATE)                                                      AS FECHA_VENCIMIENTO,
      (CURRENT_DATE - CAST(COALESCE(
        MIN(vc.FECHA_VENCIMIENTO),
        CAST(dc.FECHA AS DATE) + CAST(COALESCE(NULLIF(cp.DIAS_PPAG, 0), 30) AS INTEGER)
      ) AS DATE))                                                     AS DIAS_VENCIDO
    FROM IMPORTES_DOCTOS_CC i
    JOIN  DOCTOS_CC dc         ON dc.DOCTO_CC_ID  = i.DOCTO_CC_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
    LEFT JOIN VENCIMIENTOS_CARGOS_CC vc ON vc.DOCTO_CC_ID = i.DOCTO_CC_ID
    WHERE i.TIPO_IMPTE = 'C'
      AND COALESCE(i.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO}
      AND dc.CLIENTE_ID IN (
        SELECT dc2.CLIENTE_ID
        FROM IMPORTES_DOCTOS_CC i2
        JOIN DOCTOS_CC dc2 ON dc2.DOCTO_CC_ID = i2.DOCTO_CC_ID
        LEFT JOIN CONDICIONES_PAGO cp2 ON cp2.COND_PAGO_ID = dc2.COND_PAGO_ID
        WHERE COALESCE(i2.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO_SUB}
        GROUP BY dc2.CLIENTE_ID
        HAVING SUM(CASE
            WHEN i2.TIPO_IMPTE = 'C'
              THEN i2.IMPORTE
            WHEN i2.TIPO_IMPTE = 'R'
              THEN -(CASE WHEN COALESCE(i2.IMPUESTO,0) > 0
                          THEN i2.IMPORTE ELSE i2.IMPORTE/1.16 END)
            ELSE 0
          END) > 0
      )
    GROUP BY i.DOCTO_CC_ID, dc.CLIENTE_ID, dc.FOLIO, dc.FECHA,
             i.IMPORTE, i.IMPUESTO, cp.DIAS_PPAG
  )`;
}

// Deprecated — mantener para compatibilidad pero los endpoints usan cxcClienteSQL/cxcCargosSQL
function cxcSaldosSub() { return cxcCargosSQL(); }

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG / METAS  ✅ v5: META_IDEAL = 10% sobre base
// ═══════════════════════════════════════════════════════════════════════════════

get('/api/config/metas', async () => {
  const rows = await query(`
    SELECT COUNT(DISTINCT VENDEDOR_ID) AS NUM_VENDEDORES
    FROM DOCTOS_VE
    WHERE (
      (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
      OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
    )
    AND EXTRACT(YEAR  FROM FECHA) = EXTRACT(YEAR  FROM CURRENT_DATE)
    AND EXTRACT(MONTH FROM FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
  `);
  const numV = (rows[0] && rows[0].NUM_VENDEDORES) ? Number(rows[0].NUM_VENDEDORES) : 1;

  const META_DIA_V   = 5650;
  const META_IDEAL_V = 5650 * 1.10;
  const META_DIA_C   = 10000;
  const META_IDEAL_C = 10000 * 1.10;

  return {
    META_DIARIA_POR_VENDEDOR : META_DIA_V,
    META_IDEAL_POR_VENDEDOR  : META_IDEAL_V,
    META_COTI_POR_VENDEDOR   : META_DIA_C,
    META_COTI_IDEAL          : META_IDEAL_C,
    META_TOTAL_DIARIA        : META_DIA_V   * numV,
    META_IDEAL_TOTAL         : META_IDEAL_V * numV,
    META_COTI_TOTAL          : META_DIA_C   * numV,
    META_COTI_IDEAL_TOTAL    : META_IDEAL_C * numV,
    NUM_VENDEDORES           : numV,
    MARGEN_COMISION          : 0.08,
  };
});

get('/api/config/filtros', async () => {
  const [vendedores, clientes, anios] = await Promise.all([
    query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`)
      .catch(() => query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES ORDER BY NOMBRE`)),
    query(`
      SELECT FIRST 500 d.CLIENTE_ID, c.NOMBRE
      FROM (
        SELECT DISTINCT CLIENTE_ID FROM DOCTOS_VE
        WHERE ((TIPO_DOCTO='F' AND ESTATUS<>'C') OR (TIPO_DOCTO='V' AND ESTATUS NOT IN ('C','T')))
          AND FECHA >= (CURRENT_DATE - 365)
      ) d
      JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
      ORDER BY c.NOMBRE
    `),
    query(`
      SELECT DISTINCT EXTRACT(YEAR FROM FECHA) AS ANIO
      FROM DOCTOS_VE
      WHERE (TIPO_DOCTO='F' OR TIPO_DOCTO='V') AND ESTATUS <> 'C'
      ORDER BY ANIO DESC
    `),
  ]);
  return { vendedores, clientes, anios };
});
// ═══════════════════════════════════════════════════════════
//  VENTAS — RESÚMENES
// ═══════════════════════════════════════════════════════════

/**
 * Agregados de ventas sin UNION (VE y PV en paralelo). El UNION ALL sobre tablas grandes en Firebird
 * suele agotar timeout; dos SELECT con índice por tabla suele ser más rápido.
 */
async function queryVentasResumenAgregado(tipo, f, timeoutMs = 120000) {
  const imp = sqlVentaImporteBaseExpr('d');
  const wVe = sqlWhereVentasDocumentoValido('d');
  const wPv = sqlWhereVentasDocumentoValido('d');
  const sel = `
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE
               THEN ${imp} ELSE 0 END)                      AS HOY,
      COALESCE(SUM(${imp}), 0)                              AS MES_ACTUAL,
      COUNT(*)                                              AS FACTURAS_MES,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) < CURRENT_DATE
               THEN ${imp} ELSE 0 END)                     AS HASTA_AYER_MES
  `;
  const sqlVe = `SELECT ${sel} FROM DOCTOS_VE d WHERE ${wVe} ${f.sql}`;
  const sqlPv = `SELECT ${sel} FROM DOCTOS_PV d WHERE ${wPv} ${f.sql}`;
  if (tipo === 'VE') return query(sqlVe, f.params, timeoutMs);
  if (tipo === 'PV') return query(sqlPv, f.params, timeoutMs);
  const [rVe, rPv] = await Promise.all([
    query(sqlVe, f.params, timeoutMs),
    query(sqlPv, f.params, timeoutMs),
  ]);
  const a = rVe[0] || {};
  const b = rPv[0] || {};
  return [
    {
      HOY: (+a.HOY || 0) + (+b.HOY || 0),
      MES_ACTUAL: (+a.MES_ACTUAL || 0) + (+b.MES_ACTUAL || 0),
      FACTURAS_MES: (+a.FACTURAS_MES || 0) + (+b.FACTURAS_MES || 0),
      HASTA_AYER_MES: (+a.HASTA_AYER_MES || 0) + (+b.HASTA_AYER_MES || 0),
    },
  ];
}

/** Diagnóstico resumen: contar/sumar sin filtro de mes — mismo criterio que queryVentasResumenAgregado pero sin UNION. */
async function queryVentasDiagnosticoSinFecha(tipo, f2, timeoutMs = 120000) {
  const imp = sqlVentaImporteBaseExpr('d');
  const wVe = sqlWhereVentasDocumentoValido('d');
  const wPv = sqlWhereVentasDocumentoValido('d');
  const sel = `COUNT(*) AS N, COALESCE(MAX(CAST(d.FECHA AS DATE)), NULL) AS ULTIMA,
               COALESCE(SUM(${imp}), 0) AS SUMA_IMP`;
  const sqlVe = `SELECT ${sel} FROM DOCTOS_VE d WHERE ${wVe} ${f2.sql}`;
  const sqlPv = `SELECT ${sel} FROM DOCTOS_PV d WHERE ${wPv} ${f2.sql}`;
  if (tipo === 'VE') return query(sqlVe, f2.params, timeoutMs);
  if (tipo === 'PV') return query(sqlPv, f2.params, timeoutMs);
  const [rVe, rPv] = await Promise.all([
    query(sqlVe, f2.params, timeoutMs),
    query(sqlPv, f2.params, timeoutMs),
  ]);
  const a = rVe[0] || {};
  const b = rPv[0] || {};
  const uA = a.ULTIMA;
  const uB = b.ULTIMA;
  let ULTIMA = null;
  if (uA && uB) ULTIMA = new Date(uA) >= new Date(uB) ? uA : uB;
  else ULTIMA = uA || uB || null;
  return [
    {
      N: (+a.N || 0) + (+b.N || 0),
      ULTIMA,
      SUMA_IMP: (+a.SUMA_IMP || 0) + (+b.SUMA_IMP || 0),
    },
  ];
}

// Ventas del periodo: HOY = venta del día actual; MES_ACTUAL = total del periodo filtrado (anio/mes o desde-hasta).
get('/api/ventas/resumen', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  let rows;
  try {
    rows = await queryVentasResumenAgregado(tipo, f, 120000);
  } catch (err) {
    console.error('[ventas/resumen]', err && err.message, err);
    return {
      HOY: 0,
      MES_ACTUAL: 0,
      FACTURAS_MES: 0,
      HASTA_AYER_MES: 0,
      _queryError: String((err && err.message) || err),
    };
  }
  const out = rows[0] || {};
  out._filtro_ventas = process.env.MICROSIP_VENTAS_FILTRO || 'amplio';
  const mesCero = +(out.MES_ACTUAL || 0) === 0 && +(out.FACTURAS_MES || 0) === 0;
  if (mesCero && !out._queryError) {
    try {
      const rq2 = { query: { ...(req.query || {}) } };
      ['anio', 'mes', 'dia', 'desde', 'hasta'].forEach((k) => {
        if (rq2.query && Object.prototype.hasOwnProperty.call(rq2.query, k)) delete rq2.query[k];
      });
      const f2 = buildFiltros(rq2, 'd');
      const rows2 = await queryVentasDiagnosticoSinFecha(tipo, f2, 120000);
      const r2 = rows2[0] || {};
      const nTot = +(r2.N || 0);
      if (nTot > 0) {
        out._diagnostico = {
          tipo: 'periodo_sin_datos',
          documentos_sin_filtro_fecha: nTot,
          ultima_fecha: r2.ULTIMA,
          suma_importe_todas_fechas: Math.round((+r2.SUMA_IMP || 0) * 100) / 100,
          mensaje:
            'Hay facturas en esta empresa, pero ninguna en el mes/año del filtro. Prueba "Este año", "Mes anterior" o revisa el periodo en la barra.',
        };
      } else {
        const [cVe, cPv] = await Promise.all([
          query(`SELECT COUNT(*) AS N FROM DOCTOS_VE`, [], 8000).catch(() => [{ N: 0 }]),
          query(`SELECT COUNT(*) AS N FROM DOCTOS_PV`, [], 8000).catch(() => [{ N: 0 }]),
        ]);
        const nVe = +(cVe[0] && cVe[0].N);
        const nPv = +(cPv[0] && cPv[0].N);
        out._diagnostico = {
          tipo: nVe + nPv === 0 ? 'tablas_vacias' : 'filtro_excluye_todo',
          doctos_ve_total: nVe,
          doctos_pv_total: nPv,
          mensaje:
            nVe + nPv === 0
              ? 'DOCTOS_VE y DOCTOS_PV están vacíos en esta conexión (revisa FB_DATABASE en el servidor).'
              : 'Hay movimientos en VE/PV pero ninguno entra al filtro de ventas (TIPO_DOCTO/ESTATUS). Abre /api/debug/ventas.',
        };
      }
    } catch (e) {
      out._diagnostico = { error: String((e && e.message) || e) };
    }
  }
  return out;
});

const COTI_RESUMEN_VACIO = { HOY: 0, MES_ACTUAL: 0, COTIZACIONES_MES: 0, COTIZACIONES_HOY: 0 };

/** Tipos cotización/pedido en VE (Microsip: C, O; en algunas empresas P = pedido cotizable). */
const SQL_COTI_TIPO = `(d.TIPO_DOCTO IN ('C', 'O', 'P'))`;
/** Excluye canceladas/anuladas sin depender solo de `<>` (NULL y espacios en CHAR). */
const SQL_COTI_NO_CANCEL = `(TRIM(COALESCE(CAST(d.ESTATUS AS VARCHAR(25)), '')) NOT IN ('C','c','X'))`;

// Cotizaciones: una sola consulta optimizada (rango FECHA, índice) para Ventas, Director e Inicio.
// C u O: en Microsip a veces cotizaciones van como 'O'; excluir canceladas (ver SQL_COTI_NO_CANCEL).
async function cotizacionesResumenAgregado(req) {
  try {
    if (!req) return { ...COTI_RESUMEN_VACIO };
    if (!req.query || typeof req.query !== 'object') req.query = {};
    const q = req.query;
    if (!q.desde && !q.hasta && !q.anio) {
      const now = new Date();
      q.anio = String(now.getFullYear());
      q.mes = String(now.getMonth() + 1);
    }
    const { sql, params: pFecha } = cotizacionesFechaWhere(req);
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const params = [todayStr, todayStr, ...pFecha];
    const rows = await query(`
      SELECT
        SUM(CASE WHEN CAST(d.FECHA AS DATE) = CAST(? AS DATE)
                 THEN d.IMPORTE_NETO ELSE 0 END)                      AS HOY,
        COALESCE(SUM(d.IMPORTE_NETO), 0)                              AS MES_ACTUAL,
        COUNT(*)                                                      AS COTIZACIONES_MES,
        COUNT(CASE WHEN CAST(d.FECHA AS DATE) = CAST(? AS DATE) THEN 1 END) AS COTIZACIONES_HOY
      FROM DOCTOS_VE d
      WHERE ${SQL_COTI_TIPO}
        AND ${SQL_COTI_NO_CANCEL}
        ${sql}
    `, params, COTI_QUERY_MS).catch(() => []);
    const raw = rows[0] || {};
    const num = (v, d = 0) => {
      if (v === undefined || v === null || v === '') return d;
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    return {
      HOY: num(raw.HOY ?? raw.hoy),
      MES_ACTUAL: num(raw.MES_ACTUAL ?? raw.mes_actual),
      COTIZACIONES_MES: num(raw.COTIZACIONES_MES ?? raw.cotizaciones_mes),
      COTIZACIONES_HOY: num(raw.COTIZACIONES_HOY ?? raw.cotizaciones_hoy),
    };
  } catch (e) {
    console.error('[cotizacionesResumenAgregado]', e && e.message ? e.message : e);
    return { ...COTI_RESUMEN_VACIO };
  }
}

/** Misma agregación que scorecards Director / index.html */
function cotizacionesParaDirector(co) {
  const c = co || {};
  return {
    COTI_HOY: c.COTIZACIONES_HOY,
    IMPORTE_COTI_HOY: c.HOY,
    IMPORTE_COTI_MES: c.MES_ACTUAL,
    COTI_MES: c.COTIZACIONES_MES,
  };
}

get('/api/ventas/cotizaciones/resumen', async (req) => {
  return cotizacionesResumenAgregado(req);
});

get('/api/ventas/diarias', async (req) => {
  const tipo = getTipo(req);
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  // Fecha "N días atrás" en Node (evita depender de DATEADD en Firebird)
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const sql = tipo === ''
    ? `
    SELECT CAST(d.FECHA AS DATE) AS DIA,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS
    FROM ${ventasSub()} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
    `
    : `
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS
    FROM ${ventasSub(tipo)} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
    `;
  const rows = await query(sql, [desdeStr]).catch(() => []);
  if (tipo !== '') return (rows || []).map(r => ({ DIA: r.DIA, VENTAS_VE: tipo === 'VE' ? (r.TOTAL_VENTAS || 0) : 0, VENTAS_PV: tipo === 'PV' ? (r.TOTAL_VENTAS || 0) : 0, TOTAL_VENTAS: r.TOTAL_VENTAS || 0 }));
  return rows || [];
});

get('/api/ventas/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/mensuales', async (req) => {
  const mesesN = Math.min(Math.max(parseInt(req.query.meses) || 12, 1), 24);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - mesesN);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-01';
  const f = { sql: ' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)', params: [desdeStr] };
  const tipo = getTipo(req);
  if (tipo === '') {
    const rows = await query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COUNT(*) AS FACTURAS,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL
      FROM ${ventasSub()} d WHERE 1=1 ${f.sql}
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, f.params).catch(() => []);
    return (rows || []).map(r => ({ ANIO: r.ANIO, MES: r.MES, FACTURAS: r.FACTURAS, VENTAS_VE: r.VENTAS_VE, VENTAS_PV: r.VENTAS_PV, TOTAL: r.TOTAL }));
  }
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []).then(rows => (rows || []).map(r => ({ ANIO: r.ANIO, MES: r.MES, FACTURAS: r.FACTURAS, VENTAS_VE: tipo === 'VE' ? r.TOTAL : 0, VENTAS_PV: tipo === 'PV' ? r.TOTAL : 0, TOTAL: r.TOTAL })));
});

get('/api/ventas/cotizaciones/diarias', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const qv = (k) => {
    const v = req.query[k];
    if (v == null) return null;
    return Array.isArray(v) ? v[0] : v;
  };
  // Misma ventana temporal que lista/resumen (filters.js manda anio/mes o desde/hasta). Antes solo "últimos N días" → gráfico vacío o incoherente con KPI.
  const hasCal = !!(qv('desde') || qv('hasta') || qv('anio'));
  const whereTipo = `FROM DOCTOS_VE d WHERE ${SQL_COTI_TIPO}
      AND ${SQL_COTI_NO_CANCEL}`;
  let rows;
  if (hasCal) {
    const { sql, params } = cotizacionesFechaWhere(req);
    rows = await query(`
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_COTIZACIONES
    ${whereTipo}
      ${sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, params, COTI_QUERY_MS).catch(() => []);
  } else {
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);
    const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
    rows = await query(`
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_COTIZACIONES
    ${whereTipo}
      AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, [desdeStr], COTI_QUERY_MS).catch(() => []);
  }
  return (rows || []).map(r => ({ DIA: r.DIA, COTIZACIONES: r.COTIZACIONES, TOTAL_COTIZACIONES: r.TOTAL_COTIZACIONES || 0 }));
});

get('/api/ventas/cotizaciones/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE ${SQL_COTI_TIPO} AND ${SQL_COTI_NO_CANCEL} ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones/mensuales', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM DOCTOS_VE d WHERE ${SQL_COTI_TIPO} AND ${SQL_COTI_NO_CANCEL} ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params).catch(() => []);
});

get('/api/ventas/top-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT FIRST ${limit}
      d.CLIENTE_ID, c.NOMBRE AS CLIENTE, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL DESC
  `, f.params).catch(() => []);
});

// ventas (4).html y vendedores esperan: VENDEDOR, VENTAS_HOY, VENTAS_MES, VENTAS_MES_VE, VENTAS_MES_PV, FACTURAS_HOY, FACTURAS_MES
get('/api/ventas/por-vendedor', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS VENDEDOR,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_HOY,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) AND d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES_VE,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) AND d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES_PV,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub(tipo)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) AND d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE ORDER BY VENTAS_MES DESC
  `, f.params).catch(() => []);
});

get('/api/ventas/por-vendedor/cotizaciones', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = String(now.getFullYear());
    req.query.mes = String(now.getMonth() + 1);
  }
  const { sql, params: pFecha } = cotizacionesFechaWhere(req);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const params = [todayStr, ...pFecha];
  return query(`
    SELECT COALESCE(MAX(v.NOMBRE), 'Vend. ' || CAST(d.VENDEDOR_ID AS VARCHAR(12))) AS VENDEDOR, d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CAST(? AS DATE) THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_HOY,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS COTIZACIONES_MES,
      COUNT(*) AS NUM_COTI_MES
    FROM DOCTOS_VE d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${SQL_COTI_TIPO}
      AND ${SQL_COTI_NO_CANCEL}
      ${sql}
    GROUP BY d.VENDEDOR_ID ORDER BY COTIZACIONES_MES DESC
  `, params, COTI_QUERY_MS).catch(() => []);
});

get('/api/ventas/recientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT FIRST ${limit} d.FECHA, d.FOLIO, d.TIPO_DOCTO, d.TIPO_SRC, d.IMPORTE_NETO AS TOTAL, d.CLIENTE_ID,
      COALESCE(c.NOMBRE, 'Sin cliente') AS CLIENTE,
      COALESCE(v.NOMBRE, 'Sin vendedor') AS VENDEDOR
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE 1=1 ${f.sql}
    ORDER BY d.FECHA DESC, d.FOLIO DESC
  `, f.params).catch(() => []);
});

get('/api/ventas/vs-cotizaciones', async (req) => {
  const mesesN = Math.min(parseInt(req.query.meses) || 6, 24);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - mesesN);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-01';
  const [ventasMes, cotizMes] = await Promise.all([
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS, COUNT(*) AS NUM_DOCS
      FROM ${ventasSub()} d WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, [desdeStr]).catch(() => []),
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_COTI, COUNT(*) AS NUM_COTI
      FROM DOCTOS_VE d WHERE ${SQL_COTI_TIPO}
        AND ${SQL_COTI_NO_CANCEL} AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, [desdeStr], COTI_QUERY_MS).catch(() => []),
  ]);
  return { ventas: ventasMes || [], cotizaciones: cotizMes || [] };
});

get('/api/ventas/ranking-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.CLIENTE_ID, c.NOMBRE, COALESCE(SUM(d.IMPORTE_NETO),0) AS VENTA
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY VENTA DESC
  `, f.params).catch(() => []);
});

// Cobradas: respeta filtros de tiempo (desde/hasta o anio/mes) y vendedor; por defecto mes actual
get('/api/ventas/cobradas', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const fCc = buildFiltros(req, 'dc');
  const tipo = getTipo(req);
  const vendedorQ = req.query.vendedor ? ` AND d.VENDEDOR_ID = ${parseInt(req.query.vendedor)}` : '';
  const [rows, cobrosRow] = await Promise.all([
    query(`
      SELECT d.VENDEDOR_ID, v.NOMBRE AS VENDEDOR, COUNT(DISTINCT d.FOLIO) AS NUM_FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_VENTA
      FROM ${ventasSub(tipo)} d
      LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
      WHERE d.VENDEDOR_ID > 0 ${f.sql} ${vendedorQ}
      GROUP BY d.VENDEDOR_ID, v.NOMBRE
    `, f.params).catch(() => []),
    query(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      FROM IMPORTES_DOCTOS_CC i
      JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
      WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${fCc.sql}
    `, fCc.params).catch(() => [{ TOTAL_COBRADO: 0 }]),
  ]);
  const totalCobradoReal = +(cobrosRow && cobrosRow[0] && cobrosRow[0].TOTAL_COBRADO) || 0;
  const totalFacturado = (rows || []).reduce((s, r) => s + (+r.TOTAL_VENTA || 0), 0);
  const mapped = (rows || []).map(r => ({
    VENDEDOR_ID: r.VENDEDOR_ID,
    VENDEDOR: r.VENDEDOR,
    NOMBRE: r.VENDEDOR,
    NUM_FACTURAS: r.NUM_FACTURAS,
    FACTURAS_COBRADAS: r.NUM_FACTURAS,
    TOTAL_VENTA: +r.TOTAL_VENTA || 0,
    TOTAL_COBRADO: totalCobradoReal > 0 && totalFacturado > 0 ? Math.round((+r.TOTAL_VENTA || 0) / totalFacturado * totalCobradoReal * 100) / 100 : +r.TOTAL_VENTA || 0,
  }));
  return { vendedores: mapped, totalFacturado, totalCobrado: totalCobradoReal };
});

get('/api/ventas/margen', async (req) => {
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COALESCE(SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)), 0) AS MARGEN,
      COALESCE(SUM(det.PRECIO_TOTAL), 0) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
  `, f.params).catch(() => []);
});

get('/api/ventas/margen-articulos', async (req) => {
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)) AS MARGEN, SUM(det.PRECIO_TOTAL) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C' ${f.sql}
    GROUP BY a.ARTICULO_ID, a.DESCRIPCION ORDER BY MARGEN DESC
  `, f.params).catch(() => []);
});

get('/api/ventas/cotizaciones', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = String(now.getFullYear());
    req.query.mes = String(now.getMonth() + 1);
  }
  const { sql, params } = cotizacionesFechaWhere(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 2000);
  return query(`
    SELECT FIRST ${limit}
      d.DOCTO_VE_ID, d.FECHA, d.FOLIO, d.IMPORTE_NETO, d.CLIENTE_ID, c.NOMBRE AS CLIENTE,
      d.VENDEDOR_ID, v.NOMBRE AS VENDEDOR
    FROM DOCTOS_VE d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${SQL_COTI_TIPO}
      AND ${SQL_COTI_NO_CANCEL}
      ${sql}
    ORDER BY d.FECHA DESC
  `, params, COTI_QUERY_MS).catch(() => []);
});

get('/api/ventas/vendedores', async () => {
  return query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`).catch(() => []);
});

get('/api/ventas/diario', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  VENTAS — CUMPLIMIENTO (con filtros anio, mes, vendedor)
// ═══════════════════════════════════════════════════════════

get('/api/ventas/cumplimiento', async (req) => {
  const f = buildFiltros(req, 'd');
  const anioQ = req.query.anio ? parseInt(req.query.anio) : null;
  const mesQ = req.query.mes ? parseInt(req.query.mes) : null;
  const vendedorQ = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const desde = req.query.desde;
  const hasta = req.query.hasta;

  const [metas] = await query(`SELECT COALESCE(MAX(META_DIARIA_POR_VENDEDOR),0) AS META_DIA, COALESCE(MAX(META_IDEAL_POR_VENDEDOR),0) AS META_IDEAL FROM CONFIGURACIONES_GEN`).catch(() => [{ META_DIA: 5650, META_IDEAL: 6500 }]);
  const metaDia = +(metas && metas.META_DIA) || 5650;
  const metaIdeal = +(metas && metas.META_IDEAL) || 6500;

  let condAnioMes = 'EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)';
  let diasTranscurridos = 22;
  if (desde && hasta && /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    condAnioMes = `CAST(d.FECHA AS DATE) >= CAST('${desde}' AS DATE) AND CAST(d.FECHA AS DATE) <= CAST('${hasta}' AS DATE)`;
    diasTranscurridos = Math.ceil((new Date(hasta) - new Date(desde)) / 86400000) + 1;
    diasTranscurridos = Math.min(Math.max(diasTranscurridos, 1), 31);
  } else if (anioQ) {
    condAnioMes = `EXTRACT(YEAR FROM d.FECHA) = ${anioQ}`;
    if (mesQ) {
      condAnioMes += ` AND EXTRACT(MONTH FROM d.FECHA) = ${mesQ}`;
      const daysInMonth = new Date(anioQ, mesQ, 0).getDate();
      const today = new Date();
      diasTranscurridos = (anioQ === today.getFullYear() && mesQ === today.getMonth() + 1) ? today.getDate() : daysInMonth;
    } else {
      const today = new Date();
      diasTranscurridos = (anioQ === today.getFullYear()) ? Math.ceil((today - new Date(anioQ, 0, 1)) / 86400000) + 1 : 365;
    }
  }

  const condVendedor = vendedorQ ? ` AND d.VENDEDOR_ID = ${vendedorQ}` : '';
  const anioExpr = anioQ || 'EXTRACT(YEAR FROM CURRENT_DATE)';

  const ventas = await query(`
    SELECT d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = ${anioExpr} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_YTD,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub()} d
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    GROUP BY d.VENDEDOR_ID
  `).catch(() => []);

  const ventaMap = {};
  (ventas || []).forEach(v => { ventaMap[v.VENDEDOR_ID] = v; });

  const rows = await query(`
    SELECT DISTINCT d.VENDEDOR_ID, COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS NOMBRE
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    ORDER BY 2
  `).catch(() => []);

  const metaMes = metaDia * Math.max(diasTranscurridos, 1);
  const rowsMapped = (rows || []).map(v => {
    const d = ventaMap[v.VENDEDOR_ID] || {};
    return {
      NOMBRE: v.NOMBRE,
      VENDEDOR_ID: v.VENDEDOR_ID,
      VENTA_HOY: +d.VENTA_HOY || 0,
      VENTA_MES: +d.VENTA_MES || 0,
      VENTA_YTD: +d.VENTA_YTD || 0,
      FACTURAS_HOY: +d.FACTURAS_HOY || 0,
      FACTURAS_MES: +d.FACTURAS_MES || 0,
    };
  }).sort((a, b) => b.VENTA_MES - a.VENTA_MES);

  return rowsMapped.map(r => ({
    ...r,
    META_DIA: metaDia,
    META_MES: metaMes,
    META_IDEAL: metaIdeal,
    PCT_HOY: metaDia > 0 ? Math.round(+r.VENTA_HOY / metaDia * 100) : 0,
    PCT_MES: metaMes > 0 ? Math.round(+r.VENTA_MES / metaMes * 100) : 0,
    DIAS_TRANSCURRIDOS: diasTranscurridos,
    STATUS_HOY: metaDia > 0 ? (+r.VENTA_HOY >= metaDia ? 'OK' : +r.VENTA_HOY >= metaDia * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
    STATUS_MES: metaMes > 0 ? (+r.VENTA_MES >= metaMes ? 'OK' : +r.VENTA_MES >= metaMes * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
  }));
});

// ═══════════════════════════════════════════════════════════
//  DIRECTOR
// ═══════════════════════════════════════════════════════════

// director.html espera: dir.ventas (HOY, MES_ACTUAL, FACTURAS_MES, MES_VE, MES_PV), dir.cxc, dir.cotizaciones
// Respeta preset/filtro de fechas: ventas y cotizaciones del periodo (desde/hasta o anio/mes).
// Cotizaciones: DOCTOS_VE TIPO_DOCTO='C' ESTATUS<>'C' SUM(IMPORTE_NETO); mismo criterio que Power BI si BI usa igual (ver COTIZACIONES_WEB_VS_POWERBI.md).
get('/api/director/resumen', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  // Ventas: dos consultas VE/PV en paralelo (evita UNION lento sobre tablas grandes).
  const fDir = buildFiltros(req, 'd');
  const imp = sqlVentaImporteBaseExpr('d');
  const wVe = sqlWhereVentasDocumentoValido('d');
  const wPv = sqlWhereVentasDocumentoValido('d');
  const selDir = `
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN ${imp} ELSE 0 END) AS HOY,
      COALESCE(SUM(${imp}), 0) AS MES_ACTUAL,
      COUNT(*) AS FACTURAS_MES
  `;
  const settled = await Promise.allSettled([
    Promise.all([
      query(`SELECT ${selDir} FROM DOCTOS_VE d WHERE ${wVe} ${fDir.sql}`, fDir.params, DIRECTOR_VENTAS_MS).catch(() => [{}]),
      query(`SELECT ${selDir} FROM DOCTOS_PV d WHERE ${wPv} ${fDir.sql}`, fDir.params, DIRECTOR_VENTAS_MS).catch(() => [{}]),
    ]).then(([rVe, rPv]) => {
      const a = rVe[0] || {};
      const b = rPv[0] || {};
      return [{
        HOY: (+a.HOY || 0) + (+b.HOY || 0),
        MES_ACTUAL: (+a.MES_ACTUAL || 0) + (+b.MES_ACTUAL || 0),
        FACTURAS_MES: (+a.FACTURAS_MES || 0) + (+b.FACTURAS_MES || 0),
        MES_VE: +a.MES_ACTUAL || 0,
        MES_PV: +b.MES_ACTUAL || 0,
      }];
    }),
    query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs`, [], DIRECTOR_CXC_MS).catch(() => []),
    query(`SELECT cd.CLIENTE_ID, SUM(cd.SALDO) AS TOTAL_C, SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C FROM ${cxcCargosSQL()} cd GROUP BY cd.CLIENTE_ID`, [], DIRECTOR_CXC_MS).catch(() => []),
    cotizacionesResumenAgregado(req),
  ]);
  const val = (i, fb) => (settled[i] && settled[i].status === 'fulfilled' ? settled[i].value : fb);
  const vRow = val(0, [{}]);
  const cxcSaldos = val(1, []);
  const cxcAging = val(2, []);
  const coAgg = val(3, { ...COTI_RESUMEN_VACIO });
  const agMap = {};
  (cxcAging || []).forEach(r => { agMap[r.CLIENTE_ID] = r; });
  let saldoTotal = 0, vencido = 0, porVencer = 0;
  (cxcSaldos || []).forEach(r => {
    const saldo = +r.SALDO || 0;
    saldoTotal += saldo;
    const ag = agMap[r.CLIENTE_ID];
    if (ag && +ag.TOTAL_C > 0) {
      const pct = Math.min(+ag.VENC_C / +ag.TOTAL_C, 1);
      vencido += saldo * pct;
      porVencer += saldo * (1 - pct);
    } else porVencer += saldo;
  });
  const v = vRow[0] || {};
  const coDir = cotizacionesParaDirector(coAgg);
  return {
    ventas: { HOY: +(v.HOY||0), MES_ACTUAL: +(v.MES_ACTUAL||0), FACTURAS_MES: +(v.FACTURAS_MES||0), MES_VE: +(v.MES_VE||0), MES_PV: +(v.MES_PV||0) },
    cxc: { SALDO_TOTAL: Math.round(saldoTotal*100)/100, NUM_CLIENTES: (cxcSaldos||[]).length, VENCIDO: Math.round(vencido*100)/100, POR_VENCER: Math.round(porVencer*100)/100 },
    cotizaciones: {
      COTI_HOY: +(coDir.COTI_HOY || 0),
      IMPORTE_COTI_HOY: +(coDir.IMPORTE_COTI_HOY || 0),
      IMPORTE_COTI_MES: +(coDir.IMPORTE_COTI_MES || 0),
      COTI_MES: +(coDir.COTI_MES || 0),
    },
  };
});

get('/api/director/ventas-diarias', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const rows = await query(`
    SELECT CAST(d.FECHA AS DATE) AS DIA,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS
    FROM ${ventasSub()} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, [desdeStr]).catch(() => []);

  // Meta diaria (DAX: Meta Ventas Diaria Vendedor × 1.30 para ideal). Día laboral = Lun–Sáb (domingo = 0).
  const numV = await query(`SELECT COUNT(*) AS N FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N')`)
    .then(r => (r[0] && r[0].N != null) ? Number(r[0].N) : 1)
    .catch(() => 1);
  const META_POR_DIA = 5650;
  const FACTOR_IDEAL = 1.30;

  (rows || []).forEach(r => {
    const d = r.DIA ? new Date(r.DIA) : new Date();
    const laboral = d.getDay() !== 0; // 0 = domingo → meta 0
    const metaEq = laboral ? META_POR_DIA * numV : 0;
    r.META_EQUILIBRIO = Math.round(metaEq * 100) / 100;
    r.META_IDEAL = Math.round(metaEq * FACTOR_IDEAL * 100) / 100;
  });

  return rows;
});

// director.html espera CLIENTE, TOTAL_VENTAS, NUM_FACTURAS
get('/api/director/top-clientes', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 15, 50);
  return query(`
    SELECT FIRST ${limit} d.CLIENTE_ID, COALESCE(c.NOMBRE, 'Sin nombre') AS CLIENTE,
      COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_VENTAS, COUNT(*) AS NUM_FACTURAS
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 AND EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL_VENTAS DESC
  `).catch(() => []);
});

// director.html e index.html (Inicio): listado de vendedores con ventas en el periodo.
// Acepta desde, hasta, anio, mes. Si no hay fechas, se usa mes actual (comportamiento original).
get('/api/director/vendedores', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const rows = await query(`
    SELECT d.VENDEDOR_ID, COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS VENDEDOR,
      COUNT(*) AS FACTURAS_MES, COALESCE(SUM(d.IMPORTE_NETO),0) AS VENTAS_MES
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE ORDER BY VENTAS_MES DESC
  `, f.params).catch(() => []);
  return rows;
});

// director.html espera FOLIO, TIPO_SRC, CLIENTE, VENDEDOR, TOTAL, FECHA
get('/api/director/recientes', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT FIRST ${limit} d.FOLIO, d.TIPO_SRC, COALESCE(c.NOMBRE, 'Sin cliente') AS CLIENTE, COALESCE(v.NOMBRE, 'Sin vendedor') AS VENDEDOR, d.IMPORTE_NETO AS TOTAL, d.FECHA
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    ORDER BY d.FECHA DESC, d.FOLIO DESC
  `).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CXC
// ═══════════════════════════════════════════════════════════

// Subconsulta: una fila por documento con DIAS_VENCIDO y SALDO_NETO (Cargo − Cobro), como Power BI Saldo_Documento.
// Incluye Contado (igual que Power BI). Solo documentos con saldo > 0.
function cxcDocSaldosSQL(cfSql) {
  return `(
    SELECT d.CLIENTE_ID, d.DIAS_VENCIDO,
      CAST(
        COALESCE((SELECT SUM(i.IMPORTE) FROM IMPORTES_DOCTOS_CC i
          WHERE i.DOCTO_CC_ID = d.DOCTO_CC_ID AND i.TIPO_IMPTE = 'C' AND COALESCE(i.CANCELADO,'N') = 'N'), 0)
        - COALESCE((SELECT SUM(CASE WHEN COALESCE(i2.IMPUESTO,0) > 0 THEN i2.IMPORTE ELSE i2.IMPORTE/1.16 END)
          FROM IMPORTES_DOCTOS_CC i2
          WHERE i2.DOCTO_CC_ACR_ID = d.DOCTO_CC_ID AND i2.TIPO_IMPTE = 'R' AND COALESCE(i2.CANCELADO,'N') = 'N'), 0)
      AS DECIMAL(18,2)) AS SALDO_NETO
    FROM (
      SELECT cd.DOCTO_CC_ID, cd.CLIENTE_ID, cd.DIAS_VENCIDO
      FROM ${cxcCargosSQL()} cd
      WHERE 1=1 ${cfSql}
      GROUP BY cd.DOCTO_CC_ID, cd.CLIENTE_ID, cd.DIAS_VENCIDO
    ) d
  ) doc WHERE doc.SALDO_NETO > 0`;
}

// Resumen CxC: Vencido y No vencido como Power BI (suma de Saldo_Documento por doc vencido/vigente). Incluye Contado.
get('/api/cxc/resumen', async (req) => {
  const cf = req.query.cliente ? parseInt(req.query.cliente) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const [totales, numCli] = await Promise.all([
    query(`
      SELECT
        SUM(CASE WHEN doc.DIAS_VENCIDO >= 1 THEN doc.SALDO_NETO ELSE 0 END) AS VENCIDO,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS POR_VENCER
      FROM ${cxcDocSaldosSQL(cfSql)}
    `, [], CXC_RESUMEN_MS).catch(() => [{ VENCIDO: 0, POR_VENCER: 0 }]),
    query(`SELECT COUNT(DISTINCT doc.CLIENTE_ID) AS N FROM ${cxcDocSaldosSQL(cfSql)}`, [], CXC_RESUMEN_MS).catch(() => [{ N: 0 }]),
  ]);
  const vencido = +(totales[0] && totales[0].VENCIDO) || 0;
  const porVencer = +(totales[0] && totales[0].POR_VENCER) || 0;
  const saldoTotal = vencido + porVencer;
  return {
    SALDO_TOTAL  : Math.round(saldoTotal * 100) / 100,
    NUM_CLIENTES : +(numCli[0] && numCli[0].N) || 0,
    VENCIDO      : Math.round(vencido   * 100) / 100,
    POR_VENCER   : Math.round(porVencer * 100) / 100,
  };
});

// Aging por documento: suma de Saldo_Documento por rango de días (igual que Power BI). Buckets suman = SALDO_TOTAL.
get('/api/cxc/aging', async (req) => {
  const cf = req.query.cliente ? parseInt(req.query.cliente) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const rows = await query(`
    SELECT
      SUM(CASE WHEN doc.DIAS_VENCIDO <= 0               THEN doc.SALDO_NETO ELSE 0 END) AS CORRIENTE,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN  1 AND  30 THEN doc.SALDO_NETO ELSE 0 END) AS DIAS_1_30,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 31 AND  60 THEN doc.SALDO_NETO ELSE 0 END) AS DIAS_31_60,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 61 AND  90 THEN doc.SALDO_NETO ELSE 0 END) AS DIAS_61_90,
      SUM(CASE WHEN doc.DIAS_VENCIDO > 90               THEN doc.SALDO_NETO ELSE 0 END) AS DIAS_MAS_90
    FROM ${cxcDocSaldosSQL(cfSql)}
  `).catch(() => [{ CORRIENTE: 0, DIAS_1_30: 0, DIAS_31_60: 0, DIAS_61_90: 0, DIAS_MAS_90: 0 }]);
  const r = rows[0] || {};
  return {
    CORRIENTE  : Math.round((+r.CORRIENTE   || 0) * 100) / 100,
    DIAS_1_30  : Math.round((+r.DIAS_1_30   || 0) * 100) / 100,
    DIAS_31_60 : Math.round((+r.DIAS_31_60  || 0) * 100) / 100,
    DIAS_61_90 : Math.round((+r.DIAS_61_90  || 0) * 100) / 100,
    DIAS_MAS_90: Math.round((+r.DIAS_MAS_90 || 0) * 100) / 100,
  };
});

// Facturas vencidas: una fila por documento, SALDO = saldo neto (Cargo − Cobro) como Power BI Saldo_Documento.
get('/api/cxc/vencidas', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const cf = req.query.cliente ? ` AND d.CLIENTE_ID = ${parseInt(req.query.cliente)}` : '';
  return query(`
    SELECT FIRST ${limit}
      d.FOLIO,
      c.NOMBRE AS CLIENTE,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      CAST((
        COALESCE((SELECT SUM(i.IMPORTE) FROM IMPORTES_DOCTOS_CC i
          WHERE i.DOCTO_CC_ID = d.DOCTO_CC_ID AND i.TIPO_IMPTE = 'C' AND COALESCE(i.CANCELADO,'N') = 'N'), 0)
        - COALESCE((SELECT SUM(CASE WHEN COALESCE(i2.IMPUESTO,0) > 0 THEN i2.IMPORTE ELSE i2.IMPORTE / 1.16 END)
          FROM IMPORTES_DOCTOS_CC i2
          WHERE i2.DOCTO_CC_ACR_ID = d.DOCTO_CC_ID AND i2.TIPO_IMPTE = 'R' AND COALESCE(i2.CANCELADO,'N') = 'N'), 0)
      ) AS DECIMAL(18,2)) AS SALDO,
      d.DIAS_VENCIDO AS ATRASO,
      d.DIAS_VENCIDO AS DIAS_ATRASO,
      d.FECHA_VENCIMIENTO
    FROM (
      SELECT cd.DOCTO_CC_ID, cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO
      FROM ${cxcCargosSQL()} cd
      WHERE cd.DIAS_VENCIDO > 0 ${cf}
      GROUP BY cd.DOCTO_CC_ID, cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO
    ) d
    JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = d.DOCTO_CC_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
    WHERE (
      COALESCE((SELECT SUM(i.IMPORTE) FROM IMPORTES_DOCTOS_CC i
        WHERE i.DOCTO_CC_ID = d.DOCTO_CC_ID AND i.TIPO_IMPTE = 'C' AND COALESCE(i.CANCELADO,'N') = 'N'), 0)
      - COALESCE((SELECT SUM(CASE WHEN COALESCE(i2.IMPUESTO,0) > 0 THEN i2.IMPORTE ELSE i2.IMPORTE / 1.16 END)
        FROM IMPORTES_DOCTOS_CC i2
        WHERE i2.DOCTO_CC_ACR_ID = d.DOCTO_CC_ID AND i2.TIPO_IMPTE = 'R' AND COALESCE(i2.CANCELADO,'N') = 'N'), 0)
    ) > 0
    ORDER BY d.DIAS_VENCIDO DESC, 4 DESC
  `).catch(() => []);
});

// Top Deudores: saldo neto + condición + vencido proporcional al saldo (igual que /api/cxc/resumen). Acepta ?cliente= para filtrar.
get('/api/cxc/top-deudores', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const cf = req.query.cliente ? parseInt(req.query.cliente) : null;
  const cfSql = cf ? ` WHERE s.CLIENTE_ID = ${cf}` : '';
  const cfSql2 = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const [saldos, aging] = await Promise.all([
    query(`SELECT s.CLIENTE_ID, s.SALDO FROM ${cxcClienteSQL()} s ${cfSql}`).catch(() => []),
    query(`
      SELECT cd.CLIENTE_ID,
        SUM(cd.SALDO) AS TOTAL_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C,
        MAX(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS,
        COUNT(*) AS NUM_DOCS
      FROM ${cxcCargosSQL()} cd
      WHERE 1=1 ${cfSql2}
      GROUP BY cd.CLIENTE_ID
    `).catch(() => []),
  ]);
  const agingMap = {};
  aging.forEach(a => { agingMap[a.CLIENTE_ID] = a; });
  const clienteIds = saldos.map(s => s.CLIENTE_ID).filter(Boolean);
  if (!clienteIds.length) return [];
  const clientes = await query(`
    SELECT cl.CLIENTE_ID, cl.NOMBRE AS CLIENTE, COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO
    FROM CLIENTES cl
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = cl.COND_PAGO_ID
    WHERE cl.CLIENTE_ID IN (${clienteIds.join(',')})
  `).catch(() => []);
  const clMap = {};
  clientes.forEach(c => { clMap[c.CLIENTE_ID] = c; });
  const result = saldos
    .map(s => {
      const cl = clMap[s.CLIENTE_ID] || {};
      const ag = agingMap[s.CLIENTE_ID] || {};
      const saldo = +s.SALDO || 0;
      const totalC = +ag.TOTAL_C || 0;
      const vencC = +ag.VENC_C || 0;
      const pct = totalC > 0 ? Math.min(vencC / totalC, 1) : 0;
      const vencido = Math.round(saldo * pct * 100) / 100;
      return {
        CLIENTE_ID     : s.CLIENTE_ID,
        CLIENTE        : cl.CLIENTE || ('Cliente ' + s.CLIENTE_ID),
        CONDICION_PAGO : cl.CONDICION_PAGO || 'S/D',
        SALDO_TOTAL    : saldo,
        VENCIDO        : vencido,
        MAX_DIAS_ATRASO: +ag.MAX_DIAS || 0,
        NUM_DOCUMENTOS : +ag.NUM_DOCS || 0,
      };
    })
    .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL)
    .slice(0, limit);
  return result;
});

get('/api/cxc/historial', async (req) => {
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO, cd.SALDO
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ?
    ORDER BY cd.FECHA_VENCIMIENTO
  `, [cliente]).catch(() => []);
});

// Por Condición: saldo NETO por cliente (cargos − cobros), no suma de cargos. Cuadra con SALDO_TOTAL del resumen.
get('/api/cxc/por-condicion', async () => {
  const [saldos, aging, cargosCond] = await Promise.all([
    query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs`).catch(() => []),
    query(`
      SELECT cd.CLIENTE_ID,
        SUM(cd.SALDO) AS TOTAL_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C
      FROM ${cxcCargosSQL()} cd
      GROUP BY cd.CLIENTE_ID
    `).catch(() => []),
    query(`
      SELECT cd.CLIENTE_ID, COUNT(DISTINCT cd.DOCTO_CC_ID) AS NUM_DOCS
      FROM ${cxcCargosSQL()} cd
      GROUP BY cd.CLIENTE_ID
    `).catch(() => []),
  ]);
  const agMap = {}; aging.forEach(r => { agMap[r.CLIENTE_ID] = r; });
  const docMap = {}; cargosCond.forEach(r => { docMap[r.CLIENTE_ID] = +r.NUM_DOCS || 0; });
  const clienteIds = saldos.map(s => s.CLIENTE_ID).filter(Boolean);
  if (!clienteIds.length) return [];
  const clientes = await query(`
    SELECT cl.CLIENTE_ID, COALESCE(cp.NOMBRE, 'Sin condición') AS CONDICION_PAGO, COALESCE(cp.DIAS_PPAG, 0) AS DIAS_CREDITO
    FROM CLIENTES cl
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = cl.COND_PAGO_ID
    WHERE cl.CLIENTE_ID IN (${clienteIds.join(',')})
  `).catch(() => []);
  const byCond = {};
  saldos.forEach(r => {
    const saldo = +r.SALDO || 0;
    const ag = agMap[r.CLIENTE_ID] || {};
    const totalC = +ag.TOTAL_C || 0;
    const vencC = +ag.VENC_C || 0;
    const pct = totalC > 0 ? Math.min(vencC / totalC, 1) : 0;
    const vencido = saldo * pct;
    const corriente = saldo - vencido;
    const cl = clientes.find(c => c.CLIENTE_ID === r.CLIENTE_ID) || {};
    const key = (cl.CONDICION_PAGO || 'Sin condición') + '|' + (cl.DIAS_CREDITO ?? 0);
    if (!byCond[key]) {
      byCond[key] = { CONDICION_PAGO: cl.CONDICION_PAGO || 'Sin condición', DIAS_CREDITO: +cl.DIAS_CREDITO || 0, NUM_CLIENTES: 0, NUM_DOCUMENTOS: 0, SALDO_TOTAL: 0, VENCIDO: 0, CORRIENTE: 0 };
    }
    byCond[key].NUM_CLIENTES += 1;
    byCond[key].NUM_DOCUMENTOS += docMap[r.CLIENTE_ID] || 0;
    byCond[key].SALDO_TOTAL += saldo;
    byCond[key].VENCIDO += vencido;
    byCond[key].CORRIENTE += corriente;
  });
  return Object.values(byCond)
    .map(r => ({
      CONDICION_PAGO : r.CONDICION_PAGO,
      DIAS_CREDITO   : r.DIAS_CREDITO,
      NUM_CLIENTES   : r.NUM_CLIENTES,
      NUM_DOCUMENTOS : r.NUM_DOCUMENTOS,
      SALDO_TOTAL    : Math.round(r.SALDO_TOTAL * 100) / 100,
      VENCIDO        : Math.round(r.VENCIDO * 100) / 100,
      CORRIENTE      : Math.round(r.CORRIENTE * 100) / 100,
    }))
    .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);
});

// Calendario Pagos / Buro: por documento, con CLIENTE, ANIO, MES_EMISION, saldo restante, fechas. Sin ?cliente= devuelve todos.
// Si ?saldos_actuales=1 devuelve { rows, saldosPorCliente } para que el front muestre deuda actual sin depender del filtro meses.
get('/api/cxc/historial-pagos', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 300, 500);
  const meses = Math.min(parseInt(req.query.meses) || 12, 24);
  const saldosActuales = req.query.saldos_actuales === '1' || req.query.saldos_actuales === 'true';
  const clienteFiltro = req.query.cliente ? ` AND cl.CLIENTE_ID = ${parseInt(req.query.cliente)}` : '';
  const rows = await query(`
    SELECT FIRST ${limit}
      dc.DOCTO_CC_ID,
      dc.FOLIO,
      cl.NOMBRE                                                         AS CLIENTE,
      cl.CLIENTE_ID,
      COALESCE(cp.NOMBRE, 'S/D')                                        AS CONDICION_PAGO,
      CAST(dc.FECHA AS DATE)                                            AS FECHA_EMISION,
      CAST(COALESCE(MIN(vc.FECHA_VENCIMIENTO), CAST(dc.FECHA AS DATE) + CAST(COALESCE(NULLIF(cp.DIAS_PPAG, 0), 30) AS INTEGER)) AS DATE) AS FECHA_VENCIMIENTO,
      SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE ELSE 0 END)       AS CARGO_ORIGINAL,
      SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN i.IMPORTE ELSE 0 END)       AS TOTAL_COBRADO,
      SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE WHEN i.TIPO_IMPTE = 'R' THEN -i.IMPORTE ELSE 0 END) AS SALDO_RESTANTE,
      MAX(CASE WHEN i.TIPO_IMPTE = 'R' THEN CAST(i.FECHA AS DATE) END)   AS FECHA_ULTIMO_PAGO,
      EXTRACT(YEAR FROM dc.FECHA)                                       AS ANIO,
      EXTRACT(MONTH FROM dc.FECHA)                                      AS MES_EMISION
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    JOIN CLIENTES cl ON cl.CLIENTE_ID = dc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
    LEFT JOIN VENCIMIENTOS_CARGOS_CC vc ON vc.DOCTO_CC_ID = i.DOCTO_CC_ID
    WHERE COALESCE(i.CANCELADO, 'N') = 'N'
      AND dc.FECHA >= (CURRENT_DATE - ${meses * 31})
      ${clienteFiltro}
    GROUP BY dc.DOCTO_CC_ID, dc.FOLIO, cl.NOMBRE, cl.CLIENTE_ID, cp.NOMBRE, cp.DIAS_PPAG, dc.FECHA
    HAVING SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE ELSE 0 END) > 0
    ORDER BY dc.FECHA DESC
  `).catch(() => []);
  if (!saldosActuales || !rows || !rows.length) return rows || [];
  const ids = [...new Set((rows || []).map(r => r.CLIENTE_ID).filter(Boolean))];
  if (!ids.length) return { rows, saldosPorCliente: {} };
  let saldosPorCliente = {};
  try {
    const saldosRows = await query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs WHERE cs.CLIENTE_ID IN (${ids.join(',')})`).catch(() => []);
    (saldosRows || []).forEach(r => { saldosPorCliente[r.CLIENTE_ID] = +r.SALDO || 0; });
  } catch (_) { /* si falla saldos, igual devolver rows */ }
  return { rows, saldosPorCliente };
});

get('/api/cxc/comportamiento-pago', async (req) => {
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, AVG(cd.DIAS_VENCIDO) AS PROMEDIO_DIAS_VENCIDO, COUNT(*) AS DOCS_VENCIDOS
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ? AND cd.DIAS_VENCIDO > 0
    GROUP BY cd.CLIENTE_ID
  `, [cliente]).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  INVENTARIO — Microsip: SALDOS_IN, NIVELES_ARTICULOS, PRECIOS_ARTICULOS
// ═══════════════════════════════════════════════════════════
const SQL_EXIST_SUB = `( SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS EXISTENCIA FROM SALDOS_IN GROUP BY ARTICULO_ID )`;
const SQL_MINIMO_SUB = `( SELECT ARTICULO_ID, MAX(INVENTARIO_MINIMO) AS INVENTARIO_MINIMO FROM NIVELES_ARTICULOS WHERE INVENTARIO_MINIMO > 0 GROUP BY ARTICULO_ID )`;
const SQL_PRECIO_SUB = `( SELECT ARTICULO_ID, MIN(PRECIO) AS PRECIO1 FROM PRECIOS_ARTICULOS WHERE MONEDA_ID = 1 AND PRECIO > 0 GROUP BY ARTICULO_ID )`;

// SIN_STOCK = solo articulos con minimo definido y existencia 0 (alerta real). No contar todo el catalogo en cero.
get('/api/inv/resumen', async () => {
  const rows = await query(`
    SELECT
      COUNT(DISTINCT a.ARTICULO_ID) AS TOTAL_ARTICULOS,
      SUM(CASE WHEN COALESCE(s.EXISTENCIA, 0) < COALESCE(n.INVENTARIO_MINIMO, 0) AND COALESCE(n.INVENTARIO_MINIMO, 0) > 0 THEN 1 ELSE 0 END) AS BAJO_MINIMO,
      SUM(COALESCE(s.EXISTENCIA, 0) * COALESCE(pr.PRECIO1, 0)) AS VALOR_INVENTARIO,
      SUM(CASE WHEN COALESCE(n.INVENTARIO_MINIMO, 0) > 0 AND COALESCE(s.EXISTENCIA, 0) <= 0 THEN 1 ELSE 0 END) AS SIN_STOCK
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_PRECIO_SUB} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A'
  `).catch(() => [{}]);
  const r = rows[0] || {};
  return { TOTAL_ARTICULOS: +(r.TOTAL_ARTICULOS||0), VALOR_INVENTARIO: +(r.VALOR_INVENTARIO||0), BAJO_MINIMO: +(r.BAJO_MINIMO||0), SIN_STOCK: +(r.SIN_STOCK||0) };
});

get('/api/inv/bajo-minimo', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const q = (req.query.q || '').trim().toUpperCase();
  const extra = q.length >= 2 ? ` AND UPPER(a.NOMBRE) LIKE '%${q.replace(/'/g, "''")}%'` : '';
  return query(`
    SELECT FIRST ${limit} a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA, n.INVENTARIO_MINIMO AS EXISTENCIA_MINIMA,
      (n.INVENTARIO_MINIMO - COALESCE(s.EXISTENCIA, 0)) AS FALTANTE
    FROM ARTICULOS a
    JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(s.EXISTENCIA, 0) < n.INVENTARIO_MINIMO ${extra}
    ORDER BY FALTANTE DESC
  `).catch(() => []);
});

get('/api/inv/existencias', async (req) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const like = `%${q.toUpperCase().replace(/'/g, "''")}%`;
  return query(`
    SELECT FIRST 50 a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA, COALESCE(n.INVENTARIO_MINIMO, 0) AS EXISTENCIA_MINIMA, COALESCE(pr.PRECIO1, 0) AS PRECIO_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_PRECIO_SUB} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND (UPPER(a.NOMBRE) LIKE ? OR UPPER(CAST(a.ARTICULO_ID AS VARCHAR(50))) LIKE ?)
    ORDER BY a.NOMBRE
  `, [like, like]).catch(() => []);
});

get('/api/inv/top-stock', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT FIRST ${limit} a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA, COALESCE(s.EXISTENCIA, 0) * COALESCE(pr.PRECIO1, 0) AS VALOR_TOTAL, COALESCE(pr.PRECIO1, 0) AS PRECIO_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_PRECIO_SUB} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(s.EXISTENCIA, 0) > 0
    ORDER BY VALOR_TOTAL DESC
  `).catch(() => []);
});

// Consumo semanal desde ventas (DOCTOS_VE_DET) — inventario.html espera DESCRIPCION, EXISTENCIA, CONSUMO_SEMANAL_PROM, SEMANAS_STOCK
get('/api/inv/consumo-semanal', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA,
      SUM(det.UNIDADES) / 4.0 AS CONSUMO_SEMANAL_PROM,
      CASE WHEN SUM(det.UNIDADES) > 0 THEN COALESCE(s.EXISTENCIA, 0) / (SUM(det.UNIDADES) / 4.0) ELSE 9999 END AS SEMANAS_STOCK
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    WHERE (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C') OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
      AND d.FECHA >= (CURRENT_DATE - 28)
    GROUP BY a.NOMBRE, a.ARTICULO_ID, s.EXISTENCIA
    HAVING SUM(det.UNIDADES) > 0
    ORDER BY SEMANAS_STOCK ASC
  `).catch(() => []);
});

// Forecast consumo — inventario.html espera DESCRIPCION, UNIDAD, EXISTENCIA_ACTUAL, CONSUMO_DIARIO, DIAS_STOCK, STOCK_MINIMO_RECOMENDADO, ALERTA, CANTIDAD_REPONER
get('/api/inv/consumo', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 90, 365);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const lead = Math.min(parseInt(req.query.lead) || 15, 60);
  const rows = await query(`
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL, COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      SUM(det.UNIDADES) AS CONSUMO_PERIODO, SUM(det.UNIDADES) / ${dias}.0 AS CONSUMO_DIARIO,
      CASE WHEN SUM(det.UNIDADES) > 0 THEN CAST(COALESCE(ex.EXISTENCIA, 0) / (SUM(det.UNIDADES) / ${dias}.0) AS INTEGER) ELSE 9999 END AS DIAS_STOCK,
      CASE WHEN SUM(det.UNIDADES) > 0 THEN CAST(SUM(det.UNIDADES) / ${dias}.0 * ${lead} + 0.9999 AS INTEGER) ELSE 0 END AS STOCK_MINIMO_RECOMENDADO
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    WHERE (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C') AND d.FECHA >= (CURRENT_DATE - ${dias}) AND COALESCE(a.ESTATUS, 'A') = 'A'
    GROUP BY a.NOMBRE, a.ARTICULO_ID, a.UNIDAD_VENTA, ex.EXISTENCIA, mn.INVENTARIO_MINIMO
    HAVING SUM(det.UNIDADES) > 0
    ORDER BY DIAS_STOCK ASC
  `).catch(() => []);
  return rows.map(r => ({
    ...r,
    ALERTA: +r.DIAS_STOCK < lead ? 'CRITICO' : +r.DIAS_STOCK < lead * 2 ? 'BAJO' : +r.EXISTENCIA_ACTUAL <= +r.MIN_ACTUAL ? 'BAJO_MINIMO' : 'OK',
    NECESITA_REPONER: +r.EXISTENCIA_ACTUAL < +r.STOCK_MINIMO_RECOMENDADO,
    CANTIDAD_REPONER: Math.max(0, +r.STOCK_MINIMO_RECOMENDADO - +r.EXISTENCIA_ACTUAL),
  }));
});

get('/api/inv/sin-movimiento', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 180, 730);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  return query(`
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL, COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      MAX(CAST(d.FECHA AS DATE)) AS ULTIMO_MOVIMIENTO, (CURRENT_DATE - MAX(CAST(d.FECHA AS DATE))) AS DIAS_SIN_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN DOCTOS_VE_DET det ON det.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN DOCTOS_VE d ON d.DOCTO_VE_ID = det.DOCTO_VE_ID AND (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(ex.EXISTENCIA, 0) > 0
    GROUP BY a.NOMBRE, a.ARTICULO_ID, a.UNIDAD_VENTA, ex.EXISTENCIA, mn.INVENTARIO_MINIMO
    HAVING (MAX(CAST(d.FECHA AS DATE)) IS NULL) OR ((CURRENT_DATE - MAX(CAST(d.FECHA AS DATE))) > ${dias})
    ORDER BY 7 DESC NULLS FIRST, ex.EXISTENCIA DESC
  `).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CLIENTES (riesgo, inactivos, resumen-riesgo)
// ═══════════════════════════════════════════════════════════

get('/api/clientes/riesgo', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  return query(`
    SELECT cd.CLIENTE_ID, c.NOMBRE, SUM(cd.SALDO) AS SALDO, MAX(cd.DIAS_VENCIDO) AS MAX_DIAS_VENCIDO
    FROM ${cxcCargosSQL()} cd
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
    WHERE cd.DIAS_VENCIDO > 0
    GROUP BY cd.CLIENTE_ID, c.NOMBRE ORDER BY MAX_DIAS_VENCIDO DESC
  `).catch(() => []);
});

get('/api/clientes/inactivos', async (req) => {
  const meses = Math.min(parseInt(req.query.meses) || 12, 24);
  return query(`
    SELECT c.CLIENTE_ID, c.NOMBRE
    FROM CLIENTES c
    WHERE NOT EXISTS (
      SELECT 1 FROM DOCTOS_VE d
      WHERE d.CLIENTE_ID = c.CLIENTE_ID AND d.FECHA >= (CURRENT_DATE - ?)
    )
  `, [meses * 31]).catch(() => []);
});

get('/api/clientes/resumen-riesgo', async () => {
  const defaultRes = { TOTAL_EN_RIESGO: 0, MONTO_CRITICO: 0, MONTO_ALTO: 0, MONTO_MEDIO: 0, MONTO_LEVE: 0 };
  try {
    const [totales] = await query(`
      SELECT COUNT(DISTINCT cd.CLIENTE_ID) AS TOTAL_EN_RIESGO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS MONTO_CRITICO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 60 AND cd.DIAS_VENCIDO <= 90 THEN cd.SALDO ELSE 0 END) AS MONTO_ALTO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 30 AND cd.DIAS_VENCIDO <= 60 THEN cd.SALDO ELSE 0 END) AS MONTO_MEDIO,
        SUM(CASE WHEN cd.DIAS_VENCIDO <= 30 THEN cd.SALDO ELSE 0 END) AS MONTO_LEVE
      FROM ${cxcCargosSQL()} cd WHERE cd.DIAS_VENCIDO > 0
    `).catch(() => [null]);
    return { ...defaultRes, ...(totales || {}) };
  } catch (e) {
    return defaultRes;
  }
});

// ═══════════════════════════════════════════════════════════
//  RESULTADOS (P&L) — resultados.html espera meses[], totales{}, tiene_costo
// ═══════════════════════════════════════════════════════════

get('/api/resultados/pnl', async (req) => {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr, hastaStr;
  const { desde, hasta, anio, mes } = req.query;
  if (desde && reDate.test(desde) && hasta && reDate.test(hasta)) {
    desdeStr = desde;
    hastaStr = hasta;
  } else if (anio) {
    const y = parseInt(anio);
    const m = mes ? parseInt(mes) : null;
    if (m) {
      desdeStr = y + '-' + String(m).padStart(2, '0') + '-01';
      const lastDay = new Date(y, m, 0);
      hastaStr = y + '-' + String(m).padStart(2, '0') + '-' + String(lastDay.getDate()).padStart(2, '0');
    } else {
      desdeStr = y + '-01-01';
      hastaStr = y + '-12-31';
    }
  }
  if (!desdeStr) {
    const mesesN = Math.min(Math.max(parseInt(req.query.meses) || 3, 1), 24);
    const d = new Date();
    d.setMonth(d.getMonth() - mesesN);
    desdeStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    hastaStr = new Date().toISOString().slice(0, 10);
  }
  const dateParams = [desdeStr, hastaStr];
  const dateCond = 'CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)';
  const dateCondCc = 'CAST(dc.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(dc.FECHA AS DATE) <= CAST(? AS DATE)';

  // Costo: en algunas instalaciones ARTICULOS tiene COSTO_PROMEDIO; en otras solo DOCTOS_VE_DET tiene COSTO_TOTAL. Si ninguno existe, queda 0.
  let costosVEMes = [];
  try {
    costosVEMes = await query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(det.UNIDADES * COALESCE(a."COSTO_PROMEDIO", 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_VE d
      JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
      JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
      WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams);
  } catch (_) {
    try {
      costosVEMes = await query(`
        SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(COALESCE(NULLIF(det.COSTO_TOTAL, 0), det.CANTIDAD * COALESCE(det.COSTO_UNITARIO, 0))), 0) AS COSTO_VENTAS
        FROM DOCTOS_VE d
        JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
        WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C'
          AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
        GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
      `, dateParams);
    } catch (__) {
      costosVEMes = [];
    }
  }
  if (!Array.isArray(costosVEMes)) costosVEMes = [];
  // Fallback: si no hay costo en VE ni artículos, intentar desde contabilidad (pólizas con cuenta de costo de ventas)
  const totalCostoVE = (costosVEMes || []).reduce((s, r) => s + (+r.COSTO_VENTAS || 0), 0);
  if (totalCostoVE === 0) {
    // CUENTAS_CO en tu instalación no tiene columna CUENTA; tiene CUENTA_PT/CUENTA_JT. Filtro solo por NOMBRE.
    const condCuentas = `UPPER(CAST(cu.NOMBRE AS VARCHAR(500))) CONTAINING 'COSTO'`;
    // 1) Solo DOCTOS_CO_DET + CUENTAS_CO (sin DOCTOS_CO por si en remoto falla el JOIN)
    try {
      const costosCO = await query(`
        SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(d.IMPORTE), 0) AS COSTO_VENTAS
        FROM DOCTOS_CO_DET d
        JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
        WHERE ${condCuentas}
          AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
        GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
      `, dateParams);
      if (Array.isArray(costosCO) && costosCO.length) costosVEMes = costosCO;
    } catch (_) {}
    // 2) Si no, IMPORTE desde cabecera (c.FECHA)
    if (costosVEMes.length === 0) {
      try {
        const costosCO = await query(`
          SELECT EXTRACT(YEAR FROM c.FECHA) AS ANIO, EXTRACT(MONTH FROM c.FECHA) AS MES,
            COALESCE(SUM(d.IMPORTE), 0) AS COSTO_VENTAS
          FROM DOCTOS_CO c
          JOIN DOCTOS_CO_DET d ON d.DOCTO_CO_ID = c.DOCTO_CO_ID
          JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
          WHERE ${condCuentas}
            AND CAST(c.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(c.FECHA AS DATE) <= CAST(? AS DATE)
          GROUP BY EXTRACT(YEAR FROM c.FECHA), EXTRACT(MONTH FROM c.FECHA) ORDER BY 1, 2
        `, dateParams);
        if (Array.isArray(costosCO) && costosCO.length) costosVEMes = costosCO;
      } catch (__) {}
    }
    // 3) Por compatibilidad: CARGO/ABONO
    if (costosVEMes.length === 0) {
      try {
        const costosCO = await query(`
          SELECT EXTRACT(YEAR FROM c.FECHA) AS ANIO, EXTRACT(MONTH FROM c.FECHA) AS MES,
            COALESCE(SUM(d.CARGO), 0) - COALESCE(SUM(d.ABONO), 0) AS COSTO_VENTAS
          FROM DOCTOS_CO c
          JOIN DOCTOS_CO_DET d ON d.DOCTO_CO_ID = c.DOCTO_CO_ID
          JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
          WHERE ${condCuentas}
            AND CAST(c.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(c.FECHA AS DATE) <= CAST(? AS DATE)
          GROUP BY EXTRACT(YEAR FROM c.FECHA), EXTRACT(MONTH FROM c.FECHA) ORDER BY 1, 2
        `, dateParams);
        if (Array.isArray(costosCO) && costosCO.length) costosVEMes = costosCO;
      } catch (__) {}
    }
  }

  const [ventasMes, costosINMes, costosINDirect, cobrosMes] = await Promise.all([
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS VENTAS_NETAS,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COUNT(*) AS NUM_FACTURAS
      FROM ${ventasSub()} d
      WHERE ${dateCond}
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(det.CANTIDAD * COALESCE(det.COSTO_UNITARIO, det.PRECIO_UNITARIO, 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_IN d
      JOIN DOCTOS_IN_DET det ON det.DOCTO_IN_ID = d.DOCTO_IN_ID
      WHERE d.TIPO_MOV = 'S' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(COALESCE(d.IMPORTE, d.PRECIO_UNITARIO * d.UNIDADES, 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_IN d
      WHERE d.TIPO_DOCTO STARTING WITH 'S' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE) AND COALESCE(d.UNIDADES, 0) > 0
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    query(`
      SELECT EXTRACT(YEAR FROM dc.FECHA) AS ANIO, EXTRACT(MONTH FROM dc.FECHA) AS MES,
        SUM(CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END) AS COBROS
      FROM IMPORTES_DOCTOS_CC i
      JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
      WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N'
        AND ${dateCondCc}
      GROUP BY EXTRACT(YEAR FROM dc.FECHA), EXTRACT(MONTH FROM dc.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
  ]);

  const key = (a, m) => `${a}-${m}`;
  const costMap = {};
  (costosVEMes || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  (costosINMes || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  (costosINDirect || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  const cobMap = {}; (cobrosMes || []).forEach(r => { cobMap[key(r.ANIO, r.MES)] = +r.COBROS || 0; });

  const meses = (ventasMes || []).map(r => {
    const ventas = +r.VENTAS_NETAS || 0;
    const costo = costMap[key(r.ANIO, r.MES)] || 0;
    const cobros = cobMap[key(r.ANIO, r.MES)] || 0;
    const util = ventas - costo;
    const margenPct = ventas > 0 ? Math.round((util / ventas) * 1000) / 10 : 0;
    return {
      ANIO: r.ANIO,
      MES: r.MES,
      VENTAS_NETAS: ventas,
      VENTAS_VE: +r.VENTAS_VE || 0,
      VENTAS_PV: +r.VENTAS_PV || 0,
      COSTO_VENTAS: costo,
      UTILIDAD_BRUTA: util,
      MARGEN_BRUTO_PCT: margenPct,
      COBROS: cobros,
      NUM_FACTURAS: +r.NUM_FACTURAS || 0,
    };
  });

  const totales = meses.reduce((acc, m) => {
    acc.VENTAS_NETAS += m.VENTAS_NETAS;
    acc.VENTAS_VE += m.VENTAS_VE;
    acc.VENTAS_PV += m.VENTAS_PV;
    acc.COSTO_VENTAS += m.COSTO_VENTAS;
    acc.UTILIDAD_BRUTA += m.UTILIDAD_BRUTA;
    acc.COBROS += m.COBROS;
    acc.NUM_FACTURAS += m.NUM_FACTURAS;
    return acc;
  }, { VENTAS_NETAS: 0, VENTAS_VE: 0, VENTAS_PV: 0, COSTO_VENTAS: 0, UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0 });
  totales.MARGEN_BRUTO_PCT = totales.VENTAS_NETAS > 0
    ? Math.round((totales.UTILIDAD_BRUTA / totales.VENTAS_NETAS) * 1000) / 10 : 0;

  const tiene_costo = totales.COSTO_VENTAS > 0;

  return { meses, totales, tiene_costo };
});

// ═══════════════════════════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════════════════════════

get('/api/debug/cxc', async () => {
  const [docs, importes, clientes] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM DOCTOS_CC`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM IMPORTES_DOCTOS_CC`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM CLIENTES`).catch(() => [{ N: 0 }]),
  ]);
  return { doctos_cc: docs[0].N, importes_cc: importes[0].N, clientes: clientes[0].N };
});

get('/api/debug/ventas', async () => {
  const [ve, pv] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM DOCTOS_VE WHERE (TIPO_DOCTO = 'F' OR TIPO_DOCTO = 'V') AND ESTATUS <> 'C'`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM DOCTOS_PV WHERE (TIPO_DOCTO = 'F' OR TIPO_DOCTO = 'V') AND ESTATUS <> 'C'`).catch(() => [{ N: 0 }]),
  ]);
  return { doctos_ve: ve[0].N, doctos_pv: pv[0].N };
});

get('/api/debug/pv', async () => {
  const rows = await query(`SELECT COUNT(*) AS N FROM DOCTOS_PV`).catch(() => [{ N: 0 }]);
  return { doctos_pv: rows[0].N };
});

get('/api/debug/cumplimiento', async () => {
  const rows = await query(`SELECT FIRST 1 * FROM CONFIGURACIONES_GEN`).catch(() => []);
  return { config: rows[0] || null };
});

get('/api/debug/inv', async () => {
  const [art, lines] = await Promise.all([
    query(`SELECT COUNT(*) AS N FROM ARTICULOS`).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(*) AS N FROM LINES_EXISTENCIA`).catch(() => [{ N: 0 }]),
  ]);
  return { articulos: art[0].N, lines_existencia: lines[0].N };
});

get('/api/debug/schema', async () => {
  const tables = ['DOCTOS_VE', 'DOCTOS_CC', 'IMPORTES_DOCTOS_CC', 'CLIENTES', 'VENDEDORES'];
  const out = {};
  for (const t of tables) {
    try {
      const r = await query(`SELECT FIRST 1 * FROM ${t}`);
      out[t] = r[0] ? Object.keys(r[0]) : [];
    } catch (e) {
      out[t] = e.message;
    }
  }
  return out;
});

// ═══════════════════════════════════════════════════════════
//  CONSUMOS — por cantidades vendidas (unidades)
// ═══════════════════════════════════════════════════════════

get('/api/consumos/resumen', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const [totRows, maxRows] = await Promise.all([
    query(`
      SELECT
        COALESCE(SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.UNIDADES ELSE 0 END), 0) AS HOY_UNIDADES,
        COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES_PERIODO,
        COUNT(*) AS MOVIMIENTOS,
        COUNT(DISTINCT CAST(d.FECHA AS DATE)) AS DIAS_CON_MOVIMIENTO,
        COUNT(DISTINCT d.ARTICULO_ID) AS ARTICULOS_CONSUMIDOS
      FROM ${consumosSub(tipo)} d
      WHERE d.UNIDADES > 0 ${f.sql}
    `, f.params).catch(() => []),
    query(`
      SELECT FIRST 1
        CAST(d.FECHA AS DATE) AS DIA_MAXIMO,
        COALESCE(SUM(d.UNIDADES), 0) AS MAXIMO_DIARIO
      FROM ${consumosSub(tipo)} d
      WHERE d.UNIDADES > 0 ${f.sql}
      GROUP BY CAST(d.FECHA AS DATE)
      ORDER BY MAXIMO_DIARIO DESC, DIA_MAXIMO DESC
    `, f.params).catch(() => [])
  ]);
  const t = totRows[0] || {};
  const m = maxRows[0] || {};
  const unidadesPeriodo = +t.UNIDADES_PERIODO || 0;
  const diasConMov = +t.DIAS_CON_MOVIMIENTO || 0;
  return {
    HOY_UNIDADES: +t.HOY_UNIDADES || 0,
    UNIDADES_PERIODO: unidadesPeriodo,
    CONSUMO_PROMEDIO_DIARIO: diasConMov > 0 ? Math.round((unidadesPeriodo / diasConMov) * 100) / 100 : 0,
    CONSUMO_MAXIMO_DIARIO: +m.MAXIMO_DIARIO || 0,
    DIA_MAXIMO: m.DIA_MAXIMO || null,
    DIAS_CON_MOVIMIENTO: diasConMov,
    MOVIMIENTOS: +t.MOVIMIENTOS || 0,
    ARTICULOS_CONSUMIDOS: +t.ARTICULOS_CONSUMIDOS || 0
  };
});

get('/api/consumos/diarias', async (req) => {
  const tipo = getTipo(req);
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const rows = await query(`
    SELECT
      CAST(d.FECHA AS DATE) AS DIA,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.UNIDADES ELSE 0 END), 0) AS CONSUMO_VE,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.UNIDADES ELSE 0 END), 0) AS CONSUMO_PV,
      COALESCE(SUM(d.UNIDADES), 0) AS CONSUMO_TOTAL
    FROM ${consumosSub(tipo)} d
    WHERE d.UNIDADES > 0 AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE)
    ORDER BY 1
  `, [desdeStr]).catch(() => []);
  return rows || [];
});

get('/api/consumos/top-articulos', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 15, 100);
  return query(`
    SELECT FIRST ${limit}
      d.ARTICULO_ID,
      COALESCE(a.NOMBRE, 'Art. ' || CAST(d.ARTICULO_ID AS VARCHAR(12))) AS ARTICULO,
      COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES
    FROM ${consumosSub(tipo)} d
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
    WHERE d.UNIDADES > 0 ${f.sql}
    GROUP BY d.ARTICULO_ID, a.NOMBRE, a.UNIDAD_VENTA
    ORDER BY UNIDADES DESC
  `, f.params).catch(() => []);
});

get('/api/consumos/por-vendedor', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const rows = await query(`
    SELECT
      d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS VENDEDOR,
      COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES
    FROM ${consumosSub(tipo)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.UNIDADES > 0 AND d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE
    ORDER BY UNIDADES DESC
  `, f.params).catch(() => []);
  const total = (rows || []).reduce((s, r) => s + (+r.UNIDADES || 0), 0);
  return (rows || []).map(r => ({
    ...r,
    PARTICIPACION: total > 0 ? Math.round((+r.UNIDADES || 0) / total * 10000) / 100 : 0
  }));
});

get('/api/debug/costo', async () => {
  const rows = await query(`
    SELECT FIRST 5
      d.DOCTO_VE_ID, det.ARTICULO_ID, det.PRECIO_TOTAL, det.COSTO_TOTAL
    FROM DOCTOS_VE d JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C'
  `).catch(() => []);
  return { sample: rows };
});

// Ver columnas reales de DOCTOS_VE_DET en tu BD (para saber cómo se llama el costo)
get('/api/debug/ve-det-schema', async () => {
  const row = await query(`
    SELECT FIRST 1 * FROM DOCTOS_VE_DET
  `).catch(() => []);
  const cols = (row && row[0]) ? Object.keys(row[0]).sort() : [];
  const sample = row && row[0] ? row[0] : null;
  return { columnas: cols, muestraPrimerRegistro: sample };
});

// Diagnóstico Costo de Ventas para PnL: mismo rango de fechas que /api/resultados/pnl
// GET ?meses=3 o ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD o ?anio=2026&mes=3
get('/api/debug/pnl-costo', async (req) => {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr, hastaStr;
  const { desde, hasta, anio, mes } = req.query;
  if (desde && reDate.test(desde) && hasta && reDate.test(hasta)) {
    desdeStr = desde;
    hastaStr = hasta;
  } else if (anio) {
    const y = parseInt(anio);
    const m = mes ? parseInt(mes) : null;
    if (m) {
      desdeStr = y + '-' + String(m).padStart(2, '0') + '-01';
      const lastDay = new Date(y, m, 0);
      hastaStr = y + '-' + String(m).padStart(2, '0') + '-' + String(lastDay.getDate()).padStart(2, '0');
    } else {
      desdeStr = y + '-01-01';
      hastaStr = y + '-12-31';
    }
  }
  if (!desdeStr) {
    const mesesN = Math.min(Math.max(parseInt(req.query.meses) || 3, 1), 24);
    const d = new Date();
    d.setMonth(d.getMonth() - mesesN);
    desdeStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    hastaStr = new Date().toISOString().slice(0, 10);
  }
  const dateParams = [desdeStr, hastaStr];
  let costosVE = [];
  let errorVE = null;
  try {
    costosVE = await query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(det.UNIDADES * COALESCE(a."COSTO_PROMEDIO", 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_VE d
      JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
      JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
      WHERE (d.TIPO_DOCTO = 'F' OR d.TIPO_DOCTO = 'V') AND d.ESTATUS <> 'C'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams);
  } catch (e) {
    errorVE = e.message || String(e);
    costosVE = [];
  }
  const totalCostoVE = (costosVE || []).reduce((s, r) => s + (+r.COSTO_VENTAS || 0), 0);
  return {
    desdeStr,
    hastaStr,
    costosVERows: (costosVE || []).length,
    costosVEMes: (costosVE || []).slice(0, 12),
    totalCostoVE,
    errorVE: errorVE || null,
  };
});

// Ver columnas de ARTICULOS (para saber nombre exacto del costo)
get('/api/debug/articulos-schema', async () => {
  const row = await query(`SELECT FIRST 1 * FROM ARTICULOS`).catch(() => []);
  const cols = (row && row[0]) ? Object.keys(row[0]).sort() : [];
  const costRelated = (cols || []).filter(c => /COSTO|PRECIO|COST/i.test(c));
  return { columnas: cols, relacionadasConCosto: costRelated, muestra: row && row[0] ? row[0] : null };
});

// Ver si ARTICULOS tiene COSTO_PROMEDIO y si hay valores > 0
get('/api/debug/articulos-costo', async () => {
  let error = null;
  let sample = [];
  let totalSum = 0;
  try {
    sample = await query(`
      SELECT FIRST 10 a.ARTICULO_ID, a.NOMBRE, a."COSTO_PROMEDIO"
      FROM ARTICULOS a
      WHERE COALESCE(a."COSTO_PROMEDIO", 0) > 0
    `).catch(() => []);
    const sumRow = await query(`
      SELECT COUNT(*) AS C, COALESCE(SUM(a."COSTO_PROMEDIO"), 0) AS S
      FROM ARTICULOS a WHERE COALESCE(a."COSTO_PROMEDIO", 0) > 0
    `).catch(() => [{ C: 0, S: 0 }]);
    totalSum = sumRow && sumRow[0] ? +(sumRow[0].S || 0) : 0;
  } catch (e) {
    error = e.message || String(e);
  }
  return { error, sample: sample || [], articulosConCosto: (sample || []).length, totalSum };
});

// Misma lógica de fechas que /api/resultados/pnl y misma consulta de costo contabilidad (solo DOCTOS_CO_DET+CUENTAS_CO).
// Sirve para ver en el remoto si el PnL debería estar recibiendo costo. GET ?meses=3 o ?anio=2025
get('/api/debug/pnl-costo-contabilidad', async (req) => {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr, hastaStr;
  const { desde, hasta, anio, mes } = req.query;
  if (desde && reDate.test(desde) && hasta && reDate.test(hasta)) {
    desdeStr = desde;
    hastaStr = hasta;
  } else if (anio) {
    const y = parseInt(anio);
    const m = mes ? parseInt(mes) : null;
    if (m) {
      desdeStr = y + '-' + String(m).padStart(2, '0') + '-01';
      const lastDay = new Date(y, m, 0);
      hastaStr = y + '-' + String(m).padStart(2, '0') + '-' + String(lastDay.getDate()).padStart(2, '0');
    } else {
      desdeStr = y + '-01-01';
      hastaStr = y + '-12-31';
    }
  }
  if (!desdeStr) {
    const mesesN = Math.min(Math.max(parseInt(req.query.meses) || 3, 1), 24);
    const d = new Date();
    d.setMonth(d.getMonth() - mesesN);
    desdeStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    hastaStr = new Date().toISOString().slice(0, 10);
  }
  const dateParams = [desdeStr, hastaStr];
  // Sin usar cu.CUENTA (no existe en tu BD; solo NOMBRE, CUENTA_PT, etc.)
  const condCuentas = `UPPER(CAST(cu.NOMBRE AS VARCHAR(500))) CONTAINING 'COSTO'`;
  let costosVEMes = [];
  let error = null;
  try {
    costosVEMes = await query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE), 0) AS COSTO_VENTAS
      FROM DOCTOS_CO_DET d
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
      WHERE ${condCuentas}
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams);
  } catch (e) {
    error = e.message || String(e);
  }
  const totalCosto = (costosVEMes || []).reduce((s, r) => s + (+r.COSTO_VENTAS || 0), 0);
  return { desdeStr, hastaStr, query_params: req.query, costosVEMes: costosVEMes || [], totalCosto, error };
});

// Diagnóstico Costo desde Contabilidad (DOCTOS_CO / DOCTOS_CO_DET / CUENTAS_CO)
// En muchas instalaciones Microsip el costo de ventas solo está en pólizas contables (cuenta 6xxx o nombre "COSTO").
// GET ?meses=3 o ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
get('/api/debug/contabilidad-costo', async (req) => {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr = new Date().toISOString().slice(0, 10);
  let hastaStr = desdeStr;
  const { desde, hasta, meses } = req.query;
  if (desde && reDate.test(desde) && hasta && reDate.test(hasta)) {
    desdeStr = desde;
    hastaStr = hasta;
  } else if (meses) {
    const n = Math.min(Math.max(parseInt(meses) || 3, 1), 24);
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    desdeStr = d.toISOString().slice(0, 10);
    hastaStr = new Date().toISOString().slice(0, 10);
  }
  const out = { desdeStr, hastaStr, tablasExisten: false, doctosCoDetColumns: [], cuentasCoColumns: [], cuentasCosto: [], costoPorMes: [], error: null };
  try {
    const detRow = await query(`SELECT FIRST 1 * FROM DOCTOS_CO_DET`).catch(() => []);
    const cuRow = await query(`SELECT FIRST 1 * FROM CUENTAS_CO`).catch(() => []);
    out.doctosCoDetColumns = (detRow && detRow[0]) ? Object.keys(detRow[0]).sort() : [];
    out.cuentasCoColumns = (cuRow && cuRow[0]) ? Object.keys(cuRow[0]).sort() : [];
    if (out.doctosCoDetColumns.length && out.cuentasCoColumns.length) out.tablasExisten = true;

    // Cuentas que podrían ser costo de ventas (nombre con COSTO o cuenta 6xxx)
    const tieneNombre = out.cuentasCoColumns.some(c => /NOMBRE|DESCRIP|NOMBRE_CUENTA/i.test(c));
    const tieneCuenta = out.cuentasCoColumns.some(c => /^CUENTA$|CUENTA_ID|CODIGO/i.test(c));
    const tieneCargo = out.doctosCoDetColumns.some(c => /CARGO|IMPORTE|DEBE/i.test(c));
    const tieneAbono = out.doctosCoDetColumns.some(c => /ABONO|HABER/i.test(c));
    const colCuentaIdDet = out.doctosCoDetColumns.find(c => /CUENTA_ID|CUENTA_CO_ID/i.test(c)) || 'CUENTA_ID';
    const colCuentaIdCo = out.cuentasCoColumns.find(c => /CUENTA_ID|ID/i.test(c)) || 'CUENTA_ID';
    const colNombreCo = out.cuentasCoColumns.find(c => /NOMBRE|DESCRIP/i.test(c)) || 'NOMBRE';
    const colCuentaCo = out.cuentasCoColumns.find(c => c === 'CUENTA' || /CODIGO|CUENTA$/i.test(c)) || 'CUENTA';
    const colCargo = out.doctosCoDetColumns.find(c => /^CARGO$/i.test(c)) || out.doctosCoDetColumns.find(c => /IMPORTE|DEBE/i.test(c));
    const colAbono = out.doctosCoDetColumns.find(c => /^ABONO$/i.test(c)) || out.doctosCoDetColumns.find(c => /HABER/i.test(c));

    if (out.tablasExisten && tieneNombre) {
      const cuentasCosto = await query(`
        SELECT FIRST 20 ${colCuentaIdCo} AS CUENTA_ID, ${colNombreCo} AS NOMBRE, ${colCuentaCo} AS CUENTA
        FROM CUENTAS_CO
        WHERE UPPER(CAST(${colNombreCo} AS VARCHAR(500))) CONTAINING 'COSTO'
           OR (CAST(${colCuentaCo} AS VARCHAR(20)) STARTING WITH '6')
      `).catch(() => []);
      out.cuentasCosto = (cuentasCosto || []).map(r => ({ CUENTA_ID: r.CUENTA_ID, NOMBRE: r.NOMBRE, CUENTA: r.CUENTA }));
    }

    // Sumar costo por mes desde pólizas (cargos en cuentas de costo; en México el costo suele ser débito/CARGO)
    if (out.tablasExisten && colCargo && out.cuentasCosto.length) {
      const ids = out.cuentasCosto.map(c => c.CUENTA_ID).filter(Boolean).join(',');
      if (ids) {
        const restarAbono = colAbono ? ` - COALESCE(SUM(d.${colAbono}), 0)` : '';
        const costoPorMes = await query(`
          SELECT EXTRACT(YEAR FROM c.FECHA) AS ANIO, EXTRACT(MONTH FROM c.FECHA) AS MES,
            COALESCE(SUM(d.${colCargo}), 0)${restarAbono} AS COSTO_VENTAS
          FROM DOCTOS_CO c
          JOIN DOCTOS_CO_DET d ON d.DOCTO_CO_ID = c.DOCTO_CO_ID
          WHERE d.${colCuentaIdDet} IN (${ids})
            AND CAST(c.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(c.FECHA AS DATE) <= CAST(? AS DATE)
          GROUP BY EXTRACT(YEAR FROM c.FECHA), EXTRACT(MONTH FROM c.FECHA) ORDER BY 1, 2
        `, [desdeStr, hastaStr]).catch(() => []);
        out.costoPorMes = (costoPorMes || []).slice(0, 24);
      }
    }
  } catch (e) {
    out.error = e.message || String(e);
  }
  return out;
});

// ═══════════════════════════════════════════════════════════
//  EMAIL (preview, enviar, cron)
// ═══════════════════════════════════════════════════════════

function generarReporteHTML(data) {
  if (!data) data = {};
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reporte</title></head><body>
  <h1>Reporte Suminregio</h1>
  <p>Generado: ${new Date().toISOString()}</p>
  <pre>${JSON.stringify(data, null, 2)}</pre>
  </body></html>`;
}

get('/api/email/preview', async (req) => {
  const [ventas, cxc] = await Promise.all([
    query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM ${ventasSub()} d WHERE EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)`).catch(() => [{ T: 0 }]),
    query(`SELECT COALESCE(SUM(s.SALDO),0) AS T FROM ${cxcClienteSQL()} s`).catch(() => [{ T: 0 }]),
  ]);
  const html = generarReporteHTML({
    ventas_mes: +(ventas[0] && ventas[0].T) || 0,
    cxc_saldo: +(cxc[0] && cxc[0].T) || 0,
  });
  return { html };
});

app.post('/api/email/enviar', async (req, res) => {
  try {
    const { destinos, asunto, cuerpo } = req.body || {};
    const html = cuerpo || generarReporteHTML({ mensaje: 'Sin datos' });
    // Stub: no envía correo real sin nodemailer configurado
    res.json({ ok: true, mensaje: 'Envío simulado (configurar nodemailer para envío real)' });
  } catch (e) {
    console.error('[ERROR] /api/email/enviar', e.message);
    res.status(500).json({ error: e.message });
  }
});

function iniciarCronEmail() {
  // Stub: no programa tareas sin cron configurado
  try {
    if (typeof setInterval !== 'undefined') setInterval(() => {}, 86400000);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════
//  PING & SERVER
// ═══════════════════════════════════════════════════════════

app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    version: '9.0',
    empresa: process.env.EMPRESA_NOMBRE || 'SUMINREGIO PARKER',
  });
});

// Diagnóstico: comprueba si la API de diarias devuelve datos (últimos N días)
app.get('/api/debug/ventas-diarias', async (req, res) => {
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  try {
    const rows = await query(`
      SELECT CAST(d.FECHA AS DATE) AS DIA,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS
      FROM ${ventasSub()} d
      WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
    `, [desdeStr]);
    const count = Array.isArray(rows) ? rows.length : 0;
    res.json({
      ok: true,
      dias,
      count,
      sample: Array.isArray(rows) && rows.length ? rows.slice(0, 3) : [],
      message: count ? `Hay ${count} días con datos.` : 'La base no tiene ventas en los últimos ' + dias + ' días (o hay error de conexión).',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message), dias });
  }
});

iniciarCronEmail();

app.listen(PORT, () => {
  console.log(`Suminregio API escuchando en http://localhost:${PORT}`);
});
