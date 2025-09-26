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
