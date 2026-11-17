// Offline app shell. Bump CACHE on every release; the app is cache-first, refreshed in the background.
const CACHE = "logbook-0.5.0";
const SHELL = ["./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./js/app.js", "./js/db.js", "./js/domain.js", "./js/i18n.js", "./js/seed.js", "./js/data.js", "./js/importer.js",
  "./icons/icon-192.png", "./icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(res => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
