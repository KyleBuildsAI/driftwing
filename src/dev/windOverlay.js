// Dev wind-arrow overlay: instanced arrows on a grid around the craft showing the WindField velocity.
//
// Two layers of GRID_SIDE x GRID_SIDE arrows share one grid snapped to SPACING (so arrows stay put
// while the craft moves): one hugging the terrain TERRAIN_AGL above the ground or water (ridge lift on
// windward slopes, sink in the lee), one at the craft's own altitude (thermals, their sinking rings,
// wind sources). Arrow length follows the speed, colour follows the vertical component: warm for lift,
// cool for sink, pale for level air.
//
// The field is read through wind.probe, so the craft's own per-layer reading (wind.lastLayers) is
// never disturbed, and resampled at SAMPLE_HZ rather than every frame. The mesh is built on first
// use. Toggled by settings.windOverlay (settings panel, Developer group) and by the Arrows button the
// overlay adds to the dev badge. It is an ordinary scene object that exists only while the setting
// is on, so photo captures contain it only when the overlay is enabled.

const GRID_SIDE = 13;
const SPACING = 64;
const LAYER_COUNT = 2;
const ARROW_CAPACITY = GRID_SIDE * GRID_SIDE * LAYER_COUNT;
const TERRAIN_AGL = 45;
/** The altitude layer snaps to this step, and is skipped where it would sit on the terrain layer. */
const ALTITUDE_STEP = 10;
const ALTITUDE_LAYER_CLEARANCE = 30;
const SAMPLE_HZ = 5;
const LENGTH_PER_METRE_PER_SECOND = 4.5;
const MIN_LENGTH = 6;
const MAX_LENGTH = 56;
const WIDTH_BASE = 7;
const WIDTH_PER_LENGTH = 0.16;
/** Vertical wind (m/s) that reaches the full lift or sink colour. */
const VERTICAL_FULL = 3;
// Linear colours: level air, lift, sink.
const LEVEL_COLOR = [0.82, 0.85, 0.9];
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
  let sampleTimer = 0;
  const windSample = { vel: new T.Vector3(), turbulence: 0 };
  const probePoint = new T.Vector3();
  const direction = new T.Vector3();
  const forward = new T.Vector3(0, 0, 1);
  const instanceMatrix = new T.Matrix4();
  const instancePosition = new T.Vector3();
  const instanceQuaternion = new T.Quaternion();
  const instanceScale = new T.Vector3();
  const instanceColor = new T.Color();
  const stats = { arrows: 0, maxLift: 0, maxSink: 0, maxSpeed: 0, sampleMs: 0 };

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
    for (let index = 0; index < ARROW_CAPACITY; index++) arrows.setColorAt(index, instanceColor.setRGB(...LEVEL_COLOR));
    arrows.instanceColor.setUsage(T.DynamicDrawUsage);
    arrows.count = 0;
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

  /** Samples the field at (x, y, z) and writes one arrow centred there; false when the air is still. */
  function writeArrow(index, x, y, z) {
    probePoint.set(x, y, z);
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
    stats.maxLift = Math.max(stats.maxLift, velocity.y);
    stats.maxSink = Math.min(stats.maxSink, velocity.y);
    stats.maxSpeed = Math.max(stats.maxSpeed, speed);
    return true;
  }

  function resample() {
    const startMs = performance.now();
    const craft = state.player.position;
    const originX = Math.round(craft.x / SPACING) * SPACING;
    const originZ = Math.round(craft.z / SPACING) * SPACING;
    const altitude = Math.round(craft.y / ALTITUDE_STEP) * ALTITUDE_STEP;
    const half = (GRID_SIDE - 1) / 2;
    stats.maxLift = 0;
    stats.maxSink = 0;
    stats.maxSpeed = 0;
    let count = 0;
    for (let row = 0; row < GRID_SIDE; row++) {
      const z = originZ + (row - half) * SPACING;
      for (let column = 0; column < GRID_SIDE; column++) {
        const x = originX + (column - half) * SPACING;
        const surface = Math.max(world.groundHeight(x, z), world.WATER_LEVEL);
        const terrainY = surface + TERRAIN_AGL;
        if (writeArrow(count, x, terrainY, z)) count++;
        if (altitude - terrainY > ALTITUDE_LAYER_CLEARANCE && writeArrow(count, x, altitude, z)) count++;
      }
    }
    mesh.count = count;
    stats.arrows = count;
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceColor.clearUpdateRanges();
    if (count > 0) {
      mesh.instanceMatrix.addUpdateRange(0, count * 16);
      mesh.instanceColor.addUpdateRange(0, count * 3);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    stats.sampleMs = Math.round((performance.now() - startMs) * 100) / 100;
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
    // Resample on the next update so a fresh grid appears at once.
    sampleTimer = 0;
  }

  bus.on('settings:changed', (payload) => {
    if (payload && payload.key === 'windOverlay') applySetting();
  });
  applySetting();

  return {
    update(simDt, realDt) {
      if (!enabled) return;
      sampleTimer -= realDt;
      if (sampleTimer > 0) return;
      sampleTimer = 1 / SAMPLE_HZ;
      resample();
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
      };
    },
  };
}
