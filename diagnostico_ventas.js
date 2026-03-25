/**
 * diagnostico_ventas.js
 * Compara 4 métodos de cálculo de ventas contra Firebird
 * para identificar la discrepancia $2.3M vs $2.8M+
 *
 * Uso: (desde la carpeta microsip-api en CMD)
 *   node diagnostico_ventas.js
 */
'use strict';

// Intentar cargar dotenv si existe
try { require('dotenv').config(); } catch (_) {}

const Firebird = require('node-firebird');

const DB = {
  host          : process.env.FB_HOST     || '127.0.0.1',
  port          : parseInt(process.env.FB_PORT) || 3050,
  database      : process.env.FB_DATABASE || 'C:/Microsip datos/SUMINREGIO-PARKER.FDB',
  user          : process.env.FB_USER     || 'SYSDBA',
  password      : process.env.FB_PASSWORD || 'masterkey',
  lowercase_keys: false,
  charset       : 'UTF8',
};

console.log('\n🔌 Conectando a Firebird:', DB.database);

function q(db, sql) {
  return new Promise((res, rej) => {
    db.query(sql, [], (err, rows) => {
      if (err) rej(err); else res(rows || []);
    });
  });
}

// Mes actual en formato Firebird
const now = new Date();
const y   = now.getFullYear();
const m   = String(now.getMonth() + 1).padStart(2, '0');
const DESDE = `${y}-${m}-01`;
const HASTA  = `${y}-${m}-${String(new Date(y, now.getMonth()+1, 0).getDate()).padStart(2,'0')}`;

console.log(`📅 Período: ${DESDE} al ${HASTA}\n`);

const fmt = n => {
  if (n == null || isNaN(n)) return 'N/D';
  return '$' + Number(n).toLocaleString('es-MX', {minimumFractionDigits:2, maximumFractionDigits:2});
};

Firebird.attach(DB, async (err, db) => {
  if (err) {
    console.error('❌ Error conectando a Firebird:', err.message);
    process.exit(1);
  }
  console.log('✅ Conectado.\n');

  try {
    // ── 1. Método servidor actual: IMPORTE_NETO / 1.16, filtro APLICADO='S', TIPO IN ('V','F') ──
    const r1 = await q(db, `
      SELECT SUM(d.IMPORTE_NETO / 1.16) AS TOTAL
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND COALESCE(d.APLICADO,'N') = 'S'
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      UNION ALL
      SELECT SUM(d.IMPORTE_NETO / 1.16) AS TOTAL
      FROM DOCTOS_PV d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND COALESCE(d.APLICADO,'N') = 'S'
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
    `);
    const m1 = (r1[0]?.TOTAL || 0) + (r1[1]?.TOTAL || 0);
    console.log('1️⃣  Servidor actual (IMPORTE_NETO/1.16, APLICADO=S, V+F):      ', fmt(m1));

    // ── 2. Sin divisor: IMPORTE_NETO tal cual ──
    const r2 = await q(db, `
      SELECT SUM(d.IMPORTE_NETO) AS TOTAL
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND COALESCE(d.APLICADO,'N') = 'S'
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      UNION ALL
      SELECT SUM(d.IMPORTE_NETO) AS TOTAL
      FROM DOCTOS_PV d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND COALESCE(d.APLICADO,'N') = 'S'
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
    `);
    const m2 = (r2[0]?.TOTAL || 0) + (r2[1]?.TOTAL || 0);
    console.log('2️⃣  Sin divisor (IMPORTE_NETO crudo, APLICADO=S, V+F):          ', fmt(m2));

    // ── 3. Power BI method: UNIDADES * PRECIO_UNITARIO desde DETALLE, sin filtro APLICADO ──
    const r3 = await q(db, `
      SELECT SUM(dd.UNIDADES * dd.PRECIO_UNITARIO) AS TOTAL
      FROM DOCTOS_VE_DET dd
      JOIN DOCTOS_VE d ON d.DOCTO_VE_ID = dd.DOCTO_VE_ID
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      UNION ALL
      SELECT SUM(dd.UNIDADES * dd.PRECIO_UNITARIO) AS TOTAL
      FROM DOCTOS_PV_DET dd
      JOIN DOCTOS_PV d ON d.DOCTO_PV_ID = dd.DOCTO_PV_ID
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
    `);
    const m3 = (r3[0]?.TOTAL || 0) + (r3[1]?.TOTAL || 0);
    console.log('3️⃣  Power BI (UNI*PRECIO detalle, sin APLICADO, V+F):            ', fmt(m3));

    // ── 4. Sin filtro APLICADO, IMPORTE_NETO/1.16 ──
    const r4 = await q(db, `
      SELECT SUM(d.IMPORTE_NETO / 1.16) AS TOTAL
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      UNION ALL
      SELECT SUM(d.IMPORTE_NETO / 1.16) AS TOTAL
      FROM DOCTOS_PV d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
    `);
    const m4 = (r4[0]?.TOTAL || 0) + (r4[1]?.TOTAL || 0);
    console.log('4️⃣  Sin filtro APLICADO (IMPORTE_NETO/1.16, V+F todos):          ', fmt(m4));

    // ── 5. Cuántos docs están excluidos por APLICADO ──
    const r5 = await q(db, `
      SELECT COUNT(*) AS CNT, SUM(d.IMPORTE_NETO) AS TOTAL
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND COALESCE(d.APLICADO,'N') <> 'S'
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
    `);
    console.log(`\n⚠️  Docs VE excluidos por APLICADO<>'S': ${r5[0]?.CNT || 0} facturas, importe: ${fmt(r5[0]?.TOTAL)}`);

    // ── 6. Ver valores distintos de APLICADO en el mes ──
    const r6 = await q(db, `
      SELECT COALESCE(d.APLICADO,'NULL') AS APLY, COUNT(*) AS CNT
      FROM DOCTOS_VE d
      WHERE d.TIPO_DOCTO IN ('V','F')
        AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      GROUP BY 1
      ORDER BY 2 DESC
    `);
    console.log('\n📋 Valores de APLICADO en DOCTOS_VE este mes:');
    r6.forEach(r => console.log(`   APLICADO='${r.APLY}' → ${r.CNT} documentos`));

    // ── 7. Ver si IMPORTE_NETO ya viene sin IVA (comparar con IMPORTE_BRUTO si existe) ──
    try {
      const r7 = await q(db, `
        SELECT FIRST 3
          d.TIPO_DOCTO,
          d.IMPORTE_NETO,
          d.IMPORTE_NETO / 1.16 AS NETO_DIV_116,
          d.APLICADO
        FROM DOCTOS_VE d
        WHERE d.TIPO_DOCTO IN ('V','F')
          AND COALESCE(d.APLICADO,'N') = 'S'
          AND d.FECHA_DOCUMENTO BETWEEN '${DESDE}' AND '${HASTA}'
      `);
      console.log('\n🔍 Muestra de 3 documentos (para ver si IMPORTE_NETO ya es sin IVA):');
      r7.forEach(r => {
        console.log(`   TIPO=${r.TIPO_DOCTO} IMPORTE_NETO=${fmt(r.IMPORTE_NETO)} ÷1.16=${fmt(r.NETO_DIV_116)} APLICADO=${r.APLICADO}`);
      });
    } catch (_) {}

    console.log('\n════════════════════════════════════════════════════════');
    console.log('🎯 RESUMEN: cuál se acerca más a tu cifra real ~$2.8M?');
    console.log('   1️⃣  Servidor actual:          ', fmt(m1));
    console.log('   2️⃣  Sin divisor /1.16:         ', fmt(m2));
    console.log('   3️⃣  Power BI (UNI*PRECIO):     ', fmt(m3));
    console.log('   4️⃣  Sin filtro APLICADO /1.16: ', fmt(m4));
    console.log('════════════════════════════════════════════════════════\n');

  } catch (e) {
    console.error('❌ Error en query:', e.message);
  } finally {
    db.detach();
  }
});
