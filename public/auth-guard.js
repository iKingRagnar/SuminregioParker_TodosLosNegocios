/**
 * auth-guard.js — Redirige al login cuando:
 *  - AUTH_PROVIDER=session y no hay usuario, o
 *  - modo dummy (usuario anónimo) en un host que no es localhost (despliegue mal configurado).
 */
(function () {
  'use strict';
  if (window.__SUMINREGIO_AUTH_GUARD_V4__) return;
  window.__SUMINREGIO_AUTH_GUARD_V4__ = true;

  if (typeof location === 'undefined' || location.protocol === 'file:') return;
  var path = location.pathname || '';
  if (/login\.html$/i.test(path) || /portal\.html$/i.test(path)) return;
  if (path.indexOf('/2bi/') !== -1 || /2bi\.html$/i.test(path)) return;

  function isLocalDevHost() {
    var h = (location.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '' || h === '[::1]';
  }

  function isAnonDummyUser(d) {
    if (!d || !d.user) return false;
    if (String(d.provider || '').toLowerCase() !== 'dummy') return false;
    var u = d.user;
    if (u.id === 'anon') return true;
    if (String(u.email || '').toLowerCase() === 'anon@suminregio.local') return true;
    return false;
  }

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
      var nextQ = encodeURIComponent(location.pathname + location.search + location.hash || '');
      if (prov === 'session' && (!d || !d.user)) {
        location.replace('/login.html?next=' + nextQ);
        return;
      }
      if (!isLocalDevHost() && isAnonDummyUser(d)) {
        location.replace('/login.html?next=' + nextQ + '&misconfigured=1');
        return;
      }
      release();
    })
    .catch(function () { release(); });
})();
