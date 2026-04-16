@echo off
echo ====================================================================
echo  SUMINREGIO — Push V4: Consumos + AI Pro Max Upgrade
echo ====================================================================
cd /d "%~dp0"

echo.
echo [1/5] Limpiando git lock...
if exist ".git\index.lock" del /f ".git\index.lock"

echo.
echo [2/5] Agregando archivos modificados...

REM ─── Consumos v2 — Full rewrite ────────────────────────────────────
git add public/consumos.html

REM ─── AI Pro Max — claude.py mejorado ─────────────────────────────
git add "Asistente AI\asistente-ai\backend\services\claude.py"
git add "Asistente AI\asistente-ai\backend\services\microsip_prefetch.py"
git add "Asistente AI\asistente-ai\backend\knowledge\suminregio_consumos.md"
git add "Asistente AI\asistente-ai\backend\knowledge\suminregio_kpis_almanac.md"
git add "Asistente AI\asistente-ai\backend\knowledge\suminregio_ventas_dashboard.md"

REM ─── Chat widget mejorado ─────────────────────────────────────────
git add public/chat-widget.js

echo.
echo [3/5] Creando commit...
git commit -m "feat: consumos v2 + AI Pro Max upgrade (prompt cache + extended thinking + multi-tool)

CONSUMOS v2 (public/consumos.html):
- Full rewrite con jerarquía de métricas clara
- 8 KPIs strip con semáforos y deltas
- Tendencia diaria + moving average 7d
- Pareto 80/20 con chips de concentración
- Quiebres grid por artículo (color-coded)
- Pedidos vs Consumo con cobertura %
- Tabla vendedores con medallas y progress bars
- Semanal collapsible + lazy-loaded

AI PRO MAX (Asistente AI backend):
- Prompt caching: cache_control ephemeral en system blocks (hasta 90% menos costo)
- Extended thinking: 10k budget tokens para queries analíticas complejas
- query_microsip_multi: nueva tool — N endpoints en paralelo en 1 llamada
- get_business_health: meta-tool para diagnóstico integral rápido
- max_tokens: 8096 → 16000 para respuestas de análisis profundo
- microsip_prefetch: detecta consumos/compras y pre-inyecta contexto
- Knowledge files: suminregio_consumos.md + suminregio_kpis_almanac.md
- chat-widget.js: sugerencias contextuales mejoradas por dashboard"

echo.
echo [4/5] Push a GitHub...
git push origin main

echo.
echo ====================================================================
echo  Push V4 completado exitosamente!
echo  Cambios en: https://github.com/iKingRagnar/SuminregioParker_TodosLosNegocios
echo ====================================================================
pause
