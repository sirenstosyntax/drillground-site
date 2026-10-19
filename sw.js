/* DrillGround service worker — offline support for the installed app.
 *
 * A firefighter may open this in a bay or a stairwell with no signal. Once the
 * app has been loaded on the device, everything it needs is cached, so it keeps
 * working offline. Bump CACHE_VERSION whenever the app shell or data changes so
 * clients pick up the new files.
 */
"use strict";

var CACHE_VERSION = "drillground-v66";
// The app shell — cached on install so the app opens offline. Every entry here
// is REQUIRED: cache.addAll rejects as a unit, so one missing file fails the
// whole install and the app loses offline support entirely.
var SHELL = [
  "./",
  "index.html",
  "privacy.html",
  "app.css",
  "app.js",
  "recommend-drills.js",
  "tailboard.js",
  "entitlements.js",
  "purchase.js",
  "resources.js",
  "manifest.webmanifest",
  "drill_library.published.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

// Best-effort additions, cached individually so a miss cannot fail the install.
//
// The resource file is optional because a bundle can legitimately be built
// before any packs are published, and because every drill is runnable without
// its pack. Putting it in SHELL would mean one unpublished file costs the app
// its offline support — a bad trade for supporting material.
//
// Paid bodies are not in this cache. The page stores POST /api/packs in the
// separate cache "drillground-paid-packs", which restore() deletes when Play
// no longer lists the purchase. Do not add the public unlocked file here.
// Resource JSON is network-first so a republish refreshes without a bump.
var OPTIONAL = ["drill_resources.published.json", "drill_resources.store.json"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL).then(function () {
        return Promise.all(
          OPTIONAL.map(function (url) {
            return cache.add(url).catch(function () {
              /* not published yet; the app works without it */
            });
          })
        );
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  // Drop older app-shell caches (drillground-vN). That purge removes a device
  // that still holds the public unlocked file. Leave drillground-paid-packs
  // alone — the page deletes that cache itself when the purchase is gone.
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) {
            return k.indexOf("drillground-v") === 0 && k !== CACHE_VERSION;
          })
          .map(function (k) {
            return caches.delete(k);
          })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // Every JSON data file, not just the library. The resource files change on
  // their own schedule and a cache-first strategy would pin a device to the
  // packs it happened to see first.
  // Never store the old public paid file. A CACHE_VERSION bump deletes
  // copies that were cached under an earlier shell name.
  if (url.pathname.indexOf("drill_resources.unlocked.") !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  var isData =
    url.pathname.endsWith("drill_library.published.json") ||
    url.pathname.indexOf("drill_resources.") !== -1;

  if (isData) {
    // Network-first for data so a connected device gets fresh content, falling
    // back to the cached copy when offline. This branch does not cache the
    // unlocked payload. Paid bodies stay in the drillground-paid-packs cache.
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) {
            c.put(req, copy);
          });
          return res;
        })
        .catch(function () {
          return caches.match(req);
        })
    );
    return;
  }

  // Cache-first for the app shell (static, versioned).
  event.respondWith(
    caches.match(req).then(function (cached) {
      return (
        cached ||
        fetch(req).then(function (res) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) {
            c.put(req, copy);
          });
          return res;
        })
      );
    })
  );
});
