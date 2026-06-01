/* pwa-register.js — DESINSTALADOR de Service Worker (sin registrar, sin recargar).
 *
 * Antes registraba un SW. Combinado con un SW que se auto-recargaba, provocaba
 * un LOOP de recarga infinito. Ahora solo limpia: desregistra cualquier SW
 * existente y borra sus cachés, UNA sola vez, SIN recargar la página.
 * Resultado: el sitio funciona siempre contra la red, sin SW.
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (reg) { try { reg.unregister(); } catch (_) {} });
    }).catch(function () {});
  } catch (_) {}
  try {
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) { try { caches.delete(k); } catch (_) {} });
      }).catch(function () {});
    }
  } catch (_) {}
})();
