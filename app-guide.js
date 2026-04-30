/**
 * Tour por el menú principal + panel de avisos (campana).
 * Carga desde nav.js; requiere data-app-tour en cada .nav-link.
 */
(function () {
  var LS_TOUR = 'microsip_tour_done_v1';
  var LS_NOTIF = 'microsip_notif_read_v1';

  var TOUR_BLUEPRINT = [
    {
      href: null,
      title: 'Bienvenida',
      body: 'Aquí tienes el menú principal del panel. Puedes cambiar de módulo en cualquier momento; el negocio seleccionado y el periodo se conservan al navegar cuando aplica.'
    },
    {
      href: 'index.html',
      title: 'Inicio',
      body: 'Vista general del negocio: scorecard, alertas y, si tienes varias bases, el universo multi-empresa.'
    },
    {
      href: 'director.html',
      title: 'Director',
      body: 'Vista de dirección: ventas vs meta, salud de cartera (CxC), tendencia diaria VE+PV, ranking de vendedores y clientes. Pensada para comités rápidos y seguimiento de riesgo.'
    },
    {
      href: 'ventas.html',
      title: 'Ventas',
      body: 'Análisis de facturación VE/PV, tendencias y detalle por periodo.'
    },
    {
      href: 'consumos.html',
      title: 'Consumos',
      body: 'Consumo en unidades para compras y almacén: ritmo, concentración, cobertura vs existencia y riesgo de quiebre.'
    },
    {
      href: 'cobradas.html',
      title: 'Cobradas',
      body: 'Documentos cobrados y flujo de efectivo cobrado.'
    },
    {
      href: 'vendedores.html',
      title: 'Vendedores',
      body: 'Desempeño por vendedor y comparativos.'
    },
    {
      href: 'cxc.html',
      title: 'CxC',
      body: 'Cuentas por cobrar: saldos, vencidos, condiciones y antigüedad.'
    },
    {
      href: 'clientes.html',
      title: 'Clientes',
      body: 'Cartera de clientes y consulta operativa.'
    },
    {
      href: 'inventario.html',
      title: 'Inventario',
      body: 'Existencias, mínimos y alertas de stock.'
    },
    {
      href: 'resultados.html',
      title: 'Finanzas',
      body: 'Estado de resultados y métricas financieras del periodo.'
    }
  ];

  var NOTIF_ITEMS = [
    {
      id: 'n-empresa',
      title: 'Selector de empresa',
      body: 'Si hay varias bases Firebird, usa la barra "Negocio" bajo el menú para cambiar de empresa; la URL lleva ?db= para compartir el contexto.',
      t: 1
    },
    {
      id: 'n-filtros',
      title: 'Filtros de periodo',
      body: 'Los botones Hoy, Semana, Mes, etc. suelen aplicar a los datos de la página actual. Revisa siempre la barra gris de filtros.',
      t: 2
    },
    {
      id: 'n-ia',
      title: 'Asistente (robot)',
      body: 'El botón flotante abre el agente de soporte: preguntas sobre ventas, CxC y cotizaciones cuando está configurada la API.',
      t: 3
    },
    {
      id: 'n-tour',
      title: 'Volver a ver el tour',
      body: 'Pulsa el icono de mapa en la barra superior para repetir esta guía cuando quieras.',
      t: 4
    }
  ];

  function readReadSet() {
    try {
      var j = localStorage.getItem(LS_NOTIF);
      if (!j) return {};
      var o = JSON.parse(j);
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function writeReadSet(obj) {
    try {
      localStorage.setItem(LS_NOTIF, JSON.stringify(obj));
    } catch (_) {}
  }

  function injectGuideCSS() {
    if (document.getElementById('app-guide-styles')) return;
    var st = document.createElement('style');
    st.id = 'app-guide-styles';
    st.textContent =
      '.nav-aux-wrap{display:flex;align-items:center;gap:.35rem;flex-shrink:0}' +
      '.nav-aux-btn{' +
      'position:relative;display:grid;place-items:center;width:36px;height:36px;border-radius:9px;' +
      'border:1px solid var(--border2,rgba(255,255,255,.12));background:rgba(255,255,255,.04);' +
      'color:var(--text2,#93B4CC);cursor:pointer;transition:background .15s,border-color .15s,color .15s' +
      '}' +
      '.nav-aux-btn:hover{color:var(--text,#EDF4FF);background:var(--s2,#112233);border-color:rgba(245,124,0,.3)}' +
      '.nav-aux-btn svg{width:18px;height:18px}' +
      '.nav-aux-btn.pulse-ring{animation:navAuxPulse 2.2s ease-in-out infinite}' +
      '@keyframes navAuxPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,124,0,.35)}50%{box-shadow:0 0 0 6px rgba(245,124,0,0)}}' +
      '.app-notif-badge{position:absolute;top:4px;right:4px;min-width:16px;height:16px;padding:0 4px;border-radius:99px;' +
      'font-size:9px;font-weight:700;line-height:16px;text-align:center;background:var(--red,#E63946);color:#fff}' +
      '.app-notif-badge.hidden{display:none!important}' +
      '.app-notif-panel{position:fixed;z-index:10050;width:min(360px,calc(100vw - 1.5rem));max-height:min(420px,70vh);' +
      'overflow:auto;background:rgba(10,18,30,.97);border:1px solid var(--border2,rgba(255,255,255,.12));' +
      'border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);backdrop-filter:blur(12px)}' +
      '.app-notif-panel.hidden{display:none!important}' +
      '.app-notif-head{padding:12px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));' +
      'font-size:.72rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#4D6E8A)}' +
      '.app-notif-item{padding:11px 14px;border-bottom:1px solid var(--border,rgba(255,255,255,.06));cursor:pointer;transition:background .12s}' +
      '.app-notif-item:hover{background:rgba(255,255,255,.04)}' +
      '.app-notif-item.unread{border-left:3px solid var(--orange,#F57C00)}' +
      '.app-notif-item .nti{font-size:.82rem;font-weight:600;color:var(--text,#EDF4FF);margin-bottom:4px}' +
      '.app-notif-item .ntb{font-size:.72rem;color:var(--text2,#93B4CC);line-height:1.45}' +
      '.app-notif-foot{padding:10px 14px;display:flex;justify-content:flex-end;gap:8px}' +
      '.app-notif-foot button{font-family:inherit;font-size:.68rem;padding:6px 12px;border-radius:8px;' +
      'border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer}' +
      '.app-notif-foot button:hover{border-color:var(--orange);color:var(--orange)}' +
      '.app-tour-root{position:fixed;inset:0;z-index:10040}' +
      '.app-tour-root.hidden{display:none!important}' +
      '.app-tour-backdrop{position:absolute;inset:0;background:rgba(4,8,16,.82);backdrop-filter:blur(2px)}' +
      '@keyframes appTourIn{from{opacity:0;transform:translateX(-50%) translateY(16px) scale(.98)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}' +
      '.app-tour-popover{position:absolute;left:50%;bottom:max(12%,80px);transform:translateX(-50%);' +
      'width:min(420px,calc(100vw - 2rem));padding:0;border-radius:18px;overflow:hidden;' +
      'background:linear-gradient(165deg,rgba(18,32,52,.98) 0%,rgba(10,18,30,.99) 100%);' +
      'border:1px solid rgba(255,255,255,.1);' +
      'box-shadow:0 28px 80px rgba(0,0,0,.55),0 0 0 1px rgba(245,124,0,.08) inset;' +
      'animation:appTourIn .45s cubic-bezier(.22,1,.36,1) both}' +
      '.app-tour-accent{height:4px;background:linear-gradient(90deg,#f57c00,#ffb800,#1e7fd9,#00e5a0);opacity:.95}' +
      '.app-tour-progress-track{height:3px;background:rgba(255,255,255,.06);margin:0}' +
      '.app-tour-progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#f57c00,#ffb800);transition:width .35s ease}' +
      '.app-tour-popover-inner{padding:1.15rem 1.25rem 1.1rem}' +
      '.app-tour-popover h3{margin:0 0 .55rem;font-size:1.05rem;font-weight:800;letter-spacing:-.02em;color:var(--text,#EDF4FF)}' +
      '.app-tour-popover p{margin:0 0 1rem;font-size:.82rem;line-height:1.6;color:var(--text2,#93B4CC)}' +
      '.app-tour-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center}' +
      '.app-tour-actions button{font-family:inherit;font-size:.74rem;padding:.45rem .85rem;border-radius:8px;cursor:pointer;border:1px solid var(--border2);background:transparent;color:var(--text2)}' +
      '.app-tour-actions button.primary{background:var(--orange,#F57C00);border-color:var(--orange);color:#0a0f16;font-weight:600}' +
      '.app-tour-actions button:hover{filter:brightness(1.08)}' +
      '.app-tour-progress{font-size:.62rem;color:var(--muted);margin-top:.85rem;font-family:ui-monospace,monospace}' +
      'html[data-theme=light] .app-tour-backdrop{background:rgba(248,250,252,.93)}' +
      'html[data-theme=light] .app-tour-popover{background:#fff;border-color:rgba(15,23,42,.12);box-shadow:0 28px 80px rgba(15,23,42,.12)}' +
      'html[data-theme=light] .app-tour-popover h3{color:#0f172a}' +
      'html[data-theme=light] .app-tour-popover p{color:#475569}' +
      'html[data-theme=light] .app-tour-actions button{color:#334155;border-color:rgba(15,23,42,.15);background:rgba(15,23,42,.04)}' +
      'html[data-theme=light] .app-tour-actions button.primary{color:#0a0f16}' +
      'html[data-theme=light] .app-tour-progress{color:#64748b}' +
      'html[data-theme=light] .app-tour-progress-track{background:rgba(15,23,42,.08)}' +
      'a.nav-link.app-tour-highlight{position:relative;z-index:10045;outline:2px solid var(--orange,#F57C00);outline-offset:3px;border-radius:8px;box-shadow:0 0 0 4px rgba(245,124,0,.2)}' +
      '.app-shortcuts-root{position:fixed;inset:0;z-index:10038;display:flex;align-items:center;justify-content:center;padding:1rem}' +
      '.app-shortcuts-root.hidden{display:none!important}' +
      '.app-shortcuts-backdrop{position:absolute;inset:0;background:rgba(4,8,16,.75);backdrop-filter:blur(2px)}' +
      'html[data-theme=light] .app-shortcuts-backdrop{background:rgba(240,244,250,.85)}' +
      '.app-shortcuts-dialog{position:relative;z-index:1;width:min(440px,calc(100vw - 2rem));max-height:min(72vh,540px);overflow:auto;border-radius:14px;border:1px solid var(--border2,rgba(255,255,255,.12));' +
      'background:rgba(14,24,38,.98);box-shadow:0 20px 50px rgba(0,0,0,.5);padding:1rem 1.15rem 1.1rem}' +
      'html[data-theme=light] .app-shortcuts-dialog{background:#fff;border-color:rgba(15,23,42,.12);box-shadow:0 20px 50px rgba(15,23,42,.12)}' +
      '.app-shortcuts-dialog h3{margin:0 0 .65rem;font-size:1rem;font-weight:700;color:var(--text,#EDF4FF)}' +
      '.app-shortcuts-dialog .ash-row{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.06));font-size:.78rem;line-height:1.4}' +
      '.app-shortcuts-dialog .ash-row:last-child{border-bottom:none}' +
      '.app-shortcuts-dialog kbd{font-family:ui-monospace,monospace;font-size:.68rem;padding:3px 7px;border-radius:6px;border:1px solid var(--border2);background:rgba(255,255,255,.06);color:var(--text2,#93B4CC);white-space:nowrap}' +
      'html[data-theme=light] .app-shortcuts-dialog kbd{background:#f1f5f9;border-color:rgba(15,23,42,.15);color:#334155}' +
      '.app-shortcuts-dialog .ash-desc{flex:1;color:var(--text2,#93B4CC)}' +
      '.app-shortcuts-foot{margin-top:.85rem;display:flex;justify-content:flex-end}' +
      '.app-shortcuts-foot button{font-family:inherit;font-size:.74rem;padding:.45rem .9rem;border-radius:8px;cursor:pointer;border:1px solid var(--border2);background:var(--orange,#F57C00);border-color:var(--orange);color:#0a0f16;font-weight:600}' +
      '.app-shortcuts-foot button:hover{filter:brightness(1.06)}';
    document.head.appendChild(st);
  }

  function buildTourSteps() {
    return TOUR_BLUEPRINT.map(function (row) {
      var el = null;
      if (row.href) {
        el = document.querySelector('a.nav-link[data-app-tour="' + row.href + '"]');
      }
      return { title: row.title, body: row.body, el: el };
    });
  }

  var tourIndex = 0;
  var tourSteps = [];

  function clearTourHighlight() {
    document.querySelectorAll('a.nav-link.app-tour-highlight').forEach(function (a) {
      a.classList.remove('app-tour-highlight');
    });
  }

  function renderTourStep() {
    var root = document.getElementById('app-tour-root');
    if (!root) return;
    var step = tourSteps[tourIndex];
    var title = document.getElementById('app-tour-title');
    var body = document.getElementById('app-tour-body');
    var prog = document.getElementById('app-tour-progress');
    var btnPrev = document.getElementById('app-tour-prev');
    var btnNext = document.getElementById('app-tour-next');
    if (!step) return;
    clearTourHighlight();
    if (title) title.textContent = step.title;
    if (body) body.textContent = step.body;
    if (prog) prog.textContent = 'Paso ' + (tourIndex + 1) + ' de ' + tourSteps.length;
    var pfill = document.getElementById('app-tour-progress-fill');
    if (pfill && tourSteps.length)
      pfill.style.width = (100 * (tourIndex + 1)) / tourSteps.length + '%';
    if (btnPrev) btnPrev.style.visibility = tourIndex <= 0 ? 'hidden' : 'visible';
    if (btnNext) btnNext.textContent = tourIndex >= tourSteps.length - 1 ? 'Listo' : 'Siguiente';
    if (step.el) {
      step.el.classList.add('app-tour-highlight');
      try {
        step.el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch (_) {}
    }
  }

  function closeTour(markDone) {
    var root = document.getElementById('app-tour-root');
    if (root) {
      root.classList.add('hidden');
      root.setAttribute('aria-hidden', 'true');
    }
    clearTourHighlight();
    document.body.style.overflow = '';
    if (markDone) {
      try {
        localStorage.setItem(LS_TOUR, '1');
      } catch (_) {}
      var tb = document.getElementById('app-tour-start');
      if (tb) tb.classList.remove('pulse-ring');
    }
    updateNotifBadge();
  }

  function openTour() {
    injectTourDOM();
    tourSteps = buildTourSteps();
    tourIndex = 0;
    var root = document.getElementById('app-tour-root');
    if (!root) return;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    renderTourStep();
    document.getElementById('app-tour-next').focus();
  }

  function injectTourDOM() {
    if (document.getElementById('app-tour-root')) return;
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="app-tour-root" class="app-tour-root hidden" aria-hidden="true">' +
        '<div class="app-tour-backdrop" id="app-tour-backdrop"></div>' +
        '<div class="app-tour-popover" role="dialog" aria-modal="true" aria-labelledby="app-tour-title">' +
        '<div class="app-tour-accent"></div>' +
        '<div class="app-tour-progress-track"><div class="app-tour-progress-fill" id="app-tour-progress-fill"></div></div>' +
        '<div class="app-tour-popover-inner">' +
        '<h3 id="app-tour-title"></h3>' +
        '<p id="app-tour-body"></p>' +
        '<div class="app-tour-actions">' +
        '<button type="button" id="app-tour-skip">Saltar tour</button>' +
        '<button type="button" id="app-tour-prev">Anterior</button>' +
        '<button type="button" id="app-tour-next" class="primary">Siguiente</button>' +
        '</div>' +
        '<div class="app-tour-progress" id="app-tour-progress"></div>' +
        '</div></div></div>'
    );
    document.getElementById('app-tour-skip').addEventListener('click', function () {
      closeTour(true);
    });
    document.getElementById('app-tour-backdrop').addEventListener('click', function () {
      closeTour(false);
    });
    document.getElementById('app-tour-prev').addEventListener('click', function () {
      if (tourIndex > 0) {
        tourIndex--;
        renderTourStep();
      }
    });
    document.getElementById('app-tour-next').addEventListener('click', function () {
      if (tourIndex >= tourSteps.length - 1) closeTour(true);
      else {
        tourIndex++;
        renderTourStep();
      }
    });
    document.addEventListener('keydown', function tourKey(e) {
      var root = document.getElementById('app-tour-root');
      if (!root || root.classList.contains('hidden')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTour(false);
      }
    });
  }

  function injectNotifDOM() {
    if (document.getElementById('app-notif-panel')) return;
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="app-notif-panel" class="app-notif-panel hidden" role="region" aria-label="Avisos y novedades" hidden>' +
        '<div class="app-notif-head">Avisos y novedades</div>' +
        '<div id="app-notif-list"></div>' +
        '<div class="app-notif-foot">' +
        '<button type="button" id="app-notif-mark-all">Marcar todo leído</button>' +
        '</div></div>'
    );
  }

  function renderNotifList() {
    var list = document.getElementById('app-notif-list');
    if (!list) return;
    var read = readReadSet();
    list.innerHTML = NOTIF_ITEMS.map(function (it) {
      var isRead = !!read[it.id];
      return (
        '<div class="app-notif-item' +
        (isRead ? '' : ' unread') +
        '" data-nid="' +
        String(it.id).replace(/"/g, '') +
        '">' +
        '<div class="nti">' +
        it.title +
        '</div>' +
        '<div class="ntb">' +
        it.body +
        '</div></div>'
      );
    }).join('');
    list.querySelectorAll('.app-notif-item').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-nid');
        if (!id) return;
        var r = readReadSet();
        r[id] = 1;
        writeReadSet(r);
        row.classList.remove('unread');
        updateNotifBadge();
      });
    });
    var mall = document.getElementById('app-notif-mark-all');
    if (mall) {
      mall.onclick = function () {
        var r = {};
        NOTIF_ITEMS.forEach(function (it) {
          r[it.id] = 1;
        });
        writeReadSet(r);
        renderNotifList();
        updateNotifBadge();
      };
    }
  }

  function updateNotifBadge() {
    var badge = document.getElementById('app-notif-badge');
    if (!badge) return;
    var read = readReadSet();
    var n = NOTIF_ITEMS.filter(function (it) {
      return !read[it.id];
    }).length;
    if (n > 0) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.classList.remove('hidden');
    } else badge.classList.add('hidden');
  }

  function positionNotifPanel(anchor) {
    var panel = document.getElementById('app-notif-panel');
    if (!panel || !anchor) return;
    var r = anchor.getBoundingClientRect();
    var pw = panel.offsetWidth || 320;
    var left = r.right - pw;
    if (left < 12) left = 12;
    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
    panel.style.top = Math.round(r.bottom + 8) + 'px';
    panel.style.left = Math.round(left) + 'px';
  }

  function toggleNotifPanel(btn) {
    injectNotifDOM();
    renderNotifList();
    var panel = document.getElementById('app-notif-panel');
    if (!panel) return;
    var open = panel.classList.contains('hidden');
    if (open) {
      panel.classList.remove('hidden');
      panel.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
      positionNotifPanel(btn);
      updateNotifBadge();
    } else {
      panel.classList.add('hidden');
      panel.setAttribute('hidden', 'hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'input' || t === 'textarea' || t === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function injectShortcutsDOM() {
    if (document.getElementById('app-shortcuts-root')) return;
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="app-shortcuts-root" class="app-shortcuts-root hidden" role="dialog" aria-modal="true" aria-labelledby="app-shortcuts-title" aria-hidden="true">' +
        '<div class="app-shortcuts-backdrop" id="app-shortcuts-backdrop"></div>' +
        '<div class="app-shortcuts-dialog">' +
        '<h3 id="app-shortcuts-title">Atajos de teclado</h3>' +
        '<div class="ash-row"><kbd>?</kbd><span class="ash-desc">Abrir o cerrar esta ayuda (fuera de campos de texto).</span></div>' +
        '<div class="ash-row"><kbd>Esc</kbd><span class="ash-desc">Cerrar este panel, el tour o el panel de avisos cuando estén abiertos.</span></div>' +
        '<div class="ash-row"><kbd>Tab</kbd><span class="ash-desc">Navegar por enlaces y botones del menú (orden lógico de la página).</span></div>' +
        '<div class="ash-row"><kbd>Shift</kbd> + <kbd>Tab</kbd><span class="ash-desc">Retroceder en el foco.</span></div>' +
        '<div class="app-shortcuts-foot"><button type="button" id="app-shortcuts-close">Cerrar</button></div>' +
        '</div></div>'
    );
    document.getElementById('app-shortcuts-backdrop').addEventListener('click', closeShortcuts);
    document.getElementById('app-shortcuts-close').addEventListener('click', closeShortcuts);
  }

  function closeShortcuts() {
    var root = document.getElementById('app-shortcuts-root');
    if (!root || root.classList.contains('hidden')) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    var prev = root._returnFocus;
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus();
      } catch (_) {}
    }
    root._returnFocus = null;
  }

  function openShortcuts(fromEl) {
    injectShortcutsDOM();
    var root = document.getElementById('app-shortcuts-root');
    if (!root) return;
    root._returnFocus = fromEl || document.activeElement;
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    var btn = document.getElementById('app-shortcuts-close');
    if (btn) btn.focus();
  }

  function shortcutsGlobalKeydown(e) {
    var root = document.getElementById('app-shortcuts-root');
    var shortcutsOpen = root && !root.classList.contains('hidden');
    if (shortcutsOpen && e.key === 'Escape') {
      e.preventDefault();
      closeShortcuts();
      return;
    }
    if (shortcutsOpen) return;
    var tourRoot = document.getElementById('app-tour-root');
    if (tourRoot && !tourRoot.classList.contains('hidden')) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      openShortcuts(e.target);
    }
  }

  if (!window.__microsipShortcutsKeyBound) {
    window.__microsipShortcutsKeyBound = true;
    document.addEventListener('keydown', shortcutsGlobalKeydown);
  }

  function microsipInitAppGuide() {
    if (window.__microsipAppGuideReady) return;
    window.__microsipAppGuideReady = true;
    injectGuideCSS();
    injectNotifDOM();
    renderNotifList();
    updateNotifBadge();

    var tourBtn = document.getElementById('app-tour-start');
    var notifBtn = document.getElementById('app-notif-toggle');

    try {
      if (!localStorage.getItem(LS_TOUR) && tourBtn) tourBtn.classList.add('pulse-ring');
    } catch (_) {}

    if (tourBtn) {
      tourBtn.addEventListener('click', function () {
        openTour();
      });
    }
    if (notifBtn) {
      notifBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleNotifPanel(notifBtn);
      });
    }

    var shortcutsBtn = document.getElementById('app-shortcuts-open');
    if (shortcutsBtn) {
      shortcutsBtn.addEventListener('click', function () {
        var root = document.getElementById('app-shortcuts-root');
        if (root && !root.classList.contains('hidden')) closeShortcuts();
        else openShortcuts(shortcutsBtn);
      });
    }

    document.addEventListener('click', function (e) {
      var panel = document.getElementById('app-notif-panel');
      var btn = document.getElementById('app-notif-toggle');
      if (!panel || panel.classList.contains('hidden')) return;
      if (btn && (btn === e.target || btn.contains(e.target))) return;
      if (panel.contains(e.target)) return;
      panel.classList.add('hidden');
      panel.setAttribute('hidden', 'hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    });

    window.addEventListener('resize', function () {
      var panel = document.getElementById('app-notif-panel');
      var btn = document.getElementById('app-notif-toggle');
      if (panel && btn && !panel.classList.contains('hidden')) positionNotifPanel(btn);
    });
  }

  window.microsipInitAppGuide = microsipInitAppGuide;
})();
