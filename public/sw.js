/**
 * sw.js — Desactivado para apps con login por sesión.
 * Limpia cachés antiguas (offline-first rompía el redirect al login) y no intercepta fetch.
 * Push: si en el futuro se reactiva, usar estrategia network-only para *.html protegidos.
 */
self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys.map(function (k) {
            return caches.delete(k);
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

// Sin listener 'fetch' → el navegador va siempre a red (no hay cache-first de HTML).

self.addEventListener('push', function (event) {
  event.waitUntil(
    (function () {
      if (!event.data) {
        return Promise.resolve({ title: 'Suminregio', body: '' });
      }
      return event.data.json().catch(function () {
        try {
          return { title: 'Suminregio', body: event.data.text() };
        } catch (_) {
          return { title: 'Suminregio', body: '' };
        }
      });
    })().then(function (data) {
      return self.registration.showNotification(data.title || 'Suminregio', {
        body: data.body || '',
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: data.tag || 'sumi-notif',
        data: { url: data.url || '/' },
      });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        if (wins[i].url.indexOf(url) !== -1 && 'focus' in wins[i]) return wins[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('message', function (event) {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data.type === 'CLEAR_CACHE') {
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return caches.delete(k); }));
    });
  }
});
