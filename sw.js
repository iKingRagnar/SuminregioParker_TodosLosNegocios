/* sw.js — Service Worker para Suminregio Dashboard.
 *
 * Estrategia:
 *  - HTML / JS / CSS: NETWORK-FIRST con timeout. Siempre intenta traer la
 *    versión recién deployada; sólo cae a caché si la red falla o Render está
 *    frío (timeout). Esto garantiza que los cambios/deploys se vean de
 *    inmediato y no se queden "pegados" en una versión vieja.
 *  - Imágenes / fuentes / manifest: cache-first (stale-while-revalidate) —
 *    cambian poco y conviene carga instantánea.
 *  - API (/api/*): network-only con fallback al último cacheado si no hay red.
 *  - Versionado por CACHE_NAME — bump automático al deployar (hash del commit).
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

// ¿El recurso es "código" (HTML/JS/CSS) que debe venir siempre fresco?
function esCodigo(req, url) {
  if (req.mode === 'navigate' || req.destination === 'document') return true;
  if (req.destination === 'script' || req.destination === 'style') return true;
  return /\.(html|js|mjs|css)$/i.test(url.pathname);
}

// Network-first con timeout: intenta red; si tarda > timeoutMs o falla, usa caché.
function networkFirst(req, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (resp) => { if (!done) { done = true; resolve(resp); } };

    const timer = setTimeout(() => {
      caches.match(req).then((hit) => { if (hit) finish(hit); });
    }, timeoutMs);

    fetch(req).then((resp) => {
      clearTimeout(timer);
      if (resp && resp.ok) {
        const clone = resp.clone();
        caches.open(ASSET_CACHE).then((c) => c.put(req, clone)).catch(() => null);
      }
      finish(resp);
    }).catch(() => {
      clearTimeout(timer);
      caches.match(req).then((hit) => finish(hit || Response.error()));
    });
  });
}

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

  // HTML / JS / CSS: network-first (timeout 4s) → siempre lo último cuando hay red.
  if (esCodigo(req, url)) {
    event.respondWith(networkFirst(req, 4000));
    return;
  }

  // Imágenes / fuentes / otros estáticos: cache-first con revalidación.
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

