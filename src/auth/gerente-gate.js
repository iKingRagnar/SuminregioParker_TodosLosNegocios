'use strict';

/**
 * Restricciones por rol (sin admin):
 * - gerente + vendedor: sin P&L ni /api/ventas/margen (márgenes agregados por vendedor/mes).
 * - solo vendedor (sin gerente): además sin CxC, inventario, clientes consolidados, consumos, director, capital,
 *   admin sync/snapshot, IA, métricas internas, scorecard global, y sin APIs de costo/margen por producto;
 *   datos de ventas acotados a su VENDEDOR_ID (AUTH_VENDEDOR_MAP + req.query.vendedor forzado).
 */

const FINANCE_PREFIX_DENY = [
  '/api/resultados/',
  '/api/ventas/margen',
  '/api/debug/pnl',
];

/** Rutas extra para el nivel "solo vendedor" (no aplica si el usuario es también gerente). */
const VENDEDOR_PREFIX_DENY = [
  '/api/cxc/',
  '/api/inv/',
  '/api/consumos/',
  '/api/director/',
  '/api/capital/',
  '/api/debug/',
  '/api/reports/',
  '/api/integrations/',
  '/api/ai/',
  '/api/diagnostico/',
  '/api/briefing/',
  '/api/metrics',
  '/api/alerts/',
  '/api/admin/snapshot',
  '/api/admin/sync',
  '/api/admin/errors',
  '/api/admin/alerts',
  '/api/email/',
  '/api/boot/',
  '/api/universe/scorecard',
  '/api/clientes/',
  '/api/sec/',
];

/** Costo por línea / por artículo (no aplica a gerente: solo vendedor puro). */
const VENDEDOR_COST_DENY = ['/api/ventas/margen-lineas', '/api/ventas/margen-articulos'];

function rolesOf(req) {
  return (req.user && req.user.roles) || [];
}

/** Gerente sin admin: tiene rol gerente. */
function isGerenteOnly(req) {
  const r = rolesOf(req);
  if (!r.length) return false;
  if (r.includes('admin')) return false;
  return r.includes('gerente');
}

/**
 * Vendedor puro: tiene vendedor, sin admin ni gerente (si es gerente, aplica perfil gerente).
 */
function isVendedorTier(req) {
  const r = rolesOf(req);
  if (!r.length) return false;
  if (r.includes('admin')) return false;
  if (r.includes('gerente')) return false;
  return r.includes('vendedor');
}

/** Sin P&L / márgenes: gerente o vendedor, sin admin. */
function isFinanceRestricted(req) {
  const r = rolesOf(req);
  if (!r.length) return false;
  if (r.includes('admin')) return false;
  return r.includes('gerente') || r.includes('vendedor');
}

function pathMatchesDeny(path, list) {
  for (const p of list) {
    if (path === p || path.startsWith(p)) return true;
  }
  return false;
}

function install(app) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();

    if (isFinanceRestricted(req) && pathMatchesDeny(req.path, FINANCE_PREFIX_DENY)) {
      return res.status(403).json({
        error:
          'Tu cuenta no tiene acceso a estado de resultados (P&L), costos de venta ni márgenes por producto.',
        code: 'ROLE_FINANCE_RESTRICTED',
      });
    }

    if (isVendedorTier(req) && pathMatchesDeny(req.path, VENDEDOR_PREFIX_DENY)) {
      return res.status(403).json({
        error: 'Tu cuenta de vendedor no tiene acceso a este recurso.',
        code: 'ROLE_VENDEDOR_RESTRICTED',
      });
    }

    if (isVendedorTier(req) && pathMatchesDeny(req.path, VENDEDOR_COST_DENY)) {
      return res.status(403).json({
        error: 'Tu cuenta de vendedor no tiene acceso a márgenes ni costos por producto.',
        code: 'ROLE_VENDEDOR_COST_DENIED',
      });
    }

    next();
  });
}

/** Páginas HTML que el nivel vendedor no debe abrir (redirigir a ventas). */
const VENDEDOR_DOCUMENT_DENY = new Set([
  '/index.html',
  '/director.html',
  '/cxc.html',
  '/inventario.html',
  '/consumos.html',
  '/admin.html',
  '/capital.html',
  '/comparar.html',
  '/resultados.html',
  '/margen-producto.html',
  '/clientes.html',
  '/docs.html',
]);

module.exports = {
  install,
  isGerenteOnly,
  isVendedorTier,
  isFinanceRestricted,
  FINANCE_PREFIX_DENY,
  VENDEDOR_PREFIX_DENY,
  VENDEDOR_COST_DENY,
  VENDEDOR_DOCUMENT_DENY,
};
