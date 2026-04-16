@echo off
echo =========================================================
echo  SUMINREGIO — Asistente IA Pro (FastAPI + React)
echo =========================================================
echo.
echo Este script inicia el Asistente IA avanzado en 2 terminales:
echo   Backend: FastAPI en http://localhost:8000
echo   Frontend: React/Vite en http://localhost:5173
echo.
echo PREREQUISITOS (una sola vez):
echo   pip install -r "Asistente AI\asistente-ai\backend\requirements.txt"
echo   cd "Asistente AI\asistente-ai\frontend" ^&^& npm install
echo.
echo Presiona cualquier tecla para iniciar...
pause > nul

REM Cambiar al directorio del proyecto
set "AI_DIR=%~dp0Asistente AI\asistente-ai"

REM Abrir terminal 1: FastAPI backend
start "Asistente AI — Backend" cmd /k "cd /d \"%AI_DIR%\backend\" && echo Iniciando FastAPI backend... && uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

REM Esperar 3 segundos para que el backend arranque
timeout /t 3 /nobreak > nul

REM Abrir terminal 2: Vite frontend
start "Asistente AI — Frontend" cmd /k "cd /d \"%AI_DIR%\frontend\" && echo Iniciando React frontend... && npm run dev"

echo.
echo Asistente IA iniciando...
echo.
echo   Backend API: http://localhost:8000
echo   Frontend:    http://localhost:5173
echo   API Docs:    http://localhost:8000/docs
echo.
echo Abre http://localhost:5173 en tu navegador para usar el Asistente IA.
echo.
echo Para detener: cierra las ventanas de terminal.
echo.
pause
