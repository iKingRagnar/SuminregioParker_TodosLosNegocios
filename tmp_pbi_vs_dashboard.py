# -*- coding: utf-8 -*-
"""Compare Power BI TSV (folio, deuda) vs public/Dashboard_CC.html embedded DATA."""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
HTML = ROOT / "public" / "Dashboard_CC.html"
TSV = ROOT / "tmp_pbi_user.tsv"
TOL = 0.02


def money(s: str) -> float:
    s = (s or "").strip().replace("$", "").replace(",", "")
    if not s:
        return 0.0
    return float(s)


def load_dashboard() -> dict:
    text = HTML.read_text(encoding="utf-8")
    m = re.search(r"const DATA=(\{.*?\});", text, re.S)
    if not m:
        raise SystemExit("DATA not found in HTML")
    return json.loads(m.group(1))


def load_pbi() -> list[tuple[str, str, float]]:
    lines = [ln.rstrip("\n") for ln in TSV.read_text(encoding="utf-8").strip().splitlines() if ln.strip()]
    out = []
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        cliente, factura, _, _, deuda_s, _, _ = parts[:7]
        out.append((factura.strip(), cliente.strip(), money(deuda_s)))
    return out


def main() -> None:
    data = load_dashboard()
    fecha = data.get("fecha_corte")
    tot = data["totales"]
    by_folio = {d["folio"]: d for d in data["documentos"]}

    pbi_rows = load_pbi()
    pbi_by = {f: (c, x) for f, c, x in pbi_rows}

    print("=== Referencia HTML (Dashboard_CC.html) ===")
    print(f"fecha_corte={fecha} | docs={tot.get('docs')} | saldo_total={tot.get('saldo_total')}")

    print("\n=== Power BI export (tmp_pbi_user.tsv) ===")
    print(f"filas={len(pbi_rows)} | suma Deuda Total={sum(x for _, _, x in pbi_rows):.2f}")

    only_pbi = sorted(set(pbi_by.keys()) - set(by_folio.keys()))
    only_dash = sorted(set(by_folio.keys()) - set(pbi_by.keys()))

    print("\n=== Folios solo en Power BI (no en HTML embebido) ===")
    print(len(only_pbi), only_pbi[:50], ("..." if len(only_pbi) > 50 else ""))

    print("\n=== Folios solo en HTML embebido (no en Power BI) ===")
    print(len(only_dash), only_dash[:50], ("..." if len(only_dash) > 50 else ""))

    print("\n=== Mismo folio: |Deuda PBI - Saldo HTML| > {:.2f} ===".format(TOL))
    mism = []
    for folio, (cli_pbi, deuda_pbi) in pbi_by.items():
        if folio not in by_folio:
            continue
        d = by_folio[folio]
        saldo = float(d["saldo"])
        diff = round(deuda_pbi - saldo, 2)
        if abs(diff) > TOL:
            mism.append(
                (
                    folio,
                    deuda_pbi,
                    saldo,
                    diff,
                    d.get("bucket"),
                    d.get("vencido"),
                    cli_pbi,
                    d.get("cliente"),
                )
            )

    mism.sort(key=lambda t: -abs(t[3]))
    for row in mism[:80]:
        print(
            f"  {row[0]} | PBI={row[1]:.2f} HTML={row[2]:.2f} Δ={row[3]:.2f} | "
            f"HTML bucket={row[4]} vencido={row[5]}"
        )
    if len(mism) > 80:
        print(f"  ... +{len(mism) - 80} más")

    print(f"\nTotal folios en ambos con diferencia de saldo: {len(mism)}")


if __name__ == "__main__":
    main()
