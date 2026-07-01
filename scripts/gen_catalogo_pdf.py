#!/usr/bin/env python3
"""
gen_catalogo_pdf.py — Genera un PDF con el catálogo COMPLETO de artículos
(clave SM#### + nombre) de Suministros Médicos.

Fuente de datos: endpoint GET /api/inv/catalogo (ver inv-catalogo.js), que
devuelve TODO el catálogo ARTICULOS desde el snapshot DuckDB.

Requisitos: pip install reportlab

Uso:
  # A) En vivo desde el servidor (host debe estar permitido en egress):
  python3 scripts/gen_catalogo_pdf.py \
      --base https://suminregioparker-todoslosnegocios.onrender.com \
      --db suminregio_suministros_medicos

  # B) Desde un JSON ya descargado (objeto {productos:[...]} o lista de objetos):
  python3 scripts/gen_catalogo_pdf.py --json catalogo.json
"""
import argparse
import datetime
import json
import sys
import urllib.parse
import urllib.request


def fetch(base, db, con_existencia):
    url = (
        f"{base.rstrip('/')}/api/inv/catalogo?db={urllib.parse.quote(db)}"
        f"&limit=100000{'&con_existencia=1' if con_existencia else ''}"
    )
    with urllib.request.urlopen(url, timeout=180) as r:
        payload = json.loads(r.read().decode("utf-8"))
    if isinstance(payload, dict):
        if not payload.get("ok", True):
            sys.exit(f"El servidor respondió ok=false: {payload.get('reason')}")
        return payload.get("productos", [])
    return payload


def normalize(rows):
    out = []
    for x in rows:
        clave = str(x.get("clave") or x.get("CLAVE") or "").strip()
        nombre = str(x.get("nombre") or x.get("NOMBRE") or x.get("DESCRIPCION") or "").strip()
        if not clave and not nombre:
            continue
        existencia = x.get("existencia")
        out.append((clave, nombre, existencia))
    # ordenar por clave; las vacías al final
    out.sort(key=lambda r: (r[0] == "", r[0]))
    return out


def build_pdf(items, path, show_stock):
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import cm
    from reportlab.platypus import (Paragraph, SimpleDocTemplate, Spacer,
                                    Table, TableStyle)

    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], fontSize=16,
                           textColor=colors.HexColor("#0EA5E9"))
    sub = ParagraphStyle("s", parent=styles["Normal"], fontSize=9,
                         textColor=colors.HexColor("#555555"))
    cell = ParagraphStyle("c", parent=styles["Normal"], fontSize=8, leading=10)

    doc = SimpleDocTemplate(
        path, pagesize=letter, topMargin=1.5 * cm, bottomMargin=1.5 * cm,
        leftMargin=1.5 * cm, rightMargin=1.5 * cm,
        title="Catálogo Suministros Médicos",
    )
    hoy = datetime.date.today().strftime("%d/%m/%Y")
    elems = [
        Paragraph("Suminregio · Suministros Médicos", title),
        Paragraph(
            f"Catálogo de productos (Microsip) — clave y nombre — "
            f"{len(items)} artículos — actualizado {hoy}", sub),
        Spacer(1, 0.4 * cm),
    ]

    if show_stock:
        header = ["#", "Clave (SM)", "Producto", "Existencia"]
        widths = [1.1 * cm, 2.8 * cm, 11.0 * cm, 2.6 * cm]
    else:
        header = ["#", "Clave (SM)", "Producto"]
        widths = [1.2 * cm, 3.0 * cm, 13.3 * cm]

    data = [header]
    for i, (clave, nombre, existencia) in enumerate(items, 1):
        row = [str(i), Paragraph(clave or "—", cell), Paragraph(nombre or "—", cell)]
        if show_stock:
            row.append("" if existencia is None else str(existencia))
        data.append(row)

    tbl = Table(data, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0EA5E9")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F2F8FC")]),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D8E2EC")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("FONTNAME", (1, 1), (1, -1), "Helvetica-Bold"),
        ("ALIGN", (0, 0), (0, -1), "RIGHT"),
    ]
    if show_stock:
        style.append(("ALIGN", (3, 1), (3, -1), "RIGHT"))
    tbl.setStyle(TableStyle(style))
    elems.append(tbl)
    doc.build(elems)


def main():
    ap = argparse.ArgumentParser(description="Genera PDF del catálogo de artículos")
    ap.add_argument("--base", help="URL base del servidor")
    ap.add_argument("--db", default="suminregio_suministros_medicos",
                    help="dbId del snapshot (default: suminregio_suministros_medicos)")
    ap.add_argument("--json", help="archivo JSON con el catálogo (en vez de --base)")
    ap.add_argument("--out", default="catalogo_suministros_medicos.pdf")
    ap.add_argument("--existencia", action="store_true",
                    help="incluir columna de existencia")
    a = ap.parse_args()

    if a.json:
        rows = json.load(open(a.json, encoding="utf-8"))
        if isinstance(rows, dict):
            rows = rows.get("productos", [])
    elif a.base:
        rows = fetch(a.base, a.db, a.existencia)
    else:
        ap.error("usa --base o --json")

    items = normalize(rows)
    if not items:
        sys.exit("Sin datos: el catálogo vino vacío.")
    build_pdf(items, a.out, a.existencia)
    print(f"OK -> {a.out} ({len(items)} productos)")


if __name__ == "__main__":
    main()
