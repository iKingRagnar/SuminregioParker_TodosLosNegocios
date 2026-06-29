# CLAUDE.md — Memoria de definición del proyecto (Suminregio / microsip-api)

> Este archivo es la **memoria operativa** que Claude debe respetar SIEMPRE en este
> repositorio. Complementa `AGENTS.md` y las reglas en `.cursor/rules/`.

---

## PROTOCOLO DE OPERACIÓN EXPERTA (siempre activo)

1. **Autocrítica obligatoria — nunca entregues a la primera.**
   Antes de mostrar cualquier output técnico, ejecuta internamente el loop
   **Plan → Critique → Revise** (mínimo 1 iteración; 2 en alto riesgo):
   - **Draft:** genera la solución.
   - **Red-team de tu propio output:** "¿Qué falla aquí? ¿Qué asumí sin verificar?
     ¿Dónde se rompe a escala / con NULLs / datos sucios / cardinalidad alta?"
   - **Revise:** corrige antes de mostrar.
   - Cierra con **`Confianza: Alta/Media/Baja` + el supuesto más frágil** que la sostiene.

2. **Skill-first.** Identifica y **lee el skill aplicable antes** de codear o diseñar:
   - DAX / Power Query / SQL / Firebird → `bi-analyst` + **validar contra el esquema real**, no de memoria.
   - Multi-agente / n8n / ARIA → `agent-design` antes de proponer arquitectura.
   - Proyecto Suminregio / MAGRAN → leer el skill de contexto correspondiente primero.
   - Data/BI/ETL/Python/analítica → `.cursor/skills/data-ai-ecosystem-copilot/SKILL.md`.
   - No improvises sobre dominios con skill disponible.

3. **Cero memoria para datos volátiles.** Precios, versiones, releases, cifras, fórmulas y
   stats se **buscan (web_search) o se calculan** — nunca se afirman de memoria.

4. **Tradeoffs honestos.** En toda decisión de stack (DuckDB vs SQL Server, LangGraph vs
   n8n, etc.): incluye un **pre-mortem** ("imagina que falló en 6 meses, ¿por qué?") y el
   **steelman** (mejor argumento) de la opción que descartas.

5. **Calidad de datos como gate.** Antes de cualquier insight, **perfila**: NULLs,
   duplicados, cardinalidad, grain del modelo, rango de fechas, outliers. Sin perfilado, no hay insight.

6. **Cierre con negocio.** Toda solución cierra con: impacto de negocio, costo de
   mantenimiento y **punto de quiebre a escala** (ROI/escalabilidad).

7. **Anti-deriva.** En sesiones largas, cada pocas entregas **re-confirma el objetivo real**
   y purga supuestos acumulados que ya no aplican.

8. **Memoria auto-mejorante.** Al cerrar trabajo significativo, **destila** qué se aprendió,
   qué patrón es reusable y qué corregir la próxima — y escríbelo aquí o en el skill del proyecto.

---

## Disparadores de auditoría por contexto

| Si el contexto es… | Forzar |
| --- | --- |
| DAX / Power Query / SQL / Firebird | Leer `bi-analyst`; validar contra el esquema real (no de memoria) |
| Multi-agente / n8n / ARIA | Leer `agent-design` antes de proponer arquitectura |
| Proyecto Suminregio / MAGRAN | Leer el skill de contexto correspondiente primero |
| Dato actual (precios, versiones, releases) | `web_search` obligatorio; prohibido responder de memoria |
| Cierre de sesión significativa | Ejecutar `self-improving-memory` (destilar aprendizajes) |
| Código > 10 líneas o entregable | Crear archivo, **no** pegar inline |

---

## Contexto técnico del proyecto (hechos verificados — actualizar al aprender)

- **Cifras = base NETA (sin IVA) en TODO el proyecto.** Ventas usan `IMPORTE_NETO`
  (`sqlVentaImporteBaseExpr`). El flag `MICROSIP_VENTAS_INCLUIR_IMPUESTOS` se mantiene en
  `0` (render.yaml). Ponerlo en `1` sumaría el IVA por documento (como la UI de Microsip) y
  rompería la consistencia "sin IVA". El P&L (Estado de Resultados) siempre es neto.
- **Una sola cifra de "Ventas" en toda la app.** Ventas/Director/Inicio usan documentos
  operativos `DOCTOS_VE` (industrial) + `DOCTOS_PV` (mostrador). El **P&L usa la MISMA base
  operativa por default** (antes usaba contabilidad `SALDOS_CO` cuentas 4*, que no incorpora
  el mostrador igual y daba una cifra distinta). Para volver a base contable:
  `?pnl_ventas=conta` o `MICROSIP_PNL_USAR_VENTAS_CONTA=1`.
- **Catálogo de negocios:** `fb-databases.registry.json`. El negocio cuya base es
  `SUMINREGIO-PARKER.FDB` (id `default`) se llama **"Mangueras y Conexiones"** (no
  "Suminregio Parker"). El server salta la sobre-escritura de label si no contiene "principal".
- **Deploy:** Render despliega solo desde `main`. Tras cambios: commit + push a `main`
  (o PR → merge). Frontend = `public/` + algunos HTML en la raíz; capa visual global se
  inyecta vía `nav.js` (páginas) y `app-ui-boot.js` (dashboards).
- **Contexto visual de KPIs:** `public/kpi-context.js` (ⓘ qué es + cómo se calcula,
  auto-fit de números, promoción de sub-métricas a cards). Self-contained, idempotente.

---

## Seguridad
No commitear secretos. Credenciales vía variables de entorno o el gestor de secretos del
entorno de despliegue.
