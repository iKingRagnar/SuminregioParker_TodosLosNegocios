/**
 * mejora-continua.js — Módulo ITIL v4 + COBIT 2019 de Mejora Continua con IA
 * Endpoints: POST /api/ai/mejora, GET /api/ai/mejoras, GET /api/ai/mejora/:id,
 *            POST /api/ai/mejora/:id/comentar, PATCH /api/ai/mejora/:id/estado
 */

'use strict';

const store = require('./sumi-db');

const TABLE_MEJORAS    = 'mejoras_continua';
const TABLE_COMENTARIOS = 'mejora_comentarios';

const SYSTEM_PROMPT = `Eres un experto en ITIL v4 y COBIT 2019 analizando incidencias en un dashboard ERP industrial (Suminregio Parker — ferretería, médicos, maderas, reciclaje, etc.).

Analiza el reporte y responde SOLO con JSON válido (sin markdown):
{
  "titulo": "título corto del problema (max 60 chars)",
  "criticidad": "P1|P2|P3|P4",
  "impacto": "ALTO|MEDIO|BAJO",
  "urgencia": "ALTA|MEDIA|BAJA",
  "nivel": "CRÍTICA|ALTA|MEDIA|BAJA",
  "sla_horas": 1,
  "cobit_dominio": "DSS02|DSS03|BAI06|APO12|APO14",
  "cobit_descripcion": "nombre del proceso COBIT",
  "area_afectada": "ventas|cxc|inventario|ia|ui|datos|conectividad|usuarios|otro",
  "diagnostico": "diagnóstico claro en 2-3 líneas",
  "causa_raiz": "causa raíz probable",
  "accion_recomendada": "pasos concretos para resolver",
  "comentario_inicial": "mensaje al usuario explicando el análisis, qué se encontró y próximos pasos — tono profesional pero directo, en español mexicano"
}

ITIL v4 Matriz Impacto x Urgencia → Prioridad:
- Alto+Alta=P1, Alto+Media=P2, Alto+Baja=P3
- Medio+Alta=P2, Medio+Media=P3, Medio+Baja=P4
- Bajo+Alta=P3, Bajo+Media=P4, Bajo+Baja=P4

P1=CRÍTICA(1h), P2=ALTA(4h), P3=MEDIA(24h), P4=BAJA(72h)

COBIT 2019:
- DSS02: Gestión de solicitudes e incidentes
- DSS03: Gestión de problemas
- BAI06: Gestión de cambios de TI
- APO12: Gestión de riesgos
- APO14: Gestión de datos`;

function install(app, { log }) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }

  const client = (Anthropic && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY))
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY })
    : null;

  if (!client) {
    log && log.warn && log.warn('mejora-continua', 'sin ANTHROPIC_API_KEY — análisis IA deshabilitado');
  }

  const MODEL = process.env.AI_MODEL_MEJORA || 'claude-haiku-4-5';
  const MAX_TOKENS = Math.min(4096, Math.max(512, parseInt(process.env.AI_MEJORA_MAX_TOKENS, 10) || 1024));
  const MAX_DESC_CHARS = 4000; // cota defensiva del input al modelo

  // ── Helpers ────────────────────────────────────────────────────────────────

  function slaFromCriticidad(c) {
    const map = { P1: 1, P2: 4, P3: 24, P4: 72 };
    return map[c] || 24;
  }

  function nivelFromCriticidad(c) {
    const map = { P1: 'CRÍTICA', P2: 'ALTA', P3: 'MEDIA', P4: 'BAJA' };
    return map[c] || 'MEDIA';
  }

  const CRITICIDADES = ['P1', 'P2', 'P3', 'P4'];
  const AREAS = ['ventas', 'cxc', 'inventario', 'ia', 'ui', 'datos', 'conectividad', 'usuarios', 'otro'];

  /** Extrae el primer bloque de texto de una respuesta de Claude (ignora thinking/tool). */
  function textOf(response) {
    if (!response || !Array.isArray(response.content)) return '';
    const block = response.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    return block ? block.text : '';
  }

  /** Parseo robusto: quita fences y, si falla, extrae el primer objeto {...} del texto. */
  function parseJsonLoose(raw) {
    const clean = String(raw || '').trim()
      .replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
    try { return JSON.parse(clean); } catch (_) { /* intentar extraer subcadena */ }
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) { /* noop */ }
    }
    return null;
  }

  /** Llama al modelo con 1 reintento ante errores transitorios (429/5xx/red). */
  async function createWithRetry(params) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      const status = e && (e.status || e.statusCode);
      const transient = !status || status === 429 || (status >= 500 && status < 600);
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 800));
      return await client.messages.create(params);
    }
  }

  /** Normaliza/valida el análisis del modelo a valores conocidos + campos derivados. */
  function normalizarAnalisis(parsed, descripcion) {
    const a = parsed && typeof parsed === 'object' ? parsed : {};
    const criticidad = CRITICIDADES.includes(a.criticidad) ? a.criticidad : 'P3';
    return {
      titulo: (a.titulo ? String(a.titulo) : descripcion).slice(0, 60),
      criticidad,
      impacto: ['ALTO', 'MEDIO', 'BAJO'].includes(a.impacto) ? a.impacto : 'MEDIO',
      urgencia: ['ALTA', 'MEDIA', 'BAJA'].includes(a.urgencia) ? a.urgencia : 'MEDIA',
      nivel: nivelFromCriticidad(criticidad),
      sla_horas: slaFromCriticidad(criticidad),
      cobit_dominio: a.cobit_dominio || 'DSS02',
      cobit_descripcion: a.cobit_descripcion || 'Gestión de solicitudes e incidentes',
      area_afectada: AREAS.includes(a.area_afectada) ? a.area_afectada : 'otro',
      diagnostico: a.diagnostico || '',
      causa_raiz: a.causa_raiz || '',
      accion_recomendada: a.accion_recomendada || '',
      comentario_inicial: a.comentario_inicial || 'Ticket registrado y analizado.',
    };
  }

  function defaultAnalisis(descripcion, motivo) {
    return normalizarAnalisis({
      diagnostico: motivo || 'Análisis IA no disponible.',
      causa_raiz: 'N/A',
      accion_recomendada: 'Revisar manualmente.',
      comentario_inicial: 'Tu reporte fue registrado. El análisis automático no está disponible por ahora; un responsable lo revisará.',
    }, descripcion);
  }

  // Nunca lanza: ante cualquier fallo de IA devuelve un análisis por defecto,
  // de modo que el reporte SIEMPRE se registra (no se pierde por un hipo de IA).
  async function analizarConIA(descripcion, pagina) {
    const desc = String(descripcion || '').slice(0, MAX_DESC_CHARS);
    if (!client) return defaultAnalisis(desc, 'Análisis IA no disponible — sin API key.');

    const userMsg = [
      `Página/área: ${pagina || 'no especificado'}`,
      `Descripción del problema: ${desc}`,
    ].join('\n');

    try {
      const response = await createWithRetry({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Prompt caching: el system prompt es estable → ~90% más barato y rápido.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
      });
      const parsed = parseJsonLoose(textOf(response));
      if (!parsed) return defaultAnalisis(desc, 'No se pudo interpretar el análisis automático.');
      return normalizarAnalisis(parsed, desc);
    } catch (e) {
      log && log.warn && log.warn('mejora-continua', 'IA falló: ' + e.message);
      return defaultAnalisis(desc, 'El análisis automático no respondió.');
    }
  }

  // ── POST /api/ai/mejora — crear ticket con análisis IA ────────────────────

  app.post('/api/ai/mejora', async (req, res) => {
    try {
      const { descripcion, pagina } = req.body || {};
      if (!descripcion || !String(descripcion).trim()) {
        return res.status(400).json({ error: 'descripcion requerida' });
      }

      const user = (req.session && req.session.user) || {};
      const id   = 'mc-' + Date.now();
      const now  = new Date().toISOString();

      let analisis;
      try {
        analisis = await analizarConIA(String(descripcion).trim(), String(pagina || '').trim());
      } catch (e) {
        console.error('[mejora-continua] error IA:', e.message, e.stack);
        return res.status(502).json({ error: 'Error al analizar con IA: ' + e.message });
      }

      const ticket = {
        id,
        titulo:             analisis.titulo || descripcion.slice(0, 60),
        descripcion:        String(descripcion).trim(),
        pagina:             String(pagina || '').trim(),
        usuario:            user.nombre || user.email || 'Anónimo',
        email:              user.email || '',
        fecha_reporte:      now,
        criticidad:         analisis.criticidad  || 'P3',
        nivel:              analisis.nivel        || 'MEDIA',
        sla_horas:          analisis.sla_horas    || 24,
        impacto:            analisis.impacto      || 'MEDIO',
        urgencia:           analisis.urgencia     || 'MEDIA',
        cobit_dominio:      analisis.cobit_dominio || 'DSS02',
        cobit_descripcion:  analisis.cobit_descripcion || '',
        area_afectada:      analisis.area_afectada || 'otro',
        diagnostico_ia:     analisis.diagnostico   || '',
        causa_raiz:         analisis.causa_raiz    || '',
        accion_recomendada: analisis.accion_recomendada || '',
        estado:             'NUEVO',
        fecha_resolucion:   null,
      };

      store.append(TABLE_MEJORAS, ticket);

      // Comentario inicial de IA
      const comentarioIA = {
        mejora_id: id,
        autor:     'IA Sistema',
        rol:       'IA',
        mensaje:   analisis.comentario_inicial || 'Ticket registrado y analizado.',
        fecha:     now,
        tipo:      'DIAGNOSTICO',
      };
      store.append(TABLE_COMENTARIOS, comentarioIA);

      log && log.info && log.info('mejora-continua', `Ticket ${id} creado — ${ticket.criticidad} — ${ticket.cobit_dominio}`);

      res.json({ ok: true, ticket, comentario: comentarioIA });
    } catch (e) {
      console.error('[mejora-continua] POST /api/ai/mejora:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/ai/mejoras — listar tickets ──────────────────────────────────

  app.get('/api/ai/mejoras', (req, res) => {
    try {
      let tickets = store.readAll(TABLE_MEJORAS) || [];
      const { estado, criticidad } = req.query;

      if (estado)     tickets = tickets.filter(t => t.estado === estado);
      if (criticidad) tickets = tickets.filter(t => t.criticidad === criticidad);

      // Ordenar por fecha desc
      tickets = tickets.slice().sort((a, b) => {
        return new Date(b.fecha_reporte || 0) - new Date(a.fecha_reporte || 0);
      });

      res.json({ ok: true, total: tickets.length, tickets });
    } catch (e) {
      console.error('[mejora-continua] GET /api/ai/mejoras:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/ai/mejora/:id — ticket individual con hilo ───────────────────

  app.get('/api/ai/mejora/:id', (req, res) => {
    try {
      const tickets = store.readAll(TABLE_MEJORAS) || [];
      const ticket  = tickets.find(t => t.id === req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

      const todos     = store.readAll(TABLE_COMENTARIOS) || [];
      const comentarios = todos
        .filter(c => c.mejora_id === req.params.id)
        .sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0));

      res.json({ ok: true, ticket, comentarios });
    } catch (e) {
      console.error('[mejora-continua] GET /api/ai/mejora/:id:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/ai/mejora/:id/comentar — añadir comentario humano ───────────

  app.post('/api/ai/mejora/:id/comentar', (req, res) => {
    try {
      const tickets = store.readAll(TABLE_MEJORAS) || [];
      const ticket  = tickets.find(t => t.id === req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

      const { mensaje, tipo } = req.body || {};
      if (!mensaje || !String(mensaje).trim()) {
        return res.status(400).json({ error: 'mensaje requerido' });
      }

      const user = (req.session && req.session.user) || {};
      const comentario = {
        mejora_id: req.params.id,
        autor:     user.email || 'Anónimo',
        rol:       (user.roles && user.roles.includes('admin')) ? 'ADMIN' : 'USUARIO',
        mensaje:   String(mensaje).trim(),
        fecha:     new Date().toISOString(),
        tipo:      tipo || 'COMENTARIO',
      };

      store.append(TABLE_COMENTARIOS, comentario);
      res.json({ ok: true, comentario });
    } catch (e) {
      console.error('[mejora-continua] POST comentar:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/ai/mejora/:id/estado — actualizar estado ──────────────────

  app.patch('/api/ai/mejora/:id/estado', (req, res) => {
    try {
      const tickets = store.readAll(TABLE_MEJORAS) || [];
      const ticket  = tickets.find(t => t.id === req.params.id);
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });

      const ESTADOS = ['NUEVO', 'EN_REVISION', 'RESUELTO', 'CERRADO'];
      const { estado } = req.body || {};
      if (!estado || !ESTADOS.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS.join(', ')}` });
      }

      const updates = { estado };
      if (estado === 'RESUELTO' || estado === 'CERRADO') {
        updates.fecha_resolucion = new Date().toISOString();
      }

      store.update(TABLE_MEJORAS, ticket.id, updates);

      // Agregar comentario de cambio de estado
      const user = (req.session && req.session.user) || {};
      store.append(TABLE_COMENTARIOS, {
        mejora_id: req.params.id,
        autor:     user.email || 'Sistema',
        rol:       'ADMIN',
        mensaje:   `Estado actualizado a: ${estado}`,
        fecha:     new Date().toISOString(),
        tipo:      estado === 'RESUELTO' ? 'RESOLUCION' : 'ACTUALIZACION',
      });

      res.json({ ok: true, id: req.params.id, estado });
    } catch (e) {
      console.error('[mejora-continua] PATCH estado:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/ai/mejoras/stats — métricas para KPI cards ──────────────────

  app.get('/api/ai/mejoras/stats', (req, res) => {
    try {
      const tickets = store.readAll(TABLE_MEJORAS) || [];
      const comentarios = store.readAll(TABLE_COMENTARIOS) || [];

      const now = Date.now();
      const msDay = 86400000;
      const ms7d  = 7 * msDay;
      const ms30d = 30 * msDay;

      const abiertos   = tickets.filter(t => t.estado !== 'RESUELTO' && t.estado !== 'CERRADO');
      const resueltos  = tickets.filter(t => t.estado === 'RESUELTO' || t.estado === 'CERRADO');
      const criticos   = abiertos.filter(t => t.criticidad === 'P1' || t.criticidad === 'P2');
      const ultimos7d  = tickets.filter(t => (now - new Date(t.fecha_reporte || 0).getTime()) < ms7d);
      const ultimos30d = tickets.filter(t => (now - new Date(t.fecha_reporte || 0).getTime()) < ms30d);

      // TTR promedio (time-to-resolve) en horas
      let ttrTotal = 0, ttrCount = 0;
      resueltos.forEach(t => {
        if (t.fecha_resolucion && t.fecha_reporte) {
          const ms = new Date(t.fecha_resolucion).getTime() - new Date(t.fecha_reporte).getTime();
          if (ms > 0) { ttrTotal += ms; ttrCount++; }
        }
      });
      const ttr_horas_prom = ttrCount > 0 ? Math.round(ttrTotal / ttrCount / 3600000 * 10) / 10 : null;

      // SLA cumplimiento: tickets resueltos dentro de su sla_horas
      let slaOk = 0;
      resueltos.forEach(t => {
        if (t.fecha_resolucion && t.fecha_reporte && t.sla_horas) {
          const ms = new Date(t.fecha_resolucion).getTime() - new Date(t.fecha_reporte).getTime();
          if (ms / 3600000 <= t.sla_horas) slaOk++;
        }
      });
      const sla_cumplimiento_pct = resueltos.length > 0 ? Math.round(slaOk / resueltos.length * 100) : null;

      // Por área
      const por_area = {};
      abiertos.forEach(t => {
        const a = t.area_afectada || 'otro';
        por_area[a] = (por_area[a] || 0) + 1;
      });

      // Por COBIT
      const por_cobit = {};
      tickets.forEach(t => {
        const d = t.cobit_dominio || 'DSS02';
        por_cobit[d] = (por_cobit[d] || 0) + 1;
      });

      res.json({
        ok: true,
        total:          tickets.length,
        abiertos:       abiertos.length,
        criticos:       criticos.length,
        resueltos:      resueltos.length,
        ultimos_7d:     ultimos7d.length,
        ultimos_30d:    ultimos30d.length,
        ttr_horas_prom,
        sla_cumplimiento_pct,
        por_area,
        por_cobit,
      });
    } catch (e) {
      console.error('[mejora-continua] GET stats:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/ai/mejoras/auto-scan — detección proactiva de problemas ─────
  // Llama a endpoints críticos y crea tickets si detecta anomalías.

  app.post('/api/ai/mejoras/auto-scan', async (req, res) => {
    if (!client) return res.status(503).json({ error: 'IA no disponible' });

    try {
      const http = require('http');
      const PORT_SCAN = process.env.PORT || 7000;
      const created = [];

      function fetchLocal(path) {
        return new Promise((resolve) => {
          const opts = { method: 'GET', hostname: '127.0.0.1', port: PORT_SCAN, path, timeout: 10000 };
          const r = http.request(opts, (resp) => {
            let buf = '';
            resp.on('data', c => buf += c);
            resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(buf) }); } catch (_) { resolve({ status: resp.statusCode, body: null }); } });
          });
          r.on('error', e => resolve({ status: 0, error: e.message }));
          r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
          r.end();
        });
      }

      async function checkAndTicket(desc, pagina) {
        // Evitar duplicados: no crear si hay un ticket abierto con descripción similar
        const existing = store.readAll(TABLE_MEJORAS) || [];
        const dupe = existing.find(t =>
          t.estado !== 'RESUELTO' && t.estado !== 'CERRADO' &&
          t.descripcion && t.descripcion.slice(0, 50) === desc.slice(0, 50)
        );
        if (dupe) return null;

        let analisis;
        try { analisis = await analizarConIA(desc, pagina); } catch (_) { analisis = null; }

        const id  = 'mc-auto-' + Date.now();
        const now = new Date().toISOString();
        const ticket = {
          id,
          titulo:             (analisis && analisis.titulo) || desc.slice(0, 60),
          descripcion:        desc,
          pagina:             pagina || 'auto-scan',
          usuario:            'Auto-Scan IA',
          email:              'sistema@suminregio.com',
          fecha_reporte:      now,
          criticidad:         (analisis && analisis.criticidad)  || 'P3',
          nivel:              (analisis && analisis.nivel)        || 'MEDIA',
          sla_horas:          (analisis && analisis.sla_horas)    || 24,
          impacto:            (analisis && analisis.impacto)      || 'MEDIO',
          urgencia:           (analisis && analisis.urgencia)     || 'MEDIA',
          cobit_dominio:      (analisis && analisis.cobit_dominio) || 'DSS02',
          cobit_descripcion:  (analisis && analisis.cobit_descripcion) || '',
          area_afectada:      (analisis && analisis.area_afectada) || 'otro',
          diagnostico_ia:     (analisis && analisis.diagnostico)  || '',
          causa_raiz:         (analisis && analisis.causa_raiz)   || '',
          accion_recomendada: (analisis && analisis.accion_recomendada) || '',
          estado:             'NUEVO',
          fecha_resolucion:   null,
        };
        store.append(TABLE_MEJORAS, ticket);

        const comentarioIA = {
          mejora_id: id,
          autor:     'IA Sistema',
          rol:       'IA',
          mensaje:   (analisis && analisis.comentario_inicial) || '🔍 Problema detectado por auto-scan.',
          fecha:     now,
          tipo:      'DIAGNOSTICO',
        };
        store.append(TABLE_COMENTARIOS, comentarioIA);
        created.push(ticket);
        log && log.warn && log.warn('auto-scan', `Ticket auto creado: ${ticket.criticidad} — ${ticket.titulo}`);
        return ticket;
      }

      // ─── Checks ───────────────────────────────────────────────────────────

      // 1. CxC: hay saldos vencidos >90 días?
      const cxc = await fetchLocal('/api/cxc/resumen-aging?db=default');
      if (cxc.body && cxc.body.aging) {
        const v90 = cxc.body.aging['91-120'] || cxc.body.aging['90+'] || 0;
        const v120 = cxc.body.aging['121+'] || 0;
        if (v90 + v120 > 50000) {
          await checkAndTicket(
            `CxC: hay $${(v90 + v120).toLocaleString('es-MX')} MXN vencidos a más de 90 días sin resolver. Esto indica un riesgo de cartera alta.`,
            'Dashboard_CC'
          );
        }
      }

      // 2. Inventario: muchos artículos bajo mínimo
      const invMin = await fetchLocal('/api/inv/bajo-minimo?db=default&limit=5');
      if (invMin.body && Array.isArray(invMin.body.items) && invMin.body.items.length >= 5) {
        await checkAndTicket(
          `Inventario: se detectaron ${invMin.body.total || invMin.body.items.length} artículos por debajo del mínimo de reorden. Riesgo de quiebre de stock.`,
          'Dashboard_Inventario'
        );
      }

      // 3. Ventas: ¿estamos por debajo del 60% de meta a mitad de mes?
      const ventas = await fetchLocal('/api/ventas/cumplimiento?db=default');
      if (ventas.body && ventas.body.pct_cumplimiento !== undefined) {
        const diaActual = new Date().getDate();
        const diasMes   = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
        const avanceTiempo = diaActual / diasMes;
        const pctVentas = ventas.body.pct_cumplimiento;
        // Si llevamos más de 40% del mes pero menos del 50% de la meta
        if (avanceTiempo > 0.4 && pctVentas < 50) {
          await checkAndTicket(
            `Ventas: cumplimiento de meta al ${Math.round(pctVentas)}% cuando el mes lleva ${Math.round(avanceTiempo * 100)}% avanzado. Tendencia de cierre negativa.`,
            'Dashboard_Ventas'
          );
        }
      }

      res.json({ ok: true, tickets_creados: created.length, tickets: created });
    } catch (e) {
      console.error('[mejora-continua] auto-scan:', e.message, e.stack);
      res.status(500).json({ error: e.message });
    }
  });

  log && log.info && log.info('mejora-continua', 'módulo instalado — ITIL v4 + COBIT 2019');
}

module.exports = { install };
