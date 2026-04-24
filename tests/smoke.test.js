'use strict';

/**
 * smoke.test.js — Tests mínimos del server v2 (server_api.js).
 *
 * Verifica que el server arranque, los endpoints públicos respondan,
 * el gate de auth funcione (401 / redirect a /login) y el flujo
 * login → cookie → acceso protegido funcione end-to-end.
 *
 * Usa SUMINREGIO_API_KEY de entorno (en CI se pasa una dummy — los tests
 * NO invocan el API externo, sólo la lógica local de auth/health/ping).
 *
 * Ejecuta: npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 7099;
const AUTH_USER = 'ci_test_user';
const AUTH_PASS = 'ci_test_pass_12345';
let server;

function request(method, p, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'Accept': 'application/json' },
        body ? { 'Content-Type': 'application/json' } : {},
        headers || {}
      ),
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* no json */ }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json,
          raw: data,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
function get(p, opts) { return request('GET', p, opts); }
function post(p, body, opts) { return request('POST', p, Object.assign({ body }, opts || {})); }

function waitForReady(retries = 60) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode < 500) { res.resume(); return resolve(); }
        res.resume();
        if (n <= 0) return reject(new Error('server no arrancó (status ' + res.statusCode + ')'));
        setTimeout(() => attempt(n - 1), 250);
      });
      req.on('error', () => {
        if (n <= 0) return reject(new Error('server no arrancó (conexión fallida)'));
        setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(retries);
  });
}

before(async () => {
  server = spawn('node', [path.join(__dirname, '..', 'server_api.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      AUTH_USERS: `${AUTH_USER}:${AUTH_PASS}`,
      AUTH_SESSION_SECRET: 'ci_test_secret_at_least_sixteen_chars_long',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      SUMINREGIO_API_KEY: process.env.SUMINREGIO_API_KEY || 'sk_ext_ci_dummy_key_for_syntax_only',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  await waitForReady();
});

after(() => {
  if (server) server.kill('SIGTERM');
});

test('/health responde 200 con service=suminregio-dashboard', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.service, 'suminregio-dashboard');
});

test('/api/ping responde 200 con timestamp', async () => {
  const r = await get('/api/ping');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.ts, 'ts debe estar presente');
});

test('/api/admin/mode sin cookie → 401 (gated)', async () => {
  const r = await get('/api/admin/mode');
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'no_autenticado');
});

test('/api/admin/mode con cookie reporta external_api', async () => {
  const loginRes = await post('/api/auth/login', { username: AUTH_USER, password: AUTH_PASS });
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers['set-cookie'] || [])[0];
  assert.ok(cookie);
  const cookiePair = cookie.split(';')[0];

  const r = await get('/api/admin/mode', { headers: { Cookie: cookiePair } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mode, 'external_api');
});

test('GET / sin cookie → 302 redirect a /login', async () => {
  const r = await get('/');
  assert.equal(r.status, 302);
  assert.ok(r.headers.location && r.headers.location.startsWith('/login'),
    'Location debe apuntar a /login, fue: ' + r.headers.location);
});

test('GET /api/resultados/balance-general sin cookie → 401 JSON', async () => {
  const r = await get('/api/resultados/balance-general');
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'no_autenticado');
});

test('GET /login responde 200 con HTML del login page', async () => {
  const r = await get('/login');
  assert.equal(r.status, 200);
  assert.ok((r.headers['content-type'] || '').includes('text/html'));
  assert.ok(r.raw.includes('SUMINREGIO'), 'HTML debe contener branding SUMINREGIO');
});

test('POST /api/auth/login con credenciales inválidas → 401', async () => {
  const r = await post('/api/auth/login', { username: AUTH_USER, password: 'wrong' });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'credenciales_invalidas');
});

test('POST /api/auth/login con credenciales correctas → 200 + Set-Cookie', async () => {
  const r = await post('/api/auth/login', { username: AUTH_USER, password: AUTH_PASS, remember: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.user, AUTH_USER);
  const setCookie = r.headers['set-cookie'];
  assert.ok(setCookie && setCookie.length, 'Set-Cookie header requerido');
  assert.ok(String(setCookie[0]).includes('sumi_sess='), 'Cookie sumi_sess requerida');
  assert.ok(String(setCookie[0]).includes('HttpOnly'), 'Cookie debe ser HttpOnly');
});

test('Flujo completo: login → cookie → acceso a HTML protegido', async () => {
  const loginRes = await post('/api/auth/login', { username: AUTH_USER, password: AUTH_PASS });
  assert.equal(loginRes.status, 200);
  const cookie = (loginRes.headers['set-cookie'] || [])[0];
  assert.ok(cookie);
  // Extrae sólo el par name=value para reenvío
  const cookiePair = cookie.split(';')[0];

  // Con cookie, GET / debe entregar index.html (200)
  const idx = await get('/', { headers: { Cookie: cookiePair } });
  assert.equal(idx.status, 200);
  assert.ok((idx.headers['content-type'] || '').includes('text/html'));

  // /api/auth/me debe devolver el usuario
  const me = await get('/api/auth/me', { headers: { Cookie: cookiePair } });
  assert.equal(me.status, 200);
  assert.equal(me.json.ok, true);
  assert.equal(me.json.user, AUTH_USER);
});

test('POST /api/auth/logout limpia la cookie', async () => {
  const r = await post('/api/auth/logout', null);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const setCookie = r.headers['set-cookie'];
  assert.ok(setCookie && setCookie.length);
  assert.ok(String(setCookie[0]).includes('Max-Age=0'), 'Cookie debe expirar (Max-Age=0)');
});

test('GET /logout (convenience) → 302 redirect a /login', async () => {
  const r = await get('/logout');
  assert.equal(r.status, 302);
  assert.ok(r.headers.location && r.headers.location.includes('/login'));
});

test('Estáticos accesibles sin auth (favicon.svg, logo)', async () => {
  const fav = await get('/favicon.svg');
  assert.equal(fav.status, 200);
  const logo = await get('/assets/suminregio-industrial-logo.svg');
  assert.equal(logo.status, 200);
});
