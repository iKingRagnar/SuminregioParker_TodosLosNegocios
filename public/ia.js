/**
 * ia.js — Sumi IA · Full-page AI assistant for Suminregio Industrial
 * Uses POST /api/ai/chat (main) and POST /api/ai/chat-v2 (session-based)
 */
(function () {
  'use strict';

  var API = (typeof window !== 'undefined' && window.__API_BASE) ? window.__API_BASE : '';

  // ── State ──────────────────────────────────────────────────────────────────
  var conversations = loadConversations();
  var activeConvId = null;
  var isStreaming = false;
  var abortCtrl = null;
  var pendingImage = null; // { dataUrl, base64, mime }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var $landing = document.getElementById('ia-landing');
  var $messages = document.getElementById('ia-messages');
  var $form = document.getElementById('ia-form');
  var $input = document.getElementById('ia-input');
  var $btnSend = document.getElementById('btn-send');
  var $btnStop = document.getElementById('btn-stop');
  var $btnAttach = document.getElementById('btn-attach');
  var $btnNewChat = document.getElementById('btn-new-chat');
  var $sidebar = document.getElementById('ia-sidebar');
  var $sidebarList = document.getElementById('sidebar-conversations');
  var $sidebarSearch = document.getElementById('sidebar-search-input');
  var $btnToggle = document.getElementById('btn-toggle-sidebar');
  var $attachments = document.getElementById('ia-attachments');
  var $fileInput = document.getElementById('file-input-hidden');
  var $modelSelector = document.getElementById('model-selector');
  var $landingSuggestions = document.getElementById('landing-suggestions');

  // ── DB helper ──────────────────────────────────────────────────────────────
  function currentDb() {
    try {
      var fromUrl = new URLSearchParams(location.search).get('db');
      if (fromUrl) return fromUrl;
      var fromSess = sessionStorage.getItem('microsip_erp_db');
      if (fromSess && String(fromSess).trim()) return String(fromSess).trim();
    } catch (e) { if (window.console) console.warn('[ia]', e && e.message || e); }
    return '';
  }

  // ── Etiquetas de negocio (dbId → nombre legible) para auto-agrupado ────────
  var DB_LABELS = {};
  function dbLabel(id) {
    var key = String(id || 'default');
    if (DB_LABELS[key]) return DB_LABELS[key];
    var nice = key.replace(/^suminregio[_-]?/i, '').replace(/\.fdb$/i, '').replace(/[_-]+/g, ' ').trim();
    if (!nice || /^default$/i.test(key)) nice = 'Suminregio Parker';
    return nice.charAt(0).toUpperCase() + nice.slice(1);
  }

  // Detecta el TEMA de la consulta (subgrupo resumido) a partir del texto.
  function detectTema(text) {
    var q = String(text || '').toLowerCase();
    var R = [
      [/\bventa|factur|ingres|vendid|vend[ií]|cu[aá]nto.*llev/, 'Ventas'],
      [/\bcxc|cobr|vencid|cartera|deud|saldo|adeud/, 'Cobranza / CxC'],
      [/\binventario|stock|existenc|almac[eé]n|quiebr|mercanc/, 'Inventario'],
      [/\bvendedor|comisi[oó]n|ranking|equipo/, 'Vendedores'],
      [/\bcliente|comprador|churn|riesgo|recompra|retenci/, 'Clientes'],
      [/\bmargen|utilidad|rentab|pnl|p&l|resultado|gasto/, 'Rentabilidad'],
      [/\bcotiz|propuesta|pipeline|presupuest/, 'Cotizaciones'],
      [/\bcompra|reposi|proveed|surtir|ordenar/, 'Compras'],
      [/\bmeta|objetivo|cumplim|proyec|cierre/, 'Metas'],
      [/\bforecast|tendenc|estima|predic/, 'Proyecciones'],
    ];
    for (var i = 0; i < R.length; i++) { if (R[i][0].test(q)) return R[i][1]; }
    return 'General';
  }

  // Crea (si no existe) el grupo del negocio + subgrupo del tema y devuelve el
  // id del subgrupo, para que la conversación se auto-organice por contexto.
  function ensureContextGroup(dbId, tema) {
    try {
      var negocio = dbLabel(dbId);
      var parent = groups.find(function (g) { return !g.parentId && g.name === negocio; });
      if (!parent) { parent = { id: newGid(), name: negocio, parentId: null, collapsed: false, auto: true }; groups.push(parent); }
      var sub = groups.find(function (g) { return g.parentId === parent.id && g.name === tema; });
      if (!sub) { sub = { id: newGid(), name: tema, parentId: parent.id, collapsed: false, auto: true }; groups.push(sub); }
      saveGroups(groups);
      return sub.id;
    } catch (_) { return null; }
  }

  // ── Conversation persistence (server + localStorage fallback) ──────────────
  var STORAGE_KEY = 'sumi_ia_conversations_v1';
  var serverConvAvailable = false;

  function loadConversations() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { console.error('[chat-widget] error:', e.message||e); return []; }
  }

  function saveConversations() {
    try {
      var toSave = conversations.slice(-50);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) { if (window.console) console.warn('[ia]', e && e.message || e); }
  }

  function syncToServer(conv) {
    if (!conv) return;
    var payload = { title: conv.title, dbId: conv.dbId || currentDb(), messages: conv.messages };
    if (conv.serverId) {
      fetch(API + '/api/ia/conversations/' + conv.serverId, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } else {
      fetch(API + '/api/ia/conversations', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok && d.conversation) {
          conv.serverId = d.conversation.id;
          saveConversations();
        }
      }).catch(function () {});
    }
  }

  function loadServerConversations() {
    fetch(API + '/api/ia/conversations', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !Array.isArray(d.conversations)) return;
        serverConvAvailable = true;
        var localServerIds = {};
        conversations.forEach(function (c) { if (c.serverId) localServerIds[c.serverId] = true; });
        var migrateCount = 0;
        conversations.forEach(function (c) {
          if (!c.serverId && c.messages && c.messages.length > 0) {
            syncToServer(c);
            migrateCount++;
          }
        });
        if (migrateCount > 0 && window.console) console.info('[ia] migrated', migrateCount, 'conversations to server');
        var pullCount = 0;
        d.conversations.forEach(function (sc) {
          if (!localServerIds[sc.id]) {
            conversations.push({
              id: 'srv_' + sc.id,
              serverId: sc.id,
              title: sc.title || 'Sin título',
              dbId: sc.dbId || '',
              messages: [],
              createdAt: new Date(sc.createdAt).getTime() || Date.now(),
              updatedAt: new Date(sc.updatedAt || sc.createdAt).getTime() || Date.now(),
              msgCount: sc.msgCount || 0,
            });
            pullCount++;
          }
        });
        if (pullCount > 0) {
          saveConversations();
          renderSidebar();
        }
      })
      .catch(function () {});
  }

  function getConv(id) {
    return conversations.find(function (c) { return c.id === id; }) || null;
  }

  function createConversation() {
    var conv = {
      id: 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: 'Nueva conversación',
      dbId: currentDb(),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    conversations.push(conv);
    saveConversations();
    syncToServer(conv);
    return conv;
  }

  function deleteConversation(id) {
    var conv = getConv(id);
    if (conv && conv.serverId) {
      fetch(API + '/api/ia/conversations/' + conv.serverId, { method: 'DELETE', credentials: 'same-origin' }).catch(function () {});
    }
    conversations = conversations.filter(function (c) { return c.id !== id; });
    saveConversations();
    if (activeConvId === id) {
      activeConvId = null;
      showLanding();
    }
    renderSidebar();
  }

  function autoTitle(conv) {
    if (conv.messages.length < 1) return;
    var firstUser = conv.messages.find(function (m) { return m.role === 'user'; });
    if (!firstUser) return;
    var text = typeof firstUser.content === 'string' ? firstUser.content : '';
    conv.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');

    // Auto-organiza la conversación por contexto: grupo = negocio consultado,
    // subgrupo = tema (resumido). Solo si el usuario no la movió manualmente.
    if (!conv.groupPinned && (!conv.groupId || _isAutoGroup(conv.groupId))) {
      var subId = ensureContextGroup(conv.dbId || currentDb(), detectTema(text));
      if (subId) conv.groupId = subId;
    }

    saveConversations();
    syncToServer(conv);
    renderSidebar();
  }
  function _isAutoGroup(gid) {
    var g = groups.find(function (x) { return x.id === gid; });
    return !!(g && g.auto);
  }

  // ── Markdown rendering ─────────────────────────────────────────────────────
  // SECURITY: We escape ALL HTML first via placeholders for code blocks, then
  // escape everything else, and only re-introduce safe tags via markdown rules.
  // This prevents XSS even if the AI is prompt-injected to emit raw HTML/SVG.
  function renderMarkdown(text) {
    if (!text) return '';

    // 1) Extract fenced code blocks first (escape their contents) and replace
    //    with placeholders so the rest of the pipeline can't accidentally
    //    re-encode them.
    var codeBlocks = [];
    // Token improbable de aparecer en output normal del modelo.
    var TOKEN = '☃CB☃';
    var html = String(text).replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var i = codeBlocks.length;
      codeBlocks.push('<pre><code class="lang-' + escapeHtml(lang || 'text') + '">' + escapeHtml(code.trim()) + '</code></pre>');
      return TOKEN + i + TOKEN;
    });

    // 2) Escape ALL remaining HTML — anything from this point on that becomes
    //    a tag must be added by our own markdown rules.
    html = escapeHtml(html);

    // 3) Apply markdown transforms over the escaped string. Because `<` is now
    //    `&lt;`, no user-injected tag can survive.
    // Inline code
    html = html.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    // HR
    html = html.replace(/^---$/gm, '<hr>');
    // Tables
    html = renderMarkdownTables(html);
    // Lists
    html = renderLists(html);
    // Paragraphs
    html = html.replace(/\n{2,}/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<(h[1-3]|pre|blockquote|table|ul|ol|hr|div)/g, '<$1');
    html = html.replace(/<\/(h[1-3]|pre|blockquote|table|ul|ol|div)>\s*<\/p>/g, '</$1>');
    html = html.replace(/<p>\s*<\/p>/g, '');
    // Line breaks inside p
    html = html.replace(/\n/g, '<br>');

    // 4) Restore code-block placeholders.
    html = html.replace(new RegExp(TOKEN + '(\\d+)' + TOKEN, 'g'), function (_, i) { return codeBlocks[+i] || ''; });

    return html;
  }

  function renderLists(html) {
    // Unordered
    html = html.replace(/(^|\n)((?:[\t ]*[-*•] .+\n?)+)/g, function (_, pre, block) {
      var items = block.trim().split(/\n/).map(function (line) {
        return '<li>' + line.replace(/^[\t ]*[-*•] /, '') + '</li>';
      }).join('');
      return pre + '<ul>' + items + '</ul>';
    });
    // Ordered
    html = html.replace(/(^|\n)((?:[\t ]*\d+\. .+\n?)+)/g, function (_, pre, block) {
      var items = block.trim().split(/\n/).map(function (line) {
        return '<li>' + line.replace(/^[\t ]*\d+\.\s*/, '') + '</li>';
      }).join('');
      return pre + '<ol>' + items + '</ol>';
    });
    return html;
  }

  function renderMarkdownTables(html) {
    var tableRe = /((?:^|\n)\|.+\|[ \t]*\n\|[\s:|-]+\|[ \t]*\n(?:\|.+\|[ \t]*\n?)+)/g;
    return html.replace(tableRe, function (block) {
      var lines = block.trim().split('\n').filter(function (l) { return l.trim(); });
      if (lines.length < 3) return block;
      var headerCells = parsePipeLine(lines[0]);
      var bodyLines = lines.slice(2);
      var thead = '<thead><tr>' + headerCells.map(function (c) {
        return '<th>' + c + '</th>';
      }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + bodyLines.map(function (line) {
        var cells = parsePipeLine(line);
        return '<tr>' + cells.map(function (c) {
          var cls = smartTdClass(c);
          return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + c + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
      return '\n<div class="table-scroll-wrap"><table>' + thead + tbody + '</table></div>\n';
    });
  }

  function parsePipeLine(line) {
    return line.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
  }

  function smartTdClass(val) {
    if (!val) return '';
    var v = val.trim();
    // Semáforos
    if (/🟢/.test(v)) return 'smart-positive';
    if (/🔴/.test(v)) return 'smart-negative';
    if (/🟡/.test(v)) return 'smart-warning';
    // Percentages
    var pctMatch = v.match(/([\d,.]+)\s*%/);
    if (pctMatch) {
      var pct = parseFloat(pctMatch[1].replace(',', '.'));
      if (pct >= 95) return 'smart-positive';
      if (pct >= 80) return 'smart-warning';
      if (pct < 80 && pct > 0) return 'smart-negative';
    }
    // Currency positive/negative
    if (/^-\$/.test(v) || /^-[\d,]+/.test(v)) return 'smart-negative';
    if (/^\$[\d,.]+[MK]?$/.test(v)) return 'smart-highlight';
    return '';
  }

  function escapeHtml(text) {
    if (text == null) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Confidence heuristic ───────────────────────────────────────────────────
  function computeConfidence(text) {
    if (!text) return 'medium';
    var lower = text.toLowerCase();
    var hasNumbers = /\$[\d,.]+|[\d,.]+%/.test(text);
    var hasTable = /\|.*\|.*\|/.test(text);
    var hasUncertainty = /no tengo|no cuento|no dispongo|aproximad|estimad|podr[ií]a ser/i.test(lower);
    var hasSemaforo = /🟢|🟡|🔴/.test(text);
    if (hasUncertainty) return 'low';
    if ((hasNumbers && hasTable) || (hasNumbers && hasSemaforo)) return 'high';
    if (hasNumbers || hasTable) return 'high';
    return 'medium';
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  function showToast(msg, type) {
    var el = document.createElement('div');
    el.className = 'ia-toast ' + (type || 'success');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 3000);
  }

  // ── Suggestions ────────────────────────────────────────────────────────────
  var SUGGESTIONS = [
    '¿Cuánto llevamos de ventas hoy y este mes?',
    '¿Estamos en meta? Proyección de cierre',
    '¿Cuánto está vencido en CxC?',
    'Top 5 vendedores del mes con cumplimiento',
    'Dame un diagnóstico ejecutivo completo',
    'Estado del inventario y quiebres',
    '¿Cómo va el margen bruto?',
    'Plan de cobranza para esta semana',
  ];

  function renderSuggestions() {
    if (!$landingSuggestions) return;
    $landingSuggestions.innerHTML = SUGGESTIONS.slice(0, 6).map(function (s) {
      return '<button class="suggest-chip" data-suggestion="' + escapeHtml(s) + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>' +
        escapeHtml(s) + '</button>';
    }).join('');
    $landingSuggestions.addEventListener('click', function (e) {
      var chip = e.target.closest('.suggest-chip');
      if (!chip) return;
      var text = chip.getAttribute('data-suggestion');
      if (text) {
        $input.value = text;
        handleSubmit();
      }
    });
  }

  // ── Sidebar rendering ─────────────────────────────────────────────────────
  // ── Grupos de contexto (carpetas) para organizar conversaciones ───────────
  var GROUPS_KEY = 'sumi_ia_groups_v1';
  function loadGroups() { try { var a = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function saveGroups(a) { try { localStorage.setItem(GROUPS_KEY, JSON.stringify(a)); } catch (_) {} }
  var groups = loadGroups();
  function newGid() { return 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function addGroup(name, parentId) { groups.push({ id: newGid(), name: String(name || 'Grupo').slice(0, 40), parentId: parentId || null, collapsed: false }); saveGroups(groups); renderSidebar($sidebarSearch ? $sidebarSearch.value : ''); }
  function renameGroup(id) { var g = groups.find(function (x) { return x.id === id; }); if (!g) return; var n = prompt('Renombrar grupo:', g.name); if (n) { g.name = String(n).slice(0, 40); saveGroups(groups); renderSidebar($sidebarSearch ? $sidebarSearch.value : ''); } }
  function toggleGroupCollapse(id) { var g = groups.find(function (x) { return x.id === id; }); if (g) { g.collapsed = !g.collapsed; saveGroups(groups); renderSidebar($sidebarSearch ? $sidebarSearch.value : ''); } }
  function removeGroup(id) {
    var del = {}; del[id] = true; var added = true;
    while (added) { added = false; groups.forEach(function (g) { if (g.parentId && del[g.parentId] && !del[g.id]) { del[g.id] = true; added = true; } }); }
    conversations.forEach(function (c) { if (del[c.groupId]) { c.groupId = null; } });
    saveConversations();
    groups = groups.filter(function (g) { return !del[g.id]; });
    saveGroups(groups);
    renderSidebar($sidebarSearch ? $sidebarSearch.value : '');
  }
  function moveConvoToGroup(convoId, groupId) {
    var c = getConv(convoId); if (!c) return;
    c.groupId = groupId || null;
    c.groupPinned = true; // movida a mano → el auto-agrupado ya no la reubica
    saveConversations(); syncToServer(c);
    renderSidebar($sidebarSearch ? $sidebarSearch.value : '');
  }
  // Expone acciones para el handler global de clicks.
  window.__iaGroups = { add: addGroup, rename: renameGroup, toggle: toggleGroupCollapse, remove: removeGroup, sub: function (p) { var n = prompt('Nombre del subgrupo:'); if (n) addGroup(n, p); } };

  function _convItemHtml(c) {
    var isActive = c.id === activeConvId;
    return '<div class="conv-item' + (isActive ? ' active' : '') + '" draggable="true" data-id="' + c.id + '">' +
      '<span class="conv-title">' + escapeHtml(c.title) + '</span>' +
      '<button class="conv-delete" data-delete="' + c.id + '" title="Eliminar">&#10005;</button>' +
      '</div>';
  }
  function _groupHtml(g, byGroup, depth) {
    var kids = byGroup[g.id] || [];
    var subs = groups.filter(function (x) { return x.parentId === g.id; });
    var h = '<div class="ia-group" data-gid="' + g.id + '">' +
      '<div class="ia-group-head" data-gdrop="' + g.id + '" style="padding-left:' + (8 + depth * 12) + 'px">' +
        '<span class="ia-group-tog" data-gtoggle="' + g.id + '">' + (g.collapsed ? '▸' : '▾') + '</span>' +
        '<span class="ia-group-name" data-gtoggle="' + g.id + '">' + escapeHtml(g.name) + '</span>' +
        '<span class="ia-group-count">' + kids.length + '</span>' +
        '<span class="ia-group-acts">' +
          '<button class="ia-g-act" data-gsub="' + g.id + '" title="Subgrupo">+</button>' +
          '<button class="ia-g-act" data-gren="' + g.id + '" title="Renombrar">✎</button>' +
          '<button class="ia-g-act" data-gdel="' + g.id + '" title="Eliminar">✕</button>' +
        '</span>' +
      '</div>';
    if (!g.collapsed) {
      h += '<div class="ia-group-body">';
      subs.forEach(function (s) { h += _groupHtml(s, byGroup, depth + 1); });
      kids.forEach(function (c) { h += _convItemHtml(c); });
      h += '</div>';
    }
    return h + '</div>';
  }

  function renderSidebar(filter) {
    if (!$sidebarList) return;
    var filterLower = (filter || '').toLowerCase().trim();
    var sorted = conversations.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    if (filterLower) {
      sorted = sorted.filter(function (c) { return c.title.toLowerCase().indexOf(filterLower) !== -1; });
    }

    var validG = {}; groups.forEach(function (g) { validG[g.id] = true; });
    var byGroup = {}; var ungrouped = [];
    sorted.forEach(function (c) {
      if (c.groupId && validG[c.groupId]) { (byGroup[c.groupId] = byGroup[c.groupId] || []).push(c); }
      else ungrouped.push(c);
    });

    var html = '<div class="ia-groups-bar"><button class="ia-add-group" data-gadd="1">+ Grupo de contexto</button></div>';

    // Sin grupo (también es zona de soltado para "sacar" de un grupo)
    html += '<div class="ia-group"><div class="ia-group-head ia-ungrouped-head" data-gdrop="">' +
      '<span class="ia-group-name">Sin grupo</span><span class="ia-group-count">' + ungrouped.length + '</span></div>' +
      '<div class="ia-group-body">';
    ungrouped.forEach(function (c) { html += _convItemHtml(c); });
    html += '</div></div>';

    groups.filter(function (g) { return !g.parentId; }).forEach(function (g) { html += _groupHtml(g, byGroup, 0); });

    if (!sorted.length && !groups.length) {
      html = '<div style="padding:20px 12px;text-align:center;color:#475569;font-size:.78rem;">Sin conversaciones</div>';
    }
    $sidebarList.innerHTML = html;
  }

  // ── Show/hide views ────────────────────────────────────────────────────────
  function showLanding() {
    $landing.classList.remove('hidden');
    $messages.classList.add('hidden');
    $messages.innerHTML = '';
    activeConvId = null;
    renderSidebar();
    $input.focus();
  }

  function showConversation(convId) {
    var conv = getConv(convId);
    if (!conv) return;
    activeConvId = convId;
    $landing.classList.add('hidden');
    $messages.classList.remove('hidden');
    $messages.innerHTML = '';
    conv.messages.forEach(function (m) {
      if (m.role === 'user') appendUserMessage(m.content, m.image);
      else if (m.role === 'assistant') appendAiMessage(m.content);
    });
    scrollToBottom();
    renderSidebar();
    $input.focus();
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function appendUserMessage(text, imageDataUrl) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    var bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (imageDataUrl) {
      var img = document.createElement('img');
      img.className = 'msg-attachment';
      img.src = imageDataUrl;
      img.alt = 'Imagen adjunta';
      bubble.appendChild(img);
    }
    var txt = document.createElement('span');
    txt.textContent = typeof text === 'string' ? text : '';
    bubble.appendChild(txt);
    wrap.appendChild(bubble);
    $messages.appendChild(wrap);
  }

  function appendAiMessage(text, isError) {
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-ai' + (isError ? ' msg-error' : '');

    var avatar = document.createElement('div');
    avatar.className = 'msg-ai-avatar';
    avatar.textContent = 'S';

    var body = document.createElement('div');
    body.className = 'msg-ai-body';

    var content = document.createElement('div');
    content.className = 'msg-ai-content';
    content.innerHTML = isError ? escapeHtml(text) : renderMarkdown(text);

    body.appendChild(content);

    if (!isError && text) {
      var conf = computeConfidence(text);
      var confLabels = { high: 'Alta confianza', medium: 'Confianza media', low: 'Baja confianza' };
      var chip = document.createElement('div');
      chip.className = 'confidence-chip confidence-' + conf;
      chip.textContent = confLabels[conf] || conf;
      body.appendChild(chip);

      var actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML =
        '<button class="msg-action-btn btn-copy-msg" title="Copiar">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>' +
          ' Copiar</button>' +
        '<button class="msg-action-btn btn-export-msg" title="Exportar">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          ' Exportar</button>';
      body.appendChild(actions);
    }

    wrap.appendChild(avatar);
    wrap.appendChild(body);
    $messages.appendChild(wrap);
    return content;
  }

  function appendTypingIndicator() {
    var existing = document.getElementById('typing-indicator');
    if (existing) existing.remove();
    var wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap.id = 'typing-indicator';
    var avatar = document.createElement('div');
    avatar.className = 'msg-ai-avatar';
    avatar.textContent = 'S';
    var body = document.createElement('div');
    body.className = 'msg-ai-body';
    body.innerHTML = '<div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>';
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    $messages.appendChild(wrap);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    var el = document.getElementById('typing-indicator');
    if (el) el.remove();
  }

  function scrollToBottom() {
    if ($messages) {
      $messages.scrollTop = $messages.scrollHeight;
    }
  }

  // ── Image attachment ──────────────────────────────────────────────────────
  function handleFileSelect(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('Imagen demasiado grande (max 10MB)', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      var base64 = dataUrl.split(',')[1];
      pendingImage = { dataUrl: dataUrl, base64: base64, mime: file.type };
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }

  function renderAttachments() {
    if (!$attachments) return;
    if (!pendingImage) {
      $attachments.innerHTML = '';
      return;
    }
    $attachments.innerHTML =
      '<div class="attachment-preview">' +
        '<img src="' + pendingImage.dataUrl + '" alt="Adjunto">' +
        '<button class="attachment-remove" id="btn-remove-attach">&times;</button>' +
      '</div>';
    document.getElementById('btn-remove-attach').addEventListener('click', function () {
      pendingImage = null;
      renderAttachments();
    });
  }

  // ── Model mapping ─────────────────────────────────────────────────────────
  function getModelHint() {
    var val = $modelSelector ? $modelSelector.value : 'auto';
    if (val === 'quality') return 'sonnet';
    if (val === 'max') return 'opus';
    return '';
  }

  // ── Submit handler ────────────────────────────────────────────────────────
  function handleSubmit(e) {
    if (e) e.preventDefault();
    var text = $input.value.trim();
    if (!text && !pendingImage) return;
    if (isStreaming) return;

    // Ensure conversation exists
    var conv;
    if (activeConvId) {
      conv = getConv(activeConvId);
    }
    if (!conv) {
      conv = createConversation();
      activeConvId = conv.id;
      $landing.classList.add('hidden');
      $messages.classList.remove('hidden');
      $messages.innerHTML = '';
    }

    // Save user message
    var userMsg = { role: 'user', content: text || '(imagen adjunta)' };
    if (pendingImage) userMsg.image = pendingImage.dataUrl;
    conv.messages.push(userMsg);
    conv.updatedAt = Date.now();
    autoTitle(conv);
    saveConversations();

    // Render user message
    appendUserMessage(text, pendingImage ? pendingImage.dataUrl : null);
    scrollToBottom();

    // Clear input
    var imageToSend = pendingImage;
    $input.value = '';
    $input.style.height = 'auto';
    pendingImage = null;
    renderAttachments();
    updateSendButton();

    // Send to API
    sendToApi(conv, text, imageToSend);
  }

  function sendToApi(conv, text, image) {
    isStreaming = true;
    $btnSend.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    appendTypingIndicator();

    abortCtrl = new AbortController();

    var historyForApi = conv.messages.slice(-10).filter(function (m) { return m.role !== 'user' || conv.messages.indexOf(m) !== conv.messages.length - 1; }).map(function (m) {
      return { role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 2000) : '' };
    });

    var payload = {
      message: text || '(imagen adjunta)',
      messages: historyForApi,
      db: currentDb(),
      context: {
        page: 'Sumi IA',
        url: location.href,
      },
    };

    var modelHint = getModelHint();
    if (modelHint) payload.modelHint = modelHint;

    if (image) {
      payload.imageBase64 = image.base64;
      payload.imageMimeType = image.mime;
    }

    fetch(API + '/api/ai/chat-v3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortCtrl.signal,
      credentials: 'same-origin',
    })
    .then(function (resp) {
      if (!resp.ok) throw new Error('Error del servidor: ' + resp.status);
      return resp.json();
    })
    .then(function (data) {
      removeTypingIndicator();
      var reply = data.reply || data.response || '(Sin respuesta)';

      conv.messages.push({ role: 'assistant', content: reply });
      conv.updatedAt = Date.now();
      saveConversations();
      syncToServer(conv);

      var contentEl = appendAiMessage(reply);
      applySmartTdToElement(contentEl);
      scrollToBottom();
    })
    .catch(function (err) {
      removeTypingIndicator();
      if (err.name === 'AbortError') {
        appendAiMessage('Respuesta cancelada por el usuario.', true);
      } else {
        appendAiMessage('Error: ' + err.message, true);
      }
      scrollToBottom();
    })
    .finally(function () {
      isStreaming = false;
      abortCtrl = null;
      $btnStop.classList.add('hidden');
      $btnSend.classList.remove('hidden');
      updateSendButton();
    });
  }

  // ── SmartTD post-processing ────────────────────────────────────────────────
  function applySmartTdToElement(el) {
    if (!el) return;
    var cells = el.querySelectorAll('td');
    cells.forEach(function (td) {
      if (td.className) return;
      var cls = smartTdClass(td.textContent);
      if (cls) td.className = cls;
    });
  }

  // ── Copy / export handlers ─────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    // Copy message
    var copyBtn = e.target.closest('.btn-copy-msg');
    if (copyBtn) {
      var msgContent = copyBtn.closest('.msg-ai-body');
      if (msgContent) {
        var contentEl = msgContent.querySelector('.msg-ai-content');
        var text = contentEl ? contentEl.textContent : '';
        navigator.clipboard.writeText(text).then(function () {
          copyBtn.classList.add('copied');
          copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copiado';
          setTimeout(function () {
            copyBtn.classList.remove('copied');
            copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar';
          }, 2000);
        });
      }
      return;
    }

    // Export message
    var exportBtn = e.target.closest('.btn-export-msg');
    if (exportBtn) {
      var msgBody = exportBtn.closest('.msg-ai-body');
      if (msgBody) {
        var exportContentEl = msgBody.querySelector('.msg-ai-content');
        var exportText = exportContentEl ? exportContentEl.textContent : '';
        var blob = new Blob([exportText], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'sumi-ia-respuesta-' + new Date().toISOString().slice(0, 10) + '.txt';
        a.click();
        URL.revokeObjectURL(url);
        showToast('Respuesta exportada', 'success');
      }
      return;
    }

    // Sidebar conversation click
    var convItem = e.target.closest('.conv-item');
    if (convItem && !e.target.closest('.conv-delete')) {
      var id = convItem.getAttribute('data-id');
      if (id) {
        showConversation(id);
        closeMobileSidebar();
      }
      return;
    }

    // Sidebar delete
    var delBtn = e.target.closest('.conv-delete');
    if (delBtn) {
      var delId = delBtn.getAttribute('data-delete');
      if (delId) deleteConversation(delId);
      return;
    }

    // ── Grupos de contexto ──
    var addG = e.target.closest('[data-gadd]');
    if (addG) { var nm = prompt('Nombre del grupo de contexto:'); if (nm) window.__iaGroups.add(nm, null); return; }
    var tog = e.target.closest('[data-gtoggle]');
    if (tog) { window.__iaGroups.toggle(tog.getAttribute('data-gtoggle')); return; }
    var sub = e.target.closest('[data-gsub]');
    if (sub) { window.__iaGroups.sub(sub.getAttribute('data-gsub')); return; }
    var ren = e.target.closest('[data-gren]');
    if (ren) { window.__iaGroups.rename(ren.getAttribute('data-gren')); return; }
    var gdel = e.target.closest('[data-gdel]');
    if (gdel) { if (confirm('¿Eliminar este grupo? Sus conversaciones pasan a "Sin grupo".')) window.__iaGroups.remove(gdel.getAttribute('data-gdel')); return; }
  });

  // ── Drag & drop: arrastra una conversación a un grupo ──────────────────────
  if ($sidebarList) {
    $sidebarList.addEventListener('dragstart', function (e) {
      var it = e.target.closest('.conv-item');
      if (!it) return;
      it.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', it.getAttribute('data-id')); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    });
    $sidebarList.addEventListener('dragend', function (e) {
      var it = e.target.closest('.conv-item'); if (it) it.classList.remove('dragging');
    });
    $sidebarList.addEventListener('dragover', function (e) {
      var head = e.target.closest('[data-gdrop]'); if (!head) return;
      e.preventDefault(); head.classList.add('ia-drop'); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    });
    $sidebarList.addEventListener('dragleave', function (e) {
      var head = e.target.closest('[data-gdrop]'); if (head) head.classList.remove('ia-drop');
    });
    $sidebarList.addEventListener('drop', function (e) {
      var head = e.target.closest('[data-gdrop]'); if (!head) return;
      e.preventDefault(); head.classList.remove('ia-drop');
      var cid = ''; try { cid = e.dataTransfer.getData('text/plain'); } catch (_) {}
      if (cid) moveConvoToGroup(cid, head.getAttribute('data-gdrop') || null);
    });
  }

  // ── Input auto-resize ─────────────────────────────────────────────────────
  function autoResize() {
    $input.style.height = 'auto';
    var maxH = window.innerWidth <= 480 ? 120 : 180;
    $input.style.height = Math.min($input.scrollHeight, maxH) + 'px';
  }

  function updateSendButton() {
    var hasText = $input.value.trim().length > 0;
    var hasImage = !!pendingImage;
    $btnSend.disabled = !(hasText || hasImage);
  }

  // ── Mobile sidebar ────────────────────────────────────────────────────────
  var $backdrop = document.createElement('div');
  $backdrop.id = 'sidebar-backdrop';
  document.body.appendChild($backdrop);

  function toggleMobileSidebar() {
    $sidebar.classList.toggle('open');
    $backdrop.classList.toggle('visible');
  }

  function closeMobileSidebar() {
    $sidebar.classList.remove('open');
    $backdrop.classList.remove('visible');
    if (document.activeElement && $sidebar.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    // Ctrl+Shift+O = new chat
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      showLanding();
      return;
    }
    // Ctrl+U = attach
    if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
      e.preventDefault();
      $fileInput.click();
      return;
    }
    // Escape = close sidebar or stop streaming
    if (e.key === 'Escape') {
      if (isStreaming && abortCtrl) {
        abortCtrl.abort();
      }
      closeMobileSidebar();
    }
  });

  // ── Event bindings ─────────────────────────────────────────────────────────
  $form.addEventListener('submit', handleSubmit);

  $input.addEventListener('input', function () {
    autoResize();
    updateSendButton();
  });

  $input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });

  $btnStop.addEventListener('click', function () {
    if (abortCtrl) abortCtrl.abort();
  });

  $btnNewChat.addEventListener('click', function () {
    showLanding();
    closeMobileSidebar();
  });

  $btnAttach.addEventListener('click', function () {
    $fileInput.click();
  });

  $fileInput.addEventListener('change', function () {
    if ($fileInput.files && $fileInput.files[0]) {
      handleFileSelect($fileInput.files[0]);
    }
    $fileInput.value = '';
  });

  $btnToggle.addEventListener('click', toggleMobileSidebar);
  $backdrop.addEventListener('click', closeMobileSidebar);

  $sidebarSearch.addEventListener('input', function () {
    renderSidebar($sidebarSearch.value);
  });

  // Drag & drop images
  $form.addEventListener('dragover', function (e) {
    e.preventDefault();
    $form.style.borderColor = 'rgba(230,168,0,.6)';
  });
  $form.addEventListener('dragleave', function () {
    $form.style.borderColor = '';
  });
  $form.addEventListener('drop', function (e) {
    e.preventDefault();
    $form.style.borderColor = '';
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  });

  // ── Paste images ──────────────────────────────────────────────────────────
  $input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (file) handleFileSelect(file);
        break;
      }
    }
  });

  // ── Dynamic app height based on actual header height ────────────────────
  (function syncAppHeight() {
    function update() {
      var header = document.getElementById('app-header');
      var h = header ? header.offsetHeight : 0;
      if (h > 0) {
        var app = document.getElementById('ia-app');
        if (app) {
          app.style.height = 'calc(100dvh - ' + h + 'px)';
          app.style.height = 'calc(100vh - ' + h + 'px)';
          if (CSS.supports && CSS.supports('height', '100dvh')) {
            app.style.height = 'calc(100dvh - ' + h + 'px)';
          }
        }
      }
    }
    if (document.readyState === 'complete') update();
    else window.addEventListener('load', update);
    window.addEventListener('resize', update);
    setTimeout(update, 500);
    setTimeout(update, 1500);
  })();

  // ── Mobile: swipe to open/close sidebar ─────────────────────────────────
  (function initSwipe() {
    var startX = 0;
    var startY = 0;
    var swiping = false;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = true;
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (!swiping) return;
      swiping = false;
      var endX = e.changedTouches[0].clientX;
      var endY = e.changedTouches[0].clientY;
      var dx = endX - startX;
      var dy = Math.abs(endY - startY);
      if (dy > 80) return;
      // Swipe right from left edge → open
      if (dx > 60 && startX < 30 && !$sidebar.classList.contains('open')) {
        toggleMobileSidebar();
        return;
      }
      // Swipe left → close
      if (dx < -60 && $sidebar.classList.contains('open')) {
        closeMobileSidebar();
      }
    }, { passive: true });
  })();

  // ── Mobile: virtual keyboard detection via visualViewport ──────────────
  (function initMobileKeyboard() {
    if (!window.visualViewport) return;
    var initialHeight = window.visualViewport.height;
    var threshold = 150;
    window.visualViewport.addEventListener('resize', function () {
      var diff = initialHeight - window.visualViewport.height;
      if (diff > threshold) {
        document.body.classList.add('keyboard-open');
        scrollToBottom();
      } else {
        document.body.classList.remove('keyboard-open');
      }
    });
  })();

  // iOS scroll bounce: ya manejado por CSS `overscroll-behavior: contain` en ia.css.
  // El listener JS anterior caminaba el árbol DOM en cada touchmove (jank en
  // móviles low-end) y rompía scroll en <select> nativos.

  // ── Landing headline ────────────────────────────────────────────────────
  var $landingHeadline = document.getElementById('landing-headline');
  if ($landingHeadline) {
    $landingHeadline.innerHTML = '¿Qué quieres <em>consultar</em> hoy?';
  }

  // ── Business-unit cards in landing ─────────────────────────────────────
  var $bizUnits = document.getElementById('landing-biz-units');

  function renderBizUnits() {
    if (!$bizUnits) return;
    fetch(API + '/api/universe/databases')
      .then(function (r) { return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) return;
        var selectedDb = currentDb();
        var colors = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#06B6D4','#F97316'];
        var html = '';
        list.forEach(function (db, i) {
          var id = String(db.id || '');
          var name = String(db.label || db.id || '').replace(/\.fdb$/i, '').replace(/_/g, ' ');
          name = name.charAt(0).toUpperCase() + name.slice(1);
          var isActive = (selectedDb === id);
          var color = colors[i % colors.length];
          html += '<button class="biz-unit-card' + (isActive ? ' active' : '') + '" data-db="' + escapeHtml(id) + '">' +
            '<div class="biz-unit-name"><span class="biz-dot" style="background:' + color + '"></span>' + escapeHtml(name) + '</div>' +
            '<div class="biz-unit-desc">' + escapeHtml(String(db.host || 'ERP Microsip')) + '</div>' +
            '</button>';
        });
        $bizUnits.innerHTML = html;
        $bizUnits.addEventListener('click', function (e) {
          var card = e.target.closest('.biz-unit-card');
          if (!card) return;
          var dbId = card.getAttribute('data-db');
          if (!dbId) return;
          try { sessionStorage.setItem('microsip_erp_db', dbId); } catch (_) {}
          try {
            var u = new URL(window.location.href);
            u.searchParams.set('db', dbId);
            history.replaceState({}, '', u);
          } catch (_) {}
          $bizUnits.querySelectorAll('.biz-unit-card').forEach(function (c) { c.classList.remove('active'); });
          card.classList.add('active');
        });
      })
      .catch(function () {});
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  renderSuggestions();
  renderBizUnits();
  renderSidebar();
  showLanding();
  loadServerConversations();

  // Focus only on desktop (avoids keyboard popup on mobile load)
  if (window.innerWidth > 768) $input.focus();
})();
