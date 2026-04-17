#!/usr/bin/env node
/**
 * validate-inventario.js — Agente validador de Inventario
 * ─────────────────────────────────────────────────────────
 * Verifica: endpoints de inventario, artículos sin movimiento,
 * nivel de stock mínimo, artículos en cero y coherencia de valor.
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkHtmlSelectors, unwrap, printHeader, C,
} = require('./lib/validator-core');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

// Umbrales de alerta de negocio
const THRESHOLDS = {
  maxSinMovPct   : 0.40,   // >40% del valor en artículos sin movimiento = alerta
  maxCeroPct     : 0.30,   // >30% de artículos en existencia 0 = posible problema
  minArticulos   : 10,     // mínimo de artículos esperados en el catálogo
};

async function run() {
  printHeader('Inventario');
  const res = new ValidationResult('inventario');

  // ── 1. Estructura HTML ────────────────────────────────────────────────────
  console.log(`${C.bold}[1/4] Estructura HTML inventario.html${C.reset}`);
  checkHtmlSelectors(res, 'inventario.html', [
    'existencia',
    'sin-movimiento',
    'stock',
    'articulo',
  ]);

  // ── 2. Endpoints principales ──────────────────────────────────────────────
  console.log(`\n${C.bold}[2/4] Endpoints API${C.reset}`);
  const rRes = await checkEndpoint(res, 'GET /api/inventario/resumen', '/api/inventario/resumen');
  const rDet = await checkEndpoint(res, 'GET /api/inventario/detalle o /api/inventario', '/api/inventario');

  // ── 3. Integridad de datos ────────────────────────────────────────────────
  console.log(`\n${C.bold}[3/4] Integridad de datos${C.reset}`);
  if (rRes) {
    const d = unwrap(rRes.data) || rRes.data;
    const totalArt   = +(d.TOTAL_ARTICULOS  || d.total_articulos  || d.ARTICULOS || 0);
    const valorTotal = +(d.VALOR_TOTAL       || d.valor_total       || d.TOTAL_VALOR || 0);
    const sinMov     = +(d.VALOR_SIN_MOV     || d.valor_sin_mov     || d.SIN_MOVIMIENTO || 0);
    const enCero     = +(d.ARTICULOS_CERO    || d.articulos_cero    || 0);

    if (totalArt > 0) {
      res.ok('Total artículos', `${totalArt.toLocaleString('es-MX')} artículos`);
    } else {
      res.warn('Total artículos = 0 — posible problema con el endpoint');
    }

    if (valorTotal > 0) {
      res.ok('Valor total inventario', `$${valorTotal.toLocaleString('es-MX')}`);
    } else {
      res.warn('Valor total inventario = 0');
    }

    // % Sin movimiento
    if (valorTotal > 0 && sinMov > 0) {
      const pct = sinMov / valorTotal;
      if (pct > THRESHOLDS.maxSinMovPct) {
        res.warn(
          `${(pct*100).toFixed(1)}% del valor en artículos sin movimiento`,
          `$${sinMov.toLocaleString('es-MX')} de $${valorTotal.toLocaleString('es-MX')}`
        );
      } else {
        res.ok('% Sin movimiento en rango', `${(pct*100).toFixed(1)}%`);
      }
    }

    // % En cero
    if (totalArt > 0 && enCero > 0) {
      const pct = enCero / totalArt;
      if (pct > THRESHOLDS.maxCeroPct) {
        res.warn(`${(pct*100).toFixed(1)}% de artículos en existencia 0`, `${enCero} de ${totalArt}`);
      } else {
        res.ok('Artículos en cero dentro de límite', `${enCero} (${(pct*100).toFixed(1)}%)`);
      }
    }
  }

  if (rDet) {
    const arr = unwrap(rDet.data);
    checkArrayLength(res, 'Detalle inventario tiene artículos', arr, THRESHOLDS.minArticulos);

    if (Array.isArray(arr) && arr.length > 0) {
      // Verificar que los artículos tienen los campos básicos
      const sample = arr[0];
      const camposReq = ['ARTICULO', 'EXISTENCIA', 'COSTO'].some(f =>
        sample[f] !== undefined || sample[f.toLowerCase()] !== undefined
      );
      if (camposReq) {
        res.ok('Estructura de artículos correcta (ARTICULO, EXISTENCIA, COSTO)');
      } else {
        res.warn('Artículos pueden no tener campos esperados (ARTICULO/EXISTENCIA/COSTO)');
      }

      // Artículos con existencia negativa
      const negativos = arr.filter(a => +(a.EXISTENCIA || a.existencia || 0) < 0);
      if (negativos.length > 0) {
        res.warn(
          `${negativos.length} artículos con existencia negativa`,
          negativos.slice(0, 3).map(a => a.ARTICULO || a.articulo).join(', ')
        );
      } else {
        res.ok('Sin artículos con existencia negativa');
      }
    }
  }

  // ── 4. Consumos y rotación ────────────────────────────────────────────────
  console.log(`\n${C.bold}[4/4] Consumos y alertas de stock${C.reset}`);
  const rAlerta = await checkEndpoint(
    res, 'GET /api/inventario/alertas o /api/consumos/alertas',
    '/api/inventario/alertas'
  );
  if (rAlerta) {
    const arr = unwrap(rAlerta.data);
    if (Array.isArray(arr)) {
      const criticos = arr.filter(a => (a.ALERTA || a.alerta || '').toLowerCase() === 'critico' || (a.DIAS_STOCK || 0) < 7);
      if (criticos.length > 0) {
        res.warn(`${criticos.length} artículos en nivel CRÍTICO de stock`, criticos.slice(0, 5).map(a => a.ARTICULO || a.articulo).join(', '));
      } else {
        res.ok('Sin artículos en nivel crítico de stock');
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
