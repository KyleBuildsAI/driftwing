// WindField: the air every craft flies through, as one query.
//
//   sample(pos, t, out?) -> { vel: THREE.Vector3 (m/s), turbulence: 0..1 }
//
// The field is a sum of layers, each a pure function of position, time and the sun, so the same
// query gives the same answer (replays and remote wingmen in later phases rely on that):
//   ambient     seeded prevailing wind (the shared windDirection/windStrength uniforms the clouds
//               drift with) that strengthens and veers slowly with height above the ground
//   ridge       the wind component blowing into a slope rises with it (lift on the windward face,
//               sink in the lee), from the gradient of the shared height function
//   thermals    seeded columns over sunny land: strongest at midday, off at night, each living a
//               few minutes, leaning downwind, with a sinking ring around the core. The rising core
//               carries its own air, so the ambient wind is mostly shut out of it. The cloud system
//               draws a small cumulus cap on top of each one (thermalsNear)
//   turbulence  gusts from smooth space-time noise, scaled by wind speed and low height above the
//               ground, plus lee rotor and thermal-edge chop
//   sources     Phase 2 writers: addSource({ id, bounds, sample(pos, t) }) found through a spatial
//               hash. Phase 1 proves the path with a dev-only debug updraft (createDebugUpdraft)
//
// Craft compute airspeed as velocity - sample(pos, t).vel. CLASSIC scales the result down itself.
// probe(pos, t, out?) is the same query without touching lastLayers (overlays, many-point probes).
import * as THREE from 'three/webgpu';
import { headingFromVector, wrapDegrees } from '../core/util.js';

const AMBIENT_SPEED = 6;
const AMBIENT_REFERENCE_AGL = 400;
const RIDGE_PROBE = 40;
const RIDGE_DECAY = 160;
const RIDGE_MAX_SLOPE = 1.2;

const THERMAL_CELL = 1400;
const THERMAL_CACHE_LIMIT = 600;
const THERMAL_CLIMB_FOR_LEAN = 2.5;
const THERMAL_LEAN_SHARE = 0.35;
const THERMAL_LEAN_LIMIT = 260;
const THERMAL_RING = 2.2;
// Core size and strength: a glider circling at about 40 deg of bank (60 m radius) inside a mature
// thermal at midday climbs about 1-3 m/s.
const THERMAL_RADIUS_MIN = 100;
const THERMAL_RADIUS_SPAN = 90;
const THERMAL_PEAK_MIN = 3;
const THERMAL_PEAK_SPAN = 2.6;
// The rising core carries its own air along the leaning column, so the ambient wind is mostly
// shut out of it (at most this share, reached once the core rises at THERMAL_SHELTER_CLIMB m/s):
// a glider circling in the core drifts out slowly instead of at the full wind speed.
const THERMAL_SHELTER = 0.9;
const THERMAL_SHELTER_CLIMB = 1.2;
/** The shelter is whole out to this fraction of the core radius and fades to nothing at its edge. */
const THERMAL_SHELTER_EDGE = 0.55;
/** Chance of a thermal per cell, by biome: bright dry ground triggers the best thermals. */
const THERMAL_BIOME_CHANCE = Object.freeze({ dunes: 0.85, meadows: 0.8, pine: 0.45, archipelago: 0.35, snow: 0.15 });

const SOURCE_CELL = 256;
const SOURCE_GLOBAL_CELLS = 64;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Sources are keyed by their id as a string, so a numeric id finds the same entry on every call. */
function sourceKey(id) {
  return String(id ?? '');
}

function cellHashKey(cellX, cellZ) {
  return cellX * 73856093 + cellZ * 19349663;
}

/** Smooth noise in about [-1, 1]: incommensurate sines, phase-shifted by the world seed. */
function createGustNoise(seedHash) {
  const phases = Array.from({ length: 16 }, (unused, index) => (((seedHash + 1) * (index + 7) * 2654435761) >>> 0) / 4294967296 * Math.PI * 2);
  return function gust(channel, time, x, z) {
    const base = channel * 4;
    return (
      0.5 * Math.sin(time * 0.53 + x * 0.0041 + phases[base])
      + 0.3 * Math.sin(time * 1.37 - z * 0.0063 + phases[base + 1])
      + 0.15 * Math.sin(time * 3.11 + (x + z) * 0.011 + phases[base + 2])
      + 0.05 * Math.sin(time * 7.9 - x * 0.023 + phases[base + 3])
    );
  };
}

/** Normalizes a source's bounds to an axis-aligned box. Accepts { min, max } or { center, radius }. */
function boxFromBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') throw new TypeError('wind source needs bounds');
  const finite = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
  if (finite(bounds.min) && finite(bounds.max)) {
    return {
      minX: Math.min(bounds.min.x, bounds.max.x), minY: Math.min(bounds.min.y, bounds.max.y), minZ: Math.min(bounds.min.z, bounds.max.z),
      maxX: Math.max(bounds.min.x, bounds.max.x), maxY: Math.max(bounds.min.y, bounds.max.y), maxZ: Math.max(bounds.min.z, bounds.max.z),
    };
  }
  if (finite(bounds.center) && Number.isFinite(bounds.radius) && bounds.radius > 0) {
    const { center, radius } = bounds;
    return { minX: center.x - radius, minY: center.y - radius, minZ: center.z - radius, maxX: center.x + radius, maxY: center.y + radius, maxZ: center.z + radius };
  }
  throw new TypeError('wind source bounds must be { min, max } or { center, radius } with finite values');
}

export function createWindField({ world, uniforms, state, bus }) {
  const gust = createGustNoise(world.seedHash >>> 0);
  const thermalCells = new Map();
  const sources = new Map();
  const sourceCells = new Map();
  const globalSources = new Set();
  const samplePosition = new THREE.Vector3();
  const ambientScratch = new THREE.Vector3();
  const lastLayers = { ambient: new THREE.Vector3(), ridge: 0, thermal: 0, gust: new THREE.Vector3(), sources: 0, turbulence: 0 };

  // ---- Ambient ----------------------------------------------------------------------------
  function ambientProfile(heightAboveGround) {
    const agl = Math.max(heightAboveGround, 1);
    return Math.min(1.25, Math.max(0.35, (agl / AMBIENT_REFERENCE_AGL) ** 0.14));
  }

  /** Writes the ambient wind at heightAboveGround into target: stronger and veered up to 20 deg aloft. */
  function ambientAt(heightAboveGround, target) {
    const direction = uniforms.windDirection.value;
    const speed = AMBIENT_SPEED * uniforms.windStrength.value * ambientProfile(heightAboveGround);
    const veer = 0.35 * smoothstep(0, 1500, heightAboveGround);
    const cosVeer = Math.cos(veer);
    const sinVeer = Math.sin(veer);
    return target.set((direction.x * cosVeer - direction.y * sinVeer) * speed, 0, (direction.x * sinVeer + direction.y * cosVeer) * speed);
  }

  // ---- Ridge lift -------------------------------------------------------------------------
  function ridgeLift(x, z, surface, heightAboveGround, windX, windZ, result) {
    result.lift = 0;
    result.lee = 0;
    if (heightAboveGround > RIDGE_DECAY * 5) return result;
    const slopeX = Math.max(-RIDGE_MAX_SLOPE, Math.min(RIDGE_MAX_SLOPE, (world.groundHeight(x + RIDGE_PROBE, z) - surface) / RIDGE_PROBE));
    const slopeZ = Math.max(-RIDGE_MAX_SLOPE, Math.min(RIDGE_MAX_SLOPE, (world.groundHeight(x, z + RIDGE_PROBE) - surface) / RIDGE_PROBE));
    const upslope = windX * slopeX + windZ * slopeZ;
    const decay = Math.exp(-Math.max(heightAboveGround, 0) / RIDGE_DECAY);
    result.lift = upslope * decay;
    result.lee = Math.max(0, -upslope) * decay;
    return result;
  }

  // ---- Thermals ----------------------------------------------------------------------------
  function solarFactor() {
    return smoothstep(3, 45, state.time.sunElevation);
  }

  /** The seeded thermal of a cell, or null. Cached: it samples the terrain and biome once. */
  function thermalForCell(cellX, cellZ) {
    const key = cellHashKey(cellX, cellZ);
    if (thermalCells.has(key)) {
      const cached = thermalCells.get(key);
      if (cached === null || (cached.cellX === cellX && cached.cellZ === cellZ)) return cached;
    }
    if (thermalCells.size > THERMAL_CACHE_LIMIT) thermalCells.delete(thermalCells.keys().next().value);
    const roll = (salt) => world.hash2(cellX, cellZ, salt);
    const x = (cellX + 0.15 + 0.7 * roll(901)) * THERMAL_CELL;
    const z = (cellZ + 0.15 + 0.7 * roll(902)) * THERMAL_CELL;
    const ground = world.groundHeight(x, z);
    const chance = THERMAL_BIOME_CHANCE[world.biomeAt(x, z).key] ?? 0.4;
    if (ground < world.WATER_LEVEL + 2 || roll(900) >= chance) {
      thermalCells.set(key, null);
      return null;
    }
    const thermal = {
      id: `thermal:${cellX}:${cellZ}`,
      cellX,
      cellZ,
      x,
      z,
      ground,
      radius: THERMAL_RADIUS_MIN + THERMAL_RADIUS_SPAN * roll(904),
      peak: THERMAL_PEAK_MIN + THERMAL_PEAK_SPAN * roll(905),
      top: ground + 650 + 700 * roll(906),
      phase: roll(907),
      period: 900 + 600 * roll(908),
    };
    thermalCells.set(key, thermal);
    return thermal;
  }

  /** Current core strength (m/s) of a thermal: the sun times its slow life cycle. */
  function thermalStrength(thermal, time) {
    const cycle = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (time / thermal.period + thermal.phase));
    return thermal.peak * solarFactor() * smoothstep(0.25, 0.6, cycle);
  }

  /** Where the column is at height: it drifts downwind as it rises. */
  function thermalLean(thermal, height, windX, windZ, target) {
    const rise = Math.max(0, height - thermal.ground);
    const distance = Math.min(THERMAL_LEAN_LIMIT, (rise / THERMAL_CLIMB_FOR_LEAN) * THERMAL_LEAN_SHARE);
    const windSpeed = Math.hypot(windX, windZ) || 1;
    const share = distance * Math.min(1, windSpeed / 6);
    target.x = thermal.x + (windX / windSpeed) * share;
    target.z = thermal.z + (windZ / windSpeed) * share;
    return target;
  }

  /** Vertical profile between the ground (0) and the cap (1), peak near 1. */
  function thermalProfile(normalizedHeight) {
    if (normalizedHeight <= 0) return 0;
    if (normalizedHeight >= 1) return Math.max(0, 0.35 * (1 - (normalizedHeight - 1) * 8));
    return Math.max(0.3 * normalizedHeight, Math.cbrt(normalizedHeight) * (1 - 0.9 * normalizedHeight) / 0.5);
  }

  const leanScratch = { x: 0, z: 0 };
  function thermalAt(x, y, z, time, windX, windZ, result) {
    result.lift = 0;
    result.edge = 0;
    result.shelter = 0;
    if (solarFactor() <= 0) return result;
    const centerCellX = Math.floor(x / THERMAL_CELL);
    const centerCellZ = Math.floor(z / THERMAL_CELL);
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const thermal = thermalForCell(centerCellX + offsetX, centerCellZ + offsetZ);
        if (!thermal) continue;
        const normalizedHeight = (y - thermal.ground) / (thermal.top - thermal.ground);
        if (normalizedHeight <= 0 || normalizedHeight > 1.15) continue;
        thermalLean(thermal, y, windX, windZ, leanScratch);
        const ratio = Math.hypot(x - leanScratch.x, z - leanScratch.z) / thermal.radius;
        if (ratio > 1 + THERMAL_RING) continue;
        const vertical = thermalStrength(thermal, time) * thermalProfile(normalizedHeight);
        if (vertical <= 0) continue;
        if (ratio < 1) {
          const core = 1 - ratio * ratio;
          result.lift += vertical * core;
          result.edge = Math.max(result.edge, smoothstep(0.55, 1, ratio) * vertical);
          result.shelter = Math.max(result.shelter, THERMAL_SHELTER * (1 - smoothstep(THERMAL_SHELTER_EDGE, 1, ratio)) * smoothstep(0, THERMAL_SHELTER_CLIMB, vertical));
        } else {
          const ring = Math.sin(Math.PI * Math.min(1, (ratio - 1) / THERMAL_RING));
          result.lift -= 0.28 * vertical * ring;
          result.edge = Math.max(result.edge, 0.6 * ring * vertical);
        }
      }
    }
    return result;
  }

  // ---- Sources (Phase 2 writer API) ----------------------------------------------------------
  function unindexSource(entry) {
    globalSources.delete(entry);
    for (const key of entry.cells) sourceCells.get(key)?.delete(entry);
    entry.cells.length = 0;
  }

  function indexSource(entry) {
    unindexSource(entry);
    const box = entry.box;
    const minX = Math.floor(box.minX / SOURCE_CELL);
    const maxX = Math.floor(box.maxX / SOURCE_CELL);
    const minZ = Math.floor(box.minZ / SOURCE_CELL);
    const maxZ = Math.floor(box.maxZ / SOURCE_CELL);
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > SOURCE_GLOBAL_CELLS) {
      globalSources.add(entry);
      return;
    }
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
        const key = cellHashKey(cellX, cellZ);
        let bucket = sourceCells.get(key);
        if (!bucket) {
          bucket = new Set();
          sourceCells.set(key, bucket);
        }
        bucket.add(entry);
        entry.cells.push(key);
      }
    }
  }

  let sourceTurbulence = 0;
  function visitSource(entry, position, time, out) {
    const box = entry.box;
    if (position.x < box.minX || position.x > box.maxX || position.y < box.minY || position.y > box.maxY || position.z < box.minZ || position.z > box.maxZ) return;
    let result;
    try {
      result = entry.sample(position, time);
    } catch (error) {
      if (!entry.failed) {
        entry.failed = true;
        console.error(`[DRIFTWING] wind source "${entry.id}" failed to sample`, error);
      }
      return;
    }
    if (!result) return;
    const vel = result.vel;
    if (vel && Number.isFinite(vel.x) && Number.isFinite(vel.y) && Number.isFinite(vel.z)) {
      out.vel.x += vel.x;
      out.vel.y += vel.y;
      out.vel.z += vel.z;
    }
    if (Number.isFinite(result.turbulence)) sourceTurbulence = Math.max(sourceTurbulence, Math.min(1, Math.max(0, result.turbulence)));
  }

  function applySources(position, time, out) {
    sourceTurbulence = 0;
    const bucket = sourceCells.get(cellHashKey(Math.floor(position.x / SOURCE_CELL), Math.floor(position.z / SOURCE_CELL)));
    if (bucket) for (const entry of bucket) visitSource(entry, position, time, out);
    for (const entry of globalSources) visitSource(entry, position, time, out);
    return sourceTurbulence;
  }

  function describeSource(entry) {
    const box = entry.box;
    const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 };
    const radius = Math.hypot(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ) / 2;
    return { id: entry.id, kind: entry.kind, position: center, radius };
  }

  // ---- Public sample ---------------------------------------------------------------------------
  const ridgeResult = { lift: 0, lee: 0 };
  const thermalResult = { lift: 0, edge: 0, shelter: 0 };
  const layerAmbient = new THREE.Vector3();
  const layerGust = new THREE.Vector3();

  /**
   * The whole field at pos. record = true publishes the per-layer values in lastLayers (the craft's
   * own sample); probes for visualisation pass false so they never overwrite the craft's layers.
   */
  function sampleField(pos, t, out, record) {
    const { x, y, z } = pos;
    const surface = Math.max(world.groundHeight(x, z), world.WATER_LEVEL);
    const heightAboveGround = y - surface;

    ambientAt(heightAboveGround, layerAmbient);
    out.vel.copy(layerAmbient);
    const windX = layerAmbient.x;
    const windZ = layerAmbient.z;
    const windSpeed = Math.hypot(windX, windZ);

    ridgeLift(x, z, surface, heightAboveGround, windX, windZ, ridgeResult);
    thermalAt(x, y, z, t, windX, windZ, thermalResult);
    out.vel.y += ridgeResult.lift + thermalResult.lift;
    if (thermalResult.shelter > 0 && windSpeed > 1e-3) {
      // Inside a core the air moves with the column: it rises and drifts only as fast as the lean.
      const columnDrift = Math.max(0, thermalResult.lift) * (THERMAL_LEAN_SHARE / THERMAL_CLIMB_FOR_LEAN) * Math.min(1, windSpeed / 6);
      const horizontal = (1 - thermalResult.shelter) + thermalResult.shelter * columnDrift / windSpeed;
      out.vel.x *= horizontal;
      out.vel.z *= horizontal;
    }

    // Turbulence intensity (m/s): mechanical near the ground, lee rotor, thermal edges, light chop.
    const mechanical = 0.16 * windSpeed * Math.exp(-Math.max(heightAboveGround, 0) / 260);
    const sigma = Math.hypot(mechanical, 0.9 * ridgeResult.lee, 0.45 * thermalResult.edge, 0.2);
    layerGust.set(sigma * gust(0, t, x, z), sigma * 0.6 * gust(1, t, z, x), sigma * gust(2, t, x + 311, z - 173));
    out.vel.add(layerGust);

    let fromSources = 0;
    if (sources.size > 0) {
      samplePosition.set(x, y, z);
      fromSources = applySources(samplePosition, t, out);
    }
    out.turbulence = Math.min(1, Math.max(sigma / 3, fromSources));
    if (record) {
      lastLayers.ambient.copy(layerAmbient);
      lastLayers.ridge = ridgeResult.lift;
      lastLayers.thermal = thermalResult.lift;
      lastLayers.gust.copy(layerGust);
      lastLayers.sources = sources.size;
      lastLayers.turbulence = out.turbulence;
    }
    return out;
  }

  function sample(pos, t = state.time.elapsed, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
    return sampleField(pos, t, out, true);
  }

  /**
   * Visits the thermals whose columns stand within radius of (x, z) at time t:
   * visit({ id, x, z, radius, ground, top, strength, capX, capZ }). The cloud system draws a
   * cumulus cap at (capX, top, capZ) sized by strength.
   */
  function thermalsNear(x, z, radius, visit, t = state.time.elapsed) {
    const reach = Math.ceil(radius / THERMAL_CELL) + 1;
    const centerCellX = Math.floor(x / THERMAL_CELL);
    const centerCellZ = Math.floor(z / THERMAL_CELL);
    for (let offsetZ = -reach; offsetZ <= reach; offsetZ++) {
      for (let offsetX = -reach; offsetX <= reach; offsetX++) {
        const thermal = thermalForCell(centerCellX + offsetX, centerCellZ + offsetZ);
        if (!thermal || Math.hypot(thermal.x - x, thermal.z - z) > radius) continue;
        ambientAt(thermal.top - thermal.ground, ambientScratch);
        thermalLean(thermal, thermal.top, ambientScratch.x, ambientScratch.z, leanScratch);
        visit({ id: thermal.id, x: thermal.x, z: thermal.z, radius: thermal.radius, ground: thermal.ground, top: thermal.top, strength: thermalStrength(thermal, t), capX: leanScratch.x, capZ: leanScratch.z });
      }
    }
  }

  return {
    sample,
    thermalsNear,

    /**
     * Same result as sample(), but leaves lastLayers untouched: for visualisation and other
     * many-point queries that must not disturb the craft's own per-layer reading.
     */
    probe(pos, t = state.time.elapsed, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
      return sampleField(pos, t, out, false);
    },

    /**
     * Adds a wind source: { id, bounds, sample(pos, t), kind? }. bounds is { min, max } (world-space
     * box) or { center, radius }; sample(pos, t) returns { vel?: {x,y,z}, turbulence?: 0..1 } or null
     * and is only called for positions inside bounds. Velocities add to the field; turbulence takes
     * the maximum. Returns the id.
     */
    addSource(source) {
      if (!source || typeof source.sample !== 'function') throw new TypeError('wind source needs sample(pos, t)');
      const id = sourceKey(source.id);
      if (!id) throw new TypeError('wind source needs an id');
      if (sources.has(id)) throw new Error(`wind source "${id}" already exists`);
      const kind = typeof source.kind === 'string' && source.kind ? source.kind : 'source';
      const entry = { id, kind, box: boxFromBounds(source.bounds), sample: source.sample, cells: [], failed: false };
      sources.set(id, entry);
      indexSource(entry);
      bus.emitTyped('windSourceAdded', describeSource(entry));
      return id;
    },

    /** Moves or resizes a source (same bounds forms as addSource). */
    setSourceBounds(id, bounds) {
      const entry = sources.get(sourceKey(id));
      if (!entry) return false;
      entry.box = boxFromBounds(bounds);
      indexSource(entry);
      return true;
    },

    removeSource(id) {
      const entry = sources.get(sourceKey(id));
      if (!entry) return false;
      unindexSource(entry);
      sources.delete(entry.id);
      bus.emitTyped('windSourceRemoved', { id: entry.id, kind: entry.kind });
      return true;
    },

    get sourceCount() { return sources.size; },
    listSources() {
      return [...sources.values()].map(describeSource);
    },

    /** The nearest working thermal (core at least minStrength m/s), for the copilot and instruments. */
    nearestThermal(pos, minStrength = 0.8, t = state.time.elapsed) {
      let best = null;
      thermalsNear(pos.x, pos.z, THERMAL_CELL * 2, (thermal) => {
        if (thermal.strength < minStrength) return;
        const distance = Math.hypot(thermal.x - pos.x, thermal.z - pos.z);
        if (!best || distance < best.distance) best = { ...thermal, distance };
      }, t);
      return best;
    },

    /** Ambient wind at pos: speed (m/s) and the compass direction it blows FROM (degrees). */
    ambientAt(pos) {
      const surface = Math.max(world.groundHeight(pos.x, pos.z), world.WATER_LEVEL);
      const vector = ambientAt(pos.y - surface, new THREE.Vector3());
      return { speed: Math.hypot(vector.x, vector.z), fromDegrees: wrapDegrees(headingFromVector(vector.x, vector.z) + 180) };
    },

    /** Per-layer values from the most recent sample (dev overlay, instruments). */
    get lastLayers() { return lastLayers; },
  };
}

/**
 * Dev-only wind source: a rising column with a gentle swirl, used to prove addSource, the spatial
 * hash, sampling and removal end to end before Phase 2 spawns exist.
 */
export function createDebugUpdraft({ id = 'debug-updraft', center, radius = 220, strength = 6 }) {
  const result = { vel: new THREE.Vector3(), turbulence: 0 };
  const origin = { x: center.x, y: center.y, z: center.z };
  return {
    id,
    kind: 'debug-updraft',
    bounds: { center: origin, radius },
    sample(pos) {
      const dx = pos.x - origin.x;
      const dy = pos.y - origin.y;
      const dz = pos.z - origin.z;
      const horizontal = Math.hypot(dx, dz) / radius;
      const vertical = Math.abs(dy) / radius;
      const falloff = Math.max(0, 1 - horizontal * horizontal) * Math.max(0, 1 - vertical * vertical);
      const swirl = 0.25 * strength * falloff;
      const length = Math.hypot(dx, dz) || 1;
      result.vel.set((-dz / length) * swirl, strength * falloff, (dx / length) * swirl);
      result.turbulence = 0.4 * falloff;
      return result;
    },
  };
}
