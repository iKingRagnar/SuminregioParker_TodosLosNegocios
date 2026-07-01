/* ============================================================================
   SUMINREGIO PARKER — Motor de animaciones de entrada
   Usar junto con design-system.css. No requiere librerías externas.

   Cómo usarlo:
     1. Marca los elementos en tu HTML con las clases:
          .sp-rise      → sección/tarjeta que aparece con fade + slide-up
          .sp-grid      → contenedor de tarjetas: cada hijo hace rise con stagger
          .sp-bar-fill  → barra horizontal que crece de 0% a 100% width
          .sp-vbar      → barra vertical que crece de 0% a 100% height
          .sp-draw      → <path>/<polyline> de una gráfica de línea SVG que se "dibuja"
          .sp-count     → número (texto) que hace count-up animado

     2. Al montar la página (DOMContentLoaded o equivalente del framework):
          initEntrance('sp-root');   // 'sp-root' = id del contenedor raíz de la página
   ============================================================================ */

(function (global) {
  'use strict';

  function runEntranceAnimations(rootEl) {
    var ease = 'cubic-bezier(.18,.7,.25,1)';
    var easeBar = 'cubic-bezier(.3,.85,.3,1)';

    function rise(el, delay) {
      try {
        el.animate(
          [{ opacity: 0, transform: 'translateY(26px)' }, { opacity: 1, transform: 'none' }],
          { duration: 640, delay: delay, easing: ease, fill: 'backwards' }
        );
      } catch (e) {}
    }

    rootEl.querySelectorAll('.sp-rise').forEach(function (el, i) { rise(el, 50 + i * 70); });
    rootEl.querySelectorAll('.sp-grid').forEach(function (g) {
      Array.prototype.slice.call(g.children).forEach(function (c, i) { rise(c, 150 + i * 70); });
    });

    rootEl.querySelectorAll('.sp-bar-fill').forEach(function (b, i) {
      try {
        b.animate(
          [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
          { duration: 1000, delay: 300 + (i % 8) * 45, easing: easeBar, fill: 'backwards' }
        );
      } catch (e) {}
    });

    rootEl.querySelectorAll('.sp-vbar').forEach(function (b, i) {
      try {
        b.animate(
          [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
          { duration: 720, delay: 250 + (i % 24) * 30, easing: easeBar, fill: 'backwards' }
        );
      } catch (e) {}
    });

    rootEl.querySelectorAll('.sp-draw').forEach(function (p) {
      try {
        var len = p.getTotalLength(); // funciona en <path> y <polyline>
        p.style.strokeDasharray = len;
        p.animate(
          [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
          { duration: 1500, delay: 360, easing: 'cubic-bezier(.4,.6,.3,1)', fill: 'backwards' }
        );
      } catch (e) {}
    });

    rootEl.querySelectorAll('.sp-count').forEach(function (el, i) {
      var raw = (el.textContent || '').trim();
      // separa prefijo ($, etc.), número, sufijo (%, etc.)
      var m = raw.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/);
      if (!m) return;
      var pre = m[1], suf = m[3], dec = (m[2].split('.')[1] || '').length;
      var target = parseFloat(m[2].replace(/,/g, ''));
      if (!isFinite(target)) return;
      var dur = 1100, t0 = performance.now() + 300 + (i % 8) * 55;
      function fmtN(v) {
        return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      }
      el.dataset.cv = raw; // valor final real, por si se corta antes de terminar
      function step(now) {
        var p = Math.max(0, Math.min(1, (now - t0) / dur));
        p = 1 - Math.pow(1 - p, 3); // ease-out cubic
        el.textContent = pre + fmtN(target * p) + suf;
        if (p < 1) requestAnimationFrame(step); else el.textContent = raw;
      }
      requestAnimationFrame(step);
    });
  }

  // Guard anti doble-disparo + finalizador de seguridad a los 2.8s
  function initEntrance(rootId) {
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var root = document.getElementById(rootId);

    function guarded() {
      if (root && root.dataset.spAnimated) return;
      if (root) root.dataset.spAnimated = '1';
      runEntranceAnimations(root || document);
    }

    requestAnimationFrame(function () { requestAnimationFrame(guarded); });
    setTimeout(guarded, 170);

    setTimeout(function () {
      try {
        var r = document.getElementById(rootId) || document;
        function finish(el) {
          if (el.getAnimations) {
            el.getAnimations().forEach(function (a) {
              if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish();
            });
          }
        }
        r.querySelectorAll('.sp-rise,.sp-bar-fill,.sp-vbar,.sp-draw').forEach(finish);
        r.querySelectorAll('.sp-grid').forEach(function (g) {
          Array.prototype.slice.call(g.children).forEach(finish);
        });
        r.querySelectorAll('.sp-count').forEach(function (el) {
          if (el.dataset.cv) el.textContent = el.dataset.cv;
        });
      } catch (e) {}
    }, 2800);
  }

  global.SPAnimations = { runEntranceAnimations: runEntranceAnimations, initEntrance: initEntrance };
})(typeof window !== 'undefined' ? window : this);
