'use strict';

/**
 * src/storage/parquet-export.js — Exporta snapshots DuckDB a Parquet
 * Uso: node src/storage/parquet-export.js <snapshot.duckdb> <out-dir>
 *   o como módulo: const { exportToParquet } = require('./src/storage/parquet-export');
 *
 * Parquet es 60-85% más pequeño que DuckDB embedded para el mismo dataset.
 * Compatible con S3/R2 httpfs para lectura remota sin descargar.
 */

const fs = require('fs');
const path = require('path');

async function exportToParquet(duckdbFile, outDir, opts = {}) {
  if (!fs.existsSync(duckdbFile)) throw new Error('No existe: ' + duckdbFile);
  fs.mkdirSync(outDir, { recursive: true });

  const duckdb = require('duckdb');
  const src = new duckdb.Database(duckdbFile, { access_mode: 'READ_ONLY' });
  const conn = src.connect();

  function all(sql) {
    return new Promise((res, rej) => conn.all(sql, (err, rows) => err ? rej(err) : res(rows || [])));
  }
  function run(sql) {
    return new Promise((res, rej) => conn.run(sql, (err) => err ? rej(err) : res()));
  }

  try {
    const tables = await all(`SELECT table_name FROM information_schema.tables WHERE table_schema='main'`);
    const result = [];
    for (const { table_name } of tables) {
      const out = path.join(outDir, `${table_name}.parquet`);
      const compression = opts.compression || 'ZSTD'; // SNAPPY, ZSTD, GZIP
      try {
        await run(`COPY "${table_name}" TO '${out.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION ${compression})`);
        const sz = fs.statSync(out).size;
        result.push({ table: table_name, file: out, bytes: sz, mb: +(sz / 1048576).toFixed(2) });
      } catch (e) {
        result.push({ table: table_name, error: e.message });
      }
    }
    const manifest = {
      source: duckdbFile,
      exported_at: new Date().toISOString(),
      compression: opts.compression || 'ZSTD',
      tables: result,
      total_mb: +result.reduce((s, t) => s + (t.mb || 0), 0).toFixed(2),
    };
    fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    conn.close();
    src.close();
  }
}

// CLI
if (require.main === module) {
  const [inPath, outDir] = process.argv.slice(2);
  if (!inPath || !outDir) {
    console.error('Uso: node parquet-export.js <snapshot.duckdb> <out-dir>');
    process.exit(1);
  }
  exportToParquet(inPath, outDir)
    .then((m) => { console.log(JSON.stringify(m, null, 2)); })
    .catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { exportToParquet };
