/**
 * PM2 — túnel ngrok hacia la API (mismo puerto que server_corregido.js: PORT o 7000).
 * Este archivo SÍ va en GitHub. El binario ngrok.exe NO (está en .gitignore).
 *
 * Requisitos:
 *   1) Copiar ngrok.exe en la raíz del repo (junto a package.json).
 *   2) Una vez por máquina: ngrok config add-authtoken TU_TOKEN
 *   3) pm2 start ecosystem-ngrok.config.cjs
 *   4) pm2 save
 */
const path = require('path');

const exe = path.join(__dirname, 'ngrok.exe');
// Puerto al que ngrok debe tunelar (debe coincidir con PORT en .env o 7000 por defecto en server_corregido.js)
const port = process.env.PORT || '7000';

module.exports = {
  apps: [
    {
      name: 'ngrok-tunnel',
      cwd: __dirname,
      script: exe,
      args: `http ${port} --log=stdout`,
      interpreter: 'none',
      autorestart: true,
      max_restarts: 30,
      min_uptime: '5s',
    },
  ],
};
