'use strict';

/**
 * auto-mejora.test.js — Lógica pura del motor de automejora (ITIL 4 CSI).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('../lib/auto-mejora-core');

test('severidadDeBrecha mapea el % de cumplimiento a prioridad ITIL', () => {
  assert.equal(core.severidadDeBrecha(105), null);        // en/ sobre meta → sin brecha
  assert.equal(core.severidadDeBrecha(95).criticidad, 'P4');
  assert.equal(core.severidadDeBrecha(80).criticidad, 'P3');
  assert.equal(core.severidadDeBrecha(60).criticidad, 'P2');
  assert.equal(core.severidadDeBrecha(30).criticidad, 'P1');
  assert.equal(core.severidadDeBrecha(30).sla_horas, 1);
});

test('detectarBrechas ignora alcanzadas y sin dato; prioriza P1 primero', () => {
  const items = [
    { key: 'META_MARGEN_BRUTO_PCT', label: 'Margen', medible: true, real: 0.2, meta: 0.3, pct: 66, alcanzada: false, dir: '≥' },
    { key: 'META_FILL_RATE_PCT', label: 'Fill rate', medible: true, real: 0.97, meta: 0.95, pct: 102, alcanzada: true, dir: '≥' },
    { key: 'META_DSO_DIAS', label: 'DSO', medible: true, real: null, meta: 45, pct: null, alcanzada: null, dir: '≤' },
    { key: 'META_CARTERA_VENCIDA_PCT', label: 'Cartera vencida', medible: true, real: 0.4, meta: 0.15, pct: 37, alcanzada: false, dir: '≤' },
    { key: 'X', label: 'no medible', medible: false },
  ];
  const br = core.detectarBrechas(items);
  assert.equal(br.length, 2);                 // margen (66%) y cartera (37%)
  assert.equal(br[0].key, 'META_CARTERA_VENCIDA_PCT'); // P1 (37%) primero
  assert.equal(br[0].criticidad, 'P1');
  assert.ok(br[0].recomendacion && br[0].cobit);       // trae recomendación + COBIT
});

test('recomendacionRegla da acción + COBIT por KPI (y fallback)', () => {
  assert.equal(core.recomendacionRegla('META_DSO_DIAS').cobit, 'DSS02');
  assert.ok(core.recomendacionRegla('META_DESCONOCIDA').txt.length > 0);
});

test('tendencia detecta mejora/empeora/estable', () => {
  assert.equal(core.tendencia([70, 85]), 'mejora');
  assert.equal(core.tendencia([85, 70]), 'empeora');
  assert.equal(core.tendencia([85, 85.5]), 'estable');
  assert.equal(core.tendencia([85]), null);   // sin datos suficientes
});
