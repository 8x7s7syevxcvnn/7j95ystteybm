import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const elements = {
  dataset: $('dataset-select'), group: $('group-select'), alignment: $('alignment-select'),
  error: $('page-error'), inputs: $('input-strip'), metrics: $('metrics-body'),
  predicted: $('show-cameras'), reference: $('show-gt'), pointSize: $('point-size'),
  linked: $('link-views'), colours: $('show-colors'), density: $('point-density'),
};
const baseURL = new URL('../', import.meta.url);
const modelOrder = ['Reference', 'MEOW', 'MapAnything_Apache', 'MapAnything_NC', 'VGGT', 'Wid3R'];
const modeColors = { panorama: 0x55c4ce, perspective: 0xf0bd64, fisheye: 0xc5a2ef };
const panels = [];
let catalog;
let group;
let groupVersion = 0;
let groupController;
let cloudCache = new Map();
let referenceBounds = null;
let rendering = false;
let synchronizing = false;
let selectedInput = null;
let graphicsError = null;
let isFramed = false;
let lastActivePanel = null;

function localURL(relative) {
  if (typeof relative !== 'string' || !relative) throw new Error('An asset path is missing.');
  const url = new URL(relative, baseURL);
  if (url.origin !== baseURL.origin || !url.pathname.startsWith(baseURL.pathname)) {
    throw new Error('The asset path is outside this supplement.');
  }
  url.searchParams.set('v', '2');
  return url;
}

async function readJSON(relative, signal) {
  const response = await fetch(localURL(relative), { signal, credentials: 'omit' });
  if (!response.ok) throw new Error(`Could not load ${relative} (HTTP ${response.status}).`);
  return response.json();
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function modelLabel(id) {
  return group?.models?.[id]?.label || id;
}

function alignmentFor(id) {
  return group?.models?.[id]?.alignments?.[elements.alignment.value];
}

function asMatrix(pose) {
  if (!Array.isArray(pose)) return null;
  const flat = pose.flat();
  if (flat.length !== 16 || !flat.every(Number.isFinite)) return null;
  return new THREE.Matrix4().set(...flat);
}

function posePosition(pose) {
  const matrix = asMatrix(pose);
  return matrix ? new THREE.Vector3().setFromMatrixPosition(matrix) : null;
}

function referencePoses() {
  return alignmentFor('Reference')?.poses || group?.gt_poses || group?.views?.map((view) => view.pose) || [];
}

function sceneRadius() {
  if (referenceBounds && !referenceBounds.isEmpty()) {
    return Math.max(referenceBounds.getBoundingSphere(new THREE.Sphere()).radius, 0.01);
  }
  const bounds = new THREE.Box3();
  for (const pose of referencePoses()) {
    const point = posePosition(pose);
    if (point) bounds.expandByPoint(point);
  }
  return bounds.isEmpty() ? 1 : Math.max(bounds.getSize(new THREE.Vector3()).length(), 0.1);
}

function requestRender() {
  if (rendering || !panels.length) return;
  rendering = true;
  requestAnimationFrame(() => {
    rendering = false;
    for (const panel of panels) {
      if (panel.viewport.clientWidth && panel.viewport.clientHeight) panel.renderer.render(panel.scene, panel.camera);
    }
  });
}

function synchronizeFrom(source) {
  if (synchronizing) return;
  lastActivePanel = source;
  if (!elements.linked.checked) { requestRender(); return; }
  synchronizing = true;
  for (const panel of panels) {
    if (panel === source) continue;
    setCameraUp(panel, source.camera.up);
    panel.camera.position.copy(source.camera.position);
    panel.camera.quaternion.copy(source.camera.quaternion);
    panel.controls.target.copy(source.controls.target);
    panel.camera.near = source.camera.near;
    panel.camera.far = source.camera.far;
    panel.camera.updateProjectionMatrix();
    panel.controls.update();
  }
  synchronizing = false;
  requestRender();
}

function makeControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.0001;
  controls.maxDistance = Infinity;
  return controls;
}

function setCameraUp(panel, up) {
  if (panel.camera.up.distanceToSquared(up) < 1e-12) return;
  const target = panel.controls.target.clone();
  panel.controls.dispose();
  panel.camera.up.copy(up);
  panel.controls = makeControls(panel.camera, panel.renderer.domElement);
  panel.controls.target.copy(target);
  panel.controls.addEventListener('change', () => synchronizeFrom(panel));
}

function disposeObject(object) {
  if (!object) return;
  object.traverse((child) => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  });
  object.removeFromParent();
}

function clearPanel(panel) {
  disposeObject(panel.cloud);
  disposeObject(panel.predictedGlyphs);
  disposeObject(panel.referenceGlyphs);
  panel.cloud = null;
  panel.predictedGlyphs = null;
  panel.referenceGlyphs = null;
  panel.bounds = null;
  panel.count.textContent = '';
  panel.kind.textContent = '';
  requestRender();
}

function panelState(panel, message, error = false) {
  panel.state.replaceChildren();
  panel.state.hidden = !message;
  panel.state.classList.toggle('error', error);
  if (!message) return;
  const text = document.createElement('span');
  text.textContent = message;
  panel.state.append(text);
  if (error && !graphicsError) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry loading';
    retry.addEventListener('click', () => loadPanel(panel));
    panel.state.append(retry);
  }
}

function createPanel(side) {
  const viewport = $(`${side}-viewport`);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x101820);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', `${side === 'left' ? 'Left' : 'Right'} interactive 3D view. Drag to orbit; scroll to zoom; right-drag to pan. W A S D move, Q E move vertically.`);
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.001, 10000);
  camera.position.set(3, 2, 4);
  const controls = makeControls(camera, renderer.domElement);
  const panel = {
    side, viewport, renderer, scene, camera, controls,
    select: $(`${side}-model`), state: $(`${side}-state`), count: $(`${side}-count`), kind: $(`${side}-kind`),
    cloud: null, bounds: null, predictedGlyphs: null, referenceGlyphs: null, loadVersion: 0, model: null,
  };
  controls.addEventListener('change', () => synchronizeFrom(panel));
  renderer.domElement.addEventListener('keydown', (event) => moveWithKeyboard(event, panel));
  renderer.domElement.addEventListener('pointerdown', () => { lastActivePanel = panel; });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    panelState(panel, 'The 3D graphics context was lost. Reload this page to restore the view.', true);
  });
  panel.select.addEventListener('change', () => { selectedInput = null; updateSelectedInput(); loadPanel(panel); });
  return panel;
}

function resizePanels() {
  for (const panel of panels) {
    const width = panel.viewport.clientWidth;
    const height = panel.viewport.clientHeight;
    if (!width || !height) continue;
    panel.renderer.setSize(width, height, false);
    panel.camera.aspect = width / height;
    panel.camera.updateProjectionMatrix();
  }
  requestRender();
}

function moveWithKeyboard(event, panel) {
  if (event.altKey || event.ctrlKey || event.metaKey || !group) return;
  const key = event.key.toLowerCase();
  if (!['w', 'a', 's', 'd', 'q', 'e'].includes(key)) return;
  event.preventDefault();
  const distance = panel.camera.position.distanceTo(panel.controls.target);
  const step = Math.max(distance, sceneRadius() * 0.1) * (event.shiftKey ? 0.12 : 0.035);
  const direction = new THREE.Vector3();
  const forward = panel.camera.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().setFromMatrixColumn(panel.camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(panel.camera.matrixWorld, 1).normalize();
  if (key === 'w') direction.copy(forward);
  if (key === 's') direction.copy(forward).negate();
  if (key === 'a') direction.copy(right).negate();
  if (key === 'd') direction.copy(right);
  if (key === 'q') direction.copy(up).negate();
  if (key === 'e') direction.copy(up);
  direction.multiplyScalar(step);
  panel.camera.position.add(direction);
  panel.controls.target.add(direction);
  panel.controls.update();
  synchronizeFrom(panel);
}

async function loadCloud(spec) {
  if (!spec?.file) throw new Error('This model has no point cloud for the selected display mode.');
  const key = spec.file;
  if (cloudCache.has(key)) return cloudCache.get(key);
  const cache = cloudCache;
  const signal = groupController.signal;
  const promise = (async () => {
    const response = await fetch(localURL(key), { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`Cloud loading failed (HTTP ${response.status}).`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength % 12 !== 0 || !buffer.byteLength) throw new Error('The point-cloud file is empty or malformed.');
    const count = buffer.byteLength / 12;
    if (Number.isFinite(spec.count) && count !== spec.count) throw new Error('The point-cloud count does not match its metadata.');
    const values = new DataView(buffer);
    const positions = new Float32Array(count * 3);
    const bounds = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i < positions.length; i++) {
      positions[i] = values.getFloat32(i * 4, true);
      if (!Number.isFinite(positions[i])) throw new Error('The point-cloud file contains non-finite coordinates.');
      if (i % 3 === 2) {
        point.set(positions[i - 2], positions[i - 1], positions[i]);
        bounds.expandByPoint(point);
      }
    }
    let colours = null;
    if (spec.colors_file) {
      const rgbResponse = await fetch(localURL(spec.colors_file), { signal, credentials: 'omit' });
      if (!rgbResponse.ok) throw new Error(`RGB loading failed (HTTP ${rgbResponse.status}).`);
      const rgb = new Uint8Array(await rgbResponse.arrayBuffer());
      if (rgb.length !== count * 3) throw new Error('RGB and point counts differ.');
      colours = new Float32Array(rgb.length);
      for (let i = 0; i < rgb.length; i++) { const v = rgb[i] / 255; colours[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
    }
    return { positions, colours, count, bounds };
  })();
  cache.set(key, promise);
  try { return await promise; }
  catch (error) { if (cache.get(key) === promise) cache.delete(key); throw error; }
}

async function loadPanel(panel) {
  if (!group) return;
  const version = ++panel.loadVersion;
  const currentGroup = groupVersion;
  const model = panel.select.value;
  panel.model = model;
  clearPanel(panel);
  updateMetricSelection();
  panelState(panel, `Loading ${modelLabel(model)}…`);
  try {
    const alignment = alignmentFor(model);
    const data = await loadCloud(alignment?.cloud);
    if (version !== panel.loadVersion || currentGroup !== groupVersion) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (data.colours) geometry.setAttribute('color', new THREE.BufferAttribute(data.colours, 3));
    geometry.boundingBox = data.bounds.clone();
    geometry.computeBoundingSphere();
    const coloured = elements.colours.checked && !!data.colours;
    const material = new THREE.PointsMaterial({ color: coloured ? 0xffffff : 0xc4d0d9, vertexColors: coloured, size: Number(elements.pointSize.value), sizeAttenuation: false, transparent: true, opacity: 0.88, depthWrite: true });
    panel.cloud = new THREE.Points(geometry, material);
    panel.cloud.frustumCulled = false;
    panel.bounds = data.bounds.clone();
    panel.scene.add(panel.cloud);
    applyDensity(panel);
    panel.kind.textContent = model === 'Reference' ? 'Reference geometry' : group.models[model].metric === false ? 'Scale-free visual context' : 'Metric method';
    refreshGlyphs(panel);
    panelState(panel, '');
    requestRender();
  } catch (error) {
    if (error.name === 'AbortError' || version !== panel.loadVersion || currentGroup !== groupVersion) return;
    panelState(panel, `${modelLabel(model)} could not be shown. ${error.message}`, true);
  }
}

function applyDensity(panel) {
  if (!panel.cloud) return;
  const geometry = panel.cloud.geometry;
  const total = geometry.getAttribute('position').count;
  const count = Math.max(1, Math.round(total * Number(elements.density.value) / 100));
  if (!geometry.index) geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(total), 1).setUsage(THREE.DynamicDrawUsage));
  const index = geometry.index.array;
  for (let i = 0; i < count; i++) index[i] = count === 1 ? Math.floor(total / 2) : Math.round(i * (total - 1) / (count - 1));
  geometry.index.needsUpdate = true;
  geometry.setDrawRange(0, count);
  panel.count.textContent = `${count.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} points`;
}

function refreshColour(panel) {
  if (!panel.cloud) return;
  const coloured = elements.colours.checked && !!panel.cloud.geometry.getAttribute('color');
  panel.cloud.material.vertexColors = coloured;
  panel.cloud.material.color.setHex(coloured ? 0xffffff : 0xc4d0d9);
  panel.cloud.material.needsUpdate = true;
}

function modeType(mode = '') {
  const text = mode.toLowerCase();
  if (/panorama|erp|equirect/.test(text)) return 'panorama';
  if (/fisheye/.test(text)) return 'fisheye';
  return 'perspective';
}

function makeCameraGlyph(pose, mode, size, reference, selected) {
  const matrix = asMatrix(pose);
  if (!matrix) return null;
  const glyph = new THREE.Group();
  glyph.applyMatrix4(matrix);
  const type = modeType(mode);
  const color = selected ? 0xffe398 : reference ? 0xd2dce3 : modeColors[type];
  const coordinates = [];
  const segment = (a, b) => coordinates.push(...a, ...b);
  if (type === 'panorama') {
    const r = size * 0.46;
    for (let plane = 0; plane < 3; plane++) {
      for (let i = 0; i < 32; i++) {
        const a = i / 32 * Math.PI * 2;
        const b = (i + 1) / 32 * Math.PI * 2;
        const circle = (t) => plane === 0 ? [Math.cos(t) * r, Math.sin(t) * r, 0] : plane === 1 ? [Math.cos(t) * r, 0, Math.sin(t) * r] : [0, Math.cos(t) * r, Math.sin(t) * r];
        segment(circle(a), circle(b));
      }
    }
    segment([0, 0, 0], [0, 0, size * 1.15]);
    segment([0, 0, size * 1.15], [size * 0.16, 0, size * 0.86]);
    segment([0, 0, size * 1.15], [-size * 0.16, 0, size * 0.86]);
  } else if (type === 'fisheye') {
    const r = size * 0.55;
    for (let axis = 0; axis < 2; axis++) {
      for (let i = 0; i < 24; i++) {
        const a = i / 24 * Math.PI;
        const b = (i + 1) / 24 * Math.PI;
        const arc = (t) => axis === 0 ? [Math.cos(t) * r, 0, Math.sin(t) * r] : [0, Math.cos(t) * r, Math.sin(t) * r];
        segment(arc(a), arc(b));
      }
    }
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * Math.PI * 2;
      const b = (i + 1) / 32 * Math.PI * 2;
      segment([Math.cos(a) * r, Math.sin(a) * r, 0], [Math.cos(b) * r, Math.sin(b) * r, 0]);
    }
    segment([0, 0, 0], [0, 0, size]);
    segment([0, 0, size], [size * 0.15, 0, size * 0.75]);
    segment([0, 0, size], [-size * 0.15, 0, size * 0.75]);
  } else {
    const z = size;
    const w = size * 0.55;
    const h = size * 0.38;
    const corners = [[-w, -h, z], [w, -h, z], [w, h, z], [-w, h, z]];
    for (let i = 0; i < 4; i++) {
      segment([0, 0, 0], corners[i]);
      segment(corners[i], corners[(i + 1) % 4]);
    }
    segment([-w * 0.35, -h, z], [0, -h * 1.5, z]);
    segment([0, -h * 1.5, z], [w * 0.35, -h, z]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
  const material = reference
    ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: selected ? 1 : 0.65, dashSize: size * 0.12, gapSize: size * 0.08, depthTest: false })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const lines = new THREE.LineSegments(geometry, material);
  if (reference) lines.computeLineDistances();
  lines.renderOrder = reference ? 3 : 4;
  glyph.add(lines);
  if (!reference) {
    const center = new THREE.Mesh(new THREE.SphereGeometry(size * 0.09, 6, 4), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    center.renderOrder = 5;
    glyph.add(center);
  }
  return glyph;
}

function refreshGlyphs(panel) {
  disposeObject(panel.predictedGlyphs);
  disposeObject(panel.referenceGlyphs);
  panel.predictedGlyphs = new THREE.Group();
  panel.referenceGlyphs = new THREE.Group();
  const size = sceneRadius() * 0.045;
  const predicted = alignmentFor(panel.model)?.poses || [];
  const reference = referencePoses();
  const modes = group?.views || [];
  if (panel.model !== 'Reference') {
    predicted.forEach((pose, index) => {
      const glyph = makeCameraGlyph(pose, modes[index]?.mode, size, false, index === selectedInput);
      if (glyph) panel.predictedGlyphs.add(glyph);
    });
  }
  reference.forEach((pose, index) => {
    const glyph = makeCameraGlyph(pose, modes[index]?.mode, size * 1.06, true, index === selectedInput);
    if (glyph) panel.referenceGlyphs.add(glyph);
  });
  panel.predictedGlyphs.visible = elements.predicted.checked;
  panel.referenceGlyphs.visible = elements.reference.checked;
  panel.scene.add(panel.predictedGlyphs, panel.referenceGlyphs);
}

function resetUpAndDirection() {
  const matrix = asMatrix(referencePoses()[0]);
  const right = matrix ? new THREE.Vector3().setFromMatrixColumn(matrix, 0).normalize() : new THREE.Vector3(1, 0, 0);
  const up = matrix ? new THREE.Vector3().setFromMatrixColumn(matrix, 1).negate().normalize() : new THREE.Vector3(0, 1, 0);
  const forward = matrix ? new THREE.Vector3().setFromMatrixColumn(matrix, 2).normalize() : new THREE.Vector3(0, 0, -1);
  return { up, direction: right.multiplyScalar(0.7).addScaledVector(up, 0.55).addScaledVector(forward, -1).normalize() };
}

function framingBounds(includeShown) {
  const bounds = referenceBounds?.clone() || new THREE.Box3();
  for (const pose of referencePoses()) {
    const point = posePosition(pose);
    if (point) bounds.expandByPoint(point);
  }
  if (includeShown) for (const panel of panels) {
    if (panel.bounds) bounds.union(panel.bounds);
    for (const pose of alignmentFor(panel.model)?.poses || []) {
      const point = posePosition(pose);
      if (point) bounds.expandByPoint(point);
    }
  }
  return bounds;
}

function fitView(includeShown = false, reset = false, chosenPanel = null) {
  if (!group || !panels.length) return;
  if (!elements.linked.checked && !chosenPanel) {
    for (const panel of panels) fitView(includeShown, reset, panel);
    return;
  }
  const bounds = framingBounds(includeShown);
  if (bounds.isEmpty()) return;
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.01);
  const leader = chosenPanel || panels[0];
  let direction;
  if (reset || !isFramed) {
    const home = resetUpAndDirection();
    setCameraUp(leader, home.up);
    direction = home.direction;
  } else {
    direction = leader.camera.position.clone().sub(leader.controls.target).normalize();
    if (direction.lengthSq() < 0.1) direction.set(1, 0.7, 1).normalize();
  }
  const verticalFov = THREE.MathUtils.degToRad(leader.camera.fov);
  const narrowestAspect = Math.min(...panels.map((panel) => panel.camera.aspect));
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * narrowestAspect);
  const distance = radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.12;
  leader.controls.target.copy(sphere.center);
  leader.camera.position.copy(sphere.center).addScaledVector(direction, distance);
  leader.camera.near = Math.max(radius / 10000, 0.00001);
  leader.camera.far = Math.max(distance + radius * 1000, 100);
  leader.camera.updateProjectionMatrix();
  leader.camera.lookAt(sphere.center);
  leader.controls.update();
  synchronizeFrom(leader);
  isFramed = true;
  selectedInput = null;
  updateSelectedInput();
}

function lookFromInput(index) {
  if (!panels.length) return;
  const pose = referencePoses()[index] || group.views[index]?.pose;
  const matrix = asMatrix(pose);
  if (!matrix) { showError('The reference pose for this input is unavailable.'); return; }
  const leader = elements.linked.checked ? panels[0] : (lastActivePanel || panels[0]);
  const forward = new THREE.Vector3().setFromMatrixColumn(matrix, 2).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(matrix, 1).negate().normalize();
  leader.camera.position.setFromMatrixPosition(matrix);
  setCameraUp(leader, up);
  leader.controls.target.copy(leader.camera.position).addScaledVector(forward, Math.max(sceneRadius() * 0.65, 0.1));
  leader.camera.near = Math.max(sceneRadius() / 10000, 0.00001);
  leader.camera.far = Math.max(sceneRadius() * 1000, 100);
  leader.camera.updateProjectionMatrix();
  leader.camera.lookAt(leader.controls.target);
  leader.controls.update();
  synchronizeFrom(leader);
  selectedInput = index;
  updateSelectedInput();
}

function updateSelectedInput() {
  elements.inputs.querySelectorAll('.input-card').forEach((button, index) => button.setAttribute('aria-pressed', String(index === selectedInput)));
  for (const panel of panels) if (group) refreshGlyphs(panel);
  requestRender();
}

function buildInputs() {
  elements.inputs.replaceChildren();
  const views = group.views || [];
  views.forEach((view, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'input-card';
    button.setAttribute('aria-label', `Input ${index + 1}: ${view.id}, ${view.mode}. Look from its reference camera.`);
    button.setAttribute('aria-pressed', 'false');
    const imageWrap = document.createElement('span');
    imageWrap.className = 'image-wrap';
    const image = document.createElement('img');
    image.alt = `${view.id} ${view.mode} input`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    const imageError = () => {
      const fallback = document.createElement('span');
      fallback.className = 'image-fallback';
      fallback.textContent = 'Input image unavailable';
      imageWrap.replaceChildren(fallback);
    };
    image.addEventListener('error', imageError, { once: true });
    try { image.src = localURL(view.image).href; imageWrap.append(image); }
    catch { imageError(); }
    const caption = document.createElement('span');
    caption.className = 'input-caption';
    for (const [className, text] of [['input-index', String(index + 1).padStart(2, '0')], ['input-id', view.id], ['input-mode', view.mode]]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      caption.append(span);
    }
    button.append(imageWrap, caption);
    button.addEventListener('click', () => lookFromInput(index));
    elements.inputs.append(button);
  });
  $('input-order').textContent = `Input order: ${views.map((view) => view.id).join(' → ')}${group.k ? ` · K = ${group.k}` : ''}`;
}

function formatMetric(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function buildMetrics() {
   $('room-metrics-section').hidden = true;
   elements.metrics.replaceChildren();
   for (const metric of group.metrics || []) {
     const row=document.createElement('tr'); row.dataset.model=metric.model;
     for(const value of [modelLabel(metric.model),formatMetric(metric.AUC30,1)]) {const cell=document.createElement('td');cell.textContent=value;row.append(cell);}
     elements.metrics.append(row);
   }
   const section=elements.metrics.closest('section'); if(section) section.hidden=!(group.metrics || []).length;
   updateMetricSelection();
 }
 
function updateMetricSelection() {
  const selected = panels.map((panel) => panel.select.value);
  elements.metrics.querySelectorAll('tr[data-model]').forEach((row) => row.classList.toggle('selected-method', selected.includes(row.dataset.model)));
}

function updateAlignmentText() {
  const sim3 = elements.alignment.value === 'sim3';
  const centres = elements.alignment.value === 'centres';
  $('alignment-caption').textContent = sim3 ? 'One point-correspondence Sim(3) per tuple, for display only' : centres ? 'One camera-centre Sim(3) per tuple, for display only' : 'One first-camera rigid transform; scale unchanged';
  const note = group?.display_alignment_note;
  const suppliedNote = typeof note === 'string' ? note : note?.[elements.alignment.value] || '';
}

function updateModelOptions() {
  const keys = Object.keys(group.models || {}).sort((a, b) => {
    const ai = modelOrder.indexOf(a); const bi = modelOrder.indexOf(b);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  for (const side of ['left', 'right']) {
    const select = $(`${side}-model`);
    const previous = select.value || (side === 'left' ? 'Reference' : 'MEOW');
    select.replaceChildren();
    for (const id of keys) {
      const model = group.models[id];
      if (!model.alignments?.[elements.alignment.value]) continue;
      if (elements.alignment.value === 'raw' && id !== 'Reference' && model.metric === false) continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = modelLabel(id);
      select.append(option);
    }
    const available = Array.from(select.options).map((option) => option.value);
    const preferred = side === 'left' ? 'Reference' : 'MEOW';
    select.value = available.includes(previous) ? previous : available.includes(preferred) ? preferred : available[0] || '';
    select.disabled = !available.length;
  }
  updateMetricSelection();
}

async function loadComparison(reset = true) {
  if (!group || graphicsError) return;
  const version = groupVersion;
  const mode = elements.alignment.value;
  referenceBounds = null;
  const pendingPanels = panels.map(loadPanel);
  try {
    const data = await loadCloud(alignmentFor('Reference')?.cloud);
    if (version !== groupVersion || mode !== elements.alignment.value) return;
    referenceBounds = data.bounds.clone();
    for (const panel of panels) refreshGlyphs(panel);
    if (reset) fitView(false, true);
  } catch (error) {
    if (error.name !== 'AbortError' && version === groupVersion && mode === elements.alignment.value) {
      showError(`Reference framing is unavailable. ${error.message} You can use Fit all shown after a model loads.`);
    }
  }
  await Promise.allSettled(pendingPanels);
  if (!referenceBounds && version === groupVersion && mode === elements.alignment.value) fitView(true, true);
}

function orderedGroups(dataset) {
  const entries = [...(catalog?.[dataset] || [])];
  if (dataset === 'real') {
    const order = ['M1','M2','M3','M4','D1','D2','D3','D4','D5'];
    entries.sort((a, b) => {
      const ai = order.indexOf(a.id); const bi = order.indexOf(b.id);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  return entries;
}

function populateGroups(preferred) {
  const entries = orderedGroups(elements.dataset.value);
  elements.group.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = `${entry.label || entry.id} · K=${entry.k} · ${entry.category || ""}`;
    elements.group.append(option);
  }
  if (entries.some((entry) => entry.id === preferred)) elements.group.value = preferred;
  elements.group.disabled = !entries.length;
  if (!entries.length) showError('No tuples are supplied for this dataset.');
}

async function loadGroup() {
  const id = elements.group.value;
  if (!id) return;
  const version = ++groupVersion;
  groupController?.abort();
  groupController = new AbortController();
  cloudCache = new Map();
  group = null;
  referenceBounds = null;
  isFramed = false;
  selectedInput = null;
  showError('');
  $('tuple-label').textContent = id;
  $('tuple-summary').textContent = 'Loading tuple…';
  
  elements.inputs.replaceChildren();
  elements.metrics.replaceChildren();
  const loadingRow = document.createElement('tr');
  const loadingCell = document.createElement('td');
  loadingCell.colSpan = 6;
  loadingCell.textContent = 'Loading measurements…';
  loadingRow.append(loadingCell);
  elements.metrics.append(loadingRow);
  $('input-order').textContent = '';
  for (const panel of panels) {
    panel.loadVersion++;
    clearPanel(panel);
    panelState(panel, 'Loading tuple…');
    panel.select.disabled = true;
  }
  const query = new URLSearchParams(location.search);
  query.set('dataset', elements.dataset.value);
  query.set('group', id);
  history.replaceState(null, '', `${location.pathname}?${query.toString()}${location.hash}`);
  try {
    const data = await readJSON(`data/groups/${encodeURIComponent(id)}.json`, groupController.signal);
    if (version !== groupVersion) return;
    group = data;
    if (!group.models || !Array.isArray(group.views)) throw new Error('The tuple metadata is incomplete.');
    const oldMode = elements.alignment.value;
    elements.alignment.replaceChildren();
    for (const [id, label] of [['sim3','Point-correspondence Sim(3)'],['centres','Camera-centre Sim(3)']]) {
      if (!group.models.Reference?.alignments?.[id]) continue;
      const option = document.createElement('option'); option.value=id; option.textContent=label;elements.alignment.append(option);
    }
    elements.alignment.value = group.models.Reference.alignments[oldMode] ? oldMode : 'sim3';
    const modeCounts = new Map();
    for (const view of group.views) modeCounts.set(view.mode, (modeCounts.get(view.mode) || 0) + 1);
    $('tuple-label').textContent = group.label || id;
    const modes={panorama:0,fisheye:0,perspective:0}; for (const v of group.views) modes[/panorama/i.test(v.mode)?'panorama':/fisheye|gopro/i.test(v.mode)?'fisheye':'perspective']++; $('tuple-summary').textContent=`K = ${group.k} · `+Object.entries(modes).filter(([k,n])=>n).map(([k,n])=>`${n} ${k}`).join(' + ');
    
    
    buildInputs();
    updateModelOptions();
    updateAlignmentText();
    buildMetrics();
    await loadComparison();
    window.dispatchEvent(new CustomEvent('comparison-group-loaded', { detail: { dataset: elements.dataset.value, group: id } }));
    if (graphicsError) showError(graphicsError);
  } catch (error) {
    if (error.name === 'AbortError' || version !== groupVersion) return;
    showError(`This tuple could not be loaded. ${error.message}`);
    $('tuple-summary').textContent = 'Tuple unavailable';
    for (const panel of panels) panelState(panel, 'Tuple data is unavailable. Choose another tuple or reload the page.');
  }
}

async function initialize() {
  try {
    panels.push(createPanel('left'));
    panels.push(createPanel('right'));
    const resizeObserver = new ResizeObserver(resizePanels);
    panels.forEach((panel) => resizeObserver.observe(panel.viewport));
    resizePanels();
  } catch (error) {
    graphicsError = 'The 3D viewer requires WebGL. Enable graphics acceleration or use another browser; input images and measurements are still available below.';
    for (const side of ['left', 'right']) {
      $(`${side}-state`).textContent = graphicsError;
      $(`${side}-state`).classList.add('error');
    }
    showError(graphicsError);
  }
  elements.dataset.addEventListener('change', () => { populateGroups(); loadGroup(); });
  window.addEventListener('choose-reconstruction', event => {
    const {dataset, group: id} = event.detail;
    if (!catalog?.[dataset]) return;
    elements.dataset.value = dataset; populateGroups(id); loadGroup();
  });
  elements.group.addEventListener('change', loadGroup);
  elements.alignment.addEventListener('change', () => {
    if (!group) return;
    selectedInput = null;
    showError(graphicsError || '');
    updateModelOptions();
    updateAlignmentText();
    updateSelectedInput();
    loadComparison();
  });
  $('reset-view').addEventListener('click', () => fitView(false, true));
  $('fit-reference').addEventListener('click', () => fitView(false));
  $('fit-all').addEventListener('click', () => fitView(true));
  elements.predicted.addEventListener('change', () => {
    for (const panel of panels) if (panel.predictedGlyphs) panel.predictedGlyphs.visible = elements.predicted.checked;
    requestRender();
  });
  elements.reference.addEventListener('change', () => {
    for (const panel of panels) if (panel.referenceGlyphs) panel.referenceGlyphs.visible = elements.reference.checked;
    requestRender();
  });
  elements.linked.addEventListener('change', () => {
    document.querySelectorAll('.linked-badge').forEach(x => { x.textContent = elements.linked.checked ? 'Linked view' : 'Independent view'; });
    if (elements.linked.checked && panels.length) synchronizeFrom(lastActivePanel || panels[0]);
    requestRender();
  });
  elements.colours.addEventListener('change', () => { panels.forEach(refreshColour); requestRender(); });
  elements.density.addEventListener('input', () => {
    $('point-density-value').value = `${elements.density.value}%`;
    panels.forEach(applyDensity); requestRender();
  });
  elements.pointSize.addEventListener('input', () => {
    const size = Number(elements.pointSize.value);
    $('point-size-value').value = `${size} px`;
    for (const panel of panels) if (panel.cloud) panel.cloud.material.size = size;
    requestRender();
  });
  try {
    catalog = await readJSON('data/catalog.json');
    const query = new URLSearchParams(location.search);
    elements.dataset.value = ['real','rooms'].includes(query.get('dataset')) ? query.get('dataset') : 'real';
    populateGroups(query.get('group'));
    await loadGroup();
  } catch (error) {
    showError(`The tuple catalog could not be loaded. ${error.message} Serve this folder through a local web server; browsers cannot load the 3D data from a file:// URL.`);
    $('tuple-label').textContent = 'Catalog unavailable';
    $('tuple-summary').textContent = '';
    for (const panel of panels) panelState(panel, 'The tuple catalog is unavailable.');
  }
}

initialize();
