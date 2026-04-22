'use strict';

/**
 * Clerk auth provider — valida sesión desde cookie o header Authorization.
 * Requires:
 *   CLERK_SECRET_KEY
 *   CLERK_PUBLISHABLE_KEY (para frontend, expuesto vía /api/auth/clerk/config)
 *
 * Roles: Clerk maneja custom claims. Esperamos que el usuario tenga
 *   publicMetadata.roles = ['admin', 'director', 'vendedor', ...]
 *
 * Para instalar Clerk en frontend, agregar en HTML:
 *   <script src="https://{{publishable-key-domain}}.clerk.accounts.dev/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>
 */

let clerkSdk = null;
try { clerkSdk = require('@clerk/backend'); } catch (_) { /* opcional */ }

module.exports = {
  name: 'clerk',
  async attachUser(req) {
    if (!clerkSdk || !process.env.CLERK_SECRET_KEY) return;
    const token = (req.headers.authorization || '').replace(/^Bearer /, '') ||
                  (req.cookies && req.cookies.__session);
    if (!token) return;
    try {
      const { createClerkClient } = clerkSdk;
      const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
      const sess = await clerk.sessions.getSession(token).catch(() => null);
      if (!sess || sess.status !== 'active') return;
      const user = await clerk.users.getUser(sess.userId);
      req.user = {
        id: user.id,
        email: (user.emailAddresses[0] || {}).emailAddress,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        roles: (user.publicMetadata && user.publicMetadata.roles) || ['user'],
        provider: 'clerk',
      };
    } catch (_) {}
  },
  routes(app) {
    // Expone la publishable key al frontend
    app.get('/api/auth/clerk/config', (_req, res) => {
      res.json({
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY || null,
        configured: !!clerkSdk && !!process.env.CLERK_SECRET_KEY,
      });
    });
  },
};
