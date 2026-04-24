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
app.get('/api/universe/databases', async (_req, res) => {
  try {
    const h = await api.health();
    const dbs = (h.unidades_disponibles || []).map(id => ({
      id, label: id.toUpperCase(), active: true,
    }));
    res.json({ ok: true, default: DEFAULT_UNIDAD, databases: dbs });
  } catch (e) { return wrapError(res, e, 'universe/databases'); }
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
    res.json({
      ok: true,
      unidad,
      anio, mes,
      MES_ACTUAL: num(mesRow.total_general),
      MES_VE: num(mesRow.total_ve),
      MES_PV: num(mesRow.total_pv),
      NUM_FACTURAS: num(mesRow.num_facturas),
      HOY: num(hoyRow.total_dia),
      NUM_DOCS_HOY: num(hoyRow.num_docs),
      MES_ANTERIOR: num(cmpRow.total_mes_anterior || cmpRow.mes_anterior),
      ANIO_ANTERIOR: num(cmpRow.total_anio_anterior || cmpRow.anio_anterior),
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
app.get('/api/ventas/por-vendedor', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes });
    res.json(rows.map(r => ({
      VENDEDOR_ID: r.VENDEDOR_ID,
      VENDEDOR: r.vendedor,
      NOMBRE: r.vendedor,
      VENTAS: num(r.total_ventas),
      TOTAL: num(r.total_ventas),
      NUM_DOCS: num(r.num_docs),
      DOCS: num(r.num_docs),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/por-vendedor'); }
});

// /api/ventas/top-clientes
app.get('/api/ventas/top-clientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 10;
    const rows = await api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite });
    res.json(rows.map(r => ({
      CLIENTE_ID: r.CLIENTE_ID,
      CLIENTE: r.cliente,
      NOMBRE: r.cliente,
      VENTAS: num(r.total_ventas),
      TOTAL: num(r.total_ventas),
      NUM_DOCS: num(r.num_docs),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/top-clientes'); }
});

// /api/ventas/recientes → últimas facturas (fallback a ventas_diarias)
app.get('/api/ventas/recientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    const slice = rows.slice(-10).reverse();
    res.json(slice.map(r => ({ FECHA: r.dia, VENTAS: num(r.total_dia), DOCS: num(r.num_docs) })));
  } catch (e) { return wrapError(res, e, 'ventas/recientes'); }
});

// /api/ventas/cumplimiento
app.get('/api/ventas/cumplimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [rows] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
    ]);
    const metas = readMetas();
    const total = num((rows[0] || {}).total_general);
    const meta = num(metas.META_MES || 0);
    const pct = meta > 0 ? (total / meta) * 100 : 0;
    res.json({
      ok: true,
      MES_ACTUAL: total, META: meta, META_IDEAL: num(metas.META_IDEAL), PCT: pct,
      CUMPLIMIENTO_PCT: pct,
    });
  } catch (e) { return wrapError(res, e, 'ventas/cumplimiento'); }
});

// /api/ventas/margen-lineas
app.get('/api/ventas/margen-lineas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'margen_por_linea', { anio, mes });
    res.json(rows.map(r => ({
      LINEA: r.linea || r.LINEA,
      VENTA: num(r.venta || r.VENTA),
      COSTO: num(r.costo || r.COSTO),
      MARGEN: num(r.margen || r.MARGEN),
      MARGEN_PCT: num(r.margen_pct || r.MARGEN_PCT),
    })));
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

// /api/ventas/cobradas-detalle
app.get('/api/ventas/cobradas-detalle', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'ventas/cobradas-detalle'); }
});

// /api/ventas/cobradas-por-factura (alias)
app.get('/api/ventas/cobradas-por-factura', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
    res.json(rows);
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
app.get('/api/ventas/por-vendedor/cotizaciones', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cotizaciones_activas', { anio, mes });
    const byV = new Map();
    for (const r of rows) {
      const k = r.vendedor || '—';
      const c = byV.get(k) || { VENDEDOR: k, TOTAL: 0, NUM: 0 };
      c.TOTAL += num(r.importe_sin_iva);
      c.NUM += 1;
      byV.set(k, c);
    }
    res.json([...byV.values()].sort((a, b) => b.TOTAL - a.TOTAL));
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
    const normKey = (s) => String(s || '').trim().toUpperCase();
    const aggByCli = new Map();
    for (const v of vencida) {
      const k = normKey(v.cliente);
      if (!k) continue;
      const curr = aggByCli.get(k) || { VENCIDO: 0, MAX_DIAS: 0, NUM_DOCS: 0, COND: '' };
      const dias = num(v.dias_vencido);
      if (dias > 0) {
        curr.VENCIDO += num(v.saldo_venc);
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
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 1000 }).catch(() => []),
    ]);
    const bucketMap = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const b of aging) {
      const key = String(b.bucket).replace(/\s/g, '');
      if (key in bucketMap) bucketMap[key] = num(b.total_bucket);
    }
    const totalSaldo = num((saldo[0] || {}).saldo);
    const totalVencido = vencida
      .filter(r => r.dias_vencido > 0)
      .reduce((s, r) => s + num(r.saldo_venc), 0);
    const maxDias = vencida.reduce((m, r) => Math.max(m, num(r.dias_vencido)), 0);
    res.json({
      ok: true,
      resumen: {
        SALDO_TOTAL: totalSaldo,
        VENCIDO: totalVencido,
        VIGENTE: Math.max(0, totalSaldo - totalVencido),
        MAX_DIAS: maxDias,
        BUCKET_0_30: bucketMap['0-30'],
        BUCKET_31_60: bucketMap['31-60'],
        BUCKET_61_90: bucketMap['61-90'],
        BUCKET_90_PLUS: bucketMap['90+'],
      },
      aging,
    });
  } catch (e) { return wrapError(res, e, 'cxc/resumen-aging'); }
});

app.get('/api/cxc/vencidas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 100;
    const rows = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite });
    res.json(rows
      .filter(r => r.dias_vencido > 0)
      .map(r => ({
        CLIENTE: r.cliente,
        DOCTO_CC_ID: r.doc_id,
        FECHA: r.fecha_doc,
        FECHA_VENCIMIENTO: r.fecha_venc,
        DIAS_VENCIDO: num(r.dias_vencido),
        IMPORTE: num(r.importe_cargo),
        SALDO: num(r.saldo_venc),
        CONDICION_PAGO: r.condicion_pago,
      })));
  } catch (e) { return wrapError(res, e, 'cxc/vencidas'); }
});

app.get('/api/cxc/vigentes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 200;
    const rows = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 });
    const vigentes = rows
      .filter(r => num(r.dias_vencido) <= 0 && num(r.saldo_venc) > 0)
      .slice(0, limite)
      .map(r => ({
        CLIENTE: r.cliente,
        DOCTO_CC_ID: r.doc_id,
        FECHA: r.fecha_doc,
        FECHA_VENCIMIENTO: r.fecha_venc,
        DIAS_PARA_VENCER: Math.abs(num(r.dias_vencido)),
        SALDO: num(r.saldo_venc),
        CONDICION_PAGO: r.condicion_pago,
      }));
    res.json(vigentes);
  } catch (e) { return wrapError(res, e, 'cxc/vigentes'); }
});

app.get('/api/cxc/por-condicion', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const rows = await api.runQuery(unidad, 'cxc_por_condicion', {});
    res.json(rows.map(r => ({
      CONDICION_PAGO: r.condicion_pago || r.CONDICION,
      SALDO: num(r.saldo || r.SALDO),
      NUM_CLIENTES: num(r.num_clientes || r.NUM_CLIENTES),
      NUM_DOCS: num(r.num_docs || r.NUM_DOCS),
    })));
  } catch (e) { return wrapError(res, e, 'cxc/por-condicion'); }
});

app.get('/api/cxc/historial-pagos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes });
    res.json(rows);
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
    const cmpRow = (cmp || [])[0] || {};

    res.json({
      ok: true,
      unidad, anio, mes,
      ventas: {
        MES_ACTUAL: num(mesRow.total_general),
        MES_VE: num(mesRow.total_ve),
        MES_PV: num(mesRow.total_pv),
        NUM_FACTURAS: num(mesRow.num_facturas),
        HOY: num(hoyRow.total_dia),
        NUM_DOCS_HOY: num(hoyRow.num_docs),
        MES_ANTERIOR: num(cmpRow.total_mes_anterior || cmpRow.mes_anterior),
        ANIO_ANTERIOR: num(cmpRow.total_anio_anterior || cmpRow.anio_anterior),
      },
      cotizaciones: {
        NUM: cotis.length,
        IMPORTE: cotiTotal,
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
    res.json(ventas.map(v => {
      const m = margenById.get(v.VENDEDOR_ID) || {};
      return {
        VENDEDOR_ID: v.VENDEDOR_ID,
        VENDEDOR: v.vendedor,
        NOMBRE: v.vendedor,
        VENTAS: num(v.total_ventas),
        NUM_DOCS: num(v.num_docs),
        COSTO: num(m.costo || m.COSTO),
        MARGEN: num(m.margen || m.MARGEN),
        MARGEN_PCT: num(m.margen_pct || m.MARGEN_PCT),
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/vendedores'); }
});

app.get('/api/director/ventas-diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    res.json(rows.map(r => ({ DIA: r.dia, FECHA: r.dia, VENTAS: num(r.total_dia), DOCS: num(r.num_docs) })));
  } catch (e) { return wrapError(res, e, 'director/ventas-diarias'); }
});

app.get('/api/director/top-clientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 10;
    const rows = await api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite });
    res.json(rows.map(r => ({
      CLIENTE_ID: r.CLIENTE_ID, CLIENTE: r.cliente,
      NOMBRE: r.cliente, VENTAS: num(r.total_ventas), NUM_DOCS: num(r.num_docs),
    })));
  } catch (e) { return wrapError(res, e, 'director/top-clientes'); }
});

app.get('/api/director/recientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    res.json(rows.slice(-10).reverse().map(r => ({ FECHA: r.dia, VENTAS: num(r.total_dia), DOCS: num(r.num_docs) })));
  } catch (e) { return wrapError(res, e, 'director/recientes'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/clientes/inactivos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const meses = Number(req.query.meses) || 6;
    const limite = Number(req.query.limit) || 300;
    const rows = await api.runQuery(unidad, 'clientes_inactivos', { meses, limite });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'clientes/inactivos'); }
});

app.get('/api/clientes/resumen-riesgo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const rows = await api.runQuery(unidad, 'clientes_riesgo', {}).catch(() => []);
    const resumen = {
      NUM_RIESGO: rows.length,
      TOTAL_VENTA_HISTORICA: rows.reduce((s, r) => s + num(r.venta_historica), 0),
    };
    res.json({ ok: true, resumen, clientes: rows.slice(0, 50) });
  } catch (e) { return wrapError(res, e, 'clientes/resumen-riesgo'); }
});

app.get('/api/clientes/comercial-atraso', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 300;
    const rows = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 });
    const byCli = new Map();
    for (const r of rows) {
      if (num(r.dias_vencido) <= 0) continue;
      const k = r.cliente;
      const c = byCli.get(k) || { CLIENTE: k, SALDO_VENCIDO: 0, MAX_DIAS: 0, NUM_DOCS: 0 };
      c.SALDO_VENCIDO += num(r.saldo_venc);
      c.MAX_DIAS = Math.max(c.MAX_DIAS, num(r.dias_vencido));
      c.NUM_DOCS += 1;
      byCli.set(k, c);
    }
    res.json([...byCli.values()].sort((a, b) => b.MAX_DIAS - a.MAX_DIAS).slice(0, limite));
  } catch (e) { return wrapError(res, e, 'clientes/comercial-atraso'); }
});

app.get('/api/clientes/inteligencia', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 400;
    const rows = await api.runQuery(unidad, 'clientes_nuevos_perdidos', { limite }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'clientes/inteligencia'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTARIO
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/inv/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const rows = await api.runQuery(unidad, 'inventario_resumen_marca', {});
    const total = rows.reduce((s, r) => s + num(r.valor_total), 0);
    const totalArts = rows.reduce((s, r) => s + num(r.total_arts), 0);
    res.json({
      ok: true,
      VALOR_TOTAL: total,
      TOTAL_ARTICULOS: totalArts,
      LINEAS: rows,
    });
  } catch (e) { return wrapError(res, e, 'inv/resumen'); }
});

app.get('/api/inv/top-stock', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const rows = await api.runQuery(unidad, 'inv_top_stock', { limite });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/top-stock'); }
});

app.get('/api/inv/bajo-minimo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    const rows = await api.runQuery(unidad, 'inv_bajo_minimo', { limite }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/bajo-minimo'); }
});

app.get('/api/inv/sin-movimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const dias = Number(req.query.dias) || 180;
    const limite = Number(req.query.limit) || 60;
    const rows = await api.runQuery(unidad, 'inv_sin_movimiento', { dias, limite });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/sin-movimiento'); }
});

app.get('/api/inv/consumo-semanal', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const dias = Number(req.query.dias) || 90;
    const rows = await api.runQuery(unidad, 'consumo_semanal', { dias, limite }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/consumo-semanal'); }
});

app.get('/api/inv/consumo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    const rows = await api.runQuery(unidad, 'consumo_semanal', { limite }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/consumo'); }
});

app.get('/api/inv/operacion-critica', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 120;
    const [bajos, sinMov] = await Promise.all([
      api.runQuery(unidad, 'inv_bajo_minimo', { limite: Math.ceil(limite / 2) }).catch(() => []),
      api.runQuery(unidad, 'inv_sin_movimiento', { dias: 180, limite: Math.ceil(limite / 2) }).catch(() => []),
    ]);
    res.json({
      ok: true,
      bajo_minimo: bajos,
      sin_movimiento: sinMov,
    });
  } catch (e) { return wrapError(res, e, 'inv/operacion-critica'); }
});

app.get('/api/inv/existencias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const rows = await api.runQuery(unidad, 'stock_articulo', { clave_articulo: q }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'inv/existencias'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMOS (suministros médicos / cliente dedicado)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/consumos/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes });
    res.json({ ok: true, ...(rows[0] || {}) });
  } catch (e) { return wrapError(res, e, 'consumos/resumen'); }
});

app.get('/api/consumos/diarias', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_diarias', { anio, mes });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'consumos/diarias'); }
});

app.get('/api/consumos/top-articulos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 20;
    const rows = await api.runQuery(unidad, 'ventas_top_productos', { anio, mes, limite });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'consumos/top-articulos'); }
});

app.get('/api/consumos/semanal-por-articulo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const rows = await api.runQuery(unidad, 'consumo_semanal', { limite }).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'consumos/semanal-por-articulo'); }
});

app.get('/api/consumos/insights', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [sc, abc] = await Promise.all([
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
      api.runQuery(unidad, 'abc_inventario', {}).catch(() => []),
    ]);
    res.json({ ok: true, scorecard: sc[0] || {}, abc });
  } catch (e) { return wrapError(res, e, 'consumos/insights'); }
});

app.get('/api/consumos/por-vendedor', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'consumos/por-vendedor'); }
});

app.get('/api/consumos/pedidos-compra', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const rows = await api.runQuery(unidad, 'ordenes_compra_pendientes', {}).catch(() => []);
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'consumos/pedidos-compra'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTADOS (P&L)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/resultados/pnl', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [pnl, op] = await Promise.all([
      api.runQuery(unidad, 'pnl_resumen', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'pnl_operativo', { anio, mes }).catch(() => []),
    ]);
    res.json({ ok: true, pnl_contable: pnl, pnl_operativo: op });
  } catch (e) { return wrapError(res, e, 'resultados/pnl'); }
});

app.get('/api/resultados/balance-general', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const [cap, prueba] = await Promise.all([
      api.runQuery(unidad, 'capital_trabajo', {}).catch(() => []),
      api.runQuery(unidad, 'prueba_acida', {}).catch(() => []),
    ]);
    res.json({ ok: true, capital_trabajo: cap[0] || {}, prueba_acida: prueba[0] || {} });
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
// UNIVERSE / COMPARE / SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/universe/scorecard', async (_req, res) => {
  try {
    const rows = await api.runQuery('grupo', 'scorecard', {});
    res.json({ ok: true, unidades: rows });
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
