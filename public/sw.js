// sw.js
// Caches the app SHELL only (HTML/CSS/JS) so the app opens on a cold start
// with zero network — not just "keeps working offline after first visit."
// User data (decks/cards/reviews) never touches this file; that all lives
// in IndexedDB via db.js. This worker has no opinion about /api/* beyond
// "don't cache it" — api.js's own offline queue (genQueue in db.js) is what
// handles a failed /generate-cards request, not this file.

const CACHE_VERSION = 'lernin-shell-v30';

// Bump CACHE_VERSION on every release that changes app code, assets, or styles.
// When bumped, the browser installs the new shell in the background into a fresh
// cache and holds the worker in a 'waiting' state. The active page detects the
// waiting worker and presents a warm update prompt ("New version ready — refresh?").
// When the user confirms, the client posts SKIP_WAITING to this worker, which then
// activates, clears old caches, and claims clients, triggering a smooth reload.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles.css',
  '/app.js',
  '/db.js',
  '/card-fidelity.js',
  '/scheduler.js',
  '/study.js',
  '/sound.js',
  '/canvas.js',
  '/mind-map.js',
  '/mind-maze.js',
  '/spatial-study.js',
  '/api.js',
  '/manual-json-import.js',
  '/pdf-extract.js',
  '/secrets.js',
  '/json-repair.js',
  '/motion-studio.js',
  '/motion-player.js',
  '/motion-api.js',
  '/motion-topic.js',
  '/motion-manual-import.js',
  '/mind-map-doc.js',
  '/mind-map-doc-api.js',
  '/mind-map-doc-manual-import.js',
  '/onboarding-script.json',
  '/onboarding-script-light.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/vendor/idb.js',
  '/vendor/ts-fsrs.js'
];

// The Fraunces stylesheet is cross-origin, so cache.addAll (which fails the
// whole install on any single rejected request) is too brittle for it — a
// transient Google Fonts hiccup on first install shouldn't break the entire
// offline shell. Fetched and cached separately, best-effort, after the
// same-origin shell is safely in place. The actual .woff2 file(s) the
// stylesheet references get swept in too via the fetch handler's
// opportunistic same-response caching below (cross-origin responses are
// cacheable even though their body is opaque to JS).
const FONT_STYLESHEET = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(SHELL_ASSETS);
      try {
        const fontResponse = await fetch(FONT_STYLESHEET);
        await cache.put(FONT_STYLESHEET, fontResponse);
      } catch {
        // Offline on first install, or Google Fonts unreachable — the app
        // shell still installs and works, just falls back to system serif
        // until a future online visit fills this in.
      }
    })()
  );
  // Deliberately do NOT call self.skipWaiting() here. The new service worker
  // waits until the user confirms the update prompt on the active page.
});

// Activate only when the user confirms the update prompt or on natural restart
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
  const CACHEABLE_CROSS_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Opportunistically cache same-origin assets (e.g. a new icon
          // added later) plus the two Google Fonts origins specifically —
          // NOT cross-origin generally, since blindly caching arbitrary
          // third-party responses (analytics, ad pixels, etc., if any get
          // added later) would grow the cache unpredictably.
          const cacheable =
            response.ok &&
            (url.origin === self.location.origin || CACHEABLE_CROSS_ORIGINS.includes(url.hostname));
          if (cacheable) {
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

// Focuses an already-open tab if one exists, otherwise opens a new one —
// standard pattern for "tapping a notification should bring you to the
// app," used by the study reminder in app.js's checkAndShowStudyReminder().
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
