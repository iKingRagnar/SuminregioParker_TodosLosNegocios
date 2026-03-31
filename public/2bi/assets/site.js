(function () {
  "use strict";

  var nav = document.querySelector(".bi-nav");
  var toggle = document.querySelector(".bi-nav-toggle");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", nav.classList.contains("is-open"));
    });
    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* Ticker: duplicar primera fila para loop seamless */
  document.querySelectorAll("[data-ticker]").forEach(function (el) {
    var inner = el.querySelector(".ticker-inner");
    if (!inner) return;
    var track = inner.querySelector(".ticker-track");
    if (!track || inner.children.length > 1) return;
    var clone = track.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    inner.appendChild(clone);
  });

  /* Scroll reveal */
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".reveal").forEach(function (el) {
      el.classList.add("is-visible");
    });
    return;
  }

  var reveals = document.querySelectorAll(".reveal");
  if (!reveals.length) return;

  if (!("IntersectionObserver" in window)) {
    reveals.forEach(function (el) {
      el.classList.add("is-visible");
    });
    return;
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          io.unobserve(e.target);
        }
      });
    },
    { rootMargin: "0px 0px -6% 0px", threshold: 0.06 }
  );

  reveals.forEach(function (el) {
    io.observe(el);
  });
})();
