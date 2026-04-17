#!/usr/bin/env node
/**
 * validate-all.js — Orquestador maestro de validadores Suminregio Parker
 * ────────────────────────────────────────────────────────────────────────
 * Corre todos los agentes validadores en secuencia y genera reporte final.
 * Termina con exit code 1 si CUALQUIER validador falla (para CI/CD).
 *
 * Uso:
 *   node validators/validate-all.js                    # contra localhost:3000
 *   node validators/validate-all.js --base-url http://host:port
 *   node validators/validate-all.js --only ventas,cxc  # solo esos módulos
 *   node validators/validate-all.js --fail-fast        # detener al primer fallo
 *   node validators/validate-all.js --json             # output en JSON
 *
 * Integración pre-push (agregar a package.json scripts):
 *   "validate": "node validators/validate-all.js"
 *   "predeploy": "npm run validate"
 */
'use strict';

const path = require('path');
const { C, CONFIG, printHeader } = require('./lib/validator-core');

// ── Parsear argumentos ───────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const urlArg    = args.indexOf('--base-url');
if (urlArg !== -1) CONFIG.baseUrl = args[urlArg + 1];

const onlyArg   = args.indexOf('--only');
const onlyList  = onlyArg !== -1 ? args[onlyArg + 1].split(',').map(s => s.trim().toLowerCase()) : null;
const failFast  = args.includes('--fail-fast');
const jsonMode  = args.includes('--json');

// ── Registro de módulos ──────────────────────────────────────────────────────
const MODULES = [
  { name: 'ventas',        file: './validate-ventas.js',        emoji: '💰' },
  { name: 'cotizaciones',  file: './validate-cotizaciones.js',  emoji: '📋' },
  { name: 'pnl',          file: './validate-pnl.js',            emoji: '📊' },
  { name: 'comisiones',   file: './validate-comisiones.js',     emoji: '💼' },
  { name: 'inventario',   file: './validate-inventario.js',     emoji: '📦' },
  { name: 'consumo',      file: './validate-consumo.js',        emoji: '🔄' },
  { name: 'cxc',          file: './validate-cxc.js',            emoji: '🏦' },
];

// ── Filtrar por --only ───────────────────────────────────────────────────────
const modules = onlyList
  ? MODULES.filter(m => onlyList.includes(m.name))
  : MODULES;

// ── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  if (jsonMode) return;
  const sep = '═'.repeat(62);
  console.log('');
  console.log(`${C.cyan}${C.bold}${sep}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  🚀  SUMINREGIO PARKER — SUITE DE VALIDACIÓN PRE-DEPLOY${C.reset}`);
  console.log(`${C.cyan}${C.bold}  📡  Base URL: ${CONFIG.baseUrl}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  📅  ${new Date().toLocaleString('es-MX')}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  🧩  Módulos: ${modules.map(m => m.name).join(', ')}${C.reset}`);
  console.log(`${C.cyan}${C.bold}${sep}${C.reset}`);
  console.log('');
}

// ── Runner principal ─────────────────────────────────────────────────────────
async function runAll() {
  printBanner();

  const results   = [];
  let   anyFailed = false;

  for (const mod of modules) {
    if (!jsonMode) {
      console.log(`\n${'─'.repeat(62)}`);
    }
    try {
      const runner = require(path.resolve(__dirname, mod.file));
      const pass   = await runner();
      results.push({ module: mod.name, pass, emoji: mod.emoji });
      if (!pass) {
        anyFailed = true;
        if (failFast) {
          if (!jsonMode) console.log(`\n${C.red}${C.bold}⛔ --fail-fast activado. Deteniendo suite.${C.reset}`);
          break;
        }
      }
    } catch (e) {
      console.error(`${C.red}❌ [${mod.name}] ERROR: ${e.message}${C.reset}`);
      results.push({ module: mod.name, pass: false, emoji: mod.emoji, error: e.message });
      anyFailed = true;
      if (failFast) break;
    }
  }

  // ── Reporte final ──────────────────────────────────────────────────────────
  if (jsonMode) {
    console.log(JSON.stringify({
      timestamp : new Date().toISOString(),
      baseUrl   : CONFIG.baseUrl,
      pass      : !anyFailed,
      modules   : results,
    }, null, 2));
    return !anyFailed;
  }

  const sep = '═'.repeat(62);
  console.log('');
  console.log(`${C.cyan}${C.bold}${sep}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  📋  RESUMEN FINAL${C.reset}`);
  console.log(`${C.cyan}${C.bold}${sep}${C.reset}`);
  console.log('');

  for (const r of results) {
    const icon = r.pass ? `${C.green}✅ PASS${C.reset}` : `${C.red}❌ FAIL${C.reset}`;
    console.log(`  ${r.emoji}  ${C.bold}${r.module.padEnd(16)}${C.reset} ${icon}${r.error ? C.gray + ' — ' + r.error + C.reset : ''}`);
  }

  const totalPassed = results.filter(r => r.pass).length;
  const totalFailed = results.filter(r => !r.pass).length;

  console.log('');
  console.log(
    `  ${C.bold}Total:${C.reset} ` +
    `${C.green}${totalPassed} pasaron${C.reset}  ` +
    `${totalFailed > 0 ? C.red : C.gray}${totalFailed} fallaron${C.reset}`
  );
  console.log('');

  if (anyFailed) {
    console.log(`${C.red}${C.bold}  ⛔  VALIDACIÓN FALLIDA — NO HACER PUSH A PRODUCCIÓN${C.reset}`);
    console.log(`${C.red}     Corrige los errores arriba antes de deployar.${C.reset}`);
  } else {
    console.log(`${C.green}${C.bold}  ✅  TODAS LAS VALIDACIONES PASARON — OK PARA DEPLOY${C.reset}`);
  }
  console.log('');

  return !anyFailed;
}

// ── Punto de entrada ──────────────────────────────────────────────────────────
runAll().then(ok => process.exit(ok ? 0 : 1)).catch(e => {
  console.error(`${C.red}ERROR FATAL en orquestador:${C.reset}`, e.message);
  process.exit(2);
});
