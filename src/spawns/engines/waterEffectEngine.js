// WaterEffectEngine (contract section 3, registry name 'waterEffect'): local water deformation and
// shading for spawns, on the shared water effects layer (src/render/waterEffects.js, the engine ctx's
// `water`). One engine instance is one effect:
//
//   whirlpool        a funnel displaced into the ocean with spiral ridges and flow-mapped foam arms,
//                    spinning up over spinUp seconds, with mist over the eye (the maelstrom)
//   splash           splashes at the anchor: one at create (interval null, then the instance ends)
//                    or one every interval seconds, anywhere within scatter metres (breach splashes)
//   spray            a continuous spray ring on the water with a foam ring and swirl (a waterspout's
//                    base); `follow` makes it track another part of the same spawn (the vortex)
//   bioluminescence  a glow region: glowing surf on the swell crests, plankton flashes near the
//                    camera, and every trail in the water glows (the craft, whales, spray)
//   plungePool       a waterfall's plunge pool: a local water disc when the pool lies above the sea
//                    (from the site's cliffStep stamp), churning foam, rising mist and ripples
//   wave             a travelling wave (Phase 3): a straight crest with tapered ends crossing the
//                    ocean (a rogue wave) or an expanding ring, with foam and spray along its crest;
//                    on a site with an estuary stamp it surges up the channel from the mouth (a tidal
//                    bore) and repeats; the water query lifts the surface with it, so craft ride it
//   shallows         clear turquoise water over a lagoon or a reef (Phase 3), fitted to a site's atoll
//                    or reef stamp, with an optional surf ring breaking along the reef crest
//
// Every param is documented with units and ranges in docs/engines/waterEffect.md. The engine creates
// no GPU resources per instance: it borrows slots (vortex, glow region, pool) and droplets from the
// layer, so dispose() returns memory by construction and only has to give the slots back. It authors
// no wind sources (the maelstrom's air column is the vortex engine's). Its frame update allocates
// nothing: descriptors (spray, vortex, pool, glow region, mark) are built once in create() and
// mutated, no freshly computed double is passed to a call (V8 would box it), and the effect's random
// numbers come from a small table drawn from the spawn's seeded generator at create.
//
// LOD: near runs everything; mid keeps the vortex, glow region and pool with spray at a third of its
// rate and no plankton flashes; far releases the slots and stops the spray (the ocean grid ends 4 km
// from the camera, the pool and the glow are invisible there), and they are taken again on the way in.

import { ownsPresetAudio } from './engineKit.js';

const EFFECTS = Object.freeze(['whirlpool', 'splash', 'spray', 'bioluminescence', 'plungePool', 'wave', 'shallows']);
/** A wave's crest spray is emitted from at most this many points along the crest per frame. */
const WAVE_SPRAY_POINTS = 6;
/** A wave fades in over its first WAVE_FADE_IN metres of travel and out over its last WAVE_FADE_OUT. */
const WAVE_FADE_IN = 220;
const WAVE_FADE_OUT = 320;
const TIER_SPRAY_SCALE = Object.freeze({ near: 1, mid: 0.35, far: 0 });
/** Seconds between attempts to take a layer slot that was full. */
const SLOT_RETRY_SECONDS = 1;
const TWO_PI = Math.PI * 2;
/** Entries in an instance's random table (a power of two), drawn from its seeded generator. */
const NOISE_SIZE = 64;
const NOISE_MASK = NOISE_SIZE - 1;
/** A waterOnly splash that lands on land tries this many points (one a frame) before it waits again. */
const WATER_ONLY_TRIES = 12;

/** Engine defaults per effect (docs/engines/waterEffect.md). A preset overrides any of them. */
export const WATER_EFFECT_DEFAULTS = Object.freeze({
  common: Object.freeze({ effect: 'splash', fadeIn: 2, fadeOut: 3, follow: null, voice: null, voiceIntensity: 1, glow: 0 }),
  whirlpool: Object.freeze({
    radius: 320, eyeShare: 0.11, depth: 18, spin: 0.8, arms: 4, twist: 8, ridge: 0.7, foam: 0.9, direction: 1,
    spinUp: 12, mistRate: 45, mistSize: 7, glow: 0,
  }),
  splash: Object.freeze({ interval: null, strength: 0.6, scatter: 0, glow: 0.6, waterOnly: false }),
  spray: Object.freeze({
    ringRadius: 22, rate: 260, height: 11, spread: 0.45, swirl: 9, size: 1.3, life: 2.4, foam: 0.6, glow: 0.4,
  }),
  bioluminescence: Object.freeze({ radius: 900, strength: 1, surf: 0.6, color: 0x1f9dff, flashRate: 12, flashRadius: 4.5 }),
  plungePool: Object.freeze({ radius: null, surfaceY: null, churn: 0.85, mistRate: 120, mistSize: 5.5, rippleInterval: 1.4, glow: 0 }),
  wave: Object.freeze({
    mode: 'front', height: 12, width: 45, lean: 0.45, crestLength: 700, taper: 250, speed: 16, travelHeading: 90, start: 1500,
    travel: 3000, growth: 1, spreadLoss: 150, interval: null, spray: 300, sprayHeight: 9, foam: 0.85, estuary: false, glow: 0,
  }),
  shallows: Object.freeze({ radius: 500, fade: 150, color: 0x3fd8c9, clarity: 0.75, surf: 0, surfRadius: null, surfWidth: 16, stamp: null }),
});

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Reads the resolved params for one effect: preset values over the effect's and the common defaults. */
function resolveParams(params) {
  const effect = EFFECTS.includes(params.effect) ? params.effect : null;
  if (!effect) throw new Error(`waterEffect: params.effect must be one of ${EFFECTS.join(', ')}, got ${JSON.stringify(params.effect)}`);
  const merged = { ...WATER_EFFECT_DEFAULTS.common, ...WATER_EFFECT_DEFAULTS[effect] };
  for (const key of Object.keys(merged)) {
    if (params[key] !== undefined) merged[key] = params[key];
  }
  merged.effect = effect;
  return merged;
}

/** The first resolved stamp of a type on a site, or null. */
function siteStampOf(site, type) {
  if (!site || !Array.isArray(site.stamps)) return null;
  for (const stamp of site.stamps) if (stamp && stamp.type === type) return stamp;
  return null;
}

/** The plunge pool of a site's cliffStep stamp, or null. */
function cliffStepOf(site) {
  if (!site || !Array.isArray(site.stamps)) return null;
  for (const stamp of site.stamps) if (stamp && stamp.type === 'cliffStep' && Number.isFinite(stamp.poolX)) return stamp;
  return null;
}

/** Creates the WaterEffectEngine (see the file header). */
export function createWaterEffectEngine() {
  let ctx = null;
  let water = null;
  let live = 0;
  const liveInstances = new Set();

  /** Takes the layer slots the effect needs (at near and mid). */
  function acquireSlots(data) {
    if (data.kind === 'whirlpool' && data.vortexSlot < 0) data.vortexSlot = water.acquireVortex();
    if (data.kind === 'bioluminescence' && data.regionSlot < 0) data.regionSlot = water.acquireGlowRegion();
    if (data.kind === 'plungePool' && data.poolOnDisc && data.poolSlot < 0) data.poolSlot = water.acquirePool();
    if (data.kind === 'wave' && data.waveSlot < 0) data.waveSlot = water.acquireWave();
    if (data.kind === 'shallows' && data.shallowsSlot < 0) data.shallowsSlot = water.acquireShallows();
  }

  function releaseSlots(data) {
    if (data.vortexSlot >= 0) water.releaseVortex(data.vortexSlot);
    if (data.regionSlot >= 0) water.releaseGlowRegion(data.regionSlot);
    if (data.poolSlot >= 0) water.releasePool(data.poolSlot);
    if (data.waveSlot >= 0) water.releaseWave(data.waveSlot);
    if (data.shallowsSlot >= 0) water.releaseShallows(data.shallowsSlot);
    data.vortexSlot = -1;
    data.regionSlot = -1;
    data.poolSlot = -1;
    data.waveSlot = -1;
    data.shallowsSlot = -1;
  }

  function wantsSlot(data) {
    return (data.kind === 'whirlpool' && data.vortexSlot < 0)
      || (data.kind === 'bioluminescence' && data.regionSlot < 0)
      || (data.kind === 'plungePool' && data.poolOnDisc && data.poolSlot < 0)
      || (data.kind === 'wave' && data.waveSlot < 0)
      || (data.kind === 'shallows' && data.shallowsSlot < 0);
  }

  /** Emits data.rate * dt droplets of spray (carrying the fraction to the next frame). */
  function emitRate(data, spray, dt) {
    data.emitCarry += data.rate * dt;
    const count = Math.floor(data.emitCarry);
    if (count <= 0) return 0;
    data.emitCarry -= count;
    spray.count = count;
    return water.emitSpray(spray);
  }

  /** The anchor follows another part of the spawn (a waterspout's vortex), found once. */
  function followPart(instance, data) {
    if (data.followIndex === null) return;
    if (data.followAnchor === null) {
      const parts = ctx.spawns ? ctx.spawns.getParts(instance.id) : null;
      const part = parts && parts[data.followIndex];
      data.followAnchor = part && part !== instance && part.anchor ? part.anchor : undefined;
    }
    if (!data.followAnchor) return;
    // Whole metres: V8 boxes a non-integer double written into a Vector3 field.
    instance.anchor.x = Math.round(data.followAnchor.x);
    instance.anchor.z = Math.round(data.followAnchor.z);
  }

  /** The next entry of the instance's random table, written to data.noiseValue (no double returned). */
  function drawNoise(data) {
    data.noiseValue = data.noise[data.noiseCursor];
    data.noiseCursor = (data.noiseCursor + 1) & NOISE_MASK;
  }

  function updateWhirlpool(instance, data, dt) {
    const fade = data.fade;
    const vortex = data.vortex;
    vortex.x = instance.anchor.x;
    vortex.z = instance.anchor.z;
    data.spinAge += dt;
    const spinUp = data.params.spinUp > 0 ? Math.min(Math.max(data.spinAge / data.params.spinUp, 0), 1) : 1;
    vortex.weight = fade * (spinUp * spinUp * (3 - 2 * spinUp));
    if (data.vortexSlot >= 0) water.setVortex(data.vortexSlot, vortex);
    const mistRate = data.params.mistRate * TIER_SPRAY_SCALE[instance.tier] * vortex.weight;
    if (mistRate > 0 && dt > 0) {
      const mist = data.spray;
      mist.x = vortex.x;
      mist.z = vortex.z;
      // The eye's surface: the funnel's full depth at its centre (computed here, not queried, so no
      // double is returned across a call).
      mist.y = ctx.terrain.waterLevel - vortex.depth * vortex.weight + 1;
      mist.swirl = vortex.spin * vortex.eyeRadius * 0.6 * vortex.direction;
      data.rate = mistRate;
      emitRate(data, mist, dt);
    }
  }

  function updateSplash(instance, data, dt) {
    if (dt <= 0) return;
    data.timer -= dt;
    if (data.timer > 0) return;
    const params = data.params;
    const mark = data.mark;
    drawNoise(data);
    const angle = data.noiseValue * TWO_PI;
    drawNoise(data);
    const reach = params.scatter * Math.sqrt(data.noiseValue);
    mark.x = instance.anchor.x + Math.cos(angle) * reach;
    mark.z = instance.anchor.z + Math.sin(angle) * reach;
    mark.strength = params.strength * data.fade;
    mark.glow = params.glow;
    // waterOnly: a splash scattered onto land (a bay's centre lies on its shore) draws another point on
    // the next frame, up to WATER_ONLY_TRIES times, before it gives up until the next interval. Whole-metre
    // coordinates reach the terrain unboxed; the height query runs only while a splash is due.
    if (params.waterOnly && !water.isWaterAt(Math.round(mark.x), Math.round(mark.z))) {
      data.landTries++;
      if (data.landTries < WATER_ONLY_TRIES) {
        data.timer = 0;
        return;
      }
    } else {
      data.lastSplash = water.splashMark(mark);
      data.splashes++;
    }
    data.landTries = 0;
    if (Array.isArray(params.interval)) {
      drawNoise(data);
      data.timer = params.interval[0] + data.noiseValue * (params.interval[1] - params.interval[0]);
    } else if (Number.isFinite(params.interval) && params.interval > 0) {
      data.timer = params.interval;
    } else {
      // A one-shot splash: the spray lives on in the layer; the instance is done.
      data.timer = Infinity;
      instance.ended = true;
    }
  }

  function updateSpray(instance, data, dt) {
    if (dt <= 0) return;
    const fade = data.fade;
    const params = data.params;
    const spray = data.spray;
    spray.x = instance.anchor.x;
    spray.z = instance.anchor.z;
    // The surface under the ring (a funnel lowers it), sampled twice a second.
    data.surfaceTimer -= dt;
    if (data.surfaceTimer <= 0) {
      data.surfaceTimer = 0.5;
      spray.y = water.surfaceHeightAt(spray.x, spray.z) + 0.4;
    }
    spray.alpha = 0.55 * fade;
    data.rate = params.rate * TIER_SPRAY_SCALE[instance.tier] * fade;
    emitRate(data, spray, dt);
    data.ringTimer -= dt;
    if (data.ringTimer <= 0) {
      data.ringTimer = 0.25;
      const mark = data.mark;
      mark.x = spray.x;
      mark.z = spray.z;
      mark.radius = spray.ringRadius;
      mark.width = Math.max(3, spray.ringRadius * 0.35);
      mark.foam = params.foam * fade;
      mark.glow = params.glow * fade;
      water.foamRing(mark);
    }
  }

  function updateBioluminescence(instance, data, dt) {
    const fade = data.fade;
    const params = data.params;
    if (data.regionSlot >= 0) {
      const region = data.region;
      region.x = instance.anchor.x;
      region.z = instance.anchor.z;
      region.strength = params.strength * fade;
      region.surf = params.surf * fade;
      water.setGlowRegion(data.regionSlot, region);
    }
    if (dt <= 0 || instance.tier !== 'near') return;
    // Plankton flashes: little glows the swell sets off around the camera, inside the bay.
    const camera = ctx.camera.position;
    const offsetX = camera.x - instance.anchor.x;
    const offsetZ = camera.z - instance.anchor.z;
    if (offsetX * offsetX + offsetZ * offsetZ > params.radius * params.radius) return;
    data.emitCarry += params.flashRate * dt * fade;
    const mark = data.mark;
    while (data.emitCarry >= 1) {
      data.emitCarry -= 1;
      drawNoise(data);
      const angle = data.noiseValue * TWO_PI;
      drawNoise(data);
      const reach = 30 + 170 * data.noiseValue;
      mark.x = camera.x + Math.cos(angle) * reach;
      mark.z = camera.z + Math.sin(angle) * reach;
      drawNoise(data);
      mark.radius = params.flashRadius * (0.6 + 0.8 * data.noiseValue);
      mark.foam = 0;
      drawNoise(data);
      mark.glow = 0.35 + 0.4 * data.noiseValue;
      // Plankton glow only in the open ocean (never in a lake the bay's radius reaches).
      if (!water.isOceanAt(Math.round(mark.x), Math.round(mark.z))) continue;
      water.disturb(mark);
      data.flashes++;
    }
  }

  function updatePlungePool(instance, data, dt) {
    const fade = data.fade;
    const params = data.params;
    const pool = data.pool;
    pool.churn = params.churn * fade;
    pool.glow = params.glow * fade;
    if (data.poolSlot >= 0) water.setPool(data.poolSlot, pool);
    if (dt <= 0) return;
    const mist = data.spray;
    mist.x = pool.x;
    mist.y = pool.y + 1.5;
    mist.z = pool.z;
    mist.alpha = 0.35 * fade;
    data.rate = params.mistRate * TIER_SPRAY_SCALE[instance.tier] * fade;
    emitRate(data, mist, dt);
    if (data.poolOnDisc) return;
    // The pool lies on the open sea: churn the ocean itself.
    data.timer -= dt;
    if (data.timer <= 0) {
      data.timer = params.rippleInterval;
      const mark = data.mark;
      mark.x = pool.x;
      mark.z = pool.z;
      mark.strength = 0.45 * fade;
      water.ripple(mark);
      mark.radius = pool.radius * 0.6;
      mark.foam = params.churn * fade;
      mark.glow = params.glow * fade;
      water.disturb(mark);
    }
  }

  /** The interval before a repeating wave's next run (s), drawn from the instance's random table. */
  function nextWaveInterval(data) {
    const interval = data.params.interval;
    if (Array.isArray(interval)) {
      drawNoise(data);
      return interval[0] + data.noiseValue * (interval[1] - interval[0]);
    }
    return interval;
  }

  /**
   * A travelling wave: its crest runs data.waveTravel metres from the origin at params.speed, fading in
   * and out over its first and last metres, growing by params.growth (a bore in a narrowing channel),
   * a ring losing height as it spreads. Spray rises from points along the crest; the voice follows the
   * crest point nearest the camera. A repeating wave (params.interval) rests between runs; a single
   * run ends the instance.
   */
  function updateWave(instance, data, dt) {
    const params = data.params;
    const wave = data.wave;
    if (!data.waveRunning) {
      data.timer -= dt;
      wave.weight = 0;
      if (data.waveSlot >= 0) water.setWave(data.waveSlot, wave);
      if (data.timer > 0) return;
      data.waveRunning = true;
      data.travelled = 0;
      data.runs++;
    }
    data.travelled += params.speed * dt;
    const total = data.waveTravel;
    if (data.travelled >= total) {
      data.waveRunning = false;
      wave.weight = 0;
      if (data.waveSlot >= 0) water.setWave(data.waveSlot, wave);
      const interval = nextWaveInterval(data);
      if (Number.isFinite(interval) && interval >= 0) data.timer = interval;
      else instance.ended = true;
      return;
    }
    const share = data.travelled / total;
    const rise = Math.min(data.travelled / WAVE_FADE_IN, 1);
    const fall = Math.min((total - data.travelled) / WAVE_FADE_OUT, 1);
    wave.weight = data.fade * rise * rise * (3 - 2 * rise) * fall * fall * (3 - 2 * fall);
    wave.front = data.travelled;
    let height = data.waveHeight * (1 + (params.growth - 1) * share);
    if (wave.ring) height /= Math.sqrt(1 + data.travelled / params.spreadLoss);
    wave.height = height;
    if (data.estuary !== null) {
      // The crest spans the channel where it is now (the estuary narrows from the mouth to its head).
      const halfWidth = data.estuary.mouthHalfWidth + (data.estuary.headHalfWidth - data.estuary.mouthHalfWidth) * share;
      wave.crestLength = halfWidth * 1.3 + 30;
      wave.taper = halfWidth * 0.45 + 20;
    }
    if (data.waveSlot >= 0) water.setWave(data.waveSlot, wave);
    // The crest's centre, and the crest point nearest the camera for the voice.
    const centreX = wave.x + wave.dirX * wave.front;
    const centreZ = wave.z + wave.dirZ * wave.front;
    const camera = ctx.camera.position;
    if (wave.ring) {
      const offsetX = camera.x - wave.x;
      const offsetZ = camera.z - wave.z;
      const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) || 1;
      data.voicePoint.x = Math.round(wave.x + (offsetX / distance) * wave.front);
      data.voicePoint.z = Math.round(wave.z + (offsetZ / distance) * wave.front);
    } else {
      let across = (camera.x - centreX) * -wave.dirZ + (camera.z - centreZ) * wave.dirX;
      if (across > wave.crestLength) across = wave.crestLength;
      else if (across < -wave.crestLength) across = -wave.crestLength;
      data.voicePoint.x = Math.round(centreX - wave.dirZ * across);
      data.voicePoint.z = Math.round(centreZ + wave.dirX * across);
      // An event's anchor rides the crest's centre (discovery, the despawn rule and the map follow it).
      if (data.duration !== null && data.estuary === null) {
        instance.anchor.x = Math.round(centreX);
        instance.anchor.z = Math.round(centreZ);
      }
    }
    data.voicePoint.y = Math.round(ctx.terrain.waterLevel + height * wave.weight * 0.6);
    if (dt <= 0) return;
    // Spray off the crest, from a few points along it each frame.
    data.emitCarry += params.spray * TIER_SPRAY_SCALE[instance.tier] * wave.weight * dt;
    const count = Math.floor(data.emitCarry);
    if (count <= 0) return;
    data.emitCarry -= count;
    const spray = data.spray;
    const points = count < WAVE_SPRAY_POINTS ? count : WAVE_SPRAY_POINTS;
    const reach = wave.ring ? 0 : Math.max(wave.crestLength - wave.taper, 1);
    for (let point = 0; point < points; point++) {
      drawNoise(data);
      let dirX = wave.dirX;
      let dirZ = wave.dirZ;
      if (wave.ring) {
        const angle = data.noiseValue * TWO_PI;
        dirX = Math.cos(angle);
        dirZ = Math.sin(angle);
        spray.x = wave.x + dirX * wave.front;
        spray.z = wave.z + dirZ * wave.front;
      } else {
        const across = (data.noiseValue * 2 - 1) * reach;
        spray.x = centreX - wave.dirZ * across;
        spray.z = centreZ + wave.dirX * across;
      }
      spray.y = ctx.terrain.waterLevel + height * wave.weight * 0.92;
      spray.inheritX = dirX * params.speed * 0.7;
      spray.inheritZ = dirZ * params.speed * 0.7;
      spray.count = Math.floor(count / points) + (point < count % points ? 1 : 0);
      water.emitSpray(spray);
    }
  }

  /** Clear shallows: the region fades with the instance; the voice sits on the surf ring nearest the camera. */
  function updateShallows(instance, data) {
    const region = data.shallows;
    region.weight = data.fade;
    if (data.shallowsSlot >= 0) water.setShallows(data.shallowsSlot, region);
    const ring = region.surfRadius > 0 ? region.surfRadius : 0;
    const camera = ctx.camera.position;
    const offsetX = camera.x - region.x;
    const offsetZ = camera.z - region.z;
    const distance = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) || 1;
    const reach = distance < ring ? distance : ring;
    data.voicePoint.x = Math.round(region.x + (offsetX / distance) * reach);
    data.voicePoint.y = Math.round(ctx.terrain.waterLevel + 1);
    data.voicePoint.z = Math.round(region.z + (offsetZ / distance) * reach);
  }

  const UPDATERS = Object.freeze({
    whirlpool: updateWhirlpool,
    splash: updateSplash,
    spray: updateSpray,
    bioluminescence: updateBioluminescence,
    plungePool: updatePlungePool,
    wave: updateWave,
    shallows: updateShallows,
  });

  /**
   * A travelling wave's descriptors. A straight front starts params.start metres behind the anchor
   * on its travel heading (params.travelHeading, relative to the activation's) and runs params.travel metres,
   * crossing the anchor on the way; a ring spreads from the anchor. With params.estuary on a site with
   * an estuary stamp, the crest starts at the mouth and surges up the channel to its head.
   */
  function prepareWave(instance, data, rng) {
    const params = data.params;
    const anchor = instance.anchor;
    if (params.mode !== 'front' && params.mode !== 'ring') throw new Error(`waterEffect: params.mode must be front or ring, got ${JSON.stringify(params.mode)}`);
    for (const field of ['height', 'width', 'crestLength', 'speed', 'travel', 'growth', 'spreadLoss']) {
      if (!(Number.isFinite(params[field]) && params[field] > 0)) throw new Error(`waterEffect: params.${field} must be a positive number, got ${JSON.stringify(params[field])}`);
    }
    const estuary = params.estuary ? siteStampOf(data.site, 'estuary') : null;
    const ring = params.mode === 'ring';
    let originX = anchor.x;
    let originZ = anchor.z;
    let dirX = 1;
    let dirZ = 0;
    let crestLength = params.crestLength * data.scale;
    let taper = params.taper * data.scale;
    data.waveTravel = params.travel;
    if (estuary) {
      originX = estuary.mouthX;
      originZ = estuary.mouthZ;
      dirX = estuary.inlandX;
      dirZ = estuary.inlandZ;
      data.waveTravel = estuary.channelLength;
      crestLength = estuary.mouthHalfWidth * 1.3 + 30;
      taper = estuary.mouthHalfWidth * 0.45 + 20;
    } else if (!ring) {
      const heading = (data.activationHeading + params.travelHeading) * (Math.PI / 180);
      dirX = Math.sin(heading);
      dirZ = -Math.cos(heading);
      originX = anchor.x - dirX * params.start;
      originZ = anchor.z - dirZ * params.start;
    }
    data.estuary = estuary;
    data.waveHeight = params.height * data.scale;
    data.wave = water.createWave({
      x: originX, z: originZ, dirX, dirZ, front: 0, height: data.waveHeight, width: params.width * data.scale, lean: params.lean,
      crestLength, taper: Math.min(taper, crestLength), ring, foam: params.foam, weight: 0,
    });
    data.spray = water.createSpray({
      x: originX, y: anchor.y, z: originZ, speed: params.sprayHeight, up: 1, spread: 0.7, size: 2.4, sizeGrowth: 1.6, life: 2.2,
      drag: 0.9, gravity: 0.7, alpha: 0.6, glow: params.glow,
    });
    data.voicePoint = new ctx.THREE.Vector3(Math.round(originX), Math.round(anchor.y), Math.round(originZ));
    // A repeating wave (a bore on its site) starts its first run a little after the site appears.
    data.timer = Array.isArray(params.interval) ? rng() * params.interval[0] * 0.25 : 0;
    instance.radius = Math.max(crestLength, params.width * 4);
    data.particlesAtFull = Math.round(params.spray * 2.2);
  }

  /**
   * A shallows region: at the anchor with params.radius, or fitted to a site stamp that publishes its
   * clear water (`shallows`: x, z, radius, fade, surfRadius, surfWidth; the atoll and reef stamps):
   * params.stamp names its index, else the site's first such stamp is used.
   */
  function prepareShallows(instance, data) {
    const params = data.params;
    const anchor = instance.anchor;
    const stamps = data.site && Array.isArray(data.site.stamps) ? data.site.stamps : [];
    let fitted = null;
    if (Number.isInteger(params.stamp)) {
      fitted = stamps[params.stamp] && stamps[params.stamp].shallows ? stamps[params.stamp].shallows : null;
      if (!fitted && stamps.length > 0) throw new Error(`waterEffect: params.stamp ${params.stamp} names no stamp with clear water on the site`);
    } else {
      for (const stamp of stamps) {
        if (stamp && stamp.shallows) {
          fitted = stamp.shallows;
          break;
        }
      }
    }
    const radius = fitted ? fitted.radius : params.radius * data.scale;
    const surfRadius = fitted && params.surf > 0 ? fitted.surfRadius : Number.isFinite(params.surfRadius) ? params.surfRadius * data.scale : radius;
    data.shallows = water.createShallows({
      x: fitted ? fitted.x : anchor.x,
      z: fitted ? fitted.z : anchor.z,
      radius,
      fade: fitted ? fitted.fade : params.fade * data.scale,
      color: params.color,
      clarity: params.clarity,
      surfRadius: params.surf > 0 ? surfRadius : 0,
      surfWidth: fitted && params.surf > 0 ? fitted.surfWidth : params.surfWidth,
      surf: params.surf,
      weight: 0,
    });
    data.voicePoint = new ctx.THREE.Vector3(Math.round(data.shallows.x), Math.round(anchor.y), Math.round(data.shallows.z));
    instance.radius = Math.max(radius, surfRadius);
    data.particlesAtFull = 0;
  }

  /** Builds the effect's descriptors (once, in create). */
  function prepare(instance, data, rng) {
    const params = data.params;
    const anchor = instance.anchor;
    if (data.kind === 'whirlpool') {
      const radius = Math.max(20, params.radius * data.scale);
      data.vortex = water.createVortex({
        x: anchor.x, z: anchor.z, radius, eyeRadius: Math.max(4, radius * clamp(params.eyeShare, 0.03, 0.5)),
        depth: params.depth * data.scale, spin: params.spin, arms: params.arms, twist: params.twist,
        ridge: params.ridge * data.scale, foam: params.foam, direction: params.direction, weight: 0,
      });
      data.spray = water.createSpray({
        x: anchor.x, y: anchor.y, z: anchor.z, speed: 3, up: 1, spread: 1.1, ringRadius: radius * params.eyeShare * 0.8,
        size: params.mistSize, sizeGrowth: 1.1, life: 5, drag: 1.4, gravity: 0.04, alpha: 0.28, glow: params.glow,
      });
      instance.radius = radius;
      data.particlesAtFull = Math.round(params.mistRate * 5);
    } else if (data.kind === 'splash') {
      data.timer = Array.isArray(params.interval) ? rng() * params.interval[0] : 0;
      instance.radius = Math.max(15, params.scatter + 12 * params.strength);
      data.particlesAtFull = Math.round(40 + 260 * params.strength);
    } else if (data.kind === 'spray') {
      const ring = params.ringRadius * data.scale;
      data.spray = water.createSpray({
        x: anchor.x, y: anchor.y, z: anchor.z, speed: params.height, up: 1, spread: params.spread, ringRadius: ring,
        swirl: params.swirl, size: params.size, sizeGrowth: 1.4, life: params.life, drag: 0.9, gravity: 0.55, alpha: 0.55, glow: params.glow,
      });
      data.ringTimer = 0;
      instance.radius = Math.max(ring * 2, 30);
      data.particlesAtFull = Math.round(params.rate * params.life);
    } else if (data.kind === 'bioluminescence') {
      instance.radius = params.radius * data.scale;
      params.radius = instance.radius;
      data.region = water.createGlowRegion({ x: anchor.x, z: anchor.z, radius: params.radius, strength: 0, surf: 0, color: params.color });
      data.particlesAtFull = 0;
    } else if (data.kind === 'wave') {
      prepareWave(instance, data, rng);
    } else if (data.kind === 'shallows') {
      prepareShallows(instance, data);
    } else {
      const stamp = cliffStepOf(data.site);
      let radius = Number.isFinite(params.radius) ? params.radius : 50;
      let x = anchor.x;
      let z = anchor.z;
      let surfaceY = Number.isFinite(params.surfaceY) ? params.surfaceY : anchor.y;
      if (stamp) {
        x = stamp.poolX;
        z = stamp.poolZ;
        // The water stands 0.6 m below the pool's rim; the disc reaches where the bowl is that deep.
        const depth = Math.max(stamp.poolDepth, 1);
        const bowl = Math.sqrt(Math.min(0.95, 0.6 / depth));
        if (!Number.isFinite(params.radius)) radius = stamp.pool * Math.sqrt(1 - bowl);
        if (!Number.isFinite(params.surfaceY)) surfaceY = stamp.bottomY - 0.6;
      }
      const waterLevel = ctx.terrain.waterLevel;
      data.poolOnDisc = surfaceY > waterLevel + 0.5;
      if (!data.poolOnDisc) surfaceY = waterLevel;
      data.pool = water.createPool({ x, y: surfaceY + 0.02, z, radius: radius * data.scale, churn: 0, glow: 0 });
      data.spray = water.createSpray({
        x, y: surfaceY, z, speed: 4, up: 1, spread: 0.9, ringRadius: radius * 0.25,
        size: params.mistSize, sizeGrowth: 1.3, life: 4.5, drag: 1.3, gravity: 0.03, alpha: 0.35, glow: params.glow,
      });
      data.timer = 0;
      anchor.set(x, surfaceY, z);
      instance.radius = Math.max(radius * data.scale, 20);
      data.particlesAtFull = Math.round(params.mistRate * 4.5);
    }
  }

  return {
    name: 'waterEffect',
    init(engineCtx) {
      ctx = engineCtx;
      water = engineCtx.water;
      if (!water) throw new Error('waterEffect: the engine ctx has no water effects layer (ctx.water)');
    },
    create(preset, params, rng) {
      const resolved = resolveParams(params);
      const instance = {
        anchor: params.position,
        radius: 20,
        windSourceIds: [],
        lights: 0,
        particles: 0,
        tier: 'near',
        data: {
          kind: resolved.effect,
          params: resolved,
          scale: finiteOr(params.scale, 1),
          site: params.site ?? null,
          rng,
          age: 0,
          duration: Number.isFinite(params.duration) ? params.duration : null,
          vortexSlot: -1,
          regionSlot: -1,
          poolSlot: -1,
          poolOnDisc: false,
          vortex: null,
          spray: null,
          pool: null,
          emitCarry: 0,
          timer: 0,
          ringTimer: 0,
          spinAge: 0,
          splashes: 0,
          landTries: 0,
          flashes: 0,
          lastSplash: 0,
          particlesAtFull: 0,
          retry: 0,
          followIndex: Number.isInteger(resolved.follow) ? resolved.follow : null,
          followAnchor: null,
          voice: null,
          fade: 0,
          rate: 0,
          surfaceTimer: 0,
          region: null,
          /** The activation's compass heading (deg): a wave's travel heading is relative to it. */
          activationHeading: finiteOr(params.heading, 0),
          waveSlot: -1,
          shallowsSlot: -1,
          wave: null,
          waveRunning: false,
          waveTravel: 0,
          waveHeight: 0,
          travelled: 0,
          runs: 0,
          estuary: null,
          shallows: null,
          /** Where the voice sits (a wave's crest or a reef's surf near the camera), or null: the anchor. */
          voicePoint: null,
          mark: water.createMark(),
          noise: new Float32Array(NOISE_SIZE),
          noiseCursor: 0,
          noiseValue: 0,
        },
      };
      for (let index = 0; index < NOISE_SIZE; index++) instance.data.noise[index] = rng();
      prepare(instance, instance.data, rng);
      if (ownsPresetAudio(preset, 'waterEffect', resolved.voice) && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
        instance.data.voice = ctx.audio.spawnVoice(preset.audio.recipe, { ...(preset.audio.params ?? {}), intensity: 0 });
      }
      acquireSlots(instance.data);
      instance.particles = instance.data.particlesAtFull;
      live++;
      liveInstances.add(instance);
      return instance;
    },
    update(instance, dt) {
      const data = instance.data;
      const params = data.params;
      data.age += dt;
      followPart(instance, data);
      // Fade in from creation; events fade out over their last fadeOut seconds.
      let fade = params.fadeIn > 0 ? Math.min(Math.max(data.age / params.fadeIn, 0), 1) : 1;
      if (data.duration !== null && params.fadeOut > 0) fade = Math.min(fade, Math.min(Math.max((data.duration - data.age) / params.fadeOut, 0), 1));
      data.fade = fade;
      if (instance.tier !== 'far' && wantsSlot(data)) {
        data.retry -= dt;
        if (data.retry <= 0) {
          data.retry = SLOT_RETRY_SECONDS;
          acquireSlots(data);
        }
      }
      if (instance.tier !== 'far') UPDATERS[data.kind](instance, data, dt);
      if (data.voice) {
        data.voice.setPosition(data.voicePoint !== null ? data.voicePoint : instance.anchor);
        data.voice.setIntensity(params.voiceIntensity * fade);
      }
      if (data.duration !== null && data.age >= data.duration) instance.ended = true;
    },
    setLOD(instance, tier) {
      instance.tier = tier;
      const data = instance.data;
      if (tier === 'far') {
        releaseSlots(data);
        instance.particles = 0;
      } else {
        acquireSlots(data);
        instance.particles = Math.round(data.particlesAtFull * TIER_SPRAY_SCALE[tier]);
      }
    },
    dispose(instance) {
      const data = instance.data;
      releaseSlots(data);
      if (data.voice) {
        data.voice.dispose();
        data.voice = null;
      }
      data.followAnchor = null;
      liveInstances.delete(instance);
      live--;
    },
    /**
     * What one instance is doing, for dev tools and tests: the effect, its tier and fade, the slots it
     * holds, and a wave's run (front, height, weight, runs) or a shallows region's disc.
     */
    describe(instance) {
      const data = instance.data;
      const wave = data.wave;
      const region = data.shallows;
      return {
        effect: data.kind,
        tier: instance.tier,
        fade: data.fade,
        slots: { vortex: data.vortexSlot, glowRegion: data.regionSlot, pool: data.poolSlot, wave: data.waveSlot, shallows: data.shallowsSlot },
        wave: wave ? {
          running: data.waveRunning, runs: data.runs, front: wave.front, travel: data.waveTravel, height: wave.height, weight: wave.weight,
          originX: wave.x, originZ: wave.z, dirX: wave.dirX, dirZ: wave.dirZ, crestLength: wave.crestLength, ring: wave.ring, estuary: data.estuary !== null,
        } : null,
        shallows: region ? { x: region.x, z: region.z, radius: region.radius, surfRadius: region.surfRadius, clarity: region.clarity, weight: region.weight } : null,
      };
    },
    stats() {
      let particles = 0;
      for (const instance of liveInstances) particles += instance.particles;
      const layer = water ? water.stats() : null;
      return {
        instances: live,
        particles,
        lights: 0,
        // The layer's shared buffers: the trail texture, the droplet batch and the pool discs.
        buffers: layer ? 3 : 0,
        drawCalls: layer ? (layer.droplets > 0 ? 1 : 0) + (layer.pools > 0 ? 1 : 0) : 0,
        layer,
      };
    },
  };
}
