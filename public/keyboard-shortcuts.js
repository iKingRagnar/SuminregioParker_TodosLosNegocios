/**
 * keyboard-shortcuts.js — Accesos directos estilo Vim / Linear
 * g+v ventas · g+c cxc · g+i inventario · g+r resultados · g+d director
 * g+p comparar · / buscar · r refresh · ? ayuda
 */
(function () {
  'use strict';
  if (window.__sumiShortcutsMounted) return;
  window.__sumiShortcutsMounted = true;

  var MAP = {
    'g v': '/ventas.html',
    'g c': '/cxc.html',
    'g i': '/inventario.html',
    'g r': '/resultados.html',
    'g d': '/director.html',
    'g l': '/clientes.html',   // c ya está tomado por cxc → l de "lista"
    'g u': '/consumos.html',
    'g m': '/margen-producto.html',
    'g p': '/comparar.html',   // p de "parallel"
    'g h': '/index.html',
  };

  var buffer = '';
  var bufferTimer = null;

  function showToast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9998;' +
      'background:rgba(15,23,42,.92);color:#F5C33C;border-radius:10px;padding:8px 14px;' +
      'font-family:"DM Mono",monospace;font-size:.78rem;font-weight:600;' +
      'box-shadow:0 6px 24px -4px rgba(15,23,42,.3);pointer-events:none';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1200);
  }

  function showHelp() {
    if (document.getElementById('sumi-help-modal')) return;
    var m = document.createElement('div');
    m.id = 'sumi-help-modal';
    m.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.45);' +
      'backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px';
    m.innerHTML =
      '<div style="background:#fff;border-radius:18px;max-width:480px;width:100%;padding:22px 26px;box-shadow:0 30px 80px rgba(15,23,42,.3)">' +
      '<h3 style="margin:0 0 14px 0;color:#0F172A;font-weight:700">Atajos de teclado</h3>' +
      '<div style="display:grid;grid-template-columns:auto 1fr;gap:10px 18px;font-size:.85rem">' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">/ o ⌘K</kbd><span>Búsqueda global</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g h</kbd><span>Inicio</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g v</kbd><span>Ventas</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g c</kbd><span>CxC</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g i</kbd><span>Inventario</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g r</kbd><span>Resultados</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">g p</kbd><span>Comparar empresas</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">r</kbd><span>Recargar datos</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">?</kbd><span>Esta ayuda</span>' +
        '<kbd style="font-family:DM Mono,monospace;background:#F8FAFC;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:4px;padding:2px 8px;color:#475569">Esc</kbd><span>Cerrar modales</span>' +
      '</div>' +
      '<div style="margin-top:18px;text-align:right"><button onclick="this.closest(\'#sumi-help-modal\').remove()" style="background:linear-gradient(135deg,#F5C33C,#E6A800);color:#1A1200;border:none;padding:6px 14px;border-radius:8px;font-weight:600;cursor:pointer">Cerrar</button></div>' +
      '</div>';
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  }

  document.addEventListener('keydown', function (e) {
    // No interferir en inputs/textareas
    var tag = (e.target && e.target.tagName) || '';
    if (/input|textarea|select/i.test(tag)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '?') { e.preventDefault(); showHelp(); return; }
    if (e.key === 'Escape') {
      var h = document.getElementById('sumi-help-modal');
      if (h) h.remove();
    }
    if (e.key === 'r') {
      if (typeof window.clearApiCache === 'function') {
        window.clearApiCache();
        showToast('⟳ cache limpiado');
        setTimeout(function () { location.reload(); }, 300);
      } else {
        location.reload();
      }
      return;
    }

    // Combos "g X"
    if (/^[a-zA-Z]$/.test(e.key)) {
      buffer += e.key.toLowerCase();
      if (buffer.length > 3) buffer = buffer.slice(-3);
      clearTimeout(bufferTimer);
      bufferTimer = setTimeout(function () { buffer = ''; }, 800);

      var match = null;
      for (var k in MAP) if (MAP.hasOwnProperty(k) && (k.replace(/\s+/g, '') === buffer.replace(/\s+/g, ''))) { match = MAP[k]; break; }
      if (match) {
        buffer = '';
        clearTimeout(bufferTimer);
        showToast('→ ' + match.replace(/^\/|\.html$/g, ''));
        setTimeout(function () { window.location.href = match; }, 150);
      }
    }
  });

  // Ayuda visible una vez por sesión si es nuevo
  try {
    if (!sessionStorage.getItem('sumi_shortcuts_seen')) {
      sessionStorage.setItem('sumi_shortcuts_seen', '1');
      // Cartel compacto
      setTimeout(function () {
        var hint = document.createElement('div');
        hint.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9997;' +
          'background:#fff;border:1px solid rgba(230,168,0,.3);padding:10px 14px;border-radius:12px;' +
          'font-size:.75rem;color:#475569;box-shadow:0 6px 20px -4px rgba(15,23,42,.12);max-width:240px;' +
          'animation:sumiHintIn .3s ease';
        hint.innerHTML = '💡 Pulsa <kbd style="background:#F8FAFC;border:1px solid #E2E8F0;padding:1px 6px;border-radius:4px;font-family:DM Mono,monospace">?</kbd> para ver atajos de teclado';
        document.body.appendChild(hint);
        setTimeout(function () { hint.style.opacity = '0'; hint.style.transition = 'opacity .5s ease'; }, 6000);
        setTimeout(function () { hint.remove(); }, 7000);
      }, 2500);
    }
  } catch (_) {}
})();
