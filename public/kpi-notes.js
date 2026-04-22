/**
 * kpi-notes.js — Comentarios inline por KPI (localStorage persistente)
 * Cada KPI con data-note-key="..." recibe un icono 💬 clicable.
 * Al hacer click, popover con textarea para agregar contexto.
 * Notas se guardan en localStorage por key + db.
 */
(function () {
  'use strict';
  if (window.__sumiNotesMounted) return;
  window.__sumiNotesMounted = true;

  var DB_KEY = function () { try { return localStorage.getItem('sumi_db') || 'default'; } catch (_) { return 'default'; } };
  var NOTE_KEY = function (k) { return 'sumi_note_' + DB_KEY() + '_' + k; };

  var css = [
    '.sumi-note-btn{background:transparent;border:none;cursor:pointer;padding:2px 4px;margin-left:6px;font-size:.85rem;opacity:.4;transition:opacity .15s ease;vertical-align:middle}',
    '.sumi-note-btn:hover{opacity:1}',
    '.sumi-note-btn.has-note{opacity:1;color:#E6A800}',
    '.sumi-note-pop{position:absolute;z-index:9998;background:#fff;border:1px solid rgba(230,168,0,.3);border-radius:12px;padding:10px;box-shadow:0 12px 32px -8px rgba(15,23,42,.2);min-width:260px}',
    '.sumi-note-pop textarea{width:100%;min-height:80px;border:1px solid rgba(15,23,42,.1);border-radius:8px;padding:6px 8px;font-family:inherit;font-size:.82rem;color:#0F172A;resize:vertical}',
    '.sumi-note-pop .note-actions{display:flex;justify-content:space-between;margin-top:8px;gap:8px}',
    '.sumi-note-pop button{background:linear-gradient(135deg,#F5C33C,#E6A800);color:#1A1200;border:none;padding:5px 12px;border-radius:6px;font-weight:600;font-size:.75rem;cursor:pointer}',
    '.sumi-note-pop button.del{background:#fee;color:#B91C1C;border:1px solid rgba(239,68,68,.3)}',
    '.sumi-note-pop .note-meta{font-size:.65rem;color:#94A3B8;margin-top:6px;font-family:"DM Mono",monospace}',
  ].join('');
  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  function getNote(k) {
    try {
      var raw = localStorage.getItem(NOTE_KEY(k));
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function setNote(k, text) {
    try {
      if (!text) { localStorage.removeItem(NOTE_KEY(k)); return; }
      localStorage.setItem(NOTE_KEY(k), JSON.stringify({ text: text, ts: Date.now() }));
    } catch (_) {}
  }

  var currentPop = null;
  function closePop() { if (currentPop) { currentPop.remove(); currentPop = null; } }

  function openPop(btn, key) {
    closePop();
    var note = getNote(key) || {};
    var pop = document.createElement('div');
    pop.className = 'sumi-note-pop';
    pop.innerHTML =
      '<textarea placeholder="Escribe contexto o explicación para este KPI…">' + (note.text || '') + '</textarea>' +
      '<div class="note-actions">' +
        '<button class="del" type="button">Borrar</button>' +
        '<button class="save" type="button">Guardar</button>' +
      '</div>' +
      (note.ts ? '<div class="note-meta">Última edición: ' + new Date(note.ts).toLocaleString('es-MX') + '</div>' : '');
    document.body.appendChild(pop);
    var rect = btn.getBoundingClientRect();
    pop.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
    pop.style.left = Math.max(10, Math.min(window.innerWidth - 280, rect.left + window.scrollX)) + 'px';
    currentPop = pop;

    pop.querySelector('.save').addEventListener('click', function () {
      var v = pop.querySelector('textarea').value.trim();
      setNote(key, v);
      btn.classList.toggle('has-note', !!v);
      btn.title = v ? 'Nota: ' + v.slice(0, 80) : 'Agregar nota';
      closePop();
    });
    pop.querySelector('.del').addEventListener('click', function () {
      setNote(key, '');
      btn.classList.remove('has-note');
      btn.title = 'Agregar nota';
      closePop();
    });
    setTimeout(function () { pop.querySelector('textarea').focus(); }, 20);
  }

  document.addEventListener('click', function (e) {
    if (currentPop && !currentPop.contains(e.target) && !e.target.classList.contains('sumi-note-btn')) closePop();
  });

  function decorate() {
    document.querySelectorAll('[data-note-key]').forEach(function (el) {
      if (el.querySelector('.sumi-note-btn')) return;
      var key = el.dataset.noteKey;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sumi-note-btn';
      btn.innerHTML = '💬';
      btn.title = 'Agregar nota';
      var existing = getNote(key);
      if (existing && existing.text) {
        btn.classList.add('has-note');
        btn.title = 'Nota: ' + existing.text.slice(0, 80);
      }
      btn.addEventListener('click', function (e) { e.stopPropagation(); openPop(btn, key); });
      var target = el.querySelector('.kpi-lbl, .kpi-label, h3, h4') || el;
      target.appendChild(btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', decorate);
  } else {
    decorate();
  }
  setTimeout(decorate, 1200);
  setTimeout(decorate, 3500);
})();
