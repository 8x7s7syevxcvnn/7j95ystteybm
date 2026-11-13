const text = document.getElementById('cache-text');
const progress = document.getElementById('cache-progress');
const retry = document.getElementById('cache-retry');
const box = document.getElementById('asset-cache');
const mb = n => (n / 1e6).toFixed(1);
function update(state) {
  if (state.type === 'ASSET_ERROR') { text.textContent = 'Cache incomplete. Retry to finish downloading.'; retry.hidden = false; return; }
  if (state.type !== 'ASSET_PROGRESS') return;
  window.__assetCacheStatus = state;
  progress.max = state.totalBytes || 1; progress.value = state.loadedBytes;
  box.dataset.ready = String(state.ready);
  text.textContent = state.ready ? `All visuals cached · ${mb(state.totalBytes)} MB · ready to explore`
    : `Caching all visuals · ${mb(state.loadedBytes)} / ${mb(state.totalBytes)} MB · ${state.completed}/${state.totalFiles} files`;
  retry.hidden = !state.failed?.length;
}

async function startCache() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    // LAN HTTP fallback: populate the HTTP cache without retaining raw buffers.
    const manifest = await (await fetch('precache.json')).json();
    let position = 0, loaded = 0, completed = 0; const failed = [];
    await Promise.all(Array.from({length: 4}, async () => {
      while (position < manifest.files.length) {
        const file = manifest.files[position++];
        try {
          const r = await fetch(file.path, {cache: 'force-cache', credentials: 'omit'});
          if (!r.ok) throw Error('HTTP ' + r.status);
          const reader = r.body?.getReader();
          if (reader) for (;;) { if ((await reader.read()).done) break; }
          completed++; loaded += file.bytes;
        } catch { failed.push(file.path); }
        update({type:'ASSET_PROGRESS',totalBytes:manifest.total_bytes,loadedBytes:loaded,completed,totalFiles:manifest.files.length,failed,ready:false,storage:'http-cache'});
      }
    }));
    // Cache Storage is reliable on localhost/HTTPS; HTTP cache retention is browser-managed.
    text.textContent = failed.length ? 'Some visual assets could not download.' : `All visuals downloaded · ${mb(manifest.total_bytes)} MB`;
    return;
  }
  navigator.serviceWorker.addEventListener('message', e => update(e.data));
  const registration = await navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), {updateViaCache:'none'});
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
  }
  const worker = () => navigator.serviceWorker.controller || registration.active;
  retry.addEventListener('click', () => { retry.hidden = true; worker().postMessage({type:'RETRY_ASSET_CACHE'}); });
  worker().postMessage({type:'START_ASSET_CACHE'});
}

// Begin the complete cache immediately, without waiting for any scroll or selection.
void startCache().catch(error => { console.error(error); update({type:'ASSET_ERROR'}); });
await Promise.all([import('./hero_scan.js'), import('./viewer.js'), import('./onepage.js')]);
