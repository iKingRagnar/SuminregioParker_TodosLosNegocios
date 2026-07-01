/* ============================================================================
   SUMINREGIO PARKER — PREMIUM UPLIFT (runtime del reskin Claude Design)
   SOLO presentacional. NO toca datos, endpoints, queries ni datasets de Chart.js.
   Hace: (1) fondo crema, (2) menú PANEL/INTELIGENCIA, (3) Chart.js premium,
   (4) PARIDAD DE DISEÑO: íconos en KPI + fondo crema, logo monograma "SP",
   avatar de usuario, eyebrow de encabezado, (5) animaciones de entrada.
   Todo con guardas anti-duplicado e idempotente (se puede re-ejecutar).
   ============================================================================ */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Íconos por color de KPI (tomados 1:1 del prototipo Ventas.dc.html) */
  var ICONS = {
    blue:   { c:'#2563EB', d:'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
    green:  { c:'#0E9F6E', d:'M3 17l6-6 4 4 8-8M21 7h-4M21 7v4' },
    yellow: { c:'#E0B341', d:'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4M12 12h3' },
    gold:   { c:'#E0B341', d:'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4M12 12h3' },
    orange: { c:'#D98324', d:'M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21V3ZM9.5 7h5M9.5 10h5' },
    purple: { c:'#7C5CFC', d:'M4 19V10M9 19V5M14 19v-6M19 19V8' },
    red:    { c:'#D92D20', d:'M12 3l9 16H3zM12 10v4M12 17h.01' },
    _def:   { c:'#B8860B', d:'M4 19V10M9 19V5M14 19v-6M19 19V8' }
  };
  var COLS = ['blue','green','yellow','gold','orange','purple','red'];

  /* Eyebrow por página (según el título real) */
  var EYEBROW = [
    [/ventas/i,'Comercial'],[/cobrad|cobran/i,'Tesorería'],[/vendedor/i,'Equipo comercial'],
    [/cxc|cuentas por cobrar/i,'Cartera'],[/cliente/i,'Cartera de clientes'],[/director/i,'Dirección general'],
    [/inventario/i,'Operaciones'],[/consumo/i,'Operaciones'],[/margen/i,'Rentabilidad'],
    [/finanzas|resultado|p&l/i,'Finanzas'],[/meta/i,'Objetivos'],[/mejora/i,'Mejora continua'],[/uso/i,'Actividad']
  ];

  /* Fondo crema cálido del diseño. Ojo: la app tiene capas decorativas fijas
     (aurora #0B1629 + una capa lux/ms-ux con gradiente casi-blanco) en z-index:-1
     que se pintan ENCIMA del fondo del body. Hay que recolorearlas o el crema no se ve. */
  var PU_CREAM = '#E8DEC8';
  var PU_GRAD =
    'radial-gradient(1200px 720px at 6% -8%,rgba(224,179,65,.20),transparent 55%),' +
    'radial-gradient(1000px 700px at 104% 4%,rgba(150,110,50,.10),transparent 52%),' +
    'linear-gradient(180deg,#EDE3CE 0%,#E7DCC5 55%,#E2D7BF 100%)';
  function forceBg() {
    try {
      document.documentElement.style.setProperty('background', PU_CREAM, 'important');
      document.body.style.setProperty('background-color', PU_CREAM, 'important');
      document.body.style.setProperty('background-image', 'none', 'important');
      // Recolorear las capas decorativas fijas (z-index:-1) que tapan el fondo
      document.querySelectorAll('div').forEach(function (el) {
        var cs = getComputedStyle(el);
        if (cs.position === 'fixed' && cs.zIndex === '-1') {
          var r = el.getBoundingClientRect();
          if (r.width > 700 && r.height > 400) {
            el.style.setProperty('background-color', PU_CREAM, 'important');
            el.style.setProperty('background-image', PU_GRAD, 'important');
            // ocultar los blobs de la aurora (colores que no van en el tema claro)
            el.querySelectorAll('.vp-blob, .vp-noise').forEach(function (b) { b.style.setProperty('display', 'none', 'important'); });
          }
        }
      });
    } catch (e) { console.error('[premium] bg', e && e.message); }
  }

  function groupNav() {
    try {
      document.querySelectorAll('#app-sidebar .sb-nav-label').forEach(function (l) {
        if (/^\s*men[uú]/i.test(l.textContent)) l.textContent = 'PANEL';
      });
      if (!document.getElementById('pu-intel-label')) {
        var links = [].slice.call(document.querySelectorAll('#app-sidebar .nav-link')), sumi = null;
        for (var i = 0; i < links.length; i++) {
          var h = links[i].getAttribute('href') || '';
          if (/sumi\s*ia/i.test(links[i].textContent) || /(^|\/)ia\.html/i.test(h)) { sumi = links[i]; break; }
        }
        if (sumi) {
          var lab = document.createElement('div');
          lab.id = 'pu-intel-label'; lab.className = 'sb-nav-label'; lab.textContent = 'INTELIGENCIA';
          lab.style.cssText = 'margin-top:14px;';
          sumi.parentNode.insertBefore(lab, sumi);
        }
      }
    } catch (e) { console.error('[premium] groupNav', e && e.message); }
  }

  /* Íconos del sidebar → los de línea exactos de la referencia (Inicio.dc.html) */
  var NAV_ICONS = {
    inicio:'<path d="M4 9.5 10 4.5l6 5"/><path d="M5.4 8.6V15.5h9V8.6"/>',
    ventas:'<path d="M3 14 8 9l3 3 6-6"/><path d="M13 6h4v4"/>',
    cobrad:'<circle cx="10" cy="10" r="6.4"/><path d="M7 10.2 9.2 12.4 13.4 8"/>',
    vended:'<circle cx="7.7" cy="8" r="2.5"/><path d="M3.6 16c0-2.4 1.9-3.9 4.1-3.9S11.8 13.6 11.8 16"/><path d="M13.4 6.4a2.3 2.3 0 0 1 0 4.3"/><path d="M16.4 16c0-1.7-.8-2.8-2-3.4"/>',
    cxc:'<rect x="3.4" y="5.5" width="13.2" height="9.5" rx="2"/><path d="M3.4 8.4h13.2"/><circle cx="13.3" cy="11.4" r="0.9" fill="currentColor" stroke="none"/>',
    client:'<rect x="5" y="3.6" width="10" height="12.8" rx="1.2"/><path d="M7.8 6.6h1.4M10.9 6.6h1.4M7.8 9.4h1.4M10.9 9.4h1.4M8.8 16.4v-3h2.4v3"/>',
    director:'<rect x="3.5" y="7" width="13" height="8.4" rx="1.6"/><path d="M7.4 7V5.8A1.3 1.3 0 0 1 8.7 4.5h2.6A1.3 1.3 0 0 1 12.6 5.8V7"/>',
    inventar:'<path d="M10 3.6 16.3 7v6L10 16.4 3.7 13V7Z"/><path d="M3.7 7 10 10.4 16.3 7M10 10.4V16.4"/>',
    consumo:'<path d="M3.4 10.5h3l2-5 3 9 2-4h3.2"/>',
    margen:'<circle cx="7" cy="7" r="1.7"/><circle cx="13" cy="13" r="1.7"/><path d="M14 6 6 14"/>',
    finanz:'<path d="M4 16h12M5.6 15.5V9M10 15.5V9M14.4 15.5V9M3.6 8.4 10 4.4l6.4 4Z"/>',
    admin:'<path d="M4 6.5h7M14.4 6.5h1.6M4 13.5h2M9.4 13.5h6.6"/><circle cx="12.5" cy="6.5" r="1.7"/><circle cx="7.5" cy="13.5" r="1.7"/>',
    sumi:'<path d="M10 4 11.3 8.2 15.5 9.6 11.3 11 10 15.2 8.7 11 4.5 9.6 8.7 8.2Z"/>',
    mejora:'<path d="M6 14 14 6M8.2 6H14v5.8"/>',
    metas:'<circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2.6"/>',
    uso:'<circle cx="10" cy="10" r="6.4"/><path d="M10 6.4V10l2.4 1.6"/>'
  };
  var NAV_MATCH = ['inicio','ventas','cobrad','vended','cxc','client','director','inventar','consumo','margen','finanz','uso','admin','sumi','mejora','metas'];
  function navIcons() {
    try {
      document.querySelectorAll('#app-sidebar .nav-link').forEach(function (a) {
        if (a.getAttribute('data-pu-ico') === '1') return;
        var t = (a.textContent || '').toLowerCase(), key = null;
        for (var i = 0; i < NAV_MATCH.length; i++) { if (t.indexOf(NAV_MATCH[i]) >= 0) { key = NAV_MATCH[i]; break; } }
        var d = key && NAV_ICONS[key]; if (!d) return;
        a.setAttribute('data-pu-ico', '1');
        var wrap = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
        var svg = a.querySelector('svg');
        if (svg) svg.outerHTML = wrap; else a.insertAdjacentHTML('afterbegin', wrap);
      });
    } catch (e) { console.error('[premium] navIcons', e && e.message); }
  }

  /* Logo → monograma "SP" dorado */
  function logoMark() {
    try {
      var ic = document.querySelector('#app-sidebar .sb-logo-icon');
      if (!ic || ic.getAttribute('data-pu') === '1') return;
      ic.setAttribute('data-pu', '1');
      ic.innerHTML = '<span style="font-family:Fraunces,serif;font-weight:700;font-size:15px;color:#241A08;letter-spacing:-.02em;">SP</span>';
      ic.style.cssText = 'width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:linear-gradient(135deg,#F6D279,#E0B341,#B8860B);box-shadow:0 2px 10px rgba(184,134,11,.4);';
    } catch (e) { console.error('[premium] logo', e && e.message); }
  }

  /* Avatar de usuario en el footer (iniciales del correo) */
  function userAvatar() {
    try {
      var u = document.querySelector('#app-sidebar .nav-user');
      if (!u || u.getAttribute('data-pu') === '1') return;
      var email = (u.textContent || '').trim(); if (!email) return;
      u.setAttribute('data-pu', '1');
      var name = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
      var parts = name.split(/\s+/);
      var ini = ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || (parts[0] || '')[1] || '');
      ini = ini.toUpperCase() || email[0].toUpperCase();
      var av = document.createElement('div');
      av.className = 'pu-avatar';
      av.textContent = ini;
      u.parentNode.insertBefore(av, u);
    } catch (e) { console.error('[premium] avatar', e && e.message); }
  }

  /* Eyebrow arriba del título de la página */
  function headerEyebrow() {
    try {
      var t = document.querySelector('.page-title, h1.uni-title, main h1');
      if (!t || t.getAttribute('data-pu-eb') === '1') return;
      // si ya hay un eyebrow inmediatamente antes, no dupликar
      var prev = t.previousElementSibling;
      if (prev && /uni-eyebrow|pu-eyebrow|eyebrow/i.test(prev.className)) { t.setAttribute('data-pu-eb', '1'); return; }
      var txt = 'Suminregio Parker';
      var tt = t.textContent || '';
      for (var i = 0; i < EYEBROW.length; i++) { if (EYEBROW[i][0].test(tt)) { txt = EYEBROW[i][1]; break; } }
      t.setAttribute('data-pu-eb', '1');
      var eb = document.createElement('div');
      eb.className = 'pu-eyebrow';
      eb.textContent = txt;
      t.parentNode.insertBefore(eb, t);
    } catch (e) { console.error('[premium] eyebrow', e && e.message); }
  }

  /* Pill "● Actualizado HH:MM" a la derecha del encabezado (mueve la hora del subtítulo) */
  function headerPill() {
    try {
      var hdr = document.querySelector('.page-header');
      if (!hdr || hdr.getAttribute('data-pu-pill') === '1') return;
      var sub = hdr.querySelector('.page-sub');
      var txt = sub ? sub.textContent : '';
      var m = txt.match(/(\d{1,2}:\d{2})(?::\d{2})?\s*([ap]\.?\s*m\.?)?/i);
      if (!m) return; // sin hora que mover, no reestructura
      hdr.setAttribute('data-pu-pill', '1');
      var hora = m[1] + (m[2] ? (' ' + m[2].replace(/\s+/g, '').toLowerCase()) : '');
      if (sub) {
        var parts = txt.split('·').map(function (s) { return s.trim(); }).filter(function (s) { return s && !/actualiz/i.test(s); });
        sub.textContent = parts.join(' · ');
        if (!parts.length) sub.style.display = 'none';
      }
      hdr.style.setProperty('display', 'flex', 'important');
      hdr.style.setProperty('align-items', 'flex-end', 'important');
      hdr.style.setProperty('justify-content', 'space-between', 'important');
      hdr.style.setProperty('flex-wrap', 'wrap', 'important');
      hdr.style.setProperty('gap', '1rem', 'important');
      var pill = document.createElement('div');
      pill.className = 'pu-updated-pill';
      pill.innerHTML = '<span class="pu-dot"></span><span class="pu-updated-txt">Actualizado ' + hora + '</span>';
      hdr.appendChild(pill);
    } catch (e) { console.error('[premium] headerPill', e && e.message); }
  }

  /* KPI cards → ícono en cuadro + eyebrow (fondo crema lo pone el CSS) */
  function mkIco(col) {
    var ic = ICONS[col] || ICONS._def;
    var span = document.createElement('span');
    span.className = 'pu-kpi-ico';
    span.style.color = ic.c;
    span.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ic.d + '"/></svg>';
    return span;
  }
  function colOf(card) {
    for (var i = 0; i < COLS.length; i++) { if (card.classList.contains(COLS[i])) return COLS[i]; }
    return '_def';
  }
  function kpiIcons() {
    try {
      // .kpi-card (Ventas/Finanzas/etc.): ícono dentro de .kpi-label
      document.querySelectorAll('.kpi-card').forEach(function (card) {
        if (card.getAttribute('data-pu') === '1') return;
        var lbl = card.querySelector('.kpi-label');
        if (!lbl) return;
        card.setAttribute('data-pu', '1');
        lbl.insertBefore(mkIco(colOf(card)), lbl.firstChild);
      });
      // .kpi con clase de color (Cobradas/etc.): ícono dentro de .kpi-mod (eyebrow)
      document.querySelectorAll('.kpi.blue,.kpi.green,.kpi.yellow,.kpi.gold,.kpi.orange,.kpi.purple,.kpi.red').forEach(function (card) {
        if (card.classList.contains('kpi-card') || card.getAttribute('data-pu-ki') === '1') return;
        var mod = card.querySelector('.kpi-mod'); if (!mod) return;
        card.setAttribute('data-pu-ki', '1');
        mod.style.display = 'flex'; mod.style.alignItems = 'center'; mod.style.gap = '.45rem';
        mod.insertBefore(mkIco(colOf(card)), mod.firstChild);
      });
    } catch (e) { console.error('[premium] kpiIcons', e && e.message); }
  }

  /* KPI con valor cero → gris mudo (como el diseño). Inline porque el app re-colorea. */
  function kpiZero() {
    try {
      document.querySelectorAll('.kpi-card').forEach(function (c) {
        var v = c.querySelector('.kpi-value'); if (!v) return;
        // usar el valor FINAL (no el que va contando) para no titilar
        var raw = v.getAttribute('data-val') || v.dataset.cv || v.textContent || '';
        var zero = /^\$?\s*0([.,]0+)?\s*%?$/.test(raw.trim());
        if (zero) {
          c.classList.add('pu-zero');
          v.style.setProperty('color', '#9A8D76', 'important');
          var ic = c.querySelector('.pu-kpi-ico'); if (ic) ic.style.setProperty('color', '#9A8D76', 'important');
        } else if (c.classList.contains('pu-zero')) {
          c.classList.remove('pu-zero');
          v.style.removeProperty('color');
          var ic2 = c.querySelector('.pu-kpi-ico'); if (ic2) ic2.style.removeProperty('color');
        }
      });
    } catch (e) { console.error('[premium] kpiZero', e && e.message); }
  }

  /* Detener el conteo de números (animateNum del app + sp-count): mostrar el valor final ya. */
  function killCountUp() {
    try {
      // Marca todo lo que cuenta para que app-ui-boot no lo anime (sin tocar el texto:
      // el valor final ya lo escribe animateNum/render, y así no se pierde el formato $/,).
      document.querySelectorAll('[data-val]').forEach(function (el) { el._ms_counted = true; });
      document.querySelectorAll('.sp-count[data-cv]').forEach(function (el) { if (el.dataset.cv) el.textContent = el.dataset.cv; });
    } catch (e) { console.error('[premium] killCountUp', e && e.message); }
  }

  /* Pills de resumen del "Universo" → translúcidos sobre la banda oscura (app los pinta blancos) */
  function uniPills() {
    try {
      document.querySelectorAll('.uni-summary-strip .uni-sum-pill').forEach(function (p) {
        p.style.setProperty('background', 'rgba(255,255,255,.06)', 'important');
        p.style.setProperty('border', '1px solid rgba(240,200,104,.2)', 'important');
        p.style.setProperty('box-shadow', 'none', 'important');
        var l = p.querySelector('.u-l'); if (l) l.style.setProperty('color', '#C7AE80', 'important');
        var v = p.querySelector('.u-v'); if (v) v.style.setProperty('color', '#F7EFDE', 'important');
      });
    } catch (e) { console.error('[premium] uniPills', e && e.message); }
  }

  /* Tarjetas de entidad (Universo): mover el badge de cartera al header (arriba-derecha),
     como la referencia. Por defecto el app lo pone al final de la card. */
  function scCards() {
    try {
      document.querySelectorAll('.sc-card').forEach(function (card) {
        if (card.getAttribute('data-pu-sc') === '1') return;
        var badge = card.querySelector('.sc-badge');
        var header = card.querySelector('.sc-header');
        if (badge && header && badge.parentElement !== header) {
          card.setAttribute('data-pu-sc', '1');
          header.appendChild(badge);
        }
      });
    } catch (e) { console.error('[premium] scCards', e && e.message); }
  }

  function styleCharts() {
    try {
      if (!window.Chart || !Chart.defaults) return;
      var C = Chart.defaults;
      C.font = C.font || {}; C.font.family = "'DM Mono', monospace";
      C.color = '#A2937A'; C.borderColor = 'rgba(31,24,12,.06)';
      if (C.plugins && C.plugins.legend) {
        C.plugins.legend.labels = C.plugins.legend.labels || {};
        C.plugins.legend.labels.usePointStyle = true; C.plugins.legend.labels.boxWidth = 8;
        C.plugins.legend.labels.font = { family: "'Outfit', sans-serif", size: 11, weight: '500' };
      }
      if (C.plugins && C.plugins.tooltip) {
        var t = C.plugins.tooltip;
        t.backgroundColor = '#211A10';
        t.titleFont = { family: "'Fraunces', serif", size: 12, weight: '600' };
        t.bodyFont = { family: "'DM Mono', monospace", size: 11 };
        t.padding = 10; t.cornerRadius = 10; t.boxPadding = 4;
      }
    } catch (e) { console.error('[premium] charts', e && e.message); }
  }
  (function waitChart(n) {
    if (window.Chart && Chart.defaults) { styleCharts(); return; }
    if (n > 40) return; setTimeout(function () { waitChart(n + 1); }, 60);
  })(0);

  function rise(el, delay) {
    try { el.animate([{ opacity: 0, transform: 'translateY(22px)' }, { opacity: 1, transform: 'none' }],
      { duration: 620, delay: delay, easing: 'cubic-bezier(.18,.7,.25,1)', fill: 'backwards' }); } catch (e) {}
  }
  function animate() {
    if (reduce) return;
    ['.kpi-mega-grid', '.kpi-grid', '.sc-grid', '.aging-grid', '.uni-card-grid'].forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (g) {
        [].slice.call(g.children).forEach(function (c, i) { rise(c, 120 + i * 62); });
      });
    });
  }

  /* Corre todas las mejoras de paridad (idempotente) */
  function enhance() { logoMark(); navIcons(); userAvatar(); headerEyebrow(); headerPill(); kpiIcons(); kpiZero(); uniPills(); scCards(); killCountUp(); groupNav(); }

  function init() {
    forceBg(); styleCharts(); enhance();
    // Animaciones de entrada DESACTIVADAS a pedido del usuario (nada se mueve al cargar).
    // Re-aplica tras render async de KPIs / login footer / theme toggles
    [250, 700, 1400, 2600].forEach(function (ms) { setTimeout(function () { forceBg(); enhance(); }, ms); });
    // Observa cambios del DOM (KPIs que se pintan al cargar datos).
    // IMPORTANTE: ignora mutaciones de SOLO TEXTO (los contadores que animan las cifras),
    // si no, enhance() se dispararía en cada frame del conteo y causaría el "tick"/salto.
    try {
      var mo = new MutationObserver(function (muts) {
        var structural = false;
        for (var i = 0; i < muts.length && !structural; i++) {
          var m = muts[i], nodes = [].slice.call(m.addedNodes).concat([].slice.call(m.removedNodes));
          for (var j = 0; j < nodes.length; j++) { if (nodes[j].nodeType === 1) { structural = true; break; } }
        }
        if (!structural) return; // solo cambió texto (conteo) → no re-ejecutar
        clearTimeout(window.__puT); window.__puT = setTimeout(enhance, 200);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PremiumUplift = { forceBg: forceBg, enhance: enhance };
})();
