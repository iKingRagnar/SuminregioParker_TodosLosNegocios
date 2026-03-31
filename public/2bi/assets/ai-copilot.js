/**
 * Copiloto 2BI — UI autónoma (demo local, sin API).
 * Atajos: Ctrl/Cmd+K paleta · Esc cierra
 */
(function () {
  "use strict";

  var KB = [
    { q: /qu[eé]\s+(es|significa)\s+2bi|qui[eé]nes\s+son/i, a: "2BI Intelligence Solutions combina BI, gobernanza de datos e IA aplicada. Ayudamos a que dirección y TI compartan el mismo mapa: KPIs accionables, pipelines documentados y narrativa clara." },
    { q: /stack|tecnolog[ií]a|herramienta|azure|power|fabric|sql|python|airflow|n8n/i, a: "Trabajamos con Microsoft Fabric, Power BI, SQL Server, Firebird, Python, dbt, Airflow, n8n y APIs REST — siempre según tu contexto (legacy, híbrido o nube)." },
    { q: /soluciones|m[oó]dulo|qu[eé]\s+ofrecen/i, a: "Cubrimos scorecard y KPIs, finanzas y margen, operación e inventario, CX/cobranza, automatización y capa IA asistida (resúmenes, Q&A sobre métricas). Cada módulo tiene ejemplo navegable." },
    { q: /contacto|hablar|reuni[oó]n|correo|email|hablemos/i, a: "Para agendar: usa el botón «Hablemos» o escribe a hola@2bi.example (sustituye por tu correo real en el sitio). El copiloto es demo; un humano cierra el ciclo." },
    { q: /gobernanza|seguridad|rgpd|privacidad/i, a: "Diseñamos con mínimo privilegio, trazas y acuerdos de uso de datos. La seguridad entra en el diseño, no como parche al final." },
    { q: /ecosistema|integraci[oó]n|capa/i, a: "Arquitectura por capas: consumo y narrativa, almacenamiento y modelo, transformación y orquestación, integración. En la página Ecosistema está el detalle con etiquetas por capa." },
    { q: /ia|inteligencia\s+artificial|gpt|copiloto|aut[oó]nom/i, a: "Este sitio incluye esta interfaz de copiloto (demo local) para que veas el tipo de experiencia: sugerencias, respuestas contextuales y paleta de comandos (Ctrl+K). En proyectos reales conectamos a tus datos con gobernanza." },
    { q: /hola|buenas|hey|hi\b/i, a: "Hola. Puedo orientarte sobre 2BI, stack, soluciones o contacto. También abre la paleta con Ctrl+K (Cmd+K en Mac)." },
  ];

  function defaultReply() {
    return "Puedo ayudarte con: qué es 2BI, stack tecnológico, soluciones, ecosistema por capas, gobernanza o cómo contactar. Elige una sugerencia abajo o reformula la pregunta.";
  }

  function matchReply(text) {
    var t = String(text || "").trim();
    if (!t) return defaultReply();
    for (var i = 0; i < KB.length; i++) {
      if (KB[i].q.test(t)) return KB[i].a;
    }
    return defaultReply();
  }

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function buildUI() {
    var root = el(
      '<div id="ai-copilot-root" aria-live="polite">' +
        '<div id="ai-copilot-backdrop" aria-hidden="true"></div>' +
        '<div id="ai-copilot-panel" role="dialog" aria-label="Copiloto 2BI" aria-hidden="true">' +
        '<div class="ai-panel-head">' +
        '<div class="ai-panel-head-top">' +
        '<div>' +
        '<div class="ai-panel-title">Copiloto 2BI</div>' +
        '<div class="ai-panel-sub">Interfaz autónoma · demo local</div>' +
        '<div class="ai-panel-status"><span class="dot"></span> Contexto de página cargado</div>' +
        '<div class="ai-panel-kbd">Paleta rápida Ctrl+K · Esc cierra</div>' +
        "</div>" +
        '<button type="button" class="ai-panel-close" id="ai-copilot-close" aria-label="Cerrar">×</button>' +
        "</div></div>" +
        '<div id="ai-copilot-msgs"></div>' +
        '<div class="ai-chips" id="ai-copilot-chips"></div>' +
        '<div class="ai-panel-input-wrap">' +
        '<input type="text" id="ai-copilot-input" placeholder="Pregunta lo que necesites…" autocomplete="off" />' +
        '<button type="button" id="ai-copilot-send">Enviar</button>' +
        "</div>" +
        '<p class="ai-panel-foot">Respuestas de demostración. En producción se conecta a tus datos y políticas.</p>' +
        "</div>" +
        '<button type="button" id="ai-copilot-fab" aria-label="Abrir copiloto" aria-expanded="false">' +
        '<span class="ai-fab-ring" aria-hidden="true"></span>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />' +
        "</svg></button>" +
        '<div id="ai-palette" aria-hidden="true">' +
        '<div id="ai-palette-backdrop"></div>' +
        '<div id="ai-palette-box" role="dialog" aria-label="Paleta de comandos">' +
        '<input id="ai-palette-input" type="text" placeholder="Buscar acción o ir a…" autocomplete="off" />' +
        '<div id="ai-palette-list"></div>' +
        '<p class="ai-palette-hint">↑↓ navegar · Enter abrir · Esc salir</p>' +
        "</div></div>" +
        '<div id="ai-status-bar" title="Estado del copiloto (demo)">' +
        '<span class="ai-sb-dot"></span>' +
        '<span id="ai-status-text">Copiloto en línea · interfaz lista</span>' +
        "</div>" +
        "</div>"
    );
    document.body.appendChild(root);
    return root;
  }

  var chips = ["¿Qué es 2BI?", "Stack que usan", "¿Cómo contacto?", "Ecosistema por capas", "IA en proyectos"];

  var paletteActions = [
    { label: "Inicio", href: "index.html", keys: "g i" },
    { label: "Nosotros", href: "nosotros.html", keys: "g n" },
    { label: "Soluciones", href: "soluciones.html", keys: "g s" },
    { label: "Valores", href: "valores.html", keys: "g v" },
    { label: "Ecosistema", href: "ecosistema.html", keys: "g e" },
    { label: "Abrir copiloto", action: "openCopilot", keys: "" },
    { label: "Contacto por correo", href: "mailto:hola@2bi.example?subject=2BI", keys: "" },
  ];

  function init() {
    buildUI();
    var fab = document.getElementById("ai-copilot-fab");
    var panel = document.getElementById("ai-copilot-panel");
    var backdrop = document.getElementById("ai-copilot-backdrop");
    var closeBtn = document.getElementById("ai-copilot-close");
    var msgs = document.getElementById("ai-copilot-msgs");
    var input = document.getElementById("ai-copilot-input");
    var send = document.getElementById("ai-copilot-send");
    var chipWrap = document.getElementById("ai-copilot-chips");
    var pal = document.getElementById("ai-palette");
    var palIn = document.getElementById("ai-palette-input");
    var palList = document.getElementById("ai-palette-list");
    var palBack = document.getElementById("ai-palette-backdrop");
    var statusText = document.getElementById("ai-status-text");

    chips.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ai-chip";
      b.textContent = c;
      b.addEventListener("click", function () {
        input.value = c;
        submit();
      });
      chipWrap.appendChild(b);
    });

    function addMsg(text, role) {
      var m = document.createElement("div");
      m.className = "ai-msg ai-msg--" + role;
      m.textContent = text;
      msgs.appendChild(m);
      msgs.scrollTop = msgs.scrollHeight;
      return m;
    }

    function addTyping() {
      var m = document.createElement("div");
      m.className = "ai-msg ai-msg--bot ai-msg--typing";
      m.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      msgs.appendChild(m);
      msgs.scrollTop = msgs.scrollHeight;
      return m;
    }

    function welcome() {
      var page = "";
      try {
        page = document.title.split("—").pop().trim() || "";
      } catch (e) {}
      addMsg(
        "Estoy leyendo el contexto de «" + page + "». Pregunta por stack, soluciones o cómo contactar al equipo. Demo local — sin enviar datos a servidor.",
        "bot"
      );
    }

    function setOpen(open) {
      fab.setAttribute("aria-expanded", open ? "true" : "false");
      panel.classList.toggle("is-open", open);
      panel.setAttribute("aria-hidden", open ? "false" : "true");
      backdrop.classList.toggle("is-on", open);
      if (open) {
        setTimeout(function () {
          input.focus();
        }, 200);
      }
    }

    function toggle() {
      setOpen(!panel.classList.contains("is-open"));
    }

    fab.addEventListener("click", toggle);
    closeBtn.addEventListener("click", function () {
      setOpen(false);
    });
    backdrop.addEventListener("click", function () {
      setOpen(false);
    });

    function submit() {
      var q = String(input.value || "").trim();
      if (!q) return;
      addMsg(q, "user");
      input.value = "";
      var typing = addTyping();
      var delay = 450 + Math.min(900, q.length * 12);
      setTimeout(function () {
        typing.remove();
        addMsg(matchReply(q), "bot");
      }, delay);
    }

    send.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });

    /* Paleta */
    var palOpen = false;
    var palIdx = 0;
    var filtered = paletteActions.slice();

    function renderPalette() {
      palList.innerHTML = "";
      filtered.forEach(function (item, i) {
        var row = document.createElement("div");
        row.className = "ai-pal-item" + (i === palIdx ? " is-active" : "");
        row.textContent = item.label;
        if (item.keys) {
          var k = document.createElement("kbd");
          k.textContent = item.keys;
          row.appendChild(k);
        }
        row.addEventListener("mousedown", function (e) {
          e.preventDefault();
          runPal(item);
        });
        palList.appendChild(row);
      });
    }

    function runPal(item) {
      closePal();
      if (item.href) {
        window.location.href = item.href;
      } else if (item.action === "openCopilot") {
        setOpen(true);
      }
    }

    function openPal() {
      palOpen = true;
      pal.classList.add("is-on");
      pal.setAttribute("aria-hidden", "false");
      palIdx = 0;
      filtered = paletteActions.slice();
      palIn.value = "";
      renderPalette();
      setTimeout(function () {
        palIn.focus();
      }, 50);
    }

    function closePal() {
      palOpen = false;
      pal.classList.remove("is-on");
      pal.setAttribute("aria-hidden", "true");
    }

    function filterPal(q) {
      var s = String(q || "").toLowerCase();
      if (!s) {
        filtered = paletteActions.slice();
      } else {
        filtered = paletteActions.filter(function (x) {
          return x.label.toLowerCase().indexOf(s) !== -1;
        });
      }
      palIdx = 0;
      renderPalette();
    }

    palIn.addEventListener("input", function () {
      filterPal(palIn.value);
    });
    palBack.addEventListener("click", closePal);

    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (palOpen) closePal();
        else openPal();
      }
      if (e.key === "Escape") {
        if (palOpen) closePal();
        else setOpen(false);
      }
      if (palOpen && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
        e.preventDefault();
        if (e.key === "ArrowDown") palIdx = Math.min(filtered.length - 1, palIdx + 1);
        if (e.key === "ArrowUp") palIdx = Math.max(0, palIdx - 1);
        if (e.key === "Enter" && filtered[palIdx]) runPal(filtered[palIdx]);
        renderPalette();
      }
    });

    /* [data-ai-open] */
    document.querySelectorAll("[data-ai-open]").forEach(function (node) {
      node.addEventListener("click", function () {
        setOpen(true);
      });
    });

    var ribbonBtn = document.getElementById("ai-open-ribbon");
    if (ribbonBtn) ribbonBtn.addEventListener("click", function () {
      setOpen(true);
    });

    welcome();

    /* Rotación texto barra estado */
    var statusLines = [
      "Copiloto en línea · interfaz lista",
      "Contexto de página activo",
      "Ctrl+K · paleta de comandos",
      "Demo local · sin backend",
    ];
    var si = 0;
    setInterval(function () {
      if (!statusText) return;
      si = (si + 1) % statusLines.length;
      statusText.textContent = statusLines[si];
    }, 4200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
