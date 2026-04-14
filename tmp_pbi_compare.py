# -*- coding: utf-8 -*-
"""Compare Power BI export: Deuda Total vs Vencido + Vigente per folio."""
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent
TSV = ROOT / "tmp_pbi_user.tsv"


def money(s: str) -> float:
    s = (s or "").strip().replace("$", "").replace(",", "")
    if not s:
        return 0.0
    return float(s)


def main() -> None:
    text = TSV.read_text(encoding="utf-8")
    lines = [ln.rstrip("\n") for ln in text.strip().splitlines() if ln.strip()]
    header = lines[0].split("\t")
    if len(header) < 7:
        print("Expected 7 columns, got:", header)
        return

    rows = []
    bad_balance = []
    venta_vs_deuda = []

    for i, line in enumerate(lines[1:], start=2):
        parts = line.split("\t")
        if len(parts) < 7:
            print(f"Line {i}: wrong column count {len(parts)}: {line[:120]}...")
            continue
        cliente, factura, estatus, venta_s, deuda_s, venc_s, vig_s = parts[:7]
        deuda = money(deuda_s)
        venc = money(venc_s)
        vig = money(vig_s)
        venta = money(venta_s)
        sum_v = venc + vig
        diff = round(deuda - sum_v, 2)
        rows.append((factura, deuda, venc, vig, diff))

        if abs(diff) > 0.02:
            bad_balance.append(
                (factura, cliente, deuda, venc, vig, sum_v, diff)
            )

        # Venta vs Deuda (display Venta often rounded to integer)
        vd = abs(venta - deuda)
        if vd > 1.0:  # more than $1 difference
            venta_vs_deuda.append((factura, venta, deuda, vd))

    total_deuda = sum(r[1] for r in rows)
    total_venc = sum(r[2] for r in rows)
    total_vig = sum(r[3] for r in rows)

    print("=== Totales (suma Deuda Total por fila) ===")
    print(f"Filas: {len(rows)}")
    print(f"Suma Deuda Total: {total_deuda:.2f}")
    print(f"Suma Saldo Vencido: {total_venc:.2f}")
    print(f"Suma Saldo Vigente: {total_vig:.2f}")
    print(f"Vencido + Vigente: {total_venc + total_vig:.2f}")
    print(f"Diff (deuda - venc - vig): {total_deuda - total_venc - total_vig:.4f}")

    print("\n=== Folios donde Deuda Total ≠ Vencido + Vigente (>|0.02|) ===")
    if not bad_balance:
        print("Ninguno — todas las filas cuadran internamente.")
    else:
        for t in bad_balance:
            print(
                f"  {t[0]} | deuda={t[2]:.2f} venc={t[3]:.2f} vig={t[4]:.2f} sum={t[5]:.2f} diff={t[6]:.2f}"
            )

    print("\n=== Folios donde Venta difiere de Deuda Total en >$1 (info / no error de split) ===")
    for factura, venta, deuda, vd in sorted(venta_vs_deuda, key=lambda x: -x[3])[:30]:
        print(f"  {factura} | Venta={venta:.2f} Deuda={deuda:.2f} diff={vd:.2f}")


if __name__ == "__main__":
    main()
