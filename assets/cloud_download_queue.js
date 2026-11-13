// Cache compressed source bytes only. Callers must copy a cached buffer before
// transferring it to a Worker, because transferring would detach this cache.
export function createCloudDownloadQueue(specs, {base, onProgress = () => {}, fetchImpl = fetch} = {}) {
  const baseURL = new URL(base);
  const entries = new Map();
  let totalBytes = 0;
  for (const spec of specs) {
    if (!spec || typeof spec.file !== 'string' || !spec.file || entries.has(spec.file) ||
        !Number.isSafeInteger(spec.compressed_bytes) || spec.compressed_bytes <= 0) {
      throw new Error('Cloud files need unique names and positive compressed byte lengths.');
    }
    const url = new URL(spec.file, baseURL);
    if (url.origin !== baseURL.origin || !url.pathname.startsWith(baseURL.pathname)) {
      throw new Error('Cloud asset is outside this supplement.');
    }
    totalBytes += spec.compressed_bytes;
    entries.set(spec.file, {
      file: spec.file, size: spec.compressed_bytes, url,
      state: 'idle', loaded: 0, buffer: null, promise: null,
      resolve: null, reject: null, run: null, order: 0,
    });
  }
  if (!entries.size || !Number.isSafeInteger(totalBytes)) throw new Error('Invalid total cloud byte length.');

  const active = new Map(), errors = new Map();
  let currentFile = null, totalKnown = true, disposed = false, order = 0;
  let pumping = false, pumpAgain = false;
  const abortError = message => new DOMException(message, 'AbortError');

  function publish() {
    const current = entries.get(currentFile);
    const snapshot = {
      loadedBytes: [...entries.values()].reduce((sum, entry) => sum + entry.loaded, 0),
      totalBytes, totalKnown,
      completed: [...entries.values()].filter(entry => entry.state === 'cached').length,
      totalFiles: entries.size, currentFile,
      currentLoadedBytes: current?.loaded || 0,
      currentTotalBytes: current?.size || 0,
      activeCount: active.size,
      errors: Object.fromEntries(errors),
    };
    // A UI subscriber must not interrupt a transfer or leave its promise open.
    try { onProgress(snapshot); } catch { /* Keep queue bookkeeping independent of the UI. */ }
  }

  function pending(entry) {
    if (entry.state === 'queued' || entry.state === 'active' || entry.state === 'cached') return;
    entry.state = 'queued';
    entry.loaded = 0;
    entry.order = ++order;
    errors.delete(entry.file);
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    // Prefetch has no awaiting caller. Keep the original promise rejectable by
    // get(), while marking a background failure as handled from its creation.
    entry.promise.catch(() => {});
  }

  function stop(entry) {
    const run = entry.run;
    if (!run) return;
    entry.run = null;
    active.delete(entry.file);
    entry.loaded = 0;
    entry.state = 'queued';
    run.chunks.length = 0;
    run.controller.abort();
    if (run.reader) Promise.resolve(run.reader.cancel()).catch(() => {});
    // The same pending promise survives preemption. Discarded partial bytes no
    // longer count, so the real aggregate can decrease when a transfer restarts.
  }

  function start(entry) {
    const run = {controller: new AbortController(), reader: null, chunks: [], loaded: 0};
    entry.run = run;
    entry.loaded = 0;
    entry.state = 'active';
    active.set(entry.file, entry);
    void download(entry, run);
  }

  async function download(entry, run) {
    const isCurrent = () => !disposed && entry.run === run;
    try {
      const response = await fetchImpl(entry.url, {credentials: 'omit', signal: run.controller.signal});
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(`Cloud HTTP ${response.status}`);
      const encoding = (response.headers.get('Content-Encoding') || '').trim().toLowerCase();
      // Fetch exposes an HTTP-decoded body; its byte count cannot describe wire
      // progress when Content-Encoding changes the representation in transit.
      if (encoding && encoding !== 'identity') totalKnown = false;
      if (!response.body?.getReader) throw new Error('Streaming cloud response is unavailable.');
      run.reader = response.body.getReader();
      publish();
      for (;;) {
        const {done, value} = await run.reader.read();
        if (!isCurrent()) return;
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        run.loaded += chunk.byteLength;
        entry.loaded = run.loaded;
        if (run.loaded > entry.size) totalKnown = false;
        publish();
        if (run.loaded > entry.size) throw new Error(`Compressed cloud length mismatch: ${entry.file}`);
        run.chunks.push(chunk.slice());
      }
      if (run.loaded !== entry.size) throw new Error(`Compressed cloud length mismatch: ${entry.file}`);
      const bytes = new Uint8Array(run.loaded);
      let offset = 0;
      for (const chunk of run.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      run.chunks.length = 0;
      entry.buffer = bytes.buffer;
      entry.state = 'cached';
      entry.run = null;
      active.delete(entry.file);
      entry.resolve(entry.buffer);
      entry.resolve = entry.reject = null;
    } catch (error) {
      if (!isCurrent()) return;
      entry.state = 'failed';
      entry.loaded = 0;
      entry.run = null;
      active.delete(entry.file);
      run.chunks.length = 0;
      run.controller.abort();
      if (run.reader) Promise.resolve(run.reader.cancel()).catch(() => {});
      errors.set(entry.file, error?.message || String(error));
      entry.reject(error);
      entry.resolve = entry.reject = null;
    } finally {
      try { run.reader?.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
      if (!disposed && !entry.run) pump();
    }
  }

  function pump() {
    if (disposed) return;
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    do {
      pumpAgain = false;
      // A newly selected target gets its own slot immediately. At most one
      // other transfer continues, including an older foreground now demoted.
      const background = [...active.values()].filter(entry => entry.file !== currentFile)
        .sort((a, b) => a.order - b.order);
      for (const entry of background.slice(1)) stop(entry);
      const foreground = entries.get(currentFile);
      if (foreground?.state === 'queued' && active.size < 2) start(foreground);
      if (![...active.values()].some(entry => entry.file !== currentFile)) {
        const next = [...entries.values()].filter(entry => entry.state === 'queued' && entry.file !== currentFile)
          .sort((a, b) => a.order - b.order)[0];
        if (next && active.size < 2) start(next);
      }
    } while (pumpAgain && !disposed);
    pumping = false;
    publish();
  }

  publish();
  return {
    get(file) {
      if (disposed) {
        const result = Promise.reject(abortError('Cloud download queue is disposed.'));
        result.catch(() => {});
        return result;
      }
      const entry = entries.get(file);
      if (!entry) throw new Error(`Unknown cloud file: ${file}`);
      currentFile = file;
      pending(entry);
      pump();
      return entry.promise;
    },
    prefetchAll() {
      if (disposed) return;
      for (const entry of entries.values()) if (entry.state === 'idle') pending(entry);
      pump();
    },
    retryFailed() {
      if (disposed) return;
      for (const entry of entries.values()) if (entry.state === 'failed') pending(entry);
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of entries.values()) {
        if (entry.run) stop(entry);
        entry.reject?.(abortError('Cloud download queue is disposed.'));
        entry.resolve = entry.reject = null;
        entry.promise = entry.buffer = null;
        entry.loaded = 0;
        entry.state = 'disposed';
      }
      active.clear();
      errors.clear();
      currentFile = null;
      publish();
    },
  };
}
