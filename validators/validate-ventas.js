#!/usr/bin/env node
/**
 * validate-ventas.js — Agente validador de Ventas
 * ─────────────────────────────────────────────────
 * Verifica: endpoints API, integridad de KPIs, estructura HTML,
 * sintaxis JS y coherencia de datos antes de push a producción.
 *
 * Uso: node validators/validate-ventas.js [--base-url http://host:port]
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkPositiveNum, checkHtmlSelectors, checkJsSyntax, checkCssBraces,
  unwrap, printHeader, C,
} = require('./lib/validator-core');

// Parsear --base-url desde args
const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

async function run() {
  printHeader('Ventas');
  const res = new ValidationResult('ventas');

  // ── 1. Archivos estáticos ─────────────────────────────────────────────────
  console.log(`${C.bold}[1/5] Archivos estáticos${C.reset}`);
  checkJsSyntax(res, 'app-ui-boot.js');
  checkCssBraces(res, 'design-upgrade.css');
  checkHtmlSelectors(res, 'ventas.html', [
    'loadAll',
    'loadCotizaciones',
    'initFilters',
    'filter-bar',
    'kpi-val',
    'coti-section',
    'setInterval(loadAll',           // auto-refresh nativo ventas
    'data-cache.js',                 // caché registrado
  ]);

  // ── 2. Endpoints KPI principales ─────────────────────────────────────────
  console.log(`\n${C.bold}[2/5] Endpoints API — Ventas KPI${C.reset}`);
  const r1 = await checkEndpoint(res, 'GET /api/ventas/resumen', '/api/ventas/resumen');
  if (r1) {
    const d = unwrap(r1.data) || r1.data;
    checkPositiveNum(res, 'ventas.resumen.MES_ACTUAL > 0', d.MES_ACTUAL ?? d.mes_actual ?? d.importe);
    checkPositiveNum(res, 'ventas.resumen.ANIO_ACTUAL > 0', d.ANIO_ACTUAL ?? d.anio_actual ?? d.acumulado);
  }

  const r2 = await checkEndpoint(res, 'GET /api/ventas/diarias', '/api/ventas/diarias');
  if (r2) checkArrayLength(res, 'ventas.diarias tiene registros', unwrap(r2.data));

  await checkEndpoint(res, 'GET /api/ventas/por-vendedor', '/api/ventas/por-vendedor');

  // ── 3. Endpoints Cotizaciones ─────────────────────────────────────────────
  console.log(`\n${C.bold}[3/5] Endpoints API — Cotizaciones${C.reset}`);
  const rc = await checkEndpoint(
    res, 'GET /api/ventas/cotizaciones/resumen',
    '/api/ventas/cotizaciones/resumen?cotizaciones_scope=todos'
  );
  if (rc) {
    const d = unwrap(rc.data) || rc.data;
    if ((+d.MES_ACTUAL || 0) <= 0 && (+d.COTIZACIONES_MES || 0) <= 0) {
      res.warn('cotizaciones.resumen — todos los valores en 0 (¿API vacía o sin datos del mes?)');
    } else {
      res.ok('cotizaciones.resumen tiene datos', `MES=${d.MES_ACTUAL} COTS=${d.COTIZACIONES_MES}`);
    }
  }

  const rcd = await checkEndpoint(
    res, 'GET /api/ventas/cotizaciones/diarias',
    '/api/ventas/cotizaciones/diarias?cotizaciones_scope=todos&dias=7'
  );
  if (rcd) checkArrayLength(res, 'cotizaciones.diarias tiene registros', unwrap(rcd.data));

  // ── 4. Endpoints por vendedor ─────────────────────────────────────────────
  console.log(`\n${C.bold}[4/5] Endpoints API — Vendedores${C.reset}`);
  const rv = await checkEndpoint(
    res, 'GET /api/ventas/por-vendedor/cotizaciones',
    '/api/ventas/por-vendedor/cotizaciones?cotizaciones_scope=todos'
  );
  if (rv) checkArrayLength(res, 'ventas.por-vendedor cotizaciones tiene filas', unwrap(rv.data));

  // ── 5. Coherencia numérica ────────────────────────────────────────────────
  console.log(`\n${C.bold}[5/5] Coherencia numérica${C.reset}`);
  if (r1 && rv) {
    const totalResumen  = +(unwrap(r1.data)?.MES_ACTUAL || r1.data?.MES_ACTUAL || 0);
    const vendedoresArr = unwrap(rv.data);
    if (Array.isArray(vendedoresArr) && vendedoresArr.length > 0) {
      const totalVendedores = vendedoresArr.reduce((s, v) => s + (+(v.IMPORTE || v.importe || 0)), 0);
      if (totalResumen > 0 && totalVendedores > 0) {
        const diff = Math.abs(totalResumen - totalVendedores) / totalResumen;
        if (diff > 0.05) {
          res.warn(
            'Discrepancia resumen vs suma vendedores',
            `resumen=${totalResumen.toLocaleString('es-MX')} vends=${totalVendedores.toLocaleString('es-MX')} diff=${(diff*100).toFixed(1)}%`
          );
        } else {
          res.ok('Coherencia resumen vs suma vendedores', `diff=${(diff*100).toFixed(2)}%`);
        }
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
