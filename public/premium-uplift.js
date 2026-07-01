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

  function forceBg() {
    try {
      var grad = 'radial-gradient(1200px 720px at 6% -8%,rgba(224,179,65,.18),transparent 55%),' +
                 'radial-gradient(1100px 760px at 104% 6%,rgba(120,86,40,.08),transparent 52%),' +
                 'linear-gradient(180deg,#FBF7EE 0%,#F2ECDE 60%,#EDE6D6 100%)';
      document.documentElement.style.setProperty('background', '#EFE9DC', 'important');
      document.body.style.setProperty('background-color', '#EFE9DC', 'important');
      document.body.style.setProperty('background-image', grad, 'important');
      document.body.style.setProperty('background-attachment', 'fixed', 'important');
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

  /* KPI cards → ícono en cuadro + eyebrow (fondo crema lo pone el CSS) */
  function kpiIcons() {
    try {
      document.querySelectorAll('.kpi-card').forEach(function (card) {
        if (card.getAttribute('data-pu') === '1') return;
        var lbl = card.querySelector('.kpi-label');
        if (!lbl) return;
        card.setAttribute('data-pu', '1');
        var col = '_def';
        for (var i = 0; i < COLS.length; i++) { if (card.classList.contains(COLS[i])) { col = COLS[i]; break; } }
        var ic = ICONS[col] || ICONS._def;
        var span = document.createElement('span');
        span.className = 'pu-kpi-ico';
        span.style.color = ic.c;
        span.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ic.d + '"/></svg>';
        lbl.insertBefore(span, lbl.firstChild);
      });
    } catch (e) { console.error('[premium] kpiIcons', e && e.message); }
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
  function enhance() { logoMark(); userAvatar(); headerEyebrow(); kpiIcons(); groupNav(); }

  function init() {
    forceBg(); styleCharts(); enhance();
    requestAnimationFrame(function () { requestAnimationFrame(animate); });
    // Re-aplica tras render async de KPIs / login footer / theme toggles
    [250, 700, 1400, 2600].forEach(function (ms) { setTimeout(function () { forceBg(); enhance(); }, ms); });
    // Observa cambios del DOM (KPIs que se pintan al cargar datos)
    try {
      var mo = new MutationObserver(function () {
        clearTimeout(window.__puT); window.__puT = setTimeout(enhance, 120);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PremiumUplift = { forceBg: forceBg, enhance: enhance };
})();
