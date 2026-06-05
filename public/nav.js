/**
 * nav.js — Navegación unificada con selector de unidad de negocio global
 * Inyecta header completo en <header> (vacío) o #app-header.
 * Auto-detecta página activa · Selector de DB en todas las páginas.
 */
(function () {
  'use strict';

  if (!window.__SUMINREGIO_AUTH_GUARD_V6__) {
    try {
      var g = document.createElement('script');
      g.src = '/auth-guard.js?v=6';
      g.async = false;
      (document.head || document.documentElement).appendChild(g);
    } catch (_) {}
  }

  // Forzar SIEMPRE light mode — nunca dark. Al inicio para evitar FOUC.
  (function forceLightTheme() {
    try {
      var de = document.documentElement;
      de.classList.add('theme-premium-light');
      de.classList.remove('theme-premium-dark', 'theme-dark', 'dark');
      de.setAttribute('data-theme', 'light');
      // Mantenerlo fijo: si otro script intenta cambiarlo, lo revertimos
      try {
        new MutationObserver(function () {
          if (de.getAttribute('data-theme') !== 'light') de.setAttribute('data-theme', 'light');
          if (!de.classList.contains('theme-premium-light')) de.classList.add('theme-premium-light');
        }).observe(de, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      } catch (_) {}
    } catch (_) {}
  })();

  // Cargar capa visual premium al final del cascade, en todas las páginas
  (function injectVisualPolish() {
    try {
      var head = document.head || document.documentElement;
      function addLink(id, href) {
        if (document.getElementById(id)) return;
        var l = document.createElement('link');
        l.id = id; l.rel = 'stylesheet'; l.href = href;
        head.appendChild(l);
      }
      addLink('vp-polish-css',  '/visual-polish.css?v=5');
      addLink('vp-module-css',  '/module-polish.css?v=1');
      addLink('vp-cxc-css',     '/cxc-redesign.css?v=2');
      addLink('vp-mobile-css',  '/mobile-enhance.css?v=1');

      // Manifest PWA
      if (!document.querySelector('link[rel="manifest"]')) {
        var m = document.createElement('link');
        m.rel = 'manifest'; m.href = '/manifest.webmanifest';
        head.appendChild(m);
      }
      // Theme color (barra del navegador en móvil)
      if (!document.querySelector('meta[name="theme-color"]')) {
        var meta = document.createElement('meta');
        meta.name = 'theme-color'; meta.content = '#E6A800';
        head.appendChild(meta);
      }

      // Fondo aurora
      if (!document.getElementById('vp-aurora-js')) {
        var s = document.createElement('script');
        s.id = 'vp-aurora-js';
        s.src = '/aurora-background.js?v=3';
        s.defer = true;
        head.appendChild(s);
      }
      // Utilidades de exportación (PDF/CSV con botones automáticos)
      if (!document.getElementById('vp-export-js')) {
        var ex = document.createElement('script');
        ex.id = 'vp-export-js';
        ex.src = '/export-utils.js?v=1';
        ex.defer = true;
        head.appendChild(ex);
      }
      // Búsqueda global, atajos, badges temporales, notas, extras
      [
        ['vp-search-js',    '/global-search.js?v=1'],
        ['vp-keyb-js',      '/keyboard-shortcuts.js?v=1'],
        ['vp-yoy-js',       '/yoy-badges.js?v=1'],
        ['vp-notes-js',     '/kpi-notes.js?v=1'],
        ['vp-pres-js',      '/presentation-mode.js?v=1'],
        ['vp-tour-js',      '/tour-guide.js?v=1'],
        ['vp-push-js',      '/push-client.js?v=1'],
        ['vp-xlsx-js',      '/xlsx-export.js?v=1'],
        ['vp-tablefilter-js', '/table-filter.js?v=1'],
      ].forEach(function (pair) {
        if (document.getElementById(pair[0])) return;
        var sc = document.createElement('script');
        sc.id = pair[0]; sc.src = pair[1]; sc.defer = true;
        head.appendChild(sc);
      });

      // Service Worker: NO se registra (causaba loop de recarga). Se desinstala
      // cualquier SW previo y se borran sus cachés, una vez, sin recargar.
      if ('serviceWorker' in navigator) {
        try {
          navigator.serviceWorker.getRegistrations().then(function (regs) {
            regs.forEach(function (reg) { try { reg.unregister(); } catch (_) {} });
          }).catch(function () {});
          if (window.caches && caches.keys) {
            caches.keys().then(function (keys) {
              keys.forEach(function (k) { try { caches.delete(k); } catch (_) {} });
            }).catch(function () {});
          }
        } catch (_) {}
      }
    } catch (_) {}
  })();

  var NAV_LINKS = [
    { href: 'index.html',      label: 'Inicio',      icon: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z' },
    { href: 'ventas.html',     label: 'Ventas',       icon: 'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z' },
    { href: 'cobradas.html',   label: 'Cobradas',     icon: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' },
    { href: 'vendedores.html', label: 'Vendedores',   icon: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z' },
    { href: 'cxc.html',        label: 'CxC',          icon: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z' },
    { href: 'clientes.html',   label: 'Clientes',     icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z' },
    { href: 'director.html',   label: 'Director',     icon: 'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z' },
    { href: 'inventario.html',      label: 'Inventario', icon: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z' },
    { href: 'consumos.html',        label: 'Consumos',   icon: 'M3 3h18v2H3V3zm0 4h18v2H3V7zm0 4h12v2H3v-2zm0 4h18v2H3v-2zm0 4h12v2H3v-2z' },
    { href: 'margen-producto.html', label: 'Margen',     icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93V18h-2v1.93c-3.94-.49-7-3.86-7-7.93s3.05-7.44 7-7.93V6h2V4.07c3.94.49 7 3.86 7 7.93s-3.05 7.44-7 7.93zM12.31 11.14c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5h-2.34v1.71c-1.51.33-2.72 1.31-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H8.04c.1 1.7 1.36 2.66 2.86 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.66-3.42z' },
    { href: 'resultados.html',      label: 'Finanzas', icon: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z' },
    { href: 'usage-metrics.html', label: 'Uso',         icon: 'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055zM20.488 9H15V3.512A9.025 9.025 0 0120.488 9z' },
    { href: 'admin.html',           label: 'Admin',      icon: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1.06 13.54L7.4 11l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41-5.64 5.66z' },
    { href: 'ia.html',        label: 'Sumi IA',      icon: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z' },
    { href: 'mejora-continua.html',      label: 'Mejoras',  icon: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z' },
    { href: 'metas.html',                label: 'Metas',    icon: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z' },
  ];

  var API_ORIGIN = (function () {
    try {
      if (typeof window !== 'undefined' && window.__API_BASE) {
        var b = String(window.__API_BASE || '').replace(/\/+$/, '');
        if (b) return b;
      }
      if (location.protocol === 'file:') return 'http://localhost:7000';
      return location.origin || '';
    } catch (_) { return ''; }
  })();

  var ME_RETRY_MAX = 6;
  var ME_BACKOFF_MS = 140;

  function clearLoginSessionHints() {
    try {
      sessionStorage.removeItem('suminregio_last_login_email');
      sessionStorage.removeItem('suminregio_last_login_at');
      sessionStorage.removeItem('suminregio_me_reload_count');
    } catch (_) {}
  }

  function authMeFetch() {
    var url =
      API_ORIGIN +
      '/api/auth/me?_=' +
      Date.now() +
      '&r=' +
      encodeURIComponent(Math.random().toString(36).slice(2, 10));
    return fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    }).then(function (r) {
      return r.json();
    });
  }

  // ── DB helpers ──────────────────────────────────────────────────────────────

  function getCurrentDb() {
    try {
      var u = new URL(location.href);
      var q = u.searchParams.get('db');
      if (q != null && String(q).trim() !== '') return String(q).trim();
    } catch (_) {}
    try {
      var s = sessionStorage.getItem('microsip_erp_db');
      if (s != null && String(s).trim() !== '') return String(s).trim();
    } catch (_) {}
    return '';
  }

  function setDb(dbId) {
    try {
      if (dbId) sessionStorage.setItem('microsip_erp_db', dbId);
      else sessionStorage.removeItem('microsip_erp_db');
    } catch (_) {}
    // Reload current page with ?db= param
    try {
      var u = new URL(location.href);
      if (dbId) u.searchParams.set('db', dbId);
      else u.searchParams.delete('db');
      location.href = u.toString();
    } catch (_) {
      location.reload();
    }
  }

  // ── UI helpers ──────────────────────────────────────────────────────────────

  function currentPage() {
    try {
      var p = location.pathname.split('/').pop() || 'index.html';
      return p || 'index.html';
    } catch (_) { return ''; }
  }

  function fmtTime(d) {
    return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  // Los datos NO son en vivo: se actualizan cada día a las 11 PM. Muestra el
  // último corte ya transcurrido (hoy / ayer / fecha).
  function navCorteTxt() {
    try {
      var now = new Date();
      var cut = new Date(now); cut.setHours(23, 0, 0, 0);
      if (now < cut) cut.setDate(cut.getDate() - 1);
      var hoy = new Date(now); hoy.setHours(0, 0, 0, 0);
      var dc = new Date(cut); dc.setHours(0, 0, 0, 0);
      var dif = Math.round((hoy - dc) / 86400000);
      var cuando = dif === 0 ? 'HOY' : (dif === 1 ? 'AYER'
        : cut.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).toUpperCase());
      return 'AL CORTE ' + cuando + ' · 11 PM';
    } catch (e) { return 'CORTE DIARIO 11 PM'; }
  }

  function buildNav(linkList) {
    var list = linkList || NAV_LINKS;
    var cur = currentPage();
    return list.map(function (nl) {
      var active = (nl.href === cur || (cur === '' && nl.href === 'index.html')) ? ' active' : '';
      return '<a class="nav-link' + active + '" href="' + nl.href + '">' +
        '<svg viewBox="0 0 24 24"><path d="' + nl.icon + '"/></svg>' +
        nl.label +
      '</a>';
    }).join('');
  }

  // ── DB Selector dropdown ────────────────────────────────────────────────────

  function buildDbSelector(databases) {
    var cur = getCurrentDb();
    // Sort: default first, then alphabetical by label
    var sorted = databases.slice().sort(function (a, b) {
      if ((a.id || '').toLowerCase() === 'default') return -1;
      if ((b.id || '').toLowerCase() === 'default') return 1;
      return (a.label || a.id || '').localeCompare(b.label || b.id || '');
    });

    var curEntry = sorted.find(function (d) { return String(d.id) === cur; });
    var curLabel = curEntry
      ? (curEntry.label || curEntry.id)
      : (cur ? cur : 'Por defecto');
    // Trim long labels
    if (curLabel.length > 16) curLabel = curLabel.substring(0, 14) + '…';

    var optionsHtml = '<div class="nav-db-opt' + (!cur ? ' active' : '') + '" data-db="">' +
      '<span class="nav-db-opt-dot"></span>Por defecto</div>';
    sorted.forEach(function (d) {
      var active = String(d.id) === cur ? ' active' : '';
      var lbl = (d.label || d.id || '').replace(/</g, '&lt;');
      optionsHtml += '<div class="nav-db-opt' + active + '" data-db="' + String(d.id).replace(/"/g, '&quot;') + '">' +
        '<span class="nav-db-opt-dot"></span>' + lbl + '</div>';
    });

    return '<div class="nav-db-wrap" id="navDbWrap">' +
      '<button class="nav-db-btn" id="navDbBtn" type="button" title="Cambiar unidad de negocio">' +
        '<svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>' +
        '<span id="navDbLabel">' + curLabel + '</span>' +
        '<svg class="nav-db-chevron" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>' +
      '</button>' +
      '<div class="nav-db-dropdown" id="navDbDropdown">' +
        '<div class="nav-db-dropdown-title">Unidad de negocio</div>' +
        optionsHtml +
      '</div>' +
    '</div>';
  }

  function attachDbEvents() {
    var btn = document.getElementById('navDbBtn');
    var dropdown = document.getElementById('navDbDropdown');
    var wrap = document.getElementById('navDbWrap');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle('open');
      dropdown.style.display = open ? 'block' : 'none';
    });

    dropdown.querySelectorAll('.nav-db-opt').forEach(function (opt) {
      opt.addEventListener('click', function () {
        var dbId = opt.getAttribute('data-db') || '';
        setDb(dbId);
      });
    });

    // Close on outside click
    document.addEventListener('click', function () {
      wrap.classList.remove('open');
      dropdown.style.display = 'none';
    });
  }

  function loadDbSelector(containerId) {
    var cont = document.getElementById(containerId);
    if (!cont) return;

    // Mostrar siempre si hay al menos 1 DB — usuario necesita saber qué negocio ve.
    fetch(API_ORIGIN + '/api/universe/databases')
      .then(function (r) { return r.json(); })
      .then(function (dbs) {
        if (!Array.isArray(dbs) || dbs.length < 1) return;
        cont.innerHTML = buildDbSelector(dbs);
        attachDbEvents();
      })
      .catch(function (e) { console.warn('[nav] no pude cargar /api/universe/databases', e); });
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('nav-js-style')) return;
    var s = document.createElement('style');
    s.id = 'nav-js-style';
    s.textContent = [
      '#app-header{position:sticky;top:0;z-index:100;',
      'background:rgba(5,11,20,.92);backdrop-filter:blur(20px);',
      '-webkit-backdrop-filter:blur(20px);',
      'border-bottom:1px solid rgba(255,255,255,.07);}',

      '.nav-hi{max-width:1900px;margin:0 auto;height:62px;',
      'display:flex;align-items:center;justify-content:space-between;',
      'gap:1rem;padding:0 1.5rem;}',

      '.nav-logo{display:flex;align-items:center;gap:.7rem;text-decoration:none;flex-shrink:0}',
      '.nav-logo-icon{width:36px;height:36px;background:linear-gradient(135deg,#E6A800,#FF8C42);',
      'border-radius:9px;display:grid;place-items:center;flex-shrink:0;',
      'box-shadow:0 0 18px rgba(230,168,0,.28);}',
      '.nav-logo-icon svg{width:20px;height:20px;fill:white;}',
      '.nav-logo-txt{font-size:.9rem;font-weight:800;color:#111827;}',
      '.nav-logo-sub{font-size:.57rem;font-family:"DM Mono",monospace;',
      'color:#111827;letter-spacing:.12em;text-transform:uppercase;}',

      '#app-header nav{display:flex;align-items:center;gap:.12rem;flex-wrap:wrap;}',

      '#app-header .nav-link{display:flex;align-items:center;gap:.38rem;',
      'padding:.35rem .72rem;border-radius:7px;font-size:.73rem;font-weight:600;',
      'color:#6A85A6;text-decoration:none;transition:all .2s;',
      'white-space:nowrap;border:1px solid transparent;',
      '-webkit-tap-highlight-color:transparent;}',
      '#app-header .nav-link:hover{color:#C8D8EC;background:#112233;}',
      '#app-header .nav-link.active{color:#E6A800;background:rgba(230,168,0,.12);',
      'border-color:rgba(230,168,0,.4);}',
      '#app-header .nav-link svg{width:13px;height:13px;fill:currentColor;flex-shrink:0;}',

      '.nav-right{display:flex;align-items:center;gap:8px;flex-shrink:0;}',
      '.nav-live{display:flex;align-items:center;gap:.4rem;',
      'background:rgba(0,229,160,.1);border:1px solid rgba(0,229,160,.2);',
      'border-radius:99px;padding:.25rem .65rem;',
      'font-family:"DM Mono",monospace;font-size:.6rem;',
      'color:#00E5A0;letter-spacing:.08em;text-transform:uppercase;}',
      '.nav-live-dot{width:5px;height:5px;border-radius:50%;',
      'background:#00E5A0;box-shadow:0 0 7px #00E5A0;',
      'animation:navPulse 2s ease-in-out infinite;}',
      '@keyframes navPulse{0%,100%{opacity:1}50%{opacity:.35}}',
      '.nav-clock{font-family:"DM Mono",monospace;font-size:.72rem;',
      'color:#6A85A6;letter-spacing:.04em;min-width:6.5rem;}',
      '.nav-session-slot{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;}',
      '.nav-user{max-width:10rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:.65rem;color:#94a3b8;}',
      '.nav-logout-btn{font-size:.65rem;padding:.35rem .6rem;border-radius:8px;',
      'border:1px solid rgba(230,168,0,.35);background:rgba(230,168,0,.08);',
      'color:#E6A800;cursor:pointer;font-weight:600;font-family:inherit;}',

      /* ── DB Selector ── */
      '.nav-db-wrap{position:relative;flex-shrink:0;}',
      '.nav-db-btn{display:flex;align-items:center;gap:.35rem;',
      'padding:.3rem .6rem;border-radius:8px;',
      'background:rgba(230,168,0,.08);border:1px solid rgba(230,168,0,.25);',
      'color:#E6A800;font-size:.7rem;font-weight:600;cursor:pointer;',
      'white-space:nowrap;transition:all .2s;font-family:inherit;}',
      '.nav-db-btn:hover{background:rgba(230,168,0,.15);border-color:rgba(230,168,0,.45);}',
      '.nav-db-btn svg{width:12px;height:12px;fill:currentColor;flex-shrink:0;}',
      '.nav-db-chevron{transition:transform .2s;}',
      '.nav-db-wrap.open .nav-db-chevron{transform:rotate(180deg);}',
      '.nav-db-dropdown{display:none;position:absolute;right:0;top:calc(100% + 6px);',
      'background:#0A1628;border:1px solid rgba(255,255,255,.1);',
      'border-radius:10px;min-width:180px;z-index:500;',
      'box-shadow:0 8px 32px rgba(0,0,0,.5);overflow:hidden;}',
      '.nav-db-dropdown-title{padding:.5rem .85rem .35rem;',
      'font-size:.6rem;font-weight:700;color:#6A85A6;',
      'text-transform:uppercase;letter-spacing:.1em;',
      'border-bottom:1px solid rgba(255,255,255,.06);}',
      '.nav-db-opt{display:flex;align-items:center;gap:.5rem;',
      'padding:.55rem .85rem;font-size:.78rem;font-weight:500;',
      'color:#C8D8EC;cursor:pointer;transition:background .15s;}',
      '.nav-db-opt:hover{background:rgba(230,168,0,.1);color:#E6A800;}',
      '.nav-db-opt.active{color:#E6A800;font-weight:700;}',
      '.nav-db-opt-dot{width:6px;height:6px;border-radius:50%;',
      'background:currentColor;flex-shrink:0;opacity:.5;}',
      '.nav-db-opt.active .nav-db-opt-dot{opacity:1;',
      'box-shadow:0 0 6px currentColor;}',

      /* ── Mobile ── */
      '@media(max-width:1180px){',
      '#app-header nav{max-width:calc(100vw - 5rem);overflow-x:auto;',
      'overflow-y:hidden;-webkit-overflow-scrolling:touch;',
      'overscroll-behavior-x:contain;scrollbar-width:none;flex-wrap:nowrap;',
      'padding-bottom:2px;scroll-padding-inline:6px;}',
      '#app-header nav::-webkit-scrollbar{display:none;}',
      '#app-header .nav-link{flex-shrink:0;}',
      '}',

      '@media(max-width:680px){',
      '.nav-hi{height:auto!important;min-height:54px;',
      'padding:.4rem .9rem!important;flex-wrap:nowrap;}',
      '.nav-logo-sub{display:none;}',
      '.nav-live,.nav-clock{display:none!important;}',
      '#navDbLabel{display:none;}',
      '.nav-db-btn{padding:.3rem .4rem;}',
      '.nav-db-dropdown{right:0;left:auto;}',
      '}',

      /* Contenedor de la barra de unidad (misma UX que Inicio; chips via filters.js) */
      '.nav-injected-biz-outer{max-width:1900px;margin:0 auto 14px;width:calc(100% - 2rem);box-sizing:border-box;}',
      '@media(max-width:780px){.nav-injected-biz-outer{width:100%;padding:0 .75rem;margin-bottom:10px;}}',

      /* ── Navegación móvil guiada: barra inferior + hoja "Más" (≤760px) ── */
      '@media(max-width:760px){',
      'body.sumi-has-bnav #main-nav{display:none!important;}', /* la barra inferior reemplaza la superior; si el JS falla, la superior queda como respaldo */
      'body{padding-bottom:calc(66px + env(safe-area-inset-bottom))!important;}',
      '#sumi-bnav{position:fixed;left:0;right:0;bottom:0;z-index:1200;display:flex;',
      'justify-content:space-around;align-items:stretch;',
      'background:rgba(7,14,24,.97);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);',
      'border-top:1px solid rgba(255,255,255,.08);',
      'padding:6px 4px calc(6px + env(safe-area-inset-bottom));',
      'box-shadow:0 -8px 28px rgba(0,0,0,.35);}',
      '#sumi-bnav .sumi-bnav-item{flex:1;display:flex;flex-direction:column;align-items:center;',
      'justify-content:center;gap:3px;border:0;background:none;cursor:pointer;text-decoration:none;',
      'color:#6A85A6;font-size:.6rem;font-weight:600;font-family:inherit;line-height:1.1;',
      'padding:7px 2px;border-radius:12px;transition:color .15s,background .15s;',
      '-webkit-tap-highlight-color:transparent;min-height:48px;}',
      '#sumi-bnav .sumi-bnav-item svg{width:22px;height:22px;fill:currentColor;}',
      '#sumi-bnav .sumi-bnav-item span{max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#sumi-bnav .sumi-bnav-item.active{color:#E6A800;}',
      '#sumi-bnav .sumi-bnav-item.active svg{filter:drop-shadow(0 0 6px rgba(230,168,0,.5));}',
      '#sumi-bnav .sumi-bnav-item:active{background:rgba(230,168,0,.12);}',
      '#sumi-msheet-ov{position:fixed;inset:0;z-index:1300;background:rgba(3,7,14,.6);',
      'opacity:0;pointer-events:none;transition:opacity .22s;}',
      '#sumi-msheet-ov.open{opacity:1;pointer-events:auto;}',
      '#sumi-msheet{position:fixed;left:0;right:0;bottom:0;z-index:1310;',
      'background:#0A1628;border-top-left-radius:22px;border-top-right-radius:22px;',
      'border-top:1px solid rgba(255,255,255,.1);box-shadow:0 -16px 48px rgba(0,0,0,.5);',
      'transform:translateY(110%);transition:transform .28s cubic-bezier(.22,1,.36,1);',
      'max-height:84vh;overflow-y:auto;-webkit-overflow-scrolling:touch;',
      'padding:0 16px calc(20px + env(safe-area-inset-bottom));}',
      '#sumi-msheet.open{transform:translateY(0);}',
      '.sumi-msheet-grab{width:40px;height:4px;border-radius:99px;background:rgba(255,255,255,.22);margin:10px auto 6px;}',
      '.sumi-msheet-hd{font-size:.66rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;',
      'color:#6A85A6;padding:4px 4px 12px;}',
      '.sumi-msheet-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}',
      '.sumi-msheet-grid a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;',
      'padding:15px 6px;border-radius:14px;text-decoration:none;text-align:center;',
      'background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);',
      'color:#C8D8EC;font-size:.7rem;font-weight:600;transition:transform .12s,background .15s;',
      '-webkit-tap-highlight-color:transparent;min-height:74px;}',
      '.sumi-msheet-grid a svg{width:23px;height:23px;fill:currentColor;}',
      '.sumi-msheet-grid a:active{transform:scale(.95);}',
      '.sumi-msheet-grid a.active{color:#E6A800;background:rgba(230,168,0,.12);border-color:rgba(230,168,0,.4);}',
      '.sumi-msheet-ft{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.08);}',
      '.sumi-msheet-ft .u{font-size:.7rem;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}',
      '.sumi-msheet-ft button{font-size:.72rem;padding:.55rem .95rem;border-radius:10px;flex-shrink:0;',
      'border:1px solid rgba(230,168,0,.35);background:rgba(230,168,0,.1);color:#E6A800;font-weight:700;cursor:pointer;font-family:inherit;}',
      'body.sumi-sheet-open{overflow:hidden;}',
      '#cw-fab,#sumi-ai-pro-btn,#cw-launcher,.cw-fab{bottom:calc(80px + env(safe-area-inset-bottom))!important;}',
      '}',
      '@media(min-width:761px){#sumi-bnav,#sumi-msheet,#sumi-msheet-ov{display:none!important;}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function injectLogout(btnId, user) {
    var el = document.getElementById(btnId);
    if (!el || !user || !user.email) return;
    el.innerHTML =
      '<span class="nav-user" title="' + String(user.email).replace(/"/g, '&quot;') + '">' +
      String(user.email).replace(/</g, '&lt;') +
      '</span>' +
      '<button type="button" class="nav-logout-btn" id="navLogoutBtn">Salir</button>';
    var btn = document.getElementById('navLogoutBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        fetch(API_ORIGIN + '/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .finally(function () {
            if (typeof window.cwClearSession === 'function') window.cwClearSession();
            location.href = '/login.html';
          });
      });
    }
  }

  function mountHeader(links, user) {
    injectStyles();

    var hdr = document.getElementById('app-header') || document.querySelector('header');
    if (!hdr) {
      hdr = document.createElement('header');
      document.body.insertBefore(hdr, document.body.firstChild);
    }
    if (!hdr.id) hdr.id = 'app-header';
    hdr.className = '';
    hdr.removeAttribute('style');
    hdr.removeAttribute('aria-hidden');

    var clockId = 'nav-clock-' + Date.now();
    hdr.innerHTML =
      '<div class="nav-hi">' +
        '<a class="nav-logo" href="' + ((user && user.roles && user.roles.indexOf('vendedor') >= 0 && user.roles.indexOf('gerente') < 0 && user.roles.indexOf('admin') < 0) ? 'ventas.html' : 'index.html') + '">' +
          '<div class="nav-logo-icon">' +
            '<svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>' +
          '</div>' +
          '<div>' +
            '<div class="nav-logo-txt">Suminregio Parker</div>' +
            '<div class="nav-logo-sub">ERP SCORECARD</div>' +
          '</div>' +
        '</a>' +
        '<nav id="main-nav">' + buildNav(links) + '</nav>' +
        '<div class="nav-right">' +
          '<div id="navDbContainer"></div>' +
          '<div id="navSessionSlot" class="nav-session-slot"></div>' +
          '<div class="nav-live" title="Los datos se actualizan automáticamente cada día a las 11 PM">' +
            '<div class="nav-live-dot"></div>' + navCorteTxt() +
          '</div>' +
          '<div class="nav-clock" id="' + clockId + '">—</div>' +
        '</div>' +
      '</div>';

    injectLogout('navSessionSlot', user);

    var clockEl = document.getElementById(clockId);
    if (clockEl) {
      clockEl.textContent = fmtTime(new Date());
      setInterval(function () { clockEl.textContent = fmtTime(new Date()); }, 1000);
    }

    loadDbSelector('navDbContainer');
    injectBizContextBar(hdr);
    try { buildMobileNav(links, user); } catch (e) { console.warn('[nav] bottom nav', e); }
    ensureChatWidget();
  }

  /**
   * Navegación móvil guiada (≤760px): barra inferior con los accesos clave +
   * botón "Más" que abre una hoja con TODAS las secciones (respeta el rol).
   * Reemplaza la barra superior apretada que quedaba oculta en teléfono.
   */
  function buildMobileNav(links, user) {
    if (!Array.isArray(links) || !links.length) links = NAV_LINKS;
    ['sumi-bnav', 'sumi-msheet', 'sumi-msheet-ov'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e && e.parentNode) e.parentNode.removeChild(e);
    });
    var cur = currentPage();
    var svg = function (p) { return '<svg viewBox="0 0 24 24"><path d="' + p + '"/></svg>'; };
    var isActive = function (h) { return (h === cur || (cur === '' && h === 'index.html')); };

    // Accesos primarios (en orden de prioridad, según los permitidos por rol).
    var pri = ['index.html', 'ventas.html', 'cxc.html', 'ia.html', 'cobradas.html', 'director.html', 'vendedores.html'];
    var byHref = {};
    links.forEach(function (l) { byHref[l.href] = l; });
    var primary = [];
    pri.forEach(function (h) { if (byHref[h] && primary.length < 4 && primary.indexOf(byHref[h]) < 0) primary.push(byHref[h]); });
    links.forEach(function (l) { if (primary.length < 4 && primary.indexOf(l) < 0) primary.push(l); });
    primary = primary.slice(0, 4);

    var moreIcon = 'M4 8h4V4H4v4zm0 6h4v-4H4v4zm0 6h4v-4H4v4zm6 0h4v-4h-4v4zm0-6h4v-4h-4v4zm0-10v4h4V4h-4zm6 16h4v-4h-4v4zm0-6h4v-4h-4v4zm0-10v4h4V4h-4z';

    var bnav = document.createElement('nav');
    bnav.id = 'sumi-bnav';
    bnav.setAttribute('aria-label', 'Navegación');
    bnav.innerHTML = primary.map(function (l) {
      return '<a class="sumi-bnav-item' + (isActive(l.href) ? ' active' : '') + '" href="' + l.href + '">' +
        svg(l.icon) + '<span>' + l.label + '</span></a>';
    }).join('') +
      '<button type="button" class="sumi-bnav-item" id="sumi-bnav-more" aria-haspopup="dialog">' +
      svg(moreIcon) + '<span>Más</span></button>';
    document.body.appendChild(bnav);
    document.body.classList.add('sumi-has-bnav'); // habilita ocultar la barra superior en móvil

    var ov = document.createElement('div');
    ov.id = 'sumi-msheet-ov';
    var sheet = document.createElement('aside');
    sheet.id = 'sumi-msheet';
    sheet.setAttribute('aria-hidden', 'true');
    sheet.setAttribute('role', 'dialog');
    var grid = links.map(function (l) {
      return '<a class="' + (isActive(l.href) ? 'active' : '') + '" href="' + l.href + '">' +
        svg(l.icon) + '<span>' + l.label + '</span></a>';
    }).join('');
    var ftUser = (user && user.email)
      ? '<span class="u" title="' + String(user.email).replace(/"/g, '&quot;') + '">' + String(user.email).replace(/</g, '&lt;') + '</span>'
      : '<span class="u"></span>';
    var ftBtn = (user && user.email) ? '<button type="button" id="sumi-msheet-logout">Salir</button>' : '';
    sheet.innerHTML =
      '<div class="sumi-msheet-grab"></div>' +
      '<div class="sumi-msheet-hd">Navegación</div>' +
      '<div class="sumi-msheet-grid">' + grid + '</div>' +
      '<div class="sumi-msheet-ft">' + ftUser + ftBtn + '</div>';
    document.body.appendChild(ov);
    document.body.appendChild(sheet);

    function openSheet() {
      ov.classList.add('open');
      sheet.classList.add('open');
      sheet.setAttribute('aria-hidden', 'false');
      document.body.classList.add('sumi-sheet-open');
    }
    function closeSheet() {
      ov.classList.remove('open');
      sheet.classList.remove('open');
      sheet.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('sumi-sheet-open');
    }
    var moreBtn = document.getElementById('sumi-bnav-more');
    if (moreBtn) moreBtn.addEventListener('click', openSheet);
    ov.addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    var lo = document.getElementById('sumi-msheet-logout');
    if (lo) lo.addEventListener('click', function () {
      var realBtn = document.getElementById('navLogoutBtn');
      if (realBtn) { realBtn.click(); return; }
      try { location.href = '/api/auth/logout'; } catch (_) { /* noop */ }
    });
  }

  /** admin: todo · gerente: sin Finanzas/Margen · solo vendedor: ventas operativas. */
  function filterNavLinksForRole(user) {
    var base = NAV_LINKS;
    function stripUsageOnlyAdmin(list) {
      return list.filter(function (nl) {
        return nl.href !== 'usage-metrics.html';
      });
    }
    if (!user || !user.roles) return stripUsageOnlyAdmin(base);
    var roles = user.roles || [];
    if (roles.indexOf('admin') >= 0) return base;
    base = stripUsageOnlyAdmin(base);

    var isGerente = roles.indexOf('gerente') >= 0;
    var isVendedor = roles.indexOf('vendedor') >= 0;

    if (isVendedor && !isGerente) {
      var allow = {
        'ventas.html': true,
        'cobradas.html': true,
        'vendedores.html': true,
      };
      return base.filter(function (nl) {
        return allow[nl.href] === true;
      });
    }

    if (isGerente) {
      return base.filter(function (nl) {
        return nl.href !== 'resultados.html' && nl.href !== 'margen-producto.html';
      });
    }

    return base;
  }

  function refreshSessionLabel() {
    authMeFetch()
      .then(function (data) {
        var user = data && data.user;
        var el = document.querySelector('.nav-user');
        if (!user || !user.email || !el) return;
        var em = String(user.email);
        if (el.textContent !== em) {
          el.textContent = em;
          el.setAttribute('title', em);
        }
      })
      .catch(function () {});
  }

  function init() {
    var lastLogin = '';
    try {
      var at = parseInt(sessionStorage.getItem('suminregio_last_login_at') || '0', 10) || 0;
      if (at && Date.now() - at < 120000) {
        lastLogin = (
          sessionStorage.getItem('suminregio_last_login_email') || ''
        ).trim().toLowerCase();
      } else {
        try {
          sessionStorage.removeItem('suminregio_last_login_email');
          sessionStorage.removeItem('suminregio_last_login_at');
        } catch (_) {}
      }
    } catch (_) {}

    function finishWithUser(data) {
      var user = data && data.user;
      try {
        sessionStorage.removeItem('suminregio_login_ok');
      } catch (_) {}
      clearLoginSessionHints();
      mountHeader(filterNavLinksForRole(user), user);
    }

    function attemptFetch(attempt) {
      authMeFetch()
        .then(function (data) {
          var user = data && data.user;
          var em = user && user.email ? String(user.email).trim().toLowerCase() : '';
          if (lastLogin && em && lastLogin !== em) {
            if (attempt < ME_RETRY_MAX) {
              setTimeout(function () {
                attemptFetch(attempt + 1);
              }, ME_BACKOFF_MS * (attempt + 1));
              return;
            }
            try {
              var rc = parseInt(sessionStorage.getItem('suminregio_me_reload_count') || '0', 10) || 0;
              if (rc < 1) {
                sessionStorage.setItem('suminregio_me_reload_count', '1');
                location.reload();
                return;
              }
            } catch (_) {}
            clearLoginSessionHints();
            fetch(API_ORIGIN + '/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
              .finally(function () {
                if (typeof window.cwClearSession === 'function') window.cwClearSession();
                location.replace('/login.html?gate=session_mismatch');
              });
            return;
          }
          finishWithUser(data);
        })
        .catch(function () {
          mountHeader(NAV_LINKS, null);
        });
    }

    attemptFetch(0);
  }

  function injectBizContextBar(hdr) {
    // La barra HORIZONTAL de chips de negocio se ELIMINA en todas las páginas:
    // el cambio de unidad de negocio se hace SOLO con el dropdown del header
    // (el botón "Suminregio ▾"). Se quitan/ocultan todas las variantes de barra.
    function purge() {
      try {
        // Barras que se pueden eliminar por completo.
        var del = document.querySelectorAll('#navInjectedBizOuter, .nav-injected-biz-outer');
        for (var i = 0; i < del.length; i++) {
          if (del[i].parentNode) del[i].parentNode.removeChild(del[i]);
        }
        // Barras propias de página (index/resultados) y la muerta de filters:
        // se ocultan (su JS podría intentar mostrarlas).
        var hide = document.querySelectorAll('#bizContextBar, .nav-global-db-bar, #navInjectedBizBar, .biz-context-bar');
        for (var k = 0; k < hide.length; k++) {
          hide[k].style.setProperty('display', 'none', 'important');
        }
      } catch (_) {}
    }
    purge();
    // Re-purga si alguna página vuelve a inyectar/mostrar su barra (async).
    try {
      if (typeof MutationObserver !== 'undefined') {
        var obs = new MutationObserver(function () { purge(); });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () { obs.disconnect(); }, 15000);
      } else {
        setTimeout(purge, 1500);
        setTimeout(purge, 4000);
      }
    } catch (_) {}
  }

  function ensureChatWidget() {
    if (document.getElementById('cw-root')) return; // ya montado
    if (document.querySelector('script[src*="chat-widget.js"]')) return; // ya cargándose
    var s = document.createElement('script');
    s.src = '/chat-widget.js';
    s.defer = true;
    s.onerror = function () { console.warn('[nav] chat-widget.js no se pudo cargar'); };
    document.body.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refreshSessionLabel();
  });
})();
