// Global overrides with regional blending (contract i.4): the blood moon (preset 61) and the midnight
// sun (preset 98). Pure and deterministic, with no imports beyond the candidate hashes, so the
// director, the sky, the labs and the determinism test all agree.
//
// A preset with an `override` block is never a director candidate. Its schedule is per night:
//
//   night n is active  when  hash(seedHash, n, presetId) / 2^32 < override.nightChance
//
// where n = nightIndex(days) counts nights from noon to noon (state.time.days is the day counter the
// sky keeps: whole days since the flight began plus dayTime, so the night centred on the midnight
// where days = k is night k). On an active night the override's weight at the player is
//
//   weight = nightWindow(dayTime) x region weight
//
// nightWindow eases in through the evening while the sun is still well up (dayTime 0.64 -> 0.70) and
// out after the morning (0.30 -> 0.36), so nothing visible changes while it ramps. The region weight
// is 1 everywhere for `region: null` (the blood moon). For a region (the midnight sun's snow) it is
// 1 inside the region and fades to 0 over blendKm outside it: the region is the cells of a fixed
// 2 km lattice where the named biomes hold at least half the climate weight (src/world/worldgen.js
// biomeAt), and the weight is 1 - smoothstep(0, blendKm, distance to the nearest region cell). The
// distance is to the cell's square, so the weight changes continuously as the player flies.
//
// The midnight sun bends the sun's path (applyMidnightSun): the elevation is raised to a skim line
// that sits 1.5 degrees above the horizon at midnight (due north) and 5 degrees at the usual sunset,
// by the override's weight, so the sun skims the horizon without setting. The sky calls it through
// sky.addSunOverride and state.time follows the bent sun (night factor, labels, the WindField's
// thermals and the director's time-of-day filters all see the same sun).
import { hashString, mix32, unitFromHash } from './candidates.js';

export const OVERRIDE_KINDS = Object.freeze(['bloodMoon', 'midnightSun']);
/** The night window (dayTime): eased in over [IN_START, IN_END], out over [OUT_START, OUT_END]. */
export const NIGHT_WINDOW = Object.freeze({ inStart: 0.64, inEnd: 0.7, outStart: 0.3, outEnd: 0.36 });
/** The midnight sun's skim line (degrees above the horizon): at midnight, and at sunset / sunrise. */
export const MIDNIGHT_SUN_SKIM = Object.freeze({ midnight: 1.5, horizon: 5 });
/** Regions are sampled on this lattice (m) and cached per cell. */
export const REGION_CELL = 2000;
/** A lattice cell belongs to a region when the region's biomes hold at least this share of its climate. */
export const REGION_SHARE = 0.5;
const REGION_CACHE_LIMIT = 65536;
const OVERRIDE_SALT = 0x6b43a9b5;
const DEG = Math.PI / 180;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The night a day counter belongs to: night k runs from the noon before midnight k to the noon after. */
export function nightIndex(days) {
  return Math.floor(days + 0.5);
}

/** 0..1: how far into the night (eased; 1 from dayTime 0.70 through midnight to 0.30). */
export function nightWindow(dayTime) {
  const value = ((dayTime % 1) + 1) % 1;
  if (value >= NIGHT_WINDOW.inEnd || value <= NIGHT_WINDOW.outStart) return 1;
  if (value > NIGHT_WINDOW.inStart) return smoothstep(NIGHT_WINDOW.inStart, NIGHT_WINDOW.inEnd, value);
  if (value < NIGHT_WINDOW.outEnd) return 1 - smoothstep(NIGHT_WINDOW.outStart, NIGHT_WINDOW.outEnd, value);
  return 0;
}

/** hash(seedHash, night, presetId) as a uint32 (presetHash is hashString(presetId)). */
export function overrideHash(seedHash, night, presetHash) {
  let hash = mix32(((seedHash ^ OVERRIDE_SALT) ^ Math.imul(presetHash | 0, 0x9e3779b1)) >>> 0);
  hash = mix32((hash + Math.imul(night | 0, 0x27d4eb2d)) >>> 0);
  return hash;
}

/** Whether the override is scheduled on that night. */
export function isScheduled(seedHash, night, presetHash, nightChance) {
  return unitFromHash(overrideHash(seedHash, night, presetHash)) < nightChance;
}

/** The nights in [from, to] the override is scheduled on (labs, the debugger). */
export function scheduledNights(seedHash, presetId, nightChance, from, to) {
  const presetHash = hashString(presetId);
  const nights = [];
  for (let night = from; night <= to; night++) if (isScheduled(seedHash, night, presetHash, nightChance)) nights.push(night);
  return nights;
}

/**
 * The skim line the midnight sun keeps above (degrees): MIDNIGHT_SUN_SKIM.midnight at dayTime 0
 * rising to MIDNIGHT_SUN_SKIM.horizon at dayTime 0.25 and 0.75 (and above for the day).
 */
export function skimElevation(dayTime) {
  const value = ((dayTime % 1) + 1) % 1;
  const fromMidnight = Math.min(1, Math.min(value, 1 - value) / 0.25);
  return MIDNIGHT_SUN_SKIM.midnight + (MIDNIGHT_SUN_SKIM.horizon - MIDNIGHT_SUN_SKIM.midnight) * fromMidnight * fromMidnight;
}

/**
 * Bends a sun direction ({ x, y, z } unit vector, edited in place) toward the midnight sun's skim
 * line by weight (0..1): the elevation rises to at least the skim line, the azimuth is kept. A sun
 * already above the line is untouched, so the bend is continuous at any weight.
 */
export function applyMidnightSun(dayTime, direction, weight) {
  if (!(weight > 0)) return direction;
  const elevation = Math.asin(Math.min(1, Math.max(-1, direction.y)));
  const skim = skimElevation(dayTime) * DEG;
  if (elevation >= skim) return direction;
  const bent = elevation + (skim - elevation) * Math.min(1, weight);
  const horizontal = Math.hypot(direction.x, direction.z);
  const scale = horizontal > 1e-9 ? Math.cos(bent) / horizontal : 0;
  direction.x *= scale;
  direction.z *= scale;
  direction.y = Math.sin(bent);
  return direction;
}

/**
 * The region weight field of one override region: weightAt(x, z) in 0..1. biomeAt(x, z) is worldgen's
 * ({ key, weights }); with biomeKeys (the keys of weights in order, worldgen's BIOMES) the climate
 * weights of the named biomes add up, else the dominant biome counts 1 or 0. Lattice cells are
 * sampled once and cached (the cache only grows when the player reaches new cells), so a quiet call
 * allocates nothing.
 */
export function createRegionField({ biomes, blendKm, biomeAt, biomeKeys = null }) {
  const cells = new Map();
  const blend = blendKm * 1000;
  const radiusCells = Math.ceil(blend / REGION_CELL) + 1;

  function cellShare(cellX, cellZ) {
    const key = cellX * 1048576 + cellZ;
    let share = cells.get(key);
    if (share === undefined) {
      if (cells.size >= REGION_CACHE_LIMIT) cells.clear();
      const info = biomeAt((cellX + 0.5) * REGION_CELL, (cellZ + 0.5) * REGION_CELL);
      share = 0;
      if (info && biomeKeys && info.weights && info.weights.length === biomeKeys.length) {
        for (let index = 0; index < biomeKeys.length; index++) if (biomes.includes(biomeKeys[index])) share += info.weights[index];
      } else if (info && biomes.includes(info.key)) {
        share = 1;
      }
      cells.set(key, share);
    }
    return share;
  }

  return {
    /** 1 inside the region, easing to 0 at blendKm from its nearest cell. */
    weightAt(x, z) {
      const centreX = Math.floor(x / REGION_CELL);
      const centreZ = Math.floor(z / REGION_CELL);
      let nearest = Infinity;
      for (let offsetZ = -radiusCells; offsetZ <= radiusCells; offsetZ++) {
        const cellZ = centreZ + offsetZ;
        const dz = Math.max(cellZ * REGION_CELL - z, 0, z - (cellZ + 1) * REGION_CELL);
        if (dz >= nearest) continue;
        for (let offsetX = -radiusCells; offsetX <= radiusCells; offsetX++) {
          const cellX = centreX + offsetX;
          const dx = Math.max(cellX * REGION_CELL - x, 0, x - (cellX + 1) * REGION_CELL);
          const distance = Math.hypot(dx, dz);
          if (distance >= nearest || distance > blend) continue;
          if (cellShare(cellX, cellZ) >= REGION_SHARE) nearest = distance;
        }
      }
      return nearest === Infinity ? 0 : 1 - smoothstep(0, blend, nearest);
    },
    get cachedCells() {
      return cells.size;
    },
  };
}

/**
 * The schedule of every override preset in a preset list. biomeAt(x, z) -> { key, weights? } and
 * biomeKeys (createRegionField) feed the regional ones. update(days, dayTime, x, z) refreshes every entry in place (no allocation)
 * and returns the entry list: [{ id, presetId, kind, night, scheduled, forced, weight, region }].
 * force(presetId, night) schedules a preset on that night whatever its roll (the debugger); a forced
 * night ignores the region (weight = the night window). release(presetId) drops a forced night (the
 * night then follows its own roll again).
 */
export function createOverrideSchedule({ seedHash, presets, biomeAt = null, biomeKeys = null }) {
  const entries = [];
  for (const preset of presets) {
    if (!preset.override) continue;
    const { kind, nightChance, region } = preset.override;
    if (!OVERRIDE_KINDS.includes(kind)) throw new Error(`[DRIFTWING] override preset "${preset.id}": unknown kind "${kind}"`);
    entries.push({
      id: `override:${preset.id}`,
      presetId: preset.id,
      kind,
      nightChance,
      presetHash: hashString(preset.id),
      field: region && typeof biomeAt === 'function' ? createRegionField({ biomes: region.biomes, blendKm: region.blendKm, biomeAt, biomeKeys }) : null,
      regional: Boolean(region),
      night: 0,
      scheduled: false,
      forcedNight: null,
      weight: 0,
      region: 1,
    });
  }
  return {
    entries,
    update(days, dayTime, x, z) {
      const night = nightIndex(days);
      const window = nightWindow(dayTime);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        entry.night = night;
        const forced = entry.forcedNight === night;
        entry.scheduled = forced || isScheduled(seedHash, night, entry.presetHash, entry.nightChance);
        // A regional override with no biome source has nowhere to be: it stays off.
        entry.region = forced || !entry.regional ? 1 : entry.field ? entry.field.weightAt(x, z) : 0;
        entry.weight = entry.scheduled ? window * entry.region : 0;
      }
      return entries;
    },
    force(presetId, night) {
      const entry = entries.find((candidate) => candidate.presetId === presetId);
      if (!entry) return false;
      entry.forcedNight = night;
      return true;
    },
    release(presetId) {
      const entry = entries.find((candidate) => candidate.presetId === presetId);
      if (!entry || entry.forcedNight === null) return false;
      entry.forcedNight = null;
      return true;
    },
    has(presetId) {
      return entries.some((entry) => entry.presetId === presetId);
    },
  };
}
