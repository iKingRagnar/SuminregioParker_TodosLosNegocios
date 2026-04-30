'use strict';

/**
 * Autenticación por sesión (cookie httpOnly) + formulario login.
 * Credenciales en AUTH_USERS: "email:password:rol;email2:pass2:rol2"
 * También acepta "usuario:contraseña" (un solo :) → rol admin.
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
    if (idx <= 0) return;
    const idx2 = t.indexOf(':', idx + 1);
    let email;
    let password;
    let r;
    if (idx2 <= idx) {
      // usuario:contraseña (sin rol → admin) — compatible con envs de 2 segmentos
      email = t.slice(0, idx).trim().toLowerCase();
      password = t.slice(idx + 1).trim();
      r = 'admin';
    } else {
      email = t.slice(0, idx).trim().toLowerCase();
      password = t.slice(idx + 1, idx2).trim();
      r = t.slice(idx2 + 1).trim();
    }
    if (email && password) {
      map.set(email, {
        password,
        roles: (r || 'admin').split(',').map((x) => x.trim()).filter(Boolean),
      });
    }
  });
  return map;
}

const USERS = parseUsers();

if (String(process.env.AUTH_PROVIDER || '').toLowerCase() === 'session' && USERS.size === 0) {
  console.warn('[auth/session] AUTH_USERS no tiene entradas válidas. Usa correo:contraseña:rol o correo:contraseña (→ admin).');
}

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
          res.clearCookie('suminregio.sid', { path: '/', sameSite: 'lax' });
          res.json({ ok: true });
        });
      } else {
        res.clearCookie('suminregio.sid', { path: '/', sameSite: 'lax' });
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

  // Nueva sesión en cada login: evita arrastrar datos/cookie de otro usuario
  // y reduce fijación de sesión (session fixation).
  req.session.regenerate((regenErr) => {
    if (regenErr) {
      console.error('[auth/session] regenerate:', regenErr.message);
      return res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
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
  });
}
