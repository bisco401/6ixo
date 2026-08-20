// Minimal service worker: no runtime caching, and clear any legacy caches on activate.
const SW_BUILD_VERSION = '20260820160000';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch (err) {
      // Keep activation resilient even if cache deletion fails.
      console.warn('SW cache cleanup failed:', err);
    }
    await self.clients.claim();
  })());
});
