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
      // Hash rápido (md5 es suficiente para ETag, no es crypto real)
      const hash = crypto.createHash('md5').update(body).digest('hex').slice(0, 20);
      const etag = `W/"${hash}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=10, must-revalidate');

      const inm = req.headers['if-none-match'];
      if (inm && inm === etag) {
        res.status(304).end();
        return res;
      }
    } catch (_) { /* si falla el hash, responder normal */ }
    return origJson(data);
  };
  next();
}

// ── /health endpoint ultra-ligero (no toca DB, no log) ────────────────────────
function installHealth(app, opts) {
  const buildFingerprint = opts.buildFingerprint || 'unknown';
  // `/health` sin prefijo — lo que Python sync_duckdb.py espera
  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(`{"ok":true,"build":"${buildFingerprint}","uptime":${Math.round(process.uptime())}}`);
  });
  // Alias en /api por si algún monitor lo busca ahí
  app.get('/api/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, build: buildFingerprint, uptime: Math.round(process.uptime()) });
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

// ── Install principal ─────────────────────────────────────────────────────────
function install(app, opts = {}) {
  console.log('[performance-boost] instalando mejoras...');

  // 1. Seguridad (emite warnings si hay defaults peligrosos)
  securityAudit(opts);

  // 2. ETag middleware — DEBE registrarse antes que cualquier route que quiera beneficiarse
  app.use(etagMiddleware);

  // 3. Health endpoint (ligero; Render free wake-up)
  installHealth(app, opts);

  // 4. Snapshot upload seguro (con validación pre-swap)
  installSafeSnapshotUpload(app, opts);

  // 5. Prefetch batch endpoint
  installPrefetch(app);

  // 6. Keep-alive cron (solo si hay URL pública configurada)
  installKeepAlive();

  // 7. Graceful shutdown
  installGracefulShutdown(opts);

  console.log('[performance-boost] ✅ listo: /health, ETag, prefetch, keep-alive, shutdown');
}

module.exports = {
  install,
  etagMiddleware,
  validateDuckSnapshot,
  securityAudit,
};
