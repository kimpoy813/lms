// EduSphere service worker: makes the app installable and gives a friendly offline page.
//
// What it caches: the application shell (HTML, hashed JS/CSS, fonts, icons).
// What it never caches: anything under /api or /socket.io — grades, attendance and messages are
// private, change constantly, and must always come from the server.
// What it never touches at all: /pyrunner/, the frame students' Python programs run in. That
// page has to come from the server with its own security headers, and is not the app's page.
const VERSION = 'edusphere-v1';
const SHELL = ['/', '/offline.html', '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/pyrunner/')) return;

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
  // Fingerprinted build assets never change: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
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
  }
});
