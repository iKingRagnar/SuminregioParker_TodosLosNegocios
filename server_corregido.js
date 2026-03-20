'use strict';

/**
 * Suminregio Parker — API Server v9.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Microsip — referencia de tablas (alineado a catálogo tipo “CUENTAS CONTABLES_FUENTES.xlsx”, hoja 1):
 *  • CXC cabecera: DOCTOS_CC (Mov / Por Cobrar).
 *  • CXC importes línea a línea: IMPORTES_DOCTOS_CC (Detalle / Por Cobrar) — aquí van cargos y cobros;
 *    TIPO_IMPTE típico 'C' = cargo, 'R' = recibo/cobro (no confundir con nombre singular “IMPORTE_…”).
 *  • Relacionados: CONDICIONES_PAGO, CONCEPTOS_CC, DEPOSITOS_CC + DEPOSITOS_CC_DET, VENCIMIENTOS_CARGOS_CC.
 *  • Contabilidad / P&L futuro: CUENTAS_CO (catálogo), DOCTOS_CO + DOCTOS_CO_DET (pólizas y movimientos).
 *  • CXP análogo: IMPORTES_DOCTOS_CP sobre DOCTOS_CP.
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
 *  • /api/cxc/por-condicion → saldo neto por DOCTO_CC y condición del documento (dc.COND_PAGO_ID); contado aparte
 *  • /api/director/resumen  → CXC: cxcClienteSQL (saldo) + cxcCargosSQL (aging)
 *  • Static: express.static(__dirname) con charset=utf-8 (corrige ñ, á, etc.)
 * FIXES v5 sobre v4:
 *  • META_IDEAL corregida a 10% sobre base (antes 30%)
 *  • CXC Aging: usa VENCIMIENTOS_CARGOS_CC.FECHA_VENCIMIENTO para calcular
 *               días vencidos desde la fecha de vencimiento REAL del documento
 *               Fallback: DOCTOS_CC.FECHA + CONDICIONES_PAGO.DIAS_PPAG
 *  • Ventas: UNION ALL de DOCTOS_VE (Industrial) + DOCTOS_PV (Mostrador)
 *            Parámetro ?tipo=VE o ?tipo=PV para filtrar por fuente
 *  • Cotizaciones: solo DOCTOS_VE; predicado único sqlWhereCotizacionActiva() en todos los endpoints
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
const fs       = require('fs');
const Firebird = require('node-firebird');
const path     = require('path');

(function warnIfEnvLooksLikeJs() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    const head = fs.readFileSync(p, 'utf8').slice(0, 800);
    if (/filters\.js/i.test(head) && /Barra de filtros/i.test(head)) {
      console.error('[.env] El archivo .env contiene código de filters.js (no es un .env válido).');
      console.error('      Copia PLANTILLA-ENV-SERVIDOR.txt a .env y ajusta rutas/clave OpenAI.');
    }
  } catch (_) { /* ignore */ }
})();

const app  = express();
const PORT = process.env.PORT || 7000;

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

/**
 * Importe línea en *_DET (Microsip Firebird).
 * No usar PRECIO_UNITARIO aquí: en muchas instalaciones ese campo no existe en la BD (rompe todas las queries).
 * Orden: total del renglón si viene cargado; si no, UNIDADES × PRECIO_U (equivalente práctico al DAX).
 */
function sqlDetLineImporteExpr(detAlias = 'det') {
  const x = detAlias;
  return `COALESCE(NULLIF(${x}.PRECIO_TOTAL, 0), (COALESCE(${x}.UNIDADES, 0) * COALESCE(${x}.PRECIO_U, 0)), CAST(0 AS DOUBLE PRECISION))`;
}

/** Facturación (DAX Facturación $): solo TIPO F y V; ESTATUS no C / D / S. */
function sqlWhereFacturaVentaValida(alias = 'd') {
  const a = alias;
  return `(${a}.TIPO_DOCTO IN ('F', 'V')) AND (COALESCE(${a}.ESTATUS, 'N') NOT IN ('C', 'D', 'S'))`;
}

/** Descuento cabecera cotización VE; si tu BD no tiene DSCTO_IMPORTE pon en .env: MICROSIP_OMIT_VE_DSCTO=1 */
function sqlCotiHeaderDsctoMaxExpr() {
  if (String(process.env.MICROSIP_OMIT_VE_DSCTO || '').trim() === '1') {
    return 'CAST(0 AS DOUBLE PRECISION)';
  }
  return 'COALESCE(MAX(d.DSCTO_IMPORTE), 0)';
}

/**
 * Subconsulta: una fila por cotización VE con importe = suma líneas − descuento cabecera (DAX Cotizaciones $).
 * fSql debe incluir espacio inicial " AND ..." sobre alias d.
 */
function sqlCotizacionesVeDocSubquery(fSql = '') {
  const L = sqlDetLineImporteExpr('det');
  const ds = sqlCotiHeaderDsctoMaxExpr();
  return `(
    SELECT
      d.DOCTO_VE_ID,
      d.FECHA,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.VENDEDOR_ID,
      d.CLIENTE_ID,
      (COALESCE(SUM(${L}), 0) - ${ds}) AS IMPORTE_NETO
    FROM DOCTOS_VE d
    INNER JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE ${sqlWhereCotizacionActiva('d')}${fSql}
    GROUP BY d.DOCTO_VE_ID, d.FECHA, d.FOLIO, d.TIPO_DOCTO, d.ESTATUS, d.VENDEDOR_ID, d.CLIENTE_ID
    HAVING (COALESCE(SUM(${L}), 0) - ${ds}) <> 0
  )`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Servir archivos estáticos — public/ primero: si hay mismo nombre en raíz y en public/, gana public/
// (evita que index.html viejo en la raíz opaque public/index.html).
const staticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (filePath.endsWith('.js'))   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (filePath.endsWith('.css'))  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  }
};
app.use(express.static(path.join(__dirname, 'public'), staticOpts));
app.use(express.static(__dirname, staticOpts));

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

// ── Helper: ejecuta query → promesa ──────────────────────────────────────────
// dbOptsOverride: si se pasa, usa esa conexión (multi-empresa / scorecard universo).
function query(sql, params = [], timeoutMs = 12000, dbOptsOverride = null) {
  const attachOpts = dbOptsOverride || DB_OPTIONS;
  const queryPromise = new Promise((resolve, reject) => {
    Firebird.attach(attachOpts, (err, db) => {
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

// ── Multi-FDB: FB_DATABASES_JSON + FB_DATABASE_DIR (escaneo *.fdb) ────────────
function normalizeDatabasePathKey(dbPath) {
  const s = String(dbPath || '').trim();
  if (!s) return '';
  try {
    return path.resolve(s).replace(/\//g, '\\').toLowerCase();
  } catch (_) {
    return s.toLowerCase();
  }
}

function slugDbId(baseName) {
  let s = String(baseName || '')
    .replace(/\.fdb$/i, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s || 'fdb';
}

function parseDatabaseRegistry() {
  const host = process.env.FB_HOST || '127.0.0.1';
  const port = parseInt(process.env.FB_PORT, 10) || 3050;
  const user = process.env.FB_USER || 'SYSDBA';
  const password = process.env.FB_PASSWORD != null ? process.env.FB_PASSWORD : 'masterkey';

  const entries = [];
  const seenPaths = new Set();
  const usedIds = new Set();

  function pushEntry(id, label, databasePath, opts = {}) {
    const { optOverrides = null } = opts;
    const dbPath = String(databasePath || '').trim();
    if (!dbPath) return;
    const key = normalizeDatabasePathKey(dbPath);
    if (key && seenPaths.has(key)) return;
    if (key) seenPaths.add(key);

    let fid = id != null && String(id).trim() ? String(id).trim() : '';
    if (!fid) fid = slugDbId(path.basename(dbPath, path.extname(dbPath)));
    let n = 2;
    const baseFid = fid;
    while (usedIds.has(fid)) fid = `${baseFid}_${n++}`;
    usedIds.add(fid);

    const baseOpts = {
      host,
      port,
      database: dbPath,
      user,
      password,
      lowercase_keys: false,
      charset: 'UTF8',
    };
    if (optOverrides && typeof optOverrides === 'object') {
      if (optOverrides.host) baseOpts.host = optOverrides.host;
      if (optOverrides.port != null) baseOpts.port = parseInt(optOverrides.port, 10) || port;
      if (optOverrides.user) baseOpts.user = optOverrides.user;
      if (optOverrides.password != null) baseOpts.password = optOverrides.password;
    }

    entries.push({
      id: fid,
      label: String(label || baseFid || fid),
      options: baseOpts,
    });
  }

  const raw = process.env.FB_DATABASES_JSON;
  if (raw && raw.trim()) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        arr.forEach((x, i) => {
          if (!x || !x.database) return;
          pushEntry(
            x.id != null ? String(x.id) : `empresa_${i + 1}`,
            x.label != null ? String(x.label) : (x.id != null ? String(x.id) : `Empresa ${i + 1}`),
            x.database,
            {
              optOverrides: {
                host: x.host,
                port: x.port,
                user: x.user,
                password: x.password,
              },
            }
          );
        });
      }
    } catch (e) {
      console.error('[FB_DATABASES_JSON]', e.message);
    }
  }

  // Catálogo versionado en Git: fb-databases.registry.json (mismo directorio que este servidor).
  // Rutas completas por archivo; dedupe con JSON del .env y con el escaneo de FB_DATABASE_DIR.
  try {
    const regFile = path.join(__dirname, 'fb-databases.registry.json');
    if (fs.existsSync(regFile)) {
      const fileArr = JSON.parse(fs.readFileSync(regFile, 'utf8'));
      if (Array.isArray(fileArr) && fileArr.length) {
        fileArr.forEach((x, i) => {
          if (!x || !x.database) return;
          pushEntry(
            x.id != null ? String(x.id) : `reg_${i + 1}`,
            x.label != null ? String(x.label) : (x.id != null ? String(x.id) : `Empresa ${i + 1}`),
            x.database,
            {
              optOverrides: {
                host: x.host,
                port: x.port,
                user: x.user,
                password: x.password,
              },
            }
          );
        });
        console.log('[fb-databases.registry.json]', fileArr.length, 'entradas');
      }
    }
  } catch (e) {
    console.error('[fb-databases.registry.json]', e.message);
  }

  const primaryPath =
    String(process.env.FB_DATABASE || '').trim() || String(DB_OPTIONS.database || '').trim();

  const scannedDirKeys = new Set();
  let fdbListedInScan = 0;

  /** Escanea una carpeta: registra cada *.fdb (archivo). Rutas relativas se resuelven desde cwd del proceso Node. */
  function scanDirectoryForFdb(dirInput) {
    let absDir;
    try {
      absDir = path.resolve(String(dirInput || '').trim());
    } catch (e) {
      console.warn('[FB_DATABASE_DIR] Ruta inválida:', dirInput, e.message);
      return;
    }
    const dirKey = absDir.replace(/\\/g, '/').toLowerCase();
    if (scannedDirKeys.has(dirKey)) return;

    if (!fs.existsSync(absDir)) {
      console.warn('[FB_DATABASE_DIR] Carpeta inexistente (no se escanean .fdb):', absDir);
      return;
    }
    let stDir;
    try {
      stDir = fs.statSync(absDir);
    } catch (e) {
      console.warn('[FB_DATABASE_DIR] No se pudo acceder:', absDir, e.message);
      return;
    }
    if (!stDir.isDirectory()) {
      console.warn('[FB_DATABASE_DIR] No es una carpeta:', absDir);
      return;
    }
    scannedDirKeys.add(dirKey);

    let names;
    try {
      names = fs.readdirSync(absDir);
    } catch (e) {
      console.error('[FB_DATABASE_DIR] Lectura fallida:', absDir, e.message);
      return;
    }
    const fdbFiles = names.filter((f) => /\.fdb$/i.test(f));
    fdbFiles.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    fdbListedInScan += fdbFiles.length;
    console.log(
      '[FB_DATABASE_DIR]',
      absDir,
      '→',
      fdbFiles.length,
      'archivo(s) .fdb:',
      fdbFiles.length ? fdbFiles.join(', ') : '(ninguno — comprueba que las bases estén en esta carpeta en el servidor)'
    );
    for (const f of fdbFiles) {
      const full = path.join(absDir, f);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch (_) {
        continue;
      }
      const label = f.replace(/\.fdb$/i, '');
      pushEntry(null, label, full, {});
    }
  }

  const dirsRaw = (process.env.FB_DATABASE_DIR || '').trim();
  let dirList = dirsRaw ? dirsRaw.split(/[;,]+/).map((s) => s.trim()).filter(Boolean) : [];

  if (!dirList.length && primaryPath) {
    try {
      const inferred = path.dirname(primaryPath);
      if (inferred && inferred !== '.' && inferred.length && inferred !== primaryPath) {
        dirList = [inferred];
        console.log(
          '[FB_DATABASE_DIR] Sin variable en .env: se infiere la carpeta desde FB_DATABASE →',
          path.resolve(inferred)
        );
      }
    } catch (_) {}
  } else if (!dirsRaw) {
    console.log('[FB_DATABASE_DIR] (vacío) y sin ruta en FB_DATABASE para inferir carpeta.');
  }

  for (const d of dirList) {
    scanDirectoryForFdb(d);
  }

  // FB_DATABASE en L: pero FB_DATABASE_DIR seguía en C:\… (carpeta vacía o sin .fdb): reescaneo de la carpeta real del .fdb
  if (fdbListedInScan === 0 && primaryPath) {
    try {
      const inferred = path.dirname(primaryPath);
      if (inferred && inferred !== '.' && inferred !== primaryPath) {
        const inferredKey = path.resolve(inferred).replace(/\\/g, '/').toLowerCase();
        if (!scannedDirKeys.has(inferredKey)) {
          console.warn(
            '[FB_DATABASE_DIR] Ningún .fdb listado en las rutas del .env; escaneando la carpeta de FB_DATABASE:',
            path.resolve(inferred)
          );
          scanDirectoryForFdb(inferred);
        }
      }
    } catch (_) {}
  }

  // FB_DATABASE: por si apunta a una .fdb fuera de todo lo escaneado (dedupe por ruta).
  if (primaryPath) {
    pushEntry(null, process.env.EMPRESA_NOMBRE || 'Principal', primaryPath, {});
  }

  if (!entries.length) {
    pushEntry('default', process.env.EMPRESA_NOMBRE || 'Principal', DB_OPTIONS.database, {});
  }

  if (!entries.length) {
    return [{ id: 'default', label: process.env.EMPRESA_NOMBRE || 'Principal', options: { ...DB_OPTIONS } }];
  }

  return entries;
}

const DATABASE_REGISTRY = parseDatabaseRegistry();
console.log(
  '[Firebird] bases registradas (' + DATABASE_REGISTRY.length + '):',
  DATABASE_REGISTRY.map((d) => `${d.id} ← ${path.basename(d.options.database || '')}`).join(' | ')
);

/** null = FB_DATABASE por defecto; ?db=id debe existir en DATABASE_REGISTRY o lanza error. */
function getReqDbOpts(req) {
  if (!req || !req.query) return null;
  const id = req.query.db != null ? String(req.query.db).trim() : '';
  if (!id || id.toLowerCase() === 'default') return null;
  const idLc = id.toLowerCase();
  const hit = DATABASE_REGISTRY.find(d => String(d.id).toLowerCase() === idLc);
  if (!hit) {
    console.warn('[db] Parámetro db desconocido (se usa FB_DATABASE por defecto):', id);
    return null;
  }
  return hit.options;
}

/** Ejecuta tareas con a lo sumo `limit` en vuelo (reduce carga en servidor transaccional). */
async function mapPoolLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
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
function buildFiltros(req, alias = 'd', options = {}) {
  const omitVC = options.omitVendedorCliente === true;
  const conds  = [];
  const params = [];
  const feRoot = options.fechaExpr != null ? options.fechaExpr : `${alias}.FECHA`;
  const { anio, mes, dia, vendedor, cliente } = req.query;
  let   { desde, hasta } = req.query;

  // Validar formato básico YYYY-MM-DD
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  if (desde && !reDate.test(desde)) desde = null;
  if (hasta && !reDate.test(hasta)) hasta = null;

  if (desde) { conds.push(`CAST(${feRoot} AS DATE) >= CAST(? AS DATE)`); params.push(desde); }
  if (hasta) { conds.push(`CAST(${feRoot} AS DATE) <= CAST(? AS DATE)`); params.push(hasta); }

  // anio/mes solo si no hay rango explícito
  if (!desde) {
    if (anio) { conds.push(`EXTRACT(YEAR  FROM ${feRoot}) = ?`); params.push(parseInt(anio)); }
    if (mes)  { conds.push(`EXTRACT(MONTH FROM ${feRoot}) = ?`); params.push(parseInt(mes)); }
  }
  if (dia) { conds.push(`CAST(${feRoot} AS DATE) = CAST(? AS DATE)`); params.push(dia); }
  if (!omitVC && vendedor) { conds.push(`${alias}.VENDEDOR_ID = ?`); params.push(parseInt(vendedor)); }
  if (!omitVC && cliente) { conds.push(`${alias}.CLIENTE_ID  = ?`); params.push(parseInt(cliente)); }

  // Si hay desde, calcular cuántos días de lookback necesitamos
  let lookbackOverride = null;
  if (desde) {
    const daysAgo = Math.ceil((Date.now() - new Date(desde).getTime()) / 86400000);
    lookbackOverride = Math.max(daysAgo + 5, 31);
  }

  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params, lookbackOverride };
}

/**
 * Filtro de fechas sobre IMPORTES_DOCTOS_CC + vendedor/cliente vía documento CC aplicado
 * (COALESCE(DOCTO_CC_ACR_ID, DOCTO_CC_ID) → DOCTOS_CC → VE/PV).
 */
function filtrosImporteCobro(req, importAlias = 'i', opts = {}) {
  const base = buildFiltros(req, importAlias, {
    omitVendedorCliente: true,
    fechaExpr: opts.coalesceDcFecha ? `COALESCE(${importAlias}.FECHA, dc.FECHA)` : undefined,
  });
  let sql = base.sql;
  const params = [...base.params];
  const a = importAlias;
  const vid = req.query.vendedor ? parseInt(req.query.vendedor, 10) : NaN;
  if (!isNaN(vid) && vid > 0) {
    sql += ` AND EXISTS (
      SELECT 1 FROM DOCTOS_CC _fc
      LEFT JOIN DOCTOS_VE _ve ON _ve.DOCTO_VE_ID = _fc.DOCTO_VE_ID
      LEFT JOIN DOCTOS_PV _pv ON _pv.DOCTO_PV_ID = _fc.DOCTO_PV_ID
      WHERE _fc.DOCTO_CC_ID = COALESCE(${a}.DOCTO_CC_ACR_ID, ${a}.DOCTO_CC_ID)
        AND COALESCE(_ve.VENDEDOR_ID, _pv.VENDEDOR_ID, 0) = ?
    )`;
    params.push(vid);
  }
  const cid = req.query.cliente ? parseInt(req.query.cliente, 10) : NaN;
  if (!isNaN(cid) && cid > 0) {
    sql += ` AND EXISTS (
      SELECT 1 FROM DOCTOS_CC _fc2
      WHERE _fc2.DOCTO_CC_ID = COALESCE(${a}.DOCTO_CC_ACR_ID, ${a}.DOCTO_CC_ID)
        AND _fc2.CLIENTE_ID = ?
    )`;
    params.push(cid);
  }
  return { sql, params, lookbackOverride: base.lookbackOverride };
}

/** Restringe filas a CC ligado a factura VE y/o PV (según panel tipo). */
function sqlTipoFacLinkCc(aliasFac = 'fac', tipo = '') {
  const f = aliasFac;
  if (tipo === 'VE') return ` AND ${f}.DOCTO_VE_ID IS NOT NULL `;
  if (tipo === 'PV') return ` AND ${f}.DOCTO_PV_ID IS NOT NULL `;
  return ` AND (${f}.DOCTO_VE_ID IS NOT NULL OR ${f}.DOCTO_PV_ID IS NOT NULL) `;
}

/** Días calendario del periodo del filtro (para consumo diario promedio y cobertura). */
function consumosPeriodCalendarDays(q) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let { desde, hasta, anio, mes } = q || {};
  if (desde && !reDate.test(String(desde))) desde = null;
  if (hasta && !reDate.test(String(hasta))) hasta = null;
  if (desde && hasta) {
    const d0 = new Date(String(desde) + 'T12:00:00');
    const d1 = new Date(String(hasta) + 'T12:00:00');
    return Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
  }
  const y = anio != null && String(anio).trim() !== '' ? parseInt(anio, 10) : NaN;
  const m = mes != null && String(mes).trim() !== '' ? parseInt(mes, 10) : NaN;
  if (!isNaN(y) && !isNaN(m)) return new Date(y, m, 0).getDate();
  if (!isNaN(y) && isNaN(m)) return 365;
  return 30;
}

/**
 * Clona query string y aplica el periodo inmediatamente anterior (mismo tipo de filtro).
 * Conserva vendedor, cliente, tipo, db.
 */
function consumosPrevPeriodQuery(baseQ) {
  const q = Object.assign({}, baseQ || {});
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let { desde, hasta, anio, mes, dia } = q;
  if (desde && !reDate.test(String(desde))) desde = null;
  if (hasta && !reDate.test(String(hasta))) hasta = null;
  const iso = dt =>
    dt.getFullYear() +
    '-' +
    String(dt.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getDate()).padStart(2, '0');
  if (desde && hasta) {
    if (String(desde) === String(hasta)) {
      const d = new Date(String(desde) + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      const s = iso(d);
      return Object.assign({}, q, { desde: s, hasta: s, anio: undefined, mes: undefined, dia: undefined });
    }
    const d0 = new Date(String(desde) + 'T12:00:00');
    const d1 = new Date(String(hasta) + 'T12:00:00');
    const days = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
    const prevEnd = new Date(d0.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
    return Object.assign({}, q, {
      desde: iso(prevStart),
      hasta: iso(prevEnd),
      anio: undefined,
      mes: undefined,
      dia: undefined,
    });
  }
  const y = anio != null && String(anio).trim() !== '' ? parseInt(anio, 10) : NaN;
  const m = mes != null && String(mes).trim() !== '' ? parseInt(mes, 10) : NaN;
  if (!isNaN(y) && !isNaN(m)) {
    let pm = m - 1;
    let py = y;
    if (pm < 1) {
      pm = 12;
      py--;
    }
    return Object.assign({}, q, {
      anio: String(py),
      mes: String(pm),
      desde: undefined,
      hasta: undefined,
      dia: undefined,
    });
  }
  if (!isNaN(y) && isNaN(m)) {
    return Object.assign({}, q, {
      anio: String(y - 1),
      mes: undefined,
      desde: undefined,
      hasta: undefined,
      dia: undefined,
    });
  }
  if (dia && reDate.test(String(dia))) {
    const d = new Date(String(dia) + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    return Object.assign({}, q, {
      dia: iso(d),
      desde: undefined,
      hasta: undefined,
      anio: undefined,
      mes: undefined,
    });
  }
  return null;
}

function consumosVendedorClienteSql(req, alias = 'd') {
  const conds = [];
  const params = [];
  const { vendedor, cliente } = req.query || {};
  if (vendedor) {
    conds.push(`${alias}.VENDEDOR_ID = ?`);
    params.push(parseInt(vendedor, 10));
  }
  if (cliente) {
    conds.push(`${alias}.CLIENTE_ID = ?`);
    params.push(parseInt(cliente, 10));
  }
  return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', params };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VENTAS — MACRO SQL (UNION ALL DOCTOS_VE + DOCTOS_PV)
//  tipo: 'VE'=Industrial, 'PV'=Mostrador, ''=Todos
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * UNION ALL VE+PV: **una fila por documento** con IMPORTE_NETO = suma de líneas DET (DAX dLineasDocumentos),
 * solo TIPO_DOCTO F y V, ESTATUS no C/D/S. Sin tipo R. Documentos sin renglones o importe 0 no entran.
 * @param {string} tipo - 'VE', 'PV' o '' (todos)
 */
function ventasSub(tipo = '') {
  const L = sqlDetLineImporteExpr('det');
  const w = sqlWhereFacturaVentaValida('d');
  const ve = `
    SELECT
      d.FECHA,
      COALESCE(SUM(${L}), 0) AS IMPORTE_NETO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.DOCTO_VE_ID,
      CAST(NULL AS INTEGER) AS DOCTO_PV_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    INNER JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE ${w}
    GROUP BY d.DOCTO_VE_ID, d.FECHA, d.VENDEDOR_ID, d.CLIENTE_ID, d.FOLIO, d.TIPO_DOCTO, d.ESTATUS
    HAVING COALESCE(SUM(${L}), 0) <> 0`;

  const pv = `
    SELECT
      d.FECHA,
      COALESCE(SUM(${L}), 0) AS IMPORTE_NETO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    INNER JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
    WHERE ${w}
    GROUP BY d.DOCTO_PV_ID, d.FECHA, d.VENDEDOR_ID, d.CLIENTE_ID, d.FOLIO, d.TIPO_DOCTO, d.ESTATUS
    HAVING COALESCE(SUM(${L}), 0) <> 0`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COTIZACIONES — DAX: TIPO_DOCTO = "C" y ESTATUS <> "C"; importe = líneas − DSCTO_IMPORTE.
// ═══════════════════════════════════════════════════════════════════════════════
function sqlWhereCotizacionActiva(alias = 'd') {
  const a = alias;
  return `(UPPER(TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(4)))) = 'C') AND (COALESCE(${a}.ESTATUS, 'N') <> 'C')`;
}

function normalizeCotizacionResumenRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    HOY: Number(r.HOY) || 0,
    MES_ACTUAL: Number(r.MES_ACTUAL) || 0,
    COTIZACIONES_MES: Number(r.COTIZACIONES_MES) || 0,
    COTIZACIONES_HOY: Number(r.COTIZACIONES_HOY) || 0,
  };
}

/**
 * Subconsulta de consumo por unidades vendidas (VE + PV)
 * tipo: 'VE' | 'PV' | '' (ambos)
 */
function consumosSub(tipo = '') {
  const w = sqlWhereFacturaVentaValida('d');
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
    WHERE ${w}`;

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
    WHERE ${w}`;

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
/** Condición de pago tipo contado / inmediato: no debe computar atraso ni buckets de morosidad. */
const CXC_SQL_ES_CONTADO = `(
      POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
      OR POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
      OR POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
    )`;
/** Días desde FECHA_EMISION hasta vencimiento si no hay fila en VENCIMIENTOS_CARGOS_CC (0 = contado / mismo día). */
const CXC_DIAS_SUM_INT = `CAST((
      CASE
        WHEN POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0 THEN 0
        WHEN cp.DIAS_PPAG IS NOT NULL THEN cp.DIAS_PPAG
        ELSE 30
      END
    ) AS INTEGER)`;
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
// Días hasta vencimiento: DIAS_PPAG del catálogo (0 = contado / vence mismo día).
// Antes: NULLIF(DIAS_PPAG,0) + default 30 convertía contado (0) en +30 días → "vencido" falso.
// Ahora: CONTADO en nombre fuerza 0 días; si DIAS_PPAG IS NOT NULL se usa tal cual; si no, 30.
function cxcCargosSQL() {
  return `(
    SELECT
      i.DOCTO_CC_ID,
      dc.CLIENTE_ID,
      dc.FOLIO,
      i.IMPORTE                                                       AS SALDO,
      CAST(
        CASE
          WHEN ${CXC_SQL_ES_CONTADO} THEN CAST(dc.FECHA AS DATE)
          ELSE COALESCE(MIN(vc.FECHA_VENCIMIENTO), CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT})
        END
      AS DATE)                                                        AS FECHA_VENCIMIENTO,
      CASE
        WHEN ${CXC_SQL_ES_CONTADO} THEN 0
        ELSE (CURRENT_DATE - CAST(COALESCE(
          MIN(vc.FECHA_VENCIMIENTO),
          CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}
        ) AS DATE))
      END                                                             AS DIAS_VENCIDO
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
             i.IMPORTE, i.IMPUESTO, cp.DIAS_PPAG, cp.NOMBRE
  )`;
}

// Deprecated — mantener para compatibilidad pero los endpoints usan cxcClienteSQL/cxcCargosSQL
function cxcSaldosSub() { return cxcCargosSQL(); }

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG / METAS  — ideal = +30% sobre meta diaria (Power BI / DAX)
// ═══════════════════════════════════════════════════════════════════════════════

get('/api/config/metas', async (req) => {
  const dbo = getReqDbOpts(req);
  const rows = await query(`
    SELECT COUNT(DISTINCT VENDEDOR_ID) AS NUM_VENDEDORES
    FROM DOCTOS_VE
    WHERE (
      (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
      OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
      OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
    )
    AND EXTRACT(YEAR  FROM FECHA) = EXTRACT(YEAR  FROM CURRENT_DATE)
    AND EXTRACT(MONTH FROM FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
  `, [], 12000, dbo);
  const numV = (rows[0] && rows[0].NUM_VENDEDORES) ? Number(rows[0].NUM_VENDEDORES) : 1;

  const META_DIA_V   = 5650;
  const META_IDEAL_V = 5650 * 1.30;
  const META_DIA_C   = 10000;
  const META_IDEAL_C = 10000 * 1.30;

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

get('/api/config/filtros', async (req) => {
  const dbo = getReqDbOpts(req);
  const [vendedores, clientes, anios] = await Promise.all([
    query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`, [], 12000, dbo)
      .catch(() => query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES ORDER BY NOMBRE`, [], 12000, dbo)),
    query(`
      SELECT FIRST 500 d.CLIENTE_ID, c.NOMBRE
      FROM (
        SELECT DISTINCT CLIENTE_ID FROM DOCTOS_VE
        WHERE ((TIPO_DOCTO='F' AND ESTATUS<>'C') OR (TIPO_DOCTO='V' AND ESTATUS NOT IN ('C','T')))
          AND FECHA >= (CURRENT_DATE - 365)
      ) d
      JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
      ORDER BY c.NOMBRE
    `, [], 12000, dbo),
    query(`
      SELECT DISTINCT EXTRACT(YEAR FROM FECHA) AS ANIO
      FROM DOCTOS_VE
      WHERE (TIPO_DOCTO='F' OR TIPO_DOCTO='V') AND ESTATUS <> 'C'
      ORDER BY ANIO DESC
    `, [], 12000, dbo),
  ]);
  return { vendedores, clientes, anios };
});
// ═══════════════════════════════════════════════════════════
//  VENTAS — RESÚMENES
// ═══════════════════════════════════════════════════════════

// Ventas del periodo: HOY = venta del d\u00eda actual; MES_ACTUAL = total del periodo filtrado (anio/mes o desde-hasta) para que cuadre con Power BI.
get('/api/ventas/resumen', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f    = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const rows = await query(`
    SELECT
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE
               THEN d.IMPORTE_NETO ELSE 0 END)                      AS HOY,
      COALESCE(SUM(d.IMPORTE_NETO), 0)                              AS MES_ACTUAL,
      COUNT(*)                                                      AS FACTURAS_MES,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) < CURRENT_DATE
               THEN d.IMPORTE_NETO ELSE 0 END)                     AS HASTA_AYER_MES
    FROM ${ventasSub(tipo)} d
    WHERE 1=1 ${f.sql}
  `, f.params, 12000, dbo).catch(() => []);
  return rows[0] || {};
});

// Cotizaciones: rango de fechas explícito (primer/último día del mes) para que Firebird use índice y no escanee toda la tabla.
function lastDayOfMonth(y, m) {
  const d = new Date(y, m, 0); // m 1-12
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
get('/api/ventas/cotizaciones/resumen', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const rows = await query(`
    SELECT
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE
               THEN d.IMPORTE_NETO ELSE 0 END)         AS HOY,
      COALESCE(SUM(d.IMPORTE_NETO), 0)                 AS MES_ACTUAL,
      COUNT(*)                                         AS COTIZACIONES_MES,
      COUNT(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 END) AS COTIZACIONES_HOY
    FROM ${sqlCotizacionesVeDocSubquery(f.sql)} d
  `, f.params, 12000, dbo).catch(() => []);
  return normalizeCotizacionResumenRow(rows[0]);
});

get('/api/ventas/diarias', async (req) => {
  const dbo = getReqDbOpts(req);
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
  const rows = await query(sql, [desdeStr], 12000, dbo).catch(() => []);
  if (tipo !== '') return (rows || []).map(r => ({ DIA: r.DIA, VENTAS_VE: tipo === 'VE' ? (r.TOTAL_VENTAS || 0) : 0, VENTAS_PV: tipo === 'PV' ? (r.TOTAL_VENTAS || 0) : 0, TOTAL_VENTAS: r.TOTAL_VENTAS || 0 }));
  return rows || [];
});

get('/api/ventas/semanales', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/mensuales', async (req) => {
  const dbo = getReqDbOpts(req);
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
    `, f.params, 12000, dbo).catch(() => []);
    return (rows || []).map(r => ({ ANIO: r.ANIO, MES: r.MES, FACTURAS: r.FACTURAS, VENTAS_VE: r.VENTAS_VE, VENTAS_PV: r.VENTAS_PV, TOTAL: r.TOTAL }));
  }
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 12000, dbo).catch(() => []).then(rows => (rows || []).map(r => ({ ANIO: r.ANIO, MES: r.MES, FACTURAS: r.FACTURAS, VENTAS_VE: tipo === 'VE' ? r.TOTAL : 0, VENTAS_PV: tipo === 'PV' ? r.TOTAL : 0, TOTAL: r.TOTAL })));
});

get('/api/ventas/cotizaciones/diarias', async (req) => {
  const dbo = getReqDbOpts(req);
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const rows = await query(`
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_COTIZACIONES
    FROM ${sqlCotizacionesVeDocSubquery('')} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, [desdeStr], 12000, dbo).catch(() => []);
  return (rows || []).map(r => ({ DIA: r.DIA, COTIZACIONES: r.COTIZACIONES, TOTAL_COTIZACIONES: r.TOTAL_COTIZACIONES || 0 }));
});

get('/api/ventas/cotizaciones/semanales', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${sqlCotizacionesVeDocSubquery(f.sql)} d
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/cotizaciones/mensuales', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${sqlCotizacionesVeDocSubquery(f.sql)} d
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/top-clientes', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
});

// ventas (4).html y vendedores esperan: VENDEDOR, VENTAS_HOY, VENTAS_MES, VENTAS_MES_VE, VENTAS_MES_PV, FACTURAS_HOY, FACTURAS_MES
get('/api/ventas/por-vendedor', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/por-vendedor/cotizaciones', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const vid = req.query.vendedor ? parseInt(req.query.vendedor, 10) : null;
  const vendSql = Number.isFinite(vid) ? ' AND d.VENDEDOR_ID = ?' : '';
  const params = [...f.params];
  if (Number.isFinite(vid)) params.push(vid);
  return query(`
    SELECT
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(12))) AS VENDEDOR,
      d.VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS COTIZACIONES_HOY,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS COTIZACIONES_MES,
      COUNT(*) AS NUM_COTI_MES
    FROM ${sqlCotizacionesVeDocSubquery(' AND d.VENDEDOR_ID > 0' + f.sql + vendSql)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    GROUP BY v.NOMBRE, d.VENDEDOR_ID
    ORDER BY COTIZACIONES_MES DESC
  `, params, 12000, dbo).catch(() => []);
});

get('/api/ventas/recientes', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/vs-cotizaciones', async (req) => {
  const dbo = getReqDbOpts(req);
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
    `, [desdeStr], 12000, dbo).catch(() => []),
    query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_COTI, COUNT(*) AS NUM_COTI
      FROM ${sqlCotizacionesVeDocSubquery(' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)')} d
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, [desdeStr], 12000, dbo).catch(() => []),
  ]);
  return { ventas: ventasMes || [], cotizaciones: cotizMes || [] };
});

get('/api/ventas/ranking-clientes', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT d.CLIENTE_ID, c.NOMBRE, COALESCE(SUM(d.IMPORTE_NETO),0) AS VENTA
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY VENTA DESC
  `, f.params, 12000, dbo).catch(() => []);
});

// Cobradas: ventas en periodo (d.FECHA) + cobro real por vendedor (IMPORTES_DOCTOS_CC tipo R). Fecha de periodo: COALESCE(i.FECHA, dc.FECHA) si i.FECHA viene nula.
get('/api/ventas/cobradas', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const fi = filtrosImporteCobro(req, 'i', { coalesceDcFecha: true });
  const tipo = getTipo(req);
  const tipoFac = sqlTipoFacLinkCc('fac', tipo);
  const vendedorQ = req.query.vendedor ? ` AND d.VENDEDOR_ID = ${parseInt(req.query.vendedor, 10)}` : '';

  /** Cobros del periodo: total sin exigir enlace VE/PV (muchas bases no llenan DOCTO_* en CC). */
  const cobroSqlFull = `
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${fi.sql}`;
  /** Misma join que antes para atribuir por vendedor cuando sí hay factura ligada. */
  const cobroSqlAtrib = `
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    LEFT JOIN DOCTOS_CC fac ON fac.DOCTO_CC_ID = COALESCE(i.DOCTO_CC_ACR_ID, i.DOCTO_CC_ID)
    LEFT JOIN DOCTOS_VE ve ON ve.DOCTO_VE_ID = fac.DOCTO_VE_ID
    LEFT JOIN DOCTOS_PV pv ON pv.DOCTO_PV_ID = fac.DOCTO_PV_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = COALESCE(ve.VENDEDOR_ID, pv.VENDEDOR_ID)
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${tipoFac} ${fi.sql}`;

  const [rows, cobroPorVend, cobrosRow, cobroLinkedRows] = await Promise.all([
    query(`
      SELECT d.VENDEDOR_ID, v.NOMBRE AS VENDEDOR, COUNT(DISTINCT d.FOLIO) AS NUM_FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_VENTA
      FROM ${ventasSub(tipo)} d
      LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
      WHERE d.VENDEDOR_ID > 0 ${f.sql} ${vendedorQ}
      GROUP BY d.VENDEDOR_ID, v.NOMBRE
    `, f.params, 12000, dbo).catch(() => []),
    query(`
      SELECT
        COALESCE(ve.VENDEDOR_ID, pv.VENDEDOR_ID, 0) AS VENDEDOR_ID,
        MAX(COALESCE(v.NOMBRE, '')) AS VENDEDOR,
        COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlAtrib}
      GROUP BY COALESCE(ve.VENDEDOR_ID, pv.VENDEDOR_ID, 0)
    `, fi.params, 12000, dbo).catch(() => []),
    query(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlFull}
    `, fi.params, 12000, dbo).catch(() => [{ TOTAL_COBRADO: 0 }]),
    query(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlAtrib}
    `, fi.params, 12000, dbo).catch(() => [{ TOTAL_COBRADO: 0 }]),
  ]);

  const totalCobradoReal = +(cobrosRow && cobrosRow[0] && cobrosRow[0].TOTAL_COBRADO) || 0;
  const totalLinked = +(cobroLinkedRows && cobroLinkedRows[0] && cobroLinkedRows[0].TOTAL_COBRADO) || 0;
  const orphanCobro = Math.max(0, Math.round((totalCobradoReal - totalLinked) * 100) / 100);
  const totalFacturado = (rows || []).reduce((s, r) => s + (+r.TOTAL_VENTA || 0), 0);
  const cobMap = Object.fromEntries((cobroPorVend || []).map(r => [r.VENDEDOR_ID, +r.TOTAL_COBRADO || 0]));
  const seen = new Set();
  const mapped = (rows || []).map(r => {
    seen.add(r.VENDEDOR_ID);
    const exact = cobMap[r.VENDEDOR_ID] != null ? +cobMap[r.VENDEDOR_ID] || 0 : 0;
    const share = totalFacturado > 0 ? orphanCobro * ((+r.TOTAL_VENTA || 0) / totalFacturado) : 0;
    const totalCob = Math.round((exact + share) * 100) / 100;
    return {
      VENDEDOR_ID: r.VENDEDOR_ID,
      VENDEDOR: r.VENDEDOR,
      NOMBRE: r.VENDEDOR,
      NUM_FACTURAS: r.NUM_FACTURAS,
      FACTURAS_COBRADAS: r.NUM_FACTURAS,
      TOTAL_VENTA: +r.TOTAL_VENTA || 0,
      TOTAL_COBRADO: totalCob,
    };
  });
  for (const c of cobroPorVend || []) {
    const vid = +c.VENDEDOR_ID || 0;
    if (vid <= 0 || seen.has(vid)) continue;
    seen.add(vid);
    mapped.push({
      VENDEDOR_ID: vid,
      VENDEDOR: c.VENDEDOR,
      NOMBRE: c.VENDEDOR,
      NUM_FACTURAS: 0,
      FACTURAS_COBRADAS: 0,
      TOTAL_VENTA: 0,
      TOTAL_COBRADO: +c.TOTAL_COBRADO || 0,
    });
  }
  let sumC = mapped.reduce((s, r) => s + (+r.TOTAL_COBRADO || 0), 0);
  const rem = Math.round((totalCobradoReal - sumC) * 100) / 100;
  if (rem > 0.02 && totalFacturado > 0) {
    mapped.forEach(r => {
      r.TOTAL_COBRADO = Math.round((+r.TOTAL_COBRADO + rem * ((+r.TOTAL_VENTA || 0) / totalFacturado)) * 100) / 100;
    });
  } else if (rem > 0.02) {
    mapped.push({
      VENDEDOR_ID: 0,
      VENDEDOR: 'Sin asignar',
      NOMBRE: 'Sin asignar',
      NUM_FACTURAS: 0,
      FACTURAS_COBRADAS: 0,
      TOTAL_VENTA: 0,
      TOTAL_COBRADO: rem,
    });
  }
  return { vendedores: mapped, totalFacturado, totalCobrado: totalCobradoReal };
});

// Líneas de cobro (tipo R): fecha del movimiento en IMPORTES_DOCTOS_CC; vendedor/cliente vía CC aplicado.
get('/api/ventas/cobradas-detalle', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  // Periodo del cobro: muchas bases dejan i.FECHA nula en tipo R; el resumen reparte cobros aun así, aquí se filtra con COALESCE(i.FECHA, dc.FECHA).
  const fi = filtrosImporteCobro(req, 'i', { coalesceDcFecha: true });
  const limit = Math.min(parseInt(req.query.limit, 10) || 400, 800);
  return query(`
    SELECT FIRST ${limit}
      CAST(COALESCE(i.FECHA, dc.FECHA) AS DATE) AS FECHA_COBRO,
      dc.FOLIO AS FOLIO_CC,
      COALESCE(fac.FOLIO, dc.FOLIO) AS FOLIO,
      cl.NOMBRE AS CLIENTE,
      CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END AS MONTO_COBRADO,
      COALESCE(v.NOMBRE, '') AS VENDEDOR
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    LEFT JOIN DOCTOS_CC fac ON fac.DOCTO_CC_ID = COALESCE(i.DOCTO_CC_ACR_ID, i.DOCTO_CC_ID)
    LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = COALESCE(fac.CLIENTE_ID, dc.CLIENTE_ID)
    LEFT JOIN DOCTOS_VE ve ON ve.DOCTO_VE_ID = fac.DOCTO_VE_ID
    LEFT JOIN DOCTOS_PV pv ON pv.DOCTO_PV_ID = fac.DOCTO_PV_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = COALESCE(ve.VENDEDOR_ID, pv.VENDEDOR_ID)
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${fi.sql}
    ORDER BY COALESCE(i.FECHA, dc.FECHA) DESC, dc.FOLIO DESC
  `, fi.params, 15000, dbo).catch(() => []);
});

// Margen por renglón: DOCTOS_VE_DET / DOCTOS_PV_DET (venta sin campo importe: PRECIO_T o UNIDADES×PRECIO_U).
get('/api/ventas/margen-lineas', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 3000, 12000);
  const docOk = sqlWhereFacturaVentaValida('d');
  const ventaSql = sqlDetLineImporteExpr('det');
  const mapRows = (rows) =>
    (rows || []).map((r) => {
      const venta = +r.VENTA || 0;
      const costo = +r.COSTO || 0;
      const util = venta - costo;
      const pct = venta > 0.0001 ? (util / venta) * 100 : null;
      return {
        ...r,
        UTILIDAD: Math.round(util * 100) / 100,
        MARGEN_PCT: pct == null ? null : Math.round(pct * 100) / 100,
      };
    });
  const buildUnion = (costExpr) => {
    const vePart = `
        SELECT
          d.FOLIO,
          CAST(d.FECHA AS DATE) AS FECHA,
          'VE' AS TIPO_SRC,
          c.NOMBRE AS CLIENTE,
          COALESCE(a.CLAVE, CAST(det.ARTICULO_ID AS VARCHAR(40))) AS CLAVE_ARTICULO,
          COALESCE(a.NOMBRE, '') AS DESC_ARTICULO,
          COALESCE(det.UNIDADES, 0) AS CANTIDAD,
          COALESCE(det.PRECIO_U, 0) AS PRECIO_U,
          CAST(${costExpr} AS DECIMAL(18, 4)) AS COSTO,
          CAST(${ventaSql} AS DECIMAL(18, 4)) AS VENTA
        FROM DOCTOS_VE d
        JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        WHERE ${docOk} ${f.sql}`;
    const pvPart = `
        SELECT
          d.FOLIO,
          CAST(d.FECHA AS DATE) AS FECHA,
          'PV' AS TIPO_SRC,
          c.NOMBRE AS CLIENTE,
          COALESCE(a.CLAVE, CAST(det.ARTICULO_ID AS VARCHAR(40))) AS CLAVE_ARTICULO,
          COALESCE(a.NOMBRE, '') AS DESC_ARTICULO,
          COALESCE(det.UNIDADES, 0) AS CANTIDAD,
          COALESCE(det.PRECIO_U, 0) AS PRECIO_U,
          CAST(${costExpr} AS DECIMAL(18, 4)) AS COSTO,
          CAST(${ventaSql} AS DECIMAL(18, 4)) AS VENTA
        FROM DOCTOS_PV d
        JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        WHERE ${docOk} ${f.sql}`;
    if (tipo === 'VE') return { sql: vePart, params: f.params };
    if (tipo === 'PV') return { sql: pvPart, params: f.params };
    return { sql: `${vePart} UNION ALL ${pvPart}`, params: [...f.params, ...f.params] };
  };
  const costFull =
    'COALESCE(NULLIF(det.COSTO_TOTAL, 0), COALESCE(det.UNIDADES, 0) * COALESCE(det.COSTO_UNITARIO, 0), COALESCE(det.UNIDADES, 0) * COALESCE(a.COSTO_PROMEDIO, 0), 0)';
  const costFallback = 'COALESCE(NULLIF(det.COSTO_TOTAL, 0), COALESCE(det.UNIDADES, 0) * COALESCE(a.COSTO_PROMEDIO, 0), 0)';
  try {
    const { sql, params } = buildUnion(costFull);
    const rows = await query(
      `SELECT FIRST ${limit} * FROM (${sql}) u ORDER BY u.FECHA DESC, u.FOLIO DESC`,
      params,
      20000,
      dbo
    );
    return mapRows(rows);
  } catch (e1) {
    console.error('[margen-lineas] intento 1:', e1.message);
    try {
      const { sql, params } = buildUnion(costFallback);
      const rows = await query(
        `SELECT FIRST ${limit} * FROM (${sql}) u ORDER BY u.FECHA DESC, u.FOLIO DESC`,
        params,
        20000,
        dbo
      );
      return mapRows(rows);
    } catch (e2) {
      console.error('[margen-lineas] intento 2:', e2.message);
      try {
        const { sql, params } = buildUnion('CAST(0 AS DECIMAL(18,4))');
        const rows = await query(
          `SELECT FIRST ${limit} * FROM (${sql}) u ORDER BY u.FECHA DESC, u.FOLIO DESC`,
          params,
          20000,
          dbo
        );
        return mapRows(rows);
      } catch (e3) {
        console.error('[margen-lineas] intento 3:', e3.message);
        return [];
      }
    }
  }
});

// Facturas del periodo de ventas con cobro acumulado en periodo de cobros (misma query string de filtro).
get('/api/ventas/cobradas-por-factura', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const fiIr = filtrosImporteCobro(req, 'ir', { coalesceDcFecha: true });
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 600, 2000);
  const sql = `
    SELECT FIRST ${limit}
      q.VENDEDOR_ID,
      q.VENDEDOR,
      q.TIPO_SRC,
      q.FOLIO_VE,
      q.FECHA_FACTURA,
      q.TOTAL_VENTA,
      q.COBRADO_PERIODO
    FROM (
      SELECT
        d.VENDEDOR_ID,
        COALESCE(v.NOMBRE, '') AS VENDEDOR,
        d.TIPO_SRC,
        d.FOLIO AS FOLIO_VE,
        CAST(d.FECHA AS DATE) AS FECHA_FACTURA,
        d.IMPORTE_NETO AS TOTAL_VENTA,
        COALESCE((
          SELECT SUM(CASE WHEN COALESCE(ir.IMPUESTO, 0) > 0 THEN ir.IMPORTE ELSE ir.IMPORTE / 1.16 END)
          FROM IMPORTES_DOCTOS_CC ir
          JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = ir.DOCTO_CC_ID
          WHERE ir.TIPO_IMPTE = 'R' AND COALESCE(ir.CANCELADO, 'N') = 'N'
            AND EXISTS (
              SELECT 1 FROM DOCTOS_CC ccf
              WHERE ccf.DOCTO_CC_ID = COALESCE(ir.DOCTO_CC_ACR_ID, ir.DOCTO_CC_ID)
                AND (
                  (d.TIPO_SRC = 'VE' AND ccf.DOCTO_VE_ID = d.DOCTO_VE_ID)
                  OR (d.TIPO_SRC = 'PV' AND ccf.DOCTO_PV_ID = d.DOCTO_PV_ID)
                )
            )
            ${fiIr.sql}
        ), 0) AS COBRADO_PERIODO
      FROM ${ventasSub(tipo)} d
      LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
      WHERE d.VENDEDOR_ID > 0 ${f.sql}
    ) q
    WHERE q.COBRADO_PERIODO > 0.005
    ORDER BY q.VENDEDOR_ID, q.COBRADO_PERIODO DESC, q.FECHA_FACTURA DESC
  `;
  const params = [...f.params, ...fiIr.params];
  return query(sql, params, 20000, dbo).catch(() => []);
});

get('/api/ventas/margen', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const L = sqlDetLineImporteExpr('det');
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COALESCE(SUM((${L}) - COALESCE(det.COSTO_TOTAL, 0)), 0) AS MARGEN,
      COALESCE(SUM(${L}), 0) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${sqlWhereFacturaVentaValida('d')} ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/margen-articulos', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const L = sqlDetLineImporteExpr('det');
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION,
      COALESCE(SUM((${L}) - COALESCE(det.COSTO_TOTAL, 0)), 0) AS MARGEN,
      COALESCE(SUM(${L}), 0) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE ${sqlWhereFacturaVentaValida('d')} ${f.sql}
    GROUP BY a.ARTICULO_ID, a.DESCRIPCION ORDER BY MARGEN DESC
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/cotizaciones', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  return query(`
    SELECT FIRST ${limit}
      d.DOCTO_VE_ID, d.FECHA, d.FOLIO, d.TIPO_DOCTO, d.IMPORTE_NETO, d.CLIENTE_ID,
      c.NOMBRE AS CLIENTE, d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(12))) AS VENDEDOR
    FROM ${sqlCotizacionesVeDocSubquery(f.sql)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    ORDER BY d.FECHA DESC, d.FOLIO DESC
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/ventas/vendedores', async (req) => {
  const dbo = getReqDbOpts(req);
  return query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`, [], 12000, dbo).catch(() => []);
});

get('/api/ventas/diario', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params, 12000, dbo).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  VENTAS — CUMPLIMIENTO (con filtros anio, mes, vendedor)
// ═══════════════════════════════════════════════════════════

get('/api/ventas/cumplimiento', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const anioQ = req.query.anio ? parseInt(req.query.anio) : null;
  const mesQ = req.query.mes ? parseInt(req.query.mes) : null;
  const vendedorQ = req.query.vendedor ? parseInt(req.query.vendedor) : null;
  const desde = req.query.desde;
  const hasta = req.query.hasta;

  const [metas] = await query(`SELECT COALESCE(MAX(META_DIARIA_POR_VENDEDOR),0) AS META_DIA, COALESCE(MAX(META_IDEAL_POR_VENDEDOR),0) AS META_IDEAL FROM CONFIGURACIONES_GEN`, [], 12000, dbo).catch(() => [{ META_DIA: 5650, META_IDEAL: 6500 }]);
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
  `, [], 12000, dbo).catch(() => []);

  const ventaMap = {};
  (ventas || []).forEach(v => { ventaMap[v.VENDEDOR_ID] = v; });

  const rows = await query(`
    SELECT DISTINCT d.VENDEDOR_ID, COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS NOMBRE
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${condAnioMes} AND d.VENDEDOR_ID > 0 ${condVendedor}
    ORDER BY 2
  `, [], 12000, dbo).catch(() => []);

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
// Ventas: líneas DET (UNIDADES×precio), TIPO F/V, ESTATUS no C/D/S. Cotizaciones: TIPO C, líneas − DSCTO_IMPORTE.
async function directorResumenSnapshot(req, dbOpts, perQueryMs) {
  const qms = perQueryMs != null ? perQueryMs : 12000;
  const rq = { query: { ...req.query } };
  if (!rq.query.desde && !rq.query.hasta && !rq.query.anio) {
    const now = new Date();
    rq.query.anio = now.getFullYear();
    rq.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(rq, 'd');
  const [vRow, cxcSaldos, cxcAging, coRow] = await Promise.all([
    query(`
      SELECT
        SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS HOY,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS MES_ACTUAL,
        COUNT(*) AS FACTURAS_MES,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS MES_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS MES_PV
      FROM ${ventasSub()} d
      WHERE 1=1 ${f.sql}
    `, f.params, qms, dbOpts).catch(() => [{}]),
    query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs`, [], qms, dbOpts).catch(() => []),
    query(`SELECT cd.CLIENTE_ID, SUM(cd.SALDO) AS TOTAL_C, SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C FROM ${cxcCargosSQL()} cd GROUP BY cd.CLIENTE_ID`, [], qms, dbOpts).catch(() => []),
    query(`
      SELECT
        SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS IMPORTE_COTI_HOY,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS IMPORTE_COTI_MES,
        SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS COTI_HOY,
        COUNT(*) AS COTI_MES
      FROM ${sqlCotizacionesVeDocSubquery(f.sql)} d
    `, f.params, qms, dbOpts).catch(() => [{}]),
  ]);
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
  const co = coRow[0] || {};
  let numCliVenc = 0;
  (cxcAging || []).forEach(a => { if (+a.VENC_C > 0) numCliVenc++; });
  return {
    ventas: { HOY: +(v.HOY||0), MES_ACTUAL: +(v.MES_ACTUAL||0), FACTURAS_MES: +(v.FACTURAS_MES||0), MES_VE: +(v.MES_VE||0), MES_PV: +(v.MES_PV||0) },
    cxc: { SALDO_TOTAL: Math.round(saldoTotal*100)/100, NUM_CLIENTES: (cxcSaldos||[]).length, NUM_CLIENTES_VENCIDOS: numCliVenc, VENCIDO: Math.round(vencido*100)/100, POR_VENCER: Math.round(porVencer*100)/100 },
    cotizaciones: { COTI_HOY: +(co.COTI_HOY||0), IMPORTE_COTI_HOY: +(co.IMPORTE_COTI_HOY||0), IMPORTE_COTI_MES: +(co.IMPORTE_COTI_MES||0), COTI_MES: +(co.COTI_MES||0) },
  };
}

get('/api/director/resumen', async (req) => directorResumenSnapshot(req, getReqDbOpts(req), 12000));

// Catálogo de bases (sin credenciales) + scorecard multi-empresa (misma lógica que director, concurrencia acotada).
get('/api/universe/databases', async () =>
  DATABASE_REGISTRY.map(d => ({ id: d.id, label: d.label, database: d.options.database, host: d.options.host }))
);

get('/api/universe/scorecard', async (req) => {
  const conc = Math.min(Math.max(parseInt(req.query.concurrency, 10) || 2, 1), 5);
  const qms = Math.min(Math.max(parseInt(req.query.queryMs, 10) || 10000, 3000), 180000);
  const rows = await mapPoolLimit(DATABASE_REGISTRY, conc, async (entry) => {
    try {
      const data = await directorResumenSnapshot(req, entry.options, qms);
      const v = data.ventas || {};
      const c = data.cxc || {};
      const pctVenc = c.SALDO_TOTAL > 0 ? Math.round((c.VENCIDO / c.SALDO_TOTAL) * 1000) / 10 : 0;
      return {
        ok: true,
        id: entry.id,
        label: entry.label,
        ventas_mes: +(v.MES_ACTUAL || 0),
        ventas_hoy: +(v.HOY || 0),
        facturas_mes: +(v.FACTURAS_MES || 0),
        cxc_saldo: +(c.SALDO_TOTAL || 0),
        cxc_vencido: +(c.VENCIDO || 0),
        cxc_pct_vencido: pctVenc,
        cotiz_importe_mes: +((data.cotizaciones && data.cotizaciones.IMPORTE_COTI_MES) || 0),
        detail: data,
      };
    } catch (e) {
      return { ok: false, id: entry.id, label: entry.label, error: e.message };
    }
  });
  const ok = rows.filter(r => r.ok);
  const totVentas = ok.reduce((s, r) => s + (r.ventas_mes || 0), 0);
  const totCxc = ok.reduce((s, r) => s + (r.cxc_saldo || 0), 0);
  const totCoti = ok.reduce((s, r) => s + (r.cotiz_importe_mes || 0), 0);
  const totFacts = ok.reduce((s, r) => s + (r.facturas_mes || 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    concurrency: conc,
    queryMs: qms,
    empresas: rows,
    consolidado: {
      ventas_mes_sum: totVentas,
      cxc_saldo_sum: Math.round(totCxc * 100) / 100,
      cotiz_mes_sum: Math.round(totCoti * 100) / 100,
      facturas_mes_sum: totFacts,
      empresas_ok: ok.length,
      empresas_err: rows.length - ok.length,
      empresas_total: rows.length,
    },
  };
});

get('/api/director/ventas-diarias', async (req) => {
  const dbo = getReqDbOpts(req);
  const dias = Math.min(parseInt(req.query.dias) || 30, 366);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const vid = req.query.vendedor ? parseInt(req.query.vendedor, 10) : null;
  const vendSql = Number.isFinite(vid) ? ' AND d.VENDEDOR_ID = ?' : '';
  const paramsDiarias = [desdeStr];
  if (Number.isFinite(vid)) paramsDiarias.push(vid);
  const rows = await query(`
    SELECT CAST(d.FECHA AS DATE) AS DIA,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS
    FROM ${ventasSub()} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE) ${vendSql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, paramsDiarias, 12000, dbo).catch(() => []);

  const numVRow = await query(`SELECT COUNT(*) AS N FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N')`, [], 12000, dbo).catch(() => [{ N: 1 }]);
  let numV = (numVRow[0] && numVRow[0].N != null) ? Math.max(Number(numVRow[0].N), 1) : 1;
  if (Number.isFinite(vid)) numV = 1;
  const cfgRow = await query(`SELECT COALESCE(MAX(META_DIARIA_POR_VENDEDOR), 0) AS M FROM CONFIGURACIONES_GEN`, [], 12000, dbo).catch(() => [{ M: 0 }]);
  const META_POR_VENDEDOR = +(cfgRow[0] && cfgRow[0].M) > 0 ? +(cfgRow[0].M) : 5650;
  const FACTOR_IDEAL = 1.30;

  (rows || []).forEach(r => {
    const d = r.DIA ? new Date(r.DIA) : new Date();
    const wd = d.getDay();
    const laboral = wd >= 1 && wd <= 6;
    const metaEq = laboral ? META_POR_VENDEDOR * numV : 0;
    r.META_EQUILIBRIO = Math.round(metaEq * 100) / 100;
    r.META_IDEAL = Math.round(metaEq * FACTOR_IDEAL * 100) / 100;
  });

  return rows;
});

// director.html espera CLIENTE, TOTAL_VENTAS, NUM_FACTURAS (mismo periodo que la barra de filtros)
get('/api/director/top-clientes', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 15, 50);
  return query(`
    SELECT FIRST ${limit} d.CLIENTE_ID, COALESCE(c.NOMBRE, 'Sin nombre') AS CLIENTE,
      COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_VENTAS, COUNT(*) AS NUM_FACTURAS
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL_VENTAS DESC
  `, f.params, 12000, dbo).catch(() => []);
});

// director.html e index.html (Inicio): listado de vendedores con ventas en el periodo.
// Acepta desde, hasta, anio, mes. Si no hay fechas, se usa mes actual (comportamiento original).
get('/api/director/vendedores', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
  return rows;
});

// director.html espera FOLIO, TIPO_SRC, CLIENTE, VENDEDOR, TOTAL, FECHA (periodo del filtro; por defecto mes actual)
get('/api/director/recientes', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  return query(`
    SELECT FIRST ${limit} d.FOLIO, d.TIPO_SRC, COALESCE(c.NOMBRE, 'Sin cliente') AS CLIENTE, COALESCE(v.NOMBRE, 'Sin vendedor') AS VENDEDOR, d.IMPORTE_NETO AS TOTAL, d.FECHA
    FROM ${ventasSub()} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE 1=1 ${f.sql}
    ORDER BY d.FECHA DESC, d.FOLIO DESC
  `, f.params, 12000, dbo).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CXC
// ═══════════════════════════════════════════════════════════

// Filas por documento con DIAS_VENCIDO y SALDO_NETO (Cargo − Cobro). Sin filtro de saldo > 0 (para poder combinar WHERE en vencidas).
function cxcDocSaldosInnerSQL(cfSql) {
  return `(
    SELECT d.DOCTO_CC_ID, d.CLIENTE_ID, d.DIAS_VENCIDO,
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
  )`;
}

// Subconsulta usable en FROM: alias doc + solo documentos con saldo pendiente.
// Contado / efectivo inmediato: DIAS_VENCIDO = 0 (no entra a morosidad). No duplicar alias doc al anidar (rompía /api/cxc/vencidas).
function cxcDocSaldosSQL(cfSql) {
  return `${cxcDocSaldosInnerSQL(cfSql)} doc WHERE doc.SALDO_NETO > 0`;
}

// Resumen CxC: Vencido y No vencido (suma Saldo_Documento). Contado cuenta como vigente (sin días de atraso).
get('/api/cxc/resumen', async (req) => {
  const dbo = getReqDbOpts(req);
  const cf = req.query.cliente ? parseInt(req.query.cliente) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const docSal = cxcDocSaldosSQL(cfSql);
  const docSalVencCli = docSal.replace(/WHERE doc\.SALDO_NETO > 0\s*$/i, 'WHERE doc.SALDO_NETO > 0 AND doc.DIAS_VENCIDO >= 1');
  const [totales, numCli, numCliVenc] = await Promise.all([
    query(`
      SELECT
        SUM(CASE WHEN doc.DIAS_VENCIDO >= 1 THEN doc.SALDO_NETO ELSE 0 END) AS VENCIDO,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS POR_VENCER
      FROM ${docSal}
    `, [], 12000, dbo).catch(() => [{ VENCIDO: 0, POR_VENCER: 0 }]),
    query(`SELECT COUNT(DISTINCT doc.CLIENTE_ID) AS N FROM ${docSal}`, [], 12000, dbo).catch(() => [{ N: 0 }]),
    query(`SELECT COUNT(DISTINCT doc.CLIENTE_ID) AS N FROM ${docSalVencCli}`, [], 12000, dbo).catch(() => [{ N: 0 }]),
  ]);
  const vencido = +(totales[0] && totales[0].VENCIDO) || 0;
  const porVencer = +(totales[0] && totales[0].POR_VENCER) || 0;
  const saldoTotal = vencido + porVencer;
  return {
    SALDO_TOTAL  : Math.round(saldoTotal * 100) / 100,
    NUM_CLIENTES : +(numCli[0] && numCli[0].N) || 0,
    NUM_CLIENTES_VENCIDOS: +(numCliVenc[0] && numCliVenc[0].N) || 0,
    VENCIDO      : Math.round(vencido   * 100) / 100,
    POR_VENCER   : Math.round(porVencer * 100) / 100,
  };
});

// Aging por documento: suma de Saldo_Documento por rango de días (igual que Power BI). Buckets suman = SALDO_TOTAL.
get('/api/cxc/aging', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => [{ CORRIENTE: 0, DIAS_1_30: 0, DIAS_31_60: 0, DIAS_61_90: 0, DIAS_MAS_90: 0 }]);
  const r = rows[0] || {};
  return {
    CORRIENTE  : Math.round((+r.CORRIENTE   || 0) * 100) / 100,
    DIAS_1_30  : Math.round((+r.DIAS_1_30   || 0) * 100) / 100,
    DIAS_31_60 : Math.round((+r.DIAS_31_60  || 0) * 100) / 100,
    DIAS_61_90 : Math.round((+r.DIAS_61_90  || 0) * 100) / 100,
    DIAS_MAS_90: Math.round((+r.DIAS_MAS_90 || 0) * 100) / 100,
  };
});

// Facturas vencidas: misma base que aging (cxcDocSaldosSQL). Sin subconsultas anidadas extra (Firebird).
get('/api/cxc/vencidas', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const cf = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  return query(`
    SELECT FIRST ${limit}
      dc.FOLIO,
      c.NOMBRE AS CLIENTE,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      x.SALDO_NETO AS SALDO,
      x.DIAS_ATRASO AS ATRASO,
      x.DIAS_ATRASO AS DIAS_ATRASO,
      CAST(dc.FECHA AS DATE) AS FECHA_VENTA,
      CAST(CAST(dc.FECHA AS DATE) + CAST(COALESCE(cp.DIAS_PPAG, 0) AS INTEGER) AS DATE) AS FECHA_VENC_PLAZO,
      CAST(NULL AS DATE) AS FECHA_VENCIMIENTO,
      x.DIAS_ATRASO AS TIEMPO_SIN_PAGAR_DIAS
    FROM (
      SELECT
        doc.DOCTO_CC_ID,
        doc.CLIENTE_ID,
        MAX(doc.DIAS_VENCIDO) AS DIAS_ATRASO,
        MAX(doc.SALDO_NETO) AS SALDO_NETO
      FROM ${cxcDocSaldosInnerSQL(cfSql)} doc
      WHERE doc.SALDO_NETO > 0.005 AND doc.DIAS_VENCIDO >= 1
      GROUP BY doc.DOCTO_CC_ID, doc.CLIENTE_ID
    ) x
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = x.DOCTO_CC_ID
    JOIN CLIENTES c ON c.CLIENTE_ID = x.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
    ORDER BY x.SALDO_NETO DESC, x.DIAS_ATRASO DESC
  `, [], 12000, dbo).catch(() => []);
});

// Top Deudores: saldo neto + condición + vencido proporcional al saldo (igual que /api/cxc/resumen). Acepta ?cliente= para filtrar.
get('/api/cxc/top-deudores', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const cf = req.query.cliente ? parseInt(req.query.cliente) : null;
  const cfSql = cf ? ` WHERE s.CLIENTE_ID = ${cf}` : '';
  const cfSql2 = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const [saldos, aging] = await Promise.all([
    query(`SELECT s.CLIENTE_ID, s.SALDO FROM ${cxcClienteSQL()} s ${cfSql}`, [], 12000, dbo).catch(() => []),
    query(`
      SELECT cd.CLIENTE_ID,
        SUM(cd.SALDO) AS TOTAL_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C,
        MAX(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS,
        COUNT(*) AS NUM_DOCS
      FROM ${cxcCargosSQL()} cd
      WHERE 1=1 ${cfSql2}
      GROUP BY cd.CLIENTE_ID
    `, [], 12000, dbo).catch(() => []),
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
  `, [], 12000, dbo).catch(() => []);
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
    .filter(r => (+r.VENCIDO || 0) > 0.005)
    .sort((a, b) => (+b.VENCIDO || 0) - (+a.VENCIDO || 0))
    .slice(0, limit);
  return result;
});

get('/api/cxc/historial', async (req) => {
  const dbo = getReqDbOpts(req);
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO, cd.SALDO
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ?
    ORDER BY cd.FECHA_VENCIMIENTO
  `, [cliente], 12000, dbo).catch(() => []);
});

// Por condición: mismo saldo documento que aging (cargo en DOCTO_CC_ID − cobros en DOCTO_CC_ACR_ID); una fila por DOCTO_CC_ID.
// Evita inflar totales sumando IMPORTES fila a fila sin aplicar ACR_ID. Contado → pendiente_contado.
get('/api/cxc/por-condicion', async (req) => {
  const dbo = getReqDbOpts(req);
  const innerSQL = `
    SELECT
      x.DOCTO_CC_ID,
      x.CLIENTE_ID,
      TRIM(COALESCE(cp.NOMBRE, 'Sin condición')) AS CONDICION_PAGO,
      COALESCE(cp.DIAS_PPAG, 0) AS DIAS_CREDITO,
      CASE WHEN ${CXC_SQL_ES_CONTADO} THEN 1 ELSE 0 END AS ES_CONTADO,
      x.DIAS_VENCIDO,
      x.SALDO_NETO
    FROM (
      SELECT doc.DOCTO_CC_ID, doc.CLIENTE_ID,
        MAX(doc.SALDO_NETO) AS SALDO_NETO,
        MAX(doc.DIAS_VENCIDO) AS DIAS_VENCIDO
      FROM ${cxcDocSaldosInnerSQL('')} doc
      WHERE doc.SALDO_NETO > 0.005
      GROUP BY doc.DOCTO_CC_ID, doc.CLIENTE_ID
    ) x
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = x.DOCTO_CC_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = dc.COND_PAGO_ID
  `;
  const docs = await query(innerSQL, [], 15000, dbo).catch(() => []);
  const byCond = {};
  let pendContado = {
    CONDICION_PAGO: 'Pendiente de cobro (documentos contado / sin crédito)',
    DIAS_CREDITO: 0,
    NUM_CLIENTES: new Set(),
    NUM_DOCUMENTOS: 0,
    SALDO_TOTAL: 0,
    VENCIDO: 0,
    CORRIENTE: 0,
    ES_CONTADO: true,
  };
  for (const r of docs || []) {
    const saldo = Math.round((+r.SALDO_NETO || 0) * 100) / 100;
    if (saldo <= 0) continue;
    const esContado = +r.ES_CONTADO === 1;
    const dv = +r.DIAS_VENCIDO || 0;
    let venc = 0;
    let cor = 0;
    if (esContado) {
      venc = 0;
      cor = saldo;
    } else {
      venc = dv > 0 ? saldo : 0;
      cor = dv > 0 ? 0 : saldo;
    }
    if (esContado) {
      pendContado.NUM_CLIENTES.add(r.CLIENTE_ID);
      pendContado.NUM_DOCUMENTOS += 1;
      pendContado.SALDO_TOTAL += saldo;
      pendContado.CORRIENTE += cor;
      continue;
    }
    const key = `${r.CONDICION_PAGO}|${+r.DIAS_CREDITO || 0}`;
    if (!byCond[key]) {
      byCond[key] = {
        CONDICION_PAGO: r.CONDICION_PAGO,
        DIAS_CREDITO: +r.DIAS_CREDITO || 0,
        NUM_CLIENTES: new Set(),
        NUM_DOCUMENTOS: 0,
        SALDO_TOTAL: 0,
        VENCIDO: 0,
        CORRIENTE: 0,
        ES_CONTADO: false,
      };
    }
    const b = byCond[key];
    b.NUM_CLIENTES.add(r.CLIENTE_ID);
    b.NUM_DOCUMENTOS += 1;
    b.SALDO_TOTAL += saldo;
    b.VENCIDO += venc;
    b.CORRIENTE += cor;
  }
  const grupos = Object.values(byCond)
    .map(r => ({
      CONDICION_PAGO: r.CONDICION_PAGO,
      DIAS_CREDITO: r.DIAS_CREDITO,
      NUM_CLIENTES: r.NUM_CLIENTES.size,
      NUM_DOCUMENTOS: r.NUM_DOCUMENTOS,
      SALDO_TOTAL: Math.round(r.SALDO_TOTAL * 100) / 100,
      VENCIDO: Math.round(r.VENCIDO * 100) / 100,
      CORRIENTE: Math.round(r.CORRIENTE * 100) / 100,
      ES_CONTADO: false,
    }))
    .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);
  const pendiente_contado =
    pendContado.NUM_DOCUMENTOS > 0
      ? {
          CONDICION_PAGO: pendContado.CONDICION_PAGO,
          DIAS_CREDITO: 0,
          NUM_CLIENTES: pendContado.NUM_CLIENTES.size,
          NUM_DOCUMENTOS: pendContado.NUM_DOCUMENTOS,
          SALDO_TOTAL: Math.round(pendContado.SALDO_TOTAL * 100) / 100,
          VENCIDO: 0,
          CORRIENTE: Math.round(pendContado.CORRIENTE * 100) / 100,
          ES_CONTADO: true,
        }
      : null;
  return { grupos, pendiente_contado };
});

// Calendario Pagos / Buro: por documento, con CLIENTE, ANIO, MES_EMISION, saldo restante, fechas. Sin ?cliente= devuelve todos.
// Si ?saldos_actuales=1 devuelve { rows, saldosPorCliente } para que el front muestre deuda actual sin depender del filtro meses.
get('/api/cxc/historial-pagos', async (req) => {
  const dbo = getReqDbOpts(req);
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
      CAST(COALESCE(MIN(vc.FECHA_VENCIMIENTO), CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}) AS DATE) AS FECHA_VENCIMIENTO,
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
  `, [], 12000, dbo).catch(() => []);
  if (!saldosActuales || !rows || !rows.length) return rows || [];
  const ids = [...new Set((rows || []).map(r => r.CLIENTE_ID).filter(Boolean))];
  if (!ids.length) return { rows, saldosPorCliente: {} };
  let saldosPorCliente = {};
  try {
    const saldosRows = await query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs WHERE cs.CLIENTE_ID IN (${ids.join(',')})`, [], 12000, dbo).catch(() => []);
    (saldosRows || []).forEach(r => { saldosPorCliente[r.CLIENTE_ID] = +r.SALDO || 0; });
  } catch (_) { /* si falla saldos, igual devolver rows */ }
  return { rows, saldosPorCliente };
});

get('/api/cxc/comportamiento-pago', async (req) => {
  const dbo = getReqDbOpts(req);
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, AVG(cd.DIAS_VENCIDO) AS PROMEDIO_DIAS_VENCIDO, COUNT(*) AS DOCS_VENCIDOS
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ? AND cd.DIAS_VENCIDO > 0
    GROUP BY cd.CLIENTE_ID
  `, [cliente], 12000, dbo).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  INVENTARIO — Microsip: SALDOS_IN, NIVELES_ARTICULOS, PRECIOS_ARTICULOS
// ═══════════════════════════════════════════════════════════
const SQL_EXIST_SUB = `( SELECT ARTICULO_ID, SUM(ENTRADAS_UNIDADES - SALIDAS_UNIDADES) AS EXISTENCIA FROM SALDOS_IN GROUP BY ARTICULO_ID )`;
const SQL_MINIMO_SUB = `( SELECT ARTICULO_ID, MAX(INVENTARIO_MINIMO) AS INVENTARIO_MINIMO FROM NIVELES_ARTICULOS WHERE INVENTARIO_MINIMO > 0 GROUP BY ARTICULO_ID )`;
const SQL_PRECIO_SUB = `( SELECT ARTICULO_ID, MIN(PRECIO) AS PRECIO1 FROM PRECIOS_ARTICULOS WHERE MONEDA_ID = 1 AND PRECIO > 0 GROUP BY ARTICULO_ID )`;

// SIN_STOCK = solo articulos con minimo definido y existencia 0 (alerta real). No contar todo el catalogo en cero.
get('/api/inv/resumen', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => [{}]);
  const r = rows[0] || {};
  return { TOTAL_ARTICULOS: +(r.TOTAL_ARTICULOS||0), VALOR_INVENTARIO: +(r.VALOR_INVENTARIO||0), BAJO_MINIMO: +(r.BAJO_MINIMO||0), SIN_STOCK: +(r.SIN_STOCK||0) };
});

get('/api/inv/bajo-minimo', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => []);
});

get('/api/inv/existencias', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [like, like], 12000, dbo).catch(() => []);
});

get('/api/inv/top-stock', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  return query(`
    SELECT FIRST ${limit} a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA, COALESCE(s.EXISTENCIA, 0) * COALESCE(pr.PRECIO1, 0) AS VALOR_TOTAL, COALESCE(pr.PRECIO1, 0) AS PRECIO_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_PRECIO_SUB} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(s.EXISTENCIA, 0) > 0
    ORDER BY VALOR_TOTAL DESC
  `, [], 12000, dbo).catch(() => []);
});

// Consumo semanal desde ventas (DOCTOS_VE_DET) — inventario.html espera DESCRIPCION, EXISTENCIA, CONSUMO_SEMANAL_PROM, SEMANAS_STOCK
get('/api/inv/consumo-semanal', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => []);
});

// Forecast consumo — inventario.html espera DESCRIPCION, UNIDAD, EXISTENCIA_ACTUAL, CONSUMO_DIARIO, DIAS_STOCK, STOCK_MINIMO_RECOMENDADO, ALERTA, CANTIDAD_REPONER
get('/api/inv/consumo', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => []);
  return rows.map(r => ({
    ...r,
    ALERTA: +r.DIAS_STOCK < lead ? 'CRITICO' : +r.DIAS_STOCK < lead * 2 ? 'BAJO' : +r.EXISTENCIA_ACTUAL <= +r.MIN_ACTUAL ? 'BAJO_MINIMO' : 'OK',
    NECESITA_REPONER: +r.EXISTENCIA_ACTUAL < +r.STOCK_MINIMO_RECOMENDADO,
    CANTIDAD_REPONER: Math.max(0, +r.STOCK_MINIMO_RECOMENDADO - +r.EXISTENCIA_ACTUAL),
  }));
});

get('/api/inv/sin-movimiento', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, [], 12000, dbo).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CLIENTES (riesgo, inactivos, resumen-riesgo)
// ═══════════════════════════════════════════════════════════

get('/api/clientes/riesgo', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  return query(`
    SELECT FIRST ${limit}
      agg.CLIENTE_ID,
      agg.NOMBRE,
      agg.CONDICION_PAGO,
      st.SALDO AS SALDO_TOTAL,
      agg.MONTO_VENCIDO,
      agg.MAX_DIAS_VENCIDO,
      agg.NUM_DOCS_VENCIDOS,
      COALESCE(buy.NUM_COMPRAS_VIDA, 0) AS NUM_COMPRAS_VIDA,
      buy.ULTIMA_COMPRA,
      (SELECT FIRST 1 COALESCE(z.IMP, 0)
       FROM (
         SELECT CAST(v.FECHA AS DATE) AS FD, COALESCE(v.IMPORTE_NETO, 0) AS IMP
         FROM DOCTOS_VE v
         WHERE v.CLIENTE_ID = agg.CLIENTE_ID AND v.CLIENTE_ID > 0
           AND (
             (v.TIPO_DOCTO = 'F' AND v.ESTATUS <> 'C')
             OR (v.TIPO_DOCTO = 'V' AND v.ESTATUS NOT IN ('C','T'))
             OR (v.TIPO_DOCTO = 'R' AND v.ESTATUS <> 'C')
           )
         UNION ALL
         SELECT CAST(p.FECHA AS DATE), COALESCE(p.IMPORTE_NETO, 0)
         FROM DOCTOS_PV p
         WHERE p.CLIENTE_ID = agg.CLIENTE_ID AND p.CLIENTE_ID > 0
           AND (
             (p.TIPO_DOCTO = 'F' AND p.ESTATUS <> 'C')
             OR (p.TIPO_DOCTO = 'V' AND p.ESTATUS NOT IN ('C','T'))
             OR (p.TIPO_DOCTO = 'R' AND p.ESTATUS <> 'C')
           )
       ) z
       ORDER BY z.FD DESC
      ) AS ULTIMA_COMPRA_IMPORTE,
      CAST(COALESCE(buy.TICKET_PROMEDIO_MES, 0) * 12 AS DECIMAL(18, 2)) AS PERDIDA_VENTA_ANUAL_EST
    FROM (
      SELECT
        cd.CLIENTE_ID,
        c.NOMBRE,
        COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
        SUM(cd.SALDO) AS MONTO_VENCIDO,
        MAX(cd.DIAS_VENCIDO) AS MAX_DIAS_VENCIDO,
        COUNT(*) AS NUM_DOCS_VENCIDOS
      FROM ${cxcCargosSQL()} cd
      LEFT JOIN CLIENTES c ON c.CLIENTE_ID = cd.CLIENTE_ID
      LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
      WHERE cd.DIAS_VENCIDO > 0
      GROUP BY cd.CLIENTE_ID, c.NOMBRE, cp.NOMBRE
    ) agg
    JOIN ${cxcClienteSQL()} st ON st.CLIENTE_ID = agg.CLIENTE_ID
    LEFT JOIN (
      SELECT
        t.CLIENTE_ID,
        COUNT(*) AS NUM_COMPRAS_VIDA,
        MAX(t.FECHA_D) AS ULTIMA_COMPRA,
        COALESCE(SUM(CASE WHEN t.FECHA_D >= (CURRENT_DATE - 365) THEN t.IMP_NETO ELSE 0 END), 0) / 12.0 AS TICKET_PROMEDIO_MES
      FROM (
        SELECT CLIENTE_ID, CAST(FECHA AS DATE) AS FECHA_D, COALESCE(IMPORTE_NETO, 0) AS IMP_NETO
        FROM DOCTOS_VE
        WHERE CLIENTE_ID > 0
          AND (
            (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
            OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
            OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
          )
        UNION ALL
        SELECT CLIENTE_ID, CAST(FECHA AS DATE), COALESCE(IMPORTE_NETO, 0)
        FROM DOCTOS_PV
        WHERE CLIENTE_ID > 0
          AND (
            (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
            OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
            OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
          )
      ) t
      GROUP BY t.CLIENTE_ID
    ) buy ON buy.CLIENTE_ID = agg.CLIENTE_ID
    ORDER BY agg.MONTO_VENCIDO DESC, COALESCE(buy.TICKET_PROMEDIO_MES, 0) DESC
  `, [], 12000, dbo).catch(() => []);
});

/** Sin compra >180 días (≈6 meses). Ticket mensual = promedio simple últimos 12 meses de historial. */
get('/api/clientes/inactivos', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  return query(`
    SELECT FIRST ${limit}
      c.CLIENTE_ID,
      c.NOMBRE,
      ult.ULTIMA AS ULTIMA_COMPRA,
      (CURRENT_DATE - ult.ULTIMA) AS DIAS_SIN_COMPRA,
      COALESCE(h.TOT, 0) AS TOTAL_COMPRADO_HISTORIAL,
      CAST(COALESCE(h.TOT, 0) / 12.0 AS DECIMAL(18, 2)) AS TICKET_PROMEDIO_MES,
      'INACTIVO' AS NIVEL,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      'Sin compra >6 meses: reactivar o depurar cartera' AS REACTIVACION
    FROM CLIENTES c
    JOIN (
      SELECT CLIENTE_ID, MAX(CAST(FECHA AS DATE)) AS ULTIMA
      FROM DOCTOS_VE
      WHERE CLIENTE_ID > 0
        AND (
          (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
          OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
          OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
        )
      GROUP BY CLIENTE_ID
    ) ult ON ult.CLIENTE_ID = c.CLIENTE_ID
    LEFT JOIN (
      SELECT CLIENTE_ID, COALESCE(SUM(IMPORTE_NETO), 0) AS TOT
      FROM DOCTOS_VE
      WHERE CLIENTE_ID > 0
        AND (
          (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
          OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
          OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
        )
        AND CAST(FECHA AS DATE) >= (CURRENT_DATE - 365)
      GROUP BY CLIENTE_ID
    ) h ON h.CLIENTE_ID = c.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
    WHERE (CURRENT_DATE - ult.ULTIMA) > 180
    ORDER BY 4 DESC
  `, [], 15000, dbo).catch(() => []);
});

/** Comercial: sin compra en los últimos 60 días pero sí en los últimos 6 meses (61–180 días). */
get('/api/clientes/comercial-atraso', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  return query(`
    SELECT FIRST ${limit}
      c.CLIENTE_ID,
      c.NOMBRE,
      ult.ULTIMA AS ULTIMA_COMPRA,
      (CURRENT_DATE - ult.ULTIMA) AS DIAS_SIN_COMPRA,
      COALESCE(h.TOT, 0) AS TOTAL_COMPRADO_HISTORIAL,
      CAST(COALESCE(h.TOT, 0) / 6.0 AS DECIMAL(18, 2)) AS TICKET_PROMEDIO_MES,
      'ATRASO_COMERCIAL' AS NIVEL,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      'Seguimiento: llevaba comprando; cortar racha >60d' AS REACTIVACION
    FROM CLIENTES c
    JOIN (
      SELECT CLIENTE_ID, MAX(CAST(FECHA AS DATE)) AS ULTIMA
      FROM DOCTOS_VE
      WHERE CLIENTE_ID > 0
        AND (
          (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
          OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
          OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
        )
      GROUP BY CLIENTE_ID
    ) ult ON ult.CLIENTE_ID = c.CLIENTE_ID
    LEFT JOIN (
      SELECT CLIENTE_ID, COALESCE(SUM(IMPORTE_NETO), 0) AS TOT
      FROM DOCTOS_VE
      WHERE CLIENTE_ID > 0
        AND (
          (TIPO_DOCTO = 'F' AND ESTATUS <> 'C')
          OR (TIPO_DOCTO = 'V' AND ESTATUS NOT IN ('C', 'T'))
          OR (TIPO_DOCTO = 'R' AND ESTATUS <> 'C')
        )
        AND CAST(FECHA AS DATE) >= (CURRENT_DATE - 180)
      GROUP BY CLIENTE_ID
    ) h ON h.CLIENTE_ID = c.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
    WHERE (CURRENT_DATE - ult.ULTIMA) > 60
      AND (CURRENT_DATE - ult.ULTIMA) <= 180
    ORDER BY 4 DESC
  `, [], 15000, dbo).catch(() => []);
});

get('/api/clientes/resumen-riesgo', async (req) => {
  const dbo = getReqDbOpts(req);
  const defaultRes = { TOTAL_EN_RIESGO: 0, MONTO_CRITICO: 0, MONTO_ALTO: 0, MONTO_MEDIO: 0, MONTO_LEVE: 0 };
  try {
    const [totales] = await query(`
      SELECT COUNT(DISTINCT cd.CLIENTE_ID) AS TOTAL_EN_RIESGO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS MONTO_CRITICO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 60 AND cd.DIAS_VENCIDO <= 90 THEN cd.SALDO ELSE 0 END) AS MONTO_ALTO,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 30 AND cd.DIAS_VENCIDO <= 60 THEN cd.SALDO ELSE 0 END) AS MONTO_MEDIO,
        SUM(CASE WHEN cd.DIAS_VENCIDO <= 30 THEN cd.SALDO ELSE 0 END) AS MONTO_LEVE
      FROM ${cxcCargosSQL()} cd WHERE cd.DIAS_VENCIDO > 0
    `, [], 12000, dbo).catch(() => [null]);
    return { ...defaultRes, ...(totales || {}) };
  } catch (e) {
    return defaultRes;
  }
});

// ═══════════════════════════════════════════════════════════
//  RESULTADOS (P&L) — resultados.html espera meses[], totales{}, tiene_costo
//  dbOpts null = FB_DATABASE por defecto; si no, conexión a otra .fdb del registro.
// ═══════════════════════════════════════════════════════════

async function resultadosPnlCore(req, dbOpts) {
  const q = (sql, params, timeoutMs = 12000) => query(sql, params, timeoutMs, dbOpts);
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr, hastaStr;
  const { desde, hasta, anio, mes } = req.query;
  const mesesParam = parseInt(req.query.meses, 10);
  const useMesesRolling = !isNaN(mesesParam) && mesesParam > 0;
  if (desde && reDate.test(desde) && hasta && reDate.test(hasta)) {
    desdeStr = desde;
    hastaStr = hasta;
  } else if (useMesesRolling) {
    const mesesN = Math.min(Math.max(mesesParam, 1), 24);
    const d = new Date();
    d.setMonth(d.getMonth() - mesesN);
    desdeStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    hastaStr = new Date().toISOString().slice(0, 10);
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
    costosVEMes = await q(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(det.UNIDADES * COALESCE(a."COSTO_PROMEDIO", 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_VE d
      JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
      JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
      WHERE (
          (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
          OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C', 'T'))
          OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
        )
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams);
  } catch (_) {
    try {
      costosVEMes = await q(`
        SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(COALESCE(NULLIF(det.COSTO_TOTAL, 0), det.CANTIDAD * COALESCE(det.COSTO_UNITARIO, 0))), 0) AS COSTO_VENTAS
        FROM DOCTOS_VE d
        JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
        WHERE (
          (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
          OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C', 'T'))
          OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
        )
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
      const costosCO = await q(`
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
        const costosCO = await q(`
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
        const costosCO = await q(`
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

  const sy = parseInt(String(desdeStr).slice(0, 4), 10);
  const sm = parseInt(String(desdeStr).slice(5, 7), 10);
  const ey = parseInt(String(hastaStr).slice(0, 4), 10);
  const em = parseInt(String(hastaStr).slice(5, 7), 10);

  const [ventasMes, costosINMes, costosINDirect, cobrosMes, costosSaldos5101, gastosSaldos52] = await Promise.all([
    q(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS VENTAS_NETAS,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COUNT(*) AS NUM_FACTURAS
      FROM ${ventasSub()} d
      WHERE ${dateCond}
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(det.CANTIDAD * COALESCE(det.COSTO_UNITARIO, det.PRECIO_UNITARIO, 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_IN d
      JOIN DOCTOS_IN_DET det ON det.DOCTO_IN_ID = d.DOCTO_IN_ID
      WHERE d.TIPO_MOV = 'S' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(COALESCE(d.IMPORTE, d.PRECIO_UNITARIO * d.UNIDADES, 0)), 0) AS COSTO_VENTAS
      FROM DOCTOS_IN d
      WHERE d.TIPO_DOCTO STARTING WITH 'S' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE) AND COALESCE(d.UNIDADES, 0) > 0
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM dc.FECHA) AS ANIO, EXTRACT(MONTH FROM dc.FECHA) AS MES,
        SUM(CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END) AS COBROS
      FROM IMPORTES_DOCTOS_CC i
      JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
      WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N'
        AND ${dateCondCc}
      GROUP BY EXTRACT(YEAR FROM dc.FECHA), EXTRACT(MONTH FROM dc.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    q(`
      SELECT s.ANO AS ANIO, s.MES AS MES,
        COALESCE(SUM(COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0)), 0) AS COSTO_VENTAS
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.TIPO = 'R' OR cu.TIPO IS NULL)
        AND cu.CUENTA_PT STARTING WITH '5101'
        AND s.ANO >= ? AND s.ANO <= ?
        AND NOT (s.ANO = ? AND s.MES < ?)
        AND NOT (s.ANO = ? AND s.MES > ?)
      GROUP BY s.ANO, s.MES
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
    q(`
      SELECT s.ANO AS ANIO, s.MES AS MES,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5201' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5202' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5203' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5204' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A4,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5205' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A5,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '52'
           AND NOT (cu.CUENTA_PT STARTING WITH '5201' OR cu.CUENTA_PT STARTING WITH '5202' OR cu.CUENTA_PT STARTING WITH '5203'
             OR cu.CUENTA_PT STARTING WITH '5204' OR cu.CUENTA_PT STARTING WITH '5205')
          THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_A6,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5301' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_B1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5302' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_B2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5303' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_B3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5304' THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_B4,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '53'
           AND NOT (cu.CUENTA_PT STARTING WITH '5301' OR cu.CUENTA_PT STARTING WITH '5302'
             OR cu.CUENTA_PT STARTING WITH '5303' OR cu.CUENTA_PT STARTING WITH '5304')
          THEN COALESCE(s.CARGOS, 0) - COALESCE(s.ABONOS, 0) ELSE 0 END) AS CO_B5
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.TIPO = 'R' OR cu.TIPO IS NULL)
        AND (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53')
        AND s.ANO >= ? AND s.ANO <= ?
        AND NOT (s.ANO = ? AND s.MES < ?)
        AND NOT (s.ANO = ? AND s.MES > ?)
      GROUP BY s.ANO, s.MES
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
  ]);

  const key = (a, m) => `${a}-${m}`;
  const costMap = {};
  (costosVEMes || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  (costosINMes || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  (costosINDirect || []).forEach(r => { costMap[key(r.ANIO, r.MES)] = (costMap[key(r.ANIO, r.MES)] || 0) + (+r.COSTO_VENTAS || 0); });
  (costosSaldos5101 || []).forEach(r => {
    const k = key(r.ANIO, r.MES);
    const v = +r.COSTO_VENTAS || 0;
    if (v <= 0) return;
    if (!costMap[k] || costMap[k] === 0) costMap[k] = v;
  });
  const cobMap = {}; (cobrosMes || []).forEach(r => { cobMap[key(r.ANIO, r.MES)] = +r.COBROS || 0; });
  const gasMap = {};
  (gastosSaldos52 || []).forEach(r => { gasMap[key(r.ANIO, r.MES)] = r; });
  const gasAbs = (g, k) => Math.abs(+g[k] || 0);

  const meses = (ventasMes || []).map(r => {
    const ventas = +r.VENTAS_NETAS || 0;
    const costo = costMap[key(r.ANIO, r.MES)] || 0;
    const cobros = cobMap[key(r.ANIO, r.MES)] || 0;
    const util = ventas - costo;
    const margenPct = ventas > 0 ? Math.round((util / ventas) * 1000) / 10 : 0;
    const g = gasMap[key(r.ANIO, r.MES)] || {};
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
      CO_A1: gasAbs(g, 'CO_A1'),
      CO_A2: gasAbs(g, 'CO_A2'),
      CO_A3: gasAbs(g, 'CO_A3'),
      CO_A4: gasAbs(g, 'CO_A4'),
      CO_A5: gasAbs(g, 'CO_A5'),
      CO_A6: gasAbs(g, 'CO_A6'),
      CO_B1: gasAbs(g, 'CO_B1'),
      CO_B2: gasAbs(g, 'CO_B2'),
      CO_B3: gasAbs(g, 'CO_B3'),
      CO_B4: gasAbs(g, 'CO_B4'),
      CO_B5: gasAbs(g, 'CO_B5'),
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
    acc.CO_A1 += m.CO_A1 || 0;
    acc.CO_A2 += m.CO_A2 || 0;
    acc.CO_A3 += m.CO_A3 || 0;
    acc.CO_A4 += m.CO_A4 || 0;
    acc.CO_A5 += m.CO_A5 || 0;
    acc.CO_A6 += m.CO_A6 || 0;
    acc.CO_B1 += m.CO_B1 || 0;
    acc.CO_B2 += m.CO_B2 || 0;
    acc.CO_B3 += m.CO_B3 || 0;
    acc.CO_B4 += m.CO_B4 || 0;
    acc.CO_B5 += m.CO_B5 || 0;
    return acc;
  }, {
    VENTAS_NETAS: 0, VENTAS_VE: 0, VENTAS_PV: 0, COSTO_VENTAS: 0, UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0,
    CO_A1: 0, CO_A2: 0, CO_A3: 0, CO_A4: 0, CO_A5: 0, CO_A6: 0, CO_B1: 0, CO_B2: 0, CO_B3: 0, CO_B4: 0, CO_B5: 0,
  });
  totales.MARGEN_BRUTO_PCT = totales.VENTAS_NETAS > 0
    ? Math.round((totales.UTILIDAD_BRUTA / totales.VENTAS_NETAS) * 1000) / 10 : 0;

  const tiene_costo = totales.COSTO_VENTAS > 0;
  const sumGastoCo = ['CO_A1', 'CO_A2', 'CO_A3', 'CO_A4', 'CO_A5', 'CO_A6', 'CO_B1', 'CO_B2', 'CO_B3', 'CO_B4', 'CO_B5']
    .reduce((s, k) => s + (+totales[k] || 0), 0);
  const tiene_gastos_co = sumGastoCo > 0.01;

  return { meses, totales, tiene_costo, tiene_gastos_co };
}

get('/api/resultados/pnl', async (req) => {
  let dbId = req.query.db ? String(req.query.db).trim() : '';
  if (dbId.toLowerCase() === 'default') dbId = '';
  if (dbId) {
    const idLc = dbId.toLowerCase();
    const hit = DATABASE_REGISTRY.find(d => String(d.id).toLowerCase() === idLc);
    if (!hit) {
      console.warn('[resultados/pnl] db desconocido, usando default:', dbId);
      return resultadosPnlCore(req, null);
    }
    return resultadosPnlCore(req, hit.options);
  }
  return resultadosPnlCore(req, null);
});

// Resumen P&L por cada empresa del registro (sin devolver series completas; ahorra ancho de banda).
get('/api/resultados/pnl-universe', async (req) => {
  const conc = Math.min(Math.max(parseInt(req.query.concurrency, 10) || 2, 1), 4);
  const rows = await mapPoolLimit(DATABASE_REGISTRY, conc, async (entry) => {
    try {
      const { meses, totales, tiene_costo, tiene_gastos_co } = await resultadosPnlCore(req, entry.options);
      const t = totales || {};
      return {
        ok: true,
        id: entry.id,
        label: entry.label,
        totales: {
          VENTAS_NETAS: +t.VENTAS_NETAS || 0,
          COSTO_VENTAS: +t.COSTO_VENTAS || 0,
          UTILIDAD_BRUTA: +t.UTILIDAD_BRUTA || 0,
          MARGEN_BRUTO_PCT: +t.MARGEN_BRUTO_PCT || 0,
          COBROS: +t.COBROS || 0,
          NUM_FACTURAS: +t.NUM_FACTURAS || 0,
          VENTAS_VE: +t.VENTAS_VE || 0,
          VENTAS_PV: +t.VENTAS_PV || 0,
        },
        tiene_costo: !!tiene_costo,
        tiene_gastos_co: !!tiene_gastos_co,
        meses_count: (meses || []).length,
      };
    } catch (e) {
      return { ok: false, id: entry.id, label: entry.label, error: e.message };
    }
  });
  const ok = rows.filter(r => r.ok);
  const cons = ok.reduce((a, r) => {
    const t = r.totales || {};
    a.VENTAS_NETAS += +t.VENTAS_NETAS || 0;
    a.COSTO_VENTAS += +t.COSTO_VENTAS || 0;
    a.UTILIDAD_BRUTA += +t.UTILIDAD_BRUTA || 0;
    a.COBROS += +t.COBROS || 0;
    a.NUM_FACTURAS += +t.NUM_FACTURAS || 0;
    a.VENTAS_VE += +t.VENTAS_VE || 0;
    a.VENTAS_PV += +t.VENTAS_PV || 0;
    return a;
  }, { VENTAS_NETAS: 0, COSTO_VENTAS: 0, UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0, VENTAS_VE: 0, VENTAS_PV: 0 });
  cons.MARGEN_BRUTO_PCT = cons.VENTAS_NETAS > 0
    ? Math.round((cons.UTILIDAD_BRUTA / cons.VENTAS_NETAS) * 1000) / 10 : 0;
  cons.tiene_costo = cons.COSTO_VENTAS > 0;
  return { generatedAt: new Date().toISOString(), concurrency: conc, empresas: rows, consolidado: cons };
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
  const dbo = getReqDbOpts(req);
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
    `, f.params, 12000, dbo).catch(() => []),
    query(`
      SELECT FIRST 1
        CAST(d.FECHA AS DATE) AS DIA_MAXIMO,
        COALESCE(SUM(d.UNIDADES), 0) AS MAXIMO_DIARIO
      FROM ${consumosSub(tipo)} d
      WHERE d.UNIDADES > 0 ${f.sql}
      GROUP BY CAST(d.FECHA AS DATE)
      ORDER BY MAXIMO_DIARIO DESC, DIA_MAXIMO DESC
    `, f.params, 12000, dbo).catch(() => [])
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
  const dbo = getReqDbOpts(req);
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
  `, [desdeStr], 12000, dbo).catch(() => []);
  return rows || [];
});

get('/api/consumos/top-articulos', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
});

get('/api/consumos/por-vendedor', async (req) => {
  const dbo = getReqDbOpts(req);
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
  `, f.params, 12000, dbo).catch(() => []);
  const total = (rows || []).reduce((s, r) => s + (+r.UNIDADES || 0), 0);
  return (rows || []).map(r => ({
    ...r,
    PARTICIPACION: total > 0 ? Math.round((+r.UNIDADES || 0) / total * 10000) / 100 : 0
  }));
});

/**
 * KPIs extra consumos: variación semanal (7 vs 7), concentración Top 5, vs periodo anterior,
 * cobertura inventario sobre top artículos.
 */
get('/api/consumos/insights', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const sub = consumosSub(tipo);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const diasCal = consumosPeriodCalendarDays(req.query);
  const vc = consumosVendedorClienteSql(req, 'd');

  const today = new Date();
  const isoD = d =>
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0');
  const ultStart = new Date(today);
  ultStart.setDate(ultStart.getDate() - 6);
  const prevEnd = new Date(today);
  prevEnd.setDate(prevEnd.getDate() - 7);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 6);

  const wowParams = [
    isoD(ultStart),
    isoD(today),
    isoD(prevStart),
    isoD(prevEnd),
    isoD(prevStart),
    isoD(today),
    ...vc.params,
  ];

  const prevQ = consumosPrevPeriodQuery(req.query);
  const fakePrev = prevQ ? { query: prevQ } : null;
  const fp = fakePrev ? buildFiltros(fakePrev, 'd') : null;

  const [
    wowRows,
    top5Rows,
    currTotRows,
    prevTotRows,
    covRows,
  ] = await Promise.all([
    query(
      `
      SELECT
        COALESCE(SUM(CASE
          WHEN CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
          THEN d.UNIDADES ELSE 0 END), 0) AS ULT_7,
        COALESCE(SUM(CASE
          WHEN CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
          THEN d.UNIDADES ELSE 0 END), 0) AS PREV_7
      FROM ${sub} d
      WHERE d.UNIDADES > 0
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
        AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
        ${vc.sql}
    `,
      wowParams,
      15000,
      dbo
    ).catch(() => []),
    query(
      `
      SELECT COALESCE(SUM(UNIDADES), 0) AS TOP5_UNIDADES
      FROM (
        SELECT FIRST 5 SUM(d.UNIDADES) AS UNIDADES
        FROM ${sub} d
        WHERE d.UNIDADES > 0 ${f.sql}
        GROUP BY d.ARTICULO_ID
        ORDER BY 1 DESC
      ) t5
    `,
      f.params,
      15000,
      dbo
    ).catch(() => []),
    query(
      `
      SELECT COALESCE(SUM(d.UNIDADES), 0) AS U
      FROM ${sub} d
      WHERE d.UNIDADES > 0 ${f.sql}
    `,
      f.params,
      15000,
      dbo
    ).catch(() => []),
    fp
      ? query(
          `
      SELECT COALESCE(SUM(d.UNIDADES), 0) AS U
      FROM ${sub} d
      WHERE d.UNIDADES > 0 ${fp.sql}
    `,
          fp.params,
          15000,
          dbo
        ).catch(() => [])
      : Promise.resolve([]),
    query(
      `
      SELECT FIRST 10
        agg.ARTICULO_ID,
        COALESCE(a.NOMBRE, 'Art. ' || CAST(agg.ARTICULO_ID AS VARCHAR(12))) AS ARTICULO,
        agg.UNIDADES AS CONSUMO_PERIODO,
        COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA,
        COALESCE(mn.INVENTARIO_MINIMO, 0) AS INVENTARIO_MINIMO
      FROM (
        SELECT d.ARTICULO_ID, COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES
        FROM ${sub} d
        WHERE d.UNIDADES > 0 ${f.sql}
        GROUP BY d.ARTICULO_ID
        ORDER BY 2 DESC
      ) agg
      LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = agg.ARTICULO_ID
      LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = agg.ARTICULO_ID
      LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = agg.ARTICULO_ID
      ORDER BY agg.UNIDADES DESC
    `,
      f.params,
      18000,
      dbo
    ).catch(() => []),
  ]);

  const ult7 = +(wowRows[0] && wowRows[0].ULT_7) || 0;
  const prev7 = +(wowRows[0] && wowRows[0].PREV_7) || 0;
  let wowPct = null;
  if (prev7 > 0) wowPct = Math.round(((ult7 - prev7) / prev7) * 10000) / 100;
  else if (ult7 > 0) wowPct = 100;
  else wowPct = 0;

  let semaforoSemanal = 'amarillo';
  if (wowPct > 5) semaforoSemanal = 'verde';
  else if (wowPct < -5) semaforoSemanal = 'rojo';

  const top5Unidades = +(top5Rows[0] && top5Rows[0].TOP5_UNIDADES) || 0;
  const unidadesPeriodo = +(currTotRows[0] && currTotRows[0].U) || 0;
  const unidadesPrev = +(prevTotRows[0] && prevTotRows[0].U) || 0;
  const pctTop5 =
    unidadesPeriodo > 0 ? Math.round((top5Unidades / unidadesPeriodo) * 10000) / 100 : 0;
  let varVsPrevPct = null;
  if (unidadesPrev > 0) {
    varVsPrevPct = Math.round(((unidadesPeriodo - unidadesPrev) / unidadesPrev) * 10000) / 100;
  } else if (unidadesPeriodo > 0) {
    varVsPrevPct = 100;
  } else {
    varVsPrevPct = 0;
  }

  const cobertura = (covRows || []).map(r => {
    const cons = +r.CONSUMO_PERIODO || 0;
    const ex = +r.EXISTENCIA || 0;
    const minimo = +r.INVENTARIO_MINIMO || 0;
    const daily = cons / Math.max(1, diasCal);
    const diasCov = daily > 0 ? Math.round((ex / daily) * 100) / 100 : ex > 0 ? null : 0;
    return {
      ARTICULO_ID: r.ARTICULO_ID,
      ARTICULO: r.ARTICULO,
      CONSUMO_PERIODO: cons,
      EXISTENCIA: ex,
      INVENTARIO_MINIMO: minimo,
      CONSUMO_DIARIO_PROM: Math.round(daily * 100) / 100,
      DIAS_COBERTURA: diasCov,
    };
  });

  const alertas = [];
  for (const row of cobertura) {
    const daily = row.CONSUMO_DIARIO_PROM || 0;
    const ex = row.EXISTENCIA;
    const minimo = row.INVENTARIO_MINIMO;
    const diasCov = row.DIAS_COBERTURA;
    if (row.CONSUMO_PERIODO <= 0) continue;
    const bajoStock = minimo > 0 && ex <= minimo;
    const coberturaBaja = daily > 0 && diasCov != null && diasCov < 14;
    const sinEx = daily > 0 && ex === 0;
    if (sinEx || bajoStock || coberturaBaja) {
      alertas.push({
        tipo: 'quiebre',
        ARTICULO_ID: row.ARTICULO_ID,
        ARTICULO: row.ARTICULO,
        CONSUMO_PERIODO: row.CONSUMO_PERIODO,
        EXISTENCIA: ex,
        INVENTARIO_MINIMO: minimo,
        DIAS_COBERTURA: diasCov,
        mensaje: sinEx
          ? 'Sin existencia con consumo activo en el periodo'
          : bajoStock
            ? 'Existencia en o bajo el mínimo de inventario'
            : 'Cobertura estimada bajo 14 días al ritmo del periodo',
      });
    }
  }

  return {
    variacion_semanal: {
      unidades_ultimos_7: ult7,
      unidades_previos_7: prev7,
      variacion_pct: wowPct,
      semaforo: semaforoSemanal,
      nota: 'Comparativo de calendario: últimos 7 días vs los 7 días anteriores (respeta vendedor/cliente y tipo VE/PV).',
    },
    concentracion_top5: {
      unidades_top5: top5Unidades,
      unidades_periodo: unidadesPeriodo,
      porcentaje: pctTop5,
    },
    vs_periodo_anterior: {
      unidades_periodo: unidadesPeriodo,
      unidades_periodo_previo: unidadesPrev,
      variacion_pct: varVsPrevPct,
      tiene_previo: !!prevQ,
    },
    cobertura_top: cobertura,
    dias_calendario_periodo: diasCal,
  };
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
  if (process.env.READ_ONLY_MODE === '1' || process.env.READ_ONLY_MODE === 'true') {
    return res.status(403).json({ error: 'Modo solo lectura (READ_ONLY_MODE)' });
  }
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

// ═══════════════════════════════════════════════════════════
//  ASISTENTE IA (OpenAI-compatible) — mismo contrato que cotización-web
// ═══════════════════════════════════════════════════════════

function aiResolveDbOpts(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let dbId = (body.db != null && String(body.db).trim() !== '' ? String(body.db).trim() : '') ||
    (req.query && req.query.db ? String(req.query.db).trim() : '');
  if (!dbId || dbId.toLowerCase() === 'default') return { opts: null, id: '', label: '' };
  const idLc = dbId.toLowerCase();
  const hit = DATABASE_REGISTRY.find(d => String(d.id).toLowerCase() === idLc);
  if (!hit) {
    return {
      error: `Parámetro db desconocido: ${dbId}. Ver GET /api/universe/databases`,
    };
  }
  return { opts: hit.options, id: hit.id, label: hit.label };
}

const AI_SYSTEM_BASE_MICROSIP = `Eres el Agente de Soporte de **Suminregio Parker** — paneles que leen **Microsip (Firebird)** en solo lectura.

REGLAS:
- Responde en español, claro y conciso. No repitas saludos genéricos en cada mensaje.
- No inventes cifras: si el contexto trae datos del sistema, úsalos; si no hay datos, dilo en una frase.
- Estos dashboards **no modifican** Microsip; para altas o cambios operativos el usuario debe usar Microsip.
- Puedes explicar: ventas VE/PV, cotizaciones en DOCTOS_VE (TIPO C/O, no canceladas), **Cobradas** (cobros tipo R en CC, alineado con /api/ventas/cobradas), CxC y aging, inventario, resultados/P&L, scorecard multi-empresa cuando aplique.
- Si el contexto trae un bloque **Cobradas** o **Cotizaciones** con cifras, **respóndele al usuario con esos números** (importes, conteos, promedios). No digas que no tienes acceso a los datos del sistema si esas cifras están en el contexto.
- Si el contexto indica **empresa seleccionada**, céntrate en esa base; si hay una sola, no confundas al usuario.`;

const AI_WELCOME_MICROSIP = `¡Hola! 👋 Soy tu **Agente de Soporte** (Suminregio Parker · Microsip).

Puedo ayudarte a **interpretar** ventas, cotizaciones, cuentas por cobrar, inventario y resultados. Todo es **solo lectura** frente a la base.

Ejemplos: "¿Cuántas cotizaciones van hoy?" · "¿Qué es el saldo de CxC?" · "¿Cuál es el ticket promedio cobrado este mes?" · "Explícame el margen bruto en Resultados."`;

get('/api/ai/welcome', async () => ({ message: AI_WELCOME_MICROSIP }));

app.post('/api/ai/chat', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  if (process.env.CURSOR_API_KEY && !apiKey) {
    return res.status(400).json({
      error: 'La API key de Cursor (crsr_...) es para el editor Cursor, no para este chat.',
      hint: 'Añade OPENAI_API_KEY (OpenAI u otro endpoint compatible) en las variables de entorno del servicio.',
    });
  }
  if (!apiKey) {
    return res.status(503).json({
      error: 'API de IA no configurada',
      hint: 'Define OPENAI_API_KEY en el entorno (y opcionalmente OPENAI_API_BASE, OPENAI_MODEL).',
    });
  }
  if (String(apiKey).startsWith('crsr_')) {
    return res.status(400).json({
      error: 'La key configurada es de Cursor (crsr_...). Para este chat se necesita una key de proveedor compatible con OpenAI.',
    });
  }

  try {
    const body = req.body || {};
    const text = String(body.message || '').trim();
    const imageB64 = body.imageBase64 ? String(body.imageBase64).replace(/^data:[^;]+;base64,/, '') : '';
    const imageMime = body.imageMimeType ? String(body.imageMimeType) : '';
    if (!text && !imageB64) {
      return res.status(400).json({ error: 'Falta el mensaje (message) o una imagen (imageBase64)' });
    }

    const dbResolved = aiResolveDbOpts(req);
    if (dbResolved.error) {
      return res.status(400).json({ error: dbResolved.error });
    }
    const dbOpts = dbResolved.opts;
    const empresaCtx = dbResolved.label
      ? `\n\nEmpresa seleccionada en el panel: **${dbResolved.label}** (id: ${dbResolved.id}).`
      : '\n\nEmpresa: base por defecto del servidor (una sola .fdb o la principal).';

    let systemContent = AI_SYSTEM_BASE_MICROSIP + empresaCtx;

    const historyText = `${text} ${(Array.isArray(body.messages) ? body.messages : []).map(m => (m && m.content) || '').join(' ')}`;
    const lowerPool = (text + ' ' + historyText).toLowerCase();

    const wantsCotizaciones = /\b(cotizaciones?|cotización|cotizacion)\b/i.test(lowerPool) ||
      (/\bhoy\b|fecha|\d{1,2}\s+de\s+\w+/i.test(text) && !/\bincidentes?\b/i.test(lowerPool));

    if (wantsCotizaciones) {
      try {
        const [resumen] = await query(`
          SELECT
            COUNT(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 END) AS COT_HOY,
            COALESCE(SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END), 0) AS IMPORTE_HOY,
            COUNT(*) AS COT_MES,
            COALESCE(SUM(d.IMPORTE_NETO), 0) AS IMPORTE_MES
          FROM DOCTOS_VE d
          WHERE ${sqlWhereCotizacionActiva('d')}
            AND EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
        `, [], 12000, dbOpts).catch(() => [{}]);
        const r0 = resumen || {};
        const rows = await query(`
          SELECT FIRST 18
            CAST(d.FECHA AS DATE) AS FECHA, d.FOLIO,
            COALESCE(c.NOMBRE, '') AS CLIENTE,
            COALESCE(d.IMPORTE_NETO, 0) AS IMPORTE_NETO,
            COALESCE(v.NOMBRE, '') AS VENDEDOR
          FROM DOCTOS_VE d
          LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
          LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
          WHERE ${sqlWhereCotizacionActiva('d')}
          ORDER BY d.FECHA DESC, d.FOLIO DESC
        `, [], 12000, dbOpts).catch(() => []);
        const hoyStr = new Date().toISOString().slice(0, 10);
        const paraHoy = (rows || []).filter(row => row.FECHA && String(row.FECHA).slice(0, 10) === hoyStr);
        const listHoy = paraHoy.length
          ? paraHoy.map(c => `Folio ${c.FOLIO}, ${c.CLIENTE || 'Sin cliente'}, $${Number(c.IMPORTE_NETO || 0).toFixed(2)}`).join('; ')
          : 'Ninguna con fecha de hoy en el listado reciente.';
        const listRec = (rows || []).slice(0, 12).map(c =>
          `${c.FOLIO} (${String(c.FECHA).slice(0, 10)}) ${c.CLIENTE || ''} $${Number(c.IMPORTE_NETO || 0).toFixed(2)} — ${c.VENDEDOR || ''}`
        ).join('; ');
        systemContent += `\n\n**Cotizaciones (Microsip DOCTOS_VE, activas):**
- Mes en curso: ${r0.COT_MES || 0} docs, importe neto total ~$${Number(r0.IMPORTE_MES || 0).toFixed(2)}.
- Hoy: ${r0.COT_HOY || 0} docs, importe neto ~$${Number(r0.IMPORTE_HOY || 0).toFixed(2)}.
- Detalle hoy: ${listHoy}
- Últimas (muestra): ${listRec || 'Sin filas.'}`;
      } catch (_) { /* sin contexto si falla Firebird */ }
    }

    const wantsCxc = /\b(cxc|cuentas?\s+por\s+cobrar|saldo\s+clientes?|cobranza)\b/i.test(lowerPool);
    if (wantsCxc) {
      try {
        const [t] = await query(`SELECT COALESCE(SUM(s.SALDO), 0) AS T FROM ${cxcClienteSQL()} s`, [], 12000, dbOpts).catch(() => [{ T: 0 }]);
        const top = await query(`
          SELECT FIRST 8 cs.CLIENTE_ID, COALESCE(cl.NOMBRE, '') AS NOMBRE, cs.SALDO
          FROM ${cxcClienteSQL()} cs
          LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = cs.CLIENTE_ID
          WHERE cs.SALDO > 0.5
          ORDER BY cs.SALDO DESC
        `, [], 12000, dbOpts).catch(() => []);
        systemContent += `\n\n**CxC (resumen del panel):**
- Saldo total cartera (suma por cliente): $${Number((t && t.T) || 0).toFixed(2)}.
- Principales saldos: ${(top || []).map(x => `${x.NOMBRE || x.CLIENTE_ID}: $${Number(x.SALDO || 0).toFixed(2)}`).join('; ') || 'Sin datos.'}`;
      } catch (_) { /* sin contexto CxC */ }
    }

    const wantsVentas = /\b(ventas?|facturaci[oó]n|facturas?)\b/i.test(lowerPool) && !wantsCotizaciones;
    if (wantsVentas) {
      try {
        const tipo = '';
        const [vr] = await query(`
          SELECT
            SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS HOY,
            COALESCE(SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
              AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) THEN d.IMPORTE_NETO ELSE 0 END), 0) AS MES
          FROM ${ventasSub(tipo)} d
        `, [], 12000, dbOpts).catch(() => [{}]);
        systemContent += `\n\n**Ventas (VE+PV, facturas válidas):**
- Hoy: $${Number((vr && vr.HOY) || 0).toFixed(2)}.
- Mes en curso: $${Number((vr && vr.MES) || 0).toFixed(2)}.`;
      } catch (_) {}
    }

    const wantsCobradas =
      /\b(cobrad[ao]s?|cobrado|pagos?\s+recibidos|ticket\s+promedio|abonos?\s+a\s+cc|total\s+cobrado|comisi[oó]n\s+8|facturas?\s+cobradas?)\b/i.test(
        lowerPool
      ) && !/\bincidentes?\b/i.test(lowerPool);
    if (wantsCobradas) {
      try {
        const tipo = '';
        const [cb] = await query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO,
            COUNT(*) AS NUM_MOV_COBRO
          FROM IMPORTES_DOCTOS_CC i
          JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
          WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N'
            AND EXTRACT(YEAR FROM dc.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM dc.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
        `,
          [],
          12000,
          dbOpts
        ).catch(() => [{}]);
        const [fv] = await query(
          `
          SELECT COUNT(DISTINCT d.FOLIO) AS N_FACT, COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_FAC
          FROM ${ventasSub(tipo)} d
          WHERE d.VENDEDOR_ID > 0
            AND EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
            AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
        `,
          [],
          12000,
          dbOpts
        ).catch(() => [{}]);
        const totC = Number((cb && cb.TOTAL_COBRADO) || 0);
        const nMov = Number((cb && cb.NUM_MOV_COBRO) || 0);
        const ticketPorMov = nMov > 0 ? totC / nMov : null;
        const nFac = Number((fv && fv.N_FACT) || 0);
        const totFac = Number((fv && fv.TOTAL_FAC) || 0);
        const ticketSobreFac = nFac > 0 ? totC / nFac : null;
        const y = new Date().getFullYear();
        const m = new Date().getMonth() + 1;
        systemContent += `\n\n**Cobradas (mes en curso ${y}-${String(m).padStart(2, '0')}, misma lógica que el panel Cobradas: cobros IMPORTES_DOCTOS_CC tipo R, importe normalizado ex-IVA; filtro por año/mes de FECHA del movimiento (i.FECHA); vendedor vía CC aplicado COALESCE(DOCTO_CC_ACR_ID, DOCTO_CC_ID) → DOCTOS_VE/PV):**
- Total cobrado en el periodo: $${totC.toFixed(2)}.
- Número de movimientos de cobro (líneas R) en ese periodo: ${nMov}.
- **Ticket promedio por movimiento de cobro** (total cobrado ÷ movimientos): ${ticketPorMov != null ? '$' + ticketPorMov.toFixed(2) : 'No aplica (0 movimientos).'}.
- Referencia facturación mismo mes (VE+PV, con vendedor): ${nFac} facturas (folios distintos), total facturado $${totFac.toFixed(2)}.
- **Cobrado medio por factura del mes** (total cobrado ÷ esas facturas; aproximación si el cobro del mes se repartiera entre ellas): ${ticketSobreFac != null ? '$' + ticketSobreFac.toFixed(2) : 'No aplica.'}.
- Explica en una frase que el desglose por vendedor está en la vista Cobradas del dashboard; aquí son totales de la base activa.`;
      } catch (_) {
        /* sin contexto cobradas */
      }
    }

    const apiMessages = [{ role: 'system', content: systemContent }];
    if (Array.isArray(body.messages) && body.messages.length) {
      body.messages.forEach(m => {
        if (m && m.role && m.content) {
          apiMessages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content).slice(0, 2000),
          });
        }
      });
    }

    const userText = text || (imageB64 ? 'Describe la imagen y responde según el contexto del sistema.' : '');
    if (imageB64 && /^image\/(jpeg|png|gif|webp)$/i.test(imageMime)) {
      const dataUrl = `data:${imageMime};base64,${imageB64}`;
      apiMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: userText.slice(0, 2000) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      });
    } else {
      apiMessages.push({ role: 'user', content: userText.slice(0, 2000) });
    }

    const apiUrl = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/chat/completions';
    let model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    if (imageB64 && !/gpt-4|vision|o1|o3|o4/i.test(model)) {
      model = 'gpt-4o-mini';
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        max_tokens: 600,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (data.error) {
      return res.status(response.ok ? 500 : response.status).json({
        error: data.error.message || 'Error de la API de IA',
      });
    }
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'Sin respuesta';
    res.json({ reply });
  } catch (e) {
    console.error('[ERROR] /api/ai/chat', e.message);
    res.status(500).json({ error: String(e.message) });
  }
});

app.listen(PORT, () => {
  console.log(`Suminregio API escuchando en http://localhost:${PORT}`);
});
