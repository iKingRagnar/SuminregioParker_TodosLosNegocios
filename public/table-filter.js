/* ─────────────────────────────────────────────────────────────────────────────
 * table-filter.js — Filtro universal por columna para TODAS las tablas
 *
 * • Inyecta una fila de filtros bajo el encabezado de cada tabla de datos.
 * • Al escribir, filtra en vivo las filas (coincidencia por subcadena y por
 *   tokens en cualquier orden), IGNORANDO mayúsculas/minúsculas y acentos.
 * • Muestra un desplegable de sugerencias (autocompletado/predicción) con los
 *   valores reales de esa columna; al elegir uno, el filtro queda exacto.
 * • Se re-aplica solo cuando la tabla carga datos por AJAX (MutationObserver).
 *
 * No requiere cambios en las páginas: se carga global desde nav.js.
 * Para excluir una tabla: <table class="tf-skip"> o data-no-filter.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__SUMI_TABLE_FILTER__) return;
  window.__SUMI_TABLE_FILTER__ = true;

  /** Normaliza: minúsculas, sin acentos/diacríticos, espacios colapsados. */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function tokens(q) { return norm(q).split(' ').filter(Boolean); }
  function matchTokens(text, toks) {
    if (!toks.length) return true;
    var n = norm(text);
    for (var i = 0; i < toks.length; i++) if (n.indexOf(toks[i]) < 0) return false;
    return true;
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function debounce(fn, ms) {
    var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); };
  }

  // ── Estilos ────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tf-style')) return;
    var s = document.createElement('style');
    s.id = 'tf-style';
    s.textContent = [
      '.tf-row > th{padding:5px 8px!important;background:rgba(230,168,0,.05)!important;',
      'border-bottom:1px solid rgba(230,168,0,.18)!important;position:relative;}',
      '.tf-inp{width:100%;box-sizing:border-box;font:inherit;font-size:.72rem;',
      'padding:5px 22px 5px 8px;border:1px solid rgba(120,140,170,.32);border-radius:7px;',
      'background:#fff;color:#0f172a;outline:none;transition:border-color .15s,box-shadow .15s;',
      '-webkit-appearance:none;appearance:none;min-height:30px;}',
      '.tf-inp::placeholder{color:#9aa7b8;font-weight:400;}',
      '.tf-inp:focus{border-color:#E6A800;box-shadow:0 0 0 3px rgba(230,168,0,.16);}',
      '.tf-inp.tf-has{border-color:#E6A800;background:#fffdf5;font-weight:600;}',
      '.tf-clear{position:absolute;right:11px;top:50%;transform:translateY(-50%);',
      'width:16px;height:16px;border:0;border-radius:50%;background:rgba(120,140,170,.22);',
      'color:#475569;font-size:11px;line-height:16px;text-align:center;cursor:pointer;',
      'padding:0;display:none;z-index:2;}',
      '.tf-cell.tf-active .tf-clear{display:block;}',
      '.tf-clear:hover{background:#E6A800;color:#fff;}',
      /* contador de resultados */
      '.tf-count{font:600 .64rem/1 "DM Mono",ui-monospace,monospace;color:#92400e;',
      'background:rgba(230,168,0,.12);border:1px solid rgba(230,168,0,.3);',
      'border-radius:99px;padding:3px 9px;display:inline-flex;align-items:center;gap:5px;',
      'margin:0 0 8px;letter-spacing:.02em;}',
      '.tf-count.tf-hide{display:none;}',
      '.tf-count button{border:0;background:none;color:#b45309;cursor:pointer;font:inherit;',
      'text-decoration:underline;padding:0;}',
      /* desplegable de sugerencias */
      '.tf-dd{position:fixed;z-index:4000;background:#fff;border:1px solid rgba(15,23,42,.14);',
      'border-radius:10px;box-shadow:0 14px 40px rgba(15,23,42,.22);overflow-y:auto;',
      'max-height:300px;padding:5px;display:none;font-size:.78rem;}',
      '.tf-opt{padding:8px 11px;border-radius:7px;cursor:pointer;color:#1e293b;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.tf-opt small{color:#94a3b8;font-weight:600;margin-left:8px;}',
      '.tf-opt:hover,.tf-opt.tf-on{background:rgba(230,168,0,.14);color:#92400e;}',
      '.tf-opt mark{background:rgba(230,168,0,.32);color:inherit;border-radius:3px;padding:0 1px;}',
      '.tf-dd-empty{padding:10px 12px;color:#94a3b8;}',
      /* táctil: 44px de alto y 16px de fuente (evita el zoom de iOS al enfocar) */
      '@media(pointer:coarse){.tf-inp{min-height:44px;font-size:16px;}',
      '.tf-clear{width:28px;height:28px;line-height:28px;font-size:14px;right:8px;}}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Desplegable de sugerencias (singleton) ──────────────────────────────────
  var dd = null, ddCtx = null; // ddCtx = { input, table, col, items, active }
  function ensureDD() {
    if (dd) return dd;
    dd = document.createElement('div');
    dd.className = 'tf-dd';
    document.body.appendChild(dd);
    dd.addEventListener('mousedown', function (e) {
      var opt = e.target.closest ? e.target.closest('.tf-opt') : null;
      if (!opt || !ddCtx) return;
      e.preventDefault(); // no perder el foco antes de aplicar
      var i = +opt.getAttribute('data-i');
      chooseOption(i);
    });
    return dd;
  }
  function closeDD() { if (dd) dd.style.display = 'none'; ddCtx = null; }
  function positionDD(input) {
    var r = input.getBoundingClientRect();
    dd.style.left = Math.round(r.left) + 'px';
    dd.style.top = Math.round(r.bottom + 4) + 'px';
    dd.style.minWidth = Math.round(r.width) + 'px';
    dd.style.maxWidth = Math.max(Math.round(r.width), 320) + 'px';
  }
  function highlight(disp, toks) {
    var out = escHtml(disp);
    if (!toks.length) return out;
    // resalta el primer token encontrado (sobre versión normalizada→índices aproximados)
    try {
      var nDisp = norm(disp);
      var t = toks[0];
      var idx = nDisp.indexOf(t);
      if (idx >= 0) {
        // mapear índice normalizado a original es aproximado; resaltamos por regex insensible
        var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i');
        out = escHtml(disp).replace(re, '<mark>$1</mark>');
      }
    } catch (_) {}
    return out;
  }
  function openDD(input, table, col) {
    var vals = distinctValues(table, col);
    if (!vals.length) { closeDD(); return; }
    var toks = tokens(input.value);
    var matches = [];
    for (var i = 0; i < vals.length && matches.length < 80; i++) {
      if (matchTokens(vals[i].disp, toks)) matches.push(vals[i]);
    }
    var d = ensureDD();
    if (!matches.length) {
      d.innerHTML = '<div class="tf-dd-empty">Sin coincidencias</div>';
    } else {
      d.innerHTML = matches.map(function (v, i) {
        var cnt = v.count > 1 ? '<small>' + v.count + '</small>' : '';
        return '<div class="tf-opt" data-i="' + i + '">' + highlight(v.disp, toks) + cnt + '</div>';
      }).join('');
    }
    ddCtx = { input: input, table: table, col: col, items: matches, active: -1 };
    positionDD(input);
    d.style.display = 'block';
  }
  function moveActive(delta) {
    if (!ddCtx || !ddCtx.items.length) return;
    var n = ddCtx.items.length;
    ddCtx.active = (ddCtx.active + delta + n) % n;
    var opts = dd.querySelectorAll('.tf-opt');
    opts.forEach(function (o, i) { o.classList.toggle('tf-on', i === ddCtx.active); });
    var on = opts[ddCtx.active];
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  function chooseOption(i) {
    if (!ddCtx) return;
    var item = ddCtx.items[i != null ? i : ddCtx.active];
    if (!item) return;
    var input = ddCtx.input, table = ddCtx.table;
    input.value = item.disp;
    closeDD();
    onInputChanged(input, table);
    input.focus();
  }

  // ── Valores distintos por columna (con cache invalidable) ───────────────────
  function distinctValues(table, col) {
    var tf = table.__tf;
    if (tf.cache[col]) return tf.cache[col];
    var seen = Object.create(null), out = [];
    var rows = dataRows(tf.tbody);
    for (var i = 0; i < rows.length; i++) {
      var disp = cellText(rows[i], col).replace(/\s+/g, ' ').trim();
      if (!disp) continue;
      var key = norm(disp);
      if (seen[key] == null) { seen[key] = out.length; out.push({ disp: disp, count: 1 }); }
      else { out[seen[key]].count++; }
    }
    out.sort(function (a, b) { return a.disp.localeCompare(b.disp, 'es', { numeric: true, sensitivity: 'base' }); });
    tf.cache[col] = out;
    return out;
  }

  // ── Filas/celdas de datos ───────────────────────────────────────────────────
  function dataRows(tbody) {
    return Array.prototype.filter.call(tbody.rows, function (r) {
      if (r.classList && r.classList.contains('tf-norow')) return false;
      return r.cells.length > 1; // descarta filas "Cargando…"/vacías con colspan
    });
  }
  function cellText(row, idx) {
    var c = row.cells[idx];
    return c ? (c.textContent || '') : '';
  }

  // ── Aplicar filtros ─────────────────────────────────────────────────────────
  function applyFilter(table) {
    var tf = table.__tf;
    var active = tf.inputs.map(function (inp) { return tokens(inp.value); });
    var anyActive = active.some(function (t) { return t.length; });
    var shown = 0, total = 0;
    var rows = tf.tbody.rows;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.cells.length <= 1) continue; // dejar visibles separadores/estado
      total++;
      var ok = true;
      for (var c = 0; c < active.length && ok; c++) {
        if (active[c].length && !matchTokens(cellText(row, c), active[c])) ok = false;
      }
      row.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    // marca visual de inputs con contenido
    tf.inputs.forEach(function (inp, c) {
      var has = !!inp.value.trim();
      inp.classList.toggle('tf-has', has);
      var cell = inp.closest('.tf-cell');
      if (cell) cell.classList.toggle('tf-active', has);
    });
    // contador
    if (tf.count) {
      if (anyActive) {
        tf.count.classList.remove('tf-hide');
        tf.count.querySelector('.tf-count-txt').textContent = shown + ' de ' + total;
      } else {
        tf.count.classList.add('tf-hide');
      }
    }
  }

  function onInputChanged(input, table) {
    applyFilter(table);
    openDD(input, table, +input.getAttribute('data-col'));
  }

  function clearAll(table) {
    var tf = table.__tf;
    tf.inputs.forEach(function (i) { i.value = ''; });
    closeDD();
    applyFilter(table);
  }

  // ── Realza una tabla ────────────────────────────────────────────────────────
  function enhanceTable(table) {
    if (table.__tfEnhanced) return;
    if (table.classList.contains('tf-skip') || table.hasAttribute('data-no-filter')) return;
    var thead = table.tHead;
    var tbody = table.tBodies && table.tBodies[0];
    if (!thead || !tbody) return;
    // usar la última fila de encabezado con celdas (cubre theads de 1 fila)
    var headRows = thead.rows;
    var headRow = null;
    for (var i = headRows.length - 1; i >= 0; i--) {
      if (headRows[i].cells.length >= 2 && !headRows[i].classList.contains('tf-row')) { headRow = headRows[i]; break; }
    }
    if (!headRow) return;
    var ncols = headRow.cells.length;
    if (ncols < 2) return;
    table.__tfEnhanced = true;

    var filterRow = document.createElement('tr');
    filterRow.className = 'tf-row';
    var inputs = [];
    for (var c = 0; c < ncols; c++) {
      var th = document.createElement('th');
      th.className = 'tf-cell';
      var hdrTxt = (headRow.cells[c].textContent || '').replace(/\s+/g, ' ').trim();
      var inp = document.createElement('input');
      inp.className = 'tf-inp';
      inp.type = 'text';
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.setAttribute('data-col', c);
      inp.setAttribute('aria-label', 'Filtrar ' + (hdrTxt || ('columna ' + (c + 1))));
      inp.placeholder = hdrTxt ? ('Filtrar ' + (hdrTxt.length > 14 ? hdrTxt.slice(0, 13) + '…' : hdrTxt)) : 'Filtrar…';
      var clr = document.createElement('button');
      clr.type = 'button';
      clr.className = 'tf-clear';
      clr.innerHTML = '&times;';
      clr.tabIndex = -1;
      th.appendChild(inp);
      th.appendChild(clr);
      filterRow.appendChild(th);
      inputs.push(inp);
      bindInput(inp, clr, table);
    }
    thead.appendChild(filterRow);

    // contador de resultados (sobre la tabla)
    var count = document.createElement('div');
    count.className = 'tf-count tf-hide';
    count.innerHTML = '<span class="tf-count-txt"></span> · <button type="button">limpiar filtros</button>';
    count.querySelector('button').addEventListener('click', function () { clearAll(table); });
    if (table.parentNode) table.parentNode.insertBefore(count, table);

    table.__tf = { inputs: inputs, tbody: tbody, cache: Object.create(null), count: count };

    // Re-aplicar y refrescar sugerencias cuando la tabla cargue datos por AJAX.
    var refresh = debounce(function () {
      table.__tf.cache = Object.create(null);
      applyFilter(table);
    }, 130);
    try {
      var mo = new MutationObserver(refresh);
      mo.observe(tbody, { childList: true });
    } catch (_) {}
  }

  function bindInput(inp, clr, table) {
    var deb = debounce(function () { onInputChanged(inp, table); }, 120);
    inp.addEventListener('input', deb);
    inp.addEventListener('focus', function () { openDD(inp, table, +inp.getAttribute('data-col')); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!ddCtx) openDD(inp, table, +inp.getAttribute('data-col')); else moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter') { if (ddCtx && ddCtx.active >= 0) { e.preventDefault(); chooseOption(); } else closeDD(); }
      else if (e.key === 'Escape') { if (inp.value) { inp.value = ''; onInputChanged(inp, table); } closeDD(); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (ddCtx && ddCtx.input === inp) closeDD(); }, 120); });
    clr.addEventListener('click', function () { inp.value = ''; applyFilter(table); inp.focus(); openDD(inp, table, +inp.getAttribute('data-col')); });
    // clic en la celda de filtro no debe disparar ordenamiento del encabezado
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // ── Recorre el documento ────────────────────────────────────────────────────
  function enhanceAll(root) {
    var tables = (root || document).querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      try { enhanceTable(tables[i]); } catch (_) {}
    }
  }

  // Cerrar/recolocar el desplegable al hacer scroll o redimensionar.
  window.addEventListener('scroll', function () { closeDD(); }, true);
  window.addEventListener('resize', function () { closeDD(); });

  function boot() {
    injectCss();
    enhanceAll(document);
    // Tablas creadas dinámicamente (paneles BI): re-escanear con bajo costo.
    try {
      var mo = new MutationObserver(debounce(function () { enhanceAll(document); }, 250));
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
