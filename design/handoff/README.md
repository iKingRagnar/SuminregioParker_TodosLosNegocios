# Handoff: Suminregio Parker — Sistema Visual Premium (Sidebar Dorado)

## Overview
Este documento especifica la **capa visual** (colores, tipografía, componentes, animaciones) del rediseño premium aplicado al ERP de Suminregio Parker. El objetivo es que apliques este mismo look-and-feel sobre la aplicación web real — **sin tocar lógica de negocio, fetch de datos, rutas ni estructura de estado existente**. Es un reskin, no una reescritura funcional.

## Sobre los archivos de referencia
Las 15 páginas incluidas en `pages/` (Login + las 14 vistas del ERP) son **prototipos de diseño en HTML** construidos para explorar y validar el look — no son código de producción para copiar tal cual. Tu tarea es **recrear este sistema visual dentro del entorno real de la app** (el stack/frameworks que ya existen: HTML+CSS+JS vanilla con Chart.js, según `public/*.html`), respetando los patrones ya establecidos ahí (IDs de canvas, `fetch()` a la API, `oninput`/`onclick` handlers, etc.). Todo lo de abajo es **CSS + estructura + timing de animación**, listo para trasladar 1:1.

## Fidelidad
**Alta fidelidad.** Todos los valores (hex, tamaños, pesos, radios, sombras, timings) son exactos — cópialos tal cual, no los reinterpretes.

---

## 1. Design Tokens

### 1.1 Paleta de color

**Fondo de la app (light, cálido — reemplaza el gris frío anterior):**
```css
--bg-page-gradient:
  radial-gradient(1200px 720px at 6% -8%, rgba(224,179,65,.16), transparent 55%),
  radial-gradient(1100px 760px at 104% 4%, rgba(120,86,40,.07), transparent 52%),
  linear-gradient(180deg, #FBF7EE 0%, #F2ECDE 60%, #EDE6D6 100%);
--bg-page-fallback: #EFE9DC;
--bg-card: #FFFFFF;
--bg-card-warm: linear-gradient(170deg, #FFFFFF, #FBF7EE); /* tarjetas con gráficas */
--bg-row-hover: #FBF6EC;
--bg-pill-soft: #FAF6EC;
```

**Texto:**
```css
--text-primary:   #211A10;  /* títulos, texto principal */
--text-secondary: #3A3020;  /* texto de cuerpo importante */
--text-muted:     #6E624E;  /* subtítulos, notas */
--text-faint:     #8A7C64;  /* metadata, timestamps */
--text-mono-label:#A2937A;  /* labels uppercase en mono */
```

**Marca / acento dorado (color firma del sistema):**
```css
--gold-50:  #F6D279;
--gold-400: #E0B341;   /* acento principal, usado en botones/línea activa */
--gold-600: #B8860B;   /* texto de marca, iconos, hover */
--gold-deep:#8A6516;   /* texto sobre fondos claros dorados */
--gold-grad: linear-gradient(135deg, #F6D279, #E0B341, #B8860B); /* logo, headers hero, H1 gradiente */
```

**Semáforo de estado (usado en TODO: badges, KPIs, barras, bordes):**
```css
--state-ok:      #0E9F6E;  /* CUMPLIDO / verde */
--state-ok-bg:   #E7F6EF;
--state-warn:    #B45309;  /* ATENCION / ámbar-naranja */
--state-warn-bg: #FBF1DC;
--state-danger:  #D92D20;  /* ALERTA / rojo */
--state-danger-bg:#FEECEA;
--state-neutral: #9A8D76;
```
> Nota: en algunas tarjetas de "Indicadores del día" se usa un ámbar ligeramente distinto para warn: `#C98A1E`. Usa `#B45309` como estándar para badges de meta/cumplimiento y `#C98A1E` solo si necesitas diferenciar un warn "suave" de uno "de atención".

**Colores de serie (gráficas, avatares, categorías) — paleta categórica:**
```css
--series-blue:   #2563EB;  /* + variante clara #4F86F7 */
--series-green:  #0E9F6E;  /* también #067647 en textos KPI */
--series-purple: #7C5CFC;  /* + variante clara #9B82FF */
--series-orange: #C2410C;
--series-cyan:   #0E7490;
--series-violet: #5B43C9;
```

**Sidebar (fondo oscuro — único componente no-claro del sistema):**
```css
--sidebar-bg:       #1C150D;
--sidebar-text:     #9A938A;  /* item inactivo */
--sidebar-text-hover:#E8E3DA;
--sidebar-text-active:#F2C667;
--sidebar-heading:  #6E624E;  /* "PANEL" / "INTELIGENCIA" */
--sidebar-hover-bg: rgba(255,255,255,.06);
--sidebar-active-bg:rgba(224,179,65,.15);
--sidebar-border:   rgba(255,255,255,.08);
```

### 1.2 Tipografía

```css
/* Google Fonts — cargar los 3 */
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Outfit:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
```

| Uso | Familia | Peso | Notas |
|---|---|---|---|
| Body / UI general | `'Outfit', system-ui, sans-serif` | 400–500 | fuente base de `<body>` |
| Títulos (H1–H3, nombres de tarjeta) | `'Fraunces', serif` | 600 (H1: 600–700) | serif editorial — da el toque "premium/boutique". Clase `.fr` |
| Números, datos, timestamps, badges | `'DM Mono', monospace` | 400–500 | SIEMPRE monoespaciada para cifras (alineación tabular). Clase `.mono` |

Escala tipográfica real usada:
- H1 de página: `clamp(1.9rem, 3vw, 2.5rem)`, peso 600, `letter-spacing:-0.02em`, color `--text-primary` (a veces con `--gold-grad` + `background-clip:text` para efecto degradado en headers hero).
- H3 de tarjeta/sección: `1.08rem–1.2rem`, peso 600, Fraunces.
- Label eyebrow (uppercase pequeño sobre título): `0.6rem`, DM Mono, `letter-spacing:0.22em`, `text-transform:uppercase`, color `--gold-600`.
- Valor de KPI grande: `1.3rem–1.55rem`, DM Mono, peso 500–600, `letter-spacing:-0.025em`.
- Texto de tabla: `0.72rem–0.85rem`.
- Header de columna de tabla: `0.52rem–0.56rem`, DM Mono, uppercase, `letter-spacing:0.08em`, color `--text-mono-label`.

### 1.3 Radios de borde
```css
--radius-sm: 8px;    /* botones, inputs, chips */
--radius-md: 12px;   /* mini-cards, avatares cuadrados */
--radius-lg: 16px;   /* KPI cards */
--radius-xl: 18px;   /* cards con gráfica (PL, Margen) */
--radius-2xl: 20px;  /* cards principales de sección (Ventas, Cobradas, etc.) */
--radius-pill: 999px;/* badges, barras de progreso, chips de filtro */
```

### 1.4 Sombras
```css
--shadow-card-rest: 0 16px 38px -24px rgba(40,28,12,.32);
--shadow-card-rest-sm: 0 10px 24px -20px rgba(40,28,12,.3);  /* tarjetas pequeñas (metas, quiebres) */
--shadow-card-hover: 0 26px 54px -22px rgba(40,28,12,.34);
--shadow-pill-row: 0 6px 18px -12px rgba(40,28,12,.22);       /* barra de filtros/presets */
--shadow-logo: 0 2px 10px rgba(184,134,11,.4);
```

### 1.5 Espaciado
Escala base en `rem` (16px root), usada consistentemente:
```
0.2 · 0.3 · 0.4 · 0.5 · 0.6 · 0.7 · 0.8 · 0.9 · 1.0 · 1.1 · 1.2 · 1.3 · 1.4 · 1.5 · 2.0 rem
```
- Padding interno de card estándar: `1.4rem 1.5rem` (cards con gráfica) / header de tabla `1.1–1.2rem 1.5rem 0.8–0.9rem`.
- Gap entre tarjetas de un grid: `0.9rem–1.1rem`.
- Gap entre secciones verticales: `1.25rem–2rem`.
- `<main>` padding: `clamp(1.1rem,2.4vw,2rem) clamp(1rem,2.4vw,2rem) 3rem`, `max-width:1480px`, centrado.

### 1.6 Bordes sutiles
```css
--border-card: 1px solid rgba(31,24,12,.08);
--border-hairline: 1px solid rgba(31,24,12,.05);   /* separador de filas de tabla */
--border-hairline-2: 1px solid rgba(31,24,12,.06); /* separador de header de tabla */
```

---

## 2. Sidebar lateral

Estructura (248px fijo, sticky, scroll interno, fondo oscuro):

```html
<aside style="position:sticky; top:0; height:100vh; flex:0 0 248px; width:248px;
              background:#1C150D; color:#fff; display:flex; flex-direction:column;
              padding:20px 14px 16px; overflow-y:auto;">

  <!-- Logo -->
  <a href="/inicio" style="display:flex; align-items:center; gap:11px; padding:4px 6px 18px; text-decoration:none;">
    <div style="width:38px; height:38px; border-radius:10px;
                background:linear-gradient(135deg,#F6D279,#E0B341,#B8860B);
                display:flex; align-items:center; justify-content:center;
                box-shadow:0 2px 10px rgba(184,134,11,.4);">
      <span style="font-family:'Fraunces',serif; font-weight:700; font-size:15px; color:#241A08; letter-spacing:-0.02em;">SP</span>
    </div>
    <div>
      <div style="font-family:'Fraunces',serif; font-size:14.5px; font-weight:600; letter-spacing:-0.01em; line-height:1.1; color:#F3EFE8;">Suminregio Parker</div>
      <div style="font-family:'DM Mono',monospace; font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:#8A7C64; margin-top:3px;">ERP · Scorecard</div>
    </div>
  </a>

  <!-- Encabezado de grupo -->
  <div style="font-family:'DM Mono',monospace; font-size:9px; letter-spacing:0.16em;
              text-transform:uppercase; color:#6E624E; padding:6px 10px 6px;">Panel</div>

  <!-- Item de nav — estado INACTIVO -->
  <nav style="display:flex; flex-direction:column; gap:1px;">
    <a href="/ventas" style="display:flex; align-items:center; gap:11px; padding:8px 11px;
              border-radius:9px; font-size:13px; font-weight:500; color:#9A938A;
              text-decoration:none; cursor:pointer; transition:background .15s,color .15s;">
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor"
           stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">...</svg>
      Ventas
    </a>
    <!-- ...11 items más: Cobradas, Vendedores, CxC, Clientes, Director, Inventario,
         Consumos, Margen, P&L (label "Finanzas"), Admin -->
  </nav>

  <!-- Segundo grupo -->
  <div style="font-family:'DM Mono',monospace; font-size:9px; letter-spacing:0.16em;
              text-transform:uppercase; color:#6E624E; padding:16px 10px 6px;">Inteligencia</div>
  <nav style="display:flex; flex-direction:column; gap:1px;">
    <!-- Sumi IA, Mejoras (Mejora Continua), Metas -->
  </nav>

  <!-- Usuario, siempre al fondo -->
  <div style="margin-top:auto; display:flex; align-items:center; gap:10px;
              padding:11px 8px 4px; border-top:1px solid rgba(255,255,255,.08); margin-top:18px;">
    <div style="width:33px; height:33px; border-radius:50%; background:#2C2013; color:#E0CBA8;
                display:flex; align-items:center; justify-content:center;
                font-size:11.5px; font-weight:700;">RM</div>
    <div>
      <div style="font-size:12.5px; font-weight:600; color:#E8E3DA; line-height:1.1;">R. Mendoza</div>
      <div style="font-size:10.5px; color:#8A7C64; margin-top:2px;">Dirección General</div>
    </div>
  </div>
</aside>
```

**Estados del item de navegación:**
```css
/* Inactivo */
.nav-item { color:#9A938A; background:transparent; }
.nav-item:hover { background:rgba(255,255,255,.06); color:#E8E3DA; }

/* Activo (página actual) — NO usa :hover, es el estado marcado */
.nav-item.active {
  color:#F2C667;
  font-weight:600;
  background:rgba(224,179,65,.15);
  box-shadow:inset 2px 0 0 #E0B341;  /* barra de acento a la izquierda, dentro del item */
}
```
Iconos: outline SVG 18×18, `stroke="currentColor"`, `stroke-width="1.6"`, `stroke-linecap/linejoin="round"` — así heredan el color de texto del link automáticamente (gris inactivo → dorado activo) sin duplicar CSS de color en el `<svg>`.

El layout general de página es `display:flex` con el `<aside>` fijo y un `<main style="flex:1; max-width:1480px; margin:0 auto;">` — nunca uses una barra de nav superior junto con este sidebar.

---

## 3. Componentes

### 3.1 Card base (contenedor genérico de sección)
```css
.sp-card {
  background: #fff; /* o linear-gradient(170deg,#FFFFFF,#FBF7EE) si contiene una gráfica */
  border: 1px solid rgba(31,24,12,.08);
  border-radius: 20px; /* 18px si es de tipo "compacta" (PL/Margen) */
  box-shadow: 0 16px 38px -24px rgba(40,28,12,.32);
  overflow: hidden; /* si contiene tabla de borde a borde */
  padding: 1.4rem 1.5rem; /* si NO es tabla — las tablas usan padding solo en el header */
  transition: box-shadow .26s cubic-bezier(.22,.7,.25,1),
              transform .26s cubic-bezier(.22,.7,.25,1),
              border-color .26s;
}
.sp-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 26px 54px -22px rgba(40,28,12,.34) !important;
  border-color: rgba(224,179,65,.4) !important;
}
```
Header interno de card con tabla (separado del body):
```html
<div style="display:flex; align-items:center; justify-content:space-between; padding:1.2rem 1.5rem 0.9rem;">
  <h3 style="font-family:'Fraunces'; font-size:1.15rem; font-weight:600; color:#211A10;">Título de la Sección</h3>
  <span style="font-family:'DM Mono'; font-size:0.62rem; color:#A2937A;">mes actual</span>
</div>
```

### 3.2 Tarjeta KPI
```html
<div class="sp-card" style="position:relative; padding:0.85rem 1rem 1rem; overflow:hidden;
            box-shadow:0 10px 24px -20px rgba(40,28,12,.3);">
  <!-- barra de acento superior de 3px, color = semántico del KPI -->
  <div style="position:absolute; top:0; left:0; right:0; height:3px; background:#B8860B;"></div>
  <span style="font-family:'DM Mono'; font-size:0.56rem; letter-spacing:0.09em;
               text-transform:uppercase; color:#9A8D76;">Eyebrow / Label</span>
  <div class="sp-count" style="font-family:'DM Mono'; font-size:1.55rem; font-weight:500;
              letter-spacing:-0.025em; color:#067647;">$1,391,490</div>
  <div style="font-family:'DM Mono'; font-size:0.6rem; color:#A2937A;">Texto secundario</div>
</div>
```
El color del valor (`vcolor`) y el color de la barra de acento (`accent`) casi siempre coinciden con el color semántico del dato (verde para positivo, ámbar para meta, gris para "sin datos").

### 3.3 Badge de estado (CUMPLIDO / ATENCION / ALERTA)
Usado en tarjetas de "Metas y Cumplimiento" y en cualquier chip de estado:
```css
.badge {
  font-family: 'DM Mono', monospace;
  font-size: 0.56rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 0.16rem 0.5rem;
  border-radius: 999px;
}
.badge--cumplido { color:#0E9F6E; background:#E7F6EF; }
.badge--atencion { color:#B45309; background:#FBF1DC; }
.badge--alerta   { color:#D92D20; background:#FEECEA; }
```
La tarjeta que envuelve el badge también lleva la barra de acento superior de 3px del mismo color semántico, y la barra de progreso interna (`height:6px; border-radius:999px; background:#F2ECDE`) rellena con ese mismo color.

### 3.4 Tabla
```css
thead th {
  text-align: left; /* o right para columnas numéricas */
  padding: 0.55rem 1.2rem; /* 1.5rem en la primera/última columna si la tabla no tiene scroll horizontal */
  font-family: 'DM Mono', monospace;
  font-size: 0.52rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #A2937A;
  font-weight: 500;
  border-top: 1px solid rgba(31,24,12,.06);
  border-bottom: 1px solid rgba(31,24,12,.06);
}
tbody td {
  padding: 0.55rem 1.2rem;
  font-size: 0.78rem;
  color: #211A10;
  border-bottom: 1px solid rgba(31,24,12,.05);
}
tbody td.mono { font-family:'DM Mono',monospace; } /* toda cifra numérica */
tbody tr:hover td { background: #FBF6EC; }
```
Columnas numéricas siempre `text-align:right` y fuente `DM Mono`. Rank/# en color dorado `#B8860B`.

### 3.5 Panel "hero" oscuro (usado para mensajes ejecutivos / Operación Inventario)
```css
.hero-panel {
  background: linear-gradient(135deg, rgba(246,210,121,.16), rgba(37,99,235,.06));
  /* variante alerta: linear-gradient(135deg, rgba(246,210,121,.14), rgba(217,45,32,.05)); */
  border: 1px solid rgba(184,134,11,.2);
  border-radius: 18px;
  padding: 1.3rem 1.5rem;
}
.hero-panel h2 { font-family:'Fraunces'; font-size:1.1rem; font-weight:600; color:#241A08; }
.hero-panel p  { font-size:0.86rem; color:#5A4F3C; line-height:1.55; }
```

### 3.6 Chips / filtros tipo pill (presets de fecha, tabs)
```html
<div style="display:flex; background:#FFFFFF; border:1px solid rgba(31,24,12,.09);
            border-radius:13px; padding:4px; gap:2px;
            box-shadow:0 6px 18px -12px rgba(40,28,12,.22);">
  <button class="sp-pill" style="border:none; padding:0.5rem 0.9rem; border-radius:9px;
          font-family:'DM Mono'; font-size:0.72rem; cursor:pointer;
          transition:background .25s ease, color .2s ease, border-color .25s ease;
          background:linear-gradient(135deg,#322310,#6A4A1C); color:#F6E7C8; font-weight:600;">
    Este Mes <!-- activo -->
  </button>
  <button class="sp-pill" style="/* mismo base */ background:transparent; color:#6E624E; font-weight:500;">
    Mes Anterior
  </button>
</div>
```

---

## 4. Sistema de animación

Todas las animaciones corren una sola vez al montar cada página (no en scroll), respetan `prefers-reduced-motion`, y usan Web Animations API (`el.animate()`) en vez de CSS `animation` para poder relanzarse de forma controlada sin duplicar keyframes por elemento.

### 4.1 Guard global
```css
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
```
```js
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return; // corta toda animación
```

### 4.2 Clases utilitarias (marca el elemento, la animación se dispara por JS)
- `.sp-rise` — elemento/sección que aparece con fade + slide-up al cargar.
- `.sp-grid` — contenedor de tarjetas: cada hijo hace rise con stagger.
- `.sp-bar-fill` — barra horizontal (progreso, comparativos) que crece de 0 a 100% width.
- `.sp-vbar` — barra vertical (gráficas de barras) que crece de 0 a 100% height.
- `.sp-draw` — `<path>`/`<polyline>` de una gráfica de línea que se "dibuja" con `stroke-dashoffset`.
- `.sp-count` — número que hace count-up animado desde 0 hasta el valor real (parseado del propio texto).

### 4.3 Motor (JS — pégalo en el `componentDidMount`/init de cada vista)
```js
function runEntranceAnimations(rootEl) {
  const ease = 'cubic-bezier(.18,.7,.25,1)';
  const easeBar = 'cubic-bezier(.3,.85,.3,1)';

  const rise = (el, delay) => {
    try {
      el.animate(
        [{ opacity: 0, transform: 'translateY(26px)' }, { opacity: 1, transform: 'none' }],
        { duration: 640, delay, easing: ease, fill: 'backwards' }
      );
    } catch (e) {}
  };

  rootEl.querySelectorAll('.sp-rise').forEach((el, i) => rise(el, 50 + i * 70));
  rootEl.querySelectorAll('.sp-grid').forEach(g =>
    [...g.children].forEach((c, i) => rise(c, 150 + i * 70))
  );

  rootEl.querySelectorAll('.sp-bar-fill').forEach((b, i) => {
    try {
      b.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
        { duration: 1000, delay: 300 + (i % 8) * 45, easing: easeBar, fill: 'backwards' });
    } catch (e) {}
  });

  rootEl.querySelectorAll('.sp-vbar').forEach((b, i) => {
    try {
      b.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
        { duration: 720, delay: 250 + (i % 24) * 30, easing: easeBar, fill: 'backwards' });
    } catch (e) {}
  });

  rootEl.querySelectorAll('.sp-draw').forEach(p => {
    try {
      const len = p.getTotalLength(); // funciona en <path> y <polyline>
      p.style.strokeDasharray = len;
      p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
        { duration: 1500, delay: 360, easing: 'cubic-bezier(.4,.6,.3,1)', fill: 'backwards' });
    } catch (e) {}
  });

  rootEl.querySelectorAll('.sp-count').forEach((el, i) => {
    const raw = (el.textContent || '').trim();
    const m = raw.match(/^([^\d-]*)(-?[\d,]+(?:\.\d+)?)(.*)$/); // separa prefijo ($), número, sufijo (%)
    if (!m) return;
    const pre = m[1], suf = m[3], dec = (m[2].split('.')[1] || '').length;
    const target = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(target)) return;
    const dur = 1100, t0 = performance.now() + 300 + (i % 8) * 55;
    const fmtN = v => v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    el.dataset.cv = raw; // valor final real, por si se corta antes de terminar
    const step = now => {
      let p = Math.max(0, Math.min(1, (now - t0) / dur));
      p = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = pre + fmtN(target * p) + suf;
      if (p < 1) requestAnimationFrame(step); else el.textContent = raw;
    };
    requestAnimationFrame(step);
  });
}

// Guard anti doble-disparo (StrictMode / re-render) + finalizador de seguridad
function initEntrance(rootId) {
  const root = document.getElementById(rootId);
  const guarded = () => {
    if (root && root.dataset.spAnimated) return;
    if (root) root.dataset.spAnimated = '1';
    runEntranceAnimations(root || document);
  };
  requestAnimationFrame(() => requestAnimationFrame(guarded));
  setTimeout(guarded, 170);
  // A los 2.8s, fuerza el estado final por si alguna animación quedó pendiente (tab en background, etc.)
  setTimeout(() => {
    try {
      const r = document.getElementById(rootId) || document;
      const finish = el => el.getAnimations && el.getAnimations().forEach(a => {
        if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish();
      });
      r.querySelectorAll('.sp-rise,.sp-bar-fill,.sp-vbar,.sp-draw').forEach(finish);
      r.querySelectorAll('.sp-grid').forEach(g => [...g.children].forEach(finish));
      r.querySelectorAll('.sp-count').forEach(el => { if (el.dataset.cv) el.textContent = el.dataset.cv; });
    } catch (e) {}
  }, 2800);
}
```
**Timing summary:** rise stagger ~70ms por elemento hermano, barras ~30–45ms de stagger, conteo numérico ~55ms de stagger, duración de línea dibujada 1.5s. Todo el "reveal" de una página tarda ~1.2–1.8s en completarse tras el load.

### 4.4 Micro-interacciones CSS (hover permanente, no de entrada)
```css
@keyframes sp-blink { 0%,100% { opacity:1 } 50% { opacity:.3 } } /* punto "en vivo" de un dato sin registro aún */
```
Hover de card ya cubierto en 3.1. Hover de fila de tabla y de nav-item usan `transition` normal, no WAAPI.

---

## 5. Cómo estilizar las gráficas Chart.js reales

La app real (`public/*.html`) usa **Chart.js** sobre `<canvas>` — los prototipos usan SVG a mano solo para poder iterar el diseño rápido, pero el look debe trasladarse a la config real de Chart.js **sin tocar los datasets/data ni los endpoints**. Aplica esta configuración global una vez (Chart.defaults) y estos estilos por tipo de dataset:

```js
// Config global — pégalo antes de instanciar cualquier chart
Chart.defaults.font.family = "'DM Mono', monospace";
Chart.defaults.font.size = 11;
Chart.defaults.color = '#A2937A';               // color de ejes/labels por defecto
Chart.defaults.borderColor = 'rgba(31,24,12,.06)'; // líneas de grid, muy sutiles
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 8;
Chart.defaults.plugins.legend.labels.font = { family: "'Outfit', sans-serif", size: 11, weight: '500' };

// Tooltip — card flotante consistente con el resto del sistema
Chart.defaults.plugins.tooltip = {
  backgroundColor: '#211A10',
  titleFont: { family: "'Fraunces', serif", size: 12, weight: '600' },
  bodyFont: { family: "'DM Mono', monospace", size: 11 },
  padding: 10,
  cornerRadius: 10,
  displayColors: true,
  boxPadding: 4,
};

// Grid — solo el eje Y, muy tenue; el eje X sin grid
function applyAxisStyle(scales) {
  if (scales.x) { scales.x.grid = { display:false }; scales.x.ticks = { color:'#A2937A' }; }
  if (scales.y) { scales.y.grid = { color:'rgba(31,24,12,.06)', drawTicks:false }; scales.y.ticks = { color:'#A2937A' }; }
}
```

**Colores por tipo de serie** (usa estos hex en `borderColor`/`backgroundColor` de cada dataset, según el dato que representen — no reinventes colores nuevos):
```js
const chartPalette = {
  primary:   { line: '#B8860B', fillFrom: 'rgba(224,179,65,.26)', fillTo: 'rgba(224,179,65,.02)' }, // dorado — serie principal / línea de tendencia
  positive:  { line: '#0E9F6E', fillFrom: 'rgba(14,159,110,.20)', fillTo: 'rgba(14,159,110,.02)' },  // verde — cobros, cumplido
  blue:      { line: '#2563EB', fillFrom: 'rgba(37,99,235,.20)',  fillTo: 'rgba(37,99,235,.02)' },   // ventas/industrial (VE)
  purple:    { line: '#7C5CFC', fillFrom: 'rgba(124,92,252,.26)', fillTo: 'rgba(124,92,252,.02)' },  // cotizaciones / mostrador (PV)
  warn:      { line: '#B45309' },  // atención / ratio gasto-venta
  danger:    { line: '#D92D20' },  // alertas / vencido
};

// Barras: usar gradiente lineal vertical, no color plano
function goldBarGradient(ctx, chartArea) {
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, '#F6D279');
  g.addColorStop(1, '#B8860B');
  return g;
}
```

**Reglas de estilo Chart.js por tipo de gráfica:**
- **Línea (tendencias diarias/mensuales):** `borderWidth:2.5`, `tension:0.35` (curva suave, no angular), `pointRadius:0` (sin puntos visibles salvo hover), `fill:true` con gradiente `fillFrom→fillTo` del color de la serie, `borderCapStyle:'round'`.
- **Barras (comparativos mensuales, rankings):** `borderRadius:4` (esquinas superiores redondeadas), `barPercentage:0.7`, sin borde (`borderWidth:0`), color = gradiente dorado vertical para la serie "propia/actual" y color sólido semitransparente (`rgba(184,134,11,.35)`) para series de comparación/histórico.
- **Dona/pie (distribución, riesgo):** `cutout:'68%'`, `borderWidth:3`, `borderColor:'#FFFFFF'` (separador blanco entre segmentos), colores = semáforo de estado (`--state-ok/warn/danger`) cuando el dato es de riesgo/cumplimiento, o la paleta categórica cuando es neutral.
- **Radar (si aplica, ej. cumplimiento por vendedor):** `pointBackgroundColor` = color de la serie, `angleLines.color:'rgba(31,24,12,.08)'`, `grid.color:'rgba(31,24,12,.06)'`.
- **Animación de entrada:** Chart.js trae su propio sistema (`animation.duration`); ajústalo a `900ms` con `easing:'easeOutCubic'` para que combine con el resto del reveal (`.sp-draw`/`.sp-bar-fill` de este doc). No dupliques con WAAPI sobre el propio canvas.

---

## Assets
Ningún asset de imagen — todos los íconos son SVG inline hechos a mano (outline, `stroke="currentColor"`, 16–18px). No hay logo en imagen; el logo es el bloque "SP" con gradiente dorado + tipografía Fraunces.

## Estructura de este paquete

```
design_handoff_visual_system/
├── README.md                       ← este documento (especificación completa)
├── design-system.css               ← TODO el CSS del sistema en un solo archivo:
│                                       tokens (:root), @import de fuentes, reset,
│                                       sidebar, cards, KPI, badges, tablas, hero,
│                                       pills/tabs, keyframes — listo para copiar/pegar
├── design-system-animations.js     ← motor de animación de entrada (vanilla JS,
│                                       sin dependencias), con initEntrance('rootId')
└── pages/                          ← las 15 páginas del diseño, CADA UNA completa
    ├── Login.dc.html                  y autónoma (abre sola en el navegador y
    ├── Inicio.dc.html                 renderiza el diseño real, con su propio CSS
    ├── Ventas.dc.html                 embebido en <style> — no dependen de
    ├── Cobradas.dc.html               design-system.css para verse; ese archivo
    ├── Vendedores.dc.html             es la referencia consolidada para que
    ├── CxC.dc.html                    apliques el sistema en el código real).
    ├── Clientes.dc.html
    ├── Director.dc.html
    ├── Inventario.dc.html
    ├── Consumos.dc.html
    ├── Margen.dc.html
    ├── PL.dc.html
    ├── MejoraContinua.dc.html
    ├── Admin.dc.html
    └── support.js                  ← motor de plantillas que usan estas 15 páginas
                                        para renderizar (cópialo junto con cualquier
                                        página que quieras abrir suelta; sin él las
                                        páginas no pintan, igual que una app React
                                        sin su bundle de runtime).
```

**Cómo usar `pages/`:** abre cualquier `.dc.html` directamente en el navegador (con `support.js` en la misma carpeta) para ver el diseño real aplicado a ese flujo/pantalla exacto, con datos de ejemplo, animaciones y todos los estados. Son la fuente de verdad pixel-a-pixel si algo no quedó explícito en las secciones 1–5 de este README.

**Cómo usar `design-system.css` + `design-system-animations.js`:** son la extracción reusable del sistema — pégalos (o su equivalente en el stack real, p. ej. como módulo CSS o `<style>` global) en la app de producción y aplica las clases documentadas (`.sp-card`, `.sp-kpi`, `.sp-badge--cumplido`, `.sp-sidebar`, etc.) a tu markup real, sin tocar la lógica/datos existentes. Llama a `SPAnimations.initEntrance('id-del-contenedor-raiz')` una vez que cada vista termine de pintar sus datos reales.
