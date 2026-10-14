// LightEffectEngine (registry name 'lightEffect', contract section 3): lightning, glows, firefly
// swarms, lantern light and sweeping beams. Every param is documented, with units, ranges and
// defaults, in docs/engines/lightEffect.md (the preset authors' reference).
//
// The light budget is strict: the engine declares 2 real lights (budget.lights) and takes them from
// the pool (ctx.lights) by priority, only while they matter (a strike for its flash, a lava vent or a
// lantern launch while the spawn is near). Everything else is emissive colour plus bloom:
//   - lightning (ribbons.js): a seeded, branching bolt in one of BOLT_SLOTS shared ribbon slots, its
//     return strokes flickering over a few tenths of a second, an in-cloud flash billboard that
//     lights the cloud base, a sky and ambient flash through the sky modifier API (the flash field),
//     one real light for the strike, and thunder (audio.thunder, delayed by distance / 343 m/s);
//   - glows and swarms (glowPoints.js): points in one shared additive pool, animated in the vertex
//     shader (drift, blink, pulse, flicker) with no per-point CPU work; a glow group may stand on the
//     world's landmarks of a type (every lighthouse in sight) and blink in a chain, one after another;
//   - a steady real light (a vent, a lantern launch, a lighthouse lamp) with flicker and pulse;
//   - beams (ribbons.js): a lighthouse's sweeping spokes in one of BEAM_SLOTS ribbon slots;
//   - arcs (Phase 3): bolts leaping between the arc points of a neighbouring structure spawn (the
//     crystal spires' tips), in the same bolt slots, while that structure's glow swells with them.
// Night looks come first: glows, swarms and beams fade by the time of day (params.visibility).
//
// LOD: strikes happen only at the near and mid tiers (a heavy storm's lure flashes beyond); glows
// fade by params.lod; the real lights are released at the far tier.
//
// No allocations in update(), strikes included: the instance's numbers live in typed arrays; a
// strike's random numbers come in one typed-array batch (fillRandoms: a double returned per call
// would be boxed); the strike records, the sky modifier values and the thunder options are reused;
// bolt geometry is regenerated into preallocated arrays; the per-frame uniforms are Vector4s. None of
// the terrain is sampled per frame (the ground under strikes and glows comes from a grid sampled at
// create).
import { GLOW_PAGE_SIZE, GLOW_SHAPES, createGlowPoints } from './glowPoints.js';
import { BOLT_RANDOMS, BOLT_SEGMENTS, createBoltScratch, createRibbonSlot, generateBeams, generateBolt } from './ribbons.js';
import { MAX_POOLED_LIGHT_INTENSITY, createGroundGrid, createHeadingFrame, createParamReader, createPooledLight, fillRandoms, ownsPresetAudio, randomIn, sendVoiceLevel, smoothstep } from './engineKit.js';

/** Light-effect instances at once (glow groups); the director's budget is 8. */
const MAX_INSTANCES = 8;
/**
 * Real lights the engine declares (budget.lights) and never exceeds, even when the shared pool has
 * a free light another engine declared: a strike that needs one takes it from the engine's own
 * lowest-priority steady light.
 */
const LIGHT_BUDGET = 2;
/** Glow point pages (GLOW_PAGE_SIZE points each): the budget's 30 000 points and a little more. */
const GLOW_PAGES = 120;
export const MAX_POINTS_PER_INSTANCE = 12000;
/** Bolts in flight at once, across every storm. */
const BOLT_SLOTS = 4;
const BEAM_SLOTS = 4;
/** Seconds of a return stroke's decay. */
const STROKE_DECAY = 0.055;
/** Minimum seconds between two strikes of one storm. */
const MIN_STRIKE_GAP = 0.25;
/**
 * A strike's own random numbers, by slot: 0-7 the position attempts (angle, distance), 8 cloud or
 * ground, 9 the duration, 10 the stroke count, 11-17 the stroke gaps, 18-19 the lean (or the in-cloud
 * angle and reach), 20 the wait for the next strike. The bolt's follow from STRIKE_RANDOMS.
 */
const STRIKE_RANDOMS = 21;
const DEG = Math.PI / 180;
const LAYOUTS = Object.freeze(['point', 'ring', 'scatter', 'line', 'landmarks']);
const LANDMARK_LAYOUT = LAYOUTS.indexOf('landmarks');
/** Landmark types a glow group may stand on (src/world/worldgen.js landmark sites). */
const GLOW_LANDMARKS = Object.freeze(['arch', 'monoliths', 'lighthouse', 'balloons']);
const TOP_LEVEL_PARAMS = Object.freeze(['lightning', 'arcs', 'glows', 'swarm', 'light', 'beam', 'visibility', 'fog', 'lod', 'sound', 'soundIntensity', 'endRamp']);
/** Seconds between two searches for an arc target that is not there (yet). */
const ARC_TARGET_RETRY = 1;
const ACTIVATION_PARAMS = Object.freeze(['position', 'heading', 'site', 'startTime', 'scale', 'duration', 'seed']);

/** Linear RGB of a 0xRRGGBB colour times gain into target[offset..offset + 2]. */
function writeColor(scratchColor, hex, gain, target, offset) {
  scratchColor.setHex(hex);
  target[offset] = scratchColor.r * gain;
  target[offset + 1] = scratchColor.g * gain;
  target[offset + 2] = scratchColor.b * gain;
}

function readBlink(read, blink, path, fallbackPeriod, fallbackDuty) {
  read.onlyKeys(blink, path, ['period', 'duty']);
  return {
    period: read.range(blink?.period, `${path}.period`, fallbackPeriod, 0, 3600),
    duty: read.number(blink?.duty, `${path}.duty`, fallbackDuty, 0, 1),
  };
}

function readWander(read, wander, path, fallback) {
  read.onlyKeys(wander, path, ['radius', 'speed', 'vertical']);
  return {
    radius: read.number(wander?.radius, `${path}.radius`, fallback.radius, 0, 10000),
    speed: read.number(wander?.speed, `${path}.speed`, fallback.speed, 0, 100),
    vertical: read.number(wander?.vertical, `${path}.vertical`, fallback.vertical, 0, 4),
  };
}

function readColors(read, value, path, fallback) {
  if (value === undefined || value === null) return fallback;
  if (Number.isInteger(value)) return [read.color(value, path, 0xffffff)];
  if (!Array.isArray(value) || value.length === 0) read.fail(path, 'must be a 0xRRGGBB colour or a non-empty array of them');
  return value.map((color, index) => read.color(color, `${path}[${index}]`, 0xffffff));
}

/**
 * Reads and checks the params of one light effect (preset data plus the activation) into a plain
 * config. Throws a TypeError naming the preset and the param at fault.
 */
export function resolveLightEffectConfig(preset, params) {
  const read = createParamReader(`lightEffect preset "${preset.id}"`);
  const presetParams = {};
  for (const key of Object.keys(params)) if (!ACTIVATION_PARAMS.includes(key)) presetParams[key] = params[key];
  read.onlyKeys(presetParams, '', TOP_LEVEL_PARAMS);
  const scale = Number.isFinite(params.scale) && params.scale > 0 ? params.scale : 1;

  const lightningParams = read.object(params.lightning, 'lightning');
  read.onlyKeys(lightningParams, 'lightning', [
    'rate', 'radius', 'cloudBase', 'groundShare', 'color', 'width', 'brightness', 'branches', 'strokes', 'duration',
    'flash', 'flashRange', 'cloudGlow', 'light', 'thunder', 'intensity', 'inactiveIntensity', 'minCameraDistance',
  ]);
  let lightning = null;
  if (lightningParams) {
    const glowParams = read.object(lightningParams.cloudGlow, 'lightning.cloudGlow');
    read.onlyKeys(glowParams, 'lightning.cloudGlow', ['radius', 'intensity', 'color']);
    const strikeLight = lightningParams.light === false ? null : read.object(lightningParams.light, 'lightning.light') ?? {};
    read.onlyKeys(strikeLight, 'lightning.light', ['intensity', 'range', 'priority']);
    const color = read.color(lightningParams.color, 'lightning.color', 0xcfe0ff);
    lightning = {
      rate: read.number(lightningParams.rate, 'lightning.rate', 6, 0, 600),
      radius: read.number(lightningParams.radius, 'lightning.radius', 3000, 0, 100000) * scale,
      cloudBase: read.number(lightningParams.cloudBase, 'lightning.cloudBase', 1400, 50, 20000) * scale,
      groundShare: read.number(lightningParams.groundShare, 'lightning.groundShare', 0.55, 0, 1),
      color,
      width: read.number(lightningParams.width, 'lightning.width', 4, 0.1, 200),
      brightness: read.number(lightningParams.brightness, 'lightning.brightness', 6, 0, 100),
      branches: Math.round(read.number(lightningParams.branches, 'lightning.branches', 6, 0, 24)),
      strokes: read.range(lightningParams.strokes, 'lightning.strokes', [1, 4], 1, 8),
      duration: read.number(lightningParams.duration, 'lightning.duration', 0.7, 0.1, 5),
      flash: read.number(lightningParams.flash, 'lightning.flash', 0.6, 0, 1),
      flashRange: read.number(lightningParams.flashRange, 'lightning.flashRange', 18000, 1, 200000),
      cloudGlow: {
        radius: read.number(glowParams?.radius, 'lightning.cloudGlow.radius', 1600, 0, 50000) * scale,
        intensity: read.number(glowParams?.intensity, 'lightning.cloudGlow.intensity', 1.2, 0, 50),
        color: read.color(glowParams?.color, 'lightning.cloudGlow.color', color),
      },
      light: strikeLight ? {
        intensity: read.number(strikeLight.intensity, 'lightning.light.intensity', 2e7, 0, MAX_POOLED_LIGHT_INTENSITY),
        range: read.number(strikeLight.range, 'lightning.light.range', 8000, 1, 100000),
        priority: read.number(strikeLight.priority, 'lightning.light.priority', 3, 0, 100),
      } : null,
      thunder: read.number(lightningParams.thunder, 'lightning.thunder', 1, 0, 1.5),
      intensity: read.number(lightningParams.intensity, 'lightning.intensity', 1, 0, 1),
      inactiveIntensity: read.number(lightningParams.inactiveIntensity, 'lightning.inactiveIntensity', 0, 0, 1),
      minCameraDistance: read.number(lightningParams.minCameraDistance, 'lightning.minCameraDistance', 350, 0, 100000),
    };
  }

  const arcParams = read.object(params.arcs, 'arcs');
  read.onlyKeys(arcParams, 'arcs', ['target', 'radius', 'rate', 'maxGap', 'color', 'width', 'brightness', 'branches', 'duration', 'glow', 'thunder', 'resonance', 'chime']);
  let arcs = null;
  if (arcParams) {
    if (typeof arcParams.target !== 'string' || arcParams.target.length === 0) read.fail('arcs.target', 'must name the preset whose structure offers arc points (for example "crystalSpires")');
    arcs = {
      target: arcParams.target,
      radius: read.number(arcParams.radius, 'arcs.radius', 3000, 1, 20000),
      rate: read.number(arcParams.rate, 'arcs.rate', 24, 0, 600),
      maxGap: read.number(arcParams.maxGap, 'arcs.maxGap', 180, 5, 2000),
      color: read.color(arcParams.color, 'arcs.color', 0xbfe8ff),
      width: read.number(arcParams.width, 'arcs.width', 1.6, 0.1, 50),
      brightness: read.number(arcParams.brightness, 'arcs.brightness', 8, 0, 100),
      branches: Math.round(read.number(arcParams.branches, 'arcs.branches', 3, 0, 24)),
      duration: read.number(arcParams.duration, 'arcs.duration', 0.45, 0.1, 5),
      glow: read.number(arcParams.glow, 'arcs.glow', 0.8, 0, 50),
      thunder: read.number(arcParams.thunder, 'arcs.thunder', 0.35, 0, 1.5),
      resonance: read.number(arcParams.resonance, 'arcs.resonance', 1.5, 0, 4),
      chime: read.boolean(arcParams.chime, 'arcs.chime', true),
    };
  }

  if (params.glows !== undefined && params.glows !== null && !Array.isArray(params.glows)) read.fail('glows', 'must be an array of glow specs');
  const glows = (params.glows ?? []).map((glow, index) => {
    const path = `glows[${index}]`;
    read.object(glow, path);
    read.onlyKeys(glow, path, ['offset', 'count', 'layout', 'radius', 'length', 'height', 'onGround', 'size', 'color', 'colors', 'intensity', 'pulse', 'blink', 'flicker', 'wander', 'shape', 'landmark', 'chain']);
    const pulse = read.object(glow.pulse, `${path}.pulse`);
    read.onlyKeys(pulse, `${path}.pulse`, ['period', 'depth']);
    const chain = read.object(glow.chain, `${path}.chain`);
    read.onlyKeys(chain, `${path}.chain`, ['interval', 'period', 'duty', 'delay', 'trigger']);
    if (chain && chain.trigger !== undefined && (typeof chain.trigger !== 'string' || chain.trigger.length === 0)) read.fail(`${path}.chain.trigger`, 'must name a trigger of the preset audio recipe (for example "horn")');
    const layout = LAYOUTS.indexOf(read.oneOf(glow.layout, `${path}.layout`, 'point', LAYOUTS));
    if (layout === LANDMARK_LAYOUT && glow.landmark === undefined) read.fail(`${path}.landmark`, `is needed with layout 'landmarks' (one of ${GLOW_LANDMARKS.join(', ')})`);
    if (layout !== LANDMARK_LAYOUT && glow.landmark !== undefined) read.fail(`${path}.landmark`, "is only for layout 'landmarks'");
    return {
      offset: read.vector(glow.offset, `${path}.offset`, [0, 0, 0]).map((value) => value * scale),
      count: Math.round(read.number(glow.count, `${path}.count`, 1, 1, MAX_POINTS_PER_INSTANCE)),
      layout,
      landmark: layout === LANDMARK_LAYOUT ? read.oneOf(glow.landmark, `${path}.landmark`, 'lighthouse', GLOW_LANDMARKS) : null,
      chain: chain ? {
        interval: read.number(chain.interval, `${path}.chain.interval`, 2.5, 0, 600),
        period: read.number(chain.period, `${path}.chain.period`, 30, 0.5, 3600),
        duty: read.number(chain.duty, `${path}.chain.duty`, 0.15, 0.01, 1),
        delay: read.number(chain.delay, `${path}.chain.delay`, 0, 0, 600),
        trigger: chain.trigger ?? null,
      } : null,
      radius: read.number(glow.radius, `${path}.radius`, 50, 0, 100000) * scale,
      length: read.number(glow.length, `${path}.length`, 500, 0, 100000) * scale,
      height: read.range(glow.height, `${path}.height`, [0, 0], -10000, 30000).map((value) => value * scale),
      onGround: read.boolean(glow.onGround, `${path}.onGround`, false),
      size: read.range(glow.size, `${path}.size`, [20, 20], 0.01, 50000).map((value) => value * scale),
      colors: readColors(read, glow.colors ?? glow.color, `${path}.color`, [0xffb060]),
      intensity: read.number(glow.intensity, `${path}.intensity`, 2, 0, 200),
      pulse: pulse ? {
        period: read.number(pulse.period, `${path}.pulse.period`, 4, 0.01, 3600),
        depth: read.number(pulse.depth, `${path}.pulse.depth`, 0.4, 0, 1),
      } : null,
      blink: glow.blink ? readBlink(read, read.object(glow.blink, `${path}.blink`), `${path}.blink`, [2, 4], 0.3) : null,
      flicker: read.number(glow.flicker, `${path}.flicker`, 0, 0, 1),
      wander: readWander(read, read.object(glow.wander, `${path}.wander`), `${path}.wander`, { radius: 0, speed: 0.3, vertical: 0.5 }),
      shape: GLOW_SHAPES.indexOf(read.oneOf(glow.shape, `${path}.shape`, 'orb', GLOW_SHAPES)),
    };
  });

  const swarmParams = read.object(params.swarm, 'swarm');
  read.onlyKeys(swarmParams, 'swarm', ['count', 'radius', 'height', 'size', 'colors', 'intensity', 'blink', 'sync', 'wander']);
  const swarm = swarmParams ? {
    count: Math.round(read.number(swarmParams.count, 'swarm.count', 1500, 1, MAX_POINTS_PER_INSTANCE)),
    radius: read.number(swarmParams.radius, 'swarm.radius', 150, 1, 20000) * scale,
    height: read.range(swarmParams.height, 'swarm.height', [0.5, 4], -100, 2000),
    size: read.range(swarmParams.size, 'swarm.size', [0.8, 1.3], 0.01, 100),
    colors: readColors(read, swarmParams.colors, 'swarm.colors', [0xd8ff6a, 0xfff08a, 0xb8ff8a]),
    intensity: read.number(swarmParams.intensity, 'swarm.intensity', 4, 0, 200),
    blink: readBlink(read, read.object(swarmParams.blink, 'swarm.blink'), 'swarm.blink', [2, 5], 0.25),
    sync: read.number(swarmParams.sync, 'swarm.sync', 0.2, 0, 1),
    wander: readWander(read, read.object(swarmParams.wander, 'swarm.wander'), 'swarm.wander', { radius: 1.5, speed: 0.35, vertical: 0.5 }),
  } : null;
  // A chain's timing reads the full spread of the blink phases, which a swarm's sync narrows.
  if (swarm && glows.some((glow) => glow.chain)) read.fail('swarm', 'cannot share an instance with a chained glow group (its sync would shift the chain)');
  const glowPoints = glows.reduce((sum, glow) => sum + glow.count, 0) + (swarm ? swarm.count : 0);
  if (glowPoints > MAX_POINTS_PER_INSTANCE) read.fail('glows', `and swarm together ask for ${glowPoints} points; one instance holds at most ${MAX_POINTS_PER_INSTANCE}`);

  const lightParams = read.object(params.light, 'light');
  read.onlyKeys(lightParams, 'light', ['color', 'intensity', 'range', 'offset', 'flicker', 'pulse', 'priority', 'night']);
  const lightPulse = read.object(lightParams?.pulse, 'light.pulse');
  read.onlyKeys(lightPulse, 'light.pulse', ['period', 'depth']);
  const beamParams = read.object(params.beam, 'beam');
  read.onlyKeys(beamParams, 'beam', ['offset', 'count', 'length', 'width', 'color', 'intensity', 'period', 'tilt', 'night']);
  const visibilityParams = read.object(params.visibility, 'visibility');
  read.onlyKeys(visibilityParams, 'visibility', ['day', 'night']);
  const lodParams = read.object(params.lod, 'lod');
  read.onlyKeys(lodParams, 'lod', ['near', 'mid', 'far']);

  return {
    lightning,
    arcs,
    glows,
    swarm,
    points: glowPoints,
    light: lightParams ? {
      color: read.color(lightParams.color, 'light.color', 0xffa050),
      intensity: read.number(lightParams.intensity, 'light.intensity', 2e5, 0, MAX_POOLED_LIGHT_INTENSITY),
      range: read.number(lightParams.range, 'light.range', 600, 1, 100000),
      offset: read.vector(lightParams.offset, 'light.offset', [0, 10, 0]).map((value) => value * scale),
      flicker: read.number(lightParams.flicker, 'light.flicker', 0, 0, 1),
      pulse: lightPulse ? {
        period: read.number(lightPulse.period, 'light.pulse.period', 4, 0.01, 3600),
        depth: read.number(lightPulse.depth, 'light.pulse.depth', 0.4, 0, 1),
      } : null,
      priority: read.number(lightParams.priority, 'light.priority', 1, 0, 100),
      night: read.number(lightParams.night, 'light.night', 1, 0, 1),
    } : null,
    beam: beamParams ? {
      offset: read.vector(beamParams.offset, 'beam.offset', [0, 30, 0]).map((value) => value * scale),
      count: Math.round(read.number(beamParams.count, 'beam.count', 2, 1, 8)),
      length: read.number(beamParams.length, 'beam.length', 1200, 1, 50000) * scale,
      width: read.range(beamParams.width, 'beam.width', [2, 60], 0.01, 5000).map((value) => value * scale),
      color: read.color(beamParams.color, 'beam.color', 0xfff2d0),
      intensity: read.number(beamParams.intensity, 'beam.intensity', 1.2, 0, 100),
      period: read.number(beamParams.period, 'beam.period', 12, 0.1, 3600),
      tilt: read.number(beamParams.tilt, 'beam.tilt', 2, -89, 89) * DEG,
      night: read.number(beamParams.night, 'beam.night', 1, 0, 1),
    } : null,
    visibility: {
      day: read.number(visibilityParams?.day, 'visibility.day', 0.15, 0, 1),
      night: read.number(visibilityParams?.night, 'visibility.night', 1, 0, 1),
    },
    fog: read.number(params.fog, 'fog', 0.7, 0, 1),
    lod: {
      near: read.number(lodParams?.near, 'lod.near', 1, 0, 1),
      mid: read.number(lodParams?.mid, 'lod.mid', 1, 0, 1),
      far: read.number(lodParams?.far, 'lod.far', 0.8, 0, 1),
    },
    sound: read.boolean(params.sound, 'sound', null),
    soundIntensity: read.oneOf(params.soundIntensity, 'soundIntensity', 'activity', ['activity', 'approach']),
    endRamp: read.number(params.endRamp, 'endRamp', 4, 0, 600),
    duration: Number.isFinite(params.duration) && params.duration > 0 ? params.duration : null,
    scale,
  };
}

/** Creates the light-effect engine (see the file header). */
export function createLightEffectEngine() {
  let ctx = null;
  let points = null;
  let serial = 0;
  let lastFrame = -1;
  let scratchColor = null;
  let boltScratch = null;
  /** A strike's random batch: its own STRIKE_RANDOMS, then the bolt's BOLT_RANDOMS. */
  const strikeRandoms = new Float64Array(STRIKE_RANDOMS + BOLT_RANDOMS);
  /** A ground lookup: [x, z] in, the height out in [2]. */
  const groundPoint = new Float64Array(3);
  const bolts = [];
  const beams = [];
  const live = [];
  /** thunderRequests: strikes that asked for thunder; thunder: those the audio engine queued (it
   * needs a listener, so none before the audio has started). */
  const strikeCounters = { strikes: 0, ground: 0, cloud: 0, arcs: 0, thunderRequests: 0, thunder: 0, skipped: 0 };
  /** chainTiming's reused result. */
  const chainScratch = { phase: 0, period: 1, duty: 0.1 };

  // ---- The engine's real-light cap ------------------------------------------------------------------
  /** Real lights the engine's instances hold right now (steady and strike). */
  function countHeld() {
    let held = 0;
    for (let index = 0; index < live.length; index++) {
      const data = live[index].data;
      if (data.light && data.light.held) held++;
      if (data.strikeLight && data.strikeLight.held) held++;
    }
    return held;
  }

  /**
   * Makes room under LIGHT_BUDGET for a light of priority: true when one is free, or when a steady
   * light of lower priority was given up for it (its holder asks again a second later).
   */
  function makeRoomForLight(priority) {
    if (countHeld() < LIGHT_BUDGET) return true;
    let weakest = null;
    for (let index = 0; index < live.length; index++) {
      const light = live[index].data.light;
      if (light && light.held && light.priority < priority && (weakest === null || light.priority < weakest.priority)) weakest = light;
    }
    if (weakest === null) return false;
    weakest.release();
    return true;
  }

  /** Writes four numbers into row (0 or 1) of a glow group (create and dispose: it boxes them). */
  function writeGroupRow(group, row, x, y, z, w) {
    const offset = (group * 2 + row) * 4;
    points.groupData[offset] = x;
    points.groupData[offset + 1] = y;
    points.groupData[offset + 2] = z;
    points.groupData[offset + 3] = w;
  }

  // ---- Bolt slots ---------------------------------------------------------------------------------
  /** Takes a free bolt slot, or the one that struck longest ago. */
  function takeBoltSlot() {
    let oldest = bolts[0];
    for (let index = 0; index < bolts.length; index++) {
      const bolt = bolts[index];
      if (bolt.owner === null) return bolt;
      if (bolt.start[0] < oldest.start[0]) oldest = bolt;
    }
    return oldest;
  }

  /**
   * Writes the flash envelope of a bolt now into bolt.level[0] (decaying return strokes, then a
   * fade). Returns false once the bolt has burned out (its age is past its duration).
   */
  function updateEnvelope(bolt) {
    const age = ctx.time.elapsed - bolt.start[0];
    if (age < 0 || age > bolt.duration[0]) {
      bolt.level[0] = 0;
      return age <= bolt.duration[0];
    }
    let level = 0;
    for (let stroke = 0; stroke < bolt.strokeCount; stroke++) {
      const since = age - bolt.strokes[stroke];
      if (since >= 0) level += (stroke === 0 ? 1 : 0.75) * Math.exp(-since / STROKE_DECAY);
    }
    // The channel glows faintly between strokes, then fades out.
    level += 0.12;
    const fadeStart = bolt.duration[0] * 0.6;
    const fadeShare = Math.min(1, Math.max(0, (age - fadeStart) / (bolt.duration[0] - fadeStart)));
    bolt.level[0] = Math.min(1.6, level) * (1 - fadeShare * fadeShare * (3 - 2 * fadeShare));
    return true;
  }

  /**
   * Lights one strike of instance's storm (seeded position within its radius, never next to the
   * camera), reading strikeRandoms (filled by the caller).
   */
  function strike(instance) {
    const data = instance.data;
    const lightning = data.config.lightning;
    const random = strikeRandoms;
    const anchor = instance.anchor;
    const camera = ctx.camera.position;
    let x = 0;
    let z = 0;
    let found = false;
    for (let attempt = 0; attempt < 4 && !found; attempt++) {
      const angle = random[attempt * 2] * Math.PI * 2;
      const distance = Math.sqrt(random[attempt * 2 + 1]) * lightning.radius;
      x = anchor.x + Math.cos(angle) * distance;
      z = anchor.z + Math.sin(angle) * distance;
      const dx = x - camera.x;
      const dz = z - camera.z;
      found = dx * dx + dz * dz >= lightning.minCameraDistance * lightning.minCameraDistance;
    }
    if (!found) {
      strikeCounters.skipped++;
      return;
    }
    groundPoint[0] = x;
    groundPoint[1] = z;
    data.ground.sample(groundPoint);
    const ground = groundPoint[2];
    const cloudY = anchor.y + lightning.cloudBase;
    const toGround = random[8] < lightning.groundShare;
    const bolt = takeBoltSlot();
    bolt.owner = instance;
    bolt.start[0] = ctx.time.elapsed;
    bolt.duration[0] = lightning.duration * (0.8 + 0.4 * random[9]);
    bolt.strokeCount = Math.round(lightning.strokes[0] + (lightning.strokes[1] - lightning.strokes[0]) * random[10]);
    bolt.strokes[0] = 0;
    for (let stroke = 1; stroke < bolt.strokeCount; stroke++) bolt.strokes[stroke] = bolt.strokes[stroke - 1] + 0.05 + random[10 + stroke] * 0.12;
    bolt.ground[0] = toGround ? 1 : 0;
    // The mesh sits at the strike point; the channel runs from the cloud base down (or across it).
    const slotPosition = bolt.slot.mesh.position;
    slotPosition.x = x;
    slotPosition.y = toGround ? ground : cloudY;
    slotPosition.z = z;
    const flashPosition = bolt.flash.mesh.position;
    const height = cloudY - ground;
    const ends = boltScratch.ends;
    if (toGround) {
      const leanX = (random[18] * 2 - 1) * height * 0.25;
      const leanZ = (random[19] * 2 - 1) * height * 0.25;
      ends[0] = leanX;
      ends[1] = height;
      ends[2] = leanZ;
      ends[3] = 0;
      ends[4] = 0;
      ends[5] = 0;
      ends[6] = lightning.width;
      generateBolt(bolt.slot, boltScratch, random, STRIKE_RANDOMS, lightning.branches);
      flashPosition.x = x + leanX;
      flashPosition.y = cloudY;
      flashPosition.z = z + leanZ;
      strikeCounters.ground++;
    } else {
      // An in-cloud (spider) discharge: a long, dimmer channel along the cloud base.
      const angle = random[18] * Math.PI * 2;
      const reach = lightning.radius * (0.3 + 0.4 * random[19]) + 800;
      ends[0] = -Math.cos(angle) * reach * 0.5;
      ends[1] = 0;
      ends[2] = -Math.sin(angle) * reach * 0.5;
      ends[3] = Math.cos(angle) * reach * 0.5;
      ends[4] = -60;
      ends[5] = Math.sin(angle) * reach * 0.5;
      ends[6] = lightning.width * 0.7;
      generateBolt(bolt.slot, boltScratch, random, STRIKE_RANDOMS, Math.min(lightning.branches, 4));
      flashPosition.x = x;
      flashPosition.y = cloudY;
      flashPosition.z = z;
      strikeCounters.cloud++;
    }
    bolt.brightness[0] = lightning.brightness * (toGround ? 1 : 0.45);
    bolt.glow[0] = lightning.cloudGlow.intensity;
    bolt.slot.color.value.setHex(lightning.color);
    bolt.flash.color.value.setHex(lightning.cloudGlow.color);
    bolt.flash.params.value.y = lightning.cloudGlow.radius * (toGround ? 1 : 1.4);
    bolt.slot.mesh.visible = true;
    bolt.flash.mesh.visible = lightning.cloudGlow.intensity > 0;
    strikeCounters.strikes++;
    // The strike's real light, low in the channel.
    if (data.strikeLight) {
      data.strikeLight.update(false, 0);
      if (makeRoomForLight(data.strikeLight.priority)) data.strikeLight.update(true, 1);
      const strikeState = data.strikeLight.state;
      strikeState[0] = x;
      strikeState[1] = ground + height * 0.3;
      strikeState[2] = z;
      strikeState[3] = 0;
      data.strikeLight.apply();
      data.strikeBolt = bolt;
    }
    // Thunder: the voice's recipe carries it when it is the thunder recipe, else the audio engine.
    const intensity = lightning.thunder * (toGround ? 1 : 0.6);
    if (intensity > 0 && ctx.audio) {
      strikeCounters.thunderRequests++;
      const options = data.thunderOptions;
      options.position.x = x;
      options.position.y = ground + height * 0.5;
      options.position.z = z;
      options.intensity = intensity;
      const sent = data.voice && data.voice.recipe === 'thunder' ? data.voice.trigger('strike', options) : typeof ctx.audio.thunder === 'function' && ctx.audio.thunder(options);
      if (sent) strikeCounters.thunder++;
    }
  }

  /**
   * One arc of instance's arcs: a bolt from a random arc point of its target structure to another
   * within maxGap (strikeRandoms filled by the caller), its flash at the middle, its real light (when
   * the instance has a strike light), a crack of thunder and the voice's chime.
   */
  function arc(instance) {
    const data = instance.data;
    const arcs = data.config.arcs;
    const points = data.arcTarget.data.arcPoints;
    const count = points.length / 3;
    const random = strikeRandoms;
    const from = Math.min(count - 1, Math.floor(random[0] * count));
    // The partner: a seeded pick among the other points within maxGap (the nearest when none is).
    let to = -1;
    let nearest = -1;
    let nearestSquared = Infinity;
    let within = 0;
    const gapSquared = arcs.maxGap * arcs.maxGap;
    const fromX = points[from * 3];
    const fromY = points[from * 3 + 1];
    const fromZ = points[from * 3 + 2];
    for (let index = 0; index < count; index++) {
      if (index === from) continue;
      const dx = points[index * 3] - fromX;
      const dy = points[index * 3 + 1] - fromY;
      const dz = points[index * 3 + 2] - fromZ;
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        nearest = index;
      }
      if (squared <= gapSquared) within++;
    }
    if (within > 0) {
      let pick = Math.min(within - 1, Math.floor(random[1] * within));
      for (let index = 0; index < count && to < 0; index++) {
        if (index === from) continue;
        const dx = points[index * 3] - fromX;
        const dy = points[index * 3 + 1] - fromY;
        const dz = points[index * 3 + 2] - fromZ;
        if (dx * dx + dy * dy + dz * dz > gapSquared) continue;
        if (pick === 0) to = index;
        pick--;
      }
    } else {
      to = nearest;
    }
    if (to < 0) {
      strikeCounters.skipped++;
      return;
    }
    const bolt = takeBoltSlot();
    bolt.owner = instance;
    bolt.start[0] = ctx.time.elapsed;
    bolt.duration[0] = arcs.duration * (0.8 + 0.4 * random[9]);
    bolt.strokeCount = Math.round(1 + 2 * random[10]);
    bolt.strokes[0] = 0;
    for (let stroke = 1; stroke < bolt.strokeCount; stroke++) bolt.strokes[stroke] = bolt.strokes[stroke - 1] + 0.04 + random[10 + stroke] * 0.08;
    bolt.ground[0] = 1;
    const slotPosition = bolt.slot.mesh.position;
    slotPosition.x = fromX;
    slotPosition.y = fromY;
    slotPosition.z = fromZ;
    const ends = boltScratch.ends;
    ends[0] = points[to * 3] - fromX;
    ends[1] = points[to * 3 + 1] - fromY;
    ends[2] = points[to * 3 + 2] - fromZ;
    ends[3] = 0;
    ends[4] = 0;
    ends[5] = 0;
    ends[6] = arcs.width;
    generateBolt(bolt.slot, boltScratch, random, STRIKE_RANDOMS, arcs.branches);
    const flashPosition = bolt.flash.mesh.position;
    flashPosition.x = fromX + ends[0] * 0.5;
    flashPosition.y = fromY + ends[1] * 0.5;
    flashPosition.z = fromZ + ends[2] * 0.5;
    bolt.brightness[0] = arcs.brightness;
    bolt.glow[0] = arcs.glow;
    bolt.slot.color.value.setHex(arcs.color);
    bolt.flash.color.value.setHex(arcs.color);
    bolt.flash.params.value.y = arcs.maxGap * 0.9;
    bolt.slot.mesh.visible = true;
    bolt.flash.mesh.visible = arcs.glow > 0;
    strikeCounters.arcs++;
    if (data.strikeLight) {
      data.strikeLight.update(false, 0);
      if (makeRoomForLight(data.strikeLight.priority)) data.strikeLight.update(true, 1);
      const strikeState = data.strikeLight.state;
      strikeState[0] = flashPosition.x;
      strikeState[1] = flashPosition.y;
      strikeState[2] = flashPosition.z;
      strikeState[3] = 0;
      data.strikeLight.apply();
      data.strikeBolt = bolt;
    }
    if (arcs.thunder > 0 && ctx.audio && typeof ctx.audio.thunder === 'function') {
      strikeCounters.thunderRequests++;
      const options = data.thunderOptions;
      options.position.x = flashPosition.x;
      options.position.y = flashPosition.y;
      options.position.z = flashPosition.z;
      options.intensity = arcs.thunder;
      if (ctx.audio.thunder(options)) strikeCounters.thunder++;
    }
    if (arcs.chime && data.voice) {
      data.chimeOptions.strength = 0.6 + 0.6 * random[20];
      data.voice.trigger('chime', data.chimeOptions);
    }
  }

  /**
   * The structure part the arcs leap across: the nearest live spawn of arcs.target within arcs.radius
   * whose structure offers at least two arc points, looked up again every ARC_TARGET_RETRY seconds
   * (a target that ended drops out of the manager's live list, and its glow is given back).
   * Allocation-free.
   */
  function findArcTarget(instance, dt) {
    const data = instance.data;
    data.arcRetry[0] -= dt;
    if (data.arcRetry[0] > 0) return data.arcTarget;
    data.arcRetry[0] = ARC_TARGET_RETRY;
    const spawns = ctx.spawns;
    const arcs = data.config.arcs;
    const found = spawns && typeof spawns.nearestPart === 'function' ? spawns.nearestPart(arcs.target, 'structure', instance.anchor.x, instance.anchor.z, arcs.radius) : null;
    const usable = found && found.data && found.data.arcPoints && found.data.arcPoints.length >= 6 ? found : null;
    if (usable !== data.arcTarget) releaseResonance(data);
    data.arcTarget = usable;
    return usable;
  }

  /** Gives the target structure its own glow back (the arcs' resonance ends). */
  function releaseResonance(data) {
    if (data.arcTarget && data.resonance[0] !== 1 && data.arcTarget.params) data.arcTarget.params.glow = 1;
    data.resonance[0] = 1;
    data.arcTarget = null;
  }

  /** Once per frame: the glow pool, the bolts' envelopes (a slot whose owner is gone goes dark). */
  function frameStep() {
    if (ctx.state.frame === lastFrame) return;
    lastFrame = ctx.state.frame;
    points.update(ctx.camera, ctx.time, ctx.scene.fog);
    for (let index = 0; index < bolts.length; index++) {
      const bolt = bolts[index];
      if (bolt.owner === null) continue;
      if (!updateEnvelope(bolt)) {
        bolt.owner = null;
        bolt.slot.mesh.visible = false;
        bolt.flash.mesh.visible = false;
        bolt.slot.params.value.x = 0;
        bolt.flash.params.value.x = 0;
        continue;
      }
      const level = bolt.level[0];
      bolt.slot.params.value.x = bolt.brightness[0] * level;
      bolt.flash.params.value.x = bolt.glow[0] * (0.35 + 0.65 * Math.min(1, level));
    }
  }

  /** The in-cloud flash billboard of a bolt slot: a wide soft disc facing the camera. */
  function createFlashBillboard(index) {
    const { THREE, TSL } = ctx;
    const { Fn, vec2, vec4, uniform, positionGeometry, modelViewMatrix, cameraProjectionMatrix, uv, length, pow, saturate, float } = TSL;
    // x: intensity, y: size (m). One Vector4 takes new numbers in place; float uniforms box them.
    const params = uniform(new THREE.Vector4(0, 1000, 0, 0));
    const intensity = params.x;
    const size = params.y;
    const color = uniform(new THREE.Color(1, 1, 1));
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    material.vertexNode = Fn(() => {
      const centre = modelViewMatrix.mul(vec4(0, 0, 0, 1));
      // Squashed a little: the lit cloud base is wider than it is tall.
      return cameraProjectionMatrix.mul(vec4(centre.xy.add(positionGeometry.xy.mul(size).mul(vec2(1, 0.55))), centre.zw));
    })();
    const falloff = pow(saturate(float(1).sub(length(uv().sub(0.5)).mul(2))), 2.2);
    material.colorNode = color.mul(intensity).mul(falloff);
    material.opacityNode = saturate(falloff.mul(intensity));
    const geometry = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `lightning-cloud-flash-${index}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    ctx.scene.add(mesh);
    return { mesh, params, color, geometry, material };
  }

  // ---- Points (glows and swarms) --------------------------------------------------------------------
  /**
   * Writes the instance's glows and swarm into its pages, never more than its pages hold (config.points:
   * a short pool leaves the last points out). Returns the points written.
   */
  function writePoints(instance) {
    const data = instance.data;
    const config = data.config;
    const rng = data.rng;
    const frame = data.heading;
    const origin = data.origin;
    const color = data.colorScratch;
    const limit = config.points;
    let written = 0;
    const slotOf = (index) => data.pages[Math.floor(index / GLOW_PAGE_SIZE)] * GLOW_PAGE_SIZE + (index % GLOW_PAGE_SIZE);
    for (let glowIndex = 0; glowIndex < config.glows.length; glowIndex++) {
      const glow = config.glows[glowIndex];
      const sites = glow.layout === LANDMARK_LAYOUT ? data.landmarkPoints[glowIndex] : null;
      const count = sites ? Math.min(glow.count, sites.length / 3) : glow.count;
      for (let index = 0; index < count && written < limit; index++) {
        let right = glow.offset[0];
        let forward = glow.offset[2];
        if (sites) {
          // On a landmark: the world point itself (offset[1] lifts it to the lamp).
          const siteX = sites[index * 3];
          const siteZ = sites[index * 3 + 2];
          const y = sites[index * 3 + 1] + glow.offset[1] + randomIn(rng, glow.height[0], glow.height[1]);
          writeColor(scratchColor, glow.colors[Math.floor(rng() * glow.colors.length)], glow.intensity, color, 0);
          const timing = chainTiming(glow, index, data.chainStart);
          points.write(
            slotOf(written), siteX - origin[0], y - origin[1], siteZ - origin[2], randomIn(rng, glow.size[0], glow.size[1]),
            color[0], color[1], color[2], data.group, glow.shape,
            glow.wander.radius, glow.wander.speed, timing.phase, glow.wander.vertical,
            timing.period, timing.duty, 0, glow.flicker,
          );
          written++;
          continue;
        }
        if (glow.layout === 1) {
          const angle = (index / glow.count) * Math.PI * 2;
          right += Math.cos(angle) * glow.radius;
          forward += Math.sin(angle) * glow.radius;
        } else if (glow.layout === 2) {
          const angle = rng() * Math.PI * 2;
          const distance = Math.sqrt(rng()) * glow.radius;
          right += Math.cos(angle) * distance;
          forward += Math.sin(angle) * distance;
        } else if (glow.layout === 3) {
          forward += (glow.count > 1 ? index / (glow.count - 1) - 0.5 : 0) * glow.length;
        }
        const x = origin[0] + right * frame.rightX + forward * frame.forwardX;
        const z = origin[2] + right * frame.rightZ + forward * frame.forwardZ;
        const base = glow.onGround ? data.ground.heightAt(x, z) : origin[1];
        const y = base + glow.offset[1] + randomIn(rng, glow.height[0], glow.height[1]);
        writeColor(scratchColor, glow.colors[Math.floor(rng() * glow.colors.length)], glow.intensity, color, 0);
        const blinkPeriod = glow.blink ? randomIn(rng, glow.blink.period[0], glow.blink.period[1]) : glow.pulse ? glow.pulse.period : 0;
        // Drawn in this order (size, wander rate, phase), as every glow always has been.
        const size = randomIn(rng, glow.size[0], glow.size[1]);
        const wanderRate = glow.wander.speed * (0.7 + 0.6 * rng());
        const seededPhase = rng() * Math.PI * 2;
        if (glow.chain) {
          // A chained group blinks point after point (the line layout runs along forward).
          const timing = chainTiming(glow, index, data.chainStart);
          points.write(
            slotOf(written), x - origin[0], y - origin[1], z - origin[2], size,
            color[0], color[1], color[2], data.group, glow.shape,
            glow.wander.radius, wanderRate, timing.phase, glow.wander.vertical,
            timing.period, timing.duty, 0, glow.flicker,
          );
          written++;
          continue;
        }
        points.write(
          slotOf(written), x - origin[0], y - origin[1], z - origin[2], size,
          color[0], color[1], color[2], data.group, glow.shape,
          glow.wander.radius, wanderRate, seededPhase, glow.wander.vertical,
          blinkPeriod, glow.blink ? glow.blink.duty : 0, glow.pulse ? glow.pulse.depth : 0, glow.flicker,
        );
        written++;
      }
    }
    const swarm = config.swarm;
    if (swarm) {
      for (let index = 0; index < swarm.count && written < limit; index++) {
        const angle = rng() * Math.PI * 2;
        const distance = Math.sqrt(rng()) * swarm.radius;
        const x = origin[0] + Math.cos(angle) * distance;
        const z = origin[2] + Math.sin(angle) * distance;
        const y = data.ground.heightAt(x, z) + randomIn(rng, swarm.height[0], swarm.height[1]);
        writeColor(scratchColor, swarm.colors[Math.floor(rng() * swarm.colors.length)], swarm.intensity, color, 0);
        points.write(
          slotOf(written), x - origin[0], y - origin[1], z - origin[2], randomIn(rng, swarm.size[0], swarm.size[1]),
          color[0], color[1], color[2], data.group, 2,
          swarm.wander.radius * (0.5 + rng()), swarm.wander.speed * (0.6 + 0.8 * rng()), rng() * Math.PI * 2, swarm.wander.vertical,
          randomIn(rng, swarm.blink.period[0], swarm.blink.period[1]), swarm.blink.duty, 0, 0,
        );
        written++;
      }
    }
    return written;
  }

  /**
   * The blink of point `order` of a chained glow group: lit for duty of each period, point after point
   * interval seconds apart from the chain's start (the shader's blink cycle is fract(time / period +
   * phase / 2 pi), so the phase sets the moment each point lights). Returns the shared record.
   */
  function chainTiming(glow, order, start) {
    const chain = glow.chain;
    const lit = start + chain.delay + order * chain.interval;
    const cycle = -lit / chain.period;
    chainScratch.phase = (cycle - Math.floor(cycle)) * Math.PI * 2;
    chainScratch.period = chain.period;
    chainScratch.duty = chain.duty;
    return chainScratch;
  }

  /**
   * A chained glow group's voice: as each point of the chain lights, the voice's chain trigger fires
   * once (the lighthouse's horn answering), louder for a point near the camera, its pitch a little
   * different per point. A frame that skips several steps fires only the newest. Allocation-free.
   */
  function fireChain(instance, glowIndex, now, camera) {
    const data = instance.data;
    const glow = data.config.glows[glowIndex];
    const chain = glow.chain;
    const since = now - data.chainStart - chain.delay;
    if (since < 0) return;
    const sites = data.landmarkPoints[glowIndex];
    const count = sites ? Math.min(glow.count, sites.length / 3) : glow.count;
    if (count <= 0) return;
    const cycle = Math.floor(since / chain.period);
    const within = since - cycle * chain.period;
    const order = Math.min(count - 1, chain.interval > 0 ? Math.floor(within / chain.interval) : count - 1);
    const step = cycle * count + order;
    if (step <= data.chainFired[glowIndex]) return;
    data.chainFired[glowIndex] = step;
    let distance = 0;
    if (sites) {
      const dx = sites[order * 3] - camera.x;
      const dz = sites[order * 3 + 2] - camera.z;
      distance = Math.sqrt(dx * dx + dz * dz);
    }
    const options = data.chainOptions;
    options.strength = Math.max(0.3, Math.min(1.2, 1.2 - distance / 12000));
    const golden = order * 0.618034;
    options.pitch = 0.85 + 0.3 * (golden - Math.floor(golden));
    data.voice.trigger(chain.trigger, options);
  }

  /**
   * For every glow group on landmarks: the world points (x, ground y, z per site) of the landmarks of
   * its type within its radius of the anchor, nearest first (the anchor's own landmark leads a chain).
   * The game's world answers (ctx.game.world.landmarkSitesNear); without it (the labs) the group is
   * empty. Runs at create only.
   */
  function landmarkPoints(config, anchor) {
    const world = ctx.game && ctx.game.world ? ctx.game.world : null;
    return config.glows.map((glow) => {
      if (glow.layout !== LANDMARK_LAYOUT) return null;
      if (!world || typeof world.landmarkSitesNear !== 'function') return new Float64Array(0);
      const sites = world.landmarkSitesNear(anchor.x, anchor.z, glow.radius)
        .filter((site) => site.type === glow.landmark)
        .map((site) => ({ site, distance: Math.hypot(site.x - anchor.x, site.z - anchor.z) }))
        .sort((first, second) => first.distance - second.distance)
        .slice(0, glow.count);
      const out = new Float64Array(sites.length * 3);
      sites.forEach(({ site }, index) => {
        out[index * 3] = site.x;
        out[index * 3 + 1] = ctx.terrain.groundHeight(site.x, site.z);
        out[index * 3 + 2] = site.z;
      });
      return out;
    });
  }

  // ---- Engine interface ----------------------------------------------------------------------------
  const engine = {
    name: 'lightEffect',
    budget: { instances: MAX_INSTANCES, particles: 30000, lights: LIGHT_BUDGET },
    init(engineCtx) {
      ctx = engineCtx;
      const { THREE, TSL } = ctx;
      scratchColor = new THREE.Color();
      boltScratch = createBoltScratch();
      points = createGlowPoints({ THREE, TSL, scene: ctx.scene, sky: ctx.sky, maxGroups: MAX_INSTANCES, pages: GLOW_PAGES });
      for (let index = 0; index < BOLT_SLOTS; index++) {
        bolts.push({
          slot: createRibbonSlot({ THREE, TSL, scene: ctx.scene, name: `lightning-bolt-${index}`, segmentCapacity: BOLT_SEGMENTS, kind: 'bolt' }),
          flash: createFlashBillboard(index),
          owner: null,
          start: new Float64Array(1),
          duration: new Float64Array(1),
          brightness: new Float64Array(1),
          /** The flash billboard's intensity for this bolt (the storm's cloud glow, or the arcs' glow). */
          glow: new Float64Array(1),
          level: new Float64Array(1),
          ground: new Float64Array(1),
          strokes: new Float64Array(8),
          strokeCount: 0,
        });
      }
      for (let index = 0; index < BEAM_SLOTS; index++) {
        beams.push({ slot: createRibbonSlot({ THREE, TSL, scene: ctx.scene, name: `light-beam-${index}`, segmentCapacity: 8, kind: 'beam', clock: ctx.uniforms.time }), owner: null });
      }
      if (typeof ctx.registerPrewarm === 'function') {
        ctx.registerPrewarm(points.mesh);
        ctx.registerPrewarm(bolts[0].slot.mesh);
        ctx.registerPrewarm(bolts[0].flash.mesh);
        ctx.registerPrewarm(beams[0].slot.mesh);
      }
    },
    create(preset, params, rng) {
      const { THREE } = ctx;
      const config = resolveLightEffectConfig(preset, params);
      const anchor = params.position;
      const group = points.groups.alloc();
      if (group < 0) throw new Error(`[DRIFTWING] lightEffect: every glow group (${MAX_INSTANCES}) is in use; preset "${preset.id}" cannot start`);
      const wanted = Math.ceil(config.points / GLOW_PAGE_SIZE);
      const pages = new Int32Array(wanted);
      let pageCount = 0;
      while (pageCount < wanted) {
        const page = points.pageSlots.alloc();
        if (page < 0) break;
        pages[pageCount++] = page;
      }
      const id = `lightEffect:${serial++}`;
      const heading = createHeadingFrame().set(Number.isFinite(params.heading) ? params.heading : 0);
      const span = Math.max(200, 2.2 * Math.max(config.lightning ? config.lightning.radius : 0, config.swarm ? config.swarm.radius : 0, ...config.glows.map((glow) => Math.abs(glow.offset[0]) + Math.abs(glow.offset[2]) + glow.radius + glow.length / 2)));
      const ground = createGroundGrid(ctx.terrain, { size: 12, span });
      ground.recenter(anchor.x, anchor.z);
      ground.fill();
      const data = {
        id,
        config,
        rng,
        heading,
        group,
        pages,
        pageCount,
        points: 0,
        ground,
        tier: 'near',
        lodMid: preset.lod.mid,
        origin: new Float64Array([anchor.x, anchor.y, anchor.z]),
        fade: new Float64Array([0]),
        tierShare: new Float64Array([1]),
        age: new Float64Array([0]),
        activity: new Float64Array([1]),
        nextStrike: new Float64Array([config.lightning && config.lightning.rate > 0 ? randomIn(rng, 0.5, 3) : Infinity]),
        nextArc: new Float64Array([config.arcs && config.arcs.rate > 0 ? randomIn(rng, 0.3, 1.5) : Infinity]),
        /** The structure part the arcs leap across (findArcTarget), and the seconds to the next search. */
        arcTarget: null,
        arcRetry: new Float64Array([0]),
        /** The glow multiplier last written to the arc target (1: its own glow). */
        resonance: new Float64Array([1]),
        chimeOptions: { strength: 1, notes: 2 },
        /** Chained glow groups count their blinks from here (the scene clock at create). */
        chainStart: ctx.time.elapsed,
        /** Per glow group: its landmarks' world points (layout 'landmarks'), else null. */
        landmarkPoints: landmarkPoints(config, anchor),
        /** Per glow group: the last chain step whose voice trigger fired (-1 before the first). */
        chainFired: new Float64Array(config.glows.length).fill(-1),
        chainOptions: { strength: 1, pitch: 1 },
        colorScratch: new Float64Array(3),
        lightPhase: rng() * 100,
        /** The strike generator's state (fillRandoms), seeded from the spawn's rng. */
        randomState: new Uint32Array([Math.floor(rng() * 4294967296)]),
        /** The intensity last sent to the voice (-1 before the first): unchanged levels are not re-sent. */
        /** The voice intensity: [last sent, wanted] (sendVoiceLevel). */
        voiceLevel: new Float64Array([-1, 0]),
        light: config.light ? createPooledLight(ctx.lights, { priority: config.light.priority, color: config.light.color, range: config.light.range }) : null,
        strikeLight: config.lightning && config.lightning.light ? createPooledLight(ctx.lights, { priority: config.lightning.light.priority, color: config.lightning.color, range: config.lightning.light.range }) : null,
        strikeBolt: null,
        flash: null,
        flashValues: null,
        flashStrength: { flash: 0 },
        beam: null,
        voice: null,
        thunderOptions: { position: new THREE.Vector3(), intensity: 1 },
      };
      if (config.points > 0 && pageCount * GLOW_PAGE_SIZE < config.points) {
        // The pool is short: the points that fit are written, the rest are left out.
        config.points = pageCount * GLOW_PAGE_SIZE;
      }
      const instance = {
        anchor,
        radius: Math.max(20, span * 0.3),
        windSourceIds: [],
        lights: 0,
        particles: 0,
        data,
      };
      writeGroupRow(group, 0, 0, 0, 0, 0);
      writeGroupRow(group, 1, 0, 4, 1 - (config.swarm ? config.swarm.sync : 0), config.fog);
      data.points = config.points > 0 ? writePoints(instance) : 0;
      instance.particles = data.points;
      // The couplings can refuse (an unknown audio recipe throws): the group, the pages and whatever
      // was already attached go back before the error reaches the SpawnManager.
      try {
        if (config.lightning && config.lightning.flash > 0 && ctx.sky && typeof ctx.sky.addModifier === 'function') {
          data.flash = ctx.sky.addModifier(`${id}:flash`, { priority: 30 });
          data.flashValues = { flash: 0, flashColor: new THREE.Color(config.lightning.color), weight: 1 };
          data.flash.set(data.flashValues);
        }
        if (config.beam) {
          const beam = beams.find((entry) => entry.owner === null) ?? null;
          if (beam) {
            beam.owner = instance;
            beam.slot.color.value.setHex(config.beam.color);
            generateBeams(beam.slot, config.beam.count, config.beam.length, config.beam.width[0], config.beam.width[1], config.beam.tilt);
            // The sweep starts now and turns once per period on the scene clock (the shader turns it).
            beam.slot.params.value.y = ctx.time.elapsed;
            beam.slot.params.value.z = config.beam.period;
            data.beam = beam;
          }
        }
        if (ownsPresetAudio(preset, 'lightEffect', config.sound) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
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
      frameStep();
      const data = instance.data;
      const config = data.config;
      const anchor = instance.anchor;
      const time = engineCtx.time;
      if (dt > 0) data.age[0] += dt;
      // Activity: the storm's intensity (a dormant site's level), easing out at the end of an event.
      let activity = 1;
      if (config.duration !== null) {
        const over = data.age[0] - config.duration;
        if (over > 0) {
          activity = config.endRamp > 0 ? Math.max(0, 1 - over / config.endRamp) : 0;
          if (activity <= 0 && data.age[0] > config.duration + config.endRamp + 1) instance.ended = true;
        }
      }
      data.activity[0] = activity;
      const night = time.nightFactor;
      const visibility = config.visibility.day + (config.visibility.night - config.visibility.day) * night;
      const fadeTarget = activity * data.tierShare[0];
      data.fade[0] += (fadeTarget - data.fade[0]) * (dt > 0 ? 1 - Math.exp(-dt * 1.5) : 0);
      const camera = engineCtx.camera.position;
      const groupTable = points.groupData;
      const groupOffset = data.group * 2 * 4;
      // The points were written relative to the anchor at create; they follow it if it moves. The
      // group table is relative to the pool's origin (the camera to the metre, glowPoints.js).
      const origin = points.origin;
      groupTable[groupOffset] = anchor.x - origin[0];
      groupTable[groupOffset + 1] = anchor.y - origin[1];
      groupTable[groupOffset + 2] = anchor.z - origin[2];
      groupTable[groupOffset + 3] = data.fade[0] * visibility;

      // Lightning: strikes at the near and mid tiers, while active.
      const lightning = config.lightning;
      if (lightning) {
        const base = instance.active === false ? lightning.inactiveIntensity : lightning.intensity;
        const rate = lightning.rate / 60 * base * activity;
        if (dt > 0 && data.tier !== 'far' && rate > 0) {
          data.nextStrike[0] -= dt;
          if (data.nextStrike[0] <= 0) {
            fillRandoms(data.randomState, strikeRandoms, strikeRandoms.length);
            strike(instance);
            data.nextStrike[0] = MIN_STRIKE_GAP - Math.log(1 - strikeRandoms[20] * 0.999) / rate;
          }
        }
        // The flash of this storm's brightest bolt in flight, by the camera's distance to it.
        let brightest = 0;
        let flashDistance = Infinity;
        for (let index = 0; index < bolts.length; index++) {
          const bolt = bolts[index];
          if (bolt.owner !== instance || bolt.level[0] <= brightest) continue;
          brightest = bolt.level[0];
          const position = bolt.flash.mesh.position;
          const dx = position.x - camera.x;
          const dy = position.y - camera.y;
          const dz = position.z - camera.z;
          flashDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        if (data.flash) {
          const reach = 1 - smoothstep(lightning.flashRange * 0.25, lightning.flashRange, flashDistance);
          const flash = Math.min(1, lightning.flash * brightest * reach * (0.35 + 0.65 * night));
          if (flash !== data.flashValues.flash) {
            // Only the strength changes after create: the flash colour was set once.
            data.flashValues.flash = flash;
            data.flashStrength.flash = flash;
            data.flash.set(data.flashStrength);
          }
        }
        if (data.strikeLight) {
          const bolt = data.strikeBolt;
          const holding = bolt !== null && bolt.owner === instance && data.tier !== 'far';
          if (!holding) {
            data.strikeLight.update(false, dt);
            data.strikeBolt = null;
          } else {
            data.strikeLight.state[3] = lightning.light.intensity * Math.min(1, bolt.level[0]) * (bolt.ground[0] > 0 ? 1 : 0.4);
            data.strikeLight.apply();
          }
        }
      }

      // Arcs: across the target structure's arc points, at the near and mid tiers, while active; its
      // glow swells with the activity (the spires resonate) and goes back when the arcs end.
      const arcs = config.arcs;
      if (arcs) {
        const target = findArcTarget(instance, dt);
        if (target) {
          const swell = 1 + arcs.resonance * data.fade[0];
          if (swell !== data.resonance[0]) {
            data.resonance[0] = swell;
            target.params.glow = swell;
          }
          const rate = arcs.rate / 60 * activity;
          if (dt > 0 && data.tier !== 'far' && rate > 0) {
            data.nextArc[0] -= dt;
            if (data.nextArc[0] <= 0) {
              fillRandoms(data.randomState, strikeRandoms, strikeRandoms.length);
              arc(instance);
              data.nextArc[0] = MIN_STRIKE_GAP * 0.5 - Math.log(1 - strikeRandoms[19] * 0.999) / rate;
            }
          }
        }
      }

      // The steady real light.
      if (data.light) {
        const lightConfig = config.light;
        const visible = 1 - lightConfig.night + lightConfig.night * night;
        const level = data.fade[0] * visible;
        const wanted = data.tier !== 'far' && level > 0.02;
        const held = data.light.update(wanted && (data.light.held || countHeld() < LIGHT_BUDGET), dt);
        if (held) {
          const frame = data.heading;
          const offset = lightConfig.offset;
          const lightState = data.light.state;
          lightState[0] = anchor.x + offset[0] * frame.rightX + offset[2] * frame.forwardX;
          lightState[1] = anchor.y + offset[1];
          lightState[2] = anchor.z + offset[0] * frame.rightZ + offset[2] * frame.forwardZ;
          const seconds = time.elapsed;
          const flicker = 1 - lightConfig.flicker * (0.5 + 0.5 * Math.sin(seconds * 12.7 + data.lightPhase) * Math.sin(seconds * 5.3 + data.lightPhase * 0.6));
          const pulse = lightConfig.pulse ? 1 - lightConfig.pulse.depth * (0.5 + 0.5 * Math.sin(seconds * Math.PI * 2 / lightConfig.pulse.period + data.lightPhase)) : 1;
          lightState[3] = lightConfig.intensity * level * flicker * pulse;
          data.light.apply();
        }
      }
      const lights = (data.light && data.light.held ? 1 : 0) + (data.strikeLight && data.strikeLight.held ? 1 : 0);
      instance.lights = lights;

      // The beam sweeps.
      if (data.beam) {
        const beamConfig = config.beam;
        const frame = data.heading;
        const offset = beamConfig.offset;
        const mesh = data.beam.slot.mesh;
        // Written only when it moved (see createPooledLight's apply: a steady beam writes nothing).
        const position = mesh.position;
        const beamX = anchor.x + offset[0] * frame.rightX + offset[2] * frame.forwardX;
        const beamY = anchor.y + offset[1];
        const beamZ = anchor.z + offset[0] * frame.rightZ + offset[2] * frame.forwardZ;
        if (position.x !== beamX) position.x = beamX;
        if (position.y !== beamY) position.y = beamY;
        if (position.z !== beamZ) position.z = beamZ;
        const beamVisible = 1 - beamConfig.night + beamConfig.night * night;
        const level = beamConfig.intensity * beamVisible * data.fade[0];
        // The sweep turns in the shader on the scene clock (create set its start and period).
        const beamParams = data.beam.slot.params.value;
        if (beamParams.x !== level) beamParams.x = level;
        mesh.visible = level > 0.001;
      }

      if (data.voice) {
        data.voice.setPosition(anchor);
        for (let glowIndex = 0; glowIndex < config.glows.length; glowIndex++) {
          if (config.glows[glowIndex].chain && config.glows[glowIndex].chain.trigger) fireChain(instance, glowIndex, time.elapsed, camera);
        }
        if (config.soundIntensity === 'approach') {
          const dx = anchor.x - camera.x;
          const dy = anchor.y - camera.y;
          const dz = anchor.z - camera.z;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          data.voiceLevel[1] = Math.max(0, 1 - distance / Math.max(1, data.lodMid)) * activity;
        } else {
          data.voiceLevel[1] = activity * (lightning ? (instance.active === false ? lightning.inactiveIntensity : lightning.intensity) : 1);
        }
        sendVoiceLevel(data.voice, data.voiceLevel);
      }
    },
    setLOD(instance, tier) {
      const data = instance.data;
      data.tier = tier;
      data.tierShare[0] = data.config.lod[tier];
      if (tier === 'far') {
        if (data.light) data.light.update(false, 0);
        if (data.strikeLight) data.strikeLight.update(false, 0);
        data.strikeBolt = null;
        instance.lights = 0;
      }
    },
    dispose(instance) {
      const data = instance.data;
      for (let index = 0; index < bolts.length; index++) {
        const bolt = bolts[index];
        if (bolt.owner !== instance) continue;
        bolt.owner = null;
        bolt.level[0] = 0;
        bolt.slot.mesh.visible = false;
        bolt.flash.mesh.visible = false;
        bolt.slot.params.value.x = 0;
        bolt.flash.params.value.x = 0;
      }
      if (data.light) data.light.release();
      if (data.strikeLight) data.strikeLight.release();
      instance.lights = 0;
      if (data.config.arcs) releaseResonance(data);
      if (data.flash) {
        data.flash.remove();
        data.flash = null;
      }
      if (data.beam) {
        data.beam.owner = null;
        data.beam.slot.mesh.visible = false;
        data.beam.slot.params.value.x = 0;
        data.beam = null;
      }
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      for (let page = 0; page < data.pageCount; page++) {
        const first = data.pages[page] * GLOW_PAGE_SIZE;
        for (let slot = first; slot < first + GLOW_PAGE_SIZE; slot++) points.clear(slot);
        points.pageSlots.free(data.pages[page]);
      }
      writeGroupRow(data.group, 0, 0, 0, 0, 0);
      points.groups.free(data.group);
      data.pageCount = 0;
      instance.particles = 0;
      const index = live.indexOf(instance);
      if (index >= 0) live.splice(index, 1);
      // The frame step runs only from a live instance's update: trim the draw count (and hide the
      // pool once the last instance is gone) and queue the cleared slots now.
      points.update(ctx.camera, ctx.time.elapsed, ctx.scene.fog);
    },
    /**
     * A dev snapshot of one instance (the engine step file and the F9 checks read it): its tier, fade,
     * points, lights and couplings, and the engine's strike counters. Allocates; never per frame.
     */
    describe(instance) {
      const data = instance.data;
      let boltsLit = 0;
      for (let index = 0; index < bolts.length; index++) if (bolts[index].owner === instance) boltsLit++;
      return {
        tier: data.tier,
        fade: data.fade[0],
        /** The glows' drawn level: the fade times the day or night visibility. */
        level: points.groupData[data.group * 2 * 4 + 3],
        activity: data.activity[0],
        points: data.points,
        light: data.light ? data.light.held : false,
        strikeLight: data.strikeLight ? data.strikeLight.held : false,
        bolts: boltsLit,
        flash: data.flashValues ? data.flashValues.flash : null,
        beam: data.beam !== null,
        voice: data.voice !== null,
        arcTarget: data.config.arcs ? (data.arcTarget ? data.arcTarget.data.arcPoints.length / 3 : 0) : null,
        landmarks: data.landmarkPoints.map((sites) => (sites ? sites.length / 3 : null)),
        chainStart: data.chainStart,
        resonance: data.resonance[0],
        strikes: { ...strikeCounters },
      };
    },
    stats() {
      let particles = 0;
      let boltsLive = 0;
      let beamsLive = 0;
      for (let index = 0; index < live.length; index++) particles += live[index].particles;
      for (let index = 0; index < bolts.length; index++) if (bolts[index].owner !== null) boltsLive++;
      for (let index = 0; index < beams.length; index++) if (beams[index].owner !== null) beamsLive++;
      return {
        instances: live.length,
        particles,
        lights: countHeld(),
        buffers: points ? points.buffers + bolts.length * 5 + beams.length * 4 : 0,
        drawCalls: (points && points.mesh.visible ? 1 : 0) + boltsLive * 2 + beamsLive,
        bolts: boltsLive,
        beams: beamsLive,
        strikes: { ...strikeCounters },
      };
    },
  };
  return engine;
}
