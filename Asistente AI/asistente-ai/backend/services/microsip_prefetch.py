"""
Prefetch de contexto en vivo desde la API Microsip (misma fuente que ventas.html).

Evita respuestas inventadas cuando el usuario pregunta por ventas del día / mes actual.
No modifica el proyecto microsip-api — solo consume GET públicos del despliegue Render.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from tools.microsip import DATABASES, query_microsip

MAX_PREFETCH_JSON_CHARS = 8000


def _mx_now() -> datetime:
    try:
        return datetime.now(ZoneInfo("America/Mexico_City"))
    except Exception:
        # Fallback seguro cuando tzdata no está disponible en el runtime.
        return datetime.now()


def resolve_db_from_message(text: str) -> str:
    """Mapea lenguaje natural → query param `db` de la API."""
    tl = text.lower()
    # Más específicos primero
    rules: list[tuple[str, str]] = [
        (r"\bgrupo\s+suminregio\b", "grupo_suminregio"),
        (r"\bsuminregio\s+agua\b", "suminregio_agua"),
        (r"cart[oó]n", "suminregio_carton"),
        (r"\bmaderas?\b", "suminregio_maderas"),
        (r"reciclaje", "suminregio_reciclaje"),
        (r"suministros?\s+m[eé]dicos", "suminregio_suministros_medicos"),
        (r"\belige\b", "elige"),
        (r"\blagor\b", "lagor"),
        (r"\bmafra\b", "mafra"),
        (r"\bnortex\b", "nortex"),
        (r"parker\s*mfg|parker\s+manufacturing", "parker_mfg"),
        (r"\bsp\s+paso\b|\bsp_paso\b", "sp_paso"),
        (r"\bpaso\b", "paso"),
        (r"roberto", "roberto_gzz"),
        (r"\brobin\b", "robin"),
        (r"\bempresa\b", "empresa"),
        (r"suminregio\s+parker|parker|principal|suminregio\s+principal", "default"),
    ]
    for pat, db in rules:
        if re.search(pat, tl, re.I):
            return db
    return "default"


def _wants_ventas_snapshot(text: str) -> bool:
    t = text.lower()
    if not re.search(
        r"venta|factur|remisi|coti|importe|cotiz|dinero|pesos|mxn",
        t,
        re.I,
    ):
        return False
    if re.search(
        r"\bhoy\b|d[ií]a\s+de\s+hoy|ventas?\s+del\s+d[ií]a|este\s+d[ií]a",
        t,
        re.I,
    ):
        return True
    if re.search(
        r"mes\s+actual|este\s+mes|mes\s+en\s+curso|mes\s+corriente",
        t,
        re.I,
    ):
        return True
    return False


def _wants_cxc_snapshot(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"cxc|cuentas?\s+por\s+cobrar|cartera|vencid|aging|morosidad|cobranza|saldo\s+pendiente",
            t,
            re.I,
        )
    )


def _wants_inventory_snapshot(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"inventario|stock|existencias?|almac[eé]n|quiebre|reorden|bajo\s+m[ií]nimo|rotaci[oó]n",
            t,
            re.I,
        )
    )


def _wants_consumos_snapshot(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"consumo|consumos?|consumo\s+diario|consumo\s+mensual|ritmo\s+operativo|"
            r"abastecimiento|consumo\s+de\s+material|consumo\s+industrial|"
            r"qu[eé]\s+se\s+consume|m[aá]s\s+consumido|top\s+consumo",
            t,
            re.I,
        )
    )


def _wants_compras_snapshot(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"compras?|oc\s|orden\s+de\s+compra|pedido\s+a\s+proveedor|proveedor|"
            r"lo\s+que\s+se\s+compra|factura\s+de\s+proveedor|entrada\s+de\s+mercancia",
            t,
            re.I,
        )
    )


def _wants_universe_snapshot(text: str) -> bool:
    t = text.lower()
    return bool(
        re.search(
            r"grupo|consolidado|todas?\s+las\s+empresas?|scorecard|universo|holding|global",
            t,
            re.I,
        )
    )


def _build_prefetch_request(last_user: str) -> tuple[str, dict[str, str | int], str] | None:
    now = _mx_now()
    db = resolve_db_from_message(last_user)

    if _wants_ventas_snapshot(last_user):
        return (
            "/api/ventas/resumen",
            {"db": db, "anio": now.year, "mes": now.month},
            "VENTAS",
        )
    if _wants_cxc_snapshot(last_user):
        return (
            "/api/cxc/aging",
            {"db": db},
            "CXC",
        )
    if _wants_consumos_snapshot(last_user):
        return (
            "/api/consumos/resumen",
            {"db": db, "anio": now.year, "mes": now.month},
            "CONSUMOS",
        )
    if _wants_inventory_snapshot(last_user):
        return (
            "/api/inv/resumen",
            {"db": db},
            "INVENTARIO",
        )
    if _wants_compras_snapshot(last_user):
        return (
            "/api/compras/resumen",
            {"db": db, "anio": now.year, "mes": now.month},
            "COMPRAS",
        )
    if _wants_universe_snapshot(last_user):
        return (
            "/api/universe/scorecard",
            {"anio": now.year, "mes": now.month},
            "GRUPO",
        )
    return None


def _iter_flat_numbers(obj: Any, prefix: str = "") -> list[tuple[str, float]]:
    rows: list[tuple[str, float]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            rows.extend(_iter_flat_numbers(v, key))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            rows.extend(_iter_flat_numbers(item, f"{prefix}[{i}]"))
    else:
        if isinstance(obj, bool):
            return rows
        if isinstance(obj, (int, float)):
            rows.append((prefix, float(obj)))
    return rows


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _pick_numeric(data: Any, aliases: list[str]) -> float | None:
    flat = _iter_flat_numbers(data)
    if not flat:
        return None
    alias_set = {_normalize_key(a) for a in aliases}
    for key, value in flat:
        nkey = _normalize_key(key)
        for alias in alias_set:
            if alias and alias in nkey:
                return value
    return None


def _sales_playbook(domain: str) -> str:
    if domain == "VENTAS":
        return (
            "Playbook sugerido:\n"
            "  1) Priorizar top cuentas por oportunidad de cierre y margen.\n"
            "  2) Definir siguiente contacto con fecha y responsable.\n"
            "  3) Proponer cross-sell / up-sell con 1 oferta concreta.\n"
            "  4) Medir avance semanal: tasa de conversión, ticket promedio, ciclo de cierre."
        )
    if domain == "CXC":
        return (
            "Playbook sugerido:\n"
            "  1) Segmenta cartera por riesgo (0-30, 31-60, +60 días).\n"
            "  2) Ejecuta recordatorios y acuerdos de pago por prioridad.\n"
            "  3) Escala cuentas críticas a vendedor responsable.\n"
            "  4) Monitorea recuperación semanal y promesas incumplidas."
        )
    if domain == "INVENTARIO":
        return (
            "Playbook sugerido:\n"
            "  1) Atender quiebres y bajo mínimo por criticidad comercial.\n"
            "  2) Reordenar SKUs con mayor impacto en ventas.\n"
            "  3) Ajustar punto de reorden con rotación reciente.\n"
            "  4) Validar riesgo de margen por compras urgentes."
        )
    if domain == "CONSUMOS":
        return (
            "Playbook de Consumos sugerido:\n"
            "  1) Identificar artículos con quiebre urgente (impacto en producción/servicio).\n"
            "  2) Calcular cobertura: días de stock actual vs ritmo de consumo diario.\n"
            "  3) Priorizar reabasto por concentración Pareto (20% artículos = 80% consumo).\n"
            "  4) Revisar tendencia semanal: ¿pico estacional? ¿nuevo cliente? ¿campaña?"
        )
    if domain == "COMPRAS":
        return (
            "Playbook de Compras sugerido:\n"
            "  1) Cruzar órdenes de compra pendientes con quiebres activos.\n"
            "  2) Evaluar tiempo de entrega vs urgencia operativa.\n"
            "  3) Identificar proveedores con mayor volumen y condiciones actuales.\n"
            "  4) Monitorear desviación de presupuesto de compras vs real."
        )
    return (
        "Playbook sugerido:\n"
        "  1) Revisar KPIs por unidad y variación semanal.\n"
        "  2) Priorizar 3 focos de mayor impacto financiero.\n"
        "  3) Definir responsables y fecha de cierre por iniciativa."
    )


def _risk_block(domain: str, data: Any) -> str:
    level = "VERDE"
    reason = "Operación estable según señales detectadas."
    action = "Continuar monitoreo y ejecución estándar."

    if domain == "VENTAS":
        hoy = _pick_numeric(data, ["HOY"])
        mes_actual = _pick_numeric(data, ["MES_ACTUAL", "MESTOTAL"])
        hasta_ayer = _pick_numeric(data, ["HASTA_AYER_MES", "MESHASTAAYER"])
        if hoy is not None and hoy <= 0:
            level = "AMARILLO"
            reason = "Ventas HOY en 0 o negativas."
            action = "Activar seguimiento comercial y revisar oportunidades del día."
        if (
            hoy is not None
            and mes_actual is not None
            and hasta_ayer is not None
            and hoy <= 0
            and mes_actual <= hasta_ayer
        ):
            level = "ROJO"
            reason = "No hay avance comercial diario en el mes actual."
            action = "Escalar pipeline crítico y ejecutar plan de recuperación inmediato."

    elif domain == "CXC":
        vencida = _pick_numeric(data, ["VENCIDA", "SALDO_VENCIDO", "CXC_VENCIDA", "MOROSA"])
        total = _pick_numeric(data, ["TOTAL", "SALDO_TOTAL", "CXC_TOTAL", "CARTERA_TOTAL"])
        if vencida is not None and total and total > 0:
            ratio = vencida / total
            if ratio > 0.40:
                level = "ROJO"
                reason = f"Cartera vencida alta ({ratio:.1%} del total)."
                action = "Aplicar plan de cobranza intensiva y escalamiento comercial."
            elif ratio > 0.25:
                level = "AMARILLO"
                reason = f"Cartera vencida moderada ({ratio:.1%})."
                action = "Aumentar ritmo de seguimiento y acuerdos de pago."

    elif domain == "INVENTARIO":
        bajo = _pick_numeric(data, ["BAJO_MINIMO", "ITEMS_BAJO_MINIMO", "ARTICULOS_BAJO_MINIMO"])
        sin_stock = _pick_numeric(data, ["SIN_STOCK", "QUIEBRE", "ARTICULOS_SIN_STOCK"])
        if sin_stock is not None and sin_stock > 0:
            level = "ROJO"
            reason = f"Hay {int(sin_stock)} ítems en quiebre."
            action = "Priorizar reabasto urgente de SKUs críticos."
        elif bajo is not None and bajo > 0:
            level = "AMARILLO"
            reason = f"Hay {int(bajo)} ítems bajo mínimo."
            action = "Programar compra preventiva y ajustar punto de reorden."

    elif domain == "CONSUMOS":
        quiebres = _pick_numeric(data, ["ALERTAS_QUIEBRE", "ALERTAS_CRITICAS", "QUIEBRE", "SIN_STOCK"])
        ritmo = _pick_numeric(data, ["RITMO_DIARIO", "CONSUMO_DIARIO_PROMEDIO"])
        if quiebres is not None and quiebres > 0:
            level = "ROJO"
            reason = f"Hay {int(quiebres)} artículos en quiebre de consumo."
            action = "Revisar pedidos pendientes y acelerar reabastecimiento urgente."
        elif ritmo is not None and ritmo <= 0:
            level = "AMARILLO"
            reason = "Ritmo de consumo diario en cero o sin datos del periodo."
            action = "Verificar fuente de datos y confirmar actividad operativa."

    elif domain == "COMPRAS":
        total = _pick_numeric(data, ["TOTAL", "IMPORTE_TOTAL", "TOTAL_COMPRAS"])
        if total is not None and total <= 0:
            level = "AMARILLO"
            reason = "Sin registros de compras detectados en el periodo."
            action = "Verificar si hay órdenes de compra pendientes de aplicar."

    return (
        "Semáforo de riesgo operativo:\n"
        f"  - Nivel: {level}\n"
        f"  - Motivo: {reason}\n"
        f"  - Acción recomendada: {action}\n"
    )


def maybe_live_microsip_context(messages: list[dict[str, Any]]) -> str | None:
    """
    Si el último mensaje del usuario pide ventas/cotizaciones hoy o mes actual,
    obtiene /api/ventas/resumen y devuelve un bloque para anexar al system prompt.
    """
    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        "",
    )
    if not isinstance(last_user, str) or not last_user.strip():
        return None
    if len(last_user) > 4000:
        return None

    prefetch = _build_prefetch_request(last_user)
    if not prefetch:
        return None

    endpoint, params, domain = prefetch
    db = str(params.get("db", "default"))

    raw = query_microsip(endpoint, params)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and data.get("error"):
        return None

    pretty = json.dumps(data, ensure_ascii=False, indent=2)
    if len(pretty) > MAX_PREFETCH_JSON_CHARS:
        pretty = (
            pretty[: MAX_PREFETCH_JSON_CHARS - 64]
            + "\n\n... [JSON truncado por límite de contexto] ..."
        )
    label = DATABASES.get(db, db)
    risk = _risk_block(domain, data)
    playbook = _sales_playbook(domain)
    return (
        "════════════════════════════════════════\n"
        "  DATOS EN VIVO (API Microsip — autoridad)\n"
        "════════════════════════════════════════\n"
        f"Dominio: {domain}\n"
        f"Empresa (db={db}): {label}\n"
        f"Prefetch automático: GET {endpoint} "
        + " ".join([f"{k}={v}" for k, v in params.items()]) + "\n"
        "Misma fuente lógica que el dashboard "
        "(ventas.html — KPIs Hoy, Mes actual, remisiones).\n\n"
        "Claves JSON (no confundir):\n"
        "  • HOY — ventas facturadas del día calendario (card «Hoy»; combina fuentes según API)\n"
        "  • REMISIONES_HOY — remisiones del día\n"
        "  • MES_ACTUAL — total del mes en el filtro anio/mes\n"
        "  • HASTA_AYER_MES — mes acumulado hasta ayer (si HOY>0, MES_ACTUAL > HASTA_AYER_MES)\n"
        "  • FACTURAS_MES — número de facturas del periodo filtrado\n\n"
        f"{risk}\n"
        f"{playbook}\n\n"
        f"{pretty}\n\n"
        "Instrucción: usa EXACTAMENTE estos números del endpoint consultado. "
        "Si el usuario pide ventas hoy, reporta HOY (y REMISIONES_HOY si aplica). "
        "No inventes métricas que no estén presentes.\n"
    )
