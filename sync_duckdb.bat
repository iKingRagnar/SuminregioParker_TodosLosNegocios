@echo off
REM ============================================================
REM  sync_duckdb.bat — Suminregio Parker: Nightly DuckDB Sync
REM  Ejecutar via Windows Task Scheduler a las 23:00 (11 PM)
REM  Ruta sugerida: C:\Microsip\sync_duckdb.bat
REM ============================================================

REM --- Opcional: activar variables de entorno si no están en el sistema ---
REM SET FB_DATABASE=C:\Microsip\Datos\SUMIN.FDB
REM SET FB_PASSWORD=masterkey
REM SET RENDER_URL=https://suminregioparker-todoslosnegocios.onrender.com
REM SET SNAPSHOT_TOKEN=suminregio-snap-2026
REM SET DUCK_OUT=C:\Microsip\snapshot.duckdb

cd /d %~dp0

echo [%DATE% %TIME%] Iniciando sync DuckDB...
python "%~dp0sync_duckdb.py" >> "%~dp0sync_duckdb.log" 2>&1

if %ERRORLEVEL% NEQ 0 (
    echo [%DATE% %TIME%] ERROR: sync fallo con codigo %ERRORLEVEL% >> "%~dp0sync_duckdb.log"
    exit /b %ERRORLEVEL%
)

echo [%DATE% %TIME%] Sync completado exitosamente >> "%~dp0sync_duckdb.log"
exit /b 0
