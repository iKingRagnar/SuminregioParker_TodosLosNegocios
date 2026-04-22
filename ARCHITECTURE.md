# Arquitectura

## Estado actual

```
microsip-api/
├── server_corregido.js          ← MONOLITO (~12K LOC) — core de endpoints dashboard
├── performance-boost.js         ← ETag, Brotli, keep-alive, health, prefetch
├── ai-tools.js                  ← NL→SQL + forecasting
├── ai-chat-v2.js                ← Anthropic con memoria
├── analytics-deep.js            ← RFM, Pareto, CLV, temporal, search
├── business-intel.js            ← Pipeline, cashflow, comisiones, margen, rotación
├── notifications.js             ← WhatsApp, SMS, Slack, Push
├── collaboration.js             ← Notas, tareas, aprobaciones, audit
├── observability.js             ← Métricas p50/p95/p99, freshness
├── security-hardening.js        ← 2FA TOTP, rate-limit global
├── integrations.js              ← Power BI, Sheets, Zapier
├── email-reports.js             ← Reportes programados
├── safe-catch.js                ← Ring buffer errores
├── sumi-db.js                   ← Persistencia JSONL zero-deps
│
├── src/                          ← Estructura moderna (migración gradual)
│   ├── auth/
│   │   ├── index.js             ← Auth pluggable con 3 providers
│   │   ├── middleware.js        ← requireAuth, requireRole
│   │   └── providers/
│   │       ├── dummy.js         ← Dev mode (todos admin)
│   │       ├── basic.js         ← HTTP Basic Auth
│   │       └── clerk.js         ← Clerk (prod, cuando tengas claves)
│   ├── storage/
│   │   ├── parquet-export.js    ← DuckDB → Parquet con compresión ZSTD
│   │   └── s3-loader.js         ← DuckDB lee Parquet desde S3/R2 httpfs
│   └── routes/
│       └── ventas-example.js    ← Ejemplo extracción del monolito
│
├── tests/
│   └── smoke.test.js            ← 6 tests que cubren endpoints críticos
│
├── public/                       ← Frontend (17 HTML + 15 JS/CSS)
│   └── ...
│
├── ai-chat-v2.js · business-intel.js · ... (13 módulos backend)
├── openapi.yaml                 ← Spec de ~45 endpoints
├── .github/workflows/ci.yml     ← CI con tests + syntax check
└── README.md
```

---

## Por qué el monolito sigue vivo

`server_corregido.js` tiene **~12,000 líneas** con lógica crítica de ventas/cxc/inv/resultados. Migrar todo de un jalón rompería el dashboard en producción.

**Plan de migración gradual** (bajo riesgo, high-confidence):

### Fase 1 — Infrastructure (✅ hecho)
Módulos auxiliares ya están separados:
- `performance-boost`, `ai-tools`, `ai-chat-v2`, `analytics-deep`, `business-intel`, `notifications`, `collaboration`, `observability`, `security-hardening`, `integrations`, `email-reports`, `safe-catch`, `sumi-db`

### Fase 2 — Extracción por módulo (en progreso)
Orden recomendado (de menor a mayor riesgo):

1. **Config & Filtros** (`/api/config/*`) — ~200 LOC, sin lógica de datos
2. **Debug endpoints** (`/api/debug/*`) — sin tráfico real
3. **Director** (`/api/director/*`) — ~400 LOC, consume otros endpoints
4. **Ventas** (`/api/ventas/*`) — ~1500 LOC
5. **Cotizaciones** (`/api/ventas/cotizaciones/*`) — ~800 LOC con cursor especial
6. **Consumos** (`/api/consumos/*`) — ~500 LOC
7. **Inventario** (`/api/inv/*`) — ~1200 LOC
8. **CXC** (`/api/cxc/*`) — ~2500 LOC ⚠ más complejo
9. **Resultados** (`/api/resultados/*`) — ~1500 LOC
10. **Clientes** + resto

### Patrón de extracción

1. Crear `src/routes/<modulo>.js` exportando `install(app, deps)`.
2. Copiar el grupo de endpoints del monolito **sin eliminar aún del original**.
3. Registrar en `server_corregido.js` detrás de un flag:
   ```js
   if (process.env.USE_NEW_VENTAS === '1') {
     require('./src/routes/ventas').install(app, { query, getReqDbOpts, log });
   }
   ```
4. Deploy con flag off → verifica que nada rompe.
5. Activa flag en preview/staging, compara contra producción.
6. Cuando esté verde 48h, borra el bloque original del monolito.

Ejemplo funcional: [`src/routes/ventas-example.js`](src/routes/ventas-example.js) con `/api/ventas/resumen-v2`.

---

## Auth multi-usuario (pluggable)

```
AUTH_PROVIDER=dummy   ← default, sin auth (dev)
AUTH_PROVIDER=basic   ← HTTP Basic, ver AUTH_USERS
AUTH_PROVIDER=clerk   ← producción (necesita CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY)
```

### Modelo de roles
- `admin` → todo
- `director` → lectura + decisiones (aprobaciones)
- `vendedor` → solo su data (filtros auto)

### Cómo proteger endpoints
```js
const auth = require('./src/auth');
app.get('/api/admin/algo', auth.requireRole('admin'), handler);
app.get('/api/mi-cartera', auth.requireAuth, handler); // cualquier user
```

### Clerk setup
1. `npm i @clerk/backend`
2. Crear proyecto en https://clerk.com → Dashboard → API Keys
3. Env vars:
   ```
   AUTH_PROVIDER=clerk
   CLERK_SECRET_KEY=sk_live_...
   CLERK_PUBLISHABLE_KEY=pk_live_...
   ```
4. Frontend consulta `/api/auth/clerk/config` y carga el SDK de Clerk.

---

## Storage escalable (Parquet + S3/R2)

Cuando los snapshots `.duckdb` pesen > 500MB o tengas > 20 empresas, conviene migrar a Parquet remoto:

| Aspecto | DuckDB local | Parquet remoto |
|---|---|---|
| Tamaño | 100% | 15-40% (compresión ZSTD) |
| Persistencia Render | requiere disco | no requiere |
| Multi-instancia | no | sí (cada instancia lee del mismo S3) |
| Latencia primera query | <1ms | 50-200ms (red) |
| Queries subsecuentes | <1ms | <5ms (cache DuckDB) |

### Migrar
```bash
# 1. Exportar un snapshot existente a Parquet
node src/storage/parquet-export.js /tmp/duck_snaps/snapshot_default.duckdb ./parquet/default/

# 2. Subir a R2/S3 con rclone o aws-cli
aws s3 sync ./parquet/default/ s3://suminregio-snapshots/snapshots/default/

# 3. Activar modo S3
# Env:
#   STORAGE_MODE=s3
#   S3_BUCKET=suminregio-snapshots
#   S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com  (R2 only)
#   S3_KEY, S3_SECRET, S3_REGION
```

El loader (`src/storage/s3-loader.js`) crea VIEWs que apuntan a los Parquet remotos. El código de queries no cambia — sigue usando `FROM DOCTOS_VE`.

### Costos R2 (Cloudflare)
- Storage: $0.015/GB/mes
- Class A ops (writes): $4.50 / millón
- Class B ops (reads): $0.36 / millón
- **Egress: GRATIS** (ventaja clave vs AWS S3)

Para 2GB de snapshots + ~10k reads/día = **~$0.10/mes**.

---

## Orden sugerido para los siguientes sprints

1. **Sprint A (1 semana)**: auth real con Clerk + roles. Migrar `admin.html` y endpoints admin a `requireRole('admin')`.
2. **Sprint B (1 semana)**: migrar 2-3 módulos del monolito empezando por `config` y `debug`. Establecer el patrón.
3. **Sprint C (1 semana)**: export a Parquet + setup R2. Probar en preview antes de switch.
4. **Sprint D**: continuar extracción módulo por módulo.

Cada sprint debe terminar con los 6 smoke tests en verde + review manual de los dashboards que tocó.
