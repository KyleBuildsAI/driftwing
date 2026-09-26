// WindField: the air every craft flies through, as one query.
//
//   sample(position, time, out?) -> { vel: {x, y, z} m/s, turbulence: 0..1 }
//
// The field is a sum of layers, each a pure function of position and time plus slowly changing
// world state (sun, clouds), so the same query always answers the same way within a frame:
//   ambient     prevailing wind from the shared windDirection/windStrength uniforms (the clouds
//               drift with the same wind), with a boundary-layer profile above the ground
//   ridge       wind blowing up a slope rises with it (lift on the windward face, sink in the lee),
//               fading with height above the terrain
//   thermals    a rising column under every visible cumulus, strength set by the sun and the
//               cloud's size, leaning downwind, with a sinking ring around the core
//   turbulence  gusts from smooth space-time noise; mechanical near the ground and in the lee,
//               convective at thermal edges, light chop everywhere
//   sources     anything else that moves air registers here (a debug updraft in Phase 1; the
//               Phase 2 event director's spawns) and is found through a spatial hash
//
// Craft read airspeed as (craft velocity - sample().vel). CLASSIC scales the result down itself.
import { headingFromVector, wrapDegrees } from '../core/util.js';

const SOURCE_CELL = 256;
const SOURCE_GLOBAL_RADIUS = SOURCE_CELL * 6;
const AMBIENT_SPEED = 6;
const AMBIENT_REFERENCE_AGL = 400;
const RIDGE_PROBE = 40;
const RIDGE_DECAY = 160;
const THERMAL_SEARCH_RADIUS = 1200;
const THERMAL_CORE_FRACTION = 0.42;
const THERMAL_LEAN_LIMIT = 160;
const THERMAL_CLIMB_FOR_LEAN = 3;

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Smooth 1D noise in [-1, 1]: a few incommensurate sines, phase-shifted by the world seed. */
function createGustNoise(seedHash) {
  const phases = Array.from({ length: 12 }, (unused, index) => ((seedHash * (index + 7) * 2654435761) >>> 0) / 4294967296 * Math.PI * 2);
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

export function createWindField({ world, uniforms, state, bus }) {
  const gust = createGustNoise(world.seedHash);
  const sources = new Map();
  const sourceCells = new Map();
  const globalSources = new Set();
  const sourceScratch = { x: 0, y: 0, z: 0 };
  const thermalScratch = [];
  const thermalPool = [];
  let thermalProvider = null;
  let nextSourceId = 1;

  const layerTotals = { ambient: { x: 0, y: 0, z: 0 }, ridge: 0, thermal: 0, sources: 0 };

  // ---- Ambient ----------------------------------------------------------------------------
  function ambientProfile(heightAboveGround) {
    const agl = Math.max(heightAboveGround, 1);
    return Math.min(1.25, Math.max(0.35, (agl / AMBIENT_REFERENCE_AGL) ** 0.14));
  }

  function ambientSpeed() {
    return AMBIENT_SPEED * uniforms.windStrength.value;
  }

  // ---- Ridge lift -------------------------------------------------------------------------
  function ridgeLift(x, z, ground, heightAboveGround, windX, windZ) {
    if (heightAboveGround > RIDGE_DECAY * 5) return { lift: 0, lee: 0 };
    const slopeX = (world.groundHeight(x + RIDGE_PROBE, z) - ground) / RIDGE_PROBE;
    const slopeZ = (world.groundHeight(x, z + RIDGE_PROBE) - ground) / RIDGE_PROBE;
    const upslope = windX * Math.max(-1.2, Math.min(1.2, slopeX)) + windZ * Math.max(-1.2, Math.min(1.2, slopeZ));
    const decay = Math.exp(-Math.max(heightAboveGround, 0) / RIDGE_DECAY);
    return { lift: upslope * decay, lee: Math.max(0, -upslope) * decay };
  }

  // ---- Thermals ----------------------------------------------------------------------------
  function solarFactor() {
    return smoothstep(4, 35, state.time.sunElevation);
  }

  /** Vertical profile of a thermal between the ground (0) and cloud base (1), peak about 1. */
  function thermalProfile(normalizedHeight) {
    if (normalizedHeight <= 0) return 0;
    if (normalizedHeight >= 1) return Math.max(0, 0.35 * (1 - (normalizedHeight - 1) * 8));
    return Math.max(0.3 * normalizedHeight, Math.cbrt(normalizedHeight) * (1 - 0.9 * normalizedHeight) / 0.5);
  }

  /** Records one core reported by the provider, reusing pooled records (sampled at 120 Hz). */
  function pushThermal(coreX, coreZ, radius, base, growth) {
    const index = thermalScratch.length;
    if (!thermalPool[index]) thermalPool[index] = { x: 0, z: 0, radius: 0, base: 0, growth: 0 };
    const core = thermalPool[index];
    core.x = coreX;
    core.z = coreZ;
    core.radius = radius;
    core.base = base;
    core.growth = growth;
    thermalScratch.push(core);
  }

  /** Fills thermalScratch with the thermal cores near (x, z). */
  function collectThermals(x, z) {
    thermalScratch.length = 0;
    if (thermalProvider) thermalProvider(x, z, THERMAL_SEARCH_RADIUS, pushThermal);
    return thermalScratch;
  }

  function thermalAt(x, y, z, ground, windX, windZ, result) {
    result.lift = 0;
    result.edge = 0;
    const sun = solarFactor();
    if (sun <= 0) return result;
    const cores = collectThermals(x, z);
    for (const core of cores) {
      const baseAgl = core.base - ground;
      if (baseAgl < 60) continue;
      const normalizedHeight = (y - ground) / baseAgl;
      if (normalizedHeight <= 0 || normalizedHeight > 1.15) continue;
      // The column rises from upwind of the cloud it feeds, so low down it sits further upwind.
      const lean = Math.min(THERMAL_LEAN_LIMIT, (core.base - y) / THERMAL_CLIMB_FOR_LEAN * 0.08);
      const centerX = core.x - windX * lean;
      const centerZ = core.z - windZ * lean;
      const radius = Math.max(45, core.radius * THERMAL_CORE_FRACTION);
      const distance = Math.hypot(x - centerX, z - centerZ);
      if (distance > radius * 2.2) continue;
      const peak = sun * (1.2 + 3.2 * core.growth * Math.min(1, core.radius / 260));
      const vertical = peak * thermalProfile(normalizedHeight);
      const ratio = distance / radius;
      if (ratio < 1) {
        result.lift += vertical * (1 - ratio * ratio);
        result.edge = Math.max(result.edge, smoothstep(0.55, 1, ratio) * vertical);
      } else {
        const ring = Math.sin(Math.PI * Math.min(1, (ratio - 1) / 1.2));
        result.lift -= 0.28 * vertical * ring;
        result.edge = Math.max(result.edge, 0.6 * ring * vertical);
      }
    }
    return result;
  }

  // ---- Sources --------------------------------------------------------------------------------
  function cellKey(cellX, cellZ) {
    return `${cellX},${cellZ}`;
  }

  function unindexSource(entry) {
    globalSources.delete(entry);
    for (const key of entry.cells) sourceCells.get(key)?.delete(entry);
    entry.cells.length = 0;
  }

  function indexSource(entry) {
    unindexSource(entry);
    const { position, radius } = entry.source;
    if (radius > SOURCE_GLOBAL_RADIUS) {
      globalSources.add(entry);
      return;
    }
    const minX = Math.floor((position.x - radius) / SOURCE_CELL);
    const maxX = Math.floor((position.x + radius) / SOURCE_CELL);
    const minZ = Math.floor((position.z - radius) / SOURCE_CELL);
    const maxZ = Math.floor((position.z + radius) / SOURCE_CELL);
    for (let cellX = minX; cellX <= maxX; cellX++) {
      for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
        const key = cellKey(cellX, cellZ);
        if (!sourceCells.has(key)) sourceCells.set(key, new Set());
        sourceCells.get(key).add(entry);
        entry.cells.push(key);
      }
    }
  }

  function validateSource(source) {
    const position = source && source.position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      throw new TypeError('wind source needs a finite position {x, y, z}');
    }
    if (!(source.radius > 0) || !Number.isFinite(source.radius)) throw new TypeError('wind source needs a positive radius');
    if (typeof source.sample !== 'function') throw new TypeError('wind source needs sample(dx, dy, dz, time, outVel) -> turbulence');
    if (typeof source.kind !== 'string' || !source.kind) throw new TypeError('wind source needs a kind');
  }

  function applySources(x, y, z, time, out) {
    let turbulence = 0;
    const key = cellKey(Math.floor(x / SOURCE_CELL), Math.floor(z / SOURCE_CELL));
    const local = sourceCells.get(key);
    const visit = (entry) => {
      const { position, radius } = entry.source;
      const dx = x - position.x;
      const dy = y - position.y;
      const dz = z - position.z;
      if (dx * dx + dy * dy + dz * dz > radius * radius) return;
      sourceScratch.x = 0;
      sourceScratch.y = 0;
      sourceScratch.z = 0;
      const sourceTurbulence = entry.source.sample(dx, dy, dz, time, sourceScratch);
      if (Number.isFinite(sourceScratch.x) && Number.isFinite(sourceScratch.y) && Number.isFinite(sourceScratch.z)) {
        out.vel.x += sourceScratch.x;
        out.vel.y += sourceScratch.y;
        out.vel.z += sourceScratch.z;
      }
      if (Number.isFinite(sourceTurbulence)) turbulence = Math.max(turbulence, sourceTurbulence);
    };
    if (local) for (const entry of local) visit(entry);
    for (const entry of globalSources) visit(entry);
    return turbulence;
  }

  // ---- Public sample ---------------------------------------------------------------------------
  const thermalResult = { lift: 0, edge: 0 };

  function sample(position, time = state.time.elapsed, out = { vel: { x: 0, y: 0, z: 0 }, turbulence: 0 }) {
    const { x, y, z } = position;
    const ground = world.groundHeight(x, z);
    const heightAboveGround = y - Math.max(ground, world.WATER_LEVEL);
    const direction = uniforms.windDirection.value;
    const speed = ambientSpeed() * ambientProfile(heightAboveGround);
    const windX = direction.x * speed;
    const windZ = direction.y * speed;
    out.vel.x = windX;
    out.vel.y = 0;
    out.vel.z = windZ;
    layerTotals.ambient.x = windX;
    layerTotals.ambient.z = windZ;

    const ridge = ridgeLift(x, z, Math.max(ground, world.WATER_LEVEL), heightAboveGround, windX, windZ);
    out.vel.y += ridge.lift;
    layerTotals.ridge = ridge.lift;

    thermalAt(x, y, z, Math.max(ground, world.WATER_LEVEL), direction.x, direction.y, thermalResult);
    out.vel.y += thermalResult.lift;
    layerTotals.thermal = thermalResult.lift;

    // Turbulence intensity (m/s standard deviation) from each mechanism, then gusts from noise.
    const mechanical = 0.16 * speed * Math.exp(-Math.max(heightAboveGround, 0) / 260);
    const lee = 0.9 * ridge.lee;
    const convective = 0.45 * thermalResult.edge;
    const chop = 0.25;
    const sigma = Math.hypot(mechanical, lee, convective, chop);
    out.vel.x += sigma * gust(0, time, x, z);
    out.vel.y += sigma * 0.6 * gust(1, time, z, x);
    out.vel.z += sigma * gust(2, time, x + 311, z - 173);

    const sourceTurbulence = sources.size ? applySources(x, y, z, time, out) : 0;
    layerTotals.sources = sources.size;
    out.turbulence = Math.min(1, Math.max(sigma / 3, sourceTurbulence));
    return out;
  }

  return {
    sample,

    /**
     * Registers a wind source: { kind, position {x,y,z}, radius, sample(dx, dy, dz, time, outVel) }.
     * sample adds its velocity into outVel for the offset from the source centre and returns a
     * turbulence value 0..1. Returns the source id. Call moveSource(id) after changing position.
     */
    addSource(source) {
      validateSource(source);
      const id = source.id ? String(source.id) : `wind-${nextSourceId++}`;
      if (sources.has(id)) throw new Error(`wind source "${id}" already exists`);
      const entry = { id, source, cells: [] };
      sources.set(id, entry);
      indexSource(entry);
      bus.emitTyped('windSourceAdded', { id, kind: source.kind, position: { x: source.position.x, y: source.position.y, z: source.position.z }, radius: source.radius });
      return id;
    },

    /** Re-indexes a source after its position or radius changed. */
    moveSource(id) {
      const entry = sources.get(id);
      if (!entry) return false;
      indexSource(entry);
      return true;
    },

    removeSource(id) {
      const entry = sources.get(id);
      if (!entry) return false;
      unindexSource(entry);
      sources.delete(id);
      bus.emitTyped('windSourceRemoved', { id, kind: entry.source.kind });
      return true;
    },

    get sourceCount() { return sources.size; },
    listSources() {
      return [...sources.values()].map(({ id, source }) => ({ id, kind: source.kind, position: { ...source.position }, radius: source.radius }));
    },

    /**
     * Installs the function that lists cumulus cores near a point:
     * provider(x, z, radius, visit) calls visit(coreX, coreZ, coreRadius, cloudBase, growth) per core.
     */
    setThermalProvider(provider) {
      thermalProvider = typeof provider === 'function' ? provider : null;
    },

    /** The strongest thermal core near position, for the copilot and instruments. */
    nearestThermal(position) {
      const cores = collectThermals(position.x, position.z);
      const sun = solarFactor();
      let best = null;
      for (const core of cores) {
        const strength = sun * (1.2 + 3.2 * core.growth * Math.min(1, core.radius / 260));
        if (strength < 0.5) continue;
        const distance = Math.hypot(core.x - position.x, core.z - position.z);
        if (!best || distance < best.distance) best = { x: core.x, z: core.z, base: core.base, strength, distance };
      }
      return best;
    },

    /** Ambient wind at position: speed (m/s) and the compass direction it blows FROM (degrees). */
    ambientAt(position) {
      const ground = world.groundHeight(position.x, position.z);
      const speed = ambientSpeed() * ambientProfile(position.y - Math.max(ground, world.WATER_LEVEL));
      const direction = uniforms.windDirection.value;
      return { speed, fromDegrees: wrapDegrees(headingFromVector(direction.x, direction.y) + 180) };
    },

    /** Per-layer values from the last sample (for the dev overlay). */
    get lastLayers() { return layerTotals; },
  };
}

/**
 * A dev-only wind source: a rising column with a gentle swirl. Used to prove the source path
 * end to end (addSource, spatial hash, sampling, removal) before Phase 2 spawns exist.
 */
export function createDebugUpdraft({ position, radius = 220, strength = 6, id } = {}) {
  return {
    id,
    kind: 'debug-updraft',
    position: { x: position.x, y: position.y, z: position.z },
    radius,
    sample(dx, dy, dz, time, outVel) {
      const horizontal = Math.hypot(dx, dz) / radius;
      const vertical = Math.abs(dy) / radius;
      const falloff = Math.max(0, 1 - horizontal * horizontal) * Math.max(0, 1 - vertical * vertical);
      outVel.y += strength * falloff;
      const swirl = 0.25 * strength * falloff;
      const length = Math.hypot(dx, dz) || 1;
      outVel.x += (-dz / length) * swirl;
      outVel.z += (dx / length) * swirl;
      return 0.4 * falloff;
    },
  };
}
