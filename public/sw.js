const SHELL_CACHE = "ops-control-plane-shell-v1";
const DAY_PACK_CACHE = "ops-control-plane-day-pack-v1";
const CAPTURE_PATH = "/capture";
const DAY_PACK_PATH = "/api/reads/me";

async function cacheAppShell() {
  const cache = await caches.open(SHELL_CACHE);
  await cache.addAll(["/manifest.webmanifest", "/icon.svg"]);
  const response = await fetch(CAPTURE_PATH, { credentials: "include" });
  if (!response.ok) return;
  await cache.put(CAPTURE_PATH, response.clone());
  const html = await response.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path) => path?.startsWith("/_next/static/"));
  await Promise.all(assets.map((path) => cache.add(path)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("ops-control-plane-") && ![SHELL_CACHE, DAY_PACK_CACHE].includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname === DAY_PACK_PATH) {
    event.respondWith(networkFirst(event.request, DAY_PACK_CACHE));
    return;
  }
  if (event.request.mode === "navigate" && url.pathname === CAPTURE_PATH) {
    event.respondWith(networkFirst(event.request, SHELL_CACHE));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") {
    event.respondWith(caches.open(SHELL_CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached !== undefined) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }));
  }
});
