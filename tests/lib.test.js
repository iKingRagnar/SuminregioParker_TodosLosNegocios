'use strict';

/**
 * lib.test.js — Unit tests para los helpers compartidos en lib/
 * Pure functions, no requieren server.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ═══════════════════════════════════════════════════════════════════════════
// lib/format.js
// ═══════════════════════════════════════════════════════════════════════════
const { fmt, fmtUnits, fmtPct, fmtExact, parseMx } = require('../lib/format');

test('fmt() formatea pesos mexicanos sin decimales', () => {
  assert.equal(fmt(1234.56), '$1,235');
  assert.equal(fmt(0), '$0');
  assert.equal(fmt(-500), '$-500');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(undefined), '—');
  assert.equal(fmt('abc'), '—');
  assert.equal(fmt('1500'), '$1,500'); // strings numéricos OK
});

test('fmtUnits() preserva 2 decimales', () => {
  assert.equal(fmtUnits(1234.567), '1,234.57');
  assert.equal(fmtUnits(0), '0');
  assert.equal(fmtUnits(null), '—');
});

test('fmtPct() default 1 decimal', () => {
  assert.equal(fmtPct(12.345), '12.3%');
  assert.equal(fmtPct(12.345, 2), '12.35%');
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(null), '—');
});

test('fmtExact() mantiene 2 decimales', () => {
  assert.equal(fmtExact(1234.5), '$1,234.50');
  assert.equal(fmtExact(0.1), '$0.10');
});

test('parseMx() acepta strings con formato mexicano', () => {
  assert.equal(parseMx('$1,234,567.89'), 1234567.89);
  assert.equal(parseMx('1500'), 1500);
  assert.equal(parseMx(1500), 1500);
  assert.equal(parseMx(null), 0);
  assert.equal(parseMx('abc'), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/snap-helper.js
// ═══════════════════════════════════════════════════════════════════════════
const { makeHelpers } = require('../lib/snap-helper');

test('makeHelpers.getSnap() con request object', () => {
  const fakeSnaps = new Map([['default', { conn: {}, id: 'default' }]]);
  const { getSnap } = makeHelpers(fakeSnaps);
  const req = { query: { db: 'default' } };
  assert.ok(getSnap(req));
  assert.equal(getSnap({ query: {} }).id, 'default');
  assert.equal(getSnap(null).id, 'default');
});

test('makeHelpers.getSnap() con string dbId', () => {
  const fakeSnaps = new Map([['miempresa', { conn: {}, id: 'miempresa' }]]);
  const { getSnap } = makeHelpers(fakeSnaps);
  assert.equal(getSnap('miempresa').id, 'miempresa');
  assert.equal(getSnap('no-existe'), null);
});

test('makeHelpers.getSnap() devuelve null si snap sin conn', () => {
  const fakeSnaps = new Map([['default', { /* sin conn */ }]]);
  const { getSnap } = makeHelpers(fakeSnaps);
  assert.equal(getSnap({ query: {} }), null);
});

test('makeHelpers.all() rechaza si callback recibe error', async () => {
  const fakeSnap = {
    conn: {
      all: (sql, cb) => cb(new Error('boom'), null),
    },
  };
  const { all } = makeHelpers(new Map());
  await assert.rejects(() => all(fakeSnap, 'SELECT 1'), /boom/);
});

test('makeHelpers.all() resuelve con rows del callback', async () => {
  const fakeSnap = {
    conn: {
      all: (sql, cb) => cb(null, [{ a: 1 }, { a: 2 }]),
    },
  };
  const { all } = makeHelpers(new Map());
  const rows = await all(fakeSnap, 'SELECT 1');
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
});

test('makeHelpers.allSafe() devuelve [] si la query falla', async () => {
  const fakeSnap = {
    conn: {
      all: (sql, cb) => cb(new Error('boom')),
    },
  };
  const { allSafe } = makeHelpers(new Map());
  const rows = await allSafe(fakeSnap, 'SELECT 1');
  assert.deepEqual(rows, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/memo.js
// ═══════════════════════════════════════════════════════════════════════════
const memoLib = require('../lib/memo');

test('memo.wrap() devuelve cached en segundo hit', async () => {
  const memo = memoLib.create({ ttlMs: 1000 });
  let calls = 0;
  const fn = async () => { calls++; return { value: 42 }; };
  const r1 = await memo.wrap('k1', fn);
  const r2 = await memo.wrap('k1', fn);
  assert.equal(calls, 1, 'solo se debe llamar 1 vez al backend');
  assert.deepEqual(r1, r2);
  assert.equal(memo.stats().hits, 1);
  assert.equal(memo.stats().misses, 1);
});

test('memo.wrap() re-ejecuta si TTL expira', async () => {
  const memo = memoLib.create({ ttlMs: 10 });
  let calls = 0;
  const fn = async () => { calls++; return calls; };
  await memo.wrap('k', fn);
  await new Promise((r) => setTimeout(r, 20));
  await memo.wrap('k', fn);
  assert.equal(calls, 2);
});

test('memo.wrap() stampede protection (10 calls concurrentes → 1 backend)', async () => {
  const memo = memoLib.create({ ttlMs: 1000 });
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return 'val';
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => memo.wrap('k', fn)));
  assert.equal(calls, 1, '10 requests concurrentes deben colapsar a 1');
  assert.ok(results.every((r) => r === 'val'));
});

test('memo eviction LRU cuando se excede max', async () => {
  const memo = memoLib.create({ ttlMs: 60000, max: 3 });
  for (let i = 0; i < 5; i++) {
    await memo.wrap('k' + i, async () => i);
  }
  const s = memo.stats();
  assert.equal(s.size, 3);
  assert.equal(s.evicted, 2);
});

test('memo.invalidate() borra entrada específica', async () => {
  const memo = memoLib.create({ ttlMs: 1000 });
  let calls = 0;
  const fn = async () => ++calls;
  await memo.wrap('k', fn);
  memo.invalidate('k');
  await memo.wrap('k', fn);
  assert.equal(calls, 2);
});

test('memo.clear() resetea todo', async () => {
  const memo = memoLib.create({ ttlMs: 1000 });
  await memo.wrap('a', async () => 1);
  await memo.wrap('b', async () => 2);
  memo.clear();
  assert.equal(memo.stats().size, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/scheduler.js
// ═══════════════════════════════════════════════════════════════════════════
const scheduler = require('../lib/scheduler');

test('scheduler.schedule() valida que run sea función', () => {
  assert.throws(() => scheduler.schedule({ hour: 7 }), /run requerido/);
});

test('scheduler.schedule() valida que hour sea número', () => {
  assert.throws(() => scheduler.schedule({ run: () => {} }), /hour requerido/);
});

test('scheduler.listJobs() devuelve metadata de jobs registrados', () => {
  scheduler.stop(); // limpiar estado
  scheduler.schedule({ name: 't1', hour: 8, run: () => {} });
  scheduler.schedule({ name: 't2', hour: 9, days: [1, 2], run: () => {} });
  const list = scheduler.listJobs();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 't1');
  assert.deepEqual(list[1].days, [1, 2]);
  scheduler.stop();
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/logger.js
// ═══════════════════════════════════════════════════════════════════════════
const loggerLib = require('../lib/logger');

test('logger.create() respeta LOG_LEVEL', () => {
  const oldLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  const log = loggerLib.create();
  assert.equal(log.level, 'warn');
  process.env.LOG_LEVEL = oldLevel;
});

test('logger redacta automáticamente headers sensibles', () => {
  // Capturamos stdout/stderr para ver qué emite
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try {
    const log = loggerLib.create({ level: 'debug' });
    log.info('test', 'msg', { authorization: 'Bearer secret', body: 'ok', cookie: 'x=y' });
  } finally {
    process.stdout.write = origWrite;
  }
  const joined = lines.join('');
  assert.ok(joined.includes('***'), 'debe redactar valor');
  assert.ok(!joined.includes('Bearer secret'), 'no debe filtrar token');
  assert.ok(!joined.includes('x=y'), 'no debe filtrar cookie');
});

test('logger trunca strings gigantes', () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    const log = loggerLib.create({ level: 'debug' });
    log.info('test', 'msg', { big: 'a'.repeat(5000) });
  } finally {
    process.stdout.write = origWrite;
  }
  const joined = lines.join('');
  assert.ok(joined.includes('…'), 'debe incluir indicador de truncado');
  assert.ok(joined.length < 5000, 'salida total acotada');
});

// ═══════════════════════════════════════════════════════════════════════════
// lib/prometheus.js
// ═══════════════════════════════════════════════════════════════════════════
const promLib = require('../lib/prometheus');

test('prometheus counter incrementa', () => {
  const p = promLib.create();
  const c = p.counter('test_total', 'Test counter');
  c.inc();
  c.inc(5);
  assert.equal(c.value(), 6);
});

test('prometheus gauge set/inc/dec', () => {
  const p = promLib.create();
  const g = p.gauge('test_gauge', 'Test gauge');
  g.set(10);
  g.inc(5);
  g.dec(2);
  assert.equal(g.value(), 13);
});

test('prometheus histogram observa y suma', () => {
  const p = promLib.create();
  const h = p.histogram('test_dur', 'Test duration', [10, 100, 1000]);
  h.observe(50);
  h.observe(500);
  h.observe(50);
  const out = p.expose();
  assert.ok(out.includes('test_dur_bucket{le="100"} 2'), 'le=100 cuenta 2 (50, 50)');
  assert.ok(out.includes('test_dur_count 3'));
  assert.ok(out.includes('test_dur_sum 600'));
});

test('prometheus expose() formato válido', () => {
  const p = promLib.create();
  p.counter('req', 'Requests', { route: '/api/x' }).inc(3);
  const out = p.expose();
  assert.ok(out.includes('# HELP req Requests'));
  assert.ok(out.includes('# TYPE req counter'));
  assert.ok(out.includes('req{route="/api/x"} 3'));
});
