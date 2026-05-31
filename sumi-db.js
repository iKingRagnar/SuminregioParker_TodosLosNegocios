'use strict';

/**
 * sumi-db.js — Persistencia ligera JSON file-based (zero dependencies)
 * Para colaboración: notas compartidas, tareas, aprobaciones, audit log.
 * Sin SQLite — append-only JSON + índice en memoria. Suficiente para <10k registros
 * por colección. Si crece, migrar a better-sqlite3.
 */

const fs = require('fs');
const path = require('path');

// Elige el primer directorio ESCRIBIBLE para persistir. Prioriza disco
// persistente (Render monta uno en /var/data) sobre /tmp (efímero: se borra en
// cada redeploy). Así los tickets de mejora, historial de metas, grupos y
// conversaciones de IA sobreviven a los deploys.
function _resolveDbDir() {
  const candidates = [];
  if (process.env.SUMI_DB_DIR) candidates.push(process.env.SUMI_DB_DIR);
  // Junto al cache persistente si ese disco existe.
  if (process.env.CACHE_DIR) candidates.push(path.join(process.env.CACHE_DIR, 'sumi-db'));
  try { if (fs.existsSync('/var/data')) candidates.push('/var/data/sumi-db'); } catch (_) {}
  // Fallbacks no persistentes (dev / sin disco).
  if (process.env.DUCK_SNAPSHOT_DIR) candidates.push(path.join(process.env.DUCK_SNAPSHOT_DIR, 'sumi-db'));
  candidates.push('/tmp/duck_snaps/sumi-db');

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const persistente = !/^\/tmp(\/|$)/.test(dir);
      if (!persistente) console.warn('[sumi-db] usando almacenamiento EFÍMERO ' + dir + ' (se borra en redeploy). Configura un disco persistente o SUMI_DB_DIR.');
      else console.log('[sumi-db] almacenamiento persistente: ' + dir);
      return dir;
    } catch (_) { /* probar siguiente */ }
  }
  return '/tmp/duck_snaps/sumi-db'; // último recurso
}

const DB_DIR = _resolveDbDir();

function ensure() {
  try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (_) {}
}

function fp(coll) { return path.join(DB_DIR, coll + '.jsonl'); }

function readAll(coll) {
  ensure();
  const f = fp(coll);
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

function append(coll, record) {
  ensure();
  const row = { id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString(), ...record };
  fs.appendFileSync(fp(coll), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function update(coll, id, patch) {
  const rows = readAll(coll);
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  rows[idx] = { ...rows[idx], ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fp(coll), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return rows[idx];
}

function remove(coll, id) {
  const rows = readAll(coll).filter((r) => r.id !== id);
  fs.writeFileSync(fp(coll), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  return true;
}

function query(coll, filter) {
  const rows = readAll(coll);
  if (!filter) return rows;
  return rows.filter((r) => Object.keys(filter).every((k) => r[k] === filter[k]));
}

module.exports = { readAll, append, update, remove, query, DB_DIR };
