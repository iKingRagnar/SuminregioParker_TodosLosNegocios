/**
 * presentation-mode.js — Modo kiosko: pantalla completa auto-ciclando módulos
 * Trigger: tecla F10, o botón con data-presentation-trigger.
 * ESC sale. Arrows pausa/siguiente.
 */
(function () {
  'use strict';
  if (window.__sumiPresentation) return;
  window.__sumiPresentation = true;

  const PAGES = [
    { href: '/index.html',     name: 'Inicio' },
    { href: '/ventas.html',    name: 'Ventas' },
    { href: '/cxc.html',       name: 'CxC' },
    { href: '/inventario.html', name: 'Inventario' },
    { href: '/resultados.html', name: 'Resultados' },
    { href: '/comparar.html',  name: 'Comparar' },
  ];
  const INTERVAL = 25_000;

  function start() {
    if (document.fullscreenElement == null) {
      document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
    }
    document.body.dataset.presentation = '1';

    // Overlay indicador
    const hud = document.createElement('div');
    hud.id = 'sumi-presentation-hud';
    hud.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;background:rgba(15,23,42,.85);color:#F5C33C;padding:8px 14px;border-radius:10px;font-family:"DM Mono",monospace;font-size:.72rem;font-weight:600;backdrop-filter:blur(12px)';
    document.body.appendChild(hud);

    let idx = 0;
    function advance() {
      const cur = location.pathname;
      const next = (idx + 1) % PAGES.length;
      idx = next;
      hud.textContent = '◉ ' + PAGES[idx].name + ' · auto ' + (INTERVAL / 1000) + 's';
      if (PAGES[idx].href !== cur) {
        location.href = PAGES[idx].href + '?kiosk=1';
      }
    }

    hud.textContent = '◉ ' + (PAGES[idx].name || 'Modo presentación');
    const timer = setInterval(advance, INTERVAL);

    function stop() {
      clearInterval(timer);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      delete document.body.dataset.presentation;
      hud.remove();
      window.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
      if (e.key === 'Escape' || e.key === 'F10') { stop(); }
      if (e.key === 'ArrowRight') advance();
    }
    window.addEventListener('keydown', onKey);

    // Auto-iniciar en kiosk mode (URL con ?kiosk=1 al reanudar)
    if (/[?&]kiosk=1/.test(location.search)) {
      document.body.dataset.presentation = '1';
    }
  }

  // CSS del modo presentación
  const css = document.createElement('style');
  css.textContent = [
    'body[data-presentation="1"] #app-header nav,',
    'body[data-presentation="1"] #cw-fab,',
    'body[data-presentation="1"] #sumi-search-trigger,',
    'body[data-presentation="1"] #sumi-ai-pro-btn{display:none!important}',
    'body[data-presentation="1"]{cursor:none}',
    'body[data-presentation="1"] main{max-width:none!important;padding:40px 60px!important}',
    'body[data-presentation="1"] .kpi-card,body[data-presentation="1"] .kpi,body[data-presentation="1"] .card{transform:scale(1.05);transform-origin:center}',
  ].join('\n');
  document.head.appendChild(css);

  // Trigger
  window.addEventListener('keydown', function (e) {
    if (e.key === 'F10') { e.preventDefault(); start(); }
  });
  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest && e.target.closest('[data-presentation-trigger]');
    if (btn) { e.preventDefault(); start(); }
  });

  window.SumiPresentation = { start: start };
})();
