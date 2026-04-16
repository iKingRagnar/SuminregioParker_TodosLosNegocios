@echo off
echo ====================================================================
echo  SUMINREGIO — Push V3: FULL UPDATE (V2+V3)
echo  Performance cache + Dark Theme ALL dashboards + Mobile + IA Pro
echo ====================================================================
cd /d "%~dp0"

echo.
echo [1/5] Limpiando git lock...
if exist ".git\index.lock" del /f ".git\index.lock"

echo.
echo [2/5] Agregando archivos modificados...

REM ─── V2: Performance cache + Premium redesigns (NO incluidos en commit anterior) ──
git add public/data-cache.js
git add public/app-ui-boot.js
git add public/chat-widget.js
git add public/Dashboard_Ventas.html
git add public/Dashboard_CC.html
git add public/Dashboard_Scorecard.html
git add public/Dashboard_Correlacion.html

REM ─── V3: Dark theme — 12 dashboards restantes ─────────────────────────────
git add public/app-responsive.css
git add public/Dashboard_Comisiones.html
git add public/Dashboard_Estacionalidad.html
git add public/Dashboard_Clientes.html
git add public/Dashboard_Alertas.html
git add public/Dashboard_Rentabilidad.html
git add public/Dashboard_DSO.html
git add public/Dashboard_CP.html
git add public/Dashboard_Flujo.html
git add public/Dashboard_ABC.html
git add public/Dashboard_Rotacion.html
git add public/Dashboard_Rotacion_Profundo.html
git add public/Dashboard_Compras.html

echo.
echo [3/5] Creando commit...
git commit -m "feat: performance cache + dark theme 16 dashboards + mobile responsive + IA Pro

PERFORMANCE (V2):
- public/data-cache.js: cache localStorage+memoria TTL 2h, intercept fetch /api/*
- public/app-ui-boot.js: inyecta data-cache.js automaticamente + IA Pro launcher

REDISENOS PREMIUM (V2):
- public/Dashboard_Ventas.html: redesign visual premium completo
- public/Dashboard_CC.html: aging color-coding, risk badges, DM Mono
- public/Dashboard_Scorecard.html: gold/silver/bronze ranking, avatares, progress bars
- public/Dashboard_Correlacion.html: NUEVO scatter + regresion lineal + ratio por mes

CHAT IA (V2):
- public/chat-widget.js: sugerencias contextuales por pagina

DARK THEME 12 DASHBOARDS (V3):
- Dashboard_Comisiones, Estacionalidad, Clientes, Alertas,
  Rentabilidad, DSO, CP, Flujo, ABC, Rotacion, Rotacion_Profundo, Compras
  Todos actualizados con: tokens oscuros, KPI glass cards, tablas dark,
  nav premium scrollable horizontal, Syne+DM Mono fonts

MOBILE RESPONSIVE (V3):
- public/app-responsive.css: +200 lineas — headers movil, KPI grids 2/1 col,
  scorecard, correlacion, CC, balance, AI Pro button

IA PRO LAUNCHER (V3):
- app-ui-boot.js: bootAiProLauncher() → boton dorado en todos los navs
  abre Asistente IA Pro (localhost:5173) en nueva pestana"

echo.
echo [4/5] Push a GitHub...
git push origin main

echo.
echo ====================================================================
echo  Push V3 completado exitosamente!
echo  Cambios en: https://github.com/iKingRagnar/SuminregioParker_TodosLosNegocios
echo ====================================================================
pause
