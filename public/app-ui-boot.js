/**
 * app-ui-boot.js — capa IA: partículas + revelado al scroll (IntersectionObserver).
 * Se carga con defer en las páginas que enlazan app-ui.css.
 */
(function () {
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootAiMotion);
  } else {
    bootAiMotion();
  }
})();
