/**
 * filters.js — Barra de filtros compartida · Suminregio Parker ERP
 * -----------------------------------------------------------------
 * Uso básico:
 *   1) Añadir <div id="filter-bar"></div> en el HTML
 *   2) <script src="filters.js"></script>
 *   3) Llamar initFilters({ containerId, showVendedor, onChange })
 *
 * API pública:
 *   initFilters(config)   — inicializa y renderiza la barra
 *   filterBuildQS(extras) — devuelve query-string con los filtros activos
 *   filterGetParams()     — devuelve objeto { anio, mes, desde, hasta, vendedor }
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

  function buildQS(extras) {
    const p = Object.assign({}, getParams(), extras || {});
    return Object.keys(p)
      .filter(k => p[k] !== '' && p[k] != null)
      .map(k => k + '=' + encodeURIComponent(p[k]))
      .join('&');
  }

  function fire() {
    if (_cfg.onChange) _cfg.onChange(getParams(), buildQS);
  }

  async function loadVendedores() {
    try {
      const data = await fetch(API + '/api/config/filtros').then(r => r.json());
      _vendedores = (data.vendedores || []).filter(v => v.NOMBRE);
    } catch (e) {
      _vendedores = [];
    }
  }

  function injectCSS() {
    if (document.getElementById('filter-bar-css')) return;
    const style = document.createElement('style');
    style.id = 'filter-bar-css';
    style.textContent = `
      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: #1e2533;
        border-radius: 10px;
        margin-bottom: 18px;
        border: 1px solid rgba(255,255,255,0.07);
      }
      .fb-presets { display: flex; flex-wrap: wrap; gap: 5px; }
      .fb-preset {
        padding: 5px 12px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.18);
        background: transparent;
        color: #c0c8d4;
        font-size: 12px;
        cursor: pointer;
        transition: all .15s;
        white-space: nowrap;
      }
      .fb-preset:hover  { background: rgba(255,255,255,0.08); color:#fff; }
      .fb-preset.active { background: var(--accent,#3b82f6); border-color: var(--accent,#3b82f6); color:#fff; font-weight:600; }
      .fb-sep { width: 1px; height: 28px; background: rgba(255,255,255,0.12); align-self: center; }
      .fb-selects { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .fb-select {
        padding: 5px 10px;
        border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.18);
        background: #151c27;
        color: #c0c8d4;
        font-size: 12px;
        cursor: pointer;
        max-width: 200px;
      }
      .fb-select:focus { outline: none; border-color: var(--accent,#3b82f6); }
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
    `;
    document.head.appendChild(style);
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

  window.initFilters     = initFilters;
  window.filterBuildQS   = buildQS;
  window.filterGetParams = getParams;

})();
