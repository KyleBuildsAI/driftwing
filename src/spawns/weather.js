// Regional weather: clear -> building -> storm -> clearing, deterministic per region cell and time
// bucket, with smooth transitions. Storm presets filter on it (filters.weather) and the sky follows
// it through a sky modifier (darker, bluer-grey sky and denser fog in a storm, a golden light as it
// clears).
//
// The model is pure (createWeatherModel: no scene, no clock of its own), so the director, the labs and
// the determinism test ask it about any place and time. The game system (createWeatherSystem) samples
// it at the player every frame, eases the sky toward it and emits the typed weatherChanged event.
//
// How the cycle is laid out. The world is cut into square regions of WEATHER_REGION_SIZE metres and
// flight time (state.time.elapsed) into buckets of WEATHER_BUCKET_SECONDS. Each region runs cycles of
// WEATHER_CYCLE_BUCKETS buckets, shifted by a seeded per-region offset so neighbouring regions do not
// storm in step. A cycle is stormy with WEATHER_STORM_CYCLE_CHANCE; a stormy cycle ends with one
// building bucket, one or two storm buckets and one clearing bucket, and is clear before that. The
// state of any (region, bucket) is therefore a pure function of the seed, the region and the bucket,
// and every cycle starts and ends clear, so the order clear -> building -> storm -> clearing -> clear
// always holds. The offset never puts the first bucket of flight inside a storm sequence: every
// flight opens in clear weather (the golden-hour opening is exactly the Phase 1 picture).
//
// Chosen values, so a player meets varied weather in a normal session (tools/lab/director.mjs
// measures it):
//   region 12 km   a glider (30-40 m/s) crosses one in 5-7 min, a bush plane in 3-4 min, a jet in
//                  under a minute, so a 20-minute flight passes through several regions
//   bucket 150 s   a cycle is 8 buckets = 20 min; a storm sequence lasts 7.5-10 min (building 2.5,
//                  storm 2.5-5, clearing 2.5)
//   chance 0.7     about 1 bucket in 8 is storm, 1 in 11 building and 1 in 11 clearing somewhere;
//                  most 20-minute flights (at any speed) meet a storm, and all four states are
//                  common in a 30-minute one
//
// Transitions are smooth in time (storminess ramps through building, peaks in the storm and eases out
// through clearing, with a golden bump in the middle of clearing) and in space (sampleAt blends the
// four nearest region centres), and the game system eases the sky on top of that.
import { rehash, unitFromHash, mix32 } from './candidates.js';
import { WEATHER_STATES } from '../core/events.js';

export { WEATHER_STATES };
export const WEATHER_REGION_SIZE = 12000;
export const WEATHER_BUCKET_SECONDS = 150;
export const WEATHER_CYCLE_BUCKETS = 8;
export const WEATHER_STORM_CYCLE_CHANCE = 0.7;
/** Longest storm sequence: building 1 + storm 2 + clearing 1 buckets. */
const MAX_SEQUENCE_BUCKETS = 4;
const MAX_STORM_BUCKETS = 2;
const WEATHER_SALT = 0x3c6ef372;
/** Storminess reached at the end of the building bucket; the storm then ramps to 1 over its first quarter. */
const BUILDING_PEAK = 0.7;
const STORM_RAMP = 0.25;

const STATE_INDEX = Object.freeze({ clear: 0, building: 1, storm: 2, clearing: 3 });

function smoothUnit(value) {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

/** Storminess (0..1) in a state at progress (0..1 through the whole state). */
export function stormLevel(state, progress) {
  if (state === 'building') return BUILDING_PEAK * smoothUnit(progress);
  if (state === 'storm') return BUILDING_PEAK + (1 - BUILDING_PEAK) * smoothUnit(progress / STORM_RAMP);
  if (state === 'clearing') return 1 - smoothUnit(progress);
  return 0;
}

/** The golden light of a clearing storm (0..1): nothing at its start and end, full halfway through. */
export function goldenLevel(state, progress) {
  if (state !== 'clearing') return 0;
  const bump = Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));
  return bump * bump;
}

/** Writes a state, its progress and the derived levels into a sample record. */
function writeSample(out, state, progress) {
  out.state = state;
  out.stateIndex = STATE_INDEX[state];
  out.progress = progress;
  out.storminess = stormLevel(state, progress);
  out.golden = goldenLevel(state, progress);
  return out;
}

/** A weather sample record (reuse one per caller: sampling never allocates). */
export function createWeatherSample() {
  return { state: 'clear', stateIndex: 0, progress: 0, storminess: 0, golden: 0, bucket: 0, regionX: 0, regionZ: 0 };
}

/**
 * The pure regional weather model for one world. options override the chosen constants (the lab
 * explores alternatives with them). Returns sampleRegion, sampleAt, stateAt and regionOf.
 */
export function createWeatherModel(seedHash, {
  regionSize = WEATHER_REGION_SIZE,
  bucketSeconds = WEATHER_BUCKET_SECONDS,
  cycleBuckets = WEATHER_CYCLE_BUCKETS,
  stormChance = WEATHER_STORM_CYCLE_CHANCE,
} = {}) {
  if (!(cycleBuckets > MAX_SEQUENCE_BUCKETS)) throw new RangeError(`weather cycles need more than ${MAX_SEQUENCE_BUCKETS} buckets`);
  const baseHash = mix32((seedHash ^ WEATHER_SALT) >>> 0);
  const blendScratch = createWeatherSample();

  function regionHash(regionX, regionZ) {
    let hash = mix32((baseHash ^ (regionX | 0)) >>> 0);
    hash = mix32((hash + Math.imul(regionZ | 0, 0x27d4eb2d)) >>> 0);
    return hash;
  }

  /** The weather of one region at flight time `time` (s) into out. */
  function sampleRegion(regionX, regionZ, time, out) {
    const clock = Math.max(0, time) / bucketSeconds;
    const bucket = Math.floor(clock);
    const within = clock - bucket;
    const hash = regionHash(regionX, regionZ);
    // The offset keeps bucket 0 ahead of the storm sequence of cycle 0: every flight opens clear.
    const offset = Math.floor(unitFromHash(hash) * (cycleBuckets - MAX_SEQUENCE_BUCKETS));
    const shifted = bucket + offset;
    const cycle = Math.floor(shifted / cycleBuckets);
    const position = shifted - cycle * cycleBuckets;
    out.bucket = bucket;
    out.regionX = regionX;
    out.regionZ = regionZ;
    const cycleHash = rehash(hash, cycle + 1);
    if (unitFromHash(cycleHash) >= stormChance) return writeSample(out, 'clear', 0);
    const stormBuckets = 1 + Math.floor(unitFromHash(rehash(cycleHash, 7)) * MAX_STORM_BUCKETS);
    const sequenceStart = cycleBuckets - (stormBuckets + 2);
    const step = position - sequenceStart;
    if (step < 0) return writeSample(out, 'clear', 0);
    if (step === 0) return writeSample(out, 'building', within);
    if (step <= stormBuckets) return writeSample(out, 'storm', (step - 1 + within) / stormBuckets);
    return writeSample(out, 'clearing', within);
  }

  function regionOf(coordinate) {
    return Math.floor(coordinate / regionSize);
  }

  /**
   * The weather at a world point into out: the state of the region containing it, with storminess
   * and golden blended smoothly between the four nearest region centres.
   */
  function sampleAt(x, z, time, out) {
    const gridX = x / regionSize - 0.5;
    const gridZ = z / regionSize - 0.5;
    const cornerX = Math.floor(gridX);
    const cornerZ = Math.floor(gridZ);
    const blendX = smoothUnit(gridX - cornerX);
    const blendZ = smoothUnit(gridZ - cornerZ);
    let storminess = 0;
    let golden = 0;
    for (let corner = 0; corner < 4; corner++) {
      const offsetX = corner & 1;
      const offsetZ = corner >> 1;
      const weight = (offsetX ? blendX : 1 - blendX) * (offsetZ ? blendZ : 1 - blendZ);
      if (weight === 0) continue;
      sampleRegion(cornerX + offsetX, cornerZ + offsetZ, time, blendScratch);
      storminess += weight * blendScratch.storminess;
      golden += weight * blendScratch.golden;
    }
    sampleRegion(regionOf(x), regionOf(z), time, out);
    out.storminess = storminess;
    out.golden = golden;
    return out;
  }

  /** The state name of the region containing (x, z) at time. */
  function stateAt(x, z, time) {
    return sampleRegion(regionOf(x), regionOf(z), time, blendScratch).state;
  }

  return { regionSize, bucketSeconds, cycleBuckets, stormChance, sampleRegion, sampleAt, stateAt, regionOf };
}

// ============================================================================================
// GAME SYSTEM
// ============================================================================================
/** Seconds for the sky to cover about two thirds of the way to a new weather level. */
const SKY_EASE_SECONDS = 8;
/** A jump this far (m) in one frame (a teleport, a relaunch) snaps the sky to the new weather. */
const SNAP_DISTANCE = 1500;
const SKY_PRIORITY = 10;
const STORM_SKY = 0x566170;
const STORM_FOG = 0x6c7886;
const GOLDEN_SKY = 0xffb56b;
const GOLDEN_FOG = 0xf2b477;

/**
 * The weather system ('weather', created after 'sky' and updated just before it). It samples the
 * model at the player, eases toward it, drives the 'weather' sky modifier and emits weatherChanged
 * { state, previous, region } when the player's regional state changes. API: model, update,
 * getState(), forceState(state | null, progress) (dev builds and ?debug=1 only) and dispose().
 */
export function createWeatherSystem(ctx) {
  const { THREE, state, bus, world } = ctx;
  const sky = ctx.systems.sky;
  if (!sky || typeof sky.addModifier !== 'function') throw new Error('the weather system needs the sky system (sky.addModifier)');
  const devHooks = Boolean(import.meta.env?.DEV) || new URLSearchParams(window.location.search).get('debug') === '1';
  const model = createWeatherModel(world.seedHash >>> 0);
  const sample = createWeatherSample();
  const modifier = sky.addModifier('weather', { priority: SKY_PRIORITY });
  const colors = {
    stormSky: new THREE.Color(STORM_SKY),
    stormFog: new THREE.Color(STORM_FOG),
    goldenSky: new THREE.Color(GOLDEN_SKY),
    goldenFog: new THREE.Color(GOLDEN_FOG),
    sky: new THREE.Color(),
    fog: new THREE.Color(),
  };
  const lastPosition = state.player.position.clone();
  const forced = { state: null, progress: 0.5 };
  const values = {
    weight: 0, sunIntensity: 1, ambient: 1, fogDensity: 1, darkness: 0, overcast: 0, stars: 0,
    fogColor: colors.fog, fogColorAmount: 0, skyTint: colors.sky, skyTintAmount: 0,
  };
  let storminess = -1;
  let golden = -1;
  let currentState = null;
  let currentRegionX = 0;
  let currentRegionZ = 0;
  let regionId = '';
  let disposed = false;

  function sampleWeather() {
    const position = state.player.position;
    model.sampleAt(position.x, position.z, state.time.elapsed, sample);
    if (forced.state) writeSample(sample, forced.state, forced.progress);
    return sample;
  }

  function announce() {
    const previous = currentState;
    if (sample.state === previous && sample.regionX === currentRegionX && sample.regionZ === currentRegionZ) return;
    const regionChanged = sample.regionX !== currentRegionX || sample.regionZ !== currentRegionZ || regionId === '';
    currentRegionX = sample.regionX;
    currentRegionZ = sample.regionZ;
    if (regionChanged) regionId = `${currentRegionX}:${currentRegionZ}`;
    currentState = sample.state;
    if (previous !== null && previous !== sample.state) bus.emitTyped('weatherChanged', { state: sample.state, previous, region: regionId });
  }

  /** Sets the modifier from the eased levels. Clear weather sets weight 0: the sky is untouched. */
  function applySky() {
    // The golden light belongs to daylight; a storm clearing at night just clears.
    const glow = golden * (1 - state.time.nightFactor);
    const stormy = storminess;
    values.weight = stormy > 0 || glow > 0 ? 1 : 0;
    values.sunIntensity = (1 - 0.7 * stormy) * (1 + 0.3 * glow);
    values.ambient = 1 - 0.35 * stormy;
    values.fogDensity = 1 + 1.8 * stormy;
    values.darkness = 0.3 * stormy;
    values.overcast = 0.9 * stormy;
    const stormSky = 0.8 * stormy;
    const goldenSky = 0.45 * glow;
    const mixToGolden = stormSky + goldenSky > 0 ? goldenSky / (stormSky + goldenSky) : 0;
    colors.sky.copy(colors.stormSky).lerp(colors.goldenSky, mixToGolden);
    values.skyTintAmount = Math.max(stormSky, goldenSky);
    const stormFog = 0.7 * stormy;
    const goldenFog = 0.3 * glow;
    const fogToGolden = stormFog + goldenFog > 0 ? goldenFog / (stormFog + goldenFog) : 0;
    colors.fog.copy(colors.stormFog).lerp(colors.goldenFog, fogToGolden);
    values.fogColorAmount = Math.max(stormFog, goldenFog);
    modifier.set(values);
  }

  function update(simDt, realDt) {
    if (disposed) return;
    sampleWeather();
    const jumped = lastPosition.distanceToSquared(state.player.position) > SNAP_DISTANCE * SNAP_DISTANCE;
    lastPosition.copy(state.player.position);
    if (storminess < 0 || jumped) {
      storminess = sample.storminess;
      golden = sample.golden;
    } else {
      const ease = 1 - Math.exp(-realDt / SKY_EASE_SECONDS);
      storminess += (sample.storminess - storminess) * ease;
      golden += (sample.golden - golden) * ease;
      // Settle exactly on clear weather, so the sky returns to its untouched path.
      if (sample.storminess === 0 && storminess < 1e-4) storminess = 0;
      if (sample.golden === 0 && golden < 1e-4) golden = 0;
    }
    announce();
    applySky();
  }

  update(0, 0);

  return {
    model,
    update,
    /** The player's weather: state, region, the model's levels and the eased levels the sky shows. */
    getState() {
      return {
        state: sample.state,
        region: regionId,
        progress: Math.round(sample.progress * 1000) / 1000,
        storminess: Math.round(sample.storminess * 1000) / 1000,
        golden: Math.round(sample.golden * 1000) / 1000,
        skyStorminess: Math.round(storminess * 1000) / 1000,
        skyGolden: Math.round(golden * 1000) / 1000,
        bucket: sample.bucket,
        forced: forced.state,
        regionSize: model.regionSize,
        bucketSeconds: model.bucketSeconds,
        cycleBuckets: model.cycleBuckets,
      };
    },
    /**
     * Dev only: holds the player's weather in a state at a progress (0..1), or hands it back to the
     * model with null. With snap (the default) the sky jumps there on the next frame; without it the
     * sky eases there as it would in flight.
     */
    forceState(name, progress = 0.5, { snap = true } = {}) {
      if (!devHooks) throw new Error('weather.forceState is only available in development builds or with ?debug=1');
      if (name !== null && !WEATHER_STATES.includes(name)) throw new RangeError(`unknown weather state "${name}"`);
      if (!Number.isFinite(progress)) throw new TypeError('weather.forceState progress must be a finite number');
      forced.state = name;
      forced.progress = Math.min(1, Math.max(0, progress));
      if (snap) storminess = -1;
      return forced.state;
    },
    /** Removes the sky modifier; the sky returns to its unmodified path and updates stop. */
    dispose() {
      if (disposed) return;
      disposed = true;
      modifier.remove();
    },
  };
}
