'use strict';

/**
 * Vendedor puro (sin admin ni gerente): fuerza datos “solo lo suyo” vía VENDEDOR_ID
 * y exige mapa correo → ID (Microsip) en AUTH_VENDEDOR_MAP.
 *
 * Formato: email@dominio.com:12;otro@dominio.com:5
 * (mismo email en minúsculas que en AUTH_USERS / login).
 */

const { isVendedorTier } = require('./gerente-gate');
const { publicApiPath } = require('./session-gate');

/**
 * Rutas API permitidas aunque falte fila en AUTH_VENDEDOR_MAP (usuario autenticado sí existe).
 * Sin esto, POST /api/usage/track recibe 403 y las métricas de uso solo muestran login/logout.
 */
const VENDEDOR_ALLOW_WITHOUT_MAP = new Set(['/api/usage/track']);

/**
 * @returns {Map<string, number>}
 */
function parseVendedorMap() {
  const raw = process.env.AUTH_VENDEDOR_MAP || '';
  const m = new Map();
  raw.split(';').forEach((entry) => {
    const t = (entry || '').trim();
    if (!t) return;
    const idx = t.indexOf(':');
    if (idx <= 0) return;
    const email = t.slice(0, idx).trim().toLowerCase();
    const id = parseInt(t.slice(idx + 1).trim(), 10);
    if (email && Number.isFinite(id) && id > 0) m.set(email, id);
  });
  return m;
}

const MAP = parseVendedorMap();

if (String(process.env.AUTH_PROVIDER || '').toLowerCase() === 'session' && MAP.size === 0) {
  console.warn(
    '[auth/vendedor-scope] AUTH_VENDEDOR_MAP vacío: los usuarios solo-vendedor recibirán 403 en APIs hasta que asignes email:VENDEDOR_ID.'
  );
}

function install(app) {
  app.use((req, res, next) => {
    if (!isVendedorTier(req)) return next();

    const email = String((req.user && req.user.email) || '').toLowerCase();
    const vid = MAP.get(email);

    if (!vid) {
      if (
        req.path.startsWith('/api/') &&
        !publicApiPath(req.path) &&
        !VENDEDOR_ALLOW_WITHOUT_MAP.has(req.path)
      ) {
        return res.status(403).json({
          error:
            'Tu cuenta de vendedor debe tener VENDEDOR_ID en AUTH_VENDEDOR_MAP (formato: correo@empresa.com:123). Contacta al administrador.',
          code: 'VENDEDOR_MAP_MISSING',
        });
      }
      return next();
    }

    req.vendedorScopeId = vid;

    if (req.path.startsWith('/api/ventas/')) {
      req.query = req.query && typeof req.query === 'object' ? req.query : {};
      req.query.vendedor = String(vid);
    }

    next();
  });
}

module.exports = {
  install,
  parseVendedorMap,
  MAP,
};
