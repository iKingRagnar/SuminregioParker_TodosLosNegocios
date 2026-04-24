'use strict';

/**
 * api-client.js — Wrapper para el API externo de Suminregio.
 *
 * Reemplaza las conexiones directas a Firebird y el daily-cache local.
 * Todo el tráfico pasa por https://api.suminregio.com/api/external/ usando el
 * header X-API-Key. El API maneja su propia cache (DuckDB refrescado 2 AM MX)
 * y la autenticación por API key se verifica al lado del servidor.
 *
 * Exporta:
 *   runQuery(unidad, queryId, params?)  → Promise<rows[]>
 *   listQueries()                       → Promise<{id, engine, description}[]>
 *   health()                            → Promise<{ok, owner, unidades_disponibles}>
 *   UNIDADES_VALIDAS                    → Set<string>
 *
 * Seguridad:
 *   - La API key se lee SOLO desde env var SUMINREGIO_API_KEY.
 *   - Nunca se imprime, nunca se loguea el header.
 *   - Los errores 401/403 se reportan al caller pero sin mostrar la key.
 */

const DEFAULT_BASE = 'https://api.suminregio.com/api/external';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
// 429 específico: backoff largo (upstream tiene burst limit por minuto)
const RATE_LIMIT_BACKOFF_MS = [8_000, 20_000, 45_000];

const BASE_URL = (process.env.SUMINREGIO_API_URL || DEFAULT_BASE).replace(/\/$/, '');
const API_KEY = process.env.SUMINREGIO_API_KEY || '';
const REQUEST_TIMEOUT_MS = Number(process.env.SUMINREGIO_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
const MAX_RETRIES = Number.isFinite(Number(process.env.SUMINREGIO_API_RETRIES))
  ? Number(process.env.SUMINREGIO_API_RETRIES)
  : DEFAULT_RETRIES;

const UNIDADES_VALIDAS = new Set([
  'parker', 'medico', 'maderas', 'empaque', 'agua', 'reciclaje', 'grupo',
]);

function assertKeyPresent() {
  if (!API_KEY || !API_KEY.startsWith('sk_ext_')) {
    const err = new Error(
      'SUMINREGIO_API_KEY no configurada (esperada sk_ext_...). ' +
      'Defínela como variable de entorno antes de arrancar el server.'
    );
    err.code = 'MISSING_API_KEY';
    throw err;
  }
}

async function _fetchJson(path, { method = 'GET', body = null } = {}) {
  assertKeyPresent();
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'X-API-Key': API_KEY,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'suminregio-dashboard/2.0',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(to);

      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* text no-json */ }

      if (!res.ok) {
        const err = new Error(
          (data && (data.detail || data.error)) ||
          `HTTP ${res.status} en ${path}`
        );
        err.status = res.status;
        err.detail = data;
        // 429: respetar Retry-After si viene, sino usar backoff largo
        if (res.status === 429) {
          const ra = Number(res.headers.get('retry-after'));
          err._retryAfterMs = (Number.isFinite(ra) && ra > 0)
            ? ra * 1000
            : (RATE_LIMIT_BACKOFF_MS[attempt] || RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1]);
        } else if (res.status >= 400 && res.status < 500) {
          // No reintentar 4xx distintos de 429
          throw err;
        }
        lastErr = err;
      } else {
        return data;
      }
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    }
    // Backoff: 429 usa su propio backoff largo; resto usa el corto
    if (attempt < MAX_RETRIES) {
      const delay = lastErr && lastErr._retryAfterMs
        ? lastErr._retryAfterMs
        : DEFAULT_RETRY_DELAY_MS * (attempt + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error(`Falló request a ${path} tras ${MAX_RETRIES + 1} intentos`);
}

/**
 * Ejecuta una query del catálogo externo.
 * @param {string} unidad       parker|medico|maderas|empaque|agua|reciclaje|grupo
 * @param {string} queryId      p.ej. "ventas_resumen_mes"
 * @param {object} [params]     params del catálogo (anio, mes, limite, etc.)
 * @returns {Promise<Array>}    rows tal cual las entrega el API
 */
async function runQuery(unidad, queryId, params = {}) {
  if (!unidad || !UNIDADES_VALIDAS.has(unidad)) {
    throw new Error(`unidad inválida: "${unidad}". Válidas: ${[...UNIDADES_VALIDAS].join(', ')}`);
  }
  if (!queryId) throw new Error('queryId requerido');
  const payload = { unidad, query_id: queryId, params: params || {} };
  const data = await _fetchJson('/query', { method: 'POST', body: payload });
  if (!data || data.ok !== true) {
    const err = new Error((data && data.detail) || 'Respuesta inesperada del API');
    err.detail = data;
    throw err;
  }
  return Array.isArray(data.rows) ? data.rows : [];
}

async function runQueryFull(unidad, queryId, params = {}) {
  if (!unidad || !UNIDADES_VALIDAS.has(unidad)) {
    throw new Error(`unidad inválida: "${unidad}"`);
  }
  if (!queryId) throw new Error('queryId requerido');
  return _fetchJson('/query', {
    method: 'POST',
    body: { unidad, query_id: queryId, params: params || {} },
  });
}

async function listQueries() {
  const data = await _fetchJson('/queries');
  return (data && data.queries) || [];
}

async function health() {
  return _fetchJson('/health');
}

function hasKey() {
  return !!(API_KEY && API_KEY.startsWith('sk_ext_'));
}

module.exports = {
  runQuery,
  runQueryFull,
  listQueries,
  health,
  hasKey,
  UNIDADES_VALIDAS,
  BASE_URL,
};
