/* ============================================================
   My Life OS — service worker
   ------------------------------------------------------------
   • App page (index.html): network-first, so a new deploy shows up on
     the next open; falls back to the cached copy when offline.
   • Icons / manifest: served from cache, refreshed in the background.
   • CDN libraries (Chart.js, SheetJS, supabase-js, Google Fonts):
     cache-first. Their URLs are version-pinned, so a cached copy is
     always the right one.
   • Supabase API calls (and anything else) are never cached: they go
     straight to the network, so sync always sees live data.
   Your data lives in IndexedDB, not here: clearing this cache never
   deletes records.
   Bump VERSION after changing icons or the manifest.
   ============================================================ */
const VERSION = 'v1';
const SHELL = `lifeos-shell-${VERSION}`;
const LIBS = 'lifeos-libs-v1';
const SHELL_FILES = [
  './',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];
// Pinned libraries the page loads. Precached at install so the app works offline
// from its second launch, not only after these happen to pass through the worker.
// Keep in sync with the <script>/<link> tags in index.html. supabase-js is left out on purpose:
// it is only downloaded once cloud sync is set up, and is cached the first time it loads.
const LIB_URLS = [
  ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js', 'no-cors'],
  ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'no-cors'],
  ['https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap', 'no-cors'],
];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const ROOT = new URL('./', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Add files one by one so a single missing icon can't break the install.
    await Promise.all(SHELL_FILES.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => { })));
    const libs = await caches.open(LIBS);
    await Promise.all(LIB_URLS.map(async ([u, mode]) => {
      if (await libs.match(u)) return;
      try { const res = await fetch(new Request(u, { mode, credentials: 'omit' })); if (res.ok || res.type === 'opaque') await libs.put(u, res); } catch { }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cleanup = async () => { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.startsWith('lifeos-shell-') && k !== SHELL).map(k => caches.delete(k))); };
    await cleanup();
    await self.clients.claim();
    await new Promise(r => setTimeout(r, 1500));
    await cleanup();   // again, in case the old worker wrote to its cache while we were taking over
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app page itself
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirstPage(req));
    return;
  }
  // Own static files (icons, manifest)
  if (url.origin === self.location.origin) {
    if (/\/(rest|auth|storage|realtime)\/v1\//.test(url.pathname)) return;   // never cache an API
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Pinned CDN libraries and fonts
  if (LIB_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  // Everything else (Supabase API, auth, …): untouched, straight to the network.
});

async function networkFirstPage(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok && res.type === 'basic') cache.put(ROOT, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(ROOT)) || (await cache.match(req, { ignoreSearch: true })) ||
      new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><body style="font-family:system-ui;padding:40px;text-align:center"><h1>You\'re offline</h1><p>Open My Life OS once while online so it can work offline.</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await fresh) || new Response('', { status: 504 });
}

async function cacheFirst(req) {
  const cache = await caches.open(LIBS);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
