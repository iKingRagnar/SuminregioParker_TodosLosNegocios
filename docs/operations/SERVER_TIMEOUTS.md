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

## Selector multi-base (`?db=`)

Los chips del SCORECARD envían `?db=<id>`. En el servidor, **`getReqDbOpts`** solo acepta `id` que exista en `DATABASE_REGISTRY` (misma lista que `/api/universe/databases`). Si el id **no coincide** (URL vieja, typo, registro distinto en otro PC), Node **ignora** el parámetro y usa **`FB_DATABASE`** → puedes ver **todo en $0** aunque el chip muestre otra empresa.

- Comprobar: `GET /api/config/db-check?db=TU_ID`
- Consola del servidor: línea `[Firebird] bases registradas (N): id ← archivo.fdb`

El `index.html` ahora **limpia** `?db=` y `sessionStorage` si el id ya no está en la lista devuelta por el API.
