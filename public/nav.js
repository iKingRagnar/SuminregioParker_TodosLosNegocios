/**
 * nav.js — Navegación unificada con selector de unidad de negocio global
 * Inyecta header completo en <header> (vacío) o #app-header.
 * Auto-detecta página activa · Selector de DB en todas las páginas.
 */
(function () {
  'use strict';

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
      ].forEach(function (pair) {
        if (document.getElementById(pair[0])) return;
        var sc = document.createElement('script');
        sc.id = pair[0]; sc.src = pair[1]; sc.defer = true;
        head.appendChild(sc);
      });

      // Registrar Service Worker (offline-first)
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
          navigator.serviceWorker.register('/sw.js').catch(function (e) {
            console.warn('[SW] registro falló:', e.message);
          });
        });
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
    { href: 'resultados.html',      label: 'Resultados', icon: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z' },
    { href: 'comparar.html',        label: 'Comparar',   icon: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z' },
    { href: 'admin.html',           label: 'Admin',      icon: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1.06 13.54L7.4 11l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41-5.64 5.66z' },
    { href: 'capital.html',    label: 'Capital',      icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93V18h-2v1.93c-3.94-.49-7-3.86-7-7.93s3.05-7.44 7-7.93V6h2V4.07c3.94.49 7 3.86 7 7.93s-3.05 7.44-7 7.93zM11 9h2v4h-2zm0 6h2v2h-2z' },
  ];

  var API_ORIGIN = (function () {
    try {
      if (location.protocol === 'file:') return 'http://localhost:7000';
      return location.origin || '';
    } catch (_) { return ''; }
  })();

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
      '.nav-logo-txt{font-size:.9rem;font-weight:800;color:#F0F6FF;}',
      '.nav-logo-sub{font-size:.57rem;font-family:"DM Mono",monospace;',
      'color:#6A85A6;letter-spacing:.12em;text-transform:uppercase;}',

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

      /* Barra horizontal de negocios (todas las páginas) */
      '.nav-biz-bar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;',
      'max-width:1900px;margin:1rem auto .25rem;padding:.65rem 1rem;',
      'background:linear-gradient(180deg,rgba(17,34,51,.92),rgba(10,22,38,.88));',
      'border:1px solid rgba(255,255,255,.1);border-radius:12px;',
      'box-shadow:0 10px 40px rgba(0,0,0,.28);position:sticky;top:62px;z-index:90;}',
      '.nav-biz-label{font-family:"DM Mono",monospace;font-size:.58rem;',
      'color:#8899aa;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;}',
      '.nav-biz-chips{display:flex;flex-wrap:wrap;gap:.45rem;flex:1;min-width:0;}',
      '.nav-biz-chip{font-family:"DM Mono",monospace;font-size:.68rem;',
      'padding:.32rem .85rem;border-radius:99px;border:1px solid rgba(255,255,255,.12);',
      'background:transparent;color:#c4d1e0;cursor:pointer;transition:all .2s;white-space:nowrap;}',
      '.nav-biz-chip:hover{color:#f0f6ff;border-color:rgba(230,168,0,.35);}',
      '.nav-biz-chip.active{color:#E6A800;border-color:rgba(230,168,0,.55);',
      'background:rgba(230,168,0,.1);font-weight:600;}',
      '@media(max-width:780px){.nav-biz-bar{margin:.5rem .75rem;padding:.5rem .75rem;top:54px;}',
      '.nav-biz-label{display:none;}}',
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
          '<div class="nav-live">' +
            '<div class="nav-live-dot"></div>LIVE' +
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
    ensureChatWidget();
  }

  /** admin: todo · gerente: sin Resultados/Margen · solo vendedor: ventas operativas. */
  function filterNavLinksForRole(user) {
    var base = NAV_LINKS;
    if (!user || !user.roles) return base;
    var roles = user.roles || [];
    if (roles.indexOf('admin') >= 0) return base;

    var isGerente = roles.indexOf('gerente') >= 0;
    var isVendedor = roles.indexOf('vendedor') >= 0;

    if (isVendedor && !isGerente) {
      var allow = {
        'ventas.html': true,
        'cobradas.html': true,
        'clientes.html': true,
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

  function init() {
    fetch(API_ORIGIN + '/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var user = data && data.user;
        mountHeader(filterNavLinksForRole(user), user);
      })
      .catch(function () {
        mountHeader(NAV_LINKS, null);
      });
  }

  function injectBizContextBar(hdr) {
    // Si la página ya tiene #bizContextBar (index.html), no la duplicamos
    if (document.getElementById('bizContextBar')) return;
    if (document.getElementById('navBizBar')) return;

    var bar = document.createElement('div');
    bar.id = 'navBizBar';
    bar.className = 'nav-biz-bar';
    bar.setAttribute('aria-label', 'Unidad de negocio');
    bar.style.display = 'none';
    bar.innerHTML =
      '<span class="nav-biz-label">Unidad de negocio</span>' +
      '<div class="nav-biz-chips" id="navBizChips"></div>';

    // Insertar justo después del header
    if (hdr && hdr.parentNode) {
      hdr.parentNode.insertBefore(bar, hdr.nextSibling);
    } else {
      document.body.insertBefore(bar, document.body.firstChild);
    }

    fetch(API_ORIGIN + '/api/universe/databases')
      .then(function (r) { return r.json(); })
      .then(function (dbs) {
        if (!Array.isArray(dbs) || dbs.length < 1) return;
        renderBizChips(dbs);
        bar.style.display = 'flex';
      })
      .catch(function (e) { console.warn('[nav] biz-bar no pudo cargar dbs', e); });
  }

  function renderBizChips(dbs) {
    var box = document.getElementById('navBizChips');
    if (!box) return;
    var curDb = getCurrentDb();
    var sorted = dbs.slice().sort(function (a, b) {
      if ((a.id || '').toLowerCase() === 'default') return -1;
      if ((b.id || '').toLowerCase() === 'default') return 1;
      return (a.label || a.id || '').localeCompare(b.label || b.id || '');
    });
    var html = '<button type="button" class="nav-biz-chip' + (curDb === '' ? ' active' : '') + '" data-db="">Todos</button>';
    sorted.forEach(function (d) {
      var id = String(d.id || '');
      var lbl = (d.label || d.id || '').replace(/</g, '&lt;');
      html += '<button type="button" class="nav-biz-chip' + (curDb === id ? ' active' : '') + '" data-db="' + id.replace(/"/g, '&quot;') + '">' + lbl + '</button>';
    });
    box.innerHTML = html;
    box.querySelectorAll('.nav-biz-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var raw = btn.getAttribute('data-db') || '';
        try {
          var u = new URL(location.href);
          if (raw) u.searchParams.set('db', raw); else u.searchParams.delete('db');
          history.replaceState({}, '', u);
        } catch (_) {}
        try {
          if (raw) {
            sessionStorage.setItem('microsip_erp_db', raw);
            localStorage.setItem('currentDb', raw);
          } else {
            sessionStorage.removeItem('microsip_erp_db');
            localStorage.removeItem('currentDb');
          }
        } catch (_) {}
        location.reload();
      });
    });
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
})();
