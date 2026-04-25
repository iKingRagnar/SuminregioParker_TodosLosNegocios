/**
 * sw.js — KILL SWITCH SERVICE WORKER
 * ──────────────────────────────────────────────────────────────────────────────
 * Este SW reemplaza al anterior (sumi-v3 / sumi-v4 con offline-first cache) que
 * estaba sirviendo nav.js / filters.js viejos desde caché incluso tras los
 * deploys. La estrategia stale-while-revalidate guardaba JS del shell por
 * encima del Cache-Control: no-store que manda el servidor, así que los fixes
 * a la barra de "Unidad de negocio" no llegaban al usuario.
 *
 * Funcionamiento:
 *   · install   → skipWaiting() para tomar el control inmediato.
 *   · activate  → borra TODOS los caches sumi-* y luego se autodesregistra.
 *   · message   → responde a CLEAR_CACHE manualmente.
 *   · fetch     → NO se intercepta nada. Todas las requests van directo al
 *                 servidor (que ya tiene Cache-Control: no-store en .html/.js).
 *
 * Resultado: tras el primer reload el SW limpia su propio rastro y deja la app
 * sin cache layer. Se pierde la capacidad offline pero se gana que cada reload
 * siempre traiga el código real del deploy.
 *
 * Para volver a habilitar offline cuando esto se estabilice, reemplazar este
 * archivo por una estrategia network-first (no stale-while-revalidate) y
 * versión bumpeable, no por la vieja v3.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 1. Borra todos los caches viejos (sumi-v3-*, sumi-v4-*, etc.)
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('sumi-')).map(k => caches.delete(k)));
    } catch (_) { /* no-op */ }

    // 2. Toma control de las pestañas abiertas (necesario antes de navigate()).
    try { await self.clients.claim(); } catch (_) { /* no-op */ }

    // 3. Recarga las pestañas activas para que descarten el nav.js/filters.js
    //    viejo que ya tienen en memoria. Esto pasa ANTES del unregister porque
    //    Client.navigate() solo funciona mientras el SW controle al cliente.
    try {
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach(c => { try { c.navigate(c.url); } catch (_) {} });
    } catch (_) { /* no-op */ }

    // 4. Auto-desregistro: a partir de aquí ya no hay SW controlando la app.
    //    Los reload subsiguientes van directo al servidor.
    try {
      const reg = await self.registration;
      if (reg) await reg.unregister();
    } catch (_) { /* no-op */ }
  })());
});

// Sin handler de fetch → todas las requests pasan directo al servidor.

self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});
