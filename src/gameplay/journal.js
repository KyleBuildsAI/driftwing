import { storage } from '../core/storage.js';

/**
 * JOURNAL: the per-seed discovery log. Records biomes visited, landmarks found,
 * distance flown, highest altitude, flight time and ring-course results (best
 * clean time, best streak, the best result including misses and the last run), and
 * persists them with `storage` under `driftwing.journal.<seed>`.
 * Saves are throttled (every ~5 s while flying), immediate on discoveries,
 * biome firsts and finished ring courses, and flushed when the page hides.
 */
export function createJournal(ctx) {
  const { bus, state, world } = ctx;
  const STORAGE_KEY = `driftwing.journal.${state.seed}`;
  const SAVE_INTERVAL_SECONDS = 5;
  const STATS_EVENT_INTERVAL_SECONDS = 2;
  const MAX_LANDMARK_ENTRIES = 5000;
  const MAX_NAME_LENGTH = 80;
  const VALID_BIOMES = new Set(world.BIOMES.map((biome) => biome.key));
  const VALID_TYPES = new Set(world.LANDMARK_TYPES);

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

  function createEmptyData() {
    return {
      seed: state.seed,
      biomesVisited: [],
      landmarksFound: [],
      distanceFlown: 0,
      maxAltitude: 0,
      flightTime: 0,
      ringCourses: { completed: 0, bestStreak: 0, bestTime: null, bestResult: null, lastResult: null },
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
    return data;
  }

  const data = loadData();
  const foundIds = new Set(data.landmarksFound.map((entry) => entry.id));
  let dirty = false;
  let changePending = false;
  let changeReason = 'load';
  let saveTimer = SAVE_INTERVAL_SECONDS;
  let statsTimer = STATS_EVENT_INTERVAL_SECONDS;
  let saveFailureReported = false;

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

  function markChanged(reason) {
    dirty = true;
    changePending = true;
    changeReason = reason;
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

  function flushOnHide() {
    if (document.visibilityState === 'hidden') save();
  }
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => save());
  bus.on('biome:changed', (payload) => visitBiome(payload?.biome?.key));
  visitBiome(state.player.biome?.key);

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

    getData() {
      return snapshot();
    },

    hasFound(id) {
      return foundIds.has(id);
    },

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
