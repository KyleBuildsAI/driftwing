import { CONFIG } from '../core/config.js';
import { createInstancedPool, createSlotAllocator } from '../spawns/pools.js';

/**
 * WATER EFFECTS: local deformation and shading added onto the v1 ocean (water.js), plus the spray
 * droplets and small local pools every water spawn shares. The water system creates one layer and
 * exposes it as ctx.systems.water.effects; the spawn engines reach it as the engine ctx's `water`.
 *
 * - Trail buffer: a 256 x 256 two-channel texture laid toroidally over the world (2.5 m texels, a
 *   640 m window that scrolls with the camera; texels entering the window are cleared). Channel R is
 *   bioluminescent excitation, channel G white foam. Anything touching the water writes into it: the
 *   craft (a contact query against its telemetry every frame), spawns through addWaterDisturbance /
 *   addWaterTrail / splash, and spray droplets landing back on the water. Both channels decay on the
 *   CPU (float shadow copies, only rows that hold something) and the bytes upload once per frame.
 *   Foam shows everywhere; excitation glows only inside a glow region (a bioluminescent bay).
 * - Vortices (up to 4): a whirlpool funnel displaced into the swell (a Rankine pressure dip), spiral
 *   ridges, and flow-mapped foam arms: noise advected around the eye at the Rankine angular speed in
 *   two phases half a period apart, masked by trailing log-spiral arms.
 * - Ripple rings (up to 8): expanding ring waves from splashes and breaches.
 * - Glow regions (up to 4): bioluminescent water. Swell crests glow (glowing surf) and every
 *   excitation in the trail buffer glows, stronger at night.
 * - Spray droplets: one instanced sprite batch (ballistic, drag, the ambient wind, mist that grows),
 *   lit by the sun and sky, glowing in a glow region; a droplet that falls back onto the water leaves
 *   a small splat in the trail buffer.
 * - Pools: local water discs above sea level (a waterfall's plunge pool) with churning foam.
 *
 * With nothing registered and an empty trail buffer every added term is exactly zero, so the ocean
 * renders exactly as in Phase 1; the shader work is also skipped then (uniform branches).
 * Every spawn-facing call takes plain numbers or a descriptor object the caller built once, so the
 * callers' frame updates allocate nothing (the numeric shorthands box their arguments when V8 does
 * not inline the call, so frequent writers use the mark form). The layer's own frame work allocates
 * nothing either: no
 * double crosses a call V8 may not inline (it would be boxed), mutable doubles live in typed arrays
 * rather than closure variables, and the float uniforms are vector components updated in place. Positions reach the GPU relative to the ocean grid's
 * camera-snapped anchor (float32-safe far from the origin).
 */
export const WATER_EFFECT_LIMITS = Object.freeze({ vortices: 4, ripples: 8, glowRegions: 4, pools: 4, droplets: 6144 });

const TRAIL_SIZE = 256;
const TRAIL_TEXEL = 2.5;
const TRAIL_SPAN = TRAIL_SIZE * TRAIL_TEXEL;
/** A single trail write never covers more than this radius (m): the splat cost stays bounded. */
const TRAIL_MAX_RADIUS = 40;
const GLOW_DECAY_SECONDS = 2.8;
const FOAM_DECAY_SECONDS = 6;
/** Values below this are cleared (the row then stops being processed). */
const TRAIL_EPSILON = 0.004;
const RIPPLE_SPEED = 7;
const RIPPLE_LIFE_SECONDS = 7;
const RIPPLE_WIDTH = 5;
const RIPPLE_WAVENUMBER = 0.9;
const RIPPLE_MAX_HEIGHT = 0.55;
/** Craft contact: below this height over the water the craft leaves a foam and glow trail. */
const CONTACT_HEIGHT = 3;
/** Down to this height the craft's downwash stirs the water (glow only, weaker with height). */
const DOWNWASH_HEIGHT = 14;
const CONTACT_RADIUS = 5;
/** Landing droplets that may splat the trail buffer per frame (the rest land silently). */
const DROPLET_SPLATS_PER_FRAME = 24;
const AMBIENT_WIND_SPEED = 6;
const GRAVITY = 9.81;
const TWO_PI = Math.PI * 2;
/** Flow-map period (s) of the whirlpool foam: two noise phases half a period apart. */
const FOAM_FLOW_PERIOD = 4;

/** Defaults of a spray descriptor (createSpray). */
const SPRAY_DEFAULTS = Object.freeze({
  x: 0, y: 0, z: 0,
  count: 40,
  speed: 8,
  up: 0.8,
  spread: 0.6,
  ringRadius: 0,
  swirl: 0,
  size: 0.9,
  sizeGrowth: 0.6,
  life: 1.8,
  drag: 0.8,
  gravity: 1,
  alpha: 0.7,
  glow: 0,
  inheritX: 0,
  inheritY: 0,
  inheritZ: 0,
});

/** Defaults of a vortex descriptor (createVortex). */
const VORTEX_DEFAULTS = Object.freeze({
  x: 0, z: 0, radius: 300, eyeRadius: 36, depth: 16, spin: 0.9, arms: 5, twist: 8, ridge: 0.6, foam: 0.9, direction: 1, weight: 1,
});

/** Defaults of a pool descriptor (createPool). */
const POOL_DEFAULTS = Object.freeze({ x: 0, y: 0, z: 0, radius: 50, churn: 0.8, glow: 0 });

/** Defaults of a glow region descriptor (createGlowRegion). */
const GLOW_REGION_DEFAULTS = Object.freeze({ x: 0, z: 0, radius: 900, strength: 1, surf: 0.6, color: 0x1f9dff });

/**
 * Defaults of a mark descriptor (createMark): one write into the trail buffer or the ripples. A disc
 * uses x, z, radius, foam and glow; a trail runs from (x, z) to (x1, z1); a ring adds width; a ripple
 * and a splash use strength (and a splash glow).
 */
const MARK_DEFAULTS = Object.freeze({ x: 0, z: 0, x1: 0, z1: 0, radius: 5, width: 3, foam: 0, glow: 0, strength: 0.5 });

/** Positive modulo (JS % keeps the dividend's sign). */
function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

/** Entries in the spray jitter table (a power of two). */
const SPRAY_NOISE_SIZE = 4096;

/**
 * Creates the water effects layer. ctx: the game ctx (THREE, TSL, scene, camera, state, uniforms,
 * world, systems.sky, registerPrewarm).
 */
export function createWaterEffects(ctx) {
  const { THREE: T, TSL: L, scene, state, uniforms, world } = ctx;
  const {
    Fn, If, uniform, uniformArray, float, vec3, vec4, sin, cos, atan, log, exp, length, max, min,
    smoothstep, saturate, mix, texture, mx_noise_float, varying, positionGeometry, abs, uv, pow, oneMinus,
    instancedDynamicBufferAttribute, normalize, dot, reflect, cameraViewMatrix, positionView, color,
  } = L;
  const waterLevel = CONFIG.WATER_LEVEL;

  // =============================================================================================
  // TRAIL BUFFER
  // =============================================================================================
  const trailGlow = new Float32Array(TRAIL_SIZE * TRAIL_SIZE);
  const trailFoam = new Float32Array(TRAIL_SIZE * TRAIL_SIZE);
  const trailBytes = new Uint8Array(TRAIL_SIZE * TRAIL_SIZE * 2);
  /** Per texture row: 1 while any texel of it holds a value. */
  const rowActive = new Uint8Array(TRAIL_SIZE);
  const trailTexture = new T.DataTexture(trailBytes, TRAIL_SIZE, TRAIL_SIZE, T.RGFormat, T.UnsignedByteType);
  trailTexture.name = 'water-trails';
  trailTexture.wrapS = T.RepeatWrapping;
  trailTexture.wrapT = T.RepeatWrapping;
  trailTexture.magFilter = T.LinearFilter;
  trailTexture.minFilter = T.LinearFilter;
  trailTexture.generateMipmaps = false;
  trailTexture.needsUpdate = true;
  // The window in texel coordinates: world texel columns [windowX, windowX + TRAIL_SIZE).
  let windowX = 0;
  let windowZ = 0;
  let windowReady = false;
  let trailDirty = false;
  let trailActiveRows = 0;
  let trailUploads = 0;

  function clearColumn(column) {
    for (let row = 0; row < TRAIL_SIZE; row++) {
      const index = row * TRAIL_SIZE + column;
      trailGlow[index] = 0;
      trailFoam[index] = 0;
      trailBytes[index * 2] = 0;
      trailBytes[index * 2 + 1] = 0;
    }
  }

  function clearRow(row) {
    const start = row * TRAIL_SIZE;
    trailGlow.fill(0, start, start + TRAIL_SIZE);
    trailFoam.fill(0, start, start + TRAIL_SIZE);
    trailBytes.fill(0, start * 2, (start + TRAIL_SIZE) * 2);
    rowActive[row] = 0;
  }

  /** Moves the window to centre on position, clearing the texels that now map to newly covered ground. */
  function scrollWindow(position) {
    const nextX = Math.floor(position.x / TRAIL_TEXEL) - TRAIL_SIZE / 2;
    const nextZ = Math.floor(position.z / TRAIL_TEXEL) - TRAIL_SIZE / 2;
    if (!windowReady || Math.abs(nextX - windowX) >= TRAIL_SIZE || Math.abs(nextZ - windowZ) >= TRAIL_SIZE) {
      for (let row = 0; row < TRAIL_SIZE; row++) clearRow(row);
      windowX = nextX;
      windowZ = nextZ;
      windowReady = true;
      trailDirty = true;
      return;
    }
    if (nextX !== windowX) {
      // Columns leaving on one side come back on the other: clear the world columns entering.
      const from = nextX > windowX ? windowX + TRAIL_SIZE : nextX;
      const to = nextX > windowX ? nextX + TRAIL_SIZE : windowX;
      for (let column = from; column < to; column++) clearColumn(positiveModulo(column, TRAIL_SIZE));
      windowX = nextX;
      trailDirty = true;
    }
    if (nextZ !== windowZ) {
      const from = nextZ > windowZ ? windowZ + TRAIL_SIZE : nextZ;
      const to = nextZ > windowZ ? nextZ + TRAIL_SIZE : windowZ;
      for (let row = from; row < to; row++) clearRow(positiveModulo(row, TRAIL_SIZE));
      windowZ = nextZ;
      trailDirty = true;
    }
  }

  /**
   * Raises one texel (world texel coordinates) to at least texelValue's foam [0] and glow [1]. The
   * values travel in a typed array, so no double is passed (and boxed) per texel.
   */
  const texelValue = new Float64Array(2);
  function raiseTexel(column, row) {
    const wrappedRow = ((row % TRAIL_SIZE) + TRAIL_SIZE) % TRAIL_SIZE;
    const index = wrappedRow * TRAIL_SIZE + ((column % TRAIL_SIZE) + TRAIL_SIZE) % TRAIL_SIZE;
    if (texelValue[0] > trailFoam[index]) trailFoam[index] = texelValue[0];
    if (texelValue[1] > trailGlow[index]) trailGlow[index] = texelValue[1];
    rowActive[wrappedRow] = 1;
  }

  /**
   * Writes a mark's capsule into the trail buffer: from (x, z) to (x1, z1) when segment is true, else
   * a disc at (x, z), of mark.radius metres with a smooth edge (max blend, so repeated writes never
   * saturate beyond their strength). Returns whether any of it lies inside the window.
   */
  function writeCapsule(mark, segment) {
    const x0 = mark.x;
    const z0 = mark.z;
    const x1 = segment ? mark.x1 : x0;
    const z1 = segment ? mark.z1 : z0;
    const radius = mark.radius;
    const foam = mark.foam;
    const glow = mark.glow;
    if (!windowReady || !(radius > 0) || (!(foam > 0) && !(glow > 0))) return false;
    const reach = Math.min(radius, TRAIL_MAX_RADIUS);
    const minColumn = Math.max(windowX, Math.floor((Math.min(x0, x1) - reach) / TRAIL_TEXEL));
    const maxColumn = Math.min(windowX + TRAIL_SIZE - 1, Math.floor((Math.max(x0, x1) + reach) / TRAIL_TEXEL));
    const minRow = Math.max(windowZ, Math.floor((Math.min(z0, z1) - reach) / TRAIL_TEXEL));
    const maxRow = Math.min(windowZ + TRAIL_SIZE - 1, Math.floor((Math.max(z0, z1) + reach) / TRAIL_TEXEL));
    if (minColumn > maxColumn || minRow > maxRow) return false;
    // Long segments are clamped to the window (at most the window's texels are visited).
    const segmentX = x1 - x0;
    const segmentZ = z1 - z0;
    const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
    const foamValue = Math.min(Math.max(foam, 0), 1);
    const glowValue = Math.min(Math.max(glow, 0), 1);
    const reachSq = reach * reach;
    for (let row = minRow; row <= maxRow; row++) {
      const centerZ = (row + 0.5) * TRAIL_TEXEL;
      for (let column = minColumn; column <= maxColumn; column++) {
        const centerX = (column + 0.5) * TRAIL_TEXEL;
        let t = segmentLengthSq > 1e-6 ? ((centerX - x0) * segmentX + (centerZ - z0) * segmentZ) / segmentLengthSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const offsetX = centerX - (x0 + segmentX * t);
        const offsetZ = centerZ - (z0 + segmentZ * t);
        const distanceSq = offsetX * offsetX + offsetZ * offsetZ;
        if (distanceSq >= reachSq) continue;
        const edge = 1 - distanceSq / reachSq;
        const weight = edge * edge * (3 - 2 * edge);
        texelValue[0] = foamValue * weight;
        texelValue[1] = glowValue * weight;
        raiseTexel(column, row);
      }
    }
    trailDirty = true;
    return true;
  }

  /** Writes a mark's thin ring (a foam decal around a splash): mark.radius and mark.width metres. */
  function writeRing(mark) {
    const x = mark.x;
    const z = mark.z;
    const radius = mark.radius;
    const width = Math.max(mark.width, 0.5);
    const foam = mark.foam;
    const glow = mark.glow;
    if (!windowReady) return false;
    const outer = Math.min(radius + width, TRAIL_MAX_RADIUS * 2);
    const minColumn = Math.max(windowX, Math.floor((x - outer) / TRAIL_TEXEL));
    const maxColumn = Math.min(windowX + TRAIL_SIZE - 1, Math.floor((x + outer) / TRAIL_TEXEL));
    const minRow = Math.max(windowZ, Math.floor((z - outer) / TRAIL_TEXEL));
    const maxRow = Math.min(windowZ + TRAIL_SIZE - 1, Math.floor((z + outer) / TRAIL_TEXEL));
    if (minColumn > maxColumn || minRow > maxRow) return false;
    for (let row = minRow; row <= maxRow; row++) {
      const offsetZ = (row + 0.5) * TRAIL_TEXEL - z;
      for (let column = minColumn; column <= maxColumn; column++) {
        const offsetX = (column + 0.5) * TRAIL_TEXEL - x;
        const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
        const across = Math.abs(distance - radius) / width;
        if (across >= 1) continue;
        const weight = 1 - across * across;
        texelValue[0] = foam * weight;
        texelValue[1] = glow * weight;
        raiseTexel(column, row);
      }
    }
    trailDirty = true;
    return true;
  }

  /** Decays both channels over the rows that hold something and refreshes their bytes. */
  function decayTrails() {
    const dt = frameState[STEP];
    const glowFactor = Math.exp(-dt / GLOW_DECAY_SECONDS);
    const foamFactor = Math.exp(-dt / FOAM_DECAY_SECONDS);
    let active = 0;
    for (let row = 0; row < TRAIL_SIZE; row++) {
      if (rowActive[row] === 0) continue;
      let any = false;
      const start = row * TRAIL_SIZE;
      for (let index = start; index < start + TRAIL_SIZE; index++) {
        let glow = trailGlow[index] * glowFactor;
        let foam = trailFoam[index] * foamFactor;
        if (glow < TRAIL_EPSILON) glow = 0;
        if (foam < TRAIL_EPSILON) foam = 0;
        trailGlow[index] = glow;
        trailFoam[index] = foam;
        trailBytes[index * 2] = Math.round(glow * 255);
        trailBytes[index * 2 + 1] = Math.round(foam * 255);
        if (glow > 0 || foam > 0) any = true;
      }
      rowActive[row] = any ? 1 : 0;
      if (any) active++;
      trailDirty = true;
    }
    trailActiveRows = active;
  }

  // =============================================================================================
  // UNIFORMS (vortices, ripples, glow regions)
  // =============================================================================================
  const MAX_VORTICES = WATER_EFFECT_LIMITS.vortices;
  const MAX_RIPPLES = WATER_EFFECT_LIMITS.ripples;
  const MAX_REGIONS = WATER_EFFECT_LIMITS.glowRegions;
  const vectors = (count) => Array.from({ length: count }, () => new T.Vector4());
  // Vortex i: A = (centre x, centre z relative to the grid anchor, radius, eye radius),
  // B = (depth, ridge height, arms, twist), C = (pattern phase, direction, foam, spin).
  const vortexA = uniformArray(vectors(MAX_VORTICES), 'vec4');
  const vortexB = uniformArray(vectors(MAX_VORTICES), 'vec4');
  const vortexC = uniformArray(vectors(MAX_VORTICES), 'vec4');
  // Ripple i: (x, z relative to the anchor, age s, strength 0..1).
  const rippleData = uniformArray(vectors(MAX_RIPPLES), 'vec4');
  // Region i: (x, z relative to the anchor, radius, strength); regionSurf: surf glow per region.
  const regionData = uniformArray(vectors(MAX_REGIONS), 'vec4');
  const regionSurf = uniformArray(vectors(MAX_REGIONS), 'vec4');
  const vortexCount = uniform(0);
  const rippleCount = uniform(0);
  const regionCount = uniform(0);
  const trailsActive = uniform(0);
  const trailOrigin = uniform(new T.Vector2());
  // The flow clock (s, wrapped hourly) and the glow visibility (night): one vec2 updated in place.
  const effectClock = uniform(new T.Vector2());
  const flowTime = effectClock.x;
  const glowColor = uniform(new T.Color(GLOW_REGION_DEFAULTS.color));
  let glowColorHex = GLOW_REGION_DEFAULTS.color;
  const glowVisibility = effectClock.y;
  const foamColor = uniform(new T.Color(1, 1, 1));

  // CPU state behind the uniforms (world coordinates in doubles).
  const vortexSlots = createSlotAllocator(MAX_VORTICES);
  const vortexState = Array.from({ length: MAX_VORTICES }, () => ({ ...VORTEX_DEFAULTS, pattern: 0, used: false }));
  const regionSlots = createSlotAllocator(MAX_REGIONS);
  const regionState = Array.from({ length: MAX_REGIONS }, () => ({ x: 0, z: 0, radius: 0, strength: 0, surf: 0, used: false }));
  const rippleX = new Float64Array(MAX_RIPPLES);
  const rippleZ = new Float64Array(MAX_RIPPLES);
  const rippleAge = new Float32Array(MAX_RIPPLES).fill(RIPPLE_LIFE_SECONDS);
  const rippleStrength = new Float32Array(MAX_RIPPLES);
  let rippleCursor = 0;

  // =============================================================================================
  // SHADER NODES (used by water.js)
  // =============================================================================================
  // The undisplaced grid-local position (relative to the grid anchor, which the uniforms share).
  const gridPosition = varying(positionGeometry.xz, 'vWaterEffectGrid');

  /** Funnel height (<= 0) of vortex index at grid-local p, spiral ridges included. */
  function vortexHeightNode(p, index) {
    const a = vortexA.element(index);
    const b = vortexB.element(index);
    const c = vortexC.element(index);
    const rel = p.sub(a.xy);
    const distance = length(rel);
    const radius = a.z;
    const eye = max(a.w, 1);
    const edge = float(1).div(float(1).add(radius.div(eye).mul(radius.div(eye))));
    const ratio = distance.div(eye);
    const shape = max(float(1).div(float(1).add(ratio.mul(ratio))).sub(edge).div(oneMinus(edge)), 0);
    // Counter-clockwise angle seen from above (+x east, -z north).
    const angle = atan(rel.y.negate(), rel.x);
    const spiral = sin(angle.mul(b.z).add(c.y.mul(b.w).mul(log(ratio.add(1)))).sub(c.x));
    const ridgeEnvelope = sin(saturate(distance.div(radius)).mul(Math.PI)).mul(smoothstep(0.4, 1.4, ratio));
    return shape.mul(b.x).negate().add(spiral.mul(b.y).mul(ridgeEnvelope));
  }

  /** Height of ripple ring index at grid-local p. */
  function rippleHeightNode(p, index) {
    const ripple = rippleData.element(index);
    const distance = length(p.sub(ripple.xy));
    const front = ripple.z.mul(RIPPLE_SPEED);
    const across = distance.sub(front).div(RIPPLE_WIDTH);
    const envelope = exp(across.mul(across).negate()).mul(ripple.w).mul(exp(ripple.z.mul(-1 / 2.5)));
    return envelope.mul(RIPPLE_MAX_HEIGHT).mul(sin(distance.sub(front).mul(RIPPLE_WAVENUMBER)));
  }

  /** Vertex stage: the vertical offset (m) at grid-local p from every vortex and ripple. */
  const displacementFn = Fn(([p]) => {
    const height = float(0).toVar();
    If(vortexCount.greaterThan(0.5), () => {
      for (let index = 0; index < MAX_VORTICES; index++) height.addAssign(vortexHeightNode(p, index));
    });
    If(rippleCount.greaterThan(0.5), () => {
      for (let index = 0; index < MAX_RIPPLES; index++) height.addAssign(rippleHeightNode(p, index));
    });
    return height;
  });

  /** Flow-mapped foam noise around a vortex (two phases half a period apart). */
  function flowFoamNode(rel, omega, direction, seed) {
    const result = float(0).toVar();
    for (let phaseIndex = 0; phaseIndex < 2; phaseIndex++) {
      const phase = flowTime.div(FOAM_FLOW_PERIOD).add(phaseIndex * 0.5).fract();
      const weight = oneMinus(abs(phase.mul(2).sub(1)));
      // Backward advection: sample where the water was `age` seconds ago.
      const turn = omega.mul(phase.mul(FOAM_FLOW_PERIOD)).mul(direction);
      const cosTurn = cos(turn);
      const sinTurn = sin(turn);
      const u = rel.x;
      const w = rel.y.negate();
      const rotatedU = u.mul(cosTurn).add(w.mul(sinTurn));
      const rotatedW = w.mul(cosTurn).sub(u.mul(sinTurn));
      const sample = mx_noise_float(vec3(rotatedU.mul(0.045), rotatedW.mul(0.045), seed.add(phaseIndex * 7.31)));
      result.addAssign(sample.mul(weight));
    }
    return result;
  }

  /**
   * Fragment stage: vec4(slope x, slope z, foam 0..1, glow) at grid-local p. waveHeight is the swell's
   * height there (crests glow in a glow region).
   */
  const surfaceFn = Fn(([p, waveHeight]) => {
    const slopeX = float(0).toVar();
    const slopeZ = float(0).toVar();
    const foam = float(0).toVar();
    const glow = float(0).toVar();
    If(vortexCount.greaterThan(0.5), () => {
      for (let index = 0; index < MAX_VORTICES; index++) {
        const a = vortexA.element(index);
        const b = vortexB.element(index);
        const c = vortexC.element(index);
        const rel = p.sub(a.xy);
        const distance = max(length(rel), 0.01);
        const radius = a.z;
        const eye = max(a.w, 1);
        const ratio = distance.div(eye);
        const edge = float(1).div(float(1).add(radius.div(eye).mul(radius.div(eye))));
        const inside = float(1).sub(smoothstep(radius.mul(0.97), radius, distance));
        // d(shape)/dr of the Rankine dip, times the depth: the funnel's radial slope (<= 0 inward).
        const denominator = float(1).add(ratio.mul(ratio));
        const radialSlope = ratio.mul(2).div(denominator.mul(denominator)).div(eye).div(oneMinus(edge)).mul(b.x).mul(inside);
        slopeX.addAssign(rel.x.div(distance).mul(radialSlope));
        slopeZ.addAssign(rel.y.div(distance).mul(radialSlope));
        const angle = atan(rel.y.negate(), rel.x);
        const armPhase = angle.mul(b.z).add(c.y.mul(b.w).mul(log(ratio.add(1)))).sub(c.x);
        const arms = smoothstep(0.3, 0.95, sin(armPhase).mul(0.5).add(0.5));
        // Rankine angular speed: solid rotation in the eye, spin * eye^2 / r^2 outside.
        const omega = c.w.mul(min(float(1), float(1).div(ratio.mul(ratio))));
        const flow = flowFoamNode(rel, omega, c.y, float(index * 3.7));
        const band = smoothstep(0.7, 1.6, ratio).mul(oneMinus(smoothstep(radius.mul(0.7), radius, distance)));
        const eyeRing = smoothstep(0.8, 1.2, ratio).mul(oneMinus(smoothstep(1.4, 2.6, ratio)));
        // Thin streaks wound along each arm, broken up by the advected noise.
        const streaks = smoothstep(0.25, 0.9, sin(armPhase.mul(3).add(flow.mul(2.5))).mul(0.5).add(0.5));
        const armFoam = arms.mul(streaks.mul(0.65).add(0.35)).mul(saturate(flow.mul(0.9).add(0.6))).mul(band);
        const ringFoam = eyeRing.mul(saturate(flow.mul(1.2).add(0.4)));
        foam.addAssign(saturate(armFoam.add(ringFoam)).mul(c.z));
      }
    });
    If(rippleCount.greaterThan(0.5), () => {
      for (let index = 0; index < MAX_RIPPLES; index++) {
        const ripple = rippleData.element(index);
        const rel = p.sub(ripple.xy);
        const distance = max(length(rel), 0.01);
        const front = ripple.z.mul(RIPPLE_SPEED);
        const offset = distance.sub(front);
        const across = offset.div(RIPPLE_WIDTH);
        const envelope = exp(across.mul(across).negate()).mul(ripple.w).mul(exp(ripple.z.mul(-1 / 2.5)));
        const slope = envelope.mul(RIPPLE_MAX_HEIGHT * RIPPLE_WAVENUMBER).mul(cos(offset.mul(RIPPLE_WAVENUMBER)));
        slopeX.addAssign(rel.x.div(distance).mul(slope));
        slopeZ.addAssign(rel.y.div(distance).mul(slope));
        foam.addAssign(envelope.mul(smoothstep(0.2, 0.9, sin(offset.mul(RIPPLE_WAVENUMBER)))).mul(0.35));
      }
    });
    If(trailsActive.greaterThan(0.5), () => {
      const trail = texture(trailTexture, p.add(trailOrigin).div(TRAIL_SPAN)).rg;
      const window = max(abs(p.x), abs(p.y));
      const fade = oneMinus(smoothstep(TRAIL_SPAN * 0.38, TRAIL_SPAN * 0.48, window));
      // Foam breaks up into lace; the glow sparkles in fine points (plankton lighting up).
      const world = p.add(trailOrigin);
      const lace = mx_noise_float(vec3(world.mul(0.35), flowTime.mul(0.25)));
      const sparks = mx_noise_float(vec3(world.mul(1.1), flowTime.mul(0.9)));
      foam.addAssign(trail.y.mul(saturate(lace.mul(0.8).add(0.65))).mul(fade));
      glow.addAssign(trail.x.mul(pow(saturate(sparks.mul(0.7).add(0.55)), 2).mul(1.3).add(0.15)).mul(fade));
    });
    If(regionCount.greaterThan(0.5), () => {
      const mask = float(0).toVar();
      const surf = float(0).toVar();
      for (let index = 0; index < MAX_REGIONS; index++) {
        const region = regionData.element(index);
        const distance = length(p.sub(region.xy));
        const inside = oneMinus(smoothstep(region.z.mul(0.55), region.z, distance)).mul(region.w);
        mask.addAssign(inside);
        surf.addAssign(inside.mul(regionSurf.element(index).x));
      }
      // Glowing surf: sparse flashes where the swell crests, flickering as the noise drifts.
      const sparkle = mx_noise_float(vec3(p.add(trailOrigin).mul(0.11), flowTime.mul(0.7)));
      const crest = smoothstep(0.08, 0.36, waveHeight);
      const surfGlow = crest.mul(pow(saturate(sparkle.mul(1.2).add(0.2)), 2)).mul(surf).mul(1.4);
      // Excitation (trails) glows only where the water is bioluminescent.
      glow.assign(glow.mul(saturate(mask)).add(surfGlow));
    }).Else(() => {
      glow.assign(0);
    });
    return vec4(slopeX, slopeZ, saturate(foam), glow.mul(glowVisibility));
  });

  /** Darkening (0..1) of the water deep in a vortex funnel at grid-local p. */
  const funnelDarkenFn = Fn(([p]) => {
    const darken = float(0).toVar();
    If(vortexCount.greaterThan(0.5), () => {
      for (let index = 0; index < MAX_VORTICES; index++) {
        const a = vortexA.element(index);
        const ratio = length(p.sub(a.xy)).div(max(a.w, 1));
        const inside = oneMinus(smoothstep(a.z.mul(0.5), a.z, length(p.sub(a.xy))));
        darken.addAssign(float(1).div(float(1).add(ratio.mul(ratio).mul(0.6))).mul(inside).mul(min(vortexB.element(index).x.div(20), 1)));
      }
    });
    return saturate(darken).mul(0.6);
  });

  const nodes = {
    /** Vertex stage: height offset (m) at the undisplaced grid-local xz. */
    displacement: (localXZ) => displacementFn(localXZ),
    /** Fragment stage: vec4(slope x, slope z, foam, glow) for the swell height waveHeight. */
    surface: (waveHeight) => surfaceFn(gridPosition, waveHeight),
    /** Fragment stage: 0..1 darkening inside vortex funnels. */
    darken: () => funnelDarkenFn(gridPosition),
    glowColor,
    foamColor,
  };

  // =============================================================================================
  // SPRAY DROPLETS
  // =============================================================================================
  const DROPLETS = WATER_EFFECT_LIMITS.droplets;
  const dropletOffsets = new Float32Array(DROPLETS * 3);
  const dropletShapes = new Float32Array(DROPLETS * 4);
  const dropletOffsetAttribute = new T.InstancedBufferAttribute(dropletOffsets, 3).setUsage(T.DynamicDrawUsage);
  const dropletShapeAttribute = new T.InstancedBufferAttribute(dropletShapes, 4).setUsage(T.DynamicDrawUsage);
  const dropletShape = instancedDynamicBufferAttribute(dropletShapeAttribute, 'vec4');
  const dropletMaterial = new T.PointsNodeMaterial({ transparent: true, depthWrite: false, sizeAttenuation: true });
  dropletMaterial.positionNode = instancedDynamicBufferAttribute(dropletOffsetAttribute, 'vec3');
  dropletMaterial.sizeNode = dropletShape.x;
  const dropletRadial = uv().sub(0.5).mul(2).length();
  dropletMaterial.colorNode = Fn(() => {
    // Lit by the sun and the sky by day, the dim sky at night; bioluminescent droplets glow.
    const lit = uniforms.sunColor.mul(0.75).add(uniforms.skyZenithColor.mul(0.35)).add(uniforms.skyHorizonColor.mul(0.25));
    const dim = uniforms.skyZenithColor.mul(0.3);
    const base = mix(lit, dim, uniforms.nightFactor);
    return base.add(glowColor.mul(dropletShape.z.mul(glowVisibility).mul(2.6)));
  })();
  dropletMaterial.opacityNode = Fn(() => {
    const soft = pow(saturate(oneMinus(dropletRadial)), 1.6);
    return saturate(soft.mul(dropletShape.y));
  })();
  const dropletSprite = new T.Sprite(dropletMaterial);
  dropletSprite.count = 0;
  dropletSprite.frustumCulled = false;
  dropletSprite.renderOrder = 5;
  dropletSprite.visible = false;
  dropletSprite.name = 'water-spray';
  scene.add(dropletSprite);
  ctx.registerPrewarm?.(dropletSprite);

  const dropletX = new Float64Array(DROPLETS);
  const dropletY = new Float64Array(DROPLETS);
  const dropletZ = new Float64Array(DROPLETS);
  const dropletVelocityX = new Float32Array(DROPLETS);
  const dropletVelocityY = new Float32Array(DROPLETS);
  const dropletVelocityZ = new Float32Array(DROPLETS);
  const dropletAge = new Float32Array(DROPLETS);
  const dropletLife = new Float32Array(DROPLETS);
  const dropletSize = new Float32Array(DROPLETS);
  const dropletGrowth = new Float32Array(DROPLETS);
  const dropletDrag = new Float32Array(DROPLETS);
  const dropletGravity = new Float32Array(DROPLETS);
  const dropletAlpha = new Float32Array(DROPLETS);
  const dropletGlow = new Float32Array(DROPLETS);
  const dropletSeed = new Float32Array(DROPLETS);
  let dropletCursor = 0;
  let liveDroplets = 0;
  let dropletHighWater = 0;
  let droppedDroplets = 0;
  // Spray jitter: a table filled once by a tiny deterministic generator (no Math.random: effects stay
  // replayable). Each droplet reads seven consecutive entries; the cursor is a small integer.
  const sprayNoise = new Float32Array(SPRAY_NOISE_SIZE);
  {
    let state = 0x2f6b1d3;
    for (let index = 0; index < SPRAY_NOISE_SIZE; index++) {
      state = (state + 0x6d2b79f5) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      sprayNoise[index] = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    }
  }
  const SPRAY_NOISE_MASK = SPRAY_NOISE_SIZE - 1;
  let sprayCursor = 0;

  function claimDroplet() {
    for (let attempt = 0; attempt < DROPLETS; attempt++) {
      const index = dropletCursor;
      dropletCursor = dropletCursor + 1 === DROPLETS ? 0 : dropletCursor + 1;
      if (dropletLife[index] <= 0) return index;
    }
    return -1;
  }

  /**
   * Emits spray.count droplets from a spray descriptor (createSpray): a cone around the vertical
   * (spread radians), optionally from a ring (ringRadius) with a swirl (tangential m/s), inheriting a
   * velocity. Returns how many were emitted (the batch is full at WATER_EFFECT_LIMITS.droplets).
   */
  function emitSpray(spray) {
    const count = Math.max(0, Math.floor(spray.count));
    let emitted = 0;
    for (let index = 0; index < count; index++) {
      const slot = claimDroplet();
      if (slot < 0) {
        droppedDroplets += count - index;
        break;
      }
      const noise = sprayCursor;
      sprayCursor = (sprayCursor + 7) & SPRAY_NOISE_MASK;
      const around = sprayNoise[noise] * TWO_PI;
      const cosAround = Math.cos(around);
      const sinAround = Math.sin(around);
      const tilt = spray.spread * Math.sqrt(sprayNoise[(noise + 1) & SPRAY_NOISE_MASK]);
      const speed = spray.speed * (0.55 + 0.45 * sprayNoise[(noise + 2) & SPRAY_NOISE_MASK]);
      const horizontal = Math.sin(tilt) * speed;
      const ring = spray.ringRadius * (0.85 + 0.3 * sprayNoise[(noise + 3) & SPRAY_NOISE_MASK]);
      dropletX[slot] = spray.x + cosAround * ring;
      dropletY[slot] = spray.y;
      dropletZ[slot] = spray.z + sinAround * ring;
      dropletVelocityX[slot] = cosAround * horizontal - sinAround * spray.swirl + spray.inheritX;
      dropletVelocityY[slot] = Math.cos(tilt) * speed * spray.up + spray.inheritY;
      dropletVelocityZ[slot] = sinAround * horizontal + cosAround * spray.swirl + spray.inheritZ;
      dropletAge[slot] = 0;
      dropletLife[slot] = spray.life * (0.7 + 0.6 * sprayNoise[(noise + 4) & SPRAY_NOISE_MASK]);
      dropletSize[slot] = spray.size * (0.7 + 0.6 * sprayNoise[(noise + 5) & SPRAY_NOISE_MASK]);
      dropletGrowth[slot] = spray.sizeGrowth;
      dropletDrag[slot] = spray.drag;
      dropletGravity[slot] = spray.gravity;
      dropletAlpha[slot] = spray.alpha;
      dropletGlow[slot] = spray.glow;
      dropletSeed[slot] = sprayNoise[(noise + 6) & SPRAY_NOISE_MASK];
      if (slot + 1 > dropletHighWater) dropletHighWater = slot + 1;
      emitted++;
    }
    liveDroplets += emitted;
    return emitted;
  }

  const dropletOrigin = new T.Vector3();

  const splatMark = { ...MARK_DEFAULTS, radius: 2.2 };

  function updateDroplets(cameraPosition) {
    const dt = frameState[STEP];
    dropletOrigin.x = Math.round(cameraPosition.x / 64) * 64;
    dropletOrigin.y = Math.round(cameraPosition.y / 64) * 64;
    dropletOrigin.z = Math.round(cameraPosition.z / 64) * 64;
    dropletSprite.position.copy(dropletOrigin);
    const windX = uniforms.windDirection.value.x * AMBIENT_WIND_SPEED * uniforms.windStrength.value;
    const windZ = uniforms.windDirection.value.y * AMBIENT_WIND_SPEED * uniforms.windStrength.value;
    let splats = 0;
    let live = 0;
    let highest = 0;
    for (let index = 0; index < dropletHighWater; index++) {
      if (dropletLife[index] <= 0) continue;
      const age = dropletAge[index] + dt;
      const life = dropletLife[index];
      if (age >= life) {
        dropletLife[index] = 0;
        dropletShapes[index * 4] = 0;
        dropletShapes[index * 4 + 1] = 0;
        continue;
      }
      dropletAge[index] = age;
      const drag = dropletDrag[index];
      dropletVelocityX[index] += (windX - dropletVelocityX[index]) * drag * dt;
      dropletVelocityY[index] += (-GRAVITY * dropletGravity[index] - dropletVelocityY[index] * drag) * dt;
      dropletVelocityZ[index] += (windZ - dropletVelocityZ[index]) * drag * dt;
      dropletX[index] += dropletVelocityX[index] * dt;
      dropletY[index] += dropletVelocityY[index] * dt;
      dropletZ[index] += dropletVelocityZ[index] * dt;
      if (dropletY[index] < waterLevel && dropletVelocityY[index] < 0 && dropletGravity[index] > 0.3) {
        // Back on the water: a glowing droplet leaves a small splat.
        if (dropletGlow[index] > 0.05 && splats < DROPLET_SPLATS_PER_FRAME) {
          splatMark.x = dropletX[index];
          splatMark.z = dropletZ[index];
          splatMark.glow = dropletGlow[index] * 0.55;
          writeCapsule(splatMark, false);
          splats++;
        }
        dropletLife[index] = 0;
        dropletShapes[index * 4] = 0;
        dropletShapes[index * 4 + 1] = 0;
        continue;
      }
      const lifeShare = age / life;
      // Fade: a smoothstep in over the first 8 % of the life and out over its last 45 %.
      const rise = Math.min(lifeShare / 0.08, 1);
      const fall = Math.min(Math.max((lifeShare - 0.55) / 0.45, 0), 1);
      const fade = rise * rise * (3 - 2 * rise) * (1 - fall * fall * (3 - 2 * fall));
      const offset = index * 3;
      dropletOffsets[offset] = dropletX[index] - dropletOrigin.x;
      dropletOffsets[offset + 1] = dropletY[index] - dropletOrigin.y;
      dropletOffsets[offset + 2] = dropletZ[index] - dropletOrigin.z;
      const shape = index * 4;
      dropletShapes[shape] = dropletSize[index] * (1 + dropletGrowth[index] * age);
      dropletShapes[shape + 1] = dropletAlpha[index] * fade;
      dropletShapes[shape + 2] = dropletGlow[index];
      dropletShapes[shape + 3] = dropletSeed[index];
      live++;
      highest = index + 1;
    }
    liveDroplets = live;
    dropletHighWater = highest;
    dropletSprite.count = highest;
    dropletSprite.visible = highest > 0;
    if (highest > 0) {
      dropletOffsetAttribute.needsUpdate = true;
      dropletShapeAttribute.needsUpdate = true;
    }
  }

  // =============================================================================================
  // POOLS (local water discs above sea level)
  // =============================================================================================
  const MAX_POOLS = WATER_EFFECT_LIMITS.pools;
  const poolGeometry = new T.CircleGeometry(1, 48, 0, TWO_PI);
  poolGeometry.rotateX(-Math.PI / 2);
  const poolData = new Float32Array(MAX_POOLS * 4);
  const poolDataAttribute = new T.InstancedBufferAttribute(poolData, 4).setUsage(T.DynamicDrawUsage);
  poolGeometry.setAttribute('poolData', poolDataAttribute);
  const poolInstance = instancedDynamicBufferAttribute(poolDataAttribute, 'vec4');
  const poolMaterial = new T.MeshStandardNodeMaterial({ roughness: 0.18, metalness: 0 });
  {
    const local = positionGeometry.xz;
    const radial = length(local);
    const time = uniforms.time;
    // Churn: boils at the fall point spreading outward in rings, broken up by moving noise.
    const boil = mx_noise_float(vec3(local.mul(5.5), time.mul(0.9).add(poolInstance.z.mul(17))));
    const rings = sin(radial.mul(22).sub(time.mul(5))).mul(0.5).add(0.5);
    const churn = saturate(boil.mul(0.9).add(0.35).add(rings.mul(0.25))).mul(oneMinus(smoothstep(0.15, 0.95, radial))).mul(poolInstance.x);
    const edgeFoam = smoothstep(0.86, 1.0, radial).mul(saturate(boil.add(0.6))).mul(0.5);
    const poolFoam = saturate(churn.add(edgeFoam));
    const viewDirection = normalize(positionView.negate());
    const normalView = cameraViewMatrix.transformDirection(vec3(0, 1, 0));
    const fresnel = float(0.02).add(pow(oneMinus(saturate(dot(normalView, viewDirection))), 5).mul(0.98));
    const reflectedWorld = reflect(viewDirection.negate(), normalView).transformDirection(cameraViewMatrix);
    const skyColorNode = ctx.systems.sky?.skyColorNode;
    const reflectedSky = typeof skyColorNode === 'function'
      ? skyColorNode(normalize(vec3(reflectedWorld.x, max(reflectedWorld.y, 0.02), reflectedWorld.z))).mul(0.75)
      : mix(uniforms.skyHorizonColor, uniforms.skyZenithColor, saturate(reflectedWorld.y));
    const body = color(0x1d4f58);
    poolMaterial.colorNode = mix(body.mul(oneMinus(fresnel)), foamColor.mul(0.82), poolFoam);
    poolMaterial.emissiveNode = reflectedSky.mul(fresnel).mul(oneMinus(poolFoam))
      .add(glowColor.mul(poolFoam.mul(poolInstance.y).mul(glowVisibility).mul(2.2)));
  }
  const pools = createInstancedPool(T, { geometry: poolGeometry, material: poolMaterial, capacity: MAX_POOLS, name: 'water-pools', parent: scene });
  pools.mesh.receiveShadow = true;
  ctx.registerPrewarm?.(pools.mesh);
  const poolState = Array.from({ length: MAX_POOLS }, () => ({ ...POOL_DEFAULTS, slot: -1 }));
  const poolOrigin = new T.Vector3();
  const poolMatrix = new T.Matrix4();

  function writePools(cameraPosition) {
    if (pools.used === 0) return;
    poolOrigin.x = Math.round(cameraPosition.x / 64) * 64;
    poolOrigin.z = Math.round(cameraPosition.z / 64) * 64;
    pools.mesh.position.copy(poolOrigin);
    for (let slot = 0; slot < MAX_POOLS; slot++) {
      const pool = poolState[slot];
      if (pool.slot < 0) continue;
      // A scale and a translation, written in place (the rest stays identity).
      poolMatrix.elements[0] = pool.radius;
      poolMatrix.elements[10] = pool.radius;
      poolMatrix.elements[12] = pool.x - poolOrigin.x;
      poolMatrix.elements[13] = pool.y;
      poolMatrix.elements[14] = pool.z - poolOrigin.z;
      pools.setMatrix(slot, poolMatrix);
      poolData[slot * 4] = pool.churn;
      poolData[slot * 4 + 1] = pool.glow;
      poolData[slot * 4 + 2] = slot * 0.37;
      poolData[slot * 4 + 3] = pool.radius;
    }
    poolDataAttribute.needsUpdate = true;
    pools.flush();
  }

  // =============================================================================================
  // CRAFT CONTACT
  // =============================================================================================
  // The craft's height and last position live in a typed array (stored every frame without boxing);
  // the contact object reads them through accessors.
  const contactState = new Float64Array([Infinity, 0, 0]);
  const CONTACT_HEIGHT_SLOT = 0;
  const CONTACT_LAST_X = 1;
  const CONTACT_LAST_Z = 2;
  const contact = {
    touching: false,
    stirring: false,
    hasLast: false,
    contacts: 0,
    get height() { return contactState[CONTACT_HEIGHT_SLOT]; },
    get lastX() { return contactState[CONTACT_LAST_X]; },
    get lastZ() { return contactState[CONTACT_LAST_Z]; },
  };
  const contactMark = { ...MARK_DEFAULTS, radius: CONTACT_RADIUS };

  /** Writes the craft's trail when it touches (or low-flies over) open water. */
  function updateCraftContact() {
    const craft = state.flight?.position;
    if (!craft || !Number.isFinite(craft.x) || !Number.isFinite(craft.y) || !Number.isFinite(craft.z)) return;
    contact.touching = false;
    contact.stirring = false;
    // Funnels only lower the surface: high above the sea the funnels need not be sampled at all.
    const aboveSea = craft.y - waterLevel;
    const height = aboveSea > DOWNWASH_HEIGHT ? aboveSea : craft.y - surfaceHeightAt(craft.x, craft.z);
    contactState[CONTACT_HEIGHT_SLOT] = height;
    if (height > DOWNWASH_HEIGHT) {
      contact.hasLast = false;
      return;
    }
    // Only open water: one terrain sample per frame, and only while this low.
    if (world.heightAt(craft.x, craft.z) > waterLevel - 0.5) {
      contact.hasLast = false;
      return;
    }
    contactMark.x = contact.hasLast ? contactState[CONTACT_LAST_X] : craft.x;
    contactMark.z = contact.hasLast ? contactState[CONTACT_LAST_Z] : craft.z;
    contactMark.x1 = craft.x;
    contactMark.z1 = craft.z;
    if (height < CONTACT_HEIGHT) {
      contact.touching = true;
      contact.contacts++;
      contactMark.radius = CONTACT_RADIUS;
      contactMark.foam = 0.55;
      contactMark.glow = 1;
    } else {
      contact.stirring = true;
      const share = 1 - (height - CONTACT_HEIGHT) / (DOWNWASH_HEIGHT - CONTACT_HEIGHT);
      contactMark.radius = CONTACT_RADIUS * (1.4 + share);
      contactMark.foam = 0;
      contactMark.glow = 0.55 * share;
    }
    writeCapsule(contactMark, true);
    contactState[CONTACT_LAST_X] = craft.x;
    contactState[CONTACT_LAST_Z] = craft.z;
    contact.hasLast = true;
  }

  // =============================================================================================
  // CPU QUERIES AND UNIFORM UPLOAD
  // =============================================================================================
  /**
   * The water surface height (m) at (x, z): sea level plus every vortex funnel (swell excluded). Each
   * funnel is the normalised Rankine pressure dip, 1 at the eye's centre and 0 at its radius, as in
   * the shader. Away from every funnel it returns sea level itself (an integer: nothing is boxed).
   */
  function surfaceHeightAt(x, z) {
    let dip = 0;
    for (let slot = 0; slot < MAX_VORTICES; slot++) {
      const vortex = vortexState[slot];
      if (!vortex.used || vortex.weight <= 0) continue;
      const offsetX = x - vortex.x;
      const offsetZ = z - vortex.z;
      const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ);
      if (distance >= vortex.radius) continue;
      const eyeRadius = Math.max(vortex.eyeRadius, 1);
      const reach = vortex.radius / eyeRadius;
      const edge = 1 / (1 + reach * reach);
      const ratio = distance / eyeRadius;
      dip += ((1 / (1 + ratio * ratio) - edge) / (1 - edge)) * vortex.depth * vortex.weight;
    }
    if (dip === 0) return waterLevel;
    return waterLevel - dip;
  }

  // The grid anchor and the last flight-clock reading (doubles in a typed array: no boxing).
  const frameState = new Float64Array(5);
  const ANCHOR_X = 0;
  const ANCHOR_Z = 1;
  const LAST_ELAPSED = 2;
  /** This frame's flight-clock step (s, at most 0.1). */
  const STEP = 3;
  const ELAPSED = 4;

  /** Uploads the vortices, ripples, glow regions and clocks (vector fields written in place). */
  function uploadUniforms() {
    const elapsed = frameState[ELAPSED];
    const anchorX = frameState[ANCHOR_X];
    const anchorZ = frameState[ANCHOR_Z];
    let vortices = 0;
    for (let slot = 0; slot < MAX_VORTICES; slot++) {
      const vortex = vortexState[slot];
      const a = vortexA.array[slot];
      const b = vortexB.array[slot];
      const c = vortexC.array[slot];
      if (!vortex.used || vortex.weight <= 0) {
        a.x = 1e6; a.y = 1e6; a.z = 1; a.w = 1;
        b.x = 0; b.y = 0; b.z = 0; b.w = 0;
        c.x = 0; c.y = 1; c.z = 0; c.w = 0;
        continue;
      }
      vortices++;
      const weight = vortex.weight;
      a.x = vortex.x - anchorX; a.y = vortex.z - anchorZ; a.z = vortex.radius; a.w = vortex.eyeRadius;
      b.x = vortex.depth * weight; b.y = vortex.ridge * weight; b.z = vortex.arms; b.w = vortex.twist;
      c.x = vortex.pattern; c.y = vortex.direction; c.z = vortex.foam * weight; c.w = vortex.spin;
    }
    vortexCount.value = vortices;
    let ripples = 0;
    for (let index = 0; index < MAX_RIPPLES; index++) {
      const ripple = rippleData.array[index];
      if (rippleAge[index] >= RIPPLE_LIFE_SECONDS || rippleStrength[index] <= 0) {
        ripple.x = 1e6; ripple.y = 1e6; ripple.z = RIPPLE_LIFE_SECONDS; ripple.w = 0;
        continue;
      }
      ripples++;
      ripple.x = rippleX[index] - anchorX; ripple.y = rippleZ[index] - anchorZ; ripple.z = rippleAge[index]; ripple.w = rippleStrength[index];
    }
    rippleCount.value = ripples;
    let regions = 0;
    for (let slot = 0; slot < MAX_REGIONS; slot++) {
      const region = regionState[slot];
      const data = regionData.array[slot];
      const surf = regionSurf.array[slot];
      if (!region.used || region.strength <= 0) {
        data.x = 1e6; data.y = 1e6; data.z = 1; data.w = 0;
        surf.x = 0;
        continue;
      }
      regions++;
      data.x = region.x - anchorX; data.y = region.z - anchorZ; data.z = region.radius; data.w = region.strength;
      surf.x = region.surf;
    }
    regionCount.value = regions;
    trailOrigin.value.x = ((anchorX % TRAIL_SPAN) + TRAIL_SPAN) % TRAIL_SPAN;
    trailOrigin.value.y = ((anchorZ % TRAIL_SPAN) + TRAIL_SPAN) % TRAIL_SPAN;
    effectClock.value.x = elapsed % 3600;
    effectClock.value.y = 0.12 + 0.88 * state.time.nightFactor;
  }

  frameState[LAST_ELAPSED] = state.time.elapsed;

  /**
   * Every frame, after the ocean grid followed the camera: gridAnchor = the grid's snapped centre (a
   * Vector3). Advances the vortex patterns, ripples, droplets, craft contact and the trail buffer on
   * the flight clock (a paused game freezes them).
   */
  function update(dt, realDt, gridAnchor, cameraPosition) {
    frameState[ANCHOR_X] = gridAnchor.x;
    frameState[ANCHOR_Z] = gridAnchor.z;
    const elapsed = state.time.elapsed;
    const step = Math.max(0, Math.min(0.1, elapsed - frameState[LAST_ELAPSED]));
    frameState[LAST_ELAPSED] = elapsed;
    frameState[ELAPSED] = elapsed;
    frameState[STEP] = step;
    scrollWindow(cameraPosition);
    drainSplashes();
    for (let slot = 0; slot < MAX_VORTICES; slot++) {
      const vortex = vortexState[slot];
      if (!vortex.used) continue;
      // The arm pattern turns at a fifth of the eye's spin, wound by the arm count.
      vortex.pattern = (vortex.pattern + vortex.arms * vortex.spin * 0.2 * vortex.direction * step) % TWO_PI;
    }
    for (let index = 0; index < MAX_RIPPLES; index++) {
      if (rippleAge[index] < RIPPLE_LIFE_SECONDS) rippleAge[index] += step;
    }
    if (step > 0) {
      // High above the sea (funnels only lower the surface) the contact query is a single store here;
      // only a craft within the downwash reach runs the full query.
      const craft = state.flight?.position;
      const aboveSea = craft ? craft.y - waterLevel : Infinity;
      if (aboveSea <= DOWNWASH_HEIGHT) updateCraftContact();
      else {
        contactState[CONTACT_HEIGHT_SLOT] = aboveSea;
        contact.touching = false;
        contact.stirring = false;
        contact.hasLast = false;
      }
      decayTrails();
    }
    updateDroplets(cameraPosition);
    writePools(cameraPosition);
    if (trailDirty) {
      trailTexture.needsUpdate = true;
      trailUploads++;
      trailDirty = false;
    }
    trailsActive.value = trailActiveRows > 0 ? 1 : 0;
    uploadUniforms();
  }

  // =============================================================================================
  // SPAWN API
  // =============================================================================================
  /** A spray descriptor with defaults (build it once in create, mutate it, pass it to emitSpray). */
  function createSpray(overrides = {}) {
    return { ...SPRAY_DEFAULTS, ...overrides };
  }

  /** A vortex descriptor with defaults (see setVortex). */
  function createVortex(overrides = {}) {
    return { ...VORTEX_DEFAULTS, ...overrides };
  }

  /** A pool descriptor with defaults (see setPool). */
  function createPool(overrides = {}) {
    return { ...POOL_DEFAULTS, ...overrides };
  }

  /** Adds a mark's expanding ring wave at (x, z); strength 0..1 (1 = 0.55 m crests). */
  function pushRipple(mark) {
    const index = rippleCursor;
    rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
    rippleX[index] = mark.x;
    rippleZ[index] = mark.z;
    rippleAge[index] = 0;
    rippleStrength[index] = Math.min(Math.max(mark.strength, 0), 1);
  }

  const splashSpray = createSpray();
  const splashDisc = { ...MARK_DEFAULTS, foam: 0.95 };
  const splashRing = { ...MARK_DEFAULTS };

  // Splashes queue (four doubles each) and are drawn in the next update: a splash is a rare call that
  // V8 runs unoptimised, where every double operation allocates, so it only copies four numbers; the
  // per-frame update, which is optimised, does the arithmetic.
  const SPLASH_QUEUE = 16;
  const splashQueue = new Float64Array(SPLASH_QUEUE * 4);
  let splashQueueCount = 0;
  let splashesDropped = 0;

  /**
   * Queues a mark's splash at (x, z): a spray burst, a foam disc and ring, a ripple ring and a glow
   * splat. strength 0..1 scales all of it (1 = a whale's full breach); glow 0..1 is the excitation
   * left in the trail buffer (it only shows inside a glow region). Returns whether it was queued (up
   * to 16 per frame).
   */
  function writeSplash(mark) {
    if (splashQueueCount >= SPLASH_QUEUE) {
      splashesDropped++;
      return false;
    }
    const base = splashQueueCount * 4;
    splashQueue[base] = mark.x;
    splashQueue[base + 1] = mark.z;
    splashQueue[base + 2] = mark.strength;
    splashQueue[base + 3] = mark.glow;
    splashQueueCount++;
    return true;
  }

  /**
   * Draws the queued splashes (every frame, from update). The work sits inside this hot function's
   * loop, so it runs optimised once a few splashes have been seen.
   */
  function drainSplashes() {
    for (let queued = 0; queued < splashQueueCount; queued++) {
      const base = queued * 4;
      const x = splashQueue[base];
      const z = splashQueue[base + 1];
      const power = Math.min(Math.max(splashQueue[base + 2], 0), 1);
      const glow = splashQueue[base + 3];
      const radius = 3 + 9 * power;
      splashDisc.x = x;
      splashDisc.z = z;
      splashDisc.radius = radius;
      splashDisc.glow = glow;
      writeCapsule(splashDisc, false);
      splashRing.x = x;
      splashRing.z = z;
      splashRing.radius = radius * 1.6;
      splashRing.width = 3;
      splashRing.foam = 0.7 * power;
      splashRing.glow = glow * 0.8;
      writeRing(splashRing);
      const ripple = rippleCursor;
      rippleCursor = (rippleCursor + 1) % MAX_RIPPLES;
      rippleX[ripple] = x;
      rippleZ[ripple] = z;
      rippleAge[ripple] = 0;
      rippleStrength[ripple] = 0.35 + 0.65 * power;
      splashSpray.x = x;
      splashSpray.y = waterLevel + 0.3;
      splashSpray.z = z;
      splashSpray.count = Math.round(40 + 260 * power);
      splashSpray.speed = 6 + 14 * power;
      splashSpray.up = 1;
      splashSpray.spread = 0.75;
      splashSpray.ringRadius = radius * 0.4;
      splashSpray.swirl = 0;
      splashSpray.size = 0.9 + 1.4 * power;
      splashSpray.sizeGrowth = 0.9;
      splashSpray.life = 1.6 + 1.4 * power;
      splashSpray.drag = 0.6;
      splashSpray.gravity = 1;
      splashSpray.alpha = 0.75;
      splashSpray.glow = glow * 0.8;
      splashSpray.inheritX = 0;
      splashSpray.inheritY = 0;
      splashSpray.inheritZ = 0;
      emitSpray(splashSpray);
    }
    splashQueueCount = 0;
  }

  /** The numeric shorthands fill this mark (for one-off writes; frequent writers keep their own). */
  const shorthand = { ...MARK_DEFAULTS };

  function fillShorthand(x, z, radius, foam, glow) {
    shorthand.x = x;
    shorthand.z = z;
    shorthand.radius = radius;
    shorthand.foam = foam;
    shorthand.glow = glow;
    return shorthand;
  }

  const api = {
    nodes,
    update,
    /** A mark descriptor with defaults (build it once in create, mutate it, pass it to the mark calls). */
    createMark(overrides = {}) {
      return { ...MARK_DEFAULTS, ...overrides };
    },
    /** White foam and bioluminescent excitation (0..1 each) in a disc: mark.x, z, radius, foam, glow. */
    disturb(mark) {
      return writeCapsule(mark, false);
    },
    /** The same along a segment (a wake): from (mark.x, mark.z) to (mark.x1, mark.z1). */
    trail(mark) {
      return writeCapsule(mark, true);
    },
    /** A foam ring: mark.x, z, radius, width, foam, glow. */
    foamRing(mark) {
      return writeRing(mark);
    },
    /** An expanding ring wave: mark.x, z, strength. */
    ripple(mark) {
      pushRipple(mark);
    },
    /** A full splash: mark.x, z, strength, glow, drawn in the next update. Returns whether it was queued. */
    splashMark(mark) {
      return writeSplash(mark);
    },
    /** Shorthand of disturb: a disc of radius metres at (x, z). */
    addWaterDisturbance(x, z, radius, foam, glow) {
      return writeCapsule(fillShorthand(x, z, radius, foam, glow), false);
    },
    /** Shorthand of trail: from (x0, z0) to (x1, z1). */
    addWaterTrail(x0, z0, x1, z1, radius, foam, glow) {
      const mark = fillShorthand(x0, z0, radius, foam, glow);
      mark.x1 = x1;
      mark.z1 = z1;
      return writeCapsule(mark, true);
    },
    /** Shorthand of foamRing: a ring of radius and width metres at (x, z). */
    addFoamRing(x, z, radius, width, foam, glow) {
      const mark = fillShorthand(x, z, radius, foam, glow);
      mark.width = width;
      return writeRing(mark);
    },
    /** Shorthand of ripple. */
    addRipple(x, z, strength) {
      const mark = fillShorthand(x, z, 0, 0, 0);
      mark.strength = strength;
      pushRipple(mark);
    },
    /** Shorthand of splashMark: strength 0..1, glow 0..1 (default 1). */
    splash(x, z, strength, glow = 1) {
      const mark = fillShorthand(x, z, 0, 0, glow);
      mark.strength = strength;
      return writeSplash(mark);
    },
    createSpray,
    emitSpray,
    createVortex,
    /** Takes a vortex slot (or -1 when all WATER_EFFECT_LIMITS.vortices are in use). */
    acquireVortex() {
      const slot = vortexSlots.alloc();
      if (slot >= 0) {
        Object.assign(vortexState[slot], VORTEX_DEFAULTS);
        vortexState[slot].pattern = 0;
        vortexState[slot].used = true;
      }
      return slot;
    },
    /**
     * Copies a vortex descriptor (createVortex) into the slot: x, z (m), radius, eyeRadius, depth (m),
     * spin (rad/s at the eye), arms, twist, ridge (m), foam 0..1, direction (1 counter-clockwise seen
     * from above, -1 clockwise), weight 0..1 (fades the whole vortex).
     */
    setVortex(slot, vortex) {
      const target = vortexState[slot];
      if (!target || !target.used) return false;
      target.x = vortex.x;
      target.z = vortex.z;
      target.radius = Math.max(vortex.radius, 1);
      target.eyeRadius = Math.min(Math.max(vortex.eyeRadius, 1), target.radius * 0.9);
      target.depth = Math.max(vortex.depth, 0);
      target.spin = vortex.spin;
      target.arms = Math.max(1, Math.round(vortex.arms));
      target.twist = vortex.twist;
      target.ridge = vortex.ridge;
      target.foam = Math.min(Math.max(vortex.foam, 0), 1);
      target.direction = vortex.direction < 0 ? -1 : 1;
      target.weight = Math.min(Math.max(vortex.weight, 0), 1);
      return true;
    },
    releaseVortex(slot) {
      if (!vortexSlots.free(slot)) return false;
      vortexState[slot].used = false;
      return true;
    },
    /** Takes a glow region slot (or -1). */
    acquireGlowRegion() {
      const slot = regionSlots.alloc();
      if (slot >= 0) {
        const region = regionState[slot];
        region.used = true;
        region.strength = 0;
      }
      return slot;
    },
    /** A glow region descriptor with defaults (see setGlowRegion). */
    createGlowRegion(overrides = {}) {
      return { ...GLOW_REGION_DEFAULTS, ...overrides };
    },
    /**
     * Copies a glow region descriptor (createGlowRegion) into the slot: bioluminescent water in a disc
     * at x, z of radius (m); strength 0..1.5 (how brightly excitation glows); surf 0..1.5 (how brightly
     * the swell crests glow on their own); color 0xRRGGBB (the layer's one glow colour: the most
     * recently set region's).
     */
    setGlowRegion(slot, descriptor) {
      const region = regionState[slot];
      if (!region || !region.used) return false;
      region.x = descriptor.x;
      region.z = descriptor.z;
      region.radius = Math.max(descriptor.radius, 1);
      region.strength = Math.min(Math.max(descriptor.strength, 0), 1.5);
      region.surf = Math.min(Math.max(descriptor.surf, 0), 1.5);
      if (Number.isInteger(descriptor.color) && descriptor.color !== glowColorHex) {
        glowColorHex = descriptor.color;
        glowColor.value.setHex(glowColorHex);
      }
      return true;
    },
    releaseGlowRegion(slot) {
      if (!regionSlots.free(slot)) return false;
      regionState[slot].used = false;
      return true;
    },
    createPool,
    /** Takes a pool disc slot (or -1). */
    acquirePool() {
      const slot = pools.alloc();
      if (slot >= 0) Object.assign(poolState[slot], POOL_DEFAULTS, { slot });
      return slot;
    },
    /** Copies a pool descriptor (createPool: x, y, z, radius, churn 0..1, glow 0..1) into the slot. */
    setPool(slot, pool) {
      const target = poolState[slot];
      if (!target || target.slot < 0) return false;
      target.x = pool.x;
      target.y = pool.y;
      target.z = pool.z;
      target.radius = Math.max(pool.radius, 1);
      target.churn = Math.min(Math.max(pool.churn, 0), 1);
      target.glow = Math.min(Math.max(pool.glow, 0), 1);
      return true;
    },
    releasePool(slot) {
      const target = poolState[slot];
      if (!target || target.slot < 0) return false;
      target.slot = -1;
      pools.free(slot);
      pools.flush();
      return true;
    },
    surfaceHeightAt,
    /** How many whirlpool vortices are live (while 0 the surface is sea level everywhere). */
    get activeVortices() {
      return vortexSlots.used;
    },
    /**
     * The craft's height above the water surface (m) at the last frame (above sea level while it is
     * higher than the downwash reach), and whether it touched or stirred the water.
     */
    get craftContact() {
      return contact;
    },
    stats() {
      let vortices = 0;
      for (const vortex of vortexState) if (vortex.used) vortices++;
      let regions = 0;
      for (const region of regionState) if (region.used) regions++;
      let ripples = 0;
      for (let index = 0; index < MAX_RIPPLES; index++) if (rippleAge[index] < RIPPLE_LIFE_SECONDS && rippleStrength[index] > 0) ripples++;
      return {
        vortices,
        ripples,
        glowRegions: regions,
        pools: pools.used,
        droplets: liveDroplets,
        dropletsDropped: droppedDroplets,
        splashesDropped,
        trailRows: trailActiveRows,
        trailUploads,
        craftContacts: contact.contacts,
        craftHeight: Number.isFinite(contact.height) ? Math.round(contact.height * 10) / 10 : null,
      };
    },
    dispose() {
      dropletSprite.removeFromParent();
      dropletMaterial.dispose();
      pools.dispose();
      trailTexture.dispose();
    },
  };
  return api;
}
