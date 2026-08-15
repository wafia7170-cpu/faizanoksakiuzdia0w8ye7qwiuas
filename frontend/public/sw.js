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

/* ─────────────────────────────────────────────────────────────────────────
 * Foreground-suppression decision (pure + testable).
 *
 * Requirement: a push notification banner must be SUPPRESSED only while the
 * recipient is actively inside the app (a window is open AND visible on
 * screen) — they can already see the incoming message live via realtime, so a
 * banner would be redundant. As soon as the app is backgrounded (e.g. the user
 * swiped to the home screen WITHOUT closing it) or fully closed, no window is
 * "visible", so the notification is shown as normal.
 *
 * `WindowClient.visibilityState === 'visible'` is the reliable signal here:
 *   • Actively viewing the app  → 'visible'  → suppress banner.
 *   • Home screen / another app → 'hidden'   → show banner.
 *   • App fully closed          → no clients → show banner.
 * ───────────────────────────────────────────────────────────────────────── */
function decideShowNotification(clientsList) {
  var appIsInForeground = (clientsList || []).some(function (c) {
    return c && c.visibilityState === 'visible';
  });
  // Show the notification UNLESS the app is currently in the foreground.
  return !appIsInForeground;
}
// Expose for automated verification.
self.decideShowNotification = decideShowNotification;

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

  event.waitUntil(
    (async () => {
      let clientsList = [];
      try {
        clientsList = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
      } catch (e) {
        clientsList = [];
      }

      if (!decideShowNotification(clientsList)) {
        // App is in the foreground — the user can already see the message.
        // Let any open client know a push arrived (optional in-app cue) and
        // skip the OS notification banner entirely.
        for (const c of clientsList) {
          try {
            c.postMessage({ type: 'push-received-foreground', payload: data });
          } catch (e) {
            /* ignore */
          }
        }
        return;
      }

      // App is backgrounded or closed — show the notification as normal.
      return self.registration.showNotification(title, options);
    })(),
  );
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
