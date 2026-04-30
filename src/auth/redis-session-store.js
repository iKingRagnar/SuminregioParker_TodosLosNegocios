'use strict';

/**
 * Almacén Redis opcional para express-session.
 * En Render con más de una instancia (o tras deploy), MemoryStore hace que
 * el cookie apunte a una sesión que otro nodo no conoce → /api/auth/me
 * puede devolver otro usuario o sesión vacía.
 *
 * Variables: REDIS_URL o SESSION_REDIS_URL (p. ej. Redis de Render).
 */

function tryCreateRedisStore() {
  const url = String(process.env.REDIS_URL || process.env.SESSION_REDIS_URL || '').trim();
  if (!url) return null;
  try {
    const { createClient } = require('redis');
    const RedisStore = require('connect-redis').default;
    const client = createClient({ url });
    client.on('error', (err) => {
      console.error('[redis-session]', err.message);
    });
    const store = new RedisStore({
      client,
      prefix: 'suminregio:sess:',
    });
    client
      .connect()
      .then(() => {
        console.log('[auth] Sesiones en Redis (compartidas entre instancias).');
      })
      .catch((e) => {
        console.error('[auth] Redis no conectó; sesiones siguen en memoria:', e.message);
      });
    return store;
  } catch (e) {
    console.warn('[auth] connect-redis no disponible:', e.message);
    return null;
  }
}

module.exports = { tryCreateRedisStore };
