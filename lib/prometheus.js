'use strict';

/**
 * lib/prometheus.js — Exposición de métricas en formato Prometheus.
 *
 * Sin dependencias. Implementa el subset que necesitamos:
 *   counter:   monotónico (requests, errors, tokens)
 *   gauge:     valor actual (sessions activas, cache size)
 *   histogram: distribución (latencia, tamaño payload)
 *
 * Uso:
 *   const metrics = require('./lib/prometheus').create();
 *   metrics.counter('http_requests_total', 'Total HTTP requests', { route: '/api/x' }).inc();
 *   metrics.gauge('cache_size', 'Cache entries').set(42);
 *   metrics.histogram('http_duration_ms', 'HTTP duration', [50, 100, 250, 500, 1000]).observe(ms);
 *
 *   app.get('/api/metrics', (_req, res) => {
 *     res.set('Content-Type', 'text/plain; charset=utf-8; version=0.0.4');
 *     res.end(metrics.expose());
 *   });
 *
 * Formato Prometheus exposition:
 *   # HELP <name> <description>
 *   # TYPE <name> counter|gauge|histogram
 *   <name>{label="value"} 123
 */

function labelKey(labels) {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');
}

function create() {
  // Map<metricName, { type, help, samples: Map<labelKey, value> }>
  const metrics = new Map();

  function getOrCreate(name, type, help) {
    let m = metrics.get(name);
    if (!m) { m = { type, help, samples: new Map() }; metrics.set(name, m); }
    return m;
  }

  function counter(name, help, labels) {
    const m = getOrCreate(name, 'counter', help);
    const key = labelKey(labels);
    return {
      inc(by = 1) {
        m.samples.set(key, (m.samples.get(key) || 0) + by);
      },
      value() { return m.samples.get(key) || 0; },
    };
  }

  function gauge(name, help, labels) {
    const m = getOrCreate(name, 'gauge', help);
    const key = labelKey(labels);
    return {
      set(v) { m.samples.set(key, v); },
      inc(by = 1) { m.samples.set(key, (m.samples.get(key) || 0) + by); },
      dec(by = 1) { m.samples.set(key, (m.samples.get(key) || 0) - by); },
      value() { return m.samples.get(key) || 0; },
    };
  }

  // Histogram simple: buckets fijos + sum + count.
  // Samples internas: 'le=X' buckets, '_sum', '_count'
  function histogram(name, help, buckets) {
    let m = metrics.get(name);
    if (!m) {
      m = { type: 'histogram', help, buckets: buckets || [10, 50, 100, 250, 500, 1000, 5000], samples: new Map(), sum: 0, count: 0 };
      metrics.set(name, m);
    }
    return {
      observe(v) {
        m.sum += v;
        m.count += 1;
        for (const b of m.buckets) {
          if (v <= b) {
            const key = `le="${b}"`;
            m.samples.set(key, (m.samples.get(key) || 0) + 1);
          }
        }
        const inf = 'le="+Inf"';
        m.samples.set(inf, (m.samples.get(inf) || 0) + 1);
      },
    };
  }

  function expose() {
    const lines = [];
    for (const [name, m] of metrics) {
      if (m.help) lines.push(`# HELP ${name} ${m.help}`);
      lines.push(`# TYPE ${name} ${m.type}`);
      if (m.type === 'histogram') {
        const keys = [...m.samples.keys()].sort();
        for (const k of keys) {
          lines.push(`${name}_bucket{${k}} ${m.samples.get(k)}`);
        }
        lines.push(`${name}_sum ${m.sum}`);
        lines.push(`${name}_count ${m.count}`);
      } else {
        for (const [k, v] of m.samples) {
          lines.push(`${name}${k ? '{' + k + '}' : ''} ${v}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  return { counter, gauge, histogram, expose, metrics };
}

module.exports = { create };
