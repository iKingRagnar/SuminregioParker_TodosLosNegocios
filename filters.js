/**
 * filters.js — Barra de filtros compartida · Suminregio Parker ERP
 * ─────────────────────────────────────────────────────────────────
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
(function () {
  'use strict';

  const MESES_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const MESES_FULL = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                      'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const API = '';

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
    const p = {};
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

    let activeLabel = '';
    if (_state.desde && _state.hasta) {
      activeLabel = _state.desde === _state.hasta
        ? 'Hoy · ' + _state.desde
        : _state.desde + ' → ' + _state.hasta;
    } else {
      if (_state.anio && _state.mes) {
        activeLabel = MESES_FULL[_state.mes - 1] + ' ' + _state.anio;
      } else if (_state.anio) {
        activeLabel = 'Año ' + _state.anio;
      }
    }

    let yearOpts = '<option value="">-- Año --</option>';
    for (let i = y - 3; i <= y; i++) {
      yearOpts += `<option value="${i}" ${_state.anio === i ? 'selected' : ''}>${i}</option>`;
    }

    let monthOpts = '<option value="">-- Mes --</option>';
    MESES_FULL.forEach((nm, i) => {
      const mv = i + 1;
      monthOpts += `<option value="${mv}" ${_state.mes === mv ? 'selected' : ''}>${nm}</option>`;
    });

    let vendOpts = '<option value="">Todos los vendedores</option>';
    _vendedores.forEach(v => {
      vendOpts += `<option value="${v.VENDEDOR_ID}" ${String(_state.vendedor) === String(v.VENDEDOR_ID) ? 'selected' : ''}>${v.NOMBRE}</option>`;
    });

    const presets = [
      { key: 'hoy',      label: 'Hoy' },
      { key: 'semana',   label: 'Esta Semana' },
      { key: 'mes',      label: 'Este Mes' },
      { key: 'mes_ant',  label: 'Mes Anterior' },
      { key: 'anio',     label: 'Este Año' },
      { key: 'anio_ant', label: 'Año Anterior' },
    ];

    const presetBtns = presets.map(p =>
      `<button class="fb-preset ${_state.preset === p.key ? 'active' : ''}" data-preset="${p.key}">${p.label}</button>`
    ).join('');

    const vendSection = (_cfg.showVendedor !== false)
      ? `<select class="fb-select" id="fb-vendedor" title="Vendedor">${vendOpts}</select>`
      : '';

    c.innerHTML = `
      <div class="filter-bar">
        <div class="fb-presets">${presetBtns}</div>
        <div class="fb-sep"></div>
        <div class="fb-selects">
          <select class="fb-select" id="fb-anio">${yearOpts}</select>
          <select class="fb-select" id="fb-mes">${monthOpts}</select>
          ${vendSection}
        </div>
        <div class="fb-sep"></div>
        <div class="fb-range">
          <label>Desde <input type="date" id="fb-desde" value="${_state.desde}" class="fb-date"></label>
          <label>Hasta <input type="date" id="fb-hasta" value="${_state.hasta}" class="fb-date"></label>
          <button class="fb-apply" id="fb-apply-range">Aplicar</button>
        </div>
        ${activeLabel ? `<span class="fb-label-active">▶ ${activeLabel}</span>` : ''}
      </div>`;

    c.querySelectorAll('.fb-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        applyPreset(btn.dataset.preset);
        renderBar();
        fire();
      });
    });

    const selAnio = c.querySelector('#fb-anio');
    const selMes  = c.querySelector('#fb-mes');
    if (selAnio) selAnio.addEventListener('change', () => {
      _state.preset = 'custom';
      _state.anio   = selAnio.value ? +selAnio.value : null;
      _state.desde  = '';
      _state.hasta  = '';
      renderBar();
      fire();
    });
    if (selMes) selMes.addEventListener('change', () => {
      _state.preset = 'custom';
      _state.mes    = selMes.value ? +selMes.value : null;
      _state.desde  = '';
      _state.hasta  = '';
      renderBar();
      fire();
    });

    const selVend = c.querySelector('#fb-vendedor');
    if (selVend) selVend.addEventListener('change', () => {
      _state.vendedor = selVend.value;
      renderBar();
      fire();
    });

    const btnRange = c.querySelector('#fb-apply-range');
    if (btnRange) btnRange.addEventListener('click', () => {
      const desde = c.querySelector('#fb-desde').value;
      const hasta = c.querySelector('#fb-hasta').value;
      if (desde && hasta) {
        _state.preset  = 'custom';
        _state.desde   = desde;
        _state.hasta   = hasta;
        _state.anio    = null;
        _state.mes     = null;
        renderBar();
        fire();
      }
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
