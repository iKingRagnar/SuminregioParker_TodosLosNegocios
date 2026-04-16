/**
 * app-ui-boot.js — capa IA: partículas + revelado al scroll (IntersectionObserver).
 * Barra de refresco manual + estado (Cargando / Last refresh succeeded at).
 * Se carga con defer en las páginas que enlazan app-ui.css.
 */

// ── Inyectar data-cache.js antes que cualquier otra lógica ───────────────────
(function injectDataCache() {
  if (typeof window.__sumiCache !== 'undefined') return; // ya cargado
  var s = document.createElement('script');
  var base = (typeof window.__API_BASE === 'string' && window.__API_BASE) ? window.__API_BASE : '';
  s.src = base + '/data-cache.js';
  s.async = false; // síncrono para que intercepte fetch antes del DOMContentLoaded
  document.head.appendChild(s);
})();

(function () {
  function injectManualRefreshStyles() {
    if (typeof document === "undefined" || document.getElementById("ms-refresh-bar-styles")) return;
    var s = document.createElement("style");
    s.id = "ms-refresh-bar-styles";
    s.textContent =
      ".ms-refresh-bar{position:sticky;top:0;z-index:99999;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%;padding:8px 14px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:12px;line-height:1.35;background:linear-gradient(90deg,#0f172a 0%,#1e293b 100%);color:#e2e8f0;border-bottom:1px solid rgba(148,163,184,.35);box-shadow:0 2px 14px rgba(0,0,0,.22)}" +
      ".ms-refresh-inner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;width:100%;max-width:1400px;margin:0 auto}" +
      ".ms-refresh-btn{cursor:pointer;font:inherit;font-weight:600;padding:6px 14px;border-radius:8px;border:1px solid rgba(148,163,184,.45);background:rgba(255,255,255,.08);color:#f8fafc;transition:background .15s,border-color .15s}" +
      ".ms-refresh-btn:hover:not(:disabled){background:rgba(255,255,255,.14);border-color:rgba(226,232,240,.55)}" +
      ".ms-refresh-btn:disabled{opacity:.55;cursor:not-allowed}" +
      ".ms-refresh-status{flex:1;min-width:0;word-break:break-word}" +
      ".ms-refresh-status.loading{color:#fbbf24}" +
      ".ms-refresh-status.ok{color:#4ade80}" +
      ".ms-refresh-status.err{color:#f87171}" +
      "@media print{.ms-refresh-bar{display:none!important}}";
    document.head.appendChild(s);
  }

  function bootManualRefreshBar() {
    if (typeof document === "undefined" || !document.body) return;
    injectManualRefreshStyles();

    var bar = document.createElement("div");
    bar.className = "ms-refresh-bar";
    bar.setAttribute("role", "region");
    bar.setAttribute("aria-label", "Actualización de datos");
    bar.innerHTML =
      '<div class="ms-refresh-inner">' +
      '<button type="button" class="ms-refresh-btn">Actualizar datos</button>' +
      '<span class="ms-refresh-status loading">Cargando…</span>' +
      "</div>";

    document.body.insertBefore(bar, document.body.firstChild);

    var statusEl = bar.querySelector(".ms-refresh-status");
    var btn = bar.querySelector(".ms-refresh-btn");

    function fmt(dt) {
      try {
        return dt.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "medium" });
      } catch (e) {
        return String(dt);
      }
    }

    function setLoading() {
      statusEl.textContent = "Cargando…";
      statusEl.className = "ms-refresh-status loading";
      btn.disabled = true;
    }

    function setSuccess() {
      var now = new Date();
      statusEl.textContent = "Last refresh succeeded at: " + fmt(now);
      statusEl.className = "ms-refresh-status ok";
      btn.disabled = false;
    }

    btn.addEventListener("click", function () {
      setLoading();
      window.location.reload();
    });

    window.addEventListener("load", function () {
      if (!window.__manualRefreshDeferSuccess) {
        setSuccess();
      }
    });

    window.addEventListener("pageshow", function (ev) {
      if (ev.persisted && !window.__manualRefreshDeferSuccess) {
        setSuccess();
      }
    });

    window.markManualRefreshComplete = function () {
      setSuccess();
    };

    if (document.readyState === "complete" && !window.__manualRefreshDeferSuccess) {
      setSuccess();
    }

    applyRefreshBarStickyOffset(bar);
  }

  /** Evita que header sticky (top:0) quede bajo .ms-refresh-bar (mismo top:0, z-index mayor) y bloquee toques en el nav. */
  function applyRefreshBarStickyOffset(barEl) {
    if (typeof document === "undefined" || !barEl) return;
    function push() {
      try {
        var h = barEl.offsetHeight || 0;
        document.documentElement.style.setProperty("--ms-sticky-top", h + "px");
        // #region agent log
        fetch("http://127.0.0.1:7807/ingest/dccd4d73-a0a8-497c-b252-2fef711ed56a", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c5910b" },
          body: JSON.stringify({
            sessionId: "c5910b",
            location: "app-ui-boot.js:applyRefreshBarStickyOffset",
            message: "refresh bar height -> --ms-sticky-top",
            data: { barHeight: h, href: typeof location !== "undefined" ? String(location.pathname || "") : "" },
            timestamp: Date.now(),
            hypothesisId: "H-sticky-overlap",
          }),
        }).catch(function () {});
        // #endregion
      } catch (_) {}
    }
    push();
    if (typeof window !== "undefined") {
      window.addEventListener("resize", push, { passive: true });
      window.addEventListener("orientationchange", push, { passive: true });
    }
    if (typeof ResizeObserver !== "undefined") {
      try {
        var ro = new ResizeObserver(function () {
          push();
        });
        ro.observe(barEl);
      } catch (_) {}
    }
    if (typeof window !== "undefined") {
      window.addEventListener(
        "load",
        function () {
          push();
        },
        { passive: true }
      );
    }
  }

  function bootAiMotion() {
    if (typeof document === "undefined" || !document.body) return;

    var spark = document.createElement("div");
    spark.className = "ms-ai-sparkle";
    spark.setAttribute("aria-hidden", "true");
    document.body.insertBefore(spark, document.body.firstChild);

    var reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    var selectors = [
      ".page > .hero",
      ".page > .page-header",
      ".page > #filter-bar",
      ".page > .biz-context-bar",
      ".page > .source-tabs",
      ".page > .ms-ai-page-banner",
      ".page > .exec-mission",
      ".page > .intel-bar",
      ".uni-portfolio",
      ".kpi-mega-grid .kpi-card",
      ".kpi-grid .kpi-card",
      ".scorecard-wrap",
      ".section-divider",
      ".modules-grid .module-card",
      ".secondary-grid > .card",
      ".page > .grid-2",
      ".page > .card",
      ".page .grid .card",
      ".page > .section-title",
      ".page > .grid",
      /* Dashboards Microsip (.dash) */
      ".dash > .hdr",
      ".dash > .kpi-row",
      ".dash > .kpi-panel",
      ".dash > .chart-section",
      ".dash > .charts-grid",
      ".dash > .row-2",
      ".dash .kpi-row .kpi",
      ".dash .ccard",
      ".dash .tcard",
      /* CxC (main sin .page) */
      "main > .cxc-hero",
      "main > .cxc-kpi-journey",
      "main > #filter-bar",
      "main > .client-filter-bar",
      "main > .kpi-grid",
      "main > .aging-grid",
      "main > .tabs",
      "main > .card",
      "main > .grid-2",
      "main > .grid-32",
    ];

    var seen = new Set();
    var els = [];
    selectors.forEach(function (sel) {
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          if (seen.has(el)) return;
          seen.add(el);
          el.classList.add("ms-reveal");
          els.push(el);
        });
      } catch (_) {}
    });

    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("ms-inview");
            io.unobserve(en.target);
          }
        });
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 }
    );

    els.forEach(function (el) {
      io.observe(el);
    });

    requestAnimationFrame(function () {
      document.querySelectorAll(".hero--ai, .page > .hero.ms-reveal").forEach(function (el) {
        el.classList.add("ms-inview");
      });
    });

    setTimeout(function () {
      document.querySelectorAll(".ms-reveal:not(.ms-inview)").forEach(function (el) {
        el.classList.add("ms-inview");
      });
    }, 2800);
  }

  function bootNavTapDebug() {
    var done = false;
    document.addEventListener(
      "click",
      function (ev) {
        if (done) return;
        var el = ev.target && ev.target.closest && ev.target.closest("header nav a.nav-link, #main-nav a.nav-link");
        if (!el || !el.getAttribute) return;
        done = true;
        // #region agent log
        fetch("http://127.0.0.1:7807/ingest/dccd4d73-a0a8-497c-b252-2fef711ed56a", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c5910b" },
          body: JSON.stringify({
            sessionId: "c5910b",
            location: "app-ui-boot.js:nav-link-click",
            message: "first nav link click",
            data: { href: String(el.getAttribute("href") || "") },
            timestamp: Date.now(),
            hypothesisId: "H-nav-tap",
          }),
        }).catch(function () {});
        // #endregion
      },
      true
    );
  }

  /** Inyecta un botón "IA Pro" en el nav para abrir el Asistente IA avanzado */
  function bootAiProLauncher() {
    if (typeof document === 'undefined') return;
    var nav = document.querySelector('header nav.hdr-nav, header .hdr-nav, nav#main-nav');
    if (!nav || document.getElementById('sumi-ai-pro-btn')) return;

    // URL configurable: window.__ASISTENTE_AI_URL o localhost por defecto
    var aiUrl = (typeof window.__ASISTENTE_AI_URL === 'string' && window.__ASISTENTE_AI_URL)
      ? window.__ASISTENTE_AI_URL
      : 'http://localhost:5173';

    var btn = document.createElement('a');
    btn.id = 'sumi-ai-pro-btn';
    btn.href = aiUrl;
    btn.target = '_blank';
    btn.rel = 'noopener';
    btn.setAttribute('aria-label', 'Abrir Asistente IA Pro');
    btn.innerHTML =
      '<span style="font-size:13px;margin-right:4px">✦</span>' +
      'IA Pro';
    btn.style.cssText =
      'display:inline-flex;align-items:center;gap:2px;' +
      'background:linear-gradient(135deg,#E6A800,#B87D00);' +
      'color:#060E1A!important;font-weight:700;font-size:11px;' +
      'padding:5px 10px;border-radius:20px;letter-spacing:.04em;' +
      'border:none!important;text-decoration:none;white-space:nowrap;' +
      'box-shadow:0 2px 12px rgba(230,168,0,.35);' +
      'transition:transform .15s,box-shadow .15s;cursor:pointer;';
    btn.addEventListener('mouseenter', function() {
      btn.style.transform = 'translateY(-1px)';
      btn.style.boxShadow = '0 4px 20px rgba(230,168,0,.55)';
    });
    btn.addEventListener('mouseleave', function() {
      btn.style.transform = '';
      btn.style.boxShadow = '0 2px 12px rgba(230,168,0,.35)';
    });

    nav.appendChild(btn);
  }

  function bootAll() {
    bootAiMotion();
    bootManualRefreshBar();
    bootNavTapDebug();
    // Intentar inyectar el launcher después del DOM listo
    setTimeout(bootAiProLauncher, 100);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootAll);
  } else {
    bootAll();
  }
})();
