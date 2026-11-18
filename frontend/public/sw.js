// EduSphere service worker: makes the app installable and provides an offline shell.
//
// What it caches: the application shell (HTML, hashed JS/CSS, fonts, icons, screenshots).
// What it never caches: anything under /api, /socket.io, /healthz, /readyz, or /.well-known —
// grades, attendance, and messages are private and must always come from the server.
// What it never touches at all: /pyrunner/, the frame students' Python programs run in. That
// page has to come from the server with its own security headers, and is not the app's page.
const VERSION = 'edusphere-v3';
const SHELL = ['/', '/offline.html', '/theme-init.js', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
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

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text?.() ?? '' };
  }
  const title = data.title || 'EduSphere';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/maskable-192.png',
    tag: data.tag || 'edusphere-notification',
    data: { url: data.link || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/';
  const targetUrl = new URL(rawUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          if ('navigate' in client && client.url !== targetUrl.href) {
            client.navigate(targetUrl.href);
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl.href);
      return undefined;
    }),
  );
});
