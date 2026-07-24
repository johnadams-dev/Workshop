// roster-sw.js — Agent Roster PWA service worker (first one in this repo;
// treat as a template for future tools, but scoped narrowly to roster.html for now).
//
// Caches the static shell only (this page, manifest, icons). Anything hitting
// the mls-proxy API origin — the directory data itself (/roster/*, /offices)
// — is deliberately network-only, never cached: the entire point of
// replacing the AppSheet/Google-Sheet directory is that this data can't go
// stale, so a cached API response would defeat the purpose.
const CACHE_NAME = "roster-shell-v1";
const API_HOST   = "mls-proxy-975684028597.us-east1.run.app";
const SHELL_URLS = [
  "/roster.html",
  "/manifest.json",
  "/images/roster-android-chrome-192x192.png",
  "/images/roster-android-chrome-512x512.png",
  "/images/roster-apple-touch-icon.png",
  "/images/roster-favicon-32x32.png",
  "/images/roster-favicon-16x16.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.hostname === API_HOST) return; // network-only, never intercept

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
