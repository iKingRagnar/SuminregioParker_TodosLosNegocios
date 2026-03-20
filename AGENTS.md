# Handoff — Suminregio / Microsip API (Beto)

Resumen para retomar el proyecto sin depender del chat anterior.

## Qué es

- API **Node + Express** (`server_corregido.js`) + **Firebird** (`node-firebird`).
- Frontend estático en `public/*.html`.
- **Multi-empresa:** varias bases `.fdb` vía `FB_DATABASES_JSON` (mismo host Firebird; rutas de archivo en el servidor).

## Rutas útiles

| Área | Ruta / archivo |
|------|----------------|
| Servidor | `server_corregido.js` |
| Variables | `.env` (usar `.env.example` como plantilla; **no** commitear secretos) |
| Público | `public/` |
| Comparativo multi-FDB | `GET /api/universe/scorecard`, `GET /api/universe/databases` |
| P&L por empresa / consolidado | `GET /api/resultados/pnl?db=id`, `GET /api/resultados/pnl-universe` |
| Resultados HTML | `public/resultados.html` — chips Grupo vs cada negocio, scorecard tabla, `?db=__ALL__` o `?db=id` |
| Asistente IA | `GET /api/ai/welcome`, `POST /api/ai/chat` — requiere `OPENAI_API_KEY`; el widget se inyecta desde `nav.js` (`public/ai-widget.css`, `public/ai-assistant.js`). Con `?db=id` en la URL, el chat usa esa empresa del registro `FB_DATABASES_JSON`. |

## No saturar el servidor transaccional

- Por defecto el scorecard universo usa **concurrencia 2** (`?concurrency=2`) y timeout por query (`?queryMs=10000`).
- En Firebird crea un **usuario solo lectura** y úsalo en `FB_USER` / `FB_PASSWORD` en producción.
- Evita abrir docenas de pestañas refrescando dashboards; el front hace polling cada 60s en `index.html` — ajústalo si hace falta.

## GitHub + Render (flujo resumido)

1. Repo raíz `microsip-api` → `.\scripts\export-suminregio-deploy.ps1` → carpeta `suminregio-microsip-deploy\` lista para Git.
2. GitHub: nuevo repo; `git push` del contenido de esa carpeta (sin `Cerebro Cursor` ni PBIX).
3. Render: **New +** → **Web Service** → elegir el repo → ver checklist abajo.
4. Cada cambio: `git push` a la rama enlazada (ej. `main`) → Render redeploy automático.

**Guía larga** (Render pantalla por pantalla, tabla de variables, Windows CMD, Firebird): `DEPLOY-RENDER.md` (en el bundle) o `scripts/DEPLOY-RENDER.md` en el monorepo.

**Deploy automático PC → GitHub → servidor:** `GITHUB-RUNNER-WINDOWS-PASO-A-PASO.md` (guía detallada), `GITHUB-RUNNER-WINDOWS.md` (resumen), y `.github/workflows/deploy.yml`.

## Render — qué poner en la página (checklist)

En [dashboard.render.com](https://dashboard.render.com), con el repo ya en GitHub:

1. **New +** → **Web Service** → seleccionar el repositorio del API.
2. **Root Directory:** vacío (el `package.json` está en la raíz del bundle).
3. **Runtime:** Node · **Build Command:** `npm install` · **Start Command:** `npm start`.
4. **Environment** (mismo asistente o pestaña lateral del servicio ya creado):
   - Añadir cada variable con **Add environment variable** (Key = nombre, Value = valor).
   - Contraseñas y `OPENAI_API_KEY`: usar opción **Secret** si está disponible.
   - Mínimo Firebird: `FB_HOST`, `FB_PORT`, `FB_USER`, `FB_PASSWORD`, y `FB_DATABASE` **o** `FB_DATABASES_JSON` (JSON en una línea).
   - Opcional: `CORS_ORIGIN`, `EMPRESA_NOMBRE`, `READ_ONLY_MODE`, `OPENAI_API_KEY`, `OPENAI_API_BASE`, `OPENAI_MODEL`.
   - **No** definas `PORT`: Render la inyecta sola.
5. **Save Changes** y esperar a que el servicio termine de reiniciar / desplegar.
6. Probar: `https://TU-NOMBRE.onrender.com/api/ping` y abrir `.../index.html` o `.../resultados.html` (sin prefijo `/public/`).

**Red:** desde Render, `FB_HOST` debe ser una IP o hostname donde Firebird **sí** escuche desde internet (o VPN/túnel); `127.0.0.1` en Render no es tu PC de la oficina.

7. **Logs** (menú del servicio): si algo falla, el error de Node/Firebird aparece ahí.

## Cotizaciones (DOCTOS_VE)

- Un solo criterio en servidor: `sqlWhereCotizacionActiva` → `TIPO_DOCTO IN ('C','O')` y no canceladas (`ESTATUS <> 'C'`).
- Listado `GET /api/ventas/cotizaciones` usa `FIRST n` (máx. 500) e incluye nombre de vendedor (`LEFT JOIN VENDEDORES`).
- `GET /api/ventas/cotizaciones/resumen` siempre devuelve números normalizados (`HOY`, `MES_ACTUAL`, `COTIZACIONES_*`).

## Modo solo lectura

- `READ_ONLY_MODE=1` → `POST /api/email/enviar` responde 403.

## Seguridad

- Nunca commitear contraseñas. Rotar credenciales si se filtraron.
- Limitar quién puede llamar a la API si está expuesta en internet (VPN, IP allowlist, o auth delante).
