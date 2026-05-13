# Asistente WhatsApp con Twilio

El backend expone `/api/wa/webhook` que recibe mensajes entrantes de WhatsApp vía Twilio y responde usando el AI v3 (Opus 4.7 + 25 tools).

## Arquitectura

```
Vendedor envía
"¿Cuánto vendimos hoy?" ──▶ Twilio ──▶ POST /api/wa/webhook
                                            │
                                            ├─ validateTwilioSignature(HMAC)
                                            │
                                            ├─ handleCommand (/ventas, /mes, /churn…)
                                            │
                                            └─ AI v3 ──▶ Tool calls ──▶ Dashboard endpoints
                                                            │
                                            ◀── TwiML <Message>respuesta</Message>
```

## Pasos para activar

### 1. Crear cuenta Twilio + sandbox WhatsApp

1. Cuenta en [Twilio Console](https://console.twilio.com/)
2. **Messaging → Try it out → Send a WhatsApp message**
3. Sigue las instrucciones para conectar tu número al sandbox (escanear QR + enviar mensaje tipo `join bright-cloud`)
4. Copia tu **Account SID** y **Auth Token** del dashboard

### 2. Configurar variables de entorno (Render)

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxx
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886  # sandbox por default
ANTHROPIC_API_KEY=sk-ant-...               # para que el AI v3 funcione
AI_MODEL_V3=claude-opus-4-7                # o claude-haiku-4-5 para fast/barato
WA_DEFAULT_DB=default                      # qué empresa consulta el AI por default

# Opcionales:
WA_VENDEDORES_JSON='{"+5218112345678":"VENDEDOR_X"}'  # mapeo teléfono → ID
ALERT_WA_TO=whatsapp:+5218111111111         # destinatario alertas automáticas
WA_SKIP_SIGNATURE=0                         # NO poner a 1 en prod (1 = sin validación HMAC)
```

### 3. Configurar el webhook en Twilio

1. En Twilio Console → **Messaging → Settings → WhatsApp Sandbox**
2. Campo **When a message comes in**:
   - URL: `https://TU-DOMINIO.onrender.com/api/wa/webhook`
   - Method: `POST`
3. Guarda.

### 4. Verificar

Envía un mensaje desde tu WhatsApp al número del sandbox. Comandos rápidos:

| Mensaje | Respuesta |
|---|---|
| `/help` | Lista de comandos |
| `/ventas` | Ventas de hoy |
| `/mes` | Ventas del mes |
| `/cxc` | Total CxC |
| `/top` | Top vendedores |
| `/churn` | Top 5 clientes en riesgo |
| `/compras` | Top 10 compras urgentes |
| `/reset` | Reinicia memoria de la sesión |
| `¿Cómo va el mes?` | Pregunta libre → IA con tools |

## Seguridad

### Validación de firma HMAC (default ON)

Twilio firma cada POST con HMAC-SHA1 usando tu Auth Token. El webhook verifica:

1. `X-Twilio-Signature` está presente
2. Recalculamos el hash con tu token y comparamos `timingSafeEqual`
3. Si no coincide, devolvemos `403 Acceso denegado`

**Esto evita que cualquier persona pueda hacer POST a tu webhook** y consumir cuota de Anthropic.

> ⚠️ NO uses `WA_SKIP_SIGNATURE=1` en producción. Solo para tests locales sin Twilio.

### Rate limit

Cada sesión (por número de WhatsApp) tiene rate limit de 15 req/min (compartido con AI v3 global). Si se excede, devuelve 429 con `Retry-After`.

### Costos

- Twilio sandbox: gratis
- Twilio producción (número propio): ~$0.005 USD por mensaje
- Anthropic Opus 4.7 con prompt caching: ~$0.001-0.005 por consulta tras cache warm-up
- Estimado para un vendedor con 30 consultas/día: **~$0.30/día = ~$10/mes**

Revisa `/api/ai/chat-v3/stats` para ver tokens y costo acumulado en tiempo real.

## Producción (número propio, no sandbox)

1. Twilio Console → **Messaging → Senders → WhatsApp Senders**
2. Solicita activación del número propio (requiere aprobación de Meta — toma 1-7 días)
3. Una vez aprobado, actualiza `TWILIO_WHATSAPP_FROM=whatsapp:+TU_NUMERO`

## Troubleshooting

### "AI sin respuesta: 503"

`ANTHROPIC_API_KEY` no está configurada. Define en Render env vars y redeploy.

### "Acceso denegado" 403

Significa que la firma HMAC no coincidió. Causas comunes:

- `TWILIO_AUTH_TOKEN` mal configurado en Render
- Estás llamando al webhook directamente sin Twilio (usar `/api/wa/test` para ese caso)
- Hay un proxy/CDN entre Twilio y tu server que cambia el path

### El webhook tarda >15s

Twilio espera respuesta TwiML en máximo 15 segundos. El AI v3 con tool calls puede tomar 5-20s. Mitigación:

- Pre-warm el cache de prompts (envía `/help` al arrancar)
- Para consultas pesadas, considera responder un primer mensaje "procesando…" y mandar el resultado luego via `/api/notify/whatsapp`

### Los comandos `/ventas` funcionan pero las preguntas libres no

El AI v3 requiere `ANTHROPIC_API_KEY`. Los comandos directos consultan DuckDB sin pasar por la IA, por eso funcionan sin la key.

## Endpoints relacionados

- `POST /api/wa/webhook` — recibe mensajes de Twilio (firma validada)
- `POST /api/wa/test` — simula un mensaje sin Twilio (debug local)
- `POST /api/notify/whatsapp` — envía mensaje outbound (alertas)
- `GET /api/ai/chat-v3/sessions` — lista sesiones activas (incluye prefijo `wa-`)
- `GET /api/ai/chat-v3/stats` — métricas de uso AI

## Ejemplo de costo real (referencia)

Después de 1 día con 1 vendedor activo:

```bash
curl https://tu-dominio.com/api/ai/chat-v3/stats | jq
```

```json
{
  "requests": 47,
  "tool_calls": 38,
  "errors": 0,
  "tokens": {
    "input": 12000,
    "output": 4500,
    "cache_read": 95000,
    "cache_creation": 8000
  },
  "cache_hit_rate_pct": 80.5,
  "cost_usd_estimated": 0.21
}
```

El **80.5% cache hit rate** es lo que hace al sistema económico — el prompt caching reduce ~90% del costo de input tokens.
