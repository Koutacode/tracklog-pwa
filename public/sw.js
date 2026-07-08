const CACHE_NAME = 'tracklog-shell-v3';
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

function readPushJson(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    try {
      return { notification: { body: event.data.text() } };
    } catch {
      return {};
    }
  }
}

function textValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanValue(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}

function normalizePushPayload(payload) {
  const data = payload.data || payload.notification?.data || {};
  const notification = payload.notification || payload.webpush?.notification || {};
  return {
    title: textValue(notification.title) || textValue(data.title) || 'TrackLog',
    body: textValue(notification.body) || textValue(data.body) || '管理者メッセージがあります',
    messageId: textValue(data.messageId),
    requestLocation: booleanValue(data.requestLocation, true),
    sentAt: textValue(data.sentAt),
  };
}

self.addEventListener('push', event => {
  const payload = normalizePushPayload(readPushJson(event));
  if (!payload.messageId) return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: `tracklog-admin-${payload.messageId}`,
      renotify: true,
      data: {
        type: 'TRACKLOG_ADMIN_PUSH_CLICK',
        messageId: payload.messageId,
        body: payload.body,
        requestLocation: payload.requestLocation,
        sentAt: payload.sentAt,
      },
      actions: payload.requestLocation
        ? [{ action: 'update_location', title: '現在地更新' }]
        : [],
    }),
  );
});

self.addEventListener('notificationclick', event => {
  const data = event.notification?.data || {};
  event.notification.close();
  if (data.type !== 'TRACKLOG_ADMIN_PUSH_CLICK' || !data.messageId) return;
  const targetUrl = new URL('/messages', self.location.origin);
  targetUrl.searchParams.set('messageId', data.messageId);
  targetUrl.searchParams.set('tracklogPushMessageId', data.messageId);
  targetUrl.searchParams.set('tracklogRequestLocation', data.requestLocation ? '1' : '0');
  if (data.body) targetUrl.searchParams.set('tracklogPushBody', data.body);
  if (data.sentAt) targetUrl.searchParams.set('tracklogPushSentAt', data.sentAt);

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) {
        let targetClient = client;
        try {
          if ('navigate' in client) {
            targetClient = await client.navigate(targetUrl.toString()) || client;
          } else {
            targetClient.postMessage(data);
          }
        } catch {
          targetClient.postMessage(data);
        }
        await targetClient.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl.toString());
    }
  })());
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
