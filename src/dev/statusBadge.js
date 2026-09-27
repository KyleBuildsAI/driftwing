// Dev status badge: backend, three.js revision, fps, a frametime graph against the frame target,
// render scale and quality level, draw statistics and the detected input devices.
//
// Shown while settings.devBadge is on, and always with ?debug=1. It replaces v1's small FPS badge
// while it is visible (it shows everything that one did). Samples are only recorded while the
// badge is visible; the graph redraws at GRAPH_HZ, text lines at TEXT_HZ.

const GRAPH_SECONDS = 3;
const GRAPH_WIDTH = 216;
const GRAPH_HEIGHT = 46;
const GRAPH_HZ = 12;
const TEXT_HZ = 4;
const SAMPLE_CAPACITY = 2048;
const DEVICE_KIND_LABELS = Object.freeze({
  'hotas-stick': 'Stick',
  'hotas-throttle': 'Throttle',
  gamepad: 'Gamepad',
  keyboard: 'Keyboard',
  mouse: 'Mouse',
  touch: 'Touch',
});

function formatCount(value) {
  const number = Number(value) || 0;
  if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (number >= 1e4) return `${(number / 1e3).toFixed(1)}k`;
  return String(Math.round(number));
}

function capitalize(text) {
  const value = String(text || '');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/**
 * Builds the badge inside root (#ui-root). readRenderStats is deferred to a microtask because
 * renderer.info resets at the start of every animation tick, before the systems update.
 */
export function createStatusBadge({ ctx, root, forced = false }) {
  const { state, settings, bus, renderer, THREE } = ctx;
  const element = document.createElement('div');
  element.className = 'dw-devbadge glass';
  element.id = 'dw-devbadge';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-label', 'Developer status');
  element.innerHTML = [
    '<div class="dw-devbadge-head"><span class="dw-micro dw-gold">Dev</span><span class="dw-devbadge-backend" data-field="backend"></span></div>',
    '<div class="dw-devbadge-fps"><span data-field="fps">0</span><span class="dw-debug-unit">fps</span><span class="dw-devbadge-ms" data-field="ms"></span></div>',
    `<canvas class="dw-devbadge-graph" width="${GRAPH_WIDTH}" height="${GRAPH_HEIGHT}" aria-hidden="true"></canvas>`,
    '<div class="dw-devbadge-legend"><span data-field="target"></span><span>last 3 s</span></div>',
    '<div class="dw-debug-line" data-field="scale"></div>',
    '<div class="dw-debug-line" data-field="draws"></div>',
    '<div class="dw-debug-line" data-field="chunks"></div>',
    '<div class="dw-devbadge-devices"><span class="dw-micro">Input</span><ul data-field="devices"></ul></div>',
  ].join('');
  root.append(element);

  const fields = {};
  for (const node of element.querySelectorAll('[data-field]')) fields[node.dataset.field] = node;
  const canvas = element.querySelector('canvas');
  const graph = canvas.getContext('2d');
  if (!graph) throw new Error('DRIFTWING dev badge: 2D canvas context unavailable.');

  const samples = new Float32Array(SAMPLE_CAPACITY);
  let sampleCursor = 0;
  let sampleCount = 0;
  let visible = false;
  let graphTimer = 0;
  let textTimer = 0;
  let pixelRatio = 0;
  let devicesKey = '';

  function isWanted() {
    return forced || Boolean(settings.get('devBadge'));
  }

  function resizeCanvas() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (ratio === pixelRatio) return;
    pixelRatio = ratio;
    canvas.width = Math.round(GRAPH_WIDTH * ratio);
    canvas.height = Math.round(GRAPH_HEIGHT * ratio);
    canvas.style.width = `${GRAPH_WIDTH}px`;
    canvas.style.height = `${GRAPH_HEIGHT}px`;
  }

  function applyVisibility() {
    const next = isWanted();
    if (next === visible) return;
    visible = next;
    root.classList.toggle('dw-devbadge-on', visible);
    element.setAttribute('aria-hidden', String(!visible));
    if (visible) {
      sampleCount = 0;
      graphTimer = 0;
      textTimer = 0;
      devicesKey = '';
      resizeCanvas();
    }
  }

  function recordSample(frameMs) {
    if (!(frameMs > 0)) return;
    samples[sampleCursor] = frameMs;
    sampleCursor = (sampleCursor + 1) % SAMPLE_CAPACITY;
    sampleCount = Math.min(sampleCount + 1, SAMPLE_CAPACITY);
  }

  /** Adds one rect per recorded frame to the current path, newest at the right edge. */
  function traceBars(width, height, ceilingMs, inset) {
    const pixelsPerMs = width / (GRAPH_SECONDS * 1000);
    let right = width;
    let index = sampleCursor;
    graph.beginPath();
    for (let drawn = 0; drawn < sampleCount && right > 0; drawn++) {
      index = (index - 1 + SAMPLE_CAPACITY) % SAMPLE_CAPACITY;
      const frameMs = samples[index];
      const barWidth = Math.max(frameMs * pixelsPerMs, 0.5);
      const barHeight = Math.min(frameMs / ceilingMs, 1) * (height - inset);
      graph.rect(right - barWidth, height - barHeight, barWidth, barHeight);
      right -= barWidth;
    }
  }

  /** Frame times over the last GRAPH_SECONDS with the frame target as a dashed line. */
  function drawGraph() {
    const width = canvas.width;
    const height = canvas.height;
    const ratio = pixelRatio || 1;
    const inset = 2 * ratio;
    graph.clearRect(0, 0, width, height);
    const targetMs = Number(state.perf.targetMs) || 0;
    const ceilingMs = Math.max(targetMs > 0 ? targetMs * 2.5 : 40, 12);
    traceBars(width, height, ceilingMs, inset);
    graph.fillStyle = 'rgba(184, 230, 176, 0.55)';
    graph.fill();
    if (!(targetMs > 0)) return;
    // Frames above the target line are drawn again in the warning colour.
    const targetY = height - Math.min(targetMs / ceilingMs, 1) * (height - inset);
    graph.save();
    graph.beginPath();
    graph.rect(0, 0, width, targetY);
    graph.clip();
    traceBars(width, height, ceilingMs, inset);
    graph.fillStyle = 'rgba(242, 163, 126, 0.85)';
    graph.fill();
    graph.restore();
    graph.lineWidth = Math.max(1, ratio);
    graph.strokeStyle = 'rgba(243, 199, 122, 0.95)';
    graph.setLineDash([4 * ratio, 3 * ratio]);
    graph.beginPath();
    graph.moveTo(0, targetY + 0.5);
    graph.lineTo(width, targetY + 0.5);
    graph.stroke();
    graph.setLineDash([]);
  }

  function readDevices() {
    const input = ctx.systems.input;
    if (!input || typeof input.getDevices !== 'function') return [];
    const list = input.getDevices();
    if (!Array.isArray(list)) return [];
    return list.filter((device) => device && typeof device === 'object' && device.connected !== false);
  }

  function renderDevices() {
    const devices = readDevices();
    const key = devices.map((device) => `${device.deviceKey}|${device.kind}|${device.name}`).join(';');
    if (key === devicesKey && fields.devices.childElementCount > 0) return;
    devicesKey = key;
    fields.devices.replaceChildren();
    if (devices.length === 0) {
      const item = document.createElement('li');
      item.className = 'dw-devbadge-empty';
      item.textContent = 'no controllers';
      fields.devices.append(item);
      return;
    }
    for (const device of devices) {
      const item = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'dw-devbadge-kind';
      kind.textContent = DEVICE_KIND_LABELS[device.kind] || capitalize(device.kind || 'device');
      const name = document.createElement('span');
      name.className = 'dw-devbadge-name';
      name.textContent = String(device.name || device.deviceKey || 'unnamed');
      item.title = String(device.deviceKey || device.name || '');
      item.append(kind, name);
      fields.devices.append(item);
    }
  }

  function readRenderStats() {
    const info = renderer.info.render;
    const drawCalls = info.drawCalls ?? info.calls ?? 0;
    fields.draws.textContent = `${drawCalls} draws · ${formatCount(info.triangles)} tris`;
  }

  function renderText() {
    const perf = state.perf;
    const fps = Math.round(Number(perf.fps) || 0);
    fields.fps.textContent = String(fps);
    fields.ms.textContent = `${(Number(perf.frameMs) || 0).toFixed(1)} ms`;
    const targetHz = Number(perf.targetHz) || 0;
    element.classList.toggle('dw-fps-ok', targetHz > 0 && fps < targetHz * 0.92 && fps >= targetHz * 0.7);
    element.classList.toggle('dw-fps-low', targetHz > 0 ? fps < targetHz * 0.7 : fps < 30);
    fields.backend.textContent = `${ctx.backend} · r${THREE.REVISION}`;
    const refresh = perf.refreshHz ? `display ${perf.refreshHz} Hz` : 'display unmeasured';
    fields.target.textContent = targetHz ? `target ${targetHz} Hz · ${refresh}` : `uncapped · ${refresh}`;
    const quality = ctx.quality || {};
    const scale = Number(perf.renderScale) || 1;
    const dynamic = settings.get('dynamicResolution') ? '' : ' (fixed)';
    fields.scale.textContent = `scale ${scale.toFixed(2)}×${dynamic} · ${capitalize(quality.name || 'auto')}${quality.auto ? ' (auto)' : ''}`;
    const terrainStats = ctx.systems.terrain?.getStats?.();
    if (terrainStats && typeof terrainStats === 'object') {
      const queued = Number(terrainStats.pending) || 0;
      fields.chunks.textContent = `${Number(terrainStats.chunks) || 0} chunks${queued ? ` · ${queued} queued` : ''}`;
    } else {
      fields.chunks.textContent = 'terrain stats unavailable';
    }
    renderDevices();
    queueMicrotask(readRenderStats);
  }

  bus.on('settings:changed', (payload) => {
    if (payload && (payload.key === 'devBadge' || payload.key === 'dynamicResolution')) {
      applyVisibility();
      textTimer = 0;
    }
  });
  bus.onTyped('deviceConnected', () => { textTimer = 0; });
  bus.onTyped('deviceDisconnected', () => { textTimer = 0; });
  bus.on('quality:changed', () => { textTimer = 0; });
  bus.on('resize', resizeCanvas);
  applyVisibility();

  return {
    /** Per frame: records the last frame time and redraws at a reduced rate. */
    update(step, photoActive) {
      if (!visible) return;
      recordSample(Number(state.perf.lastFrameMs) || 0);
      if (photoActive) return;
      graphTimer -= step;
      if (graphTimer <= 0) {
        graphTimer = 1 / GRAPH_HZ;
        drawGraph();
      }
      textTimer -= step;
      if (textTimer <= 0) {
        textTimer = 1 / TEXT_HZ;
        renderText();
      }
    },
    isVisible: () => visible,
  };
}
