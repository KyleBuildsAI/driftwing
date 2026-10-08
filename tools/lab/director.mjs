// Director lab: runs the event director (src/spawns/director.js) headless, with the regional weather
// model (src/spawns/weather.js) and the real perf governor (src/core/perf.js), against stub presets,
// a stub SpawnManager and stub sites, over simulated flight paths: hours of flight in seconds of wall
// time. The world is the real deterministic world generator, so the surface and biome filters see
// real terrain.
//
// Checks:
//   pacing        from a start with nothing in sight, the first notable comes 60-90 s into the flight
//                 (every seed and speed); the drought fill ends droughts inside the 90 s window, with
//                 no sites at all (events only) and in a typical world with sites (the share and the
//                 longest drought are printed: the rest is content-limited, see EMPTY_WORLD_SHARE)
//   rarity        mean interval between activations per rarity tier over a long flight, against the
//                 targets: common every few minutes (2-5 min), uncommon 10-15 min, rare 30-60 min,
//                 legendary 1-2 h
//   ahead         scheduled activations lie within 45 degrees of the heading, long-drought fills
//                 within 60, all inside the preset's distance band, drought fills 3-8 km out.
//                 Nothing starts behind
//   cooldowns     per-preset cooldowns hold and the same preset never runs twice in a row
//   budgets       never more than 2 heavy spawns, per-engine caps held, the director never pushes
//                 the manager past the heavy budget, and budget refusals stay rare
//   lifetimes     every event ends (naturally, at its lifetime, or by the despawn rule), no event
//                 outlives its duration plus the grace, and despawns only happen out of range and out
//                 of view (a bush plane, a jet that leaves events behind, and engines that never end)
//   framework     the same guarantees against a manager shaped like the p2/framework SpawnManager
//                 (described records, canActivate, getSiteSpawn / setSiteActive, 'spawns:inView')
//   deferral      while the perf headroom reports missed frames no heavy spawn starts
//   weather       the state distribution, the cycle order, clear openings, smooth levels, and the
//                 share of normal sessions (20 and 30 min at glider, bush plane and jet speed) that
//                 meet a storm and all four states
//   determinism   two identical runs give identical activation logs; another path gives another log
//   shedding      under load the director sheds all its levels before the render scale steps down,
//                 and gets them back only after the scale is back at 1; with no shedder the governor
//                 steps exactly as the Phase 1 governor (tag v2-structure) does
//   api           getNearby is sorted and well formed; getState carries the debugger's fields
//   near          filters.near: every activation of a preset gathered at landmarks lies exactly on a
//                 Phase 1 landmark of its types (the real world generator's landmarkSitesNear), still
//                 ahead and inside its distance band; without landmarkSitesNear it never activates
//   track         (Phase 3, contract i.1) a craft drifting east with its nose north gets its content
//                 within 60 degrees of the drift line; a hover keeps the nose; a turn of the track eases
//                 over about a second
//   craft         (i.2) craftWeight's favour, above bands and clamp; seaplane, eagle, balloon and a high
//                 spaceplane each raise the mean weight of what starts on the same path, every log entry
//                 records the craft, and a module's own directorProfile replaces the default
//   combos        (i.3) dev fixtures: combos start with their preconditions holding (night and biome, a
//                 monolith circle, an erupting volcano), members on their ring and delay with the combo
//                 as parent, the log and comboStarted list them in order, budgets and exclusivity hold,
//                 the logs are deterministic, and forceSpawn starts one by day
//   overrides     (i.4) the night index and window, the per-night schedule, the midnight sun's bend, the
//                 regional blend on the real world, and the director's wiring (never candidates, the
//                 scheduled nights exactly, the sink, the once-a-night spawn, forceSpawn)
//   schema        the validator accepts a full combo and override and refuses broken blocks
//
// Usage: node tools/lab/director.mjs [--hours 24] [--verbose] [--presets stub|real]
// --presets real runs the pacing checks against the game's own presets (src/spawns/presets/index.js)
// instead of the stubs: the first notable, the drought fill with no sites (events only), a typical
// world whose sites come from the real placement, and a per-preset activation report per speed. The
// other groups test the director's rules and need the stubs' full Phase 2 list, so they are skipped.
// Prints a table and exits non-zero if any check fails.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG, WORLD_OPTIONS } from '../../src/core/config.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createPerfGovernor } from '../../src/core/perf.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { PRESETS as GAME_PRESETS } from '../../src/spawns/presets/index.js';
import {
  COMBO_MEMBER_PATIENCE, CRAFT_WEIGHT_RANGE, DEFAULT_DIRECTOR_PROFILES, DIRECTOR_BUDGETS, DROUGHT_BAND, MAX_OFF_AXIS, MAX_OFF_AXIS_WIDE,
  PACING_WINDOW_MAX, RARITY_COOLDOWNS, RARITY_TIERS, craftWeight, createDirector, matchesTimeOfDay,
} from '../../src/spawns/director.js';
import {
  MIDNIGHT_SUN_SKIM, applyMidnightSun, createRegionField, nightIndex, nightWindow, scheduledNights,
} from '../../src/spawns/overrides.js';
import { validatePresets } from '../../src/spawns/schema.js';
import { angleBetween, bearingDegrees, hashString, mix32, rehash, unitFromHash } from '../../src/spawns/candidates.js';
import {
  WEATHER_BUCKET_SECONDS, WEATHER_CYCLE_BUCKETS, WEATHER_REGION_SIZE, WEATHER_STATES, createWeatherModel, createWeatherSample,
} from '../../src/spawns/weather.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { hours: 24, verbose: false, presets: 'stub' };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--verbose') options.verbose = true;
    else if (flag === '--hours') options.hours = Number(argv[++index]);
    else if (flag === '--presets') options.presets = argv[++index];
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!['stub', 'real'].includes(options.presets)) throw new Error('--presets must be stub or real');
  if (!(options.hours >= 4)) throw new Error('--hours must be at least 4 (the legendary tier needs hours of flight)');
  return options;
}
const OPTIONS = parseArgs(process.argv);

const results = [];
function check(group, name, pass, detail = '') {
  results.push({ group, name, pass: Boolean(pass), detail });
}
function verbose(line) {
  if (OPTIONS.verbose) process.stdout.write(`${line}\n`);
}

// ============================================================================================
// STUB PRESETS: the director-facing fields of the Phase 2 presets (pure data, contract section 1)
// ============================================================================================
const DESPAWN = Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 });
const CANDIDATES_BY_RARITY = Object.freeze({
  common: { cellSize: 4000, bucketSeconds: 300, chance: 0.35 },
  uncommon: { cellSize: 6000, bucketSeconds: 450, chance: 0.3 },
  rare: { cellSize: 8000, bucketSeconds: 600, chance: 0.35 },
  legendary: { cellSize: 10000, bucketSeconds: 900, chance: 0.5 },
});

function eventPreset(id, category, rarity, { heavy = false, engines = ['emitter'], filters = {}, candidates = null, duration = [120, 240], tags = [] } = {}) {
  return Object.freeze({
    id,
    name: id,
    category,
    kind: 'event',
    rarity,
    heavy,
    tags,
    candidates: candidates || CANDIDATES_BY_RARITY[rarity],
    filters: { minDistance: 3000, maxDistance: 8000, ...filters },
    engines: engines.map((engine) => ({ engine, params: {} })),
    lifetime: { duration, despawn: DESPAWN },
  });
}
function sitePreset(id, category, rarity, { heavy = false, activeState = null, engines = ['structure'], tags = [] } = {}) {
  return Object.freeze({
    id,
    name: id,
    category,
    kind: 'site',
    rarity,
    heavy,
    tags,
    activeState,
    filters: activeState ? { minDistance: 3000, maxDistance: 20000 } : {},
    engines: engines.map((engine) => ({ engine, params: {} })),
    lifetime: { duration: null, despawn: { distance: 20000, hysteresis: 3000, outOfViewSeconds: 20 } },
  });
}

const STUB_PRESETS = Object.freeze([
  eventPreset('tornado', 'weather', 'rare', { heavy: true, engines: ['vortex', 'emitter', 'windModifier'], filters: { weather: ['storm'], surface: 'land' }, duration: [240, 360], tags: ['spectacle', 'farLure'] }),
  eventPreset('supercell', 'weather', 'uncommon', { heavy: true, engines: ['weatherVolume', 'lightEffect', 'windModifier'], filters: { weather: ['building', 'storm'], minDistance: 6000, maxDistance: 20000 }, candidates: { cellSize: 12000, bucketSeconds: 450, chance: 0.5 }, duration: [300, 480], tags: ['spectacle', 'farLure'] }),
  eventPreset('waterspout', 'ocean', 'uncommon', { engines: ['vortex', 'emitter'], filters: { surface: 'water', weather: ['building', 'storm'] }, tags: ['water', 'spectacle'] }),
  eventPreset('lenticular', 'weather', 'common', { engines: ['weatherVolume', 'windModifier'], filters: { biomes: ['snow', 'pine'] }, tags: ['calm', 'slow', 'spectacle', 'snow'] }),
  eventPreset('microburst', 'weather', 'uncommon', { engines: ['weatherVolume', 'windModifier'], filters: { weather: ['building', 'storm'] }, tags: ['challenge'] }),
  eventPreset('glory', 'weather', 'common', { engines: ['celestial'], filters: { timeOfDay: ['day'], altitude: { min: 600 } }, tags: ['calm', 'slow', 'spectacle'] }),
  eventPreset('whalePod', 'ocean', 'common', { engines: ['fauna', 'waterEffect'], filters: { surface: 'coast' }, tags: ['water', 'coast', 'calm', 'slow', 'spectacle'] }),
  eventPreset('murmuration', 'wildlife', 'uncommon', { engines: ['fauna'], filters: { timeOfDay: ['dusk'], biomes: ['meadows', 'pine'] }, tags: ['murmuration', 'calm', 'slow', 'spectacle'] }),
  // The pacing floor: a common event the terrain, weather and hour never rule out, dense enough that
  // a candidate usually waits in the cone ahead (about 2 in the 45 degree cone, 3 in the 60 degree one).
  eventPreset('geese', 'wildlife', 'common', { engines: ['fauna'], candidates: { cellSize: 3500, bucketSeconds: 300, chance: 0.6 }, tags: ['murmuration', 'calm', 'slow'] }),
  eventPreset('hawks', 'wildlife', 'common', { engines: ['fauna'], filters: { timeOfDay: ['day'], surface: 'land' }, tags: ['thermal', 'calm'] }),
  eventPreset('fireflies', 'wildlife', 'common', { engines: ['fauna', 'lightEffect'], filters: { timeOfDay: ['night'], biomes: ['meadows', 'archipelago'], altitude: { max: 1500 } }, tags: ['night', 'calm', 'slow', 'forest'] }),
  eventPreset('eagle', 'wildlife', 'uncommon', { engines: ['fauna'], tags: ['thermal', 'calm'] }),
  eventPreset('meteorShower', 'celestial', 'uncommon', { engines: ['celestial', 'lightEffect'], filters: { timeOfDay: ['night'] }, tags: ['celestial', 'night', 'calm', 'spectacle'] }),
  eventPreset('eclipse', 'celestial', 'legendary', { engines: ['celestial'], filters: { timeOfDay: ['day'] }, duration: [150, 210], tags: ['celestial', 'calm', 'spectacle'] }),
  eventPreset('comet', 'celestial', 'rare', { heavy: true, engines: ['celestial'], filters: { timeOfDay: ['night'] }, duration: [300, 400], tags: ['celestial', 'night', 'farLure', 'spectacle'] }),
  eventPreset('lanterns', 'celestial', 'rare', { engines: ['emitter', 'lightEffect'], filters: { timeOfDay: ['night', 'dusk'] }, tags: ['night', 'calm', 'slow', 'spectacle'] }),
  eventPreset('skyWhale', 'fantasy', 'rare', { heavy: true, engines: ['fauna', 'windModifier'], duration: [240, 360], tags: ['calm', 'slow', 'spectacle', 'farLure'] }),
  eventPreset('jetStream', 'flightplay', 'uncommon', { engines: ['windModifier'], filters: { altitude: { min: 2500 } }, tags: ['challenge'] }),
  eventPreset('stormChase', 'setpiece', 'legendary', { heavy: true, engines: ['setPiece'], filters: { weather: ['building', 'storm'] }, duration: [420, 540], tags: ['spectacle', 'challenge'] }),
  sitePreset('volcano', 'geo', 'rare', { heavy: true, activeState: { duration: [180, 300] }, engines: ['structure', 'emitter'], tags: ['spectacle', 'farLure'] }),
  sitePreset('geyserField', 'geo', 'common', { engines: ['emitter'], tags: ['spectacle', 'water'] }),
  sitePreset('windFarm', 'structure', 'common', { tags: ['slow'] }),
  sitePreset('airfield', 'structure', 'common', { tags: ['calm', 'perch'] }),
  sitePreset('crystalSpires', 'fantasy', 'uncommon', { engines: ['structure', 'lightEffect'], tags: ['perch', 'spectacle'] }),
]);
/** The presets the director runs on: the stubs, or the game's own with --presets real. */
const REAL_MODE = OPTIONS.presets === 'real';
const PRESETS = REAL_MODE ? GAME_PRESETS : STUB_PRESETS;
const PRESET_BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));
/** Sites within this range (m) are instances in the stub manager (beyond it, only lures). */
const SITE_INSTANCE_RANGE = 12000;
/** What a site renders as while the budgets have no room for its engines. */
const BARE_SITE = Object.freeze({ id: 'bareSite', engines: [{ engine: 'structure', params: {} }] });
const SITE_PRESETS = PRESETS.filter((preset) => preset.kind === 'site');

/** Per-engine cost of one instance in the stub (particles, real lights). */
const ENGINE_COST = Object.freeze({
  vortex: { particles: 9000, lights: 0 },
  emitter: { particles: 16000, lights: 0 },
  weatherVolume: { particles: 6000, lights: 0 },
  fauna: { particles: 1500, lights: 0 },
  structure: { particles: 0, lights: 0 },
  celestial: { particles: 2000, lights: 0 },
  waterEffect: { particles: 5000, lights: 0 },
  lightEffect: { particles: 6000, lights: 2 },
  windModifier: { particles: 0, lights: 0 },
  setPiece: { particles: 0, lights: 0 },
});

// ============================================================================================
// STUB WORLD PIECES: sites, the flight path, the sun and the view
// ============================================================================================
/** Deterministic sites on the 2 km grid (the placement contract's sitesNear), with a chance per cell. */
function createStubPlacement(seedHash, siteChance) {
  const cellSize = 2000;
  const cache = new Map();
  function siteInCell(cellX, cellZ) {
    const key = `${cellX}:${cellZ}`;
    if (cache.has(key)) return cache.get(key);
    let site = null;
    const hash = mix32((seedHash ^ Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellZ, 0x165667b1) ^ 0x51e) >>> 0);
    if (unitFromHash(hash) < siteChance) {
      // One site in five is a volcano (the preset with a director-driven active state).
      const pick = unitFromHash(rehash(hash, 1));
      const preset = pick < 0.2 ? PRESET_BY_ID.get('volcano') : SITE_PRESETS[1 + Math.floor(unitFromHash(rehash(hash, 2)) * (SITE_PRESETS.length - 1))];
      const x = (cellX + 0.2 + 0.6 * unitFromHash(rehash(hash, 3))) * cellSize;
      const z = (cellZ + 0.2 + 0.6 * unitFromHash(rehash(hash, 4))) * cellSize;
      site = { id: `${preset.id}:${cellX}:${cellZ}`, presetId: preset.id, x, z, groundY: 200, rotation: unitFromHash(rehash(hash, 5)) * Math.PI * 2, scale: 1, seed: hash, stamps: [] };
    }
    cache.set(key, site);
    return site;
  }
  return {
    sitesNear(x, z, radius) {
      const sites = [];
      if (siteChance <= 0) return sites;
      for (let cellZ = Math.floor((z - radius) / cellSize); cellZ <= Math.floor((z + radius) / cellSize); cellZ++) {
        for (let cellX = Math.floor((x - radius) / cellSize); cellX <= Math.floor((x + radius) / cellSize); cellX++) {
          const site = siteInCell(cellX, cellZ);
          if (site && Math.hypot(site.x - x, site.z - z) <= radius) sites.push(site);
        }
      }
      return sites.sort((first, second) => Math.hypot(first.x - x, first.z - z) - Math.hypot(second.x - x, second.z - z));
    },
  };
}

function mulberry32(state) {
  let value = state | 0;
  return function next() {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A scripted wandering path: seeded turns at a limited rate, a slowly varying altitude. */
function createFlightPath({ pathSeed, speed, altitude: [lowAltitude, highAltitude], turnRate = 3 }) {
  const random = mulberry32(hashString(pathSeed));
  const player = { position: { x: 0, y: lowAltitude, z: 0 }, heading: random() * 360, speed };
  let targetHeading = player.heading;
  let nextTurnAt = 30 + random() * 60;
  const altitudePhase = random() * Math.PI * 2;
  return {
    player,
    step(dt, time) {
      if (time >= nextTurnAt) {
        const sign = random() < 0.5 ? -1 : 1;
        targetHeading = (player.heading + sign * (20 + random() * 100) + 360) % 360;
        nextTurnAt = time + 30 + random() * 60;
      }
      const difference = ((targetHeading - player.heading + 540) % 360) - 180;
      const turn = Math.max(-turnRate * dt, Math.min(turnRate * dt, difference));
      player.heading = (player.heading + turn + 360) % 360;
      const radians = (player.heading * Math.PI) / 180;
      player.position.x += Math.sin(radians) * speed * dt;
      player.position.z -= Math.cos(radians) * speed * dt;
      const blend = 0.5 + 0.5 * Math.sin(time / 400 + altitudePhase);
      player.position.y = lowAltitude + (highAltitude - lowAltitude) * blend;
    },
  };
}

/** The sun on a uniform day clock (CONFIG day length), starting in the golden hour. */
function createSun(startDayTime = 0.72) {
  const sun = { sunElevation: 0, dayTime: startDayTime, days: startDayTime };
  return {
    sun,
    update(time) {
      sun.days = startDayTime + time / CONFIG.DAY_LENGTH_DEFAULT;
      sun.dayTime = sun.days % 1;
      sun.sunElevation = Math.sin((sun.dayTime - 0.25) * Math.PI * 2) * CONFIG.SUN_MAX_ELEVATION_DEG;
    },
  };
}

/** The camera looks along the heading: a 100 degree cone out to 40 km. */
function createView(player) {
  return function isInView(x, y, z, radius) {
    const distance = Math.hypot(x - player.position.x, z - player.position.z);
    if (distance > 40000) return false;
    if (distance <= radius) return true;
    const widen = (Math.atan2(radius, distance) * 180) / Math.PI;
    return angleBetween(bearingDegrees(player.position.x, player.position.z, x, z), player.heading) <= 50 + widen;
  };
}

// ============================================================================================
// STUB SPAWN MANAGER (contract section 4, plus the director's additions)
// ============================================================================================
/**
 * shape 'contract' answers as contract section 4 reads (instances with anchor and ended, getStats
 * { engines, total }, setLodBias, a site's active state through activate({ site })). shape 'framework'
 * answers as the p2/framework SpawnManager does: described records with position and duration,
 * getStats { engines, totals, heavy }, canActivate, getSiteSpawn / setSiteActive, 'spawns:inView',
 * and no setLodBias.
 */
function createStubSpawnManager({ bus, player, getTime, placement, isInView, budgets = DIRECTOR_BUDGETS, naturalEnds = true, shape = 'contract', presetById = PRESET_BY_ID }) {
  const instances = new Map();
  const activeList = [];
  const siteInstances = new Map();
  const seenSites = new Set();
  const records = [];
  const ends = [];
  const lodBiasHistory = [];
  const counters = { refusedHeavy: 0, refusedEngine: 0, refusedLights: 0, maxHeavy: 0, maxEngine: {}, maxLights: 0 };
  let serial = 0;
  const stats = { engines: {}, total: { instances: 0, particles: 0, lights: 0, heavy: 0 } };
  for (const name of Object.keys(ENGINE_COST)) stats.engines[name] = { instances: 0, particles: 0, lights: 0 };

  function recount() {
    for (const name of Object.keys(stats.engines)) {
      const engine = stats.engines[name];
      engine.instances = 0;
      engine.particles = 0;
      engine.lights = 0;
    }
    stats.total.instances = 0;
    stats.total.particles = 0;
    stats.total.lights = 0;
    stats.total.heavy = 0;
    activeList.length = 0;
    for (const instance of instances.values()) {
      activeList.push(instance);
      if (instance.heavy && !instance.ended) stats.total.heavy++;
      for (const name of instance.engines) {
        const engine = stats.engines[name];
        engine.instances++;
        engine.particles += ENGINE_COST[name].particles;
        engine.lights += ENGINE_COST[name].lights;
        stats.total.particles += ENGINE_COST[name].particles;
        stats.total.lights += ENGINE_COST[name].lights;
      }
      stats.total.instances++;
    }
    counters.maxHeavy = Math.max(counters.maxHeavy, stats.total.heavy);
    counters.maxLights = Math.max(counters.maxLights, stats.total.lights);
    for (const [name, engine] of Object.entries(stats.engines)) {
      const peak = counters.maxEngine[name] || { instances: 0, particles: 0 };
      counters.maxEngine[name] = { instances: Math.max(peak.instances, engine.instances), particles: Math.max(peak.particles, engine.particles) };
    }
  }

  /** The manager's own budget gate (it refuses what would break a budget). */
  function refusal(preset, countsHeavy) {
    if (countsHeavy && stats.total.heavy >= budgets.maxHeavy) return 'heavy';
    for (const { engine } of preset.engines) {
      const cap = budgets.engines[engine];
      const used = stats.engines[engine];
      if (used.instances + 1 > cap.instances) return 'engine';
      if (cap.particles > 0 && used.particles + ENGINE_COST[engine].particles > cap.particles) return 'engine';
    }
    const lights = preset.engines.reduce((sum, { engine }) => sum + ENGINE_COST[engine].lights, 0);
    if (lights > 0 && stats.total.lights + lights > budgets.maxRealLights) return 'lights';
    return null;
  }

  function createInstance(preset, { position, source, duration, seed, site, heavy }) {
    const id = `i${++serial}`;
    // Engines end an event a little before its duration (a tornado ropes out); with naturalEnds off
    // they never do, and the director's lifetime rule has to end it.
    const natural = naturalEnds && Number.isFinite(duration) && duration !== null ? duration * (0.85 + 0.15 * unitFromHash(seed >>> 0)) : Infinity;
    const instance = {
      id, presetId: preset.id, engine: preset.engines[0].engine, engines: preset.engines.map((entry) => entry.engine),
      anchor: { x: position.x, y: position.y, z: position.z }, radius: 800, heavy, tier: 'far', ended: false,
      windSourceIds: [], lights: 0, particles: 0,
      data: { source, startedAt: getTime(), endsAt: getTime() + natural, site: site || null, duration },
    };
    instances.set(id, instance);
    recount();
    return instance;
  }

  function describe(instance) {
    return {
      id: instance.id, presetId: instance.presetId, heavy: instance.heavy, source: instance.data.source,
      position: { x: instance.anchor.x, y: instance.anchor.y, z: instance.anchor.z }, radius: instance.radius,
      duration: instance.data.duration, active: instance.data.active !== false,
    };
  }

  /** A site's active state switched by the director (framework shape). */
  function setSiteActive(id, active) {
    const instance = instances.get(id);
    if (!instance || instance.data.source !== 'site') return false;
    const time = getTime();
    if (active && instance.data.activeSince === undefined) {
      const distance = Math.hypot(instance.anchor.x - player.position.x, instance.anchor.z - player.position.z);
      const bearing = bearingDegrees(player.position.x, player.position.z, instance.anchor.x, instance.anchor.z);
      records.push({ time, presetId: instance.presetId, source: 'director', distance, offAxis: angleBetween(bearing, player.heading), duration: null, refused: null, site: instance.data.site.id });
      instance.data.activeSince = time;
    } else if (!active && instance.data.activeSince !== undefined) {
      endSiteActive(instance, 'siteInactive', time);
    }
    return true;
  }
  function endSiteActive(instance, reason, time) {
    ends.push({ id: instance.id, presetId: instance.presetId, reason, time, age: time - instance.data.activeSince, distance: null, inView: null, duration: null, source: 'director' });
    instance.data.activeSince = undefined;
  }

  const api = {
    records,
    ends,
    lodBiasHistory,
    counters,
    activate(presetId, options) {
      const preset = presetById.get(presetId);
      if (!preset) throw new Error(`stub manager: unknown preset ${presetId}`);
      // A site's active state rides on the site: its heavy share is the site instance's.
      const siteInstance = options.site ? siteInstances.get(options.site.id) : null;
      const countsHeavy = preset.heavy && !(siteInstance && siteInstance.heavy);
      const refused = refusal(preset, countsHeavy);
      const time = getTime();
      const distance = Math.hypot(options.position.x - player.position.x, options.position.z - player.position.z);
      const bearing = bearingDegrees(player.position.x, player.position.z, options.position.x, options.position.z);
      records.push({
        time, presetId, source: options.source, distance, offAxis: angleBetween(bearing, player.heading),
        duration: options.duration, refused, site: options.site ? options.site.id : null,
        parent: options.parent ?? null, x: options.position.x, z: options.position.z, bearing,
      });
      if (refused === 'heavy') counters.refusedHeavy++;
      if (refused === 'engine') counters.refusedEngine++;
      if (refused === 'lights') counters.refusedLights++;
      if (refused) return null;
      const instance = createInstance(preset, { ...options, heavy: countsHeavy });
      records[records.length - 1].id = instance.id;
      return instance.id;
    },
    deactivate(id, reason) {
      const instance = instances.get(id);
      if (!instance) return false;
      const distance = Math.hypot(instance.anchor.x - player.position.x, instance.anchor.z - player.position.z);
      ends.push({ id, presetId: instance.presetId, reason, time: getTime(), age: getTime() - instance.data.startedAt, distance, inView: isInView(instance.anchor.x, instance.anchor.y, instance.anchor.z, instance.radius), duration: instance.data.duration, source: instance.data.source });
      instances.delete(id);
      recount();
      return true;
    },
    getActive() {
      return activeList;
    },
    getInstance(id) {
      return instances.get(id) || null;
    },
    getStats() {
      return stats;
    },
    setLodBias(bias) {
      lodBiasHistory.push(bias);
    },
    /** Once per director tick: natural endings, site instances in range and sites coming into view. */
    update() {
      const time = getTime();
      let changed = false;
      for (const instance of instances.values()) {
        if (instance.ended) {
          // The engine finished last tick: the manager removes it now.
          ends.push({ id: instance.id, presetId: instance.presetId, reason: 'ended', time, age: time - instance.data.startedAt, distance: null, inView: null, duration: instance.data.duration, source: instance.data.source });
          instances.delete(instance.id);
          changed = true;
        } else if (instance.data.source !== 'site' && time >= instance.data.endsAt) {
          instance.ended = true;
          changed = true;
        }
      }
      for (const site of placement.sitesNear(player.position.x, player.position.z, SITE_INSTANCE_RANGE)) {
        if (!siteInstances.has(site.id) && stats.engines.structure.instances < budgets.engines.structure.instances) {
          const preset = presetById.get(site.presetId);
          // A site renders its heavy parts, lights and particles only while the budgets allow;
          // otherwise it stands as bare structure until they do.
          const heavy = preset.heavy && stats.total.heavy < budgets.maxHeavy;
          const withinBudget = refusal(preset, heavy) === null;
          const instance = createInstance(withinBudget ? preset : BARE_SITE, { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', duration: null, seed: site.seed, site, heavy: heavy && withinBudget });
          siteInstances.set(site.id, instance);
        }
        if (!seenSites.has(site.id) && Math.hypot(site.x - player.position.x, site.z - player.position.z) < 12000 && isInView(site.x, site.groundY, site.z, 500)) {
          seenSites.add(site.id);
          if (shape === 'framework') bus.emit('spawns:inView', { id: `spawn:${site.id}`, presetId: site.presetId, siteId: site.id, kind: 'site', distance: 12000 });
          else bus.emit('spawns:siteInView', { id: site.id, presetId: site.presetId });
        }
      }
      for (const [siteId, instance] of siteInstances) {
        if (Math.hypot(instance.anchor.x - player.position.x, instance.anchor.z - player.position.z) > SITE_INSTANCE_RANGE + 3000) {
          if (instance.data.activeSince !== undefined) endSiteActive(instance, 'range', getTime());
          instances.delete(instance.id);
          siteInstances.delete(siteId);
          changed = true;
        }
      }
      if (changed) recount();
    },
  };
  if (shape === 'contract') return api;
  const frameworkStats = { engines: {}, totals: stats.total, heavy: 0, heavyLimit: budgets.maxHeavy };
  const REFUSAL_NAMES = Object.freeze({ heavy: 'heavy', engine: 'instances', lights: 'particles' });
  return {
    records, ends, lodBiasHistory, counters,
    activate: api.activate,
    deactivate: api.deactivate,
    update: api.update,
    getActive: () => activeList.filter((instance) => !instance.ended).map(describe),
    getInstance(id) {
      const instance = instances.get(id);
      return instance && !instance.ended ? describe(instance) : null;
    },
    getStats() {
      for (const [name, engine] of Object.entries(stats.engines)) frameworkStats.engines[name] = { ...engine, budget: { ...budgets.engines[name] } };
      frameworkStats.heavy = stats.total.heavy;
      return frameworkStats;
    },
    canActivate(presetId, source = 'director') {
      const preset = presetById.get(presetId);
      if (!preset) return 'preset';
      const reason = refusal(preset, preset.heavy && source !== 'site');
      return reason ? REFUSAL_NAMES[reason] : null;
    },
    getSiteSpawn(siteId) {
      const instance = siteInstances.get(siteId);
      return instance ? instance.id : null;
    },
    setSiteActive,
  };
}

// ============================================================================================
// SCENARIO RUNNER
// ============================================================================================
const SPEEDS = Object.freeze({
  glider: { speed: 35, altitude: [700, 1800] },
  bushplane: { speed: 60, altitude: [300, 1500] },
  jet: { speed: 220, altitude: [1500, 6000] },
});
const STEP_SECONDS = 0.1;
/**
 * Sites per 2 km cell in the typical world: the 11 site presets of Phase 2 with a few per cent each
 * (a new site comes into view every minute or two at bush plane speed).
 */
const TYPICAL_SITE_CHANCE = 0.08;

/**
 * Flies one scripted path. options: seed, pathSeed, hours, craft (SPEEDS key), siteChance, perf
 * (a perf governor or a stub; none by default).
 */
function runScenario({ seed, pathSeed, hours, craft, siteChance, perf = null, naturalEnds = true, shape = 'contract' }) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const world = createWorldGen(seed, WORLD_OPTIONS);
  const weather = createWeatherModel(world.seedHash >>> 0);
  // Real mode: the real placement of the real site presets (none at all when siteChance is 0).
  const placement = !REAL_MODE ? createStubPlacement(world.seedHash >>> 0, siteChance) : siteChance > 0 ? world : { sitesNear: () => [] };
  const path = createFlightPath({ pathSeed, ...SPEEDS[craft] });
  const sun = createSun();
  let time = 0;
  const getTime = () => time;
  const isInView = createView(path.player);
  const manager = createStubSpawnManager({ bus, player: path.player, getTime, placement, isInView, naturalEnds, shape });
  const director = createDirector({
    seedHash: world.seedHash >>> 0,
    presets: PRESETS,
    spawnManager: manager,
    weather,
    terrain: { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: CONFIG.WATER_LEVEL, landmarkSitesNear: world.landmarkSitesNear },
    getPlayer: () => path.player,
    getTime,
    getSun: () => sun.sun,
    isInView,
    placement,
    perf,
    bus,
    devHooks: true,
  });
  const notables = [];
  bus.on('spawns:siteInView', () => notables.push({ time, kind: 'site' }));
  bus.on('spawns:inView', () => notables.push({ time, kind: 'site' }));
  const heavyByTick = { max: 0 };
  /** Snapshots of the director whenever a drought runs past 90 s (why nothing was eligible). */
  const longDroughts = [];
  const totalSteps = Math.round((hours * 3600) / STEP_SECONDS);
  let nextManagerTick = 0;
  for (let step = 0; step <= totalSteps; step++) {
    time = step * STEP_SECONDS;
    path.step(STEP_SECONDS, time);
    sun.update(time);
    if (time >= nextManagerTick) {
      nextManagerTick += 0.5;
      manager.update();
      heavyByTick.max = Math.max(heavyByTick.max, manager.counters.maxHeavy);
    }
    director.update();
    if (step % 100 === 0 && longDroughts.length < 20) {
      const snapshot = director.getState();
      if (snapshot.droughtSeconds > 90) {
        const reasons = {};
        for (const candidate of snapshot.candidates) reasons[candidate.rejection || 'eligible'] = (reasons[candidate.rejection || 'eligible'] || 0) + 1;
        longDroughts.push({ time, drought: snapshot.droughtSeconds, sun: Math.round(sun.sun.sunElevation), altitude: Math.round(path.player.position.y), weather: snapshot.weather, reasons });
      }
    }
  }
  const state = director.getState();
  const nearby = director.getNearby(10);
  const log = director.getLog();
  director.dispose();
  return { log, state, nearby, manager, notables, heavyByTick, hours, craft, longDroughts };
}

// ============================================================================================
// CHECKS
// ============================================================================================
function testPacing() {
  const firsts = [];
  for (const seed of ['PACING-1', 'PACING-2', 'PACING-3']) {
    for (const craft of Object.keys(SPEEDS)) {
      const run = runScenario({ seed, pathSeed: `${seed}-${craft}`, hours: 0.05, craft, siteChance: 0 });
      firsts.push({ seed, craft, first: run.state.firstNotableAt });
    }
  }
  const values = firsts.map((entry) => entry.first);
  const inWindow = values.every((value) => value !== null && value >= 60 && value <= 90);
  check('pacing', 'first notable 60-90 s into a flight with nothing in sight (3 seeds x 3 speeds)', inWindow, `${Math.min(...values)}-${Math.max(...values)} s: ${firsts.map((entry) => `${entry.seed}/${entry.craft} ${entry.first}`).join(', ')}`);

  const droughts = [];
  for (const craft of Object.keys(SPEEDS)) {
    const run = runScenario({ seed: 'DROUGHT', pathSeed: `drought-${craft}`, hours: 3, craft, siteChance: 0 });
    droughts.push({ craft, longest: run.state.longestDrought, fills: run.state.droughtFills, notables: run.state.notables, pacing: run.state.pacing });
    for (const entry of run.longDroughts.slice(0, 4)) verbose(`long drought (${craft}): ${JSON.stringify(entry)}`);
  }
  check('pacing', `drought fill, no sites at all (3 h per speed): >= ${EMPTY_WORLD_SHARE * 100} % of droughts end within ${PACING_WINDOW_MAX} s`, droughts.every((entry) => entry.fills > 0 && windowShare(entry.pacing) >= EMPTY_WORLD_SHARE), droughts.map(describePacing).join('; '));
}

/**
 * Pacing targets. A drought ends within the window whenever a candidate its rules admit lies ahead;
 * the share that cannot is content-limited (at night inland only one common preset fits, and the
 * cooldowns and the no-repeat rule hold even then), so these are shares, reported with the longest.
 */
const EMPTY_WORLD_SHARE = 0.9;
const TYPICAL_WORLD_SHARE = 0.95;
function windowShare(pacing) {
  return pacing.droughts > 0 ? pacing.withinWindow / pacing.droughts : 1;
}
function describePacing(entry) {
  return `${entry.craft ? `${entry.craft}: ` : ''}${entry.pacing.withinWindow}/${entry.pacing.droughts} droughts within ${PACING_WINDOW_MAX} s (${(windowShare(entry.pacing) * 100).toFixed(1)} %), longest ${entry.longest} s, ${entry.fills} fills`;
}

/** Mean interval (s) between activations of each tier in a log over `hours`. */
function tierIntervals(log, hours) {
  const counts = Object.fromEntries(RARITY_TIERS.map((tier) => [tier, 0]));
  for (const entry of log) counts[PRESET_BY_ID.get(entry.presetId).rarity]++;
  return Object.fromEntries(RARITY_TIERS.map((tier) => [tier, { count: counts[tier], interval: counts[tier] > 0 ? (hours * 3600) / counts[tier] : Infinity }]));
}

const RATE_TARGETS = Object.freeze({ common: [120, 300], uncommon: [600, 900], rare: [1800, 3600], legendary: [3600, 7200] });

function testLongFlight() {
  const hours = OPTIONS.hours;
  const run = runScenario({ seed: 'RARITY', pathSeed: 'rarity-bushplane', hours, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  const intervals = tierIntervals(run.log, hours);
  const byReason = run.log.reduce((counts, entry) => ({ ...counts, [entry.reason]: (counts[entry.reason] || 0) + 1 }), {});
  for (const entry of run.longDroughts.slice(0, 6)) verbose(`long drought (long flight): ${JSON.stringify(entry)}`);
  verbose(`long flight: ${run.log.length} activations (${JSON.stringify(byReason)}), ${run.state.notables} notables, ${run.notables.length} sites in view`);
  for (const tier of RARITY_TIERS) {
    const [low, high] = RATE_TARGETS[tier];
    const { count, interval } = intervals[tier];
    check('rarity', `${tier}: mean interval ${low / 60}-${high / 60} min over ${hours} h`, interval >= low && interval <= high, `${count} activations, one per ${(interval / 60).toFixed(1)} min`);
  }
  check('pacing', `typical world (${hours} h, bush plane): >= ${TYPICAL_WORLD_SHARE * 100} % of droughts end within ${PACING_WINDOW_MAX} s`, windowShare(run.state.pacing) >= TYPICAL_WORLD_SHARE, `${describePacing({ pacing: run.state.pacing, longest: run.state.longestDrought, fills: run.state.droughtFills })}; ${run.notables.length} sites came into view`);

  // Ahead, never behind.
  const director = run.manager.records.filter((record) => record.source === 'director');
  const reasonAt = new Map(run.log.map((entry) => [`${entry.time}|${entry.presetId}`, entry.reason]));
  const scheduled = director.filter((record) => reasonAt.get(`${record.time}|${record.presetId}`) === 'schedule');
  const worstAxis = Math.max(...director.map((record) => record.offAxis));
  const worstScheduled = Math.max(...scheduled.map((record) => record.offAxis));
  const outOfBand = director.filter((record) => {
    const preset = PRESET_BY_ID.get(record.presetId);
    return record.distance < (preset.filters.minDistance ?? 3000) - 1 || record.distance > (preset.filters.maxDistance ?? 8000) + 1;
  });
  check('ahead', `scheduled activations within ${MAX_OFF_AXIS} deg of the heading, drought fills within ${MAX_OFF_AXIS_WIDE}`, worstScheduled <= MAX_OFF_AXIS + 1e-9 && worstAxis <= MAX_OFF_AXIS_WIDE + 1e-9 && scheduled.length > 0, `${director.length} activations: scheduled worst ${worstScheduled.toFixed(1)} deg, all worst ${worstAxis.toFixed(1)} deg`);
  check('ahead', 'none behind the player (over 90 deg off the heading)', director.every((record) => record.offAxis < 90), `${director.filter((record) => record.offAxis >= 90).length} behind`);
  check('ahead', "every director activation inside its preset's distance band", outOfBand.length === 0, `${outOfBand.length} outside`);
  const fillTimes = new Set(run.log.filter((entry) => entry.reason === 'drought').map((entry) => entry.time));
  const fills = director.filter((record) => fillTimes.has(record.time) && !record.refused);
  const fillsOut = fills.filter((record) => record.distance < DROUGHT_BAND.min - 1 || record.distance > DROUGHT_BAND.max + 1);
  check('ahead', 'drought fills 3-8 km ahead', fillsOut.length === 0 && fills.length > 0, `${fills.length} fills, ${fills.length ? `${Math.round(Math.min(...fills.map((record) => record.distance)))}-${Math.round(Math.max(...fills.map((record) => record.distance)))} m` : 'none'}`);

  // Cooldowns and repeats.
  const lastByPreset = new Map();
  let cooldownBreaks = 0;
  let repeats = 0;
  run.log.forEach((entry, index) => {
    const preset = PRESET_BY_ID.get(entry.presetId);
    const previous = lastByPreset.get(entry.presetId);
    if (previous !== undefined && entry.time - previous < RARITY_COOLDOWNS[preset.rarity]) cooldownBreaks++;
    lastByPreset.set(entry.presetId, entry.time);
    if (index > 0 && run.log[index - 1].presetId === entry.presetId) repeats++;
  });
  check('cooldowns', 'per-preset cooldowns hold', cooldownBreaks === 0, `${cooldownBreaks} activations inside a cooldown`);
  check('cooldowns', 'no preset twice in a row', repeats === 0, `${repeats} back-to-back repeats in ${run.log.length}`);

  // Budgets.
  const counters = run.manager.counters;
  const engineBreaks = Object.entries(counters.maxEngine).filter(([name, peak]) => peak.instances > DIRECTOR_BUDGETS.engines[name].instances || (DIRECTOR_BUDGETS.engines[name].particles > 0 && peak.particles > DIRECTOR_BUDGETS.engines[name].particles));
  check('budgets', `heavy spawns never over ${DIRECTOR_BUDGETS.maxHeavy}`, counters.maxHeavy <= DIRECTOR_BUDGETS.maxHeavy && run.heavyByTick.max <= DIRECTOR_BUDGETS.maxHeavy, `peak ${counters.maxHeavy} heavy (sites included)`);
  check('budgets', 'per-engine instance and particle caps and the light cap held', engineBreaks.length === 0 && counters.maxLights <= DIRECTOR_BUDGETS.maxRealLights, `${engineBreaks.length ? engineBreaks.map(([name, peak]) => `${name} ${JSON.stringify(peak)}`).join(', ') : 'no engine over its caps'}; peak lights ${counters.maxLights}/${DIRECTOR_BUDGETS.maxRealLights}`);
  const refusals = counters.refusedHeavy + counters.refusedEngine + counters.refusedLights;
  check('budgets', 'the director never pushes past the heavy budget, and budget refusals stay rare (< 2 %)', counters.refusedHeavy === 0 && refusals < director.length * 0.02, `${refusals} of ${director.length} refused by the manager: heavy ${counters.refusedHeavy}, engine ${counters.refusedEngine}, lights ${counters.refusedLights}`);

  checkLifetimes('bush plane, natural endings', run, director);

  // API.
  const nearby = run.nearby;
  const sorted = nearby.every((entry, index) => index === 0 || nearby[index - 1].distance <= entry.distance);
  const wellFormed = nearby.every((entry) => typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.category === 'string' && Number.isFinite(entry.distance) && entry.distance <= 10000 && Number.isFinite(entry.bearing) && ['active', 'dormant', 'site', 'discovered'].includes(entry.state) && (entry.etaSeconds === null || Number.isFinite(entry.etaSeconds)));
  const states = [...new Set(nearby.map((entry) => entry.state))].join(', ');
  check('api', 'getNearby(10) is sorted by distance and well formed', sorted && wellFormed && nearby.length > 0, `${nearby.length} entries (${states})`);
  const fields = ['droughtSeconds', 'budgets', 'heavyCount', 'candidates', 'cooldowns', 'weather', 'log', 'logHash', 'tiers', 'shedLevel'];
  check('api', 'getState carries the debugger fields', fields.every((field) => field in run.state), fields.filter((field) => !(field in run.state)).join(', ') || fields.join(', '));
  return run;
}

/** Every started event ends; despawns only out of range and out of view; nothing outlives duration + grace. */
function checkLifetimes(label, run, directorRecords) {
  const directorEnds = run.manager.ends.filter((end) => end.source === 'director');
  const reasons = directorEnds.reduce((counts, end) => ({ ...counts, [end.reason]: (counts[end.reason] || 0) + 1 }), {});
  const started = directorRecords.filter((record) => !record.refused).length;
  // The run disposes the director at the end, which ends whatever still runs ('dispose').
  check('lifetimes', `${label}: every started event ends`, directorEnds.length === started, `${started} started: ${JSON.stringify(reasons)}`);
  const badDespawns = directorEnds.filter((end) => end.reason === 'despawn' && (end.inView || end.distance <= DESPAWN.distance + DESPAWN.hysteresis));
  if (reasons.despawn) check('lifetimes', `${label}: despawns only beyond distance + hysteresis and out of view`, badDespawns.length === 0, `${reasons.despawn} despawns, ${badDespawns.length} in range or in view`);
  const timed = directorEnds.filter((end) => end.age !== null && end.duration !== null && end.reason !== 'dispose');
  const overran = timed.filter((end) => end.age > end.duration + 60.5);
  check('lifetimes', `${label}: no event outlives its duration plus the 60 s grace`, overran.length === 0 && timed.length > 0, `${timed.length} timed ends, ${overran.length} overran`);
  return reasons;
}

function testLifetimes() {
  // A jet leaves events behind fast: the despawn rule ends them.
  const jet = runScenario({ seed: 'DESPAWN', pathSeed: 'despawn-jet', hours: 3, craft: 'jet', siteChance: TYPICAL_SITE_CHANCE });
  const jetReasons = checkLifetimes('jet', jet, jet.manager.records.filter((record) => record.source === 'director'));
  check('lifetimes', 'jet: events left behind are despawned', (jetReasons.despawn || 0) > 0, `${jetReasons.despawn || 0} despawns`);
  // Engines that never finish: the director's lifetime rule ends them.
  const stuck = runScenario({ seed: 'LIFETIME', pathSeed: 'lifetime-glider', hours: 3, craft: 'glider', siteChance: TYPICAL_SITE_CHANCE, naturalEnds: false });
  const stuckReasons = checkLifetimes('engines that never end', stuck, stuck.manager.records.filter((record) => record.source === 'director'));
  check('lifetimes', 'engines that never end: the lifetime rule ends them', (stuckReasons.lifetime || 0) > 0, `${stuckReasons.lifetime || 0} lifetime ends`);
}

/** The director against a manager shaped like the p2/framework SpawnManager: the same guarantees. */
function testFrameworkShape() {
  const hours = 8;
  const run = runScenario({ seed: 'FRAMEWORK', pathSeed: 'framework-bushplane', hours, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE, shape: 'framework' });
  const director = run.manager.records.filter((record) => record.source === 'director');
  const siteStates = director.filter((record) => record.site !== null);
  const counters = run.manager.counters;
  const refusals = counters.refusedHeavy + counters.refusedEngine + counters.refusedLights;
  let repeats = 0;
  run.log.forEach((entry, index) => { if (index > 0 && run.log[index - 1].presetId === entry.presetId) repeats++; });
  const directorEnds = run.manager.ends.filter((end) => end.source === 'director');
  const label = `framework-shaped manager, ${hours} h`;
  check('framework', `${label}: nothing behind, heavy never over ${DIRECTOR_BUDGETS.maxHeavy}, no repeats`, director.every((record) => record.offAxis <= MAX_OFF_AXIS_WIDE + 1e-9) && counters.maxHeavy <= DIRECTOR_BUDGETS.maxHeavy && repeats === 0 && director.length > 0, `${director.length} activations, worst ${Math.max(...director.map((record) => record.offAxis)).toFixed(1)} deg, peak heavy ${counters.maxHeavy}, ${repeats} repeats`);
  check('framework', `${label}: canActivate keeps refusals rare (< 2 %)`, counters.refusedHeavy === 0 && refusals < director.length * 0.02, `${refusals} refused`);
  check('framework', `${label}: every start ends, site active states through setSiteActive`, directorEnds.length === director.filter((record) => !record.refused).length && siteStates.length > 0, `${directorEnds.length} ends of ${director.filter((record) => !record.refused).length} starts; ${siteStates.length} volcano eruptions`);
  check('framework', `${label}: pacing with 'spawns:inView' notables`, windowShare(run.state.pacing) >= TYPICAL_WORLD_SHARE && run.notables.length > 0, describePacing({ pacing: run.state.pacing, longest: run.state.longestDrought, fills: run.state.droughtFills }));
}

function testDeferral() {
  const perfStub = {
    addLoadShedder() {
      return { remove() {} };
    },
    getHeadroom() {
      return { missing: true, ratio: 1.3, shedDepth: 0 };
    },
  };
  const run = runScenario({ seed: 'DEFER', pathSeed: 'defer', hours: 4, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE, perf: perfStub });
  const heavy = run.log.filter((entry) => PRESET_BY_ID.get(entry.presetId).heavy);
  check('deferral', 'no heavy activation while frames miss the target', heavy.length === 0 && run.log.length > 0, `${run.log.length} activations in 4 h, ${heavy.length} heavy`);
}

function testDeterminism() {
  const first = runScenario({ seed: 'SAME', pathSeed: 'same-path', hours: 3, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  const second = runScenario({ seed: 'SAME', pathSeed: 'same-path', hours: 3, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  const other = runScenario({ seed: 'SAME', pathSeed: 'another-path', hours: 3, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  const identical = JSON.stringify(first.log) === JSON.stringify(second.log) && first.state.logHash === second.state.logHash;
  check('determinism', 'same seed and path: identical activation logs', identical && first.log.length > 0, `${first.log.length} entries, hash ${first.state.logHash} / ${second.state.logHash}`);
  check('determinism', 'another path: a different log', other.state.logHash !== first.state.logHash, `hash ${other.state.logHash}`);
  const seedOther = runScenario({ seed: 'OTHER', pathSeed: 'same-path', hours: 1, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  const firstHour = runScenario({ seed: 'SAME', pathSeed: 'same-path', hours: 1, craft: 'bushplane', siteChance: TYPICAL_SITE_CHANCE });
  check('determinism', 'another seed: a different log', seedOther.state.logHash !== firstHour.state.logHash, `hash ${seedOther.state.logHash} vs ${firstHour.state.logHash}`);
}

function testWeather() {
  const weather = createWeatherModel(hashString('WEATHER'));
  const sample = createWeatherSample();
  const counts = Object.fromEntries(WEATHER_STATES.map((state) => [state, 0]));
  let openings = 0;
  let badOpenings = 0;
  let orderBreaks = 0;
  for (let regionX = -30; regionX < 30; regionX++) {
    for (let regionZ = -30; regionZ < 30; regionZ++) {
      openings++;
      weather.sampleRegion(regionX, regionZ, 0, sample);
      if (sample.state !== 'clear') badOpenings++;
      weather.sampleRegion(regionX, regionZ, WEATHER_BUCKET_SECONDS - 1, sample);
      if (sample.state !== 'clear') badOpenings++;
      let previous = null;
      for (let time = 0; time < 24 * 3600; time += 30) {
        weather.sampleRegion(regionX, regionZ, time, sample);
        counts[sample.state]++;
        if (previous !== null && previous !== sample.state && WEATHER_STATES[(WEATHER_STATES.indexOf(previous) + 1) % 4] !== sample.state) orderBreaks++;
        previous = sample.state;
      }
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const shares = Object.fromEntries(WEATHER_STATES.map((state) => [state, counts[state] / total]));
  check('weather', 'state distribution over 3600 regions x 24 h', shares.storm > 0.08 && shares.storm < 0.2 && shares.building > 0.05 && shares.clearing > 0.05 && shares.clear > 0.6, WEATHER_STATES.map((state) => `${state} ${(shares[state] * 100).toFixed(1)} %`).join(', '));
  check('weather', 'cycle order clear > building > storm > clearing > clear, always', orderBreaks === 0, `${orderBreaks} out-of-order transitions`);
  check('weather', 'every flight opens clear (the first bucket, every region)', badOpenings === 0, `${badOpenings} of ${openings * 2} opening samples not clear`);

  // Smooth along a path: storminess never jumps between 1 s samples, even across region borders.
  let largestStep = 0;
  let previousLevel = null;
  const path = createFlightPath({ pathSeed: 'weather-smooth', ...SPEEDS.jet });
  for (let time = 0; time < 6 * 3600; time += 1) {
    path.step(1, time);
    weather.sampleAt(path.player.position.x, path.player.position.z, time, sample);
    if (previousLevel !== null) largestStep = Math.max(largestStep, Math.abs(sample.storminess - previousLevel));
    previousLevel = sample.storminess;
  }
  check('weather', 'storminess changes smoothly in flight (jet, 6 h, 1 s samples)', largestStep < 0.05, `largest change in 1 s: ${largestStep.toFixed(4)}`);

  // Normal sessions: what share meets a storm, and all four states.
  const sessionRows = [];
  for (const minutes of [20, 30]) {
    for (const craft of Object.keys(SPEEDS)) {
      let withStorm = 0;
      let withAll = 0;
      const sessions = 200;
      for (let session = 0; session < sessions; session++) {
        const model = createWeatherModel(hashString(`SESSION-${session}`));
        const flight = createFlightPath({ pathSeed: `session-${craft}-${session}`, ...SPEEDS[craft] });
        const seen = new Set();
        for (let time = 0; time < minutes * 60; time += 5) {
          flight.step(5, time);
          seen.add(model.stateAt(flight.player.position.x, flight.player.position.z, time));
        }
        if (seen.has('storm')) withStorm++;
        if (seen.size === 4) withAll++;
      }
      sessionRows.push({ minutes, craft, storm: withStorm / sessions, all: withAll / sessions });
    }
  }
  const twenty = sessionRows.filter((row) => row.minutes === 20);
  const thirty = sessionRows.filter((row) => row.minutes === 30);
  check('weather', 'most 20-minute flights meet a storm (every speed)', twenty.every((row) => row.storm > 0.5), twenty.map((row) => `${row.craft} ${(row.storm * 100).toFixed(0)} %`).join(', '));
  check('weather', '30-minute flights meet all four states often (every speed)', thirty.every((row) => row.all > 0.4), thirty.map((row) => `${row.craft} ${(row.all * 100).toFixed(0)} % all four, ${(row.storm * 100).toFixed(0)} % storm`).join(', '));
  verbose(`weather: region ${WEATHER_REGION_SIZE} m, bucket ${WEATHER_BUCKET_SECONDS} s, cycle ${WEATHER_CYCLE_BUCKETS} buckets; sessions ${JSON.stringify(sessionRows)}`);
}

// ---- Load shedding ------------------------------------------------------------------------------------
/** The Phase 1 governor (tag v2-structure), imported from a temporary copy with absolute imports. */
async function loadPhaseOneGovernor() {
  const source = execFileSync('git', ['show', 'v2-structure:src/core/perf.js'], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  const core = join(PROJECT_ROOT, 'src', 'core');
  const patched = source
    .replace("from './util.js'", `from '${pathToFileURL(join(core, 'util.js')).href}'`)
    .replace("from './config.js'", `from '${pathToFileURL(join(core, 'config.js')).href}'`);
  const directory = mkdtempSync(join(tmpdir(), 'driftwing-director-lab-'));
  const file = join(directory, 'perf-phase1.mjs');
  writeFileSync(file, patched);
  try {
    return (await import(pathToFileURL(file).href)).createPerfGovernor;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createGovernorHarness(factory) {
  const bus = new EventBus();
  const values = { quality: 'high', dynamicResolution: true, frameTarget: 'auto' };
  const renderer = { ratio: 1, getPixelRatio() { return this.ratio; }, setPixelRatio(ratio) { this.ratio = ratio; } };
  const state = { ready: true, photoMode: false, perf: {} };
  const ctx = { renderer, settings: { get: (key) => values[key] }, bus, state, quality: {}, post: { scale: 1, setRenderScale(scale) { this.scale = scale; } } };
  const perf = factory(ctx, { devHooks: true });
  return { perf, state, bus };
}

/** Drives a governor through a load trace: phases of { seconds, baseMs, scaledMs }, shed relief per level. */
function driveGovernor(harness, phases, { reliefPerLevel = 0, onFrame = null } = {}) {
  const timeline = [];
  harness.bus.on('perf:renderScale', ({ scale }) => timeline.push({ kind: 'scale', scale }));
  harness.bus.on('perf:loadShed', ({ action, depth }) => timeline.push({ kind: action, depth }));
  let appliedKey = '';
  let clock = 0;
  for (const phase of phases) {
    const frames = Math.round(phase.seconds * 60);
    for (let frame = 0; frame < frames; frame++) {
      clock += 1 / 60;
      const depth = harness.state.perf.shedDepth || 0;
      const baseMs = phase.baseMs - reliefPerLevel * depth;
      const key = `${baseMs}|${phase.scaledMs}`;
      if (key !== appliedKey) {
        appliedKey = key;
        harness.perf.simulateLoad({ baseMs, scaledMs: phase.scaledMs });
      }
      if (onFrame) onFrame(clock);
      harness.perf.update({ frameMs: 1000 / 60, cpuMs: 2 });
    }
  }
  return timeline;
}

const LOAD_TRACE = Object.freeze([
  { seconds: 8, baseMs: 8, scaledMs: 6 },
  { seconds: 50, baseMs: 18, scaledMs: 6 },
  { seconds: 90, baseMs: 6, scaledMs: 6 },
]);
const OSCILLATING_TRACE = Object.freeze([
  { seconds: 6, baseMs: 9, scaledMs: 7 },
  { seconds: 12, baseMs: 16, scaledMs: 8 },
  { seconds: 10, baseMs: 9, scaledMs: 8 },
  { seconds: 12, baseMs: 15, scaledMs: 9 },
  { seconds: 30, baseMs: 7, scaledMs: 8 },
  { seconds: 20, baseMs: 17, scaledMs: 10 },
  { seconds: 40, baseMs: 6, scaledMs: 6 },
]);

async function testShedding() {
  // Node has no window: the governor only reads the device pixel ratio from it.
  globalThis.window = globalThis.window || { devicePixelRatio: 1 };

  const harness = createGovernorHarness(createPerfGovernor);
  let time = 0;
  const player = { position: { x: 0, y: 800, z: 0 }, heading: 0, speed: 60 };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const placement = createStubPlacement(1, 0);
  const manager = createStubSpawnManager({ bus, player, getTime: () => time, placement, isInView: createView(player) });
  const world = createWorldGen('SHED', WORLD_OPTIONS);
  const deferSeen = [];
  const director = createDirector({
    seedHash: world.seedHash >>> 0, presets: PRESETS, spawnManager: manager, weather: createWeatherModel(world.seedHash >>> 0),
    terrain: { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: 0 },
    getPlayer: () => player, getTime: () => time, getSun: () => ({ sunElevation: 20, dayTime: 0.4 }), isInView: createView(player),
    placement, perf: harness.perf, bus,
  });
  const timeline = driveGovernor(harness, LOAD_TRACE, {
    reliefPerLevel: 1.2,
    onFrame(clock) {
      time = clock;
      director.update();
      if (Math.abs(clock % 5) < 1 / 60) deferSeen.push({ shed: director.getState().shedLevel, defer: director.getState().deferHeavy });
    },
  });
  const order = timeline.map((entry) => (entry.kind === 'scale' ? `scale ${entry.scale}` : `${entry.kind} ${entry.depth}`));
  verbose(`shedding timeline: ${order.join(' > ')}`);
  const sheds = timeline.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.kind === 'shed');
  const restores = timeline.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.kind === 'restore');
  const scaleDowns = [];
  const scaleUps = [];
  let lastScale = 1;
  timeline.forEach((entry, index) => {
    if (entry.kind !== 'scale') return;
    (entry.scale < lastScale ? scaleDowns : scaleUps).push(index);
    lastScale = entry.scale;
  });
  const shedFirst = sheds.length === 3 && scaleDowns.length > 0 && sheds.every((entry) => entry.index < scaleDowns[0]);
  const restoreLast = restores.length === 3 && scaleUps.length > 0 && restores.every((entry) => entry.index > scaleUps[scaleUps.length - 1]);
  check('shedding', 'all three director levels shed before the render scale steps down', shedFirst, order.join(' > '));
  check('shedding', 'the scale climbs back to 1 before the director restores, last level first', restoreLast && restores.map((entry) => entry.depth).join(',') === '2,1,0' && lastScale === 1, `restores to depth ${restores.map((entry) => entry.depth).join(', ')}; final scale ${lastScale}`);
  check('shedding', 'shed levels: heavy deferral, then far LOD demotion through the LOD bias', manager.lodBiasHistory.join(',') === '1,0.7,0.5,0.7,1,1' && deferSeen.some((entry) => entry.shed >= 1 && entry.defer), `LOD bias ${manager.lodBiasHistory.join(' > ')}`);
  director.dispose();

  // A director disposed while shedding (the spawns system drops a director that throws) puts the
  // manager's LOD bias back: perf removes its shedder without calling restore().
  {
    const sheddingManager = createStubSpawnManager({ bus, player, getTime: () => time, placement, isInView: createView(player) });
    const shedding = createDirector({
      seedHash: world.seedHash >>> 0, presets: PRESETS, spawnManager: sheddingManager, weather: createWeatherModel(world.seedHash >>> 0),
      terrain: { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: 0 },
      getPlayer: () => player, getTime: () => time, getSun: () => ({ sunElevation: 20, dayTime: 0.4 }), isInView: createView(player),
      placement, bus,
    });
    for (let level = 0; level < 3; level++) shedding.shedder.shed();
    const shedBias = sheddingManager.lodBiasHistory.at(-1);
    shedding.dispose();
    check('shedding', 'disposing a director at shed level 3 puts the LOD bias back to 1', shedBias === 0.5 && sheddingManager.lodBiasHistory.at(-1) === 1, `LOD bias ${sheddingManager.lodBiasHistory.join(' > ')}`);
  }

  const phaseOne = await loadPhaseOneGovernor();
  for (const [name, trace] of [['step load', LOAD_TRACE], ['oscillating load', OSCILLATING_TRACE]]) {
    const current = createGovernorHarness(createPerfGovernor);
    const reference = createGovernorHarness(phaseOne);
    driveGovernor(current, trace);
    driveGovernor(reference, trace);
    const now = JSON.stringify(current.state.perf.scaleHistory);
    const before = JSON.stringify(reference.state.perf.scaleHistory);
    check('shedding', `no shedder: dynamic resolution identical to Phase 1 (${name})`, now === before && current.state.perf.scaleHistory.length > 0, `${current.state.perf.scaleHistory.length} scale steps: ${current.state.perf.scaleHistory.map((entry) => `${entry.time}s ${entry.scale}`).join(', ')}`);
  }
}

// ============================================================================================
// PHASE 3 (contract i): the ground track, craft weighting, combos and global overrides
// ============================================================================================
/**
 * Flies a director over a custom path. player: { position, heading, speed, velocity? } (moved by
 * step(dt, time, player)); presets: the director's list (the stub manager knows the same list).
 * Returns { log, state, manager, events, world, sun, overrideEntries }.
 */
function runCustom({
  seed, presets = PRESETS, hours, player, step, siteChance = 0, getCraft = null, profileFor = undefined, sunStart = 0.72,
  naturalEnds = true, overrideSink = null, onStep = null, devHooks = true,
}) {
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const world = createWorldGen(seed, WORLD_OPTIONS);
  const weather = createWeatherModel(world.seedHash >>> 0);
  const placement = createStubPlacement(world.seedHash >>> 0, siteChance);
  const sun = createSun(sunStart);
  let time = 0;
  const getTime = () => time;
  const isInView = createView(player);
  const manager = createStubSpawnManager({ bus, player, getTime, placement, isInView, naturalEnds, presetById });
  const events = { comboStarted: [], globalOverride: [] };
  bus.onTyped('comboStarted', (payload) => events.comboStarted.push({ time, ...payload }));
  bus.onTyped('globalOverride', (payload) => events.globalOverride.push({ time, ...payload }));
  const director = createDirector({
    seedHash: world.seedHash >>> 0,
    presets,
    spawnManager: manager,
    weather,
    terrain: {
      heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: CONFIG.WATER_LEVEL, landmarkSitesNear: world.landmarkSitesNear,
      biomeKeys: world.BIOMES.map((biome) => biome.key),
    },
    getPlayer: () => player,
    getTime,
    getSun: () => sun.sun,
    isInView,
    placement,
    bus,
    getCraft,
    ...(profileFor !== undefined ? { profileFor } : {}),
    overrideSink,
    devHooks,
  });
  const totalSteps = Math.round((hours * 3600) / STEP_SECONDS);
  let nextManagerTick = 0;
  for (let index = 0; index <= totalSteps; index++) {
    time = index * STEP_SECONDS;
    step(STEP_SECONDS, time, player);
    sun.update(time);
    if (time >= nextManagerTick) {
      nextManagerTick += 0.5;
      manager.update();
    }
    director.update();
    if (onStep) onStep(director, time, sun.sun);
  }
  const state = director.getState();
  const log = director.getLog();
  const overrideEntries = director.getOverrides();
  director.dispose();
  return { log, state, manager, events, world, sun, overrideEntries, presetById };
}

/** A path step for a flight that moves along its velocity (the drift) whatever the nose says. */
function driftStep(dt, time, player) {
  player.position.x += player.velocity.x * dt;
  player.position.z += player.velocity.z * dt;
}

/** A createFlightPath wanderer with a velocity along its heading (ground track = heading). */
function wanderingPlayer(pathSeed, speed, altitude) {
  const path = createFlightPath({ pathSeed, speed, altitude });
  const player = path.player;
  player.velocity = { x: 0, y: 0, z: -speed };
  return {
    player,
    step(dt, time) {
      path.step(dt, time);
      const radians = (player.heading * Math.PI) / 180;
      player.velocity.x = Math.sin(radians) * speed;
      player.velocity.z = -Math.cos(radians) * speed;
    },
  };
}

function testTrack() {
  // A balloon drifting east on the wind, nose to the north: its content belongs on the drift line.
  const drifting = { position: { x: 0, y: 900, z: 0 }, heading: 0, speed: 1, velocity: { x: 8, y: 0, z: 0 } };
  const drift = runCustom({ seed: 'TRACK', hours: 3, player: drifting, step: driftStep, siteChance: TYPICAL_SITE_CHANCE });
  const records = drift.manager.records.filter((record) => record.source === 'director' && !record.site);
  const offTrack = records.map((record) => angleBetween(record.bearing, 90));
  const offNose = records.map((record) => angleBetween(record.bearing, 0));
  check('track', 'drifting east, nose north: every activation within 60 deg of the ground track', records.length > 0 && Math.max(...offTrack) <= MAX_OFF_AXIS_WIDE + 1e-9, `${records.length} activations, worst ${Math.max(...offTrack).toFixed(1)} deg off the track`);
  const besideNose = offNose.filter((angle) => angle > MAX_OFF_AXIS_WIDE).length;
  check('track', 'drifting: most activations lie outside the cone of the nose (the drift line wins)', besideNose > records.length * 0.5, `${besideNose}/${records.length} more than 60 deg off the nose`);

  // A hover (below 2 m/s over the ground) keeps the nose heading.
  const hovering = { position: { x: 0, y: 400, z: 0 }, heading: 200, speed: 0.6, velocity: { x: 0.6, y: 0, z: 0 } };
  const hover = runCustom({ seed: 'TRACK', hours: 1, player: hovering, step: driftStep });
  const hoverRecords = hover.manager.records.filter((record) => record.source === 'director');
  const hoverWorst = Math.max(...hoverRecords.map((record) => angleBetween(record.bearing, 200)));
  check('track', 'hovering (0.6 m/s): activations follow the nose heading', hoverRecords.length > 0 && hoverWorst <= MAX_OFF_AXIS_WIDE + 1e-9, `${hoverRecords.length} activations, worst ${hoverWorst.toFixed(1)} deg off the nose`);

  // Smoothing: a 90 degree turn of the ground track (east to north) settles over about a second.
  const turning = { position: { x: 0, y: 900, z: 0 }, heading: 90, speed: 30, velocity: { x: 30, y: 0, z: 0 } };
  const samples = [];
  runCustom({
    seed: 'TRACK', hours: 20 / 3600, player: turning,
    step(dt, time, player) {
      if (time >= 10) {
        player.velocity.x = 0;
        player.velocity.z = -30;
        player.heading = 0;
      }
      driftStep(dt, time, player);
    },
    onStep(director, time) {
      if (Math.abs(time - 9.5) < 1e-6 || Math.abs(time - 10.5) < 1e-6 || Math.abs(time - 14) < 1e-6) samples.push(director.getState().track);
    },
  });
  const [before, first, settled] = samples;
  check('track', 'a 90 degree turn: the track eases over 1 s (part way after one tick, settled after 4 s)', before === 90 && first < 90 && first > 0 && Math.min(settled, 360 - settled) <= 2, `track ${samples.join(' > ')} deg`);
}

/**
 * How much a log's director activations suit a profile: the mean craft weight of their presets (the
 * share above 1 is reported too).
 */
function favouredShare(log, profile, altitude) {
  const entries = log.filter((entry) => entry.reason === 'schedule' || entry.reason === 'drought');
  const values = entries.map((entry) => craftWeight(PRESET_BY_ID.get(entry.presetId), profile, altitude));
  const mean = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return { mean, share: values.length > 0 ? values.filter((value) => value > 1).length / values.length : 0, count: entries.length };
}

function testCraftWeighting() {
  const profiles = DEFAULT_DIRECTOR_PROFILES;
  const byId = (id) => PRESET_BY_ID.get(id);
  const units = [
    ['seaplane on a whale pod (water, coast)', craftWeight(byId('whalePod'), profiles.seaplane, 500), 1.8 * 1.4],
    ['eagle on thermal hawks (thermal)', craftWeight(byId('hawks'), profiles.eagle, 500), 2],
    ['eagle on a murmuration (murmuration)', craftWeight(byId('murmuration'), profiles.eagle, 500), 1.8],
    ['spaceplane below 20 km on a comet', craftWeight(byId('comet'), profiles.spaceplane, 15000), 1],
    ['spaceplane above 20 km on a comet (celestial x farLure, clamped)', craftWeight(byId('comet'), profiles.spaceplane, 25000), CRAFT_WEIGHT_RANGE.max],
    ['spaceplane above 20 km on geese (wildlife, clamped)', craftWeight(byId('geese'), profiles.spaceplane, 25000), CRAFT_WEIGHT_RANGE.min],
    ['balloon on a glory (calm x slow x spectacle, clamped)', craftWeight(byId('glory'), profiles.balloon, 800), CRAFT_WEIGHT_RANGE.max],
    ['no profile', craftWeight(byId('comet'), null, 25000), 1],
  ];
  const wrong = units.filter(([, value, expected]) => Math.abs(value - expected) > 1e-9);
  check('craft', 'craftWeight: profile favour, above bands and the 0.25..3 clamp', wrong.length === 0, wrong.length ? wrong.map(([name, value, expected]) => `${name}: ${value} (expected ${expected})`).join('; ') : units.map(([name, value]) => `${name} ${Math.round(value * 100) / 100}`).join(', '));

  // The same seed and path flown by different craft: the favoured share rises.
  const cases = [
    { craft: 'seaplane', speed: 55, altitude: [150, 600], hours: 6 },
    { craft: 'eagle', speed: 25, altitude: [300, 1200], hours: 6 },
    { craft: 'balloon', speed: 8, altitude: [600, 1500], hours: 6 },
    { craft: 'spaceplane', speed: 220, altitude: [24000, 30000], hours: 6 },
  ];
  for (const entry of cases) {
    const fly = (craft) => {
      const wanderer = wanderingPlayer(`craft-${entry.craft}`, entry.speed, entry.altitude);
      return runCustom({ seed: 'CRAFT-WEIGHT', hours: entry.hours, player: wanderer.player, step: (dt, time) => wanderer.step(dt, time), siteChance: TYPICAL_SITE_CHANCE, getCraft: () => craft });
    };
    const baseline = fly('glider');
    const weighted = fly(entry.craft);
    const altitude = (entry.altitude[0] + entry.altitude[1]) / 2;
    const before = favouredShare(baseline.log, profiles[entry.craft], altitude);
    const after = favouredShare(weighted.log, profiles[entry.craft], altitude);
    const tiersBefore = tierIntervals(baseline.log.filter((item) => item.reason !== 'debug'), entry.hours);
    const tiersAfter = tierIntervals(weighted.log.filter((item) => item.reason !== 'debug'), entry.hours);
    const tierText = RARITY_TIERS.map((tier) => `${tier} ${tiersBefore[tier].count}>${tiersAfter[tier].count}`).join(', ');
    check('craft', `${entry.craft}: favoured presets win more often than for the glider on the same path (${entry.hours} h)`, after.mean > before.mean && after.count > 0,
      `mean craft weight ${before.mean.toFixed(3)} > ${after.mean.toFixed(3)} (favoured ${(before.share * 100).toFixed(1)} % > ${(after.share * 100).toFixed(1)} %) of ${before.count} / ${after.count} activations; tiers ${tierText}`);
    check('craft', `${entry.craft}: every log entry records the craft`, weighted.log.length > 0 && weighted.log.every((item) => item.craft === entry.craft), `${weighted.log.length} entries`);
    if (entry.craft === 'seaplane') {
      const again = fly('seaplane');
      check('craft', 'seaplane twice on the same path: identical logs; the glider: a different hash', JSON.stringify(again.log) === JSON.stringify(weighted.log) && weighted.state.logHash !== baseline.state.logHash, `hash ${weighted.state.logHash} / ${again.state.logHash}, glider ${baseline.state.logHash}`);
    }
  }

  // A module's own directorProfile wins over the defaults.
  const own = { favor: { tags: { celestial: 3 } } };
  const wanderer = wanderingPlayer('craft-module', 55, [300, 900]);
  const moduleRun = runCustom({ seed: 'CRAFT-WEIGHT', hours: 4, player: wanderer.player, step: (dt, time) => wanderer.step(dt, time), siteChance: TYPICAL_SITE_CHANCE, getCraft: () => 'seaplane', profileFor: () => own });
  check('craft', "a module's directorProfile replaces the default profile", Object.keys(moduleRun.state.craftWeights).every((id) => (PRESET_BY_ID.get(id).tags || []).includes('celestial')) && Object.keys(moduleRun.state.craftWeights).length > 0, `weighted presets: ${JSON.stringify(moduleRun.state.craftWeights)}`);
}

// ---- Combos ---------------------------------------------------------------------------------------
const COMBO_DESPAWN = Object.freeze({ distance: 14000, hysteresis: 3000, outOfViewSeconds: 30 });
function comboPreset(id, block, { engines = ['lightEffect'], filters = {}, candidates = { cellSize: 5000, bucketSeconds: 300, chance: 0.9 }, duration = [240, 300] } = {}) {
  return Object.freeze({
    ...eventPreset(id, 'celestial', 'legendary', { engines, filters: { minDistance: 3000, maxDistance: 9000, ...filters }, candidates, duration, tags: ['spectacle'] }),
    lifetime: { duration, despawn: COMBO_DESPAWN },
    combo: block,
  });
}
const COMBO_NIGHT_SKY = comboPreset('comboNightSky', {
  preconditions: { timeOfDay: ['night'], biomes: ['snow', 'pine', 'meadows'] },
  members: [{ presetId: 'meteorShower', role: 'anchor' }, { presetId: 'comet', place: { bearing: 30, distance: 4000, jitter: 600 }, delay: 20 }],
  exclusive: true,
  heavySlots: 1,
});
const COMBO_MONOLITH = comboPreset('comboMonolith', {
  preconditions: { timeOfDay: ['day'], near: { landmarks: ['monoliths'], radius: 6000 } },
  members: [{ presetId: 'eclipse', role: 'anchor' }, { presetId: 'glory', place: { bearing: -40, distance: 2500, jitter: 300 } }],
});
const COMBO_VOLCANO = comboPreset('comboVolcano', {
  preconditions: { siteActive: ['volcano'] },
  members: [{ presetId: 'microburst', place: { bearing: 0, distance: 1500 } }, { presetId: 'lanterns', place: { bearing: 90, distance: 2000, jitter: 200 }, delay: 45 }],
}, { filters: { minDistance: 3000, maxDistance: 12000 } });
// The volcano fixture erupts often (common, its active state on most of its buckets), so a combo
// waiting for an active volcano gets its chances in a few hours.
const FREQUENT_VOLCANO = Object.freeze({ ...sitePreset('volcano', 'geo', 'common', { heavy: true, activeState: { duration: [600, 900] }, engines: ['structure', 'emitter'], tags: ['spectacle', 'farLure'] }) });
const COMBO_PRESETS = Object.freeze([...STUB_PRESETS.map((preset) => (preset.id === 'volcano' ? FREQUENT_VOLCANO : preset)), COMBO_NIGHT_SKY, COMBO_MONOLITH, COMBO_VOLCANO]);

/** Combo starts in a run: each with its member records (by parent) and its spawn ids. */
function combosOf(run) {
  const starts = run.log.filter((entry) => entry.members);
  return starts.map((entry) => {
    const records = run.manager.records.filter((record) => record.parent === entry.combo && !record.refused);
    const main = records.find((record) => record.presetId === entry.presetId);
    const members = records.filter((record) => record !== main);
    const ids = new Set(records.map((record) => record.id));
    const endTimes = run.manager.ends.filter((end) => ids.has(end.id)).map((end) => end.time);
    return { entry, main, members, end: endTimes.length === records.length && endTimes.length > 0 ? Math.max(...endTimes) : Infinity };
  });
}

/** The angle-free checks of a member's placement: the anchor at the combo point, others in their ring. */
function placementError(combo, presetById, log) {
  const block = presetById.get(combo.entry.presetId).combo;
  for (let index = 0; index < block.members.length; index++) {
    const member = block.members[index];
    const record = combo.members.find((candidate) => candidate.presetId === member.presetId);
    const dropped = log.some((entry) => entry.reason === 'comboMemberDropped' && entry.candidateId === `${combo.entry.combo}#${index}`);
    if (!record && dropped) continue;
    if (!record) return `member ${member.presetId} never started`;
    const distance = Math.hypot(record.x - combo.main.x, record.z - combo.main.z);
    if (member.role === 'anchor' || !member.place) {
      if (distance > 1e-6) return `anchor ${member.presetId} ${distance.toFixed(1)} m from the combo`;
      continue;
    }
    const jitter = member.place.jitter || 0;
    if (distance < member.place.distance - jitter - 1 || distance > member.place.distance + jitter + 1) return `${member.presetId} at ${distance.toFixed(0)} m (wanted ${member.place.distance} +- ${jitter})`;
  }
  return '';
}

function testCombos() {
  const flyNight = () => {
    const wanderer = wanderingPlayer('combo-night', 55, [400, 1400]);
    return runCustom({ seed: 'COMBO', presets: COMBO_PRESETS, hours: 12, player: wanderer.player, step: (dt, time) => wanderer.step(dt, time), siteChance: TYPICAL_SITE_CHANCE });
  };
  const run = flyNight();
  const presetById = run.presetById;
  const combos = combosOf(run);
  const byPreset = (id) => combos.filter((combo) => combo.entry.presetId === id);
  check('combos', 'combos start in a long flight (night sky, monoliths, volcano fixtures)', byPreset('comboNightSky').length > 0 && byPreset('comboMonolith').length > 0,
    `${combos.length} combos in 12 h: ${['comboNightSky', 'comboMonolith', 'comboVolcano'].map((id) => `${id} ${byPreset(id).length}`).join(', ')}`);

  // Preconditions at the start.
  const preconditionBreaks = [];
  for (const combo of combos) {
    const time = combo.entry.time;
    const dayTime = (0.72 + time / CONFIG.DAY_LENGTH_DEFAULT) % 1;
    const elevation = Math.sin((dayTime - 0.25) * Math.PI * 2) * CONFIG.SUN_MAX_ELEVATION_DEG;
    const preconditions = presetById.get(combo.entry.presetId).combo.preconditions;
    if (preconditions.timeOfDay && !matchesTimeOfDay(preconditions.timeOfDay, elevation, dayTime)) preconditionBreaks.push(`${combo.entry.combo} timeOfDay`);
    if (preconditions.biomes && !preconditions.biomes.includes(run.world.biomeAt(combo.main.x, combo.main.z).key)) preconditionBreaks.push(`${combo.entry.combo} biome`);
    if (preconditions.near && !run.world.landmarkSitesNear(combo.main.x, combo.main.z, 1).some((site) => preconditions.near.landmarks.includes(site.type) && site.x === combo.main.x && site.z === combo.main.z)) preconditionBreaks.push(`${combo.entry.combo} not on a monolith`);
  }
  check('combos', 'every combo started with its preconditions holding (night / biome; day / on a monolith circle)', preconditionBreaks.length === 0 && combos.length > 0, preconditionBreaks.join(', ') || `${combos.length} checked`);

  // Members: placement, parents, delays, log order and the event.
  const placementBreaks = combos.map((combo) => placementError(combo, presetById, run.log)).filter(Boolean);
  check('combos', 'members placed deterministically: the anchor on the combo point, the others on their ring (distance +- jitter)', placementBreaks.length === 0 && combos.length > 0, placementBreaks.join('; ') || `${combos.reduce((sum, combo) => sum + combo.members.length, 0)} members`);
  const parentBreaks = combos.filter((combo) => !combo.main || combo.main.parent !== combo.entry.combo || combo.members.some((record) => record.parent !== combo.entry.combo));
  check('combos', "the combo and its members start through the manager with source 'director' and the combo id as parent", parentBreaks.length === 0 && combos.every((combo) => combo.main.source === 'director'), `${parentBreaks.length} with a wrong parent`);
  const delayBreaks = [];
  for (const combo of combos) {
    const block = presetById.get(combo.entry.presetId).combo;
    for (const member of block.members) {
      const record = combo.members.find((candidate) => candidate.presetId === member.presetId);
      if (!record) continue;
      const late = record.time - combo.entry.time - (member.delay || 0);
      if (late < -1e-6 || late > COMBO_MEMBER_PATIENCE) delayBreaks.push(`${member.presetId} ${late.toFixed(1)} s`);
    }
  }
  check('combos', 'members start at their delay (comet 20 s and lanterns 45 s after their combo)', delayBreaks.length === 0 && combos.length > 0, delayBreaks.join(', ') || 'all on time');
  const logBreaks = combos.filter((combo) => {
    const block = presetById.get(combo.entry.presetId).combo;
    const memberEntries = run.log.filter((entry) => entry.combo === combo.entry.combo && (entry.reason === 'comboMember' || entry.reason === 'comboMemberDropped'));
    return JSON.stringify(combo.entry.members) !== JSON.stringify(block.members.map((member) => member.presetId)) || memberEntries.length !== block.members.length;
  });
  const eventBreaks = combos.filter((combo) => !run.events.comboStarted.some((event) => event.id === combo.entry.combo && event.presetId === combo.entry.presetId && JSON.stringify(event.members) === JSON.stringify(combo.entry.members)));
  check('combos', 'the log records each combo with its members in order (and a comboMember or comboMemberDropped entry each); comboStarted fires', logBreaks.length === 0 && eventBreaks.length === 0 && run.events.comboStarted.length === combos.length, `${combos.length} combos, ${run.events.comboStarted.length} comboStarted events`);

  // Budgets and exclusivity.
  // A combo starts only when the budgets admit every member; a waiting member's heavy slot stays
  // reserved against the director's own activations, but a site coming into range may still take it
  // (the manager never refuses a site): then the member retries, and is dropped (logged) after
  // COMBO_MEMBER_PATIENCE.
  const memberRefusals = run.manager.records.filter((record) => record.parent !== null && record.refused);
  const dropped = run.log.filter((entry) => entry.reason === 'comboMemberDropped');
  const droppedOk = dropped.every((entry) => memberRefusals.some((record) => record.parent === entry.combo && record.presetId === entry.presetId && record.refused === 'heavy'));
  const reservationBreaks = [];
  for (const combo of combos) {
    const block = presetById.get(combo.entry.presetId).combo;
    block.members.forEach((member, index) => {
      if (!(member.delay > 0) || !presetById.get(member.presetId).heavy) return;
      const startedAt = combo.members.find((record) => record.presetId === member.presetId)?.time ?? dropped.find((entry) => entry.candidateId === `${combo.entry.combo}#${index}`)?.time ?? Infinity;
      for (const entry of run.log) {
        if ((entry.reason === 'schedule' || entry.reason === 'drought') && entry.time > combo.entry.time && entry.time < startedAt && presetById.get(entry.presetId).heavy) reservationBreaks.push(`${entry.presetId} at ${entry.time} s`);
      }
    });
  }
  check('combos', "budgets admit every member at the start; a waiting heavy member's slot is kept from the director's own heavy activations", run.manager.counters.maxHeavy <= DIRECTOR_BUDGETS.maxHeavy && droppedOk && reservationBreaks.length === 0,
    `peak heavy ${run.manager.counters.maxHeavy}; ${memberRefusals.length} member retries refused (${[...new Set(memberRefusals.map((record) => record.refused))].join(', ') || 'none'}), ${dropped.length} dropped after a site took the slot; ${reservationBreaks.length} director heavy starts while a member waited`);
  const legendaryStarts = run.log.filter((entry) => (entry.reason === 'schedule' || entry.reason === 'drought') && presetById.get(entry.presetId).rarity === 'legendary');
  const exclusiveBreaks = [];
  for (const combo of combos) {
    if (!presetById.get(combo.entry.presetId).combo.exclusive) continue;
    for (const entry of legendaryStarts) if (entry !== combo.entry && entry.time > combo.entry.time && entry.time < combo.end) exclusiveBreaks.push(`${entry.presetId} at ${entry.time} s inside ${combo.entry.combo}`);
  }
  check('combos', 'an exclusive combo keeps every other legendary out while it runs', exclusiveBreaks.length === 0 && byPreset('comboNightSky').length > 0, exclusiveBreaks.join(', ') || `${byPreset('comboNightSky').length} exclusive combos, ${legendaryStarts.length} legendary starts in all`);

  // The active-volcano precondition.
  // Only the volcano combo is legendary here, so every legendary turn waits for an eruption.
  const volcanoPresets = COMBO_PRESETS.filter((preset) => preset.rarity !== 'legendary' || preset.id === 'comboVolcano');
  const volcanoRun = (() => {
    const wanderer = wanderingPlayer('combo-volcano', 55, [400, 1400]);
    return runCustom({ seed: 'COMBO-VOLCANO', presets: volcanoPresets, hours: 12, player: wanderer.player, step: (dt, time) => wanderer.step(dt, time), siteChance: 0.2 });
  })();
  const volcanoCombos = combosOf(volcanoRun).filter((combo) => combo.entry.presetId === 'comboVolcano');
  const eruptions = volcanoRun.manager.records.filter((record) => record.presetId === 'volcano' && record.source === 'director' && !record.refused);
  const volcanoBreaks = volcanoCombos.filter((combo) => !eruptions.some((record) => record.time <= combo.entry.time && Math.hypot(record.x - combo.main.x, record.z - combo.main.z) <= 20000
    && !volcanoRun.manager.ends.some((end) => end.id === record.id && end.time <= combo.entry.time)));
  check('combos', 'siteActive: a volcano combo starts only with an erupting volcano within 20 km', volcanoCombos.length > 0 && volcanoBreaks.length === 0, `${volcanoCombos.length} volcano combos, ${eruptions.length} eruptions, ${volcanoBreaks.length} without one`);

  // Determinism and the forced combo.
  const again = flyNight();
  check('combos', 'same seed and path: identical logs with the combos', JSON.stringify(again.log) === JSON.stringify(run.log) && again.state.logHash === run.state.logHash, `${run.log.length} entries, hash ${run.state.logHash} / ${again.state.logHash}`);
  let forcedId = null;
  const forcedPlayer = { position: { x: 0, y: 800, z: 0 }, heading: 45, speed: 50, velocity: { x: 35.4, y: 0, z: -35.4 } };
  const forced = runCustom({
    seed: 'COMBO-FORCE', presets: COMBO_PRESETS, hours: 120 / 3600, player: forcedPlayer, step: driftStep, sunStart: 0.4,
    onStep(director, time) {
      if (forcedId === null && time >= 5) forcedId = director.forceSpawn('comboNightSky', { distance: 4000, force: true });
    },
  });
  const forcedMembers = forced.manager.records.filter((record) => record.parent === forcedId);
  const forcedComet = forcedMembers.find((record) => record.presetId === 'comet');
  check('combos', "forceSpawn starts a combo by day, its preconditions ignored (the F9 debugger's path), members on their delay", forcedId === 'combo:debug:1' && forcedMembers.length === 3 && forcedComet && Math.abs(forcedComet.time - 25) <= 0.6 && forced.log.some((entry) => entry.reason === 'debug' && entry.members),
    `${forcedId}: ${forcedMembers.map((record) => `${record.presetId} ${record.source} at ${record.time} s`).join(', ')}`);
}

// ---- Global overrides -------------------------------------------------------------------------------
const BLOOD_MOON_FIXTURE = Object.freeze({
  ...eventPreset('bloodMoonFixture', 'celestial', 'rare', { engines: ['celestial'], tags: ['celestial', 'night', 'spectacle'] }),
  override: { kind: 'bloodMoon', nightChance: 0.5, region: null },
});
const MIDNIGHT_SUN_FIXTURE = Object.freeze({
  ...eventPreset('midnightSunFixture', 'celestial', 'legendary', { engines: ['celestial'], tags: ['celestial', 'snow'] }),
  override: { kind: 'midnightSun', nightChance: 0.5, region: { biomes: ['snow'], blendKm: 3 } },
});
const OVERRIDE_PRESETS = Object.freeze([...STUB_PRESETS, BLOOD_MOON_FIXTURE, MIDNIGHT_SUN_FIXTURE]);

function testOverrides() {
  const nights = [[0.72, 1], [1.49, 1], [1.51, 2], [3.2, 3]].filter(([days, night]) => nightIndex(days) !== night);
  const windowValues = [0.5, 0.6, 0.67, 0.75, 0, 0.25, 0.33, 0.4].map((dayTime) => Math.round(nightWindow(dayTime) * 100) / 100);
  check('overrides', 'night index (noon to noon) and the night window (eased in by 0.70, out from 0.30)', nights.length === 0 && windowValues.join(',') === '0,0,0.5,1,1,1,0.5,0', `window at 0.5, 0.6, 0.67, 0.75, 0, 0.25, 0.33, 0.4: ${windowValues.join(', ')}`);

  const seedHash = hashString('OVERRIDES');
  const first = scheduledNights(seedHash, 'bloodMoon', 0.04, 0, 19999);
  const second = scheduledNights(seedHash, 'bloodMoon', 0.04, 0, 19999);
  const otherSeed = scheduledNights(hashString('OTHER'), 'bloodMoon', 0.04, 0, 19999);
  check('overrides', 'the schedule is deterministic per seed and preset, at its night chance (0.04 over 20000 nights)', JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(first) !== JSON.stringify(otherSeed) && Math.abs(first.length / 20000 - 0.04) < 0.005,
    `${first.length} nights (${(first.length / 200).toFixed(2)} %); first ${first.slice(0, 6).join(', ')}`);

  // The midnight sun's bend: never below the skim line at full weight, continuous, untouched by day.
  const direction = { x: 0, y: 0, z: 0 };
  let lowest = Infinity;
  let largestStep = 0;
  let previous = null;
  let dayChanged = 0;
  for (let index = 0; index <= 10000; index++) {
    const dayTime = index / 10000;
    const angle = (dayTime - 0.25) * Math.PI * 2;
    const elevation = Math.sin(angle) * CONFIG.SUN_MAX_ELEVATION_DEG * (Math.PI / 180);
    const azimuth = Math.PI / 2 + angle;
    direction.x = Math.sin(azimuth) * Math.cos(elevation);
    direction.y = Math.sin(elevation);
    direction.z = -Math.cos(azimuth) * Math.cos(elevation);
    const baseY = direction.y;
    applyMidnightSun(dayTime, direction, 1);
    const bent = (Math.asin(direction.y) * 180) / Math.PI;
    lowest = Math.min(lowest, bent);
    if (previous !== null) largestStep = Math.max(largestStep, Math.abs(bent - previous));
    previous = bent;
    if (Math.sin(elevation) > Math.sin(10 * (Math.PI / 180)) && direction.y !== baseY) dayChanged++;
  }
  check('overrides', 'the midnight sun skims the horizon: never below 1.5 deg at full weight, a continuous path, the day untouched', lowest >= MIDNIGHT_SUN_SKIM.midnight - 1e-9 && largestStep < 0.2 && dayChanged === 0, `lowest ${lowest.toFixed(2)} deg, largest step ${largestStep.toFixed(3)} deg per 0.0001 day, ${dayChanged} day samples changed`);

  // The regional blend over the real world: 1 in the snow, 0 beyond blendKm of it, a smooth ramp
  // between (the world's snow patches are 1.5-8 km across, so presets keep blendKm to a few km).
  const world = createWorldGen('OVERRIDE-REGION', WORLD_OPTIONS);
  const field = createRegionField({ biomes: ['snow'], blendKm: 3, biomeAt: world.biomeAt, biomeKeys: world.BIOMES.map((biome) => biome.key) });
  let snowPoint = null;
  let farPoint = null;
  for (let radius = 0; radius <= 400000 && (!snowPoint || !farPoint); radius += 2000) {
    for (let angle = 0; angle < 360 && (!snowPoint || !farPoint); angle += 15) {
      const x = Math.sin((angle * Math.PI) / 180) * radius;
      const z = -Math.cos((angle * Math.PI) / 180) * radius;
      const weight = field.weightAt(x, z);
      if (!snowPoint && weight === 1 && world.biomeAt(x, z).key === 'snow') snowPoint = { x, z };
      if (!farPoint && weight === 0) farPoint = { x, z };
    }
  }
  let rampStep = 0;
  let coverage = 0;
  if (snowPoint && farPoint) {
    const distance = Math.hypot(farPoint.x - snowPoint.x, farPoint.z - snowPoint.z);
    let last = null;
    for (let travelled = 0; travelled <= distance; travelled += 100) {
      const blend = travelled / distance;
      const weight = field.weightAt(snowPoint.x + (farPoint.x - snowPoint.x) * blend, snowPoint.z + (farPoint.z - snowPoint.z) * blend);
      if (last !== null) rampStep = Math.max(rampStep, Math.abs(weight - last));
      last = weight;
    }
    for (let index = 0; index < 400; index++) if (field.weightAt((index % 20) * 7919 - 79190, Math.floor(index / 20) * 7919 - 79190) === 1) coverage++;
  }
  check('overrides', 'regional blend (snow, 3 km): 1 over the snow, 0 beyond the blend, no step over 0.08 per 100 m between', snowPoint !== null && farPoint !== null && rampStep < 0.08,
    `snow ${JSON.stringify(snowPoint)}, clear ${JSON.stringify(farPoint)}, largest step ${rampStep.toFixed(3)}; full weight on ${(coverage / 4).toFixed(1)} % of a 150 km grid; ${field.cachedCells} cells cached`);

  // The director: overrides are never candidates; events, the sink and the once-a-night spawn follow
  // the schedule.
  const sinkLog = [];
  const sink = {
    apply(entry) {
      sinkLog.push({ id: entry.id, night: entry.night, weight: entry.weight, region: entry.region, scheduled: entry.scheduled });
    },
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  const wanderer = wanderingPlayer('override-path', 55, [400, 1400]);
  const hours = 2;
  const run = runCustom({ seed: 'OVERRIDES', presets: OVERRIDE_PRESETS, hours, player: wanderer.player, step: (dt, time) => wanderer.step(dt, time), overrideSink: sink });
  const overrideIds = new Set(['bloodMoonFixture', 'midnightSunFixture']);
  const asCandidates = run.log.filter((entry) => overrideIds.has(entry.presetId) && entry.reason !== 'override');
  check('overrides', 'override presets are never director candidates (only override entries in the log)', asCandidates.length === 0, `${run.log.filter((entry) => overrideIds.has(entry.presetId)).length} override entries, ${asCandidates.length} as candidates`);
  const lastNight = nightIndex(0.72 + (hours * 3600) / CONFIG.DAY_LENGTH_DEFAULT);
  const expected = scheduledNights(run.world.seedHash >>> 0, 'bloodMoonFixture', 0.5, 1, lastNight);
  const bloodStarts = run.events.globalOverride.filter((event) => event.id === 'override:bloodMoonFixture' && event.active && !run.events.globalOverride.some((other) => other.id === event.id && other.time < event.time && other.time > event.time - 60));
  const bloodNights = [...new Set(sinkLog.filter((entry) => entry.id === 'override:bloodMoonFixture' && entry.weight > 0).map((entry) => entry.night))];
  check('overrides', 'the blood moon shows exactly on its scheduled nights (globalOverride on start, half weight and end)', JSON.stringify(bloodNights) === JSON.stringify(expected.filter((night) => bloodNights.includes(night) || night < lastNight)) && bloodStarts.length > 0,
    `scheduled nights ${expected.join(', ')}; shown ${bloodNights.join(', ')}; ${run.events.globalOverride.filter((event) => event.id === 'override:bloodMoonFixture').length} events`);
  const fullAtMidnight = sinkLog.filter((entry) => entry.id === 'override:bloodMoonFixture' && entry.scheduled && entry.weight === 1).length > 0;
  const quietOff = sinkLog.filter((entry) => !entry.scheduled && entry.weight !== 0).length === 0;
  check('overrides', 'the sink gets every entry: full weight in a scheduled night, 0 on the others; disposed with the director', fullAtMidnight && quietOff && sink.disposed, `${sinkLog.length} sink calls`);
  const regionBreaks = sinkLog.filter((entry) => entry.id === 'override:midnightSunFixture' && entry.scheduled && entry.weight > entry.region + 1e-9);
  check('overrides', 'the midnight sun is weighted by its region (never above the snow share at the player)', regionBreaks.length === 0, `${sinkLog.filter((entry) => entry.id === 'override:midnightSunFixture' && entry.weight > 0).length} weighted ticks, region at the end ${run.overrideEntries.find((entry) => entry.presetId === 'midnightSunFixture').region.toFixed(3)}`);
  const bloodSpawns = run.manager.records.filter((record) => record.presetId === 'bloodMoonFixture' && !record.refused);
  const bloodEnds = run.manager.ends.filter((end) => end.presetId === 'bloodMoonFixture');
  const highNights = [...new Set(sinkLog.filter((entry) => entry.id === 'override:bloodMoonFixture' && entry.weight >= 0.5).map((entry) => entry.night))];
  check('overrides', "the override's own preset starts once per night from half weight (its discovery) and ends with it", bloodSpawns.length === highNights.length && bloodEnds.every((end) => end.reason === 'override' || end.reason === 'ended' || end.reason === 'dispose'), `${bloodSpawns.length} spawns for ${highNights.length} nights; ends ${JSON.stringify(bloodEnds.map((end) => end.reason))}`);

  // forceSpawn: the debugger forces an override on the current night.
  let forcedId = null;
  const forcedSink = [];
  const unscheduled = (() => {
    for (let night = 1; night < 400; night++) if (!scheduledNights(createWorldGen('OVERRIDES-FORCE', WORLD_OPTIONS).seedHash >>> 0, 'bloodMoonFixture', 0.5, night, night).length) return night;
    return null;
  })();
  const forcedPlayer = { position: { x: 0, y: 800, z: 0 }, heading: 0, speed: 40, velocity: { x: 0, y: 0, z: -40 } };
  runCustom({
    seed: 'OVERRIDES-FORCE', presets: OVERRIDE_PRESETS, hours: 300 / 3600, player: forcedPlayer, step: driftStep, sunStart: unscheduled - 1 + 0.6,
    overrideSink: { apply(entry) { if (entry.id === 'override:bloodMoonFixture') forcedSink.push(entry.weight); }, dispose() {} },
    onStep(director, time) {
      if (forcedId === null && time >= 1) forcedId = director.forceSpawn('bloodMoonFixture');
    },
  });
  check('overrides', 'forceSpawn forces an override on an unscheduled night (it shows from the evening)', forcedId === 'override:bloodMoonFixture' && Math.max(...forcedSink) === 1, `night ${unscheduled}: ${forcedId}, peak weight ${Math.max(...forcedSink)}`);
}

/** The preset validator's combo, override and tags rules, on full presets cloned from the game's. */
function testComboSchema() {
  const meteor = GAME_PRESETS.find((preset) => preset.id === 'meteorShower');
  const base = { ...meteor, id: 'comboSchemaTest', rarity: 'legendary' };
  const valid = Object.freeze({
    ...base,
    tags: ['celestial', 'night'],
    combo: {
      preconditions: { timeOfDay: ['night'], biomes: ['snow'], siteActive: ['volcano'], near: { landmarks: ['monoliths'], sites: ['crystalSpires'], radius: 6000 } },
      members: [{ presetId: 'meteorShower', role: 'anchor' }, { presetId: 'comet', place: { bearing: 30, distance: 4000, jitter: 600 }, delay: 20 }],
      exclusive: true,
      heavySlots: 2,
    },
  });
  const override = Object.freeze({ ...meteor, id: 'overrideSchemaTest', override: { kind: 'midnightSun', nightChance: 0.04, region: { biomes: ['snow'], blendKm: 20 } } });
  let validError = '';
  try {
    validatePresets([...GAME_PRESETS, valid, override]);
  } catch (error) {
    validError = error.message;
  }
  check('schema', 'a full combo and an override preset validate with the 30 game presets', validError === '', validError || 'valid');
  const broken = [
    ['a combo that is not legendary', { ...valid, rarity: 'rare' }],
    ['a member that names no preset', { ...valid, combo: { ...valid.combo, members: [{ presetId: 'nothingHere', role: 'anchor' }] } }],
    ['a member that is a site', { ...valid, combo: { ...valid.combo, members: [{ presetId: 'volcano', role: 'anchor' }] } }],
    ['two anchors', { ...valid, combo: { ...valid.combo, members: [{ presetId: 'meteorShower', role: 'anchor' }, { presetId: 'comet', role: 'anchor' }] } }],
    ['siteActive on a site without an active state', { ...valid, combo: { ...valid.combo, preconditions: { siteActive: ['geyserField'] } } }],
    ['a member without a place', { ...valid, combo: { ...valid.combo, members: [{ presetId: 'comet' }] } }],
    ['an unknown tag', { ...valid, tags: ['banana'] }],
    ['a repeated tag', { ...valid, tags: ['night', 'night'] }],
    ['an override on a combo', { ...valid, override: { kind: 'bloodMoon', nightChance: 0.1, region: null } }],
    ['an unknown override kind', { ...override, override: { kind: 'aurora', nightChance: 0.1, region: null } }],
  ];
  const accepted = [];
  for (const [label, preset] of broken) {
    try {
      validatePresets([...GAME_PRESETS, Object.freeze(preset)]);
      accepted.push(label);
    } catch (error) {
      verbose(`schema refuses ${label}: ${error.message}`);
    }
  }
  check('schema', `the validator refuses broken combo, override and tags blocks (${broken.length} cases)`, accepted.length === 0, accepted.length ? `accepted: ${accepted.join(', ')}` : 'all refused');
}

// ============================================================================================
// RUN
// ============================================================================================
/** Real mode: pacing in a world with the real presets' sites (their real placement), bush plane speed. */
function testRealWorldPacing() {
  const hours = Math.min(OPTIONS.hours, 6);
  const run = runScenario({ seed: 'RARITY', pathSeed: 'rarity-bushplane', hours, craft: 'bushplane', siteChance: 1 });
  for (const entry of run.longDroughts.slice(0, 6)) verbose(`long drought (real world): ${JSON.stringify(entry)}`);
  const counts = run.log.reduce((all, entry) => ({ ...all, [entry.presetId]: (all[entry.presetId] || 0) + 1 }), {});
  verbose(`real world: ${run.log.length} activations ${JSON.stringify(counts)}, ${run.notables.length} sites came into view`);
  check('pacing', `real presets, real sites (${hours} h, bush plane): >= ${TYPICAL_WORLD_SHARE * 100} % of droughts end within ${PACING_WINDOW_MAX} s`, windowShare(run.state.pacing) >= TYPICAL_WORLD_SHARE,
    `${describePacing({ pacing: run.state.pacing, longest: run.state.longestDrought, fills: run.state.droughtFills })}; ${run.notables.length} sites came into view; activations ${JSON.stringify(counts)}`);
}

/**
 * filters.near on its own: a director with one common event gathered at lighthouses and balloon fairs
 * (the sky lantern festival's rule) flies a long path over the real world; every activation must sit
 * on such a landmark, ahead and inside the band. A terrain without landmarkSitesNear never activates it.
 */
function testNearFilter() {
  const nearPreset = Object.freeze({
    id: 'nearTest', name: 'nearTest', category: 'celestial', kind: 'event', rarity: 'common', heavy: false,
    candidates: { cellSize: 3500, bucketSeconds: 300, chance: 0.6 },
    filters: { minDistance: 3000, maxDistance: 8000, near: { landmarks: ['lighthouse', 'balloons'], radius: 4000 } },
    engines: [{ engine: 'emitter', params: {} }],
    lifetime: { duration: [60, 90], despawn: DESPAWN },
  });
  // A second common event, so the no-repeat rule lets the near preset come back again and again.
  const filler = eventPreset('nearFiller', 'wildlife', 'common', { candidates: { cellSize: 3500, bucketSeconds: 300, chance: 0.6 }, duration: [60, 90] });
  function run(withLandmarks) {
    const world = createWorldGen('NEAR-LAB', WORLD_OPTIONS);
    const path = createFlightPath({ pathSeed: 'near-lab', ...SPEEDS.bushplane });
    const sun = createSun();
    let time = 0;
    const activations = [];
    const live = new Map();
    const manager = {
      activate(presetId, options) {
        const id = `near:${time}`;
        if (presetId !== nearPreset.id) {
          live.set(id, { anchor: { ...options.position }, radius: 300, heavy: false, ended: false, startedAt: time, duration: options.duration });
          return id;
        }
        const distance = Math.hypot(options.position.x - path.player.position.x, options.position.z - path.player.position.z);
        const offAxis = angleBetween(bearingDegrees(path.player.position.x, path.player.position.z, options.position.x, options.position.z), path.player.heading);
        activations.push({ x: options.position.x, z: options.position.z, distance, offAxis });
        live.set(id, { anchor: { ...options.position }, radius: 300, heavy: false, ended: false, startedAt: time, duration: options.duration });
        return id;
      },
      deactivate(id) { return live.delete(id); },
      getActive: () => [...live.values()],
      getInstance: (id) => live.get(id) ?? null,
      getStats: () => ({ engines: {}, total: { lights: 0 } }),
    };
    const terrain = { heightAt: world.heightAt, biomeAt: world.biomeAt, waterLevel: CONFIG.WATER_LEVEL };
    if (withLandmarks) terrain.landmarkSitesNear = world.landmarkSitesNear;
    const director = createDirector({
      seedHash: world.seedHash >>> 0, presets: [nearPreset, filler], spawnManager: manager, weather: createWeatherModel(world.seedHash >>> 0), terrain,
      getPlayer: () => path.player, getTime: () => time, getSun: () => sun.sun, isInView: createView(path.player),
    });
    for (let step = 0; step <= Math.round(3600 / STEP_SECONDS); step++) {
      time = step * STEP_SECONDS;
      path.step(STEP_SECONDS, time);
      sun.update(time);
      for (const [id, instance] of live) if (time - instance.startedAt > instance.duration) live.delete(id);
      director.update();
    }
    director.dispose();
    return { world, activations };
  }
  const { world, activations } = run(true);
  const onLandmark = activations.filter((entry) => world.landmarkSitesNear(entry.x, entry.z, 1).some((site) => (site.type === 'lighthouse' || site.type === 'balloons') && site.x === entry.x && site.z === entry.z));
  const ahead = activations.every((entry) => entry.offAxis <= MAX_OFF_AXIS_WIDE && entry.distance >= 3000 && entry.distance <= 8000);
  check('near', 'every activation of a near-filtered preset sits on a lighthouse or balloon fair, ahead and in its band', activations.length > 0 && onLandmark.length === activations.length && ahead, `${onLandmark.length}/${activations.length} on a landmark in 1 h; ahead and in band: ${ahead}`);
  const without = run(false);
  check('near', 'without landmarkSitesNear a near-filtered preset never activates', without.activations.length === 0, `${without.activations.length} activations`);
}

/**
 * --presets real: which of the game's presets filled the drought flights, per speed (a report next to
 * the pacing checks, which run on the same presets).
 */
function reportRealPresets() {
  for (const craft of Object.keys(SPEEDS)) {
    const run = runScenario({ seed: 'DROUGHT', pathSeed: `drought-${craft}`, hours: 3, craft, siteChance: 0 });
    const counts = {};
    for (const entry of run.log) counts[entry.presetId] = (counts[entry.presetId] || 0) + 1;
    const reasons = {};
    for (const drought of run.longDroughts) {
      const key = `sun ${drought.sun >= 0 ? 'up' : 'down'}, ${drought.weather}`;
      reasons[key] = (reasons[key] || 0) + 1;
    }
    check('real', `${craft}: activations of the game's ${PRESETS.length} presets in 3 h (report)`, true, `${describePacing({ craft: '', longest: run.state.longestDrought, fills: run.state.droughtFills, pacing: run.state.pacing })}; ${JSON.stringify(counts)}; droughts past 90 s sampled: ${JSON.stringify(reasons)}`);
  }
}

const started = Date.now();
testPacing();
if (REAL_MODE) {
  testRealWorldPacing();
  reportRealPresets();
} else {
  testLongFlight();
  testLifetimes();
  testFrameworkShape();
  testDeferral();
  testDeterminism();
  testWeather();
  await testShedding();
  testNearFilter();
  testTrack();
  testCraftWeighting();
  testCombos();
  testOverrides();
  testComboSchema();
}
const wallSeconds = (Date.now() - started) / 1000;

const groupWidth = Math.max(...results.map((result) => result.group.length));
const nameWidth = Math.min(80, Math.max(...results.map((result) => result.name.length)));
process.stdout.write(`${'check'.padEnd(groupWidth)}  ${'what'.padEnd(nameWidth)}  result  detail\n`);
process.stdout.write(`${'-'.repeat(groupWidth)}  ${'-'.repeat(nameWidth)}  ------  ------\n`);
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.group.padEnd(groupWidth)}  ${result.name.padEnd(nameWidth)}  ${result.pass ? 'PASS  ' : 'FAIL  '}  ${result.detail}\n`);
}
process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} director checks (${wallSeconds.toFixed(1)} s wall time)\n`);
process.exitCode = failed === 0 ? 0 : 1;
