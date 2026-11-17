/* Guarda la app en el teléfono para que abra sin internet. Cambiar V en cada versión publicada. */
const V = "terreno-1.1.1";
const FILES = ["./", "index.html", "app.js", "zxing-reader.js", "zxing_reader.wasm", "jszip.min.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const r = e.request; if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => hit || fetch(r).catch(() => r.mode === "navigate" ? caches.match("index.html") : Response.error())));
});
