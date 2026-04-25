'use strict';

/**
 * Daily cache layer — reemplazo de DuckDB snapshots.
 *
 * Regla: el dashboard consulta Firebird SOLO UNA VEZ al día, a las 23:00 hora
 * de México (UTC-6). El resto del día sirve los resultados guardados.
 *
 *  • Lectura: si el cache tiene timestamp >= la última 23:00 México, se sirve.
 *    Si no, se golpea Firebird, se guarda y se sirve.
 *  • Refresh automático a las 23:00 México: re-ejecuta todas las queries que
 *    alguna vez cachearon, y sobreescribe.
 *  • Si Firebird falla en el refresh, se mantiene el cache anterior
 *    (principio de "historia previa").
 *
 * Persistencia: disco de Render (/var/data/cache por defecto), sobrevive
 * reinicios y redeploys.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.CACHE_DIR || (
  (() => {
    try { return fs.existsSync('/var/data') ? '/var/data/cache' : '/tmp/cache'; }
    catch { return '/tmp/cache'; }
  })()
);

try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) { /* ignore */ }

const REGISTRY_FILE = path.join(CACHE_DIR, '_registry.json');

let _registry = {};
try {
  const raw = fs.readFileSync(REGISTRY_FILE, 'utf8');
  _registry = JSON.parse(raw || '{}') || {};
} catch (_) { _registry = {}; }

function saveRegistry() {
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(_registry), 'utf8'); }
  catch (_) { /* ignore */ }
}

function keyFor(dbId, sql, params) {
  const h = crypto.createHash('sha256');
  h.update(String(dbId || 'default'));
  h.update('|');
  h.update(String(sql));
  h.update('|');
  try { h.update(JSON.stringify(params || [])); } catch { h.update(''); }
  return h.digest('hex').slice(0, 40);
}

function cachePath(key) { return path.join(CACHE_DIR, key + '.json'); }

/**
 * Última 23:00 México (UTC-6, sin horario de verano) expresada en ms UTC.
 *   23:00 CDMX = 05:00 UTC del día siguiente.
 * Si `now >= hoy-05:00-UTC` → devuelve hoy-05:00-UTC (= anoche 23:00 CDMX).
 * Si no, devuelve ayer-05:00-UTC (= anteayer 23:00 CDMX).
 */
function mostRecent23MxUtcMs(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const today5UTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0);
  if (nowMs >= today5UTC) return today5UTC;
  return today5UTC - 24 * 3600 * 1000;
}

function msUntilNext23Mx(nowMs = Date.now()) {
  const last = mostRecent23MxUtcMs(nowMs);
  const next = last + 24 * 3600 * 1000;
  return Math.max(next - nowMs, 60 * 1000);
}

function readCache(key) {
  try {
    const p = cachePath(key);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function writeCache(key, rows) {
  try {
    fs.writeFileSync(cachePath(key), JSON.stringify({ ts: Date.now(), rows }), 'utf8');
  } catch (e) {
    console.warn('[daily-cache] writeCache failed:', e && e.message);
  }
}

/**
 * Envuelve la ejecución de una query. Si hay cache fresco (≥ última 23:00 Mx)
 * lo retorna. Si no, corre `runFn`, cachea el resultado y lo retorna. Si
 * `runFn` falla, intenta servir cache stale (mejor eso que 500).
 */
async function wrap(dbId, sql, params, runFn) {
  const key = keyFor(dbId, sql, params);
  const cutoff = mostRecent23MxUtcMs();
  const cached = readCache(key);
  if (cached && typeof cached.ts === 'number' && cached.ts >= cutoff) {
    return cached.rows;
  }
  if (!_registry[key]) {
    _registry[key] = { dbId, sql, params };
    saveRegistry();
  }
  try {
    const rows = await runFn();
    writeCache(key, rows);
    return rows;
  } catch (e) {
    if (cached) {
      const ageH = Math.round((Date.now() - cached.ts) / 3600000);
      console.warn(`[daily-cache] Firebird falló, sirvo cache stale (${ageH}h): ${e && e.message}`);
      return cached.rows;
    }
    throw e;
  }
}

/**
 * Programa el refresh recursivo a las 23:00 México. `refreshFn(dbId, sql, params)`
 * debe ejecutar Firebird directo y devolver filas.
 */
function scheduleDailyRefresh(refreshFn) {
  const delay = msUntilNext23Mx();
  const mins = Math.round(delay / 60000);
  const whenISO = new Date(Date.now() + delay).toISOString();
  console.log(`[daily-cache] Próximo refresh en ${mins} min (23:00 CDMX, UTC ${whenISO})`);
  setTimeout(async () => {
    console.log('[daily-cache] === Refresh diario 23:00 CDMX ===');
    const entries = Object.entries(_registry);
    let ok = 0, fail = 0;
    for (const [key, row] of entries) {
      const { dbId, sql, params } = row || {};
      try {
        const rows = await refreshFn(dbId, sql, params);
        writeCache(key, rows);
        ok++;
      } catch (e) {
        fail++;
        console.warn(`[daily-cache] refresh falló ${key.slice(0, 8)}: ${e && e.message}`);
      }
    }
    console.log(`[daily-cache] Refresh diario OK: ${ok} queries / ${fail} fallos (cache previo preservado en los fallos).`);
    scheduleDailyRefresh(refreshFn);
  }, delay);
}

function stats() {
  let files = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      files++;
      try { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {}
    }
  } catch {}
  const delay = msUntilNext23Mx();
  return {
    dir: CACHE_DIR,
    files,
    bytes,
    registeredQueries: Object.keys(_registry).length,
    nextRefreshInMs: delay,
    nextRefreshAt: new Date(Date.now() + delay).toISOString(),
    policy: 'Firebird se consulta UNA vez al día a las 23:00 México. Resto del día: cache.',
  };
}

module.exports = { wrap, scheduleDailyRefresh, stats, CACHE_DIR };
