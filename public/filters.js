/**
 * filters.js � Barra de filtros compartida � Suminregio Parker ERP
 * -----------------------------------------------------------------
 * Uso b�sico:
 *   1) A�adir <div id="filter-bar"></div> en el HTML
 *   2) <script src="filters.js"></script>
 *   3) Llamar initFilters({ containerId, showVendedor, onChange })
 *
 * API p�blica:
 *   initFilters(config)   � inicializa y renderiza la barra
 *   filterBuildQS(extras) � devuelve query-string con los filtros activos
 *   filterGetParams()     � devuelve objeto { anio, mes, desde, hasta, vendedor }
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
  const PARKER_DB_CANDIDATES = ['default'];

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
      // Compat backward: alias legacy "SUMINREGIO-PARKER" -> "default" real id.
      if (/^suminregio[-_\s]?parker$/i.test(db)) db = 'default';
      if (!db) db = PARKER_DB_CANDIDATES[0];
      return db;
    } catch (e) {
      return PARKER_DB_CANDIDATES[0];
    }
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

  /** extras: objeto opcional. opts.omitDb = true no a�ade ?db= (p. ej. universe/scorecard). */
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
    const base = i >= 0 ? s.slice(i + 1) : s;
    return base.replace(/\.fdb$/i, '');
  }

  const ALLOWED_DB_TERMS = ['suminregio', 'agua', 'medicos', 'madera', 'carton', 'especial', 'reciclaje'];
  const DB_DISPLAY_STRIP_TERMS = ['suminregio', 'parker', 'grupo', 'suministros'];
  const DB_ALLOWED_SET = ALLOWED_DB_TERMS.reduce(function (acc, t) { acc[t] = 1; return acc; }, {});
  function isSnapshotOrTempDb(e) {
    const pool = normDbText([
      e && e.id,
      e && e.label,
      fdbBasename(e && e.database)
    ].join(' '));
    if (pool.indexOf('parker') < 0) return false;
    return (
      /(^|[_\-\s])(ant|temp|msp)([_\-\s]|$)/.test(pool) ||
      /parker[_\-\s]*23\s*jun|parker[_\-\s]*23jun/.test(pool) ||
      /parker[_\-\s]*320/.test(pool) ||
      /parker[_\-\s]*paso/.test(pool)
    );
  }
  function normDbText(v) {
    return String(v == null ? '' : v)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
  function cleanDbDisplayName(v) {
    const raw = String(v == null ? '' : v).replace(/\.fdb$/i, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const toks = raw.split(' ');
    const cleaned = toks.filter(function (t) {
      const n = normDbText(t).replace(/[^a-z0-9]+/g, '');
      if (!n) return false;
      return DB_DISPLAY_STRIP_TERMS.indexOf(n) < 0;
    }).join(' ').trim();
    return cleaned || raw;
  }
  function filterAllowedDatabases(list) {
    const arr = Array.isArray(list) ? list : [];
    const out = arr.filter(function (e) {
      if (isSnapshotOrTempDb(e)) return false;
      const mainFields = [
        e && e.id,
        e && e.label,
        fdbBasename(e && e.database)
      ].join(' ');
      const pool = normDbText(mainFields);
      const tokens = pool.split(/[^a-z0-9]+/).filter(Boolean);
      if (ALLOWED_DB_TERMS.some(function (t) { return pool.indexOf(t) >= 0; })) return true;
      return tokens.some(function (tk) { return !!DB_ALLOWED_SET[tk]; });
    });

    return out;
  }
  if (typeof window !== 'undefined') {
    window.filterDbCatalog = filterAllowedDatabases;
  }

  function renderDbChipsInto(container, list, onChange) {
    if (!container) return;
    let urlDb = getSelectedDbId();
    const ids = (list || []).map(function (e) { return String((e && e.id) || ''); });
    const preferred = PARKER_DB_CANDIDATES.find(function (id) { return ids.indexOf(id) >= 0; }) || ids[0] || '';
    if (!urlDb || (urlDb !== '__all__' && ids.indexOf(urlDb) < 0)) urlDb = preferred;
    if (urlDb) {
      try {
        const u = new URL(window.location.href);
        u.searchParams.set('db', urlDb);
        history.replaceState({}, '', u);
      } catch (_) {}
      if (urlDb !== '__all__') {
        try { sessionStorage.setItem('microsip_erp_db', urlDb); } catch (_) {}
      }

    }
    let html = '';
    const isAll = (urlDb === '__all__');
    html += '<button type="button" class="biz-chip db-chip' + (isAll ? ' active' : '') + '" data-db="__all__" title="Suma ventas/P&amp;L de todos los negocios de la barra">' +
      '<span class="db-chip-main">Todos los Negocios</span><span class="db-chip-sub">Suma de negocios en barra</span></button>';
    (list || []).forEach(function (e) {
      const id = String(e.id || '');
      const fname = fdbBasename(e.database);
      const main = cleanDbDisplayName(fname || id);
      const idClean = String(id).replace(/\.fdb$/i, '');
      const labelClean = cleanDbDisplayName(String(e.label || '').replace(/\.fdb$/i, ''));
      const idPretty = cleanDbDisplayName(idClean);
      const sub = (labelClean && labelClean !== main && labelClean !== idPretty) ? labelClean : idPretty;
      const active = (!isAll && urlDb === id) ? ' active' : '';
      const title = escChip((e.database || '') + (e.host ? ' \u00b7 ' + e.host : ''));
      html += '<button type="button" class="biz-chip db-chip' + active + '" data-db="' + escChip(id) + '" title="' + title + '">' +
        '<span class="db-chip-main">' + escChip(main) + '</span><span class="db-chip-sub">' + escChip(sub) + '</span></button>';
    });
    container.innerHTML = html;

    container.querySelectorAll('.biz-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const raw = btn.getAttribute('data-db') || preferred || PARKER_DB_CANDIDATES[0];
        try {
          const u = new URL(window.location.href);
          u.searchParams.set('db', raw);
          history.replaceState({}, '', u);
        } catch (_) {}
        // No persistir __all__ en sessionStorage; solo afecta la página actual
        if (raw !== '__all__') {
          try { sessionStorage.setItem('microsip_erp_db', raw); } catch (_) {}
        }

        container.querySelectorAll('.biz-chip').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        if (onChange) onChange(raw);
      });
    });
  }

  /** A�ade ?db= a una ruta que empieza en /api/... (o path relativo con query). */
  function apiPathWithDb(path) {
    const db = getSelectedDbId();
    if (!db) return path;
    const sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + 'db=' + encodeURIComponent(db);
  }

  async function initGlobalDbBarAfterNav(headerEl) {
    if (document.getElementById('bizChips')) return;
    if (document.getElementById('navDbBarWrap')) return;
    const header = headerEl || document.getElementById('app-header');
    if (!header || !header.parentNode) return;
    const wrap = document.createElement('div');
    wrap.id = 'navDbBarWrap';
    wrap.className = 'nav-db-bar-outer';
    wrap.innerHTML = '<div class="biz-context-bar nav-global-db-bar" style="display:none;margin:0 auto 14px;max-width:1900px;width:calc(100% - 3rem)">' +
      '<span class="biz-context-label">Unidad de negocio</span><div class="biz-chips" id="navGlobalDbChips"></div></div>';
    header.parentNode.insertBefore(wrap, header.nextSibling);
    const bar = wrap.querySelector('.biz-context-bar');
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
    list = filterAllowedDatabases(list);
    if (!Array.isArray(list) || !list.length || !chips) return;
    bar.style.display = 'flex';
    renderDbChipsInto(chips, list, function () {
      if (typeof window.filterSyncFiltersToUrl === 'function') window.filterSyncFiltersToUrl();
      window.location.reload();
    });
  }

  /** Sincroniza fecha/vendedor/preset en la URL para que sigan vivos tras reload (?db= en chips). */
  function syncFiltersToUrl() {
    try {
      const u = new URL(window.location.href);
      // P&L (resultados): no reescribir query con preset global — el usuario y el back usan anio/mes propios
      if (/resultados\.html$/i.test(u.pathname)) {

        return;
      }
      const p = getParams();
      const sp = new URLSearchParams();
      const db = getSelectedDbId();
      if (db) sp.set('db', db);
      if (p.desde && p.hasta) {
        sp.set('desde', p.desde);
        sp.set('hasta', p.hasta);
      } else {
        if (p.anio != null && p.anio !== '') sp.set('anio', String(p.anio));
        if (p.mes != null && p.mes !== '') sp.set('mes', String(p.mes));
      }
      if (p.preset) sp.set('preset', String(p.preset));
      if (p.vendedor) sp.set('vendedor', String(p.vendedor));
      const qs = sp.toString();
      const path = u.pathname + (u.hash || '');
      history.replaceState({}, '', path + (qs ? '?' + qs : ''));
    } catch (_) {}
  }

  /** Lee ?preset=&anio=&mes=&desde=&hasta=&vendedor= al cargar (p. ej. tras reload con ?db=). */
  function hydrateFiltersFromUrl() {
    try {
      const sp = new URLSearchParams(window.location.search);
      const v = sp.get('vendedor');
      if (v) _state.vendedor = v;
      const desde = sp.get('desde');
      const hasta = sp.get('hasta');
      if (desde && hasta && /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
        _state.desde = desde;
        _state.hasta = hasta;
        _state.anio = null;
        _state.mes = null;
        const pr = sp.get('preset');
        if (pr && (pr === 'hoy' || pr === 'semana')) _state.preset = pr;
        else _state.preset = 'hoy';
        return;
      }
      const pr = sp.get('preset');
      if (pr && ['hoy', 'semana', 'mes', 'mes_ant', 'anio', 'anio_ant'].indexOf(pr) >= 0) {
        applyPreset(pr);
      }
      const anio = parseInt(sp.get('anio'), 10);
      const mes = parseInt(sp.get('mes'), 10);
      if (!isNaN(anio)) _state.anio = anio;
      if (!isNaN(mes)) _state.mes = mes;
    } catch (_) {}
  }

  function fire() {
    syncFiltersToUrl();
    if (_cfg.onChange) _cfg.onChange(getParams(), buildQS);
  }

  async function loadVendedores() {
    try {
      const qs = buildQS();
      const url = API + '/api/config/filtros' + (qs ? '?' + qs : '');
      const ac = new AbortController();
      const t = setTimeout(function () {
        try { ac.abort(); } catch (_) {}
      }, 25000);
      let r;
      try {
        r = await fetch(url, { signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
      const data = await r.json();
      _vendedores = (data.vendedores || []).filter(v => v.NOMBRE);
    } catch (e) {
      _vendedores = [];
    }
  }

  function injectCSS() {
    if (!document.getElementById('filter-bar-css')) {
    const style = document.createElement('style');
    style.id = 'filter-bar-css';
    style.textContent = `
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: linear-gradient(180deg, rgba(17,30,45,.94), rgba(13,22,34,.94));
        border-radius: 14px;
        margin-bottom: 16px;
        border: 1px solid rgba(120,155,196,.24);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 8px 24px rgba(2,8,23,.25);
      }
      .fb-presets { display: flex; flex-wrap: wrap; gap: 6px; }
      .fb-preset {
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid rgba(140,174,212,.24);
        background: rgba(19,31,46,.72);
        color: #b4c4d8;
        font-size: 11px;
        letter-spacing: .01em;
        cursor: pointer;
        transition: all .18s ease;
        white-space: nowrap;
      }
      .fb-preset:hover  { background: rgba(34,54,77,.95); border-color: rgba(140,174,212,.4); color:#e5edf8; transform: translateY(-1px); }
      .fb-preset.active {
        background: linear-gradient(135deg, rgba(230,168,0,.95), rgba(255,138,51,.9));
        border-color: rgba(255,196,99,.75);
        color:#0b1624;
        font-weight:700;
      }
      .fb-sep { width: 1px; height: 30px; background: rgba(140,174,212,.24); align-self: center; }
      .fb-selects { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .fb-select {
        padding: 7px 11px;
        border-radius: 10px;
        border: 1px solid rgba(140,174,212,.24);
        background: rgba(15,26,40,.86);
        color: #d3deea;
        font-size: 12px;
        cursor: pointer;
        max-width: 200px;
      }
      .fb-select:focus { outline: none; border-color: rgba(230,168,0,.6); box-shadow: 0 0 0 3px rgba(230,168,0,.14); }
      .fb-range { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .fb-range label { font-size: 11px; color: #8a94a6; display: flex; align-items: center; gap: 4px; }
      .fb-date {
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.18);
        background: #151c27;
        color: #c0c8d4;
        font-size: 12px;
      }
      .fb-date:focus { outline: none; border-color: var(--accent,#3b82f6); }
      .biz-context-bar {
        display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
        padding: 10px 14px; border-radius: 14px; margin-bottom: 14px;
        background: linear-gradient(180deg, rgba(16,29,44,.92), rgba(11,22,34,.92));
        border: 1px solid rgba(120,155,196,.22);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.04), 0 8px 22px rgba(2,8,23,.24);
      }
      .biz-context-label {
        font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
        color: #6A85A6; white-space: nowrap;
      }
      .biz-chips { display: flex; flex-wrap: wrap; gap: 10px; row-gap: 10px; flex: 1; min-width: 0; align-content: flex-start; }
      .biz-chip {
        font-family: ui-monospace, 'DM Mono', monospace; font-size: 11px;
        padding: 7px 12px; border-radius: 999px; border: 1px solid rgba(140,174,212,.22);
        background: rgba(18,31,46,.7); color: #b8c8da; cursor: pointer; transition: .2s;
        text-align: left;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
        box-sizing: border-box;
      }
      .biz-chip:hover { color: #f0f5fb; border-color: rgba(230,168,0,.45); transform: translateY(-1px); }
      .biz-chip.active {
        color: #111c2a; border-color: rgba(255,205,122,.7);
        background: linear-gradient(135deg, rgba(230,168,0,.95), rgba(255,138,51,.9));
      }
      .db-chip-main { display: block; font-weight: 600; letter-spacing: .02em; }
      .db-chip-sub { display: block; font-size: 9px; opacity: .82; margin-top: 2px; font-weight: 500; }

      .fb-apply {
        padding: 5px 14px;
        border-radius: 6px;
        border: none;
        background: var(--accent,#3b82f6);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        font-weight: 600;
        transition: opacity .15s;
      }
      .fb-apply:hover { opacity: .85; }
      .fb-label-active { font-size: 11px; color: var(--accent,#3b82f6); font-weight: 600; white-space: nowrap; }
      @media (max-width: 780px) {
        .filter-bar, .biz-context-bar { padding: 10px 10px; border-radius: 12px; }
        .fb-preset, .biz-chip { font-size: 10px; padding: 6px 10px; }
        .db-chip-sub { display: none; }
      }
    `;
    document.head.appendChild(style);
    }
    injectPremiumFilterOverrides();
  }

  /** Barra de filtros legible en ERP premium (tema claro; sin barra oscura). */
  function injectPremiumFilterOverrides() {
    if (!document.documentElement.classList.contains('theme-premium-light')) return;
    if (document.getElementById('filter-bar-css-premium')) return;
    const s = document.createElement('style');
    s.id = 'filter-bar-css-premium';
    s.textContent = `
      html.theme-premium-light[data-theme="light"] .filter-bar {
        background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%) !important;
        border: 1px solid rgba(15, 23, 42, 0.1) !important;
        box-shadow: 0 4px 18px rgba(15, 23, 42, 0.06) !important;
      }
      html.theme-premium-light[data-theme="light"] .fb-preset {
        background: #f1f5f9 !important;
        color: #475569 !important;
        border-color: rgba(15, 23, 42, 0.1) !important;
      }
      html.theme-premium-light[data-theme="light"] .fb-preset:hover {
        background: #e2e8f0 !important;
        color: #0f172a !important;
      }
      html.theme-premium-light[data-theme="light"] .fb-preset.active {
        background: linear-gradient(135deg, #fbbf24, #f59e0b) !important;
        color: #422006 !important;
        border-color: rgba(217, 119, 6, 0.35) !important;
      }
      html.theme-premium-light[data-theme="light"] .fb-select {
        background: #fff !important;
        color: #0f172a !important;
        border-color: rgba(15, 23, 42, 0.12) !important;
      }
      html.theme-premium-light[data-theme="light"] .biz-context-bar {
        background: linear-gradient(180deg, #f8fafc, #f1f5f9) !important;
        border: 1px solid rgba(15, 23, 42, 0.1) !important;
        box-shadow: 0 2px 12px rgba(15, 23, 42, 0.05) !important;
      }
      html.theme-premium-light[data-theme="light"] .biz-context-label { color: #64748b !important; }
      html.theme-premium-light[data-theme="light"] .biz-chip {
        background: #fff !important;
        color: #334155 !important;
        border-color: rgba(15, 23, 42, 0.12) !important;
      }
      html.theme-premium-light[data-theme="light"] .biz-chip:hover { color: #0f172a !important; }
      html.theme-premium-light[data-theme="light"] .biz-chip.active {
        color: #422006 !important;
        background: linear-gradient(135deg, #fbbf24, #f59e0b) !important;
        border-color: rgba(217, 119, 6, 0.4) !important;
      }
    `;
    document.head.appendChild(s);
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
      hydrateFiltersFromUrl();

      const vendPromise = (_cfg.showVendedor !== false) ? loadVendedores() : null;

      renderBar();
      syncFiltersToUrl();

      if (_cfg.onReady) await Promise.resolve(_cfg.onReady(getParams(), buildQS));

      if (vendPromise) {
        await vendPromise;
        renderBar();
        syncFiltersToUrl();
      }
    } catch(e) {
      console.warn('[filters.js] initFilters error:', e);
      try { if (config && config.onReady) await Promise.resolve(config.onReady({}, () => '')); } catch(_) {}
    }
  }

  /**
   * Une el snapshot de GET /api/cxc/resumen con dir.cxc de /api/director/resumen.
   * Cubre timeout/fetch vacío y el caso en que el resumen aislado llegue sin VENCIDO coherente
   * mientras el director ya trae la misma cartera con mora correcta (misma fuente servidor).
   */
  function mergeCxcKpiWithDirector(cxcRaw, directorRaw) {
    function norm(o) {
      if (!o || typeof o !== 'object') {
        return { SALDO_TOTAL: 0, VENCIDO: 0, POR_VENCER: 0, NUM_CLIENTES: 0, NUM_CLIENTES_VENCIDOS: null };
      }
      var r = o.resumen && typeof o.resumen === 'object' ? o.resumen : o;
      function pickNum() {
        for (var i = 0; i < arguments.length; i++) {
          var k = arguments[i];
          if (r[k] != null && r[k] !== '' && !isNaN(+r[k])) return +r[k];
        }
        return 0;
      }
      var nv = r.NUM_CLIENTES_VENCIDOS;
      if (nv == null || nv === '') nv = r.num_clientes_vencidos;
      return {
        SALDO_TOTAL: pickNum('SALDO_TOTAL', 'saldo_total'),
        VENCIDO: pickNum('VENCIDO', 'vencido'),
        POR_VENCER: pickNum('POR_VENCER', 'por_vencer'),
        NUM_CLIENTES: pickNum('NUM_CLIENTES', 'num_clientes'),
        NUM_CLIENTES_VENCIDOS: nv != null && nv !== '' ? nv : null
      };
    }
    var a = norm(cxcRaw);
    var b = norm(directorRaw && directorRaw.cxc ? directorRaw.cxc : {});
    if (a.SALDO_TOTAL <= 0 && a.VENCIDO <= 0 && (b.SALDO_TOTAL > 0 || b.VENCIDO > 0)) return b;
    var out = {
      SALDO_TOTAL: a.SALDO_TOTAL,
      VENCIDO: a.VENCIDO,
      POR_VENCER: a.POR_VENCER,
      NUM_CLIENTES: a.NUM_CLIENTES,
      NUM_CLIENTES_VENCIDOS: a.NUM_CLIENTES_VENCIDOS
    };
    if (a.SALDO_TOTAL > 0 && b.SALDO_TOTAL > 0) {
      var mx = Math.max(a.SALDO_TOTAL, b.SALDO_TOTAL);
      var relDiff = Math.abs(a.SALDO_TOTAL - b.SALDO_TOTAL) / mx;
      if (relDiff <= 0.02) {
        if (b.VENCIDO > a.VENCIDO) out.VENCIDO = b.VENCIDO;
        if (b.POR_VENCER > a.POR_VENCER) out.POR_VENCER = b.POR_VENCER;
        if ((out.NUM_CLIENTES_VENCIDOS == null || out.NUM_CLIENTES_VENCIDOS === '') && b.NUM_CLIENTES_VENCIDOS != null) {
          out.NUM_CLIENTES_VENCIDOS = b.NUM_CLIENTES_VENCIDOS;
        }
      }
    }
    return out;
  }

  window.initFilters              = initFilters;
  window.filterBuildQS            = buildQS;
  window.filterGetParams          = getParams;
  window.getSelectedDbId          = getSelectedDbId;
  window.renderDbChipsInto        = renderDbChipsInto;
  window.apiPathWithDb            = apiPathWithDb;
  window.initGlobalDbBarAfterNav  = initGlobalDbBarAfterNav;
  window.filterSyncFiltersToUrl   = syncFiltersToUrl;
  window.mergeCxcKpiWithDirector  = mergeCxcKpiWithDirector;

})();
