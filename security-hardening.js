'use strict';

/**
 * security-hardening.js — 2FA TOTP + rate-limit global
 *   GET  /api/sec/2fa/setup       → genera secret + QR URL para admin
 *   POST /api/sec/2fa/verify      → valida código TOTP (stateless, sin DB)
 *   Rate limit extendido a endpoints de escritura + admin
 */

const crypto = require('crypto');

// ── TOTP (RFC 6238) — implementación manual sin deps ─────────────────────────
function base32decode(b32) {
  const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.replace(/=+$/, '').toUpperCase()) {
    const v = alph.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function base32encode(buf) {
  const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  while (bits.length % 5) bits += '0';
  for (let i = 0; i < bits.length; i += 5) out += alph[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function totp(secretB32, timeStep) {
  timeStep = timeStep || Math.floor(Date.now() / 30000);
  const key = base32decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
  buf.writeUInt32BE(timeStep & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

function install(app, { createRateLimiter, log }) {
  const json = require('express').json();

  // ── 2FA TOTP ────────────────────────────────────────────────────────────────
  app.get('/api/sec/2fa/setup', (_req, res) => {
    // Genera secret aleatorio de 20 bytes (160 bits)
    const secret = base32encode(crypto.randomBytes(20));
    const issuer = 'Suminregio';
    const account = 'admin';
    const otpauth = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6&algorithm=SHA1`;
    res.json({
      secret,
      otpauth,
      qrURL: 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(otpauth),
      hint: 'Escanea en Google Authenticator / Authy, guarda el secret en env TOTP_SECRET.',
    });
  });

  app.post('/api/sec/2fa/verify', json, (req, res) => {
    const { secret, code } = req.body || {};
    const useSecret = secret || process.env.TOTP_SECRET;
    if (!useSecret || !code) return res.status(400).json({ error: 'Falta secret/code' });
    // Ventana ±1 (90s total)
    const now = Math.floor(Date.now() / 30000);
    const valid = [now - 1, now, now + 1].some((t) => totp(useSecret, t) === String(code).padStart(6, '0'));
    res.json({ ok: valid });
  });

  // ── Middleware 2FA para admin endpoints ─────────────────────────────────────
  if (process.env.TOTP_SECRET && process.env.REQUIRE_2FA_ADMIN === '1') {
    app.use(['/api/admin/', '/api/cache/flush'], (req, res, next) => {
      // Excepciones: lectura (GET) no requiere 2FA
      if (req.method === 'GET') return next();
      const code = req.headers['x-2fa-code'];
      if (!code) return res.status(401).json({ error: 'Requiere X-2FA-Code' });
      const now = Math.floor(Date.now() / 30000);
      const valid = [now - 1, now, now + 1].some((t) => totp(process.env.TOTP_SECRET, t) === String(code).padStart(6, '0'));
      if (!valid) return res.status(401).json({ error: '2FA inválido' });
      next();
    });
    log.info('security', '2FA activa para admin writes');
  }

  // ── Rate limit global extendido ────────────────────────────────────────────
  if (createRateLimiter) {
    const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
    app.use(['/api/admin/', '/api/collab/', '/api/notify/'], (req, res, next) => {
      if (req.method === 'GET') return next();
      return writeLimiter(req, res, next);
    });
    log.info('security', 'rate-limit global a writes /api/admin|collab|notify');
  }
}

module.exports = { install, totp };
