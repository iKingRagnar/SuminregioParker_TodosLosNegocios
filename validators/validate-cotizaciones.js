#!/usr/bin/env node
/**
 * validate-cotizaciones.js — Agente validador de Cotizaciones
 * ─────────────────────────────────────────────────────────────
 * Verifica: visibilidad de #coti-section, candado CSS, endpoints,
 * integridad de datos y conversión de cotizaciones a ventas.
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkPositiveNum, checkHtmlSelectors, checkCssBraces,
  unwrap, printHeader, C,
} = require('./lib/validator-core');
const fs   = require('fs');
const path = require('path');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

async function run() {
  printHeader('Cotizaciones');
  const res = new ValidationResult('cotizaciones');

  // ── 1. Candado CSS — #coti-section nunca debe tener opacity:0 forzado ─────
  console.log(`${C.bold}[1/4] Candado CSS (coti-section)${C.reset}`);
  const cssPath = path.join(CONFIG.publicDir || path.resolve(__dirname, '../public'), 'design-upgrade.css');
  if (fs.existsSync(cssPath)) {
    const css = fs.readFileSync(cssPath, 'utf8');

    // Verificar que el candado de seguridad está presente
    if (css.includes('#coti-section .kpi-card') && css.includes('opacity:1') || css.includes('opacity: 1')) {
      res.ok('Candado opacity:1 presente en #coti-section');
    } else {
      res.warn('Candado opacity:1 no encontrado — verificar que coti-section no quede invisible');
    }

    // Verificar que NO hay overflow:hidden en .filter-bar que pudiera clipear dropdowns
    const filterBarBlock = css.match(/\.filter-bar\s*\{[^}]+\}/g) || [];
    const hasOverflowHidden = filterBarBlock.some(b => b.includes('overflow') && b.includes('hidden'));
    if (hasOverflowHidden) {
      res.warn('.filter-bar tiene overflow:hidden — dropdowns absolutos pueden quedar clippeados');
    } else {
      res.ok('.filter-bar sin overflow:hidden peligroso');
    }

    checkCssBraces(res, 'design-upgrade.css');
  } else {
    res.warn('design-upgrade.css no encontrado en ruta esperada');
  }

  // ── 2. Estructura HTML ────────────────────────────────────────────────────
  console.log(`\n${C.bold}[2/4] Estructura HTML ventas.html${C.reset}`);
  checkHtmlSelectors(res, 'ventas.html', [
    'id="coti-section"',
    'loadCotizaciones',
    'buildCotiApiUrl',
    'cotizaciones_scope=todos',
    'applyCotiData',
    'canonCotiResumen',
    'unlockDynamicCards',            // candado JS
    'dynamicSections',               // lista de secciones dinámicas
  ]);

  // ── 3. Endpoints API ──────────────────────────────────────────────────────
  console.log(`\n${C.bold}[3/4] Endpoints API${C.reset}`);
  const BASE_QS = '?cotizaciones_scope=todos';

  const rRes = await checkEndpoint(
    res, 'GET cotizaciones/resumen',
    `/api/ventas/cotizaciones/resumen${BASE_QS}`
  );
  if (rRes) {
    const d = unwrap(rRes.data) || rRes.data;
    const mesActual  = +(d.MES_ACTUAL  || 0);
    const cotsMes    = +(d.COTIZACIONES_MES || d.N_MES || 0);
    const hoy        = +(d.HOY         || 0);

    if (mesActual > 0 || cotsMes > 0) {
      res.ok('cotizaciones.resumen.MES_ACTUAL', `$${mesActual.toLocaleString('es-MX')}`);
    } else {
      res.warn('cotizaciones.resumen vacío — todos los campos en 0');
    }

    if (cotsMes > 0) {
      res.ok('cotizaciones.resumen.COTIZACIONES_MES', `${cotsMes} cotizaciones`);
    } else {
      res.warn('COTIZACIONES_MES = 0 — sin cotizaciones registradas en el periodo');
    }

    // Tasa de conversión
    const tasaConv = mesActual > 0 ? ((mesActual / (+(d.POTENCIAL || mesActual || 1))) * 100) : 0;
    if (+(d.TASA_CONVERSION || d.CONVERSION || 0) > 0 || tasaConv > 0) {
      res.ok('Tasa de conversión calculable', `${(+(d.TASA_CONVERSION || tasaConv)).toFixed(1)}%`);
    } else {
      res.warn('Tasa de conversión no disponible o 0%');
    }
  }

  const rDiar = await checkEndpoint(
    res, 'GET cotizaciones/diarias',
    `/api/ventas/cotizaciones/diarias${BASE_QS}&dias=14`
  );
  if (rDiar) {
    const arr = unwrap(rDiar.data);
    checkArrayLength(res, 'cotizaciones.diarias tiene filas', arr, 1);
  }

  const rVend = await checkEndpoint(
    res, 'GET por-vendedor/cotizaciones',
    `/api/ventas/por-vendedor/cotizaciones${BASE_QS}`
  );
  if (rVend) {
    const arr = unwrap(rVend.data);
    checkArrayLength(res, 'cotizaciones por vendedor tiene filas', arr, 1);
    if (Array.isArray(arr) && arr.length > 0) {
      const totalCoti = arr.reduce((s, v) => s + (+(v.IMPORTE || v.importe || 0)), 0);
      res.ok('Suma cotizaciones por vendedor', `$${totalCoti.toLocaleString('es-MX')}`);
    }
  }

  // ── 4. Coherencia resumen vs ventas reales ────────────────────────────────
  console.log(`\n${C.bold}[4/4] Coherencia cotizaciones vs ventas${C.reset}`);
  if (rRes && rVend) {
    const cotiTotal = +(unwrap(rRes.data)?.MES_ACTUAL || rRes.data?.MES_ACTUAL || 0);
    const vendArr   = unwrap(rVend.data);
    if (Array.isArray(vendArr) && vendArr.length > 0 && cotiTotal > 0) {
      const vendTotal = vendArr.reduce((s, v) => s + (+(v.IMPORTE || v.importe || 0)), 0);
      const diff = Math.abs(cotiTotal - vendTotal) / cotiTotal;
      if (diff > 0.05) {
        res.warn(
          'Discrepancia resumen vs suma vendedores',
          `resumen=$${cotiTotal.toLocaleString('es-MX')} vends=$${vendTotal.toLocaleString('es-MX')} diff=${(diff*100).toFixed(1)}%`
        );
      } else {
        res.ok('Coherencia resumen vs vendedores', `diff=${(diff*100).toFixed(2)}%`);
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
