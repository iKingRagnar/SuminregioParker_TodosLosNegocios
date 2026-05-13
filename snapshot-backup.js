'use strict';

/**
 * snapshot-backup.js — Endpoints para descargar y listar snapshots.
 *
 *   GET /api/admin/snapshot/download?db=...   → descarga el .duckdb actual
 *   GET /api/admin/snapshot/list              → lista snapshots disponibles con tamaño
 *
 * Útil para:
 *  - Hacer backup local antes de un cambio riesgoso
 *  - Inspeccionar el snapshot que está actualmente en producción
 *  - Migración / replicación a otro entorno
 *
 * Seguridad:
 *  - Requiere X-Snapshot-Token (mismo que /upload) — timing-safe compare
 *  - dbId sanitizado (whitelist regex)
 *  - Path constrained al DUCK_SNAPSHOT_DIR (no path traversal)
 *  - Audit log de cada descarga
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function install(app, { snapshotDir, snapshotToken, log, audit }) {
  if (!snapshotDir) {
    log && log.warn && log.warn('snapshot-backup', 'no instalado (sin snapshotDir)');
    return;
  }

  function authOk(req) {
    if (!snapshotToken) return false;
    const provided = req.headers['x-snapshot-token'];
    const expected = Buffer.from(snapshotToken);
    const given = Buffer.from(String(provided || ''));
    if (expected.length !== given.length || expected.length === 0) return false;
    try { return crypto.timingSafeEqual(expected, given); } catch (_) { return false; }
  }

  app.get('/api/admin/snapshot/list', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const files = fs.readdirSync(snapshotDir)
        .filter((f) => f.startsWith('snapshot_') && f.endsWith('.duckdb'))
        .map((f) => {
          const full = path.join(snapshotDir, f);
          const stat = fs.statSync(full);
          return {
            dbId: f.replace(/^snapshot_/, '').replace(/\.duckdb$/, ''),
            filename: f,
            bytes: stat.size,
            mb: +(stat.size / 1024 / 1024).toFixed(2),
            mtime: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.bytes - a.bytes);
      res.json({ ok: true, dir: snapshotDir, snapshots: files });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/admin/snapshot/download', (req, res) => {
    if (!authOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const dbId = String(req.query.db || 'default').trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(dbId)) {
      return res.status(400).json({ error: 'db inválido (solo [a-zA-Z0-9_-])' });
    }
    const snapFile = path.join(snapshotDir, `snapshot_${dbId}.duckdb`);

    // Defense in depth: confirma que resolvedPath esté dentro de snapshotDir
    // (defendido por el regex también, pero defensa en profundidad)
    const real = path.resolve(snapFile);
    const realDir = path.resolve(snapshotDir);
    if (!real.startsWith(realDir + path.sep) && real !== realDir) {
      return res.status(400).json({ error: 'Path inválido' });
    }
    if (!fs.existsSync(snapFile)) {
      return res.status(404).json({ error: 'Snapshot no existe', dbId });
    }

    try {
      const stat = fs.statSync(snapFile);
      // Computar SHA-256 para que el cliente pueda verificar integridad
      const hash = crypto.createHash('sha256');
      const buf = fs.readFileSync(snapFile);
      hash.update(buf);
      const sha = hash.digest('hex');

      if (audit) audit.log(req, 'snapshot.download', { dbId, bytes: stat.size });

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="snapshot_${dbId}_${stat.mtime.toISOString().slice(0, 10)}.duckdb"`);
      res.setHeader('X-Snapshot-Sha256', sha);
      res.end(buf);
    } catch (e) {
      log && log.error && log.error('snapshot-download', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  log && log.info && log.info('snapshot-backup', '✅ /api/admin/snapshot/{list,download}');
}

module.exports = { install };
