/**
 * app-ui-boot.js — Capa IA Premium: partículas · aurora · reveal scroll
 * Barra de refresco · cursor glow · staggered animations · IA Pro launcher
 * v2 — Debug telemetry eliminado. Cursor glow + sparkle multicapa añadidos.
 */

// ── Inyectar data-cache.js antes que cualquier otra lógica ───────────────────
(function injectDataCache() {
  if (typeof window.__sumiCache !== 'undefined') return;
  var s = document.createElement('script');
  var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : '';
  s.src = base + '/data-cache.js';
  s.async = false;
  document.head.appendChild(s);
})();

(function () {
  // ════════════════════════════════════════════════════════
  //  REFRESH BAR
  // ════════════════════════════════════════════════════════
  function injectManualRefreshStyles() {
    if (typeof document === 'undefined' || document.getElementById('ms-refresh-bar-styles')) return;
    var s = document.createElement('style');
    s.id = 'ms-refresh-bar-styles';
    s.textContent =
      '.ms-refresh-bar{position:sticky;top:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%;padding:7px 14px;' +
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12px;line-height:1.35;' +
      'background:linear-gradient(90deg,rgba(8,16,30,.96) 0%,rgba(15,28,50,.94) 100%);' +
      'color:#e2e8f0;border-bottom:1px solid rgba(255,255,255,.06);' +
      'box-shadow:0 2px 16px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.04);' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}' +

      '.ms-refresh-inner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;' +
      'max-width:1400px;margin:0 auto}' +

      '.ms-refresh-btn{cursor:pointer;font:inherit;font-weight:700;padding:5px 14px;' +
      'border-radius:20px;border:1px solid rgba(230,168,0,.4);' +
      'background:linear-gradient(135deg,rgba(230,168,0,.12),rgba(34,211,238,.08));' +
      'color:#f8fafc;letter-spacing:.02em;' +
      'transition:background .18s,border-color .18s,transform .18s,box-shadow .18s}' +

      '.ms-refresh-btn:hover:not(:disabled){' +
      'background:linear-gradient(135deg,rgba(230,168,0,.22),rgba(34,211,238,.14));' +
      'border-color:rgba(230,168,0,.65);transform:translateY(-1px);' +
      'box-shadow:0 4px 16px rgba(230,168,0,.25)}' +

      '.ms-refresh-btn:active:not(:disabled){transform:translateY(0) scale(.97)}' +
      '.ms-refresh-btn:disabled{opacity:.45;cursor:not-allowed}' +
      '.ms-refresh-status{flex:1;min-width:0;word-break:break-word;font-size:11.5px;letter-spacing:.01em}' +
      '.ms-refresh-status.loading{color:#fbbf24;animation:ms-rb-blink 1.4s ease-in-out infinite}' +
      '.ms-refresh-status.ok{color:#4ade80}' +
      '.ms-refresh-status.err{color:#f87171}' +

      '@keyframes ms-rb-blink{0%,100%{opacity:1}50%{opacity:.55}}' +
      '@media print{.ms-refresh-bar{display:none!important}}';
    document.head.appendChild(s);
  }

  function bootManualRefreshBar() {
    if (typeof document === 'undefined' || !document.body) return;
    injectManualRefreshStyles();

    var bar = document.createElement('div');
    bar.className = 'ms-refresh-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Actualización de datos');
    bar.innerHTML =
      '<div class="ms-refresh-inner">' +
      '<button type="button" class="ms-refresh-btn" id="ms-ref-btn">↻ Actualizar</button>' +
      '<span class="ms-refresh-status loading" id="ms-ref-status">Cargando datos…</span>' +
      '<span id="ms-countdown" style="font-family:\'DM Mono\',monospace;font-size:10.5px;color:rgba(148,163,184,.7);margin-left:auto;white-space:nowrap"></span>' +
      '</div>';

    document.body.insertBefore(bar, document.body.firstChild);

    var statusEl = document.getElementById('ms-ref-status') || bar.querySelector('.ms-refresh-status');
    var btn      = document.getElementById('ms-ref-btn')    || bar.querySelector('.ms-refresh-btn');
    var cntEl    = document.getElementById('ms-countdown');

    var _lastOkTs   = null;
    var _cntTimer   = null;
    var AUTO_MINS   = 30; // minutos de auto-refresh (setInterval de los dashboards)

    function fmt(dt) {
      try { return dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
      catch (e) { return String(dt); }
    }

    function startCountdown() {
      if (_cntTimer) clearInterval(_cntTimer);
      if (!_lastOkTs || !cntEl) return;
      _cntTimer = setInterval(function() {
        var elapsed = Math.floor((Date.now() - _lastOkTs) / 1000);
        var total   = AUTO_MINS * 60;
        var remain  = Math.max(0, total - elapsed);
        if (remain <= 0) { cntEl.textContent = '↻ auto-refresco ahora'; return; }
        var m = Math.floor(remain / 60);
        var s = remain % 60;
        cntEl.textContent = '⏱ próx. auto ' + m + ':' + String(s).padStart(2, '0');
      }, 1000);
    }

    function setLoading() {
      if (_cntTimer) { clearInterval(_cntTimer); _cntTimer = null; }
      if (cntEl) cntEl.textContent = '';
      statusEl.textContent = 'Cargando datos…';
      statusEl.className = 'ms-refresh-status loading';
      btn.disabled = true;
    }

    function setSuccess() {
      _lastOkTs = Date.now();
      var now = new Date(_lastOkTs);
      statusEl.textContent = '✓ Actualizado: ' + fmt(now);
      statusEl.className = 'ms-refresh-status ok';
      btn.disabled = false;
      startCountdown();
    }

    btn.addEventListener('click', function () {
      setLoading();
      // Intentar llamar loadAll() si existe; sino reload
      if (typeof window.loadAll === 'function') {
        try { window.loadAll(); return; } catch(_) {}
      }
      window.location.reload();
    });

    window.addEventListener('load', function () {
      if (!window.__manualRefreshDeferSuccess) setSuccess();
    });

    window.addEventListener('pageshow', function (ev) {
      if (ev.persisted && !window.__manualRefreshDeferSuccess) setSuccess();
    });

    window.markManualRefreshComplete = function () { setSuccess(); };

    if (document.readyState === 'complete' && !window.__manualRefreshDeferSuccess) setSuccess();

    applyRefreshBarStickyOffset(bar);
  }

  /** Calcula el offset del header sticky para que no quede tapado por la barra */
  function applyRefreshBarStickyOffset(barEl) {
    if (typeof document === 'undefined' || !barEl) return;

    function push() {
      try {
        var h = barEl.offsetHeight || 0;
        document.documentElement.style.setProperty('--ms-sticky-top', h + 'px');
      } catch (_) {}
    }

    push();
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', push, { passive: true });
      window.addEventListener('orientationchange', push, { passive: true });
    }
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(push).observe(barEl); } catch (_) {}
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('load', push, { passive: true });
    }
  }

  // ════════════════════════════════════════════════════════
  //  AURORA LAYER 2 + SPARKLES MULTICAPA (DOM injection)
  // ════════════════════════════════════════════════════════
  function bootAiMotion() {
    if (typeof document === 'undefined' || !document.body) return;

    // Sparkle capa 1
    var spark = document.createElement('div');
    spark.className = 'ms-ai-sparkle';
    spark.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(spark, document.body.firstChild);

    // Sparkle capa 2
    var spark2 = document.createElement('div');
    spark2.className = 'ms-ai-sparkle2';
    spark2.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(spark2, document.body.firstChild);

    // Sparkle capa 3 (gold)
    var spark3 = document.createElement('div');
    spark3.className = 'ms-ai-sparkle3';
    spark3.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(spark3, document.body.firstChild);

    // Aurora capa 2
    var aurora2 = document.createElement('div');
    aurora2.className = 'ms-ai-aurora2';
    aurora2.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(aurora2, document.body.firstChild);

    var reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduce) return;

    // ── IntersectionObserver: scroll reveal ─────────────────
    var selectors = [
      '.page > .hero',
      '.page > .page-header',
      '.page > #filter-bar',
      '.page > .biz-context-bar',
      '.page > .source-tabs',
      '.page > .ms-ai-page-banner',
      '.page > .exec-mission',
      '.page > .intel-bar',
      '.uni-portfolio',
      '.kpi-mega-grid .kpi-card',
      '.kpi-grid .kpi-card',
      '.scorecard-wrap',
      '.section-divider',
      '.modules-grid .module-card',
      '.secondary-grid > .card',
      '.page > .grid-2',
      '.page > .card',
      '.page .grid .card',
      '.page > .section-title',
      '.page > .grid',
      /* Dashboards Microsip */
      '.dash > .hdr',
      '.dash > .kpi-row',
      '.dash > .kpi-panel',
      '.dash > .chart-section',
      '.dash > .charts-grid',
      '.dash > .row-2',
      '.dash .kpi-row .kpi',
      '.dash .ccard',
      '.dash .tcard',
      /* CxC */
      'main > .cxc-hero',
      'main > .cxc-kpi-journey',
      'main > #filter-bar',
      'main > .client-filter-bar',
      'main > .kpi-grid',
      'main > .aging-grid',
      'main > .tabs',
      'main > .card',
      'main > .grid-2',
      'main > .grid-32',
    ];

    var seen = new Set();
    var els  = [];

    selectors.forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (seen.has(el)) return;
          seen.add(el);
          el.classList.add('ms-reveal');
          els.push(el);
        });
      } catch (_) {}
    });

    // Delay escalonado por posición en el DOM (máx ~0.5s)
    els.forEach(function (el, i) {
      var delay = Math.min(i * 0.055, 0.50);
      el.style.transitionDelay = delay + 's';
    });

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('ms-inview');
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: '0px 0px -5% 0px', threshold: 0.04 }
    );

    els.forEach(function (el) { io.observe(el); });

    // Forzar visible al hero inmediatamente
    requestAnimationFrame(function () {
      document.querySelectorAll('.hero--ai, .page > .hero.ms-reveal').forEach(function (el) {
        el.classList.add('ms-inview');
      });
    });

    // Fallback: garantizar que todo se muestre aunque no intersecte
    setTimeout(function () {
      document.querySelectorAll('.ms-reveal:not(.ms-inview)').forEach(function (el) {
        el.classList.add('ms-inview');
      });
    }, 2600);
  }

  // ════════════════════════════════════════════════════════
  //  CURSOR GLOW — halo sutil que sigue al cursor
  // ════════════════════════════════════════════════════════
  function bootCursorGlow() {
    if (typeof document === 'undefined') return;

    // Solo en desktop (pointer: fine)
    if (typeof window.matchMedia === 'function' &&
        !window.matchMedia('(pointer: fine)').matches) return;

    var reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    var glow = document.createElement('div');
    glow.className = 'ms-cursor-glow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.appendChild(glow);

    var mx = window.innerWidth  / 2;
    var my = window.innerHeight / 2;
    var cx = mx, cy = my;
    var raf;

    document.addEventListener('mousemove', function (e) {
      mx = e.clientX;
      my = e.clientY;
    }, { passive: true });

    document.addEventListener('mouseleave', function () {
      glow.style.opacity = '0';
    });
    document.addEventListener('mouseenter', function () {
      glow.style.opacity = '1';
    });

    function lerp(a, b, t) { return a + (b - a) * t; }

    function animate() {
      cx = lerp(cx, mx, 0.08);
      cy = lerp(cy, my, 0.08);
      glow.style.left = cx + 'px';
      glow.style.top  = cy + 'px';
      raf = requestAnimationFrame(animate);
    }

    raf = requestAnimationFrame(animate);
  }

  // ════════════════════════════════════════════════════════
  //  IA PRO LAUNCHER — botón en el nav
  // ════════════════════════════════════════════════════════
  function bootAiProLauncher() {
    if (typeof document === 'undefined') return;
    var nav = document.querySelector('header nav.hdr-nav, header .hdr-nav, nav#main-nav');
    if (!nav || document.getElementById('sumi-ai-pro-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'sumi-ai-pro-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Abrir Asistente IA Pro');
    btn.innerHTML =
      '<span style="font-size:12px;margin-right:3px;filter:drop-shadow(0 0 4px rgba(230,168,0,.8))">✦</span>' +
      'IA Pro';
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:2px;' +
      'background:linear-gradient(135deg,#E6A800 0%,#B87D00 55%,#E6A800 100%);' +
      'background-size:200% auto;' +
      'color:#060E1A!important;font-weight:800;font-size:11.5px;' +
      'padding:5px 12px;border-radius:24px;letter-spacing:.05em;' +
      'border:none!important;text-decoration:none;white-space:nowrap;' +
      'box-shadow:0 2px 14px rgba(230,168,0,.40),0 0 0 1px rgba(230,168,0,.25);' +
      'transition:transform .18s,box-shadow .18s,background-position .4s;' +
      'cursor:pointer;animation:ms-iapro-shimmer 3s ease-in-out infinite;';

    // Inyectar keyframe del botón si no existe
    if (!document.getElementById('sumi-ai-pro-style')) {
      var st = document.createElement('style');
      st.id = 'sumi-ai-pro-style';
      st.textContent =
        '@keyframes ms-iapro-shimmer{' +
        '0%,100%{background-position:0% center;box-shadow:0 2px 14px rgba(230,168,0,.40),0 0 0 1px rgba(230,168,0,.25)}' +
        '50%{background-position:100% center;box-shadow:0 4px 24px rgba(230,168,0,.65),0 0 0 1px rgba(230,168,0,.45)}' +
        '}';
      document.head.appendChild(st);
    }

    btn.addEventListener('mouseenter', function () {
      btn.style.transform = 'translateY(-2px) scale(1.04)';
      btn.style.boxShadow = '0 6px 28px rgba(230,168,0,.65),0 0 0 1px rgba(230,168,0,.45)';
      btn.style.animationPlayState = 'paused';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.transform = '';
      btn.style.boxShadow = '';
      btn.style.animationPlayState = 'running';
    });

    // ── Click: abre el chat widget embebido; nunca navega a un servidor externo ──
    btn.addEventListener('click', function (e) {
      e.preventDefault();

      // 1. Si el FAB del chat widget existe, simular click para abrirlo
      var fab = document.getElementById('cw-fab');
      if (fab) {
        // Si ya está abierto (panel visible), sólo enfocar input
        var panel = document.getElementById('cw-panel');
        if (panel && panel.style.display !== 'none' && panel.style.display !== '') {
          var inp = document.getElementById('cw-input');
          if (inp) inp.focus();
          return;
        }
        fab.click();
        // Dar foco al input tras apertura de animación
        setTimeout(function () {
          var inp = document.getElementById('cw-input');
          if (inp) inp.focus();
        }, 320);
        return;
      }

      // 2. Fallback: Si __ASISTENTE_AI_URL está configurado explícitamente en el servidor, usarlo
      if (typeof window.__ASISTENTE_AI_URL === 'string' && window.__ASISTENTE_AI_URL &&
          !window.__ASISTENTE_AI_URL.includes('localhost:5173')) {
        window.open(window.__ASISTENTE_AI_URL, '_blank', 'noopener');
        return;
      }

      // 3. Último recurso: mostrar toast de aviso en vez de página de error
      _showAiProToast();
    });

    nav.appendChild(btn);
  }

  function _showAiProToast() {
    if (document.getElementById('sumi-ai-toast')) return;
    var t = document.createElement('div');
    t.id = 'sumi-ai-toast';
    t.textContent = '💬 El asistente IA está disponible en el panel de chat (ícono inferior derecho)';
    t.style.cssText =
      'position:fixed;bottom:80px;right:20px;z-index:99999;' +
      'background:linear-gradient(135deg,#1a2740,#0d1a2e);' +
      'color:#e6c84a;font-size:13px;font-weight:600;' +
      'padding:12px 18px;border-radius:12px;max-width:320px;' +
      'box-shadow:0 4px 24px rgba(0,0,0,.55),0 0 0 1px rgba(230,168,0,.3);' +
      'border-left:3px solid #E6A800;' +
      'animation:sumi-toast-in .3s ease;pointer-events:none;';
    if (!document.getElementById('sumi-toast-kf')) {
      var ks = document.createElement('style');
      ks.id = 'sumi-toast-kf';
      ks.textContent =
        '@keyframes sumi-toast-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}' +
        '@keyframes sumi-toast-out{from{opacity:1}to{opacity:0;transform:translateY(16px)}}';
      document.head.appendChild(ks);
    }
    document.body.appendChild(t);
    setTimeout(function () {
      t.style.animation = 'sumi-toast-out .35s ease forwards';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 380);
    }, 3500);
  }

  // ════════════════════════════════════════════════════════
  //  KPI COUNT-UP — anima números al entrar en viewport
  // ════════════════════════════════════════════════════════
  function bootKpiCountUp() {
    if (typeof document === 'undefined') return;

    var reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    var targets = document.querySelectorAll('.kpi-val[data-val], .kpi-num[data-val]');
    if (!targets.length) return;

    function easeOut(t) { return 1 - Math.pow(1 - t, 4); }

    function animateNum(el) {
      if (el._ms_counted) return;
      el._ms_counted = true;

      var raw    = parseFloat(el.dataset.val);
      var prefix = el.dataset.prefix || '';
      var suffix = el.dataset.suffix || '';
      var decimals = (el.dataset.val.split('.')[1] || '').length;

      var start = 0;
      var end   = raw;
      var dur   = 1200;
      var t0    = performance.now();

      function step(now) {
        var p = Math.min((now - t0) / dur, 1);
        var v = easeOut(p) * end;
        el.textContent = prefix + v.toFixed(decimals) + suffix;
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = prefix + end.toFixed(decimals) + suffix;
      }

      requestAnimationFrame(step);
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          animateNum(en.target);
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.5 });

    targets.forEach(function (el) { io.observe(el); });
  }

  // ════════════════════════════════════════════════════════
  //  TECLADO — Alt+A → abrir / cerrar panel IA
  // ════════════════════════════════════════════════════════
  function bootKeyboardShortcuts() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', function (e) {
      // Alt+A (sin Ctrl, sin Meta) → toggle chat widget
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'a') {
        // No interferir si el foco está en un input / textarea / select / contenteditable
        var tag = document.activeElement ? document.activeElement.tagName : '';
        if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
        if (document.activeElement && document.activeElement.isContentEditable) return;

        e.preventDefault();
        var fab = document.getElementById('cw-fab');
        if (fab) {
          fab.click();
          return;
        }
        // Sin chat widget: abrir botón IA Pro si existe
        var iapro = document.getElementById('sumi-ai-pro-btn');
        if (iapro) iapro.click();
      }
    });

    // Tooltip de atajo en el botón IA Pro
    setTimeout(function () {
      var iapro = document.getElementById('sumi-ai-pro-btn');
      if (iapro && !iapro.getAttribute('title')) {
        iapro.setAttribute('title', 'Asistente IA (Alt+A)');
      }
    }, 200);
  }

  // ════════════════════════════════════════════════════════
  //  BOOT ALL
  // ════════════════════════════════════════════════════════
  function bootAll() {
    bootAiMotion();
    bootManualRefreshBar();
    bootCursorGlow();
    bootKpiCountUp();
    setTimeout(bootAiProLauncher, 120);
    bootKeyboardShortcuts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }

})();
