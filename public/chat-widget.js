/**
 * chat-widget.js — Asistente IA flotante para dashboards Microsip
 * Inyectar en todas las páginas con: <script src="/chat-widget.js"></script>
 * Requiere: /chat-widget.css (se inyecta automáticamente)
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const API     = (typeof window !== 'undefined' && window.__API_BASE) ? window.__API_BASE : '';
  const PAGE    = (() => { try { return document.title.split('—')[0].trim() || location.pathname.split('/').pop(); } catch { return ''; } })();
  // DB dinámico: se resuelve en cada sendMessage para respetar el selector de negocio en vivo.
  function currentDb() {
    try {
      var fromUrl = new URLSearchParams(location.search).get('db');
      if (fromUrl) return fromUrl;
      var fromLs = (typeof localStorage !== 'undefined') && localStorage.getItem('currentDb');
      if (fromLs) return fromLs;
    } catch (_) {}
    return '';
  }

  // Sugerencias contextuales por página — enriquecidas con análisis profundo
  const SUGGESTIONS_BY_PAGE = {
    'Dashboard_Ventas': [
      '¿Cuánto llevamos de ventas hoy y este mes?',
      '¿Estamos en meta? Dame % de cumplimiento',
      'Proyección de cierre de mes (regresión lineal)',
      'Top 5 clientes del mes con ticket promedio',
      '¿Qué vendedor va mejor? Análisis 4D + ventas',
      'Dame un diagnóstico ejecutivo completo de ventas',
    ],
    'Dashboard_CC': [
      '¿Cuánto está vencido y qué % del total representa?',
      'Top 5 deudores con días vencidos',
      '¿Quién supera 60 y 90 días? Acción urgente',
      'DSO actual vs benchmark de 30 días',
      'Plan de cobranza para esta semana — prioridades',
      'Proyección de flujo de cobranza siguiente 30 días',
    ],
    'Dashboard_Scorecard': [
      '¿Quién va mejor en cumplimiento de meta?',
      'Perfil de Abel Cabrera: ventas + fortalezas 4D',
      'Perfil de Alejandro Medina: ventas + áreas de mejora',
      '¿Quién necesita coaching urgente según 4D?',
      'Análisis cruzado: ventas vs perfil psicométrico',
      '¿Qué dice Boostrategy sobre el equipo actual?',
    ],
    'Dashboard_Rentabilidad': [
      '¿Cuál es el margen bruto actual?',
      '¿Qué línea de producto tiene mejor margen?',
      '¿Qué vendedor vende con más margen?',
      'Tendencia del margen — ¿se está erosionando?',
    ],
    'Dashboard_Correlacion': [
      '¿Cuál es el ratio gasto/venta este mes?',
      'Análisis de correlación: R² y qué significa',
      'Tendencia del ratio en últimos 6 meses',
      'Recomendación: ¿reducir gastos o impulsar ventas?',
    ],
    'Dashboard_Estacionalidad': [
      '¿Cuáles son los 3 meses más fuertes históricamente?',
      'Índice estacional: ¿estamos en mes alto o bajo?',
      'YoY: ¿este mes va mejor o peor que el año pasado?',
      'Proyección del mes basada en patrón estacional',
    ],
    'Dashboard_Clientes': [
      'Pareto de clientes: ¿cuántos generan el 80% de ventas?',
      '¿Hay riesgo de concentración? Dame el índice HHI',
      'Clientes sin compra en los últimos 30 días',
      'Propón estrategia de cross-sell para top 10',
    ],
    'Dashboard_DSO': [
      '¿Cuál es el DSO actual y cómo se compara vs 30 días?',
      'Top 5 clientes con peor DSO',
      'Tendencia histórica del DSO',
      'Plan de acción para reducir DSO en 15 días',
    ],
    'Dashboard_Alertas': [
      '¿Cuáles son las alertas críticas activas ahora mismo?',
      '¿Qué artículos están en quiebre hoy?',
      'Clientes con CXC en estado crítico (> 90 días)',
      'Dame el resumen ejecutivo de todos los riesgos activos',
    ],
    'Dashboard_Rotacion': [
      '¿Cuál es la rotación de inventario actual?',
      'Días de inventario — ¿estamos por debajo de 45 días?',
      'Top 10 artículos con menor rotación',
      'Fill rate: ¿qué % de pedidos surtimos completos?',
    ],
    'Dashboard_Compras': [
      '¿Cuánto hemos comprado este mes vs el anterior?',
      'Top 5 proveedores por volumen de compra',
      '¿Hay compras urgentes por quiebres de inventario?',
      'Compras vs presupuesto — ¿hay desviación?',
    ],
    'consumos': [
      '¿Cuál es el ritmo de consumo diario este mes?',
      '¿Hay artículos en quiebre de consumo?',
      'Pareto: ¿qué 20% de artículos = 80% del consumo?',
      'Cobertura de inventario: ¿cuántos días de stock quedan?',
      'Cruza consumo vs OC pendientes — ¿hay brecha?',
      'Dame el diagnóstico completo de abastecimiento',
    ],
    'default': [
      '¿Cuánto llevamos de ventas hoy?',
      '¿Estamos en meta este mes?',
      '¿Cuánto está vencido en CXC?',
      '¿Cómo va el margen bruto?',
      'Top 5 vendedores del mes',
      'Proyección de cierre de mes',
      'Estado del inventario y quiebres',
      'Resumen ejecutivo completo del grupo',
    ],
  };

  function getSuggestions() {
    const path = location.pathname.split('/').pop() || '';
    const pageKey = Object.keys(SUGGESTIONS_BY_PAGE).find(k => PAGE.includes(k) || path.includes(k));
    return pageKey ? SUGGESTIONS_BY_PAGE[pageKey] : SUGGESTIONS_BY_PAGE['default'];
  }

  const SUGGESTIONS = getSuggestions();

  // ── Persistent chat history (localStorage) ──────────────────────────────
  const HISTORY_KEY = 'cw_chat_history_v2';
  function loadPersistedHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(-40) : []; // keep last 40 turns
    } catch (_) { return []; }
  }
  function persistHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-40))); } catch (_) {}
  }
  function clearPersistedHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (_) {}
    history = [];
  }

  let history  = loadPersistedHistory();
  let pendingImg = null;  // { dataUrl, base64 }
  let isOpen   = false;
  let isTyping = false;
  let activeTab = 'chat';
  let alertsCache = null;
  let lastFailedMessage = null; // para retry

  // ── Live DOM KPI Collector ─────────────────────────────────────────────────
  // Scrapes visible KPI values from the current dashboard page and returns a
  // compact summary string that gets injected into every AI request as context.
  function collectPageKpis() {
    const entries = [];
    const seen = new Set();

    function push(label, val) {
      if (!label || !val) return;
      const key = label.toLowerCase().trim();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(`${label.trim()}: ${String(val).trim()}`);
    }

    // 1. Elements with explicit data-kpi + data-val attributes (most reliable)
    document.querySelectorAll('[data-kpi][data-val]').forEach(el => {
      push(el.getAttribute('data-kpi'), el.getAttribute('data-val'));
    });

    // 2. KPI cards pattern: sibling .kpi-label / .kpi-title + .kpi-val / .kpi-value
    document.querySelectorAll('.kpi-val[data-val], .kpi-value[data-val], .kpi-num[data-val]').forEach(el => {
      const card = el.closest('.kpi-card, .kpi-item, .stat-card, [class*="kpi"]');
      const labelEl = card
        ? (card.querySelector('.kpi-label,.kpi-title,.kpi-name,.stat-label,.card-label') || null)
        : el.previousElementSibling;
      const label = labelEl ? labelEl.textContent : el.getAttribute('data-kpi') || el.id || 'KPI';
      push(label, el.getAttribute('data-val') || el.textContent);
    });

    // 3. Generic .kpi-val / .kpi-value without data-val — read textContent
    document.querySelectorAll('.kpi-val:not([data-val]), .kpi-value:not([data-val])').forEach(el => {
      const card = el.closest('.kpi-card, .kpi-item, .stat-card');
      if (!card) return;
      const labelEl = card.querySelector('.kpi-label,.kpi-title,.kpi-name,.stat-label');
      const label = labelEl ? labelEl.textContent : 'KPI';
      const val = el.textContent.replace(/\s+/g,' ').trim();
      if (val && val !== '—' && val !== '-') push(label, val);
    });

    // 4. Hero / big summary numbers (index.html style)
    document.querySelectorAll('.hero-num, .big-num, .uni-sum-pill').forEach(el => {
      const lbl = el.querySelector('.u-l, .hero-label, .big-label');
      const val = el.querySelector('.u-v, .hero-value, .big-value');
      if (lbl && val) push(lbl.textContent, val.textContent);
    });

    // 5. Stat pills / summary strip
    document.querySelectorAll('.stat-pill, .summary-pill, [class*="sum-pill"]').forEach(el => {
      const lbl = el.querySelector('[class*="label"],[class*="name"]');
      const val = el.querySelector('[class*="val"],[class*="value"],[class*="num"]');
      if (lbl && val) push(lbl.textContent, val.textContent);
    });

    if (!entries.length) return null;
    return entries.slice(0, 20).join('\n');
  }

  // ── CSS injection ─────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('cw-css')) return;
    const link = document.createElement('link');
    link.id   = 'cw-css';
    link.rel  = 'stylesheet';
    link.href = (API || '') + '/chat-widget.css';
    document.head.appendChild(link);
  }

  // ── HTML del widget ──────────────────────────────────────────────────────
  function buildHtml() {
    return `
<button id="cw-fab" title="Asistente IA" aria-label="Abrir asistente IA">🤖</button>
<div id="cw-panel" role="dialog" aria-label="Asistente IA">

  <div id="cw-header">
    <div id="cw-header-icon">🤖</div>
    <div id="cw-header-info">
      <div id="cw-header-title">Asistente IA — ERP</div>
      <div id="cw-header-sub">Cargando datos en tiempo real…</div>
    </div>
    <div id="cw-status-dot" title="Conectado"></div>
    <div id="cw-header-actions">
      <button class="cw-hbtn" id="cw-clear-history" title="Borrar historial">🗑</button>
      <button class="cw-hbtn" id="cw-refresh-btn" title="Actualizar datos">↻</button>
      <button class="cw-hbtn" id="cw-minimize" title="Minimizar">✕</button>
    </div>
  </div>

  <div id="cw-tabs">
    <div class="cw-tab active" data-tab="chat">💬 Chat</div>
    <div class="cw-tab" data-tab="alerts">🔔 Alertas</div>
    <div class="cw-tab" data-tab="kpis">📊 KPIs</div>
  </div>

  <!-- Chat Tab -->
  <div id="cw-msgs"></div>

  <!-- Alerts Tab -->
  <div id="cw-alerts-panel"></div>

  <!-- KPIs Tab -->
  <div id="cw-kpis-panel" style="display:none;flex:1;overflow-y:auto;padding:12px"></div>

  <!-- Quick action buttons (chat mode only) -->
  <div id="cw-quick-actions">
    <button class="cw-qa-btn" data-q="Dame el resumen ejecutivo completo de hoy">📋 Resumen hoy</button>
    <button class="cw-qa-btn" data-q="¿Estamos en meta? Dame % de cumplimiento">🎯 Meta</button>
    <button class="cw-qa-btn" data-q="¿Cuánto está vencido en CXC y qué % representa?">💰 CXC</button>
    <button class="cw-qa-btn" data-q="Top 5 vendedores del mes con cumplimiento">🏆 Top 5</button>
    <button class="cw-qa-btn" data-q="Proyección de cierre de mes (regresión lineal)">📈 Proyección</button>
    <button class="cw-qa-btn" data-q="¿Cuál es el margen bruto actual?">📊 Margen</button>
  </div>

  <div id="cw-suggestions"></div>
  <div id="cw-img-preview">
    <img id="cw-img-thumb" src="" alt="captura"/>
    <span id="cw-img-preview-label">Captura adjunta al próximo mensaje</span>
    <button id="cw-img-clear" title="Quitar imagen">✕</button>
  </div>
  <div id="cw-send-alert-btns" style="display:none">
    <button class="cw-action-btn email"    id="cw-send-email"    >📧 Email</button>
    <button class="cw-action-btn whatsapp" id="cw-send-wa"       >💬 WhatsApp</button>
    <button class="cw-action-btn both"     id="cw-send-both"     >🔔 Ambos</button>
  </div>
  <div id="cw-input-area">
    <button id="cw-img-btn" title="Capturar pantalla y adjuntar al mensaje">📷</button>
    <textarea id="cw-input" placeholder="Pregunta algo sobre ventas, CXC, resultados…" rows="1"></textarea>
    <button id="cw-send" title="Enviar">➤</button>
  </div>

</div>`;
  }

  // ── Render helpers ────────────────────────────────────────────────────────
  function $ (id) { return document.getElementById(id); }

  function scrollBottom() {
    const el = $('cw-msgs');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /** Convierte markdown básico a HTML — con soporte para tablas GFM, listas y formato */
  function mdToHtml(text) {
    // 1. Escapar HTML primero
    let s = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // 2. Tablas GFM — detectar bloques | col | col |
    s = s.replace(/((?:^\|.+\|[ \t]*\n?)+)/gm, (tableBlock) => {
      const rows = tableBlock.trim().split('\n').filter(r => r.trim().startsWith('|'));
      if (rows.length < 2) return tableBlock;
      const isSep = r => /^\|[\s\|:\-]+\|$/.test(r.trim());
      let html = '<table>';
      let inBody = false;
      rows.forEach((row, i) => {
        if (isSep(row)) { inBody = true; return; }
        const cells = row.replace(/^\||\|$/g,'').split('|').map(c => c.trim());
        if (!inBody && i === 0) {
          html += '<thead><tr>' + cells.map(c=>`<th>${c}</th>`).join('') + '</tr></thead><tbody>';
        } else {
          html += '<tr>' + cells.map(c=>`<td>${c}</td>`).join('') + '</tr>';
        }
      });
      html += '</tbody></table>';
      return html;
    });

    // 3. Encabezados
    s = s
      .replace(/^### (.+)$/gm,'<strong style="color:#E6A800;display:block;margin:6px 0 2px">$1</strong>')
      .replace(/^## (.+)$/gm,'<strong style="display:block;margin:8px 0 3px;font-size:1.05em">$1</strong>');

    // 4. Negrita + itálica
    s = s
      .replace(/\*\*\*(.*?)\*\*\*/g,'<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,'<em>$1</em>')
      .replace(/_(.*?)_/g,'<em>$1</em>');

    // 5. Código inline
    s = s.replace(/`([^`]+)`/g,'<code style="background:rgba(255,255,255,.08);padding:1px 6px;border-radius:3px;font-family:monospace;font-size:.88em">$1</code>');

    // 6. Listas
    s = s
      .replace(/^[\-\*] (.+)$/gm,'<div style="padding-left:12px;margin:2px 0">• $1</div>')
      .replace(/^\d+\. (.+)$/gm,'<div style="padding-left:12px;margin:2px 0">$1</div>');

    // 7. Emojis semáforo
    s = s
      .replace(/🔴/g,'<span style="color:#ef4444">🔴</span>')
      .replace(/🟡/g,'<span style="color:#f59e0b">🟡</span>')
      .replace(/🟢/g,'<span style="color:#22c55e">🟢</span>')
      .replace(/⚠️/g,'<span style="color:#f59e0b">⚠️</span>')
      .replace(/✅/g,'<span style="color:#22c55e">✅</span>')
      .replace(/🚨/g,'<span style="color:#ef4444">🚨</span>');

    // 8. HR + newlines (no dentro de tablas ya procesadas)
    s = s
      .replace(/^---$/gm,'<hr style="border:none;border-top:1px solid rgba(255,255,255,.1);margin:6px 0">')
      .replace(/\n/g,'<br>');

    return s;
  }

  function addMessage(role, text, imgDataUrl, opts = {}) {
    const msgs = $('cw-msgs');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'cw-msg ' + role;

    const now = new Date();
    const ts = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    div.setAttribute('data-ts', now.toISOString());

    const avatarIcon = role === 'ai' ? '🤖' : '👤';
    let bubbleContent = mdToHtml(text);
    if (imgDataUrl && role === 'user') {
      bubbleContent += `<br><img src="${imgDataUrl}" style="margin-top:6px;max-width:200px;border-radius:6px;border:1px solid #1e3a5f" alt="captura"/>`;
    }
    // Retry button for error messages
    const isError = opts.isError || (role === 'ai' && /^[⚠️📶⏱]/.test(text.trim()));
    const retryHtml = (isError && lastFailedMessage)
      ? `<div style="margin-top:6px"><button class="cw-retry-btn" onclick="this.closest('.cw-msg').dispatchEvent(new CustomEvent('cw:retry',{bubbles:true}))">↺ Reintentar</button></div>`
      : '';
    const tsHtml = `<span class="cw-msg-ts">${ts}</span>`;

    div.innerHTML = `
      <div class="cw-msg-avatar">${avatarIcon}</div>
      <div class="cw-msg-bubble">${bubbleContent}${retryHtml}${tsHtml}</div>`;

    if (isError && lastFailedMessage) {
      const failedMsg = lastFailedMessage;
      div.addEventListener('cw:retry', () => {
        div.remove();
        sendMessage(failedMsg);
      });
    }
    msgs.appendChild(div);
    if (!opts.noHistory) {
      history.push({ role: role === 'ai' ? 'assistant' : 'user', content: text });
      persistHistory();
    }
    scrollBottom();
  }

  function showTyping() {
    const msgs = $('cw-msgs');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'cw-msg ai cw-typing';
    div.id = 'cw-typing-indicator';
    div.innerHTML = `<div class="cw-msg-avatar">🤖</div><div class="cw-msg-bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
    msgs.appendChild(div);
    scrollBottom();
  }

  function removeTyping() {
    const el = $('cw-typing-indicator');
    if (el) el.remove();
  }

  function setStatus(text, ok) {
    const sub = document.querySelector('#cw-header-sub');
    const dot = $('cw-status-dot');
    if (sub) sub.textContent = text;
    if (dot) {
      dot.style.background = ok === false ? '#ef4444' : '#22c55e';
      dot.style.boxShadow  = `0 0 6px ${ok === false ? '#ef4444' : '#22c55e'}`;
    }
  }

  // ── Captura de pantalla (html2canvas CDN) ─────────────────────────────────
  function captureScreen() {
    return new Promise((resolve, reject) => {
      // Cargar html2canvas si no existe
      if (typeof window.html2canvas !== 'undefined') {
        doCapture(resolve, reject);
        return;
      }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      s.onload  = () => doCapture(resolve, reject);
      s.onerror = () => reject(new Error('No se pudo cargar html2canvas'));
      document.head.appendChild(s);
    });
  }

  function doCapture(resolve, reject) {
    // Ocultar el widget antes de capturar
    const panel = $('cw-panel');
    const fab   = $('cw-fab');
    if (panel) panel.style.visibility = 'hidden';
    if (fab)   fab.style.visibility   = 'hidden';

    window.html2canvas(document.body, {
      useCORS: true, allowTaint: true, scale: 1.2,
      backgroundColor: '#0a1628',
      ignoreElements: el => el.id === 'cw-panel' || el.id === 'cw-fab',
    }).then(canvas => {
      if (panel) panel.style.visibility = '';
      if (fab)   fab.style.visibility   = '';
      const dataUrl = canvas.toDataURL('image/png', 0.85);
      resolve(dataUrl);
    }).catch(e => {
      if (panel) panel.style.visibility = '';
      if (fab)   fab.style.visibility   = '';
      reject(e);
    });
  }

  // ── Enviar mensaje al backend AI ─────────────────────────────────────────
  async function sendMessage(text) {
    if (!text.trim() || isTyping) return;
    isTyping = true;
    lastFailedMessage = null;

    const imgDataUrl = pendingImg ? pendingImg.dataUrl : null;
    const imgBase64  = pendingImg ? pendingImg.base64  : null;
    pendingImg = null;
    clearImgPreview();

    addMessage('user', text, imgDataUrl);
    clearInput();
    showTyping();
    hideSuggestions();
    hideQuickActions();

    try {
      // Historial en formato que espera el servidor (sin el último turno user ya agregado)
      const prevHistory = history.slice(-14).slice(0, -1);
      // Inyectar KPIs vivos del DOM para que el LLM tenga contexto actual sin consultas extra
      const liveKpis = collectPageKpis();
      const body = {
        message   : text,
        context   : {
          page: PAGE,
          url: location.pathname,
          ...(liveKpis ? { pageKpis: liveKpis } : {}),
        },
        messages  : prevHistory.map(h => ({ role: h.role, content: h.content })),
      };
      var _db = currentDb(); if (_db) body.db = _db;
      if (imgBase64) {
        body.imageBase64    = imgBase64;
        body.imageMimeType  = 'image/png';
      }

      const resp = await fetch(API + '/api/ai/chat', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify(body),
        signal : AbortSignal.timeout(90000),
      });

      removeTyping();

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const errCode = resp.status;
        let errMsg;
        if (errCode === 401 || errCode === 403) {
          errMsg = '🔑 Error de autenticación con el servidor IA. Contacta al administrador.';
        } else if (errCode === 429) {
          errMsg = '⏳ Demasiadas solicitudes. Espera unos segundos e intenta de nuevo.';
        } else if (errCode >= 500) {
          errMsg = `⚠️ El servidor IA encontró un problema interno (${errCode}). Intenta de nuevo en unos segundos.`;
          if (err.error) errMsg += `\n\nDetalle técnico: ${String(err.error).slice(0, 120)}`;
        } else {
          errMsg = `⚠️ Error ${errCode}: ${err.error || err.message || 'Error desconocido'}`;
        }
        addMessage('ai', errMsg);
        setStatus('Error temporal', false);
        setTimeout(() => setStatus('Conectado', true), 5000);
      } else {
        const data = await resp.json();
        // El servidor puede devolver { reply } (formato actual) o { response } (nuevo)
        const reply = data.reply || data.response || '(Sin respuesta)';
        addMessage('ai', reply);
        setStatus('Conectado', true);
      }
    } catch (e) {
      removeTyping();
      lastFailedMessage = text; // habilita botón retry
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        const fallback = await quickFallbackReply(text);
        if (fallback) {
          addMessage('ai', fallback + '\n\n_Nota: la capa IA tardó más de lo esperado; te mostré datos directos del sistema._');
        } else {
          addMessage('ai', '⏱ La consulta tardó demasiado. Intenta de nuevo o haz una pregunta más específica.\n\nSugerencia: _"ventas hoy"_, _"CXC vencida"_, _"resumen del mes"_.', null, { isError: true });
        }
      } else if (e.message && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError'))) {
        addMessage('ai', '📶 Sin conexión al servidor IA. Verifica que el servicio esté corriendo.', null, { isError: true });
        setStatus('Sin conexión', false);
      } else {
        addMessage('ai', `⚠️ Error de conexión: ${e.message || 'Error desconocido'}`, null, { isError: true });
        setStatus('Sin conexión', false);
      }
      setTimeout(() => setStatus('Reconectando…', null), 3000);
    } finally {
      isTyping = false;
    }
  }

  // ── Tab: Alertas ──────────────────────────────────────────────────────────
  async function loadAlerts() {
    const panel = $('cw-alerts-panel');
    if (!panel) return;
    panel.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;font-size:12px">🔄 Verificando KPIs…</div>';

    try {
      const resp = await fetch(API + '/api/alerts/check' + (DB_PARAM ? '?db=' + DB_PARAM : ''), {
        signal: AbortSignal.timeout(45000),
      });
      const data = await resp.json();
      alertsCache  = data;
      renderAlerts(data);
    } catch (e) {
      panel.innerHTML = `<div style="padding:16px;color:#ef4444;font-size:12px">Error: ${e.message}</div>`;
    }
  }

  function renderAlerts(data) {
    const panel = $('cw-alerts-panel');
    const fab   = $('cw-fab');
    if (!panel) return;

    const alertas = data.alertas || [];
    if (fab) fab.classList.toggle('has-badge', alertas.length > 0);

    if (!alertas.length) {
      panel.innerHTML = `<div style="padding:20px;text-align:center">
        <div style="font-size:28px;margin-bottom:8px">✅</div>
        <div style="color:#22c55e;font-size:13px;font-weight:700">Todos los KPIs en rango</div>
        <div style="color:#64748b;font-size:11px;margin-top:4px">${data.fecha || ''}</div>
      </div>`;
    } else {
      panel.innerHTML = alertas.map(a => `
        <div class="cw-alert-item">
          <div class="cw-alert-mod">⚠️ ${escHtml(a.modulo)}</div>
          <div class="cw-alert-desc">${escHtml(a.descripcion)}</div>
          <div class="cw-alert-val">${escHtml(a.valor)}</div>
        </div>`).join('');
    }
  }

  // ── Tab: KPIs ─────────────────────────────────────────────────────────────
  async function loadKpis() {
    const panel = $('cw-kpis-panel');
    if (!panel) return;
    panel.innerHTML = '<div style="padding:20px;text-align:center;color:#64748b;font-size:12px">🔄 Cargando KPIs…</div>';

    try {
      // Mostrar KPIs del DOM (instantáneo, sin fetch)
      const domKpis = collectPageKpis();
      let domSection = '';
      if (domKpis) {
        const domLines = domKpis.split('\n').filter(Boolean).slice(0, 12);
        domSection = `<div class="cw-kpi-card">
          <div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:6px;text-transform:uppercase">🖥️ Dashboard actual</div>
          ${domLines.map(line => {
            const [label, ...rest] = line.split(':');
            return kpiRow(label.trim(), rest.join(':').trim());
          }).join('')}
        </div>`;
        panel.innerHTML = domSection + '<div style="padding:12px;text-align:center;color:#64748b;font-size:11px">🔄 Cargando datos de sistema…</div>';
      }

      // Usar alertsCache si ya fue cargado
      const data = alertsCache || await fetch(API + '/api/alerts/check' + (DB_PARAM ? '?db=' + DB_PARAM : ''), { signal: AbortSignal.timeout(30000) })
        .then(r => r.json());
      const { ventas, cxc, pnl, metas } = data.kpis || {};
      const v = ventas || {}; const c = cxc || {}; const p = pnl?.totales || {};
      const fmtM = n => { if (n == null || isNaN(+n)) return 'N/D'; n = +n; if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2)+'M'; if (Math.abs(n)>=1e3) return '$'+(n/1e3).toFixed(1)+'K'; return '$'+Math.round(n).toLocaleString(); };
      const fmtP = n => (n == null||isNaN(+n)) ? 'N/D' : (+n).toFixed(1)+'%';

      panel.innerHTML = (domSection || '') + `
        <div class="cw-kpi-card">
          <div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:6px;text-transform:uppercase">📊 Ventas</div>
          ${kpiRow('Venta mes', fmtM(v.TOTAL_MES||v.VENTA_MES))}
          ${kpiRow('Meta mensual', fmtM(metas?.META_TOTAL_MENSUAL))}
          ${kpiRow('Cumplimiento', fmtP(v.CUMPL_PCT), +v.CUMPL_PCT >= 80)}
          ${kpiRow('Venta hoy', fmtM(v.TOTAL_HOY||v.VENTA_HOY))}
        </div>
        <div class="cw-kpi-card">
          <div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:6px;text-transform:uppercase">💰 CXC</div>
          ${kpiRow('Saldo total', fmtM(c.SALDO_TOTAL))}
          ${kpiRow('Vencido', fmtM(c.VENCIDO), c.SALDO_TOTAL > 0 ? (c.VENCIDO/c.SALDO_TOTAL*100) < 30 : true)}
          ${kpiRow('% Vencido', fmtP(c.SALDO_TOTAL>0?c.VENCIDO/c.SALDO_TOTAL*100:0), c.SALDO_TOTAL>0?c.VENCIDO/c.SALDO_TOTAL*100<30:true)}
          ${kpiRow('Clientes', c.NUM_CLIENTES)}
        </div>
        <div class="cw-kpi-card">
          <div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:6px;text-transform:uppercase">📈 Resultados</div>
          ${kpiRow('Ventas netas (3m)', fmtM(p.VENTAS_NETAS))}
          ${kpiRow('Costo ventas', fmtM(p.COSTO_VENTAS))}
          ${kpiRow('Utilidad bruta', fmtM(p.UTILIDAD_BRUTA))}
          ${kpiRow('Margen bruto', fmtP(p.MARGEN_BRUTO_PCT), +p.MARGEN_BRUTO_PCT >= 25)}
          ${kpiRow('Cobros (3m)', fmtM(p.COBROS))}
        </div>`;
    } catch (e) {
      panel.innerHTML = `<div style="padding:12px;color:#ef4444;font-size:12px">Error: ${e.message}</div>`;
    }
  }

  function kpiRow(label, val, ok) {
    const cls = ok === undefined ? '' : ok ? 'cw-kpi-ok' : 'cw-kpi-warn';
    return `<div class="cw-kpi-row">
      <span class="cw-kpi-label">${label}</span>
      <span class="cw-kpi-val ${cls}">${val}</span>
    </div>`;
  }

  // ── Enviar alerta manual ─────────────────────────────────────────────────
  async function sendAlertNow(channels) {
    const btns = ['cw-send-email','cw-send-wa','cw-send-both'];
    btns.forEach(id => { const b = $(id); if(b) b.disabled = true; });

    try {
      const resp = await fetch(API + '/api/alerts/send', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ channels, db: DB_PARAM || undefined, captureScreenshots: true }),
        signal : AbortSignal.timeout(90000),
      });
      const data = await resp.json();
      if (data.ok || !data.error) {
        addMessage('ai', `✅ Alerta enviada correctamente.\n${data.result?.email ? '📧 Email: ' + (data.result.email.recipients||[]).join(', ') : ''}\n${data.result?.whatsapp ? '💬 WhatsApp: ' + data.result.whatsapp.map(r=>r.to).join(', ') : ''}`);
        switchTab('chat');
      } else {
        addMessage('ai', `⚠️ Error al enviar: ${data.error}`);
      }
    } catch (e) {
      addMessage('ai', `⚠️ Error: ${e.message}`);
    } finally {
      btns.forEach(id => { const b = $(id); if(b) b.disabled = false; });
    }
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────
  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.cw-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('cw-msgs').classList.toggle('hidden', tab !== 'chat');
    const alertPanel  = $('cw-alerts-panel');
    const kpiPanel    = $('cw-kpis-panel');
    const sugPanel    = $('cw-suggestions');
    const inputArea   = $('cw-input-area');
    const alertBtns   = $('cw-send-alert-btns');
    const imgPreview  = $('cw-img-preview');
    const quickAct    = $('cw-quick-actions');

    if (alertPanel) { alertPanel.classList.toggle('active', tab === 'alerts'); }
    if (kpiPanel)   { kpiPanel.style.display    = tab === 'kpis'    ? 'block' : 'none'; }
    if (sugPanel)   { sugPanel.style.display     = tab === 'chat'    ? 'flex'  : 'none'; }
    if (inputArea)  { inputArea.style.display    = tab === 'chat'    ? 'flex'  : 'none'; }
    if (alertBtns)  { alertBtns.style.display    = tab === 'alerts'  ? 'flex'  : 'none'; }
    if (imgPreview) { imgPreview.classList.toggle('visible', tab === 'chat' && !!pendingImg); }
    if (quickAct)   { quickAct.style.display     = tab === 'chat'    ? 'flex'  : 'none'; }

    if (tab === 'alerts') loadAlerts();
    if (tab === 'kpis')   loadKpis();
  }

  // ── Sugerencias ──────────────────────────────────────────────────────────
  function renderSuggestions() {
    const el = $('cw-suggestions');
    if (!el) return;
    el.innerHTML = SUGGESTIONS.map(s =>
      `<div class="cw-chip" data-text="${escHtml(s)}">${escHtml(s)}</div>`
    ).join('');
    el.querySelectorAll('.cw-chip').forEach(c =>
      c.addEventListener('click', () => {
        const txt = c.getAttribute('data-text');
        $('cw-input').value = txt;
        sendMessage(txt);
      })
    );
  }

  function hideSuggestions() {
    const el = $('cw-suggestions');
    if (el) el.innerHTML = '';
  }

  function hideQuickActions() {
    const el = $('cw-quick-actions');
    if (el) el.style.display = 'none';
  }

  function showQuickActions() {
    const el = $('cw-quick-actions');
    if (el) el.style.display = 'flex';
  }

  function clearInput() {
    const inp = $('cw-input');
    if (inp) { inp.value = ''; inp.style.height = 'auto'; }
  }

  function clearImgPreview() {
    pendingImg = null;
    const prev = $('cw-img-preview');
    if (prev) prev.classList.remove('visible');
    const btn = $('cw-img-btn');
    if (btn) btn.classList.remove('active');
  }

  function fmtMoneyFull(v) {
    const n = Number(v || 0);
    return n.toLocaleString('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  async function quickFallbackReply(userText) {
    const t = String(userText || '').toLowerCase();
    const isVentas = /\b(ventas?|facturaci[oó]n|vendid[oa]s?)\b/i.test(t);
    const isCxc = /\b(cxc|cuentas?\s+por\s+cobrar|deudores?|vencid[oa]s?)\b/i.test(t);
    const isResultados = /\b(resultados?|pnl|estado\s+de\s+resultados|margen|utilidad)\b/i.test(t);
    if (!isVentas && !isCxc && !isResultados) return null;

    const qs = DB_PARAM ? `?db=${encodeURIComponent(DB_PARAM)}` : '';
    try {
      if (isVentas) {
        const resp = await fetch(API + '/api/ventas/resumen' + qs, { signal: AbortSignal.timeout(20000) });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data) {
          const hoy = Number(data.TOTAL_HOY || data.VENTA_HOY || 0);
          const mes = Number(data.TOTAL_MES || data.VENTA_MES || 0);
          const fact = Number(data.NUM_FACTURAS_MES || data.FACTURAS_MES || 0);
          return `Ventas (fallback rápido):\n- Hoy: ${fmtMoneyFull(hoy)}\n- Mes: ${fmtMoneyFull(mes)}\n- Facturas mes: ${fact.toLocaleString('es-MX')}`;
        }
      }
      if (isCxc) {
        const resp = await fetch(API + '/api/cxc/resumen-aging' + qs, { signal: AbortSignal.timeout(20000) });
        const snap = await resp.json().catch(() => ({}));
        if (resp.ok && snap && (snap.resumen || snap.SALDO_TOTAL != null)) {
          let data = snap.resumen && typeof snap.resumen === 'object' ? { ...snap.resumen } : { ...snap };
          const aging = snap.aging && typeof snap.aging === 'object' ? snap.aging : {};
          if (typeof window.reconcileCxcResumenWithAging === 'function') {
            data = window.reconcileCxcResumenWithAging(data, aging);
          } else {
            const v0 = Number(data.VENCIDO || 0);
            const mora =
              Number(aging.DIAS_1_30 || 0) +
              Number(aging.DIAS_31_60 || 0) +
              Number(aging.DIAS_61_90 || 0) +
              Number(aging.DIAS_MAS_90 || 0);
            const corA = Number(aging.CORRIENTE || 0);
            if (v0 <= 0.005 && mora > 0.005) {
              data.VENCIDO = mora;
              if (Number(data.POR_VENCER || 0) <= 0.005) data.POR_VENCER = corA;
            }
          }
          const saldo = Number(data.SALDO_TOTAL || 0);
          const venc = Number(data.VENCIDO || 0);
          const corriente = Number(data.CORRIENTE || data.POR_VENCER || data.VIGENTE || 0);
          return `CxC (fallback rápido):\n- Saldo total: ${fmtMoneyFull(saldo)}\n- Vencido: ${fmtMoneyFull(venc)}\n- Corriente/Por vencer: ${fmtMoneyFull(corriente)}`;
        }
      }
      if (isResultados) {
        const resp = await fetch(API + '/api/resultados/pnl' + qs, { signal: AbortSignal.timeout(25000) });
        const data = await resp.json().catch(() => ({}));
        const ttot = (data && data.totales) || {};
        if (resp.ok && Object.keys(ttot).length) {
          return `Resultados (fallback rápido):\n- Ventas netas: ${fmtMoneyFull(ttot.VENTAS_NETAS)}\n- Costo de ventas: ${fmtMoneyFull(ttot.COSTO_VENTAS)}\n- Utilidad bruta: ${fmtMoneyFull(ttot.UTILIDAD_BRUTA)}\n- Margen bruto: ${Number(ttot.MARGEN_BRUTO_PCT || 0).toFixed(2)}%`;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  // ── Bienvenida ────────────────────────────────────────────────────────────
  function showWelcome() {
    const today = new Date().toLocaleDateString('es-MX', { weekday:'short', month:'short', day:'numeric' });
    addMessage('ai', `👋 Hola, soy tu asistente IA de ${PAGE || 'ERP'} conectado en tiempo real a la base de datos Microsip.\n\n📅 ${today} — ¿En qué te puedo ayudar hoy?\n\nPuedo responder sobre ventas, CXC, estado de resultados, vendedores, inventario y más. También puedes capturar la pantalla con 📷 para que analice los gráficos.`);
    setStatus('Conectado · datos en tiempo real', true);
  }

  // ── Inicialización ────────────────────────────────────────────────────────
  function init() {
    injectCss();

    const wrapper = document.createElement('div');
    wrapper.id = 'cw-root';
    wrapper.innerHTML = buildHtml();
    document.body.appendChild(wrapper);

    const fab   = $('cw-fab');
    const panel = $('cw-panel');
    const input = $('cw-input');
    const send  = $('cw-send');

    // Botón borrar historial
    const clearHistBtn = $('cw-clear-history');
    if (clearHistBtn) {
      clearHistBtn.addEventListener('click', () => {
        clearPersistedHistory();
        const msgs = $('cw-msgs');
        if (msgs) msgs.innerHTML = '';
        showWelcome();
        renderSuggestions();
        showQuickActions();
      });
    }

    // Quick action buttons
    const qaContainer = $('cw-quick-actions');
    if (qaContainer) {
      qaContainer.querySelectorAll('.cw-qa-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const q = btn.getAttribute('data-q');
          if (q) {
            $('cw-input').value = q;
            sendMessage(q);
          }
        });
      });
    }

    // Abrir / cerrar
    fab.addEventListener('click', () => {
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      fab.textContent = isOpen ? '✕' : '🤖';
      if (isOpen && history.length === 0) {
        showWelcome();
        renderSuggestions();
        showQuickActions();
        // Verificar estado de alertas en background
        fetch(API + '/api/alerts/check' + (DB_PARAM ? '?db=' + DB_PARAM : ''), { signal: AbortSignal.timeout(30000) })
          .then(r => r.json())
          .then(data => {
            alertsCache = data;
            if (data.alertas && data.alertas.length > 0) {
              fab.classList.add('has-badge');
              setStatus(`⚠️ ${data.alertas.length} alerta(s) activa(s)`, false);
            } else {
              setStatus('✅ KPIs en rango · tiempo real', true);
            }
          })
          .catch(() => setStatus('Conectado', true));
      }
    });

    $('cw-minimize').addEventListener('click', () => {
      isOpen = false;
      panel.classList.remove('open');
      fab.textContent = '🤖';
    });

    // Refresh de datos
    $('cw-refresh-btn').addEventListener('click', () => {
      alertsCache = null;
      setStatus('Actualizando…');
      if (activeTab === 'alerts') loadAlerts();
      else if (activeTab === 'kpis') loadKpis();
      else {
        addMessage('ai', '🔄 Actualizando datos en tiempo real…');
        fetch(API + '/api/alerts/check' + (DB_PARAM ? '?db=' + DB_PARAM : ''), { signal: AbortSignal.timeout(30000) })
          .then(r => r.json())
          .then(data => {
            alertsCache = data;
            const n = (data.alertas||[]).length;
            addMessage('ai', n > 0
              ? `⚠️ ${n} alerta(s) activa(s):\n` + data.alertas.map(a => `• ${a.modulo}: ${a.descripcion} → ${a.valor}`).join('\n')
              : '✅ Todos los KPIs están dentro de rango.');
            setStatus(n > 0 ? `⚠️ ${n} alerta(s)` : '✅ KPIs en rango', n === 0);
          }).catch(e => addMessage('ai', `Error actualizando: ${e.message}`));
      }
    });

    // Tabs
    document.querySelectorAll('.cw-tab').forEach(t =>
      t.addEventListener('click', () => switchTab(t.dataset.tab))
    );

    // Botones de envío de alerta
    $('cw-send-email').addEventListener('click', () => sendAlertNow(['email']));
    $('cw-send-wa').addEventListener('click',    () => sendAlertNow(['whatsapp']));
    $('cw-send-both').addEventListener('click',  () => sendAlertNow(['email','whatsapp']));

    // Captura de pantalla
    $('cw-img-btn').addEventListener('click', async () => {
      if (pendingImg) { clearImgPreview(); return; }
      const btn = $('cw-img-btn');
      btn.textContent = '⏳';
      btn.disabled = true;
      try {
        const dataUrl  = await captureScreen();
        const base64   = dataUrl.split(',')[1];
        pendingImg = { dataUrl, base64 };
        const thumb = $('cw-img-thumb');
        if (thumb) thumb.src = dataUrl;
        const prev = $('cw-img-preview');
        if (prev) prev.classList.add('visible');
        btn.classList.add('active');
      } catch (e) {
        addMessage('ai', `No se pudo capturar la pantalla: ${e.message}`);
      } finally {
        btn.textContent = '📷';
        btn.disabled = false;
      }
    });

    $('cw-img-clear').addEventListener('click', clearImgPreview);

    // Input
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(input.value);
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 96) + 'px';
    });
    send.addEventListener('click', () => sendMessage(input.value));
  }

  // Arrancar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
