// The light-effect engine's glow points: one shared additive pool of camera-facing points, drawn in a
// single call, for glows (lava vents, crystal tips, lamps), firefly swarms and lantern halos. No
// real light per point: emissive colour plus bloom.
//
// Groups (one per light-effect instance) own a row of a small uniform table (a Float32Array of vec4
// elements in a uniform buffer, uploaded as it is: no per-element copy every frame): the group's origin
// relative to the mesh's origin, the camera to the metre (written each frame in float64 on the CPU)
// and its fade (activation, tier, day and night visibility); then its near-fade distance, how far
// its blink phases spread (1 - sync) and its fog strength. Points own slots in PAGE_SIZE pages;
// each has four static records written once, when its instance is created:
//   pointA  home position (m, relative to the group origin), size (m)
//   pointB  linear colour times intensity (HDR), group row + SHAPE_STRIDE x shape
//   pointC  wander radius (m), wander rate (rad/s), phase (rad), vertical wander (share)
//   pointD  blink period (s), blink duty (0 = steady), pulse depth, flicker
// Everything that moves is a closed-form function of time in the vertex shader (drifting,
// blinking, pulsing, flickering), identical on WebGPU and WebGL2, with no per-frame CPU work per
// point. Far points keep a minimum size on screen and dim with it, so a swarm 500 m away is a field
// of faint sparks rather than nothing.
import { createSlotAllocator } from '../pools.js';
import { createRangeList } from './engineKit.js';

export const GLOW_PAGE_SIZE = 256;
export const GLOW_SHAPES = Object.freeze(['orb', 'flare', 'firefly']);
const GROUP_ROWS = 2;
/** pointB.w packs the group row and the shape: row + SHAPE_STRIDE * shape. */
const SHAPE_STRIDE = 16;
/** Smallest drawn size as a share of the distance (about 2 px at 1080p): farther points dim instead. */
const MIN_ANGULAR_SIZE = 0.0022;
const RENDER_ORDER = 6;

/**
 * Builds the pool. options: THREE, TSL, scene, sky (the sky system: its fogAmountNode gives the points
 * the scene's haze; without it, as in the labs, a linear fog stands in), maxGroups, pages.
 */
export function createGlowPoints({ THREE, TSL, scene, sky = null, maxGroups, pages }) {
  if (maxGroups > SHAPE_STRIDE) throw new RangeError(`glow points: at most ${SHAPE_STRIDE} groups`);
  const {
    Fn, float, int, vec2, vec3, vec4, uniform, buffer, instancedBufferAttribute, positionGeometry,
    modelViewMatrix, cameraProjectionMatrix, uv, varyingProperty, abs, exp, sin, cos, floor, fract, max, mix, pow,
    smoothstep, saturate, length, select,
  } = TSL;
  const capacity = pages * GLOW_PAGE_SIZE;
  /** Element row * GROUP_ROWS + index holds [4e, 4e + 3]: see the header for the two rows. */
  const groupData = new Float32Array(maxGroups * GROUP_ROWS * 4);
  const groupTable = buffer(groupData, 'vec4', maxGroups * GROUP_ROWS);
  /**
   * The mesh's origin: the camera position rounded to whole metres (the group table is relative to
   * it). Whole metres are small integers, which the mesh position (a Vector3, whose fields hold
   * boxed numbers in the running game) takes without a new heap number each frame.
   */
  const origin = new Float64Array(3);
  // The frame scalars share one vec4 uniform: a Vector4 takes new numbers in place, a float uniform
  // boxes each one.
  const frameValues = uniform(new THREE.Vector4(0, 400, 2400, 0));
  const clock = frameValues.x;
  const fogNear = frameValues.y;
  const fogFar = frameValues.z;
  const groups = createSlotAllocator(maxGroups);
  const pageSlots = createSlotAllocator(pages);

  const attributes = [0, 1, 2, 3].map(() => new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  for (const attribute of attributes) attribute.updateRanges = createRangeList(1);
  const arrays = attributes.map((attribute) => attribute.array);
  const range = { start: 0, count: 0 };

  const pointA = instancedBufferAttribute(attributes[0], 'vec4');
  const pointB = instancedBufferAttribute(attributes[1], 'vec4');
  const pointC = instancedBufferAttribute(attributes[2], 'vec4');
  const pointD = instancedBufferAttribute(attributes[3], 'vec4');
  const vColor = varyingProperty('vec3', 'vGlowColor');
  const vShape = varyingProperty('vec2', 'vGlowShape');

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  material.vertexNode = Fn(() => {
    const shape = floor(pointB.w.div(SHAPE_STRIDE));
    const row = int(pointB.w.sub(shape.mul(SHAPE_STRIDE)));
    const group = groupTable.element(row.mul(GROUP_ROWS));
    const style = groupTable.element(row.mul(GROUP_ROWS).add(1));
    const time = clock;
    // Drift: three incommensurate sines around the home position.
    const phase = pointC.z;
    const wanderTime = time.mul(pointC.y);
    const wander = vec3(
      sin(wanderTime.add(phase)).add(sin(wanderTime.mul(2.31).add(phase.mul(1.7))).mul(0.35)),
      sin(wanderTime.mul(0.63).add(phase.mul(2.9))).mul(pointC.w),
      cos(wanderTime.mul(0.81).add(phase.mul(2.3))).add(cos(wanderTime.mul(1.93).add(phase)).mul(0.35)),
    ).mul(pointC.x);
    const offset = pointA.xyz.add(wander).add(group.xyz);
    const distance = length(offset);
    // Blink (a lit window of duty in each period, the phases partly synchronised), pulse, flicker.
    const period = max(pointD.x, 0.001);
    const cycle = fract(time.div(period).add(phase.mul(style.z).div(Math.PI * 2)));
    const duty = pointD.y;
    const blinkWindow = smoothstep(0, max(duty.mul(0.3), 0.001), cycle).mul(float(1).sub(smoothstep(duty.mul(0.55), max(duty, 0.002), cycle)));
    const blink = select(duty.greaterThan(0), mix(0.04, 1, blinkWindow), float(1));
    const pulse = select(duty.lessThanEqual(0).and(pointD.x.greaterThan(0)),
      float(1).sub(pointD.z.mul(sin(time.mul(Math.PI * 2).div(period).add(phase)).mul(0.5).add(0.5))), float(1));
    const flicker = float(1).sub(pointD.w.mul(sin(time.mul(23.1).add(phase.mul(7))).mul(sin(time.mul(9.7).add(phase.mul(3)))).mul(0.5).add(0.5)));
    // A far point keeps a minimum size on screen and dims with it (linearly, not by the area: a swarm
    // far away should still read as a faint glitter, as the eye adapted to the night sees it).
    const size = pointA.w;
    const drawnSize = max(size, distance.mul(MIN_ANGULAR_SIZE));
    const areaDim = size.div(drawnSize);
    const nearFade = smoothstep(style.y.mul(0.5), style.y, distance);
    const haze = sky && typeof sky.fogAmountNode === 'function' ? sky.fogAmountNode(offset) : smoothstep(fogNear, fogFar, distance);
    const fog = haze.mul(style.w);
    const level = blink.mul(pulse).mul(flicker).mul(group.w).mul(areaDim).mul(nearFade).mul(float(1).sub(fog));
    vColor.assign(pointB.xyz.mul(level));
    vShape.assign(vec2(shape, 0));
    const viewCentre = modelViewMatrix.mul(vec4(offset, 1));
    const visible = select(level.greaterThan(0.0001), float(1), float(0));
    const corner = positionGeometry.xy.mul(drawnSize).mul(visible);
    return cameraProjectionMatrix.mul(vec4(viewCentre.xy.add(corner), viewCentre.zw));
  })();

  const centred = uv().sub(0.5);
  const radius = length(centred).mul(2);
  const coverage = Fn(() => {
    const shape = vShape.x;
    const halo = pow(saturate(float(1).sub(radius)), 2.4);
    const core = pow(saturate(float(1).sub(radius.mul(2.6))), 2);
    // flare: a thin horizontal streak through the orb (lamps, lighthouses)
    const streak = exp(abs(centred.y).mul(-60)).mul(saturate(float(1).sub(abs(centred.x).mul(2)))).mul(0.8);
    // firefly: a tight hot point in a wide soft halo (the sprite is mostly halo, so a swarm reads as
    // soft lights at a distance, not single pixels)
    const firefly = pow(saturate(float(1).sub(radius)), 2.6).mul(0.45).add(pow(saturate(float(1).sub(radius.mul(5))), 2).mul(2.2));
    const orb = halo.mul(0.55).add(core.mul(1.4));
    return select(shape.lessThan(0.5), orb, select(shape.lessThan(1.5), orb.add(streak), firefly));
  })();
  material.colorNode = vColor.mul(coverage);
  material.opacityNode = saturate(coverage);

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'light-effect-glows';
  mesh.frustumCulled = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.count = 0;
  mesh.visible = false;
  scene.add(mesh);

  let dirtyLow = Infinity;
  let dirtyHigh = -1;

  return {
    mesh,
    groups,
    pageSlots,
    groupData,
    /** The mesh's origin (the camera to the metre, set by update): the group table is relative to it. */
    origin,
    capacity,
    /** Writes one point's records into slot (shape: an index of GLOW_SHAPES). */
    write(slot, x, y, z, size, red, green, blue, row, shape, wanderRadius, wanderRate, phase, vertical, blinkPeriod, blinkDuty, pulseDepth, flicker) {
      const offset = slot * 4;
      const [a, b, c, d] = arrays;
      a[offset] = x;
      a[offset + 1] = y;
      a[offset + 2] = z;
      a[offset + 3] = size;
      b[offset] = red;
      b[offset + 1] = green;
      b[offset + 2] = blue;
      b[offset + 3] = row + SHAPE_STRIDE * shape;
      c[offset] = wanderRadius;
      c[offset + 1] = wanderRate;
      c[offset + 2] = phase;
      c[offset + 3] = vertical;
      d[offset] = blinkPeriod;
      d[offset + 1] = blinkDuty;
      d[offset + 2] = pulseDepth;
      d[offset + 3] = flicker;
      if (slot < dirtyLow) dirtyLow = slot;
      if (slot > dirtyHigh) dirtyHigh = slot;
    },
    /** Clears a slot (its point is drawn no more). */
    clear(slot) {
      const offset = slot * 4;
      for (let index = 0; index < 4; index++) {
        const array = arrays[index];
        array[offset] = 0;
        array[offset + 1] = 0;
        array[offset + 2] = 0;
        array[offset + 3] = 0;
      }
      if (slot < dirtyLow) dirtyLow = slot;
      if (slot > dirtyHigh) dirtyHigh = slot;
    },
    /**
     * Once per frame: moves the mesh to the origin (the camera to the metre), uploads the slots
     * written since the last flush (one range), draws up to the highest page in use.
     * time is the sky's time state (its elapsed seconds drive the animation).
     */
    update(camera, time, fog) {
      const values = frameValues.value;
      values.x = time.elapsed;
      if (fog) {
        values.y = fog.near;
        values.z = fog.far;
      }
      origin[0] = Math.round(camera.position.x);
      origin[1] = Math.round(camera.position.y);
      origin[2] = Math.round(camera.position.z);
      const position = mesh.position;
      if (position.x !== origin[0]) position.x = origin[0];
      if (position.y !== origin[1]) position.y = origin[1];
      if (position.z !== origin[2]) position.z = origin[2];
      if (dirtyHigh >= dirtyLow) {
        // Points are written in whole instances at create and dispose: one range covers them. A range
        // three has not uploaded yet (the mesh was hidden) is widened, never dropped.
        const pending = attributes[0].updateRanges.length > 0;
        const start = pending ? Math.min(range.start / 4, dirtyLow) : dirtyLow;
        const end = pending ? Math.max((range.start + range.count) / 4 - 1, dirtyHigh) : dirtyHigh;
        range.start = start * 4;
        range.count = (end - start + 1) * 4;
        for (let index = 0; index < 4; index++) {
          const attribute = attributes[index];
          attribute.updateRanges.length = 0;
          attribute.updateRanges.add(range.start, range.count);
          attribute.needsUpdate = true;
        }
        dirtyLow = Infinity;
        dirtyHigh = -1;
      }
      mesh.count = pageSlots.highWater * GLOW_PAGE_SIZE;
      mesh.visible = mesh.count > 0;
    },
    get buffers() { return attributes.length + 1; },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
