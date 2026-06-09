/* ─────────────────────────────────────────────────────────────────────────────
 * empty-period-helper.js — Evita la confusión de "tablero vacío"
 *
 * Cuando el periodo por defecto (mes en curso) todavía no tiene movimiento de
 * ventas en la base seleccionada, el tablero salía vacío sin explicación. Este
 * script detecta ese caso (vía /api/periodo/ultimo), AVISA con un banner claro y
 * CAE automáticamente al último mes con datos. Respeta cualquier periodo que el
 * usuario haya elegido explícitamente (no lo toca).
 *
 * Se carga global desde nav.js. No requiere cambios en las páginas.
 * ──────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__SUMI_EMPTY_PERIOD__) return;
  window.__SUMI_EMPTY_PERIOD__ = true;

  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function mesNom(m) { return cap(MESES[m - 1] || ('mes ' + m)); }

  function getDb() {
    try { var u = new URL(location.href).searchParams.get('db'); if (u && u.trim()) return u.trim(); } catch (_) {}
    try { var s = sessionStorage.getItem('microsip_erp_db'); if (s && s.trim()) return s.trim(); } catch (_) {}
    return '';
  }
  function apiBase() {
    try { if (window.__API_BASE) return String(window.__API_BASE).replace(/\/+$/, ''); } catch (_) {}
    return location.origin || '';
  }

  /** ¿El periodo activo es el mes en curso por defecto (sin elección explícita)? */
  function isDefaultCurrentMonth() {
    try {
      var sp = new URL(location.href).searchParams;
      if (sp.get('anio') || sp.get('mes') || sp.get('desde') || sp.get('hasta') || sp.get('preset')) return false;
    } catch (_) {}
    if (typeof window.filterGetParams !== 'function') return false;
    var p = window.filterGetParams() || {};
    return (p.preset || 'mes') === 'mes';
  }

  var acted = false;

  function act() {
    if (acted) return;
    if (typeof window.filterSetAnioMes !== 'function' || typeof window.filterGetParams !== 'function') return;
    if (!isDefaultCurrentMonth()) return;
    var now = new Date(), curY = now.getFullYear(), curM = now.getMonth() + 1, curYM = curY * 100 + curM;
    var db = getDb();
    var ck = 'sumi_ultmes_' + (db || 'def');
    var cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(ck) || 'null'); } catch (_) {}
    if (cached && cached.t && (Date.now() - cached.t) < 600000) {
      handle(cached.anio, cached.mes, curY, curM, curYM);
      return;
    }
    fetch(apiBase() + '/api/periodo/ultimo' + (db ? ('?db=' + encodeURIComponent(db)) : ''), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j) return;
        // No cachear fallos transitorios (ok:false o sin dato): cachear {anio:null} 10 min
        // desactivaba el aviso/fallback justo cuando más se necesitaba.
        if (j.ok && j.anio) {
          try { sessionStorage.setItem(ck, JSON.stringify({ anio: j.anio, mes: j.mes, t: Date.now() })); } catch (_) {}
        }
        if (j.ok) handle(j.anio, j.mes, curY, curM, curYM);
      })
      .catch(function () {});
  }

  function handle(anio, mes, curY, curM, curYM) {
    if (!anio || !mes) return;
    if (acted) return;
    var latestYM = anio * 100 + mes;
    if (latestYM >= curYM) return; // el mes en curso sí tiene datos (o futuro): nada que hacer
    acted = true;
    showBanner(curY, curM, anio, mes);
    try { window.filterSetAnioMes(anio, mes); } catch (_) {} // cae al último mes con datos (una vez)
  }

  function injectCss() {
    if (document.getElementById('sumi-empty-period-css')) return;
    var s = document.createElement('style');
    s.id = 'sumi-empty-period-css';
    s.textContent =
      '#sumi-empty-period{display:flex;align-items:center;gap:12px;flex-wrap:wrap;' +
      'background:linear-gradient(90deg,rgba(230,168,0,.16),rgba(255,140,66,.10));' +
      'border:1px solid rgba(230,168,0,.4);border-radius:14px;padding:13px 16px;margin:0 0 16px;' +
      'box-shadow:0 8px 26px rgba(230,168,0,.14);animation:sepIn .3s ease both;}' +
      '@keyframes sepIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}' +
      '#sumi-empty-period .sep-ic{font-size:1.2rem;line-height:1;}' +
      '#sumi-empty-period .sep-tx{flex:1;min-width:220px;color:#7c2d12;font-size:.9rem;line-height:1.35;}' +
      '#sumi-empty-period .sep-tx b{color:#92400e;}' +
      '#sumi-empty-period .sep-btn{border:1px solid rgba(180,83,9,.4);background:rgba(255,255,255,.7);' +
      'color:#92400e;font-weight:700;font-size:.8rem;padding:8px 14px;border-radius:10px;cursor:pointer;font-family:inherit;}' +
      '#sumi-empty-period .sep-btn:hover{background:#fff;}' +
      '#sumi-empty-period .sep-x{border:0;background:none;color:#b45309;font-size:1.3rem;line-height:1;cursor:pointer;padding:0 4px;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function showBanner(curY, curM, anio, mes) {
    if (document.getElementById('sumi-empty-period')) return;
    injectCss();
    var b = document.createElement('div');
    b.id = 'sumi-empty-period';
    b.innerHTML =
      '<span class="sep-ic">📅</span>' +
      '<span class="sep-tx"><b>' + mesNom(curM) + ' ' + curY + '</b> aún no tiene movimiento en esta base. ' +
      'Mostrando el último periodo con datos: <b>' + mesNom(mes) + ' ' + anio + '</b>.</span>' +
      '<button type="button" class="sep-btn" id="sep-current">Ver ' + mesNom(curM) + ' de todos modos</button>' +
      '<button type="button" class="sep-x" aria-label="cerrar">&times;</button>';
    var anchor = document.querySelector('main');
    if (anchor) anchor.insertBefore(b, anchor.firstChild);
    else {
      var hdr = document.getElementById('app-header');
      if (hdr && hdr.parentNode) hdr.parentNode.insertBefore(b, hdr.nextSibling);
      else document.body.appendChild(b);
    }
    var cur = document.getElementById('sep-current');
    if (cur) cur.addEventListener('click', function () { try { window.filterSetAnioMes(curY, curM); } catch (_) {} });
    var x = b.querySelector('.sep-x');
    if (x) x.addEventListener('click', function () { b.remove(); });
  }

  // Esperar a que filters.js exponga la API antes de actuar.
  var tries = 0;
  function waitAndRun() {
    if (typeof window.filterSetAnioMes === 'function' && typeof window.filterGetParams === 'function') {
      setTimeout(act, 80);
      return;
    }
    if (tries++ > 40) return; // ~6s
    setTimeout(waitAndRun, 150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitAndRun);
  else waitAndRun();
})();
