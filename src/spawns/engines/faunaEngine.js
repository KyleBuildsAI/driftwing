// FaunaEngine (contract section 3, registry name 'fauna'): instanced animals with per-preset rule
// sets. One engine instance is one group of one species (faunaSpecies.js) following one behaviour:
//
//   murmuration  thousands of birds streaming toward a morphing, folding shape (seeded ellipsoid
//                lobes and travelling waves) with topological flocking; they burst away from the
//                player's path in a wave that spreads through their neighbours, then re-form
//   flock        a wandering boid flock (separation, alignment, cohesion) that scatters (the v1 look)
//   formation    a V (or echelon) that holds its slots and follows the player's gentle turns and
//                speed; the formation-slot API reports the player's own slot (getFormation), and the
//                optional achievement fires once when it is held long enough
//   circling     birds circling inside the Phase 1 thermals (WindField.thermalsNear), climbing with
//                the column's lean and gliding on to the next one; over the anchor with no thermal
//   pod          whales travelling at the surface: spouting, fluke-up dives, occasional full breaches
//                with a splash, and wakes (bioluminescent in a glowing bay) through the water layer
//   wingman      a large bird that waits, joins off the player's wing, matches speed within its
//                limits for escortSeconds, then peels off with a call (bus 'fauna:call')
//   drift        colossal animals drifting along their heading at a cruise altitude with slow
//                undulation; an optional slipstream wind source trails the leader (a lift lane)
//   herd         a terrain-following herd (altitude mode 'ground'): grazing and walking on the ground,
//                never onto slopes steeper than slopeLimit (rise over 6 m) or into water within
//                waterMargin; a stampede (the player buzzing it, a timer, or setParam 'stampede')
//                runs it away from the trigger, downhill-biased, raising the engine's own pooled dust
//   column       a long line of walkers along a PathFollower path (src/world/pathFollower.js): a
//                given path in the spawn frame, or 'auto' (buildGroundPath around slopes and water);
//                lanes, spacing and jitter (a caribou migration, a camel caravan)
//   surface      animals on the water surface of ctx.game.waterQuery (ocean and lakes, following the
//                swell): dolphins porpoise and race the craft's shadow when it flies low over the
//                water; flamingos stand in shallow water and take off in a wave when buzzed, fly as
//                a flock over the water, and settle back
//
// Rendering: one InstancedMesh per species, built in init() and shared by every group of that
// species (a contiguous block of agents each). The per-agent state reaches the GPU as three vec4
// attributes (position and scale, forward and bank, flap phase / gate / amplitude / seed), uploaded
// whole once per frame, and the vertex shader builds each agent's basis and animates the wings or
// the body there. Far away a small agent is drawn at least minPixels tall, so a murmuration reads as a
// dark cloud from kilometres out. Positions are relative to a floating origin near the camera.
//
// Ground and surface animals pool like the others; their dust (one shared sprite of soft billboards,
// each group owning a block of slots) counts against the fauna particle budget. Predators: the
// scatter radius and burst scale with the active craft module's faunaThreat (default 1; the eagle 2.5).
//
// Allocation: the frame update allocates nothing. Agent state lives in typed arrays, group doubles in
// a Float64Array, neighbour search in a shared hashed grid, and every helper takes integer indices:
// the per-agent helpers read their double arguments from the call registers (io, by IO index)
// because V8 boxes a double passed to, or returned from, a call it does not inline.
// Outside the engine, a few rationed calls may allocate: terrain heights (group ground probes, one
// every sixteenth frame per group; a herd's fine ground grid, one cell every fourth frame, every
// second while it stampedes; a surface group's water heights, one agent a frame), the thermal refresh of circling groups (WindField.thermalsNear, every
// thermalRefresh seconds), wind-source re-indexing when a slipstream leaves its bounds' margin, and
// bus events on discrete moments (a scatter, a formation change, a call).
//
// Big flocks search neighbours in interleaved slices: each agent refreshes its flocking steering every
// second frame near and every third at mid (NEIGHBOR_STRIDE), and steers on the kept value between.
//
// LOD: near simulates everything; mid simulates with fewer neighbours; far hides the agents and only
// moves the group (a heavy preset's lure takes over), and they are re-seeded around it on the way
// back in. A slipstream is removed at far (the player cannot reach it there) and re-added nearer.
// Params, units and ranges: docs/engines/fauna.md.
import { SPECIES } from './faunaSpecies.js';
import { createWindSample, ownsPresetAudio } from './engineKit.js';
import { SLOPE_RUN, buildGroundPath, createPath, createPathFollower } from '../../world/pathFollower.js';

export const FAUNA_BEHAVIORS = Object.freeze(['murmuration', 'flock', 'formation', 'circling', 'pod', 'wingman', 'drift', 'herd', 'column', 'surface']);
/** Altitude modes: above the ground, above sea level, on the water, near the player, on the ground. */
export const ALTITUDE_MODES = Object.freeze(['agl', 'msl', 'water', 'player', 'ground']);
/** Stampede triggers of a herd. */
export const STAMPEDE_TRIGGERS = Object.freeze(['player', 'timer', 'event']);
/** Dust sprites shared by every ground group (each group owns a block of slots). */
export const DUST_CAPACITY = 2048;

/** Engine defaults (docs/engines/fauna.md). A preset overrides any field; nested blocks merge. */
export const FAUNA_DEFAULTS = Object.freeze({
  species: 'starling',
  behavior: 'flock',
  count: 30,
  size: 1,
  sizeJitter: 0.15,
  speed: null,
  altitude: Object.freeze({ mode: 'agl', value: 120, spread: 20, ceiling: 2500 }),
  floor: 15,
  wander: 0.06,
  leash: 600,
  fadeIn: 1.5,
  fadeOut: 6,
  voice: null,
  voiceIntensity: 1,
  flocking: Object.freeze({ separation: 1.4, separationRadius: 3, alignment: 1.1, cohesion: 0.12, neighborRadius: 12, maxNeighbors: 7 }),
  scatter: Object.freeze({ radius: 60, burst: 24, recover: 3.5, spread: 0.9, trigger: 'scatter', cooldown: 6 }),
  murmuration: Object.freeze({ radius: 110, flatten: 0.45, morphSeconds: 11, fold: 0.35, wave: 0.18, seek: 0.9 }),
  formation: Object.freeze({
    shape: 'v', spacing: 3.4, angle: 34, rise: 0.12, followPlayer: true, followRadius: 380, followTurnRate: 5,
    maxHeadingGap: 55, playerSpacing: 24, tolerance: 14, heightTolerance: 9, headingTolerance: 30, holdSeconds: 10,
    achievement: null,
  }),
  circling: Object.freeze({ radius: Object.freeze([45, 85]), climb: 1.3, bottom: 150, top: 900, thermals: 1, thermalSearch: 1800, thermalRefresh: 12, useThermals: true, requireThermal: false }),
  pod: Object.freeze({
    spread: 45, surfaceSeconds: Object.freeze([14, 26]), diveSeconds: Object.freeze([10, 22]), breachChance: 0.3,
    spoutInterval: Object.freeze([4, 7]), spoutHeight: 8, wake: 0.55, glow: 1, depth: 16, callInterval: Object.freeze([16, 38]),
    seekWater: 0,
  }),
  wingman: Object.freeze({
    side: 0, right: 16, up: 2, forward: 3, joinRadius: 1500, escortSeconds: 60, lostDistance: 420, lostSeconds: 6,
    peelSeconds: 16, trigger: 'call', waitAltitude: 140, waitRadius: 70,
  }),
  drift: Object.freeze({ bob: 22, bobPeriod: 46, lane: 0.6, slipstream: null }),
  herd: Object.freeze({
    slopeLimit: 0.45, waterMargin: 8, gaits: Object.freeze({ walk: 1.3, trot: 4, run: 11 }), cohesion: 0.5, spacing: 6,
    graze: 0.55, stampede: Object.freeze({ trigger: 'player', radius: 260, speed: null, duration: 22, interval: 120, cooldown: 45, downhill: 0.6, maxAltitude: 350 }),
    dust: Object.freeze({ rate: 5, size: 5, color: 0xb39876 }),
  }),
  column: Object.freeze({
    path: 'auto', length: 2600, spacing: 5, lanes: 2, laneWidth: 3.2, speed: null, jitter: 0.6, mode: 'pingpong',
    maxSlope: null, resample: 8, dust: Object.freeze({ rate: 0, size: 4, color: 0xc4ab84 }),
  }),
  surface: Object.freeze({
    spread: 10,
    porpoise: Object.freeze({ height: 2, interval: Object.freeze([3, 7]) }),
    raceShadow: Object.freeze({ radius: 700, boost: 1.8, maxAltitude: 260 }),
    wade: Object.freeze({
      depthMax: 0.6, flushRadius: 150, takeoffWave: Object.freeze({ delay: 0.35, spread: 0.6 }), flySeconds: Object.freeze([25, 45]),
      flyAltitude: 45, flyRadius: 260, spacing: 2.2, searchRadius: 1600,
    }),
  }),
  calls: Object.freeze({ trigger: 'call', interval: null }),
});

/**
 * Per-behaviour defaults applied under the preset's params: a formation only scatters on a near miss,
 * whales, wingmen and drifting giants never do.
 */
const BEHAVIOR_DEFAULTS = Object.freeze({
  murmuration: Object.freeze({ scatter: Object.freeze({ radius: 70, burst: 26, recover: 4, spread: 0.92 }) }),
  flock: Object.freeze({}),
  formation: Object.freeze({ scatter: Object.freeze({ radius: 7, burst: 14, recover: 2.5, spread: 0.6 }) }),
  circling: Object.freeze({ scatter: Object.freeze({ radius: 35, burst: 12, recover: 3, spread: 0 }) }),
  pod: Object.freeze({ scatter: null }),
  wingman: Object.freeze({ scatter: null }),
  drift: Object.freeze({ scatter: null }),
  herd: Object.freeze({ scatter: null, altitude: Object.freeze({ mode: 'ground', value: 0, spread: 0 }), fadeIn: 0.8, sizeJitter: 0.08 }),
  column: Object.freeze({ scatter: null, altitude: Object.freeze({ mode: 'ground', value: 0, spread: 0 }), fadeIn: 0.8, sizeJitter: 0.08 }),
  surface: Object.freeze({ scatter: null, altitude: Object.freeze({ mode: 'water', value: 0, spread: 0 }) }),
});

/** Slipstream defaults (drift.slipstream: true or an object). */
const SLIPSTREAM_DEFAULTS = Object.freeze({ length: 900, radius: 80, speed: 16, lift: 3.5, turbulence: 0.15 });

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const GRAVITY = 9.81;
/** Neighbour grid: a hashed table of cells; collisions only add candidates the distance test drops. */
const GRID_BUCKETS = 4096;
/** Groups up to this size search neighbours by brute force. */
const BRUTE_FORCE_LIMIT = 48;
/**
 * Flocks larger than BRUTE_FORCE_LIMIT refresh each agent's flocking steering (the neighbour search)
 * every NEIGHBOR_STRIDE[tier] frames, in interleaved slices, and reuse it in between.
 */
const NEIGHBOR_STRIDE = Object.freeze({ near: 2, mid: 3, far: 3 });
/** Ground probes per group: a 3 x 3 grid around the group, one sample refreshed per frame. */
const GROUND_GRID = 3;
const MODE_WAIT = 0;
const MODE_JOIN = 1;
const MODE_ESCORT = 2;
const MODE_PEEL = 3;
const WHALE_SURFACE = 0;
const WHALE_DIVE = 1;
const WHALE_DEEP = 2;
const WHALE_BREACH = 3;

// Group doubles (data.g) by index.
const G = Object.freeze({
  X: 0, Y: 1, Z: 2, VX: 3, VY: 4, VZ: 5, HEADING: 6, SPEED: 7, TIME: 8, FLAP: 9, AGE: 10, FADE: 11,
  CX: 12, CY: 13, CZ: 14, RADIUS: 15, SCATTER_COOLDOWN: 16, CALL_TIMER: 17, HOLD: 18, HOLD_BEST: 19, GRACE: 20,
  MODE_TIMER: 21, THERMAL_TIMER: 22, WIND_X: 23, WIND_Y: 24, WIND_Z: 25, BASE_Y: 26, PLAYER_DISTANCE: 27, SIDE: 28,
  LOST: 29, TERRAIN_TIMER: 30, ANCHOR_X: 31, ANCHOR_Y: 32, ANCHOR_Z: 33, GROUND_X: 34, GROUND_Z: 35, GROUND_SPACING: 36,
  SLOT_X: 37, SLOT_Y: 38, SLOT_Z: 39, TARGET_SPEED: 40, LEAD_X: 41, LEAD_Y: 42, LEAD_Z: 43, LEAD_HEADING: 44,
  MORPH_A: 45, MORPH_B: 46, MORPH_C: 47, MORPH_YAW: 48, SIZE: 49, SLOT_DISTANCE: 50,
  STAMPEDE: 51, STAMPEDE_X: 52, STAMPEDE_Z: 53, STAMPEDE_COOLDOWN: 54, GAIT: 55, AVOID_TIMER: 56, STAMPEDE_TIMER: 57,
  FLUSH: 58, FLUSH_X: 59, FLUSH_Z: 60, FLUSH_Y: 61, RACE: 62, SHADOW_X: 63, SHADOW_Z: 64, PATH_TIME: 65, HOME_X: 66,
  HOME_Y: 67, HOME_Z: 68, DUST_LIVE: 69, FLUSH_COUNT: 70, WATER_CURSOR: 71, SHADOW_WET: 72,
});
const G_LENGTH = 73;
// Call registers (io) by index. A caller writes the slots a helper reads, then calls it.
const IO = Object.freeze({
  TARGET_X: 0, TARGET_Y: 1, TARGET_Z: 2, FEED_X: 3, FEED_Y: 4, FEED_Z: 5, GAIN: 6, SEEK_MAX: 7, WEIGHT: 8,
  MIN_SPEED: 9, MAX_SPEED: 10, ACCEL: 11, CLIMB: 12, BANK_BLEND: 13, FLOOR: 14, CUSHION: 15, BURST: 16,
  TIME: 17, GLIDE: 18, DECAY: 19, GROUND: 20, SAMPLE_X: 21, SAMPLE_Z: 22, INVERSE_CELL: 23, SPREAD: 24,
  SELF_X: 25, SELF_Y: 26, SELF_Z: 27, RADIUS_SQ: 28, SEPARATION: 29, SEPARATION_SQ: 30, SUM_X: 31, SUM_Y: 32,
  SUM_Z: 33, TURN_TARGET: 34, TURN_STEP: 35, SIZE_SCALE: 36, FORWARD_X: 37, FORWARD_Z: 38, RIGHT_X: 39, RIGHT_Z: 40,
  SLOPE: 41, GRAD_X: 42, GRAD_Z: 43, WET: 44, SLOPE_LIMIT: 45, MARGIN: 46, SPEED_NOW: 47, DUST_MIN: 48, STEP_DT: 49,
});
const IO_LENGTH = 50;
/** Agent modes of the new behaviours (pool.mode). */
const HERD_GRAZE = 0;
const HERD_WALK = 1;
const WADE_STAND = 0;
const WADE_TAKEOFF = 1;
const WADE_FLY = 2;
const WADE_LAND = 3;
/** Metres a standing wader shuffles about its home: with shallows all round it, and on a narrow band. */
const WADE_SHUFFLE = 1;
const WADE_SHUFFLE_NARROW = 0;
/** Shallow-water probes the ring scan for wader homes may spend at create (a narrow band's spots). */
const WADE_HOME_PROBES = 2500;
/** Seconds a flushed flock needs to glide home after its longest flight (the far tier's settle). */
const WADER_RETURN_SECONDS = 25;
const SWIM = 0;
const SWIM_LEAP = 1;
/** A herd's fine ground grid: FINE_GRID x FINE_GRID cells around the herd. */
const FINE_GRID = 9;
/** Ground probes refresh one sample every this many frames per group (terrain heights allocate). */
const GROUND_PROBE_FRAMES = 16;
/** The per-thermal arrays of a circling group's thermal cache. */
const THERMAL_FIELDS = Object.freeze(['x', 'z', 'capX', 'capZ', 'ground', 'top', 'radius', 'strength']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Preset params over the defaults; nested blocks merge one level deep. */
function resolveParams(params) {
  const resolved = {};
  const behaviorDefaults = BEHAVIOR_DEFAULTS[params.behavior] ?? {};
  for (const key of Object.keys(FAUNA_DEFAULTS)) {
    const base = FAUNA_DEFAULTS[key];
    const value = params[key];
    const behaviorValue = behaviorDefaults[key];
    if (isPlainObject(base)) {
      if (value === null || (value === undefined && behaviorValue === null)) {
        resolved[key] = key === 'scatter' ? null : { ...base };
        continue;
      }
      resolved[key] = { ...base, ...(isPlainObject(behaviorValue) ? behaviorValue : {}), ...(isPlainObject(value) ? value : {}) };
    } else {
      resolved[key] = value !== undefined ? value : fallbackValue(behaviorValue, base);
    }
  }
  if (!SPECIES[resolved.species]) throw new Error(`fauna: params.species must be one of ${Object.keys(SPECIES).join(', ')}, got ${JSON.stringify(resolved.species)}`);
  if (!FAUNA_BEHAVIORS.includes(resolved.behavior)) throw new Error(`fauna: params.behavior must be one of ${FAUNA_BEHAVIORS.join(', ')}, got ${JSON.stringify(resolved.behavior)}`);
  const count = Array.isArray(resolved.count) ? resolved.count : [resolved.count, resolved.count];
  if (!Number.isFinite(count[0]) || !Number.isFinite(count[1]) || count[0] < 1) throw new Error(`fauna: params.count must be a positive number or [min, max], got ${JSON.stringify(params.count)}`);
  resolved.countRange = count;
  if (!Number.isFinite(resolved.fadeOut) || resolved.fadeOut < 0 || resolved.fadeOut > 600) throw new Error(`fauna: params.fadeOut must be within 0..600 s, got ${JSON.stringify(params.fadeOut)}`);
  if (resolved.drift.slipstream === true) resolved.drift.slipstream = { ...SLIPSTREAM_DEFAULTS };
  else if (isPlainObject(resolved.drift.slipstream)) resolved.drift.slipstream = { ...SLIPSTREAM_DEFAULTS, ...resolved.drift.slipstream };
  validateGroundAndSurface(resolved, params);
  return resolved;
}

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

function isRange(value, min = 0) {
  return Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[0] >= min && value[1] >= value[0];
}

/**
 * The Phase 3 params (altitude mode, herd, column, surface): validated like the Phase 2 ones, each
 * error naming the field. The species' kind must suit the behaviour (quadrupeds herd or walk in a
 * column; the surface takes whales and wading birds).
 */
function validateGroundAndSurface(resolved, params) {
  const fail = (field, message) => {
    throw new Error(`fauna: params.${field} ${message}`);
  };
  const def = SPECIES[resolved.species];
  const behavior = resolved.behavior;
  if (!ALTITUDE_MODES.includes(resolved.altitude.mode)) fail('altitude.mode', `must be one of ${ALTITUDE_MODES.join(', ')}, got ${JSON.stringify(resolved.altitude.mode)}`);
  const walks = behavior === 'herd' || behavior === 'column';
  if (walks && def.kind !== 'quadruped') fail('species', `must be a quadruped for behavior ${behavior}, got ${def.id}`);
  if (def.kind === 'quadruped' && !walks) fail('behavior', `must be herd or column for the quadruped ${def.id}, got ${behavior}`);
  if (walks && resolved.altitude.mode !== 'ground') fail('altitude.mode', `must be ground for behavior ${behavior}`);
  if (resolved.altitude.mode === 'ground' && !walks) fail('altitude.mode', 'ground is for herd and column behaviours');
  if (behavior === 'surface' && def.kind !== 'whale' && !def.wade) fail('species', `must swim (a whale kind) or wade for behavior surface, got ${def.id}`);
  if (behavior === 'herd') {
    const herd = resolved.herd;
    if (!positive(herd.slopeLimit) || herd.slopeLimit > 5) fail('herd.slopeLimit', `must be within 0..5 (rise over ${SLOPE_RUN} m), got ${JSON.stringify(herd.slopeLimit)}`);
    if (!(Number.isFinite(herd.waterMargin) && herd.waterMargin >= 0)) fail('herd.waterMargin', 'must be a number >= 0 (m)');
    const gaits = { ...FAUNA_DEFAULTS.herd.gaits, ...(isPlainObject(params.herd?.gaits) ? params.herd.gaits : {}) };
    if (!(positive(gaits.walk) && gaits.trot > gaits.walk && gaits.run > gaits.trot)) fail('herd.gaits', 'must be { walk, trot, run } in rising m/s');
    herd.gaits = gaits;
    if (!positive(herd.spacing)) fail('herd.spacing', 'must be a positive number (m)');
    if (!(Number.isFinite(herd.cohesion) && herd.cohesion >= 0)) fail('herd.cohesion', 'must be a number >= 0');
    if (!(Number.isFinite(herd.graze) && herd.graze >= 0 && herd.graze <= 1)) fail('herd.graze', 'must be within 0..1');
    const stampede = { ...FAUNA_DEFAULTS.herd.stampede, ...(isPlainObject(params.herd?.stampede) ? params.herd.stampede : {}) };
    if (!STAMPEDE_TRIGGERS.includes(stampede.trigger)) fail('herd.stampede.trigger', `must be one of ${STAMPEDE_TRIGGERS.join(', ')}`);
    for (const field of ['radius', 'duration', 'interval']) if (!positive(stampede[field])) fail(`herd.stampede.${field}`, 'must be a positive number');
    if (stampede.speed !== null && !positive(stampede.speed)) fail('herd.stampede.speed', 'must be null or a positive number (m/s)');
    if (!(Number.isFinite(stampede.cooldown) && stampede.cooldown >= 0)) fail('herd.stampede.cooldown', 'must be a number >= 0 (s)');
    if (!(Number.isFinite(stampede.downhill) && stampede.downhill >= 0 && stampede.downhill <= 1)) fail('herd.stampede.downhill', 'must be within 0..1');
    herd.stampede = stampede;
    herd.dust = validateDust({ ...FAUNA_DEFAULTS.herd.dust, ...(isPlainObject(params.herd?.dust) ? params.herd.dust : {}) }, 'herd.dust', fail);
  }
  if (behavior === 'column') {
    const column = resolved.column;
    const path = column.path;
    if (path !== 'auto') {
      if (!isPlainObject(path) || !Array.isArray(path.points) || path.points.length < 2) fail('column.path', "must be 'auto' or { points: [[along, across], ...] (at least two), closed?, smoothing? }");
      path.points.forEach((point, index) => {
        if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) fail(`column.path.points[${index}]`, 'must be [along, across] in metres');
      });
    }
    if (!positive(column.length)) fail('column.length', 'must be a positive number (m)');
    if (!positive(column.spacing)) fail('column.spacing', 'must be a positive number (m)');
    if (!Number.isInteger(column.lanes) || column.lanes < 1 || column.lanes > 8) fail('column.lanes', 'must be an integer 1..8');
    if (!(Number.isFinite(column.laneWidth) && column.laneWidth >= 0)) fail('column.laneWidth', 'must be a number >= 0 (m)');
    if (column.speed !== null && !positive(column.speed)) fail('column.speed', 'must be null or a positive number (m/s)');
    if (!(Number.isFinite(column.jitter) && column.jitter >= 0)) fail('column.jitter', 'must be a number >= 0 (m)');
    if (!['loop', 'pingpong', 'once'].includes(column.mode)) fail('column.mode', 'must be loop, pingpong or once');
    if (column.maxSlope !== null && !positive(column.maxSlope)) fail('column.maxSlope', 'must be null or a positive number');
    if (!(Number.isFinite(column.resample) && column.resample >= 2)) fail('column.resample', 'must be a number >= 2 (m)');
    column.dust = validateDust({ ...FAUNA_DEFAULTS.column.dust, ...(isPlainObject(params.column?.dust) ? params.column.dust : {}) }, 'column.dust', fail);
  }
  if (behavior === 'surface') {
    const surface = resolved.surface;
    const merge = (key) => ({ ...FAUNA_DEFAULTS.surface[key], ...(isPlainObject(params.surface?.[key]) ? params.surface[key] : {}) });
    surface.porpoise = merge('porpoise');
    surface.raceShadow = merge('raceShadow');
    surface.wade = merge('wade');
    surface.wade.takeoffWave = { ...FAUNA_DEFAULTS.surface.wade.takeoffWave, ...(isPlainObject(params.surface?.wade?.takeoffWave) ? params.surface.wade.takeoffWave : {}) };
    if (!positive(surface.spread)) fail('surface.spread', 'must be a positive number (m)');
    if (!(Number.isFinite(surface.porpoise.height) && surface.porpoise.height >= 0)) fail('surface.porpoise.height', 'must be a number >= 0 (m)');
    if (!isRange(surface.porpoise.interval, 0.5)) fail('surface.porpoise.interval', 'must be [min, max] seconds (min >= 0.5)');
    if (!(Number.isFinite(surface.raceShadow.radius) && surface.raceShadow.radius >= 0)) fail('surface.raceShadow.radius', 'must be a number >= 0 (m)');
    if (!(Number.isFinite(surface.raceShadow.boost) && surface.raceShadow.boost >= 1)) fail('surface.raceShadow.boost', 'must be a number >= 1');
    if (!positive(surface.raceShadow.maxAltitude)) fail('surface.raceShadow.maxAltitude', 'must be a positive number (m above the water)');
    const wade = surface.wade;
    for (const field of ['depthMax', 'flushRadius', 'flyAltitude', 'flyRadius', 'spacing', 'searchRadius']) if (!positive(wade[field])) fail(`surface.wade.${field}`, 'must be a positive number');
    if (!isRange(wade.flySeconds, 1)) fail('surface.wade.flySeconds', 'must be [min, max] seconds (min >= 1)');
    if (!(Number.isFinite(wade.takeoffWave.delay) && wade.takeoffWave.delay >= 0)) fail('surface.wade.takeoffWave.delay', 'must be a number >= 0 (s per 10 m)');
    if (!(Number.isFinite(wade.takeoffWave.spread) && wade.takeoffWave.spread >= 0)) fail('surface.wade.takeoffWave.spread', 'must be a number >= 0 (s)');
  }
}

function validateDust(dust, field, fail) {
  if (!(Number.isFinite(dust.rate) && dust.rate >= 0 && dust.rate <= 60)) fail(`${field}.rate`, 'must be within 0..60 puffs a second per running animal');
  if (!positive(dust.size)) fail(`${field}.size`, 'must be a positive number (m)');
  if (!Number.isInteger(dust.color) || dust.color < 0 || dust.color > 0xffffff) fail(`${field}.color`, 'must be an sRGB hex number');
  return dust;
}

function fallbackValue(behaviorValue, base) {
  return behaviorValue !== undefined ? behaviorValue : base;
}

function rangeValue(range, random) {
  if (Array.isArray(range)) return range[0] + random() * (range[1] - range[0]);
  return range;
}

/** Contiguous agent ranges in a species buffer (first fit; freed ranges merge). */
function createRangeAllocator(capacity) {
  const free = [{ start: 0, length: capacity }];
  const used = new Map();
  let highWater = 0;
  function refreshHighWater() {
    highWater = 0;
    for (const [start, length] of used) if (start + length > highWater) highWater = start + length;
  }
  return {
    alloc(length) {
      for (let index = 0; index < free.length; index++) {
        const range = free[index];
        if (range.length < length) continue;
        const start = range.start;
        range.start += length;
        range.length -= length;
        if (range.length === 0) free.splice(index, 1);
        used.set(start, length);
        refreshHighWater();
        return start;
      }
      return -1;
    },
    free(start) {
      const length = used.get(start);
      if (length === undefined) return false;
      used.delete(start);
      free.push({ start, length });
      free.sort((first, second) => first.start - second.start);
      for (let index = free.length - 2; index >= 0; index--) {
        const current = free[index];
        const next = free[index + 1];
        if (current.start + current.length === next.start) {
          current.length += next.length;
          free.splice(index + 1, 1);
        }
      }
      refreshHighWater();
      return true;
    },
    get highWater() { return highWater; },
    get used() {
      let total = 0;
      for (const length of used.values()) total += length;
      return total;
    },
    capacity,
  };
}

/** Creates the FaunaEngine (see the file header). */
export function createFaunaEngine() {
  let ctx = null;
  let THREE = null;
  const pools = {};
  const poolList = [];
  const liveInstances = new Set();
  let live = 0;
  let frameStamp = -1;
  // Holders of the typed wildlifeQuiet event (spawn ids, a total solar eclipse): while any holds,
  // the animals fall silent (no calls, no scatter cries, the wing rush and songs eased out).
  const quietSources = new Set();
  const pixelWorld = { value: 0.002 };
  let pixelWorldUniform = null;

  // ---- Shared neighbour grid and scratch -------------------------------------------------------
  let maxAgents = 0;
  const gridHead = new Int32Array(GRID_BUCKETS);
  let gridNext = null;
  const neighborhood = new Float64Array(10);
  const steering = new Float64Array(3);
  const lateral = new Float64Array(1);
  const io = new Float64Array(IO_LENGTH);
  // The active craft's faunaThreat (default 1; the eagle 2.5): scatter radius and burst scale with it.
  const threat = new Float64Array(1);
  threat[0] = 1;
  // The frame's time step, for the helpers below update(): a double handed to a call V8 does not
  // inline (the engine's update inlines a great deal and runs out of budget) is boxed every call.
  const frameStep = new Float64Array(1);
  let threatCraft = null;

  // =============================================================================================
  // SPECIES POOLS (init)
  // =============================================================================================
  function buildMaterial(def, attributes) {
    const { TSL } = ctx;
    const {
      Fn, float, vec3, sin, cos, abs, sign, max, min, mix, smoothstep, saturate, length, cross,
      positionGeometry, instancedDynamicBufferAttribute, vertexColor, attribute, color, uniform, modelWorldMatrix,
      cameraPosition, vec4,
    } = TSL;
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: def.kind === 'whale' ? 0.55 : def.kind === 'quadruped' ? 0.92 : 0.86,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    const agentPosition = instancedDynamicBufferAttribute(attributes.position, 'vec4');
    const agentDirection = instancedDynamicBufferAttribute(attributes.direction, 'vec4');
    const agentAnim = instancedDynamicBufferAttribute(attributes.anim, 'vec4');
    const time = ctx.uniforms.time;
    if (!pixelWorldUniform) pixelWorldUniform = uniform(pixelWorld.value);

    material.positionNode = Fn(() => {
      const local = positionGeometry;
      const phase = agentAnim.x;
      const radial = abs(local.x);
      let animated;
      if (def.kind === 'bird' && def.wade) {
        // A wading bird: gate below 0 folds it (standing: wings tucked, legs down, neck up); above 0
        // it flaps as any bird, the legs trailing straight back and the neck reaching forward.
        const flap = def.flap;
        const hinge = def.hinge;
        const reach = Math.max(def.halfSpan - hinge, 1e-3);
        const fold = saturate(agentAnim.y.negate());
        const flapGate = saturate(agentAnim.y);
        const span = max(radial.sub(hinge), 0).mul(float(1).sub(fold.mul(0.82)));
        const stroke = sin(phase).add(sin(phase.mul(2)).mul(0.2));
        const flapAngle = stroke.mul(agentAnim.z.mul(0.35).add(0.8).mul(flap.amplitude)).add(flap.dihedral);
        const glideAngle = sin(time.mul(1.2).add(agentAnim.w.mul(40))).mul(0.03).add(flap.glideDihedral);
        const wingAngle = mix(mix(glideAngle, flapAngle, flapGate), float(0.25), fold);
        const bend = wingAngle.mul(smoothstep(0.3, 0.9, span.div(reach)).mul(0.55).add(1));
        const bentX = sign(local.x).mul(min(radial, hinge).add(span.mul(cos(bend))));
        const limb = attribute('leg', 'vec2');
        const legMask = limb.y.mul(float(1).sub(limb.x));
        const neckMask = limb.y.mul(limb.x);
        // Legs swing back about the hip (legTop) as the fold opens; the neck tips forward about its base.
        const legAngle = float(1).sub(fold).mul(1.35);
        const legY = local.y.sub(def.wade.legTop[1]);
        const legZ = local.z.sub(def.wade.legTop[2]);
        const legRotY = legY.mul(cos(legAngle)).add(legZ.mul(sin(legAngle))).add(def.wade.legTop[1]);
        const legRotZ = legZ.mul(cos(legAngle)).sub(legY.mul(sin(legAngle))).add(def.wade.legTop[2]);
        const neckAngle = float(1).sub(fold).mul(-1.15);
        const neckY = local.y.sub(def.wade.neckBase[1]);
        const neckZ = local.z.sub(def.wade.neckBase[2]);
        const neckRotY = neckY.mul(cos(neckAngle)).add(neckZ.mul(sin(neckAngle))).add(def.wade.neckBase[1]);
        const neckRotZ = neckZ.mul(cos(neckAngle)).sub(neckY.mul(sin(neckAngle))).add(def.wade.neckBase[2]);
        const bodyBob = sin(phase).mul(-0.018 * def.size).mul(flapGate);
        const wingY = local.y.add(span.mul(sin(bend))).add(bodyBob);
        const limbY = mix(mix(wingY, legRotY, legMask), neckRotY, neckMask);
        const limbZ = mix(mix(local.z, legRotZ, legMask), neckRotZ, neckMask);
        animated = vec3(mix(bentX, local.x, limb.y), limbY, limbZ);
      } else if (def.kind === 'bird') {
        const flap = def.flap;
        const hinge = def.hinge;
        const reach = Math.max(def.halfSpan - hinge, 1e-3);
        const span = max(radial.sub(hinge), 0);
        const stroke = sin(phase).add(sin(phase.mul(2)).mul(0.2));
        const flapAngle = stroke.mul(agentAnim.z.mul(0.35).add(0.8).mul(flap.amplitude)).add(flap.dihedral);
        const glideAngle = sin(time.mul(1.2).add(agentAnim.w.mul(40))).mul(0.03).add(flap.glideDihedral);
        const wingAngle = mix(glideAngle, flapAngle, agentAnim.y);
        const bend = wingAngle.mul(smoothstep(0.3, 0.9, span.div(reach)).mul(0.55).add(1));
        const bentX = sign(local.x).mul(min(radial, hinge).add(span.mul(cos(bend))));
        const bodyBob = sin(phase).mul(-0.018 * def.size).mul(agentAnim.y);
        animated = vec3(bentX, local.y.add(span.mul(sin(bend))).add(bodyBob), local.z);
      } else if (def.kind === 'quadruped') {
        // Legs swing about the hip in diagonal pairs (the leg attribute's phase offset), the stride
        // widening from walk to run (anim.z); standing (gate 0) freezes them. The body bobs twice a
        // stride. Leg vertices move as a lever about the hip: a thin leg rotates as it translates.
        const gait = def.gait;
        const limb = attribute('leg', 'vec2');
        const amplitude = mix(float(gait.amplitude[0]), float(gait.amplitude[1]), agentAnim.z).mul(agentAnim.y);
        const swing = sin(phase.add(limb.x)).mul(amplitude);
        const lever = max(float(gait.hip).sub(local.y), 0).mul(limb.y);
        const legZ = local.z.sub(sin(swing).mul(lever));
        const legY = local.y.add(float(1).sub(cos(swing)).mul(lever));
        const bob = abs(sin(phase)).mul(gait.bob).mul(agentAnim.y).mul(agentAnim.z.mul(1.5).add(0.5)).mul(float(1).sub(limb.y));
        animated = vec3(local.x, legY.add(bob), legZ);
      } else {
        const body = def.body;
        const hinge = def.hinge;
        const tail = saturate(local.z.sub(body.tailStart).div(body.tailEnd - body.tailStart));
        const wave = sin(phase.sub(local.z.mul(TWO_PI / body.wavelength)));
        const bodyLift = tail.mul(tail).mul(body.amplitude).mul(agentAnim.z).mul(wave);
        // Pectoral fins: beyond the hinge and ahead of the flukes.
        const finMask = smoothstep(hinge * 0.98, hinge * 1.02, radial).mul(float(1).sub(smoothstep(body.tailEnd * 0.1, body.tailEnd * 0.35, local.z)));
        const finAngle = sin(phase.mul(0.5).add(1.3)).mul(body.finAmplitude).mul(finMask);
        const finSpan = max(radial.sub(hinge), 0).mul(finMask);
        const finX = sign(local.x).mul(radial.sub(finSpan).add(finSpan.mul(cos(finAngle))));
        animated = vec3(finX, local.y.add(bodyLift).add(finSpan.mul(sin(finAngle))), local.z);
      }
      // The agent's basis: forward, right (level, then banked) and up.
      const forward = agentDirection.xyz;
      const rightRaw = vec3(forward.z.negate(), 0, forward.x);
      const right0 = rightRaw.div(max(length(rightRaw), 1e-4));
      const up0 = cross(right0, forward);
      const cosBank = cos(agentDirection.w);
      const sinBank = sin(agentDirection.w);
      const right = right0.mul(cosBank).sub(up0.mul(sinBank));
      const up = up0.mul(cosBank).add(right0.mul(sinBank));
      let scale = agentPosition.w;
      if (def.minPixels > 0) {
        // Far away, never smaller than minPixels on screen.
        const worldAgent = modelWorldMatrix.mul(vec4(agentPosition.xyz, 1)).xyz;
        const distance = length(worldAgent.sub(cameraPosition));
        const boost = max(float(1), distance.mul(pixelWorldUniform).mul(def.minPixels).div(max(agentPosition.w.mul(def.size), 1e-4)));
        scale = agentPosition.w.mul(boost);
      }
      return agentPosition.xyz.add(right.mul(animated.x).add(up.mul(animated.y)).sub(forward.mul(animated.z)).mul(scale));
    })();
    const tint = mix(float(0.86), float(1.1), agentAnim.w);
    material.colorNode = vertexColor().mul(tint);
    if (def.spotColor !== undefined) {
      const glow = attribute('emissive', 'float');
      material.emissiveNode = color(def.spotColor).mul(glow).mul(ctx.uniforms.nightFactor.mul(2.2).add(0.35));
    }
    return material;
  }

  function createSpeciesPool(def) {
    const capacity = def.capacity;
    const geometry = def.build(THREE);
    const positionData = new Float32Array(capacity * 4);
    const directionData = new Float32Array(capacity * 4);
    const animData = new Float32Array(capacity * 4);
    for (let index = 0; index < capacity; index++) directionData[index * 4 + 2] = -1;
    const attributes = {
      position: new THREE.InstancedBufferAttribute(positionData, 4).setUsage(THREE.DynamicDrawUsage),
      direction: new THREE.InstancedBufferAttribute(directionData, 4).setUsage(THREE.DynamicDrawUsage),
      anim: new THREE.InstancedBufferAttribute(animData, 4).setUsage(THREE.DynamicDrawUsage),
    };
    const material = buildMaterial(def, attributes);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    // The agents are placed by the shader: the instance matrices stay identity and never upload.
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = `fauna-${def.id}`;
    ctx.scene.add(mesh);
    if (ctx.registerPrewarm) ctx.registerPrewarm(mesh);
    maxAgents = Math.max(maxAgents, capacity);
    return {
      def,
      capacity,
      geometry,
      material,
      mesh,
      attributes,
      positionData,
      directionData,
      animData,
      ranges: createRangeAllocator(capacity),
      origin: new THREE.Vector3(),
      originFrame: -1,
      drawing: 0,
      px: new Float64Array(capacity),
      py: new Float64Array(capacity),
      pz: new Float64Array(capacity),
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      vz: new Float32Array(capacity),
      bank: new Float32Array(capacity),
      phase: new Float32Array(capacity),
      gate: new Float32Array(capacity),
      excite: new Float32Array(capacity),
      seed: new Float32Array(capacity),
      scale: new Float32Array(capacity),
      fleeX: new Float32Array(capacity),
      fleeY: new Float32Array(capacity),
      fleeZ: new Float32Array(capacity),
      flockX: new Float32Array(capacity),
      flockY: new Float32Array(capacity),
      flockZ: new Float32Array(capacity),
      homeX: new Float32Array(capacity),
      homeY: new Float32Array(capacity),
      homeZ: new Float32Array(capacity),
      mode: new Uint8Array(capacity),
      timer: new Float32Array(capacity),
      aux: new Float32Array(capacity),
      aux2: new Float32Array(capacity),
      /** Quadrupeds: the gait blend (0 walk .. 1 run) the shader widens the stride with. */
      gait: new Float32Array(capacity),
      /** Wading birds: how far (m) a standing bird shuffles about its home, kept inside the shallows. */
      shuffle: new Float32Array(capacity),
    };
  }

  /** Once per frame: the floating origin near the camera and the pixel size for minPixels. */
  function beginFrame() {
    const frame = ctx.state.frame;
    if (frame === frameStamp) return;
    frameStamp = frame;
    const camera = ctx.camera;
    const height = ctx.renderer && ctx.renderer.domElement ? ctx.renderer.domElement.clientHeight : 0;
    const viewportHeight = height > 0 ? height : 720;
    const nextPixelWorld = (2 * Math.tan(camera.fov * DEG * 0.5)) / (camera.zoom * viewportHeight);
    // The uniform is written only when the lens or the viewport changed.
    if (nextPixelWorld !== pixelWorld.value) {
      pixelWorld.value = nextPixelWorld;
      if (pixelWorldUniform) pixelWorldUniform.value = nextPixelWorld;
    }
    for (let index = 0; index < poolList.length; index++) {
      const pool = poolList[index];
      pool.origin.x = Math.round(camera.position.x / 64) * 64;
      pool.origin.y = Math.round(camera.position.y / 64) * 64;
      pool.origin.z = Math.round(camera.position.z / 64) * 64;
      pool.mesh.position.copy(pool.origin);
      pool.drawing = 0;
    }
    if (dust) {
      dust.origin.x = Math.round(camera.position.x / 64) * 64;
      dust.origin.y = Math.round(camera.position.y / 64) * 64;
      dust.origin.z = Math.round(camera.position.z / 64) * 64;
      dust.sprite.position.copy(dust.origin);
    }
    // The threat follows a craft change only (a string compare a frame).
    const craft = ctx.state.flight ? ctx.state.flight.craft : null;
    if (craft !== threatCraft) {
      threatCraft = craft;
      const registry = ctx.game && ctx.game.craftRegistry;
      const module = craft && registry && typeof registry.get === 'function' ? registry.get(craft) : null;
      threat[0] = module && Number.isFinite(module.faunaThreat) && module.faunaThreat > 0 ? module.faunaThreat : 1;
    }
  }

  // =============================================================================================
  // TERRAIN AND WATER
  // =============================================================================================
  function surfaceBelow(x, z) {
    const ground = ctx.terrain.heightAt(x, z);
    const water = ctx.terrain.waterLevel;
    return ground > water ? ground : water;
  }

  /**
   * Every GROUND_PROBE_FRAMES frames, refreshes one of the group's 3 x 3 ground samples (round robin),
   * re-centring the grid when needed.
   */
  function probeGround(data) {
    data.groundWait = (data.groundWait + 1) % GROUND_PROBE_FRAMES;
    if (data.groundWait !== 0) return;
    const g = data.g;
    const spacing = g[G.GROUND_SPACING];
    const offsetX = g[G.CX] - g[G.GROUND_X];
    const offsetZ = g[G.CZ] - g[G.GROUND_Z];
    if (offsetX * offsetX + offsetZ * offsetZ > spacing * spacing * 0.5) {
      g[G.GROUND_X] = Math.round(g[G.CX] / spacing) * spacing;
      g[G.GROUND_Z] = Math.round(g[G.CZ] / spacing) * spacing;
    }
    const cell = data.groundCursor;
    data.groundCursor = (cell + 1) % (GROUND_GRID * GROUND_GRID);
    const column = (cell % GROUND_GRID) - 1;
    const row = Math.floor(cell / GROUND_GRID) - 1;
    data.ground[cell] = surfaceBelow(g[G.GROUND_X] + column * spacing, g[G.GROUND_Z] + row * spacing);
  }

  /**
   * The group's ground (or water) height at io[SAMPLE_X], io[SAMPLE_Z], bilinear over its sample grid,
   * into io[GROUND].
   */
  function sampleGround(data) {
    const g = data.g;
    const spacing = g[G.GROUND_SPACING];
    const u = Math.min(Math.max((io[IO.SAMPLE_X] - g[G.GROUND_X]) / spacing + 1, 0), 1.999);
    const v = Math.min(Math.max((io[IO.SAMPLE_Z] - g[G.GROUND_Z]) / spacing + 1, 0), 1.999);
    const column = Math.floor(u);
    const row = Math.floor(v);
    const fu = u - column;
    const fv = v - row;
    const ground = data.ground;
    const h00 = ground[row * GROUND_GRID + column];
    const h10 = ground[row * GROUND_GRID + column + 1];
    const h01 = ground[(row + 1) * GROUND_GRID + column];
    const h11 = ground[(row + 1) * GROUND_GRID + column + 1];
    io[IO.GROUND] = (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
  }

  /** The ground under agent index, into io[GROUND]. */
  function groundUnder(data, pool, index) {
    io[IO.SAMPLE_X] = pool.px[index];
    io[IO.SAMPLE_Z] = pool.pz[index];
    sampleGround(data);
  }

  /** The ground under the group's goal, into io[GROUND]. */
  function groundUnderGoal(data) {
    io[IO.SAMPLE_X] = data.g[G.X];
    io[IO.SAMPLE_Z] = data.g[G.Z];
    sampleGround(data);
  }

  function fillGround(data) {
    const g = data.g;
    const spacing = g[G.GROUND_SPACING];
    g[G.GROUND_X] = Math.round(g[G.X] / spacing) * spacing;
    g[G.GROUND_Z] = Math.round(g[G.Z] / spacing) * spacing;
    for (let cell = 0; cell < GROUND_GRID * GROUND_GRID; cell++) {
      const column = (cell % GROUND_GRID) - 1;
      const row = Math.floor(cell / GROUND_GRID) - 1;
      data.ground[cell] = surfaceBelow(g[G.GROUND_X] + column * spacing, g[G.GROUND_Z] + row * spacing);
    }
  }

  /** The water surface at (x, z): sea level, unless a whirlpool funnel is active somewhere. */
  function waterSurface(x, z) {
    return ctx.water && ctx.water.activeVortices > 0 ? ctx.water.surfaceHeightAt(x, z) : ctx.terrain.waterLevel;
  }

  /** Whether the water is flat everywhere (no funnel): then its surface is sea level itself. */
  function waterIsFlat() {
    return !ctx.water || ctx.water.activeVortices === 0;
  }

  /** Whether (x, z) and four points margin metres around it are all open water (the pod's land test, 6 m deep). */
  function isOpenWater(x, z, margin) {
    const deep = ctx.terrain.waterLevel - 6;
    return ctx.terrain.heightAt(x, z) < deep
      && ctx.terrain.heightAt(x + margin, z) < deep && ctx.terrain.heightAt(x - margin, z) < deep
      && ctx.terrain.heightAt(x, z + margin) < deep && ctx.terrain.heightAt(x, z - margin) < deep;
  }

  /**
   * A pod's create-time search (pod.seekWater): when the anchor is not on open water, moves the group
   * goal to the nearest open water within reach (rings 150 m apart, 16 bearings each), so a candidate
   * near a coast puts its whales in the sea. Returns false when there is none.
   */
  function seekOpenWater(g, reach, spread) {
    // Room to swim: the pod's own lanes and the 350 m it looks ahead for land.
    const margin = Math.max(250, spread * 4);
    if (isOpenWater(g[G.X], g[G.Z], margin)) return true;
    for (let radius = 150; radius <= reach; radius += 150) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * TWO_PI;
        const x = Math.round(g[G.ANCHOR_X] + Math.sin(angle) * radius);
        const z = Math.round(g[G.ANCHOR_Z] - Math.cos(angle) * radius);
        if (!isOpenWater(x, z, margin)) continue;
        g[G.X] = x;
        g[G.Z] = z;
        g[G.ANCHOR_X] = x;
        g[G.ANCHOR_Z] = z;
        return true;
      }
    }
    return false;
  }

  // =============================================================================================
  // NEIGHBOURS
  // =============================================================================================
  /** The hashed grid bucket of agent index (cell size 1 / io[INVERSE_CELL]). */
  function cellKey(pool, index) {
    const inverseCell = io[IO.INVERSE_CELL];
    const cellX = Math.floor(pool.px[index] * inverseCell);
    const cellY = Math.floor(pool.py[index] * inverseCell);
    const cellZ = Math.floor(pool.pz[index] * inverseCell);
    return ((Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663) ^ Math.imul(cellZ, 83492791)) >>> 0) & (GRID_BUCKETS - 1);
  }

  function buildGrid(pool, start, end) {
    gridHead.fill(-1);
    for (let index = start; index < end; index++) {
      const key = cellKey(pool, index);
      gridNext[index] = gridHead[key];
      gridHead[key] = index;
    }
  }

  /**
   * Sums separation push, neighbour velocity and offset for agent index (up to maxNeighbors within
   * radius), and adopts a neighbour's stronger excitement (the scatter wave). useGrid: the hashed grid
   * built for this group; else brute force over [start, end). Reads io[INVERSE_CELL] and io[SPREAD].
   */
  function gatherNeighbors(pool, index, start, end, flocking, useGrid, maxNeighbors) {
    neighborhood.fill(0);
    const x = pool.px[index];
    const y = pool.py[index];
    const z = pool.pz[index];
    const inverseCell = io[IO.INVERSE_CELL];
    io[IO.SELF_X] = x;
    io[IO.SELF_Y] = y;
    io[IO.SELF_Z] = z;
    io[IO.RADIUS_SQ] = flocking.neighborRadius * flocking.neighborRadius;
    io[IO.SEPARATION] = flocking.separationRadius;
    io[IO.SEPARATION_SQ] = flocking.separationRadius * flocking.separationRadius;
    let found = 0;
    if (useGrid) {
      const baseX = Math.floor(x * inverseCell);
      const baseY = Math.floor(y * inverseCell);
      const baseZ = Math.floor(z * inverseCell);
      for (let cell = 0; cell < 27 && found < maxNeighbors; cell++) {
        const cellX = baseX + (cell % 3) - 1;
        const cellY = baseY + (Math.floor(cell / 3) % 3) - 1;
        const cellZ = baseZ + Math.floor(cell / 9) - 1;
        const key = ((Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663) ^ Math.imul(cellZ, 83492791)) >>> 0) & (GRID_BUCKETS - 1);
        for (let other = gridHead[key]; other >= 0 && found < maxNeighbors; other = gridNext[other]) {
          if (other === index) continue;
          found += accumulateNeighbor(pool, index, other);
        }
      }
    } else {
      for (let other = start; other < end && found < maxNeighbors; other++) {
        if (other === index) continue;
        found += accumulateNeighbor(pool, index, other);
      }
    }
    neighborhood[9] = found;
  }

  /** Adds neighbour other to agent index's sums (the agent's position and radii are in io). */
  function accumulateNeighbor(pool, index, other) {
    const dx = pool.px[other] - io[IO.SELF_X];
    const dy = pool.py[other] - io[IO.SELF_Y];
    const dz = pool.pz[other] - io[IO.SELF_Z];
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq > io[IO.RADIUS_SQ]) return 0;
    if (distanceSq < io[IO.SEPARATION_SQ] && distanceSq > 1e-6) {
      const distance = Math.sqrt(distanceSq);
      const push = (1 - distance / io[IO.SEPARATION]) / distance;
      neighborhood[0] -= dx * push;
      neighborhood[1] -= dy * push;
      neighborhood[2] -= dz * push;
    }
    neighborhood[3] += pool.vx[other];
    neighborhood[4] += pool.vy[other];
    neighborhood[5] += pool.vz[other];
    neighborhood[6] += dx;
    neighborhood[7] += dy;
    neighborhood[8] += dz;
    // The scatter wave: a neighbour's panic spreads (weakened by spread per hop).
    const panic = pool.excite[other] * io[IO.SPREAD];
    if (panic > pool.excite[index] + 0.2) {
      pool.excite[index] = panic;
      pool.fleeX[index] = pool.fleeX[other];
      pool.fleeY[index] = pool.fleeY[other];
      pool.fleeZ[index] = pool.fleeZ[other];
    }
    return 1;
  }

  /**
   * The flocking steering of agent index into steering[0..2]: searched afresh on its slice's frame
   * (and kept in the flock arrays), reused from them on the others. Reads io[INVERSE_CELL] and io[SPREAD].
   */
  function flockSteering(pool, index, start, end, flocking, useGrid, maxNeighbors, fresh) {
    if (fresh) {
      steering[0] = 0;
      steering[1] = 0;
      steering[2] = 0;
      gatherNeighbors(pool, index, start, end, flocking, useGrid, maxNeighbors);
      steerFlocking(pool, index, flocking);
      pool.flockX[index] = steering[0];
      pool.flockY[index] = steering[1];
      pool.flockZ[index] = steering[2];
      return;
    }
    steering[0] = pool.flockX[index];
    steering[1] = pool.flockY[index];
    steering[2] = pool.flockZ[index];
  }

  /** Separation, alignment and cohesion from the gathered neighbourhood, loosened while excited. */
  function steerFlocking(pool, index, flocking) {
    const calm = 1 - 0.8 * pool.excite[index];
    steering[0] += neighborhood[0] * flocking.separation * 10;
    steering[1] += neighborhood[1] * flocking.separation * 10;
    steering[2] += neighborhood[2] * flocking.separation * 10;
    const count = neighborhood[9];
    if (count <= 0) return;
    const alignment = flocking.alignment * calm;
    const cohesion = flocking.cohesion * calm;
    steering[0] += (neighborhood[3] / count - pool.vx[index]) * alignment + (neighborhood[6] / count) * cohesion;
    steering[1] += (neighborhood[4] / count - pool.vy[index]) * alignment + (neighborhood[7] / count) * cohesion;
    steering[2] += (neighborhood[5] / count - pool.vz[index]) * alignment + (neighborhood[8] / count) * cohesion;
  }

  // =============================================================================================
  // STEERING AND INTEGRATION
  // =============================================================================================
  /**
   * Seeks io[TARGET_*] with a velocity feed-forward io[FEED_*] at io[GAIN] (1/s), the desired speed
   * capped at io[SEEK_MAX], adding the difference to the agent's velocity times io[WEIGHT].
   */
  function steerToward(pool, index) {
    let desiredX = (io[IO.TARGET_X] - pool.px[index]) * io[IO.GAIN] + io[IO.FEED_X];
    let desiredY = (io[IO.TARGET_Y] - pool.py[index]) * io[IO.GAIN] + io[IO.FEED_Y];
    let desiredZ = (io[IO.TARGET_Z] - pool.pz[index]) * io[IO.GAIN] + io[IO.FEED_Z];
    const maxSpeed = io[IO.SEEK_MAX];
    const lengthSq = desiredX * desiredX + desiredY * desiredY + desiredZ * desiredZ;
    if (lengthSq > maxSpeed * maxSpeed) {
      const scale = maxSpeed / Math.sqrt(lengthSq);
      desiredX *= scale;
      desiredY *= scale;
      desiredZ *= scale;
    }
    const weight = io[IO.WEIGHT];
    steering[0] += (desiredX - pool.vx[index]) * weight;
    steering[1] += (desiredY - pool.vy[index]) * weight;
    steering[2] += (desiredZ - pool.vz[index]) * weight;
  }

  /** Flees along the agent's flee direction at io[BURST] (m/s) times its excitement. */
  function steerFlee(pool, index) {
    const excitement = pool.excite[index];
    if (excitement <= 0.01) return;
    const strength = io[IO.BURST] * excitement;
    steering[0] += pool.fleeX[index] * strength;
    steering[1] += pool.fleeY[index] * strength;
    steering[2] += pool.fleeZ[index] * strength;
  }

  /** Pushes up within 20 m of the floor height io[CUSHION]. */
  function steerAboveFloor(pool, index) {
    const cushion = io[IO.CUSHION] + 20 - pool.py[index];
    if (cushion > 0) steering[1] += cushion * 0.9;
  }

  /**
   * Applies the steering (accel limit io[ACCEL], climb limit io[CLIMB], speeds io[MIN_SPEED] to
   * io[MAX_SPEED]), banks into the turn at io[BANK_BLEND] and moves the agent over the frame's step,
   * never below io[FLOOR]. Returns nothing; writes the agent's arrays.
   */
  function integrate(pool, index) {
    const dt = frameStep[0];
    const excitement = pool.excite[index];
    const limit = io[IO.ACCEL] * (1 + 1.6 * excitement);
    const lengthSq = steering[0] * steering[0] + steering[1] * steering[1] + steering[2] * steering[2];
    if (lengthSq > limit * limit) {
      const scale = limit / Math.sqrt(lengthSq);
      steering[0] *= scale;
      steering[1] *= scale;
      steering[2] *= scale;
    }
    let vx = pool.vx[index] + steering[0] * dt;
    let vy = pool.vy[index] + steering[1] * dt;
    let vz = pool.vz[index] + steering[2] * dt;
    const climb = io[IO.CLIMB] * (1 + excitement);
    vy = Math.min(Math.max(vy, -climb), climb);
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
    const top = io[IO.MAX_SPEED] * (1 + 0.5 * excitement);
    const clamped = Math.min(Math.max(speed, io[IO.MIN_SPEED]), top);
    if (clamped !== speed) {
      const scale = clamped / speed;
      vx *= scale;
      vy *= scale;
      vz *= scale;
    }
    const horizontal = Math.sqrt(vx * vx + vz * vz) || 1;
    lateral[0] = (steering[0] * -vz + steering[2] * vx) / horizontal;
    const targetBank = Math.min(Math.max(Math.atan2(lateral[0], GRAVITY), -1.1), 1.1);
    pool.bank[index] += (targetBank - pool.bank[index]) * io[IO.BANK_BLEND];
    pool.vx[index] = vx;
    pool.vy[index] = vy;
    pool.vz[index] = vz;
    pool.px[index] += vx * dt;
    pool.py[index] += vy * dt;
    pool.pz[index] += vz * dt;
    const floorY = io[IO.FLOOR];
    if (pool.py[index] < floorY) {
      pool.py[index] = floorY;
      if (pool.vy[index] < 1) pool.vy[index] = 1;
    }
  }

  /**
   * Flap phase and gate for a bird: flapping while excited or climbing, gliding in its glide share
   * io[GLIDE] (on the group clock io[TIME]).
   */
  function animateBird(pool, index, excitedGate) {
    const dt = frameStep[0];
    const time = io[IO.TIME];
    const glideShare = io[IO.GLIDE];
    const def = pool.def;
    const seed = pool.seed[index];
    const rate = def.flap.rate[0] + (def.flap.rate[1] - def.flap.rate[0]) * seed;
    const excitement = pool.excite[index];
    pool.phase[index] = (pool.phase[index] + TWO_PI * rate * (1 + 0.5 * excitement) * dt) % (TWO_PI * 64);
    const glideWave = Math.sin(time * (0.19 + 0.2 * seed) + seed * TWO_PI);
    const threshold = Math.cos(Math.PI * glideShare);
    let target = glideWave > threshold ? 0 : 1;
    if (pool.vy[index] > 1.8 || excitement > 0.2 || excitedGate) target = 1;
    pool.gate[index] += (target - pool.gate[index]) * Math.min(1, dt * 3);
  }

  /** Decays excitement toward calm by the factor io[DECAY]. */
  function calm(pool, index) {
    pool.excite[index] *= io[IO.DECAY];
    if (pool.excite[index] < 0.005) pool.excite[index] = 0;
  }

  // =============================================================================================
  // SCATTER FROM THE PLAYER
  // =============================================================================================
  const pathDirection = new Float64Array(3);

  /**
   * Agents within scatter.radius of the player burst away from its path (up and aside). Returns the
   * number of agents newly scattered.
   */
  function scatterFromPlayer(pool, data, start, end) {
    const scatter = data.params.scatter;
    if (!scatter) return 0;
    const g = data.g;
    const player = ctx.state.player;
    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    const scatterRadius = scatter.radius * threat[0];
    const reach = g[G.RADIUS] + scatterRadius;
    const toCenterX = g[G.CX] - px;
    const toCenterY = g[G.CY] - py;
    const toCenterZ = g[G.CZ] - pz;
    if (toCenterX * toCenterX + toCenterY * toCenterY + toCenterZ * toCenterZ > reach * reach) return 0;
    let directionX = player.velocity.x;
    let directionY = player.velocity.y;
    let directionZ = player.velocity.z;
    let directionLength = Math.sqrt(directionX * directionX + directionY * directionY + directionZ * directionZ);
    if (directionLength < 1) {
      directionX = player.forward.x;
      directionY = player.forward.y;
      directionZ = player.forward.z;
      directionLength = Math.sqrt(directionX * directionX + directionY * directionY + directionZ * directionZ) || 1;
    }
    pathDirection[0] = directionX / directionLength;
    pathDirection[1] = directionY / directionLength;
    pathDirection[2] = directionZ / directionLength;
    const radiusSq = scatterRadius * scatterRadius;
    const burstScale = Math.min(threat[0], 2);
    let fled = 0;
    for (let index = start; index < end; index++) {
      const dx = pool.px[index] - px;
      const dy = pool.py[index] - py;
      const dz = pool.pz[index] - pz;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > radiusSq || pool.excite[index] > 0.9) continue;
      const along = dx * pathDirection[0] + dy * pathDirection[1] + dz * pathDirection[2];
      let perpX = dx - pathDirection[0] * along;
      let perpY = dy - pathDirection[1] * along;
      let perpZ = dz - pathDirection[2] * along;
      let perpLength = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
      if (perpLength < 0.5) {
        const angle = pool.seed[index] * TWO_PI;
        perpX = Math.cos(angle) * -pathDirection[2];
        perpY = 0.5;
        perpZ = Math.cos(angle) * pathDirection[0];
        perpLength = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ) || 1;
      }
      const forwardShare = along >= 0 ? 0.3 : -0.15;
      let fleeX = perpX / perpLength + pathDirection[0] * forwardShare;
      let fleeY = perpY / perpLength + 0.7;
      let fleeZ = perpZ / perpLength + pathDirection[2] * forwardShare;
      const fleeLength = Math.sqrt(fleeX * fleeX + fleeY * fleeY + fleeZ * fleeZ) || 1;
      fleeX /= fleeLength;
      fleeY /= fleeLength;
      fleeZ /= fleeLength;
      pool.fleeX[index] = fleeX;
      pool.fleeY[index] = fleeY;
      pool.fleeZ[index] = fleeZ;
      const burst = scatter.burst * burstScale * (0.85 + 0.3 * pool.seed[index]);
      pool.vx[index] = pool.vx[index] * 0.3 + fleeX * burst;
      pool.vy[index] = pool.vy[index] * 0.3 + fleeY * burst * 0.6;
      pool.vz[index] = pool.vz[index] * 0.3 + fleeZ * burst;
      pool.excite[index] = 1;
      fled++;
    }
    if (fled > 0 && g[G.SCATTER_COOLDOWN] <= 0) {
      g[G.SCATTER_COOLDOWN] = scatter.cooldown;
      if (data.voice && scatter.trigger && quietSources.size === 0) data.voice.trigger(scatter.trigger);
      ctx.bus.emit('fauna:scatter', {
        id: data.instance.id, presetId: data.instance.presetId, species: pool.def.id, count: fled,
        position: { x: g[G.CX], y: g[G.CY], z: g[G.CZ] },
      });
    }
    return fled;
  }

  // =============================================================================================
  // BEHAVIOURS: GROUP MOTION (the goal) AND AGENT RULES
  // =============================================================================================
  /** Turns the group's heading toward io[TURN_TARGET] (radians) by at most io[TURN_STEP]. */
  function turnGroup(g) {
    let delta = io[IO.TURN_TARGET] - g[G.HEADING];
    delta -= TWO_PI * Math.floor((delta + Math.PI) / TWO_PI);
    g[G.HEADING] += Math.min(Math.max(delta, -io[IO.TURN_STEP]), io[IO.TURN_STEP]);
  }

  /** Wandering goal inside the leash around the anchor, at the altitude mode's height. */
  function moveWanderGoal(data, dt) {
    const g = data.g;
    const params = data.params;
    const time = g[G.TIME];
    const wander = Math.sin(time * 0.071 + data.phaseSeed * 13.7) * 0.11 + Math.sin(time * 0.023 + data.phaseSeed * 41.3) * 0.07;
    g[G.HEADING] += wander * params.wander * 10 * dt;
    // Past the leash, curve back toward the anchor.
    const awayX = g[G.X] - g[G.ANCHOR_X];
    const awayZ = g[G.Z] - g[G.ANCHOR_Z];
    const awaySq = awayX * awayX + awayZ * awayZ;
    if (awaySq > params.leash * params.leash) {
      io[IO.TURN_TARGET] = Math.atan2(-awayX, awayZ);
      io[IO.TURN_STEP] = 0.35 * dt;
      turnGroup(g);
    }
    g[G.VX] = Math.sin(g[G.HEADING]) * g[G.SPEED];
    g[G.VZ] = (-Math.cos(g[G.HEADING])) * g[G.SPEED];
    g[G.X] += g[G.VX] * dt;
    g[G.Z] += g[G.VZ] * dt;
    settleAltitude(data, dt);
  }

  /** Eases the goal's height toward the altitude mode's target over the ground. */
  function settleAltitude(data, dt) {
    const g = data.g;
    const altitude = data.params.altitude;
    groundUnderGoal(data);
    const ground = io[IO.GROUND];
    let target;
    if (altitude.mode === 'msl') target = altitude.value;
    else if (altitude.mode === 'water') target = waterIsFlat() ? ctx.terrain.waterLevel : waterSurface(g[G.X], g[G.Z]);
    else target = ground + altitude.value;
    if (altitude.mode !== 'water') target = Math.max(target, ground + data.params.floor + 10);
    const previous = g[G.Y];
    g[G.Y] += (target - g[G.Y]) * Math.min(1, dt * 0.35);
    g[G.VY] = dt > 0 ? (g[G.Y] - previous) / dt : 0;
  }

  // ---- murmuration -------------------------------------------------------------------------------
  function simulateMurmuration(data, dt, tier) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const shape = params.murmuration;
    const flocking = params.flocking;
    const start = data.start;
    const end = start + data.count;
    const time = g[G.TIME];
    const radius = shape.radius * g[G.SIZE];
    // The morphing shape: axes breathing between a ball and a sheet, a slow yaw, folds and a wave.
    const morph = TWO_PI / Math.max(1, shape.morphSeconds);
    const axisA = radius * (1 + 0.45 * Math.sin(time * morph + data.phaseSeed * 11));
    const axisB = radius * shape.flatten * (1 + 0.6 * Math.sin(time * morph * 0.63 + data.phaseSeed * 5));
    const axisC = radius * (0.8 + 0.35 * Math.sin(time * morph * 1.37 + data.phaseSeed * 3));
    const yaw = time * morph * 0.21 + data.phaseSeed * TWO_PI;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const fold = shape.fold * radius;
    const waveAmplitude = shape.wave * radius;
    const useGrid = data.count > BRUTE_FORCE_LIMIT;
    io[IO.INVERSE_CELL] = 1 / Math.max(flocking.neighborRadius, 1);
    io[IO.SPREAD] = params.scatter ? params.scatter.spread : 0;
    if (useGrid) buildGrid(pool, start, end);
    const maxNeighbors = tier === 'near' ? flocking.maxNeighbors : Math.min(4, flocking.maxNeighbors);
    const speedRange = data.speedRange;
    io[IO.DECAY] = Math.exp(-dt / Math.max(0.2, params.scatter ? params.scatter.recover : 3));
    io[IO.BANK_BLEND] = 1 - Math.exp(-3.5 * dt);
    io[IO.MIN_SPEED] = speedRange[0];
    io[IO.MAX_SPEED] = speedRange[1];
    io[IO.ACCEL] = 26;
    io[IO.CLIMB] = 8;
    io[IO.TIME] = time;
    io[IO.GLIDE] = pool.def.flap.glideShare;
    io[IO.BURST] = params.scatter ? params.scatter.burst : 0;
    io[IO.FEED_X] = g[G.VX];
    io[IO.FEED_Y] = 0;
    io[IO.FEED_Z] = g[G.VZ];
    io[IO.SEEK_MAX] = speedRange[1];
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const stride = useGrid ? NEIGHBOR_STRIDE[tier] : 1;
    const slice = data.neighborSlice = (data.neighborSlice + 1) % stride;
    for (let index = start; index < end; index++) {
      flockSteering(pool, index, start, end, flocking, useGrid, maxNeighbors, (index - start) % stride === slice);
      const homeX = pool.homeX[index] * axisA;
      const homeY = pool.homeY[index] * axisB;
      const homeZ = pool.homeZ[index] * axisC;
      const localX = homeX * cosYaw - homeZ * sinYaw;
      const localZ = homeX * sinYaw + homeZ * cosYaw;
      const bend = Math.sin((localX / radius) * Math.PI + time * morph * 1.9) * fold;
      const pulse = Math.sin((localZ / radius) * 2.4 - time * 1.3) * waveAmplitude;
      io[IO.TARGET_X] = g[G.X] + localX + pulse * 0.4;
      io[IO.TARGET_Y] = g[G.Y] + homeY + bend;
      io[IO.TARGET_Z] = g[G.Z] + localZ;
      const seek = shape.seek * (1 - 0.85 * pool.excite[index]);
      io[IO.GAIN] = seek;
      io[IO.WEIGHT] = 1.6 * seek;
      steerToward(pool, index);
      steerFlee(pool, index);
      groundUnder(data, pool, index);
      io[IO.CUSHION] = io[IO.GROUND] + params.floor;
      steerAboveFloor(pool, index);
      io[IO.FLOOR] = io[IO.GROUND] + params.floor * 0.5;
      integrate(pool, index);
      animateBird(pool, index, false);
      calm(pool, index);
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  // ---- flock (v1-style) -------------------------------------------------------------------------
  function simulateFlock(data, dt, tier) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const flocking = params.flocking;
    const start = data.start;
    const end = start + data.count;
    const useGrid = data.count > BRUTE_FORCE_LIMIT;
    io[IO.INVERSE_CELL] = 1 / Math.max(flocking.neighborRadius, 1);
    io[IO.SPREAD] = params.scatter ? params.scatter.spread : 0;
    if (useGrid) buildGrid(pool, start, end);
    const maxNeighbors = tier === 'near' ? flocking.maxNeighbors : Math.min(4, flocking.maxNeighbors);
    const speedRange = data.speedRange;
    io[IO.DECAY] = Math.exp(-dt / Math.max(0.2, params.scatter ? params.scatter.recover : 3));
    io[IO.BANK_BLEND] = 1 - Math.exp(-3.5 * dt);
    io[IO.MIN_SPEED] = speedRange[0];
    io[IO.MAX_SPEED] = speedRange[1];
    io[IO.ACCEL] = 12;
    io[IO.CLIMB] = 4.5;
    io[IO.TIME] = g[G.TIME];
    io[IO.GLIDE] = pool.def.flap.glideShare;
    io[IO.BURST] = params.scatter ? params.scatter.burst * 0.75 : 0;
    // The flock seeks a point ahead of the wandering goal.
    io[IO.TARGET_X] = g[G.X] + Math.sin(g[G.HEADING]) * 60;
    io[IO.TARGET_Y] = g[G.Y];
    io[IO.TARGET_Z] = g[G.Z] - Math.cos(g[G.HEADING]) * 60;
    io[IO.FEED_X] = 0;
    io[IO.FEED_Y] = 0;
    io[IO.FEED_Z] = 0;
    io[IO.GAIN] = 0.25;
    io[IO.SEEK_MAX] = g[G.SPEED];
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const stride = useGrid ? NEIGHBOR_STRIDE[tier] : 1;
    const slice = data.neighborSlice = (data.neighborSlice + 1) % stride;
    for (let index = start; index < end; index++) {
      flockSteering(pool, index, start, end, flocking, useGrid, maxNeighbors, (index - start) % stride === slice);
      const calmShare = 1 - 0.85 * pool.excite[index];
      io[IO.WEIGHT] = 0.55 * calmShare;
      steerToward(pool, index);
      // A loose pull to the centre keeps stragglers in.
      steering[0] += (g[G.CX] - pool.px[index]) * 0.012 * calmShare;
      steering[1] += (g[G.CY] - pool.py[index]) * 0.012 * calmShare;
      steering[2] += (g[G.CZ] - pool.pz[index]) * 0.012 * calmShare;
      steerFlee(pool, index);
      groundUnder(data, pool, index);
      io[IO.CUSHION] = io[IO.GROUND] + params.floor;
      io[IO.FLOOR] = io[IO.CUSHION];
      steerAboveFloor(pool, index);
      integrate(pool, index);
      animateBird(pool, index, false);
      calm(pool, index);
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  // ---- formation --------------------------------------------------------------------------------
  /** Writes the local slot offset (back, right, up in metres) of slot k into steering[0..2] (io[SIZE_SCALE]). */
  function slotOffset(formation, k) {
    const sizeScale = io[IO.SIZE_SCALE];
    if (k === 0) {
      steering[0] = 0;
      steering[1] = 0;
      steering[2] = 0;
      return;
    }
    const rank = formation.shape === 'echelon' ? k : Math.ceil(k / 2);
    const side = formation.shape === 'echelon' ? 1 : (k % 2 === 1 ? -1 : 1);
    const spacing = formation.spacing * sizeScale;
    const angle = formation.angle * DEG;
    steering[0] = rank * spacing * Math.cos(angle);
    steering[1] = side * rank * spacing * Math.sin(angle);
    steering[2] = rank * formation.rise * sizeScale;
  }

  function moveFormationGoal(data, dt) {
    const g = data.g;
    const params = data.params;
    const formation = params.formation;
    const player = ctx.state.player;
    const offsetX = player.position.x - g[G.X];
    const offsetY = player.position.y - g[G.Y];
    const offsetZ = player.position.z - g[G.Z];
    const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
    g[G.PLAYER_DISTANCE] = distance;
    const playerHeading = player.heading * DEG;
    let gap = playerHeading - g[G.HEADING];
    gap -= TWO_PI * Math.floor((gap + Math.PI) / TWO_PI);
    const following = formation.followPlayer && distance < formation.followRadius && Math.abs(gap) < formation.maxHeadingGap * DEG;
    if (following) {
      // Gentle turns only: the flock turns toward the player's heading at followTurnRate.
      io[IO.TURN_TARGET] = playerHeading;
      io[IO.TURN_STEP] = formation.followTurnRate * DEG * dt;
      turnGroup(g);
      const groundSpeed = Math.sqrt(player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z);
      g[G.TARGET_SPEED] = Math.min(Math.max(groundSpeed, data.speedRange[0]), data.speedRange[1]);
    } else {
      const time = g[G.TIME];
      g[G.HEADING] += (Math.sin(time * 0.05 + data.phaseSeed * 9) * 0.5) * params.wander * dt;
      g[G.TARGET_SPEED] = data.cruise;
    }
    const awayX = g[G.X] - g[G.ANCHOR_X];
    const awayZ = g[G.Z] - g[G.ANCHOR_Z];
    if (!following && awayX * awayX + awayZ * awayZ > params.leash * params.leash * 16) {
      io[IO.TURN_TARGET] = Math.atan2(-awayX, awayZ);
      io[IO.TURN_STEP] = 0.2 * dt;
      turnGroup(g);
    }
    // Matching the player's speed is quick while following (so the slot can be held), slow otherwise.
    g[G.SPEED] += (g[G.TARGET_SPEED] - g[G.SPEED]) * Math.min(1, dt * (following ? 1.5 : 0.4));
    g[G.VX] = Math.sin(g[G.HEADING]) * g[G.SPEED];
    g[G.VZ] = (-Math.cos(g[G.HEADING])) * g[G.SPEED];
    g[G.X] += g[G.VX] * dt;
    g[G.Z] += g[G.VZ] * dt;
    settleAltitude(data, dt);
  }

  function simulateFormation(data, dt) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const formation = params.formation;
    const start = data.start;
    const end = start + data.count;
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = -Math.cos(g[G.HEADING]);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    io[IO.SIZE_SCALE] = g[G.SIZE];
    const speedRange = data.speedRange;
    io[IO.DECAY] = Math.exp(-dt / Math.max(0.2, params.scatter ? params.scatter.recover : 3));
    io[IO.BANK_BLEND] = 1 - Math.exp(-3 * dt);
    io[IO.MIN_SPEED] = speedRange[0] * 0.8;
    io[IO.MAX_SPEED] = speedRange[1];
    io[IO.ACCEL] = 10;
    io[IO.CLIMB] = 5;
    io[IO.BURST] = params.scatter ? params.scatter.burst : 0;
    io[IO.FEED_X] = g[G.VX];
    io[IO.FEED_Y] = g[G.VY];
    io[IO.FEED_Z] = g[G.VZ];
    io[IO.GAIN] = 0.9;
    io[IO.SEEK_MAX] = speedRange[1];
    g[G.FLAP] = (g[G.FLAP] + TWO_PI * (pool.def.flap.rate[0] + pool.def.flap.rate[1]) * 0.5 * dt) % (TWO_PI * 64);
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      const k = index - start;
      slotOffset(formation, k);
      const back = steering[0];
      const across = steering[1];
      const up = steering[2];
      io[IO.TARGET_X] = g[G.X] - forwardX * back + rightX * across;
      io[IO.TARGET_Y] = g[G.Y] + up;
      io[IO.TARGET_Z] = g[G.Z] - forwardZ * back + rightZ * across;
      steering[0] = 0;
      steering[1] = 0;
      steering[2] = 0;
      const calmShare = 1 - pool.excite[index];
      io[IO.WEIGHT] = 2.2 * calmShare + 0.2;
      steerToward(pool, index);
      steerFlee(pool, index);
      groundUnder(data, pool, index);
      io[IO.CUSHION] = io[IO.GROUND] + params.floor;
      io[IO.FLOOR] = io[IO.CUSHION];
      steerAboveFloor(pool, index);
      integrate(pool, index);
      // The wingbeat runs down each leg of the V as a wave.
      const rank = formation.shape === 'echelon' ? k : Math.ceil(k / 2);
      pool.phase[index] = g[G.FLAP] - rank * 0.55 + pool.excite[index] * pool.seed[index] * 3;
      pool.gate[index] = 1;
      calm(pool, index);
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    io[IO.FORWARD_X] = forwardX;
    io[IO.FORWARD_Z] = forwardZ;
    io[IO.RIGHT_X] = rightX;
    io[IO.RIGHT_Z] = rightZ;
    trackPlayerSlot(data, dt);
  }

  /**
   * The player's slot: beyond the last bird of the shorter leg, playerSpacing further out (the group's
   * axes in io[FORWARD_*] and io[RIGHT_*]).
   */
  function trackPlayerSlot(data, dt) {
    const forwardX = io[IO.FORWARD_X];
    const forwardZ = io[IO.FORWARD_Z];
    const rightX = io[IO.RIGHT_X];
    const rightZ = io[IO.RIGHT_Z];
    const g = data.g;
    const formation = data.params.formation;
    const sizeScale = g[G.SIZE];
    const followers = data.count - 1;
    let side;
    let rank;
    if (formation.shape === 'echelon') {
      side = 1;
      rank = followers;
    } else {
      const left = Math.ceil(followers / 2);
      const right = Math.floor(followers / 2);
      side = right < left ? 1 : -1;
      rank = side === 1 ? right : left;
    }
    const angle = formation.angle * DEG;
    const along = rank * formation.spacing * sizeScale + formation.playerSpacing;
    const back = along * Math.cos(angle);
    const across = side * along * Math.sin(angle);
    g[G.SLOT_X] = g[G.X] - forwardX * back + rightX * across;
    g[G.SLOT_Y] = g[G.Y] + (rank + 1) * formation.rise * sizeScale;
    g[G.SLOT_Z] = g[G.Z] - forwardZ * back + rightZ * across;
    const player = ctx.state.player;
    const dx = player.position.x - g[G.SLOT_X];
    const dy = player.position.y - g[G.SLOT_Y];
    const dz = player.position.z - g[G.SLOT_Z];
    const horizontal = Math.sqrt(dx * dx + dz * dz);
    let gap = player.heading * DEG - g[G.HEADING];
    gap -= TWO_PI * Math.floor((gap + Math.PI) / TWO_PI);
    const state = data.formationState;
    g[G.SLOT_DISTANCE] = Math.sqrt(horizontal * horizontal + dy * dy);
    const inside = horizontal < formation.tolerance && Math.abs(dy) < formation.heightTolerance && Math.abs(gap) < formation.headingTolerance * DEG;
    if (inside) {
      g[G.GRACE] = 0.6;
      if (!state.inSlot) {
        state.inSlot = true;
        emitFormation(data, 'enter');
      }
      g[G.HOLD] += dt;
    } else if (state.inSlot) {
      g[G.GRACE] -= dt;
      if (g[G.GRACE] <= 0) {
        state.inSlot = false;
        emitFormation(data, 'leave');
        g[G.HOLD] = 0;
      }
    }
    if (g[G.HOLD] > g[G.HOLD_BEST]) g[G.HOLD_BEST] = g[G.HOLD];
    if (!state.complete && g[G.HOLD] >= formation.holdSeconds) {
      state.complete = true;
      emitFormation(data, 'complete');
      if (formation.achievement) emitAchievement(data.preset, formation.achievement);
    }
  }

  /**
   * Emits the typed achievement event with the title from the preset's achievements list. A separate
   * function with a plain loop: a closure inside trackPlayerSlot would make V8 allocate a context on
   * every frame's call.
   */
  function emitAchievement(preset, id) {
    let title = id;
    const list = Array.isArray(preset.achievements) ? preset.achievements : [];
    for (let index = 0; index < list.length; index++) if (list[index] && list[index].id === id) title = list[index].title;
    ctx.bus.emitTyped('achievement', { id, title });
  }

  /**
   * The formation-slot API object of a group: its numbers read the group doubles through accessors, so
   * the frame update never writes a double into an object (V8 would box it).
   */
  function createFormationState(g, holdTarget) {
    return {
      inSlot: false,
      complete: false,
      holdTarget,
      get holdSeconds() { return g[G.HOLD]; },
      get bestHoldSeconds() { return g[G.HOLD_BEST]; },
      get distance() { return g[G.SLOT_DISTANCE]; },
      slot: {
        get x() { return g[G.SLOT_X]; },
        get y() { return g[G.SLOT_Y]; },
        get z() { return g[G.SLOT_Z]; },
      },
    };
  }

  function emitFormation(data, change) {
    const state = data.formationState;
    ctx.bus.emit('fauna:formation', {
      id: data.instance.id, presetId: data.instance.presetId, state: change,
      seconds: Math.round(state.holdSeconds * 10) / 10, slot: { x: state.slot.x, y: state.slot.y, z: state.slot.z },
    });
  }

  // ---- circling ----------------------------------------------------------------------------------
  /** The WindField visitor writes thermals into the group's typed arrays (it runs in the refresh). */
  function createThermalVisitor(data) {
    return (thermal) => {
      const cache = data.thermals;
      if (cache.count >= cache.x.length || thermal.strength <= 0.3) return;
      const slot = cache.count++;
      cache.x[slot] = thermal.x;
      cache.z[slot] = thermal.z;
      cache.capX[slot] = thermal.capX;
      cache.capZ[slot] = thermal.capZ;
      cache.ground[slot] = thermal.ground;
      cache.top[slot] = thermal.top;
      cache.radius[slot] = thermal.radius;
      cache.strength[slot] = thermal.strength;
    };
  }

  /** Insertion sort of the cached thermals by distance to (x, z) (at most 8; no allocation). */
  function sortThermals(cache, x, z) {
    for (let index = 1; index < cache.count; index++) {
      for (let slot = index; slot > 0; slot--) {
        const previousDx = cache.x[slot - 1] - x;
        const previousDz = cache.z[slot - 1] - z;
        const currentDx = cache.x[slot] - x;
        const currentDz = cache.z[slot] - z;
        if (previousDx * previousDx + previousDz * previousDz <= currentDx * currentDx + currentDz * currentDz) break;
        for (let key = 0; key < THERMAL_FIELDS.length; key++) {
          const values = cache[THERMAL_FIELDS[key]];
          const swap = values[slot];
          values[slot] = values[slot - 1];
          values[slot - 1] = swap;
        }
      }
    }
  }

  function refreshThermals(data) {
    const cache = data.thermals;
    const g = data.g;
    const circling = data.params.circling;
    const previousCount = cache.count;
    cache.count = 0;
    if (circling.useThermals && ctx.wind && typeof ctx.wind.thermalsNear === 'function') {
      ctx.wind.thermalsNear(g[G.ANCHOR_X], g[G.ANCHOR_Z], circling.thermalSearch, data.thermalVisitor);
      // Keep the nearest few to the anchor: the group circles together, not across the region.
      sortThermals(cache, g[G.ANCHOR_X], g[G.ANCHOR_Z]);
      if (cache.count > circling.thermals) cache.count = Math.max(1, circling.thermals);
    }
    if (cache.count === 0 && circling.requireThermal && circling.useThermals) {
      // The birds mark real lift only: with no working thermal they keep the columns they had (the
      // visitor wrote nothing over them) and ride them out. A group that never found one ends (see
      // create); the soaring fallback below only keeps its arrays valid until then.
      if (previousCount > 0) {
        cache.count = previousCount;
        return;
      }
      data.noThermal = true;
    }
    if (cache.count === 0) {
      // No working thermal: soar over the anchor.
      cache.x[0] = g[G.ANCHOR_X];
      cache.z[0] = g[G.ANCHOR_Z];
      cache.capX[0] = g[G.ANCHOR_X];
      cache.capZ[0] = g[G.ANCHOR_Z];
      cache.ground[0] = g[G.ANCHOR_Y];
      cache.top[0] = g[G.ANCHOR_Y] + circling.top;
      cache.radius[0] = 90;
      cache.strength[0] = 0;
      cache.count = 1;
    }
  }

  function simulateCircling(data, dt) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const circling = params.circling;
    const cache = data.thermals;
    const start = data.start;
    const end = start + data.count;
    const speedRange = data.speedRange;
    io[IO.DECAY] = Math.exp(-dt / Math.max(0.2, params.scatter ? params.scatter.recover : 3));
    io[IO.BANK_BLEND] = 1 - Math.exp(-2.5 * dt);
    io[IO.MIN_SPEED] = speedRange[0];
    io[IO.MAX_SPEED] = speedRange[1];
    io[IO.ACCEL] = 7;
    io[IO.CLIMB] = 3.5;
    io[IO.TIME] = g[G.TIME];
    io[IO.BURST] = params.scatter ? params.scatter.burst * 0.6 : 0;
    io[IO.FEED_X] = 0;
    io[IO.FEED_Z] = 0;
    g[G.THERMAL_TIMER] -= dt;
    if (g[G.THERMAL_TIMER] <= 0) {
      g[G.THERMAL_TIMER] = circling.thermalRefresh;
      refreshThermals(data);
    }
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      let thermal = Math.floor(pool.aux2[index]) % cache.count;
      if (thermal < 0) thermal = 0;
      const ground = cache.ground[thermal];
      const top = Math.max(ground + circling.bottom + 60, Math.min(cache.top[thermal], ground + circling.top));
      const bottom = ground + circling.bottom;
      const share = Math.min(Math.max((pool.py[index] - ground) / Math.max(1, cache.top[thermal] - ground), 0), 1);
      const centerX = cache.x[thermal] + (cache.capX[thermal] - cache.x[thermal]) * share;
      const centerZ = cache.z[thermal] + (cache.capZ[thermal] - cache.z[thermal]) * share;
      const radius = pool.homeX[index];
      const direction = pool.homeY[index];
      const toX = pool.px[index] - centerX;
      const toZ = pool.pz[index] - centerZ;
      const distance = Math.sqrt(toX * toX + toZ * toZ);
      steering[0] = 0;
      steering[1] = 0;
      steering[2] = 0;
      if (pool.mode[index] === 1) {
        // Gliding over to the thermal: straight at it, sinking gently.
        io[IO.TARGET_X] = centerX;
        io[IO.TARGET_Y] = Math.max(bottom, pool.py[index] - 40);
        io[IO.TARGET_Z] = centerZ;
        io[IO.FEED_Y] = 0;
        io[IO.GAIN] = 0.05;
        io[IO.SEEK_MAX] = data.cruise * 1.2;
        io[IO.WEIGHT] = 1.2;
        steerToward(pool, index);
        if (distance < radius * 1.6) pool.mode[index] = 0;
      } else {
        // Circle: aim a little ahead on the circle, climbing with the thermal's strength.
        const angle = Math.atan2(toZ, toX) + direction * 0.5;
        const climb = circling.climb * (cache.strength[thermal] > 0 ? Math.min(1.6, 0.4 + cache.strength[thermal] * 0.35) : 0.35);
        io[IO.TARGET_X] = centerX + Math.cos(angle) * radius;
        io[IO.TARGET_Y] = pool.py[index] + climb * 4;
        io[IO.TARGET_Z] = centerZ + Math.sin(angle) * radius;
        io[IO.FEED_Y] = climb;
        io[IO.GAIN] = 0.35;
        io[IO.SEEK_MAX] = data.cruise;
        io[IO.WEIGHT] = 1.5;
        steerToward(pool, index);
        if (pool.py[index] > top - 20) {
          // Top of the column: glide on to the next thermal, or spiral down and start over.
          if (cache.count > 1) {
            pool.aux2[index] = (thermal + 1 + Math.floor(pool.seed[index] * (cache.count - 1))) % cache.count;
            pool.mode[index] = 1;
          } else {
            pool.py[index] = Math.min(pool.py[index], top - 20);
            pool.vy[index] = -1.2;
          }
        }
      }
      steerFlee(pool, index);
      groundUnder(data, pool, index);
      io[IO.CUSHION] = Math.max(bottom * 0.5 + ground * 0.5, io[IO.GROUND] + params.floor);
      io[IO.FLOOR] = io[IO.CUSHION];
      steerAboveFloor(pool, index);
      integrate(pool, index);
      io[IO.GLIDE] = pool.mode[index] === 1 ? 0.97 : pool.def.flap.glideShare;
      animateBird(pool, index, false);
      calm(pool, index);
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    g[G.X] = g[G.CX];
    g[G.Y] = g[G.CY];
    g[G.Z] = g[G.CZ];
  }

  // ---- pod (whales) --------------------------------------------------------------------------------
  function movePodGoal(data) {
    const dt = frameStep[0];
    const g = data.g;
    const params = data.params;
    const time = g[G.TIME];
    g[G.HEADING] += Math.sin(time * 0.031 + data.phaseSeed * 7) * params.wander * 0.4 * dt;
    // Keep to open water: look 350 m ahead now and then; land ahead turns the pod.
    g[G.TERRAIN_TIMER] -= dt;
    if (g[G.TERRAIN_TIMER] <= 0) {
      g[G.TERRAIN_TIMER] = 2;
      const aheadX = g[G.X] + Math.sin(g[G.HEADING]) * 350;
      const aheadZ = g[G.Z] - Math.cos(g[G.HEADING]) * 350;
      if (ctx.terrain.heightAt(aheadX, aheadZ) > ctx.terrain.waterLevel - 6) g[G.SIDE] = 1;
      else g[G.SIDE] = 0;
    }
    if (g[G.SIDE] > 0) g[G.HEADING] += 0.35 * dt;
    g[G.VX] = Math.sin(g[G.HEADING]) * g[G.SPEED];
    g[G.VZ] = (-Math.cos(g[G.HEADING])) * g[G.SPEED];
    g[G.X] += g[G.VX] * dt;
    g[G.Z] += g[G.VZ] * dt;
    g[G.Y] = waterIsFlat() ? ctx.terrain.waterLevel : waterSurface(g[G.X], g[G.Z]);
  }

  /**
   * An event's natural end: the group fades out over the last fadeOut seconds of its duration and
   * ends with it, instead of vanishing when the manager's grace runs out. A wingman only ends this way
   * while it is still waiting (a joined eagle finishes its escort and peels off).
   */
  function endWithDuration(instance, data) {
    const g = data.g;
    const left = data.duration - g[G.AGE];
    const fadeOut = data.params.fadeOut;
    if (left < fadeOut) g[G.FADE] = Math.min(g[G.FADE], fadeOut > 0 ? Math.max(left / fadeOut, 0) : 0);
    if (left <= 0) instance.ended = true;
  }

  function nextWhaleTimer(data, range) {
    return range[0] + data.rng() * (range[1] - range[0]);
  }

  function simulatePod(data, dt) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const pod = params.pod;
    const start = data.start;
    const end = start + data.count;
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = -Math.cos(g[G.HEADING]);
    const water = ctx.water;
    const bankBlend = 1 - Math.exp(-1.5 * dt);
    const scaleBase = g[G.SIZE];
    const flat = waterIsFlat();
    const seaLevel = ctx.terrain.waterLevel;
    io[IO.FEED_X] = g[G.VX];
    io[IO.FEED_Y] = 0;
    io[IO.FEED_Z] = g[G.VZ];
    io[IO.GAIN] = 0.08;
    io[IO.WEIGHT] = 0.6;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      const scale = pool.scale[index] * scaleBase;
      const girth = pool.def.size * 0.125 * scale;
      // Horizontal: each whale keeps its lane in the pod's frame.
      const laneX = g[G.X] + forwardX * pool.homeZ[index] - forwardZ * pool.homeX[index];
      const laneZ = g[G.Z] + forwardZ * pool.homeZ[index] + forwardX * pool.homeX[index];
      const surfaceY = flat ? seaLevel : waterSurface(pool.px[index], pool.pz[index]);
      let mode = pool.mode[index];
      pool.timer[index] -= dt;
      if (mode === WHALE_BREACH) {
        // Ballistic: up out of the water, rolling, and back down with a splash.
        pool.vy[index] -= GRAVITY * dt;
        pool.px[index] += pool.vx[index] * dt;
        pool.py[index] += pool.vy[index] * dt;
        pool.pz[index] += pool.vz[index] * dt;
        pool.bank[index] += 1.4 * dt;
        if (pool.vy[index] < 0 && pool.py[index] < surfaceY - girth * 0.4) {
          if (water) {
            const mark = data.waterMark;
            mark.x = pool.px[index];
            mark.z = pool.pz[index];
            mark.strength = Math.min(1, 0.55 + scale * 0.03);
            mark.glow = pod.glow;
            water.splashMark(mark);
          }
          pool.mode[index] = WHALE_DEEP;
          pool.timer[index] = 3;
          pool.vy[index] = -2;
        }
      } else {
        let targetY;
        let speedShare = 1;
        if (mode === WHALE_SURFACE) {
          targetY = surfaceY - girth * 0.55;
          if (pool.timer[index] <= 0) {
            pool.mode[index] = WHALE_DIVE;
            pool.timer[index] = 5;
          }
          // Spouts while at the surface.
          pool.aux[index] -= dt;
          if (pool.aux[index] <= 0 && pool.py[index] > surfaceY - girth * 1.2) {
            pool.aux[index] = pod.spoutInterval[0] + data.rng() * (pod.spoutInterval[1] - pod.spoutInterval[0]);
            if (water) {
              // The spout, from the blowhole a quarter of the body ahead of centre (inline: this hot
              // loop runs optimised, a separate rarely called function would not).
              const spray = data.spout;
              const speed = Math.sqrt(pool.vx[index] * pool.vx[index] + pool.vz[index] * pool.vz[index]) || 1;
              const ahead = pool.def.size * 0.28 * scale;
              spray.x = pool.px[index] + (pool.vx[index] / speed) * ahead;
              spray.z = pool.pz[index] + (pool.vz[index] / speed) * ahead;
              spray.y = Math.max(surfaceY + 0.5, pool.py[index] + pool.def.size * 0.11 * scale);
              spray.count = 70;
              spray.speed = pod.spoutHeight * 1.5;
              spray.inheritX = pool.vx[index];
              spray.inheritZ = pool.vz[index];
              water.emitSpray(spray);
            }
          }
        } else if (mode === WHALE_DIVE) {
          targetY = surfaceY - pod.depth * scale;
          speedShare = 1.2;
          if (pool.timer[index] <= 0) {
            pool.mode[index] = WHALE_DEEP;
            pool.timer[index] = nextWhaleTimer(data, pod.diveSeconds);
          }
        } else {
          targetY = surfaceY - pod.depth * scale;
          if (pool.timer[index] <= 0) {
            if (data.rng() < pod.breachChance) {
              // Breach: launch from below at 11-13 m/s, steeply pitched: two thirds of the body clear.
              pool.mode[index] = WHALE_BREACH;
              pool.py[index] = surfaceY - girth * 2;
              pool.vy[index] = (11.5 + 1.5 * pool.seed[index]) * Math.sqrt(scale);
              pool.vx[index] = forwardX * 2.5;
              pool.vz[index] = forwardZ * 2.5;
              pool.bank[index] = 0;
              if (data.voice && quietSources.size === 0) data.voice.trigger('call');
              mode = WHALE_BREACH;
            } else {
              pool.mode[index] = WHALE_SURFACE;
              pool.timer[index] = nextWhaleTimer(data, pod.surfaceSeconds);
              pool.aux[index] = 0.8;
            }
          }
        }
        if (mode !== WHALE_BREACH) {
          steering[0] = 0;
          steering[1] = 0;
          steering[2] = 0;
          io[IO.TARGET_X] = laneX;
          io[IO.TARGET_Y] = pool.py[index];
          io[IO.TARGET_Z] = laneZ;
          io[IO.SEEK_MAX] = data.speedRange[1] * speedShare;
          steerToward(pool, index);
          const vx = pool.vx[index] + steering[0] * dt;
          const vz = pool.vz[index] + steering[2] * dt;
          const speed = Math.sqrt(vx * vx + vz * vz) || 1;
          const clamped = Math.min(Math.max(speed, data.speedRange[0]), data.speedRange[1] * speedShare);
          pool.vx[index] = (vx / speed) * clamped;
          pool.vz[index] = (vz / speed) * clamped;
          // Vertical: eased toward the mode's depth (the pitch follows from it).
          pool.vy[index] += ((targetY - pool.py[index]) * 0.5 - pool.vy[index]) * Math.min(1, dt * 1.2);
          pool.px[index] += pool.vx[index] * dt;
          pool.py[index] += pool.vy[index] * dt;
          pool.pz[index] += pool.vz[index] * dt;
          pool.bank[index] += (0 - pool.bank[index]) * bankBlend;
        }
      }
      // Wakes where the back breaks the surface (glowing in a bioluminescent bay).
      if (water && pool.mode[index] !== WHALE_BREACH && pool.py[index] > surfaceY - girth * 1.3) {
        pool.aux2[index] -= dt;
        if (pool.aux2[index] <= 0) {
          pool.aux2[index] = 0.3;
          const mark = data.waterMark;
          mark.x = pool.px[index] - pool.vx[index] * 1.2;
          mark.z = pool.pz[index] - pool.vz[index] * 1.2;
          mark.x1 = pool.px[index];
          mark.z1 = pool.pz[index];
          mark.radius = girth * 1.6;
          mark.foam = pod.wake * 0.7;
          mark.glow = pod.glow;
          water.trail(mark);
        }
      }
      const seed = pool.seed[index];
      const rate = pool.def.body.rate[0] + (pool.def.body.rate[1] - pool.def.body.rate[0]) * seed;
      pool.phase[index] = (pool.phase[index] + TWO_PI * rate * (pool.mode[index] === WHALE_DIVE ? 1.6 : 1) * dt) % (TWO_PI * 64);
      pool.gate[index] = 1;
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  // ---- wingman ------------------------------------------------------------------------------------
  function simulateWingman(instance, data, dt) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const wingman = params.wingman;
    const player = ctx.state.player;
    const start = data.start;
    const end = start + data.count;
    io[IO.BANK_BLEND] = 1 - Math.exp(-2.5 * dt);
    io[IO.DECAY] = Math.exp(-dt / 3);
    io[IO.TIME] = g[G.TIME];
    const lead = start;
    const dxLead = player.position.x - pool.px[lead];
    const dyLead = player.position.y - pool.py[lead];
    const dzLead = player.position.z - pool.pz[lead];
    const distance = Math.sqrt(dxLead * dxLead + dyLead * dyLead + dzLead * dzLead);
    g[G.PLAYER_DISTANCE] = distance;
    let mode = data.mode;
    if (mode === MODE_WAIT && distance < wingman.joinRadius) {
      mode = MODE_JOIN;
      if (g[G.SIDE] === 0) {
        const right = player.right;
        g[G.SIDE] = (pool.px[lead] - player.position.x) * right.x + (pool.pz[lead] - player.position.z) * right.z >= 0 ? 1 : -1;
      }
    }
    // The wing slot, from the craft's own axes.
    const side = g[G.SIDE] === 0 ? 1 : g[G.SIDE];
    const slotX = player.position.x + player.right.x * side * wingman.right + player.forward.x * wingman.forward + player.up.x * wingman.up;
    const slotY = player.position.y + player.right.y * side * wingman.right + player.forward.y * wingman.forward + player.up.y * wingman.up;
    const slotZ = player.position.z + player.right.z * side * wingman.right + player.forward.z * wingman.forward + player.up.z * wingman.up;
    const slotDx = slotX - pool.px[lead];
    const slotDy = slotY - pool.py[lead];
    const slotDz = slotZ - pool.pz[lead];
    const slotDistance = Math.sqrt(slotDx * slotDx + slotDy * slotDy + slotDz * slotDz);
    if (mode === MODE_JOIN && slotDistance < 45) {
      mode = MODE_ESCORT;
      g[G.MODE_TIMER] = 0;
      emitCall(data, 'join');
    }
    if (mode === MODE_ESCORT) {
      g[G.MODE_TIMER] += dt;
      g[G.LOST] = slotDistance > wingman.lostDistance ? g[G.LOST] + dt : 0;
      if (g[G.MODE_TIMER] >= wingman.escortSeconds || g[G.LOST] > wingman.lostSeconds) {
        mode = MODE_PEEL;
        g[G.MODE_TIMER] = 0;
        emitCall(data, 'peel');
      }
    } else if (mode === MODE_PEEL) {
      g[G.MODE_TIMER] += dt;
      if (g[G.MODE_TIMER] >= wingman.peelSeconds && instance.data.duration !== null) instance.ended = true;
    }
    data.mode = mode;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const speedRange = data.speedRange;
    io[IO.MIN_SPEED] = speedRange[0];
    io[IO.MAX_SPEED] = speedRange[1];
    io[IO.ACCEL] = 14;
    io[IO.CLIMB] = 12;
    io[IO.GLIDE] = mode === MODE_ESCORT ? 0.6 : pool.def.flap.glideShare;
    for (let index = start; index < end; index++) {
      steering[0] = 0;
      steering[1] = 0;
      steering[2] = 0;
      const offset = (index - start) * 9;
      if (mode === MODE_WAIT) {
        // Circling over the anchor, waiting for the player.
        const toX = pool.px[index] - g[G.ANCHOR_X];
        const toZ = pool.pz[index] - g[G.ANCHOR_Z];
        const angle = Math.atan2(toZ, toX) + 0.5;
        const radius = wingman.waitRadius + offset;
        io[IO.TARGET_X] = g[G.ANCHOR_X] + Math.cos(angle) * radius;
        io[IO.TARGET_Y] = g[G.BASE_Y];
        io[IO.TARGET_Z] = g[G.ANCHOR_Z] + Math.sin(angle) * radius;
        io[IO.FEED_X] = 0;
        io[IO.FEED_Y] = 0;
        io[IO.FEED_Z] = 0;
        io[IO.GAIN] = 0.3;
        io[IO.SEEK_MAX] = data.cruise;
        io[IO.WEIGHT] = 1.4;
        steerToward(pool, index);
      } else if (mode === MODE_JOIN || mode === MODE_ESCORT) {
        // Match the craft's velocity within the speed limits, closing on the slot.
        io[IO.TARGET_X] = slotX + player.right.x * side * offset;
        io[IO.TARGET_Y] = slotY;
        io[IO.TARGET_Z] = slotZ + player.right.z * side * offset;
        io[IO.FEED_X] = player.velocity.x;
        io[IO.FEED_Y] = player.velocity.y;
        io[IO.FEED_Z] = player.velocity.z;
        io[IO.GAIN] = mode === MODE_JOIN ? 0.5 : 0.8;
        io[IO.SEEK_MAX] = speedRange[1];
        io[IO.WEIGHT] = 2.2;
        steerToward(pool, index);
      } else {
        // Peel off: a climbing turn away from the player's side.
        const awayX = player.right.x * side * 200 + player.forward.x * 120;
        const awayZ = player.right.z * side * 200 + player.forward.z * 120;
        io[IO.TARGET_X] = pool.px[index] + awayX;
        io[IO.TARGET_Y] = pool.py[index] + 60;
        io[IO.TARGET_Z] = pool.pz[index] + awayZ;
        io[IO.FEED_X] = 0;
        io[IO.FEED_Y] = 0;
        io[IO.FEED_Z] = 0;
        io[IO.GAIN] = 0.1;
        io[IO.SEEK_MAX] = data.cruise * 1.3;
        io[IO.WEIGHT] = 1.1;
        steerToward(pool, index);
      }
      groundUnder(data, pool, index);
      io[IO.CUSHION] = io[IO.GROUND] + params.floor;
      io[IO.FLOOR] = io[IO.CUSHION];
      steerAboveFloor(pool, index);
      integrate(pool, index);
      animateBird(pool, index, mode === MODE_JOIN || mode === MODE_PEEL);
      calm(pool, index);
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    g[G.X] = g[G.CX];
    g[G.Y] = g[G.CY];
    g[G.Z] = g[G.CZ];
  }

  function emitCall(data, reason) {
    const calls = data.params.calls;
    if (data.voice && quietSources.size === 0) data.voice.trigger(data.params.wingman.trigger || calls.trigger);
    const g = data.g;
    ctx.bus.emit('fauna:call', {
      id: data.instance.id, presetId: data.instance.presetId, species: data.pool.def.id, reason,
      position: { x: g[G.CX], y: g[G.CY], z: g[G.CZ] },
    });
  }

  // ---- drift ----------------------------------------------------------------------------------------
  function moveDriftGoal(data, dt) {
    const g = data.g;
    const params = data.params;
    const time = g[G.TIME];
    g[G.HEADING] += Math.sin(time * 0.013 + data.phaseSeed * 5) * params.wander * 0.3 * dt;
    g[G.VX] = Math.sin(g[G.HEADING]) * g[G.SPEED];
    g[G.VZ] = (-Math.cos(g[G.HEADING])) * g[G.SPEED];
    g[G.X] += g[G.VX] * dt;
    g[G.Z] += g[G.VZ] * dt;
    const drift = params.drift;
    const bobRate = TWO_PI / Math.max(1, drift.bobPeriod);
    groundUnderGoal(data);
    const baseY = Math.max(g[G.BASE_Y], io[IO.GROUND] + params.floor + data.pool.def.size * g[G.SIZE] * 0.3);
    // A slow bob, and its exact derivative as the climb rate (the body pitches with it).
    const bobPhase = time * bobRate + data.phaseSeed * TWO_PI;
    g[G.Y] += (baseY + Math.sin(bobPhase) * drift.bob - g[G.Y]) * Math.min(1, dt * 0.5);
    g[G.VY] = Math.cos(bobPhase) * drift.bob * bobRate;
  }

  function simulateDrift(data, dt) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const start = data.start;
    const end = start + data.count;
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = (-Math.cos(g[G.HEADING]));
    const lane = params.drift.lane;
    const bankBlend = 1 - Math.exp(-0.8 * dt);
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      const scale = pool.scale[index] * g[G.SIZE];
      // Lanes: side by side and staggered, lane * body length apart; each lags a little on its own bob.
      const laneX = g[G.X] + forwardX * pool.homeZ[index] * scale * lane - forwardZ * pool.homeX[index] * scale * lane;
      const laneZ = g[G.Z] + forwardZ * pool.homeZ[index] * scale * lane + forwardX * pool.homeX[index] * scale * lane;
      const laneY = g[G.Y] + pool.homeY[index] * scale * lane * 0.3;
      // Each animal eases into its lane at up to a fifth of the cruise speed on top of the drift.
      const catchUp = 0.2 * data.cruise;
      const correctionX = Math.min(Math.max((laneX - pool.px[index]) * 0.3, -catchUp), catchUp);
      const correctionY = Math.min(Math.max((laneY - pool.py[index]) * 0.3, -catchUp), catchUp);
      const correctionZ = Math.min(Math.max((laneZ - pool.pz[index]) * 0.3, -catchUp), catchUp);
      pool.vx[index] = g[G.VX] + correctionX;
      pool.vy[index] = g[G.VY] + correctionY;
      pool.vz[index] = g[G.VZ] + correctionZ;
      pool.px[index] += pool.vx[index] * dt;
      pool.py[index] += pool.vy[index] * dt;
      pool.pz[index] += pool.vz[index] * dt;
      pool.bank[index] += (Math.sin(g[G.TIME] * 0.05 + pool.seed[index] * 6) * 0.08 - pool.bank[index]) * bankBlend;
      const rate = pool.def.body.rate[0] + (pool.def.body.rate[1] - pool.def.body.rate[0]) * pool.seed[index];
      pool.phase[index] = (pool.phase[index] + TWO_PI * rate * dt) % (TWO_PI * 64);
      pool.gate[index] = 1;
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    const leadIndex = start;
    g[G.LEAD_X] = pool.px[leadIndex];
    g[G.LEAD_Y] = pool.py[leadIndex];
    g[G.LEAD_Z] = pool.pz[leadIndex];
    g[G.LEAD_HEADING] = g[G.HEADING];
  }

  // ---- slipstream wind source -----------------------------------------------------------------------
  /**
   * The slipstream behind the leader: a tube `length` metres long and `radius` wide trailing the
   * animal, with a tailwind along its heading and lift, strongest on the axis and fading at the ends;
   * its edge churns (turbulence). The sample reads the group's live doubles, so the source is exact
   * while its bounds only move when the leader leaves their margin.
   */
  function createSlipstream(data, id) {
    const g = data.g;
    const slipstream = data.params.drift.slipstream;
    const length = slipstream.length * Math.max(1, g[G.SIZE] / 200);
    const radius = slipstream.radius * Math.max(1, g[G.SIZE] / 200);
    const result = createWindSample();
    const margin = length * 0.3;
    const source = {
      id,
      kind: 'slipstream',
      bounds: null,
      sample(position) {
        const heading = g[G.LEAD_HEADING];
        const forwardX = Math.sin(heading);
        const forwardZ = -Math.cos(heading);
        const offsetX = position.x - g[G.LEAD_X];
        const offsetY = position.y - g[G.LEAD_Y];
        const offsetZ = position.z - g[G.LEAD_Z];
        const behind = -(offsetX * forwardX + offsetZ * forwardZ);
        if (behind < -radius || behind > length) return null;
        const acrossX = offsetX + forwardX * behind;
        const acrossZ = offsetZ + forwardZ * behind;
        const acrossSq = (acrossX * acrossX + acrossZ * acrossZ + offsetY * offsetY) / (radius * radius);
        if (acrossSq >= 1) return null;
        const core = 1 - acrossSq;
        const along = Math.min(1, (behind + radius) / radius) * (1 - Math.max(0, behind / length) * Math.max(0, behind / length));
        const strength = core * along * g[G.FADE];
        result.vel.x = forwardX * slipstream.speed * strength;
        result.vel.y = slipstream.lift * strength;
        result.vel.z = forwardZ * slipstream.speed * strength;
        result.turbulence = slipstream.turbulence * (1 - core) * along;
        return result;
      },
    };
    return {
      source,
      margin,
      reach: length + radius + margin,
      /** Moves the bounds when the leader has left their margin (re-indexing is rationed). */
      refresh(force) {
        const dx = g[G.LEAD_X] - g[G.WIND_X];
        const dy = g[G.LEAD_Y] - g[G.WIND_Y];
        const dz = g[G.LEAD_Z] - g[G.WIND_Z];
        if (!force && dx * dx + dy * dy + dz * dz < margin * margin) return false;
        g[G.WIND_X] = g[G.LEAD_X];
        g[G.WIND_Y] = g[G.LEAD_Y];
        g[G.WIND_Z] = g[G.LEAD_Z];
        const reach = length + radius + margin;
        this.bounds.min.x = g[G.WIND_X] - reach;
        this.bounds.min.y = g[G.WIND_Y] - radius - margin;
        this.bounds.min.z = g[G.WIND_Z] - reach;
        this.bounds.max.x = g[G.WIND_X] + reach;
        this.bounds.max.y = g[G.WIND_Y] + radius + margin;
        this.bounds.max.z = g[G.WIND_Z] + reach;
        return true;
      },
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    };
  }

  function attachSlipstream(instance, data) {
    const wind = data.wind;
    if (!wind || data.windAttached || !ctx.wind) return;
    wind.refresh(true);
    wind.source.bounds = wind.bounds;
    ctx.wind.addSource(wind.source);
    instance.windSourceIds.push(wind.source.id);
    data.windAttached = true;
  }

  function detachSlipstream(instance, data) {
    const wind = data.wind;
    if (!wind || !data.windAttached) return;
    ctx.wind.removeSource(wind.source.id);
    const position = instance.windSourceIds.indexOf(wind.source.id);
    if (position >= 0) instance.windSourceIds.splice(position, 1);
    data.windAttached = false;
  }

  // =============================================================================================
  // DUST: one shared sprite of soft billboards (herds and columns); each group owns a block of slots
  // =============================================================================================
  let dust = null;

  function createDustPool() {
    const { TSL } = ctx;
    const { instancedDynamicBufferAttribute, uv, saturate, float, vec2, vec4, mix, pow, min } = TSL;
    const dustA = new Float32Array(DUST_CAPACITY * 4);
    const dustB = new Float32Array(DUST_CAPACITY * 4);
    const attributeA = new THREE.InstancedBufferAttribute(dustA, 4).setUsage(THREE.DynamicDrawUsage);
    const attributeB = new THREE.InstancedBufferAttribute(dustB, 4).setUsage(THREE.DynamicDrawUsage);
    const nodeA = instancedDynamicBufferAttribute(attributeA, 'vec4');
    const nodeB = instancedDynamicBufferAttribute(attributeB, 'vec4');
    const material = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
    material.name = 'fauna-dust';
    // nodeA: position relative to the pool origin (m) and size (m); nodeB: linear colour and opacity.
    material.positionNode = nodeA.xyz;
    material.scaleNode = vec2(nodeA.w, nodeA.w);
    const light = mix(float(1), float(0.3), ctx.uniforms.nightFactor);
    material.colorNode = vec4(nodeB.rgb.mul(ctx.uniforms.sunColor.mul(0.45).add(0.6)).mul(light), 1);
    const radial = uv().sub(0.5).mul(2).length();
    material.opacityNode = saturate(nodeB.a.mul(pow(saturate(float(1).sub(min(radial, float(1)).mul(radial))), 1.6)));
    const sprite = new THREE.Sprite(material);
    sprite.name = 'fauna-dust';
    sprite.count = 0;
    sprite.frustumCulled = false;
    sprite.renderOrder = 2;
    sprite.visible = false;
    ctx.scene.add(sprite);
    if (ctx.registerPrewarm) ctx.registerPrewarm(sprite);
    return {
      sprite,
      material,
      attributeA,
      attributeB,
      dustA,
      dustB,
      ranges: createRangeAllocator(DUST_CAPACITY),
      origin: new THREE.Vector3(),
      px: new Float64Array(DUST_CAPACITY),
      py: new Float64Array(DUST_CAPACITY),
      pz: new Float64Array(DUST_CAPACITY),
      vx: new Float32Array(DUST_CAPACITY),
      vy: new Float32Array(DUST_CAPACITY),
      vz: new Float32Array(DUST_CAPACITY),
      age: new Float32Array(DUST_CAPACITY),
      life: new Float32Array(DUST_CAPACITY),
      size: new Float32Array(DUST_CAPACITY),
      // Linear rgb of each group's dust (written per slot at emission).
      color: new Float32Array(DUST_CAPACITY * 3),
    };
  }

  /** sRGB hex to linear rgb into out (Float32Array of 3). */
  function linearColor(hex, out) {
    for (let channel = 0; channel < 3; channel++) {
      const value = ((hex >> (16 - channel * 8)) & 255) / 255;
      out[channel] = value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    }
  }

  /** A group's dust block (slots), or none when the dust is off or the pool is full (a budget, not an error). */
  function allocDust(data, dustParams) {
    data.dustStart = -1;
    data.dustCount = 0;
    if (!dust || !dustParams || dustParams.rate <= 0) return 0;
    const slots = Math.min(256, Math.max(48, data.count * 3));
    const start = dust.ranges.alloc(slots);
    if (start < 0) return 0;
    data.dustStart = start;
    data.dustCount = slots;
    data.dustCursor = 0;
    data.dustParams = dustParams;
    data.dustColor = new Float32Array(3);
    linearColor(dustParams.color, data.dustColor);
    for (let slot = start; slot < start + slots; slot++) {
      dust.life[slot] = 0;
      dust.age[slot] = 0;
      dust.dustA[slot * 4 + 3] = 0;
      dust.dustB[slot * 4 + 3] = 0;
    }
    return slots;
  }

  function freeDust(data) {
    if (!dust || data.dustStart < 0) return;
    for (let slot = data.dustStart; slot < data.dustStart + data.dustCount; slot++) {
      dust.life[slot] = 0;
      dust.dustA[slot * 4 + 3] = 0;
      dust.dustB[slot * 4 + 3] = 0;
    }
    dust.ranges.free(data.dustStart);
    data.dustStart = -1;
    data.dustCount = 0;
    refreshDustDraw();
  }

  /** Hides the group's puffs (the far tier): they would not follow the moving origin there. */
  function clearDust(data) {
    for (let slot = data.dustStart; slot < data.dustStart + data.dustCount; slot++) {
      dust.life[slot] = 0;
      dust.dustA[slot * 4 + 3] = 0;
      dust.dustB[slot * 4 + 3] = 0;
    }
    data.g[G.DUST_LIVE] = 0;
    refreshDustDraw();
  }

  function refreshDustDraw() {
    dust.sprite.count = dust.ranges.highWater;
    dust.sprite.visible = dust.ranges.highWater > 0;
    dust.attributeA.needsUpdate = true;
    dust.attributeB.needsUpdate = true;
  }

  /** One puff at agent index's feet, kicked back from its motion (the oldest slot of the block is reused). */
  function emitDust(data, pool, index) {
    const slot = data.dustStart + data.dustCursor;
    data.dustCursor = (data.dustCursor + 1) % data.dustCount;
    // A cheap deterministic jitter from the slot and the agent's phase (no random stream per puff).
    const jitter = Math.sin(slot * 12.9898 + pool.phase[index] * 78.233) * 43758.5453;
    const share = jitter - Math.floor(jitter);
    const params = data.dustParams;
    dust.px[slot] = pool.px[index] + (share - 0.5) * 1.6;
    dust.py[slot] = pool.py[index] + 0.25;
    dust.pz[slot] = pool.pz[index] + (0.5 - share) * 1.6;
    dust.vx[slot] = -pool.vx[index] * 0.18 + (share - 0.5) * 1.2;
    dust.vy[slot] = 0.7 + share * 0.9;
    dust.vz[slot] = -pool.vz[index] * 0.18 + (0.5 - share) * 1.2;
    dust.age[slot] = 0;
    dust.life[slot] = 2.6 + share * 2;
    dust.size[slot] = params.size * (0.6 + share * 0.5);
    dust.color[slot * 3] = data.dustColor[0];
    dust.color[slot * 3 + 1] = data.dustColor[1];
    dust.color[slot * 3 + 2] = data.dustColor[2];
  }

  /** Advances and writes the group's dust block; the group's live puffs into g[DUST_LIVE]. */
  function updateDust(data) {
    const dt = frameStep[0];
    if (data.dustStart < 0) return;
    const origin = dust.origin;
    const drag = Math.exp(-0.9 * dt);
    const windX = data.g[G.WIND_X];
    const windZ = data.g[G.WIND_Z];
    let alive = 0;
    for (let slot = data.dustStart; slot < data.dustStart + data.dustCount; slot++) {
      const offset = slot * 4;
      if (dust.life[slot] <= 0) continue;
      dust.age[slot] += dt;
      const share = dust.age[slot] / dust.life[slot];
      if (share >= 1) {
        dust.life[slot] = 0;
        dust.dustA[offset + 3] = 0;
        dust.dustB[offset + 3] = 0;
        continue;
      }
      alive++;
      dust.vx[slot] = dust.vx[slot] * drag + windX * (1 - drag);
      dust.vy[slot] = dust.vy[slot] * drag + 0.12 * dt;
      dust.vz[slot] = dust.vz[slot] * drag + windZ * (1 - drag);
      dust.px[slot] += dust.vx[slot] * dt;
      dust.py[slot] += dust.vy[slot] * dt;
      dust.pz[slot] += dust.vz[slot] * dt;
      dust.dustA[offset] = dust.px[slot] - origin.x;
      dust.dustA[offset + 1] = dust.py[slot] - origin.y;
      dust.dustA[offset + 2] = dust.pz[slot] - origin.z;
      dust.dustA[offset + 3] = dust.size[slot] * (1 + share * 1.8);
      dust.dustB[offset] = dust.color[slot * 3];
      dust.dustB[offset + 1] = dust.color[slot * 3 + 1];
      dust.dustB[offset + 2] = dust.color[slot * 3 + 2];
      // Fades in fast, thins out slowly; the group's own fade applies.
      dust.dustB[offset + 3] = 0.42 * Math.min(1, share * 8) * (1 - share) * (1 - share) * data.g[G.FADE];
    }
    data.g[G.DUST_LIVE] = alive;
    refreshDustDraw();
  }

  /**
   * Emits the group's dust from agent index running at io[SPEED_NOW]: `rate` puffs a second above
   * io[DUST_MIN] m/s, over io[STEP_DT] seconds.
   */
  function kickDust(data, pool, index) {
    const speed = io[IO.SPEED_NOW];
    const threshold = io[IO.DUST_MIN];
    if (data.dustStart < 0 || speed < threshold) return;
    pool.aux2[index] += data.dustParams.rate * Math.min(1, speed / (threshold * 2)) * io[IO.STEP_DT];
    while (pool.aux2[index] >= 1) {
      pool.aux2[index] -= 1;
      emitDust(data, pool, index);
    }
  }

  // =============================================================================================
  // GROUND AND WATER QUERIES OF THE NEW MODES
  // =============================================================================================
  /** Integer probe coordinates reach the terrain unboxed; the extra ground surfaces (island tops) count. */
  function groundAt(data, x, z) {
    let height = ctx.terrain.groundHeight(x, z);
    const surfaces = ctx.surfaces;
    if (surfaces && surfaces.count > 0) {
      const top = surfaces.surfaceBelow(x, z, data.g[G.BASE_Y] + 40);
      if (top > height) height = top;
    }
    return height;
  }

  /** Water at (x, z): the shared water query (ocean and lakes) when the game has one, else the sea. */
  function isWaterAt(x, z, ground) {
    const query = ctx.game && ctx.game.waterQuery;
    if (query && typeof query.isWater === 'function') return query.isWater(x, z);
    return ground < ctx.terrain.waterLevel;
  }

  /**
   * The water surface height at (x, z): the shared water query (swell and local lakes) when the game
   * has one, else sea level with the whirlpool dips.
   */
  function waterHeightAt(x, z) {
    const query = ctx.game && ctx.game.waterQuery;
    if (query && typeof query.heightAt === 'function') {
      const height = query.heightAt(x, z);
      if (height > -Infinity) return height;
    }
    return waterSurface(x, z);
  }

  // ---- A herd's fine ground grid ----------------------------------------------------------------
  function createFineGround(spacing) {
    const cells = FINE_GRID * FINE_GRID;
    return {
      spacing,
      cx: 0,
      cz: 0,
      heights: new Float64Array(cells),
      water: new Uint8Array(cells),
      dirty: new Uint8Array(cells),
      scratchHeights: new Float64Array(cells),
      scratchWater: new Uint8Array(cells),
      cursor: 0,
      wait: 0,
    };
  }

  function probeFineCell(data, fine, cell) {
    const half = (FINE_GRID - 1) / 2;
    const x = fine.cx + ((cell % FINE_GRID) - half) * fine.spacing;
    const z = fine.cz + (Math.floor(cell / FINE_GRID) - half) * fine.spacing;
    const height = groundAt(data, x, z);
    fine.heights[cell] = height;
    fine.water[cell] = isWaterAt(x, z, height) ? 1 : 0;
    fine.dirty[cell] = 0;
  }

  /** Centres the grid on (x, z) (whole cells) and probes every cell (create, and back from far). */
  function fillFine(data, x, z) {
    const fine = data.fine;
    fine.cx = Math.round(x / fine.spacing) * fine.spacing;
    fine.cz = Math.round(z / fine.spacing) * fine.spacing;
    for (let cell = 0; cell < FINE_GRID * FINE_GRID; cell++) probeFineCell(data, fine, cell);
  }

  /**
   * Follows the herd's centroid: shifts the grid by whole cells (kept cells move, new ones wait for a
   * probe).
   */
  function recentreFine(data) {
    const fine = data.fine;
    const shiftX = Math.round((data.g[G.CX] - fine.cx) / fine.spacing);
    const shiftZ = Math.round((data.g[G.CZ] - fine.cz) / fine.spacing);
    if (shiftX === 0 && shiftZ === 0) return;
    fine.scratchHeights.set(fine.heights);
    fine.scratchWater.set(fine.water);
    for (let row = 0; row < FINE_GRID; row++) {
      for (let column = 0; column < FINE_GRID; column++) {
        const cell = row * FINE_GRID + column;
        const sourceColumn = column + shiftX;
        const sourceRow = row + shiftZ;
        if (sourceColumn >= 0 && sourceColumn < FINE_GRID && sourceRow >= 0 && sourceRow < FINE_GRID) {
          const source = sourceRow * FINE_GRID + sourceColumn;
          fine.heights[cell] = fine.scratchHeights[source];
          fine.water[cell] = fine.scratchWater[source];
        } else {
          // Until probed, a new cell takes its nearest kept neighbour's height and counts as water,
          // so nothing walks onto ground the herd has not seen yet.
          const nearColumn = Math.min(Math.max(sourceColumn, 0), FINE_GRID - 1);
          const nearRow = Math.min(Math.max(sourceRow, 0), FINE_GRID - 1);
          fine.heights[cell] = fine.scratchHeights[nearRow * FINE_GRID + nearColumn];
          fine.water[cell] = 1;
          fine.dirty[cell] = 1;
        }
      }
    }
    fine.cx += shiftX * fine.spacing;
    fine.cz += shiftZ * fine.spacing;
  }

  /** One probe every `every` frames: a cell waiting since a shift first, else the next in turn. */
  function probeFine(data, every) {
    const fine = data.fine;
    fine.wait = (fine.wait + 1) % every;
    if (fine.wait !== 0) return;
    recentreFine(data);
    const cells = FINE_GRID * FINE_GRID;
    let cell = -1;
    for (let step = 0; step < cells; step++) {
      const candidate = (fine.cursor + step) % cells;
      if (fine.dirty[candidate]) {
        cell = candidate;
        break;
      }
    }
    if (cell < 0) cell = fine.cursor;
    fine.cursor = (cell + 1) % cells;
    probeFineCell(data, fine, cell);
  }

  /**
   * Bilinear ground at io[SAMPLE_X], io[SAMPLE_Z] on the fine grid into io[GROUND], its gradient into
   * io[GRAD_X], io[GRAD_Z] and the slope (the gradient's length, rise over run) into io[SLOPE]; io[WET]
   * is 1 when the nearest cell is water.
   */
  function sampleFine(fine) {
    const half = (FINE_GRID - 1) / 2;
    const spacing = fine.spacing;
    const u = Math.min(Math.max((io[IO.SAMPLE_X] - fine.cx) / spacing + half, 0), FINE_GRID - 1.001);
    const v = Math.min(Math.max((io[IO.SAMPLE_Z] - fine.cz) / spacing + half, 0), FINE_GRID - 1.001);
    const column = Math.floor(u);
    const row = Math.floor(v);
    const fu = u - column;
    const fv = v - row;
    const heights = fine.heights;
    const h00 = heights[row * FINE_GRID + column];
    const h10 = heights[row * FINE_GRID + column + 1];
    const h01 = heights[(row + 1) * FINE_GRID + column];
    const h11 = heights[(row + 1) * FINE_GRID + column + 1];
    io[IO.GROUND] = (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
    io[IO.GRAD_X] = ((h10 - h00) * (1 - fv) + (h11 - h01) * fv) / spacing;
    io[IO.GRAD_Z] = ((h01 - h00) * (1 - fu) + (h11 - h10) * fu) / spacing;
    io[IO.SLOPE] = Math.sqrt(io[IO.GRAD_X] * io[IO.GRAD_X] + io[IO.GRAD_Z] * io[IO.GRAD_Z]);
    io[IO.WET] = fine.water[((v + 0.5) | 0) * FINE_GRID + ((u + 0.5) | 0)];
  }

  /**
   * True when (io[SAMPLE_X], io[SAMPLE_Z]) is steeper than io[SLOPE_LIMIT], or water lies within
   * io[MARGIN] metres of it.
   */
  function blockedAt(fine) {
    const slopeLimit = io[IO.SLOPE_LIMIT];
    const margin = io[IO.MARGIN];
    const x = io[IO.SAMPLE_X];
    const z = io[IO.SAMPLE_Z];
    sampleFine(fine);
    if (io[IO.SLOPE] > slopeLimit || io[IO.WET] > 0) return true;
    if (margin <= 0) return false;
    const ground = io[IO.GROUND];
    const slope = io[IO.SLOPE];
    let wet = false;
    for (let side = 0; side < 4 && !wet; side++) {
      io[IO.SAMPLE_X] = x + (side === 0 ? margin : side === 1 ? -margin : 0);
      io[IO.SAMPLE_Z] = z + (side === 2 ? margin : side === 3 ? -margin : 0);
      sampleFine(fine);
      if (io[IO.WET] > 0) wet = true;
    }
    io[IO.SAMPLE_X] = x;
    io[IO.SAMPLE_Z] = z;
    io[IO.GROUND] = ground;
    io[IO.SLOPE] = slope;
    return wet;
  }

  // =============================================================================================
  // HERD
  // =============================================================================================
  const STAMPEDE_REASONS = Object.freeze({ player: 'player', timer: 'timer', event: 'event' });

  function startStampede(data, x, z, trigger) {
    const g = data.g;
    const stampede = data.params.herd.stampede;
    g[G.STAMPEDE] = stampede.duration;
    g[G.STAMPEDE_X] = x;
    g[G.STAMPEDE_Z] = z;
    g[G.STAMPEDE_COOLDOWN] = stampede.duration + stampede.cooldown;
    // Away from the trigger at once; the agents follow at their own pace.
    g[G.HEADING] = Math.atan2(g[G.CX] - x, -(g[G.CZ] - z));
    const pool = data.pool;
    for (let index = data.start; index < data.start + data.count; index++) pool.mode[index] = HERD_WALK;
    ctx.bus.emit('fauna:stampede', {
      id: data.instance.id, presetId: data.instance.presetId, species: pool.def.id, trigger: STAMPEDE_REASONS[trigger],
      position: { x: g[G.CX], y: g[G.CY], z: g[G.CZ] },
    });
  }

  function checkStampede(data) {
    const dt = frameStep[0];
    const g = data.g;
    const stampede = data.params.herd.stampede;
    if (g[G.STAMPEDE] > 0) {
      g[G.STAMPEDE] -= dt;
      return;
    }
    g[G.STAMPEDE_COOLDOWN] -= dt;
    if (stampede.trigger === 'timer') {
      g[G.STAMPEDE_TIMER] -= dt;
      if (g[G.STAMPEDE_TIMER] <= 0) {
        g[G.STAMPEDE_TIMER] = stampede.interval;
        // From a side that turns with the group clock (deterministic).
        const angle = data.phaseSeed * TWO_PI + g[G.TIME] * 0.37;
        startStampede(data, g[G.CX] + Math.sin(angle) * 200, g[G.CZ] - Math.cos(angle) * 200, 'timer');
      }
      return;
    }
    if (stampede.trigger !== 'player' || g[G.STAMPEDE_COOLDOWN] > 0) return;
    const player = ctx.state.player.position;
    const dx = player.x - g[G.CX];
    const dz = player.z - g[G.CZ];
    const reach = stampede.radius * Math.sqrt(threat[0]);
    if (dx * dx + dz * dz > reach * reach || player.y - g[G.CY] > stampede.maxAltitude) return;
    startStampede(data, player.x, player.z, 'player');
  }

  /** The herd's goal: grazing drift or a stampede, steering clear of steep ground and water. */
  function moveHerdGoal(data) {
    const dt = frameStep[0];
    const g = data.g;
    const herd = data.params.herd;
    if (data.instance.tier === 'far') {
      // Out of sight the herd holds its place, but a running stampede and its cooldown keep their
      // clocks, so a herd left mid-run has settled to a walk when the player comes back.
      if (g[G.STAMPEDE] > 0) g[G.STAMPEDE] -= dt;
      else {
        g[G.STAMPEDE_COOLDOWN] -= dt;
        g[G.SPEED] = herd.gaits.walk * (1 - herd.graze * 0.6);
        g[G.GAIT] = 0;
      }
      return;
    }
    checkStampede(data);
    const stampeding = g[G.STAMPEDE] > 0;
    const runSpeed = data.runSpeed;
    const target = stampeding ? runSpeed : herd.gaits.walk * (1 - herd.graze * 0.6);
    g[G.SPEED] += (target - g[G.SPEED]) * Math.min(1, dt * (stampeding ? 1.4 : 0.4));
    if (stampeding) {
      // Away from the trigger, bent downhill.
      const awayX = g[G.CX] - g[G.STAMPEDE_X];
      const awayZ = g[G.CZ] - g[G.STAMPEDE_Z];
      const awayLength = Math.sqrt(awayX * awayX + awayZ * awayZ) || 1;
      io[IO.SAMPLE_X] = g[G.X];
      io[IO.SAMPLE_Z] = g[G.Z];
      sampleFine(data.fine);
      const downhill = herd.stampede.downhill;
      const fleeX = awayX / awayLength - io[IO.GRAD_X] * downhill * 4;
      const fleeZ = awayZ / awayLength - io[IO.GRAD_Z] * downhill * 4;
      io[IO.TURN_TARGET] = Math.atan2(fleeX, -fleeZ);
      io[IO.TURN_STEP] = 0.6 * dt;
      turnGroup(g);
    } else {
      const time = g[G.TIME];
      g[G.HEADING] += (Math.sin(time * 0.05 + data.phaseSeed * 13.7) * 0.11 + Math.sin(time * 0.017 + data.phaseSeed * 41.3) * 0.07) * dt;
      const awayX = g[G.X] - g[G.ANCHOR_X];
      const awayZ = g[G.Z] - g[G.ANCHOR_Z];
      if (awayX * awayX + awayZ * awayZ > data.params.leash * data.params.leash) {
        io[IO.TURN_TARGET] = Math.atan2(-awayX, awayZ);
        io[IO.TURN_STEP] = 0.25 * dt;
        turnGroup(g);
      }
    }
    // Look ahead now and then: a blocked line turns the goal to the nearest clear heading.
    g[G.AVOID_TIMER] -= dt;
    if (g[G.AVOID_TIMER] <= 0) {
      g[G.AVOID_TIMER] = 0.4;
      steerGoalClear(data);
    }
    const nextX = g[G.X] + Math.sin(g[G.HEADING]) * g[G.SPEED] * dt;
    const nextZ = g[G.Z] - Math.cos(g[G.HEADING]) * g[G.SPEED] * dt;
    io[IO.SAMPLE_X] = nextX;
    io[IO.SAMPLE_Z] = nextZ;
    io[IO.SLOPE_LIMIT] = herd.slopeLimit;
    io[IO.MARGIN] = herd.waterMargin;
    if (!blockedAt(data.fine)) {
      g[G.VX] = (nextX - g[G.X]) / dt;
      g[G.VZ] = (nextZ - g[G.Z]) / dt;
      g[G.X] = nextX;
      g[G.Z] = nextZ;
    } else {
      g[G.VX] = 0;
      g[G.VZ] = 0;
      g[G.AVOID_TIMER] = 0;
    }
    io[IO.SAMPLE_X] = g[G.X];
    io[IO.SAMPLE_Z] = g[G.Z];
    sampleFine(data.fine);
    g[G.Y] = io[IO.GROUND];
    g[G.GAIT] = Math.min(Math.max((g[G.SPEED] - herd.gaits.walk) / (herd.gaits.run - herd.gaits.walk), 0), 1);
  }

  /** Candidate turns (radians) tried in order when the line ahead is blocked. */
  const CLEAR_TURNS = Object.freeze([0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, Math.PI]);

  function steerGoalClear(data) {
    const g = data.g;
    const herd = data.params.herd;
    const fine = data.fine;
    const reach = Math.min(fine.spacing * (FINE_GRID - 1) * 0.42, 18 + g[G.SPEED] * 3);
    io[IO.SLOPE_LIMIT] = herd.slopeLimit;
    io[IO.MARGIN] = herd.waterMargin;
    for (let attempt = 0; attempt < CLEAR_TURNS.length; attempt++) {
      const heading = g[G.HEADING] + CLEAR_TURNS[attempt];
      let clear = true;
      for (let step = 1; step <= 3 && clear; step++) {
        io[IO.SAMPLE_X] = g[G.X] + Math.sin(heading) * reach * (step / 3);
        io[IO.SAMPLE_Z] = g[G.Z] - Math.cos(heading) * reach * (step / 3);
        if (blockedAt(fine)) clear = false;
      }
      if (clear) {
        g[G.HEADING] = heading;
        return;
      }
    }
    // Hemmed in: stand still this time and look again soon.
    g[G.SPEED] = 0;
  }

  function simulateHerd(data) {
    const dt = frameStep[0];
    const pool = data.pool;
    const g = data.g;
    const herd = data.params.herd;
    const fine = data.fine;
    const start = data.start;
    const end = start + data.count;
    const stampeding = g[G.STAMPEDE] > 0;
    probeFine(data, stampeding ? 2 : 4);
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = -Math.cos(g[G.HEADING]);
    const spacing = herd.spacing * g[G.SIZE] * (stampeding ? 0.8 : 1);
    const runSpeed = data.runSpeed;
    const topSpeed = Math.max(herd.gaits.walk * 1.4, g[G.SPEED] * 1.25);
    const accel = stampeding ? 7 : 2.5;
    const separation = spacing * 0.55;
    const separationSq = separation * separation;
    const stride = pool.def.gait.stride;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      // The animal's place in the herd (a loose sunflower around the goal, turned to the heading).
      const slotX = g[G.X] + (-forwardZ * pool.homeX[index] + forwardX * pool.homeZ[index]) * spacing;
      const slotZ = g[G.Z] + (forwardX * pool.homeX[index] + forwardZ * pool.homeZ[index]) * spacing;
      pool.timer[index] -= dt;
      if (!stampeding && pool.timer[index] <= 0) {
        // Grazing: stand a while, then walk a little; the herd's graze share sets the balance.
        const grazing = pool.mode[index] === HERD_GRAZE;
        pool.mode[index] = grazing ? HERD_WALK : HERD_GRAZE;
        pool.timer[index] = grazing ? 4 + pool.seed[index] * 8 : (6 + pool.seed[index] * 14) * herd.graze * 2;
      }
      const toSlotX = slotX - pool.px[index];
      const toSlotZ = slotZ - pool.pz[index];
      const toSlotSq = toSlotX * toSlotX + toSlotZ * toSlotZ;
      const standing = !stampeding && pool.mode[index] === HERD_GRAZE && toSlotSq < spacing * spacing * 4;
      let steerX = 0;
      let steerZ = 0;
      if (standing) {
        steerX = -pool.vx[index] * 2;
        steerZ = -pool.vz[index] * 2;
      } else {
        const gain = stampeding ? 0.9 : 0.35;
        let desiredX = toSlotX * gain + g[G.VX];
        let desiredZ = toSlotZ * gain + g[G.VZ];
        const desiredLength = Math.sqrt(desiredX * desiredX + desiredZ * desiredZ);
        if (desiredLength > topSpeed) {
          desiredX *= topSpeed / desiredLength;
          desiredZ *= topSpeed / desiredLength;
        }
        steerX = (desiredX - pool.vx[index]) * 1.5;
        steerZ = (desiredZ - pool.vz[index]) * 1.5;
      }
      // Separation (each animal keeps its spacing; a big herd checks a rotating share of the others).
      const x = pool.px[index];
      const z = pool.pz[index];
      const stride2 = data.count > 64 ? 3 : 1;
      for (let other = start + ((index + data.neighborSlice) % stride2); other < end; other += stride2) {
        if (other === index) continue;
        const dx = x - pool.px[other];
        const dz = z - pool.pz[other];
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq >= separationSq || distanceSq < 1e-6) continue;
        const push = (separation - Math.sqrt(distanceSq)) / separation;
        steerX += dx * push * 3 * stride2;
        steerZ += dz * push * 3 * stride2;
      }
      const steerLength = Math.sqrt(steerX * steerX + steerZ * steerZ);
      if (steerLength > accel) {
        steerX *= accel / steerLength;
        steerZ *= accel / steerLength;
      }
      let vx = pool.vx[index] + steerX * dt;
      let vz = pool.vz[index] + steerZ * dt;
      const speed = Math.sqrt(vx * vx + vz * vz);
      const limit = stampeding ? runSpeed * 1.1 : topSpeed;
      if (speed > limit) {
        vx *= limit / speed;
        vz *= limit / speed;
      }
      // Never onto steep ground or into water: try the move, then each axis alone, else stop.
      let nextX = x + vx * dt;
      let nextZ = z + vz * dt;
      io[IO.SAMPLE_X] = nextX;
      io[IO.SAMPLE_Z] = nextZ;
      io[IO.SLOPE_LIMIT] = herd.slopeLimit;
      io[IO.MARGIN] = herd.waterMargin * 0.5;
      if (blockedAt(fine)) {
        io[IO.SAMPLE_X] = nextX;
        io[IO.SAMPLE_Z] = z;
        if (!blockedAt(fine)) {
          nextZ = z;
          vz = 0;
        } else {
          io[IO.SAMPLE_X] = x;
          io[IO.SAMPLE_Z] = nextZ;
          if (!blockedAt(fine)) {
            nextX = x;
            vx = 0;
          } else {
            nextX = x;
            nextZ = z;
            vx = 0;
            vz = 0;
          }
        }
      }
      io[IO.SAMPLE_X] = nextX;
      io[IO.SAMPLE_Z] = nextZ;
      sampleFine(fine);
      const y = io[IO.GROUND];
      pool.vy[index] = dt > 0 ? (y - pool.py[index]) / dt : 0;
      pool.vx[index] = vx;
      pool.vz[index] = vz;
      pool.px[index] = nextX;
      pool.py[index] = y;
      pool.pz[index] = nextZ;
      const moving = Math.sqrt(vx * vx + vz * vz);
      pool.gait[index] = Math.min(Math.max((moving - herd.gaits.walk) / (herd.gaits.run - herd.gaits.walk), 0), 1);
      pool.gate[index] += ((moving > 0.25 ? 1 : 0) - pool.gate[index]) * Math.min(1, dt * 4);
      pool.phase[index] = (pool.phase[index] + TWO_PI * (moving / (stride * pool.scale[index] * g[G.SIZE])) * dt) % (TWO_PI * 64);
      pool.bank[index] = 0;
      io[IO.SPEED_NOW] = moving;
      io[IO.DUST_MIN] = herd.gaits.trot * 0.8;
      io[IO.STEP_DT] = dt;
      kickDust(data, pool, index);
      sumX += nextX;
      sumY += y;
      sumZ += nextZ;
    }
    data.neighborSlice = (data.neighborSlice + 1) % 3;
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    updateDust(data);
  }

  /**
   * Finds where a herd can stand: the anchor when its ground is clear, else the nearest clear point
   * within reach (rings 120 m apart, 16 bearings), re-filling the fine grid there. False when none.
   */
  function seekClearGround(data, reach) {
    const g = data.g;
    const herd = data.params.herd;
    const clearHere = () => {
      fillFine(data, g[G.X], g[G.Z]);
      io[IO.SAMPLE_X] = g[G.X];
      io[IO.SAMPLE_Z] = g[G.Z];
      io[IO.SLOPE_LIMIT] = herd.slopeLimit;
      io[IO.MARGIN] = herd.waterMargin;
      return !blockedAt(data.fine);
    };
    if (clearHere()) return true;
    for (let radius = 120; radius <= reach; radius += 120) {
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * TWO_PI;
        g[G.X] = Math.round(g[G.ANCHOR_X] + Math.sin(angle) * radius);
        g[G.Z] = Math.round(g[G.ANCHOR_Z] - Math.cos(angle) * radius);
        if (clearHere()) {
          g[G.ANCHOR_X] = g[G.X];
          g[G.ANCHOR_Z] = g[G.Z];
          return true;
        }
      }
    }
    return false;
  }

  // =============================================================================================
  // COLUMN
  // =============================================================================================
  const columnOut = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 1, heading: 0, distance: 0, speed: 0, done: false };
  /** [flight time, car offset] handed to the follower without boxing. */
  const columnQuery = new Float64Array(2);

  /**
   * The column's path in the world: column.path points ([along, across] in the spawn frame) or 'auto'
   * (buildGroundPath from the anchor along the heading, around slopes and water), resampled every
   * `resample` metres with the ground height, as a PathFollower. Returns false when no route exists.
   */
  function buildColumnPath(data, heading) {
    const g = data.g;
    const column = data.params.column;
    const forwardX = Math.sin(heading);
    const forwardZ = -Math.cos(heading);
    let planar;
    if (column.path === 'auto') {
      const route = buildGroundPath(ctx.terrain, ctx.game ? ctx.game.waterQuery ?? null : null, {
        from: { x: g[G.ANCHOR_X], z: g[G.ANCHOR_Z] },
        to: { x: g[G.ANCHOR_X] + forwardX * column.length, z: g[G.ANCHOR_Z] + forwardZ * column.length },
        maxSlope: column.maxSlope ?? data.params.herd.slopeLimit,
        seed: Math.floor(data.phaseSeed * 2147483647),
        spacing: 50,
        waterLevel: ctx.terrain.waterLevel,
      });
      if (route.points.length < 6) return false;
      planar = route.points;
    } else {
      planar = new Float64Array(column.path.points.length * 3);
      column.path.points.forEach(([along, across], index) => {
        planar[index * 3] = g[G.ANCHOR_X] + forwardX * along - forwardZ * across;
        planar[index * 3 + 2] = g[G.ANCHOR_Z] + forwardZ * along + forwardX * across;
      });
    }
    // Resample with the ground under every point, so the walkers stand on the terrain.
    const smooth = createPath({ points: planar, closed: column.path !== 'auto' && column.path.closed === true, smoothing: column.path === 'auto' ? 'catmullRom' : column.path.smoothing ?? 'catmullRom', samplesPerSegment: 8 });
    const samples = Math.max(2, Math.ceil(smooth.length / column.resample) + 1);
    const points = new Float64Array(samples * 3);
    const point = { x: 0, y: 0, z: 0 };
    for (let index = 0; index < samples; index++) {
      smooth.sampleAt((index / (samples - 1)) * smooth.length, point);
      points[index * 3] = point.x;
      points[index * 3 + 1] = groundAt(data, point.x, point.z);
      points[index * 3 + 2] = point.z;
    }
    data.path = createPath({ points, closed: smooth.closed, smoothing: 'linear' });
    const length = Math.ceil(data.count / column.lanes) * column.spacing;
    data.follower = createPathFollower({
      path: data.path,
      speed: column.speed ?? data.cruise,
      mode: smooth.closed ? 'loop' : column.mode,
      startTime: ctx.state.time.elapsed,
      startDistance: Math.min(length, data.path.length * 0.5),
    });
    return true;
  }

  function simulateColumn(data) {
    const dt = frameStep[0];
    const pool = data.pool;
    const g = data.g;
    const column = data.params.column;
    const lanes = column.lanes;
    const start = data.start;
    const end = start + data.count;
    const stride = pool.def.gait.stride;
    const time = g[G.TIME];
    columnQuery[0] = ctx.state.time.elapsed;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      const k = index - start;
      columnQuery[1] = Math.floor(k / lanes) * column.spacing + pool.homeZ[index];
      data.follower.carAtFrom(columnQuery, 0, columnOut);
      const horizontal = Math.sqrt(columnOut.tx * columnOut.tx + columnOut.tz * columnOut.tz) || 1;
      const rightX = -columnOut.tz / horizontal;
      const rightZ = columnOut.tx / horizontal;
      const lateral = ((k % lanes) - (lanes - 1) * 0.5) * column.laneWidth + pool.homeX[index] + Math.sin(time * 0.3 + pool.seed[index] * TWO_PI) * column.jitter * 0.5;
      const x = columnOut.x + rightX * lateral;
      const y = columnOut.y;
      const z = columnOut.z + rightZ * lateral;
      if (dt > 0) {
        pool.vx[index] = (x - pool.px[index]) / dt;
        pool.vy[index] = (y - pool.py[index]) / dt;
        pool.vz[index] = (z - pool.pz[index]) / dt;
      }
      pool.px[index] = x;
      pool.py[index] = y;
      pool.pz[index] = z;
      const moving = columnOut.speed;
      pool.gait[index] = Math.min(Math.max((moving - data.cruise) / (data.speedRange[1] - data.cruise), 0), 1);
      pool.gate[index] += ((moving > 0.2 ? 1 : 0) - pool.gate[index]) * Math.min(1, dt * 3);
      pool.phase[index] = (pool.phase[index] + TWO_PI * (moving / (stride * pool.scale[index] * g[G.SIZE])) * dt) % (TWO_PI * 64);
      pool.bank[index] = 0;
      io[IO.SPEED_NOW] = moving;
      io[IO.DUST_MIN] = 0.5;
      io[IO.STEP_DT] = dt;
      kickDust(data, pool, index);
      sumX += x;
      sumY += y;
      sumZ += z;
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
    g[G.X] = g[G.CX];
    g[G.Y] = g[G.CY];
    g[G.Z] = g[G.CZ];
    updateDust(data);
  }

  // =============================================================================================
  // SURFACE: dolphins and wading birds
  // =============================================================================================
  /** Refreshes one agent's cached water height a frame (pool.homeY), round robin. */
  function refreshWaterCache(data) {
    const pool = data.pool;
    const g = data.g;
    const cursor = g[G.WATER_CURSOR];
    const index = data.start + cursor;
    pool.homeY[index] = waterHeightAt(Math.round(pool.px[index]), Math.round(pool.pz[index]));
    g[G.WATER_CURSOR] = (cursor + 1) % data.count;
  }

  /** The point under the craft's shadow on the water (the sun's direction), into SHADOW_X / SHADOW_Z. */
  function shadowPoint(g, waterY) {
    const player = ctx.state.player.position;
    const sun = ctx.state.time.sunDirection;
    const height = player.y - waterY;
    if (sun && sun.y > 0.12 && height > 0) {
      g[G.SHADOW_X] = player.x - (sun.x / sun.y) * height;
      g[G.SHADOW_Z] = player.z - (sun.z / sun.y) * height;
    } else {
      g[G.SHADOW_X] = player.x;
      g[G.SHADOW_Z] = player.z;
    }
  }

  function moveSurfaceGoal(data) {
    const dt = frameStep[0];
    if (data.pool.def.wade) moveWaderGoal(data);
    else moveDolphinGoal(data);
  }

  /** Dolphins: wander on open water like a pod, or race toward the craft's shadow when it flies low. */
  function moveDolphinGoal(data) {
    const dt = frameStep[0];
    const g = data.g;
    const race = data.params.surface.raceShadow;
    const waterY = g[G.BASE_Y];
    shadowPoint(g, waterY);
    const player = ctx.state.player.position;
    const dx = g[G.SHADOW_X] - g[G.CX];
    const dz = g[G.SHADOW_Z] - g[G.CZ];
    const near = dx * dx + dz * dz < race.radius * race.radius && player.y - waterY < race.maxAltitude;
    // Whether the shadow is over open water: a terrain probe twice a second (terrain heights allocate).
    g[G.AVOID_TIMER] -= dt;
    if (g[G.AVOID_TIMER] <= 0) {
      g[G.AVOID_TIMER] = 0.5;
      g[G.SHADOW_WET] = ctx.terrain.heightAt(Math.round(g[G.SHADOW_X]), Math.round(g[G.SHADOW_Z])) < ctx.terrain.waterLevel - 3 ? 1 : 0;
    }
    const racing = near && g[G.SHADOW_WET] > 0;
    const previous = g[G.RACE] > 0.5;
    g[G.RACE] += ((racing ? 1 : 0) - g[G.RACE]) * Math.min(1, dt * 1.5);
    if ((g[G.RACE] > 0.5) !== previous) {
      ctx.bus.emit('fauna:race', { id: data.instance.id, presetId: data.instance.presetId, species: data.pool.def.id, racing: g[G.RACE] > 0.5 });
    }
    if (g[G.RACE] > 0.5) {
      // Chase the shadow: the goal heads for it at the boosted speed (dolphins cannot keep up with a
      // fast craft, they race it while it is slow or circling).
      const toX = g[G.SHADOW_X] - g[G.X];
      const toZ = g[G.SHADOW_Z] - g[G.Z];
      io[IO.TURN_TARGET] = Math.atan2(toX, -toZ);
      io[IO.TURN_STEP] = 1.4 * dt;
      turnGroup(g);
      const top = data.cruise * race.boost;
      const distance = Math.sqrt(toX * toX + toZ * toZ);
      g[G.SPEED] += (Math.min(top, Math.max(data.cruise, distance * 0.4)) - g[G.SPEED]) * Math.min(1, dt * 1.2);
      g[G.VX] = Math.sin(g[G.HEADING]) * g[G.SPEED];
      g[G.VZ] = -Math.cos(g[G.HEADING]) * g[G.SPEED];
      g[G.X] += g[G.VX] * dt;
      g[G.Z] += g[G.VZ] * dt;
      g[G.Y] = waterY;
      return;
    }
    g[G.SPEED] += (data.cruise - g[G.SPEED]) * Math.min(1, dt * 0.5);
    movePodGoal(data);
    g[G.Y] = waterY;
  }

  function simulateDolphins(data) {
    const dt = frameStep[0];
    const pool = data.pool;
    const g = data.g;
    const surface = data.params.surface;
    const start = data.start;
    const end = start + data.count;
    data.waterWait = (data.waterWait + 1) % 2;
    if (data.waterWait === 0) refreshWaterCache(data);
    g[G.BASE_Y] = pool.homeY[start];
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = -Math.cos(g[G.HEADING]);
    const water = ctx.water;
    const boost = 1 + (surface.raceShadow.boost - 1) * g[G.RACE];
    const top = data.speedRange[1] * boost;
    const leap = Math.sqrt(2 * GRAVITY * Math.max(0.1, surface.porpoise.height));
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = start; index < end; index++) {
      const scale = pool.scale[index] * g[G.SIZE];
      const surfaceY = pool.homeY[index];
      const laneX = g[G.X] + (forwardX * pool.homeZ[index] - forwardZ * pool.homeX[index]) * surface.spread;
      const laneZ = g[G.Z] + (forwardZ * pool.homeZ[index] + forwardX * pool.homeX[index]) * surface.spread;
      pool.timer[index] -= dt * (1 + g[G.RACE]);
      if (pool.mode[index] === SWIM_LEAP) {
        pool.vy[index] -= GRAVITY * dt;
        pool.px[index] += pool.vx[index] * dt;
        pool.py[index] += pool.vy[index] * dt;
        pool.pz[index] += pool.vz[index] * dt;
        if (pool.vy[index] < 0 && pool.py[index] < surfaceY - 0.2 * scale) {
          pool.mode[index] = SWIM;
          pool.aux2[index] = 0;
          pool.timer[index] = rangeValue(surface.porpoise.interval, data.rng);
          if (water) {
            const mark = data.waterMark;
            mark.x = pool.px[index];
            mark.z = pool.pz[index];
            mark.strength = 0.28;
            mark.glow = 1;
            water.splashMark(mark);
          }
        }
      } else {
        steering[0] = 0;
        steering[1] = 0;
        steering[2] = 0;
        io[IO.TARGET_X] = laneX;
        io[IO.TARGET_Y] = pool.py[index];
        io[IO.TARGET_Z] = laneZ;
        io[IO.FEED_X] = g[G.VX];
        io[IO.FEED_Y] = 0;
        io[IO.FEED_Z] = g[G.VZ];
        io[IO.GAIN] = 0.5;
        io[IO.WEIGHT] = 1.2;
        io[IO.SEEK_MAX] = top;
        steerToward(pool, index);
        const vx = pool.vx[index] + steering[0] * dt;
        const vz = pool.vz[index] + steering[2] * dt;
        const speed = Math.sqrt(vx * vx + vz * vz) || 1;
        const clamped = Math.min(Math.max(speed, data.speedRange[0]), top);
        pool.vx[index] = (vx / speed) * clamped;
        pool.vz[index] = (vz / speed) * clamped;
        // Just under the surface, riding the swell (the cached water height); aux2 counts the
        // seconds since the last splash-down.
        pool.aux2[index] += dt;
        const targetY = surfaceY - 0.25 * scale;
        pool.vy[index] += ((targetY - pool.py[index]) * 3 - pool.vy[index]) * Math.min(1, dt * 4);
        pool.px[index] += pool.vx[index] * dt;
        pool.py[index] += pool.vy[index] * dt;
        pool.pz[index] += pool.vz[index] * dt;
        if (pool.timer[index] <= 0 && surface.porpoise.height > 0) {
          pool.mode[index] = SWIM_LEAP;
          pool.py[index] = surfaceY - 0.15 * scale;
          pool.vy[index] = leap * (0.8 + 0.4 * pool.seed[index]) * Math.sqrt(scale);
          if (water) {
            const mark = data.waterMark;
            mark.x = pool.px[index];
            mark.z = pool.pz[index];
            mark.strength = 0.2;
            mark.glow = 1;
            water.splashMark(mark);
          }
        }
      }
      const seed = pool.seed[index];
      const rate = pool.def.body.rate[0] + (pool.def.body.rate[1] - pool.def.body.rate[0]) * seed;
      pool.phase[index] = (pool.phase[index] + TWO_PI * rate * boost * dt) % (TWO_PI * 64);
      pool.gate[index] = 1;
      pool.bank[index] *= 0.95;
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  // ---- wading birds ------------------------------------------------------------------------------
  /**
   * Finds shallow water to stand in: depth (water height minus ground) within (0.06, depthMax), at
   * the anchor or the nearest point within searchRadius (rings 60 m apart, 24 bearings). Writes the
   * wading centre into HOME_X / HOME_Z and the agents' home offsets; false when there is none.
   */
  function seekShallows(data) {
    const g = data.g;
    const wade = data.params.surface.wade;
    const shallowAt = (x, z) => {
      const ground = groundAt(data, x, z);
      if (!isWaterAt(x, z, ground)) return false;
      const depth = waterHeightAt(x, z) - ground;
      return depth > 0.06 && depth < wade.depthMax;
    };
    let found = shallowAt(Math.round(g[G.ANCHOR_X]), Math.round(g[G.ANCHOR_Z]));
    if (found) {
      g[G.HOME_X] = Math.round(g[G.ANCHOR_X]);
      g[G.HOME_Z] = Math.round(g[G.ANCHOR_Z]);
    }
    for (let radius = 60; radius <= wade.searchRadius && !found; radius += 60) {
      for (let step = 0; step < 24 && !found; step++) {
        const angle = (step / 24) * TWO_PI;
        const x = Math.round(g[G.ANCHOR_X] + Math.sin(angle) * radius);
        const z = Math.round(g[G.ANCHOR_Z] - Math.cos(angle) * radius);
        if (shallowAt(x, z)) {
          found = true;
          g[G.HOME_X] = x;
          g[G.HOME_Z] = z;
        }
      }
    }
    if (!found) return false;
    // Homes: a golden-angle spiral around the centre, kept only in the shallows. On a narrow band (a
    // steep shore) the spiral mostly misses, so one scan of the rings around the centre collects free
    // shallow spots along the band for the birds it missed; only with none left does a bird share the
    // centre. (Create time only: the scan allocates and probes at most WADE_HOME_PROBES points.)
    const pool = data.pool;
    const legHeight = pool.def.wade.legHeight;
    const taken = new Set();
    const free = (x, z) => !taken.has(`${x},${z}`) && shallowAt(x, z);
    const unplaced = [];
    for (let index = data.start; index < data.start + data.count; index++) {
      const k = index - data.start;
      pool.homeX[index] = 0;
      pool.homeZ[index] = 0;
      let placed = false;
      for (let attempt = 0; attempt < 6 && !placed; attempt++) {
        const ring = Math.sqrt(k + 1 + attempt * data.count) * wade.spacing;
        const angle = (k + attempt * 7) * 2.399963;
        const x = Math.round(g[G.HOME_X] + Math.cos(angle) * ring);
        const z = Math.round(g[G.HOME_Z] + Math.sin(angle) * ring);
        if (free(x, z)) {
          pool.homeX[index] = x - g[G.HOME_X];
          pool.homeZ[index] = z - g[G.HOME_Z];
          taken.add(`${x},${z}`);
          placed = true;
        }
      }
      if (!placed) unplaced.push(index);
    }
    // The centre (shallow: the search found it) is the first free spot (a bird left there keeps its
    // zero offset), then the rings.
    const centreKey = `${g[G.HOME_X]},${g[G.HOME_Z]}`;
    if (unplaced.length > 0 && !taken.has(centreKey)) {
      taken.add(centreKey);
      unplaced.pop();
    }
    const ringLimit = Math.ceil(Math.sqrt(data.count) * 8);
    let probes = WADE_HOME_PROBES;
    for (let ringIndex = 1; ringIndex <= ringLimit && unplaced.length > 0 && probes > 0; ringIndex++) {
      const ring = ringIndex * wade.spacing;
      const steps = Math.max(12, Math.ceil((TWO_PI * ring) / wade.spacing));
      for (let step = 0; step < steps && unplaced.length > 0 && probes-- > 0; step++) {
        const angle = (step / steps) * TWO_PI;
        const x = Math.round(g[G.HOME_X] + Math.cos(angle) * ring);
        const z = Math.round(g[G.HOME_Z] + Math.sin(angle) * ring);
        if (!free(x, z)) continue;
        const index = unplaced.pop();
        pool.homeX[index] = x - g[G.HOME_X];
        pool.homeZ[index] = z - g[G.HOME_Z];
        taken.add(`${x},${z}`);
      }
    }
    for (let index = data.start; index < data.start + data.count; index++) {
      const homeX = pool.homeX[index];
      const homeZ = pool.homeZ[index];
      // A narrow shallow band (a steep shore): the bird stands still, so it never wades out of it.
      const spotX = g[G.HOME_X] + homeX;
      const spotZ = g[G.HOME_Z] + homeZ;
      const roomy = shallowAt(spotX + 1, spotZ) && shallowAt(spotX - 1, spotZ) && shallowAt(spotX, spotZ + 1) && shallowAt(spotX, spotZ - 1);
      pool.shuffle[index] = roomy ? WADE_SHUFFLE : WADE_SHUFFLE_NARROW;
      // The body stands legHeight above the bottom.
      pool.homeY[index] = groundAt(data, g[G.HOME_X] + homeX, g[G.HOME_Z] + homeZ) + legHeight * pool.scale[index] * g[G.SIZE];
    }
    g[G.HOME_Y] = waterHeightAt(g[G.HOME_X], g[G.HOME_Z]);
    g[G.X] = g[G.HOME_X];
    g[G.Y] = g[G.HOME_Y];
    g[G.Z] = g[G.HOME_Z];
    return true;
  }

  /** The waders' goal: their shallows while standing; a wide circle over the water while they fly. */
  function moveWaderGoal(data) {
    const dt = frameStep[0];
    const g = data.g;
    const wade = data.params.surface.wade;
    g[G.STAMPEDE_COOLDOWN] -= dt;
    if (g[G.FLUSH] > 0) {
      g[G.FLUSH] += dt;
      // Out of sight (the far tier) the birds are not simulated: once the longest flight and the glide
      // back are over, the flock is home, so a player who comes back finds it wading.
      if (data.instance.tier === 'far' && g[G.FLUSH] > wade.flySeconds[1] + WADER_RETURN_SECONDS) {
        settleWadersUnseen(data);
        return;
      }
      const angle = data.phaseSeed * TWO_PI + g[G.FLUSH] * (data.cruise / wade.flyRadius);
      g[G.X] = g[G.HOME_X] + Math.sin(angle) * wade.flyRadius;
      g[G.Z] = g[G.HOME_Z] - Math.cos(angle) * wade.flyRadius;
      g[G.Y] = g[G.HOME_Y] + wade.flyAltitude;
      g[G.VX] = Math.cos(angle) * data.cruise;
      g[G.VZ] = Math.sin(angle) * data.cruise;
      return;
    }
    g[G.X] = g[G.HOME_X];
    g[G.Y] = g[G.HOME_Y];
    g[G.Z] = g[G.HOME_Z];
    g[G.VX] = 0;
    g[G.VZ] = 0;
    if (g[G.STAMPEDE_COOLDOWN] > 0) return;
    // Buzzed: the craft within flushRadius of the flock takes it off, in a wave from the craft.
    const player = ctx.state.player.position;
    const dx = player.x - g[G.CX];
    const dy = player.y - g[G.CY];
    const dz = player.z - g[G.CZ];
    const reach = wade.flushRadius * threat[0];
    if (dx * dx + dy * dy + dz * dz > reach * reach) return;
    flushWaders(data, player.x, player.y, player.z);
  }

  /** The flock lands at home at once (the far tier): every bird standing, re-armed after the usual rest. */
  function settleWadersUnseen(data) {
    const g = data.g;
    const pool = data.pool;
    g[G.FLUSH] = 0;
    g[G.STAMPEDE_COOLDOWN] = 20;
    g[G.X] = g[G.HOME_X];
    g[G.Y] = g[G.HOME_Y];
    g[G.Z] = g[G.HOME_Z];
    g[G.VX] = 0;
    g[G.VZ] = 0;
    for (let index = data.start; index < data.start + data.count; index++) pool.mode[index] = WADE_STAND;
  }

  /** Every bird gets its take-off delay: farther from the trigger, later (the wave), plus a seeded spread. */
  function flushWaders(data, x, y, z) {
    const g = data.g;
    const pool = data.pool;
    const wave = data.params.surface.wade.takeoffWave;
    g[G.FLUSH] = 1e-3;
    g[G.FLUSH_X] = x;
    g[G.FLUSH_Y] = y;
    g[G.FLUSH_Z] = z;
    g[G.FLUSH_COUNT] = 0;
    for (let index = data.start; index < data.start + data.count; index++) {
      const dx = pool.px[index] - x;
      const dz = pool.pz[index] - z;
      pool.timer[index] = (Math.sqrt(dx * dx + dz * dz) / 10) * wave.delay + pool.seed[index] * wave.spread;
      pool.gait[index] = 0;
      pool.aux[index] = rangeValue(data.params.surface.wade.flySeconds, data.rng);
    }
    ctx.bus.emit('fauna:flush', {
      id: data.instance.id, presetId: data.instance.presetId, species: pool.def.id, count: data.count,
      position: { x: g[G.CX], y: g[G.CY], z: g[G.CZ] },
    });
  }

  function simulateWaders(data) {
    const dt = frameStep[0];
    const pool = data.pool;
    const g = data.g;
    const wade = data.params.surface.wade;
    const start = data.start;
    const end = start + data.count;
    const water = ctx.water;
    const time = g[G.TIME];
    const flying = g[G.FLUSH] > 0;
    let standing = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    io[IO.TIME] = time;
    io[IO.GLIDE] = pool.def.flap.glideShare;
    for (let index = start; index < end; index++) {
      const scale = pool.scale[index] * g[G.SIZE];
      const homeX = g[G.HOME_X] + pool.homeX[index];
      const homeZ = g[G.HOME_Z] + pool.homeZ[index];
      const standY = pool.homeY[index];
      let mode = pool.mode[index];
      if (mode === WADE_STAND) {
        // pool.gait (a quadruped's gait) marks a wading bird that has flown in this flush.
        if (flying && pool.gait[index] === 0) {
          pool.timer[index] -= dt;
          if (pool.timer[index] <= 0) {
            pool.gait[index] = 1;
            mode = WADE_TAKEOFF;
            pool.mode[index] = mode;
            pool.aux2[index] = 0;
            g[G.FLUSH_COUNT] += 1;
            // Away from the trigger along the water.
            const awayX = pool.px[index] - g[G.FLUSH_X];
            const awayZ = pool.pz[index] - g[G.FLUSH_Z];
            const awayLength = Math.sqrt(awayX * awayX + awayZ * awayZ) || 1;
            pool.vx[index] = (awayX / awayLength) * 3;
            pool.vz[index] = (awayZ / awayLength) * 3;
            pool.vy[index] = 0;
          }
        }
        if (mode === WADE_STAND) {
          // Standing in the shallows: a slow shuffle about the home spot, wings folded.
          const shuffle = time * 0.07 + pool.seed[index] * TWO_PI;
          const targetX = homeX + Math.sin(shuffle) * pool.shuffle[index];
          const targetZ = homeZ + Math.cos(shuffle * 0.8) * pool.shuffle[index];
          pool.vx[index] = (targetX - pool.px[index]) * 0.4;
          pool.vy[index] = 0;
          pool.vz[index] = (targetZ - pool.pz[index]) * 0.4;
          pool.px[index] += pool.vx[index] * dt;
          pool.py[index] += (standY - pool.py[index]) * Math.min(1, dt * 3);
          pool.pz[index] += pool.vz[index] * dt;
          pool.gate[index] += (-1 - pool.gate[index]) * Math.min(1, dt * 2.5);
          pool.phase[index] = (pool.phase[index] + dt * 2) % (TWO_PI * 64);
          standing++;
        }
      }
      if (mode === WADE_TAKEOFF || mode === WADE_FLY || mode === WADE_LAND) {
        steering[0] = 0;
        steering[1] = 0;
        steering[2] = 0;
        pool.aux2[index] += dt;
        if (mode === WADE_TAKEOFF) {
          // A running take-off: flapping hard, speed building along the water, then the climb.
          const run = pool.aux2[index];
          const awayLength = Math.sqrt(pool.vx[index] * pool.vx[index] + pool.vz[index] * pool.vz[index]) || 1;
          steering[0] = (pool.vx[index] / awayLength) * 6;
          steering[2] = (pool.vz[index] / awayLength) * 6;
          steering[1] = run > 0.8 ? 3 : 0;
          if (water && run < 1.4 && pool.timer[index] <= 0) {
            pool.timer[index] = 0.22;
            const mark = data.waterMark;
            mark.x = pool.px[index] - pool.vx[index] * 0.3;
            mark.z = pool.pz[index] - pool.vz[index] * 0.3;
            mark.x1 = pool.px[index];
            mark.z1 = pool.pz[index];
            mark.radius = 0.6 * scale;
            mark.foam = 0.6;
            mark.glow = 1;
            water.trail(mark);
          }
          pool.timer[index] -= dt;
          if (pool.py[index] > standY + 6) pool.mode[index] = WADE_FLY;
        } else if (mode === WADE_FLY) {
          // A loose flock on the group's circle, each bird on its own offset.
          io[IO.TARGET_X] = g[G.X] + pool.homeX[index] * 2.2;
          io[IO.TARGET_Y] = g[G.Y] + (pool.seed[index] - 0.5) * 10;
          io[IO.TARGET_Z] = g[G.Z] + pool.homeZ[index] * 2.2;
          io[IO.FEED_X] = g[G.VX];
          io[IO.FEED_Y] = 0;
          io[IO.FEED_Z] = g[G.VZ];
          io[IO.GAIN] = 0.4;
          io[IO.WEIGHT] = 1;
          io[IO.SEEK_MAX] = data.speedRange[1];
          steerToward(pool, index);
          if (g[G.FLUSH] > pool.aux[index]) pool.mode[index] = WADE_LAND;
        } else {
          // Settling back: glide to the home spot, slowing with the distance, and stand.
          const toX = homeX - pool.px[index];
          const toZ = homeZ - pool.pz[index];
          const distance = Math.sqrt(toX * toX + toZ * toZ);
          const approach = Math.min(data.cruise, Math.max(1.5, distance * 0.25));
          io[IO.TARGET_X] = homeX;
          io[IO.TARGET_Y] = standY + Math.min(distance * 0.12, 30);
          io[IO.TARGET_Z] = homeZ;
          io[IO.FEED_X] = 0;
          io[IO.FEED_Y] = 0;
          io[IO.FEED_Z] = 0;
          io[IO.GAIN] = 0.6;
          io[IO.WEIGHT] = 1.2;
          io[IO.SEEK_MAX] = approach;
          steerToward(pool, index);
          if (distance < 7 && pool.py[index] < standY + 3) {
            pool.mode[index] = WADE_STAND;
            pool.vx[index] = 0;
            pool.vy[index] = 0;
            pool.vz[index] = 0;
          }
        }
        if (pool.mode[index] !== WADE_STAND) {
          io[IO.ACCEL] = 9;
          io[IO.CLIMB] = 4;
          io[IO.MIN_SPEED] = pool.mode[index] === WADE_LAND ? 0.5 : 2;
          io[IO.MAX_SPEED] = data.speedRange[1];
          io[IO.BANK_BLEND] = Math.min(1, dt * 2.5);
          io[IO.FLOOR] = standY - 0.5;
          integrate(pool, index);
          animateBird(pool, index, pool.mode[index] === WADE_TAKEOFF);
          if (pool.mode[index] === WADE_LAND && pool.py[index] < standY + 3) pool.gate[index] += (-0.2 - pool.gate[index]) * Math.min(1, dt * 2);
        }
      }
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    if (flying && standing === data.count && g[G.FLUSH_COUNT] > 0) {
      // Everyone is back: re-armed after a short rest.
      g[G.FLUSH] = 0;
      g[G.STAMPEDE_COOLDOWN] = 20;
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  function simulateSurface(data) {
    const dt = frameStep[0];
    if (data.pool.def.wade) simulateWaders(data);
    else simulateDolphins(data);
  }

  // =============================================================================================
  // SHARED PER-GROUP STEPS
  // =============================================================================================
  /** The group's centroid from the position sums io[SUM_*], and its sampled radius. */
  function finishCentroid(data) {
    const g = data.g;
    const pool = data.pool;
    const count = data.count;
    g[G.CX] = io[IO.SUM_X] / count;
    g[G.CY] = io[IO.SUM_Y] / count;
    g[G.CZ] = io[IO.SUM_Z] / count;
    let radiusSq = 0;
    const end = data.start + count;
    // Sampled radius (every 8th agent): cheap enough for thousands.
    const stride = count > 256 ? 8 : 1;
    for (let index = data.start; index < end; index += stride) {
      const dx = pool.px[index] - g[G.CX];
      const dy = pool.py[index] - g[G.CY];
      const dz = pool.pz[index] - g[G.CZ];
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > radiusSq) radiusSq = distanceSq;
    }
    g[G.RADIUS] = Math.sqrt(radiusSq) + 4;
  }

  /**
   * The spawn's anchor (a THREE.Vector3 the SpawnManager reads for the LOD, the lure, discovery and
   * audio) at the group's centroid, in whole metres: V8 boxes every non-integer double written into a
   * Vector3 field, and a metre is far below what those uses resolve.
   */
  function writeAnchor(instance, g) {
    instance.anchor.x = Math.round(g[G.CX]);
    instance.anchor.y = Math.round(g[G.CY]);
    instance.anchor.z = Math.round(g[G.CZ]);
  }

  /** The group's centroid and radius from its agents' positions. */
  function recomputeCentroid(data) {
    const pool = data.pool;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (let index = data.start; index < data.start + data.count; index++) {
      sumX += pool.px[index];
      sumY += pool.py[index];
      sumZ += pool.pz[index];
    }
    io[IO.SUM_X] = sumX;
    io[IO.SUM_Y] = sumY;
    io[IO.SUM_Z] = sumZ;
    finishCentroid(data);
  }

  /** Places every agent around the goal (on create and when coming back from the far tier). */
  function seedAgents(data) {
    const pool = data.pool;
    const g = data.g;
    const params = data.params;
    const start = data.start;
    const end = start + data.count;
    const behavior = params.behavior;
    const forwardX = Math.sin(g[G.HEADING]);
    const forwardZ = (-Math.cos(g[G.HEADING]));
    const sizeScale = g[G.SIZE];
    for (let index = start; index < end; index++) {
      const k = index - start;
      let x = g[G.X];
      let y = g[G.Y];
      let z = g[G.Z];
      if (behavior === 'murmuration') {
        const radius = params.murmuration.radius * sizeScale;
        x += pool.homeX[index] * radius;
        y += pool.homeY[index] * radius * params.murmuration.flatten;
        z += pool.homeZ[index] * radius;
      } else if (behavior === 'formation') {
        io[IO.SIZE_SCALE] = sizeScale;
        slotOffset(params.formation, k);
        x += -forwardX * steering[0] - forwardZ * steering[1];
        y += steering[2];
        z += -forwardZ * steering[0] + forwardX * steering[1];
      } else if (behavior === 'circling') {
        const angle = pool.seed[index] * TWO_PI;
        x += Math.cos(angle) * pool.homeX[index] + (pool.homeZ[index] - 0.5) * 400;
        z += Math.sin(angle) * pool.homeX[index] + (pool.aux[index] - 0.5) * 400;
        y += (pool.seed[index] - 0.5) * 120;
      } else if (behavior === 'pod' || behavior === 'drift') {
        const lane = behavior === 'drift' ? params.drift.lane * pool.scale[index] * sizeScale : 1;
        x += (forwardX * pool.homeZ[index] - forwardZ * pool.homeX[index]) * lane;
        z += (forwardZ * pool.homeZ[index] + forwardX * pool.homeX[index]) * lane;
        if (behavior === 'drift') y += pool.homeY[index] * lane * 0.3;
        else y = waterSurface(x, z) - (pool.mode[index] === WHALE_SURFACE ? pool.def.size * 0.125 * 0.55 : params.pod.depth) * pool.scale[index] * sizeScale;
      } else if (behavior === 'wingman') {
        const angle = pool.seed[index] * TWO_PI;
        x += Math.cos(angle) * params.wingman.waitRadius;
        z += Math.sin(angle) * params.wingman.waitRadius;
      } else if (behavior === 'herd') {
        const spacing = params.herd.spacing * sizeScale;
        x += (-forwardZ * pool.homeX[index] + forwardX * pool.homeZ[index]) * spacing;
        z += (forwardX * pool.homeX[index] + forwardZ * pool.homeZ[index]) * spacing;
        io[IO.SAMPLE_X] = x;
        io[IO.SAMPLE_Z] = z;
        sampleFine(data.fine);
        y = io[IO.GROUND];
      } else if (behavior === 'surface' && pool.def.wade) {
        // On their home spots in the shallows, standing.
        x = g[G.HOME_X] + pool.homeX[index];
        z = g[G.HOME_Z] + pool.homeZ[index];
        y = pool.homeY[index];
        pool.mode[index] = WADE_STAND;
        pool.gate[index] = -1;
      } else if (behavior === 'surface') {
        x += (forwardX * pool.homeZ[index] - forwardZ * pool.homeX[index]) * params.surface.spread;
        z += (forwardZ * pool.homeZ[index] + forwardX * pool.homeX[index]) * params.surface.spread;
        pool.homeY[index] = waterHeightAt(Math.round(x), Math.round(z));
        y = pool.homeY[index] - 0.25 * pool.scale[index] * sizeScale;
        pool.mode[index] = SWIM;
      } else if (behavior === 'column') {
        // Placed on the path below (simulateColumn with no time step).
      } else {
        const angle = pool.seed[index] * TWO_PI;
        const radius = Math.sqrt(pool.homeX[index] * 0.5 + 0.5) * 14 * sizeScale;
        x += Math.cos(angle) * radius;
        y += (pool.homeY[index]) * 6;
        z += Math.sin(angle) * radius;
      }
      pool.px[index] = x;
      pool.py[index] = y;
      pool.pz[index] = z;
      const still = behavior === 'herd' || (behavior === 'surface' && pool.def.wade);
      const speed = still ? 0 : behavior === 'pod' ? data.cruise * 0.8 : data.cruise;
      pool.vx[index] = forwardX * speed;
      pool.vy[index] = 0;
      pool.vz[index] = forwardZ * speed;
      pool.bank[index] = 0;
      pool.excite[index] = 0;
      pool.flockX[index] = 0;
      pool.flockY[index] = 0;
      pool.flockZ[index] = 0;
    }
    g[G.CX] = g[G.X];
    g[G.CY] = g[G.Y];
    g[G.CZ] = g[G.Z];
    if (behavior === 'column') {
      // Placed on the path with no time step (the frame's step is restored after).
      const step = frameStep[0];
      frameStep[0] = 0;
      simulateColumn(data);
      frameStep[0] = step;
    }
    if (behavior === 'surface' && pool.def.wade && g[G.FLUSH] > 0) {
      g[G.FLUSH] = 0;
      g[G.STAMPEDE_COOLDOWN] = 10;
    }
  }

  /** Writes the group's agents into the species buffers (hidden: scale 0). */
  function writeAgents(data, hidden) {
    const pool = data.pool;
    const g = data.g;
    const origin = pool.origin;
    const start = data.start;
    const end = start + data.count;
    const fade = g[G.FADE];
    const size = g[G.SIZE];
    const positionData = pool.positionData;
    const directionData = pool.directionData;
    const animData = pool.animData;
    for (let index = start; index < end; index++) {
      const offset = index * 4;
      if (hidden) {
        positionData[offset + 3] = 0;
        continue;
      }
      positionData[offset] = pool.px[index] - origin.x;
      positionData[offset + 1] = pool.py[index] - origin.y;
      positionData[offset + 2] = pool.pz[index] - origin.z;
      positionData[offset + 3] = pool.scale[index] * size * fade;
      const vx = pool.vx[index];
      const vy = pool.vy[index];
      const vz = pool.vz[index];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > 0.05) {
        directionData[offset] = vx / speed;
        directionData[offset + 1] = vy / speed;
        directionData[offset + 2] = vz / speed;
      }
      directionData[offset + 3] = pool.bank[index];
      animData[offset] = pool.phase[index];
      animData[offset + 1] = pool.gate[index];
      const kind = pool.def.kind;
      animData[offset + 2] = kind === 'whale' ? (pool.mode[index] === WHALE_BREACH ? 0.35 : 1) : kind === 'quadruped' ? pool.gait[index] : pool.excite[index];
      animData[offset + 3] = pool.seed[index];
    }
    pool.attributes.position.needsUpdate = true;
    if (!hidden) {
      pool.attributes.direction.needsUpdate = true;
      pool.attributes.anim.needsUpdate = true;
      pool.drawing++;
    }
    pool.mesh.count = pool.ranges.highWater;
    pool.mesh.visible = pool.drawing > 0;
  }

  /** Calls on the preset's interval (whale songs). */
  function updateCalls(data, dt) {
    const calls = data.params.calls;
    const interval = data.params.behavior === 'pod' ? data.params.pod.callInterval : calls.interval;
    if (!data.voice || !interval) return;
    const g = data.g;
    g[G.CALL_TIMER] -= dt;
    if (g[G.CALL_TIMER] > 0) return;
    g[G.CALL_TIMER] = rangeValue(interval, data.rng);
    if (quietSources.size === 0) data.voice.trigger(calls.trigger);
  }

  function updateVoice(instance, data) {
    if (!data.voice) return;
    const g = data.g;
    data.voice.setPosition(instance.anchor);
    // While the wildlife is quiet the level drops to 0 (the audio engine eases between levels).
    let intensity = quietSources.size > 0 ? 0 : data.params.voiceIntensity * g[G.FADE];
    if (data.params.behavior === 'murmuration' || data.params.behavior === 'flock') {
      // The wing rush swells as the player nears the flock.
      const reach = Math.max(200, g[G.RADIUS] * 3);
      intensity *= Math.min(Math.max(1 - (g[G.PLAYER_DISTANCE] - g[G.RADIUS]) / reach, 0.15), 1);
    }
    // A herd's rumble swells with its gait (a stampede is loud).
    if (data.params.behavior === 'herd') intensity *= 0.3 + 0.7 * g[G.GAIT];
    data.voice.setIntensity(intensity);
  }

  const GOAL_MOVERS = Object.freeze({
    murmuration: moveWanderGoal,
    flock: moveWanderGoal,
    formation: moveFormationGoal,
    circling: null,
    pod: movePodGoal,
    wingman: null,
    drift: moveDriftGoal,
    herd: moveHerdGoal,
    column: null,
    surface: moveSurfaceGoal,
  });

  function playerDistance(data) {
    const g = data.g;
    const player = ctx.state.player.position;
    const dx = player.x - g[G.CX];
    const dy = player.y - g[G.CY];
    const dz = player.z - g[G.CZ];
    g[G.PLAYER_DISTANCE] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // =============================================================================================
  // CREATE
  // =============================================================================================
  function speciesDefaults(def, params) {
    const speed = Number.isFinite(params.speed) ? params.speed : def.cruise;
    return { cruise: speed, speedRange: [def.speed[0], Math.max(def.speed[1], speed * 1.2)] };
  }

  /** Per-agent constants for the behaviour: home points, radii, lanes, timers. */
  function initAgents(data, rng) {
    const pool = data.pool;
    const params = data.params;
    const start = data.start;
    const end = start + data.count;
    for (let index = start; index < end; index++) {
      const k = index - start;
      pool.seed[index] = rng();
      pool.scale[index] = 1 + (rng() * 2 - 1) * params.sizeJitter;
      pool.phase[index] = rng() * TWO_PI;
      pool.gate[index] = 1;
      pool.excite[index] = 0;
      pool.mode[index] = 0;
      pool.timer[index] = 0;
      pool.aux[index] = rng();
      pool.aux2[index] = 0;
      if (params.behavior === 'murmuration' || params.behavior === 'flock') {
        // A home point in the unit ball (uniform).
        let x;
        let y;
        let z;
        do {
          x = rng() * 2 - 1;
          y = rng() * 2 - 1;
          z = rng() * 2 - 1;
        } while (x * x + y * y + z * z > 1);
        pool.homeX[index] = x;
        pool.homeY[index] = y;
        pool.homeZ[index] = z;
      } else if (params.behavior === 'circling') {
        pool.homeX[index] = rangeValue(params.circling.radius, rng);
        pool.homeY[index] = rng() < 0.5 ? -1 : 1;
        pool.homeZ[index] = rng();
        pool.aux2[index] = k;
      } else if (params.behavior === 'pod') {
        // Lanes: loosely abreast and staggered.
        pool.homeX[index] = (rng() * 2 - 1) * params.pod.spread;
        pool.homeZ[index] = (rng() * 2 - 1) * params.pod.spread * 0.6;
        pool.mode[index] = rng() < 0.6 ? WHALE_SURFACE : WHALE_DEEP;
        pool.timer[index] = pool.mode[index] === WHALE_SURFACE ? rangeValue(params.pod.surfaceSeconds, rng) : rangeValue(params.pod.diveSeconds, rng) * rng();
        pool.aux[index] = rng() * 3;
      } else if (params.behavior === 'herd') {
        // A loose sunflower (golden angle), in units of the herd spacing: x across, z along.
        const ring = Math.sqrt(k + 0.5) * 0.62;
        const angle = k * 2.399963 + rng() * 0.4;
        pool.homeX[index] = Math.cos(angle) * ring;
        pool.homeZ[index] = Math.sin(angle) * ring * 1.3;
        pool.mode[index] = rng() < params.herd.graze ? HERD_GRAZE : HERD_WALK;
        pool.timer[index] = rng() * 10;
        pool.aux2[index] = 0;
      } else if (params.behavior === 'column') {
        // Jitter across (x) and along (z) the line.
        pool.homeX[index] = (rng() * 2 - 1) * params.column.jitter;
        pool.homeZ[index] = (rng() * 2 - 1) * params.column.jitter * 2;
        pool.aux2[index] = 0;
      } else if (params.behavior === 'surface') {
        pool.homeX[index] = rng() * 2 - 1;
        pool.homeZ[index] = (rng() * 2 - 1) * 0.7;
        pool.mode[index] = 0;
        pool.timer[index] = rangeValue(params.surface.porpoise.interval, rng) * rng();
        pool.gate[index] = SPECIES[params.species].wade ? -1 : 1;
      } else if (params.behavior === 'drift') {
        pool.homeX[index] = k === 0 ? 0 : (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2);
        pool.homeY[index] = k === 0 ? 0 : -0.5 * Math.ceil(k / 2);
        pool.homeZ[index] = k === 0 ? 0 : -0.7 * Math.ceil(k / 2);
        if (k > 0) pool.scale[index] *= 0.45;
      } else {
        pool.homeX[index] = rng() * 2 - 1;
        pool.homeY[index] = rng() * 2 - 1;
        pool.homeZ[index] = rng();
      }
    }
  }

  function create(preset, params, rng) {
    const resolved = resolveParams(params);
    const def = SPECIES[resolved.species];
    const pool = pools[def.id];
    const count = Math.max(1, Math.round(rangeValue(resolved.countRange, rng)));
    const start = pool.ranges.alloc(count);
    if (start < 0) throw new Error(`fauna: no room for ${count} more ${def.id} (${pool.ranges.used} of ${pool.capacity} in use)`);
    // The setup can refuse (an unknown audio recipe throws): the manager never receives an instance
    // to dispose then, so the agent range goes back to the species pool before the error goes on.
    try {
      return createGroup(preset, params, rng, resolved, def, pool, start, count);
    } catch (error) {
      pool.ranges.free(start);
      pool.mesh.count = pool.ranges.highWater;
      if (pool.ranges.highWater === 0) pool.mesh.visible = false;
      throw error;
    }
  }

  /** The rest of create() once the group's agent range [start, start + count) is allocated. */
  function createGroup(preset, params, rng, resolved, def, pool, start, count) {
    const g = new Float64Array(G_LENGTH);
    const anchor = params.position;
    const speeds = speciesDefaults(def, resolved);
    const heading = Number.isFinite(params.heading) ? params.heading * DEG : rng() * TWO_PI;
    g[G.ANCHOR_X] = anchor.x;
    g[G.ANCHOR_Y] = anchor.y;
    g[G.ANCHOR_Z] = anchor.z;
    g[G.X] = anchor.x;
    g[G.Z] = anchor.z;
    g[G.HEADING] = heading;
    g[G.SPEED] = speeds.cruise;
    g[G.TARGET_SPEED] = speeds.cruise;
    g[G.SIZE] = resolved.size * (Number.isFinite(params.scale) ? params.scale : 1);
    // Whole metres: the probe coordinates stay integers, which V8 passes to the terrain without boxing.
    g[G.GROUND_SPACING] = resolved.behavior === 'murmuration' ? Math.max(120, Math.round(resolved.murmuration.radius * g[G.SIZE])) : 150;
    g[G.THERMAL_TIMER] = 0;
    g[G.CALL_TIMER] = 3 + rng() * 6;
    g[G.SIDE] = resolved.wingman.side === 1 || resolved.wingman.side === -1 ? resolved.wingman.side : 0;
    const data = {
      instance: null,
      preset,
      params: resolved,
      pool,
      start,
      count,
      g,
      rng,
      cruise: speeds.cruise,
      speedRange: speeds.speedRange,
      phaseSeed: rng(),
      ground: new Float64Array(GROUND_GRID * GROUND_GRID),
      groundCursor: 0,
      groundWait: 0,
      neighborSlice: 0,
      hidden: false,
      mode: MODE_WAIT,
      duration: Number.isFinite(params.duration) ? params.duration : null,
      voice: null,
      thermals: null,
      thermalVisitor: null,
      spout: null,
      waterMark: null,
      wind: null,
      windAttached: false,
      formationState: null,
      noThermal: false,
      noWater: false,
      noGround: false,
      runSpeed: 0,
      waterWait: 0,
      fine: null,
      path: null,
      follower: null,
      dustStart: -1,
      dustCount: 0,
      dustCursor: 0,
      dustParams: null,
      dustColor: null,
    };
    if (resolved.behavior === 'pod' && resolved.pod.seekWater > 0 && !seekOpenWater(g, resolved.pod.seekWater, resolved.pod.spread)) data.noWater = true;
    fillGround(data);
    // The goal's starting height from the altitude mode.
    const altitude = resolved.altitude;
    groundUnderGoal(data);
    const ground = io[IO.GROUND];
    if (altitude.mode === 'player') {
      // Near the player's own height (offset by value), kept between the floor and the ceiling above
      // the ground there; from then on the group holds that height above sea level.
      const playerY = ctx.state && ctx.state.player ? ctx.state.player.position.y : ground + altitude.value;
      const wanted = playerY + altitude.value + (rng() * 2 - 1) * altitude.spread;
      altitude.value = Math.min(Math.max(wanted, ground + resolved.floor + 30), ground + Math.max(resolved.floor + 30, altitude.ceiling));
      altitude.mode = 'msl';
    }
    if (resolved.behavior === 'pod') g[G.Y] = waterSurface(g[G.X], g[G.Z]);
    else if (altitude.mode === 'msl') g[G.Y] = Math.max(altitude.value, ground + resolved.floor + 10);
    else if (altitude.mode === 'water') g[G.Y] = waterSurface(g[G.X], g[G.Z]);
    else g[G.Y] = ground + altitude.value + (rng() * 2 - 1) * altitude.spread;
    if (resolved.behavior === 'wingman') g[G.Y] = Math.max(g[G.Y], ground + resolved.wingman.waitAltitude);
    g[G.BASE_Y] = g[G.Y];
    if (resolved.behavior === 'drift') g[G.Y] += Math.sin(data.phaseSeed * TWO_PI) * resolved.drift.bob;
    if (resolved.behavior === 'circling') {
      data.thermals = {
        count: 0,
        x: new Float64Array(8), z: new Float64Array(8), capX: new Float64Array(8), capZ: new Float64Array(8),
        ground: new Float64Array(8), top: new Float64Array(8), radius: new Float64Array(8), strength: new Float64Array(8),
      };
      data.thermalVisitor = createThermalVisitor(data);
      g[G.ANCHOR_Y] = ground;
    }
    if (resolved.behavior === 'formation') {
      g[G.SLOT_DISTANCE] = Infinity;
      data.formationState = createFormationState(g, resolved.formation.holdSeconds);
    }
    if (resolved.behavior === 'herd') {
      const span = Math.max(96, resolved.herd.spacing * g[G.SIZE] * Math.sqrt(count) * 2.4);
      data.fine = createFineGround(Math.max(8, Math.ceil(span / (FINE_GRID - 1))));
      if (!seekClearGround(data, 1500)) data.noGround = true;
      io[IO.SAMPLE_X] = g[G.X];
      io[IO.SAMPLE_Z] = g[G.Z];
      sampleFine(data.fine);
      g[G.Y] = io[IO.GROUND];
      g[G.BASE_Y] = g[G.Y];
      g[G.SPEED] = resolved.herd.gaits.walk * (1 - resolved.herd.graze * 0.6);
      // A plain number (a null-or-number read in the frame would box the other branch's double).
      data.runSpeed = resolved.herd.stampede.speed ?? resolved.herd.gaits.run;
      g[G.STAMPEDE_TIMER] = resolved.herd.stampede.interval * (0.5 + data.phaseSeed * 0.5);
      g[G.STAMPEDE_COOLDOWN] = 4;
    }
    if (resolved.behavior === 'column' && !buildColumnPath(data, heading)) data.noGround = true;
    if (resolved.behavior === 'surface') {
      g[G.SPEED] = speeds.cruise;
      if (def.wade) {
        if (!seekShallows(data)) data.noWater = true;
        g[G.STAMPEDE_COOLDOWN] = 2;
      } else {
        if (!seekOpenWater(g, 3000, resolved.surface.spread * 3)) data.noWater = true;
        g[G.Y] = waterHeightAt(Math.round(g[G.X]), Math.round(g[G.Z]));
        g[G.BASE_Y] = g[G.Y];
      }
    }
    if ((resolved.behavior === 'pod' || resolved.behavior === 'surface') && ctx.water) {
      data.waterMark = ctx.water.createMark();
      data.spout = ctx.water.createSpray({ speed: 12, up: 1, spread: 0.1, size: 1.4, sizeGrowth: 1.4, life: 2.6, drag: 1.1, gravity: 0.35, alpha: 0.6, glow: resolved.pod.glow * 0.8 });
    }
    initAgents(data, rng);
    if (resolved.behavior === 'surface' && def.wade && !data.noWater) seekShallows(data);
    if (!data.noGround) seedAgents(data);
    if (resolved.behavior === 'circling') {
      // Spread the birds over the first thermals they find.
      refreshThermals(data);
      g[G.THERMAL_TIMER] = resolved.circling.thermalRefresh;
      for (let index = start; index < start + count; index++) {
        const thermal = index % data.thermals.count;
        pool.aux2[index] = thermal;
        const angle = pool.seed[index] * TWO_PI;
        pool.px[index] = data.thermals.x[thermal] + Math.cos(angle) * pool.homeX[index];
        pool.pz[index] = data.thermals.z[thermal] + Math.sin(angle) * pool.homeX[index];
        pool.py[index] = data.thermals.ground[thermal] + resolved.circling.bottom + pool.seed[index] * 250;
      }
    }
    const instance = {
      anchor,
      radius: 30,
      windSourceIds: [],
      lights: 0,
      particles: count,
      tier: 'near',
      data,
    };
    data.instance = instance;
    // A pod with no open water in reach, or birds that must mark a thermal and found none, end at once
    // (a natural end: the manager removes the spawn on its next frame, before anything is drawn).
    if (data.noWater || data.noThermal || data.noGround) instance.ended = true;
    if (resolved.behavior === 'herd') instance.particles += allocDust(data, resolved.herd.dust);
    if (resolved.behavior === 'column') instance.particles += allocDust(data, resolved.column.dust);
    if (resolved.behavior === 'drift' && resolved.drift.slipstream) {
      g[G.LEAD_X] = g[G.X];
      g[G.LEAD_Y] = g[G.Y];
      g[G.LEAD_Z] = g[G.Z];
      g[G.LEAD_HEADING] = heading;
      data.wind = createSlipstream(data, `fauna:${Math.floor(g[G.ANCHOR_X])}:${Math.floor(g[G.ANCHOR_Z])}:${start}`);
    }
    if (ownsPresetAudio(preset, 'fauna', resolved.voice) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
      data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: 0 });
    }
    recomputeCentroid(data);
    anchor.set(g[G.CX], g[G.CY], g[G.CZ]);
    instance.radius = Math.max(30, g[G.RADIUS]);
    live++;
    liveInstances.add(instance);
    return instance;
  }

  // =============================================================================================
  // ENGINE
  // =============================================================================================
  return {
    name: 'fauna',
    init(engineCtx) {
      ctx = engineCtx;
      THREE = engineCtx.THREE;
      for (const id of Object.keys(SPECIES)) {
        pools[id] = createSpeciesPool(SPECIES[id]);
        poolList.push(pools[id]);
      }
      gridNext = new Int32Array(maxAgents);
      dust = createDustPool();
      if (ctx.bus && typeof ctx.bus.onTyped === 'function') {
        ctx.bus.onTyped('wildlifeQuiet', ({ source, quiet }) => {
          if (quiet) quietSources.add(source);
          else quietSources.delete(source);
        });
      }
    },
    create,
    update(instance, dt) {
      frameStep[0] = dt;
      beginFrame();
      const data = instance.data;
      const g = data.g;
      const params = data.params;
      g[G.AGE] += dt;
      g[G.TIME] += dt;
      g[G.FADE] = params.fadeIn > 0 ? Math.min(Math.max(g[G.AGE] / params.fadeIn, 0), 1) : 1;
      if (data.duration !== null && (params.behavior !== 'wingman' || data.mode === MODE_WAIT)) endWithDuration(instance, data);
      g[G.SCATTER_COOLDOWN] -= dt;
      const mover = GOAL_MOVERS[params.behavior];
      if (dt > 0 && mover) mover(data, dt);
      if (instance.tier === 'far') {
        if (!data.hidden) {
          data.hidden = true;
          writeAgents(data, true);
        }
        // At far only the group moves (circling birds and a waiting wingman hold their place).
        g[G.CX] = g[G.X];
        g[G.CY] = g[G.Y];
        g[G.CZ] = g[G.Z];
        if (data.wind && data.windAttached) detachSlipstream(instance, data);
        if (data.dustStart >= 0) clearDust(data);
        writeAnchor(instance, g);
        updateVoice(instance, data);
        return;
      }
      if (data.hidden) {
        data.hidden = false;
        if (data.fine) fillFine(data, g[G.X], g[G.Z]);
        seedAgents(data);
      }
      if (dt > 0) {
        probeGround(data);
        playerDistance(data);
        const behavior = params.behavior;
        if (behavior === 'murmuration') simulateMurmuration(data, dt, instance.tier);
        else if (behavior === 'flock') simulateFlock(data, dt, instance.tier);
        else if (behavior === 'formation') simulateFormation(data, dt);
        else if (behavior === 'circling') simulateCircling(data, dt);
        else if (behavior === 'pod') simulatePod(data, dt);
        else if (behavior === 'wingman') simulateWingman(instance, data, dt);
        else if (behavior === 'herd') simulateHerd(data);
        else if (behavior === 'column') simulateColumn(data);
        else if (behavior === 'surface') simulateSurface(data);
        else simulateDrift(data, dt);
        if (behavior !== 'pod' && behavior !== 'drift' && behavior !== 'herd' && behavior !== 'column' && behavior !== 'surface') scatterFromPlayer(data.pool, data, data.start, data.start + data.count);
        updateCalls(data, dt);
        if (data.wind) {
          if (!data.windAttached) attachSlipstream(instance, data);
          else if (data.wind.refresh(false)) ctx.wind.setSourceBounds(data.wind.source.id, data.wind.bounds);
        }
      }
      writeAgents(data, false);
      writeAnchor(instance, g);
      // Whole metres (an integer store never boxes).
      instance.radius = Math.max(20, Math.round(g[G.RADIUS]));
      updateVoice(instance, data);
    },
    setLOD(instance, tier) {
      instance.tier = tier;
      if (tier === 'far' && instance.data.wind) detachSlipstream(instance, instance.data);
    },
    dispose(instance) {
      const data = instance.data;
      detachSlipstream(instance, data);
      writeAgents(data, true);
      freeDust(data);
      data.pool.ranges.free(data.start);
      data.pool.mesh.count = data.pool.ranges.highWater;
      if (data.pool.ranges.highWater === 0) data.pool.mesh.visible = false;
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      data.thermalVisitor = null;
      liveInstances.delete(instance);
      live--;
    },
    stats() {
      let particles = 0;
      let drawCalls = 0;
      const species = {};
      for (const instance of liveInstances) particles += instance.particles;
      for (const id of Object.keys(pools)) {
        const pool = pools[id];
        if (pool.mesh.visible && pool.mesh.count > 0) drawCalls++;
        const used = pool.ranges.used;
        if (used > 0) species[id] = used;
      }
      if (dust && dust.sprite.visible) drawCalls++;
      return {
        instances: live, particles, lights: 0, buffers: Object.keys(pools).length * 3 + 2, drawCalls, species, quiet: quietSources.size > 0,
        dustSlots: dust ? dust.ranges.used : 0, threat: threat[0],
      };
    },
    /**
     * The formation-slot API: the live formation state of a spawn's formation part, or null:
     * { inSlot, holdSeconds, bestHoldSeconds, complete, distance (m, player to slot), slot: { x, y, z },
     * holdTarget (s) }. Read it, never keep it past the spawn. Bus 'fauna:formation' reports enter,
     * leave and complete.
     */
    getFormation(spawnId) {
      if (!ctx || !ctx.spawns) return null;
      for (const part of ctx.spawns.getParts(spawnId)) {
        if (part && part.engine === 'fauna' && part.data && part.data.formationState) return part.data.formationState;
      }
      return null;
    },
    /**
     * Live params (the set-piece engine's hook): 'stampede' (a value >= 0.5 starts a herd's stampede
     * from the player's side, the event trigger) and 'flush' (>= 0.5 takes wading birds off). Returns
     * whether the param is known for this group.
     */
    setParam(instance, name, value) {
      const data = instance.data;
      if (!data || !Number.isFinite(value)) return false;
      const player = ctx.state.player.position;
      if (name === 'stampede' && data.params.behavior === 'herd') {
        if (value >= 0.5 && data.g[G.STAMPEDE] <= 0) startStampede(data, player.x, player.z, 'event');
        return true;
      }
      if (name === 'flush' && data.params.behavior === 'surface' && data.pool.def.wade) {
        if (value >= 0.5 && data.g[G.FLUSH] <= 0) flushWaders(data, player.x, player.y, player.z);
        return true;
      }
      return false;
    },
    /** Live group summary for dev tools and tests: { species, behavior, count, center, radius, mode }. */
    describe(spawnId) {
      if (!ctx || !ctx.spawns) return null;
      for (const part of ctx.spawns.getParts(spawnId)) {
        if (!part || part.engine !== 'fauna' || !part.data || !part.data.g) continue;
        const data = part.data;
        const g = data.g;
        let excited = 0;
        for (let index = data.start; index < data.start + data.count; index++) if (data.pool.excite[index] > 0.5) excited++;
        let airborne = 0;
        let leaping = 0;
        for (let index = data.start; index < data.start + data.count; index++) {
          if (data.params.behavior === 'surface' && data.pool.def.wade && data.pool.mode[index] !== WADE_STAND) airborne++;
          if (data.params.behavior === 'surface' && !data.pool.def.wade && data.pool.mode[index] === SWIM_LEAP) leaping++;
        }
        return {
          species: data.pool.def.id,
          behavior: data.params.behavior,
          count: data.count,
          center: { x: g[G.CX], y: g[G.CY], z: g[G.CZ] },
          radius: g[G.RADIUS],
          excited,
          mode: data.mode,
          playerDistance: g[G.PLAYER_DISTANCE],
          hidden: data.hidden,
          wind: data.windAttached,
          // Phase 3 modes: a herd's stampede and gait, a column's path, waders aloft, dolphins racing.
          stampede: g[G.STAMPEDE] > 0,
          gait: g[G.GAIT],
          dust: g[G.DUST_LIVE],
          pathLength: data.path ? data.path.length : 0,
          airborne,
          leaping,
          flushed: g[G.FLUSH] > 0,
          racing: g[G.RACE] > 0.5,
        };
      }
      return null;
    },
  };
}
