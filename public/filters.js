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
  let _clientes   = [];
  let _state      = { preset: 'mes', anio: null, mes: null, desde: '', hasta: '', vendedor: '', cliente: '' };
  /** Copia editable cuando deferApply: preset/fechas/vendedor no disparan carga hasta Aplicar. */
  let _pending    = null;

  function copyFilterState(src) {
    const s = src || _state;
    return {
      preset: s.preset || 'mes',
      anio: s.anio == null ? null : s.anio,
      mes: s.mes == null ? null : s.mes,
      desde: s.desde || '',
      hasta: s.hasta || '',
      vendedor: s.vendedor || '',
      cliente: s.cliente || ''
    };
  }
  function filterStatesEqual(a, b) {
    if (!a || !b) return true;
    return a.preset === b.preset && a.anio === b.anio && a.mes === b.mes &&
      a.desde === b.desde && a.hasta === b.hasta &&
      String(a.vendedor || '') === String(b.vendedor || '') &&
      String(a.cliente || '') === String(b.cliente || '');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function today() { return new Date(); }

  function applyPreset(preset, tgt) {
    const t = tgt || _state;
    const d  = today();
    const y  = d.getFullYear();
    const m  = d.getMonth() + 1;
    t.preset = preset;
    t.desde  = '';
    t.hasta  = '';
    t.anio   = null;
    t.mes    = null;

    switch (preset) {
      case 'hoy':
        t.desde = t.hasta = isoDate(d);
        break;
      case 'semana': {
        const dow   = d.getDay();
        const start = new Date(d);
        start.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        t.desde = isoDate(start);
        t.hasta = isoDate(d);
        break;
      }
      case 'ytd': {
        // Year-to-date (Ene → hoy): alinea con Power BI cuando el slicer Año-Mes
        // está acotado a meses del año en curso (Ene–Abr, etc.).
        // Se implementa como rango desde/hasta para que todas las APIs respeten el mismo corte.
        const start = new Date(y, 0, 1);
        t.desde = isoDate(start);
        t.hasta = isoDate(d);
        break;
      }
      case 'mes':
        t.anio = y;
        t.mes  = m;
        break;
      case 'mes_ant':
        t.anio = (m === 1) ? y - 1 : y;
        t.mes  = (m === 1) ? 12    : m - 1;
        break;
      case 'anio':
        t.anio = y;
        break;
      case 'anio_ant':
        t.anio = y - 1;
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

  /** Igual que cxc.html cxcEffectiveDb(): solo ?db= y sessionStorage; sin alias parker→default y sin fallback a default forzado. Si vacío, no se envía ?db= (servidor = misma regla que CxC sin parámetro). */
  function getDbForCxcApi() {
    try {
      var u = (new URLSearchParams(window.location.search).get('db') || '').trim();
      if (u) return u;
      var s = (sessionStorage.getItem('microsip_erp_db') || '').trim();
      if (s) return s;
    } catch (e) {}
    return '';
  }

  /** Mismo criterio que cxc.html: saldo neto documento (`documento`) salvo URL/sessionStorage explícitos. */
  function getCxcTotalKpiParam() {
    try {
      var u = (new URLSearchParams(window.location.search).get('cxc_total') || '').trim();
      if (u) return u.toLowerCase();
      var s = (sessionStorage.getItem('cxc_total_kpi') || '').trim();
      if (s) return s.toLowerCase();
    } catch (e) {}
    return 'documento';
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
    if (_state.cliente) p.cliente = _state.cliente;
    return p;
  }

  /** extras: objeto opcional. opts.omitDb = true no a�ade ?db= (p. ej. universe/scorecard). opts.omitVendedor = true quita vendedor del QS (p. ej. vista global de ventas-diarias). opts.useCxcDbIdentity = true usa mismo ?db= que la pestaña CxC (sin alias parker→default). opts.omitPeriodForCxcSnapshot = true quita periodo del QS para snapshot CxC KPI (posición, no ventas del periodo). */
  function buildQS(extras, opts) {
    const p = Object.assign({}, getParams(), (extras && typeof extras === 'object') ? extras : {});
    if (opts && opts.omitVendedor) delete p.vendedor;
    if (opts && opts.omitCliente) delete p.cliente;
    if (opts && opts.omitExecutiveDrilldown) {
      delete p.cliente;
      delete p.vendedor;
    }
    if (opts && opts.omitPeriodForCxcSnapshot) {
      delete p.desde;
      delete p.hasta;
      delete p.anio;
      delete p.mes;
      delete p.preset;
      delete p.vendedor;
      delete p.cliente;
      var cxcTotSnap = getCxcTotalKpiParam();
      if (cxcTotSnap) p.cxc_total = cxcTotSnap;
    }
    if (!opts || !opts.omitDb) {
      var db;
      if (opts && opts.omitPeriodForCxcSnapshot) {
        /* Misma identidad que ventas/CxC (?db= literal): getSelectedDbId() alias parker→default podía desalinear resumen-aging vs el resto del tablero. */
        db = getDbForCxcApi() || getSelectedDbId();
      } else {
        /* useCxcDbIdentity: sin ?db= ni sessionStorage, getDbForCxcApi() queda vacío y antes no se enviaba db;
         * director/resumen iba a default del servidor mientras resumen-aging sí mandaba chip (getSelectedDbId) → CxC incoherente. */
        db = opts && opts.useCxcDbIdentity ? (getDbForCxcApi() || getSelectedDbId()) : getSelectedDbId();
      }
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
  /** Evita "AGUA" + "Agua" cuando main y sub son el mismo texto en distinto casing/acento. */
  function dbChipSubRedundant(main, sub) {
    if (!sub || !main) return true;
    const a = normDbText(main).replace(/[^a-z0-9]+/g, '');
    const b = normDbText(sub).replace(/[^a-z0-9]+/g, '');
    return a.length > 0 && a === b;
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
      const subHtml = dbChipSubRedundant(main, sub)
        ? ''
        : '<span class="db-chip-sub">' + escChip(sub) + '</span>';
      const active = (!isAll && urlDb === id) ? ' active' : '';
      const title = escChip((e.database || '') + (e.host ? ' \u00b7 ' + e.host : ''));
      html += '<button type="button" class="biz-chip db-chip' + active + '" data-db="' + escChip(id) + '" title="' + title + '">' +
        '<span class="db-chip-main">' + escChip(main) + '</span>' + subHtml + '</button>';
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
    /* Sin initFilters() (p. ej. cxc.html), injectCSS nunca corría: .biz-chips quedaba sin flex/gap y los botones pegados. */
    injectCSS();
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
      const p = getParams();
      // P&L: persistir periodo (anio/mes o desde/hasta) + preset para que loadData() y recargas lean el mismo estado.
      if (/resultados\.html$/i.test(u.pathname)) {
        const sp = new URLSearchParams();
        try {
          const qdb = (new URLSearchParams(window.location.search).get('db') || '').trim();
          if (qdb) sp.set('db', qdb);
        } catch (_) {}
        if (p.desde && p.hasta) {
          sp.set('desde', p.desde);
          sp.set('hasta', p.hasta);
        } else {
          if (p.anio != null && p.anio !== '') sp.set('anio', String(p.anio));
          if (p.mes != null && p.mes !== '') sp.set('mes', String(p.mes));
        }
        if (p.preset) sp.set('preset', String(p.preset));
        const qs = sp.toString();
        history.replaceState({}, '', u.pathname + (qs ? '?' + qs : '') + (u.hash || ''));
        return;
      }
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
      const c = sp.get('cliente');
      if (c) _state.cliente = c;
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
      const anioUrl = parseInt(sp.get('anio'), 10);
      const mesUrl = parseInt(sp.get('mes'), 10);
      if (pr === 'custom_mes' && !isNaN(anioUrl) && !isNaN(mesUrl) && mesUrl >= 1 && mesUrl <= 12) {
        _state.preset = 'custom_mes';
        _state.desde = '';
        _state.hasta = '';
        _state.anio = anioUrl;
        _state.mes = mesUrl;
        return;
      }
      if (pr && ['hoy', 'semana', 'mes', 'mes_ant', 'ytd', 'anio', 'anio_ant'].indexOf(pr) >= 0) {
        applyPreset(pr, _state);
      }
      if (!isNaN(anioUrl)) _state.anio = anioUrl;
      if (!isNaN(mesUrl)) _state.mes = mesUrl;
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
      _clientes = (data.clientes || []).filter(c => c.NOMBRE);
    } catch (e) {
      _vendedores = [];
      _clientes = [];
    }
  }

  function injectCSS() {
    if (!document.getElementById('filter-bar-css')) {
    const style = document.createElement('style');
    style.id = 'filter-bar-css';
    style.textContent = `
      #filter-bar {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 16px;
        align-items: stretch;
      }
      #filter-bar > .filter-bar {
        margin-bottom: 0;
      }
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
      .filter-mes-anio-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
        padding: 8px 12px;
        border-radius: 12px;
        border: 1px solid rgba(140,174,212,.22);
        background: rgba(19,31,46,.55);
        align-self: flex-start;
        box-sizing: border-box;
      }
      .filter-ma-lbl {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
        color: #6A85A6;
        white-space: nowrap;
      }
      .filter-ma-select {
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid rgba(140,174,212,.24);
        background: rgba(15,26,40,.86);
        color: #d3deea;
        font-size: 12px;
        cursor: pointer;
        min-width: 7rem;
      }
      .filter-ma-select:focus {
        outline: none;
        border-color: rgba(230,168,0,.6);
        box-shadow: 0 0 0 3px rgba(230,168,0,.14);
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
        padding: 6px 14px;
        border-radius: 8px;
        border: 1px solid rgba(230,168,0,.45);
        background: linear-gradient(135deg, rgba(230,168,0,.88), rgba(255,138,51,.82));
        color: #0b1624;
        font-size: 11px;
        cursor: pointer;
        font-weight: 700;
        letter-spacing: .04em;
        transition: box-shadow .15s, transform .12s;
      }
      .fb-apply:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(230,168,0,.22); }
      .fb-apply:disabled { opacity: .45; cursor: not-allowed; transform: none; box-shadow: none; }
      .fb-apply.fb-apply--dirty { box-shadow: 0 0 0 2px rgba(230,168,0,.55); }
      .fb-apply-hint { font-size: 10px; color: #8896a8; max-width: 240px; line-height: 1.35; }
      .fb-label-active { font-size: 11px; color: var(--accent,#3b82f6); font-weight: 600; white-space: nowrap; }
      @media (max-width: 780px) {
        .filter-bar, .biz-context-bar { padding: 10px 10px; border-radius: 12px; }
        .filter-mes-anio-toolbar { padding: 8px 10px; }
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
      html.theme-premium-light[data-theme="light"] .fb-apply {
        border-color: rgba(217, 119, 6, 0.45) !important;
        background: linear-gradient(135deg, #fbbf24, #f59e0b) !important;
        color: #422006 !important;
      }
      html.theme-premium-light[data-theme="light"] .fb-apply-hint { color: #64748b !important; }
      html.theme-premium-light[data-theme="light"] #filter-bar > .filter-mes-anio-toolbar {
        background: #fff !important;
        border: 1px solid rgba(15, 23, 42, 0.1) !important;
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.04) !important;
      }
      html.theme-premium-light[data-theme="light"] .filter-ma-lbl { color: #64748b !important; }
      html.theme-premium-light[data-theme="light"] .filter-ma-select {
        background: #fff !important;
        color: #0f172a !important;
        border-color: rgba(15, 23, 42, 0.12) !important;
      }
    `;
    document.head.appendChild(s);
  }

  /** Sincroniza selects Mes/Año con el estado actual (preset, rango, etc.). */
  function syncMesAnioToolbarUI() {
    var selM = document.getElementById('filterSelMes');
    var selA = document.getElementById('filterSelAnio');
    if (!selM || !selA) return;
    var p = getParams();
    if (p.anio != null && p.anio !== '' && p.mes != null && p.mes !== '') {
      selA.value = String(+p.anio);
      selM.value = String(+p.mes);
      return;
    }
    if (p.anio != null && p.anio !== '' && (p.mes == null || p.mes === '')) {
      selA.value = String(+p.anio);
      selM.value = '1';
      return;
    }
    if (p.desde && p.hasta) {
      var end = String(p.hasta).split('-');
      if (end.length === 3) {
        selA.value = end[0];
        selM.value = String(parseInt(end[1], 10));
      }
    }
  }

  /** Toolbar compartida Ene–Dic + año; se monta debajo de los chips en #filter-bar. */
  function mountMesAnioToolbar(containerEl) {
    if (_cfg.showMesAnioToolbar === false) return;
    if (!containerEl) return;
    injectCSS();
    var old = document.getElementById('filterMesAnioToolbar');
    if (old) old.remove();
    var tb = document.createElement('div');
    tb.id = 'filterMesAnioToolbar';
    tb.className = 'filter-mes-anio-toolbar';
    tb.setAttribute('title', 'Mes calendario (enero–diciembre) y año — alinea datos con el periodo elegido');
    tb.innerHTML = '<span class="filter-ma-lbl">Mes</span><select id="filterSelMes" class="filter-ma-select" aria-label="Mes (Ene–Dic)"></select>' +
      '<span class="filter-ma-lbl">Año</span><select id="filterSelAnio" class="filter-ma-select" aria-label="Año"></select>';
    containerEl.appendChild(tb);
    var selM = document.getElementById('filterSelMes');
    var selA = document.getElementById('filterSelAnio');
    var y0 = new Date().getFullYear();
    selA.innerHTML = '';
    for (var y = y0 - 4; y <= y0 + 1; y++) {
      selA.appendChild(new Option(String(y), String(y)));
    }
    selM.innerHTML = '';
    for (var mo = 1; mo <= 12; mo++) {
      selM.appendChild(new Option(MESES_ES[mo - 1], String(mo)));
    }
    syncMesAnioToolbarUI();
    function applyMesAnio() {
      var y = parseInt(selA.value, 10);
      var m = parseInt(selM.value, 10);
      if (isNaN(y) || isNaN(m)) return;
      filterSetAnioMes(y, m);
    }
    selM.addEventListener('change', applyMesAnio);
    selA.addEventListener('change', applyMesAnio);
  }

  function renderBar() {
    injectCSS();
    const c = document.getElementById(_cfg.containerId || 'filter-bar');
    if (!c) return;

    const ui = (_cfg.deferApply && _pending) ? _pending : _state;
    const dirty = !!(_cfg.deferApply && _pending && !filterStatesEqual(_pending, _state));

    let vendOpts = '<option value="">Todos los vendedores</option>';
    _vendedores.forEach(v => {
      vendOpts += `<option value="${v.VENDEDOR_ID}" ${String(ui.vendedor) === String(v.VENDEDOR_ID) ? 'selected' : ''}>${v.NOMBRE}</option>`;
    });

    let cliOpts = '<option value="">Todos los clientes</option>';
    _clientes.forEach(cl => {
      cliOpts += `<option value="${cl.CLIENTE_ID}" ${String(ui.cliente) === String(cl.CLIENTE_ID) ? 'selected' : ''}>${cl.NOMBRE}</option>`;
    });

    const presets = [
      { key: 'hoy',      label: 'Hoy' },
      { key: 'semana',   label: 'Esta Semana' },
      { key: 'mes',      label: 'Este Mes' },
      { key: 'mes_ant',  label: 'Mes Anterior' },
      { key: 'ytd',      label: 'YTD (Ene\u2013Hoy)' },
      { key: 'anio',     label: 'Este A&#241;o' },
      { key: 'anio_ant', label: 'A&#241;o Anterior' },
    ];

    const presetBtns = presets.map(p =>
      `<button type="button" class="fb-preset ${ui.preset === p.key ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`
    ).join('');

    const vendSection = (_cfg.showVendedor !== false)
      ? `<div class="fb-selects"><select class="fb-select" id="fb-vendedor" title="Vendedor">${vendOpts}</select></div>`
      : '';
    const cliSection = (_cfg.showCliente === true)
      ? `<div class="fb-selects"><select class="fb-select" id="fb-cliente" title="Cliente">${cliOpts}</select></div>`
      : '';

    const applySection = _cfg.deferApply
      ? `<div class="fb-sep"></div><div class="fb-apply-wrap" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <button type="button" class="fb-apply${dirty ? ' fb-apply--dirty' : ''}" id="fb-apply-filters" ${dirty ? '' : 'disabled'} aria-label="Aplicar filtros de periodo">Aplicar filtros</button>
          ${dirty ? '<span class="fb-apply-hint">Hay cambios de periodo o vendedor sin aplicar. Pulsa para recargar datos.</span>' : '<span class="fb-apply-hint">Tras cambiar periodo o vendedor, pulsa Aplicar.</span>'}
        </div>`
      : '';

    c.innerHTML = `
      <div class="filter-bar">
        <div class="fb-presets">${presetBtns}</div>
        ${(_cfg.showVendedor !== false || _cfg.showCliente === true) ? `<div class="fb-sep"></div>${vendSection}${cliSection}` : ''}
        ${applySection}
      </div>`;

    c.querySelectorAll('.fb-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.preset;
        if (_cfg.deferApply && _pending) {
          applyPreset(key, _pending);
        } else {
          applyPreset(key, _state);
        }
        renderBar();
        if (!_cfg.deferApply) fire();
      });
    });

    const btnApply = c.querySelector('#fb-apply-filters');
    if (btnApply) {
      btnApply.addEventListener('click', () => {
        if (!_cfg.deferApply || !_pending) return;
        _state = copyFilterState(_pending);
        renderBar();
        fire();
      });
    }

    const selVend = c.querySelector('#fb-vendedor');
    if (selVend) selVend.addEventListener('change', () => {
      if (_cfg.deferApply && _pending) {
        _pending.vendedor = selVend.value;
      } else {
        _state.vendedor = selVend.value;
      }
      renderBar();
      if (!_cfg.deferApply) fire();
    });

    const selCli = c.querySelector('#fb-cliente');
    if (selCli) selCli.addEventListener('change', () => {
      if (_cfg.deferApply && _pending) {
        _pending.cliente = selCli.value;
      } else {
        _state.cliente = selCli.value;
      }
      renderBar();
      if (!_cfg.deferApply) fire();
    });

    mountMesAnioToolbar(c);
  }

  async function initFilters(config) {
    try {
      _cfg   = config || {};
      _state = { preset: 'mes', anio: null, mes: null, desde: '', hasta: '', vendedor: '', cliente: '' };

      applyPreset(_cfg.defaultPreset || 'mes', _state);
      hydrateFiltersFromUrl();
      _pending = _cfg.deferApply ? copyFilterState(_state) : null;

      const vendPromise = (_cfg.showVendedor !== false || _cfg.showCliente === true) ? loadVendedores() : null;

      renderBar();
      syncFiltersToUrl();

      if (_cfg.onReady) await Promise.resolve(_cfg.onReady(getParams(), buildQS));

      if (vendPromise) {
        await vendPromise;
        if (_cfg.deferApply) _pending = copyFilterState(_state);
        renderBar();
        syncFiltersToUrl();
      }
    } catch(e) {
      console.warn('[filters.js] initFilters error:', e);
      try { if (config && config.onReady) await Promise.resolve(config.onReady({}, () => '')); } catch(_) {}
    }
  }

  /** Suma buckets con nombres canónicos (Firebird/proxies / JSON a veces usan otra forma de clave). */
  function bucketSumCanonical(age) {
    var canon = { CORRIENTE: 0, DIAS_1_30: 0, DIAS_31_60: 0, DIAS_61_90: 0, DIAS_MAS_90: 0 };
    if (!age || typeof age !== 'object' || Array.isArray(age)) return canon;
    function foldBucketKey(k) {
      var ku = String(k).toUpperCase();
      if (Object.prototype.hasOwnProperty.call(canon, ku)) return ku;
      var c = ku.replace(/[^A-Z0-9]/g, '');
      if (c === 'CORRIENTE' || c.indexOf('CORRIENTE') === 0) return 'CORRIENTE';
      if (c === 'DIAS130' || c === 'DIAS1A30' || c === 'RANGO130') return 'DIAS_1_30';
      if (c === 'DIAS3160' || c === 'DIAS31A60') return 'DIAS_31_60';
      if (c === 'DIAS6190' || c === 'DIAS61A90') return 'DIAS_61_90';
      if (c === 'DIASMAS90' || c === 'MAS90' || c === 'DIAS90MAS' || c === 'DIAS90') return 'DIAS_MAS_90';
      return null;
    }
    Object.keys(age).forEach(function (k) {
      var v = +age[k] || 0;
      var fk = foldBucketKey(k);
      if (fk) canon[fk] += v;
    });
    return canon;
  }

  /** Misma forma que cxc.html: aging plano o envuelto en array (proxies / merges raros). */
  function normalizeCxcAging(ageRaw) {
    if (!ageRaw || typeof ageRaw !== 'object') return {};
    var base;
    if (Array.isArray(ageRaw)) {
      base = ageRaw[0] && typeof ageRaw[0] === 'object' && !Array.isArray(ageRaw[0]) ? ageRaw[0] : {};
    } else {
      base = ageRaw;
    }
    return bucketSumCanonical(base);
  }

  /** Igual que aging: ODBC/proxy a veces devuelve resumen como array de una fila; sin unwrap VENCIDO queda en 0 en Director/Inicio. */
  function unwrapCxcResumenRow(res) {
    if (res == null) return {};
    if (Array.isArray(res)) {
      return (res[0] && typeof res[0] === 'object' && !Array.isArray(res[0])) ? res[0] : {};
    }
    if (typeof res === 'object') return res;
    return {};
  }

  /** director/resumen con omitCxc=1 antes mandaba cxc en ceros; no es cartera real y no debe mezclarse con resumen-aging. */
  function getDirectorCxcPayload(directorRaw) {
    var raw = directorRaw && directorRaw.cxc;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var s = +raw.SALDO_TOTAL || 0;
    var v = +raw.VENCIDO || 0;
    var n = +raw.NUM_CLIENTES || 0;
    if (s <= 0.005 && v <= 0.005 && n <= 0.005) return null;
    return raw;
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
      var rSrc = o.resumen != null && typeof o.resumen === 'object' ? o.resumen : o;
      var r = unwrapCxcResumenRow(rSrc);
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
    var b = norm(getDirectorCxcPayload(directorRaw) || {});
    if (a.SALDO_TOTAL <= 0 && a.VENCIDO <= 0 && (b.SALDO_TOTAL > 0 || b.VENCIDO > 0)) return b;
    var out = {
      SALDO_TOTAL: a.SALDO_TOTAL,
      VENCIDO: a.VENCIDO,
      POR_VENCER: a.POR_VENCER,
      NUM_CLIENTES: a.NUM_CLIENTES,
      NUM_CLIENTES_VENCIDOS: a.NUM_CLIENTES_VENCIDOS
    };
    function saldoAligned(am, bm, maxRel) {
      if (am <= 0 || bm <= 0) return false;
      var mx = Math.max(am, bm);
      return Math.abs(am - bm) / mx <= maxRel;
    }
    // 0.50 alineado con tolerancia doc vs legacy en servidor (0.35 a veces dejaba vencido en 0 con saldos razonablemente cercanos).
    if (a.SALDO_TOTAL > 0 && a.VENCIDO <= 0.005 && b.VENCIDO > 0.005 && saldoAligned(a.SALDO_TOTAL, b.SALDO_TOTAL, 0.50)) {
      out.VENCIDO = b.VENCIDO;
      out.POR_VENCER = b.POR_VENCER > 0.005 ? b.POR_VENCER : Math.max(0, a.SALDO_TOTAL - b.VENCIDO);
      if (b.NUM_CLIENTES_VENCIDOS != null && b.NUM_CLIENTES_VENCIDOS !== '') out.NUM_CLIENTES_VENCIDOS = b.NUM_CLIENTES_VENCIDOS;
    }
    if (a.SALDO_TOTAL > 0 && b.SALDO_TOTAL > 0) {
      var mx = Math.max(a.SALDO_TOTAL, b.SALDO_TOTAL);
      var relDiff = Math.abs(a.SALDO_TOTAL - b.SALDO_TOTAL) / mx;
      if (relDiff <= 0.50) {
        if (b.VENCIDO > out.VENCIDO) out.VENCIDO = b.VENCIDO;
        if (b.POR_VENCER > out.POR_VENCER) out.POR_VENCER = b.POR_VENCER;
        if ((out.NUM_CLIENTES_VENCIDOS == null || out.NUM_CLIENTES_VENCIDOS === '') && b.NUM_CLIENTES_VENCIDOS != null) {
          out.NUM_CLIENTES_VENCIDOS = b.NUM_CLIENTES_VENCIDOS;
        }
      }
    }
    return out;
  }

  /**
   * Copia resumen sin rellenar VENCIDO desde buckets: la mora por buckets puede no ser el mismo universo que SALDO_TOTAL (documento vs líneas).
   */
  function reconcileCxcResumenWithAging(resumen, aging) {
    resumen = unwrapCxcResumenRow(resumen);
    if (!resumen || typeof resumen !== 'object') resumen = {};
    var out = {};
    for (var k in resumen) {
      if (Object.prototype.hasOwnProperty.call(resumen, k)) out[k] = resumen[k];
    }
    return out;
  }

  /**
   * Escala VENCIDO/POR_VENCER al saldo KPI si la suma difiere (>8%); no sustituye por suma de buckets de aging.
   */
  function finalizeCxcKpiDisplay(resumen, aging) {
    resumen = unwrapCxcResumenRow(resumen);
    if (!resumen || typeof resumen !== 'object') resumen = {};
    aging = normalizeCxcAging(aging);
    var out = {};
    for (var k in resumen) {
      if (Object.prototype.hasOwnProperty.call(resumen, k)) out[k] = resumen[k];
    }
    var saldo = +out.SALDO_TOTAL || 0;
    var venc = +out.VENCIDO || 0;
    var pvenc = +out.POR_VENCER || 0;
    if (saldo > 0.005) {
      var sumVp = venc + pvenc;
      if (sumVp > 0.005 && Math.abs(sumVp - saldo) / saldo > 0.08) {
        var r = saldo / sumVp;
        venc *= r;
        pvenc *= r;
      }
    }
    out.VENCIDO = venc;
    out.POR_VENCER = pvenc;
    return out;
  }

  /**
   * Si tras reconcile/merge/finalize el vencido sigue en 0 pero /api/director/resumen ya trajo cxc del mismo motor
   * (cxcResumenAgingUnificado) con mora > 0, tomar VENCIDO del director. Cubre: aging vacío en JSON, timeouts parciales,
   * o claves de buckets no normalizadas en el snapshot dedicado.
   */
  function backfillVencidoFromDirectorKpi(merged, directorRaw, aging) {
    if (!merged || typeof merged !== 'object') return merged;
    var mv = +merged.VENCIDO || 0;
    if (mv > 0.005) return merged;
    var dc = getDirectorCxcPayload(directorRaw);
    if (!dc || typeof dc !== 'object') return merged;
    var dv = +dc.VENCIDO || 0;
    if (dv <= 0.005) return merged;
    var ms = +merged.SALDO_TOTAL || 0;
    var ds = +dc.SALDO_TOTAL || 0;
    var mora = 0;
    if (aging && typeof aging === 'object') {
      mora =
        (+aging.DIAS_1_30 || 0) + (+aging.DIAS_31_60 || 0) +
        (+aging.DIAS_61_90 || 0) + (+aging.DIAS_MAS_90 || 0);
    }
    if (mora > 0.005 && Math.abs(mora - dv) / Math.max(mora, dv, 1) > 0.50) return merged;
    var useSaldo = ms > 0.005 ? ms : ds;
    var other = ms > 0.005 ? ds : ms;
    if (useSaldo <= 0.005) return merged;
    if (other > 0.005) {
      var mx = Math.max(useSaldo, other);
      if (Math.abs(useSaldo - other) / mx > 0.22) return merged;
    }
    merged.VENCIDO = dv;
    var saldo = ms > 0.005 ? ms : ds;
    var pv = +merged.POR_VENCER || 0;
    if (pv <= 0.005 && saldo > 0.005) merged.POR_VENCER = Math.max(0, saldo - dv);
    if ((merged.NUM_CLIENTES_VENCIDOS == null || merged.NUM_CLIENTES_VENCIDOS === '') &&
        dc.NUM_CLIENTES_VENCIDOS != null && dc.NUM_CLIENTES_VENCIDOS !== '') {
      merged.NUM_CLIENTES_VENCIDOS = dc.NUM_CLIENTES_VENCIDOS;
    }
    return merged;
  }

  /**
   * Un solo lugar para Inicio/Director: mismo orden que cxc.html (reconcile + merge + finalize).
   * Siempre pasa aging normalizado ({} si falta) para no saltar la lógica de mora.
   */
  function applyCxcSnapshotForKpis(cxcSnap, directorRaw) {
    var snap = cxcSnap && typeof cxcSnap === 'object' ? cxcSnap : {};
    var resSrc = snap.resumen != null && typeof snap.resumen === 'object' ? snap.resumen : snap;
    var res = unwrapCxcResumenRow(resSrc);
    if (res && typeof res === 'object') {
      function cxcPickNum(r, keys) {
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
          if (r[k] === '' || r[k] == null) continue;
          var t = parseFloat(String(r[k]).replace(/,/g, ''));
          if (!isNaN(t)) return t;
        }
        return NaN;
      }
      var res2 = Object.assign({}, res);
      var st = cxcPickNum(res2, ['SALDO_TOTAL', 'saldo_total']);
      var ve = cxcPickNum(res2, ['VENCIDO', 'vencido']);
      var pv = cxcPickNum(res2, ['POR_VENCER', 'por_vencer']);
      var nc = cxcPickNum(res2, ['NUM_CLIENTES', 'num_clientes']);
      if (!isNaN(st)) res2.SALDO_TOTAL = st;
      if (!isNaN(ve)) res2.VENCIDO = ve;
      if (!isNaN(pv)) res2.POR_VENCER = pv;
      if (!isNaN(nc)) res2.NUM_CLIENTES = nc;
      res = res2;
    }
    var dc = getDirectorCxcPayload(directorRaw);
    var v0 = +res.VENCIDO || 0;
    // Director usa el mismo motor que resumen-aging; alinear saldo/clientes y, si el snapshot aún no trae mora, copiar VENCIDO del director.
    if (dc && +dc.SALDO_TOTAL > 0.005) {
      res = Object.assign({}, res, {
        SALDO_TOTAL: +dc.SALDO_TOTAL || 0,
        NUM_CLIENTES: +dc.NUM_CLIENTES || +res.NUM_CLIENTES || 0,
        NUM_CLIENTES_VENCIDOS: dc.NUM_CLIENTES_VENCIDOS != null && dc.NUM_CLIENTES_VENCIDOS !== ''
          ? dc.NUM_CLIENTES_VENCIDOS
          : res.NUM_CLIENTES_VENCIDOS
      });
      if (v0 <= 0.005 && (+dc.VENCIDO || 0) > 0.005) {
        res.VENCIDO = +dc.VENCIDO;
        res.POR_VENCER = +dc.POR_VENCER || 0;
      }
    }
    var aging = normalizeCxcAging(snap.aging);
    var raw = res;
    if (typeof reconcileCxcResumenWithAging === 'function') {
      raw = reconcileCxcResumenWithAging(raw, aging);
    }
    var merged = typeof mergeCxcKpiWithDirector === 'function' ? mergeCxcKpiWithDirector(raw, directorRaw) : raw;
    if (typeof finalizeCxcKpiDisplay === 'function') {
      merged = finalizeCxcKpiDisplay(merged, aging);
    }
    merged = backfillVencidoFromDirectorKpi(merged, directorRaw, aging);
    return merged;
  }

  /**
   * Inicio/Director: sin barra de negocio (p. ej. director.html) sessionStorage y ?db= pueden faltar ? todas las APIs deben usar getSelectedDbId().
   */
  function syncDbContextFromUrlOrFallback() {
    try {
      var u = (new URLSearchParams(window.location.search).get('db') || '').trim();
      if (u) {
        sessionStorage.setItem('microsip_erp_db', u);
        return;
      }
      var s = (sessionStorage.getItem('microsip_erp_db') || '').trim();
      if (s) return;
      var d = getSelectedDbId();
      if (d) {
        sessionStorage.setItem('microsip_erp_db', d);
        var loc = new URL(window.location.href);
        loc.searchParams.set('db', d);
        history.replaceState({}, '', loc);
      }
    } catch (e) {}
  }

  /**
   * Paso final KPI CxC en tarjetas: máximo entre director.cxc, snapshot y suma de buckets aging; saldo preferente desde director si existe.
   */
  function mergeCxcDisplayForDashboard(cx, directorRaw, cxcSnap) {
    var px = cx && typeof cx === 'object' ? cx : {};
    var dc = getDirectorCxcPayload(directorRaw);
    if (dc && (+dc.SALDO_TOTAL || 0) > 0.005) {
      var s0 = +px.SALDO_TOTAL || 0;
      var v0 = +px.VENCIDO || 0;
      if (s0 <= 0.005) {
        px = Object.assign({}, px, {
          SALDO_TOTAL: +dc.SALDO_TOTAL,
          VENCIDO: +dc.VENCIDO || 0,
          POR_VENCER: +dc.POR_VENCER || 0,
          NUM_CLIENTES: +dc.NUM_CLIENTES || +px.NUM_CLIENTES || 0,
          NUM_CLIENTES_VENCIDOS: dc.NUM_CLIENTES_VENCIDOS != null && dc.NUM_CLIENTES_VENCIDOS !== ''
            ? dc.NUM_CLIENTES_VENCIDOS
            : px.NUM_CLIENTES_VENCIDOS
        });
      } else if (v0 <= 0.005 && (+dc.VENCIDO || 0) > 0.005) {
        var mx0 = Math.max(s0, +dc.SALDO_TOTAL || 0);
        if (mx0 > 0 && Math.abs(s0 - (+dc.SALDO_TOTAL || 0)) / mx0 <= 0.50) {
          px = Object.assign({}, px, {
            VENCIDO: +dc.VENCIDO,
            POR_VENCER: (+dc.POR_VENCER || 0) > 0.005 ? +dc.POR_VENCER : Math.max(0, s0 - (+dc.VENCIDO || 0))
          });
        }
      }
    }
    var ag = normalizeCxcAging(cxcSnap && cxcSnap.aging);
    var mora =
      (+ag.DIAS_1_30 || 0) + (+ag.DIAS_31_60 || 0) +
      (+ag.DIAS_61_90 || 0) + (+ag.DIAS_MAS_90 || 0);
    var vDir = dc ? (+dc.VENCIDO || 0) : 0;
    var vPx = +px.VENCIDO || 0;
    // Resumen crudo del snapshot (antes de pipelines): si algún paso dejó VENCIDO en 0 pero el JSON del servidor sí traía mora, no perderlo.
    var vSnap = 0;
    try {
      var rr = unwrapCxcResumenRow(cxcSnap && cxcSnap.resumen);
      if (rr && typeof rr === 'object') vSnap = +rr.VENCIDO || 0;
    } catch (e) {}
    var saldo = 0;
    if (dc && (+dc.SALDO_TOTAL || 0) > 0.005) {
      saldo = +dc.SALDO_TOTAL;
    } else {
      saldo = +px.SALDO_TOTAL || 0;
    }
    var moraCap = 0;
    if (mora > 0.005) {
      moraCap = saldo > 0.005 ? Math.min(mora, saldo) : mora;
    }
    var venc = Math.max(vDir, vPx, moraCap, vSnap);
    var corrienteAging = +ag.CORRIENTE || 0;
    if (saldo <= 0.005 && venc > 0.005 && (mora + corrienteAging) > 0.005) {
      saldo = mora + corrienteAging;
    }
    if (saldo <= 0.005 && venc <= 0.005) return px;
    return Object.assign({}, px, {
      SALDO_TOTAL: saldo,
      VENCIDO: venc,
      POR_VENCER: Math.max(0, saldo - venc),
      NUM_CLIENTES: (dc && (+dc.NUM_CLIENTES || 0) > 0) ? +dc.NUM_CLIENTES : (+px.NUM_CLIENTES || 0),
      NUM_CLIENTES_VENCIDOS: dc && dc.NUM_CLIENTES_VENCIDOS != null && dc.NUM_CLIENTES_VENCIDOS !== ''
        ? dc.NUM_CLIENTES_VENCIDOS
        : px.NUM_CLIENTES_VENCIDOS
    });
  }

  function filterCommitDeferred() {
    if (!_cfg.deferApply || !_pending) return false;
    if (filterStatesEqual(_pending, _state)) return false;
    _state = copyFilterState(_pending);
    renderBar();
    fire();
    return true;
  }
  function filterDeferDirty() {
    return !!(_cfg.deferApply && _pending && !filterStatesEqual(_pending, _state));
  }

  /** P&L resultados: fija mes–año calendario (Ene–Dic) y dispara recarga. */
  function filterSetAnioMes(anio, mes) {
    const y = parseInt(anio, 10);
    const mo = parseInt(mes, 10);
    if (isNaN(y) || isNaN(mo) || mo < 1 || mo > 12) return;
    _state.preset = 'custom_mes';
    _state.desde = '';
    _state.hasta = '';
    _state.anio = y;
    _state.mes = mo;
    if (_cfg.deferApply && _pending) {
      _pending.preset = 'custom_mes';
      _pending.desde = '';
      _pending.hasta = '';
      _pending.anio = y;
      _pending.mes = mo;
    }
    renderBar();
    syncFiltersToUrl();
    fire();
  }

  window.initFilters              = initFilters;
  window.filterBuildQS            = buildQS;
  window.filterGetParams          = getParams;
  window.filterSetAnioMes         = filterSetAnioMes;
  window.syncFilterMesAnioToolbar = syncMesAnioToolbarUI;
  window.filterCommitDeferred     = filterCommitDeferred;
  window.filterDeferDirty         = filterDeferDirty;
  window.getSelectedDbId          = getSelectedDbId;
  window.renderDbChipsInto        = renderDbChipsInto;
  window.apiPathWithDb            = apiPathWithDb;
  window.initGlobalDbBarAfterNav  = initGlobalDbBarAfterNav;
  window.filterSyncFiltersToUrl   = syncFiltersToUrl;
  window.mergeCxcKpiWithDirector  = mergeCxcKpiWithDirector;
  window.reconcileCxcResumenWithAging = reconcileCxcResumenWithAging;
  window.finalizeCxcKpiDisplay      = finalizeCxcKpiDisplay;
  window.normalizeCxcAging        = normalizeCxcAging;
  window.applyCxcSnapshotForKpis  = applyCxcSnapshotForKpis;
  window.mergeCxcDisplayForDashboard = mergeCxcDisplayForDashboard;
  window.syncDbContextFromUrlOrFallback = syncDbContextFromUrlOrFallback;
  window.getDbForCxcApi           = getDbForCxcApi;
  /** Query string para GET /api/cxc/resumen-aging en tableros: db + preset (sin anio/mes: snapshot cartera = pestaña CxC). */
  function filterCxcKpiQueryString() {
    return buildQS(null, { useCxcDbIdentity: true, omitPeriodForCxcSnapshot: true });
  }
  window.filterCxcKpiQueryString  = filterCxcKpiQueryString;

})();
