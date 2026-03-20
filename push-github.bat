@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
set "REPO=%~dp0"
cd /d "%REPO%"

REM Git en PATH o ruta típica (evita "git no reconocido" en algunas consolas)
set "GIT=git"
where git >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\Git\bin\git.exe" set "GIT=C:\Program Files\Git\bin\git.exe"
  if exist "C:\Program Files (x86)\Git\bin\git.exe" set "GIT=C:\Program Files (x86)\Git\bin\git.exe"
)

for /f "tokens=*" %%b in ('"%GIT%" rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if "!BRANCH!"=="" (
  echo [ERROR] No parece un repo Git ^(falta .git^) o Git no instalado.
  pause
  exit /b 1
)

set "MSG=%~1"
if "!MSG!"=="" set "MSG=Actualización microsip-api"

echo === Rama actual: !BRANCH! ===
echo === git add -A ===
"%GIT%" add -A
if errorlevel 1 (
  echo [ERROR] git add falló ^(¿Filename too long? Revisa .gitignore^).
  pause
  exit /b 1
)

REM ¿Hay algo en staging? Si no, no hagas commit ^(antes fallaba con "nothing to commit"^)
"%GIT%" diff --cached --quiet
if errorlevel 1 (
  echo === git commit ===
  "%GIT%" commit -m "!MSG!"
  if errorlevel 1 (
    echo [ERROR] git commit falló ^(mensaje o conflicto^).
    pause
    exit /b 1
  )
) else (
  echo [INFO] No hay cambios nuevos para commit; se intenta push por si quedaron commits locales.
)

echo === git push origin !BRANCH! ===
"%GIT%" push -u origin "!BRANCH!"
if errorlevel 1 (
  echo [ERROR] push falló. Revisa red, credenciales y que exista la rama en GitHub.
  pause
  exit /b 1
)
echo Listo.
pause
endlocal
