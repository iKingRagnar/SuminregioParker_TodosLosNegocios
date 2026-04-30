/**
 * auth-guard.js — Si el servidor usa sesión (AUTH_PROVIDER=session) y no hay usuario,
 * redirige al login aunque el HTML llegue desde caché del navegador o Service Worker viejo.
 */
(function () {
  'use strict';
  if (window.__SUMINREGIO_AUTH_GUARD_V3__) return;
  window.__SUMINREGIO_AUTH_GUARD_V3__ = true;

  if (typeof location === 'undefined' || location.protocol === 'file:') return;
  var path = location.pathname || '';
  if (/login\.html$/i.test(path) || /portal\.html$/i.test(path)) return;
  if (path.indexOf('/2bi/') !== -1 || /2bi\.html$/i.test(path)) return;

  try {
    var st = document.createElement('style');
    st.textContent = 'html.suminregio-auth-pending body{visibility:hidden}';
    (document.head || document.documentElement).appendChild(st);
    document.documentElement.classList.add('suminregio-auth-pending');
  } catch (_) {}

  function release() {
    try {
      document.documentElement.classList.remove('suminregio-auth-pending');
    } catch (_) {}
  }

  var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : (location.origin || '');

  fetch(base + '/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var prov = String((d && d.provider) || '').toLowerCase();
      if (prov === 'session' && (!d || !d.user)) {
        var n = encodeURIComponent(location.pathname + location.search + location.hash || '');
        location.replace('/login.html?next=' + n);
        return;
      }
      release();
    })
    .catch(function () { release(); });
})();
