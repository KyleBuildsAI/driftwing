// EmitterEngine (registry name 'emitter', contract section 3): GPU particle emitters for plumes,
// jets, sprays, sparks, dust rings, mist and rising lanterns. Every param is documented, with units,
// ranges and defaults, in docs/engines/emitter.md (the preset authors' reference).
//
// An emitter instance owns a row of the particle system's tables and whole pages of one of its two
// pools (particleSystem.js). Each frame it:
//   - works out its emission level: the base intensity (or the dormant level of an inactive site), a
//     seeded eruption schedule, a pulse, the end ramp of an event, and its LOD tier's share;
//   - emits that many particles (seeded shapes, directions, speeds, sizes), writing only their birth
//     records; the GPU does the motion (compute on WebGPU, closed form on WebGL2) and the look;
//   - fires seeded bursts (lava bombs, meteor sparks);
//   - drives its couplings: a real light from the pool (lava glow at night), the underglow that
//     lights its own plume, a spawn voice with its triggers, a WindField source that follows the
//     emission (a geyser's updraft), and an immersion sky modifier (inside an ash plume).
// Once per frame (the first instance update of a frame) the engine flushes the uploads, dispatches
// the compute kernels and refreshes a few nodes of the emitters' wind grids (FIELD_PROBES_PER_FRAME
// in all, round robin).
//
// LOD: the tier's share (params.lod) scales the emission rate; fewer particles are drawn larger
// (1 / sqrt(share), at most 2.5 x) so a plume keeps its body. At the far tier emission stops by
// default: a heavy preset's lure takes over (src/spawns/lure.js), and a preset may keep a cheap far
// emitter with lod.far > 0.
//
// Wind: a windSource is registered with the WindField on create and removed on dispose. At the far
// tier it is removed too when it cannot reach the player there (its reach, radius plus height, is
// below the preset's lod.mid: the far tier starts beyond lod.mid), and registered again nearer.
//
// No allocations in update(): the instance's numbers live in typed arrays and pooled records; the
// wind source's sample() writes one reused result; the light, voice and sky handles were made in
// create(). What the engine calls may allocate a little: the terrain height under a grid node and
// the WindField probes (worldgen's noise), which is why they are rationed.
import { FIELD_NODES, FIELD_X, FIELD_Y, FRAME_ROWS, GROUND_MODES, PAGE_SIZE, PARAM_ROWS, PARTICLE_STYLES, createParticleSystem } from './particleSystem.js';
import { MAX_POOLED_LIGHT_INTENSITY, createGroundGrid, createHeadingFrame, createParamReader, createPooledLight, fillRandoms, randomIn, sendVoiceLevel, smoothstep } from './engineKit.js';

/** Emitter instances at once (rows of the particle tables); the director's budget is 16. */
const MAX_EMITTERS = 16;
/** Pages of PAGE_SIZE particles per pool (alpha: puffs, additive: glows and sparks). */
const POOL_PAGES = Object.freeze({ alpha: 80, additive: 24 });
export const MAX_PARTICLES_PER_EMITTER = 32768;
/** Particles one emitter may emit in one frame (a long stall must not flood a pool). */
const MAX_EMIT_PER_FRAME = 4096;
/**
 * WindField probes per frame while a wind grid fills (a new emitter, or a grid that moved): a
 * 48-node grid fills in 24 frames. A probe costs the WindField's terrain lookups (worldgen's noise
 * allocates, about 10 KB a probe), so once every grid is filled one node is refreshed every
 * FIELD_REFRESH_FRAMES frames across all emitters (12 a second at 60 fps: one emitter's grid every
 * 4 s, eight every 32 s), and the nodes ease over FIELD_EASE_SECONDS: the air a plume leans in
 * changes slowly. Counted in frames, so the refresh pacing needs no fractional arithmetic.
 */
const FIELD_PROBES_PER_FRAME = 2;
const FIELD_REFRESH_FRAMES = 5;
/** Seconds over which a grid node eases to a new wind sample. */
const FIELD_EASE_SECONDS = 6;
/** Ground samples per frame for an emitter's spawn grid (hugGround) while it is stale after a move. */
const GROUND_SAMPLES_PER_FRAME = 4;
/** Random numbers one emitted particle draws (the slot layout is in emit()). */
const RANDOMS_PER_PARTICLE = 12;
/** Particles per random batch: emit() refills its random numbers this many particles at a time. */
const RANDOM_BATCH_PARTICLES = 256;
/** Numbers in one particle's birth record (particleSystem.js writeBirth). */
const BIRTH_FIELDS = 12;
const GRAVITY = 9.81;
const DEG = Math.PI / 180;
/** Engine drag floor (1/s): the closed form divides by it. */
const MIN_DRAG = 0.02;
/** Emitter speed above which a frame's anchor jump is a relocation, not motion (m/s). */
const TELEPORT_SPEED = 3000;
const SHAPES = Object.freeze(['point', 'sphere', 'disc', 'ring', 'box', 'line']);
const DIRECTIONS = Object.freeze(['up', 'radial', 'antiSun', 'wind']);
const WIND_TYPES = Object.freeze(['updraft', 'downburst', 'turbulence']);
const TOP_LEVEL_PARAMS = Object.freeze([
  'particles', 'blend', 'style', 'rate', 'intensity', 'inactiveIntensity', 'schedule', 'pulse', 'bursts', 'shape', 'offset',
  'attach', 'hugGround', 'direction', 'speed', 'spread', 'radial', 'swirl', 'inherit', 'travel', 'gravity', 'buoyancy',
  'buoyancyDecay', 'drag', 'windFollow', 'turbulence', 'ground', 'groundOffset', 'restitution', 'life', 'size', 'sizeCurve',
  'sizeJitter', 'stretch', 'colors', 'colorMid', 'brightnessJitter', 'opacity', 'fadeIn', 'fadeOut', 'emissive',
  'emissiveDecay', 'nightBoost', 'lit', 'softness', 'fog', 'depthFade', 'underglow', 'lod', 'lodSizeBoost', 'field',
  'light', 'windSource', 'immersion', 'sound', 'soundTriggers', 'endRamp', 'warmStart',
]);
/** What the SpawnManager merges into every engine's params (not preset params). */
const ACTIVATION_PARAMS = Object.freeze(['position', 'heading', 'site', 'startTime', 'scale', 'duration', 'seed']);

/** Linear RGB of a 0xRRGGBB colour into target[offset..offset + 2] (via a scratch THREE.Color). */
function writeColor(scratchColor, hex, target, offset) {
  scratchColor.setHex(hex);
  target[offset] = scratchColor.r;
  target[offset + 1] = scratchColor.g;
  target[offset + 2] = scratchColor.b;
}

/**
 * The rate (1/s) at which buoyancy decays for a decay time (s; 0 = it never decays), kept clear of
 * the drag so the closed-form motion (particleSystem.js) never divides by zero.
 */
function buoyancyRate(decaySeconds, drag) {
  const rate = decaySeconds > 0 ? 1 / decaySeconds : 1e-4;
  return Math.abs(drag - rate) < 0.01 ? drag + 0.01 : rate;
}

/**
 * Reads and checks the params of one emitter (preset data plus the activation) into a plain config
 * of numbers. Throws a TypeError naming the preset and the param at fault.
 */
export function resolveEmitterConfig(preset, params) {
  const read = createParamReader(`emitter params of preset "${preset.id}"`);
  const presetParams = {};
  for (const key of Object.keys(params)) if (!ACTIVATION_PARAMS.includes(key)) presetParams[key] = params[key];
  read.onlyKeys(presetParams, '', TOP_LEVEL_PARAMS);
  const style = read.oneOf(params.style, 'style', 'puff', PARTICLE_STYLES);
  const blend = read.oneOf(params.blend, 'blend', style === 'puff' || style === 'droplet' ? 'alpha' : 'additive', ['alpha', 'additive']);
  const particles = Math.round(read.number(params.particles, 'particles', 4000, 1, MAX_PARTICLES_PER_EMITTER));
  const life = read.range(params.life, 'life', [2, 4], 0.05, 600);
  // size is [start, end] (m), not [min, max]: a particle may shrink over its life.
  const size = Number.isFinite(params.size) ? [params.size, params.size] : params.size ?? [2, 6];
  if (!Array.isArray(size) || size.length !== 2) read.fail('size', 'must be a number or [start, end] in metres');
  const sizeStart = read.number(size[0], 'size[0]', 2, 0, 20000);
  const sizeEnd = read.number(size[1], 'size[1]', 6, 0, 20000);
  const lifeMean = (life[0] + life[1]) / 2;
  const scale = Number.isFinite(params.scale) && params.scale > 0 ? params.scale : 1;

  const shapeParams = read.object(params.shape, 'shape');
  read.onlyKeys(shapeParams, 'shape', ['type', 'radius', 'innerRadius', 'height', 'size', 'length', 'surface']);
  const shapeType = read.oneOf(shapeParams?.type, 'shape.type', 'point', SHAPES);
  const shapeRadius = read.number(shapeParams?.radius, 'shape.radius', shapeType === 'point' ? 0 : 10, 0, 50000) * scale;
  const shape = {
    type: SHAPES.indexOf(shapeType),
    radius: shapeRadius,
    innerRadius: read.number(shapeParams?.innerRadius, 'shape.innerRadius', shapeType === 'ring' ? shapeRadius * 0.85 / scale : 0, 0, 50000) * scale,
    height: read.number(shapeParams?.height, 'shape.height', 0, 0, 50000) * scale,
    size: read.vector(shapeParams?.size, 'shape.size', [10, 10, 10]).map((value) => Math.abs(value) * scale),
    length: read.number(shapeParams?.length, 'shape.length', 100, 0, 100000) * scale,
    surface: read.boolean(shapeParams?.surface, 'shape.surface', false),
  };

  const directionParam = params.direction;
  let directionMode = 0;
  let direction = [0, 1, 0];
  if (typeof directionParam === 'string') {
    read.oneOf(directionParam, 'direction', 'up', DIRECTIONS);
    directionMode = DIRECTIONS.indexOf(directionParam);
  } else {
    direction = read.vector(directionParam, 'direction', [0, 1, 0]);
    const length = Math.sqrt(direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2);
    if (length < 1e-6) read.fail('direction', 'must not be the zero vector');
    direction = direction.map((value) => value / length);
    directionMode = -1;
  }

  const scheduleParams = read.object(params.schedule, 'schedule');
  read.onlyKeys(scheduleParams, 'schedule', ['period', 'active', 'rampUp', 'rampDown', 'idle', 'startActive']);
  const schedule = scheduleParams ? {
    period: read.range(scheduleParams.period, 'schedule.period', [60, 120], 0.1, 86400),
    active: read.range(scheduleParams.active, 'schedule.active', [8, 15], 0.1, 86400),
    rampUp: read.number(scheduleParams.rampUp, 'schedule.rampUp', 1.5, 0, 600),
    rampDown: read.number(scheduleParams.rampDown, 'schedule.rampDown', 3, 0, 600),
    idle: read.number(scheduleParams.idle, 'schedule.idle', 0, 0, 1),
    startActive: read.boolean(scheduleParams.startActive, 'schedule.startActive', false),
  } : null;
  const pulseParams = read.object(params.pulse, 'pulse');
  read.onlyKeys(pulseParams, 'pulse', ['period', 'depth']);
  const pulse = pulseParams ? {
    period: read.number(pulseParams.period, 'pulse.period', 8, 0.05, 3600),
    depth: read.number(pulseParams.depth, 'pulse.depth', 0.4, 0, 1),
  } : null;
  const burstParams = read.object(params.bursts, 'bursts');
  read.onlyKeys(burstParams, 'bursts', ['interval', 'count', 'speedScale', 'minLevel']);
  const bursts = burstParams ? {
    interval: read.range(burstParams.interval, 'bursts.interval', [4, 10], 0.05, 86400),
    count: read.range(burstParams.count, 'bursts.count', [20, 60], 1, MAX_EMIT_PER_FRAME),
    speedScale: read.number(burstParams.speedScale, 'bursts.speedScale', 1, 0, 100),
    minLevel: read.number(burstParams.minLevel, 'bursts.minLevel', 0.2, 0, 1),
  } : null;

  const turbulenceParams = read.object(params.turbulence, 'turbulence');
  read.onlyKeys(turbulenceParams, 'turbulence', ['spread', 'wobble', 'frequency', 'vertical']);
  const lodParams = read.object(params.lod, 'lod');
  read.onlyKeys(lodParams, 'lod', ['near', 'mid', 'far']);
  const fieldParams = read.object(params.field, 'field');
  read.onlyKeys(fieldParams, 'field', ['extent', 'height', 'base']);
  const speed = read.range(params.speed, 'speed', [2, 4], 0, 5000);
  const windFollow = read.number(params.windFollow, 'windFollow', 1, 0, 2);
  const buoyancy = read.number(params.buoyancy, 'buoyancy', 0, -200, 200);
  const buoyancyDecay = read.number(params.buoyancyDecay, 'buoyancyDecay', 0, 0, 3600);
  const drag = read.number(params.drag, 'drag', 0.5, MIN_DRAG, 100);
  const gravity = read.number(params.gravity, 'gravity', 1, -5, 5);
  // The field grid spans where the particles can go: their reach over a life, and the shape.
  const reach = Math.min(12000, (speed[1] + windFollow * 12 + Math.abs(buoyancy) * Math.min(life[1], buoyancyDecay || life[1]) / Math.max(drag, 0.2)) * life[1] * 0.6);
  const shapeExtent = Math.max(shapeRadius, shape.length / 2, shape.size[0] / 2, shape.size[2] / 2);
  const extent = read.number(fieldParams?.extent, 'field.extent', Math.min(24000, Math.max(300, 2 * (shapeExtent + reach))), 50, 60000) * (fieldParams?.extent ? scale : 1);
  const fieldHeight = read.number(fieldParams?.height, 'field.height', Math.min(16000, Math.max(200, reach * (buoyancy > 0 ? 1.2 : 0.6) + shape.height)), 20, 30000) * (fieldParams?.height ? scale : 1);

  const underglowParams = read.object(params.underglow, 'underglow');
  read.onlyKeys(underglowParams, 'underglow', ['color', 'intensity', 'height', 'flicker', 'night']);
  const lightParams = read.object(params.light, 'light');
  read.onlyKeys(lightParams, 'light', ['color', 'intensity', 'range', 'offset', 'flicker', 'priority', 'night', 'follow']);
  const windParams = read.object(params.windSource, 'windSource');
  read.onlyKeys(windParams, 'windSource', ['type', 'strength', 'radius', 'height', 'base', 'turbulence', 'outflow', 'depth']);
  const immersionParams = read.object(params.immersion, 'immersion');
  read.onlyKeys(immersionParams, 'immersion', ['radius', 'height', 'base', 'fogDensity', 'fogColor', 'fogColorAmount', 'darkness']);
  const triggerParams = read.object(params.soundTriggers, 'soundTriggers');
  read.onlyKeys(triggerParams, 'soundTriggers', ['schedule', 'burst']);
  const colors = Array.isArray(params.colors) ? params.colors : null;
  if (params.colors !== undefined && (!colors || colors.length < 1 || colors.length > 3)) read.fail('colors', 'must be an array of 1 to 3 0xRRGGBB colours');
  const colorList = (colors ?? [0xffffff]).map((color, index) => read.color(color, `colors[${index}]`, 0xffffff));
  while (colorList.length < 3) colorList.push(colorList[colorList.length - 1]);
  const lifeMax = life[1];
  const lodShares = {
    near: read.number(lodParams?.near, 'lod.near', 1, 0, 1),
    mid: read.number(lodParams?.mid, 'lod.mid', 0.4, 0, 1),
    far: read.number(lodParams?.far, 'lod.far', 0, 0, 1),
  };

  return {
    particles,
    pool: blend,
    style: PARTICLE_STYLES.indexOf(style),
    rate: read.number(params.rate, 'rate', particles * 0.9 / lifeMean, 0, 1e6),
    intensity: read.number(params.intensity, 'intensity', 1, 0, 1),
    inactiveIntensity: read.number(params.inactiveIntensity, 'inactiveIntensity', 0.15, 0, 1),
    schedule,
    pulse,
    bursts,
    shape,
    offset: read.vector(params.offset, 'offset', [0, 0, 0]).map((value) => value * scale),
    attachCamera: read.oneOf(params.attach, 'attach', 'anchor', ['anchor', 'camera']) === 'camera',
    hugGround: read.boolean(params.hugGround, 'hugGround', false),
    directionMode,
    direction,
    speed,
    spread: read.number(params.spread, 'spread', 15, 0, 180) * DEG,
    radial: read.number(params.radial, 'radial', 0, -5000, 5000),
    swirl: read.number(params.swirl, 'swirl', 0, -5000, 5000),
    inherit: read.number(params.inherit, 'inherit', 0, 0, 1),
    travel: read.vector(params.travel, 'travel', null),
    gravity: gravity * GRAVITY,
    buoyancy,
    buoyancyLambda: buoyancyRate(buoyancyDecay, drag),
    drag,
    windFollow,
    turbulence: {
      spread: read.number(turbulenceParams?.spread, 'turbulence.spread', 0, 0, 10000) * scale,
      wobble: read.number(turbulenceParams?.wobble, 'turbulence.wobble', 0, 0, 10000) * scale,
      frequency: read.number(turbulenceParams?.frequency, 'turbulence.frequency', 0.5, 0, 50) * Math.PI * 2,
      vertical: read.number(turbulenceParams?.vertical, 'turbulence.vertical', 0.6, 0, 2),
    },
    ground: GROUND_MODES.indexOf(read.oneOf(params.ground, 'ground', 'none', GROUND_MODES)),
    groundOffset: read.number(params.groundOffset, 'groundOffset', 0.5, -100, 1000),
    restitution: read.number(params.restitution, 'restitution', 0.35, 0, 1),
    life,
    lifeMax,
    sizeStart: sizeStart * scale,
    sizeEnd: sizeEnd * scale,
    sizeCurve: read.number(params.sizeCurve, 'sizeCurve', 1, 0.05, 20),
    sizeJitter: read.number(params.sizeJitter, 'sizeJitter', 0.3, 0, 1),
    stretch: read.number(params.stretch, 'stretch', 0, 0, 10),
    colors: colorList,
    colorMid: read.number(params.colorMid, 'colorMid', 0.5, 0, 1),
    brightnessJitter: read.number(params.brightnessJitter, 'brightnessJitter', 0.1, 0, 1),
    opacity: read.number(params.opacity, 'opacity', 0.6, 0, 1),
    fadeIn: read.number(params.fadeIn, 'fadeIn', 0.1, 0, 1),
    fadeOut: read.number(params.fadeOut, 'fadeOut', 1.5, 0, 20),
    emissive: read.number(params.emissive, 'emissive', 0, 0, 100),
    emissiveDecay: read.number(params.emissiveDecay, 'emissiveDecay', 0, 0, 100),
    nightBoost: read.number(params.nightBoost, 'nightBoost', 0, 0, 20),
    lit: read.number(params.lit, 'lit', blend === 'alpha' ? 1 : 0, 0, 1),
    softness: read.number(params.softness, 'softness', 1.6, 0.2, 8),
    fog: read.number(params.fog, 'fog', 1, 0, 1),
    depthFade: read.number(params.depthFade, 'depthFade', blend === 'alpha' ? 3 : 0, 0, 1000),
    underglow: underglowParams ? {
      color: read.color(underglowParams.color, 'underglow.color', 0xff6a2a),
      intensity: read.number(underglowParams.intensity, 'underglow.intensity', 1.5, 0, 50),
      height: read.number(underglowParams.height, 'underglow.height', 800, 1, 50000) * scale,
      flicker: read.number(underglowParams.flicker, 'underglow.flicker', 0.2, 0, 1),
      night: read.number(underglowParams.night, 'underglow.night', 0.8, 0, 1),
    } : null,
    lod: lodShares,
    lodSizeBoost: read.boolean(params.lodSizeBoost, 'lodSizeBoost', true),
    field: {
      extent,
      height: fieldHeight,
      base: read.number(fieldParams?.base, 'field.base', -Math.min(200, fieldHeight * 0.1), -30000, 30000),
    },
    light: lightParams ? {
      color: read.color(lightParams.color, 'light.color', 0xff8a3a),
      intensity: read.number(lightParams.intensity, 'light.intensity', 2e6, 0, MAX_POOLED_LIGHT_INTENSITY),
      range: read.number(lightParams.range, 'light.range', 3000, 1, 100000),
      offset: read.vector(lightParams.offset, 'light.offset', [0, 50, 0]).map((value) => value * scale),
      flicker: read.number(lightParams.flicker, 'light.flicker', 0.25, 0, 1),
      priority: read.number(lightParams.priority, 'light.priority', 2, 0, 100),
      night: read.number(lightParams.night, 'light.night', 1, 0, 1),
      follow: read.number(lightParams.follow, 'light.follow', 1, 0, 1),
    } : null,
    windSource: windParams ? {
      type: WIND_TYPES.indexOf(read.oneOf(windParams.type, 'windSource.type', 'updraft', WIND_TYPES)),
      strength: read.number(windParams.strength, 'windSource.strength', 8, 0, 200),
      radius: read.number(windParams.radius, 'windSource.radius', 150, 1, 50000) * scale,
      height: read.number(windParams.height, 'windSource.height', 600, 1, 30000) * scale,
      base: read.number(windParams.base, 'windSource.base', 0, -1000, 30000) * scale,
      turbulence: read.number(windParams.turbulence, 'windSource.turbulence', 0.4, 0, 1),
      outflow: read.number(windParams.outflow, 'windSource.outflow', 0, 0, 200),
      depth: read.number(windParams.depth, 'windSource.depth', 150, 1, 5000) * scale,
    } : null,
    immersion: immersionParams ? {
      radius: read.number(immersionParams.radius, 'immersion.radius', 800, 1, 50000) * scale,
      height: read.number(immersionParams.height, 'immersion.height', 3000, 1, 30000) * scale,
      base: read.number(immersionParams.base, 'immersion.base', 0, -1000, 30000) * scale,
      fogDensity: read.number(immersionParams.fogDensity, 'immersion.fogDensity', 4, 1, 8),
      fogColor: read.color(immersionParams.fogColor, 'immersion.fogColor', colorList[1]),
      fogColorAmount: read.number(immersionParams.fogColorAmount, 'immersion.fogColorAmount', 0.7, 0, 1),
      darkness: read.number(immersionParams.darkness, 'immersion.darkness', 0.3, 0, 1),
    } : null,
    sound: read.boolean(params.sound, 'sound', true),
    soundTriggers: {
      schedule: triggerParams ? read.oneOf(triggerParams.schedule, 'soundTriggers.schedule', null, ['burst', 'boom', 'streak', 'fireball', 'call', 'chime', 'scatter']) : null,
      burst: triggerParams ? read.oneOf(triggerParams.burst, 'soundTriggers.burst', null, ['burst', 'boom', 'streak', 'fireball', 'call', 'chime', 'scatter']) : null,
    },
    endRamp: read.number(params.endRamp, 'endRamp', 3, 0, 600),
    warmStart: read.boolean(params.warmStart, 'warmStart', !bursts || Boolean(params.rate)),
    duration: Number.isFinite(params.duration) && params.duration > 0 ? params.duration : null,
    scale,
  };
}

/** Creates the emitter engine (see the file header). */
/** Writes four numbers into element index of a vec4 table (create time and dispose: it boxes them). */
function writeTableElement(table, index, x, y, z, w) {
  const offset = index * 4;
  table[offset] = x;
  table[offset + 1] = y;
  table[offset + 2] = z;
  table[offset + 3] = w;
}

export function createEmitterEngine() {
  let ctx = null;
  let system = null;
  let serial = 0;
  let lastFrame = -1;
  let lightsHeld = 0;
  let fieldCursor = 0;
  let scratchColor = null;
  let probePoint = null;
  let probeResult = null;
  /** The current random batch of emit(): RANDOMS_PER_PARTICLE numbers per particle. */
  const randoms = new Float64Array(RANDOMS_PER_PARTICLE * RANDOM_BATCH_PARTICLES);
  /** One particle's birth record on its way to the pool. */
  const birth = new Float64Array(BIRTH_FIELDS);
  /** A ground lookup: [x, z] in, the ground height out in [2]. */
  const groundPoint = new Float64Array(3);
  /**
   * The current update's step (s) and emit()'s span (s) and speed scale: numbers handed to the
   * helpers through typed arrays, because V8 boxes a double passed to a call it does not inline.
   */
  const frameDt = new Float64Array(1);
  const emitArgs = new Float64Array(2);
  /** Live instances in creation order (the field budget's round robin). */
  const live = [];

  // ---- Per-frame engine work ----------------------------------------------------------------------
  /** The frame's shared work, run by the first instance update of each frame. */
  function frameStep() {
    if (ctx.state.frame === lastFrame) return;
    lastFrame = ctx.state.frame;
    system.update(ctx.renderer, ctx.camera, frameDt, ctx.scene.fog, ctx.time);
    refreshFields();
  }

  /** Whether an emitter's wind grid is sampled at all (allocated, emitting, following the wind). */
  function fieldWanted(data) {
    return data.row >= 0 && data.share[0] > 0 && data.config.windFollow > 0;
  }

  /**
   * Samples wind-grid nodes across the live emitters (round robin): FIELD_PROBES_PER_FRAME while a
   * grid is filling (only the filling grids), else one every FIELD_REFRESH_FRAMES frames.
   */
  function refreshFields() {
    const count = live.length;
    if (count === 0) return;
    let filling = false;
    for (let index = 0; index < count && !filling; index++) {
      const data = live[index].data;
      filling = data.fieldPending > 0 && fieldWanted(data);
    }
    let probes = FIELD_PROBES_PER_FRAME;
    if (!filling) probes = ctx.state.frame % FIELD_REFRESH_FRAMES === 0 ? 1 : 0;
    for (let visited = 0; visited < count && probes > 0; visited++) {
      if (fieldCursor >= count) fieldCursor = 0;
      const instance = live[fieldCursor];
      const data = instance.data;
      if (!fieldWanted(data) || (filling && data.fieldPending === 0)) {
        fieldCursor++;
        continue;
      }
      while (probes > 0) {
        sampleFieldNode(data, data.fieldNode);
        probes--;
        data.fieldNode++;
        if (data.fieldNode >= FIELD_NODES) {
          data.fieldNode = 0;
          break;
        }
      }
      if (data.fieldNode === 0) fieldCursor++;
    }
  }

  /** Probes the WindField at one node of an emitter's grid and eases the node toward it. */
  function sampleFieldNode(data, node) {
    const origin = data.frameOrigin;
    const placement = data.fieldPlacement;
    const ix = node % FIELD_X;
    const iz = Math.floor(node / FIELD_X) % FIELD_X;
    const iy = Math.floor(node / (FIELD_X * FIELD_X));
    // Whole metres: a small integer stored in the point's fields stays unboxed, where a fresh
    // fractional number costs a heap number (the grid's nodes are hundreds of metres apart).
    probePoint.x = Math.round(origin[0] + placement[0] + ix * placement[3]);
    probePoint.y = Math.round(origin[1] + placement[1] + iy * placement[4]);
    probePoint.z = Math.round(origin[2] + placement[2] + iz * placement[3]);
    const now = ctx.time.elapsed;
    // The WindField's own clock is the same elapsed time (passing it would box it).
    ctx.wind.probe(probePoint, undefined, probeResult);
    const since = now - data.fieldSampled[node];
    const fresh = data.fieldSampled[node] < 0;
    const ease = fresh ? 1 : 1 - Math.exp(-Math.max(0, since) / FIELD_EASE_SECONDS);
    if (fresh) data.fieldPending--;
    data.fieldSampled[node] = now;
    const field = system.fieldData;
    const offset = (data.row * FIELD_NODES + node) * 4;
    field[offset] += (probeResult.vel.x - field[offset]) * ease;
    field[offset + 1] += (probeResult.vel.y - field[offset + 1]) * ease;
    field[offset + 2] += (probeResult.vel.z - field[offset + 2]) * ease;
  }

  /**
   * Samples the ground under the emitter's field grid (16 columns) into every level's w, and the
   * ground under the emission point (the ceiling of the grid's ground, particleSystem.js) into its
   * frame row.
   */
  function sampleFieldGround(data) {
    const origin = data.frameOrigin;
    const placement = data.fieldPlacement;
    const vent = Math.max(ctx.terrain.groundHeight(data.point[0], data.point[2]), ctx.terrain.waterLevel) - origin[1];
    system.frameData[(data.row * FRAME_ROWS + 1) * 4 + 2] = vent;
    for (let column = 0; column < FIELD_X * FIELD_X; column++) {
      const x = origin[0] + placement[0] + (column % FIELD_X) * placement[3];
      const z = origin[2] + placement[2] + Math.floor(column / FIELD_X) * placement[3];
      const ground = Math.max(ctx.terrain.groundHeight(x, z), ctx.terrain.waterLevel) - origin[1];
      for (let level = 0; level < FIELD_Y; level++) system.fieldData[(data.row * FIELD_NODES + level * FIELD_X * FIELD_X + column) * 4 + 3] = ground;
    }
  }

  /** Centres an emitter's field grid on the emission point (relative to its frame origin). */
  function placeField(data, x, y, z) {
    const config = data.config;
    const placement = data.fieldPlacement;
    placement[0] = x - data.frameOrigin[0] - config.field.extent / 2;
    placement[1] = y - data.frameOrigin[1] + config.field.base;
    placement[2] = z - data.frameOrigin[2] - config.field.extent / 2;
    placement[3] = config.field.extent / (FIELD_X - 1);
    placement[4] = config.field.height / (FIELD_Y - 1);
    const row = data.row * PARAM_ROWS;
    writeTableElement(system.paramData, row + 10, placement[0], placement[1], placement[2], placement[3]);
    system.paramData[(row + 11) * 4] = placement[4];
    for (let node = 0; node < FIELD_NODES; node++) data.fieldSampled[node] = -1;
    data.fieldPending = FIELD_NODES;
  }

  // ---- Params table -------------------------------------------------------------------------------
  /** Writes an emitter's static params into its row of the particle system's params table. */
  function writeParams(data) {
    const config = data.config;
    const table = system.paramData;
    const row = data.row * PARAM_ROWS;
    const colors = data.colorScratch;
    for (let index = 0; index < 3; index++) writeColor(scratchColor, config.colors[index], colors, index * 3);
    writeTableElement(table, row, 0, -config.gravity, 0, config.drag);
    writeTableElement(table, row + 1, config.buoyancy, config.buoyancyLambda, config.windFollow, config.ground);
    writeTableElement(table, row + 2, config.sizeStart, config.sizeEnd, config.sizeCurve, config.stretch);
    writeTableElement(table, row + 3, colors[0], colors[1], colors[2], config.fadeIn);
    writeTableElement(table, row + 4, colors[3], colors[4], colors[5], config.colorMid);
    writeTableElement(table, row + 5, colors[6], colors[7], colors[8], config.fadeOut);
    writeTableElement(table, row + 6, config.opacity, config.emissive, config.emissiveDecay, config.lit);
    if (config.underglow) {
      writeColor(scratchColor, config.underglow.color, colors, 0);
      writeTableElement(table, row + 7, colors[0], colors[1], colors[2], config.underglow.height);
    } else {
      writeTableElement(table, row + 7, 0, 0, 0, 1);
    }
    writeTableElement(table, row + 8, config.turbulence.spread, config.turbulence.wobble, config.turbulence.frequency, config.turbulence.vertical);
    writeTableElement(table, row + 9, config.groundOffset, config.depthFade, config.fog, config.style);
    writeTableElement(table, row + 11, table[(row + 11) * 4], config.restitution, config.nightBoost, config.softness);
    const frame = data.row * FRAME_ROWS;
    writeTableElement(system.frameData, frame, 0, 0, 0, 0);
    writeTableElement(system.frameData, frame + 1, 1, 1, 0, 0);
  }

  // ---- Emission -----------------------------------------------------------------------------------
  /**
   * Writes a random direction within the emitter's cone around its axis (world, unit) into
   * data.emitScratch[3..5], from the two random numbers at randoms[first]. The axis is data.axis
   * (world, unit).
   */
  function coneDirection(data, first) {
    const axis = data.axis;
    const spread = data.config.spread;
    const cosine = 1 - randoms[first] * (1 - Math.cos(spread));
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const angle = randoms[first + 1] * Math.PI * 2;
    // Two unit vectors perpendicular to the axis.
    let ux;
    let uy;
    let uz;
    if (Math.abs(axis[1]) < 0.95) {
      ux = axis[2];
      uy = 0;
      uz = -axis[0];
    } else {
      ux = 0;
      uy = -axis[2];
      uz = axis[1];
    }
    const uLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= uLength;
    uy /= uLength;
    uz /= uLength;
    const wx = axis[1] * uz - axis[2] * uy;
    const wy = axis[2] * ux - axis[0] * uz;
    const wz = axis[0] * uy - axis[1] * ux;
    const cosAngle = Math.cos(angle) * sine;
    const sinAngle = Math.sin(angle) * sine;
    const out = data.emitScratch;
    out[3] = axis[0] * cosine + ux * cosAngle + wx * sinAngle;
    out[4] = axis[1] * cosine + uy * cosAngle + wy * sinAngle;
    out[5] = axis[2] * cosine + uz * cosAngle + wz * sinAngle;
  }

  /**
   * A random point of the emitter's shape in its local frame (right, up, forward) into
   * emitScratch[0..2], from the three random numbers at randoms[first].
   */
  function shapePoint(data, first) {
    const shape = data.config.shape;
    const out = data.emitScratch;
    const randomA = randoms[first];
    const randomB = randoms[first + 1];
    const randomC = randoms[first + 2];
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    switch (shape.type) {
      case 1: {
        // sphere: uniform in the volume, or on the surface
        const cosine = randomA * 2 - 1;
        const sine = Math.sqrt(1 - cosine * cosine);
        const angle = randomB * Math.PI * 2;
        const radius = shape.radius * (shape.surface ? 1 : Math.cbrt(randomC));
        out[0] = Math.cos(angle) * sine * radius;
        out[1] = cosine * radius;
        out[2] = Math.sin(angle) * sine * radius;
        break;
      }
      case 2:
      case 3: {
        // disc and ring: uniform over the annulus, up to height above it
        const inner = shape.innerRadius;
        const radius = Math.sqrt(inner * inner + randomA * (shape.radius * shape.radius - inner * inner));
        const angle = randomB * Math.PI * 2;
        out[0] = Math.cos(angle) * radius;
        out[1] = randomC * shape.height;
        out[2] = Math.sin(angle) * radius;
        break;
      }
      case 4:
        out[0] = (randomA - 0.5) * shape.size[0];
        out[1] = (randomB - 0.5) * shape.size[1];
        out[2] = (randomC - 0.5) * shape.size[2];
        break;
      case 5:
        // line: across the emitter (right), up to height above it
        out[0] = (randomA - 0.5) * shape.length;
        out[1] = randomB * shape.height;
        break;
      default:
        break;
    }
  }

  /** The emission axis (world, unit) for this frame into data.axis. */
  function refreshAxis(data) {
    const config = data.config;
    const axis = data.axis;
    if (config.directionMode === 2) {
      const sun = ctx.time.sunDirection;
      axis[0] = -sun.x;
      axis[1] = -sun.y;
      axis[2] = -sun.z;
    } else if (config.directionMode === 3) {
      const field = system.fieldData;
      const offset = (data.row * FIELD_NODES + FIELD_X * FIELD_X + 5) * 4;
      const length = Math.sqrt(field[offset] * field[offset] + field[offset + 1] * field[offset + 1] + field[offset + 2] * field[offset + 2]);
      if (length > 0.1) {
        axis[0] = field[offset] / length;
        axis[1] = field[offset + 1] / length;
        axis[2] = field[offset + 2] / length;
      } else {
        axis[0] = 0;
        axis[1] = 1;
        axis[2] = 0;
      }
    } else if (config.directionMode === -1) {
      const frame = data.heading;
      const direction = config.direction;
      axis[0] = direction[0] * frame.rightX + direction[2] * frame.forwardX;
      axis[1] = direction[1];
      axis[2] = direction[0] * frame.rightZ + direction[2] * frame.forwardZ;
    } else {
      axis[0] = 0;
      axis[1] = 1;
      axis[2] = 0;
    }
  }

  /**
   * Emits count particles born over the last span seconds (spread evenly, the newest now). With
   * alongPath they leave from along the emission point's path since the previous frame (a moving
   * emitter draws a continuous stream); without it from the point itself (a warm start). speedScale
   * scales the launch speed (bursts). span and speedScale come in emitArgs[0] and emitArgs[1].
   *
   * Each particle reads RANDOMS_PER_PARTICLE numbers of the batch from its first slot: 0-2 the shape
   * point, 3 the speed, 4-5 the cone direction, 6 the radial fallback angle, 7 the size jitter, 8 the
   * brightness, 9 the life, 10 the seed. The birth record goes to the pool through one typed array,
   * so nothing in the loop boxes a number.
   */
  function emit(data, count, alongPath) {
    const span = emitArgs[0];
    const speedScale = emitArgs[1];
    const config = data.config;
    const pool = data.pool;
    const frame = data.heading;
    const out = data.emitScratch;
    const origin = data.frameOrigin;
    const point = data.point;
    const previous = data.previousPoint;
    const now = ctx.time.elapsed;
    const lifeLow = config.life[0];
    const lifeSpan = config.life[1] - lifeLow;
    const speedLow = config.speed[0];
    const speedSpan = config.speed[1] - speedLow;
    const sizeScale = data.sizeScale[0];
    let batchLeft = 0;
    let first = 0;
    for (let index = 0; index < count; index++) {
      if (batchLeft === 0) {
        batchLeft = Math.min(RANDOM_BATCH_PARTICLES, count - index);
        fillRandoms(data.randomState, randoms, batchLeft * RANDOMS_PER_PARTICLE);
        first = 0;
      }
      batchLeft--;
      const along = (index + 1) / count;
      const back = (1 - along) * span;
      const path = alongPath ? along : 1;
      shapePoint(data, first);
      const localRight = out[0] + config.offset[0];
      const localUp = out[1] + config.offset[1];
      const localForward = out[2] + config.offset[2];
      const baseX = previous[0] + (point[0] - previous[0]) * path;
      const baseY = previous[1] + (point[1] - previous[1]) * path;
      const baseZ = previous[2] + (point[2] - previous[2]) * path;
      const x = baseX + localRight * frame.rightX + localForward * frame.forwardX;
      const z = baseZ + localRight * frame.rightZ + localForward * frame.forwardZ;
      let y = baseY + localUp;
      if (config.hugGround) {
        groundPoint[0] = x;
        groundPoint[1] = z;
        data.spawnGround.sample(groundPoint);
        y = groundPoint[2] + localUp;
      }
      // Launch velocity: the cone around the axis (or radial), plus radial and swirl, plus inheritance.
      let vx;
      let vy;
      let vz;
      const speed = (speedLow + speedSpan * randoms[first + 3]) * speedScale;
      if (config.directionMode === 1) {
        const offsetX = x - baseX;
        const offsetY = y - baseY;
        const offsetZ = z - baseZ;
        const length = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
        if (length > 1e-3) {
          data.axis[0] = offsetX / length;
          data.axis[1] = offsetY / length;
          data.axis[2] = offsetZ / length;
        } else {
          data.axis[0] = 0;
          data.axis[1] = 1;
          data.axis[2] = 0;
        }
      }
      coneDirection(data, first + 4);
      vx = out[3] * speed;
      vy = out[4] * speed;
      vz = out[5] * speed;
      if (config.radial !== 0 || config.swirl !== 0) {
        let horizontalX = x - baseX;
        let horizontalZ = z - baseZ;
        let length = Math.sqrt(horizontalX * horizontalX + horizontalZ * horizontalZ);
        if (length < 1e-3) {
          const angle = randoms[first + 6] * Math.PI * 2;
          horizontalX = Math.cos(angle);
          horizontalZ = Math.sin(angle);
          length = 1;
        }
        horizontalX /= length;
        horizontalZ /= length;
        vx += horizontalX * config.radial - horizontalZ * config.swirl;
        vz += horizontalZ * config.radial + horizontalX * config.swirl;
      }
      if (config.inherit > 0) {
        vx += data.velocity[0] * config.inherit;
        vy += data.velocity[1] * config.inherit;
        vz += data.velocity[2] * config.inherit;
      }
      const slot = data.pages[Math.floor(data.ring / PAGE_SIZE)] * PAGE_SIZE + (data.ring % PAGE_SIZE);
      data.ring = (data.ring + 1) % data.capacity;
      birth[0] = x - origin[0];
      birth[1] = y - origin[1];
      birth[2] = z - origin[2];
      birth[3] = now - back;
      birth[4] = vx;
      birth[5] = vy;
      birth[6] = vz;
      birth[7] = lifeLow + lifeSpan * randoms[first + 9];
      birth[8] = data.row;
      birth[9] = randoms[first + 10];
      birth[10] = (1 + config.sizeJitter * (randoms[first + 7] * 2 - 1)) * sizeScale;
      birth[11] = 1 + config.brightnessJitter * (randoms[first + 8] * 2 - 1);
      pool.writeBirth(slot, birth);
      first += RANDOMS_PER_PARTICLE;
    }
    data.emitted += count;
  }

  // ---- Schedule, pulse and the end of an event -----------------------------------------------------
  /** Advances the seeded eruption schedule by the frame's step; returns its envelope (0..1) in data.levels[1]. */
  function advanceSchedule(data) {
    const dt = frameDt[0];
    const schedule = data.config.schedule;
    const levels = data.levels;
    if (!schedule) {
      levels[1] = 1;
      return;
    }
    const state = data.scheduleState;
    state[1] -= dt;
    while (state[1] <= 0) {
      const phase = state[0];
      if (phase === 0) {
        state[0] = 1;
        state[1] += Math.max(0.001, schedule.rampUp);
        data.triggerDuration[0] = schedule.rampUp + state[2] + schedule.rampDown;
        data.pendingScheduleTrigger = true;
      } else if (phase === 1) {
        state[0] = 2;
        state[1] += state[2];
      } else if (phase === 2) {
        state[0] = 3;
        state[1] += Math.max(0.001, schedule.rampDown);
      } else {
        state[0] = 0;
        state[2] = randomIn(data.rng, schedule.active[0], schedule.active[1]);
        state[1] += Math.max(0.1, randomIn(data.rng, schedule.period[0], schedule.period[1]) - state[2] - schedule.rampUp - schedule.rampDown);
      }
    }
    const phase = state[0];
    let envelope = 0;
    if (phase === 1) envelope = 1 - state[1] / Math.max(0.001, schedule.rampUp);
    else if (phase === 2) envelope = 1;
    else if (phase === 3) envelope = state[1] / Math.max(0.001, schedule.rampDown);
    envelope = envelope < 0 ? 0 : envelope > 1 ? 1 : envelope;
    levels[1] = schedule.idle + (1 - schedule.idle) * envelope;
  }

  /**
   * Fires one seeded burst (when the level is at least bursts.minLevel) and draws the time to the
   * next one. The level and the share come from data's typed arrays (levels[0], share[0]).
   */
  function fireBurst(data) {
    const config = data.config;
    const bursts = config.bursts;
    const level = data.levels[0];
    data.burstTimer[0] += randomIn(data.rng, bursts.interval[0], bursts.interval[1]);
    if (level < bursts.minLevel) return;
    const burstCount = Math.min(MAX_EMIT_PER_FRAME, Math.max(1, Math.round(randomIn(data.rng, bursts.count[0], bursts.count[1]) * data.share[0])));
    refreshAxis(data);
    emitArgs[0] = 0;
    emitArgs[1] = bursts.speedScale;
    emit(data, burstCount, true);
    if (data.voice && config.soundTriggers.burst) {
      data.triggerOptions.strength = Math.min(1, 0.4 + 0.6 * level);
      data.triggerOptions.intensity = data.triggerOptions.strength;
      data.voice.trigger(config.soundTriggers.burst, data.triggerOptions);
    }
  }

  /** Sends the voice its schedule trigger once an eruption starts (with the eruption's duration). */
  function fireScheduleTrigger(instance) {
    const data = instance.data;
    const config = data.config;
    data.pendingScheduleTrigger = false;
    if (!data.voice || !config.soundTriggers.schedule) return;
    const base = instance.active === false ? config.inactiveIntensity : config.intensity;
    data.triggerOptions.strength = base;
    data.triggerOptions.intensity = base;
    data.triggerOptions.duration = data.triggerDuration[0];
    data.voice.trigger(config.soundTriggers.schedule, data.triggerOptions);
  }

  // ---- Wind source ----------------------------------------------------------------------------------
  /** Registers the emitter's wind source (its sample() closes over the instance's typed arrays). */
  function addWindSource(instance) {
    const data = instance.data;
    const source = data.config.windSource;
    const centre = data.windCentre;
    const level = data.levels;
    const result = data.windResult;
    const vel = result.vel;
    const radius = source.radius;
    const inverseRadiusSquared = 1 / (radius * radius);
    const height = source.height;
    const type = source.type;
    data.windBounds.min.x = centre[0] - radius * 2;
    data.windBounds.min.y = centre[1] + source.base - 20;
    data.windBounds.min.z = centre[2] - radius * 2;
    data.windBounds.max.x = centre[0] + radius * 2;
    data.windBounds.max.y = centre[1] + source.base + height * 1.2;
    data.windBounds.max.z = centre[2] + radius * 2;
    ctx.wind.addSource({
      id: data.windId,
      kind: 'emitter-plume',
      bounds: data.windBounds,
      sample: function sampleEmitterWind(position) {
        const strength = level[3];
        if (strength <= 0) return null;
        const dx = position.x - centre[0];
        const dz = position.z - centre[2];
        const ratio = (dx * dx + dz * dz) * inverseRadiusSquared;
        if (ratio > 4) return null;
        const up = (position.y - centre[1] - source.base) / height;
        if (up < -0.02 || up > 1.2) return null;
        const core = Math.exp(-2 * ratio);
        const taper = up < 0.8 ? 1 : 1 - (up - 0.8) / 0.4;
        vel.x = 0;
        vel.y = 0;
        vel.z = 0;
        if (type === 0) {
          vel.y = source.strength * strength * core * taper * (up < 0.05 ? up / 0.05 : 1);
        } else if (type === 1) {
          // Downburst: the core slams down; near the ground the air spreads outward.
          const aboveGround = position.y - centre[1] - source.base;
          const nearGround = Math.exp(-aboveGround / source.depth);
          vel.y = -source.strength * strength * core * taper * (1 - nearGround);
          const distance = Math.sqrt(dx * dx + dz * dz);
          if (distance > 1) {
            const outward = source.outflow * strength * nearGround * Math.min(1, distance / radius) * Math.exp(-0.5 * ratio);
            vel.x = dx / distance * outward;
            vel.z = dz / distance * outward;
          }
        }
        result.turbulence = source.turbulence * strength * Math.exp(-ratio) * taper;
        return result;
      },
    });
    instance.windSourceIds.push(data.windId);
    data.windActive = true;
  }

  function removeWindSource(instance) {
    const data = instance.data;
    if (!data.windActive) return;
    ctx.wind.removeSource(data.windId);
    const index = instance.windSourceIds.indexOf(data.windId);
    if (index >= 0) instance.windSourceIds.splice(index, 1);
    data.windActive = false;
  }

  /** Moves the wind source's bounds with its emitter when it drifted a quarter of its radius. */
  function followWindSource(data) {
    const source = data.config.windSource;
    const centre = data.windCentre;
    const dx = data.point[0] - centre[0];
    const dz = data.point[2] - centre[2];
    centre[1] = data.point[1];
    if (dx * dx + dz * dz < source.radius * source.radius * 0.0625) return;
    centre[0] = data.point[0];
    centre[2] = data.point[2];
    if (!data.windActive) return;
    data.windBounds.min.x = centre[0] - source.radius * 2;
    data.windBounds.min.y = centre[1] + source.base - 20;
    data.windBounds.min.z = centre[2] - source.radius * 2;
    data.windBounds.max.x = centre[0] + source.radius * 2;
    data.windBounds.max.y = centre[1] + source.base + source.height * 1.2;
    data.windBounds.max.z = centre[2] + source.radius * 2;
    ctx.wind.setSourceBounds(data.windId, data.windBounds);
  }

  // ---- Immersion (inside the plume) -----------------------------------------------------------------
  function updateImmersion(data) {
    const dt = frameDt[0];
    const immersion = data.config.immersion;
    const camera = ctx.camera.position;
    const dx = camera.x - data.point[0];
    const dz = camera.z - data.point[2];
    const distance = Math.sqrt(dx * dx + dz * dz);
    const above = camera.y - data.point[1] - immersion.base;
    const inside = (1 - smoothstep(immersion.radius * 0.55, immersion.radius, distance))
      * smoothstep(-40, 60, above) * (1 - smoothstep(immersion.height * 0.8, immersion.height, above));
    const target = inside * data.levels[2];
    const eased = data.immersionWeight[0] + (target - data.immersionWeight[0]) * (1 - Math.exp(-dt * 1.5));
    if (Math.abs(eased - data.immersionWeight[0]) < 1e-4 && !(target === 0 && eased > 0 && eased < 1e-3)) return;
    data.immersionWeight[0] = eased < 1e-3 && target === 0 ? 0 : eased;
    // Only the weight changes after create: the colour and densities were set once.
    data.immersionWeightValues.weight = data.immersionWeight[0];
    data.immersion.set(data.immersionWeightValues);
  }

  // ---- Engine interface ----------------------------------------------------------------------------
  const engine = {
    name: 'emitter',
    budget: { instances: MAX_EMITTERS, particles: 120000, lights: 1 },
    init(engineCtx) {
      ctx = engineCtx;
      const { THREE } = ctx;
      scratchColor = new THREE.Color();
      probePoint = new THREE.Vector3();
      probeResult = { vel: new THREE.Vector3(), turbulence: 0 };
      system = createParticleSystem({
        THREE: ctx.THREE,
        TSL: ctx.TSL,
        scene: ctx.scene,
        backend: ctx.backend,
        uniforms: ctx.uniforms,
        sky: ctx.sky,
        maxEmitters: MAX_EMITTERS,
        pages: POOL_PAGES,
      });
      system.prewarm(ctx.renderer);
      if (typeof ctx.registerPrewarm === 'function') for (const mesh of system.meshes) ctx.registerPrewarm(mesh);
    },
    create(preset, params, rng) {
      const { THREE } = ctx;
      const config = resolveEmitterConfig(preset, params);
      const pool = system.pools[config.pool];
      const row = system.rows.alloc();
      if (row < 0) throw new Error(`[DRIFTWING] emitter: every emitter row (${MAX_EMITTERS}) is in use; preset "${preset.id}" cannot emit`);
      // Whole pages; when the pool is short the emitter runs on what is free (its rate follows).
      const wanted = Math.ceil(config.particles / PAGE_SIZE);
      const pages = new Int32Array(wanted);
      let pageCount = 0;
      while (pageCount < wanted) {
        const page = pool.pageSlots.alloc();
        if (page < 0) break;
        pages[pageCount++] = page;
      }
      const capacity = Math.min(config.particles, pageCount * PAGE_SIZE);
      const anchor = params.position;
      const heading = createHeadingFrame().set(Number.isFinite(params.heading) ? params.heading : 0);
      const id = `emitter:${serial++}`;
      const origin = config.attachCamera ? ctx.camera.position : anchor;
      const data = {
        id,
        config,
        preset,
        pool,
        row,
        pages,
        pageCount,
        capacity,
        ring: 0,
        rng,
        /** The per-particle generator's state (fillRandoms), seeded from the spawn's rng. */
        randomState: new Uint32Array([Math.floor(rng() * 4294967296)]),
        heading,
        tier: 'near',
        share: new Float64Array([1]),
        sizeScale: new Float64Array([1]),
        /** levels: [emission, schedule envelope, emission x fades (couplings), wind source strength] */
        levels: new Float64Array(4),
        /** schedule: [phase 0 idle / 1 up / 2 active / 3 down, seconds left in it, active length] */
        scheduleState: new Float64Array(3),
        triggerDuration: new Float64Array(1),
        pendingScheduleTrigger: false,
        burstTimer: new Float64Array([0]),
        debt: new Float64Array([0]),
        age: new Float64Array([0]),
        emitted: 0,
        frameOrigin: new Float64Array([anchor.x, anchor.y, anchor.z]),
        point: new Float64Array([origin.x, origin.y, origin.z]),
        previousPoint: new Float64Array([origin.x, origin.y, origin.z]),
        previousAnchor: new Float64Array([anchor.x, anchor.y, anchor.z]),
        velocity: new Float64Array(3),
        axis: new Float64Array([0, 1, 0]),
        emitScratch: new Float64Array(6),
        colorScratch: new Float64Array(9),
        travel: config.travel ? heading.toWorld(config.travel[0], config.travel[1], config.travel[2], { x: 0, y: 0, z: 0 }) : null,
        fieldPlacement: new Float64Array(5),
        fieldSampled: new Float64Array(FIELD_NODES),
        fieldNode: 0,
        fieldPending: FIELD_NODES,
        spawnGround: config.hugGround ? createGroundGrid(ctx.terrain, { size: 8, span: Math.max(100, config.field.extent * 0.6) }) : null,
        light: config.light ? createPooledLight(ctx.lights, { priority: config.light.priority, color: config.light.color, range: config.light.range }) : null,
        lightPhase: rng() * 100,
        voice: null,
        triggerOptions: { strength: 1, duration: 1, intensity: 1 },
        voiceVelocity: new THREE.Vector3(),
        /** The intensity last sent to the voice (-1 before the first): unchanged levels are not re-sent. */
        /** The voice intensity: [last sent, wanted] (sendVoiceLevel). */
        voiceLevel: new Float64Array([-1, 0]),
        windId: `${id}:wind`,
        windActive: false,
        windCentre: new Float64Array([anchor.x, anchor.y, anchor.z]),
        // Vector3s rather than {x, y, z} literals: the literal shape is shared across the whole game,
        // and once anything stores a non-number in it, every number written to it is boxed.
        windBounds: { min: new THREE.Vector3(), max: new THREE.Vector3() },
        windResult: { vel: new THREE.Vector3(), turbulence: 0 },
        windReach: config.windSource ? config.windSource.radius * 2 + config.windSource.height : 0,
        lodMid: preset.lod.mid,
        warmStart: config.warmStart,
        immersion: null,
        immersionWeight: new Float64Array(1),
        immersionValues: null,
        immersionWeightValues: { weight: 0 },
        ending: false,
      };
      data.scheduleState[0] = config.schedule && config.schedule.startActive ? 2 : 0;
      data.scheduleState[2] = config.schedule ? randomIn(rng, config.schedule.active[0], config.schedule.active[1]) : 0;
      data.scheduleState[1] = config.schedule ? (config.schedule.startActive ? data.scheduleState[2] : randomIn(rng, 0.2, 1) * config.schedule.period[0]) : 0;
      data.burstTimer[0] = config.bursts ? randomIn(rng, config.bursts.interval[0], config.bursts.interval[1]) * 0.5 : 0;
      writeParams(data);
      placeField(data, origin.x, origin.y, origin.z);
      sampleFieldGround(data);
      if (data.spawnGround) {
        data.spawnGround.recenter(origin.x, origin.z);
        data.spawnGround.fill();
      }
      // A first wind sample at the centre fills the whole grid, so the first particles already drift.
      probePoint.set(origin.x, origin.y + config.field.height * 0.3, origin.z);
      ctx.wind.probe(probePoint, ctx.time.elapsed, probeResult);
      for (let node = 0; node < FIELD_NODES; node++) {
        const offset = (row * FIELD_NODES + node) * 4;
        system.fieldData[offset] = probeResult.vel.x;
        system.fieldData[offset + 1] = probeResult.vel.y;
        system.fieldData[offset + 2] = probeResult.vel.z;
      }

      const instance = {
        anchor,
        radius: Math.max(5, config.shape.radius, config.field.extent * 0.2),
        windSourceIds: [],
        lights: 0,
        particles: capacity,
        data,
      };
      // The couplings can refuse (an unknown audio recipe throws): the row, the pages and whatever
      // was already attached go back before the error reaches the SpawnManager.
      try {
        if (config.windSource) addWindSource(instance);
        if (config.immersion && ctx.sky && typeof ctx.sky.addModifier === 'function') {
          data.immersion = ctx.sky.addModifier(`${id}:immersion`, { priority: 20 });
          const immersion = config.immersion;
          data.immersionValues = {
            weight: 0,
            fogDensity: immersion.fogDensity,
            fogColor: new THREE.Color(immersion.fogColor),
            fogColorAmount: immersion.fogColorAmount,
            darkness: immersion.darkness,
          };
          data.immersion.set(data.immersionValues);
        }
        if (config.sound && preset.audio && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
          data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: 0 });
          data.voice.setPosition(anchor);
        }
      } catch (error) {
        engine.dispose(instance);
        throw error;
      }
      live.push(instance);
      return instance;
    },
    update(instance, dt, engineCtx) {
      frameDt[0] = dt;
      frameStep();
      const data = instance.data;
      const config = data.config;
      const anchor = instance.anchor;
      if (data.travel && dt > 0) {
        anchor.x += data.travel.x * dt;
        anchor.y += data.travel.y * dt;
        anchor.z += data.travel.z * dt;
      }
      // The emitter's own velocity (inheritance, doppler); a jump is a relocation, not motion.
      if (dt > 0) {
        const moveX = anchor.x - data.previousAnchor[0];
        const moveY = anchor.y - data.previousAnchor[1];
        const moveZ = anchor.z - data.previousAnchor[2];
        const moved = Math.sqrt(moveX * moveX + moveY * moveY + moveZ * moveZ);
        const relocated = moved > TELEPORT_SPEED * dt;
        data.velocity[0] = relocated ? 0 : moveX / dt;
        data.velocity[1] = relocated ? 0 : moveY / dt;
        data.velocity[2] = relocated ? 0 : moveZ / dt;
      }
      data.previousAnchor[0] = anchor.x;
      data.previousAnchor[1] = anchor.y;
      data.previousAnchor[2] = anchor.z;
      const source = config.attachCamera ? engineCtx.camera.position : anchor;
      data.previousPoint[0] = data.point[0];
      data.previousPoint[1] = data.point[1];
      data.previousPoint[2] = data.point[2];
      data.point[0] = source.x;
      data.point[1] = source.y;
      data.point[2] = source.z;
      const jumpX = data.point[0] - data.previousPoint[0];
      const jumpZ = data.point[2] - data.previousPoint[2];
      if (jumpX * jumpX + jumpZ * jumpZ > (TELEPORT_SPEED * Math.max(dt, 1 / 60)) ** 2) {
        data.previousPoint[0] = data.point[0];
        data.previousPoint[1] = data.point[1];
        data.previousPoint[2] = data.point[2];
      }
      // The field grid follows a moving emission point (a camera-attached emitter, a travelling one).
      const placement = data.fieldPlacement;
      const middleX = data.frameOrigin[0] + placement[0] + config.field.extent / 2;
      const middleZ = data.frameOrigin[2] + placement[2] + config.field.extent / 2;
      if (Math.abs(data.point[0] - middleX) > config.field.extent * 0.3 || Math.abs(data.point[2] - middleZ) > config.field.extent * 0.3) {
        placeField(data, data.point[0], data.point[1], data.point[2]);
        sampleFieldGround(data);
      }
      if (data.spawnGround) {
        if (data.spawnGround.drifted(data.point, 0.25)) data.spawnGround.recenter(data.point[0], data.point[2]);
        data.spawnGround.step(GROUND_SAMPLES_PER_FRAME);
      }

      // Emission level: base (or dormant), schedule, pulse, the end of the event.
      const levels = data.levels;
      if (dt > 0) data.age[0] += dt;
      advanceSchedule(data);
      const base = instance.active === false ? config.inactiveIntensity : config.intensity;
      let level = base * levels[1];
      if (config.pulse) {
        const wave = 0.5 + 0.5 * Math.sin(data.age[0] * Math.PI * 2 / config.pulse.period);
        level *= 1 - config.pulse.depth * wave;
      }
      if (config.duration !== null) {
        const over = data.age[0] - config.duration;
        if (over > 0) {
          data.ending = true;
          level *= config.endRamp > 0 ? Math.max(0, 1 - over / config.endRamp) : 0;
          if (over > config.endRamp + config.lifeMax) instance.ended = true;
        }
      }
      levels[0] = level;
      levels[2] = level;
      levels[3] = level;

      // Emission: the continuous rate (never more than the pages can hold over a life) and bursts.
      const share = data.share[0];
      if (data.warmStart && share > 0 && data.capacity > 0) {
        // Entering an emitting tier: the emitter appears as if it had been running for a life
        // (a plume first seen from 6 km is already a plume, not a puff growing from the ground).
        data.warmStart = false;
        const settled = Math.min(data.capacity * share, config.rate * level * share * config.lifeMax);
        if (settled >= 1) {
          refreshAxis(data);
          emitArgs[0] = config.lifeMax;
          emitArgs[1] = 1;
          emit(data, Math.floor(settled), false);
        }
      }
      if (dt > 0 && data.capacity > 0 && share > 0) {
        const maxRate = data.capacity * share / config.lifeMax;
        const rate = Math.min(config.rate * level * share, maxRate);
        data.debt[0] += rate * dt;
        let count = Math.floor(data.debt[0]);
        data.debt[0] -= count;
        if (count > MAX_EMIT_PER_FRAME) count = MAX_EMIT_PER_FRAME;
        refreshAxis(data);
        if (count > 0) {
          emitArgs[0] = dt;
          emitArgs[1] = 1;
          emit(data, count, true);
        }
        if (config.bursts) {
          data.burstTimer[0] -= dt;
          if (data.burstTimer[0] <= 0) fireBurst(data);
        }
      } else if (dt > 0) {
        data.debt[0] = 0;
      }
      if (data.pendingScheduleTrigger) fireScheduleTrigger(instance);

      // Frame row: the frame origin relative to the camera, the underglow, the fade.
      const camera = engineCtx.camera.position;
      const frameTable = system.frameData;
      const frameOffset = data.row * FRAME_ROWS * 4;
      frameTable[frameOffset] = data.frameOrigin[0] - camera.x;
      frameTable[frameOffset + 1] = data.frameOrigin[1] - camera.y;
      frameTable[frameOffset + 2] = data.frameOrigin[2] - camera.z;
      const time = engineCtx.time.elapsed;
      const night = engineCtx.time.nightFactor;
      if (config.underglow) {
        const glow = config.underglow;
        const flicker = 1 - glow.flicker * (0.5 + 0.5 * Math.sin(time * 9.7 + data.lightPhase) * Math.sin(time * 3.1 + data.lightPhase * 1.7));
        frameTable[frameOffset + 3] = glow.intensity * (0.25 + 0.75 * level) * flicker * (1 - glow.night + glow.night * night);
      } else {
        frameTable[frameOffset + 3] = 0;
      }

      // Couplings: the real light, the voice, the immersion modifier.
      if (data.light) {
        const lightConfig = config.light;
        const visible = 1 - lightConfig.night + lightConfig.night * night;
        const lightLevel = (1 - lightConfig.follow + lightConfig.follow * level) * visible;
        const wanted = data.tier !== 'far' && lightLevel > 0.02;
        const held = data.light.update(wanted, dt);
        if (held) {
          const frame = data.heading;
          const offset = lightConfig.offset;
          const lightState = data.light.state;
          lightState[0] = anchor.x + offset[0] * frame.rightX + offset[2] * frame.forwardX;
          lightState[1] = anchor.y + offset[1];
          lightState[2] = anchor.z + offset[0] * frame.rightZ + offset[2] * frame.forwardZ;
          const flicker = 1 - lightConfig.flicker * (0.5 + 0.5 * Math.sin(time * 11.3 + data.lightPhase) * Math.sin(time * 4.3 + data.lightPhase * 0.7));
          lightState[3] = lightConfig.intensity * lightLevel * flicker;
          data.light.apply();
        }
        const lights = held ? 1 : 0;
        lightsHeld += lights - instance.lights;
        instance.lights = lights;
      }
      if (data.voice) {
        data.voiceVelocity.x = data.velocity[0];
        data.voiceVelocity.y = data.velocity[1];
        data.voiceVelocity.z = data.velocity[2];
        data.voice.setPosition(anchor, data.voiceVelocity);
        data.voiceLevel[1] = level;
        sendVoiceLevel(data.voice, data.voiceLevel);
      }
      if (data.windActive || (config.windSource && data.tier !== 'far')) followWindSource(data);
      if (data.immersion) updateImmersion(data);
      instance.particles = Math.round(data.capacity * share);
    },
    setLOD(instance, tier) {
      const data = instance.data;
      const config = data.config;
      data.tier = tier;
      const share = config.lod[tier];
      if (data.share[0] <= 0 && share > 0 && config.warmStart) data.warmStart = true;
      data.share[0] = share;
      data.sizeScale[0] = config.lodSizeBoost && share > 0 && share < 1 ? Math.min(2.5, 1 / Math.sqrt(share)) : 1;
      instance.particles = Math.round(data.capacity * share);
      if (config.windSource) {
        const unreachable = tier === 'far' && data.windReach < data.lodMid;
        if (unreachable && data.windActive) removeWindSource(instance);
        else if (!unreachable && !data.windActive) addWindSource(instance);
      }
      if (data.light && tier === 'far') {
        data.light.update(false, 0);
        lightsHeld -= instance.lights;
        instance.lights = 0;
      }
    },
    dispose(instance) {
      const data = instance.data;
      removeWindSource(instance);
      if (data.light) {
        data.light.release();
        lightsHeld -= instance.lights;
        instance.lights = 0;
      }
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      if (data.immersion) {
        data.immersion.remove();
        data.immersion = null;
      }
      // Its particles end with it: the pages go back with every slot's life cleared.
      const pool = data.pool;
      for (let page = 0; page < data.pageCount; page++) {
        const first = data.pages[page] * PAGE_SIZE;
        for (let slot = first; slot < first + PAGE_SIZE; slot++) pool.kill(slot);
        pool.pageSlots.free(data.pages[page]);
      }
      pool.flush();
      pool.refreshCount();
      const frame = data.row * FRAME_ROWS;
      writeTableElement(system.frameData, frame, 0, 0, 0, 0);
      writeTableElement(system.frameData, frame + 1, 0, 0, 0, 0);
      system.rows.free(data.row);
      data.row = -1;
      data.pageCount = 0;
      data.capacity = 0;
      instance.particles = 0;
      const index = live.indexOf(instance);
      if (index >= 0) live.splice(index, 1);
    },
    /**
     * A dev snapshot of one instance (the engine step file and the F9 checks read it): its tier and
     * share, levels, particles emitted and held, and its couplings. Allocates; never per frame.
     */
    describe(instance) {
      const data = instance.data;
      return {
        tier: data.tier,
        share: data.share[0],
        pool: data.config.pool,
        capacity: data.capacity,
        emitted: data.emitted,
        level: data.levels[0],
        schedule: data.config.schedule ? { phase: data.scheduleState[0], envelope: data.levels[1] } : null,
        windActive: data.windActive,
        light: data.light ? data.light.held : false,
        voice: data.voice !== null,
        immersion: data.immersion ? data.immersionWeight[0] : null,
        ending: data.ending,
      };
    },
    stats() {
      let particles = 0;
      for (let index = 0; index < live.length; index++) particles += live[index].particles;
      const alpha = system ? system.pools.alpha : null;
      const additive = system ? system.pools.additive : null;
      return {
        instances: live.length,
        particles,
        lights: lightsHeld,
        buffers: system ? alpha.buffers + additive.buffers + 3 : 0,
        drawCalls: system ? (alpha.mesh.visible ? 1 : 0) + (additive.mesh.visible ? 1 : 0) : 0,
        compute: system ? system.useCompute : false,
        pages: system ? {
          alpha: { used: alpha.pageSlots.used, capacity: alpha.pageSlots.capacity },
          additive: { used: additive.pageSlots.used, capacity: additive.pageSlots.capacity },
        } : null,
      };
    },
  };
  return engine;
}
