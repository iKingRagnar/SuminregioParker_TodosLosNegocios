'use strict';

/**
 * auto-mejora.js — Motor de Mejora Continua de lazo cerrado (ITIL 4 CSI).
 *
 * Barre TODOS los negocios, lee el cumplimiento de metas, detecta brechas
 * (Real < Meta), las prioriza ITIL (P1-P4 por tamaño de brecha), genera una
 * recomendación (regla COBIT, o IA en el resumen) y crea/actualiza tickets en
 * el CI Register (mismo store que Mejora Continua → aparecen en /mejoras).
 * Registra snapshots para tendencia y agenda un barrido diario.
 *
 * Endpoints:
 *   POST /api/auto-mejora/run         → ejecuta el barrido ahora
 *   GET  /api/auto-mejora/resumen     → resumen ejecutivo (brechas + tendencia + acciones)
 *   GET  /api/auto-mejora/tendencia   → tendencia por KPI desde el historial
 */

const http = require('http');
const store = require('./sumi-db');
const core = require('./lib/auto-mejora-core');

const TABLE_MEJORAS = 'mejoras_continua';
const TABLE_COMENTARIOS = 'mejora_comentarios';
const TABLE_HIST = 'metas_historial';

function install(app, { log } = {}) {
  const PORT = process.env.PORT || 7000;

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }
  const aiClient = (Anthropic && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY))
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY })
    : null;
  const AI_MODEL = process.env.AI_MODEL_RESUMEN || 'claude-haiku-4-5';

  function fetchLocal(path) {
    return new Promise((resolve) => {
      const req = http.request({ method: 'GET', hostname: '127.0.0.1', port: PORT, path, timeout: 30000 }, (resp) => {
        let buf = '';
        resp.on('data', (c) => { buf += c; });
        resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  async function getNegocios() {
    const data = await fetchLocal('/api/universe/databases');
    if (Array.isArray(data) && data.length) return data.map((d) => ({ id: d.id, label: d.label || d.id }));
    return [{ id: 'default', label: 'Suminregio Parker' }];
  }

  function nombreNegocio(neg) { return neg.label || neg.id; }

  // ── Upsert de ticket de brecha (dedup por id estable) ──────────────────────
  function upsertTicketBrecha(neg, brecha) {
    const id = `auto-meta-${neg.id}-${brecha.key}`;
    const tickets = store.readAll(TABLE_MEJORAS) || [];
    const existing = tickets.find((t) => t.id === id);
    const now = new Date().toISOString();
    const pctTxt = brecha.pct != null ? Math.round(brecha.pct) + '%' : '—';
    const desc = `[${nombreNegocio(neg)}] ${brecha.label}: cumplimiento ${pctTxt} de la meta. `
      + `Actual ${fmtKpi(brecha)} vs meta ${fmtMeta(brecha)}. Brecha detectada automáticamente por el motor de mejora continua.`;

    const campos = {
      titulo: `${brecha.label} bajo meta — ${nombreNegocio(neg)}`,
      descripcion: desc,
      pagina: 'auto-mejora',
      criticidad: brecha.criticidad,
      nivel: brecha.nivel,
      sla_horas: brecha.sla_horas,
      impacto: brecha.criticidad === 'P1' || brecha.criticidad === 'P2' ? 'ALTO' : 'MEDIO',
      urgencia: brecha.criticidad === 'P1' ? 'ALTA' : brecha.criticidad === 'P2' ? 'MEDIA' : 'BAJA',
      cobit_dominio: brecha.cobit,
      cobit_descripcion: 'Mejora continua dirigida por metas',
      area_afectada: brecha.area,
      diagnostico_ia: `KPI "${brecha.label}" por debajo de su meta en ${nombreNegocio(neg)} (cumplimiento ${pctTxt}).`,
      causa_raiz: 'Brecha entre el resultado real y el objetivo definido.',
      accion_recomendada: brecha.recomendacion,
      meta_key: brecha.key,
      negocio: neg.id,
      real: brecha.real,
      meta: brecha.meta,
      pct: brecha.pct,
    };

    if (existing) {
      // Solo refresca si sigue ABIERTO (respeta cierres humanos).
      if (existing.estado !== 'RESUELTO' && existing.estado !== 'CERRADO') {
        store.update(TABLE_MEJORAS, id, campos);
        return { id, accion: 'actualizado' };
      }
      return { id, accion: 'cerrado-omitido' };
    }
    store.append(TABLE_MEJORAS, Object.assign({ id, usuario: 'Auto-Mejora IA', email: 'sistema@suminregio.com', fecha_reporte: now, estado: 'NUEVO', fecha_resolucion: null }, campos));
    store.append(TABLE_COMENTARIOS, {
      mejora_id: id, autor: 'Auto-Mejora IA', rol: 'IA', fecha: now, tipo: 'DIAGNOSTICO',
      mensaje: `🎯 Brecha detectada: ${brecha.label} en ${nombreNegocio(neg)} con ${pctTxt} de cumplimiento. Acción sugerida (COBIT ${brecha.cobit}): ${brecha.recomendacion}`,
    });
    return { id, accion: 'creado' };
  }

  function fmtKpi(b) {
    if (b.dir === '≤' && /PCT|RATE/i.test(b.key)) return (Math.round(b.real * 1000) / 10) + '%';
    if (/PCT|RATE/i.test(b.key)) return (Math.round(b.real * 1000) / 10) + '%';
    if (/DIAS/.test(b.key)) return Math.round(b.real) + ' días';
    return String(Math.round(b.real * 100) / 100);
  }
  function fmtMeta(b) {
    if (/PCT|RATE/i.test(b.key)) return (Math.round(b.meta * 1000) / 10) + '%';
    if (/DIAS/.test(b.key)) return Math.round(b.meta) + ' días';
    return String(Math.round(b.meta * 100) / 100);
  }

  // ── Barrido principal ──────────────────────────────────────────────────────
  async function runSweep() {
    const negocios = await getNegocios();
    const now = new Date().toISOString();
    let brechasTotal = 0, creados = 0, actualizados = 0, snapshots = 0;
    const porNegocio = [];

    for (const neg of negocios) {
      const cumpl = await fetchLocal(`/api/metas/cumplimiento?db=${encodeURIComponent(neg.id)}`);
      if (!cumpl || !Array.isArray(cumpl.items)) { porNegocio.push({ negocio: neg.id, error: true }); continue; }

      // Snapshot histórico de los KPIs medibles con dato (para tendencia).
      cumpl.items.forEach((it) => {
        if (it.medible && it.real != null) {
          store.append(TABLE_HIST, { db: neg.id, key: it.key, real: it.real, meta: it.meta, pct: it.pct, alcanzada: !!it.alcanzada, fecha: now });
          snapshots++;
        }
      });

      const brechas = core.detectarBrechas(cumpl.items);
      brechasTotal += brechas.length;
      for (const b of brechas) {
        const r = upsertTicketBrecha(neg, b);
        if (r.accion === 'creado') creados++;
        else if (r.accion === 'actualizado') actualizados++;
      }
      porNegocio.push({ negocio: neg.id, label: neg.label, brechas: brechas.length, top: brechas.slice(0, 3).map((b) => ({ kpi: b.label, criticidad: b.criticidad, pct: b.pct })) });
    }

    log && log.info && log.info('auto-mejora', `barrido: ${negocios.length} negocios · ${brechasTotal} brechas · ${creados} tickets nuevos · ${actualizados} actualizados`);
    return { ok: true, negocios: negocios.length, brechas: brechasTotal, tickets_creados: creados, tickets_actualizados: actualizados, snapshots, por_negocio: porNegocio, generadoEn: now };
  }

  // ── Tendencia por KPI desde el historial ───────────────────────────────────
  function calcularTendencias(db) {
    const hist = (store.readAll(TABLE_HIST) || []).filter((h) => !db || h.db === db);
    const grupos = {};
    hist.forEach((h) => {
      const k = h.db + '|' + h.key;
      (grupos[k] = grupos[k] || []).push(h);
    });
    const out = [];
    Object.keys(grupos).forEach((k) => {
      const serie = grupos[k].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      const pcts = serie.map((s) => s.pct).filter((p) => p != null);
      const last = serie[serie.length - 1];
      out.push({
        db: last.db, key: last.key, pct: last.pct, real: last.real, meta: last.meta,
        alcanzada: last.alcanzada, muestras: serie.length, tendencia: core.tendencia(pcts),
      });
    });
    return out;
  }

  // ── Resumen ejecutivo (IA opcional) ────────────────────────────────────────
  async function resumenEjecutivo() {
    const negocios = await getNegocios();
    const bloques = [];
    for (const neg of negocios) {
      const cumpl = await fetchLocal(`/api/metas/cumplimiento?db=${encodeURIComponent(neg.id)}`);
      if (!cumpl || !Array.isArray(cumpl.items)) continue;
      const brechas = core.detectarBrechas(cumpl.items);
      const medibles = cumpl.items.filter((i) => i.medible && i.real != null);
      bloques.push({ negocio: neg.label || neg.id, medibles: medibles.length, brechas: brechas.length, top: brechas.slice(0, 5) });
    }
    const tendencias = calcularTendencias();
    const empeorando = tendencias.filter((t) => t.tendencia === 'empeora');

    let narrativa = null;
    if (aiClient && bloques.length) {
      try {
        const ctx = JSON.stringify({ negocios: bloques, empeorando: empeorando.slice(0, 8) }).slice(0, 6000);
        const resp = await aiClient.messages.create({
          model: AI_MODEL, max_tokens: 700,
          system: [{ type: 'text', text: 'Eres analista de mejora continua (ITIL 4 / COBIT) de Suminregio Parker. Redacta un resumen ejecutivo BREVE (máx 8 líneas) en español mexicano profesional: prioridades de la semana, brechas más graves por negocio, KPIs que empeoran y 2-3 acciones concretas. Sin tecnicismos internos.', cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: 'Datos de cumplimiento de metas y tendencias:\n' + ctx }],
        });
        const blk = (resp.content || []).find((b) => b.type === 'text');
        narrativa = blk ? blk.text : null;
      } catch (e) { log && log.warn && log.warn('auto-mejora', 'resumen IA falló: ' + e.message); }
    }
    return { ok: true, por_negocio: bloques, empeorando, narrativa, generadoEn: new Date().toISOString() };
  }

  // ── Endpoints ──────────────────────────────────────────────────────────────
  app.post('/api/auto-mejora/run', async (_req, res) => {
    try { res.json(await runSweep()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/auto-mejora/tendencia', (req, res) => {
    try { res.json({ ok: true, tendencias: calcularTendencias(req.query.db) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/auto-mejora/resumen', async (_req, res) => {
    try { res.json(await resumenEjecutivo()); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Agendado diario (después del refresh de datos) ─────────────────────────
  try {
    const scheduler = require('./lib/scheduler');
    const hour = Math.min(23, Math.max(0, parseInt(process.env.AUTO_MEJORA_HOUR, 10) || 6));
    scheduler.schedule({ name: 'auto-mejora-sweep', hour, run: async () => { await runSweep(); } });
  } catch (e) { log && log.warn && log.warn('auto-mejora', 'no se pudo agendar: ' + e.message); }

  log && log.info && log.info('auto-mejora', 'motor de automejora instalado (ITIL 4 CSI)');
}

module.exports = { install };
