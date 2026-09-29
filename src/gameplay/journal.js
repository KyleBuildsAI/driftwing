import { storage } from '../core/storage.js';
import { JOURNAL_STAT_OPS } from '../core/events.js';
import { LANDING_GRADES, isBetterLanding } from '../flight/landing.js';
import { PRESETS, PRESET_BY_ID } from '../spawns/presets/index.js';
import { PRESET_CATEGORIES } from '../spawns/schema.js';

/** Where the global records (achievements and bests across every world) are kept. */
export const RECORDS_STORAGE_KEY = 'driftwing-v2.records';
const RECORDS_VERSION = 1;

/**
 * The journal statistics the game knows (typed event journalStat): how each folds and what it
 * measures. Other keys are kept too, folded with the op they arrive with.
 */
export const JOURNAL_STATS = Object.freeze({
  stormsChased: Object.freeze({ op: 'add', unit: 'count', label: 'Storms chased' }),
  closestTornado: Object.freeze({ op: 'min', unit: 'metres', label: 'Closest tornado' }),
  bestCanyonRun: Object.freeze({ op: 'min', unit: 'seconds', label: 'Best canyon run' }),
});
const STAT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;

/**
 * JOURNAL: the per-seed discovery log. Records biomes visited, landmarks found, spawns discovered
 * (the typed 'discovery' events that carry a presetId: name, category, seed, coordinates, time of
 * day and the first-seen date), distance flown, highest altitude, flight time, ring-course results
 * (best clean time, best streak, the best result including misses and the last run) and graded
 * landings (count, last and best, from the typed 'landed' event), and persists them with `storage`
 * under `driftwing-v2.journal.<seed>`.
 *
 * The global records live under `driftwing-v2.records`, shared by every world: the journal
 * statistics from the typed 'journalStat' events (storms chased, closest tornado, best canyon run
 * and any other key a preset sends), the achievements from the typed 'achievement' events, and the
 * best landing in any world.
 *
 * The spawn collection counts implemented presets only: found / total over the spawn registry (the
 * SpawnManager's presets, which is PRESETS in a player's build).
 *
 * Saves are throttled (every ~5 s while flying), immediate on discoveries, biome firsts, finished
 * ring courses, new best landings, records and achievements, and flushed when the page hides.
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
    return { stats: {}, achievements: [], bestLanding: null };
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

  /** Validates one stored record statistic ({ value, op, at, seed, presetId }); null when unusable. */
  function sanitizeStat(stat) {
    if (!stat || typeof stat !== 'object') return null;
    const value = finiteNumber(stat.value, NaN);
    if (!Number.isFinite(value) || !JOURNAL_STAT_OPS.includes(stat.op)) return null;
    return {
      value,
      op: stat.op,
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

  /** Reads the global records (every world), repairing anything malformed. */
  function loadRecords() {
    const loaded = createEmptyRecords();
    const stored = storage.read(RECORDS_STORAGE_KEY, null);
    if (!stored || typeof stored !== 'object') return loaded;
    if (stored.stats && typeof stored.stats === 'object') {
      for (const [key, raw] of Object.entries(stored.stats)) {
        if (!STAT_KEY_PATTERN.test(key) || Object.keys(loaded.stats).length >= MAX_STATS) continue;
        const stat = sanitizeStat(raw);
        if (stat) loaded.stats[key] = stat;
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
    return loaded;
  }

  const data = loadData();
  const records = loadRecords();
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
    return {
      stats,
      achievements: records.achievements.map((entry) => ({ ...entry })),
      bestLanding: records.bestLanding ? { ...records.bestLanding } : null,
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

  function accumulateFlight(dt) {
    const player = state.player;
    if (Number.isFinite(player.speed) && player.speed > 0) data.distanceFlown += player.speed * dt;
    if (Number.isFinite(player.altitude) && player.altitude > data.maxAltitude) data.maxAltitude = player.altitude;
    data.flightTime += dt;
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
    const known = JOURNAL_STATS[payload.key];
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

  function flushOnHide() {
    if (document.visibilityState === 'hidden') save();
  }
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => save());
  bus.on('biome:changed', (payload) => visitBiome(payload?.biome?.key));
  bus.on('landed', (landing) => recordLanding(landing));
  bus.onTyped('discovery', (payload) => recordSpawnDiscovery(payload));
  bus.onTyped('journalStat', (payload) => recordStat(payload));
  bus.onTyped('achievement', (payload) => recordAchievement(payload));
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
      }
      if (changePending) {
        changePending = false;
        const reason = changeReason;
        changeReason = 'stats';
        bus.emit('journal:changed', { reason });
      }
    },

    /** The journal (the persisted shape) plus the global records and the spawn collection counts. */
    getData() {
      const { found, total } = collection();
      return { ...snapshot(), records: recordsSnapshot(), collection: { found, total } };
    },

    /** The global records: { stats: { key: { value, op, at, seed, presetId } }, achievements, bestLanding }. */
    getRecords() {
      return recordsSnapshot();
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
