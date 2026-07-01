/* ============================================================================
   SUMINREGIO PARKER — PREMIUM UPLIFT (animaciones de entrada)
   Motor vanilla del handoff de Claude Design. Solo presentacional:
   NO toca datos, endpoints, ni Chart.js. Respeta prefers-reduced-motion.
   Marca elementos con .sp-rise / .sp-count / .sp-bar-fill / .sp-vbar / .sp-draw
   y también anima .kpi-card / .sc-card / .card automáticamente al cargar.
   ============================================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rise(el, delay) {
    try {
      el.animate(
        [{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'none' }],
        { duration: 620, delay: delay, easing: 'cubic-bezier(.18,.7,.25,1)', fill: 'backwards' }
      );
    } catch (e) {}
  }

  function countUp(el, i) {
    var raw = (el.textContent || '').trim();
    var m = raw.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
    if (!m) return;
    var pre = m[1], suf = m[3], dec = (m[2].split('.')[1] || '').length;
    var target = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(target)) return;
    var dur = 1050, t0 = performance.now() + 260 + (i % 8) * 55;
    var fmtN = function (v) { return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }); };
    el.dataset.puFinal = raw;
    var step = function (now) {
      var p = Math.max(0, Math.min(1, (now - t0) / dur));
      p = 1 - Math.pow(1 - p, 3);
      el.textContent = pre + fmtN(target * p) + suf;
      if (p < 1) requestAnimationFrame(step); else el.textContent = raw;
    };
    requestAnimationFrame(step);
  }

  function run(root) {
    if (reduce) return;
    var r = root || document;

    // Elementos marcados explícitamente
    r.querySelectorAll('.sp-rise').forEach(function (el, i) { rise(el, 40 + i * 65); });

    // Auto-stagger de las tarjetas reales de la app (sin tocar su markup)
    ['.kpi-mega-grid', '.kpi-grid', '.sc-grid', '.aging-grid', '.uni-card-grid'].forEach(function (sel) {
      r.querySelectorAll(sel).forEach(function (g) {
        [].slice.call(g.children).forEach(function (c, i) { rise(c, 120 + i * 62); });
      });
    });

    // Barras horizontales / verticales marcadas
    r.querySelectorAll('.sp-bar-fill').forEach(function (b, i) {
      try { b.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
        { duration: 950, delay: 280 + (i % 8) * 45, easing: 'cubic-bezier(.3,.85,.3,1)', fill: 'backwards', transformOrigin: 'left' }); } catch (e) {}
    });
    r.querySelectorAll('.sp-vbar').forEach(function (b, i) {
      try { b.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
        { duration: 700, delay: 240 + (i % 24) * 30, easing: 'cubic-bezier(.3,.85,.3,1)', fill: 'backwards', transformOrigin: 'bottom' }); } catch (e) {}
    });
    // Líneas SVG marcadas
    r.querySelectorAll('.sp-draw').forEach(function (p) {
      try {
        var len = p.getTotalLength();
        p.style.strokeDasharray = len;
        p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
          { duration: 1400, delay: 340, easing: 'cubic-bezier(.4,.6,.3,1)', fill: 'backwards' });
      } catch (e) {}
    });
    // Count-up de KPIs marcados
    r.querySelectorAll('.sp-count').forEach(function (el, i) { countUp(el, i); });
  }

  var done = false;
  function init() {
    if (done) return; done = true;
    requestAnimationFrame(function () { requestAnimationFrame(function () { run(document); }); });
    // Finalizador de seguridad: fuerza estado final por si algo quedó pendiente
    setTimeout(function () {
      try {
        document.querySelectorAll('.sp-count').forEach(function (el) { if (el.dataset.puFinal) el.textContent = el.dataset.puFinal; });
      } catch (e) {}
    }, 2800);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PremiumUplift = { run: run };
})();
