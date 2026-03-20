# -*- coding: utf-8 -*-
"""
Base de datos SQLite - Sistema de Cotización y Gestión para Servicio Técnico.
100% gratuito, sin servidor, archivo local.
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cotizacion.db")


def get_connection():
    """Obtiene conexión a SQLite."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # acceso por nombre de columna
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Crea todas las tablas si no existen."""
    conn = get_connection()
    cur = conn.cursor()

    # Catálogo de Clientes
    cur.execute("""
        CREATE TABLE IF NOT EXISTS clientes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT UNIQUE,
            nombre TEXT NOT NULL,
            rfc TEXT,
            direccion TEXT,
            telefono TEXT,
            email TEXT,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Catálogo de Refacciones
    cur.execute("""
        CREATE TABLE IF NOT EXISTS refacciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo TEXT UNIQUE NOT NULL,
            descripcion TEXT NOT NULL,
            precio_unitario REAL NOT NULL DEFAULT 0,
            unidad TEXT DEFAULT 'PZA',
            activo INTEGER DEFAULT 1,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Catálogo de Máquinas (vinculadas a cliente)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS maquinas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cliente_id INTEGER NOT NULL REFERENCES clientes(id),
            codigo TEXT,
            nombre TEXT NOT NULL,
            modelo TEXT,
            ubicacion TEXT,
            activo INTEGER DEFAULT 1,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Cotizaciones (cabecera) - tipo: 'refacciones' | 'mano_obra'
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cotizaciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folio TEXT UNIQUE,
            cliente_id INTEGER NOT NULL REFERENCES clientes(id),
            tipo TEXT NOT NULL CHECK(tipo IN ('refacciones','mano_obra')),
            fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
            vigencia_dias INTEGER DEFAULT 30,
            observaciones TEXT,
            subtotal REAL DEFAULT 0,
            iva REAL DEFAULT 0,
            total REAL DEFAULT 0,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Líneas de cotización (refacciones o mano de obra)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS cotizacion_lineas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
            refaccion_id INTEGER REFERENCES refacciones(id),
            descripcion TEXT,
            cantidad REAL NOT NULL DEFAULT 1,
            precio_unitario REAL NOT NULL DEFAULT 0,
            subtotal REAL DEFAULT 0,
            iva REAL DEFAULT 0,
            total REAL DEFAULT 0,
            orden INTEGER DEFAULT 0
        )
    """)

    # Incidentes (asociados a cliente + máquina)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS incidentes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folio TEXT,
            cliente_id INTEGER NOT NULL REFERENCES clientes(id),
            maquina_id INTEGER REFERENCES maquinas(id),
            descripcion TEXT NOT NULL,
            prioridad TEXT CHECK(prioridad IN ('baja','media','alta','critica')),
            fecha_reporte TEXT NOT NULL DEFAULT (date('now','localtime')),
            tecnico_responsable TEXT,
            estatus TEXT DEFAULT 'abierto' CHECK(estatus IN ('abierto','en_proceso','cerrado','cancelado')),
            cerrado_en TEXT,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Bitácora de trabajo (vinculada a incidente o cotización)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bitacoras (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            incidente_id INTEGER REFERENCES incidentes(id),
            cotizacion_id INTEGER REFERENCES cotizaciones(id),
            fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
            tecnico TEXT,
            actividades TEXT,
            tiempo_horas REAL DEFAULT 0,
            materiales_usados TEXT,
            observaciones TEXT,
            creado_en TEXT DEFAULT (datetime('now','localtime')),
            CHECK((incidente_id IS NOT NULL) OR (cotizacion_id IS NOT NULL))
        )
    """)

    # Plan de mantenimiento por máquina (preventivo)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mantenimiento_plan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            maquina_id INTEGER NOT NULL REFERENCES maquinas(id) ON DELETE CASCADE,
            tipo TEXT NOT NULL CHECK(tipo IN ('diario','semanal','mensual','anual')),
            descripcion TEXT,
            dias_frecuencia INTEGER,
            ultima_fecha TEXT,
            proxima_fecha TEXT,
            activo INTEGER DEFAULT 1,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Checklist de actividades por tipo de mantenimiento
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mantenimiento_checklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER REFERENCES mantenimiento_plan(id) ON DELETE CASCADE,
            maquina_id INTEGER REFERENCES maquinas(id) ON DELETE CASCADE,
            actividad TEXT NOT NULL,
            orden INTEGER DEFAULT 0,
            obligatorio INTEGER DEFAULT 1
        )
    """)

    # Registro de mantenimientos realizados (preventivo o correctivo)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mantenimientos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            maquina_id INTEGER NOT NULL REFERENCES maquinas(id),
            tipo TEXT NOT NULL CHECK(tipo IN ('preventivo','correctivo')),
            plan_id INTEGER REFERENCES mantenimiento_plan(id),
            fecha_programada TEXT,
            fecha_inicio TEXT,
            fecha_fin TEXT,
            descripcion_falla TEXT,
            causa_raiz TEXT,
            accion_tomada TEXT,
            tecnico TEXT,
            horas_invertidas REAL DEFAULT 0,
            costo_refacciones REAL DEFAULT 0,
            costo_total REAL DEFAULT 0,
            observaciones TEXT,
            creado_en TEXT DEFAULT (datetime('now','localtime'))
        )
    """)

    # Refacciones usadas en un mantenimiento
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mantenimiento_refacciones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mantenimiento_id INTEGER NOT NULL REFERENCES mantenimientos(id) ON DELETE CASCADE,
            refaccion_id INTEGER NOT NULL REFERENCES refacciones(id),
            cantidad REAL NOT NULL DEFAULT 1,
            precio_unitario REAL NOT NULL,
            subtotal REAL
        )
    """)

    # Técnicos (catálogo simple para autocompletado)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS tecnicos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT UNIQUE NOT NULL,
            activo INTEGER DEFAULT 1
        )
    """)

    # Índices para búsquedas rápidas
    cur.execute("CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_clientes_codigo ON clientes(codigo)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_refacciones_codigo ON refacciones(codigo)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_refacciones_descripcion ON refacciones(descripcion)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_maquinas_cliente ON maquinas(cliente_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_cotizaciones_cliente ON cotizaciones(cliente_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_incidentes_cliente ON incidentes(cliente_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mantenimientos_maquina ON mantenimientos(maquina_id)")

    conn.commit()
    conn.close()


def generar_folio(prefijo="COT"):
    """Genera folio único para cotizaciones."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT COUNT(*) FROM cotizaciones WHERE fecha = date('now','localtime')"
    )
    n = cur.fetchone()[0] + 1
    from datetime import datetime
    folio = f"{prefijo}-{datetime.now().strftime('%Y%m%d')}-{n:04d}"
    conn.close()
    return folio
