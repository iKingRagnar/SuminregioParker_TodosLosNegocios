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
 *  • /api/cxc/top-deudores  → saldo por documento + DOCTOS_CC; condición COALESCE(dc.COND_PAGO_ID, cliente)
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
 *  • Cotizaciones: misma macro que ventas (UNION DOCTOS_VE + DOCTOS_PV), mismo IMPORTE_NETO (sqlVentaImporteBaseExpr),
 *            TIPO_DOCTO en MICROSIP_COTIZACION_TIPOS (por defecto C); ESTATUS <> cancelada; ?tipo=VE|PV igual que ventas.
 *            MICROSIP_COTIZACION_REQUIERE_APLICADO=1 para exigir APLICADO='S' como facturas (por defecto no se filtra APLICADO).
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
// Render expone el commit en RENDER_GIT_COMMIT; si no existe (local), usar string fijo.
const BUILD_FINGERPRINT = (process.env.RENDER_GIT_COMMIT && String(process.env.RENDER_GIT_COMMIT).trim())
  ? ('git:' + String(process.env.RENDER_GIT_COMMIT).trim().slice(0, 12))
  : 'dev-local';

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

// Estado de resultados (formato Microsip/PBI): usar IMPORTE_NETO tal cual (sin divisor global).
function sqlVentaImporteResultadosExpr(alias = 'd') {
  const a = alias;
  return `COALESCE(${a}.IMPORTE_NETO, 0)`;
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// Servir archivos estáticos — public/ primero: si hay mismo nombre en raíz y en public/, gana public/
// (evita que index.html viejo en la raíz opaque public/index.html).
const staticOpts = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
    }
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
      if (err) {

        return reject(err);
      }
      db.query(sql, params, (err2, result) => {
        db.detach();
        if (err2) {

          return reject(err2);
        }
        resolve(result || []);
      });
    });
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Query timeout (${timeoutMs}ms)`)), timeoutMs)
  );
  return Promise.race([queryPromise, timeoutPromise]);
}

/**
 * cxcResumenAgingUnificado lanza varias consultas pesadas en paralelo; 12–30 s suele ser poco en Firebird remoto (Render).
 * Env: MICROSIP_CXC_AGING_Q_MS (mín. 5000, por defecto 45000, tope 180000).
 */
function cxcAgingQueryMs() {
  const n = parseInt(process.env.MICROSIP_CXC_AGING_Q_MS, 10);
  const t = Number.isFinite(n) && n >= 5000 ? n : 45000;
  return Math.min(180000, Math.max(15000, t));
}

const tableColumnsCache = new Map();
function dbCacheKey(dbOptsOverride = null) {
  const o = dbOptsOverride || DB_OPTIONS;
  return `${o.host || ''}|${o.port || ''}|${o.database || ''}|${o.user || ''}`;
}
async function getTableColumns(tableName, dbOptsOverride = null) {
  const table = String(tableName || '').trim().toUpperCase();
  if (!table) return new Set();
  const key = `${dbCacheKey(dbOptsOverride)}::${table}`;
  if (tableColumnsCache.has(key)) return tableColumnsCache.get(key);
  const rows = await query(
    `SELECT TRIM(rf.RDB$FIELD_NAME) AS N
     FROM RDB$RELATION_FIELDS rf
     WHERE rf.RDB$RELATION_NAME = ?
     ORDER BY rf.RDB$FIELD_POSITION`,
    [table],
    12000,
    dbOptsOverride
  ).catch(() => []);
  const cols = new Set((rows || []).map((r) => String(r.N || '').trim().toUpperCase()).filter(Boolean));
  // Solo cachear si realmente se obtuvieron columnas; si está vacío (cold-start failure) se reintentará en el próximo request
  if (cols.size > 0) tableColumnsCache.set(key, cols);
  return cols;
}
function firstExistingColumn(colsSet, candidates) {
  for (const c of candidates || []) {
    const cc = String(c || '').trim().toUpperCase();
    if (cc && colsSet.has(cc)) return cc;
  }
  return null;
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

  let primaryPath =
    String(process.env.FB_DATABASE || '').trim() || String(DB_OPTIONS.database || '').trim();
  const primaryExists = (p) => {
    try { return !!(p && fs.existsSync(path.resolve(String(p)))); } catch (_) { return false; }
  };
  // Fallback automático para instalaciones locales típicas cuando C:/Microsip datos no existe.
  if (!primaryExists(primaryPath)) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const guess = [
      path.join(home, 'Downloads', 'BI Ventas', 'SUMINREGIO-PARKER.FDB'),
      path.join(home, 'Downloads', 'BI Ventas', 'SUMINREGIO-PARKER.fdb'),
    ];
    const hit = guess.find((p) => primaryExists(p));
    if (hit) {
      primaryPath = hit;
      console.warn('[FB_DATABASE] Ruta principal no encontrada; usando fallback detectado:', path.resolve(hit));
    }
  }

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

  // Si existe id "default", forzarlo a la base principal resuelta para que el panel no caiga en rutas muertas.
  const defaultIdx = entries.findIndex(e => String(e.id || '').toLowerCase() === 'default');
  if (defaultIdx >= 0 && primaryPath) {
    entries[defaultIdx].options = { ...entries[defaultIdx].options, database: primaryPath };
    if (!entries[defaultIdx].label || /principal/i.test(String(entries[defaultIdx].label))) {
      entries[defaultIdx].label = process.env.EMPRESA_NOMBRE || 'Suminregio Parker (principal)';
    }
  }

  if (!entries.length) {
    pushEntry('default', process.env.EMPRESA_NOMBRE || 'Principal', DB_OPTIONS.database, {});
  }

  if (!entries.length) {
    return [{ id: 'default', label: process.env.EMPRESA_NOMBRE || 'Principal', options: { ...DB_OPTIONS } }];
  }

  // Mostrar solo familias de negocio permitidas por dirección:
  // suminregio, agua, medicos, madera, carton, especial y reciclaje (sin empaque).
  const allowedDbTerms = ['suminregio', 'agua', 'medicos', 'madera', 'carton', 'especial', 'reciclaje'];
  /** Excluye bases que dirección pidió retirar del selector (sigue existiendo en disco / registry). */
  const isExcludedCatalogEntry = (e) => {
    const base = path.basename(String(e && e.options && e.options.database ? e.options.database : '')).toLowerCase();
    const pool = [
      e && e.id,
      e && e.label,
      base,
      e && e.options && e.options.database ? String(e.options.database).toLowerCase() : '',
    ].join(' ');
    if (/empaque/i.test(pool)) return true;
    if (pool.includes('hamer')) return true;
    if (base === 'suminregio.fdb') return true;
    if (String(e && e.id).toLowerCase() === 'suminregio' && !pool.includes('parker')) return true;
    if (/suminregio\s*especial|suminregio_especial/.test(pool)) return true;
    if (base.includes('especial') && base.includes('suminregio')) return true;
    return false;
  };
  const isSnapshotOrTempDb = (e) => {
    const pool = [
      e && e.id,
      e && e.label,
      e && e.options && e.options.database ? path.basename(String(e.options.database)) : '',
    ].join(' ').toLowerCase();
    if (!pool.includes('parker')) return false;
    return (
      /(^|[_\-\s])(ant|temp|msp)([_\-\s]|$)/.test(pool) ||
      /parker[_\-\s]*23\s*jun|parker[_\-\s]*23jun/.test(pool) ||
      /parker[_\-\s]*320/.test(pool) ||
      /parker[_\-\s]*paso/.test(pool)
    );
  };
  const isAllowed = (e) => {
    const pool = [
      e && e.id,
      e && e.label,
      e && e.options && e.options.database ? path.basename(String(e.options.database)) : '',
    ].join(' ').toLowerCase();
    if (isSnapshotOrTempDb(e)) return false;
    return allowedDbTerms.some((t) => pool.includes(t));
  };
  const filtered = entries.filter(isAllowed).filter((e) => !isExcludedCatalogEntry(e));
  if (filtered.length) {
    console.log('[Firebird] filtro de catálogo activo:', filtered.length, 'de', entries.length, 'bases visibles');
    return filtered;
  }

  // Fallback de seguridad para no dejar el catálogo vacío.
  const fallbackDefault = entries.find((e) => String((e && e.id) || '').toLowerCase() === 'default');
  return fallbackDefault ? [fallbackDefault] : entries.slice(0, 1);
}

const DATABASE_REGISTRY = parseDatabaseRegistry();
console.log(
  '[Firebird] bases registradas (' + DATABASE_REGISTRY.length + '):',
  DATABASE_REGISTRY.map((d) => `${d.id} ← ${path.basename(d.options.database || '')}`).join(' | ')
);

function normalizeDbQueryId(raw) {
  const src = raw != null ? String(raw).trim() : '';
  if (!src) return '';
  const parts = src.split(',').map(s => String(s || '').trim()).filter(Boolean);
  if (!parts.length) return '';
  // Caso frecuente: db=default,default o db=elige,elige
  if (parts.every(p => p.toLowerCase() === parts[0].toLowerCase())) return parts[0];
  // Si vienen múltiples valores distintos, usar el primero no vacío.
  return parts[0];
}

/** null = FB_DATABASE por defecto; ?db=id debe existir en DATABASE_REGISTRY o lanza error. */
function getReqDbOpts(req) {
  if (!req || !req.query) return null;
  const id = normalizeDbQueryId(req.query.db);
  if (!id || id.toLowerCase() === 'default') {
    const def = DATABASE_REGISTRY.find(d => String(d.id || '').toLowerCase() === 'default');
    return def ? def.options : null;
  }
  const idLc = id.toLowerCase();
  const hit = DATABASE_REGISTRY.find(d => String(d.id).toLowerCase() === idLc);
  if (!hit) {
    console.warn('[db] Parámetro db desconocido (se usa FB_DATABASE por defecto):', id);
    const def = DATABASE_REGISTRY.find(d => String(d.id || '').toLowerCase() === 'default');
    return def ? def.options : null;
  }
  return hit.options;
}

/**
 * Ejecuta queryFn contra todas las bases registradas y combina los resultados.
 * queryFn recibe (dbOptions, entry) y debe devolver un array.
 * Cada fila recibe una propiedad EMPRESA con el label de la empresa.
 */
async function runForAllDbs(queryFn) {
  const results = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
    try {
      const rows = await queryFn(entry.options, entry);
      const label = entry.label || entry.id || path.basename(entry.options.database || '');
      return (rows || []).map(r => Object.assign({}, r, { EMPRESA: label }));
    } catch (e) {
      const id = entry && (entry.id || entry.label) ? String(entry.id || entry.label) : '?';
      console.error(`[runForAllDbs] fallo en db=${id}:`, e && (e.message || e));
      throw e;
    }
  });
  return results.flat();
}

function isAllDbs(req) {
  const id = req && req.query && req.query.db != null ? String(req.query.db).trim().toLowerCase() : '';
  return id === '__all__';
}

/** Suma resúmenes de ventas de varias bases (db=__all__). */
function mergeVentasResumen(outs) {
  return outs.reduce(
    (acc, out) => ({
      HOY: acc.HOY + (+out.HOY || 0),
      MES_ACTUAL: acc.MES_ACTUAL + (+out.MES_ACTUAL || 0),
      FACTURAS_MES: acc.FACTURAS_MES + (+out.FACTURAS_MES || 0),
      HASTA_AYER_MES: acc.HASTA_AYER_MES + (+out.HASTA_AYER_MES || 0),
      REMISIONES_HOY: acc.REMISIONES_HOY + (+out.REMISIONES_HOY || 0),
      REMISIONES_MES: acc.REMISIONES_MES + (+out.REMISIONES_MES || 0),
    }),
    { HOY: 0, MES_ACTUAL: 0, FACTURAS_MES: 0, HASTA_AYER_MES: 0, REMISIONES_HOY: 0, REMISIONES_MES: 0 },
  );
}

/** Número desde fila Firebird / driver (string con coma, distintas mayúsculas en alias). */
function sqlRowNumber(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function pickCotizacionResumenField(r, upperKeys) {
  if (!r || typeof r !== 'object') return 0;
  const byUpper = new Map();
  for (const [k, v] of Object.entries(r)) {
    byUpper.set(String(k).toUpperCase(), v);
  }
  for (const k of upperKeys) {
    if (byUpper.has(k)) return sqlRowNumber(byUpper.get(k));
  }
  return 0;
}

function mergeCotizacionResumenRows(rows) {
  return rows.reduce(
    (acc, r) => ({
      HOY: acc.HOY + pickCotizacionResumenField(r, ['HOY']),
      MES_ACTUAL: acc.MES_ACTUAL + pickCotizacionResumenField(r, ['MES_ACTUAL']),
      COTIZACIONES_MES: acc.COTIZACIONES_MES + pickCotizacionResumenField(r, ['COTIZACIONES_MES']),
      COTIZACIONES_HOY: acc.COTIZACIONES_HOY + pickCotizacionResumenField(r, ['COTIZACIONES_HOY']),
    }),
    { HOY: 0, MES_ACTUAL: 0, COTIZACIONES_MES: 0, COTIZACIONES_HOY: 0 },
  );
}

/** Tipos de documento considerados cotización (env MICROSIP_COTIZACION_TIPOS; default amplio por instalaciones Microsip). */
function parseCotizacionTipos() {
  const raw = (process.env.MICROSIP_COTIZACION_TIPOS || 'C,O,Q,P,CT,CU').trim();
  const parts = raw.split(/[,;|\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return parts.length ? parts : ['C', 'O'];
}

/** Lista SQL IN (legado / herramientas). */
function sqlCotizacionTiposInList() {
  return parseCotizacionTipos()
    .map((t) => `'${String(t).replace(/'/g, "''")}'`)
    .join(', ');
}

function mergeBalanceDetalleSide(arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const r of arr || []) {
      const cu = String(r.CUENTA_PT || '').trim();
      if (!cu) continue;
      const saldo = Math.round((+r.SALDO || 0) * 100) / 100;
      const prev = map.get(cu);
      if (!prev) {
        map.set(cu, { CUENTA_PT: r.CUENTA_PT, NOMBRE: r.NOMBRE || '', SALDO: saldo });
      } else {
        prev.SALDO = Math.round((prev.SALDO + saldo) * 100) / 100;
        const n = String(r.NOMBRE || '').trim();
        if (n.length > String(prev.NOMBRE || '').length) prev.NOMBRE = n;
      }
    }
  }
  return Array.from(map.values())
    .filter((r) => Math.abs(+r.SALDO || 0) >= 0.005)
    .sort((a, b) => Math.abs(+b.SALDO || 0) - Math.abs(+a.SALDO || 0));
}

/** Activo circulante: caja/bancos (nombre o prefijo 1102* típico PCGA MX; "BANREGIO" no contiene "banco"). */
function balanceActivoRowEsCajaBancos(row) {
  const nom = String((row && row.NOMBRE) || '');
  const cu = String((row && row.CUENTA_PT) || '').replace(/\s/g, '');
  if (/caja|banco|efectivo|banregio|bbva|santander|hsbc|inbursa|scotiab|scotiabank|banamex|banorte|citiban|mifel|actinver|bancoppel|interbanc|multiva|monex|velocity|clabe|cuenta\s+de\s+cheques/i.test(nom)) return true;
  if (/^1102[\d.]*/i.test(cu)) return true;
  return false;
}
function balanceActivoRowEsCliente(row) {
  const nom = String((row && row.NOMBRE) || '');
  const cu = String((row && row.CUENTA_PT) || '').replace(/\s/g, '');
  if (/cobrar|cliente|deudor|cuentas\s+por\s+cobrar/i.test(nom)) return true;
  if (/^1103[\d.]*/i.test(cu)) return true;
  return false;
}
function balanceActivoRowEsInventario(row) {
  const nom = String((row && row.NOMBRE) || '');
  const cu = String((row && row.CUENTA_PT) || '').replace(/\s/g, '');
  if (/invent|almacen|mercanc/i.test(nom)) return true;
  if (/^1104[\d.]*/i.test(cu) || /^1105[\d.]*/i.test(cu)) return true;
  return false;
}

/** Desglose Activo (balance clásico) por nombre de cuenta; una fila → un solo rubro. */
function balanceActivoBreakdownFromRows(activoRows) {
  const reFijo = /activo fijo|activo\s+fijo|fijo neto|depreciac|equipo de|equipos|maquin|mobiliario|mueble|veh[ií]culo|transporte|inmueble|terreno|edificio|instalacion(es)?\s+en|inversion(es)?\s+en bienes/i;
  const reDif = /cargos?\s+diferidos?|gasto(s)?\s+diferidos?|diferido|organizaci|constituci|gastos?\s+de\s+instalaci/i;
  let caja = 0;
  let cxc = 0;
  let invent = 0;
  let fijo = 0;
  let dif = 0;
  let otros = 0;
  for (const row of activoRows || []) {
    const sal = +row.SALDO || 0;
    const nom = String(row.NOMBRE || '');
    if (balanceActivoRowEsCajaBancos(row)) caja += sal;
    else if (balanceActivoRowEsCliente(row)) cxc += sal;
    else if (balanceActivoRowEsInventario(row)) invent += sal;
    else if (reFijo.test(nom)) fijo += sal;
    else if (reDif.test(nom)) dif += sal;
    else otros += sal;
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  const circ = caja + cxc + invent;
  return {
    ACTIVO_CAJA_BANCOS: round2(caja),
    ACTIVO_CXC: round2(cxc),
    ACTIVO_INVENTARIO: round2(invent),
    ACTIVO_CIRCULANTE: round2(circ),
    ACTIVO_FIJO_NETO: round2(fijo),
    CARGOS_DIFERIDOS: round2(dif),
    OTROS_ACTIVOS: round2(otros),
  };
}

function mergeBalanceGeneralFromPayloads(parts) {
  const ok = (parts || []).filter(Boolean);
  if (!ok.length) {
    const z = {
      ACTIVO_TOTAL: 0,
      PASIVO_TOTAL: 0,
      CAPITAL_TOTAL: 0,
      PASIVO_MAS_CAPITAL: 0,
      DIFERENCIA_BALANCE: 0,
      ...balanceActivoBreakdownFromRows([]),
    };
    return { cierre: {}, totales: z, detalleFull: { activo: [], pasivo: [], capital: [] } };
  }
  const c0 = ok[0].cierre || {};
  const balanceUltimo = ok.some((p) => p.cierre && p.cierre.balance_ultimo_cierre_disponible);
  const cierre = { ...c0, balance_ultimo_cierre_disponible: balanceUltimo };
  const detalleFull = {
    activo: mergeBalanceDetalleSide(ok.map((p) => p.detalleFull && p.detalleFull.activo)),
    pasivo: mergeBalanceDetalleSide(ok.map((p) => p.detalleFull && p.detalleFull.pasivo)),
    capital: mergeBalanceDetalleSide(ok.map((p) => p.detalleFull && p.detalleFull.capital)),
  };
  const activo_total = ok.reduce((s, p) => s + (+((p.totales || {}).ACTIVO_TOTAL) || 0), 0);
  const pasivo_total = ok.reduce((s, p) => s + (+((p.totales || {}).PASIVO_TOTAL) || 0), 0);
  const capital_total = ok.reduce((s, p) => s + (+((p.totales || {}).CAPITAL_TOTAL) || 0), 0);
  const round2 = (x) => Math.round(x * 100) / 100;
  const at = round2(activo_total);
  const pmc = round2(pasivo_total + capital_total);
  const actBreak = balanceActivoBreakdownFromRows(detalleFull.activo);
  return {
    cierre,
    totales: {
      ACTIVO_TOTAL: at,
      PASIVO_TOTAL: round2(pasivo_total),
      CAPITAL_TOTAL: round2(capital_total),
      PASIVO_MAS_CAPITAL: pmc,
      DIFERENCIA_BALANCE: round2(pmc - at),
      ...actBreak,
    },
    detalleFull,
  };
}

function sliceBalanceGeneralPublic(p) {
  const df = p.detalleFull || { activo: [], pasivo: [], capital: [] };
  return {
    cierre: p.cierre,
    totales: p.totales,
    detalle: {
      activo: (df.activo || []).slice(0, 20),
      pasivo: (df.pasivo || []).slice(0, 20),
      capital: (df.capital || []).slice(0, 20),
    },
  };
}

function mergeCxcResumenAgingSnaps(snaps) {
  const out = {
    resumen: {
      SALDO_TOTAL: 0,
      NUM_CLIENTES: 0,
      NUM_CLIENTES_VENCIDOS: 0,
      VENCIDO: 0,
      POR_VENCER: 0,
    },
    aging: {
      CORRIENTE: 0,
      DIAS_1_30: 0,
      DIAS_31_60: 0,
      DIAS_61_90: 0,
      DIAS_MAS_90: 0,
    },
  };
  for (const s of snaps || []) {
    if (!s || !s.resumen) continue;
    out.resumen.SALDO_TOTAL += +s.resumen.SALDO_TOTAL || 0;
    out.resumen.NUM_CLIENTES += +s.resumen.NUM_CLIENTES || 0;
    out.resumen.NUM_CLIENTES_VENCIDOS += +s.resumen.NUM_CLIENTES_VENCIDOS || 0;
    out.resumen.VENCIDO += +s.resumen.VENCIDO || 0;
    out.resumen.POR_VENCER += +s.resumen.POR_VENCER || 0;
    if (s.aging) {
      out.aging.CORRIENTE += +s.aging.CORRIENTE || 0;
      out.aging.DIAS_1_30 += +s.aging.DIAS_1_30 || 0;
      out.aging.DIAS_31_60 += +s.aging.DIAS_31_60 || 0;
      out.aging.DIAS_61_90 += +s.aging.DIAS_61_90 || 0;
      out.aging.DIAS_MAS_90 += +s.aging.DIAS_MAS_90 || 0;
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  out.resumen.SALDO_TOTAL = r2(out.resumen.SALDO_TOTAL);
  out.resumen.VENCIDO = r2(out.resumen.VENCIDO);
  out.resumen.POR_VENCER = r2(out.resumen.POR_VENCER);
  Object.keys(out.aging).forEach((k) => { out.aging[k] = r2(out.aging[k]); });
  return out;
}

function mergeCxcPorCondicionPayloads(payloads) {
  const map = new Map();
  for (const data of payloads || []) {
    const grupos = (data && data.grupos) || [];
    for (const g of grupos) {
      const key = `${g.CONDICION_PAGO}|${g.DIAS_CREDITO}|${g.ES_CONTADO ? 1 : 0}`;
      if (!map.has(key)) {
        map.set(key, {
          CONDICION_PAGO: g.CONDICION_PAGO,
          DIAS_CREDITO: g.DIAS_CREDITO,
          NUM_CLIENTES: 0,
          NUM_DOCUMENTOS: 0,
          SALDO_TOTAL: 0,
          VENCIDO: 0,
          CORRIENTE: 0,
          ES_CONTADO: !!g.ES_CONTADO,
        });
      }
      const a = map.get(key);
      a.NUM_CLIENTES += +g.NUM_CLIENTES || 0;
      a.NUM_DOCUMENTOS += +g.NUM_DOCUMENTOS || 0;
      a.SALDO_TOTAL += +g.SALDO_TOTAL || 0;
      a.VENCIDO += +g.VENCIDO || 0;
      a.CORRIENTE += +g.CORRIENTE || 0;
    }
  }
  const grupos = Array.from(map.values())
    .map((g) => ({
      CONDICION_PAGO: g.CONDICION_PAGO,
      DIAS_CREDITO: g.DIAS_CREDITO,
      NUM_CLIENTES: g.NUM_CLIENTES,
      NUM_DOCUMENTOS: g.NUM_DOCUMENTOS,
      SALDO_TOTAL: Math.round(g.SALDO_TOTAL * 100) / 100,
      VENCIDO: Math.round(g.VENCIDO * 100) / 100,
      CORRIENTE: Math.round(g.CORRIENTE * 100) / 100,
      ES_CONTADO: !!g.ES_CONTADO,
    }))
    .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);
  return { grupos, pendiente_contado: null };
}

function mergeDirectorResumenSnapshots(parts) {
  const ventas = {
    HOY: 0,
    MES_ACTUAL: 0,
    FACTURAS_MES: 0,
    MES_VE: 0,
    MES_PV: 0,
    REMISIONES_HOY: 0,
    REMISIONES_MES: 0,
  };
  const cxc = {
    SALDO_TOTAL: 0,
    NUM_CLIENTES: 0,
    NUM_CLIENTES_VENCIDOS: 0,
    VENCIDO: 0,
    POR_VENCER: 0,
  };
  const cotizaciones = {
    COTI_HOY: 0,
    IMPORTE_COTI_HOY: 0,
    IMPORTE_COTI_MES: 0,
    COTI_MES: 0,
  };
  for (const p of parts || []) {
    if (!p) continue;
    const v = p.ventas || {};
    ventas.HOY += +v.HOY || 0;
    ventas.MES_ACTUAL += +v.MES_ACTUAL || 0;
    ventas.FACTURAS_MES += +v.FACTURAS_MES || 0;
    ventas.MES_VE += +v.MES_VE || 0;
    ventas.MES_PV += +v.MES_PV || 0;
    ventas.REMISIONES_HOY += +v.REMISIONES_HOY || 0;
    ventas.REMISIONES_MES += +v.REMISIONES_MES || 0;
    const cx = p.cxc || {};
    cxc.SALDO_TOTAL += +cx.SALDO_TOTAL || 0;
    cxc.NUM_CLIENTES += +cx.NUM_CLIENTES || 0;
    cxc.NUM_CLIENTES_VENCIDOS += +cx.NUM_CLIENTES_VENCIDOS || 0;
    cxc.VENCIDO += +cx.VENCIDO || 0;
    cxc.POR_VENCER += +cx.POR_VENCER || 0;
    const co = p.cotizaciones || {};
    cotizaciones.COTI_HOY += +co.COTI_HOY || 0;
    cotizaciones.IMPORTE_COTI_HOY += +co.IMPORTE_COTI_HOY || 0;
    cotizaciones.IMPORTE_COTI_MES += +co.IMPORTE_COTI_MES || 0;
    cotizaciones.COTI_MES += +co.COTI_MES || 0;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  cxc.SALDO_TOTAL = r2(cxc.SALDO_TOTAL);
  cxc.VENCIDO = r2(cxc.VENCIDO);
  cxc.POR_VENCER = r2(cxc.POR_VENCER);
  cotizaciones.IMPORTE_COTI_HOY = r2(cotizaciones.IMPORTE_COTI_HOY);
  cotizaciones.IMPORTE_COTI_MES = r2(cotizaciones.IMPORTE_COTI_MES);
  ventas.HOY = r2(ventas.HOY);
  ventas.MES_ACTUAL = r2(ventas.MES_ACTUAL);
  ventas.MES_VE = r2(ventas.MES_VE);
  ventas.MES_PV = r2(ventas.MES_PV);
  ventas.REMISIONES_HOY = r2(ventas.REMISIONES_HOY);
  ventas.REMISIONES_MES = r2(ventas.REMISIONES_MES);
  return { ventas, cxc, cotizaciones };
}

function mergeDiariasVentas(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const k = String(r.DIA);
      if (!map.has(k)) map.set(k, { DIA: r.DIA, VENTAS_VE: 0, VENTAS_PV: 0, TOTAL_VENTAS: 0 });
      const m = map.get(k);
      m.VENTAS_VE += +(r.VENTAS_VE || 0);
      m.VENTAS_PV += +(r.VENTAS_PV || 0);
      m.TOTAL_VENTAS += +(r.TOTAL_VENTAS || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.DIA).localeCompare(String(b.DIA)));
}

function mergeMensualesVentas(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const k = `${+r.ANIO}-${+r.MES}`;
      if (!map.has(k)) {
        map.set(k, {
          ANIO: +r.ANIO,
          MES: +r.MES,
          FACTURAS: 0,
          VENTAS_VE: 0,
          VENTAS_PV: 0,
          TOTAL: 0,
        });
      }
      const m = map.get(k);
      m.FACTURAS += +(r.FACTURAS || 0);
      m.VENTAS_VE += +(r.VENTAS_VE || 0);
      m.VENTAS_PV += +(r.VENTAS_PV || 0);
      m.TOTAL += +(r.TOTAL || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.ANIO !== b.ANIO ? a.ANIO - b.ANIO : a.MES - b.MES));
}

function mergeSemanalesVentas(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const k = `${+r.ANIO}-${+r.SEMANA}`;
      if (!map.has(k)) map.set(k, { ANIO: +r.ANIO, SEMANA: +r.SEMANA, FACTURAS: 0, TOTAL: 0 });
      const m = map.get(k);
      m.FACTURAS += +(r.FACTURAS || 0);
      m.TOTAL += +(r.TOTAL || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.ANIO !== b.ANIO ? a.ANIO - b.ANIO : a.SEMANA - b.SEMANA));
}

function mergeSemanalesCotiz(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const k = `${+r.ANIO}-${+r.SEMANA}`;
      if (!map.has(k)) map.set(k, { ANIO: +r.ANIO, SEMANA: +r.SEMANA, COTIZACIONES: 0, TOTAL: 0 });
      const m = map.get(k);
      m.COTIZACIONES += +(r.COTIZACIONES || 0);
      m.TOTAL += +(r.TOTAL || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.ANIO !== b.ANIO ? a.ANIO - b.ANIO : a.SEMANA - b.SEMANA));
}

function mergeMensualesCotiz(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const k = `${+r.ANIO}-${+r.MES}`;
      if (!map.has(k)) map.set(k, { ANIO: +r.ANIO, MES: +r.MES, COTIZACIONES: 0, TOTAL: 0 });
      const m = map.get(k);
      m.COTIZACIONES += +(r.COTIZACIONES || 0);
      m.TOTAL += +(r.TOTAL || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.ANIO !== b.ANIO ? a.ANIO - b.ANIO : a.MES - b.MES));
}

function mergeDiariasCotiz(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const diaVal = r.DIA ?? r.dia;
      const k = String(diaVal);
      if (!map.has(k)) map.set(k, { DIA: diaVal, COTIZACIONES: 0, TOTAL_COTIZACIONES: 0 });
      const m = map.get(k);
      m.COTIZACIONES += pickCotizacionResumenField(r, ['COTIZACIONES']);
      m.TOTAL_COTIZACIONES += pickCotizacionResumenField(r, ['TOTAL_COTIZACIONES']);
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.DIA).localeCompare(String(b.DIA)));
}

/** Agrupa por nombre de vendedor (mismo nombre en distintas bases = una fila). */
function mergePorVendedorVentas(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const name = String(r.VENDEDOR || '').trim();
      const key = name.toUpperCase() || `__ID_${r.VENDEDOR_ID}`;
      if (!map.has(key)) {
        map.set(key, {
          VENDEDOR_ID: +(r.VENDEDOR_ID || 0),
          VENDEDOR: name || r.VENDEDOR,
          VENTAS_HOY: 0,
          VENTAS_MES: 0,
          VENTAS_MES_VE: 0,
          VENTAS_MES_PV: 0,
          FACTURAS_HOY: 0,
          FACTURAS_MES: 0,
        });
      }
      const m = map.get(key);
      m.VENTAS_HOY += +(r.VENTAS_HOY || 0);
      m.VENTAS_MES += +(r.VENTAS_MES || 0);
      m.VENTAS_MES_VE += +(r.VENTAS_MES_VE || 0);
      m.VENTAS_MES_PV += +(r.VENTAS_MES_PV || 0);
      m.FACTURAS_HOY += +(r.FACTURAS_HOY || 0);
      m.FACTURAS_MES += +(r.FACTURAS_MES || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.VENTAS_MES - a.VENTAS_MES);
}

function mergePorVendedorCotiz(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const name = String(r.VENDEDOR || '').trim();
      const key = name.toUpperCase() || `__ID_${r.VENDEDOR_ID}`;
      if (!map.has(key)) {
        map.set(key, {
          VENDEDOR_ID: +(r.VENDEDOR_ID || 0),
          VENDEDOR: name || r.VENDEDOR,
          COTIZACIONES_HOY: 0,
          COTIZACIONES_MES: 0,
          NUM_COTI_MES: 0,
        });
      }
      const m = map.get(key);
      m.COTIZACIONES_HOY += pickCotizacionResumenField(r, ['COTIZACIONES_HOY']);
      m.COTIZACIONES_MES += pickCotizacionResumenField(r, ['COTIZACIONES_MES']);
      m.NUM_COTI_MES += pickCotizacionResumenField(r, ['NUM_COTI_MES']);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.COTIZACIONES_MES - a.COTIZACIONES_MES);
}

function mergeTopClientes(rowsList, limit) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const name = String(r.CLIENTE || '').trim().toUpperCase();
      if (!name) continue;
      if (!map.has(name)) {
        map.set(name, { CLIENTE_ID: r.CLIENTE_ID, CLIENTE: r.CLIENTE, FACTURAS: 0, TOTAL: 0 });
      }
      const m = map.get(name);
      m.FACTURAS += +(r.FACTURAS || 0);
      m.TOTAL += +(r.TOTAL || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.TOTAL - a.TOTAL).slice(0, limit);
}

function mergeRankingClientes(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const name = String(r.NOMBRE || '').trim().toUpperCase();
      if (!name) continue;
      if (!map.has(name)) map.set(name, { CLIENTE_ID: r.CLIENTE_ID, NOMBRE: r.NOMBRE, VENTA: 0 });
      map.get(name).VENTA += +(r.VENTA || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.VENTA - a.VENTA);
}

function mergeVsCotizaciones(parts) {
  const vmap = new Map();
  const cmap = new Map();
  for (const { ventas, cotizaciones } of parts) {
    for (const r of ventas || []) {
      const k = `${+r.ANIO}-${+r.MES}`;
      if (!vmap.has(k)) vmap.set(k, { ANIO: +r.ANIO, MES: +r.MES, TOTAL_VENTAS: 0, NUM_DOCS: 0 });
      const mv = vmap.get(k);
      mv.TOTAL_VENTAS += +(r.TOTAL_VENTAS || 0);
      mv.NUM_DOCS += +(r.NUM_DOCS || 0);
    }
    for (const r of cotizaciones || []) {
      const k = `${+r.ANIO}-${+r.MES}`;
      if (!cmap.has(k)) cmap.set(k, { ANIO: +r.ANIO, MES: +r.MES, TOTAL_COTI: 0, NUM_COTI: 0 });
      const mc = cmap.get(k);
      mc.TOTAL_COTI += +(r.TOTAL_COTI || 0);
      mc.NUM_COTI += +(r.NUM_COTI || 0);
    }
  }
  const allKeys = [...new Set([...vmap.keys(), ...cmap.keys()])].sort((a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return ay !== by ? ay - by : am - bm;
  });
  const ventas = allKeys.map((k) => {
    if (vmap.has(k)) return vmap.get(k);
    const c = cmap.get(k);
    return { ANIO: c.ANIO, MES: c.MES, TOTAL_VENTAS: 0, NUM_DOCS: 0 };
  });
  const cotizaciones = allKeys.map((k) => {
    if (cmap.has(k)) return cmap.get(k);
    const v = vmap.get(k);
    return { ANIO: v.ANIO, MES: v.MES, TOTAL_COTI: 0, NUM_COTI: 0 };
  });
  return { ventas, cotizaciones };
}

/** Cotizaciones: misma lógica VE+PV sin UNION (timeout PV remoto). */
function mergeDiariasCotizVePv(veRows, pvRows) {
  const map = new Map();
  const add = (r) => {
    if (!r || r.DIA == null) return;
    const k = String(r.DIA);
    const cur = map.get(k) || { DIA: r.DIA, COTIZACIONES: 0, TOTAL_COTIZACIONES: 0 };
    cur.COTIZACIONES += +(r.COTIZACIONES || 0);
    cur.TOTAL_COTIZACIONES += +(r.TOTAL_COTIZACIONES || 0);
    map.set(k, cur);
  };
  (veRows || []).forEach(add);
  (pvRows || []).forEach(add);
  return Array.from(map.values()).sort((a, b) => new Date(a.DIA) - new Date(b.DIA));
}

function mergePorVendedorCotizVePv(veRows, pvRows) {
  const map = new Map();
  const add = (r) => {
    if (!r) return;
    const id = +(r.VENDEDOR_ID || 0);
    const cur = map.get(id) || {
      VENDEDOR_ID: id,
      VENDEDOR: r.VENDEDOR || 'No asignado',
      COTIZACIONES_HOY: 0,
      COTIZACIONES_MES: 0,
      NUM_COTI_MES: 0,
    };
    cur.COTIZACIONES_HOY += +(r.COTIZACIONES_HOY || 0);
    cur.COTIZACIONES_MES += +(r.COTIZACIONES_MES || 0);
    cur.NUM_COTI_MES += +(r.NUM_COTI_MES || 0);
    if (r.VENDEDOR && String(r.VENDEDOR).trim() && r.VENDEDOR !== 'No asignado') cur.VENDEDOR = r.VENDEDOR;
    map.set(id, cur);
  };
  (veRows || []).forEach(add);
  (pvRows || []).forEach(add);
  return Array.from(map.values()).sort((a, b) => (b.COTIZACIONES_MES || 0) - (a.COTIZACIONES_MES || 0));
}

function mergeVsCotizMesVePv(veRows, pvRows) {
  const map = new Map();
  const add = (r) => {
    if (!r) return;
    const k = `${+r.ANIO}-${+r.MES}`;
    const cur = map.get(k) || { ANIO: +r.ANIO, MES: +r.MES, TOTAL_COTI: 0, NUM_COTI: 0 };
    cur.TOTAL_COTI += +(r.TOTAL_COTI || 0);
    cur.NUM_COTI += +(r.NUM_COTI || 0);
    map.set(k, cur);
  };
  (veRows || []).forEach(add);
  (pvRows || []).forEach(add);
  return Array.from(map.values()).sort((a, b) => (a.ANIO - b.ANIO) || (a.MES - b.MES));
}

function mergeRecientes(rowsList, limit) {
  const flat = rowsList.flat().filter(Boolean);
  flat.sort((a, b) => {
    const ta = +(a.TOTAL || 0) - +(b.TOTAL || 0);
    if (ta !== 0) return -ta;
    const fa = new Date(a.FECHA).getTime();
    const fb = new Date(b.FECHA).getTime();
    if (fa !== fb) return fb - fa;
    return String(b.FOLIO || '').localeCompare(String(a.FOLIO || ''));
  });
  return flat.slice(0, limit);
}

/** Lista de cotizaciones consolidada (ordena por importe). */
function mergeCotizacionesList(rowsList, limit) {
  const flat = rowsList.flat().filter(Boolean);
  flat.sort((a, b) => {
    const ia = +(a.IMPORTE_NETO || 0) - +(b.IMPORTE_NETO || 0);
    if (ia !== 0) return -ia;
    const fa = new Date(a.FECHA).getTime();
    const fb = new Date(b.FECHA).getTime();
    if (fa !== fb) return fb - fa;
    return String(b.FOLIO || '').localeCompare(String(a.FOLIO || ''));
  });
  return flat.slice(0, limit);
}

function mergeVendedoresList(rowsList) {
  const map = new Map();
  for (const rows of rowsList) {
    for (const r of rows || []) {
      const name = String(r.NOMBRE || '').trim().toUpperCase();
      if (!name) continue;
      if (!map.has(name)) map.set(name, { VENDEDOR_ID: r.VENDEDOR_ID, NOMBRE: r.NOMBRE });
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.NOMBRE).localeCompare(String(b.NOMBRE), 'es'));
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
 * Genera sub-SELECT con UNION ALL de DOCTOS_VE + DOCTOS_PV,
 * filtrando solo Facturas/Ventas válidas sin doble-conteo.
 * @param {string} tipo - 'VE', 'PV' o '' (todos)
 */
function ventasSub(tipo = '', opts = {}) {
  const includeRemisiones = !!(opts && opts.includeRemisiones);
  const doctosVenta = includeRemisiones ? "('V', 'F')" : "('F')";
  const imp = sqlVentaImporteBaseExpr('d');
  const impBruto = `COALESCE(d.IMPORTE_NETO, 0)`;
  const ve = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      ${impBruto} AS IMPORTE_NETO_BRUTO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.DOCTO_VE_ID,
      CAST(NULL AS INTEGER) AS DOCTO_PV_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    WHERE (
      d.TIPO_DOCTO IN ${doctosVenta}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`;

  const pv = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      ${impBruto} AS IMPORTE_NETO_BRUTO,
      COALESCE(
        CASE WHEN d.TIPO_DOCTO = 'F' THEN
          (SELECT d2.VENDEDOR_ID
           FROM DOCTOS_PV_LIGAS liga
           JOIN DOCTOS_PV d2 ON d2.DOCTO_PV_ID = liga.DOCTO_PV_FTE_ID
           WHERE liga.DOCTO_PV_DEST_ID = d.DOCTO_PV_ID
           ROWS 1)
        ELSE d.VENDEDOR_ID
        END,
      0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    WHERE (
      d.TIPO_DOCTO IN ${doctosVenta}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

function remisionesSub(tipo = '') {
  const imp = sqlVentaImporteBaseExpr('d');
  const impBruto = `COALESCE(d.IMPORTE_NETO, 0)`;
  const ve = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      ${impBruto} AS IMPORTE_NETO_BRUTO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.DOCTO_VE_ID,
      CAST(NULL AS INTEGER) AS DOCTO_PV_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    WHERE (
      d.TIPO_DOCTO = 'V'
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`;
  const pv = `
    SELECT
      d.FECHA,
      ${imp} AS IMPORTE_NETO,
      ${impBruto} AS IMPORTE_NETO_BRUTO,
      COALESCE(d.VENDEDOR_ID, 0)  AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    WHERE (
      d.TIPO_DOCTO = 'V'
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`;
  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COTIZACIONES — misma macro que ventas (UNION DOCTOS_VE + DOCTOS_PV), misma base de importe
//  (sqlVentaImporteBaseExpr). TIPO_DOCTO vía MICROSIP_COTIZACION_TIPOS (default C,O,Q,P; 1ª letra o texto completo).
//  ESTATUS <> C (no cancelada). APLICADO='S' solo si MICROSIP_COTIZACION_REQUIERE_APLICADO=1.
//  Vigencia (FECHA_VENCIMIENTO…) solo en rama VE, vía resolveCotizacionVigenciaSqlSuffix.
//  Por defecto getCotizacionesTipo() = '' (VE+PV): el filtro Industrial/Mostrador no vacía cotizaciones.
//  MICROSIP_COTIZACION_SOLO_TIPO_MARCADO=1 → solo letras C,O,Q,P + texto COTIZ* (sin fallback amplio).
// ═══════════════════════════════════════════════════════════════════════════════

/** @param {'VE'|'PV'} src — reglas de “no es venta cerrada” difieren entre DOCTOS_VE y DOCTOS_PV. */
function sqlWhereCotizacionComoVenta(alias = 'd', src = 'VE') {
  const a = alias;
  const soloTipoMarcado = (process.env.MICROSIP_COTIZACION_SOLO_TIPO_MARCADO || '').match(/^(1|true|yes)$/i);
  const reqAplicado = (process.env.MICROSIP_COTIZACION_REQUIERE_APLICADO || '').match(/^(1|true|yes)$/i);
  const aplicado = reqAplicado ? ` AND COALESCE(${a}.APLICADO, 'N') = 'S'` : '';
  const tipos = parseCotizacionTipos();
  const trimmed = `UPPER(TRIM(CAST(${a}.TIPO_DOCTO AS VARCHAR(40))))`;
  const one = tipos.filter((t) => t.length === 1);
  const multi = tipos.filter((t) => t.length > 1);
  const esc = (t) => `'${String(t).replace(/'/g, "''")}'`;
  const parts = [];
  if (one.length) parts.push(`SUBSTRING(${trimmed} FROM 1 FOR 1) IN (${one.map(esc).join(', ')})`);
  if (multi.length) parts.push(`${trimmed} IN (${multi.map(esc).join(', ')})`);
  const byCodes = parts.length ? `(${parts.join(' OR ')})` : '0=1';
  const byCotizNombre = `(
      POSITION('COTIZ' IN ${trimmed}) > 0
      OR POSITION('COTI' IN ${trimmed}) > 0
      OR POSITION('PRESUP' IN ${trimmed}) > 0
      OR POSITION('PROPUE' IN ${trimmed}) > 0
    )`;
  const tipoSql = `(${byCodes} OR ${byCotizNombre})`;
  const estNotC = `UPPER(TRIM(CAST(COALESCE(${a}.ESTATUS, 'N') AS VARCHAR(8)))) <> 'C'`;
  if (soloTipoMarcado) {
    return `( ${tipoSql} AND ${estNotC} )${aplicado}`;
  }
  const noEsVentaCerradaVe = `NOT (
      ${a}.TIPO_DOCTO IN ('F', 'V', 'R')
      AND COALESCE(${a}.APLICADO, 'N') = 'S'
      AND COALESCE(${a}.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
    )`;
  const noEsVentaCerradaPv = `NOT (
      ${a}.TIPO_DOCTO = 'F'
      AND COALESCE(${a}.APLICADO, 'N') = 'S'
      AND COALESCE(${a}.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
    )`;
  /* No excluir 'T': en varias bases las cotizaciones/pedidos abiertos usan ESTATUS T y quedaban fuera de toda macro (KPI $0). C,D,S siguen fuera como en ventas. */
  const exEstFallback = `COALESCE(${a}.ESTATUS, 'N') NOT IN ('C', 'D', 'S')`;
  const fallback =
    src === 'PV'
      ? `( ${noEsVentaCerradaPv} AND ${exEstFallback} )`
      : `( ${noEsVentaCerradaVe} AND ${exEstFallback} )`;
  return `( ( ${tipoSql} OR ${fallback} ) AND ${estNotC} )${aplicado}`;
}

/** Rango ISO YYYY-MM-DD para acotar cotizaciones dentro del sub-SELECT (evita escanear todo el histórico). */
function sqlCotizInnerFechaBounds(feExpr, bounds) {
  if (!bounds || typeof bounds !== 'object') return '';
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let s = '';
  if (bounds.desde && re.test(String(bounds.desde))) {
    s += ` AND CAST(${feExpr} AS DATE) >= CAST('${String(bounds.desde)}' AS DATE)`;
  }
  if (bounds.hasta && re.test(String(bounds.hasta))) {
    s += ` AND CAST(${feExpr} AS DATE) <= CAST('${String(bounds.hasta)}' AS DATE)`;
  }
  return s;
}

/**
 * Sub-SELECT cotizaciones: paralelo a ventasSub(), con TIPO_DOCTO 'C' y opcional sufijo de vigencia en VE.
 * @param {string} tipo - 'VE', 'PV' o '' (ambos)
 * @param {{ vigenciaVeSuffix?: string }} opts
 * @param {{ desde?: string, hasta?: string } | null} innerBounds - filtro de fecha **dentro** del subquery (crítico en tablas grandes).
 */
function cotizacionesSub(tipo = '', opts = {}, innerBounds = null) {
  const vigVe = String((opts && opts.vigenciaVeSuffix) || '');
  const feVe = (opts && opts.sqlFeVe) || 'd.FECHA';
  const fePv = (opts && opts.sqlFePv) || 'd.FECHA';
  const bVe = sqlCotizInnerFechaBounds(feVe, innerBounds);
  const bPv = sqlCotizInnerFechaBounds(fePv, innerBounds);
  const imp = sqlVentaImporteBaseExpr('d');
  const wVe = sqlWhereCotizacionComoVenta('d', 'VE');
  const wPv = sqlWhereCotizacionComoVenta('d', 'PV');
  const ve = `
    SELECT
      ${feVe} AS FECHA,
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
    WHERE (${wVe})${vigVe}${bVe}
  `;
  const pv = `
    SELECT
      ${fePv} AS FECHA,
      ${imp} AS IMPORTE_NETO,
      COALESCE(
        CASE WHEN d.TIPO_DOCTO = 'F' THEN
          (SELECT d2.VENDEDOR_ID
           FROM DOCTOS_PV_LIGAS liga
           JOIN DOCTOS_PV d2 ON d2.DOCTO_PV_ID = liga.DOCTO_PV_FTE_ID
           WHERE liga.DOCTO_PV_DEST_ID = d.DOCTO_PV_ID
           ROWS 1)
        ELSE d.VENDEDOR_ID
        END,
      0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID,  0)  AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    WHERE (${wPv})${bPv}
  `;
  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

/** desde/hasta ISO desde query (anio+mes materializable como en resumen cotizaciones). */
function cotizQueryIsoBounds(req) {
  const q = req && req.query ? req.query : {};
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desde = q.desde != null ? String(q.desde).trim() : '';
  let hasta = q.hasta != null ? String(q.hasta).trim() : '';
  if (desde && !reDate.test(desde)) desde = '';
  if (hasta && !reDate.test(hasta)) hasta = '';
  if (!desde && !hasta && q.anio && q.mes) {
    const y = parseInt(String(q.anio || ''), 10);
    const m = parseInt(String(q.mes || ''), 10);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      return { desde: `${y}-${String(m).padStart(2, '0')}-01`, hasta: lastDayOfMonth(y, m) };
    }
  }
  if (desde && hasta) return { desde, hasta };
  if (desde) return { desde };
  return null;
}

function normalizeCotizacionResumenRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    HOY: pickCotizacionResumenField(r, ['HOY']),
    MES_ACTUAL: pickCotizacionResumenField(r, ['MES_ACTUAL']),
    COTIZACIONES_MES: pickCotizacionResumenField(r, ['COTIZACIONES_MES']),
    COTIZACIONES_HOY: pickCotizacionResumenField(r, ['COTIZACIONES_HOY']),
  };
}

/** Importe cotización: misma base que ventas (cabecera IMPORTE_NETO / divisor IVA). */
function sqlCotiImporteExpr(alias = 'd') {
  return sqlVentaImporteBaseExpr(alias);
}

/** Sufijo SQL (AND …) para excluir cotizaciones con vigencia vencida SOLO si MICROSIP_COTIZACIONES_SOLO_VIGENTES=1.
 *  Por defecto no se filtra (paridad con Power BI / histórico del mes). MICROSIP_COTIZACIONES_INCLUIR_VENCIDAS=1 fuerza sin filtro. */
const cotizacionVigenciaCache = new Map();
const cotizacionVigenciaInFlight = new Map();
async function resolveCotizacionVigenciaSqlSuffix(dbo) {
  const key = `${dbCacheKey(dbo)}:cotiVig`;
  if (cotizacionVigenciaCache.has(key)) return cotizacionVigenciaCache.get(key);
  if (cotizacionVigenciaInFlight.has(key)) return cotizacionVigenciaInFlight.get(key);
  const p = (async () => {
    if ((process.env.MICROSIP_COTIZACIONES_INCLUIR_VENCIDAS || '').match(/^(1|true|yes)$/i)) {
      cotizacionVigenciaCache.set(key, '');
      return '';
    }
    if (!(process.env.MICROSIP_COTIZACIONES_SOLO_VIGENTES || '').match(/^(1|true|yes)$/i)) {
      cotizacionVigenciaCache.set(key, '');
      return '';
    }
    const cols = await getTableColumns('DOCTOS_VE', dbo).catch(() => new Set());
    const col = firstExistingColumn(cols, ['FECHA_VENCIMIENTO', 'FECHA_VIGENCIA', 'FECHA_VALIDA', 'FECHA_CADUCIDAD']);
    const suffix = col ? ` AND (d.${col} IS NULL OR CAST(d.${col} AS DATE) >= CURRENT_DATE)` : '';
    cotizacionVigenciaCache.set(key, suffix);

    return suffix;
  })().finally(() => {
    cotizacionVigenciaInFlight.delete(key);
  });
  cotizacionVigenciaInFlight.set(key, p);
  return p;
}

/** Fecha de cabecera VE/PV: COALESCE(FECHA, FECHA_DOCUMENTO) si existen ambas (cotizaciones a veces solo documentan una). */
const doctosHeaderFechaCache = new Map();
async function resolveDoctosHeaderFechaSqlPair(dbo) {
  const key = `${dbCacheKey(dbo)}:docHdrFe`;
  if (doctosHeaderFechaCache.has(key)) return doctosHeaderFechaCache.get(key);
  const [veCols, pvCols] = await Promise.all([
    getTableColumns('DOCTOS_VE', dbo),
    getTableColumns('DOCTOS_PV', dbo),
  ]);
  const expr = (cols) => {
    const fe = firstExistingColumn(cols, ['FECHA']);
    const fd = firstExistingColumn(cols, ['FECHA_DOCUMENTO']);
    if (fe && fd) return `COALESCE(d.${fe}, d.${fd})`;
    return `d.${fe || fd || 'FECHA'}`;
  };
  const out = { ve: expr(veCols), pv: expr(pvCols) };
  doctosHeaderFechaCache.set(key, out);
  return out;
}

async function cotizacionSqlOpts(dbo) {
  const [fePair, cotiEw] = await Promise.all([
    resolveDoctosHeaderFechaSqlPair(dbo),
    resolveCotizacionVigenciaSqlSuffix(dbo),
  ]);
  return {
    vigenciaVeSuffix: cotiEw,
    sqlFeVe: fePair.ve,
    sqlFePv: fePair.pv,
  };
}

/** Cache por base: columnas reales en DOCTOS_* (FECHA vs FECHA_DOCUMENTO, UNIDADES vs CANTIDAD). */
const consumosSchemaCache = new Map();
const consumosSchemaInFlight = new Map();

/**
 * Resuelve columnas de fecha en cabecera y cantidad en renglón (variantes Microsip).
 * Si se usa FECHA_DOCUMENTO o CANTIDAD incorrectamente, la query falla y los KPIs quedan en 0.
 */
async function resolveConsumosSchema(dbo) {
  const key = dbCacheKey(dbo) + ':v3amt';
  if (consumosSchemaCache.has(key)) return consumosSchemaCache.get(key);
  // Deduplication: share in-flight promise across concurrent callers (prevents N×4 DB queries on cold start)
  if (consumosSchemaInFlight.has(key)) return consumosSchemaInFlight.get(key);
  const p = Promise.all([
    getTableColumns('DOCTOS_VE', dbo),
    getTableColumns('DOCTOS_PV', dbo),
    getTableColumns('DOCTOS_VE_DET', dbo),
    getTableColumns('DOCTOS_PV_DET', dbo),
  ]).then(([veCols, pvCols, veDetCols, pvDetCols]) => {
    const fv = firstExistingColumn(veCols, ['FECHA', 'FECHA_DOCUMENTO']) || 'FECHA';
    const fp = firstExistingColumn(pvCols, ['FECHA', 'FECHA_DOCUMENTO']) || 'FECHA';
    const veQty = firstExistingColumn(veDetCols, ['UNIDADES', 'CANTIDAD']) || 'UNIDADES';
    const pvQty = firstExistingColumn(pvDetCols, ['UNIDADES', 'CANTIDAD']) || 'UNIDADES';
    const amtCandidates = ['PRECIO_TOTAL', 'IMPORTE', 'IMPORTE_TOTAL', 'SUBTOTAL', 'TOTAL_LINEA', 'IMPORTE_LINEA', 'IMPORTE_NETO', 'TOTAL', 'NETO', 'PRECIO_TOTAL_NETO', 'TOTAL_RENGLON', 'PRECIO_NETO'];
    const veAmt = firstExistingColumn(veDetCols, amtCandidates);
    const pvAmt = firstExistingColumn(pvDetCols, amtCandidates);
    const out = {
      feExprVe: `d.${fv}`,
      feExprPv: `d.${fp}`,
      veQty,
      pvQty,
      veAmt,
      pvAmt,
    };

    // Only cache if schema detection actually worked (at least one table had columns)
    const schemaDetected = veCols.size > 0 || pvCols.size > 0 || veDetCols.size > 0 || pvDetCols.size > 0;
    if (schemaDetected) {
      consumosSchemaCache.set(key, out);
    }
    return out;
  }).finally(() => {
    consumosSchemaInFlight.delete(key);
  });
  consumosSchemaInFlight.set(key, p);
  return p;
}

/**
 * Subconsulta de consumo por unidades vendidas (VE + PV)
 * tipo: 'VE' | 'PV' | '' (ambos)
 * parts: salida de resolveConsumosSchema(dbo)
 *
 * Por defecto el WHERE de cabecera coincide con /api/ventas/margen-articulos (DOCTOS_VE+DET con F/V/R),
 * que en producción sí devuelve renglones. El criterio ventasSub() (APLICADO='S', solo F) es más estricto
 * y en muchas bases deja consumo/sin-movimiento en cero — activar con MICROSIP_CONSUMOS_FILTRO_VENTAS_SUB=1.
 */
function consumosSubSql(tipo = '', parts) {
  const p = parts || {};
  const feVe = p.feExprVe || 'd.FECHA';
  const fePv = p.feExprPv || 'd.FECHA';
  const veQty = p.veQty || 'UNIDADES';
  const pvQty = p.pvQty || 'UNIDADES';
  const veImp = p.veAmt ? `COALESCE(det.${p.veAmt}, 0)` : '0';
  const pvImp = p.pvAmt ? `COALESCE(det.${p.pvAmt}, 0)` : '0';
  const strictVentas = (process.env.MICROSIP_CONSUMOS_FILTRO_VENTAS_SUB || '').match(/^(1|true|yes)$/i);
  const inclRem = (process.env.MICROSIP_CONSUMOS_INCLUYE_REMISIONES || '').match(/^(1|true|yes)$/i);
  const tiposDoc = inclRem ? "('V', 'F')" : "('F')";
  const veDocWhere = strictVentas
    ? `(
      d.TIPO_DOCTO IN ${tiposDoc}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`
    : `(
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    )`;
  const pvDocWhere = strictVentas
    ? `(
      d.TIPO_DOCTO IN ${tiposDoc}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`
    : `(
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    )`;
  // Proyectar siempre CAST(... AS DATE) AS FECHA para que buildFiltros y KPIs usen d.FECHA en el exterior.
  const ve = `
    SELECT
      CAST(${feVe} AS DATE) AS FECHA,
      COALESCE(det.${veQty}, 0) AS UNIDADES,
      ${veImp} AS IMPORTE_LINEA,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE ${veDocWhere}`;

  const pv = `
    SELECT
      CAST(${fePv} AS DATE) AS FECHA,
      COALESCE(det.${pvQty}, 0) AS UNIDADES,
      ${pvImp} AS IMPORTE_LINEA,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
    WHERE ${pvDocWhere}`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

/**
 * Variante "pushdown": genera subquery de consumo con filtro de fecha ADENTRO del SQL
 * para que Firebird use mejor índices (evita escaneo completo cuando el filtro está fuera).
 *
 * limitDays: N días hacia atrás desde CURRENT_DATE (p. ej. 180 o 400)
 * tipo: 'VE' | 'PV' | '' (ambos)
 */
function consumosSubSqlWithLookback(tipo = '', parts, limitDays) {
  const p = parts || {};
  const feVe = p.feExprVe || 'd.FECHA';
  const fePv = p.feExprPv || 'd.FECHA';
  const veQty = p.veQty || 'UNIDADES';
  const pvQty = p.pvQty || 'UNIDADES';
  const veImp = p.veAmt ? `COALESCE(det.${p.veAmt}, 0)` : '0';
  const pvImp = p.pvAmt ? `COALESCE(det.${p.pvAmt}, 0)` : '0';
  const strictVentas = (process.env.MICROSIP_CONSUMOS_FILTRO_VENTAS_SUB || '').match(/^(1|true|yes)$/i);
  const inclRem = (process.env.MICROSIP_CONSUMOS_INCLUYE_REMISIONES || '').match(/^(1|true|yes)$/i);
  const tiposDoc = inclRem ? "('V', 'F')" : "('F')";
  const veDocWhere = strictVentas
    ? `(
      d.TIPO_DOCTO IN ${tiposDoc}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`
    : `(
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    )`;
  const pvDocWhere = strictVentas
    ? `(
      d.TIPO_DOCTO IN ${tiposDoc}
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    )`
    : `(
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C','T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    )`;

  const days = Math.max(1, parseInt(limitDays, 10) || 1);
  const ve = `
    SELECT
      CAST(${feVe} AS DATE) AS FECHA,
      COALESCE(det.${veQty}, 0) AS UNIDADES,
      ${veImp} AS IMPORTE_LINEA,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE ${veDocWhere}
      AND ${feVe} >= (CURRENT_DATE - ${days})`;

  const pv = `
    SELECT
      CAST(${fePv} AS DATE) AS FECHA,
      COALESCE(det.${pvQty}, 0) AS UNIDADES,
      ${pvImp} AS IMPORTE_LINEA,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      COALESCE(det.ARTICULO_ID, 0) AS ARTICULO_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
    WHERE ${pvDocWhere}
      AND ${fePv} >= (CURRENT_DATE - ${days})`;

  if (tipo === 'VE') return `(${ve})`;
  if (tipo === 'PV') return `(${pv})`;
  return `(${ve} UNION ALL ${pv})`;
}

// ── Filtro de tipo de ventas desde request ────────────────────────────────────
function getTipo(req) {
  const t = (req.query.tipo || '').toUpperCase();
  return t === 'VE' ? 'VE' : t === 'PV' ? 'PV' : '';
}

/** Cotizaciones: por defecto siempre VE+PV (evita $0 si el panel está en un solo módulo). MICROSIP_COTIZACIONES_RESPETAR_TIPO_PANEL=1 para acatar `tipo`. */
function getCotizacionesTipo(req) {
  const scope = String(req.query.cotizaciones_scope || req.query.coti_scope || '').toLowerCase();
  if (scope === 'todos' || scope === 'all' || scope === '1') return '';
  if ((process.env.MICROSIP_COTIZACIONES_RESPETAR_TIPO_PANEL || '').match(/^(1|true|yes)$/i)) return getTipo(req);
  return '';
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
// Excluir contado/inmediato de CxC por requerimiento operativo.
const CXC_EXCLUIR_CONTADO = ` AND (
  cp.COND_PAGO_ID IS NULL OR (
    POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('PREPAGO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('ANTICIPO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('CONTRA ENTREGA' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
    AND POSITION('AL CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
  )
) `;
const CXC_EXCLUIR_CONTADO_SUB = ` AND (
  cp2.COND_PAGO_ID IS NULL OR (
    POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('PREPAGO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('ANTICIPO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('CONTRA ENTREGA' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
    AND POSITION('AL CONTADO' IN UPPER(COALESCE(TRIM(cp2.NOMBRE), ''))) = 0
  )
) `;
/** Condición de pago tipo contado / inmediato: no debe computar atraso ni buckets de morosidad. */
const CXC_SQL_ES_CONTADO = `(
      POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
      OR POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
      OR POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0
    )`;
/** Días desde FECHA_EMISION hasta vencimiento si no hay fila en VENCIMIENTOS_CARGOS_CC.
 *  Microsip a veces deja DIAS_PPAG=0 pero el nombre sigue siendo "30 DIAS" → antes vencía el mismo día y el atraso quedaba absurdo vs Power BI.
 *  Solo usamos 0 días si el nombre es contado/efectivo/inmediato (rama arriba en CASE o exclusión CXC_EXCLUIR_CONTADO). */
const CXC_DIAS_SUM_INT = `CAST((
      CASE
        WHEN POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0 THEN 0
        WHEN POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0 THEN 0
        WHEN POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) > 0 THEN 0
        WHEN COALESCE(cp.DIAS_PPAG, 0) > 0 THEN cp.DIAS_PPAG
        ELSE 30
      END
    ) AS INTEGER)`;
function cxcClienteSQL() {
  return `(
    SELECT
      dc_cargo.CLIENTE_ID,
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
    JOIN DOCTOS_CC dc_cargo ON dc_cargo.DOCTO_CC_ID = CASE
      WHEN i.TIPO_IMPTE = 'R' AND i.DOCTO_CC_ACR_ID IS NOT NULL THEN i.DOCTO_CC_ACR_ID
      ELSE i.DOCTO_CC_ID
    END
    LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc_cargo.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc_cargo.COND_PAGO_ID, clx.COND_PAGO_ID)
    WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO}
    GROUP BY dc_cargo.CLIENTE_ID
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
// Vencimiento = FECHA_CARGO + DIAS_PPAG (condición de pago). Sin VENCIMIENTOS_CARGOS_CC:
// esa tabla almacena fechas renegociadas/extendidas que hacen que todo aparezca como CORRIENTE.
// El cálculo coincide con Power BI: vencimiento = fecha de emisión + días de crédito.
function cxcCargosSQL() {
  return `(
    SELECT
      i.DOCTO_CC_ID,
      dc.CLIENTE_ID,
      dc.FOLIO,
      i.IMPORTE                                                       AS SALDO,
      CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}                   AS FECHA_VENCIMIENTO,
      CASE
        WHEN ${CXC_SQL_ES_CONTADO} THEN 0
        ELSE (CURRENT_DATE - (CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}))
      END                                                             AS DIAS_VENCIDO
    FROM IMPORTES_DOCTOS_CC i
    JOIN  DOCTOS_CC dc         ON dc.DOCTO_CC_ID  = i.DOCTO_CC_ID
    LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
    WHERE i.TIPO_IMPTE = 'C'
      AND COALESCE(i.CANCELADO, 'N') = 'N'
      AND COALESCE(dc.ESTATUS, 'A') NOT IN ('C') ${CXC_EXCLUIR_CONTADO}
      AND dc.CLIENTE_ID IN (
        SELECT cs.CLIENTE_ID
        FROM ${cxcClienteSQL()} cs
      )
  )`;
}

// Deprecated — mantener para compatibilidad pero los endpoints usan cxcClienteSQL/cxcCargosSQL
function cxcSaldosSub() { return cxcCargosSQL(); }

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG / METAS  — ideal = +30% sobre meta diaria (Power BI / DAX)
// ═══════════════════════════════════════════════════════════════════════════════

const metasCache = new Map();
/** Cache corto por base (+ cliente opcional) para /api/cxc/resumen-aging: evita martillar Firebird con 6 queries en cada refresh del tablero. TTL env MICROSIP_CXC_SNAPSHOT_CACHE_MS (default 12000 ms; 0 = desactivar). ?nocache=1 fuerza recálculo. */
const cxcResumenAgingSnapCache = new Map();

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

  const META_DIA_V   = 5650;
  const META_IDEAL_V = 5650 * 1.30;
  const META_DIA_C   = 10000;
  const META_IDEAL_C = 10000 * 1.30;

  const payload = {
    META_DIARIA_POR_VENDEDOR : META_DIA_V,
    META_IDEAL_POR_VENDEDOR  : META_IDEAL_V,
    META_COTI_POR_VENDEDOR   : META_DIA_C,
    META_COTI_IDEAL          : META_IDEAL_C,
    META_TOTAL_DIARIA        : META_DIA_V   * numV,
    META_IDEAL_TOTAL         : META_IDEAL_V * numV,
    META_COTI_TOTAL          : META_DIA_C   * numV,
    META_COTI_IDEAL_TOTAL    : META_IDEAL_C * numV,
    NUM_VENDEDORES           : numV,
    NUM_VENDEDORES_ACTIVOS   : numVActivos,
    NUM_VENDEDORES_CON_VENTA : numVConVenta,
    MARGEN_COMISION          : 0.08,
  };

  metasCache.set(dbKey, { expireAt: Date.now() + 60 * 1000, payload });
  return payload;
});

get('/api/config/filtros', async (req) => {
  const dbo = getReqDbOpts(req);
  const [vendedores, clientes, anios] = await Promise.all([
    query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`, [], 30000, dbo)
      .catch(() => query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES ORDER BY NOMBRE`, [], 30000, dbo)),
    query(`
      SELECT FIRST 500 d.CLIENTE_ID, c.NOMBRE
      FROM (
        SELECT DISTINCT CLIENTE_ID FROM DOCTOS_VE
        WHERE ((TIPO_DOCTO='F' AND ESTATUS<>'C') OR (TIPO_DOCTO='V' AND ESTATUS NOT IN ('C','T')))
          AND FECHA >= (CURRENT_DATE - 365)
      ) d
      JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
      ORDER BY c.NOMBRE
    `, [], 30000, dbo),
    query(`
      SELECT DISTINCT EXTRACT(YEAR FROM FECHA) AS ANIO
      FROM DOCTOS_VE
      WHERE (TIPO_DOCTO='F' OR TIPO_DOCTO='V') AND ESTATUS <> 'C'
      ORDER BY ANIO DESC
    `, [], 30000, dbo),
  ]);
  return { vendedores, clientes, anios };
});
// ═══════════════════════════════════════════════════════════
//  VENTAS — RESÚMENES
// ═══════════════════════════════════════════════════════════

// Ventas del periodo: HOY = venta del d\u00eda actual; MES_ACTUAL = total del periodo filtrado (anio/mes o desde-hasta) para que cuadre con Power BI.
get('/api/ventas/resumen', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const run = async (dbo) => {
    const f = buildFiltros(req, 'd');
    const tipo = getTipo(req);
    const [rows, remRows] = await Promise.all([
      query(`
    SELECT
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE
               THEN d.IMPORTE_NETO ELSE 0 END)                      AS HOY,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE
               THEN d.IMPORTE_NETO_BRUTO ELSE 0 END)               AS HOY_IVA,
      COALESCE(SUM(d.IMPORTE_NETO), 0)                              AS MES_ACTUAL,
      COALESCE(SUM(d.IMPORTE_NETO_BRUTO), 0)                       AS MES_ACTUAL_IVA,
      COUNT(*)                                                      AS FACTURAS_MES,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) < CURRENT_DATE
               THEN d.IMPORTE_NETO ELSE 0 END)                     AS HASTA_AYER_MES
    FROM ${ventasSub(tipo)} d
    WHERE 1=1 ${f.sql}
  `, f.params, 30000, dbo).catch(() => []),
      query(`
    SELECT
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS REMISIONES_HOY,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO_BRUTO ELSE 0 END) AS REMISIONES_HOY_IVA,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS REMISIONES_MES,
      COALESCE(SUM(d.IMPORTE_NETO_BRUTO), 0) AS REMISIONES_MES_IVA
    FROM ${remisionesSub(tipo)} d
    WHERE 1=1 ${f.sql}
  `, f.params, 30000, dbo).catch(() => []),
    ]);
    const out = {
      HOY: +((rows[0] && rows[0].HOY) || 0),
      HOY_IVA: +((rows[0] && rows[0].HOY_IVA) || 0),
      MES_ACTUAL: +((rows[0] && rows[0].MES_ACTUAL) || 0),
      MES_ACTUAL_IVA: +((rows[0] && rows[0].MES_ACTUAL_IVA) || 0),
      FACTURAS_MES: +((rows[0] && rows[0].FACTURAS_MES) || 0),
      HASTA_AYER_MES: +((rows[0] && rows[0].HASTA_AYER_MES) || 0),
    };
    const rem = remRows[0] || {};
    out.REMISIONES_HOY = +(rem.REMISIONES_HOY || 0);
    out.REMISIONES_MES = +(rem.REMISIONES_MES || 0);
    out.REMISIONES_HOY_IVA = +(rem.REMISIONES_HOY_IVA || 0);
    out.REMISIONES_MES_IVA = +(rem.REMISIONES_MES_IVA || 0);
    return out;
  };
  if (isAllDbs(req)) {
    const outs = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return { HOY: 0, MES_ACTUAL: 0, FACTURAS_MES: 0, HASTA_AYER_MES: 0, REMISIONES_HOY: 0, REMISIONES_MES: 0 };
      }
    });
    return mergeVentasResumen(outs);
  }
  return run(getReqDbOpts(req));
});

// Cotizaciones: rango de fechas explícito (primer/último día del mes) para que Firebird use índice y no escanee toda la tabla.
function lastDayOfMonth(y, m) {
  const d = new Date(y, m, 0); // m 1-12
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Express puede entregar query duplicada como array; tomar el primer valor. */
function firstQueryVal(q) {
  if (q == null) return null;
  if (Array.isArray(q)) return q.length ? String(q[0]).trim() : null;
  return String(q).trim();
}

/** Normaliza fecha de fila Firebird/driver a YYYY-MM-DD (node-firebird suele usar Date; a veces objeto o string). */
function sqlRowDateToIso(v) {
  if (v == null || v === '') return null;
  try {
    if (v instanceof Date && !isNaN(v.getTime())) {
      return (
        v.getFullYear() +
        '-' +
        String(v.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(v.getDate()).padStart(2, '0')
      );
    }
    if (typeof v === 'object' && v !== null && !(v instanceof Buffer)) {
      const y = +(v.year != null ? v.year : v.YEAR);
      const mo = +(v.month != null ? v.month : v.MONTH);
      const da = +(v.day != null ? v.day : v.DAY != null ? v.DAY : v.date);
      if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(da) && mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
        return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
      }
    }
  } catch (_) {}
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }
  return null;
}
get('/api/ventas/cotizaciones/resumen', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const run = async (dbo) => {
    // Optimización: si el filtro viene como anio+mes (sin rango), materializarlo a desde/hasta
    // para que Firebird use índice de FECHA y evitar escaneo con EXTRACT() en tablas grandes.
    if (!req.query.desde && !req.query.hasta && req.query.anio && req.query.mes) {
      const y = parseInt(String(req.query.anio || ''), 10);
      const m = parseInt(String(req.query.mes || ''), 10);
      if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
        req.query.desde = `${y}-${String(m).padStart(2, '0')}-01`;
        req.query.hasta = lastDayOfMonth(y, m);
      }
    }
    // Evitar UNION y ligas PV en resumen: consultar VE y PV por separado y sumar.
    // PV puede ser muy pesado (ver timeouts en /api/debug/cotizaciones-tipos); VE suele responder rápido.
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const imp = sqlCotiImporteExpr('d'); // cabecera
    const wVe = sqlWhereCotizacionComoVenta('d', 'VE');
    const wPv = sqlWhereCotizacionComoVenta('d', 'PV');
    const feVe = cotiOpts.sqlFeVe || 'd.FECHA';
    const fePv = cotiOpts.sqlFePv || 'd.FECHA';
    const fVe = buildFiltros(req, 'd', { fechaExpr: feVe });
    const fPv = buildFiltros(req, 'd', { fechaExpr: fePv });

    const veSql = `
      SELECT
        SUM(CASE WHEN CAST(${feVe} AS DATE) = CURRENT_DATE THEN ${imp} ELSE 0 END) AS HOY,
        COALESCE(SUM(${imp}), 0) AS MES_ACTUAL,
        COUNT(*) AS COTIZACIONES_MES,
        COUNT(CASE WHEN CAST(${feVe} AS DATE) = CURRENT_DATE THEN 1 END) AS COTIZACIONES_HOY
      FROM DOCTOS_VE d
      WHERE 1=1 ${fVe.sql} AND (${wVe})${String(cotiOpts.vigenciaVeSuffix || '')}
    `;
    const pvSql = `
      SELECT
        SUM(CASE WHEN CAST(${fePv} AS DATE) = CURRENT_DATE THEN ${imp} ELSE 0 END) AS HOY,
        COALESCE(SUM(${imp}), 0) AS MES_ACTUAL,
        COUNT(*) AS COTIZACIONES_MES,
        COUNT(CASE WHEN CAST(${fePv} AS DATE) = CURRENT_DATE THEN 1 END) AS COTIZACIONES_HOY
      FROM DOCTOS_PV d
      WHERE 1=1 ${fPv.sql} AND (${wPv})
    `;

    const cotiResumenMs = 240000;
    const [veRows, pvRows] = await Promise.all([
      query(veSql, fVe.params, cotiResumenMs, dbo).catch((err) => {
        console.error('[cotizaciones/resumen][VE]', err && (err.message || err));
        return [];
      }),
      query(pvSql, fPv.params, cotiResumenMs, dbo).catch((err) => {
        console.error('[cotizaciones/resumen][PV]', err && (err.message || err));
        return [];
      }),
    ]);

    const ve = normalizeCotizacionResumenRow(veRows[0]);
    const pv = normalizeCotizacionResumenRow(pvRows[0]);
    return mergeCotizacionResumenRows([ve, pv]);
  };
  if (isAllDbs(req)) {
    const rows = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return { HOY: 0, MES_ACTUAL: 0, COTIZACIONES_MES: 0, COTIZACIONES_HOY: 0 };
      }
    });
    return mergeCotizacionResumenRows(rows);
  }
  return run(getReqDbOpts(req));
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
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO_BRUTO ELSE 0 END), 0) AS VENTAS_VE_IVA,
      COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO_BRUTO ELSE 0 END), 0) AS VENTAS_PV_IVA,
      COALESCE(SUM(d.IMPORTE_NETO_BRUTO), 0) AS TOTAL_VENTAS_IVA
    FROM ${ventasSub()} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `
    : `
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS FACTURAS,
      COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_VENTAS,
      COALESCE(SUM(d.IMPORTE_NETO_BRUTO), 0) AS TOTAL_VENTAS_IVA
    FROM ${ventasSub(tipo)} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
    `;
  const run = async (dbo) => {
    const rows = await query(sql, [desdeStr], 12000, dbo).catch(() => []);
    if (tipo !== '') {
      return (rows || []).map(r => ({
        DIA: r.DIA,
        VENTAS_VE: tipo === 'VE' ? (r.TOTAL_VENTAS || 0) : 0,
        VENTAS_PV: tipo === 'PV' ? (r.TOTAL_VENTAS || 0) : 0,
        TOTAL_VENTAS: r.TOTAL_VENTAS || 0,
        VENTAS_VE_IVA: tipo === 'VE' ? (r.TOTAL_VENTAS_IVA || 0) : 0,
        VENTAS_PV_IVA: tipo === 'PV' ? (r.TOTAL_VENTAS_IVA || 0) : 0,
        TOTAL_VENTAS_IVA: r.TOTAL_VENTAS_IVA || 0,
      }));
    }
    return rows || [];
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeDiariasVentas(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const run = async (dbo) => query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 30000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeSemanalesVentas(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/mensuales', async (req) => {
  const mesesN = Math.min(Math.max(parseInt(req.query.meses) || 12, 1), 24);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - mesesN);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-01';
  const f = { sql: ' AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)', params: [desdeStr] };
  const tipo = getTipo(req);
  const run = async (dbo) => {
    if (tipo === '') {
      const rows = await query(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COUNT(*) AS FACTURAS,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL
      FROM ${ventasSub()} d WHERE 1=1 ${f.sql}
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, f.params, 30000, dbo).catch(() => []);
      return (rows || []).map(r => ({
        ANIO: r.ANIO,
        MES: r.MES,
        FACTURAS: r.FACTURAS,
        VENTAS_VE: r.VENTAS_VE,
        VENTAS_PV: r.VENTAS_PV,
        TOTAL: r.TOTAL,
      }));
    }
    const rows = await query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 30000, dbo).catch(() => []);
    return (rows || []).map(r => ({
      ANIO: r.ANIO,
      MES: r.MES,
      FACTURAS: r.FACTURAS,
      VENTAS_VE: tipo === 'VE' ? r.TOTAL : 0,
      VENTAS_PV: tipo === 'PV' ? r.TOTAL : 0,
      TOTAL: r.TOTAL,
    }));
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeMensualesVentas(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/cotizaciones/diarias', async (req) => {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let qDesde = firstQueryVal(req.query.desde);
  let qHasta = firstQueryVal(req.query.hasta);
  if (qDesde && !reDate.test(String(qDesde))) qDesde = null;
  if (qHasta && !reDate.test(String(qHasta))) qHasta = null;

  let fechaWhere = 'CAST(d.FECHA AS DATE) >= CAST(? AS DATE)';
  let fechaParams = [];

  if (qDesde && qHasta) {
    let d0 = new Date(String(qDesde) + 'T12:00:00');
    let d1 = new Date(String(qHasta) + 'T12:00:00');
    if (!isNaN(d0.getTime()) && !isNaN(d1.getTime())) {
      if (d1 < d0) {
        const t = d0;
        d0 = d1;
        d1 = t;
      }
      const spanDays = Math.ceil((d1 - d0) / 86400000) + 1;
      if (spanDays > 366) {
        d0 = new Date(d1);
        d0.setDate(d0.getDate() - 365);
      }
      const fmt = (dt) =>
        dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      fechaWhere = 'CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)';
      fechaParams = [fmt(d0), fmt(d1)];
    }
  }

  // Mismo corte que resumen/cotizaciones cuando el filtro es anio+mes (Este mes, etc.), sin desde/hasta en la URL.
  if (!fechaParams.length) {
    const y = parseInt(String(firstQueryVal(req.query.anio) || ''), 10);
    const m = parseInt(String(firstQueryVal(req.query.mes) || ''), 10);
    if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
      fechaWhere = 'CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)';
      fechaParams = [`${y}-${String(m).padStart(2, '0')}-01`, lastDayOfMonth(y, m)];
    }
  }

  if (!fechaParams.length) {
    const dias = Math.min(parseInt(String(req.query.dias || '30'), 10) || 30, 366);
    const desde = new Date();
    desde.setDate(desde.getDate() - dias);
    const desdeStr =
      desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
    fechaParams = [desdeStr];
  }

  let queryMs = 180000;
  if (fechaParams.length === 2) {
    const dA = new Date(String(fechaParams[0]) + 'T12:00:00');
    const dB = new Date(String(fechaParams[1]) + 'T12:00:00');
    if (!isNaN(dA.getTime()) && !isNaN(dB.getTime())) {
      const span = Math.abs(Math.ceil((dB - dA) / 86400000)) + 1;
      if (span > 62) queryMs = 240000;
    }
  }

  const vid = req.query.vendedor ? parseInt(String(firstQueryVal(req.query.vendedor) || ''), 10) : NaN;
  const cid = req.query.cliente ? parseInt(String(firstQueryVal(req.query.cliente) || ''), 10) : NaN;
  let vcSql = '';
  const sqlParams = [...fechaParams];
  if (Number.isFinite(vid) && vid > 0) {
    vcSql += ' AND d.VENDEDOR_ID = ?';
    sqlParams.push(vid);
  }
  if (Number.isFinite(cid) && cid > 0) {
    vcSql += ' AND d.CLIENTE_ID = ?';
    sqlParams.push(cid);
  }

  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const ci = sqlCotiImporteExpr('d');
    const tipoPanel = getCotizacionesTipo(req);
    const innerBd =
      fechaParams.length === 2
        ? { desde: fechaParams[0], hasta: fechaParams[1] }
        : fechaParams.length === 1
          ? { desde: fechaParams[0] }
          : null;
    const qSub = (sub) =>
      query(
        `
    SELECT CAST(d.FECHA AS DATE) AS DIA, COUNT(*) AS COTIZACIONES, COALESCE(SUM(${ci}),0) AS TOTAL_COTIZACIONES
    FROM ${sub} d
    WHERE ${fechaWhere}${vcSql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `,
        sqlParams,
        queryMs,
        dbo,
      ).catch((err) => {
        console.error('[cotizaciones/diarias]', err && (err.message || err));
        return [];
      });
    let rows;
    if (tipoPanel === 'VE' || tipoPanel === 'PV') {
      rows = await qSub(cotizacionesSub(tipoPanel, cotiOpts, innerBd));
    } else {
      const [ve, pv] = await Promise.all([
        qSub(cotizacionesSub('VE', cotiOpts, innerBd)),
        qSub(cotizacionesSub('PV', cotiOpts, innerBd)),
      ]);
      rows = mergeDiariasCotizVePv(ve, pv);
    }
    // No filtrar filas: si sqlRowDateToIso falla, conservar DIA crudo (Express serializa Date → ISO).
    return (rows || []).map((r) => {
      const iso = sqlRowDateToIso(r.DIA);
      return {
        DIA: iso != null ? iso : r.DIA,
        COTIZACIONES: +(r.COTIZACIONES || 0),
        TOTAL_COTIZACIONES: +(r.TOTAL_COTIZACIONES || 0) || 0,
      };
    });
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeDiariasCotiz(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/cotizaciones/semanales', async (req) => {
  const f = buildFiltros(req, 'd');
  const innerBd = cotizQueryIsoBounds(req);
  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const cotiSub = cotizacionesSub(getCotizacionesTipo(req), cotiOpts, innerBd);
    const ci = sqlCotiImporteExpr('d');
    return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(WEEK FROM d.FECHA) AS SEMANA,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(${ci}),0) AS TOTAL
    FROM ${cotiSub} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(WEEK FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 90000, dbo).catch(() => []);
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeSemanalesCotiz(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/cotizaciones/mensuales', async (req) => {
  const f = buildFiltros(req, 'd');
  const innerBd = cotizQueryIsoBounds(req);
  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const cotiSub = cotizacionesSub(getCotizacionesTipo(req), cotiOpts, innerBd);
    const ci = sqlCotiImporteExpr('d');
    return query(`
    SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COUNT(*) AS COTIZACIONES, COALESCE(SUM(${ci}),0) AS TOTAL
    FROM ${cotiSub} d WHERE 1=1 ${f.sql}
    GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
  `, f.params, 90000, dbo).catch(() => []);
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeMensualesCotiz(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/top-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const run = async (dbo) => query(`
    SELECT FIRST ${limit}
      d.CLIENTE_ID, c.NOMBRE AS CLIENTE, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY TOTAL DESC
  `, f.params, 30000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeTopClientes(lists, limit);
  }
  return run(getReqDbOpts(req));
});

// ventas (4).html y vendedores esperan: VENDEDOR, VENTAS_HOY, VENTAS_MES, VENTAS_MES_VE, VENTAS_MES_PV, FACTURAS_HOY, FACTURAS_MES
get('/api/ventas/por-vendedor', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const run = async (dbo) => query(`
    SELECT
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      CASE
        WHEN COALESCE(d.VENDEDOR_ID, 0) <= 0 THEN 'No asignado'
        ELSE COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10)))
      END AS VENDEDOR,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_HOY,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) AND d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES_VE,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) AND d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END) AS VENTAS_MES_PV,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub(tipo)} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE) AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE) ${f.sql}
    GROUP BY
      COALESCE(d.VENDEDOR_ID, 0),
      CASE
        WHEN COALESCE(d.VENDEDOR_ID, 0) <= 0 THEN 'No asignado'
        ELSE COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10)))
      END
    ORDER BY VENTAS_MES DESC
  `, f.params, 30000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergePorVendedorVentas(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/por-vendedor/cotizaciones', async (req) => {
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const innerBd = cotizQueryIsoBounds(req);
  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const ci = sqlCotiImporteExpr('d');
    const t = 240000;
    const tipoPanel = getCotizacionesTipo(req);
    const qSub = (sub) =>
      query(
        `
    SELECT
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      CASE WHEN COALESCE(d.VENDEDOR_ID, 0) = 0 THEN 'No asignado'
           ELSE COALESCE(MAX(v.NOMBRE), 'Vendedor ' || CAST(COALESCE(d.VENDEDOR_ID, 0) AS VARCHAR(12)))
      END AS VENDEDOR,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN ${ci} ELSE 0 END) AS COTIZACIONES_HOY,
      COALESCE(SUM(${ci}), 0) AS COTIZACIONES_MES,
      COUNT(*) AS NUM_COTI_MES
    FROM ${sub} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE 1=1 ${f.sql}
    GROUP BY COALESCE(d.VENDEDOR_ID, 0)
    ORDER BY COTIZACIONES_MES DESC
  `,
        f.params,
        t,
        dbo,
      ).catch((err) => {
        console.error('[por-vendedor/cotizaciones]', err && (err.message || err));
        return [];
      });
    if (tipoPanel === 'VE' || tipoPanel === 'PV') {
      return qSub(cotizacionesSub(tipoPanel, cotiOpts, innerBd));
    }
    const [ve, pv] = await Promise.all([
      qSub(cotizacionesSub('VE', cotiOpts, innerBd)),
      qSub(cotizacionesSub('PV', cotiOpts, innerBd)),
    ]);
    return mergePorVendedorCotizVePv(ve, pv);
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergePorVendedorCotiz(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/recientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const run = async (dbo) => query(`
    SELECT FIRST ${limit} d.FECHA, d.FOLIO, d.TIPO_DOCTO, d.TIPO_SRC, d.IMPORTE_NETO AS TOTAL, d.CLIENTE_ID,
      COALESCE(c.NOMBRE, 'Sin cliente') AS CLIENTE,
      COALESCE(v.NOMBRE, 'Sin vendedor') AS VENDEDOR
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE 1=1 ${f.sql}
    ORDER BY d.IMPORTE_NETO DESC, d.FECHA DESC, d.FOLIO DESC
  `, f.params, 30000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeRecientes(lists, limit);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/vs-cotizaciones', async (req) => {
  const mesesN = Math.min(parseInt(req.query.meses) || 6, 24);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - mesesN);
  const desdeStr = desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-01';
  const tipoVentas = getTipo(req);
  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const ci = sqlCotiImporteExpr('d');
    const tMs = 240000;
    const tipoPanel = getCotizacionesTipo(req);
    const qCotiSub = (sub) =>
      query(
        `
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        CAST(COALESCE(SUM(${ci}), 0) AS DOUBLE PRECISION) AS TOTAL_COTI, COUNT(*) AS NUM_COTI
      FROM ${sub} d
      WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `,
        [desdeStr],
        tMs,
        dbo,
      ).catch((err) => {
        console.error('[vs-cotizaciones cotiz]', err && (err.message || err));
        return [];
      });
    const innerVs = { desde: desdeStr };
    let cotizMes;
    if (tipoPanel === 'VE' || tipoPanel === 'PV') {
      cotizMes = await qCotiSub(cotizacionesSub(tipoPanel, cotiOpts, innerVs));
    } else {
      const [cve, cpv] = await Promise.all([
        qCotiSub(cotizacionesSub('VE', cotiOpts, innerVs)),
        qCotiSub(cotizacionesSub('PV', cotiOpts, innerVs)),
      ]);
      cotizMes = mergeVsCotizMesVePv(cve, cpv);
    }
    const ventasMes = await query(
      `
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        CAST(COALESCE(SUM(d.IMPORTE_NETO), 0) AS DOUBLE PRECISION) AS TOTAL_VENTAS, COUNT(*) AS NUM_DOCS
      FROM ${ventasSub(tipoVentas)} d WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `,
      [desdeStr],
      tMs,
      dbo,
    ).catch((err) => {
      console.error('[vs-cotizaciones ventas]', err && (err.message || err));
      return [];
    });
    return { ventas: ventasMes || [], cotizaciones: cotizMes || [] };
  };
  if (isAllDbs(req)) {
    const parts = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return { ventas: [], cotizaciones: [] };
      }
    });
    return mergeVsCotizaciones(parts);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/ranking-clientes', async (req) => {
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  const run = async (dbo) => query(`
    SELECT d.CLIENTE_ID, c.NOMBRE, COALESCE(SUM(d.IMPORTE_NETO),0) AS VENTA
    FROM ${ventasSub(tipo)} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    WHERE d.CLIENTE_ID > 0 ${f.sql}
    GROUP BY d.CLIENTE_ID, c.NOMBRE ORDER BY VENTA DESC
  `, f.params, 30000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeRankingClientes(lists);
  }
  return run(getReqDbOpts(req));
});

// Cobradas: ventas en periodo (d.FECHA) + cobro real por vendedor (IMPORTES_DOCTOS_CC tipo R). Fecha de periodo: COALESCE(i.FECHA, dc.FECHA) si i.FECHA viene nula.
get('/api/ventas/cobradas', async (req) => {
  const dbo = getReqDbOpts(req);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const vendedorReq = req.query.vendedor ? parseInt(req.query.vendedor, 10) : NaN;
  const reqNoVend = { ...req, query: { ...(req.query || {}) } };
  delete reqNoVend.query.vendedor;
  const fAll = buildFiltros(reqNoVend, 'd');
  const fiAll = filtrosImporteCobro(reqNoVend, 'i', { coalesceDcFecha: true });
  const tipo = getTipo(req);
  const tipoFac = sqlTipoFacLinkCc('fac', tipo);
  const vendedorAtribExpr = `COALESCE(
    ve.VENDEDOR_ID,
    (SELECT d2.VENDEDOR_ID
     FROM DOCTOS_PV_LIGAS liga
     JOIN DOCTOS_PV d2 ON d2.DOCTO_PV_ID = liga.DOCTO_PV_FTE_ID
     WHERE liga.DOCTO_PV_DEST_ID = pv.DOCTO_PV_ID
     ROWS 1),
    pv.VENDEDOR_ID,
    0
  )`;

  /** Cobros del periodo: total sin exigir enlace VE/PV (muchas bases no llenan DOCTO_* en CC). */
  const cobroSqlFull = `
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${fiAll.sql}`;
  /** Misma join que antes para atribuir por vendedor cuando sí hay factura ligada. */
  const cobroSqlAtrib = `
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    LEFT JOIN DOCTOS_CC fac ON fac.DOCTO_CC_ID = COALESCE(i.DOCTO_CC_ACR_ID, i.DOCTO_CC_ID)
    LEFT JOIN DOCTOS_VE ve ON ve.DOCTO_VE_ID = fac.DOCTO_VE_ID
    LEFT JOIN DOCTOS_PV pv ON pv.DOCTO_PV_ID = fac.DOCTO_PV_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = ${vendedorAtribExpr}
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${tipoFac} ${fiAll.sql}`;

  const [rows, cobroPorVend, cobrosRow, cobroLinkedRows] = await Promise.all([
    query(`
      SELECT d.VENDEDOR_ID, v.NOMBRE AS VENDEDOR, COUNT(DISTINCT d.FOLIO) AS NUM_FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL_VENTA
      FROM ${ventasSub(tipo)} d
      LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
      WHERE d.VENDEDOR_ID > 0 ${fAll.sql}
      GROUP BY d.VENDEDOR_ID, v.NOMBRE
    `, fAll.params, 12000, dbo).catch(() => []),
    query(`
      SELECT
        ${vendedorAtribExpr} AS VENDEDOR_ID,
        MAX(COALESCE(v.NOMBRE, '')) AS VENDEDOR,
        COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlAtrib}
      GROUP BY ${vendedorAtribExpr}
    `, fiAll.params, 12000, dbo).catch(() => []),
    query(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlFull}
    `, fiAll.params, 12000, dbo).catch(() => [{ TOTAL_COBRADO: 0 }]),
    query(`
      SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
      ${cobroSqlAtrib}
    `, fiAll.params, 12000, dbo).catch(() => [{ TOTAL_COBRADO: 0 }]),
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
  mapped.sort((a, b) => {
    const dc = (+b.TOTAL_COBRADO || 0) - (+a.TOTAL_COBRADO || 0);
    if (Math.abs(dc) > 0.0001) return dc;
    return (+b.TOTAL_VENTA || 0) - (+a.TOTAL_VENTA || 0);
  });
  let out = mapped;
  if (!isNaN(vendedorReq) && vendedorReq > 0) {
    out = mapped.filter(r => (+r.VENDEDOR_ID || 0) === vendedorReq);
  }
  const outFacturado = out.reduce((s, r) => s + (+r.TOTAL_VENTA || 0), 0);
  const outCobrado = out.reduce((s, r) => s + (+r.TOTAL_COBRADO || 0), 0);
  return { vendedores: out, totalFacturado: outFacturado, totalCobrado: outCobrado };
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
  const vendedorAtribExpr = `COALESCE(
    ve.VENDEDOR_ID,
    (SELECT d2.VENDEDOR_ID
     FROM DOCTOS_PV_LIGAS liga
     JOIN DOCTOS_PV d2 ON d2.DOCTO_PV_ID = liga.DOCTO_PV_FTE_ID
     WHERE liga.DOCTO_PV_DEST_ID = pv.DOCTO_PV_ID
     ROWS 1),
    pv.VENDEDOR_ID,
    0
  )`;
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
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = ${vendedorAtribExpr}
    WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N' ${fi.sql}
    ORDER BY MONTO_COBRADO DESC, COALESCE(i.FECHA, dc.FECHA) DESC, dc.FOLIO DESC
  `, fi.params, 15000, dbo).catch(err => { console.error('cobradas-detalle error:', err && (err.message || err)); return []; });
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
  const [veCols, pvCols, veDetCols, pvDetCols, inCols, inDetCols, artCols] = await Promise.all([
    getTableColumns('DOCTOS_VE', dbo),
    getTableColumns('DOCTOS_PV', dbo),
    getTableColumns('DOCTOS_VE_DET', dbo),
    getTableColumns('DOCTOS_PV_DET', dbo),
    getTableColumns('DOCTOS_IN', dbo),
    getTableColumns('DOCTOS_IN_DET', dbo),
    getTableColumns('ARTICULOS', dbo),
  ]);
  const inDetIdCol = firstExistingColumn(inDetCols, ['DOCTO_IN_DET_ID', 'RENGLON', 'POSICION']);
  const inCostoUnitCol = firstExistingColumn(inDetCols, ['COSTO_UNITARIO', 'COSTO_U']);
  const inCostoTotalCol = firstExistingColumn(inDetCols, ['COSTO_TOTAL', 'IMPORTE']);
  const inQtyCol = firstExistingColumn(inDetCols, ['CANTIDAD', 'UNIDADES']);
  const inClaveCol = firstExistingColumn(inDetCols, ['CLAVE_ARTICULO']);
  const inHasCancel = inCols.has('CANCELADO');
  const inHasAplicado = inCols.has('APLICADO');
  const inHasFecha = inCols.has('FECHA');

  const doDocOk = (hdrCols) => {
    const conds = [];
    if (hdrCols.has('TIPO_DOCTO')) conds.push(`d.TIPO_DOCTO IN ('F', 'V')`);
    if (hdrCols.has('ESTATUS')) conds.push(`COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')`);
    if (hdrCols.has('APLICADO')) conds.push(`COALESCE(d.APLICADO, 'S') = 'S'`);
    return conds.length ? `(${conds.join(' AND ')})` : '(1=1)';
  };

  function costoUnitSubquery(detArticuloExpr, detClaveExpr, fechaDocExpr) {
    const w = [`ind.ARTICULO_ID = ${detArticuloExpr}`];
    if (inClaveCol && detClaveExpr) w.push(`COALESCE(ind.${inClaveCol}, '') = COALESCE(${detClaveExpr}, '')`);
    if (inHasCancel) w.push(`COALESCE(di.CANCELADO, 'N') = 'N'`);
    if (inHasAplicado) w.push(`COALESCE(di.APLICADO, 'S') = 'S'`);
    if (inHasFecha) w.push(`CAST(di.FECHA AS DATE) <= CAST(${fechaDocExpr} AS DATE)`);

    const unitExpr = inCostoUnitCol
      ? `NULLIF(ind.${inCostoUnitCol}, 0)`
      : ((inCostoTotalCol && inQtyCol)
        ? `CASE WHEN COALESCE(ind.${inQtyCol}, 0) <> 0 THEN COALESCE(ind.${inCostoTotalCol}, 0) / COALESCE(ind.${inQtyCol}, 1) ELSE NULL END`
        : 'NULL');

    const orderParts = [];
    if (inHasFecha) orderParts.push('di.FECHA DESC');
    if (inDetIdCol) orderParts.push(`ind.${inDetIdCol} DESC`);
    if (!orderParts.length) orderParts.push('di.DOCTO_IN_ID DESC');

    return `COALESCE((
      SELECT FIRST 1 COALESCE(${unitExpr}, 0)
      FROM DOCTOS_IN di
      JOIN DOCTOS_IN_DET ind ON ind.DOCTO_IN_ID = di.DOCTO_IN_ID
      WHERE ${w.join(' AND ')}
      ORDER BY ${orderParts.join(', ')}
    ), 0)`;
  }

  function buildExpr(colsSet) {
    const qtyCol = firstExistingColumn(colsSet, ['UNIDADES', 'CANTIDAD']) || 'UNIDADES';
    const precioUnitCol = firstExistingColumn(colsSet, ['PRECIO_UNITARIO', 'PRECIO_U', 'PRECIO']) || 'PRECIO_UNITARIO';
    const claveCol = firstExistingColumn(colsSet, ['CLAVE_ARTICULO']);
    // DAX base: Importe_Neto = Unidades * Precio_Unitario
    const ventaSql = `COALESCE(det.${qtyCol}, 0) * COALESCE(det.${precioUnitCol}, 0)`;
    const unitCostoSql = costoUnitSubquery('det.ARTICULO_ID', claveCol ? `det.${claveCol}` : null, 'd.FECHA');
    const costSql = `COALESCE(det.${qtyCol}, 0) * (${unitCostoSql})`;
    return { qtyCol, precioUnitCol, ventaSql, costSql };
  }
  const veExpr = buildExpr(veDetCols);
  const pvExpr = buildExpr(pvDetCols);
  const artClaveCol = firstExistingColumn(artCols, ['CLAVE', 'CLAVE_ARTICULO']);
  const veDetClaveCol = firstExistingColumn(veDetCols, ['CLAVE_ARTICULO']);
  const pvDetClaveCol = firstExistingColumn(pvDetCols, ['CLAVE_ARTICULO']);
  const veClaveExpr = artClaveCol
    ? `COALESCE(a.${artClaveCol}, ${veDetClaveCol ? `det.${veDetClaveCol}` : "''"}, CAST(det.ARTICULO_ID AS VARCHAR(40)))`
    : (veDetClaveCol ? `COALESCE(det.${veDetClaveCol}, CAST(det.ARTICULO_ID AS VARCHAR(40)))` : `CAST(det.ARTICULO_ID AS VARCHAR(40))`);
  const pvClaveExpr = artClaveCol
    ? `COALESCE(a.${artClaveCol}, ${pvDetClaveCol ? `det.${pvDetClaveCol}` : "''"}, CAST(det.ARTICULO_ID AS VARCHAR(40)))`
    : (pvDetClaveCol ? `COALESCE(det.${pvDetClaveCol}, CAST(det.ARTICULO_ID AS VARCHAR(40)))` : `CAST(det.ARTICULO_ID AS VARCHAR(40))`);
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
  const buildUnion = () => {
    const vePart = `
        SELECT
          d.FOLIO,
          CAST(d.FECHA AS DATE) AS FECHA,
          'VE' AS TIPO_SRC,
          c.NOMBRE AS CLIENTE,
          COALESCE(v.NOMBRE, '') AS VENDEDOR,
          ${veClaveExpr} AS CLAVE_ARTICULO,
          COALESCE(a.NOMBRE, '') AS DESC_ARTICULO,
          COALESCE(det.${veExpr.qtyCol}, 0) AS CANTIDAD,
          CAST(COALESCE(det.${veExpr.precioUnitCol}, 0) AS DECIMAL(18, 4)) AS PRECIO_U,
          CAST(${veExpr.costSql} AS DECIMAL(18, 4)) AS COSTO,
          CAST(${veExpr.ventaSql} AS DECIMAL(18, 4)) AS VENTA
        FROM DOCTOS_VE d
        JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
        WHERE ${doDocOk(veCols)} ${f.sql}`;
    const pvPart = `
        SELECT
          d.FOLIO,
          CAST(d.FECHA AS DATE) AS FECHA,
          'PV' AS TIPO_SRC,
          c.NOMBRE AS CLIENTE,
          COALESCE(v.NOMBRE, '') AS VENDEDOR,
          ${pvClaveExpr} AS CLAVE_ARTICULO,
          COALESCE(a.NOMBRE, '') AS DESC_ARTICULO,
          COALESCE(det.${pvExpr.qtyCol}, 0) AS CANTIDAD,
          CAST(COALESCE(det.${pvExpr.precioUnitCol}, 0) AS DECIMAL(18, 4)) AS PRECIO_U,
          CAST(${pvExpr.costSql} AS DECIMAL(18, 4)) AS COSTO,
          CAST(${pvExpr.ventaSql} AS DECIMAL(18, 4)) AS VENTA
        FROM DOCTOS_PV d
        JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
        LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
        WHERE ${doDocOk(pvCols)} ${f.sql}`;
    if (tipo === 'VE') return { sql: vePart, params: f.params };
    if (tipo === 'PV') return { sql: pvPart, params: f.params };
    return { sql: `${vePart} UNION ALL ${pvPart}`, params: [...f.params, ...f.params] };
  };
  try {
    const { sql, params } = buildUnion();
    const rows = await query(
      `SELECT FIRST ${limit} * FROM (${sql}) u ORDER BY u.VENTA DESC, u.FECHA DESC, u.FOLIO DESC`,
      params,
      20000,
      dbo
    );
    return mapRows(rows);
  } catch (e1) {
    console.error('[margen-lineas] error:', e1.message);
    if (String(req.query.debug || '') === '1') {
      return [{ ERROR: e1.message }];
    }
    return [];
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
    ORDER BY q.COBRADO_PERIODO DESC, q.TOTAL_VENTA DESC, q.FECHA_FACTURA DESC
  `;
  const params = [...f.params, ...fiIr.params];
  return query(sql, params, 20000, dbo).catch(err => { console.error('cobradas-por-factura error:', err && (err.message || err)); return []; });
});

get('/api/ventas/margen', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  return query(`
    SELECT d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
      COALESCE(SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)), 0) AS MARGEN,
      COALESCE(SUM(det.PRECIO_TOTAL), 0) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE (
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C', 'T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    ) ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE, EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
  `, f.params, 30000, dbo).catch(() => []);
});

get('/api/ventas/margen-articulos', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  return query(`
    SELECT a.ARTICULO_ID, a.DESCRIPCION, SUM(det.PRECIO_TOTAL - COALESCE(det.COSTO_TOTAL, 0)) AS MARGEN, SUM(det.PRECIO_TOTAL) AS VENTA
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = det.ARTICULO_ID
    WHERE (
      (d.TIPO_DOCTO = 'F' AND d.ESTATUS <> 'C')
      OR (d.TIPO_DOCTO = 'V' AND d.ESTATUS NOT IN ('C', 'T'))
      OR (d.TIPO_DOCTO = 'R' AND d.ESTATUS <> 'C')
    ) ${f.sql}
    GROUP BY a.ARTICULO_ID, a.DESCRIPCION ORDER BY MARGEN DESC
  `, f.params, 30000, dbo).catch(() => []);
});

get('/api/ventas/cotizaciones', async (req) => {
  const f = buildFiltros(req, 'd');
  const innerBd = cotizQueryIsoBounds(req);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const run = async (dbo) => {
    const cotiOpts = await cotizacionSqlOpts(dbo);
    const cotiSub = cotizacionesSub(getCotizacionesTipo(req), cotiOpts, innerBd);
    const ci = sqlCotiImporteExpr('d');
    return query(`
    SELECT FIRST ${limit}
      d.DOCTO_VE_ID, d.DOCTO_PV_ID, d.FECHA, d.FOLIO, d.TIPO_DOCTO, d.TIPO_SRC, ${ci} AS IMPORTE_NETO, d.CLIENTE_ID,
      c.NOMBRE AS CLIENTE, d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(12))) AS VENDEDOR
    FROM ${cotiSub} d
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE 1=1 ${f.sql}
    ORDER BY ${ci} DESC, d.FECHA DESC, d.FOLIO DESC
  `, f.params, 30000, dbo).catch((err) => {
      console.error('[ventas/cotizaciones]', err && (err.message || err));
      return [];
    });
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeCotizacionesList(lists, limit);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/vendedores', async (req) => {
  const run = async (dbo) => query(`SELECT VENDEDOR_ID, NOMBRE FROM VENDEDORES WHERE COALESCE(ESTATUS,'A') NOT IN ('I','B','0','N') ORDER BY NOMBRE`, [], 12000, dbo).catch(() => []);
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 3, async (entry) => {
      try {
        return await run(entry.options);
      } catch (e) {
        return [];
      }
    });
    return mergeVendedoresList(lists);
  }
  return run(getReqDbOpts(req));
});

get('/api/ventas/diario', async (req) => {
  const dbo = getReqDbOpts(req);
  const f = buildFiltros(req, 'd');
  const tipo = getTipo(req);
  return query(`
    SELECT CAST(d.FECHA AS DATE) AS FECHA, COUNT(*) AS FACTURAS, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOTAL
    FROM ${ventasSub(tipo)} d WHERE 1=1 ${f.sql}
    GROUP BY CAST(d.FECHA AS DATE) ORDER BY 1
  `, f.params, 30000, dbo).catch(() => []);
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

  const condVendedor = vendedorQ != null ? ` AND COALESCE(d.VENDEDOR_ID, 0) = ${vendedorQ}` : '';
  const anioExpr = anioQ || 'EXTRACT(YEAR FROM CURRENT_DATE)';

  const ventas = await query(`
    SELECT COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_MES,
      SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = ${anioExpr} THEN d.IMPORTE_NETO ELSE 0 END) AS VENTA_YTD,
      SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 ELSE 0 END) AS FACTURAS_HOY,
      SUM(CASE WHEN ${condAnioMes} THEN 1 ELSE 0 END) AS FACTURAS_MES
    FROM ${ventasSub()} d
    WHERE ${condAnioMes} ${condVendedor}
    GROUP BY COALESCE(d.VENDEDOR_ID, 0)
  `, [], 12000, dbo).catch(() => []);

  const ventaMap = {};
  (ventas || []).forEach(v => { ventaMap[v.VENDEDOR_ID] = v; });

  const rows = await query(`
    SELECT DISTINCT
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      CASE
        WHEN COALESCE(d.VENDEDOR_ID, 0) <= 0 THEN 'No asignado'
        ELSE COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10)))
      END AS NOMBRE
    FROM ${ventasSub()} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE ${condAnioMes} ${condVendedor}
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

  return rowsMapped.map(r => {
    const sinMeta = (+r.VENDEDOR_ID || 0) <= 0;
    const mDia = sinMeta ? 0 : metaDia;
    const mMes = sinMeta ? 0 : metaMes;
    return {
      ...r,
      META_DIA: mDia,
      META_MES: mMes,
      META_IDEAL: sinMeta ? 0 : metaIdeal,
      PCT_HOY: mDia > 0 ? Math.round(+r.VENTA_HOY / mDia * 100) : 0,
      PCT_MES: mMes > 0 ? Math.round(+r.VENTA_MES / mMes * 100) : 0,
      DIAS_TRANSCURRIDOS: diasTranscurridos,
      STATUS_HOY: mDia > 0 ? (+r.VENTA_HOY >= mDia ? 'OK' : +r.VENTA_HOY >= mDia * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
      STATUS_MES: mMes > 0 ? (+r.VENTA_MES >= mMes ? 'OK' : +r.VENTA_MES >= mMes * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
      SIN_META: sinMeta,
    };
  });
});

// ═══════════════════════════════════════════════════════════
//  DIRECTOR
// ═══════════════════════════════════════════════════════════

// director.html espera: dir.ventas (HOY, MES_ACTUAL, FACTURAS_MES, MES_VE, MES_PV), dir.cxc, dir.cotizaciones
// Respeta preset/filtro de fechas: ventas y cotizaciones del periodo (desde/hasta o anio/mes).
// Cotizaciones: misma macro que ventas con TIPO_DOCTO='C' e IMPORTE_NETO vía sqlVentaImporteBaseExpr.
async function directorResumenSnapshot(req, dbOpts, perQueryMs) {
  // Render / Firebird remoto: 12s era poco; CxC unificado usa varias queries. Alinear con cxcAgingQueryMs().
  const agingFloor = cxcAgingQueryMs();
  const qms =
    perQueryMs != null
      ? Math.min(180000, Math.max(perQueryMs, agingFloor, 25000))
      : Math.min(180000, Math.max(agingFloor, 45000));
  const rq = { query: { ...req.query } };
  if (!rq.query.desde && !rq.query.hasta && !rq.query.anio) {
    const now = new Date();
    rq.query.anio = now.getFullYear();
    rq.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(rq, 'd');
  const cotiOpts = await cotizacionSqlOpts(dbOpts);
  const omitCxc = String((req && req.query && req.query.omitCxc) || '').trim() === '1';
  /* Cotizaciones: mismo criterio que /api/ventas/cotizaciones/resumen — VE y PV por separado (UNION+ligas PV timeout → no anular todo). */
  const cotiMs = Math.min(180000, Math.max(qms, 95000));
  const cotiPromise = (async () => {
    const qr = { query: { ...rq.query } };
    if (!qr.query.desde && !qr.query.hasta && qr.query.anio && qr.query.mes) {
      const y = parseInt(String(qr.query.anio || ''), 10);
      const m = parseInt(String(qr.query.mes || ''), 10);
      if (Number.isFinite(y) && Number.isFinite(m) && m >= 1 && m <= 12) {
        qr.query.desde = `${y}-${String(m).padStart(2, '0')}-01`;
        qr.query.hasta = lastDayOfMonth(y, m);
      }
    }
    const imp = sqlCotiImporteExpr('d');
    const wVe = sqlWhereCotizacionComoVenta('d', 'VE');
    const wPv = sqlWhereCotizacionComoVenta('d', 'PV');
    const feVe = cotiOpts.sqlFeVe || 'd.FECHA';
    const fePv = cotiOpts.sqlFePv || 'd.FECHA';
    const fVe = buildFiltros(qr, 'd', { fechaExpr: feVe });
    const fPv = buildFiltros(qr, 'd', { fechaExpr: fePv });
    const t = Math.min(180000, Math.max(cotiMs, 120000));
    const veSql = `
      SELECT
        SUM(CASE WHEN CAST(${feVe} AS DATE) = CURRENT_DATE THEN ${imp} ELSE 0 END) AS HOY,
        COALESCE(SUM(${imp}), 0) AS MES_ACTUAL,
        COUNT(*) AS COTIZACIONES_MES,
        COUNT(CASE WHEN CAST(${feVe} AS DATE) = CURRENT_DATE THEN 1 END) AS COTIZACIONES_HOY
      FROM DOCTOS_VE d
      WHERE 1=1 ${fVe.sql} AND (${wVe})${String(cotiOpts.vigenciaVeSuffix || '')}
    `;
    const pvSql = `
      SELECT
        SUM(CASE WHEN CAST(${fePv} AS DATE) = CURRENT_DATE THEN ${imp} ELSE 0 END) AS HOY,
        COALESCE(SUM(${imp}), 0) AS MES_ACTUAL,
        COUNT(*) AS COTIZACIONES_MES,
        COUNT(CASE WHEN CAST(${fePv} AS DATE) = CURRENT_DATE THEN 1 END) AS COTIZACIONES_HOY
      FROM DOCTOS_PV d
      WHERE 1=1 ${fPv.sql} AND (${wPv})
    `;
    // Inicio/Director: siempre VE+PV (no usar ?tipo= ni getCotizacionesTipo: residual de Ventas dejaba COTI en 0).
    const [veRows, pvRows] = await Promise.all([
      query(veSql, fVe.params, t, dbOpts).catch((err) => {
        console.error('[director/snapshot][coti VE]', err && (err.message || err));
        return [];
      }),
      query(pvSql, fPv.params, t, dbOpts).catch((err) => {
        console.error('[director/snapshot][coti PV]', err && (err.message || err));
        return [];
      }),
    ]);
    const merged = mergeCotizacionResumenRows([
      normalizeCotizacionResumenRow(veRows[0]),
      normalizeCotizacionResumenRow(pvRows[0]),
    ]);
    return [
      {
        IMPORTE_COTI_HOY: merged.HOY,
        IMPORTE_COTI_MES: merged.MES_ACTUAL,
        COTI_HOY: merged.COTIZACIONES_HOY,
        COTI_MES: merged.COTIZACIONES_MES,
      },
    ];
  })();
  const [vRow, remRow, cxcSnap, coRow] = await Promise.all([
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
    query(`
      SELECT
        SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS REMISIONES_HOY,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS REMISIONES_MES
      FROM ${remisionesSub()} d
      WHERE 1=1 ${f.sql}
    `, f.params, qms, dbOpts).catch(() => [{}]),
    omitCxc
      ? Promise.resolve({ resumen: { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 }, aging: {} })
      : cxcResumenAgingUnificado(rq, dbOpts, qms).catch(() => ({ resumen: { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 }, aging: {} })),
    cotiPromise,
  ]);
  const v = vRow[0] || {};
  const rem = remRow[0] || {};
  const co = coRow[0] || {};
  const cxc = (cxcSnap && cxcSnap.resumen) || { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 };

  return {
    ventas: { HOY: +(v.HOY||0), MES_ACTUAL: +(v.MES_ACTUAL||0), FACTURAS_MES: +(v.FACTURAS_MES||0), MES_VE: +(v.MES_VE||0), MES_PV: +(v.MES_PV||0), REMISIONES_HOY: +(rem.REMISIONES_HOY||0), REMISIONES_MES: +(rem.REMISIONES_MES||0) },
    cxc: { SALDO_TOTAL: +(cxc.SALDO_TOTAL||0), NUM_CLIENTES: +(cxc.NUM_CLIENTES||0), NUM_CLIENTES_VENCIDOS: +(cxc.NUM_CLIENTES_VENCIDOS||0), VENCIDO: +(cxc.VENCIDO||0), POR_VENCER: +(cxc.POR_VENCER||0) },
    cotizaciones: { COTI_HOY: +(co.COTI_HOY||0), IMPORTE_COTI_HOY: +(co.IMPORTE_COTI_HOY||0), IMPORTE_COTI_MES: +(co.IMPORTE_COTI_MES||0), COTI_MES: +(co.COTI_MES||0) },
  };
}

get('/api/director/resumen', async (req) => {
  const dirQms = Math.min(180000, Math.max(cxcAgingQueryMs(), 35000));
  if (isAllDbs(req)) {
    const parts = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await directorResumenSnapshot(req, entry.options, dirQms);
      } catch (e) {
        return {
          ventas: { HOY: 0, MES_ACTUAL: 0, FACTURAS_MES: 0, MES_VE: 0, MES_PV: 0, REMISIONES_HOY: 0, REMISIONES_MES: 0 },
          cxc: { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 },
          cotizaciones: { COTI_HOY: 0, IMPORTE_COTI_HOY: 0, IMPORTE_COTI_MES: 0, COTI_MES: 0 },
        };
      }
    });
    return mergeDirectorResumenSnapshots(parts);
  }
  return directorResumenSnapshot(req, getReqDbOpts(req), dirQms);
});

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
  `, f.params, 30000, dbo).catch(() => []);
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
  `, f.params, 30000, dbo).catch(() => []);
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
  `, f.params, 30000, dbo).catch(() => []);
});

// ═══════════════════════════════════════════════════════════
//  CXC
// ═══════════════════════════════════════════════════════════

// Filas por documento con DIAS_VENCIDO y SALDO_NETO (Cargo − Cobro). Sin filtro de saldo > 0 (para poder combinar WHERE en vencidas).
// Una sola fila por DOCTO_CC_ID: cxcCargosSQL puede repetir el mismo documento con distinto DIAS_VENCIDO (varias líneas de cargo / join a vencimientos).
// Antes GROUP BY (... DIAS_VENCIDO) duplicaba el mismo saldo en docAgg y dejaba VENCIDO=0 al repartir mal corriente vs mora.
/** Importe recibo/cobro en base (ex-IVA) alineado a cxcClienteSQL / DAX. */
const CXC_RECIBO_BASE_EXPR = `CASE WHEN COALESCE(i2.IMPUESTO,0) > 0 THEN i2.IMPORTE ELSE i2.IMPORTE/1.16 END`;

function cxcDocSaldosInnerSQL(cfSql) {
  // Cobros (R): además de DOCTO_CC_ACR_ID = factura, algunas instalaciones registran el recibo con DOCTO_CC_ID = factura y ACR nulo.
  return `(
    SELECT d.DOCTO_CC_ID, d.CLIENTE_ID, d.DIAS_VENCIDO,
      CAST(
        COALESCE((SELECT SUM(i.IMPORTE) FROM IMPORTES_DOCTOS_CC i
          WHERE i.DOCTO_CC_ID = d.DOCTO_CC_ID AND i.TIPO_IMPTE = 'C' AND COALESCE(i.CANCELADO,'N') = 'N'), 0)
        - COALESCE((SELECT SUM(${CXC_RECIBO_BASE_EXPR})
          FROM IMPORTES_DOCTOS_CC i2
          WHERE i2.TIPO_IMPTE = 'R' AND COALESCE(i2.CANCELADO,'N') = 'N'
            AND (
              i2.DOCTO_CC_ACR_ID = d.DOCTO_CC_ID
              OR (i2.DOCTO_CC_ID = d.DOCTO_CC_ID AND i2.DOCTO_CC_ACR_ID IS NULL)
            )), 0)
      AS DECIMAL(18,2)) AS SALDO_NETO
    FROM (
      SELECT cd.DOCTO_CC_ID, cd.CLIENTE_ID,
        MAX(cd.DIAS_VENCIDO) AS DIAS_VENCIDO
      FROM ${cxcCargosSQL()} cd
      WHERE 1=1 ${cfSql}
      GROUP BY cd.DOCTO_CC_ID, cd.CLIENTE_ID
    ) d
  )`;
}

// Subconsulta usable en FROM: alias doc + solo documentos con saldo pendiente.
// Contado / efectivo inmediato: DIAS_VENCIDO = 0 (no entra a morosidad). No duplicar alias doc al anidar (rompía /api/cxc/vencidas).
function cxcDocSaldosSQL(cfSql) {
  return `${cxcDocSaldosInnerSQL(cfSql)} doc WHERE doc.SALDO_NETO > 0`;
}

async function cxcResumenAgingUnificado(req, dbo, qms) {
  /* Tope alineado con GET /api/cxc/resumen-aging (queryMs hasta 180000). Antes min(qms,120000) anulaba queryMs=180000 y en bases lentas dejaba snapshot vacío / vencido 0. */
  const ms = typeof qms === 'number' && qms > 0 ? Math.min(Math.max(qms, 3000), 180000) : cxcAgingQueryMs();
  const t0 = Date.now();
  const cf = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const whereCliDoc = cf ? ` AND doc.CLIENTE_ID = ${cf}` : '';
  const whereCliSaldo = cf ? ` WHERE cs.CLIENTE_ID = ${cf}` : '';
  const agingLegacySql = `
      SELECT
        cd.CLIENTE_ID,
        SUM(cd.SALDO) AS TOTAL_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO <= 0 THEN cd.SALDO ELSE 0 END) AS COR_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 1 AND 30 THEN cd.SALDO ELSE 0 END) AS B1_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 31 AND 60 THEN cd.SALDO ELSE 0 END) AS B2_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 61 AND 90 THEN cd.SALDO ELSE 0 END) AS B3_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS B4_C,
        SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C
      FROM ${cxcCargosSQL()} cd
      ${cf ? `WHERE cd.CLIENTE_ID = ${cf}` : ''}
      GROUP BY cd.CLIENTE_ID
    `;

  const [docAggRows, cxcSaldosLegacy, cxcAgingLegacyRaw, docStatsRows, movStatsRows, saldoCutRows] = await Promise.all([
    query(`
      SELECT
        COUNT(DISTINCT doc.CLIENTE_ID) AS NUM_CLIENTES_DOC,
        COUNT(DISTINCT CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.CLIENTE_ID END) AS NUM_CLI_VENC_DOC,
        SUM(doc.SALDO_NETO) AS TOTAL_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS COR_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 1 AND 30 THEN doc.SALDO_NETO ELSE 0 END) AS B1_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 31 AND 60 THEN doc.SALDO_NETO ELSE 0 END) AS B2_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 61 AND 90 THEN doc.SALDO_NETO ELSE 0 END) AS B3_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 90 THEN doc.SALDO_NETO ELSE 0 END) AS B4_C,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS VENC_C
      FROM ${cxcDocSaldosInnerSQL('')} doc
      WHERE doc.SALDO_NETO > 0.005 ${whereCliDoc}
    `, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado docAgg error:', err && (err.message || err)); return []; }),
    query(`SELECT cs.CLIENTE_ID, cs.SALDO FROM ${cxcClienteSQL()} cs${whereCliSaldo}`, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado saldosLegacy error:', err && (err.message || err)); return []; }),
    query(agingLegacySql, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado agingLegacy error:', err && (err.message || err)); return []; }),
    query(`
      SELECT
        COUNT(*) AS DOCS_SALDO,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN 1 ELSE 0 END) AS DOCS_VENCIDOS,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN 1 ELSE 0 END) AS DOCS_CORRIENTE,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS SALDO_CORRIENTE,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS SALDO_VENCIDO
      FROM ${cxcDocSaldosInnerSQL('')} doc
      WHERE doc.SALDO_NETO > 0.005 ${whereCliDoc}
    `, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado docStats error:', err && (err.message || err)); return []; }),
    query(`
      SELECT
        SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN 1 ELSE 0 END) AS MOV_C,
        SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN 1 ELSE 0 END) AS MOV_R,
        COUNT(DISTINCT CASE WHEN i.TIPO_IMPTE = 'C' THEN i.DOCTO_CC_ID END) AS DOCS_CON_CARGO,
        COUNT(DISTINCT CASE WHEN i.TIPO_IMPTE = 'R' THEN i.DOCTO_CC_ACR_ID END) AS DOCS_CON_COBRO_REF,
        SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE ELSE 0 END) AS CARGOS_IMPORTE,
        SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN (CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END) ELSE 0 END) AS COBROS_IMPORTE
      FROM IMPORTES_DOCTOS_CC i
      JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = CASE
        WHEN i.TIPO_IMPTE = 'R' AND i.DOCTO_CC_ACR_ID IS NOT NULL THEN i.DOCTO_CC_ACR_ID
        ELSE i.DOCTO_CC_ID
      END
      LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
      LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
      WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO} ${cf ? ` AND dc.CLIENTE_ID = ${cf}` : ''}
    `, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado movStats error:', err && (err.message || err)); return []; }),
    query(`
      SELECT
        COUNT(*) AS DOCS_ALL,
        SUM(CASE WHEN doc.SALDO_NETO > 0.005 THEN 1 ELSE 0 END) AS DOCS_PENDIENTES,
        SUM(CASE WHEN doc.SALDO_NETO <= 0.005 THEN 1 ELSE 0 END) AS DOCS_PAGADOS_O_CERRADOS
      FROM ${cxcDocSaldosInnerSQL('')} doc
      WHERE 1 = 1 ${whereCliDoc}
    `, [], ms, dbo).catch((err) => { console.error('cxcResumenAgingUnificado saldoCut error:', err && (err.message || err)); return []; }),
  ]);

  let saldoTotal = 0, vencido = 0, porVencer = 0;
  let agCorr = 0, ag1 = 0, ag2 = 0, ag3 = 0, ag4 = 0;
  const docAgg = (Array.isArray(docAggRows) && docAggRows[0]) ? docAggRows[0] : {};
  saldoTotal = +docAgg.TOTAL_C || 0;
  vencido = +docAgg.VENC_C || 0;
  agCorr = +docAgg.COR_C || 0;
  ag1 = +docAgg.B1_C || 0;
  ag2 = +docAgg.B2_C || 0;
  ag3 = +docAgg.B3_C || 0;
  ag4 = +docAgg.B4_C || 0;
  porVencer = agCorr;
  let numCliVenc = +(docAgg.NUM_CLI_VENC_DOC || 0);

  // Si el aging legacy vino vacío/cero por timeout parcial, reintentar una vez con más tiempo.
  let cxcAgingLegacy = Array.isArray(cxcAgingLegacyRaw) ? cxcAgingLegacyRaw : [];
  if (saldoTotal > 0.005) {
    const legacyHadRows = Array.isArray(cxcAgingLegacy) && cxcAgingLegacy.length;
    const legacyAnyVenc = legacyHadRows && cxcAgingLegacy.some((r) => (+r.VENC_C || 0) > 0.005);
    const legacyAnyData = legacyHadRows && cxcAgingLegacy.some((r) => ((+r.TOTAL_C || 0) > 0.005) || ((+r.COR_C || 0) > 0.005) || ((+r.VENC_C || 0) > 0.005));
    if (!legacyAnyData || (!legacyAnyVenc && vencido <= 0.005)) {
      const msRetry = Math.min(180000, Math.max(ms, 90000));
      try {
        const retryRows = await query(agingLegacySql, [], msRetry, dbo).catch(() => []);
        if (Array.isArray(retryRows) && retryRows.length) cxcAgingLegacy = retryRows;
      } catch (_) {}
    }
  }
  if (saldoTotal <= 0.005 && Array.isArray(cxcSaldosLegacy) && cxcSaldosLegacy.length) {
    saldoTotal = (cxcSaldosLegacy || []).reduce((s, r) => s + (+r.SALDO || 0), 0);
    const aggLegacy = (Array.isArray(cxcAgingLegacy) ? cxcAgingLegacy : []).reduce((a, r) => {
      a.cor += (+r.COR_C || 0);
      a.b1 += (+r.B1_C || 0);
      a.b2 += (+r.B2_C || 0);
      a.b3 += (+r.B3_C || 0);
      a.b4 += (+r.B4_C || 0);
      a.venc += (+r.VENC_C || 0);
      return a;
    }, { cor: 0, b1: 0, b2: 0, b3: 0, b4: 0, venc: 0 });
    const hasLegacyAging = (aggLegacy.cor + aggLegacy.venc) > 0.005;
    if (hasLegacyAging) {
      agCorr = aggLegacy.cor;
      ag1 = aggLegacy.b1;
      ag2 = aggLegacy.b2;
      ag3 = aggLegacy.b3;
      ag4 = aggLegacy.b4;
      vencido = aggLegacy.venc;
      porVencer = aggLegacy.cor;
    } else {
      porVencer = saldoTotal;
      vencido = 0;
      agCorr = saldoTotal;
    }
    numCliVenc = (Array.isArray(cxcAgingLegacy) ? cxcAgingLegacy.filter(r => (+r.VENC_C || 0) > 0.005).length : 0);
  }

  // Reconciliación: agregado por documento (docAgg) puede dejar todo en corriente si DIAS_VENCIDO no cuadra con líneas de cargo;
  // el aging por cliente (cxcAgingLegacy) suele ser el que cuadraba con Power BI / lectura histórica.
  const aggLegacyFlat = (Array.isArray(cxcAgingLegacy) ? cxcAgingLegacy : []).reduce(
    (a, r) => {
      a.cor += +r.COR_C || 0;
      a.b1 += +r.B1_C || 0;
      a.b2 += +r.B2_C || 0;
      a.b3 += +r.B3_C || 0;
      a.b4 += +r.B4_C || 0;
      a.venc += +r.VENC_C || 0;
      return a;
    },
    { cor: 0, b1: 0, b2: 0, b3: 0, b4: 0, venc: 0 }
  );
  const legacySum = aggLegacyFlat.cor + aggLegacyFlat.b1 + aggLegacyFlat.b2 + aggLegacyFlat.b3 + aggLegacyFlat.b4;
  if (
    saldoTotal > 0.005 &&
    vencido <= 0.005 &&
    aggLegacyFlat.venc > 0.005 &&
    legacySum > 0.005 &&
    Array.isArray(cxcAgingLegacy) &&
    cxcAgingLegacy.length
  ) {
    const mx = Math.max(saldoTotal, legacySum);
    const relDiff = mx > 0 ? Math.abs(saldoTotal - legacySum) / mx : 1;
    // Doc (saldo neto por factura) vs legacy (suma de líneas de cargo) a veces divergen >35% y dejaban VENCIDO=0 con mora real.
    // 0.72: tolera bases donde docAgg y legacy no cuadran al 55% pero la mora legacy sigue siendo la lectura útil (Power BI / cargos).
    if (relDiff <= 0.72) {
      vencido = aggLegacyFlat.venc;
      agCorr = aggLegacyFlat.cor;
      ag1 = aggLegacyFlat.b1;
      ag2 = aggLegacyFlat.b2;
      ag3 = aggLegacyFlat.b3;
      ag4 = aggLegacyFlat.b4;
      porVencer = agCorr;
      saldoTotal = legacySum;
      numCliVenc = cxcAgingLegacy.filter((r) => (+r.VENC_C || 0) > 0.005).length;
    }
  }

  // Si el agregado por documento sigue con VENCIDO=0 pero el aging por cliente sí tiene mora y los totales
  // legacy no entraron en la ventana del 35%, escalar buckets legacy al SALDO_TOTAL documental (misma forma, otro tamaño).
  if (
    saldoTotal > 0.005 &&
    vencido <= 0.005 &&
    aggLegacyFlat.venc > 0.005 &&
    legacySum > 0.005 &&
    Array.isArray(cxcAgingLegacy) &&
    cxcAgingLegacy.length
  ) {
    const scale = saldoTotal / legacySum;
    if (scale >= 0.05 && scale <= 18.0) {
      agCorr = aggLegacyFlat.cor * scale;
      ag1 = aggLegacyFlat.b1 * scale;
      ag2 = aggLegacyFlat.b2 * scale;
      ag3 = aggLegacyFlat.b3 * scale;
      ag4 = aggLegacyFlat.b4 * scale;
      vencido = ag1 + ag2 + ag3 + ag4;
      porVencer = agCorr;
      numCliVenc = cxcAgingLegacy.filter((r) => (+r.VENC_C || 0) > 0.005).length;
    }
  }

  if (vencido <= 0.005 && saldoTotal > 1000 && aggLegacyFlat.venc <= 0.005) {
    console.warn(
      '[cxc/resumen-aging] VENCIDO=0 con cartera >0; relDiff doc/legacy posible; saldoTotal=%s numCliDoc=%s',
      saldoTotal,
      docAgg.NUM_CLIENTES_DOC
    );
  }

  const resumen = {
    SALDO_TOTAL: Math.round(saldoTotal * 100) / 100,
    NUM_CLIENTES: cf ? ((cxcSaldosLegacy || []).length ? 1 : 0) : Math.max(+(docAgg.NUM_CLIENTES_DOC || 0), (cxcSaldosLegacy || []).length),
    NUM_CLIENTES_VENCIDOS: numCliVenc,
    VENCIDO: Math.round(vencido * 100) / 100,
    POR_VENCER: Math.round(porVencer * 100) / 100,
  };
  const aging = {
    CORRIENTE: Math.round(agCorr * 100) / 100,
    DIAS_1_30: Math.round(ag1 * 100) / 100,
    DIAS_31_60: Math.round(ag2 * 100) / 100,
    DIAS_61_90: Math.round(ag3 * 100) / 100,
    DIAS_MAS_90: Math.round(ag4 * 100) / 100,
  };


  return { resumen, aging };
}

// Resumen CxC: Vencido y No vencido (suma Saldo_Documento). Contado cuenta como vigente (sin días de atraso).
get('/api/cxc/resumen', async (req) => {
  if (isAllDbs(req)) {
    const snaps = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await cxcResumenAgingUnificado(req, entry.options);
      } catch (e) {
        return { resumen: { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 }, aging: {} };
      }
    });
    return mergeCxcResumenAgingSnaps(snaps).resumen;
  }
  const dbo = getReqDbOpts(req);
  const snap = await cxcResumenAgingUnificado(req, dbo);
  return snap.resumen;
});

// Aging por documento: suma de Saldo_Documento por rango de días (igual que Power BI). Buckets suman = SALDO_TOTAL.
get('/api/cxc/aging', async (req) => {
  if (isAllDbs(req)) {
    const snaps = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await cxcResumenAgingUnificado(req, entry.options);
      } catch (e) {
        return { resumen: {}, aging: { CORRIENTE: 0, DIAS_1_30: 0, DIAS_31_60: 0, DIAS_61_90: 0, DIAS_MAS_90: 0 } };
      }
    });
    return mergeCxcResumenAgingSnaps(snaps).aging;
  }
  const dbo = getReqDbOpts(req);
  const snap = await cxcResumenAgingUnificado(req, dbo);
  return snap.aging;
});

// Un solo snapshot: evita que el cliente llame /resumen y /aging en paralelo (duplicaba cxcResumenAgingUnificado y saturaba Firebird en Render).
get('/api/cxc/resumen-aging', async (req) => {
  const qms = Math.min(Math.max(parseInt(req.query.queryMs, 10) || cxcAgingQueryMs(), 3000), 180000);
  if (isAllDbs(req)) {
    const snaps = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await cxcResumenAgingUnificado(req, entry.options, qms);
      } catch (e) {
        return { resumen: { SALDO_TOTAL: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: 0, VENCIDO: 0, POR_VENCER: 0 }, aging: { CORRIENTE: 0, DIAS_1_30: 0, DIAS_31_60: 0, DIAS_61_90: 0, DIAS_MAS_90: 0 } };
      }
    });
    return mergeCxcResumenAgingSnaps(snaps);
  }
  const dbo = getReqDbOpts(req);
  const nocache = String((req.query && req.query.nocache) || '') === '1';
  const ttlRaw = parseInt(process.env.MICROSIP_CXC_SNAPSHOT_CACHE_MS, 10);
  const ttlMs = Number.isFinite(ttlRaw) ? Math.min(Math.max(ttlRaw, 0), 120000) : 12000;
  const cfRaw = req.query && req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const cfKey = Number.isFinite(cfRaw) && cfRaw > 0 ? String(cfRaw) : '';
  const cacheKey = `${dbCacheKey(dbo)}|cxcSnap|${cfKey}`;
  if (!nocache && ttlMs > 0) {
    const hit = cxcResumenAgingSnapCache.get(cacheKey);
    if (hit && hit.expireAt > Date.now()) return hit.payload;
  }
  const snap = await cxcResumenAgingUnificado(req, dbo, qms);
  const payload = { resumen: snap.resumen, aging: snap.aging };
  if (!nocache && ttlMs > 0) {
    cxcResumenAgingSnapCache.set(cacheKey, { expireAt: Date.now() + ttlMs, payload });
  }
  return payload;
});

// Debug: desglosa fuentes de CxC para ver por qué VENCIDO puede caer a 0.
get('/api/debug/cxc-resumen-aging', async (req) => {
  const dbo = getReqDbOpts(req);
  const qms = Math.min(Math.max(parseInt(req.query.queryMs, 10) || cxcAgingQueryMs(), 3000), 180000);
  const t0 = Date.now();
  const cf = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const whereCliDoc = cf ? ` AND doc.CLIENTE_ID = ${cf}` : '';

  const docAggSql = `
    SELECT
      COUNT(DISTINCT doc.CLIENTE_ID) AS NUM_CLIENTES_DOC,
      COUNT(DISTINCT CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.CLIENTE_ID END) AS NUM_CLI_VENC_DOC,
      SUM(doc.SALDO_NETO) AS TOTAL_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS COR_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 1 AND 30 THEN doc.SALDO_NETO ELSE 0 END) AS B1_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 31 AND 60 THEN doc.SALDO_NETO ELSE 0 END) AS B2_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO BETWEEN 61 AND 90 THEN doc.SALDO_NETO ELSE 0 END) AS B3_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO > 90 THEN doc.SALDO_NETO ELSE 0 END) AS B4_C,
      SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS VENC_C,
      MAX(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS_VENC
    FROM ${cxcDocSaldosInnerSQL('')} doc
    WHERE doc.SALDO_NETO > 0.005 ${whereCliDoc}
  `;

  const agingLegacySql = `
    SELECT
      cd.CLIENTE_ID,
      SUM(cd.SALDO) AS TOTAL_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO <= 0 THEN cd.SALDO ELSE 0 END) AS COR_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 1 AND 30 THEN cd.SALDO ELSE 0 END) AS B1_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 31 AND 60 THEN cd.SALDO ELSE 0 END) AS B2_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO BETWEEN 61 AND 90 THEN cd.SALDO ELSE 0 END) AS B3_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 90 THEN cd.SALDO ELSE 0 END) AS B4_C,
      SUM(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.SALDO ELSE 0 END) AS VENC_C,
      MAX(CASE WHEN cd.DIAS_VENCIDO > 0 THEN cd.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS_VENC
    FROM ${cxcCargosSQL()} cd
    ${cf ? `WHERE cd.CLIENTE_ID = ${cf}` : ''}
    GROUP BY cd.CLIENTE_ID
  `;

  async function safeQuery(name, sql) {
    const t = Date.now();
    try {
      const rows = await query(sql, [], qms, dbo);
      return { name, ok: true, ms: Date.now() - t, rows: Array.isArray(rows) ? rows.length : 0, sample: Array.isArray(rows) ? rows.slice(0, 3) : [] , err: null };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t, rows: 0, sample: [], err: e && (e.message || String(e)) };
    }
  }

  const [docAgg, legacy, snap] = await Promise.all([
    safeQuery('docAgg', docAggSql),
    safeQuery('agingLegacy', agingLegacySql),
    (async () => {
      const t = Date.now();
      try {
        const s = await cxcResumenAgingUnificado(req, dbo, qms);
        return { ok: true, ms: Date.now() - t, resumen: s.resumen, aging: s.aging };
      } catch (e) {
        return { ok: false, ms: Date.now() - t, err: e && (e.message || String(e)) };
      }
    })(),
  ]);

  return {
    ok: true,
    ts: new Date().toISOString(),
    elapsed_ms: Date.now() - t0,
    queryMs: qms,
    db: normalizeDbQueryId(req.query.db) || 'default',
    cliente: cf,
    server_tz_offset_min: new Date().getTimezoneOffset(),
    pieces: { docAgg, agingLegacy: legacy },
    snapshot: snap,
  };
});

// Facturas vencidas: misma base que aging (cxcDocSaldosSQL). Sin subconsultas anidadas extra (Firebird).
get('/api/cxc/vencidas', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const perDb = Math.min(Math.max(limit, 30), 250);
  const cf = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const run = async (dbo, firstN) => {
    const n = Math.min(firstN, 500);
    return query(`
    SELECT FIRST ${n}
      dc.FOLIO,
      COALESCE(c.NOMBRE, 'Sin cliente') AS CLIENTE,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      x.SALDO_NETO AS SALDO,
      x.DIAS_ATRASO AS ATRASO,
      x.DIAS_ATRASO AS DIAS_ATRASO,
      CAST(dc.FECHA AS DATE) AS FECHA_VENTA,
      CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}                   AS FECHA_VENC_PLAZO,
      CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}                   AS FECHA_VENCIMIENTO,
      x.DIAS_ATRASO AS TIEMPO_SIN_PAGAR_DIAS
    FROM (
      SELECT
        doc.DOCTO_CC_ID,
        doc.CLIENTE_ID,
        MAX(doc.DIAS_VENCIDO) AS DIAS_ATRASO,
        MAX(doc.SALDO_NETO) AS SALDO_NETO
      FROM ${cxcDocSaldosInnerSQL(cfSql)} doc
      WHERE doc.SALDO_NETO > 0.005 AND doc.DIAS_VENCIDO > 0
      GROUP BY doc.DOCTO_CC_ID, doc.CLIENTE_ID
    ) x
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = x.DOCTO_CC_ID
    LEFT JOIN CLIENTES c ON c.CLIENTE_ID = x.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, c.COND_PAGO_ID)
    ORDER BY x.SALDO_NETO DESC, x.DIAS_ATRASO DESC
  `, [], 30000, dbo).catch((err) => {
      const msg = err && (err.message || String(err));
      console.error('cxc /api/cxc/vencidas query error:', msg);
      return [];
    });
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      const rows = await run(entry.options, perDb);
      const label = entry.label || entry.id || '';
      return (rows || []).map((r) => Object.assign({}, r, { NEGOCIO: label }));
    });
    const flat = lists.flat();
    flat.sort((a, b) => (+b.SALDO || 0) - (+a.SALDO || 0));
    return flat.slice(0, limit);
  }
  const dbo = getReqDbOpts(req);
  return run(dbo, limit);
});

// Top Deudores: saldo neto + condición + vencido proporcional al saldo (igual que /api/cxc/resumen). Acepta ?cliente= para filtrar.
get('/api/cxc/top-deudores', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const perDb = Math.min(Math.max(limit, 15), 80);
  const cf = req.query.cliente ? parseInt(req.query.cliente, 10) : null;
  const cfSql = cf ? ` AND cd.CLIENTE_ID = ${cf}` : '';
  const runMain = async (dbo, firstN) => {
    const n = Math.min(firstN, 100);
    return query(`
    SELECT FIRST ${n}
      doc.CLIENTE_ID,
      COALESCE(cl.NOMBRE, 'Cliente ' || CAST(doc.CLIENTE_ID AS VARCHAR(12))) AS CLIENTE,
      COALESCE(MAX(cp.NOMBRE), 'S/D') AS CONDICION_PAGO,
      SUM(doc.SALDO_NETO) AS SALDO_TOTAL,
      SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS VENCIDO,
      MAX(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS_ATRASO,
      COUNT(*) AS NUM_DOCUMENTOS
    FROM ${cxcDocSaldosInnerSQL(cfSql)} doc
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = doc.DOCTO_CC_ID
    LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = doc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, cl.COND_PAGO_ID)
    WHERE doc.SALDO_NETO > 0.005
    GROUP BY doc.CLIENTE_ID, cl.NOMBRE
    ORDER BY SALDO_TOTAL DESC, VENCIDO DESC
  `, [], 12000, dbo).catch(err => { console.error('cxc top-deudores main error:', err && (err.message || err)); return []; });
  };
  const runFb = async (dbo, firstN) => {
    const n = Math.min(firstN, 100);
    return query(`
    SELECT FIRST ${n}
      c.CLIENTE_ID,
      COALESCE(cl.NOMBRE, 'Cliente ' || CAST(c.CLIENTE_ID AS VARCHAR(12))) AS CLIENTE,
      COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
      c.SALDO AS SALDO_TOTAL,
      CAST(0 AS DOUBLE PRECISION) AS VENCIDO,
      CAST(0 AS INTEGER) AS MAX_DIAS_ATRASO,
      CAST(0 AS INTEGER) AS NUM_DOCUMENTOS
    FROM ${cxcClienteSQL()} c
    LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = c.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = cl.COND_PAGO_ID
    WHERE c.SALDO > 0.005 ${cf ? `AND c.CLIENTE_ID = ${cf}` : ''}
    ORDER BY c.SALDO DESC
  `, [], 12000, dbo).catch(err => { console.error('cxc top-deudores fallback error:', err && (err.message || err)); return []; });
  };
  const oneDb = async (dbo, firstN) => {
    const rows = await runMain(dbo, firstN);
    if ((rows || []).length) return rows;
    return runFb(dbo, firstN);
  };
  if (isAllDbs(req)) {
    const lists = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      const rows = await oneDb(entry.options, perDb);
      const label = entry.label || entry.id || '';
      return (rows || []).map((r) => Object.assign({}, r, { NEGOCIO: label }));
    });
    const flat = lists.flat();
    flat.sort((a, b) => (+b.SALDO_TOTAL || 0) - (+a.SALDO_TOTAL || 0));
    return flat.slice(0, limit);
  }
  const dbo = getReqDbOpts(req);
  return oneDb(dbo, limit);
});

get('/api/cxc/historial', async (req) => {
  const dbo = getReqDbOpts(req);
  const cliente = req.query.cliente ? parseInt(req.query.cliente) : null;
  if (!cliente) return [];
  return query(`
    SELECT cd.CLIENTE_ID, cd.FOLIO, cd.FECHA_VENCIMIENTO, cd.DIAS_VENCIDO, cd.SALDO
    FROM ${cxcCargosSQL()} cd WHERE cd.CLIENTE_ID = ?
    ORDER BY cd.SALDO DESC, cd.DIAS_VENCIDO DESC, cd.FECHA_VENCIMIENTO
  `, [cliente], 12000, dbo).catch(() => []);
});

// Por condición: saldo neto por documento CC, agrupado por COND_PAGO del documento (excluye contado/inmediato).
async function cxcPorCondicionPayload(req, dbo) {
  const docs = await query(`
    SELECT
      dc.DOCTO_CC_ID,
      dc.CLIENTE_ID,
      TRIM(COALESCE(cp.NOMBRE, 'Sin condición')) AS CONDICION_PAGO,
      COALESCE(cp.DIAS_PPAG, 0) AS DIAS_CREDITO,
      doc.DIAS_VENCIDO AS DIAS_VENCIDO,
      doc.SALDO_NETO AS SALDO_NETO
    FROM ${cxcDocSaldosInnerSQL('')} doc
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = doc.DOCTO_CC_ID
    LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
    WHERE doc.SALDO_NETO > 0.005
      AND (
        cp.COND_PAGO_ID IS NULL OR (
          POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
          AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
          AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
        )
      )
    GROUP BY dc.DOCTO_CC_ID, dc.CLIENTE_ID, cp.NOMBRE, cp.DIAS_PPAG, doc.DIAS_VENCIDO, doc.SALDO_NETO
  `, [], 15000, dbo).catch(() => []);
  if (!(docs || []).length) {
    const altRows = await query(`
      SELECT FIRST 800
        c.CLIENTE_ID,
        TRIM(COALESCE(cp.NOMBRE, 'Sin condición')) AS CONDICION_PAGO,
        COALESCE(cp.DIAS_PPAG, 0) AS DIAS_CREDITO,
        c.SALDO AS SALDO_TOTAL
      FROM ${cxcClienteSQL()} c
      LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = c.CLIENTE_ID
      LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = cl.COND_PAGO_ID
      WHERE c.SALDO > 0.005
        AND (cp.COND_PAGO_ID IS NULL OR (
          POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
          AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
          AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
        ))
      ORDER BY c.SALDO DESC
    `, [], 12000, dbo).catch(() => []);
    const agg = {};
    for (const r of altRows || []) {
      const saldo = +r.SALDO_TOTAL || 0;
      if (saldo <= 0) continue;
      const dias = +r.DIAS_CREDITO || 0;
      const cond = r.CONDICION_PAGO || 'Sin condición';
      const esContado = false;
      const key = `${cond}|${dias}|0`;
      if (!agg[key]) {
        agg[key] = {
          CONDICION_PAGO: cond,
          DIAS_CREDITO: dias,
          NUM_CLIENTES: new Set(),
          NUM_DOCUMENTOS: 0,
          SALDO_TOTAL: 0,
          VENCIDO: 0,
          CORRIENTE: 0,
          ES_CONTADO: esContado,
        };
      }
      const a = agg[key];
      a.NUM_CLIENTES.add(r.CLIENTE_ID);
      a.SALDO_TOTAL += saldo;
      a.CORRIENTE += saldo;
    }
    const gruposAlt = Object.values(agg).map(g => ({
      CONDICION_PAGO: g.CONDICION_PAGO,
      DIAS_CREDITO: g.DIAS_CREDITO,
      NUM_CLIENTES: g.NUM_CLIENTES.size,
      NUM_DOCUMENTOS: g.NUM_DOCUMENTOS,
      SALDO_TOTAL: Math.round(g.SALDO_TOTAL * 100) / 100,
      VENCIDO: 0,
      CORRIENTE: Math.round(g.CORRIENTE * 100) / 100,
      ES_CONTADO: !!g.ES_CONTADO,
    })).sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);
    return { grupos: gruposAlt, pendiente_contado: null };
  }
  const byCond = {};
  for (const r of docs || []) {
    const saldo = Math.round((+r.SALDO_NETO || 0) * 100) / 100;
    if (saldo <= 0) continue;
    const dv = +r.DIAS_VENCIDO || 0;
    const venc = dv > 0 ? saldo : 0;
    const cor = dv > 0 ? 0 : saldo;
    const esContado = false;
    let diasCredito = +r.DIAS_CREDITO || 0;
    if (diasCredito <= 0) {
      const m = String(r.CONDICION_PAGO || '').match(/(\d{1,3})\s*DIAS?/i);
      if (m && m[1]) diasCredito = parseInt(m[1], 10) || 0;
    }
    const key = `${r.CONDICION_PAGO}|${diasCredito}|0`;
    if (!byCond[key]) {
      byCond[key] = {
        CONDICION_PAGO: r.CONDICION_PAGO,
        DIAS_CREDITO: diasCredito,
        NUM_CLIENTES: new Set(),
        NUM_DOCUMENTOS: 0,
        SALDO_TOTAL: 0,
        VENCIDO: 0,
        CORRIENTE: 0,
        ES_CONTADO: esContado,
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
      ES_CONTADO: !!r.ES_CONTADO,
    }))
    .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);

  return { grupos, pendiente_contado: null };
}

get('/api/cxc/por-condicion', async (req) => {
  if (isAllDbs(req)) {
    const outs = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await cxcPorCondicionPayload(req, entry.options);
      } catch (e) {
        return { grupos: [], pendiente_contado: null };
      }
    });
    return mergeCxcPorCondicionPayloads(outs);
  }
  return cxcPorCondicionPayload(req, getReqDbOpts(req));
});

// Calendario Pagos / Buro: por documento, con CLIENTE, ANIO, MES_EMISION, saldo restante, fechas. Sin ?cliente= devuelve todos.
// Si ?saldos_actuales=1 devuelve { rows, saldosPorCliente } para que el front muestre deuda actual sin depender del filtro meses.
get('/api/cxc/historial-pagos', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 300, 500);
  const meses = Math.min(parseInt(req.query.meses) || 12, 120);
  const saldosActuales = req.query.saldos_actuales === '1' || req.query.saldos_actuales === 'true';
  const clienteFiltro = req.query.cliente ? ` AND cl.CLIENTE_ID = ${parseInt(req.query.cliente)}` : '';
  // Con saldos_actuales=1 el front necesita filas con saldo aunque la FECHA del doc sea muy antigua; sin esto el calendario queda vacío con cartera vieja.
  const fechaSql = saldosActuales ? '' : ` AND dc.FECHA >= (CURRENT_DATE - ${meses * 31})`;
  const rows = await query(`
    SELECT FIRST ${limit}
      dc.DOCTO_CC_ID,
      dc.FOLIO,
      cl.NOMBRE                                                         AS CLIENTE,
      cl.CLIENTE_ID,
      COALESCE(cp.NOMBRE, 'S/D')                                        AS CONDICION_PAGO,
      CAST(COALESCE(MIN(CASE WHEN i.TIPO_IMPTE = 'C' THEN COALESCE(i.FECHA, dc.FECHA) END), CAST(dc.FECHA AS DATE)) AS DATE) AS FECHA_EMISION,
      CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT}                     AS FECHA_VENCIMIENTO,
      SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE ELSE 0 END)       AS CARGO_ORIGINAL,
      SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN i.IMPORTE ELSE 0 END)       AS TOTAL_COBRADO,
      SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE WHEN i.TIPO_IMPTE = 'R' THEN -i.IMPORTE ELSE 0 END) AS SALDO_RESTANTE,
      MAX(CASE WHEN i.TIPO_IMPTE = 'R' THEN CAST(COALESCE(i.FECHA, dc.FECHA) AS DATE) END)   AS FECHA_ULTIMO_PAGO,
      EXTRACT(YEAR FROM COALESCE(MIN(CASE WHEN i.TIPO_IMPTE = 'C' THEN COALESCE(i.FECHA, dc.FECHA) END), CAST(dc.FECHA AS DATE))) AS ANIO,
      EXTRACT(MONTH FROM COALESCE(MIN(CASE WHEN i.TIPO_IMPTE = 'C' THEN COALESCE(i.FECHA, dc.FECHA) END), CAST(dc.FECHA AS DATE))) AS MES_EMISION
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    JOIN CLIENTES cl ON cl.CLIENTE_ID = dc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, cl.COND_PAGO_ID)
    WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${CXC_EXCLUIR_CONTADO}
      ${fechaSql}
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
/** Una sola agregación SALDOS_IN: existencia + entradas/salidas (evita dos full-scan en operación crítica). */
const SQL_SALDOS_BAL_SUB = `( SELECT ARTICULO_ID,
  SUM(COALESCE(ENTRADAS_UNIDADES, 0)) AS ENTRADAS_TOTAL,
  SUM(COALESCE(SALIDAS_UNIDADES, 0)) AS SALIDAS_TOTAL,
  SUM(COALESCE(ENTRADAS_UNIDADES, 0) - COALESCE(SALIDAS_UNIDADES, 0)) AS EXISTENCIA
  FROM SALDOS_IN GROUP BY ARTICULO_ID )`;
const SQL_PRECIO_SUB = `( SELECT ARTICULO_ID, MIN(PRECIO) AS PRECIO1 FROM PRECIOS_ARTICULOS WHERE MONEDA_ID = 1 AND PRECIO > 0 GROUP BY ARTICULO_ID )`;
/** Timeout Firebird para consumo semanal / forecast inventario (antes 12s → [] vacío en hosts lentos). */
const INV_CONSUMO_Q_MS = 90000;
/** Listados inventario (bajo mínimo, existencias, top stock): evitar [] por timeout 12s en servidor lento. */
const INV_LIST_Q_MS = 60000;
/** Por defecto VE+PV en consumos inventario; si MICROSIP_INV_CONSUMO_VE_ONLY=1 → solo VE (más liviano). */
function invUseVePvUnion() {
  return !(process.env.MICROSIP_INV_CONSUMO_VE_ONLY || '').match(/^(1|true|yes)$/i);
}
/**
 * Sin movimiento / operación crítica (subconsulta consumos):
 * - MICROSIP_INV_HEAVY_VE_ONLY=1 → solo VE.
 * - MICROSIP_INV_HEAVY_INCLUYE_PV=1 y consumo no VE-only → VE+PV.
 * - Render sin INCLUYE_PV → solo VE (evita timeout 90s+ en union pesada).
 * - Otro host → VE+PV si invUseVePvUnion.
 */
function invHeavySubTipo() {
  if ((process.env.MICROSIP_INV_HEAVY_VE_ONLY || '').match(/^(1|true|yes)$/i)) return 'VE';
  if ((process.env.MICROSIP_INV_HEAVY_INCLUYE_PV || '').match(/^(1|true|yes)$/i) && invUseVePvUnion()) return '';
  if (String(process.env.RENDER || '').toLowerCase() === 'true') return 'VE';
  return invUseVePvUnion() ? '' : 'VE';
}

function invIsRender() {
  return String(process.env.RENDER || '').toLowerCase() === 'true';
}

/** WHERE de ventas VE/PV en cabecera (misma lógica que consumosSubSql, pero reusable). */
function invDocWhereSql(alias = 'd') {
  const strictVentas = (process.env.MICROSIP_CONSUMOS_FILTRO_VENTAS_SUB || '').match(/^(1|true|yes)$/i);
  const inclRem = (process.env.MICROSIP_CONSUMOS_INCLUYE_REMISIONES || '').match(/^(1|true|yes)$/i);
  const tiposDoc = inclRem ? "('V', 'F')" : "('F')";
  if (strictVentas) {
    return `(
      ${alias}.TIPO_DOCTO IN ${tiposDoc}
      AND COALESCE(${alias}.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(${alias}.APLICADO, 'N') = 'S'
    )`;
  }
  return `(
    (${alias}.TIPO_DOCTO = 'F' AND ${alias}.ESTATUS <> 'C')
    OR (${alias}.TIPO_DOCTO = 'V' AND ${alias}.ESTATUS NOT IN ('C','T'))
    OR (${alias}.TIPO_DOCTO = 'R' AND ${alias}.ESTATUS <> 'C')
  )`;
}

/**
 * Sin movimiento: modo rápido = un solo scan de ventas recientes (DIAS/ULTIMO NULL en respuesta; tabla ≥365 en cliente suele vaciarse).
 * Modo completo = idle_um + días (correcto para 365 días) pero suele superar el proxy de Render (~60–120 s).
 * Prioridad env: MICROSIP_INV_SIN_MOV_FAST=0 fuerza completo; =1 fuerza rápido.
 * Sin variable: en Render (RENDER=true) por defecto rápido; en otro host (p. ej. Parker directo) por defecto completo.
 */
function invSinMovFastDefault() {
  const e = String(process.env.MICROSIP_INV_SIN_MOV_FAST || '').trim().toLowerCase();
  if (e === '0' || e === 'false' || e === 'no') return false;
  if (e === '1' || e === 'true' || e === 'yes') return true;
  return String(process.env.RENDER || '').toLowerCase() === 'true';
}

/** Días de historial de ventas en subquery cs de operación crítica (default 400; en modo liviano 120; en Render+rápido 90). Env: MICROSIP_INV_OP_CONSUMO_DIAS (28–730). */
function invOperacionConsumoLookbackDays() {
  const n = parseInt(process.env.MICROSIP_INV_OP_CONSUMO_DIAS, 10);
  if (Number.isFinite(n) && n >= 28 && n <= 730) return n;
  if (invIsRender() && invSinMovFastDefault()) return 90;
  return invSinMovFastDefault() ? 120 : 400;
}

/**
 * Timeout Firebird para sin-movimiento y operación crítica (Promise.race en query()).
 * Env: MICROSIP_INV_HEAVY_Q_MS (45000–300000). Por defecto 180s modo rápido, 240s modo completo.
 */
function invHeavyQueryTimeoutMs() {
  const n = parseInt(process.env.MICROSIP_INV_HEAVY_Q_MS, 10);
  if (Number.isFinite(n) && n >= 45000 && n <= 300000) return n;
  return invSinMovFastDefault() ? 180000 : 240000;
}

const invPrecioSubCache = new Map();
/** Precio mínimo por artículo (PRECIO vs PRECIO_VENTA; MONEDA_ID opcional). Falla común: MONEDA_ID o PRECIO distintos → rompe solo el KPI agregado con precios. */
async function invPrecioSubSql(dbo) {
  const key = dbCacheKey(dbo);
  if (invPrecioSubCache.has(key)) return invPrecioSubCache.get(key);
  const cols = await getTableColumns('PRECIOS_ARTICULOS', dbo);
  if (!cols || cols.size === 0) {
    invPrecioSubCache.set(key, SQL_PRECIO_SUB);
    return invPrecioSubCache.get(key);
  }
  const precioCol = firstExistingColumn(cols, ['PRECIO', 'PRECIO_VENTA', 'PRECIO_LISTA', 'IMPORTE']);
  if (!precioCol) {
    invPrecioSubCache.set(key, SQL_PRECIO_SUB);
    return invPrecioSubCache.get(key);
  }
  const hasMoneda = cols.has('MONEDA_ID');
  const where = hasMoneda ? `${precioCol} > 0 AND MONEDA_ID = 1` : `${precioCol} > 0`;
  const sql = `( SELECT ARTICULO_ID, MIN(${precioCol}) AS PRECIO1 FROM PRECIOS_ARTICULOS WHERE ${where} GROUP BY ARTICULO_ID )`;
  invPrecioSubCache.set(key, sql);
  return sql;
}

const invCostoSubCache = new Map();
/**
 * Costo unitario por artículo desde ARTICULOS (COSTO_PROMEDIO, ULTIMO_COSTO o COSTO; alineado con Power BI).
 * Si ninguna columna existe, cae al subquery de precio mínimo (PRECIO1 renombrado a COSTO1).
 */
async function invCostoSubSql(dbo) {
  const key = dbCacheKey(dbo);
  if (invCostoSubCache.has(key)) return invCostoSubCache.get(key);
  const cols = await getTableColumns('ARTICULOS', dbo).catch(() => new Set());
  const costoCol = firstExistingColumn(cols || new Set(), ['COSTO_PROMEDIO', 'ULTIMO_COSTO', 'COSTO']);
  if (costoCol) {
    invCostoSubCache.set(key, `( SELECT a.ARTICULO_ID, COALESCE(a.${costoCol}, 0) AS COSTO1 FROM ARTICULOS a )`);
  } else {
    const priceSub = await invPrecioSubSql(dbo);
    // Si no pudimos leer columnas (cold-start / timeout), NO cachear el fallback;
    // de lo contrario podríamos quedarnos atorados valuando por precio en vez de costo.
    const fallback = priceSub.replace(/PRECIO1/g, 'COSTO1');
    if ((cols instanceof Set ? cols.size : 0) > 0) {
      invCostoSubCache.set(key, fallback);
    }
    return fallback;
  }
  return invCostoSubCache.get(key);
}

// SIN_STOCK = solo articulos con minimo definido y existencia 0 (alerta real). No contar todo el catalogo en cero.
get('/api/inv/resumen', async (req) => {
  const dbo = getReqDbOpts(req);

  const qCounts = `
    SELECT
      COUNT(DISTINCT a.ARTICULO_ID) AS TOTAL_ARTICULOS,
      SUM(CASE WHEN COALESCE(s.EXISTENCIA, 0) < COALESCE(n.INVENTARIO_MINIMO, 0) AND COALESCE(n.INVENTARIO_MINIMO, 0) > 0 THEN 1 ELSE 0 END) AS BAJO_MINIMO,
      SUM(CASE WHEN COALESCE(n.INVENTARIO_MINIMO, 0) > 0 AND COALESCE(s.EXISTENCIA, 0) <= 0 THEN 1 ELSE 0 END) AS SIN_STOCK
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A'
  `;
  const invQTimeout = 60000;
  const countsRows = await query(qCounts, [], invQTimeout, dbo).catch(() => [{}]);
  const costoSub = await invCostoSubSql(dbo);
  const qValor = `
    SELECT COALESCE(SUM(COALESCE(s.EXISTENCIA, 0) * COALESCE(cs.COSTO1, 0)), 0) AS VALOR_INVENTARIO
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${costoSub} cs ON cs.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A'
  `;
  const valorRows = await query(qValor, [], invQTimeout, dbo).catch(() => [{ VALOR_INVENTARIO: 0 }]);
  const c = countsRows[0] || {};
  const v = valorRows[0] || {};
  const r = Object.assign({}, c, v);

  return { TOTAL_ARTICULOS: +(r.TOTAL_ARTICULOS||0), VALOR_INVENTARIO: +(r.VALOR_INVENTARIO||0), BAJO_MINIMO: +(r.BAJO_MINIMO||0), SIN_STOCK: +(r.SIN_STOCK||0) };
});

/**
 * Reconciliación inventario vs BI:
 * - total (actual) por SALDOS_IN * costo
 * - solo con stock > 0
 * - solo con stock > 0 y con ventas en ventana (ej. 90d / YTD)
 */
get('/api/debug/inv-reconcile', async (req) => {
  const dbo = getReqDbOpts(req);
  const dias = Math.min(Math.max(parseInt(String(req.query.dias || '90'), 10) || 90, 1), 730);
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr =
    desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');

  const costoSub = await invCostoSubSql(dbo);
  const invQTimeout = 120000;
  const cols = await getTableColumns('ARTICULOS', dbo).catch(() => new Set());
  const colsSet = cols instanceof Set ? cols : new Set(Array.isArray(cols) ? cols : []);
  const tipoCol = firstExistingColumn(colsSet, ['TIPO_ARTICULO', 'TIPO', 'ES_SERVICIO']);
  const hasNombre = colsSet.has('NOMBRE');

  // "Servicios" en Microsip suelen vivir como artículos con nombre/linea especial y distorsionan inventario vs BI.
  // Si hay columna de tipo, úsala; si no, cae a heurística por nombre.
  const whereNoServicios = (() => {
    if (tipoCol) {
      // ES_SERVICIO puede ser 0/1, o TIPO_ARTICULO puede ser texto; dejamos ambas opciones.
      return ` AND NOT (COALESCE(a.${tipoCol}, '') IN ('S', 'SERV', 'SERVICIO', 'SERVICIOS') OR COALESCE(a.${tipoCol}, 0) = 1)`;
    }
    if (hasNombre) return ` AND UPPER(a.NOMBRE) NOT CONTAINING 'SERVICIO'`;
    return '';
  })();

  const qBase = (whereExtra) => `
    SELECT
      COUNT(DISTINCT a.ARTICULO_ID) AS ARTICULOS,
      COALESCE(SUM(COALESCE(s.EXISTENCIA, 0)), 0) AS UNIDADES,
      COALESCE(SUM(COALESCE(s.EXISTENCIA, 0) * COALESCE(cs.COSTO1, 0)), 0) AS VALOR
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${costoSub} cs ON cs.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' ${whereExtra || ''}
  `;

  // SKUs vendidos en ventana: usa DOCTOS_VE_DET (más directo para consumo).
  const qVendidosVentana = `
    SELECT DISTINCT det.ARTICULO_ID
    FROM DOCTOS_VE d
    JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
    WHERE COALESCE(d.ESTATUS, 'N') <> 'C'
      AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
  `;

  // Variante VE+PV: reusa misma lógica de consumo (si existe PV) en vez de solo VE.
  const csp = await resolveConsumosSchema(dbo).catch(() => null);
  const subConsumos = csp ? consumosSubSql('', csp) : null; // '' => VE+PV union (según schema)
  const qVendidosVentanaVePv = subConsumos ? `
    SELECT DISTINCT d.ARTICULO_ID
    FROM ${subConsumos} d
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
      AND COALESCE(d.UNIDADES, 0) > 0
  ` : null;

  const [tot, conStock, vendidos, totNoServ, conStockNoServ, vendidosNoServ, vendidosVePv, vendidosVePvNoServ] = await Promise.all([
    query(qBase(''), [], invQTimeout, dbo).catch(() => [{}]),
    query(qBase(' AND COALESCE(s.EXISTENCIA, 0) > 0'), [], invQTimeout, dbo).catch(() => [{}]),
    query(
      qBase(` AND COALESCE(s.EXISTENCIA, 0) > 0 AND a.ARTICULO_ID IN (${qVendidosVentana})`),
      [desdeStr],
      invQTimeout,
      dbo,
    ).catch(() => [{}]),
    query(qBase(`${whereNoServicios}`), [], invQTimeout, dbo).catch(() => [{}]),
    query(qBase(` AND COALESCE(s.EXISTENCIA, 0) > 0 ${whereNoServicios}`), [], invQTimeout, dbo).catch(() => [{}]),
    query(
      qBase(` AND COALESCE(s.EXISTENCIA, 0) > 0 ${whereNoServicios} AND a.ARTICULO_ID IN (${qVendidosVentana})`),
      [desdeStr],
      invQTimeout,
      dbo,
    ).catch(() => [{}]),
    qVendidosVentanaVePv ? query(
      qBase(` AND COALESCE(s.EXISTENCIA, 0) > 0 AND a.ARTICULO_ID IN (${qVendidosVentanaVePv})`),
      [desdeStr],
      invQTimeout,
      dbo,
    ).catch(() => [{}]) : Promise.resolve([{}]),
    qVendidosVentanaVePv ? query(
      qBase(` AND COALESCE(s.EXISTENCIA, 0) > 0 ${whereNoServicios} AND a.ARTICULO_ID IN (${qVendidosVentanaVePv})`),
      [desdeStr],
      invQTimeout,
      dbo,
    ).catch(() => [{}]) : Promise.resolve([{}]),
  ]);

  const pick = (rows) => (rows && rows[0]) ? rows[0] : {};
  const a = pick(tot);
  const b = pick(conStock);
  const c = pick(vendidos);
  const d = pick(totNoServ);
  const e = pick(conStockNoServ);
  const f = pick(vendidosNoServ);
  const g = pick(vendidosVePv);
  const h = pick(vendidosVePvNoServ);
  const r2 = (x) => Math.round((+x || 0) * 100) / 100;

  return {
    ok: true,
    db: normalizeDbQueryId(req.query.db) || 'default',
    ventana_dias: dias,
    desde_param: desdeStr,
    reglas: {
      excluye_servicios: whereNoServicios ? true : false,
      tipo_col_detectado: tipoCol || null,
      vendidos_en_ventana: {
        ve_only: true,
        ve_pv_union: !!qVendidosVentanaVePv,
      },
    },
    totales: {
      articulos_activos: +a.ARTICULOS || 0,
      unidades: r2(a.UNIDADES),
      valor: r2(a.VALOR),
    },
    con_stock_mayor_cero: {
      articulos_activos: +b.ARTICULOS || 0,
      unidades: r2(b.UNIDADES),
      valor: r2(b.VALOR),
    },
    con_stock_y_ventas_en_ventana: {
      articulos_activos: +c.ARTICULOS || 0,
      unidades: r2(c.UNIDADES),
      valor: r2(c.VALOR),
    },
    totales_sin_servicios: {
      articulos_activos: +d.ARTICULOS || 0,
      unidades: r2(d.UNIDADES),
      valor: r2(d.VALOR),
    },
    con_stock_sin_servicios: {
      articulos_activos: +e.ARTICULOS || 0,
      unidades: r2(e.UNIDADES),
      valor: r2(e.VALOR),
    },
    con_stock_y_ventas_en_ventana_sin_servicios: {
      articulos_activos: +f.ARTICULOS || 0,
      unidades: r2(f.UNIDADES),
      valor: r2(f.VALOR),
    },
    con_stock_y_ventas_en_ventana_ve_pv: {
      articulos_activos: +g.ARTICULOS || 0,
      unidades: r2(g.UNIDADES),
      valor: r2(g.VALOR),
    },
    con_stock_y_ventas_en_ventana_ve_pv_sin_servicios: {
      articulos_activos: +h.ARTICULOS || 0,
      unidades: r2(h.UNIDADES),
      valor: r2(h.VALOR),
    },
    nota:
      'Si BI no cuadra con totales, normalmente es por excluir servicios/líneas/grupos o por definir "vendido" como VE+PV. Usa este endpoint para identificar cuál variante se acerca al KPI de BI.',
  };
});

// Diagnóstico duro de conectividad Firebird para inventario (no oculta errores).
app.get('/api/debug/firebird-inv', async (req, res) => {
  const dbo = getReqDbOpts(req);
  const dbId = req && req.query && req.query.db ? String(req.query.db) : 'default';
  try {

    const rel = await query(`SELECT COUNT(*) AS C FROM RDB$RELATIONS`, [], 12000, dbo);
    const art = await query(`SELECT COUNT(*) AS C FROM ARTICULOS`, [], 12000, dbo);
    const act = await query(`SELECT COUNT(*) AS C FROM ARTICULOS a WHERE COALESCE(a.ESTATUS,'A')='A'`, [], 12000, dbo);
    const sample = await query(`SELECT FIRST 3 a.ARTICULO_ID, a.NOMBRE, a.ESTATUS FROM ARTICULOS a ORDER BY a.ARTICULO_ID`, [], 12000, dbo);
    const precioSubDbg = await invPrecioSubSql(dbo);
    const inv = await query(`
      SELECT
        COUNT(DISTINCT a.ARTICULO_ID) AS TOTAL_ARTICULOS,
        SUM(CASE WHEN COALESCE(s.EXISTENCIA, 0) < COALESCE(n.INVENTARIO_MINIMO, 0) AND COALESCE(n.INVENTARIO_MINIMO, 0) > 0 THEN 1 ELSE 0 END) AS BAJO_MINIMO,
        SUM(COALESCE(s.EXISTENCIA, 0) * COALESCE(pr.PRECIO1, 0)) AS VALOR_INVENTARIO,
        SUM(CASE WHEN COALESCE(n.INVENTARIO_MINIMO, 0) > 0 AND COALESCE(s.EXISTENCIA, 0) <= 0 THEN 1 ELSE 0 END) AS SIN_STOCK
      FROM ARTICULOS a
      LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
      LEFT JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
      LEFT JOIN ${precioSubDbg} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
      WHERE COALESCE(a.ESTATUS, 'A') = 'A'
    `, [], 15000, dbo);
    const out = {
      ok: true,
      db: dbId,
      connection: {
        host: dbo && dbo.host ? String(dbo.host) : '',
        port: dbo && dbo.port ? Number(dbo.port) : 0,
        database: dbo && dbo.database ? String(dbo.database) : '',
        user: dbo && dbo.user ? String(dbo.user) : '',
      },
      counts: {
        relations: +(rel[0] && rel[0].C || 0),
        articulos_total: +(art[0] && art[0].C || 0),
        articulos_activos: +(act[0] && act[0].C || 0),
      },
      inv_resumen_raw: inv[0] || {},
      sample_articulos: Array.isArray(sample) ? sample : [],
    };

    return res.json(out);
  } catch (e) {
    const errMsg = e && e.message ? String(e.message) : String(e || 'Error desconocido');

    return res.status(500).json({
      ok: false,
      db: dbId,
      connection: {
        host: dbo && dbo.host ? String(dbo.host) : '',
        port: dbo && dbo.port ? Number(dbo.port) : 0,
        database: dbo && dbo.database ? String(dbo.database) : '',
        user: dbo && dbo.user ? String(dbo.user) : '',
      },
      error: errMsg,
    });
  }
});

/**
 * Compara existencia operativa (SALDOS_IN agregado, mismo criterio que /api/inv/top-stock) vs LINES_EXISTENCIA si existe.
 * Power BI a menudo muestra entradas/salidas del periodo del filtro (p. ej. neto 0 en el año) mientras SALDOS_IN es saldo acumulado Microsip.
 * Uso: GET /api/debug/inv-articulo?db=default&q=LAPIZ  o  ?id=12345
 */
app.get('/api/debug/inv-articulo', async (req, res) => {
  const dbo = getReqDbOpts(req);
  const dbId = req && req.query && req.query.db != null ? String(req.query.db) : 'default';
  if (!dbo) {
    return res.status(400).json({ ok: false, db: dbId, error: 'Sin opciones de base (db inválida).' });
  }
  const id = req.query && req.query.id != null ? parseInt(req.query.id, 10) : NaN;
  const q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
  if (!Number.isFinite(id) && q.length < 3) {
    return res.status(400).json({
      ok: false,
      db: dbId,
      error: 'Indica ?id=ARTICULO_ID o ?q=texto (mín. 3 caracteres, búsqueda por nombre).',
    });
  }
  try {
    const balSub = SQL_SALDOS_BAL_SUB;
    let rows;
    if (Number.isFinite(id) && id > 0) {
      rows = await query(
        `
        SELECT FIRST 1 a.ARTICULO_ID, a.NOMBRE, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD_VENTA,
          COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA_SALDOS_IN,
          COALESCE(s.ENTRADAS_TOTAL, 0) AS ENTRADAS_ACUM_SALDOS_IN,
          COALESCE(s.SALIDAS_TOTAL, 0) AS SALIDAS_ACUM_SALDOS_IN
        FROM ARTICULOS a
        LEFT JOIN ${balSub} s ON s.ARTICULO_ID = a.ARTICULO_ID
        WHERE a.ARTICULO_ID = ? AND COALESCE(a.ESTATUS, 'A') = 'A'
      `,
        [id],
        20000,
        dbo,
      );
    } else {
      const frag = q.toUpperCase().replace(/'/g, "''");
      rows = await query(
        `
        SELECT FIRST 1 a.ARTICULO_ID, a.NOMBRE, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD_VENTA,
          COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA_SALDOS_IN,
          COALESCE(s.ENTRADAS_TOTAL, 0) AS ENTRADAS_ACUM_SALDOS_IN,
          COALESCE(s.SALIDAS_TOTAL, 0) AS SALIDAS_ACUM_SALDOS_IN
        FROM ARTICULOS a
        LEFT JOIN ${balSub} s ON s.ARTICULO_ID = a.ARTICULO_ID
        WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND UPPER(a.NOMBRE) CONTAINING '${frag}'
        ORDER BY a.ARTICULO_ID
      `,
        [],
        20000,
        dbo,
      );
    }
    const art = rows && rows[0] ? rows[0] : null;
    let linesExistencia = null;
    if (art && art.ARTICULO_ID != null) {
      const aid = art.ARTICULO_ID;
      try {
        const le = await query(
          'SELECT SUM(COALESCE(EXISTENCIA, 0)) AS SUMA_EXISTENCIA FROM LINES_EXISTENCIA WHERE ARTICULO_ID = ?',
          [aid],
          15000,
          dbo,
        );
        linesExistencia = { columna: 'EXISTENCIA', filas: le && le[0] ? le[0] : {} };
      } catch (e1) {
        try {
          const le2 = await query(
            'SELECT SUM(COALESCE(CANTIDAD, 0)) AS SUMA_CANTIDAD FROM LINES_EXISTENCIA WHERE ARTICULO_ID = ?',
            [aid],
            15000,
            dbo,
          );
          linesExistencia = { columna: 'CANTIDAD', filas: le2 && le2[0] ? le2[0] : {}, nota: 'EXISTENCIA no disponible; probado CANTIDAD' };
        } catch (e2) {
          linesExistencia = {
            error: 'No se pudo leer LINES_EXISTENCIA (tabla o columnas distintas en esta versión Microsip).',
            intento_existencia: e1 && e1.message ? String(e1.message) : String(e1),
            intento_cantidad: e2 && e2.message ? String(e2.message) : String(e2),
          };
        }
      }
    }
    return res.json({
      ok: true,
      db: dbId,
      nota_power_bi_vs_api:
        'El tablero HTML usa SALDOS_IN: existencia = entradas acumuladas − salidas acumuladas por artículo (saldo operativo Microsip). ' +
        'Un modelo Power BI que filtre por año/mes suele mostrar solo movimientos de ese periodo; si entradas y salidas del periodo se cancelan, el neto del periodo es 0 aunque el saldo global en almacén sea distinto.',
      articulo: art,
      lines_existencia: linesExistencia,
    });
  } catch (e) {
    const errMsg = e && e.message ? String(e.message) : String(e || 'Error');
    return res.status(500).json({ ok: false, db: dbId, error: errMsg });
  }
});

/** Diagnóstico liviano: explica por qué "sin movimiento" puede salir en 0 sin ser bug de UI (timeout vs reglas). */
app.get('/api/debug/inv-sin-movimiento-counts', async (req, res) => {
  const dbo = getReqDbOpts(req);
  const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 180, 1), 730);
  const dbId = req && req.query && req.query.db != null ? String(req.query.db) : 'default';
  if (!dbo) {
    return res.status(400).json({ ok: false, db: dbId, error: 'Sin opciones de base (db inválida o no configurada).' });
  }
  try {
    const csp = await resolveConsumosSchema(dbo);
    const subDoc = consumosSubSql(invHeavySubTipo(), csp);
    const [r1, r2, r3] = await Promise.all([
      query(`SELECT COUNT(*) AS N FROM ARTICULOS a WHERE COALESCE(a.ESTATUS, 'A') = 'A'`, [], 20000, dbo),
      query(
        `SELECT COUNT(*) AS N FROM ARTICULOS a
         LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
         WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(ex.EXISTENCIA, 0) > 0`,
        [],
        45000,
        dbo,
      ),
      query(
        `SELECT COUNT(DISTINCT d.ARTICULO_ID) AS N FROM ${subDoc} d
         WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
           AND COALESCE(d.ARTICULO_ID, 0) <> 0
           AND CAST(d.FECHA AS DATE) > (CURRENT_DATE - ${dias})`,
        [],
        invHeavyQueryTimeoutMs(),
        dbo,
      ),
    ]);
    const activos = +(r1[0] && r1[0].N) || 0;
    const conStock = +(r2[0] && r2[0].N) || 0;
    const conVentaReciente = +(r3[0] && r3[0].N) || 0;
    return res.json({
      ok: true,
      db: dbId,
      dias_ventana: dias,
      inv_heavy_subtipo_ve_o_union: invHeavySubTipo() || 'VE+PV',
      sin_mov_fast_default: invSinMovFastDefault(),
      articulos_activos: activos,
      activos_con_existencia_mayor_cero: conStock,
      skus_distintos_con_venta_en_ventana: conVentaReciente,
      lectura: conStock <= 0
        ? 'No hay artículos activos con existencia > 0 en SALDOS_IN agregado; la tabla sin movimiento vacía es coherente.'
        : conVentaReciente >= conStock
          ? 'Casi todos los SKUs con stock tienen al menos una línea de venta en la ventana; lista "sin movimiento" puede ser legítimamente vacía.'
          : 'Hay stock y no todos los SKUs vendieron en la ventana; si la UI sigue en 0, revisar proxy/timeout o respuesta JSON (no array).',
    });
  } catch (e) {
    const errMsg = e && e.message ? String(e.message) : String(e || 'Error');
    return res.status(500).json({ ok: false, db: dbId, error: errMsg });
  }
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
  `, [], INV_LIST_Q_MS, dbo).catch(() => []);
});

get('/api/inv/existencias', async (req) => {
  const dbo = getReqDbOpts(req);
  const q = (req.query.q || '').trim();
  if (q.length < 2) return [];
  const like = `%${q.toUpperCase().replace(/'/g, "''")}%`;
  const precioSub = await invPrecioSubSql(dbo);
  return query(`
    SELECT FIRST 50 a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA, COALESCE(n.INVENTARIO_MINIMO, 0) AS EXISTENCIA_MINIMA, COALESCE(pr.PRECIO1, 0) AS PRECIO_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} n ON n.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${precioSub} pr ON pr.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND (UPPER(a.NOMBRE) LIKE ? OR UPPER(CAST(a.ARTICULO_ID AS VARCHAR(50))) LIKE ?)
    ORDER BY a.NOMBRE
  `, [like, like], INV_LIST_Q_MS, dbo).catch(() => []);
});

get('/api/inv/top-stock', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const costoSub = await invCostoSubSql(dbo);
  return query(`
    SELECT FIRST ${limit} a.ARTICULO_ID, a.NOMBRE AS DESCRIPCION, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(s.EXISTENCIA, 0) AS EXISTENCIA,
      COALESCE(s.EXISTENCIA, 0) * COALESCE(cs.COSTO1, 0) AS VALOR_TOTAL,
      COALESCE(cs.COSTO1, 0) AS PRECIO_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${costoSub} cs ON cs.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(s.EXISTENCIA, 0) > 0
    ORDER BY VALOR_TOTAL DESC
  `, [], INV_LIST_Q_MS, dbo).catch(() => []);
});

// Consumo semanal desde ventas (VE+PV por defecto; MICROSIP_INV_CONSUMO_VE_ONLY=1 → solo VE). Respeta periodo del filtro.
// Respuesta: { rows, meta } — meta evita confusión “sin datos” vs periodo mal resuelto; errores SQL → 500 (visible en UI).
get('/api/inv/consumo-semanal', async (req) => {
  const dbo = getReqDbOpts(req);
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const { desdeStr, hastaStr, periodDays } = invPeriodDaysFromReq(req);
  const weeksInPeriod = Math.max(periodDays / 7.0, 0.01);
  const csp = await resolveConsumosSchema(dbo);
  const subDoc = consumosSubSql(invUseVePvUnion() ? '' : 'VE', csp);
  // Firebird: divisiones en entero / ratios enormes → "Arithmetic exception, numeric overflow".
  // Todo en DOUBLE PRECISION + NULLIF evita desborde al calcular semanas de cobertura.
  const rows = await query(`
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID,
      CAST(COALESCE(s.EXISTENCIA, 0) AS DOUBLE PRECISION) AS EXISTENCIA,
      CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION) AS CONSUMO_SEMANAL_PROM,
      CAST(
        CASE WHEN CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) > 0 THEN
          COALESCE(CAST(s.EXISTENCIA AS DOUBLE PRECISION), 0)
            / NULLIF(CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION), 0)
        ELSE 9999.0
        END AS DOUBLE PRECISION
      ) AS SEMANAS_STOCK
    FROM ${subDoc} d
    JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
    LEFT JOIN ${SQL_EXIST_SUB} s ON s.ARTICULO_ID = a.ARTICULO_ID
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    GROUP BY a.NOMBRE, a.ARTICULO_ID, s.EXISTENCIA
    HAVING SUM(d.UNIDADES) > 0
    ORDER BY SEMANAS_STOCK ASC
  `, [weeksInPeriod, weeksInPeriod, desdeStr, hastaStr], INV_CONSUMO_Q_MS, dbo);
  return {
    rows: rows || [],
    meta: {
      desde: desdeStr,
      hasta: hastaStr,
      periodDays,
      weeksInPeriod: Math.round(weeksInPeriod * 100) / 100,
      database: dbo && dbo.database ? path.basename(String(dbo.database)) : '',
    },
  };
});

// Diagnóstico rápido: cuenta renglones de consumo en el periodo (misma subconsulta que consumo semanal).
get('/api/inv/consumo-diagnostico', async (req) => {
  const dbo = getReqDbOpts(req);
  const { desdeStr, hastaStr } = invPeriodDaysFromReq(req);
  const csp = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(invUseVePvUnion() ? '' : 'VE', csp);
  const rows = await query(
    `
    SELECT COUNT(*) AS C FROM (
      SELECT 1
      FROM ${sub} d
      WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
        AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
        AND COALESCE(d.UNIDADES, 0) > 0
    ) x
  `,
    [desdeStr, hastaStr],
    60000,
    dbo
  );
  const c = rows && rows[0] ? +rows[0].C : 0;
  const dbFile = dbo && dbo.database ? path.basename(String(dbo.database)) : '';
  return {
    ok: true,
    desde: desdeStr,
    hasta: hastaStr,
    renglones_venta_en_periodo: c,
    database: dbFile,
    queryEcho: req.query || {},
    nota:
      'Mismo criterio que consumo semanal (VE+PV salvo env). Si renglones_venta_en_periodo es 0 pero en Ventas > Margen por artículo sí hay filas en el mismo periodo, compara queryEcho con la barra de filtros (?preset, ?anio, ?mes, ?desde, ?hasta).',
  };
});

// Forecast consumo — periodo = filtro (desde/hasta / preset).
get('/api/inv/consumo', async (req) => {
  const dbo = getReqDbOpts(req);
  const { desdeStr, hastaStr, periodDays } = invPeriodDaysFromReq(req);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const lead = Math.min(parseInt(req.query.lead) || 15, 60);
  const csp = await resolveConsumosSchema(dbo);
  const subDoc = consumosSubSql(invUseVePvUnion() ? '' : 'VE', csp);
  const rows = await query(`
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL, COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      SUM(d.UNIDADES) AS CONSUMO_PERIODO,
      CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION) AS CONSUMO_DIARIO,
      CASE WHEN CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) > 0 THEN
        CAST(
          CASE WHEN COALESCE(CAST(ex.EXISTENCIA AS DOUBLE PRECISION), 0) / NULLIF(CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION), 0) > 2147483647
            THEN 2147483647
            ELSE COALESCE(CAST(ex.EXISTENCIA AS DOUBLE PRECISION), 0) / NULLIF(CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION), 0)
          END AS INTEGER
        )
      ELSE 9999 END AS DIAS_STOCK,
      CASE WHEN CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) > 0 THEN
        CAST(
          CASE WHEN (CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION)) * CAST(? AS DOUBLE PRECISION) + 0.9999 > 2147483647
            THEN 2147483647
            ELSE (CAST(SUM(d.UNIDADES) AS DOUBLE PRECISION) / CAST(? AS DOUBLE PRECISION)) * CAST(? AS DOUBLE PRECISION) + 0.9999
          END AS INTEGER
        )
      ELSE 0 END AS STOCK_MINIMO_RECOMENDADO
    FROM ${subDoc} d
    JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
    LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    WHERE CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE) AND COALESCE(a.ESTATUS, 'A') = 'A'
    GROUP BY a.NOMBRE, a.ARTICULO_ID, a.UNIDAD_VENTA, ex.EXISTENCIA, mn.INVENTARIO_MINIMO
    HAVING SUM(d.UNIDADES) > 0
    ORDER BY DIAS_STOCK ASC
  `, [periodDays, periodDays, periodDays, periodDays, lead, periodDays, lead, desdeStr, hastaStr], INV_CONSUMO_Q_MS, dbo).catch((err) => {
    console.error('[api/inv/consumo]', err && (err.message || err));
    return [];
  });
  const rowArr = Array.isArray(rows) ? rows : [];
  return rowArr.map(r => ({
    ...r,
    ALERTA: +r.DIAS_STOCK < lead ? 'CRITICO' : +r.DIAS_STOCK < lead * 2 ? 'BAJO' : +r.EXISTENCIA_ACTUAL <= +r.MIN_ACTUAL ? 'BAJO_MINIMO' : 'OK',
    NECESITA_REPONER: +r.EXISTENCIA_ACTUAL < +r.STOCK_MINIMO_RECOMENDADO,
    CANTIDAD_REPONER: Math.max(0, +r.STOCK_MINIMO_RECOMENDADO - +r.EXISTENCIA_ACTUAL),
  }));
});

/**
 * Modo rápido devuelve filas sin DIAS_SIN_VENTA. Para la tabla ≥365 en cliente: segunda consulta
 * solo sobre los ARTICULO_ID ya devueltos (acotada). Desactivar: MICROSIP_INV_SIN_MOV_ENRICH_DIAS=0.
 */
async function enrichSinMovIdleDias(rows, dias, histDias, dbo, csp) {
  const dis = String(process.env.MICROSIP_INV_SIN_MOV_ENRICH_DIAS || '').trim().toLowerCase();
  if (dis === '0' || dis === 'false' || dis === 'no') return rows;
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const ids = [...new Set(rows.map((r) => +r.ARTICULO_ID).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return rows;
  const subDocHist = consumosSubSqlWithLookback(invHeavySubTipo(), csp, histDias);
  const idList = ids.join(',');
  const enrichMs = Math.min(invHeavyQueryTimeoutMs(), 120000);
  try {
    const idleRows = await query(
      `
      SELECT t.ARTICULO_ID, t.ULTIMO_MOVIMIENTO, (CURRENT_DATE - t.ULTIMO_MOVIMIENTO) AS DIAS_SIN_VENTA
      FROM (
        SELECT d.ARTICULO_ID, MAX(CAST(d.FECHA AS DATE)) AS ULTIMO_MOVIMIENTO
        FROM ${subDocHist} d
        WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
          AND COALESCE(d.ARTICULO_ID, 0) <> 0
          AND CAST(d.FECHA AS DATE) <= (CURRENT_DATE - ${dias})
          AND CAST(d.FECHA AS DATE) >= (CURRENT_DATE - ${histDias})
          AND d.ARTICULO_ID IN (${idList})
        GROUP BY d.ARTICULO_ID
      ) t
    `,
      [],
      enrichMs,
      dbo,
    );
    const map = new Map();
    for (const ir of idleRows || []) {
      map.set(+ir.ARTICULO_ID, { ult: ir.ULTIMO_MOVIMIENTO, dias: ir.DIAS_SIN_VENTA });
    }
    return rows.map((r) => {
      const m = map.get(+r.ARTICULO_ID);
      if (!m) return r;
      return {
        ...r,
        ULTIMO_MOVIMIENTO: m.ult != null ? m.ult : r.ULTIMO_MOVIMIENTO,
        DIAS_SIN_VENTA: m.dias != null ? m.dias : r.DIAS_SIN_VENTA,
      };
    });
  } catch (e) {
    console.error('[api/inv/sin-movimiento enrich dias]', e && (e.message || e));
    return rows;
  }
}

get('/api/inv/sin-movimiento', async (req) => {
  const dias = Math.min(parseInt(req.query.dias) || 180, 730);
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  /** Días hacia atrás para calcular último movimiento (tabla 365+ en cliente). Env: MICROSIP_INV_SIN_MOV_HIST_DIAS (máx. 1460). */
  const histParsed = parseInt(process.env.MICROSIP_INV_SIN_MOV_HIST_DIAS, 10);
  const histDias = Math.min(1460, Math.max(Number.isFinite(histParsed) ? histParsed : 600, dias + 1));
  async function sinMovimientoForDb(dbo) {
    const csp = await resolveConsumosSchema(dbo);
    // Render ultra-liviano (fast): evitar scan masivo (DISTINCT/UNION) y usar EXISTS con corte temprano
    // sobre un set de candidatos con stock. Esto privilegia "que responda" en Render.
    const useUltra = invIsRender() && invSinMovFastDefault() && !(process.env.MICROSIP_INV_SIN_MOV_ULTRA || '').match(/^(0|false|no)$/i);
    // Pushdown de fecha: evita full-scan de consumos cuando el filtro está fuera del subquery.
    // histDias se usa en modo completo; para modo rápido solo interesa la ventana "dias".
    const lookback = invSinMovFastDefault() ? dias : histDias;
    const subDoc = useUltra ? null : consumosSubSqlWithLookback(invHeavySubTipo(), csp, lookback);
    if (invSinMovFastDefault()) {
      if (useUltra) {
        // Candidatos: top existencia; filtro "no vendió" con EXISTS (ROWS 1) para cortar rápido.
        const candLim = Math.min(limit * 12, 2400);
        let rowsUltra = await query(`
    WITH cand AS (
      SELECT FIRST ${candLim}
        a.ARTICULO_ID,
        a.NOMBRE AS DESCRIPCION,
        COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
        COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL,
        COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL
      FROM ARTICULOS a
      JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
      LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
      WHERE COALESCE(a.ESTATUS, 'A') = 'A'
        AND COALESCE(ex.EXISTENCIA, 0) > 0
      ORDER BY ex.EXISTENCIA DESC NULLS LAST
    )
    SELECT FIRST ${limit}
      c.DESCRIPCION, c.ARTICULO_ID, c.UNIDAD,
      c.EXISTENCIA_ACTUAL, c.MIN_ACTUAL,
      CAST(NULL AS DATE) AS ULTIMO_MOVIMIENTO,
      CAST(NULL AS INTEGER) AS DIAS_SIN_VENTA
    FROM cand c
    WHERE NOT EXISTS (
      SELECT 1
      FROM DOCTOS_VE d
      JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
      WHERE ${invDocWhereSql('d')}
        AND d.FECHA >= (CURRENT_DATE - ${dias})
        AND det.ARTICULO_ID = c.ARTICULO_ID
    )
    ORDER BY c.EXISTENCIA_ACTUAL DESC NULLS LAST
  `, [], invHeavyQueryTimeoutMs(), dbo);
        rowsUltra = await enrichSinMovIdleDias(rowsUltra, dias, histDias, dbo, csp);
        return rowsUltra;
      }
      let rowsFast = await query(`
    WITH recent AS (
      SELECT DISTINCT d.ARTICULO_ID AS AID
      FROM ${subDoc} d
      WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
        AND COALESCE(d.ARTICULO_ID, 0) <> 0
        AND CAST(d.FECHA AS DATE) > (CURRENT_DATE - ${dias})
    )
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL, COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      CAST(NULL AS DATE) AS ULTIMO_MOVIMIENTO,
      CAST(NULL AS INTEGER) AS DIAS_SIN_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(ex.EXISTENCIA, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.AID = a.ARTICULO_ID)
    ORDER BY ex.EXISTENCIA DESC NULLS LAST
  `, [], invHeavyQueryTimeoutMs(), dbo);
      rowsFast = await enrichSinMovIdleDias(rowsFast, dias, histDias, dbo, csp);
      return rowsFast;
    }
    // Modo completo: recent + idle_um (2× scan) — usar MICROSIP_INV_SIN_MOV_FAST=0 en Render si el proxy aguanta.
    return query(`
    WITH recent AS (
      SELECT DISTINCT d.ARTICULO_ID AS AID
      FROM ${subDoc} d
      WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
        AND COALESCE(d.ARTICULO_ID, 0) <> 0
        AND CAST(d.FECHA AS DATE) > (CURRENT_DATE - ${dias})
    ),
    idle_um AS (
      SELECT d.ARTICULO_ID, MAX(CAST(d.FECHA AS DATE)) AS ULTIMO_MOVIMIENTO
      FROM ${subDoc} d
      WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
        AND COALESCE(d.ARTICULO_ID, 0) <> 0
        AND CAST(d.FECHA AS DATE) <= (CURRENT_DATE - ${dias})
        AND CAST(d.FECHA AS DATE) >= (CURRENT_DATE - ${histDias})
      GROUP BY d.ARTICULO_ID
    )
    SELECT FIRST ${limit} a.NOMBRE AS DESCRIPCION, a.ARTICULO_ID, COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(ex.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL, COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      um.ULTIMO_MOVIMIENTO,
      CASE WHEN um.ULTIMO_MOVIMIENTO IS NULL THEN NULL ELSE (CURRENT_DATE - um.ULTIMO_MOVIMIENTO) END AS DIAS_SIN_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_EXIST_SUB} ex ON ex.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN idle_um um ON um.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A' AND COALESCE(ex.EXISTENCIA, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.AID = a.ARTICULO_ID)
      AND (um.ULTIMO_MOVIMIENTO IS NULL OR (CURRENT_DATE - um.ULTIMO_MOVIMIENTO) > ${dias})
    ORDER BY DIAS_SIN_VENTA DESC NULLS FIRST, ex.EXISTENCIA DESC
  `, [], invHeavyQueryTimeoutMs(), dbo);
  }
  if (isAllDbs(req)) return runForAllDbs((dbo) => sinMovimientoForDb(dbo));
  return sinMovimientoForDb(getReqDbOpts(req));
});

/**
 * Render: no recorrer todo el catálogo en operación crítica (JOIN masivo ARTICULOS × bal × cs).
 * Ultra = candidatos = SKUs con consumo en ventana ∪ primeros N con existencia ≤ 0 en bal.
 * Desactivar: MICROSIP_INV_OPERACION_ULTRA=0. Tope ceros: MICROSIP_INV_OPERACION_CERO_CAP (100–1200, default 400).
 */
function invOperacionCriticaUltraEnabled() {
  const e = String(process.env.MICROSIP_INV_OPERACION_ULTRA || '').trim().toLowerCase();
  if (e === '0' || e === 'false' || e === 'no') return false;
  if (e === '1' || e === 'true' || e === 'yes') return true;
  return invIsRender();
}

function invOperacionCeroCap() {
  const n = parseInt(process.env.MICROSIP_INV_OPERACION_CERO_CAP, 10);
  if (Number.isFinite(n) && n >= 100 && n <= 1200) return n;
  return 400;
}

/** SQL principal operación crítica: ultra (CTE zid) o scan completo. */
function operacionCriticaSelectSql(subOc, limit, opLb, ultra) {
  const csInner = `SELECT
        d.ARTICULO_ID,
        SUM(CASE WHEN CAST(d.FECHA AS DATE) >= (CURRENT_DATE - 28) THEN ABS(COALESCE(d.UNIDADES, 0)) ELSE 0 END) AS CONSUMO_4S,
        SUM(CASE WHEN EXTRACT(YEAR FROM d.FECHA) = EXTRACT(YEAR FROM CURRENT_DATE)
                      AND EXTRACT(MONTH FROM d.FECHA) = EXTRACT(MONTH FROM CURRENT_DATE)
                 THEN ABS(COALESCE(d.UNIDADES, 0)) ELSE 0 END) AS CONSUMO_MES,
        MAX(CAST(d.FECHA AS DATE)) AS ULTIMO_MOVIMIENTO,
        (CURRENT_DATE - MAX(CAST(d.FECHA AS DATE))) AS DIAS_SIN_VENTA
      FROM ${subOc} d
      WHERE ABS(COALESCE(d.UNIDADES, 0)) > 0
        AND COALESCE(d.ARTICULO_ID, 0) <> 0
      GROUP BY d.ARTICULO_ID`;
  if (ultra) {
    const capCero = invOperacionCeroCap();
    return `
WITH bal AS (
  SELECT ARTICULO_ID,
    SUM(COALESCE(ENTRADAS_UNIDADES, 0)) AS ENTRADAS_TOTAL,
    SUM(COALESCE(SALIDAS_UNIDADES, 0)) AS SALIDAS_TOTAL,
    SUM(COALESCE(ENTRADAS_UNIDADES, 0) - COALESCE(SALIDAS_UNIDADES, 0)) AS EXISTENCIA
  FROM SALDOS_IN GROUP BY ARTICULO_ID
),
cs AS (
  ${csInner}
),
zid AS (
  SELECT ARTICULO_ID FROM cs
  UNION
  SELECT FIRST ${capCero} b.ARTICULO_ID FROM bal b WHERE COALESCE(b.EXISTENCIA, 0) <= 0
)
SELECT FIRST ${limit}
  a.ARTICULO_ID,
  a.NOMBRE AS DESCRIPCION,
  COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
  COALESCE(bal.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL,
  COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
  COALESCE(bal.ENTRADAS_TOTAL, 0) AS ENTRADAS_TOTAL,
  COALESCE(bal.SALIDAS_TOTAL, 0) AS SALIDAS_TOTAL,
  COALESCE(cs.CONSUMO_4S, 0) AS CONSUMO_4_SEMANAS,
  COALESCE(cs.CONSUMO_MES, 0) AS CONSUMO_MES_ACTUAL,
  cs.ULTIMO_MOVIMIENTO,
  cs.DIAS_SIN_VENTA
FROM zid
JOIN ARTICULOS a ON a.ARTICULO_ID = zid.ARTICULO_ID
LEFT JOIN bal ON bal.ARTICULO_ID = a.ARTICULO_ID
LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
LEFT JOIN cs ON cs.ARTICULO_ID = a.ARTICULO_ID
WHERE COALESCE(a.ESTATUS, 'A') = 'A'
  AND (
    COALESCE(bal.EXISTENCIA, 0) <= 0
    OR (
      (COALESCE(cs.CONSUMO_4S, 0) > 0 OR COALESCE(cs.CONSUMO_MES, 0) > 0)
      AND COALESCE(bal.EXISTENCIA, 0) <= COALESCE(mn.INVENTARIO_MINIMO, 0)
    )
  )
ORDER BY
  CASE WHEN COALESCE(bal.EXISTENCIA, 0) <= 0 AND (COALESCE(cs.CONSUMO_4S, 0) > 0 OR COALESCE(cs.CONSUMO_MES, 0) > 0) THEN 0 ELSE 1 END,
  COALESCE(cs.CONSUMO_4S, 0) DESC,
  COALESCE(cs.CONSUMO_MES, 0) DESC,
  COALESCE(bal.EXISTENCIA, 0) ASC`;
  }
  return `
    SELECT FIRST ${limit}
      a.ARTICULO_ID,
      a.NOMBRE AS DESCRIPCION,
      COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(bal.EXISTENCIA, 0) AS EXISTENCIA_ACTUAL,
      COALESCE(mn.INVENTARIO_MINIMO, 0) AS MIN_ACTUAL,
      COALESCE(bal.ENTRADAS_TOTAL, 0) AS ENTRADAS_TOTAL,
      COALESCE(bal.SALIDAS_TOTAL, 0) AS SALIDAS_TOTAL,
      COALESCE(cs.CONSUMO_4S, 0) AS CONSUMO_4_SEMANAS,
      COALESCE(cs.CONSUMO_MES, 0) AS CONSUMO_MES_ACTUAL,
      cs.ULTIMO_MOVIMIENTO,
      cs.DIAS_SIN_VENTA
    FROM ARTICULOS a
    LEFT JOIN ${SQL_SALDOS_BAL_SUB} bal ON bal.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN ${SQL_MINIMO_SUB} mn ON mn.ARTICULO_ID = a.ARTICULO_ID
    LEFT JOIN (
      ${csInner}
    ) cs ON cs.ARTICULO_ID = a.ARTICULO_ID
    WHERE COALESCE(a.ESTATUS, 'A') = 'A'
      AND (
        COALESCE(bal.EXISTENCIA, 0) <= 0
        OR (
          (COALESCE(cs.CONSUMO_4S, 0) > 0 OR COALESCE(cs.CONSUMO_MES, 0) > 0)
          AND COALESCE(bal.EXISTENCIA, 0) <= COALESCE(mn.INVENTARIO_MINIMO, 0)
        )
      )
    ORDER BY
      CASE WHEN COALESCE(bal.EXISTENCIA, 0) <= 0 AND (COALESCE(cs.CONSUMO_4S, 0) > 0 OR COALESCE(cs.CONSUMO_MES, 0) > 0) THEN 0 ELSE 1 END,
      COALESCE(cs.CONSUMO_4S, 0) DESC,
      COALESCE(cs.CONSUMO_MES, 0) DESC,
      COALESCE(bal.EXISTENCIA, 0) ASC`;
}

// Operación inventario: existencia 0 persistente + consumo activo + cobertura de críticos.
get('/api/inv/operacion-critica', async (req) => {
  const opLb = invOperacionConsumoLookbackDays();
  const ultraOp = invOperacionCriticaUltraEnabled();
  if (isAllDbs(req)) {
    const limit2 = Math.min(parseInt(req.query.limit) || 120, 300);
    async function opCritForDb(dbo) {
      const csp2 = await resolveConsumosSchema(dbo);
      const subOc2 = consumosSubSqlWithLookback(invHeavySubTipo(), csp2, opLb);
      const sqlOp2 = operacionCriticaSelectSql(subOc2, limit2, opLb, ultraOp);
      const rows2 = await query(sqlOp2, [], invHeavyQueryTimeoutMs(), dbo);
      return (rows2 || []).map(r => {
        const existencia=+r.EXISTENCIA_ACTUAL||0, minimo=+r.MIN_ACTUAL||0, c4=+r.CONSUMO_4_SEMANAS||0, cm=+r.CONSUMO_MES_ACTUAL||0;
        const semanal=c4>0?c4/4:0, diario=semanal/7, semanas=semanal>0?existencia/semanal:null, dias=diario>0?existencia/diario:null;
        const entradas=+r.ENTRADAS_TOTAL||0, nuncaInventario=entradas<=0.0001, consumeActivo=c4>0||cm>0;
        const critico=consumeActivo&&(existencia<=0||(dias!=null&&dias<14)||(minimo>0&&existencia<=minimo));
        let estado='Normal';
        if(existencia<=0&&consumeActivo&&nuncaInventario) estado='Sin inventario historico y con consumo activo';
        else if(existencia<=0&&consumeActivo) estado='Agotado con consumo activo';
        else if(existencia<=0) estado='Sin existencia sin consumo reciente';
        else if(critico) estado='Cobertura critica';
        else if(consumeActivo&&dias!=null&&dias<28) estado='Cobertura baja';
        return {...r, CONSUMO_SEMANAL_PROM:Math.round(semanal*100)/100, CONSUMO_DIARIO_PROM:Math.round(diario*100)/100, SEMANAS_COBERTURA_EST:semanas==null?null:Math.round(semanas*100)/100, DIAS_COBERTURA_EST:dias==null?null:Math.round(dias*100)/100, NUNCA_TUVO_ENTRADA:nuncaInventario, CONSUMO_ACTIVO:consumeActivo, CRITICO:critico, ESTADO_OPERATIVO:estado};
      });
    }
    const allRows = await runForAllDbs((dbo) => opCritForDb(dbo));
    const criticos = allRows.filter(r=>r.CRITICO).length;
    return { rows: allRows, resumen: { total: allRows.length, criticos } };
  }
  const dbo = getReqDbOpts(req);
  const csp = await resolveConsumosSchema(dbo);
  const subOc = consumosSubSqlWithLookback(invHeavySubTipo(), csp, opLb);
  const limit = Math.min(parseInt(req.query.limit) || 120, 300);
  const sqlOp = operacionCriticaSelectSql(subOc, limit, opLb, ultraOp);
  const rows = await query(sqlOp, [], invHeavyQueryTimeoutMs(), dbo);

  const enriched = (rows || []).map((r) => {
    const existencia = +r.EXISTENCIA_ACTUAL || 0;
    const minimo = +r.MIN_ACTUAL || 0;
    const c4 = +r.CONSUMO_4_SEMANAS || 0;
    const cm = +r.CONSUMO_MES_ACTUAL || 0;
    const semanal = c4 > 0 ? (c4 / 4) : 0;
    const diario = semanal / 7;
    const semanas = semanal > 0 ? (existencia / semanal) : null;
    const dias = diario > 0 ? (existencia / diario) : null;
    const entradas = +r.ENTRADAS_TOTAL || 0;
    const nuncaInventario = entradas <= 0.0001;
    const consumeActivo = c4 > 0 || cm > 0;
    const critico = consumeActivo && (existencia <= 0 || (dias != null && dias < 14) || (minimo > 0 && existencia <= minimo));
    let estado = 'Normal';
    if (existencia <= 0 && consumeActivo && nuncaInventario) estado = 'Sin inventario historico y con consumo activo';
    else if (existencia <= 0 && consumeActivo) estado = 'Agotado con consumo activo';
    else if (existencia <= 0) estado = 'Sin existencia sin consumo reciente';
    else if (critico) estado = 'Cobertura critica';
    else if (consumeActivo && dias != null && dias < 28) estado = 'Cobertura baja';
    return {
      ...r,
      CONSUMO_SEMANAL_PROM: Math.round(semanal * 100) / 100,
      CONSUMO_DIARIO_PROM: Math.round(diario * 100) / 100,
      SEMANAS_COBERTURA_EST: semanas == null ? null : Math.round(semanas * 100) / 100,
      DIAS_COBERTURA_EST: dias == null ? null : Math.round(dias * 100) / 100,
      NUNCA_TUVO_ENTRADA: nuncaInventario,
      CONSUMO_ACTIVO: consumeActivo,
      CRITICO: critico,
      ESTADO_OPERATIVO: estado,
    };
  });
  const resumen = {
    total_revisados: enriched.length,
    cero_existencia: enriched.filter(x => (+x.EXISTENCIA_ACTUAL || 0) <= 0).length,
    cero_y_consumo: enriched.filter(x => (+x.EXISTENCIA_ACTUAL || 0) <= 0 && x.CONSUMO_ACTIVO).length,
    nunca_entraron: enriched.filter(x => x.NUNCA_TUVO_ENTRADA).length,
    criticos: enriched.filter(x => x.CRITICO).length,
  };

  return { resumen, rows: enriched };
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
      agg.SALDO_TOTAL,
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
        doc.CLIENTE_ID,
        c.NOMBRE,
        COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
        SUM(doc.SALDO_NETO) AS SALDO_TOTAL,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_VENCIDO,
        MAX(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS_VENCIDO,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN 1 ELSE 0 END) AS NUM_DOCS_VENCIDOS
      FROM ${cxcDocSaldosInnerSQL('')} doc
      LEFT JOIN CLIENTES c ON c.CLIENTE_ID = doc.CLIENTE_ID
      LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = c.COND_PAGO_ID
      WHERE doc.SALDO_NETO > 0
      GROUP BY doc.CLIENTE_ID, c.NOMBRE, cp.NOMBRE
    ) agg
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
    WHERE agg.MONTO_VENCIDO > 0
    ORDER BY agg.MONTO_VENCIDO DESC, COALESCE(buy.TICKET_PROMEDIO_MES, 0) DESC
  `, [], 35000, dbo).catch(() => []);
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

/** Inteligencia de clientes: CxC en riesgo + inactivos sin compra >90d que hayan comprado al menos 1 vez. */
get('/api/clientes/inteligencia', async (req) => {
  const limit = Math.min(parseInt(req.query.limit) || 300, 800);
  async function inteligenciaForDb(dbo) {
    const [riesgo, inactivos] = await Promise.all([
      query(`
        SELECT FIRST 200
          agg.CLIENTE_ID, agg.NOMBRE, agg.CONDICION_PAGO,
          agg.SALDO_TOTAL, agg.MONTO_VENCIDO, agg.MAX_DIAS_VENCIDO, agg.NUM_DOCS_VENCIDOS,
          COALESCE(buy.NUM_COMPRAS_VIDA, 0) AS NUM_COMPRAS_VIDA,
          buy.ULTIMA_COMPRA,
          COALESCE((SELECT FIRST 1 COALESCE(z.IMP,0) FROM (
            SELECT CAST(v.FECHA AS DATE) AS FD, COALESCE(v.IMPORTE_NETO,0) AS IMP FROM DOCTOS_VE v
            WHERE v.CLIENTE_ID=agg.CLIENTE_ID AND v.CLIENTE_ID>0
              AND v.TIPO_DOCTO NOT IN ('C') AND v.ESTATUS NOT IN ('C','T')
            UNION ALL
            SELECT CAST(p.FECHA AS DATE), COALESCE(p.IMPORTE_NETO,0) FROM DOCTOS_PV p
            WHERE p.CLIENTE_ID=agg.CLIENTE_ID AND p.CLIENTE_ID>0
              AND p.TIPO_DOCTO NOT IN ('C') AND p.ESTATUS NOT IN ('C','T')
          ) z ORDER BY z.FD DESC), 0) AS ULTIMA_COMPRA_IMPORTE,
          CAST(COALESCE(buy.TICKET_PROMEDIO_MES,0)*12 AS DECIMAL(18,2)) AS PERDIDA_VENTA_ANUAL_EST,
          CASE WHEN agg.MAX_DIAS_VENCIDO>90 THEN 'CRITICO'
               WHEN agg.MAX_DIAS_VENCIDO>60 THEN 'ALTO'
               WHEN agg.MAX_DIAS_VENCIDO>30 THEN 'MEDIO' ELSE 'LEVE' END AS NIVEL
        FROM (
          SELECT doc.CLIENTE_ID, c.NOMBRE, COALESCE(cp.NOMBRE,'S/D') AS CONDICION_PAGO,
            SUM(doc.SALDO_NETO) AS SALDO_TOTAL,
            SUM(CASE WHEN doc.DIAS_VENCIDO>0 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_VENCIDO,
            MAX(CASE WHEN doc.DIAS_VENCIDO>0 THEN doc.DIAS_VENCIDO ELSE 0 END) AS MAX_DIAS_VENCIDO,
            SUM(CASE WHEN doc.DIAS_VENCIDO>0 THEN 1 ELSE 0 END) AS NUM_DOCS_VENCIDOS
          FROM ${cxcDocSaldosInnerSQL('')} doc
          LEFT JOIN CLIENTES c ON c.CLIENTE_ID=doc.CLIENTE_ID
          LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID=c.COND_PAGO_ID
          WHERE doc.SALDO_NETO>0
          GROUP BY doc.CLIENTE_ID, c.NOMBRE, cp.NOMBRE
        ) agg
        LEFT JOIN (
          SELECT t.CLIENTE_ID, COUNT(*) AS NUM_COMPRAS_VIDA, MAX(t.FECHA_D) AS ULTIMA_COMPRA,
            COALESCE(SUM(CASE WHEN t.FECHA_D>=(CURRENT_DATE-365) THEN t.IMP_NETO ELSE 0 END),0)/12.0 AS TICKET_PROMEDIO_MES
          FROM (
            SELECT CLIENTE_ID, CAST(FECHA AS DATE) AS FECHA_D, COALESCE(IMPORTE_NETO,0) AS IMP_NETO FROM DOCTOS_VE
            WHERE CLIENTE_ID>0 AND TIPO_DOCTO NOT IN ('C') AND ESTATUS NOT IN ('C','T')
            UNION ALL
            SELECT CLIENTE_ID, CAST(FECHA AS DATE), COALESCE(IMPORTE_NETO,0) FROM DOCTOS_PV
            WHERE CLIENTE_ID>0 AND TIPO_DOCTO NOT IN ('C') AND ESTATUS NOT IN ('C','T')
          ) t
          GROUP BY t.CLIENTE_ID
        ) buy ON buy.CLIENTE_ID=agg.CLIENTE_ID
        WHERE agg.MONTO_VENCIDO>0
        ORDER BY agg.MONTO_VENCIDO DESC
      `, [], 35000, dbo).catch(() => []),
      query(`
        SELECT FIRST 300
          c.CLIENTE_ID, c.NOMBRE,
          COALESCE(cp.NOMBRE,'S/D') AS CONDICION_PAGO,
          0 AS SALDO_TOTAL, 0 AS MONTO_VENCIDO, 0 AS MAX_DIAS_VENCIDO, 0 AS NUM_DOCS_VENCIDOS,
          ult.NUM_COMPRAS_VIDA,
          ult.ULTIMA AS ULTIMA_COMPRA,
          0 AS ULTIMA_COMPRA_IMPORTE,
          CAST(COALESCE(ult.TICKET_PROM,0)*12 AS DECIMAL(18,2)) AS PERDIDA_VENTA_ANUAL_EST,
          'INACTIVO' AS NIVEL
        FROM CLIENTES c
        JOIN (
          SELECT CLIENTE_ID, MAX(CAST(FECHA AS DATE)) AS ULTIMA, COUNT(*) AS NUM_COMPRAS_VIDA,
            COALESCE(SUM(CASE WHEN CAST(FECHA AS DATE)>=(CURRENT_DATE-365) THEN COALESCE(IMPORTE_NETO,0) ELSE 0 END),0)/12.0 AS TICKET_PROM
          FROM DOCTOS_VE
          WHERE CLIENTE_ID>0 AND TIPO_DOCTO NOT IN ('C') AND ESTATUS NOT IN ('C','T')
          GROUP BY CLIENTE_ID
          HAVING MAX(CAST(FECHA AS DATE))<(CURRENT_DATE-90)
        ) ult ON ult.CLIENTE_ID=c.CLIENTE_ID
        LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID=c.COND_PAGO_ID
        ORDER BY ult.ULTIMA ASC
      `, [], 35000, dbo).catch(() => []),
    ]);
    // Merge: riesgo clients first, then inactivos not already in riesgo
    const riesgoIds = new Set((riesgo || []).map(r => r.CLIENTE_ID));
    const merged = [
      ...(riesgo || []),
      ...(inactivos || []).filter(r => !riesgoIds.has(r.CLIENTE_ID)),
    ];
    return merged;
  }
  if (isAllDbs(req)) return runForAllDbs((dbo) => inteligenciaForDb(dbo));
  return inteligenciaForDb(getReqDbOpts(req));
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
      SELECT COUNT(DISTINCT doc.CLIENTE_ID) AS TOTAL_EN_RIESGO,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 90 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_CRITICO,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 60 AND doc.DIAS_VENCIDO <= 90 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_ALTO,
        SUM(CASE WHEN doc.DIAS_VENCIDO > 30 AND doc.DIAS_VENCIDO <= 60 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_MEDIO,
        SUM(CASE WHEN doc.DIAS_VENCIDO <= 30 THEN doc.SALDO_NETO ELSE 0 END) AS MONTO_LEVE
      FROM ${cxcDocSaldosInnerSQL('')} doc
      WHERE doc.SALDO_NETO > 0 AND doc.DIAS_VENCIDO > 0
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
  const q = (sql, params, timeoutMs = 28000) => query(sql, params, timeoutMs, dbOpts);
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let desdeStr, hastaStr;
  const { desde, hasta, anio, mes } = req.query;
  const mesesParam = parseInt(req.query.meses, 10);
  const hasRangoExplicito = !!(desde && reDate.test(desde) && hasta && reDate.test(hasta));
  const hasPeriodoExplicito = hasRangoExplicito || !!anio;
  const useMesesRolling = !hasPeriodoExplicito && !isNaN(mesesParam) && mesesParam > 0;
  if (hasRangoExplicito) {
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

  const salCols = await getTableColumns('SALDOS_CO', dbOpts).catch(() => new Set());
  const salAnoCol = firstExistingColumn(salCols, ['ANO', 'ANIO', 'EJERCICIO']) || 'ANO';
  const salMesCol = firstExistingColumn(salCols, ['MES', 'PERIODO', 'NUM_MES']) || 'MES';
  const salCargoCol = firstExistingColumn(salCols, ['CARGOS', 'CARGO', 'DEBE']) || 'CARGOS';
  const salAbonoCol = firstExistingColumn(salCols, ['ABONOS', 'ABONO', 'HABER']) || 'ABONOS';
  const salYearExpr = `s.${salAnoCol}`;
  const salMonthExpr = `s.${salMesCol}`;
  const salDeltaExpr = `COALESCE(s.${salCargoCol}, 0) - COALESCE(s.${salAbonoCol}, 0)`;
  const salGastoExpr = `ABS(${salDeltaExpr})`;
  const detCols = await getTableColumns('DOCTOS_CO_DET', dbOpts).catch(() => new Set());
  const detCargoCol = firstExistingColumn(detCols, ['CARGO', 'CARGOS', 'DEBE']);
  const detAbonoCol = firstExistingColumn(detCols, ['ABONO', 'ABONOS', 'HABER']);
  const detImporteCol = firstExistingColumn(detCols, ['IMPORTE', 'MONTO']);
  const detDeltaExprRaw = (detCargoCol && detAbonoCol)
    ? `COALESCE(d.${detCargoCol}, 0) - COALESCE(d.${detAbonoCol}, 0)`
    : (detImporteCol ? `COALESCE(d.${detImporteCol}, 0)` : '0');
  // Si CARGO/ABONO existen pero vienen en 0, usar IMPORTE para no perder pólizas.
  const detDeltaExpr = detImporteCol
    ? `(CASE WHEN ABS(${detDeltaExprRaw}) > 0 THEN ${detDeltaExprRaw} ELSE COALESCE(d.${detImporteCol}, 0) END)`
    : detDeltaExprRaw;
  const detGastoExpr = `ABS(${detDeltaExpr})`;
  const detDateExpr = detCols.has('FECHA') ? 'd.FECHA' : 'c.FECHA';
  const detNeedsDoctoJoin = !detCols.has('FECHA');
  const cuCoCols = await getTableColumns('CUENTAS_CO', dbOpts).catch(() => new Set());
  /** Algunas bases guardan la máscara en CUENTA_JT y CUENTA_PT va vacío → los filtros 52/6* no encontraban nada. */
  const cuentaExprCo = cuCoCols.has('CUENTA_JT')
    ? `COALESCE(NULLIF(TRIM(COALESCE(cu.CUENTA_PT, '')), ''), NULLIF(TRIM(COALESCE(cu.CUENTA_JT, '')), ''), '')`
    : `TRIM(COALESCE(cu.CUENTA_PT, ''))`;
  // Misma lógica que gastoBucket(): "Otros Gastos" en 5203* va a partidas extraordinarias (CO_C1), no a administración (CO_A3).
  const sqlCoNombreUp = `UPPER(TRIM(COALESCE(NULLIF(cu.NOMBRE, ''), NULLIF(cu.CUENTA_JT, ''), '')))`;
  const sqlCoA35203SoloAdmin = `cu.CUENTA_PT STARTING WITH '5203' AND ${sqlCoNombreUp} <> 'OTROS GASTOS'`;
  const sqlCoC15201Mas5203Otros = `(cu.CUENTA_PT STARTING WITH '5401' OR (cu.CUENTA_PT STARTING WITH '5203' AND ${sqlCoNombreUp} = 'OTROS GASTOS'))`;

  // FIX: usar el mismo divisor IVA que ventasSub() para que resultados.html
  // sea consistente con ventas.html, director.html, vendedores.html, etc.
  // Antes usaba sqlVentaImporteResultadosExpr (sin divisor) → ventas 16% más altas.
  const impRes = sqlVentaImporteBaseExpr('d');
  const ventasSubRes = `(
    SELECT
      d.FECHA,
      ${impRes} AS IMPORTE_NETO,
      COALESCE(d.VENDEDOR_ID, 0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      d.DOCTO_VE_ID,
      CAST(NULL AS INTEGER) AS DOCTO_PV_ID,
      'VE' AS TIPO_SRC
    FROM DOCTOS_VE d
    WHERE d.TIPO_DOCTO IN ('V', 'F')
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
    UNION ALL
    SELECT
      d.FECHA,
      ${impRes} AS IMPORTE_NETO,
      COALESCE(
        CASE WHEN d.TIPO_DOCTO = 'F' THEN
          (SELECT d2.VENDEDOR_ID
           FROM DOCTOS_PV_LIGAS liga
           JOIN DOCTOS_PV d2 ON d2.DOCTO_PV_ID = liga.DOCTO_PV_FTE_ID
           WHERE liga.DOCTO_PV_DEST_ID = d.DOCTO_PV_ID
           ROWS 1)
        ELSE d.VENDEDOR_ID
        END,
        d.VENDEDOR_ID,
      0) AS VENDEDOR_ID,
      COALESCE(d.CLIENTE_ID, 0) AS CLIENTE_ID,
      d.FOLIO,
      d.TIPO_DOCTO,
      d.ESTATUS,
      CAST(NULL AS INTEGER) AS DOCTO_VE_ID,
      d.DOCTO_PV_ID,
      'PV' AS TIPO_SRC
    FROM DOCTOS_PV d
    WHERE d.TIPO_DOCTO IN ('V', 'F')
      AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
      AND COALESCE(d.APLICADO, 'N') = 'S'
  )`;

  // Costo principal: renglones VE/PV con costo unitario histórico desde entradas (misma base lógica que margen-producto).
  let costosLineasMes = [];
  try {
    const [veCols, pvCols, veDetCols, pvDetCols, inCols, inDetCols] = await Promise.all([
      getTableColumns('DOCTOS_VE', dbOpts),
      getTableColumns('DOCTOS_PV', dbOpts),
      getTableColumns('DOCTOS_VE_DET', dbOpts),
      getTableColumns('DOCTOS_PV_DET', dbOpts),
      getTableColumns('DOCTOS_IN', dbOpts),
      getTableColumns('DOCTOS_IN_DET', dbOpts),
    ]);
    const inDetIdCol = firstExistingColumn(inDetCols, ['DOCTO_IN_DET_ID', 'RENGLON', 'POSICION']);
    const inCostoUnitCol = firstExistingColumn(inDetCols, ['COSTO_UNITARIO', 'COSTO_U']);
    const inCostoTotalCol = firstExistingColumn(inDetCols, ['COSTO_TOTAL', 'IMPORTE']);
    const inQtyCol = firstExistingColumn(inDetCols, ['CANTIDAD', 'UNIDADES']);
    const inClaveCol = firstExistingColumn(inDetCols, ['CLAVE_ARTICULO']);
    const inHasCancel = inCols.has('CANCELADO');
    const inHasAplicado = inCols.has('APLICADO');
    const inHasFecha = inCols.has('FECHA');
    const veDetQtyCol = firstExistingColumn(veDetCols, ['UNIDADES', 'CANTIDAD']) || 'UNIDADES';
    const pvDetQtyCol = firstExistingColumn(pvDetCols, ['UNIDADES', 'CANTIDAD']) || 'UNIDADES';
    const veDetClaveCol = firstExistingColumn(veDetCols, ['CLAVE_ARTICULO']);
    const pvDetClaveCol = firstExistingColumn(pvDetCols, ['CLAVE_ARTICULO']);

    const doDocOk = (hdrCols) => {
      const conds = [];
      if (hdrCols.has('TIPO_DOCTO')) conds.push(`d.TIPO_DOCTO IN ('F', 'V')`);
      if (hdrCols.has('ESTATUS')) conds.push(`COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')`);
      if (hdrCols.has('APLICADO')) conds.push(`COALESCE(d.APLICADO, 'S') = 'S'`);
      return conds.length ? `(${conds.join(' AND ')})` : '(1=1)';
    };

    function costoUnitSubquery(detArticuloExpr, detClaveExpr, fechaDocExpr) {
      const where = [`ind.ARTICULO_ID = ${detArticuloExpr}`];
      if (inClaveCol && detClaveExpr) where.push(`COALESCE(ind.${inClaveCol}, '') = COALESCE(${detClaveExpr}, '')`);
      if (inHasCancel) where.push(`COALESCE(di.CANCELADO, 'N') = 'N'`);
      if (inHasAplicado) where.push(`COALESCE(di.APLICADO, 'S') = 'S'`);
      if (inHasFecha) where.push(`CAST(di.FECHA AS DATE) <= CAST(${fechaDocExpr} AS DATE)`);

      const unitExpr = inCostoUnitCol
        ? `NULLIF(ind.${inCostoUnitCol}, 0)`
        : ((inCostoTotalCol && inQtyCol)
          ? `CASE WHEN COALESCE(ind.${inQtyCol}, 0) <> 0 THEN COALESCE(ind.${inCostoTotalCol}, 0) / COALESCE(ind.${inQtyCol}, 1) ELSE NULL END`
          : 'NULL');
      const orderParts = [];
      if (inHasFecha) orderParts.push('di.FECHA DESC');
      if (inDetIdCol) orderParts.push(`ind.${inDetIdCol} DESC`);
      if (!orderParts.length) orderParts.push('di.DOCTO_IN_ID DESC');
      return `COALESCE((SELECT FIRST 1 COALESCE(${unitExpr}, 0) FROM DOCTOS_IN di JOIN DOCTOS_IN_DET ind ON ind.DOCTO_IN_ID = di.DOCTO_IN_ID WHERE ${where.join(' AND ')} ORDER BY ${orderParts.join(', ')}), 0)`;
    }

    const veCostExpr = `COALESCE(det.${veDetQtyCol}, 0) * (${costoUnitSubquery('det.ARTICULO_ID', veDetClaveCol ? `det.${veDetClaveCol}` : null, 'd.FECHA')})`;
    const pvCostExpr = `COALESCE(det.${pvDetQtyCol}, 0) * (${costoUnitSubquery('det.ARTICULO_ID', pvDetClaveCol ? `det.${pvDetClaveCol}` : null, 'd.FECHA')})`;
    const [costVeRows, costPvRows] = await Promise.all([
      q(`
        SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(${veCostExpr}), 0) AS COSTO_VENTAS
        FROM DOCTOS_VE d
        JOIN DOCTOS_VE_DET det ON det.DOCTO_VE_ID = d.DOCTO_VE_ID
        WHERE ${doDocOk(veCols)} AND ${dateCond}
        GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
        ORDER BY 1, 2
      `, dateParams).catch(() => []),
      q(`
        SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(${pvCostExpr}), 0) AS COSTO_VENTAS
        FROM DOCTOS_PV d
        JOIN DOCTOS_PV_DET det ON det.DOCTO_PV_ID = d.DOCTO_PV_ID
        WHERE ${doDocOk(pvCols)} AND ${dateCond}
        GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
        ORDER BY 1, 2
      `, dateParams).catch(() => []),
    ]);
    const lineCostMap = {};
    [...(costVeRows || []), ...(costPvRows || [])].forEach((r) => {
      const k = `${r.ANIO}-${r.MES}`;
      lineCostMap[k] = (lineCostMap[k] || 0) + (+r.COSTO_VENTAS || 0);
    });
    costosLineasMes = Object.entries(lineCostMap).map(([k, v]) => {
      const [anioK, mesK] = k.split('-');
      return { ANIO: +anioK, MES: +mesK, COSTO_VENTAS: v };
    });
  } catch (_) {
    costosLineasMes = [];
  }

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

  // 6* y 5xx (no costo 51 ni bloque 52–54); 7* = gastos en planes tipo PCG (México / varios catálogos Microsip).
  const sqlGastosMicrosipExtendWhere = `(
      (${cuentaExprCo}) STARTING WITH '6'
      OR (
        (${cuentaExprCo}) STARTING WITH '5'
        AND NOT (${cuentaExprCo}) STARTING WITH '51'
        AND NOT ((${cuentaExprCo}) STARTING WITH '52' OR (${cuentaExprCo}) STARTING WITH '53' OR (${cuentaExprCo}) STARTING WITH '54')
      )
      OR (${cuentaExprCo}) STARTING WITH '7'
    )`;
  const [ventasMes, descuentosMes, costosINMes, costosINDirect, cobrosMes, costosSaldos5101, ingresosSaldos4, gastosSaldos52, gastosDoctos52, gastosSaldosExtend, gastosDoctosExtend] = await Promise.all([
    q(`
      SELECT EXTRACT(YEAR FROM d.FECHA) AS ANIO, EXTRACT(MONTH FROM d.FECHA) AS MES,
        COALESCE(SUM(d.IMPORTE_NETO), 0) AS VENTAS_BRUTAS,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'VE' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_VE,
        COALESCE(SUM(CASE WHEN d.TIPO_SRC = 'PV' THEN d.IMPORTE_NETO ELSE 0 END), 0) AS VENTAS_PV,
        COUNT(*) AS NUM_FACTURAS
      FROM ${ventasSubRes} d
      WHERE ${dateCond}
      GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA) ORDER BY 1, 2
    `, dateParams).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM x.FECHA) AS ANIO, EXTRACT(MONTH FROM x.FECHA) AS MES,
        COALESCE(SUM(x.IMPORTE), 0) AS DESCUENTOS_DEV
      FROM (
        SELECT d.FECHA, ${sqlVentaImporteBaseExpr('d')} AS IMPORTE
        FROM DOCTOS_VE d
        WHERE d.TIPO_DOCTO IN ('D')
          AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
          AND COALESCE(d.APLICADO, 'N') = 'S'
        UNION ALL
        SELECT d.FECHA, ${sqlVentaImporteBaseExpr('d')} AS IMPORTE
        FROM DOCTOS_PV d
        WHERE d.TIPO_DOCTO IN ('D')
          AND COALESCE(d.ESTATUS, 'N') NOT IN ('C', 'D', 'S')
          AND COALESCE(d.APLICADO, 'N') = 'S'
      ) x
      WHERE CAST(x.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(x.FECHA AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM x.FECHA), EXTRACT(MONTH FROM x.FECHA) ORDER BY 1, 2
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
      SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
        COALESCE(SUM(${salDeltaExpr}), 0) AS COSTO_VENTAS
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '5101'
        AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY ${salYearExpr}, ${salMonthExpr}
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
    q(`
      SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
        COALESCE(SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '4' THEN (COALESCE(s.${salAbonoCol},0) - COALESCE(s.${salCargoCol},0)) ELSE 0 END), 0) AS VENTAS_NETAS_CONTA
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY ${salYearExpr}, ${salMonthExpr}
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
    q(`
      SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5201' THEN ${salGastoExpr} ELSE 0 END) AS CO_A1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5202' THEN ${salGastoExpr} ELSE 0 END) AS CO_A2,
        SUM(CASE WHEN ${sqlCoA35203SoloAdmin} THEN ${salGastoExpr} ELSE 0 END) AS CO_A3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5204' THEN ${salGastoExpr} ELSE 0 END) AS CO_A4,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5205' THEN ${salGastoExpr} ELSE 0 END) AS CO_A5,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '52'
           AND NOT (cu.CUENTA_PT STARTING WITH '5201' OR cu.CUENTA_PT STARTING WITH '5202' OR cu.CUENTA_PT STARTING WITH '5203'
             OR cu.CUENTA_PT STARTING WITH '5204' OR cu.CUENTA_PT STARTING WITH '5205')
         THEN ${salGastoExpr} ELSE 0 END) AS CO_A6,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5301' THEN ${salGastoExpr} ELSE 0 END) AS CO_B1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5302' THEN ${salGastoExpr} ELSE 0 END) AS CO_B2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5303' THEN ${salGastoExpr} ELSE 0 END) AS CO_B3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5304' THEN ${salGastoExpr} ELSE 0 END) AS CO_B4,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '53'
           AND NOT (cu.CUENTA_PT STARTING WITH '5301' OR cu.CUENTA_PT STARTING WITH '5302'
             OR cu.CUENTA_PT STARTING WITH '5303' OR cu.CUENTA_PT STARTING WITH '5304')
         THEN ${salGastoExpr} ELSE 0 END) AS CO_B5,
        SUM(CASE WHEN ${sqlCoC15201Mas5203Otros} THEN ${salGastoExpr} ELSE 0 END) AS CO_C1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5402' THEN ${salGastoExpr} ELSE 0 END) AS CO_C2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5403' THEN ${salGastoExpr} ELSE 0 END) AS CO_C3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5404' THEN ${salGastoExpr} ELSE 0 END) AS CO_C4,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5405' THEN ${salGastoExpr} ELSE 0 END) AS CO_C5,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '54'
           AND NOT (cu.CUENTA_PT STARTING WITH '5401' OR cu.CUENTA_PT STARTING WITH '5402'
             OR cu.CUENTA_PT STARTING WITH '5403' OR cu.CUENTA_PT STARTING WITH '5404' OR cu.CUENTA_PT STARTING WITH '5405')
         THEN ${salGastoExpr} ELSE 0 END) AS CO_C6
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY ${salYearExpr}, ${salMonthExpr}
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM ${detDateExpr}) AS ANIO, EXTRACT(MONTH FROM ${detDateExpr}) AS MES,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5201' THEN ${detGastoExpr} ELSE 0 END) AS CO_A1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5202' THEN ${detGastoExpr} ELSE 0 END) AS CO_A2,
        SUM(CASE WHEN ${sqlCoA35203SoloAdmin} THEN ${detGastoExpr} ELSE 0 END) AS CO_A3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5204' THEN ${detGastoExpr} ELSE 0 END) AS CO_A4,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5205' THEN ${detGastoExpr} ELSE 0 END) AS CO_A5,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '52'
           AND NOT (cu.CUENTA_PT STARTING WITH '5201' OR cu.CUENTA_PT STARTING WITH '5202' OR cu.CUENTA_PT STARTING WITH '5203'
             OR cu.CUENTA_PT STARTING WITH '5204' OR cu.CUENTA_PT STARTING WITH '5205')
         THEN ${detGastoExpr} ELSE 0 END) AS CO_A6,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5301' THEN ${detGastoExpr} ELSE 0 END) AS CO_B1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5302' THEN ${detGastoExpr} ELSE 0 END) AS CO_B2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5303' THEN ${detGastoExpr} ELSE 0 END) AS CO_B3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5304' THEN ${detGastoExpr} ELSE 0 END) AS CO_B4,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '53'
           AND NOT (cu.CUENTA_PT STARTING WITH '5301' OR cu.CUENTA_PT STARTING WITH '5302'
             OR cu.CUENTA_PT STARTING WITH '5303' OR cu.CUENTA_PT STARTING WITH '5304')
         THEN ${detGastoExpr} ELSE 0 END) AS CO_B5,
        SUM(CASE WHEN ${sqlCoC15201Mas5203Otros} THEN ${detGastoExpr} ELSE 0 END) AS CO_C1,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5402' THEN ${detGastoExpr} ELSE 0 END) AS CO_C2,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5403' THEN ${detGastoExpr} ELSE 0 END) AS CO_C3,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5404' THEN ${detGastoExpr} ELSE 0 END) AS CO_C4,
        SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5405' THEN ${detGastoExpr} ELSE 0 END) AS CO_C5,
        SUM(CASE
          WHEN cu.CUENTA_PT STARTING WITH '54'
           AND NOT (cu.CUENTA_PT STARTING WITH '5401' OR cu.CUENTA_PT STARTING WITH '5402'
             OR cu.CUENTA_PT STARTING WITH '5403' OR cu.CUENTA_PT STARTING WITH '5404' OR cu.CUENTA_PT STARTING WITH '5405')
         THEN ${detGastoExpr} ELSE 0 END) AS CO_C6
      FROM DOCTOS_CO_DET d
      ${detNeedsDoctoJoin ? 'JOIN DOCTOS_CO c ON c.DOCTO_CO_ID = d.DOCTO_CO_ID' : ''}
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND CAST(${detDateExpr} AS DATE) >= CAST(? AS DATE) AND CAST(${detDateExpr} AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM ${detDateExpr}), EXTRACT(MONTH FROM ${detDateExpr})
      ORDER BY 1, 2
    `, dateParams, 15000).catch(() => []),
    q(`
      SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
        COALESCE(SUM(${salGastoExpr}), 0) AS GASTO_EXTRA_OP
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE ${sqlGastosMicrosipExtendWhere}
        AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY ${salYearExpr}, ${salMonthExpr}
      ORDER BY 1, 2
    `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []),
    q(`
      SELECT EXTRACT(YEAR FROM ${detDateExpr}) AS ANIO, EXTRACT(MONTH FROM ${detDateExpr}) AS MES,
        COALESCE(SUM(${detGastoExpr}), 0) AS GASTO_EXTRA_OP
      FROM DOCTOS_CO_DET d
      ${detNeedsDoctoJoin ? 'JOIN DOCTOS_CO c ON c.DOCTO_CO_ID = d.DOCTO_CO_ID' : ''}
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
      WHERE ${sqlGastosMicrosipExtendWhere}
        AND CAST(${detDateExpr} AS DATE) >= CAST(? AS DATE) AND CAST(${detDateExpr} AS DATE) <= CAST(? AS DATE)
      GROUP BY EXTRACT(YEAR FROM ${detDateExpr}), EXTRACT(MONTH FROM ${detDateExpr})
      ORDER BY 1, 2
    `, dateParams, 15000).catch(() => []),
  ]);
  const dbgSumRows = (rows) => (rows || []).reduce((acc, r) => {
    const cols = ['CO_A1', 'CO_A2', 'CO_A3', 'CO_A4', 'CO_A5', 'CO_A6', 'CO_B1', 'CO_B2', 'CO_B3', 'CO_B4', 'CO_B5', 'CO_C1', 'CO_C2', 'CO_C3', 'CO_C4', 'CO_C5', 'CO_C6'];
    return acc + cols.reduce((s, c) => s + Math.abs(+r[c] || 0), 0);
  }, 0);


  const key = (a, m) => `${a}-${m}`;
  const isNameLike = (v, re) => re.test(String(v || '').toUpperCase());
  const gastoBucket = (cuenta, nombre) => {
    const c = String(cuenta || '').trim();
    const n = String(nombre || '').trim();
    if (!c) return '';
    if (isNameLike(n, /FINAN/)) return 'CO_B1'; // gastos financieros
    if (isNameLike(n, /OTROS?\s+GAST/)) return 'CO_C1'; // partidas extraordinarias
    if (c.startsWith('5201')) return 'CO_A1'; // total gastos de venta
    if (c.startsWith('5202')) return 'CO_A2'; // total gastos de operación
    if (c.startsWith('5203')) return 'CO_A3'; // total gastos de administración (sin "otros gastos")
    if (c.startsWith('52') || c.startsWith('53') || c.startsWith('54')) return 'CO_A3';
    return '';
  };
  const emptyGasRow = () => ({
    CO_A1: 0, CO_A2: 0, CO_A3: 0, CO_A4: 0, CO_A5: 0, CO_A6: 0,
    CO_B1: 0, CO_B2: 0, CO_B3: 0, CO_B4: 0, CO_B5: 0,
    CO_C1: 0, CO_C2: 0, CO_C3: 0, CO_C4: 0, CO_C5: 0, CO_C6: 0,
  });
  const rowsToClasifMap = (rows) => {
    const out = {};
    (rows || []).forEach((r) => {
      const k = key(r.ANIO, r.MES);
      if (!out[k]) out[k] = emptyGasRow();
      const imp = Math.abs(+r.IMP || 0);
      if (imp <= 0.0001) return;
      const b = gastoBucket(r.CUENTA_PT, r.NOMBRE);
      if (!b) return;
      out[k][b] = (+out[k][b] || 0) + imp;
    });
    return out;
  };
  const gastosSaldosClasifRows = await q(`
    SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
      TRIM(COALESCE(cu.CUENTA_PT, '')) AS CUENTA_PT,
      TRIM(COALESCE(cu.NOMBRE, cu.CUENTA_PT)) AS NOMBRE,
      COALESCE(SUM(${salGastoExpr}), 0) AS IMP
    FROM SALDOS_CO s
    JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
    WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
      AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
      AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
      AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
    GROUP BY ${salYearExpr}, ${salMonthExpr}, cu.CUENTA_PT, cu.NOMBRE
    ORDER BY 1, 2, 3
  `, [sy, ey, sy, sm, ey, em], 15000).catch(() => []);
  const gastosClasifMap = rowsToClasifMap(gastosSaldosClasifRows);
  /** Gastos en 6* (muchos catálogos Microsip) y 5xx que no son costo 51* ni bloque 52–54; se suman a CO_A2 (operación) para gráfica y totales. */
  const extraOpGastoMap = {};
  (gastosSaldosExtend || []).forEach((r) => {
    const k = key(r.ANIO, r.MES);
    extraOpGastoMap[k] = Math.abs(+r.GASTO_EXTRA_OP || 0);
  });
  (gastosDoctosExtend || []).forEach((r) => {
    const k = key(r.ANIO, r.MES);
    const d = Math.abs(+r.GASTO_EXTRA_OP || 0);
    if (d < 0.01) return;
    const s = extraOpGastoMap[k] || 0;
    extraOpGastoMap[k] = Math.max(s, d);
  });

  const mapFromRows = (rows) => {
    const out = {};
    (rows || []).forEach((r) => {
      const k = key(r.ANIO, r.MES);
      const v = +r.COSTO_VENTAS || 0;
      if (v > 0) out[k] = v;
    });
    return out;
  };
  const costByConta = mapFromRows(costosSaldos5101);
  const costByLineas = mapFromRows(costosLineasMes);
  const costByVeDet = mapFromRows(costosVEMes);
  const costByInDet = mapFromRows(costosINMes);
  const costByInHdr = mapFromRows(costosINDirect);
  const costMap = {};
  // Prioridad: Contabilidad (5101) -> lineas historicas -> VE_DET -> IN_DET -> IN header.
  const chooseCost = (k) => {
    if (costByConta[k] > 0) return { value: costByConta[k], source: 'CONTA_5101' };
    if (costByLineas[k] > 0) return { value: costByLineas[k], source: 'LINEAS_HIST' };
    if (costByVeDet[k] > 0) return { value: costByVeDet[k], source: 'VE_DET' };
    if (costByInDet[k] > 0) return { value: costByInDet[k], source: 'IN_DET' };
    if (costByInHdr[k] > 0) return { value: costByInHdr[k], source: 'IN_HDR' };
    return { value: 0, source: 'NONE' };
  };
  const descMap = {};
  (descuentosMes || []).forEach(r => { descMap[key(r.ANIO, r.MES)] = +r.DESCUENTOS_DEV || 0; });
  const cobMap = {}; (cobrosMes || []).forEach(r => { cobMap[key(r.ANIO, r.MES)] = +r.COBROS || 0; });
  const sumGastosRows = (rows) => (rows || []).reduce((acc, r) => {
    const cols = ['CO_A1', 'CO_A2', 'CO_A3', 'CO_A4', 'CO_A5', 'CO_A6', 'CO_B1', 'CO_B2', 'CO_B3', 'CO_B4', 'CO_B5', 'CO_C1', 'CO_C2', 'CO_C3', 'CO_C4', 'CO_C5', 'CO_C6'];
    return acc + cols.reduce((s, c) => s + Math.abs(+r[c] || 0), 0);
  }, 0);
  const sumGastoRow = (r) => {
    const cols = ['CO_A1', 'CO_A2', 'CO_A3', 'CO_A4', 'CO_A5', 'CO_A6', 'CO_B1', 'CO_B2', 'CO_B3', 'CO_B4', 'CO_B5', 'CO_C1', 'CO_C2', 'CO_C3', 'CO_C4', 'CO_C5', 'CO_C6'];
    return cols.reduce((s, c) => s + Math.abs(+((r || {})[c]) || 0), 0);
  };
  const sameMonth = sy === ey && sm === em;
  // El fallback de gastos debe aplicar tanto en rango explícito (desde/hasta) como en vista mensual (anio&mes).
  const singleMonthRange = hasRangoExplicito && sameMonth;
  const singleMonthParam = !!(req.query && req.query.anio && req.query.mes);
  const wantSingleMonthFallback = singleMonthRange || singleMonthParam;
  let gastosRows = Array.isArray(gastosSaldos52) ? gastosSaldos52 : [];
  let gastosEstimados = false;
  let gastosEstimadosDesde = null;
  if (sumGastosRows(gastosRows) <= 0.01 && sumGastosRows(gastosDoctos52) > 0.01) {
    gastosRows = gastosDoctos52;
  }
  if (sumGastosRows(gastosRows) <= 0.01 && wantSingleMonthFallback) {
    const yStart = `${ey}-01-01`;
    const yEnd = hastaStr;
    const yStartNum = ey * 100 + 1;
    const yEndNum = ey * 100 + em;
    let fallbackRows = [];
    try {
      fallbackRows = await q(`
        SELECT ${salYearExpr} AS ANIO, ${salMonthExpr} AS MES,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5201' THEN ${salGastoExpr} ELSE 0 END) AS CO_A1,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5202' THEN ${salGastoExpr} ELSE 0 END) AS CO_A2,
          SUM(CASE WHEN ${sqlCoA35203SoloAdmin} THEN ${salGastoExpr} ELSE 0 END) AS CO_A3,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5204' THEN ${salGastoExpr} ELSE 0 END) AS CO_A4,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5205' THEN ${salGastoExpr} ELSE 0 END) AS CO_A5,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '52' THEN ${salGastoExpr} ELSE 0 END) AS CO_A6,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5301' THEN ${salGastoExpr} ELSE 0 END) AS CO_B1,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5302' THEN ${salGastoExpr} ELSE 0 END) AS CO_B2,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5303' THEN ${salGastoExpr} ELSE 0 END) AS CO_B3,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5304' THEN ${salGastoExpr} ELSE 0 END) AS CO_B4,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '53' THEN ${salGastoExpr} ELSE 0 END) AS CO_B5,
          SUM(CASE WHEN ${sqlCoC15201Mas5203Otros} THEN ${salGastoExpr} ELSE 0 END) AS CO_C1,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5402' THEN ${salGastoExpr} ELSE 0 END) AS CO_C2,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5403' THEN ${salGastoExpr} ELSE 0 END) AS CO_C3,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5404' THEN ${salGastoExpr} ELSE 0 END) AS CO_C4,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5405' THEN ${salGastoExpr} ELSE 0 END) AS CO_C5,
          SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '54' THEN ${salGastoExpr} ELSE 0 END) AS CO_C6
        FROM SALDOS_CO s
        JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
        WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
          AND (${salYearExpr} * 100 + ${salMonthExpr}) >= ?
          AND (${salYearExpr} * 100 + ${salMonthExpr}) <= ?
        GROUP BY ${salYearExpr}, ${salMonthExpr}
        ORDER BY ${salYearExpr} DESC, ${salMonthExpr} DESC
      `, [yStartNum, yEndNum], 15000).catch(() => []);
    } catch (_) {}
    let fb = (fallbackRows || []).find((r) => sumGastoRow(r) > 0.01);
    if (!fb) {
      try {
        fallbackRows = await q(`
          SELECT EXTRACT(YEAR FROM ${detDateExpr}) AS ANIO, EXTRACT(MONTH FROM ${detDateExpr}) AS MES,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5201' THEN ${detGastoExpr} ELSE 0 END) AS CO_A1,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5202' THEN ${detGastoExpr} ELSE 0 END) AS CO_A2,
            SUM(CASE WHEN ${sqlCoA35203SoloAdmin} THEN ${detGastoExpr} ELSE 0 END) AS CO_A3,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5204' THEN ${detGastoExpr} ELSE 0 END) AS CO_A4,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5205' THEN ${detGastoExpr} ELSE 0 END) AS CO_A5,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '52' THEN ${detGastoExpr} ELSE 0 END) AS CO_A6,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5301' THEN ${detGastoExpr} ELSE 0 END) AS CO_B1,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5302' THEN ${detGastoExpr} ELSE 0 END) AS CO_B2,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5303' THEN ${detGastoExpr} ELSE 0 END) AS CO_B3,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5304' THEN ${detGastoExpr} ELSE 0 END) AS CO_B4,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '53' THEN ${detGastoExpr} ELSE 0 END) AS CO_B5,
            SUM(CASE WHEN ${sqlCoC15201Mas5203Otros} THEN ${detGastoExpr} ELSE 0 END) AS CO_C1,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5402' THEN ${detGastoExpr} ELSE 0 END) AS CO_C2,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5403' THEN ${detGastoExpr} ELSE 0 END) AS CO_C3,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5404' THEN ${detGastoExpr} ELSE 0 END) AS CO_C4,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '5405' THEN ${detGastoExpr} ELSE 0 END) AS CO_C5,
            SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '54' THEN ${detGastoExpr} ELSE 0 END) AS CO_C6
          FROM DOCTOS_CO_DET d
          ${detNeedsDoctoJoin ? 'JOIN DOCTOS_CO c ON c.DOCTO_CO_ID = d.DOCTO_CO_ID' : ''}
          JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
          WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
            AND CAST(${detDateExpr} AS DATE) >= CAST(? AS DATE) AND CAST(${detDateExpr} AS DATE) <= CAST(? AS DATE)
          GROUP BY EXTRACT(YEAR FROM ${detDateExpr}), EXTRACT(MONTH FROM ${detDateExpr})
          ORDER BY EXTRACT(YEAR FROM ${detDateExpr}) DESC, EXTRACT(MONTH FROM ${detDateExpr}) DESC
        `, [yStart, yEnd], 15000).catch(() => []);
      } catch (_) {}
      fb = (fallbackRows || []).find((r) => sumGastoRow(r) > 0.01);
    }
    if (fb) {
      gastosRows = [{ ...fb, ANIO: ey, MES: em }];
      gastosEstimados = true;
      gastosEstimadosDesde = { ANIO: +fb.ANIO || null, MES: +fb.MES || null };
    }
  }


  const gasMap = {};
  (gastosRows || []).forEach(r => { gasMap[key(r.ANIO, r.MES)] = r; });
  const gasAbs = (g, k) => Math.abs(+g[k] || 0);
  const ventasContaMap = {};
  (ingresosSaldos4 || []).forEach(r => { ventasContaMap[key(r.ANIO, r.MES)] = +r.VENTAS_NETAS_CONTA || 0; });

  const costosElegidos = [];
  const ventasFuentes = [];
  const ventasByKm = {};
  (ventasMes || []).forEach((r) => { ventasByKm[key(r.ANIO, r.MES)] = r; });
  const monthKeySet = new Set();
  const addMonthKeys = (rows) => {
    (rows || []).forEach((row) => {
      if (row == null || row.ANIO == null || row.MES == null) return;
      monthKeySet.add(key(row.ANIO, row.MES));
    });
  };
  addMonthKeys(ventasMes);
  addMonthKeys(ingresosSaldos4);
  addMonthKeys(gastosSaldos52);
  addMonthKeys(gastosDoctos52);
  addMonthKeys(gastosSaldosExtend);
  addMonthKeys(gastosDoctosExtend);
  addMonthKeys(costosSaldos5101);
  addMonthKeys(descuentosMes);
  addMonthKeys(cobrosMes);
  addMonthKeys(costosVEMes);
  addMonthKeys(costosINMes);
  addMonthKeys(costosINDirect);
  const sortedMonthKeys = Array.from(monthKeySet).sort((a, b) => {
    const [ay, am] = a.split('-').map((x) => parseInt(x, 10));
    const [by, bm] = b.split('-').map((x) => parseInt(x, 10));
    return ay !== by ? ay - by : am - bm;
  });
  const meses = sortedMonthKeys.map((km) => {
    const parts = km.split('-');
    const anioR = parseInt(parts[0], 10);
    const mesR = parseInt(parts[1], 10);
    const r = ventasByKm[km] || {
      ANIO: anioR,
      MES: mesR,
      VENTAS_BRUTAS: 0,
      VENTAS_VE: 0,
      VENTAS_PV: 0,
      NUM_FACTURAS: 0,
    };
    const ventasBrutas = +r.VENTAS_BRUTAS || 0;
    const descuentosDev = descMap[key(r.ANIO, r.MES)] || 0;
    const kmKey = key(r.ANIO, r.MES);
    const ventasConta = +(ventasContaMap[kmKey] || 0);
    // Para Estado de Resultados priorizar ingresos contables (clase 4*).
    const ventas = ventasConta > 0.01 ? ventasConta : ventasBrutas;
    ventasFuentes.push({ ANIO: r.ANIO, MES: r.MES, ventas_dashboard: ventasBrutas, ventas_conta4: ventasConta, ventas_usada: ventas, fuente: ventasConta > 0.01 ? 'SALDOS_CO_4*' : 'VENTAS_DOCS_FV' });
    const chosen = chooseCost(kmKey);
    const costo = chosen.value || 0;
    costMap[kmKey] = costo;
    costosElegidos.push({ ANIO: r.ANIO, MES: r.MES, source: chosen.source, costo });
    const cobros = cobMap[key(r.ANIO, r.MES)] || 0;
    const util = ventas - costo;
    const margenPct = ventas > 0 ? Math.round((util / ventas) * 1000) / 10 : 0;
    const g = gastosClasifMap[kmKey] || gasMap[kmKey] || {};
    return {
      ANIO: r.ANIO,
      MES: r.MES,
      VENTAS_BRUTAS: ventasBrutas,
      DESCUENTOS_DEV: descuentosDev,
      VENTAS_NETAS: ventas,
      VENTAS_VE: +r.VENTAS_VE || 0,
      VENTAS_PV: +r.VENTAS_PV || 0,
      COSTO_VENTAS: costo,
      UTILIDAD_BRUTA: util,
      MARGEN_BRUTO_PCT: margenPct,
      COBROS: cobros,
      NUM_FACTURAS: +r.NUM_FACTURAS || 0,
      CO_A1: gasAbs(g, 'CO_A1'),
      CO_A2: gasAbs(g, 'CO_A2') + (+extraOpGastoMap[kmKey] || 0),
      CO_A3: gasAbs(g, 'CO_A3'),
      CO_A4: gasAbs(g, 'CO_A4'),
      CO_A5: gasAbs(g, 'CO_A5'),
      CO_A6: gasAbs(g, 'CO_A6'),
      CO_B1: gasAbs(g, 'CO_B1'),
      CO_B2: gasAbs(g, 'CO_B2'),
      CO_B3: gasAbs(g, 'CO_B3'),
      CO_B4: gasAbs(g, 'CO_B4'),
      CO_B5: gasAbs(g, 'CO_B5'),
      CO_C1: gasAbs(g, 'CO_C1'),
      CO_C2: gasAbs(g, 'CO_C2'),
      CO_C3: gasAbs(g, 'CO_C3'),
      CO_C4: gasAbs(g, 'CO_C4'),
      CO_C5: gasAbs(g, 'CO_C5'),
      CO_C6: gasAbs(g, 'CO_C6'),
    };
  });

  const totales = meses.reduce((acc, m) => {
    acc.VENTAS_BRUTAS += m.VENTAS_BRUTAS || 0;
    acc.DESCUENTOS_DEV += m.DESCUENTOS_DEV || 0;
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
    acc.CO_C1 += m.CO_C1 || 0;
    acc.CO_C2 += m.CO_C2 || 0;
    acc.CO_C3 += m.CO_C3 || 0;
    acc.CO_C4 += m.CO_C4 || 0;
    acc.CO_C5 += m.CO_C5 || 0;
    acc.CO_C6 += m.CO_C6 || 0;
    return acc;
  }, {
    VENTAS_BRUTAS: 0, DESCUENTOS_DEV: 0, VENTAS_NETAS: 0, VENTAS_VE: 0, VENTAS_PV: 0, COSTO_VENTAS: 0, UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0,
    CO_A1: 0, CO_A2: 0, CO_A3: 0, CO_A4: 0, CO_A5: 0, CO_A6: 0, CO_B1: 0, CO_B2: 0, CO_B3: 0, CO_B4: 0, CO_B5: 0, CO_C1: 0, CO_C2: 0, CO_C3: 0, CO_C4: 0, CO_C5: 0, CO_C6: 0,
  });
  totales.MARGEN_BRUTO_PCT = totales.VENTAS_NETAS > 0
    ? Math.round((totales.UTILIDAD_BRUTA / totales.VENTAS_NETAS) * 1000) / 10 : 0;

  const tiene_costo = totales.COSTO_VENTAS > 0;
  const sumGastoCo = ['CO_A1', 'CO_A2', 'CO_A3', 'CO_A4', 'CO_A5', 'CO_A6', 'CO_B1', 'CO_B2', 'CO_B3', 'CO_B4', 'CO_B5', 'CO_C1', 'CO_C2', 'CO_C3', 'CO_C4', 'CO_C5', 'CO_C6']
    .reduce((s, k) => s + (+totales[k] || 0), 0);
  const tiene_gastos_co = sumGastoCo > 0.01;



  let prefijos_rows = [];
  try {
    prefijos_rows = await q(`
      SELECT
        TRIM(COALESCE(cu.CUENTA_PT, '')) AS CUENTA_PT,
        TRIM(COALESCE(cu.NOMBRE, '')) AS ETIQUETA
      FROM CUENTAS_CO cu
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
      ORDER BY cu.CUENTA_PT
    `, [], 10000);
  } catch (_) {
    try {
      prefijos_rows = await q(`
        SELECT
          TRIM(COALESCE(cu.CUENTA_PT, '')) AS CUENTA_PT,
          TRIM(COALESCE(cu.CUENTA_JT, '')) AS ETIQUETA
        FROM CUENTAS_CO cu
        WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        ORDER BY cu.CUENTA_PT
      `, [], 10000);
    } catch (__) {
      prefijos_rows = [];
    }
  }
  const prefijos_labels = {};
  let prefijos_top_rows = [];
  let subconceptos_rows = [];
  try {
    prefijos_top_rows = await q(`
      SELECT
        CASE
          WHEN cu.CUENTA_PT STARTING WITH '5201' THEN 'CO_A1'
          WHEN cu.CUENTA_PT STARTING WITH '5202' THEN 'CO_A2'
          WHEN cu.CUENTA_PT STARTING WITH '5203' AND ${sqlCoNombreUp} = 'OTROS GASTOS' THEN 'CO_C1'
          WHEN cu.CUENTA_PT STARTING WITH '5203' THEN 'CO_A3'
          WHEN cu.CUENTA_PT STARTING WITH '5204' THEN 'CO_A4'
          WHEN cu.CUENTA_PT STARTING WITH '5205' THEN 'CO_A5'
          WHEN cu.CUENTA_PT STARTING WITH '52' THEN 'CO_A6'
          WHEN cu.CUENTA_PT STARTING WITH '5301' THEN 'CO_B1'
          WHEN cu.CUENTA_PT STARTING WITH '5302' THEN 'CO_B2'
          WHEN cu.CUENTA_PT STARTING WITH '5303' THEN 'CO_B3'
          WHEN cu.CUENTA_PT STARTING WITH '5304' THEN 'CO_B4'
          WHEN cu.CUENTA_PT STARTING WITH '53' THEN 'CO_B5'
          WHEN cu.CUENTA_PT STARTING WITH '5401' THEN 'CO_C1'
          WHEN cu.CUENTA_PT STARTING WITH '5402' THEN 'CO_C2'
          WHEN cu.CUENTA_PT STARTING WITH '5403' THEN 'CO_C3'
          WHEN cu.CUENTA_PT STARTING WITH '5404' THEN 'CO_C4'
          WHEN cu.CUENTA_PT STARTING WITH '5405' THEN 'CO_C5'
          WHEN cu.CUENTA_PT STARTING WITH '54' THEN 'CO_C6'
          ELSE NULL
        END AS BUCKET,
        TRIM(COALESCE(NULLIF(cu.NOMBRE, ''), NULLIF(cu.CUENTA_JT, ''), cu.CUENTA_PT)) AS ETIQUETA,
        SUM(ABS(${salDeltaExpr})) AS IMP
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY 1, 2
      ORDER BY 1, 3 DESC
    `, [sy, ey, sy, sm, ey, em], 12000);
  } catch (_) {
    prefijos_top_rows = [];
  }
  try {
    subconceptos_rows = await q(`
      SELECT
        CASE
          WHEN cu.CUENTA_PT STARTING WITH '5201' THEN 'CO_A1'
          WHEN cu.CUENTA_PT STARTING WITH '5202' THEN 'CO_A2'
          WHEN cu.CUENTA_PT STARTING WITH '5203' AND ${sqlCoNombreUp} = 'OTROS GASTOS' THEN 'CO_C1'
          WHEN cu.CUENTA_PT STARTING WITH '5203' THEN 'CO_A3'
          WHEN cu.CUENTA_PT STARTING WITH '5204' THEN 'CO_A4'
          WHEN cu.CUENTA_PT STARTING WITH '5205' THEN 'CO_A5'
          WHEN cu.CUENTA_PT STARTING WITH '52' THEN 'CO_A6'
          WHEN cu.CUENTA_PT STARTING WITH '5301' THEN 'CO_B1'
          WHEN cu.CUENTA_PT STARTING WITH '5302' THEN 'CO_B2'
          WHEN cu.CUENTA_PT STARTING WITH '5303' THEN 'CO_B3'
          WHEN cu.CUENTA_PT STARTING WITH '5304' THEN 'CO_B4'
          WHEN cu.CUENTA_PT STARTING WITH '53' THEN 'CO_B5'
          WHEN cu.CUENTA_PT STARTING WITH '5401' THEN 'CO_C1'
          WHEN cu.CUENTA_PT STARTING WITH '5402' THEN 'CO_C2'
          WHEN cu.CUENTA_PT STARTING WITH '5403' THEN 'CO_C3'
          WHEN cu.CUENTA_PT STARTING WITH '5404' THEN 'CO_C4'
          WHEN cu.CUENTA_PT STARTING WITH '5405' THEN 'CO_C5'
          WHEN cu.CUENTA_PT STARTING WITH '54' THEN 'CO_C6'
          ELSE NULL
        END AS BUCKET,
        TRIM(COALESCE(NULLIF(cu.NOMBRE, ''), NULLIF(cu.CUENTA_JT, ''), cu.CUENTA_PT)) AS ETIQUETA,
        ${salYearExpr} AS ANIO,
        ${salMonthExpr} AS MES,
        SUM(ABS(${salDeltaExpr})) AS IMP
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND ${salYearExpr} >= ? AND ${salYearExpr} <= ?
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} < ?)
        AND NOT (${salYearExpr} = ? AND ${salMonthExpr} > ?)
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3, 4
    `, [sy, ey, sy, sm, ey, em], 15000);
  } catch (_) {
    subconceptos_rows = [];
  }
  for (const r of (prefijos_top_rows || [])) {
    const b = String(r.BUCKET || '').trim();
    const et = String(r.ETIQUETA || '').trim();
    if (!b || !et) continue;
    if (!prefijos_labels[b]) prefijos_labels[b] = et;
  }
  const pRows = Array.isArray(prefijos_rows) ? prefijos_rows : [];
  const pickPref = (prefix, exceptList) => {
    for (const r of pRows) {
      const cp = String(r.CUENTA_PT || '').trim();
      const et = String(r.ETIQUETA || '').trim();
      if (!cp || !et) continue;
      if (!cp.startsWith(prefix)) continue;
      if (Array.isArray(exceptList) && exceptList.some(x => cp.startsWith(x))) continue;
      return et;
    }
    return null;
  };
  prefijos_labels.CO_A1 = 'Total gastos de venta';
  prefijos_labels.CO_A2 = 'Total gastos de operación';
  prefijos_labels.CO_A3 = 'Total gastos de administración';
  prefijos_labels.CO_B1 = 'Gastos financieros';
  prefijos_labels.CO_C1 = 'Otros gastos (partidas extraordinarias)';
  const subTmp = {};
  for (const r of (subconceptos_rows || [])) {
    const b = String(r.BUCKET || '').trim();
    if (!b) continue;
    const et = String(r.ETIQUETA || '').trim() || 'Sin etiqueta';
    const an = +r.ANIO || 0;
    const me = +r.MES || 0;
    const val = +r.IMP || 0;
    if (!an || me < 1 || me > 12 || val <= 0.005) continue;
    if (!subTmp[b]) subTmp[b] = {};
    if (!subTmp[b][et]) subTmp[b][et] = { etiqueta: et, total: 0, meses: {} };
    const mk = `${an}-${String(me).padStart(2, '0')}`;
    subTmp[b][et].total += val;
    subTmp[b][et].meses[mk] = (subTmp[b][et].meses[mk] || 0) + val;
  }
  const subconceptos = {};
  Object.keys(subTmp).forEach((bucket) => {
    subconceptos[bucket] = Object.values(subTmp[bucket])
      .sort((a, b) => (+b.total || 0) - (+a.total || 0))
      .slice(0, 30);
  });


  return { meses, totales, tiene_costo, tiene_gastos_co, prefijos_labels, subconceptos, gastos_estimados: gastosEstimados, gastos_estimados_desde: gastosEstimadosDesde };
}

/** Consolida P&L contable sumando mes a mes todas las bases del registro (db=__all__). */
async function resultadosPnlMergedAll(req) {
  const outs = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
    try {
      return await resultadosPnlCore(req, entry.options);
    } catch (e) {
      return {
        meses: [],
        totales: {},
        tiene_costo: false,
        tiene_gastos_co: false,
        prefijos_labels: {},
        subconceptos: {},
        gastos_estimados: false,
        gastos_estimados_desde: null,
      };
    }
  });
  const mesMap = new Map();
  for (const out of outs) {
    for (const m of out.meses || []) {
      const k = `${+m.ANIO}-${+m.MES}`;
      if (!mesMap.has(k)) mesMap.set(k, { ANIO: +m.ANIO, MES: +m.MES });
      const acc = mesMap.get(k);
      Object.keys(m).forEach((key) => {
        if (key === 'ANIO' || key === 'MES' || key === 'MARGEN_BRUTO_PCT') return;
        const v = m[key];
        if (typeof v === 'number' && Number.isFinite(v)) acc[key] = (acc[key] || 0) + v;
      });
    }
  }
  const meses = Array.from(mesMap.values()).sort((a, b) =>
    (+a.ANIO !== +b.ANIO ? +a.ANIO - +b.ANIO : +a.MES - +b.MES));
  meses.forEach((m) => {
    m.MARGEN_BRUTO_PCT = m.VENTAS_NETAS > 0
      ? Math.round((m.UTILIDAD_BRUTA / m.VENTAS_NETAS) * 1000) / 10 : 0;
  });
  const totales = meses.reduce(
    (acc, m) => {
      acc.VENTAS_BRUTAS += m.VENTAS_BRUTAS || 0;
      acc.DESCUENTOS_DEV += m.DESCUENTOS_DEV || 0;
      acc.VENTAS_NETAS += m.VENTAS_NETAS || 0;
      acc.VENTAS_VE += m.VENTAS_VE || 0;
      acc.VENTAS_PV += m.VENTAS_PV || 0;
      acc.COSTO_VENTAS += m.COSTO_VENTAS || 0;
      acc.UTILIDAD_BRUTA += m.UTILIDAD_BRUTA || 0;
      acc.COBROS += m.COBROS || 0;
      acc.NUM_FACTURAS += m.NUM_FACTURAS || 0;
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
      acc.CO_C1 += m.CO_C1 || 0;
      acc.CO_C2 += m.CO_C2 || 0;
      acc.CO_C3 += m.CO_C3 || 0;
      acc.CO_C4 += m.CO_C4 || 0;
      acc.CO_C5 += m.CO_C5 || 0;
      acc.CO_C6 += m.CO_C6 || 0;
      return acc;
    },
    {
      VENTAS_BRUTAS: 0,
      DESCUENTOS_DEV: 0,
      VENTAS_NETAS: 0,
      VENTAS_VE: 0,
      VENTAS_PV: 0,
      COSTO_VENTAS: 0,
      UTILIDAD_BRUTA: 0,
      COBROS: 0,
      NUM_FACTURAS: 0,
      CO_A1: 0,
      CO_A2: 0,
      CO_A3: 0,
      CO_A4: 0,
      CO_A5: 0,
      CO_A6: 0,
      CO_B1: 0,
      CO_B2: 0,
      CO_B3: 0,
      CO_B4: 0,
      CO_B5: 0,
      CO_C1: 0,
      CO_C2: 0,
      CO_C3: 0,
      CO_C4: 0,
      CO_C5: 0,
      CO_C6: 0,
    },
  );
  totales.MARGEN_BRUTO_PCT = totales.VENTAS_NETAS > 0
    ? Math.round((totales.UTILIDAD_BRUTA / totales.VENTAS_NETAS) * 1000) / 10 : 0;
  const tiene_costo = outs.some((o) => o.tiene_costo);
  const tiene_gastos_co = outs.some((o) => o.tiene_gastos_co);
  const prefijos_labels = outs.find((o) => o.prefijos_labels && Object.keys(o.prefijos_labels).length)?.prefijos_labels || {};
  const subMerged = {};
  for (const out of outs) {
    const sc = out.subconceptos || {};
    for (const bucket of Object.keys(sc)) {
      if (!subMerged[bucket]) subMerged[bucket] = {};
      for (const item of sc[bucket] || []) {
        const et = String(item.etiqueta || '');
        if (!subMerged[bucket][et]) subMerged[bucket][et] = { etiqueta: et, total: 0, meses: {} };
        subMerged[bucket][et].total += +item.total || 0;
        const mx = item.meses || {};
        Object.keys(mx).forEach((mk) => {
          subMerged[bucket][et].meses[mk] = (subMerged[bucket][et].meses[mk] || 0) + (+mx[mk] || 0);
        });
      }
    }
  }
  const subconceptos = {};
  Object.keys(subMerged).forEach((bucket) => {
    subconceptos[bucket] = Object.values(subMerged[bucket])
      .sort((a, b) => (+b.total || 0) - (+a.total || 0))
      .slice(0, 30);
  });
  const gastos_estimados = outs.some((o) => o.gastos_estimados);
  const gastos_estimados_desde = outs.find((o) => o.gastos_estimados_desde)?.gastos_estimados_desde || null;
  return {
    meses,
    totales,
    tiene_costo,
    tiene_gastos_co,
    prefijos_labels,
    subconceptos,
    gastos_estimados,
    gastos_estimados_desde,
  };
}

get('/api/resultados/pnl', async (req) => {
  let dbId = req.query.db ? String(req.query.db).trim() : '';
  if (dbId.toLowerCase() === 'default') dbId = '';
  if (dbId.toLowerCase() === '__all__') {
    return resultadosPnlMergedAll(req);
  }
  let out;
  if (dbId) {
    const idLc = dbId.toLowerCase();
    const hit = DATABASE_REGISTRY.find(d => String(d.id).toLowerCase() === idLc);
    if (!hit) {
      console.warn('[resultados/pnl] db desconocido, usando default:', dbId);
      out = await resultadosPnlCore(req, null);
    } else {
      out = await resultadosPnlCore(req, hit.options);
    }
  } else {
    out = await resultadosPnlCore(req, null);
  }
  return out;
});

// Resumen P&L por cada empresa del registro (sin devolver series completas; ahorra ancho de banda).
get('/api/resultados/pnl-universe', async (req) => {
  const conc = Math.min(Math.max(parseInt(req.query.concurrency, 10) || 2, 1), 4);
  let registry = DATABASE_REGISTRY;
  const qdb = req.query.db ? String(req.query.db).trim().toLowerCase() : '';
  // db=default debe acotar a UNA base (la entrada "default" o la primera). Antes se ignoraba
  // y se escaneaban todas las empresas → timeout en el cliente → tabla P&L en "Cargando...".
  if (qdb === '__all__') {
    registry = DATABASE_REGISTRY;
  } else if (qdb && qdb !== 'default') {
    const hit = DATABASE_REGISTRY.find((d) => String(d.id).toLowerCase() === qdb);
    if (hit) registry = [hit];
  } else if (qdb === 'default') {
    const def = DATABASE_REGISTRY.find((d) => String(d.id).toLowerCase() === 'default') || DATABASE_REGISTRY[0];
    if (def) registry = [def];
  } else if (!qdb && DATABASE_REGISTRY.length === 1) {
    registry = [DATABASE_REGISTRY[0]];
  }
  const rows = await mapPoolLimit(registry, conc, async (entry) => {
    try {
      const { meses, totales, tiene_costo, tiene_gastos_co } = await resultadosPnlCore(req, entry.options);
      const t = totales || {};
      return {
        ok: true,
        id: entry.id,
        label: entry.label,
        totales: {
          VENTAS_BRUTAS: +t.VENTAS_BRUTAS || 0,
          DESCUENTOS_DEV: +t.DESCUENTOS_DEV || 0,
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
    a.VENTAS_BRUTAS += +t.VENTAS_BRUTAS || 0;
    a.DESCUENTOS_DEV += +t.DESCUENTOS_DEV || 0;
    a.VENTAS_NETAS += +t.VENTAS_NETAS || 0;
    a.COSTO_VENTAS += +t.COSTO_VENTAS || 0;
    a.UTILIDAD_BRUTA += +t.UTILIDAD_BRUTA || 0;
    a.COBROS += +t.COBROS || 0;
    a.NUM_FACTURAS += +t.NUM_FACTURAS || 0;
    a.VENTAS_VE += +t.VENTAS_VE || 0;
    a.VENTAS_PV += +t.VENTAS_PV || 0;
    return a;
  }, { VENTAS_BRUTAS: 0, DESCUENTOS_DEV: 0, VENTAS_NETAS: 0, COSTO_VENTAS: 0, UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0, VENTAS_VE: 0, VENTAS_PV: 0 });
  cons.MARGEN_BRUTO_PCT = cons.VENTAS_NETAS > 0
    ? Math.round((cons.UTILIDAD_BRUTA / cons.VENTAS_NETAS) * 1000) / 10 : 0;
  cons.tiene_costo = cons.COSTO_VENTAS > 0;
  return { generatedAt: new Date().toISOString(), concurrency: conc, empresas: rows, consolidado: cons };
});

function resolveDateRangeFromQuery(q) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  let { desde, hasta, anio, mes } = q || {};
  if (desde && reDate.test(String(desde)) && hasta && reDate.test(String(hasta))) {
    return { desdeStr: String(desde), hastaStr: String(hasta) };
  }
  const y = anio != null && String(anio).trim() !== '' ? parseInt(anio, 10) : NaN;
  const m = mes != null && String(mes).trim() !== '' ? parseInt(mes, 10) : NaN;
  if (!isNaN(y) && !isNaN(m)) {
    const lastDay = new Date(y, m, 0).getDate();
    return { desdeStr: `${y}-${String(m).padStart(2, '0')}-01`, hastaStr: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
  }
  if (!isNaN(y) && isNaN(m)) {
    return { desdeStr: `${y}-01-01`, hastaStr: `${y}-12-31` };
  }
  const preset = String((q || {}).preset || '').toLowerCase();
  const now = new Date();
  const yNow = now.getFullYear();
  const moNow = now.getMonth() + 1;
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (preset === 'hoy') {
    const s = iso(now);
    return { desdeStr: s, hastaStr: s };
  }
  if (preset === 'semana') {
    const dow = now.getDay();
    const start = new Date(now);
    start.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    return { desdeStr: iso(start), hastaStr: iso(now) };
  }
  if (preset === 'mes') {
    const lastDay = new Date(yNow, moNow, 0).getDate();
    return {
      desdeStr: `${yNow}-${String(moNow).padStart(2, '0')}-01`,
      hastaStr: `${yNow}-${String(moNow).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  if (preset === 'mes_ant') {
    let pm = moNow - 1;
    let py = yNow;
    if (pm < 1) {
      pm = 12;
      py--;
    }
    const lastDay = new Date(py, pm, 0).getDate();
    return {
      desdeStr: `${py}-${String(pm).padStart(2, '0')}-01`,
      hastaStr: `${py}-${String(pm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  if (preset === 'anio') {
    return { desdeStr: `${yNow}-01-01`, hastaStr: `${yNow}-12-31` };
  }
  if (preset === 'anio_ant') {
    const yy = yNow - 1;
    return { desdeStr: `${yy}-01-01`, hastaStr: `${yy}-12-31` };
  }
  const mesesN = Math.min(Math.max(parseInt((q || {}).meses, 10) || 3, 1), 24);
  const d = new Date();
  d.setMonth(d.getMonth() - mesesN);
  const desdeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const h = new Date();
  const hastaStr = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
  return { desdeStr, hastaStr };
}

/** Periodo del filtro (inventario consumo/forecast): días calendario inclusivos. */
function invPeriodDaysFromReq(req) {
  const { desdeStr, hastaStr } = resolveDateRangeFromQuery(req.query || {});
  const d0 = new Date(String(desdeStr) + 'T12:00:00');
  const d1 = new Date(String(hastaStr) + 'T12:00:00');
  const periodDays = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
  return { desdeStr, hastaStr, periodDays };
}

function balanceHastaStrForYm(y, m) {
  const lastDay = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/** Último (año, mes) ≤ límite con movimiento en SALDOS_CO para cuentas 1/2/3 (evita balance en $0 cuando el mes en curso aún no tiene cierre en Microsip). */
async function findLatestSaldosCoCierreBalance(dbo, limY, limM, salAnoCol, salMesCol, salCargoCol, salAbonoCol) {
  const compositeLim = limY * 100 + limM;
  const hit = await query(`
    SELECT FIRST 1 x.ANIO, x.MES
    FROM (
      SELECT s.${salAnoCol} AS ANIO, s.${salMesCol} AS MES,
        SUM(ABS(COALESCE(s.${salCargoCol}, 0)) + ABS(COALESCE(s.${salAbonoCol}, 0))) AS MOV_T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '1' OR cu.CUENTA_PT STARTING WITH '2' OR cu.CUENTA_PT STARTING WITH '3')
        AND (s.${salAnoCol} * 100 + s.${salMesCol}) <= ?
      GROUP BY s.${salAnoCol}, s.${salMesCol}
    ) x
    WHERE x.MOV_T > 1
    ORDER BY x.ANIO DESC, x.MES DESC
  `, [compositeLim], 12000, dbo).catch(() => []);
  const r = (hit && hit[0]) || null;
  if (!r) return null;
  const yy = +r.ANIO;
  const mm = +r.MES;
  if (!yy || !mm) return null;
  return { ANIO: yy, MES: mm };
}

// Balance General resumido por naturaleza contable (activo/pasivo/capital) al cierre del periodo filtrado.
// db=__all__: suma por CUENTA_PT en todas las bases del registro (misma lógica que P&L consolidado).
async function buildBalanceGeneralForDbo(req, dbo) {
  const { desdeStr, hastaStr } = resolveDateRangeFromQuery(req.query || {});
  const yReq = parseInt(String(hastaStr).slice(0, 4), 10);
  const mReq = parseInt(String(hastaStr).slice(5, 7), 10);
  const salCols = await getTableColumns('SALDOS_CO', dbo);
  const salAnoCol = firstExistingColumn(salCols, ['ANO', 'ANIO']) || 'ANO';
  const salMesCol = firstExistingColumn(salCols, ['MES', 'PERIODO']) || 'MES';
  const salCargoCol = firstExistingColumn(salCols, ['CARGOS', 'DEBE']) || 'CARGOS';
  const salAbonoCol = firstExistingColumn(salCols, ['ABONOS', 'HABER']) || 'ABONOS';
  const balanceCoYtd = (process.env.MICROSIP_BALANCE_CO_YTD || '').match(/^(1|true|yes)$/i);

  const computeAt = async (y, m) => {
    const mesCond = balanceCoYtd ? `s.${salMesCol} <= ?` : `s.${salMesCol} = ?`;
    const rows = await query(`
      SELECT
        SUBSTRING(cu.CUENTA_PT FROM 1 FOR 1) AS GRUPO1,
        cu.CUENTA_PT,
        TRIM(COALESCE(cu.NOMBRE, cu.CUENTA_PT)) AS NOMBRE,
        SUM(COALESCE(s.${salCargoCol}, 0)) AS CARGOS,
        SUM(COALESCE(s.${salAbonoCol}, 0)) AS ABONOS
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE s.${salAnoCol} = ?
        AND ${mesCond}
        AND (cu.CUENTA_PT STARTING WITH '1' OR cu.CUENTA_PT STARTING WITH '2' OR cu.CUENTA_PT STARTING WITH '3')
      GROUP BY SUBSTRING(cu.CUENTA_PT FROM 1 FOR 1), cu.CUENTA_PT, cu.NOMBRE
      ORDER BY cu.CUENTA_PT
    `, [y, m], 15000, dbo).catch(() => []);
    const detail = { activo: [], pasivo: [], capital: [] };
    let activo = 0; let pasivo = 0; let capital = 0;
    (rows || []).forEach((r) => {
      const g = String(r.GRUPO1 || '').trim();
      const cargos = +r.CARGOS || 0;
      const abonos = +r.ABONOS || 0;
      let saldo = 0;
      if (g === '1') saldo = cargos - abonos;
      if (g === '2' || g === '3') saldo = abonos - cargos;
      saldo = Math.round(saldo * 100) / 100;
      if (Math.abs(saldo) < 0.005) return;
      const rec = { CUENTA_PT: r.CUENTA_PT, NOMBRE: r.NOMBRE, SALDO: saldo };
      if (g === '1') { activo += saldo; detail.activo.push(rec); }
      if (g === '2') { pasivo += saldo; detail.pasivo.push(rec); }
      if (g === '3') { capital += saldo; detail.capital.push(rec); }
    });
    detail.activo.sort((a, b) => Math.abs(+b.SALDO || 0) - Math.abs(+a.SALDO || 0));
    detail.pasivo.sort((a, b) => Math.abs(+b.SALDO || 0) - Math.abs(+a.SALDO || 0));
    detail.capital.sort((a, b) => Math.abs(+b.SALDO || 0) - Math.abs(+a.SALDO || 0));
    const actBreak = balanceActivoBreakdownFromRows(detail.activo);
    return {
      totales: {
        ACTIVO_TOTAL: Math.round(activo * 100) / 100,
        PASIVO_TOTAL: Math.round(pasivo * 100) / 100,
        CAPITAL_TOTAL: Math.round(capital * 100) / 100,
        PASIVO_MAS_CAPITAL: Math.round((pasivo + capital) * 100) / 100,
        DIFERENCIA_BALANCE: Math.round(((pasivo + capital) - activo) * 100) / 100,
        ...actBreak,
      },
      detalleFull: {
        activo: detail.activo,
        pasivo: detail.pasivo,
        capital: detail.capital,
      },
    };
  };

  let yEff = yReq;
  let mEff = mReq;
  let usedFallback = false;
  let body = await computeAt(yEff, mEff);
  const mag = Math.abs(+body.totales.ACTIVO_TOTAL || 0)
    + Math.abs(+body.totales.PASIVO_TOTAL || 0)
    + Math.abs(+body.totales.CAPITAL_TOTAL || 0);
  if (mag < 0.5 && !balanceCoYtd) {
    const alt = await findLatestSaldosCoCierreBalance(dbo, yReq, mReq, salAnoCol, salMesCol, salCargoCol, salAbonoCol);
    if (alt && (alt.ANIO !== yReq || alt.MES !== mReq)) {
      body = await computeAt(alt.ANIO, alt.MES);
      yEff = alt.ANIO;
      mEff = alt.MES;
      usedFallback = true;
    }
  }

  return {
    cierre: {
      ANIO: yEff,
      MES: mEff,
      hasta: balanceHastaStrForYm(yEff, mEff),
      solicitado_ANIO: yReq,
      solicitado_MES: mReq,
      solicitado_hasta: hastaStr,
      balance_ultimo_cierre_disponible: usedFallback,
    },
    totales: body.totales,
    detalleFull: body.detalleFull,
  };
}

get('/api/resultados/balance-general', async (req) => {
  if (isAllDbs(req)) {
    const parts = await mapPoolLimit(DATABASE_REGISTRY, 2, async (entry) => {
      try {
        return await buildBalanceGeneralForDbo(req, entry.options);
      } catch (e) {
        return null;
      }
    });
    return sliceBalanceGeneralPublic(mergeBalanceGeneralFromPayloads(parts));
  }
  const dbo = getReqDbOpts(req);
  const one = await buildBalanceGeneralForDbo(req, dbo);
  return sliceBalanceGeneralPublic(one);
});

// Estado de resultados SR (contable): desglosa gastos operativos y extraordinarios por cuentas.
get('/api/resultados/estado-sr', async (req) => {
  const dbo = getReqDbOpts(req);
  const { desdeStr, hastaStr } = resolveDateRangeFromQuery(req.query || {});
  const pnl = await resultadosPnlCore(req, dbo).catch(() => ({ meses: [], totales: {} }));

  const y = parseInt(String(hastaStr).slice(0, 4), 10);
  const m = parseInt(String(hastaStr).slice(5, 7), 10);
  // Mismas columnas dinámicas que resultadosPnlCore / balance-general: ANO vs ANIO, DEBE/HABER, etc.
  const salCols = await getTableColumns('SALDOS_CO', dbo).catch(() => new Set());
  const salAnoCol = firstExistingColumn(salCols, ['ANO', 'ANIO', 'EJERCICIO']) || 'ANO';
  const salMesCol = firstExistingColumn(salCols, ['MES', 'PERIODO', 'NUM_MES']) || 'MES';
  const salCargoCol = firstExistingColumn(salCols, ['CARGOS', 'CARGO', 'DEBE']) || 'CARGOS';
  const salAbonoCol = firstExistingColumn(salCols, ['ABONOS', 'ABONO', 'HABER']) || 'ABONOS';
  const salYearExpr = `s.${salAnoCol}`;
  const salMonthExpr = `s.${salMesCol}`;
  const salDeltaIng4 = `(COALESCE(s.${salAbonoCol},0) - COALESCE(s.${salCargoCol},0))`;
  const salGastoAbs = `ABS(COALESCE(s.${salCargoCol}, 0) - COALESCE(s.${salAbonoCol}, 0))`;
  const ventasContaRows = await query(`
    SELECT COALESCE(SUM(CASE WHEN cu.CUENTA_PT STARTING WITH '4' THEN (${salDeltaIng4}) ELSE 0 END), 0) AS VENTAS
    FROM SALDOS_CO s
    JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
    WHERE ${salYearExpr} = ? AND ${salMonthExpr} = ?
  `, [y, m], 15000, dbo).catch(() => [{ VENTAS: 0 }]);
  const ventasConta = +((ventasContaRows[0] && ventasContaRows[0].VENTAS) || 0);
  const ventasPnl = +((pnl && pnl.totales && pnl.totales.VENTAS_NETAS) || 0);
  const ventas = ventasConta > 0.01 ? ventasConta : ventasPnl;
  const costo = +((pnl && pnl.totales && pnl.totales.COSTO_VENTAS) || 0);
  const utilidadBruta = ventas - costo;
  const rows = await query(`
    SELECT
      cu.CUENTA_PT,
      TRIM(COALESCE(cu.NOMBRE, cu.CUENTA_PT)) AS NOMBRE,
      COALESCE(SUM(${salGastoAbs}), 0) AS IMP
    FROM SALDOS_CO s
    JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
    WHERE ${salYearExpr} = ? AND ${salMonthExpr} = ?
      AND (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
    GROUP BY cu.CUENTA_PT, cu.NOMBRE
    ORDER BY cu.CUENTA_PT
  `, [y, m], 15000, dbo).catch(() => []);

  const isName = (r, re) => re.test(String((r && r.NOMBRE) || '').toUpperCase());
  let gastoVenta = 0;
  let gastoOperacion = 0;
  let gastoAdmin = 0;
  let otrosGastos = 0;
  let gastosFinancieros = 0;
  (rows || []).forEach((r) => {
    const cuenta = String(r.CUENTA_PT || '').trim();
    const imp = +r.IMP || 0;
    if (imp <= 0) return;
    if (isName(r, /FINAN/)) {
      gastosFinancieros += imp;
      return;
    }
    if (isName(r, /OTROS?\s+GAST/)) {
      otrosGastos += imp;
      return;
    }
    if (cuenta.startsWith('5201')) { gastoVenta += imp; return; }
    if (cuenta.startsWith('5202')) { gastoOperacion += imp; return; }
    if (cuenta.startsWith('52') || cuenta.startsWith('53') || cuenta.startsWith('54')) {
      gastoAdmin += imp;
    }
  });
  const extOpRows = await query(`
    SELECT COALESCE(SUM(${salGastoAbs}), 0) AS T
    FROM SALDOS_CO s
    JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
    WHERE ${salYearExpr} = ? AND ${salMonthExpr} = ?
      AND (
        cu.CUENTA_PT STARTING WITH '6'
        OR (
          cu.CUENTA_PT STARTING WITH '5'
          AND NOT cu.CUENTA_PT STARTING WITH '51'
          AND NOT (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        )
      )
  `, [y, m], 15000, dbo).catch(() => [{ T: 0 }]);
  const extOp = Math.abs(+((extOpRows[0] && extOpRows[0].T) || 0));
  if (extOp > 0.005) gastoOperacion += extOp;
  const totalGastosOperativos = gastoVenta + gastoOperacion + gastoAdmin;
  const utilidadOperacion = utilidadBruta - totalGastosOperativos;
  const utilidadAntesImpuestos = utilidadOperacion - otrosGastos - gastosFinancieros;
  const payload = {
    periodo: { desde: desdeStr, hasta: hastaStr, ANIO: y, MES: m },
    estado: {
      ventas_netas: Math.round(ventas * 100) / 100,
      costo_ventas: Math.round(costo * 100) / 100,
      utilidad_bruta: Math.round(utilidadBruta * 100) / 100,
      gastos_venta: Math.round(gastoVenta * 100) / 100,
      gastos_operacion: Math.round(gastoOperacion * 100) / 100,
      gastos_administracion: Math.round(gastoAdmin * 100) / 100,
      total_gastos_operativos: Math.round(totalGastosOperativos * 100) / 100,
      utilidad_operacion: Math.round(utilidadOperacion * 100) / 100,
      otros_gastos: Math.round(otrosGastos * 100) / 100,
      gastos_financieros: Math.round(gastosFinancieros * 100) / 100,
      utilidad_antes_impuestos: Math.round(utilidadAntesImpuestos * 100) / 100,
    },
    partidas_extraordinarias: {
      otros_gastos: Math.round(otrosGastos * 100) / 100,
      gastos_financieros: Math.round(gastosFinancieros * 100) / 100,
      total: Math.round((otrosGastos + gastosFinancieros) * 100) / 100,
    },
    cuentas_muestra: (rows || []).slice(0, 50),
  };

  return payload;
});

// Reconciliación extendida para febrero u otros periodos: ventas/costo/gastos por variantes.
get('/api/debug/pnl-reconcile-ext', async (req) => {
  const dbo = getReqDbOpts(req);
  const { desdeStr, hastaStr } = resolveDateRangeFromQuery(req.query || {});
  const params = [desdeStr, hastaStr];
  const out = {};
  const safeOne = async (k, sql, p = params) => {
    const rows = await query(sql, p, 15000, dbo).catch(() => [{ T: 0 }]);
    out[k] = +((rows[0] && (rows[0].T ?? rows[0].TOTAL)) || 0);
  };
  await Promise.all([
    safeOne('ventas_fv_aplicado', `
      SELECT COALESCE(SUM(${sqlVentaImporteBaseExpr('d')}),0) AS T
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('F','V')
        AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S')
        AND COALESCE(d.APLICADO,'N')='S'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    `),
    safeOne('ventas_f_solo', `
      SELECT COALESCE(SUM(${sqlVentaImporteBaseExpr('d')}),0) AS T
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO='F'
        AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S')
        AND COALESCE(d.APLICADO,'N')='S'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    `),
    safeOne('ventas_pv_fv_aplicado', `
      SELECT COALESCE(SUM(${sqlVentaImporteBaseExpr('d')}),0) AS T
      FROM DOCTOS_PV d
      WHERE d.TIPO_DOCTO IN ('F','V')
        AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S')
        AND COALESCE(d.APLICADO,'N')='S'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    `),
    safeOne('costo_conta_5101', `
      SELECT COALESCE(SUM(COALESCE(s.CARGOS,0) - COALESCE(s.ABONOS,0)),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '5101'
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('gastos_abs_52_53_54', `
      SELECT COALESCE(SUM(ABS(COALESCE(s.CARGOS,0)-COALESCE(s.ABONOS,0))),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('gastos_signed_52_53_54', `
      SELECT COALESCE(SUM(COALESCE(s.CARGOS,0)-COALESCE(s.ABONOS,0)),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE (cu.CUENTA_PT STARTING WITH '52' OR cu.CUENTA_PT STARTING WITH '53' OR cu.CUENTA_PT STARTING WITH '54')
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('gastos_abs_52', `
      SELECT COALESCE(SUM(ABS(COALESCE(s.CARGOS,0)-COALESCE(s.ABONOS,0))),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '52'
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('gastos_abs_53', `
      SELECT COALESCE(SUM(ABS(COALESCE(s.CARGOS,0)-COALESCE(s.ABONOS,0))),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '53'
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('gastos_abs_54', `
      SELECT COALESCE(SUM(ABS(COALESCE(s.CARGOS,0)-COALESCE(s.ABONOS,0))),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '54'
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
    safeOne('ventas_ve_fv_menos_iva116', `
      SELECT COALESCE(SUM(${sqlVentaImporteBaseExpr('d')} / 1.16),0) AS T
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('F','V')
        AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S')
        AND COALESCE(d.APLICADO,'N')='S'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    `),
    safeOne('ventas_pv_fv_menos_iva116', `
      SELECT COALESCE(SUM(${sqlVentaImporteBaseExpr('d')} / 1.16),0) AS T
      FROM DOCTOS_PV d
      WHERE d.TIPO_DOCTO IN ('F','V')
        AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S')
        AND COALESCE(d.APLICADO,'N')='S'
        AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE) AND CAST(d.FECHA AS DATE) <= CAST(? AS DATE)
    `),
    safeOne('ventas_conta_ingresos_4', `
      SELECT COALESCE(SUM(COALESCE(s.ABONOS,0)-COALESCE(s.CARGOS,0)),0) AS T
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE cu.CUENTA_PT STARTING WITH '4'
        AND s.ANO = EXTRACT(YEAR FROM CAST(? AS DATE))
        AND s.MES = EXTRACT(MONTH FROM CAST(? AS DATE))
    `),
  ]);
  const payload = { desdeStr, hastaStr, variantes: out };

  return payload;
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

get('/api/debug/cxc-reconcile', async (req) => {
  const dbo = getReqDbOpts(req);
  const q = (sql, params, ms) => query(sql, params, ms, dbo);
  const clienteTotalSql = (opts) => {
    const exContado = opts && opts.excludeContado ? CXC_EXCLUIR_CONTADO : '';
    const conIva = opts && opts.withIva;
    const cargoExpr = conIva ? '(i.IMPORTE + COALESCE(i.IMPUESTO, 0))' : 'i.IMPORTE';
    const reciboExpr = conIva
      ? '(i.IMPORTE + COALESCE(i.IMPUESTO, 0))'
      : `(CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END)`;
    return `
      SELECT COALESCE(SUM(x.SALDO), 0) AS T
      FROM (
        SELECT dc.CLIENTE_ID,
          SUM(CASE
            WHEN i.TIPO_IMPTE = 'C' THEN ${cargoExpr}
            WHEN i.TIPO_IMPTE = 'R' THEN -(${reciboExpr})
            ELSE 0
          END) AS SALDO
        FROM IMPORTES_DOCTOS_CC i
        JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
        LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
        LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
        WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${exContado}
        GROUP BY dc.CLIENTE_ID
        HAVING SUM(CASE
          WHEN i.TIPO_IMPTE = 'C' THEN ${cargoExpr}
          WHEN i.TIPO_IMPTE = 'R' THEN -(${reciboExpr})
          ELSE 0
        END) > 0
      ) x
    `;
  };
  const docSql = `
    SELECT
      SUM(CASE WHEN doc.DIAS_VENCIDO > 0 THEN doc.SALDO_NETO ELSE 0 END) AS VENCIDO,
      SUM(CASE WHEN doc.DIAS_VENCIDO <= 0 THEN doc.SALDO_NETO ELSE 0 END) AS POR_VENCER
    FROM ${cxcDocSaldosSQL('')}
  `;
  const movimientosSql = (excludeContado) => `
    SELECT
      SUM(CASE WHEN i.TIPO_IMPTE = 'C' THEN i.IMPORTE ELSE 0 END) AS CARGOS,
      SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN i.IMPORTE ELSE 0 END) AS RECIBOS_IMPORTE,
      SUM(CASE WHEN i.TIPO_IMPTE = 'R' THEN (CASE WHEN COALESCE(i.IMPUESTO, 0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END) ELSE 0 END) AS RECIBOS_NORMALIZADOS
    FROM IMPORTES_DOCTOS_CC i
    JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
    LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
    LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
    WHERE COALESCE(i.CANCELADO, 'N') = 'N' ${excludeContado ? CXC_EXCLUIR_CONTADO : ''}
  `;
  const [docRows, vCurrent, vLegacyEx, vActIn, vIvaEx, vIvaIn, movEx, movIn] = await Promise.all([
    q(docSql, [], 20000).catch(() => [{ VENCIDO: 0, POR_VENCER: 0 }]),
    q(`SELECT COALESCE(SUM(cs.SALDO), 0) AS T FROM ${cxcClienteSQL()} cs`, [], 20000).catch(() => [{ T: 0 }]),
    q(clienteTotalSql({ withIva: false, excludeContado: true }), [], 20000).catch(() => [{ T: 0 }]),
    q(clienteTotalSql({ withIva: false, excludeContado: false }), [], 20000).catch(() => [{ T: 0 }]),
    q(clienteTotalSql({ withIva: true, excludeContado: true }), [], 20000).catch(() => [{ T: 0 }]),
    q(clienteTotalSql({ withIva: true, excludeContado: false }), [], 20000).catch(() => [{ T: 0 }]),
    q(movimientosSql(true), [], 20000).catch(() => [{ CARGOS: 0, RECIBOS_IMPORTE: 0, RECIBOS_NORMALIZADOS: 0 }]),
    q(movimientosSql(false), [], 20000).catch(() => [{ CARGOS: 0, RECIBOS_IMPORTE: 0, RECIBOS_NORMALIZADOS: 0 }]),
  ]);
  const docV = +(docRows[0] && docRows[0].VENCIDO) || 0;
  const docP = +(docRows[0] && docRows[0].POR_VENCER) || 0;
  const payload = {
    metodo_doc_saldos: { total: Math.round((docV + docP) * 100) / 100, vencido: Math.round(docV * 100) / 100, por_vencer: Math.round(docP * 100) / 100 },
    metodo_cliente_actual_excluye_contado: Math.round((+(vCurrent[0] && vCurrent[0].T) || 0) * 100) / 100,
    metodo_cliente_legacy_excluye_contado: Math.round((+(vLegacyEx[0] && vLegacyEx[0].T) || 0) * 100) / 100,
    metodo_cliente_actual_incluye_contado: Math.round((+(vActIn[0] && vActIn[0].T) || 0) * 100) / 100,
    metodo_cliente_con_iva_excluye_contado: Math.round((+(vIvaEx[0] && vIvaEx[0].T) || 0) * 100) / 100,
    metodo_cliente_con_iva_incluye_contado: Math.round((+(vIvaIn[0] && vIvaIn[0].T) || 0) * 100) / 100,
    movimientos_excluye_contado: {
      cargos: Math.round((+(movEx[0] && movEx[0].CARGOS) || 0) * 100) / 100,
      recibos_importe: Math.round((+(movEx[0] && movEx[0].RECIBOS_IMPORTE) || 0) * 100) / 100,
      recibos_normalizados: Math.round((+(movEx[0] && movEx[0].RECIBOS_NORMALIZADOS) || 0) * 100) / 100,
    },
    movimientos_incluye_contado: {
      cargos: Math.round((+(movIn[0] && movIn[0].CARGOS) || 0) * 100) / 100,
      recibos_importe: Math.round((+(movIn[0] && movIn[0].RECIBOS_IMPORTE) || 0) * 100) / 100,
      recibos_normalizados: Math.round((+(movIn[0] && movIn[0].RECIBOS_NORMALIZADOS) || 0) * 100) / 100,
    },
  };

  return payload;
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

// Diagnóstico de cuentas contables — ayuda a entender por qué gastos muestran $0
get('/api/debug/saldos-co-cuentas', async (req) => {
  const dbo = getReqDbOpts(req);
  const q = (sql, params, ms) => query(sql, params, ms, dbo);
  const [totalCuentas, cuentasPrefijos, saldosCols, saldosMuestra, doctosCols] = await Promise.all([
    q(`SELECT COUNT(*) AS N FROM CUENTAS_CO`, [], 8000).catch(() => [{ N: -1 }]),
    q(`SELECT SUBSTRING(cu.CUENTA_PT FROM 1 FOR 2) AS PREFIJO2, COUNT(*) AS N
       FROM CUENTAS_CO cu WHERE cu.CUENTA_PT IS NOT NULL AND CHAR_LENGTH(TRIM(cu.CUENTA_PT)) >= 2
       GROUP BY 1 ORDER BY 2 DESC`, [], 10000).catch(() => []),
    q(`SELECT FIRST 1 * FROM SALDOS_CO`, [], 8000).catch(() => []).then(r => r[0] ? Object.keys(r[0]) : []),
    q(`SELECT FIRST 5 s.*, cu.CUENTA_PT, cu.NOMBRE FROM SALDOS_CO s
       JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
       WHERE cu.CUENTA_PT STARTING WITH '5'
       ORDER BY cu.CUENTA_PT`, [], 10000).catch(() => []),
    q(`SELECT FIRST 1 * FROM DOCTOS_CO_DET`, [], 8000).catch(() => []).then(r => r[0] ? Object.keys(r[0]) : []),
  ]);
  const prefijo5x = await q(`SELECT SUBSTRING(cu.CUENTA_PT FROM 1 FOR 4) AS PREF4, cu.NOMBRE, COUNT(s.CUENTA_ID) AS SALDOS
     FROM CUENTAS_CO cu LEFT JOIN SALDOS_CO s ON s.CUENTA_ID = cu.CUENTA_ID
     WHERE cu.CUENTA_PT STARTING WITH '5'
     GROUP BY 1, 2 ORDER BY 1`, [], 12000).catch(() => []);
  return {
    total_cuentas_co: (totalCuentas[0] || {}).N,
    saldos_co_columnas: saldosCols,
    doctos_co_det_columnas: doctosCols,
    prefijos_2dig_todos: cuentasPrefijos,
    cuentas_5xxx_con_saldos: prefijo5x,
    muestra_saldos_5xxx: saldosMuestra,
    nota: 'Si cuentas_5xxx_con_saldos tiene SALDOS=0 para prefijos 52/53/54, no hay polizas contables cargadas en Microsip para gastos operativos.',
  };
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

/** Lista de bases disponibles para ?db= (id/label + archivo). */
get('/api/debug/dbs', async (req) => {
  return {
    ok: true,
    count: DATABASE_REGISTRY.length,
    dbs: DATABASE_REGISTRY.map((d) => ({
      id: d.id,
      label: d.label || d.id,
      file: path.basename((d.options && d.options.database) || ''),
    })),
    nota: 'Usa el campo id en ?db=. label es solo informativo para humanos.',
  };
});

/**
 * Diagnóstico ultra-ligero Firebird: valida si el cuello es ATTACH/red vs tablas grandes.
 * Ejecuta una consulta mínima a RDB$DATABASE con timeout configurable (?ms=).
 */
get('/api/debug/firebird-ping', async (req) => {
  const dbo = getReqDbOpts(req);
  const ms = Math.min(240000, Math.max(5000, parseInt(String(req.query.ms || '20000'), 10) || 20000));
  const t0 = Date.now();
  try {
    const rows = await query('SELECT 1 AS OK FROM RDB$DATABASE', [], ms, dbo);
    const t1 = Date.now();
    return {
      ok: true,
      timeout_ms: ms,
      elapsed_ms: t1 - t0,
      sample: rows && rows[0] ? rows[0] : null,
      nota: 'Si esto timeoutea, el problema es conexión/red/locks del servidor Firebird (no el SQL de cotizaciones).',
    };
  } catch (e) {
    const t1 = Date.now();
    return {
      ok: false,
      timeout_ms: ms,
      elapsed_ms: t1 - t0,
      error: String(e && e.message ? e.message : e),
      nota: 'Si falla aquí, revisar host/puerto Firebird, VPN/firewall, locks, o latencia extrema entre Render y el servidor.',
    };
  }
});

/**
 * Monitoreo Firebird (MON$): revela locks/queries largas sin tocar DOCTOS_*.
 * Nota: MON$ existe en Firebird 2.1+; si no existe, regresará error.
 */
get('/api/debug/firebird-mon', async (req) => {
  const dbo = getReqDbOpts(req);
  const ms = Math.min(240000, Math.max(5000, parseInt(String(req.query.ms || '20000'), 10) || 20000));
  const t0 = Date.now();
  try {
    const [dbRows, txRows, stRows] = await Promise.all([
      query(
        `SELECT
           MON$ATTACHMENT_ID AS ATTACHMENT_ID,
           MON$OLDEST_TRANSACTION AS OLDEST_TX,
           MON$OLDEST_ACTIVE AS OLDEST_ACTIVE_TX,
           MON$OLDEST_SNAPSHOT AS OLDEST_SNAPSHOT_TX,
           MON$NEXT_TRANSACTION AS NEXT_TX
         FROM MON$DATABASE`,
        [],
        ms,
        dbo,
      ).catch((e) => ({ error: String(e && e.message ? e.message : e) })),
      query(
        `SELECT FIRST 15
           MON$TRANSACTION_ID AS TX_ID,
           MON$STATE AS STATE,
           MON$ISOLATION_MODE AS ISOLATION,
           MON$LOCK_TIMEOUT AS LOCK_TIMEOUT,
           MON$TIMESTAMP AS STARTED_AT,
           MON$ATTACHMENT_ID AS ATTACHMENT_ID
         FROM MON$TRANSACTIONS
         ORDER BY MON$TIMESTAMP ASC`,
        [],
        ms,
        dbo,
      ).catch((e) => ({ error: String(e && e.message ? e.message : e) })),
      query(
        `SELECT FIRST 15
           s.MON$STATEMENT_ID AS STMT_ID,
           s.MON$ATTACHMENT_ID AS ATTACHMENT_ID,
           s.MON$TIMESTAMP AS STARTED_AT,
           s.MON$STATE AS STATE,
           CHAR_LENGTH(s.MON$SQL_TEXT) AS SQL_LEN,
           SUBSTRING(s.MON$SQL_TEXT FROM 1 FOR 220) AS SQL_HEAD
         FROM MON$STATEMENTS s
         WHERE s.MON$SQL_TEXT IS NOT NULL
         ORDER BY s.MON$TIMESTAMP ASC`,
        [],
        ms,
        dbo,
      ).catch((e) => ({ error: String(e && e.message ? e.message : e) })),
    ]);
    return {
      ok: true,
      timeout_ms: ms,
      elapsed_ms: Date.now() - t0,
      mon_database: dbRows,
      mon_transactions: txRows,
      mon_statements: stRows,
      nota:
        'Si aquí aparecen statements muy viejos o OLDEST_* muy atrás, hay transacciones abiertas/locks/GC. Esto explica timeouts en DOCTOS_VE incluso para MAX().',
    };
  } catch (e) {
    return {
      ok: false,
      timeout_ms: ms,
      elapsed_ms: Date.now() - t0,
      error: String(e && e.message ? e.message : e),
      nota: 'Si MON$ no existe o falla, usar debug/schema e índices (metadata) para el siguiente paso.',
    };
  }
});

/**
 * Metadata de índices/PK sin escanear tablas grandes: confirma si DOCTO_VE_ID/DOCTO_PV_ID están indexados.
 */
get('/api/debug/doctos-meta', async (req) => {
  const dbo = getReqDbOpts(req);
  const ms = Math.min(240000, Math.max(5000, parseInt(String(req.query.ms || '20000'), 10) || 20000));
  const q = async (sql) => query(sql, [], ms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  const ve = await q(`
    SELECT
      TRIM(rc.RDB$RELATION_NAME) AS REL,
      TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
      TRIM(rc.RDB$CONSTRAINT_TYPE) AS CONSTRAINT_TYPE,
      TRIM(rc.RDB$INDEX_NAME) AS INDEX_NAME,
      TRIM(seg.RDB$FIELD_NAME) AS FIELD_NAME
    FROM RDB$RELATION_CONSTRAINTS rc
    JOIN RDB$INDEX_SEGMENTS seg ON seg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
    WHERE rc.RDB$RELATION_NAME = 'DOCTOS_VE'
      AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
      AND seg.RDB$FIELD_NAME = 'DOCTO_VE_ID'
  `);
  const pv = await q(`
    SELECT
      TRIM(rc.RDB$RELATION_NAME) AS REL,
      TRIM(rc.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME,
      TRIM(rc.RDB$CONSTRAINT_TYPE) AS CONSTRAINT_TYPE,
      TRIM(rc.RDB$INDEX_NAME) AS INDEX_NAME,
      TRIM(seg.RDB$FIELD_NAME) AS FIELD_NAME
    FROM RDB$RELATION_CONSTRAINTS rc
    JOIN RDB$INDEX_SEGMENTS seg ON seg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME
    WHERE rc.RDB$RELATION_NAME = 'DOCTOS_PV'
      AND rc.RDB$CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
      AND seg.RDB$FIELD_NAME = 'DOCTO_PV_ID'
  `);
  const relStats = await q(`
    SELECT
      TRIM(r.RDB$RELATION_NAME) AS REL,
      r.RDB$FORMAT AS FMT,
      r.RDB$RELATION_ID AS REL_ID,
      COALESCE(r.RDB$SYSTEM_FLAG, 0) AS SYS,
      COALESCE(r.RDB$FLAGS, 0) AS FLAGS
    FROM RDB$RELATIONS r
    WHERE r.RDB$RELATION_NAME IN ('DOCTOS_VE', 'DOCTOS_PV')
  `);
  return {
    ok: true,
    timeout_ms: ms,
    doctos_ve_pk: ve,
    doctos_pv_pk: pv,
    relations: relStats,
    nota:
      'Esto no toca datos, solo metadata. Si no hay PK/índice en DOCTO_*_ID, MAX()/ORDER BY serán lentísimos. Si sí hay, entonces el problema es lock/GC/transacción larga.',
  };
});

/** Buscar CLIENTE_ID por nombre (para alinear WEB vs PBI sin adivinar IDs). */
get('/api/debug/clientes-buscar', async (req) => {
  const termRaw = String(req.query.q || '').trim();
  if (!termRaw) return { ok: false, error: 'Parámetro requerido: q=' };
  const q = termRaw.slice(0, 80);
  const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || '25'), 10) || 25));
  const ms = Math.min(120000, Math.max(5000, parseInt(String(req.query.ms || '15000'), 10) || 15000));
  const sql = `
    SELECT FIRST ${limit}
      c.CLIENTE_ID,
      TRIM(COALESCE(c.NOMBRE, '')) AS NOMBRE
    FROM CLIENTES c
    WHERE UPPER(COALESCE(c.NOMBRE,'')) LIKE UPPER(?)
    ORDER BY c.CLIENTE_ID
  `;
  const params = [`%${q}%`];

  let rows;
  if (isAllDbs(req)) {
    rows = await runForAllDbs(async (dbo) => {
      const r = await query(sql, params, ms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
      // Si falló en una base, devolver 0 filas para no tumbar el agregado.
      return r && r.error ? [] : (r || []);
    });
  } else {
    const dbo = getReqDbOpts(req);
    rows = await query(sql, params, ms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  }
  return {
    ok: true,
    q,
    limit,
    timeout_ms: ms,
    rows,
    nota: 'Usa esto para encontrar el CLIENTE_ID (ej. SINDICATO...) y luego probar /api/cxc/resumen-aging?cliente=ID.',
  };
});

/** Sonda DOCTOS_VE/DOCTOS_PV: identifica si el atasco es ORDER BY, MAX(), o lectura por PK. */
get('/api/debug/doctos-probe', async (req) => {
  const dbo = getReqDbOpts(req);
  const ms = Math.min(240000, Math.max(5000, parseInt(String(req.query.ms || '45000'), 10) || 45000));
  const n = Math.min(30, Math.max(3, parseInt(String(req.query.n || '12'), 10) || 12));
  const out = { timeout_ms: ms, n };

  const step = async (key, fn) => {
    const t0 = Date.now();
    try {
      const val = await fn();
      out[key] = { ok: true, elapsed_ms: Date.now() - t0, value: val };
    } catch (e) {
      out[key] = { ok: false, elapsed_ms: Date.now() - t0, error: String(e && e.message ? e.message : e) };
    }
  };

  // VE
  await step('ve_max_id', async () => {
    const r = await query('SELECT MAX(d.DOCTO_VE_ID) AS ID FROM DOCTOS_VE d', [], ms, dbo);
    return r && r[0] ? +r[0].ID || 0 : 0;
  });
  const veMax = out.ve_max_id && out.ve_max_id.ok ? +out.ve_max_id.value || 0 : 0;
  if (veMax > 0) {
    await step('ve_by_pk', async () => {
      const r = await query(
        `SELECT d.DOCTO_VE_ID, d.FOLIO,
          TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO,
          TRIM(CAST(COALESCE(d.ESTATUS,'N') AS VARCHAR(8))) AS ESTATUS,
          CAST(d.FECHA AS DATE) AS FECHA_D
        FROM DOCTOS_VE d
        WHERE d.DOCTO_VE_ID = ?`,
        [veMax],
        ms,
        dbo,
      );
      return r && r[0] ? r[0] : null;
    });
    await step('ve_last_n_window', async () => {
      const fromId = Math.max(1, veMax - 5000);
      const r = await query(
        `SELECT FIRST ${n} d.DOCTO_VE_ID, d.FOLIO, TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO, TRIM(CAST(COALESCE(d.ESTATUS,'N') AS VARCHAR(8))) AS ESTATUS, CAST(d.FECHA AS DATE) AS FECHA_D FROM DOCTOS_VE d WHERE d.DOCTO_VE_ID >= ? ORDER BY d.DOCTO_VE_ID DESC`,
        [fromId],
        ms,
        dbo,
      );
      return { from_id: fromId, rows: r || [] };
    });
  }

  // PV (solo si piden src=PV o BOTH)
  const src = String(req.query.src || 'VE').trim().toUpperCase(); // VE|PV|BOTH
  out.src = src;
  if (src === 'PV' || src === 'BOTH') {
    await step('pv_max_id', async () => {
      const r = await query('SELECT MAX(d.DOCTO_PV_ID) AS ID FROM DOCTOS_PV d', [], ms, dbo);
      return r && r[0] ? +r[0].ID || 0 : 0;
    });
    const pvMax = out.pv_max_id && out.pv_max_id.ok ? +out.pv_max_id.value || 0 : 0;
    if (pvMax > 0) {
      await step('pv_by_pk', async () => {
        const r = await query(
          `SELECT d.DOCTO_PV_ID, d.FOLIO,
            TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO,
            TRIM(CAST(COALESCE(d.ESTATUS,'N') AS VARCHAR(8))) AS ESTATUS,
            CAST(d.FECHA AS DATE) AS FECHA_D
          FROM DOCTOS_PV d
          WHERE d.DOCTO_PV_ID = ?`,
          [pvMax],
          ms,
          dbo,
        );
        return r && r[0] ? r[0] : null;
      });
      await step('pv_last_n_window', async () => {
        const fromId = Math.max(1, pvMax - 5000);
        const r = await query(
          `SELECT FIRST ${n} d.DOCTO_PV_ID, d.FOLIO, TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO, TRIM(CAST(COALESCE(d.ESTATUS,'N') AS VARCHAR(8))) AS ESTATUS, CAST(d.FECHA AS DATE) AS FECHA_D FROM DOCTOS_PV d WHERE d.DOCTO_PV_ID >= ? ORDER BY d.DOCTO_PV_ID DESC`,
          [fromId],
          ms,
          dbo,
        );
        return { from_id: fromId, rows: r || [] };
      });
    }
  }

  out.nota =
    'Si ve_max_id falla → tabla/locks. Si ve_max_id ok pero ve_by_pk falla → lectura/índice. Si ve_by_pk ok pero ve_last_n_window falla → ORDER BY/plan. Con esto decidimos el siguiente fix.';
  return out;
});

/** Muestra ultrarrápida: últimos N docs VE/PV (sin GROUP BY masivo). Si tipos hace timeout, esto suele responder. */
get('/api/debug/cotizaciones-recientes', async (req) => {
  const dbo = getReqDbOpts(req);
  const n = Math.min(30, Math.max(3, parseInt(String(req.query.n || '12'), 10) || 12));
  const src = String(req.query.src || 'both').trim().toUpperCase(); // VE | PV | BOTH
  const t = 180000;
  const sqlVe = `
    SELECT FIRST ${n}
      d.FOLIO,
      TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO,
      TRIM(CAST(COALESCE(d.ESTATUS, 'N') AS VARCHAR(8))) AS ESTATUS,
      CAST(d.FECHA AS DATE) AS FECHA_D,
      d.DOCTO_VE_ID
    FROM DOCTOS_VE d
    ORDER BY d.DOCTO_VE_ID DESC
  `;
  const sqlPv = `
    SELECT FIRST ${n}
      d.FOLIO,
      TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS TIPO_DOCTO,
      TRIM(CAST(COALESCE(d.ESTATUS, 'N') AS VARCHAR(8))) AS ESTATUS,
      CAST(d.FECHA AS DATE) AS FECHA_D,
      d.DOCTO_PV_ID
    FROM DOCTOS_PV d
    ORDER BY d.DOCTO_PV_ID DESC
  `;
  const out = { n, src, timeout_ms: t };
  if (src !== 'PV') {
    out.ve_ultimos = await query(sqlVe, [], t, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  }
  if (src !== 'VE') {
    out.pv_ultimos = await query(sqlPv, [], t, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  }
  return {
    ...out,
    ve_ultimos: out.ve_ultimos && out.ve_ultimos.error ? out.ve_ultimos : out.ve_ultimos || [],
    pv_ultimos: out.pv_ultimos && out.pv_ultimos.error ? out.pv_ultimos : out.pv_ultimos || [],
    nota: 'Sin filtro de cotización: solo últimos documentos (ordenados por ID). Ver TIPO_DOCTO reales vs macro C,O,Q,P. Si esto también timeout, FB/red muy lentos.',
  };
});

/** Diagnóstico: TIPO_DOCTO en ventana + macro cotización. Serial + fecha por parámetro; default 14 días (7–800). */
get('/api/debug/cotizaciones-tipos', async (req) => {
  const dbo = getReqDbOpts(req);
  const dias = Math.min(800, Math.max(7, parseInt(String(req.query.dias || '14'), 10) || 14));
  const desde = new Date();
  desde.setDate(desde.getDate() - dias);
  const desdeStr =
    desde.getFullYear() + '-' + String(desde.getMonth() + 1).padStart(2, '0') + '-' + String(desde.getDate()).padStart(2, '0');
  const cotiOpts = await cotizacionSqlOpts(dbo);
  const feVe = cotiOpts.sqlFeVe || 'd.FECHA';
  const fePv = cotiOpts.sqlFePv || 'd.FECHA';
  const wVe = sqlWhereCotizacionComoVenta('d', 'VE');
  const wPv = sqlWhereCotizacionComoVenta('d', 'PV');
  const imp = sqlCotiImporteExpr('d');
  const vig = String(cotiOpts.vigenciaVeSuffix || '');
  const dateVe = `CAST(${feVe} AS DATE) >= CAST(? AS DATE)`;
  const datePv = `CAST(${fePv} AS DATE) >= CAST(? AS DATE)`;
  const params = [desdeStr];

  const sqlVe = `
    SELECT TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS T, COUNT(*) AS N
    FROM DOCTOS_VE d
    WHERE COALESCE(d.ESTATUS, 'N') <> 'C' AND ${dateVe}
    GROUP BY TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40)))
    ORDER BY N DESC
  `;
  const sqlPv = `
    SELECT TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40))) AS T, COUNT(*) AS N
    FROM DOCTOS_PV d
    WHERE COALESCE(d.ESTATUS, 'N') <> 'C' AND ${datePv}
    GROUP BY TRIM(CAST(d.TIPO_DOCTO AS VARCHAR(40)))
    ORDER BY N DESC
  `;
  const macroVeSql = `
    SELECT COUNT(*) AS DOCS, COALESCE(SUM(${imp}), 0) AS IMPORTE_SUM
    FROM DOCTOS_VE d
    WHERE (${wVe})${vig} AND ${dateVe}
  `;
  const macroPvSql = `
    SELECT COUNT(*) AS DOCS, COALESCE(SUM(${imp}), 0) AS IMPORTE_SUM
    FROM DOCTOS_PV d
    WHERE (${wPv}) AND ${datePv}
  `;

  const qms = 240000;
  const ve = await query(sqlVe, params, qms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  const pv = await query(sqlPv, params, qms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  const veMacroRows = await query(macroVeSql, params, qms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));
  const pvMacroRows = await query(macroPvSql, params, qms, dbo).catch((e) => ({ error: String(e && e.message ? e.message : e) }));

  const veErr = veMacroRows && veMacroRows.error;
  const pvErr = pvMacroRows && pvMacroRows.error;
  const v1 = !veErr ? veMacroRows[0] || {} : {};
  const v2 = !pvErr ? pvMacroRows[0] || {} : {};
  const macro = {
    DOCS: (+v1.DOCS || 0) + (+v2.DOCS || 0),
    IMPORTE_SUM: (+v1.IMPORTE_SUM || 0) + (+v2.IMPORTE_SUM || 0),
    por_fuente: {
      ve: veErr ? { error: veErr } : v1,
      pv: pvErr ? { error: pvErr } : v2,
    },
  };
  if (veErr || pvErr) {
    const parts = [veErr, pvErr].filter(Boolean);
    if (parts.length) macro.error = parts.join(' | ');
  }

  return {
    ve_tipos: ve,
    pv_tipos: pv,
    ventana_dias: dias,
    desde_param: desdeStr,
    macro_cotizaciones_ult_400d: macro,
    nota:
      'Consultas en serie; fecha por parámetro. Default ?dias=14 (min 7). Si timeout, usar /api/debug/cotizaciones-recientes. MICROSIP_COTIZACION_SOLO_TIPO_MARCADO=1 desactiva el fallback amplio.',
  };
});

// ═══════════════════════════════════════════════════════════
//  CONSUMOS — por cantidades vendidas (unidades)
// ═══════════════════════════════════════════════════════════

get('/api/consumos/resumen', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd');
  const [totRows, maxRows] = await Promise.all([
    query(`
      SELECT
        COALESCE(SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.UNIDADES ELSE 0 END), 0) AS HOY_UNIDADES,
        COALESCE(SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_LINEA ELSE 0 END), 0) AS HOY_VENTA_IMPORTE,
        COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES_PERIODO,
        COALESCE(SUM(d.IMPORTE_LINEA), 0) AS VENTA_IMPORTE_PERIODO,
        COUNT(*) AS MOVIMIENTOS,
        COUNT(DISTINCT CAST(d.FECHA AS DATE)) AS DIAS_CON_MOVIMIENTO,
        COUNT(DISTINCT d.ARTICULO_ID) AS ARTICULOS_CONSUMIDOS
      FROM ${sub} d
      WHERE d.UNIDADES > 0 ${f.sql}
    `, f.params, 30000, dbo).catch(() => []),
    query(`
      SELECT FIRST 1
        CAST(d.FECHA AS DATE) AS DIA_MAXIMO,
        COALESCE(SUM(d.UNIDADES), 0) AS MAXIMO_DIARIO
      FROM ${sub} d
      WHERE d.UNIDADES > 0 ${f.sql}
      GROUP BY CAST(d.FECHA AS DATE)
      ORDER BY MAXIMO_DIARIO DESC, DIA_MAXIMO DESC
    `, f.params, 30000, dbo).catch(() => [])
  ]);
  const t = totRows[0] || {};
  const m = maxRows[0] || {};
  const unidadesPeriodo = +t.UNIDADES_PERIODO || 0;
  const diasConMov = +t.DIAS_CON_MOVIMIENTO || 0;
  return {
    HOY_UNIDADES: +t.HOY_UNIDADES || 0,
    HOY_VENTA_IMPORTE: +t.HOY_VENTA_IMPORTE || 0,
    UNIDADES_PERIODO: unidadesPeriodo,
    VENTA_IMPORTE_PERIODO: +t.VENTA_IMPORTE_PERIODO || 0,
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
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
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
    FROM ${sub} d
    WHERE d.UNIDADES > 0 AND CAST(d.FECHA AS DATE) >= CAST(? AS DATE)
    GROUP BY CAST(d.FECHA AS DATE)
    ORDER BY 1
  `, [desdeStr], 30000, dbo).catch(() => []);
  return rows || [];
});

get('/api/consumos/top-articulos', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
  const f = buildFiltros(req, 'd');
  const limit = Math.min(parseInt(req.query.limit) || 15, 100);
  return query(`
    SELECT FIRST ${limit}
      d.ARTICULO_ID,
      COALESCE(a.NOMBRE, 'Art. ' || CAST(d.ARTICULO_ID AS VARCHAR(12))) AS ARTICULO,
      COALESCE(a.UNIDAD_VENTA, 'PZA') AS UNIDAD,
      COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES,
      COALESCE(SUM(d.IMPORTE_LINEA), 0) AS VENTA_IMPORTE
    FROM ${sub} d
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
    WHERE d.UNIDADES > 0 ${f.sql}
    GROUP BY d.ARTICULO_ID, a.NOMBRE, a.UNIDAD_VENTA
    ORDER BY UNIDADES DESC
  `, f.params, 30000, dbo).catch(() => []);
});

get('/api/consumos/por-vendedor', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
  const f = buildFiltros(req, 'd');
  const rows = await query(`
    SELECT
      d.VENDEDOR_ID,
      COALESCE(v.NOMBRE, 'Vendedor ' || CAST(d.VENDEDOR_ID AS VARCHAR(10))) AS VENDEDOR,
      COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES,
      COALESCE(SUM(d.IMPORTE_LINEA), 0) AS VENTA_IMPORTE
    FROM ${sub} d
    LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID
    WHERE d.UNIDADES > 0 AND d.VENDEDOR_ID > 0 ${f.sql}
    GROUP BY d.VENDEDOR_ID, v.NOMBRE
    ORDER BY UNIDADES DESC
  `, f.params, 30000, dbo).catch(() => []);
  const total = (rows || []).reduce((s, r) => s + (+r.UNIDADES || 0), 0);
  const totalImp = (rows || []).reduce((s, r) => s + (+r.VENTA_IMPORTE || 0), 0);
  return (rows || []).map(r => ({
    ...r,
    PARTICIPACION: total > 0 ? Math.round((+r.UNIDADES || 0) / total * 10000) / 100 : 0,
    PARTICIPACION_IMPORTE: totalImp > 0 ? Math.round((+r.VENTA_IMPORTE || 0) / totalImp * 10000) / 100 : 0
  }));
});

/**
 * Cruce Consumo vs Pedidos/OC en el periodo.
 * Busca dinámicamente una estructura de compras válida (CM/CP/OC) y agrega unidades pedidas
 * para los artículos de mayor consumo del filtro activo.
 */
get('/api/consumos/pedidos-compra', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
  if (!req.query.desde && !req.query.hasta && !req.query.anio) {
    const now = new Date();
    req.query.anio = now.getFullYear();
    req.query.mes = now.getMonth() + 1;
  }
  const f = buildFiltros(req, 'd', { omitVendedorCliente: true });
  const topN = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 5), 30);
  const topRows = await query(`
    SELECT FIRST ${topN}
      d.ARTICULO_ID,
      COALESCE(a.NOMBRE, 'Art. ' || CAST(d.ARTICULO_ID AS VARCHAR(12))) AS ARTICULO,
      COALESCE(SUM(d.UNIDADES), 0) AS UNIDADES_CONSUMO
    FROM ${sub} d
    LEFT JOIN ARTICULOS a ON a.ARTICULO_ID = d.ARTICULO_ID
    WHERE d.UNIDADES > 0 ${f.sql}
    GROUP BY d.ARTICULO_ID, a.NOMBRE
    ORDER BY UNIDADES_CONSUMO DESC
  `, f.params, 18000, dbo).catch(() => []);
  const ids = (topRows || []).map(r => +r.ARTICULO_ID || 0).filter(Boolean);

  const sourceCandidates = [
    { key: 'OC', head: 'DOCTOS_OC', det: 'DOCTOS_OC_DET', headId: 'DOCTO_OC_ID' },
    { key: 'CP', head: 'DOCTOS_CP', det: 'DOCTOS_CP_DET', headId: 'DOCTO_CP_ID' },
    // CM se deja al final porque suele incluir movimientos internos, no solo pedidos.
    { key: 'CM', head: 'DOCTOS_CM', det: 'DOCTOS_CM_DET', headId: 'DOCTO_CM_ID' },
  ];
  let src = null;
  for (const c of sourceCandidates) {
    const [hCols, dCols] = await Promise.all([
      getTableColumns(c.head, dbo).catch(() => new Set()),
      getTableColumns(c.det, dbo).catch(() => new Set()),
    ]);
    const hid = firstExistingColumn(hCols, [c.headId, 'ID']);
    const did = firstExistingColumn(dCols, [c.headId, 'ID']);
    const art = firstExistingColumn(dCols, ['ARTICULO_ID']);
    const qty = firstExistingColumn(dCols, ['UNIDADES', 'CANTIDAD', 'CANT', 'UNIDAD']);
    const fec = firstExistingColumn(hCols, ['FECHA', 'FCH_HORA', 'CREADO_EN']);
    const est = firstExistingColumn(hCols, ['ESTATUS', 'STATUS']);
    if (hid && did && art && qty && fec) {
      src = { ...c, hid, did, art, qty, fec, est };
      break;
    }
  }



  if (!src) {
    return {
      ok: false,
      message: 'No se encontró estructura de pedidos/OC compatible en esta base.',
      source: null,
      top_consumo: (topRows || []).map(r => ({
        ARTICULO_ID: r.ARTICULO_ID,
        ARTICULO: r.ARTICULO,
        UNIDADES_CONSUMO: +r.UNIDADES_CONSUMO || 0,
        UNIDADES_PEDIDAS: 0,
        COBERTURA_PEDIDOS_PCT: 0,
      })),
    };
  }

  const fh = buildFiltros(req, 'h', { omitVendedorCliente: true, fechaExpr: `h.${src.fec}` });
  const inSql = ids.length ? ` AND det.${src.art} IN (${ids.map(() => '?').join(',')})` : '';
  const stSql = src.est ? ` AND COALESCE(h.${src.est}, '') <> 'C'` : '';
  const pedRows = ids.length ? await query(`
    SELECT
      det.${src.art} AS ARTICULO_ID,
      COALESCE(SUM(COALESCE(det.${src.qty}, 0)), 0) AS UNIDADES_PEDIDAS
    FROM ${src.head} h
    JOIN ${src.det} det ON det.${src.did} = h.${src.hid}
    WHERE 1=1 ${fh.sql} ${stSql} ${inSql}
    GROUP BY det.${src.art}
  `, [...fh.params, ...ids], 20000, dbo).catch(() => []) : [];
  const pedMap = new Map((pedRows || []).map(r => [+r.ARTICULO_ID || 0, +r.UNIDADES_PEDIDAS || 0]));
  const outRows = (topRows || []).map(r => {
    const cons = +r.UNIDADES_CONSUMO || 0;
    const ped = pedMap.get(+r.ARTICULO_ID || 0) || 0;
    const cov = cons > 0 ? Math.round((ped / cons) * 10000) / 100 : 0;
    return {
      ARTICULO_ID: r.ARTICULO_ID,
      ARTICULO: r.ARTICULO,
      UNIDADES_CONSUMO: cons,
      UNIDADES_PEDIDAS: ped,
      BRECHA_UNIDADES: Math.round((cons - ped) * 100) / 100,
      COBERTURA_PEDIDOS_PCT: cov,
    };
  });
  const totalCons = outRows.reduce((s, r) => s + (+r.UNIDADES_CONSUMO || 0), 0);
  const totalPed = outRows.reduce((s, r) => s + (+r.UNIDADES_PEDIDAS || 0), 0);



  return {
    ok: true,
    source: {
      key: src.key,
      head: src.head,
      det: src.det,
      qtyColumn: src.qty,
      dateColumn: src.fec,
      confidence: src.key === 'CM' ? 'low' : 'high',
      note: src.key === 'CM' ? 'CM puede mezclar movimientos internos además de compras.' : 'Origen de compras detectado.',
    },
    resumen: {
      unidades_consumo_top: Math.round(totalCons * 100) / 100,
      unidades_pedidas_top: Math.round(totalPed * 100) / 100,
      cobertura_pedidos_top_pct: totalCons > 0 ? Math.round((totalPed / totalCons) * 10000) / 100 : 0,
      brecha_top: Math.round((totalCons - totalPed) * 100) / 100,
    },
    top_consumo: outRows,
  };
});

/**
 * KPIs extra consumos: variación semanal (7 vs 7), concentración Top 5, vs periodo anterior,
 * cobertura inventario sobre top artículos.
 */
get('/api/consumos/insights', async (req) => {
  const dbo = getReqDbOpts(req);
  const tipo = getTipo(req);
  const parts = await resolveConsumosSchema(dbo);
  const sub = consumosSubSql(tipo, parts);
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
  const consumoDiarioTop = cobertura.reduce((s, r) => s + (+r.CONSUMO_DIARIO_PROM || 0), 0);
  const existenciaTop = cobertura.reduce((s, r) => s + (+r.EXISTENCIA || 0), 0);
  const inventarioMinTop = cobertura.reduce((s, r) => s + (+r.INVENTARIO_MINIMO || 0), 0);
  const inventarioOperativo14 = cobertura.reduce((s, r) => {
    const diario = +r.CONSUMO_DIARIO_PROM || 0;
    const minimo = +r.INVENTARIO_MINIMO || 0;
    return s + Math.max(minimo, diario * 14);
  }, 0);
  const faltanteOperativo = Math.max(0, inventarioOperativo14 - existenciaTop);
  const diasOperacionTop = consumoDiarioTop > 0
    ? Math.round((existenciaTop / consumoDiarioTop) * 100) / 100
    : null;
  const criticos = cobertura
    .filter(r => {
      const dc = +r.DIAS_COBERTURA;
      const ex = +r.EXISTENCIA || 0;
      const min = +r.INVENTARIO_MINIMO || 0;
      const diario = +r.CONSUMO_DIARIO_PROM || 0;
      return (diario > 0 && ex <= 0) || (min > 0 && ex <= min) || (diario > 0 && Number.isFinite(dc) && dc < 10);
    })
    .sort((a, b) => (+a.DIAS_COBERTURA || 0) - (+b.DIAS_COBERTURA || 0))
    .slice(0, 5);

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
    operacion_minima: {
      dias_objetivo: 14,
      consumo_diario_top: Math.round(consumoDiarioTop * 100) / 100,
      existencia_top: Math.round(existenciaTop * 100) / 100,
      inventario_minimo_top: Math.round(inventarioMinTop * 100) / 100,
      inventario_operativo_objetivo: Math.round(inventarioOperativo14 * 100) / 100,
      faltante_operativo: Math.round(faltanteOperativo * 100) / 100,
      dias_operacion_estimados_top: diasOperacionTop,
    },
    alertas_criticas: criticos,
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
get('/api/debug/articulos-schema', async (req) => {
  const dbo = getReqDbOpts(req);
  const row = await query(`SELECT FIRST 1 * FROM ARTICULOS`, [], 20000, dbo).catch(() => []);
  const cols = (row && row[0]) ? Object.keys(row[0]).sort() : [];
  const costRelated = (cols || []).filter(c => /COSTO|PRECIO|COST/i.test(c));
  return { columnas: cols, relacionadasConCosto: costRelated, muestra: row && row[0] ? row[0] : null };
});

// Ver si ARTICULOS tiene COSTO_PROMEDIO y si hay valores > 0
get('/api/debug/articulos-costo', async (req) => {
  const dbo = getReqDbOpts(req);
  let error = null;
  let sample = [];
  let totalSum = 0;
  let cols = new Set();
  try {
    cols = await getTableColumns('ARTICULOS', dbo).catch(() => new Set());
    sample = await query(`
      SELECT FIRST 10 a.ARTICULO_ID, a.NOMBRE, a."COSTO_PROMEDIO"
      FROM ARTICULOS a
      WHERE COALESCE(a."COSTO_PROMEDIO", 0) > 0
    `, [], 25000, dbo).catch(() => []);
    const sumRow = await query(`
      SELECT COUNT(*) AS C, COALESCE(SUM(a."COSTO_PROMEDIO"), 0) AS S
      FROM ARTICULOS a WHERE COALESCE(a."COSTO_PROMEDIO", 0) > 0
    `, [], 25000, dbo).catch(() => [{ C: 0, S: 0 }]);
    totalSum = sumRow && sumRow[0] ? +(sumRow[0].S || 0) : 0;
  } catch (e) {
    error = e.message || String(e);
  }
  return { ok: !error, db: normalizeDbQueryId(req.query.db) || 'default', cols_count: cols && cols.size ? cols.size : 0, has_costo_promedio: cols instanceof Set ? cols.has('COSTO_PROMEDIO') : null, error, sample: sample || [], articulosConCosto: (sample || []).length, totalSum };
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
    build: BUILD_FINGERPRINT,
    empresa: process.env.EMPRESA_NOMBRE || 'SUMINREGIO PARKER',
  });
});

// Diagnóstico: top cuentas con movimiento contable (Saldos y Pólizas) para un mes.
// Útil cuando /api/resultados/pnl trae CO_* = 0 (Mar/Abr): revela si hay pólizas en otras cuentas o si no hay contabilidad capturada.
app.get('/api/debug/gastos-co-mes', async (req, res) => {
  const dbo = getReqDbOpts(req);
  const y = parseInt(String(req.query.anio || ''), 10);
  const m = parseInt(String(req.query.mes || ''), 10);
  if (!y || m < 1 || m > 12) {
    return res.status(400).json({ ok: false, error: 'Parámetros requeridos: anio=YYYY&mes=1..12' });
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10) || 30, 5), 200);
  try {
    const salCols = await getTableColumns('SALDOS_CO', dbo).catch(() => new Set());
    const salAnoCol = firstExistingColumn(salCols, ['ANO', 'ANIO', 'EJERCICIO']) || 'ANO';
    const salMesCol = firstExistingColumn(salCols, ['MES', 'PERIODO', 'NUM_MES']) || 'MES';
    const salCargoCol = firstExistingColumn(salCols, ['CARGOS', 'CARGO', 'DEBE']) || 'CARGOS';
    const salAbonoCol = firstExistingColumn(salCols, ['ABONOS', 'ABONO', 'HABER']) || 'ABONOS';
    const detCols = await getTableColumns('DOCTOS_CO_DET', dbo).catch(() => new Set());
    const detCargoCol = firstExistingColumn(detCols, ['CARGO', 'CARGOS', 'DEBE']);
    const detAbonoCol = firstExistingColumn(detCols, ['ABONO', 'ABONOS', 'HABER']);
    const detImporteCol = firstExistingColumn(detCols, ['IMPORTE', 'MONTO']);
    const detDeltaExprRaw = (detCargoCol && detAbonoCol)
      ? `COALESCE(d.${detCargoCol}, 0) - COALESCE(d.${detAbonoCol}, 0)`
      : (detImporteCol ? `COALESCE(d.${detImporteCol}, 0)` : '0');
    const detDeltaExpr = detImporteCol
      ? `(CASE WHEN ABS(${detDeltaExprRaw}) > 0 THEN ${detDeltaExprRaw} ELSE COALESCE(d.${detImporteCol}, 0) END)`
      : detDeltaExprRaw;
    const detAbsExpr = `ABS(${detDeltaExpr})`;
    const detDateExpr = detCols.has('FECHA') ? 'd.FECHA' : 'c.FECHA';
    const detNeedsDoctoJoin = !detCols.has('FECHA');
    const cuCoCols = await getTableColumns('CUENTAS_CO', dbo).catch(() => new Set());
    const cuentaExprCo = cuCoCols.has('CUENTA_JT')
      ? `COALESCE(NULLIF(TRIM(COALESCE(cu.CUENTA_PT, '')), ''), NULLIF(TRIM(COALESCE(cu.CUENTA_JT, '')), ''), '')`
      : `TRIM(COALESCE(cu.CUENTA_PT, ''))`;

    const salTop = await query(`
      SELECT FIRST ${limit}
        ${cuentaExprCo} AS CUENTA,
        TRIM(COALESCE(NULLIF(cu.NOMBRE, ''), NULLIF(cu.CUENTA_JT, ''), cu.CUENTA_PT)) AS NOMBRE,
        SUM(ABS(COALESCE(s.${salCargoCol}, 0) - COALESCE(s.${salAbonoCol}, 0))) AS IMP
      FROM SALDOS_CO s
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = s.CUENTA_ID
      WHERE s.${salAnoCol} = ? AND s.${salMesCol} = ?
      GROUP BY 1, 2
      ORDER BY IMP DESC
    `, [y, m], 15000, dbo).catch(() => []);

    const detTop = await query(`
      SELECT FIRST ${limit}
        ${cuentaExprCo} AS CUENTA,
        TRIM(COALESCE(NULLIF(cu.NOMBRE, ''), NULLIF(cu.CUENTA_JT, ''), cu.CUENTA_PT)) AS NOMBRE,
        SUM(${detAbsExpr}) AS IMP
      FROM DOCTOS_CO_DET d
      ${detNeedsDoctoJoin ? 'JOIN DOCTOS_CO c ON c.DOCTO_CO_ID = d.DOCTO_CO_ID' : ''}
      JOIN CUENTAS_CO cu ON cu.CUENTA_ID = d.CUENTA_ID
      WHERE EXTRACT(YEAR FROM ${detDateExpr}) = ? AND EXTRACT(MONTH FROM ${detDateExpr}) = ?
      GROUP BY 1, 2
      ORDER BY IMP DESC
    `, [y, m], 20000, dbo).catch(() => []);

    return res.json({
      ok: true,
      anio: y,
      mes: m,
      db: (req.query && req.query.db) ? String(req.query.db) : undefined,
      note: 'Si aquí aparecen cuentas de gastos en Mar/Abr, ajustamos el mapeo de prefijos. Si viene vacío o puro 0, entonces aún no hay contabilidad capturada/afectada para ese mes.',
      top_saldos_co: salTop,
      top_doctos_co_det: detTop,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Diagnóstico: un folio específico de CxC para comparar contra Power BI.
// Ej: /api/debug/cxc-folio?folio=SPK001733&db=default
app.get('/api/debug/cxc-folio', async (req, res) => {
  const dbo = getReqDbOpts(req);
  const folio = (req.query && req.query.folio != null) ? String(req.query.folio).trim() : '';
  if (!folio) return res.status(400).json({ ok: false, error: 'Parámetro requerido: folio' });
  const folioEsc = folio.replace(/'/g, "''");
  try {
    // Documento base + condición de pago (documento o cliente) + cálculo de vencimiento
    const rows = await query(`
      SELECT FIRST 1
        dc.DOCTO_CC_ID,
        dc.CLIENTE_ID,
        dc.FOLIO,
        CAST(dc.FECHA AS DATE) AS FECHA_DOCTO,
        COALESCE(cp.NOMBRE, 'S/D') AS CONDICION_PAGO,
        COALESCE(cp.DIAS_PPAG, 0) AS DIAS_PPAG,
        CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT} AS FECHA_VENC_CALC,
        CASE WHEN ${CXC_SQL_ES_CONTADO} THEN 0 ELSE (CURRENT_DATE - (CAST(dc.FECHA AS DATE) + ${CXC_DIAS_SUM_INT})) END AS DIAS_VENC_CALC
      FROM DOCTOS_CC dc
      LEFT JOIN CLIENTES clx ON clx.CLIENTE_ID = dc.CLIENTE_ID
      LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, clx.COND_PAGO_ID)
      WHERE TRIM(dc.FOLIO) = '${folioEsc}'
    `, [], 15000, dbo).catch(() => []);
    if (!rows || !rows.length) return res.json({ ok: false, folio, error: 'Folio no encontrado en DOCTOS_CC' });
    const d = rows[0];

    // Cargos y cobros (mismo criterio de SALDO_NETO que cxcDocSaldosInnerSQL)
    const sums = await query(`
      SELECT
        COALESCE((SELECT SUM(i.IMPORTE) FROM IMPORTES_DOCTOS_CC i
          WHERE i.DOCTO_CC_ID = ? AND i.TIPO_IMPTE = 'C' AND COALESCE(i.CANCELADO,'N') = 'N'), 0) AS CARGOS,
        COALESCE((SELECT SUM(${CXC_RECIBO_BASE_EXPR}) FROM IMPORTES_DOCTOS_CC i2
          WHERE i2.TIPO_IMPTE = 'R' AND COALESCE(i2.CANCELADO,'N') = 'N'
            AND (
              i2.DOCTO_CC_ACR_ID = ?
              OR (i2.DOCTO_CC_ID = ? AND i2.DOCTO_CC_ACR_ID IS NULL)
            )), 0) AS COBROS_BASE
    `, [d.DOCTO_CC_ID, d.DOCTO_CC_ID, d.DOCTO_CC_ID], 20000, dbo).catch(() => [{ CARGOS: 0, COBROS_BASE: 0 }]);
    const s = (sums && sums[0]) || { CARGOS: 0, COBROS_BASE: 0 };
    const saldoNeto = Math.round(((+s.CARGOS || 0) - (+s.COBROS_BASE || 0)) * 100) / 100;

    return res.json({
      ok: true,
      folio,
      docto_cc_id: +d.DOCTO_CC_ID || null,
      cliente_id: +d.CLIENTE_ID || null,
      fecha_docto: d.FECHA_DOCTO,
      condicion_pago: d.CONDICION_PAGO,
      dias_ppag: +d.DIAS_PPAG || 0,
      fecha_venc_calc: d.FECHA_VENC_CALC,
      dias_venc_calc: +d.DIAS_VENC_CALC || 0,
      cargos: Math.round((+s.CARGOS || 0) * 100) / 100,
      cobros_base: Math.round((+s.COBROS_BASE || 0) * 100) / 100,
      saldo_neto: saldoNeto,
      note: 'Compara estos campos contra Power BI: si Power BI lo marca vencido pero dias_venc_calc <= 0, hay que ajustar la fecha base/vencimiento (VENCIMIENTOS_CARGOS_CC, condición pago, o regla contado).',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, folio, error: String(e.message || e) });
  }
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

function aiReqFromBody(body, req) {
  const out = { query: {} };
  const src = body && typeof body === 'object' ? body : {};
  const bodyQuery = src.query && typeof src.query === 'object' ? src.query : {};
  const ctx = src.context && typeof src.context === 'object' ? src.context : {};
  const filters = ctx.filters && typeof ctx.filters === 'object' ? ctx.filters : {};
  const pick = (k) => {
    if (filters[k] != null && String(filters[k]).trim() !== '') return filters[k];
    if (bodyQuery[k] != null && String(bodyQuery[k]).trim() !== '') return bodyQuery[k];
    if (src[k] != null && String(src[k]).trim() !== '') return src[k];
    if (req && req.query && req.query[k] != null && String(req.query[k]).trim() !== '') return req.query[k];
    return '';
  };
  ['preset', 'anio', 'mes', 'desde', 'hasta', 'vendedor', 'cliente', 'tipo', 'meses'].forEach((k) => {
    const v = pick(k);
    if (v !== '') out.query[k] = v;
  });
  const msgPool = `${src.message || ''} ${(Array.isArray(src.messages) ? src.messages.map(m => (m && m.content) || '').join(' ') : '')}`.toLowerCase();
  const asksWeek = /\b(semana|semanal|esta semana|esta\s+sem)\b/.test(msgPool);
  if (!out.query.desde && !out.query.hasta && !out.query.anio) {
    if ((String(out.query.preset || '').toLowerCase() === 'semana') || asksWeek) {
      const now = new Date();
      const dow = now.getDay(); // 0 domingo, 1 lunes
      const diffToMonday = dow === 0 ? 6 : (dow - 1);
      const monday = new Date(now);
      monday.setDate(now.getDate() - diffToMonday);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.query.desde = iso(monday);
      out.query.hasta = iso(sunday);
      out.query.preset = 'semana';
    }
  }
  if (!out.query.desde && !out.query.hasta && !out.query.anio) {
    const now = new Date();
    out.query.anio = now.getFullYear();
    out.query.mes = now.getMonth() + 1;
  }
  return out;
}

const AI_SYSTEM_BASE_MICROSIP = `Eres el Agente de Soporte de **Suminregio Parker** — paneles que leen **Microsip (Firebird)** en solo lectura.

REGLAS:
- Responde en español, claro y conciso. No repitas saludos genéricos en cada mensaje.
- No inventes cifras: si el contexto trae datos del sistema, úsalos; si no hay datos, dilo en una frase.
- Estos dashboards **no modifican** Microsip; para altas o cambios operativos el usuario debe usar Microsip.
- Puedes explicar: ventas VE/PV, cotizaciones en DOCTOS_VE (TIPO C/O, no canceladas), **Cobradas** (cobros tipo R en CC, alineado con /api/ventas/cobradas), CxC y aging, inventario, resultados/P&L, scorecard multi-empresa cuando aplique.
- Si el contexto trae un bloque **Cobradas** o **Cotizaciones** con cifras, **respóndele al usuario con esos números** (importes, conteos, promedios). No digas que no tienes acceso a los datos del sistema si esas cifras están en el contexto.
- Si el contexto indica **empresa seleccionada**, céntrate en esa base; si hay una sola, no confundas al usuario.
- Si el contexto trae trazabilidad o bloques con cifras (ventas, cxc, resultados, cobradas, pronóstico), no respondas con frases tipo "no tengo acceso"; usa esas cifras.
- En preguntas analíticas, estructura la salida en 4 bloques: "Resumen ejecutivo", "Tabla de métricas", "Interpretación" y "Acciones recomendadas".`;

const AI_WELCOME_MICROSIP = `¡Hola! 👋 Soy tu **Agente de Soporte** (Suminregio Parker · Microsip).

Puedo ayudarte a **interpretar** ventas, cotizaciones, cuentas por cobrar, inventario y resultados. Todo es **solo lectura** frente a la base.

Ejemplos: "¿Cuántas cotizaciones van hoy?" · "¿Qué es el saldo de CxC?" · "¿Cuál es el ticket promedio cobrado este mes?" · "Explícame el margen bruto en Resultados."`;

const AI_TOOL_CATALOG = [
  { id: 'cotizaciones', label: 'Cotizaciones activas', area: 'ventas' },
  { id: 'cxc', label: 'Cuentas por cobrar', area: 'cartera' },
  { id: 'ventas', label: 'Ventas facturadas VE/PV', area: 'ventas' },
  { id: 'cobradas', label: 'Cobros registrados', area: 'cobranza' },
  { id: 'resultados', label: 'Estado de resultados / P&L', area: 'finanzas' },
  { id: 'pronostico_ventas', label: 'Pronóstico ventas 3 meses', area: 'analitica' },
  { id: 'escenario_visual', label: 'Dashboard visual generado', area: 'visual' },
  { id: 'dashboard_screenshot', label: 'Screenshot dashboard real', area: 'visual' },
];

const AI_CONTEXT_CACHE = new Map();
async function aiWithCache(key, ttlMs, computeFn) {
  const hit = AI_CONTEXT_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < ttlMs) return hit.val;
  const val = await computeFn();
  AI_CONTEXT_CACHE.set(key, { ts: now, val });
  return val;
}

function aiSelectTools({ text = '', lowerPool = '', page = '', requested = [] }) {
  const forced = Array.isArray(requested)
    ? requested.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (forced.length) {
    return [...new Set(forced)].filter(id => AI_TOOL_CATALOG.some(t => t.id === id));
  }
  const picks = [];
  const wantsCotizaciones = /\b(cotizaciones?|cotización|cotizacion)\b/i.test(lowerPool) ||
    (/\bhoy\b|fecha|\d{1,2}\s+de\s+\w+/i.test(text) && !/\bincidentes?\b/i.test(lowerPool));
  const wantsCxc = /\b(cxc|cuentas?\s+por\s+cobrar|saldo\s+clientes?|cobranza|deudores?|vencid[oa]s?)\b/i.test(lowerPool);
  const wantsVentas = /\b(ventas?|facturaci[oó]n|facturas?|vendid[oa]s?|vend[ií]|ingresos?\s+por\s+venta)\b/i.test(lowerPool) && !wantsCotizaciones;
  const wantsCobradas = /\b(cobrad[ao]s?|cobrado|pagos?\s+recibidos|ticket\s+promedio|abonos?\s+a\s+cc|total\s+cobrado|comisi[oó]n\s+8|facturas?\s+cobradas?)\b/i.test(lowerPool);
  const wantsResultados = /\b(resultados?|pnl|estado\s+de\s+resultados|margen(?:\s+bruto)?|utilidad|costo(?:s)?\s+de\s+venta)\b/i.test(lowerPool);
  const wantsForecast = /\b(pron[oó]stico|proyecci[oó]n|forecast|estimar|estimaci[oó]n|siguientes?\s+\d+\s+mes(es)?|pr[oó]ximos?\s+\d+\s+mes(es)?)\b/i.test(lowerPool) && /\b(ventas?|facturaci[oó]n|vendid[oa]s?)\b/i.test(lowerPool);
  const wantsVisualScenario = /\b(visual(?:es)?\s+ai|escenario|simulaci[oó]n)\b/i.test(lowerPool);
  const wantsDashboardShot = /\b(screenshot|captura|pantalla|dashboard real|vista actual)\b/i.test(lowerPool);

  if (wantsCotizaciones) picks.push('cotizaciones');
  if (wantsCxc) picks.push('cxc');
  if (wantsVentas) picks.push('ventas');
  if (wantsCobradas) picks.push('cobradas');
  if (wantsResultados) picks.push('resultados');
  if (wantsForecast) picks.push('pronostico_ventas');
  const wantsExplicitScenario = /\b(escenario|simulaci[oó]n)\b/i.test(lowerPool);
  if (wantsVisualScenario && (!wantsDashboardShot || wantsExplicitScenario)) picks.push('escenario_visual');
  if (wantsDashboardShot) picks.push('dashboard_screenshot');
  if (!picks.length) {
    if (/resultados\.html/i.test(page)) picks.push('resultados');
    else if (/cxc\.html/i.test(page)) picks.push('cxc');
    else if (/cobradas\.html/i.test(page)) picks.push('cobradas');
    else if (/ventas\.html/i.test(page)) picks.push('ventas');
  }
  return [...new Set(picks)];
}

function aiAnthropicModelCandidates() {
  const envModel = String(process.env.ANTHROPIC_MODEL || '').trim();
  const defaults = [
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
  ];
  const out = [];
  if (envModel) out.push(envModel);
  defaults.forEach((m) => { if (!out.includes(m)) out.push(m); });
  return out;
}

function aiFmtYm(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

function aiAddMonths(y, m, add) {
  const d = new Date(y, m - 1 + add, 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

function aiLinRegPredict(seriesY, horizon) {
  const n = seriesY.length;
  if (n < 2) return Array.from({ length: horizon }, () => (seriesY[n - 1] || 0));
  let sx = 0; let sy = 0; let sxy = 0; let sx2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i + 1;
    const y = Number(seriesY[i] || 0);
    sx += x; sy += y; sxy += x * y; sx2 += x * x;
  }
  const den = (n * sx2 - sx * sx) || 1;
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  const out = [];
  for (let h = 1; h <= horizon; h++) {
    out.push(Math.max(0, a + b * (n + h)));
  }
  return out;
}

function aiSnaivePredict(seriesY, horizon, season) {
  const n = seriesY.length;
  if (n < season) return Array.from({ length: horizon }, () => (seriesY[n - 1] || 0));
  const out = [];
  for (let h = 1; h <= horizon; h++) {
    const idx = n - season + ((h - 1) % season);
    out.push(Math.max(0, Number(seriesY[idx] || 0)));
  }
  return out;
}

function aiModelMae(seriesY, model) {
  const n = seriesY.length;
  const hold = Math.min(6, Math.max(2, n - 2));
  let err = 0; let cnt = 0;
  for (let i = n - hold; i < n; i++) {
    const train = seriesY.slice(0, i);
    const pred = model(train, 1)[0];
    err += Math.abs((seriesY[i] || 0) - (pred || 0));
    cnt++;
  }
  return cnt ? (err / cnt) : Number.POSITIVE_INFINITY;
}

function aiSvgEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function aiFmtMoneyMx(v, min = 2, max = 2) {
  const n = Number(v || 0);
  return n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: min, maximumFractionDigits: max });
}

function aiSvgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function aiBuildScenarioSvg(payload) {
  const title = aiSvgEscape(payload.title || 'Escenario generado');
  const subtitle = aiSvgEscape(payload.subtitle || '');
  const kpis = Array.isArray(payload.kpis) ? payload.kpis.slice(0, 4) : [];
  const hist = Array.isArray(payload.hist) ? payload.hist : [];
  const pred = Array.isArray(payload.pred) ? payload.pred : [];
  const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 6) : [];
  const w = 1200; const h = 760;
  const chartX = 70; const chartY = 245; const chartW = 1060; const chartH = 245;
  const vals = [...hist.map(Number), ...pred.map(Number)].filter(n => Number.isFinite(n));
  const maxV = Math.max(1, ...vals);
  const maxVLabel = aiSvgEscape(aiFmtMoneyMx(maxV));
  const minVLabel = aiSvgEscape(aiFmtMoneyMx(0));
  const toX = (i, n) => chartX + (n <= 1 ? 0 : (i * chartW / (n - 1)));
  const toY = (v) => chartY + chartH - ((Number(v || 0) / maxV) * chartH);
  const histPts = hist.map((v, i) => `${toX(i, hist.length)},${toY(v)}`).join(' ');
  const predPts = pred.map((v, i) => `${toX(hist.length - 1 + i, hist.length - 1 + pred.length)},${toY(v)}`).join(' ');
  const cards = kpis.map((k, i) => {
    const x = 45 + i * 285;
    return `
      <rect x="${x}" y="90" width="265" height="120" rx="14" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.14)"/>
      <text x="${x + 16}" y="124" fill="#93B4CC" font-family="Inter,Arial" font-size="16">${aiSvgEscape(k.label || '')}</text>
      <text x="${x + 16}" y="168" fill="#EDF4FF" font-family="Inter,Arial" font-size="30" font-weight="700">${aiSvgEscape(k.value || '')}</text>
    `;
  }).join('\n');
  const tableRows = rows.map((r, i) => `
      <text x="68" y="${555 + i * 34}" fill="#C8D8EC" font-family="Inter,Arial" font-size="16">${aiSvgEscape(r.name || '')}</text>
      <text x="1120" y="${555 + i * 34}" fill="#EDF4FF" text-anchor="end" font-family="Inter,Arial" font-size="16" font-weight="700">${aiSvgEscape(r.value || '')}</text>
  `).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0B1B2D"/>
      <stop offset="100%" stop-color="#07111E"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <text x="45" y="48" fill="#EDF4FF" font-family="Inter,Arial" font-size="34" font-weight="800">${title}</text>
  <text x="45" y="74" fill="#93B4CC" font-family="Inter,Arial" font-size="16">${subtitle}</text>
  ${cards}
  <text x="45" y="232" fill="#FFB800" font-family="Inter,Arial" font-size="18" font-weight="700">Tendencia histórica + pronóstico</text>
  <rect x="${chartX}" y="${chartY}" width="${chartW}" height="${chartH}" rx="12" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.12)"/>
  <text x="${chartX + 10}" y="${chartY + 22}" fill="#93B4CC" font-family="Inter,Arial" font-size="12">${maxVLabel}</text>
  <text x="${chartX + 10}" y="${chartY + chartH - 8}" fill="#93B4CC" font-family="Inter,Arial" font-size="12">${minVLabel}</text>
  <polyline fill="none" stroke="#4DA6FF" stroke-width="3" points="${histPts}"/>
  <polyline fill="none" stroke="#FFB800" stroke-width="3" stroke-dasharray="8 6" points="${predPts}"/>
  <line x1="${toX(Math.max(0, hist.length - 1), Math.max(1, hist.length - 1 + pred.length))}" y1="${chartY}" x2="${toX(Math.max(0, hist.length - 1), Math.max(1, hist.length - 1 + pred.length))}" y2="${chartY + chartH}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4"/>
  <text x="70" y="530" fill="#FFB800" font-family="Inter,Arial" font-size="18" font-weight="700">Top hallazgos</text>
  ${tableRows}
</svg>`;
}

function aiDetectDashboardPage(text, pageCtx) {
  const t = String(text || '').toLowerCase();
  const p = String(pageCtx || '').trim().toLowerCase();
  if (/(resultados|pnl|estado de resultados)/i.test(t)) return 'resultados.html';
  if (/\bcxc\b|cuentas?\s+por\s+cobrar|deudores|vencid/i.test(t)) return 'cxc.html';
  if (/cobrad|cobranza|pagos?\s+recibidos/i.test(t)) return 'cobradas.html';
  if (/margen|rentabilidad/i.test(t)) return 'margen-producto.html';
  if (/inventario|stock|existencia/i.test(t)) return 'inventario.html';
  if (/cliente|riesgo cliente/i.test(t)) return 'clientes.html';
  if (/vendedor/i.test(t)) return 'vendedores.html';
  if (/consumo/i.test(t)) return 'consumos.html';
  if (/director|indice direccion|índice dirección/i.test(t)) return 'director.html';
  if (/ventas?|facturaci[oó]n/i.test(t)) return 'ventas.html';
  if (/\.html$/i.test(p)) return p;
  return 'resultados.html';
}

function aiBuildDashboardUrl(baseUrl, pageFile, aiReq, dbId) {
  const safeBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const u = new URL(`${safeBase}/${pageFile}`);
  const q = (aiReq && aiReq.query) || {};
  if (dbId) u.searchParams.set('db', dbId);
  ['preset', 'anio', 'mes', 'desde', 'hasta', 'vendedor', 'cliente', 'tipo', 'meses'].forEach((k) => {
    const v = q[k];
    if (v != null && String(v).trim() !== '') u.searchParams.set(k, String(v));
  });
  return u.toString();
}

function aiPlaywrightExecutableCandidates() {
  const out = [];
  const push = (p) => {
    const v = String(p || '').trim();
    if (!v) return;
    if (out.includes(v)) return;
    if (fs.existsSync(v)) out.push(v);
  };
  push(process.env.PLAYWRIGHT_EXECUTABLE_PATH);
  push(process.env.CHROME_BIN);
  push(process.env.PUPPETEER_EXECUTABLE_PATH);
  if (process.platform === 'win32') {
    push(path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    push(path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    push(path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    push(path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return out;
}

async function aiCaptureDashboardPngDataUrl(targetUrl) {
  const { chromium } = await import('playwright');
  const launchAttempts = [
    { name: 'bundled', opts: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
    { name: 'channel-chrome', opts: { headless: true, channel: 'chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
    { name: 'channel-msedge', opts: { headless: true, channel: 'msedge', args: ['--no-sandbox', '--disable-dev-shm-usage'] } },
  ];
  aiPlaywrightExecutableCandidates().forEach((exe, i) => {
    launchAttempts.push({
      name: `exe-${i + 1}`,
      opts: { headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    });
  });

  let lastErr = null;
  for (const att of launchAttempts) {
    let browser;
    try {
      browser = await chromium.launch(att.opts);
      const page = await browser.newPage({ viewport: { width: 1600, height: 980 } });
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(2200);
      const buf = await page.screenshot({ type: 'png', fullPage: true });
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (e) {
      lastErr = e;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
  throw lastErr || new Error('No fue posible abrir navegador para screenshot');
}

async function aiRunContextTool(toolId, aiReq, dbOpts, ctx = {}) {
  const qCtx = (aiReq && aiReq.query) || {};
  const cacheKey = JSON.stringify({ toolId, db: dbOpts && dbOpts.database ? dbOpts.database : 'default', qCtx });
  return aiWithCache(cacheKey, 15000, async () => {
    if (toolId === 'cotizaciones') {
      const fCot = buildFiltros(aiReq, 'd');
      const cotiOpts = await cotizacionSqlOpts(dbOpts);
      const cotiSub = cotizacionesSub(getCotizacionesTipo(aiReq), cotiOpts, cotizQueryIsoBounds(aiReq));
      const [resumen] = await query(`
        SELECT
          COUNT(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN 1 END) AS COT_HOY,
          COALESCE(SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN ${sqlCotiImporteExpr('d')} ELSE 0 END), 0) AS IMPORTE_HOY,
          COUNT(*) AS COT_PERIODO,
          COALESCE(SUM(${sqlCotiImporteExpr('d')}), 0) AS IMPORTE_PERIODO
        FROM ${cotiSub} d
        WHERE 1=1 ${fCot.sql}
      `, fCot.params, 12000, dbOpts).catch(() => [{}]);
      const rows = await query(`
        SELECT FIRST 12
          CAST(d.FECHA AS DATE) AS FECHA, d.FOLIO,
          COALESCE(c.NOMBRE, '') AS CLIENTE,
          COALESCE(${sqlCotiImporteExpr('d')}, 0) AS IMPORTE_NETO
        FROM ${cotiSub} d
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID
        WHERE 1=1 ${fCot.sql}
        ORDER BY d.FECHA DESC, d.FOLIO DESC
      `, fCot.params, 12000, dbOpts).catch(() => []);
      const r = resumen || {};
      return {
        toolId,
        block: `\n\n**Cotizaciones (herramienta):**
- Periodo filtrado: ${r.COT_PERIODO || 0} docs, importe ~$${Number(r.IMPORTE_PERIODO || 0).toFixed(2)}.
- Hoy: ${r.COT_HOY || 0} docs, importe ~$${Number(r.IMPORTE_HOY || 0).toFixed(2)}.
- Muestra reciente: ${(rows || []).map(x => `${x.FOLIO} ${String(x.FECHA || '').slice(0, 10)} $${Number(x.IMPORTE_NETO || 0).toFixed(2)}`).join('; ') || 'Sin filas.'}`,
        source: '/api/ventas/cotizaciones',
      };
    }

    if (toolId === 'cxc') {
      const snap = await cxcResumenAgingUnificado({ query: (aiReq && aiReq.query) || {} }, dbOpts).catch(() => ({ resumen: { SALDO_TOTAL: 0 }, aging: {} }));
      let saldoTotal = +(((snap || {}).resumen || {}).SALDO_TOTAL || 0);
      if (saldoTotal <= 0.005) {
        const [sumRow] = await query(`SELECT COALESCE(SUM(cs.SALDO),0) AS TOTAL FROM ${cxcClienteSQL()} cs`, [], 15000, dbOpts).catch(() => [{ TOTAL: 0 }]);
        saldoTotal = +((sumRow && sumRow.TOTAL) || 0);
      }
      const top = await query(`
        SELECT FIRST 8 cs.CLIENTE_ID, COALESCE(cl.NOMBRE, '') AS NOMBRE, cs.SALDO
        FROM ${cxcClienteSQL()} cs
        LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = cs.CLIENTE_ID
        WHERE cs.SALDO > 0.5
        ORDER BY cs.SALDO DESC
      `, [], 12000, dbOpts).catch(() => []);
      let porCond = await query(`
        SELECT FIRST 6
          COALESCE(cp.NOMBRE, 'Sin condición') AS CONDICION,
          COALESCE(SUM(doc.SALDO_NETO), 0) AS SALDO
        FROM (${cxcDocSaldosInnerSQL('')}) doc
        LEFT JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = doc.DOCTO_CC_ID
        LEFT JOIN CLIENTES c ON c.CLIENTE_ID = dc.CLIENTE_ID
        LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = COALESCE(dc.COND_PAGO_ID, c.COND_PAGO_ID)
        WHERE doc.SALDO_NETO > 0.5
          AND (
            cp.COND_PAGO_ID IS NULL OR (
              POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
              AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
              AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
            )
          )
        GROUP BY COALESCE(cp.NOMBRE, 'Sin condición')
        ORDER BY 2 DESC
      `, [], 12000, dbOpts).catch(() => []);
      if (!porCond || !porCond.length) {
        porCond = await query(`
          SELECT FIRST 6
            COALESCE(cp.NOMBRE, 'Sin condición') AS CONDICION,
            COALESCE(SUM(c.SALDO), 0) AS SALDO
          FROM ${cxcClienteSQL()} c
          LEFT JOIN CLIENTES cl ON cl.CLIENTE_ID = c.CLIENTE_ID
          LEFT JOIN CONDICIONES_PAGO cp ON cp.COND_PAGO_ID = cl.COND_PAGO_ID
          WHERE c.SALDO > 0.005
            AND (
              cp.COND_PAGO_ID IS NULL OR (
                POSITION('CONTADO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
                AND POSITION('EFECTIVO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
                AND POSITION('INMEDIATO' IN UPPER(COALESCE(TRIM(cp.NOMBRE), ''))) = 0
              )
            )
          GROUP BY COALESCE(cp.NOMBRE, 'Sin condición')
          ORDER BY 2 DESC
        `, [], 12000, dbOpts).catch(() => []);
      }
      if ((!porCond || !porCond.length) && snap && snap.aging) {
        const ag = snap.aging || {};
        porCond = [
          { CONDICION: 'Corriente', SALDO: +ag.CORRIENTE || 0 },
          { CONDICION: 'Vencido', SALDO: +ag.VENCIDO || 0 },
        ].filter(x => (+x.SALDO || 0) > 0.005);
      }

      return {
        toolId,
        block: `\n\n**CxC (herramienta):**
- Saldo total cartera: $${Number(saldoTotal || 0).toFixed(2)}.
- Top deudores: ${(top || []).map(x => `${x.NOMBRE || x.CLIENTE_ID}: $${Number(x.SALDO || 0).toFixed(2)}`).join('; ') || 'Sin datos.'}
- Por condición: ${(porCond || []).map(x => `${x.CONDICION}: $${Number(x.SALDO || 0).toFixed(2)}`).join('; ') || 'No disponible para esta base.'}`,
        source: '/api/cxc/resumen + /api/cxc/por-condicion',
      };
    }

    if (toolId === 'ventas') {
      const tipo = getTipo(aiReq);
      const fV = buildFiltros(aiReq, 'd');
      const [vr] = await query(`
        SELECT
          SUM(CASE WHEN CAST(d.FECHA AS DATE) = CURRENT_DATE THEN d.IMPORTE_NETO ELSE 0 END) AS HOY,
          COALESCE(SUM(d.IMPORTE_NETO), 0) AS PERIODO
        FROM ${ventasSub(tipo)} d
        WHERE 1=1 ${fV.sql}
      `, fV.params, 12000, dbOpts).catch(() => [{}]);
      return {
        toolId,
        block: `\n\n**Ventas (herramienta):**
- Hoy: $${Number((vr && vr.HOY) || 0).toFixed(2)}.
- Total periodo filtrado: $${Number((vr && vr.PERIODO) || 0).toFixed(2)}.`,
        source: '/api/ventas/resumen',
      };
    }

    if (toolId === 'cobradas') {
      const tipo = getTipo(aiReq);
      const fi = filtrosImporteCobro(aiReq, 'i', { coalesceDcFecha: true });
      const fV = buildFiltros(aiReq, 'd');
      const [cb] = await query(`
        SELECT
          COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO,
          COUNT(*) AS NUM_MOV_COBRO
        FROM IMPORTES_DOCTOS_CC i
        JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
        WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N'
          ${fi.sql}
      `, fi.params, 12000, dbOpts).catch(() => [{}]);
      const [fv] = await query(`
        SELECT COUNT(DISTINCT d.FOLIO) AS N_FACT, COALESCE(SUM(d.IMPORTE_NETO), 0) AS TOTAL_FAC
        FROM ${ventasSub(tipo)} d
        WHERE d.VENDEDOR_ID > 0
          ${fV.sql}
      `, fV.params, 12000, dbOpts).catch(() => [{}]);
      const totC = Number((cb && cb.TOTAL_COBRADO) || 0);
      const nMov = Number((cb && cb.NUM_MOV_COBRO) || 0);
      const nFac = Number((fv && fv.N_FACT) || 0);
      return {
        toolId,
        block: `\n\n**Cobradas (herramienta):**
- Total cobrado: $${totC.toFixed(2)}.
- Movimientos de cobro: ${nMov}.
- Ticket promedio por movimiento: ${nMov > 0 ? '$' + (totC / nMov).toFixed(2) : 'No aplica'}.
- Facturas referencia del periodo: ${nFac}.`,
        source: '/api/ventas/cobradas',
      };
    }

    if (toolId === 'resultados') {
      const pnl = await resultadosPnlCore(aiReq, dbOpts);
      const meses = Array.isArray(pnl && pnl.meses) ? pnl.meses : [];
      const tot = pnl && pnl.totales ? pnl.totales : {};
      const sumGastos = ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6','CO_B1','CO_B2','CO_B3','CO_B4','CO_B5','CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6']
        .reduce((s, k) => s + (+tot[k] || 0), 0);
      const utilOp = (+tot.UTILIDAD_BRUTA || 0) - sumGastos;
      const hasGastosContables = sumGastos > 0.01;
      const ult = meses.slice(-3).map(m =>
        `${m.PERIODO || `${m.ANIO}-${String(m.MES || '').padStart(2, '0')}`}: Vta $${Number(m.VENTAS_NETAS || 0).toFixed(2)}, Costo $${Number(m.COSTO_VENTAS || 0).toFixed(2)}, Margen ${Number(m.MARGEN_BRUTO_PCT || 0).toFixed(2)}%`
      ).join(' | ');

      return {
        toolId,
        block: `\n\n**Resultados / P&L (herramienta):**
- Ventas netas: $${Number(tot.VENTAS_NETAS || 0).toFixed(2)}.
- Costo de ventas: $${Number(tot.COSTO_VENTAS || 0).toFixed(2)}.
- Utilidad bruta: $${Number(tot.UTILIDAD_BRUTA || 0).toFixed(2)} (${Number(tot.MARGEN_BRUTO_PCT || 0).toFixed(2)}%).
- Gastos operativos: $${Number(sumGastos || 0).toFixed(2)}.
- Utilidad operativa: ${hasGastosContables ? ('$' + Number(utilOp || 0).toFixed(2)) : 'No disponible (sin pólizas 52/53/54 en el periodo)'}.
- Últimos meses: ${ult || 'Sin meses para el filtro actual.'}`,
        source: '/api/resultados/pnl',
      };
    }
    if (toolId === 'pronostico_ventas') {
      const q = (aiReq && aiReq.query) || {};
      const tipo = getTipo(aiReq);
      const params = [];
      let extraWhere = '';
      if (q.vendedor != null && String(q.vendedor).trim() !== '') {
        extraWhere += ' AND d.VENDEDOR_ID = ?';
        params.push(Number(q.vendedor));
      }
      if (q.cliente != null && String(q.cliente).trim() !== '') {
        extraWhere += ' AND d.CLIENTE_ID = ?';
        params.push(Number(q.cliente));
      }

      let endDate = new Date();
      if (q.hasta && /^\d{4}-\d{2}-\d{2}$/.test(String(q.hasta))) {
        endDate = new Date(String(q.hasta));
      } else if (q.anio && q.mes) {
        endDate = new Date(Number(q.anio), Number(q.mes), 0);
      } else if (q.anio) {
        endDate = new Date(Number(q.anio), 11, 31);
      }
      const endIso = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
      const rows = await query(`
        SELECT
          EXTRACT(YEAR FROM d.FECHA) AS ANIO,
          EXTRACT(MONTH FROM d.FECHA) AS MES,
          COALESCE(SUM(d.IMPORTE_NETO), 0) AS VENTAS
        FROM ${ventasSub(tipo)} d
        WHERE CAST(d.FECHA AS DATE) <= ?
          AND CAST(d.FECHA AS DATE) >= DATEADD(-36 MONTH TO ?)
          ${extraWhere}
        GROUP BY EXTRACT(YEAR FROM d.FECHA), EXTRACT(MONTH FROM d.FECHA)
        ORDER BY 1,2
      `, [endIso, endIso, ...params], 15000, dbOpts).catch(() => []);

      const map = new Map();
      (rows || []).forEach(r => map.set(aiFmtYm(Number(r.ANIO), Number(r.MES)), Number(r.VENTAS || 0)));
      const start = rows && rows.length
        ? { y: Number(rows[0].ANIO), m: Number(rows[0].MES) }
        : { y: endDate.getFullYear(), m: endDate.getMonth() + 1 };
      const end = { y: endDate.getFullYear(), m: endDate.getMonth() + 1 };
      const labelsHist = [];
      const yHist = [];
      let cursor = { y: start.y, m: start.m };
      while (cursor.y < end.y || (cursor.y === end.y && cursor.m <= end.m)) {
        const k = aiFmtYm(cursor.y, cursor.m);
        labelsHist.push(k);
        yHist.push(Number(map.get(k) || 0));
        cursor = aiAddMonths(cursor.y, cursor.m, 1);
      }

      const hasEnough = yHist.length >= 6;
      const maeLin = hasEnough ? aiModelMae(yHist, aiLinRegPredict) : Number.POSITIVE_INFINITY;
      const maeS12 = yHist.length >= 18 ? aiModelMae(yHist, (s, h) => aiSnaivePredict(s, h, 12)) : Number.POSITIVE_INFINITY;
      const best = maeS12 < maeLin ? 'seasonal_naive_12' : 'linear_regression';
      const pred = best === 'seasonal_naive_12' ? aiSnaivePredict(yHist, 3, 12) : aiLinRegPredict(yHist, 3);
      const baseYm = end;
      const labelsFc = [1, 2, 3].map(i => {
        const d = aiAddMonths(baseYm.y, baseYm.m, i);
        return aiFmtYm(d.y, d.m);
      });
      const total3 = pred.reduce((a, b) => a + Number(b || 0), 0);

      const chartLabels = [...labelsHist, ...labelsFc];
      const dsHist = [...yHist, null, null, null];
      const dsPred = Array(yHist.length).fill(null).concat(pred.map(v => Number(v || 0)));
      const qc = {
        type: 'line',
        data: {
          labels: chartLabels,
          datasets: [
            { label: 'Ventas históricas', data: dsHist, borderColor: '#4DA6FF', backgroundColor: 'rgba(77,166,255,.12)', fill: false, tension: 0.25, pointRadius: 2 },
            { label: 'Pronóstico 3 meses', data: dsPred, borderColor: '#FFB800', backgroundColor: 'rgba(255,184,0,.15)', fill: false, tension: 0.22, borderDash: [6, 4], pointRadius: 3 },
          ],
        },
        options: {
          plugins: { legend: { display: true } },
          scales: { y: { beginAtZero: true } },
        },
      };
      const qcUrl = `https://quickchart.io/chart?width=960&height=420&format=png&c=${encodeURIComponent(JSON.stringify(qc))}`;
      const predRows = labelsFc.map((l, i) => `${l}: $${Number(pred[i] || 0).toFixed(2)}`).join(' | ');
      return {
        toolId,
        block: `\n\n**Pronóstico de ventas (herramienta):**
- Método elegido: ${best === 'seasonal_naive_12' ? 'Seasonal Naive (estacionalidad 12m)' : 'Regresión lineal'}.
- Ventana histórica usada: ${labelsHist.length} meses hasta ${aiFmtYm(end.y, end.m)}.
- Proyección próximos 3 meses: ${predRows}.
- Total estimado 3 meses: $${total3.toFixed(2)}.
- Soporte visual: gráfica de histórico + pronóstico adjunta.`,
        source: '/api/resultados/pnl + series mensuales ventas',
        visuals: [{ type: 'image', title: 'Pronóstico de ventas (3 meses)', url: qcUrl }],
      };
    }
    if (toolId === 'escenario_visual') {
      const pnl = await resultadosPnlCore(aiReq, dbOpts).catch(() => ({ meses: [], totales: {} }));
      const meses = Array.isArray(pnl && pnl.meses) ? pnl.meses : [];
      const tot = (pnl && pnl.totales) || {};
      const hist = meses.slice(-8).map(m => Number(m.VENTAS || 0));
      const histLabels = meses.slice(-8).map(m => String(m.PERIODO || aiFmtYm(Number(m.ANIO || 0), Number(m.MES || 1))));
      const pred = hist.length >= 3 ? aiLinRegPredict(hist, 3) : [0, 0, 0];
      const lastPeriod = meses.length ? meses[meses.length - 1] : {};
      const lastY = Number(lastPeriod.ANIO || new Date().getFullYear());
      const lastM = Number(lastPeriod.MES || (new Date().getMonth() + 1));
      const predLabels = [1, 2, 3].map(i => {
        const d = aiAddMonths(lastY, lastM, i);
        return aiFmtYm(d.y, d.m);
      });

      const [cxcT] = await query(`SELECT COALESCE(SUM(s.SALDO), 0) AS T FROM ${cxcClienteSQL()} s`, [], 12000, dbOpts).catch(() => [{ T: 0 }]);
      const fCobro = filtrosImporteCobro(aiReq, 'i', { coalesceDcFecha: true });
      const [cb] = await query(`
        SELECT COALESCE(SUM(CASE WHEN COALESCE(i.IMPUESTO,0) > 0 THEN i.IMPORTE ELSE i.IMPORTE / 1.16 END), 0) AS TOTAL_COBRADO
        FROM IMPORTES_DOCTOS_CC i
        JOIN DOCTOS_CC dc ON dc.DOCTO_CC_ID = i.DOCTO_CC_ID
        WHERE i.TIPO_IMPTE = 'R' AND COALESCE(i.CANCELADO, 'N') = 'N'
          ${fCobro.sql}
      `, fCobro.params, 12000, dbOpts).catch(() => [{ TOTAL_COBRADO: 0 }]);

      const rows = [
        { name: 'Ventas netas periodo', value: aiFmtMoneyMx(tot.VENTAS_NETAS || 0) },
        { name: 'Costo de ventas', value: aiFmtMoneyMx(tot.COSTO_VENTAS || 0) },
        { name: 'Utilidad operativa', value: aiFmtMoneyMx(tot.UTILIDAD_OPERATIVA || 0) },
        { name: 'Cartera CxC', value: aiFmtMoneyMx((cxcT && cxcT.T) || 0) },
        { name: 'Cobros del periodo', value: aiFmtMoneyMx((cb && cb.TOTAL_COBRADO) || 0) },
        { name: 'Pronóstico 3m', value: aiFmtMoneyMx(pred.reduce((a, b) => a + Number(b || 0), 0)) },
      ];
      const svg = aiBuildScenarioSvg({
        title: 'Escenario AI generado desde tu pregunta',
        subtitle: `Base activa · histórico ${histLabels[0] || '-'} a ${histLabels[histLabels.length - 1] || '-'} · proyección ${predLabels[0]} a ${predLabels[2]}`,
        kpis: [
          { label: 'Ventas netas', value: aiFmtMoneyMx(tot.VENTAS_NETAS || 0) },
          { label: 'Margen bruto %', value: `${Number(tot.MARGEN_BRUTO_PCT || 0).toFixed(1)}%` },
          { label: 'CxC cartera', value: aiFmtMoneyMx((cxcT && cxcT.T) || 0) },
          { label: 'Pronóstico 3m', value: aiFmtMoneyMx(pred.reduce((a, b) => a + Number(b || 0), 0)) },
        ],
        hist: hist,
        pred: pred,
        rows,
      });
      return {
        toolId,
        block: `\n\n**Escenario visual AI (generado desde pregunta):**
- Se construyó un mini-dashboard dinámico (KPIs + tendencia + hallazgos) para este contexto.
- Histórico usado: ${histLabels.length} meses.
- Proyección incluida: ${predLabels.join(', ')}.`,
        source: 'render dinámico AI (SVG)',
        visuals: [{ type: 'image', title: 'Escenario AI generado', url: aiSvgDataUrl(svg) }],
      };
    }
    if (toolId === 'dashboard_screenshot') {
      const pageFile = aiDetectDashboardPage(ctx.text || '', ctx.pageCtx || '');
      const baseUrl = process.env.AI_SCREENSHOT_BASE_URL || `http://127.0.0.1:${PORT}`;
      const targetUrl = aiBuildDashboardUrl(baseUrl, pageFile, aiReq, ctx.dbId || '');
      try {
        const img = await aiCaptureDashboardPngDataUrl(targetUrl);
        return {
          toolId,
          block: `\n\n**Screenshot real de dashboard:**
- Vista capturada: ${pageFile}
- URL renderizada: ${targetUrl}`,
          source: `playwright:${pageFile}`,
          visuals: [{ type: 'image', title: `Screenshot ${pageFile}`, url: img }],
        };
      } catch (e) {
        const errMsg = String((e && e.message) || e || '');

        return {
          toolId,
          block: '',
          source: `playwright-error:${pageFile}`,
          visuals: [],
        };
      }
    }
    return { toolId, block: '', source: '' };
  });
}

get('/api/ai/welcome', async () => ({ message: AI_WELCOME_MICROSIP }));

get('/api/ai/tools/catalog', async () => ({ tools: AI_TOOL_CATALOG }));

app.post('/api/ai/tools/run', async (req, res) => {
  try {
    const body = req.body || {};
    const dbResolved = aiResolveDbOpts(req);
    if (dbResolved.error) return res.status(400).json({ error: dbResolved.error });
    const aiReq = aiReqFromBody(body, req);
    const text = String(body.message || '').trim();
    const lowerPool = text.toLowerCase();
    const pageCtx = body && body.context && body.context.page ? String(body.context.page) : '';
    const requested = Array.isArray(body.tools) ? body.tools : [];
    const selected = aiSelectTools({ text, lowerPool, page: pageCtx, requested });
    const results = [];
    for (const id of selected) {
      const r = await aiRunContextTool(id, aiReq, dbResolved.opts, { dbId: dbResolved.id, text, pageCtx });
      results.push({ toolId: id, source: r.source, block: r.block, visuals: Array.isArray(r.visuals) ? r.visuals : [] });
    }
    res.json({ selected, results });
  } catch (e) {
    console.error('[ERROR] /api/ai/tools/run', e.message);
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/ai/visuals/render', async (req, res) => {
  try {
    const body = req.body || {};
    const dbResolved = aiResolveDbOpts(req);
    if (dbResolved.error) return res.status(400).json({ error: dbResolved.error });
    const aiReq = aiReqFromBody(body, req);
    const r = await aiRunContextTool('escenario_visual', aiReq, dbResolved.opts);
    const first = r && Array.isArray(r.visuals) ? r.visuals[0] : null;
    res.json({
      ok: true,
      title: first ? first.title : 'Escenario AI',
      image: first ? first.url : '',
      note: r && r.block ? r.block : '',
    });
  } catch (e) {
    console.error('[ERROR] /api/ai/visuals/render', e.message);
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/ai/visuals/screenshot', async (req, res) => {
  try {
    const body = req.body || {};
    const dbResolved = aiResolveDbOpts(req);
    if (dbResolved.error) return res.status(400).json({ error: dbResolved.error });
    const aiReq = aiReqFromBody(body, req);
    const text = String(body.message || '').trim();
    const pageCtx = body && body.context && body.context.page ? String(body.context.page) : '';
    const r = await aiRunContextTool('dashboard_screenshot', aiReq, dbResolved.opts, { dbId: dbResolved.id, text, pageCtx });
    const first = r && Array.isArray(r.visuals) ? r.visuals[0] : null;
    res.json({
      ok: true,
      title: first ? first.title : 'Screenshot dashboard',
      image: first ? first.url : '',
      note: r && r.block ? r.block : '',
      source: r && r.source ? r.source : '',
    });
  } catch (e) {
    console.error('[ERROR] /api/ai/visuals/screenshot', e.message);
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  const providerEnv = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const provider = providerEnv || ((anthropicKey && !openaiKey) ? 'anthropic' : 'openai');
  const llmAvailable = provider === 'anthropic'
    ? !!anthropicKey
    : !!openaiKey && !String(openaiKey).startsWith('crsr_');
  const llmUnavailableHint = provider === 'anthropic'
    ? 'Define ANTHROPIC_API_KEY (y opcionalmente ANTHROPIC_API_BASE, ANTHROPIC_MODEL).'
    : 'Define OPENAI_API_KEY (y opcionalmente OPENAI_API_BASE, OPENAI_MODEL).';

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
    const aiReq = aiReqFromBody(body, req);
    const empresaCtx = dbResolved.label
      ? `\n\nEmpresa seleccionada en el panel: **${dbResolved.label}** (id: ${dbResolved.id}).`
      : '\n\nEmpresa: base por defecto del servidor (una sola .fdb o la principal).';

    let systemContent = AI_SYSTEM_BASE_MICROSIP + empresaCtx;
    const pageCtx = body && body.context && body.context.page ? String(body.context.page) : '';
    const q = (aiReq && aiReq.query) || {};
    const filtrosCtx = [
      q.preset ? `preset=${q.preset}` : '',
      q.anio ? `anio=${q.anio}` : '',
      q.mes ? `mes=${q.mes}` : '',
      q.desde ? `desde=${q.desde}` : '',
      q.hasta ? `hasta=${q.hasta}` : '',
      q.vendedor ? `vendedor=${q.vendedor}` : '',
      q.cliente ? `cliente=${q.cliente}` : '',
      q.tipo ? `tipo=${q.tipo}` : '',
    ].filter(Boolean).join(', ');
    if (pageCtx || filtrosCtx) {
      systemContent += `\n\nContexto actual del usuario: ${pageCtx || 'dashboard'}${filtrosCtx ? ` · filtros: ${filtrosCtx}` : ''}.`;
    }

    const historyText = `${text} ${(Array.isArray(body.messages) ? body.messages : []).map(m => (m && m.content) || '').join(' ')}`;
    const lowerPool = (text + ' ' + historyText).toLowerCase();
    const requestedTools = Array.isArray(body.tools) ? body.tools : [];
    const selectedTools = aiSelectTools({ text, lowerPool, page: pageCtx, requested: requestedTools });
    const analyticAsk = /\b(ventas?|vendid[oa]s?|cxc|cobrad|resultado|pnl|margen|utilidad|pron[oó]stico|proyecci[oó]n|inventario|cliente|vendedor)\b/i.test(lowerPool);
    const asksShotInPrompt = /\b(screenshot|captura|pantalla)\b/i.test(lowerPool);
    if (asksShotInPrompt && !selectedTools.includes('dashboard_screenshot')) {
      selectedTools.push('dashboard_screenshot');
    }
    const toolSources = [];
    const toolBlocks = [];
    const visuals = [];
    for (const toolId of selectedTools) {
      try {
        const t = await aiRunContextTool(toolId, aiReq, dbOpts, { dbId: dbResolved.id, text, pageCtx });
        if (t && t.block) systemContent += t.block;
        if (t && t.block) toolBlocks.push(String(t.block));
        if (t && t.source) toolSources.push(`${toolId}: ${t.source}`);
        if (t && Array.isArray(t.visuals) && t.visuals.length) visuals.push(...t.visuals);
      } catch (_) {
        // sigue con el resto de tools
      }
    }
    if (toolSources.length) {
      systemContent += `\n\nTrazabilidad de datos: ${toolSources.join(' | ')}.`;
    }
    if (analyticAsk) {
      systemContent += `\n\nFormato de respuesta obligatorio para esta consulta:
1) Resumen ejecutivo (2-4 bullets con conclusión principal)
2) Tabla de métricas (en markdown con 3-8 filas)
3) Interpretación (causas probables y lectura del riesgo/oportunidad)
4) Acciones recomendadas (3-5 acciones concretas, priorizadas).`;
    }

    if (!llmAvailable) {
      const joined = toolBlocks.join('\n').trim();
      const fallback = joined
        ? `Resumen ejecutivo\n- Respuesta generada en modo local (sin LLM externo).\n- Datos obtenidos de tus endpoints reales y filtros activos.\n\n${joined}\n\nAcción recomendada\n- Para respuestas conversacionales más ricas, configura proveedor IA externo.\n- ${llmUnavailableHint}`
        : `No hay proveedor IA configurado y tampoco hubo datos para esta consulta con los filtros actuales.\n\nConfigura IA externa para respuestas narrativas:\n- ${llmUnavailableHint}`;
      return res.json({ reply: fallback, visuals });
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

    let reply = 'Sin respuesta';
    if (provider === 'anthropic') {
      const apiUrl = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1/messages';
      const models = aiAnthropicModelCandidates();
      const anthMessages = [];
      if (Array.isArray(body.messages) && body.messages.length) {
        body.messages.forEach((m) => {
          if (!m || !m.content) return;
          anthMessages.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: String(m.content).slice(0, 2000),
          });
        });
      }
      if (imageB64 && /^image\/(jpeg|png|gif|webp)$/i.test(imageMime)) {
        anthMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: userText.slice(0, 2000) },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: imageMime,
                data: imageB64,
              },
            },
          ],
        });
      } else {
        anthMessages.push({ role: 'user', content: userText.slice(0, 2000) });
      }
      let data = {};
      let lastReason = '';
      let usedModel = '';
      for (const model of models) {
        usedModel = model;
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            system: systemContent,
            messages: anthMessages,
            max_tokens: 900,
          }),
        });
        data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
          lastReason = (data && data.error && (data.error.message || data.error.type)) || `HTTP ${response.status}`;
          continue;
        }
        break;
      }
      if (!data || data.error || !Array.isArray(data.content)) {
        if (openaiKey && !String(openaiKey).startsWith('crsr_')) {
          try {
            const fallbackApiUrl = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/chat/completions';
            const fallbackModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
            const openaiResp = await fetch(fallbackApiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${openaiKey}`,
              },
              body: JSON.stringify({
                model: fallbackModel,
                messages: apiMessages,
                max_tokens: 600,
              }),
            });
            const openaiData = await openaiResp.json().catch(() => ({}));
            const openaiReply = (openaiData && openaiData.choices && openaiData.choices[0] && openaiData.choices[0].message && openaiData.choices[0].message.content)
              ? String(openaiData.choices[0].message.content).trim()
              : '';
            if (openaiResp.ok && openaiReply) {

              return res.json({ reply: openaiReply, visuals });
            }
          } catch (_) {
            // continúa a fallback local
          }
        }
        const joined = toolBlocks.join('\n').trim();
        const rawReason = lastReason || (data && data.error && (data.error.message || data.error.type)) || 'Error de la API de Claude';
        const reason = String(rawReason || '').trim();

        const fallback = joined
          ? `Resumen ejecutivo\n- Asistente conversacional externo no disponible temporalmente.\n- Se activa respuesta local con datos reales del sistema.\n\n${joined}\n\nAcción recomendada\n- Revisar credenciales/permisos de Claude en el servidor para recuperar respuestas narrativas avanzadas.`
          : `Claude no respondió correctamente (${reason}) y no hubo datos para esta consulta con los filtros actuales.`;
        return res.json({ reply: fallback, visuals });
      }
      reply = Array.isArray(data.content)
        ? data.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('\n').trim()
        : '';
      if (!reply) reply = 'Sin respuesta';
    } else {
      const apiUrl = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/chat/completions';
      let model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      if (imageB64 && !/gpt-4|vision|o1|o3|o4/i.test(model)) {
        model = 'gpt-4o-mini';
      }
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          max_tokens: 600,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (data.error) {
        const joined = toolBlocks.join('\n').trim();
        const reason = data.error.message || 'Error de la API de IA';
        const fallback = joined
          ? `Resumen ejecutivo\n- El proveedor IA devolvió error (${reason}).\n- Se activa respuesta local con datos reales del sistema.\n\n${joined}\n\nAcción recomendada\n- Revisa credenciales/modelo del proveedor.\n- Esta respuesta ya está calculada con tus endpoints reales.`
          : `El proveedor IA devolvió error (${reason}) y no hubo datos para esta consulta con los filtros actuales.`;
        return res.json({ reply: fallback, visuals });
      }
      reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'Sin respuesta';
    }
    res.json({ reply, visuals });
  } catch (e) {
    console.error('[ERROR] /api/ai/chat', e.message);
    res.status(500).json({ error: String(e.message) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTAS Y SCHEDULER — módulos opcionales (se cargan solo si existen)
// ═══════════════════════════════════════════════════════════════════════════════
let _checkKpis, _sendAlert, _runAlertJob, _captureScreenshots, _getNotifierConfig, _verifyChannels;
try {
  _checkKpis        = require('./modules/alerts').checkKpis;
  _sendAlert        = require('./modules/notifier').sendAlert;
  _getNotifierConfig = require('./modules/notifier').getNotifierConfig;
  _verifyChannels   = require('./modules/notifier').verifyChannels;
  const sched       = require('./modules/scheduler');
  _runAlertJob      = sched.runAlertJob;
  _captureScreenshots = sched.captureScreenshots;
  // Iniciar cron de alertas al arrancar el servidor
  sched.startScheduler();
} catch (e) {
  console.warn('[alerts] Módulos de alertas no disponibles:', e.message);
}

// ── GET /api/alerts/check — Verificar KPIs ahora ─────────────────────────────
app.get('/api/alerts/check', async (req, res) => {
  if (!_checkKpis) {
    return res.json({ ok: true, alertas: [], kpis: {}, empresa: process.env.EMPRESA_NOMBRE || 'ERP',
      fecha: new Date().toLocaleDateString('es-MX'), _note: 'Módulo de alertas no instalado' });
  }
  try {
    const db = req.query.db || null;
    const result = await _checkKpis(db);
    res.json(result);
  } catch (e) {
    console.error('[/api/alerts/check]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alerts/send — Enviar alerta manualmente (email + WhatsApp) ──────
app.post('/api/alerts/send', async (req, res) => {
  if (!_checkKpis || !_sendAlert) {
    return res.status(503).json({ error: 'Módulos de alertas/notifier no instalados' });
  }
  try {
    const body       = req.body || {};
    const channels   = Array.isArray(body.channels) ? body.channels : ['email', 'whatsapp'];
    const doScreens  = body.captureScreenshots === true;
    const db         = body.db || null;

    const alertData  = await _checkKpis(db);
    let screenshots  = [];
    if (doScreens && _captureScreenshots) {
      try {
        screenshots = await _captureScreenshots([
          { name: 'ventas',     path: '/ventas.html',     waitFor: null },
          { name: 'cxc',        path: '/cxc.html',        waitFor: null },
          { name: 'resultados', path: '/resultados.html', waitFor: null },
        ]);
      } catch (se) {
        console.warn('[alerts/send] Screenshots fallaron:', se.message);
      }
    }

    const result = await _sendAlert({ alertData, screenshotBuffers: screenshots, channels });
    res.json({ ok: true, alertData: { ...alertData, kpis: undefined }, result });
  } catch (e) {
    console.error('[/api/alerts/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/alerts/config — Diagnóstico de canales y destinatarios ───────────
app.get('/api/alerts/config', async (_req, res) => {
  try {
    if (!_getNotifierConfig) {
      return res.status(503).json({ error: 'Módulo notifier no instalado' });
    }
    const cfg = _getNotifierConfig();
    const out = {
      email: {
        enabled: !!(cfg && cfg.email && cfg.email.enabled),
        host: (cfg && cfg.email && cfg.email.host) || '',
        port: (cfg && cfg.email && cfg.email.port) || 0,
        secure: !!(cfg && cfg.email && cfg.email.secure),
        from: (cfg && cfg.email && cfg.email.from) || '',
        to: (cfg && cfg.email && cfg.email.to) || [],
      },
      whatsapp: {
        enabled: !!(cfg && cfg.whatsapp && cfg.whatsapp.enabled),
        from: (cfg && cfg.whatsapp && cfg.whatsapp.from) || '',
        to: (cfg && cfg.whatsapp && cfg.whatsapp.to) || [],
        accountSidMasked: (cfg && cfg.whatsapp && cfg.whatsapp.accountSid)
          ? String(cfg.whatsapp.accountSid).replace(/^(.{6}).*(.{4})$/, '$1...$2')
          : '',
      },
    };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/alerts/verify — Verificación activa SMTP/Twilio ──────────────────
app.get('/api/alerts/verify', async (_req, res) => {
  try {
    if (!_verifyChannels) {
      return res.status(503).json({ error: 'Módulo notifier no instalado' });
    }
    const out = await _verifyChannels();
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/alerts/test — Envío de prueba (sin capturas) ───────────────────
app.post('/api/alerts/test', async (req, res) => {
  if (!_checkKpis || !_sendAlert) {
    return res.status(503).json({ error: 'Módulos de alertas/notifier no instalados' });
  }
  try {
    const channels = Array.isArray((req.body || {}).channels) ? req.body.channels : ['email', 'whatsapp'];
    const alertData = await _checkKpis(null);
    // En prueba forzamos una alerta ficticia para confirmar el canal
    alertData.alertas = [{ modulo: 'Prueba', descripcion: 'Este es un mensaje de prueba del sistema de alertas', nivel: 'INFO', valor: 'TEST OK' }];
    const result = await _sendAlert({ alertData, screenshotBuffers: [], channels });
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[/api/alerts/test]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNÓSTICO VENTAS: endpoint temporal para comparar métodos de cálculo ────
app.get('/api/diagnostico/ventas', async (req, res) => {
  const dbParam = req.query.db || null;
  const dbOpts  = dbParam ? resolveDb(dbParam) : null;

  // Periodo: mes actual por defecto, o ?desde=&hasta= en query string
  const now   = new Date();
  const y     = now.getFullYear();
  const m     = String(now.getMonth() + 1).padStart(2, '0');
  const lastD = new Date(y, now.getMonth() + 1, 0).getDate();
  const DESDE = req.query.desde || `${y}-${m}-01`;
  const HASTA = req.query.hasta || `${y}-${m}-${String(lastD).padStart(2, '0')}`;

  const DIV = VENTAS_SIN_IVA_DIVISOR; // el divisor configurado en .env

  try {
    // 1. Método actual: IMPORTE_NETO / DIV, APLICADO='S', ESTATUS no C/D/S
    const [r1ve, r1pv] = await Promise.all([
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO / CAST(${DIV} AS DOUBLE PRECISION)),0) AS T FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')='S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO / CAST(${DIV} AS DOUBLE PRECISION)),0) AS T FROM DOCTOS_PV d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')='S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);
    const m1 = (r1ve[0]?.T || 0) + (r1pv[0]?.T || 0);

    // 2. Sin divisor: IMPORTE_NETO tal cual, APLICADO='S'
    const [r2ve, r2pv] = await Promise.all([
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')='S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM DOCTOS_PV d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')='S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);
    const m2 = (r2ve[0]?.T || 0) + (r2pv[0]?.T || 0);

    // 3. Power BI: UNIDADES * PRECIO_UNITARIO desde detalle, sin APLICADO, sin ESTATUS
    const [r3ve, r3pv] = await Promise.all([
      query(`SELECT COALESCE(SUM(dd.UNIDADES * dd.PRECIO_UNITARIO),0) AS T FROM DOCTOS_VE_DET dd JOIN DOCTOS_VE d ON d.DOCTO_VE_ID = dd.DOCTO_VE_ID WHERE d.TIPO_DOCTO IN ('V','F') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COALESCE(SUM(dd.UNIDADES * dd.PRECIO_UNITARIO),0) AS T FROM DOCTOS_PV_DET dd JOIN DOCTOS_PV d ON d.DOCTO_PV_ID = dd.DOCTO_PV_ID WHERE d.TIPO_DOCTO IN ('V','F') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);
    const m3 = (r3ve[0]?.T || 0) + (r3pv[0]?.T || 0);

    // 4. Sin filtro APLICADO: IMPORTE_NETO / DIV, solo ESTATUS
    const [r4ve, r4pv] = await Promise.all([
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO / CAST(${DIV} AS DOUBLE PRECISION)),0) AS T FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO / CAST(${DIV} AS DOUBLE PRECISION)),0) AS T FROM DOCTOS_PV d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);
    const m4 = (r4ve[0]?.T || 0) + (r4pv[0]?.T || 0);

    // 5. Sin divisor Y sin filtro APLICADO
    const [r5ve, r5pv] = await Promise.all([
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COALESCE(SUM(d.IMPORTE_NETO),0) AS T FROM DOCTOS_PV d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);
    const m5 = (r5ve[0]?.T || 0) + (r5pv[0]?.T || 0);

    // 6. Docs excluidos por APLICADO
    const [excVe, excPv] = await Promise.all([
      query(`SELECT COUNT(*) AS CNT, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOT FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')<>'S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
      query(`SELECT COUNT(*) AS CNT, COALESCE(SUM(d.IMPORTE_NETO),0) AS TOT FROM DOCTOS_PV d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.ESTATUS,'N') NOT IN ('C','D','S') AND COALESCE(d.APLICADO,'N')<>'S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 30000, dbOpts),
    ]);

    // 7. Valores distintos de APLICADO
    const aplVe = await query(`SELECT COALESCE(d.APLICADO,'NULL') AS APLY, COUNT(*) AS CNT FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}' GROUP BY 1 ORDER BY 2 DESC`, [], 30000, dbOpts).catch(() => []);

    // 8. Muestra de 3 docs (para ver si IMPORTE_NETO ya viene sin IVA)
    const muestra = await query(`SELECT FIRST 3 d.TIPO_DOCTO, d.IMPORTE_NETO, d.IMPORTE_NETO/1.16 AS NETO_DIV, d.APLICADO, d.ESTATUS FROM DOCTOS_VE d WHERE d.TIPO_DOCTO IN ('V','F') AND COALESCE(d.APLICADO,'N')='S' AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'`, [], 15000, dbOpts).catch(() => []);

    const fmt = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);

    res.json({
      periodo: { desde: DESDE, hasta: HASTA },
      divisor_configurado: DIV,
      metodos: {
        m1_servidor_actual:       { label: `IMPORTE_NETO/${DIV}, APLICADO=S, ESTATUS ok`,      total: m1, formateado: fmt(m1) },
        m2_sin_divisor:           { label: 'IMPORTE_NETO crudo, APLICADO=S, ESTATUS ok',       total: m2, formateado: fmt(m2) },
        m3_power_bi:              { label: 'UNI×PRECIO desde detalle, sin APLICADO ni ESTATUS', total: m3, formateado: fmt(m3) },
        m4_sin_aplicado_con_div:  { label: `IMPORTE_NETO/${DIV}, sin filtro APLICADO`,         total: m4, formateado: fmt(m4) },
        m5_sin_divisor_sin_aplic: { label: 'IMPORTE_NETO crudo, sin filtro APLICADO',          total: m5, formateado: fmt(m5) },
      },
      excluidos_por_aplicado: {
        doctos_ve: { count: excVe[0]?.CNT || 0, importe: excVe[0]?.TOT || 0, formateado: fmt(excVe[0]?.TOT) },
        doctos_pv: { count: excPv[0]?.CNT || 0, importe: excPv[0]?.TOT || 0, formateado: fmt(excPv[0]?.TOT) },
      },
      valores_aplicado_este_mes: aplVe,
      muestra_3_documentos: muestra,
    });
  } catch (e) {
    console.error('[diagnostico/ventas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

get('/api/debug/build-info', async () => {

  return {
    build: BUILD_FINGERPRINT,
    hasFallbackFlags: true,
    expectedFields: ['gastos_estimados', 'gastos_estimados_desde'],
    now: new Date().toISOString(),
  };
});

// Pre-calentar el caché de esquema al iniciar (reduce cold-start en primera petición)
setImmediate(() => {
  resolveConsumosSchema(null).catch(() => {});
});

app.listen(PORT, () => {
  console.log(`Suminregio API escuchando en http://localhost:${PORT} · build=${BUILD_FINGERPRINT}`);
});
