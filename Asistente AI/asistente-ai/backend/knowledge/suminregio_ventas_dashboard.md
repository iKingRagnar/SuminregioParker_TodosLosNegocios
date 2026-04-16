# Suminregio — Contexto completo de negocio y dashboards

Referencia alineada con la API desplegada en Render y los dashboards HTML del proyecto.

## URL del sistema

- Base: `https://suminregioparker-todoslosnegocios.onrender.com`
- Dashboard principal: `/Dashboard_Index.html`
- Ventas: `/Dashboard_Ventas.html?db=default&anio=2026&mes=4&preset=mes`
- Scorecard ejecutivo: `/Dashboard_Scorecard.html`
- Correlación Gastos·Ventas: `/Dashboard_Correlacion.html`
- CXC: `/Dashboard_CC.html`
- Inventario: `/inventario.html`
- Resultados (P&L + Balance): `/resultados.html`

## Parámetros habituales

| Query | Uso |
|-------|-----|
| `db` | Empresa: `default` = Suminregio Parker (principal); ver lista en backend `DATABASES` |
| `anio`, `mes` | Mes del calendario para KPIs «Mes actual», gráficas y tablas |
| `preset` | Vista del periodo en la UI |
| `tipo` | En API REST: `VE`, `PV` o sin param = ambos (como botones Todos / VE / PV) |

## KPI → `/api/ventas/resumen`

| UI | Campo JSON |
|----|------------|
| Hoy | `HOY` |
| Mes actual | `MES_ACTUAL` |
| Facturas mes | `FACTURAS_MES` |
| Remisiones (día / mes) | `REMISIONES_HOY`, `REMISIONES_MES` |
| Acumulado hasta ayer (mes) | `HASTA_AYER_MES` |

Interpretación: **HOY** es la autoridad para «ventas de hoy». No deducir cero comparando solo `HASTA_AYER_MES` con `MES_ACTUAL`.

---

## PROYECTO BOOSTRATEGY (Allinko Consulting)

**Consultoría en Ventas Estratégicas** implementada por **Luis Salinas Fox** (Director, Allinko Consulting).

- **Objetivo:** +20% incremento en ventas (crecimiento promedio esperado 15–25%)
- **Duración:** 12 meses, 3 fases:
  1. **Boostrategy** — Diagnóstico, estructura de venta, modelos de compensación
  2. **Procesos Comerciales** — Métodos de selección, métricas, MKT digital, relaciones públicas
  3. **Coach / Auditoría** — Seguimiento y ajuste de resultados
- **Actividades clave:** Estructura de venta, métodos de selección, métricas, modelos de compensación, marketing digital, relaciones públicas

---

## Equipo de Ventas SUMINREGIO (6 ejecutivos — Evaluación 4D Psicométrica)

| Vendedor | Prospectador | Técnico | Cerrador | Servicio | Notas |
|----------|-------------|---------|----------|----------|-------|
| Guadalupe Mtz. | 33 | 18.2 | 29 | 22 | ⚠️ Bajo desempeño general — máxima área de mejora |
| Brisa Olvera | 49.5 | 57.2↑ | 50.5↑ | 62↑ | Desarrollo en crecimiento sostenido |
| Alejandro Medina | 64↑ | 48.1 | 39 | 63.5↑ | Buen prospectador; mejorar cierre |
| Josue Gonzalez | 66↑ | 16.8⚠️ | 37.5 | 43 | Fuerte prospectador, débil técnico |
| Abel Cabrera | 60↑ | 57.9↑ | 38.5 | 66.5↑ | Mejor perfil técnico-servicio del equipo |
| Rogelio Hdz. | 29.5⚠️ | 45 | 37 | 37.5 | Área de oportunidad significativa en prospección |

**Dimensiones 4D:**
- **Prospectador** — capacidad de apertura de nuevas cuentas
- **Técnico** — conocimiento de producto y soluciones
- **Cerrador** — habilidad para cerrar ventas y negociar
- **Servicio** — orientación al cliente y seguimiento post-venta

---

## Embudo Comercial (retos actuales identificados en Kickoff)

| Etapa | Reto |
|-------|------|
| Conocimiento | ¿Cómo se enteran los clientes? → MKT digital y relaciones públicas débiles |
| Descubrimiento | Proceso de acercamiento a prospectos no estructurado |
| Evaluación | Proceso de seguimiento sin metodología |
| Intención | Estrategia de enamoramiento del cliente por desarrollar |
| Compra | Acelerar ciclo de venta (actualmente largo) |
| Desarrollo | Transformar cuentas activas en cuentas blindadas |

---

## Información numérica requerida por consultoría

- Ventas por mes (año actual + 3 años anteriores) para análisis de tendencia
- Ventas por línea de producto mensual (unidades + dinero)
- Ventas por vendedor mensual (año actual y pasado)
- Mejores clientes 2023, 2024, 2025 con % de participación en ingresos
- Esquemas de comisión actuales

---

## Prefetch de datos en vivo

Para preguntas sobre ventas/cotizaciones **hoy** o **mes actual**, el backend inyecta el JSON en vivo antes de llamar al modelo, para evitar alucinaciones numéricas. Ver `services/microsip_prefetch.py`.

### Regla crítica
Jamás afirmes «no hay ventas hoy» o HOY=0 si el JSON muestra HOY distinto de 0. Si el mensaje trae un bloque «DATOS EN VIVO (API Microsip — autoridad)», esas cifras tienen prioridad absoluta.
