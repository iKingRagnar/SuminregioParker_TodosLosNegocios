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

  const MODEL = 'claude-haiku-4-5';

  // ── Helpers ────────────────────────────────────────────────────────────────

  function slaFromCriticidad(c) {
    const map = { P1: 1, P2: 4, P3: 24, P4: 72 };
    return map[c] || 24;
  }

  function nivelFromCriticidad(c) {
    const map = { P1: 'CRÍTICA', P2: 'ALTA', P3: 'MEDIA', P4: 'BAJA' };
    return map[c] || 'MEDIA';
  }

  async function analizarConIA(descripcion, pagina) {
    if (!client) {
      return {
        titulo: descripcion.slice(0, 60),
        criticidad: 'P3',
        impacto: 'MEDIO',
        urgencia: 'MEDIA',
        nivel: 'MEDIA',
        sla_horas: 24,
        cobit_dominio: 'DSS02',
        cobit_descripcion: 'Gestión de solicitudes e incidentes',
        area_afectada: 'otro',
        diagnostico: 'Análisis IA no disponible — sin API key.',
        causa_raiz: 'N/A',
        accion_recomendada: 'Revisar manualmente.',
        comentario_inicial: 'Tu reporte fue registrado. El análisis IA no está disponible en este momento.',
      };
    }

    const userMsg = [
      `Página/área: ${pagina || 'no especificado'}`,
      `Descripción del problema: ${descripcion}`,
    ].join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });

    const raw = response.content[0].text.trim();
    // Strip markdown fences if Claude adds them despite instructions
    const clean = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(clean);
    // Ensure derived fields are consistent
    parsed.sla_horas = slaFromCriticidad(parsed.criticidad);
    parsed.nivel     = nivelFromCriticidad(parsed.criticidad);
    return parsed;
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

  log && log.info && log.info('mejora-continua', 'módulo instalado — ITIL v4 + COBIT 2019');
}

module.exports = { install };
