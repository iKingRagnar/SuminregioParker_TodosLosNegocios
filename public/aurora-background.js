/**
 * aurora-background.js — Fondo aurora interactivo con parallax de mouse
 * ──────────────────────────────────────────────────────────────────────────────
 * Inspirado en la landing de Google Antigravity: blobs de color con blur pesado
 * que se desplazan suavemente siguiendo al cursor, con easing.
 *
 * Características:
 *   · 5 blobs con la paleta Suminregio (oro, azul noche, cyan eléctrico, púrpura)
 *   · Parallax de mouse con easing (requestAnimationFrame, sin jank)
 *   · Respeta prefers-reduced-motion (se detiene la animación)
 *   · Rotación lenta ambient cuando el mouse no se mueve
 *   · Capa fija detrás de todo (z-index: -1), pointer-events: none
 *   · Se auto-monta al cargar — no requiere HTML explícito
 */
(function () {
  'use strict';

  if (window.__vpAuroraMounted) return;
  window.__vpAuroraMounted = true;

  var prefersReduced = false;
  try {
    prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {}

  // Paleta — colores pertinentes al proyecto
  var BLOBS = [
    { color: 'rgba(230, 168, 0, 0.42)',   size: 620, ax: 0.14, ay: 0.10, bx: 22, by: 18 },  // oro grande (top-left)
    { color: 'rgba(230, 168, 0, 0.26)',   size: 420, ax: 0.80, ay: 0.72, bx: 85, by: 72 },  // oro pequeño (bot-right)
    { color: 'rgba(64, 150, 255, 0.38)',  size: 540, ax: 0.75, ay: 0.18, bx: 72, by: 22 },  // azul eléctrico (top-right)
    { color: 'rgba(139, 92, 246, 0.30)',  size: 460, ax: 0.20, ay: 0.78, bx: 30, by: 80 },  // púrpura (bot-left)
    { color: 'rgba(20, 184, 166, 0.22)',  size: 380, ax: 0.50, ay: 0.48, bx: 50, by: 50 },  // teal (centro)
  ];

  // ── Inyectar estilos base ───────────────────────────────────────────────────
  var css = [
    '#vp-aurora-root{',
      'position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;',
      'background:',
        'radial-gradient(ellipse at 50% -20%, rgba(230,168,0,.04) 0%, transparent 50%),',
        '#0B1629;',
    '}',
    '#vp-aurora-root .vp-blob{',
      'position:absolute;border-radius:50%;',
      'filter:blur(90px);',
      'will-change:transform;',
      'transition:transform 1.4s cubic-bezier(.22,1,.36,1);',
      'mix-blend-mode:screen;',
    '}',
    '#vp-aurora-root .vp-noise{',
      'position:absolute;inset:-100px;',
      'background-image:url("data:image/svg+xml;utf8,',
        '<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22>',
          '<filter id=%22n%22><feTurbulence type=%22fractalNoise%22 baseFrequency=%22.9%22 numOctaves=%222%22 stitchTiles=%22stitch%22/>',
          '<feColorMatrix values=%220 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .08 0%22/></filter>',
          '<rect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23n)%22/>',
        '</svg>");',
      'opacity:.45;pointer-events:none;',
    '}',
    '@media (prefers-reduced-motion: reduce){',
      '#vp-aurora-root .vp-blob{transition:none !important;}',
    '}',
  ].join('');

  var style = document.createElement('style');
  style.id = 'vp-aurora-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // ── Construir el DOM ────────────────────────────────────────────────────────
  function mount() {
    if (document.getElementById('vp-aurora-root')) return;

    var root = document.createElement('div');
    root.id = 'vp-aurora-root';
    root.setAttribute('aria-hidden', 'true');

    var blobEls = BLOBS.map(function (b, i) {
      var el = document.createElement('div');
      el.className = 'vp-blob';
      el.style.width  = b.size + 'px';
      el.style.height = b.size + 'px';
      el.style.left   = 'calc(' + b.bx + '% - ' + (b.size / 2) + 'px)';
      el.style.top    = 'calc(' + b.by + '% - ' + (b.size / 2) + 'px)';
      el.style.background = 'radial-gradient(circle, ' + b.color + ' 0%, transparent 70%)';
      el.dataset.ax = b.ax;
      el.dataset.ay = b.ay;
      root.appendChild(el);
      return el;
    });

    var noise = document.createElement('div');
    noise.className = 'vp-noise';
    root.appendChild(noise);

    // Insertar como primer hijo del body para que quede detrás de todo
    if (document.body.firstChild) {
      document.body.insertBefore(root, document.body.firstChild);
    } else {
      document.body.appendChild(root);
    }

    // ── Parallax con easing ──────────────────────────────────────────────────
    var mouseX = window.innerWidth  / 2;
    var mouseY = window.innerHeight / 2;
    var curX   = mouseX;
    var curY   = mouseY;
    var t0     = performance.now();
    var lastMove = t0;
    var ticking = false;

    function onPointer(e) {
      var ev = e.touches ? e.touches[0] : e;
      mouseX = ev.clientX;
      mouseY = ev.clientY;
      lastMove = performance.now();
      if (!ticking && !prefersReduced) {
        ticking = true;
        requestAnimationFrame(tick);
      }
    }

    function tick(now) {
      // Easing: ~6% por frame hacia el target del mouse
      curX += (mouseX - curX) * 0.06;
      curY += (mouseY - curY) * 0.06;

      var w = window.innerWidth  || 1;
      var h = window.innerHeight || 1;
      // Centro normalizado en -0.5 → +0.5
      var cx = (curX / w) - 0.5;
      var cy = (curY / h) - 0.5;

      // Ambient drift cuando no hay input: sinusoidal lento
      var elapsed = (now - t0) / 1000;
      var idle = (now - lastMove) > 1400;
      var driftX = idle ? Math.sin(elapsed * 0.18) * 0.18 : 0;
      var driftY = idle ? Math.cos(elapsed * 0.22) * 0.14 : 0;

      for (var i = 0; i < blobEls.length; i++) {
        var el = blobEls[i];
        var ax = parseFloat(el.dataset.ax) || 0.5;
        var ay = parseFloat(el.dataset.ay) || 0.5;
        // Cada blob tiene su propia amplitud de parallax (más grande = se mueve más)
        var amp = 90 + (ax + ay) * 70; // 90-230 px
        var tx = (cx + driftX) * amp * (ax < 0.5 ? -1.2 : 1);
        var ty = (cy + driftY) * amp * (ay < 0.5 ? -1 : 1.2);
        el.style.transform = 'translate3d(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px,0)';
      }

      // Seguir animando mientras haya movimiento residual o ambient drift
      var stillMoving = Math.abs(mouseX - curX) > 0.3 || Math.abs(mouseY - curY) > 0.3;
      if (stillMoving || idle) {
        requestAnimationFrame(tick);
      } else {
        ticking = false;
      }
    }

    // Arranque: una pasada para que los blobs queden centrados con transform
    requestAnimationFrame(tick);

    if (!prefersReduced) {
      window.addEventListener('mousemove',   onPointer, { passive: true });
      window.addEventListener('touchmove',   onPointer, { passive: true });
      window.addEventListener('resize', function () { mouseX = window.innerWidth / 2; mouseY = window.innerHeight / 2; }, { passive: true });

      // Ambient tick cada pocos segundos si el usuario no mueve el mouse
      setInterval(function () {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(tick);
        }
      }, 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
