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

const EFFECTS = Object.freeze(['whirlpool', 'splash', 'spray', 'bioluminescence', 'plungePool']);
const TIER_SPRAY_SCALE = Object.freeze({ near: 1, mid: 0.35, far: 0 });
/** Seconds between attempts to take a layer slot that was full. */
const SLOT_RETRY_SECONDS = 1;
const TWO_PI = Math.PI * 2;
/** Entries in an instance's random table (a power of two), drawn from its seeded generator. */
const NOISE_SIZE = 64;
const NOISE_MASK = NOISE_SIZE - 1;

/** Engine defaults per effect (docs/engines/waterEffect.md). A preset overrides any of them. */
export const WATER_EFFECT_DEFAULTS = Object.freeze({
  common: Object.freeze({ effect: 'splash', fadeIn: 2, fadeOut: 3, follow: null, voice: false, voiceIntensity: 1, glow: 0 }),
  whirlpool: Object.freeze({
    radius: 320, eyeShare: 0.11, depth: 18, spin: 0.8, arms: 4, twist: 8, ridge: 0.7, foam: 0.9, direction: 1,
    spinUp: 12, mistRate: 45, mistSize: 7, glow: 0,
  }),
  splash: Object.freeze({ interval: null, strength: 0.6, scatter: 0, glow: 0.6 }),
  spray: Object.freeze({
    ringRadius: 22, rate: 260, height: 11, spread: 0.45, swirl: 9, size: 1.3, life: 2.4, foam: 0.6, glow: 0.4,
  }),
  bioluminescence: Object.freeze({ radius: 900, strength: 1, surf: 0.6, color: 0x1f9dff, flashRate: 12, flashRadius: 4.5 }),
  plungePool: Object.freeze({ radius: null, surfaceY: null, churn: 0.85, mistRate: 120, mistSize: 5.5, rippleInterval: 1.4, glow: 0 }),
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
  }

  function releaseSlots(data) {
    if (data.vortexSlot >= 0) water.releaseVortex(data.vortexSlot);
    if (data.regionSlot >= 0) water.releaseGlowRegion(data.regionSlot);
    if (data.poolSlot >= 0) water.releasePool(data.poolSlot);
    data.vortexSlot = -1;
    data.regionSlot = -1;
    data.poolSlot = -1;
  }

  function wantsSlot(data) {
    return (data.kind === 'whirlpool' && data.vortexSlot < 0)
      || (data.kind === 'bioluminescence' && data.regionSlot < 0)
      || (data.kind === 'plungePool' && data.poolOnDisc && data.poolSlot < 0);
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
    instance.anchor.x = data.followAnchor.x;
    instance.anchor.z = data.followAnchor.z;
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
    data.lastSplash = water.splashMark(mark);
    data.splashes++;
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

  const UPDATERS = Object.freeze({
    whirlpool: updateWhirlpool,
    splash: updateSplash,
    spray: updateSpray,
    bioluminescence: updateBioluminescence,
    plungePool: updatePlungePool,
  });

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
          mark: water.createMark(),
          noise: new Float32Array(NOISE_SIZE),
          noiseCursor: 0,
          noiseValue: 0,
        },
      };
      for (let index = 0; index < NOISE_SIZE; index++) instance.data.noise[index] = rng();
      prepare(instance, instance.data, rng);
      if (resolved.voice === true && preset.audio && ctx.audio && typeof ctx.audio.spawnVoice === 'function') {
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
        data.voice.setPosition(instance.anchor);
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
