/**
 * push-client.js — Client-side subscribe a web push
 * Carga VAPID public key desde /api/notify/push/vapid-public-key y se suscribe.
 * Almacena subscription en servidor vía /api/notify/push/subscribe.
 */
(function () {
  'use strict';
  if (window.__sumiPush) return;
  window.__sumiPush = true;

  async function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const keyRes = await fetch('/api/notify/push/vapid-public-key').then((r) => r.json());
      if (!keyRes.publicKey) return false;

      const existing = await reg.pushManager.getSubscription();
      if (existing) return true;

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return false;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: await urlBase64ToUint8Array(keyRes.publicKey),
      });
      await fetch('/api/notify/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub }),
      });
      return true;
    } catch (e) {
      console.warn('[push] subscribe falló:', e.message);
      return false;
    }
  }

  window.SumiPush = { subscribe: subscribe };

  // Botón opt-in automático
  setTimeout(function () {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
    if (sessionStorage.getItem('sumi_push_asked')) return;
    sessionStorage.setItem('sumi_push_asked', '1');

    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:70px;right:16px;z-index:9997;background:#fff;border:1px solid rgba(230,168,0,.3);border-radius:12px;padding:10px 14px;font-size:.82rem;color:#0F172A;max-width:320px;box-shadow:0 8px 24px -4px rgba(15,23,42,.12)';
    bar.innerHTML = '🔔 ¿Activar alertas push para CxC crítica, ventas bajas, etc.?<br><button id="push-yes" style="margin-top:8px;background:linear-gradient(135deg,#F5C33C,#E6A800);color:#1A1200;border:none;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;margin-right:6px">Sí</button><button id="push-no" style="background:transparent;border:1px solid #E2E8F0;color:#64748B;padding:6px 12px;border-radius:6px;cursor:pointer">Ahora no</button>';
    document.body.appendChild(bar);
    bar.querySelector('#push-yes').onclick = async function () { await subscribe(); bar.remove(); };
    bar.querySelector('#push-no').onclick = function () { bar.remove(); };
    setTimeout(function () { bar.remove(); }, 25000);
  }, 8000);
})();
