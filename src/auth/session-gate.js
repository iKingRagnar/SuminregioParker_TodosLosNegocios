'use strict';

/**
 * Candado previo a estáticos: con AUTH_PROVIDER=session exige cookie de sesión
 * salvo rutas públicas (login, health, upload snapshot con token, etc.).
 */

const {
  isFinanceRestricted,
  isVendedorTier,
  VENDEDOR_DOCUMENT_DENY,
} = require('./gerente-gate');

function publicApiPath(path) {
  if (path.startsWith('/api/auth/')) return true;
  if (path === '/api/health') return true;
  // Snapshot nocturno / automatización (autorización por X-Snapshot-Token en el handler)
  if (path === '/api/admin/snapshot/upload') return true;
  return false;
}

function publicDocumentPath(path) {
  if (path === '/login.html' || path === '/portal.html') return true;
  if (path === '/favicon.svg' || path === '/favicon.ico') return true;
  if (path === '/manifest.webmanifest') return true;
  if (path === '/robots.txt') return true;
  // SW y guard del cliente deben servirse sin sesión (Accept */* no es navegación HTML).
  if (path === '/sw.js' || path === '/auth-guard.js') return true;
  return false;
}

/** Peticiones que típicamente cargan un documento HTML (navegador o enlaces directos). */
function wantsHtmlPageNavigation(req, docPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = docPath || '';
  if (p === '/' || p === '' || /\.html$/i.test(p)) return true;
  const dest = req.headers['sec-fetch-dest'];
  if (dest === 'document' || dest === 'iframe') return true;
  const acc = req.headers.accept || '';
  if (/text\/html/i.test(acc)) return true;
  if (!dest && !acc) return true;
  return false;
}

function publicHealthPath(path) {
  return path === '/health' || path === '/healthz';
}

function install(app) {
  app.use((req, res, next) => {
    const path = (req.path || '').split('?')[0];
    if (publicHealthPath(path)) return next();
    if (publicDocumentPath(path)) return next();
    if (publicApiPath(path)) return next();

    const hasUser = req.user && (req.user.email || req.user.id);
    if (hasUser) {
      if (isVendedorTier(req) && VENDEDOR_DOCUMENT_DENY.has(path)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, '/ventas.html');
      }
      if (
        (path === '/resultados.html' || path === '/margen-producto.html') &&
        isFinanceRestricted(req)
      ) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, '/ventas.html');
      }
      return next();
    }

    if (path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(401).json({
        error: 'Sesión requerida. Inicia sesión en /login.html',
        code: 'AUTH_REQUIRED',
      });
    }

    if (wantsHtmlPageNavigation(req, path)) {
      const nextUrl = encodeURIComponent(req.originalUrl || '/index.html');
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, `/login.html?next=${nextUrl}`);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).send('No autorizado');
  });
}

module.exports = {
  install,
  publicApiPath,
  publicDocumentPath,
  publicHealthPath,
  wantsHtmlPageNavigation,
};
