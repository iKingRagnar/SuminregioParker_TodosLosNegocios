'use strict';

/**
 * server_api.js — Suminregio Parker Dashboard v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * Backend slim que CONSUME el API externo https://api.suminregio.com/api/external
 * Reemplaza al monolito server_corregido.js (12k líneas con queries Firebird
 * directas + daily-cache). Toda la lectura de datos pasa por api-client.js y el
 * catálogo oficial de 70 queries.
 *
 * Beneficios:
 *  - Cero conexiones Firebird expuestas en WAN.
 *  - Cache y cuadres ya validados del lado del API (DuckDB refrescado 2 AM MX).
 *  - Consolidado "grupo" sin fan-out manual: ?db=grupo basta.
 *  - Hardening: helmet, rate-limit, basic auth UI, CORS estricto.
 *
 * Ruta mínima viable para el dashboard actual (index / director / cxc / ventas
 * / cobradas / clientes / inventario / cotizaciones / margen / resultados).
 *
 * Envs clave:
 *   SUMINREGIO_API_KEY  (requerida, sk_ext_...)
 *   PORT                (default 7000)
 *   AUTH_USERS          ("user:pass;user2:pass2") — vacío = sin basic auth
 *   CORS_ORIGIN         (default *; en prod pon el dominio real)
 *   RATE_LIMIT_MAX      (default 300 req/min)
 *   DEFAULT_UNIDAD      (default "parker")
 *   NODE_ENV            (production → helmet CSP estricto)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const path = require('path');
const fs = require('fs');

const api = require('./api-client');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 7000;
const DEFAULT_UNIDAD = (process.env.DEFAULT_UNIDAD || 'parker').toLowerCase();
const IS_PROD = process.env.NODE_ENV === 'production';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 300;
const BUILD_FINGERPRINT = (process.env.RENDER_GIT_COMMIT && String(process.env.RENDER_GIT_COMMIT).trim())
  ? `git:${String(process.env.RENDER_GIT_COMMIT).trim().slice(0, 12)}`
  : 'dev-local';

if (!api.hasKey()) {
  console.error('[FATAL] SUMINREGIO_API_KEY no configurada. Define la env var antes de arrancar.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render / proxy

// ── Security middleware ─────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // las HTML actuales usan inline <style> y <script>; se migra aparte
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()),
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));

// Rate limit SOLO en /api/ — las HTML y estáticos no cuentan
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit_excedido', retry_after_s: 60 },
  skip: (req) => req.path === '/api/ping' || req.path === '/api/metrics' || req.path === '/health',
}));

app.use(express.json({ limit: '1mb' }));

// Basic auth OPCIONAL (solo si AUTH_USERS está configurada).
// Formato: "usuario:pass;usuario2:pass2". Se aplica a TODO excepto /health y /api/ping.
if (process.env.AUTH_USERS && process.env.AUTH_USERS.trim()) {
  const users = {};
  for (const pair of process.env.AUTH_USERS.split(';')) {
    const [u, p] = pair.split(':');
    if (u && p) users[u.trim()] = p.trim();
  }
  if (Object.keys(users).length) {
    console.log(`[auth] basic auth ACTIVO para ${Object.keys(users).length} usuario(s)`);
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/api/ping') return next();
      return basicAuth({ users, challenge: true, realm: 'Suminregio' })(req, res, next);
    });
  }
}

// ── Estáticos (misma lógica que server_corregido.js) ────────────────────────
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
    if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
  },
};
app.use(express.static(path.join(__dirname, 'public'), staticOpts));
app.use(express.static(__dirname, staticOpts));

// ── Helpers ─────────────────────────────────────────────────────────────────
function unidadFromReq(req) {
  const raw = String(req.query.db || req.query.unidad || '').trim().toLowerCase();
  if (!raw) return DEFAULT_UNIDAD;
  if (api.UNIDADES_VALIDAS.has(raw)) return raw;
  // Alias legacy: "default" → unidad por defecto
  if (raw === 'default') return DEFAULT_UNIDAD;
  return DEFAULT_UNIDAD;
}

function yearMonthFromReq(req, defAnio, defMes) {
  const now = new Date();
  const anio = Number(req.query.anio || req.query.year || defAnio || now.getFullYear());
  const mes = Number(req.query.mes || req.query.month || defMes || (now.getMonth() + 1));
  return { anio, mes };
}

function wrapError(res, e, ctx = '') {
  const status = e.status || 500;
  const payload = {
    ok: false,
    error: (e && e.message) || 'error',
    context: ctx || undefined,
  };
  if (e.detail && typeof e.detail === 'object' && !e.detail.detail) payload.detail = e.detail.detail || e.detail.error;
  if (!IS_PROD && e.stack) payload.stack = e.stack.split('\n').slice(0, 5);
  return res.status(status).json(payload);
}

function num(x, fb = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fb;
}

// ── Inventario: mapeo upstream-lowercase → frontend-UPPERCASE ────────────────
// Las queries del API externo (inv_top_stock, inv_bajo_minimo, inv_sin_movimiento,
// consumo_semanal, articulos_bajo_minimo, inventario_articulos_detalle) devuelven
// keys lowercase (articulo, stock, valor_inventario...) pero las vistas en
// public/inventario.html, public/director.html y public/consumos.html leen
// UPPERCASE (DESCRIPCION, EXISTENCIA, PRECIO_VENTA, VALOR_TOTAL...).
// Este helper produce un row enriquecido con los campos UPPERCASE manteniendo
// los originales para no romper consumidores que sí leen lowercase.
function mapInvRow(r, opts = {}) {
  if (!r || typeof r !== 'object') return r;
  const get = (...keys) => {
    for (const k of keys) {
      if (r[k] != null && r[k] !== '') return r[k];
    }
    return null;
  };
  const articuloId = get('ARTICULO_ID', 'articulo_id');
  const desc = get('articulo', 'ARTICULO', 'descripcion', 'DESCRIPCION', 'nombre', 'NOMBRE') || '';
  const clave = get('CLAVE_ARTICULO', 'clave_articulo', 'clave', 'CLAVE', 'codigo', 'CODIGO') || '';
  const linea = get('linea', 'LINEA', 'familia', 'FAMILIA') || '';
  // existencia: stock en top_stock; existencia en bajo_minimo; existencia_actual en otros
  const existencia = num(get('EXISTENCIA', 'existencia', 'EXISTENCIA_ACTUAL', 'existencia_actual',
    'stock_actual', 'STOCK_ACTUAL', 'stock', 'STOCK'));
  const minimo = num(get('EXISTENCIA_MINIMA', 'existencia_minima', 'minimo', 'MINIMO',
    'min_actual', 'MIN_ACTUAL'));
  const costoUnit = num(get('costo_unitario', 'COSTO_UNITARIO', 'costo', 'COSTO',
    'costo_promedio', 'COSTO_PROMEDIO'));
  const valorInv = num(get('valor_inventario', 'VALOR_INVENTARIO', 'valor_total',
    'VALOR_TOTAL', 'valor_stock', 'VALOR_STOCK', 'valor', 'VALOR'));
  const unidades = num(get('unidades_total', 'UNIDADES_TOTAL', 'unidades', 'UNIDADES',
    'cantidad', 'CANTIDAD'));
  const ventaTotal = num(get('venta_total', 'VENTA_TOTAL', 'total_venta', 'TOTAL_VENTA'));
  const dias = opts.dias || 13; // ventana default consumo_semanal: 13 semanas
  // Consumo semanal promedio: si trae sem_actual..sem_12 promedia esos campos;
  // si no, intenta consumo_semanal_prom directo; si no, deriva de unidades_total/13.
  let consSem = num(get('consumo_semanal_prom', 'CONSUMO_SEMANAL_PROM'));
  if (!consSem) {
    let semanas = 0, suma = 0;
    for (let i = 1; i <= 12; i++) {
      const k = `sem_${i}`;
      if (r[k] != null) { suma += num(r[k]); semanas++; }
    }
    if (r.sem_actual != null) { suma += num(r.sem_actual); semanas++; }
    consSem = semanas > 0 ? suma / semanas : (unidades / dias);
  }
  const semanasStock = num(get('semanas_stock', 'SEMANAS_STOCK'));
  const salidasAnio = num(get('salidas_anio', 'SALIDAS_ANIO'));
  const mesesSinVenta = num(get('meses_sin_venta', 'MESES_SIN_VENTA'));
  const rotacionLabel = get('rotacion_label', 'ROTACION_LABEL') || '';
  const ultimoMov = get('ultimo_movimiento', 'ULTIMO_MOVIMIENTO',
    'fecha_ultimo_movimiento', 'FECHA_ULTIMO_MOVIMIENTO');
  const diasSinVenta = num(get('dias_sin_venta', 'DIAS_SIN_VENTA'));
  return {
    ...r,
    ARTICULO_ID: articuloId,
    DESCRIPCION: desc,
    NOMBRE: desc,
    ARTICULO: desc,
    CLAVE_ARTICULO: clave,
    CLAVE: clave,
    CODIGO: clave,
    LINEA: linea,
    UNIDAD: get('unidad', 'UNIDAD') || '',
    EXISTENCIA: existencia,
    EXISTENCIA_ACTUAL: existencia,
    STOCK_ACTUAL: existencia,
    EXISTENCIA_MINIMA: minimo,
    MIN_ACTUAL: minimo,
    PRECIO_VENTA: costoUnit,
    COSTO_UNITARIO: costoUnit,
    COSTO_PROMEDIO: costoUnit,
    VALOR_TOTAL: valorInv,
    VALOR_INVENTARIO: valorInv,
    VALOR_STOCK: valorInv,
    UNIDADES_TOTAL: unidades,
    VENTA_TOTAL: ventaTotal,
    CONSUMO_SEMANAL_PROM: Math.round(consSem * 100) / 100,
    SEMANAS_STOCK: semanasStock || (consSem > 0 ? Math.round((existencia / consSem) * 100) / 100 : 0),
    SALIDAS_ANIO: salidasAnio,
    MESES_SIN_VENTA: mesesSinVenta,
    ROTACION_LABEL: rotacionLabel,
    ULTIMO_MOVIMIENTO: ultimoMov,
    DIAS_SIN_VENTA: diasSinVenta,
    FALTANTE: existencia < minimo ? minimo - existencia : 0,
  };
}

// ── CxC: filtro de "ventas a contado" y "ya pagadas" ─────────────────────────
// Regla del cliente (abr 2026): "no tomar en cuenta lo que sea a contado y
// tampoco lo que ya se pago". Aplicado en el cálculo de VENCIDO + listas vencidas.
//
//  · contado:    condicion_pago contiene "CONTADO" / "CASH" / "PAGO INMEDIATO" / "0 DIAS".
//                Ojo: "CONTADO RIESGO" o ventas no-credito tampoco entran.
//  · ya pagada:  saldo_venc <= 0 (residual cobrado por completo). El upstream
//                deja el row con dias_vencido > 0 igual hasta el cierre del CC,
//                por eso filtramos por saldo, no por flag de status.
function isContadoCondicion(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t) return false;
  if (t.includes('CONTADO')) return true;
  if (t.includes('CASH'))    return true;
  if (t.includes('PAGO INMEDIATO')) return true;
  if (/^0\s*D[IÍ]?A?S?$/.test(t)) return true;
  return false;
}
function isCxcRowVencidoReal(r) {
  // Vencido real = saldo positivo (> 1 centavo, ignora residuos float-point) +
  // días vencidos > 0 + condición a crédito.
  return num(r && r.saldo_venc) > 0.01
      && num(r && r.dias_vencido) > 0
      && !isContadoCondicion(r && r.condicion_pago);
}

// BigInt-safe JSON
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (data) {
    try {
      const body = JSON.stringify(data, (_k, v) => {
        if (typeof v !== 'bigint') return v;
        return (v <= Number.MAX_SAFE_INTEGER && v >= -Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(body);
    } catch { return origJson(data); }
  };
  next();
});

// ── Health / Ping ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'suminregio-dashboard', build: BUILD_FINGERPRINT, upstream: api.BASE_URL });
});
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), build: BUILD_FINGERPRINT });
});
app.get('/api/admin/mode', (_req, res) => {
  res.json({ ok: true, mode: 'external_api', upstream: api.BASE_URL, build: BUILD_FINGERPRINT });
});
app.get('/api/admin/sync/status', async (_req, res) => {
  try {
    const h = await api.health();
    res.json({ ok: true, upstream: h, mode: 'external_api' });
  } catch (e) { return wrapError(res, e, 'sync/status'); }
});

// ── Catálogo de unidades / queries ──────────────────────────────────────────
// Etiquetas amigables para los chips de "Unidad de negocio" del frontend.
// Las unidades vienen del API externo (UNIDADES_VALIDAS de api-client.js).
const UNIDAD_LABELS = {
  parker:    'Parker',
  medico:    'M\u00e9dicos',
  maderas:   'Maderas',
  empaque:   'Empaque',
  agua:      'Agua',
  reciclaje: 'Reciclaje',
  grupo:     'Grupo Total',
};
function labelForUnidad(id) {
  if (UNIDAD_LABELS[id]) return UNIDAD_LABELS[id];
  return String(id || '').replace(/^./, c => c.toUpperCase());
}

app.get('/api/universe/databases', async (_req, res) => {
  // Frontend (nav.js, index.html, cxc.html, filters.js) espera un ARRAY plano:
  //   [{ id, label, database, active }]
  // Si el upstream falla, devolvemos las 7 unidades válidas locales para que
  // los chips de negocios sigan apareciendo aunque el API externo esté caído.
  let ids = [];
  try {
    const h = await api.health();
    if (Array.isArray(h && h.unidades_disponibles) && h.unidades_disponibles.length) {
      ids = h.unidades_disponibles.slice();
    }
  } catch (_) { /* fall through to local defaults */ }
  if (!ids.length) ids = Array.from(api.UNIDADES_VALIDAS);
  const dbs = ids.map(id => ({
    id,
    label: labelForUnidad(id),
    database: id,
    active: true,
  }));
  res.json(dbs);
});
app.get('/api/catalog/queries', async (_req, res) => {
  try { res.json({ ok: true, queries: await api.listQueries() }); }
  catch (e) { return wrapError(res, e, 'catalog/queries'); }
});

// ── Config / metas (local, no del API) ──────────────────────────────────────
const METAS_PATH = path.join(__dirname, 'metas.json');
function readMetas() {
  try { return JSON.parse(fs.readFileSync(METAS_PATH, 'utf8')); }
  catch { return { META_MES: 3000000, META_IDEAL: 3300000, META_ANIO: 36000000 }; }
}
app.get('/api/config/metas', (_req, res) => {
  res.json({ ok: true, ...readMetas() });
});

// ─────────────────────────────────────────────────────────────────────────────
// VENTAS
// ─────────────────────────────────────────────────────────────────────────────

// /api/ventas/resumen → { MES_ACTUAL, HOY, ... }
app.get('/api/ventas/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [mesRows, diaRows, comp] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }),
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
    ]);
    const mesRow = mesRows[0] || {};
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hoyRow = (diaRows || []).find(r => String(r.dia).startsWith(hoyStr)) || {};
    const cmpRow = comp[0] || {};
    const totalGeneral = num(mesRow.total_general);
    const totalVe      = num(mesRow.total_ve);
    const totalPv      = num(mesRow.total_pv);
    const numFacturas  = num(mesRow.num_facturas);
    const totalHoy     = num(hoyRow.total_dia);
    const numDocsHoy   = num(hoyRow.num_docs);
    res.json({
      ok: true,
      unidad,
      anio, mes,
      MES_ACTUAL: totalGeneral,
      MES_VE: totalVe,
      MES_PV: totalPv,
      NUM_FACTURAS: numFacturas,
      // Aliases legacy: ventas.html lee FACTURAS_MES; index/director leen NUM_FACTURAS_MES.
      FACTURAS_MES: numFacturas,
      NUM_FACTURAS_MES: numFacturas,
      HOY: totalHoy,
      NUM_DOCS_HOY: numDocsHoy,
      FACTURAS_HOY: numDocsHoy,
      // Compat: el upstream no expone IVA. Devolvemos 0 para que el frontend
      // pueda condicionar el render sin romperse al leer las claves.
      HOY_IVA: 0,
      MES_ACTUAL_IVA: 0,
      // Remisiones: en este modelo de datos NO se separan dentro del API
      // unificado; el frontend tolera 0 y oculta la línea.
      REMISIONES_MES: 0,
      REMISIONES_MES_IVA: 0,
      MES_ANTERIOR: num(cmpRow.total_mes_anterior || cmpRow.mes_anterior),
      ANIO_ANTERIOR: num(cmpRow.total_anterior || cmpRow.total_anio_anterior || cmpRow.anio_anterior),
      // YoY trend reads VENTA_HOY/VENTA_MES/TOTAL_HOY/TOTAL_MES alternativamente.
      VENTA_HOY: totalHoy,
      VENTA_MES: totalGeneral,
      TOTAL_HOY: totalHoy,
      TOTAL_MES: totalGeneral,
      BUILD: BUILD_FINGERPRINT,
    });
  } catch (e) { return wrapError(res, e, 'ventas/resumen'); }
});

// /api/ventas/diarias → [{ DIA, VENTAS, DOCS }]
app.get('/api/ventas/diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    res.json(rows.map(r => ({
      DIA: r.dia, FECHA: r.dia, VENTAS: num(r.total_dia), TOTAL: num(r.total_dia), DOCS: num(r.num_docs),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/diarias'); }
});

// /api/ventas/mensuales → [{ ANIO, MES, TOTAL }]
app.get('/api/ventas/mensuales', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const anio = Number(req.query.anio) || new Date().getFullYear();
    const rows = await api.runQuery(unidad, 'ventas_acumulado_anual', { anio });
    res.json(rows.map(r => ({
      ANIO: num(r.anio || anio),
      MES: num(r.mes),
      TOTAL: num(r.total_ve || r.total),
      VENTAS: num(r.total_ve || r.total),
      VE: num(r.total_ve), PV: num(r.total_pv),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/mensuales'); }
});

// /api/ventas/por-vendedor
// Aliases compatibles con UI legacy: ventas.html lee VENTAS_MES + VENTAS_MES_VE + VENTAS_MES_PV + FACTURAS_MES.
app.get('/api/ventas/por-vendedor', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes });
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const total = num(r.total_ventas != null ? r.total_ventas : r.TOTAL);
      const ve = num(r.total_ve != null ? r.total_ve : r.VE);
      const pv = num(r.total_pv != null ? r.total_pv : r.PV);
      const docs = num(r.num_docs != null ? r.num_docs : r.NUM_DOCS);
      return {
        VENDEDOR_ID: +r.VENDEDOR_ID || +r.vendedor_id || 0,
        VENDEDOR: r.vendedor || r.VENDEDOR,
        NOMBRE: r.vendedor || r.VENDEDOR,
        VENTAS: total,
        TOTAL: total,
        VENTAS_MES: total,
        VENTAS_MES_VE: ve,
        VENTAS_MES_PV: pv,
        NUM_DOCS: docs,
        DOCS: docs,
        FACTURAS_MES: docs,
        NUM_FACTURAS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/por-vendedor'); }
});

// /api/ventas/top-clientes
app.get('/api/ventas/top-clientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 10;
    const rows = await api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite });
    res.json(rows.map(r => {
      const total = num(r.total_ventas);
      const docs  = num(r.num_docs);
      return {
        CLIENTE_ID: r.CLIENTE_ID,
        CLIENTE: r.cliente,
        NOMBRE: r.cliente,
        VENTAS: total,
        TOTAL: total,
        // Aliases: ventas.html lee TOTAL_VENTAS / IMPORTE_NETO indistintamente.
        TOTAL_VENTAS: total,
        IMPORTE_NETO: total,
        NUM_DOCS: docs,
        // Aliases legacy: docs/facturas. ventas.html acepta cualquiera.
        DOCS: docs,
        FACTURAS: docs,
        NUM_FACTURAS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/top-clientes'); }
});

// /api/ventas/recientes
// El upstream centralizado no expone una query de "documentos recientes".
// Adaptamos `ventas_diarias` a filas tipo documento-resumen para que la
// tabla en ventas.html renderice algo útil (un row por día con su total),
// poblando los aliases que el frontend espera (FOLIO/CLIENTE/VENDEDOR/
// TOTAL/IMPORTE_NETO/TIPO_DOCTO/TIPO_SRC/FECHA).
app.get('/api/ventas/recientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 60);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    // Últimos N días con movimiento, más reciente arriba.
    const slice = (Array.isArray(rows) ? rows : [])
      .filter(r => num(r.total_dia) > 0 || num(r.num_docs) > 0)
      .slice(-limit).reverse();
    res.json(slice.map(r => {
      const fecha  = r.dia || r.FECHA || null;
      const total  = num(r.total_dia);
      const docs   = num(r.num_docs);
      const folio  = fecha ? `Día ${String(fecha).slice(0, 10)}` : '—';
      return {
        FOLIO: folio,
        TIPO_DOCTO: 'F',
        TIPO_SRC: 'AGG',
        FECHA: fecha,
        CLIENTE: docs > 0 ? `Resumen del día (${docs} docs)` : 'Resumen del día',
        VENDEDOR: '—',
        TOTAL: total,
        VENTAS: total,
        IMPORTE_NETO: total,
        DOCS: docs,
        NUM_DOCS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/recientes'); }
});

// /api/ventas/cumplimiento
// CONTRATO: array de vendedores (legacy); index.html y vendedores.html esperan filas con
// VENDEDOR_ID, NOMBRE, VENTA_MES, FACTURAS_MES, META_DIA, META_MES, PCT_MES, STATUS_MES.
app.get('/api/ventas/cumplimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [rows, ventasDiarias] = await Promise.all([
      api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes }),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }).catch(() => []),
    ]);
    const metas = readMetas();
    const metaDia   = num(metas.META_DIARIA || metas.META_DIA || 5650);
    const metaIdeal = num(metas.META_IDEAL || 6500);

    // Días transcurridos: mes en curso → fecha de hoy; mes pasado → días totales del mes.
    const today = new Date();
    const isCurrentMonth = (anio === today.getFullYear() && mes === (today.getMonth() + 1));
    const daysInMonth = new Date(anio, mes, 0).getDate();
    const diasTranscurridos = Math.max(1, isCurrentMonth ? today.getDate() : daysInMonth);

    // VENTA_HOY / FACTURAS_HOY no las da ventas_por_vendedor; las derivamos de ventas_diarias
    // del último día disponible (asumimos que ese día son las ventas del día con más fecha).
    const hoyKey = today.toISOString().slice(0, 10);
    const hoyRow = (Array.isArray(ventasDiarias) ? ventasDiarias : []).find(r => String(r.dia || r.DIA || '').slice(0, 10) === hoyKey);
    // Nota: ventas_diarias agrega por día sin desglosar por vendedor, así que VENTA_HOY/FACTURAS_HOY
    // sólo se reportan cuando el dataset upstream lo permita. Quedan en 0 si no se puede derivar.

    const out = (Array.isArray(rows) ? rows : []).map(r => {
      const vid    = +r.VENDEDOR_ID || +r.vendedor_id || 0;
      const nombre = r.vendedor || r.VENDEDOR || r.nombre || ('Vendedor ' + vid);
      const ventaMes    = num(r.total_ventas || r.total || r.TOTAL);
      const facturasMes = num(r.num_docs    || r.num   || r.NUM);
      const sinMeta = vid <= 0;
      const mDia = sinMeta ? 0 : metaDia;
      const mMes = sinMeta ? 0 : metaDia * diasTranscurridos;
      const pctMes = mMes > 0 ? Math.round(ventaMes / mMes * 100) : 0;
      return {
        VENDEDOR_ID: vid,
        NOMBRE: nombre,
        VENDEDOR: nombre,
        VENTA_HOY: 0,
        VENTA_MES: ventaMes,
        VENTA_YTD: ventaMes,
        FACTURAS_HOY: 0,
        FACTURAS_MES: facturasMes,
        META_DIA: mDia,
        META_MES: mMes,
        META_IDEAL: sinMeta ? 0 : metaIdeal,
        PCT_HOY: 0,
        PCT_MES: pctMes,
        DIAS_TRANSCURRIDOS: diasTranscurridos,
        STATUS_HOY: 'SIN_META',
        STATUS_MES: mMes > 0 ? (ventaMes >= mMes ? 'OK' : ventaMes >= mMes * 0.7 ? 'PARCIAL' : 'BAJO') : 'SIN_META',
        SIN_META: sinMeta,
      };
    }).sort((a, b) => b.VENTA_MES - a.VENTA_MES);

    res.json(out);
  } catch (e) { return wrapError(res, e, 'ventas/cumplimiento'); }
});

// /api/ventas/cumplimiento/global → contrato del legacy /api/ventas/cumplimiento (objeto)
// Para consumidores que esperan { MES_ACTUAL, META, PCT } sin desglose por vendedor.
app.get('/api/ventas/cumplimiento/global', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes });
    const metas = readMetas();
    const total = num((rows[0] || {}).total_general);
    const meta = num(metas.META_MES || 0);
    const pct = meta > 0 ? (total / meta) * 100 : 0;
    res.json({
      ok: true,
      MES_ACTUAL: total, META: meta, META_IDEAL: num(metas.META_IDEAL), PCT: pct,
      CUMPLIMIENTO_PCT: pct,
    });
  } catch (e) { return wrapError(res, e, 'ventas/cumplimiento/global'); }
});

// /api/ventas/margen-lineas
// Aunque la ruta dice "lineas", el frontend (margen-producto.html, ventas.html)
// espera filas a nivel ARTÍCULO con DESC_ARTICULO/CLAVE_ARTICULO/CANTIDAD/VENTA/
// COSTO/UTILIDAD/MARGEN_PCT. Antes tirábamos `margen_por_linea` (agregado por línea
// de producto) y los rows quedaban sin DESC_ARTICULO ni CLAVE → la tabla se veía
// vacía aunque sí hubiera datos. Ahora usamos `margen_por_producto` (catálogo verificado:
// articulo, CLAVE_ARTICULO, unidades, total_venta, total_costo, utilidad, margen_pct).
app.get('/api/ventas/margen-lineas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = await api.runQuery(unidad, 'margen_por_producto', { anio, mes, limite }).catch(() => []);
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const desc   = r.articulo || r.ARTICULO || r.descripcion || r.DESCRIPCION || '';
      const clave  = r.CLAVE_ARTICULO || r.clave_articulo || r.clave || r.CLAVE || '';
      const linea  = r.linea || r.LINEA || '';
      const cant   = num(r.unidades != null ? r.unidades : r.UNIDADES);
      const venta  = num(r.total_venta != null ? r.total_venta : (r.VENTA != null ? r.VENTA : r.venta));
      const costo  = num(r.total_costo != null ? r.total_costo : (r.COSTO != null ? r.COSTO : r.costo));
      const util   = num(r.utilidad != null ? r.utilidad : (r.UTILIDAD != null ? r.UTILIDAD : (venta - costo)));
      const pct    = num(r.margen_pct != null ? r.margen_pct : (r.MARGEN_PCT != null ? r.MARGEN_PCT : (venta > 0 ? (util / venta) * 100 : 0)));
      return {
        ARTICULO_ID: r.ARTICULO_ID || r.articulo_id || null,
        DESC_ARTICULO: desc,
        DESCRIPCION: desc,
        ARTICULO: desc,
        NOMBRE: desc,
        CLAVE_ARTICULO: clave,
        CLAVE: clave,
        CODIGO: clave,
        LINEA: linea,
        CANTIDAD: cant,
        UNIDADES: cant,
        VENTA: venta,
        TOTAL_VENTA: venta,
        IMPORTE: venta,
        COSTO: costo,
        TOTAL_COSTO: costo,
        UTILIDAD: util,
        MARGEN: util,
        MARGEN_PCT: Math.round(pct * 100) / 100,
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/margen-lineas'); }
});

// /api/ventas/cobradas
app.get('/api/ventas/cobradas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_por_vendedor', { anio, mes })
      .catch(() => []); // query tiene bug upstream — devolver vacío si falla
    res.json(rows.map(r => ({
      VENDEDOR: r.vendedor || r.VENDEDOR,
      VENDEDOR_ID: r.VENDEDOR_ID,
      COBRADO: num(r.total_cobrado || r.cobrado || r.COBRADO),
      NUM_COBROS: num(r.num_cobros || r.NUM_COBROS),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/cobradas'); }
});

// Normaliza un row de cobros_detalle_mes al contrato legacy (FECHA_COBRO/FOLIO_CC/FOLIO/CLIENTE/MONTO_COBRADO/VENDEDOR)
// que esperan cobradas.html y otros consumers. Cubre múltiples nombres alternativos del upstream.
function normalizeCobroRow(r) {
  if (!r || typeof r !== 'object') return r;
  const fechaCobro = r.FECHA_COBRO || r.fecha_cobro || r.FECHA || r.fecha || r.fecha_factura || r.FECHA_FACTURA || null;
  const folioCc    = r.FOLIO_COBRO || r.folio_cobro || r.FOLIO_CC || r.folio_cc || r.FOLIO_CC_DC || r.folio_dc || null;
  const folioFac   = r.FOLIO_FACTURA || r.folio_factura || r.FOLIO_VE || r.folio_ve || r.FOLIO || r.folio || null;
  const cliente    = r.CLIENTE || r.cliente || r.NOMBRE_CLIENTE || r.nombre_cliente || '';
  const vendedor   = r.VENDEDOR || r.vendedor || r.NOMBRE_VENDEDOR || r.nombre_vendedor || '';
  const monto      = r.MONTO_COBRADO != null ? r.MONTO_COBRADO
                   : r.monto_cobrado != null ? r.monto_cobrado
                   : r.IMPORTE_COBRADO != null ? r.IMPORTE_COBRADO
                   : r.importe_cobrado != null ? r.importe_cobrado
                   : r.COBRADO_PERIODO != null ? r.COBRADO_PERIODO
                   : r.cobrado_periodo != null ? r.cobrado_periodo
                   : r.IMPORTE != null ? r.IMPORTE
                   : r.importe;
  return {
    ...r,
    FECHA_COBRO   : fechaCobro,
    FOLIO_COBRO   : folioCc || folioFac || null,
    FOLIO_CC      : folioCc || folioFac || null,
    FOLIO_FACTURA : folioFac || folioCc || null,
    FOLIO         : folioFac || folioCc || null,
    CLIENTE       : cliente,
    VENDEDOR      : vendedor,
    MONTO_COBRADO : num(monto),
    COBRADO_PERIODO: num(monto),
    ORIGEN        : r.ORIGEN || r.origen || (r.tipo_src ? String(r.tipo_src).toUpperCase() : null),
  };
}

// /api/ventas/cobradas-detalle
app.get('/api/ventas/cobradas-detalle', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
    res.json((Array.isArray(rows) ? rows : []).map(normalizeCobroRow));
  } catch (e) { return wrapError(res, e, 'ventas/cobradas-detalle'); }
});

// /api/ventas/cobradas-por-factura (alias)
app.get('/api/ventas/cobradas-por-factura', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
    res.json((Array.isArray(rows) ? rows : []).map(normalizeCobroRow));
  } catch (e) { return wrapError(res, e, 'ventas/cobradas-por-factura'); }
});

// /api/ventas/cotizaciones/resumen
app.get('/api/ventas/cotizaciones/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cotizaciones_activas', { anio, mes });
    const totalMes = rows.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hoyRows = rows.filter(r => String(r.FECHA).startsWith(hoyStr));
    const totalHoy = hoyRows.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    res.json({
      ok: true,
      COTIZACIONES_MES: rows.length,
      COTIZACIONES_HOY: hoyRows.length,
      MES_ACTUAL: totalMes,
      HOY: totalHoy,
      NUM_COTIZACIONES: rows.length,
    });
  } catch (e) { return wrapError(res, e, 'ventas/cotizaciones/resumen'); }
});

// /api/ventas/cotizaciones/diarias
app.get('/api/ventas/cotizaciones/diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cotizaciones_activas', { anio, mes });
    const byDay = new Map();
    for (const r of rows) {
      const k = String(r.FECHA || '').slice(0, 10);
      if (!k) continue;
      const curr = byDay.get(k) || { DIA: k, TOTAL: 0, DOCS: 0 };
      curr.TOTAL += num(r.importe_sin_iva);
      curr.DOCS += 1;
      byDay.set(k, curr);
    }
    res.json([...byDay.values()].sort((a, b) => a.DIA.localeCompare(b.DIA)));
  } catch (e) { return wrapError(res, e, 'ventas/cotizaciones/diarias'); }
});

// /api/ventas/por-vendedor/cotizaciones
// Devuelve VENDEDOR_ID + nombre + alias COTIZACIONES_MES/NUM_COTI_MES para que
// vendedores.html pueda mergear con ventas_por_vendedor por VENDEDOR_ID
// y caer al nombre cuando el ID no esté en el row de cotizaciones.
app.get('/api/ventas/por-vendedor/cotizaciones', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cotizaciones_activas', { anio, mes });
    const byV = new Map();
    for (const r of rows) {
      const vid    = +r.VENDEDOR_ID || +r.vendedor_id || 0;
      const nombre = r.vendedor || r.VENDEDOR || (vid > 0 ? ('Vendedor ' + vid) : '—');
      const k      = vid > 0 ? ('id:' + vid) : ('n:' + nombre);
      const c = byV.get(k) || {
        VENDEDOR_ID: vid,
        VENDEDOR: nombre,
        NOMBRE: nombre,
        TOTAL: 0,
        NUM: 0,
      };
      c.TOTAL += num(r.importe_sin_iva);
      c.NUM   += 1;
      byV.set(k, c);
    }
    const out = [...byV.values()].map(c => ({
      ...c,
      // Aliases legacy esperados por el frontend (vendedores.html / ventas.html)
      COTIZACIONES_MES: c.TOTAL,
      NUM_COTI_MES: c.NUM,
      IMPORTE_TOTAL: c.TOTAL,
    })).sort((a, b) => b.TOTAL - a.TOTAL);
    res.json(out);
  } catch (e) { return wrapError(res, e, 'ventas/por-vendedor/cotizaciones'); }
});

// /api/ventas/vs-cotizaciones
app.get('/api/ventas/vs-cotizaciones', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [ventas, cotis] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
      api.runQuery(unidad, 'cotizaciones_activas', { anio, mes }),
    ]);
    const totalV = num((ventas[0] || {}).total_general);
    const totalC = cotis.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    res.json({
      ok: true,
      VENTAS: totalV, COTIZACIONES: totalC,
      RATIO: totalC > 0 ? totalV / totalC : 0,
      NUM_VENTAS: num((ventas[0] || {}).num_facturas),
      NUM_COTIZACIONES: cotis.length,
    });
  } catch (e) { return wrapError(res, e, 'ventas/vs-cotizaciones'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CxC
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/cxc/top-deudores', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 20;
    const [top, vencida] = await Promise.all([
      api.runQuery(unidad, 'cxc_top_deudores', { limite }),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 }).catch(() => []),
    ]);
    // cxc_vencida_detalle trae "cliente" (nombre) sin CLIENTE_ID → agregamos por
    // nombre normalizado para cruzar contra top_deudores.
    // VENCIDO real excluye contado y ya-pagadas (regla negocio cliente, abril 2026).
    const normKey = (s) => String(s || '').trim().toUpperCase();
    const aggByCli = new Map();
    for (const v of vencida) {
      const k = normKey(v.cliente);
      if (!k) continue;
      const curr = aggByCli.get(k) || { VENCIDO: 0, MAX_DIAS: 0, NUM_DOCS: 0, COND: '' };
      if (isCxcRowVencidoReal(v)) {
        curr.VENCIDO += num(v.saldo_venc);
        const dias = num(v.dias_vencido);
        if (dias > curr.MAX_DIAS) curr.MAX_DIAS = dias;
      }
      curr.NUM_DOCS += 1;
      if (v.condicion_pago && !curr.COND) curr.COND = v.condicion_pago;
      aggByCli.set(k, curr);
    }
    res.json(top.map(r => {
      const agg = aggByCli.get(normKey(r.cliente)) || { VENCIDO: 0, MAX_DIAS: 0, NUM_DOCS: 0, COND: '' };
      return {
        CLIENTE_ID: r.CLIENTE_ID,
        CLIENTE: r.cliente,
        NOMBRE: r.cliente,
        SALDO_TOTAL: num(r.saldo),
        VENCIDO: agg.VENCIDO,
        MAX_DIAS_ATRASO: agg.MAX_DIAS,
        NUM_DOCUMENTOS: agg.NUM_DOCS,
        CONDICION_PAGO: agg.COND,
      };
    }));
  } catch (e) { return wrapError(res, e, 'cxc/top-deudores'); }
});

app.get('/api/cxc/resumen-aging', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const [aging, saldo, vencida] = await Promise.all([
      api.runQuery(unidad, 'cxc_aging', {}),
      api.runQuery(unidad, 'cxc_saldo_total', {}),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
    ]);
    // Aging buckets de VENCIDO real: SIEMPRE recalculados desde `cxc_vencida_detalle`
    // (contado fuera, saldo<=0 fuera). El upstream `cxc_aging` devuelve la cartera
    // total bucketed por edad-de-emisión (suma = saldo_total), no por días-de-atraso,
    // así que NO sirve para los buckets que lee el frontend (DIAS_1_30 = vencido 1-30 días).
    // Regression Apr 2026: antes confiábamos en upstream cuando su suma > 0 (= siempre),
    // resultando en TODO mostrado como vencido en el dashboard.
    const bucketMap = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const v of vencida) {
      if (!isCxcRowVencidoReal(v)) continue;
      const d = num(v.dias_vencido);
      const k = d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
      bucketMap[k] += num(v.saldo_venc);
    }
    const totalSaldo = num((saldo[0] || {}).saldo);
    // VENCIDO real: saldo > 0 + días > 0 + no contado (regla negocio).
    const vencidasReales = vencida.filter(isCxcRowVencidoReal);
    const totalVencido = vencidasReales.reduce((s, r) => s + num(r.saldo_venc), 0);
    const maxDias = vencidasReales.reduce((m, r) => Math.max(m, num(r.dias_vencido)), 0);

    // CONTADO: el upstream `cxc_vencida_detalle` mete documentos a contado en el
    // listado aunque NO sean cartera real (regla del cliente: "no me interesa lo
    // que es a contado"). Sumamos para poder restarlos del SALDO_TOTAL al calcular
    // CORRIENTE/VIGENTE — sin esto la UI pinta esos $ ~$100k como "vigente" o
    // peor, los confunde con vencidos.
    const totalContado = vencida
      .filter(r => isContadoCondicion(r.condicion_pago) && num(r.saldo_venc) > 0.01)
      .reduce((s, r) => s + num(r.saldo_venc), 0);

    // CORRIENTE / VIGENTE / POR_VENCER: cartera a crédito que NO está vencida.
    // El upstream `cxc_vencida_detalle` solo devuelve documentos vencidos
    // (dias_vencido > 0) — nunca rows con dias<=0. Por eso si filtramos sobre
    // `vencida` por dias<=0 obtenemos 0 y la UI pintaba TODO como vencido.
    // Cálculo correcto: VIGENTE = SALDO − VENCIDO_REAL − CONTADO. (todo dato
    // upstream cuadra al centavo: $2,035,553 = $705,893 + $102,286 + $1,227,374.)
    const porVencerLineas = vencida
      .filter(r =>
        num(r.dias_vencido) <= 0 &&
        num(r.saldo_venc) > 0.01 &&
        !isContadoCondicion(r.condicion_pago)
      )
      .reduce((s, r) => s + num(r.saldo_venc), 0);
    const vigenteCalc = Math.max(0, totalSaldo - totalVencido - totalContado);
    const porVencer = porVencerLineas > 0.01 ? porVencerLineas : vigenteCalc;

    // Conteo de clientes únicos con vencido / con cartera (todo a crédito).
    const norm = (s) => String(s || '').trim().toUpperCase();
    const cliVencidos = new Set();
    const cliCartera  = new Set();
    let numDocs = 0;
    for (const v of vencida) {
      if (isContadoCondicion(v.condicion_pago)) continue;
      if (num(v.saldo_venc) <= 0) continue;
      const k = norm(v.cliente);
      if (!k) continue;
      cliCartera.add(k);
      if (num(v.dias_vencido) > 0) cliVencidos.add(k);
      numDocs += 1;
    }

    // Canonical aging shape esperado por public/filters.js → normalizeCxcAging():
    // CORRIENTE / DIAS_1_30 / DIAS_31_60 / DIAS_61_90 / DIAS_MAS_90.
    // CORRIENTE = vigente real (saldo a crédito no vencido). Antes lo dejábamos
    // en 0 cuando upstream no traía rows con dias<=0 — eso pintaba el doughnut
    // "todo rojo / vencido". Ahora va con el vigente calculado por diferencia.
    const agingCanonico = {
      CORRIENTE: porVencer,
      DIAS_1_30: bucketMap['0-30'],
      DIAS_31_60: bucketMap['31-60'],
      DIAS_61_90: bucketMap['61-90'],
      DIAS_MAS_90: bucketMap['90+'],
    };

    res.json({
      ok: true,
      resumen: {
        SALDO_TOTAL: totalSaldo,
        VENCIDO: totalVencido,
        VIGENTE: Math.max(0, totalSaldo - totalVencido - totalContado),
        CONTADO: totalContado,
        POR_VENCER: porVencer,
        MAX_DIAS: maxDias,
        NUM_CLIENTES: cliCartera.size,
        NUM_CLIENTES_VENCIDOS: cliVencidos.size,
        NUM_DOCUMENTOS: numDocs,
        BUCKET_0_30: bucketMap['0-30'],
        BUCKET_31_60: bucketMap['31-60'],
        BUCKET_61_90: bucketMap['61-90'],
        BUCKET_90_PLUS: bucketMap['90+'],
        // Dup canonical en resumen para los lectores antiguos que los buscaban ahí.
        ...agingCanonico,
      },
      aging: agingCanonico,
      aging_raw: aging,
    });
  } catch (e) { return wrapError(res, e, 'cxc/resumen-aging'); }
});

// Mapper compartido: cxc_vencida_detalle del API externo → forma legada que
// cxc.html consume (tablas Vencidas / Vigentes / Totales). Antes devolvíamos
// FECHA, DIAS_VENCIDO y omitíamos FOLIO; el front lo leía como FECHA_VENTA y
// DIAS_ATRASO, así que las tablas salían en blanco aunque hubiera cartera.
function mapCxcDocumentRow(r) {
  const dias = num(r.dias_vencido);
  const saldo = num(r.saldo_venc);
  const fechaDoc = r.fecha_doc || r.FECHA || null;
  const fechaVenc = r.fecha_venc || r.FECHA_VENCIMIENTO || null;
  // Folio real: el upstream actual no expone DOCTOS_CC.FOLIO, así que
  // caemos a doc_id como identificador legible (mejor que '—').
  const folio = r.folio != null ? r.folio
              : (r.FOLIO != null ? r.FOLIO
              : (r.doc_id != null ? r.doc_id : ''));
  return {
    FOLIO: String(folio || ''),
    CLIENTE: r.cliente || r.CLIENTE || '',
    CONDICION_PAGO: r.condicion_pago || r.CONDICION_PAGO || 'S/D',
    SALDO: saldo,
    SALDO_NETO: saldo,
    ATRASO: dias,
    DIAS_ATRASO: dias,
    DIAS_VENCIDO: dias,
    FECHA: fechaDoc,
    FECHA_VENTA: fechaDoc,
    FECHA_VENC_PLAZO: fechaVenc,
    FECHA_VENCIMIENTO: fechaVenc,
    TIEMPO_SIN_PAGAR_DIAS: dias > 0 ? dias : 0,
    IMPORTE: num(r.importe_cargo),
    DOCTO_CC_ID: r.doc_id != null ? r.doc_id : null,
  };
}

app.get('/api/cxc/vencidas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 100;
    // Filtramos contado + ya pagadas (saldo <= 0). Regla de negocio para "vencido real".
    const rows = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite: Math.max(limite, 2000) });
    const out = (rows || [])
      .filter(isCxcRowVencidoReal)
      .map(mapCxcDocumentRow)
      .sort((a, b) => (b.DIAS_ATRASO - a.DIAS_ATRASO) || (b.SALDO - a.SALDO))
      .slice(0, limite);
    res.json(out);
  } catch (e) { return wrapError(res, e, 'cxc/vencidas'); }
});

app.get('/api/cxc/vigentes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 200;
    const [rows, credito, top] = await Promise.all([
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }),
      api.runQuery(unidad, 'credito_por_cliente', { limite: 5000 }).catch(() => []),
      api.runQuery(unidad, 'cxc_top_deudores', { limite: 5000 }).catch(() => []),
    ]);
    // Path A: si el upstream devolviera documentos con dias<=0 (caso ideal),
    // los pintamos a nivel línea. Esto era todo lo que hacíamos antes.
    const linea = (rows || [])
      .filter(r =>
        num(r.dias_vencido) <= 0 &&
        num(r.saldo_venc) > 0.01 &&
        !isContadoCondicion(r.condicion_pago)
      )
      .map(mapCxcDocumentRow)
      .sort((a, b) => b.SALDO - a.SALDO);
    if (linea.length) {
      return res.json(linea.slice(0, limite));
    }
    // Path B (caso real con `cxc_vencida_detalle` upstream actual): el detalle
    // solo regresa vencidas. Reconstruimos la cartera VIGENTE por cliente
    // cruzando 3 fuentes:
    //   - cxc_top_deudores       → saldo total por cliente (es el listado COMPLETO,
    //                              suma exactamente al saldo total CxC)
    //   - cxc_vencida_detalle    → vencidas (solo crédito + saldo>0.01) por cliente
    //   - credito_por_cliente    → condicion_pago + facturas_pendientes (subset
    //                              de los top deudores con detalle de crédito)
    // vigente_cliente = saldo_total − Σvencidas. Si > 0 y no es 100% contado,
    // emitimos una row sintética por cliente con DIAS_ATRASO=-1.
    const norm = (s) => String(s || '').trim().toUpperCase();
    const vencPorCliente = new Map();
    const condPorCliente = new Map();
    const idPorCliente = new Map();
    for (const r of (rows || [])) {
      const k = norm(r.cliente);
      if (!k) continue;
      // Captura condicion_pago vista en algún docto del cliente (preferimos crédito).
      const cond = String(r.condicion_pago || '').trim();
      if (cond) {
        const prev = condPorCliente.get(k);
        if (!prev || isContadoCondicion(prev)) condPorCliente.set(k, cond);
      }
      if (isContadoCondicion(r.condicion_pago)) continue;
      if (num(r.saldo_venc) <= 0.01) continue;
      vencPorCliente.set(k, (vencPorCliente.get(k) || 0) + num(r.saldo_venc));
    }
    for (const c of (credito || [])) {
      const k = norm(c.cliente || c.CLIENTE);
      if (!k) continue;
      const cond = String(c.condicion_pago || c.CONDICION_PAGO || '').trim();
      if (cond) {
        const prev = condPorCliente.get(k);
        if (!prev || isContadoCondicion(prev)) condPorCliente.set(k, cond);
      }
      const id = c.CLIENTE_ID ?? c.cliente_id;
      if (id != null) idPorCliente.set(k, id);
    }
    const facPorCliente = new Map();
    for (const c of (credito || [])) {
      const k = norm(c.cliente || c.CLIENTE);
      if (!k) continue;
      const f = num(c.facturas_pendientes ?? c.FACTURAS_PENDIENTES);
      if (f > 0) facPorCliente.set(k, f);
    }
    const out = [];
    for (const t of (top || [])) {
      const cli = norm(t.cliente || t.CLIENTE);
      if (!cli) continue;
      const saldoCli = num(t.saldo_cxc ?? t.saldo ?? t.SALDO);
      if (saldoCli <= 0.01) continue;
      const condicion = condPorCliente.get(cli) || '';
      // Si la condición observada es 100% contado, tratamos el cliente como contado
      // y no lo incluimos como cartera (regla de negocio: contado fuera).
      if (condicion && isContadoCondicion(condicion)) continue;
      const venc = vencPorCliente.get(cli) || 0;
      const vigente = saldoCli - venc;
      if (vigente <= 0.01) continue;
      out.push({
        FOLIO: '—',
        CLIENTE: t.cliente || t.CLIENTE || '',
        CONDICION_PAGO: condicion || 'S/D',
        SALDO: vigente,
        SALDO_NETO: vigente,
        ATRASO: -1,
        DIAS_ATRASO: -1,
        DIAS_VENCIDO: -1,
        FECHA: null,
        FECHA_VENTA: null,
        FECHA_VENC_PLAZO: null,
        FECHA_VENCIMIENTO: null,
        TIEMPO_SIN_PAGAR_DIAS: 0,
        IMPORTE: vigente,
        DOCTO_CC_ID: null,
        FACTURAS_PENDIENTES: facPorCliente.get(cli) || 0,
        CLIENTE_ID: idPorCliente.get(cli) || (t.CLIENTE_ID ?? t.cliente_id ?? null),
        SINTETICO: true,
      });
    }
    out.sort((a, b) => b.SALDO - a.SALDO);
    res.json(out.slice(0, limite));
  } catch (e) { return wrapError(res, e, 'cxc/vigentes'); }
});

// /api/cxc/por-condicion: cxc.html lee SALDO_TOTAL/CORRIENTE/VENCIDO/NUM_DOCUMENTOS/DIAS_CREDITO.
// El upstream `cxc_por_condicion` solo trae el agregado plano por condición; para que el
// front pueda graficar barras corriente vs vencido, reconstruimos desde `cxc_vencida_detalle`
// igual que hacía el server legacy. Filtra contado fuera (no es cartera).
app.get('/api/cxc/por-condicion', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const [base, detalle] = await Promise.all([
      api.runQuery(unidad, 'cxc_por_condicion', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
    ]);

    // Regex para extraer "30 dias" de la etiqueta cuando upstream no expone DIAS_CREDITO.
    function diasFromLabel(s) {
      const m = String(s || '').match(/(\d{1,3})\s*D[IÍ]AS?/i);
      return m ? +m[1] : 0;
    }

    // Index por condicion → DIAS_CREDITO (upstream agregado puede traerlo).
    const diasByCond = new Map();
    const numClientesByCond = new Map();
    for (const r of (base || [])) {
      const cond = r.condicion_pago || r.CONDICION || r.CONDICION_PAGO;
      if (!cond) continue;
      const k = String(cond).trim();
      const d = num(r.dias_credito || r.DIAS_CREDITO || r.dias_ppag || r.DIAS_PPAG);
      if (d > 0 && !diasByCond.has(k)) diasByCond.set(k, d);
      const nc = num(r.num_clientes || r.NUM_CLIENTES);
      if (nc > 0 && !numClientesByCond.has(k)) numClientesByCond.set(k, nc);
    }

    // Estrategia: el SALDO_TOTAL por condición lo toma de `cxc_por_condicion`
    // (upstream, agregado plano que incluye TODA la cartera viva). El VENCIDO
    // por condición se reagrega desde `cxc_vencida_detalle` (solo dias>0 +
    // crédito + saldo>0). CORRIENTE se deriva por diferencia. Antes solo
    // reagregábamos desde el detalle vencido y CORRIENTE quedaba en 0 → la UI
    // pintaba todas las barras en rojo aunque hubiera saldo vigente importante.
    const agg = new Map();
    for (const r of (base || [])) {
      const cond = String(r.condicion_pago || r.CONDICION || r.CONDICION_PAGO || '').trim();
      if (!cond) continue;
      if (isContadoCondicion(cond)) continue;
      const saldo = num(r.saldo || r.SALDO || r.saldo_total || r.SALDO_TOTAL);
      if (saldo <= 0) continue;
      agg.set(cond, {
        CONDICION_PAGO: cond,
        SALDO_TOTAL: saldo,
        VENCIDO: 0,
        CORRIENTE: 0,
        NUM_DOCUMENTOS: num(r.num_docs || r.NUM_DOCS || r.NUM_DOCUMENTOS),
        _clientes: new Set(),
      });
    }

    // Acumular VENCIDO real desde el detalle (filtrado contado fuera + dias>0 + saldo>0).
    for (const v of (detalle || [])) {
      if (isContadoCondicion(v.condicion_pago)) continue;
      const saldo = num(v.saldo_venc);
      if (saldo <= 0.01) continue;
      const dias = num(v.dias_vencido);
      if (dias <= 0) continue;
      const cond = String(v.condicion_pago || '').trim();
      if (!cond) continue;
      let cur = agg.get(cond);
      if (!cur) {
        cur = {
          CONDICION_PAGO: cond,
          SALDO_TOTAL: 0,
          VENCIDO: 0,
          CORRIENTE: 0,
          NUM_DOCUMENTOS: 0,
          _clientes: new Set(),
        };
        agg.set(cond, cur);
      }
      cur.VENCIDO += saldo;
      cur.NUM_DOCUMENTOS += 1;
      const cli = String(v.cliente || '').trim().toUpperCase();
      if (cli) cur._clientes.add(cli);
    }

    // CORRIENTE = SALDO_TOTAL − VENCIDO por condición (clamp >=0).
    for (const cur of agg.values()) {
      if (cur.SALDO_TOTAL <= 0) {
        // Caso edge: condicion solo aparece en detalle (vencidas pero no en el agregado).
        // Tomamos el saldo total = vencido (no hay corriente conocido).
        cur.SALDO_TOTAL = cur.VENCIDO;
      }
      cur.CORRIENTE = Math.max(0, cur.SALDO_TOTAL - cur.VENCIDO);
    }

    const grupos = [...agg.values()]
      .map(g => {
        const dias = diasByCond.get(g.CONDICION_PAGO) || diasFromLabel(g.CONDICION_PAGO);
        return {
          CONDICION_PAGO: g.CONDICION_PAGO,
          DIAS_CREDITO: dias,
          NUM_CLIENTES: numClientesByCond.get(g.CONDICION_PAGO) || g._clientes.size,
          NUM_DOCUMENTOS: g.NUM_DOCUMENTOS,
          NUM_DOCS: g.NUM_DOCUMENTOS, // alias para compat
          SALDO_TOTAL: Math.round(g.SALDO_TOTAL * 100) / 100,
          SALDO: Math.round(g.SALDO_TOTAL * 100) / 100, // alias para compat
          VENCIDO: Math.round(g.VENCIDO * 100) / 100,
          CORRIENTE: Math.round(g.CORRIENTE * 100) / 100,
          ES_CONTADO: false,
        };
      })
      .sort((a, b) => b.SALDO_TOTAL - a.SALDO_TOTAL);

    res.json({ grupos, pendiente_contado: null });
  } catch (e) { return wrapError(res, e, 'cxc/por-condicion'); }
});

// Burós de pago (cxc.html → loadBuro): usa una ventana de N meses y muestra
// status por mes de emisión (OK/Late/Bad/Pending) por documento.
// Espera filas con CLIENTE_ID, CLIENTE, ANIO, MES_EMISION, CARGO_ORIGINAL,
// TOTAL_COBRADO, SALDO_RESTANTE, FECHA_VENCIMIENTO, FECHA_ULTIMO_PAGO.
// Modo legacy (per-mes): cobros_detalle_mes solo. Modo nuevo (?meses=12 con
// ?saldos_actuales=1): se reconstruye desde cxc_vencida_detalle (docs vivos)
// + cobros_detalle_mes de los meses pedidos para inferir TOTAL_COBRADO y
// FECHA_ULTIMO_PAGO. Sin CLIENTE_ID upstream → usamos el nombre como key.
app.get('/api/cxc/historial-pagos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const meses = Math.min(Math.max(parseInt(req.query.meses, 10) || 0, 0), 24);
    const saldosActuales = String(req.query.saldos_actuales || '') === '1';
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    // Modo legacy: el cliente solo pidió un mes (sin meses + sin saldos_actuales).
    if (!meses && !saldosActuales) {
      const { anio, mes } = yearMonthFromReq(req);
      const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
      return res.json((Array.isArray(rows) ? rows : []).map(normalizeCobroRow));
    }

    // Modo nuevo: ventana de meses + saldos actuales.
    const now = new Date();
    const win = [];
    const M = meses || 12;
    for (let i = M - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      win.push({ anio: d.getFullYear(), mes: d.getMonth() + 1 });
    }

    // 1) Documentos vivos (cartera con saldo > 0).
    const detalle = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite: limit * 4 })
      .catch(() => []);

    // 2) Cobros de la ventana, en lotes de 3 para no martillar al upstream.
    const cobrosPorMes = [];
    const concurrency = 3;
    for (let i = 0; i < win.length; i += concurrency) {
      const slice = win.slice(i, i + concurrency);
      const got = await Promise.all(slice.map(({ anio, mes }) =>
        api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes }).catch(() => [])
      ));
      cobrosPorMes.push(...got);
    }
    const cobrosFlat = cobrosPorMes.flat().map(normalizeCobroRow);

    // Index cobros por nombre cliente (ID rara vez está). Suma MONTO_COBRADO,
    // toma fecha más reciente como FECHA_ULTIMO_PAGO.
    const norm = (s) => String(s || '').trim().toUpperCase();
    const cobrosByCli = new Map();
    for (const c of cobrosFlat) {
      const k = norm(c.CLIENTE);
      if (!k) continue;
      const cur = cobrosByCli.get(k) || { total: 0, ultima: null };
      cur.total += num(c.MONTO_COBRADO);
      const f = c.FECHA_COBRO || c.FECHA;
      if (f) {
        const d = new Date(f);
        if (!isNaN(d.getTime()) && (!cur.ultima || d > cur.ultima)) cur.ultima = d;
      }
      cobrosByCli.set(k, cur);
    }

    // 3) Filas estilo legacy a partir de la cartera viva.
    const rows = [];
    const saldosPorCliente = {};
    let pseudoId = 1;
    const idByCli = new Map();
    for (const v of (detalle || [])) {
      const cliente = v.cliente || '';
      const k = norm(cliente);
      if (!k) continue;
      // Sintetizamos un CLIENTE_ID estable (incremental por nombre) para que
      // el front pueda agrupar — el upstream actual no lo expone.
      let cid = idByCli.get(k);
      if (cid == null) { cid = pseudoId++; idByCli.set(k, cid); }

      const fechaDoc = v.fecha_doc ? new Date(v.fecha_doc) : null;
      const anio = fechaDoc && !isNaN(fechaDoc.getTime()) ? fechaDoc.getFullYear() : null;
      const mesE = fechaDoc && !isNaN(fechaDoc.getTime()) ? fechaDoc.getMonth() + 1 : null;
      const cargo = num(v.importe_cargo);
      const saldoRest = num(v.saldo_venc);
      const totalCobrado = Math.max(0, cargo - saldoRest);
      const cobInfo = cobrosByCli.get(k) || null;
      rows.push({
        DOCTO_CC_ID: v.doc_id != null ? v.doc_id : null,
        FOLIO: String(v.doc_id != null ? v.doc_id : ''),
        CLIENTE_ID: cid,
        CLIENTE: cliente,
        CONDICION_PAGO: v.condicion_pago || 'S/D',
        FECHA_EMISION: v.fecha_doc || null,
        FECHA_VENCIMIENTO: v.fecha_venc || null,
        ANIO: anio,
        MES_EMISION: mesE,
        CARGO_ORIGINAL: cargo,
        TOTAL_COBRADO: totalCobrado,
        SALDO_RESTANTE: saldoRest,
        FECHA_ULTIMO_PAGO: cobInfo && cobInfo.ultima ? cobInfo.ultima.toISOString().slice(0, 10) : null,
      });
      // Saldo actual por cliente: suma de saldo_venc.
      saldosPorCliente[cid] = (saldosPorCliente[cid] || 0) + saldoRest;
    }

    rows.sort((a, b) => {
      const fa = a.FECHA_EMISION ? +new Date(a.FECHA_EMISION) : 0;
      const fb = b.FECHA_EMISION ? +new Date(b.FECHA_EMISION) : 0;
      return fb - fa;
    });

    if (saldosActuales) return res.json({ rows: rows.slice(0, limit), saldosPorCliente });
    res.json(rows.slice(0, limit));
  } catch (e) { return wrapError(res, e, 'cxc/historial-pagos'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTOR — Composite endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/director/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const omitCxc = String(req.query.omitCxc || '') === '1';

    const queries = [
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }),
      api.runQuery(unidad, 'cotizaciones_activas', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
    ];
    if (!omitCxc) queries.push(api.runQuery(unidad, 'cxc_saldo_total', {}));

    const [mesRows, diaRows, cotis, cmp, saldo] = await Promise.all(queries);
    const mesRow = mesRows[0] || {};
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hoyRow = (diaRows || []).find(r => String(r.dia).startsWith(hoyStr)) || {};
    const cotiTotal = cotis.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    const cotiNumHoy = cotis.filter(r => String(r.fecha || '').slice(0, 10) === hoyStr).length;
    const cotiImpHoy = cotis.filter(r => String(r.fecha || '').slice(0, 10) === hoyStr)
      .reduce((s, r) => s + num(r.importe_sin_iva), 0);
    const cmpRow = (cmp || [])[0] || {};
    const numFac = num(mesRow.num_facturas);

    res.json({
      ok: true,
      unidad, anio, mes,
      ventas: {
        MES_ACTUAL: num(mesRow.total_general),
        MES_VE: num(mesRow.total_ve),
        MES_PV: num(mesRow.total_pv),
        NUM_FACTURAS: numFac,
        // Aliases para director.html que lee FACTURAS_MES.
        FACTURAS_MES: numFac,
        // El upstream no separa remisiones del total general; reportamos 0 para no inflar.
        REMISIONES_MES: 0,
        HOY: num(hoyRow.total_dia),
        NUM_DOCS_HOY: num(hoyRow.num_docs),
        MES_ANTERIOR: num(cmpRow.total_mes_anterior || cmpRow.mes_anterior),
        ANIO_ANTERIOR: num(cmpRow.total_anterior || cmpRow.total_anio_anterior || cmpRow.anio_anterior),
      },
      cotizaciones: {
        // Contrato dual: nombres legacy del backend + nombres "amigables" que lee director.html.
        NUM: cotis.length,
        IMPORTE: cotiTotal,
        COTI_HOY: cotiNumHoy,
        COTI_MES: cotis.length,
        IMPORTE_COTI_HOY: cotiImpHoy,
        IMPORTE_COTI_MES: cotiTotal,
      },
      cxc: saldo ? { SALDO_TOTAL: num((saldo[0] || {}).saldo) } : null,
      build: BUILD_FINGERPRINT,
    });
  } catch (e) { return wrapError(res, e, 'director/resumen'); }
});

app.get('/api/director/vendedores', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [ventas, margen] = await Promise.all([
      api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes }),
      api.runQuery(unidad, 'margen_por_vendedor', { anio, mes }).catch(() => []),
    ]);
    const margenById = new Map((margen || []).map(m => [m.VENDEDOR_ID || m.vendedor_id, m]));
    // Meta diaria por vendedor × días transcurridos = meta del mes (igual cálculo que /ventas/cumplimiento).
    const metas = readMetas();
    const metaDia = num(metas.META_DIARIA_POR_VENDEDOR || metas.META_DIARIA || metas.META_DIA || 5650);
    const today = new Date();
    const isCurrentMonth = (anio === today.getFullYear() && mes === (today.getMonth() + 1));
    const daysInMonth = new Date(anio, mes, 0).getDate();
    const diasTranscurridos = Math.max(1, isCurrentMonth ? today.getDate() : daysInMonth);
    const metaMes = metaDia * diasTranscurridos;

    res.json((Array.isArray(ventas) ? ventas : []).map(v => {
      const id = +v.VENDEDOR_ID || +v.vendedor_id || 0;
      const m = margenById.get(id) || margenById.get(v.VENDEDOR_ID) || {};
      const total = num(v.total_ventas != null ? v.total_ventas : v.TOTAL);
      const docs  = num(v.num_docs != null ? v.num_docs : v.NUM_DOCS);
      const sinMeta = id <= 0;
      return {
        VENDEDOR_ID: id,
        VENDEDOR: v.vendedor || v.VENDEDOR,
        NOMBRE:   v.vendedor || v.VENDEDOR,
        // Aliases para director.html (renderVendedoresList lee VENTAS_MES + META_MES).
        VENTAS:      total,
        TOTAL:       total,
        VENTAS_MES:  total,
        NUM_DOCS:    docs,
        FACTURAS_MES: docs,
        META_DIA:    sinMeta ? 0 : metaDia,
        META_MES:    sinMeta ? 0 : metaMes,
        COSTO:      num(m.costo || m.COSTO),
        MARGEN:     num(m.margen || m.MARGEN),
        MARGEN_PCT: num(m.margen_pct || m.MARGEN_PCT),
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/vendedores'); }
});

app.get('/api/director/ventas-diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // Necesitamos VE/PV por día y líneas de meta para que los charts en director.html
    // (renderVentasDiarias) puedan dibujar VE+PV apilado y líneas META_DIARIA / META_IDEAL.
    // El upstream no expone VE/PV por día — sólo total_dia + num_docs — así que prorrateamos
    // la composición del mes (total_ve / total_pv del mes) sobre cada día.
    const [diaRows, mesRows] = await Promise.all([
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
    ]);
    const mesRow = (mesRows && mesRows[0]) || {};
    const totalGen = num(mesRow.total_general);
    const totalVe = num(mesRow.total_ve);
    const totalPv = num(mesRow.total_pv);
    const ratioVe = totalGen > 0 ? totalVe / totalGen : 1;
    const ratioPv = totalGen > 0 ? totalPv / totalGen : 0;
    const metas = readMetas();
    const metaDiaria = num(metas.META_DIARIA || metas.META_DIA || metas.META_EQUILIBRIO || 5650);
    const metaIdeal  = num(metas.META_IDEAL || 6500);
    res.json((Array.isArray(diaRows) ? diaRows : []).map(r => {
      const total = num(r.total_dia);
      return {
        DIA: r.dia,
        FECHA: r.dia,
        VENTAS: total,
        TOTAL: total,
        TOTAL_DIA: total,
        VENTAS_VE: Math.round(total * ratioVe * 100) / 100,
        VENTAS_PV: Math.round(total * ratioPv * 100) / 100,
        VE: Math.round(total * ratioVe * 100) / 100,
        PV: Math.round(total * ratioPv * 100) / 100,
        DOCS: num(r.num_docs),
        NUM_DOCS: num(r.num_docs),
        // Líneas horizontales para los charts: meta de equilibrio + meta ideal por día.
        META_DIARIA: metaDiaria,
        META_EQUILIBRIO: metaDiaria,
        META_IDEAL: metaIdeal,
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/ventas-diarias'); }
});

app.get('/api/director/top-clientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 10;
    const rows = await api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite });
    // director.html exportClientesCsv lee TOTAL_VENTAS / TOTAL / IMPORTE_NETO + NUM_FACTURAS / FACTURAS / DOCS.
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const total = num(r.total_ventas != null ? r.total_ventas : r.TOTAL);
      const docs  = num(r.num_docs != null ? r.num_docs : r.NUM_DOCS);
      return {
        CLIENTE_ID: r.CLIENTE_ID,
        CLIENTE: r.cliente, NOMBRE: r.cliente,
        VENTAS: total,
        TOTAL: total,
        TOTAL_VENTAS: total,
        IMPORTE_NETO: total,
        NUM_DOCS: docs,
        FACTURAS: docs,
        NUM_FACTURAS: docs,
        DOCS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/top-clientes'); }
});

// /api/director/recientes
// El upstream no expone una query "ventas_recientes" con folio/cliente/vendedor por ticket.
// Como graceful-degradation pintamos las últimas líneas de ventas_diarias agregadas por día
// con etiquetas que respeten el contrato del frontend (FOLIO=día, CLIENTE='Total del día').
app.get('/api/director/recientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    const slice = (Array.isArray(rows) ? rows : []).slice(-10).reverse();
    res.json(slice.map(r => {
      const dia = r.dia || r.DIA || r.fecha || r.FECHA;
      const folio = String(dia || '').slice(5, 10) || '\u2014'; // MM-DD
      return {
        FECHA: dia,
        FOLIO: folio,
        TIPO_SRC: 'VE',
        CLIENTE: 'Total del d\u00eda',
        VENDEDOR: '\u2014',
        TOTAL: num(r.total_dia != null ? r.total_dia : r.TOTAL),
        VENTAS: num(r.total_dia != null ? r.total_dia : r.TOTAL),
        DOCS: num(r.num_docs != null ? r.num_docs : r.NUM_DOCS),
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/recientes'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────────────────────────────────────────

// /api/clientes/inactivos
// clientes.html#renderInactivos espera: NOMBRE, NIVEL (INACTIVO/MUY_INACTIVO),
// DIAS_SIN_COMPRA, ULTIMA_COMPRA, TOTAL_COMPRADO_HISTORIAL, TICKET_PROMEDIO_MES,
// REACTIVACION, CONDICION_PAGO. Normalizamos los nombres del upstream a ese contrato.
app.get('/api/clientes/inactivos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const meses = Number(req.query.meses) || 6;
    const limite = Number(req.query.limit) || 300;
    const rows = await api.runQuery(unidad, 'clientes_inactivos', { meses, limite });
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const dias    = num(r.dias_sin_compra != null ? r.dias_sin_compra : r.DIAS_SIN_COMPRA);
      const totHist = num(r.total_comprado != null ? r.total_comprado : (r.TOTAL_COMPRADO_HISTORIAL != null ? r.TOTAL_COMPRADO_HISTORIAL : r.total));
      const ticket  = num(r.ticket_promedio_mes != null ? r.ticket_promedio_mes : (r.TICKET_PROMEDIO_MES != null ? r.TICKET_PROMEDIO_MES : (totHist / 12)));
      const nivel   = dias > 365 ? 'MUY_INACTIVO' : 'INACTIVO';
      const reactiv = dias > 365 ? 'CRITICA' : dias > 180 ? 'URGENTE' : 'MEDIA';
      return {
        ...r,
        NOMBRE: r.cliente || r.CLIENTE || r.nombre || r.NOMBRE || '',
        CLIENTE: r.cliente || r.CLIENTE || r.nombre || r.NOMBRE || '',
        NIVEL: nivel,
        DIAS_SIN_COMPRA: dias,
        ULTIMA_COMPRA: r.ultima_compra || r.ULTIMA_COMPRA || null,
        TOTAL_COMPRADO_HISTORIAL: totHist,
        TICKET_PROMEDIO_MES: ticket,
        REACTIVACION: reactiv,
        CONDICION_PAGO: r.condicion_pago || r.CONDICION_PAGO || '',
      };
    }));
  } catch (e) { return wrapError(res, e, 'clientes/inactivos'); }
});

app.get('/api/clientes/resumen-riesgo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    // Riesgo = clientes con cartera vencida real (no contado, saldo > 0).
    // Inactivos = clientes sin compras en 6+ meses.
    const [riesgo, inactivos, vencida] = await Promise.all([
      api.runQuery(unidad, 'clientes_riesgo', {}).catch(() => []),
      api.runQuery(unidad, 'clientes_inactivos', { meses: 6, limite: 1000 }).catch(() => []),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
    ]);
    // Aging por cliente (sólo cartera real: a crédito + saldo > 0).
    const norm = (s) => String(s || '').trim().toUpperCase();
    const byCli = new Map();
    for (const v of vencida) {
      if (!isCxcRowVencidoReal(v)) continue;
      const k = norm(v.cliente);
      if (!k) continue;
      const c = byCli.get(k) || { CLIENTE: v.cliente, SALDO: 0, MAX_DIAS: 0 };
      c.SALDO += num(v.saldo_venc);
      c.MAX_DIAS = Math.max(c.MAX_DIAS, num(v.dias_vencido));
      byCli.set(k, c);
    }
    // Buckets monetarios por severidad (días vencidos).
    let MONTO_LEVE = 0, MONTO_MEDIO = 0, MONTO_ALTO = 0, MONTO_CRITICO = 0;
    let nLeve = 0, nMedio = 0, nAlto = 0, nCritico = 0;
    for (const c of byCli.values()) {
      const d = c.MAX_DIAS;
      if (d <= 30)        { MONTO_LEVE    += c.SALDO; nLeve++;    }
      else if (d <= 60)   { MONTO_MEDIO   += c.SALDO; nMedio++;   }
      else if (d <= 90)   { MONTO_ALTO    += c.SALDO; nAlto++;    }
      else                { MONTO_CRITICO += c.SALDO; nCritico++; }
    }
    const resumen = {
      // Legacy contract — usado por index.html / clientes.html
      TOTAL_EN_RIESGO: byCli.size,
      TOTAL_INACTIVOS: Array.isArray(inactivos) ? inactivos.length : 0,
      MONTO_LEVE, MONTO_MEDIO, MONTO_ALTO, MONTO_CRITICO,
      NUM_LEVE: nLeve, NUM_MEDIO: nMedio, NUM_ALTO: nAlto, NUM_CRITICO: nCritico,
      // Datos auxiliares
      NUM_RIESGO: Array.isArray(riesgo) ? riesgo.length : 0,
      TOTAL_VENTA_HISTORICA: (Array.isArray(riesgo) ? riesgo : []).reduce((s, r) => s + num(r.venta_historica), 0),
    };
    res.json({
      ok: true,
      // index.html lee `cliRes.TOTAL_EN_RIESGO`/etc. directamente del top-level.
      ...resumen,
      resumen,
      clientes: [...byCli.values()].sort((a, b) => b.MAX_DIAS - a.MAX_DIAS).slice(0, 50),
    });
  } catch (e) { return wrapError(res, e, 'clientes/resumen-riesgo'); }
});

// /api/clientes/comercial-atraso → clientes con compra atrasada (días sin comprar > 30).
// clientes.html espera: NOMBRE, DIAS_SIN_COMPRA, ULTIMA_COMPRA, TOTAL_COMPRADO_HISTORIAL,
// TICKET_PROMEDIO_MES, REACTIVACION, CONDICION_PAGO.
// Lo construimos desde clientes_inactivos (que ya tiene DIAS_SIN_COMPRA + historial)
// con un umbral más bajo (30 días) para captar atrasos comerciales tempranos.
app.get('/api/clientes/comercial-atraso', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 300;
    const rows = await api.runQuery(unidad, 'clientes_inactivos', { meses: 1, limite: 1500 }).catch(() => []);
    const out = (Array.isArray(rows) ? rows : []).map(r => {
      const dias    = num(r.dias_sin_compra != null ? r.dias_sin_compra : r.DIAS_SIN_COMPRA);
      const ultima  = r.ultima_compra || r.ULTIMA_COMPRA || r.fecha_ultima || null;
      const totHist = num(r.total_comprado != null ? r.total_comprado : (r.TOTAL_COMPRADO_HISTORIAL != null ? r.TOTAL_COMPRADO_HISTORIAL : r.total));
      const ticket  = num(r.ticket_promedio_mes != null ? r.ticket_promedio_mes : (r.TICKET_PROMEDIO_MES != null ? r.TICKET_PROMEDIO_MES : (totHist / 12)));
      const reactiv = dias > 180 ? 'CRITICA' : dias > 90 ? 'URGENTE' : dias > 60 ? 'MEDIA' : 'TEMPRANA';
      return {
        NOMBRE: r.cliente || r.CLIENTE || r.nombre || r.NOMBRE || '',
        CLIENTE: r.cliente || r.CLIENTE || r.nombre || r.NOMBRE || '',
        DIAS_SIN_COMPRA: dias,
        ULTIMA_COMPRA: ultima,
        TOTAL_COMPRADO_HISTORIAL: totHist,
        TICKET_PROMEDIO_MES: ticket,
        REACTIVACION: reactiv,
        CONDICION_PAGO: r.condicion_pago || r.CONDICION_PAGO || '',
      };
    }).filter(c => c.DIAS_SIN_COMPRA >= 30) // sólo atraso real, no compras de hace 1 semana
      .sort((a, b) => b.DIAS_SIN_COMPRA - a.DIAS_SIN_COMPRA)
      .slice(0, limite);
    res.json(out);
  } catch (e) { return wrapError(res, e, 'clientes/comercial-atraso'); }
});

// /api/clientes/inteligencia → tabla principal de "Riesgo" en clientes.html.
// Espera filas con: NOMBRE, EMPRESA, SALDO_TOTAL, MONTO_VENCIDO, MAX_DIAS_VENCIDO,
// NUM_DOCS_VENCIDOS, NIVEL_RIESGO, NUM_COMPRAS_VIDA, ULTIMA_COMPRA,
// ULTIMA_COMPRA_IMPORTE, PERDIDA_VENTA_ANUAL_EST, CONDICION_PAGO.
// Lo construimos agregando cxc_vencida_detalle (cartera real) + clientes_inactivos (historial).
app.get('/api/clientes/inteligencia', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 400;
    const [vencida, hist] = await Promise.all([
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
      api.runQuery(unidad, 'clientes_inactivos', { meses: 0, limite: 5000 }).catch(() => []),
    ]);
    const norm = (s) => String(s || '').trim().toUpperCase();
    // Index histórico por nombre normalizado.
    const histByName = new Map();
    for (const h of (Array.isArray(hist) ? hist : [])) {
      const k = norm(h.cliente || h.CLIENTE || h.nombre || h.NOMBRE);
      if (!k) continue;
      histByName.set(k, h);
    }
    // Aging por cliente desde cxc_vencida_detalle (sólo cartera real).
    const byCli = new Map();
    for (const v of (Array.isArray(vencida) ? vencida : [])) {
      if (!isCxcRowVencidoReal(v)) continue;
      const nombre = v.cliente || v.CLIENTE || '';
      const k = norm(nombre);
      if (!k) continue;
      const c = byCli.get(k) || {
        NOMBRE: nombre,
        EMPRESA: '',
        SALDO_TOTAL: 0, MONTO_VENCIDO: 0,
        MAX_DIAS_VENCIDO: 0, NUM_DOCS_VENCIDOS: 0,
        CONDICION_PAGO: v.condicion_pago || v.CONDICION_PAGO || '',
      };
      c.SALDO_TOTAL      += num(v.saldo);
      c.MONTO_VENCIDO    += num(v.saldo_venc);
      c.MAX_DIAS_VENCIDO  = Math.max(c.MAX_DIAS_VENCIDO, num(v.dias_vencido));
      c.NUM_DOCS_VENCIDOS += 1;
      if (!c.CONDICION_PAGO && (v.condicion_pago || v.CONDICION_PAGO)) c.CONDICION_PAGO = v.condicion_pago || v.CONDICION_PAGO;
      byCli.set(k, c);
    }
    const out = [...byCli.entries()].map(([k, c]) => {
      const h = histByName.get(k) || {};
      const totHist = num(h.total_comprado != null ? h.total_comprado : (h.TOTAL_COMPRADO_HISTORIAL != null ? h.TOTAL_COMPRADO_HISTORIAL : h.total));
      const numCompras = num(h.num_compras != null ? h.num_compras : (h.NUM_COMPRAS_VIDA != null ? h.NUM_COMPRAS_VIDA : h.num_docs));
      const ultima = h.ultima_compra || h.ULTIMA_COMPRA || null;
      const ticket = num(h.ticket_promedio_mes != null ? h.ticket_promedio_mes : (h.TICKET_PROMEDIO_MES != null ? h.TICKET_PROMEDIO_MES : (totHist / 12)));
      const d = c.MAX_DIAS_VENCIDO;
      const nivel = d > 90 ? 'CRITICO' : d > 60 ? 'ALTO' : d > 30 ? 'MEDIO' : 'LEVE';
      return {
        ...c,
        NIVEL_RIESGO: nivel,
        NUM_COMPRAS_VIDA: numCompras,
        ULTIMA_COMPRA: ultima,
        ULTIMA_COMPRA_IMPORTE: num(h.ultima_compra_importe || h.ULTIMA_COMPRA_IMPORTE),
        TOTAL_COMPRADO_HISTORIAL: totHist,
        TICKET_PROMEDIO_MES: ticket,
        PERDIDA_VENTA_ANUAL_EST: ticket * 12,
      };
    })
      .sort((a, b) => b.MONTO_VENCIDO - a.MONTO_VENCIDO)
      .slice(0, limite);
    res.json(out);
  } catch (e) { return wrapError(res, e, 'clientes/inteligencia'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTARIO
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/inv/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    // Resumen de marcas (siempre) + bajo-minimo en paralelo para conteos.
    // limite alto en bajo_minimo para que el conteo refleje la realidad y no el cap (50).
    const [rows, bajos] = await Promise.all([
      api.runQuery(unidad, 'inventario_resumen_marca', {}),
      api.runQuery(unidad, 'inv_bajo_minimo', { limite: 5000 }).catch(() => []),
    ]);
    const total = rows.reduce((s, r) => s + num(r.valor_total), 0);
    const totalArts = rows.reduce((s, r) => s + num(r.total_arts), 0);
    // BAJO_MINIMO = items con minimo definido y existencia < minimo (existencia > 0 implícito en upstream)
    // SIN_STOCK   = items con minimo definido y existencia <= 0 (alerta real)
    const bajoMinimo = bajos.filter(r => num(r.existencia) > 0).length;
    const sinStock   = bajos.filter(r => num(r.existencia) <= 0).length;
    res.json({
      ok: true,
      // Aliases: el frontend espera VALOR_INVENTARIO; mantenemos VALOR_TOTAL para back-compat.
      VALOR_INVENTARIO: total,
      VALOR_TOTAL: total,
      TOTAL_ARTICULOS: totalArts,
      BAJO_MINIMO: bajoMinimo,
      SIN_STOCK: sinStock,
      VALOR_CRITERIO: 'costo_promedio',
      LINEAS: rows,
    });
  } catch (e) { return wrapError(res, e, 'inv/resumen'); }
});

app.get('/api/inv/top-stock', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const rows = await api.runQuery(unidad, 'inv_top_stock', { limite });
    res.json((Array.isArray(rows) ? rows : []).map(r => mapInvRow(r)));
  } catch (e) { return wrapError(res, e, 'inv/top-stock'); }
});

app.get('/api/inv/bajo-minimo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    // Combinamos `inv_bajo_minimo` (corte oficial bajo mínimo) y `articulos_bajo_minimo`
    // (mismo dato, distinto shape: incluye linea, codigo y salidas_anio). Si una falla,
    // usamos la otra; si las dos retornan, preferimos la versión más rica.
    const [base, rico] = await Promise.all([
      api.runQuery(unidad, 'inv_bajo_minimo', { limite }).catch(() => []),
      api.runQuery(unidad, 'articulos_bajo_minimo', { limite }).catch(() => []),
    ]);
    const rowsRich = Array.isArray(rico) && rico.length ? rico : (Array.isArray(base) ? base : []);
    res.json(rowsRich.map(r => mapInvRow(r)));
  } catch (e) { return wrapError(res, e, 'inv/bajo-minimo'); }
});

app.get('/api/inv/sin-movimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const dias = Number(req.query.dias) || 180;
    const limite = Number(req.query.limit) || 60;
    const rows = await api.runQuery(unidad, 'inv_sin_movimiento', { dias, limite });
    res.json((Array.isArray(rows) ? rows : []).map(r => mapInvRow(r)));
  } catch (e) { return wrapError(res, e, 'inv/sin-movimiento'); }
});

app.get('/api/inv/consumo-semanal', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const dias = Number(req.query.dias) || 90;
    const rows = await api.runQuery(unidad, 'consumo_semanal', { dias, limite }).catch(() => []);
    res.json((Array.isArray(rows) ? rows : []).map(r => mapInvRow(r, { dias: 13 })));
  } catch (e) { return wrapError(res, e, 'inv/consumo-semanal'); }
});

// /api/inv/consumo (forecast)
// CONTRATO: inventario.html (sección "Forecast") espera filas con
// DESCRIPCION, UNIDAD, EXISTENCIA_ACTUAL, CONSUMO_DIARIO, DIAS_STOCK,
// ALERTA, STOCK_MINIMO_RECOMENDADO, CANTIDAD_REPONER.
// Como el upstream sólo expone consumo_semanal (sin estos derivados),
// los calculamos aquí a partir del consumo semanal y la existencia actual.
app.get('/api/inv/consumo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    const lead   = Math.min(Math.max(Number(req.query.lead) || 15, 1), 60);
    const rows = await api.runQuery(unidad, 'consumo_semanal', { limite }).catch(() => []);
    const out = (Array.isArray(rows) ? rows : []).map(r => {
      const desc       = r.descripcion || r.DESCRIPCION || r.nombre || r.NOMBRE || '';
      const unidadArt  = r.unidad || r.UNIDAD || '';
      const existencia = num(r.existencia != null ? r.existencia : r.EXISTENCIA);
      const consSem    = num(r.consumo_semanal_prom != null ? r.consumo_semanal_prom : r.CONSUMO_SEMANAL_PROM);
      const consDia    = consSem > 0 ? consSem / 7 : 0;
      const semStock   = num(r.semanas_stock != null ? r.semanas_stock : r.SEMANAS_STOCK);
      // DIAS_STOCK: si tenemos consumo_semanal, derivar; si no, intentar SEMANAS_STOCK*7; si no, "infinito"=9999.
      const diasStock = consDia > 0 ? Math.round(existencia / consDia)
                      : (semStock > 0 ? Math.round(semStock * 7) : 9999);
      const stockMinRec = consDia > 0 ? Math.ceil(consDia * lead) : 0;
      const cantReponer = Math.max(0, stockMinRec - existencia);
      const alerta = diasStock < lead ? 'CRITICO'
                   : diasStock < lead * 2 ? 'BAJO'
                   : (consSem > 0 && existencia <= stockMinRec) ? 'BAJO_MINIMO'
                   : 'OK';
      return {
        DESCRIPCION: desc,
        UNIDAD: unidadArt,
        EXISTENCIA_ACTUAL: existencia,
        EXISTENCIA: existencia,
        CONSUMO_SEMANAL_PROM: consSem,
        CONSUMO_DIARIO: consDia,
        DIAS_STOCK: diasStock,
        SEMANAS_STOCK: semStock,
        STOCK_MINIMO_RECOMENDADO: stockMinRec,
        CANTIDAD_REPONER: cantReponer,
        NECESITA_REPONER: cantReponer > 0,
        ALERTA: alerta,
      };
    });
    res.json(out);
  } catch (e) { return wrapError(res, e, 'inv/consumo'); }
});

// /api/inv/operacion-critica
// CONTRATO: inventario.html lee payload.rows + payload.resumen.{criticos}.
// Cada row debe tener DESCRIPCION, EXISTENCIA_ACTUAL, ENTRADAS_TOTAL,
// CONSUMO_4_SEMANAS, DIAS_COBERTURA_EST, SEMANAS_COBERTURA_EST,
// DIAS_SIN_VENTA, ULTIMO_MOVIMIENTO, CRITICO, ESTADO_OPERATIVO.
// Las construimos uniendo bajo_minimo (urgentes por stock) y sin_movimiento
// (urgentes por rotación), enriqueciendo con consumo_semanal cuando podemos.
app.get('/api/inv/operacion-critica', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 120;
    const [bajos, sinMov, consumo] = await Promise.all([
      api.runQuery(unidad, 'inv_bajo_minimo', { limite: Math.ceil(limite / 2) }).catch(() => []),
      api.runQuery(unidad, 'inv_sin_movimiento', { dias: 180, limite: Math.ceil(limite / 2) }).catch(() => []),
      api.runQuery(unidad, 'consumo_semanal', { limite: 1000 }).catch(() => []),
    ]);
    // Indexar consumo semanal por descripción normalizada (no siempre hay
    // ARTICULO_ID en todas las queries del catálogo).
    const norm = (s) => String(s || '').trim().toUpperCase();
    const consumoByDesc = new Map();
    for (const c of (Array.isArray(consumo) ? consumo : [])) {
      const k = norm(c.descripcion || c.DESCRIPCION || c.nombre || c.NOMBRE);
      if (k) consumoByDesc.set(k, c);
    }
    const seen = new Map();
    const pushRow = (src, kind) => {
      const desc = src.descripcion || src.DESCRIPCION || src.nombre || src.NOMBRE || '';
      if (!desc) return;
      const key = norm(desc);
      if (seen.has(key)) {
        // Si ya estaba, marcar también con la otra causa.
        const r = seen.get(key);
        r.CAUSAS = Array.from(new Set([...(r.CAUSAS || []), kind]));
        return;
      }
      const ex = num(src.existencia != null ? src.existencia
                  : (src.EXISTENCIA != null ? src.EXISTENCIA
                  : (src.existencia_actual != null ? src.existencia_actual
                  : src.EXISTENCIA_ACTUAL)));
      const minAct = num(src.existencia_minima != null ? src.existencia_minima
                  : (src.EXISTENCIA_MINIMA != null ? src.EXISTENCIA_MINIMA
                  : (src.min_actual != null ? src.min_actual : src.MIN_ACTUAL)));
      const ult   = src.ultimo_movimiento || src.ULTIMO_MOVIMIENTO || src.fecha_ult || null;
      const dsv   = src.dias_sin_venta != null ? num(src.dias_sin_venta)
                  : (src.DIAS_SIN_VENTA != null ? num(src.DIAS_SIN_VENTA) : null);
      const c     = consumoByDesc.get(key) || {};
      const consSem  = num(c.consumo_semanal_prom != null ? c.consumo_semanal_prom : c.CONSUMO_SEMANAL_PROM);
      const cons4    = consSem * 4;
      const consDia  = consSem / 7;
      const diasCob  = consDia > 0 ? ex / consDia : null;
      const semCob   = consSem > 0 ? ex / consSem : null;
      const critico  = ex <= 0 || (kind === 'BAJO_MIN' && ex < minAct) || (dsv != null && dsv >= 365);
      const estado   = ex <= 0 ? 'AGOTADO'
                     : (kind === 'BAJO_MIN' && ex < minAct) ? 'COBERTURA BAJA'
                     : (dsv != null && dsv >= 365) ? 'SIN VENTA 1 AÑO'
                     : kind === 'BAJO_MIN' ? 'BAJO MÍNIMO'
                     : 'OK';
      seen.set(key, {
        DESCRIPCION: desc,
        UNIDAD: src.unidad || src.UNIDAD || '',
        EXISTENCIA_ACTUAL: ex,
        MIN_ACTUAL: minAct,
        ENTRADAS_TOTAL: num(src.entradas != null ? src.entradas : src.ENTRADAS_TOTAL),
        CONSUMO_4_SEMANAS: cons4,
        CONSUMO_SEMANAL_PROM: consSem,
        DIAS_COBERTURA_EST: diasCob,
        SEMANAS_COBERTURA_EST: semCob,
        DIAS_SIN_VENTA: dsv,
        ULTIMO_MOVIMIENTO: ult,
        CRITICO: critico,
        ESTADO_OPERATIVO: estado,
        CAUSAS: [kind],
      });
    };
    for (const b of (Array.isArray(bajos) ? bajos : [])) pushRow(b, 'BAJO_MIN');
    for (const s of (Array.isArray(sinMov) ? sinMov : [])) pushRow(s, 'SIN_MOV');
    const allRows = [...seen.values()].slice(0, limite);
    const criticos = allRows.filter(r => r.CRITICO).length;
    res.json({
      ok: true,
      rows: allRows,
      resumen: {
        criticos,
        total: allRows.length,
        bajo_minimo: (Array.isArray(bajos) ? bajos.length : 0),
        sin_movimiento: (Array.isArray(sinMov) ? sinMov.length : 0),
      },
      // Compat hacia atrás: algunos consumidores antiguos leían bajo_minimo/sin_movimiento.
      bajo_minimo: bajos,
      sin_movimiento: sinMov,
    });
  } catch (e) { return wrapError(res, e, 'inv/operacion-critica'); }
});

app.get('/api/inv/existencias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    const limite = Number(req.query.limit) || 200;
    // Estrategia: 1) si q parece clave exacta, intentar `stock_articulo`; 2) fallback
    // a `inventario_articulos_detalle` y filtrar en server por descripción/clave.
    // El API no tiene un endpoint de búsqueda full-text de inventario, así que
    // descargamos un page grande y filtramos local — es lo que hace el dashboard
    // legacy y devuelve datos consistentes contra `inv_top_stock`.
    let rows = [];
    if (q && /^[A-Z0-9_-]{3,32}$/i.test(q)) {
      try {
        const exact = await api.runQuery(unidad, 'stock_articulo', { clave_articulo: q.toUpperCase() });
        if (Array.isArray(exact) && exact.length) rows = exact;
      } catch (_) { /* ignore */ }
    }
    if (!rows.length) {
      const detalle = await api.runQuery(unidad, 'inventario_articulos_detalle', { limite: 5000 })
        .catch(() => []);
      const all = Array.isArray(detalle) ? detalle : [];
      if (q) {
        rows = all.filter(r => {
          const desc = String(r.descripcion || r.DESCRIPCION || r.articulo || '').toLowerCase();
          const clv  = String(r.clave_articulo || r.CLAVE_ARTICULO || r.clave || '').toLowerCase();
          const cod  = String(r.codigo || r.CODIGO || '').toLowerCase();
          const lin  = String(r.linea || r.LINEA || '').toLowerCase();
          return desc.includes(q) || clv.includes(q) || cod.includes(q) || lin.includes(q);
        });
      } else {
        rows = all.slice(0, limite);
      }
    }
    res.json(rows.slice(0, limite).map(r => mapInvRow(r)));
  } catch (e) { return wrapError(res, e, 'inv/existencias'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMOS (suministros médicos / cliente dedicado)
// ─────────────────────────────────────────────────────────────────────────────

// /api/consumos/resumen
// CONTRATO consumos.html: { ok, resumen: { TOTAL_CONSUMO, NUM_DOCS, NUM_ARTICULOS,
//   TICKET_PROMEDIO, MES_ANTERIOR, ANIO_ANTERIOR, VARIACION_PCT, VARIACION_YOY_PCT } }
app.get('/api/consumos/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // Mes anterior explícito (ventas_comparativo solo trae YoY, no MoM)
    const dPrev = new Date(anio, mes - 2, 1);
    const anioPrev = dPrev.getFullYear();
    const mesPrev = dPrev.getMonth() + 1;
    const [mesRows, topProductos, comparativo, mesAntRows] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
      api.runQuery(unidad, 'ventas_top_productos', { anio, mes, limite: 1000 }).catch(() => []),
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio: anioPrev, mes: mesPrev }).catch(() => []),
    ]);
    const m = mesRows[0] || {};
    const cmp = (Array.isArray(comparativo) ? comparativo : [])[0] || {};
    const totalConsumo = num(m.total_general);
    const numDocs = num(m.num_facturas);
    const numArticulos = (Array.isArray(topProductos) ? topProductos : []).length;
    const ticketProm = numDocs > 0 ? totalConsumo / numDocs : 0;
    const mesAnt = num((mesAntRows[0] || {}).total_general)
      || num(cmp.total_mes_anterior || cmp.mes_anterior);
    // ventas_comparativo upstream devuelve {anio_actual, mes, total_actual, total_anterior}
    // donde total_anterior = mismo mes año pasado (YoY).
    const anioAnt = num(cmp.total_anterior || cmp.total_anio_anterior || cmp.anio_anterior);
    res.json({
      ok: true,
      unidad, anio, mes,
      // Top-level (alguna versión del frontend lee ahí directo)
      TOTAL_CONSUMO: totalConsumo,
      NUM_DOCS: numDocs,
      NUM_ARTICULOS: numArticulos,
      TICKET_PROMEDIO: ticketProm,
      VARIACION_PCT: mesAnt > 0 ? ((totalConsumo - mesAnt) / mesAnt) * 100 : 0,
      VARIACION_YOY_PCT: anioAnt > 0 ? ((totalConsumo - anioAnt) / anioAnt) * 100 : 0,
      MES_ANTERIOR: mesAnt,
      ANIO_ANTERIOR: anioAnt,
      // Sub-objeto canónico
      resumen: {
        TOTAL_CONSUMO: totalConsumo,
        NUM_DOCS: numDocs,
        NUM_FACTURAS: numDocs,
        NUM_ARTICULOS: numArticulos,
        TICKET_PROMEDIO: ticketProm,
        MES_ANTERIOR: mesAnt,
        ANIO_ANTERIOR: anioAnt,
        VARIACION_PCT: mesAnt > 0 ? ((totalConsumo - mesAnt) / mesAnt) * 100 : 0,
        VARIACION_YOY_PCT: anioAnt > 0 ? ((totalConsumo - anioAnt) / anioAnt) * 100 : 0,
      },
    });
  } catch (e) { return wrapError(res, e, 'consumos/resumen'); }
});

// /api/consumos/diarias → [{ DIA, FECHA, CONSUMO_TOTAL, NUM_DOCS }]
app.get('/api/consumos/diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    res.json((Array.isArray(rows) ? rows : []).map(r => ({
      DIA: r.dia,
      FECHA: r.dia,
      CONSUMO_TOTAL: num(r.total_dia),
      TOTAL: num(r.total_dia),
      VENTAS: num(r.total_dia),
      NUM_DOCS: num(r.num_docs),
      DOCS: num(r.num_docs),
    })));
  } catch (e) { return wrapError(res, e, 'consumos/diarias'); }
});

// /api/consumos/top-articulos → [{ ARTICULO, CLAVE_ARTICULO, UNIDADES, VENTA_IMPORTE, ... }]
app.get('/api/consumos/top-articulos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 20;
    const rows = await api.runQuery(unidad, 'ventas_top_productos', { anio, mes, limite });
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const desc = r.articulo || r.ARTICULO || r.descripcion || r.DESCRIPCION || '';
      const clave = r.CLAVE_ARTICULO || r.clave_articulo || r.clave || '';
      const unidades = num(r.unidades_vendidas != null ? r.unidades_vendidas : r.UNIDADES);
      const total = num(r.total_venta != null ? r.total_venta : r.TOTAL_VENTA);
      return {
        ARTICULO_ID: r.ARTICULO_ID || r.articulo_id || null,
        ARTICULO: desc,
        DESCRIPCION: desc,
        NOMBRE: desc,
        CLAVE_ARTICULO: clave,
        CLAVE: clave,
        UNIDADES: unidades,
        UNIDADES_VENDIDAS: unidades,
        CANTIDAD: unidades,
        VENTA_IMPORTE: total,
        IMPORTE: total,
        TOTAL_VENTA: total,
        TOTAL: total,
      };
    }));
  } catch (e) { return wrapError(res, e, 'consumos/top-articulos'); }
});

// /api/consumos/semanal-por-articulo → { rows: [...] } con UPPERCASE
app.get('/api/consumos/semanal-por-articulo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const rows = await api.runQuery(unidad, 'consumo_semanal', { limite }).catch(() => []);
    const mapped = (Array.isArray(rows) ? rows : []).map(r => mapInvRow(r, { dias: 13 }));
    res.json({ ok: true, rows: mapped });
  } catch (e) { return wrapError(res, e, 'consumos/semanal-por-articulo'); }
});

// /api/consumos/insights → composite con concentración top5, scorecard, abc, vs período anterior
app.get('/api/consumos/insights', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // Mes anterior para "vs periodo anterior"
    const dPrev = new Date(anio, mes - 2, 1);
    const anioPrev = dPrev.getFullYear();
    const mesPrev = dPrev.getMonth() + 1;
    const [sc, abc, topProd, mesActual, mesPrevRows, comp] = await Promise.all([
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
      api.runQuery(unidad, 'abc_inventario', {}).catch(() => []),
      api.runQuery(unidad, 'ventas_top_productos', { anio, mes, limite: 100 }).catch(() => []),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio: anioPrev, mes: mesPrev }).catch(() => []),
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
    ]);
    const totalActual = num((mesActual[0] || {}).total_general);
    const totalPrev = num((mesPrevRows[0] || {}).total_general);
    // Concentración top5 sobre el mes actual
    const arrTop = Array.isArray(topProd) ? topProd : [];
    const top5Total = arrTop.slice(0, 5).reduce((s, r) => s + num(r.total_venta), 0);
    const concentracionTop5Pct = totalActual > 0 ? (top5Total / totalActual) * 100 : 0;
    res.json({
      ok: true,
      unidad, anio, mes,
      scorecard: sc[0] || {},
      abc,
      vs_periodo_anterior: {
        actual: totalActual,
        anterior: totalPrev,
        delta: totalActual - totalPrev,
        delta_pct: totalPrev > 0 ? ((totalActual - totalPrev) / totalPrev) * 100 : 0,
      },
      concentracion_top5: {
        importe: top5Total,
        porcentaje: Math.round(concentracionTop5Pct * 100) / 100,
        articulos: arrTop.slice(0, 5).map(r => ({
          ARTICULO: r.articulo || '',
          CLAVE_ARTICULO: r.CLAVE_ARTICULO || r.clave_articulo || '',
          IMPORTE: num(r.total_venta),
        })),
      },
      comparativo: (Array.isArray(comp) && comp[0]) || {},
    });
  } catch (e) { return wrapError(res, e, 'consumos/insights'); }
});

// /api/consumos/por-vendedor → [{ VENDEDOR, VENDEDOR_ID, VENTA_IMPORTE, UNIDADES, NUM_DOCS }]
app.get('/api/consumos/por-vendedor', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes });
    res.json((Array.isArray(rows) ? rows : []).map(r => {
      const total = num(r.total_ventas != null ? r.total_ventas : r.TOTAL);
      const docs = num(r.num_docs != null ? r.num_docs : r.NUM_DOCS);
      return {
        VENDEDOR_ID: r.VENDEDOR_ID || r.vendedor_id || 0,
        VENDEDOR: r.vendedor || r.VENDEDOR || '',
        NOMBRE: r.vendedor || r.VENDEDOR || '',
        VENTA_IMPORTE: total,
        TOTAL_VENTAS: total,
        TOTAL: total,
        IMPORTE: total,
        UNIDADES: docs, // proxy: número de docs como cantidad
        NUM_DOCS: docs,
        DOCS: docs,
      };
    }).sort((a, b) => b.VENTA_IMPORTE - a.VENTA_IMPORTE));
  } catch (e) { return wrapError(res, e, 'consumos/por-vendedor'); }
});

// /api/consumos/pedidos-compra → { ok, resumen, top_consumo }
app.get('/api/consumos/pedidos-compra', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [ocpRows, topProd] = await Promise.all([
      api.runQuery(unidad, 'ordenes_compra_pendientes', {}).catch(() => []),
      api.runQuery(unidad, 'ventas_top_productos', { anio, mes, limite: 20 }).catch(() => []),
    ]);
    const ocp = (Array.isArray(ocpRows) ? ocpRows : []).map(r => ({
      PROVEEDOR: r.proveedor || r.PROVEEDOR || '',
      FOLIO: r.FOLIO || r.folio || '',
      FECHA: r.FECHA || r.fecha || null,
      FECHA_ENTREGA: r.FECHA_ENTREGA || r.fecha_entrega || null,
      DIAS_ESPERA: num(r.dias_espera),
      IMPORTE_PEDIDO: num(r.importe_pedido),
      UNIDADES_PEDIDAS: num(r.unidades_pedidas),
      ARTICULO: r.articulo || r.ARTICULO || '',
      CLAVE_ARTICULO: r.CLAVE_ARTICULO || r.clave_articulo || '',
    }));
    const totalImporte = ocp.reduce((s, r) => s + r.IMPORTE_PEDIDO, 0);
    const numPedidos = ocp.length;
    res.json({
      ok: true,
      unidad, anio, mes,
      resumen: {
        NUM_PEDIDOS: numPedidos,
        TOTAL_IMPORTE: totalImporte,
        DIAS_ESPERA_PROM: numPedidos > 0
          ? Math.round((ocp.reduce((s, r) => s + r.DIAS_ESPERA, 0) / numPedidos) * 10) / 10
          : 0,
      },
      pedidos: ocp,
      top_consumo: (Array.isArray(topProd) ? topProd : []).map(r => ({
        ARTICULO: r.articulo || r.ARTICULO || '',
        CLAVE_ARTICULO: r.CLAVE_ARTICULO || r.clave_articulo || '',
        UNIDADES: num(r.unidades_vendidas),
        VENTA_IMPORTE: num(r.total_venta),
      })),
    });
  } catch (e) { return wrapError(res, e, 'consumos/pedidos-compra'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTADOS (P&L)
// ─────────────────────────────────────────────────────────────────────────────

// Resuelve ventana de meses desde query params. Soporta:
//   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD   (rango explícito)
//   ?anio=Y&mes=M                        (mes específico)
//   ?anio=Y                              (año completo)
//   ?meses=N                             (últimos N meses corriendo, default 6)
function pnlMonthsWindow(query) {
  const reDate = /^\d{4}-\d{2}-\d{2}$/;
  const out = [];
  const pushYM = (y, m) => {
    if (!y || !m || m < 1 || m > 12) return;
    out.push({ anio: y, mes: m });
  };
  const desde = String(query.desde || '').trim();
  const hasta = String(query.hasta || '').trim();
  const anio = query.anio ? parseInt(query.anio, 10) : NaN;
  const mes = query.mes ? parseInt(query.mes, 10) : NaN;
  const mesesParam = parseInt(query.meses, 10);

  if (reDate.test(desde) && reDate.test(hasta)) {
    const y0 = parseInt(desde.slice(0, 4), 10);
    const m0 = parseInt(desde.slice(5, 7), 10);
    const y1 = parseInt(hasta.slice(0, 4), 10);
    const m1 = parseInt(hasta.slice(5, 7), 10);
    let y = y0, m = m0;
    while (y < y1 || (y === y1 && m <= m1)) {
      pushYM(y, m);
      m++; if (m > 12) { m = 1; y++; }
      if (out.length > 36) break;
    }
  } else if (!isNaN(anio) && !isNaN(mes)) {
    pushYM(anio, mes);
  } else if (!isNaN(anio)) {
    for (let m = 1; m <= 12; m++) pushYM(anio, m);
  } else {
    const n = Math.min(Math.max(isNaN(mesesParam) ? 6 : mesesParam, 1), 24);
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      pushYM(d.getFullYear(), d.getMonth() + 1);
    }
  }
  return out;
}

// Aliasing defensivo del summary de P&L. Antes leíamos `pnl_resumen` esperando
// VENTAS_NETAS/COSTO_VENTAS/UTILIDAD_BRUTA, pero `pnl_resumen` upstream devuelve
// una fila por CUENTA_ID con cargos/abonos — NO el resumen ejecutivo. El verdadero
// resumen vive en `pnl_operativo` con keys ingreso_total/costo_total/utilidad_bruta/
// margen_bruto_pct/ingreso_ve/ingreso_pv. Y para meses históricos (14 meses) está
// `margen_historico_mensual` con anio/mes/ingreso_total/costo_total/utilidad/margen_pct.
function pickPnlSummary(opRow, histRow, vmRow) {
  const op = opRow || {};
  const h  = histRow || {};
  const vm = vmRow || {};
  const ingresoTotal = num(op.ingreso_total ?? op.INGRESO_TOTAL ?? h.ingreso_total
    ?? op.ventas_netas ?? op.VENTAS_NETAS ?? vm.total_general ?? 0);
  const ingresoVe = num(op.ingreso_ve ?? op.INGRESO_VE ?? vm.total_ve ?? 0);
  const ingresoPv = num(op.ingreso_pv ?? op.INGRESO_PV ?? vm.total_pv ?? 0);
  const costoTotal = num(op.costo_total ?? op.COSTO_TOTAL ?? h.costo_total
    ?? op.costo_ventas ?? op.COSTO_VENTAS ?? 0);
  const costoVe = num(op.costo_ve ?? op.COSTO_VE ?? 0);
  const costoPv = num(op.costo_pv ?? op.COSTO_PV ?? 0);
  const utilBruta = num(op.utilidad_bruta ?? op.UTILIDAD_BRUTA ?? h.utilidad
    ?? (ingresoTotal - costoTotal));
  const margenPct = num(op.margen_bruto_pct ?? op.MARGEN_BRUTO_PCT ?? h.margen_pct
    ?? (ingresoTotal > 0 && costoTotal > 0
      ? Math.round((utilBruta / ingresoTotal) * 1000) / 10 : 0));
  return {
    VENTAS_BRUTAS: ingresoTotal,
    DESCUENTOS_DEV: 0, // upstream no expone aún este split
    VENTAS_NETAS: ingresoTotal,
    VENTAS_VE: ingresoVe,
    VENTAS_PV: ingresoPv,
    COSTO_VENTAS: costoTotal,
    COSTO_VE: costoVe,
    COSTO_PV: costoPv,
    UTILIDAD_BRUTA: utilBruta,
    MARGEN_BRUTO_PCT: margenPct,
  };
}

// Aliasing defensivo de gastos por buckets CO_A1...CO_C6.
// `pnl_operativo` no expone gastos por sub-bucket — sólo ingresos/costos/utilidad
// bruta. Los gastos se construyen abajo a partir de `gastos_detalle` por prefijo
// de cuenta. Esta función queda para compat por si en el futuro el upstream los
// expone agrupados directamente.
function pickPnlGastos(row) {
  const r = row || {};
  const co = {};
  ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6',
   'CO_B1','CO_B2','CO_B3','CO_B4','CO_B5',
   'CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6'].forEach(k => {
    co[k] = num(r[k] ?? r[k.toLowerCase()] ?? 0);
  });
  if (Object.values(co).every(v => !v)) {
    co.CO_A1 = num(r.gastos_venta ?? r.gasto_venta ?? r.GASTOS_VENTA ?? 0);
    co.CO_A2 = num(r.gastos_operacion ?? r.GASTOS_OPERACION ?? 0);
    co.CO_A3 = num(r.gastos_administracion ?? r.GASTOS_ADMIN ?? r.gasto_admin ?? 0);
    co.CO_B1 = num(r.gastos_financieros ?? r.GASTOS_FINANCIEROS ?? 0);
    co.CO_C1 = num(r.otros_gastos ?? r.OTROS_GASTOS ?? r.partidas_extraordinarias ?? 0);
  }
  return co;
}

// Suma cobros del mes a partir del detalle (cobros_detalle_mes)
function sumCobros(rows) {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((s, r) => {
    const v = r.monto_cobrado ?? r.MONTO_COBRADO
            ?? r.importe_cobrado ?? r.IMPORTE_COBRADO
            ?? r.cobrado_periodo ?? r.COBRADO_PERIODO
            ?? r.importe ?? r.IMPORTE ?? 0;
    return s + num(v);
  }, 0);
}

// Aliasing defensivo de ventas_resumen_mes (campo principal de ventas/facturas/VE/PV).
function pickVentasMes(row) {
  const r = row || {};
  return {
    VENTAS_NETAS: num(r.total_general ?? r.VENTAS_NETAS ?? r.total_ventas ?? r.total_netas ?? 0),
    VENTAS_VE: num(r.total_ve ?? r.VENTAS_VE ?? r.total_ve_neto ?? 0),
    VENTAS_PV: num(r.total_pv ?? r.VENTAS_PV ?? r.total_pv_neto ?? 0),
    NUM_FACTURAS: num(r.num_facturas ?? r.NUM_FACTURAS ?? r.num_docs ?? 0),
  };
}

app.get('/api/resultados/pnl', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const ventana = pnlMonthsWindow(req.query || {});
    if (!ventana.length) {
      return res.json({
        ok: true, meses: [], totales: {},
        prefijos_labels: {}, tiene_costo: false, tiene_gastos_co: false,
        subconceptos: {},
      });
    }

    // Pre-fetch del histórico mensual: trae ~14 meses con ingreso_total/costo_total/
    // utilidad/margen_pct ya pre-calculados. Lo usamos como fallback rápido cuando
    // un mes específico no responde con `pnl_operativo` (e.g. meses muy viejos
    // donde el upstream tira 4xx).
    const histRows = await api.runQuery(unidad, 'margen_historico_mensual', {}).catch(() => []);
    const histByYM = new Map();
    for (const h of (Array.isArray(histRows) ? histRows : [])) {
      const a = num(h.anio ?? h.ANIO);
      const m = num(h.mes ?? h.MES);
      if (a > 0 && m > 0) histByYM.set(`${a}-${m}`, h);
    }

    // fetchOne: por mes traemos en paralelo lo absolutamente necesario:
    //   - ventas_resumen_mes (VE/PV/total/num_facturas)
    //   - pnl_operativo      (ingreso_total/costo_total/utilidad_bruta/margen_bruto_pct)
    //   - cobros_detalle_mes (suma de cobros)
    //   - gastos_detalle     (gastos por cuenta para construir buckets CO_*)
    // Antes incluíamos `pnl_resumen` pero NO trae el resumen — devuelve filas
    // por CUENTA_ID con cargos/abonos, no el high-level. Quitarlo evita 1 round-trip
    // por mes (×N meses se nota en el TTFB del dashboard).
    const fetchOne = async ({ anio, mes }) => {
      const [vmRows, opRows, cobRows, gtRows, devRows] = await Promise.all([
        api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
        api.runQuery(unidad, 'pnl_operativo', { anio, mes }).catch(() => []),
        api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes }).catch(() => []),
        api.runQuery(unidad, 'gastos_detalle', { anio, mes }).catch(() => []),
        api.runQuery(unidad, 'devoluciones_por_cliente', { anio, mes, limite: 500 }).catch(() => []),
      ]);
      const vm = pickVentasMes(vmRows[0] || {});
      const histRow = histByYM.get(`${anio}-${mes}`) || null;
      const summary = pickPnlSummary(opRows[0] || null, histRow, vmRows[0] || null);
      const co = pickPnlGastos(opRows[0] || {});
      const cobros = sumCobros(cobRows);
      // Devoluciones (TIPO_DOCTO=D, solo PV en el catálogo). Se exponen como
      // DESCUENTOS_DEV usando `monto_bruto_dev` (parece ser el monto sin IVA
      // de la devolución real; `total_devuelto` upstream tiene semántica
      // inconsistente — ratio variable vs monto_bruto_dev). NO se restan
      // automáticamente del headline VENTAS_NETAS hasta confirmar con MicroSIP
      // la semántica exacta. Para reconciliación al centavo usar
      // /api/debug/ventas-mes que expone ambos campos.
      const devoluciones = (Array.isArray(devRows) ? devRows : [])
        .reduce((s, d) => s + num(d.monto_bruto_dev ?? d.MONTO_BRUTO_DEV ?? 0), 0);

      // Construir buckets CO_* a partir de gastos_detalle (siempre que `pnl_operativo`
      // no exponga gastos directamente). Misma regla por prefijo de cuenta que
      // usaba el legacy.
      const coTieneDatos = Object.values(co).some(v => +v > 0);
      if (!coTieneDatos && Array.isArray(gtRows) && gtRows.length) {
        gtRows.forEach(g => {
          const cuenta = String(g.cuenta_pt ?? g.CUENTA_PT ?? g.cuenta ?? g.CUENTA ?? '').trim();
          const imp = num(g.importe ?? g.IMPORTE ?? g.gasto ?? g.monto ?? g.TOTAL ?? 0);
          if (!imp || !cuenta) return;
          if (cuenta.startsWith('5201')) co.CO_A1 += imp;
          else if (cuenta.startsWith('5202')) co.CO_A2 += imp;
          else if (cuenta.startsWith('5203')) co.CO_A3 += imp;
          else if (cuenta.startsWith('5204')) co.CO_A4 += imp;
          else if (cuenta.startsWith('5205')) co.CO_A5 += imp;
          else if (cuenta.startsWith('5206')) co.CO_A6 += imp;
          else if (cuenta.startsWith('5301')) co.CO_B1 += imp;
          else if (cuenta.startsWith('5302')) co.CO_B2 += imp;
          else if (cuenta.startsWith('5303')) co.CO_B3 += imp;
          else if (cuenta.startsWith('5304')) co.CO_B4 += imp;
          else if (cuenta.startsWith('5305')) co.CO_B5 += imp;
          else if (cuenta.startsWith('5401')) co.CO_C1 += imp;
          else if (cuenta.startsWith('5402')) co.CO_C2 += imp;
          else if (cuenta.startsWith('5403')) co.CO_C3 += imp;
          else if (cuenta.startsWith('5404')) co.CO_C4 += imp;
          else if (cuenta.startsWith('5405')) co.CO_C5 += imp;
          else if (cuenta.startsWith('5406')) co.CO_C6 += imp;
        });
      }

      return {
        ANIO: anio,
        MES: mes,
        VENTAS_BRUTAS: summary.VENTAS_BRUTAS,
        DESCUENTOS_DEV: devoluciones,
        VENTAS_NETAS: summary.VENTAS_NETAS,
        VENTAS_VE: summary.VENTAS_VE || vm.VENTAS_VE,
        VENTAS_PV: summary.VENTAS_PV || vm.VENTAS_PV,
        COSTO_VENTAS: summary.COSTO_VENTAS,
        COSTO_VE: summary.COSTO_VE,
        COSTO_PV: summary.COSTO_PV,
        UTILIDAD_BRUTA: summary.UTILIDAD_BRUTA,
        MARGEN_BRUTO_PCT: summary.MARGEN_BRUTO_PCT,
        COBROS: cobros,
        NUM_FACTURAS: vm.NUM_FACTURAS,
        ...co,
      };
    };

    // Ejecutar de a 3 en paralelo para no saturar el upstream con bursts.
    const meses = [];
    const concurrency = 3;
    for (let i = 0; i < ventana.length; i += concurrency) {
      const batch = ventana.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(fetchOne));
      meses.push(...results);
    }

    const CO_KEYS = ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6',
      'CO_B1','CO_B2','CO_B3','CO_B4','CO_B5',
      'CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6'];

    const totales = meses.reduce((acc, m) => {
      acc.VENTAS_BRUTAS += m.VENTAS_BRUTAS || 0;
      acc.DESCUENTOS_DEV += m.DESCUENTOS_DEV || 0;
      acc.VENTAS_NETAS += m.VENTAS_NETAS || 0;
      acc.VENTAS_VE += m.VENTAS_VE || 0;
      acc.VENTAS_PV += m.VENTAS_PV || 0;
      acc.COSTO_VENTAS += m.COSTO_VENTAS || 0;
      acc.COSTO_VE += m.COSTO_VE || 0;
      acc.COSTO_PV += m.COSTO_PV || 0;
      acc.UTILIDAD_BRUTA += m.UTILIDAD_BRUTA || 0;
      acc.COBROS += m.COBROS || 0;
      acc.NUM_FACTURAS += m.NUM_FACTURAS || 0;
      CO_KEYS.forEach(k => { acc[k] = (acc[k] || 0) + (m[k] || 0); });
      return acc;
    }, {
      VENTAS_BRUTAS: 0, DESCUENTOS_DEV: 0, VENTAS_NETAS: 0,
      VENTAS_VE: 0, VENTAS_PV: 0,
      COSTO_VENTAS: 0, COSTO_VE: 0, COSTO_PV: 0,
      UTILIDAD_BRUTA: 0, COBROS: 0, NUM_FACTURAS: 0,
    });
    totales.MARGEN_BRUTO_PCT = totales.VENTAS_NETAS > 0 && totales.COSTO_VENTAS > 0
      ? Math.round((totales.UTILIDAD_BRUTA / totales.VENTAS_NETAS) * 1000) / 10 : 0;

    const tiene_costo = totales.COSTO_VENTAS > 0;
    const sumGastosCo = CO_KEYS.reduce((s, k) => s + (+totales[k] || 0), 0);
    const tiene_gastos_co = sumGastosCo > 0.01;

    // prefijos_labels: etiquetas humanas de los buckets CO_*. Etiquetas
    // estándar Microsip (gastos de venta/operación/admin/financieros/extra).
    const prefijos_labels = {
      CO_A1: 'Gastos de Venta',
      CO_A2: 'Gastos de Operación',
      CO_A3: 'Gastos de Administración',
      CO_A4: 'Gastos de Personal',
      CO_A5: 'Gastos Generales',
      CO_A6: 'Otros Gastos Op.',
      CO_B1: 'Gastos Financieros',
      CO_B2: 'Productos Financieros',
      CO_B3: 'Diferencias Cambiarias',
      CO_B4: 'Otros Financieros',
      CO_B5: 'Resultado Cambiario',
      CO_C1: 'Otros Gastos / Extraordinarios',
      CO_C2: 'Otros Productos',
      CO_C3: 'Pérdida en Venta de Activo',
      CO_C4: 'Utilidad en Venta de Activo',
      CO_C5: 'ISR/IETU',
      CO_C6: 'PTU',
    };

    res.json({
      ok: true,
      unidad,
      meses,
      totales,
      prefijos_labels,
      tiene_costo,
      tiene_gastos_co,
      gastos_estimados: false,
      gastos_estimados_desde: null,
      subconceptos: {},
    });
  } catch (e) { return wrapError(res, e, 'resultados/pnl'); }
});

// /api/resultados/balance-general
// Reconstrucción del Balance General usando lo que sí expone la API externa:
//   - capital_trabajo  → cxc, inventario, bancos, activo_circulante, cxp
//   - prueba_acida     → cxc, efectivo, activo_liquido, cxp (cross-check)
//   - cxc_saldo_total  → saldo (fallback)
//   - cxp_saldo_total  → saldo (fallback)
//
// LIMITACIÓN UPSTREAM: el catálogo no expone CUENTAS_CO/SALDOS_CO directo, así
// que NO podemos desglosar Activo Fijo / Cargos Diferidos / Otros Activos /
// Capital Social / Utilidades Retenidas como hacía la versión Firebird directa
// (legacy `buildBalanceGeneralForDbo` en archive/server_corregido.legacy.js).
// Lo que se devuelve es el Balance ejecutivo (circulante + cxp + patrimonio
// implícito) que mantiene la ecuación contable Activo = Pasivo + Capital
// alineada con el frontend de public/resultados.html (`renderClassicBalance`).
//
// Shape devuelto (compatible con loadBalanceGeneral en resultados.html):
//   { ok, totales: { ACTIVO_TOTAL, PASIVO_TOTAL, CAPITAL_TOTAL,
//                    PASIVO_MAS_CAPITAL, DIFERENCIA_BALANCE,
//                    ACTIVO_CAJA_BANCOS, ACTIVO_CXC, ACTIVO_INVENTARIO,
//                    ACTIVO_CIRCULANTE, ACTIVO_FIJO_NETO,
//                    CARGOS_DIFERIDOS, OTROS_ACTIVOS },
//     detalle: { activo:[{CUENTA_PT,NOMBRE,SALDO}], pasivo:[…], capital:[…] },
//     cierre:  { ANIO, MES, balance_ultimo_cierre_disponible } }
app.get('/api/resultados/balance-general', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);

    const [capRows, pruebaRows, cxcRows, cxpRows] = await Promise.all([
      api.runQuery(unidad, 'capital_trabajo', {}).catch(() => []),
      api.runQuery(unidad, 'prueba_acida', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_saldo_total', {}).catch(() => []),
      api.runQuery(unidad, 'cxp_saldo_total', {}).catch(() => []),
    ]);

    // Cuando unidad=grupo el upstream hace fan-out y regresa 1 fila por BU
    // (con prefijo _unidad/_unidad_nombre). Agregamos sumando los campos
    // numéricos para que el balance consolidado refleje la suma del grupo.
    const sumRows = (rows, keys) => {
      const arr = Array.isArray(rows) ? rows : [];
      const out = {};
      for (const k of keys) out[k] = arr.reduce((s, r) => s + num(r && r[k]), 0);
      return out;
    };

    const cap = sumRows(capRows, ['cxc', 'inventario', 'bancos', 'activo_circulante', 'cxp', 'capital_trabajo']);
    const prueba = sumRows(pruebaRows, ['cxc', 'efectivo', 'activo_liquido', 'cxp']);
    const cxcSal = sumRows(cxcRows, ['saldo']);
    const cxpSal = sumRows(cxpRows, ['saldo']);

    // Componentes del activo circulante. Preferimos capital_trabajo (incluye
    // inventario que es el componente fuerte del balance), con fallback a
    // prueba_acida y a los saldos individuales.
    const cxc = num(cap.cxc || prueba.cxc || cxcSal.saldo);
    const inventario = num(cap.inventario);
    const bancos = num(cap.bancos || prueba.efectivo);
    const activoCirculante = num(cap.activo_circulante || (cxc + inventario + bancos));

    // Pasivo: por ahora upstream solo expone CXP (no hay desglose de pasivo
    // bancario c/p ni otras provisiones contables). Es el mejor proxy para
    // mantener la ecuación contable cuadrada.
    const pasivoTotal = num(cap.cxp || prueba.cxp || cxpSal.saldo);

    // Activo fijo / cargos diferidos / otros activos: NO expuestos por el
    // catálogo. Quedan en 0 — el frontend (`renderClassicBalance`) los pinta
    // como $0 cuando t.ACTIVO_FIJO_NETO está definido pero vacío.
    const activoFijoNeto = 0;
    const cargosDiferidos = 0;
    const otrosActivos = 0;
    const activoTotal = activoCirculante + activoFijoNeto + cargosDiferidos + otrosActivos;

    // Capital implícito: Activo − Pasivo (la ecuación contable la cierra el
    // patrimonio). Esto evita devolver $0 cuando upstream no expone clase 3*.
    const capitalTotal = activoTotal - pasivoTotal;
    const pasivoMasCapital = pasivoTotal + capitalTotal;
    const diferencia = pasivoMasCapital - activoTotal; // = 0 por construcción

    const round2 = (v) => Math.round(num(v) * 100) / 100;

    const totales = {
      ACTIVO_TOTAL: round2(activoTotal),
      PASIVO_TOTAL: round2(pasivoTotal),
      CAPITAL_TOTAL: round2(capitalTotal),
      PASIVO_MAS_CAPITAL: round2(pasivoMasCapital),
      DIFERENCIA_BALANCE: round2(diferencia),
      ACTIVO_CAJA_BANCOS: round2(bancos),
      ACTIVO_CXC: round2(cxc),
      ACTIVO_INVENTARIO: round2(inventario),
      ACTIVO_CIRCULANTE: round2(activoCirculante),
      ACTIVO_FIJO_NETO: round2(activoFijoNeto),
      CARGOS_DIFERIDOS: round2(cargosDiferidos),
      OTROS_ACTIVOS: round2(otrosActivos),
    };

    // Detalle por naturaleza contable: 3 rubros del activo, CXP, patrimonio
    // implícito. Las claves CUENTA_PT 1102/1103/1104 alinean con los regex
    // del frontend (`bgRowEsCajaBancos`, `bgRowEsCliente`, `bgRowEsInventario`).
    const detalle = {
      activo: [
        { CUENTA_PT: '1102', NOMBRE: 'Caja y bancos (efectivo disponible)', SALDO: round2(bancos) },
        { CUENTA_PT: '1103', NOMBRE: 'Clientes — Cuentas por cobrar', SALDO: round2(cxc) },
        { CUENTA_PT: '1104', NOMBRE: 'Inventario en almacén', SALDO: round2(inventario) },
      ].filter((r) => Math.abs(r.SALDO) > 0.005),
      pasivo: [
        { CUENTA_PT: '2101', NOMBRE: 'Proveedores — Cuentas por pagar', SALDO: round2(pasivoTotal) },
      ].filter((r) => Math.abs(r.SALDO) > 0.005),
      capital: Math.abs(capitalTotal) > 0.005 ? [{
        CUENTA_PT: '3*',
        NOMBRE: 'Patrimonio implícito (Activo − Pasivo · API externa no expone clase 3 desglosada)',
        SALDO: round2(capitalTotal),
      }] : [],
    };

    res.json({
      ok: true,
      unidad,
      totales,
      detalle,
      cierre: {
        ANIO: anio,
        MES: mes,
        balance_ultimo_cierre_disponible: false,
        fuente: 'api-externa · capital_trabajo + prueba_acida + cxc/cxp_saldo_total',
      },
      // Mantener payload legacy como nested para compat con consumidores anteriores.
      // Cuando unidad=grupo se devuelve la suma agregada (no el array per-BU).
      capital_trabajo: cap,
      prueba_acida: prueba,
    });
  } catch (e) { return wrapError(res, e, 'resultados/balance-general'); }
});

app.get('/api/resultados/estado-sr', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [op, mesRows, gastos] = await Promise.all([
      api.runQuery(unidad, 'pnl_operativo', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'gastos_detalle', { anio, mes }).catch(() => []),
    ]);
    res.json({
      ok: true,
      ingresos: mesRows[0] || {},
      utilidad_bruta: op[0] || {},
      gastos,
    });
  } catch (e) { return wrapError(res, e, 'resultados/estado-sr'); }
});

app.get('/api/resultados/pnl-universe', async (req, res) => {
  try {
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery('grupo', 'pnl_operativo', { anio, mes }).catch(() => []);
    res.json({ ok: true, unidades: rows });
  } catch (e) { return wrapError(res, e, 'resultados/pnl-universe'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG / DIAGNÓSTICO
// Endpoint de transparencia para reconciliar contra MicroSIP.
// Ejemplo: /api/debug/ventas-mes?unidad=parker&anio=2026&mes=2
// Devuelve TODOS los upstream relevantes (ventas_resumen_mes, pnl_operativo,
// devoluciones_por_cliente, ventas_acumulado_anual, ventas_resumen_ejecutivo,
// canales_de_venta, ventas_diarias) para que el usuario verifique al centavo.
//
// REGLA DE NEGOCIO CORRECTA (reportada por Guillermo, 2026-04-24):
//   - VE (facturas):  TIPO_DOCTO='F' AND APLICADO='S' AND CANCELADO='N'
//   - PV (mostrador): TIPO_DOCTO='V'
//   - DEDUP folio: si un mismo folio aparece en VE y PV, contar SOLO el de VE
//     (la venta de mostrador que se factura ya quedó reflejada en la factura).
//   - Resultado: VENTA NETA antes de impuestos.
//
// LIMITACIÓN UPSTREAM ACTUAL (api.suminregio.com/api/external):
//   - Filtros aplicados: TIPO_DOCTO='F' AND ESTATUS<>'C'  (VE)
//                       TIPO_DOCTO='V' AND ESTATUS<>'D'  (PV)
//   - NO aplica filtro APLICADO='S'
//   - NO aplica dedup folio entre VE y PV → posible doble conteo cuando una
//     venta de mostrador se factura.
//   - El gap explica diferencias contra MicroSIP cuando hay alta proporción
//     de ventas mostrador-facturadas (típicamente 5-10% de ventas).
//   - Fix requiere actualización del catálogo upstream — escalar a quien
//     administra la API.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/debug/ventas-mes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [vm, op, dev, anual, ejec, canales, dias] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'pnl_operativo', { anio, mes }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'devoluciones_por_cliente', { anio, mes, limite: 500 }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'ventas_acumulado_anual', { anio }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'ventas_resumen_ejecutivo', { anio }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'canales_de_venta', { anio, mes }).catch(e => ({ error: String(e.message || e) })),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }).catch(e => ({ error: String(e.message || e) })),
    ]);

    // Helpers
    const toRows = (x) => Array.isArray(x) ? x : [];
    const sum = (rows, key) => toRows(rows).reduce((s, r) => s + num(r[key]), 0);

    // Resumen al centavo
    const vmRow = toRows(vm)[0] || {};
    const opRow = toRows(op)[0] || {};
    const ventasBrutas = num(vmRow.total_general ?? opRow.ingreso_total ?? 0);
    const totalDevuelto = sum(dev, 'total_devuelto');
    const totalBrutoDev = sum(dev, 'monto_bruto_dev');
    const ventasNetas = Math.max(0, ventasBrutas - totalDevuelto);
    const sumDiarias = sum(dias, 'total_dia');
    const sumCanales = sum(canales, 'total_venta');
    const acumRow = toRows(anual).find(r => num(r.mes ?? r.MES) === mes) || {};
    const ejecRow = toRows(ejec).find(r => num(r.mes ?? r.MES) === mes) || {};

    res.json({
      ok: true,
      unidad,
      anio,
      mes,
      reconciliacion: {
        ventas_brutas_resumen_mes: ventasBrutas,
        ventas_brutas_pnl_operativo: num(opRow.ingreso_total),
        suma_ventas_diarias: sumDiarias,
        suma_canales_venta_VE: sumCanales,
        acumulado_anual_mes: num(acumRow.total_ventas ?? acumRow.total_general ?? acumRow.total ?? 0),
        ejecutivo_mes: num(ejecRow.total_general ?? ejecRow.total_ventas ?? 0),
        devoluciones_total_devuelto: totalDevuelto,
        devoluciones_monto_bruto_dev: totalBrutoDev,
        ventas_netas_calculadas: ventasNetas,
        nota: 'devoluciones_por_cliente solo cubre TIPO_DOCTO=D (PV). Notas de credito VE no estan en el catalogo upstream.',
        regla_negocio_correcta: {
          VE: "TIPO_DOCTO='F' AND APLICADO='S' AND CANCELADO='N'",
          PV: "TIPO_DOCTO='V'",
          dedup: "Si un folio aparece en VE y PV, contar SOLO la VE (venta mostrador-facturada).",
          resultado: 'VENTA NETA antes de impuestos.',
        },
        limitacion_upstream: {
          filtros_actuales_VE: "TIPO_DOCTO='F' AND ESTATUS<>'C'  (no filtra APLICADO ni CANCELADO)",
          filtros_actuales_PV: "TIPO_DOCTO='V' AND ESTATUS<>'D'",
          dedup_folio: 'NO aplicado upstream — posible doble conteo cuando venta mostrador se factura.',
          accion: 'Escalar a quien administra api.suminregio.com para actualizar el catalogo.',
        },
      },
      ventas_resumen_mes: vmRow,
      pnl_operativo: opRow,
      devoluciones_por_cliente: toRows(dev),
      ventas_acumulado_anual: toRows(anual),
      ventas_resumen_ejecutivo: toRows(ejec),
      canales_de_venta: toRows(canales),
      ventas_diarias_count: toRows(dias).length,
    });
  } catch (e) { return wrapError(res, e, 'debug/ventas-mes'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSE / COMPARE / SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/universe/scorecard', async (_req, res) => {
  // CONTRATO comparar.html: array plano [{ id, label, snapshot, ventas:{mes,hoy}, cxc:{total,vencido} }].
  // Fan-out manual a las 6 BUs (no usamos `grupo` porque queremos un row por unidad,
  // no el consolidado). Si alguna unidad falla, devolvemos placeholder con flag offline.
  try {
    const ids = ['parker', 'medico', 'maderas', 'empaque', 'agua', 'reciclaje'];
    const today = new Date();
    const anio = today.getFullYear();
    const mes = today.getMonth() + 1;
    const hoyStr = today.toISOString().slice(0, 10);
    const tasks = ids.map(async (id) => {
      try {
        const [scRows, mesRows, diaRows, saldo, vencida] = await Promise.all([
          api.runQuery(id, 'scorecard', {}).catch(() => []),
          api.runQuery(id, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
          api.runQuery(id, 'ventas_diarias', { anio, mes }).catch(() => []),
          api.runQuery(id, 'cxc_saldo_total', {}).catch(() => []),
          api.runQuery(id, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
        ]);
        const sc = (Array.isArray(scRows) ? scRows : [])[0] || {};
        const mesRow = (Array.isArray(mesRows) ? mesRows : [])[0] || {};
        const totalMes = num(mesRow.total_general) || num(sc.ventas_mes_actual);
        const hoyRow = (Array.isArray(diaRows) ? diaRows : []).find(r => String(r.dia).startsWith(hoyStr)) || {};
        const totalSaldo = num((Array.isArray(saldo) ? saldo[0] : null || {}).saldo) || num(sc.saldo_cxc);
        const vencido = (Array.isArray(vencida) ? vencida : [])
          .filter(isCxcRowVencidoReal)
          .reduce((s, r) => s + num(r.saldo_venc), 0);
        return {
          id,
          label: labelForUnidad(id),
          ok: true,
          snapshot: sc,
          ventas: {
            mes: totalMes,
            hoy: num(hoyRow.total_dia),
            num_facturas: num(mesRow.num_facturas),
            mes_anterior: num(sc.ventas_mes_anterior),
            anio_anterior: num(sc.ventas_anio_anterior),
          },
          cxc: {
            total: totalSaldo,
            vencido,
            vigente: Math.max(0, totalSaldo - vencido),
          },
          clientes_activos: num(sc.clientes_activos),
        };
      } catch (e) {
        return { id, label: labelForUnidad(id), ok: false, error: String(e.message || e) };
      }
    });
    const unidades = await Promise.all(tasks);
    res.json({ ok: true, unidades });
  } catch (e) { return wrapError(res, e, 'universe/scorecard'); }
});

app.get('/api/compare/temporal', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_comparativo', { anio, mes });
    res.json({ ok: true, rows });
  } catch (e) { return wrapError(res, e, 'compare/temporal'); }
});

app.get('/api/briefing/diario', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [sc, top, aging, cotis] = await Promise.all([
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
      api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite: 5 }).catch(() => []),
      api.runQuery(unidad, 'cxc_aging', {}).catch(() => []),
      api.runQuery(unidad, 'cotizaciones_activas', { anio, mes }).catch(() => []),
    ]);
    res.json({
      ok: true,
      unidad, anio, mes, ts: new Date().toISOString(),
      scorecard: sc[0] || {},
      top_clientes: top,
      cxc_aging: aging,
      cotizaciones_activas: cotis.length,
    });
  } catch (e) { return wrapError(res, e, 'briefing/diario'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// DEBUG / ADMIN (mínimo necesario)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/debug/cxc-contado-delta', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const rows = await api.runQuery(unidad, 'cxc_por_condicion', {});
    res.json({ ok: true, por_condicion: rows });
  } catch (e) { return wrapError(res, e, 'debug/cxc-contado-delta'); }
});

app.get('/api/debug/cxc-ve-pv-gap', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const mesRows = await api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes });
    res.json({ ok: true, ventas: mesRows[0] || {} });
  } catch (e) { return wrapError(res, e, 'debug/cxc-ve-pv-gap'); }
});

app.get('/api/admin/errors', (_req, res) => res.json({ ok: true, errors: [] }));
app.delete('/api/admin/errors', (_req, res) => res.json({ ok: true, cleared: true }));
app.get('/api/admin/alerts/test', (_req, res) => res.json({ ok: true, note: 'alerts no configuradas en modo external_api' }));

app.get('/api/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send([
    '# HELP suminregio_up 1 si el server está vivo',
    '# TYPE suminregio_up gauge',
    'suminregio_up 1',
  ].join('\n'));
});

// Notificaciones: stubs (las dejamos fuera del MVP del API externo)
app.get('/api/notify/push/vapid-public-key', (_req, res) => {
  res.json({ ok: false, error: 'push no habilitado en modo external_api' });
});
app.post('/api/notify/push/subscribe', (_req, res) => res.json({ ok: false, error: 'push no habilitado' }));
app.post('/api/notify/push/send', (_req, res) => res.json({ ok: false, error: 'push no habilitado' }));
app.post('/api/notify/slack', (_req, res) => res.json({ ok: false, error: 'slack no habilitado' }));

// Capital (snapshot local opcional)
const CAPITAL_PATH = path.join(__dirname, 'data', 'capital.json');
app.get('/api/capital/data', (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(CAPITAL_PATH, 'utf8'))); }
  catch { res.json({ ok: true, data: [] }); }
});
app.post('/api/capital/semana', (req, res) => {
  try {
    const curr = (() => { try { return JSON.parse(fs.readFileSync(CAPITAL_PATH, 'utf8')); } catch { return { ok: true, data: [] }; } })();
    curr.data = curr.data || [];
    curr.data.push({ ts: new Date().toISOString(), ...(req.body || {}) });
    fs.mkdirSync(path.dirname(CAPITAL_PATH), { recursive: true });
    fs.writeFileSync(CAPITAL_PATH, JSON.stringify(curr, null, 2));
    res.json({ ok: true });
  } catch (e) { return wrapError(res, e, 'capital/semana'); }
});
app.get('/api/capital/snapshot', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const [cap, saldoCxc] = await Promise.all([
      api.runQuery(unidad, 'capital_trabajo', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_saldo_total', {}).catch(() => []),
    ]);
    res.json({ ok: true, capital: cap[0] || {}, saldo_cxc: num((saldoCxc[0] || {}).saldo) });
  } catch (e) { return wrapError(res, e, 'capital/snapshot'); }
});

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use('/api/', (req, res) => {
  res.status(404).json({ ok: false, error: 'ruta no encontrada', path: req.originalUrl });
});

// Root → index.html
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Arranque ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[suminregio-dashboard v2] listo en :${PORT}`);
  console.log(`  upstream: ${api.BASE_URL}`);
  console.log(`  build:    ${BUILD_FINGERPRINT}`);
  console.log(`  unidad:   ${DEFAULT_UNIDAD}`);
  console.log(`  cors:     ${CORS_ORIGIN}`);
  if (process.env.AUTH_USERS) console.log('  auth:     basic auth activo');
  console.log(`  prod:     ${IS_PROD}`);
});

module.exports = app;
