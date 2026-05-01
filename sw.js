// Macro Demon — Service Worker
// Goals (in priority order):
//   1. Cache the app shell (HTML + CDN scripts + fonts) so revisits are
//      instant — no network round-trip for the static parts.
//   2. Stale-while-revalidate for cacheable third-party data fetches
//      (Yahoo, FRED, Finnhub, etc.). Page renders from cache immediately,
//      fresh response replaces it in cache for the next visit.
//   3. Pass-through (no caching) for the Netlify function — those calls
//      are POSTs that mutate state (rate-limit counters, AI calls) and
//      shouldn't be served stale.
//
// Invalidation strategy:
//   - Bump CACHE_VERSION when you ship a new index.html or change the
//     proxy contract. Old caches are deleted on activation.

const CACHE_VERSION = 'md-v3';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

// Static assets that should be cached immediately on install.
// (Fonts and CDN scripts will be cached on first request via runtime caching.)
const APP_SHELL = [
  '/',
  '/index.html',
];

// Origins where stale-while-revalidate is safe (read-only data APIs).
// POSTs and the function endpoint are NEVER cached.
const SWR_ORIGINS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
  'https://api.stlouisfed.org',
  'https://finnhub.io',
  'https://newsdata.io',
  'https://www.alphavantage.co',
  'https://api.coingecko.com',
  'https://api.binance.com',
  'https://api.frankfurter.app',
];

// Static assets we want cache-first (Chart.js, fonts, etc.) — anything
// hosted on a CDN that won't change for the life of this app version.
const STATIC_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ── INSTALL: warm the app-shell cache ─────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean up old caches, take control immediately ──────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => !k.startsWith(CACHE_VERSION))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: route by URL ──────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Bail on non-GET requests entirely. POSTs (like claude-proxy) pass
  // through to network, never cached.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin GETs (HTML, our own assets): network-first with cache fallback.
  // This way you always get the freshest UI, but offline still works.
  if (url.origin === self.location.origin) {
    // Skip the SW entirely for the function endpoint (defence in depth).
    if (url.pathname.startsWith('/.netlify/functions/')) return;
    event.respondWith(networkFirst(req, APP_SHELL_CACHE));
    return;
  }

  // CDN static assets: cache-first (immutable for app version).
  if (STATIC_ORIGINS.some(o => req.url.startsWith(o))) {
    event.respondWith(cacheFirst(req, APP_SHELL_CACHE));
    return;
  }

  // Third-party data APIs: stale-while-revalidate.
  if (SWR_ORIGINS.some(o => req.url.startsWith(o))) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // Anything else: network passthrough (no caching).
});

// ── Cache strategies ─────────────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    // No cache, no network — return a 504 so calling code sees a real error.
    return new Response('Offline', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response('Offline', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  // Kick off the network refresh in the background regardless of cache hit.
  // Errors on the refresh don't break the response — we still serve cache.
  const refresh = fetch(req)
    .then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  // If we have a cached version, return it immediately. Otherwise wait
  // for the network.
  return cached || (await refresh) || new Response('Offline', { status: 504 });
}
