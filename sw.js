/* sw.js — Service Worker minimalista para Suminregio Dashboard.
 *
 * Estrategia:
 *  - Estáticos (HTML/JS/CSS/img/fuentes): network-first con cache de fallback
 *    para que un Render frío de 30s no deje al usuario en blanco.
 *  - API (/api/*): network-only (datos siempre frescos), pero captura errores
 *    de red devolviendo el último response cacheado si existe.
 *  - Versionado por CACHE_NAME — bump al deployar para invalidar.
 */

// __CACHE_VERSION__ es reemplazado por el server con el hash del commit actual.
// Si server lo sirve "as-is" (file:// o desarrollo), usamos 'dev' como fallback.
const CACHE_VERSION = '__CACHE_VERSION__' === ('__CACHE_VERSION' + '__') ? 'dev' : '__CACHE_VERSION__';
const CACHE_NAME = 'suminregio-api-' + CACHE_VERSION;
const ASSET_CACHE = 'suminregio-assets-' + CACHE_VERSION;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/safe-dom.js',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME && k !== ASSET_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // No interceptar cross-origin (CDNs, fonts.googleapis.com)
  if (url.origin !== self.location.origin) return;

  // API: network-first con fallback al último cacheado.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then((resp) => {
        // Cache solo GETs 200 que sean razonablemente pequeños
        if (resp && resp.ok && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => null);
        }
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || new Response(
        JSON.stringify({ ok: false, offline: true, error: 'Sin conexión' }),
        { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
      )))
    );
    return;
  }

  // Estáticos: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const fetchPromise = fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(ASSET_CACHE).then((c) => c.put(req, clone)).catch(() => null);
        }
        return resp;
      }).catch(() => hit);
      return hit || fetchPromise;
    })
  );
});

// Comunicación con la página: forzar update de cache.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});
