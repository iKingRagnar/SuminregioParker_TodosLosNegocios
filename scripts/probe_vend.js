'use strict';
// Probe rápido de shapes upstream — ejecutar con: node scripts/probe_vend.js
require('dotenv').config();
const api = require('../api-client.js');

(async () => {
  const y = new Date().getFullYear();
  const m = new Date().getMonth() + 1;
  try {
    console.log('--- ventas_por_vendedor parker', y, m, '---');
    const r1 = await api.runQuery('parker', 'ventas_por_vendedor', { anio: y, mes: m });
    console.log('count:', r1.length, 'fields:', r1[0] ? Object.keys(r1[0]) : '(vacío)');
    console.log('sample:', JSON.stringify(r1.slice(0, 3), null, 2));

    console.log('\n--- cotizaciones_activas parker', y, m, '---');
    const r2 = await api.runQuery('parker', 'cotizaciones_activas', { anio: y, mes: m });
    console.log('count:', r2.length, 'fields:', r2[0] ? Object.keys(r2[0]) : '(vacío)');
    console.log('sample:', JSON.stringify(r2.slice(0, 2), null, 2));

    console.log('\n--- ventas_resumen_mes parker', y, m, '---');
    const r3 = await api.runQuery('parker', 'ventas_resumen_mes', { anio: y, mes: m });
    console.log('sample:', JSON.stringify(r3, null, 2));

    console.log('\n--- margen_por_vendedor parker', y, m, '---');
    try {
      const r4 = await api.runQuery('parker', 'margen_por_vendedor', { anio: y, mes: m });
      console.log('count:', r4.length, 'fields:', r4[0] ? Object.keys(r4[0]) : '(vacío)');
      console.log('sample:', JSON.stringify(r4.slice(0, 2), null, 2));
    } catch (e) { console.log('margen err:', e.message); }
  } catch (e) {
    console.error('ERROR:', e.message, e.detail || '');
    process.exit(1);
  }
})();
