'use strict';
// Audit end-to-end: simula lo que los endpoints del dashboard hacen con los
// datos upstream, para confirmar shapes finales (field names, valores) antes
// de que lleguen al frontend. Ejecutar con: node scripts/probe_audit.js
require('dotenv').config();
const api = require('../api-client.js');

const num = (x, fb = 0) => Number.isFinite(Number(x)) ? Number(x) : fb;
const normName = (s) => String(s || '').trim().toUpperCase();

(async () => {
  const unidad = 'parker';
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;

  console.log('===== /api/ventas/cumplimiento (simulado) =====');
  const [vend, mg] = await Promise.all([
    api.runQuery(unidad, 'ventas_por_vendedor', { anio: y, mes: m }),
    api.runQuery(unidad, 'margen_por_vendedor', { anio: y, mes: m }).catch(() => []),
  ]);
  const margenByName = new Map();
  for (const x of mg) { const k = normName(x.vendedor); if (k) margenByName.set(k, x); }
  const cumpl = vend.map(v => {
    const mg = margenByName.get(normName(v.vendedor)) || {};
    return {
      VENDEDOR_ID: v.VENDEDOR_ID,
      NOMBRE: v.vendedor,
      VENTA_MES: num(v.total_ventas),
      VENTAS_MES: num(v.total_ventas),
      FACTURAS_MES: num(v.num_docs),
      META_MES: 600000,
      CUMPLIMIENTO_PCT: num(v.total_ventas) / 600000 * 100,
      MARGEN_PCT: num(mg.margen_pct),
    };
  });
  console.log('count:', cumpl.length);
  console.log('top 3:', JSON.stringify(cumpl.slice(0, 3), null, 2));
  console.log('has VENDEDOR_ID:', cumpl.every(x => x.VENDEDOR_ID != null));

  console.log('\n===== /api/ventas/por-vendedor/cotizaciones (simulado) =====');
  const cotis = await api.runQuery(unidad, 'cotizaciones_activas', { anio: y, mes: m });
  const idByName = new Map();
  for (const v of vend) { const k = normName(v.vendedor); if (k) idByName.set(k, v.VENDEDOR_ID); }
  const byV = new Map();
  for (const r of cotis) {
    const k = normName(r.vendedor);
    const c = byV.get(k) || { VENDEDOR_ID: idByName.get(k) || null, VENDEDOR: r.vendedor, COTIZACIONES_MES: 0, NUM_COTI_MES: 0 };
    c.COTIZACIONES_MES += num(r.importe_sin_iva);
    c.NUM_COTI_MES += 1;
    byV.set(k, c);
  }
  const arr = [...byV.values()];
  console.log('count:', arr.length);
  console.log('top 3:', JSON.stringify(arr.slice(0, 3), null, 2));
  console.log('matched VENDEDOR_ID:', arr.filter(x => x.VENDEDOR_ID != null).length, '/', arr.length);

  console.log('\n===== /api/cxc/resumen-aging (simulado) =====');
  const [saldo, vencida, aging] = await Promise.all([
    api.runQuery(unidad, 'cxc_saldo_total', {}),
    api.runQuery(unidad, 'cxc_vencida_detalle', { limite: 2000 }),
    api.runQuery(unidad, 'cxc_aging', {}),
  ]);
  const bucketMap = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const b of aging) if (b.bucket in bucketMap) bucketMap[b.bucket] = num(b.total_bucket);
  const totalSaldo = num((saldo[0] || {}).saldo);
  const vencidoAging = bucketMap['0-30'] + bucketMap['31-60'] + bucketMap['61-90'] + bucketMap['90+'];
  const vigente = Math.max(0, totalSaldo - vencidoAging);
  console.log('SALDO_TOTAL:', totalSaldo.toFixed(2));
  console.log('VENCIDO (aging):', vencidoAging.toFixed(2));
  console.log('VIGENTE:', vigente.toFixed(2));
  console.log('buckets:', bucketMap);
  console.log('cobertura aging vs saldo:', (vencidoAging/totalSaldo*100).toFixed(1) + '%');

  console.log('\n===== /api/universe/databases (simulado) =====');
  const h = await api.health();
  console.log('unidades:', h.unidades_disponibles);
})().catch(e => { console.error('ERROR:', e.message, e.detail || ''); process.exit(1); });
