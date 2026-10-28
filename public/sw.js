// Service worker mínimo: permite instalar la app (PWA) y sirve la interfaz sin conexión.
// Las llamadas a Supabase (otro dominio) nunca se cachean: los registros siempre requieren conexión.
const CACHE = 'asisteapp-v2';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/main.js', '/js/api.js', '/js/ui.js', '/js/face.js',
  '/js/employee.js', '/js/admin.js', '/config.js', '/icon.svg', '/manifest.webmanifest'];

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
