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
    { href: 'margen-producto.html', label: 'Margen', icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>' },
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

  /** Mantiene ?db= al cambiar de m?dulo (Inicio ? CxC, etc.). */
  function navHref(href) {
    let db = '';
    try {
      db = (new URLSearchParams(window.location.search).get('db') || '').trim();
      if (!db) db = (sessionStorage.getItem('microsip_erp_db') || '').trim();
    } catch (_) {}
    if (!db) return href;
    const sep = href.indexOf('?') >= 0 ? '&' : '?';
    return href + sep + 'db=' + encodeURIComponent(db);
  }

  function svgIcon(pathData) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${pathData}</svg>`;
  }

  function buildNavLinks() {
    const cur = currentPage();
    return PAGES.map(p => {
      const active = cur === p.href ? ' active' : '';
      return `<a href="${navHref(p.href)}" class="nav-link${active}" data-app-tour="${p.href}">${svgIcon(p.icon)}${p.label}</a>`;
    }).join('');
  }

  const icSun = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const icMoon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const icMap = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>';
  const icBell = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  function buildHeader() {
    return `<header id="app-header">
  <div class="header-inner">
    <a href="${navHref('index.html')}" class="logo">
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
    <div class="nav-aux-wrap" id="nav-aux-wrap">
      <button type="button" class="nav-aux-btn" id="app-theme-toggle" aria-label="Tema claro u oscuro" title="Tema">${icSun}</button>
      <button type="button" class="nav-aux-btn" id="app-shortcuts-open" aria-label="Atajos de teclado" title="Atajos (? )">?</button>
      <button type="button" class="nav-aux-btn" id="app-tour-start" aria-label="Tour guiado por m?dulos" title="Tour">${icMap}</button>
      <button type="button" class="nav-aux-btn" id="app-notif-toggle" aria-label="Avisos" aria-expanded="false" title="Avisos">${icBell}<span id="app-notif-badge" class="app-notif-badge hidden">0</span></button>
    </div>
    <div class="header-right">
      <div class="live-pill"><div class="live-dot"></div>Live</div>
      <div class="clock" id="reloj">--:--:--</div>
    </div>
  </div>
</header>`;
  }

  const LS_THEME = 'microsip_theme';
  function applyNavTheme() {
    let t = 'dark';
    try { t = localStorage.getItem(LS_THEME) || 'dark'; } catch (_) {}
    const light = t === 'light';
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    const btn = document.getElementById('app-theme-toggle');
    if (btn) {
      btn.innerHTML = light ? icMoon : icSun;
      btn.title = light ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro';
    }
  }
  function toggleNavTheme() {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    try { localStorage.setItem(LS_THEME, light ? 'dark' : 'light'); } catch (_) {}
    applyNavTheme();
  }

  function loadAppGuideScript() {
    if (typeof window.microsipInitAppGuide === 'function') {
      window.microsipInitAppGuide();
      return;
    }
    if (document.getElementById('app-guide-loader')) return;
    const sc = document.createElement('script');
    sc.id = 'app-guide-loader';
    sc.src = '/app-guide.js';
    sc.defer = true;
    sc.onload = function () {
      if (typeof window.microsipInitAppGuide === 'function') window.microsipInitAppGuide();
    };
    document.body.appendChild(sc);
  }

  /* Inject shared CSS variables + header styles if not already present */
  function injectSharedStyles() {
    if (!document.getElementById('ms-erp-fonts')) {
      const lf = document.createElement('link');
      lf.id = 'ms-erp-fonts';
      lf.rel = 'stylesheet';
      lf.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,600&display=swap';
      document.head.appendChild(lf);
    }
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

/* --- Header (Plus Jakarta Sans + glass) ---------------------------- */
header#app-header {
  position:sticky;top:0;z-index:100;
  background:linear-gradient(180deg,rgba(6,14,26,.97) 0%,rgba(6,14,26,.88) 100%);
  backdrop-filter:saturate(140%) blur(20px);
  -webkit-backdrop-filter:saturate(140%) blur(20px);
  border-bottom:1px solid var(--border);
  box-shadow:0 4px 24px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.04);
}
.header-inner {
  max-width:1900px;margin:0 auto;min-height:64px;height:auto;min-width:0;
  display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(11.25rem,max-content);
  align-items:center;gap:1rem;padding:.55rem 1.5rem;
}
.logo {
  display:flex;align-items:center;gap:.75rem;text-decoration:none;flex-shrink:0;
}
.logo-icon {
  width:40px;height:40px;
  background:linear-gradient(145deg,#ff8a1a 0%,var(--orange) 45%,#c2410c 100%);
  border-radius:12px;display:grid;place-items:center;flex-shrink:0;
  box-shadow:0 4px 16px var(--orange-glow), inset 0 1px 0 rgba(255,255,255,.2);
}
.logo-icon svg { width:20px;height:20px; }
.logo-text {
  font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  font-size:.92rem;font-weight:800;color:var(--text);white-space:nowrap;
  letter-spacing:-.02em;line-height:1.15;
}
.logo-sub  {
  font-size:.58rem;font-family:'JetBrains Mono',ui-monospace,monospace;color:var(--muted);
  letter-spacing:.12em;text-transform:uppercase;font-weight:500;
}

nav#main-nav {
  display:flex;align-items:center;gap:.35rem;flex-wrap:nowrap;overflow-x:auto;
  scrollbar-width:none;flex:1;min-width:0;justify-content:center;
  padding:.25rem .5rem;margin:0 .25rem;
  background:rgba(255,255,255,.02);border-radius:999px;border:1px solid rgba(255,255,255,.06);
}
nav#main-nav::-webkit-scrollbar { display:none; }

.nav-link {
  display:flex;align-items:center;gap:.4rem;
  padding:.45rem .78rem;border-radius:999px;
  font-family:'Plus Jakarta Sans',system-ui,sans-serif;
  font-size:.72rem;font-weight:600;color:var(--muted);
  text-decoration:none;transition:transform .15s,background .18s,color .18s,border-color .18s,box-shadow .18s;
  white-space:nowrap;flex-shrink:0;
  border:1px solid transparent;
}
.nav-link:hover {
  color:var(--text2);
  background:rgba(255,255,255,.06);
  transform:translateY(-1px);
}
.nav-link.active {
  color:#fff;
  background:linear-gradient(135deg,rgba(245,124,0,.35),rgba(245,124,0,.12));
  border-color:rgba(245,124,0,.4);
  box-shadow:0 2px 12px rgba(245,124,0,.15), inset 0 1px 0 rgba(255,255,255,.1);
}
.nav-link svg { width:14px;height:14px;flex-shrink:0;opacity:.9; }

.header-right {
  display:flex;align-items:center;justify-content:flex-end;gap:.75rem;flex-shrink:0;
  justify-self:end;min-width:11.25rem;
}
.live-pill {
  display:flex;align-items:center;gap:.45rem;
  background:linear-gradient(135deg,rgba(245,124,0,.18),rgba(245,124,0,.06));
  border:1px solid rgba(245,124,0,.3);
  border-radius:999px;padding:.32rem .78rem;
  font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.58rem;font-weight:600;
  color:var(--orange);letter-spacing:.06em;text-transform:uppercase;
}
.live-dot {
  width:6px;height:6px;border-radius:50%;
  background:var(--orange);box-shadow:0 0 10px var(--orange);
  animation:livepulse 2s ease-in-out infinite;
}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:.35}}
.clock {
  font-family:'JetBrains Mono',ui-monospace,monospace,'Courier New',Courier,monospace;font-size:.74rem;color:var(--muted);
  letter-spacing:0;font-weight:500;font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;
  padding:.35rem .5rem;border-radius:10px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.06);
  box-sizing:border-box;flex-shrink:0;
  min-width:7.35rem;width:7.35rem;text-align:center;white-space:nowrap;
}

.nav-aux-wrap{display:flex;align-items:center;gap:.4rem;flex-shrink:0;margin-left:.25rem;padding-left:.5rem;border-left:1px solid rgba(255,255,255,.08)}
.nav-aux-btn{
  position:relative;display:grid;place-items:center;width:38px;height:38px;border-radius:11px;
  border:1px solid rgba(255,255,255,.1);
  background:rgba(255,255,255,.04);
  color:var(--text2);cursor:pointer;
  transition:transform .15s,background .18s,border-color .18s,color .18s,box-shadow .18s;
  font-weight:700;font-size:.82rem;font-family:'Plus Jakarta Sans',system-ui,sans-serif;padding:0;line-height:1;
}
.nav-aux-btn:hover{
  color:var(--text);background:rgba(255,255,255,.08);
  border-color:rgba(245,124,0,.35);
  box-shadow:0 4px 14px rgba(0,0,0,.2);
  transform:translateY(-1px);
}

.microsip-skip-link{position:absolute;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.microsip-skip-link:focus{position:fixed;left:12px;top:12px;z-index:20000;width:auto;height:auto;clip:auto;overflow:visible;padding:10px 16px;background:#0f172a;color:#fff;border-radius:8px;text-decoration:none;outline:2px solid var(--orange)}

html[data-theme="light"]{
  --bg:#f0f5fa;--s1:#ffffff;--s2:#e8eef6;--s3:#dce6f0;--s4:#cfd9e8;
  --border:rgba(15,23,42,.08);--border2:rgba(15,23,42,.12);
  --text:#0f172a;--text2:#334155;--muted:#64748b;--dim:#e2e8f0;
}
html[data-theme="light"] body{background:var(--bg)!important;color:var(--text)!important}
html[data-theme="light"] header#app-header{
  background:linear-gradient(180deg,rgba(255,255,255,.98),rgba(248,250,252,.94));
  border-bottom-color:var(--border2);
  box-shadow:0 4px 20px rgba(15,23,42,.06);
}
html[data-theme="light"] .logo-sub{color:var(--muted)}
html[data-theme="light"] nav#main-nav{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.08)}
html[data-theme="light"] .nav-link{color:var(--muted)}
html[data-theme="light"] .nav-link:hover{color:var(--text2);background:rgba(15,23,42,.06)}
html[data-theme="light"] .nav-link.active{
  color:#9a3412;
  background:linear-gradient(135deg,rgba(251,191,36,.35),rgba(253,230,138,.2));
  border-color:rgba(217,119,6,.4);
  box-shadow:0 2px 10px rgba(251,191,36,.2);
}
html[data-theme="light"] .live-pill{background:rgba(30,127,217,.1);border-color:rgba(30,127,217,.25);color:var(--blue)}
html[data-theme="light"] .clock{color:var(--muted);background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.08)}
html[data-theme="light"] .nav-aux-wrap{border-left-color:rgba(15,23,42,.1)}
html[data-theme="light"] .orb{opacity:.06!important}
html[data-theme="light"] .nav-aux-btn{background:rgba(15,23,42,.04);color:var(--text2);border-color:rgba(15,23,42,.1)}
html[data-theme="light"] .microsip-skip-link:focus{background:#0f172a;color:#fff}

/* --- Sortable tables (global) --------------------------------------- */
.ms-sortable-th{cursor:pointer;user-select:none;position:relative;padding-right:1.1rem!important}
.ms-sortable-th:hover{color:var(--text)}
.ms-sortable-th::after{
  content:'?';
  position:absolute;right:.3rem;top:50%;transform:translateY(-50%);
  font-size:.65rem;opacity:.45;color:var(--muted);
}
.ms-sortable-th[data-ms-sort-dir="asc"]::after{content:'?';opacity:.9;color:var(--text2)}
.ms-sortable-th[data-ms-sort-dir="desc"]::after{content:'?';opacity:.9;color:var(--text2)}

/* --- Global readability + storytelling layer -------------------------- */
:where(main,.page){
  max-width:1720px;
}
:where(main,.page) :where(h1,.hero-title){
  letter-spacing:-.02em;
}
:where(main,.page) :where(.hero-sub,.notice,.card-note,.insight-text,.mod-desc,.alert-text,.biz-context-hint,.biz-context-hint--compact,.kpi-sub,.sd-label,.section-divider-label,.footer){
  color:var(--text2)!important;
  line-height:1.58;
}
:where(main,.page) :where(.card-title,.scorecard-title,.insight-title,.mod-name,.sc-kpi-name,.uni-ec-name,.pl-mini-head){
  font-size:clamp(.9rem,1.1vw,.98rem)!important;
}
:where(main,.page) :where(.kpi-label,.kpi-module,.mod-kpi-label,.sc-kpi-area,.hero-eyebrow,.biz-context-label){
  color:var(--text2)!important;
  font-size:clamp(.62rem,.85vw,.72rem)!important;
}
:where(main,.page) :where(table thead th,.tbl th,.sc-table th,.pnl-structured th,.uni-table th,.pl-mini-table th){
  color:var(--text2)!important;
  font-size:clamp(.6rem,.8vw,.68rem)!important;
}
:where(main,.page) :where(table tbody td,.tbl td,.sc-table td,.pnl-structured td,.uni-table td,.pl-mini-table td){
  color:var(--text)!important;
  font-size:clamp(.74rem,.95vw,.83rem)!important;
}
:where(main,.page) :where(.card,.kpi,.module-card,.uni-entity-card,.pl-sc-card,.scorecard-wrap,.pl-mini-wrap){
  border-color:rgba(255,255,255,.12)!important;
}
:where(main,.page) :where(.chart-wrap,.chart-h220,.chart-h200){
  min-height:220px;
}

.ms-story{
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:.8rem 1rem;
  align-items:center;
  margin:0 0 1rem;
  padding:.85rem 1rem;
  border-radius:12px;
  border:1px solid rgba(255,255,255,.14);
  background:linear-gradient(150deg,rgba(255,184,0,.1),rgba(17,34,51,.9));
}
.ms-story-left{min-width:0}
.ms-story-kicker{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:.62rem;
  letter-spacing:.1em;
  text-transform:uppercase;
  color:var(--amber);
}
.ms-story-text{
  margin-top:.28rem;
  color:var(--text);
  font-size:.82rem;
  line-height:1.55;
}
.ms-story-pill{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  font-size:.62rem;
  padding:.28rem .62rem;
  border-radius:999px;
  color:var(--text2);
  border:1px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.04);
  white-space:nowrap;
}
@media (max-width: 900px){
  .ms-story{grid-template-columns:1fr}
}

/* --- Global semantic traffic-light ---------------------------------- */
.ms-sem-good{color:var(--green)!important}
.ms-sem-yellow{color:var(--yellow)!important}
.ms-sem-orange{color:var(--orange)!important}
.ms-sem-red{color:var(--red)!important}
`;
    document.head.appendChild(style); // Append last so brand vars override page vars
  }

  function parseTableValue(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return { type: 'str', val: '' };
    const iso = Date.parse(s);
    if (!isNaN(iso) && /^\d{4}-\d{2}-\d{2}/.test(s)) return { type: 'num', val: iso };
    const mx = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (mx) {
      const y = Number(mx[3].length === 2 ? ('20' + mx[3]) : mx[3]);
      const m = Number(mx[2]) - 1;
      const d = Number(mx[1]);
      const dt = new Date(y, m, d).getTime();
      if (!isNaN(dt)) return { type: 'num', val: dt };
    }
    const compact = s.replace(/[$,%\s,]/g, '');
    const km = compact.match(/^(-?\d+(?:\.\d+)?)([KkMm])$/);
    if (km) {
      const base = Number(km[1]);
      if (!isNaN(base)) return { type: 'num', val: base * (/[Mm]/.test(km[2]) ? 1000000 : 1000) };
    }
    const n = Number(compact);
    if (!isNaN(n)) return { type: 'num', val: n };
    return { type: 'str', val: s.toUpperCase() };
  }

  function makeTableSortable(table) {
    if (!table || table.dataset.msSortReady === '1') return;
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    if (!thead || !tbody) return;
    if (thead.querySelector('th[data-sort]')) return; // tabla con sorting custom
    const headers = Array.from(thead.querySelectorAll('th'));
    if (!headers.length) return;
    headers.forEach((th, idx) => {
      if (th.getAttribute('colspan') && Number(th.getAttribute('colspan')) > 1) return;
      th.classList.add('ms-sortable-th');
      th.addEventListener('click', () => {
        const currentCol = Number(table.dataset.msSortCol || -1);
        const nextDir = (currentCol === idx && table.dataset.msSortDir === 'desc') ? 'asc' : 'desc';
        table.dataset.msSortCol = String(idx);
        table.dataset.msSortDir = nextDir;
        headers.forEach(h => h.removeAttribute('data-ms-sort-dir'));
        th.setAttribute('data-ms-sort-dir', nextDir);
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((ra, rb) => {
          const ca = ra.children[idx];
          const cb = rb.children[idx];
          const va = parseTableValue(ca ? ca.textContent : '');
          const vb = parseTableValue(cb ? cb.textContent : '');
          let cmp = 0;
          if (va.type === 'num' && vb.type === 'num') cmp = va.val - vb.val;
          else cmp = String(va.val).localeCompare(String(vb.val), 'es', { sensitivity: 'base' });
          return nextDir === 'asc' ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
    table.dataset.msSortReady = '1';
  }

  function initGlobalTableSort() {
    document.querySelectorAll('table').forEach(makeTableSortable);
  }

  function pageNarrative(page) {
    const map = {
      'index.html': { k: 'Storyline', t: 'Empieza por el resumen ejecutivo, luego revisa alertas y termina en los m\u00f3dulos con mayor desviaci\u00f3n.', p: 'Vista 360' },
      'director.html': { k: 'Storyline', t: 'Lee de izquierda a derecha: cumplimiento del mes, riesgo de CxC y finalmente rotaci\u00f3n para decidir prioridad.', p: 'Decisi\u00f3n directiva' },
      'ventas.html': { k: 'Storyline', t: 'Primero tendencia y total, despu\u00e9s vendedores y al final detalle por cliente/producto para acciones comerciales.', p: 'Embudo comercial' },
      'margen-producto.html': { k: 'Storyline', t: 'Enf\u00f3cate en margen %, costo y volumen: identifica top utilidad y productos que venden mucho pero dejan poco.', p: 'Rentabilidad' },
      'consumos.html': { k: 'Storyline', t: 'Valida d\u00edas de cobertura, luego quiebres potenciales y termina con compras sugeridas para no frenar operaci\u00f3n.', p: 'Continuidad operativa' },
      'cobradas.html': { k: 'Storyline', t: 'Revisa total cobrado, ticket promedio y detalle de cobros por vendedor/factura para evaluar efectividad de cobranza.', p: 'Flujo de efectivo' },
      'vendedores.html': { k: 'Storyline', t: 'Compara productividad por vendedor y baja al detalle para detectar cartera activa vs estancada.', p: 'Desempe\u00f1o comercial' },
      'cxc.html': { k: 'Storyline', t: 'Empieza por deuda total, despu\u00e9s aging y finalmente top deudores/condiciones para priorizar gesti\u00f3n de cobro.', p: 'Riesgo de cartera' },
      'clientes.html': { k: 'Storyline', t: 'Cruza saldo, vencido y \u00faltima compra para detectar clientes en riesgo y el impacto potencial en ventas.', p: 'Riesgo cliente' },
      'inventario.html': { k: 'Storyline', t: 'Consulta cobertura y rotaci\u00f3n; luego aterriza en art\u00edculos cr\u00edticos con sobrestock o bajo stock.', p: 'Salud inventario' },
      'resultados.html': { k: 'Storyline', t: 'Lee ventas netas, costo y margen bruto; luego gastos operativos y utilidad para explicar el resultado final.', p: 'P&L guiado' },
    };
    return map[page] || { k: 'Storyline', t: 'Revisa KPIs principales y luego baja al detalle para explicar causa y acci\u00f3n.', p: 'Vista guiada' };
  }

  function injectStoryStrip() {
    const mainEl = document.querySelector('main') || document.querySelector('.page');
    if (!mainEl || document.getElementById('ms-story-strip')) return;
    const n = pageNarrative(currentPage());
    const html = '<section id="ms-story-strip" class="ms-story" aria-label="Gu\u00eda de lectura del dashboard">' +
      '<div class="ms-story-left">' +
      `<div class="ms-story-kicker">${n.k}</div>` +
      `<div class="ms-story-text">${n.t}</div>` +
      '</div>' +
      `<span class="ms-story-pill">${n.p}</span>` +
      '</section>';
    mainEl.insertAdjacentHTML('afterbegin', html);
  }

  function parseSemNumber(raw) {
    const txt = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!txt) return null;
    if (!/[$%\d]/.test(txt) && !/\(\s*\$?\s*\d/.test(txt)) return null;
    const hasPct = txt.indexOf('%') >= 0;
    const parenNeg = /\(\s*\$?\s*[\d.,]+\s*\)/.test(txt);
    const m = txt.match(/-?\$?\s*[\d,.]+(?:\.\d+)?/);
    if (!m) return null;
    let n = Number(String(m[0]).replace(/[$,\s]/g, ''));
    if (isNaN(n)) return null;
    if (parenNeg) n = -Math.abs(n);
    return { value: n, abs: Math.abs(n), isPct: hasPct };
  }

  function getSemContext(el) {
    if (!el) return '';
    const row = el.closest('tr');
    const rowHead = row && row.firstElementChild ? row.firstElementChild.textContent : '';
    const cardTitle = (el.closest('.card') && el.closest('.card').querySelector('.card-title')) ? el.closest('.card').querySelector('.card-title').textContent : '';
    const prev = el.previousElementSibling ? el.previousElementSibling.textContent : '';
    return String([rowHead, cardTitle, prev].filter(Boolean).join(' ')).toLowerCase();
  }

  function semLevelByContext(parsed, ctx) {
    if (!parsed) return '';
    const badCtx = /(gasto|costo|venc|deuda|atras|moros|riesgo|cartera|descuento|devoluc|merma|dias)/i.test(ctx);
    const goodCtx = /(venta|utilidad|margen|cobro|ingreso|eficiencia|cumplimiento|comision|vigente|salud)/i.test(ctx);

    if (badCtx) {
      if (parsed.isPct) {
        if (parsed.abs <= 20) return 'ms-sem-good';
        if (parsed.abs <= 40) return 'ms-sem-yellow';
        if (parsed.abs <= 60) return 'ms-sem-orange';
        return 'ms-sem-red';
      }
      if (parsed.abs <= 0) return 'ms-sem-good';
      if (parsed.abs <= 50000) return 'ms-sem-yellow';
      if (parsed.abs <= 200000) return 'ms-sem-orange';
      return 'ms-sem-red';
    }
    if (goodCtx) {
      if (parsed.isPct) {
        if (parsed.value >= 60) return 'ms-sem-good';
        if (parsed.value >= 40) return 'ms-sem-yellow';
        if (parsed.value >= 20) return 'ms-sem-orange';
        return 'ms-sem-red';
      }
      if (parsed.value < 0) return 'ms-sem-red';
      if (parsed.value < 50000) return 'ms-sem-orange';
      if (parsed.value < 200000) return 'ms-sem-yellow';
      return 'ms-sem-good';
    }
    if (parsed.value < 0) return 'ms-sem-red';
    return '';
  }

  function applyGlobalSemaforos() {
    const targets = document.querySelectorAll('td, .kpi-val, .kpi-value, .val, .cond-amt-total, .cond-amt-sub, .metric-value');
    let painted = 0;
    let scanned = 0;
    targets.forEach((el) => {
      if (!el || !el.textContent) return;
      scanned += 1;
      el.classList.remove('ms-sem-good', 'ms-sem-yellow', 'ms-sem-orange', 'ms-sem-red');
      const parsed = parseSemNumber(el.textContent);
      if (!parsed) return;
      const lvl = semLevelByContext(parsed, getSemContext(el));
      if (!lvl) return;
      el.classList.add(lvl);
      painted += 1;
    });
    // #region agent log
    fetch('http://127.0.0.1:7845/ingest/dccd4d73-a0a8-497c-b252-2fef711ed56a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5e0522'},body:JSON.stringify({sessionId:'5e0522',runId:'run18',hypothesisId:'H80',location:'nav.js:applyGlobalSemaforos',message:'global semantic coloring pass',data:{scanned,painted,page:currentPage()},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }

  /* Replace or inject header */
  function inject() {
    injectSharedStyles();
    if (!document.getElementById('microsip-skip')) {
      document.body.insertAdjacentHTML(
        'afterbegin',
        '<a id="microsip-skip" class="microsip-skip-link" href="#app-main-content">Ir al contenido</a>'
      );
    }
    const skipEl = document.getElementById('microsip-skip');
    const existing = document.querySelector('header');
    const html = buildHeader();
    if (existing) {
      existing.outerHTML = html;
    } else if (skipEl) {
      skipEl.insertAdjacentHTML('afterend', html);
    } else {
      document.body.insertAdjacentHTML('afterbegin', html);
    }

    const mainEl = document.querySelector('main') || document.querySelector('.page');
    if (mainEl && !mainEl.id) mainEl.id = 'app-main-content';
    injectStoryStrip();

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

    const themeBtn = document.getElementById('app-theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', toggleNavTheme);
    }
    applyNavTheme();

    // Legacy assistant disabled by default (chat-widget.js is the active assistant).
    if (window.__USE_LEGACY_AI_ASSISTANT__ === true) {
      injectAiAssistant();
    }

    loadAppGuideScript();

    if (typeof window.initGlobalDbBarAfterNav === 'function') {
      window.initGlobalDbBarAfterNav(document.getElementById('app-header'));
    }
    initGlobalTableSort();
    applyGlobalSemaforos();
    try {
      let semTick = null;
      const scheduleSemaforo = () => {
        if (semTick) return;
        semTick = requestAnimationFrame(() => {
          semTick = null;
          applyGlobalSemaforos();
          // #region agent log
          fetch('http://127.0.0.1:7845/ingest/dccd4d73-a0a8-497c-b252-2fef711ed56a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5e0522'},body:JSON.stringify({sessionId:'5e0522',runId:'run18',hypothesisId:'H81',location:'nav.js:MutationObserver',message:'semantic recolor scheduled after DOM mutation',data:{page:currentPage()},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
        });
      };
      const mo = new MutationObserver(() => { initGlobalTableSort(); scheduleSemaforo(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  /** Widget IA: mismos IDs que sistema-cotizacion-web (#ai-widget-wrap, #ai-fab, ?). */
  function injectAiAssistant() {
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