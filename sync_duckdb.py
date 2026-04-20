#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_duckdb.py - Suminregio Parker: Firebird -> DuckDB Nightly Sync
====================================================================
Corre en el servidor Windows donde vive Firebird (conexion LOCAL, sin WAN).
Actualiza el snapshot una vez por noche via Windows Task Scheduler.

RUTA CORRECTA en este servidor: C:\\Microsip datos\\  (con espacio)

INSTALAR dependencias (una sola vez):
    pip install fdb duckdb requests

VARIABLES DE ENTORNO (o dejar los defaults de abajo):
    FB_DATABASE  = C:\\Microsip datos\\SUMINREGIO-PARKER.FDB
    FB_PASSWORD  = masterkey
    RENDER_URL   = https://suminregioparker-todoslosnegocios.onrender.com
    SNAPSHOT_TOKEN = suminregio-snap-2026
    DUCK_OUT     = C:\\Microsip datos\\snapshot.duckdb

EJECUTAR manualmente:
    python "C:\\Microsip datos\\sync_duckdb.py"
"""

import os
import sys
import time
import logging
import decimal
import datetime as dt
from datetime import datetime, timedelta

# ── Configuracion ────────────────────────────────────────────────────────────
FB_HOST    = os.environ.get('FB_HOST',     'localhost')
FB_DB      = os.environ.get('FB_DATABASE', r'C:\Microsip datos\SUMINREGIO-PARKER.FDB')
FB_USER    = os.environ.get('FB_USER',     'SYSDBA')
FB_PASS    = os.environ.get('FB_PASSWORD', 'masterkey')
FB_PORT    = int(os.environ.get('FB_PORT', '3050'))
FB_CHARSET = os.environ.get('FB_CHARSET',  'WIN1252')

RENDER_URL     = os.environ.get('RENDER_URL',      'https://suminregioparker-todoslosnegocios.onrender.com')
SNAPSHOT_TOKEN = os.environ.get('SNAPSHOT_TOKEN',  'suminregio-snap-2026')
DUCK_OUT       = os.environ.get('DUCK_OUT',        r'C:\Microsip datos\snapshot.duckdb')

YEARS_BACK = 3  # anos de historia a sincronizar

# ── Logging ──────────────────────────────────────────────────────────────────
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

CUTOFF_DATE = (datetime.now() - timedelta(days=365 * YEARS_BACK)).strftime('%Y-%m-%d')

# ── Columnas requeridas por tabla (minimo que debe existir en el dashboard) ──
# El script descubrira TODAS las columnas disponibles en Firebird
# y seleccionara solo estas + cualquier otra no-BLOB que exista.
# Si alguna columna requerida no existe, se omite sin error.
REQUIRED_COLS = {
    'DOCTOS_VE':          ['DOCTO_VE_ID', 'FOLIO', 'FECHA', 'TIPO_DOCTO',
                           'CLIENTE_ID', 'VENDEDOR_ID', 'IMPORTE_NETO',
                           'ESTATUS', 'APLICADO'],
    'DOCTOS_PV':          ['DOCTO_PV_ID', 'FOLIO', 'FECHA', 'TIPO_DOCTO',
                           'CLIENTE_ID', 'VENDEDOR_ID', 'IMPORTE_NETO',
                           'ESTATUS', 'APLICADO'],
    'DOCTOS_VE_DET':      ['DOCTO_VE_DET_ID', 'DOCTO_VE_ID', 'ARTICULO_ID',
                           'UNIDADES', 'PRECIO_UNITARIO', 'PCTJE_DSCTO',
                           'PRECIO_TOTAL_NETO', 'POSICION'],
    'CLIENTES':           ['CLIENTE_ID', 'NOMBRE', 'CONDICION_PAGO_ID'],
    'VENDEDORES':         ['VENDEDOR_ID', 'NOMBRE'],
    'ARTICULOS':          ['ARTICULO_ID', 'NOMBRE', 'CLAVE'],
    'IMPORTES_DOCTOS_CC': ['IMPORTE_DOCTO_CC_ID', 'DOCTO_CC_ID', 'CLIENTE_ID',
                           'TIPO_MOVTO', 'FECHA', 'IMPORTE_NETO', 'FOLIO'],
    'DOCTOS_CC':          ['DOCTO_CC_ID', 'FOLIO', 'FECHA', 'CLIENTE_ID',
                           'IMPORTE_NETO', 'ESTATUS', 'APLICADO'],
    'CONDICIONES_PAGO':   ['CONDICION_PAGO_ID', 'NOMBRE'],
    'CONFIGURACIONES_GEN':[], # columnas custom - se descubren solas
}

# Columnas de fecha para aplicar filtro CUTOFF por tabla
DATE_FILTER_COL = {
    'DOCTOS_VE':          'FECHA',
    'DOCTOS_PV':          'FECHA',
    'DOCTOS_VE_DET':      None,  # filtrada via subquery de DOCTOS_VE
    'IMPORTES_DOCTOS_CC': 'FECHA',
    'DOCTOS_CC':          'FECHA',
}

# ── Funciones utiles ─────────────────────────────────────────────────────────

def get_table_columns(fb_conn, table_name):
    """
    Devuelve lista de columnas no-BLOB disponibles en la tabla.
    RDB$FIELD_TYPE = 261 es BLOB en Firebird.
    """
    cur = fb_conn.cursor()
    try:
        cur.execute("""
            SELECT TRIM(rf.RDB$FIELD_NAME)
            FROM RDB$RELATION_FIELDS rf
            JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
            WHERE TRIM(rf.RDB$RELATION_NAME) = ?
              AND f.RDB$FIELD_TYPE <> 261
            ORDER BY rf.RDB$FIELD_POSITION
        """, [table_name.strip()])
        return [r[0].strip() for r in cur.fetchall()]
    finally:
        cur.close()


def build_select(table_name, available_cols, required_cols):
    """
    Construye el SELECT usando solo columnas que existen en Firebird.
    Prioriza las requeridas; incluye todas las disponibles.
    """
    avail_set = set(available_cols)
    # Incluir todas las columnas disponibles (el dashboard puede usar cualquiera)
    # Ordenar: requeridas primero, luego el resto
    req = [c for c in required_cols if c in avail_set]
    rest = [c for c in available_cols if c not in set(required_cols)]
    final_cols = req + rest
    if not final_cols:
        final_cols = available_cols  # fallback: todas

    col_exprs = []
    for c in final_cols:
        # Envolver numericos conocidos en COALESCE para evitar NULLs
        if c in ('IMPORTE_NETO', 'IMPORTE_NETO_IVA', 'PRECIO_UNITARIO',
                 'PCTJE_DSCTO', 'PRECIO_TOTAL_NETO', 'UNIDADES',
                 'DIAS_CREDITO', 'DIAS_PPAG', 'META_DIARIA_POR_VENDEDOR',
                 'META_IDEAL_POR_VENDEDOR'):
            col_exprs.append(f'COALESCE({c}, 0) AS {c}')
        else:
            col_exprs.append(c)

    return final_cols, col_exprs


def fetch_table(fb_conn, table_name):
    """
    Auto-descubre columnas de Firebird y hace el SELECT de forma segura.
    Aplica filtro de fecha si corresponde.
    """
    log.info(f'  Leyendo {table_name}...')
    t0 = time.time()

    # 1. Descubrir columnas disponibles
    available = get_table_columns(fb_conn, table_name)
    if not available:
        log.warning(f'  {table_name}: no se encontraron columnas (tabla inexistente?)')
        return [], []

    required = REQUIRED_COLS.get(table_name, [])
    final_cols, col_exprs = build_select(table_name, available, required)

    # 2. Construir WHERE
    date_col = DATE_FILTER_COL.get(table_name)
    where = ''
    params = []

    if table_name == 'DOCTOS_VE_DET' and 'DOCTO_VE_ID' in set(available):
        where = f"""WHERE DOCTO_VE_ID IN (
            SELECT DOCTO_VE_ID FROM DOCTOS_VE WHERE FECHA >= '{CUTOFF_DATE}'
        )"""
    elif date_col and date_col in set(available):
        where = f"WHERE {date_col} >= ?"
        params = [CUTOFF_DATE]

    # 3. Ejecutar
    limit = 'FIRST 1 ' if table_name == 'CONFIGURACIONES_GEN' else ''
    sql = f"SELECT {limit}{', '.join(col_exprs)} FROM {table_name} {where}".strip()

    cur = fb_conn.cursor()
    try:
        cur.execute(sql, params)
        rows = cur.fetchall()
        actual_cols = [d[0] for d in cur.description]
    finally:
        cur.close()

    log.info(f'    -> {len(rows):,} filas, {len(actual_cols)} columnas en {time.time()-t0:.1f}s')
    return actual_cols, rows


# ── DuckDB helpers ────────────────────────────────────────────────────────────

def _duck_type(val):
    if val is None:         return 'VARCHAR'
    if isinstance(val, bool): return 'BOOLEAN'
    if isinstance(val, int):  return 'BIGINT'
    if isinstance(val, (float, decimal.Decimal)): return 'DOUBLE'
    if isinstance(val, datetime): return 'TIMESTAMP'
    if isinstance(val, dt.date):  return 'DATE'
    if isinstance(val, dt.time):  return 'TIME'
    return 'VARCHAR'

def _infer_types(cols, rows):
    types = ['VARCHAR'] * len(cols)
    found = [False] * len(cols)
    for row in rows:
        for i, val in enumerate(row):
            if not found[i] and val is not None:
                types[i] = _duck_type(val)
                found[i] = True
        if all(found):
            break
    return types

def _clean_row(row):
    return tuple(float(v) if isinstance(v, decimal.Decimal) else v for v in row)


def build_duckdb(fb_conn, out_path):
    import duckdb
    log.info(f'Fecha de corte: {CUTOFF_DATE} (ultimos {YEARS_BACK} anos)')

    tmp_path = out_path + '.building'
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    duck = duckdb.connect(tmp_path)
    duck.execute('PRAGMA threads=4')

    total_rows = 0
    tables_done = []

    for table_name in REQUIRED_COLS.keys():
        try:
            cols, rows = fetch_table(fb_conn, table_name)
            if not cols:
                continue
            total_rows += len(rows)

            duck.execute(f'DROP TABLE IF EXISTS "{table_name}"')

            if rows:
                col_types = _infer_types(cols, rows)
                col_defs  = ', '.join([f'"{c}" {t}' for c, t in zip(cols, col_types)])
                duck.execute(f'CREATE TABLE "{table_name}" ({col_defs})')

                col_list     = ', '.join([f'"{c}"' for c in cols])
                placeholders = ', '.join(['?' for _ in cols])
                batch_size   = 5000
                for i in range(0, len(rows), batch_size):
                    clean = [_clean_row(r) for r in rows[i:i+batch_size]]
                    duck.executemany(
                        f'INSERT INTO "{table_name}" ({col_list}) VALUES ({placeholders})',
                        clean
                    )
                tables_done.append(table_name)
            else:
                # Crear tabla vacia con esquema descubierto
                avail = get_table_columns(fb_conn, table_name)
                if avail:
                    col_defs = ', '.join([f'"{c}" VARCHAR' for c in avail[:20]])
                    duck.execute(f'CREATE TABLE IF NOT EXISTS "{table_name}" ({col_defs})')
                log.warning(f'  {table_name}: 0 filas')

        except Exception as e:
            log.warning(f'  {table_name}: omitida por error -> {e}')
            continue

    # Metadata
    duck.execute("""
        CREATE OR REPLACE TABLE _snapshot_meta (
            created_at   TIMESTAMP,
            cutoff_date  VARCHAR,
            total_rows   BIGINT,
            tables_synced VARCHAR,
            version      INTEGER
        )
    """)
    duck.execute(
        'INSERT INTO _snapshot_meta VALUES (CURRENT_TIMESTAMP, ?, ?, ?, 2)',
        [CUTOFF_DATE, total_rows, ','.join(tables_done)]
    )

    # Indices para acelerar queries del dashboard
    try:
        duck.execute('CREATE INDEX idx_ve_fecha ON "DOCTOS_VE"("FECHA")')
        duck.execute('CREATE INDEX idx_ve_tipo  ON "DOCTOS_VE"("TIPO_DOCTO", "FECHA")')
        duck.execute('CREATE INDEX idx_ve_id    ON "DOCTOS_VE"("DOCTO_VE_ID")')
        duck.execute('CREATE INDEX idx_pv_fecha ON "DOCTOS_PV"("FECHA")')
        duck.execute('CREATE INDEX idx_icc_fecha ON "IMPORTES_DOCTOS_CC"("FECHA")')
        duck.execute('CREATE INDEX idx_icc_cli  ON "IMPORTES_DOCTOS_CC"("CLIENTE_ID")')
    except Exception as e:
        log.warning(f'Indices parciales: {e}')

    duck.close()

    # Renombrar atomicamente
    if os.path.exists(out_path):
        os.replace(tmp_path, out_path)
    else:
        os.rename(tmp_path, out_path)

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log.info(f'DuckDB creado: {out_path} ({size_mb:.1f} MB, {total_rows:,} filas, tablas: {tables_done})')


def upload_snapshot(duck_path):
    import requests
    url = f'{RENDER_URL}/api/admin/snapshot/upload'
    log.info(f'Subiendo snapshot a {url} ...')
    t0 = time.time()
    size_mb = os.path.getsize(duck_path) / 1024 / 1024
    log.info(f'  Tamano: {size_mb:.1f} MB')

    with open(duck_path, 'rb') as f:
        resp = requests.post(
            url,
            headers={
                'X-Snapshot-Token': SNAPSHOT_TOKEN,
                'Content-Type': 'application/octet-stream',
                'X-DB-Id': 'default',
            },
            data=f,
            timeout=300,
        )

    elapsed = time.time() - t0
    if resp.ok:
        log.info(f'Upload exitoso en {elapsed:.1f}s: {resp.text[:200]}')
    else:
        log.error(f'Upload fallo {resp.status_code}: {resp.text[:400]}')
        raise RuntimeError(f'Upload HTTP {resp.status_code}')


def main():
    log.info('=== Suminregio DuckDB Sync ===')
    log.info(f'Firebird: {FB_HOST}:{FB_PORT} / {FB_DB}')
    log.info(f'DuckDB output: {DUCK_OUT}')

    for lib in [('fdb', 'pip install fdb'),
                ('duckdb', 'pip install duckdb'),
                ('requests', 'pip install requests')]:
        try:
            __import__(lib[0])
        except ImportError:
            log.error(f'{lib[0]} no instalado. Ejecuta: {lib[1]}')
            sys.exit(1)

    import fdb
    t_start = time.time()
    log.info('Conectando a Firebird...')
    fb_conn = fdb.connect(
        host=FB_HOST, port=FB_PORT, database=FB_DB,
        user=FB_USER, password=FB_PASS, charset=FB_CHARSET,
    )
    fb_conn.begin()
    log.info('Conexion OK')

    try:
        build_duckdb(fb_conn, DUCK_OUT)
        upload_snapshot(DUCK_OUT)
        elapsed = time.time() - t_start
        log.info(f'Sync completado en {elapsed:.0f}s')
    except Exception as e:
        log.error(f'Error en sync: {e}')
        sys.exit(1)
    finally:
        try:
            fb_conn.close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
