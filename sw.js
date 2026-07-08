// sw.js
// Caches the app SHELL only (HTML/CSS/JS) so the app opens on a cold start
// with zero network — not just "keeps working offline after first visit."
// User data (decks/cards/reviews) never touches this file; that all lives
// in IndexedDB via db.js. This worker has no opinion about /api/* beyond
// "don't cache it" — api.js's own offline queue (genQueue in db.js) is what
// handles a failed /generate-cards request, not this file.

const CACHE_VERSION = 'recalldb-shell-v1';

// Bump CACHE_VERSION on every deploy that changes any of these files, or
// returning users will keep serving a stale shell from cache. Wiring this
// bump into your CI push step (e.g. injecting a build hash) is worth doing
// once this stabilizes — for now it's a manual version string.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/db.js',
  '/scheduler.js',
  '/study.js',
  '/api.js',
  '/canvas.js',
  '/pdf-extract.js',
  '/manifest.json',
  '/styles.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls — let them hit the network directly (or fail
  // naturally, which is what api.js's own offline handling expects).
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Cache-first for the shell: instant load offline, no network round-trip
  // even when online, since these files change only on deploy.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Opportunistically cache anything else same-origin (e.g. a new
          // icon added later) without requiring a SHELL_ASSETS edit.
          if (response.ok && url.origin === self.location.origin) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached — for a navigation request, fall back to
          // the shell so the app still opens rather than showing a browser
          // error page.
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          throw new Error('Offline and asset not cached');
        });
    })
  );
});
