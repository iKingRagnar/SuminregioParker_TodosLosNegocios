@echo off
REM ================================================================
REM  setup_scheduler.bat - Registra sync_duckdb en Task Scheduler
REM  Corre TODOS LOS DIAS a las 23:00 (11 PM) como NT AUTHORITY\SYSTEM
REM  => NO requiere tu sesion iniciada. Funciona aunque cierres sesion
REM     o reinicies el server.
REM
REM  EJECUTAR UNA SOLA VEZ como Administrador:
REM    1. Clic derecho -> "Ejecutar como administrador"
REM    2. Confirmar UAC
REM    3. Listo: sync corre cada dia a las 23:00 sin importar la sesion
REM ================================================================

SET TASK_NAME=SuminregioSyncDuckDB
SET SCRIPT_DIR=%~dp0
SET PY_SCRIPT=%SCRIPT_DIR%sync_duckdb.py
SET BAT_PATH=%SCRIPT_DIR%sync_duckdb.bat

if not exist "%PY_SCRIPT%" (
    echo [ERROR] No encuentro: %PY_SCRIPT%
    echo Este setup_scheduler.bat debe estar en la misma carpeta que sync_duckdb.py.
    pause
    exit /b 1
)

REM --- Detectar python.exe accesible por SYSTEM (NO de AppData\Local) ---
REM SYSTEM no ve python instalado solo-para-usuario en C:\Users\GUILLERMO\AppData\...
SET PY_PATH=
for /f "usebackq tokens=*" %%p in (`where python 2^>nul`) do (
    echo %%p | findstr /i /c:"AppData\\Local" >nul
    if errorlevel 1 (
        if not defined PY_PATH set PY_PATH=%%p
    )
)

echo Eliminando tarea anterior si existe...
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

if defined PY_PATH (
    echo.
    echo [OK] Python for-all-users detectado en: %PY_PATH%
    echo Creando tarea como SYSTEM (corre aunque no haya sesion iniciada)...
    echo.
    schtasks /Create ^
      /TN "%TASK_NAME%" ^
      /TR "\"%PY_PATH%\" \"%PY_SCRIPT%\"" ^
      /SC DAILY ^
      /ST 23:00 ^
      /RU "SYSTEM" ^
      /RL HIGHEST ^
      /F
) else (
    echo.
    echo [WARN] Python solo esta en AppData\Local (instalado solo para tu usuario).
    echo        SYSTEM no puede acceder ahi. La tarea se crea para TU usuario
    echo        y SOLO correra cuando tengas sesion iniciada.
    echo.
    echo        Para que corra SIN sesion iniciada:
    echo          1. Desinstala Python actual
    echo          2. Reinstala marcando "Install for all users" (requiere admin)
    echo          3. Re-ejecuta este setup_scheduler.bat
    echo.
    schtasks /Create ^
      /TN "%TASK_NAME%" ^
      /TR "\"%BAT_PATH%\"" ^
      /SC DAILY ^
      /ST 23:00 ^
      /RL HIGHEST ^
      /F
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] No se pudo crear la tarea. Ejecuta este bat como ADMINISTRADOR.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo  OK - Tarea registrada: %TASK_NAME%
echo  Corre cada dia a las 23:00
echo.
echo  Para verificar:    schtasks /Query /TN "%TASK_NAME%" /V /FO LIST
echo  Para ejecutar ya:  schtasks /Run /TN "%TASK_NAME%"
echo  Para eliminar:     schtasks /Delete /TN "%TASK_NAME%" /F
echo ================================================================
pause
