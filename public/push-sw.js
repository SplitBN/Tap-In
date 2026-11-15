// Web Push handlers, imported into the generated service worker (vite.config.ts → workbox.importScripts).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Tap In', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || './' },
    icon: 'icon-192.png', badge: 'icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(url); return; } }
    await self.clients.openWindow(url);
  })());
});
