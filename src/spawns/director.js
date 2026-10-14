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
//              threshold (a seeded 60-70 s per drought, leaving time to find one), the best eligible candidate AHEAD on the
//              ground track, 3-8 km out, is activated: a common one or one of a due tier, from 75 s an
//              uncommon one too, and from 80 s a rare one or one up to 60 degrees off the track
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
//              candidate, surface (land, water, coast), distance band, and `near`: a candidate moves
//              onto the nearest Phase 1 landmark of the named types within the radius of its seeded
//              point (a lantern festival at a lighthouse), or is rejected when there is none
//   ahead      every director activation lies within 45 degrees of the ground track (60 for a
//              drought past 80 s) and inside the preset's distance band; nothing is ever started
//              behind the player. The ground track is the bearing of the horizontal velocity,
//              smoothed over 1 s, or the nose heading below 2 m/s: a balloon, an airship or anything
//              drifting gets its content along its drift line, not where the nose points
//   lifetimes  events end naturally (the engine sets instance.ended) or after their seeded duration
//              plus a grace period; beyond despawn.distance + hysteresis and out of view for
//              outOfViewSeconds they are despawned, and back inside despawn.distance the out-of-view
//              timer resets
//   perf       a load shedder: level 1 defers heavy activations, levels 2 and 3 demote far LODs
//              through the SpawnManager's LOD bias. The perf governor consults it before it lowers
//              the render scale. A frame-time miss reported by perf.getHeadroom() also defers heavy
//              activations on its own
//   craft      (contract i.2) the ahead score is multiplied by craftWeight(preset, profile,
//              altitude): the flying craft's directorProfile (its module's, or
//              DEFAULT_DIRECTOR_PROFILES) favours preset tags and categories, clamped to 0.25..3, so
//              it reorders candidates inside a rarity tier but never across tiers (a due tier adds 10)
//   combos     (contract i.3) a preset with a `combo` block is a legendary candidate whose
//              preconditions (biomes, time of day, weather at the candidate, an active site nearby,
//              landmarks or sites within a radius) all hold; it starts only when the budgets admit
//              every member at once, its members are placed around it deterministically and started
//              (some after a delay, their budget share reserved meanwhile), and an exclusive combo
//              keeps every other legendary out while it runs
//   overrides  (contract i.4, src/spawns/overrides.js) presets with an `override` block (the blood
//              moon, the midnight sun) are never candidates: their per-night schedule gives a weight
//              at the player, fires globalOverride and drives the sky through the overrideSink
//
// Every activation is logged as { time, presetId, candidateId, reason, craft } (combos add combo
// and members, in order); the log (and its running hash) is identical for the same seed, the same
// scripted path and the same craft, which the determinism test and tools/lab/director.mjs check.
// The director allocates only when something happens (an activation, a new candidate position, a
// craft change, an API call); a quiet tick reuses pooled records.
//
// Distances are metres, headings and bearings compass degrees (0 north, 90 east), times seconds of
// flight (state.time.elapsed in the game).
import { applyMidnightSun, createOverrideSchedule, nightIndex } from './overrides.js';
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
const LEGENDARY_TIER = RARITY_TIERS.indexOf('legendary');
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
/** Below this ground speed (m/s) the ahead tests follow the nose heading instead of the ground track. */
export const TRACK_MIN_SPEED = 2;
/** The ground track is smoothed over this time constant (s), on the director's ticks. */
export const TRACK_SMOOTHING_SECONDS = 1;
const TRACK_BLEND = 1 - Math.exp(-DIRECTOR_TICK_SECONDS / TRACK_SMOOTHING_SECONDS);
/** Craft weights are clamped to this range (contract i.2): never enough to reorder rarity tiers. */
export const CRAFT_WEIGHT_RANGE = Object.freeze({ min: 0.25, max: 3 });

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * The director profiles the spec requires (contract i.2), for a craft whose module brings no
 * directorProfile of its own (a module's profile always wins). Tags are PRESET_TAGS (schema.js),
 * categories PRESET_CATEGORIES; an `above` band multiplies on top of the base favour from its
 * altitude (m MSL) up.
 */
export const DEFAULT_DIRECTOR_PROFILES = freezeDeep({
  seaplane: { favor: { tags: { water: 1.8, lake: 2, coast: 1.4 } } },
  eagle: { favor: { tags: { thermal: 2, perch: 1.8, murmuration: 1.8 } } },
  spaceplane: {
    above: [{
      altitude: 20000,
      favor: { tags: { celestial: 3, farLure: 2.5 }, categories: { wildlife: 0.25, structure: 0.25, flightplay: 0.25, geo: 0.5, ocean: 0.5 } },
    }],
  },
  balloon: { favor: { tags: { calm: 1.8, slow: 1.8, spectacle: 1.5 } } },
  airship: { favor: { tags: { calm: 1.5, slow: 1.5, spectacle: 1.4 } } },
});

/** The product of a favour block's weights that apply to a preset (its tags and its category). */
function favorWeight(preset, favor) {
  if (!favor) return 1;
  let weight = 1;
  const tags = favor.tags;
  if (tags && Array.isArray(preset.tags)) {
    for (let index = 0; index < preset.tags.length; index++) {
      const value = tags[preset.tags[index]];
      if (Number.isFinite(value) && value > 0) weight *= value;
    }
  }
  const categories = favor.categories;
  if (categories) {
    const value = categories[preset.category];
    if (Number.isFinite(value) && value > 0) weight *= value;
  }
  return weight;
}

/**
 * How much a craft favours a preset (contract i.2): the base favour of its directorProfile times every
 * `above` band the altitude (m MSL) has reached, clamped to CRAFT_WEIGHT_RANGE; 1 without a profile.
 */
export function craftWeight(preset, profile, altitude) {
  if (!profile) return 1;
  let weight = favorWeight(preset, profile.favor);
  const bands = profile.above;
  if (Array.isArray(bands)) {
    for (let index = 0; index < bands.length; index++) {
      if (altitude >= bands[index].altitude) weight *= favorWeight(preset, bands[index].favor);
    }
  }
  return Math.min(CRAFT_WEIGHT_RANGE.max, Math.max(CRAFT_WEIGHT_RANGE.min, weight));
}

/** How many of a profile's `above` bands an altitude has reached (weights change only when this does). */
function bandLevel(profile, altitude) {
  const bands = profile ? profile.above : null;
  if (!Array.isArray(bands)) return 0;
  let level = 0;
  for (let index = 0; index < bands.length; index++) if (altitude >= bands[index].altitude) level++;
  return level;
}

/** A combo whose members cannot all start within this long after their start time drops the rest (s). */
export const COMBO_MEMBER_PATIENCE = 60;
/** A refused waiting member is tried again this often (s). */
const COMBO_MEMBER_RETRY = 2;
/** siteActive preconditions look this far (m) from the candidate when the combo names no near radius. */
const COMBO_SITE_RADIUS = 20000;
const COMBO_MEMBER_SALT = 0x51ed;
/** The blood moon's sky modifier at full weight: a deep red moon (and moon light) in a darker night. */
const BLOOD_MOON_SKY = Object.freeze({ darkness: 0.32, ambient: 0.8, moonTint: 0xc8442a, moonTintAmount: 0.88 });
/** An override's own preset starts this far (m) ahead on the ground track (its discovery). */
const OVERRIDE_SPAWN_DISTANCE = 3000;
/** A refused override spawn is tried again after this long (s). */
const OVERRIDE_SPAWN_RETRY = 10;
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
  near: 'near',
  precondition: 'precondition',
  exclusive: 'exclusive',
  comboBudget: 'comboBudget',
});

/**
 * Whether a time-of-day filter admits the sun at elevation (degrees) on a morning or evening.
 * day: sun up; night: sun more than 6 degrees down; dawn / dusk: the low sun of the morning / the
 * evening, from 10 degrees below the horizon to 14 above it (the golden hour counts as both day and
 * dawn or dusk); golden: the sky's golden band, 3 degrees below the horizon to 14 above, morning or
 * evening; midday: the sun 14 degrees up or more, above the golden band (the thermal hours).
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
    if (name === 'golden' && sunElevation >= -3 && sunElevation < 14) return true;
    if (name === 'midday' && sunElevation >= 14) return true;
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
  const near = filters.near && Array.isArray(filters.near.landmarks) && Number.isFinite(filters.near.radius)
    ? { landmarks: filters.near.landmarks, radius: filters.near.radius }
    : null;
  // An override preset is scheduled per night (src/spawns/overrides.js), never rolled as a candidate.
  const override = preset.override || null;
  return {
    preset,
    index,
    id: preset.id,
    tier,
    heavy: preset.heavy === true,
    kind: preset.kind,
    candidateKind: override ? null : preset.kind === 'event' ? 'event' : siteActive ? 'siteActive' : null,
    /** The combo block, resolved against the other presets by resolveCombos (null for a plain preset). */
    combo: preset.combo || null,
    override,
    presetHash: hashString(preset.id),
    settings,
    filters,
    band: {
      min: Number.isFinite(filters.minDistance) ? filters.minDistance : DEFAULT_BAND.min,
      max: Number.isFinite(filters.maxDistance) ? filters.maxDistance : DEFAULT_BAND.max,
    },
    engines,
    near,
    usesLights: engines.includes('lightEffect'),
    cooldown: Number.isFinite(preset.cooldown) ? preset.cooldown : RARITY_COOLDOWNS[preset.rarity],
    duration: siteActive ? preset.activeState.duration || null : lifetime.duration || null,
    despawn: lifetime.despawn || null,
  };
}

/**
 * Resolves every combo block against the director's presets (contract i.3): its members' infos in
 * order, the heavy slots it needs at once (at least its heavy members and itself), the engine
 * instances and real lights its members use, and the member ids the log records.
 */
function resolveCombos(infos, infoById) {
  for (const info of infos) {
    if (!info.combo) continue;
    const block = info.combo;
    if (info.kind !== 'event' || info.preset.rarity !== 'legendary') throw new Error(`[DRIFTWING] director: combo "${info.id}" must be a legendary event`);
    const members = [];
    block.members.forEach((member, index) => {
      const memberInfo = infoById.get(member.presetId);
      // An optional member names a preset this build may not have (another batch's): the combo then
      // starts without it, and its log and comboStarted list the members it really has.
      if (!memberInfo && member.optional === true) return;
      if (!memberInfo || memberInfo.kind !== 'event' || memberInfo.combo || memberInfo.override) {
        throw new Error(`[DRIFTWING] director: combo "${info.id}" member ${index} names "${member.presetId}", which is not a plain event preset of the director`);
      }
      members.push({
        info: memberInfo,
        role: member.role === 'anchor' ? 'anchor' : 'member',
        place: member.place || null,
        delay: Number.isFinite(member.delay) ? member.delay : 0,
      });
    });
    const engineNeeds = {};
    let heavyMembers = info.heavy ? 1 : 0;
    let lights = info.usesLights ? 1 : 0;
    for (const name of info.engines) engineNeeds[name] = (engineNeeds[name] || 0) + 1;
    for (const member of members) {
      if (member.info.heavy) heavyMembers++;
      if (member.info.usesLights) lights++;
      for (const name of member.info.engines) engineNeeds[name] = (engineNeeds[name] || 0) + 1;
    }
    const preconditions = block.preconditions || {};
    info.combo = {
      preconditions,
      near: preconditions.near || null,
      siteRadius: preconditions.near && Number.isFinite(preconditions.near.radius) ? preconditions.near.radius : COMBO_SITE_RADIUS,
      members,
      memberIds: Object.freeze(members.map((member) => member.info.id)),
      exclusive: block.exclusive === true,
      heavySlots: Math.max(Number.isInteger(block.heavySlots) ? block.heavySlots : 0, heavyMembers),
      engineNeeds,
      engineNames: Object.keys(engineNeeds),
      lights,
    };
  }
}

/**
 * Creates a director. Options:
 *   seedHash        the world seed hash (worldgen's seedHash; candidates.seedHashFor(seed))
 *   presets         the preset list (src/spawns/presets/index.js PRESETS, or the lab's)
 *   spawnManager    the SpawnManager (contract section 4): activate, deactivate, getActive,
 *                   getInstance, getStats, and setLodBias for load shedding (spawnCount, when
 *                   offered, lets the shedder skip levels that would take nothing away)
 *   weather         a weather model (createWeatherModel): stateAt(x, z, time), sampleAt
 *   terrain         { heightAt(x, z), biomeAt(x, z) -> { key, weights? }, waterLevel,
 *                   landmarkSitesNear?(x, z, radius) -> [{ type, x, z }], biomeKeys? (the keys of
 *                   biomeAt's weights, in order: the overrides' regional blend) } (without
 *                   landmarkSitesNear, presets with a `near` filter are never activated)
 *   getPlayer()     -> { position: { x, y, z }, heading (deg), speed (m/s), velocity?: { x, y, z } }
 *                   (the ahead tests follow the ground track of velocity, contract i.1)
 *   getTime()       -> flight time (s)
 *   getSun()        -> { sunElevation (deg), dayTime (0..1), days? (the day counter: whole days
 *                   since the start plus dayTime; the overrides' night index, dayTime without it) }
 *   isInView(x, y, z, radius) -> boolean (the camera frustum)
 *   placement       optional: { sitesNear(x, z, radius) -> [site] } (site active states, getNearby)
 *   perf            optional: the perf governor (addLoadShedder, getHeadroom)
 *   bus             optional: the typed event bus (discoveries and 'spawns:siteInView' count as
 *                   notables)
 *   isDiscovered(id) optional: whether a site was discovered on an earlier flight (the journal)
 *   budgets         optional: DIRECTOR_BUDGETS by default
 *   getCraft()      optional: the flying craft's id (contract i.2: the craft weighting and the log)
 *   profileFor(id)  optional: the craft's directorProfile or null (DEFAULT_DIRECTOR_PROFILES[id] by
 *                   default; the game passes the module's own profile first)
 *   overrideSink    optional: { apply(entry), dispose() } receives every override entry each tick
 *                   ({ id, presetId, kind, night, scheduled, weight, region }; the game's drives
 *                   the sky) and is disposed with the director
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
  getCraft = null,
  profileFor = null,
  overrideSink = null,
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
  resolveCombos(infos, infoById);
  const candidateInfos = infos.filter((info) => info.candidateKind !== null);
  const eventInfos = candidateInfos.filter((info) => info.candidateKind === 'event');
  const siteActiveInfos = new Map(candidateInfos.filter((info) => info.candidateKind === 'siteActive').map((info) => [info.id, info]));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, candidateInfos.reduce((largest, info) => Math.max(largest, info.band.max), DROUGHT_BAND.max));
  const heavyCandidates = candidateInfos.some((info) => info.heavy);
  const lookupProfile = typeof profileFor === 'function' ? profileFor : (id) => DEFAULT_DIRECTOR_PROFILES[id] ?? null;
  /** craftWeight per preset for the current craft and altitude band (recomputed when either changes). */
  const weights = new Float64Array(infos.length).fill(1);
  const craftState = { id: '', profile: null, band: 0 };
  const overrides = createOverrideSchedule({ seedHash, presets, biomeAt: terrain.biomeAt, biomeKeys: terrain.biomeKeys ?? null });
  /** Per override entry: whether it is on, above half weight, and the spawn it started (discovery). */
  const overrideStatus = overrides.entries.map(() => ({ active: false, high: false, spawnId: null, spawnedNight: null, retryAt: -Infinity }));

  const pool = createCandidatePool(128);
  /** candidate hash -> { surface bits, biome key } (a candidate's ground never changes). */
  const groundCache = new Map();
  /** candidate hash -> the landmark { x, z } a `near` candidate moved onto, or null (none in reach). */
  const nearCache = new Map();
  /** candidate hash -> time until which it is not considered again (activated, or refused). */
  const usedUntil = new Map();
  const refusedUntil = new Map();
  const cooldownUntil = new Float64Array(infos.length);
  const tierDue = new Float64Array(RARITY_TIERS.length);
  const tierCount = new Uint32Array(RARITY_TIERS.length);
  const tierActivations = new Uint32Array(RARITY_TIERS.length);
  /**
   * Live spawns the director started: { id, info, source, activatedAt, expiresAt, outOfView, siteId,
   * candidateId, combo (the combo record it belongs to, or null), comboMember }.
   */
  const activations = [];
  /** candidate hash -> the { x, z } a combo's near precondition moved it onto, or null (none in reach). */
  const comboNearCache = new Map();
  /**
   * Live combos: { id, info, presetId, hash, x, z, viewX, viewZ, heading, source, forced, exclusive,
   * live (spawns still running), mainAlive, pending [{ index, at }] }.
   */
  const combos = [];
  /** The budget share of combo members still waiting for their delay (kept free for them). */
  const reserved = { heavy: 0, lights: 0, engines: {} };
  for (const name of Object.keys(budgets.engines)) reserved.engines[name] = 0;
  let legendaryLive = 0;
  let exclusiveLive = 0;
  const memberPoint = { x: 0, z: 0 };
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
  // heading: the nose (compass degrees); track: where the craft is actually going over the ground
  // (contract i.1), the smoothed bearing of the horizontal velocity, which every ahead test uses.
  const player = { x: 0, y: 0, z: 0, heading: 0, speed: 0, groundSpeed: 0, track: 0 };
  /** The smoothed ground-track direction (a horizontal unit vector, compass frame: x east, z south). */
  const trackDirection = { x: 0, z: -1, ready: false };
  const sun = { elevation: 0, dayTime: 0, days: 0 };

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
  /**
   * The ground track (contract i.1): the bearing of the horizontal velocity, or the nose heading below
   * TRACK_MIN_SPEED (a hover, a calm), smoothed over TRACK_SMOOTHING_SECONDS. advance is true on a
   * director tick only, so API calls between ticks never move the smoothing (the log stays a pure
   * function of the seed and the path). Without a velocity (the labs' scripted paths) the track is
   * the heading itself, unsmoothed, exactly as before the ground track existed.
   */
  function updateTrack(current, advance) {
    const velocity = current.velocity;
    const vx = velocity && Number.isFinite(velocity.x) ? velocity.x : 0;
    const vz = velocity && Number.isFinite(velocity.z) ? velocity.z : 0;
    const groundSpeed = Math.hypot(vx, vz);
    player.groundSpeed = velocity ? groundSpeed : player.speed;
    let targetX;
    let targetZ;
    if (velocity && groundSpeed >= TRACK_MIN_SPEED) {
      targetX = vx / groundSpeed;
      targetZ = vz / groundSpeed;
    } else {
      const radians = (player.heading * Math.PI) / 180;
      targetX = Math.sin(radians);
      targetZ = -Math.cos(radians);
    }
    if (!trackDirection.ready || !velocity) {
      trackDirection.x = targetX;
      trackDirection.z = targetZ;
      trackDirection.ready = true;
    } else if (advance) {
      trackDirection.x += (targetX - trackDirection.x) * TRACK_BLEND;
      trackDirection.z += (targetZ - trackDirection.z) * TRACK_BLEND;
      const length = Math.hypot(trackDirection.x, trackDirection.z);
      // A full reversal inside one tick passes through zero: keep the new direction then.
      if (length < 1e-6) {
        trackDirection.x = targetX;
        trackDirection.z = targetZ;
      } else {
        trackDirection.x /= length;
        trackDirection.z /= length;
      }
    }
    const degrees = (Math.atan2(trackDirection.x, -trackDirection.z) * 180) / Math.PI;
    player.track = degrees < 0 ? degrees + 360 : degrees;
  }

  function readInputs(advance = false) {
    const current = getPlayer();
    player.x = current.position.x;
    player.y = current.position.y;
    player.z = current.position.z;
    player.heading = current.heading;
    player.speed = current.speed;
    updateTrack(current, advance);
    const sky = getSun();
    sun.elevation = sky.sunElevation;
    sun.dayTime = sky.dayTime;
    sun.days = Number.isFinite(sky.days) ? sky.days : sky.dayTime;
    headroomMissing = perf && typeof perf.getHeadroom === 'function' ? perf.getHeadroom().missing === true : false;
    if (advance) updateCraftWeights();
  }

  /**
   * The craft weighting (contract i.2): weights[] holds craftWeight for every preset, recomputed only
   * when the craft, its profile or the altitude band changes (a quiet tick allocates nothing).
   */
  function updateCraftWeights() {
    const id = typeof getCraft === 'function' ? String(getCraft() ?? '') : '';
    const profile = id ? lookupProfile(id) ?? null : null;
    const band = bandLevel(profile, player.y);
    if (id === craftState.id && profile === craftState.profile && band === craftState.band) return;
    craftState.id = id;
    craftState.profile = profile;
    craftState.band = band;
    for (let index = 0; index < infos.length; index++) weights[index] = craftWeight(infos[index].preset, profile, player.y);
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

  /**
   * filters.near: the nearest Phase 1 landmark of the preset's types within its radius of the seeded
   * point, as { x, z }, or null. Cached by the candidate's hash (landmarks never move).
   */
  function nearLandmark(info, record) {
    if (nearCache.has(record.hash)) return nearCache.get(record.hash);
    if (nearCache.size >= SURFACE_CACHE_LIMIT) nearCache.clear();
    let best = null;
    if (typeof terrain.landmarkSitesNear === 'function') {
      let bestDistance = Infinity;
      const sites = terrain.landmarkSitesNear(record.x, record.z, info.near.radius);
      for (let index = 0; index < sites.length; index++) {
        const site = sites[index];
        if (!info.near.landmarks.includes(site.type)) continue;
        const distance = Math.hypot(site.x - record.x, site.z - record.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x: site.x, z: site.z };
        }
      }
    }
    nearCache.set(record.hash, best);
    return best;
  }

  /** The preset's environment filters at the candidate: time of day, altitude, weather, surface, biome, near. */
  function environmentRejection(info, record) {
    const filters = info.filters;
    if (info.near && nearCache.get(record.hash) === null) return REJECT.near;
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
      // Combo members waiting for their delay hold their share (reserved.engines).
      if ((used.instances || 0) + (reserved.engines[name] || 0) + 1 > cap.instances) return true;
      if (cap.particles > 0 && (used.particles || 0) >= cap.particles * PARTICLE_HEADROOM) return true;
    }
    return false;
  }

  /** The director's own rules for a candidate that passed its environment filters. */
  function directorRejection(info, record) {
    if (time < cooldownUntil[info.index]) return REJECT.cooldown;
    if (info.index === lastPresetIndex) return REJECT.repeat;
    if (info.combo) {
      const rule = comboBudgetRejection(info);
      if (rule) return rule;
    } else {
      // An exclusive combo keeps every other legendary out while it runs (contract i.3).
      if (info.tier === LEGENDARY_TIER && exclusiveLive > 0) return REJECT.exclusive;
      if (info.heavy) {
        if (heavyActive + reserved.heavy >= budgets.maxHeavy) return REJECT.heavyBudget;
        if (shedLevel >= 1 || headroomMissing) return REJECT.deferred;
      }
      if (engineAtCap(info)) return REJECT.engineBudget;
      if (info.usesLights && lightsActive + (reserved.lights + 1) * LIGHTS_PER_SPAWN > budgets.maxRealLights) return REJECT.lightBudget;
    }
    if (record.offAxis > MAX_OFF_AXIS_WIDE || record.distance < info.band.min || record.distance > info.band.max) return REJECT.notAhead;
    return info.candidateKind === 'event' ? managerRejection(info) : '';
  }

  // ---- Combos (contract i.3) -------------------------------------------------------------------------
  /** Whether a site of one of the presets in siteIds has a live active state within radius of (x, z). */
  function siteActiveNear(siteIds, x, z, radius) {
    for (let index = 0; index < activations.length; index++) {
      const record = activations[index];
      if (record.siteId === null || !siteIds.includes(record.info.id)) continue;
      const instance = spawnManager.getInstance(record.id);
      const anchor = instance ? instance.anchor || instance.position : null;
      if (anchor && Math.hypot(anchor.x - x, anchor.z - z) <= radius) return true;
    }
    return false;
  }

  /** The combo's preconditions at the candidate (contract i.3): '' when all hold. */
  function comboRejection(info, record) {
    const combo = info.combo;
    const preconditions = combo.preconditions;
    if (combo.near && comboNearCache.get(record.hash) === null) return REJECT.precondition;
    if (preconditions.timeOfDay && !matchesTimeOfDay(preconditions.timeOfDay, sun.elevation, sun.dayTime)) return REJECT.precondition;
    if (preconditions.weather && !preconditions.weather.includes(weather.stateAt(record.x, record.z, time))) return REJECT.precondition;
    if (preconditions.biomes && !preconditions.biomes.includes(groundOf(record).biome)) return REJECT.precondition;
    if (preconditions.siteActive && !siteActiveNear(preconditions.siteActive, record.x, record.z, combo.siteRadius)) return REJECT.precondition;
    return '';
  }

  /**
   * Whether the budgets admit every member of a combo at once: its heavy slots, each engine's instances
   * (and particle headroom), the real lights, the load shedder, and exclusivity both ways.
   */
  function comboBudgetRejection(info) {
    const combo = info.combo;
    if (exclusiveLive > 0 || (combo.exclusive && legendaryLive > 0)) return REJECT.exclusive;
    if (combo.heavySlots > 0) {
      if (heavyActive + reserved.heavy + combo.heavySlots > budgets.maxHeavy) return REJECT.comboBudget;
      if (shedLevel >= 1 || headroomMissing) return REJECT.deferred;
    }
    const perEngine = engineStats && engineStats.engines ? engineStats.engines : null;
    for (let index = 0; index < combo.engineNames.length; index++) {
      const name = combo.engineNames[index];
      const cap = budgets.engines[name];
      if (!cap) continue;
      const used = perEngine && perEngine[name] ? perEngine[name] : null;
      const instances = used ? used.instances || 0 : 0;
      if (instances + (reserved.engines[name] || 0) + combo.engineNeeds[name] > cap.instances) return REJECT.comboBudget;
      if (used && cap.particles > 0 && (used.particles || 0) >= cap.particles * PARTICLE_HEADROOM) return REJECT.comboBudget;
    }
    if (combo.lights > 0 && lightsActive + (reserved.lights + combo.lights) * LIGHTS_PER_SPAWN > budgets.maxRealLights) return REJECT.comboBudget;
    return '';
  }

  /**
   * A combo's near precondition: the nearest landmark of its types within radius of the candidate (or,
   * with only sites named, the nearest such site), as { x, z }, or null when one of the named kinds has
   * nothing in reach. Cached by the candidate's hash (landmarks and sites never move).
   */
  function comboNearPoint(info, record) {
    if (comboNearCache.has(record.hash)) return comboNearCache.get(record.hash);
    if (comboNearCache.size >= SURFACE_CACHE_LIMIT) comboNearCache.clear();
    const near = info.combo.near;
    let landmark = null;
    let site = null;
    if (Array.isArray(near.landmarks)) {
      let bestDistance = Infinity;
      const found = typeof terrain.landmarkSitesNear === 'function' ? terrain.landmarkSitesNear(record.x, record.z, near.radius) : [];
      for (let index = 0; index < found.length; index++) {
        const entry = found[index];
        if (!near.landmarks.includes(entry.type)) continue;
        const distance = Math.hypot(entry.x - record.x, entry.z - record.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          landmark = entry;
        }
      }
    }
    if (Array.isArray(near.sites)) {
      let bestDistance = Infinity;
      const found = placement ? placement.sitesNear(record.x, record.z, near.radius) : [];
      for (let index = 0; index < found.length; index++) {
        const entry = found[index];
        if (!near.sites.includes(entry.presetId)) continue;
        const distance = Math.hypot(entry.x - record.x, entry.z - record.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          site = entry;
        }
      }
    }
    const missing = (Array.isArray(near.landmarks) && landmark === null) || (Array.isArray(near.sites) && site === null);
    const anchor = missing ? null : landmark || site;
    const point = anchor ? { x: anchor.x, z: anchor.z } : null;
    comboNearCache.set(record.hash, point);
    return point;
  }

  /** A log entry copy (a combo's member list copied too). */
  function copyEntry(entry) {
    const copy = { ...entry };
    if (entry.members) copy.members = entry.members.slice();
    return copy;
  }

  /** The presets the current craft favours or disfavours, with their weights (getState). */
  function favouredPresets() {
    const favoured = {};
    for (let index = 0; index < infos.length; index++) if (weights[index] !== 1) favoured[infos[index].id] = Math.round(weights[index] * 100) / 100;
    return favoured;
  }

  /** Whether a spawn id is still one of the director's live activations. */
  function isLive(id) {
    for (let index = 0; index < activations.length; index++) if (activations[index].id === id) return true;
    return false;
  }

  /** Live legendary spawns and exclusive combos, for the exclusivity rule (once per tick). */
  function countLegendaries() {
    legendaryLive = 0;
    for (let index = 0; index < activations.length; index++) {
      const record = activations[index];
      if (!record.comboMember && record.info.tier === LEGENDARY_TIER) legendaryLive++;
    }
    exclusiveLive = 0;
    for (let index = 0; index < combos.length; index++) if (combos[index].exclusive) exclusiveLive++;
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
      const info = infos[record.presetIndex];
      if (record.siteIndex >= 0) continue;
      // filters.near moves a candidate onto its landmark; a combo's near precondition onto its
      // landmark or site (contract i.3).
      const point = info.near ? nearLandmark(info, record) : info.combo && info.combo.near ? comboNearPoint(info, record) : null;
      if (point) {
        record.x = point.x;
        record.z = point.z;
        record.distance = Math.hypot(point.x - player.x, point.z - player.z);
      }
    }
    for (let index = 0; index < pool.count; index++) {
      const record = pool.records[index];
      record.bearing = bearingDegrees(player.x, player.z, record.x, record.z);
      record.offAxis = angleBetween(record.bearing, player.track);
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
      const environment = environmentRejection(info, record) || (info.combo ? comboRejection(info, record) : '');
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
   * bounds the angle off the ground track, and drought fills also keep to DROUGHT_BAND. Due tiers
   * outrank the rest, rarer due tiers first, then the ahead score times the craft weight decides (at
   * most CRAFT_WEIGHT_RANGE.max, below the 10 a due tier adds), with the candidate's own roll as a
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
      record.rank = (due ? 10 + info.tier : 0) + record.score * weights[info.index] + (1 - record.roll) * 0.01;
      if (best === null || compareRanked(record, best) < 0) best = record;
    }
    return best;
  }

  // ---- Activation -----------------------------------------------------------------------------------
  /**
   * Appends an activation to the log and its running hash. Every entry records the flying craft
   * (contract i.2); combo entries add the combo id, and a combo's own entry its member ids in order.
   */
  function appendLog(entry) {
    entry.craft = craftState.id;
    log.push(entry);
    if (log.length > LOG_LIMIT) log.shift();
    logTotal++;
    let line = `${entry.time}|${entry.presetId}|${entry.candidateId}|${entry.reason}|${entry.craft}`;
    if (entry.combo) line += `|${entry.combo}`;
    if (entry.members) line += `|${entry.members.join(',')}`;
    line += ';';
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

  /**
   * Records a live spawn the director started. A combo member (comboMember) spends its preset's
   * cooldown but neither the rarity schedule nor the no-repeat rule: it rides on its combo's turn.
   */
  function track(id, info, source, { candidate, siteId, duration, siteActive = false, combo = null, comboMember = false }) {
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
      combo,
      comboMember,
    };
    activations.push(record);
    if (combo) combo.live++;
    cooldownUntil[info.index] = time + info.cooldown;
    if (info.heavy) heavyActive++;
    if (comboMember) return record;
    lastPresetIndex = info.index;
    tierDue[info.tier] = time + drawPeriod(info.tier);
    tierActivations[info.tier]++;
    return record;
  }

  function activateCandidate(record, reason) {
    const info = infos[record.presetIndex];
    if (info.combo) return activateCombo(info, record, reason);
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

  // ---- Combo activation (contract i.3) ------------------------------------------------------------------
  /** A combo candidate passed every rule: start the combo and its members. */
  function activateCombo(info, record, reason) {
    const bucketEnd = (record.bucket + 1) * info.settings.bucketSeconds;
    const label = candidateId(record, info.id);
    const started = startCombo(info, {
      x: record.x, z: record.z, heading: record.heading, hash: record.hash, label, reason, source: 'director', forced: false,
    });
    if (!started) {
      refusedUntil.set(record.hash, bucketEnd);
      return false;
    }
    usedUntil.set(record.hash, bucketEnd);
    markNotable('event', time);
    if (reason === 'drought') droughtFills++;
    return true;
  }

  /**
   * Starts a combo: its own preset at the anchor point (source as given, the combo id as parent), then
   * every member, each placed by memberPosition and started now or after its delay (the budget share
   * of a waiting member stays reserved). Logs the combo with its members in order, emits comboStarted
   * and returns the combo record, or null when the manager refused the combo's own spawn.
   */
  function startCombo(info, { x, z, heading, hash, label, reason, source, forced }) {
    const comboId = `combo:${label}`;
    const duration = durationFor(info, hash);
    const id = spawnManager.activate(info.id, {
      position: { x, y: groundY(x, z), z }, heading, source, seed: hash, duration, parent: comboId, ...(forced ? { force: true } : {}),
    });
    if (id === null || id === undefined) return null;
    // A combo whose own preset seeks its ground (anchor.seek: a migration's valley) places its members
    // around the point the SpawnManager moved it to, so they all meet there.
    if (info.preset.anchor && info.preset.anchor.seek) {
      const placed = spawnManager.getInstance(id);
      const anchor = placed ? placed.anchor || placed.position : null;
      if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.z)) {
        x = anchor.x;
        z = anchor.z;
      }
    }
    const combo = {
      id: comboId,
      info,
      presetId: info.id,
      mainId: id,
      hash,
      x,
      z,
      viewX: player.x,
      viewZ: player.z,
      heading,
      source,
      forced,
      exclusive: info.combo.exclusive,
      live: 0,
      pending: [],
      startedAt: time,
    };
    combos.push(combo);
    track(id, info, source, { candidate: label, siteId: null, duration, combo });
    appendLog({ time, presetId: info.id, candidateId: label, reason, combo: comboId, members: info.combo.memberIds });
    if (bus && typeof bus.emitTyped === 'function') bus.emitTyped('comboStarted', { id: comboId, presetId: info.id, members: info.combo.memberIds.slice() });
    const members = info.combo.members;
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      if (member.delay > 0 || !startMember(combo, index)) {
        combo.pending.push({ index, at: time + member.delay, nextTry: time + member.delay });
        reserveMember(member.info, 1);
      }
    }
    countLegendaries();
    return combo;
  }

  /** Holds (sign 1) or releases (-1) a waiting member's budget share. */
  function reserveMember(info, sign) {
    if (info.heavy) reserved.heavy += sign;
    if (info.usesLights) reserved.lights += sign;
    for (let index = 0; index < info.engines.length; index++) {
      const name = info.engines[index];
      if (name in reserved.engines) reserved.engines[name] += sign;
    }
  }

  /**
   * Where member `index` of a combo stands: the anchor (role 'anchor', or no place) at the combo's
   * point; any other member place.distance metres from it on place.bearing, measured from the line
   * of sight (0 is straight beyond the anchor as seen from where the player was when the combo
   * started, 90 to its right), moved by up to place.jitter metres. The jitter comes from
   * hash(seedHash, combo candidate, member index): the candidate's hash already holds the seed.
   */
  function memberPosition(combo, index, out) {
    const member = combo.info.combo.members[index];
    out.x = combo.x;
    out.z = combo.z;
    if (member.role === 'anchor' || !member.place) return out;
    const view = combo.viewX === combo.x && combo.viewZ === combo.z ? combo.heading : bearingDegrees(combo.viewX, combo.viewZ, combo.x, combo.z);
    const radians = ((view + member.place.bearing) * Math.PI) / 180;
    out.x += Math.sin(radians) * member.place.distance;
    out.z -= Math.cos(radians) * member.place.distance;
    const jitter = Number.isFinite(member.place.jitter) ? member.place.jitter : 0;
    if (jitter > 0) {
      const memberHash = rehash(combo.hash, COMBO_MEMBER_SALT + index);
      const radius = jitter * Math.sqrt(unitFromHash(memberHash));
      const angle = unitFromHash(rehash(memberHash, 1)) * Math.PI * 2;
      out.x += Math.sin(angle) * radius;
      out.z -= Math.cos(angle) * radius;
    }
    return out;
  }

  /** Starts member `index` of a combo now. Returns whether the manager took it. */
  function startMember(combo, index) {
    const member = combo.info.combo.members[index];
    const memberInfo = member.info;
    memberPosition(combo, index, memberPoint);
    const seed = rehash(combo.hash, COMBO_MEMBER_SALT + 101 + index);
    const duration = durationFor(memberInfo, seed);
    const id = spawnManager.activate(memberInfo.id, {
      position: { x: memberPoint.x, y: groundY(memberPoint.x, memberPoint.z), z: memberPoint.z },
      heading: combo.heading,
      source: combo.source,
      seed,
      duration,
      parent: combo.id,
      ...(combo.forced ? { force: true } : {}),
    });
    if (id === null || id === undefined) return false;
    const label = `${combo.id}#${index}`;
    track(id, memberInfo, combo.source, { candidate: label, siteId: null, duration, combo, comboMember: true });
    appendLog({ time, presetId: memberInfo.id, candidateId: label, reason: 'comboMember', combo: combo.id });
    return true;
  }

  /**
   * Once per tick: waiting members start when their delay is up (a refusal retries every
   * COMBO_MEMBER_RETRY s, for up to COMBO_MEMBER_PATIENCE s, then the member is dropped and logged);
   * a combo whose own spawn has ended drops its waiting members; a combo with nothing live and nothing
   * waiting is over.
   */
  function processCombos() {
    for (let comboIndex = combos.length - 1; comboIndex >= 0; comboIndex--) {
      const combo = combos[comboIndex];
      const mainAlive = isLive(combo.mainId);
      for (let index = combo.pending.length - 1; index >= 0; index--) {
        const entry = combo.pending[index];
        if (mainAlive && time < entry.nextTry) continue;
        const member = combo.info.combo.members[entry.index];
        let done = false;
        if (mainAlive && startMember(combo, entry.index)) {
          done = true;
        } else if (!mainAlive || time >= entry.at + COMBO_MEMBER_PATIENCE) {
          done = true;
          appendLog({ time, presetId: member.info.id, candidateId: `${combo.id}#${entry.index}`, reason: 'comboMemberDropped', combo: combo.id });
        }
        if (done) {
          reserveMember(member.info, -1);
          combo.pending.splice(index, 1);
        } else {
          entry.nextTry = time + COMBO_MEMBER_RETRY;
        }
      }
      if (combo.live <= 0 && combo.pending.length === 0) combos.splice(comboIndex, 1);
    }
  }

  // ---- Global overrides (contract i.4) --------------------------------------------------------------
  /**
   * Once per tick: the override schedule at the player (src/spawns/overrides.js). globalOverride fires
   * when an override starts, ends, and when its weight crosses 0.5; the overrideSink gets every entry;
   * from half weight the override's own preset is started once per night (its discovery and journal
   * entry) and it is ended with the override.
   */
  function updateOverrides() {
    if (overrides.entries.length === 0) return;
    const entries = overrides.update(sun.days, sun.dayTime, player.x, player.z);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const status = overrideStatus[index];
      const active = entry.weight > 0;
      const high = entry.weight >= 0.5;
      if (active !== status.active || (active && high !== status.high)) {
        if (active && !status.active) appendLog({ time, presetId: entry.presetId, candidateId: `${entry.id}@${entry.night}`, reason: 'override' });
        if (bus && typeof bus.emitTyped === 'function') bus.emitTyped('globalOverride', { id: entry.id, kind: entry.kind, active, weight: entry.weight });
      }
      status.active = active;
      status.high = high;
      if (overrideSink && typeof overrideSink.apply === 'function') overrideSink.apply(entry);
      overrideSpawn(entry, status);
    }
  }

  /** Starts an override's preset once per night from half weight; ends it when the override ends. */
  function overrideSpawn(entry, status) {
    if (status.spawnId !== null) {
      const instance = spawnManager.getInstance(status.spawnId);
      if (!instance || instance.ended === true) {
        status.spawnId = null;
      } else if (!status.active) {
        spawnManager.deactivate(status.spawnId, 'override');
        status.spawnId = null;
      }
      return;
    }
    if (!status.high || status.spawnedNight === entry.night || time < status.retryAt) return;
    const info = infoById.get(entry.presetId);
    const radians = (player.track * Math.PI) / 180;
    const x = player.x + Math.sin(radians) * OVERRIDE_SPAWN_DISTANCE;
    const z = player.z - Math.cos(radians) * OVERRIDE_SPAWN_DISTANCE;
    const seed = rehash(baseHash, hashString(entry.id) ^ Math.imul(entry.night | 0, 0x27d4eb2d));
    const id = spawnManager.activate(info.id, { position: { x, y: groundY(x, z), z }, heading: player.track, source: 'director', seed, duration: durationFor(info, seed) });
    if (id === null || id === undefined) {
      // Refused (a budget, or engines with nothing to draw here): try again a little later.
      status.retryAt = time + OVERRIDE_SPAWN_RETRY;
      return;
    }
    status.spawnId = id;
    status.spawnedNight = entry.night;
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
    const combo = activations[index].combo;
    if (combo) combo.live--;
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
    readInputs(true);
    refreshBudgets();
    pollActivations();
    processCombos();
    countLegendaries();
    updateOverrides();
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
        log: log.slice(-50).map(copyEntry),
        logLength: logTotal,
        logHash: logHash.toString(16).padStart(8, '0'),
        track: Math.round(player.track),
        groundSpeed: Math.round(player.groundSpeed * 10) / 10,
        craft: craftState.id,
        craftWeights: favouredPresets(),
        combos: combos.map((combo) => ({
          id: combo.id,
          presetId: combo.presetId,
          exclusive: combo.exclusive,
          live: combo.live,
          pending: combo.pending.map((entry) => combo.info.combo.members[entry.index].info.id),
          age: Math.round(time - combo.startedAt),
        })),
        overrides: overrides.entries.map((entry) => ({
          id: entry.id,
          presetId: entry.presetId,
          kind: entry.kind,
          night: entry.night,
          scheduled: entry.scheduled,
          forced: entry.forcedNight === entry.night,
          weight: Math.round(entry.weight * 1000) / 1000,
          region: Math.round(entry.region * 1000) / 1000,
        })),
      };
    },

    /**
     * The whole activation log (a copy): [{ time, presetId, candidateId, reason, craft, combo?,
     * members? }].
     */
    getLog() {
      return log.map(copyEntry);
    },

    /** The override schedule's entries now (a copy): [{ id, presetId, kind, night, scheduled, weight, region }]. */
    getOverrides() {
      return overrides.entries.map((entry) => ({ id: entry.id, presetId: entry.presetId, kind: entry.kind, night: entry.night, scheduled: entry.scheduled, weight: entry.weight, region: entry.region }));
    },

    /** Whether presetId is one of the director's presets (forceSpawn and scheduling know it). */
    hasPreset(presetId) {
      return infoById.has(presetId);
    },

    /**
     * Dev only: starts a preset ahead of the player through the SpawnManager (source 'debug').
     * options: { distance (m), bearingOffset (deg), force (ignore the manager's budgets), at ({ x, z }:
     * the spot itself instead of a point ahead, as the F9 combo staging uses) }. A combo
     * starts with all its members, its preconditions ignored (contract i.3: how the F9 debugger forces
     * one); the combo id is returned. An override is scheduled on the current night whatever its roll
     * and region (it shows from the evening on); its id is returned.
     */
    forceSpawn(presetId, { distance = 3000, bearingOffset = 0, force = false, at = null } = {}) {
      if (!devHooks) throw new Error('director.forceSpawn is only available in development builds or with ?debug=1');
      const info = infoById.get(presetId);
      if (!info) throw new RangeError(`director.forceSpawn: unknown preset "${presetId}"`);
      readInputs();
      if (info.override) {
        overrides.force(presetId, nightIndex(sun.days));
        return `override:${presetId}`;
      }
      const radians = ((player.track + bearingOffset) * Math.PI) / 180;
      const spot = at && Number.isFinite(at.x) && Number.isFinite(at.z);
      const x = spot ? at.x : player.x + Math.sin(radians) * distance;
      const z = spot ? at.z : player.z - Math.cos(radians) * distance;
      const seed = mix32((baseHash ^ Math.imul(++debugSerial, 0x9e3779b1)) >>> 0);
      if (info.combo) {
        const combo = startCombo(info, { x, z, heading: player.track, hash: seed, label: `debug:${debugSerial}`, reason: 'debug', source: 'debug', forced: force === true });
        if (!combo) return null;
        markNotable('event', time);
        return combo.id;
      }
      const duration = durationFor(info, seed);
      const id = spawnManager.activate(info.id, { position: { x, y: groundY(x, z), z }, heading: player.track, source: 'debug', seed, duration, force: force === true });
      if (id === null || id === undefined) return null;
      const label = `debug:${debugSerial}`;
      track(id, info, 'debug', { candidate: label, siteId: null, duration });
      appendLog({ time, presetId: info.id, candidateId: label, reason: 'debug' });
      markNotable('event', time);
      return id;
    },

    /**
     * Dev only: drops an override forced with forceSpawn, so its night follows its own roll again (a
     * dev check gives the sky back after showing the midnight sun). Returns whether one was forced.
     */
    releaseOverride(presetId) {
      if (!devHooks) throw new Error('director.releaseOverride is only available in development builds or with ?debug=1');
      return overrides.release(presetId);
    },

    /**
     * Dev only: starts the active state of a live site spawn now (an erupting volcano), tracked like
     * the director's own: it ends after its seeded activeState duration, and a combo's siteActive
     * precondition sees it. Used by the F9 combo staging (the volcano under the aurora). Returns the
     * site's spawn id, or null when the site has no live spawn or its preset no active state.
     */
    forceSiteActive(siteId) {
      if (!devHooks) throw new Error('director.forceSiteActive is only available in development builds or with ?debug=1');
      if (!siteSpawnApi) return null;
      const spawnId = spawnManager.getSiteSpawn(siteId);
      if (!spawnId) return null;
      if (isLive(spawnId)) return spawnId;
      const instance = spawnManager.getInstance(spawnId);
      const info = instance ? siteActiveInfos.get(instance.presetId) : null;
      if (!info) return null;
      if (spawnManager.setSiteActive(spawnId, true) === false) return null;
      readInputs();
      const seed = mix32((baseHash ^ Math.imul(++debugSerial, 0x9e3779b1)) >>> 0);
      const duration = durationFor(info, seed);
      const label = `debug:${debugSerial}`;
      track(spawnId, info, 'debug', { candidate: label, siteId, duration, siteActive: true });
      appendLog({ time, presetId: info.id, candidateId: label, reason: 'debug' });
      markNotable('event', time);
      return spawnId;
    },

    /** The director's load shedder (registered with perf when one was given). */
    shedder,

    /**
     * Stops the director: unsubscribes, unregisters the shedder (perf drops its levels without a
     * restore, so the manager's LOD bias is put back here) and ends the spawns it started.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribers) if (typeof unsubscribe === 'function') unsubscribe();
      if (shedderHandle) shedderHandle.remove();
      if (shedLevel !== 0) {
        shedLevel = 0;
        applyLodBias();
      }
      for (const record of activations) endActivation(record, 'dispose');
      activations.length = 0;
      combos.length = 0;
      for (const status of overrideStatus) {
        if (status.spawnId !== null) spawnManager.deactivate(status.spawnId, 'dispose');
        status.spawnId = null;
      }
      if (overrideSink && typeof overrideSink.dispose === 'function') overrideSink.dispose();
    },
  };
}

/**
 * The game's override sink (contract i.4): the blood moon is a sky modifier (the moon reddens and the
 * night darkens), the midnight sun a sun override that bends the sun's path through applyMidnightSun,
 * each eased by the override's weight. sky is the sky system (addModifier, addSunOverride). Handles
 * are made on an override's first non-zero weight and kept until dispose(); a tick reuses them.
 */
export function createSkyOverrideSink(sky) {
  const handles = new Map();
  const weightValues = { weight: 0 };

  function create(entry) {
    if (entry.kind === 'bloodMoon') {
      const modifier = sky.addModifier(entry.id, { priority: 5 });
      modifier.set({ ...BLOOD_MOON_SKY, weight: 0 });
      return { modifier, sun: null };
    }
    return { modifier: null, sun: sky.addSunOverride(entry.id, { apply: applyMidnightSun }) };
  }

  return {
    apply(entry) {
      let handle = handles.get(entry.id);
      if (!handle) {
        if (!(entry.weight > 0)) return;
        handle = create(entry);
        handles.set(entry.id, handle);
      }
      if (handle.modifier) {
        weightValues.weight = entry.weight;
        handle.modifier.set(weightValues);
      } else {
        handle.sun.setWeight(entry.weight);
      }
    },
    dispose() {
      for (const handle of handles.values()) {
        if (handle.modifier) handle.modifier.remove();
        if (handle.sun) handle.sun.remove();
      }
      handles.clear();
    },
  };
}

/**
 * The director wired to the running game, for the spawns system to create once its SpawnManager
 * exists and to update every frame: the flight clock, the player, the sun, the camera frustum, the
 * regional weather system, the world's height and biome functions, the perf governor, the bus, the
 * flying craft and its module's directorProfile, and the sky (the overrides' sink).
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
  // The camera matrices are in the render frame (src/core/origin.js): world points move into it.
  const origin = ctx.origin ?? null;
  let frustumFrame = -1;
  const sky = ctx.systems.sky ?? null;
  const overrideSink = sky && typeof sky.addModifier === 'function' && typeof sky.addSunOverride === 'function' ? createSkyOverrideSink(sky) : null;
  const flight = ctx.systems.flight ?? null;
  return createDirector({
    seedHash: world.seedHash >>> 0,
    presets,
    spawnManager,
    weather: weather.model,
    terrain: {
      heightAt: world.heightAt,
      biomeAt: world.biomeAt,
      waterLevel: CONFIG.WATER_LEVEL,
      landmarkSitesNear: world.landmarkSitesNear,
      biomeKeys: Array.isArray(world.BIOMES) ? world.BIOMES.map((biome) => biome.key) : null,
    },
    // The craft flying now (the controller's, which may still be refusing a settings change).
    getCraft: () => (flight && typeof flight.getCraft === 'function' ? flight.getCraft() : ctx.settings.get('craft')),
    profileFor: (craftId) => (ctx.craftRegistry && ctx.craftRegistry.get(craftId)?.directorProfile) ?? DEFAULT_DIRECTOR_PROFILES[craftId] ?? null,
    overrideSink,
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
      if (origin) origin.toRender(sphere.center, sphere.center);
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
