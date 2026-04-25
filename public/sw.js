/**
 * sw.js — Service Worker de Suminregio (offline-first)
 * ──────────────────────────────────────────────────────────────────────────────
 * Estrategia:
 *   · Shell (HTML, CSS, JS, fonts): cache-first con update on revalidate
 *     → Abre instantáneo incluso sin red. Actualiza en background.
 *   · API (/api/*): network-first con fallback a cache de última respuesta
 *     → Datos siempre frescos cuando hay red; al menos vista stale cuando no.
 *   · Excepción: /api/admin/*, /api/ai/* → solo red (nunca cache, son sensibles)
 */
const CACHE_VERSION = 'sumi-v3';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const API_CACHE     = CACHE_VERSION + '-api';

const SHELL_PRECACHE = [
  '/',
  '/index.html',
  '/ventas.html',
  '/cxc.html',
  '/inventario.html',
  '/resultados.html',
  '/consumos.html',
  '/vendedores.html',
  '/clientes.html',
  '/margen-producto.html',
  '/director.html',
  '/nav.js',
  '/filters.js',
  '/data-cache.js',
  '/visual-polish.css',
  '/cxc-redesign.css',
  '/module-polish.css',
  '/mobile-enhance.css',
  '/export-utils.js',
  '/global-search.js',
  '/keyboard-shortcuts.js',
  '/yoy-badges.js',
  '/kpi-notes.js',
  '/presentation-mode.js',
  '/tour-guide.js',
  '/push-client.js',
  '/xlsx-export.js',
  '/comparar.html',
  '/aurora-background.js',
  '/app-ui.css',
  '/app-ui-boot.js',
  '/design-upgrade.css',
  '/mobile.css',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// Rutas API que NO deben cachear (sensibles/admin/IA en tiempo real)
const API_NO_CACHE = [/^\/api\/admin\//, /^\/api\/ai\//, /^\/api\/cache\//];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_PRECACHE).catch((err) => {
        console.warn('[SW] precache parcial:', err);
      })
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('sumi-') && !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Solo same-origin
  if (url.origin !== self.location.origin) return;

  // API sensible: siempre red, sin cache
  if (API_NO_CACHE.some((rx) => rx.test(url.pathname))) return;

  // API normal: network-first, cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Shell: cache-first, revalidate en background
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(API_CACHE).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) {
      // Marcamos respuesta como stale para que el frontend pueda detectarlo
      const h = new Headers(cached.headers);
      h.set('X-From-SW-Cache', 'stale');
      return new Response(await cached.blob(), { status: cached.status, headers: h });
    }
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => cached);
  return cached || fetchPromise;
}

// ── Push notifications ─────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { title: 'Suminregio', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Suminregio', {
      body: data.body || '',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: data.tag || 'sumi-notif',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((wins) => {
      for (const c of wins) { if (c.url.includes(url) && 'focus' in c) return c.focus(); }
      return clients.openWindow(url);
    })
  );
});

// Permite al frontend pedir un flush manual
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});
