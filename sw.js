// Service Worker — Træningslog
// Strategi:
//   - App shell (HTML/CSS/JS, eksterne libs):  cache-first med baggrunds-revalidering
//   - Supabase API-kald:                       network-first med fallback til cache
//   - Andet:                                   network-first

const CACHE_VERSION = 'v122';
const APP_CACHE = `traeningslog-app-${CACHE_VERSION}`;
const RUNTIME_CACHE = `traeningslog-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './hjaelp.html',
  './privacy.html',
  './terms.html',
  './404.html',
  './icon-192.png',
  './og-image.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  'https://unpkg.com/lucide@1.14.0',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache => {
      return Promise.allSettled(APP_SHELL.map(url => cache.add(url).catch(() => null)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k !== APP_CACHE && k !== RUNTIME_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isSupabaseRequest(url){
  return url.hostname.endsWith('supabase.co');
}

function isAppShellRequest(url){
  if(url.origin === self.location.origin) return true;
  return url.hostname === 'unpkg.com'
      || url.hostname === 'cdn.jsdelivr.net'
      || url.hostname === 'cdnjs.cloudflare.com';
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  if(isSupabaseRequest(url)){
    event.respondWith(
      fetch(req).then(response => {
        if(response.ok){
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
        }
        return response;
      }).catch(() => caches.match(req))
    );
    return;
  }

  if(isAppShellRequest(url)){
    event.respondWith(
      caches.match(req).then(cached => {
        const network = fetch(req).then(response => {
          if(response.ok){
            const copy = response.clone();
            caches.open(APP_CACHE).then(c => c.put(req, copy));
          }
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});

self.addEventListener('message', event => {
  if(!event.data) return;
  if(event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
  // Ryd Supabase-cache når brugeren logger ud — undgår at stale
  // user-data fra forrige session kan serveres til ny bruger på samme device.
  if(event.data.type === 'CLEAR_RUNTIME_CACHE'){
    event.waitUntil(caches.delete(RUNTIME_CACHE));
  }
});
