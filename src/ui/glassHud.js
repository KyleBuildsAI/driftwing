// Glass HUD: the third-person flight HUD. It is built from v1's HUD cards (the speed / altitude card
// with its throttle bar, and the compass, both kept current by ui.js in settings.units) plus three
// pieces this module drives:
//   - a compact attitude indicator in the flight card (state.flight pitch and roll, 30 Hz);
//   - the stall / AoA warning on the flight card (state.flight.stall and aoa; the helicopter's
//     stall lamp is its low-rotor-rpm warning), which wakes an idle HUD while it is on;
//   - the flight path marker: the classic velocity-vector symbol drawn where the air-relative
//     velocity (state.flight.airVelocity) points, projected far ahead of the craft, next to a small
//     nose symbol on the craft's longitudinal axis. Sideslip shows as a lateral offset from the
//     nose, angle of attack as a vertical one. Off screen it pins to the edge and dims.
//
// Visibility: every third-person view shows the glass HUD. A first-person view with an instrument
// panel (the cockpit) shows it only with settings.hud.cockpitGlass (off by default); a first-person
// view without a panel (the FPV drone's camera, the wingsuit's helmet view) keeps it, as it is their
// only readout. settings.hud.flightPathMarker (on by default) hides the marker alone. The pieces
// carry .dw-glass and fade with the v1 HUD (.dw-fade: idle, Tab, photo mode). The camera system
// calls update() once per frame after it has placed the camera, so the marker matches the frame.
import './glassHud.css';
import { THEMES } from './instruments/gaugeKit.js';

const DEG = Math.PI / 180;
/** The marker is projected this far (m) along the air-relative velocity and the nose. */
const PROJECTION_DISTANCE = 1500;
/** Below this airspeed (m/s) the flight path means little (hover, taxi): the marker is hidden. */
const MIN_MARKER_AIRSPEED = 5;
/** Distance (CSS px) the marker keeps from the screen edges when it pins there. */
const EDGE_MARGIN = 26;
/** Pitch (deg) from the attitude indicator's centre to its rim. */
const ATTITUDE_PITCH_RANGE = 40;
const ATTITUDE_RUNGS = Object.freeze([-20, -10, 10, 20]);
/** Seconds between re-measures of the attitude canvas size (it changes with the layout). */
const ATTITUDE_MEASURE_SECONDS = 1;
const GLASS = THEMES.glass;

function requireElement(root, id) {
  const element = root.querySelector(`#${id}`);
  if (!element) throw new Error(`DRIFTWING glass HUD: element #${id} is missing from the page.`);
  return element;
}

export function createGlassHud(ctx) {
  const { THREE, camera, state, settings } = ctx;
  const root = document.getElementById('ui-root');
  if (!root) throw new Error('DRIFTWING glass HUD: the #ui-root element is missing from the page.');
  const dom = {
    attitude: requireElement(root, 'dw-attitude'),
    stall: requireElement(root, 'dw-stall'),
    stallText: requireElement(root, 'dw-stall-text'),
    stallAngle: requireElement(root, 'dw-stall-aoa'),
    marker: requireElement(root, 'dw-fpm'),
    markerSymbol: requireElement(root, 'dw-fpm-marker'),
    noseSymbol: requireElement(root, 'dw-fpm-nose'),
  };
  const attitudePen = dom.attitude.getContext('2d');
  if (!attitudePen) throw new Error('DRIFTWING glass HUD: 2D canvas unavailable for the attitude indicator.');

  const projected = new THREE.Vector3();
  const aimPoint = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const prefs = { cockpitGlass: false, flightPathMarker: true };
  const shown = { glass: null, marker: null, markerEdge: null, nose: null, stallKind: '', stallText: '', stallAngle: '' };
  const placed = { markerX: NaN, markerY: NaN, noseX: NaN, noseY: NaN };
  const attitudeCanvas = { cssSize: 0, pixels: 0, measureTimer: 0, pitch: NaN, roll: NaN };
  const counters = { attitudeRedraws: 0, markerFrames: 0, stallWakes: 0 };
  const markerState = { visible: false, onScreen: false, x: 0, y: 0, noseVisible: false, noseX: 0, noseY: 0, airspeed: 0 };

  function readPrefs() {
    const hud = settings.get('hud');
    prefs.cockpitGlass = Boolean(hud && hud.cockpitGlass);
    prefs.flightPathMarker = !hud || hud.flightPathMarker !== false;
  }
  readPrefs();
  ctx.bus.on('settings:changed', ({ key }) => {
    if (key === 'hud') readPrefs();
  });
  window.addEventListener('resize', () => {
    attitudeCanvas.measureTimer = 0;
    placed.markerX = NaN;
    placed.noseX = NaN;
  });

  // ---- Visibility ------------------------------------------------------------------------------
  function setGlassVisible(visible) {
    if (shown.glass === visible) return;
    shown.glass = visible;
    root.classList.toggle('dw-glass-off', !visible);
  }

  // ---- Attitude indicator ------------------------------------------------------------------------
  /** Keeps the canvas backing store at its CSS size times the pixel ratio (re-measured each second). */
  function measureAttitude(realDt) {
    attitudeCanvas.measureTimer -= realDt;
    if (attitudeCanvas.measureTimer > 0) return false;
    attitudeCanvas.measureTimer = ATTITUDE_MEASURE_SECONDS;
    const cssSize = dom.attitude.clientWidth;
    if (!(cssSize > 0)) return false;
    const pixels = Math.round(cssSize * Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    if (pixels === attitudeCanvas.pixels) return false;
    attitudeCanvas.cssSize = cssSize;
    attitudeCanvas.pixels = pixels;
    dom.attitude.width = pixels;
    dom.attitude.height = pixels;
    return true;
  }

  function drawAttitude(pitch, roll) {
    const size = attitudeCanvas.pixels;
    if (!(size > 0)) return;
    const pen = attitudePen;
    const radius = size / 2 - 1;
    const scale = radius / ATTITUDE_PITCH_RANGE;
    const line = Math.max(1, size / 56);
    pen.clearRect(0, 0, size, size);
    pen.save();
    pen.translate(size / 2, size / 2);
    pen.beginPath();
    pen.arc(0, 0, radius, 0, Math.PI * 2);
    pen.clip();
    // The card: sky and ground rolled and pitched behind the fixed aircraft symbol.
    pen.save();
    pen.rotate(-roll * DEG);
    pen.translate(0, Math.max(-80, Math.min(80, pitch)) * scale);
    pen.fillStyle = GLASS.sky;
    pen.fillRect(-size, -size * 2, size * 2, size * 2);
    pen.fillStyle = GLASS.ground;
    pen.fillRect(-size, 0, size * 2, size * 2);
    pen.strokeStyle = GLASS.horizon;
    pen.lineWidth = line * 1.2;
    pen.beginPath();
    pen.moveTo(-size, 0);
    pen.lineTo(size, 0);
    pen.stroke();
    pen.lineWidth = line;
    pen.strokeStyle = GLASS.white;
    for (const rung of ATTITUDE_RUNGS) {
      const half = radius * (Math.abs(rung) === 10 ? 0.22 : 0.34);
      pen.beginPath();
      pen.moveTo(-half, -rung * scale);
      pen.lineTo(half, -rung * scale);
      pen.stroke();
    }
    // Bank pointer, turning with the card.
    pen.translate(0, -Math.max(-80, Math.min(80, pitch)) * scale);
    pen.fillStyle = GLASS.pointer;
    pen.beginPath();
    pen.moveTo(0, -radius + 1.5 * line);
    pen.lineTo(-3 * line, -radius + 6.5 * line);
    pen.lineTo(3 * line, -radius + 6.5 * line);
    pen.closePath();
    pen.fill();
    pen.restore();
    // Fixed aircraft symbol and zero-bank index.
    pen.strokeStyle = GLASS.needle;
    pen.lineWidth = line * 2;
    pen.lineCap = 'round';
    pen.beginPath();
    pen.moveTo(-radius * 0.56, 0);
    pen.lineTo(-radius * 0.2, 0);
    pen.lineTo(-radius * 0.1, radius * 0.1);
    pen.moveTo(radius * 0.56, 0);
    pen.lineTo(radius * 0.2, 0);
    pen.lineTo(radius * 0.1, radius * 0.1);
    pen.stroke();
    pen.fillStyle = GLASS.needle;
    pen.beginPath();
    pen.arc(0, 0, line * 1.3, 0, Math.PI * 2);
    pen.fill();
    pen.restore();
    pen.strokeStyle = GLASS.faceEdge;
    pen.lineWidth = line;
    pen.beginPath();
    pen.arc(size / 2, size / 2, radius - line / 2, 0, Math.PI * 2);
    pen.stroke();
    counters.attitudeRedraws++;
  }

  function updateAttitude(realDt, redraw) {
    const resized = measureAttitude(realDt);
    const flight = state.flight;
    const pitch = Number.isFinite(flight.pitch) ? flight.pitch : 0;
    const roll = Number.isFinite(flight.roll) ? flight.roll : 0;
    const moved = Math.abs(pitch - attitudeCanvas.pitch) > 0.05 || Math.abs(roll - attitudeCanvas.roll) > 0.05;
    if (!resized && !(redraw && moved)) return;
    attitudeCanvas.pitch = pitch;
    attitudeCanvas.roll = roll;
    drawAttitude(pitch, roll);
  }

  // ---- Stall / AoA warning ---------------------------------------------------------------------------
  const NO_WARNING = Object.freeze({ kind: '', text: '', angle: '' });

  /**
   * The warning for this frame: { kind: '' | 'warning' | 'stalled', text, angle }. The text is what
   * a screen reader announces; the angle of attack beside it is visual only, so it can change every
   * frame without repeating the announcement.
   */
  function stallWarning() {
    const flight = state.flight;
    const stall = flight.stall;
    if (!stall || (!stall.warning && !stall.stalled)) return NO_WARNING;
    const craft = ctx.systems.flight?.getCraftModule?.() ?? null;
    const kind = stall.stalled ? 'stalled' : 'warning';
    if (craft?.simProfile?.model === 'helicopter') return { kind, text: stall.stalled ? 'Rotor stall' : 'Low rotor RPM', angle: '' };
    const aoa = Math.round(Number.isFinite(flight.aoa) ? flight.aoa : 0);
    return { kind, text: stall.stalled ? 'Stall' : 'High AoA', angle: `${aoa}°` };
  }

  function updateStall(active) {
    const warning = active ? stallWarning() : NO_WARNING;
    if (warning.kind !== shown.stallKind) {
      shown.stallKind = warning.kind;
      dom.stall.dataset.kind = warning.kind;
      dom.stall.classList.toggle('dw-on', warning.kind !== '');
    }
    if (warning.text !== shown.stallText) {
      shown.stallText = warning.text;
      dom.stallText.textContent = warning.text;
    }
    if (warning.angle !== shown.stallAngle) {
      shown.stallAngle = warning.angle;
      dom.stallAngle.textContent = warning.angle;
    }
    if (warning.kind !== '') {
      // A warning keeps an idle HUD awake so it is never hidden while it matters.
      ctx.systems.ui?.wake?.();
      counters.stallWakes++;
    }
  }

  // ---- Flight path marker ---------------------------------------------------------------------------
  /**
   * Projects a world point to CSS pixels. Returns { x, y, onScreen, behind } in `out`; points
   * behind the camera or off screen are pinned to the edge in their direction.
   */
  function projectToScreen(point, out) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    projected.copy(point).applyMatrix4(camera.matrixWorldInverse);
    const behind = projected.z > -0.5;
    const cameraX = projected.x;
    const cameraY = projected.y;
    let x;
    let y;
    if (!behind) {
      projected.applyMatrix4(camera.projectionMatrix);
      x = (projected.x * 0.5 + 0.5) * width;
      y = (-projected.y * 0.5 + 0.5) * height;
      out.onScreen = x >= EDGE_MARGIN && x <= width - EDGE_MARGIN && y >= EDGE_MARGIN && y <= height - EDGE_MARGIN;
    } else {
      out.onScreen = false;
    }
    out.behind = behind;
    if (out.onScreen) {
      out.x = x;
      out.y = y;
      return out;
    }
    const centerX = width / 2;
    const centerY = height / 2;
    const directionX = behind ? cameraX : x - centerX;
    const directionY = behind ? -cameraY : y - centerY;
    const halfX = Math.max(1, centerX - EDGE_MARGIN);
    const halfY = Math.max(1, centerY - EDGE_MARGIN);
    const edgeScale = Math.min(halfX / Math.max(Math.abs(directionX), 1e-6), halfY / Math.max(Math.abs(directionY), 1e-6));
    out.x = centerX + directionX * edgeScale;
    out.y = centerY + directionY * edgeScale;
    return out;
  }

  const markerProjection = { x: 0, y: 0, onScreen: false, behind: false };
  const noseProjection = { x: 0, y: 0, onScreen: false, behind: false };

  function placeElement(element, x, y, key) {
    if (Math.abs(x - placed[`${key}X`]) < 0.25 && Math.abs(y - placed[`${key}Y`]) < 0.25) return;
    placed[`${key}X`] = x;
    placed[`${key}Y`] = y;
    element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  function setMarkerClasses(visible, edge, noseVisible) {
    if (shown.marker !== visible) {
      shown.marker = visible;
      dom.marker.classList.toggle('dw-on', visible);
    }
    if (shown.markerEdge !== edge) {
      shown.markerEdge = edge;
      dom.markerSymbol.classList.toggle('dw-edge', edge);
    }
    if (shown.nose !== noseVisible) {
      shown.nose = noseVisible;
      dom.noseSymbol.classList.toggle('dw-on', noseVisible);
    }
  }

  function updateMarker(active) {
    const flight = state.flight;
    const airVelocity = flight.airVelocity;
    const airspeed = airVelocity ? airVelocity.length() : 0;
    markerState.airspeed = airspeed;
    const player = state.player;
    if (!active || !prefs.flightPathMarker || !(airspeed >= MIN_MARKER_AIRSPEED) || !player.position || !player.forward) {
      markerState.visible = false;
      markerState.noseVisible = false;
      setMarkerClasses(false, false, false);
      return;
    }
    camera.updateMatrixWorld();
    direction.copy(airVelocity).divideScalar(airspeed);
    aimPoint.copy(player.position).addScaledVector(direction, PROJECTION_DISTANCE);
    projectToScreen(aimPoint, markerProjection);
    aimPoint.copy(player.position).addScaledVector(player.forward, PROJECTION_DISTANCE);
    projectToScreen(aimPoint, noseProjection);
    placeElement(dom.markerSymbol, markerProjection.x, markerProjection.y, 'marker');
    placeElement(dom.noseSymbol, noseProjection.x, noseProjection.y, 'nose');
    markerState.visible = true;
    markerState.onScreen = markerProjection.onScreen;
    markerState.x = markerProjection.x;
    markerState.y = markerProjection.y;
    markerState.noseVisible = noseProjection.onScreen;
    markerState.noseX = noseProjection.x;
    markerState.noseY = noseProjection.y;
    counters.markerFrames++;
    setMarkerClasses(true, !markerProjection.onScreen, noseProjection.onScreen);
  }

  return {
    /**
     * Per frame, after the camera pose is final. firstPersonPanel: a first-person view with an
     * instrument panel is on screen; photo: photo mode (the HUD is hidden); redraw: the camera
     * system's 30 Hz instrument tick.
     */
    update(realDt, { firstPersonPanel, photo, redraw }) {
      const glass = !firstPersonPanel || prefs.cockpitGlass;
      setGlassVisible(glass);
      const active = glass && !photo && state.ready;
      updateAttitude(realDt, redraw && glass && !photo);
      updateStall(active);
      updateMarker(active);
    },

    /** True while the glass HUD is shown in the current view (before idle / Tab / photo fades). */
    get visible() {
      return shown.glass === true;
    },

    getStats() {
      return {
        visible: shown.glass === true,
        cockpitGlass: prefs.cockpitGlass,
        flightPathMarker: prefs.flightPathMarker,
        stall: { kind: shown.stallKind, text: shown.stallText, angle: shown.stallAngle },
        marker: {
          visible: markerState.visible,
          onScreen: markerState.onScreen,
          x: Math.round(markerState.x * 10) / 10,
          y: Math.round(markerState.y * 10) / 10,
          nose: { visible: markerState.noseVisible, x: Math.round(markerState.noseX * 10) / 10, y: Math.round(markerState.noseY * 10) / 10 },
          airspeed: Math.round(markerState.airspeed * 10) / 10,
        },
        attitude: { size: attitudeCanvas.cssSize, redraws: counters.attitudeRedraws },
        stallWakes: counters.stallWakes,
      };
    },
  };
}
