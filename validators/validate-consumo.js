#!/usr/bin/env node
/**
 * validate-consumo.js — Agente validador de Consumo (Costos de producción)
 * ──────────────────────────────────────────────────────────────────────────
 * Verifica: endpoints de consumo/salidas, coherencia vs inventario,
 * tendencias anómalas y estructura de consumos.html
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkHtmlSelectors, unwrap, printHeader, C,
} = require('./lib/validator-core');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

const THRESHOLDS = {
  maxConsumoVsVentasPct : 0.95, // consumo no debe superar el 95% de ventas del mes
  minConsumoMes         : 1,    // debe haber al menos 1 movimiento de consumo en el mes
};

async function run() {
  printHeader('Consumo');
  const res = new ValidationResult('consumo');

  // ── 1. Estructura HTML ────────────────────────────────────────────────────
  console.log(`${C.bold}[1/4] Estructura HTML consumos.html${C.reset}`);
  checkHtmlSelectors(res, 'consumos.html', [
    'consumo',
    'salida',
    'articulo',
  ]);

  // ── 2. Endpoints API ──────────────────────────────────────────────────────
  console.log(`\n${C.bold}[2/4] Endpoints API${C.reset}`);
  const rRes = await checkEndpoint(
    res, 'GET /api/consumos/resumen',
    '/api/consumos/resumen'
  );
  const rDet = await checkEndpoint(
    res, 'GET /api/consumos/detalle o /api/consumos',
    '/api/consumos'
  );

  // ── 3. Integridad de datos ────────────────────────────────────────────────
  console.log(`\n${C.bold}[3/4] Integridad de datos${C.reset}`);
  if (rRes) {
    const d = unwrap(rRes.data) || rRes.data;
    const totalConsumo = +(d.TOTAL || d.total || d.TOTAL_CONSUMO || d.importe || 0);
    const movimientos  = +(d.MOVIMIENTOS || d.movimientos || d.N || 0);

    if (totalConsumo > 0) {
      res.ok('Total consumo del periodo', `$${totalConsumo.toLocaleString('es-MX')}`);
    } else {
      res.warn('Total consumo = 0 — sin movimientos de salida en el periodo');
    }

    if (movimientos > 0) {
      res.ok('Movimientos de consumo registrados', `${movimientos}`);
    } else {
      res.warn('Sin movimientos de consumo (puede ser normal si no hay producción)');
    }
  }

  if (rDet) {
    const arr = unwrap(rDet.data);
    checkArrayLength(res, 'Detalle consumo tiene registros', arr, 1);

    if (Array.isArray(arr) && arr.length > 0) {
      // Artículos más consumidos
      const sorted = [...arr].sort((a, b) =>
        (+(b.IMPORTE || b.importe || b.TOTAL || 0)) - (+(a.IMPORTE || a.importe || a.TOTAL || 0))
      );
      const top3 = sorted.slice(0, 3).map(a =>
        `${a.ARTICULO || a.articulo || 'N/A'}: $${(+(a.IMPORTE || a.importe || 0)).toLocaleString('es-MX')}`
      );
      res.ok('Top artículos consumidos', top3.join(' | '));

      // Verificar fechas dentro del periodo
      const ahora = new Date();
      const hace90 = new Date(ahora - 90 * 24 * 3600 * 1000);
      const conFecha = arr.filter(a => a.FECHA || a.fecha);
      if (conFecha.length > 0) {
        const masReciente = conFecha.reduce((max, a) => {
          const d = new Date(a.FECHA || a.fecha);
          return d > max ? d : max;
        }, hace90);
        const diasDesde = Math.floor((ahora - masReciente) / (24 * 3600 * 1000));
        if (diasDesde > 30) {
          res.warn(`Último consumo hace ${diasDesde} días — datos pueden estar desactualizados`);
        } else {
          res.ok('Último consumo reciente', `hace ${diasDesde} días`);
        }
      }
    }
  }

  // ── 4. Coherencia consumo vs ventas ──────────────────────────────────────
  console.log(`\n${C.bold}[4/4] Coherencia consumo vs ventas${C.reset}`);
  const rVentas = await checkEndpoint(
    res, 'GET /api/ventas/resumen (referencia)',
    '/api/ventas/resumen'
  );
  if (rRes && rVentas) {
    const consumoTotal = +(unwrap(rRes.data)?.TOTAL || rRes.data?.TOTAL || rRes.data?.importe || 0);
    const ventasTotal  = +(unwrap(rVentas.data)?.MES_ACTUAL || rVentas.data?.MES_ACTUAL || 0);
    if (consumoTotal > 0 && ventasTotal > 0) {
      const ratio = consumoTotal / ventasTotal;
      if (ratio > THRESHOLDS.maxConsumoVsVentasPct) {
        res.warn(
          `Consumo es ${(ratio*100).toFixed(1)}% de ventas — margen puede ser negativo`,
          `consumo=$${consumoTotal.toLocaleString('es-MX')} ventas=$${ventasTotal.toLocaleString('es-MX')}`
        );
      } else {
        res.ok(
          `Ratio consumo/ventas en rango`,
          `${(ratio*100).toFixed(1)}%`
        );
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
