'use strict';

/**
 * Dummy auth provider — sin autenticación real, todos son admin anónimo.
 * Solo para desarrollo / modo single-user.
 */

module.exports = {
  name: 'dummy',
  async attachUser(req) {
    req.user = {
      id: 'anon',
      email: 'anon@suminregio.local',
      name: 'Admin (dev)',
      roles: ['admin', 'director', 'vendedor'],
      provider: 'dummy',
    };
  },
  routes() {},
};
