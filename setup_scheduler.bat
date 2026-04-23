@echo off
REM ================================================================
REM  setup_scheduler.bat — Registra sync_duckdb.bat en Task Scheduler
REM  para correr TODOS LOS DIAS a las 23:00 (11 PM) automaticamente.
REM
REM  EJECUTAR UNA SOLA VEZ como Administrador:
REM    1. Clic derecho -> "Ejecutar como administrador"
REM    2. Confirmar creacion
REM    3. Listo: sync corre cada dia a las 23:00
REM
REM  Ruta esperada del bat: C:\Microsip datos\sync_duckdb.bat
REM ================================================================

SET TASK_NAME=SuminregioSyncDuckDB
REM Usar la ubicación del propio .bat — permite correr desde donde sea
SET BAT_PATH=%~dp0sync_duckdb.bat

if not exist "%BAT_PATH%" (
    echo [ERROR] No encuentro: %BAT_PATH%
    echo Este setup_scheduler.bat debe estar en la misma carpeta que sync_duckdb.bat.
    pause
    exit /b 1
)

echo Eliminando tarea anterior si existe...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo Creando tarea programada diaria a las 23:00...
schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "\"%BAT_PATH%\"" ^
  /SC DAILY ^
  /ST 23:00 ^
  /RL HIGHEST ^
  /F

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] No se pudo crear la tarea. Ejecuta este bat como ADMINISTRADOR.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo  OK — Tarea registrada: %TASK_NAME%
echo  Corre cada dia a las 23:00
echo  Log: C:\Microsip datos\sync_duckdb.log
echo.
echo  Para verificar:  schtasks /Query /TN "%TASK_NAME%"
echo  Para ejecutar manualmente ahora: schtasks /Run /TN "%TASK_NAME%"
echo  Para eliminar:   schtasks /Delete /TN "%TASK_NAME%" /F
echo ================================================================
pause
