/**
 * Agente de Soporte IA — mismos IDs que sistema-cotizacion-web (#ai-widget-wrap, #ai-fab, …).
 * Usa GET /api/ai/welcome y POST /api/ai/chat. Opcional: ?db= en la URL → se envía en el body.
 */
(function () {
  function apiBase() {
    const b = typeof window !== 'undefined' && window.__API_BASE != null ? String(window.__API_BASE) : '';
    return b.replace(/\/+$/, '') || (window.location.protocol === 'file:' ? 'http://localhost:7000' : window.location.origin || '');
  }

  function dbFromUrl() {
    try {
      const u = new URLSearchParams(window.location.search);
      const d = u.get('db');
      return d && d.trim() ? d.trim() : '';
    } catch (_) {
      return '';
    }
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsAll(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function showAiToast(message, type) {
    type = type === 'error' ? 'error' : 'success';
    let root = document.getElementById('ai-toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ai-toast-root';
      document.body.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = 'ai-toast ai-toast-' + type;
    el.textContent = message;
    root.appendChild(el);
    function dismiss() {
      el.classList.add('ai-toast-out');
      setTimeout(function () {
        try {
          el.remove();
        } catch (_) {}
      }, 300);
    }
    const t = setTimeout(dismiss, type === 'error' ? 6500 : 4200);
    el.addEventListener('click', function () {
      clearTimeout(t);
      dismiss();
    });
  }

  async function fetchJson(url, opts) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    const r = await fetch(url, Object.assign({}, opts || {}, { headers }));
    const text = await r.text();
    if (!r.ok) throw new Error(text || r.statusText);
    if (!text || !String(text).trim()) return {};
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(text);
    }
  }

  function initAiChat() {
    const wrap = qs('#ai-widget-wrap');
    const widget = qs('#ai-widget');
    const fab = qs('#ai-fab');
    const nudgeEl = qs('#ai-fab-nudge');
    const nudgeClose = qs('#ai-fab-nudge-close');
    const NUDGE_SESSION_KEY = 'ai-fab-nudge-dismissed';
    const minimizeBtn = qs('#ai-minimize');
    const unreadBadge = qs('#ai-unread-badge');
    const messagesEl = qs('#ai-messages');
    const inputEl = qs('#ai-input');
    const sendBtn = qs('#ai-send');
    const attachBtn = qs('#ai-attach');
    const fileInput = qs('#ai-file-input');
    const voiceBtn = qs('#ai-voice');
    if (!wrap || !widget || !messagesEl || !inputEl || !sendBtn) return;

    const API = apiBase();
    const chatHistory = [];
    const STORAGE_KEY = 'aiWidgetPos';
    const IDLE_ASK_MS = 2 * 60 * 1000;
    const IDLE_CLOSE_MS = 4 * 60 * 1000;
    let lastUserActivity = 0;
    let idleAskShown = false;
    let idleClosedShown = false;
    let unreadCount = 0;
    let idleCheckTimer = null;
    let pendingFileBase64 = null;
    let pendingFileMime = null;

    function dismissFabNudge() {
      if (!nudgeEl) return;
      try {
        sessionStorage.setItem(NUDGE_SESSION_KEY, '1');
      } catch (_) {}
      nudgeEl.classList.remove('ai-fab-nudge--visible');
      wrap.classList.remove('ai-fab-nudge-active');
      setTimeout(function () {
        if (nudgeEl) nudgeEl.classList.add('hidden');
      }, 400);
    }

    function maybeShowFabNudge() {
      if (!nudgeEl || !fab) return;
      try {
        if (sessionStorage.getItem(NUDGE_SESSION_KEY)) return;
      } catch (_) {}
      setTimeout(function () {
        if (wrap.classList.contains('expanded')) return;
        try {
          if (sessionStorage.getItem(NUDGE_SESSION_KEY)) return;
        } catch (_) {}
        nudgeEl.classList.remove('hidden');
        requestAnimationFrame(function () {
          nudgeEl.classList.add('ai-fab-nudge--visible');
          wrap.classList.add('ai-fab-nudge-active');
        });
        setTimeout(dismissFabNudge, 14000);
      }, 2600);
    }
    maybeShowFabNudge();
    if (nudgeClose) {
      nudgeClose.addEventListener('click', function (e) {
        e.stopPropagation();
        dismissFabNudge();
      });
    }

    function setExpanded(expanded) {
      wrap.classList.toggle('collapsed', !expanded);
      wrap.classList.toggle('expanded', expanded);
      if (expanded) {
        unreadCount = 0;
        updateUnreadBadge();
        dismissFabNudge();
      }
    }

    function updateUnreadBadge() {
      if (!unreadBadge) return;
      if (unreadCount <= 0) {
        unreadBadge.classList.add('hidden');
        unreadBadge.textContent = '0';
      } else {
        unreadBadge.classList.remove('hidden');
        unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      }
    }

    function resetIdleTimers() {
      lastUserActivity = Date.now();
      idleAskShown = false;
      idleClosedShown = false;
    }

    function scheduleIdleCheck() {
      if (idleCheckTimer) clearInterval(idleCheckTimer);
      idleCheckTimer = setInterval(function () {
        const elapsed = Date.now() - lastUserActivity;
        if (elapsed >= IDLE_CLOSE_MS && idleAskShown && !idleClosedShown) {
          idleClosedShown = true;
          append(
            'Por inactividad minimicé la conversación. Cuando quieras seguir, abre de nuevo el asistente o escribe aquí. ¡Hasta pronto! 👋',
            false
          );
          setExpanded(false);
        } else if (elapsed >= IDLE_ASK_MS && !idleAskShown) {
          idleAskShown = true;
          append('¿Necesitas algo más? Estoy aquí cuando quieras. 😊', false);
          if (wrap.classList.contains('collapsed')) {
            unreadCount++;
            updateUnreadBadge();
          }
        }
      }, 30000);
    }

    if (fab) {
      fab.addEventListener('click', function () { setExpanded(true); });
      fab.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setExpanded(true);
        }
      });
    }
    if (minimizeBtn) minimizeBtn.addEventListener('click', function () { setExpanded(false); });

    function loadPosition() {
      try {
        const s = localStorage.getItem(STORAGE_KEY);
        if (s) {
          const pos = JSON.parse(s);
          const right = pos.right;
          const bottom = pos.bottom;
          wrap.style.right = right != null ? right + 'px' : '';
          wrap.style.bottom = bottom != null ? bottom + 'px' : '';
          wrap.style.left = '';
        }
      } catch (_) {}
    }

    function savePosition() {
      const r = parseFloat(wrap.style.right);
      const b = parseFloat(wrap.style.bottom);
      if (!isNaN(r) || !isNaN(b)) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ right: isNaN(r) ? 24 : r, bottom: isNaN(b) ? 24 : b })
        );
      }
    }
    loadPosition();

    const dragHeader = qs('.ai-widget-drag', widget);
    if (dragHeader) {
      let dragging = false;
      let startX;
      let startY;
      let startRight;
      let startBottom;
      dragHeader.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startRight = parseFloat(wrap.style.right) || 24;
        startBottom = parseFloat(wrap.style.bottom) || 24;
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        wrap.style.right = Math.max(0, startRight - dx) + 'px';
        wrap.style.bottom = Math.max(0, startBottom - dy) + 'px';
        wrap.style.left = 'auto';
      });
      document.addEventListener('mouseup', function () {
        if (dragging) {
          dragging = false;
          savePosition();
        }
      });
    }

    function removeTypingIndicator() {
      const el = messagesEl.querySelector('.ai-typing');
      if (el) el.remove();
    }

    function append(msg, isUser) {
      if (!isUser) removeTypingIndicator();
      const div = document.createElement('div');
      div.className = 'ai-msg ' + (isUser ? 'ai-msg-user' : 'ai-msg-bot');
      div.style.whiteSpace = 'pre-wrap';
      div.textContent = msg;
      messagesEl.appendChild(div);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
      if (!isUser && wrap.classList.contains('collapsed')) {
        unreadCount++;
        updateUnreadBadge();
      }
    }

    function speakReply(text) {
      if (!text || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 500));
      u.lang = 'es-MX';
      u.rate = 0.95;
      u.onerror = function () {};
      window.speechSynthesis.speak(u);
    }

    let voiceRetryCount = 0;
    const VOICE_MAX_RETRY = 1;

    function startVoiceInput(isRetry) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        showAiToast('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.', 'error');
        return;
      }
      if (!window.isSecureContext) {
        showAiToast('La voz requiere HTTPS o localhost.', 'error');
        return;
      }
      if (isRetry) showAiToast('Escuchando de nuevo… Habla ahora.', 'success');
      else showAiToast('Escuchando… Di tu mensaje en los próximos segundos.', 'success');

      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'es-MX';
      rec.maxAlternatives = 3;
      if (voiceBtn) voiceBtn.classList.add('recording');
      let spokenText = '';
      rec.onresult = function (e) {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          const t = result[0] && result[0].transcript;
          if (result.isFinal && t) {
            spokenText += t;
            try {
              rec.stop();
            } catch (_) {}
          }
        }
      };
      rec.onend = function () {
        if (voiceBtn) voiceBtn.classList.remove('recording');
        voiceRetryCount = 0;
        const txt = spokenText.trim();
        if (txt) {
          inputEl.value = (inputEl.value.trim() ? inputEl.value + ' ' : '') + txt;
          send();
        }
      };
      rec.onerror = function (e) {
        if (voiceBtn) voiceBtn.classList.remove('recording');
        if (e.error === 'aborted') return;
        if (e.error === 'no-speech' && !isRetry && voiceRetryCount < VOICE_MAX_RETRY) {
          voiceRetryCount++;
          showAiToast('No se detectó voz. Reintentando en 1 segundo…', 'success');
          setTimeout(function () { startVoiceInput(true); }, 1000);
          return;
        }
        let msg = 'No se pudo reconocer la voz.';
        if (e.error === 'not-allowed') {
          msg = 'Permiso de micrófono denegado. Permite el micrófono en la barra del navegador.';
        } else if (e.error === 'network') {
          msg = 'Reconocimiento de voz requiere conexión.';
        }
        showAiToast(msg, 'error');
        voiceRetryCount = 0;
      };
      setTimeout(function () {
        try {
          rec.start();
        } catch (err) {
          if (voiceBtn) voiceBtn.classList.remove('recording');
          showAiToast('No se pudo iniciar el micrófono.', 'error');
        }
      }, 400);
    }

    async function loadWelcome() {
      try {
        const data = await fetchJson(API + '/api/ai/welcome');
        if (data.message) append(data.message, false);
      } catch (_) {
        append(
          '¡Hola! Soy el Agente de Soporte. Puedo ayudarte a entender ventas, cotizaciones, CxC y resultados (solo lectura). ¿En qué te ayudo?',
          false
        );
      }
    }
    loadWelcome();
    scheduleIdleCheck();

    qsAll('#ai-suggestions .ai-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const msg = btn.getAttribute('data-msg');
        if (msg) {
          inputEl.value = msg;
          send();
        }
      });
    });

    const allowedImage = /^image\/(jpeg|png|gif|webp)$/i;
    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        const file = this.files && this.files[0];
        if (!file) return;
        const mime = file.type || '';
        if (!allowedImage.test(mime)) {
          showAiToast('Aquí solo se admiten imágenes (JPG, PNG, GIF, WebP). PDF/Word usa otro flujo.', 'error');
          this.value = '';
          return;
        }
        const reader = new FileReader();
        reader.onload = function () {
          const s = reader.result;
          pendingFileBase64 = s && s.indexOf('base64,') !== -1 ? s.split('base64,')[1] : s;
          pendingFileMime = mime;
          showAiToast('Imagen lista. Escribe tu pregunta y envía.', 'success');
        };
        reader.readAsDataURL(file);
        this.value = '';
      });
    }

    async function send() {
      const text = inputEl.value.trim();
      if (!text && !pendingFileBase64) return;
      inputEl.value = '';
      const messageToSend = text || (pendingFileBase64 ? '¿Qué ves en esta imagen?' : '');
      const fileLabel = pendingFileBase64 ? '[Imagen adjunta]' : '';
      append(text || fileLabel, true);
      const suggestionsEl = qs('#ai-suggestions');
      if (suggestionsEl) suggestionsEl.classList.add('hidden');
      resetIdleTimers();

      const userMsg = { role: 'user', content: messageToSend };
      chatHistory.push(userMsg);

      sendBtn.disabled = true;
      const typingEl = document.createElement('div');
      typingEl.className = 'ai-msg ai-msg-bot ai-typing';
      typingEl.setAttribute('aria-live', 'polite');
      typingEl.innerHTML =
        '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
      messagesEl.appendChild(typingEl);
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });

      const fileB64 = pendingFileBase64;
      const fileMime = pendingFileMime;
      pendingFileBase64 = null;
      pendingFileMime = null;

      const db = dbFromUrl();
      const body = {
        message: messageToSend,
        messages: chatHistory.slice(0, -1),
      };
      if (db) body.db = db;
      if (fileB64 && allowedImage.test(fileMime)) {
        body.imageBase64 = fileB64;
        body.imageMimeType = fileMime;
      }

      try {
        const data = await fetchJson(API + '/api/ai/chat', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const reply = data.reply || 'Sin respuesta';
        append(reply, false);
        chatHistory.push({ role: 'assistant', content: reply });
        while (chatHistory.length > 20) chatHistory.splice(0, 2);
        if (reply && window.speechSynthesis) speakReply(reply);
      } catch (e) {
        let msg = e.message;
        try {
          const o = JSON.parse(msg);
          if (o.error) msg = o.error;
          if (o.hint) msg += '\n\n' + o.hint;
        } catch (_) {}
        append('⚠️ ' + msg, false);
      }
      sendBtn.disabled = false;
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
    if (voiceBtn) voiceBtn.addEventListener('click', function () { startVoiceInput(false); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAiChat);
  } else {
    initAiChat();
  }
})();
