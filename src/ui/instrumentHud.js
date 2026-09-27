// Instrument HUD overlay: the active craft's instruments (craft.instruments) as glass tiles in the
// v1 HUD style, for readability in any view. Off by default (settings.hud.overlay), so CLASSIC's v1
// HUD is untouched unless the player turns it on.
//
// The tiles form a grid on the right edge. Its band runs between whatever v1 HUD element sits above
// it (top bar, stats or dev badge, touch chips) and below it (seed card, mic, touch controls),
// measured from the live layout, and the tile size and column count are chosen to fit that band, so
// it stays clear of the HUD cards, the mode pill and the craft picker from 1280 x 720 down to phones.
// It fades with the v1 HUD (.dw-fade) and redraws only when the camera system's 30 Hz instrument
// clock says so.
import './instrumentHud.css';

const TILE = Object.freeze({ MAX: 104, MIN: 58, STEP: 2, GAP: 6 });
/** Right-hand HUD elements the column must stay clear of. */
const OBSTACLE_SELECTORS = Object.freeze([
  '#dw-topbar', '#dw-debug', '.dw-devbadge', '#dw-chips', '#dw-compass', '#dw-modebar', '#dw-flight',
  '#dw-corner', '#dw-mic', '.dw-throttle-slider', '.dw-action-cluster', '.dw-sound-pill',
]);
const LAYOUT_INTERVAL_SECONDS = 1;
const EDGE_MARGIN = 16;
const OBSTACLE_MARGIN = 10;
/** The column may use at most this share of the screen width. */
const MAX_WIDTH_SHARE = 0.34;

export function createInstrumentHud(ctx, instrumentSet) {
  const { settings, bus } = ctx;
  const host = document.getElementById('ui-root') || document.body;
  const container = document.createElement('div');
  container.className = 'dw-ihud dw-fade';
  container.setAttribute('aria-hidden', 'true');
  container.hidden = true;
  host.appendChild(container);

  const tiles = [];
  let tileIds = '';
  let enabled = readEnabled();
  let layoutTimer = 0;
  let layout = { size: 0, columns: 0, rows: 0, top: 0, right: 0 };
  let redraws = 0;

  function readEnabled() {
    const hud = settings.get('hud');
    return Boolean(hud && hud.overlay);
  }

  function pixelRatio() {
    return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  }

  function rebuildTiles(ids) {
    container.replaceChildren();
    tiles.length = 0;
    for (const id of ids) {
      const element = document.createElement('div');
      element.className = 'dw-ihud-tile glass';
      element.dataset.instrument = id;
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable for the instrument HUD');
      element.appendChild(canvas);
      container.appendChild(element);
      tiles.push({ id, element, canvas, context, pixels: 0 });
    }
    tileIds = ids.join(',');
    layoutTimer = 0;
  }

  /** The free vertical band on the right edge: [top, bottom] in CSS pixels. */
  function measureBand(width, height) {
    let top = EDGE_MARGIN;
    let bottom = height - EDGE_MARGIN;
    const columnLeft = width * (1 - MAX_WIDTH_SHARE) - EDGE_MARGIN;
    for (const selector of OBSTACLE_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.right < columnLeft) continue;
        const middle = (rect.top + rect.bottom) / 2;
        if (middle < height / 2) top = Math.max(top, rect.bottom + OBSTACLE_MARGIN);
        else bottom = Math.min(bottom, rect.top - OBSTACLE_MARGIN);
      }
    }
    return { top, bottom: Math.max(bottom, top + TILE.MIN) };
  }

  /** Picks the largest tile size whose grid fits the band and the width budget. */
  function computeLayout() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const count = tiles.length;
    const band = measureBand(width, height);
    const available = band.bottom - band.top;
    const maxWidth = Math.max(TILE.MIN, width * MAX_WIDTH_SHARE);
    let chosen = null;
    for (let size = TILE.MAX; size >= TILE.MIN; size -= TILE.STEP) {
      const rows = Math.max(1, Math.min(count, Math.floor((available + TILE.GAP) / (size + TILE.GAP))));
      const columns = Math.ceil(count / rows);
      const gridWidth = columns * size + (columns - 1) * TILE.GAP;
      if (gridWidth <= maxWidth) {
        chosen = { size, rows: Math.ceil(count / columns), columns };
        break;
      }
    }
    if (!chosen) {
      const rows = Math.max(1, Math.floor((available + TILE.GAP) / (TILE.MIN + TILE.GAP)));
      const columns = Math.ceil(count / rows);
      chosen = { size: TILE.MIN, rows: Math.ceil(count / columns), columns };
    }
    const gridHeight = chosen.rows * chosen.size + (chosen.rows - 1) * TILE.GAP;
    const top = Math.round(band.top + Math.max(0, (available - gridHeight) / 2));
    return { ...chosen, top, right: EDGE_MARGIN };
  }

  function applyLayout() {
    layout = computeLayout();
    container.style.top = `${layout.top}px`;
    container.style.right = `max(${layout.right}px, env(safe-area-inset-right, 0px))`;
    container.style.gridTemplateColumns = `repeat(${layout.columns}, ${layout.size}px)`;
    container.style.gridAutoRows = `${layout.size}px`;
    const pixels = Math.round(layout.size * pixelRatio());
    for (const tile of tiles) {
      if (tile.pixels === pixels) continue;
      tile.pixels = pixels;
      tile.canvas.width = pixels;
      tile.canvas.height = pixels;
    }
  }

  function redraw() {
    for (const tile of tiles) {
      tile.context.clearRect(0, 0, tile.pixels, tile.pixels);
      instrumentSet.draw(tile.id, tile.context, 0, 0, tile.pixels, 'glass');
    }
    redraws++;
  }

  bus.on('settings:changed', ({ key }) => {
    if (key === 'hud') enabled = readEnabled();
  });
  window.addEventListener('resize', () => {
    layoutTimer = 0;
  });

  return {
    /** True while the overlay is switched on and the craft has instruments. */
    get visible() {
      return enabled && tiles.length > 0;
    },

    /**
     * Per frame: keeps the tiles in step with the craft's instruments and the layout current;
     * redraws the gauges when `redrawNow` (the 30 Hz instrument tick).
     */
    update(realDt, redrawNow) {
      const ids = instrumentSet.ids;
      if (!enabled || ids.length === 0) {
        container.hidden = true;
        return;
      }
      if (ids.join(',') !== tileIds) rebuildTiles(ids);
      const wasHidden = container.hidden;
      container.hidden = false;
      layoutTimer -= realDt;
      if (wasHidden || layoutTimer <= 0) {
        layoutTimer = LAYOUT_INTERVAL_SECONDS;
        applyLayout();
      }
      if (redrawNow || wasHidden) redraw();
    },

    getStats() {
      return { enabled, visible: enabled && tiles.length > 0, tiles: tiles.length, redraws, layout: { ...layout } };
    },
  };
}
