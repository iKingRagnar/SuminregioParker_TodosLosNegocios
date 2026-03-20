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
// Puerto local de la API (debe coincidir con .env / server_corregido.js). Solo dígitos.
const raw = (process.env.PORT && String(process.env.PORT).trim()) || '7000';
const port = String(parseInt(raw, 10) || 7000);

module.exports = {
  apps: [
    {
      name: 'ngrok-tunnel',
      cwd: __dirname,
      script: exe,
      // ngrok v3: subcomando "http" + puerto. No uses --log=stdout aquí (provoca ayuda y exit).
      args: ['http', port],
      interpreter: 'none',
      autorestart: true,
      max_restarts: 30,
      min_uptime: '5s',
    },
  ],
};
