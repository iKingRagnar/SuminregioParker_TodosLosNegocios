'use strict';

/**
 * sumi-db.js — Persistencia ligera JSON file-based (zero dependencies)
 * Para colaboración: notas compartidas, tareas, aprobaciones, audit log.
 * Sin SQLite — append-only JSON + índice en memoria. Suficiente para <10k registros
 * por colección. Si crece, migrar a better-sqlite3.
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = process.env.SUMI_DB_DIR || path.join(process.env.DUCK_SNAPSHOT_DIR || '/tmp/duck_snaps', 'sumi-db');

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
