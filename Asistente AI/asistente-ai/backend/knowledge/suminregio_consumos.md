# SUMINREGIO — Dashboard de Consumos (consumos.html)

## ¿Qué es consumos.html?

El dashboard de **Consumos & Abastecimiento** mide el ritmo operativo de materiales dentro del grupo.
Responde la pregunta: **"¿qué se está consumiendo, a qué velocidad, y tenemos suficiente?"**

URL: `https://suminregioparker-todoslosnegocios.onrender.com/consumos.html?db=default&anio=AAAA&mes=M&preset=mes`

---

## KPIs Principales (strip de 8 métricas)

| KPI | Descripción | Semáforo |
|-----|-------------|----------|
| **Consumo Hoy** | Valor consumido en el día actual | Rojo si = 0 en día hábil |
| **Consumo Periodo** | Total del mes filtrado + delta vs mes anterior | Verde >0%, Rojo si caída |
| **Ritmo Diario** | Promedio de consumo por día hábil del periodo | Referencia de velocidad operativa |
| **Pico Máximo** | Día de mayor consumo en el periodo (valor + fecha) | Outlier detector |
| **Artículos Activos** | Número de SKUs con al menos 1 movimiento | Diversidad de consumo |
| **Alertas Quiebre** | Artículos en stock 0 que siguen en consumo activo | 🚨 Rojo si > 0 |
| **Concentración Top 5** | % del consumo total en los 5 artículos más consumidos | Riesgo si > 60% |
| **Variación Semanal** | Comparación semana actual vs semana anterior | Detecta cambios de ritmo |

---

## Visualizaciones Clave

### 1. Tendencia Diaria (line chart)
- Consumo por día del periodo
- **Moving average 7 días** (línea punteada) para suavizar ruido
- Detecta: tendencias al alza/baja, días pico, quiebres de patrón

### 2. Pareto Top Artículos (horizontal bar chart)
- Top 15 artículos por valor consumido
- Chips informativos: "El 20% de artículos genera el X% del consumo"
- Análisis ABC automático: A (≥80%), B (80-95%), C (<5%)

### 3. Quiebres Grid
- Tarjeta por artículo en quiebre o cobertura crítica
- Colores:
  - 🔴 Rojo: sin stock, en consumo activo (quiebre real)
  - 🟡 Amarillo: cobertura < 7 días (riesgo inminente)
  - 🟢 Verde: cobertura ≥ 7 días (monitoreo)
- Badge: días de cobertura restante

### 4. Pedidos vs Consumo (tabla de cobertura)
- Por artículo: unidades pedidas, consumidas, cobertura %
- Colores de cobertura: verde ≥100%, amarillo 50-100%, rojo <50%
- Brecha: diferencia pedido-consumo (positivo = exceso OC, negativo = faltante)

### 5. Análisis por Vendedor
- Quién genera más consumo (movimiento de materiales por responsable)
- Medallas 🥇🥈🥉 para top 3
- Progress bar normalizado al máximo

### 6. Matriz Semanal (collapsible, lazy-loaded)
- Consumo por artículo × semana del periodo
- Se carga solo cuando el usuario expande la sección (evita bloqueo de UI)

---

## Endpoints API de Consumos

```
GET /api/consumos/resumen?db=default&anio=2026&mes=4
→ Resumen del periodo: total, ritmo, pico, artículos activos

GET /api/consumos/diario?db=default&anio=2026&mes=4
→ Consumo por día (array [{fecha, total}])

GET /api/consumos/top?db=default&anio=2026&mes=4
→ Top artículos por valor (array [{clave, nombre, total, unidades}])

GET /api/consumos/insights?db=default&anio=2026&mes=4
→ {alertas_criticas: [{articulo, dias_sin_stock}], concentracion_top5, variacion_semanal}

GET /api/consumos/oc?db=default&anio=2026&mes=4
→ Pedidos vs consumo por artículo [{articulo, pedido, consumido, cobertura_pct, brecha}]

GET /api/consumos/vendedores?db=default&anio=2026&mes=4
→ Consumo por vendedor/responsable

GET /api/consumos/semanal?db=default&anio=2026&mes=4
→ Matriz semanal (pesada, se llama lazy)
```

---

## Métricas Estadísticas Clave

**Cobertura de Inventario** = Stock actual / Ritmo diario
- > 30 días: cómodo ✅
- 15-30 días: vigilar ⚠️
- 7-15 días: crítico 🟠
- < 7 días: quiebre inminente 🔴

**Concentración Pareto**:
- Si top 5 artículos > 70% del consumo → riesgo de dependencia
- Revisar plan de abasto para esos 5 SKUs con prioridad máxima

**Variación Semanal (semáforo)**:
- +10% o más: posible campaña, proyecto especial o temporada alta
- -10% o menos: revisar si hay pausa operativa o falta de materiales
- ±10%: operación estable

---

## Contexto de Negocio

El dashboard de consumos es crítico para:
1. **Control de abastecimiento**: detectar antes que llegue a quiebre
2. **Planeación de compras**: ritmo diario → proyección de necesidades
3. **Trazabilidad operativa**: quién consume qué y cuándo
4. **Optimización de inventario**: reducir excedentes y eliminar quiebres simultáneamente

---

## Instrucciones para el Asistente

Cuando el usuario pregunte sobre consumos:
- Siempre referencia el ritmo diario para proyectar necesidades futuras
- Si hay quiebres, DILO con urgencia y lista los artículos específicos
- Sugiere cruzar consumo vs OC pendientes para calcular cobertura real
- El análisis Pareto es clave: el 20% de SKUs = 80% del valor, ahí enfocar atención
- Si piden "¿cuánto dura el stock?": usa ritmo diario como divisor
