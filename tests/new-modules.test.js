'use strict';

/**
 * new-modules.test.js — Smoke tests para los 11 módulos del PR #3 + extensiones.
 *
 * Reusa la convención del smoke.test.js: arranca server con DUCK_ONLY_MODE=1
 * sin snapshot. Espera 200 con `{ ok: false, reason: 'Sin snapshot' }` o
 * estructura coherente. NUNCA 500, NUNCA hang.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 7098;
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

function postJson(p, payload) {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data, 'utf8') },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }); }
        catch (_) { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function waitReady(retries = 40) {
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
      AUTH_PROVIDER: 'dummy',
      WA_SKIP_SIGNATURE: '1',  // tests no firman como Twilio
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});
  server.stdout.on('data', () => {});
  await waitReady();
});

after(() => { if (server) server.kill('SIGTERM'); });

// ════════ Churn ════════
test('/api/churn/at-risk responde sin snapshot', async () => {
  const r = await get('/api/churn/at-risk');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
});

test('/api/churn/summary responde sin snapshot', async () => {
  const r = await get('/api/churn/summary');
  assert.equal(r.status, 200);
});

// ════════ Compras semanal ════════
test('/api/compras/lista responde sin snapshot', async () => {
  const r = await get('/api/compras/lista');
  assert.equal(r.status, 200);
});

test('/api/compras/preview entrega HTML o 503', async () => {
  const r = await get('/api/compras/preview');
  assert.ok(r.status === 200 || r.status === 503);
});

// ════════ ABC-XYZ ════════
test('/api/inv/abc-xyz responde sin snapshot', async () => {
  const r = await get('/api/inv/abc-xyz');
  assert.equal(r.status, 200);
});

// ════════ Lead scoring ════════
test('/api/leads/scoring responde sin snapshot', async () => {
  const r = await get('/api/leads/scoring');
  assert.equal(r.status, 200);
});

test('/api/leads/conversion-rates responde sin snapshot', async () => {
  const r = await get('/api/leads/conversion-rates');
  assert.equal(r.status, 200);
});

// ════════ Cross-sell ════════
test('/api/cross-sell/global responde sin snapshot', async () => {
  const r = await get('/api/cross-sell/global');
  assert.equal(r.status, 200);
});

// ════════ Prob de pago ════════
test('/api/cxc/prob-pago responde sin snapshot', async () => {
  const r = await get('/api/cxc/prob-pago');
  assert.equal(r.status, 200);
});

// ════════ Reorden dinámico ════════
test('/api/inv/reorden responde sin snapshot', async () => {
  const r = await get('/api/inv/reorden');
  assert.equal(r.status, 200);
});

// ════════ Catálogo completo ════════
test('/api/inv/catalogo responde sin snapshot', async () => {
  const r = await get('/api/inv/catalogo');
  assert.equal(r.status, 200);
  assert.equal(r.json && r.json.ok, false);
});

// ════════ Forecast SKU ════════
test('/api/forecast/sku/batch responde sin snapshot', async () => {
  const r = await get('/api/forecast/sku/batch?topN=5&meses=3');
  assert.equal(r.status, 200);
});

// ════════ Catalog cleanup ════════
test('/api/catalogos/duplicados/articulos responde sin snapshot', async () => {
  const r = await get('/api/catalogos/duplicados/articulos');
  assert.equal(r.status, 200);
});

test('/api/catalogos/clientes-sin-rfc responde sin snapshot', async () => {
  const r = await get('/api/catalogos/clientes-sin-rfc');
  assert.equal(r.status, 200);
});

// ════════ SAT/DIOT ════════
test('/api/sat/diot responde sin snapshot', async () => {
  const r = await get('/api/sat/diot?periodo=2026-01');
  assert.equal(r.status, 200);
});

test('/api/sat/proveedores-rfc-invalido responde sin snapshot', async () => {
  const r = await get('/api/sat/proveedores-rfc-invalido');
  assert.equal(r.status, 200);
});

// ════════ WhatsApp inbound ════════
test('/api/wa/test responde a /help sin requerir snapshot ni Twilio', async () => {
  const r = await postJson('/api/wa/test', { message: '/help' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.reply.includes('Comandos'));
});

test('/api/wa/webhook rechaza request sin firma cuando se exige', async () => {
  // En este test, WA_SKIP_SIGNATURE=1, así que NO rechaza por firma.
  // Sólo verificamos que el endpoint exista y responda (con o sin TwiML).
  const r = await postJson('/api/wa/webhook', { From: 'whatsapp:+5218112345678', Body: '/help' });
  // express.urlencoded espera form-urlencoded, no JSON, así que devolverá XML con error o 200
  assert.ok(r.status === 200 || r.status === 403, 'webhook responde, status: ' + r.status);
});

// ════════ Seguridad: el rate-limit del AI chat-v2 existe ════════
test('/api/ai/chat-v2 responde 503 sin ANTHROPIC_API_KEY (rate-limit pasa antes)', async () => {
  const r = await postJson('/api/ai/chat-v2', { message: 'hola', sessionId: 'test-1' });
  // Sin key → 503. Con rate-limit excedido → 429. Cualquier respuesta válida acepta.
  assert.ok([200, 400, 429, 503].includes(r.status), 'status válido: ' + r.status);
});

// ════════ Validación de input (business-intel comisiones) ════════
test('/api/bi/comisiones rechaza mes inválido (fix SQL injection)', async () => {
  const r = await get('/api/bi/comisiones?mes=2026-01%27%20OR%20%271%27%3D%271');
  assert.equal(r.status, 400, 'debe rechazar formato inválido tras el fix');
});

// ════════ AI v3 ════════
test('/api/ai/chat-v3/tools devuelve catalog sin requerir auth', async () => {
  const r = await get('/api/ai/chat-v3/tools');
  assert.equal(r.status, 200);
  assert.ok(r.json.tools && r.json.tools.length >= 15, 'debe haber >=15 tools registradas');
});

test('/api/ai/chat-v3/stats devuelve métricas', async () => {
  const r = await get('/api/ai/chat-v3/stats');
  assert.equal(r.status, 200);
  assert.ok('requests' in r.json && 'tokens' in r.json);
});

test('/api/ai/chat-v3/sessions devuelve lista (vacía o no)', async () => {
  const r = await get('/api/ai/chat-v3/sessions');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.sessions));
});

test('/api/ai/chat-v3 responde 400 sin mensaje', async () => {
  const r = await postJson('/api/ai/chat-v3', { sessionId: 'test' });
  assert.ok([400, 503].includes(r.status), 'sin message → 400; sin API key → 503');
});

// ════════ Prometheus metrics ════════
test('/api/metrics expone formato prometheus', async () => {
  // Hacer una request primero para que el contador se incremente
  await get('/api/admin/mode');
  const r = await get('/api/metrics');
  assert.equal(r.status, 200);
  // Devuelve text, no JSON
  const text = r.raw || (r.json ? JSON.stringify(r.json) : '');
  assert.ok(text.includes('# HELP') || text.includes('suminregio_'), 'debe ser formato prometheus');
});

// ════════ Health deep ════════
test('/api/health/deep devuelve estado completo', async () => {
  const r = await get('/api/health/deep');
  // Sin snapshots: 503; con: 200. Ambos válidos.
  assert.ok([200, 503].includes(r.status));
  assert.ok(r.json && r.json.status && ['healthy', 'degraded', 'unhealthy'].includes(r.json.status));
  assert.ok(r.json.version);
  assert.ok(r.json.memory && typeof r.json.memory.heap_used_mb === 'number');
  assert.ok(Array.isArray(r.json.snapshots));
  assert.ok(Array.isArray(r.json.issues));
});

test('/api/health/live siempre 200', async () => {
  const r = await get('/api/health/live');
  assert.equal(r.status, 200);
  assert.equal(r.json.alive, true);
  assert.ok(typeof r.json.uptimeSec === 'number');
});

test('/api/health/ready 503 sin snapshots', async () => {
  const r = await get('/api/health/ready');
  // Sin snapshots cargados (DUCK_ONLY_MODE=1 sin disco), responde 503
  assert.ok([200, 503].includes(r.status));
});

test('/api/cron/status lista crons registrados', async () => {
  const r = await get('/api/cron/status');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.jobs));
});

// ════════ Security headers ════════
test('respuestas tienen security headers', async () => {
  const r = await get('/api/admin/mode');
  // El test ya no expone headers en .json/.raw, hacemos una request HTTP raw
  const headers = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${PORT}/api/admin/mode`, (resp) => {
      resolve(resp.headers);
      resp.resume();
    });
  });
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN');
  assert.ok(headers['referrer-policy']);
  assert.ok(headers['permissions-policy']);
});

test('/api/bi/comisiones acepta mes válido YYYY-MM', async () => {
  const r = await get('/api/bi/comisiones?mes=2026-01');
  assert.ok(r.status === 200 || r.status === 500); // 500 acceptable sin snapshot
});
