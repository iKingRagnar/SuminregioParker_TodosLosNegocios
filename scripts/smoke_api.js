'use strict';

/**
 * smoke_api.js — Arranca server_api.js, golpea las rutas críticas, imprime
 * resultado y cifras clave, apaga el server. No requiere Firebird.
 *
 * Uso:  SUMINREGIO_API_KEY=sk_ext_... node scripts/smoke_api.js [--port 7111]
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 7111);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = process.env.SUMINREGIO_API_KEY;

if (!KEY || !KEY.startsWith('sk_ext_')) {
  console.error('Falta SUMINREGIO_API_KEY (sk_ext_...)');
  process.exit(2);
}

const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'development' };
const serverPath = path.resolve(__dirname, '..', 'server_api.js');
const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let serverReady = false;
const logs = [];
child.stdout.on('data', (d) => { logs.push(d.toString()); if (d.toString().includes('listo en')) serverReady = true; });
child.stderr.on('data', (d) => { logs.push('[STDERR] ' + d.toString()); });

async function waitReady(ms = 8000) {
  const t0 = Date.now();
  while (!serverReady && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 100));
  if (!serverReady) throw new Error('server no arrancó:\n' + logs.join(''));
}

async function get(pathname) {
  const r = await fetch(BASE + pathname);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

function fmtMoney(n) {
  if (!Number.isFinite(+n)) return '—';
  return '$' + (+n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  try {
    await waitReady();
    console.log('[smoke] server arrancó en ' + BASE);

    const tests = [
      { label: 'health',                   url: '/health' },
      { label: 'ping',                     url: '/api/ping' },
      { label: 'admin/mode',               url: '/api/admin/mode' },
      { label: 'universe/databases',       url: '/api/universe/databases' },
      { label: 'ventas/resumen parker 03', url: '/api/ventas/resumen?db=parker&anio=2026&mes=3' },
      { label: 'ventas/diarias parker 03', url: '/api/ventas/diarias?db=parker&anio=2026&mes=3' },
      { label: 'ventas/top-clientes',      url: '/api/ventas/top-clientes?db=parker&anio=2026&mes=3&limit=3' },
      { label: 'ventas/por-vendedor',      url: '/api/ventas/por-vendedor?db=parker&anio=2026&mes=3' },
      { label: 'ventas/cotizaciones',      url: '/api/ventas/cotizaciones/resumen?db=parker&anio=2026&mes=3' },
      { label: 'cxc/resumen-aging',        url: '/api/cxc/resumen-aging?db=parker' },
      { label: 'cxc/top-deudores',         url: '/api/cxc/top-deudores?db=parker&limit=3' },
      { label: 'cxc/vencidas',             url: '/api/cxc/vencidas?db=parker&limit=5' },
      { label: 'director/resumen',         url: '/api/director/resumen?db=parker&anio=2026&mes=3' },
      { label: 'director/vendedores',      url: '/api/director/vendedores?db=parker&anio=2026&mes=3' },
      { label: 'inv/resumen',              url: '/api/inv/resumen?db=parker' },
      { label: 'universe/scorecard grupo', url: '/api/universe/scorecard' },
      { label: 'briefing diario',          url: '/api/briefing/diario?db=parker&anio=2026&mes=3' },
      { label: 'config/metas',             url: '/api/config/metas' },
    ];

    let pass = 0, fail = 0;
    for (const t of tests) {
      try {
        const r = await get(t.url);
        const ok = r.status === 200 && r.json;
        if (ok) pass++; else fail++;
        const summary = (() => {
          if (!r.json) return (r.text || '').substring(0, 80);
          if (Array.isArray(r.json)) return `array[${r.json.length}]`;
          if (r.json.ok === false) return 'ERR: ' + (r.json.error || '');
          const keys = Object.keys(r.json).slice(0, 4).join(',');
          return `{${keys}${Object.keys(r.json).length > 4 ? ',...' : ''}}`;
        })();
        console.log(`  ${ok ? '✓' : '✗'} ${r.status}  ${t.label.padEnd(35)} ${summary}`);

        // Mostrar cifra cuando aplica
        if (t.label === 'ventas/resumen parker 03' && r.json && r.json.MES_ACTUAL != null) {
          console.log(`      MES_ACTUAL=${fmtMoney(r.json.MES_ACTUAL)}  NUM_FACTURAS=${r.json.NUM_FACTURAS}`);
        }
        if (t.label === 'cxc/resumen-aging' && r.json && r.json.resumen) {
          console.log(`      SALDO_TOTAL=${fmtMoney(r.json.resumen.SALDO_TOTAL)}  VENCIDO=${fmtMoney(r.json.resumen.VENCIDO)}`);
        }
        if (t.label === 'cxc/top-deudores' && Array.isArray(r.json) && r.json[0]) {
          const d = r.json[0];
          console.log(`      #1: ${d.CLIENTE} SALDO=${fmtMoney(d.SALDO_TOTAL)}  VENCIDO=${fmtMoney(d.VENCIDO)}`);
        }
        if (t.label === 'director/resumen' && r.json && r.json.ventas) {
          console.log(`      ventas.MES_ACTUAL=${fmtMoney(r.json.ventas.MES_ACTUAL)}  cxc.SALDO=${fmtMoney(r.json.cxc && r.json.cxc.SALDO_TOTAL)}`);
        }
      } catch (e) {
        fail++;
        console.log(`  ✗ ERR ${t.label}: ${e.message}`);
      }
    }

    console.log(`\n[smoke] ${pass}/${tests.length} pasan.`);
    if (fail) process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main().catch(e => { console.error(e); child.kill(); process.exit(1); });
