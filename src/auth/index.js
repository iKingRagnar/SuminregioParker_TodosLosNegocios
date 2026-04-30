'use strict';

/**
 * src/auth/index.js — Sistema de autenticación pluggable
 *
 * Providers disponibles (via env AUTH_PROVIDER):
 *   · 'dummy' (default)     → sin auth; todos son admin anónimo (modo dev)
 *   · 'clerk'               → Clerk (requires CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY)
 *   · 'basic'               → HTTP Basic Auth con users en AUTH_USERS env
 *   · 'session'             → Login por formulario (cookie httpOnly) + AUTH_USERS
 *
 * Uso:
 *   const auth = require('./src/auth');
 *   auth.install(app);          // endpoints + middleware
 *   app.get('/admin', auth.requireRole('admin'), handler);
 */

const providers = {
  dummy: require('./providers/dummy'),
  basic: require('./providers/basic'),
  clerk: require('./providers/clerk'),
  session: require('./providers/session'),
};

function getProvider() {
  const name = String(process.env.AUTH_PROVIDER || 'dummy').toLowerCase();
  return providers[name] || providers.dummy;
}

function install(app) {
  const provider = getProvider();
  const { log } = (() => { try { return require('../../performance-boost'); } catch (_) { return { log: console }; } })();

  // Middleware: attach req.user si está auth'd
  app.use((req, _res, next) => {
    provider.attachUser(req).then(() => next()).catch(() => next());
  });

  // Rutas específicas del provider
  if (typeof provider.routes === 'function') provider.routes(app);

  // Endpoint universal: estado del usuario actual
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user || null, provider: process.env.AUTH_PROVIDER || 'dummy' });
  });

  log.info && log.info('auth', `provider=${process.env.AUTH_PROVIDER || 'dummy'}`);
}

/** Middleware: exige usuario autenticado */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  next();
}

/** Middleware: exige rol específico */
function requireRole(role) {
  const roles = Array.isArray(role) ? role : [role];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    const userRoles = req.user.roles || [];
    if (!roles.some((r) => userRoles.includes(r))) {
      return res.status(403).json({ error: 'Rol insuficiente', required: roles, have: userRoles });
    }
    next();
  };
}

module.exports = { install, requireAuth, requireRole, getProvider };
