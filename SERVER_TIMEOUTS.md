# Timeouts Firebird / API (mar 2026)

## Problema

El helper `query()` usaba **12s por defecto**. En producción casi **todas** las rutas (`/api/cxc/*`, `/api/inv/*`, ventas con `ventasSub()`, etc.) hacían consultas pesadas → **timeout** → `catch(() => [])` → el front veía **listas vacías** en casi todas las pestañas.

## Solución

- **`FB_QUERY_DEFAULT_MS`** en `server_corregido.js`: por defecto **60000** (1 min), configurable en `.env`:

  ```env
  FB_QUERY_DEFAULT_MS=60000
  ```

- **Front** (`public/index.html`, `public/ventas.html`): `fwt` pasa a **60s por defecto** (antes 10s en inicio y 45s en ventas).

## Despliegue

Tras `git pull`, reiniciar Node/pm2. Opcional: añadir `FB_QUERY_DEFAULT_MS=60000` al `.env` del servidor para documentar.
