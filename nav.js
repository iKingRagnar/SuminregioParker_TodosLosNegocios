/**
 * nav.js avegaciz#ompartida SUMINREGIO PARKER v1.0
 * Inyecta el header completo en todas las p?nas de forma consistente.
 * Uso: <script src="nav.js"></script> en el <body>, antes del cierre </body>
 * La p?na activa se detecta autom)camente por pathname.
 */
(function () {
  const PAGES = [
    { href: 'index.html',      label: 'Inicio',      icon: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
    { href: 'director.html',   label: 'Director',    icon: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' },
    { href: 'ventas.html',     label: 'Ventas',      icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' },
    { href: 'consumos.html',   label: 'Consumos',    icon: '<path d="M4 19h16M6 16l3-5 3 3 4-6 2 3"/>' },
    { href: 'cobradas.html',   label: 'Cobradas',    icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' },
    { href: 'vendedores.html', label: 'Vendedores',  icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
    { href: 'cxc.html',        label: 'CxC',         icon: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>' },
    { href: 'clientes.html',   label: 'Clientes',    icon: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' },
    { href: 'inventario.html', label: 'Inventario',  icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 2 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>' },
    { href: 'resultados.html', label: 'Resultados',  icon: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>' },
  ];

  function currentPage() {
    const p = window.location.pathname.split('/').pop() || 'index.html';
    return p === '' ? 'index.html' : p;
  }

  function svgIcon(pathData) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
  }

  function buildNavLinks() {
    const cur = currentPage();
    return PAGES.map(p => {
      const active = cur === p.href ? ' active' : '';
      return `<a href="${p.href}" class="nav-link${active}">${svgIcon(p.icon)}${p.label}</a>`;
    }).join('');
  }

  function buildHeader() {
    return `<header id="app-header">
  <div class="header-inner">
    <a href="index.html" class="logo">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
        </svg>
      </div>
      <div>
        <div class="logo-text">Suminregio Parker</div>
        <div class="logo-sub">Mangueras Industriales</div>
      </div>
    </a>
    <nav id="main-nav">
      ${buildNavLinks()}
    </nav>
    <div class="header-right">
      <div class="live-pill"><div class="live-dot"></div>Live</div>
      <div class="clock" id="reloj">--:--:--</div>
    </div>
  </div>
</header>`;
  }

  /* Inject shared CSS variables + header styles if not already present */
  function injectSharedStyles() {
    if (document.getElementById('shared-nav-styles')) return;
    const style = document.createElement('style');
    style.id = 'shared-nav-styles';
    style.textContent = `
/* --- SUMINREGIO PARKER Brand Colors ------------------------------- */
:root {
  --bg:#060E1A;
  --s1:#0C1B29;
  --s2:#112233;
  --s3:#172D42;
  --s4:#1D3654;
  --border:rgba(255,255,255,.06);
  --border2:rgba(255,255,255,.12);
  --orange:#F57C00;
  --orange-dim:rgba(245,124,0,.13);
  --orange-glow:rgba(245,124,0,.22);
  --amber:#FFB800;
  --amber-dim:rgba(255,184,0,.12);
  --green:#00C48C;
  --green-dim:rgba(0,196,140,.12);
  --blue:#1E7FD9;
  --blue-dim:rgba(30,127,217,.12);
  --red:#E63946;
  --red-dim:rgba(230,57,70,.13);
  --cyan:#00B4D8;
  --cyan-dim:rgba(0,180,216,.12);
  --purple:#7B5EA7;
  --purple-dim:rgba(123,94,167,.12);
  --yellow:var(--amber);
  --yellow-dim:var(--amber-dim);
  --text:#EDF4FF;
  --text2:#93B4CC;
  --muted:#4D6E8A;
  --dim:#1A2F44;
}

/* --- Header -------------------------------------------------------- */
header#app-header {
  position:sticky;top:0;z-index:100;
  background:rgba(6,14,26,.92);backdrop-filter:blur(24px);
  border-bottom:1px solid var(--border);
}
.header-inner {
  max-width:1900px;margin:0 auto;height:62px;
  display:flex;align-items:center;justify-content:space-between;
  gap:1rem;padding:0 1.5rem;
}
.logo {
  display:flex;align-items:center;gap:.7rem;text-decoration:none;flex-shrink:0;
}
.logo-icon {
  width:36px;height:36px;
  background:linear-gradient(135deg,var(--orange),var(--amber));
  border-radius:9px;display:grid;place-items:center;flex-shrink:0;
  box-shadow:0 0 18px var(--orange-glow);
}
.logo-icon svg { width:18px;height:18px; }
.logo-text { font-size:.88rem;font-weight:800;color:var(--text);white-space:nowrap; }
.logo-sub  { font-size:.55rem;font-family:'DM Mono',monospace;color:var(--muted);letter-spacing:.1em;text-transform:uppercase; }

nav#main-nav {
  display:flex;align-items:center;gap:.15rem;flex-wrap:nowrap;overflow-x:auto;
  scrollbar-width:none;flex:1;justify-content:center;padding:0 1rem;
}
nav#main-nav::-webkit-scrollbar { display:none; }

.nav-link {
  display:flex;align-items:center;gap:.38rem;
  padding:.32rem .72rem;border-radius:7px;
  font-size:.72rem;font-weight:600;color:var(--muted);
  text-decoration:none;transition:all .18s;white-space:nowrap;flex-shrink:0;
  border:1px solid transparent;
}
.nav-link:hover { color:var(--text2);background:var(--s2); }
.nav-link.active {
  color:var(--orange);background:var(--orange-dim);
  border-color:rgba(245,124,0,.25);
}
.nav-link svg { width:13px;height:13px;flex-shrink:0; }

.header-right { display:flex;align-items:center;gap:.9rem;flex-shrink:0; }
.live-pill {
  display:flex;align-items:center;gap:.4rem;
  background:var(--orange-dim);border:1px solid rgba(245,124,0,.25);
  border-radius:99px;padding:.26rem .7rem;
  font-family:'DM Mono',monospace;font-size:.6rem;
  color:var(--orange);letter-spacing:.08em;text-transform:uppercase;
}
.live-dot {
  width:5px;height:5px;border-radius:50%;
  background:var(--orange);box-shadow:0 0 7px var(--orange);
  animation:livepulse 2s ease-in-out infinite;
}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:.35}}
.clock { font-family:'DM Mono',monospace;font-size:.75rem;color:var(--muted);letter-spacing:.04em; }
`;
    document.head.appendChild(style); // Append last so brand vars override page vars
  }

  /* Replace or inject header */
  function inject() {
    injectSharedStyles();
    const existing = document.querySelector('header');
    const html = buildHeader();
    if (existing) {
      existing.outerHTML = html;
    } else {
      document.body.insertAdjacentHTML('afterbegin', html);
    }

    // Start clock
    const clockEl = document.getElementById('reloj');
    if (clockEl) {
      const tick = () => {
        const n = new Date();
        clockEl.textContent =
          String(n.getHours()).padStart(2,'0') + ':' +
          String(n.getMinutes()).padStart(2,'0') + ':' +
          String(n.getSeconds()).padStart(2,'0');
      };
      tick();
      setInterval(tick, 1000);
    }

    injectAiAssistant();
  }

  /** Widget IA: mismos IDs que sistema-cotizacion-web (#ai-widget-wrap, #ai-fab, …). */
  function injectAiAssistant() {
    if (document.getElementById('ai-widget-wrap')) return;

    const scriptSrc = document.currentScript && document.currentScript.src;
    const base = scriptSrc ? scriptSrc.replace(/[/\\][^/\\]+$/, '/') : '';

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = base + 'ai-widget.css';
    document.head.appendChild(link);

    const icoRobot = '<svg class="ai-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="14" rx="3"/><circle cx="9.5" cy="13" r="1.25" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1.25" fill="currentColor" stroke="none"/><path d="M8 17h8"/><path d="M12 3v4"/></svg>';
    const icoChev = '<svg class="ai-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
    const icoClip = '<svg class="ai-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>';
    const icoMic = '<svg class="ai-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    const icoPlane = '<svg class="ai-ico-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

    document.body.insertAdjacentHTML('beforeend',
      '<div id="ai-widget-wrap" class="ai-widget-wrap collapsed" aria-label="Agente de Soporte - Asistente con IA">' +
        '<div id="ai-fab-nudge" class="ai-fab-nudge hidden" role="status" aria-live="polite" aria-atomic="true">' +
          '<button type="button" class="ai-fab-nudge-close" id="ai-fab-nudge-close" aria-label="Cerrar aviso" title="Cerrar">\u00d7</button>' +
          '<p class="ai-fab-nudge-text"><strong>\u00bfTe ayudo?</strong> Toca el robot para abrir el asistente: cotizaciones, CxC, ventas y m\u00e1s.</p>' +
        '</div>' +
        '<div id="ai-fab" class="ai-fab" title="Abrir Agente de Soporte" role="button" tabindex="0">' +
          icoRobot +
          '<span class="ai-fab-tooltip">\u00bfTe puedo ayudar?</span>' +
          '<span id="ai-unread-badge" class="ai-unread-badge hidden">0</span>' +
        '</div>' +
        '<div id="ai-widget" class="ai-widget ai-widget-panel">' +
          '<div class="ai-chat-header ai-widget-drag">' +
            '<div class="ai-avatar">' + icoRobot + '</div>' +
            '<div>' +
              '<h2>Agente de Soporte</h2>' +
              '<span class="ai-status">En l\u00ednea \u00b7 Arrastra para mover</span>' +
            '</div>' +
            '<button type="button" id="ai-minimize" class="ai-btn-minimize" aria-label="Minimizar">' + icoChev + '</button>' +
          '</div>' +
          '<div class="ai-chat">' +
            '<div class="ai-chat-messages" id="ai-messages"></div>' +
            '<div class="ai-chat-suggestions" id="ai-suggestions">' +
              '<span class="ai-suggestions-label">Preguntas r\u00e1pidas:</span>' +
              '<button type="button" class="ai-chip" data-msg="\u00bfCu\u00e1ntas cotizaciones van hoy?">Cotizaciones de hoy</button>' +
              '<button type="button" class="ai-chip" data-msg="\u00bfCu\u00e1l es el saldo total de cuentas por cobrar?">Saldo CxC</button>' +
              '<button type="button" class="ai-chip" data-msg="\u00bfC\u00f3mo van las ventas del mes (VE y PV)?">Ventas del mes</button>' +
              '<button type="button" class="ai-chip" data-msg="Expl\u00edcame qu\u00e9 es el scorecard multi-empresa en Inicio.">Multi-empresa</button>' +
            '</div>' +
            '<div class="ai-chat-form">' +
              '<input type="file" id="ai-file-input" class="hidden" accept="image/jpeg,image/png,image/gif,image/webp" aria-hidden="true">' +
              '<div class="ai-chat-form-tools" role="toolbar" aria-label="Adjuntar y voz">' +
                '<button type="button" id="ai-attach" class="ai-btn-attach" aria-label="Adjuntar imagen">' + icoClip + '</button>' +
                '<button type="button" id="ai-voice" class="ai-btn-attach" aria-label="Hablar (voz)" title="Hablar con el asistente">' + icoMic + '</button>' +
              '</div>' +
              '<input type="text" id="ai-input" placeholder="Escribe o habla tu mensaje\u2026" maxlength="500" autocomplete="off">' +
              '<button type="button" id="ai-send" class="btn primary ai-chat-send" aria-label="Enviar mensaje al asistente">' + icoPlane + '<span class="ai-send-label">Enviar</span></button>' +
            '</div>' +
            '<p class="ai-voice-hint" id="ai-voice-hint">Pulsa el micr\u00f3fono y habla; el texto se env\u00eda al asistente. Requiere Chrome/Edge y HTTPS (o localhost).</p>' +
          '</div>' +
        '</div>' +
      '</div>');

    const s = document.createElement('script');
    s.src = base + 'ai-assistant.js';
    s.defer = true;
    document.body.appendChild(s);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();