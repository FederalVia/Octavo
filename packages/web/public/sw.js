/*
 * Octavo offline cache.
 *
 * Everything is fetched from your computer first, so you always see the latest
 * version. If your computer can't be reached (it's off, or your phone has no
 * signal), the last copy saved on this device is shown instead, read-only.
 * Only GET requests are cached; saving changes always needs a connection.
 */
const SHELL = 'octavo-shell-v2';
const DATA = 'octavo-data-v2';
const MAX_ASSETS = 400;
const MAX_CACHE_BYTES = 5 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      // Drop caches from older versions of this file.
      for (const name of await caches.keys()) {
        if (name.startsWith('octavo-') && name !== SHELL && name !== DATA) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  ),
);

const scope = new URL(self.registration.scope);

function isApi(url) {
  return url.pathname.startsWith(scope.pathname + 'api/');
}

/** Big downloads and live web pages aren't worth keeping offline. */
function shouldCache(request, res) {
  if (res.status !== 200) return false; // cache.put rejects 206 etc.
  const path = new URL(request.url).pathname;
  if (path === scope.pathname + 'api/publish.zip' || path.startsWith(scope.pathname + 'api/web/')) return false;
  const len = Number(res.headers.get('Content-Length'));
  if (len > MAX_CACHE_BYTES) return false;
  return true;
}

/** Cache key without the access key, so a new key doesn't hide saved copies. */
function keyFor(request) {
  const url = new URL(request.url);
  url.searchParams.delete('token');
  return url.toString();
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = keyFor(request);
  try {
    const res = await fetch(request);
    if (shouldCache(request, res)) {
      try {
        await cache.put(key, res.clone());
        if (cacheName === SHELL) trim(cache);
      } catch {
        /* quota or unsupported response: still return the network copy */
      }
    }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (!hit) throw err;
    // Tell the app it's looking at a saved copy.
    const headers = new Headers(hit.headers);
    headers.set('X-Octavo-Offline', '1');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return; // media seeking: 206 responses can't be cached
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.endsWith('/api/events') || url.pathname.startsWith(scope.pathname + 'mcp')) return; // live streams
  if (isApi(url)) {
    event.respondWith(networkFirst(request, DATA));
  } else if (request.mode === 'navigate') {
    // The app page itself: serve the saved index.html for any page address when offline.
    event.respondWith(
      networkFirst(request, SHELL).catch(async () => (await caches.open(SHELL)).match(new URL('./', scope).toString()) ?? Response.error()),
    );
  } else {
    event.respondWith(networkFirst(request, SHELL));
  }
});

// "Save all notes for offline": the app sends the list of URLs to fetch.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'octavo:save-all' || !Array.isArray(msg.urls)) return;
  const headers = msg.token ? { Authorization: `Bearer ${msg.token}` } : {};
  event.waitUntil(
    (async () => {
      const cache = await caches.open(DATA);
      let done = 0;
      const queue = [...msg.urls];
      const worker = async () => {
        while (queue.length) {
          const u = queue.shift();
          try {
            const res = await fetch(u, { headers });
            if (res.ok) await cache.put(keyFor(new Request(u)), res);
          } catch {
            /* skip */
          }
          done++;
          if (done % 10 === 0 || done === msg.urls.length) event.source?.postMessage({ type: 'octavo:save-progress', done, total: msg.urls.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })(),
  );
});
