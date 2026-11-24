// Discenda service worker: makes the app installable and provides an offline shell.
//
// What it caches: the application shell (HTML, hashed JS/CSS, fonts, icons, screenshots).
// What it never caches: anything under /api, /socket.io, /healthz, /readyz, or /.well-known —
// grades, attendance, and messages are private and must always come from the server.
// What it never touches at all: /pyrunner/, the frame students' Python programs run in. That
// page has to come from the server with its own security headers, and is not the app's page.
const VERSION = 'discenda-v4';
const SHELL = ['/', '/offline.html', '/theme-init.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];
const SHELL_SET = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/socket.io/')
    || url.pathname.startsWith('/pyrunner/')
    || url.pathname.startsWith('/.well-known/')
    || url.pathname === '/healthz'
    || url.pathname === '/readyz'
  ) {
    return;
  }

  // Page loads: network first, then the cached shell, then the offline page.
  if (request.mode === 'navigate') {
    // Every address of the app answers with the same page, which is kept as the shell. An
    // address that names a file (/offline.html, a frame) is some other page and must not replace it.
    const isAppPage = !url.pathname.split('/').pop().includes('.');
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && isAppPage) {
            const copy = response.clone(); // clone before the page consumes the body
            caches.open(VERSION).then((cache) => cache.put('/', copy));
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) ?? (await caches.match('/offline.html'))),
    );
    return;
  }

  // Fingerprinted build assets and static media: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname.startsWith('/screenshots/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Shell files (manifest, favicon, theme-init, offline page): network first so updates
  // propagate immediately online while staying self-contained offline.
  if (SHELL_SET.has(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});

function parsePushPayload(event) {
  let raw = null;
  if (event.data) {
    try {
      raw = typeof event.data.json === 'function' ? event.data.json() : JSON.parse(event.data.text());
    } catch {
      try {
        const text = typeof event.data.text === 'function' ? event.data.text() : '';
        if (text && text.trim()) {
          try {
            raw = JSON.parse(text);
          } catch {
            raw = { body: text.trim() };
          }
        }
      } catch {
        raw = {};
      }
    }
  }
  if (typeof raw === 'string') {
    raw = raw.trim() ? { body: raw.trim() } : {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = {};
  }
  if (!raw.title && !raw.body && !raw.message) {
    if (raw.notification && typeof raw.notification === 'object') raw = raw.notification;
    else if (raw.data && typeof raw.data === 'object') raw = raw.data;
  }

  const pick = (...vals) => {
    for (const val of vals) {
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return '';
  };

  const title = pick(raw.title, raw.heading, raw.subject) || 'Discenda';
  const bodyText = pick(raw.body, raw.message, raw.summary, raw.description, raw.text);
  const body = bodyText || (title === 'Discenda' ? 'You have a new notification. Open Discenda to view details.' : 'Open Discenda to view details.');
  const link = pick(raw.link, raw.url) || '/notifications';
  const tag = pick(raw.tag) || `discenda-${Date.now()}`;
  const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();

  return {
    title,
    options: {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag,
      renotify: true,
      timestamp,
      data: { url: link },
    },
  };
}

self.addEventListener('push', (event) => {
  const { title, options } = parsePushPayload(event);
  event.waitUntil(
    self.registration.showNotification(title, options).catch(() =>
      self.registration.showNotification('Discenda', {
        body: 'You have a new notification. Open Discenda to view details.',
        icon: '/icons/icon-192.png',
        data: { url: '/notifications' },
      }),
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/';
  const targetUrl = new URL(rawUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          if ('navigate' in client && client.url !== targetUrl.href) {
            try {
              await client.navigate(targetUrl.href);
            } catch {
              // Ignore navigation failure and focus or open a window below.
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
      return undefined;
    }),
  );
});
