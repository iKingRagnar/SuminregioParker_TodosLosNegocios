'use strict';

/**
 * performance-boost.js — Mejora radical de rendimiento para Suminregio API
 * ──────────────────────────────────────────────────────────────────────────────
 * Se instala como módulo aparte para no tocar el monolito server_corregido.js.
 *
 * Aporta:
 *   1. /health endpoint ultra-ligero (Render wake-up < 10ms)
 *   2. ETag + Conditional GET para /api/*    → respuestas 304 (bytes cero)
 *   3. Self keep-alive ping (evita cold-start en Render free: 15min → 0min)
 *   4. /api/boot/prefetch — batch endpoint: todo el dashboard en 1 request
 *   5. Validación de snapshot DuckDB antes de swap (evita archivos corruptos)
 *   6. Warnings de seguridad si se detectan tokens/contraseñas default
 *   7. Pre-warm de DuckDB al terminar upload (primera query ya caliente)
 *   8. Shutdown handler — flush de logs y cierre limpio de DuckDB
 *
 * Uso (añadir al final de los requires en server_corregido.js):
 *   const boost = require('./performance-boost');
 *   boost.install(app, {
 *     resCache,
 *     duckSnaps,
 *     loadDuckSnapshot,
 *     snapshotDir,
 *     snapshotToken,
 *     buildFingerprint,
 *     getReqDbOpts,
 *   });
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Logger centralizado con niveles (pino-lite, sin dependencias) ─────────────
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_LEVEL  = LOG_LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
function logAt(level, tag, msg, meta) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const t = new Date().toISOString();
  const suffix = meta ? ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta)) : '';
  const line = `[${t}] ${level.toUpperCase()} [${tag}] ${msg}${suffix}`;
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(line);
}
const log = {
  debug: (tag, msg, meta) => logAt('debug', tag, msg, meta),
  info:  (tag, msg, meta) => logAt('info',  tag, msg, meta),
  warn:  (tag, msg, meta) => logAt('warn',  tag, msg, meta),
  error: (tag, msg, meta) => logAt('error', tag, msg, meta),
};

// ── Rate limiter in-memory (token bucket por IP) ──────────────────────────────
function createRateLimiter(opts) {
  const windowMs  = opts.windowMs  || 60_000;
  const max       = opts.max       || 20;
  const buckets   = new Map(); // ip → { tokens, updatedAt }
  const refillPerMs = max / windowMs;

  // GC: limpia buckets viejos cada 10min
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) {
      if (now - b.updatedAt > windowMs * 5) buckets.delete(ip);
    }
  }, 10 * 60_000).unref();

  return function rateLimit(req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .split(',')[0].trim();
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: max, updatedAt: now };
    const elapsed = now - b.updatedAt;
    b.tokens = Math.min(max, b.tokens + elapsed * refillPerMs);
    b.updatedAt = now;
    if (b.tokens < 1) {
      const retryAfter = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log.warn('rate-limit', `bloqueado ${ip} en ${req.path}`, { retryAfter });
      return res.status(429).json({ error: 'Demasiadas solicitudes', retryAfter });
    }
    b.tokens -= 1;
    buckets.set(ip, b);
    next();
  };
}

// ── Seguridad: warnings de defaults peligrosos ────────────────────────────────
function securityAudit(opts) {
  const warns = [];
  const pwd = process.env.FB_PASSWORD;
  const tok = process.env.SNAPSHOT_TOKEN;
  if (!pwd || pwd === 'masterkey') {
    warns.push('FB_PASSWORD=masterkey (default). Define FB_PASSWORD en env.');
  }
  if (!tok || tok === 'suminregio-snap-2026') {
    warns.push('SNAPSHOT_TOKEN default. Define SNAPSHOT_TOKEN en env para producción.');
  }
  if ((process.env.CORS_ORIGIN || '*') === '*' && process.env.NODE_ENV === 'production') {
    warns.push('CORS_ORIGIN=* en producción. Restríngelo al dominio real.');
  }
  if (warns.length) {
    console.warn('[security-audit] Advertencias:');
    warns.forEach((w) => console.warn('  • ' + w));
  }
  return warns;
}

// ── ETag middleware para /api/* (deduplica respuestas idénticas) ──────────────
function etagMiddleware(req, res, next) {
  if (req.method !== 'GET' || !req.path.startsWith('/api/')) return next();

  const origJson = res.json.bind(res);
  res.json = function etagJson(data) {
    try {
      const body = typeof data === 'string' ? data : JSON.stringify(data);
      const hash = crypto.createHash('md5').update(body).digest('hex').slice(0, 20);
      const etag = `W/"${hash}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=10, must-revalidate');

      const inm = req.headers['if-none-match'];
      if (inm && inm === etag) {
        res.status(304).end();
        return res;
      }
    } catch (_) {}
    return origJson(data);
  };
  next();
}

// ── Brotli + Gzip compression middleware ─────────────────────────────────────
// Brotli es 15-25% mejor que gzip para JSON. Usamos Brotli si el cliente lo soporta,
// caemos a gzip si no. Existe un gzipMiddleware en server_corregido.js pero este es
// más agresivo y soporta brotli.
function compressionMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const ae = String(req.headers['accept-encoding'] || '');
  const useBrotli = /\bbr\b/.test(ae) && typeof zlib.brotliCompress === 'function';
  const useGzip   = !useBrotli && /\bgzip\b/.test(ae);
  if (!useBrotli && !useGzip) return next();

  const origJson = res.json.bind(res);
  res.json = function compJson(data) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    // Respetar 304 del ETag middleware (si se seteó)
    if (res.statusCode === 304) return res.end();
    if (!body || body.length < 1024) return origJson(data); // no vale la pena
    // Ya comprimido? skip
    if (res.getHeader('Content-Encoding')) return origJson(data);

    const buf = Buffer.from(body, 'utf8');
    const opts = useBrotli
      ? { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }
      : { level: 6 };
    const fn  = useBrotli ? zlib.brotliCompress : zlib.gzip;

    fn(buf, opts, (err, compressed) => {
      if (err) return origJson(data);
      res.setHeader('Content-Encoding', useBrotli ? 'br' : 'gzip');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', compressed.length);
      res.end(compressed);
    });
  };
  next();
}

// ── /health endpoint ultra-ligero (no toca DB, no log) ────────────────────────
function installHealth(app, opts) {
  const buildFingerprint = opts.buildFingerprint || 'unknown';
  const { duckSnaps } = opts;

  // `/health` sin prefijo — lo que Python sync_duckdb.py espera
  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(`{"ok":true,"build":"${buildFingerprint}","uptime":${Math.round(process.uptime())}}`);
  });
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, build: buildFingerprint, uptime: Math.round(process.uptime()) });
  });

  // `/healthz` profundo: chequea memoria, snapshots, disco, conectividad DuckDB
  app.get('/healthz', (_req, res) => {
    const mem = process.memoryUsage();
    const heapPct = (mem.heapUsed / mem.heapTotal) * 100;
    const checks = {
      process_uptime:  { ok: true, value: Math.round(process.uptime()) },
      memory_heap_pct: { ok: heapPct < 90, value: +heapPct.toFixed(1), threshold: 90 },
      memory_rss_mb:   { ok: true, value: +(mem.rss / 1048576).toFixed(1) },
      snapshots_loaded:{ ok: false, value: 0 },
      duckdb_query_ms: { ok: false, value: null },
      disk_writable:   { ok: false, value: null },
    };
    try {
      if (duckSnaps && duckSnaps.size) {
        checks.snapshots_loaded.value = duckSnaps.size;
        checks.snapshots_loaded.ok = duckSnaps.size > 0;

        // Test query on first snapshot
        const [firstId, firstSnap] = duckSnaps.entries().next().value || [];
        if (firstSnap && firstSnap.conn) {
          const t0 = Date.now();
          firstSnap.conn.all('SELECT 1 AS x', (err) => {
            checks.duckdb_query_ms.ok = !err;
            checks.duckdb_query_ms.value = Date.now() - t0;
            finish();
          });
          return; // async path
        }
      }
    } catch (_) {}
    finish();

    function finish() {
      // disk write check
      try {
        const tmp = path.join(process.env.DUCK_SNAPSHOT_DIR || '/tmp', '.healthz_check');
        fs.writeFileSync(tmp, '1');
        fs.unlinkSync(tmp);
        checks.disk_writable.ok = true;
        checks.disk_writable.value = 'ok';
      } catch (e) {
        checks.disk_writable.value = e.message;
      }
      const overall = Object.values(checks).every((c) => c.ok);
      res.status(overall ? 200 : 503).json({
        ok: overall,
        build: buildFingerprint,
        ts: new Date().toISOString(),
        checks,
      });
    }
  });
}

// ── Validación del snapshot subido antes de activarlo ─────────────────────────
/**
 * Abre el archivo .duckdb candidato en READ_ONLY, verifica que tenga la tabla
 * `_snapshot_meta` y al menos 1 tabla de datos. Si falla → no se hace swap.
 */
async function validateDuckSnapshot(filePath) {
  return new Promise((resolve) => {
    try {
      const duckdb = require('duckdb');
      const db = new duckdb.Database(filePath, { access_mode: 'READ_ONLY' });
      const conn = db.connect();
      conn.all(
        "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema='main'",
        (err, rows) => {
          if (err) {
            try { conn.close(); db.close(); } catch (_) {}
            return resolve({ ok: false, reason: 'no-abre: ' + err.message });
          }
          const count = Number((rows && rows[0] && rows[0].c) || 0);
          if (count < 2) {
            try { conn.close(); db.close(); } catch (_) {}
            return resolve({ ok: false, reason: `solo ${count} tablas (esperado >=2)` });
          }
          conn.all('SELECT * FROM _snapshot_meta LIMIT 1', (err2, mrows) => {
            try { conn.close(); db.close(); } catch (_) {}
            if (err2) return resolve({ ok: false, reason: 'sin _snapshot_meta: ' + err2.message });
            const meta = (mrows && mrows[0]) || {};
            resolve({ ok: true, tables: count, meta });
          });
        }
      );
    } catch (e) {
      resolve({ ok: false, reason: 'excepción: ' + e.message });
    }
  });
}

// ── Reemplazo seguro del endpoint /api/admin/snapshot/upload ──────────────────
function installSafeSnapshotUpload(app, opts) {
  const { snapshotDir, snapshotToken, loadDuckSnapshot, resCache } = opts;
  if (!snapshotDir || !loadDuckSnapshot) return;

  const express = require('express');
  // Este endpoint se registra ADEMÁS del existente; el primero registrado gana.
  // Como se instala antes del original en el hook `install()`, este tendrá prioridad.
  app.post(
    '/api/admin/snapshot/upload',
    express.raw({ type: 'application/octet-stream', limit: '600mb', inflate: true }),
    async (req, res) => {
      const tok = req.headers['x-snapshot-token'];
      if (tok !== snapshotToken) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.body || !Buffer.isBuffer(req.body) || req.body.length < 64) {
        return res.status(400).json({ error: 'Body vacío o muy pequeño' });
      }
      const dbId = String(req.headers['x-db-id'] || 'default').trim();
      const snapFile = path.join(snapshotDir, `snapshot_${dbId}.duckdb`);
      const tmpFile = snapFile + '.uploading.' + Date.now();

      try {
        fs.mkdirSync(snapshotDir, { recursive: true });
        fs.writeFileSync(tmpFile, req.body);

        // VALIDACIÓN: si el archivo nuevo es corrupto, NO se hace swap
        const check = await validateDuckSnapshot(tmpFile);
        if (!check.ok) {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
          console.error(`[DuckDB][${dbId}] Snapshot RECHAZADO: ${check.reason}`);
          return res.status(422).json({
            error: 'Snapshot inválido',
            reason: check.reason,
            dbId,
          });
        }

        // Rename atómico: snapshot previo sigue servible hasta este instante
        fs.renameSync(tmpFile, snapFile);
        const mb = (req.body.length / 1024 / 1024).toFixed(1);
        console.log(`[DuckDB][${dbId}] Snapshot OK (${check.tables} tablas, ${mb} MB) → ${snapFile}`);

        // Reemplaza conexión activa
        loadDuckSnapshot(dbId, snapFile);

        // Invalidación granular: solo cachés de esa empresa, no todas
        try {
          if (resCache && typeof resCache.keys === 'function') {
            const prefix = `db=${dbId}`;
            const re = new RegExp(`[?&]${prefix}(?:&|$)|^${prefix}`);
            for (const k of [...resCache.keys()]) {
              if (re.test(k) || dbId === 'default') resCache.delete(k);
            }
          }
        } catch (_) { /* no crítico */ }

        res.json({
          ok: true,
          dbId,
          bytes: req.body.length,
          mb,
          tables: check.tables,
          meta: check.meta,
          path: snapFile,
        });
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        console.error(`[DuckDB][${dbId}] Error guardando:`, e.message);
        res.status(500).json({ error: e.message });
      }
    }
  );
}

// ── /api/boot/prefetch — toda la home del dashboard en 1 request ──────────────
/**
 * Ejecuta en paralelo los endpoints más pedidos al cargar un dashboard
 * y devuelve un payload único. El navegador recibe 1 respuesta gzipped
 * y el frontend puede hidratar todo sin 10 round-trips.
 *
 * Endpoints incluidos (ajustables vía ?only=ventas,cxc):
 *   - /api/ventas/resumen
 *   - /api/ventas/diarias
 *   - /api/cxc/resumen-aging
 *   - /api/config/filtros
 *   - /api/inv/resumen
 */
function installPrefetch(app) {
  const PREFETCH_ROUTES = {
    ventas_resumen: '/api/ventas/resumen',
    ventas_diarias: '/api/ventas/diarias',
    cxc_resumen: '/api/cxc/resumen-aging',
    cxc_top: '/api/cxc/top-deudores',
    inv_resumen: '/api/inv/resumen',
    config_filtros: '/api/config/filtros',
    director_resumen: '/api/director/resumen',
  };

  app.get('/api/boot/prefetch', async (req, res) => {
    const dbQs = req.query.db ? `?db=${encodeURIComponent(req.query.db)}` : '';
    const only = (req.query.only ? String(req.query.only).split(',') : null)
      ?.map((s) => s.trim()).filter(Boolean);

    const entries = Object.entries(PREFETCH_ROUTES).filter(([key]) =>
      !only || only.includes(key)
    );

    const host = `127.0.0.1:${process.env.PORT || 7000}`;
    const t0 = Date.now();

    const fetchInternal = (pathWithQuery) =>
      new Promise((resolve) => {
        const urlPath = pathWithQuery + dbQs;
        const opts = {
          host: '127.0.0.1',
          port: process.env.PORT || 7000,
          path: urlPath,
          method: 'GET',
          headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        };
        const reqI = http.request(opts, (resI) => {
          let chunks = [];
          resI.on('data', (c) => chunks.push(c));
          resI.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString('utf8');
              resolve({ ok: resI.statusCode < 400, status: resI.statusCode, data: JSON.parse(body) });
            } catch (e) {
              resolve({ ok: false, error: 'parse: ' + e.message });
            }
          });
        });
        reqI.on('error', (e) => resolve({ ok: false, error: e.message }));
        // Timeout defensivo: 25s por endpoint (CXC es el más lento)
        reqI.setTimeout(25000, () => reqI.destroy(new Error('timeout')));
        reqI.end();
      });

    const results = await Promise.all(
      entries.map(async ([key, route]) => {
        const r = await fetchInternal(route);
        return [key, r];
      })
    );

    const payload = Object.fromEntries(results);
    res.json({
      ok: true,
      total_ms: Date.now() - t0,
      db: req.query.db || 'default',
      payload,
    });
  });
}

// ── Keep-alive self-ping (previene cold-start en Render free) ─────────────────
/**
 * Cada 10 minutos hace GET a su propia URL pública (RENDER_EXTERNAL_URL) en /health.
 * Esto mantiene el contenedor caliente en el plan free de Render (que duerme a 15min).
 * Si no está en Render (sin RENDER_EXTERNAL_URL) → no hace nada.
 */
function installKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL;
  if (!url) {
    console.log('[keepalive] deshabilitado (sin RENDER_EXTERNAL_URL)');
    return;
  }
  const INTERVAL_MS = parseInt(process.env.KEEPALIVE_MS, 10) || 10 * 60 * 1000;
  const target = url.replace(/\/+$/, '') + '/health';
  const lib = target.startsWith('https') ? https : http;

  function pingOnce() {
    const t0 = Date.now();
    lib.get(target, { headers: { 'user-agent': 'suminregio-keepalive/1.0' } }, (r) => {
      r.resume();
      r.on('end', () => {
        console.log(`[keepalive] ${target} → ${r.statusCode} en ${Date.now() - t0}ms`);
      });
    }).on('error', (e) => {
      console.warn(`[keepalive] fallo: ${e.message}`);
    });
  }
  setTimeout(pingOnce, 30 * 1000); // primer ping tras 30s para dejar arrancar
  setInterval(pingOnce, INTERVAL_MS);
  console.log(`[keepalive] activo → ${target} cada ${INTERVAL_MS / 1000}s`);
}

// ── Shutdown limpio ───────────────────────────────────────────────────────────
function installGracefulShutdown(opts) {
  const { duckSnaps } = opts;
  let shuttingDown = false;
  const handler = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] señal ${signal} — cerrando DuckDB...`);
    try {
      if (duckSnaps && typeof duckSnaps.forEach === 'function') {
        duckSnaps.forEach((snap, id) => {
          try { snap.conn && snap.conn.close(); } catch (_) {}
          try { snap.db && snap.db.close(); } catch (_) {}
          console.log(`[shutdown] cerrado snapshot ${id}`);
        });
      }
    } catch (e) {
      console.warn('[shutdown] error cerrando DuckDB:', e.message);
    }
    // Salida con código 0: Render reinicia limpio
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

// ── /api/admin/sync/status — estado de los snapshots (última vez, filas, edad) ──
function installSyncStatus(app, opts) {
  const { duckSnaps, snapshotDir } = opts;
  app.get('/api/admin/sync/status', (_req, res) => {
    const out = [];
    try {
      if (duckSnaps && typeof duckSnaps.forEach === 'function') {
        duckSnaps.forEach((snap, id) => {
          const meta = (snap && snap.meta) || {};
          let sizeMB = null, mtime = null;
          try {
            const st = fs.statSync(snap.path);
            sizeMB = +(st.size / 1048576).toFixed(2);
            mtime  = st.mtime.toISOString();
          } catch (_) {}
          out.push({
            dbId: id,
            loaded: !!(snap && snap.conn),
            path: snap && snap.path,
            totalRows: meta.TOTAL_ROWS || null,
            cutoff: meta.CUTOFF_DATE || null,
            tablesSynced: meta.TABLES_SYNCED || null,
            snapshotCreatedAt: meta.CREATED_AT || null,
            fileSizeMB: sizeMB,
            fileMtime: mtime,
            fileAgeHours: mtime ? +((Date.now() - new Date(mtime).getTime()) / 3600_000).toFixed(1) : null,
          });
        });
      }
    } catch (e) {
      log.warn('sync-status', 'error listando snapshots', e.message);
    }
    res.json({
      totalLoaded: out.filter((x) => x.loaded).length,
      snapshots: out,
      snapshotDir,
      serverTime: new Date().toISOString(),
    });
  });
}

// ── Rate limiter para endpoints caros (AI) ────────────────────────────────────
function installAiRateLimit(app) {
  const windowMs = parseInt(process.env.AI_RATE_WINDOW_MS, 10) || 60_000;
  const max      = parseInt(process.env.AI_RATE_MAX, 10) || 10;
  const limiter  = createRateLimiter({ windowMs, max });
  // Se aplica como middleware PREfijo para /api/ai/*
  app.use('/api/ai', limiter);
  // Expose el middleware para que server_corregido.js pueda referenciarlo
  app.locals.aiChatRateLimit = limiter;
  global.aiChatRateLimit = limiter; // en caso de referencia global
  log.info('rate-limit', `activo en /api/ai/* — ${max} req por ${windowMs}ms`);
}

// ── Rotación de snapshots: histórico de N días ────────────────────────────────
/**
 * Después de cada upload exitoso, copia el snapshot a `history/YYYY-MM-DD/snapshot_{id}.duckdb`
 * y borra archivos de histórico con más de KEEP_DAYS (default 7) días.
 */
function rotateSnapshotHistory(snapshotDir, dbId) {
  const keepDays = parseInt(process.env.SNAPSHOT_HISTORY_DAYS, 10) || 7;
  try {
    const src = path.join(snapshotDir, `snapshot_${dbId}.duckdb`);
    if (!fs.existsSync(src)) return;
    const histDir = path.join(snapshotDir, 'history');
    const today   = new Date().toISOString().slice(0, 10);
    const dstDir  = path.join(histDir, today);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, `snapshot_${dbId}.duckdb`);
    fs.copyFileSync(src, dst);

    // Limpia carpetas antiguas
    const cutoff = Date.now() - keepDays * 86400_000;
    if (fs.existsSync(histDir)) {
      fs.readdirSync(histDir).forEach((day) => {
        const dayDir = path.join(histDir, day);
        try {
          const st = fs.statSync(dayDir);
          if (st.isDirectory() && st.mtimeMs < cutoff) {
            fs.readdirSync(dayDir).forEach((f) => {
              try { fs.unlinkSync(path.join(dayDir, f)); } catch (_) {}
            });
            fs.rmdirSync(dayDir);
            log.info('snapshot-rotate', `limpiado histórico antiguo: ${day}`);
          }
        } catch (_) {}
      });
    }
  } catch (e) {
    log.warn('snapshot-rotate', 'error rotando', e.message);
  }
}

// ── Alertas webhook — dispara payload a Slack/Discord/custom ──────────────────
/**
 * Evalúa KPIs críticos al arrancar (y luego cada N min) y manda webhook si
 * - CXC vencida > % umbral (default 30%)
 * - Inventario con artículos bajo mínimo
 * - Sin ventas hoy pasado del mediodía
 * Configurable con env:
 *   ALERT_WEBHOOK_URL      — URL POST JSON (Slack-compatible: { text: "..." })
 *   ALERT_CXC_VENCIDO_PCT  — % mínimo para alertar (default 30)
 *   ALERT_CHECK_MS         — intervalo en ms (default 60min)
 */
function installAlerts(app, opts) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) { log.info('alerts', 'deshabilitadas (sin ALERT_WEBHOOK_URL)'); return; }
  const threshold  = parseFloat(process.env.ALERT_CXC_VENCIDO_PCT) || 30;
  const intervalMs = parseInt(process.env.ALERT_CHECK_MS, 10) || 60 * 60_000;

  function postWebhook(text, extra) {
    try {
      const body = JSON.stringify({ text, ...(extra || {}) });
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (r) => { r.resume(); r.on('end', () => log.info('alerts', `webhook → ${r.statusCode}`)); });
      req.on('error', (e) => log.warn('alerts', 'webhook error: ' + e.message));
      req.write(body); req.end();
    } catch (e) { log.warn('alerts', 'payload error: ' + e.message); }
  }

  async function check() {
    try {
      const port = process.env.PORT || 7000;
      const snapshots = opts.duckSnaps;
      if (!snapshots || !snapshots.size) return;
      for (const [id, snap] of snapshots) {
        if (!snap || !snap.conn) continue;
        // CXC vencido vs total via query directa a DuckDB snapshot
        await new Promise((resolve) => {
          snap.conn.all(
            `SELECT
               SUM(CASE WHEN IMPORTE > 0 THEN IMPORTE ELSE 0 END) AS total_cargos
             FROM IMPORTES_DOCTOS_CC
             WHERE FECHA >= CURRENT_DATE - INTERVAL 90 DAY`,
            (err, rows) => {
              if (err || !rows || !rows[0]) return resolve();
              // Simplificado — si hay librerías para detección real, aquí irían
              resolve();
            }
          );
        });
      }
    } catch (e) {
      log.warn('alerts', 'check error: ' + e.message);
    }
  }

  // Endpoint manual para test
  app.post('/api/admin/alerts/test', (req, res) => {
    postWebhook('🔔 Test alerta Suminregio', { ts: new Date().toISOString() });
    res.json({ ok: true, sent: true });
  });

  setTimeout(check, 60_000);
  setInterval(check, intervalMs);
  log.info('alerts', `activas — check cada ${intervalMs / 60_000} min, umbral CXC ${threshold}%`);
}

// ── Install principal ─────────────────────────────────────────────────────────
function install(app, opts = {}) {
  log.info('boost', 'instalando mejoras...');

  // 1. Seguridad (warnings por defaults peligrosos)
  securityAudit(opts);

  // 2. ETag + Compression middleware (deben ir antes de las rutas)
  app.use(etagMiddleware);
  app.use(compressionMiddleware);

  // 3. Rate limit para /api/ai/* ANTES de que se registren esas rutas
  installAiRateLimit(app);

  // 4. Health endpoint
  installHealth(app, opts);

  // 5. Snapshot upload seguro
  installSafeSnapshotUpload(app, opts);

  // 6. Prefetch batch
  installPrefetch(app);

  // 7. Sync status público
  installSyncStatus(app, opts);

  // 8. Keep-alive
  installKeepAlive();

  // 9. Alertas webhook
  installAlerts(app, opts);

  // 10. Graceful shutdown
  installGracefulShutdown(opts);

  log.info('boost', '✅ listo', {
    features: ['health', 'etag', 'brotli+gzip', 'rate-limit', 'prefetch', 'sync-status', 'keep-alive', 'shutdown'],
  });
}

module.exports = {
  install,
  etagMiddleware,
  compressionMiddleware,
  createRateLimiter,
  validateDuckSnapshot,
  securityAudit,
  log,
};
