// Dev wind-arrow overlay: instanced arrows on a grid around the craft showing the WindField velocity.
//
// Two layers of GRID_SIDE x GRID_SIDE arrows share one grid snapped to SPACING (so arrows stay put
// while the craft moves): one hugging the terrain TERRAIN_AGL above the ground or water (ridge lift on
// windward slopes, sink in the lee), one at the craft's own altitude (thermals, their sinking rings,
// wind sources). Arrow length follows the speed, colour follows the vertical component: warm for lift,
// cool for sink, pale for level air.
//
// The field is read through wind.probe, so the craft's own per-layer reading (wind.lastLayers) is
// never disturbed. The grid is resampled SAMPLE_HZ times a second, each pass spread over the frames
// in between, so no single frame pays for the whole grid. The mesh is built on first use. Toggled by
// settings.windOverlay (settings panel, Developer group) and by the Arrows button the overlay adds to
// the dev badge. It is an ordinary scene object drawn only while the setting is on, so photo
// captures contain it only when the overlay is enabled.

const GRID_SIDE = 13;
const SPACING = 64;
const LAYER_COUNT = 2;
const GRID_COLUMNS = GRID_SIDE * GRID_SIDE;
const ARROW_CAPACITY = GRID_COLUMNS * LAYER_COUNT;
const TERRAIN_AGL = 45;
/** The altitude layer snaps to this step, and is skipped where it would sit on the terrain layer. */
const ALTITUDE_STEP = 10;
const ALTITUDE_LAYER_CLEARANCE = 30;
const SAMPLE_HZ = 5;
/** Arrows whose sample point is this close to the camera are left out, so none fills the view. */
const CAMERA_CLEARANCE = 55;
const LENGTH_PER_METRE_PER_SECOND = 4.5;
const MIN_LENGTH = 6;
const MAX_LENGTH = 56;
const WIDTH_BASE = 7;
const WIDTH_PER_LENGTH = 0.16;
/** Vertical wind (m/s) that reaches the full lift or sink colour. */
const VERTICAL_FULL = 3;
// Linear colours: level air, lift, sink.
const LEVEL_COLOR = [0.66, 0.72, 0.8];
const LIFT_COLOR = [1, 0.36, 0.06];
const SINK_COLOR = [0.08, 0.38, 1];

const BADGE_ROW_CLASS = 'dw-devbadge-wind';

/**
 * The Wind row of the dev badge (created on first use), where the dev wind tools put their buttons.
 * Returns null when the badge is not in the page.
 */
export function badgeWindRow() {
  const badge = document.getElementById('dw-devbadge');
  if (!badge) return null;
  let row = badge.querySelector(`.${BADGE_ROW_CLASS}`);
  if (row) return row;
  row = document.createElement('div');
  row.className = `${BADGE_ROW_CLASS} dw-debug-line`;
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--dw-hairline)' });
  const label = document.createElement('span');
  label.className = 'dw-micro';
  label.textContent = 'Wind';
  Object.assign(label.style, { fontFamily: 'var(--font-ui)', fontSize: '9px', marginRight: 'auto' });
  row.append(label);
  badge.append(row);
  return row;
}

/** A compact toggle button for the badge's Wind row; pressed state shows as the gold solid style. */
export function createBadgeButton(row, text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dw-text-button';
  button.textContent = text;
  button.title = title;
  button.setAttribute('aria-pressed', 'false');
  Object.assign(button.style, { height: '22px', padding: '0 9px', fontSize: '10.5px' });
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  row.append(button);
  return {
    element: button,
    setPressed(pressed) {
      button.setAttribute('aria-pressed', String(pressed));
      button.classList.toggle('dw-solid', pressed);
    },
    setText(value) {
      if (button.textContent !== value) button.textContent = value;
    },
  };
}

export function createWindOverlaySystem(ctx) {
  const { THREE: T, TSL, scene, settings, bus, state, world } = ctx;
  const { vec3, float, normalWorld } = TSL;

  let mesh = null;
  let enabled = false;
  const windSample = { vel: new T.Vector3(), turbulence: 0 };
  const probePoint = new T.Vector3();
  const direction = new T.Vector3();
  const forward = new T.Vector3(0, 0, 1);
  const instanceMatrix = new T.Matrix4();
  const instancePosition = new T.Vector3();
  const instanceQuaternion = new T.Quaternion();
  const instanceScale = new T.Vector3();
  const instanceColor = new T.Color();
  const stats = { arrows: 0, maxLift: 0, maxSink: 0, maxSpeed: 0, sampleMs: 0, chunkMs: 0 };

  /** A unit arrow along +z: a thin shaft from 0 to 0.7 and a cone head to 1. */
  function buildArrowGeometry() {
    const shaft = new T.CylinderGeometry(0.035, 0.035, 0.7, 6, 1);
    shaft.translate(0, 0.35, 0);
    const head = new T.ConeGeometry(0.12, 0.3, 8, 1);
    head.translate(0, 0.85, 0);
    const merged = ctx.addons.BufferGeometryUtils.mergeGeometries([shaft, head]);
    shaft.dispose();
    head.dispose();
    if (!merged) throw new Error('DRIFTWING wind overlay: the arrow geometry could not be merged.');
    merged.rotateX(Math.PI / 2);
    return merged;
  }

  function buildMesh() {
    // Unlit, top-lit by its own normal so the arrows read as solid shapes in any light.
    const material = new T.MeshBasicNodeMaterial({ fog: false });
    material.colorNode = vec3(float(0.7).add(normalWorld.y.mul(0.3)));
    const arrows = new T.InstancedMesh(buildArrowGeometry(), material, ARROW_CAPACITY);
    arrows.name = 'wind-overlay';
    arrows.instanceMatrix.setUsage(T.DynamicDrawUsage);
    const hidden = new T.Matrix4().makeScale(0, 0, 0);
    for (let index = 0; index < ARROW_CAPACITY; index++) {
      arrows.setMatrixAt(index, hidden);
      arrows.setColorAt(index, instanceColor.setRGB(...LEVEL_COLOR));
    }
    arrows.instanceColor.setUsage(T.DynamicDrawUsage);
    arrows.frustumCulled = false;
    arrows.castShadow = false;
    arrows.receiveShadow = false;
    scene.add(arrows);
    return arrows;
  }

  function colorFor(vertical) {
    const share = Math.min(1, Math.abs(vertical) / VERTICAL_FULL);
    const target = vertical >= 0 ? LIFT_COLOR : SINK_COLOR;
    return instanceColor.setRGB(
      LEVEL_COLOR[0] + (target[0] - LEVEL_COLOR[0]) * share,
      LEVEL_COLOR[1] + (target[1] - LEVEL_COLOR[1]) * share,
      LEVEL_COLOR[2] + (target[2] - LEVEL_COLOR[2]) * share,
    );
  }

  /** Samples the field at (x, y, z) and writes one arrow centred there; false when hidden (still air, at the camera). */
  function writeArrow(index, x, y, z) {
    probePoint.set(x, y, z);
    if (probePoint.distanceToSquared(ctx.camera.position) < CAMERA_CLEARANCE * CAMERA_CLEARANCE) return false;
    ctx.wind.probe(probePoint, state.time.elapsed, windSample);
    const velocity = windSample.vel;
    const speed = velocity.length();
    if (!(speed > 1e-3)) return false;
    const length = Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, speed * LENGTH_PER_METRE_PER_SECOND));
    const width = WIDTH_BASE + length * WIDTH_PER_LENGTH;
    direction.copy(velocity).divideScalar(speed);
    instanceQuaternion.setFromUnitVectors(forward, direction);
    instancePosition.set(x, y, z).addScaledVector(direction, -length / 2);
    instanceScale.set(width, width, length);
    instanceMatrix.compose(instancePosition, instanceQuaternion, instanceScale);
    mesh.setMatrixAt(index, instanceMatrix);
    mesh.setColorAt(index, colorFor(velocity.y));
    sweep.lift = Math.max(sweep.lift, velocity.y);
    sweep.sink = Math.min(sweep.sink, velocity.y);
    sweep.speed = Math.max(sweep.speed, speed);
    return true;
  }

  const hiddenMatrix = new T.Matrix4().makeScale(0, 0, 0);
  // The current sweep: the grid is latched when it starts so every arrow of one pass shares it.
  const sweep = { nextColumn: 0, originX: 0, originZ: 0, altitude: 0, visible: 0, lift: 0, sink: 0, speed: 0, ms: 0, chunkMs: 0 };

  function beginSweep() {
    const craft = state.player.position;
    sweep.nextColumn = 0;
    sweep.originX = Math.round(craft.x / SPACING) * SPACING;
    sweep.originZ = Math.round(craft.z / SPACING) * SPACING;
    sweep.altitude = Math.round(craft.y / ALTITUDE_STEP) * ALTITUDE_STEP;
    sweep.visible = 0;
    sweep.lift = 0;
    sweep.sink = 0;
    sweep.speed = 0;
    sweep.ms = 0;
    sweep.chunkMs = 0;
  }

  function finishSweep() {
    stats.arrows = sweep.visible;
    stats.maxLift = sweep.lift;
    stats.maxSink = sweep.sink;
    stats.maxSpeed = sweep.speed;
    stats.sampleMs = Math.round(sweep.ms * 100) / 100;
    stats.chunkMs = Math.round(sweep.chunkMs * 100) / 100;
  }

  /** Samples one grid column: the terrain-hugging arrow and, clear of it, the craft-altitude arrow. */
  function sampleColumn(column) {
    const half = (GRID_SIDE - 1) / 2;
    const x = sweep.originX + ((column % GRID_SIDE) - half) * SPACING;
    const z = sweep.originZ + (Math.floor(column / GRID_SIDE) - half) * SPACING;
    const surface = Math.max(world.groundHeight(x, z), world.WATER_LEVEL);
    const terrainY = surface + TERRAIN_AGL;
    const terrainSlot = column * LAYER_COUNT;
    if (writeArrow(terrainSlot, x, terrainY, z)) sweep.visible++;
    else mesh.setMatrixAt(terrainSlot, hiddenMatrix);
    if (sweep.altitude - terrainY > ALTITUDE_LAYER_CLEARANCE && writeArrow(terrainSlot + 1, x, sweep.altitude, z)) sweep.visible++;
    else mesh.setMatrixAt(terrainSlot + 1, hiddenMatrix);
  }

  /**
   * Resamples the next share of the grid: SAMPLE_HZ full passes per second, spread over the frames
   * in between so no single frame pays for the whole grid.
   */
  function resampleChunk(realDt) {
    const startMs = performance.now();
    if (sweep.nextColumn >= GRID_COLUMNS) beginSweep();
    const first = sweep.nextColumn;
    const share = Math.max(1, Math.ceil(GRID_COLUMNS * SAMPLE_HZ * Math.max(realDt, 0)));
    const last = Math.min(GRID_COLUMNS, first + share);
    for (let column = first; column < last; column++) sampleColumn(column);
    sweep.nextColumn = last;
    const firstSlot = first * LAYER_COUNT;
    const slotCount = (last - first) * LAYER_COUNT;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceColor.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(firstSlot * 16, slotCount * 16);
    mesh.instanceColor.addUpdateRange(firstSlot * 3, slotCount * 3);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    const elapsedMs = performance.now() - startMs;
    sweep.ms += elapsedMs;
    sweep.chunkMs = Math.max(sweep.chunkMs, elapsedMs);
    if (last >= GRID_COLUMNS) finishSweep();
  }

  const arrowsButton = (() => {
    const row = badgeWindRow();
    if (!row) return null;
    return createBadgeButton(row, 'Arrows', 'Wind arrows: warm lifts, cool sinks, length is speed', () => {
      settings.set('windOverlay', !settings.get('windOverlay'));
    });
  })();

  function applySetting() {
    const wanted = Boolean(settings.get('windOverlay'));
    arrowsButton?.setPressed(wanted);
    if (wanted === enabled) return;
    if (wanted && !ctx.wind?.probe) {
      console.error('[DRIFTWING] wind overlay: the wind field has no probe(); the overlay stays off.');
      return;
    }
    enabled = wanted;
    if (enabled && !mesh) mesh = buildMesh();
    if (mesh) mesh.visible = enabled;
    // A fresh pass starts on the next update, from the craft's current position.
    if (enabled) sweep.nextColumn = GRID_COLUMNS;
  }

  bus.on('settings:changed', (payload) => {
    if (payload && payload.key === 'windOverlay') applySetting();
  });
  applySetting();

  return {
    update(simDt, realDt) {
      if (!enabled) return;
      resampleChunk(realDt);
    },
    isEnabled: () => enabled,
    getStats() {
      return {
        enabled,
        arrows: stats.arrows,
        capacity: ARROW_CAPACITY,
        maxLift: Math.round(stats.maxLift * 100) / 100,
        maxSink: Math.round(stats.maxSink * 100) / 100,
        maxSpeed: Math.round(stats.maxSpeed * 100) / 100,
        sampleMs: stats.sampleMs,
        chunkMs: stats.chunkMs,
      };
    },
  };
}
