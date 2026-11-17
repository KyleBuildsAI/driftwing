import { storage } from '../core/storage.js';
import { EVENT_TYPES, JOURNAL_STAT_OPS } from '../core/events.js';
import { LANDING_GRADES, isBetterLanding } from '../flight/landing.js';
import { FIGURES, FIGURE_IDS } from '../flight/maneuverRecognizer.js';
import { PRESETS, PRESET_BY_ID } from '../spawns/presets/index.js';
import { PRESET_CATEGORIES } from '../spawns/schema.js';
import { craftRegistry } from '../craft/registry.js';

/** Where the global records (achievements and bests across every world) are kept. */
export const RECORDS_STORAGE_KEY = 'driftwing-v2.records';
/**
 * The records' persisted version. Version 2 (Phase 3 wave 2) added craftTime and worldsVisited;
 * version 3 (Milestone O) adds figures, perches, skinTime and the maxAltitude statistic. Older
 * records migrate on load (migrateRecordsToV3) and are saved back at once as this version.
 */
export const RECORDS_VERSION = 3;

/**
 * The journal statistics the game knows (typed event journalStat): how each folds and what it
 * measures. Other keys are kept too, folded with the op they arrive with. The unit 'altitude' is
 * metres above sea level, shown in metres below 10 km and in kilometres above (space included).
 */
export const JOURNAL_STATS = Object.freeze({
  stormsChased: Object.freeze({ op: 'add', unit: 'count', label: 'Storms chased' }),
  closestTornado: Object.freeze({ op: 'min', unit: 'metres', label: 'Closest tornado' }),
  bestCanyonRun: Object.freeze({ op: 'min', unit: 'seconds', label: 'Best canyon run' }),
  maxAltitude: Object.freeze({ op: 'max', unit: 'altitude', label: 'Highest altitude' }),
});
/** The medals a challenge best can hold (challengeFinished's medal without 'none'). */
const MEDALS = Object.freeze(EVENT_TYPES.challengeFinished.medal.filter((medal) => medal !== 'none'));
/** The perch kinds of the typed 'perched' event (a terrain peak, a structure, a tree top). */
export const PERCH_KINDS = Object.freeze([...EVENT_TYPES.perched.kind]);
const STAT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
const CRAFT_ID_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
const MAX_CRAFT_TIMES = 64;
/** Skins kept per craft in skinTime (the eagle has two). */
const MAX_SKINS_PER_CRAFT = 8;
/** Worlds visited through portals kept in the records (the oldest drop first). */
const MAX_WORLDS_VISITED = 200;
const WORLD_SEED_PATTERN = /^[A-Z0-9-]{1,24}$/;
/** Counts (figures flown, perches landed) and flight seconds stop here: anything larger is storage damage. */
const MAX_COUNT = 1e9;
const MAX_SECONDS = 1e9;
/** A stored altitude above this (m) is storage damage, not flight (the spaceplane's ceiling is 150 km). */
const MAX_RECORDED_ALTITUDE = 1e7;
const FIGURE_ID_SET = new Set(FIGURE_IDS);
/** The figure each aerobatic best-score statistic belongs to (the version 3 migration reads them). */
const FIGURE_BY_STAT = new Map(FIGURES.map((figure) => [figure.stat, figure.id]));
/** The per-world journals the version 3 migration reads for the highest altitude flown before it. */
const JOURNAL_KEY_PREFIX = 'driftwing-v2.journal.';
const MAX_MIGRATED_JOURNALS = 1000;
/** Module statistics the version 3 migration takes as altitudes already reached. */
const MIGRATED_ALTITUDE_STATS = Object.freeze(['balloonMaxAltitude', 'spaceplaneApogee']);

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True for a storage key that matches pattern and is not an Object.prototype name (constructor, toString, ...). */
function isOwnKey(key, pattern) {
  return typeof key === 'string' && pattern.test(key) && !(key in Object.prototype);
}

/** A whole count in 0..MAX_COUNT (0 for anything unusable). */
function boundedCount(value) {
  return Math.min(MAX_COUNT, Math.max(0, Math.floor(finiteOr(value, 0))));
}

/** A figure score in 0..100 to 0.1, or null when unusable. */
function figureScore(value) {
  const score = finiteOr(value, NaN);
  return score >= 0 ? Math.round(Math.min(100, score) * 10) / 10 : null;
}

/** Positive flight seconds (capped), or null. */
function flightSeconds(value) {
  const seconds = finiteOr(value, NaN);
  return seconds > 0 ? Math.min(MAX_SECONDS, seconds) : null;
}

/** figures { [figureId]: { count, bestScore } } repaired: known figures only, flown at least once. */
function sanitizeFigures(raw) {
  const figures = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return figures;
  for (const id of FIGURE_IDS) {
    const entry = Object.hasOwn(raw, id) ? raw[id] : null;
    if (!entry || typeof entry !== 'object') continue;
    const count = boundedCount(entry.count);
    const bestScore = figureScore(entry.bestScore);
    if (count >= 1 && bestScore !== null) figures[id] = { count, bestScore };
  }
  return figures;
}

/** perches { count, kinds: { peak, structure, tree } } repaired: the count is at least the kinds' sum. */
function sanitizePerches(raw) {
  const perches = { count: 0, kinds: {} };
  for (const kind of PERCH_KINDS) perches.kinds[kind] = 0;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return perches;
  let sum = 0;
  if (raw.kinds && typeof raw.kinds === 'object' && !Array.isArray(raw.kinds)) {
    for (const kind of PERCH_KINDS) {
      perches.kinds[kind] = Object.hasOwn(raw.kinds, kind) ? boundedCount(raw.kinds[kind]) : 0;
      sum += perches.kinds[kind];
    }
  }
  perches.count = Math.min(MAX_COUNT, Math.max(boundedCount(raw.count), sum));
  return perches;
}

/** craftTime { [craftId]: seconds } repaired: craft-id keys, positive seconds, at most MAX_CRAFT_TIMES. */
function sanitizeCraftTime(raw) {
  const craftTime = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return craftTime;
  let kept = 0;
  for (const [craft, value] of Object.entries(raw)) {
    if (kept >= MAX_CRAFT_TIMES) break;
    const seconds = flightSeconds(value);
    if (!isOwnKey(craft, CRAFT_ID_PATTERN) || seconds === null) continue;
    craftTime[craft] = seconds;
    kept++;
  }
  return craftTime;
}

/** skinTime { [craftId]: { [skinId]: seconds } } repaired, capped per craft and in crafts. */
function sanitizeSkinTime(raw) {
  const skinTime = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return skinTime;
  let crafts = 0;
  for (const [craft, skins] of Object.entries(raw)) {
    if (crafts >= MAX_CRAFT_TIMES) break;
    const clean = sanitizeCraftTime(skins);
    const ids = Object.keys(clean).slice(0, MAX_SKINS_PER_CRAFT);
    if (!isOwnKey(craft, CRAFT_ID_PATTERN) || ids.length === 0) continue;
    skinTime[craft] = {};
    for (const skin of ids) skinTime[craft][skin] = clean[skin];
    crafts++;
  }
  return skinTime;
}

/**
 * Brings records loaded from version 1 or 2 up to version 3 (in place; `loaded` is already
 * sanitized). Version 1 had no craftTime or worldsVisited (they start empty, as version 2 read
 * them). Neither had figures, perches or the maxAltitude statistic, so those start from what the
 * older records already prove: each aerobatic figure's best-score statistic means that figure was
 * flown at least once with that score, the eagle's eaglePerches statistic is the perches landed
 * (their kinds were never kept), and the highest altitude is the highest of every world's journal
 * (its maxAltitude), the balloon's highest flight and the spaceplane's highest apogee.
 */
export function migrateRecordsToV3(loaded, readJournalMaxAltitudes = journalMaxAltitudes) {
  for (const [stat, figure] of FIGURE_BY_STAT) {
    const record = loaded.stats[stat];
    const bestScore = record ? figureScore(record.value) : null;
    if (bestScore !== null && !loaded.figures[figure]) loaded.figures[figure] = { count: 1, bestScore };
  }
  const eaglePerches = loaded.stats.eaglePerches;
  if (eaglePerches) loaded.perches.count = Math.max(loaded.perches.count, boundedCount(eaglePerches.value));
  if (!loaded.stats.maxAltitude) {
    let highest = { value: 0, seed: null };
    for (const key of MIGRATED_ALTITUDE_STATS) {
      const record = loaded.stats[key];
      if (record && record.value > highest.value && record.value <= MAX_RECORDED_ALTITUDE) highest = { value: record.value, seed: record.seed };
    }
    for (const journal of readJournalMaxAltitudes()) {
      if (journal.value > highest.value) highest = journal;
    }
    if (highest.value > 0) loaded.stats.maxAltitude = { value: Math.round(highest.value * 10) / 10, op: 'max', at: 0, seed: highest.seed, presetId: null };
  }
  return loaded;
}

/** The highest point of every stored per-world journal: [{ value (m), seed }] (at most MAX_MIGRATED_JOURNALS). */
function journalMaxAltitudes() {
  const highest = [];
  for (const key of storage.keys(JOURNAL_KEY_PREFIX).slice(0, MAX_MIGRATED_JOURNALS)) {
    const journal = storage.read(key, null);
    const value = journal && typeof journal === 'object' ? finiteOr(journal.maxAltitude, NaN) : NaN;
    const seed = key.slice(JOURNAL_KEY_PREFIX.length);
    if (value > 0 && value <= MAX_RECORDED_ALTITUDE) highest.push({ value, seed: WORLD_SEED_PATTERN.test(seed) ? seed : null });
  }
  return highest;
}

/**
 * The journal stats the registered craft modules declare (module journal.stats), rebuilt when a module
 * registers or is replaced (the cache keeps the module objects it was built from).
 */
const craftStats = { modules: [], stats: new Map() };
function craftJournalStats() {
  const registered = craftRegistry.list().filter((entry) => entry.available).map((entry) => craftRegistry.get(entry.id));
  const unchanged = registered.length === craftStats.modules.length && registered.every((module, index) => module === craftStats.modules[index]);
  if (unchanged) return craftStats.stats;
  craftStats.modules = registered;
  craftStats.stats = new Map();
  for (const module of registered) {
    const id = module.id;
    const stats = module.journal?.stats ?? [];
    for (const stat of stats) {
      if (!JOURNAL_STATS[stat.key]) craftStats.stats.set(stat.key, Object.freeze({ op: stat.op, unit: stat.unit, label: stat.label, craft: id }));
    }
  }
  return craftStats.stats;
}

/**
 * What a journal statistic is: { op, unit, label } for the game's own (JOURNAL_STATS) and every
 * registered craft module's journal.stats (contract h.2), or null for a key nobody declared.
 */
export function journalStatInfo(key) {
  return JOURNAL_STATS[key] ?? craftJournalStats().get(key) ?? null;
}

/**
 * Every journal statistic the game knows, in order: the game's own (JOURNAL_STATS, craft null), then
 * each registered craft module's journal.stats in catalog order (craft: its id). Each is
 * { key, op, unit, label, craft }.
 */
export function listJournalStats() {
  const list = Object.entries(JOURNAL_STATS).map(([key, stat]) => ({ key, op: stat.op, unit: stat.unit, label: stat.label, craft: null }));
  for (const [key, stat] of craftJournalStats()) list.push({ key, op: stat.op, unit: stat.unit, label: stat.label, craft: stat.craft });
  return list;
}

/**
 * JOURNAL: the per-seed discovery log. Records biomes visited, landmarks found, spawns discovered
 * (the typed 'discovery' events that carry a presetId: name, category, seed, coordinates, time of
 * day and the first-seen date), distance flown, highest altitude, flight time, ring-course results
 * (best clean time, best streak, the best result including misses and the last run) and graded
 * landings (count, last and best, from the typed 'landed' event), and persists them with `storage`
 * under `driftwing-v2.journal.<seed>`.
 *
 * The global records live under `driftwing-v2.records` (RECORDS_VERSION, migrated from every older
 * version on load), shared by every world: the journal statistics from the typed 'journalStat' events
 * (storms chased, closest tornado, best canyon run, each craft module's own journal.stats and any
 * other key a preset sends) plus the highest altitude ever flown (maxAltitude, op 'max', metres above
 * sea level, followed every frame, space included), the achievements from the typed 'achievement'
 * events, the best landing in any world, the flight time per craft (craftTime: seconds, counted every
 * frame of flight for the craft flying it) and per skin (skinTime, for a craft with skins), the
 * aerobatic figures flown (figures: count and best score per figure, from the typed 'figureFlown'
 * event), the perches landed (perches: count and kinds, from the typed 'perched' event when the bird
 * settles) and the worlds visited through portal rings (worldsVisited, from the typed 'worldVisited'
 * event, saved at once). Challenge medals and best times stay with the challenge system
 * (driftwing-v2.challenges); the journal reads them through ctx.systems.challenges.getRecords().
 *
 * The spawn collection counts implemented presets only: found / total over the spawn registry (the
 * SpawnManager's presets, which is PRESETS in a player's build).
 *
 * Saves are throttled (every ~5 s while flying: the journal, and the records whenever flight time,
 * the highest altitude, a figure or a perch changed them), immediate on discoveries, biome firsts,
 * finished ring courses, new best landings, statistics, achievements and worlds visited, and flushed
 * when the page hides.
 * Besides 'journal:changed' { reason }, the journal announces 'journal:discovery' { entry, found,
 * total }, 'journal:record' { key, value, previous, improved, op, presetId } and
 * 'journal:achievement' { entry } for the discovery toast and the map.
 */
export function createJournal(ctx) {
  const { bus, state, world } = ctx;
  const STORAGE_KEY = `driftwing-v2.journal.${state.seed}`;
  const SAVE_INTERVAL_SECONDS = 5;
  const STATS_EVENT_INTERVAL_SECONDS = 2;
  const MAX_LANDMARK_ENTRIES = 5000;
  const MAX_SPAWN_ENTRIES = 5000;
  const MAX_ACHIEVEMENTS = 500;
  const MAX_STATS = 200;
  const MAX_NAME_LENGTH = 80;
  const MAX_ID_LENGTH = 96;
  const MAX_DESCRIPTION_LENGTH = 240;
  const MAX_CRAFT_ID_LENGTH = 32;
  const VALID_BIOMES = new Set(world.BIOMES.map((biome) => biome.key));
  const VALID_TYPES = new Set(world.LANDMARK_TYPES);
  const VALID_CATEGORIES = new Set(PRESET_CATEGORIES);
  const VALID_SPAWN_KINDS = new Set(['site', 'event']);

  function finiteNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  function nonNegative(value) {
    return Math.max(0, finiteNumber(value, 0));
  }
  function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  function boundedString(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, maxLength) : null;
  }

  function createEmptyData() {
    return {
      seed: state.seed,
      biomesVisited: [],
      landmarksFound: [],
      distanceFlown: 0,
      maxAltitude: 0,
      flightTime: 0,
      ringCourses: { completed: 0, bestStreak: 0, bestTime: null, bestResult: null, lastResult: null },
      landings: { count: 0, best: null, last: null },
      spawnsFound: [],
    };
  }

  function createEmptyRecords() {
    return { stats: {}, achievements: [], bestLanding: null, craftTime: {}, skinTime: {}, worldsVisited: [], figures: {}, perches: sanitizePerches(null) };
  }

  /**
   * One graded landing as stored: { grade, sinkRate (m/s), groundSpeed (m/s), craft, at (ms epoch) },
   * or null when the values are unusable. Used for fresh landings and for repairing stored ones.
   */
  function sanitizeLanding(landing) {
    if (!landing || typeof landing !== 'object') return null;
    if (!LANDING_GRADES.includes(landing.grade)) return null;
    const sinkRate = finiteNumber(landing.sinkRate, NaN);
    if (!(sinkRate >= 0)) return null;
    const craft = typeof landing.craft === 'string' && landing.craft.length > 0 ? landing.craft.slice(0, MAX_CRAFT_ID_LENGTH) : 'unknown';
    return {
      grade: landing.grade,
      sinkRate: roundTo(sinkRate, 2),
      groundSpeed: roundTo(nonNegative(landing.groundSpeed), 1),
      craft,
      at: nonNegative(landing.at),
    };
  }

  /**
   * One finished course as stored: { passed, total, time } (time in seconds), or null when the
   * values are unusable. Used both for fresh results and for repairing stored ones.
   */
  function sanitizeCourseResult(result) {
    if (!result || typeof result !== 'object') return null;
    const total = Math.floor(nonNegative(result.total));
    const passed = Math.min(Math.floor(nonNegative(result.passed)), total);
    const time = finiteNumber(result.time, NaN);
    if (total <= 0 || !(time > 0)) return null;
    return { passed, total, time: roundTo(time, 2) };
  }

  /** True when `candidate` beats `current`: more of the course passed, then a faster time. */
  function isBetterCourse(candidate, current) {
    if (current === null) return true;
    const candidateShare = candidate.passed / candidate.total;
    const currentShare = current.passed / current.total;
    if (candidateShare !== currentShare) return candidateShare > currentShare;
    if (candidate.passed !== current.passed) return candidate.passed > current.passed;
    return candidate.time < current.time;
  }

  /** Validates one stored landmark entry; returns null when it is unusable. */
  function sanitizeLandmark(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 32) return null;
    if (!VALID_TYPES.has(entry.type)) return null;
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) return null;
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name.slice(0, MAX_NAME_LENGTH),
      x: Math.round(finiteNumber(entry.x, 0)),
      z: Math.round(finiteNumber(entry.z, 0)),
      biome: VALID_BIOMES.has(entry.biome) ? entry.biome : null,
      foundAt: finiteNumber(entry.foundAt, 0),
    };
  }

  /**
   * Validates one stored spawn discovery; returns null when it is unusable. Stored entries are
   * { id, presetId, name, category, kind, description, x, y, z, dayTime, timeLabel, seed, foundAt }.
   */
  function sanitizeSpawnEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = boundedString(entry.id, MAX_ID_LENGTH);
    const presetId = boundedString(entry.presetId, MAX_ID_LENGTH);
    const name = boundedString(entry.name, MAX_NAME_LENGTH);
    if (!id || !presetId || !name) return null;
    const dayTime = finiteNumber(entry.dayTime, NaN);
    return {
      id,
      presetId,
      name,
      category: VALID_CATEGORIES.has(entry.category) ? entry.category : 'flightplay',
      kind: VALID_SPAWN_KINDS.has(entry.kind) ? entry.kind : 'event',
      description: boundedString(entry.description, MAX_DESCRIPTION_LENGTH) ?? '',
      x: Math.round(finiteNumber(entry.x, 0)),
      y: Math.round(finiteNumber(entry.y, 0)),
      z: Math.round(finiteNumber(entry.z, 0)),
      dayTime: dayTime >= 0 && dayTime < 1 ? roundTo(dayTime, 4) : 0,
      timeLabel: boundedString(entry.timeLabel, 32) ?? '',
      seed: boundedString(entry.seed, 24) ?? state.seed,
      foundAt: nonNegative(entry.foundAt),
    };
  }

  /**
   * Validates one stored record statistic ({ value, op, at, seed, presetId }); null when unusable. A
   * known key (the game's or a craft module's) keeps its own op and never goes negative, and the
   * highest altitude never passes MAX_RECORDED_ALTITUDE.
   */
  function sanitizeStat(stat, key) {
    if (!stat || typeof stat !== 'object') return null;
    const value = finiteNumber(stat.value, NaN);
    if (!Number.isFinite(value) || !JOURNAL_STAT_OPS.includes(stat.op)) return null;
    const known = journalStatInfo(key);
    if (known && !(value >= 0)) return null;
    if (key === 'maxAltitude' && value > MAX_RECORDED_ALTITUDE) return null;
    return {
      value,
      op: known ? known.op : stat.op,
      at: nonNegative(stat.at),
      seed: boundedString(stat.seed, 24),
      presetId: boundedString(stat.presetId, MAX_ID_LENGTH),
    };
  }

  /** Validates one stored achievement ({ id, title, at, seed }); null when unusable. */
  function sanitizeAchievement(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const id = boundedString(entry.id, MAX_ID_LENGTH);
    const title = boundedString(entry.title, MAX_NAME_LENGTH);
    if (!id || !title) return null;
    return { id, title, at: nonNegative(entry.at), seed: boundedString(entry.seed, 24) };
  }

  /** Reads the stored journal for this seed, repairing anything malformed. */
  function loadData() {
    const data = createEmptyData();
    const stored = storage.read(STORAGE_KEY, null);
    if (!stored || typeof stored !== 'object') return data;
    if (typeof stored.seed === 'string' && stored.seed !== state.seed) return data;
    if (Array.isArray(stored.biomesVisited)) {
      data.biomesVisited = [...new Set(stored.biomesVisited.filter((key) => VALID_BIOMES.has(key)))];
    }
    if (Array.isArray(stored.landmarksFound)) {
      const seen = new Set();
      for (const raw of stored.landmarksFound) {
        const entry = sanitizeLandmark(raw);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        data.landmarksFound.push(entry);
        if (data.landmarksFound.length >= MAX_LANDMARK_ENTRIES) break;
      }
    }
    data.distanceFlown = nonNegative(stored.distanceFlown);
    data.maxAltitude = nonNegative(stored.maxAltitude);
    data.flightTime = nonNegative(stored.flightTime);
    const rings = stored.ringCourses && typeof stored.ringCourses === 'object' ? stored.ringCourses : {};
    const bestTime = finiteNumber(rings.bestTime, NaN);
    data.ringCourses = {
      completed: Math.floor(nonNegative(rings.completed)),
      bestStreak: Math.floor(nonNegative(rings.bestStreak)),
      bestTime: bestTime > 0 ? bestTime : null,
      bestResult: sanitizeCourseResult(rings.bestResult),
      lastResult: sanitizeCourseResult(rings.lastResult),
    };
    const landings = stored.landings && typeof stored.landings === 'object' ? stored.landings : {};
    data.landings = {
      count: Math.floor(nonNegative(landings.count)),
      best: sanitizeLanding(landings.best),
      last: sanitizeLanding(landings.last),
    };
    if (Array.isArray(stored.spawnsFound)) {
      const seen = new Set();
      for (const raw of stored.spawnsFound) {
        const entry = sanitizeSpawnEntry(raw);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        data.spawnsFound.push(entry);
        if (data.spawnsFound.length >= MAX_SPAWN_ENTRIES) break;
      }
    }
    return data;
  }

  /** One portal crossing as stored: { seed, from, portalId, at (ms epoch) }, or null when unusable. */
  function sanitizeWorldVisit(raw) {
    if (!raw || typeof raw !== 'object' || !WORLD_SEED_PATTERN.test(raw.seed ?? '') || !WORLD_SEED_PATTERN.test(raw.from ?? '')) return null;
    if (typeof raw.portalId !== 'string' || raw.portalId.length === 0 || raw.portalId.length > 128) return null;
    return { seed: raw.seed, from: raw.from, portalId: raw.portalId, at: nonNegative(raw.at) };
  }

  /**
   * Reads the global records (every world), repairing anything malformed, and migrates a version 1 or
   * 2 record to RECORDS_VERSION (migrateRecordsToV3). Returns { records, migratedFrom } (migratedFrom:
   * the stored version that was migrated, else null).
   */
  function loadRecords() {
    const loaded = createEmptyRecords();
    const stored = storage.read(RECORDS_STORAGE_KEY, null);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { records: loaded, migratedFrom: null };
    if (stored.stats && typeof stored.stats === 'object' && !Array.isArray(stored.stats)) {
      let kept = 0;
      for (const [key, raw] of Object.entries(stored.stats)) {
        if (!isOwnKey(key, STAT_KEY_PATTERN) || kept >= MAX_STATS) continue;
        const stat = sanitizeStat(raw, key);
        if (!stat) continue;
        loaded.stats[key] = stat;
        kept++;
      }
    }
    if (Array.isArray(stored.achievements)) {
      const seen = new Set();
      for (const raw of stored.achievements) {
        const entry = sanitizeAchievement(raw);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        loaded.achievements.push(entry);
        if (loaded.achievements.length >= MAX_ACHIEVEMENTS) break;
      }
    }
    loaded.bestLanding = sanitizeLanding(stored.bestLanding);
    if (Array.isArray(stored.worldsVisited)) {
      // The newest MAX_WORLDS_VISITED usable entries, oldest first.
      for (let index = stored.worldsVisited.length - 1; index >= 0 && loaded.worldsVisited.length < MAX_WORLDS_VISITED; index--) {
        const entry = sanitizeWorldVisit(stored.worldsVisited[index]);
        if (entry) loaded.worldsVisited.push(entry);
      }
      loaded.worldsVisited.reverse();
    }
    loaded.craftTime = sanitizeCraftTime(stored.craftTime);
    loaded.skinTime = sanitizeSkinTime(stored.skinTime);
    loaded.figures = sanitizeFigures(stored.figures);
    loaded.perches = sanitizePerches(stored.perches);
    const storedVersion = Number.isInteger(stored.version) && stored.version >= 1 ? stored.version : 1;
    if (storedVersion >= RECORDS_VERSION) return { records: loaded, migratedFrom: null };
    migrateRecordsToV3(loaded);
    return { records: loaded, migratedFrom: storedVersion };
  }

  const data = loadData();
  const { records, migratedFrom } = loadRecords();
  const foundIds = new Set(data.landmarksFound.map((entry) => entry.id));
  const spawnIds = new Set(data.spawnsFound.map((entry) => entry.id));
  const statOpMismatchReported = new Set();
  let dirty = false;
  let changePending = false;
  let changeReason = 'load';
  let saveTimer = SAVE_INTERVAL_SECONDS;
  let statsTimer = STATS_EVENT_INTERVAL_SECONDS;
  let saveFailureReported = false;
  let recordsSaveFailureReported = false;
  /**
   * The records changed without a save of their own (flight time, the highest altitude, a figure, a
   * perch): saved with the journal's throttled saves and when the page hides.
   */
  let recordsDirty = false;

  /** JSON-safe copy of the journal (also the persisted shape). */
  function snapshot() {
    return {
      seed: data.seed,
      biomesVisited: data.biomesVisited.slice(),
      landmarksFound: data.landmarksFound.map((entry) => ({ ...entry })),
      distanceFlown: roundTo(data.distanceFlown, 1),
      maxAltitude: roundTo(data.maxAltitude, 1),
      flightTime: roundTo(data.flightTime, 1),
      ringCourses: {
        ...data.ringCourses,
        bestResult: data.ringCourses.bestResult ? { ...data.ringCourses.bestResult } : null,
        lastResult: data.ringCourses.lastResult ? { ...data.ringCourses.lastResult } : null,
      },
      landings: {
        count: data.landings.count,
        best: data.landings.best ? { ...data.landings.best } : null,
        last: data.landings.last ? { ...data.landings.last } : null,
      },
      spawnsFound: data.spawnsFound.map((entry) => ({ ...entry })),
    };
  }

  /** JSON-safe copy of the global records (the persisted shape, without its version). */
  function recordsSnapshot() {
    const stats = {};
    for (const [key, stat] of Object.entries(records.stats)) stats[key] = { ...stat };
    if (stats.maxAltitude) stats.maxAltitude.value = roundTo(stats.maxAltitude.value, 1);
    const craftTime = {};
    for (const [craft, seconds] of Object.entries(records.craftTime)) craftTime[craft] = roundTo(seconds, 1);
    const skinTime = {};
    for (const [craft, skins] of Object.entries(records.skinTime)) {
      skinTime[craft] = {};
      for (const [skin, seconds] of Object.entries(skins)) skinTime[craft][skin] = roundTo(seconds, 1);
    }
    const figures = {};
    for (const [figure, entry] of Object.entries(records.figures)) figures[figure] = { ...entry };
    return {
      stats,
      achievements: records.achievements.map((entry) => ({ ...entry })),
      bestLanding: records.bestLanding ? { ...records.bestLanding } : null,
      craftTime,
      skinTime,
      worldsVisited: records.worldsVisited.map((entry) => ({ ...entry })),
      figures,
      perches: { count: records.perches.count, kinds: { ...records.perches.kinds } },
    };
  }

  function save() {
    if (storage.write(STORAGE_KEY, snapshot())) {
      dirty = false;
      return true;
    }
    if (!saveFailureReported) {
      saveFailureReported = true;
      bus.emit('notify', {
        text: 'This browser will not keep your journal, but discoveries still count for this flight.',
        kind: 'warning',
      });
    }
    return false;
  }

  function saveRecords() {
    recordsDirty = false;
    if (storage.write(RECORDS_STORAGE_KEY, { version: RECORDS_VERSION, ...recordsSnapshot() })) return true;
    if (!recordsSaveFailureReported) {
      recordsSaveFailureReported = true;
      bus.emit('notify', { text: 'This browser will not keep your records, but they still count for this flight.', kind: 'warning' });
    }
    return false;
  }

  function markChanged(reason) {
    dirty = true;
    changePending = true;
    changeReason = reason;
  }

  /** The global records changed (saved on the throttle); the panel hears 'journal:changed' { reason }. */
  function markRecordsChanged(reason) {
    recordsDirty = true;
    changePending = true;
    changeReason = reason;
  }

  // ---- Spawn registry and the collection ---------------------------------------------------------
  /** Every implemented preset: the SpawnManager's registry, else the built-in list. */
  function registryPresets() {
    const manager = ctx.systems.spawns?.manager;
    return manager && typeof manager.listPresets === 'function' ? manager.listPresets() : PRESETS;
  }

  /** The preset for an id: the registry's, else the built-in list's, else null. */
  function presetFor(presetId) {
    const manager = ctx.systems.spawns?.manager;
    const registered = manager && typeof manager.getPreset === 'function' ? manager.getPreset(presetId) : null;
    return registered ?? PRESET_BY_ID[presetId] ?? null;
  }

  /**
   * The spawn collection: { found, total, presets: [{ id, name, category, found }] } over the
   * implemented presets. found counts presets with at least one discovery in this world.
   */
  function collection() {
    const discoveredPresets = new Set(data.spawnsFound.map((entry) => entry.presetId));
    const presets = registryPresets().map((preset) => ({ id: preset.id, name: preset.name, category: preset.category, found: discoveredPresets.has(preset.id) }));
    let found = 0;
    for (const preset of presets) if (preset.found) found++;
    return { found, total: presets.length, presets };
  }

  /** Achievements the presets declare ({ id, title, description, presetId }), for the journal's list. */
  function declaredAchievements() {
    const declared = [];
    const seen = new Set();
    for (const preset of registryPresets()) {
      if (!Array.isArray(preset.achievements)) continue;
      for (const achievement of preset.achievements) {
        if (!achievement || typeof achievement.id !== 'string' || seen.has(achievement.id)) continue;
        seen.add(achievement.id);
        declared.push({ id: achievement.id, title: String(achievement.title || achievement.id), description: String(achievement.description || ''), presetId: preset.id });
      }
    }
    return declared;
  }

  function visitBiome(key) {
    if (!VALID_BIOMES.has(key) || data.biomesVisited.includes(key)) return false;
    data.biomesVisited.push(key);
    markChanged('biome');
    save();
    return true;
  }

  /** Flight time per craft (and per skin for a craft with skins), for the craft flying this frame. */
  function accumulateCraftTime(dt) {
    const flight = state.flight;
    const craft = flight ? flight.craft : null;
    if (typeof craft !== 'string' || !isOwnKey(craft, CRAFT_ID_PATTERN)) return;
    if (Object.hasOwn(records.craftTime, craft)) {
      records.craftTime[craft] = Math.min(MAX_SECONDS, records.craftTime[craft] + dt);
    } else if (Object.keys(records.craftTime).length < MAX_CRAFT_TIMES) {
      records.craftTime[craft] = dt;
    } else {
      return;
    }
    recordsDirty = true;
    const skin = flight.craftState ? flight.craftState.skin : null;
    if (typeof skin !== 'string' || !isOwnKey(skin, CRAFT_ID_PATTERN)) return;
    let skins = Object.hasOwn(records.skinTime, craft) ? records.skinTime[craft] : null;
    if (!skins) {
      if (Object.keys(records.skinTime).length >= MAX_CRAFT_TIMES) return;
      skins = records.skinTime[craft] = {};
    }
    if (Object.hasOwn(skins, skin)) skins[skin] = Math.min(MAX_SECONDS, skins[skin] + dt);
    else if (Object.keys(skins).length < MAX_SKINS_PER_CRAFT) skins[skin] = dt;
  }

  /**
   * The highest altitude ever flown (the maxAltitude statistic, op 'max'), followed every frame of
   * flight, space included: the record object is updated in place, saved on the throttle.
   */
  function followMaxAltitude(altitude) {
    if (!Number.isFinite(altitude) || altitude <= 0) return;
    const record = records.stats.maxAltitude;
    if (record && !(altitude > record.value)) return;
    if (record) {
      record.value = altitude;
      record.at = Date.now();
      record.seed = state.seed;
      record.presetId = null;
    } else {
      records.stats.maxAltitude = { value: altitude, op: 'max', at: Date.now(), seed: state.seed, presetId: null };
    }
    recordsDirty = true;
  }

  function accumulateFlight(dt) {
    const player = state.player;
    if (Number.isFinite(player.speed) && player.speed > 0) data.distanceFlown += player.speed * dt;
    if (Number.isFinite(player.altitude) && player.altitude > data.maxAltitude) data.maxAltitude = player.altitude;
    data.flightTime += dt;
    accumulateCraftTime(dt);
    followMaxAltitude(player.altitude);
    dirty = true;
    statsTimer -= dt;
    if (statsTimer <= 0) {
      statsTimer = STATS_EVENT_INTERVAL_SECONDS;
      changePending = true;
      if (changeReason === 'load') changeReason = 'stats';
    }
  }

  /**
   * Records a graded landing (the typed 'landed' payload). The best one (better grade, then the
   * lower sink rate) is saved at once, and the best in any world goes to the global records.
   * Returns { count, best, last, isBest } or null when unusable.
   */
  function recordLanding(landing) {
    const entry = sanitizeLanding({ ...landing, at: Date.now() });
    if (!entry) return null;
    const landings = data.landings;
    landings.count += 1;
    landings.last = entry;
    const isBest = isBetterLanding(entry, landings.best);
    if (isBest) landings.best = { ...entry };
    markChanged('landing');
    if (isBest) save();
    if (isBetterLanding(entry, records.bestLanding)) {
      records.bestLanding = { ...entry };
      saveRecords();
    }
    return { count: landings.count, best: landings.best ? { ...landings.best } : null, last: { ...entry }, isBest };
  }

  /**
   * Records a spawn discovery (the typed 'discovery' payload with a presetId): name, category, seed,
   * coordinates, time of day and first-seen date, plus the preset's kind and journal one-liner.
   * Returns the new entry, or null when it is not a spawn, unusable or already in the journal.
   */
  function recordSpawnDiscovery(payload) {
    if (!payload || typeof payload.presetId !== 'string' || typeof payload.id !== 'string') return null;
    if (spawnIds.has(payload.id)) return null;
    const preset = presetFor(payload.presetId);
    const position = payload.position || {};
    const entry = sanitizeSpawnEntry({
      id: payload.id,
      presetId: payload.presetId,
      name: payload.name || preset?.name,
      category: preset?.category ?? payload.kind,
      kind: preset?.kind ?? 'event',
      description: preset?.journal?.description ?? '',
      x: position.x,
      y: position.y,
      z: position.z,
      dayTime: state.time.dayTime,
      timeLabel: state.time.label,
      seed: state.seed,
      foundAt: Date.now(),
    });
    if (!entry) return null;
    spawnIds.add(entry.id);
    if (data.spawnsFound.length < MAX_SPAWN_ENTRIES) data.spawnsFound.push(entry);
    markChanged('spawn');
    save();
    const { found, total } = collection();
    bus.emit('journal:discovery', { entry: { ...entry }, found, total });
    return { ...entry };
  }

  /** Reports a producer bug once per key: a known statistic that arrived with another op. */
  function reportStatOpMismatch(key, op, expected) {
    if (statOpMismatchReported.has(key)) return;
    statOpMismatchReported.add(key);
    console.error(`[DRIFTWING] journalStat "${key}" arrived with op "${op}"; it is recorded with "${expected}"`);
  }

  /**
   * Folds a statistic (the typed 'journalStat' payload { key, value, op, presetId? }) into the global
   * records: 'add' sums, 'min' keeps the lowest, 'max' the highest. Known keys (JOURNAL_STATS) always
   * fold with their own op. Returns { key, value, previous, improved, op, presetId }, or null when
   * the payload is unusable.
   */
  function recordStat(payload) {
    if (!payload || typeof payload.key !== 'string' || !STAT_KEY_PATTERN.test(payload.key)) return null;
    const value = finiteNumber(payload.value, NaN);
    if (!Number.isFinite(value) || !JOURNAL_STAT_OPS.includes(payload.op)) return null;
    const known = journalStatInfo(payload.key);
    let op = payload.op;
    if (known && known.op !== op) {
      reportStatOpMismatch(payload.key, op, known.op);
      op = known.op;
    }
    if (op === 'add' && !(value > 0)) return null;
    if (known && !(value >= 0)) return null;
    const current = records.stats[payload.key] ?? null;
    if (!current && Object.keys(records.stats).length >= MAX_STATS) return null;
    const previous = current ? current.value : null;
    let next;
    if (op === 'add') next = (previous ?? 0) + value;
    else if (op === 'min') next = previous === null ? value : Math.min(previous, value);
    else next = previous === null ? value : Math.max(previous, value);
    next = roundTo(next, 3);
    const improved = next !== previous;
    const presetId = typeof payload.presetId === 'string' ? payload.presetId.slice(0, MAX_ID_LENGTH) : null;
    if (improved) {
      records.stats[payload.key] = { value: next, op, at: Date.now(), seed: state.seed, presetId };
      saveRecords();
      markChanged('stat');
    }
    const result = { key: payload.key, value: next, previous, improved, op, presetId };
    bus.emit('journal:record', { ...result });
    return result;
  }

  /**
   * Records an achievement (the typed 'achievement' payload { id, title }) the first time it is
   * earned in any world. Returns the new entry, or null when unusable or already earned.
   */
  function recordAchievement(payload) {
    const entry = sanitizeAchievement({ id: payload?.id, title: payload?.title, at: Date.now(), seed: state.seed });
    if (!entry || records.achievements.some((existing) => existing.id === entry.id)) return null;
    if (records.achievements.length >= MAX_ACHIEVEMENTS) return null;
    records.achievements.push(entry);
    saveRecords();
    markChanged('achievement');
    bus.emit('journal:achievement', { entry: { ...entry } });
    return { ...entry };
  }

  /**
   * Records an aerobatic figure (the typed 'figureFlown' payload { figure, score, craft, position }):
   * one more of it and its best score (0-100). Returns { figure, count, bestScore, improved }, or null
   * for a figure the recognizer does not know or an unusable score.
   */
  function recordFigure(payload) {
    if (!payload || !FIGURE_ID_SET.has(payload.figure)) return null;
    const score = figureScore(payload.score);
    if (score === null) return null;
    const figure = payload.figure;
    let entry = records.figures[figure];
    const improved = !entry || score > entry.bestScore;
    if (!entry) entry = records.figures[figure] = { count: 0, bestScore: score };
    entry.count = Math.min(MAX_COUNT, entry.count + 1);
    if (improved) entry.bestScore = score;
    markRecordsChanged('figure');
    return { figure, count: entry.count, bestScore: entry.bestScore, improved };
  }

  /**
   * Records a perch landing (the typed 'perched' payload when the bird settles, perched true; a
   * take-off, perched false, is not a landing). Returns { count, kinds } or null when unusable.
   */
  function recordPerch(payload) {
    if (!payload || payload.perched !== true || !PERCH_KINDS.includes(payload.kind)) return null;
    const perches = records.perches;
    perches.count = Math.min(MAX_COUNT, perches.count + 1);
    perches.kinds[payload.kind] = Math.min(MAX_COUNT, perches.kinds[payload.kind] + 1);
    markRecordsChanged('perch');
    return { count: perches.count, kinds: { ...perches.kinds } };
  }

  /** The challenge system's stored bests (src/gameplay/challenges.js), or null when it is absent. */
  function challengeRecords() {
    const challenges = ctx.systems.challenges;
    return challenges && typeof challenges.getRecords === 'function' ? challenges.getRecords() : null;
  }

  /**
   * The medals of every best run (per course and craft) the challenge system keeps: { gold, silver,
   * bronze, none, runs, courses }, all zero without the challenge system. Read, never stored here.
   */
  function medalTally() {
    const tally = { gold: 0, silver: 0, bronze: 0, none: 0, runs: 0, courses: 0 };
    const courses = challengeRecords()?.courses;
    if (!courses || typeof courses !== 'object') return tally;
    for (const course of Object.values(courses)) {
      let flown = false;
      for (const best of Object.values(course?.best ?? {})) {
        if (!best || !Number.isFinite(best.time)) continue;
        flown = true;
        tally.runs++;
        tally[MEDALS.includes(best.medal) ? best.medal : 'none']++;
      }
      if (flown) tally.courses++;
    }
    return tally;
  }

  function flushOnHide() {
    if (document.visibilityState !== 'hidden') return;
    save();
    if (recordsDirty) saveRecords();
  }
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => {
    save();
    if (recordsDirty) saveRecords();
  });
  bus.on('biome:changed', (payload) => visitBiome(payload?.biome?.key));
  bus.on('landed', (landing) => recordLanding(landing));
  bus.onTyped('discovery', (payload) => recordSpawnDiscovery(payload));
  bus.onTyped('journalStat', (payload) => recordStat(payload));
  bus.onTyped('achievement', (payload) => recordAchievement(payload));
  bus.onTyped('figureFlown', (payload) => recordFigure(payload));
  bus.onTyped('perched', (payload) => recordPerch(payload));
  // Portals (preset 67): the world the player went through to, saved at once (the page reloads next).
  bus.onTyped('worldVisited', (payload) => {
    const entry = sanitizeWorldVisit({ seed: payload.seed, from: payload.previous, portalId: payload.portalId, at: Date.now() });
    if (!entry) return;
    records.worldsVisited.push(entry);
    records.worldsVisited.splice(0, Math.max(0, records.worldsVisited.length - MAX_WORLDS_VISITED));
    saveRecords();
    save();
    markChanged('world');
  });
  // Challenges: the challenge system keeps the bests (driftwing-v2.challenges); a new best refreshes the panel.
  bus.onTyped('challengeFinished', (payload) => {
    if (payload?.improved) markChanged('challenge');
  });
  // Records read from an older version were migrated: keep them as the current version at once.
  if (migratedFrom !== null) saveRecords();
  visitBiome(state.player.biome?.key);
  // The spawns this world's journal already holds are discovered: they never announce again.
  ctx.systems.spawns?.manager?.markDiscovered?.(data.spawnsFound.map((entry) => entry.id));

  return {
    update(dt, realDt) {
      if (dt > 0) accumulateFlight(dt);
      saveTimer -= realDt;
      if (saveTimer <= 0) {
        saveTimer = SAVE_INTERVAL_SECONDS;
        if (dirty) save();
        if (recordsDirty) saveRecords();
      }
      if (changePending) {
        changePending = false;
        const reason = changeReason;
        changeReason = 'stats';
        bus.emit('journal:changed', { reason });
      }
    },

    /**
     * The journal (the persisted shape) plus the global records, the spawn collection counts and the
     * challenge bests (every world; the challenge system's records, or null without it).
     */
    getData() {
      const { found, total } = collection();
      return { ...snapshot(), records: recordsSnapshot(), collection: { found, total }, challenges: challengeRecords() };
    },

    /** The challenge bests: { version, courses: { courseKey: { name, presetId, best: { craft: { time, medal, splits, missed, date } } } } } or null. */
    getChallengeRecords: challengeRecords,

    /**
     * The global records: { stats: { key: { value, op, at, seed, presetId } } (maxAltitude among them),
     * achievements, bestLanding, craftTime: { craft: seconds }, skinTime: { craft: { skin: seconds } },
     * worldsVisited: [{ seed, from, portalId, at }], figures: { figure: { count, bestScore } },
     * perches: { count, kinds: { peak, structure, tree } } }.
     */
    getRecords() {
      return recordsSnapshot();
    },

    /** The medals of the challenge bests: { gold, silver, bronze, none, runs, courses } (medalTally). */
    getMedals: medalTally,

    /** The stored version the records were migrated from on this load (1 or 2), or null. */
    getMigratedFrom() {
      return migratedFrom;
    },

    /** The spawn collection over the implemented presets: { found, total, presets }. */
    getCollection: collection,

    /** Achievements the presets declare (earned or not): [{ id, title, description, presetId }]. */
    getDeclaredAchievements: declaredAchievements,

    hasFound(id) {
      return foundIds.has(id);
    },

    /** True when the spawn (a site id or an event preset id) is in this world's journal. */
    hasDiscovered(id) {
      return spawnIds.has(id);
    },

    recordLanding,
    recordSpawnDiscovery,
    recordStat,
    recordAchievement,
    recordFigure,
    recordPerch,

    /** Records a discovered landmark. Returns true only the first time. */
    recordLandmark(site, name) {
      if (!site || typeof site.id !== 'string' || foundIds.has(site.id)) return false;
      if (!VALID_TYPES.has(site.type)) return false;
      foundIds.add(site.id);
      if (data.landmarksFound.length < MAX_LANDMARK_ENTRIES) {
        data.landmarksFound.push({
          id: site.id,
          type: site.type,
          name: String(name || site.type).slice(0, MAX_NAME_LENGTH),
          x: Math.round(site.x),
          z: Math.round(site.z),
          biome: VALID_BIOMES.has(site.biomeKey) ? site.biomeKey : null,
          foundAt: Date.now(),
        });
      }
      markChanged('landmark');
      save();
      return true;
    },

    /**
     * Records a finished ring course. bestTime only counts clean runs (every
     * ring passed); bestResult ({ passed, total, time }) keeps the best run
     * including misses (most of the course passed, then fastest) and
     * lastResult the latest one. Returns the updated bests plus which ones
     * were beaten.
     */
    recordRingCourse(result) {
      const passed = Math.floor(nonNegative(result?.passed));
      const total = Math.floor(nonNegative(result?.total));
      const streak = Math.floor(nonNegative(result?.bestStreak));
      const time = finiteNumber(result?.time, NaN);
      const rings = data.ringCourses;
      rings.completed += 1;
      const isBestStreak = streak > rings.bestStreak;
      if (isBestStreak) rings.bestStreak = streak;
      let isBestTime = false;
      if (total > 0 && passed >= total && time > 0 && (rings.bestTime === null || time < rings.bestTime)) {
        rings.bestTime = roundTo(time, 2);
        isBestTime = true;
      }
      const courseResult = sanitizeCourseResult({ passed, total, time });
      let isBestResult = false;
      if (courseResult !== null) {
        rings.lastResult = courseResult;
        if (isBetterCourse(courseResult, rings.bestResult)) {
          rings.bestResult = { ...courseResult };
          isBestResult = true;
        }
      }
      markChanged('rings');
      save();
      return {
        completed: rings.completed,
        bestStreak: rings.bestStreak,
        bestTime: rings.bestTime,
        bestResult: rings.bestResult ? { ...rings.bestResult } : null,
        lastResult: rings.lastResult ? { ...rings.lastResult } : null,
        isBestStreak,
        isBestTime,
        isBestResult,
      };
    },
  };
}
