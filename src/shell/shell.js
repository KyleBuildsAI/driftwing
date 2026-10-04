// DRIFTWING launcher shell: the root page. Two separate games behind one toggle, V1 (the frozen
// original, /v1/) and V2 (/v2/), in a single full-window iframe, so only one game ever runs.
//
// - Version: ?v=1 / ?v=2 when given, else the one remembered in localStorage
//   (driftwing.shell.lastVersion), else V2. Every load is remembered and written back to ?v=.
// - Forwarding: the game gets the shell's hash and every query parameter except v, so
//   /?v=2&renderer=webgl and /#seed=ABC reach the game. A hash change reloads the game with it.
// - Switching: the veil fades in, the iframe goes to about:blank (which frees the old game's GPU
//   device, audio and gamepads), the other game loads, the veil fades out and the game gets focus.
//   A request made while a switch runs is queued, and the latest one wins.
// - Pill: V1 | V2, top-left, hidden after HIDE_AFTER_MS without activity. It reappears when the
//   pointer reaches the top-left edge strips, when anything in the shell has focus or input, and
//   after each switch. It is placed in the first spot clear of the running game's HUD.
// - Messages: V2 asks for a switch with postMessage({ source: 'driftwing-v2',
//   type: 'switch-version', to }), and for another world (a seed link applied in its settings) with
//   postMessage({ source: 'driftwing-v2', type: 'open-world', hash: '#seed=ABC&t=0.723' }): the shell
//   takes that hash as its own (dropping any ?seed= and ?time= it forwards) and reloads V2 with it.
//   Only a message from this shell's own iframe, from this origin, with exactly one of those shapes
//   is honoured; anything else is ignored without a trace.
//
// window.DRIFTWING_SHELL is a small read-mostly handle for the headless tests.
import { isWorldHash } from '../core/seed.js';

const VERSIONS = Object.freeze(['v1', 'v2']);
const DEFAULT_VERSION = 'v2';
const LAST_VERSION_KEY = 'driftwing.shell.lastVersion';
const LABELS = Object.freeze({ v1: 'V1', v2: 'V2' });
const HIDE_AFTER_MS = 3000;
/** Matches --dw-fade-ms in index.html. */
const FADE_MS = 280;
/** A game that never fires load (a stalled CDN, say) is shown anyway after this long. */
const LOAD_TIMEOUT_MS = 30000;
/** While the pill shows, it is re-placed this often, since the game's HUD can change under it. */
const PLACE_INTERVAL_MS = 500;
/** Pill placement: the games' HUD edge insets, the scan step and the clearance around HUD items. */
const PILL_EDGE_LEFT = 18;
const PILL_EDGE_TOP = 14;
const PILL_SCAN_STEP = 8;
const PILL_CLEARANCE = 8;
/**
 * HUD elements the pill must not cover, in either game (V1's ids are frozen with V1; V2's top-left
 * stack is .dw-modebar and #dw-chips, and on touch screens its flight card sits there too).
 * Selectors a game lacks match nothing.
 */
const HUD_SELECTOR = ['.dw-modebar', '#dw-chips > *', '#dw-compass', '#dw-flight', '.dw-topbar', '.dw-debug', '.dw-devbadge'].join(', ');
const SWITCH_REQUEST_KEYS = Object.freeze(['source', 'to', 'type']);
const WORLD_REQUEST_KEYS = Object.freeze(['hash', 'source', 'type']);

const frame = document.getElementById('dw-shell-frame');
const veil = document.getElementById('dw-shell-veil');
const pill = document.getElementById('dw-shell-pill');
const statusRegion = document.getElementById('dw-shell-status');
const pillButtons = [...pill.querySelectorAll('button[data-version]')];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let current = null;
let busy = false;
/** The request made while a switch ran: { version, reload } or null. */
let queued = null;
let switches = 0;
let storageAvailable = true;
let hideTimer = 0;
let placeTimer = 0;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---- Version choice and persistence -------------------------------------------------------------
/** 'v1' | 'v2' from ?v=1 / ?v=2 (v1 / v2 accepted too), or null. */
function versionFromQuery() {
  const value = new URLSearchParams(window.location.search).get('v');
  if (value === '1' || value === 'v1') return 'v1';
  if (value === '2' || value === 'v2') return 'v2';
  return null;
}

function readRememberedVersion() {
  try {
    const value = window.localStorage.getItem(LAST_VERSION_KEY);
    return VERSIONS.includes(value) ? value : null;
  } catch (error) {
    // Storage blocked (a privacy setting): the shell still works and opens the default version.
    storageAvailable = false;
    return null;
  }
}

function rememberVersion(version) {
  if (!storageAvailable) return;
  try {
    window.localStorage.setItem(LAST_VERSION_KEY, version);
  } catch (error) {
    storageAvailable = false;
  }
}

/** Writes ?v= for the running game into the shell URL, so a reload opens the same game. */
function reflectVersionInUrl(version) {
  const params = new URLSearchParams(window.location.search);
  params.set('v', version.slice(1));
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
}

/**
 * The game URL: its directory beside the shell plus every shell query parameter except v, and the
 * shell's hash. Relative, so the site works at a subpath (GitHub Pages serves /driftwing/).
 */
function gameUrl(version) {
  const params = new URLSearchParams(window.location.search);
  params.delete('v');
  const query = params.toString();
  const page = window.location.protocol === 'file:' ? `${version}/index.html` : `${version}/`;
  return `${page}${query ? `?${query}` : ''}${window.location.hash}`;
}

// ---- Loading and switching ----------------------------------------------------------------------
/** Points the iframe at url; resolves true on its load event, false after LOAD_TIMEOUT_MS. */
function navigateFrame(url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      frame.removeEventListener('load', onLoad);
      resolve(false);
    }, LOAD_TIMEOUT_MS);
    function onLoad() {
      clearTimeout(timer);
      resolve(true);
    }
    frame.addEventListener('load', onLoad, { once: true });
    frame.src = url;
  });
}

function setVeil(opaque) {
  veil.classList.toggle('dw-clear', !opaque);
  return sleep(reducedMotion.matches ? 0 : FADE_MS);
}

/** Keyboard, mouse and gamepads go to the game. */
function focusGame() {
  frame.focus();
  frame.contentWindow?.focus();
}

function updatePill() {
  for (const button of pillButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.version === current));
    button.disabled = busy;
  }
}

/**
 * Loads version into the iframe. After the first load it runs the full switch: veil in,
 * about:blank, the new game, veil out, focus.
 */
async function loadGame(version, { initial = false } = {}) {
  busy = true;
  updatePill();
  statusRegion.textContent = `Loading ${LABELS[version]}`;
  if (!initial) {
    await setVeil(true);
    await navigateFrame('about:blank');
  }
  current = version;
  rememberVersion(version);
  reflectVersionInUrl(version);
  frame.title = `DRIFTWING ${LABELS[version]}`;
  updatePill();
  await navigateFrame(gameUrl(version));
  await setVeil(false);
  busy = false;
  if (!initial) switches += 1;
  updatePill();
  statusRegion.textContent = `${LABELS[version]} is running`;
  focusGame();
  showPill();
  const next = queued;
  queued = null;
  if (next) requestVersion(next.version, { reload: next.reload });
}

/**
 * Asks for a version. Asking for the running game only hands it the focus back, unless reload is
 * set (a new hash). While a switch runs, the latest request waits for it. Returns true when a
 * load was started or queued.
 */
function requestVersion(version, { reload = false } = {}) {
  if (!VERSIONS.includes(version)) return false;
  if (busy) {
    queued = { version, reload };
    return true;
  }
  if (version === current && !reload) {
    focusGame();
    return false;
  }
  loadGame(version).catch((error) => {
    console.error('[DRIFTWING shell] switching games failed', error);
    busy = false;
    updatePill();
  });
  return true;
}

// ---- Messages from V2 ---------------------------------------------------------------------------
/** True when data is a plain object with exactly the (sorted) keys. */
function hasExactKeys(data, expectedKeys) {
  if (data === null || typeof data !== 'object' || Object.getPrototypeOf(data) !== Object.prototype) return false;
  const keys = Object.keys(data).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

/** True for exactly { source: 'driftwing-v2', type: 'switch-version', to: 'v1' | 'v2' }. */
function isSwitchRequest(data) {
  if (!hasExactKeys(data, SWITCH_REQUEST_KEYS)) return false;
  return data.source === 'driftwing-v2' && data.type === 'switch-version' && VERSIONS.includes(data.to);
}

/** True for exactly { source: 'driftwing-v2', type: 'open-world', hash: '#seed=...' }. */
function isWorldRequest(data) {
  if (!hasExactKeys(data, WORLD_REQUEST_KEYS)) return false;
  return data.source === 'driftwing-v2' && data.type === 'open-world' && isWorldHash(data.hash);
}

/**
 * Makes hash the shell's own (so the shell URL names the world and a reload returns to it) and
 * reloads V2 with it. A ?seed= or ?time= the shell forwards would win over the hash, so they go.
 */
function openWorld(hash) {
  const params = new URLSearchParams(window.location.search);
  params.delete('seed');
  params.delete('time');
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${hash}`);
  requestVersion('v2', { reload: true });
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
  if (isSwitchRequest(event.data)) requestVersion(event.data.to);
  else if (isWorldRequest(event.data)) openWorld(event.data.hash);
});

// ---- The pill: placement and auto-hide ----------------------------------------------------------
/** Rectangles (shell viewport coordinates) of the running game's HUD elements. */
function hudRects() {
  // contentDocument is null while the frame shows another origin; the pill then takes the corner.
  const gameDocument = frame.contentDocument;
  if (!gameDocument || !gameDocument.defaultView) return [];
  const rects = [];
  for (const element of gameDocument.querySelectorAll(HUD_SELECTOR)) {
    const style = gameDocument.defaultView.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

/**
 * Puts the pill at the first spot clear of the game's HUD: along the top row from the left edge,
 * then down the left edge, else in the corner.
 */
function placePill() {
  const width = pill.offsetWidth;
  const height = pill.offsetHeight;
  const rects = hudRects();
  const isClear = (x, y) => rects.every((rect) => x + width + PILL_CLEARANCE <= rect.left || x - PILL_CLEARANCE >= rect.right
    || y + height + PILL_CLEARANCE <= rect.top || y - PILL_CLEARANCE >= rect.bottom);
  const lastX = Math.min(window.innerWidth * 0.5, window.innerWidth - width - PILL_EDGE_LEFT);
  const lastY = Math.min(window.innerHeight * 0.6, window.innerHeight - height - PILL_EDGE_TOP);
  let spot = null;
  for (let x = PILL_EDGE_LEFT; x <= lastX && !spot; x += PILL_SCAN_STEP) {
    if (isClear(x, PILL_EDGE_TOP)) spot = [x, PILL_EDGE_TOP];
  }
  for (let y = PILL_EDGE_TOP; y <= lastY && !spot; y += PILL_SCAN_STEP) {
    if (isClear(PILL_EDGE_LEFT, y)) spot = [PILL_EDGE_LEFT, y];
  }
  const [left, top] = spot ?? [PILL_EDGE_LEFT, PILL_EDGE_TOP];
  pill.style.left = `${left}px`;
  pill.style.top = `${top}px`;
}

function hidePill() {
  // Kept while the pointer is on it or it holds keyboard focus.
  if (pill.matches(':hover') || pill.contains(document.activeElement)) {
    scheduleHide();
    return;
  }
  pill.classList.remove('dw-visible');
  clearInterval(placeTimer);
  placeTimer = 0;
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePill, HIDE_AFTER_MS);
}

function showPill() {
  placePill();
  pill.classList.add('dw-visible');
  if (!placeTimer) placeTimer = setInterval(placePill, PLACE_INTERVAL_MS);
  scheduleHide();
}

/** Activity the shell itself sees: shows the pill, or keeps it up while it shows. */
function noteActivity() {
  if (pill.classList.contains('dw-visible')) scheduleHide();
  else showPill();
}

// Pointer events over the game go to the game, so these only fire on the hot strips and the pill.
for (const zone of document.querySelectorAll('.dw-shell-hot')) zone.addEventListener('pointerenter', showPill);
window.addEventListener('pointermove', noteActivity);
window.addEventListener('keydown', noteActivity);
pill.addEventListener('focusin', showPill);
window.addEventListener('resize', () => {
  if (pill.classList.contains('dw-visible')) placePill();
});
for (const button of pillButtons) {
  button.addEventListener('click', () => requestVersion(button.dataset.version));
}
window.addEventListener('hashchange', () => requestVersion(current ?? DEFAULT_VERSION, { reload: true }));

// ---- Test handle and start ----------------------------------------------------------------------
window.DRIFTWING_SHELL = Object.freeze({
  get version() { return current; },
  get busy() { return busy; },
  /** Completed switches since the shell loaded (the first load is not one). */
  get switches() { return switches; },
  get pillVisible() { return pill.classList.contains('dw-visible'); },
  get storageAvailable() { return storageAvailable; },
  /** The running game's own debug handle (window.DRIFTWING inside the iframe), or null. */
  get game() {
    // contentDocument is null for a page from another origin, whose window must not be probed.
    return frame.contentDocument ? frame.contentWindow.DRIFTWING ?? null : null;
  },
  requestVersion,
});

loadGame(versionFromQuery() ?? readRememberedVersion() ?? DEFAULT_VERSION, { initial: true }).catch((error) => {
  console.error('[DRIFTWING shell] loading the game failed', error);
});
