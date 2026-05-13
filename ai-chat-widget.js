/* ai-chat-widget.js — Widget de chat IA flotante para los dashboards.
 *
 * Consume /api/ai/chat-v3/stream vía SSE para typing-indicator real.
 * Mantiene sessionId en localStorage para conversaciones que persisten
 * entre reloads. Usa escHtml de safe-dom.js para evitar XSS.
 *
 * Uso: incluir <script src="/ai-chat-widget.js" defer></script>
 *
 * Configurable via window.SUMI_AI_CONFIG:
 *   { db: 'default', effort: 'medium', position: 'bottom-right' }
 */
(function () {
  'use strict';

  var CFG = (typeof window !== 'undefined' && window.SUMI_AI_CONFIG) || {};
  var DB = CFG.db || 'default';
  var EFFORT = CFG.effort || 'medium';
  var POSITION = CFG.position || 'bottom-right';

  function escHtml(s) {
    if (typeof window.escHtml === 'function') return window.escHtml(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getSessionId() {
    try {
      var sid = localStorage.getItem('sumi_ai_v3_session');
      if (!sid) {
        sid = 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('sumi_ai_v3_session', sid);
      }
      return sid;
    } catch (_) { return 'web-' + Date.now(); }
  }

  function clearSession() {
    try { localStorage.removeItem('sumi_ai_v3_session'); } catch (_) {}
  }

  function injectStyles() {
    if (document.getElementById('sumi-ai-styles')) return;
    var style = document.createElement('style');
    style.id = 'sumi-ai-styles';
    style.textContent = [
      '.sumi-ai-fab{position:fixed;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#E6A800 0%,#D97706 100%);border:none;color:#fff;font-size:26px;cursor:pointer;z-index:99999;box-shadow:0 8px 24px rgba(230,168,0,.4);transition:transform .2s}',
      '.sumi-ai-fab:hover{transform:scale(1.1)}',
      '.sumi-ai-fab.bottom-right{bottom:24px;right:24px}',
      '.sumi-ai-fab.bottom-left{bottom:24px;left:24px}',
      '.sumi-ai-panel{position:fixed;width:420px;max-width:calc(100vw - 32px);height:600px;max-height:80vh;background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(15,23,42,.25);border:1px solid rgba(15,23,42,.08);z-index:99999;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.sumi-ai-panel.bottom-right{bottom:92px;right:24px}',
      '.sumi-ai-panel.bottom-left{bottom:92px;left:24px}',
      '.sumi-ai-panel.open{display:flex}',
      '.sumi-ai-head{background:linear-gradient(135deg,#0F172A,#1E293B);color:#fff;padding:14px 18px;display:flex;justify-content:space-between;align-items:center}',
      '.sumi-ai-head-title{font-size:.92rem;font-weight:700;display:flex;align-items:center;gap:8px}',
      '.sumi-ai-head-actions{display:flex;gap:8px}',
      '.sumi-ai-head-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:18px;opacity:.7;padding:4px 8px;border-radius:4px}',
      '.sumi-ai-head-btn:hover{opacity:1;background:rgba(255,255,255,.1)}',
      '.sumi-ai-msgs{flex:1;overflow-y:auto;padding:16px;background:#F6F8FB;display:flex;flex-direction:column;gap:12px}',
      '.sumi-ai-msg{padding:10px 14px;border-radius:14px;font-size:.88rem;line-height:1.45;max-width:85%;word-wrap:break-word}',
      '.sumi-ai-msg.user{background:#1E293B;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
      '.sumi-ai-msg.assistant{background:#fff;color:#0F172A;align-self:flex-start;border:1px solid rgba(15,23,42,.08);border-bottom-left-radius:4px;white-space:pre-wrap}',
      '.sumi-ai-tool{font-size:.72rem;color:#64748B;font-style:italic;align-self:flex-start;padding:4px 8px}',
      '.sumi-ai-tool .ok{color:#16A34A}',
      '.sumi-ai-tool .err{color:#DC2626}',
      '.sumi-ai-form{padding:12px;border-top:1px solid rgba(15,23,42,.08);background:#fff;display:flex;gap:8px}',
      '.sumi-ai-input{flex:1;border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:10px 14px;font-size:.88rem;font-family:inherit;outline:none}',
      '.sumi-ai-input:focus{border-color:#E6A800}',
      '.sumi-ai-send{background:#E6A800;color:#fff;border:none;border-radius:10px;padding:0 18px;font-size:.88rem;font-weight:700;cursor:pointer}',
      '.sumi-ai-send:disabled{opacity:.4;cursor:not-allowed}',
      '.sumi-ai-typing{display:inline-flex;gap:3px;padding:8px 0}',
      '.sumi-ai-typing span{width:6px;height:6px;border-radius:50%;background:#94A3B8;animation:sumiBlink 1.2s infinite}',
      '.sumi-ai-typing span:nth-child(2){animation-delay:.2s}',
      '.sumi-ai-typing span:nth-child(3){animation-delay:.4s}',
      '@keyframes sumiBlink{0%,80%,100%{opacity:.3}40%{opacity:1}}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function build() {
    injectStyles();

    var fab = document.createElement('button');
    fab.className = 'sumi-ai-fab ' + POSITION;
    fab.innerHTML = '<span>🤖</span>';
    fab.title = 'Asistente IA Suminregio';
    fab.setAttribute('aria-label', 'Abrir asistente IA');

    var panel = document.createElement('div');
    panel.className = 'sumi-ai-panel ' + POSITION;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Asistente IA');
    panel.innerHTML =
      '<div class="sumi-ai-head">' +
        '<div class="sumi-ai-head-title">🤖 Asistente Suminregio <span style="font-weight:400;opacity:.7;font-size:.7rem">· Opus 4.7</span></div>' +
        '<div class="sumi-ai-head-actions">' +
          '<button class="sumi-ai-head-btn" data-act="reset" title="Nueva conversación" aria-label="Nueva conversación">↻</button>' +
          '<button class="sumi-ai-head-btn" data-act="close" title="Cerrar" aria-label="Cerrar">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="sumi-ai-msgs" id="sumi-ai-msgs">' +
        '<div class="sumi-ai-msg assistant">¡Hola! Pregúntame lo que sea sobre ventas, cobranza, inventario o margen. Tengo acceso a más de 20 herramientas para consultar los datos reales del negocio.</div>' +
      '</div>' +
      '<form class="sumi-ai-form" id="sumi-ai-form">' +
        '<input class="sumi-ai-input" id="sumi-ai-input" placeholder="¿Cómo va el mes?" autocomplete="off" aria-label="Pregunta al asistente">' +
        '<button class="sumi-ai-send" type="submit">Enviar</button>' +
      '</form>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    var msgs = panel.querySelector('#sumi-ai-msgs');
    var form = panel.querySelector('#sumi-ai-form');
    var input = panel.querySelector('#sumi-ai-input');
    var sendBtn = form.querySelector('button[type="submit"]');

    fab.addEventListener('click', function () {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) setTimeout(function () { input.focus(); }, 100);
    });
    panel.querySelector('[data-act="close"]').addEventListener('click', function () {
      panel.classList.remove('open');
    });
    panel.querySelector('[data-act="reset"]').addEventListener('click', function () {
      if (!confirm('¿Iniciar conversación nueva?')) return;
      clearSession();
      msgs.innerHTML = '<div class="sumi-ai-msg assistant">Conversación reiniciada. ¿En qué te ayudo?</div>';
    });

    function append(role, text) {
      var div = document.createElement('div');
      div.className = 'sumi-ai-msg ' + role;
      div.textContent = text;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    function appendTool(name, status) {
      var div = document.createElement('div');
      div.className = 'sumi-ai-tool';
      var statusHtml = status === 'ok' ? '<span class="ok">✓</span>' : status === 'err' ? '<span class="err">✗</span>' : '⚙️';
      div.innerHTML = statusHtml + ' ' + escHtml(name);
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function appendTyping() {
      var div = document.createElement('div');
      div.className = 'sumi-ai-msg assistant';
      div.innerHTML = '<div class="sumi-ai-typing"><span></span><span></span><span></span></div>';
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return div;
    }

    async function send(text) {
      append('user', text);
      sendBtn.disabled = true;
      input.value = '';
      input.disabled = true;

      var typingEl = appendTyping();
      var assistantEl = null;
      var assistantText = '';

      try {
        var resp = await fetch('/api/ai/chat-v3/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: getSessionId(), db: DB, message: text, effort: EFFORT }),
        });

        if (!resp.ok || !resp.body) {
          typingEl.remove();
          append('assistant', 'Error: ' + resp.status + '. Asegúrate de que ANTHROPIC_API_KEY esté configurada en el server.');
          return;
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';

        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });

          var lines = buf.split('\n');
          buf = lines.pop();
          var event = null;
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) {
              try {
                var data = JSON.parse(line.slice(6));
                if (event === 'text' && data.delta) {
                  if (typingEl) { typingEl.remove(); typingEl = null; }
                  if (!assistantEl) assistantEl = append('assistant', '');
                  assistantText += data.delta;
                  assistantEl.textContent = assistantText;
                  msgs.scrollTop = msgs.scrollHeight;
                } else if (event === 'tool_use') {
                  appendTool(data.name, 'pending');
                } else if (event === 'tool_result') {
                  appendTool(data.name, data.ok ? 'ok' : 'err');
                } else if (event === 'error') {
                  if (typingEl) typingEl.remove();
                  append('assistant', '⚠️ Error: ' + (data.message || 'desconocido'));
                }
              } catch (_) {}
              event = null;
            }
          }
        }

        if (typingEl) typingEl.remove();
        if (!assistantText) append('assistant', '(sin respuesta — verifica configuración)');
      } catch (e) {
        if (typingEl) typingEl.remove();
        append('assistant', '⚠️ Error de red: ' + e.message);
      } finally {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
      }
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (text) send(text);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
