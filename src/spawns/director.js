// The event director: decides, twice a second, which dormant deterministic candidate (an event, or
// the active state of a site such as an erupting volcano) becomes a live spawn, and when a live one
// it started should go.
//
// Inputs, read every tick: the player's position, heading and speed, the biome and surface under each
// candidate, the time of day, the regional weather (src/spawns/weather.js), the spawns already
// active (the SpawnManager, section 4 of the Phase 2 contracts) and the perf headroom.
//
// Rules, in the order they are applied:
//   pacing     something notable within 60-90 s of flight. The drought clock counts the time with
//              nothing notable going on: it restarts when a site comes into view, on a discovery,
//              on an activation, and on every tick while a spawn the director started is in view
//              (the player is watching it or flying toward it). When it reaches the drought
//              threshold (a seeded 60-70 s per drought, leaving time to find one), the best eligible candidate AHEAD of the
//              heading, 3-8 km out, is activated: a common one or one of a due tier, from 75 s an
//              uncommon one too, and from 80 s a rare one or one up to 60 degrees off the heading
//   rarity     each tier has a due time drawn from its period (common 2.5-5 min, uncommon 10-15 min,
//              rare 30-60 min, legendary 1-2 h of flight); a due tier activates its best eligible
//              candidate ahead, and any activation of a tier draws its next due time
//   cooldowns  per preset (by rarity, or the preset's own cooldown), and the same preset never runs
//              twice in a row
//   budgets    at most 2 heavy spawns, per-engine instance and particle caps and a real-light cap,
//              checked against the SpawnManager's stats with headroom for the new spawn's share
//              (the director does not know a preset's exact cost; the manager, which does, refuses
//              an activation that would still break a budget, and that candidate then waits for
//              its next bucket)
//   filters    per preset: biome, time of day, altitude band (player MSL), weather state at the
//              candidate, surface (land, water, coast), distance band
//   ahead      every director activation lies within 45 degrees of the heading (60 for a drought
//              past 80 s) and inside the
//              preset's distance band; nothing is ever started behind the player
//   lifetimes  events end naturally (the engine sets instance.ended) or after their seeded duration
//              plus a grace period; beyond despawn.distance + hysteresis and out of view for
//              outOfViewSeconds they are despawned, and back inside despawn.distance the out-of-view
//              timer resets
//   perf       a load shedder: level 1 defers heavy activations, levels 2 and 3 demote far LODs
//              through the SpawnManager's LOD bias. The perf governor consults it before it lowers
//              the render scale. A frame-time miss reported by perf.getHeadroom() also defers heavy
//              activations on its own
//
// Every activation is logged as { time, presetId, candidateId, reason }; the log (and its running
// hash) is identical for the same seed and the same scripted path, which the determinism test and
// tools/lab/director.mjs check. The director allocates only when something happens (an activation,
// a new candidate position, an API call); a quiet tick reuses pooled records.
//
// Distances are metres, headings and bearings compass degrees (0 north, 90 east), times seconds of
// flight (state.time.elapsed in the game).
import {
  angleBetween,
  aheadScore,
  bearingDegrees,
  candidateHash,
  candidateId,
  candidateSettings,
  collectPresetCandidates,
  compareCandidates,
  createCandidatePool,
  hashString,
  mix32,
  rehash,
  unitFromHash,
} from './candidates.js';

export const DIRECTOR_TICK_SECONDS = 0.5;
export const RARITY_TIERS = Object.freeze(['common', 'uncommon', 'rare', 'legendary']);
/** Seconds between two activations of a tier: [min, max], drawn per activation. */
export const RARITY_PERIODS = Object.freeze({
  common: Object.freeze([150, 300]),
  uncommon: Object.freeze([600, 900]),
  rare: Object.freeze([1800, 3600]),
  legendary: Object.freeze([3600, 7200]),
});
/** Default per-preset cooldown (s) by rarity; a preset may set its own `cooldown`. */
export const RARITY_COOLDOWNS = Object.freeze({ common: 150, uncommon: 1200, rare: 2700, legendary: 5400 });
/** The pacing window: a drought ends at a seeded threshold in [DROUGHT_MIN, DROUGHT_MIN + DROUGHT_SPREAD). */
export const DROUGHT_MIN = 60;
/** The end of the pacing window (s): something notable should come by then. */
export const PACING_WINDOW_MAX = 90;
const DROUGHT_SPREAD = 10;
/** From this drought length an uncommon candidate may fill it too. */
const DROUGHT_RELAX = 75;
/** Drought fills sit in this band ahead (m), intersected with the preset's own band. */
export const DROUGHT_BAND = Object.freeze({ min: 3000, max: 8000 });
/** Largest angle (degrees) off the heading for a director activation: inside the view ahead. */
export const MAX_OFF_AXIS = 45;
/**
 * A drought this long (s) widens the search: up to MAX_OFF_AXIS_WIDE off the heading (still well
 * ahead, never behind) and rare candidates too, so the 90 s window holds where content is thin.
 */
const DROUGHT_WIDEN = 80;
export const MAX_OFF_AXIS_WIDE = 60;
/**
 * Budget headroom: an engine counts as full once its particles reach this share of the cap, and a
 * preset with lights needs this many real lights free (the director does not know exact costs).
 */
const PARTICLE_HEADROOM = 0.85;
const LIGHTS_PER_SPAWN = 2;
const COMMON_BIT = 1 << RARITY_TIERS.indexOf('common');
const UNCOMMON_BIT = 1 << RARITY_TIERS.indexOf('uncommon');
const RARE_BIT = 1 << RARITY_TIERS.indexOf('rare');
/** Default distance band (m) for a preset whose filters leave it out. */
const DEFAULT_BAND = Object.freeze({ min: 3000, max: 8000 });
/** Candidates are gathered out to the largest preset band, capped here (m). */
const MAX_SEARCH_RADIUS = 30000;
/** A lifetime backstop: an event still running this long after its duration is ended by the director. */
const LIFETIME_GRACE = 60;
/** Site active states: candidate buckets and chance when the preset has no candidates block. */
const SITE_ACTIVE_DEFAULTS = Object.freeze({ bucketSeconds: 600, chance: 0.5 });
/** Load shedding: levels 2 and 3 multiply the LOD distances by these (fewer instances at NEAR and MID). */
const SHED_LOD_BIAS = Object.freeze([1, 1, 0.7, 0.5]);
const MAX_SHED_LEVEL = SHED_LOD_BIAS.length - 1;
/** Coast: land and water both within this distance (m) of the point. */
const COAST_PROBE = 1200;
const SURFACE_CACHE_LIMIT = 4096;
const LOG_LIMIT = 5000;
const DIRECTOR_SALT = 0x2545f491;

/** Budgets the director holds and the SpawnManager reads (ctx.budgets). */
export const DIRECTOR_BUDGETS = Object.freeze({
  maxHeavy: 2,
  maxRealLights: 8,
  engines: Object.freeze({
    vortex: Object.freeze({ instances: 3, particles: 40000 }),
    emitter: Object.freeze({ instances: 16, particles: 120000 }),
    weatherVolume: Object.freeze({ instances: 6, particles: 30000 }),
    fauna: Object.freeze({ instances: 8, particles: 12000 }),
    structure: Object.freeze({ instances: 24, particles: 0 }),
    celestial: Object.freeze({ instances: 3, particles: 6000 }),
    waterEffect: Object.freeze({ instances: 4, particles: 20000 }),
    lightEffect: Object.freeze({ instances: 8, particles: 30000 }),
    windModifier: Object.freeze({ instances: 12, particles: 0 }),
    setPiece: Object.freeze({ instances: 1, particles: 0 }),
  }),
});

const SURFACE_LAND = 1;
const SURFACE_WATER = 2;
const SURFACE_COAST = 4;

/** Rejection reasons (getState shows the last one per candidate). */
const REJECT = Object.freeze({
  used: 'used',
  refused: 'refused',
  timeOfDay: 'timeOfDay',
  altitude: 'altitude',
  weather: 'weather',
  surface: 'surface',
  biome: 'biome',
  cooldown: 'cooldown',
  repeat: 'repeat',
  heavyBudget: 'heavyBudget',
  deferred: 'deferred',
  engineBudget: 'engineBudget',
  lightBudget: 'lightBudget',
  notAhead: 'notAhead',
});

/**
 * Whether a time-of-day filter admits the sun at elevation (degrees) on a morning or evening.
 * day: sun up; night: sun more than 6 degrees down; dawn / dusk: the low sun of the morning / the
 * evening, from 10 degrees below the horizon to 14 above it (the golden hour counts as both day and
 * dawn or dusk).
 */
export function matchesTimeOfDay(names, sunElevation, dayTime) {
  if (!names) return true;
  const morning = dayTime < 0.5;
  const low = sunElevation >= -10 && sunElevation < 14;
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name === 'day' && sunElevation >= 0) return true;
    if (name === 'night' && sunElevation < -6) return true;
    if (name === 'dawn' && morning && low) return true;
    if (name === 'dusk' && !morning && low) return true;
  }
  return false;
}

/** Static per-preset facts the director needs every tick. */
function describePreset(preset, index) {
  const tier = RARITY_TIERS.indexOf(preset.rarity);
  if (tier < 0) throw new Error(`[DRIFTWING] director: preset "${preset.id}" has an unknown rarity "${preset.rarity}"`);
  const filters = preset.filters || {};
  const lifetime = preset.lifetime || {};
  const siteActive = preset.kind === 'site' && Boolean(preset.activeState);
  const settings = candidateSettings(preset);
  if (siteActive && !preset.candidates) {
    settings.bucketSeconds = SITE_ACTIVE_DEFAULTS.bucketSeconds;
    settings.chance = SITE_ACTIVE_DEFAULTS.chance;
  }
  const engines = (preset.engines || []).map((entry) => entry.engine);
  return {
    preset,
    index,
    id: preset.id,
    tier,
    heavy: preset.heavy === true,
    kind: preset.kind,
    candidateKind: preset.kind === 'event' ? 'event' : siteActive ? 'siteActive' : null,
    presetHash: hashString(preset.id),
    settings,
    filters,
    band: {
      min: Number.isFinite(filters.minDistance) ? filters.minDistance : DEFAULT_BAND.min,
      max: Number.isFinite(filters.maxDistance) ? filters.maxDistance : DEFAULT_BAND.max,
    },
    engines,
    usesLights: engines.includes('lightEffect'),
    cooldown: Number.isFinite(preset.cooldown) ? preset.cooldown : RARITY_COOLDOWNS[preset.rarity],
    duration: siteActive ? preset.activeState.duration || null : lifetime.duration || null,
    despawn: lifetime.despawn || null,
  };
}

/**
 * Creates a director. Options:
 *   seedHash        the world seed hash (worldgen's seedHash; candidates.seedHashFor(seed))
 *   presets         the preset list (src/spawns/presets/index.js PRESETS, or the lab's)
 *   spawnManager    the SpawnManager (contract section 4): activate, deactivate, getActive,
 *                   getInstance, getStats, and setLodBias for load shedding (spawnCount, when
 *                   offered, lets the shedder skip levels that would take nothing away)
 *   weather         a weather model (createWeatherModel): stateAt(x, z, time), sampleAt
 *   terrain         { heightAt(x, z), biomeAt(x, z) -> { key }, waterLevel }
 *   getPlayer()     -> { position: { x, y, z }, heading (deg), speed (m/s) }
 *   getTime()       -> flight time (s)
 *   getSun()        -> { sunElevation (deg), dayTime (0..1) }
 *   isInView(x, y, z, radius) -> boolean (the camera frustum)
 *   placement       optional: { sitesNear(x, z, radius) -> [site] } (site active states, getNearby)
 *   perf            optional: the perf governor (addLoadShedder, getHeadroom)
 *   bus             optional: the typed event bus (discoveries and 'spawns:siteInView' count as
 *                   notables)
 *   isDiscovered(id) optional: whether a site was discovered on an earlier flight (the journal)
 *   budgets         optional: DIRECTOR_BUDGETS by default
 *   devHooks        enables forceSpawn
 */
export function createDirector({
  seedHash,
  presets,
  spawnManager,
  weather,
  terrain,
  getPlayer,
  getTime,
  getSun,
  isInView,
  placement = null,
  perf = null,
  bus = null,
  isDiscovered = null,
  budgets = DIRECTOR_BUDGETS,
  devHooks = false,
}) {
  if (!Number.isInteger(seedHash)) throw new TypeError('createDirector: seedHash must be an integer');
  if (!Array.isArray(presets)) throw new TypeError('createDirector: presets must be an array');
  for (const method of ['activate', 'deactivate', 'getActive', 'getInstance', 'getStats']) {
    if (!spawnManager || typeof spawnManager[method] !== 'function') throw new TypeError(`createDirector: spawnManager.${method}() is missing`);
  }
  if (!weather || typeof weather.stateAt !== 'function') throw new TypeError('createDirector: weather.stateAt() is missing');
  if (!terrain || typeof terrain.heightAt !== 'function' || typeof terrain.biomeAt !== 'function') throw new TypeError('createDirector: terrain.heightAt() and terrain.biomeAt() are needed');
  for (const [name, value] of Object.entries({ getPlayer, getTime, getSun, isInView })) {
    if (typeof value !== 'function') throw new TypeError(`createDirector: ${name}() is missing`);
  }

  const baseHash = mix32((seedHash ^ DIRECTOR_SALT) >>> 0);
  const waterLevel = Number.isFinite(terrain.waterLevel) ? terrain.waterLevel : 0;
  const infos = presets.map(describePreset);
  const infoById = new Map(infos.map((info) => [info.id, info]));
  const candidateInfos = infos.filter((info) => info.candidateKind !== null);
  const eventInfos = candidateInfos.filter((info) => info.candidateKind === 'event');
  const siteActiveInfos = new Map(candidateInfos.filter((info) => info.candidateKind === 'siteActive').map((info) => [info.id, info]));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, candidateInfos.reduce((largest, info) => Math.max(largest, info.band.max), DROUGHT_BAND.max));
  const heavyCandidates = candidateInfos.some((info) => info.heavy);

  const pool = createCandidatePool(128);
  /** candidate hash -> { surface bits, biome key } (a candidate's ground never changes). */
  const groundCache = new Map();
  /** candidate hash -> time until which it is not considered again (activated, or refused). */
  const usedUntil = new Map();
  const refusedUntil = new Map();
  const cooldownUntil = new Float64Array(infos.length);
  const tierDue = new Float64Array(RARITY_TIERS.length);
  const tierCount = new Uint32Array(RARITY_TIERS.length);
  const tierActivations = new Uint32Array(RARITY_TIERS.length);
  /** Live spawns the director started: { id, info, source, activatedAt, expiresAt, outOfView, siteId, candidateId }. */
  const activations = [];
  const siteScratch = [];
  const log = [];
  let logHash = 2166136261 >>> 0;
  let logTotal = 0;

  // The director's clock starts at the flight time it is created at (0 at boot): pacing, the rarity
  // schedule and the ticks all count from there, on the half second.
  const startTime = Math.max(0, getTime());
  let time = startTime;
  let nextTickAt = Math.ceil(startTime / DIRECTOR_TICK_SECONDS) * DIRECTOR_TICK_SECONDS;
  let tickCount = 0;
  let lastNotableAt = startTime;
  let lastNotableKind = 'start';
  let notableCount = 0;
  let firstNotableAt = null;
  let droughtThreshold = DROUGHT_MIN;
  let droughtFills = 0;
  let longestDrought = 0;
  let fillableDroughts = 0;
  let droughtsInWindow = 0;
  let lastPresetIndex = -1;
  let shedLevel = 0;
  let headroomMissing = false;
  let heavyActive = 0;
  let lightsActive = 0;
  let debugSerial = 0;
  let disposed = false;
  let engineStats = null;
  const player = { x: 0, y: 0, z: 0, heading: 0, speed: 0 };
  const sun = { elevation: 0, dayTime: 0 };

  function drawPeriod(tier) {
    const [low, high] = RARITY_PERIODS[RARITY_TIERS[tier]];
    const roll = unitFromHash(rehash(baseHash, 101 + tier * 7919 + tierCount[tier] * 104729));
    tierCount[tier]++;
    return low + (high - low) * roll;
  }
  function drawDroughtThreshold() {
    return DROUGHT_MIN + DROUGHT_SPREAD * unitFromHash(rehash(baseHash, 7 + notableCount * 31337));
  }
  for (let tier = 0; tier < RARITY_TIERS.length; tier++) tierDue[tier] = startTime + drawPeriod(tier);
  droughtThreshold = drawDroughtThreshold();

  /**
   * Ends the running drought at `now`. Droughts that reached DROUGHT_MIN are the ones the fill had to
   * answer; the share of them that ended inside the pacing window is the pacing record in getState.
   */
  function endDrought(now) {
    const gap = now - lastNotableAt;
    longestDrought = Math.max(longestDrought, gap);
    if (gap >= DROUGHT_MIN) {
      fillableDroughts++;
      if (gap <= PACING_WINDOW_MAX) droughtsInWindow++;
    }
    lastNotableAt = now;
  }

  /** Something notable happened at `now` (the tick time for the director's own activations). */
  function markNotable(kind, now = getTime()) {
    endDrought(now);
    lastNotableKind = kind;
    notableCount++;
    if (firstNotableAt === null) firstNotableAt = now;
    droughtThreshold = drawDroughtThreshold();
  }

  /** A spawn the director started is in view at the current tick: the drought clock restarts. */
  function noteOngoing() {
    endDrought(time);
  }

  // Discoveries (landmarks and spawns) and sites coming into view are notables. Site ids seen in a
  // discovery mark those sites 'discovered' in getNearby (isDiscovered, when given, is asked too: the
  // journal remembers discoveries across flights).
  const discovered = new Set();
  const unsubscribers = [];
  if (bus) {
    unsubscribers.push(bus.onTyped('discovery', (payload) => {
      if (payload && typeof payload.id === 'string') discovered.add(payload.id);
      markNotable('discovery');
    }));
    // The SpawnManager announces the first sighting of a spawn; either name is heard.
    unsubscribers.push(bus.on('spawns:siteInView', () => markNotable('siteInView')));
    unsubscribers.push(bus.on('spawns:inView', () => markNotable('inView')));
  }
  function isSiteDiscovered(id) {
    return discovered.has(id) || (typeof isDiscovered === 'function' && isDiscovered(id) === true);
  }

  // ---- Load shedding ---------------------------------------------------------------------------------
  function applyLodBias() {
    if (typeof spawnManager.setLodBias === 'function') spawnManager.setLodBias(SHED_LOD_BIAS[shedLevel]);
  }
  /**
   * Whether the next level would take load away: deferring heavy activations needs heavy candidates
   * (or live spawns the later levels act on), and demoting LODs needs live spawns. A level with
   * nothing to shed is refused, so the governor goes straight to the render scale.
   */
  function nextLevelSheds() {
    const liveSpawns = typeof spawnManager.spawnCount === 'function' ? spawnManager.spawnCount() > 0 : true;
    return shedLevel === 0 ? heavyCandidates || liveSpawns : liveSpawns;
  }
  const shedder = {
    id: 'director',
    /** Level 1 defers heavy activations; levels 2-3 demote far LODs (needs spawnManager.setLodBias). */
    shed() {
      if (shedLevel >= MAX_SHED_LEVEL) return false;
      if (shedLevel >= 1 && typeof spawnManager.setLodBias !== 'function') return false;
      if (!nextLevelSheds()) return false;
      shedLevel++;
      applyLodBias();
      return true;
    },
    restore() {
      if (shedLevel === 0) return;
      shedLevel--;
      applyLodBias();
    },
  };
  const shedderHandle = perf && typeof perf.addLoadShedder === 'function' ? perf.addLoadShedder(shedder) : null;
  const siteSpawnApi = typeof spawnManager.getSiteSpawn === 'function' && typeof spawnManager.setSiteActive === 'function';

  // ---- Reading the world ----------------------------------------------------------------------------
  function readInputs() {
    const current = getPlayer();
    player.x = current.position.x;
    player.y = current.position.y;
    player.z = current.position.z;
    player.heading = current.heading;
    player.speed = current.speed;
    const sky = getSun();
    sun.elevation = sky.sunElevation;
    sun.dayTime = sky.dayTime;
    headroomMissing = perf && typeof perf.getHeadroom === 'function' ? perf.getHeadroom().missing === true : false;
  }

  function surfaceBits(x, z) {
    const water = terrain.heightAt(x, z) < waterLevel;
    let bits = water ? SURFACE_WATER : SURFACE_LAND;
    for (let probe = 0; probe < 4; probe++) {
      const probeX = x + (probe === 0 ? COAST_PROBE : probe === 1 ? -COAST_PROBE : 0);
      const probeZ = z + (probe === 2 ? COAST_PROBE : probe === 3 ? -COAST_PROBE : 0);
      if ((terrain.heightAt(probeX, probeZ) < waterLevel) !== water) {
        bits |= SURFACE_COAST;
        break;
      }
    }
    return bits;
  }

  /** The candidate's ground: { surface bits, biome key }, cached by its hash. */
  function groundOf(record) {
    let ground = groundCache.get(record.hash);
    if (!ground) {
      if (groundCache.size >= SURFACE_CACHE_LIMIT) groundCache.clear();
      ground = { surface: surfaceBits(record.x, record.z), biome: terrain.biomeAt(record.x, record.z).key };
      groundCache.set(record.hash, ground);
    }
    return ground;
  }

  function matchesSurface(surface, bits) {
    if (!surface || surface === 'any') return true;
    if (surface === 'land') return (bits & SURFACE_LAND) !== 0;
    if (surface === 'water') return (bits & SURFACE_WATER) !== 0;
    if (surface === 'coast') return (bits & SURFACE_COAST) !== 0;
    return false;
  }

  /** The preset's environment filters at the candidate: time of day, altitude, weather, surface, biome. */
  function environmentRejection(info, record) {
    const filters = info.filters;
    if (!matchesTimeOfDay(filters.timeOfDay, sun.elevation, sun.dayTime)) return REJECT.timeOfDay;
    const altitude = filters.altitude;
    if (altitude && ((Number.isFinite(altitude.min) && player.y < altitude.min) || (Number.isFinite(altitude.max) && player.y > altitude.max))) return REJECT.altitude;
    if (filters.weather && !filters.weather.includes(weather.stateAt(record.x, record.z, time))) return REJECT.weather;
    if ((filters.surface && filters.surface !== 'any') || filters.biomes) {
      const ground = groundOf(record);
      if (!matchesSurface(filters.surface, ground.surface)) return REJECT.surface;
      if (filters.biomes && !filters.biomes.includes(ground.biome)) return REJECT.biome;
    }
    return '';
  }

  function engineAtCap(info) {
    const caps = budgets.engines;
    const perEngine = engineStats && engineStats.engines ? engineStats.engines : null;
    for (let index = 0; index < info.engines.length; index++) {
      const name = info.engines[index];
      const cap = caps[name];
      if (!cap || !perEngine || !perEngine[name]) continue;
      const used = perEngine[name];
      if ((used.instances || 0) + 1 > cap.instances) return true;
      if (cap.particles > 0 && (used.particles || 0) >= cap.particles * PARTICLE_HEADROOM) return true;
    }
    return false;
  }

  /** The director's own rules for a candidate that passed its environment filters. */
  function directorRejection(info, record) {
    if (time < cooldownUntil[info.index]) return REJECT.cooldown;
    if (info.index === lastPresetIndex) return REJECT.repeat;
    if (info.heavy) {
      if (heavyActive >= budgets.maxHeavy) return REJECT.heavyBudget;
      if (shedLevel >= 1 || headroomMissing) return REJECT.deferred;
    }
    if (engineAtCap(info)) return REJECT.engineBudget;
    if (info.usesLights && lightsActive + LIGHTS_PER_SPAWN > budgets.maxRealLights) return REJECT.lightBudget;
    if (record.offAxis > MAX_OFF_AXIS_WIDE || record.distance < info.band.min || record.distance > info.band.max) return REJECT.notAhead;
    return info.candidateKind === 'event' ? managerRejection(info) : '';
  }

  function refreshBudgets() {
    engineStats = spawnManager.getStats();
    const totals = engineStats ? engineStats.total || engineStats.totals || null : null;
    lightsActive = totals && Number.isFinite(totals.lights) ? totals.lights : 0;
    // The manager's own heavy count when it keeps one (an inactive site does not count there).
    if (engineStats && Number.isFinite(engineStats.heavy)) {
      heavyActive = engineStats.heavy;
      return;
    }
    heavyActive = 0;
    const active = spawnManager.getActive();
    for (let index = 0; index < active.length; index++) {
      const instance = active[index];
      if (instance.heavy && instance.ended !== true) heavyActive++;
    }
  }

  /** The manager's own verdict, when it offers one (canActivate returns a refusal reason or null). */
  function managerRejection(info) {
    if (typeof spawnManager.canActivate !== 'function') return '';
    const refusal = spawnManager.canActivate(info.id, 'director');
    if (!refusal) return '';
    if (refusal === 'heavy') return REJECT.heavyBudget;
    if (refusal === 'instances' || refusal === 'particles') return REJECT.engineBudget;
    return REJECT.refused;
  }

  // ---- Candidates -------------------------------------------------------------------------------------
  function gatherCandidates() {
    pool.reset();
    for (let index = 0; index < eventInfos.length; index++) {
      const info = eventInfos[index];
      collectPresetCandidates(pool, {
        seedHash, presetIndex: info.index, presetHash: info.presetHash, settings: info.settings,
        x: player.x, z: player.z, radius: Math.min(searchRadius, info.band.max), time,
      });
    }
    siteScratch.length = 0;
    if (placement && siteActiveInfos.size > 0) {
      const sites = placement.sitesNear(player.x, player.z, searchRadius);
      for (let index = 0; index < sites.length; index++) {
        const site = sites[index];
        const info = siteActiveInfos.get(site.presetId);
        if (!info) continue;
        const bucket = Math.floor(time / info.settings.bucketSeconds);
        const hash = candidateHash(seedHash, hashString(site.id), 0, bucket, info.presetHash);
        const roll = unitFromHash(hash);
        if (roll >= info.settings.chance) continue;
        const dx = site.x - player.x;
        const dz = site.z - player.z;
        const distance = Math.hypot(dx, dz);
        if (distance > info.band.max) continue;
        siteScratch.push(site);
        const record = pool.acquire();
        record.hash = hash;
        record.presetIndex = info.index;
        record.cellX = 0;
        record.cellZ = 0;
        record.bucket = bucket;
        record.x = site.x;
        record.z = site.z;
        record.roll = roll / info.settings.chance;
        record.heading = Number.isFinite(site.rotation) ? (site.rotation * 180) / Math.PI : 0;
        record.distance = distance;
        record.siteIndex = siteScratch.length - 1;
      }
    }
    for (let index = 0; index < pool.count; index++) {
      const record = pool.records[index];
      record.bearing = bearingDegrees(player.x, player.z, record.x, record.z);
      record.offAxis = angleBetween(record.bearing, player.heading);
    }
  }

  /** Marks every candidate viable (its environment admits it) and eligible (the director may start it now). */
  function evaluateCandidates() {
    for (let index = 0; index < pool.count; index++) {
      const record = pool.records[index];
      const info = infos[record.presetIndex];
      record.eligible = false;
      record.viable = false;
      if ((usedUntil.get(record.hash) ?? -1) > time) { record.rejection = REJECT.used; continue; }
      if ((refusedUntil.get(record.hash) ?? -1) > time) { record.rejection = REJECT.refused; continue; }
      const environment = environmentRejection(info, record);
      if (environment) { record.rejection = environment; continue; }
      record.viable = true;
      const rule = directorRejection(info, record);
      if (rule) { record.rejection = rule; continue; }
      record.eligible = true;
      record.rejection = '';
      record.score = aheadScore(record.distance, record.offAxis, { minDistance: info.band.min, maxDistance: info.band.max, maxOffAxis: MAX_OFF_AXIS_WIDE });
    }
  }

  /** Higher rank first; equal ranks fall back to the candidates' total order. */
  function compareRanked(first, second) {
    if (first.rank !== second.rank) return second.rank - first.rank;
    return compareCandidates(first, second);
  }

  /**
   * The best eligible candidate for a choice: tierMask admits rarity tiers (bit per tier), maxOffAxis
   * bounds the angle off the heading, and drought fills also keep to DROUGHT_BAND. Due tiers outrank
   * the rest, rarer due tiers first, then the ahead score decides, with the candidate's own roll as a
   * small seeded preference.
   */
  function pickBest(tierMask, maxOffAxis, droughtFill) {
    let best = null;
    for (let index = 0; index < pool.count; index++) {
      const record = pool.records[index];
      if (!record.eligible) continue;
      const info = infos[record.presetIndex];
      if ((tierMask & (1 << info.tier)) === 0 || record.offAxis > maxOffAxis) continue;
      if (droughtFill && (record.distance < DROUGHT_BAND.min || record.distance > DROUGHT_BAND.max)) continue;
      const due = time >= tierDue[info.tier];
      record.rank = (due ? 10 + info.tier : 0) + record.score + (1 - record.roll) * 0.01;
      if (best === null || compareRanked(record, best) < 0) best = record;
    }
    return best;
  }

  // ---- Activation -----------------------------------------------------------------------------------
  function appendLog(entry) {
    log.push(entry);
    if (log.length > LOG_LIMIT) log.shift();
    logTotal++;
    const line = `${entry.time}|${entry.presetId}|${entry.candidateId}|${entry.reason};`;
    for (let index = 0; index < line.length; index++) {
      logHash ^= line.charCodeAt(index);
      logHash = Math.imul(logHash, 16777619) >>> 0;
    }
  }

  function durationFor(info, hash) {
    const range = info.duration;
    if (!Array.isArray(range) || range.length !== 2) return null;
    return range[0] + (range[1] - range[0]) * unitFromHash(rehash(hash, 11));
  }

  function groundY(x, z) {
    return Math.max(terrain.heightAt(x, z), waterLevel);
  }

  function track(id, info, source, { candidate, siteId, duration, siteActive = false }) {
    const record = {
      id,
      info,
      source,
      activatedAt: time,
      // A site's active state ends exactly at its duration (nothing else ends it); an event gets a
      // grace period, since its engine normally ends it first.
      expiresAt: duration === null ? Infinity : time + duration + (siteActive ? 0 : LIFETIME_GRACE),
      durationChecked: siteActive,
      outOfView: 0,
      siteId,
      siteActive,
      candidateId: candidate,
    };
    activations.push(record);
    cooldownUntil[info.index] = time + info.cooldown;
    lastPresetIndex = info.index;
    tierDue[info.tier] = time + drawPeriod(info.tier);
    tierActivations[info.tier]++;
    if (info.heavy) heavyActive++;
    return record;
  }

  function activateCandidate(record, reason) {
    const info = infos[record.presetIndex];
    const site = record.siteIndex >= 0 ? siteScratch[record.siteIndex] : null;
    const duration = durationFor(info, record.hash);
    const position = { x: record.x, y: site && Number.isFinite(site.groundY) ? site.groundY : groundY(record.x, record.z), z: record.z };
    const bucketEnd = (record.bucket + 1) * info.settings.bucketSeconds;
    const siteActive = site !== null && siteSpawnApi;
    const id = siteActive ? startSiteActiveState(site) : spawnManager.activate(info.id, {
      position,
      heading: record.heading,
      source: 'director',
      seed: record.hash,
      duration,
      ...(site ? { site } : {}),
    });
    if (id === null || id === undefined) {
      // Refused (a budget the director could not see, or a site not loaded yet): leave this
      // candidate for the rest of its bucket.
      refusedUntil.set(record.hash, bucketEnd);
      return false;
    }
    usedUntil.set(record.hash, bucketEnd);
    const label = site ? `${site.id}@${record.bucket}` : candidateId(record, info.id);
    track(id, info, 'director', { candidate: label, siteId: site ? site.id : null, duration, siteActive });
    appendLog({ time, presetId: info.id, candidateId: label, reason });
    markNotable('event', time);
    if (reason === 'drought') droughtFills++;
    return true;
  }

  /**
   * A manager with a site API (getSiteSpawn / setSiteActive) keeps one spawn per site and switches its
   * active state; the director then starts and ends the state on that spawn. Returns its id or null.
   */
  function startSiteActiveState(site) {
    const spawnId = spawnManager.getSiteSpawn(site.id);
    if (!spawnId) return null;
    return spawnManager.setSiteActive(spawnId, true) === false ? null : spawnId;
  }

  /** Ends what the director started: a site's active state, or the spawn itself. */
  function endActivation(record, reason) {
    if (record.siteActive) spawnManager.setSiteActive(record.id, false);
    else spawnManager.deactivate(record.id, reason);
  }

  function decide() {
    const drought = time - lastNotableAt;
    let dueMask = 0;
    for (let tier = 0; tier < RARITY_TIERS.length; tier++) if (time >= tierDue[tier]) dueMask |= 1 << tier;
    if (drought >= droughtThreshold) {
      // Common candidates and those of a due tier fill a drought; from DROUGHT_RELAX uncommon ones
      // too, and from DROUGHT_WIDEN rare ones, in the wider cone ahead.
      const widened = drought >= DROUGHT_WIDEN;
      const fillMask = dueMask | COMMON_BIT | (drought >= DROUGHT_RELAX ? UNCOMMON_BIT : 0) | (widened ? RARE_BIT : 0);
      const best = pickBest(fillMask, widened ? MAX_OFF_AXIS_WIDE : MAX_OFF_AXIS, true);
      if (best && activateCandidate(best, 'drought')) return;
    }
    // Scheduled rarity: the rarest due tier with an eligible candidate ahead.
    for (let tier = RARITY_TIERS.length - 1; tier >= 0; tier--) {
      if ((dueMask & (1 << tier)) === 0) continue;
      const best = pickBest(1 << tier, MAX_OFF_AXIS, false);
      if (best && activateCandidate(best, 'schedule')) return;
    }
  }

  // ---- Lifetimes and despawn -------------------------------------------------------------------------
  function removeActivation(index) {
    const last = activations.length - 1;
    if (index !== last) activations[index] = activations[last];
    activations.pop();
  }

  function pollActivations() {
    for (let index = activations.length - 1; index >= 0; index--) {
      const record = activations[index];
      const instance = spawnManager.getInstance(record.id);
      if (!instance || instance.ended === true) {
        removeActivation(index);
        continue;
      }
      // A manager that draws the event's duration itself reports it: the backstop follows that one.
      if (!record.durationChecked) {
        record.durationChecked = true;
        if (Number.isFinite(instance.duration)) record.expiresAt = record.activatedAt + instance.duration + LIFETIME_GRACE;
      }
      if (time >= record.expiresAt) {
        endActivation(record, 'lifetime');
        removeActivation(index);
        continue;
      }
      const anchor = instance.anchor || instance.position;
      if (!anchor) continue;
      const inView = isInView(anchor.x, anchor.y, anchor.z, instance.radius || 0);
      // A spawn in view is something notable going on: no drought while the player can see it.
      if (inView) noteOngoing();
      const rule = record.info.despawn;
      if (!rule) continue;
      const distance = Math.hypot(anchor.x - player.x, anchor.z - player.z);
      if (distance > rule.distance + rule.hysteresis) {
        if (inView) record.outOfView = 0;
        else record.outOfView += DIRECTOR_TICK_SECONDS;
        if (record.outOfView >= rule.outOfViewSeconds) {
          endActivation(record, 'despawn');
          removeActivation(index);
        }
      } else if (distance < rule.distance) {
        record.outOfView = 0;
      }
    }
  }

  function pruneMaps() {
    for (const [hash, until] of usedUntil) if (until <= time) usedUntil.delete(hash);
    for (const [hash, until] of refusedUntil) if (until <= time) refusedUntil.delete(hash);
  }

  function tick() {
    tickCount++;
    readInputs();
    refreshBudgets();
    pollActivations();
    gatherCandidates();
    evaluateCandidates();
    decide();
    if (tickCount % 120 === 0) pruneMaps();
  }

  // ---- API --------------------------------------------------------------------------------------------
  function entryFor(id, info, x, z, state) {
    const distance = Math.hypot(x - player.x, z - player.z);
    return {
      id,
      name: info ? info.preset.name : id,
      category: info ? info.preset.category : 'unknown',
      distance: Math.round(distance),
      bearing: Math.round(bearingDegrees(player.x, player.z, x, z)) % 360,
      state,
      etaSeconds: player.speed > 1 ? Math.round(distance / player.speed) : null,
    };
  }

  return {
    /** Call every frame: the director ticks at 2 Hz on the flight clock (getTime), on the half second. */
    update() {
      if (disposed) return;
      const now = getTime();
      let ticks = 0;
      while (now >= nextTickAt && ticks < 4) {
        time = nextTickAt;
        nextTickAt += DIRECTOR_TICK_SECONDS;
        tick();
        ticks++;
      }
      // A long stall (a hidden tab) skips the missed ticks instead of replaying them.
      if (now >= nextTickAt) nextTickAt = Math.ceil(now / DIRECTOR_TICK_SECONDS) * DIRECTOR_TICK_SECONDS;
    },

    /**
     * Spawns, dormant candidates and sites within radiusKm, nearest first:
     * [{ id, name, category, distance (m), bearing (deg), state, etaSeconds }]. state is 'active'
     * (a live spawn the director started, or an active site), 'dormant' (a candidate its filters admit
     * now), 'site' (a site not yet discovered) or 'discovered'.
     */
    getNearby(radiusKm = 10) {
      const radius = Math.max(0, Number(radiusKm) || 0) * 1000;
      const entries = [];
      const activeSites = new Set();
      readInputs();
      for (const record of activations) {
        const instance = spawnManager.getInstance(record.id);
        const anchor = instance ? instance.anchor || instance.position : null;
        if (!instance || instance.ended === true || !anchor) continue;
        if (record.siteId) activeSites.add(record.siteId);
        const entry = entryFor(record.siteId || record.id, record.info, anchor.x, anchor.z, 'active');
        if (entry.distance <= radius) entries.push(entry);
      }
      for (let index = 0; index < pool.count; index++) {
        const record = pool.records[index];
        if (!record.viable || record.siteIndex >= 0) continue;
        const info = infos[record.presetIndex];
        if ((usedUntil.get(record.hash) ?? -1) > time) continue;
        const entry = entryFor(candidateId(record, info.id), info, record.x, record.z, 'dormant');
        if (entry.distance <= radius) entries.push(entry);
      }
      if (placement) {
        for (const site of placement.sitesNear(player.x, player.z, radius)) {
          // Sites of presets the director does not know (the terrain test's fixtures) are skipped.
          if (activeSites.has(site.id) || !infoById.has(site.presetId)) continue;
          const state = isSiteDiscovered(site.id) ? 'discovered' : 'site';
          entries.push(entryFor(site.id, infoById.get(site.presetId), site.x, site.z, state));
        }
      }
      return entries.sort((first, second) => first.distance - second.distance);
    },

    /** Director state for the debugger and the labs (a snapshot; safe to keep). */
    getState() {
      const cooldowns = {};
      for (const info of infos) {
        const remaining = cooldownUntil[info.index] - time;
        if (remaining > 0) cooldowns[info.id] = Math.round(remaining);
      }
      const tiers = {};
      RARITY_TIERS.forEach((name, tier) => {
        tiers[name] = { dueIn: Math.round(tierDue[tier] - time), activations: tierActivations[tier] };
      });
      const candidates = [];
      for (let index = 0; index < pool.count && candidates.length < 60; index++) {
        const record = pool.records[index];
        const info = infos[record.presetIndex];
        candidates.push({
          id: record.siteIndex >= 0 ? `${siteScratch[record.siteIndex].id}@${record.bucket}` : candidateId(record, info.id),
          presetId: info.id,
          distance: Math.round(record.distance),
          offAxis: Math.round(record.offAxis),
          eligible: record.eligible,
          rejection: record.rejection,
        });
      }
      const engines = {};
      for (const [name, cap] of Object.entries(budgets.engines)) {
        const used = engineStats && engineStats.engines && engineStats.engines[name] ? engineStats.engines[name] : null;
        engines[name] = { instances: used ? used.instances || 0 : 0, maxInstances: cap.instances, particles: used ? used.particles || 0 : 0, maxParticles: cap.particles };
      }
      return {
        time,
        ticks: tickCount,
        droughtSeconds: Math.round((time - lastNotableAt) * 10) / 10,
        droughtThreshold: Math.round(droughtThreshold * 10) / 10,
        longestDrought: Math.round(Math.max(longestDrought, time - lastNotableAt) * 10) / 10,
        lastNotable: { time: lastNotableAt, kind: lastNotableKind },
        firstNotableAt,
        notables: notableCount,
        droughtFills,
        pacing: { droughts: fillableDroughts, withinWindow: droughtsInWindow },
        weather: weather.stateAt(player.x, player.z, time),
        heavyCount: heavyActive,
        budgets: { maxHeavy: budgets.maxHeavy, maxRealLights: budgets.maxRealLights, lights: lightsActive, engines },
        shedLevel,
        deferHeavy: shedLevel >= 1 || headroomMissing,
        tiers,
        cooldowns,
        lastPresetId: lastPresetIndex >= 0 ? infos[lastPresetIndex].id : null,
        candidates,
        active: activations.map((record) => ({
          id: record.id,
          presetId: record.info.id,
          source: record.source,
          age: Math.round(time - record.activatedAt),
          remaining: Number.isFinite(record.expiresAt) ? Math.round(record.expiresAt - LIFETIME_GRACE - time) : null,
        })),
        log: log.slice(-50),
        logLength: logTotal,
        logHash: logHash.toString(16).padStart(8, '0'),
      };
    },

    /** The whole activation log (a copy): [{ time, presetId, candidateId, reason }]. */
    getLog() {
      return log.map((entry) => ({ ...entry }));
    },

    /** Whether presetId is one of the director's presets (forceSpawn and scheduling know it). */
    hasPreset(presetId) {
      return infoById.has(presetId);
    },

    /**
     * Dev only: starts a preset ahead of the player through the SpawnManager (source 'debug').
     * options: { distance (m), bearingOffset (deg), force (ignore the manager's budgets) }.
     */
    forceSpawn(presetId, { distance = 3000, bearingOffset = 0, force = false } = {}) {
      if (!devHooks) throw new Error('director.forceSpawn is only available in development builds or with ?debug=1');
      const info = infoById.get(presetId);
      if (!info) throw new RangeError(`director.forceSpawn: unknown preset "${presetId}"`);
      readInputs();
      const radians = ((player.heading + bearingOffset) * Math.PI) / 180;
      const x = player.x + Math.sin(radians) * distance;
      const z = player.z - Math.cos(radians) * distance;
      const seed = mix32((baseHash ^ Math.imul(++debugSerial, 0x9e3779b1)) >>> 0);
      const duration = durationFor(info, seed);
      const id = spawnManager.activate(info.id, { position: { x, y: groundY(x, z), z }, heading: player.heading, source: 'debug', seed, duration, force: force === true });
      if (id === null || id === undefined) return null;
      const label = `debug:${debugSerial}`;
      track(id, info, 'debug', { candidate: label, siteId: null, duration });
      appendLog({ time, presetId: info.id, candidateId: label, reason: 'debug' });
      markNotable('event', time);
      return id;
    },

    /** The director's load shedder (registered with perf when one was given). */
    shedder,

    /** Stops the director: unsubscribes, unregisters the shedder and ends the spawns it started. */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe();
      if (shedderHandle) shedderHandle.remove();
      for (const record of activations) endActivation(record, 'dispose');
      activations.length = 0;
    },
  };
}

/**
 * The director wired to the running game, for the spawns system to create once its SpawnManager
 * exists and to update every frame: the flight clock, the player, the sun, the camera frustum, the
 * regional weather system, the world's height and biome functions, the perf governor and the bus.
 * options: { spawnManager, presets, placement?, isDiscovered?, budgets?, devHooks? }. budgets defaults to
 * DIRECTOR_BUDGETS (the spawns system passes the SpawnManager's own budget view, so both agree);
 * devHooks (forceSpawn) defaults to dev builds and ?debug=1.
 */
export function createGameDirector(ctx, { spawnManager, presets, placement = null, isDiscovered = null, budgets = DIRECTOR_BUDGETS, devHooks = null }) {
  const { THREE, state, camera, world, CONFIG } = ctx;
  const weather = ctx.systems.weather;
  if (!weather || !weather.model) throw new Error('createGameDirector: the weather system must be created first');
  const params = new URLSearchParams(window.location.search);
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  let frustumFrame = -1;
  return createDirector({
    seedHash: world.seedHash >>> 0,
    presets,
    spawnManager,
    weather: weather.model,
    terrain: { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: CONFIG.WATER_LEVEL },
    getPlayer: () => state.player,
    getTime: () => state.time.elapsed,
    getSun: () => state.time,
    isInView(x, y, z, radius) {
      if (frustumFrame !== state.frame) {
        frustumFrame = state.frame;
        viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem, camera.reversedDepth);
      }
      sphere.center.set(x, y, z);
      sphere.radius = radius;
      return frustum.intersectsSphere(sphere);
    },
    placement,
    perf: ctx.perf,
    bus: ctx.bus,
    isDiscovered,
    budgets,
    devHooks: devHooks === null ? Boolean(import.meta.env?.DEV) || params.get('debug') === '1' : devHooks === true,
  });
}
