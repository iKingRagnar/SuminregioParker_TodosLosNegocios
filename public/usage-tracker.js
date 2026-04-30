/**
 * Métricas de uso: tiempo activo visible por pestaña (Page Visibility API).
 * Envía page_enter al cargar y page_leave al salir (pagehide / beforeunload).
 */
(function () {
  'use strict';
  if (window.__SUMINREGIO_USAGE_TRACKER_V1__) return;
  window.__SUMINREGIO_USAGE_TRACKER_V1__ = true;
  if (typeof location === 'undefined' || location.protocol === 'file:') return;
  var p = (location.pathname || '').toLowerCase();
  if (p.indexOf('login.html') >= 0 || p.indexOf('portal.html') >= 0) return;

  var path = location.pathname + location.search;
  try {
    if (!sessionStorage.getItem('sumi_usage_tab')) {
      sessionStorage.setItem('sumi_usage_tab', 't_' + Math.random().toString(36).slice(2) + '_' + Date.now());
    }
  } catch (_) {}
  var tabId = '';
  try {
    tabId = sessionStorage.getItem('sumi_usage_tab') || '';
  } catch (_) {}

  var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE.replace(/\/+$/, '') : '';

  function post(type, durationMs) {
    try {
      fetch(base + '/api/usage/track', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: type,
          path: path,
          durationMs: durationMs == null ? null : durationMs,
          tabId: tabId,
        }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  post('page_enter', null);

  var activeMs = 0;
  var segmentStart = document.hidden ? 0 : Date.now();
  var left = false;

  function closeSegment() {
    if (segmentStart) {
      activeMs += Date.now() - segmentStart;
      segmentStart = 0;
    }
  }

  function openSegment() {
    if (!document.hidden) segmentStart = Date.now();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) closeSegment();
    else openSegment();
  });

  function flushLeave() {
    if (left) return;
    left = true;
    closeSegment();
    if (activeMs < 500) return;
    post('page_leave', activeMs);
  }

  window.addEventListener('pagehide', flushLeave);
  window.addEventListener('beforeunload', flushLeave);
})();
