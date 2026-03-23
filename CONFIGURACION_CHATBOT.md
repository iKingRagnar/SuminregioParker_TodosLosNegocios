# Configuración del Asistente IA + Alertas Automáticas

## 1. Prerequisitos instalados

```
npm install @anthropic-ai/sdk nodemailer twilio node-cron  ← ya instalado ✅
```

---

## 2. Configurar el archivo `.env`

Copia `.env.example` a `.env` y llena estos valores:

```env
# ─── IA (Claude) ─────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-XXXX   ← de console.anthropic.com
AI_MODEL=claude-3-5-haiku-20241022    ← rápido y económico
AI_EMPRESA_NOMBRE=Suminregio Parker

# ─── Email Outlook 365 ──────────────────────────────────────────
EMAIL_USER=guillermo@tudominio.com
EMAIL_PASS=xxxx xxxx xxxx xxxx        ← App Password (16 chars)
EMAIL_FROM=Dashboard ERP <guillermo@tudominio.com>
EMAIL_TO=guillermo@tudominio.com,direccion@tudominio.com

# ─── WhatsApp Twilio ────────────────────────────────────────────
TWILIO_ACCOUNT_SID=ACxxxxxxxxxx       ← console.twilio.com
TWILIO_AUTH_TOKEN=xxxxxxxxxx
TWILIO_WA_FROM=whatsapp:+14155238886  ← sandbox Twilio
ALERT_WA_TO=whatsapp:+5218112345678   ← tu número con código país

# ─── Scheduler ──────────────────────────────────────────────────
ALERT_CRON=0 7 * * 1-6               ← lun-sab a las 7am Monterrey
ALERT_VENTA_UMBRAL_PCT=80            ← alerta si ventas < 80% del ritmo esperado
ALERT_CXC_VENCIDO_PCT=30             ← alerta si CXC vencido > 30%
```

---

## 3. Cómo obtener la App Password de Outlook 365

1. Ve a https://account.microsoft.com/security
2. → **Contraseñas de aplicación** (o **App passwords**)
3. Crea una nueva → copia los 16 caracteres (con espacios)
4. Pégalos en `EMAIL_PASS=xxxx xxxx xxxx xxxx`

> ⚠️ Si tu organización tiene MFA activado, necesitas App Password.
> Si no tiene MFA, puedes usar tu contraseña normal.

---

## 4. Configurar WhatsApp Sandbox Twilio

1. Ve a https://console.twilio.com/
2. Messaging → Try it out → Send a WhatsApp message
3. Escanea el QR con tu WhatsApp
4. Manda el mensaje que te piden (ej: `join bright-cloud`)
5. ¡Listo! Ya puedes recibir mensajes del sandbox

> Para producción (número propio): activa **WhatsApp Sender** en Twilio (requiere aprobación Meta).

---

## 5. Cómo funciona el sistema

### Chat IA en los dashboards
- Ícono 🤖 flotante en esquina inferior derecha de **todos** los dashboards
- Accede a datos en tiempo real de la BD Firebird vía los endpoints del servidor
- Responde en español con datos concretos de ventas, CXC, resultados, vendedores
- **📷 Captura pantalla**: toma captura del dashboard actual y se la envía a Claude para análisis visual
- **🔔 Tab Alertas**: muestra alertas activas y botones para enviar por email/WhatsApp

### Alertas automáticas diarias (7am)
El scheduler verifica automáticamente:
- Ventas vs meta (alerta si < 80% del ritmo esperado)
- CXC vencido (alerta si > 30% del saldo)
- Margen bruto (alerta si < 25%)
- Vendedores sin ventas

Si hay alertas, toma **screenshots de los dashboards** (ventas, CXC, resultados) y los adjunta al email.

### Endpoints disponibles
| Endpoint | Método | Descripción |
|---------|--------|-------------|
| `/api/alerts/check` | GET | Verifica KPIs ahora |
| `/api/alerts/send` | POST | Envía alerta manual |
| `/api/alerts/test` | POST | Envío de prueba |
| `/api/ai/chat` | POST | Chat con el asistente IA |

### Prueba manual del email
```bash
curl -X POST http://localhost:7000/api/alerts/test \
  -H "Content-Type: application/json" \
  -d '{"channels":["email","whatsapp"]}'
```

---

## 6. Notas importantes

- El chatbot usa el modelo `claude-3-5-haiku-20241022` por defecto (rápido, ~$0.001/mensaje)
- Para más potencia cambia a `claude-opus-4-6` en `AI_MODEL`
- Los screenshots usan **Playwright** (ya instalado en el proyecto)
- Si Playwright falla, las alertas se envían sin imágenes (el email sigue funcionando)
- Las alertas solo se activan si `EMAIL_USER` y/o `TWILIO_ACCOUNT_SID` están configurados
