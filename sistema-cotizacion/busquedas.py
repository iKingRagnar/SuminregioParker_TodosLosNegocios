# -*- coding: utf-8 -*-
"""Funciones de búsqueda para autocompletado (clientes, refacciones, máquinas)."""
from database import get_connection


def buscar_clientes(texto):
    """Retorna lista de (nombre a mostrar, dict con id, nombre, rfc, direccion, etc)."""
    if not texto or len(texto.strip()) < 1:
        return []
    conn = get_connection()
    cur = conn.cursor()
    t = f"%{texto.strip()}%"
    cur.execute(
        "SELECT id, codigo, nombre, rfc, direccion, telefono, email FROM clientes WHERE nombre LIKE ? OR codigo LIKE ? OR rfc LIKE ? ORDER BY nombre LIMIT 20",
        (t, t, t),
    )
    rows = cur.fetchall()
    conn.close()
    return [(r["nombre"] + (f" ({r['codigo']})" if r["codigo"] else ""), dict(r)) for r in rows]


def buscar_refacciones(texto):
    """Retorna lista de (codigo - descripcion, dict con id, codigo, descripcion, precio_unitario)."""
    if not texto or len(texto.strip()) < 1:
        return []
    conn = get_connection()
    cur = conn.cursor()
    t = f"%{texto.strip()}%"
    cur.execute(
        "SELECT id, codigo, descripcion, precio_unitario, unidad FROM refacciones WHERE activo=1 AND (codigo LIKE ? OR descripcion LIKE ?) ORDER BY codigo LIMIT 20",
        (t, t),
    )
    rows = cur.fetchall()
    conn.close()
    return [(f"{r['codigo']} - {r['descripcion']}", dict(r)) for r in rows]


def buscar_maquinas(texto, cliente_id=None):
    """Retorna lista de (nombre máquina, dict). Si cliente_id se filtra por cliente."""
    if not texto or len(texto.strip()) < 1:
        return []
    conn = get_connection()
    cur = conn.cursor()
    t = f"%{texto.strip()}%"
    if cliente_id:
        cur.execute(
            "SELECT id, codigo, nombre, modelo, ubicacion, cliente_id FROM maquinas WHERE activo=1 AND cliente_id=? AND (nombre LIKE ? OR codigo LIKE ?) ORDER BY nombre LIMIT 20",
            (cliente_id, t, t),
        )
    else:
        cur.execute(
            "SELECT id, codigo, nombre, modelo, ubicacion, cliente_id FROM maquinas WHERE activo=1 AND (nombre LIKE ? OR codigo LIKE ?) ORDER BY nombre LIMIT 20",
            (t, t),
        )
    rows = cur.fetchall()
    conn.close()
    return [(r["nombre"] + (f" ({r['codigo']})" if r["codigo"] else ""), dict(r)) for r in rows]


def buscar_tecnicos(texto):
    """Retorna lista de nombres de técnicos."""
    if not texto or len(texto.strip()) < 1:
        return []
    conn = get_connection()
    cur = conn.cursor()
    t = f"%{texto.strip()}%"
    cur.execute("SELECT nombre FROM tecnicos WHERE activo=1 AND nombre LIKE ? ORDER BY nombre LIMIT 15", (t,))
    rows = cur.fetchall()
    conn.close()
    return [(r["nombre"], {"nombre": r["nombre"]}) for r in rows]
