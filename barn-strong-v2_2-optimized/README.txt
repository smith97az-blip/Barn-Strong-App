Barn Strong v2.2 (optimized base)
- Clean seams for v2.3: analytics stub, Today’s Session stub, Coach Portal stub
- Red/Gold theme + mascot (SVG, zero deps)
- PWA (service worker + manifest) and SPA redirects
- Firebase Auth/Firestore optional; runs in local demo without config
- Exercise Library seeded with initial 13 (v2.3 will replace with full li st)

Deploy (no CLI):
1) Unzip and drag this folder to Netlify (manual deploy).
2) In Firebase Console: enable Auth (Email/Password) + Firestore if you plan to use cloud.
3) Put your config in firebase-config.js (or keep it blank to run demo).
