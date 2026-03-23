#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:-/ruta/a/microsip-api}"
PM2_NAME="${2:-microsip-api}"
BASE_URL="${3:-http://127.0.0.1:3000}"

echo "[deploy] app_dir=${APP_DIR}"
echo "[deploy] pm2=${PM2_NAME}"
echo "[deploy] base_url=${BASE_URL}"

cd "${APP_DIR}"

echo "[deploy] git pull"
git pull origin "$(git rev-parse --abbrev-ref HEAD)"

echo "[deploy] npm install --omit=dev"
npm install --omit=dev

echo "[deploy] pm2 restart"
pm2 restart "${PM2_NAME}" --update-env

echo "[deploy] pm2 status"
pm2 status "${PM2_NAME}"

echo "[deploy] smoke check resultados"
curl -fsS "${BASE_URL}/api/resultados/pnl?db=default&desde=2026-03-01&hasta=2026-03-31" >/dev/null

echo "[deploy] smoke check ai chat"
curl -fsS "${BASE_URL}/api/ai/chat" \
  -H "content-type: application/json" \
  -d '{"message":"cuanto vendi hoy","provider":"anthropic","db":"default"}' >/dev/null

echo "[deploy] OK"
