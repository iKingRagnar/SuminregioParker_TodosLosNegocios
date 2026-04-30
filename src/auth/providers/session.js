'use strict';

/**
 * Autenticación por sesión (cookie httpOnly) + formulario login.
 * Credenciales en AUTH_USERS: "email:password:rol;email2:pass2:rol2"
 * Roles: admin | gerente | vendedor (coma para varios: admin,gerente)
 *
 * Contraseñas no deben contener ":" ni ";" (separadores del formato).
 */

const crypto = require('crypto');

const LOGIN_MAX_ATTEMPTS = parseInt(process.env.AUTH_LOGIN_MAX_ATTEMPTS || '12', 10);
const LOGIN_WINDOW_MS = parseInt(process.env.AUTH_LOGIN_WINDOW_MS || '900000', 10); // 15 min

/** @type {Map<string, { password: string, roles: string[] }>} */
function parseUsers() {
  const raw = process.env.AUTH_USERS || '';
  const map = new Map();
  raw.split(';').forEach((entry) => {
    const t = (entry || '').trim();
    if (!t) return;
    const idx = t.indexOf(':');
    const idx2 = t.indexOf(':', idx + 1);
    if (idx <= 0 || idx2 <= idx) return;
    const email = t.slice(0, idx).trim().toLowerCase();
    const password = t.slice(idx + 1, idx2).trim();
    const r = t.slice(idx2 + 1).trim();
    if (email && password) {
      map.set(email, {
        password,
        roles: (r || 'user').split(',').map((x) => x.trim()).filter(Boolean),
      });
    }
  });
  return map;
}

const USERS = parseUsers();

/** SHA-256 comparación en tiempo constante (evita leak por longitud). */
function passwordsMatch(given, expected) {
  const a = crypto.createHash('sha256').update(String(given), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  try {
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const _attempts = new Map(); // ip → { n, resetAt }

function recordFailure(ip) {
  const now = Date.now();
  let row = _attempts.get(ip);
  if (!row || now > row.resetAt) row = { n: 0, resetAt: now + LOGIN_WINDOW_MS };
  row.n += 1;
  _attempts.set(ip, row);
  return row.n >= LOGIN_MAX_ATTEMPTS;
}

function clearFailures(ip) {
  _attempts.delete(ip);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = {
  name: 'session',
  USERS,

  async attachUser(req) {
    const s = req.session;
    if (s && s.user) {
      req.user = {
        id: s.user.id,
        email: s.user.email,
        name: s.user.name || s.user.email,
        roles: s.user.roles || [],
        provider: 'session',
      };
    }
  },

  routes(app) {
    app.post('/api/auth/login', expressJsonLogin);
    app.post('/api/auth/logout', (req, res) => {
      if (req.session) {
        req.session.destroy(() => {
          res.clearCookie('connect.sid', { path: '/' });
          res.json({ ok: true });
        });
      } else {
        res.json({ ok: true });
      }
    });
  },
};

function expressJsonLogin(req, res) {
  const ip = clientIp(req);
  const row = _attempts.get(ip);
  if (row && Date.now() <= row.resetAt && row.n >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({
      error: 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
      code: 'RATE_LIMIT',
    });
  }

  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const entry = USERS.get(email);

  if (!entry || !passwordsMatch(password, entry.password)) {
    const locked = recordFailure(ip);
    return res.status(401).json({
      error: locked
        ? 'Cuenta bloqueada temporalmente por intentos fallidos.'
        : 'Correo o contraseña incorrectos.',
      code: 'LOGIN_FAILED',
    });
  }

  clearFailures(ip);

  const user = {
    id: email,
    email,
    name: email,
    roles: entry.roles,
  };
  req.session.user = user;
  req.session.save((err) => {
    if (err) {
      console.error('[auth/session] save:', err.message);
      return res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
    res.json({
      ok: true,
      user: { email: user.email, roles: user.roles },
    });
  });
}
