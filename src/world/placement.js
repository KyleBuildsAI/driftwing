// Deterministic site placement: where every persistent spawn (volcano, canyon, airfield, ...) sits.
//
// Sites live on a 2 km grid. Every site preset (preset.kind === 'site' with a `placement` block,
// see src/spawns/presets/) is rolled once per cell with hash(seed, cellX, cellZ, presetId), then
// filtered, in this order:
//   1. chance      the roll must fall under placement.chance;
//   2. biome       the dominant biome at the site, from the terrain's OWN biome function, must be
//                  one of placement.biomes (null = any);
//   3. surface     'land' | 'water' | 'coast' | 'any', from the unstamped height at the centre and on
//                  a ring the size of the site's stamps;
//   4. terrain     minHeight / maxHeight of the centre, and relief: 'peak' | 'valley' | 'flat' |
//                  'ridge' | 'any', from a ring of samples RELIEF_RADIUS out;
//   5. landmarks   placement.clearance metres between the site's stamp footprint and every Phase 1
//                  landmark;
//   6. minSpacing  two sites of one preset closer than placement.minSpacing: the one with the higher
//                  priority roll wins (ties go to the lower cell), checked against every neighbouring
//                  cell in a fixed order, so the answer never depends on which cell was asked first;
//   7. clearance   the same rule between different presets: two sites whose stamp footprints come
//                  closer than the larger of their clearances keep only the higher priority.
// Rules 6 and 7 compare against the other sites' rule 1-6 results (never their final ones), so the
// check is local, needs no recursion and gives the same answer from any starting cell.
//
// Everything is a pure function of (seed, presets, the unstamped world): the main thread and the
// terrain worker each build their own placement and agree without any messaging. Results are cached
// per cell; the caches only save work, and clearing them never changes an answer.
//
// Pure: imports only stamps.js, no DOM, so the terrain worker runs exactly this code.
import { compareStampOrder, resolveStamp, stampReach, validateStampSpec } from './stamps.js';

/** Site grid cell size (m); the stamp spatial hash uses the same cells. */
export const SITE_CELL = 2000;
export const SURFACES = Object.freeze(['land', 'water', 'coast', 'any']);
export const RELIEFS = Object.freeze(['peak', 'valley', 'flat', 'ridge', 'any']);
export const ALIGNMENTS = Object.freeze(['random', 'downhill', 'ridge']);

const BIOME_KEYS = Object.freeze(['snow', 'pine', 'dunes', 'archipelago', 'meadows']);
/** Relief ring radius (m) and its thresholds (m). */
const RELIEF_RADIUS = 450;
const PEAK_PROMINENCE = 35;
const VALLEY_DEPTH = 25;
const FLAT_SPREAD = 30;
const RIDGE_ALONG = 40;
const RIDGE_DROP = 35;
/** Phase 1 landmarks without shaping (arches, balloons) still need this much room (m). */
const LANDMARK_MIN_RADIUS = 150;
const CELL_OFFSET = 32768;
const CELL_SPAN = 65536;
const CANDIDATE_CACHE_LIMIT = 400000;
const CELL_CACHE_LIMIT = 40000;
const EMPTY = Object.freeze([]);
const RING_ANGLES = Object.freeze(Array.from({ length: 8 }, (unused, index) => (index / 8) * Math.PI * 2));

function mix32(value) {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a of a string, mixed: the preset salt in hash(seed, cellX, cellZ, presetId). */
export function hashText(text) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash >>> 0);
}

function mulberry32(state) {
  let a = state | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

/** Throws a clear error naming the preset and the field when a site preset's placement is unusable. */
export function validateSitePreset(preset) {
  const where = `preset "${preset && preset.id}"`;
  if (!preset || typeof preset.id !== 'string' || preset.id.length === 0) throw new Error(`${where}: id must be a non-empty string`);
  const placement = preset.placement;
  if (placement === null || typeof placement !== 'object') throw new Error(`${where}.placement: a site preset needs a placement block`);
  if (!isNumber(placement.chance) || placement.chance < 0 || placement.chance > 1) throw new Error(`${where}.placement.chance: must be a number in [0, 1]`);
  if (!isNumber(placement.minSpacing) || placement.minSpacing < 0) throw new Error(`${where}.placement.minSpacing: must be a number of metres >= 0`);
  if (placement.biomes !== null && placement.biomes !== undefined) {
    if (!Array.isArray(placement.biomes) || placement.biomes.length === 0) throw new Error(`${where}.placement.biomes: must be null or a non-empty array`);
    for (const biome of placement.biomes) if (!BIOME_KEYS.includes(biome)) throw new Error(`${where}.placement.biomes: "${biome}" is not one of ${BIOME_KEYS.join(', ')}`);
  }
  if (!SURFACES.includes(placement.surface ?? 'any')) throw new Error(`${where}.placement.surface: must be one of ${SURFACES.join(', ')}`);
  const terrain = placement.terrain;
  if (terrain !== undefined && terrain !== null) {
    if (typeof terrain !== 'object') throw new Error(`${where}.placement.terrain: must be an object`);
    if (terrain.minHeight !== undefined && !isNumber(terrain.minHeight)) throw new Error(`${where}.placement.terrain.minHeight: must be a number`);
    if (terrain.maxHeight !== undefined && !isNumber(terrain.maxHeight)) throw new Error(`${where}.placement.terrain.maxHeight: must be a number`);
    if (!RELIEFS.includes(terrain.relief ?? 'any')) throw new Error(`${where}.placement.terrain.relief: must be one of ${RELIEFS.join(', ')}`);
  }
  if (placement.clearance !== undefined && (!isNumber(placement.clearance) || placement.clearance < 0)) throw new Error(`${where}.placement.clearance: must be a number of metres >= 0`);
  if (!ALIGNMENTS.includes(placement.align ?? 'random')) throw new Error(`${where}.placement.align: must be one of ${ALIGNMENTS.join(', ')}`);
  const scale = placement.scale;
  if (scale !== undefined && !(Array.isArray(scale) && scale.length === 2 && scale.every((value) => isNumber(value) && value > 0) && scale[0] <= scale[1])) {
    throw new Error(`${where}.placement.scale: must be an ascending [min, max] range of positive numbers`);
  }
  const stamps = preset.stamps ?? EMPTY;
  if (!Array.isArray(stamps)) throw new Error(`${where}.stamps: must be an array`);
  stamps.forEach((spec, index) => validateStampSpec(spec, `${where} stamps[${index}]`));
}

/**
 * Site-list hash (the determinism test's key): the sites sorted by id, each as its id and its
 * coordinates rounded to 1 cm, folded into two 32-bit FNV-1a lanes. Returns 16 hex digits.
 */
export function hashSiteList(sites) {
  const lines = sites.map((site) => `${site.id}@${Math.round(site.x * 100)},${Math.round(site.z * 100)}`);
  lines.sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
  let low = 2166136261 >>> 0;
  let high = 0x811c9dc5 ^ 0x5bd1e995;
  for (const line of lines) {
    for (let index = 0; index < line.length; index++) {
      const code = line.charCodeAt(index);
      low = Math.imul(low ^ code, 16777619) >>> 0;
      high = Math.imul(high ^ ((code + index) & 0xffff), 16777619) >>> 0;
    }
    low = mix32(low ^ 0x0a);
    high = mix32(high + low);
  }
  return `${low.toString(16).padStart(8, '0')}${high.toString(16).padStart(8, '0')}`;
}

/**
 * Creates the placement for one world.
 *   seed:    the world's uint32 seed hash (worldgen's seedHash)
 *   world:   the UNSTAMPED base functions: { heightAt(x, z), biomeIndexAt(x, z), waterLevel,
 *            landmarkSitesNear(x, z, radius) }
 *   presets: the preset list; only site presets (kind 'site' with a placement block) are placed
 * Returns { sitePresets, maxReach, hasStamps, sitesInCell, sitesNear, stampsInCell, stampsOverlap,
 * clearCaches }.
 */
export function createPlacement({ seed, world, presets }) {
  const seedHash = seed >>> 0;
  const waterLevel = world.waterLevel;
  const entries = [];
  for (const preset of presets) {
    if (!preset || preset.kind !== 'site' || !preset.placement) continue;
    validateSitePreset(preset);
    const stamps = preset.stamps ?? EMPTY;
    const reach = stamps.reduce((largest, spec) => Math.max(largest, stampReach(spec)), 0);
    entries.push({
      index: entries.length,
      preset,
      salt: hashText(preset.id),
      reach,
      clearance: preset.placement.clearance ?? 0,
      // The footprint probed for the surface filter: the stamps' own extent, within limits.
      surfaceRadius: Math.min(Math.max(reach * 0.5, 200), 1200),
    });
  }
  const presetCount = entries.length;
  const maxReach = entries.reduce((largest, entry) => Math.max(largest, entry.reach), 0);
  const maxClearance = entries.reduce((largest, entry) => Math.max(largest, entry.clearance), 0);
  const hasStamps = entries.some((entry) => (entry.preset.stamps ?? EMPTY).length > 0);
  const stampCellReach = Math.ceil(maxReach / SITE_CELL);

  const candidateCache = new Map();
  const siteCellCache = new Map();
  const stampCellCache = new Map();

  function cellKey(cellX, cellZ) {
    return (cellX + CELL_OFFSET) * CELL_SPAN + (cellZ + CELL_OFFSET);
  }

  /** uint32 hash(seed, cellX, cellZ, presetId) for one stream of numbers. */
  function cellHash(cellX, cellZ, salt, stream) {
    let h = mix32((seedHash ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
    h = mix32((h ^ Math.imul(cellX | 0, 0x85ebca77)) >>> 0);
    h = mix32((h + Math.imul(cellZ | 0, 0xc2b2ae3d)) >>> 0);
    return mix32((h ^ Math.imul(stream + 1, 0x27d4eb2f)) >>> 0);
  }
  function cellRandom(cellX, cellZ, salt, stream) {
    return cellHash(cellX, cellZ, salt, stream) / 4294967296;
  }

  // ---- Filters -----------------------------------------------------------------------------
  const ringHeights = new Float64Array(8);
  const surfaceHeights = new Float64Array(8);

  function sampleRing(x, z, radius, out) {
    for (let index = 0; index < 8; index++) {
      const angle = RING_ANGLES[index];
      out[index] = world.heightAt(x + Math.sin(angle) * radius, z - Math.cos(angle) * radius);
    }
  }

  function surfaceMatches(surface, centre) {
    if (surface === 'any') return true;
    let land = 0;
    let water = 0;
    for (let index = 0; index < 8; index++) {
      if (surfaceHeights[index] > waterLevel + 1) land++;
      else if (surfaceHeights[index] < waterLevel - 2) water++;
    }
    if (surface === 'land') return centre > waterLevel + 3 && land === 8;
    if (surface === 'water') return centre < waterLevel - 6 && water === 8;
    return centre > waterLevel - 10 && centre < waterLevel + 14 && land >= 2 && water >= 2;
  }

  function reliefMatches(relief, centre) {
    if (relief === 'any') return true;
    let sum = 0;
    let low = centre;
    let high = centre;
    for (let index = 0; index < 8; index++) {
      const height = ringHeights[index];
      sum += height;
      if (height < low) low = height;
      if (height > high) high = height;
    }
    const mean = sum / 8;
    if (relief === 'peak') return centre - mean >= PEAK_PROMINENCE && centre >= high - 10;
    if (relief === 'valley') return mean - centre >= VALLEY_DEPTH;
    if (relief === 'flat') return high - low <= FLAT_SPREAD;
    return ridgeAxis(centre) >= 0;
  }

  /** Ring index (0-3) of the ridge axis through the centre, or -1 when this is not a ridge. */
  function ridgeAxis(centre) {
    let best = -1;
    let bestScore = Infinity;
    for (let axis = 0; axis < 4; axis++) {
      const alongScore = Math.abs(ringHeights[axis] - centre) + Math.abs(ringHeights[axis + 4] - centre);
      const across = Math.max(ringHeights[(axis + 2) % 8], ringHeights[(axis + 6) % 8]);
      if (alongScore <= RIDGE_ALONG * 2 && across <= centre - RIDGE_DROP && alongScore < bestScore) {
        bestScore = alongScore;
        best = axis;
      }
    }
    return best;
  }

  function siteRotation(entry, cellX, cellZ, centre) {
    const align = entry.preset.placement.align ?? 'random';
    const jitter = (cellRandom(cellX, cellZ, entry.salt, 6) - 0.5) * 0.5;
    if (align === 'downhill') {
      let uphillX = 0;
      let uphillZ = 0;
      for (let index = 0; index < 8; index++) {
        const angle = RING_ANGLES[index];
        uphillX += (ringHeights[index] - centre) * Math.sin(angle);
        uphillZ += (ringHeights[index] - centre) * -Math.cos(angle);
      }
      if (Math.hypot(uphillX, uphillZ) > 1) return Math.atan2(-uphillX, uphillZ) + jitter;
    } else if (align === 'ridge') {
      const axis = ridgeAxis(centre);
      if (axis >= 0) return RING_ANGLES[axis] + (cellRandom(cellX, cellZ, entry.salt, 7) < 0.5 ? 0 : Math.PI) + jitter * 0.3;
    }
    return cellRandom(cellX, cellZ, entry.salt, 5) * Math.PI * 2;
  }

  function landmarksClear(x, z, entry) {
    const room = entry.reach + entry.clearance;
    const landmarks = world.landmarkSitesNear(x, z, room + 400);
    for (const landmark of landmarks) {
      const radius = Math.max(landmark.shapingRadius || 0, LANDMARK_MIN_RADIUS);
      if (Math.hypot(landmark.x - x, landmark.z - z) < room + radius) return false;
    }
    return true;
  }

  // ---- Rules 1-5: one preset in one cell ---------------------------------------------------------
  function buildCandidate(cellX, cellZ, entry) {
    const preset = entry.preset;
    const placement = preset.placement;
    if (cellRandom(cellX, cellZ, entry.salt, 0) >= placement.chance) return null;
    const x = (cellX + 0.15 + 0.7 * cellRandom(cellX, cellZ, entry.salt, 1)) * SITE_CELL;
    const z = (cellZ + 0.15 + 0.7 * cellRandom(cellX, cellZ, entry.salt, 2)) * SITE_CELL;
    const biome = BIOME_KEYS[world.biomeIndexAt(x, z)];
    if (Array.isArray(placement.biomes) && !placement.biomes.includes(biome)) return null;
    const centre = world.heightAt(x, z);
    const terrain = placement.terrain ?? null;
    if (terrain && isNumber(terrain.minHeight) && centre < terrain.minHeight) return null;
    if (terrain && isNumber(terrain.maxHeight) && centre > terrain.maxHeight) return null;
    const surface = placement.surface ?? 'any';
    if (surface !== 'any') {
      sampleRing(x, z, entry.surfaceRadius, surfaceHeights);
      if (!surfaceMatches(surface, centre)) return null;
    }
    const align = placement.align ?? 'random';
    const relief = terrain ? terrain.relief ?? 'any' : 'any';
    if (relief !== 'any' || align !== 'random') sampleRing(x, z, RELIEF_RADIUS, ringHeights);
    if (!reliefMatches(relief, centre)) return null;
    if (!landmarksClear(x, z, entry)) return null;
    const scaleRange = placement.scale ?? [0.85, 1.15];
    return {
      entry,
      cellX,
      cellZ,
      x,
      z,
      groundY: centre,
      biome,
      rotation: siteRotation(entry, cellX, cellZ, centre),
      scale: scaleRange[0] + (scaleRange[1] - scaleRange[0]) * cellRandom(cellX, cellZ, entry.salt, 4),
      seed: cellHash(cellX, cellZ, entry.salt, 8),
      priority: cellRandom(cellX, cellZ, entry.salt, 3),
      spaced: undefined,
      placed: undefined,
    };
  }

  function candidate(cellX, cellZ, entry) {
    const key = cellKey(cellX, cellZ) * presetCount + entry.index;
    let found = candidateCache.get(key);
    if (found === undefined) {
      found = buildCandidate(cellX, cellZ, entry);
      if (candidateCache.size >= CANDIDATE_CACHE_LIMIT) candidateCache.clear();
      candidateCache.set(key, found);
    }
    return found;
  }

  /** True when `other` beats `own`: the higher priority roll, then the lower cell, then the preset order. */
  function beats(other, own) {
    if (other.priority !== own.priority) return other.priority > own.priority;
    if (other.cellX !== own.cellX) return other.cellX < own.cellX;
    if (other.cellZ !== own.cellZ) return other.cellZ < own.cellZ;
    return other.entry.index < own.entry.index;
  }

  // ---- Rule 6: minSpacing within one preset -------------------------------------------------------
  function spaced(own) {
    if (own.spaced !== undefined) return own.spaced;
    const spacing = own.entry.preset.placement.minSpacing;
    const range = Math.ceil(spacing / SITE_CELL);
    let result = true;
    for (let offsetZ = -range; offsetZ <= range && result; offsetZ++) {
      for (let offsetX = -range; offsetX <= range; offsetX++) {
        if (offsetX === 0 && offsetZ === 0) continue;
        const other = candidate(own.cellX + offsetX, own.cellZ + offsetZ, own.entry);
        if (other === null) continue;
        const dx = other.x - own.x;
        const dz = other.z - own.z;
        if (dx * dx + dz * dz < spacing * spacing && beats(other, own)) {
          result = false;
          break;
        }
      }
    }
    own.spaced = result;
    return result;
  }

  // ---- Rule 7: clearance between different sites ------------------------------------------------------
  function placed(own) {
    if (own.placed !== undefined) return own.placed;
    let result = spaced(own);
    if (result) {
      const range = Math.ceil((own.entry.reach + maxReach + maxClearance) / SITE_CELL);
      for (let offsetZ = -range; offsetZ <= range && result; offsetZ++) {
        for (let offsetX = -range; offsetX <= range && result; offsetX++) {
          for (let index = 0; index < presetCount; index++) {
            const entry = entries[index];
            if (entry === own.entry && offsetX === 0 && offsetZ === 0) continue;
            const other = candidate(own.cellX + offsetX, own.cellZ + offsetZ, entry);
            if (other === null || !beats(other, own) || !spaced(other)) continue;
            const room = own.entry.reach + entry.reach + Math.max(own.entry.clearance, entry.clearance);
            const dx = other.x - own.x;
            const dz = other.z - own.z;
            if (dx * dx + dz * dz < room * room) {
              result = false;
              break;
            }
          }
        }
      }
    }
    own.placed = result;
    return result;
  }

  function createSite(own) {
    const preset = own.entry.preset;
    const site = {
      id: `${preset.id}:${own.cellX}:${own.cellZ}`,
      presetId: preset.id,
      cellX: own.cellX,
      cellZ: own.cellZ,
      x: own.x,
      z: own.z,
      groundY: own.groundY,
      rotation: own.rotation,
      scale: own.scale,
      seed: own.seed,
      biome: own.biome,
      stamps: EMPTY,
    };
    const specs = preset.stamps ?? EMPTY;
    if (specs.length > 0) {
      const context = { baseHeight: world.heightAt, waterLevel };
      site.stamps = Object.freeze(specs.map((spec, index) => resolveStamp(spec, site, index, mulberry32(mix32((own.seed ^ Math.imul(index + 1, 0x632be5ab)) >>> 0)), context)));
    }
    return Object.freeze(site);
  }

  // ---- Queries --------------------------------------------------------------------------------------------
  /** The sites whose centre lies in cell (cellX, cellZ), in preset order (a cached, frozen array). */
  function sitesInCell(cellX, cellZ) {
    if (presetCount === 0) return EMPTY;
    const key = cellKey(cellX, cellZ);
    let sites = siteCellCache.get(key);
    if (sites === undefined) {
      let list = null;
      for (let index = 0; index < presetCount; index++) {
        const own = candidate(cellX, cellZ, entries[index]);
        if (own === null || !placed(own)) continue;
        if (list === null) list = [];
        list.push(createSite(own));
      }
      sites = list === null ? EMPTY : Object.freeze(list);
      if (siteCellCache.size >= CELL_CACHE_LIMIT) siteCellCache.clear();
      siteCellCache.set(key, sites);
    }
    return sites;
  }

  /** Every site whose centre is within radius of (x, z), nearest first (a new array). */
  function sitesNear(x, z, radius) {
    const found = [];
    if (presetCount === 0) return found;
    const minCellX = Math.floor((x - radius) / SITE_CELL);
    const maxCellX = Math.floor((x + radius) / SITE_CELL);
    const minCellZ = Math.floor((z - radius) / SITE_CELL);
    const maxCellZ = Math.floor((z + radius) / SITE_CELL);
    const distances = new Map();
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (const site of sitesInCell(cellX, cellZ)) {
          const distance = Math.hypot(site.x - x, site.z - z);
          if (distance > radius) continue;
          distances.set(site, distance);
          found.push(site);
        }
      }
    }
    found.sort((first, second) => distances.get(first) - distances.get(second) || (first.id < second.id ? -1 : 1));
    return found;
  }

  /**
   * The spatial hash: every resolved stamp whose bounds overlap cell (cellX, cellZ) of the SITE_CELL
   * grid, in the global apply order (a cached, frozen array; the same empty array when none).
   */
  function stampsInCell(cellX, cellZ) {
    if (!hasStamps) return EMPTY;
    const key = cellKey(cellX, cellZ);
    let stamps = stampCellCache.get(key);
    if (stamps !== undefined) return stamps;
    const minX = cellX * SITE_CELL;
    const minZ = cellZ * SITE_CELL;
    const maxX = minX + SITE_CELL;
    const maxZ = minZ + SITE_CELL;
    let list = null;
    for (let offsetZ = -stampCellReach; offsetZ <= stampCellReach; offsetZ++) {
      for (let offsetX = -stampCellReach; offsetX <= stampCellReach; offsetX++) {
        for (const site of sitesInCell(cellX + offsetX, cellZ + offsetZ)) {
          for (const stamp of site.stamps) {
            if (stamp.maxX < minX || stamp.minX > maxX || stamp.maxZ < minZ || stamp.minZ > maxZ) continue;
            if (list === null) list = [];
            list.push(stamp);
          }
        }
      }
    }
    if (list === null) stamps = EMPTY;
    else {
      list.sort(compareStampOrder);
      stamps = Object.freeze(list);
    }
    if (stampCellCache.size >= CELL_CACHE_LIMIT) stampCellCache.clear();
    stampCellCache.set(key, stamps);
    return stamps;
  }

  /** True when any stamp's bounds overlap the rectangle (edges included). */
  function stampsOverlap(minX, minZ, maxX, maxZ) {
    if (!hasStamps) return false;
    const minCellX = Math.floor(minX / SITE_CELL);
    const maxCellX = Math.floor(maxX / SITE_CELL);
    const minCellZ = Math.floor(minZ / SITE_CELL);
    const maxCellZ = Math.floor(maxZ / SITE_CELL);
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        for (const stamp of stampsInCell(cellX, cellZ)) {
          if (stamp.maxX >= minX && stamp.minX <= maxX && stamp.maxZ >= minZ && stamp.minZ <= maxZ) return true;
        }
      }
    }
    return false;
  }

  return {
    sitePresets: Object.freeze(entries.map((entry) => entry.preset)),
    maxReach,
    hasStamps,
    sitesInCell,
    sitesNear,
    stampsInCell,
    stampsOverlap,
    /** Drops every cache (answers never change; for memory tests and benchmarks). */
    clearCaches() {
      candidateCache.clear();
      siteCellCache.clear();
      stampCellCache.clear();
    },
  };
}
