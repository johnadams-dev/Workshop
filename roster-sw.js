// roster-sw.js — Agent Roster PWA service worker (first one in this repo;
// treat as a template for future tools, but scoped narrowly to roster.html for now).
//
// Caches the static shell only (this page, manifest, icons). Anything hitting
// the mls-proxy API origin — the directory data itself (/roster/*, /offices)
// — is deliberately network-only, never cached: the entire point of
// replacing the AppSheet/Google-Sheet directory is that this data can't go
// stale, so a cached API response would defeat the purpose.
const CACHE_NAME = "roster-shell-v2";
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

  // Network-first, cache as a fallback for offline use only -- NOT cache-
  // first. A cache-first shell (the original v1 strategy here) means once
  // roster.html is cached, it's served from that snapshot forever on every
  // future reload, since the browser only re-checks this SW script itself
  // for byte-level changes, not the shell files it caches -- a real bug
  // found 2026-09-14: a shipped feature (the "Send a message" compose box,
  // commit af13553) was invisible to a user whose browser had roster.html
  // cached from before that commit, with no way to self-heal short of a
  // hard cache clear. Network-first fixes this going forward without
  // requiring CACHE_NAME to be bumped on every future roster.html edit.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
