#!/usr/bin/env node
/**
 * validate-pnl.js — Agente validador de P&L (Resultados)
 * ─────────────────────────────────────────────────────────
 * Verifica: endpoints del P&L, coherencia contable, márgenes
 * dentro de rangos razonables y estructura de resultados.html
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkPositiveNum, checkHtmlSelectors, checkJsSyntax,
  unwrap, printHeader, C,
} = require('./lib/validator-core');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

// Rangos razonables de negocio para Suminregio
const THRESHOLDS = {
  margenBrutoMin  : 0.05,   // ≥ 5% margen bruto mínimo aceptable
  margenBrutoMax  : 0.95,   // ≤ 95% (si es 100% → costo de ventas = 0 → error datos)
  margenNetoMin   : -0.50,  // no mayor pérdida del 50%
  margenNetoMax   : 0.90,
  gastosPctMax    : 0.80,   // gastos no deben superar el 80% de ventas
};

async function run() {
  printHeader('P&L — Resultados');
  const res = new ValidationResult('pnl');

  // ── 1. Estructura HTML ────────────────────────────────────────────────────
  console.log(`${C.bold}[1/5] Estructura resultados.html${C.reset}`);
  checkHtmlSelectors(res, 'resultados.html', [
    'ventas-netas',
    'costo-ventas',
    'utilidad-bruta',
    'gastos-operacion',
    'utilidad-neta',
    'margen-bruto',
    'margen-neto',
  ]);

  // ── 2. Endpoint P&L principal ─────────────────────────────────────────────
  console.log(`\n${C.bold}[2/5] Endpoint /api/resultados/pnl${C.reset}`);
  const rPnl = await checkEndpoint(res, 'GET /api/resultados/pnl', '/api/resultados/pnl');
  let ventas = 0, costo = 0, utilBruta = 0, gastos = 0, utilNeta = 0;

  if (rPnl) {
    const d = unwrap(rPnl.data) || rPnl.data;

    ventas    = +(d.VENTAS_NETAS    || d.ventas_netas    || d.VENTAS    || 0);
    costo     = +(d.COSTO_VENTAS    || d.costo_ventas    || d.COSTO     || 0);
    utilBruta = +(d.UTILIDAD_BRUTA  || d.utilidad_bruta  || 0) || (ventas - costo);
    gastos    = +(d.GASTOS_OPERACION|| d.gastos_operacion|| d.GASTOS    || 0);
    utilNeta  = +(d.UTILIDAD_NETA   || d.utilidad_neta   || 0) || (utilBruta - gastos);

    checkPositiveNum(res, 'Ventas Netas > 0', ventas);

    // Costo de ventas — puede ser 0 si los datos están incompletos (bug conocido)
    if (costo <= 0) {
      res.warn('Costo de Ventas = 0 — revisar consulta DOCTOS_IN/TIPO_DOCTO (bug conocido)');
    } else {
      res.ok('Costo de Ventas > 0', `$${costo.toLocaleString('es-MX')}`);
    }

    // Margen bruto
    if (ventas > 0) {
      const mb = utilBruta / ventas;
      if (mb > THRESHOLDS.margenBrutoMax) {
        res.fail('Margen bruto', `${(mb*100).toFixed(1)}% — demasiado alto, Costo de Ventas probablemente en 0`);
      } else if (mb < THRESHOLDS.margenBrutoMin) {
        res.warn('Margen bruto muy bajo', `${(mb*100).toFixed(1)}%`);
      } else {
        res.ok('Margen bruto en rango', `${(mb*100).toFixed(1)}%`);
      }

      // Margen neto
      if (utilNeta !== 0) {
        const mn = utilNeta / ventas;
        if (mn < THRESHOLDS.margenNetoMin) {
          res.fail('Margen neto', `${(mn*100).toFixed(1)}% — pérdida > 50%`);
        } else if (mn > THRESHOLDS.margenNetoMax) {
          res.warn('Margen neto muy alto', `${(mn*100).toFixed(1)}%`);
        } else {
          res.ok('Margen neto en rango', `${(mn*100).toFixed(1)}%`);
        }
      }

      // Gastos como % de ventas
      if (gastos > 0) {
        const gp = gastos / ventas;
        if (gp > THRESHOLDS.gastosPctMax) {
          res.warn('Gastos/Ventas alto', `${(gp*100).toFixed(1)}% (máx recomendado ${THRESHOLDS.gastosPctMax*100}%)`);
        } else {
          res.ok('Gastos/Ventas en rango', `${(gp*100).toFixed(1)}%`);
        }
      }
    }
  }

  // ── 3. Endpoint Gastos por categoría ─────────────────────────────────────
  console.log(`\n${C.bold}[3/5] Gastos por categoría${C.reset}`);
  const rGast = await checkEndpoint(res, 'GET /api/resultados/gastos', '/api/resultados/gastos');
  if (rGast) {
    const arr = unwrap(rGast.data);
    checkArrayLength(res, 'Gastos tiene categorías', arr, 1);
    if (Array.isArray(arr)) {
      const totalGastos = arr.reduce((s, g) => s + (+(g.IMPORTE || g.importe || g.TOTAL || 0)), 0);
      if (ventas > 0 && totalGastos > 0) {
        res.ok('Total gastos calculado', `$${totalGastos.toLocaleString('es-MX')}`);
      }
    }
  }

  // ── 4. Endpoint comparativo anual ────────────────────────────────────────
  console.log(`\n${C.bold}[4/5] Comparativo anual${C.reset}`);
  const rAnio = await checkEndpoint(
    res, 'GET /api/resultados/por-mes o /api/resultados/mensual',
    '/api/resultados/por-mes'
  );
  if (rAnio) checkArrayLength(res, 'Datos mensuales del año', unwrap(rAnio.data), 1);

  // ── 5. Coherencia P&L ─────────────────────────────────────────────────────
  console.log(`\n${C.bold}[5/5] Coherencia contable${C.reset}`);
  if (rPnl && ventas > 0) {
    // Ventas = Costo + Utilidad Bruta (tolerancia 1%)
    const expectedUB = ventas - costo;
    if (costo > 0 && Math.abs(utilBruta - expectedUB) / ventas > 0.01) {
      res.fail(
        'Ecuación Ventas − Costo ≠ Utilidad Bruta',
        `${ventas} − ${costo} = ${expectedUB} ≠ ${utilBruta}`
      );
    } else if (costo > 0) {
      res.ok('Ecuación contable: Ventas − Costo = Utilidad Bruta ✓');
    }

    // Utilidad Neta = Utilidad Bruta − Gastos (tolerancia 5%)
    if (gastos > 0) {
      const expectedUN = utilBruta - gastos;
      if (Math.abs(utilNeta - expectedUN) / Math.abs(utilBruta || 1) > 0.05) {
        res.warn(
          'Posible discrepancia Utilidad Bruta − Gastos ≠ Utilidad Neta',
          `${utilBruta} − ${gastos} = ${expectedUN} vs ${utilNeta}`
        );
      } else {
        res.ok('Ecuación contable: Utilidad Bruta − Gastos = Utilidad Neta ✓');
      }
    }
  }

  return res.finalize();
}

module.exports = run;
if (require.main === module) {
  run().then(ok => process.exit(ok ? 0 : 1)).catch(e => {
    console.error(`${C.red}ERROR FATAL:${C.reset}`, e.message);
    process.exit(2);
  });
}
