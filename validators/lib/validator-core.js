/**
 * validator-core.js — Núcleo compartido para todos los agentes validadores
 * ─────────────────────────────────────────────────────────────────────────
 * Suminregio Parker ERP · Pre-deploy validation suite
 */
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Configuración ────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl    : process.env.VALIDATOR_BASE_URL || 'http://localhost:3000',
  timeout    : parseInt(process.env.VALIDATOR_TIMEOUT_MS || '12000'),
  publicDir  : path.resolve(__dirname, '../../public'),
  thresholds : {
    maxNullPct    : 0.30,   // máx 30% de campos nulos en respuesta API
    minRecords    : 1,      // mínimo de registros en arrays de datos
    maxResponseMs : 8000,   // tiempo máximo aceptable de respuesta
  },
};

// ── Colores ANSI ─────────────────────────────────────────────────────────────
const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  red    : '\x1b[31m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  blue   : '\x1b[34m',
  cyan   : '\x1b[36m',
  gray   : '\x1b[90m',
};

// ── Resultado de validación ──────────────────────────────────────────────────
class ValidationResult {
  constructor(module) {
    this.module   = module;
    this.passed   = [];
    this.failed   = [];
    this.warnings = [];
    this.startTs  = Date.now();
    this.endTs    = null;
  }

  ok(label, detail = '') {
    this.passed.push({ label, detail });
    console.log(`  ${C.green}✅${C.reset} ${label}${detail ? C.gray + ' · ' + detail + C.reset : ''}`);
  }

  fail(label, detail = '') {
    this.failed.push({ label, detail });
    console.log(`  ${C.red}❌${C.reset} ${C.bold}${label}${C.reset}${detail ? C.gray + ' · ' + detail + C.reset : ''}`);
  }

  warn(label, detail = '') {
    this.warnings.push({ label, detail });
    console.log(`  ${C.yellow}⚠️ ${C.reset} ${label}${detail ? C.gray + ' · ' + detail + C.reset : ''}`);
  }

  finalize() {
    this.endTs = Date.now();
    const ms   = this.endTs - this.startTs;
    const ok   = this.failed.length === 0;
    const statusIcon = ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log('');
    console.log(
      `  ${C.bold}[${this.module}]${C.reset} ${statusIcon} ` +
      `✅ ${this.passed.length}  ❌ ${this.failed.length}  ⚠️  ${this.warnings.length}  ` +
      `${C.gray}(${ms}ms)${C.reset}`
    );
    return ok;
  }

  toJSON() {
    return {
      module   : this.module,
      pass     : this.failed.length === 0,
      passed   : this.passed.length,
      failed   : this.failed.length,
      warnings : this.warnings.length,
      ms       : (this.endTs || Date.now()) - this.startTs,
      failures : this.failed,
      warns    : this.warnings,
    };
  }
}

// ── Fetch con timeout ────────────────────────────────────────────────────────
function fetchJson(url, timeoutMs = CONFIG.timeout) {
  return new Promise((resolve, reject) => {
    const lib      = url.startsWith('https') ? https : http;
    const start    = Date.now();
    const req      = lib.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        const ms = Date.now() - start;
        try {
          const data = JSON.parse(raw);
          resolve({ data, status: res.statusCode, ms });
        } catch (e) {
          reject(new Error(`JSON parse error (${res.statusCode}): ${raw.slice(0, 120)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

// ── Validadores reutilizables ────────────────────────────────────────────────

/** Verifica que una URL de API responda con status 200 */
async function checkEndpoint(res, label, url) {
  try {
    const { status, ms, data } = await fetchJson(CONFIG.baseUrl + url);
    if (status !== 200) {
      res.fail(label, `HTTP ${status}`);
      return null;
    }
    if (ms > CONFIG.thresholds.maxResponseMs) {
      res.warn(label, `Respuesta lenta: ${ms}ms`);
    } else {
      res.ok(label, `${ms}ms`);
    }
    return { data, ms };
  } catch (e) {
    res.fail(label, e.message);
    return null;
  }
}

/** Verifica que un array tenga al menos N registros */
function checkArrayLength(res, label, arr, min = CONFIG.thresholds.minRecords) {
  const a = Array.isArray(arr) ? arr : (arr && arr.data ? arr.data : []);
  if (!Array.isArray(a) || a.length < min) {
    res.fail(label, `Array vacío o <${min} registros (got ${Array.isArray(a) ? a.length : typeof a})`);
    return false;
  }
  res.ok(label, `${a.length} registros`);
  return true;
}

/** Verifica que un valor numérico sea > 0 */
function checkPositiveNum(res, label, val) {
  const n = typeof val === 'string' ? parseFloat(val) : +val;
  if (isNaN(n) || n <= 0) {
    res.fail(label, `Valor inválido: ${val}`);
    return false;
  }
  res.ok(label, `${n.toLocaleString('es-MX')}`);
  return true;
}

/** Verifica que un HTML/JS tenga selectores CSS clave */
function checkHtmlSelectors(res, filename, selectors) {
  const filePath = path.join(CONFIG.publicDir, filename);
  if (!fs.existsSync(filePath)) {
    res.fail(`Archivo existe: ${filename}`);
    return;
  }
  res.ok(`Archivo existe: ${filename}`);
  const content = fs.readFileSync(filePath, 'utf8');
  for (const sel of selectors) {
    if (!content.includes(sel)) {
      res.fail(`Selector/string presente: ${sel}`, filename);
    } else {
      res.ok(`Selector/string presente: ${sel}`);
    }
  }
}

/** Verifica sintaxis JS via Node --check */
function checkJsSyntax(res, filename) {
  const { execSync } = require('child_process');
  const filePath = path.join(CONFIG.publicDir, filename);
  try {
    execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
    res.ok(`Sintaxis JS válida: ${filename}`);
  } catch (e) {
    res.fail(`Sintaxis JS: ${filename}`, e.stderr ? e.stderr.toString().slice(0, 120) : e.message);
  }
}

/** Verifica balance de llaves en CSS */
function checkCssBraces(res, filename) {
  const filePath = path.join(CONFIG.publicDir, filename);
  if (!fs.existsSync(filePath)) { res.fail(`CSS existe: ${filename}`); return; }
  const css    = fs.readFileSync(filePath, 'utf8');
  const opens  = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  if (opens !== closes) {
    res.fail(`Balance CSS ${filename}`, `{ ${opens} vs } ${closes}`);
  } else {
    res.ok(`Balance CSS ${filename}`, `${opens} pares de llaves ✓`);
  }
}

/** Unwrap data de respuestas API envueltas en { data: [...] } o { rows: [...] } */
function unwrap(resp) {
  if (!resp) return null;
  if (Array.isArray(resp)) return resp;
  if (resp.data)  return resp.data;
  if (resp.rows)  return resp.rows;
  if (resp.items) return resp.items;
  return resp;
}

// ── Header del reporte ───────────────────────────────────────────────────────
function printHeader(moduleName) {
  const line = '═'.repeat(58);
  console.log('');
  console.log(`${C.cyan}${C.bold}${line}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  🔍 VALIDATOR — ${moduleName.toUpperCase()}${C.reset}`);
  console.log(`${C.cyan}${C.bold}  Suminregio Parker ERP · ${new Date().toLocaleString('es-MX')}${C.reset}`);
  console.log(`${C.cyan}${C.bold}${line}${C.reset}`);
  console.log('');
}

module.exports = {
  CONFIG,
  ValidationResult,
  fetchJson,
  checkEndpoint,
  checkArrayLength,
  checkPositiveNum,
  checkHtmlSelectors,
  checkJsSyntax,
  checkCssBraces,
  unwrap,
  printHeader,
  C,
};
