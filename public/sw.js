// Service worker mínimo: permite instalar la app (PWA) y sirve la interfaz sin conexión.
// Las llamadas a Supabase (otro dominio) nunca se cachean: los registros siempre requieren conexión.
const CACHE = 'asisteapp-v10';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/main.js', '/js/api.js', '/js/ui.js', '/js/face.js',
  '/js/employee.js', '/js/admin.js', '/js/incidencias.js', '/js/notifications.js', '/config.js', '/icon.svg', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/privacidad.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Red primero para obtener siempre la versión más reciente; caché como respaldo.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

// ---------- Notificaciones push ----------

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() ?? {}; } catch { data = { title: 'AsisteApp', body: e.data?.text() ?? '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'AsisteApp', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag,
    renotify: Boolean(data.tag),
    data: { link: data.link || '#/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(`/${e.notification.data?.link || '#/'}`, self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      return win.navigate(url).catch(() => win.postMessage({ type: 'navigate', url }));
    }
    return self.clients.openWindow(url);
  })());
});
