/**
 * modules/alerts.js
 * Verifica todos los KPIs del dashboard contra sus umbrales/metas
 * y genera un objeto alertData listo para enviar por email/WhatsApp.
 */
'use strict';

const { gatherKpiSnapshot } = require('./ai-chat');

const UMBRAL_VENTA_PCT  = +(process.env.ALERT_VENTA_UMBRAL_PCT  || 80);  // % cumplimiento mínimo esperado
const UMBRAL_CXC_VENC   = +(process.env.ALERT_CXC_VENCIDO_PCT   || 30);  // % vencido máximo CXC
const UMBRAL_MARGEN_MIN = +(process.env.ALERT_MARGEN_MIN_PCT     || 25);  // % margen bruto mínimo

const EMPRESA = process.env.AI_EMPRESA_NOMBRE || process.env.EMPRESA_NOMBRE || 'Suminregio';

const fmtM   = n => { if (n == null || isNaN(+n)) return 'N/D'; n = +n; if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; return '$' + Math.round(n).toLocaleString('es-MX'); };
const fmtPct = n => (n == null || isNaN(+n)) ? 'N/D' : (+n).toFixed(1) + '%';

/**
 * checkKpis(db?)
 * Obtiene KPIs en tiempo real y evalúa alertas.
 * Retorna: { empresa, fecha, alertas: [], kpis: {ventas, cxc, pnl}, ok: bool }
 */
async function checkKpis(db) {
  const snap  = await gatherKpiSnapshot(db);
  const { ventas, cxc, metas, pnl, cumpl } = snap;
  const alertas = [];

  const today    = new Date();
  const diasMes  = today.getDate();
  const diasTot  = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const pctDia   = diasMes / diasTot; // fracción del mes transcurrida

  // ── 1. Ventas vs meta mensual ─────────────────────────────────────────────
  const ventaMes  = +(ventas?.TOTAL_MES || ventas?.VENTA_MES || 0);
  const metaMens  = +(metas?.META_TOTAL_MENSUAL || 0);

  if (metaMens > 0 && ventaMes >= 0) {
    // Esperable a esta altura del mes
    const ventaEsperada = metaMens * pctDia;
    const cumplEsperado = ventaMes / ventaEsperada * 100; // % del ritmo esperado

    // Asignar el cumplimiento calculado de vuelta al objeto ventas para el email
    if (ventas) ventas.CUMPL_PCT = (ventaMes / metaMens * 100).toFixed(1);
    if (ventas) ventas.META_MES  = metaMens;

    if (cumplEsperado < UMBRAL_VENTA_PCT) {
      alertas.push({
        modulo: 'Ventas',
        descripcion: `Venta ${fmtM(ventaMes)} vs esperado ${fmtM(ventaEsperada)} (día ${diasMes}/${diasTot})`,
        nivel: 'ALERTA',
        valor: `${fmtPct(cumplEsperado)} del ritmo esperado`,
        ok: false,
      });
    }
  }

  // ── 2. CXC — % vencido ────────────────────────────────────────────────────
  const saldoCxc = +(cxc?.SALDO_TOTAL || 0);
  const vencCxc  = +(cxc?.VENCIDO || 0);
  if (saldoCxc > 0) {
    const pctVenc = (vencCxc / saldoCxc) * 100;
    if (pctVenc > UMBRAL_CXC_VENC) {
      alertas.push({
        modulo: 'CXC',
        descripcion: `${fmtM(vencCxc)} vencido de ${fmtM(saldoCxc)} saldo total`,
        nivel: pctVenc > 50 ? 'CRÍTICO' : 'ALERTA',
        valor: fmtPct(pctVenc) + ' vencido',
        ok: false,
      });
    }
  }

  // ── 3. Estado de Resultados — margen bruto ────────────────────────────────
  const margen = +(pnl?.totales?.MARGEN_BRUTO_PCT || 0);
  const hasCosto = pnl?.totales?.COSTO_VENTAS > 0;
  if (hasCosto && margen < UMBRAL_MARGEN_MIN) {
    alertas.push({
      modulo: 'Finanzas',
      descripcion: `Margen bruto por debajo del objetivo (${UMBRAL_MARGEN_MIN}%)`,
      nivel: margen < 15 ? 'CRÍTICO' : 'ALERTA',
      valor: fmtPct(margen),
      ok: false,
    });
  }

  // ── 4. Vendedores — sin ventas hoy ────────────────────────────────────────
  if (Array.isArray(cumpl) && cumpl.length) {
    const sinVenta = cumpl.filter(v => (+v.VENTA_MES || 0) === 0 && (+v.META_MES || 0) > 0);
    if (sinVenta.length > 1) {
      alertas.push({
        modulo: 'Vendedores',
        descripcion: `${sinVenta.length} vendedor(es) sin ventas registradas este mes`,
        nivel: 'INFO',
        valor: sinVenta.map(v => v.VENDEDOR || v.NOMBRE || 'S/N').slice(0, 3).join(', '),
        ok: false,
      });
    }
  }

  const fecha = today.toLocaleDateString('es-MX', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  return {
    empresa: EMPRESA,
    fecha,
    alertas,
    kpis: { ventas, cxc, pnl, metas },
    ok: alertas.length === 0,
    generatedAt: today.toISOString(),
  };
}

module.exports = { checkKpis };
