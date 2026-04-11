/**
 * app-ui-boot.js — capa IA: partículas + revelado al scroll (IntersectionObserver).
 * Barra de refresco manual + estado (Cargando / Last refresh succeeded at).
 * Se carga con defer en las páginas que enlazan app-ui.css.
 */
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

  function bootAll() {
    bootAiMotion();
    bootManualRefreshBar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootAll);
  } else {
    bootAll();
  }
})();
