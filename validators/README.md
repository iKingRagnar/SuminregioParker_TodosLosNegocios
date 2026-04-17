# 🔍 Suminregio Parker — Agentes Validadores Pre-Deploy

Suite de validación automática que verifica integridad de datos, endpoints API, estructura HTML y coherencia numérica **antes de cada push a GitHub/producción**.

---

## Módulos disponibles

| Agente | Archivo | Qué valida |
|--------|---------|-----------|
| 💰 Ventas | `validate-ventas.js` | KPIs resumen, diarias, por vendedor, cotizaciones, coherencia resumen vs suma |
| 📋 Cotizaciones | `validate-cotizaciones.js` | #coti-section CSS, candado, endpoints, tasa conversión, coherencia |
| 📊 P&L | `validate-pnl.js` | Márgenes bruto/neto, ecuación contable, gastos como % de ventas |
| 💼 Comisiones | `validate-comisiones.js` | Tasa 8%, vendedores anómalos, cobros vinculados |
| 📦 Inventario | `validate-inventario.js` | % sin movimiento, artículos negativos, alertas stock crítico |
| 🔄 Consumo | `validate-consumo.js` | Movimientos de salida, ratio consumo/ventas, fechas recientes |
| 🏦 CxC | `validate-cxc.js` | Aging buckets, DSO, % vencido, clientes en riesgo |

---

## Uso

```bash
# Validar TODOS los módulos contra el servidor local
node validators/validate-all.js

# Contra servidor específico (ngrok, staging, etc.)
node validators/validate-all.js --base-url https://abc123.ngrok-free.app

# Solo módulos específicos
node validators/validate-all.js --only ventas,cxc

# Detener al primer fallo
node validators/validate-all.js --fail-fast

# Output JSON (para CI/CD)
node validators/validate-all.js --json > resultado.json

# Validar un módulo individualmente
node validators/validate-ventas.js
node validators/validate-cotizaciones.js
node validators/validate-pnl.js
```

---

## Integración en package.json

```json
{
  "scripts": {
    "validate": "node validators/validate-all.js",
    "validate:ci": "node validators/validate-all.js --json --fail-fast",
    "predeploy": "npm run validate"
  }
}
```

## Integración con push-github.bat

Agrega al principio del `.bat`:
```bat
echo Corriendo validadores...
node validators/validate-all.js
if %errorlevel% neq 0 (
    echo VALIDACION FALLIDA - push cancelado
    pause
    exit /b 1
)
echo Validacion OK, continuando push...
```

---

## Códigos de salida

- `0` — Todas las validaciones pasaron ✅
- `1` — Al menos una validación falló ❌
- `2` — Error fatal en el orquestador 💥

---

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `VALIDATOR_BASE_URL` | `http://localhost:3000` | URL base del servidor |
| `VALIDATOR_TIMEOUT_MS` | `12000` | Timeout por petición en ms |
