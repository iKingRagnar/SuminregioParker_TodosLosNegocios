/**
 * Sumi IA — Frontend con streaming SSE, markdown y UX avanzada.
 * Conecta a POST /api/ai/chat-v2/stream (SSE) con fallback a /api/ai/chat (JSON).
 */
(function () {
  'use strict';

  function apiBase() {
    var b = typeof window !== 'undefined' && window.__API_BASE != null ? String(window.__API_BASE) : '';
    return b.replace(/\/+$/, '') || (window.location.protocol === 'file:' ? 'http://localhost:7000' : window.location.origin || '');
  }

  function dbFromUrl() {
    try {
      var u = new URLSearchParams(window.location.search);
      var d = u.get('db');
      if (d && d.trim()) return d.trim();
      var s = sessionStorage.getItem('microsip_erp_db');
      return s && String(s).trim() ? String(s).trim() : '';
    } catch (_) { return ''; }
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsAll(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // ── Markdown ligero (sin dependencias) ────────────────────────────────────
  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHtml(text);

    // Code blocks (```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre class="ai-md-pre"><code class="ai-md-code">' + code.trim() + '</code></pre>';
    });

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code class="ai-md-inline">$1</code>');

    // Tables
    html = html.replace(/((?:\|[^\n]+\|\n?){2,})/g, function (block) {
      var lines = block.trim().split('\n').filter(function (l) { return l.trim(); });
      if (lines.length < 2) return block;
      var isSep = function (l) { return /^\|[\s\-:|]+\|$/.test(l.trim()); };
      var parseRow = function (l) {
        return l.trim().replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
      };
      var headerLine = lines[0];
      var sepIdx = lines.findIndex(isSep);
      if (sepIdx < 0) sepIdx = 1;
      var headerCells = parseRow(headerLine);
      var thead = '<thead><tr>' + headerCells.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>';
      var bodyLines = lines.filter(function (_, i) { return i !== 0 && !isSep(lines[i]); });
      var tbody = '<tbody>' + bodyLines.map(function (l) {
        return '<tr>' + parseRow(l).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '<table class="ai-md-table">' + thead + tbody + '</table>';
    });

    // Headers
    html = html.replace(/^#### (.+)$/gm, '<h5 class="ai-md-h">$1</h5>');
    html = html.replace(/^### (.+)$/gm, '<h4 class="ai-md-h">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h4 class="ai-md-h">$1</h4>');

    // Bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');

    // Unordered lists
    html = html.replace(/((?:^[•\-\*] .+$\n?)+)/gm, function (block) {
      var items = block.trim().split('\n').map(function (l) {
        return '<li>' + l.replace(/^[•\-\*]\s*/, '') + '</li>';
      }).join('');
      return '<ul class="ai-md-list">' + items + '</ul>';
    });

    // Ordered lists
    html = html.replace(/((?:^\d+[\.\)] .+$\n?)+)/gm, function (block) {
      var items = block.trim().split('\n').map(function (l) {
        return '<li>' + l.replace(/^\d+[\.\)]\s*/, '') + '</li>';
      }).join('');
      return '<ol class="ai-md-list">' + items + '</ol>';
    });

    // Horizontal rule
    html = html.replace(/^[-=]{3,}$/gm, '<hr class="ai-md-hr">');

    // Line breaks (preserve but collapse excessive)
    html = html.replace(/\n{3,}/g, '\n\n');
    html = html.replace(/\n/g, '<br>');

    // Clean up <br> inside block elements
    html = html.replace(/<br>(<\/?(?:table|thead|tbody|tr|th|td|ul|ol|li|pre|h[1-6]|hr))/g, '$1');
    html = html.replace(/(<\/(?:table|ul|ol|pre|h[1-6]|hr)>)<br>/g, '$1');

    return html;
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  // ── Toast notifications ───────────────────────────────────────────────────
  function showAiToast(message, type) {
    type = type === 'error' ? 'error' : 'success';
    var root = document.getElementById('ai-toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ai-toast-root';
      document.body.appendChild(root);
    }
    var el = document.createElement('div');
    el.className = 'ai-toast ai-toast-' + type;
    el.textContent = message;
    root.appendChild(el);
    function dismiss() {
      el.classList.add('ai-toast-out');
      setTimeout(function () { try { el.remove(); } catch (_) {} }, 300);
    }
    var t = setTimeout(dismiss, type === 'error' ? 6500 : 4200);
    el.addEventListener('click', function () { clearTimeout(t); dismiss(); });
  }

  // ── Session persistence ───────────────────────────────────────────────────
  var SESSION_KEY = 'sumi-ai-session-id';
  function getSessionId() {
    try {
      var id = localStorage.getItem(SESSION_KEY);
      if (id) return id;
    } catch (_) {}
    var newId = 'sess-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { localStorage.setItem(SESSION_KEY, newId); } catch (_) {}
    return newId;
  }

  // ── Main init ─────────────────────────────────────────────────────────────
  function initAiChat() {
    var wrap = qs('#ai-widget-wrap');
    var widget = qs('#ai-widget');
    var fab = qs('#ai-fab');
    var nudgeEl = qs('#ai-fab-nudge');
    var nudgeClose = qs('#ai-fab-nudge-close');
    var NUDGE_SESSION_KEY = 'ai-fab-nudge-dismissed';
    var minimizeBtn = qs('#ai-minimize');
    var unreadBadge = qs('#ai-unread-badge');
    var messagesEl = qs('#ai-messages');
    var inputEl = qs('#ai-input');
    var sendBtn = qs('#ai-send');
    var attachBtn = qs('#ai-attach');
    var fileInput = qs('#ai-file-input');
    var voiceBtn = qs('#ai-voice');
    if (!wrap || !widget || !messagesEl || !inputEl || !sendBtn) return;

    var API = apiBase();
    var chatHistory = [];
    var STORAGE_KEY = 'aiWidgetPos';
    var IDLE_ASK_MS = 2 * 60 * 1000;
    var IDLE_CLOSE_MS = 4 * 60 * 1000;
    var lastUserActivity = 0;
    var idleAskShown = false;
    var idleClosedShown = false;
    var unreadCount = 0;
    var idleCheckTimer = null;
    var pendingFileBase64 = null;
    var pendingFileMime = null;
    var sessionId = getSessionId();
    var isSending = false;

    // ── Nudge ─────────────────────────────────────────────────────────────
    function dismissFabNudge() {
      if (!nudgeEl) return;
      try { sessionStorage.setItem(NUDGE_SESSION_KEY, '1'); } catch (_) {}
      nudgeEl.classList.remove('ai-fab-nudge--visible');
      wrap.classList.remove('ai-fab-nudge-active');
      setTimeout(function () { if (nudgeEl) nudgeEl.classList.add('hidden'); }, 400);
    }

    function maybeShowFabNudge() {
      if (!nudgeEl || !fab) return;
      try { if (sessionStorage.getItem(NUDGE_SESSION_KEY)) return; } catch (_) {}
      setTimeout(function () {
        if (wrap.classList.contains('expanded')) return;
        try { if (sessionStorage.getItem(NUDGE_SESSION_KEY)) return; } catch (_) {}
        nudgeEl.classList.remove('hidden');
        requestAnimationFrame(function () {
          nudgeEl.classList.add('ai-fab-nudge--visible');
          wrap.classList.add('ai-fab-nudge-active');
        });
        setTimeout(dismissFabNudge, 14000);
      }, 2600);
    }
    maybeShowFabNudge();
    if (nudgeClose) nudgeClose.addEventListener('click', function (e) { e.stopPropagation(); dismissFabNudge(); });

    // ── Expand / collapse ─────────────────────────────────────────────────
    function setExpanded(expanded) {
      wrap.classList.toggle('collapsed', !expanded);
      wrap.classList.toggle('expanded', expanded);
      if (expanded) { unreadCount = 0; updateUnreadBadge(); dismissFabNudge(); inputEl.focus(); }
    }

    function updateUnreadBadge() {
      if (!unreadBadge) return;
      if (unreadCount <= 0) { unreadBadge.classList.add('hidden'); unreadBadge.textContent = '0'; }
      else { unreadBadge.classList.remove('hidden'); unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount); }
    }

    // ── Idle timers ───────────────────────────────────────────────────────
    function resetIdleTimers() { lastUserActivity = Date.now(); idleAskShown = false; idleClosedShown = false; }

    function scheduleIdleCheck() {
      if (idleCheckTimer) clearInterval(idleCheckTimer);
      idleCheckTimer = setInterval(function () {
        var elapsed = Date.now() - lastUserActivity;
        if (elapsed >= IDLE_CLOSE_MS && idleAskShown && !idleClosedShown) {
          idleClosedShown = true;
          appendBot('Por inactividad minimicé la conversación. Cuando quieras seguir, abre de nuevo el asistente. 👋');
          setExpanded(false);
        } else if (elapsed >= IDLE_ASK_MS && !idleAskShown) {
          idleAskShown = true;
          appendBot('¿Necesitas algo más? Estoy aquí cuando quieras. 😊');
          if (wrap.classList.contains('collapsed')) { unreadCount++; updateUnreadBadge(); }
        }
      }, 30000);
    }

    // ── FAB + minimize ────────────────────────────────────────────────────
    if (fab) {
      fab.addEventListener('click', function () { setExpanded(true); });
      fab.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(true); } });
    }
    if (minimizeBtn) minimizeBtn.addEventListener('click', function () { setExpanded(false); });

    // ── Drag ──────────────────────────────────────────────────────────────
    function loadPosition() {
      try {
        var s = localStorage.getItem(STORAGE_KEY);
        if (s) { var pos = JSON.parse(s); wrap.style.right = pos.right != null ? pos.right + 'px' : ''; wrap.style.bottom = pos.bottom != null ? pos.bottom + 'px' : ''; wrap.style.left = ''; }
      } catch (_) {}
    }
    function savePosition() {
      var r = parseFloat(wrap.style.right), b = parseFloat(wrap.style.bottom);
      if (!isNaN(r) || !isNaN(b)) localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: isNaN(r) ? 24 : r, bottom: isNaN(b) ? 24 : b }));
    }
    loadPosition();

    var dragHeader = qs('.ai-widget-drag', widget);
    if (dragHeader) {
      var dragging = false, startX, startY, startRight, startBottom;
      dragHeader.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return; e.preventDefault(); dragging = true;
        startX = e.clientX; startY = e.clientY;
        startRight = parseFloat(wrap.style.right) || 24; startBottom = parseFloat(wrap.style.bottom) || 24;
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        wrap.style.right = Math.max(0, startRight - (e.clientX - startX)) + 'px';
        wrap.style.bottom = Math.max(0, startBottom - (e.clientY - startY)) + 'px';
        wrap.style.left = 'auto';
      });
      document.addEventListener('mouseup', function () { if (dragging) { dragging = false; savePosition(); } });
    }

    // ── Message rendering ─────────────────────────────────────────────────
    function removeTypingIndicator() {
      var el = messagesEl.querySelector('.ai-typing');
      if (el) el.remove();
    }

    function appendUser(msg) {
      var div = document.createElement('div');
      div.className = 'ai-msg ai-msg-user';
      div.textContent = msg;
      messagesEl.appendChild(div);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    }

    function appendBot(msg) {
      removeTypingIndicator();
      var div = document.createElement('div');
      div.className = 'ai-msg ai-msg-bot';
      div.innerHTML = renderMarkdown(msg);
      addCopyButton(div, msg);
      messagesEl.appendChild(div);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      if (wrap.classList.contains('collapsed')) { unreadCount++; updateUnreadBadge(); }
      return div;
    }

    function createStreamingBubble() {
      removeTypingIndicator();
      var div = document.createElement('div');
      div.className = 'ai-msg ai-msg-bot ai-msg-streaming';
      div.innerHTML = '<span class="ai-stream-cursor"></span>';
      messagesEl.appendChild(div);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      return div;
    }

    function updateStreamingBubble(div, fullText) {
      div.innerHTML = renderMarkdown(fullText) + '<span class="ai-stream-cursor"></span>';
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    }

    function finalizeStreamingBubble(div, fullText) {
      div.classList.remove('ai-msg-streaming');
      div.innerHTML = renderMarkdown(fullText);
      addCopyButton(div, fullText);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      if (wrap.classList.contains('collapsed')) { unreadCount++; updateUnreadBadge(); }
    }

    function addCopyButton(div, rawText) {
      var btn = document.createElement('button');
      btn.className = 'ai-copy-btn';
      btn.title = 'Copiar respuesta';
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard.writeText(rawText).then(function () {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0d9488" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
          setTimeout(function () {
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
          }, 1800);
        });
      });
      div.appendChild(btn);
    }

    function appendVisuals(visuals) {
      if (!Array.isArray(visuals) || !visuals.length) return;
      visuals.forEach(function (v) {
        if (!v || String(v.type || '').toLowerCase() !== 'image') return;
        var url = String(v.url || '').trim();
        if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) return;
        var div = document.createElement('div');
        div.className = 'ai-msg ai-msg-bot';
        div.style.display = 'grid'; div.style.gap = '8px'; div.style.whiteSpace = 'normal';
        var cap = document.createElement('div');
        cap.style.fontSize = '12px'; cap.style.opacity = '0.9';
        cap.textContent = v.title ? String(v.title) : 'Visual';
        var a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        var img = document.createElement('img');
        img.src = url; img.alt = cap.textContent; img.loading = 'lazy';
        img.style.width = '100%'; img.style.borderRadius = '10px';
        img.style.border = '1px solid rgba(255,255,255,.15)';
        img.style.background = 'rgba(255,255,255,.03)';
        a.appendChild(img); div.appendChild(cap); div.appendChild(a);
        messagesEl.appendChild(div);
      });
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    }

    // ── Voice ─────────────────────────────────────────────────────────────
    function speakReply(text) {
      if (!text || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text.slice(0, 500));
      u.lang = 'es-MX'; u.rate = 0.95; u.onerror = function () {};
      window.speechSynthesis.speak(u);
    }

    var voiceRetryCount = 0;
    function startVoiceInput(isRetry) {
      var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) { showAiToast('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.', 'error'); return; }
      if (!window.isSecureContext) { showAiToast('La voz requiere HTTPS o localhost.', 'error'); return; }
      showAiToast(isRetry ? 'Escuchando de nuevo… Habla ahora.' : 'Escuchando… Di tu mensaje.', 'success');

      var rec = new SpeechRecognition();
      rec.continuous = true; rec.interimResults = true; rec.lang = 'es-MX'; rec.maxAlternatives = 3;
      if (voiceBtn) voiceBtn.classList.add('recording');
      var spokenText = '';
      rec.onresult = function (e) {
        for (var i = e.resultIndex; i < e.results.length; i++) {
          var result = e.results[i];
          if (result.isFinal && result[0] && result[0].transcript) {
            spokenText += result[0].transcript;
            try { rec.stop(); } catch (_) {}
          }
        }
      };
      rec.onend = function () {
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceRetryCount = 0;
        var txt = spokenText.trim();
        if (txt) { inputEl.value = (inputEl.value.trim() ? inputEl.value + ' ' : '') + txt; send(); }
      };
      rec.onerror = function (e) {
        if (voiceBtn) voiceBtn.classList.remove('recording');
        if (e.error === 'aborted') return;
        if (e.error === 'no-speech' && !isRetry && voiceRetryCount < 1) {
          voiceRetryCount++;
          showAiToast('No se detectó voz. Reintentando…', 'success');
          setTimeout(function () { startVoiceInput(true); }, 1000);
          return;
        }
        var msg = 'No se pudo reconocer la voz.';
        if (e.error === 'not-allowed') msg = 'Permiso de micrófono denegado.';
        else if (e.error === 'network') msg = 'Reconocimiento de voz requiere conexión.';
        showAiToast(msg, 'error');
        voiceRetryCount = 0;
      };
      setTimeout(function () { try { rec.start(); } catch (_) { if (voiceBtn) voiceBtn.classList.remove('recording'); showAiToast('No se pudo iniciar el micrófono.', 'error'); } }, 400);
    }

    // ── Welcome ───────────────────────────────────────────────────────────
    appendBot('¡Hola! Soy **Sumi**, tu asistente ejecutivo de Suminregio. Puedo ayudarte con ventas, CXC, inventario, márgenes, vendedores y más. ¿En qué te ayudo?');
    scheduleIdleCheck();

    qsAll('#ai-suggestions .ai-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var msg = btn.getAttribute('data-msg');
        if (msg) { inputEl.value = msg; send(); }
      });
    });

    // ── File attach ───────────────────────────────────────────────────────
    var allowedImage = /^image\/(jpeg|png|gif|webp)$/i;
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var file = this.files && this.files[0];
        if (!file) return;
        var mime = file.type || '';
        if (!allowedImage.test(mime)) { showAiToast('Solo imágenes (JPG, PNG, GIF, WebP).', 'error'); this.value = ''; return; }
        var reader = new FileReader();
        reader.onload = function () {
          var s = reader.result;
          pendingFileBase64 = s && s.indexOf('base64,') !== -1 ? s.split('base64,')[1] : s;
          pendingFileMime = mime;
          showAiToast('Imagen lista. Escribe tu pregunta y envía.', 'success');
        };
        reader.readAsDataURL(file);
        this.value = '';
      });
    }

    // ── SSE streaming send ────────────────────────────────────────────────
    async function sendStreaming(messageToSend) {
      var db = dbFromUrl();
      var body = { message: messageToSend, sessionId: sessionId };
      if (db) body.db = db;

      var bubble = createStreamingBubble();
      var fullText = '';

      try {
        var resp = await fetch(API + '/api/ai/chat-v2/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          var errText = await resp.text();
          throw new Error(errText || resp.statusText);
        }

        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        while (true) {
          var result = await reader.read();
          if (result.done) break;

          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            try {
              var evt = JSON.parse(line.slice(6));
              if (evt.type === 'delta' && evt.text) {
                fullText += evt.text;
                updateStreamingBubble(bubble, fullText);
              } else if (evt.type === 'error') {
                throw new Error(evt.error || 'Error del servidor');
              }
            } catch (parseErr) {
              if (parseErr.message && parseErr.message !== 'Error del servidor') continue;
              throw parseErr;
            }
          }
        }

        finalizeStreamingBubble(bubble, fullText);
        chatHistory.push({ role: 'assistant', content: fullText });
        while (chatHistory.length > 40) chatHistory.splice(0, 2);
        return fullText;
      } catch (e) {
        if (fullText) {
          finalizeStreamingBubble(bubble, fullText);
          chatHistory.push({ role: 'assistant', content: fullText });
        } else {
          bubble.remove();
          throw e;
        }
        return fullText;
      }
    }

    // ── Fallback JSON send (to legacy /api/ai/chat) ──────────────────────
    async function sendJson(messageToSend) {
      var db = dbFromUrl();
      var body = { message: messageToSend, messages: chatHistory.slice(0, -1), sessionId: sessionId };
      if (db) body.db = db;

      var resp = await fetch(API + '/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var text = await resp.text();
      if (!resp.ok) throw new Error(text || resp.statusText);
      var data = JSON.parse(text);
      var reply = data.reply || 'Sin respuesta';
      appendBot(reply);
      appendVisuals(data.visuals || []);
      chatHistory.push({ role: 'assistant', content: reply });
      while (chatHistory.length > 40) chatHistory.splice(0, 2);
      return reply;
    }

    // ── Send orchestrator ─────────────────────────────────────────────────
    async function send() {
      if (isSending) return;
      var text = inputEl.value.trim();
      if (!text && !pendingFileBase64) return;
      inputEl.value = '';
      isSending = true;

      var messageToSend = text || (pendingFileBase64 ? '¿Qué ves en esta imagen?' : '');
      appendUser(text || '[Imagen adjunta]');
      var suggestionsEl = qs('#ai-suggestions');
      if (suggestionsEl) suggestionsEl.classList.add('hidden');
      resetIdleTimers();

      chatHistory.push({ role: 'user', content: messageToSend });
      sendBtn.disabled = true;

      pendingFileBase64 = null;
      pendingFileMime = null;

      try {
        var reply = await sendStreaming(messageToSend);
        if (reply && window.speechSynthesis) speakReply(reply);
      } catch (streamErr) {
        try {
          chatHistory.pop();
          chatHistory.push({ role: 'user', content: messageToSend });
          var reply2 = await sendJson(messageToSend);
          if (reply2 && window.speechSynthesis) speakReply(reply2);
        } catch (fallbackErr) {
          var msg = fallbackErr.message;
          try { var o = JSON.parse(msg); if (o.error) msg = o.error; if (o.hint) msg += '\n' + o.hint; } catch (_) {}
          appendBot('⚠️ ' + msg);
        }
      }
      sendBtn.disabled = false;
      isSending = false;
    }

    // ── Event bindings ────────────────────────────────────────────────────
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    if (voiceBtn) voiceBtn.addEventListener('click', function () { startVoiceInput(false); });

    // Keyboard shortcut: Ctrl+Shift+S to toggle chat
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setExpanded(!wrap.classList.contains('expanded'));
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAiChat);
  else initAiChat();
})();
