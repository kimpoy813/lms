// Discenda service worker: makes the app installable and provides an offline shell.
//
// What it caches: the application shell (HTML, hashed JS/CSS, fonts, icons, screenshots).
// What it never caches: anything under /api, /socket.io, /healthz, /readyz, or /.well-known —
// grades, attendance, and messages are private and must always come from the server.
// What it never touches at all: /pyrunner/, the frame students' Python programs run in. That
// page has to come from the server with its own security headers, and is not the app's page.
const VERSION = 'discenda-v7';
const SHELL = ['/', '/offline.html', '/theme-init.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png', '/branding/discenda-logo-light.png', '/branding/discenda-logo-dark.png'];
const SHELL_SET = new Set(SHELL);
const GENERIC_PUSH_TITLES = new Set(['discenda', 'notification', 'new notification', 'new message']);

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

  // Shell files (manifest, theme-init, offline page, and brand lockups): network first so updates
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
  const initial = [];
  if (event.data) {
    try {
      initial.push(typeof event.data.json === 'function' ? event.data.json() : JSON.parse(event.data.text()));
    } catch {
      try {
        const text = typeof event.data.text === 'function' ? event.data.text().trim() : '';
        if (text) {
          try {
            initial.push(JSON.parse(text));
          } catch {
            initial.push({ body: text });
          }
        }
      } catch {
        // Fall through to a non-empty, useful notification below.
      }
    }
  }

  // Web Push providers use both flat payloads and wrappers such as { notification: {...} }
  // or { data: { notification: {...} } }. Walk those wrappers without assuming one shape.
  const records = [];
  const queue = [...initial];
  const seen = new Set();
  while (queue.length > 0 && records.length < 12) {
    const value = queue.shift();
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) continue;
      try {
        queue.push(JSON.parse(text));
      } catch {
        records.push({ body: text });
      }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) continue;
    seen.add(value);
    records.push(value);
    for (const key of ['notification', 'data', 'payload']) {
      if (value[key] && (typeof value[key] === 'object' || typeof value[key] === 'string')) queue.push(value[key]);
    }
  }

  const pick = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
  const fromRecords = (keys) => pick(...records.flatMap((record) => keys.map((key) => record[key])));
  const bodyText = fromRecords(['body', 'message', 'summary', 'description', 'text']);
  const suppliedTitle = fromRecords(['title', 'heading', 'subject', 'notificationTitle']);
  const specificTitle = GENERIC_PUSH_TITLES.has(suppliedTitle.toLowerCase()) ? '' : suppliedTitle;
  // Put the event detail in the visible title when senders omit one or supply only the app name.
  const bodyTitle = bodyText.length > 200 ? `${bodyText.slice(0, 199).trimEnd()}…` : bodyText;
  const title = (specificTitle || bodyTitle || 'New notification').slice(0, 200);
  const body = (bodyText || 'You have a new notification. Open Discenda to view details.').slice(0, 500);
  const link = fromRecords(['link', 'url']) || '/notifications';
  const tag = fromRecords(['tag']) || `discenda-${Date.now()}`;
  const rawTimestamp = records.find((record) => typeof record.timestamp === 'number' && Number.isFinite(record.timestamp))?.timestamp;
  const timestamp = rawTimestamp ?? Date.now();

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
      // Retain the actual event text if optional visual options are rejected by a browser.
      self.registration.showNotification(title, {
        body: options.body,
        tag: options.tag,
        timestamp: options.timestamp,
        data: options.data,
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
