/* ============================================================================
   SUMINREGIO PARKER — PREMIUM UPLIFT (runtime del reskin Claude Design)
   SOLO presentacional. NO toca datos, endpoints, queries ni datasets de Chart.js.
   Hace: (1) forzar el fondo crema cálido, (2) agrupar el menú PANEL/INTELIGENCIA,
   (3) config global premium de Chart.js (tooltip/fuentes/grid — sin tocar datos),
   (4) animaciones de entrada. Respeta prefers-reduced-motion.
   ============================================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Fondo crema cálido (gana a temas previos con !important vía JS) ────── */
  function forceBg() {
    try {
      var grad = 'radial-gradient(1200px 720px at 6% -8%,rgba(224,179,65,.18),transparent 55%),' +
                 'radial-gradient(1100px 760px at 104% 6%,rgba(120,86,40,.08),transparent 52%),' +
                 'linear-gradient(180deg,#FBF7EE 0%,#F2ECDE 60%,#EDE6D6 100%)';
      document.documentElement.style.setProperty('background', '#EFE9DC', 'important');
      document.body.style.setProperty('background-color', '#EFE9DC', 'important');
      document.body.style.setProperty('background-image', grad, 'important');
      document.body.style.setProperty('background-attachment', 'fixed', 'important');
    } catch (e) { console.error('[premium] bg', e && e.message); }
  }

  /* ── 2. Agrupar menú: "MENÚ" -> "PANEL" + insertar "INTELIGENCIA" ──────────── */
  function groupNav() {
    try {
      var labels = document.querySelectorAll('#app-sidebar .sb-nav-label');
      labels.forEach(function (l) { if (/^\s*men[uú]/i.test(l.textContent)) l.textContent = 'PANEL'; });
      if (document.getElementById('pu-intel-label')) return;
      var links = [].slice.call(document.querySelectorAll('#app-sidebar .nav-link'));
      var sumi = null;
      for (var i = 0; i < links.length; i++) {
        var a = links[i]; var h = a.getAttribute('href') || '';
        if (/sumi\s*ia/i.test(a.textContent) || /(^|\/)ia\.html/i.test(h)) { sumi = a; break; }
      }
      if (sumi) {
        var lab = document.createElement('div');
        lab.id = 'pu-intel-label'; lab.className = 'sb-nav-label'; lab.textContent = 'INTELIGENCIA';
        lab.style.cssText = 'margin-top:14px;padding:.3rem .55rem .5rem;';
        sumi.parentNode.insertBefore(lab, sumi);
      }
    } catch (e) { console.error('[premium] groupNav', e && e.message); }
  }

  /* ── 3. Chart.js: config global premium (NO toca datasets/datos) ───────────── */
  function styleCharts() {
    try {
      if (!window.Chart || !Chart.defaults) return;
      var C = Chart.defaults;
      C.font = C.font || {};
      C.font.family = "'DM Mono', monospace";
      C.color = '#A2937A';
      C.borderColor = 'rgba(31,24,12,.06)';
      if (C.plugins && C.plugins.legend) {
        C.plugins.legend.labels = C.plugins.legend.labels || {};
        C.plugins.legend.labels.usePointStyle = true;
        C.plugins.legend.labels.boxWidth = 8;
        C.plugins.legend.labels.font = { family: "'Outfit', sans-serif", size: 11, weight: '500' };
      }
      if (C.plugins && C.plugins.tooltip) {
        var t = C.plugins.tooltip;
        t.backgroundColor = '#211A10';
        t.titleFont = { family: "'Fraunces', serif", size: 12, weight: '600' };
        t.bodyFont = { family: "'DM Mono', monospace", size: 11 };
        t.padding = 10; t.cornerRadius = 10; t.boxPadding = 4;
      }
    } catch (e) { console.error('[premium] charts', e && e.message); }
  }
  // Aplica en cuanto Chart esté disponible (antes de que las páginas creen sus charts)
  (function waitChart(n) {
    if (window.Chart && Chart.defaults) { styleCharts(); return; }
    if (n > 40) return;
    setTimeout(function () { waitChart(n + 1); }, 60);
  })(0);

  /* ── 4. Animaciones de entrada ─────────────────────────────────────────────── */
  function rise(el, delay) {
    try { el.animate([{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'none' }],
      { duration: 620, delay: delay, easing: 'cubic-bezier(.18,.7,.25,1)', fill: 'backwards' }); } catch (e) {}
  }
  function animate() {
    if (reduce) return;
    document.querySelectorAll('.sp-rise').forEach(function (el, i) { rise(el, 40 + i * 65); });
    ['.kpi-mega-grid', '.kpi-grid', '.sc-grid', '.aging-grid', '.uni-card-grid'].forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (g) {
        [].slice.call(g.children).forEach(function (c, i) { rise(c, 120 + i * 62); });
      });
    });
  }

  function init() {
    forceBg(); groupNav(); styleCharts();
    requestAnimationFrame(function () { requestAnimationFrame(animate); });
    // Re-forzar el fondo por si un theme-toggle tardío lo pisa
    setTimeout(forceBg, 400);
    setTimeout(function () { forceBg(); groupNav(); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PremiumUplift = { forceBg: forceBg, groupNav: groupNav };
})();
