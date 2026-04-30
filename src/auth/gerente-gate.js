'use strict';

/**
 * Bloquea a usuarios con rol gerente (sin admin) rutas API de P&L, costos y margen.
 */

const PREFIX_DENY = [
  '/api/resultados/',
  '/api/ventas/margen',
  '/api/debug/pnl',
];

function isGerenteOnly(req) {
  const roles = (req.user && req.user.roles) || [];
  if (!roles.length) return false;
  if (roles.includes('admin')) return false;
  return roles.includes('gerente');
}

function install(app) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (!isGerenteOnly(req)) return next();
    const path = req.path;
    for (const p of PREFIX_DENY) {
      if (path === p || path.startsWith(p)) {
        return res.status(403).json({
          error:
            'Tu cuenta no tiene acceso a estado de resultados (P&L), costos de venta ni márgenes por producto.',
          code: 'ROLE_FINANCE_RESTRICTED',
        });
      }
    }
    next();
  });
}

module.exports = { install, isGerenteOnly, PREFIX_DENY };
