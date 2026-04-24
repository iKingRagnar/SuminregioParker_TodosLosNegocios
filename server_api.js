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
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

// ── Session-cookie auth (reemplaza al basic auth del browser) ───────────────
// AUTH_USERS="usuario:pass;usuario2:pass2" habilita login; sin esa env, el
// acceso es abierto. La cookie "sumi_sess" es HMAC-firmada con un secreto
// derivado o configurado en AUTH_SESSION_SECRET.
const AUTH_USERS_RAW = (process.env.AUTH_USERS || '').trim();
const AUTH_USERS = {};
if (AUTH_USERS_RAW) {
  for (const pair of AUTH_USERS_RAW.split(';')) {
    const [u, p] = pair.split(':');
    if (u && p) AUTH_USERS[u.trim()] = p.trim();
  }
}
const AUTH_ENABLED = Object.keys(AUTH_USERS).length > 0;
const SESSION_COOKIE = 'sumi_sess';
const SESSION_SECRET = (process.env.AUTH_SESSION_SECRET && process.env.AUTH_SESSION_SECRET.length >= 16)
  ? process.env.AUTH_SESSION_SECRET
  : crypto.createHash('sha256').update('suminregio-v2::' + AUTH_USERS_RAW + '::' + (process.env.SUMINREGIO_API_KEY || '')).digest('hex');
const SESSION_MAX_AGE_DEFAULT_MS = 1000 * 60 * 60 * 12;       // 12 h por defecto
const SESSION_MAX_AGE_REMEMBER_MS = 1000 * 60 * 60 * 24 * 30; // 30 d con "recordarme"

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = (str + '==='.slice((str.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(pad, 'base64');
}
function signSessionToken(payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
  return body + '.' + b64urlEncode(sig);
}
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sigB64] = token.split('.');
  if (!body || !sigB64) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest();
  let given;
  try { given = b64urlDecode(sigB64); } catch { return null; }
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
  if (!payload.u || typeof payload.u !== 'string') return null;
  return payload;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function issueSessionCookie(res, username, remember) {
  const maxAge = remember ? SESSION_MAX_AGE_REMEMBER_MS : SESSION_MAX_AGE_DEFAULT_MS;
  const token = signSessionToken({ u: username, exp: Date.now() + maxAge, r: !!remember });
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function currentSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = cookies[SESSION_COOKIE];
  return tok ? verifySessionToken(tok) : null;
}

// Rutas/patrones que NO requieren sesión (estáticos de la pantalla de login
// + endpoints de auth + health). Todo lo demás queda gateado.
// NOTA CRÍTICA: los .js/.mjs/.map son públicos porque no contienen datos de negocio —
// el gate real vive en los endpoints /api/* que devuelven información. Sin esto, cada
// script del dashboard redirige a /login y el cliente entra en loop de 302s (visible
// en logs como "GET /nav.js → 688B", "GET /login?next=%2Fnav.js → 9732B", etc).
// /fix(.html) es la utilidad técnica de rescate que desregistra el SW zombie y
// limpia cachés — DEBE ser pública porque si el browser no puede llegar al login
// por culpa del SW viejo, tampoco podría llegar a /fix si estuviera gateado.
const PUBLIC_ALLOW_RE = /^(?:\/login(?:\.html)?$|\/fix(?:\.html)?$|\/logout$|\/api\/auth\/|\/api\/ping$|\/health$|\/favicon|\/assets\/|\/manifest\.webmanifest$|\/sw\.js$|\/.*\.(?:css|js|mjs|map|svg|png|jpg|jpeg|gif|ico|webp|avif|woff2?|ttf|otf|eot|txt|json)(?:\?.*)?$)/i;

if (AUTH_ENABLED) {
  console.log(`[auth] session-cookie auth ACTIVO para ${Object.keys(AUTH_USERS).length} usuario(s)`);
  app.use((req, res, next) => {
    // Always allow public routes, health checks, static assets for the login screen
    if (req.method === 'OPTIONS') return next();
    if (PUBLIC_ALLOW_RE.test(req.path)) return next();

    const sess = currentSession(req);
    if (sess) {
      req.user = sess;
      return next();
    }
    // API → 401 JSON; HTML → redirect al login conservando ?next=
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'no_autenticado', login_url: '/login' });
    }
    const nextUrl = encodeURIComponent(req.originalUrl || req.url || '/');
    return res.redirect(302, `/login?next=${nextUrl}`);
  });
} else {
  console.log('[auth] AUTH_USERS vacío → acceso abierto (dev)');
}

// Endpoints de autenticación (siempre registrados; devuelven shape consistente)
app.post('/api/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const usernameRaw = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const remember = !!body.remember;
    if (!usernameRaw || !password) {
      return res.status(400).json({ ok: false, error: 'usuario_y_contrasena_requeridos' });
    }
    if (!AUTH_ENABLED) {
      // Sin AUTH_USERS todo acceso es abierto; dejamos pasar y emitimos cookie "guest"
      issueSessionCookie(res, 'guest', remember);
      return res.json({ ok: true, user: 'guest', remember, mode: 'open' });
    }
    const expected = AUTH_USERS[usernameRaw];
    let pwOk = false;
    if (expected) {
      const a = Buffer.from(password, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      pwOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!pwOk) {
      // Delay pequeño para mitigar brute-force por red (no bloquea event-loop)
      return setTimeout(() => {
        res.status(401).json({ ok: false, error: 'credenciales_invalidas' });
      }, 350);
    }
    issueSessionCookie(res, usernameRaw, remember);
    return res.json({ ok: true, user: usernameRaw, remember, mode: 'auth' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'login_fallo', detail: String(e && e.message || e) });
  }
});
app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  const sess = currentSession(req);
  if (!sess) return res.status(401).json({ ok: false, error: 'no_autenticado' });
  res.json({ ok: true, user: sess.u, remember: !!sess.r, exp: sess.exp });
});
// /login → public/login.html (el static middleware resuelve la ruta concreta)
app.get('/login', (_req, res) => {
  const loginHtml = path.join(__dirname, 'public', 'login.html');
  if (fs.existsSync(loginHtml)) return res.sendFile(loginHtml);
  return res.status(500).send('login.html no encontrado');
});
// Logout convenience (GET) — borra la cookie y redirige al login
app.get('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.redirect(302, '/login');
});
// /fix → public/fix.html — utilidad técnica pública que desregistra el SW zombie
// y limpia cachés del navegador. Debe responder siempre, sin auth, porque el
// usuario que no puede llegar al login por culpa del SW viejo tampoco podría
// llegar a /fix si estuviera gateado.
app.get('/fix', (_req, res) => {
  const fixHtml = path.join(__dirname, 'public', 'fix.html');
  if (fs.existsSync(fixHtml)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(fixHtml);
  }
  return res.status(500).send('fix.html no encontrado');
});

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
  let anio = Number(req.query.anio || req.query.year || defAnio || now.getFullYear());
  let mes = Number(req.query.mes || req.query.month || defMes || (now.getMonth() + 1));
  // Honrar ?preset=mes_ant / anio_ant cuando el cliente no manda anio/mes explícitos
  const preset = String(req.query.preset || '').toLowerCase();
  const anioExplicit = req.query.anio != null || req.query.year != null;
  const mesExplicit = req.query.mes != null || req.query.month != null;
  if (preset === 'mes_ant' && !mesExplicit) {
    mes = mes - 1;
    if (mes === 0) { mes = 12; if (!anioExplicit) anio = anio - 1; }
  } else if (preset === 'anio_ant' && !anioExplicit) {
    anio = anio - 1;
  }
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
  const def = {
    META_MES: 3000000,
    META_IDEAL: 3300000,
    META_ANIO: 36000000,
    META_DIARIA: 100000,
    META_DIARIA_POR_VENDEDOR: 20000,
    META_VENDEDOR_MES: 600000,
    META_VENDEDOR_ANIO: 7200000,
  };
  try {
    const loaded = JSON.parse(fs.readFileSync(METAS_PATH, 'utf8'));
    return { ...def, ...loaded };
  } catch { return def; }
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
    const [mesRows, diaRows, comp, scoreRows] = await Promise.all([
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }),
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
    ]);
    const mesRow = mesRows[0] || {};
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hoyRow = (diaRows || []).find(r => String(r.dia).startsWith(hoyStr)) || {};
    const cmpRow = comp[0] || {};
    const scoreRow = (scoreRows || [])[0] || {};
    // ventas_comparativo devuelve total_anterior = mismo mes del año anterior.
    // El mes anterior consecutivo sale de scorecard.ventas_mes_anterior.
    const anioAnterior = num(
      cmpRow.total_anterior || cmpRow.total_anio_anterior || cmpRow.anio_anterior,
    );
    const mesAnterior = num(
      scoreRow.ventas_mes_anterior || cmpRow.total_mes_anterior || cmpRow.mes_anterior,
    );
    // ventas.html consume FACTURAS_MES / REMISIONES_MES por alias. El external
    // API no expone IVA por separado — esos campos se quedan en 0.
    res.json({
      ok: true,
      unidad,
      anio, mes,
      MES_ACTUAL: num(mesRow.total_general),
      MES_VE: num(mesRow.total_ve),
      MES_PV: num(mesRow.total_pv),
      NUM_FACTURAS: num(mesRow.num_facturas),
      FACTURAS_MES: num(mesRow.num_facturas),       // alias para ventas.html
      NUM_FACTURAS_MES: num(mesRow.num_facturas),   // alias para ventas.html
      REMISIONES_MES: num(mesRow.total_pv),         // PV ≈ punto de venta/remisiones
      HOY: num(hoyRow.total_dia),
      TOTAL_HOY: num(hoyRow.total_dia),
      VENTA_HOY: num(hoyRow.total_dia),
      TOTAL_MES: num(mesRow.total_general),
      VENTA_MES: num(mesRow.total_general),
      NUM_DOCS_HOY: num(hoyRow.num_docs),
      MES_ANTERIOR: mesAnterior,
      ANIO_ANTERIOR: anioAnterior,
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
    // ventas_acumulado_anual devuelve { mes, total_mes }. No separa VE/PV.
    res.json(rows.map(r => {
      const total = num(r.total_mes || r.total_ve || r.total);
      return {
        ANIO: num(r.anio || anio),
        MES: num(r.mes),
        TOTAL: total,
        VENTAS: total,
        VE: num(r.total_ve), // puede ser 0 si la query no lo separa
        PV: num(r.total_pv),
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/mensuales'); }
});

// /api/ventas/por-vendedor
// ventas.html ordena y muestra barras usando r.VENTAS_MES y r.FACTURAS_MES,
// así que emitimos esos alias además de VENTAS/NUM_DOCS/TOTAL/DOCS para que
// cualquier consumidor (director, vendedores, charts) encuentre el field.
app.get('/api/ventas/por-vendedor', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes });
    res.json(rows.map(r => {
      const ventas = num(r.total_ventas);
      const docs = num(r.num_docs);
      return {
        VENDEDOR_ID: r.VENDEDOR_ID,
        VENDEDOR: r.vendedor,
        NOMBRE: r.vendedor,
        VENTAS: ventas,
        VENTAS_MES: ventas,        // alias que ventas.html usa para ordenar
        TOTAL: ventas,
        TOTAL_VENTAS: ventas,
        NUM_DOCS: docs,
        DOCS: docs,
        FACTURAS_MES: docs,        // alias que ventas.html usa para mostrar #facturas
        NUM_FACTURAS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/por-vendedor'); }
});

// /api/ventas/top-clientes
// ventas.html lee r.TOTAL ?? r.TOTAL_VENTAS ?? r.IMPORTE_NETO — emitimos todos
// los aliases para evitar mismatch entre páginas (ventas, director, index).
app.get('/api/ventas/top-clientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 10;
    const rows = await api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite });
    res.json(rows.map(r => {
      const ventas = num(r.total_ventas);
      const docs = num(r.num_docs);
      return {
        CLIENTE_ID: r.CLIENTE_ID,
        CLIENTE: r.cliente,
        NOMBRE: r.cliente,
        VENTAS: ventas,
        TOTAL: ventas,
        TOTAL_VENTAS: ventas,
        IMPORTE_NETO: ventas,
        NUM_DOCS: docs,
        NUM_FACTURAS: docs,
        FACTURAS: docs,
      };
    }));
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
// Devuelve ARRAY de vendedores con ventas_mes + meta + cumplimiento_pct.
// vendedores.html hace Array.isArray(cumplData) ? cumplData : [], por eso
// la forma canónica aquí es array — no objeto agregado.
// index.html y ai-chat.js lo consumen pero sólo lo pasan a través, así que
// el cambio de shape (object → array) es compatible.
app.get('/api/ventas/cumplimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [vendedores, margen] = await Promise.all([
      api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes }),
      api.runQuery(unidad, 'margen_por_vendedor', { anio, mes }).catch(() => []),
    ]);
    const metas = readMetas();
    const metaVendedorMes = num(metas.META_VENDEDOR_MES || 600000);
    const metaVendedorDia = num(metas.META_DIARIA_POR_VENDEDOR || 20000);
    // margen_por_vendedor no trae VENDEDOR_ID — match por nombre normalizado.
    const normName = (s) => String(s || '').trim().toUpperCase();
    const margenByName = new Map();
    for (const mg of (margen || [])) {
      const k = normName(mg.vendedor || mg.VENDEDOR);
      if (k) margenByName.set(k, mg);
    }
    res.json(vendedores.map(v => {
      const mg = margenByName.get(normName(v.vendedor)) || {};
      const ventaMes = num(v.total_ventas);
      const facturas = num(v.num_docs);
      const pctMes = metaVendedorMes > 0 ? (ventaMes / metaVendedorMes) * 100 : 0;
      return {
        VENDEDOR_ID: v.VENDEDOR_ID,
        NOMBRE: v.vendedor,
        VENDEDOR: v.vendedor,
        VENTA_MES: ventaMes,
        VENTAS_MES: ventaMes,       // alias defensivo (index.html ranking sort)
        VENTA_HOY: 0,                // upstream no tiene ventas_hoy_por_vendedor aún
        FACTURAS_MES: facturas,
        NUM_DOCS: facturas,
        META_MES: metaVendedorMes,
        META_DIA: metaVendedorDia,
        CUMPLIMIENTO_PCT: pctMes,
        PCT: pctMes,
        MARGEN_PCT: num(mg.margen_pct || mg.MARGEN_PCT),
        UTILIDAD: num(mg.utilidad || mg.UTILIDAD),
      };
    }));
  } catch (e) { return wrapError(res, e, 'ventas/cumplimiento'); }
});

// /api/ventas/margen-lineas
app.get('/api/ventas/margen-lineas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'margen_por_linea', { anio, mes });
    // margen_por_linea devuelve { linea, num_articulos, unidades, total_venta,
    // total_costo, utilidad, margen_pct }. Los fields antiguos (venta/costo/
    // margen) nunca existieron — quedaban en 0 en la UI.
    res.json(rows.map(r => ({
      LINEA: r.linea || r.LINEA,
      VENTA: num(r.total_venta || r.venta || r.VENTA),
      COSTO: num(r.total_costo || r.costo || r.COSTO),
      MARGEN: num(r.utilidad || r.margen || r.MARGEN),
      MARGEN_PCT: num(r.margen_pct || r.MARGEN_PCT),
      NUM_ARTICULOS: num(r.num_articulos),
      UNIDADES: num(r.unidades),
    })));
  } catch (e) { return wrapError(res, e, 'ventas/margen-lineas'); }
});

// /api/ventas/cobradas
app.get('/api/ventas/cobradas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // cobros_por_vendedor corre sobre Firebird live y a veces devuelve 500.
    // Degradamos a [] y al mismo tiempo intentamos `ventas_por_vendedor`
    // como fallback para que la UI muestre al menos el facturado.
    const [cobrosRaw, ventasRaw] = await Promise.all([
      api.runQuery(unidad, 'cobros_por_vendedor', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes }).catch(() => []),
    ]);

    const normKey = (s) => String(s || '').trim().toUpperCase();
    const facturadoByV = new Map();
    for (const v of ventasRaw) {
      facturadoByV.set(normKey(v.vendedor), num(v.total_ventas));
    }

    const vendedores = (cobrosRaw || []).map((r) => {
      const nombre = r.vendedor || r.VENDEDOR || '';
      const cobrado = num(r.total_cobrado || r.cobrado || r.COBRADO);
      const facturado = facturadoByV.get(normKey(nombre)) || 0;
      const nCobros = num(r.num_cobros || r.NUM_COBROS);
      return {
        VENDEDOR: nombre,
        NOMBRE: nombre,
        VENDEDOR_ID: r.VENDEDOR_ID,
        COBRADO: cobrado,
        TOTAL_COBRADO: cobrado,        // alias que cobradas.html espera
        FACTURADO: facturado,
        TOTAL_FACTURADO: facturado,
        NUM_COBROS: nCobros,
        NUM_DOCS: nCobros,
        NUM_FACTURAS: nCobros,         // alias: cobradas.html lee r.NUM_FACTURAS por fila
        PCT_COBRADO: facturado > 0 ? Math.round((cobrado / facturado) * 1000) / 10 : 0,
      };
    });

    // Si cobros falló pero hay ventas, construir la lista a partir de ventas
    // para no dejar la UI vacía.
    if (!vendedores.length && ventasRaw.length) {
      for (const v of ventasRaw) {
        const docs = num(v.num_docs);
        vendedores.push({
          VENDEDOR: v.vendedor,
          NOMBRE: v.vendedor,
          VENDEDOR_ID: v.VENDEDOR_ID,
          COBRADO: 0,
          TOTAL_COBRADO: 0,
          FACTURADO: num(v.total_ventas),
          TOTAL_FACTURADO: num(v.total_ventas),
          NUM_COBROS: 0,
          NUM_DOCS: docs,
          NUM_FACTURAS: docs,
          PCT_COBRADO: 0,
        });
      }
    }

    const totalCobrado = vendedores.reduce((s, r) => s + r.COBRADO, 0);
    const totalFacturado = vendedores.reduce((s, r) => s + r.FACTURADO, 0);
    res.json({
      ok: true,
      vendedores,
      totalCobrado: Math.round(totalCobrado * 100) / 100,
      totalFacturado: Math.round(totalFacturado * 100) / 100,
    });
  } catch (e) { return wrapError(res, e, 'ventas/cobradas'); }
});

// /api/ventas/cobradas-detalle
// cobros_detalle_mes corre sobre el engine Firebird (live). Cuando Firebird
// está caído o la query del lado upstream lanza un 500, devolvemos un array
// vacío para que la UI degrade a estado "sin cobros" en vez de crashear.
app.get('/api/ventas/cobradas-detalle', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes })
      .catch((err) => {
        console.warn(`[cobradas-detalle] upstream failed: ${err.message}`);
        return [];
      });
    res.json(rows);
  } catch (e) { return wrapError(res, e, 'ventas/cobradas-detalle'); }
});

// /api/ventas/cobradas-por-factura (alias)
app.get('/api/ventas/cobradas-por-factura', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes })
      .catch((err) => {
        console.warn(`[cobradas-por-factura] upstream failed: ${err.message}`);
        return [];
      });
    // Normalizar al shape que cobradas.html espera: FECHA_FACTURA, FOLIO_VE,
    // CLIENTE, COBRADO_PERIODO, VENDEDOR. Upstream los trae en minúscula.
    res.json((rows || []).map((r) => ({
      FECHA_FACTURA: r.fecha || r.FECHA || r.fecha_factura || '',
      FECHA: r.fecha || r.FECHA || '',
      FOLIO_VE: r.folio || r.FOLIO || r.folio_ve || '',
      FOLIO: r.folio || r.FOLIO || '',
      CLIENTE: r.cliente || r.CLIENTE || '',
      MONTO_COBRADO: num(r.monto_cobrado || r.MONTO_COBRADO || r.cobrado),
      COBRADO_PERIODO: num(r.cobrado_periodo || r.cobrado || r.monto_cobrado),
      VENDEDOR: r.vendedor || r.VENDEDOR || '',
    })));
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
// Devuelve array agrupado por vendedor con:
//   VENDEDOR (nombre), VENDEDOR_ID (match contra ventas_por_vendedor por nombre),
//   COTIZACIONES_MES (monto total), NUM_COTI_MES (conteo), TOTAL/NUM (alias legacy).
// vendedores.html hace: cotiMap[c.VENDEDOR_ID] = c; COTI_MES: cotiMap[v.VENDEDOR_ID].COTIZACIONES_MES
// por eso es crítico emitir VENDEDOR_ID y los campos con nombres que el frontend espera.
app.get('/api/ventas/por-vendedor/cotizaciones', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const [cotis, ventas] = await Promise.all([
      api.runQuery(unidad, 'cotizaciones_activas', { anio, mes }),
      // Cruzamos contra ventas_por_vendedor para obtener VENDEDOR_ID (cotizaciones_activas no lo trae).
      api.runQuery(unidad, 'ventas_por_vendedor', { anio, mes }).catch(() => []),
    ]);
    const normName = (s) => String(s || '').trim().toUpperCase();
    const idByName = new Map();
    for (const v of (ventas || [])) {
      const k = normName(v.vendedor);
      if (k) idByName.set(k, v.VENDEDOR_ID);
    }
    const byV = new Map();
    for (const r of cotis) {
      const nombre = r.vendedor || '—';
      const key = normName(nombre);
      const c = byV.get(key) || {
        VENDEDOR_ID: idByName.get(key) || null,
        VENDEDOR: nombre,
        NOMBRE: nombre,
        COTIZACIONES_MES: 0,
        NUM_COTI_MES: 0,
        TOTAL: 0,
        NUM: 0,
      };
      const monto = num(r.importe_sin_iva);
      c.COTIZACIONES_MES += monto;
      c.NUM_COTI_MES += 1;
      c.TOTAL += monto;
      c.NUM += 1;
      byV.set(key, c);
    }
    res.json([...byV.values()].sort((a, b) => b.COTIZACIONES_MES - a.COTIZACIONES_MES));
  } catch (e) { return wrapError(res, e, 'ventas/por-vendedor/cotizaciones'); }
});

// /api/ventas/vs-cotizaciones
// ventas.html consume este endpoint con ?meses=6 y espera arrays:
//   { ventas: [{ANIO, MES, TOTAL_VENTAS, NUM_DOCS}, ...],
//     cotizaciones: [{ANIO, MES, TOTAL_COTI, NUM_COTI}, ...] }
// Hay que iterar N meses y agregar por mes (ventas_resumen_mes + cotizaciones_activas).
app.get('/api/ventas/vs-cotizaciones', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const mesesN = Math.max(1, Math.min(24, Number(req.query.meses) || 6));
    const { anio, mes } = yearMonthFromReq(req);
    const base = new Date(anio, mes - 1, 1);
    const ventana = [];
    for (let i = mesesN - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      ventana.push({ anio: d.getFullYear(), mes: d.getMonth() + 1 });
    }

    // Paralelizamos las N*2 llamadas (ventas + cotis por mes). Con 6 meses
    // son 12 llamadas — un loop secuencial tardaba >45s y tumbaba la UI.
    const tasks = ventana.flatMap(({ anio: a, mes: m }) => [
      api.runQuery(unidad, 'ventas_resumen_mes', { anio: a, mes: m }).catch(() => []),
      api.runQuery(unidad, 'cotizaciones_activas', { anio: a, mes: m }).catch(() => []),
    ]);
    const resultados = await Promise.all(tasks);

    const ventasArr = [];
    const cotiArr = [];
    ventana.forEach(({ anio: a, mes: m }, i) => {
      const ventasRows = resultados[i * 2] || [];
      const cotisRows = resultados[i * 2 + 1] || [];
      const vRow = ventasRows[0] || {};
      ventasArr.push({
        ANIO: a, MES: m,
        TOTAL_VENTAS: num(vRow.total_general),
        TOTAL_VE: num(vRow.total_ve),
        TOTAL_PV: num(vRow.total_pv),
        NUM_DOCS: num(vRow.num_facturas),
      });
      const totC = cotisRows.reduce((s, r) => s + num(r.importe_sin_iva), 0);
      cotiArr.push({
        ANIO: a, MES: m,
        TOTAL_COTI: totC,
        NUM_COTI: cotisRows.length,
      });
    });

    const totalV = ventasArr.reduce((s, r) => s + r.TOTAL_VENTAS, 0);
    const totalC = cotiArr.reduce((s, r) => s + r.TOTAL_COTI, 0);
    res.json({
      ok: true,
      ventas: ventasArr,
      cotizaciones: cotiArr,
      VENTAS: totalV, COTIZACIONES: totalC,
      RATIO: totalC > 0 ? totalV / totalC : 0,
      NUM_VENTAS: ventasArr.reduce((s, r) => s + r.NUM_DOCS, 0),
      NUM_COTIZACIONES: cotiArr.reduce((s, r) => s + r.NUM_COTI, 0),
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
    // FUENTE DE VERDAD: los buckets de aging suman exactamente al saldo total.
    // cxc_vencida_detalle es detalle filtrado (limite + saldo_venc con ruido
    // float) — sirve para MAX_DIAS y conteo de clientes, pero NO para totales.
    const totalVencidoFromAging = bucketMap['0-30'] + bucketMap['31-60'] + bucketMap['61-90'] + bucketMap['90+'];
    // VIGENTE = saldo documental que aún no vence. Si los buckets aging cubren
    // el saldo total, VIGENTE = 0 (situación actual: 100% de la cartera vencida).
    const totalVigente = Math.max(0, totalSaldo - totalVencidoFromAging);
    const maxDias = vencida.reduce((m, r) => Math.max(m, num(r.dias_vencido)), 0);
    const clientesVencidos = new Set(
      vencida.filter(r => num(r.dias_vencido) > 0 && r.cliente)
             .map(r => String(r.cliente).trim().toUpperCase())
    ).size;
    const clientesTotales = new Set(
      vencida.filter(r => r.cliente)
             .map(r => String(r.cliente).trim().toUpperCase())
    ).size;

    // Dos formas del aging para compatibilidad con distintos consumidores:
    //   - agingObj: forma canónica que espera cxc.html y filters.js
    //     (CORRIENTE / DIAS_1_30 / DIAS_31_60 / DIAS_61_90 / DIAS_MAS_90).
    //   - agingArray: forma cruda del external API ([{bucket, total_bucket,
    //     num_cargos}, ...]) — se conserva en `aging_raw` por si alguien la usa.
    const agingObj = {
      CORRIENTE: totalVigente,
      DIAS_1_30: bucketMap['0-30'],
      DIAS_31_60: bucketMap['31-60'],
      DIAS_61_90: bucketMap['61-90'],
      DIAS_MAS_90: bucketMap['90+'],
    };

    res.json({
      ok: true,
      resumen: {
        SALDO_TOTAL: totalSaldo,
        VENCIDO: totalVencidoFromAging,     // fuente: suma de buckets aging (matchea saldo total)
        VIGENTE: totalVigente,               // saldo - aging; 0 si toda la cartera está vencida
        POR_VENCER: totalVigente,            // alias que usa cxc.html
        MAX_DIAS: maxDias,
        NUM_CLIENTES: clientesTotales,
        NUM_CLIENTES_VENCIDOS: clientesVencidos,
        BUCKET_0_30: bucketMap['0-30'],
        BUCKET_31_60: bucketMap['31-60'],
        BUCKET_61_90: bucketMap['61-90'],
        BUCKET_90_PLUS: bucketMap['90+'],
      },
      aging: agingObj,
      aging_raw: aging,
    });
  } catch (e) { return wrapError(res, e, 'cxc/resumen-aging'); }
});

app.get('/api/cxc/vencidas', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 100;
    const rows = await api.runQuery(unidad, 'cxc_vencida_detalle', { limite });
    res.json(rows
      .filter(r => num(r.dias_vencido) > 0)
      .map(r => {
        const dias = num(r.dias_vencido);
        return {
          CLIENTE: r.cliente,
          DOCTO_CC_ID: r.doc_id,
          FOLIO: r.folio || r.doc_id,
          FECHA: r.fecha_doc,
          FECHA_VENTA: r.fecha_doc,
          FECHA_VENCIMIENTO: r.fecha_venc,
          FECHA_VENC_PLAZO: r.fecha_venc,
          DIAS_VENCIDO: dias,
          DIAS_ATRASO: dias,            // alias que cxc.html espera para filtrar/ordenar
          TIEMPO_SIN_PAGAR_DIAS: dias,
          IMPORTE: num(r.importe_cargo),
          SALDO: num(r.saldo_venc),
          CONDICION_PAGO: r.condicion_pago,
        };
      }));
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
      .map(r => {
        const dias = num(r.dias_vencido);
        return {
          CLIENTE: r.cliente,
          DOCTO_CC_ID: r.doc_id,
          FOLIO: r.folio || r.doc_id,
          FECHA: r.fecha_doc,
          FECHA_VENTA: r.fecha_doc,
          FECHA_VENCIMIENTO: r.fecha_venc,
          FECHA_VENC_PLAZO: r.fecha_venc,
          DIAS_PARA_VENCER: Math.abs(dias),
          DIAS_ATRASO: dias,        // cxc.html lo usa para orden (negativo o 0)
          TIEMPO_SIN_PAGAR_DIAS: 0,
          IMPORTE: num(r.importe_cargo),
          SALDO: num(r.saldo_venc),
          CONDICION_PAGO: r.condicion_pago,
        };
      });
    res.json(vigentes);
  } catch (e) { return wrapError(res, e, 'cxc/vigentes'); }
});

app.get('/api/cxc/por-condicion', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    // cxc_por_condicion sólo devuelve { condicion_pago, saldo }, así que
    // enriquecemos con cxc_vencida_detalle para poder partir corriente vs
    // vencido, contar clientes únicos y documentos por condición — que es
    // justo lo que consume cxc.html (SALDO_TOTAL, CORRIENTE, VENCIDO,
    // NUM_CLIENTES, NUM_DOCUMENTOS, DIAS_CREDITO).
    const [condRows, detalle] = await Promise.all([
      api.runQuery(unidad, 'cxc_por_condicion', {}),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 5000 }).catch(() => []),
    ]);

    // Detectar "días de crédito" a partir del nombre de la condición
    // (p.ej. "30 DIAS", "Contado", "60 DÍAS"). Si no hay número, 0.
    const diasFromCond = (s) => {
      const m = String(s || '').match(/(\d+)\s*d/i);
      return m ? Number(m[1]) : 0;
    };

    // Agrupar detalle por condición de pago para sacar corriente/vencido,
    // clientes únicos y docs.
    const agg = new Map();
    for (const v of detalle) {
      const cond = String(v.condicion_pago || 'S/D').trim();
      const key = cond.toUpperCase();
      if (!agg.has(key)) {
        agg.set(key, { clientes: new Set(), docs: 0, corriente: 0, vencido: 0 });
      }
      const a = agg.get(key);
      const saldoVenc = num(v.saldo_venc);
      if (num(v.dias_vencido) > 0) a.vencido += saldoVenc;
      else a.corriente += saldoVenc;
      a.docs += 1;
      if (v.cliente) a.clientes.add(String(v.cliente).trim().toUpperCase());
    }

    res.json(condRows.map(r => {
      const cond = r.condicion_pago || r.CONDICION || '';
      const saldoTotal = num(r.saldo || r.SALDO);
      const a = agg.get(String(cond).trim().toUpperCase())
              || { clientes: new Set(), docs: 0, corriente: 0, vencido: 0 };
      return {
        CONDICION_PAGO: cond,
        // SALDO kept for backward compat, SALDO_TOTAL is the canonical name
        // that cxc.html expects.
        SALDO: saldoTotal,
        SALDO_TOTAL: saldoTotal,
        CORRIENTE: a.corriente,
        VENCIDO: a.vencido,
        NUM_CLIENTES: a.clientes.size,
        NUM_DOCS: a.docs,
        NUM_DOCUMENTOS: a.docs,
        DIAS_CREDITO: diasFromCond(cond),
      };
    }));
  } catch (e) { return wrapError(res, e, 'cxc/por-condicion'); }
});

app.get('/api/cxc/historial-pagos', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // Firebird engine — degradar a [] si upstream falla.
    const rows = await api.runQuery(unidad, 'cobros_detalle_mes', { anio, mes })
      .catch((err) => {
        console.warn(`[cxc/historial-pagos] upstream failed: ${err.message}`);
        return [];
      });
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
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
    ];
    if (!omitCxc) queries.push(api.runQuery(unidad, 'cxc_saldo_total', {}));

    const [mesRows, diaRows, cotis, cmp, scoreRows, saldo] = await Promise.all(queries);
    const mesRow = mesRows[0] || {};
    const hoyStr = new Date().toISOString().slice(0, 10);
    const hoyRow = (diaRows || []).find(r => String(r.dia).startsWith(hoyStr)) || {};
    // Cotizaciones: separar total del mes y de hoy (director.html consume
    // COTIZACIONES_MES / COTIZACIONES_HOY / IMPORTE_COTI_MES / IMPORTE_COTI_HOY).
    const cotiTotal = cotis.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    const cotisHoy = cotis.filter(r => String(r.FECHA || '').startsWith(hoyStr));
    const cotiImporteHoy = cotisHoy.reduce((s, r) => s + num(r.importe_sin_iva), 0);
    const cmpRow = (cmp || [])[0] || {};
    const scoreRow = (scoreRows || [])[0] || {};

    // ventas_comparativo sólo devuelve { anio_actual, mes, total_actual,
    // total_anterior } — total_anterior es MISMO MES DEL AÑO ANTERIOR por
    // definición de la query (ver queries-catalogo.md). El mes anterior
    // consecutivo viene de scorecard.ventas_mes_anterior.
    const anioAnterior = num(
      cmpRow.total_anterior || cmpRow.total_anio_anterior || cmpRow.anio_anterior,
    );
    const mesAnterior = num(
      scoreRow.ventas_mes_anterior || cmpRow.total_mes_anterior || cmpRow.mes_anterior,
    );

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
        MES_ANTERIOR: mesAnterior,
        ANIO_ANTERIOR: anioAnterior,
      },
      cotizaciones: {
        NUM: cotis.length,
        IMPORTE: cotiTotal,
        // Canonical fields que director.html consume
        COTIZACIONES_MES: cotis.length,
        COTIZACIONES_HOY: cotisHoy.length,
        COTI_MES: cotis.length,
        COTI_HOY: cotisHoy.length,
        IMPORTE_COTI_MES: cotiTotal,
        IMPORTE_COTI_HOY: cotiImporteHoy,
        NUM_COTIZACIONES: cotis.length,
        MES_ACTUAL: cotiTotal,
        HOY: cotiImporteHoy,
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
    // margen_por_vendedor sólo trae { vendedor, num_docs, venta_bruta,
    // costo_total, utilidad, margen_pct } — no hay VENDEDOR_ID, así que el
    // match tiene que ser por nombre normalizado.
    const normName = (s) => String(s || '').trim().toUpperCase();
    const margenByName = new Map();
    for (const m of (margen || [])) {
      const k = normName(m.vendedor || m.VENDEDOR);
      if (k) margenByName.set(k, m);
    }
    res.json(ventas.map(v => {
      const m = margenByName.get(normName(v.vendedor)) || {};
      const ventasMonto = num(v.total_ventas);
      const numDocs = num(v.num_docs);
      return {
        VENDEDOR_ID: v.VENDEDOR_ID,
        VENDEDOR: v.vendedor,
        NOMBRE: v.vendedor,
        VENTAS: ventasMonto,
        VENTAS_MES: ventasMonto,       // alias que director.html usa para ordenar
        TOTAL_VENTAS: ventasMonto,     // alias defensivo adicional
        NUM_DOCS: numDocs,
        FACTURAS: numDocs,
        DOCS: numDocs,
        COSTO: num(m.costo_total || m.costo || m.COSTO),
        MARGEN: num(m.utilidad || m.margen || m.MARGEN),
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
    res.json(rows.map(r => {
      const ventas = num(r.total_ventas);
      const docs = num(r.num_docs);
      return {
        CLIENTE_ID: r.CLIENTE_ID,
        CLIENTE: r.cliente,
        NOMBRE: r.cliente,
        VENTAS: ventas,
        TOTAL_VENTAS: ventas,    // director.html lee r.TOTAL_VENTAS / r.TOTAL / r.IMPORTE_NETO
        TOTAL: ventas,
        IMPORTE_NETO: ventas,
        NUM_DOCS: docs,
        NUM_FACTURAS: docs,      // director.html lee r.NUM_FACTURAS / r.FACTURAS / r.DOCS
        FACTURAS: docs,
        DOCS: docs,
      };
    }));
  } catch (e) { return wrapError(res, e, 'director/top-clientes'); }
});

app.get('/api/director/recientes', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    const limite = Number(req.query.limit) || 15;
    // El catálogo externo NO tiene una query de "facturas recientes" a nivel
    // documento (no existe `ventas_facturas_recientes`). Mostramos top-clientes
    // del mes con el shape que director.html espera: {FOLIO, TIPO_SRC, CLIENTE,
    // VENDEDOR, TOTAL, FECHA}. De esa forma la tarjeta "Movimientos recientes"
    // queda con info útil (quién está comprando más este mes) aunque no sea
    // factura-por-factura.
    const [topClientes, ventasDia] = await Promise.all([
      api.runQuery(unidad, 'ventas_top_clientes', { anio, mes, limite }).catch(() => []),
      api.runQuery(unidad, 'ventas_diarias', { anio, mes }).catch(() => []),
    ]);
    const ultimaFecha = (ventasDia.length && ventasDia[ventasDia.length - 1].dia) || null;
    const rows = (topClientes || []).slice(0, limite).map((r) => ({
      FOLIO: '—',
      TIPO_SRC: 'VE',
      CLIENTE: r.cliente,
      VENDEDOR: '—',
      TOTAL: num(r.total_ventas),
      FECHA: ultimaFecha,
    }));
    res.json(rows);
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
    // clientes_riesgo trae frecuencia de compra (CLIENTE_ID, cliente,
    // compras_periodo_anterior, compras_periodo_reciente) — no trae niveles
    // ni montos. Para el dashboard de riesgo agregamos el vencimiento real
    // desde cxc_vencida_detalle y clasificamos por días de atraso, que es lo
    // que los usuarios realmente quieren ver en las tarjetas CRITICO/ALTO/…
    const [riesgoRows, vencidas] = await Promise.all([
      api.runQuery(unidad, 'clientes_riesgo', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 }).catch(() => []),
    ]);

    // Agregar cartera vencida por cliente
    const porCliente = new Map();
    for (const v of vencidas) {
      const key = String(v.cliente || '').trim().toUpperCase();
      if (!key) continue;
      const dias = num(v.dias_vencido);
      if (dias <= 0) continue;
      const saldo = num(v.saldo_venc);
      const imp = saldo > 0.01 ? saldo : num(v.importe_cargo);
      if (imp <= 0) continue;
      const curr = porCliente.get(key) || { cliente: v.cliente, MAX_DIAS: 0, MONTO: 0, DOCS: 0 };
      if (dias > curr.MAX_DIAS) curr.MAX_DIAS = dias;
      curr.MONTO += imp;
      curr.DOCS += 1;
      porCliente.set(key, curr);
    }

    const acc = {
      CRITICO: { n: 0, m: 0 },
      ALTO: { n: 0, m: 0 },
      MEDIO: { n: 0, m: 0 },
      LEVE: { n: 0, m: 0 },
    };
    const clientesClasificados = [];
    for (const c of porCliente.values()) {
      let nivel;
      if (c.MAX_DIAS > 90) nivel = 'CRITICO';
      else if (c.MAX_DIAS > 60) nivel = 'ALTO';
      else if (c.MAX_DIAS > 30) nivel = 'MEDIO';
      else nivel = 'LEVE';
      acc[nivel].n += 1;
      acc[nivel].m += c.MONTO;
      clientesClasificados.push({
        cliente: c.cliente,
        nivel_riesgo: nivel,
        max_dias_vencido: c.MAX_DIAS,
        monto_vencido: Math.round(c.MONTO * 100) / 100,
        num_docs: c.DOCS,
      });
    }
    clientesClasificados.sort((a, b) => b.monto_vencido - a.monto_vencido);

    const resumen = {
      NUM_RIESGO: clientesClasificados.length || riesgoRows.length,
      TOTAL_VENTA_HISTORICA: 0, // no disponible en la API actual
      NUM_CRITICO: acc.CRITICO.n, MONTO_CRITICO: Math.round(acc.CRITICO.m * 100) / 100,
      NUM_ALTO: acc.ALTO.n,       MONTO_ALTO: Math.round(acc.ALTO.m * 100) / 100,
      NUM_MEDIO: acc.MEDIO.n,     MONTO_MEDIO: Math.round(acc.MEDIO.m * 100) / 100,
      NUM_LEVE: acc.LEVE.n,       MONTO_LEVE: Math.round(acc.LEVE.m * 100) / 100,
      TOTAL_EN_RIESGO: Math.round((acc.CRITICO.m + acc.ALTO.m + acc.MEDIO.m + acc.LEVE.m) * 100) / 100,
    };
    res.json({
      ok: true,
      resumen,
      clientes: clientesClasificados.slice(0, 50),
      clientes_frecuencia: riesgoRows.slice(0, 50), // original clientes_riesgo para compat
    });
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
    // El catálogo externo NO tiene `clientes_inteligencia_ventas`. Construimos
    // el dataset de inteligencia cruzando `clientes_nuevos_perdidos` (status +
    // histórico de compras) con `cxc_vencida_detalle` (máx días vencido,
    // monto vencido por cliente) para derivar NIVEL_RIESGO localmente.
    const [nuevosPerdidos, vencidas] = await Promise.all([
      api.runQuery(unidad, 'clientes_nuevos_perdidos', { limite }).catch(() => []),
      api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 }).catch(() => []),
    ]);

    const porCliente = new Map();
    for (const v of vencidas) {
      const key = String(v.cliente || '').trim().toUpperCase();
      if (!key) continue;
      const dias = num(v.dias_vencido);
      const saldo = num(v.saldo_venc);
      const monto = num(v.importe_cargo);
      const curr = porCliente.get(key) || { MAX_DIAS_VENCIDO: 0, MONTO_VENCIDO: 0, NUM_DOCS_VENC: 0 };
      if (dias > curr.MAX_DIAS_VENCIDO) curr.MAX_DIAS_VENCIDO = dias;
      if (saldo > 0.01) curr.MONTO_VENCIDO += saldo;
      else if (monto > 0 && dias > 0) curr.MONTO_VENCIDO += monto;
      if (dias > 0) curr.NUM_DOCS_VENC += 1;
      porCliente.set(key, curr);
    }

    const nivelRiesgo = (row) => {
      const d = row.MAX_DIAS_VENCIDO;
      if (d > 90) return 'CRITICO';
      if (d > 60) return 'ALTO';
      if (d > 30) return 'MEDIO';
      if (d > 0)  return 'LEVE';
      if (row.STATUS && /PERDIDO/i.test(row.STATUS)) return 'MEDIO';
      return 'OK';
    };

    const enriched = nuevosPerdidos.map((r) => {
      const key = String(r.cliente || '').trim().toUpperCase();
      const v = porCliente.get(key) || { MAX_DIAS_VENCIDO: 0, MONTO_VENCIDO: 0, NUM_DOCS_VENC: 0 };
      const numDocs = Math.max(1, num(r.total_docs) || 1);
      const out = {
        CLIENTE: r.cliente,
        STATUS: r.status,
        PRIMERA_COMPRA: r.primera_compra,
        ULTIMA_COMPRA: r.ultima_compra,
        NUM_COMPRAS_VIDA: num(r.total_docs),
        TOTAL_VENTA: num(r.total_venta),
        ULTIMA_COMPRA_IMPORTE: Math.round((num(r.total_venta) / numDocs) * 100) / 100,
        DIAS_SIN_COMPRA: num(r.dias_sin_compra),
        MAX_DIAS_VENCIDO: v.MAX_DIAS_VENCIDO,
        MONTO_VENCIDO: Math.round(v.MONTO_VENCIDO * 100) / 100,
        NUM_DOCS_VENC: v.NUM_DOCS_VENC,
      };
      out.NIVEL_RIESGO = nivelRiesgo(out);
      return out;
    });

    // clientes.html hace `Array.isArray(riesgo) ? riesgo : []` — devolver
    // directamente el array para que la tabla de riesgo se llene.
    res.json(enriched);
  } catch (e) { return wrapError(res, e, 'clientes/inteligencia'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVENTARIO
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/inv/resumen', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    // inventario_resumen_marca = { linea, total_arts, existencia_total,
    // valor_total, pct_arts, pct_valor, valor_prom_por_art }.
    // Para los KPI "bajo mínimo" y "sin stock" necesitamos queries aparte —
    // las hacemos en paralelo y degradamos a 0 si fallan.
    const [rows, bajoMin, topStock] = await Promise.all([
      api.runQuery(unidad, 'inventario_resumen_marca', {}),
      api.runQuery(unidad, 'inv_bajo_minimo', { limite: 5000 }).catch(() => []),
      api.runQuery(unidad, 'inv_top_stock', { limite: 5000 }).catch(() => []),
    ]);
    const valorInventario = rows.reduce((s, r) => s + num(r.valor_total), 0);
    const totalArts = rows.reduce((s, r) => s + num(r.total_arts), 0);
    const existenciaUnidades = rows.reduce((s, r) => s + num(r.existencia_total), 0);
    // "Sin stock" = artículos con stock 0 en inv_top_stock. Si la query trae
    // sólo los top-N no sabemos cuántos hay con stock 0 — usamos el dataset
    // amplio (5000) como aproximación, y si viene corto reportamos lo que hay.
    const sinStock = topStock.filter(r => num(r.stock) <= 0).length;
    res.json({
      ok: true,
      // Canonical names expected by inventario.html
      VALOR_INVENTARIO: valorInventario,
      VALOR_TOTAL: valorInventario, // alias
      TOTAL_ARTICULOS: totalArts,
      EXISTENCIA_UNIDADES_SUM: existenciaUnidades,
      BAJO_MINIMO: bajoMin.length,
      SIN_STOCK: sinStock,
      VALOR_CRITERIO: 'costo_unitario × existencia',
      LINEAS: rows,
    });
  } catch (e) { return wrapError(res, e, 'inv/resumen'); }
});

app.get('/api/inv/top-stock', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const rows = await api.runQuery(unidad, 'inv_top_stock', { limite });
    // inv_top_stock upstream devuelve {ARTICULO_ID, articulo, CLAVE_ARTICULO,
    // stock, costo_unitario, valor_inventario}. El frontend lee DESCRIPCION /
    // UNIDAD / EXISTENCIA / PRECIO_VENTA / VALOR_TOTAL.
    res.json(rows.map(r => ({
      ARTICULO_ID: r.ARTICULO_ID,
      CLAVE_ARTICULO: r.CLAVE_ARTICULO,
      DESCRIPCION: r.articulo || r.DESCRIPCION,
      UNIDAD: r.UNIDAD || r.unidad || '',
      EXISTENCIA: num(r.stock),
      PRECIO_VENTA: num(r.precio_venta || r.costo_unitario),
      COSTO_UNITARIO: num(r.costo_unitario),
      VALOR_TOTAL: num(r.valor_inventario),
    })));
  } catch (e) { return wrapError(res, e, 'inv/top-stock'); }
});

app.get('/api/inv/bajo-minimo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    const rows = await api.runQuery(unidad, 'inv_bajo_minimo', { limite }).catch(() => []);
    // inv_bajo_minimo upstream devuelve {ARTICULO_ID, articulo, stock_actual}.
    // El frontend de inventario.html necesita DESCRIPCION / UNIDAD /
    // EXISTENCIA / EXISTENCIA_MINIMA / FALTANTE. Como el API no expone
    // EXISTENCIA_MINIMA, forzamos 0 y calculamos FALTANTE = -stock si stock<0
    // (la query ya filtra por "bajo mínimo" upstream, así que todos los rows
    // están bajo su umbral por definición).
    res.json(rows.map(r => {
      const stock = num(r.stock_actual);
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        DESCRIPCION: r.articulo || r.DESCRIPCION,
        UNIDAD: r.UNIDAD || '',
        EXISTENCIA: stock,
        EXISTENCIA_MINIMA: num(r.existencia_minima, 0),
        FALTANTE: stock < 0 ? Math.abs(stock) : 0,
      };
    }));
  } catch (e) { return wrapError(res, e, 'inv/bajo-minimo'); }
});

app.get('/api/inv/sin-movimiento', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const dias = Number(req.query.dias) || 180;
    const limite = Number(req.query.limit) || 60;
    // inv_sin_movimiento sólo devuelve {ARTICULO_ID, articulo}. Cruzamos con
    // inventario_articulos_detalle para enriquecer con existencia/valor si
    // aparece el artículo (máx 3k artículos, match por descripción).
    const [rows, detalle] = await Promise.all([
      api.runQuery(unidad, 'inv_sin_movimiento', { dias, limite }).catch(() => []),
      api.runQuery(unidad, 'inventario_articulos_detalle', { limite: 5000 }).catch(() => []),
    ]);
    const detByDesc = new Map();
    for (const d of (detalle || [])) {
      const key = String(d.descripcion || '').trim().toUpperCase();
      if (key) detByDesc.set(key, d);
    }
    res.json(rows.map(r => {
      const key = String(r.articulo || '').trim().toUpperCase();
      const d = detByDesc.get(key) || {};
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        DESCRIPCION: r.articulo || r.DESCRIPCION || '',
        UNIDAD: r.UNIDAD || '',
        EXISTENCIA: num(d.existencia),
        VALOR_INVENTARIO: num(d.valor),
        LINEA: d.linea || '',
        MESES_SIN_VENTA: num(d.meses_sin_venta),
        ROTACION_LABEL: d.rotacion_label || '',
        DIAS_SIN_VENTA: dias,
      };
    }));
  } catch (e) { return wrapError(res, e, 'inv/sin-movimiento'); }
});

app.get('/api/inv/consumo-semanal', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 30;
    const dias = Number(req.query.dias) || 90;
    const [rows, topStock] = await Promise.all([
      api.runQuery(unidad, 'consumo_semanal', { dias, limite }).catch(() => []),
      api.runQuery(unidad, 'inv_top_stock', { limite: 5000 }).catch(() => []),
    ]);
    // consumo_semanal trae sem_1..sem_12 (12 semanas). Calculamos
    // CONSUMO_SEMANAL_PROM como promedio de esas 12 semanas y
    // SEMANAS_STOCK = EXISTENCIA / CONSUMO_SEMANAL_PROM, cruzando con
    // inv_top_stock por CLAVE_ARTICULO para obtener el stock actual.
    const stockByClave = new Map();
    for (const s of (topStock || [])) {
      const k = String(s.CLAVE_ARTICULO || '').trim();
      if (k) stockByClave.set(k, num(s.stock));
    }
    const out = rows.map((r) => {
      const semanas = [];
      for (let i = 1; i <= 12; i++) {
        const v = r[`sem_${i}`];
        if (v != null) semanas.push(num(v));
      }
      const prom = semanas.length
        ? semanas.reduce((s, v) => s + v, 0) / semanas.length
        : 0;
      const existencia = stockByClave.get(String(r.CLAVE_ARTICULO || '').trim()) || 0;
      const semStock = prom > 0 ? (existencia / prom) : 9999;
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        CLAVE_ARTICULO: r.CLAVE_ARTICULO,
        DESCRIPCION: r.articulo,
        EXISTENCIA: existencia,
        UNIDADES_TOTAL: num(r.unidades_total),
        VENTA_TOTAL: num(r.venta_total),
        CONSUMO_SEMANAL_PROM: Math.round(prom * 100) / 100,
        SEMANAS_STOCK: Math.round(semStock * 10) / 10,
        sem_actual: num(r.sem_actual),
      };
    });
    res.json(out);
  } catch (e) { return wrapError(res, e, 'inv/consumo-semanal'); }
});

app.get('/api/inv/consumo', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 50;
    const lead = Number(req.query.lead) || 15; // días de lead time default
    const [rows, topStock] = await Promise.all([
      api.runQuery(unidad, 'consumo_semanal', { limite }).catch(() => []),
      api.runQuery(unidad, 'inv_top_stock', { limite: 5000 }).catch(() => []),
    ]);
    const stockByClave = new Map();
    for (const s of (topStock || [])) {
      const k = String(s.CLAVE_ARTICULO || '').trim();
      if (k) stockByClave.set(k, num(s.stock));
    }
    // Calcular consumo_diario_promedio (sumar sem_1..sem_12 / (12*7)) y
    // stock_para_lead = consumo_diario * lead. Útil para tablas de reorden.
    const out = rows.map((r) => {
      let total = 0;
      for (let i = 1; i <= 12; i++) total += num(r[`sem_${i}`]);
      const diario = total / (12 * 7);
      const existencia = stockByClave.get(String(r.CLAVE_ARTICULO || '').trim()) || 0;
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        CLAVE_ARTICULO: r.CLAVE_ARTICULO,
        DESCRIPCION: r.articulo,
        EXISTENCIA: existencia,
        UNIDADES_TOTAL: num(r.unidades_total),
        CONSUMO_DIARIO_PROM: Math.round(diario * 100) / 100,
        CONSUMO_LEAD: Math.round(diario * lead * 100) / 100,
        DIAS_STOCK: diario > 0 ? Math.round((existencia / diario) * 10) / 10 : 9999,
      };
    });
    res.json(out);
  } catch (e) { return wrapError(res, e, 'inv/consumo'); }
});

app.get('/api/inv/operacion-critica', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const limite = Number(req.query.limit) || 120;
    const [bajos, sinMov, detalle] = await Promise.all([
      api.runQuery(unidad, 'inv_bajo_minimo', { limite: Math.ceil(limite / 2) }).catch(() => []),
      api.runQuery(unidad, 'inv_sin_movimiento', { dias: 180, limite: Math.ceil(limite / 2) }).catch(() => []),
      api.runQuery(unidad, 'inventario_articulos_detalle', { limite: 5000 }).catch(() => []),
    ]);
    const detByDesc = new Map();
    for (const d of (detalle || [])) {
      const k = String(d.descripcion || '').trim().toUpperCase();
      if (k) detByDesc.set(k, d);
    }
    const bajoMap = bajos.map((r) => {
      const stock = num(r.stock_actual);
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        DESCRIPCION: r.articulo,
        UNIDAD: '',
        EXISTENCIA: stock,
        EXISTENCIA_MINIMA: 0,
        FALTANTE: stock < 0 ? Math.abs(stock) : 0,
      };
    });
    const sinMovMap = sinMov.map((r) => {
      const d = detByDesc.get(String(r.articulo || '').trim().toUpperCase()) || {};
      return {
        ARTICULO_ID: r.ARTICULO_ID,
        DESCRIPCION: r.articulo,
        EXISTENCIA: num(d.existencia),
        VALOR_INVENTARIO: num(d.valor),
        MESES_SIN_VENTA: num(d.meses_sin_venta),
      };
    });
    res.json({
      ok: true,
      bajo_minimo: bajoMap,
      sin_movimiento: sinMovMap,
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

// Normaliza una fila de `pnl_resumen` / `pnl_operativo` / `ventas_resumen_mes`
// al shape que `public/resultados.html` espera:
//   { ANIO, MES, VENTAS_BRUTAS, VENTAS_NETAS, VENTAS_VE, VENTAS_PV,
//     COSTO_VENTAS, UTILIDAD_BRUTA, MARGEN_BRUTO_PCT, COBROS, NUM_FACTURAS,
//     CO_A1..CO_C6 }. Las columnas upstream pueden venir en minúsculas
// snake_case o ya en mayúsculas; aceptamos ambas.
function _pickNum(row, ...keys) {
  if (!row) return 0;
  for (const k of keys) {
    if (row[k] != null) {
      const n = Number(row[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}
function pnlRowNormalizar(r, anio, mes) {
  r = r || {};
  // pnl_operativo devuelve: ingreso_ve, ingreso_pv, ingreso_total,
  //                         costo_ve, costo_pv, costo_total,
  //                         utilidad_bruta, margen_bruto_pct
  // ventas_resumen_mes devuelve: total_ve, total_pv, total_general,
  //                              num_facturas, costo_total, utilidad_bruta,
  //                              margen_bruto_pct
  const ventasVe = _pickNum(r, 'VENTAS_VE', 'ventas_ve', 'ingreso_ve', 'total_ve');
  const ventasPv = _pickNum(r, 'VENTAS_PV', 'ventas_pv', 'ingreso_pv', 'total_pv');
  const ventasNetas = _pickNum(r,
    'VENTAS_NETAS', 'ventas_netas',
    'ingreso_total', 'total_general', 'total_ventas_netas', 'VENTAS_NETAS_DOCS',
  ) || (ventasVe + ventasPv);
  const ventasBrutas = _pickNum(r,
    'VENTAS_BRUTAS', 'ventas_brutas', 'total_bruto',
  ) || (ventasNetas + _pickNum(r, 'DESCUENTOS_DEV', 'descuentos_dev', 'descuentos'));
  const costo = _pickNum(r,
    'COSTO_VENTAS', 'costo_ventas', 'costo_total', 'costo',
  );
  const utilBruta = _pickNum(r, 'UTILIDAD_BRUTA', 'utilidad_bruta') ||
    (costo > 0 ? Math.round((ventasNetas - costo) * 100) / 100 : 0);
  const margenPct = _pickNum(r, 'MARGEN_BRUTO_PCT', 'margen_bruto_pct') ||
    (ventasNetas > 0 ? Math.round((utilBruta / ventasNetas) * 1000) / 10 : 0);
  const cobros = _pickNum(r, 'COBROS', 'cobros', 'total_cobrado');
  const numFact = _pickNum(r, 'NUM_FACTURAS', 'num_facturas', 'facturas', 'num_docs');

  const out = {
    ANIO: _pickNum(r, 'ANIO', 'anio') || anio,
    MES: _pickNum(r, 'MES', 'mes') || mes,
    VENTAS_BRUTAS: ventasBrutas,
    DESCUENTOS_DEV: _pickNum(r, 'DESCUENTOS_DEV', 'descuentos_dev', 'descuentos'),
    VENTAS_NETAS: ventasNetas,
    VENTAS_VE: ventasVe,
    VENTAS_PV: ventasPv,
    COSTO_VENTAS: costo,
    UTILIDAD_BRUTA: utilBruta,
    MARGEN_BRUTO_PCT: margenPct,
    COBROS: cobros,
    NUM_FACTURAS: numFact,
  };
  for (const k of ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6',
                   'CO_B1','CO_B2','CO_B3','CO_B4','CO_B5',
                   'CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6']) {
    out[k] = _pickNum(r, k, k.toLowerCase());
  }
  return out;
}

function pnlTotalesDesdeMeses(meses) {
  const KEYS_NUM = ['VENTAS_BRUTAS','DESCUENTOS_DEV','VENTAS_NETAS','VENTAS_VE','VENTAS_PV','COSTO_VENTAS','UTILIDAD_BRUTA','COBROS','NUM_FACTURAS',
    'CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6','CO_B1','CO_B2','CO_B3','CO_B4','CO_B5','CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6'];
  const tot = {};
  for (const k of KEYS_NUM) tot[k] = 0;
  for (const m of (meses || [])) {
    for (const k of KEYS_NUM) tot[k] += _pickNum(m, k);
  }
  tot.MARGEN_BRUTO_PCT = tot.VENTAS_NETAS > 0
    ? Math.round((tot.UTILIDAD_BRUTA / tot.VENTAS_NETAS) * 1000) / 10 : 0;
  return tot;
}

/**
 * Dado anio/mes o meses=N o desde/hasta, resuelve la lista de {anio, mes}
 * que hay que consultar al catálogo. Si el usuario fijó mes único, devuelve
 * solo ese; si pidió meses=6, devuelve los últimos 6 terminando en el mes
 * actual (o el pedido si viene con anio+mes).
 */
function resolverVentanaMeses(req) {
  const now = new Date();
  const anioQ = Number(req.query.anio || req.query.year || 0);
  const mesQ  = Number(req.query.mes || req.query.month || 0);
  const mesesN = Math.max(1, Math.min(24, Number(req.query.meses || 0) || 0));
  const desde = String(req.query.desde || '').trim();
  const hasta = String(req.query.hasta || '').trim();

  const out = [];
  if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde) && hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    const dA = new Date(desde + 'T00:00:00');
    const dB = new Date(hasta + 'T00:00:00');
    if (!isNaN(dA) && !isNaN(dB) && dA <= dB) {
      const cur = new Date(dA.getFullYear(), dA.getMonth(), 1);
      const end = new Date(dB.getFullYear(), dB.getMonth(), 1);
      while (cur <= end) {
        out.push({ anio: cur.getFullYear(), mes: cur.getMonth() + 1 });
        cur.setMonth(cur.getMonth() + 1);
      }
      return out;
    }
  }

  if (anioQ && !mesQ && mesesN === 0) {
    // ?anio=2026 solo → los 12 meses del año, acotados a mes actual si anio=actual
    const topMes = (anioQ === now.getFullYear()) ? (now.getMonth() + 1) : 12;
    for (let m = 1; m <= topMes; m++) out.push({ anio: anioQ, mes: m });
    return out;
  }

  if (anioQ && mesQ) return [{ anio: anioQ, mes: mesQ }];

  if (mesesN) {
    const baseY = anioQ || now.getFullYear();
    const baseM = mesQ || (now.getMonth() + 1);
    const startDate = new Date(baseY, baseM - 1 - (mesesN - 1), 1);
    for (let i = 0; i < mesesN; i++) {
      const d = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
      out.push({ anio: d.getFullYear(), mes: d.getMonth() + 1 });
    }
    return out;
  }

  // Default: mes actual
  return [{ anio: now.getFullYear(), mes: now.getMonth() + 1 }];
}

/**
 * Construye el payload P&L a partir del catálogo externo. Intenta primero
 * `pnl_resumen` + `pnl_operativo`; si alguno no existe o devuelve vacío,
 * rellena con `ventas_resumen_mes` y gastos via `gastos_detalle` para que
 * la UI no quede en ceros.
 */
async function construirPnlPayload(unidad, ventana) {
  const meses = [];
  let tieneGastosCoAny = false;
  const gastosRangos = {};
  const subconceptos = {};
  const prefijos_labels = {
    CO_A1: 'Total gastos de venta',
    CO_A2: 'Total gastos de operación',
    CO_A3: 'Total gastos de administración',
    CO_B1: 'Gastos financieros',
    CO_C1: 'Otros gastos (partidas extraordinarias)',
  };

  for (const { anio, mes } of ventana) {
    // Traemos en paralelo las 3 vistas que pueden alimentar el mes.
    const [pnlResumen, pnlOp, ventasMes, gastos] = await Promise.all([
      api.runQuery(unidad, 'pnl_resumen', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'pnl_operativo', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'ventas_resumen_mes', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'gastos_detalle', { anio, mes }).catch(() => []),
    ]);

    // Merge: arranca de ventas_resumen_mes (que sabemos existe), luego
    // superpone lo que venga de pnl_resumen/pnl_operativo.
    const baseRow = (Array.isArray(ventasMes) && ventasMes[0]) || {};
    const resumenRow = (Array.isArray(pnlResumen) && pnlResumen[0]) || {};
    const opRow = (Array.isArray(pnlOp) && pnlOp[0]) || {};
    const merged = { ...baseRow, ...resumenRow, ...opRow };
    const row = pnlRowNormalizar(merged, anio, mes);

    // Gastos CO_*: intenta primero columnas directas de pnl_*; si todas son
    // cero, clasifica `gastos_detalle` por CUENTA_PT.
    const sumDirect = ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6',
      'CO_B1','CO_B2','CO_B3','CO_B4','CO_B5',
      'CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6']
      .reduce((s, k) => s + (row[k] || 0), 0);

    if (sumDirect < 0.01 && Array.isArray(gastos) && gastos.length) {
      // gastos_detalle es en realidad el mayor contable: trae TODAS las cuentas
      // con su saldo_neto del mes. Filtramos sólo las cuentas de gastos
      // (operativos, financieros, extraordinarios) y las clasificamos por el
      // nombre de la cuenta para poblar los buckets CO_A*/B*/C*.
      const clasificarPorNombre = (nombre) => {
        const n = String(nombre || '').toUpperCase();
        // Excluir cuentas de balance / ingresos / impuestos
        if (/^PROVEEDORES|^CLIENTES|^BANREGIO|^BANCO|^ALMACEN|^IVA|^ISR|^COSTO DE VENTAS|^VENTAS|^DEVOLUC|^CAJA|^INVERSION/.test(n)) return null;
        if (/SALARIO|SUELDO|NOMINA|HONORARIO|COMISION(?!ES BANCARIA)|BONO|VACACION|AGUINALDO|PTU|IMSS|INFONAVIT|AFORE|PREST.* SOCIAL|GRATIFICAC|INCENTIVO|FINIQUITO/.test(n)) return 'CO_A3'; // personal
        if (/PUBLICIDAD|PROPAGANDA|PROMOC|MERCADOTECNIA|MARKETING|EVENTO|EXHIBIC/.test(n)) return 'CO_A1'; // ventas
        if (/FLETE|ENVIO|PAQUETE|TRANSPORT|MENSAJERIA|AUTOPISTA|GASOLIN|COMBUSTIBLE/.test(n)) return 'CO_A2'; // distrib/operacion
        if (/RENT|ARRENDAMIENTO|MANTEN|LIMPIEZA|UNIFORME|AGUA|LUZ|TELEFONO|INTERNET|SERVICIO.*PUBLIC/.test(n)) return 'CO_A2'; // operación
        if (/PAPELER|OFICIN|LEGAL|CONTABLE|AUDITOR|ASESOR|CAPACITAC|VIATIC|VIAJE|HOSPED/.test(n)) return 'CO_A3'; // admin
        if (/SEGURO|FIANZA|IMPUEST|DERECHO|MULTAS|RECARG/.test(n)) return 'CO_A3';
        if (/COMISION.*BANCAR|INTERES|FINANC|CAMBIARI|CREDIT/.test(n)) return 'CO_B1'; // financieros
        if (/DEPRECIAC|AMORTIZAC|EXTRAORD|OTROS GASTOS/.test(n)) return 'CO_C1';
        if (/GASTOS VARIOS|VARIOS/.test(n)) return 'CO_A1'; // cajón genérico
        return null;
      };

      for (const g of gastos) {
        const cuenta_id = g.CUENTA_ID || g.cuenta_id;
        const nombre = g.nombre_cuenta || g.NOMBRE_CUENTA || g.NOMBRE || g.nombre || g.concepto || '';
        // saldo_neto = cargos - abonos (positivo = gasto, negativo = ingreso/balance)
        const saldo = _pickNum(g, 'saldo_neto', 'SALDO_NETO', 'saldo', 'SALDO', 'IMPORTE', 'importe', 'IMP', 'imp', 'MONTO', 'monto', 'TOTAL', 'total');
        if (!nombre || saldo <= 0) continue;
        const bucket = clasificarPorNombre(nombre);
        if (!bucket) continue;
        row[bucket] = (row[bucket] || 0) + saldo;

        const etiqueta = nombre;
        if (!subconceptos[bucket]) subconceptos[bucket] = {};
        const mkey = `${anio}-${String(mes).padStart(2, '0')}`;
        if (!subconceptos[bucket][etiqueta]) subconceptos[bucket][etiqueta] = { etiqueta, total: 0, meses: {} };
        subconceptos[bucket][etiqueta].total += saldo;
        subconceptos[bucket][etiqueta].meses[mkey] = (subconceptos[bucket][etiqueta].meses[mkey] || 0) + saldo;
      }
    }

    // Recalcula margen bruto por si costo/ventas cambiaron con el merge
    if (row.VENTAS_NETAS > 0) {
      row.MARGEN_BRUTO_PCT = Math.round((row.UTILIDAD_BRUTA / row.VENTAS_NETAS) * 1000) / 10;
    }

    // ¿tiene gastos operativos en este mes?
    const sumGastos = ['CO_A1','CO_A2','CO_A3','CO_A4','CO_A5','CO_A6',
      'CO_B1','CO_B2','CO_B3','CO_B4','CO_B5',
      'CO_C1','CO_C2','CO_C3','CO_C4','CO_C5','CO_C6']
      .reduce((s, k) => s + (row[k] || 0), 0);
    if (sumGastos > 0.01) tieneGastosCoAny = true;

    gastosRangos[`${anio}-${String(mes).padStart(2, '0')}`] = sumGastos;
    meses.push(row);
  }

  // subconceptos: convertir a arrays ordenados por total desc
  const subconceptosOut = {};
  for (const k of Object.keys(subconceptos)) {
    subconceptosOut[k] = Object.values(subconceptos[k])
      .filter(x => (x.total || 0) > 0.005)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
  }

  const totales = pnlTotalesDesdeMeses(meses);
  const tiene_costo = totales.COSTO_VENTAS > 0.01;

  return {
    meses,
    totales,
    tiene_costo,
    tiene_gastos_co: tieneGastosCoAny,
    prefijos_labels,
    subconceptos: subconceptosOut,
    gastos_estimados: false,
    gastos_estimados_desde: null,
  };
}

app.get('/api/resultados/pnl', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const ventana = resolverVentanaMeses(req);
    const payload = await construirPnlPayload(unidad, ventana);
    res.json(payload);
  } catch (e) { return wrapError(res, e, 'resultados/pnl'); }
});

app.get('/api/resultados/balance-general', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);

    // Composición: el API externo expone vistas OPERATIVAS (no el catálogo
    // contable completo). Por eso armamos el Balance General sintético a partir
    // de capital_trabajo + cxc_saldo_total + cxp_saldo_total + desglose de
    // inventario, CxC aging y top proveedores. Los rubros no-circulantes (fijo,
    // diferidos) no están expuestos por el API → se reportan como 0 con nota.
    const [cap, prueba, cxcSaldo, cxpSaldo, invPorMarca, cxcAging, topProv, cxpAging] = await Promise.all([
      api.runQuery(unidad, 'capital_trabajo', {}).catch(() => []),
      api.runQuery(unidad, 'prueba_acida', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_saldo_total', {}).catch(() => []),
      api.runQuery(unidad, 'cxp_saldo_total', {}).catch(() => []),
      api.runQuery(unidad, 'inventario_resumen_marca', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_aging', {}).catch(() => []),
      api.runQuery(unidad, 'cxp_top_proveedores', { limite: 10 }).catch(() => []),
      api.runQuery(unidad, 'cxp_aging', {}).catch(() => []),
    ]);

    const capRow = cap[0] || {};
    const pruebaRow = prueba[0] || {};
    const cxcRow = cxcSaldo[0] || {};
    const cxpRow = cxpSaldo[0] || {};

    // Preferimos saldos explícitos de cxc/cxp_saldo_total; capital_trabajo es fallback.
    const caja = num(capRow.bancos);
    const cxc = num(cxcRow.saldo, num(capRow.cxc));
    const inventario = num(capRow.inventario);
    const activoCirc = caja + cxc + inventario;
    const activoFijoNeto = 0; // no expuesto en API externo
    const cargosDiferidos = 0;
    const otrosActivos = 0;
    const activoTotal = activoCirc + activoFijoNeto + cargosDiferidos + otrosActivos;

    const cxp = num(cxpRow.saldo, num(capRow.cxp));
    const otrosPasivos = 0; // no expuesto
    const pasivoTotal = cxp + otrosPasivos;

    const capitalTotal = Math.round((activoTotal - pasivoTotal) * 100) / 100; // patrimonio implícito
    const diferencia = Math.round(((pasivoTotal + capitalTotal) - activoTotal) * 100) / 100;

    const totales = {
      ACTIVO_TOTAL: activoTotal,
      PASIVO_TOTAL: pasivoTotal,
      CAPITAL_TOTAL: capitalTotal,
      DIFERENCIA_BALANCE: diferencia,
      ACTIVO_CAJA_BANCOS: caja,
      ACTIVO_CXC: cxc,
      ACTIVO_INVENTARIO: inventario,
      ACTIVO_CIRCULANTE: activoCirc,
      ACTIVO_FIJO_NETO: activoFijoNeto,
      CARGOS_DIFERIDOS: cargosDiferidos,
      OTROS_ACTIVOS: otrosActivos,
      RATIO_CIRCULANTE: num(capRow.ratio_circulante),
      CAPITAL_TRABAJO: num(capRow.capital_trabajo, activoCirc - pasivoTotal),
      PRUEBA_ACIDA: num(pruebaRow.prueba_acida),
    };

    // Detalle "activo": mostramos caja, cxc y top-líneas de inventario con estilo Microsip
    // (CUENTA_PT/NOMBRE/SALDO) para que el frontend existente lo pinte sin cambios.
    const activoDetalle = [
      { CUENTA_PT: '11', NOMBRE: 'Caja y bancos', SALDO: caja },
      { CUENTA_PT: '12', NOMBRE: 'Cuentas por cobrar — clientes', SALDO: cxc },
    ];
    const topInvLineas = (Array.isArray(invPorMarca) ? invPorMarca : [])
      .slice()
      .sort((a, b) => num(b.valor_total) - num(a.valor_total))
      .slice(0, 8);
    for (const l of topInvLineas) {
      if (num(l.valor_total) <= 0) continue;
      activoDetalle.push({
        CUENTA_PT: '13',
        NOMBRE: `Inventario — ${l.linea || 'Línea sin clasificar'}`,
        SALDO: num(l.valor_total),
      });
    }

    // Detalle "pasivo": top proveedores (si disponibles) + resumen de aging.
    const pasivoDetalle = [];
    if (Array.isArray(topProv) && topProv.length) {
      for (const p of topProv) {
        const sal = num(p.saldo || p.SALDO);
        if (sal <= 0) continue;
        pasivoDetalle.push({
          CUENTA_PT: '21',
          NOMBRE: `Cuentas por pagar — ${p.proveedor || p.PROVEEDOR || 'Proveedor'}`,
          SALDO: sal,
        });
      }
    }
    if (!pasivoDetalle.length && cxp > 0) {
      pasivoDetalle.push({ CUENTA_PT: '21', NOMBRE: 'Cuentas por pagar — proveedores', SALDO: cxp });
    }

    // Detalle "capital": patrimonio implícito (el API externo no expone cuentas 3*)
    const capitalDetalle = [];
    if (Math.abs(capitalTotal) > 0.01) {
      capitalDetalle.push({
        CUENTA_PT: '3*',
        NOMBRE: 'Patrimonio implícito (Activo − Pasivo; el API externo no expone catálogo contable 3*)',
        SALDO: capitalTotal,
      });
    }

    res.json({
      ok: true,
      unidad,
      fuente: 'suminregio-api (vistas operativas)',
      nota: 'Balance General sintético a partir de capital_trabajo + cxc_saldo_total + cxp_saldo_total + inventario_resumen_marca. Rubros no-circulantes (activo fijo, diferidos) no se exponen en el API externo: se calculan a $0. El patrimonio se reporta como implícito (Activo − Pasivo).',
      totales,
      detalle: {
        activo: activoDetalle,
        pasivo: pasivoDetalle,
        capital: capitalDetalle,
      },
      aging: {
        cxc: cxcAging,
        cxp: cxpAging,
      },
      cierre: { MES: mes, ANIO: anio, balance_ultimo_cierre_disponible: false },
      capital_trabajo: capRow,
      prueba_acida: pruebaRow,
    });
  } catch (e) { return wrapError(res, e, 'resultados/balance-general'); }
});

app.get('/api/resultados/estado-sr', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // Usamos construirPnlPayload para obtener el mismo payload normalizado
    // del P&L y de ahí derivar los campos que el HTML lee (srVentas,
    // srCosto, srBruta, srUai, etc.). Evita divergencias de redondeo.
    const payload = await construirPnlPayload(unidad, [{ anio, mes }]);
    const t = payload.totales || {};
    const gv = t.CO_A1 || 0;
    const go = t.CO_A2 || 0;
    const ga = t.CO_A3 || 0;
    const totOp = gv + go + ga;
    const og = t.CO_C1 || 0;
    const gf = t.CO_B1 || 0;
    const uai = (t.UTILIDAD_BRUTA || 0) - totOp - og - gf;

    // cuentas_muestra: top subconceptos operativos, ya agregados por construirPnlPayload
    const cuentasMuestra = [];
    for (const bucket of ['CO_A1', 'CO_A2', 'CO_A3', 'CO_B1', 'CO_C1']) {
      const subs = (payload.subconceptos && payload.subconceptos[bucket]) || [];
      for (const s of subs) {
        cuentasMuestra.push({
          CUENTA_PT: bucket,
          NOMBRE: s.etiqueta,
          IMP: s.total,
        });
      }
    }

    res.json({
      ok: true,
      periodo: { ANIO: anio, MES: mes },
      estado: {
        ventas_netas: t.VENTAS_NETAS || 0,
        costo_ventas: t.COSTO_VENTAS || 0,
        utilidad_bruta: t.UTILIDAD_BRUTA || 0,
        gastos_venta: gv,
        gastos_operacion: go,
        gastos_administracion: ga,
        total_gastos_operativos: totOp,
        otros_gastos: og,
        gastos_financieros: gf,
        utilidad_antes_impuestos: uai,
      },
      cuentas_muestra: cuentasMuestra,
      // Legacy: campos antiguos por si algún consumidor los usaba
      ingresos: payload.meses[0] || {},
      utilidad_bruta: { utilidad_bruta: t.UTILIDAD_BRUTA || 0 },
      gastos: cuentasMuestra,
    });
  } catch (e) { return wrapError(res, e, 'resultados/estado-sr'); }
});

app.get('/api/resultados/pnl-universe', async (req, res) => {
  try {
    const ventana = resolverVentanaMeses(req);
    const concurrency = Math.max(1, Math.min(6, Number(req.query.concurrency) || 2));

    // Unidades reales (sin "grupo": ese es el consolidado sintético).
    const UNIDADES = ['parker', 'medico', 'maderas', 'empaque', 'agua', 'reciclaje'];

    // Procesar con concurrencia limitada para no saturar upstream (429).
    const empresas = new Array(UNIDADES.length);
    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= UNIDADES.length) return;
        const id = UNIDADES[i];
        try {
          const payload = await construirPnlPayload(id, ventana);
          empresas[i] = {
            ok: true,
            id,
            label: id,
            tiene_costo: payload.tiene_costo,
            tiene_gastos_co: payload.tiene_gastos_co,
            totales: payload.totales,
            meses: payload.meses,
          };
        } catch (err) {
          empresas[i] = {
            ok: false,
            id,
            label: id,
            error: (err && err.message) || 'error',
            totales: {},
            meses: [],
          };
        }
      }
    }
    const workers = [];
    for (let k = 0; k < concurrency; k++) workers.push(worker());
    await Promise.all(workers);

    // Consolidado: suma de las que respondieron ok
    const oks = empresas.filter(e => e && e.ok);
    const mesesByKey = new Map();
    for (const e of oks) {
      for (const m of (e.meses || [])) {
        const k = `${m.ANIO}-${String(m.MES).padStart(2, '0')}`;
        if (!mesesByKey.has(k)) mesesByKey.set(k, { ANIO: m.ANIO, MES: m.MES });
        const agg = mesesByKey.get(k);
        for (const col of Object.keys(m)) {
          if (col === 'ANIO' || col === 'MES' || col === 'MARGEN_BRUTO_PCT') continue;
          agg[col] = (agg[col] || 0) + (Number(m[col]) || 0);
        }
      }
    }
    const consolidadoMeses = Array.from(mesesByKey.values()).sort((a, b) => {
      if (a.ANIO !== b.ANIO) return a.ANIO - b.ANIO;
      return a.MES - b.MES;
    }).map(m => {
      m.MARGEN_BRUTO_PCT = m.VENTAS_NETAS > 0
        ? Math.round((m.UTILIDAD_BRUTA / m.VENTAS_NETAS) * 1000) / 10 : 0;
      return m;
    });
    const consolidado = {
      ...pnlTotalesDesdeMeses(consolidadoMeses),
      tiene_costo: oks.some(e => e.tiene_costo),
      tiene_gastos_co: oks.some(e => e.tiene_gastos_co),
      meses: consolidadoMeses,
    };

    res.json({ empresas, consolidado, concurrency });
  } catch (e) { return wrapError(res, e, 'resultados/pnl-universe'); }
});

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSE / COMPARE / SCORECARD
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/universe/scorecard', async (_req, res) => {
  try {
    const base = await api.runQuery('grupo', 'scorecard', {});
    const rows = Array.isArray(base) ? base : [];

    // Enriquecer en paralelo cada unidad con inventario y CxC vencido.
    // Si alguna query falla individualmente no se cae el endpoint.
    const enriched = await Promise.all(rows.map(async (u) => {
      const id = u._unidad || u.unidad || u.id;
      if (!id) return null;
      const [invRows, agingRows] = await Promise.all([
        api.runQuery(id, 'inventario_resumen_marca', {}).catch(() => []),
        api.runQuery(id, 'cxc_aging', {}).catch(() => []),
      ]);
      const invValor = (invRows || []).reduce((s, r) => s + num(r.valor_total), 0);
      const invArticulos = (invRows || []).reduce((s, r) => s + num(r.total_arts), 0);
      // aging: "0-30" es al corriente; 31+ días = vencido
      const cxcVencido = (agingRows || []).reduce((s, r) => {
        const b = String(r.bucket || r.rango || '').toLowerCase().trim();
        if (!b || b === '0-30' || b === '00-30' || b === 'al_corriente' || b === 'vigente' || b.startsWith('por_vencer')) return s;
        return s + num(r.total_bucket, num(r.saldo));
      }, 0);
      return {
        id,
        label: u._unidad_nombre || u.nombre || id,
        snapshot: true,
        ventas: {
          mes: num(u.ventas_mes_actual),
          hoy: 0, // no expuesto por el query scorecard
          mes_anterior: num(u.ventas_mes_anterior),
          anio_anterior: num(u.ventas_anio_anterior),
        },
        cxc: {
          total: num(u.saldo_cxc),
          vencido: Math.round(cxcVencido * 100) / 100,
        },
        inv: {
          valor: Math.round(invValor * 100) / 100,
          articulos: invArticulos,
        },
        clientes: {
          activos: num(u.clientes_activos),
          total: num(u.clientes_activos), // el API sólo expone activos
        },
      };
    }));
    const items = enriched.filter(Boolean);
    // Shape compatible: array bajo `items` (comparar.html) y `unidades` (legacy).
    res.json({ ok: true, items, unidades: items });
  } catch (e) { return wrapError(res, e, 'universe/scorecard'); }
});

app.get('/api/compare/temporal', async (req, res) => {
  try {
    const unidad = unidadFromReq(req);
    const { anio, mes } = yearMonthFromReq(req);
    // yoy-badges.js pide /api/compare/temporal?metrics=ventas_mes,cxc_total,…
    // y lee data.metrics[nombre] = {actual, mes_pasado, anio_pasado}
    const requested = String(req.query.metrics || req.query.metric || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const wanted = requested.length ? new Set(requested) : new Set(['ventas_mes', 'cxc_total']);

    const [vComp, scoreRows, cxcSaldo] = await Promise.all([
      api.runQuery(unidad, 'ventas_comparativo', { anio, mes }).catch(() => []),
      api.runQuery(unidad, 'scorecard', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_saldo_total', {}).catch(() => []),
    ]);

    const vRow = (vComp || [])[0] || {};
    const sRow = (scoreRows || [])[0] || {};
    const cxcRow = (cxcSaldo || [])[0] || {};

    const ventasActual = num(vRow.total_actual, num(sRow.ventas_mes_actual));
    const ventasMesAnt = num(sRow.ventas_mes_anterior);
    const ventasAnioAnt = num(vRow.total_anterior, num(sRow.ventas_anio_anterior));
    const cxcActual = num(cxcRow.saldo);

    const metrics = {};
    if (wanted.has('ventas_mes')) {
      metrics.ventas_mes = {
        actual: ventasActual,
        mes_pasado: ventasMesAnt || null,
        anio_pasado: ventasAnioAnt || null,
      };
    }
    if (wanted.has('cxc_total')) {
      metrics.cxc_total = {
        actual: cxcActual,
        mes_pasado: null,  // no expuesto en API
        anio_pasado: null, // no expuesto en API
      };
    }

    res.json({
      ok: true,
      metrics,
      rows: vComp,                 // compat con consumidores antiguos
      periodo: { ANIO: anio, MES: mes },
    });
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
    const [cap, saldoCxc, cxpSaldo, invRows, pruebaRows] = await Promise.all([
      api.runQuery(unidad, 'capital_trabajo', {}).catch(() => []),
      api.runQuery(unidad, 'cxc_saldo_total', {}).catch(() => []),
      api.runQuery(unidad, 'cxp_saldo_total', {}).catch(() => []),
      api.runQuery(unidad, 'inventario_resumen_marca', {}).catch(() => []),
      api.runQuery(unidad, 'prueba_acida', {}).catch(() => []),
    ]);
    const capRow = cap[0] || {};
    const pruebaRow = pruebaRows[0] || {};
    const cxc = num((saldoCxc[0] || {}).saldo, num(capRow.cxc));
    const cxp = num((cxpSaldo[0] || {}).saldo, num(capRow.cxp));
    const inventario = num(capRow.inventario) ||
      (Array.isArray(invRows) ? invRows.reduce((s, r) => s + num(r.valor_total), 0) : 0);
    const bancos = num(capRow.bancos);
    // Respuesta shape: plano en root para que `capital.html` lea
    // `snap.cxc`, `snap.inventario`, etc. Mantengo capital/saldo_cxc como
    // legacy por si algún consumidor los usaba.
    res.json({
      ok: true,
      unidad,
      cxc,
      cxp,
      inventario,
      bancos,
      capital_trabajo: num(capRow.capital_trabajo, cxc + inventario + bancos - cxp),
      ratio_circulante: num(capRow.ratio_circulante),
      prueba_acida: num(pruebaRow.prueba_acida),
      capital: capRow,
      saldo_cxc: cxc,
    });
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
  console.log(`  auth:     ${AUTH_ENABLED ? 'session cookie (' + Object.keys(AUTH_USERS).length + ' usuario/s) — login en /login' : 'abierto (AUTH_USERS vacío)'}`);
  console.log(`  prod:     ${IS_PROD}`);
});

module.exports = app;
