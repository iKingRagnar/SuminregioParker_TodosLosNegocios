'use strict';

/**
 * lib/format.js — Helpers de formato MXN compartidos.
 * Antes duplicados en 6+ módulos.
 */

function fmt(n) {
  if (n == null || isNaN(+n)) return '—';
  return '$' + Math.round(+n).toLocaleString('es-MX');
}

function fmtUnits(n) {
  if (n == null || isNaN(+n)) return '—';
  return (+n).toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

function fmtPct(n, decimals) {
  if (n == null || isNaN(+n)) return '—';
  return (+n).toFixed(decimals != null ? decimals : 1) + '%';
}

// Sin redondeo (preserva decimales para reportes financieros).
function fmtExact(n) {
  if (n == null || isNaN(+n)) return '—';
  return '$' + (+n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "1,234,567" → 1234567 (parser de strings con formato MX).
function parseMx(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const n = Number(String(s).replace(/[^\d\-.]/g, ''));
  return isNaN(n) ? 0 : n;
}

module.exports = { fmt, fmtUnits, fmtPct, fmtExact, parseMx };
