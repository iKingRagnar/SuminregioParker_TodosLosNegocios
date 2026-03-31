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
  const DB_PARAM = (() => { try { return new URLSearchParams(location.search).get('db') || ''; } catch { return ''; } })();

  const SUGGESTIONS = [
    '¿Cuánto llevamos de ventas?',
    '¿Estamos en meta?',
    '¿Cuánto se vence de CXC?',
    '¿Cómo está el margen bruto?',
    'Top 5 vendedores del mes',
    'Proyección fin de mes',
    'Enviar alerta por email',
  ];

  let history  = [];
  let pendingImg = null;  // { dataUrl, base64 }
  let isOpen   = false;
  let isTyping = false;
  let activeTab = 'chat';
  let alertsCache = null;

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
      <div id="cw-header-sub" id="cw-sub">Cargando datos en tiempo real…</div>
    </div>
    <div id="cw-status-dot" title="Conectado"></div>
    <div id="cw-header-actions">
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

  /** Convierte markdown básico a HTML */
  function mdToHtml(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,'<em>$1</em>')
      .replace(/`([^`]+)`/g,'<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:3px;font-family:monospace">$1</code>')
      .replace(/⚠️/g,'<span style="color:#f59e0b">⚠️</span>')
      .replace(/✅/g,'<span style="color:#22c55e">✅</span>')
      .replace(/📊|💰|📈|👥|📦|🔔/g, s => `<span>${s}</span>`)
      .replace(/\n/g,'<br>');
  }

  function addMessage(role, text, imgDataUrl) {
    const msgs = $('cw-msgs');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'cw-msg ' + role;

    const avatarIcon = role === 'ai' ? '🤖' : '👤';
    let bubbleContent = mdToHtml(text);
    if (imgDataUrl && role === 'user') {
      bubbleContent += `<br><img src="${imgDataUrl}" style="margin-top:6px;max-width:200px;border-radius:6px;border:1px solid #1e3a5f" alt="captura"/>`;
    }
    div.innerHTML = `
      <div class="cw-msg-avatar">${avatarIcon}</div>
      <div class="cw-msg-bubble">${bubbleContent}</div>`;
    msgs.appendChild(div);
    history.push({ role: role === 'ai' ? 'assistant' : 'user', content: text });
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

    const imgDataUrl = pendingImg ? pendingImg.dataUrl : null;
    const imgBase64  = pendingImg ? pendingImg.base64  : null;
    pendingImg = null;
    clearImgPreview();

    addMessage('user', text, imgDataUrl);
    clearInput();
    showTyping();
    hideSuggestions();

    try {
      // Historial en formato que espera el servidor (sin el último turno user ya agregado)
      const prevHistory = history.slice(-14).slice(0, -1);
      const body = {
        message   : text,
        context   : { page: PAGE },
        messages  : prevHistory.map(h => ({ role: h.role, content: h.content })),
      };
      if (DB_PARAM) body.db = DB_PARAM;
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
        addMessage('ai', `⚠️ Error del servidor: ${err.error || resp.status}. Verifica que ANTHROPIC_API_KEY esté configurado en .env`);
      } else {
        const data = await resp.json();
        // El servidor puede devolver { reply } (formato actual) o { response } (nuevo)
        addMessage('ai', data.reply || data.response || '(Respuesta vacía)');
      }
    } catch (e) {
      removeTyping();
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        const fallback = await quickFallbackReply(text);
        if (fallback) {
          addMessage('ai', fallback + '\n\nNota: la capa conversacional tardó más de lo esperado; te mostré datos directos del sistema.');
        } else {
          addMessage('ai', '⏱ La capa conversacional tardó más de lo esperado. Intenta nuevamente; si quieres, te puedo responder directo con un módulo específico (ventas, CxC o resultados).');
        }
      } else {
        addMessage('ai', `⚠️ No se pudo conectar al servidor: ${e.message}`);
        setStatus('Sin conexión', false);
      }
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
      // Usar alertsCache si ya fue cargado
      const data = alertsCache || await fetch(API + '/api/alerts/check' + (DB_PARAM ? '?db=' + DB_PARAM : ''))
        .then(r => r.json());
      const { ventas, cxc, pnl, metas } = data.kpis || {};
      const v = ventas || {}; const c = cxc || {}; const p = pnl?.totales || {};
      const fmtM = n => { if (n == null || isNaN(+n)) return 'N/D'; n = +n; if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(2)+'M'; if (Math.abs(n)>=1e3) return '$'+(n/1e3).toFixed(1)+'K'; return '$'+Math.round(n).toLocaleString(); };
      const fmtP = n => (n == null||isNaN(+n)) ? 'N/D' : (+n).toFixed(1)+'%';

      panel.innerHTML = `
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
    const alertPanel = $('cw-alerts-panel');
    const kpiPanel   = $('cw-kpis-panel');
    const sugPanel   = $('cw-suggestions');
    const inputArea  = $('cw-input-area');
    const alertBtns  = $('cw-send-alert-btns');
    const imgPreview = $('cw-img-preview');

    if (alertPanel) { alertPanel.classList.toggle('active', tab === 'alerts'); }
    if (kpiPanel)   { kpiPanel.style.display   = tab === 'kpis'    ? 'block'  : 'none'; }
    if (sugPanel)   { sugPanel.style.display    = tab === 'chat'    ? 'flex'   : 'none'; }
    if (inputArea)  { inputArea.style.display   = tab === 'chat'    ? 'flex'   : 'none'; }
    if (alertBtns)  { alertBtns.style.display   = tab === 'alerts'  ? 'flex'   : 'none'; }
    if (imgPreview) { imgPreview.classList.toggle('visible', tab === 'chat' && !!pendingImg); }

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

    // Abrir / cerrar
    fab.addEventListener('click', () => {
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      fab.textContent = isOpen ? '✕' : '🤖';
      if (isOpen && history.length === 0) {
        showWelcome();
        renderSuggestions();
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
