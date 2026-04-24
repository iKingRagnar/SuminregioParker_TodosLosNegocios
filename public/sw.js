/**
 * sw.js — Service Worker de Suminregio
 * ──────────────────────────────────────────────────────────────────────────────
 * v4-auth-migration: bumpeo de versión para invalidar caches viejos que servían
 * HTML del dashboard sin pasar por el gate de /login (causaba que el usuario
 * viera Panel Ejecutivo con $0 en vez del login page tras activar auth v2).
 *
 * Estrategia:
 *   · HTML (navegación): NETWORK-FIRST siempre. Así el middleware de auth del
 *     server puede redirigir a /login cuando no hay cookie. Si no hay red,
 *     fallback a último HTML cacheado para vista offline.
 *   · Scripts estáticos (JS, CSS, fonts, imágenes): stale-while-revalidate.
 *     Carga instantánea desde cache + refresh en background.
 *   · API (/api/*): network-first con fallback a cache. Datos siempre frescos.
 *   · API sensible (/api/admin/*, /api/ai/*, /api/auth/*, /api/cache/*):
 *     solo red, nunca cache.
 *
 * Al activar esta versión, se eliminan TODOS los caches anteriores (sumi-v*).
 * Se envía un mensaje a todos los clientes para que recarguen automáticamente
 * y vean el login/dashboard nuevo sin necesidad de limpiar cache manual.
 */
const CACHE_VERSION = 'sumi-v4-auth-migration';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const API_CACHE     = CACHE_VERSION + '-api';
const HTML_CACHE    = CACHE_VERSION + '-html';

// Solo precacheamos assets estáticos (no HTML). Los HTML viven en HTML_CACHE
// pero se pueblan on-demand vía network-first, nunca se pre-cachean.
const SHELL_PRECACHE = [
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
  '/aurora-background.js',
  '/app-ui.css',
  '/app-ui-boot.js',
  '/design-upgrade.css',
  '/mobile.css',
  '/favicon.svg',
  '/manifest.webmanifest',
];

// Rutas API que NO deben cachear (sensibles o que cambian auth state)
const API_NO_CACHE = [
  /^\/api\/admin\//,
  /^\/api\/ai\//,
  /^\/api\/auth\//,
  /^\/api\/cache\//,
];

self.addEventListener('install', (event) => {
  // Activar inmediatamente sin esperar cierre de pestañas
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_PRECACHE).catch((err) => {
        console.warn('[SW v4] precache parcial:', err);
      })
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Borrar TODOS los caches viejos (sumi-v1, sumi-v2, sumi-v3, etc.)
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('sumi-') && !k.startsWith(CACHE_VERSION))
        .map((k) => caches.delete(k))
    );
    // Tomar control de todas las pestañas abiertas inmediatamente
    await self.clients.claim();
    // Avisar a cada cliente para que recargue y vea la versión nueva
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      try { client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }); } catch (_) {}
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 1. API sensible: siempre red, nunca cache
  if (API_NO_CACHE.some((rx) => rx.test(url.pathname))) return;

  // 2. API normal: network-first con cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // 3. HTML (navegación): NETWORK-FIRST siempre, así el auth gate del server
  //    tiene oportunidad de redirigir a /login cuando no hay cookie válida.
  //    Sin esto, el SW servía HTML cacheado y la redirección nunca ocurría.
  const accept = req.headers.get('accept') || '';
  const isHtmlNav = req.mode === 'navigate'
                 || accept.includes('text/html')
                 || url.pathname.endsWith('.html')
                 || url.pathname === '/'
                 || (!url.pathname.includes('.') && !url.pathname.startsWith('/api/'));
  if (isHtmlNav) {
    event.respondWith(networkFirstHTML(req));
    return;
  }

  // 4. Assets estáticos (JS, CSS, fuentes, imágenes): stale-while-revalidate
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    // Solo cacheamos 200s (no cacheamos 401, 403, redirects)
    if (res && res.status === 200) {
      const clone = res.clone();
      caches.open(cacheName).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('X-From-SW-Cache', 'stale');
      return new Response(await cached.blob(), { status: cached.status, headers: h });
    }
    throw err;
  }
}

async function networkFirstHTML(req) {
  try {
    // Siempre intenta red primero. Si el server redirige (302 a /login) el browser
    // sigue el redirect naturalmente. Si devuelve 401 no lo cacheamos.
    const res = await fetch(req, { redirect: 'follow' });
    if (res && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(HTML_CACHE).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (err) {
    // Sin red: intenta servir HTML cacheado como último recurso
    const cached = await caches.match(req);
    if (cached) {
      const h = new Headers(cached.headers);
      h.set('X-From-SW-Cache', 'offline');
      return new Response(await cached.blob(), { status: cached.status, headers: h });
    }
    // Sin red y sin cache: dejamos que falle para que el browser muestre su error
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
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});
