#!/usr/bin/env node
/**
 * validate-comisiones.js — Agente validador de Comisiones
 * ─────────────────────────────────────────────────────────
 * Verifica: endpoints de comisiones, tasas por vendedor,
 * coherencia con ventas cobradas y estructura HTML.
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkHtmlSelectors, unwrap, printHeader, C,
} = require('./lib/validator-core');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

const COMISION_PCT_ESPERADO = 0.08; // 8% sobre utilidad real (config Suminregio)
const MAX_COMISION_UNITARIA = 0.25; // alerta si un vendedor supera 25% de comisión

async function run() {
  printHeader('Comisiones');
  const res = new ValidationResult('comisiones');

  // ── 1. Estructura HTML ────────────────────────────────────────────────────
  console.log(`${C.bold}[1/4] Estructura HTML${C.reset}`);
  checkHtmlSelectors(res, 'vendedores.html', [
    'comision',
    'vendedor',
    'cobro',
    'utilidad',
  ]);

  // ── 2. Endpoints comisiones ───────────────────────────────────────────────
  console.log(`\n${C.bold}[2/4] Endpoints API${C.reset}`);
  const rVend = await checkEndpoint(
    res, 'GET /api/comisiones o /api/vendedores/comisiones',
    '/api/comisiones'
  );
  const rVend2 = rVend || await checkEndpoint(
    res, 'GET /api/vendedores/cobros',
    '/api/vendedores/cobros'
  );

  // ── 3. Integridad datos ───────────────────────────────────────────────────
  console.log(`\n${C.bold}[3/4] Integridad de datos${C.reset}`);
  if (rVend2) {
    const arr = unwrap(rVend2.data);
    checkArrayLength(res, 'Comisiones tiene filas de vendedores', arr, 1);

    if (Array.isArray(arr) && arr.length > 0) {
      let totalComision  = 0;
      let totalUtilidad  = 0;
      let vendedoresAnormales = [];

      for (const v of arr) {
        const comision  = +(v.COMISION  || v.comision  || v.COMISION_TOTAL  || 0);
        const utilidad  = +(v.UTILIDAD  || v.utilidad  || v.UTILIDAD_REAL   || 0);
        const cobros    = +(v.COBROS    || v.cobros    || v.MONTO_COBRADO   || 0);
        const nombre    = v.VENDEDOR || v.vendedor || v.NOMBRE || 'N/A';

        totalComision += comision;
        totalUtilidad += utilidad;

        // Tasa de comisión anormal
        if (utilidad > 0 && comision > 0) {
          const tasa = comision / utilidad;
          if (tasa > MAX_COMISION_UNITARIA) {
            vendedoresAnormales.push(`${nombre}: ${(tasa*100).toFixed(1)}%`);
          }
        }
      }

      res.ok('Total vendedores con comisiones', `${arr.length} vendedores`);
      res.ok('Total comisiones calculadas', `$${totalComision.toLocaleString('es-MX')}`);

      // Tasa global de comisiones
      if (totalUtilidad > 0) {
        const tasaGlobal = totalComision / totalUtilidad;
        const diff = Math.abs(tasaGlobal - COMISION_PCT_ESPERADO);
        if (diff > 0.02) {
          res.warn(
            `Tasa global de comisiones: ${(tasaGlobal*100).toFixed(2)}%`,
            `Esperado ≈ ${(COMISION_PCT_ESPERADO*100)}%`
          );
        } else {
          res.ok(`Tasa global de comisiones ≈ ${(COMISION_PCT_ESPERADO*100)}%`, `actual: ${(tasaGlobal*100).toFixed(2)}%`);
        }
      }

      if (vendedoresAnormales.length > 0) {
        res.warn('Vendedores con tasa de comisión anormal (>25%)', vendedoresAnormales.join(', '));
      } else {
        res.ok('Todas las tasas de comisión en rango normal');
      }
    }
  }

  // ── 4. Cobros vinculados ──────────────────────────────────────────────────
  console.log(`\n${C.bold}[4/4] Cobros vinculados${C.reset}`);
  const rCobros = await checkEndpoint(
    res, 'GET /api/cobradas/resumen o /api/cobros/resumen',
    '/api/cobradas/resumen'
  );
  if (rCobros) {
    const d = unwrap(rCobros.data) || rCobros.data;
    const totalCobrado = +(d.TOTAL || d.total || d.COBRADO || d.cobrado || 0);
    if (totalCobrado > 0) {
      res.ok('Cobros del periodo disponibles', `$${totalCobrado.toLocaleString('es-MX')}`);
    } else {
      res.warn('Cobros del periodo en 0 — comisiones pueden estar desactualizadas');
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
