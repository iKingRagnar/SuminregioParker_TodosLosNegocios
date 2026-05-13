'use strict';

/**
 * lib/scheduler.js — Scheduler central de crons in-process.
 *
 * Antes: 4 módulos (email-reports, compras-semanal, churn-detector, alerts)
 * cada uno hacía `setInterval(() => {...}, 60_000)` para chequear si era su
 * hora. Eso es 4 timers despertando cada minuto, cada uno con su lógica
 * de "lastSent" para no disparar 2× en la misma hora.
 *
 * Ahora: un solo timer. Los jobs se registran con cron-spec mínimo:
 *   schedule({
 *     name: 'email-diario',
 *     hour: 7,
 *     minute: 0,
 *     days: [1,2,3,4,5,6],  // 0=domingo
 *     run: async () => { ... },
 *   });
 *
 * Garantías:
 *  - Un job no corre dos veces en el mismo (día, hora) gracias a `lastRunKey`.
 *  - Si el server se reinicia, el lastRunKey se pierde — pero como sólo
 *    permitimos correr durante una ventana de 5 min al inicio de la hora,
 *    el peor caso es que un cron se salte.
 *  - Errores del job se loguean pero no tumban al scheduler.
 */

const _jobs = [];
let _interval = null;
let _logger = console;

function _todayMx() {
  return new Date().toISOString().slice(0, 10);
}

function _tick() {
  const now = new Date();
  const today = _todayMx();
  const dow = now.getDay();
  const hh = now.getHours();
  const mm = now.getMinutes();

  for (const job of _jobs) {
    if (mm >= 5) continue; // sólo primeros 5 minutos de la hora
    if (job.hour !== hh) continue;
    if (job.minute != null && job.minute !== mm) continue;
    if (Array.isArray(job.days) && !job.days.includes(dow)) continue;
    const key = `${today}-${hh}`;
    if (job._lastRunKey === key) continue;
    job._lastRunKey = key;
    Promise.resolve(job.run()).catch((e) => {
      _logger.warn && _logger.warn(`[scheduler] ${job.name} falló:`, e && e.message);
    });
  }
}

/**
 * Registra un job y arranca el scheduler si aún no está corriendo.
 * @param {object} job
 * @param {string} job.name
 * @param {number} job.hour  — hora 0-23 (local time del proceso)
 * @param {number} [job.minute]  — minuto dentro de la hora (default: cualquiera dentro de los primeros 5)
 * @param {number[]} [job.days] — días de la semana (0-6). default: todos los días.
 * @param {Function} job.run — async función a ejecutar
 */
function schedule(job) {
  if (!job || typeof job.run !== 'function') throw new Error('scheduler: job.run requerido');
  if (typeof job.hour !== 'number') throw new Error('scheduler: job.hour requerido');
  _jobs.push({ ...job, _lastRunKey: null });
  if (!_interval) {
    _interval = setInterval(_tick, 60_000);
    // No referenciamos el timer para no bloquear process.exit en tests
    if (_interval.unref) _interval.unref();
    _logger.info && _logger.info(`[scheduler] activo (chequeo cada 60s)`);
  }
  _logger.info && _logger.info(`[scheduler] registrado: ${job.name} → ${String(job.hour).padStart(2, '0')}:00${job.days ? ' días ' + job.days.join(',') : ''}`);
}

function setLogger(log) {
  if (log) _logger = log;
}

function listJobs() {
  return _jobs.map((j) => ({ name: j.name, hour: j.hour, days: j.days, lastRunKey: j._lastRunKey }));
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _jobs.length = 0;
}

module.exports = { schedule, setLogger, listJobs, stop };
