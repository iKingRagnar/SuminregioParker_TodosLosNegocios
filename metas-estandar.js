/* metas-estandar.js — Tarjeta uniforme de "Metas estándar de referencia".
 *
 * Muestra, en cada tablero que no tenía objetivos definidos, las METAS
 * ESTÁNDAR SUGERIDAS que expone /api/config/metas (benchmarks de
 * distribución/mayoreo B2B). Son valores de REFERENCIA, no metas oficiales:
 * el aviso indica explícitamente que hay que ajustarlas a la empresa.
 *
 * Diseño defensivo: componente autónomo, sin dependencias, estilos propios
 * con prefijo `mestd-`, jamás lanza (todo en try/catch) para no afectar al
 * resto de la página. Se inserta como <details> colapsable al final del
 * contenido — no interfiere con el layout ni el JS existente.
 */
(function () {
  'use strict';

  // ── Qué metas mostrar por página (las relevantes a cada tablero) ───────────
  var PAGE_METAS = {
    'index.html':                ['META_MARGEN_BRUTO_PCT', 'META_DSO_DIAS', 'META_CARTERA_VENCIDA_PCT', 'META_ROTACION_INVENTARIO_ANUAL', 'META_CUMPLIMIENTO_PEDIDOS_PCT', 'META_CRECIMIENTO_YOY_PCT'],
    'director.html':             ['META_DIARIA_POR_VENDEDOR', 'META_MARGEN_BRUTO_PCT', 'META_DSO_DIAS', 'META_CARTERA_VENCIDA_PCT', 'META_CRECIMIENTO_YOY_PCT'],
    'resultados.html':           ['META_MARGEN_BRUTO_PCT', 'META_MARGEN_NETO_PCT', 'META_GASTO_OPERATIVO_PCT', 'META_CRECIMIENTO_YOY_PCT'],
    'cxc.html':                  ['META_DSO_DIAS', 'META_CARTERA_VENCIDA_PCT', 'META_EFICIENCIA_COBRANZA_PCT'],
    'cobradas.html':             ['META_EFICIENCIA_COBRANZA_PCT', 'META_DSO_DIAS'],
    'clientes.html':             ['META_RETENCION_CLIENTES_PCT', 'META_CHURN_MENSUAL_PCT', 'META_RECOMPRA_PCT'],
    'consumos.html':             ['META_DIAS_INVENTARIO_MAX', 'META_FILL_RATE_PCT', 'META_ROTACION_INVENTARIO_ANUAL'],
    'inventario.html':           ['META_ROTACION_INVENTARIO_ANUAL', 'META_DIAS_INVENTARIO_MAX', 'META_FILL_RATE_PCT', 'META_EXACTITUD_INVENTARIO_PCT'],
    'margen-producto.html':      ['META_MARGEN_PRODUCTO_MIN_PCT', 'META_MARGEN_BRUTO_PCT'],
    'vendedores.html':           ['META_DIARIA_POR_VENDEDOR', 'META_IDEAL_POR_VENDEDOR', 'META_CRECIMIENTO_YOY_PCT'],
    'ventas.html':               ['META_DIARIA_POR_VENDEDOR', 'META_CRECIMIENTO_YOY_PCT', 'META_MARGEN_BRUTO_PCT'],
    'hospital.html':             ['META_CUMPLIMIENTO_PEDIDOS_PCT', 'META_ENTREGA_A_TIEMPO_PCT', 'META_MARGEN_BRUTO_PCT'],
    'suministros-medicos.html':  ['META_CUMPLIMIENTO_PEDIDOS_PCT', 'META_MARGEN_BRUTO_PCT', 'META_ROTACION_INVENTARIO_ANUAL'],
  };

  // ── Etiqueta, dirección del objetivo y formato por meta ────────────────────
  var DEFS = {
    META_MARGEN_BRUTO_PCT:         { label: 'Margen bruto',              dir: '≥', kind: 'pct' },
    META_MARGEN_NETO_PCT:          { label: 'Margen neto (operativo)',   dir: '≥', kind: 'pct' },
    META_GASTO_OPERATIVO_PCT:      { label: 'Gasto operativo',           dir: '≤', kind: 'pct' },
    META_CRECIMIENTO_YOY_PCT:      { label: 'Crecimiento anual (YoY)',   dir: '≥', kind: 'pct' },
    META_MARGEN_PRODUCTO_MIN_PCT:  { label: 'Margen mínimo por producto', dir: '≥', kind: 'pct' },
    META_DSO_DIAS:                 { label: 'Días de cobro (DSO)',       dir: '≤', kind: 'dias' },
    META_CARTERA_VENCIDA_PCT:      { label: 'Cartera vencida',           dir: '≤', kind: 'pct' },
    META_EFICIENCIA_COBRANZA_PCT:  { label: 'Eficiencia de cobranza',    dir: '≥', kind: 'pct' },
    META_ROTACION_INVENTARIO_ANUAL:{ label: 'Rotación de inventario',    dir: '≥', kind: 'x' },
    META_DIAS_INVENTARIO_MAX:      { label: 'Días de inventario',        dir: '≤', kind: 'dias' },
    META_FILL_RATE_PCT:            { label: 'Fill rate (surtido)',       dir: '≥', kind: 'pct' },
    META_EXACTITUD_INVENTARIO_PCT: { label: 'Exactitud de inventario',   dir: '≥', kind: 'pct' },
    META_CUMPLIMIENTO_PEDIDOS_PCT: { label: 'Cumplimiento de pedidos',   dir: '≥', kind: 'pct' },
    META_ENTREGA_A_TIEMPO_PCT:     { label: 'Entregas a tiempo',         dir: '≥', kind: 'pct' },
    META_RETENCION_CLIENTES_PCT:   { label: 'Retención de clientes',     dir: '≥', kind: 'pct' },
    META_CHURN_MENSUAL_PCT:        { label: 'Churn mensual',             dir: '≤', kind: 'pct' },
    META_RECOMPRA_PCT:             { label: 'Tasa de recompra',          dir: '≥', kind: 'pct' },
    META_DIARIA_POR_VENDEDOR:      { label: 'Venta diaria por vendedor', dir: '≥', kind: 'money' },
    META_IDEAL_POR_VENDEDOR:       { label: 'Venta ideal por vendedor',  dir: '≥', kind: 'money' },
  };

  function fmtVal(kind, v) {
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    if (kind === 'pct') return Math.round(n * 1000) / 10 + '%';
    if (kind === 'dias') return n + ' días';
    if (kind === 'x') return n + '×/año';
    if (kind === 'money') return '$' + n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
    return String(n);
  }

  function currentPage() {
    var p = (location.pathname || '').split('/').pop();
    if (!p || p === '') p = 'index.html';
    return p.toLowerCase();
  }

  function apiBase() {
    return (typeof window !== 'undefined' && window.__API_BASE) ? window.__API_BASE : '';
  }

  function injectStyles() {
    if (document.getElementById('mestd-styles')) return;
    var css =
      '.mestd-card{margin:1.25rem auto;max-width:1200px;padding:0 1rem;font-family:inherit}' +
      '.mestd-box{border:1px solid rgba(127,127,127,.28);border-radius:12px;background:rgba(127,127,127,.07);padding:.5rem .9rem}' +
      '.mestd-box>summary{cursor:pointer;list-style:none;font-weight:600;font-size:.9rem;display:flex;align-items:center;gap:.5rem;padding:.35rem 0}' +
      '.mestd-box>summary::-webkit-details-marker{display:none}' +
      '.mestd-box>summary::after{content:"\\25be";margin-left:auto;opacity:.6;transition:transform .2s}' +
      '.mestd-box[open]>summary::after{transform:rotate(180deg)}' +
      '.mestd-grid{display:flex;flex-wrap:wrap;gap:.5rem;margin:.6rem 0 .3rem}' +
      '.mestd-chip{display:flex;flex-direction:column;gap:.1rem;border:1px solid rgba(127,127,127,.25);border-radius:9px;padding:.45rem .65rem;min-width:140px;background:rgba(127,127,127,.06)}' +
      '.mestd-chip .l{font-size:.68rem;opacity:.75}' +
      '.mestd-chip .v{font-size:1rem;font-weight:700;font-variant-numeric:tabular-nums}' +
      '.mestd-chip .m{font-size:.66rem;font-variant-numeric:tabular-nums;opacity:.9}' +
      '.mestd-chip.ok{border-color:rgba(52,211,153,.5)}' +
      '.mestd-chip.bad{border-color:rgba(248,113,113,.5)}' +
      '.mestd-ok{color:#34d399;font-weight:700}' +
      '.mestd-bad{color:#f87171;font-weight:700}' +
      '.mestd-mut{opacity:.6}' +
      '.mestd-note{font-size:.7rem;opacity:.75;line-height:1.4;margin-top:.35rem}' +
      '.mestd-badge{font-size:.62rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border:1px solid rgba(212,160,23,.5);color:#d4a017;border-radius:99px;padding:.05rem .45rem}';
    var st = document.createElement('style');
    st.id = 'mestd-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // Δ formateado según tipo (pct → puntos porcentuales)
  function fmtDelta(kind, delta) {
    if (delta == null) return '';
    var signo = delta > 0 ? '+' : '';
    if (kind === 'pct') return signo + (Math.round(delta * 1000) / 10) + ' pp';
    if (kind === 'money') return signo + '$' + Math.round(delta).toLocaleString('es-MX');
    if (kind === 'dias') return signo + Math.round(delta) + ' d';
    return signo + (Math.round(delta * 100) / 100);
  }

  function render(items, keys, personalizadas) {
    injectStyles();
    var byKey = {};
    items.forEach(function (it) { byKey[it.key] = it; });

    var chips = keys.map(function (k) {
      var it = byKey[k];
      if (!it || it.meta == null) return '';
      var metaTxt = (it.dir || '') + ' ' + fmtVal(it.kind, it.meta);

      // Con dato real medido → Real grande + Meta/Δ/% con color
      if (it.medible && it.real != null) {
        var ok = !!it.alcanzada;
        var pctTxt = (it.pct != null ? Math.round(it.pct) + '%' : '—');
        var line = 'Meta ' + metaTxt + ' · <span class="' + (ok ? 'mestd-ok' : 'mestd-bad') + '">'
          + (ok ? '✓ ' : '✗ ') + pctTxt + '</span> · Δ ' + fmtDelta(it.kind, it.delta);
        return '<div class="mestd-chip ' + (ok ? 'ok' : 'bad') + '">'
          + '<span class="l">' + it.label + '</span>'
          + '<span class="v">' + fmtVal(it.kind, it.real) + '</span>'
          + '<span class="m">' + line + '</span></div>';
      }

      // Medible pero sin dato disponible, o meta-solo (objetivo de referencia)
      var sub = it.medible ? '<span class="m mestd-mut">sin dato actual</span>'
        : '<span class="m mestd-mut">objetivo</span>';
      return '<div class="mestd-chip"><span class="l">' + it.label + '</span>'
        + '<span class="v">' + metaTxt + '</span>' + sub + '</div>';
    }).join('');
    if (!chips) return;

    var badge = personalizadas
      ? '<span class="mestd-badge" style="border-color:rgba(52,211,153,.5);color:#34d399">Personalizadas</span>'
      : '<span class="mestd-badge">Estándar</span>';
    var note = (personalizadas
      ? 'Metas configuradas por la empresa. '
      : 'Metas estándar sugeridas (benchmarks B2B). ')
      + 'El % es el cumplimiento vs la meta (✓ = alcanzada). Edítalas en '
      + '<a href="metas.html" style="color:inherit;text-decoration:underline">Metas / Objetivos</a> '
      + 'y el cálculo se recalcula en todo el proyecto.';

    var wrap = document.createElement('div');
    wrap.className = 'mestd-card';
    wrap.innerHTML =
      '<details class="mestd-box" open>' +
      '<summary>' + badge + ' 🎯 Metas y cumplimiento</summary>' +
      '<div class="mestd-grid">' + chips + '</div>' +
      '<p class="mestd-note">' + note + '</p>' +
      '</details>';

    var host = document.querySelector('main') || document.body;
    host.appendChild(wrap);
  }

  function init() {
    try {
      var keys = PAGE_METAS[currentPage()];
      if (!keys || !keys.length) return; // página sin metas mapeadas → no hace nada
      var dbqs = '';
      try {
        var db = new URLSearchParams(location.search).get('db');
        if (db) dbqs = '?db=' + encodeURIComponent(db);
      } catch (_) { /* URLSearchParams no disponible */ }

      fetch(apiBase() + '/api/metas/cumplimiento' + dbqs, { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data && data.items) render(data.items, keys, data.personalizadas); })
        .catch(function () { /* sin red / endpoint: no mostrar nada */ });
    } catch (_) { /* nunca romper la página */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
