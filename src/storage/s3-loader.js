'use strict';

/**
 * src/storage/s3-loader.js — DuckDB lee Parquet desde S3/R2 remoto
 *
 * Usa la extensión httpfs de DuckDB. No requiere descargar archivos.
 * Pensado para después: migrar de snapshots .duckdb locales a Parquet en S3/R2.
 *
 * Activar con env STORAGE_MODE=s3. Default sigue siendo 'local'.
 *
 * Env requeridas (si STORAGE_MODE=s3):
 *   S3_ENDPOINT   = https://<account>.r2.cloudflarestorage.com  (para R2; omitir para AWS S3)
 *   S3_BUCKET     = suminregio-snapshots
 *   S3_REGION     = auto  (R2) o us-east-1
 *   S3_KEY        = access key id
 *   S3_SECRET     = secret access key
 *   S3_PREFIX     = snapshots/   (prefijo dentro del bucket)
 */

const MODE = process.env.STORAGE_MODE || 'local';

function createS3Snapshot(dbId) {
  if (MODE !== 's3') throw new Error('STORAGE_MODE != s3');
  const duckdb = require('duckdb');
  const db = new duckdb.Database(':memory:');
  const conn = db.connect();

  return new Promise((resolve, reject) => {
    // Setup httpfs + credenciales
    const endpoint = process.env.S3_ENDPOINT || '';
    const region   = process.env.S3_REGION   || 'auto';
    const bucket   = process.env.S3_BUCKET;
    const prefix   = process.env.S3_PREFIX   || 'snapshots/';
    const key      = process.env.S3_KEY;
    const secret   = process.env.S3_SECRET;
    if (!bucket || !key || !secret) return reject(new Error('Falta S3_BUCKET / S3_KEY / S3_SECRET'));

    const setup = [
      `INSTALL httpfs`,
      `LOAD httpfs`,
      `SET s3_region='${region}'`,
      `SET s3_access_key_id='${key}'`,
      `SET s3_secret_access_key='${secret}'`,
      endpoint ? `SET s3_endpoint='${endpoint.replace(/^https?:\/\//, '')}'` : null,
      endpoint ? `SET s3_url_style='path'` : null,
      endpoint ? `SET s3_use_ssl=true` : null,
    ].filter(Boolean);

    let i = 0;
    function nextSetup() {
      if (i >= setup.length) return resolve({
        db, conn,
        s3Path: (table) => `s3://${bucket}/${prefix}${dbId}/${table}.parquet`,
      });
      conn.run(setup[i++] + ';', (err) => err ? reject(err) : nextSetup());
    }
    nextSetup();
  });
}

/** Carga un snapshot S3 creando VIEWs por cada tabla que apuntan al parquet remoto */
async function loadS3Snapshot(dbId, tableList) {
  const { db, conn, s3Path } = await createS3Snapshot(dbId);
  for (const t of tableList) {
    await new Promise((res, rej) => {
      conn.run(`CREATE OR REPLACE VIEW "${t}" AS SELECT * FROM read_parquet('${s3Path(t)}')`, (err) => err ? rej(err) : res());
    });
  }
  return { db, conn, meta: { mode: 's3', bucket: process.env.S3_BUCKET, dbId } };
}

module.exports = { loadS3Snapshot, MODE };
