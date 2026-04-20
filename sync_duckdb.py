#!/usr/bin/env python3
"""
sync_duckdb.py — Suminregio Parker: Firebird → DuckDB Nightly Sync
================================================================
Corre en el servidor Windows donde vive Firebird (conexión LOCAL, sin WAN).
Actualiza el snapshot una vez por noche vía Windows Task Scheduler.

INSTALAR dependencias (una sola vez):
    pip install fdb duckdb requests

CONFIGURAR variables de entorno en Windows (o editar los defaults abajo):
    FB_HOST          = localhost
    FB_DATABASE      = C:\Microsip datos\SUMINREGIO-PARKER.FDB  ← base principal (487 MB)
    FB_USER          = SYSDBA
    FB_PASSWORD      = masterkey
    FB_PORT          = 3050
    FB_CHARSET       = WIN1252
    RENDER_URL       = https://suminregioparker-todoslosnegocios.onrender.com
    SNAPSHOT_TOKEN   = suminregio-snap-2026
    DUCK_OUT         = C:\Microsip datos\snapshot.duckdb

RUTA CORRECTA en este servidor: C:\Microsip datos\  (con espacio, sin backslash al final)
Bases disponibles en esa ruta: SUMINREGIO-PARKER.FDB, SUMINREGIO MADERAS.FDB, etc.

EJECUTAR manualmente:
    python sync_duckdb.py

SALIDA esperada:
    2026-04-19 23:00:01 INFO === Suminregio DuckDB Sync ===
    2026-04-19 23:00:02 INFO Leyendo DOCTOS_VE...
    2026-04-19 23:00:08 INFO   → 48,312 filas en 6.1s
    ...
    2026-04-19 23:02:15 INFO DuckDB creado: C:\Microsip datos\snapshot.duckdb (87.3 MB)
    2026-04-19 23:02:48 INFO Upload exitoso en 33.1s: {"ok":true}
    2026-04-19 23:02:48 INFO ✅ Sync completado
"""

import os
import sys
import time
import logging
from datetime import datetime, timedelta

# ── Configuración ───────────────────────────────────────────────────────────
FB_HOST     = os.environ.get('FB_HOST',     'localhost')
FB_DB       = os.environ.get('FB_DATABASE', r'C:\Microsip datos\SUMINREGIO-PARKER.FDB')
FB_USER     = os.environ.get('FB_USER',     'SYSDBA')
FB_PASS     = os.environ.get('FB_PASSWORD', 'masterkey')
FB_PORT     = int(os.environ.get('FB_PORT', '3050'))
FB_CHARSET  = os.environ.get('FB_CHARSET',  'WIN1252')

RENDER_URL     = os.environ.get('RENDER_URL',     'https://suminregioparker-todoslosnegocios.onrender.com')
SNAPSHOT_TOKEN = os.environ.get('SNAPSHOT_TOKEN', 'suminregio-snap-2026')
DUCK_OUT       = os.environ.get('DUCK_OUT',       r'C:\Microsip datos\snapshot.duckdb')

YEARS_BACK = 3  # años de historia a sincronizar

# ── Logging ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            os.path.join(os.path.dirname(DUCK_OUT), 'sync_duckdb.log'),
            encoding='utf-8'
        ),
    ]
)
log = logging.getLogger('sync_duckdb')

# ── Tablas a sincronizar ────────────────────────────────────────────────────
# Solo columnas usadas por el dashboard (sin BLOBs, sin texto largo innecesario)
CUTOFF_DATE = (datetime.now() - timedelta(days=365 * YEARS_BACK)).strftime('%Y-%m-%d')

TABLES = {
    'DOCTOS_VE': {
        'sql': """
            SELECT d.DOCTO_VE_ID, d.FOLIO, d.FECHA, d.TIPO_DOCTO,
                   d.CLIENTE_ID, d.VENDEDOR_ID,
                   COALESCE(d.IMPORTE_NETO, 0.0) AS IMPORTE_NETO,
                   d.ESTATUS, d.APLICADO,
                   CAST(CURRENT_DATE - d.FECHA AS INTEGER) AS DIAS_ABIERTA
            FROM DOCTOS_VE d
            WHERE d.FECHA >= ?
        """,
        'params': [CUTOFF_DATE],
    },
    'DOCTOS_PV': {
        'sql': """
            SELECT d.DOCTO_PV_ID, d.FOLIO, d.FECHA, d.TIPO_DOCTO,
                   d.CLIENTE_ID, d.VENDEDOR_ID,
                   COALESCE(d.IMPORTE_NETO, 0.0) AS IMPORTE_NETO,
                   d.ESTATUS, d.APLICADO
            FROM DOCTOS_PV d
            WHERE d.FECHA >= ?
        """,
        'params': [CUTOFF_DATE],
    },
    'DOCTOS_VE_DET': {
        'sql': """
            SELECT det.DOCTO_VE_DET_ID, det.DOCTO_VE_ID,
                   det.ARTICULO_ID, det.UNIDADES,
                   COALESCE(det.PRECIO_UNITARIO,   0.0) AS PRECIO_UNITARIO,
                   COALESCE(det.PCTJE_DSCTO,       0.0) AS PCTJE_DSCTO,
                   COALESCE(det.PRECIO_TOTAL_NETO, 0.0) AS PRECIO_TOTAL_NETO,
                   det.POSICION
            FROM DOCTOS_VE_DET det
            WHERE det.DOCTO_VE_ID IN (
                SELECT dv.DOCTO_VE_ID FROM DOCTOS_VE dv WHERE dv.FECHA >= ?
            )
        """,
        'params': [CUTOFF_DATE],
    },
    'CLIENTES': {
        'sql': """
            SELECT c.CLIENTE_ID, c.NOMBRE, c.NOMBRE_COMERCIAL,
                   c.RFC, c.CONDICION_PAGO_ID
            FROM CLIENTES c
        """,
        'params': [],
    },
    'VENDEDORES': {
        'sql': "SELECT v.VENDEDOR_ID, v.NOMBRE FROM VENDEDORES v",
        'params': [],
    },
    'ARTICULOS': {
        'sql': "SELECT a.ARTICULO_ID, a.NOMBRE, a.CLAVE FROM ARTICULOS a",
        'params': [],
    },
    'IMPORTES_DOCTOS_CC': {
        'sql': """
            SELECT i.IMPORTE_DOCTO_CC_ID, i.DOCTO_CC_ID, i.CLIENTE_ID,
                   i.TIPO_MOVTO, i.FECHA, i.DOCTO_CC_ACR_ID,
                   COALESCE(i.IMPORTE_NETO,     0.0) AS IMPORTE_NETO,
                   COALESCE(i.IMPORTE_NETO_IVA, 0.0) AS IMPORTE_NETO_IVA,
                   i.FOLIO, i.REFERENCIA
            FROM IMPORTES_DOCTOS_CC i
            WHERE i.FECHA >= ?
        """,
        'params': [CUTOFF_DATE],
    },
    'DOCTOS_CC': {
        'sql': """
            SELECT dc.DOCTO_CC_ID, dc.FOLIO, dc.FECHA,
                   dc.CLIENTE_ID, dc.CONDICION_PAGO_ID,
                   COALESCE(dc.IMPORTE_NETO, 0.0) AS IMPORTE_NETO,
                   dc.ESTATUS, dc.APLICADO
            FROM DOCTOS_CC dc
            WHERE dc.FECHA >= ?
        """,
        'params': [CUTOFF_DATE],
    },
    'CONDICIONES_PAGO': {
        'sql': """
            SELECT cp.CONDICION_PAGO_ID, cp.NOMBRE,
                   COALESCE(cp.DIAS_CREDITO, 0) AS DIAS_CREDITO
            FROM CONDICIONES_PAGO cp
        """,
        'params': [],
    },
    'CONFIGURACIONES_GEN': {
        'sql': """
            SELECT FIRST 1
                   COALESCE(META_DIARIA_POR_VENDEDOR, 0.0) AS META_DIARIA_POR_VENDEDOR,
                   COALESCE(META_IDEAL_POR_VENDEDOR,  0.0) AS META_IDEAL_POR_VENDEDOR
            FROM CONFIGURACIONES_GEN
        """,
        'params': [],
    },
}

# ── Funciones ───────────────────────────────────────────────────────────────

def fetch_table(fb_conn, name, sql, params):
    log.info(f'  Leyendo {name}...')
    t0 = time.time()
    cur = fb_conn.cursor()
    try:
        cur.execute(sql.strip(), params)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    finally:
        cur.close()
    log.info(f'    → {len(rows):,} filas en {time.time()-t0:.1f}s')
    return cols, rows


def build_duckdb(fb_conn, out_path):
    import duckdb
    log.info(f'Fecha de corte: {CUTOFF_DATE} (últimos {YEARS_BACK} años)')

    tmp_path = out_path + '.building'
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    duck = duckdb.connect(tmp_path)
    duck.execute('PRAGMA threads=4')

    total_rows = 0
    for name, cfg in TABLES.items():
        cols, rows = fetch_table(fb_conn, name, cfg['sql'], cfg['params'])
        total_rows += len(rows)

        duck.execute(f'DROP TABLE IF EXISTS "{name}"')
        if rows:
            # Let DuckDB infer schema from data
            col_list = ', '.join([f'"{c}"' for c in cols])
            placeholders = ', '.join(['?' for _ in cols])
            # Insert in batches of 5000 to avoid memory spikes
            batch_size = 5000
            for i in range(0, len(rows), batch_size):
                duck.executemany(
                    f'INSERT INTO "{name}" ({col_list}) VALUES ({placeholders})',
                    rows[i:i+batch_size]
                )
        else:
            log.warning(f'  {name}: 0 filas — tabla vacía')

    # Metadata
    duck.execute("""
        CREATE OR REPLACE TABLE _snapshot_meta (
            created_at  TIMESTAMP,
            cutoff_date VARCHAR,
            total_rows  BIGINT,
            version     INTEGER
        )
    """)
    duck.execute(
        'INSERT INTO _snapshot_meta VALUES (CURRENT_TIMESTAMP, ?, ?, 1)',
        [CUTOFF_DATE, total_rows]
    )

    # Índices para acelerar queries del dashboard
    try:
        duck.execute('CREATE INDEX idx_ve_fecha  ON "DOCTOS_VE"("FECHA")')
        duck.execute('CREATE INDEX idx_ve_tipo   ON "DOCTOS_VE"("TIPO_DOCTO", "FECHA")')
        duck.execute('CREATE INDEX idx_ve_id     ON "DOCTOS_VE"("DOCTO_VE_ID")')
        duck.execute('CREATE INDEX idx_pv_fecha  ON "DOCTOS_PV"("FECHA")')
        duck.execute('CREATE INDEX idx_icc_fecha ON "IMPORTES_DOCTOS_CC"("FECHA")')
        duck.execute('CREATE INDEX idx_icc_cli   ON "IMPORTES_DOCTOS_CC"("CLIENTE_ID")')
    except Exception as e:
        log.warning(f'Índices parciales: {e}')

    duck.close()

    # Mover al path final de forma atómica
    if os.path.exists(out_path):
        os.replace(tmp_path, out_path)
    else:
        os.rename(tmp_path, out_path)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log.info(f'DuckDB creado: {out_path} ({size_mb:.1f} MB, {total_rows:,} filas totales)')


def upload_snapshot(duck_path):
    import requests
    url = f'{RENDER_URL}/api/admin/snapshot/upload'
    log.info(f'Subiendo snapshot a {url} ...')
    t0 = time.time()
    size_mb = os.path.getsize(duck_path) / 1024 / 1024
    log.info(f'  Tamaño: {size_mb:.1f} MB')

    with open(duck_path, 'rb') as f:
        resp = requests.post(
            url,
            headers={
                'X-Snapshot-Token': SNAPSHOT_TOKEN,
                'Content-Type': 'application/octet-stream',
                'X-DB-Id': 'default',
            },
            data=f,
            timeout=300,   # 5 min máximo para el upload
        )

    elapsed = time.time() - t0
    if resp.ok:
        log.info(f'Upload exitoso en {elapsed:.1f}s: {resp.text[:200]}')
    else:
        log.error(f'Upload falló {resp.status_code}: {resp.text[:400]}')
        raise RuntimeError(f'Upload HTTP {resp.status_code}')


def main():
    log.info('=== Suminregio DuckDB Sync ===')
    log.info(f'Firebird: {FB_HOST}:{FB_PORT} / {FB_DB}')
    log.info(f'DuckDB output: {DUCK_OUT}')

    try:
        import fdb
    except ImportError:
        log.error('fdb no está instalado. Ejecuta: pip install fdb')
        sys.exit(1)
    try:
        import duckdb
    except ImportError:
        log.error('duckdb no está instalado. Ejecuta: pip install duckdb')
        sys.exit(1)
    try:
        import requests
    except ImportError:
        log.error('requests no está instalado. Ejecuta: pip install requests')
        sys.exit(1)

    t_start = time.time()
    fb_conn = fdb.connect(
        host=FB_HOST,
        port=FB_PORT,
        database=FB_DB,
        user=FB_USER,
        password=FB_PASS,
        charset=FB_CHARSET,
    )
    # Snapshot de lectura — no afecta transacciones activas de Microsip
    fb_conn.begin()

    try:
        build_duckdb(fb_conn, DUCK_OUT)
        upload_snapshot(DUCK_OUT)
        elapsed = time.time() - t_start
        log.info(f'✅ Sync completado en {elapsed:.0f}s')
    except Exception as e:
        log.error(f'❌ Error en sync: {e}')
        sys.exit(1)
    finally:
        try:
            fb_conn.close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
