@echo off
setlocal
REM ================================================================
REM  setup_scheduler.bat - Registra sync_duckdb diario 23:00
REM  MODO USUARIO (no requiere admin del servidor)
REM
REM  Como lo ejecutas SIN admin del server, la tarea corre como
REM  tu usuario actual (%USERNAME%) y REQUIERE que tu sesion este
REM  iniciada a las 23:00.
REM
REM  COMO DEJAR SESION ABIERTA 24/7:
REM    - Conectarse por RDP
REM    - NO hacer "Cerrar sesion" (Sign out)
REM    - SOLO cerrar con la X de la ventana de RDP
REM    => tu sesion queda corriendo en el servidor
REM
REM  Si el server reinicia, hay que reconectar RDP una vez.
REM ================================================================

SET TASK_NAME=SuminregioSyncDuckDB
SET SCRIPT_DIR=%~dp0
SET BAT_PATH=%SCRIPT_DIR%sync_duckdb.bat
SET PY_SCRIPT=%SCRIPT_DIR%sync_duckdb.py

if not exist "%PY_SCRIPT%" (
    echo [ERROR] No encuentro: %PY_SCRIPT%
    pause & exit /b 1
)

if not exist "%BAT_PATH%" (
    echo [ERROR] No encuentro: %BAT_PATH%
    pause & exit /b 1
)

echo.
echo ================================================================
echo  Creando tarea para el usuario: %USERNAME%
echo  Requiere: tu sesion abierta a las 23:00
echo ================================================================
echo.

echo Eliminando tarea anterior si existe...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

echo Creando tarea programada...
schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "\"%BAT_PATH%\"" ^
  /SC DAILY ^
  /ST 23:00 ^
  /F

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] No se pudo crear la tarea. Revisa permisos.
    pause & exit /b 1
)

echo.
echo ================================================================
echo  OK - Tarea registrada: %TASK_NAME%
echo  Usuario: %USERNAME%
echo  Horario: todos los dias a las 23:00
echo  Requiere: sesion iniciada
echo.
echo  IMPORTANTE: no hagas "Cerrar sesion" en el RDP.
echo              Solo cierra la ventana RDP con la X.
echo              Asi tu sesion queda corriendo y la tarea dispara.
echo.
echo  Verificar:      schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo  Ejecutar ahora: schtasks /Run /TN "%TASK_NAME%"
echo  Eliminar:       schtasks /Delete /TN "%TASK_NAME%" /F
echo ================================================================
pause
endlocal
