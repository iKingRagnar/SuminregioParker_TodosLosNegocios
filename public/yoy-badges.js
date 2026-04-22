/**
 * yoy-badges.js — Inyecta badges "▲ +18% MoM · ▼ -4% YoY" en cada KPI
 * Consume /api/compare/temporal?metric=ventas_mes&db=...
 * El endpoint devuelve { actual, mes_pasado, anio_pasado } — el JS calcula delta%.
 */
(function () {
  'use strict';
  if (window.__sumiYoyMounted) return;
  window.__sumiYoyMounted = true;

  var css = [
    '.sumi-delta{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:999px;font-size:.66rem;font-weight:700;font-family:"DM Mono",monospace;margin-left:6px;vertical-align:middle}',
    '.sumi-delta.up{background:rgba(34,197,94,.12);color:#15803D;border:1px solid rgba(34,197,94,.25)}',
    '.sumi-delta.down{background:rgba(239,68,68,.12);color:#B91C1C;border:1px solid rgba(239,68,68,.25)}',
    '.sumi-delta.flat{background:rgba(100,116,139,.1);color:#64748B;border:1px solid rgba(100,116,139,.2)}',
  ].join('');
  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  function pct(cur, ref) {
    if (!ref || !isFinite(ref)) return null;
    return ((cur - ref) / Math.abs(ref)) * 100;
  }

  function badge(cur, ref, label) {
    var p = pct(cur, ref);
    if (p === null) return '';
    var cls = Math.abs(p) < 1 ? 'flat' : (p > 0 ? 'up' : 'down');
    var arrow = Math.abs(p) < 1 ? '→' : (p > 0 ? '▲' : '▼');
    var txt = (p > 0 ? '+' : '') + p.toFixed(1) + '% ' + label;
    return '<span class="sumi-delta ' + cls + '" title="' + label + ': ' + Math.round(ref).toLocaleString('es-MX') + '">' +
           arrow + ' ' + txt + '</span>';
  }

  /** Anexar badges a un elemento KPI. data = { actual, mes_pasado, anio_pasado } */
  function attachBadges(kpiEl, data) {
    if (!kpiEl || !data) return;
    var valEl = kpiEl.querySelector('.kpi-val, .kpi-value, .metric-value, .value');
    if (!valEl) return;
    if (valEl.querySelector('.sumi-delta')) return; // ya inyectado
    var html = '';
    if (data.mes_pasado != null) html += badge(data.actual, data.mes_pasado, 'MoM');
    if (data.anio_pasado != null) html += badge(data.actual, data.anio_pasado, 'YoY');
    if (html) valEl.insertAdjacentHTML('beforeend', ' ' + html);
  }

  /** Carga deltas desde el servidor para un set de métricas.
   *  Busca nodos con data-metric="ventas_mes" y los decora. */
  function hydrate() {
    var nodes = document.querySelectorAll('[data-metric]');
    if (!nodes.length) return;
    var metrics = {};
    nodes.forEach(function (n) { metrics[n.dataset.metric] = true; });
    var dbParam = '';
    try {
      var db = localStorage.getItem('sumi_db') || '';
      if (db) dbParam = '&db=' + encodeURIComponent(db);
    } catch (_) {}
    var keys = Object.keys(metrics).join(',');
    fetch('/api/compare/temporal?metrics=' + encodeURIComponent(keys) + dbParam)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        nodes.forEach(function (n) {
          var m = n.dataset.metric;
          if (data.metrics && data.metrics[m]) attachBadges(n, data.metrics[m]);
        });
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
  setTimeout(hydrate, 1500);
  setTimeout(hydrate, 4000);

  window.SumiYoY = { hydrate: hydrate, attachBadges: attachBadges };
})();
