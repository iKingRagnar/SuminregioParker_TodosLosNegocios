/**
 * filters.js ? Barra de filtros compartida ? Suminregio Parker ERP
 * -----------------------------------------------------------------
 * Uso b?sico:
 *   1) A?adir <div id="filter-bar"></div> en el HTML
 *   2) <script src="filters.js"></script>
 *   3) Llamar initFilters({ containerId, showVendedor, onChange })
 *
 * API p?blica:
 *   initFilters(config)   ? inicializa y renderiza la barra
 *   filterBuildQS(extras) ? devuelve query-string con los filtros activos
 *   filterGetParams()     ? devuelve objeto { anio, mes, desde, hasta, vendedor }
 */

// Fix ngrok (plan gratis): evita pantalla de advertencia para que fetch() reciba JSON
if (typeof window !== 'undefined' && /ngrok-free\.app|ngrok\.io|ngrok-free\.dev/i.test(window.location.hostname)) {
  var _fetch = window.fetch;
  window.fetch = function (url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers, { 'ngrok-skip-browser-warning': '1' });
    return _fetch.call(this, url, opts);
  };
}

(function () {
  'use strict';

  const MESES_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const MESES_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const API = (typeof window !== 'undefined' && window.__API_BASE !== undefined) ? window.__API_BASE : '';

  let _cfg        = {};
  let _vendedores = [];
  let _state      = { preset: 'mes', anio: null, mes: null, desde: '', hasta: '', vendedor: '' };

  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function today() { return new Date(); }

  function applyPreset(preset) {
    const d  = today();
    const y  = d.getFullYear();
    const m  = d.getMonth() + 1;
    _state.preset = preset;
    _state.desde  = '';
    _state.hasta  = '';
    _state.anio   = null;
    _state.mes    = null;

    switch (preset) {
      case 'hoy':
        _state.desde = _state.hasta = isoDate(d);
        break;
      case 'semana': {
        const dow   = d.getDay();
        const start = new Date(d);
        start.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        _state.desde = isoDate(start);
        _state.hasta = isoDate(d);
        break;
      }
      case 'mes':
        _state.anio = y;
        _state.mes  = m;
        break;
      case 'mes_ant':
        _state.anio = (m === 1) ? y - 1 : y;
        _state.mes  = (m === 1) ? 12    : m - 1;
        break;
      case 'anio':
        _state.anio = y;
        break;
      case 'anio_ant':
        _state.anio = y - 1;
        break;
      default:
        break;
    }
  }

  function getSelectedDbId() {
    try {
      let db = (new URLSearchParams(window.location.search).get('db') || '').trim();
      if (!db) db = (sessionStorage.getItem('microsip_erp_db') || '').trim();
      return db;
    } catch (e) {
      return '';
    }
  }

  /** Al cambiar de .fdb el VENDEDOR_ID de otra empresa no aplica: vac?a filtro y el &lt;select&gt;. */
  function clearVendedorSilent() {
    _state.vendedor = '';
    try {
      var sel = document.getElementById('fb-vendedor');
      if (sel) sel.value = '';
    } catch (_) {}
  }

  function getParams() {
    const p = { preset: _state.preset || 'mes' };
    if (_state.desde && _state.hasta) {
      p.desde = _state.desde;
      p.hasta = _state.hasta;
    } else {
      if (_state.anio) p.anio = _state.anio;
      if (_state.mes)  p.mes  = _state.mes;
    }
    if (_state.vendedor) p.vendedor = _state.vendedor;
    return p;
  }

  /** extras: objeto opcional. opts.omitDb = true no a?ade ?db= (p. ej. universe/scorecard). */
  function buildQS(extras, opts) {
    const p = Object.assign({}, getParams(), (extras && typeof extras === 'object') ? extras : {});
    if (!opts || !opts.omitDb) {
      const db = getSelectedDbId();
      if (db) p.db = db;
    }
    return Object.keys(p)
      .filter(k => p[k] !== '' && p[k] != null)
      .map(k => k + '=' + encodeURIComponent(p[k]))
      .join('&');
  }

  function escChip(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function fdbBasename(p) {
    if (!p) return '';
    const s = String(p).replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  /** Nombre visible sin extensión .fdb */
  function displayDbTitle(fname) {
    if (!fname) return '';
    return String(fname).replace(/\.fdb$/i, '');
  }

  function renderDbChipsInto(container, list, onChange) {
    if (!container) return;
    // Fallback visual por si algún CSS no cargó todavía.
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
    container.style.gap = '12px';
    container.style.alignContent = 'start';
    const urlDb = getSelectedDbId();
    const searchDefault = 'por defecto servidor env fb_database';
    let html = '<button type="button" class="biz-tile db-chip' + (!urlDb ? ' active' : '') + '" data-db="" data-search="' + searchDefault + '" title="Conexi\u00f3n por defecto del servidor (FB_DATABASE)">' +
      '<span class="biz-tile-kicker">Conexi\u00f3n</span>' +
      '<span class="biz-tile-title">Por defecto</span>' +
      '<span class="biz-tile-meta">Variable FB_DATABASE del servidor</span></button>';
    (list || []).forEach(function (e) {
      const id = String(e.id || '');
      const fname = fdbBasename(e.database);
      const main = displayDbTitle(fname || id);
      const sub = (e.label && e.label !== fname && e.label !== id) ? e.label : (e.label || displayDbTitle(id));
      const active = urlDb === id ? ' active' : '';
      const title = escChip((e.database || '') + (e.host ? ' \u00b7 ' + e.host : ''));
      const searchHay = escChip([main, sub, id, fname, e.host || ''].join(' ').toLowerCase());
      html += '<button type="button" class="biz-tile db-chip' + active + '" data-db="' + escChip(id) + '" data-search="' + searchHay + '" title="' + title + '">' +
        '<span class="biz-tile-kicker">' + (fname ? 'Base' : 'ID') + '</span>' +
        '<span class="biz-tile-title">' + escChip(main.length > 42 ? main.slice(0, 40) + '\u2026' : main) + '</span>' +
        '<span class="biz-tile-meta">' + escChip(sub) + '</span></button>';
    });
    container.innerHTML = html;
    function applyTileState(tile, isActive) {
      if (!tile) return;
      tile.style.borderColor = isActive ? 'rgba(245,124,0,.55)' : 'rgba(255,255,255,.12)';
      tile.style.background = isActive ? 'linear-gradient(145deg, rgba(245,124,0,.18), rgba(245,124,0,.06))' : 'rgba(255,255,255,.04)';
      tile.style.color = isActive ? '#fff' : '#cbd5e1';
    }
    container.querySelectorAll('.biz-tile').forEach(function (btn) {
      if (!btn.style.minHeight) btn.style.minHeight = '88px';
      btn.style.border = '1px solid rgba(255,255,255,.12)';
      btn.style.borderRadius = '14px';
      btn.style.background = 'rgba(255,255,255,.04)';
      btn.style.padding = '12px 14px';
      btn.style.display = 'flex';
      btn.style.flexDirection = 'column';
      btn.style.alignItems = 'flex-start';
      btn.style.gap = '4px';
      btn.style.textAlign = 'left';
      btn.style.cursor = 'pointer';
      applyTileState(btn, btn.classList.contains('active'));
      btn.addEventListener('click', function () {
        const raw = btn.getAttribute('data-db') || '';
        try {
          const u = new URL(window.location.href);
          if (raw) u.searchParams.set('db', raw);
          else u.searchParams.delete('db');
          history.replaceState({}, '', u);
        } catch (_) {}
        try {
          if (raw) sessionStorage.setItem('microsip_erp_db', raw);
          else sessionStorage.removeItem('microsip_erp_db');
        } catch (_) {}
        container.querySelectorAll('.biz-tile').forEach(function (b) { b.classList.remove('active'); applyTileState(b, false); });
        btn.classList.add('active');
        applyTileState(btn, true);
        clearVendedorSilent();
        if (onChange) onChange(raw);
      });
    });
  }

  /** A?ade ?db= a una ruta que empieza en /api/... (o path relativo con query). */
  function apiPathWithDb(path) {
    const db = getSelectedDbId();
    if (!db) return path;
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + 'db=' + encodeURIComponent(db);
  }

  async function initGlobalDbBarAfterNav(headerEl) {
    if (document.getElementById('bizChips')) return;
    if (document.getElementById('navDbBarWrap')) return;
    // P?ginas sin initFilters() (CxC, Clientes, Inventario, etc.) nunca llamaban injectCSS:
    // los .biz-tile / .biz-chips-grid quedaban sin reglas y se ve?an como texto amontonado.
    injectCSS();
    const header = headerEl || document.getElementById('app-header');
    if (!header || !header.parentNode) return;
    const wrap = document.createElement('div');
    wrap.id = 'navDbBarWrap';
    wrap.className = 'nav-db-bar-outer';
    wrap.innerHTML =
      '<section class="biz-db-shell nav-global-db-bar" style="display:none" aria-label="Selector de empresa">' +
      '  <div class="biz-db-inner">' +
      '    <header class="biz-db-head">' +
      '      <div class="biz-db-head-text">' +
      '        <p class="biz-db-eyebrow">Contexto de datos</p>' +
      '        <h2 class="biz-db-heading">Empresa activa</h2>' +
      '        <p class="biz-db-desc">Elige la base Firebird. Los informes y KPI usan esta conexi\u00f3n.</p>' +
      '      </div>' +
      '      <div class="biz-db-tools">' +
      '        <label class="biz-db-search-wrap">' +
      '          <span class="biz-db-search-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></span>' +
      '          <input type="search" class="biz-db-search" id="bizDbSearch" placeholder="Buscar empresa o archivo\u2026" autocomplete="off" />' +
      '        </label>' +
      '        <button type="button" class="biz-db-toggle" id="bizDbToggle" aria-expanded="true" title="Compactar panel">Ocultar</button>' +
      '      </div>' +
      '    </header>' +
      '    <div class="biz-db-body" id="bizDbBody">' +
      '      <div class="biz-chips-scroll"><div class="biz-chips biz-chips-grid" id="navGlobalDbChips"></div></div>' +
      '    </div>' +
      '  </div>' +
      '</section>';
    header.parentNode.insertBefore(wrap, header.nextSibling);
    const bar = wrap.querySelector('.biz-db-shell');
    const chips = document.getElementById('navGlobalDbChips');
    const base = (typeof window.__API_BASE !== 'undefined' && window.__API_BASE != null)
      ? String(window.__API_BASE).replace(/\/+$/, '')
      : (window.location.protocol === 'file:' ? 'http://localhost:7000' : (window.location.origin || ''));
    let list = [];
    try {
      const r = await fetch((base || '') + '/api/universe/databases');
      list = await r.json();
    } catch (e) {
      list = [];
    }
    if (!Array.isArray(list) || !list.length || !chips) return;
    bar.style.display = 'block';
    renderDbChipsInto(chips, list, function () { window.location.reload(); });

    var searchEl = document.getElementById('bizDbSearch');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        var q = (searchEl.value || '').trim().toLowerCase();
        chips.querySelectorAll('.biz-tile').forEach(function (btn) {
          var hay = (btn.getAttribute('data-search') || '').toLowerCase();
          btn.style.display = !q || hay.indexOf(q) >= 0 ? '' : 'none';
        });
      });
    }
    var toggleBtn = document.getElementById('bizDbToggle');
    var bodyEl = document.getElementById('bizDbBody');
    try {
      var val = sessionStorage.getItem('microsip_db_panel_collapsed');
      var collapsed = (val == null) ? true : val === '1';
      if (collapsed && bodyEl && toggleBtn) {
        bodyEl.hidden = true;
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.textContent = 'Mostrar';
      }
    } catch (_) {}
    if (toggleBtn && bodyEl) {
      toggleBtn.addEventListener('click', function () {
        var open = bodyEl.hidden;
        bodyEl.hidden = !open;
        toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggleBtn.textContent = open ? 'Ocultar' : 'Mostrar';
        try {
          sessionStorage.setItem('microsip_db_panel_collapsed', open ? '0' : '1');
        } catch (_) {}
      });
    }
  }

  function fire() {
    if (_cfg.onChange) _cfg.onChange(getParams(), buildQS);
  }

  async function loadVendedores() {
    try {
      const qs = buildQS();
      const url = API + '/api/config/filtros' + (qs ? '?' + qs : '');
      const data = await fetch(url).then(r => r.json());
      _vendedores = (data.vendedores || []).filter(v => v.NOMBRE);
    } catch (e) {
      _vendedores = [];
    }
  }

  function ensureDesignFonts() {
    if (document.getElementById('ms-erp-fonts')) return;
    var l = document.createElement('link');
    l.id = 'ms-erp-fonts';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,600&display=swap';
    document.head.appendChild(l);
  }

  function injectCSS() {
    ensureDesignFonts();
    if (document.getElementById('filter-bar-css')) return;
    const style = document.createElement('style');
    style.id = 'filter-bar-css';
    style.textContent = `
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        padding: 14px 18px;
        background: linear-gradient(145deg, rgba(15,23,42,.94), rgba(12,18,32,.88));
        border-radius: 16px;
        margin-bottom: 22px;
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 4px 24px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.04);
        backdrop-filter: blur(12px);
      }
      .fb-presets { display: flex; flex-wrap: wrap; gap: 8px; }
      .fb-preset {
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.03);
        color: #94a3b8;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: .02em;
        cursor: pointer;
        transition: transform .15s, border-color .15s, background .15s, color .15s, box-shadow .15s;
        white-space: nowrap;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      }
      .fb-preset:hover  {
        background: rgba(255,255,255,.07);
        color: #f1f5f9;
        border-color: rgba(245,124,0,.25);
        transform: translateY(-1px);
      }
      .fb-preset.active {
        background: linear-gradient(135deg, rgba(245,124,0,.22), rgba(255,184,0,.12));
        border-color: rgba(245,124,0,.45);
        color: #fff;
        box-shadow: 0 0 0 1px rgba(245,124,0,.15), 0 8px 20px rgba(245,124,0,.12);
      }
      .fb-sep { width: 1px; height: 32px; background: linear-gradient(180deg, transparent, rgba(255,255,255,.12), transparent); align-self: center; }
      .fb-selects { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .fb-select {
        padding: 8px 14px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(6,14,26,.6);
        color: #e2e8f0;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        max-width: 240px;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      }
      .fb-select:focus { outline: none; border-color: rgba(245,124,0,.45); box-shadow: 0 0 0 3px rgba(245,124,0,.12); }
      .fb-range { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .fb-range label { font-size: 11px; color: #8a94a6; display: flex; align-items: center; gap: 4px; }
      .fb-date {
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(6,14,26,.6);
        color: #e2e8f0;
        font-size: 12px;
      }
      .fb-date:focus { outline: none; border-color: rgba(245,124,0,.45); }

      /* ?? Panel selector de empresas (vista ?dashboard?) ?? */
      .nav-db-bar-outer { max-width: 1900px; margin: 0 auto 20px; padding: 0 1.5rem; width: 100%; box-sizing: border-box; }
      .biz-db-shell {
        border-radius: 20px;
        border: 1px solid rgba(255,255,255,.09);
        background: linear-gradient(165deg, rgba(17,28,48,.97) 0%, rgba(8,14,26,.94) 50%, rgba(12,20,36,.96) 100%);
        box-shadow:
          0 4px 6px rgba(0,0,0,.15),
          0 24px 48px rgba(0,0,0,.28),
          inset 0 1px 0 rgba(255,255,255,.06);
        overflow: hidden;
        position: relative;
      }
      .biz-db-shell::before {
        content: '';
        position: absolute; inset: 0;
        background: radial-gradient(900px 280px at 12% -20%, rgba(245,124,0,.14), transparent 55%),
                    radial-gradient(700px 200px at 88% 0%, rgba(30,127,217,.1), transparent 50%);
        pointer-events: none;
      }
      .biz-db-inner { position: relative; z-index: 1; padding: 20px 22px 18px; }
      .biz-db-head {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px 24px;
        margin-bottom: 16px;
      }
      .biz-db-eyebrow {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .2em;
        text-transform: uppercase;
        color: #f59e0b;
        margin: 0 0 6px;
      }
      .biz-db-heading {
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
        font-size: 1.35rem;
        font-weight: 800;
        letter-spacing: -.03em;
        color: #f8fafc;
        margin: 0 0 6px;
        line-height: 1.15;
      }
      .biz-db-desc {
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
        font-size: .8rem;
        color: #94a3b8;
        margin: 0;
        max-width: 520px;
        line-height: 1.5;
      }
      .biz-db-tools {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
      }
      .biz-db-search-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 14px 0 12px;
        min-width: min(100%, 280px);
        height: 44px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(6,14,26,.55);
        transition: border-color .2s, box-shadow .2s;
      }
      .biz-db-search-wrap:focus-within {
        border-color: rgba(245,124,0,.4);
        box-shadow: 0 0 0 3px rgba(245,124,0,.1);
      }
      .biz-db-search-ico { color: #64748b; flex-shrink: 0; display: grid; place-items: center; }
      .biz-db-search {
        flex: 1;
        min-width: 0;
        border: none;
        background: transparent;
        color: #f1f5f9;
        font-size: .82rem;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
        outline: none;
      }
      .biz-db-search::placeholder { color: #64748b; }
      .biz-db-toggle {
        height: 44px;
        padding: 0 18px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,.12);
        background: rgba(255,255,255,.04);
        color: #cbd5e1;
        font-size: 12px;
        font-weight: 600;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
        cursor: pointer;
        transition: background .15s, color .15s, border-color .15s;
      }
      .biz-db-toggle:hover {
        background: rgba(255,255,255,.08);
        color: #fff;
        border-color: rgba(255,255,255,.18);
      }
      .biz-db-body { padding-top: 2px; }
      .biz-chips-scroll {
        max-height: min(320px, 42vh);
        overflow-y: auto;
        overflow-x: hidden;
        padding: 4px 4px 8px;
        margin: 0 -4px;
        scrollbar-width: thin;
        scrollbar-color: rgba(245,124,0,.35) rgba(255,255,255,.06);
      }
      .biz-chips-scroll::-webkit-scrollbar { width: 8px; }
      .biz-chips-scroll::-webkit-scrollbar-thumb {
        background: rgba(245,124,0,.35);
        border-radius: 99px;
      }
      .biz-chips-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
        align-content: start;
      }
      .biz-tile {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        text-align: left;
        gap: 6px;
        padding: 14px 16px 14px;
        min-height: 96px;
        border-radius: 16px;
        border: 1px solid rgba(255,255,255,.1);
        background: rgba(255,255,255,.03);
        color: #cbd5e1;
        cursor: pointer;
        transition: transform .18s ease, border-color .18s, background .18s, box-shadow .18s;
        font-family: 'JetBrains Mono', 'DM Mono', ui-monospace, monospace;
        position: relative;
      }
      .biz-tile::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 16px;
        opacity: 0;
        transition: opacity .2s;
        background: linear-gradient(135deg, rgba(245,124,0,.08), rgba(30,127,217,.06));
        pointer-events: none;
      }
      .biz-tile:hover {
        transform: translateY(-2px);
        border-color: rgba(255,255,255,.18);
        background: rgba(255,255,255,.06);
        box-shadow: 0 12px 28px rgba(0,0,0,.25);
      }
      .biz-tile:hover::after { opacity: 1; }
      .biz-tile.active {
        border-color: rgba(245,124,0,.55);
        background: linear-gradient(145deg, rgba(245,124,0,.18), rgba(245,124,0,.06));
        box-shadow: 0 0 0 1px rgba(245,124,0,.2), 0 16px 40px rgba(245,124,0,.12);
        color: #fff;
      }
      .biz-tile.active::after { opacity: 0; }
      .biz-tile-kicker {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: .14em;
        text-transform: uppercase;
        color: #64748b;
      }
      .biz-tile.active .biz-tile-kicker { color: rgba(251,191,36,.9); }
      .biz-tile-title {
        font-size: 12px;
        font-weight: 600;
        line-height: 1.35;
        color: #f1f5f9;
        word-break: break-word;
        width: 100%;
      }
      .biz-tile-meta {
        font-size: 10px;
        font-weight: 500;
        color: #94a3b8;
        line-height: 1.4;
        width: 100%;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      }
      .biz-tile.active .biz-tile-meta { color: #e2e8f0; }

      /* Compat: barras embebidas que a?n usen .biz-context-bar */
      .biz-context-bar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
        padding: 14px 18px; border-radius: 16px; margin-bottom: 18px;
        background: linear-gradient(145deg, rgba(15,23,42,.9), rgba(12,18,32,.85));
        border: 1px solid rgba(255,255,255,.08);
      }
      .biz-context-label {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
        color: #94a3b8;
      }
      .biz-chips:not(.biz-chips-grid) { display: flex; flex-wrap: wrap; gap: 8px; flex: 1; min-width: 0; }

      .fb-apply {
        padding: 8px 18px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #f57c00, #ea580c);
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
        transition: transform .15s, filter .15s;
      }
      .fb-apply:hover { filter: brightness(1.08); transform: translateY(-1px); }
      .fb-label-active { font-size: 11px; color: #f59e0b; font-weight: 600; white-space: nowrap; }

      html[data-theme="light"] .filter-bar {
        background: linear-gradient(145deg, #fff, #f1f5f9);
        border-color: rgba(15,23,42,.1);
        box-shadow: 0 4px 20px rgba(15,23,42,.06);
      }
      html[data-theme="light"] .fb-preset { color: #475569; background: rgba(15,23,42,.04); border-color: rgba(15,23,42,.1); }
      html[data-theme="light"] .fb-preset:hover { color: #0f172a; background: rgba(15,23,42,.06); }
      html[data-theme="light"] .fb-preset.active {
        color: #fff;
        background: linear-gradient(135deg, #ea580c, #f59e0b);
        border-color: rgba(234,88,12,.5);
      }
      html[data-theme="light"] .fb-select, html[data-theme="light"] .fb-date {
        background: #fff;
        color: #0f172a;
        border-color: rgba(15,23,42,.12);
      }
      html[data-theme="light"] .biz-db-shell {
        background: linear-gradient(165deg, #fff 0%, #f8fafc 100%);
        border-color: rgba(15,23,42,.1);
        box-shadow: 0 4px 24px rgba(15,23,42,.08);
      }
      html[data-theme="light"] .biz-db-heading { color: #0f172a; }
      html[data-theme="light"] .biz-db-desc { color: #64748b; }
      html[data-theme="light"] .biz-db-search-wrap { background: #f1f5f9; border-color: rgba(15,23,42,.1); }
      html[data-theme="light"] .biz-db-search { color: #0f172a; }
      html[data-theme="light"] .biz-tile {
        background: rgba(15,23,42,.03);
        border-color: rgba(15,23,42,.1);
        color: #334155;
      }
      html[data-theme="light"] .biz-tile-title { color: #0f172a; }
      html[data-theme="light"] .biz-tile-meta { color: #64748b; }
      html[data-theme="light"] .biz-tile.active {
        background: linear-gradient(145deg, rgba(251,191,36,.2), rgba(253,230,138,.15));
        border-color: rgba(217,119,6,.45);
      }
      html[data-theme="light"] .biz-tile-kicker { color: #64748b; }

      @keyframes ms-dash-rise {
        from { opacity: 0; transform: translateY(14px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .card, .kpi-card, .k, article.k, .g2 > .card {
        animation: ms-dash-rise 0.55s cubic-bezier(.22, 1, .36, 1) both;
      }

      /* Semáforo KPI: borde + halo (todas las páginas que cargan filters.js) */
      .kpi-card.dash-sem-ok, .kpi.dash-sem-ok, article.k.dash-sem-ok, .dash-sem-host.dash-sem-ok {
        box-shadow: 0 0 0 1px rgba(0, 229, 160, 0.38), 0 12px 40px rgba(0, 229, 160, 0.1) !important;
        border-color: rgba(0, 229, 160, 0.5) !important;
      }
      .kpi-card.dash-sem-warn, .kpi.dash-sem-warn, article.k.dash-sem-warn, .dash-sem-host.dash-sem-warn {
        box-shadow: 0 0 0 1px rgba(255, 184, 0, 0.42), 0 12px 40px rgba(255, 184, 0, 0.09) !important;
        border-color: rgba(255, 184, 0, 0.48) !important;
      }
      .kpi-card.dash-sem-danger, .kpi.dash-sem-danger, article.k.dash-sem-danger, .dash-sem-host.dash-sem-danger {
        box-shadow: 0 0 0 1px rgba(255, 69, 102, 0.42), 0 12px 40px rgba(255, 69, 102, 0.1) !important;
        border-color: rgba(255, 69, 102, 0.5) !important;
      }
      .kpi-card.dash-sem-info, .kpi.dash-sem-info, article.k.dash-sem-info, .dash-sem-host.dash-sem-info {
        box-shadow: 0 0 0 1px rgba(77, 166, 255, 0.35), 0 12px 40px rgba(77, 166, 255, 0.08) !important;
        border-color: rgba(77, 166, 255, 0.42) !important;
      }
      .kpi-card.dash-sem-neutral, .kpi.dash-sem-neutral, article.k.dash-sem-neutral, .dash-sem-host.dash-sem-neutral {
        box-shadow: 0 0 0 1px rgba(90, 112, 144, 0.25), 0 8px 28px rgba(0, 0, 0, 0.12) !important;
        border-color: rgba(148, 163, 184, 0.22) !important;
      }
      html[data-theme="light"] .kpi-card.dash-sem-ok, html[data-theme="light"] .kpi.dash-sem-ok, html[data-theme="light"] article.k.dash-sem-ok, html[data-theme="light"] .dash-sem-host.dash-sem-ok {
        box-shadow: 0 0 0 1px rgba(22, 163, 74, 0.35), 0 8px 28px rgba(22, 163, 74, 0.07) !important;
        border-color: rgba(22, 163, 74, 0.4) !important;
      }
      html[data-theme="light"] .kpi-card.dash-sem-warn, html[data-theme="light"] .kpi.dash-sem-warn, html[data-theme="light"] article.k.dash-sem-warn, html[data-theme="light"] .dash-sem-host.dash-sem-warn {
        box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.35), 0 8px 28px rgba(217, 119, 6, 0.08) !important;
        border-color: rgba(217, 119, 6, 0.42) !important;
      }
      html[data-theme="light"] .kpi-card.dash-sem-danger, html[data-theme="light"] .kpi.dash-sem-danger, html[data-theme="light"] article.k.dash-sem-danger, html[data-theme="light"] .dash-sem-host.dash-sem-danger {
        box-shadow: 0 0 0 1px rgba(220, 38, 38, 0.32), 0 8px 28px rgba(220, 38, 38, 0.07) !important;
        border-color: rgba(220, 38, 38, 0.4) !important;
      }
      html[data-theme="light"] .kpi-card.dash-sem-info, html[data-theme="light"] .kpi.dash-sem-info, html[data-theme="light"] article.k.dash-sem-info, html[data-theme="light"] .dash-sem-host.dash-sem-info {
        box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.28), 0 8px 28px rgba(37, 99, 235, 0.06) !important;
        border-color: rgba(37, 99, 235, 0.35) !important;
      }
      html[data-theme="light"] .kpi-card.dash-sem-neutral, html[data-theme="light"] .kpi.dash-sem-neutral, html[data-theme="light"] article.k.dash-sem-neutral, html[data-theme="light"] .dash-sem-host.dash-sem-neutral {
        box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.12), 0 6px 20px rgba(15, 23, 42, 0.06) !important;
        border-color: rgba(15, 23, 42, 0.14) !important;
      }
    `;
    document.head.appendChild(style);
  }

  var DASH_SEM_LEVELS = ['ok', 'warn', 'danger', 'info', 'neutral'];
  function dashboardSemClass(level) {
    var k = String(level == null ? 'neutral' : level).toLowerCase();
    return DASH_SEM_LEVELS.indexOf(k) >= 0 ? ('dash-sem-' + k) : 'dash-sem-neutral';
  }
  function dashboardApplySem(el, level) {
    if (!el || el.nodeType !== 1) return;
    DASH_SEM_LEVELS.forEach(function (lv) {
      el.classList.remove('dash-sem-' + lv);
    });
    el.classList.add(dashboardSemClass(level));
  }

  function renderBar() {
    injectCSS();
    const c = document.getElementById(_cfg.containerId || 'filter-bar');
    if (!c) return;

    const d  = today();
    const y  = d.getFullYear();

    let vendOpts = '<option value="">Todos los vendedores</option>';
    _vendedores.forEach(v => {
      vendOpts += `<option value="${v.VENDEDOR_ID}" ${String(_state.vendedor) === String(v.VENDEDOR_ID) ? 'selected' : ''}>${v.NOMBRE}</option>`;
    });

    const presets = [
      { key: 'hoy',      label: 'Hoy' },
      { key: 'semana',   label: 'Esta Semana' },
      { key: 'mes',      label: 'Este Mes' },
      { key: 'mes_ant',  label: 'Mes Anterior' },
      { key: 'anio',     label: 'Este A&#241;o' },
      { key: 'anio_ant', label: 'A&#241;o Anterior' },
    ];

    const presetBtns = presets.map(p =>
      `<button class="fb-preset ${_state.preset === p.key ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`
    ).join('');

    const vendSection = (_cfg.showVendedor !== false)
      ? `<div class="fb-selects"><select class="fb-select" id="fb-vendedor" title="Vendedor">${vendOpts}</select></div>`
      : '';

    c.innerHTML = `
      <div class="filter-bar">
        <div class="fb-presets">${presetBtns}</div>
        ${(_cfg.showVendedor !== false) ? `<div class="fb-sep"></div>${vendSection}` : ''}
      </div>`;

    c.querySelectorAll('.fb-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        applyPreset(btn.dataset.preset);
        renderBar();
        fire();
      });
    });

    const selVend = c.querySelector('#fb-vendedor');
    if (selVend) selVend.addEventListener('change', () => {
      _state.vendedor = selVend.value;
      renderBar();
      fire();
    });
  }

  async function initFilters(config) {
    try {
      _cfg   = config || {};
      _state = { preset: 'mes', anio: null, mes: null, desde: '', hasta: '', vendedor: '' };

      applyPreset(_cfg.defaultPreset || 'mes');

      if (_cfg.showVendedor !== false) {
        await loadVendedores();
      }

      renderBar();

      if (_cfg.onReady) _cfg.onReady(getParams(), buildQS);
    } catch(e) {
      console.warn('[filters.js] initFilters error:', e);
      try { if (config && config.onReady) config.onReady({}, () => ''); } catch(_) {}
    }
  }

  window.initFilters              = initFilters;
  window.filterBuildQS            = buildQS;
  window.filterGetParams          = getParams;
  window.filterClearVendedorSilent = clearVendedorSilent;
  window.getSelectedDbId          = getSelectedDbId;
  window.renderDbChipsInto        = renderDbChipsInto;
  window.apiPathWithDb            = apiPathWithDb;
  window.initGlobalDbBarAfterNav  = initGlobalDbBarAfterNav;
  window.dashboardSemClass        = dashboardSemClass;
  window.dashboardApplySem        = dashboardApplySem;

})();
