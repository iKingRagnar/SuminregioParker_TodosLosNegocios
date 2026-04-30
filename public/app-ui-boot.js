/**
 * app-ui-boot.js — Capa IA Premium: partículas · aurora · reveal scroll
 * Barra de refresco · cursor glow · staggered animations · IA Pro launcher
 * v2 — Debug telemetry eliminado. Cursor glow + sparkle multicapa añadidos.
 */

(function loadAuthGuard() {
  if (typeof window === 'undefined' || window.__SUMINREGIO_AUTH_GUARD_V6__) return;
  try {
    var g = document.createElement('script');
    g.src = '/auth-guard.js?v=6';
    g.async = false;
    (document.head || document.documentElement).appendChild(g);
  } catch (_) {}
})();

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
      var _autoFired = false; // evitar doble disparo

      _cntTimer = setInterval(function () {
        var elapsed = Math.floor((Date.now() - _lastOkTs) / 1000);
        var total   = AUTO_MINS * 60;
        var remain  = Math.max(0, total - elapsed);

        if (remain <= 0) {
          // ── Disparo único del auto-refresh ─────────────────────────────
          if (!_autoFired) {
            _autoFired = true;
            clearInterval(_cntTimer);
            _cntTimer = null;
            if (cntEl) cntEl.textContent = '↻ actualizando…';

            // 1. Limpiar AMBAS capas de caché
            try {
              if (typeof window.clearApiCache === 'function') window.clearApiCache();
            } catch (_) {}
            try {
              if (typeof SUMI_CACHE !== 'undefined') {
                SUMI_CACHE.clearAll();
                SUMI_CACHE.setBypass(true);
                setTimeout(function () { SUMI_CACHE.setBypass(false); }, 14000);
              }
            } catch (_) {}

            // 2. Recargar datos de la página (sin full reload si es posible)
            setLoading();
            var reloaded = false;
            if (typeof window.loadAll === 'function') {
              try { window.loadAll(); reloaded = true; } catch (_) {}
            }
            if (!reloaded && typeof window.__reloadPageData === 'function') {
              try { window.__reloadPageData(); reloaded = true; } catch (_) {}
            }
            if (!reloaded) {
              // Fallback: full reload con caché ya limpia
              setTimeout(function () { window.location.reload(); }, 300);
            }
          }
          return;
        }

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

    // IMPORTANTE: ventas.html usa setText() que guarda el valor formateado
    // ("$795,069.93") en data-val de .kpi-value — NO targeteamos .kpi-value
    // para evitar parseFloat("$795,069.93") = NaN que sobreescribe el valor.
    // Solo targetear .kpi-val y .kpi-num que usan data-val numérico limpio.
    var targets = document.querySelectorAll(
      '.kpi-val[data-val], .kpi-num[data-val]'
    );
    if (!targets.length) return;

    // Easing: exponential out — arranque rápido, frenada suave
    function easeOutExpo(t) {
      return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    }

    // Formatea número con separadores de miles según locale es-MX
    function fmtNum(v, decimals, prefix, suffix) {
      var abs = Math.abs(v);
      var sign = v < 0 ? '-' : '';
      var formatted;
      try {
        formatted = abs.toLocaleString('es-MX', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals
        });
      } catch (e) {
        formatted = abs.toFixed(decimals);
      }
      return prefix + sign + formatted + suffix;
    }

    function animateNum(el) {
      if (el._ms_counted) return;

      // Limpiar cualquier símbolo de formato antes de parsear
      var rawStr   = (el.dataset.val || '').replace(/[^0-9.-]/g, '');
      var raw      = parseFloat(rawStr);

      // Guard: si no es número limpio, no animar (evita NaN en pantalla)
      if (isNaN(raw)) return;

      el._ms_counted = true;

      var prefix   = el.dataset.prefix || '';
      var suffix   = el.dataset.suffix || '';
      var decimals = (el.dataset.val.split('.')[1] || '').replace(/[^0-9]/g,'').length;
      var dur      = 1400;
      var t0       = performance.now();

      function step(now) {
        var p = Math.min((now - t0) / dur, 1);
        var e = easeOutExpo(p);
        var v = e * raw;
        el.textContent = fmtNum(v, decimals, prefix, suffix);
        if (p < 1) {
          requestAnimationFrame(step);
        } else {
          el.textContent = fmtNum(raw, decimals, prefix, suffix);
          // Micro-pop CSS al terminar
          el.classList.add('counting');
          setTimeout(function () { el.classList.remove('counting'); }, 450);
        }
      }

      requestAnimationFrame(step);
    }

    if (!('IntersectionObserver' in window)) {
      // Fallback sin IO: animar directamente
      targets.forEach(animateNum);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          animateNum(en.target);
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.4, rootMargin: '0px 0px -30px 0px' });

    targets.forEach(function (el) { io.observe(el); });
  }

  // ════════════════════════════════════════════════════════
  //  TOOLTIP — sistema premium data-tooltip
  //  Uso: <span data-tooltip="Texto descriptivo">…</span>
  // ════════════════════════════════════════════════════════
  function bootTooltip() {
    if (typeof document === 'undefined') return;

    // Crear elemento tooltip único reutilizable
    var tip = document.createElement('div');
    tip.id = 'sumi-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-live', 'polite');
    document.body.appendChild(tip);

    var _showTimer = null;
    var _hideTimer = null;
    var _currentTarget = null;

    function positionTip(el) {
      var rect = el.getBoundingClientRect();
      var tipRect = tip.getBoundingClientRect();
      var MARGIN = 10;
      var ARROW_H = 6;

      // Preferir arriba
      var top = rect.top - tipRect.height - ARROW_H - MARGIN;
      var left = rect.left + rect.width / 2 - tipRect.width / 2;

      // Si no cabe arriba, poner abajo
      if (top < MARGIN) {
        top = rect.bottom + ARROW_H + MARGIN;
        tip.style.setProperty('--arrow-dir', 'top');
      } else {
        tip.style.setProperty('--arrow-dir', 'bottom');
      }

      // Clamp horizontal
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - tipRect.width - MARGIN));

      tip.style.top  = Math.round(top)  + 'px';
      tip.style.left = Math.round(left) + 'px';
    }

    function showTip(el) {
      clearTimeout(_hideTimer);
      _currentTarget = el;
      tip.textContent = el.dataset.tooltip;
      tip.style.opacity = '0';
      tip.style.display = 'block';
      tip.classList.remove('visible');

      // Necesitamos un frame para obtener tipRect correcto
      requestAnimationFrame(function () {
        positionTip(el);
        _showTimer = setTimeout(function () {
          tip.classList.add('visible');
        }, 30);
      });
    }

    function hideTip() {
      clearTimeout(_showTimer);
      tip.classList.remove('visible');
      _hideTimer = setTimeout(function () {
        tip.style.display = 'none';
        _currentTarget = null;
      }, 200);
    }

    // Evento delegado — funciona con elementos dinámicos
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[data-tooltip]');
      if (!el || el === _currentTarget) return;
      showTip(el);
    }, { passive: true });

    document.addEventListener('mouseout', function (e) {
      var el = e.target.closest('[data-tooltip]');
      if (!el) return;
      if (e.relatedTarget && e.relatedTarget !== tip && el.contains(e.relatedTarget)) return;
      hideTip();
    }, { passive: true });

    // Cerrar en scroll/resize
    window.addEventListener('scroll', hideTip, { passive: true });
    window.addEventListener('resize', hideTip, { passive: true });

    // Cerrar en foco (teclado)
    document.addEventListener('focusout', function (e) {
      if (e.target.closest('[data-tooltip]')) hideTip();
    }, { passive: true });
  }

  // ════════════════════════════════════════════════════════
  //  SCROLL PROGRESS BAR — indicador de posición en página
  // ════════════════════════════════════════════════════════
  function bootScrollProgress() {
    if (typeof document === 'undefined') return;

    var bar = document.createElement('div');
    bar.id = 'sumi-scroll-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);

    var ticking = false;
    function update() {
      var scrolled = window.scrollY || window.pageYOffset || 0;
      var total    = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        1
      );
      var pct = Math.min(100, (scrolled / total) * 100);
      bar.style.width = pct + '%';
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });

    // Estado inicial
    update();
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
  //  MOBILE RESPONSIVE SYSTEM
  //  Inyecta mobile.css + hamburger nav drawer + swipe
  // ════════════════════════════════════════════════════════
  function bootMobile() {
    if (typeof document === 'undefined') return;

    // 1. Inject mobile.css stylesheet
    if (!document.getElementById('sumi-mobile-css')) {
      var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : '';
      var lnk = document.createElement('link');
      lnk.id   = 'sumi-mobile-css';
      lnk.rel  = 'stylesheet';
      lnk.href = base + '/mobile.css';
      document.head.appendChild(lnk);
    }

    // Only wire the hamburger on mobile widths
    var mq = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:768px)');
    if (!mq || !mq.matches) {
      // Still add listener so resizing into mobile works
      if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { if (e.matches) _buildHamburger(); });
      return;
    }
    _buildHamburger();
    if (mq && mq.addEventListener) mq.addEventListener('change', function (e) { if (e.matches) _buildHamburger(); });
  }

  function _buildHamburger() {
    if (document.getElementById('sumi-hamburger')) return; // already built

    var header = document.querySelector('header');
    if (!header) return;

    // ── Find the nav element ─────────────────────────────────────────
    var nav = header.querySelector('nav.hdr-nav, .hdr-nav, nav#main-nav')
           || header.querySelector('nav')
           || document.querySelector('nav#main-nav');
    if (!nav) return;

    // ── Create overlay backdrop ──────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.id = 'sumi-nav-overlay';
    document.body.appendChild(overlay);

    // ── Create hamburger button ──────────────────────────────────────
    var btn = document.createElement('button');
    btn.id   = 'sumi-hamburger';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Menú');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML =
      '<div class="hbg-icon">' +
        '<span></span><span></span><span></span>' +
      '</div>';

    // Insert into header (before or after existing header-right)
    var headerInner = header.querySelector('.header-inner') || header;
    var headerRight = headerInner.querySelector('.header-right');
    if (headerRight) {
      headerInner.insertBefore(btn, headerRight);
    } else {
      headerInner.appendChild(btn);
    }

    // ── Toggle function ──────────────────────────────────────────────
    var isNavOpen = false;
    function openNav() {
      isNavOpen = true;
      nav.classList.add('nav-open');
      overlay.classList.add('active');
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden'; // prevent scroll behind
    }
    function closeNav() {
      isNavOpen = false;
      nav.classList.remove('nav-open');
      overlay.classList.remove('active');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
    function toggleNav() { isNavOpen ? closeNav() : openNav(); }

    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleNav(); });
    overlay.addEventListener('click', closeNav);

    // Close nav when any nav-link is clicked
    nav.querySelectorAll('.nav-link, a').forEach(function (a) {
      a.addEventListener('click', function () { setTimeout(closeNav, 80); });
    });
    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isNavOpen) closeNav();
    });

    // ── Swipe-to-close (right-edge swipe left) ───────────────────────
    var swipeStartX = 0;
    var swipeStartY = 0;
    nav.addEventListener('touchstart', function (e) {
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
    }, { passive: true });
    nav.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - swipeStartX;
      var dy = Math.abs(e.changedTouches[0].clientY - swipeStartY);
      if (dx > 60 && dy < 60) closeNav();   // swipe right → close (RTL-friendly)
      if (dx < -60 && dy < 60) closeNav();  // swipe left → close (for left drawer)
    }, { passive: true });

    // ── Swipe-to-close on chat widget (bottom sheet) ─────────────────
    var cwPanel = document.getElementById('cw-panel');
    if (cwPanel) {
      var cwSwipeY = 0;
      cwPanel.addEventListener('touchstart', function (e) {
        cwSwipeY = e.touches[0].clientY;
      }, { passive: true });
      cwPanel.addEventListener('touchend', function (e) {
        var dy = e.changedTouches[0].clientY - cwSwipeY;
        // Swipe down ≥ 80px on top 60px of panel → close
        if (dy > 80 && e.changedTouches[0].clientY - cwPanel.getBoundingClientRect().top < 60) {
          var fab = document.getElementById('cw-fab');
          if (fab) fab.click();
        }
      }, { passive: true });
    }

    // ── Active nav-link current page ─────────────────────────────────
    var curPage = location.pathname.split('/').pop() || 'index.html';
    nav.querySelectorAll('a.nav-link').forEach(function (a) {
      var href = (a.getAttribute('href') || '').split('?')[0].split('/').pop();
      if (href === curPage) a.classList.add('active');
    });
  }

  // ════════════════════════════════════════════════════════
  //  THEME TOGGLE — dark / light mode
  // ════════════════════════════════════════════════════════
  function bootThemeToggle() {
    if (typeof document === 'undefined') return;
    // Apply saved theme on load
    var saved = '';
    try { saved = localStorage.getItem('sumi_theme') || ''; } catch(_) {}
    if (saved === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.classList.remove('theme-premium-light');
    } else if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }

    // Inject toggle button into nav-right after nav.js runs
    setTimeout(function () {
      var navRight = document.querySelector('.nav-right');
      if (!navRight || document.getElementById('sumi-theme-toggle')) return;
      var btn = document.createElement('button');
      btn.id = 'sumi-theme-toggle';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Cambiar tema');
      btn.setAttribute('title', 'Cambiar tema (claro/oscuro)');
      btn.textContent = _isDark() ? '☀️' : '🌙';
      btn.addEventListener('click', _toggleTheme);
      navRight.insertBefore(btn, navRight.firstChild);
    }, 180);
  }

  function _isDark() {
    var th = document.documentElement.getAttribute('data-theme');
    return th !== 'light';
  }

  function _toggleTheme() {
    var btn = document.getElementById('sumi-theme-toggle');
    if (_isDark()) {
      document.documentElement.setAttribute('data-theme', 'light');
      document.documentElement.classList.add('theme-premium-light');
      try { localStorage.setItem('sumi_theme', 'light'); } catch(_) {}
      if (btn) btn.textContent = '🌙';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.documentElement.classList.remove('theme-premium-light');
      try { localStorage.setItem('sumi_theme', 'dark'); } catch(_) {}
      if (btn) btn.textContent = '☀️';
    }
  }

  // ════════════════════════════════════════════════════════
  //  COMMAND PALETTE — Cmd+K / Ctrl+K
  // ════════════════════════════════════════════════════════
  var _cmdPalOpen = false;
  var _cmdPalIdx  = 0;

  var _CMD_PAGES = [
    { href:'index.html',      label:'Inicio',      desc:'Scorecard ejecutivo · KPIs principales',      icon:'🏠', color:'#4DA6FF' },
    { href:'ventas.html',     label:'Ventas',       desc:'Venta del día, mes, vendedores, facturas',    icon:'📈', color:'#00E5A0' },
    { href:'cobradas.html',   label:'Cobradas',     desc:'Cobranza realizada · facturas cobradas',      icon:'✅', color:'#00E5A0' },
    { href:'vendedores.html', label:'Vendedores',   desc:'Ranking y desempeño del equipo de ventas',   icon:'👥', color:'#9B6DFF' },
    { href:'cxc.html',        label:'CxC',          desc:'Cuentas por cobrar · aging · DSO',           icon:'💰', color:'#FFB800' },
    { href:'clientes.html',   label:'Clientes',     desc:'Top clientes · concentración',               icon:'🏢', color:'#4DA6FF' },
    { href:'director.html',   label:'Director',     desc:'Panel ejecutivo · ventas + cartera + equipo', icon:'📊', color:'#E6A800' },
    { href:'inventario.html', label:'Inventario',   desc:'Existencias · mínimos · artículos sin stock', icon:'📦', color:'#FF8C42' },
    { href:'resultados.html', label:'Finanzas',   desc:'Estado de resultados · PnL · margen bruto',  icon:'📋', color:'#00E5A0' },
  ];

  var _CMD_ACTIONS = [
    { id:'chat',    label:'Abrir Asistente IA',   desc:'Consulta inteligente en tiempo real',  icon:'🤖', color:'#E6A800', kbd:'Alt+A' },
    { id:'refresh', label:'Actualizar datos',      desc:'Recargar todos los KPIs del dashboard', icon:'↻',  color:'#4DA6FF', kbd:'Alt+R' },
    { id:'theme',   label:'Cambiar tema',          desc:'Alternar modo oscuro / claro',          icon:'🌙', color:'#9B6DFF', kbd:''      },
    { id:'export',  label:'Exportar CSV',          desc:'Descargar datos de la tabla activa',    icon:'⬇', color:'#00E5A0',  kbd:''      },
  ];

  function bootCommandPalette() {
    if (typeof document === 'undefined') return;

    // Build palette DOM
    var overlay = document.createElement('div');
    overlay.id = 'sumi-cmdpal-overlay';
    overlay.innerHTML =
      '<div id="sumi-cmdpal">' +
        '<div id="sumi-cmdpal-input-wrap">' +
          '<span id="sumi-cmdpal-icon">⌘</span>' +
          '<input id="sumi-cmdpal-input" type="text" placeholder="Buscar página o acción…" autocomplete="off" spellcheck="false"/>' +
          '<span id="sumi-cmdpal-hint">ESC para cerrar</span>' +
        '</div>' +
        '<div id="sumi-cmdpal-results"></div>' +
        '<div id="sumi-cmdpal-footer">' +
          '<span><span class="cp-kbd">↑↓</span> navegar</span>' +
          '<span><span class="cp-kbd">↵</span> abrir</span>' +
          '<span><span class="cp-kbd">ESC</span> cerrar</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Keyboard shortcut to open
    document.addEventListener('keydown', function (e) {
      // Cmd+K / Ctrl+K
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        _cmdPalOpen ? _closeCmdPal() : _openCmdPal();
        return;
      }
      // / key on non-input elements
      if (e.key === '/' && !_cmdPalOpen) {
        var tag = document.activeElement ? document.activeElement.tagName : '';
        if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
        if (document.activeElement && document.activeElement.isContentEditable) return;
        e.preventDefault();
        _openCmdPal();
        return;
      }
      if (!_cmdPalOpen) return;
      if (e.key === 'Escape') { _closeCmdPal(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); _cmdPalMove(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _cmdPalMove(-1); return; }
      if (e.key === 'Enter')     { e.preventDefault(); _cmdPalActivate(); return; }
    });

    // Click overlay to close
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _closeCmdPal();
    });

    // Input filter
    var inp = document.getElementById('sumi-cmdpal-input');
    if (inp) inp.addEventListener('input', function () { _cmdPalRender(this.value); });
  }

  function _openCmdPal() {
    var overlay = document.getElementById('sumi-cmdpal-overlay');
    if (!overlay) return;
    _cmdPalOpen = true;
    _cmdPalIdx = 0;
    overlay.classList.add('open');
    var inp = document.getElementById('sumi-cmdpal-input');
    if (inp) { inp.value = ''; inp.focus(); }
    _cmdPalRender('');
    document.body.style.overflow = 'hidden';
  }

  function _closeCmdPal() {
    var overlay = document.getElementById('sumi-cmdpal-overlay');
    if (!overlay) return;
    _cmdPalOpen = false;
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  function _cmdPalItems(q) {
    var term = (q || '').toLowerCase().trim();
    var pages = _CMD_PAGES.filter(function (p) {
      return !term || p.label.toLowerCase().includes(term) || p.desc.toLowerCase().includes(term);
    });
    var actions = _CMD_ACTIONS.filter(function (a) {
      return !term || a.label.toLowerCase().includes(term) || a.desc.toLowerCase().includes(term);
    });
    return { pages: pages, actions: actions };
  }

  function _cmdPalRender(q) {
    var res = document.getElementById('sumi-cmdpal-results');
    if (!res) return;
    var items = _cmdPalItems(q);
    var html = '';
    if (items.pages.length) {
      html += '<div class="cmdpal-section-label">Páginas</div>';
      items.pages.forEach(function (p) {
        html += '<a class="cmdpal-item" href="' + p.href + '" data-cmdpal-type="page">' +
          '<div class="cmdpal-item-icon" style="color:' + p.color + '">' + p.icon + '</div>' +
          '<div class="cmdpal-item-text">' +
            '<div class="cmdpal-item-name">' + p.label + '</div>' +
            '<div class="cmdpal-item-desc">' + p.desc + '</div>' +
          '</div>' +
        '</a>';
      });
    }
    if (items.actions.length) {
      html += '<div class="cmdpal-section-label">Acciones</div>';
      items.actions.forEach(function (a) {
        html += '<div class="cmdpal-item" data-cmdpal-action="' + a.id + '" data-cmdpal-type="action">' +
          '<div class="cmdpal-item-icon" style="color:' + a.color + '">' + a.icon + '</div>' +
          '<div class="cmdpal-item-text">' +
            '<div class="cmdpal-item-name">' + a.label + '</div>' +
            '<div class="cmdpal-item-desc">' + a.desc + '</div>' +
          '</div>' +
          (a.kbd ? '<span class="cmdpal-item-kbd">' + a.kbd + '</span>' : '') +
        '</div>';
      });
    }
    if (!html) {
      html = '<div class="cmdpal-empty">Sin resultados para "' + q + '"</div>';
    }
    res.innerHTML = html;
    _cmdPalIdx = 0;
    _cmdPalHighlight();

    // Wire action clicks
    res.querySelectorAll('[data-cmdpal-action]').forEach(function (el) {
      el.addEventListener('click', function () {
        _cmdPalRunAction(el.getAttribute('data-cmdpal-action'));
        _closeCmdPal();
      });
    });
    // Wire page clicks
    res.querySelectorAll('a.cmdpal-item').forEach(function (el) {
      el.addEventListener('click', function () { _closeCmdPal(); });
    });
  }

  function _cmdPalRunAction(id) {
    if (id === 'chat') {
      var fab = document.getElementById('cw-fab');
      if (fab) fab.click();
    } else if (id === 'refresh') {
      if (typeof window.loadAll === 'function') window.loadAll();
      else location.reload();
    } else if (id === 'theme') {
      _toggleTheme();
    } else if (id === 'export') {
      // Try CSV export functions in order of priority
      if (typeof window.exportVentasCsv === 'function') window.exportVentasCsv();
      else if (typeof window.exportVendedoresCsv === 'function') window.exportVendedoresCsv();
      else if (typeof window.exportClientesCsv === 'function') window.exportClientesCsv();
    }
  }

  function _cmdPalAllItems() {
    var q = '';
    try { q = document.getElementById('sumi-cmdpal-input').value; } catch(_) {}
    var items = _cmdPalItems(q);
    return Array.from(document.querySelectorAll('#sumi-cmdpal-results .cmdpal-item'));
  }

  function _cmdPalHighlight() {
    var all = _cmdPalAllItems();
    all.forEach(function (el, i) {
      el.classList.toggle('cmdpal-active', i === _cmdPalIdx);
      if (i === _cmdPalIdx) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function _cmdPalMove(dir) {
    var all = _cmdPalAllItems();
    if (!all.length) return;
    _cmdPalIdx = (_cmdPalIdx + dir + all.length) % all.length;
    _cmdPalHighlight();
  }

  function _cmdPalActivate() {
    var all = _cmdPalAllItems();
    if (all[_cmdPalIdx]) all[_cmdPalIdx].click();
  }

  // ════════════════════════════════════════════════════════
  //  OFFLINE BANNER
  // ════════════════════════════════════════════════════════
  function bootOfflineBanner() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    var banner = document.createElement('div');
    banner.id = 'sumi-offline-banner';
    banner.textContent = '📡 Sin conexión a Internet — algunos datos pueden estar desactualizados';
    document.body.appendChild(banner);

    function update() {
      banner.classList.toggle('show', !navigator.onLine);
    }
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
    update();
  }

  // ════════════════════════════════════════════════════════
  //  PULL-TO-REFRESH — mobile swipe down at top
  // ════════════════════════════════════════════════════════
  function bootPullToRefresh() {
    if (typeof document === 'undefined') return;
    var mq = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:768px)');
    if (!mq || !mq.matches) return;

    var indicator = document.createElement('div');
    indicator.id = 'sumi-ptr-indicator';
    indicator.textContent = '↓ Suelta para actualizar';
    document.body.appendChild(indicator);

    var startY = 0;
    var pulling = false;
    var THRESHOLD = 72;

    document.addEventListener('touchstart', function (e) {
      if (window.scrollY === 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!pulling) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 20 && window.scrollY === 0) {
        indicator.style.display = 'block';
        if (dy > THRESHOLD) {
          indicator.classList.add('ptr-ready');
          indicator.textContent = '↑ Suelta para actualizar';
        } else {
          indicator.classList.remove('ptr-ready');
          indicator.textContent = '↓ Jalando para actualizar… (' + Math.round(dy) + 'px)';
        }
      }
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!pulling) return;
      var dy = e.changedTouches[0].clientY - startY;
      indicator.style.display = 'none';
      indicator.classList.remove('ptr-ready');
      pulling = false;
      if (dy > THRESHOLD && window.scrollY === 0) {
        indicator.textContent = '↻ Actualizando...';
        indicator.style.display = 'block';
        setTimeout(function () { indicator.style.display = 'none'; }, 1200);
        // Trigger page data reload
        if (typeof window.loadAll === 'function') {
          window.loadAll();
        } else {
          location.reload();
        }
      }
    }, { passive: true });
  }

  // ════════════════════════════════════════════════════════
  //  BOTTOM NAVIGATION BAR — mobile only
  // ════════════════════════════════════════════════════════
  var BOTTOM_NAV_ITEMS = [
    { href:'index.html',    label:'Inicio',   icon:'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',    id:'bnav-inicio' },
    { href:'ventas.html',   label:'Ventas',   icon:'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z', id:'bnav-ventas' },
    { href:'cxc.html',      label:'CxC',      icon:'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z', id:'bnav-cxc-tab' },
    { href:'director.html', label:'Director', icon:'M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z',  id:'bnav-director' },
    { href:null,            label:'IA',       icon:'M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2M9 9a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1m6 0a1 1 0 0 0-1 1 1 1 0 0 0 1 1 1 1 0 0 0 1-1 1 1 0 0 0-1-1z', id:'bnav-ai-btn', isAi:true },
  ];

  function bootBottomNav() {
    if (typeof document === 'undefined') return;
    var mq = typeof window.matchMedia === 'function' && window.matchMedia('(max-width:768px)');
    if (!mq || !mq.matches) return;
    if (document.getElementById('sumi-bottom-nav')) return;

    var cur = (location.pathname.split('/').pop() || 'index.html');
    var nav = document.createElement('nav');
    nav.id = 'sumi-bottom-nav';
    nav.setAttribute('aria-label', 'Navegación principal');

    var ul = document.createElement('ul');
    BOTTOM_NAV_ITEMS.forEach(function (item) {
      var li = document.createElement('li');
      li.id = item.id || '';
      var isActive = item.href && (item.href === cur);

      if (item.isAi) {
        var btn = document.createElement('button');
        btn.id = 'bnav-ai-btn';
        btn.type = 'button';
        btn.className = 'bnav-ai-btn';
        btn.setAttribute('aria-label', 'Asistente IA');
        btn.innerHTML =
          '<div class="bnav-icon"><svg viewBox="0 0 24 24"><path d="' + item.icon + '"/></svg></div>' +
          '<span class="bnav-label">' + item.label + '</span>';
        btn.addEventListener('click', function () {
          var fab = document.getElementById('cw-fab');
          if (fab) fab.click();
        });
        li.appendChild(btn);
      } else {
        var a = document.createElement('a');
        a.href = item.href;
        if (isActive) a.className = 'bnav-active';
        a.setAttribute('aria-label', item.label);
        // CxC gets an alert badge span
        var badge = item.id === 'bnav-cxc-tab' ? '<span class="bnav-badge" id="bnav-cxc-badge"></span>' : '';
        a.innerHTML =
          badge +
          '<div class="bnav-icon"><svg viewBox="0 0 24 24"><path d="' + item.icon + '"/></svg></div>' +
          '<span class="bnav-label">' + item.label + '</span>';
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    nav.appendChild(ul);
    document.body.appendChild(nav);

    // Check for CxC alerts in background
    setTimeout(function () {
      var apiBase = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : '';
      fetch(apiBase + '/api/alerts/check', { signal: AbortSignal.timeout(15000) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var badge = document.getElementById('bnav-cxc-badge');
          if (badge && data.alertas && data.alertas.length > 0) {
            badge.classList.add('show');
          }
        })
        .catch(function () {});
    }, 3000);
  }

  // ════════════════════════════════════════════════════════
  //  BOOT ALL
  // ════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════
  //  DESIGN UPGRADE — inyectar CSS global + reveal observer
  // ════════════════════════════════════════════════════════
  function bootDesignUpgrade() {
    // 1. Inject design-upgrade.css into every page automatically
    if (!document.getElementById('du-global-css')) {
      var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : '';
      var link = document.createElement('link');
      link.id = 'du-global-css';
      link.rel = 'stylesheet';
      link.href = base + '/design-upgrade.css';
      document.head.appendChild(link);
    }

    // 2. IntersectionObserver for .ms-reveal → .is-visible (stagger entrance)
    if ('IntersectionObserver' in window) {
      var revealIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('is-visible');
            revealIO.unobserve(en.target);
          }
        });
      }, { threshold: 0.08 });

      // Observe all current + future .ms-reveal elements
      function observeReveal() {
        document.querySelectorAll('.ms-reveal:not(.is-visible)').forEach(function (el) {
          revealIO.observe(el);
        });
      }
      observeReveal();

      // MutationObserver to catch dynamically added elements
      // ⚠️ GUARD: observeReveal() solo observa elementos con .ms-reveal explícito.
      //    El autoReveal de abajo NUNCA aplica .ms-reveal a secciones dinámicas,
      //    por lo que este observer es seguro — solo actúa sobre lo que ya tiene la clase.
      var mo = new MutationObserver(function () { observeReveal(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }

    // 3. KPI value pop animation when content changes
    var popObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        var el = m.target;
        if (el && el.classList && el.classList.contains('kpi-value')) {
          el.classList.remove('counting');
          void el.offsetWidth; // reflow
          el.classList.add('counting');
          setTimeout(function () { el.classList.remove('counting'); }, 500);
        }
      });
    });
    document.querySelectorAll('.kpi-value').forEach(function (el) {
      popObserver.observe(el, { childList: true, characterData: true, subtree: true });
    });

    // 4. Add ms-reveal to KPI cards and module cards that don't have it yet
    // ⚠️  GUARD — REGLA DE ORO:
    //     Solo aplicar ms-reveal a contenedores ESTÁTICOS de index.html.
    //     NUNCA usar selector genérico '.kpi-card' — rompe #coti-section,
    //     capital.html, cxc.html y cualquier sección con tarjetas dinámicas.
    //     Si necesitas agregar una nueva sección al efecto de reveal, usa el
    //     patrón '.mi-grid-estatica > .kpi-card' con el contenedor padre exacto.
    var autoReveal = [
      '.kpi-mega-grid > .kpi-card',    // index.html — grid principal de KPIs
      '.modules-grid > .module-card',  // index.html — grid de módulos
      '.uni-entity-card',              // vendedores/clientes — tarjetas de entidad
      '.card.ms-reveal-auto'           // opt-in explícito con clase ms-reveal-auto
      // ❌ NO AGREGAR: '.kpi-card', '.kpi-grid .kpi-card'  → rompe cotizaciones y dinámicos
    ];
    autoReveal.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (!el.classList.contains('ms-reveal')) {
          el.classList.add('ms-reveal');
          if ('IntersectionObserver' in window) revealIO && revealIO.observe(el);
        }
      });
    });

    // ════ CANDADO: asegurar visibilidad en secciones dinámicas ════
    // Estas secciones renderizan tarjetas vía JS asíncrono.
    // Forzar is-visible para que nunca queden ocultas por ms-reveal.
    var dynamicSections = [
      '#coti-section',       // ventas.html — cotizaciones cargadas por loadCotizaciones()
      '#capital-kpis',       // capital.html — KPIs del capital de trabajo
      '#cxc-kpis',           // cxc.html — KPIs de CxC
      '#inv-kpis',           // inventario.html
      '#resumen-kpis'        // resultados.html
    ];
    function unlockDynamicCards() {
      dynamicSections.forEach(function (sec) {
        var container = document.querySelector(sec);
        if (!container) return;
        container.querySelectorAll('.kpi-card, .kpi-value, .kpi-label').forEach(function (el) {
          el.classList.remove('ms-reveal');
          el.classList.add('is-visible');
          el.style.opacity = '';
          el.style.transform = '';
          el.style.filter = '';
        });
      });
    }
    unlockDynamicCards();
    // Re-ejecutar después de que cargue contenido dinámico
    setTimeout(unlockDynamicCards, 600);
    setTimeout(unlockDynamicCards, 1500);
    setTimeout(unlockDynamicCards, 3500);
  }

  // ════════════════════════════════════════════════════════
  //  3D TILT + MAGNETIC HOVER — cards reaccionan al mouse
  // ════════════════════════════════════════════════════════
  function bootTiltEffect() {
    if (typeof document === 'undefined') return;
    if (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Only desktop (no touch)
    if ('ontouchstart' in window) return;

    var TILT_MAX   = 8;  // max degrees
    var TILT_SCALE = 1.015;

    function attachTilt(el) {
      if (el._tiltBound) return;
      el._tiltBound = true;

      el.addEventListener('mousemove', function (e) {
        var rect = el.getBoundingClientRect();
        var cx   = rect.left + rect.width  / 2;
        var cy   = rect.top  + rect.height / 2;
        var dx   = (e.clientX - cx) / (rect.width  / 2);
        var dy   = (e.clientY - cy) / (rect.height / 2);
        var rx   = -dy * TILT_MAX;
        var ry   =  dx * TILT_MAX;
        el.style.transform =
          'perspective(900px) rotateX(' + rx + 'deg) rotateY(' + ry + 'deg) scale(' + TILT_SCALE + ')';
        // Shine position for holographic effect
        var sx = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1) + '%';
        var sy = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1) + '%';
        el.style.setProperty('--tilt-shine-x', sx);
        el.style.setProperty('--tilt-shine-y', sy);
      });

      el.addEventListener('mouseleave', function () {
        el.style.transform = '';
        el.style.removeProperty('--tilt-shine-x');
        el.style.removeProperty('--tilt-shine-y');
      });
    }

    function scanTilt() {
      document.querySelectorAll('.kpi-card, .module-card, .uni-entity-card').forEach(attachTilt);
    }

    scanTilt();
    // Re-scan after dynamic content loads
    setTimeout(scanTilt, 800);
    setTimeout(scanTilt, 2500);
  }

  // ════════════════════════════════════════════════════════
  //  CANVAS PARTICLE NETWORK — red ambiental de partículas
  // ════════════════════════════════════════════════════════
  function bootParticleNetwork() {
    if ('ontouchstart' in window) return; // solo desktop
    if (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (document.getElementById('sumi-particles')) return;

    var canvas = document.createElement('canvas');
    canvas.id = 'sumi-particles';
    canvas.style.cssText = [
      'position:fixed;inset:0;width:100%;height:100%;',
      'pointer-events:none;z-index:0;',
      'opacity:.55;mix-blend-mode:screen;'
    ].join('');
    document.body.insertBefore(canvas, document.body.firstChild);

    var ctx = canvas.getContext('2d');
    var W, H, particles;
    var PARTICLE_COUNT = 48;
    var MAX_DIST = 110;
    var raf;

    function resize() {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }

    function mkParticle() {
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - .5) * .28,
        vy: (Math.random() - .5) * .28,
        r: Math.random() * 1.6 + .5,
        alpha: Math.random() * .35 + .1
      };
    }

    function init() {
      resize();
      particles = Array.from({ length: PARTICLE_COUNT }, mkParticle);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      // Update positions
      particles.forEach(function (p) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0)  p.x = W;
        if (p.x > W)  p.x = 0;
        if (p.y < 0)  p.y = H;
        if (p.y > H)  p.y = 0;
      });

      // Draw connections
      for (var i = 0; i < particles.length; i++) {
        for (var j = i + 1; j < particles.length; j++) {
          var dx = particles[i].x - particles[j].x;
          var dy = particles[i].y - particles[j].y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MAX_DIST) {
            var lineAlpha = (1 - dist / MAX_DIST) * .12;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = 'rgba(77,140,230,' + lineAlpha + ')';
            ctx.lineWidth = .5;
            ctx.stroke();
          }
        }
      }

      // Draw particles
      particles.forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(100,160,255,' + p.alpha + ')';
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    }

    window.addEventListener('resize', function () {
      cancelAnimationFrame(raf);
      init();
      draw();
    });

    init();
    draw();
  }

  // ════════════════════════════════════════════════════════
  //  CLICK RIPPLE — onda dorada al hacer clic
  // ════════════════════════════════════════════════════════
  function bootClickRipple() {
    if ('ontouchstart' in window) return;
    document.addEventListener('click', function (e) {
      // Solo en elementos interactivos o cards
      var target = e.target;
      var isInteractive = target.closest('button, a, .kpi-card, .module-card, .tab-btn, .card-badge, .biz-chip, .nav-link');
      if (!isInteractive) return;

      var ripple = document.createElement('span');
      ripple.className = 'click-ripple';
      ripple.style.left = e.clientX + 'px';
      ripple.style.top  = e.clientY + 'px';
      document.body.appendChild(ripple);
      setTimeout(function () { ripple.remove(); }, 700);
    });
  }

  // ════════════════════════════════════════════════════════
  //  NUMBER SCRAMBLE — DESACTIVADO
  //  Razón: el MutationObserver disparaba en CADA frame del
  //  count-up (bootKpiCountUp cambia textContent ~60fps),
  //  causando que los números "bailaran" constantemente.
  //  El efecto visual resultaba muy molesto en producción.
  // ════════════════════════════════════════════════════════
  function bootNumberScramble() { /* no-op */ }

  // ════════════════════════════════════════════════════════
  //  CUSTOM CURSOR — punto dorado + anillo magnético
  // ════════════════════════════════════════════════════════
  function bootCustomCursor() {
    if ('ontouchstart' in window) return;
    if (typeof document === 'undefined') return;
    if (document.getElementById('sumi-cursor-dot')) return;

    var dot  = document.createElement('div'); dot.id  = 'sumi-cursor-dot';
    var ring = document.createElement('div'); ring.id = 'sumi-cursor-ring';
    document.body.appendChild(dot);
    document.body.appendChild(ring);

    var cx = -200, cy = -200, rx = -200, ry = -200;

    document.addEventListener('mousemove', function (e) {
      cx = e.clientX; cy = e.clientY;
      dot.style.left = cx + 'px';
      dot.style.top  = cy + 'px';
    });

    // Hover states
    var INTERACTIVE = 'a, button, .kpi-card, .module-card, .tab-btn, .nav-link, .biz-chip, .card-badge, .ms-refresh-btn, .top-cli-btn, [role="button"], .bn-item';
    document.addEventListener('mouseover', function (e) {
      if (e.target.closest(INTERACTIVE)) {
        dot.classList.add('cu-hover');
        ring.classList.add('cu-hover');
      }
    });
    document.addEventListener('mouseout', function (e) {
      if (e.target.closest(INTERACTIVE)) {
        dot.classList.remove('cu-hover');
        ring.classList.remove('cu-hover');
      }
    });

    // Click flash
    document.addEventListener('mousedown', function () {
      dot.classList.add('cu-click');
      ring.classList.add('cu-click');
    });
    document.addEventListener('mouseup', function () {
      dot.classList.remove('cu-click');
      ring.classList.remove('cu-click');
    });

    // Smooth lag for ring
    function followRing() {
      rx += (cx - rx) * 0.11;
      ry += (cy - ry) * 0.11;
      ring.style.left = rx + 'px';
      ring.style.top  = ry + 'px';
      requestAnimationFrame(followRing);
    }
    followRing();
  }

  // ════════════════════════════════════════════════════════
  //  MAGNETIC EFFECT — nav links / tabs atraen al cursor
  // ════════════════════════════════════════════════════════
  function bootMagneticEffect() {
    if ('ontouchstart' in window) return;
    if (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    function attachMag(el, strength) {
      if (el._magBound) return;
      el._magBound = true;
      el.addEventListener('mousemove', function (e) {
        var rect = el.getBoundingClientRect();
        var dx = (e.clientX - (rect.left + rect.width  / 2)) * strength;
        var dy = (e.clientY - (rect.top  + rect.height / 2)) * strength;
        el.style.transform = 'translate(' + dx.toFixed(2) + 'px, ' + dy.toFixed(2) + 'px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    }

    function scanMagnetic() {
      document.querySelectorAll('#app-header .nav-link').forEach(function (el) {
        attachMag(el, 0.22);
      });
      document.querySelectorAll('.tab-btn').forEach(function (el) {
        attachMag(el, 0.28);
      });
      document.querySelectorAll('.ms-refresh-btn').forEach(function (el) {
        attachMag(el, 0.3);
      });
    }
    scanMagnetic();
    setTimeout(scanMagnetic, 800);
  }

  // ════════════════════════════════════════════════════════
  //  PAGE TRANSITIONS — fade cinemático entre páginas
  // ════════════════════════════════════════════════════════
  function bootPageTransitions() {
    // Fade IN al cargar
    document.body.style.cssText += ';opacity:0;filter:blur(3px);transform:translateY(6px)';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.style.transition = 'opacity .5s ease, transform .5s ease, filter .45s ease';
        document.body.style.opacity = '';
        document.body.style.transform = '';
        document.body.style.filter = '';
        setTimeout(function () { document.body.style.transition = ''; }, 600);
      });
    });

    // Fade OUT al navegar
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript') ||
          href.startsWith('mailto') || href.startsWith('tel')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      try {
        var url = new URL(href, location.href);
        if (url.origin !== location.origin) return;
      } catch (_) { return; }
      e.preventDefault();
      document.body.classList.add('sumi-page-leaving');
      setTimeout(function () { location.href = href; }, 330);
    });
  }

  // ════════════════════════════════════════════════════════
  //  TOP LOADING BAR — barra de progreso dorada
  // ════════════════════════════════════════════════════════
  function bootTopLoadingBar() {
    if (document.getElementById('sumi-top-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'sumi-top-bar';
    bar.style.width = '0%';
    document.body.insertBefore(bar, document.body.firstChild);

    var pct = 0;
    var iv = setInterval(function () {
      var jump = Math.random() * 12 + 3;
      pct = Math.min(pct + jump, 88);
      bar.style.width = pct + '%';
    }, 220);

    function finish() {
      clearInterval(iv);
      bar.style.width = '100%';
      setTimeout(function () {
        bar.style.opacity = '0';
        setTimeout(function () { bar.remove(); }, 450);
      }, 280);
    }

    if (document.readyState === 'complete') {
      finish();
    } else {
      window.addEventListener('load', finish, { once: true });
      // Safety: finish if load doesn't fire in 4s
      setTimeout(finish, 4000);
    }
  }

  // ════════════════════════════════════════════════════════
  //  API CACHE — respuestas en localStorage por 30 minutos
  // ════════════════════════════════════════════════════════
  // REGLA: los datos cargados UNA VEZ no se recargan hasta
  // que pasen 30 min o el usuario presione "Actualizar".
  // ════════════════════════════════════════════════════════
  var SUMI_CACHE = (function () {
    var PREFIX  = 'sc_api_';
    var TTL_MS  = 30 * 60 * 1000; // 30 minutos
    var _bypass = false;           // true solo durante refresh manual

    function _key(url) { return PREFIX + url; }

    function get(url) {
      if (_bypass) return null;
      try {
        var raw = localStorage.getItem(_key(url));
        if (!raw) return null;
        var entry = JSON.parse(raw);
        if (!entry || !entry.ts || !entry.data) return null;
        if (Date.now() - entry.ts > TTL_MS) return null; // expirado
        return entry.data;
      } catch (_) { return null; }
    }

    function set(url, data) {
      try {
        localStorage.setItem(_key(url), JSON.stringify({ ts: Date.now(), data: data }));
      } catch (_) {}
    }

    function getTs(url) {
      try {
        var raw = localStorage.getItem(_key(url));
        if (!raw) return null;
        var entry = JSON.parse(raw);
        return entry && entry.ts ? entry.ts : null;
      } catch (_) { return null; }
    }

    function clearAll() {
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.startsWith(PREFIX)) localStorage.removeItem(k);
        });
      } catch (_) {}
    }

    function setBypass(v) { _bypass = v; }
    function getTTL()     { return TTL_MS; }

    return { get: get, set: set, getTs: getTs, clearAll: clearAll, setBypass: setBypass, getTTL: getTTL };
  })();

  window.SUMI_CACHE = SUMI_CACHE; // exponer globalmente

  function bootApiCache() {
    if (window._sumiCacheInstalled) return;
    window._sumiCacheInstalled = true;

    var _origFetch = window.fetch;

    window.fetch = function (input, opts) {
      var url    = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      var method = (opts && opts.method ? opts.method : 'GET').toUpperCase();

      // Solo cachear GET a /api/
      if (method !== 'GET' || url.indexOf('/api/') === -1) {
        return _origFetch.apply(this, arguments);
      }

      // ¿Hay datos frescos en caché?
      var cached = SUMI_CACHE.get(url);
      if (cached !== null) {
        // Devolver respuesta inmediata desde caché
        var fakeResp = {
          ok: true,
          status: 200,
          statusText: 'OK (cached)',
          _fromCache: true,
          _cachedAt: SUMI_CACHE.getTs(url),
          json: function () { return Promise.resolve(cached); },
          text: function () { return Promise.resolve(JSON.stringify(cached)); },
          clone: function () { return this; }
        };
        return Promise.resolve(fakeResp);
      }

      // No hay caché — fetch real y guardar resultado
      return _origFetch.apply(this, arguments).then(function (resp) {
        if (!resp.ok) return resp;
        // Clonar para poder leer .json() y aún devolver el response original
        return resp.clone().json().then(function (data) {
          SUMI_CACHE.set(url, data);
          return resp;
        }).catch(function () { return resp; });
      });
    };

    // Botón "Actualizar" → limpiar caché + recargar datos
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('#ms-ref-btn, .ms-refresh-btn, [data-action="refresh"]');
      if (!btn) return;
      SUMI_CACHE.clearAll();
      SUMI_CACHE.setBypass(true);
      // Después del fetch manual, reactivar caché
      setTimeout(function () { SUMI_CACHE.setBypass(false); }, 8000);
    });

    // Mostrar en la barra de estado cuándo fue la última actualización real
    function patchRefreshStatus() {
      var statusEl = document.getElementById('ms-ref-status');
      if (!statusEl) return;

      // Buscar la entrada de caché más reciente entre las APIs comunes
      var commonApis = [
        '/api/ventas/resumen', '/api/cxc/resumen', '/api/inv/resumen',
        '/api/ventas/dia', '/api/cobradas/resumen', '/api/alertas/check'
      ];
      var base = (typeof window.__API_BASE === 'string') ? window.__API_BASE : '';
      var latestTs = null;
      commonApis.forEach(function (path) {
        var ts = SUMI_CACHE.getTs(base + path);
        if (ts && (!latestTs || ts > latestTs)) latestTs = ts;
      });

      if (latestTs) {
        var dt = new Date(latestTs);
        var fmt = dt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        statusEl.textContent = '✓ Actualizado: ' + fmt + ' (caché)';
        statusEl.className = 'ms-refresh-status ok';
      }
    }

    setTimeout(patchRefreshStatus, 400);
    setTimeout(patchRefreshStatus, 1500);
  }

  function bootAll() {
    bootApiCache();       // ← PRIMERO: intercepta fetch antes de que las páginas carguen datos
    bootDesignUpgrade();
    bootTiltEffect();
    bootAiMotion();
    bootManualRefreshBar();
    bootCursorGlow();
    bootKpiCountUp();
    setTimeout(bootAiProLauncher, 120);
    bootKeyboardShortcuts();
    bootMobile();
    bootThemeToggle();
    bootCommandPalette();
    bootOfflineBanner();
    bootPullToRefresh();
    bootBottomNav();
    // ── Premium v4 ──
    bootParticleNetwork();
    bootClickRipple();
    bootNumberScramble();
    // ── Premium v5 ──
    bootCustomCursor();
    bootMagneticEffect();
    bootPageTransitions();
    bootTopLoadingBar();
    // ── Premium v6 ──
    bootTooltip();
    bootScrollProgress();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAll);
  } else {
    bootAll();
  }

})();
