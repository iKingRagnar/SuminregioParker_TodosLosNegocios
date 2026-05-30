'use strict';

/**
 * lib/metas-config.js — Fuente ÚNICA de las metas/objetivos del proyecto.
 *
 * Centraliza:
 *   1. El ESQUEMA de todas las metas (grupo, etiqueta, tipo, rango, default).
 *   2. Los valores efectivos = defaults estándar + overrides de la empresa.
 *   3. La MATEMÁTICA de las metas derivadas (ideal, totales) — se recalculan
 *      siempre a partir de las metas base, así editar una base cuadra todo.
 *   4. La persistencia de los overrides (data/metas-overrides.json).
 *
 * Las metas base son benchmarks estándar de distribución/mayoreo B2B: son
 * VALORES DE REFERENCIA, no metas oficiales. Cualquiera puede editarlas
 * (POST /api/config/metas) y el cambio se refleja en todo el proyecto, porque
 * todos los tableros leen /api/config/metas.
 */

const fs = require('fs');
const path = require('path');

const OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'metas-overrides.json');

// ── Esquema de metas BASE (editables) ────────────────────────────────────────
//   kind: 'pct' (fracción 0..1) | 'money' | 'dias' | 'x' (veces/año) |
//         'factor' (multiplicador) | 'num'
//   dir:  '≥' objetivo mínimo · '≤' objetivo máximo (sólo informativo en UI)
const SCHEMA = [
  // Ventas / Vendedores
  { key: 'META_DIARIA_POR_VENDEDOR', group: 'Ventas', label: 'Venta diaria por vendedor', kind: 'money', dir: '≥', def: 5650, min: 0, max: 1e7 },
  { key: 'META_COTI_POR_VENDEDOR',   group: 'Ventas', label: 'Cotización diaria por vendedor', kind: 'money', dir: '≥', def: 10000, min: 0, max: 1e7 },
  { key: 'META_FACTOR_IDEAL',        group: 'Ventas', label: 'Factor meta ideal (×)', kind: 'factor', dir: '≥', def: 1.30, min: 1, max: 3 },
  { key: 'MARGEN_COMISION',          group: 'Ventas', label: 'Margen de comisión', kind: 'pct', dir: '≥', def: 0.08, min: 0, max: 1 },
  // Rentabilidad / Resultados
  { key: 'META_MARGEN_BRUTO_PCT',    group: 'Rentabilidad', label: 'Margen bruto', kind: 'pct', dir: '≥', def: 0.30, min: 0, max: 1 },
  { key: 'META_MARGEN_NETO_PCT',     group: 'Rentabilidad', label: 'Margen neto (operativo)', kind: 'pct', dir: '≥', def: 0.08, min: 0, max: 1 },
  { key: 'META_GASTO_OPERATIVO_PCT', group: 'Rentabilidad', label: 'Gasto operativo / ventas', kind: 'pct', dir: '≤', def: 0.20, min: 0, max: 1 },
  { key: 'META_CRECIMIENTO_YOY_PCT', group: 'Rentabilidad', label: 'Crecimiento anual (YoY)', kind: 'pct', dir: '≥', def: 0.10, min: -1, max: 5 },
  { key: 'META_MARGEN_PRODUCTO_MIN_PCT', group: 'Rentabilidad', label: 'Margen mínimo por producto', kind: 'pct', dir: '≥', def: 0.20, min: 0, max: 1 },
  // Cartera / CxC
  { key: 'META_DSO_DIAS',            group: 'Cartera', label: 'Días de cobro (DSO)', kind: 'dias', dir: '≤', def: 45, min: 1, max: 365 },
  { key: 'META_CARTERA_VENCIDA_PCT', group: 'Cartera', label: 'Cartera vencida', kind: 'pct', dir: '≤', def: 0.15, min: 0, max: 1 },
  { key: 'META_EFICIENCIA_COBRANZA_PCT', group: 'Cartera', label: 'Eficiencia de cobranza', kind: 'pct', dir: '≥', def: 0.95, min: 0, max: 1 },
  // Inventario
  { key: 'META_ROTACION_INVENTARIO_ANUAL', group: 'Inventario', label: 'Rotación de inventario', kind: 'x', dir: '≥', def: 6, min: 0.1, max: 60 },
  { key: 'META_DIAS_INVENTARIO_MAX', group: 'Inventario', label: 'Días de inventario', kind: 'dias', dir: '≤', def: 60, min: 1, max: 365 },
  { key: 'META_FILL_RATE_PCT',       group: 'Inventario', label: 'Fill rate (surtido)', kind: 'pct', dir: '≥', def: 0.95, min: 0, max: 1 },
  { key: 'META_EXACTITUD_INVENTARIO_PCT', group: 'Inventario', label: 'Exactitud de inventario', kind: 'pct', dir: '≥', def: 0.97, min: 0, max: 1 },
  // Pedidos / Cumplimiento
  { key: 'META_CUMPLIMIENTO_PEDIDOS_PCT', group: 'Pedidos', label: 'Cumplimiento de pedidos', kind: 'pct', dir: '≥', def: 0.95, min: 0, max: 1 },
  { key: 'META_ENTREGA_A_TIEMPO_PCT', group: 'Pedidos', label: 'Entregas a tiempo', kind: 'pct', dir: '≥', def: 0.95, min: 0, max: 1 },
  // Clientes / Retención
  { key: 'META_RETENCION_CLIENTES_PCT', group: 'Clientes', label: 'Retención de clientes', kind: 'pct', dir: '≥', def: 0.85, min: 0, max: 1 },
  { key: 'META_CHURN_MENSUAL_PCT',   group: 'Clientes', label: 'Churn mensual', kind: 'pct', dir: '≤', def: 0.05, min: 0, max: 1 },
  { key: 'META_RECOMPRA_PCT',        group: 'Clientes', label: 'Tasa de recompra', kind: 'pct', dir: '≥', def: 0.60, min: 0, max: 1 },
];

const SCHEMA_BY_KEY = SCHEMA.reduce((m, s) => { m[s.key] = s; return m; }, {});

// Metas DERIVADAS (sólo lectura): se recalculan de las base para que la
// matemática cuadre en todo el proyecto.
const DERIVED = [
  { key: 'META_IDEAL_POR_VENDEDOR', group: 'Ventas', label: 'Venta ideal por vendedor', kind: 'money', dir: '≥', formula: 'Venta diaria × Factor ideal' },
  { key: 'META_COTI_IDEAL',         group: 'Ventas', label: 'Cotización ideal por vendedor', kind: 'money', dir: '≥', formula: 'Cotización diaria × Factor ideal' },
  { key: 'META_TOTAL_DIARIA',       group: 'Ventas', label: 'Meta diaria del equipo', kind: 'money', dir: '≥', formula: 'Venta diaria × # vendedores' },
  { key: 'META_IDEAL_TOTAL',        group: 'Ventas', label: 'Meta ideal del equipo', kind: 'money', dir: '≥', formula: 'Venta ideal × # vendedores' },
  { key: 'META_COTI_TOTAL',         group: 'Ventas', label: 'Cotización total del equipo', kind: 'money', dir: '≥', formula: 'Cotización diaria × # vendedores' },
  { key: 'META_COTI_IDEAL_TOTAL',   group: 'Ventas', label: 'Cotización ideal del equipo', kind: 'money', dir: '≥', formula: 'Cotización ideal × # vendedores' },
];

function defaults() {
  const d = {};
  for (const s of SCHEMA) d[s.key] = s.def;
  return d;
}

// ── Persistencia de overrides ────────────────────────────────────────────────
let _cache = null; // { mtime, data }

function loadOverrides() {
  try {
    const stat = fs.statSync(OVERRIDES_PATH);
    if (_cache && _cache.mtime === stat.mtimeMs) return _cache.data;
    const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    const data = (raw && typeof raw === 'object') ? raw : {};
    _cache = { mtime: stat.mtimeMs, data };
    return data;
  } catch (_) {
    return {}; // sin archivo → sin overrides
  }
}

function saveOverrides(obj) {
  const dir = path.dirname(OVERRIDES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(obj, null, 2), 'utf8');
  _cache = null; // forzar recarga
}

/**
 * Valida y mezcla un input parcial { KEY: value } sobre los overrides actuales.
 * Devuelve { ok, errors:[], overrides } sin escribir a disco.
 */
function validateMerge(input) {
  const errors = [];
  const clean = {};
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['payload vacío o inválido'], overrides: loadOverrides() };
  }
  for (const [key, rawVal] of Object.entries(input)) {
    const sc = SCHEMA_BY_KEY[key];
    if (!sc) { errors.push(`meta desconocida o no editable: ${key}`); continue; }
    const v = Number(rawVal);
    if (!isFinite(v)) { errors.push(`${key}: valor no numérico`); continue; }
    if (v < sc.min || v > sc.max) {
      errors.push(`${key}: fuera de rango (${sc.min}..${sc.max})`);
      continue;
    }
    clean[key] = v;
  }
  if (errors.length) return { ok: false, errors, overrides: loadOverrides() };
  const merged = Object.assign({}, loadOverrides(), clean);
  return { ok: true, errors: [], overrides: merged };
}

function resetOverrides() {
  saveOverrides({});
  return {};
}

/**
 * Construye el payload completo de metas: base (default+override) + derivadas.
 * @param {object} ctx { numV, numVActivos, numVConVenta }
 */
function buildPayload(ctx) {
  const numV = Math.max(Number(ctx && ctx.numV) || 1, 1);
  const ov = loadOverrides();
  const base = Object.assign(defaults(), ov);

  const FACTOR_IDEAL = base.META_FACTOR_IDEAL;
  const META_DIA_V = base.META_DIARIA_POR_VENDEDOR;
  const META_DIA_C = base.META_COTI_POR_VENDEDOR;
  const META_IDEAL_V = META_DIA_V * FACTOR_IDEAL;
  const META_IDEAL_C = META_DIA_C * FACTOR_IDEAL;

  const payload = Object.assign({}, base, {
    // Derivadas (recalculadas siempre desde las base)
    META_IDEAL_POR_VENDEDOR: META_IDEAL_V,
    META_COTI_IDEAL:         META_IDEAL_C,
    META_TOTAL_DIARIA:       META_DIA_V  * numV,
    META_IDEAL_TOTAL:        META_IDEAL_V * numV,
    META_COTI_TOTAL:         META_DIA_C  * numV,
    META_COTI_IDEAL_TOTAL:   META_IDEAL_C * numV,
    // Contexto
    NUM_VENDEDORES:           numV,
    NUM_VENDEDORES_ACTIVOS:   Number(ctx && ctx.numVActivos) || 0,
    NUM_VENDEDORES_CON_VENTA: Number(ctx && ctx.numVConVenta) || 0,
    // Metadatos
    METAS_PERSONALIZADAS:     Object.keys(ov).length > 0,
    METAS_ESTANDAR_SUGERIDAS: Object.keys(ov).length === 0,
    _NOTA_METAS_ESTANDAR:
      'Metas estándar sugeridas (benchmarks de distribución B2B). Son valores ' +
      'de referencia, no metas oficiales: edítalas en /metas.html y se reflejan ' +
      'en todo el proyecto.',
  });
  return payload;
}

module.exports = {
  SCHEMA, DERIVED, SCHEMA_BY_KEY,
  defaults, loadOverrides, saveOverrides, validateMerge, resetOverrides,
  buildPayload, OVERRIDES_PATH,
};
