/**
 * modules/ai-chat.js
 * Asistente IA con contexto en tiempo real de todos los KPIs del ERP Microsip.
 * Llama a los propios endpoints del servidor para obtener datos frescos antes
 * de responder, y envía la consulta + datos a Claude (Anthropic).
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 7000;
const LOCAL = `http://localhost:${PORT}`;
const MODEL  = process.env.AI_MODEL || 'claude-opus-4-6';
const EMPRESA = process.env.AI_EMPRESA_NOMBRE || process.env.EMPRESA_NOMBRE || 'la empresa';

// ── Cliente Anthropic ─────────────────────────────────────────────────────────
function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.startsWith('sk-ant-api03-XXXXXX')) {
    throw new Error('ANTHROPIC_API_KEY no configurada. Agrega tu clave en el archivo .env');
  }
  return new Anthropic({ apiKey: key });
}

// ── Fetch con timeout (llama a sus propios endpoints) ────────────────────────
async function selfFetch(path, ms = 30000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`${LOCAL}${path}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// ── Recolector de KPIs en tiempo real ────────────────────────────────────────
async function gatherKpiSnapshot(db) {
  const qs = db ? `?db=${encodeURIComponent(db)}` : '';
  const [ventas, cxc, metas, pnl, vendedores, cumpl, inv] = await Promise.all([
    selfFetch(`/api/ventas/resumen${qs}`, 25000),
    selfFetch(`/api/cxc/resumen${qs}`, 20000),
    selfFetch(`/api/config/metas`, 10000),
    selfFetch(`/api/resultados/pnl?meses=3${qs}`, 45000),
    selfFetch(`/api/director/vendedores${qs}`, 20000),
    selfFetch(`/api/ventas/cumplimiento${qs}`, 25000),
    selfFetch(`/api/inv/resumen${qs}`, 15000),
  ]);
  return { ventas, cxc, metas, pnl, vendedores, cumpl, inv };
}

// ── Formateador de números para el prompt ────────────────────────────────────
const fmtM = n => {
  if (n == null || isNaN(+n)) return 'N/D';
  n = +n;
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('es-MX');
};
const fmtPct = n => (n == null || isNaN(+n)) ? 'N/D' : (+n).toFixed(1) + '%';

// ── Constructor del system prompt con datos reales ────────────────────────────
function buildSystemPrompt(snap, pageName) {
  const { ventas, cxc, metas, pnl, vendedores, cumpl, inv } = snap;
  const today = new Date();
  const diasMes = today.getDate();
  const diasTotMes = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const pctDiaMes = ((diasMes / diasTotMes) * 100).toFixed(1);

  // ─── Ventas ───
  let ventasStr = 'Sin datos';
  if (ventas) {
    const ventaMes  = +(ventas.TOTAL_MES || ventas.VENTA_MES || 0);
    const metaMens  = +(metas?.META_TOTAL_MENSUAL || 0);
    const cumplPct  = metaMens > 0 ? ((ventaMes / metaMens) * 100).toFixed(1) : 'N/D';
    const pctEspera = metaMens > 0 ? ((diasMes / diasTotMes) * metaMens).toFixed(0) : null;
    ventasStr = `
  • Venta mes actual    : ${fmtM(ventaMes)}
  • Meta mensual        : ${fmtM(metaMens)}
  • Cumplimiento        : ${cumplPct}% (esperado a hoy: ${pctEspera ? fmtM(+pctEspera) : 'N/D'} = ${pctDiaMes}% del mes)
  • Venta hoy           : ${fmtM(ventas.TOTAL_HOY || ventas.VENTA_HOY)}
  • Meta diaria         : ${fmtM(metas?.META_TOTAL_DIARIA)}
  • # Facturas mes      : ${ventas.NUM_FACTURAS_MES || ventas.FACTURAS_MES || 'N/D'}`;
  }

  // ─── CXC ───
  let cxcStr = 'Sin datos';
  if (cxc) {
    const saldo = +(cxc.SALDO_TOTAL || 0);
    const venc  = +(cxc.VENCIDO || 0);
    const pv    = +(cxc.POR_VENCER || cxc.VIGENTE || 0);
    const pctV  = saldo > 0 ? ((venc / saldo) * 100).toFixed(1) : 0;
    cxcStr = `
  • Saldo total         : ${fmtM(saldo)}
  • Vencido             : ${fmtM(venc)} (${pctV}% del saldo)
  • Por vencer/vigente  : ${fmtM(pv)}
  • # Clientes          : ${cxc.NUM_CLIENTES || 'N/D'}`;
  }

  // ─── Estado de Resultados ───
  let pnlStr = 'Sin datos';
  if (pnl && pnl.totales) {
    const t = pnl.totales;
    pnlStr = `
  • Ventas netas (3m)   : ${fmtM(t.VENTAS_NETAS)}
  • Costo de ventas     : ${fmtM(t.COSTO_VENTAS)}
  • Utilidad bruta      : ${fmtM(t.UTILIDAD_BRUTA)}
  • Margen bruto        : ${fmtPct(t.MARGEN_BRUTO_PCT)}
  • Cobros (3m)         : ${fmtM(t.COBROS)}`;
  }

  // ─── Top vendedores ───
  let vendStr = 'Sin datos';
  if (Array.isArray(vendedores) && vendedores.length) {
    vendStr = vendedores.slice(0, 8).map(v =>
      `  • ${(v.VENDEDOR || v.NOMBRE || 'S/N').substring(0, 20).padEnd(20)} | Venta mes: ${fmtM(v.VENTA_MES || v.VENTAS_MES)} | Cumpl: ${fmtPct(v.CUMPL_PCT || v.PCT_CUMPL)}`
    ).join('\n');
  } else if (Array.isArray(cumpl) && cumpl.length) {
    vendStr = cumpl.slice(0, 8).map(v =>
      `  • ${(v.VENDEDOR || v.NOMBRE || 'S/N').substring(0, 20).padEnd(20)} | Venta mes: ${fmtM(v.VENTA_MES)} | Meta: ${fmtM(v.META_MES)}`
    ).join('\n');
  }

  // ─── Inventario ───
  let invStr = 'Sin datos';
  if (inv) {
    invStr = `
  • Total artículos     : ${inv.TOTAL_ARTICULOS || 'N/D'}
  • Artículos bajo mín  : ${inv.ARTICULOS_BAJO_MINIMO || 'N/D'}
  • Valor inventario    : ${fmtM(inv.VALOR_TOTAL)}`;
  }

  return `Eres el Asistente IA de ${EMPRESA}, integrado directamente con el sistema ERP Microsip Firebird.
Tienes acceso en tiempo real a todos los KPIs del negocio. Hoy es ${today.toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}, día ${diasMes} de ${diasTotMes} del mes (${pctDiaMes}% del mes transcurrido).${pageName ? `\nEl usuario está en la página: ${pageName}.` : ''}

════ DATOS EN TIEMPO REAL ════

📊 VENTAS:${ventasStr}

💰 CUENTAS POR COBRAR (CXC):${cxcStr}

📈 ESTADO DE RESULTADOS (últimos 3 meses):${pnlStr}

👥 VENDEDORES (cumplimiento mes):
${vendStr}

📦 INVENTARIO:${invStr}

════ INSTRUCCIONES ════
• Responde SIEMPRE en español, de forma directa y con datos concretos.
• Cuando alguien pregunte por ventas, cumplimiento o proyección: analiza el ritmo actual vs días transcurridos del mes y da una proyección realista.
• Si algo está fuera de rango (cumplimiento < 80%, vencido > 30%, margen < 25%), márca lo con ⚠️ y explica la implicación.
• Si te piden una comparativa o ranking, formatea con una tabla o lista numerada.
• Cuando veas una imagen del dashboard, analiza los gráficos y números visibles y combínalos con tus datos en tiempo real.
• Sé conciso: respuestas de 3-8 líneas a menos que el usuario pida un reporte completo.
• Si el usuario pide enviar una alerta por email/WhatsApp, responde que puede hacerlo desde el botón "Enviar Alerta" del menú del widget.`;
}

// ── Conversación principal ────────────────────────────────────────────────────
/**
 * chat({ message, imageBase64, pageName, db, history })
 * → { response: string, usage: object }
 */
async function chat({ message, imageBase64, pageName, db, history = [] }) {
  const client = getClient();

  // Obtener KPIs en paralelo mientras preparamos el prompt
  const snap = await gatherKpiSnapshot(db);
  const systemPrompt = buildSystemPrompt(snap, pageName);

  // Construir historial para la API (últimos 10 turnos para no exceder tokens)
  const recentHistory = (history || []).slice(-10);
  const messages = [
    ...recentHistory.map(h => ({
      role: h.role,
      content: h.content,
    })),
  ];

  // Mensaje del usuario (con imagen si la hay)
  if (imageBase64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: imageBase64,
          },
        },
        { type: 'text', text: message },
      ],
    });
  } else {
    messages.push({ role: 'user', content: message });
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  const text = response.content?.[0]?.text || '(Sin respuesta)';
  return { response: text, usage: response.usage };
}

module.exports = { chat, gatherKpiSnapshot, buildSystemPrompt };
