// The shared water-height query: the ocean's waves plus every local water body (contract section c.2).
//
// One water model for everything that touches water: the flight models and the flight controller
// (contact, floats, the water soft crash), spray and bioluminescence, the cameras, the copilot, the
// test harness and the renderer. The ocean's swell is the SAME wave table the ocean shader draws
// (createOceanWaves, quantised to the 4096 m wave tile for the world's prevailing wind) with the SAME
// swell scale (oceanSwellScale, a pure function of the flight clock), so a craft floating on a crest
// sits where the crest is drawn. Local water bodies (waters.js) come from placement through worldgen:
// flat surfaces at their own levels, clipped to their basins.
//
// Everything is a pure function of (seed, presets, x, z, t), plus the whirlpool funnels, which come
// from deterministic spawns through the water effects layer (attachEffects). Queries allocate nothing;
// a direct-mapped cache of the terrain lattice heights keeps the ocean test (is the ground below sea
// level?) cheap for queries near each other, and only ever saves work: its answers are bit-identical
// to worldgen.groundHeight.
//
// Pure JS (no three.js, no DOM): the node labs run it as the game does.
import { waterOutlineContains } from './waters.js';

/** The wave tile (m): every wave vector has a whole number of cycles over it (wrapped coordinates stay seamless). */
export const WAVE_TILE = 4096;
const GRAVITY = 9.81;
const WAVE_SPEED_SCALE = 0.9;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * The ocean's wave set before quantisation (angles in degrees relative to the prevailing wind). The
 * swell displaces the surface (Gerstner: amplitude in m, steepness the horizontal share); the detail
 * waves only shape the shader's per-pixel normal (slope = wave number x amplitude).
 */
export const OCEAN_WAVES = Object.freeze({
  swell: Object.freeze([
    Object.freeze({ angle: 0, wavelength: 84, amplitude: 0.26, steepness: 1.6 }),
    Object.freeze({ angle: -31, wavelength: 51, amplitude: 0.19, steepness: 1.8 }),
    Object.freeze({ angle: 27, wavelength: 33, amplitude: 0.13, steepness: 2.0 }),
    Object.freeze({ angle: -9, wavelength: 21, amplitude: 0.08, steepness: 2.2 }),
  ]),
  detail: Object.freeze([
    Object.freeze({ angle: 22, wavelength: 14.3, slope: 0.06 }),
    Object.freeze({ angle: -31, wavelength: 10.4, slope: 0.066 }),
    Object.freeze({ angle: 6, wavelength: 7.6, slope: 0.072 }),
    Object.freeze({ angle: -12, wavelength: 5.7, slope: 0.072 }),
    Object.freeze({ angle: 47, wavelength: 4.4, slope: 0.066 }),
    Object.freeze({ angle: -58, wavelength: 3.5, slope: 0.062 }),
    Object.freeze({ angle: 104, wavelength: 2.8, slope: 0.048 }),
    Object.freeze({ angle: -117, wavelength: 2.2, slope: 0.044 }),
    Object.freeze({ angle: 31, wavelength: 1.7, slope: 0.04 }),
  ]),
});

/** One wave quantised to whole cycles over the wave tile, for the wind angle (radians). */
function quantiseWave(windAngle, angleDegrees, wavelength) {
  const angle = windAngle + angleDegrees * DEG;
  const cyclesX = Math.round((WAVE_TILE * Math.cos(angle)) / wavelength);
  const cyclesZ = Math.round((WAVE_TILE * Math.sin(angle)) / wavelength);
  const frequencyX = cyclesX / WAVE_TILE;
  const frequencyZ = cyclesZ / WAVE_TILE;
  const frequency = Math.hypot(frequencyX, frequencyZ);
  const waveNumber = TWO_PI * frequency;
  return {
    frequencyX,
    frequencyZ,
    directionX: frequencyX / frequency,
    directionZ: frequencyZ / frequency,
    waveNumber,
    wavelength: 1 / frequency,
    angularSpeed: Math.sqrt(GRAVITY * waveNumber) * WAVE_SPEED_SCALE,
  };
}

/**
 * The quantised ocean wave table for a world whose prevailing wind blows toward (windX, windZ) (the
 * windDirection uniform). Returns a frozen { windAngle, swell: [...], detail: [...] }; each wave has
 * frequencyX/Z (cycles per metre), directionX/Z, waveNumber, wavelength, angularSpeed (rad/s),
 * amplitude (m), steepness (swell) and phaseSeed (cycles). The ocean material (waterMaterial.js) and
 * the query share it.
 */
export function createOceanWaves(windX, windZ) {
  const windAngle = Math.atan2(windZ, windX);
  const swell = OCEAN_WAVES.swell.map((spec, index) => Object.freeze({
    ...quantiseWave(windAngle, spec.angle, spec.wavelength),
    amplitude: spec.amplitude,
    steepness: spec.steepness,
    phaseSeed: (index * 0.618034) % 1,
  }));
  const detail = OCEAN_WAVES.detail.map((spec, index) => {
    const wave = quantiseWave(windAngle, spec.angle, spec.wavelength);
    return Object.freeze({
      ...wave,
      amplitude: spec.slope / wave.waveNumber,
      steepness: 0,
      slope: spec.slope,
      phaseSeed: ((index + OCEAN_WAVES.swell.length) * 0.618034) % 1,
    });
  });
  return Object.freeze({ windAngle, swell: Object.freeze(swell), detail: Object.freeze(detail) });
}

/**
 * The ambient wind strength (1 = the prevailing wind's mean) at flight time t (s): the slow swing the
 * WindField's ambient wind and the clouds' drift follow (the windStrength uniform, written from the
 * same formula by src/render/clouds.js).
 */
export function ambientWindStrength(t) {
  return 1 + 0.1 * Math.sin(t * 0.011) + 0.05 * Math.sin(t * 0.037 + 1.7);
}

/** The ocean swell scale at flight time t: the shader and the physics read this one function. */
export function oceanSwellScale(t) {
  const scale = 0.75 + 0.35 * ambientWindStrength(t);
  return scale < 0.7 ? 0.7 : scale > 1.2 ? 1.2 : scale;
}

// The surface parameter found by inverting the swell's horizontal displacement (see swellParameter),
// and the swell height (oceanHeightInto): doubles kept in a typed array, never returned.
const parameter = new Float64Array(3);

/**
 * The undisplaced surface parameter whose displaced position is (x, z): the Gerstner swell moves
 * each surface point sideways (up to about a metre), so the crest drawn above (x, z) belongs to a
 * nearby parameter. Two fixed-point steps (the swell's horizontal Jacobian is about 0.18, so the
 * error shrinks to a few centimetres). Writes the parameter into `parameter`.
 */
function swellParameter(x, z, t, swellScale, waves) {
  let px = x;
  let pz = z;
  for (let iteration = 0; iteration < 2; iteration++) {
    let shiftX = 0;
    let shiftZ = 0;
    for (let index = 0; index < waves.swell.length; index++) {
      const wave = waves.swell[index];
      const theta = TWO_PI * (px * wave.frequencyX + pz * wave.frequencyZ - (wave.angularSpeed * t) / TWO_PI - wave.phaseSeed);
      const horizontal = Math.cos(theta) * wave.amplitude * swellScale * wave.steepness;
      shiftX += horizontal * wave.directionX;
      shiftZ += horizontal * wave.directionZ;
    }
    px = x - shiftX;
    pz = z - shiftZ;
  }
  parameter[0] = px;
  parameter[1] = pz;
}

/**
 * The ocean swell's height (m above mean sea level) at world (x, z) and flight time t: the pure
 * Gerstner sum of the swell waves of `waves` (createOceanWaves) at swell scale swellScale, the same
 * waves the ocean shader displaces its vertices by.
 */
export function oceanHeight(x, z, t, swellScale, waves) {
  oceanHeightInto(x, z, t, swellScale, waves);
  return parameter[2];
}

/** oceanHeight written into parameter[2] (the query's hot path returns no double, so boxes none). */
function oceanHeightInto(x, z, t, swellScale, waves) {
  swellParameter(x, z, t, swellScale, waves);
  let height = 0;
  for (let index = 0; index < waves.swell.length; index++) {
    const wave = waves.swell[index];
    const theta = TWO_PI * (parameter[0] * wave.frequencyX + parameter[1] * wave.frequencyZ - (wave.angularSpeed * t) / TWO_PI - wave.phaseSeed);
    height += Math.sin(theta) * wave.amplitude * swellScale;
  }
  parameter[2] = height;
}

/**
 * The swell at (x, z, t) into out: height (m above mean sea level), the surface normal (normalX/Y/Z,
 * unit) and the orbital velocity of the surface there (velocityX/Y/Z, m/s).
 */
export function oceanSample(x, z, t, swellScale, waves, out) {
  swellParameter(x, z, t, swellScale, waves);
  let height = 0;
  let slopeX = 0;
  let slopeZ = 0;
  let crestLift = 0;
  let velocityX = 0;
  let velocityY = 0;
  let velocityZ = 0;
  for (let index = 0; index < waves.swell.length; index++) {
    const wave = waves.swell[index];
    const theta = TWO_PI * (parameter[0] * wave.frequencyX + parameter[1] * wave.frequencyZ - (wave.angularSpeed * t) / TWO_PI - wave.phaseSeed);
    const sine = Math.sin(theta);
    const cosine = Math.cos(theta);
    const amplitude = wave.amplitude * swellScale;
    height += sine * amplitude;
    const slope = cosine * amplitude * wave.waveNumber;
    slopeX += slope * wave.directionX;
    slopeZ += slope * wave.directionZ;
    crestLift += sine * amplitude * wave.waveNumber * wave.steepness;
    // d(theta)/dt = -angularSpeed: the vertical and horizontal displacements' time derivatives.
    velocityY -= amplitude * wave.angularSpeed * cosine;
    const horizontal = amplitude * wave.steepness * wave.angularSpeed * sine;
    velocityX += horizontal * wave.directionX;
    velocityZ += horizontal * wave.directionZ;
  }
  const normalY = 1 - crestLift;
  const length = Math.sqrt(slopeX * slopeX + normalY * normalY + slopeZ * slopeZ);
  out.height = height;
  out.normalX = -slopeX / length;
  out.normalY = normalY / length;
  out.normalZ = -slopeZ / length;
  out.velocityX = velocityX;
  out.velocityY = velocityY;
  out.velocityZ = velocityZ;
  return out;
}

/** A sample object for waterQuery.sample (build it once, reuse it). */
export function createWaterSample() {
  return {
    height: -Infinity, normalX: 0, normalY: 1, normalZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0,
    kind: 'none', bodyId: null, body: null, material: 'water', depth: 0, film: false,
  };
}

/** Entries of the terrain lattice cache: a 64 x 64 window of the LOD0 lattice (256 m at 4 m). */
const LATTICE_WINDOW = 64;

/**
 * Creates the water query for one world.
 *   world          worldgen (heightAt, GRID_STEP, WATER_LEVEL, watersAt, waterBodiesNear)
 *   effects        the water effects layer (whirlpool funnels), or null; attachEffects sets it later
 *   windDirection  the prevailing downwind direction { x, y } (the windDirection uniform: x east, y
 *                  south), which quantises the wave table
 *   clock          { elapsed }: the flight clock (state.time), the default time of every query
 * The game's instance is ctx.waterQuery (main.js).
 */
export function createWaterQuery({ world, effects = null, windDirection, clock = { elapsed: 0 } }) {
  const waves = createOceanWaves(windDirection.x, windDirection.y);
  const seaLevel = world.WATER_LEVEL;
  const gridStep = world.GRID_STEP;
  const heightAtLattice = world.heightAt;
  let waterEffects = effects;
  const latticeKeys = new Float64Array(LATTICE_WINDOW * LATTICE_WINDOW).fill(NaN);
  const latticeHeights = new Float64Array(LATTICE_WINDOW * LATTICE_WINDOW);
  // Doubles written per query live in a typed array (no boxing): the ground and the funnel dip.
  const scratch = new Float64Array(3);
  const GROUND = 0;
  const DIP = 1;
  const SWELL = 2;
  const swellScratch = { height: 0, normalX: 0, normalY: 1, normalZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0 };
  const counters = { queries: 0, samples: 0, latticeMisses: 0 };

  /**
   * The cache slot of LOD0 lattice point (i, j), holding worldgen's heightAt there (latticeHeights;
   * filled on a miss). Slots are small integers, so nothing is boxed.
   */
  function latticeSlot(i, j) {
    const key = i * 1048576 + j;
    const slot = ((i & (LATTICE_WINDOW - 1)) << 6) | (j & (LATTICE_WINDOW - 1));
    if (latticeKeys[slot] !== key) {
      counters.latticeMisses++;
      latticeHeights[slot] = heightAtLattice(i * gridStep, j * gridStep);
      latticeKeys[slot] = key;
    }
    return slot;
  }

  /**
   * worldgen.groundHeight (the collision surface) through the lattice cache, with the same two
   * triangles and the same arithmetic (bit-identical), written into scratch[GROUND].
   */
  function groundInto(x, z) {
    const gx = x / gridStep;
    const gz = z / gridStep;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const slot10 = latticeSlot(i + 1, j);
    const slot01 = latticeSlot(i, j + 1);
    if (fx + fz <= 1) {
      const h00 = latticeHeights[latticeSlot(i, j)];
      scratch[GROUND] = h00 + (latticeHeights[slot10] - h00) * fx + (latticeHeights[slot01] - h00) * fz;
      return;
    }
    const h11 = latticeHeights[latticeSlot(i + 1, j + 1)];
    scratch[GROUND] = h11 + (latticeHeights[slot01] - h11) * (1 - fx) + (latticeHeights[slot10] - h11) * (1 - fz);
  }

  /** worldgen.groundHeight through the lattice cache (callers outside the hot path). */
  function groundAt(x, z) {
    groundInto(x, z);
    return scratch[GROUND];
  }

  /** Measures the ground at (x, z) once per query into scratch[GROUND] (NaN until then). */
  function measureGround(x, z) {
    if (scratch[GROUND] !== scratch[GROUND]) groundInto(x, z);
  }

  /** The highest local body whose surface covers (x, z) at its static level, or null. */
  function lakeAt(x, z) {
    const list = world.watersAt(x, z);
    let best = null;
    for (let index = 0; index < list.length; index++) {
      const record = list[index];
      if (best !== null && record.level <= best.level) continue;
      const bounds = record.bounds;
      if (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ) continue;
      if (!waterOutlineContains(record, x, z)) continue;
      measureGround(x, z);
      if (scratch[GROUND] < record.level) best = record;
    }
    return best;
  }

  /** The whirlpool funnels' dip (m, >= 0) at (x, z), into scratch[DIP]. */
  function funnelDipInto(x, z) {
    scratch[DIP] = waterEffects === null || !(waterEffects.activeVortices > 0) ? 0 : seaLevel - waterEffects.surfaceHeightAt(x, z);
  }

  /** The swell scale at flight time t (oceanSwellScale, written out), into scratch[SWELL]. */
  function swellInto(t) {
    const strength = 1 + 0.1 * Math.sin(t * 0.011) + 0.05 * Math.sin(t * 0.037 + 1.7);
    const scale = 0.75 + 0.35 * strength;
    scratch[SWELL] = scale < 0.7 ? 0.7 : scale > 1.2 ? 1.2 : scale;
  }

  /**
   * The water surface height (m above sea level) at (x, z) and flight time t: the highest of the
   * ocean (sea level plus the swell, minus any whirlpool dip; wherever the ground is below sea level)
   * and every local body covering (x, z) (ice bodies included: their level is a solid surface).
   * -Infinity where neither exists.
   */
  function heightAt(x, z, t = clock.elapsed) {
    counters.queries++;
    scratch[GROUND] = NaN;
    const lake = world.hasWaters ? lakeAt(x, z) : null;
    let height = lake === null ? -Infinity : lake.level;
    measureGround(x, z);
    if (scratch[GROUND] < seaLevel) {
      swellInto(t);
      oceanHeightInto(x, z, t, scratch[SWELL], waves);
      funnelDipInto(x, z);
      const ocean = seaLevel + parameter[2] - scratch[DIP];
      if (ocean > height) height = ocean;
    }
    return height;
  }

  /**
   * The water at (x, z, t) into out (createWaterSample): height, the surface normal, the orbital
   * velocity, kind ('ocean' | 'lake' | 'none'), bodyId and body (the local body's record, null on the
   * ocean), material ('water' | 'ice'), depth (m of water above the ground) and film (true on a thin
   * film over a flat, which craft treat as wet ground). kind 'lake' covers every local body (lakes,
   * pools and films).
   */
  function sample(x, z, t = clock.elapsed, out = createWaterSample()) {
    counters.samples++;
    scratch[GROUND] = NaN;
    const lake = world.hasWaters ? lakeAt(x, z) : null;
    measureGround(x, z);
    const ground = scratch[GROUND];
    let oceanSurface = -Infinity;
    if (ground < seaLevel) {
      swellInto(t);
      oceanSample(x, z, t, scratch[SWELL], waves, swellScratch);
      funnelDipInto(x, z);
      oceanSurface = seaLevel + swellScratch.height - scratch[DIP];
    }
    if (lake !== null && lake.level >= oceanSurface) {
      out.height = lake.level;
      out.normalX = 0;
      out.normalY = 1;
      out.normalZ = 0;
      out.velocityX = 0;
      out.velocityY = 0;
      out.velocityZ = 0;
      out.kind = 'lake';
      out.bodyId = lake.id;
      out.body = lake;
      out.material = lake.material;
      out.depth = lake.level - ground;
      out.film = lake.kind === 'thin';
      return out;
    }
    if (oceanSurface > -Infinity) {
      out.height = oceanSurface;
      out.normalX = swellScratch.normalX;
      out.normalY = swellScratch.normalY;
      out.normalZ = swellScratch.normalZ;
      out.velocityX = swellScratch.velocityX;
      out.velocityY = swellScratch.velocityY;
      out.velocityZ = swellScratch.velocityZ;
      out.kind = 'ocean';
      out.bodyId = null;
      out.body = null;
      out.material = 'water';
      out.depth = oceanSurface - ground;
      out.film = false;
      return out;
    }
    out.height = -Infinity;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.velocityX = 0;
    out.velocityY = 0;
    out.velocityZ = 0;
    out.kind = 'none';
    out.bodyId = null;
    out.body = null;
    out.material = 'water';
    out.depth = 0;
    out.film = false;
    return out;
  }

  /** Whether there is water at (x, z): a local body or the sea (static levels, no swell, no time). */
  function isWater(x, z) {
    scratch[GROUND] = NaN;
    if (world.hasWaters && lakeAt(x, z) !== null) return true;
    measureGround(x, z);
    return scratch[GROUND] < seaLevel;
  }

  /** Whether (x, z) is open ocean: the sea, with no local body over it (static, no time). */
  function isOcean(x, z) {
    scratch[GROUND] = NaN;
    if (world.hasWaters && lakeAt(x, z) !== null) return false;
    measureGround(x, z);
    return scratch[GROUND] < seaLevel;
  }

  /**
   * The static water level at (x, z) (a local body's level, else sea level where the ground is below
   * it, else -Infinity), written into out[offset]: for callers that must not box a returned double.
   */
  function staticLevelInto(x, z, out, offset) {
    scratch[GROUND] = NaN;
    const lake = world.hasWaters ? lakeAt(x, z) : null;
    if (lake !== null) out[offset] = lake.level;
    else {
      measureGround(x, z);
      out[offset] = scratch[GROUND] < seaLevel ? seaLevel : -Infinity;
    }
  }

  return {
    /** The quantised ocean wave table (createOceanWaves) the ocean shader also draws. */
    waves,
    /** Mean sea level (m). */
    seaLevel,
    heightAt,
    sample,
    isWater,
    isOcean,
    staticLevelInto,
    /** The resolved local water bodies within radius of (x, z), nearest first: visit(record). */
    bodiesNear(x, z, radius, visit) {
      world.waterBodiesNear(x, z, radius, visit);
    },
    /** The ocean swell scale at (x, z) and time t (the same function the shader's swell follows). */
    swellScale(x, z, t = clock.elapsed) {
      return oceanSwellScale(t);
    },
    /** worldgen.groundHeight through the query's lattice cache (bit-identical, cheaper nearby). */
    groundHeight: groundAt,
    /** Attaches the water effects layer: whirlpool funnels lower the ocean surface. */
    attachEffects(next) {
      waterEffects = next ?? null;
    },
    getStats() {
      return { queries: counters.queries, samples: counters.samples, latticeMisses: counters.latticeMisses, effects: waterEffects !== null };
    },
  };
}
