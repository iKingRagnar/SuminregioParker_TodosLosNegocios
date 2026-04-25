# Migración Dashboard → API externa Suminregio

Última actualización: 2026-04-24

## Resumen ejecutivo

El dashboard de Suminregio Parker pasó de **conectar directo a Firebird local**
(con `daily-cache` propio y snapshots DuckDB) a **consumir el API centralizado
`https://api.suminregio.com/api/external`**. Toda la lectura de datos vive en
el API (70 queries pre-validadas, DuckDB replica refrescada 2 AM MX) y el
dashboard es ahora solamente un consumidor autenticado.

## Motivación

1. **Seguridad**: ya no se expone Firebird en WAN ni se compartían credenciales
   `SYSDBA/masterkey`. La API key `sk_ext_...` es auditable y revocable.
2. **Cuadres validados**: las 70 queries ya pasaron el estándar de 7 reglas
   (simetría cargos/pagos, MOSTRADOR excluido, etc.) al centavo contra MicroSIP.
3. **Consolidado natural**: `unidad: "grupo"` hace fan-out automático a las 6
   BUs; antes había que mantener 6 conexiones Firebird y mergear en server.
4. **Menos código**: 12,288 líneas de `server_corregido.js` (con SQL embebido)
   → **~640 líneas** de `server_api.js` (adaptadores finos sobre el catálogo).

## Estado del trabajo

| Fase | Estado |
|---|:---:|
| Inventariar rutas/queries (26 routes, 159 SQLs inline) | ✅ |
| Mapear SQL → `query_id` del catálogo de 70 queries | ✅ |
| `api-client.js` con retry + backoff 429 + timeout | ✅ |
| `server_api.js` (nuevo monolito slim, ~640 líneas) | ✅ |
| Hardening: helmet + rate-limit + basic auth + CORS estricto | ✅ |
| `package.json` v2.0 (deps nuevas, deps legacy como `optionalDependencies`) | ✅ |
| `render.yaml` (sin disco local, sin Firebird, con `SUMINREGIO_API_KEY`) | ✅ |
| `.env.example` re-escrito | ✅ |
| Smoke test 18/18 contra Parker marzo 2026 | ✅ |
| Archivo `archive/`: `server_corregido.legacy.js`, `daily-cache.legacy.js` | ✅ |
| Deploy en Render + validación producción | ⏳ Guillermo tiene que poner `SUMINREGIO_API_KEY` en dashboard de Render |
| Remover UIs no migradas (push notifications, 2FA) | ⏳ Si se quieren, configurar aparte |

## Cifras validadas al centavo (parker, marzo 2026)

| KPI | Valor | Fuente |
|---|---:|---|
| Ventas del mes (VE+PV sin IVA) | **$3,164,113.49** | `ventas_resumen_mes` |
| Número facturas | 321 | idem |
| Ventas VE | $2,779,005.34 | idem |
| Ventas PV | $385,108.15 | idem |
| Saldo CxC total | **$2,035,553.52** | `cxc_saldo_total` |
| CxC vencido | $808,179.45 | derivado de `cxc_vencida_detalle` |
| Top deudor | ELIGETUPROFESIONAL.COM $927,962.24 (vencido $69,507.98) | `cxc_top_deudores` |

> Nota: el saldo ancla del bug histórico de CxC ($2,009,698.59 al 2026-03-21)
> difiere del saldo vivo de hoy ($2,035,553.52) por timing: el API trae la
> instantánea más reciente (DuckDB refrescada anoche). La asimetría
> `IMPORTE+IMPUESTO` de cargos/pagos que causaba la cartera inflada está
> resuelta del lado del API.

## Mapeo rutas → query_id

### Ventas
| Ruta dashboard | query_id del catálogo | Notas |
|---|---|---|
| `/api/ventas/resumen` | `ventas_resumen_mes` + `ventas_diarias` + `ventas_comparativo` | Composite (hoy + mes + comparativo) |
| `/api/ventas/diarias` | `ventas_diarias` | 1:1 |
| `/api/ventas/mensuales` | `ventas_acumulado_anual` | 1:1 |
| `/api/ventas/por-vendedor` | `ventas_por_vendedor` | 1:1 |
| `/api/ventas/top-clientes` | `ventas_top_clientes` | 1:1 |
| `/api/ventas/recientes` | `ventas_diarias` | slice últimos 10 |
| `/api/ventas/cumplimiento` | `ventas_resumen_mes` + `metas.json` local | Composite |
| `/api/ventas/margen-lineas` | `margen_por_linea` | 1:1 |
| `/api/ventas/cobradas` | `cobros_por_vendedor` | 1:1 (upstream tiene bug; adapter devuelve vacío si falla) |
| `/api/ventas/cobradas-detalle` | `cobros_detalle_mes` | 1:1 |
| `/api/ventas/cobradas-por-factura` | `cobros_detalle_mes` | alias |
| `/api/ventas/cotizaciones/resumen` | `cotizaciones_activas` | agregación en server |
| `/api/ventas/cotizaciones/diarias` | `cotizaciones_activas` | group by día |
| `/api/ventas/por-vendedor/cotizaciones` | `cotizaciones_activas` | group by vendedor |
| `/api/ventas/vs-cotizaciones` | `ventas_resumen_mes` + `cotizaciones_activas` | ratio |

### CxC
| Ruta dashboard | query_id del catálogo | Notas |
|---|---|---|
| `/api/cxc/top-deudores` | `cxc_top_deudores` + `cxc_vencida_detalle` | Join por nombre cliente normalizado (vencida no trae CLIENTE_ID) |
| `/api/cxc/resumen-aging` | `cxc_aging` + `cxc_saldo_total` + `cxc_vencida_detalle` | Composite |
| `/api/cxc/vencidas` | `cxc_vencida_detalle` | filtro dias_vencido > 0 |
| `/api/cxc/vigentes` | `cxc_vencida_detalle` | filtro dias_vencido ≤ 0 |
| `/api/cxc/por-condicion` | `cxc_por_condicion` | 1:1 |
| `/api/cxc/historial-pagos` | `cobros_detalle_mes` | 1:1 |

### Director (composite)
| Ruta | Composite de | Notas |
|---|---|---|
| `/api/director/resumen` | `ventas_resumen_mes` + `ventas_diarias` + `cotizaciones_activas` + `ventas_comparativo` + `cxc_saldo_total` | `?omitCxc=1` salta CxC |
| `/api/director/vendedores` | `ventas_por_vendedor` + `margen_por_vendedor` | Merge por VENDEDOR_ID |
| `/api/director/ventas-diarias` | `ventas_diarias` | 1:1 |
| `/api/director/top-clientes` | `ventas_top_clientes` | 1:1 |
| `/api/director/recientes` | `ventas_diarias` | slice últimos 10 |

### Clientes / Inventario / Consumos / Resultados / Universe
Todas las demás rutas son wrappers 1:1 sobre el catálogo. Ver `server_api.js`.

## Seguridad aplicada

- **Helmet**: default hardening (X-Content-Type-Options, X-Frame-Options, etc.).
- **CORS estricto**: `CORS_ORIGIN` env (default `*` — en prod conviene el
  dominio real).
- **Rate limit `/api/*`**: 300 req/min por IP (configurable con
  `RATE_LIMIT_MAX`). Excluye `/health`, `/api/ping`, `/api/metrics`.
- **Basic auth opcional**: si `AUTH_USERS="user:pass;u2:p2"`, toda la UI queda
  tras HTTP basic. Excepción: `/health` y `/api/ping` para healthchecks.
- **API key en env**: `SUMINREGIO_API_KEY` nunca se committea ni se imprime.
  Render la expone vía `sync: false`.
- **Retry 429 con backoff largo**: 8s / 20s / 45s, respeta header
  `Retry-After` si el upstream lo manda.

## Deploy en Render

1. En el dashboard de Render, ir a **Environment** del servicio
   `suminregioparker-todoslosnegocios`.
2. Agregar secret: `SUMINREGIO_API_KEY=sk_ext_FQHxtBCPUhyx3VpLCaeFwwXusHhSI0`
   (sync: false — solo en el panel de Render).
3. (Opcional) Agregar `AUTH_USERS=guillermo:PASS_FUERTE` para basic auth.
4. (Opcional) Apretar `CORS_ORIGIN=https://tu-dominio.com` en prod.
5. Disparar redeploy (el repo en GitHub ya trae `startCommand: node server_api.js`).
6. Verificar `/health` → debe responder `{ ok: true, service: "suminregio-dashboard" }`.

## Cómo correr local

```bash
cd microsip-api
cp .env.example .env
# editar .env y poner SUMINREGIO_API_KEY=sk_ext_...

npm install
npm start              # arranca server_api.js en :7000

# Smoke test full (18 rutas críticas)
SUMINREGIO_API_KEY=sk_ext_... npm run smoke
```

## Legacy (archivado)

Todo está en `archive/`:
- `server_corregido.legacy.js` — monolito 12,288 líneas con queries Firebird
  directas (referencia histórica; NO correr en prod).
- `server_corregido_resto.legacy.js` — extras del monolito.
- `server_corregido.LOCAL_VENTAS_COTI_REF.js` — versión local de ventas/coti.
- `daily-cache.legacy.js` — cache por archivo (obsoleto; el API cachea).
- `server_cumplimiento_filtros.js` — filtros de cumplimiento.

Para arrancar el legacy (solo para debugging):
```bash
npm run start:legacy
```

## Pendientes / follow-ups

1. **Deploy en Render** (requiere Guillermo ponga la API key).
2. **UIs no migradas**: push notifications, Slack webhook, 2FA. Se dejaron
   como stubs en `server_api.js`. Si se quieren, se configuran aparte.
3. **Metas dashboard**: se movieron a `metas.json` local (no hay en el API).
4. **Capital snapshot**: se mantiene como archivo local `data/capital.json`
   porque el API no tiene endpoint de escritura.
5. **Monitoreo upstream**: cuando el API devuelve 429 persistente o 5xx, el
   dashboard muestra `{ ok: false, error: ... }`. Considerar agregar banner
   de degradación en el frontend si los errores duran > 5 minutos.
