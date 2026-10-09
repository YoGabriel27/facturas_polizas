// Service worker: permite instalar la app y abrirla rápido.
// Los datos (Supabase) siempre se piden en línea; nunca se guardan en caché.
const VERSION = 'v2';
const CACHE = `polizas-${VERSION}`;
const ARCHIVOS = [
  '/', '/index.html', '/css/styles.css', '/js/app.js', '/js/calc.js', '/js/pdf-factura.js',
  '/js/config.js', '/js/centros-costo.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/favicon-48.png',
];
const CDN = ['cdn.jsdelivr.net', 'cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Archivos propios: primero la red (para ver siempre la última versión), si no hay conexión, la copia guardada
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req)
      .then((res) => {
        if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('/index.html'))));
    return;
  }

  // Librerías y tipografías con versión fija: se guardan la primera vez
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
      return res;
    })));
  }
  // Todo lo demás (Supabase) va directo a la red
});
