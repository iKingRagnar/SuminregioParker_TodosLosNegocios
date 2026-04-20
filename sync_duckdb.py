#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_duckdb.py - Suminregio: Firebird -> DuckDB Nightly Sync (TODAS LAS BASES)
===============================================================================
Sincroniza TODAS las bases de datos del grupo en paralelo.
Cada base genera su propio snapshot y lo sube a Render.
Render mantiene un snapshot por empresa -> 0 conexiones Firebird durante el dia.

INSTALAR (una sola vez):
    pip install fdb duckdb requests

EJECUTAR manualmente:
    python "C:\\Microsip datos\\sync_duckdb.py"

VARIABLES DE ENTORNO (opcionales, ya tienen defaults correctos):
    FB_HOST          = localhost
    FB_USER          = SYSDBA
    FB_PASSWORD      = masterkey
    RENDER_URL       = https://suminregioparker-todoslosnegocios.onrender.com
    SNAPSHOT_TOKEN   = suminregio-snap-2026
    DUCK_DIR         = C:\\Microsip datos\\snapshots
    SYNC_WORKERS     = 4   (cuantas bases en paralelo)
    SYNC_DB_IDS      = default,suminregio_maderas,...  (dejar vacio = todas)
"""

import os
import sys
import time
import logging
import decimal
import datetime as dt
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Configuracion global ─────────────────────────────────────────────────────
FB_HOST    = os.environ.get('FB_HOST',     'localhost')
FB_USER    = os.environ.get('FB_USER',     'SYSDBA')
FB_PASS    = os.environ.get('FB_PASSWORD', 'masterkey')
FB_PORT    = int(os.environ.get('FB_PORT', '3050'))
FB_CHARSET = os.environ.get('FB_CHARSET',  'WIN1252')

RENDER_URL     = os.environ.get('RENDER_URL',     'https://suminregioparker-todoslosnegocios.onrender.com')
SNAPSHOT_TOKEN = os.environ.get('SNAPSHOT_TOKEN', 'suminregio-snap-2026')
DUCK_DIR       = os.environ.get('DUCK_DIR',       r'C:\Microsip datos\snapshots')
SYNC_WORKERS   = int(os.environ.get('SYNC_WORKERS', '4'))
YEARS_BACK     = 3

# ── Catalogo de TODAS las bases del grupo ─────────────────────────────────────
# id: debe coincidir con el id en fb-databases.registry.json del servidor
# Comentar las que NO quieras sincronizar
ALL_DATABASES = [
    {'id': 'default',                        'path': r'C:\Microsip datos\SUMINREGIO-PARKER.FDB'},
    {'id': 'suminregio_maderas',             'path': r'C:\Microsip datos\SUMINREGIO MADERAS.FDB'},
    {'id': 'suminregio_reciclaje',           'path': r'C:\Microsip datos\SUMINREGIO RECICLAJE.FDB'},
    {'id': 'suminregio_suministros_medicos', 'path': r'C:\Microsip datos\SUMINREGIO SUMINISTROS MEDICOS.FDB'},
    {'id': 'suminregio_agua',                'path': r'C:\Microsip datos\SUMINREGIO AGUA.FDB'},
    {'id': 'suminregio_carton',              'path': r'C:\Microsip datos\SUMINREGIO CARTON.FDB'},
    {'id': 'suminregio_empaque',             'path': r'C:\Microsip datos\SUMINREGIO EMPAQUE.FDB'},
    {'id': 'suminregio_especial',            'path': r'C:\Microsip datos\SUMINREGIO ESPECIAL.FDB'},
    {'id': 'grupo_suminregio',               'path': r'C:\Microsip datos\GRUPO SUMINREGIO.FDB'},
    {'id': 'parker_mfg',                     'path': r'C:\Microsip datos\PARKER-MFG.FDB'},
    {'id': 'hamer_empaques',                 'path': r'C:\Microsip datos\HAMER EMPAQUES.FDB'},
    {'id': 'lagor',                          'path': r'C:\Microsip datos\LAGOR.FDB'},
    {'id': 'mafra',                          'path': r'C:\Microsip datos\MAFRA.FDB'},
    {'id': 'nortex',                         'path': r'C:\Microsip datos\NORTEX.FDB'},
    {'id': 'paso',                           'path': r'C:\Microsip datos\PASO.FDB'},
    {'id': 'sp_paso',                        'path': r'C:\Microsip datos\SP PASO.FDB'},
    {'id': 'roberto_gzz',                    'path': r'C:\Microsip datos\ROBERTO GZZ.FDB'},
    {'id': 'robin',                          'path': r'C:\Microsip datos\ROBIN.FDB'},
    {'id': 'empresa',                        'path': r'C:\Microsip datos\EMPRESA.FDB'},
    {'id': 'elige',                          'path': r'C:\Microsip datos\ELIGE.FDB'},
]

# Filtrar por SYNC_DB_IDS si esta definido
_env_ids = [x.strip() for x in os.environ.get('SYNC_DB_IDS', '').split(',') if x.strip()]
DATABASES = [d for d in ALL_DATABASES if not _env_ids or d['id'] in _env_ids]

CUTOFF_DATE = (datetime.now() - timedelta(days=365 * YEARS_BACK)).strftime('%Y-%m-%d')

# ── Logging ──────────────────────────────────────────────────────────────────
os.makedirs(DUCK_DIR, exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s [%(name)s] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(DUCK_DIR, 'sync_duckdb.log'), encoding='utf-8'),
    ]
)

# ── Columnas minimas requeridas por tabla ─────────────────────────────────────
REQUIRED_COLS = {
    'DOCTOS_VE':          ['DOCTO_VE_ID','FOLIO','FECHA','TIPO_DOCTO',
                           'CLIENTE_ID','VENDEDOR_ID','IMPORTE_NETO','ESTATUS','APLICADO'],
    'DOCTOS_PV':          ['DOCTO_PV_ID','FOLIO','FECHA','TIPO_DOCTO',
                           'CLIENTE_ID','VENDEDOR_ID','IMPORTE_NETO','ESTATUS','APLICADO'],
    'DOCTOS_VE_DET':      ['DOCTO_VE_DET_ID','DOCTO_VE_ID','ARTICULO_ID',
                           'UNIDADES','PRECIO_UNITARIO','PRECIO_TOTAL_NETO','POSICION'],
    'CLIENTES':           ['CLIENTE_ID','NOMBRE','CONDICION_PAGO_ID'],
    'VENDEDORES':         ['VENDEDOR_ID','NOMBRE'],
    'ARTICULOS':          ['ARTICULO_ID','NOMBRE','CLAVE'],
    'IMPORTES_DOCTOS_CC': ['FECHA','IMPORTE_NETO'],
    'DOCTOS_CC':          ['DOCTO_CC_ID','FOLIO','FECHA','CLIENTE_ID','IMPORTE_NETO','ESTATUS'],
    'CONDICIONES_PAGO':   ['CONDICION_PAGO_ID','NOMBRE'],
    'CONFIGURACIONES_GEN':[],
}

NUMERIC_COLS = {
    'IMPORTE_NETO','IMPORTE_NETO_IVA','PRECIO_UNITARIO','PCTJE_DSCTO',
    'PRECIO_TOTAL_NETO','UNIDADES','DIAS_CREDITO','DIAS_PPAG',
    'META_DIARIA_POR_VENDEDOR','META_IDEAL_POR_VENDEDOR',
}

DATE_FILTER = {
    'DOCTOS_VE': 'FECHA', 'DOCTOS_PV': 'FECHA',
    'IMPORTES_DOCTOS_CC': 'FECHA', 'DOCTOS_CC': 'FECHA',
}

# ── Helpers Firebird ──────────────────────────────────────────────────────────

def get_columns(fb_conn, table):
    """Columnas no-BLOB disponibles en la tabla (via catalogo Firebird)."""
    cur = fb_conn.cursor()
    try:
        cur.execute("""
            SELECT TRIM(rf.RDB$FIELD_NAME)
            FROM RDB$RELATION_FIELDS rf
            JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE
            WHERE TRIM(rf.RDB$RELATION_NAME) = ?
              AND f.RDB$FIELD_TYPE <> 261
            ORDER BY rf.RDB$FIELD_POSITION
        """, [table.strip()])
        return [r[0].strip() for r in cur.fetchall()]
    finally:
        cur.close()


def fetch_table(fb_conn, table, log):
    log.info(f'  Leyendo {table}...')
    t0 = time.time()

    available = get_columns(fb_conn, table)
    if not available:
        log.warning(f'  {table}: no existe en esta base')
        return [], []

    avail_set  = set(available)
    required   = [c for c in REQUIRED_COLS.get(table, []) if c in avail_set]
    extra      = [c for c in available if c not in set(REQUIRED_COLS.get(table, []))]
    final_cols = required + extra

    col_exprs = []
    for c in final_cols:
        if c in NUMERIC_COLS:
            col_exprs.append(f'COALESCE({c}, 0) AS {c}')
        else:
            col_exprs.append(c)

    # WHERE clause
    date_col = DATE_FILTER.get(table)
    where, params = '', []
    if table == 'DOCTOS_VE_DET' and 'DOCTO_VE_ID' in avail_set:
        where = f"WHERE DOCTO_VE_ID IN (SELECT DOCTO_VE_ID FROM DOCTOS_VE WHERE FECHA >= '{CUTOFF_DATE}')"
    elif date_col and date_col in avail_set:
        where = f'WHERE {date_col} >= ?'
        params = [CUTOFF_DATE]

    limit = 'FIRST 1 ' if table == 'CONFIGURACIONES_GEN' else ''
    sql   = f"SELECT {limit}{', '.join(col_exprs)} FROM {table} {where}".strip()

    cur = fb_conn.cursor()
    try:
        cur.execute(sql, params)
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
    finally:
        cur.close()

    log.info(f'    -> {len(rows):,} filas, {len(cols)} cols en {time.time()-t0:.1f}s')
    return cols, rows


# ── Helpers DuckDB ────────────────────────────────────────────────────────────

def _duck_type(val):
    if val is None:               return 'VARCHAR'
    if isinstance(val, bool):     return 'BOOLEAN'
    if isinstance(val, int):      return 'BIGINT'
    if isinstance(val, (float, decimal.Decimal)): return 'DOUBLE'
    if isinstance(val, datetime): return 'TIMESTAMP'
    if isinstance(val, dt.date):  return 'DATE'
    if isinstance(val, dt.time):  return 'TIME'
    return 'VARCHAR'

def _infer_types(cols, rows):
    types, found = ['VARCHAR'] * len(cols), [False] * len(cols)
    for row in rows:
        for i, v in enumerate(row):
            if not found[i] and v is not None:
                types[i] = _duck_type(v)
                found[i] = True
        if all(found): break
    return types

def _clean(row):
    return tuple(float(v) if isinstance(v, decimal.Decimal) else v for v in row)


# ── Sync de UNA base ──────────────────────────────────────────────────────────

def sync_one(db_entry):
    import fdb, duckdb, requests
    db_id   = db_entry['id']
    db_path = db_entry['path']
    log     = logging.getLogger(db_id)
    duck_out = os.path.join(DUCK_DIR, f'snapshot_{db_id}.duckdb')

    log.info(f'=== Iniciando: {db_id} -> {db_path}')
    t_start = time.time()

    # 1. Conectar Firebird
    try:
        fb = fdb.connect(host=FB_HOST, port=FB_PORT, database=db_path,
                         user=FB_USER, password=FB_PASS, charset=FB_CHARSET)
        fb.begin()
    except Exception as e:
        log.error(f'No se pudo conectar: {e}')
        return db_id, False, str(e)

    # 2. Construir DuckDB
    tmp = duck_out + '.building'
    if os.path.exists(tmp): os.remove(tmp)
    duck = duckdb.connect(tmp)
    duck.execute('PRAGMA threads=2')

    total_rows, tables_done = 0, []
    for table in REQUIRED_COLS:
        try:
            cols, rows = fetch_table(fb, table, log)
            if not cols: continue
            total_rows += len(rows)
            duck.execute(f'DROP TABLE IF EXISTS "{table}"')
            if rows:
                col_types = _infer_types(cols, rows)
                col_defs  = ', '.join([f'"{c}" {t}' for c,t in zip(cols, col_types)])
                duck.execute(f'CREATE TABLE "{table}" ({col_defs})')
                col_list = ', '.join([f'"{c}"' for c in cols])
                ph       = ', '.join(['?' for _ in cols])
                for i in range(0, len(rows), 5000):
                    duck.executemany(
                        f'INSERT INTO "{table}" ({col_list}) VALUES ({ph})',
                        [_clean(r) for r in rows[i:i+5000]]
                    )
                tables_done.append(table)
        except Exception as e:
            log.warning(f'  {table} omitida: {e}')

    # Metadata
    duck.execute("""CREATE OR REPLACE TABLE _snapshot_meta (
        created_at TIMESTAMP, cutoff_date VARCHAR,
        total_rows BIGINT, db_id VARCHAR, tables_synced VARCHAR, version INTEGER
    )""")
    duck.execute('INSERT INTO _snapshot_meta VALUES (CURRENT_TIMESTAMP,?,?,?,?,2)',
                 [CUTOFF_DATE, total_rows, db_id, ','.join(tables_done)])

    # Indices (best effort)
    for stmt in [
        'CREATE INDEX idx_ve_fecha ON "DOCTOS_VE"("FECHA")',
        'CREATE INDEX idx_ve_tipo  ON "DOCTOS_VE"("TIPO_DOCTO","FECHA")',
        'CREATE INDEX idx_pv_fecha ON "DOCTOS_PV"("FECHA")',
        'CREATE INDEX idx_icc_fecha ON "IMPORTES_DOCTOS_CC"("FECHA")',
    ]:
        try: duck.execute(stmt)
        except: pass

    duck.close()
    fb.close()

    if os.path.exists(duck_out): os.replace(tmp, duck_out)
    else: os.rename(tmp, duck_out)

    size_mb = os.path.getsize(duck_out) / 1024 / 1024
    log.info(f'DuckDB OK: {size_mb:.1f} MB, {total_rows:,} filas')

    # 3. Upload a Render
    try:
        url = f'{RENDER_URL}/api/admin/snapshot/upload'
        with open(duck_out, 'rb') as f:
            resp = requests.post(url, data=f, timeout=300, headers={
                'X-Snapshot-Token': SNAPSHOT_TOKEN,
                'X-DB-Id': db_id,
                'Content-Type': 'application/octet-stream',
            })
        if resp.ok:
            log.info(f'Upload OK en {time.time()-t_start:.0f}s: {resp.text[:120]}')
            return db_id, True, None
        else:
            msg = f'Upload HTTP {resp.status_code}: {resp.text[:200]}'
            log.error(msg)
            return db_id, False, msg
    except Exception as e:
        log.error(f'Upload error: {e}')
        return db_id, False, str(e)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    root = logging.getLogger('sync')
    root.info(f'=== Suminregio DuckDB Multi-Sync ===')
    root.info(f'Bases a sincronizar: {len(DATABASES)}')
    root.info(f'Workers en paralelo: {SYNC_WORKERS}')
    root.info(f'Carpeta snapshots:   {DUCK_DIR}')
    root.info(f'Fecha de corte:      {CUTOFF_DATE}')

    for lib in [('fdb','pip install fdb'),('duckdb','pip install duckdb'),('requests','pip install requests')]:
        try: __import__(lib[0])
        except ImportError:
            root.error(f'{lib[0]} no instalado. Ejecuta: {lib[1]}')
            sys.exit(1)

    os.makedirs(DUCK_DIR, exist_ok=True)

    t0 = time.time()
    ok, fail = [], []

    with ThreadPoolExecutor(max_workers=SYNC_WORKERS) as ex:
        futures = {ex.submit(sync_one, db): db['id'] for db in DATABASES}
        for fut in as_completed(futures):
            db_id, success, err = fut.result()
            if success: ok.append(db_id)
            else:       fail.append((db_id, err))

    elapsed = time.time() - t0
    root.info(f'')
    root.info(f'=== Resultado en {elapsed:.0f}s ===')
    root.info(f'OK    ({len(ok)}):   {ok}')
    if fail:
        root.warning(f'FAIL  ({len(fail)}): {[f[0] for f in fail]}')
        for db_id, err in fail:
            root.warning(f'  {db_id}: {err}')
    root.info(f'Sync completado.')

if __name__ == '__main__':
    main()
