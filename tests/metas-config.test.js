'use strict';

/**
 * metas-config.test.js — Unit tests de lib/metas-config (fuente única de metas).
 * Verifica la matemática de las metas derivadas, la validación y los overrides.
 * Usa un archivo temporal para no tocar data/metas-overrides.json real.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const mc = require('../lib/metas-config');

// Limpia overrides después de cada test que escriba.
afterEach(() => { try { fs.unlinkSync(mc.OVERRIDES_PATH); } catch (_) {} mc.resetOverrides(); try { fs.unlinkSync(mc.OVERRIDES_PATH); } catch (_) {} });

test('defaults() entrega un valor por cada meta del esquema', () => {
  const d = mc.defaults();
  for (const s of mc.SCHEMA) assert.ok(d[s.key] === s.def, `default de ${s.key}`);
});

test('buildPayload: meta ideal = diaria × factor (matemática cuadra)', () => {
  const p = mc.buildPayload({ numV: 1 });
  assert.equal(p.META_IDEAL_POR_VENDEDOR, p.META_DIARIA_POR_VENDEDOR * p.META_FACTOR_IDEAL);
  assert.equal(p.META_COTI_IDEAL, p.META_COTI_POR_VENDEDOR * p.META_FACTOR_IDEAL);
});

test('buildPayload: totales del equipo = base × número de vendedores', () => {
  const numV = 7;
  const p = mc.buildPayload({ numV });
  assert.equal(p.META_TOTAL_DIARIA, p.META_DIARIA_POR_VENDEDOR * numV);
  assert.equal(p.META_IDEAL_TOTAL, p.META_IDEAL_POR_VENDEDOR * numV);
  assert.equal(p.META_COTI_TOTAL, p.META_COTI_POR_VENDEDOR * numV);
  assert.equal(p.META_COTI_IDEAL_TOTAL, p.META_COTI_IDEAL * numV);
});

test('numV mínimo es 1 (evita totales en 0)', () => {
  const p = mc.buildPayload({ numV: 0 });
  assert.equal(p.NUM_VENDEDORES, 1);
});

test('validateMerge acepta valores válidos y rechaza desconocidos / fuera de rango', () => {
  const ok = mc.validateMerge({ META_MARGEN_BRUTO_PCT: 0.35, META_DSO_DIAS: 30 });
  assert.equal(ok.ok, true);
  assert.equal(ok.overrides.META_MARGEN_BRUTO_PCT, 0.35);

  const unknown = mc.validateMerge({ NO_EXISTE: 1 });
  assert.equal(unknown.ok, false);

  const outOfRange = mc.validateMerge({ META_MARGEN_BRUTO_PCT: 5 });
  assert.equal(outOfRange.ok, false);

  const nan = mc.validateMerge({ META_DSO_DIAS: 'abc' });
  assert.equal(nan.ok, false);
});

test('saveOverrides + buildPayload: editar una base recalcula las derivadas', () => {
  const res = mc.validateMerge({ META_DIARIA_POR_VENDEDOR: 6000, META_FACTOR_IDEAL: 1.5 });
  assert.equal(res.ok, true);
  mc.saveOverrides(res.overrides);
  const p = mc.buildPayload({ numV: 2 });
  assert.equal(p.META_DIARIA_POR_VENDEDOR, 6000);
  assert.equal(p.META_IDEAL_POR_VENDEDOR, 9000);   // 6000 × 1.5
  assert.equal(p.META_TOTAL_DIARIA, 12000);        // 6000 × 2
  assert.equal(p.META_IDEAL_TOTAL, 18000);         // 9000 × 2
  assert.equal(p.METAS_PERSONALIZADAS, true);
});

test('cumplimiento (más-es-mejor): real >= meta → alcanzada y pct >= 100', () => {
  // META_MARGEN_BRUTO_PCT default 0.30, dir ≥
  const c = mc.cumplimiento('META_MARGEN_BRUTO_PCT', 0.33, 0.30);
  assert.equal(c.dir, 'higher');
  assert.equal(c.alcanzada, true);
  assert.equal(c.pct, 110);              // 0.33/0.30 = 110%
  assert.ok(Math.abs(c.delta - 0.03) < 1e-9);
});

test('cumplimiento (más-es-mejor): real < meta → no alcanzada y pct < 100', () => {
  const c = mc.cumplimiento('META_CUMPLIMIENTO_PEDIDOS_PCT', 0.855, 0.95);
  assert.equal(c.alcanzada, false);
  assert.equal(c.pct, 90);               // 0.855/0.95 = 90%
});

test('cumplimiento (menos-es-mejor): real <= meta → alcanzada y pct >= 100', () => {
  // META_CARTERA_VENCIDA_PCT default 0.15, dir ≤
  const c = mc.cumplimiento('META_CARTERA_VENCIDA_PCT', 0.10, 0.15);
  assert.equal(c.dir, 'lower');
  assert.equal(c.alcanzada, true);
  assert.equal(c.pct, 150);              // 0.15/0.10 = 150%
});

test('cumplimiento (menos-es-mejor): real > meta → no alcanzada y pct < 100', () => {
  const c = mc.cumplimiento('META_DSO_DIAS', 60, 45);
  assert.equal(c.alcanzada, false);
  assert.equal(c.pct, 75);               // 45/60 = 75%
  assert.equal(c.delta, 15);
});

test('cumplimiento sin dato real → pct/delta null (degrada)', () => {
  const c = mc.cumplimiento('META_MARGEN_BRUTO_PCT', null, 0.30);
  assert.equal(c.real, null);
  assert.equal(c.pct, null);
  assert.equal(c.alcanzada, null);
});

test('resetOverrides vuelve a los valores estándar', () => {
  mc.saveOverrides({ META_MARGEN_BRUTO_PCT: 0.5 });
  mc.resetOverrides();
  const p = mc.buildPayload({ numV: 1 });
  assert.equal(p.META_MARGEN_BRUTO_PCT, 0.30);
  assert.equal(p.METAS_PERSONALIZADAS, false);
});
