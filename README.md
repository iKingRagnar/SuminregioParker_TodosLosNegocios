# Suminregio API · Dashboard Ejecutivo

Plataforma integral de BI para Suminregio Parker y su grupo de empresas. Ingesta nocturna desde **Microsip (Firebird)** vía **DuckDB snapshots**, frontend light-mode premium con ~17 módulos de dashboard, 45+ endpoints REST, servicios de colaboración, AI y notificaciones.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│  Tu servidor Windows (oficina)                              │
│  ┌──────────────┐      ┌───────────────────┐                │
│  │ Microsip FDB │◄─────│ sync_duckdb.py    │                │
│  │ (Firebird)   │      │ (cron nocturno)   │                │
│  └──────────────┘      └────────┬──────────┘                │
│                                 │ gzipped .duckdb           │
└─────────────────────────────────┼───────────────────────────┘
                                  │ HTTPS
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│  Render (Starter plan + disco persistente opcional)         │
│  ┌──────────────────────────────────────────────────┐       │
│  │ server_corregido.js (Express, Node 20)           │       │
│  │                                                  │       │
│  │  /api/admin/snapshot/upload  →  DUCK_SNAPSHOT_DIR│       │
│  │                                                  │       │
│  │  DUCK_ONLY_MODE=1  →  0 conexiones Firebird      │       │
│  │                                                  │       │
│  │  Módulos instalados:                             │       │
│  │  · performance-boost  (ETag, Brotli, keep-alive) │       │
│  │  · ai-tools           (NL→SQL + forecasting)     │       │
│  │  · ai-chat-v2         (Anthropic + memoria)      │       │
│  │  · analytics-deep     (RFM, Pareto, CLV)         │       │
│  │  · business-intel     (pipeline, cashflow, etc.) │       │
│  │  · notifications      (WhatsApp, Slack, Push)    │       │
│  │  · collaboration      (notas, tareas, audit)     │       │
│  │  · observability      (métricas p50/p95/p99)     │       │
│  │  · security-hardening (2FA TOTP)                 │       │
│  │  · email-reports      (cron diario)              │       │
│  │  · integrations       (Power BI, Sheets, Zapier) │       │
│  │  · safe-catch         (ring buffer de errores)   │       │
│  └──────────────────────────────────────────────────┘       │
│  Persistencia: disk mount en /var/data/duck_snaps           │
└─────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ HTTPS + Service Worker
                                  │
                      ┌───────────┴────────────┐
                      │ Frontend (PWA)         │
                      │  · 17 dashboards HTML  │
                      │  · Light mode forzado  │
                      │  · Offline-first (SW)  │
                      │  · Cmd+K search        │
                      │  · F10 presentación    │
                      └────────────────────────┘
```

---

## Stack

- **Backend**: Node.js 20, Express 4, DuckDB embedded, node-firebird (fallback), Anthropic SDK, Twilio, Nodemailer, web-push
- **Frontend**: Vanilla JS + CSS (zero framework), Chart.js, Service Worker, Web Push API
- **Data**: Firebird (source of truth) → DuckDB (snapshot serving) → cliente
- **Deploy**: Render.com (Starter o superior con disco persistente)

---

## Setup local

```bash
git clone https://github.com/iKingRagnar/SuminregioParker_TodosLosNegocios
cd SuminregioParker_TodosLosNegocios
npm install

# Modo desarrollo (sin Firebird, snapshots de disco)
DUCK_ONLY_MODE=1 npm start

# Abrir http://localhost:7000/index.html
```

---

## Variables de entorno

### Esenciales
| Var | Default | Notas |
|---|---|---|
| `PORT` | `7000` | Render lo setea automático |
| `DUCK_ONLY_MODE` | `1` | `0` para permitir fallback Firebird |
| `DUCK_SNAPSHOT_DIR` | `/tmp/duck_snaps` | **IMPORTANTE**: usa `/var/data/duck_snaps` en Render con disco persistente |
| `SNAPSHOT_TOKEN` | `suminregio-snap-2026` | Cambialo en prod |
| `EMPRESA_NOMBRE` | `SUMINREGIO PARKER` | Para display |

### Firebird (solo si `DUCK_ONLY_MODE=0`)
| Var | Notas |
|---|---|
| `FB_HOST`, `FB_PORT`, `FB_DATABASE`, `FB_USER`, `FB_PASSWORD` | Default FDB |
| `FB_DATABASES_JSON` | Array JSON con múltiples BDs |
| `fb-databases.registry.json` | Archivo versionado con todas las BDs |

### Performance
| Var | Default | Notas |
|---|---|---|
| `RENDER_EXTERNAL_URL` | — | Activa keep-alive self-ping |
| `SNAPSHOT_HISTORY_DAYS` | `7` | Retención de histórico |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

### AI
| Var | Notas |
|---|---|
| `ANTHROPIC_API_KEY` | Para `/api/ai/chat-v2` |
| `AI_MODEL` | Default `claude-haiku-4-5-20251001` |
| `AI_RATE_MAX` | Default 10 req/min |

### Notificaciones
| Var | Notas |
|---|---|
| `TWILIO_SID` / `TWILIO_TOKEN` | WhatsApp + SMS |
| `TWILIO_WHATSAPP_FROM` | Ej: `whatsapp:+14155238886` (sandbox) |
| `SLACK_WEBHOOK_URL` | Incoming webhook |
| `VAPID_PUBLIC` / `VAPID_PRIVATE` | Generar con `npx web-push generate-vapid-keys` |
| `ALERT_WEBHOOK_URL` | Alertas automáticas |

### Email reports
| Var | Notas |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP server |
| `SMTP_FROM` | Remitente display |
| `REPORT_TO` | Destinatarios separados por coma |
| `REPORT_HOUR` | Hora de envío (0-23, default 7) |
| `REPORT_DBS` | Bases a reportar (default `default`) |

### Seguridad
| Var | Notas |
|---|---|
| `TOTP_SECRET` | Generar con `GET /api/sec/2fa/setup` |
| `REQUIRE_2FA_ADMIN` | `1` para exigir 2FA en writes admin |
| `CORS_ORIGIN` | Default `*`, restringir en prod |

### Integraciones
| Var | Notas |
|---|---|
| `POWERBI_REFRESH_WEBHOOK` | URL del webhook de Power BI |
| `ZAPIER_WEBHOOK_URL` | Relay genérico |

### Observabilidad
| Var | Default | Notas |
|---|---|---|
| `FRESHNESS_WARN_H` | `30` | Snapshot viejo = warn |
| `FRESHNESS_ALERT_H` | `48` | Snapshot viejo = alert |

---

## Endpoints principales (~45)

Para ver todos con playground interactivo: **[/docs.html](/docs.html)** (Swagger UI).

### Por categoría

**Health & Admin**
- `GET /health`, `GET /healthz` (profundo), `GET /api/ping`
- `GET /api/admin/mode`, `/api/admin/sync/status`, `/api/admin/errors`
- `POST /api/admin/snapshot/upload` (con validación)
- `GET /api/cache/stats`, `DELETE /api/cache/flush`

**Dashboard (consumen DuckDB)**
- `GET /api/ventas/*` (resumen, diarias, semanales, por-vendedor, cobradas, margen, etc.)
- `GET /api/cxc/*` (resumen-aging, vencidas, vigentes, top-deudores, historial)
- `GET /api/inv/*` (resumen, bajo-minimo, consumo-semanal, sin-movimiento)
- `GET /api/resultados/pnl`, `/api/resultados/balance-general`
- `GET /api/director/*` (resumen, top-clientes, vendedores)
- `GET /api/universe/scorecard` (multi-empresa)

**Analytics avanzado**
- `GET /api/analytics/rfm` — segmentación Champions/Leales/EnRiesgo/Perdidos
- `GET /api/analytics/pareto?dim=cliente|articulo`
- `GET /api/analytics/clv`
- `GET /api/compare/temporal?metrics=ventas_mes,cxc_total`
- `GET /api/search/global?q=...`
- `GET /api/anomalies/check`

**Business Intelligence**
- `GET /api/bi/pipeline-cotizaciones` (funnel)
- `GET /api/bi/cashflow?dias=60`
- `GET /api/bi/comisiones?mes=YYYY-MM&pct=2.5`
- `GET /api/bi/margen-productos?min=15`
- `GET /api/bi/rotacion-categorias`
- `POST /api/bi/conciliacion-bancaria`

**Forecasting**
- `GET /api/forecast/ventas?dias=30`
- `GET /api/forecast/inventario`

**AI**
- `POST /api/ai/ask` (NL→SQL determinístico)
- `POST /api/ai/chat-v2` (Anthropic con memoria)
- `GET /api/ai/sessions`

**Colaboración**
- `GET/POST/DELETE /api/collab/notes`
- `GET/POST/PATCH /api/collab/tasks`
- `GET/POST/PATCH /api/collab/approvals`
- `GET /api/collab/audit`

**Notificaciones**
- `POST /api/notify/{whatsapp,sms,slack,push/send}`
- `POST /api/slack/command`

**Reportes**
- `GET /api/reports/preview?db=...`
- `POST /api/reports/send`

**Observabilidad**
- `GET /api/metrics`, `/api/metrics/slow`, `/api/metrics/freshness`

**Seguridad**
- `GET /api/sec/2fa/setup`
- `POST /api/sec/2fa/verify`

**Integraciones**
- `POST /api/integrations/powerbi/refresh`
- `GET /api/integrations/sheets/export?tab=...`

---

## Frontend

### Dashboards (17 páginas)

`index.html`, `ventas.html`, `cxc.html`, `inventario.html`, `resultados.html`, `consumos.html`, `vendedores.html`, `clientes.html`, `cobradas.html`, `director.html`, `margen-producto.html`, `capital.html`, `suministros-medicos.html`, `comparar.html`, `admin.html`, `docs.html`, `director.html`.

### Atajos de teclado (pulsa `?` para ver)

| Atajo | Acción |
|---|---|
| `⌘K` / `Ctrl+K` / `/` | Búsqueda global |
| `g v` | Ventas |
| `g c` | CxC |
| `g i` | Inventario |
| `g r` | Resultados |
| `g p` | Comparar empresas |
| `r` | Refresh datos |
| `F10` | Modo presentación (kiosko) |
| `?` | Ayuda |

### Capas visuales

- `visual-polish.css` — sistema de diseño base
- `module-polish.css` — defensivo para todos los módulos
- `cxc-redesign.css` — override completo CxC
- `mobile-enhance.css` — touch targets, safe-area, móvil nativo
- `aurora-background.js` — fondo parallax interactivo

---

## Deploy en Render

### Primera vez
1. Conecta GitHub en Render → New Web Service → selecciona este repo
2. Build: `npm install` · Start: `npm start`
3. **Disco persistente** (opcional pero recomendado):
   - Settings → Disks → Add Disk
   - Mount path: `/var/data/duck_snaps`
   - Size: 1 GB
   - Env var: `DUCK_SNAPSHOT_DIR=/var/data/duck_snaps`
4. Setea variables de entorno mínimas (ver sección arriba)

### Cada deploy
`git push origin main` → Render redeploy automático.

### Despues de un redeploy (si NO hay disco persistente)
Los snapshots se pierden. Corre:
```powershell
python "C:\Microsip datos\sync_duckdb.py"
```

---

## Servidor Windows (origen de datos)

El archivo [`sync_duckdb.py`](sync_duckdb.py) lee Firebird con `fdb`, genera DuckDB snapshots por empresa, comprime con gzip, y hace POST a Render. Programa con Windows Task Scheduler (ej. 3am diario).

---

## Tests

```bash
npm test
```

Los tests (`node --test`) arrancan el server en port alternativo y validan 6 endpoints críticos. CI corre automático en cada PR via `.github/workflows/ci.yml`.

---

## Troubleshooting

### Dashboard muestra ceros
`snapshotsLoaded: 0` en `/api/admin/mode`. Corre `sync_duckdb.py` o sube snapshot manual.

### Cold start de 30s
Plan Render free duerme tras 15min inactividad. Soluciones:
- Upgrade a Starter ($7/mes)
- Setea `RENDER_EXTERNAL_URL` → keep-alive self-ping cada 10 min

### Snapshot corrupto
Upload devuelve 422 automático, snapshot anterior sigue vivo. No hay data loss.

### CXC con valores raros
Revisa `MICROSIP_CXC_*` env vars y `/api/debug/cxc`.

---

## Contacto / Soporte

Proyecto de Guillermo Ragnar · [@iKingRagnar](https://github.com/iKingRagnar) · guillermorc44@gmail.com

Issues y PRs: [GitHub Issues](https://github.com/iKingRagnar/SuminregioParker_TodosLosNegocios/issues)
