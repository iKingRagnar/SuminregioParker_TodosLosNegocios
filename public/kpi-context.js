/**
 * kpi-context.js — Contexto en cada visual: "qué es" + "cómo se calcula".
 *
 * Cubre las dos formas que pidió el usuario:
 *   (2) Tooltip ⓘ  → ícono junto al label; al pasar el mouse / tocar muestra
 *                     qué es el KPI y cómo se calcula (fórmula real).
 *   (3) Texto fijo → una línea compacta "ƒ …" siempre visible bajo el número
 *                     con la fórmula resumida.
 *
 * No edita cada página: corre en runtime, detecta los KPIs por el TEXTO de su
 * label (las clases son inconsistentes a lo largo del proyecto) y los anota.
 * Idempotente + MutationObserver para KPIs que se renderizan por JS.
 * Sólo anota lo que está en el diccionario; lo desconocido se deja intacto.
 */
(function () {
  'use strict';
  if (window.__sumiKpiContext) return;
  window.__sumiKpiContext = true;

  /* ── Normalización de texto de label ──────────────────────────────────────
     "Cotiz. del Día" → "cotiz del dia" · "% Vencido" → "vencido" ·
     "Venta Industrial (VE)" → "venta industrial"                              */
  function norm(s) {
    return (s || '')
      .replace(/ /g, ' ')
      .replace(/\([^)]*\)/g, ' ')                 // quita parentéticos (VE),(≤30d)…
      .replace(/[²₂]/g, '2').replace(/[³₃]/g, '3')  // superíndices: R² → r2
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
      .toLowerCase()
      .replace(/[^a-z0-9ñ ]+/g, ' ')              // fuera emojis, ▪, →, símbolos, %, $…
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ── Diccionario de KPIs: clave normalizada → { what, how } ────────────────
     what = qué es / para qué sirve (1 frase).  how = cómo se calcula (fórmula).
     Las fórmulas siguen las definiciones de negocio del servidor (SAE/Microsip):
       Margen Bruto % = Utilidad Bruta ÷ Ventas Netas × 100, etc.              */
  var D = {
    // ── Etiquetas cortas de tarjetas densas (multi-empresa / módulos) ────────
    'periodo':            { what: 'Ventas netas del periodo seleccionado.', how: 'Σ facturas del rango, sin IVA.' },
    'hoy':                { what: 'Ventas netas de hoy.', how: 'Σ facturas del día actual, sin IVA.' },
    'cxc':                { what: 'Cartera por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'mes':                { what: 'Ventas netas del mes en curso.', how: 'Σ facturas del 1° del mes a hoy, sin IVA.' },
    // ── Ventas ──────────────────────────────────────────────────────────────
    'venta del dia':      { what: 'Facturación neta de hoy.', how: 'Σ facturas del día actual, sin IVA.' },
    'ventas hoy':         { what: 'Facturación neta de hoy.', how: 'Σ facturas del día actual, sin IVA.' },
    'venta del mes':      { what: 'Facturación neta acumulada del mes en curso.', how: 'Σ facturas del 1° del mes a hoy, sin IVA.' },
    'venta mes':          { what: 'Facturación neta del mes en curso.', how: 'Σ facturas del 1° del mes a hoy, sin IVA.' },
    'ventas mes':         { what: 'Facturación neta del mes en curso.', how: 'Σ facturas del 1° del mes a hoy, sin IVA.' },
    'importe mes':        { what: 'Facturación neta del mes en curso.', how: 'Σ facturas del mes, sin IVA.' },
    'venta total':        { what: 'Facturación neta del periodo filtrado.', how: 'Σ importes facturados − devoluciones, sin IVA.' },
    'venta neta':         { what: 'Facturación neta del periodo.', how: 'Ventas − devoluciones − descuentos, sin IVA.' },
    'ventas netas':       { what: 'Facturación neta del periodo.', how: 'Ventas − devoluciones − descuentos, sin IVA.' },
    'ventas':             { what: 'Facturación del periodo.', how: 'Σ facturas del periodo, sin IVA.' },
    'venta industrial':   { what: 'Ventas de línea industrial (facturas VE).', how: 'Σ documentos tipo Venta (VE) del periodo.' },
    'industrial':         { what: 'Ventas de línea industrial (facturas VE).', how: 'Σ documentos tipo Venta (VE) del periodo.' },
    'total combinado':    { what: 'Venta total (industrial + mostrador).', how: 'Venta industrial (VE) + venta mostrador (PV).' },
    'facturas':           { what: 'Número de facturas del periodo.', how: 'Conteo de documentos de venta emitidos.' },
    'facturas mes':       { what: 'Número de facturas del mes.', how: 'Conteo de facturas emitidas en el mes.' },
    'documentos':         { what: 'Número de documentos del periodo.', how: 'Conteo de documentos emitidos en el rango.' },
    'ventas de mostrador':{ what: 'Ventas de mostrador / punto de venta.', how: 'Σ tickets de punto de venta (PV) del periodo.' },
    'mostrador':          { what: 'Ventas de mostrador / punto de venta.', how: 'Σ tickets de punto de venta (PV) del periodo.' },
    'pv':                 { what: 'Ventas de mostrador / punto de venta.', how: 'Σ tickets de punto de venta (PV) del periodo.' },
    've':                 { what: 'Ventas de línea industrial (facturas VE).', how: 'Σ documentos tipo Venta (VE) del periodo.' },
    'venta en riesgo':    { what: 'Venta expuesta a perderse.', how: 'Σ ventas de clientes marcados en riesgo de fuga.' },
    'ticket promedio':    { what: 'Importe promedio por factura.', how: 'Ventas del periodo ÷ número de facturas.' },
    'ticket prom':        { what: 'Importe promedio por factura.', how: 'Ventas del periodo ÷ número de facturas.' },
    'prom diario':        { what: 'Venta promedio por día.', how: 'Ventas del periodo ÷ días con venta.' },

    // ── Cotizaciones ────────────────────────────────────────────────────────
    'cotiz del dia':      { what: 'Monto cotizado hoy.', how: 'Σ cotizaciones emitidas el día de hoy.' },
    'cotiz hoy':          { what: 'Monto cotizado hoy.', how: 'Σ cotizaciones emitidas el día de hoy.' },
    'cotiz mes':          { what: 'Monto cotizado en el mes.', how: 'Σ cotizaciones emitidas del 1° del mes a hoy.' },
    'cotiz periodo':      { what: 'Monto cotizado en el periodo.', how: 'Σ cotizaciones emitidas en el rango.' },
    'cotiz':              { what: 'Monto cotizado en el periodo.', how: 'Σ cotizaciones emitidas en el rango.' },
    'conversion':         { what: 'Qué % de lo cotizado se vuelve venta.', how: 'Ventas ÷ cotizaciones del periodo × 100.' },
    'conv coti':          { what: 'Qué % de lo cotizado se vuelve venta.', how: 'Ventas ÷ cotizaciones del periodo × 100.' },
    'conv estimada':      { what: 'Conversión esperada de cotización a venta.', how: 'Ventas ÷ cotizaciones (estimado) × 100.' },
    'relacion v cxc':     { what: 'Ventas del mes frente a la cartera por cobrar.', how: 'Ventas del mes ÷ saldo total de CxC.' },

    // ── CxC / Cartera ─────────────────────────────────────────────────────────
    'saldo total cxc':    { what: 'Cartera total por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'saldo cxc total':    { what: 'Cartera total por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'cartera total':      { what: 'Cartera total por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'total cartera':      { what: 'Cartera total por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'cartera':            { what: 'Cartera por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'total por cobrar':   { what: 'Cartera total por cobrar a clientes.', how: 'Σ saldos pendientes de facturas abiertas.' },
    'clientes que me deben': { what: 'Clientes con saldo pendiente.', how: 'Conteo de clientes con saldo > 0.' },
    'vencido':            { what: 'Cartera ya vencida (pasó su fecha de pago).', how: 'Σ saldos con días de vencido > 0.' },
    'total vencido':      { what: 'Cartera ya vencida en total.', how: 'Σ saldos con días de vencido > 0.' },
    'exposicion vencida': { what: 'Monto expuesto ya vencido.', how: 'Σ saldos vencidos de la cartera.' },
    'vencido prom sem':   { what: 'Vencido promedio por semana.', how: 'Promedio del saldo vencido por semana del periodo.' },
    'vigente':            { what: 'Cartera aún dentro de plazo.', how: 'Σ saldos cuya fecha de pago no ha llegado.' },
    'no vencido':         { what: 'Cartera aún dentro de plazo.', how: 'Σ saldos cuya fecha de pago no ha llegado.' },
    'por vencer':         { what: 'Cartera próxima a vencer, aún vigente.', how: 'Σ saldos con fecha de pago futura.' },
    'por vencer vigente': { what: 'Cartera próxima a vencer, aún vigente.', how: 'Σ saldos con fecha de pago futura.' },
    'dso global':         { what: 'Días promedio que tardas en cobrar (DSO).', how: '(Cartera ÷ ventas a crédito) × días del periodo.' },
    'dso':                { what: 'Días promedio que tardas en cobrar (DSO).', how: '(Cartera ÷ ventas a crédito) × días del periodo.' },
    'salud cartera':      { what: 'Qué tan sana está la cartera.', how: 'Cartera vigente ÷ cartera total × 100.' },
    'capital en riesgo':  { what: 'Saldo expuesto en clientes de alto riesgo.', how: 'Σ saldo vencido de clientes en alerta.' },
    'costo de capital':   { what: 'Costo financiero de la cartera vencida.', how: 'Saldo vencido × tasa × días ÷ 360.' },
    'atraso promedio':    { what: 'Días promedio de atraso al pagar.', how: 'Promedio de días vencidos ponderado por saldo.' },
    'atraso comercial':   { what: 'Atraso comercial de la cartera.', how: 'Promedio de días vencidos de las facturas abiertas.' },

    // ── Cobranza ──────────────────────────────────────────────────────────────
    'cobrado':            { what: 'Dinero efectivamente cobrado en el periodo.', how: 'Σ pagos aplicados a facturas del rango.' },
    'cobros':             { what: 'Dinero efectivamente cobrado en el periodo.', how: 'Σ pagos aplicados a facturas del rango.' },
    'cobros recibidos':   { what: 'Dinero efectivamente cobrado en el periodo.', how: 'Σ pagos aplicados a facturas del rango.' },
    'total cobrado':      { what: 'Total cobrado en el periodo.', how: 'Σ pagos aplicados a facturas del rango.' },
    'total cobrado del mes': { what: 'Total cobrado en el mes.', how: 'Σ pagos aplicados a facturas del mes.' },
    'cobrado relativo':   { what: 'Cobrado frente a lo facturado.', how: 'Total cobrado ÷ total facturado × 100.' },
    'ticket promedio cobrado': { what: 'Cobro promedio por documento.', how: 'Total cobrado ÷ número de cobros.' },
    'que me pagan a tiempo': { what: 'Puntualidad de pago de los clientes.', how: 'Facturas pagadas antes de vencer ÷ pagadas × 100.' },
    'total facturado':    { what: 'Base de facturación del periodo.', how: 'Σ importe de facturas emitidas en el rango.' },
    'total depositos':    { what: 'Depósitos recibidos en el periodo.', how: 'Σ movimientos de entrada de efectivo.' },
    'total retiros':      { what: 'Retiros / salidas de efectivo.', how: 'Σ movimientos de salida de efectivo.' },
    'flujo neto':         { what: 'Efectivo neto del periodo.', how: 'Depósitos − retiros del periodo.' },

    // ── Inventario ────────────────────────────────────────────────────────────
    'valor inventario':   { what: 'Valor del inventario a costo.', how: 'Σ (existencia × costo unitario) por artículo.' },
    'valor inventario actual': { what: 'Valor del inventario a costo, hoy.', how: 'Σ (existencia actual × costo unitario).' },
    'valor en stock':     { what: 'Valor del inventario a costo.', how: 'Σ (existencia × costo unitario) por artículo.' },
    'total inventario':   { what: 'Valor del inventario a costo.', how: 'Σ (existencia × costo unitario) por artículo.' },
    'dias de inventario': { what: 'Días que dura el inventario al ritmo de venta.', how: '(Inventario ÷ costo de ventas) × días del periodo.' },
    'rotacion mensual':   { what: 'Veces que rota el inventario al mes.', how: 'Costo de ventas del mes ÷ inventario promedio.' },
    'rotacion':           { what: 'Veces que rota el inventario.', how: 'Costo de ventas ÷ inventario promedio.' },
    'bajo minimo':        { what: 'Artículos por debajo de su mínimo.', how: 'Conteo de SKUs con existencia < punto de reorden.' },
    'bajo min':           { what: 'Artículos por debajo de su mínimo.', how: 'Conteo de SKUs con existencia < punto de reorden.' },
    'sin stock':          { what: 'Artículos agotados.', how: 'Conteo de SKUs con existencia = 0.' },
    'sin movimiento':     { what: 'Artículos sin ventas en el periodo.', how: 'SKUs sin salidas en el rango analizado.' },
    'nunca vendidos':     { what: 'Artículos que nunca se han vendido.', how: 'SKUs sin ninguna venta histórica.' },
    'articulos':          { what: 'Artículos en el catálogo / análisis.', how: 'Conteo de SKUs considerados.' },
    'total articulos':    { what: 'Total de artículos del catálogo.', how: 'Conteo de SKUs activos.' },
    'articulos con stock':{ what: 'Artículos con existencia disponible.', how: 'Conteo de SKUs con existencia > 0.' },
    'articulos en stock': { what: 'Artículos con existencia disponible.', how: 'Conteo de SKUs con existencia > 0.' },
    'articulos vendidos': { what: 'Artículos con al menos una venta.', how: 'Conteo de SKUs con ventas en el periodo.' },
    'alta rotacion':      { what: 'Artículos que rotan muy rápido.', how: 'SKUs con días de inventario ≤ 30.' },
    'clase a':            { what: 'Artículos que concentran ~80% del valor (Pareto).', how: 'Ordena por venta y acumula hasta el 80%.' },
    'clase b':            { what: 'Artículos del siguiente ~15% del valor.', how: 'Acumulado de venta entre 80% y 95%.' },
    'clase c':            { what: 'Artículos del 5% final del valor.', how: 'Acumulado de venta sobre el 95%.' },
    'articulos abc':      { what: 'Artículos clasificados por importancia (ABC).', how: 'Clasificación Pareto A/B/C por venta.' },

    // ── Clientes ──────────────────────────────────────────────────────────────
    'total clientes':     { what: 'Clientes con actividad en el periodo.', how: 'Conteo distinto de clientes con venta.' },
    'clientes':           { what: 'Clientes considerados.', how: 'Conteo distinto de clientes.' },
    'activos':            { what: 'Clientes que compraron recientemente.', how: 'Clientes con compra en los últimos 30 días.' },
    'clientes alerta':    { what: 'Clientes que requieren atención.', how: 'Clientes con saldo vencido o sin compra reciente.' },
    'clientes en riesgo': { what: 'Clientes con riesgo de fuga o mora.', how: 'Clientes con caída de compra o saldo vencido.' },
    'clientes en rojo':   { what: 'Clientes con saldo vencido.', how: 'Conteo de clientes con factura vencida.' },
    'clientes con mora':  { what: 'Clientes con pagos atrasados.', how: 'Conteo de clientes con saldo vencido.' },
    'inactivos':          { what: 'Clientes sin compra reciente.', how: 'Sin compra en 30/60/90+ días según segmento.' },
    'inactivos ventas':   { what: 'Clientes que dejaron de comprar.', how: 'Sin ventas en el periodo de corte.' },
    'dormidos':           { what: 'Clientes adormecidos (61–90 días sin comprar).', how: 'Última compra hace 61–90 días.' },
    'perdidos':           { what: 'Clientes perdidos (90+ días sin comprar).', how: 'Última compra hace más de 90 días.' },
    'nuevos':             { what: 'Clientes que compraron por primera vez.', how: 'Primera factura dentro del periodo.' },
    'pot reactivacion':   { what: 'Venta potencial al reactivar dormidos.', how: 'Σ venta histórica de clientes inactivos.' },

    // ── P&L / Resultados ──────────────────────────────────────────────────────
    'margen bruto':       { what: 'Rentabilidad sobre ventas.', how: 'Utilidad bruta ÷ ventas netas × 100.' },
    'margen bruto actual':{ what: 'Rentabilidad sobre ventas, al corte.', how: 'Utilidad bruta ÷ ventas netas × 100.' },
    'margen':             { what: 'Rentabilidad sobre ventas.', how: 'Utilidad bruta ÷ ventas netas × 100.' },
    'utilidad bruta':     { what: 'Ganancia tras el costo de ventas.', how: 'Ventas netas − costo de ventas.' },
    'utilidad':           { what: 'Ganancia del periodo.', how: 'Ventas netas − costo de ventas.' },
    'utilidad real':      { what: 'Ganancia real tras costos.', how: 'Ventas netas − costo de ventas − ajustes.' },
    'costo de ventas':    { what: 'Costo de la mercancía vendida.', how: 'Σ costo de los artículos facturados.' },
    'ratio gasto venta':  { what: 'Qué parte de la venta se va en gastos.', how: 'Gastos operativos ÷ ventas × 100.' },
    'eficiencia operativa': { what: 'Qué tan eficiente es la operación.', how: 'Utilidad operativa ÷ ventas × 100.' },
    'variacion mom':      { what: 'Cambio vs el mes anterior.', how: '(Mes actual − mes previo) ÷ mes previo × 100.' },
    'variacion yoy':      { what: 'Cambio vs el mismo mes del año pasado.', how: '(Mes actual − mismo mes año ant.) ÷ ese mes × 100.' },

    // ── Compras / CxP ─────────────────────────────────────────────────────────
    'total compras':      { what: 'Compras del periodo.', how: 'Σ importe de facturas de proveedor.' },
    'compras':            { what: 'Compras del periodo.', how: 'Σ importe de facturas de proveedor.' },
    'deuda total':        { what: 'Saldo por pagar a proveedores (CxP).', how: 'Σ saldos pendientes con proveedores.' },
    'proveedores':        { what: 'Proveedores con actividad.', how: 'Conteo de proveedores con compras o saldo.' },
    'prom dias s compra': { what: 'Días promedio sin comprar.', how: 'Promedio de días desde la última compra.' },

    // ── Comisiones / Vendedores ───────────────────────────────────────────────
    'comisiones':         { what: 'Comisiones generadas por cobro.', how: '% de comisión × monto cobrado del vendedor.' },
    'comision':           { what: 'Comisión del periodo.', how: '% de comisión × monto cobrado.' },
    'total comisiones':   { what: 'Comisiones totales (8% sobre cobro).', how: '8% × monto cobrado del periodo.' },
    'vendedores activos': { what: 'Vendedores con ventas en el periodo.', how: 'Conteo distinto de vendedores con venta.' },
    'vendedores':         { what: 'Vendedores del equipo.', how: 'Conteo de vendedores con actividad.' },
    'equipo':             { what: 'Cumplimiento del equipo.', how: 'Vendedores en meta ÷ total del equipo × 100.' },

    // ── Metas ─────────────────────────────────────────────────────────────────
    'meta diaria':        { what: 'Objetivo de venta diario.', how: 'Meta mensual ÷ días hábiles del mes.' },
    'meta dia':           { what: 'Objetivo de venta diario.', how: 'Meta mensual ÷ días hábiles del mes.' },
    'meta mes':           { what: 'Objetivo de venta del mes.', how: 'Definido en Metas / Objetivos.' },
    'meta cotiz':         { what: 'Objetivo de cotización del periodo.', how: 'Definido en Metas / Objetivos.' },
    'cumplimiento':       { what: 'Avance frente a la meta.', how: 'Real ÷ meta × 100.' },
    'meta mes cumpl':     { what: 'Cumplimiento de la meta del mes.', how: 'Venta del mes ÷ meta del mes × 100.' },

    // ── Correlación / estadística (dashboards) ────────────────────────────────
    'coeficiente r2':     { what: 'Qué tan fuerte es la relación (0–1).', how: 'R² de la regresión lineal entre las variables.' },
    'intercepto':         { what: 'Valor base cuando x = 0.', how: 'Término independiente α de la recta y = α + βx.' },
    'pendiente':          { what: 'Cuánto cambia y por cada unidad de x.', how: 'Coeficiente β de la recta y = α + βx.' },
    'interpretacion':     { what: 'Lectura en lenguaje simple del resultado.', how: 'Traduce el R²/β a una conclusión de negocio.' },
    'meses analizados':   { what: 'Cuántos meses entran en el análisis.', how: 'Conteo de periodos mensuales con datos.' },
    'tendencia ratio':    { what: 'Hacia dónde va la relación gasto/venta.', how: 'Pendiente del ratio a lo largo del tiempo.' },

    // ── Consumos / abastecimiento ─────────────────────────────────────────────
    'brecha total':       { what: 'Brecha entre lo que se consume y lo cubierto.', how: 'Consumo proyectado − stock/cobertura disponible.' },
    'cobertura general':  { what: 'Cuánto cubre el stock al consumo.', how: 'Stock disponible ÷ consumo promedio diario.' },
    'concentracion top 5':{ what: 'Qué % del consumo está en el top 5.', how: 'Consumo de los 5 mayores ÷ consumo total × 100.' },
    'consumo top':        { what: 'Artículo de mayor consumo.', how: 'Máximo Σ consumo por artículo del periodo.' },
    'pedido top':         { what: 'Pedido/compra de mayor monto.', how: 'Máximo Σ importe por pedido del periodo.' },
    'stock minimo operativo': { what: 'Existencia mínima para operar sin quiebre.', how: 'Consumo diario × días de reposición objetivo.' },
    'variacion semanal':  { what: 'Cambio de consumo semana vs semana.', how: 'Consumo últimos 7d − 7d previos, en %.' },
    'vs periodo anterior':{ what: 'Cambio frente al periodo previo.', how: '(Actual − anterior) ÷ anterior × 100.' },

    // ── Vendedores (equipo / récords) ─────────────────────────────────────────
    'total equipo hoy':   { what: 'Venta de todo el equipo hoy.', how: 'Σ ventas de todos los vendedores del día.' },
    'total equipo mes':   { what: 'Venta de todo el equipo en el mes.', how: 'Σ ventas de todos los vendedores del mes.' },
    'mejor hoy':          { what: 'Mejor vendedor del día.', how: 'Vendedor con mayor venta hoy.' },
    'mejor mes ytd':      { what: 'Mejor mes en lo que va del año.', how: 'Mes con mayor venta acumulada (YTD).' },
    'ytd':                { what: 'Acumulado del año a la fecha (Year-To-Date).', how: 'Σ del 1° de enero a hoy.' },
    'vendedor top del mes':{ what: 'Vendedor líder del mes.', how: 'Vendedor con mayor venta del mes.' },

    // ── Riesgo / cartera (clientes, alertas) ──────────────────────────────────
    'monto critico':      { what: 'Saldo en mora severa (>90 días).', how: 'Σ saldo vencido a más de 90 días.' },
    'monto alto':         { what: 'Saldo en mora media (61–90 días).', how: 'Σ saldo vencido entre 61 y 90 días.' },
    'capital en riesgo':  { what: 'Saldo expuesto en clientes de alto riesgo.', how: 'Σ saldo vencido de clientes en alerta.' },
    'exposicion vencida': { what: 'Monto total expuesto ya vencido.', how: 'Σ saldos vencidos (leve+medio+alto+crítico).' },
    'en meta':            { what: 'Cuántos van cumpliendo su meta.', how: 'Conteo de elementos con avance ≥ 100%.' },
    'en riesgo':          { what: 'Elementos que requieren atención.', how: 'Conteo de los que cruzan el umbral de riesgo.' },
    'criticos':           { what: 'Casos en estado crítico.', how: 'Conteo de elementos marcados como críticos.' },
    'top10 venta':        { what: 'Qué % de la venta está en el top 10.', how: 'Venta de los 10 mayores ÷ venta total × 100.' },
    'pagos procesados':   { what: 'Pagos registrados en el periodo.', how: 'Conteo de pagos aplicados.' },
    'registros':          { what: 'Número de registros considerados.', how: 'Conteo de filas del análisis.' },
    'inventario activo total': { what: 'Peso del inventario en el activo.', how: 'Inventario ÷ activo total × 100.' },
    'costo total':        { what: 'Costo total del concepto.', how: 'Σ costo de los artículos o partidas.' },

    // ── Mejora continua / operación ───────────────────────────────────────────
    'total reportes':     { what: 'Total de reportes/incidencias.', how: 'Conteo de tickets registrados.' },
    'resueltos':          { what: 'Casos ya resueltos.', how: 'Conteo de tickets cerrados.' },
    'en revision':        { what: 'Casos en revisión.', how: 'Conteo de tickets en proceso.' },
    'p1 p2 criticos altos': { what: 'Incidencias críticas y altas (P1+P2).', how: 'Conteo de tickets de prioridad 1 y 2.' },
    'mttr':               { what: 'Tiempo medio de resolución de incidentes.', how: 'Promedio de horas entre apertura y cierre.' },
    'cumplimiento sla':   { what: 'Qué % de casos cumple el SLA.', how: 'Casos dentro de SLA ÷ total × 100.' }
  };

  /* alias → clave canónica (variantes que no quiero duplicar arriba) */
  var ALIAS = {
    'venta industrial ve': 'venta industrial',
    'ventas de mostrador pv': 'ventas de mostrador',
    'saldo': 'saldo total cxc',
    'tasa': 'conversion',
    'cobrado del mes': 'total cobrado del mes',
    'activos 30d': 'activos',
    'dormidos 61 90d': 'dormidos',
    'perdidos 90 d': 'perdidos',
    'en riesgo 31 60d': 'clientes en riesgo',
    'clientes en riesgo cxc': 'clientes en riesgo',
    'p1 p2': 'p1 p2 criticos altos',
    'cotiz del mes': 'cotiz mes'
  };

  /* títulos de gráficas / paneles → contexto (sólo ⓘ, sin caption) */
  var CHARTS = {
    'tendencia de ventas':   { what: 'Evolución de la venta en el tiempo.', how: 'Σ ventas agrupadas por día o mes.' },
    'ranking vendedores':    { what: 'Vendedores ordenados por venta.', how: 'Σ ventas por vendedor, de mayor a menor.' },
    'ranking de vendedores': { what: 'Vendedores ordenados por venta.', how: 'Σ ventas por vendedor, de mayor a menor.' },
    'scorecard ejecutivo':   { what: 'Tablero de KPIs frente a sus metas.', how: 'Compara el valor real de cada KPI contra su meta.' },
    'universo de negocios':  { what: 'Resumen consolidado de todas las empresas.', how: 'Consolida los KPIs clave por empresa del grupo.' },
    'aging de cartera':      { what: 'Cartera por antigüedad de vencimiento.', how: 'Agrupa los saldos por tramos de días vencidos.' },
    'alertas del sistema':   { what: 'Avisos que requieren tu atención.', how: 'Reglas sobre ventas, cartera e inventario.' }
  };

  /* Patrones para títulos de gráficas/paneles: cubren el "largo tail" sin
     escribir cada título. Se prueban en orden cuando no hay match exacto.    */
  var CHART_PATTERNS = [
    [/aging|antiguedad/,                 'Cartera por antigüedad de vencimiento.', 'Agrupa los saldos por tramos de días vencidos.'],
    [/pareto|concentracion|curva de/,    'Regla 80/20: pocos concentran la mayoría.', 'Ordena por aporte y acumula el % del total.'],
    [/scatter|dispersion|correlacion/,   'Relación entre dos variables.', 'Cada punto es un periodo; la recta es la tendencia.'],
    [/proyeccion|forecast|fin de mes/,   'Estimación hacia el futuro.', 'Extrapola la tendencia reciente del periodo.'],
    [/matriz/,                           'Cruce de dos dimensiones.', 'Una dimensión en filas y otra en columnas.'],
    [/tendencia|evolucion|movil|acumulad/, 'Evolución de la métrica en el tiempo.', 'Valor agrupado por día, semana o mes.'],
    [/ranking|top \d|^top|mejores|menos rentables|lentos|mas\b/, 'Los primeros del ranking, ordenados.', 'Ordena por el valor y toma los primeros.'],
    [/distribucion|reparto|\bmix\b|por fuente|por tipo|por nivel|por estatus|por condicion|por bucket|bucket/, 'Cómo se reparte el total entre categorías.', '% que aporta cada categoría al total.'],
    [/comparativa|\bvs\b|versus|primera vs/, 'Comparación lado a lado.', 'Pone dos o más series juntas para contrastar.'],
    [/aging|cobranza|cobros|cobrado/,    'Dinero cobrado por periodo.', 'Σ pagos aplicados, agrupados por periodo.'],
    [/comision/,                         'Comisiones por vendedor o periodo.', '% de comisión × monto cobrado.'],
    [/rotacion|velocidad/,               'Qué tan rápido rota el inventario.', 'Costo de ventas ÷ inventario promedio.'],
    [/rentabilidad|margen|ratio/,        'Rentabilidad / ratios por segmento.', 'Utilidad ÷ ventas × 100 (o el ratio indicado).'],
    [/flujo|efectivo|saldos bancarios|bancos/, 'Movimiento de efectivo.', 'Entradas − salidas por periodo.'],
    [/dso|dias de cobro|dias de pago/,   'Velocidad de cobro a clientes.', 'Días promedio entre la venta y el pago.'],
    [/estacionalidad|dia de la semana|quincena|por dia del mes/, 'Patrón por día o temporada.', 'Promedia la métrica según el día o periodo.'],
    [/balance|activo|pasivo|estructura/, 'Situación financiera (balance).', 'Activo = pasivo + capital, al corte.'],
    [/consumo|cobertura|quiebre|stock minimo|bajo minimo/, 'Consumo y abasto de inventario.', 'Σ salidas frente a existencia y reposición.'],
    [/compras|proveedor/,                'Compras y proveedores.', 'Σ importe de compras por proveedor o periodo.'],
    [/cumplimiento|meta/,                'Avance frente a la meta.', 'Real ÷ meta × 100.'],
    [/causa raiz|prioridad|diagnostico|accion recomendada|seguimiento|modelo de mejora/, 'Apoyo de mejora continua (ITIL).', 'Estructura el análisis y la acción del caso.'],
    [/sin movimiento|nunca vendidos|capital por linea|valor en stock|por clasificacion/, 'Inventario por estado/clasificación.', 'Σ valor o existencia agrupada por clase.'],
    [/abc|linea|categoria/,              'Desglose por producto o línea.', 'Σ de la métrica agrupada por artículo/línea.'],
    [/vendedor|equipo/,                  'Desglose por vendedor.', 'Σ de la métrica agrupada por vendedor.'],
    [/deudor|deuda|debe|por cobrar|saldo|como pagan|comportamiento de pago/, 'Desglose por cliente y su saldo.', 'Σ saldo pendiente agrupado por cliente.'],
    [/cliente/,                          'Desglose por cliente.', 'Σ de la métrica agrupada por cliente.'],
    [/documento|factura|movimiento|detalle|tabla|listado|registr/, 'Desglose fila por fila del concepto.', 'Una fila por registro con sus columnas.'],
    [/estatus|estado|alertas|riesgo/,    'Estado actual y avisos.', 'Clasifica según reglas de negocio.'],
    [/cotiza|conversion/,                'Cotizaciones y su conversión.', 'Σ cotizaciones y % que pasa a venta.'],
    [/ventas|venta|facturacion/,         'Comportamiento de ventas.', 'Σ ventas agrupadas por la dimensión del eje.'],
    [/indicadores|metricas|resumen|analisis/, 'Resumen de indicadores del módulo.', 'Consolida los KPIs clave de la vista.']
  ];
  function matchChart(key) {
    if (!key) return null;
    if (CHARTS[key]) return CHARTS[key];
    for (var i = 0; i < CHART_PATTERNS.length; i++) {
      if (CHART_PATTERNS[i][0].test(key)) return { what: CHART_PATTERNS[i][1], how: CHART_PATTERNS[i][2] };
    }
    return null;
  }

  function lookup(key) {
    if (!key) return null;
    if (D[key]) return D[key];
    if (ALIAS[key] && D[ALIAS[key]]) return D[ALIAS[key]];
    // intento por prefijo (p.ej. "activos 30d" → "activos")
    var words = key.split(' ');
    while (words.length > 1) {
      words.pop();
      var pre = words.join(' ');
      if (D[pre]) return D[pre];
      if (ALIAS[pre] && D[ALIAS[pre]]) return D[ALIAS[pre]];
    }
    return null;
  }

  /* ── Estilos (inyectados; tema claro de lujo) ─────────────────────────────── */
  var CSS = [
    '.kpi-cx-i{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:5px;border-radius:50%;',
    'border:1px solid rgba(15,23,42,.22);color:#64748B;font-size:9px;line-height:1;font-style:normal;font-weight:700;cursor:help;',
    'vertical-align:middle;user-select:none;transition:all .15s ease;font-family:system-ui,-apple-system,sans-serif;background:rgba(255,255,255,.7);flex:none}',
    '.kpi-cx-i:hover,.kpi-cx-i:focus{background:#E6A800;border-color:#E6A800;color:#1A1200;outline:none}',
    '.kpi-cx-i::before{content:"i"}',
    '.kpi-cx-cap{margin-top:.32rem;font-family:"DM Mono","SFMono-Regular",ui-monospace,monospace;font-size:.58rem;line-height:1.35;',
    'color:#94A3B8;font-weight:500;letter-spacing:.01em;display:flex;gap:.3em;align-items:flex-start}',
    '.kpi-cx-cap b{color:#B8860B;font-weight:700;flex:none}',
    /* la fórmula SE ENVUELVE (no se trunca): así se lee completa y no parece "cortada" */
    '.kpi-cx-cap .cx-txt{white-space:normal;overflow-wrap:anywhere;min-width:0;flex:1}',
    /* tooltip flotante */
    '#kpi-cx-tip{position:fixed;z-index:99999;max-width:300px;background:#0F172A;color:#E5EDF7;border:1px solid rgba(230,168,0,.35);',
    'border-radius:12px;padding:11px 13px;box-shadow:0 18px 48px -12px rgba(15,23,42,.55);font-family:system-ui,-apple-system,sans-serif;',
    'font-size:.74rem;line-height:1.5;pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .14s ease,transform .14s ease}',
    '#kpi-cx-tip.on{opacity:1;transform:translateY(0)}',
    '#kpi-cx-tip .cx-h{font-weight:700;color:#fff;font-size:.78rem;margin-bottom:4px;letter-spacing:-.01em}',
    '#kpi-cx-tip .cx-w{color:#CBD5E1;margin-bottom:6px}',
    '#kpi-cx-tip .cx-f{color:#FCD34D;font-family:"DM Mono",ui-monospace,monospace;font-size:.7rem;display:block;',
    'border-top:1px solid rgba(255,255,255,.1);padding-top:6px}',
    '#kpi-cx-tip .cx-f b{color:#FDE68A;font-weight:700}',
    /* badge "LIVE" de los dashboards: no dejar que el flex lo exprima ("● L") */
    '.live-pill{flex:none!important;white-space:nowrap!important}',
    '@media print{.kpi-cx-i{display:none}#kpi-cx-tip{display:none}}'
  ].join('');
  var st = document.createElement('style');
  st.id = 'kpi-cx-style';
  st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);

  /* ── Tooltip singleton ────────────────────────────────────────────────────── */
  var tip = null;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.id = 'kpi-cx-tip';
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(el) {
    var t = ensureTip();
    t.innerHTML = '<div class="cx-h">' + el.getAttribute('data-h') + '</div>' +
      '<div class="cx-w">' + el.getAttribute('data-w') + '</div>' +
      '<span class="cx-f"><b>Cómo se calcula:</b> ' + el.getAttribute('data-f') + '</span>';
    t.classList.add('on');
    var r = el.getBoundingClientRect();
    // medir para colocar
    t.style.left = '0px'; t.style.top = '0px';
    var tw = t.offsetWidth, th = t.offsetHeight;
    var left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8; // si no cabe arriba, abajo
    t.style.left = Math.round(left) + 'px';
    t.style.top = Math.round(top) + 'px';
  }
  function hideTip() { if (tip) tip.classList.remove('on'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ── Detección del valor asociado a un label ──────────────────────────────── */
  var VALUE_SEL = '.kpi-value,.kpi-v,.kpi-val,.sc-kpi-val,.stat-val,.mod-kpi-val,.mc-kpi-val,.bg-kpi-val,.kpi-num,.metric-val,.kc-value,.pill-value';
  var CARD_SEL = '.kpi-card,.kpi,.sc-kpi,.stat-item,.mod-kpi,.mc-kpi,.bg-kpi,.metric,.kpi-box';
  function findCard(labelEl) {
    var c = labelEl.closest(CARD_SEL);
    if (c) return c;
    // fallback: el padre directo si contiene un valor
    var p = labelEl.parentElement;
    if (p && p.querySelector(VALUE_SEL)) return p;
    return p;
  }

  /* ── Anotar un label ──────────────────────────────────────────────────────── */
  function annotateLabel(el) {
    if (!el || el.getAttribute('data-cx') || !el.textContent) return;
    // ignorar si el propio label es muy largo (probable párrafo, no KPI)
    var raw = el.textContent.trim();
    if (raw.length > 60 || raw.length < 2) return;
    var def = lookup(norm(raw));
    if (!def) return;
    el.setAttribute('data-cx', '1');

    // (2) ícono ⓘ con tooltip
    var i = document.createElement('span');
    i.className = 'kpi-cx-i';
    i.setAttribute('tabindex', '0');
    i.setAttribute('role', 'button');
    i.setAttribute('aria-label', raw + ': qué es y cómo se calcula');
    i.setAttribute('data-h', esc(raw));
    i.setAttribute('data-w', esc(def.what));
    i.setAttribute('data-f', esc(def.how));
    i.addEventListener('mouseenter', function () { showTip(i); });
    i.addEventListener('mouseleave', hideTip);
    i.addEventListener('focus', function () { showTip(i); });
    i.addEventListener('blur', hideTip);
    i.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (tip && tip.classList.contains('on')) hideTip(); else showTip(i);
    });
    el.appendChild(i);

    // (3) caption fija con la fórmula — SOLO en KPIs "hero" espaciosos.
    // En mini-stats densas (multi-empresa, módulos, micro-cards) dejamos solo el
    // ⓘ para no recargar (el usuario pidió contexto, pero también menos amontone).
    var isMini = el.matches('.sc-kpi-lbl,.mc-kpi-label,.bg-kpi-label,.pill-label') ||
                 !!el.closest('.sc-kpi,.mc-kpi,.uni-ec-m,.bg-kpi,.pill');
    if (isMini) return;
    var card = findCard(el);
    var val = card ? card.querySelector(VALUE_SEL) : null;
    if (card && !card.querySelector('.kpi-cx-cap')) {
      var cap = document.createElement('div');
      cap.className = 'kpi-cx-cap';
      cap.innerHTML = '<b>ƒ</b><span class="cx-txt" title="' + esc(def.how) + '">' + esc(def.how) + '</span>';
      // colocar tras el sub existente, o tras el valor, o al final de la tarjeta
      var sub = card.querySelector('.kpi-sub,.sc-kpi-sub,.mod-kpi-sub,.kpi-hint,.mc-kpi-hint');
      if (sub && sub.parentElement) sub.parentElement.insertBefore(cap, sub.nextSibling);
      else if (val && val.parentElement) val.parentElement.insertBefore(cap, val.nextSibling);
      else card.appendChild(cap);
    }
  }

  /* ── Anotar un título de gráfica/panel (sólo ⓘ) ───────────────────────────── */
  // h1 NO (es el título de la página, no una gráfica). h2/h3 + clases de panel.
  var TITLE_SEL = 'h2,h3,.panel-title,.card-title,.section-title,.chart-title,.sc-title,.block-title,.chart-h,.card-h,.widget-title';
  function annotateTitle(el) {
    if (!el || el.getAttribute('data-cx') || !el.textContent) return;
    var raw = el.textContent.replace(/\s+/g, ' ').trim();
    if (raw.length > 60 || raw.length < 4) return;
    if (/por qu[eé]|porqu[eé]| = /i.test(raw)) return;  // saltar FAQ ("¿Por qué…", "A = B")
    var def = matchChart(norm(raw));
    if (!def) return;
    el.setAttribute('data-cx', '1');
    var i = document.createElement('span');
    i.className = 'kpi-cx-i';
    i.setAttribute('tabindex', '0');
    i.setAttribute('role', 'button');
    i.setAttribute('aria-label', raw + ': qué es y cómo se calcula');
    i.setAttribute('data-h', esc(raw));
    i.setAttribute('data-w', esc(def.what));
    i.setAttribute('data-f', esc(def.how));
    i.addEventListener('mouseenter', function () { showTip(i); });
    i.addEventListener('mouseleave', hideTip);
    i.addEventListener('focus', function () { showTip(i); });
    i.addEventListener('blur', hideTip);
    i.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (tip && tip.classList.contains('on')) hideTip(); else showTip(i); });
    el.appendChild(i);
  }

  var LABEL_SEL = '.kpi-label,.kpi-l,.kpi-lbl,.sc-kpi-lbl,.stat-label,.mod-kpi-label,.mc-kpi-label,.bg-kpi-label,.kpi-top,.kc-label,.pill-label';

  /* ── Auto-fit: el número SIEMPRE cabe ─────────────────────────────────────
     Achica con precisión (por elemento) cualquier valor cuyo texto se desborde
     de su caja, hasta un piso legible. Resuelve los cortes en columnas angostas
     que el CSS por sí solo no puede (longitud de texto variable).            */
  var FIT_SEL = '.kpi-value,.kpi-v,.kpi-val,.sc-kpi-val,.stat-val,.mod-kpi-val,.mc-kpi-val,.bg-kpi-val,.kpi-num,.metric-val,.sc-val,.uni-ec-m .m-v,.u-v,.kc-value,.pill-value';
  var FIT_CARD_SEL = '.kpi-card,.kpi,.sc-kpi,.stat-item,.mod-kpi,.mc-kpi,.metric,.kpi-box,.pl-sc-card,.bg-kpi,.kc-card';
  // Ancho REAL disponible para el valor: el menor entre su propia caja y el
  // interior de su tarjeta. Clave porque un valor sin restricción de ancho puede
  // crecer MÁS que su tarjeta (clientWidth == scrollWidth) y el corte ocurre
  // contra la TARJETA, no contra el propio valor.
  function availWidth(el) {
    var own = el.clientWidth || 0;
    var card = el.closest(FIT_CARD_SEL);
    if (card) {
      var cs = getComputedStyle(card);
      var inner = card.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      if (inner > 24) return own ? Math.min(own, inner) : inner;
    }
    return own;
  }
  function fitValue(el) {
    if (!el || !el.offsetParent) return;             // invisible → omitir
    // reset al tamaño de CSS. Usamos setProperty con 'important' porque las
    // reglas de tamaño del tema llevan !important y de otro modo ganarían al
    // estilo inline (por eso un fitter sin 'important' no tenía efecto).
    el.style.removeProperty('font-size');
    var avail = availWidth(el);
    if (!avail) return;
    if (el.scrollWidth <= avail + 1) return;         // ya cabe en su tarjeta
    var px = parseFloat(getComputedStyle(el).fontSize) || 14;
    var floor = Math.max(9, px * 0.4);               // no bajar de ~9px ni del 40%
    var guard = 0;
    while (el.scrollWidth > avail + 1 && px > floor && guard < 20) {
      px = px * 0.93;
      el.style.setProperty('font-size', px + 'px', 'important');
      guard++;
    }
    if (!el.getAttribute('title')) el.setAttribute('title', el.textContent.trim());
  }
  function fitAll() {
    try {
      var vals = document.querySelectorAll(FIT_SEL);
      for (var i = 0; i < vals.length; i++) fitValue(vals[i]);
    } catch (e) { /* noop */ }
  }

  function scan() {
    try {
      var labels = document.querySelectorAll(LABEL_SEL);
      for (var a = 0; a < labels.length; a++) annotateLabel(labels[a]);
      var titles = document.querySelectorAll(TITLE_SEL);
      for (var b = 0; b < titles.length; b++) annotateTitle(titles[b]);
      fitAll();
    } catch (e) { if (window.console) console.warn('[kpi-context]', e && e.message || e); }
  }

  /* re-escanear cuando se renderizan KPIs por JS (debounce) */
  var pending = null;
  function scheduleScan() {
    if (pending) return;
    pending = setTimeout(function () { pending = null; scan(); }, 220);
  }

  function boot() {
    scan();
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) { scheduleScan(); return; }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* sin MutationObserver: al menos el primer scan corrió */ }
    // reintentos por si la data tarda
    setTimeout(scan, 1200);
    setTimeout(scan, 3000);
    window.addEventListener('scroll', hideTip, { passive: true });
    var rT = null;
    window.addEventListener('resize', function () {
      hideTip();
      if (rT) clearTimeout(rT);
      rT = setTimeout(fitAll, 180);   // re-encajar números al cambiar el ancho
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // hook público (debug / forzar re-encaje tras renders propios de la página)
  window.SumiKpiContext = { scan: scan, fitAll: fitAll, fitValue: fitValue };
})();
