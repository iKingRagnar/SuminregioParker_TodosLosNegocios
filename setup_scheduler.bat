@echo off
setlocal enabledelayedexpansion
REM ================================================================
REM  setup_scheduler.bat - Registra sync_duckdb diario a las 23:00
REM
REM  Detecta automaticamente la mejor opcion:
REM    A) SYSTEM (sin password, sin sesion, si hay Python for-all-users)
REM    B) Tu usuario + password guardado (sin sesion, password encriptado)
REM    C) Solo con sesion iniciada (fallback, si cancelas password)
REM
REM  EJECUTAR UNA SOLA VEZ como Administrador:
REM    Clic derecho -> "Ejecutar como administrador"
REM ================================================================

SET TASK_NAME=SuminregioSyncDuckDB
SET SCRIPT_DIR=%~dp0
SET PY_SCRIPT=%SCRIPT_DIR%sync_duckdb.py
SET BAT_PATH=%SCRIPT_DIR%sync_duckdb.bat

if not exist "%PY_SCRIPT%" (
    echo [ERROR] No encuentro: %PY_SCRIPT%
    pause & exit /b 1
)

REM --- Detectar python.exe accesible por SYSTEM (NO de AppData\Local) ---
SET PY_PATH=
for /f "usebackq tokens=*" %%p in (`where python 2^>nul`) do (
    echo %%p | findstr /i /c:"AppData\\Local" >nul
    if errorlevel 1 (
        if not defined PY_PATH set PY_PATH=%%p
    )
)

echo.
echo Eliminando tarea anterior si existe...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

if defined PY_PATH (
    echo.
    echo [MODO A] Python for-all-users detectado: !PY_PATH!
    echo Creando tarea como SYSTEM (sin sesion, sin password)...
    schtasks /Create ^
      /TN "%TASK_NAME%" ^
      /TR "\"!PY_PATH!\" \"%PY_SCRIPT%\"" ^
      /SC DAILY ^
      /ST 23:00 ^
      /RU "SYSTEM" ^
      /RL HIGHEST ^
      /F
    goto :verify
)

echo.
echo Python solo esta en AppData\Local (no accesible por SYSTEM).
echo.
echo ==========================================================
echo  OPCION B: Usar tu usuario + password guardado
echo  - Password se encripta por Windows Task Scheduler
echo  - Tarea corre SIN sesion iniciada
echo  - Solo escribes el password UNA vez aqui
echo ==========================================================
echo.
set /p USER_PASS=Password de %USERNAME% (ENTER vacio = modo C solo-con-sesion):

if "!USER_PASS!"=="" goto :modo_c

echo.
echo [MODO B] Creando tarea como %USERNAME% con password guardado...
schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "\"%BAT_PATH%\"" ^
  /SC DAILY ^
  /ST 23:00 ^
  /RU "%USERNAME%" ^
  /RP "!USER_PASS!" ^
  /RL HIGHEST ^
  /F
goto :verify

:modo_c
echo.
echo [MODO C] Creando tarea SOLO-con-sesion-iniciada (fallback)...
echo         AVISO: si cierras sesion, la tarea NO correra.
schtasks /Create ^
  /TN "%TASK_NAME%" ^
  /TR "\"%BAT_PATH%\"" ^
  /SC DAILY ^
  /ST 23:00 ^
  /RL HIGHEST ^
  /F

:verify
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] No se pudo crear la tarea. Verifica:
    echo   1. Estas ejecutando como Administrador ^(clic derecho^)
    echo   2. El password escrito es correcto ^(si usaste modo B^)
    pause & exit /b 1
)

echo.
echo ================================================================
echo  OK - Tarea registrada: %TASK_NAME%
echo  Corre cada dia a las 23:00
echo.
echo  Verificar:       schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo  Ejecutar ahora:  schtasks /Run /TN "%TASK_NAME%"
echo  Eliminar:        schtasks /Delete /TN "%TASK_NAME%" /F
echo ================================================================
pause
endlocal
