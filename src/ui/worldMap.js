// World map (M, the bindable 'mapToggle' action): a large glass panel over the flight, which carries
// on behind it like behind every other panel. It shows the terrain as shaded-relief tiles from the
// map-tile worker (src/world/mapTiles.js: the shared height and biome functions, generated off the
// main thread and cached), the discovered sites as category icons (undiscovered ones never appear),
// the Phase 1 landmarks found, this flight's trail, the craft's position and heading, and the current
// waypoint.
//
// Click or tap to set a waypoint there through the waypoint system (on a site's icon it takes the
// site's name). Drag to pan, wheel or pinch to zoom; with the map focused, the arrow keys pan, + and -
// zoom, 0 follows the craft again and Enter sets a waypoint at the centre. Those keys stay in the map;
// every other key still flies.
//
// The trail is recorded all flight long, map open or not, into a fixed ring of points (no allocation
// per frame). Drawing happens only while the map is open, at most 30 times a second.
import './worldMap.css';
import { createMapTileService } from '../world/mapTiles.js';
import { DISCOVERY_ICONS, discoveryIcon } from './categoryIcons.js';
import { distanceParts, formatCoordinates } from './journalFormat.js';

/** Samples per tile side, and the smallest tile (level 0) in metres; each level doubles it. */
const TILE_RESOLUTION = 128;
const BASE_TILE_METRES = 1000;
const MAX_LEVEL = 8;
/** Zoom limits and the opening zoom, in metres per CSS pixel. */
const MIN_METRES_PER_PIXEL = 2.5;
const MAX_METRES_PER_PIXEL = 420;
const DEFAULT_METRES_PER_PIXEL = 22;
/** Decoded tiles kept in memory (least recently drawn go first). */
const TILE_CACHE_LIMIT = 220;
/** Trail: fixed capacity (points), spacing (m), and the jump (m) that starts a new line. */
const TRAIL_CAPACITY = 6000;
const TRAIL_SPACING = 40;
const TRAIL_BREAK = 1500;
/** Icons: drawn radius, hit radius, glyph size (CSS px). */
const ICON_RADIUS = 13;
const ICON_HIT_RADIUS = 18;
const ICON_GLYPH = 16;
/** Pointer travel (CSS px) before a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 6;
const KEY_PAN_PIXELS = 110;
const KEY_ZOOM_FACTOR = 1.5;
const WHEEL_ZOOM_RATE = 0.0016;
const REDRAW_SECONDS = 1 / 30;
/** Scale bar lengths (m) to choose from; the bar is 70-150 px long. */
const SCALE_STEPS = Object.freeze([50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]);
const TILE_KEY_OFFSET = 2 ** 20;
const TILE_KEY_SPAN = 2 ** 21;
const WAYPOINT_DASH = Object.freeze([6, 6]);
const NO_DASH = Object.freeze([]);
const HEADING_NAMES = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
/** One number for a tile (no string per frame): level, then the tile indices offset to be positive. */
function tileKey(level, tileX, tileZ) {
  return (level * TILE_KEY_SPAN + (tileX + TILE_KEY_OFFSET)) * TILE_KEY_SPAN + (tileZ + TILE_KEY_OFFSET);
}
function tileSizeFor(level) {
  return BASE_TILE_METRES * 2 ** level;
}
/** The tile level whose tiles show about 256 px wide at this zoom. */
function levelFor(metresPerPixel) {
  return clamp(Math.round(Math.log2((metresPerPixel * 256) / BASE_TILE_METRES)), 0, MAX_LEVEL);
}
function compassName(bearing) {
  return HEADING_NAMES[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/**
 * Creates the world map panel inside root (#ui-root). ctx: the game context (state, bus, world,
 * worldOptions, systems.journal, systems.waypoints). toast(text, options): the UI's toast. Returns
 * { element, onOpen(), onClose(), update(step), isOpen(), getState(), clientPointFor(x, z),
 * centerOn(x, z, metresPerPixel?), follow(), refreshSites(), dispose() }.
 */
export function createWorldMap({ root, ctx, toast }) {
  const { state, bus } = ctx;
  const element = document.createElement('section');
  element.className = 'dw-panel glass dw-map';
  element.id = 'dw-panel-map';
  element.dataset.panel = 'map';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-labelledby', 'dw-map-title');
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = [
    '<header class="dw-panel-head">',
    '<div><div class="dw-micro" id="dw-map-seed">Seed</div><h2 id="dw-map-title">World map</h2></div>',
    '<div class="dw-map-tools">',
    '<button type="button" class="dw-text-button" data-action="copy-link" aria-label="Copy a link to this world"><svg class="dw-icon"><use href="#dw-i-link"/></svg><span>Copy link</span></button>',
    '<button type="button" class="dw-icon-button" data-action="close-panel" aria-label="Close map"><svg class="dw-icon"><use href="#dw-i-close"/></svg></button>',
    '</div>',
    '</header>',
    '<div class="dw-map-view" tabindex="0" aria-describedby="dw-map-help">',
    '<canvas class="dw-map-canvas" aria-hidden="true"></canvas>',
    '<div class="dw-map-zoom glass">',
    '<button type="button" class="dw-icon-button dw-small" data-map-action="zoom-in" aria-label="Zoom in">+</button>',
    '<button type="button" class="dw-icon-button dw-small" data-map-action="zoom-out" aria-label="Zoom out">&minus;</button>',
    '<button type="button" class="dw-icon-button dw-small" data-map-action="follow" aria-label="Follow the craft" aria-pressed="true"><svg class="dw-icon"><use href="#dw-i-autopilot"/></svg></button>',
    '</div>',
    '<div class="dw-map-readout" aria-live="polite"></div>',
    '<div class="dw-map-scale" aria-hidden="true"><i></i><span></span></div>',
    '<div class="dw-map-status" hidden></div>',
    '</div>',
    '<footer class="dw-map-foot">',
    '<span class="dw-map-count"></span>',
    '<span class="dw-map-help" id="dw-map-help">Click to set a waypoint · Drag to pan · Wheel to zoom · Arrows, + / − and 0 when focused</span>',
    '</footer>',
  ].join('');
  root.append(element);

  const dom = {
    seed: element.querySelector('#dw-map-seed'),
    view: element.querySelector('.dw-map-view'),
    canvas: element.querySelector('.dw-map-canvas'),
    readout: element.querySelector('.dw-map-readout'),
    scaleBar: element.querySelector('.dw-map-scale i'),
    scaleLabel: element.querySelector('.dw-map-scale span'),
    status: element.querySelector('.dw-map-status'),
    count: element.querySelector('.dw-map-count'),
    follow: element.querySelector('[data-map-action="follow"]'),
  };
  const context = dom.canvas.getContext('2d');
  if (!context) throw new Error('DRIFTWING map: this browser has no 2D canvas.');

  const tiles = createMapTileService({ seed: state.seed, worldOptions: ctx.worldOptions });
  const tileCache = new Map();
  const iconPaths = new Map(Object.entries(DISCOVERY_ICONS).map(([key, icon]) => [key, icon.paths.map((data) => new Path2D(data))]));
  const playerArrow = new Path2D('M0 -12 L7.5 8.5 L0 4.5 L-7.5 8.5 Z');
  const view = { centerX: state.player.position.x, centerZ: state.player.position.z, metresPerPixel: DEFAULT_METRES_PER_PIXEL, follow: true, width: 0, height: 0, dpr: 1 };
  const trail = { points: new Float32Array(TRAIL_CAPACITY * 2), head: 0, count: 0, lastX: NaN, lastZ: NaN };
  const pointers = new Map();
  const gesture = { mode: 'none', startX: 0, startY: 0, moved: false, pinchDistance: 0, lastX: 0, lastY: 0 };
  const hover = { active: false, x: 0, y: 0, text: '' };
  let sites = [];
  let open = false;
  let dirty = true;
  let drawTimer = 0;
  let drawSerial = 0;
  let scaleText = '';
  let tilesFailedReported = false;

  // ---- Coordinates ----------------------------------------------------------------------------
  function screenX(worldX) {
    return (worldX - view.centerX) / view.metresPerPixel + view.width / 2;
  }
  function screenY(worldZ) {
    return (worldZ - view.centerZ) / view.metresPerPixel + view.height / 2;
  }
  function worldXAt(pixelX) {
    return view.centerX + (pixelX - view.width / 2) * view.metresPerPixel;
  }
  function worldZAt(pixelY) {
    return view.centerZ + (pixelY - view.height / 2) * view.metresPerPixel;
  }
  function localPoint(event) {
    const rect = dom.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  // ---- Sites and landmarks (the journal: discovered ones only) --------------------------------
  /** Rebuilds the drawn sites from the journal: sites among the spawn discoveries, and landmarks. */
  function refreshSites() {
    const data = ctx.systems.journal?.getData?.();
    const next = [];
    if (data && typeof data === 'object') {
      for (const entry of data.spawnsFound ?? []) {
        if (entry.kind !== 'site') continue;
        next.push({ x: entry.x, z: entry.z, icon: entry.category, color: discoveryIcon(entry.category).color, name: entry.name, kind: 'site' });
      }
      for (const entry of data.landmarksFound ?? []) {
        next.push({ x: entry.x, z: entry.z, icon: entry.type, color: discoveryIcon(entry.type).color, name: entry.name, kind: 'landmark' });
      }
    }
    sites = next;
    const siteCount = next.filter((site) => site.kind === 'site').length;
    const landmarkCount = next.length - siteCount;
    dom.count.textContent = `${siteCount} ${siteCount === 1 ? 'site' : 'sites'} · ${landmarkCount} ${landmarkCount === 1 ? 'landmark' : 'landmarks'} discovered`;
    dirty = true;
  }

  /** The site whose icon is under a canvas point, or null. */
  function siteAt(pixelX, pixelY) {
    let best = null;
    let bestDistance = ICON_HIT_RADIUS;
    for (const site of sites) {
      const distance = Math.hypot(screenX(site.x) - pixelX, screenY(site.z) - pixelY);
      if (distance <= bestDistance) {
        best = site;
        bestDistance = distance;
      }
    }
    return best;
  }

  // ---- Trail ----------------------------------------------------------------------------------
  function pushTrail(x, z) {
    const index = trail.head * 2;
    trail.points[index] = x;
    trail.points[index + 1] = z;
    trail.head = (trail.head + 1) % TRAIL_CAPACITY;
    if (trail.count < TRAIL_CAPACITY) trail.count++;
  }
  function breakTrail() {
    if (trail.count > 0 && !Number.isNaN(trail.lastX)) pushTrail(NaN, NaN);
    trail.lastX = NaN;
    trail.lastZ = NaN;
  }
  function recordTrail() {
    const position = state.player.position;
    const x = position.x;
    const z = position.z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (Number.isNaN(trail.lastX)) {
      pushTrail(x, z);
      trail.lastX = x;
      trail.lastZ = z;
      return;
    }
    const dx = x - trail.lastX;
    const dz = z - trail.lastZ;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < TRAIL_SPACING * TRAIL_SPACING) return;
    if (distanceSq > TRAIL_BREAK * TRAIL_BREAK) pushTrail(NaN, NaN);
    pushTrail(x, z);
    trail.lastX = x;
    trail.lastZ = z;
    if (open) dirty = true;
  }

  // ---- Tiles ----------------------------------------------------------------------------------
  function evictTiles() {
    if (tileCache.size <= TILE_CACHE_LIMIT) return;
    const ready = [];
    for (const [key, entry] of tileCache) if (entry.status === 'ready') ready.push([key, entry]);
    ready.sort((first, second) => first[1].usedAt - second[1].usedAt);
    for (let index = 0; index < ready.length && tileCache.size > TILE_CACHE_LIMIT; index++) {
      const [key, entry] = ready[index];
      if (entry.usedAt === drawSerial) break;
      entry.bitmap.close();
      tileCache.delete(key);
    }
  }

  function reportTileFailure(error) {
    if (tilesFailedReported) return;
    tilesFailedReported = true;
    console.error('[DRIFTWING] a map tile could not be decoded', error);
  }

  function requestTile(level, tileX, tileZ, key, priority) {
    const size = tileSizeFor(level);
    const entry = { status: 'pending', bitmap: null, usedAt: drawSerial, level };
    tileCache.set(key, entry);
    tiles.request({ x: tileX * size, z: tileZ * size, size, resolution: TILE_RESOLUTION, fields: ['color'] }, { priority }).then((tile) => {
      if (tileCache.get(key) !== entry) return null;
      if (!tile) {
        tileCache.delete(key);
        return null;
      }
      return createImageBitmap(new ImageData(tile.color, TILE_RESOLUTION, TILE_RESOLUTION)).then((bitmap) => {
        if (tileCache.get(key) !== entry) {
          bitmap.close();
          return;
        }
        entry.bitmap = bitmap;
        entry.status = 'ready';
        dirty = true;
        evictTiles();
      });
    }).catch((error) => {
      tileCache.delete(key);
      reportTileFailure(error);
    });
  }

  /** Re-ranks the queued tiles around the view and drops the ones that left it. */
  function reprioritizeTiles(level) {
    const size = tileSizeFor(level);
    const marginX = view.width * view.metresPerPixel;
    const marginZ = view.height * view.metresPerPixel;
    tiles.reprioritize((spec) => {
      if (spec.size !== size) return null;
      const centreX = spec.x + spec.size / 2;
      const centreZ = spec.z + spec.size / 2;
      if (Math.abs(centreX - view.centerX) > marginX || Math.abs(centreZ - view.centerZ) > marginZ) return null;
      return Math.hypot(centreX - view.centerX, centreZ - view.centerZ) / size;
    });
    for (const [key, entry] of tileCache) {
      if (entry.status === 'pending' && entry.level !== level) {
        // Its request was dropped (or will resolve for nothing); forget it so it can come back.
        tileCache.delete(key);
      }
    }
  }

  /** Draws the part of a coarser, ready tile that covers the missing tile, if one is cached. */
  function drawFallback(level, tileX, tileZ, left, top, pixelSize) {
    const size = tileSizeFor(level);
    for (let parentLevel = level + 1; parentLevel <= Math.min(MAX_LEVEL, level + 3); parentLevel++) {
      const parentSize = tileSizeFor(parentLevel);
      const parentX = Math.floor((tileX * size) / parentSize);
      const parentZ = Math.floor((tileZ * size) / parentSize);
      const parent = tileCache.get(tileKey(parentLevel, parentX, parentZ));
      if (!parent || parent.status !== 'ready') continue;
      parent.usedAt = drawSerial;
      const scale = TILE_RESOLUTION / parentSize;
      const sourceX = (tileX * size - parentX * parentSize) * scale;
      const sourceZ = (tileZ * size - parentZ * parentSize) * scale;
      const sourceSize = size * scale;
      context.drawImage(parent.bitmap, sourceX, sourceZ, sourceSize, sourceSize, left, top, pixelSize, pixelSize);
      return;
    }
  }

  function drawTiles() {
    const level = levelFor(view.metresPerPixel);
    const size = tileSizeFor(level);
    const pixelSize = size / view.metresPerPixel;
    const firstX = Math.floor(worldXAt(0) / size);
    const lastX = Math.floor(worldXAt(view.width) / size);
    const firstZ = Math.floor(worldZAt(0) / size);
    const lastZ = Math.floor(worldZAt(view.height) / size);
    const centreTileX = view.centerX / size - 0.5;
    const centreTileZ = view.centerZ / size - 0.5;
    let missing = 0;
    for (let tileZ = firstZ; tileZ <= lastZ; tileZ++) {
      for (let tileX = firstX; tileX <= lastX; tileX++) {
        const key = tileKey(level, tileX, tileZ);
        const left = Math.floor(screenX(tileX * size));
        const top = Math.floor(screenY(tileZ * size));
        // One extra pixel closes the hairline gaps between tiles at fractional zooms.
        const drawSize = Math.ceil(pixelSize) + 1;
        const entry = tileCache.get(key);
        if (entry && entry.status === 'ready') {
          entry.usedAt = drawSerial;
          context.drawImage(entry.bitmap, left, top, drawSize, drawSize);
          continue;
        }
        missing++;
        drawFallback(level, tileX, tileZ, left, top, drawSize);
        if (!entry) requestTile(level, tileX, tileZ, key, Math.hypot(tileX - centreTileX, tileZ - centreTileZ));
      }
    }
    return missing;
  }

  // ---- Overlays -------------------------------------------------------------------------------
  function drawTrail() {
    if (trail.count < 2) return;
    context.lineWidth = 2.4;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(255, 236, 196, 0.85)';
    context.shadowColor = 'rgba(12, 8, 16, 0.6)';
    context.shadowBlur = 3;
    context.beginPath();
    const start = (trail.head - trail.count + TRAIL_CAPACITY) % TRAIL_CAPACITY;
    let penDown = false;
    for (let step = 0; step < trail.count; step++) {
      const index = ((start + step) % TRAIL_CAPACITY) * 2;
      const x = trail.points[index];
      const z = trail.points[index + 1];
      if (Number.isNaN(x)) {
        penDown = false;
        continue;
      }
      if (penDown) context.lineTo(screenX(x), screenY(z));
      else context.moveTo(screenX(x), screenY(z));
      penDown = true;
    }
    context.lineTo(screenX(state.player.position.x), screenY(state.player.position.z));
    context.stroke();
    context.shadowBlur = 0;
  }

  function drawIcon(site) {
    const x = screenX(site.x);
    const y = screenY(site.z);
    if (x < -ICON_RADIUS || y < -ICON_RADIUS || x > view.width + ICON_RADIUS || y > view.height + ICON_RADIUS) return;
    context.save();
    context.translate(x, y);
    context.beginPath();
    context.arc(0, 0, ICON_RADIUS, 0, Math.PI * 2);
    context.fillStyle = 'rgba(22, 17, 28, 0.82)';
    context.fill();
    context.lineWidth = 1.6;
    context.strokeStyle = site.color;
    context.stroke();
    const scale = ICON_GLYPH / 24;
    context.scale(scale, scale);
    context.translate(-12, -12);
    context.lineWidth = 1.8;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const path of iconPaths.get(site.icon) ?? iconPaths.get('flightplay')) context.stroke(path);
    context.restore();
  }

  function drawWaypoint() {
    const waypoint = state.waypoint;
    if (!waypoint) return;
    const x = screenX(waypoint.x);
    const y = screenY(waypoint.z);
    context.setLineDash(WAYPOINT_DASH);
    context.lineWidth = 1.5;
    context.strokeStyle = 'rgba(243, 199, 122, 0.7)';
    context.beginPath();
    context.moveTo(screenX(state.player.position.x), screenY(state.player.position.z));
    context.lineTo(x, y);
    context.stroke();
    context.setLineDash(NO_DASH);
    context.beginPath();
    context.arc(x, y, 12, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(243, 199, 122, 0.95)';
    context.lineWidth = 2;
    context.stroke();
    context.beginPath();
    context.moveTo(x, y - 7);
    context.lineTo(x + 5, y);
    context.lineTo(x, y + 7);
    context.lineTo(x - 5, y);
    context.closePath();
    context.fillStyle = '#f3c77a';
    context.fill();
  }

  function drawPlayer() {
    const x = screenX(state.player.position.x);
    const y = screenY(state.player.position.z);
    context.save();
    context.translate(x, y);
    context.rotate((state.player.heading * Math.PI) / 180);
    context.shadowColor = 'rgba(10, 7, 14, 0.7)';
    context.shadowBlur = 6;
    context.fillStyle = '#fff4dc';
    context.fill(playerArrow);
    context.shadowBlur = 0;
    context.lineWidth = 1.6;
    context.strokeStyle = '#1b1420';
    context.stroke(playerArrow);
    context.restore();
  }

  function drawHover() {
    if (!hover.active) return;
    const site = siteAt(hover.x, hover.y);
    if (!site) return;
    const x = screenX(site.x);
    const y = screenY(site.z) - ICON_RADIUS - 8;
    context.font = '500 12.5px Inter, "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(16, 12, 20, 0.85)';
    context.strokeText(site.name, x, y);
    context.fillStyle = '#fffaf1';
    context.fillText(site.name, x, y);
  }

  function updateScaleBar() {
    let metres = SCALE_STEPS[0];
    for (const step of SCALE_STEPS) {
      if (step / view.metresPerPixel <= 150) metres = step;
    }
    const pixels = metres / view.metresPerPixel;
    const [value, unit] = distanceParts(metres);
    const text = `${value} ${unit}`;
    dom.scaleBar.style.width = `${Math.round(pixels)}px`;
    if (text !== scaleText) {
      scaleText = text;
      dom.scaleLabel.textContent = text;
    }
  }

  function draw() {
    drawSerial++;
    context.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    context.fillStyle = '#1c1722';
    context.fillRect(0, 0, view.width, view.height);
    context.imageSmoothingEnabled = true;
    const missing = drawTiles();
    drawTrail();
    for (const site of sites) drawIcon(site);
    drawWaypoint();
    drawPlayer();
    drawHover();
    updateScaleBar();
    const stats = tiles.stats();
    const status = stats.failed ? 'The terrain could not be drawn on this device.' : missing > 0 ? 'Charting the terrain…' : '';
    if (dom.status.textContent !== status) dom.status.textContent = status;
    dom.status.hidden = status === '';
    dirty = false;
  }

  function resize() {
    const rect = dom.view.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (width === view.width && height === view.height && dpr === view.dpr) return;
    view.width = width;
    view.height = height;
    view.dpr = dpr;
    dom.canvas.width = Math.round(width * dpr);
    dom.canvas.height = Math.round(height * dpr);
    dirty = true;
  }
  const resizeObserver = new ResizeObserver(() => {
    if (open) resize();
  });
  resizeObserver.observe(dom.view);

  // ---- View changes ---------------------------------------------------------------------------
  function setFollow(follow) {
    view.follow = follow;
    dom.follow.setAttribute('aria-pressed', String(follow));
    if (follow) {
      view.centerX = state.player.position.x;
      view.centerZ = state.player.position.z;
    }
    dirty = true;
  }
  function pan(pixelsX, pixelsY) {
    setFollow(false);
    view.centerX += pixelsX * view.metresPerPixel;
    view.centerZ += pixelsY * view.metresPerPixel;
    dirty = true;
  }
  /** Zooms by factor (above 1 zooms out), keeping the world point under (pixelX, pixelY) in place. */
  function zoomAt(factor, pixelX = view.width / 2, pixelY = view.height / 2) {
    const next = clamp(view.metresPerPixel * factor, MIN_METRES_PER_PIXEL, MAX_METRES_PER_PIXEL);
    if (next === view.metresPerPixel) return;
    const anchorX = worldXAt(pixelX);
    const anchorZ = worldZAt(pixelY);
    view.metresPerPixel = next;
    if (!view.follow) {
      view.centerX = anchorX - (pixelX - view.width / 2) * next;
      view.centerZ = anchorZ - (pixelY - view.height / 2) * next;
    }
    reprioritizeTiles(levelFor(next));
    dirty = true;
  }

  /** Sets the waypoint at a world point; on a site's icon it snaps there and takes the site's name. */
  function setWaypointAt(pixelX, pixelY) {
    const site = siteAt(pixelX, pixelY);
    const x = site ? site.x : worldXAt(pixelX);
    const z = site ? site.z : worldZAt(pixelY);
    const waypoints = ctx.systems.waypoints;
    if (!waypoints || typeof waypoints.set !== 'function') {
      toast('Waypoints are not available in this session.', { kind: 'warning', key: 'waypoint' });
      return null;
    }
    return waypoints.set({ x, z }, site ? site.name : 'Waypoint');
  }

  function updateReadout() {
    let text = '';
    if (hover.active) {
      const site = siteAt(hover.x, hover.y);
      const x = site ? site.x : worldXAt(hover.x);
      const z = site ? site.z : worldZAt(hover.y);
      const player = state.player.position;
      const distance = Math.hypot(x - player.x, z - player.z);
      const bearing = (Math.atan2(x - player.x, -(z - player.z)) * 180) / Math.PI;
      const [value, unit] = distanceParts(distance);
      text = `${site ? `${site.name} · ` : ''}${value} ${unit} ${compassName(bearing)} of you · ${formatCoordinates(x, z)}`;
    }
    if (text !== hover.text) {
      hover.text = text;
      dom.readout.textContent = text;
    }
  }

  // ---- Pointer, wheel and keyboard ------------------------------------------------------------
  dom.canvas.addEventListener('pointerdown', (event) => {
    const point = localPoint(event);
    pointers.set(event.pointerId, point);
    dom.canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 1) {
      gesture.mode = 'press';
      gesture.startX = point.x;
      gesture.startY = point.y;
      gesture.lastX = point.x;
      gesture.lastY = point.y;
      gesture.moved = false;
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      gesture.mode = 'pinch';
      gesture.moved = true;
      gesture.pinchDistance = Math.hypot(first.x - second.x, first.y - second.y);
      gesture.lastX = (first.x + second.x) / 2;
      gesture.lastY = (first.y + second.y) / 2;
    }
    dom.view.focus({ preventScroll: true });
    event.preventDefault();
  });
  dom.canvas.addEventListener('pointermove', (event) => {
    const point = localPoint(event);
    hover.active = event.pointerType === 'mouse';
    hover.x = point.x;
    hover.y = point.y;
    if (hover.active) dirty = true;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, point);
    if (gesture.mode === 'press' || gesture.mode === 'drag') {
      if (!gesture.moved && Math.hypot(point.x - gesture.startX, point.y - gesture.startY) >= DRAG_THRESHOLD) {
        gesture.moved = true;
        gesture.mode = 'drag';
      }
      if (gesture.mode === 'drag') {
        pan(gesture.lastX - point.x, gesture.lastY - point.y);
        gesture.lastX = point.x;
        gesture.lastY = point.y;
      }
    } else if (gesture.mode === 'pinch' && pointers.size >= 2) {
      const [first, second] = [...pointers.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      pan(gesture.lastX - midX, gesture.lastY - midY);
      if (distance > 0 && gesture.pinchDistance > 0) zoomAt(gesture.pinchDistance / distance, midX, midY);
      gesture.pinchDistance = distance;
      gesture.lastX = midX;
      gesture.lastY = midY;
    }
  });
  function endPointer(event, cancelled) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!cancelled && gesture.mode === 'press' && !gesture.moved && pointers.size === 0) {
      const point = localPoint(event);
      setWaypointAt(point.x, point.y);
    }
    if (pointers.size === 0) gesture.mode = 'none';
    else if (gesture.mode === 'pinch' && pointers.size === 1) {
      const [remaining] = [...pointers.values()];
      gesture.mode = 'drag';
      gesture.lastX = remaining.x;
      gesture.lastY = remaining.y;
    }
  }
  dom.canvas.addEventListener('pointerup', (event) => endPointer(event, false));
  dom.canvas.addEventListener('pointercancel', (event) => endPointer(event, true));
  dom.canvas.addEventListener('pointerleave', () => {
    hover.active = false;
    dirty = true;
  });
  dom.canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = localPoint(event);
    const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * view.height : event.deltaY;
    zoomAt(Math.exp(pixels * WHEEL_ZOOM_RATE), point.x, point.y);
  }, { passive: false });
  dom.view.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let handled = true;
    switch (event.code) {
      case 'ArrowLeft': pan(-KEY_PAN_PIXELS, 0); break;
      case 'ArrowRight': pan(KEY_PAN_PIXELS, 0); break;
      case 'ArrowUp': pan(0, -KEY_PAN_PIXELS); break;
      case 'ArrowDown': pan(0, KEY_PAN_PIXELS); break;
      case 'Equal':
      case 'NumpadAdd': zoomAt(1 / KEY_ZOOM_FACTOR); break;
      case 'Minus':
      case 'NumpadSubtract': zoomAt(KEY_ZOOM_FACTOR); break;
      case 'Digit0':
      case 'Numpad0': setFollow(true); break;
      case 'Enter':
      case 'NumpadEnter': setWaypointAt(view.width / 2, view.height / 2); break;
      default: handled = false;
    }
    if (!handled) return;
    // The map keys stay in the map: neither the flight keys nor the UI keys see them.
    event.preventDefault();
    event.stopPropagation();
  });
  element.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-map-action]') : null;
    if (!button) return;
    const action = button.dataset.mapAction;
    if (action === 'zoom-in') zoomAt(1 / KEY_ZOOM_FACTOR);
    else if (action === 'zoom-out') zoomAt(KEY_ZOOM_FACTOR);
    else if (action === 'follow') setFollow(true);
  });

  // ---- Events ---------------------------------------------------------------------------------
  bus.on('journal:discovery', () => {
    if (open) refreshSites();
  });
  bus.on('journal:changed', (payload) => {
    if (open && payload && (payload.reason === 'landmark' || payload.reason === 'spawn')) refreshSites();
  });
  bus.on('waypoint:set', () => {
    dirty = true;
  });
  bus.on('waypoint:cleared', () => {
    dirty = true;
  });
  bus.onTyped('relaunched', () => breakTrail());

  return {
    element,
    /** The panel opened (ui.js showPanel): follow the craft, read the journal, take the focus. */
    onOpen() {
      open = true;
      root.classList.add('dw-map-open');
      dom.seed.textContent = `Seed ${state.seed}`;
      refreshSites();
      resize();
      if (view.follow) setFollow(true);
      reprioritizeTiles(levelFor(view.metresPerPixel));
      dirty = true;
      drawTimer = 0;
      dom.view.focus({ preventScroll: true });
    },
    /** The panel closed: stop drawing and drop the tiles still queued. */
    onClose() {
      open = false;
      root.classList.remove('dw-map-open');
      pointers.clear();
      gesture.mode = 'none';
      hover.active = false;
      tiles.reprioritize(() => null);
    },
    /** Every UI frame: records the trail; while open, follows the craft and redraws (30 Hz at most). */
    update(step) {
      recordTrail();
      if (!open) return;
      if (view.follow && (view.centerX !== state.player.position.x || view.centerZ !== state.player.position.z)) {
        view.centerX = state.player.position.x;
        view.centerZ = state.player.position.z;
        dirty = true;
      }
      drawTimer -= step;
      if (dirty && drawTimer <= 0) {
        drawTimer = REDRAW_SECONDS;
        if (view.follow) reprioritizeTiles(levelFor(view.metresPerPixel));
        draw();
        updateReadout();
      }
    },
    isOpen: () => open,
    /** The map's state for tests and tools. */
    getState() {
      let ready = 0;
      let pending = 0;
      for (const entry of tileCache.values()) {
        if (entry.status === 'ready') ready++;
        else pending++;
      }
      return {
        open,
        centerX: Math.round(view.centerX),
        centerZ: Math.round(view.centerZ),
        metresPerPixel: Math.round(view.metresPerPixel * 100) / 100,
        follow: view.follow,
        level: levelFor(view.metresPerPixel),
        size: { width: view.width, height: view.height },
        tiles: { ready, pending, service: tiles.stats() },
        sites: sites.map((site) => ({ name: site.name, kind: site.kind, icon: site.icon, x: site.x, z: site.z })),
        trailPoints: trail.count,
        waypoint: state.waypoint ? { x: Math.round(state.waypoint.x), z: Math.round(state.waypoint.z), label: state.waypoint.label } : null,
      };
    },
    /** Client (viewport) coordinates of a world point on the open map, or null when it is off the map. */
    clientPointFor(x, z) {
      const rect = dom.canvas.getBoundingClientRect();
      const pixelX = screenX(x);
      const pixelY = screenY(z);
      if (pixelX < 0 || pixelY < 0 || pixelX > view.width || pixelY > view.height) return null;
      return { x: rect.left + pixelX, y: rect.top + pixelY };
    },
    /** Stops following the craft and centres the map on a world point (optionally at a zoom, m/px). */
    centerOn(x, z, metresPerPixel = view.metresPerPixel) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      setFollow(false);
      view.centerX = x;
      view.centerZ = z;
      view.metresPerPixel = clamp(metresPerPixel, MIN_METRES_PER_PIXEL, MAX_METRES_PER_PIXEL);
      reprioritizeTiles(levelFor(view.metresPerPixel));
      dirty = true;
      return true;
    },
    /** Follows the craft again (the map's follow button, 0). */
    follow() {
      setFollow(true);
    },
    refreshSites,
    dispose() {
      resizeObserver.disconnect();
      tiles.dispose();
      for (const entry of tileCache.values()) if (entry.bitmap) entry.bitmap.close();
      tileCache.clear();
      element.remove();
    },
  };
}
