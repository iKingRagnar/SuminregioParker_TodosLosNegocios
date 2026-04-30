'use strict';

/**
 * smoke.test.js — Tests mínimos de endpoints críticos.
 * Ejecuta: npm test (requiere: npm i -D node:test)
 * O con node nativo: node --test tests/
 *
 * Arranca el server en un puerto alternativo, hace requests, valida responses.
 * En modo DUCK_ONLY_MODE=1 sin snapshot: endpoints deben devolver [] o {} vacío,
 * NO error 500 ni hang.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 7099;
let server;

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); }
        catch (_) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    }).on('error', reject);
  });
}

function waitForReady(retries = 40) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode < 500) return resolve();
        setTimeout(() => attempt(n - 1), 250);
      }).on('error', () => {
        if (n <= 0) return reject(new Error('server no arrancó'));
        setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(retries);
  });
}

before(async () => {
  server = spawn('node', [path.join(__dirname, '..', 'server_corregido.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DUCK_ONLY_MODE: '1',
      LOG_LEVEL: 'warn',
      NODE_ENV: 'test',
      RENDER: '',
      RENDER_EXTERNAL_URL: '',
      // Evitar que el .env local con session bloquee /api/* en CI o máquinas de dev
      AUTH_PROVIDER: 'dummy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  await waitForReady();
});

after(() => {
  if (server) server.kill('SIGTERM');
});

test('/health responde 200', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('/api/admin/mode reporta duckOnlyMode', async () => {
  const r = await get('/api/admin/mode');
  assert.equal(r.status, 200);
  assert.equal(r.json.duckOnlyMode, true);
  assert.ok(Array.isArray(r.json.snapshots));
});

test('/api/admin/sync/status retorna arreglo de snapshots', async () => {
  const r = await get('/api/admin/sync/status');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.snapshots));
  assert.ok('totalLoaded' in r.json);
});

test('/api/ventas/resumen devuelve ceros sin snapshot (no 500, no hang)', async () => {
  const r = await get('/api/ventas/resumen');
  assert.equal(r.status, 200);
  assert.ok(r.json);
});

test('/api/ping reporta uptime + memory', async () => {
  const r = await get('/api/ping');
  assert.equal(r.status, 200);
  assert.ok(r.json.uptime);
  assert.ok(r.json.memory);
});

test('ETag repetido responde 304', async () => {
  const r1 = await new Promise((res) => {
    http.get(`http://127.0.0.1:${PORT}/api/admin/mode`, (resp) => {
      const etag = resp.headers.etag;
      resp.resume();
      resp.on('end', () => res(etag));
    });
  });
  assert.ok(r1, 'ETag debe estar presente');
  const r2 = await new Promise((res) => {
    http.get({
      hostname: '127.0.0.1', port: PORT, path: '/api/admin/mode',
      headers: { 'If-None-Match': r1 },
    }, (resp) => {
      resp.resume();
      resp.on('end', () => res(resp.statusCode));
    });
  });
  assert.equal(r2, 304);
});
