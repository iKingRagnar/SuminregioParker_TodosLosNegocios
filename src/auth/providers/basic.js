'use strict';

/**
 * HTTP Basic Auth provider.
 * Env AUTH_USERS = "guillermo:pass123:admin;juan:otra:vendedor"
 * (user:password:role separados por ; entre usuarios)
 */

function parseUsers() {
  const raw = process.env.AUTH_USERS || '';
  const map = new Map();
  raw.split(';').forEach((entry) => {
    const [u, p, r] = entry.split(':').map((s) => (s || '').trim());
    if (u && p) map.set(u, { password: p, roles: (r || 'user').split(',').map((x) => x.trim()) });
  });
  return map;
}

const USERS = parseUsers();

module.exports = {
  name: 'basic',
  async attachUser(req) {
    const h = req.headers.authorization;
    if (!h || !/^Basic /.test(h)) return;
    try {
      const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      const entry = USERS.get(u);
      if (entry && entry.password === p) {
        req.user = { id: u, email: u, name: u, roles: entry.roles, provider: 'basic' };
      }
    } catch (_) {}
  },
  routes(app) {
    app.get('/api/auth/basic/challenge', (_req, res) => {
      res.set('WWW-Authenticate', 'Basic realm="Suminregio"');
      res.status(401).json({ error: 'Basic auth required' });
    });
  },
};
