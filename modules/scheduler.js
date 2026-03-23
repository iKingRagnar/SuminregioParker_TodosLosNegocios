/**
 * modules/scheduler.js
 * Cron diario (default 7am lun-sab) que:
 *  1. Verifica todos los KPIs
 *  2. Toma screenshots de los dashboards principales con Playwright
 *  3. Envía email HTML + WhatsApp con los resultados
 */
'use strict';

const cron      = require('node-cron');
const path      = require('path');
const { checkKpis }  = require('./alerts');
const { sendAlert }  = require('./notifier');

const PORT = process.env.PORT || 7000;
const CRON = process.env.ALERT_CRON || '0 7 * * 1-6'; // lun-sab 7am
const BASE = `http://localhost:${PORT}`;

// Páginas a capturar para el email (en orden de importancia)
const DASHBOARD_PAGES = [
  { name: 'ventas',      path: '/ventas.html',      waitFor: '#kVentaMes' },
  { name: 'cxc',         path: '/cxc.html',         waitFor: '#kSaldo' },
  { name: 'resultados',  path: '/resultados.html',  waitFor: null },
  { name: 'vendedores',  path: '/vendedores.html',  waitFor: null },
];

// ── Captura de screenshots con Playwright ─────────────────────────────────────
async function captureScreenshots(pages) {
  let playwright, chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (_) {
    console.warn('[scheduler] Playwright no disponible, screenshots omitidos');
    return [];
  }

  const screenshots = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
    });

    for (const pg of pages) {
      try {
        const page = await context.newPage();
        await page.goto(BASE + pg.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Esperar que los KPIs carguen (máximo 8s extra)
        if (pg.waitFor) {
          await page.waitForSelector(pg.waitFor, { timeout: 8000 }).catch(() => {});
        }
        await page.waitForTimeout(2500); // deja renderizar charts
        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        screenshots.push({ name: `${pg.name}.png`, buffer });
        await page.close();
      } catch (e) {
        console.warn(`[scheduler] Screenshot de ${pg.name} falló: ${e.message}`);
      }
    }
    await context.close();
  } catch (e) {
    console.error('[scheduler] Error lanzando Playwright:', e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return screenshots;
}

// ── Trabajo principal del cron ────────────────────────────────────────────────
async function runAlertJob(opts = {}) {
  const verbose = opts.verbose !== false;
  if (verbose) console.log(`[scheduler] Iniciando job de alertas ${new Date().toISOString()}`);

  try {
    // 1. Verificar KPIs
    const alertData = await checkKpis(opts.db || null);
    if (verbose) console.log(`[scheduler] KPIs verificados. Alertas: ${alertData.alertas.length}`);

    // 2. Screenshots (solo si hay alertas O si es modo full)
    let screenshots = [];
    const forceScreenshots = opts.forceScreenshots || alertData.alertas.length > 0;
    if (forceScreenshots) {
      if (verbose) console.log('[scheduler] Capturando screenshots...');
      screenshots = await captureScreenshots(DASHBOARD_PAGES);
      if (verbose) console.log(`[scheduler] ${screenshots.length} screenshot(s) capturados`);
    }

    // 3. Enviar notificaciones
    const channels = opts.channels || ['email', 'whatsapp'];
    const result = await sendAlert({
      alertData,
      screenshotBuffers: screenshots,
      channels,
    });

    if (verbose) {
      if (result.email)    console.log('[scheduler] Email enviado:', result.email.recipients);
      if (result.whatsapp) console.log('[scheduler] WhatsApp enviado:', result.whatsapp.map(r => r.to));
      if (result.errors.length) console.warn('[scheduler] Errores:', result.errors);
    }

    return { ok: true, alertData, result };
  } catch (e) {
    console.error('[scheduler] Error en job:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Inicialización del cron ───────────────────────────────────────────────────
let cronTask = null;

function startScheduler() {
  if (!cron.validate(CRON)) {
    console.warn(`[scheduler] ALERT_CRON inválido: "${CRON}". Scheduler no iniciado.`);
    return;
  }

  // Verificar si hay credenciales antes de activar
  const hasEmail = process.env.EMAIL_USER && !process.env.EMAIL_PASS?.includes('xxxx');
  const hasTwilio = process.env.TWILIO_ACCOUNT_SID && !process.env.TWILIO_ACCOUNT_SID.startsWith('ACxxxxxxx');

  if (!hasEmail && !hasTwilio) {
    console.log('[scheduler] Sin credenciales de notificación configuradas. Configura EMAIL_USER/EMAIL_PASS o TWILIO_* en .env para activar alertas automáticas.');
    return;
  }

  cronTask = cron.schedule(CRON, () => {
    runAlertJob({ forceScreenshots: true }).catch(e =>
      console.error('[scheduler] Cron job falló:', e.message)
    );
  }, {
    timezone: 'America/Monterrey',
  });

  console.log(`[scheduler] ✅ Alertas programadas: "${CRON}" (America/Monterrey) → Email: ${hasEmail ? '✓' : '✗'} WhatsApp: ${hasTwilio ? '✓' : '✗'}`);
  return cronTask;
}

function stopScheduler() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
}

module.exports = { startScheduler, stopScheduler, runAlertJob, captureScreenshots };
