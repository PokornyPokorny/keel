// Keeps Keel's own files on the phone so it opens with no signal. Never touches the GitHub API:
// photos and listings are handled by the page (and its own on-phone storage).
const SHELL = ['./', 'index.html', 'days.js', 'github.js', 'local.js', 'photos.js', 'money.js', 'money-rules.js', 'up.js', 'money-store.js', 'manifest.webmanifest',
               'icon-180.png', 'icon-192.png', 'icon-512.png'];
const CACHE = 'keel-shell';

// Fetch every file fresh and replace the cached set only if all of them arrived,
// so an update never leaves a mix of old and new files.
async function refreshShell() {
  const fresh = await Promise.all(SHELL.map(async url => {
    const r = await fetch(new Request(url, { cache: 'no-store' }));
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    // Read each body as it arrives: unread bodies hold their connections, and with ~6 per host
    // waiting for all ten before reading any can deadlock.
    return [url, new Response(await r.blob(), { status: r.status, headers: r.headers })];
  }));
  const cache = await caches.open(CACHE);
  await Promise.all(fresh.map(([url, r]) => cache.put(url, r)));
}

self.addEventListener('install', e => { e.waitUntil(refreshShell()); self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Cache first, so a cold start with no signal still opens. Each open refreshes the set in the background,
// which means a new version shows up on the open after the one that downloaded it.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
  if (e.request.mode === 'navigate') e.waitUntil(refreshShell().catch(() => {}));
});
