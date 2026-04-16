/**
 * data-cache.js — Sistema de caché global para dashboards Suminregio
 * ─────────────────────────────────────────────────────────────────
 * • Intercepta TODAS las peticiones GET a /api/* transparentemente
 * • Caché en memoria (Map) → inmediato al navegar entre páginas en la misma sesión
 * • Caché en localStorage → persiste entre recargas hasta 2 horas
 * • Auto-refresh cada 2 horas: invalida caché y recarga datos
 * • Límite de tamaño: máx 200KB por item, máx 4MB total en localStorage
 * • Botón "Actualizar datos" limpia caché y refresca sin full page reload
 */
(function () {
  'use strict';

  const CACHE_TTL    = 2 * 60 * 60 * 1000; // 2 horas en ms
  const MAX_ITEM_KB  = 200;                 // máx KB por item en localStorage
  const MAX_TOTAL_KB = 4096;                // máx KB total en localStorage
  const LS_PREFIX    = 'sumi_c_';
  const LS_STATS_KEY = 'sumi_cache_stats';

  // ── Caché en memoria (sesión actual) ────────────────────────────────────────
  const memCache = new Map(); // key → { data, ts, size }

  // ── Utilidades ───────────────────────────────────────────────────────────────
  function cacheKey(url) {
    // Normaliza la URL para usarla como clave
    try {
      const u = new URL(url, location.origin);
      return LS_PREFIX + u.pathname + u.search;
    } catch (_) {
      return LS_PREFIX + url;
    }
  }

  function sizeKB(str) { return Math.round(str.length / 1024); }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      // cuota excedida: evictar entradas más antiguas y reintentar
      evictOldest();
      try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
    }
  }

  function evictOldest() {
    try {
      const entries = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LS_PREFIX)) continue;
        try {
          const raw = localStorage.getItem(k);
          const { ts } = JSON.parse(raw);
          entries.push({ k, ts });
        } catch (_) { entries.push({ k, ts: 0 }); }
      }
      entries.sort((a, b) => a.ts - b.ts);
      // Eliminar el 30% más antiguo
      const toRemove = Math.max(1, Math.floor(entries.length * 0.3));
      entries.slice(0, toRemove).forEach(e => { try { localStorage.removeItem(e.k); } catch (_) {} });
    } catch (_) {}
  }

  function getTotalLSKB() {
    try {
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LS_PREFIX)) continue;
        const v = localStorage.getItem(k);
        if (v) total += v.length;
      }
      return Math.round(total / 1024);
    } catch (_) { return 0; }
  }

  // ── Leer desde caché ─────────────────────────────────────────────────────────
  function getCached(url) {
    const key = cacheKey(url);
    const now = Date.now();

    // 1. Memoria primero (más rápido)
    if (memCache.has(key)) {
      const { data, ts } = memCache.get(key);
      if (now - ts < CACHE_TTL) return data;
      memCache.delete(key);
    }

    // 2. localStorage
    const raw = lsGet(key);
    if (!raw) return null;
    try {
      const { data, ts } = JSON.parse(raw);
      if (now - ts < CACHE_TTL) {
        // Cargar también a memoria para accesos subsecuentes
        memCache.set(key, { data, ts, size: raw.length });
        return data;
      }
      // Expirado
      try { localStorage.removeItem(key); } catch (_) {}
    } catch (_) {}
    return null;
  }

  // ── Guardar en caché ─────────────────────────────────────────────────────────
  function setCached(url, data) {
    const key = cacheKey(url);
    const ts  = Date.now();
    const entry = { data, ts };

    // Siempre en memoria
    memCache.set(key, { data, ts });

    // En localStorage solo si el item no es demasiado grande
    try {
      const raw = JSON.stringify(entry);
      if (sizeKB(raw) <= MAX_ITEM_KB) {
        // Verificar cuota total antes de guardar
        if (getTotalLSKB() + sizeKB(raw) > MAX_TOTAL_KB) evictOldest();
        lsSet(key, raw);
      }
    } catch (_) {}
  }

  // ── Interceptor de fetch ─────────────────────────────────────────────────────
  const _origFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const url    = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) ? init.method.toUpperCase() : 'GET';

    // Solo cachear GETs a rutas /api/
    const isApiGet = method === 'GET' && (url.includes('/api/') || url.startsWith('/api'));
    if (!isApiGet) return _origFetch(input, init);

    // Revisar caché
    const cached = getCached(url);
    if (cached !== null) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-From-Cache': 'true',
          'X-Cache-Age': String(Date.now() - (memCache.get(cacheKey(url))?.ts || Date.now())),
        },
      });
    }

    // Fetch real
    try {
      const resp = await _origFetch(input, init);
      if (resp.ok) {
        const clone = resp.clone();
        clone.json().then(data => {
          setCached(url, data);
          updateCacheStats();
        }).catch(() => {});
      }
      return resp;
    } catch (err) {
      // Si falla la red pero tenemos caché expirado, devolverlo igual (stale-while-revalidate)
      const stale = getStale(url);
      if (stale !== null) {
        console.warn('[SumiCache] Red no disponible, sirviendo datos expirados para:', url);
        return new Response(JSON.stringify(stale), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-From-Cache': 'stale' },
        });
      }
      throw err;
    }
  };

  function getStale(url) {
    const key = cacheKey(url);
    const raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw).data; } catch (_) { return null; }
  }

  // ── Funciones públicas ───────────────────────────────────────────────────────
  /** Invalida toda la caché /api/ */
  window.clearApiCache = function () {
    memCache.clear();
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX)) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) {}
    localStorage.setItem('sumi_last_refresh', String(Date.now()));
    console.info('[SumiCache] Caché limpiada');
  };

  /** Invalida endpoints específicos que matcheen un patrón */
  window.invalidateCachePattern = function (pattern) {
    const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    memCache.forEach((v, k) => { if (re.test(k)) memCache.delete(k); });
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX) && re.test(k)) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) {}
  };

  /** Retorna info de estado del caché */
  window.getCacheStatus = function () {
    return {
      memEntries  : memCache.size,
      lsKB        : getTotalLSKB(),
      lastRefresh : localStorage.getItem('sumi_last_refresh'),
      ttlMs       : CACHE_TTL,
      nextRefreshIn: getNextRefreshMs(),
    };
  };

  function getNextRefreshMs() {
    const last = +(localStorage.getItem('sumi_last_refresh') || 0);
    return Math.max(0, CACHE_TTL - (Date.now() - last));
  }

  function updateCacheStats() {
    try {
      localStorage.setItem(LS_STATS_KEY, JSON.stringify({
        entries: memCache.size,
        lsKB: getTotalLSKB(),
        ts: Date.now(),
      }));
    } catch (_) {}
  }

  // ── Auto-refresh cada 2 horas ────────────────────────────────────────────────
  (function setupAutoRefresh() {
    const lastRefresh = +(localStorage.getItem('sumi_last_refresh') || 0);
    if (!lastRefresh) {
      localStorage.setItem('sumi_last_refresh', String(Date.now()));
    }

    // Si ya pasaron 2h desde último refresh: invalidar caché al cargar la página
    if (Date.now() - lastRefresh > CACHE_TTL) {
      window.clearApiCache();
    }

    // Programar el próximo auto-refresh
    function scheduleNextRefresh() {
      const remaining = getNextRefreshMs();
      setTimeout(function doRefresh() {
        console.info('[SumiCache] ⏱ Auto-refresh activado (2h)');
        window.clearApiCache();

        // Actualizar indicador visual si existe
        const statusEl = document.querySelector('.ms-refresh-status');
        const btnEl    = document.querySelector('.ms-refresh-btn');
        if (statusEl) {
          statusEl.textContent = '🔄 Actualizando datos automáticamente…';
          statusEl.className   = 'ms-refresh-status loading';
        }
        if (btnEl) btnEl.disabled = true;

        // Mostrar toast de notificación
        showRefreshToast();

        // Recargar datos de la página actual sin full reload si tiene función propia
        if (typeof window.__reloadPageData === 'function') {
          window.__reloadPageData().then(() => {
            if (statusEl) {
              statusEl.textContent = '✅ Datos actualizados automáticamente · ' + new Date().toLocaleTimeString('es-MX');
              statusEl.className   = 'ms-refresh-status ok';
            }
            if (btnEl) btnEl.disabled = false;
          }).catch(() => {
            window.location.reload();
          });
        } else {
          // Fallback: full page reload después de 1.5s
          setTimeout(() => window.location.reload(), 1500);
        }

        // Programar el siguiente en otras 2h
        scheduleNextRefresh();
      }, remaining);
    }

    scheduleNextRefresh();
  })();

  // ── Toast de notificación ────────────────────────────────────────────────────
  function showRefreshToast() {
    try {
      let toast = document.getElementById('sumi-refresh-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sumi-refresh-toast';
        toast.style.cssText =
          'position:fixed;bottom:100px;right:28px;z-index:99999;' +
          'background:linear-gradient(135deg,#0d1b2e,#1a2e45);' +
          'border:1px solid rgba(230,168,0,.35);border-radius:12px;' +
          'padding:12px 16px;color:#F0F6FF;font-size:12.5px;' +
          'font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5);' +
          'display:flex;align-items:center;gap:10px;' +
          'transform:translateX(120%);transition:transform .4s cubic-bezier(.34,1.56,.64,1);';
        toast.innerHTML =
          '<span style="font-size:18px">⏱</span>' +
          '<div><strong style="color:#E6A800;display:block;margin-bottom:2px">Auto-refresh activado</strong>' +
          '<span style="color:#94a3b8;font-size:11px">Datos actualizados cada 2 horas</span></div>';
        document.body.appendChild(toast);
      }
      setTimeout(() => { toast.style.transform = 'translateX(0)'; }, 50);
      setTimeout(() => { toast.style.transform = 'translateX(120%)'; }, 4500);
    } catch (_) {}
  }

  // ── Modificar el botón de refresh ────────────────────────────────────────────
  // (se ejecuta una vez que el DOM esté listo)
  function patchRefreshButton() {
    const btn = document.querySelector('.ms-refresh-btn');
    if (!btn || btn._sumiPatched) return;
    btn._sumiPatched = true;

    btn.addEventListener('click', function (e) {
      e.stopImmediatePropagation();
      e.preventDefault();

      const statusEl = document.querySelector('.ms-refresh-status');
      if (statusEl) {
        statusEl.textContent = '🔄 Limpiando caché y actualizando…';
        statusEl.className   = 'ms-refresh-status loading';
      }
      btn.disabled = true;

      window.clearApiCache();

      if (typeof window.__reloadPageData === 'function') {
        window.__reloadPageData().then(() => {
          if (statusEl) {
            statusEl.textContent = '✅ Actualizado · ' + new Date().toLocaleTimeString('es-MX');
            statusEl.className   = 'ms-refresh-status ok';
          }
          btn.disabled = false;
        }).catch(() => {
          window.location.reload();
        });
      } else {
        setTimeout(() => window.location.reload(), 200);
      }
    }, true);
  }

  // ── Indicador de caché en la barra ───────────────────────────────────────────
  function injectCacheIndicator() {
    const bar = document.querySelector('.ms-refresh-inner');
    if (!bar || document.getElementById('sumi-cache-ind')) return;

    const lastRefreshTs = +(localStorage.getItem('sumi_last_refresh') || Date.now());
    const agoMin = Math.round((Date.now() - lastRefreshTs) / 60000);
    const nextMin = Math.round(getNextRefreshMs() / 60000);

    const ind = document.createElement('span');
    ind.id = 'sumi-cache-ind';
    ind.style.cssText =
      'font-size:10.5px;color:#64748b;font-family:\'DM Mono\',monospace;letter-spacing:.04em;margin-left:auto;white-space:nowrap;';
    ind.textContent = agoMin < 2
      ? `⚡ Caché activo · próximo refresh en ${nextMin}m`
      : `⚡ Caché activo · ${agoMin}m ago · refresh en ${nextMin}m`;
    bar.appendChild(ind);

    // Actualizar cada minuto
    setInterval(() => {
      const ago2 = Math.round((Date.now() - (+(localStorage.getItem('sumi_last_refresh') || Date.now()))) / 60000);
      const next2 = Math.round(getNextRefreshMs() / 60000);
      ind.textContent = ago2 < 2
        ? `⚡ Caché activo · próximo refresh en ${next2}m`
        : `⚡ Caché activo · ${ago2}m ago · refresh en ${next2}m`;
    }, 60000);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  function boot() {
    patchRefreshButton();
    injectCacheIndicator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // Retry por si app-ui-boot.js aún no insertó la barra
  setTimeout(boot, 800);
  setTimeout(boot, 2500);

  window.__sumiCache = { version: '1.0', ttl: CACHE_TTL };
  console.info(`[SumiCache] ✅ Iniciado · TTL: 2h · LS: ${getTotalLSKB()}KB usados`);
})();
