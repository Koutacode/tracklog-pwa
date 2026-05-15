const CACHE_NAME = 'tracklog-shell-v2';
const PRECACHE = ['/', '/manifest.webmanifest', '/apple-touch-icon.png', '/pwa-192.png', '/pwa-512.png'];

async function fetchAndCache(request) {
  const response = await fetch(request);
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) return caches.delete(key);
          return Promise.resolve(true);
        }),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin && (url.pathname === '/version.json' || url.pathname === '/sw.js')) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetchAndCache(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/')) || Response.error();
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetchAndCache(request).catch(async () => {
      const cached = await caches.match(request);
      return cached || Response.error();
    }),
  );
});
