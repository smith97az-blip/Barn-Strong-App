// sw.js — Barn Strong PWA (GitHub Pages safe, Firebase-friendly)
const VERSION    = 'v3.1.6';                     // ⬅️ bump when you change this file
const CACHE_NAME = `bs-static-${VERSION}`;

// Scope base (works under /Barn-Strong-App/)
const BASE = self.registration.scope;
const u = (p) => new URL(p, BASE).toString();

// List your core same-origin assets here (add/remove as needed).
// You can keep these unversioned; fetch handler uses ignoreSearch.
const PRECACHE_ASSETS = [
  u('./'),
  u('index.html'),
  u('styles.css'),
  u('app.js'),
  u('assets/mascot-barn-angry.png'),
  // Add other local assets you want offline (fonts/images).
];

// --- Helpers ---
function shouldBypass(url) {
  // Bypass ALL cross-origin requests, and any Firebase/Google endpoints.
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return true;

  const host = url.hostname;
  const isFirebaseOrGoogle =
    host.endsWith('googleapis.com') ||
    host.endsWith('gstatic.com') ||
    host.endsWith('firebaseio.com') ||
    url.pathname.startsWith('/__/firebase');
  return isFirebaseOrGoogle;
}

// --- Install: precache, but skip any failures (no addAll all-or-nothing) ---
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(
      PRECACHE_ASSETS.map(async (assetUrl) => {
        const req = new Request(assetUrl, { cache: 'reload' });
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') {
            await cache.put(req, res.clone());
          } else {
            console.warn('[SW] Skip precache (bad status):', assetUrl, res.status);
          }
        } catch (e) {
          console.warn('[SW] Skip precache (fetch failed):', assetUrl, e);
        }
      })
    );
    await self.skipWaiting();
  })());
});

// --- Activate: clean old versions, take control ---
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => n.startsWith('bs-static-') && n !== CACHE_NAME)
           .map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

// Optional: allow page to postMessage('SKIP_WAITING') to activate immediately
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --- Fetch: cache-first for same-origin static GETs; bypass Firebase/Google/cross-origin ---
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache Firebase/Google or any cross-origin traffic
  if (shouldBypass(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // Same-origin handling with cache-first, ignoreSearch for ?v=...
  event.respondWith((async () => {
    // Try cache first
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const netRes = await fetch(req);
      // Cache only same-origin static responses that are OK/opaque
      if (netRes && (netRes.ok || netRes.type === 'opaque')) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, netRes.clone()).catch(() => {});
      }
      return netRes;
    } catch (e) {
      // SPA fallback for navigations when offline
      if (req.mode === 'navigate') {
        const fallback = await caches.match(u('index.html'), { ignoreSearch: true });
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});

