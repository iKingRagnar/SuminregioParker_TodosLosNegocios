/**
 * tour-guide.js — Intro tour para usuarios nuevos (una sola vez)
 * Destaca cada módulo con tooltip. Se salta con Esc o X.
 */
(function () {
  'use strict';
  try { if (localStorage.getItem('sumi_tour_done')) return; } catch (_) {}
  if (!/index\.html$|^\/$/.test(location.pathname)) return;
  if (window.__sumiTour) return;
  window.__sumiTour = true;

  const STEPS = [
    { title: '¡Bienvenido!', body: 'Este es tu dashboard Suminregio con datos en tiempo real. Te muestro qué hay en cada módulo.', target: null },
    { title: 'Navegación',    body: 'En la barra superior tienes los 10 módulos. Prueba con <kbd>g v</kbd> para ventas o <kbd>⌘K</kbd> para búsqueda global.', target: '#app-header nav' },
    { title: 'Atajos',        body: 'Pulsa <kbd>?</kbd> en cualquier momento para ver todos los atajos de teclado.', target: null },
    { title: 'Comparar',      body: 'Nuevo: ve todas las empresas lado a lado en <strong>Comparar</strong>.', target: 'a[href*="comparar"]' },
    { title: 'Exportar',      body: 'Cada card con tabla tiene botones 📊 CSV y 📄 PDF arriba a la derecha.', target: null },
    { title: 'Notas',         body: 'Cada KPI tiene 💬 para agregar contexto. Se guarda en tu navegador.', target: null },
    { title: 'Listo 🎉',       body: 'Explora. Si algo se ve raro, recarga con <kbd>R</kbd> o mándame feedback.', target: null },
  ];

  let idx = 0;

  const backdrop = document.createElement('div');
  backdrop.id = 'sumi-tour-backdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(15,23,42,.35);backdrop-filter:blur(2px)';

  const pop = document.createElement('div');
  pop.id = 'sumi-tour-pop';
  pop.style.cssText = 'position:fixed;z-index:9999;background:#fff;border:1px solid rgba(230,168,0,.3);border-radius:16px;padding:22px 24px;max-width:340px;box-shadow:0 20px 60px -10px rgba(15,23,42,.3);font-family:inherit;color:#0F172A';

  function render() {
    const s = STEPS[idx];
    pop.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<span style="font-size:.7rem;color:#94A3B8;font-family:DM Mono,monospace">' + (idx + 1) + '/' + STEPS.length + '</span>' +
        '<button id="t-close" style="background:none;border:none;color:#94A3B8;font-size:1.2rem;cursor:pointer;padding:0">✕</button>' +
      '</div>' +
      '<h3 style="margin:0 0 8px 0;color:#0F172A;font-weight:700">' + s.title + '</h3>' +
      '<div style="font-size:.88rem;color:#475569;line-height:1.5">' + s.body + '</div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:16px;gap:8px">' +
        '<button id="t-skip" style="background:none;border:none;color:#94A3B8;font-size:.78rem;cursor:pointer">Saltar</button>' +
        '<button id="t-next" style="background:linear-gradient(135deg,#F5C33C,#E6A800);color:#1A1200;border:none;padding:7px 18px;border-radius:8px;font-weight:600;cursor:pointer;font-size:.85rem">' + (idx === STEPS.length - 1 ? 'Cerrar' : 'Siguiente') + '</button>' +
      '</div>';

    // Posicionar relativo al target
    let rect = { top: window.innerHeight / 2 - 80, left: window.innerWidth / 2 - 170 };
    if (s.target) {
      const el = document.querySelector(s.target);
      if (el) {
        const r = el.getBoundingClientRect();
        rect = { top: Math.min(window.innerHeight - 280, r.bottom + 12), left: Math.max(16, r.left) };
        // Resaltar target
        el.style.outline = '2px solid #E6A800';
        el.style.outlineOffset = '4px';
        el.style.borderRadius = '8px';
        el.style.transition = 'outline .2s ease';
      }
    } else {
      rect = { top: window.innerHeight / 2 - 100, left: window.innerWidth / 2 - 170 };
    }
    pop.style.top = rect.top + 'px';
    pop.style.left = rect.left + 'px';

    document.getElementById('t-close').onclick = done;
    document.getElementById('t-skip').onclick  = done;
    document.getElementById('t-next').onclick  = advance;
  }

  function clearHighlights() {
    document.querySelectorAll('[style*="outline: 2px solid"]').forEach((el) => {
      if (el === pop) return;
      el.style.outline = ''; el.style.outlineOffset = '';
    });
  }

  function advance() {
    clearHighlights();
    idx++;
    if (idx >= STEPS.length) { done(); return; }
    render();
  }

  function done() {
    clearHighlights();
    backdrop.remove();
    pop.remove();
    try { localStorage.setItem('sumi_tour_done', '1'); } catch (_) {}
  }

  function start() {
    document.body.appendChild(backdrop);
    document.body.appendChild(pop);
    render();
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { done(); document.removeEventListener('keydown', onKey); }
    });
  }

  setTimeout(start, 1500);
  window.SumiTour = { restart: function () { try { localStorage.removeItem('sumi_tour_done'); } catch (_) {} location.reload(); } };
})();
