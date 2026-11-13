// Same-origin worker protocol and accessible loading state. No persistent storage.
export function decodeCloud(spec, {base, signal, onProgress, buffer, workerFactory} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cloud load cancelled', 'AbortError'));
    const worker = workerFactory ? workerFactory() : new Worker(new URL('./gt_cloud_worker.js?v=4', import.meta.url));
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new DOMException('Cloud load cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, {once:true});
    worker.onmessage = ({data}) => {
      if (settled || data.id !== spec.file) return;
      if (data.type === 'progress') { onProgress?.(data); return; }
      if (data.type === 'result') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.error || 'Cloud loading failed'));
    };
    worker.onerror = event => finish(new Error(event.message || 'Cloud worker failed'));
    worker.onmessageerror = () => finish(new Error('Cloud worker returned unreadable data'));
    const message = {spec, base:String(base), id:spec.file};
    // Keep the session's compressed cache intact; transfer only a decoding copy.
    if (buffer) { message.buffer = buffer.slice(0); }
    try { worker.postMessage(message, message.buffer ? [message.buffer] : []); }
    catch (error) { finish(error); }
  });
}

export function createCloudProgress(container, {showBar = true} = {}) {
  container.setAttribute('role', 'status');
  const label = document.createElement('span');
  const bar = document.createElement('progress');
  bar.className = 'cloud-load-bar';
  bar.max = 1;
  bar.setAttribute('aria-label', 'Point-cloud loading progress');
  const mib = bytes => (bytes / 1048576).toFixed(2) + ' MiB';
  return {
    show(text = 'Loading point cloud…') {
      container.replaceChildren(...(showBar ? [label, bar] : [label])); label.textContent = text;
      bar.removeAttribute('value'); container.hidden = false;
    },
    update({phase, loaded = 0, total = null, asset = 'point cloud'}) {
      container.replaceChildren(...(showBar ? [label, bar] : [label])); container.hidden = false;
      const known = phase === 'download' && Number.isFinite(total) && total > 0 && loaded <= total;
      if (known) bar.value = loaded / total; else bar.removeAttribute('value');
      label.textContent = phase === 'download'
        ? `Downloading ${asset} · ${known ? Math.floor(loaded / total * 100) + '% · ' : ''}${mib(loaded)}${known ? ' / ' + mib(total) : ''}`
        : phase === 'decompress' ? 'Decompressing point cloud…'
        : phase === 'render' ? 'Preparing display…' : 'Parsing point cloud…';
    },
    aggregate(state) {
      this.update({phase:'download', loaded:state.loadedBytes, total:state.totalKnown ? state.totalBytes : null, asset:'five room scans'});
      if (state.completed !== state.totalFiles && state.totalKnown && state.loadedBytes >= state.totalBytes) {
        bar.value = 0.999; label.textContent = label.textContent.replace('100%', '99%');
      }
      if (Object.keys(state.errors || {}).length) label.textContent += ' · Some background downloads can be retried by selecting the room.';
      if (state.completed === state.totalFiles) { bar.value = 1; label.textContent = `${state.totalFiles} / ${state.totalFiles} scans ready · ${mib(state.loadedBytes)}`; }
    },
    clear() { container.replaceChildren(); container.hidden = true; }
  };
}

// Release a ready scene even if a background transfer failed; its retry stays visible.
export function cloudOverlayReady(sceneReady, state) {
  return !!sceneReady && !!state && (state.completed === state.totalFiles || Object.keys(state.errors || {}).length > 0);
}
