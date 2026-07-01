/* no-motion.js — Desactiva TODO el movimiento de carga (a pedido del usuario).
   Fuerza que window.matchMedia('(prefers-reduced-motion: reduce)') reporte matches=true,
   así todo el código de animación/conteo que ya respeta reduced-motion se salta solo.
   DEBE cargar ANTES que cualquier otro script (primer <script> del <head>).
   No toca datos ni lógica: solo evita las animaciones de entrada y el conteo de cifras. */
(function () {
  'use strict';
  try {
    var _mm = window.matchMedia;
    if (typeof _mm !== 'function') return;
    window.matchMedia = function (q) {
      if (typeof q === 'string' && /prefers-reduced-motion\s*:\s*reduce/i.test(q)) {
        return {
          matches: true, media: q, onchange: null,
          addListener: function () {}, removeListener: function () {},
          addEventListener: function () {}, removeEventListener: function () {},
          dispatchEvent: function () { return false; }
        };
      }
      return _mm.call(window, q);
    };
  } catch (e) { /* noop */ }
})();
