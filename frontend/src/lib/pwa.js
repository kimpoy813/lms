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
  const onLoad = async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      registration.addEventListener('updatefound', () => {
        const next = registration.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            onUpdateReady?.(() => next.postMessage({ type: 'SKIP_WAITING' }));
          }
        });
      });
    } catch {
      // Service workers are optional progressive enhancement.
    }
  };
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
  return () => window.removeEventListener('load', onLoad);
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
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const json = sub.toJSON();
  await apiClient.post('/notifications/push/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
  });
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
