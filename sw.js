// sw.js — Barn Strong PWA (robust precache for GitHub Pages)
const VERSION    = 'v3.1.4';            // bump to force update
const CACHE_NAME = `bs-static-${VERSION}`;

// Use the service worker scope as the base so it works under /Barn-Strong-App/
const BASE = self.registration.scope; // e.g. https://user.github.io/Barn-Strong-App/

// Helper to resolve against BASE
const u = (p) => new URL(p, BASE).toString();

// ✅ List your core assets here (prefer no query strings; we’ll ignoreSearch later)
const PRECACHE_ASSETS = [
  u('./'),
  u('index.html'),
  u('styles.css'),
  u('app.js'),
  u('assets/mascot-barn-angry.png'),
  // If you load CDN libs, you can include them too:
  // 'https://cdn.jsdelivr.net/npm/chart.js',
];

// INSTALL: fetch + put each asset, skip failures (no all-or-nothing)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = PRECACHE_ASSETS.map((url) => new Request(url, { cache: 'reload' }));

    await Promise.all(requests.map(async (req) => {
      try {
        const res = await fetch(req);
        // Accept OK or opaque (some CDNs return opaque)
        if (res.ok || res.type === 'opaque') {
          await cache.put(req, res.clone());
        } else {
          console.warn('[SW] Skip caching (bad status):', req.url, res.status);
        }
      } catch (e) {
        console.warn('[SW] Skip caching (fetch failed):', req.url, e);
      }
    }));

    // Activate this SW immediately
    await self.skipWaiting();
  })());
});

// ACTIVATE: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('bs-static-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// FETCH: cache-first for GET; fall back to network; ignore search to tolerate ?v=...
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    // Try cache (ignoreSearch lets /app.js serve /app.js?v=123)
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const netRes = await fetch(req);
      // Stash a copy for future if OK/opaque
      if (netRes && (netRes.ok || netRes.type === 'opaque')) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, netRes.clone()).catch(() => {});
      }
      return netRes;
    } catch (e) {
      // Navigation fallback: serve cached index.html for SPA routes when offline
      if (req.mode === 'navigate') {
        const fallback = await caches.match(u('index.html'), { ignoreSearch: true });
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
