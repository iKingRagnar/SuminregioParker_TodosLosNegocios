#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el PDF del catálogo de Suministros Médicos a partir del ERP.

Toma EXACTAMENTE la misma data que el ERP (Microsip) a través del endpoint
ya desplegado:

    GET /api/inv/existencias-todas?db=<id>&desde_id=<cursor>&limit=500&almacen=1,2

El endpoint pagina por cursor (ARTICULO_ID). Este script recorre todas las
páginas, junta el inventario completo (clave, descripción, unidad, empaque,
existencia, mínimo, costo) y arma un PDF con tabla, encabezado repetido por
página y numeración.

Uso típico (con el endpoint desplegado y el egress activo):

    pip install reportlab
    python scripts/generar_catalogo_pdf.py \
        --base-url https://suminregioparker-todoslosnegocios.onrender.com \
        --db default \
        --out catalogo-suministros-medicos.pdf

Opciones útiles:
    --almacen 1,2        Filtra existencia a esos almacenes (default: todos)
    --solo-existencia    Incluye sólo artículos con existencia > 0
    --titulo "..."       Cambia el título de portada
    --demo               No llama a la red: genera un PDF de muestra con datos
                         ficticios (para validar el formato del catálogo)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

# ── Columnas que entrega /api/inv/existencias-todas ─────────────────────────
# ARTICULO_ID, CLAVE, DESCRIPCION, UNIDAD, UNIDAD_COMPRA, CONTENIDO_EMPAQUE,
# EXISTENCIA, INVENTARIO_MINIMO, COSTO_UNITARIO


def fetch_all(base_url: str, db: str, almacen: str, page_limit: int,
              timeout: int = 60, max_pages: int = 10000) -> list[dict]:
    """Recorre el endpoint paginado por cursor (desde_id) hasta agotarlo."""
    base_url = base_url.rstrip("/")
    rows: list[dict] = []
    desde_id = 0
    pages = 0
    while pages < max_pages:
        params = {"db": db, "desde_id": desde_id, "limit": page_limit}
        if almacen:
            params["almacen"] = almacen
        url = f"{base_url}/api/inv/existencias-todas?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            raise SystemExit(f"[error] HTTP {e.code} en {url}\n{body}")
        except urllib.error.URLError as e:
            raise SystemExit(f"[error] No se pudo conectar a {url}: {e.reason}")

        # El endpoint devuelve una lista de filas. Si llega un dict de error,
        # lo mostramos honestamente en vez de tragar el fallo.
        if isinstance(payload, dict) and payload.get("error"):
            raise SystemExit(f"[error] El endpoint respondió: {payload['error']}")
        if not isinstance(payload, list):
            raise SystemExit(f"[error] Respuesta inesperada (no es lista): {str(payload)[:200]}")

        if not payload:  # [] = fin del inventario
            break
        rows.extend(payload)
        # Avanza el cursor al último ARTICULO_ID de la página.
        desde_id = max(int(r.get("ARTICULO_ID", 0) or 0) for r in payload)
        pages += 1
        print(f"  página {pages}: +{len(payload)} (total {len(rows)}, cursor={desde_id})",
              file=sys.stderr)
        if len(payload) < page_limit:  # última página parcial
            break
    return rows


def _demo_rows() -> list[dict]:
    """Datos ficticios para validar el formato del PDF sin tocar la red."""
    demo = [
        ("MED-001", "GUANTE LATEX EXPLORACION CHICO C/100", "CAJA", "PZA", 100, 340, 50, 78.50),
        ("MED-002", "CUBREBOCAS TRICAPA TERMOSELLADO C/50", "CAJA", "PZA", 50, 1280, 200, 32.00),
        ("MED-003", "JERINGA DESECHABLE 5ML C/AGUJA 21G", "PZA", "PZA", 1, 4200, 500, 1.95),
        ("MED-004", "GASA ESTERIL 7.5X5CM SOBRE INDIVIDUAL", "PZA", "PZA", 1, 980, 300, 2.40),
        ("MED-005", "ALCOHOL ETILICO 70% 1LT", "PZA", "PZA", 1, 156, 40, 28.90),
        ("MED-006", "TERMOMETRO DIGITAL INFRARROJO FRENTE", "PZA", "PZA", 1, 18, 10, 215.00),
        ("MED-007", "VENDA ELASTICA 10CM X 5M", "PZA", "PZA", 1, 410, 100, 9.75),
        ("MED-008", "TELA ADHESIVA MICROPORE 2.5CM", "ROLLO", "PZA", 1, 220, 60, 14.20),
        ("MED-009", "ABATELENGUAS MADERA C/500", "PAQ", "PZA", 500, 64, 20, 45.00),
        ("MED-010", "SOLUCION FISIOLOGICA 0.9% 500ML", "PZA", "PZA", 1, 0, 80, 19.50),
    ]
    keys = ["CLAVE", "DESCRIPCION", "UNIDAD", "UNIDAD_COMPRA", "CONTENIDO_EMPAQUE",
            "EXISTENCIA", "INVENTARIO_MINIMO", "COSTO_UNITARIO"]
    rows = []
    for i, vals in enumerate(demo, start=1):
        r = dict(zip(keys, vals))
        r["ARTICULO_ID"] = i
        rows.append(r)
    return rows


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _fmt_qty(v) -> str:
    n = _num(v)
    return f"{n:,.0f}" if n == int(n) else f"{n:,.2f}"


def _fmt_money(v) -> str:
    return f"${_num(v):,.2f}"


def build_pdf(rows: list[dict], out_path: str, titulo: str,
              subtitulo: str, solo_existencia: bool) -> None:
    # Import diferido: así --help funciona aunque reportlab no esté instalado.
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter, landscape
    from reportlab.lib.units import mm
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import (SimpleDocTemplate, Table, TableStyle,
                                    Paragraph, Spacer)

    if solo_existencia:
        rows = [r for r in rows if _num(r.get("EXISTENCIA")) > 0]

    # Orden estable y legible: por descripción.
    rows = sorted(rows, key=lambda r: str(r.get("DESCRIPCION", "")).upper())

    styles = getSampleStyleSheet()
    cell = ParagraphStyle("cell", parent=styles["Normal"], fontSize=7.5,
                          leading=9, fontName="Helvetica")
    cell_desc = ParagraphStyle("desc", parent=cell, fontName="Helvetica")
    head = ParagraphStyle("h1", parent=styles["Title"], fontSize=20,
                          textColor=colors.HexColor("#0b3d2e"))
    sub = ParagraphStyle("sub", parent=styles["Normal"], fontSize=10,
                         textColor=colors.HexColor("#555555"))

    header_cells = ["Clave", "Descripción", "Unidad", "Empaque",
                    "Existencia", "Mínimo", "Costo unit."]
    data = [header_cells]
    valor_total = 0.0
    for r in rows:
        exist = _num(r.get("EXISTENCIA"))
        costo = _num(r.get("COSTO_UNITARIO"))
        valor_total += exist * costo
        empaque = _num(r.get("CONTENIDO_EMPAQUE"))
        empaque_txt = f"{r.get('UNIDAD_COMPRA','') or ''} x{_fmt_qty(empaque)}".strip() \
            if empaque > 0 else (str(r.get("UNIDAD_COMPRA", "") or "") or "—")
        data.append([
            Paragraph(str(r.get("CLAVE", "") or "—"), cell),
            Paragraph(str(r.get("DESCRIPCION", "") or ""), cell_desc),
            Paragraph(str(r.get("UNIDAD", "") or ""), cell),
            Paragraph(empaque_txt, cell),
            Paragraph(_fmt_qty(exist), cell),
            Paragraph(_fmt_qty(r.get("INVENTARIO_MINIMO")), cell),
            Paragraph(_fmt_money(costo), cell),
        ])

    page = landscape(letter)
    doc = SimpleDocTemplate(
        out_path, pagesize=page,
        leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=14 * mm, bottomMargin=14 * mm,
        title=titulo, author="Suminregio Parker — ERP Microsip",
    )

    col_widths = [28 * mm, 95 * mm, 18 * mm, 30 * mm, 24 * mm, 20 * mm, 25 * mm]
    table = Table(data, colWidths=col_widths, repeatRows=1)
    style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0b3d2e")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 8),
        ("ALIGN", (4, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cccccc")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f2f7f4")]),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ])
    table.setStyle(style)

    elems = [
        Paragraph(titulo, head),
        Paragraph(subtitulo, sub),
        Paragraph(
            f"{len(rows):,} artículos · valor de inventario a costo: "
            f"{_fmt_money(valor_total)}", sub),
        Spacer(1, 6 * mm),
        table,
    ]

    def _footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(colors.HexColor("#888888"))
        w, _h = page
        canvas.drawString(12 * mm, 7 * mm,
                          "Suminregio Parker — Catálogo de Suministros Médicos")
        canvas.drawRightString(w - 12 * mm, 7 * mm, f"Página {_doc.page}")
        canvas.restoreState()

    doc.build(elems, onFirstPage=_footer, onLaterPages=_footer)
    print(f"[ok] PDF generado: {out_path} ({len(rows):,} artículos)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Genera el PDF del catálogo de Suministros Médicos.")
    ap.add_argument("--base-url",
                    default="https://suminregioparker-todoslosnegocios.onrender.com",
                    help="URL base del ERP desplegado.")
    ap.add_argument("--db", default="default", help="Identificador de base (?db=).")
    ap.add_argument("--almacen", default="",
                    help="IDs de almacén separados por coma (default: todos).")
    ap.add_argument("--limit", type=int, default=500,
                    help="Tamaño de página del cursor (máx 1000).")
    ap.add_argument("--out", default="catalogo-suministros-medicos.pdf",
                    help="Ruta del PDF de salida.")
    ap.add_argument("--titulo", default="Catálogo de Suministros Médicos")
    ap.add_argument("--solo-existencia", action="store_true",
                    help="Incluir sólo artículos con existencia > 0.")
    ap.add_argument("--demo", action="store_true",
                    help="Genera un PDF de muestra con datos ficticios (sin red).")
    args = ap.parse_args()

    if args.demo:
        print("[demo] usando datos ficticios (no se llama a la red)", file=sys.stderr)
        rows = _demo_rows()
        fuente = "DATOS DE MUESTRA (demo) — no son existencias reales"
    else:
        print(f"[fetch] {args.base_url} (db={args.db}, almacen={args.almacen or 'todos'})",
              file=sys.stderr)
        rows = fetch_all(args.base_url, args.db, args.almacen, args.limit)
        fuente = f"Fuente: {args.base_url} · db={args.db} · almacén={args.almacen or 'todos'}"

    if not rows:
        raise SystemExit("[error] El inventario vino vacío; no se generó PDF.")

    hoy = _dt.date.today().strftime("%d/%m/%Y")
    subtitulo = f"{fuente} · Generado el {hoy}"
    build_pdf(rows, args.out, args.titulo, subtitulo, args.solo_existencia)


if __name__ == "__main__":
    main()
