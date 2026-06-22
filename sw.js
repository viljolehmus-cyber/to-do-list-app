/* ==========================================================================
   sw.js — service worker: offline support for the PWA.

   Strategy: pre-cache the full app shell on install (everything is local,
   there are no third-party requests), then serve cache-first with a
   network fallback. Bump VERSION whenever any asset changes so clients
   pick up the new files.

   All paths are relative so the app works when served from a
   subdirectory (e.g. GitHub Pages: username.github.io/repo/).
   ========================================================================== */

const VERSION = 'taskly-v11';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './storage.js',
  './icons.js',
  './notifications.js',
  './suggestions.js',
  './auth.js',
  './entry.js',
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        // offline and not cached: fall back to the app shell for navigations
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    }),
  );
});

/* Reminders are *local* notifications fired by notifications.js while the
   app is open — true push to a closed app would need a push backend.
   This handler just focuses (or reopens) the app when a notification is
   tapped. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => 'focus' in c);
      if (client) return client.focus();
      return self.clients.openWindow('./');
    }),
  );
});
