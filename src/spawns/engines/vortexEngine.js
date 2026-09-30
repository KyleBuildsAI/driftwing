// VortexEngine (registry name 'vortex'): tornadoes, waterspouts, the maelstrom's air column and,
// later, dust devils and eyewalls. docs/engines/vortex.md lists every param with its unit and range.
//
// One vortex is:
//   - a funnel shell: a tapered, twisting, translucent-to-opaque condensation tube that hangs from a
//     cloud base, flares into a lowered collar there, wobbles along a rope axis, descends to the
//     ground as it forms (touchdown) and thins, leans and lifts as it ropes out;
//   - soft condensation puffs that spiral up its skin and ring the collar;
//   - a ground-contact ring that lifts and orbits: brown debris over land, white spray over water
//     (the mix follows the surface under a vortex that tracks across a coast);
//   - a WindField 'rankine' source (windSources.js): solid-body core, 1/r outside, radial inflow,
//     a violent updraft core and heavy turbulence, its axis following the visible rope;
//   - optionally the preset's audio voice (the 'tornado' recipe), placed on the anchor.
// Lifecycle: forming (touchdown over formSeconds) -> mature -> ropeOut (ropeSeconds, timed to end
// with the event's duration) -> dissipated, where instance.ended tells the manager it is over. A
// vortex without a duration (a site) stays mature until instance.control.ropeOut is set. It can
// track across the terrain along a seeded path precomputed at create (so frames never query the
// terrain), riding the ground or the water under it.
//
// GPU: everything is shared and built once in init(): one shell mesh holding MAX_VORTICES tubes and
// one instanced sprite holding MAX_VORTICES particle blocks. Each vortex takes a slot; its motion is
// computed in the vertex shaders from a per-slot uniform block (uniformArray of Vector4) plus static
// per-particle seeds, so a frame writes a few dozen numbers and uploads no buffers. The same shaders
// run on WebGPU and WebGL2 (no compute, no storage buffers). A free slot draws nothing; dispose()
// returns the slot, so GPU memory stays at its post-init level (the shared meshes are prewarmed
// behind the loading fade).
//
// LOD: near draws everything; mid keeps the shell, 60 % of the puffs and 35 % of the ground ring;
// far hides a heavy preset (its lure takes over) and keeps a light preset's shell with a few puffs.
// The wind source is removed at 'far' when its reach (the inflow radius) is inside the nearest the
// far tier can start (lod.mid x 0.5 LOD bias x 0.92 hysteresis), so it can never touch the player
// there; it comes back at 'mid'.
//
// No allocations in update(): per-instance numbers live in a Float64Array, the slot block is written
// into pre-built Vector4s, the path is precomputed, and the wind source moves in place.
import { FRAME, FRAME_SIZE, checkSourceParamNames, createWindSource, resolveSourceParams } from './windSources.js';

export const MAX_VORTICES = 4;
const SHELL_SEGMENTS = 28;
const SHELL_ROWS = 40;
/** The shell rows above this share curve up into the cloud base and flare into the collar. */
const COLLAR_ROW = 0.86;
const GROUND_BLOCK = 4096;
const PUFF_BLOCK = 1024;
const BLOCK = GROUND_BLOCK + PUFF_BLOCK;
/** Vector4s per slot in the uniform block (element 0 is the shared clock). */
const SLOT_VECTORS = 11;
const LOD_GROUND_SHARE = Object.freeze({ near: 1, mid: 0.35, far: 0 });
const LOD_PUFF_SHARE = Object.freeze({ near: 1, mid: 0.6, far: 0.25 });
/** The smallest LOD bias the director applies, and the manager's LOD hysteresis. */
const MIN_LOD_BIAS = 0.5;
const LOD_HYSTERESIS = 0.08;
const PATH_STEP = 60;
const PATH_MAX_POINTS = 512;
const SITE_PATH_SECONDS = 600;
const VISIBILITY_RATE = 1.2;
/**
 * Aerial perspective (the clouds' model, not the terrain fog): a vortex hazes toward the sky colour
 * behind it from the fog's near distance to HAZE_FAR, at most HAZE_MAX, so a tornado a few
 * kilometres out still stands out like the clouds do. Its foot takes the terrain fog, so it sits in
 * the same air as the ground under it.
 */
const HAZE_FAR = 7500;
const HAZE_MAX = 0.9;
const STAGES = Object.freeze(['forming', 'mature', 'ropeOut', 'dissipated']);

// Per-instance numbers (Float64Array indices).
const S = Object.freeze({
  AGE: 0, STAGE: 1, STAGE_TIME: 2, FORM: 3, ROPE: 4, STRENGTH: 5, VISIBILITY: 6, ACTIVITY: 7, SPIN: 8,
  WATER: 9, VEL_X: 10, VEL_Z: 11, PREV_X: 12, PREV_Z: 13, WIND_ON: 14, GROUND_SHARE: 15, PUFF_SHARE: 16,
  VISIBLE_TARGET: 17, MATURE_END: 18, LEAN_X: 19, LEAN_Z: 20, DT: 21, WATER_TARGET: 22, SPIN_RATE: 23,
});
const STATE_SIZE = 24;
/** Ramps of the frame update (Float64Array slots, see writeSmoothstep). */
const R = Object.freeze({ FORM: 0, CONDENSE: 1, ROPE_FADE: 2, ROPE_LIFT: 3, ROPE_LEAN: 4, CONTACT_IN: 5, CONTACT_OUT: 6 });

/** Every vortex param: [name, default, min, max, isLength]. Lengths scale with the activation scale. */
const VORTEX_PARAMETERS = Object.freeze([
  ['coreRadius', 60, 2, 2000, true],
  ['topRadius', 240, 5, 6000, true],
  ['cloudBase', 900, 30, 12000, true],
  ['taper', 2.2, 0.5, 6, false],
  ['twist', 0.6, -4, 4, false],
  ['wobble', 25, 0, 2000, true],
  ['wobblePeriod', 9, 1, 120, false],
  ['ropeLean', 0.5, 0, 2, false],
  ['ropeThin', 0.22, 0.05, 1, false],
  ['collar', 0.8, 0, 3, false],
  ['opacity', 0.95, 0, 1, false],
  ['striation', 0.6, 0, 1, false],
  ['spin', 0, 0, 12, false],
  ['groundParticles', 2400, 0, GROUND_BLOCK, false],
  ['debrisRadius', 2.6, 0.5, 12, false],
  ['debrisHeight', 160, 0, 3000, true],
  ['particleSize', 3.5, 0.2, 60, true],
  ['sprayHeight', 70, 0, 2000, true],
  ['puffs', 420, 0, PUFF_BLOCK, false],
  ['puffSize', 80, 1, 1500, true],
  ['formSeconds', 20, 0, 600, false],
  ['ropeSeconds', 30, 0, 600, false],
  ['trackSpeed', 0, 0, 80, false],
  ['trackTurn', 0, -180, 180, false],
  ['trackWander', 20, 0, 90, false],
  ['trackMeander', 1500, 100, 20000, true],
  ['audioIntensity', 1, 0, 1, false],
]);
const COLOR_PARAMETERS = Object.freeze([
  ['color', 0xb8b2aa],
  ['shadeColor', 0x4b4e57],
  ['debrisColor', 0x5e4b3a],
  ['sprayColor', 0xe6eff2],
]);
const WIND_KEYS = Object.freeze(['maxTangential', 'inflowRadius', 'inflowSpeed', 'updraft', 'sinkRing', 'turbulence', 'gust', 'rotation']);
/** Every param name a vortex accepts, with the ones the SpawnManager merges in. */
const KNOWN_PARAMS = Object.freeze(new Set([
  ...VORTEX_PARAMETERS.map((entry) => entry[0]), ...COLOR_PARAMETERS.map((entry) => entry[0]), ...WIND_KEYS,
  'surface', 'startStage', 'voice', 'wind', 'windCoreRadius', 'windTop', 'scale',
  'position', 'heading', 'site', 'startTime', 'duration', 'seed',
]));

/**
 * target[index] = smoothstep(edge0, edge1, source[sourceIndex]). The frame update calls this instead
 * of a function taking or returning a computed double, which V8 boxes whenever it does not inline
 * the call (the edges are literals, which V8 keeps as constants).
 */
function writeSmoothstep(target, index, edge0, edge1, source, sourceIndex) {
  const t = Math.min(1, Math.max(0, (source[sourceIndex] - edge0) / (edge1 - edge0)));
  target[index] = t * t * (3 - 2 * t);
}

function readNumber(params, name, fallback, min, max) {
  const value = params[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value)) throw new TypeError(`[DRIFTWING] vortex: ${name} must be a finite number, got ${String(value)}`);
  return Math.min(max, Math.max(min, value));
}

function readColor(params, name, fallback) {
  const value = params[name];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) throw new TypeError(`[DRIFTWING] vortex: ${name} must be a 0xRRGGBB integer, got ${String(value)}`);
  return value;
}

/**
 * The resolved params of one vortex: every table entry (clamped, lengths times scale), the colours,
 * the surface, the start stage, the voice switch and the wind source params. The preset's own
 * 'rankine' wind entry (preset.wind) supplies wind defaults the engine params may override.
 */
export function resolveVortexParams(preset, params) {
  for (const key of Object.keys(params)) {
    if (!KNOWN_PARAMS.has(key)) throw new TypeError(`[DRIFTWING] vortex: "${key}" is not a vortex param (docs/engines/vortex.md lists them)`);
  }
  const scale = Number.isFinite(params.scale) && params.scale > 0 ? params.scale : 1;
  const resolved = { scale };
  for (const [name, fallback, min, max, isLength] of VORTEX_PARAMETERS) {
    const value = readNumber(params, name, fallback, min, max);
    resolved[name] = isLength ? value * scale : value;
  }
  resolved.groundParticles = Math.round(resolved.groundParticles);
  resolved.puffs = Math.round(resolved.puffs);
  for (const [name, fallback] of COLOR_PARAMETERS) resolved[name] = readColor(params, name, fallback);
  const surface = params.surface ?? 'auto';
  if (!['auto', 'land', 'water'].includes(surface)) throw new TypeError(`[DRIFTWING] vortex: surface must be 'auto', 'land' or 'water', got ${String(surface)}`);
  resolved.surface = surface;
  const startStage = params.startStage ?? 'forming';
  if (startStage !== 'forming' && startStage !== 'mature') throw new TypeError(`[DRIFTWING] vortex: startStage must be 'forming' or 'mature', got ${String(startStage)}`);
  resolved.startStage = startStage;
  resolved.voice = params.voice !== false;
  const presetWind = Array.isArray(preset.wind) ? preset.wind.find((entry) => entry && entry.type === 'rankine') : null;
  const windInput = { ...(presetWind && presetWind.params ? presetWind.params : {}) };
  checkSourceParamNames('rankine', windInput, `vortex: preset "${preset.id}" wind`);
  for (const key of WIND_KEYS) if (params[key] !== undefined) windInput[key] = params[key];
  // The wind's core and column follow the visible funnel unless the preset sets them apart.
  windInput.coreRadius = params.windCoreRadius ?? windInput.coreRadius ?? resolved.coreRadius / scale;
  windInput.top = params.windTop ?? windInput.top ?? resolved.cloudBase / scale;
  resolved.wind = params.wind === false ? null : resolveSourceParams('rankine', windInput, scale);
  return resolved;
}

export function createVortexEngine() {
  let ctx = null;
  let data = null;
  let shell = null;
  let shellGeometry = null;
  let shellMaterial = null;
  let particles = null;
  let bufferCount = 0;
  const active = [];
  let slots = null;
  /** The particle clock (s): kept in a typed array, as a double closure variable would box on every write. */
  const clock = new Float64Array(1);
  let lastFrame = -1;
  let live = 0;
  let serial = 0;
  let indicesPerShell = 0;
  const color = { r: 0, g: 0, b: 0 };

  // ---- Shared GPU resources ----------------------------------------------------------------------
  function buildShellGeometry(THREE) {
    const columns = SHELL_SEGMENTS + 1;
    const rows = SHELL_ROWS + 1;
    const vertsPerShell = columns * rows;
    const positions = new Float32Array(MAX_VORTICES * vertsPerShell * 3);
    const slotValues = new Float32Array(MAX_VORTICES * vertsPerShell);
    const indices = new Uint16Array(MAX_VORTICES * SHELL_SEGMENTS * SHELL_ROWS * 6);
    let vertex = 0;
    let index = 0;
    for (let slot = 0; slot < MAX_VORTICES; slot++) {
      const first = vertex;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const angle = (column / SHELL_SEGMENTS) * Math.PI * 2;
          positions[vertex * 3] = Math.cos(angle);
          positions[vertex * 3 + 1] = row / SHELL_ROWS;
          positions[vertex * 3 + 2] = Math.sin(angle);
          slotValues[vertex] = slot;
          vertex++;
        }
      }
      for (let row = 0; row < SHELL_ROWS; row++) {
        for (let column = 0; column < SHELL_SEGMENTS; column++) {
          const a = first + row * columns + column;
          const b = a + 1;
          const c = a + columns;
          const d = c + 1;
          indices[index++] = a;
          indices[index++] = c;
          indices[index++] = b;
          indices[index++] = b;
          indices[index++] = c;
          indices[index++] = d;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('vortexSlot', new THREE.BufferAttribute(slotValues, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    indicesPerShell = SHELL_SEGMENTS * SHELL_ROWS * 6;
    return geometry;
  }

  /** The node expressions shared by both materials: slot data access and the funnel's axis and radius. */
  function createShaderKit(TSL) {
    const { float, int, vec2, sin, pow, mix, clamp, smoothstep, saturate, normalize, length, cameraPosition, PI } = TSL;
    const element = (slotBase, offset) => data.element(slotBase.add(offset));
    const slotBaseOf = (slotNode) => int(slotNode.add(0.5)).mul(SLOT_VECTORS).add(1);
    /** The rope axis offset (x, z) at a height share of the cloud base. */
    const axisOffset = (block, heightShare) => {
      const bow = sin(clamp(heightShare, 0, 1).mul(PI));
      return vec2(block.d3.x.mul(heightShare).add(block.d3.z.mul(bow)), block.d3.y.mul(heightShare).add(block.d3.w.mul(bow)));
    };
    /** The funnel radius at a height share, thinned as it ropes out. */
    const funnelRadius = (block, heightShare) => {
      const taper = pow(clamp(heightShare, 0, 1), block.d2.x);
      return mix(block.d1.x, block.d1.y, taper).mul(mix(float(1), block.d9.w, block.d2.y));
    };
    const readBlock = (slotNode) => {
      const base = slotBaseOf(slotNode);
      const block = {};
      for (let offset = 0; offset < SLOT_VECTORS; offset++) block[`d${offset}`] = element(base, offset);
      return block;
    };
    /** The haze share at a world position (heightShare: its height over the cloud base). */
    const hazeAt = (worldPosition, heightShare) => {
      const globals = data.element(0);
      const distance = length(worldPosition.sub(cameraPosition));
      const air = smoothstep(globals.y, globals.z, distance).mul(HAZE_MAX);
      const ground = smoothstep(globals.y, globals.w, distance).mul(float(1).sub(smoothstep(0.05, 0.3, heightShare)));
      return air.max(ground);
    };
    /** The sky colour behind a world position (the sky's own function, as the fog and clouds use). */
    const skyBehind = (worldPosition) => {
      const ray = normalize(worldPosition.sub(cameraPosition));
      const skyColorNode = ctx.sky && typeof ctx.sky.skyColorNode === 'function' ? ctx.sky.skyColorNode : null;
      return skyColorNode ? skyColorNode(ray) : mix(ctx.uniforms.fogColor, ctx.uniforms.skyZenithColor, smoothstep(0.03, 0.6, saturate(ray.y)));
    };
    return { readBlock, axisOffset, funnelRadius, hazeAt, skyBehind };
  }

  function buildShellMaterial(THREE, TSL, uniforms) {
    const {
      float, vec3, vec4, sin, cos, pow, mix, smoothstep, saturate, max, abs, dot, normalize, clamp, step, atan, attribute,
      positionGeometry, positionWorld, cameraPosition, mx_noise_float, PI,
    } = TSL;
    const kit = createShaderKit(TSL);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    material.name = 'vortex-shell';
    const slot = attribute('vortexSlot', 'float');
    const clockNode = data.element(0).x;

    const block = kit.readBlock(slot);
    const cloudBase = max(block.d1.z, 1);
    const bottom = block.d1.w;
    const row = positionGeometry.y;
    // The tube runs from its bottom to just under the cloud base; the top rows widen a little into the
    // base and fade, hidden in the collar puffs (the lowered cloud).
    const along = clamp(row.div(COLLAR_ROW), 0, 1);
    const collar = clamp(row.sub(COLLAR_ROW).div(1 - COLLAR_ROW), 0, 1);
    const height = mix(bottom, cloudBase.mul(0.97), along).add(cloudBase.mul(0.03).mul(collar).mul(collar));
    const heightShare = height.div(cloudBase);
    const spin = block.d0.w;
    const twist = block.d6.w.mul(PI).mul(2).mul(heightShare);
    const angle = atan(positionGeometry.z, positionGeometry.x).add(spin).add(twist);
    const bulge = mx_noise_float(vec3(cos(angle).mul(1.6), height.mul(0.006).sub(clockNode.mul(0.25)), sin(angle).mul(1.6).add(slot.mul(7.3)))).mul(0.16);
    const flare = pow(collar, 1.5).mul(block.d10.x).mul(0.25).add(1);
    // A free or hidden slot collapses to its axis.
    const radius = kit.funnelRadius(block, heightShare).mul(bulge.add(1)).mul(flare).mul(step(0.001, block.d2.z));
    const axis = kit.axisOffset(block, heightShare);
    material.positionNode = vec3(
      block.d0.x.add(axis.x).add(cos(angle).mul(radius)),
      block.d0.y.add(height),
      block.d0.z.add(axis.y).add(sin(angle).mul(radius)),
    );

    // Fragment: condensation striations spiralling up, sun-wrapped shading with a dark backlit body
    // and a silver rim against the sun, a dusty foot over land, denser at the silhouette.
    const fragmentBlock = kit.readBlock(slot);
    const fragmentBase = max(fragmentBlock.d1.z, 1);
    const fragmentHeight = positionWorld.y.sub(fragmentBlock.d0.y);
    const fragmentShare = clamp(fragmentHeight.div(fragmentBase), 0, 1.2);
    const fragmentAxis = kit.axisOffset(fragmentBlock, fragmentShare);
    const radial = normalize(vec3(positionWorld.x.sub(fragmentBlock.d0.x.add(fragmentAxis.x)), 0.0001, positionWorld.z.sub(fragmentBlock.d0.z.add(fragmentAxis.y))));
    const viewDirection = normalize(cameraPosition.sub(positionWorld));
    // The surface normal of the tapering tube: the radial direction tipped down by the radius slope.
    const taper = fragmentBlock.d2.x;
    const slope = fragmentBlock.d1.y.sub(fragmentBlock.d1.x).mul(taper).mul(pow(max(fragmentShare, 0.001), taper.sub(1))).div(fragmentBase)
      .mul(mix(float(1), fragmentBlock.d9.w, fragmentBlock.d2.y));
    const surfaceNormal = normalize(vec3(radial.x, slope.negate(), radial.z));
    const rim = float(1).sub(abs(dot(surfaceNormal, viewDirection)));
    const streakAngle = atan(radial.z, radial.x).sub(fragmentBlock.d0.w).sub(fragmentBlock.d6.w.mul(PI).mul(2).mul(fragmentShare));
    const streaks = mx_noise_float(vec3(cos(streakAngle).mul(2.2), fragmentShare.mul(9).sub(clockNode.mul(0.9)), sin(streakAngle).mul(2.2)));
    const bands = mix(float(1), streaks.mul(0.4).add(0.8), fragmentBlock.d7.w);
    const sunDirection = uniforms.sunDirection;
    const sunUp = smoothstep(-0.12, 0.2, sunDirection.y);
    const facing = dot(radial, normalize(vec3(sunDirection.x, 0.0001, sunDirection.z)));
    const wrap = saturate(facing.mul(0.45).add(0.55));
    const backlit = saturate(dot(viewDirection.negate(), sunDirection));
    const funnelColor = fragmentBlock.d6.xyz;
    const shadeColor = fragmentBlock.d7.xyz;
    const body = mix(shadeColor, funnelColor.mul(uniforms.sunColor).mul(1.2), wrap.mul(sunUp).mul(float(1).sub(backlit.mul(0.6))));
    const collarShare = clamp(row.sub(COLLAR_ROW).div(1 - COLLAR_ROW), 0, 1);
    const silver = uniforms.sunColor.mul(pow(rim, 3).mul(backlit).mul(sunUp).mul(1.1).mul(float(1).sub(smoothstep(0.6, 0.95, fragmentShare))).mul(float(1).sub(collarShare)));
    const ambient = uniforms.skyZenithColor.mul(0.25).add(uniforms.skyHorizonColor.mul(0.08)).mul(funnelColor.add(0.2));
    const night = mix(float(1), float(0.3), uniforms.nightFactor);
    const dust = pow(float(1).sub(clamp(fragmentShare, 0, 1)), 3).mul(float(1).sub(fragmentBlock.d4.w)).mul(0.6);
    const dusty = fragmentBlock.d8.xyz.mul(uniforms.sunColor.mul(wrap.mul(sunUp).mul(0.7).add(0.3)));
    const shaded = mix(body.add(ambient), dusty.add(ambient.mul(0.5)), dust).add(silver).mul(night).mul(bands);
    material.colorNode = vec4(mix(shaded, kit.skyBehind(positionWorld), kit.hazeAt(positionWorld, fragmentShare)), 1);
    const footFade = smoothstep(0, 0.06, row);
    const collarFade = float(1).sub(smoothstep(0, 0.8, collarShare.add(streaks.mul(0.1))));
    // Thinner near the ground (condensation thins where the air warms), opaque aloft.
    const thinning = mix(float(0.7), float(1), smoothstep(0, 0.4, fragmentShare));
    // Soft, fuzzy edges: the shell fades out toward its silhouette, the way a cloud does.
    const edge = smoothstep(0.02, 0.4, float(1).sub(rim).add(streaks.mul(0.08)));
    const density = fragmentBlock.d2.w.mul(fragmentBlock.d2.z).mul(edge).mul(thinning).mul(mix(float(1), streaks.mul(0.3).add(0.85), fragmentBlock.d7.w));
    material.opacityNode = saturate(density.mul(footFade).mul(collarFade));
    return material;
  }

  function buildParticles(THREE, TSL, uniforms, rng) {
    const {
      float, vec2, vec3, vec4, sin, cos, pow, mix, smoothstep, saturate, fract, max, min, step, dot, clamp, normalize,
      uv, instancedBufferAttribute, varying, cameraPosition, PI,
    } = TSL;
    const count = MAX_VORTICES * BLOCK;
    const seeds = new Float32Array(count * 4);
    const slotsAndIndex = new Float32Array(count * 2);
    for (let index = 0; index < count; index++) {
      seeds[index * 4] = rng();
      seeds[index * 4 + 1] = rng();
      seeds[index * 4 + 2] = rng();
      seeds[index * 4 + 3] = rng();
      slotsAndIndex[index * 2] = Math.floor(index / BLOCK);
      slotsAndIndex[index * 2 + 1] = index % BLOCK;
    }
    const seedAttribute = new THREE.InstancedBufferAttribute(seeds, 4);
    const indexAttribute = new THREE.InstancedBufferAttribute(slotsAndIndex, 2);
    const seed = instancedBufferAttribute(seedAttribute, 'vec4');
    const slotIndex = instancedBufferAttribute(indexAttribute, 'vec2');
    const kit = createShaderKit(TSL);
    const block = kit.readBlock(slotIndex.x);
    const clockNode = data.element(0).x;
    const local = slotIndex.y;
    const isPuff = step(float(GROUND_BLOCK), local);
    const cloudBase = max(block.d1.z, 1);
    const spin = block.d0.w;

    // Ground ring: debris over land, spray over water (each particle rolls its kind against the water
    // share). Two thirds are a churning cloud (big, soft, faint: dust or mist), the rest fine bits
    // (small and dense: debris or droplets) flung out and up.
    const groundActive = step(local, block.d5.x.sub(0.5));
    const life = fract(clockNode.div(seed.y.mul(4).add(3.5)).add(seed.x));
    const spray = step(fract(seed.x.mul(7.13).add(seed.z.mul(3.7))), block.d4.w);
    const cloudy = step(fract(seed.w.mul(13.17).add(seed.y.mul(5.3))), 0.66);
    const ringRadius = block.d4.x.mul(seed.z.mul(0.9).add(0.35)).mul(mix(float(1), float(0.8), cloudy));
    const ringAngle = seed.w.mul(PI).mul(2).add(spin.mul(float(1.6).sub(seed.z))).add(life.mul(3));
    const debrisHeight = block.d4.y.mul(pow(life, 1.4)).mul(seed.y.mul(0.6).add(0.4)).mul(mix(float(1), float(0.55), cloudy));
    const sprayHeight = block.d8.w.mul(sin(life.mul(PI))).mul(seed.y.mul(0.5).add(0.5));
    const groundHeight = mix(debrisHeight, sprayHeight, spray);
    const groundRadius = ringRadius.mul(mix(life.mul(life).mul(0.8).add(1), life.mul(0.3).add(1), spray));
    const groundShare = groundHeight.div(cloudBase);
    const groundAxis = kit.axisOffset(block, groundShare);
    const bitSize = block.d5.z.mul(seed.y.mul(0.6).add(0.3));
    const cloudSize = block.d5.z.mul(seed.y.mul(5).add(4)).mul(life.mul(0.8).add(0.6));
    const groundSize = mix(bitSize, cloudSize, cloudy);
    const groundAlpha = smoothstep(0, 0.12, life).mul(float(1).sub(smoothstep(0.7, 1, life))).mul(block.d4.z).mul(groundActive)
      .mul(mix(mix(float(0.95), float(0.8), spray), mix(float(0.32), float(0.26), spray), cloudy));

    // Condensation puffs drift up the skin; a third build the lowered collar under the cloud base
    // (flattened sprites).
    const puffLocal = local.sub(GROUND_BLOCK);
    const puffActive = step(puffLocal, block.d5.y.sub(0.5));
    const puffLife = fract(clockNode.mul(0.35).div(seed.y.mul(4).add(3.5)).add(seed.x));
    const inCollar = step(0.6, seed.y).mul(step(0.01, block.d10.x));
    const bottomShare = clamp(block.d1.w.div(cloudBase), 0, 1);
    const skinShare = mix(bottomShare, float(1), puffLife);
    const collarShare = seed.z.mul(0.07).add(0.93);
    const puffShare = mix(skinShare, collarShare, inCollar);
    const skinRadius = kit.funnelRadius(block, puffShare).mul(seed.z.mul(0.35).add(1));
    const collarRadius = block.d1.y.mul(block.d10.x.mul(seed.z.mul(1.2).add(0.2)).add(1));
    const puffRadius = mix(skinRadius, collarRadius, inCollar);
    const puffAngle = seed.w.mul(PI).mul(2).add(spin.mul(mix(float(0.8), float(0.25), inCollar))).add(block.d6.w.mul(PI).mul(2).mul(puffShare));
    const puffAxis = kit.axisOffset(block, puffShare);
    const puffSize = block.d5.w.mul(seed.y.mul(0.8).add(0.6)).mul(mix(puffShare.mul(0.9).add(0.8), float(1.7), inCollar));
    const puffAlpha = smoothstep(0, 0.2, puffLife).mul(float(1).sub(smoothstep(0.7, 1, puffLife))).mul(puffActive).mul(block.d2.w).mul(mix(float(0.14), float(0.58), inCollar));

    const height = mix(groundHeight, puffShare.mul(cloudBase), isPuff);
    const radius = mix(groundRadius, puffRadius, isPuff);
    const angle = mix(ringAngle, puffAngle, isPuff);
    const axis = mix(groundAxis, puffAxis, isPuff);
    const visible = block.d2.z;
    const alpha = mix(groundAlpha, puffAlpha, isPuff).mul(visible);
    const size = mix(groundSize, puffSize, isPuff).mul(step(0.002, alpha));
    const flatten = inCollar.mul(isPuff);

    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    material.name = 'vortex-particles';
    material.positionNode = vec3(
      block.d0.x.add(axis.x).add(cos(angle).mul(radius)),
      block.d0.y.add(height),
      block.d0.z.add(axis.y).add(sin(angle).mul(radius)),
    );
    material.scaleNode = vec2(size.mul(flatten.mul(0.5).add(1)), size.mul(float(1).sub(flatten.mul(0.45))));
    material.rotationNode = seed.w.mul(6.283).add(clockNode.mul(seed.z.sub(0.5))).mul(float(1).sub(flatten));

    // Lit per particle in the vertex stage: the sun on the side of the ring facing it.
    const sunDirection = uniforms.sunDirection;
    const radialDirection = normalize(vec3(cos(angle), 0, sin(angle)));
    const wrap = saturate(dot(radialDirection, normalize(vec3(sunDirection.x, 0.0001, sunDirection.z))).mul(0.5).add(0.5));
    const sunUp = smoothstep(-0.12, 0.2, sunDirection.y);
    const ambient = uniforms.skyZenithColor.mul(0.25).add(uniforms.skyHorizonColor.mul(0.15));
    const debrisColor = block.d8.xyz.mul(mix(float(0.55), float(1.15), cloudy));
    const sprayColor = block.d9.xyz;
    const puffColor = mix(block.d6.xyz, block.d7.xyz, inCollar.mul(0.55));
    const albedo = mix(mix(debrisColor, sprayColor, spray), puffColor, isPuff);
    // Against the sun the ring and the puffs darken like the shell (the lit side faces away).
    const worldPosition = material.positionNode;
    const backlit = saturate(dot(normalize(worldPosition.sub(cameraPosition)), sunDirection)).mul(sunUp);
    const shade = mix(block.d7.xyz.mul(0.8), albedo.mul(uniforms.sunColor).mul(1.3), wrap.mul(sunUp).mul(0.8).add(0.2).mul(float(1).sub(backlit.mul(0.6))));
    const night = mix(float(1), float(0.3), uniforms.nightFactor);
    const lit = shade.add(ambient.mul(albedo.add(0.3))).mul(night);
    const hazed = mix(lit, kit.skyBehind(worldPosition), kit.hazeAt(worldPosition, height.div(cloudBase)));
    const tint = varying(vec4(hazed, alpha), 'vVortexTint');
    // Soft falloff: clouds, mist and puffs are wide and feathered, bits nearly solid.
    const softness = varying(mix(float(0.8), float(2.4), max(isPuff, cloudy)), 'vVortexSoftness');
    const radial = uv().sub(0.5).mul(2).length();
    material.colorNode = vec4(tint.rgb, 1);
    material.opacityNode = saturate(tint.a.mul(pow(saturate(float(1).sub(min(radial, float(1)).mul(radial))), softness)));

    const sprite = new THREE.Sprite(material);
    sprite.name = 'vortex-particles';
    sprite.count = 0;
    sprite.frustumCulled = false;
    sprite.renderOrder = 2;
    sprite.visible = false;
    return { sprite, material, attributes: [seedAttribute, indexAttribute] };
  }

  // ---- Slot block ------------------------------------------------------------------------------------
  function slotVector(slot, offset) {
    return data.array[1 + slot * SLOT_VECTORS + offset];
  }

  function writeColor(vector, hex, alpha) {
    color.r = ((hex >> 16) & 255) / 255;
    color.g = ((hex >> 8) & 255) / 255;
    color.b = (hex & 255) / 255;
    // sRGB to linear, as the renderer shades in linear space.
    vector.x = color.r <= 0.04045 ? color.r / 12.92 : Math.pow((color.r + 0.055) / 1.055, 2.4);
    vector.y = color.g <= 0.04045 ? color.g / 12.92 : Math.pow((color.g + 0.055) / 1.055, 2.4);
    vector.z = color.b <= 0.04045 ? color.b / 12.92 : Math.pow((color.b + 0.055) / 1.055, 2.4);
    vector.w = alpha;
  }

  /** Writes the static part of a slot's block (colours and shape constants) on create. */
  function writeStaticBlock(slot, p) {
    writeColor(slotVector(slot, 6), p.color, p.twist);
    writeColor(slotVector(slot, 7), p.shadeColor, p.striation);
    writeColor(slotVector(slot, 8), p.debrisColor, p.sprayHeight);
    writeColor(slotVector(slot, 9), p.sprayColor, p.ropeThin);
    slotVector(slot, 10).set(p.collar, 0, 0, 0);
  }

  function clearSlot(slot) {
    for (let offset = 0; offset < SLOT_VECTORS; offset++) slotVector(slot, offset).set(0, 0, 0, 0);
  }

  function refreshDrawRanges() {
    const high = slots.highWater;
    shellGeometry.setDrawRange(0, high * indicesPerShell);
    particles.sprite.count = high * BLOCK;
    shell.visible = high > 0;
    particles.sprite.visible = high > 0;
  }

  // ---- Path -------------------------------------------------------------------------------------------
  /**
   * The seeded track (x, z, surface height, water share per PATH_STEP metres), precomputed so frames
   * never query the terrain. A stationary vortex has one point.
   */
  function buildPath(p, position, heading, duration, rng) {
    const terrain = ctx.terrain;
    const seconds = p.trackSpeed > 0 ? (Number.isFinite(duration) && duration > 0 ? duration : SITE_PATH_SECONDS) : 0;
    const length = p.trackSpeed * seconds;
    const points = length > 0 ? Math.min(PATH_MAX_POINTS, Math.ceil(length / PATH_STEP) + 2) : 1;
    const step = points > 1 ? length / (points - 2) : 0;
    const path = new Float64Array(points * 4);
    let x = position.x;
    let z = position.z;
    // The track meanders: its heading swings up to trackWander degrees either side of the base
    // heading, once every trackMeander metres.
    const baseDirection = ((heading + p.trackTurn) * Math.PI) / 180;
    const wanderPhase = rng() * Math.PI * 2;
    const wander = (p.trackWander * Math.PI) / 180;
    for (let index = 0; index < points; index++) {
      const ground = terrain.groundHeight(x, z);
      const water = terrain.waterLevel;
      const overWater = ground < water ? 1 : 0;
      path[index * 4] = x;
      path[index * 4 + 1] = z;
      path[index * 4 + 2] = Math.max(ground, water);
      path[index * 4 + 3] = p.surface === 'water' ? 1 : p.surface === 'land' ? 0 : overWater;
      const direction = baseDirection + wander * Math.sin((2 * Math.PI * index * step) / p.trackMeander + wanderPhase);
      x += Math.sin(direction) * step;
      z -= Math.cos(direction) * step;
    }
    return { points: path, count: points, step };
  }

  // ---- Wind ----------------------------------------------------------------------------------------------
  function addWind(instance) {
    const record = instance.data;
    if (!record.windSource || record.state[S.WIND_ON] === 1) return;
    const source = record.windSource;
    ctx.wind.addSource({ id: source.id, kind: source.kind, bounds: source.refreshBounds(), sample: source.sample });
    record.state[S.WIND_ON] = 1;
    instance.windSourceIds.push(source.id);
  }

  function removeWind(instance) {
    const record = instance.data;
    if (!record.windSource || record.state[S.WIND_ON] !== 1) return;
    ctx.wind.removeSource(record.windSource.id);
    record.state[S.WIND_ON] = 0;
    const index = instance.windSourceIds.indexOf(record.windSource.id);
    if (index >= 0) instance.windSourceIds.splice(index, 1);
  }

  // ---- Stages ----------------------------------------------------------------------------------------------
  function enterStage(state, stage) {
    state[S.STAGE] = stage;
    state[S.STAGE_TIME] = 0;
  }

  function advanceStage(instance) {
    const record = instance.data;
    const state = record.state;
    const p = record.params;
    state[S.STAGE_TIME] += state[S.DT];
    const control = instance.control;
    const stage = state[S.STAGE];
    if (stage === 0) {
      state[S.FORM] = p.formSeconds > 0 ? Math.min(1, state[S.STAGE_TIME] / p.formSeconds) : 1;
      if (state[S.FORM] >= 1) enterStage(state, 1);
    } else if (stage === 1) {
      state[S.FORM] = 1;
      if (control.ropeOut === true || state[S.AGE] >= state[S.MATURE_END]) enterStage(state, 2);
    } else if (stage === 2) {
      state[S.ROPE] = p.ropeSeconds > 0 ? Math.min(1, state[S.STAGE_TIME] / p.ropeSeconds) : 1;
      if (state[S.ROPE] >= 1) enterStage(state, 3);
    } else if (!record.site) {
      instance.ended = true;
    }
  }

  // ---- Frame ---------------------------------------------------------------------------------------------------
  /** Advances the shared particle clock once per frame by the instance's frame time. */
  function advanceClock(state) {
    const frame = ctx.state.frame;
    if (frame === lastFrame) return;
    lastFrame = frame;
    clock[0] += state[S.DT];
    // Wrapped so float32 keeps millisecond resolution in the shaders over long sessions.
    if (clock[0] > 3600) clock[0] -= 3600;
    const globals = data.array[0];
    globals.x = clock[0];
    const fog = ctx.scene.fog;
    const fogNear = fog && Number.isFinite(fog.near) ? fog.near : 400;
    const fogFar = fog && Number.isFinite(fog.far) ? fog.far : 2400;
    globals.y = Math.max(350, fogNear * 0.9);
    globals.z = Math.max(globals.y + 100, HAZE_FAR);
    globals.w = Math.max(globals.y + 100, fogFar);
  }

  /** Moves the anchor along the precomputed path; the surface's water share goes to state[WATER_TARGET]. */
  function followPath(instance, record, state) {
    const path = record.path;
    const anchor = instance.anchor;
    let pointX;
    let pointZ;
    let surface;
    let water;
    if (path.count === 1 || path.step <= 0) {
      pointX = path.points[0];
      pointZ = path.points[1];
      surface = path.points[2];
      water = path.points[3];
    } else {
      let distance = record.params.trackSpeed * state[S.AGE];
      const span = (path.count - 2) * path.step;
      if (!Number.isFinite(record.duration)) {
        // Sites ping-pong along their path.
        const cycle = distance % (2 * span);
        distance = cycle > span ? 2 * span - cycle : cycle;
      }
      const position = Math.min(path.count - 1.0001, distance / path.step);
      const index = Math.floor(position);
      const blend = position - index;
      const base = index * 4;
      const points = path.points;
      pointX = points[base] + (points[base + 4] - points[base]) * blend;
      pointZ = points[base + 1] + (points[base + 5] - points[base + 1]) * blend;
      surface = points[base + 2] + (points[base + 6] - points[base + 2]) * blend;
      water = points[base + 3] + (points[base + 7] - points[base + 3]) * blend;
    }
    anchor.x = pointX;
    anchor.z = pointZ;
    anchor.y = surface;
    state[S.WATER_TARGET] = water;
  }

  /** Writes the stage's strength (state[STRENGTH]), the slot block and the wind frame. */
  function writeFrame(instance) {
    const record = instance.data;
    const state = record.state;
    const dt = state[S.DT];
    const p = record.params;
    const slot = record.slot;
    const age = state[S.AGE];
    const form = state[S.FORM];
    const rope = state[S.ROPE];
    const stage = state[S.STAGE];
    const anchor = instance.anchor;

    // Activity: the control intensity and a site's active state, eased.
    const control = instance.control;
    const wantActive = instance.active === false ? 0 : Math.min(1.5, Math.max(0, Number.isFinite(control.intensity) ? control.intensity : 1));
    state[S.ACTIVITY] += (wantActive - state[S.ACTIVITY]) * Math.min(1, dt * 0.5);
    const activity = state[S.ACTIVITY];
    const ramps = record.ramps;
    writeSmoothstep(ramps, R.FORM, 0, 1, state, S.FORM);
    writeSmoothstep(ramps, R.CONDENSE, 0, 0.2, state, S.FORM);
    writeSmoothstep(ramps, R.ROPE_FADE, 0.7, 1, state, S.ROPE);
    writeSmoothstep(ramps, R.ROPE_LIFT, 0.55, 1, state, S.ROPE);
    writeSmoothstep(ramps, R.ROPE_LEAN, 0, 0.8, state, S.ROPE);
    writeSmoothstep(ramps, R.CONTACT_IN, 0.35, 0.8, state, S.FORM);
    writeSmoothstep(ramps, R.CONTACT_OUT, 0.5, 0.85, state, S.ROPE);
    const lifeStrength = stage === 3 ? 0 : ramps[R.FORM] * (1 - rope) * Math.sqrt(1 - rope);
    const strength = lifeStrength * activity;
    state[S.STRENGTH] = strength;

    state[S.VISIBILITY] += (state[S.VISIBLE_TARGET] - state[S.VISIBILITY]) * Math.min(1, dt * VISIBILITY_RATE * 2);
    const condensation = (stage === 0 ? ramps[R.CONDENSE] : 1) * (1 - ramps[R.ROPE_FADE]) * Math.min(1, activity);
    const fade = condensation * state[S.VISIBILITY];

    const bottom = stage >= 2 ? p.cloudBase * 0.92 * ramps[R.ROPE_LIFT] : p.cloudBase * (1 - ramps[R.FORM]);
    const leanScale = p.ropeLean * p.cloudBase * ramps[R.ROPE_LEAN];
    const leanX = state[S.LEAN_X] * leanScale;
    const leanZ = state[S.LEAN_Z] * leanScale;
    const wobbleAmount = p.wobble * (1 + 2 * rope);
    const wobblePhase = (age * Math.PI * 2) / p.wobblePeriod + record.phase;
    const wobbleX = wobbleAmount * Math.sin(wobblePhase);
    const wobbleZ = wobbleAmount * Math.cos(wobblePhase * 0.77 + 1.3);
    const spinRate = state[S.SPIN_RATE] * (0.3 + 0.7 * strength);
    state[S.SPIN] = (state[S.SPIN] + spinRate * dt) % (Math.PI * 2000);
    const contact = ramps[R.CONTACT_IN] * (1 - ramps[R.CONTACT_OUT]) * Math.min(1, activity);

    const d0 = slotVector(slot, 0);
    d0.x = anchor.x;
    d0.y = anchor.y;
    d0.z = anchor.z;
    d0.w = state[S.SPIN];
    const d1 = slotVector(slot, 1);
    d1.x = p.coreRadius;
    d1.y = p.topRadius;
    d1.z = p.cloudBase;
    d1.w = bottom;
    const d2 = slotVector(slot, 2);
    d2.x = p.taper;
    d2.y = rope;
    d2.z = fade;
    d2.w = p.opacity;
    const d3 = slotVector(slot, 3);
    d3.x = leanX;
    d3.y = leanZ;
    d3.z = wobbleX;
    d3.w = wobbleZ;
    const d4 = slotVector(slot, 4);
    d4.x = p.coreRadius * p.debrisRadius * (1 + 0.6 * rope);
    d4.y = p.debrisHeight;
    d4.z = contact;
    d4.w = state[S.WATER];
    const groundCount = Math.round(p.groundParticles * state[S.GROUND_SHARE]);
    const puffCount = Math.round(p.puffs * state[S.PUFF_SHARE]);
    const d5 = slotVector(slot, 5);
    d5.x = groundCount;
    d5.y = puffCount;
    d5.z = p.particleSize;
    d5.w = p.puffSize;
    instance.particles = fade > 0.002 ? (contact > 0.002 ? groundCount : 0) + puffCount : 0;

    // The wind follows the same axis: lean and wobble from the cloud base to the wind's top.
    const frame = record.frame;
    if (frame) {
      const heightRatio = record.wind.top / p.cloudBase;
      frame[FRAME.X] = anchor.x;
      frame[FRAME.Y] = anchor.y;
      frame[FRAME.Z] = anchor.z;
      frame[FRAME.STRENGTH] = strength;
      frame[FRAME.AGE] = age;
      frame[FRAME.A] = leanX * heightRatio;
      frame[FRAME.B] = leanZ * heightRatio;
      frame[FRAME.C] = wobbleX;
      frame[FRAME.D] = wobbleZ;
    }
  }

  function moveWind(instance) {
    const record = instance.data;
    if (!record.windSource || record.state[S.WIND_ON] !== 1) return;
    const source = record.windSource;
    ctx.wind.setSourceBounds(source.id, source.refreshBounds());
  }

  function updateVoice(instance) {
    const record = instance.data;
    const state = record.state;
    const dt = state[S.DT];
    const anchor = instance.anchor;
    if (dt > 0) {
      state[S.VEL_X] = (anchor.x - state[S.PREV_X]) / dt;
      state[S.VEL_Z] = (anchor.z - state[S.PREV_Z]) / dt;
    }
    state[S.PREV_X] = anchor.x;
    state[S.PREV_Z] = anchor.z;
    if (!record.voice) return;
    record.velocity.x = state[S.VEL_X];
    record.velocity.z = state[S.VEL_Z];
    record.voice.setPosition(anchor, record.velocity);
    record.voice.setIntensity(Math.min(1, state[S.STRENGTH] * record.params.audioIntensity));
  }

  return {
    name: 'vortex',

    init(engineCtx) {
      ctx = engineCtx;
      const { THREE, TSL } = ctx;
      const vectors = Array.from({ length: 1 + MAX_VORTICES * SLOT_VECTORS }, () => new THREE.Vector4());
      data = TSL.uniformArray(vectors, 'vec4');
      vectors[0].set(0, 350, HAZE_FAR, 2400);
      slots = ctx.pools.createSlotAllocator(MAX_VORTICES);
      // A fixed seed: the particle seeds are the same every session (the look is deterministic).
      let seedState = 0x2545f491;
      const rng = () => {
        seedState = (seedState + 0x6d2b79f5) >>> 0;
        let mixed = seedState;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
      };
      shellGeometry = buildShellGeometry(THREE);
      shellMaterial = buildShellMaterial(THREE, TSL, ctx.uniforms);
      shell = new THREE.Mesh(shellGeometry, shellMaterial);
      shell.name = 'vortex-shells';
      shell.frustumCulled = false;
      shell.renderOrder = 2;
      shell.visible = false;
      ctx.scene.add(shell);
      particles = buildParticles(THREE, TSL, ctx.uniforms, rng);
      ctx.scene.add(particles.sprite);
      // GPU buffers: the shell's position, slot and index buffers, the particle seeds and indices, the uniform block.
      bufferCount = 3 + particles.attributes.length + 1;
      if (typeof ctx.registerPrewarm === 'function') {
        ctx.registerPrewarm(shell);
        ctx.registerPrewarm(particles.sprite);
      }
    },

    create(preset, params, rng) {
      const { THREE } = ctx;
      const p = resolveVortexParams(preset, params);
      const slot = slots.alloc();
      if (slot < 0) throw new Error(`[DRIFTWING] vortex: all ${MAX_VORTICES} vortex slots are in use`);
      const heading = Number.isFinite(params.heading) ? params.heading : 0;
      const duration = Number.isFinite(params.duration) && params.duration > 0 ? params.duration : null;
      const path = buildPath(p, params.position, heading, duration, rng);
      const state = new Float64Array(STATE_SIZE);
      state[S.STAGE] = p.startStage === 'mature' ? 1 : 0;
      state[S.FORM] = p.startStage === 'mature' ? 1 : 0;
      state[S.MATURE_END] = duration === null ? Infinity : Math.max(p.startStage === 'mature' ? 0 : p.formSeconds, duration - p.ropeSeconds);
      state[S.VISIBILITY] = 1;
      state[S.VISIBLE_TARGET] = 1;
      state[S.ACTIVITY] = 1;
      state[S.GROUND_SHARE] = 1;
      state[S.PUFF_SHARE] = 1;
      state[S.SPIN] = rng() * Math.PI * 2;
      // The visible spin (rad/s): the param, or a calm fraction of the wind's core rotation.
      state[S.SPIN_RATE] = p.spin > 0 ? p.spin : Math.min(3, (0.35 * (p.wind ? p.wind.maxTangential : 40)) / Math.max(p.coreRadius, 1));
      state[S.WATER] = path.points[3];
      // Rope-out leans the rope away from its track, to a seeded side.
      const leanAngle = ((heading + p.trackTurn + (rng() < 0.5 ? 90 : -90) + (rng() - 0.5) * 60) * Math.PI) / 180;
      state[S.LEAN_X] = Math.sin(leanAngle);
      state[S.LEAN_Z] = -Math.cos(leanAngle);
      const anchor = params.position;
      anchor.set(path.points[0], path.points[2], path.points[1]);
      state[S.PREV_X] = anchor.x;
      state[S.PREV_Z] = anchor.z;

      const record = {
        slot,
        params: p,
        wind: p.wind,
        path,
        state,
        ramps: new Float64Array(7),
        duration,
        site: params.site ?? null,
        phase: rng() * Math.PI * 2,
        frame: null,
        windSource: null,
        voice: null,
        velocity: new THREE.Vector3(),
        preset,
      };
      const instance = {
        anchor,
        radius: Math.max(p.topRadius * (1 + p.collar), p.coreRadius * p.debrisRadius),
        windSourceIds: [],
        lights: 0,
        particles: 0,
        tier: 'near',
        control: { intensity: 1, ropeOut: false },
        data: record,
      };
      clearSlot(slot);
      writeStaticBlock(slot, p);
      try {
        if (p.wind) {
          const frame = new Float64Array(FRAME_SIZE);
          frame[FRAME.X] = anchor.x;
          frame[FRAME.Y] = anchor.y;
          frame[FRAME.Z] = anchor.z;
          frame[FRAME.DIR_X] = Math.sin((heading * Math.PI) / 180);
          frame[FRAME.DIR_Z] = -Math.cos((heading * Math.PI) / 180);
          frame[FRAME.PHASE] = rng() * Math.PI * 2;
          record.frame = frame;
          serial++;
          record.windSource = createWindSource(THREE, { id: `vortex:${params.seed ?? 0}:${serial}`, type: 'rankine', params: p.wind, frame, kind: 'spawn-vortex' });
          addWind(instance);
        }
        if (preset.audio && p.voice && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
          record.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: 0 });
        }
      } catch (error) {
        removeWind(instance);
        clearSlot(slot);
        slots.free(slot);
        refreshDrawRanges();
        throw error;
      }
      live++;
      active.push(instance);
      writeFrame(instance);
      refreshDrawRanges();
      return instance;
    },

    update(instance, dt) {
      const record = instance.data;
      const state = record.state;
      state[S.DT] = dt;
      advanceClock(state);
      state[S.AGE] += dt;
      advanceStage(instance);
      followPath(instance, record, state);
      state[S.WATER] += (state[S.WATER_TARGET] - state[S.WATER]) * Math.min(1, dt * 0.4);
      writeFrame(instance);
      moveWind(instance);
      updateVoice(instance);
    },

    setLOD(instance, tier) {
      const record = instance.data;
      const state = record.state;
      const heavyFar = tier === 'far' && instance.heavy === true;
      state[S.VISIBLE_TARGET] = heavyFar ? 0 : 1;
      state[S.GROUND_SHARE] = LOD_GROUND_SHARE[tier] ?? 1;
      state[S.PUFF_SHARE] = heavyFar ? 0 : LOD_PUFF_SHARE[tier] ?? 1;
      instance.tier = tier;
      if (!record.windSource) return;
      const lod = record.preset.lod;
      const farStartsAt = lod && Number.isFinite(lod.mid) ? lod.mid * MIN_LOD_BIAS * (1 - LOD_HYSTERESIS) : Infinity;
      if (tier === 'far' && record.windSource.reach < farStartsAt) removeWind(instance);
      else addWind(instance);
    },

    dispose(instance) {
      const record = instance.data;
      removeWind(instance);
      if (record.voice) {
        record.voice.dispose();
        record.voice = null;
      }
      clearSlot(record.slot);
      slots.free(record.slot);
      refreshDrawRanges();
      live--;
      const index = active.indexOf(instance);
      if (index >= 0) active.splice(index, 1);
    },

    stats() {
      let particleCount = 0;
      for (const instance of active) particleCount += instance.particles;
      return {
        instances: live,
        particles: particleCount,
        lights: 0,
        buffers: bufferCount,
        drawCalls: (shell && shell.visible ? 1 : 0) + (particles && particles.sprite.visible ? 1 : 0),
      };
    },

    /**
     * Dev inspection: an instance's stage, its lifecycle numbers and its slot's uniform block (the
     * values the shaders read this frame).
     */
    describe(instance) {
      const record = instance.data;
      const state = record.state;
      const block = [];
      for (let offset = 0; offset < SLOT_VECTORS; offset++) block.push(slotVector(record.slot, offset).toArray());
      return {
        stage: STAGES[state[S.STAGE]],
        age: state[S.AGE],
        form: state[S.FORM],
        rope: state[S.ROPE],
        strength: state[S.STRENGTH],
        visibility: state[S.VISIBILITY],
        water: state[S.WATER],
        slot: record.slot,
        windOn: state[S.WIND_ON] === 1,
        clock: clock[0],
        block,
      };
    },
  };
}
