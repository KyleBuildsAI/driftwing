import * as THREE from 'three/webgpu';
import { clamp, wrapDegrees, vectorFromHeading, bearingTo, isFiniteVector, isFiniteQuaternion } from '../core/util.js';
import { CONFIG } from '../core/config.js';
import { Copilot } from '../copilot/copilot.js';
import { storage } from '../core/storage.js';
import { createControlsPanel } from './controlsPanel.js';
import { createCraftPicker } from './craftPicker.js';
import { createSettingsPanel } from './settingsPanel.js';
import { createStatusBadge } from '../dev/statusBadge.js';

/**
 * UI: warm glass HUD (compass tape, flight instruments, waypoint / ring marker,
 * status chips and craft picker), WREN subtitles + live transcript, command bar,
 * toasts and banners, Journal / Settings / Controls / Help / Menu panels, touch
 * controls (virtual stick and throttle slider), photo-mode chrome, the dev status
 * badge, the first-run hint, idle auto-hide and every UI hotkey.
 * DOM writes happen only when a displayed value changes; positions use
 * compositor-only transforms; nothing is allocated per frame except the short
 * strings for values that actually changed.
 */
export function createUISystem(ctx) {
  const { THREE: T, state, bus, settings, world, camera, renderer } = ctx;
  const root = document.getElementById('ui-root');
  if (!root) throw new Error('DRIFTWING UI: the #ui-root element is missing from the page.');

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const params = new URLSearchParams(window.location.search);
  const PX_PER_DEGREE = 4;
  const HEADING_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const LANDMARK_TYPE_LABELS = { arch: 'Stone arch', monoliths: 'Standing stones', lighthouse: 'Lighthouse', balloons: 'Balloon meet' };
  const PRESET_LABELS = {
    dawn: 'dawn', sunrise: 'sunrise', morning: 'morning', noon: 'noon', golden: 'golden hour',
    sunset: 'sunset', dusk: 'dusk', night: 'night', midnight: 'midnight',
  };
  const TIME_CYCLE = ['dawn', 'noon', 'golden', 'night'];
  const LANDING_GRADE_LABELS = { butter: 'Butter', smooth: 'Smooth', firm: 'Firm', hard: 'Hard' };
  const TOAST_KINDS = new Set(['info', 'success', 'warning']);
  const MIC_STATES = new Set(['idle', 'listening', 'thinking', 'unsupported', 'error']);
  const MIC_TIPS = {
    idle: 'Talk to WREN (M)',
    listening: 'Listening. Press M to stop',
    thinking: 'WREN is thinking',
    unsupported: 'Voice input is not available in this browser. Press Enter to type to WREN',
    error: 'Voice input hit a snag. Press M to try again',
  };
  const MIC_TIPS_TOUCH = {
    idle: 'Talk to WREN',
    listening: 'Listening. Tap to stop',
    thinking: 'WREN is thinking',
    unsupported: 'Voice input is not available in this browser. Use the menu to type to WREN',
    error: 'Voice input hit a snag. Tap to try again',
  };
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const FIRST_RUN_KEY = 'driftwing-v2.ui.firstRunHintSeen';
  const MAX_TOASTS = 2;
  // Toasts raised in photo mode wait for the exit; older ones are no longer news.
  const DEFERRED_TOAST_MAX_AGE = 45;
  // Seconds a banner or toast must have been on screen to count as read when photo mode cuts it short.
  const OVERLAY_READ_SECONDS = 1.6;
  // World-space radius of what the target marker points at (rings.js ring + halo; waypoints.js ground ring),
  // so the label can sit beside the target instead of on top of it.
  const TARGET_FOOTPRINT = { ring: 22, waypoint: 46 };
  const TARGET_LABEL_MIN_OFFSET = 28;
  const TARGET_LABEL_MAX_OFFSET = 190;
  const TARGET_LABEL_WIDTH = 124;
  const LANDMARK_MARKER_COUNT = 4;
  const LANDMARK_MARKER_RADIUS = 4500;
  const COMMAND_HISTORY_LIMIT = 16;
  const STICK_DEADZONE = 0.08;
  const SLIDER_PADDING = 12;
  const SUBTITLE_FADE_SECONDS = 0.62;
  // The intro banner waits until the biome under and ahead of the glider has settled;
  // biome banners then stay quiet for a while so the opening is not re-announced.
  const INTRO_STABLE_SECONDS = 2;
  const INTRO_AHEAD_METRES = 320;
  const INTRO_AHEAD_PATIENCE = 6;
  const INTRO_GIVE_UP_SECONDS = 12;
  const BIOME_QUIET_AFTER_INTRO = 15;
  // A banner beside an open panel needs at least this much free width, else it waits.
  const BANNER_MIN_FREE_WIDTH = 340;
  // Portrait touch layout (CSS px / seconds).
  const PORTRAIT_CHECK_SECONDS = 0.15;
  const PORTRAIT_SLOT_SWITCH_SECONDS = 0.8;
  const PORTRAIT_GLIDER_PADDING = 14;
  const PORTRAIT_SPEECH_RESERVE = 104;
  const PORTRAIT_TOAST_LANE = 46;
  // Glider outline in its local frame (metres, -z forward): nose, belly, fin tip, tail cone, wingtips.
  const GLIDER_OUTLINE = [[0, 0, -3.2], [0, -0.55, 0], [0, 1.95, 4.4], [0, 0.35, 5.2], [-7.35, 0.45, 0.4], [7.35, 0.45, 0.4]];
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const coarsePointerQuery = window.matchMedia('(pointer: coarse)');

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  function requireElement(id) {
    const found = root.querySelector(`#${id}`);
    if (!found) throw new Error(`DRIFTWING UI: element #${id} is missing from ui.html.`);
    return found;
  }
  const dom = {
    compassStrip: requireElement('dw-compass-strip'),
    compassTape: requireElement('dw-compass-tape'),
    compassMarkers: requireElement('dw-compass-markers'),
    heading: requireElement('dw-heading'),
    headingName: requireElement('dw-heading-name'),
    timeChip: requireElement('dw-time-chip'),
    timeLabel: requireElement('dw-time-label'),
    timeClock: requireElement('dw-time-clock'),
    autopilotDetail: requireElement('dw-autopilot-detail'),
    ringChip: requireElement('dw-ring-chip'),
    ringIndex: requireElement('dw-ring-index'),
    ringTotal: requireElement('dw-ring-total'),
    ringTime: requireElement('dw-ring-time'),
    ringStreak: requireElement('dw-ring-streak'),
    ringStreakValue: requireElement('dw-ring-streak-value'),
    debug: requireElement('dw-debug'),
    debugFps: requireElement('dw-debug-fps'),
    debugMs: requireElement('dw-debug-ms'),
    debugBackend: requireElement('dw-debug-backend'),
    debugDraws: requireElement('dw-debug-draws'),
    debugChunks: requireElement('dw-debug-chunks'),
    speed: requireElement('dw-speed'),
    throttleFill: requireElement('dw-throttle-fill'),
    throttleValue: requireElement('dw-throttle-value'),
    altitude: requireElement('dw-altitude'),
    agl: requireElement('dw-agl'),
    vsi: requireElement('dw-vsi'),
    vsiValue: requireElement('dw-vsi-value'),
    seedValue: requireElement('dw-seed-value'),
    newWorld: requireElement('dw-new-world'),
    newWorldLabel: requireElement('dw-new-world-label'),
    commandButton: requireElement('dw-command-button'),
    menuNewWorld: requireElement('dw-menu-new-world'),
    mic: requireElement('dw-mic'),
    target: requireElement('dw-target'),
    targetLabel: requireElement('dw-target-label'),
    targetName: requireElement('dw-target-name'),
    targetDistance: requireElement('dw-target-distance'),
    targetChevron: requireElement('dw-target-chevron'),
    targetEdgeDistance: requireElement('dw-target-edge-distance'),
    toasts: requireElement('dw-toasts'),
    banner: requireElement('dw-banner'),
    bannerLabel: requireElement('dw-banner-label'),
    bannerTitle: requireElement('dw-banner-title'),
    bannerDetail: requireElement('dw-banner-detail'),
    bannerPalette: requireElement('dw-banner-palette'),
    speech: requireElement('dw-speech'),
    hint: requireElement('dw-hint'),
    transcriptText: requireElement('dw-transcript-text'),
    subtitle: requireElement('dw-subtitle'),
    subtitleLabel: requireElement('dw-subtitle-label'),
    subtitleText: requireElement('dw-subtitle-text'),
    command: requireElement('dw-command'),
    commandForm: requireElement('dw-command-form'),
    commandInput: requireElement('dw-command-input'),
    quickWaypoint: requireElement('dw-quick-waypoint'),
    quickAutopilot: requireElement('dw-quick-autopilot'),
    quickRings: requireElement('dw-quick-rings'),
    journalSeed: requireElement('dw-journal-seed'),
    helpMode: requireElement('dw-help-mode'),
    helpFlight: requireElement('dw-help-flight'),
    helpShortcuts: requireElement('dw-help-shortcuts'),
    journalBody: requireElement('dw-journal-body'),
    menuSeed: requireElement('dw-menu-seed'),
    craftPicker: requireElement('dw-craft-picker'),
    touchControls: requireElement('dw-touch-controls'),
    stickZone: requireElement('dw-stick-zone'),
    stick: requireElement('dw-stick'),
    stickKnob: requireElement('dw-stick-knob'),
    throttleSlider: requireElement('dw-throttle-slider'),
    actionCluster: requireElement('dw-action-cluster'),
    chips: requireElement('dw-chips'),
    flightCard: requireElement('dw-flight'),
    sliderFill: requireElement('dw-slider-fill'),
    sliderThumb: requireElement('dw-slider-thumb'),
    photo: requireElement('dw-photo'),
    photoMeta: requireElement('dw-photo-meta'),
    photoHint: requireElement('dw-photo-hint'),
    flash: requireElement('dw-flash'),
  };
  const panels = {
    journal: requireElement('dw-panel-journal'),
    settings: requireElement('dw-panel-settings'),
    controls: requireElement('dw-panel-controls'),
    help: requireElement('dw-panel-help'),
    menu: requireElement('dw-panel-menu'),
  };
  const panelButtons = {
    journal: requireElement('dw-journal-button'),
    settings: requireElement('dw-settings-button'),
    help: requireElement('dw-help-button'),
  };

  // ---------------------------------------------------------------------------
  // Mutable UI state
  // ---------------------------------------------------------------------------
  const view = { width: window.innerWidth, height: window.innerHeight };
  const targetMargins = { left: 60, right: 60, top: 110, bottom: 130 };
  const rootClassCache = new Map();
  let uiClock = 0;
  let localActivity = performance.now();
  let pointerOverUi = false;
  let idle = false;
  let hudHiddenByUser = false;
  let hudHiddenToastShown = false;
  let photoActive = false;
  let touchMode = false;
  let activePanel = null;
  let commandOpen = false;
  let micState = 'idle';
  let micErrorResetAt = 0;
  let revealEndsAt = 0;
  let debugForced = params.get('debug') === '1';
  let newWorldConfirmUntil = 0;
  let toastSerial = 0;
  let waypointReachedAt = -Infinity;
  let lastAutopilotEnabled = Boolean(state.player.autopilot && state.player.autopilot.enabled);
  let lastTimePreset = null;
  let lastTimePresetAt = -Infinity;
  let journalStatsTimer = 0;
  let landmarkRefreshTimer = 0;
  let debugTimer = 0;
  let autopilotDetailTimer = 0;
  let ringFlashUntil = 0;

  const compassState = { width: 440, half: 220, heading: NaN, headingWhole: -1 };
  const readouts = {
    speed: NaN, altitude: NaN, agl: NaN, vsiTenths: NaN, vsiTrend: '', throttle: NaN, throttlePercent: -1,
    stalled: null,
  };
  const chipState = { minute: -1, label: null, phase: '', ringIndex: -1, ringTotal: -1, ringTenths: -1, ringStreak: -1 };
  const targetState = {
    kind: null, shownKind: null, label: '', distance: 0, mode: '', x: NaN, y: NaN, angle: NaN, distanceKey: NaN, name: '', near: null,
    labelOffset: NaN, labelLeft: false, waypointX: NaN, waypointZ: NaN, waypointBase: 0,
  };
  const subtitleState = { visible: false, expiresAt: 0, collapseAt: Infinity };
  const transcriptState = { visible: false, expiresAt: Infinity };
  const bannerState = { phase: 'idle', until: 0, queue: [], current: null, shownAt: 0, retryAt: 0, sharesSpeech: false };
  const bannerCss = { x: '', width: '', top: '' };
  const biomeBannerState = { lastKey: state.player.biome ? state.player.biome.key : null, lastShownAt: -Infinity, pending: null, pendingSince: 0, suppressUntil: 0 };
  const introState = { phase: 'idle', key: null, stableSince: 0, startedAt: 0, timer: 0 };
  const portraitState = {
    active: false, timer: 0, slot: 'bottom', pendingSlot: 'bottom', pendingSince: 0,
    gliderTop: NaN, gliderBottom: NaN, topSlotY: 0, bottomSlotY: 0, cssTop: '', cssBottom: '',
  };
  const hintState = { showAt: Infinity, hideAt: Infinity, visible: false, dodging: false, speechLayout: -1, left: 0, right: 0, top: 0, bottom: 0 };
  const toasts = [];
  const deferredToasts = [];
  let deferredToastFlushAt = 0;
  const photoState = { metaText: '', statusText: '', statusUntil: 0, statusShown: false, refreshTimer: 0, targetLabel: '', targetUntil: 0 };
  const commandHistory = [];
  let commandHistoryIndex = -1;
  const journalStatElements = { distance: null, time: null, altitude: null, landmarks: null };
  const nearbyLandmarks = [];

  const targetWorld = new T.Vector3();
  const projected = new T.Vector3();
  const gliderPoint = new T.Vector3();

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function setRootClass(name, enabled) {
    if (rootClassCache.get(name) === enabled) return;
    rootClassCache.set(name, enabled);
    root.classList.toggle(name, enabled);
  }
  function wrap180(degrees) {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
  }
  function capitalize(text) {
    const value = String(text || '');
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }
  function hexToCss(hex) {
    return `#${(Number(hex) >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
  }
  function padNumber(value, length) {
    return String(value).padStart(length, '0');
  }
  function formatDistance(metres) {
    if (!Number.isFinite(metres)) return '';
    if (metres < 950) return `${Math.max(0, Math.round(metres / 10) * 10)} m`;
    const kilometres = metres / 1000;
    return kilometres < 9.95 ? `${kilometres.toFixed(1)} km` : `${Math.round(kilometres)} km`;
  }
  function distanceKey(metres) {
    if (!Number.isFinite(metres)) return -1;
    if (metres < 950) return Math.round(metres / 10);
    const kilometres = metres / 1000;
    return kilometres < 9.95 ? 100000 + Math.round(kilometres * 10) : 200000 + Math.round(kilometres);
  }
  function formatRaceTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    const wholeSeconds = Math.floor(rest);
    const tenths = Math.floor((rest - wholeSeconds) * 10);
    return `${minutes}:${padNumber(wholeSeconds, 2)}.${tenths}`;
  }
  function formatClock(dayTime) {
    const minuteOfDay = Math.floor((((dayTime % 1) + 1) % 1) * 1440) % 1440;
    return `${padNumber(Math.floor(minuteOfDay / 60), 2)}:${padNumber(minuteOfDay % 60, 2)}`;
  }
  function formatCount(value) {
    const number = Number(value) || 0;
    if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
    if (number >= 1e4) return `${(number / 1e3).toFixed(1)}k`;
    return String(Math.round(number));
  }
  function durationParts(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    if (safe < 60) return [String(Math.floor(safe)), 's'];
    if (safe < 3600) return [String(Math.floor(safe / 60)), 'min'];
    const hours = Math.floor(safe / 3600);
    return [`${hours}:${padNumber(Math.floor((safe - hours * 3600) / 60), 2)}`, 'h'];
  }
  function distanceParts(metres) {
    const safe = Math.max(0, Number(metres) || 0);
    if (safe < 1000) return [String(Math.round(safe)), 'm'];
    return [safe < 100000 ? (safe / 1000).toFixed(1) : String(Math.round(safe / 1000)), 'km'];
  }
  function biomeNameFor(value) {
    if (Number.isInteger(value) && world.BIOMES[value]) return world.BIOMES[value].name;
    const match = world.BIOMES.find((biome) => biome.key === value || biome.name === value);
    return match ? match.name : capitalize(value || 'Unknown lands');
  }
  function biomeIndexFor(value) {
    if (Number.isInteger(value) && world.BIOMES[value]) return value;
    const match = world.BIOMES.find((biome) => biome.key === value);
    return match ? match.index : -1;
  }
  function readingSeconds(text) {
    const words = text.split(/\s+/).length;
    return clamp(1.6 + words * 0.36, 3.2, 11);
  }
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    const type = target.type;
    return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }
  /**
   * Captures a pointer for a drag control. Returns false when the browser
   * refuses (pointer already gone or not capturable); the control then keeps
   * tracking uncaptured and releases on pointerleave instead.
   */
  function capturePointer(element, pointerId) {
    try {
      element.setPointerCapture(pointerId);
      return true;
    } catch (error) {
      return false;
    }
  }
  function releasePointerLock() {
    if (document.pointerLockElement && typeof document.exitPointerLock === 'function') document.exitPointerLock();
  }
  function playBlip() {
    ctx.systems.audio?.blip?.();
  }
  function markActivity() {
    localActivity = performance.now();
  }

  // ---------------------------------------------------------------------------
  // Compass tape + markers
  // ---------------------------------------------------------------------------
  function buildCompassTape() {
    const tapeWidth = 720 * PX_PER_DEGREE;
    const height = 36;
    const parts = [];
    for (let degree = -180; degree <= 540; degree += 5) {
      const x = (degree + 180) * PX_PER_DEGREE;
      const bearing = wrapDegrees(degree);
      if (bearing % 45 === 0) {
        const index = bearing / 45;
        const classes = index === 0 ? 'dw-tape-label dw-tape-cardinal dw-tape-north' : index % 2 === 0 ? 'dw-tape-label dw-tape-cardinal' : 'dw-tape-label';
        parts.push(`<text class="${classes}" x="${x}" y="${index % 2 === 0 ? 24 : 23}">${HEADING_NAMES[index]}</text>`);
      } else if (bearing % 15 === 0) {
        parts.push(`<line class="dw-tick" x1="${x}" y1="${height - 12}" x2="${x}" y2="${height - 6}"/>`);
      } else {
        parts.push(`<circle class="dw-tick-minor" cx="${x}" cy="${height - 8}" r="0.9"/>`);
      }
    }
    dom.compassTape.innerHTML = `<svg width="${tapeWidth}" height="${height}" viewBox="0 0 ${tapeWidth} ${height}" aria-hidden="true">${parts.join('')}</svg>`;
  }

  function createCompassMarker(className, iconId) {
    const element = document.createElement('div');
    element.className = `dw-cmarker ${className}`;
    element.innerHTML = `<svg class="dw-icon"><use href="#${iconId}"/></svg>`;
    dom.compassMarkers.append(element);
    return { element, use: element.querySelector('use'), icon: iconId, x: NaN, visible: false, edge: false, site: null };
  }
  const compassTargetMarker = createCompassMarker('dw-cmarker-target', 'dw-i-diamond');
  const landmarkMarkers = [];
  for (let index = 0; index < LANDMARK_MARKER_COUNT; index++) landmarkMarkers.push(createCompassMarker('dw-cmarker-landmark', 'dw-i-arch'));

  function setCompassMarkerVisible(marker, visible) {
    if (marker.visible === visible) return;
    marker.visible = visible;
    marker.element.classList.toggle('dw-on', visible);
  }
  function setCompassMarkerIcon(marker, iconId) {
    if (marker.icon === iconId) return;
    marker.icon = iconId;
    marker.use.setAttribute('href', `#${iconId}`);
  }
  function placeCompassMarker(marker, bearing, heading) {
    const relative = wrap180(bearing - heading);
    const rawX = compassState.half + relative * PX_PER_DEGREE;
    const edge = rawX < 12 || rawX > compassState.width - 12;
    const x = clamp(rawX, 12, compassState.width - 12);
    if (!(Math.abs(x - marker.x) <= 0.25)) {
      marker.x = x;
      marker.element.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0)`;
    }
    if (edge !== marker.edge) {
      marker.edge = edge;
      marker.element.classList.toggle('dw-edge', edge);
    }
  }

  function refreshNearbyLandmarks() {
    nearbyLandmarks.length = 0;
    const list = ctx.systems.landmarks?.getNearby?.(LANDMARK_MARKER_RADIUS);
    if (Array.isArray(list)) {
      for (const site of list) {
        if (nearbyLandmarks.length >= LANDMARK_MARKER_COUNT) break;
        if (site && !site.discovered && Number.isFinite(site.x) && Number.isFinite(site.z)) nearbyLandmarks.push(site);
      }
    }
    for (let index = 0; index < landmarkMarkers.length; index++) {
      const marker = landmarkMarkers[index];
      const site = nearbyLandmarks[index] || null;
      marker.site = site;
      if (!site) {
        setCompassMarkerVisible(marker, false);
        continue;
      }
      setCompassMarkerIcon(marker, LANDMARK_TYPE_LABELS[site.type] ? `dw-i-${site.type}` : 'dw-i-arch');
      const distance = Number.isFinite(site.distance) ? site.distance : Math.hypot(site.x - state.player.position.x, site.z - state.player.position.z);
      marker.element.style.setProperty('--dw-marker-opacity', (0.95 - 0.5 * clamp(distance / LANDMARK_MARKER_RADIUS, 0, 1)).toFixed(2));
      setCompassMarkerVisible(marker, true);
    }
  }

  function updateCompass(realDt) {
    const heading = wrapDegrees(Number(state.player.heading) || 0);
    if (!(Math.abs(heading - compassState.heading) <= 0.04)) {
      compassState.heading = heading;
      const offset = compassState.half - (heading + 180) * PX_PER_DEGREE;
      dom.compassTape.style.transform = `translate3d(${offset.toFixed(1)}px, 0, 0)`;
      const whole = Math.round(heading) % 360;
      if (whole !== compassState.headingWhole) {
        compassState.headingWhole = whole;
        dom.heading.textContent = padNumber(whole, 3);
        dom.headingName.textContent = HEADING_NAMES[Math.round(whole / 45) % 8];
      }
    }
    landmarkRefreshTimer -= realDt;
    if (landmarkRefreshTimer <= 0) {
      landmarkRefreshTimer = 1;
      refreshNearbyLandmarks();
    }
    const player = state.player.position;
    for (let index = 0; index < landmarkMarkers.length; index++) {
      const marker = landmarkMarkers[index];
      if (marker.site) placeCompassMarker(marker, bearingTo(player.x, player.z, marker.site.x, marker.site.z), heading);
    }
    if (targetState.kind) {
      setCompassMarkerIcon(compassTargetMarker, targetState.kind === 'ring' ? 'dw-i-ring' : 'dw-i-diamond');
      placeCompassMarker(compassTargetMarker, bearingTo(player.x, player.z, targetWorld.x, targetWorld.z), heading);
    }
    setCompassMarkerVisible(compassTargetMarker, Boolean(targetState.kind));
  }

  // ---------------------------------------------------------------------------
  // Flight instruments
  // ---------------------------------------------------------------------------

  function updateInstruments() {
    const player = state.player;
    const speed = Math.round((Number(player.speed) || 0) * 3.6);
    if (speed !== readouts.speed) {
      readouts.speed = speed;
      dom.speed.textContent = String(speed);
    }
    const stalled = Boolean(player.stalled);
    if (stalled !== readouts.stalled) {
      readouts.stalled = stalled;
      dom.speed.style.color = stalled ? 'var(--dw-warn)' : '';
    }
    const altitude = Math.round(Number(player.altitude) || 0);
    if (altitude !== readouts.altitude) {
      readouts.altitude = altitude;
      dom.altitude.textContent = String(altitude);
    }
    const agl = Math.max(0, Math.round(Number(player.agl) || 0));
    if (agl !== readouts.agl) {
      readouts.agl = agl;
      dom.agl.textContent = `${agl} m`;
    }
    const vsiTenths = Math.round((Number(player.verticalSpeed) || 0) * 10);
    if (vsiTenths !== readouts.vsiTenths) {
      readouts.vsiTenths = vsiTenths;
      dom.vsiValue.textContent = `${(Math.abs(vsiTenths) / 10).toFixed(1)} m/s`;
      const trend = vsiTenths >= 5 ? 'up' : vsiTenths <= -5 ? 'down' : 'level';
      if (trend !== readouts.vsiTrend) {
        readouts.vsiTrend = trend;
        dom.vsi.dataset.trend = trend;
      }
    }
    const throttle = clamp(Number(player.throttle) || 0, 0, 1);
    if (!(Math.abs(throttle - readouts.throttle) <= 0.002)) {
      readouts.throttle = throttle;
      dom.throttleFill.style.transform = `scaleX(${throttle.toFixed(3)})`;
      const percent = Math.round(throttle * 100);
      if (percent !== readouts.throttlePercent) {
        readouts.throttlePercent = percent;
        dom.throttleValue.textContent = `${percent}%`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status chips
  // ---------------------------------------------------------------------------
  function updateTimeChip() {
    const time = state.time;
    const minute = Math.floor((((Number(time.dayTime) % 1) + 1) % 1) * 1440) % 1440;
    if (minute !== chipState.minute) {
      chipState.minute = minute;
      dom.timeClock.textContent = `${padNumber(Math.floor(minute / 60), 2)}:${padNumber(minute % 60, 2)}`;
    }
    const label = time.label || '';
    if (label !== chipState.label) {
      chipState.label = label;
      dom.timeLabel.textContent = capitalize(label);
    }
    const phase = time.nightFactor > 0.55 ? 'moon' : time.goldenFactor > 0.45 ? 'sunset' : 'sun';
    if (phase !== chipState.phase) {
      chipState.phase = phase;
      dom.timeChip.dataset.phase = phase;
    }
  }

  function autopilotDetailText() {
    const autopilot = state.player.autopilot;
    const course = state.ringCourse;
    if (autopilot.followWaypoint) {
      if (course && course.active) return 'Following the rings';
      if (state.waypoint) return `To ${state.waypoint.label && state.waypoint.label !== 'Waypoint' ? state.waypoint.label : 'the waypoint'}`;
    }
    const heading = Number.isFinite(autopilot.heading) ? padNumber(Math.round(wrapDegrees(autopilot.heading)) % 360, 3) : padNumber(Math.round(wrapDegrees(state.player.heading)) % 360, 3);
    const altitude = Number.isFinite(autopilot.altitude) ? Math.round(autopilot.altitude) : Math.round(state.player.altitude);
    return `HDG ${heading}° · ${altitude} m`;
  }

  function updateAutopilotChip(realDt) {
    const autopilot = state.player.autopilot;
    const enabled = Boolean(autopilot && autopilot.enabled);
    setRootClass('dw-ap-on', enabled);
    if (!enabled) {
      autopilotDetailTimer = 0;
      return;
    }
    autopilotDetailTimer -= realDt;
    if (autopilotDetailTimer > 0) return;
    autopilotDetailTimer = 0.25;
    const text = autopilotDetailText();
    if (dom.autopilotDetail.textContent !== text) dom.autopilotDetail.textContent = text;
  }

  function updateRingChip() {
    const course = state.ringCourse;
    const total = Math.max(0, Math.round(Number(course.total) || 0));
    const index = Math.min(Math.max(0, Math.round(Number(course.nextIndex) || 0)) + 1, Math.max(total, 1));
    if (index !== chipState.ringIndex) {
      chipState.ringIndex = index;
      dom.ringIndex.textContent = String(index);
    }
    if (total !== chipState.ringTotal) {
      chipState.ringTotal = total;
      dom.ringTotal.textContent = String(total);
    }
    const tenths = Math.floor((Number(course.elapsed) || 0) * 10);
    if (tenths !== chipState.ringTenths) {
      chipState.ringTenths = tenths;
      dom.ringTime.textContent = formatRaceTime(tenths / 10);
    }
    const streak = Math.max(0, Math.round(Number(course.streak) || 0));
    if (streak !== chipState.ringStreak) {
      chipState.ringStreak = streak;
      dom.ringStreakValue.textContent = streak > 0 ? `×${streak}` : '0';
      dom.ringStreak.classList.toggle('dw-hot', streak >= 2);
    }
    if (ringFlashUntil && uiClock >= ringFlashUntil) {
      ringFlashUntil = 0;
      dom.ringChip.classList.remove('dw-flash-pass', 'dw-flash-miss');
    }
  }

  function flashRingChip(className) {
    dom.ringChip.classList.remove('dw-flash-pass', 'dw-flash-miss');
    dom.ringChip.classList.add(className);
    ringFlashUntil = uiClock + 0.7;
  }

  // ---------------------------------------------------------------------------
  // Waypoint / ring target marker (projected + edge chevron)
  // ---------------------------------------------------------------------------
  function resolveTarget() {
    const course = state.ringCourse;
    const player = state.player.position;
    const ring = course && course.active ? course.nextRingPosition : null;
    if (ring && Number.isFinite(ring.x) && Number.isFinite(ring.y) && Number.isFinite(ring.z)) {
      targetWorld.set(ring.x, ring.y, ring.z);
      targetState.kind = 'ring';
      targetState.distance = Number.isFinite(course.nextRingDistance) ? course.nextRingDistance : targetWorld.distanceTo(player);
      targetState.label = `Ring ${Math.max(0, Math.round(Number(course.nextIndex) || 0)) + 1}`;
      return true;
    }
    const waypoint = state.waypoint;
    if (waypoint && Number.isFinite(waypoint.x) && Number.isFinite(waypoint.z)) {
      if (waypoint.x !== targetState.waypointX || waypoint.z !== targetState.waypointZ) {
        targetState.waypointX = waypoint.x;
        targetState.waypointZ = waypoint.z;
        targetState.waypointBase = Math.max(world.groundHeight(waypoint.x, waypoint.z), CONFIG.WATER_LEVEL);
      }
      targetWorld.set(waypoint.x, targetState.waypointBase + 24, waypoint.z);
      targetState.kind = 'waypoint';
      targetState.distance = Math.hypot(waypoint.x - player.x, waypoint.z - player.z);
      targetState.label = typeof waypoint.label === 'string' && waypoint.label.trim() ? waypoint.label.trim() : 'Waypoint';
      return true;
    }
    targetState.kind = null;
    return false;
  }

  function setTargetMode(mode) {
    if (mode === targetState.mode) return;
    if (targetState.mode) dom.target.classList.remove(`dw-mode-${targetState.mode}`);
    targetState.mode = mode;
    dom.target.classList.add(`dw-mode-${mode}`);
  }

  function updateTargetMarker() {
    const hasTarget = targetState.kind !== null;
    setRootClass('dw-has-target', hasTarget);
    if (!hasTarget) return;
    if (targetState.kind !== targetState.shownKind) {
      targetState.shownKind = targetState.kind;
      dom.target.classList.toggle('dw-kind-ring', targetState.kind === 'ring');
    }
    if (targetState.label !== targetState.name) {
      targetState.name = targetState.label;
      dom.targetName.textContent = targetState.label;
    }
    const key = distanceKey(targetState.distance);
    if (key !== targetState.distanceKey) {
      targetState.distanceKey = key;
      const text = formatDistance(targetState.distance);
      dom.targetDistance.textContent = text;
      dom.targetEdgeDistance.textContent = text;
    }
    const near = targetState.kind === 'waypoint' && targetState.distance < 260;
    if (near !== targetState.near) {
      targetState.near = near;
      dom.target.classList.toggle('dw-near', near);
    }

    camera.updateMatrixWorld();
    projected.copy(targetWorld).applyMatrix4(camera.matrixWorldInverse);
    const cameraX = projected.x;
    const cameraY = projected.y;
    const depth = -projected.z;
    const behind = projected.z > -0.5;
    const width = view.width;
    const height = view.height;
    let screenX = 0;
    let screenY = 0;
    let onScreen = false;
    if (!behind) {
      projected.applyMatrix4(camera.projectionMatrix);
      screenX = (projected.x * 0.5 + 0.5) * width;
      screenY = (-projected.y * 0.5 + 0.5) * height;
      onScreen = screenX >= targetMargins.left && screenX <= width - targetMargins.right && screenY >= targetMargins.top && screenY <= height - targetMargins.bottom;
    }
    if (onScreen) {
      setTargetMode('on');
      placeTarget(screenX, screenY);
      placeTargetLabel(screenX, depth, height);
      return;
    }
    const centerX = (targetMargins.left + width - targetMargins.right) * 0.5;
    const centerY = (targetMargins.top + height - targetMargins.bottom) * 0.5;
    const halfX = Math.max(1, (width - targetMargins.left - targetMargins.right) * 0.5);
    const halfY = Math.max(1, (height - targetMargins.top - targetMargins.bottom) * 0.5);
    let directionX;
    let directionY;
    if (behind) {
      // Behind the camera: point sideways toward the shorter turn (flattened
      // vertically), or straight down when the target is dead astern.
      directionX = cameraX;
      directionY = -cameraY * 0.25;
      if (Math.abs(directionX) < Math.abs(projected.z) * 0.12) {
        directionX *= 0.5;
        directionY = Math.abs(directionY) + halfY;
      }
    } else {
      directionX = screenX - centerX;
      directionY = screenY - centerY;
    }
    const scale = Math.min(halfX / Math.max(Math.abs(directionX), 1e-6), halfY / Math.max(Math.abs(directionY), 1e-6));
    setTargetMode('off');
    placeTarget(centerX + directionX * scale, centerY + directionY * scale);
    const angle = Math.atan2(directionY, directionX);
    if (!(Math.abs(angle - targetState.angle) <= 0.004)) {
      targetState.angle = angle;
      dom.targetChevron.style.transform = `rotate(${angle.toFixed(3)}rad)`;
      const labelX = -Math.cos(angle) * 30;
      const labelY = -Math.sin(angle) * 22;
      dom.targetEdgeDistance.style.transform = `translate3d(calc(${labelX.toFixed(1)}px - 50%), calc(${labelY.toFixed(1)}px - 50%), 0)`;
    }
  }

  function placeTarget(x, y) {
    if (Math.abs(x - targetState.x) < 0.25 && Math.abs(y - targetState.y) < 0.25) return;
    targetState.x = x;
    targetState.y = y;
    dom.target.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
  /**
   * The label sits beside the reticle at its height, just clear of the target's projected
   * footprint (the ring itself, or the beacon's ground ring below the reticle), so the target
   * stays visible. It flips to the left when the right side is short of room. When the target
   * fills a large part of the view, the label tucks in next to the reticle inside the opening.
   */
  function placeTargetLabel(screenX, depth, height) {
    const focalPixels = camera.projectionMatrix.elements[5] * height * 0.5;
    const footprint = ((TARGET_FOOTPRINT[targetState.kind] || 0) * focalPixels) / Math.max(depth, 1);
    const clearOffset = footprint + 14;
    const rawOffset = clearOffset <= TARGET_LABEL_MAX_OFFSET ? Math.max(TARGET_LABEL_MIN_OFFSET, clearOffset) : TARGET_LABEL_MIN_OFFSET;
    const offset = Math.round(rawOffset / 2) * 2;
    const roomRight = view.width - screenX - 12;
    const roomLeft = screenX - 12;
    const left = offset + TARGET_LABEL_WIDTH > roomRight && roomLeft > roomRight;
    if (offset === targetState.labelOffset && left === targetState.labelLeft) return;
    targetState.labelOffset = offset;
    if (left !== targetState.labelLeft) {
      targetState.labelLeft = left;
      dom.target.classList.toggle('dw-label-left', left);
    }
    dom.targetLabel.style.transform = left ? `translate3d(calc(${-offset}px - 100%), -50%, 0)` : `translate3d(${offset}px, -50%, 0)`;
  }

  /**
   * The first-run hint shares the bottom centre with the projected marker:
   * while the marker (reticle + label, or edge chevron) overlaps the hint,
   * the hint steps back so the marker stays readable.
   */
  function updateHintDodge(markerVisible) {
    const x = targetState.x;
    const y = targetState.y;
    const overlapping = hintState.visible && markerVisible && x + 64 > hintState.left && x - 64 < hintState.right && y + 66 > hintState.top && y - 70 < hintState.bottom;
    if (overlapping === hintState.dodging) return;
    hintState.dodging = overlapping;
    dom.hint.classList.toggle('dw-dodge', overlapping);
  }
  function measureHint() {
    if (!hintState.visible) return;
    const rect = dom.hint.getBoundingClientRect();
    hintState.left = rect.left;
    hintState.right = rect.right;
    hintState.top = rect.top;
    hintState.bottom = rect.bottom;
  }

  // ---------------------------------------------------------------------------
  // FPS / debug badge
  // ---------------------------------------------------------------------------
  function isDebugVisible() {
    return debugForced || Boolean(settings.get('showFps'));
  }
  function applyDebugVisibility() {
    const visible = isDebugVisible();
    setRootClass('dw-debug-on', visible);
    dom.debug.setAttribute('aria-hidden', String(!visible));
    if (visible) debugTimer = 0;
  }
  // renderer.info is reset at the start of every animation tick (before the
  // systems update), so draw statistics are read in a microtask after render.
  function readRenderStats() {
    const info = renderer.info.render;
    const drawCalls = info.drawCalls ?? info.calls ?? 0;
    dom.debugDraws.textContent = `${drawCalls} draws · ${formatCount(info.triangles)} tris`;
  }
  function updateDebugBadge(realDt) {
    // The dev status badge shows everything this one does and takes its place while visible.
    if (!isDebugVisible() || photoActive || statusBadge.isVisible()) return;
    debugTimer -= realDt;
    if (debugTimer > 0) return;
    debugTimer = 0.5;
    const fps = Math.round(Number(state.perf.fps) || 0);
    dom.debugFps.textContent = String(fps);
    dom.debugMs.textContent = `${(Number(state.perf.frameMs) || 0).toFixed(1)} ms`;
    dom.debug.classList.toggle('dw-fps-ok', fps < 55 && fps >= 40);
    dom.debug.classList.toggle('dw-fps-low', fps < 40);
    const quality = ctx.quality || {};
    dom.debugBackend.textContent = `${ctx.backend} · r${T.REVISION} · ${quality.name || 'auto'}${quality.auto ? ' (auto)' : ''}`;
    const terrainStats = ctx.systems.terrain?.getStats?.();
    if (terrainStats && typeof terrainStats === 'object') {
      const queued = Number(terrainStats.pending) || 0;
      dom.debugChunks.textContent = `${Number(terrainStats.chunks) || 0} chunks${queued ? ` · ${queued} queued` : ''}`;
    } else {
      dom.debugChunks.textContent = 'terrain stats unavailable';
    }
    queueMicrotask(readRenderStats);
  }

  // ---------------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------------
  /**
   * Toasts coalesce by `options.key` (default: the text): a toast whose key is already on
   * screen replaces that one and restarts its timer instead of stacking. At most MAX_TOASTS
   * stay visible. In photo mode nothing is drawn over the view: `options.photo` picks
   * 'defer' (default: shown after photo mode), 'status' (brief line in the photo bar, also the
   * default for warnings) or 'drop'.
   */
  function toast(text, options = {}) {
    const message = String(text ?? '').trim();
    if (!message) return;
    const kind = TOAST_KINDS.has(options.kind) ? options.kind : 'info';
    const duration = Number.isFinite(options.duration) ? clamp(options.duration, 1, 20) : clamp(2.4 + message.length * 0.035, 2.8, 6.5);
    const key = typeof options.key === 'string' && options.key ? options.key : message;
    const wrap = Boolean(options.wrap) || message.length > 72;
    toastSerial++;
    if (photoActive) {
      routePhotoToast(message, key, kind, options);
      return;
    }
    const existing = findToast(key);
    if (existing) {
      refreshToast(existing, message, kind, duration, wrap);
      return;
    }
    const element = document.createElement('div');
    element.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dw-toast-dot';
    const label = document.createElement('span');
    element.append(dot, label);
    const entry = { element, label, key, text: '', kind, wrap, duration, expiresAt: uiClock + duration, leaveAt: null, shownAt: uiClock };
    setToastContent(entry, message, kind, wrap);
    dom.toasts.append(element);
    toasts.push(entry);
    enforceToastCap();
  }

  function setToastContent(entry, message, kind, wrap) {
    entry.text = message;
    entry.kind = kind;
    entry.wrap = wrap;
    entry.element.className = `dw-toast glass dw-toast-${kind}${wrap ? ' dw-toast-wrap' : ''}`;
    entry.label.className = wrap ? 'dw-toast-text dw-wrap' : 'dw-toast-text';
    entry.label.textContent = message;
  }

  function findToast(key) {
    for (let index = toasts.length - 1; index >= 0; index--) {
      if (toasts[index].key === key) return toasts[index];
    }
    return null;
  }

  /** Replaces a toast in place; one on its way out slides back in instead of a new one stacking. */
  function refreshToast(entry, message, kind, duration, wrap) {
    const reviving = entry.leaveAt !== null;
    const changed = entry.text !== message || entry.kind !== kind;
    setToastContent(entry, message, kind, wrap);
    entry.leaveAt = null;
    entry.duration = duration;
    entry.expiresAt = uiClock + duration;
    if (reviving) {
      entry.shownAt = uiClock;
      enforceToastCap();
    } else if (changed && !reducedMotionQuery.matches) {
      entry.element.animate([{ transform: 'scale(1.035)', filter: 'brightness(1.25)' }, { transform: 'none', filter: 'none' }], { duration: 320, easing: 'ease-out' });
    }
  }

  function startToastExit(entry) {
    entry.leaveAt = uiClock + 0.45;
    entry.element.classList.add('dw-leaving');
  }

  /** Oldest toasts beyond the cap leave; at most one extra is still animating out. */
  function enforceToastCap() {
    const maxToasts = view.height < 480 ? 1 : MAX_TOASTS;
    let activeCount = 0;
    for (const entry of toasts) if (entry.leaveAt === null) activeCount++;
    for (const entry of toasts) {
      if (activeCount <= maxToasts) break;
      if (entry.leaveAt === null) {
        startToastExit(entry);
        activeCount--;
      }
    }
    let leavingKept = 0;
    for (let index = toasts.length - 1; index >= 0; index--) {
      const entry = toasts[index];
      if (entry.leaveAt === null) continue;
      if (leavingKept < 1) {
        leavingKept++;
        continue;
      }
      entry.element.remove();
      toasts.splice(index, 1);
    }
  }

  function routePhotoToast(message, key, kind, options) {
    const policy = options.photo || (kind === 'warning' ? 'status' : 'defer');
    if (policy === 'status') showPhotoStatus(message);
    else if (policy === 'defer') deferToast(message, key, { kind, key, duration: options.duration, wrap: options.wrap });
  }

  function deferToast(message, key, options) {
    const index = deferredToasts.findIndex((entry) => entry.key === key);
    if (index >= 0) deferredToasts.splice(index, 1);
    deferredToasts.push({ text: message, key, options, queuedAt: uiClock });
    if (deferredToasts.length > MAX_TOASTS) deferredToasts.shift();
  }

  function flushDeferredToasts() {
    deferredToastFlushAt = 0;
    const pending = deferredToasts.splice(0);
    for (const entry of pending) {
      if (uiClock - entry.queuedAt <= DEFERRED_TOAST_MAX_AGE) toast(entry.text, entry.options);
    }
  }

  /** Photo mode clears the stack at once; toasts that had barely appeared return afterwards. */
  function clearToastsForPhoto() {
    for (const entry of toasts) {
      if (entry.leaveAt === null && uiClock - entry.shownAt < OVERLAY_READ_SECONDS) {
        deferToast(entry.text, entry.key, { kind: entry.kind, key: entry.key, duration: entry.duration, wrap: entry.wrap });
      }
      entry.element.remove();
    }
    toasts.length = 0;
  }

  function updateToasts() {
    if (deferredToastFlushAt && !photoActive && uiClock >= deferredToastFlushAt) flushDeferredToasts();
    for (let index = toasts.length - 1; index >= 0; index--) {
      const entry = toasts[index];
      if (entry.leaveAt === null) {
        if (uiClock >= entry.expiresAt) startToastExit(entry);
      } else if (uiClock >= entry.leaveAt) {
        entry.element.remove();
        toasts.splice(index, 1);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Craft picker, dev status badge
  // ---------------------------------------------------------------------------
  function onModebarChoice() {
    playBlip();
    wake();
  }
  const craftPicker = createCraftPicker({ element: dom.craftPicker, settings, bus, craftRegistry: ctx.craftRegistry, onSelect: onModebarChoice });
  const statusBadge = createStatusBadge({ ctx, root, forced: params.get('debug') === '1' });

  // ---------------------------------------------------------------------------
  // Subtitles, live transcript, first-run hint
  // ---------------------------------------------------------------------------
  function setSubtitle(text, options = {}) {
    const message = String(text ?? '').trim();
    if (!message) {
      hideSubtitle();
      return;
    }
    dom.subtitleText.textContent = message;
    dom.subtitleLabel.textContent = typeof options.label === 'string' && options.label.trim() ? options.label.trim() : 'WREN';
    dom.subtitle.classList.toggle('dw-remote', options.source === 'remote');
    subtitleState.collapseAt = Infinity;
    if (dom.subtitle.classList.contains('dw-gone')) reflowSpeech(() => dom.subtitle.classList.remove('dw-gone'));
    dom.subtitle.classList.add('dw-show');
    subtitleState.visible = true;
    subtitleState.expiresAt = uiClock + (Number.isFinite(options.duration) ? clamp(options.duration, 1, 30) : readingSeconds(message));
    yieldBannerToSpeech();
  }
  /** Fades the subtitle out in place; it leaves the layout only once the fade has finished. */
  function hideSubtitle() {
    if (!subtitleState.visible) return;
    subtitleState.visible = false;
    subtitleState.collapseAt = uiClock + SUBTITLE_FADE_SECONDS;
    dom.subtitle.classList.remove('dw-show');
  }
  function collapseSubtitle() {
    subtitleState.collapseAt = Infinity;
    reflowSpeech(() => dom.subtitle.classList.add('dw-gone'));
  }
  /**
   * Applies a layout change to the speech stack, then glides the first-run hint from where it
   * was (FLIP), so it never jumps into (or through) the space the subtitle leaves.
   */
  function reflowSpeech(change) {
    const before = hintState.visible ? dom.hint.getBoundingClientRect().top : NaN;
    change();
    if (!hintState.visible) return;
    measureHint();
    const offset = before - hintState.top;
    if (Math.abs(offset) < 1 || reducedMotionQuery.matches) return;
    dom.hint.animate([{ translate: `0 ${offset.toFixed(1)}px` }, { translate: '0 0' }], { duration: 480, easing: 'cubic-bezier(0.22, 0.8, 0.26, 1)' });
  }

  function showTranscript(text, final) {
    const message = String(text ?? '').trim();
    if (!message) {
      if (micState === 'listening') {
        dom.transcriptText.textContent = 'Listening';
        transcriptState.expiresAt = Infinity;
        transcriptState.visible = true;
        setRootClass('dw-transcript-on', true);
      }
      return;
    }
    dom.transcriptText.textContent = message;
    transcriptState.visible = true;
    transcriptState.expiresAt = final ? uiClock + 2.8 : Infinity;
    setRootClass('dw-transcript-on', true);
    yieldBannerToSpeech();
  }
  function hideTranscriptSoon(delaySeconds) {
    if (!transcriptState.visible) return;
    transcriptState.expiresAt = Math.min(transcriptState.expiresAt, uiClock + delaySeconds);
  }

  /**
   * The first-run hint strip: the virtual stick, throttle lever, rudder, gear / flaps / airbrake,
   * view cycle, the first / third person swap and the craft ability, from the keyboard bindings
   * (touch: the on-screen controls).
   */
  function renderHint() {
    const throttle = craftHasThrottle();
    if (touchMode) {
      dom.hint.innerHTML = `<span class="dw-hint-item">Drag on the left to steer</span>${throttle ? '<span class="dw-hint-item">Slide right for throttle</span>' : ''}<span class="dw-hint-item">Tap the mic for WREN</span>`;
    } else {
      dom.hint.innerHTML = [
        '<span class="dw-hint-item"><kbd>Click</kbd> virtual stick</span>',
        throttle ? hintItem(['throttle'], 'throttle lever') : '',
        hintItem(['yaw'], 'rudder', 'negative'),
        throttle ? hintItem(['gearToggle', 'flapsDown', 'airbrake'], 'gear, flaps, airbrake') : '',
        hintItem(['viewCycle'], 'view'),
        hintItem(['viewToggle1P3P'], 'cockpit / outside'),
        hintItem(['craftAbility'], abilityLabel().toLowerCase()),
      ].join('');
    }
    if (hintState.visible) measureHint();
  }
  function hintItem(targets, label, order = 'positive') {
    const keys = keyGroupsHtml(targetKeyGroups(targets, { order }));
    return keys ? `<span class="dw-hint-item">${keys} ${escapeHtml(label)}</span>` : '';
  }
  function scheduleFirstRunHint() {
    if (storage.read(FIRST_RUN_KEY, false) === true) return;
    // After the intro banner, so the opening view stays uncluttered.
    hintState.showAt = uiClock + 5.6;
  }

  // ---------------------------------------------------------------------------
  // Key lists (first-run hint, help), read from the keyboard bindings
  // ---------------------------------------------------------------------------
  const ARROW_GLYPHS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const CRAFT_SELECT_TARGETS = ['craftSelect1', 'craftSelect2', 'craftSelect3', 'craftSelect4', 'craftSelect5', 'craftSelect6'];
  const HELP_FLIGHT = [
    { targets: ['throttle'], text: 'Throttle lever up / down' },
    { targets: ['roll'], order: 'negative', text: 'Bank with the ailerons' },
    { targets: ['pitch'], text: 'Nose up / down (Invert pitch in Settings)' },
    { targets: ['yaw'], order: 'negative', text: 'Rudder left / right' },
    { targets: ['trim'], text: 'Pitch trim nose up / down' },
    { targets: ['gearToggle'], text: 'Landing gear up / down' },
    { targets: ['flapsDown', 'flapsUp'], text: 'Flaps down / up' },
    { targets: ['airbrake'], text: 'Airbrake or spoilers (hold); wheel brakes on the ground' },
    { targets: ['viewCycle'], text: 'Cycle the view: chase, cockpit, wing, flyby' },
    { targets: ['viewToggle1P3P'], text: 'Swap between the cockpit and your last outside view' },
    { targets: ['craftAbility'], text: () => `Craft ability: ${abilityLabel()}` },
  ];
  const HELP_SHORTCUTS = [
    { craftKeys: true, text: 'Glider, bush plane, jet, helicopter, wingsuit, FPV drone' },
    { targets: ['craftPrev', 'craftNext'], text: 'Previous / next craft' },
    { targets: ['versionToggle'], text: 'Switch to V1, the original game' },
    { keys: [['Enter'], ['/']], text: 'Ask WREN' },
    { keys: [['M']], text: 'Talk to WREN' },
    { targets: ['copilotPTT'], text: 'Push to talk to WREN (hold)' },
    { targets: ['photoMode'], html: 'Photo mode (<kbd>K</kbd> captures)' },
    { targets: ['journal'], text: 'Journal' },
    { targets: ['settings'], text: 'Settings' },
    { targets: ['controlsPanel'], text: 'Controls: bindings and calibration' },
    { keys: [['H'], ['?']], text: 'This help' },
    { targets: ['timeForward', 'timeBack'], text: 'Next / previous time of day' },
    { targets: ['waypointAhead'], extraKeys: [['X']], text: 'Waypoint ahead / clear it' },
    { targets: ['waypointNearest'], text: 'Waypoint to the nearest landmark' },
    { targets: ['autopilotToggle'], text: 'Autopilot' },
    { targets: ['ringCourse'], text: 'Ring course start / cancel' },
    { targets: ['viewForward', 'viewBack', 'viewLeft', 'viewRight'], text: 'View forward, back, left, right' },
    { targets: ['recenterView'], text: 'Recenter the view' },
    { targets: ['relaunch'], text: 'Relaunch (aerotow, peak or air start)' },
    { targets: ['engineToggle'], text: 'Engine on / off' },
    { targets: ['chuteDeploy'], text: 'Deploy the parachute' },
    { keys: [['Shift', 'V']], text: 'WREN voice on / off' },
    { keys: [['I']], text: 'FPS and stats' },
    { keys: [['Tab']], text: 'Hide or show the HUD' },
    { keys: [['Esc']], text: 'Close a panel or leave photo mode' },
  ];

  /** Craft without a throttle (the glider, the wingsuit): it leaves the hints, the help and the HUD. */
  function craftHasThrottle() {
    const module = ctx.craftRegistry.get(settings.get('craft'));
    return module?.inputProfile?.throttle !== 'none';
  }
  function applyThrottleVisibility() {
    setRootClass('dw-no-throttle', !craftHasThrottle());
  }
  function abilityLabel() {
    const module = ctx.craftRegistry.get(settings.get('craft'));
    return module?.abilities?.craftAbility?.label ?? 'Craft ability';
  }
  /** Keyboard references of a target for the current craft (none before input starts). */
  function keyboardRefs(target) {
    const bindings = ctx.systems.input?.bindings;
    if (!bindings) return [];
    return bindings.getRefs('keyboard', target, settings.get('craft'));
  }
  function keyName(code) {
    return ARROW_GLYPHS[code] ?? ctx.systems.input?.describeRef({ type: 'key', code }, 'keyboard') ?? code;
  }
  /** Key names of one reference: ['Shift', 'F'] or an axis pair ('negative' order puts left / down first). */
  function refKeyNames(ref, order) {
    if (ref.type === 'key') return ref.shift ? ['Shift', keyName(ref.code)] : [keyName(ref.code)];
    if (ref.type === 'keys') return order === 'negative' ? [keyName(ref.negative), keyName(ref.positive)] : [keyName(ref.positive), keyName(ref.negative)];
    return [];
  }
  /** Every key group ([names]) the keyboard binds to targets. */
  function targetKeyGroups(targets, { order = 'positive', filter = null } = {}) {
    const groups = [];
    for (const target of targets) {
      for (const ref of keyboardRefs(target)) {
        if (filter && !filter(ref)) continue;
        const names = refKeyNames(ref, order);
        if (names.length > 0) groups.push(names);
      }
    }
    return groups;
  }
  /** Single keys sit side by side (as v1 listed them); combinations and pairs are split by a slash. */
  function keyGroupsHtml(groups) {
    const separated = groups.length > 1 && groups.some((names) => names.length > 1);
    const parts = groups.map((names) => names.map((name) => `<kbd>${escapeHtml(name)}</kbd>`).join(''));
    if (!separated) return parts.join('');
    // Each combination or pair stays on one line when the list wraps.
    return parts.map((part) => `<span class="dw-key-group">${part}</span>`).join('<span class="dw-key-sep">/</span>');
  }
  /** The six craft keys, as "1-6" when they are the digit row. */
  function craftKeysHtml() {
    const groups = CRAFT_SELECT_TARGETS.map((target) => targetKeyGroups([target])[0] ?? null);
    const digits = groups.every((names, index) => names && names.length === 1 && names[0] === String(index + 1));
    if (digits) return '<kbd>1</kbd><span class="dw-key-sep">-</span><kbd>6</kbd>';
    return keyGroupsHtml(groups.filter(Boolean));
  }
  function helpRowHtml(entry) {
    let keys;
    if (entry.craftKeys) keys = craftKeysHtml();
    else if (entry.keys) keys = keyGroupsHtml(entry.keys);
    else keys = keyGroupsHtml([...targetKeyGroups(entry.targets, entry), ...(entry.extraKeys ?? [])]);
    const text = entry.html ?? escapeHtml(typeof entry.text === 'function' ? entry.text() : entry.text);
    return `<dt>${keys || '<span class="dw-key-word">Unbound</span>'}</dt><dd>${text}</dd>`;
  }
  /** Fills the help panel's key lists from the current bindings. */
  function renderHelp() {
    const versionKey = keyGroupsHtml(targetKeyGroups(['versionToggle'])) || 'The V1 | V2 pill';
    const cycleKey = keyGroupsHtml(targetKeyGroups(['viewCycle'])) || 'Cycle view (unbound)';
    const swapKey = keyGroupsHtml(targetKeyGroups(['viewToggle1P3P'])) || 'First / third person (unbound)';
    dom.helpMode.innerHTML = `Every craft flies the full flight model. The assists (Settings) steady it as much as you like, from 100% down to raw physics. Fly from outside (chase, wing and flyby) or from the cockpit: ${cycleKey} cycles the views and ${swapKey} swaps at once between the cockpit and your last outside view. Each craft remembers its own view, and the view never changes how it flies. ${versionKey} switches to V1, the original game.`;
    const throttle = craftHasThrottle();
    dom.helpFlight.innerHTML = HELP_FLIGHT.filter((entry) => throttle || !(entry.targets && entry.targets.includes('throttle'))).map((entry) => helpRowHtml(entry)).join('');
    dom.helpShortcuts.innerHTML = HELP_SHORTCUTS.map((entry) => helpRowHtml(entry)).join('');
  }
  let helpBindingsWired = false;
  /** Keeps the open help panel and a showing hint current when bindings change. */
  function wireHelpBindings() {
    const bindings = ctx.systems.input?.bindings;
    if (helpBindingsWired || !bindings) return;
    helpBindingsWired = true;
    bindings.onChange(() => {
      if (activePanel === 'help') renderHelp();
      if (hintState.visible) renderHint();
    });
  }

  // ---------------------------------------------------------------------------
  // Banner (biomes, discoveries, course results)
  // ---------------------------------------------------------------------------
  const bannerSwatches = [];
  for (let index = 0; index < 6; index++) {
    const swatch = document.createElement('span');
    bannerSwatches.push(swatch);
  }
  function queueBanner(entry) {
    if (bannerState.queue.some((queued) => queued.title === entry.title)) return;
    bannerState.queue.push(entry);
    if (bannerState.queue.length > 4) bannerState.queue.shift();
  }
  function fillBanner(entry) {
    dom.bannerLabel.textContent = entry.label || '';
    dom.bannerTitle.textContent = entry.title || '';
    dom.bannerDetail.textContent = entry.detail || '';
    const palette = Number.isInteger(entry.paletteIndex) ? world.PALETTES_SRGB[entry.paletteIndex] : null;
    if (Array.isArray(palette)) {
      palette.forEach((hex, index) => {
        if (bannerSwatches[index]) bannerSwatches[index].style.background = hexToCss(hex);
      });
      dom.bannerPalette.replaceChildren(...bannerSwatches.slice(0, palette.length));
    } else {
      dom.bannerPalette.replaceChildren();
    }
  }
  function presentBanner(entry) {
    dom.banner.classList.add('dw-show');
    bannerState.current = entry;
    bannerState.shownAt = uiClock;
    bannerState.phase = 'showing';
    bannerState.until = uiClock + (entry.duration || 4.4);
  }
  /**
   * Hides the banner early (photo mode, a panel covering it, speech taking its slot). A banner
   * cut short before it could be read goes back to the front of the queue.
   */
  function suspendBanner() {
    const current = bannerState.current;
    if (bannerState.phase === 'showing' && current && uiClock - bannerState.shownAt < OVERLAY_READ_SECONDS) {
      if (!bannerState.queue.some((queued) => queued.title === current.title)) bannerState.queue.unshift(current);
    }
    dom.banner.classList.remove('dw-show');
    if (bannerState.phase === 'showing') {
      bannerState.phase = 'leaving';
      bannerState.until = uiClock + (photoActive ? 0 : 1.1);
    }
    bannerState.current = null;
  }
  /** Queued banners wait for the letterbox to clear after photo mode. */
  function resumeBannersAfterPhoto() {
    const earliest = uiClock + 0.9;
    for (const entry of bannerState.queue) entry.notBefore = Math.max(entry.notBefore || 0, earliest);
  }
  /** A biome banner is stale once the glider has left that biome. */
  function isBannerStale(entry) {
    return Boolean(entry.biomeKey) && Boolean(state.player.biome) && state.player.biome.key !== entry.biomeKey;
  }
  function writeBannerVar(name, cacheKey, value) {
    if (bannerCss[cacheKey] === value) return;
    bannerCss[cacheKey] = value;
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  function setBannerColumn(centreX, width) {
    writeBannerVar('--dw-banner-x', 'x', Number.isFinite(centreX) ? `${Math.round(centreX)}px` : '');
    writeBannerVar('--dw-banner-width', 'width', Number.isFinite(width) ? `${Math.round(width)}px` : '');
  }
  function setBannerTop(top) {
    writeBannerVar('--dw-banner-top', 'top', Number.isFinite(top) ? `${Math.round(top)}px` : '');
  }
  /**
   * Positions the banner where nothing covers it: beside an open side panel, or (portrait touch)
   * in a free band above or below the glider. Returns false when there is no room yet.
   */
  function placeBanner() {
    const panelRect = activePanel ? panels[activePanel].getBoundingClientRect() : null;
    bannerState.sharesSpeech = false;
    if (portraitState.active) {
      setBannerColumn(NaN, NaN);
      return placeBannerPortrait(panelRect);
    }
    setBannerTop(NaN);
    if (!panelRect) {
      setBannerColumn(NaN, NaN);
      return true;
    }
    const freeWidth = panelRect.left - 16;
    if (freeWidth < BANNER_MIN_FREE_WIDTH) return false;
    setBannerColumn(8 + freeWidth / 2, Math.min(640, freeWidth - 24));
    return true;
  }
  function placeBannerPortrait(panelRect) {
    const layout = portraitState;
    if (!Number.isFinite(layout.gliderTop)) return !panelRect;
    const floor = panelRect ? Math.min(layout.bottomSlotY, panelRect.top - 8) : layout.bottomSlotY;
    const speechUp = layout.slot === 'top';
    const reserve = Math.max(speechStackHeight(), PORTRAIT_SPEECH_RESERVE) + 8;
    const bands = [
      [speechUp ? layout.topSlotY + reserve : layout.topSlotY, Math.min(layout.gliderTop, floor)],
      [layout.gliderBottom, speechUp ? floor : Math.min(floor, layout.bottomSlotY - reserve)],
    ];
    // While WREN is quiet, the speech slot itself is free for a banner.
    if (!speechStackVisible()) bands.push(speechUp ? [layout.topSlotY, Math.min(layout.gliderTop, floor)] : [layout.gliderBottom, floor]);
    const height = dom.banner.offsetHeight;
    for (let index = 0; index < bands.length; index++) {
      const [start, end] = bands[index];
      if (end - start < height) continue;
      bannerState.sharesSpeech = index === 2;
      setBannerTop(start + Math.min((end - start - height) / 2, 40));
      return true;
    }
    return false;
  }
  /** Speech wins its slot: a banner borrowing that slot steps aside when WREN talks. */
  function yieldBannerToSpeech() {
    if (bannerState.phase === 'showing' && bannerState.sharesSpeech) suspendBanner();
  }
  /** A panel opened or closed: move the showing banner beside it, or hold it until it closes. */
  function refreshBannerPlacement() {
    if (bannerState.phase === 'showing' && !placeBanner()) suspendBanner();
  }
  function updateBanner() {
    if (bannerState.phase === 'showing' && uiClock >= bannerState.until) {
      dom.banner.classList.remove('dw-show');
      bannerState.phase = 'leaving';
      bannerState.current = null;
      bannerState.until = uiClock + 1.3;
    } else if (bannerState.phase === 'leaving' && uiClock >= bannerState.until) {
      bannerState.phase = 'idle';
    }
    if (bannerState.phase !== 'idle' || bannerState.queue.length === 0 || photoActive) return;
    const next = bannerState.queue[0];
    if ((next.notBefore && uiClock < next.notBefore) || uiClock < bannerState.retryAt) return;
    if (isBannerStale(next)) {
      bannerState.queue.shift();
      return;
    }
    fillBanner(next);
    if (!placeBanner()) {
      bannerState.retryAt = uiClock + 0.25;
      return;
    }
    bannerState.queue.shift();
    presentBanner(next);
  }
  function startIntroBanner() {
    introState.phase = 'waiting';
    introState.key = null;
    introState.startedAt = uiClock;
    introState.timer = 0;
  }
  function biomeKeyAhead(metres) {
    const player = state.player;
    if (!Number.isFinite(player.heading) || !isFiniteVector(player.position)) return null;
    const forward = vectorFromHeading(player.heading);
    const info = world.biomeAt(player.position.x + forward.x * metres, player.position.z + forward.z * metres);
    return info ? info.key : null;
  }
  /**
   * "Now flying over X" names the biome the player is actually seeing: it waits until the biome
   * under the glider has held for a moment and matches the ground ahead (or patience runs out).
   */
  function updateIntroBanner(step) {
    if (introState.phase !== 'waiting') return;
    introState.timer -= step;
    if (introState.timer > 0) return;
    introState.timer = 0.25;
    const biome = state.player.biome;
    const waited = uiClock - introState.startedAt;
    if (waited >= INTRO_GIVE_UP_SECONDS) {
      introState.phase = 'done';
      return;
    }
    if (!biome || !biome.key) return;
    if (biome.key !== introState.key) {
      introState.key = biome.key;
      introState.stableSince = uiClock;
    }
    if (uiClock - introState.stableSince < INTRO_STABLE_SECONDS) return;
    if (waited < INTRO_AHEAD_PATIENCE && biomeKeyAhead(INTRO_AHEAD_METRES) !== biome.key) return;
    introState.phase = 'done';
    biomeBannerState.lastKey = biome.key;
    biomeBannerState.lastShownAt = uiClock;
    biomeBannerState.suppressUntil = uiClock + BIOME_QUIET_AFTER_INTRO;
    queueBanner({ label: 'Now flying over', title: biome.name, detail: introDetail(biome), paletteIndex: biome.index, biomeKey: biome.key });
  }
  /** WREN's own description of the view (e.g. "meadows at the foot of the Snow Peaks") when it adds nuance. */
  function introDetail(biome) {
    if (typeof Copilot !== 'function' || typeof Copilot.describePlace !== 'function') return '';
    const player = state.player;
    const place = Copilot.describePlace(world, player.position.x, player.position.z, player.groundHeight, player.heading);
    if (!place || !place.phrase || place.phrase === `the ${biome.name}`) return '';
    return place.phrase.charAt(0).toUpperCase() + place.phrase.slice(1);
  }
  function updatePendingBiome() {
    const pending = biomeBannerState.pending;
    if (!pending || introState.phase === 'waiting' || uiClock < biomeBannerState.suppressUntil) return;
    if (uiClock - biomeBannerState.pendingSince < 1.2 || uiClock - biomeBannerState.lastShownAt < 10) return;
    biomeBannerState.pending = null;
    if (pending.key === biomeBannerState.lastKey) return;
    biomeBannerState.lastKey = pending.key;
    biomeBannerState.lastShownAt = uiClock;
    queueBanner({ label: 'Entering', title: pending.name, paletteIndex: pending.index, biomeKey: pending.key });
  }

  // ---------------------------------------------------------------------------
  // Portrait touch layout: the speech stack and banner keep clear of the glider
  // ---------------------------------------------------------------------------
  function speechStackVisible() {
    return subtitleState.visible || hintState.visible || transcriptState.visible;
  }
  function speechStackHeight() {
    return speechStackVisible() ? dom.speech.getBoundingClientRect().height : 0;
  }
  /** Screen-space vertical extent of the glider in CSS px (wings clipped at the screen edges). */
  function measureGliderSpan() {
    const player = state.player;
    if (!isFiniteVector(player.position) || !isFiniteQuaternion(player.quaternion)) return false;
    projected.copy(player.position).project(camera);
    if (!(projected.z < 1)) return false;
    const centreX = (projected.x + 1) * 0.5 * view.width;
    const centreY = (1 - projected.y) * 0.5 * view.height;
    let top = centreY;
    let bottom = centreY;
    for (const [x, y, z] of GLIDER_OUTLINE) {
      gliderPoint.set(x, y, z).applyQuaternion(player.quaternion).add(player.position);
      projected.copy(gliderPoint).project(camera);
      if (!(projected.z < 1)) continue;
      const screenX = (projected.x + 1) * 0.5 * view.width;
      let screenY = (1 - projected.y) * 0.5 * view.height;
      if ((screenX < 0 || screenX > view.width) && Math.abs(screenX - centreX) > 1) {
        const along = ((screenX < 0 ? 0 : view.width) - centreX) / (screenX - centreX);
        screenY = centreY + (screenY - centreY) * clamp(along, 0, 1);
      }
      top = Math.min(top, screenY);
      bottom = Math.max(bottom, screenY);
    }
    portraitState.gliderTop = top - PORTRAIT_GLIDER_PADDING;
    portraitState.gliderBottom = bottom + PORTRAIT_GLIDER_PADDING;
    return true;
  }
  /** The top slot starts under the HUD cards and the toast lane; the bottom slot ends above the touch controls. */
  function measurePortraitSlots() {
    const cardsBottom = Math.max(dom.chips.getBoundingClientRect().bottom, dom.flightCard.getBoundingClientRect().bottom);
    const controlsTop = Math.min(dom.throttleSlider.getBoundingClientRect().top, dom.actionCluster.getBoundingClientRect().top);
    portraitState.topSlotY = Math.round(cardsBottom + PORTRAIT_TOAST_LANE);
    portraitState.bottomSlotY = Math.round(controlsTop - 10);
  }
  function gliderOverlap(start, end) {
    return Math.max(0, Math.min(end, portraitState.gliderBottom) - Math.max(start, portraitState.gliderTop));
  }
  function writeSpeechVar(name, cacheKey, value) {
    if (portraitState[cacheKey] === value) return;
    portraitState[cacheKey] = value;
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  function applySpeechSlot() {
    const layout = portraitState;
    writeSpeechVar('--dw-speech-top', 'cssTop', layout.active ? `${layout.topSlotY}px` : '');
    writeSpeechVar('--dw-speech-bottom', 'cssBottom', layout.active ? `${Math.max(0, Math.round(view.height - layout.bottomSlotY))}px` : '');
    setRootClass('dw-speech-top', layout.active && layout.slot === 'top');
  }
  /**
   * Portrait phones: dock WREN's speech stack above the touch controls, or under the HUD cards
   * when the glider sits low on screen, whichever keeps it off the aircraft. A slot change
   * while text is showing must persist for a moment first, so the stack never flickers.
   */
  function updatePortraitLayout(step) {
    const active = touchMode && view.height > view.width && state.ready && !photoActive;
    if (active !== portraitState.active) {
      portraitState.active = active;
      portraitState.timer = 0;
      if (!active) {
        portraitState.slot = 'bottom';
        portraitState.gliderTop = NaN;
        applySpeechSlot();
      }
    }
    if (!active) return;
    portraitState.timer -= step;
    if (portraitState.timer > 0) return;
    portraitState.timer = PORTRAIT_CHECK_SECONDS;
    if (!measureGliderSpan()) return;
    measurePortraitSlots();
    const reserve = Math.max(speechStackHeight(), PORTRAIT_SPEECH_RESERVE);
    const bottomOverlap = gliderOverlap(portraitState.bottomSlotY - reserve, portraitState.bottomSlotY);
    const topOverlap = gliderOverlap(portraitState.topSlotY, portraitState.topSlotY + reserve);
    const wanted = topOverlap + 8 < bottomOverlap ? 'top' : 'bottom';
    if (wanted === portraitState.slot) {
      portraitState.pendingSlot = wanted;
    } else if (!speechStackVisible()) {
      portraitState.slot = wanted;
    } else if (portraitState.pendingSlot !== wanted) {
      portraitState.pendingSlot = wanted;
      portraitState.pendingSince = uiClock;
    } else if (uiClock - portraitState.pendingSince >= PORTRAIT_SLOT_SWITCH_SECONDS) {
      portraitState.slot = wanted;
    }
    applySpeechSlot();
  }

  // ---------------------------------------------------------------------------
  // Mic state
  // ---------------------------------------------------------------------------
  /** Tooltip + accessible name for the mic; touch wording has no key hints. */
  function applyMicTip() {
    const tip = touchMode ? MIC_TIPS_TOUCH[micState] : MIC_TIPS[micState];
    dom.mic.dataset.tip = tip;
    dom.mic.setAttribute('aria-label', tip);
  }
  function setMicState(nextState, message) {
    const next = MIC_STATES.has(nextState) ? nextState : 'idle';
    micState = next;
    dom.mic.dataset.state = next;
    applyMicTip();
    dom.mic.setAttribute('aria-pressed', String(next === 'listening'));
    dom.mic.setAttribute('aria-disabled', String(next === 'unsupported'));
    setRootClass('dw-listening', next === 'listening');
    setRootClass('dw-mic-unsupported', next === 'unsupported');
    micErrorResetAt = next === 'error' ? uiClock + 2.6 : 0;
    if (next === 'listening') {
      showTranscript('', false);
      wake();
    } else if (next === 'thinking') {
      hideTranscriptSoon(3.5);
    } else {
      hideTranscriptSoon(1.4);
    }
    if (next === 'error' && typeof message === 'string' && message.trim() && !subtitleState.visible) setSubtitle(message);
  }

  function toggleMic() {
    if (micState === 'unsupported') {
      toast('Voice input is not available in this browser. You can type to WREN instead.', { key: 'mic', photo: 'status' });
      openCommandBar();
      return;
    }
    playBlip();
    bus.emit('mic:toggle', {});
  }

  // ---------------------------------------------------------------------------
  // Actions (hotkeys and buttons route through the copilot's executor)
  // ---------------------------------------------------------------------------
  function showActionResult(result, serialBefore) {
    if (typeof result === 'string' && result.trim() && toastSerial === serialBefore) toast(result.trim());
  }
  function runAction(action) {
    const serialBefore = toastSerial;
    let result;
    try {
      result = ctx.executeAction(action);
    } catch (error) {
      console.error('[DRIFTWING] UI action failed', action, error);
      toast('That did not work just now.', { kind: 'warning' });
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(
        (text) => showActionResult(text, serialBefore),
        (error) => {
          console.error('[DRIFTWING] UI action failed', action, error);
          toast('That did not work just now.', { kind: 'warning' });
        },
      );
      return;
    }
    showActionResult(result, serialBefore);
  }

  function cycleTimePreset() {
    let nextIndex;
    if (lastTimePreset && uiClock - lastTimePresetAt < 8) {
      nextIndex = (TIME_CYCLE.indexOf(lastTimePreset) + 1) % TIME_CYCLE.length;
    } else {
      const dayTime = ((Number(state.time.dayTime) % 1) + 1) % 1;
      if (dayTime >= 0.2 && dayTime < 0.4) nextIndex = 1;
      else if (dayTime >= 0.4 && dayTime < 0.68) nextIndex = 2;
      else if (dayTime >= 0.68 && dayTime < 0.8) nextIndex = 3;
      else nextIndex = 0;
    }
    lastTimePreset = TIME_CYCLE[nextIndex];
    lastTimePresetAt = uiClock;
    runAction({ type: 'time', preset: lastTimePreset });
  }

  function toggleAutopilot() {
    const enabled = Boolean(state.player.autopilot && state.player.autopilot.enabled);
    if (enabled) {
      runAction({ type: 'autopilot', enabled: false });
      return;
    }
    const hasTarget = Boolean(state.waypoint || (state.ringCourse && state.ringCourse.active));
    runAction({ type: 'autopilot', enabled: true, followWaypoint: hasTarget });
  }

  function toggleRingCourse() {
    if (state.ringCourse && state.ringCourse.active) runAction({ type: 'cancelRingCourse' });
    else runAction({ type: 'ringCourse', count: 10 });
  }

  function setWaypointAhead() {
    runAction({ type: 'waypoint', bearing: Math.round(wrapDegrees(Number(state.player.heading) || 0)), distance: 1500 });
  }

  function clearWaypoint() {
    if (!state.waypoint) {
      toast('There is no waypoint to clear.', { key: 'waypoint' });
      return;
    }
    runAction({ type: 'clearWaypoint' });
  }

  function captureScreenshot() {
    if (typeof ctx.requestScreenshot === 'function') ctx.requestScreenshot({ scale: 1.5 });
  }

  function togglePhotoMode(active) {
    if (typeof ctx.setPhotoMode === 'function') ctx.setPhotoMode(active);
  }

  function toggleVoice() {
    const next = !settings.get('copilotVoice');
    settings.set('copilotVoice', next);
    toast(next ? 'WREN voice on' : 'WREN voice off. Subtitles only', { key: 'voice', photo: 'status' });
  }

  function toggleFpsBadge() {
    if (isDebugVisible()) {
      debugForced = false;
      if (settings.get('showFps')) settings.set('showFps', false);
      else applyDebugVisibility();
    } else {
      settings.set('showFps', true);
    }
  }

  function toggleHud() {
    hudHiddenByUser = !hudHiddenByUser;
    setRootClass('dw-hud-off', hudHiddenByUser);
    if (hudHiddenByUser && !hudHiddenToastShown) {
      hudHiddenToastShown = true;
      toast('HUD hidden. Press Tab to bring it back.');
    }
    if (!hudHiddenByUser) wake();
  }

  // ---------------------------------------------------------------------------
  // Seed chip: share link and new world
  // ---------------------------------------------------------------------------
  /** Share links open V2 through the launcher shell (/?v=2), which forwards #seed= to V2. */
  function shareUrl() {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('v', '2');
    url.hash = new URLSearchParams({ seed: state.seed }).toString();
    return url.toString();
  }
  function copyWithSelection(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-200px;left:0;width:10px;height:10px;opacity:0;';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    area.remove();
    return copied;
  }
  function writeClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => copyWithSelection(text),
      );
    }
    return Promise.resolve(copyWithSelection(text));
  }
  function copyShareLink() {
    const link = shareUrl();
    writeClipboard(link).then((copied) => {
      if (copied) toast('Share link copied. Anyone who opens it flies this same world.', { kind: 'success' });
      else toast(`Share this world: ${link}`, { duration: 10, wrap: true });
    });
  }
  function randomSeed() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => SEED_ALPHABET[byte % SEED_ALPHABET.length]).join('');
  }
  function navigateToSeed(seed) {
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed.toUpperCase());
    window.location.assign(url.toString());
  }
  function setNewWorldConfirm(active) {
    dom.newWorld.classList.toggle('dw-confirm', active);
    dom.menuNewWorld.classList.toggle('dw-confirm', active);
    dom.newWorldLabel.textContent = active ? 'Confirm new world' : 'New world';
    const menuLabel = dom.menuNewWorld.querySelector('span');
    if (menuLabel) menuLabel.textContent = active ? 'Tap again for a new world' : 'New world';
  }
  function requestNewWorld() {
    if (newWorldConfirmUntil && uiClock < newWorldConfirmUntil) {
      newWorldConfirmUntil = 0;
      navigateToSeed(randomSeed());
      return;
    }
    newWorldConfirmUntil = uiClock + 3.2;
    setNewWorldConfirm(true);
  }

  // ---------------------------------------------------------------------------
  // Command bar
  // ---------------------------------------------------------------------------
  function setQuickChip(button, label, command) {
    if (button.textContent !== label) button.textContent = label;
    button.dataset.command = command;
  }
  function refreshQuickChips() {
    const autopilotOn = Boolean(state.player.autopilot && state.player.autopilot.enabled);
    if (autopilotOn) setQuickChip(dom.quickAutopilot, 'Autopilot off', 'autopilot off');
    else if (state.waypoint) setQuickChip(dom.quickAutopilot, 'Take us there', 'take us there');
    else setQuickChip(dom.quickAutopilot, 'Autopilot on', 'autopilot on');
    if (state.waypoint) setQuickChip(dom.quickWaypoint, 'Clear waypoint', 'clear the waypoint');
    else setQuickChip(dom.quickWaypoint, 'Set waypoint', 'set a waypoint ahead');
    if (state.ringCourse && state.ringCourse.active) setQuickChip(dom.quickRings, 'Cancel course', 'cancel the ring course');
    else setQuickChip(dom.quickRings, 'Ring course', 'start a ring course');
  }
  function openCommandBar(prefill = '') {
    if (photoActive) return;
    if (activePanel === 'menu' || (touchMode && activePanel)) showPanel(null);
    refreshQuickChips();
    commandOpen = true;
    commandHistoryIndex = -1;
    setRootClass('dw-command-open', true);
    dom.command.setAttribute('aria-hidden', 'false');
    dom.commandButton.setAttribute('aria-pressed', 'true');
    dom.commandInput.value = prefill;
    releasePointerLock();
    dom.commandInput.focus({ preventScroll: true });
    wake();
  }
  /** Moves focus out of a container before it is hidden (aria-hidden must never hide focus). */
  function releaseFocusWithin(container) {
    const focused = document.activeElement;
    if (focused && focused !== document.body && container.contains(focused) && typeof focused.blur === 'function') focused.blur();
  }
  function closeCommandBar() {
    if (!commandOpen) return;
    commandOpen = false;
    releaseFocusWithin(dom.command);
    setRootClass('dw-command-open', false);
    dom.command.setAttribute('aria-hidden', 'true');
    dom.commandButton.setAttribute('aria-pressed', 'false');
    wake();
  }
  function submitCommand(text) {
    const phrase = String(text ?? '').trim().slice(0, 200);
    if (!phrase) {
      closeCommandBar();
      return;
    }
    if (commandHistory[0] !== phrase) {
      commandHistory.unshift(phrase);
      if (commandHistory.length > COMMAND_HISTORY_LIMIT) commandHistory.pop();
    }
    playBlip();
    showTranscript(phrase, true);
    closeCommandBar();
    bus.emit('ui:command', { text: phrase });
  }
  function recallHistory(step) {
    if (commandHistory.length === 0) return;
    commandHistoryIndex = clamp(commandHistoryIndex + step, -1, commandHistory.length - 1);
    dom.commandInput.value = commandHistoryIndex >= 0 ? commandHistory[commandHistoryIndex] : '';
    const end = dom.commandInput.value.length;
    dom.commandInput.setSelectionRange(end, end);
  }

  // ---------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------
  function showPanel(name) {
    const next = name && panels[name] ? name : null;
    if (next && photoActive) return false;
    if (next === activePanel) {
      if (next === 'journal') renderJournal();
      return true;
    }
    if (activePanel === 'controls') controlsPanel.onClose();
    for (const [panelName, panel] of Object.entries(panels)) {
      const open = panelName === next;
      if (!open) releaseFocusWithin(panel);
      panel.classList.toggle('dw-open', open);
      panel.setAttribute('aria-hidden', String(!open));
      if (panelButtons[panelName]) panelButtons[panelName].setAttribute('aria-pressed', String(open));
    }
    activePanel = next;
    setRootClass('dw-panel-open', Boolean(next));
    refreshBannerPlacement();
    if (next) {
      if (touchMode && commandOpen) closeCommandBar();
      releasePointerLock();
      if (next === 'journal') renderJournal();
      if (next === 'settings') settingsPanel.syncAll();
      if (next === 'controls') controlsPanel.onOpen();
      if (next === 'help') {
        wireHelpBindings();
        renderHelp();
      }
      if (next === 'menu') dom.menuSeed.textContent = `Seed ${state.seed}`;
      journalStatsTimer = 2;
      playBlip();
      wake();
    }
    return true;
  }
  function togglePanel(name) {
    showPanel(activePanel === name ? null : name);
  }
  /**
   * Opens the controls panel ('controlsPanel' action, the settings button, or the bus event
   * 'ui:openControls' { calibrate } the copilot sends for "calibrate controls"); calibrate starts
   * the calibration wizard for every connected controller. Leaves photo mode first.
   */
  function openControls(options = {}) {
    if (photoActive) togglePhotoMode(false);
    if (!showPanel('controls')) return false;
    if (options && options.calibrate) return controlsPanel.startCalibration(null);
    return true;
  }

  // ---- Journal ------------------------------------------------------------------
  function statCard(label, parts, statKey) {
    return `<div class="dw-stat"><span class="dw-micro">${escapeHtml(label)}</span><span class="dw-stat-value" data-stat="${statKey}">${escapeHtml(parts[0])}<small>${escapeHtml(parts[1])}</small></span></div>`;
  }
  function journalStatParts(data) {
    const landmarks = Array.isArray(data.landmarksFound) ? data.landmarksFound.length : 0;
    return {
      distance: distanceParts(data.distanceFlown),
      time: durationParts(data.flightTime),
      altitude: [String(Math.round(Math.max(0, Number(data.maxAltitude) || 0))), 'm'],
      landmarks: [String(landmarks), landmarks === 1 ? 'landmark' : 'landmarks'],
    };
  }
  function renderJournal() {
    dom.journalSeed.textContent = `Seed ${state.seed}`;
    const data = ctx.systems.journal?.getData?.();
    if (!data || typeof data !== 'object') {
      dom.journalBody.innerHTML = '<p class="dw-empty">The journal is not available in this session.</p>';
      journalStatElements.distance = null;
      return;
    }
    const visited = new Set(Array.isArray(data.biomesVisited) ? data.biomesVisited : []);
    const currentKey = state.player.biome ? state.player.biome.key : null;
    const landmarks = Array.isArray(data.landmarksFound) ? data.landmarksFound : [];
    const ringData = data.ringCourses && typeof data.ringCourses === 'object'
      ? data.ringCourses
      : { completed: 0, bestStreak: data.bestRingStreak, bestTime: data.bestRingTime };
    const stats = journalStatParts(data);
    const html = [];
    html.push('<div class="dw-stats">');
    html.push(statCard('Distance flown', stats.distance, 'distance'));
    html.push(statCard('Time aloft', stats.time, 'time'));
    html.push(statCard('Highest point', stats.altitude, 'altitude'));
    html.push(statCard('Discovered', stats.landmarks, 'landmarks'));
    html.push('</div>');

    html.push('<div class="dw-group"><h3 class="dw-micro">Biomes</h3><div class="dw-biomes">');
    for (const biome of world.BIOMES) {
      const here = biome.key === currentKey;
      const seen = here || visited.has(biome.key);
      const swatch = (world.PALETTES_SRGB[biome.index] || []).map((hex) => `<span style="background:${hexToCss(hex)}"></span>`).join('');
      const status = here ? 'Here now' : seen ? 'Visited' : 'Not yet';
      html.push(`<div class="dw-biome${seen ? ' dw-visited' : ''}${here ? ' dw-current' : ''}"><div class="dw-swatch">${swatch}</div><span class="dw-biome-name">${escapeHtml(biome.name)}</span><span class="dw-biome-state">${status}</span></div>`);
    }
    html.push('</div></div>');

    html.push('<div class="dw-group"><h3 class="dw-micro">Landmarks</h3>');
    if (landmarks.length === 0) {
      html.push('<p class="dw-empty">None yet. Stone arches, standing stones, lighthouses and balloon meets are scattered across this world. Ask WREN to find one.</p>');
    } else {
      html.push('<ul class="dw-landmarks">');
      for (let index = landmarks.length - 1; index >= 0 && index >= landmarks.length - 60; index--) {
        const landmark = landmarks[index] || {};
        const type = LANDMARK_TYPE_LABELS[landmark.type] ? landmark.type : 'arch';
        html.push(`<li class="dw-landmark"><span class="dw-landmark-icon"><svg class="dw-icon"><use href="#dw-i-${type}"/></svg></span><span><span class="dw-landmark-name">${escapeHtml(landmark.name || LANDMARK_TYPE_LABELS[type])}</span><br><span class="dw-landmark-meta">${escapeHtml(LANDMARK_TYPE_LABELS[type])} · ${escapeHtml(biomeNameFor(landmark.biome))}</span></span></li>`);
      }
      html.push('</ul>');
    }
    html.push('</div>');

    const completed = Math.max(0, Math.round(Number(ringData.completed) || 0));
    const bestStreak = Math.max(0, Math.round(Number(ringData.bestStreak) || 0));
    const bestTime = Number(ringData.bestTime);
    html.push('<div class="dw-group"><h3 class="dw-micro">Ring courses</h3><div class="dw-ring-bests">');
    html.push(statCard('Flown', [String(completed), ''], 'rings-completed'));
    html.push(statCard('Streak', [String(bestStreak), bestStreak === 1 ? 'ring' : 'rings'], 'rings-streak'));
    html.push(statCard('Best', Number.isFinite(bestTime) && bestTime > 0 ? [formatRaceTime(bestTime), ''] : ['None', ''], 'rings-time'));
    html.push('</div></div>');
    html.push(landingsHtml(data.landings));

    dom.journalBody.innerHTML = html.join('');
    journalStatElements.distance = dom.journalBody.querySelector('[data-stat="distance"]');
    journalStatElements.time = dom.journalBody.querySelector('[data-stat="time"]');
    journalStatElements.altitude = dom.journalBody.querySelector('[data-stat="altitude"]');
    journalStatElements.landmarks = dom.journalBody.querySelector('[data-stat="landmarks"]');
  }
  function craftNameFor(craftId) {
    return ctx.craftRegistry.catalog.find((entry) => entry.id === craftId)?.name ?? capitalize(craftId || 'unknown craft');
  }
  /** Touchdown sink rate in the player's units, with the other unit alongside. */
  function formatSinkRate(sinkRate) {
    const feetPerMinute = Math.round((sinkRate * 196.85) / 10) * 10;
    return settings.get('units') === 'aviation' ? `${feetPerMinute} fpm (${sinkRate.toFixed(1)} m/s)` : `${sinkRate.toFixed(1)} m/s (${feetPerMinute} fpm)`;
  }
  function formatGroundSpeed(metresPerSecond) {
    return settings.get('units') === 'aviation' ? `${Math.round(metresPerSecond * 1.943844)} kt` : `${Math.round(metresPerSecond * 3.6)} km/h`;
  }
  function formatWhen(epochMs) {
    if (!(epochMs > 0)) return '';
    const seconds = (Date.now() - epochMs) / 1000;
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
    return new Date(epochMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  /** Journal section for graded landings: the best one (grade, sink rate, craft, when), count and last. */
  function landingsHtml(landings) {
    const html = ['<div class="dw-group"><h3 class="dw-micro">Landings</h3>'];
    const best = landings && landings.best;
    if (!best || !LANDING_GRADE_LABELS[best.grade]) {
      html.push('<p class="dw-empty">No graded landings yet. Every touchdown is graded butter, smooth, firm or hard, and the best one is kept here.</p></div>');
      return html.join('');
    }
    const meta = [craftNameFor(best.craft), `${formatGroundSpeed(best.groundSpeed)} over the ground`, formatWhen(best.at)].filter(Boolean).join(' · ');
    html.push(`<div class="dw-landing-best dw-grade-${best.grade}" data-landing-grade="${best.grade}"><span class="dw-landing-grade">${LANDING_GRADE_LABELS[best.grade]}</span><span class="dw-landing-detail"><span>Best landing: ${escapeHtml(formatSinkRate(best.sinkRate))} sink</span><span class="dw-landing-meta">${escapeHtml(meta)}</span></span></div>`);
    const count = Math.max(0, Math.round(Number(landings.count) || 0));
    const last = landings.last && LANDING_GRADE_LABELS[landings.last.grade] ? landings.last : null;
    html.push('<div class="dw-landing-bests">');
    html.push(statCard('Graded', [String(count), count === 1 ? 'landing' : 'landings'], 'landings-count'));
    html.push(statCard('Last', last ? [LANDING_GRADE_LABELS[last.grade], formatSinkRate(last.sinkRate).split(' (')[0]] : ['None', ''], 'landings-last'));
    html.push('</div></div>');
    return html.join('');
  }
  function writeStat(element, parts) {
    if (!element) return;
    const valueNode = element.firstChild;
    const unitNode = element.lastChild;
    if (valueNode && valueNode.nodeType === 3 && valueNode.nodeValue !== parts[0]) valueNode.nodeValue = parts[0];
    if (unitNode && unitNode.textContent !== parts[1]) unitNode.textContent = parts[1];
  }
  function updateJournalStats(realDt) {
    journalStatsTimer -= realDt;
    if (journalStatsTimer > 0 || !journalStatElements.distance) return;
    journalStatsTimer = 2;
    const data = ctx.systems.journal?.getData?.();
    if (!data || typeof data !== 'object') return;
    const stats = journalStatParts(data);
    writeStat(journalStatElements.distance, stats.distance);
    writeStat(journalStatElements.time, stats.time);
    writeStat(journalStatElements.altitude, stats.altitude);
    writeStat(journalStatElements.landmarks, stats.landmarks);
  }

  // ---- Settings and controls ------------------------------------------------------
  const settingsPanel = createSettingsPanel({ panel: panels.settings, ctx, toast, navigateToSeed });
  const controlsPanel = createControlsPanel({ panel: panels.controls, ctx });

  // ---------------------------------------------------------------------------
  // Photo mode chrome
  // ---------------------------------------------------------------------------
  function renderPhotoChrome() {
    photoState.refreshTimer = 0;
    renderPhotoMeta();
    dom.photoHint.innerHTML = touchMode
      ? 'Drag on the left to look around'
      : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Q</kbd><kbd>E</kbd> down / up · Mouse look · Wheel zoom · <kbd>Shift</kbd> faster';
  }
  /**
   * Live time label for the photo bar. While a requested time change is still easing the sky
   * toward its target, the target's label is shown (the clock itself stays live).
   */
  function photoMetaText() {
    const time = state.time;
    const label = photoState.targetLabel && uiClock < photoState.targetUntil ? photoState.targetLabel : time.label || '';
    return `${capitalize(label)} · ${formatClock(Number(time.dayTime) || 0)} · Seed ${state.seed}`;
  }
  /** Writes the photo bar meta line (or a brief status such as a saved photo) when it changes. */
  function renderPhotoMeta() {
    const status = photoState.statusText && uiClock < photoState.statusUntil ? photoState.statusText : '';
    const text = status || photoMetaText();
    if (text !== photoState.metaText) {
      photoState.metaText = text;
      dom.photoMeta.textContent = text;
    }
    const statusShown = Boolean(status);
    if (statusShown !== photoState.statusShown) {
      photoState.statusShown = statusShown;
      dom.photoMeta.classList.toggle('dw-photo-status', statusShown);
    }
  }
  function showPhotoStatus(text) {
    photoState.statusText = text;
    photoState.statusUntil = uiClock + clamp(1.8 + text.length * 0.03, 2.4, 4.5);
    renderPhotoMeta();
  }
  function updatePhotoChrome(step) {
    photoState.refreshTimer -= step;
    if (photoState.refreshTimer > 0) return;
    photoState.refreshTimer = 0.5;
    renderPhotoMeta();
  }
  function setPhotoMode(active) {
    const next = Boolean(active);
    if (next === photoActive) return;
    photoActive = next;
    if (!next) releaseFocusWithin(dom.photo);
    setRootClass('dw-photo-on', next);
    dom.photo.setAttribute('aria-hidden', String(!next));
    if (next) {
      closeCommandBar();
      showPanel(null);
      suspendBanner();
      clearToastsForPhoto();
      photoState.statusText = '';
      renderPhotoChrome();
    } else {
      resumeBannersAfterPhoto();
      if (deferredToasts.length > 0) deferredToastFlushAt = uiClock + 0.7;
      // A first-run hint paused by photo mode gets enough time to be read again.
      if (hintState.visible) hintState.hideAt = Math.max(hintState.hideAt, uiClock + 3);
    }
    if (touchMode) {
      releaseStick();
      measureTouchControls();
    }
    wake();
  }
  function playShutterFlash() {
    const peak = reducedMotionQuery.matches ? 0.25 : 0.62;
    dom.flash.animate([{ opacity: 0 }, { opacity: peak, offset: 0.12 }, { opacity: 0 }], { duration: reducedMotionQuery.matches ? 260 : 560, easing: 'ease-out' });
  }

  // ---------------------------------------------------------------------------
  // Touch controls
  // ---------------------------------------------------------------------------
  const stickState = { pointerId: null, captured: false, originX: 0, originY: 0, homeX: 0, homeY: 0, radius: 54 };
  const sliderState = { pointerId: null, captured: false, top: 0, span: 1, travel: 172, value: NaN };

  function measureTouchControls() {
    if (!touchMode) return;
    if (stickState.pointerId === null) {
      const rect = dom.stick.getBoundingClientRect();
      stickState.homeX = rect.left + rect.width / 2;
      stickState.homeY = rect.top + rect.height / 2;
      stickState.radius = Math.max(30, rect.width * 0.4);
    }
    sliderState.travel = Math.max(40, dom.throttleSlider.clientHeight - 24);
    sliderState.value = NaN;
  }
  function enableTouchMode() {
    if (touchMode) return;
    touchMode = true;
    setRootClass('dw-touch', true);
    dom.touchControls.setAttribute('aria-hidden', 'false');
    if (hintState.visible) renderHint();
    applyMicTip();
    measureLayout();
  }
  function moveStick(clientX, clientY) {
    let deltaX = clientX - stickState.originX;
    let deltaY = clientY - stickState.originY;
    const distance = Math.hypot(deltaX, deltaY);
    const radius = stickState.radius;
    if (distance > radius) {
      deltaX *= radius / distance;
      deltaY *= radius / distance;
    }
    dom.stickKnob.style.transform = `translate3d(${deltaX.toFixed(1)}px, ${deltaY.toFixed(1)}px, 0)`;
    let axisX = deltaX / radius;
    let axisY = -deltaY / radius;
    const magnitude = Math.hypot(axisX, axisY);
    if (magnitude < STICK_DEADZONE) {
      axisX = 0;
      axisY = 0;
    } else {
      const rescale = (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE) / magnitude;
      axisX *= rescale;
      axisY *= rescale;
    }
    ctx.systems.input?.touch?.setStick(axisX, axisY);
  }
  function releaseStick() {
    stickState.pointerId = null;
    ctx.systems.input?.touch?.releaseStick();
    dom.stickKnob.style.transform = '';
    dom.stick.style.transform = '';
    setRootClass('dw-stick-active', false);
  }
  function onStickDown(event) {
    if (stickState.pointerId !== null) return;
    event.preventDefault();
    enableTouchMode();
    if (stickState.homeX === 0) measureTouchControls();
    stickState.pointerId = event.pointerId;
    stickState.captured = capturePointer(dom.stickZone, event.pointerId);
    const margin = stickState.radius * 1.3;
    stickState.originX = clamp(event.clientX, margin, Math.max(margin, view.width * 0.46 - margin * 0.5));
    stickState.originY = clamp(event.clientY, margin + 60, Math.max(margin + 60, view.height - margin));
    dom.stick.style.transform = `translate3d(${(stickState.originX - stickState.homeX).toFixed(1)}px, ${(stickState.originY - stickState.homeY).toFixed(1)}px, 0)`;
    setRootClass('dw-stick-active', true);
    moveStick(event.clientX, event.clientY);
    wake();
  }
  function onStickMove(event) {
    if (event.pointerId !== stickState.pointerId) return;
    moveStick(event.clientX, event.clientY);
  }
  function onStickUp(event) {
    if (event.pointerId !== stickState.pointerId) return;
    releaseStick();
  }
  function onStickLeave(event) {
    if (event.pointerId === stickState.pointerId && !stickState.captured) releaseStick();
  }

  function renderSlider(value) {
    if (Math.abs(value - sliderState.value) < 0.002) return;
    sliderState.value = value;
    dom.sliderFill.style.transform = `scaleY(${value.toFixed(3)})`;
    dom.sliderThumb.style.transform = `translate3d(0, ${(-(SLIDER_PADDING - 2) - value * sliderState.travel).toFixed(1)}px, 0)`;
    dom.throttleSlider.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  }
  function setThrottleFromSlider(clientY) {
    const value = clamp(1 - (clientY - sliderState.top) / sliderState.span, 0, 1);
    ctx.systems.input?.touch?.setThrottle(value);
    renderSlider(value);
  }
  function releaseSlider() {
    sliderState.pointerId = null;
    ctx.systems.input?.touch?.releaseThrottle();
  }
  function onSliderDown(event) {
    if (sliderState.pointerId !== null) return;
    event.preventDefault();
    sliderState.pointerId = event.pointerId;
    sliderState.captured = capturePointer(dom.throttleSlider, event.pointerId);
    const rect = dom.throttleSlider.getBoundingClientRect();
    sliderState.top = rect.top + SLIDER_PADDING;
    sliderState.span = Math.max(1, rect.height - SLIDER_PADDING * 2);
    setThrottleFromSlider(event.clientY);
    wake();
  }
  function onSliderMove(event) {
    if (event.pointerId !== sliderState.pointerId) return;
    setThrottleFromSlider(event.clientY);
  }
  function onSliderUp(event) {
    if (event.pointerId !== sliderState.pointerId) return;
    releaseSlider();
  }
  function onSliderLeave(event) {
    if (event.pointerId === sliderState.pointerId && !sliderState.captured) releaseSlider();
  }

  dom.stickZone.addEventListener('pointerdown', onStickDown);
  dom.stickZone.addEventListener('pointermove', onStickMove);
  dom.stickZone.addEventListener('pointerup', onStickUp);
  dom.stickZone.addEventListener('pointercancel', onStickUp);
  dom.stickZone.addEventListener('lostpointercapture', onStickUp);
  dom.stickZone.addEventListener('pointerleave', onStickLeave);
  dom.throttleSlider.addEventListener('pointerdown', onSliderDown);
  dom.throttleSlider.addEventListener('pointermove', onSliderMove);
  dom.throttleSlider.addEventListener('pointerup', onSliderUp);
  dom.throttleSlider.addEventListener('pointercancel', onSliderUp);
  dom.throttleSlider.addEventListener('lostpointercapture', onSliderUp);
  dom.throttleSlider.addEventListener('pointerleave', onSliderLeave);

  // ---------------------------------------------------------------------------
  // Layout measurement (resize / touch mode only; never per frame)
  // ---------------------------------------------------------------------------
  function measureLayout() {
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    const portrait = view.height > view.width;
    if (touchMode) {
      targetMargins.left = 46;
      targetMargins.right = 46;
      targetMargins.top = portrait ? 274 : 96;
      targetMargins.bottom = portrait ? 290 : 110;
    } else {
      const compact = view.width <= 760;
      targetMargins.left = 64;
      targetMargins.right = 64;
      targetMargins.top = compact ? 170 : 112;
      targetMargins.bottom = compact ? 190 : 140;
    }
    compassState.width = dom.compassStrip.clientWidth || compassState.width;
    compassState.half = compassState.width / 2;
    compassState.heading = NaN;
    for (const marker of landmarkMarkers) marker.x = NaN;
    compassTargetMarker.x = NaN;
    targetState.x = NaN;
    measureTouchControls();
    measureHint();
  }

  // ---------------------------------------------------------------------------
  // Auto-hide
  // ---------------------------------------------------------------------------
  function wake() {
    localActivity = performance.now();
    if (idle) {
      idle = false;
      setRootClass('dw-idle', false);
    }
  }
  function updateAutoHide() {
    const lastInput = Math.max(localActivity, Number(ctx.systems.input?.getLastActivity?.()) || 0);
    const eligible = Boolean(settings.get('hudAutoHide')) && state.ready && !commandOpen && !activePanel && !photoActive && !pointerOverUi && stickState.pointerId === null && sliderState.pointerId === null;
    const shouldIdle = eligible && performance.now() - lastInput > CONFIG.UI_IDLE_HIDE_MS;
    if (shouldIdle !== idle) {
      idle = shouldIdle;
      setRootClass('dw-idle', idle);
    }
  }

  // ---------------------------------------------------------------------------
  // Hotkeys and input actions
  // ---------------------------------------------------------------------------
  // Named, rebindable actions (photo mode, journal, settings, time of day, ring course, waypoints,
  // autopilot) arrive as 'input:action' presses from the input system on any device. The keys
  // below stay UI-only: M mic, Enter and / command, H and ? help, Escape, X clear waypoint, K capture, I fps, Shift+V voice, Tab HUD. A key the
  // player has bound to an action belongs to that action (input.consumesKey).
  const PHOTO_MODE_HOTKEYS = new Set(['escape', 'capture', 'fps', 'voice', 'mic']);
  const PHOTO_MODE_ACTIONS = new Set(['photoMode', 'timeForward', 'timeBack']);
  const TIME_PRESET_SUN = { dawn: [-4, false], golden: [8, true], night: [-35, true] };
  function resolveHotkey(event) {
    switch (event.code) {
      case 'KeyM': return 'mic';
      case 'Enter':
      case 'NumpadEnter': return 'command';
      case 'KeyH': return 'help';
      case 'Escape': return 'escape';
      case 'KeyX': return 'clearWaypoint';
      case 'KeyK': return 'capture';
      case 'KeyI': return 'fps';
      case 'KeyV': return event.shiftKey ? 'voice' : null;
      case 'Tab': return 'hud';
      default: break;
    }
    if (event.key === '?') return 'help';
    if (event.key === '/') return 'command';
    return null;
  }
  function handleEscape() {
    if (commandOpen) closeCommandBar();
    else if (activePanel === 'controls' && controlsPanel.handleEscape()) return;
    else if (activePanel) showPanel(null);
    else if (photoActive) togglePhotoMode(false);
    else if (hudHiddenByUser) toggleHud();
  }
  function runHotkey(hotkey) {
    switch (hotkey) {
      case 'mic': toggleMic(); break;
      case 'command':
        if (!commandOpen) openCommandBar();
        else dom.commandInput.focus({ preventScroll: true });
        break;
      case 'help': togglePanel('help'); break;
      case 'escape': handleEscape(); break;
      case 'clearWaypoint': clearWaypoint(); break;
      case 'capture': captureScreenshot(); break;
      case 'fps': toggleFpsBadge(); break;
      case 'voice': toggleVoice(); break;
      case 'hud': toggleHud(); break;
      default: break;
    }
  }
  function onKeyDown(event) {
    markActivity();
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (event.target instanceof HTMLButtonElement && root.contains(event.target) && (event.key === 'Enter' || event.key === ' ')) return;
    // Tab moves focus through an open panel's controls instead of hiding the HUD.
    if (event.code === 'Tab' && activePanel && panels[activePanel].contains(document.activeElement)) return;
    if (ctx.systems.input?.consumesKey?.(event)) return;
    const hotkey = resolveHotkey(event);
    if (!hotkey) return;
    if (photoActive && !PHOTO_MODE_HOTKEYS.has(hotkey)) return;
    event.preventDefault();
    if (event.repeat) return;
    runHotkey(hotkey);
  }

  /** Day time of a TIME_CYCLE preset (the copilot's preset definitions). */
  function presetDayTime(preset) {
    const sun = TIME_PRESET_SUN[preset];
    return sun ? ctx.util.dayTimeForSunElevation(sun[0], sun[1]) : 0.5;
  }
  /** Time of day one preset back: the previous preset in a chain, else the last one passed today. */
  function cycleTimePresetBack() {
    let nextIndex;
    if (lastTimePreset && uiClock - lastTimePresetAt < 8) {
      nextIndex = (TIME_CYCLE.indexOf(lastTimePreset) + TIME_CYCLE.length - 1) % TIME_CYCLE.length;
    } else {
      const dayTime = ((Number(state.time.dayTime) % 1) + 1) % 1;
      let smallestGap = Infinity;
      nextIndex = 0;
      TIME_CYCLE.forEach((preset, presetIndex) => {
        const gap = (((dayTime - presetDayTime(preset) - 0.01) % 1) + 1) % 1;
        if (gap < smallestGap) {
          smallestGap = gap;
          nextIndex = presetIndex;
        }
      });
    }
    lastTimePreset = TIME_CYCLE[nextIndex];
    lastTimePresetAt = uiClock;
    runAction({ type: 'time', preset: lastTimePreset });
  }
  function setWaypointNearest() {
    runAction({ type: 'find', target: 'landmark' });
  }
  function runInputAction(actionId) {
    switch (actionId) {
      case 'photoMode': togglePhotoMode(!state.photoMode); break;
      case 'journal': togglePanel('journal'); break;
      case 'settings': togglePanel('settings'); break;
      case 'controlsPanel': togglePanel('controls'); break;
      case 'timeForward': cycleTimePreset(); break;
      case 'timeBack': cycleTimePresetBack(); break;
      case 'ringCourse': toggleRingCourse(); break;
      case 'waypointAhead': setWaypointAhead(); break;
      case 'waypointNearest': setWaypointNearest(); break;
      case 'autopilotToggle': toggleAutopilot(); break;
      default: break;
    }
  }
  function onInputAction(payload) {
    if (!payload || payload.phase !== 'press') return;
    if (photoActive && !PHOTO_MODE_ACTIONS.has(payload.id)) return;
    markActivity();
    runInputAction(payload.id);
  }
  bus.on('input:action', onInputAction);

  dom.commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandBar();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      recallHistory(1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      recallHistory(-1);
    }
  });
  dom.commandForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCommand(dom.commandInput.value);
  });

  // ---------------------------------------------------------------------------
  // Delegated clicks and focus hygiene
  // ---------------------------------------------------------------------------
  function runUiAction(name) {
    switch (name) {
      case 'open-command': openCommandBar(); break;
      case 'toggle-journal': togglePanel('journal'); break;
      case 'toggle-settings': togglePanel('settings'); break;
      case 'toggle-help': togglePanel('help'); break;
      case 'open-controls': openControls(); break;
      case 'calibrate-controls': openControls({ calibrate: true }); break;
      case 'open-menu': togglePanel('menu'); break;
      case 'close-panel': showPanel(null); break;
      case 'copy-link': copyShareLink(); break;
      case 'new-world': requestNewWorld(); break;
      case 'mic':
        closeCommandBar();
        toggleMic();
        break;
      case 'capture': captureScreenshot(); break;
      case 'exit-photo': togglePhotoMode(false); break;
      case 'photo-mode':
        showPanel(null);
        togglePhotoMode(true);
        break;
      case 'autopilot-off': runAction({ type: 'autopilot', enabled: false }); break;
      default: break;
    }
  }
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    markActivity();
    const quick = target.closest('[data-command]');
    if (quick && root.contains(quick)) {
      submitCommand(quick.dataset.command);
      return;
    }
    const actionElement = target.closest('[data-action]');
    if (actionElement && root.contains(actionElement)) runUiAction(actionElement.dataset.action);
  });
  // Mouse clicks must not leave focus on HUD buttons: Space (the craft ability) and Enter
  // would otherwise re-trigger the last clicked button.
  root.addEventListener('mousedown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target && target.closest('button') && !target.closest('input')) event.preventDefault();
  });
  root.addEventListener('pointerover', (event) => {
    // The touch joystick zone is a large steering surface, not a control to hover.
    pointerOverUi = event.target instanceof Element && !event.target.closest('.dw-stick-zone');
  });
  root.addEventListener('pointerout', (event) => {
    pointerOverUi = event.relatedTarget instanceof Element && root.contains(event.relatedTarget);
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', markActivity, { passive: true });
  window.addEventListener('wheel', markActivity, { passive: true });
  window.addEventListener('touchstart', markActivity, { passive: true });
  window.addEventListener('pointerdown', (event) => {
    markActivity();
    if (event.pointerType === 'touch') enableTouchMode();
  }, { passive: true });
  coarsePointerQuery.addEventListener('change', (event) => {
    if (event.matches) enableTouchMode();
  });

  // ---------------------------------------------------------------------------
  // Event bus wiring
  // ---------------------------------------------------------------------------
  bus.on('game:ready', () => {
    setRootClass('dw-ready', true);
    setRootClass('dw-revealing', true);
    revealEndsAt = uiClock + 2.4;
    wake();
    startIntroBanner();
    scheduleFirstRunHint();
  });
  bus.on('copilot:speech', (payload) => {
    if (payload && payload.text) setSubtitle(payload.text, { source: payload.source });
  });
  bus.on('copilot:listening', (payload) => {
    if (payload) setMicState(payload.state, payload.message);
  });
  bus.on('copilot:transcript', (payload) => {
    if (payload) showTranscript(payload.text, Boolean(payload.final));
  });
  bus.on('notify', (payload) => {
    if (payload && payload.text) toast(payload.text, { kind: payload.kind });
  });
  bus.on('biome:changed', (payload) => {
    const biome = payload && payload.biome;
    if (!biome || !biome.key) return;
    biomeBannerState.pending = biome;
    biomeBannerState.pendingSince = uiClock;
  });
  bus.on('landmark:discovered', (payload) => {
    if (!payload) return;
    const site = payload.site || {};
    const type = payload.type || site.type;
    const typeLabel = LANDMARK_TYPE_LABELS[type] || 'Landmark';
    const biomeName = biomeNameFor(Number.isInteger(site.biome) ? site.biome : site.biomeKey);
    queueBanner({ label: 'Discovered', title: payload.name || typeLabel, detail: `${typeLabel} · ${biomeName}`, paletteIndex: biomeIndexFor(Number.isInteger(site.biome) ? site.biome : site.biomeKey), duration: 4.8 });
    landmarkRefreshTimer = 0;
    if (activePanel === 'journal') renderJournal();
  });
  bus.on('landmark:threaded', (payload) => {
    toast(payload && payload.name ? `Threaded ${payload.name}` : 'Threaded the arch', { kind: 'success' });
  });
  bus.on('autopilot:changed', (payload) => {
    if (!payload) return;
    const enabled = Boolean(payload.enabled);
    autopilotDetailTimer = 0;
    if (enabled === lastAutopilotEnabled) return;
    lastAutopilotEnabled = enabled;
    if (enabled) toast(payload.followWaypoint && (state.waypoint || state.ringCourse.active) ? 'Autopilot engaged, following the marker' : 'Autopilot engaged', { key: 'autopilot' });
    else toast(payload.reason === 'manual override' ? 'Autopilot off. You have the controls' : 'Autopilot off', { key: 'autopilot' });
    wake();
  });
  bus.on('waypoint:set', (payload) => {
    if (!payload) return;
    const player = state.player.position;
    const distance = Number.isFinite(payload.x) && Number.isFinite(payload.z) ? Math.hypot(payload.x - player.x, payload.z - player.z) : NaN;
    const label = typeof payload.label === 'string' && payload.label.trim() && payload.label.trim().toLowerCase() !== 'waypoint' ? payload.label.trim() : '';
    const distanceText = Number.isFinite(distance) ? formatDistance(distance) : '';
    toast(['Waypoint set', label, distanceText].filter(Boolean).join(' · '), { kind: 'success', key: 'waypoint' });
    targetState.waypointX = NaN;
    wake();
  });
  bus.on('waypoint:reached', (payload) => {
    waypointReachedAt = uiClock;
    const label = payload && typeof payload.label === 'string' && payload.label.trim() && payload.label.trim().toLowerCase() !== 'waypoint' ? payload.label.trim() : '';
    toast(label ? `Arrived at ${label}` : 'Waypoint reached', { kind: 'success', key: 'waypoint' });
  });
  bus.on('waypoint:cleared', () => {
    if (uiClock - waypointReachedAt > 4) toast('Waypoint cleared', { key: 'waypoint' });
  });
  bus.on('rings:started', (payload) => {
    const total = payload && Number.isFinite(payload.total) ? payload.total : 0;
    toast(total ? `Ring course: ${total} rings. Follow the gold marker` : 'Ring course started', { kind: 'success', key: 'rings' });
    chipState.ringIndex = -1;
    wake();
  });
  bus.on('ring:passed', () => flashRingChip('dw-flash-pass'));
  bus.on('ring:missed', () => flashRingChip('dw-flash-miss'));
  bus.on('rings:finished', (payload) => {
    if (!payload) return;
    const passed = Math.round(Number(payload.passed) || 0);
    const total = Math.round(Number(payload.total) || 0);
    const bestStreak = Math.round(Number(payload.bestStreak) || 0);
    queueBanner({ label: 'Course complete', title: `${passed} of ${total} rings`, detail: `${formatRaceTime(payload.time)} · best streak ${bestStreak}`, duration: 5.2 });
    if (activePanel === 'journal') renderJournal();
  });
  bus.on('rings:cancelled', () => toast('Ring course cancelled', { key: 'rings' }));
  bus.on('time:changed', (payload) => {
    if (!payload) return;
    const name = payload.preset && PRESET_LABELS[payload.preset] ? PRESET_LABELS[payload.preset] : String(payload.label || '').trim();
    const easing = Number(payload.transition) > 0;
    photoState.targetLabel = easing ? String(payload.label || '').trim() : '';
    photoState.targetUntil = easing ? uiClock + Number(payload.transition) + 0.2 : 0;
    // One coalescing toast per change; the photo bar's live label covers it in photo mode.
    if (name) toast(`Shifting to ${name}`, { key: 'time', photo: 'drop' });
    chipState.label = null;
    if (photoActive) renderPhotoMeta();
    wake();
  });
  bus.on('journal:changed', () => {
    if (activePanel === 'journal') renderJournal();
  });
  bus.on('screenshot:taken', () => {
    playShutterFlash();
    toast('Photo saved to your downloads', { kind: 'success', photo: 'status' });
  });
  bus.on('settings:changed', (payload) => {
    if (!payload || !payload.key) return;
    if (payload.key === 'showFps') applyDebugVisibility();
    if (payload.key === 'hudAutoHide' && !payload.value) wake();
    if (payload.key === 'units' && activePanel === 'journal') renderJournal();
  });
  bus.onTyped('craftChanged', () => {
    applyThrottleVisibility();
    if (activePanel === 'help') renderHelp();
    if (hintState.visible) renderHint();
  });
  bus.on('ui:openControls', (payload) => openControls(payload || {}));
  bus.on('quality:changed', () => {
    debugTimer = 0;
  });
  bus.on('resize', measureLayout);

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------
  buildCompassTape();
  dom.seedValue.textContent = state.seed;
  dom.menuSeed.textContent = `Seed ${state.seed}`;
  dom.journalSeed.textContent = `Seed ${state.seed}`;
  dom.command.setAttribute('aria-hidden', 'true');
  const speechRecognitionAvailable = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  setMicState(speechRecognitionAvailable ? 'idle' : 'unsupported');
  if (params.get('touch') === '1' || coarsePointerQuery.matches) enableTouchMode();
  measureLayout();
  applyDebugVisibility();
  applyThrottleVisibility();
  renderHint();
  updateTimeChip();

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------
  function updateTimers(step) {
    updateToasts();
    if (subtitleState.visible && uiClock >= subtitleState.expiresAt) hideSubtitle();
    if (transcriptState.visible && uiClock >= transcriptState.expiresAt) {
      transcriptState.visible = false;
      setRootClass('dw-transcript-on', false);
    }
    if (uiClock >= subtitleState.collapseAt) collapseSubtitle();
    updateIntroBanner(step);
    updatePendingBiome();
    updateBanner();
    if (photoActive) {
      // The first-run hint waits out photo mode: its show / hide timers are paused.
      if (Number.isFinite(hintState.showAt)) hintState.showAt += step;
      if (Number.isFinite(hintState.hideAt)) hintState.hideAt += step;
    } else if (uiClock >= hintState.showAt) {
      hintState.showAt = Infinity;
      hintState.hideAt = uiClock + 6.5;
      hintState.visible = true;
      renderHint();
      dom.hint.classList.add('dw-show');
      measureHint();
      storage.write(FIRST_RUN_KEY, true);
    } else if (uiClock >= hintState.hideAt) {
      hintState.hideAt = Infinity;
      hintState.visible = false;
      dom.hint.classList.remove('dw-show', 'dw-dodge');
      hintState.dodging = false;
    }
    if (newWorldConfirmUntil && uiClock >= newWorldConfirmUntil) {
      newWorldConfirmUntil = 0;
      setNewWorldConfirm(false);
    }
    if (micErrorResetAt && uiClock >= micErrorResetAt) {
      micErrorResetAt = 0;
      if (micState === 'error') setMicState('idle');
    }
    if (revealEndsAt && uiClock >= revealEndsAt) {
      revealEndsAt = 0;
      setRootClass('dw-revealing', false);
    }
  }

  // UI timers (toasts, subtitles, banners, hints) follow the wall clock, not the
  // simulation's clamped realDt, so reading times stay right at low frame rates.
  let lastUpdateAt = 0;
  function update(dt, realDt) {
    const now = performance.now();
    const fallbackStep = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    const step = lastUpdateAt > 0 ? clamp((now - lastUpdateAt) / 1000, 0, 0.25) : fallbackStep;
    lastUpdateAt = now;
    uiClock += step;
    updateAutoHide();
    updateTimers(step);
    updatePortraitLayout(step);
    if (photoActive) updatePhotoChrome(step);
    const ringActive = Boolean(state.ringCourse && state.ringCourse.active);
    setRootClass('dw-ring-active', ringActive);
    const hudShown = state.ready && !idle && !hudHiddenByUser && !photoActive;
    const markerShown = state.ready && !hudHiddenByUser && !photoActive && (hudShown || ringActive);
    if (markerShown || hudShown) resolveTarget();
    if (hudShown) {
      updateCompass(step);
      updateInstruments();
      updateTimeChip();
      updateAutopilotChip(step);
    }
    if (ringActive && !photoActive && !hudHiddenByUser) updateRingChip();
    if (markerShown) updateTargetMarker();
    if (hintState.visible) {
      // The hint shifts when the subtitle / transcript above it appear or leave.
      const speechLayout = (subtitleState.visible ? 1 : 0) + (transcriptState.visible ? 2 : 0);
      if (speechLayout !== hintState.speechLayout) {
        hintState.speechLayout = speechLayout;
        measureHint();
      }
    }
    if (hintState.visible || hintState.dodging) updateHintDodge(markerShown && targetState.kind !== null);
    if (touchMode && sliderState.pointerId === null) renderSlider(clamp(Number(state.player.throttle) || 0, 0, 1));
    updateDebugBadge(step);
    statusBadge.update(step, photoActive);
    craftPicker.update(step);
    if (activePanel === 'journal') updateJournalStats(step);
    if (activePanel === 'settings') settingsPanel.update(step);
    if (activePanel === 'controls') controlsPanel.update(step);
  }

  return {
    update, toast, setSubtitle, setMicState, showPanel, togglePanel, setPhotoMode, wake, openControls,
    /** v2 chrome for tests and other systems: the craft picker, settings tabs and controls panel. */
    craftPicker, settingsPanel, controlsPanel, statusBadge,
  };
}
