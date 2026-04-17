#!/usr/bin/env node
/**
 * validate-cxc.js — Agente validador de Cuentas por Cobrar (CxC)
 * ────────────────────────────────────────────────────────────────
 * Verifica: aging buckets, DSO, cartera vencida, coherencia saldos
 * y alertas de clientes en riesgo.
 */
'use strict';

const {
  CONFIG, ValidationResult, checkEndpoint, checkArrayLength,
  checkHtmlSelectors, unwrap, printHeader, C,
} = require('./lib/validator-core');

const urlArg = process.argv.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = process.argv[urlArg + 1];

const THRESHOLDS = {
  maxVencidoPct  : 0.50,   // >50% cartera vencida = alerta grave
  maxDSO         : 90,     // DSO > 90 días = alerta
  minCartera     : 1,      // debe haber cartera > $1
};

async function run() {
  printHeader('CxC — Cuentas por Cobrar');
  const res = new ValidationResult('cxc');

  // ── 1. Estructura HTML ────────────────────────────────────────────────────
  console.log(`${C.bold}[1/4] Estructura HTML cxc.html${C.reset}`);
  checkHtmlSelectors(res, 'cxc.html', [
    'vencido',
    'cartera',
    'cliente',
    'saldo',
  ]);

  // ── 2. Endpoints API ──────────────────────────────────────────────────────
  console.log(`\n${C.bold}[2/4] Endpoints API${C.reset}`);
  const rAging = await checkEndpoint(res, 'GET /api/cxc/aging o resumen-aging', '/api/cxc/resumen-aging');
  const rClts  = await checkEndpoint(res, 'GET /api/cxc/clientes', '/api/cxc/clientes');

  // ── 3. Aging buckets ──────────────────────────────────────────────────────
  console.log(`\n${C.bold}[3/4] Aging buckets${C.reset}`);
  if (rAging) {
    const d         = unwrap(rAging.data) || rAging.data;
    const saldoTotal = +(d.SALDO_TOTAL || d.saldo_total || d.TOTAL || 0);
    const vencido    = +(d.VENCIDO     || d.vencido     || d.TOTAL_VENCIDO || 0);
    const corriente  = +(d.CORRIENTE   || d.corriente   || 0);
    const dso        = +(d.DSO         || d.dso         || 0);

    if (saldoTotal > 0) {
      res.ok('Saldo total cartera', `$${saldoTotal.toLocaleString('es-MX')}`);
    } else {
      res.warn('Saldo total cartera = 0');
    }

    // % Vencido
    if (saldoTotal > 0 && vencido >= 0) {
      const pct = vencido / saldoTotal;
      if (pct > THRESHOLDS.maxVencidoPct) {
        res.fail(
          `Cartera vencida al ${(pct*100).toFixed(1)}% — supera el 50%`,
          `$${vencido.toLocaleString('es-MX')} de $${saldoTotal.toLocaleString('es-MX')}`
        );
      } else if (pct > 0.30) {
        res.warn(`Cartera vencida al ${(pct*100).toFixed(1)}%`, `$${vencido.toLocaleString('es-MX')}`);
      } else {
        res.ok('% Cartera vencida en rango', `${(pct*100).toFixed(1)}%`);
      }
    }

    // DSO
    if (dso > 0) {
      if (dso > THRESHOLDS.maxDSO) {
        res.warn(`DSO = ${dso} días — supera los ${THRESHOLDS.maxDSO} días recomendados`);
      } else {
        res.ok('DSO en rango aceptable', `${dso} días`);
      }
    }

    // Aging buckets (0-30, 31-60, 61-90, +90)
    const b0_30  = +(d.BUCKET_0_30  || d.b0_30  || d['0_30']  || 0);
    const b31_60 = +(d.BUCKET_31_60 || d.b31_60 || d['31_60'] || 0);
    const b61_90 = +(d.BUCKET_61_90 || d.b61_90 || d['61_90'] || 0);
    const b90    = +(d.BUCKET_90    || d.b90    || d['90plus']|| 0);
    if (b0_30 + b31_60 + b61_90 + b90 > 0) {
      res.ok('Aging buckets presentes', `0-30:$${b0_30.toLocaleString()} 31-60:$${b31_60.toLocaleString()} 61-90:$${b61_90.toLocaleString()} +90:$${b90.toLocaleString()}`);
      if (b90 > saldoTotal * 0.20) {
        res.warn(`+90 días representa ${((b90/saldoTotal)*100).toFixed(1)}% de cartera — riesgo de incobrabilidad`);
      }
    }

    // Verificar coherencia: corriente + vencido ≈ total (tolerancia 5%)
    if (corriente > 0 && vencido >= 0 && saldoTotal > 0) {
      const suma = corriente + vencido;
      const diff = Math.abs(suma - saldoTotal) / saldoTotal;
      if (diff > 0.05) {
        res.warn(
          'Corriente + Vencido ≠ Total cartera',
          `${corriente.toLocaleString()} + ${vencido.toLocaleString()} = ${suma.toLocaleString()} vs total ${saldoTotal.toLocaleString()}`
        );
      } else {
        res.ok('Coherencia corriente + vencido ≈ total ✓');
      }
    }
  }

  // ── 4. Clientes en riesgo ─────────────────────────────────────────────────
  console.log(`\n${C.bold}[4/4] Clientes en riesgo${C.reset}`);
  if (rClts) {
    const arr = unwrap(rClts.data);
    if (Array.isArray(arr)) {
      res.ok('Clientes con saldo', `${arr.length} clientes`);
      const enRiesgo = arr.filter(c =>
        (+(c.DIAS_VENCIDO || c.dias_vencido || 0) > 60) ||
        (+(c.SALDO || c.saldo || 0) > 100000 && +(c.DIAS_VENCIDO || 0) > 30)
      );
      if (enRiesgo.length > 0) {
        res.warn(
          `${enRiesgo.length} clientes en riesgo (>60 días o >$100K con >30d)`,
          enRiesgo.slice(0, 3).map(c => c.CLIENTE || c.cliente || 'N/A').join(', ')
        );
      } else {
        res.ok('Sin clientes en nivel de riesgo alto');
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
