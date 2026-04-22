/**
 * global-search.js — Búsqueda global tipo Cmd+K / Ctrl+K
 * Encuentra clientes, artículos, folios de CxC, vendedores en TODO el dataset.
 */
(function () {
  'use strict';
  if (window.__sumiSearchMounted) return;
  window.__sumiSearchMounted = true;

  var API = '/api/search/global';
  var state = { open: false, q: '', results: [], loading: false, idx: 0 };

  // ── Modal DOM ──────────────────────────────────────────────────────────────
  var css = [
    '#sumi-search-overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(8px);z-index:9999;display:none;align-items:flex-start;justify-content:center;padding-top:10vh}',
    '#sumi-search-overlay.open{display:flex}',
    '#sumi-search-box{background:#fff;border:1px solid rgba(230,168,0,.3);border-radius:18px;width:min(680px,92vw);max-height:70vh;display:flex;flex-direction:column;box-shadow:0 30px 80px -20px rgba(15,23,42,.35);overflow:hidden;animation:sumiSearchIn .25s cubic-bezier(.34,1.56,.64,1)}',
    '@keyframes sumiSearchIn{from{opacity:0;transform:translateY(-10px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}',
    '#sumi-search-input{border:none;outline:none;padding:18px 22px;font-size:1rem;font-family:inherit;color:#0F172A;background:transparent;border-bottom:1px solid rgba(15,23,42,.08)}',
    '#sumi-search-input::placeholder{color:#94A3B8}',
    '#sumi-search-results{overflow-y:auto;max-height:50vh;padding:4px}',
    '.sumi-sr-item{padding:10px 16px;cursor:pointer;border-radius:10px;display:flex;align-items:center;gap:12px;color:#0F172A;transition:background .12s ease}',
    '.sumi-sr-item:hover,.sumi-sr-item.active{background:rgba(230,168,0,.1)}',
    '.sumi-sr-ico{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#F5C33C,#E6A800);display:grid;place-items:center;flex-shrink:0;font-size:12px;color:#1A1200;font-weight:700}',
    '.sumi-sr-main{flex:1;min-width:0}',
    '.sumi-sr-title{font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sumi-sr-sub{font-size:.72rem;color:#64748B}',
    '.sumi-sr-tag{background:rgba(15,23,42,.06);color:#64748B;font-size:.62rem;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:6px;letter-spacing:.04em}',
    '#sumi-search-foot{padding:10px 16px;border-top:1px solid rgba(15,23,42,.06);font-size:.7rem;color:#94A3B8;display:flex;justify-content:space-between;gap:8px;background:#F8FAFC}',
    '.sumi-kbd{background:#fff;border:1px solid rgba(15,23,42,.1);border-bottom-width:2px;border-radius:4px;padding:1px 6px;font-family:"DM Mono",monospace;font-size:.7rem;color:#475569}',
    '#sumi-search-trigger{position:fixed;bottom:24px;left:24px;z-index:90;background:rgba(255,255,255,.95);border:1px solid rgba(230,168,0,.35);color:#0F172A;padding:8px 12px;border-radius:999px;font-size:.75rem;font-family:inherit;box-shadow:0 4px 14px -3px rgba(15,23,42,.12);cursor:pointer;display:flex;align-items:center;gap:8px}',
    '#sumi-search-trigger:hover{border-color:#E6A800}',
    '@media(max-width:640px){#sumi-search-trigger{bottom:80px}}',
  ].join('');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function buildModal() {
    if (document.getElementById('sumi-search-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'sumi-search-overlay';
    overlay.innerHTML =
      '<div id="sumi-search-box">' +
        '<input id="sumi-search-input" placeholder="Buscar cliente, folio, artículo, vendedor…" autocomplete="off" />' +
        '<div id="sumi-search-results"></div>' +
        '<div id="sumi-search-foot">' +
          '<span><span class="sumi-kbd">↑</span> <span class="sumi-kbd">↓</span> navegar · <span class="sumi-kbd">⏎</span> abrir · <span class="sumi-kbd">Esc</span> cerrar</span>' +
          '<span>Búsqueda global</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.getElementById('sumi-search-input').addEventListener('input', onInput);
    document.getElementById('sumi-search-input').addEventListener('keydown', onKey);

    // FAB opcional (solo si no hay uno ya)
    if (!document.getElementById('sumi-search-trigger') && !document.querySelector('[data-no-search-fab]')) {
      var fab = document.createElement('button');
      fab.id = 'sumi-search-trigger';
      fab.innerHTML = '<span>🔍</span> Buscar <span class="sumi-kbd">⌘K</span>';
      fab.addEventListener('click', open);
      document.body.appendChild(fab);
    }
  }

  function open() {
    state.open = true;
    document.getElementById('sumi-search-overlay').classList.add('open');
    setTimeout(function () { document.getElementById('sumi-search-input').focus(); }, 50);
  }
  function close() {
    state.open = false;
    document.getElementById('sumi-search-overlay').classList.remove('open');
    document.getElementById('sumi-search-input').value = '';
    render([]);
  }

  var timer = null;
  function onInput(e) {
    var q = e.target.value.trim();
    state.q = q;
    state.idx = 0;
    clearTimeout(timer);
    if (!q) { render([]); return; }
    timer = setTimeout(function () { doSearch(q); }, 180);
  }

  function doSearch(q) {
    state.loading = true;
    renderLoading();
    var dbParam = '';
    try {
      var db = localStorage.getItem('sumi_db') || (window.__SUMI_DB || '');
      if (db) dbParam = '&db=' + encodeURIComponent(db);
    } catch (_) {}
    fetch(API + '?q=' + encodeURIComponent(q) + dbParam)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.loading = false;
        state.results = (data && data.results) || [];
        render(state.results);
      })
      .catch(function () {
        state.loading = false;
        render([]);
      });
  }

  function renderLoading() {
    document.getElementById('sumi-search-results').innerHTML =
      '<div style="padding:30px;text-align:center;color:#94A3B8">Buscando…</div>';
  }

  function render(items) {
    var box = document.getElementById('sumi-search-results');
    if (!items.length) {
      box.innerHTML = state.q
        ? '<div style="padding:30px;text-align:center;color:#94A3B8">Sin resultados para "' + state.q + '"</div>'
        : '<div style="padding:30px;text-align:center;color:#94A3B8">Escribe para buscar</div>';
      return;
    }
    box.innerHTML = items.map(function (r, i) {
      var ico = (r.type || 'x').charAt(0).toUpperCase();
      return '<a class="sumi-sr-item ' + (i === state.idx ? 'active' : '') + '" ' +
             'style="text-decoration:none" href="' + (r.href || '#') + '">' +
             '<div class="sumi-sr-ico">' + ico + '</div>' +
             '<div class="sumi-sr-main">' +
               '<div class="sumi-sr-title">' + (r.title || '') + '</div>' +
               '<div class="sumi-sr-sub">' + (r.sub || '') + '</div>' +
             '</div>' +
             '<span class="sumi-sr-tag">' + (r.type || '') + '</span>' +
             '</a>';
    }).join('');
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (!state.results.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); state.idx = Math.min(state.results.length - 1, state.idx + 1); render(state.results); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); state.idx = Math.max(0, state.idx - 1); render(state.results); }
    if (e.key === 'Enter')     { e.preventDefault(); var r = state.results[state.idx]; if (r && r.href) window.location.href = r.href; }
  }

  // ── Keybinding global Ctrl+K / Cmd+K ────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      state.open ? close() : open();
    }
    if (e.key === '/' && !/input|textarea|select/i.test((e.target && e.target.tagName) || '')) {
      e.preventDefault();
      open();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildModal);
  } else {
    buildModal();
  }

  window.SumiSearch = { open: open, close: close };
})();
