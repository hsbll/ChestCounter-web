// Keeps the analyzer (the .NET files) and the fonts in the browser, so that only the first visit after each
// update downloads them. One cache per published version (sw.js?v=…): an update never mixes with older files.
// Everything else (the page itself, its scripts) is not touched and always comes from the network.
const version = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `chestlookout-${version}`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
    for (const key of await caches.keys()) {
        if (key.startsWith('chestlookout-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || !/\/(_framework|fonts)\//.test(url.pathname)) return;
    event.respondWith((async () => {
        try {
            const cache = await caches.open(CACHE);
            const hit = await cache.match(request);
            if (hit) return hit;
            const response = await fetch(request);
            if (response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
            return response;
        } catch {
            return fetch(request);
        }
    })());
});
