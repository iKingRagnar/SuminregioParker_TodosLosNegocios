#!/usr/bin/env bash
# scripts/check-budget.sh — Performance budget para HTML/CSS/JS frontend.
#
# Filosofía: si un archivo crece >50% en una sola PR, probablemente algo se
# rompió o se dejó código no usado. Si pasa el budget total, considera
# code splitting o lazy loading.
#
# Outputs:
#   - Tabla de archivos con tamaño actual + budget
#   - Exit 1 si algún archivo excede su budget
#
# Para ajustar budgets: editar la tabla BUDGETS abajo.

set -u

declare -A BUDGETS=(
  ["index.html"]="220000"
  ["cxc.html"]="220000"
  ["ventas.html"]="200000"
  ["resultados.html"]="280000"
  ["inventario.html"]="180000"
  ["clientes.html"]="180000"
  ["director.html"]="180000"
  ["consumos.html"]="180000"
  ["cobradas.html"]="180000"
  ["vendedores.html"]="180000"
  ["margen-producto.html"]="180000"
  ["performance.html"]="50000"
  ["filters.js"]="80000"
  ["nav.js"]="60000"
  ["safe-dom.js"]="3000"
  ["pwa-register.js"]="3000"
  ["sw.js"]="5000"
  ["ai-chat-widget.js"]="20000"
)

PASS=0
FAIL=0
TOTAL_SIZE=0
WARNINGS=0

printf '\n\033[1m📦 Performance budget check\033[0m\n\n'
printf '  %-32s %10s %10s %10s %s\n' "Archivo" "Tamaño" "Budget" "Δ" "Status"
printf '  %s\n' "─────────────────────────────────────────────────────────────────────"

for file in "${!BUDGETS[@]}"; do
  budget="${BUDGETS[$file]}"
  if [ -f "$file" ]; then
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null)
    TOTAL_SIZE=$((TOTAL_SIZE + size))
    pct_used=$((size * 100 / budget))
    delta=$((size - budget))
    if [ "$size" -le "$budget" ]; then
      if [ "$pct_used" -ge 90 ]; then
        # Within budget but >90% — warn so future PR doesn't surprise
        printf '  %-32s %10d %10d %+10d \033[33m⚠ %d%%\033[0m\n' "$file" "$size" "$budget" "$delta" "$pct_used"
        WARNINGS=$((WARNINGS + 1))
      else
        printf '  %-32s %10d %10d %+10d \033[32m✓ %d%%\033[0m\n' "$file" "$size" "$budget" "$delta" "$pct_used"
      fi
      PASS=$((PASS + 1))
    else
      printf '  %-32s %10d %10d \033[31m%+10d ✗ %d%% OVER\033[0m\n' "$file" "$size" "$budget" "$delta" "$pct_used"
      FAIL=$((FAIL + 1))
    fi
  else
    printf '  %-32s %s\n' "$file" "(no encontrado, skip)"
  fi
done

printf '  %s\n' "─────────────────────────────────────────────────────────────────────"
printf '  %-32s %10d bytes (%d KB)\n' "TOTAL" "$TOTAL_SIZE" "$((TOTAL_SIZE / 1024))"

printf '\n\033[1mResultado: %d pass · %d fail · %d warnings\033[0m\n\n' "$PASS" "$FAIL" "$WARNINGS"

if [ $FAIL -gt 0 ]; then
  printf '\033[31m✗ Algunos archivos exceden su budget. Considera:\033[0m\n'
  printf '   - Mover CSS común a public/app.css\n'
  printf '   - Lazy loading de Chart.js solo cuando se necesite\n'
  printf '   - Extraer JS inline a archivos cacheables\n'
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  printf '\033[33m⚠ Algunos archivos están cerca del límite (>90%%).\033[0m\n'
  printf '   Considera revisar antes del próximo crecimiento.\n'
fi

printf '\033[32m✓ Performance budget OK\033[0m\n'
exit 0
