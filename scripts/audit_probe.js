#!/usr/bin/env node
// Probes queries against the external API and prints field names + sample row.
// Usage: node scripts/audit_probe.js

const KEY = 'sk_ext_FQHxtBCPUhyx3VpLCaeFwwXusHhSI0';
const URL = 'https://api.suminregio.com/api/external/query';
const UNIDAD = 'parker';

const QUERIES = [
  { id: 'inventario_resumen_marca', params: {} },
  { id: 'inv_top_stock', params: { limite: 5 } },
  { id: 'inv_bajo_minimo', params: { limite: 5 } },
  { id: 'inv_sin_movimiento', params: { dias: 180, limite: 5 } },
  { id: 'consumo_semanal', params: { dias: 90, limite: 5 } },
  { id: 'stock_articulo', params: { clave_articulo: 'TEST' } },
  { id: 'ventas_resumen_mes', params: { anio: 2026, mes: 4 } },
  { id: 'ventas_diarias', params: { anio: 2026, mes: 4 } },
  { id: 'ventas_top_productos', params: { anio: 2026, mes: 4, limite: 5 } },
  { id: 'ventas_por_vendedor', params: { anio: 2026, mes: 4 } },
  { id: 'scorecard', params: {} },
  { id: 'abc_inventario', params: {} },
  { id: 'ordenes_compra_pendientes', params: {} },
  { id: 'rotacion_inventario', params: {} },
  { id: 'inventario_desglose_marca_linea', params: {} },
  { id: 'inventario_rotacion_marca', params: {} },
  { id: 'inventario_articulos_detalle', params: {} },
  { id: 'compras_realizadas', params: { anio: 2026 } },
  { id: 'articulos_bajo_minimo', params: {} },
];

async function probe(q) {
  try {
    const resp = await fetch(URL, {
      method: 'POST',
      headers: { 'X-API-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unidad: UNIDAD, query_id: q.id, params: q.params }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data) {
      console.log(`\n=== ${q.id} ===`);
      console.log(`HTTP ${resp.status}:`, text.substring(0, 200));
      return;
    }
    const rows = data.rows || data.data || (Array.isArray(data) ? data : []);
    console.log(`\n=== ${q.id} (params: ${JSON.stringify(q.params)}) ===`);
    console.log(`HTTP ${resp.status}  count=${rows.length}`);
    if (rows.length > 0) {
      console.log('FIELDS:', Object.keys(rows[0]).join(', '));
      console.log('SAMPLE:', JSON.stringify(rows[0], null, 2));
    } else {
      console.log('EMPTY');
      if (data.error) console.log('ERROR:', data.error);
    }
  } catch (e) {
    console.log(`\n=== ${q.id} ===  EXC: ${e.message}`);
  }
}

(async () => {
  for (const q of QUERIES) {
    await probe(q);
  }
})();
