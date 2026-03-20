@echo off
chcp 65001 >nul
set "ROOT=%~dp0.."
cd /d "%ROOT%"

echo === PM2: microsip-api ===
pm2 describe microsip-api >nul 2>&1
if %errorlevel%==0 (
  pm2 restart microsip-api
) else (
  pm2 start ecosystem.config.cjs
)

if exist "%ROOT%\ngrok.exe" (
  echo === PM2: ngrok-tunnel ===
  pm2 describe ngrok-tunnel >nul 2>&1
  if %errorlevel%==0 (
    pm2 restart ngrok-tunnel
  ) else (
    pm2 start ecosystem-ngrok.config.cjs
  )
) else (
  echo [AVISO] No hay ngrok.exe en la raiz del repo. Solo corre la API. Descarga: https://ngrok.com/download
)

pm2 save
echo.
pm2 list
