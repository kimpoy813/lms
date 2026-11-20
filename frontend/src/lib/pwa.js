// PWA helpers: service worker registration (production) and install prompt capture.
let deferredPrompt = null;
const listeners = new Set();

function notify() {
  const ready = Boolean(deferredPrompt);
  for (const fn of listeners) fn(ready);
}

export function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone === true);
}

export function canInstallPwa() {
  return Boolean(deferredPrompt) && !isStandaloneMode();
}

export function subscribeInstallPrompt(listener) {
  listeners.add(listener);
  listener(canInstallPwa());
  return () => listeners.delete(listener);
}

export async function promptInstallPwa() {
  if (!deferredPrompt) return null;
  const event = deferredPrompt;
  deferredPrompt = null;
  notify();
  await event.prompt();
  const choice = await event.userChoice;
  return choice?.outcome ?? null;
}

export function initPwaListeners() {
  if (typeof window === 'undefined') return () => {};
  const onBeforeInstall = (event) => {
    event.preventDefault();
    deferredPrompt = event;
    notify();
  };
  const onInstalled = () => {
    deferredPrompt = null;
    notify();
  };
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    window.removeEventListener('appinstalled', onInstalled);
  };
}

export function registerServiceWorker({ onUpdateReady } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  let activeRegistration = null;
  const onLoad = async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      activeRegistration = registration;
      registration.addEventListener('updatefound', () => {
        const next = registration.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            if (onUpdateReady) onUpdateReady(() => next.postMessage({ type: 'SKIP_WAITING' }));
            else next.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
      registration.update().catch(() => {});
    } catch {
      // Service workers are optional progressive enhancement.
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') activeRegistration?.update().catch(() => {});
  };
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('load', onLoad);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

// Test helper
export function _resetPwaForTest() {
  deferredPrompt = null;
  listeners.clear();
}

// ── Web Push helpers ──────────────────────────────────────────────────────────
export function isPushSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return Boolean('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

function bufferToBase64Url(buffer) {
  if (!buffer) return null;
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function subscriptionMatchesKey(sub, publicKey) {
  if (!sub || !publicKey) return false;
  const existing = sub.options?.applicationServerKey;
  if (!existing) return true;
  const a = new Uint8Array(existing);
  const b = urlBase64ToUint8Array(publicKey);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function extractSubscriptionPayload(sub) {
  const json = typeof sub.toJSON === 'function' ? sub.toJSON() : {};
  const keys = {
    p256dh: json.keys?.p256dh ?? bufferToBase64Url(sub.getKey?.('p256dh')),
    auth: json.keys?.auth ?? bufferToBase64Url(sub.getKey?.('auth')),
  };
  return { endpoint: json.endpoint ?? sub.endpoint, keys };
}

export async function getActivePushSubscription() {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function enableWebPush(publicKey, apiClient) {
  if (!isPushSupported()) throw new Error('This browser does not support Web Push notifications.');
  if (!publicKey) throw new Error('Push notifications are not configured on this server.');
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked in your browser settings. Allow notifications for this site and try again.'
      : 'Notification permission was dismissed.');
  }
  const registration = await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (sub && !subscriptionMatchesKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await apiClient.post('/notifications/push/subscribe', extractSubscriptionPayload(sub));
  return sub;
}

export async function disableWebPush(apiClient) {
  const sub = await getActivePushSubscription();
  if (!sub) return false;
  const endpoint = sub.endpoint;
  try {
    await apiClient.post('/notifications/push/unsubscribe', { endpoint });
  } finally {
    await sub.unsubscribe();
  }
  return true;
}
