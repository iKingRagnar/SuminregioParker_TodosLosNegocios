'use strict';

/**
 * lib/auto-mejora-core.js — Lógica PURA del motor de automejora (ITIL 4 CSI).
 *
 * Sin I/O: recibe el cumplimiento de metas y devuelve brechas priorizadas,
 * recomendaciones (regla) y tendencias. Testeable en aislamiento.
 */

// Severidad de la brecha según el % de cumplimiento (100% = en meta).
// Cuanto más por debajo, mayor prioridad ITIL.
function severidadDeBrecha(pct) {
  const p = Number(pct);
  if (!isFinite(p)) return null;
  if (p >= 100) return null;                 // sin brecha
  if (p >= 90)  return { criticidad: 'P4', nivel: 'BAJA',    sla_horas: 72 };
  if (p >= 75)  return { criticidad: 'P3', nivel: 'MEDIA',   sla_horas: 24 };
  if (p >= 50)  return { criticidad: 'P2', nivel: 'ALTA',    sla_horas: 4 };
  return { criticidad: 'P1', nivel: 'CRÍTICA', sla_horas: 1 };
}

// Recomendación por regla (ITIL/COBIT) cuando no hay IA disponible.
const RECOMENDACIONES = {
  META_MARGEN_BRUTO_PCT:        { area: 'datos',       cobit: 'APO10', txt: 'Revisar precios y costos por línea; renegociar con proveedores y depurar SKUs de bajo margen.' },
  META_MARGEN_NETO_PCT:         { area: 'datos',       cobit: 'APO06', txt: 'Controlar el gasto operativo (revisar conceptos CO_*) y buscar eficiencias sin afectar servicio.' },
  META_GASTO_OPERATIVO_PCT:     { area: 'datos',       cobit: 'APO06', txt: 'Auditar gastos de operación vs ventas; recortar gasto no productivo.' },
  META_CRECIMIENTO_YOY_PCT:     { area: 'ventas',      cobit: 'APO08', txt: 'Reactivar clientes inactivos, campañas de cross-sell y foco en líneas de mayor demanda.' },
  META_DSO_DIAS:                { area: 'cxc',         cobit: 'DSS02', txt: 'Acortar el ciclo de cobro: recordatorios automáticos y descuento por pronto pago.' },
  META_CARTERA_VENCIDA_PCT:     { area: 'cxc',         cobit: 'DSS02', txt: 'Intensificar cobranza de cartera >90 días y revisar políticas de crédito.' },
  META_EFICIENCIA_COBRANZA_PCT: { area: 'cxc',         cobit: 'DSS02', txt: 'Conciliar cobros y dar seguimiento a facturas pendientes del periodo.' },
  META_ROTACION_INVENTARIO_ANUAL:{area: 'inventario',  cobit: 'APO14', txt: 'Liquidar inventario lento (clase C/Z) y ajustar puntos de reorden por demanda real.' },
  META_DIAS_INVENTARIO_MAX:     { area: 'inventario',  cobit: 'APO14', txt: 'Reducir días de inventario: compras por demanda y liquidación de excedentes.' },
  META_FILL_RATE_PCT:           { area: 'inventario',  cobit: 'DSS01', txt: 'Mejorar disponibilidad de líneas A; revisar lead times y stock de seguridad.' },
  META_CUMPLIMIENTO_PEDIDOS_PCT:{ area: 'inventario',  cobit: 'DSS01', txt: 'Asegurar surtido completo: priorizar abasto de SKUs más pedidos.' },
  META_RETENCION_CLIENTES_PCT:  { area: 'clientes',    cobit: 'APO08', txt: 'Programa de retención: seguimiento proactivo a clientes en riesgo de fuga.' },
  META_CHURN_MENSUAL_PCT:       { area: 'clientes',    cobit: 'APO08', txt: 'Atacar el churn: contactar clientes que dejaron de comprar y entender la causa.' },
  META_RECOMPRA_PCT:            { area: 'clientes',    cobit: 'APO08', txt: 'Impulsar recompra: ofertas dirigidas, recordatorios y suscripción/recurrencia.' },
};

function recomendacionRegla(key) {
  return RECOMENDACIONES[key] || { area: 'otro', cobit: 'APO11', txt: 'Analizar la causa de la brecha y definir un plan de acción con responsable y fecha.' };
}

/**
 * Detecta brechas (KPIs medibles por debajo de su meta) y las prioriza.
 * @param {Array} items  items de /api/metas/cumplimiento
 * @returns {Array} brechas [{ key, label, real, meta, delta, pct, dir, ...severidad, area, cobit, recomendacion }]
 */
function detectarBrechas(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || !it.medible || it.real == null || it.alcanzada) continue;
    const sev = severidadDeBrecha(it.pct);
    if (!sev) continue;
    const r = recomendacionRegla(it.key);
    out.push({
      key: it.key, label: it.label, real: it.real, meta: it.meta,
      delta: it.delta, pct: it.pct, dir: it.dir,
      criticidad: sev.criticidad, nivel: sev.nivel, sla_horas: sev.sla_horas,
      area: r.area, cobit: r.cobit, recomendacion: r.txt,
    });
  }
  // Ordena por prioridad (P1 primero) y luego por % más bajo.
  const rank = { P1: 0, P2: 1, P3: 2, P4: 3 };
  out.sort((a, b) => (rank[a.criticidad] - rank[b.criticidad]) || (a.pct - b.pct));
  return out;
}

/**
 * Tendencia de un KPI a partir de su serie histórica de pct (ordenada por fecha asc).
 * Devuelve 'mejora' | 'empeora' | 'estable' | null (sin datos suficientes).
 */
function tendencia(serie, umbral) {
  if (!Array.isArray(serie) || serie.length < 2) return null;
  const u = isFinite(umbral) ? umbral : 1; // puntos porcentuales de cambio mínimo
  const prev = Number(serie[serie.length - 2]);
  const last = Number(serie[serie.length - 1]);
  if (!isFinite(prev) || !isFinite(last)) return null;
  const diff = last - prev;
  if (diff > u) return 'mejora';
  if (diff < -u) return 'empeora';
  return 'estable';
}

module.exports = {
  severidadDeBrecha, recomendacionRegla, detectarBrechas, tendencia, RECOMENDACIONES,
};
