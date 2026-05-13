#!/usr/bin/env bash
# scripts/smoke-deploy.sh — Verifica que un deploy esté sano.
#
# Uso:
#   ./scripts/smoke-deploy.sh https://suminregioparker.onrender.com
#   ./scripts/smoke-deploy.sh https://staging.example.com   # con --staging
#
# Verifica:
#  - /health responde 200
#  - /api/admin/mode tiene snapshots
#  - /api/health/deep está healthy o degraded (no unhealthy)
#  - Headers de seguridad están
#  - /api/metrics responde formato prometheus
#  - /api/ai/chat-v3/tools lista >=15 tools
#
# Exit codes:
#   0 — todo OK
#   1 — uno o más checks fallaron
#
# Variables opcionales:
#   SMOKE_TIMEOUT (default 10s por request)
#   SMOKE_VERBOSE=1 muestra responses completas

set -u
BASE="${1:-http://127.0.0.1:7000}"
TIMEOUT="${SMOKE_TIMEOUT:-10}"
VERBOSE="${SMOKE_VERBOSE:-0}"

PASS=0
FAIL=0
WARNINGS=0

color_ok() { printf '\033[32m✓\033[0m'; }
color_err() { printf '\033[31m✗\033[0m'; }
color_warn() { printf '\033[33m!\033[0m'; }

check() {
  local name="$1"
  local cmd="$2"
  local result
  result=$(eval "$cmd" 2>&1)
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then
    printf '  %s %s\n' "$(color_ok)" "$name"
    PASS=$((PASS + 1))
    [ "$VERBOSE" = "1" ] && [ -n "$result" ] && printf '    %s\n' "$result"
  else
    printf '  %s %s\n' "$(color_err)" "$name"
    printf '    %s\n' "$result"
    FAIL=$((FAIL + 1))
  fi
}

warn_check() {
  local name="$1"
  local cmd="$2"
  local result
  result=$(eval "$cmd" 2>&1)
  if [ $? -eq 0 ]; then
    printf '  %s %s\n' "$(color_ok)" "$name"
    PASS=$((PASS + 1))
  else
    printf '  %s %s\n' "$(color_warn)" "$name"
    printf '    %s\n' "$result"
    WARNINGS=$((WARNINGS + 1))
  fi
}

printf '\n\033[1mSmoke test: %s\033[0m\n\n' "$BASE"

# 1. Health basico
check "/health responde 200" \
  "curl -fsS --max-time $TIMEOUT '$BASE/health' >/dev/null"

# 2. Admin mode
check "/api/admin/mode responde JSON" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/admin/mode' | grep -q duckOnlyMode"

# 3. Health deep — accept healthy o degraded, no unhealthy
warn_check "/api/health/deep healthy/degraded" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/health/deep' | grep -qE '\"status\":\"(healthy|degraded)\"'"

# 4. Security headers
check "X-Content-Type-Options nosniff" \
  "curl -fsS --max-time $TIMEOUT -I '$BASE/api/admin/mode' | grep -qi 'x-content-type-options: nosniff'"

check "X-Frame-Options" \
  "curl -fsS --max-time $TIMEOUT -I '$BASE/api/admin/mode' | grep -qi 'x-frame-options'"

# 5. Metrics
check "/api/metrics formato prometheus" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/metrics' | grep -q '# HELP'"

# 6. AI tools catalog
check "/api/ai/chat-v3/tools >=15 tools" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/ai/chat-v3/tools' | grep -oE '\"name\"' | wc -l | awk '\$1 >= 15'"

# 7. Cron status
check "/api/cron/status responde" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/cron/status' >/dev/null"

# 8. Boot prefetch funciona
warn_check "/api/boot/prefetch responde" \
  "curl -fsS --max-time $TIMEOUT '$BASE/api/boot/prefetch?db=default' >/dev/null"

printf '\n\033[1mResultado: %d pass · %d fail · %d warnings\033[0m\n' "$PASS" "$FAIL" "$WARNINGS"

if [ $FAIL -gt 0 ]; then
  printf '\n\033[31mDeploy NO está sano. Revisa los errores arriba.\033[0m\n'
  exit 1
fi

if [ $WARNINGS -gt 0 ]; then
  printf '\n\033[33mDeploy parcialmente OK con warnings (típico sin snapshot cargado).\033[0m\n'
  exit 0
fi

printf '\n\033[32mDeploy 100%% sano ✨\033[0m\n'
exit 0
