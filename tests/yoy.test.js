'use strict';

/**
 * yoy.test.js — Verifica el cálculo de crecimiento YoY desde la serie del P&L.
 * Usa meses históricos (2023–2024) para que "último mes completo" sea
 * determinista (siempre < mes actual de ejecución).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { yoyFromPnl } = require('../src/routes/metas-routes');

function serie(ventasPorYM) {
  const meses = [];
  for (const y of [2023, 2024]) {
    for (let mo = 1; mo <= 12; mo++) {
      const ym = y + '-' + String(mo).padStart(2, '0');
      meses.push({ ANIO: y, MES: mo, VENTAS_NETAS: ventasPorYM[ym] != null ? ventasPorYM[ym] : 100 });
    }
  }
  return { meses };
}

test('YoY: último mes completo vs mismo mes del año anterior (+20%)', () => {
  // 2024-12 = 120 vs 2023-12 = 100 → +0.20
  const b = serie({ '2024-12': 120, '2023-12': 100 });
  const yoy = yoyFromPnl(b);
  assert.ok(Math.abs(yoy - 0.20) < 1e-9, 'esperado 0.20, fue ' + yoy);
});

test('YoY: caída (-10%)', () => {
  const b = serie({ '2024-12': 90, '2023-12': 100 });
  assert.ok(Math.abs(yoyFromPnl(b) - (-0.10)) < 1e-9);
});

test('YoY: sin serie suficiente → null', () => {
  assert.equal(yoyFromPnl({ meses: [{ ANIO: 2024, MES: 12, VENTAS_NETAS: 100 }] }), null);
  assert.equal(yoyFromPnl({}), null);
  assert.equal(yoyFromPnl(null), null);
});

test('YoY: mes base del año anterior en 0 → null (evita división por cero)', () => {
  const b = serie({ '2024-12': 120, '2023-12': 0 });
  assert.equal(yoyFromPnl(b), null);
});
