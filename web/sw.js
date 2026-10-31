const CACHE = 'nails-crm-static-v1';
const FILES = ['./', './index.html', './styles.css', './core.js', './app.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', e => {
  const request = e.request;
  if(request.method !== 'GET' || new URL(request.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(request).then(response => {if(response.ok && new URL(request.url).origin === self.location.origin){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;}).catch(()=>caches.match(request)));
});
