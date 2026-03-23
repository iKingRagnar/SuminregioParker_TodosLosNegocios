@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

set "REPO=%~dp0"
cd /d "%REPO%"

set "GIT=git"
where git >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\Git\bin\git.exe" set "GIT=C:\Program Files\Git\bin\git.exe"
  if exist "C:\Program Files (x86)\Git\bin\git.exe" set "GIT=C:\Program Files (x86)\Git\bin\git.exe"
)

for /f "tokens=*" %%b in ('"%GIT%" rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if "!BRANCH!"=="" (
  echo [ERROR] Este folder no parece repo Git.
  exit /b 1
)

set "MSG=%~1"
if "!MSG!"=="" set "MSG=Deploy microsip-api"

set "REMOTE_SSH=%~2"
if "!REMOTE_SSH!"=="" set "REMOTE_SSH=usuario@tu-servidor"

set "APP_DIR=%~3"
if "!APP_DIR!"=="" set "APP_DIR=/ruta/a/microsip-api"

set "PM2_NAME=%~4"
if "!PM2_NAME!"=="" set "PM2_NAME=microsip-api"

set "BASE_URL=%~5"
if "!BASE_URL!"=="" set "BASE_URL=https://arthrodiran-unmutual-meadow.ngrok-free.dev"

echo.
echo [1/3] Git add/commit/push en !BRANCH!
"%GIT%" add -A
if errorlevel 1 (
  echo [ERROR] git add fallo.
  exit /b 1
)

"%GIT%" diff --cached --quiet
if errorlevel 1 (
  "%GIT%" commit -m "!MSG!"
  if errorlevel 1 (
    echo [ERROR] git commit fallo.
    exit /b 1
  )
) else (
  echo [INFO] No habia cambios staged; se intentara push de todos modos.
)

"%GIT%" push -u origin "!BRANCH!"
if errorlevel 1 (
  echo [ERROR] git push fallo.
  exit /b 1
)

echo.
echo [2/3] Comando remoto recomendado (copiar y pegar):
echo ssh !REMOTE_SSH! "cd !APP_DIR! && bash ./scripts/deploy-remote.sh !APP_DIR! !PM2_NAME! !BASE_URL!"

echo.
echo [3/3] Verificaciones API recomendadas:
echo curl -s "!BASE_URL!/api/resultados/pnl?db=default^&desde=2026-03-01^&hasta=2026-03-31"
echo curl -s "!BASE_URL!/api/ai/chat" -H "content-type: application/json" -d "{\"message\":\"cuanto vendi hoy\",\"provider\":\"anthropic\",\"db\":\"default\"}"

echo.
echo Listo. Push completado y comando remoto generado.
endlocal
