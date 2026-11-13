// Cache only this site's public static assets. No visitor identifiers or analytics.
const BASE = new URL('./', self.location.href);
const PREFIX = 'meow-visuals-' + encodeURIComponent(BASE.pathname) + '-';
let setup, storage, cacheName, entries, manifest, running = 0, active = false, ready = false, lastPost = 0;
let outstanding = [], completion;
const inflight = new Map();

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function relative(url) {
  const u = new URL(url);
  if (u.origin !== BASE.origin || !u.pathname.startsWith(BASE.pathname)) return null;
  return decodeURIComponent(u.pathname.slice(BASE.pathname.length)) || 'index.html';
}

async function initialize() {
  if (setup) return setup;
  setup = (async () => {
    const manifestURL = new URL('precache.json', BASE).href;
    let r;
    try {
      r = await fetch(manifestURL, {cache: 'no-store', credentials: 'omit'});
      if (!r.ok) throw Error('Asset list HTTP ' + r.status);
    } catch (error) {
      for (const key of (await caches.keys()).reverse()) {
        if (!key.startsWith(PREFIX)) continue;
        r = await (await caches.open(key)).match(manifestURL);
        if (r) break;
      }
      if (!r) throw error;
    }
    manifest = await r.json();
    cacheName = PREFIX + manifest.version;
    storage = await caches.open(cacheName);
    await storage.put(manifestURL, new Response(JSON.stringify(manifest), {headers:{'Content-Type':'application/json'}}));
    const stored = new Set((await storage.keys()).map(r => relative(r.url)));
    entries = new Map(manifest.files.map(f => [f.path, {...f, loaded: stored.has(f.path) ? f.bytes : 0, state: stored.has(f.path) ? 'cached' : 'queued'}]));
    // Put initial visible assets first; every remaining file is queued immediately.
    const priority = e => /^(assets|vendor)\//.test(e.path) || e.path.endsWith('.json') ? 0 : /office_display|(?:Reference|MEOW)_sim3/.test(e.path) ? 1 : 2;
    outstanding = [...entries.values()].filter(e => e.state !== 'cached').sort((a, b) => priority(a) - priority(b));
    return manifest;
  })().catch(error => { setup = null; throw error; });
  return setup;
}

function snapshot() {
  const all = [...entries.values()];
  return {type: 'ASSET_PROGRESS', version: manifest.version, totalBytes: manifest.total_bytes,
    loadedBytes: all.reduce((s, e) => s + e.loaded, 0), completed: all.filter(e => e.state === 'cached').length,
    totalFiles: all.length, failed: all.filter(e => e.state === 'failed').map(e => e.path), ready,
    storage: 'browser-cache', activeDownloads: running};
}

async function publish(force = false) {
  if (!manifest || !entries || (!force && Date.now() - lastPost < 200)) return;
  lastPost = Date.now();
  const message = snapshot();
  for (const client of await self.clients.matchAll({includeUncontrolled: true})) {
    if (client.url.startsWith(BASE.href)) client.postMessage(message);
  }
}

function download(entry) {
  if (inflight.has(entry.path)) return inflight.get(entry.path);
  const url = new URL(entry.path, BASE).href;
  const task = (async () => {
    entry.state = 'active';
    const cached = await storage.match(url);
    if (cached) { entry.loaded = entry.bytes; entry.state = 'cached'; return; }
    entry.loaded = 0;
    const response = await fetch(url, {credentials: 'omit', cache: 'no-cache'});
    if (!response.ok) throw Error('Asset HTTP ' + response.status);
    // Both branches drain concurrently; no permanent ArrayBuffer is retained.
    const write = storage.put(url, response.clone());
    write.catch(() => {});
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        entry.loaded = Math.min(entry.bytes, entry.loaded + value.byteLength);
        void publish();
      }
    }
    await write;
    entry.loaded = entry.bytes; entry.state = 'cached';
  })().catch(error => {
    entry.state = 'failed'; entry.loaded = 0; entry.error = String(error);
    throw error;
  }).finally(() => { inflight.delete(entry.path); void publish(true); });
  inflight.set(entry.path, task);
  return task;
}

async function prefetch(retry = false) {
  await initialize();
  if (retry) {
    for (const e of entries.values()) if (e.state === 'failed') { e.state = 'queued'; outstanding.push(e); }
  }
  if (active) { void publish(true); return completion; }
  ready = false; active = true;
  completion = (async () => {
    await publish(true);
    await Promise.all(Array.from({length: 4}, async () => {
      for (;;) {
        const entry = outstanding.shift();
        if (!entry) break;
        if (entry.state === 'cached') continue;
        running++;
        try { await download(entry); } catch { /* Retry is explicit, and completion stays false. */ }
        finally { running--; }
      }
    }));
    ready = [...entries.values()].every(e => e.state === 'cached');
    active = false;
    if (ready) {
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== cacheName) await caches.delete(key);
    }
    await publish(true);
  })();
  return completion;
}

self.addEventListener('message', event => {
  if (!['START_ASSET_CACHE', 'RETRY_ASSET_CACHE'].includes(event.data?.type)) return;
  event.waitUntil(prefetch(event.data.type === 'RETRY_ASSET_CACHE').catch(error => {
    event.source?.postMessage({type: 'ASSET_ERROR', message: String(error)});
  }));
});

self.addEventListener('fetch', event => {
  const request = event.request, path = relative(request.url);
  if (request.method !== 'GET' || path === null || ['sw.js', 'precache.json'].includes(path)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => { await initialize(); return storage.match(new URL('index.html', BASE).href); }));
    return;
  }
  event.respondWith((async () => {
    await initialize();
    const entry = entries.get(path);
    if (!entry) return fetch(request);
    const url = new URL(path, BASE).href;
    const cached = await storage.match(url);
    if (cached) return cached;
    // Requested assets share the same download as the background queue.
    await download(entry);
    return await storage.match(url);
  })());
});

// Build d5e445e33c26dd34
