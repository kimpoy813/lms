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
