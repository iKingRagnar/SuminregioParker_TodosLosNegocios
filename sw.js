/* sw.js — Service Worker AUTO-DESTRUCTIVO (kill-switch).
 *
 * Por qué: versiones anteriores instalaron un SW con caché de HTML/JS/CSS, que
 * dejaba el sitio "pegado" en una versión vieja (los cambios/deploys no se
 * veían). Esta versión NO cachea nada y, además, se DESREGISTRA a sí misma y
 * borra todas las cachés, devolviendo el sitio al comportamiento normal del
 * navegador (siempre red). Tras esto, no queda ningún SW activo.
 */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      // 1) Borra TODAS las cachés que dejaron versiones previas del SW.
      try {
        var keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      } catch (_) {}
      // 2) Toma control y se autodesregistra. NO recarga las pestañas (evita
      //    loops de recarga). El desinstalador de pwa-register limpia el resto.
      try { await self.clients.claim(); } catch (_) {}
      try { await self.registration.unregister(); } catch (_) {}
    })()
  );
});

/* Sin listener 'fetch': el navegador va SIEMPRE a la red. Nada se cachea. */
