'use strict';

/**
 * ai-chat-v2.js — Sumi IA: asistente conversacional elite con streaming + contexto rico
 *
 * Endpoints:
 *   POST /api/ai/chat-v2          { message, db?, sessionId?, stream? }
 *   POST /api/ai/chat-v2/stream   SSE streaming version
 *   GET  /api/ai/sessions         lista conversaciones activas
 *   DELETE /api/ai/sessions/:id
 */

function install(app, { duckSnaps, log }) {
  var Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }

  var client = null;
  if (Anthropic && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)) {
    try {
      client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
    } catch (e) { log.warn('ai-chat-v2', 'init error: ' + e.message); }
  }

  var sessions = new Map();
  var MAX_SESSIONS = 50;
  var MAX_MSGS = 50;

  var MODEL_CANDIDATES = (function () {
    var env = String(process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || '').trim();
    var defaults = [
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
    ];
    var out = [];
    if (env) out.push(env);
    defaults.forEach(function (m) { if (out.indexOf(m) === -1) out.push(m); });
    return out;
  })();

  function getSnap(id) {
    var s = duckSnaps.get(id);
    return (s && s.conn) ? s : null;
  }

  function all(snap, sql) {
    return new Promise(function (res, rej) {
      snap.conn.all(sql, function (err, rows) { err ? rej(err) : res(rows || []); });
    });
  }

  function fmtM(n) {
    if (n == null || isNaN(+n)) return 'N/D';
    n = +n;
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n).toLocaleString('es-MX');
  }

  function pct(part, total) {
    if (!total || total <= 0) return '0';
    return ((part / total) * 100).toFixed(1);
  }

  // ── Contexto rico en tiempo real ──────────────────────────────────────────
  async function buildContext(dbId) {
    var snap = getSnap(dbId);
    if (!snap) return 'SIN SNAPSHOT: no hay datos cargados para ' + dbId;
    try {
      var results = await Promise.all([
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total, COUNT(*) AS docs, AVG(IMPORTE_NETO) AS ticket FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE FECHA = CURRENT_DATE - INTERVAL 1 DAY AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
        all(snap, "SELECT SUM(IMPORTE_NETO) AS total FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE - INTERVAL 1 MONTH) AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
        all(snap, "SELECT SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS saldo, SUM(CASE WHEN FECHA_VENCIMIENTO < CURRENT_DATE AND IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS vencido, COUNT(DISTINCT CASE WHEN IMPORTE > 0 THEN CLIENTE_ID END) AS num_clientes FROM IMPORTES_DOCTOS_CC").catch(function () { return [{}]; }),
        all(snap, "SELECT COUNT(*) AS n FROM ARTICULOS").catch(function () { return [{}]; }),
        all(snap, "SELECT COUNT(*) AS n FROM CLIENTES").catch(function () { return [{}]; }),
        all(snap, "SELECT v.NOMBRE, SUM(d.IMPORTE_NETO) AS total FROM DOCTOS_VE d LEFT JOIN VENDEDORES v ON v.VENDEDOR_ID = d.VENDEDOR_ID WHERE date_trunc('month', d.FECHA) = date_trunc('month', CURRENT_DATE) AND (d.ESTATUS IS NULL OR d.ESTATUS <> 'C') GROUP BY v.NOMBRE ORDER BY total DESC LIMIT 5").catch(function () { return []; }),
        all(snap, "SELECT c.NOMBRE, SUM(d.IMPORTE) AS saldo FROM IMPORTES_DOCTOS_CC d LEFT JOIN CLIENTES c ON c.CLIENTE_ID = d.CLIENTE_ID GROUP BY c.NOMBRE HAVING SUM(d.IMPORTE) > 0 ORDER BY saldo DESC LIMIT 5").catch(function () { return []; }),
        all(snap, "SELECT SUM(IMPORTE_NETO) AS ventas, SUM(COSTO_TOTAL) AS costo FROM DOCTOS_VE WHERE date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE) AND (ESTATUS IS NULL OR ESTATUS <> 'C')").catch(function () { return [{}]; }),
        all(snap, "SELECT SUM(ABS(IMPORTE)) AS cobrado, COUNT(*) AS movs FROM IMPORTES_DOCTOS_CC WHERE IMPORTE < 0 AND date_trunc('month', FECHA) = date_trunc('month', CURRENT_DATE)").catch(function () { return [{}]; }),
      ]);

      var ventasHoy = results[0], ventasMes = results[1], ventasAyer = results[2];
      var ventasMesAnt = results[3], cxc = results[4], inv = results[5];
      var clientes = results[6], topVend = results[7], topDeud = results[8];
      var margen = results[9], cobros = results[10];

      var today = new Date();
      var dia = today.getDate();
      var diasMes = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      var pctMes = pct(dia, diasMes);

      var vh = +(ventasHoy[0] && ventasHoy[0].total) || 0;
      var vm = +(ventasMes[0] && ventasMes[0].total) || 0;
      var va = +(ventasAyer[0] && ventasAyer[0].total) || 0;
      var vma = +(ventasMesAnt[0] && ventasMesAnt[0].total) || 0;
      var docs = +(ventasMes[0] && ventasMes[0].docs) || 0;
      var ticket = +(ventasMes[0] && ventasMes[0].ticket) || 0;
      var saldo = +(cxc[0] && cxc[0].saldo) || 0;
      var vencido = +(cxc[0] && cxc[0].vencido) || 0;
      var pctVenc = pct(vencido, saldo);

      var ventasBruto = +(margen[0] && margen[0].ventas) || 0;
      var costoTotal = +(margen[0] && margen[0].costo) || 0;
      var utilidadBruta = ventasBruto - costoTotal;
      var margenPct = pct(utilidadBruta, ventasBruto);

      var cobrado = +(cobros[0] && cobros[0].cobrado) || 0;

      var proyeccionMes = dia > 0 ? (vm / dia) * diasMes : 0;
      var ritmo = dia > 0 ? vm / dia : 0;

      var vendRanking = topVend.map(function (v, i) {
        return '  ' + (i + 1) + '. ' + (v.NOMBRE || 'S/N') + ': ' + fmtM(v.total);
      }).join('\n') || '  Sin datos';

      var deudRanking = topDeud.map(function (d, i) {
        return '  ' + (i + 1) + '. ' + (d.NOMBRE || 'S/N') + ': ' + fmtM(d.saldo);
      }).join('\n') || '  Sin datos';

      var variacionMom = vma > 0 ? (((vm - vma) / vma) * 100).toFixed(1) : 'N/A';

      return [
        '═══ CONTEXTO EN TIEMPO REAL ═══',
        'EMPRESA: ' + dbId,
        'FECHA: ' + today.toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        'DIA ' + dia + '/' + diasMes + ' del mes (' + pctMes + '% transcurrido)',
        '',
        '--- VENTAS ---',
        '  Hoy: ' + fmtM(vh) + ' | Ayer: ' + fmtM(va),
        '  Mes actual: ' + fmtM(vm) + ' (' + docs + ' facturas, ticket prom: ' + fmtM(ticket) + ')',
        '  Mes anterior (completo): ' + fmtM(vma),
        '  Variacion MoM: ' + variacionMom + '%',
        '  Ritmo diario: ' + fmtM(ritmo) + '/dia',
        '  Proyeccion cierre mes: ' + fmtM(proyeccionMes),
        '',
        '--- MARGEN ---',
        '  Ventas brutas mes: ' + fmtM(ventasBruto),
        '  Costo de ventas: ' + fmtM(costoTotal),
        '  Utilidad bruta: ' + fmtM(utilidadBruta) + ' (' + margenPct + '%)',
        '',
        '--- CXC (CUENTAS POR COBRAR) ---',
        '  Saldo total: ' + fmtM(saldo),
        '  Vencido: ' + fmtM(vencido) + ' (' + pctVenc + '% del saldo)',
        '  Clientes con saldo: ' + ((cxc[0] && cxc[0].num_clientes) || 0),
        '  Cobros del mes: ' + fmtM(cobrado),
        '',
        '--- TOP VENDEDORES MES ---',
        vendRanking,
        '',
        '--- TOP DEUDORES ---',
        deudRanking,
        '',
        '--- CATALOGO ---',
        '  Articulos: ' + ((inv[0] && inv[0].n) || 0) + ' | Clientes: ' + ((clientes[0] && clientes[0].n) || 0),
      ].join('\n');
    } catch (e) { return 'Error contexto: ' + e.message; }
  }

  // ── System prompt elite ──────────────────────────────────────────────────
  function buildSystemPrompt(ctx) {
    return [
      'Eres **Sumi**, asistente ejecutivo de elite del **Grupo Suminregio** — empresa mexicana distribuidora de suministros industriales (MRO), con sede en Monterrey, N.L.',
      '',
      '==== REGLAS CRITICAS ====',
      '1. IDIOMA: Siempre en espanol, tono ejecutivo-profesional pero accesible.',
      '2. DATOS: Usa las cifras del contexto EXACTAMENTE. NUNCA inventes numeros. Si no tienes el dato, di "no tengo ese dato en el contexto actual".',
      '3. FORMATO MONEDA: formato mexicano (ej: $1,234,567). Para millones usa $X.XXM, para miles $X.XK.',
      '4. SEMAFOROS: Incluye indicadores de estado: 🟢 (bien) 🟡 (atencion) 🔴 (critico) cuando reportes metricas.',
      '5. FORMATO ANALISIS: **Resumen ejecutivo** (2-4 bullets) → **Metricas** (tabla markdown) → **Interpretacion** (causas + riesgo) → **Acciones** (3-5 concretas, priorizadas).',
      '6. BREVEDAD: Para preguntas simples responde en 3-8 lineas. Reportes completos solo si los piden.',
      '7. PROACTIVIDAD: Si detectas algo preocupante en los datos (vencido > 30%, cumplimiento < 80%, margen < 25%), senalalo con ⚠️ aunque no pregunten.',
      '8. CALCULOS: Puedes y DEBES hacer calculos: proyecciones lineales, % de cumplimiento vs dias transcurridos del mes, promedios, variaciones MoM/YoY, DSO estimado.',
      '9. RITMO DE VENTA: Cuando pregunten sobre cumplimiento, SIEMPRE calcula: (venta_actual / dias_transcurridos) * dias_totales_mes = proyeccion de cierre.',
      '10. CONTEXTO TEMPORAL: Analiza si el ritmo de venta es suficiente considerando los dias habiles restantes.',
      '11. Si preguntan algo fuera de tu dominio, responde brevemente y redirige al negocio.',
      '12. NAVEGACION: Si preguntan como ver algo, indica el dashboard correspondiente.',
      '13. USA MARKDOWN: Responde con **negritas**, *italicas*, tablas markdown, listas con viñetas y bloques de codigo cuando mejore la legibilidad.',
      '',
      '==== AREAS QUE DOMINAS ====',
      '• Ventas: VE (industrial) / PV (mostrador), remisiones, cotizaciones, cumplimiento vs meta, ticket promedio, comparativos MoM/YoY',
      '• CXC: aging buckets (0-30, 31-60, 61-90, +90d), DSO, cartera vencida %, cobranza efectiva, plan de cobro',
      '• Inventario: quiebres, ABC, rotacion, dias de cobertura, punto de reorden, fill rate',
      '• Finanzas (P&L): margen bruto, costo de ventas, utilidad operativa, ratio gasto/venta, tendencia',
      '• Vendedores: ranking, cumplimiento, desempeno, scorecard',
      '• Clientes: concentracion (Pareto/HHI), inactivos, cross-sell, churn, LTV estimado',
      '• Estadistica: correlacion, CV, forecast regresion lineal, estacionalidad',
      '',
      '==== UMBRALES DE NEGOCIO (SEMAFOROS) ====',
      '| Indicador | 🟢 Verde | 🟡 Ambar | 🔴 Rojo |',
      '|---|---|---|---|',
      '| Cumplimiento meta | >= 90% del ritmo | 70-89% | < 70% |',
      '| CXC vencido / total | < 20% | 20-35% | > 35% |',
      '| Margen bruto | >= 28% | 22-27% | < 22% |',
      '| DSO (dias) | <= 30 | 31-45 | > 45 |',
      '| Vendedores sin venta | 0 | 1 | >= 2 |',
      '| Articulos en quiebre | < 5% catalogo | 5-10% | > 10% |',
      '',
      ctx,
    ].join('\n');
  }

  // ── API call con model fallback ──────────────────────────────────────────
  async function callAnthropic(system, messages, stream) {
    var lastErr = null;
    for (var i = 0; i < MODEL_CANDIDATES.length; i++) {
      try {
        var model = MODEL_CANDIDATES[i];
        if (stream) {
          return { stream: client.messages.stream({ model: model, max_tokens: 4096, system: system, messages: messages }), model: model };
        }
        var response = await client.messages.create({ model: model, max_tokens: 4096, system: system, messages: messages });
        return { response: response, model: model };
      } catch (e) {
        lastErr = e;
        if (e.status === 401 || e.status === 403) throw e;
        log.warn('ai-chat-v2', 'model ' + MODEL_CANDIDATES[i] + ' failed: ' + e.message + ', trying next...');
      }
    }
    throw lastErr || new Error('All models failed');
  }

  // ── Session management helpers ───────────────────────────────────────────
  function getOrCreateSession(sessionId, dbId) {
    var sess = sessions.get(sessionId);
    if (!sess) {
      sess = { createdAt: Date.now(), lastAt: Date.now(), messages: [], dbId: dbId };
      sessions.set(sessionId, sess);
      if (sessions.size > MAX_SESSIONS) {
        var oldest = null;
        var oldestTime = Infinity;
        sessions.forEach(function (s, id) {
          if (s.lastAt < oldestTime) { oldest = id; oldestTime = s.lastAt; }
        });
        if (oldest) sessions.delete(oldest);
      }
    }
    sess.lastAt = Date.now();
    return sess;
  }

  var jsonParser = require('express').json({ limit: '200kb' });

  // ── Endpoint JSON (no streaming) ─────────────────────────────────────────
  app.post('/api/ai/chat-v2', jsonParser, async function (req, res) {
    if (!client) {
      return res.status(503).json({ error: 'AI no configurado', hint: 'Define ANTHROPIC_API_KEY en Render Env vars.' });
    }

    var body = req.body || {};
    var dbId = String(body.db || 'default');
    var sessionId = String(body.sessionId || 'anon-' + Date.now());
    var userMsg = String(body.message || '').trim();
    if (!userMsg) return res.status(400).json({ error: 'Falta body.message' });

    var sess = getOrCreateSession(sessionId, dbId);
    sess.messages.push({ role: 'user', content: userMsg });
    if (sess.messages.length > MAX_MSGS) sess.messages = sess.messages.slice(-MAX_MSGS);

    try {
      var ctx = await buildContext(dbId);
      var system = buildSystemPrompt(ctx);
      var apiMsgs = sess.messages.map(function (m) { return { role: m.role, content: m.content }; });

      var result = await callAnthropic(system, apiMsgs, false);
      var reply = (result.response.content || []).map(function (c) { return c.text || ''; }).join('\n').trim();
      sess.messages.push({ role: 'assistant', content: reply });

      res.json({ ok: true, sessionId: sessionId, reply: reply, usage: result.response.usage, model: result.model });
    } catch (e) {
      log.error('ai-chat-v2', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Endpoint SSE streaming ───────────────────────────────────────────────
  app.post('/api/ai/chat-v2/stream', jsonParser, async function (req, res) {
    if (!client) {
      return res.status(503).json({ error: 'AI no configurado', hint: 'Define ANTHROPIC_API_KEY en Render Env vars.' });
    }

    var body = req.body || {};
    var dbId = String(body.db || 'default');
    var sessionId = String(body.sessionId || 'anon-' + Date.now());
    var userMsg = String(body.message || '').trim();
    if (!userMsg) return res.status(400).json({ error: 'Falta body.message' });

    var sess = getOrCreateSession(sessionId, dbId);
    sess.messages.push({ role: 'user', content: userMsg });
    if (sess.messages.length > MAX_MSGS) sess.messages = sess.messages.slice(-MAX_MSGS);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    var fullReply = '';

    try {
      var ctx = await buildContext(dbId);
      var system = buildSystemPrompt(ctx);
      var apiMsgs = sess.messages.map(function (m) { return { role: m.role, content: m.content }; });

      var result = await callAnthropic(system, apiMsgs, true);
      var messageStream = result.stream;

      res.write('data: ' + JSON.stringify({ type: 'start', model: result.model, sessionId: sessionId }) + '\n\n');

      messageStream.on('text', function (text) {
        fullReply += text;
        res.write('data: ' + JSON.stringify({ type: 'delta', text: text }) + '\n\n');
      });

      var finalMessage = await messageStream.finalMessage();

      sess.messages.push({ role: 'assistant', content: fullReply });

      res.write('data: ' + JSON.stringify({
        type: 'done',
        usage: finalMessage.usage,
        model: result.model,
        sessionId: sessionId,
      }) + '\n\n');
      res.end();
    } catch (e) {
      log.error('ai-chat-v2-stream', e.message);
      res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n');
      res.end();
    }
  });

  // ── Sessions CRUD ────────────────────────────────────────────────────────
  app.get('/api/ai/sessions', function (_req, res) {
    var list = [];
    sessions.forEach(function (s, id) {
      list.push({
        id: id, dbId: s.dbId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastAt: new Date(s.lastAt).toISOString(),
        msgCount: s.messages.length,
      });
    });
    list.sort(function (a, b) { return new Date(b.lastAt) - new Date(a.lastAt); });
    res.json({ ok: true, sessions: list });
  });

  app.delete('/api/ai/sessions/:id', function (req, res) {
    var existed = sessions.delete(req.params.id);
    res.json({ ok: true, existed: existed });
  });

  log.info('ai-chat-v2', client ? '✅ Sumi IA con streaming + model fallback (' + MODEL_CANDIDATES[0] + ')' : '⚠️  sin API key (503)');
}

module.exports = { install };
