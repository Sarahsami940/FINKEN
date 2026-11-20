/**
 * Finken's service worker. Built by the `finken-service-worker` plugin in
 * vite.config.ts, which fills in the list of files and the version.
 *
 * - The whole app (every script, style, icon and the page itself) is kept on
 *   the device, so Finken opens with no connection. Records are not kept
 *   here: they live in the app's own offline copy and sync on their own.
 * - Nothing under /api is ever cached: money records always go through sync.
 * - A new version waits until the person chooses to reload, so the app never
 *   changes under them in the middle of something.
 * - Shows reminders, and opens Finken at the right page when one is tapped.
 */
const VERSION = '__VERSION__';
const CACHE = `finken-${VERSION}`;
const PRECACHE = self.__PRECACHE;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('finken-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return;

  // Pages: the newest from the network when there is one, else the copy kept here.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) await (await caches.open(CACHE)).put('/', fresh.clone());
          return fresh;
        } catch {
          return (await caches.match('/', { cacheName: CACHE })) ?? (await caches.match('/')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Everything else the app is made of: the copy kept here, else the network (and keep it).
  event.respondWith(
    (async () => {
      const kept = await caches.match(request);
      if (kept) return kept;
      const fresh = await fetch(request);
      if (fresh.ok && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'))) await (await caches.open(CACHE)).put(request, fresh.clone());
      return fresh;
    })(),
  );
});

// ── Reminders ──────────────────────────────────────────────────────────────

/** Sent by Finken's server. The text says what is due without amounts, as it can show on a locked screen. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Finken', {
      body: data.body || 'Something needs your attention.',
      tag: data.tag || 'finken-reminder',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/money/upcoming' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(target);
      }
      return self.clients.openWindow(target);
    })(),
  );
});
