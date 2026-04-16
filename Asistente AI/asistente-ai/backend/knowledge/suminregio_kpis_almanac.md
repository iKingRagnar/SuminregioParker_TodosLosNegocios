# SUMINREGIO — Almanaque de KPIs y Dashboards

Referencia rápida de los 16 dashboards del sistema BI de Suminregio.
URL base: `https://suminregioparker-todoslosnegocios.onrender.com/`

---

## 1. Dashboard Ventas (`ventas.html`)

**Pregunta que responde**: ¿Cuánto vendemos hoy, este mes y cómo vamos vs meta?

| KPI | Campo API | Semáforo |
|-----|-----------|----------|
| Ventas Hoy | `HOY` | Rojo si = 0 en día hábil |
| Ventas Mes | `MES_ACTUAL` | vs Meta diaria × días transcurridos |
| Remisiones Hoy | `REMISIONES_HOY` | Monitora pipeline no facturado |
| Ticket Promedio | `MES_ACTUAL / FACTURAS_MES` | Tendencia de mezcla |
| Top Vendedor | `/api/director/vendedores` | Ranking por importe |

**Endpoints**: `/api/ventas/resumen`, `/api/ventas/diarias`, `/api/ventas/mensuales`, `/api/director/vendedores`

---

## 2. Dashboard Cuentas por Cobrar (`cc.html` / `cxc.html`)

**Pregunta**: ¿Cuánto nos deben y cuánto está vencido?

| KPI | Descripción | Semáforo |
|-----|-------------|----------|
| Saldo Total CXC | Total cartera activa | Referencia |
| Cartera Vencida | Saldo con días > 0 | Rojo > 20% del total |
| DSO | Días promedio de cobro | Rojo > 60 días |
| Aging Buckets | 0-30, 31-60, 61-90, +90 días | +90 días = acción urgente |

**Fórmula DSO**: (CXC total / Ventas últimos 90d) × 90
**Endpoints**: `/api/cxc/resumen`, `/api/cxc/aging`, `/api/cxc/top-deudores`

---

## 3. Dashboard Scorecard (`scorecard.html`)

**Pregunta**: ¿Cómo están todos los vendedores vs su meta?

| KPI | Descripción |
|-----|-------------|
| Cumplimiento % | Ventas reales / Meta × 100 |
| Ranking | Posición por importe del mes |
| Tendencia MoM | Comparación vs mes anterior |

**Emblema**: 🥇🥈🥉 para top 3. Badge rojo si < 70% de meta.
**Endpoints**: `/api/director/vendedores`, `/api/ventas/resumen`

---

## 4. Dashboard Correlación (`correlacion.html`)

**Pregunta**: ¿Hay relación entre ventas y gastos? ¿Qué variables se mueven juntas?

| Visual | Descripción |
|--------|-------------|
| Scatter plot | Ventas vs Gastos por mes (puntos + tendencia) |
| Regresión lineal | y = a + bx — qué tan fuerte es la relación |
| R² | 0 = sin correlación, 1 = correlación perfecta |
| Ratio mensual | Gastos / Ventas × 100% — debe estar < 30% idealmente |

**Endpoints**: `/api/ventas/mensuales`, `/api/gastos/mensuales`

---

## 5. Dashboard Comisiones (`comisiones.html`)

**Pregunta**: ¿Cuánto de comisión corresponde a cada vendedor?

KPIs: comisión calculada, base de ventas, % comisión, comparación vs mes anterior.

---

## 6. Dashboard Estacionalidad (`estacionalidad.html`)

**Pregunta**: ¿Cuáles son los meses buenos y los meses malos históricamente?

| Visual | Descripción |
|--------|-------------|
| Mapa de calor | Mes × Año → intensidad = ventas |
| Índice estacional | Mes / promedio anual — > 1.2 = mes alto, < 0.8 = mes bajo |
| YoY comparación | Mismo mes año anterior |

---

## 7. Dashboard Clientes (`clientes.html`)

**Pregunta**: ¿Quiénes son los clientes clave y cómo están comprando?

| KPI | Descripción |
|-----|-------------|
| Pareto clientes | 20% de clientes = 80% de ventas |
| Ticket promedio por cliente | Segmentación por tamaño |
| Clientes nuevos vs recurrentes | Retención |
| Concentración HHI | Riesgo de dependencia (HHI > 0.25 = crítico) |

**Endpoints**: `/api/ventas/top-clientes`, `/api/ventas/ranking-clientes`

---

## 8. Dashboard Alertas (`alertas.html`)

**Pregunta**: ¿Qué anomalías o situaciones críticas hay ahora mismo?

Alertas automáticas detectadas:
- Ventas HOY = 0 en día hábil
- CXC vencida > 40% del total
- Cliente con DSO > 90 días
- Stock = 0 en artículo activo
- Vendedor < 70% de meta a mitad de mes

---

## 9. Dashboard Rentabilidad (`rentabilidad.html`)

**Pregunta**: ¿Cuánto margen bruto generamos y cuál línea es más rentable?

| KPI | Fórmula |
|-----|---------|
| Margen Bruto % | (Ventas - Costo) / Ventas × 100 |
| Rentabilidad por vendedor | Margen que genera cada ejecutivo |
| Mix de productos | % ventas por línea de alto/bajo margen |

**Endpoints**: `/api/ventas/margen`

---

## 10. Dashboard DSO (`dso.html`)

**Pregunta**: ¿En cuántos días cobramos en promedio y quiénes pagan tarde?

KPIs: DSO promedio, DSO por cliente, tendencia histórica, clientes > 60 días.

---

## 11. Dashboard Cuentas por Pagar (`cp.html`)

**Pregunta**: ¿Cuánto le debemos a proveedores y cuándo vence?

KPIs: CXP total, vencida, por vencer, aging de proveedores, días promedio de pago.

---

## 12. Dashboard Flujo de Efectivo (`flujo.html`)

**Pregunta**: ¿Cuál es el flujo de caja proyectado?

Combina: cobros esperados (CXC por vencer) - pagos esperados (CXP por vencer).

---

## 13. Dashboard ABC Inventario (`abc.html`)

**Pregunta**: ¿Qué artículos son A (críticos), B (importantes), C (de bajo impacto)?

| Segmento | Criterio | Gestión |
|----------|----------|---------|
| A | Top 20% por valor | Control estricto, revisión diaria |
| B | Siguiente 30% | Revisión semanal |
| C | Último 50% | Revisión mensual, evaluar descontinuar |

---

## 14. Dashboard Rotación (`rotacion.html`)

**Pregunta**: ¿Qué tan rápido se mueve el inventario?

| KPI | Fórmula | Benchmark |
|-----|---------|-----------|
| Rotación | Costo ventas / Inventario promedio | Mayor = mejor |
| Días de Inventario | 365 / Rotación | < 45 días = ágil |
| Fill Rate | % pedidos surtidos completos | > 95% = excelente |

---

## 15. Dashboard Rotación Profundo (`rotacion_profundo.html`)

**Pregunta**: Rotación a nivel de artículo individual con análisis de obsolescencia.

Adicional vs Rotación base: artículos sin movimiento > 90 días, riesgo de obsolescencia, costo del inventario detenido.

---

## 16. Dashboard Compras (`compras.html`)

**Pregunta**: ¿Qué compramos, a quién y cuánto?

| KPI | Descripción |
|-----|-------------|
| Total compras periodo | Valor total de entradas de proveedor |
| Top proveedores | Pareto de proveedores por monto |
| Compras vs presupuesto | Desviación del plan |
| Tiempo de entrega | Lead time promedio por proveedor |

---

## Scorecard Global (`universe/scorecard`)

Endpoint especial que retorna todas las empresas del grupo en paralelo:
`GET /api/universe/scorecard?anio=2026&mes=4`

Responde: ventas HOY y MES para cada una de las 14 empresas del grupo.

---

## Umbrales de Semáforo — Referencia Rápida

| Métrica | Verde | Amarillo | Rojo |
|---------|-------|----------|------|
| DSO (días) | < 30 | 30-60 | > 60 |
| CXC vencida % | < 10% | 10-20% | > 20% |
| Fill Rate % | > 95% | 85-95% | < 85% |
| Margen Bruto % | > 30% | 20-30% | < 20% |
| Cumplimiento Meta % | > 90% | 70-90% | < 70% |
| Días inventario | < 45 | 45-90 | > 90 |
| Concentración HHI | < 0.10 | 0.10-0.25 | > 0.25 |
| Variación ventas MoM | > 0% | -10% a 0% | < -10% |

---

## Contexto Empresarial del Grupo

El Grupo Suminregio opera 14 unidades de negocio con el mismo ERP Microsip/Firebird.
La empresa principal es **Suminregio Parker (db=default)**.

Distribución del grupo:
- Industrial/Distribución: Suminregio Parker, Parker MFG, Nortex, Lagor, Mafra
- Materiales: Cartón, Maderas, Reciclaje
- Servicios: Agua, Suministros Médicos
- Regional: Roberto GZZ, Robin, Paso, SP Paso
- Consolidado: Grupo Suminregio (holding)

Para análisis consolidado → `/api/universe/scorecard`
Para análisis individual → `?db=nombre_empresa`
