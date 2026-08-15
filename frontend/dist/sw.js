/* Service worker for Web Push notifications (iOS PWA compatible).
 * Scope: '/' (served from site root). Handles push + notification clicks.
 * Intentionally NO fetch/caching handler so it never interferes with the
 * existing app loading or Supabase realtime. */

self.addEventListener('install', (event) => {
  // Activate immediately so pushes work on first enable without a reload.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'New message 💗';
  const options = {
    body: data.body || 'You have a new message',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    tag: data.tag || 'chat-message',
    renotify: false,
    data: { url: data.url || '/' },
  };

  // iOS REQUIRES a visible notification for every push, or the subscription
  // can be revoked. Never skip showNotification.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          // If a window for this app is already open, focus it.
          if ('focus' in client) {
            try {
              if ('navigate' in client) client.navigate(target);
            } catch (e) { /* cross-origin / not allowed — ignore */ }
            return client.focus();
          }
        }
        return self.clients.openWindow(target);
      }),
  );
});
