@echo off
REM ============================================================
REM  sync_duckdb.bat — Suminregio Parker: Nightly DuckDB Sync
REM  Ejecutar via Windows Task Scheduler a las 23:00 (11 PM)
REM
REM  RUTA CORRECTA del servidor: C:\Microsip datos\
REM  (tiene espacio — es "Microsip datos" no "Microsip\Datos")
REM
REM  Copiar este .bat y sync_duckdb.py a: C:\Microsip datos\
REM  Luego en Task Scheduler apuntar a:   C:\Microsip datos\sync_duckdb.bat
REM ============================================================

REM --- Variables de entorno (quitar REM si no están configuradas en Windows) ---
REM SET FB_DATABASE=C:\Microsip datos\SUMINREGIO-PARKER.FDB
REM SET FB_PASSWORD=masterkey
REM SET FB_HOST=localhost
REM SET RENDER_URL=https://suminregioparker-todoslosnegocios.onrender.com
REM SET SNAPSHOT_TOKEN=suminregio-snap-2026
REM SET DUCK_OUT=C:\Microsip datos\snapshot.duckdb

cd /d %~dp0

echo [%DATE% %TIME%] Iniciando sync DuckDB...
python "%~dp0sync_duckdb.py" >> "%~dp0sync_duckdb.log" 2>&1

if %ERRORLEVEL% NEQ 0 (
    echo [%DATE% %TIME%] ERROR: sync fallo con codigo %ERRORLEVEL% >> "%~dp0sync_duckdb.log"
    exit /b %ERRORLEVEL%
)

echo [%DATE% %TIME%] Sync completado exitosamente >> "%~dp0sync_duckdb.log"
exit /b 0
