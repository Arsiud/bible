// Caches the app and the KJV so it opens offline. Bump VERSION when files change.
const VERSION = "bible-v10";
const FILES = ["./", "index.html", "style.css", "app.js", "connect.js", "firebase-config.js", "kjv.json", "web.json", "asv.json", "manifest.json",
               "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Network first so updates show up right away; fall back to the cache when offline.
// "no-cache" makes the browser check with the server instead of reusing its own
// 10-minute copy, which otherwise kept old files (like firebase-config.js) around.
// ESV API requests are never cached.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    fetch(event.request.url, { cache: "no-cache" })
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
