/* pwa-register.js — Registra el Service Worker desde cualquier página.
 *
 * Uso (en cada .html antes de </body>):
 *   <link rel="manifest" href="/manifest.webmanifest">
 *   <script src="/pwa-register.js" defer></script>
 *
 * No-op si:
 *   - navegador sin SW
 *   - servido por file:// (dev local sin server)
 *   - hostname incluye 'ngrok' (evita SW raros en túnel temporal)
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  if (/ngrok|localhost|127\.0\.0\.1/i.test(location.hostname)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js')
      .then(function (reg) {
        // Auto-actualizar cuando hay un SW nuevo esperando
        reg.addEventListener('updatefound', function () {
          var newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function () {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // Hay update — el siguiente reload usará el SW nuevo.
              if (window.console) console.info('[PWA] update disponible, activa con reload.');
            }
          });
        });
      })
      .catch(function (e) {
        if (window.console) console.warn('[PWA] SW registration failed:', e.message);
      });
  });
})();
