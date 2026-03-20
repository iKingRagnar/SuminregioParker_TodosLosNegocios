/**
 * PM2 — proceso principal microsip-api (Node + Express).
 * Va en GitHub: cada clone/pull trae esta definición.
 *
 * Primera vez en la máquina:
 *   cd C:\ruta\al\repo
 *   npm ci
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * Túnel ngrok (opcional): ecosystem-ngrok.config.cjs + ngrok.exe en la raíz.
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'microsip-api',
      cwd: __dirname,
      script: path.join(__dirname, 'server_corregido.js'),
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      // Carga .env del mismo directorio (dotenv también lo lee en server_corregido.js)
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
