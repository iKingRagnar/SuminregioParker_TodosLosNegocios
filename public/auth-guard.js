/**
 * auth-guard.js — Redirige al login cuando no hay sesión válida o el servidor está en dummy en hosting.
 * Si /api/auth/me falla en producción, redirige al login (no se muestra el panel a ciegas).
 */
(function () {
  'use strict';
  if (window.__SUMINREGIO_AUTH_GUARD_V5__) return;
  window.__SUMINREGIO_AUTH_GUARD_V5__ = true;

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

  function goLogin(qs) {
    var nextQ = encodeURIComponent(location.pathname + location.search + location.hash || '');
    location.replace('/login.html?next=' + nextQ + (qs ? '&' + qs : ''));
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
  var isLocal = isLocalDevHost();

  var watchdog = setTimeout(function () {
    if (!isLocal) goLogin('gate=timeout');
    else release();
  }, 12000);

  function done() {
    try {
      clearTimeout(watchdog);
    } catch (_) {}
  }

  fetch(base + '/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) {
      return r.text().then(function (text) {
        var d = null;
        try {
          d = text ? JSON.parse(text) : null;
        } catch (_) {
          d = { _badJson: true };
        }
        return { ok: r.ok, status: r.status, d: d };
      });
    })
    .then(function (pack) {
      done();
      if (!pack.ok || !pack.d || pack.d._badJson) {
        if (!isLocal) goLogin('gate=me');
        else release();
        return;
      }
      var d = pack.d;
      var prov = String((d && d.provider) || '').toLowerCase();
      if (prov === 'session' && (!d || !d.user)) {
        goLogin();
        return;
      }
      if (!isLocal && isAnonDummyUser(d)) {
        goLogin('misconfigured=1');
        return;
      }
      release();
    })
    .catch(function () {
      done();
      if (!isLocal) goLogin('gate=net');
      else release();
    });
})();
