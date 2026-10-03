// SpawnManager (contract section 4): creates, updates, levels and ends spawn instances.
//
// A spawn is one activation of a preset. It has one engine instance per entry of preset.engines
// (its parts), all sharing the spawn's id, tier and lifetime. The manager:
//   - activates spawns (sites from the pluggable site feed, events from the director, anything from
//     the dev debugger) within the budgets: at most heavyLimit heavy spawns, per-engine instance and
//     particle caps, and the real-light pool;
//   - picks each spawn's LOD tier from the camera distance and preset.lod, with hysteresis, and tells
//     its engines (setLOD); setLodBias scales the LOD distances down under load;
//   - draws the FAR lure of heavy presets (src/spawns/lure.js), crossfading with the engines' own
//     geometry at the mid boundary;
//   - ends events that finish (instance.ended), expire, or leave range and view (the despawn rule),
//     and removes sites beyond lod.far plus their hysteresis;
//   - keeps a site to its hours: a site preset with filters.timeOfDay (a night-only bay) is created
//     only inside those hours, and removed once they end and it is out of view;
//   - detects discovery: within preset.discovery.radius and in view (in the camera frustum and not
//     hidden by terrain along the sight line), once per site id or event preset per world;
//   - accounts memory: renderer.info.memory and the JS heap before each create and after each
//     dispose, for the ?test=spawns harness;
//   - cleans up after engines: wind sources and real lights a disposed instance still held are
//     removed and reported as leaks.
//
// The frame update allocates nothing: records live in an array, per-engine counters are built once,
// the site scan reads the feed's per-cell cache in time slices, and the hot path never passes a
// double to a call V8 may not inline (it would box it) nor uses Math.hypot (it allocates its argument
// list). The exceptions are outside the manager: the terrain height the occlusion ray samples
// (worldgen's noise allocates, and returns a boxed double). So rays run only while a spawn still
// needs a visibility answer, a few per frame and at most every VISIBILITY_RETRY_FRAMES per spawn, at
// whole-metre coordinates (passed unboxed). The view cone is built every frame from the camera's own
// position, quaternion and lens.
import { LOD_TIERS, validateInstance } from './engineRegistry.js';
import { createLureSystem } from './lure.js';
import { createLightPool } from './lightPool.js';
import { createInstancedPool, createMeshPool, createObjectPool, createScratch, createSlotAllocator } from './pools.js';
import { matchesTimeOfDay } from './director.js';

export const DEFAULT_HEAVY_LIMIT = 2;
export const DEFAULT_ENGINE_BUDGET = Object.freeze({ instances: 32, particles: 60000 });
/** The most real lights spawns may use at once, whatever the engines declare (budget.lights). */
export const MAX_REAL_LIGHTS = 4;
/** LOD boundaries move by this share: out past boundary * (1 + H), back in below boundary * (1 - H). */
export const LOD_HYSTERESIS = 0.08;
/** Placement grid (contract 2.1): the site feed's cell size. */
const SITE_CELL = 2000;
/** Site-feed cells scanned per frame (a full sweep of a 40 km radius takes about half a second). */
const SITE_CELLS_PER_FRAME = 48;
/**
 * Visibility (frustum and terrain occlusion) checks per frame, round-robin over the spawns that still
 * need one (not yet seen, not yet discovered, or a director event past its despawn distance).
 */
const VISIBILITY_CHECKS_PER_FRAME = 2;
/** Frames before a spawn found out of view is checked again (about half a second). */
const VISIBILITY_RETRY_FRAMES = 30;
const OCCLUSION_SAMPLES = 10;
/** A sight line is blocked when the ground rises this far (m) above it. */
const OCCLUSION_MARGIN = 1;

/** Seconds an event may run past its drawn duration before the manager ends it for its engine. */
const EVENT_GRACE_SECONDS = 45;
const MEMORY_LOG_SIZE = 64;
/**
 * preset.anchor seek 'peak': a coarse grid of this many samples a side over the disc, then its
 * PEAK_CLIMBS highest samples climb to their summits in strides halving down to PEAK_MIN_STRIDE (m).
 */
const PEAK_SEEK_GRID = 25;
const PEAK_CLIMBS = 4;
const PEAK_MIN_STRIDE = 8;
/** Spawns alive at once (far above the budgets; activations past it are refused as 'capacity'). */
export const MAX_SPAWNS = 512;
const DEG = Math.PI / 180;

/** 32-bit FNV-1a hash of a string (seeds from ids). */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seeded random generator (mulberry32): returns a function giving [0, 1). */
export function createSeededRandom(seed) {
  let value = seed >>> 0;
  return function random() {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tier rank (0 near, 1 mid, 2 far) for distance, moving from rank with hysteresis (-1: none yet).
 * The frame update uses nextTierRank(record), the same rule reading the record's own fields.
 */
export function tierRankFor(distance, lod, rank = -1) {
  const boundary0 = lod.near;
  const boundary1 = lod.mid;
  if (rank < 0) return distance <= boundary0 ? 0 : distance <= boundary1 ? 1 : 2;
  let next = rank;
  while (next < 2 && distance > (next === 0 ? boundary0 : boundary1) * (1 + LOD_HYSTERESIS)) next++;
  while (next > 0 && distance < (next === 1 ? boundary0 : boundary1) * (1 - LOD_HYSTERESIS)) next--;
  return next;
}

/**
 * tierRankFor(distance / lodScale[0], record.preset.lod, record.tierRank), reading the distance from
 * distances[record.slot]. lodScale[0] is the LOD bias (1, or below 1 to demote spawns sooner); it
 * lives in a typed array so the frame update never passes a double into this call.
 */
function nextTierRank(record, distances, lodScale) {
  const distance = distances[record.slot] / lodScale[0];
  const lod = record.preset.lod;
  let next = record.tierRank;
  while (next < 2 && distance > (next === 0 ? lod.near : lod.mid) * (1 + LOD_HYSTERESIS)) next++;
  while (next > 0 && distance < (next === 1 ? lod.near : lod.mid) * (1 - LOD_HYSTERESIS)) next--;
  return next;
}

function createMemoryReading() {
  return { geometries: 0, textures: 0, attributes: 0, programs: 0, bytes: 0, heap: null };
}

function copyReading(target, source) {
  target.geometries = source.geometries;
  target.textures = source.textures;
  target.attributes = source.attributes;
  target.programs = source.programs;
  target.bytes = source.bytes;
  target.heap = source.heap;
  return target;
}

/**
 * Creates the SpawnManager. options:
 *   THREE, TSL, scene, camera, renderer, backend, wind, audio, world, state, sky, bus, perf,
 *   settings, uniforms       the game's services (the engine ctx is built from them)
 *   registry                 the engine registry (engineRegistry.js)
 *   presets                  the preset list (validated by the caller)
 *   siteFeed                 optional: { sitesInCell(cellX, cellZ) } and/or { sitesNear(x, z, radius) }
 *   seed                     the world seed (string), for event seeds
 *   registerPrewarm          optional: registers the lure mesh for the pipeline prewarm; engines get
 *                            it too (engineCtx.registerPrewarm) for the meshes they build in init()
 *   water                    optional: the water effects layer (src/render/waterEffects.js), the
 *                            engines' water API (engineCtx.water)
 *   maxLights                the cap on real lights (default MAX_REAL_LIGHTS); the pool holds the sum
 *                            of the engines' budget.lights up to it
 *   engineBudgets            optional: default { instances, particles } caps by engine name (the
 *                            director's DIRECTOR_BUDGETS.engines) for engines that declare no budget
 *   surfaces                 optional: the extra ground surfaces (src/world/groundSurfaces.js), where
 *                            engines register landable tops (engine ctx `surfaces`)
 *   weatherState             optional: () => the player's regional weather state ('clear' |
 *                            'building' | 'storm' | 'clearing') or null (engine ctx `weatherState`);
 *                            the typed weatherChanged event reports changes only, so an engine reads
 *                            the state it starts in here
 */
export function createSpawnManager(options) {
  const {
    THREE, TSL, scene, camera, renderer, backend, wind, audio, world, state, sky, bus, perf, settings, uniforms,
    registry, presets = [], seed = '', registerPrewarm = null, maxLights = MAX_REAL_LIGHTS, engineBudgets = null,
    water = null, surfaces = null, weatherState = null,
  } = options;
  const presetById = new Map();
  for (const preset of presets) presetById.set(preset.id, preset);
  let siteFeed = options.siteFeed ?? null;
  let initialized = false;
  let heavyLimit = DEFAULT_HEAVY_LIMIT;
  let nextSerial = 1;
  const worldSeedHash = hashString(String(seed));

  // ---- Records ----------------------------------------------------------------------------------
  const records = [];
  const recordById = new Map();
  const recordBySite = new Map();
  const discovered = new Set();
  /** Per engine: { budget: { instances, particles }, instances, particles, lights }. */
  const engineCounters = new Map();
  const tierCounts = [0, 0, 0];
  /** Per engine name: its live { instances, particles } caps (the objects setBudget changes). */
  const engineCaps = {};
  /** The LOD bias (setLodBias): LOD distances are multiplied by it. */
  const lodScale = new Float64Array([1]);
  const refusals = { preset: 0, engine: 0, heavy: 0, instances: 0, particles: 0, capacity: 0, error: 0, declined: 0 };
  // Per-spawn doubles written every frame live in typed arrays indexed by the spawn's slot: a double
  // field on an object can lose its unboxed representation (a map shared with records that stored
  // something else), after which every write allocates.
  const spawnSlots = createSlotAllocator(MAX_SPAWNS);
  const distances = new Float64Array(MAX_SPAWNS);
  const outOfView = new Float64Array(MAX_SPAWNS);
  const nextVisibilityFrame = new Int32Array(MAX_SPAWNS);
  const leaks = { windSources: 0, lights: 0 };
  const counters = { activated: 0, ended: 0, tierChanges: 0, discoveries: 0, lureRefused: 0, visibilityChecks: 0 };
  let heavyActive = 0;
  let visibilityCursor = 0;
  let lastRefusal = null;

  // ---- Memory accounting ------------------------------------------------------------------------
  const memoryLog = Array.from({ length: MEMORY_LOG_SIZE }, () => ({
    id: '', presetId: '', serial: 0, disposed: false,
    before: createMemoryReading(), afterCreate: createMemoryReading(), afterDispose: createMemoryReading(),
  }));
  let memoryCursor = 0;
  const memoryBaseline = createMemoryReading();
  const memoryScratch = createMemoryReading();
  let memoryCreated = 0;
  let memoryDisposed = 0;

  /** Writes renderer.info.memory and the JS heap (Chrome only; else null) into target. */
  function readMemory(target) {
    const memory = renderer?.info?.memory;
    target.geometries = memory?.geometries ?? 0;
    target.textures = memory?.textures ?? 0;
    target.attributes = memory?.attributes ?? 0;
    target.programs = memory?.programs ?? 0;
    target.bytes = memory?.total ?? 0;
    const heap = globalThis.performance?.memory?.usedJSHeapSize;
    target.heap = Number.isFinite(heap) ? heap : null;
    return target;
  }

  // ---- Camera and visibility ----------------------------------------------------------------------
  // The view cone: the frustum's four side planes (nx, ny, nz, d each) without its near and far
  // planes, because a lure 30 km out lies far beyond the camera's far plane and is still in view.
  const sidePlanes = new Float64Array(16);
  const viewProjection = new THREE.Matrix4();
  const cameraPosition = new THREE.Vector3();
  const visibilitySphere = new THREE.Sphere();

  /** Frame state of the view: the frame count. */
  const view = { frame: 0 };

  /**
   * This frame's camera position and view cone (the frustum's four side planes), every frame the
   * manager has spawns. The camera system has moved the camera by now, while its world matrix is only
   * refreshed when the frame renders, so a camera hanging straight off the scene (main.js) is read from
   * its own position, quaternion and lens: plain arithmetic in a function that runs every frame, which
   * V8 optimises and which allocates nothing. Any other camera goes through its world matrix.
   */
  function refreshCamera() {
    if (camera.parent !== scene && camera.parent !== null) {
      refreshCameraFromMatrix();
      return;
    }
    cameraPosition.copy(camera.position);
    const q = camera.quaternion;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    const rightX = 1 - 2 * (qy * qy + qz * qz);
    const rightY = 2 * (qx * qy + qw * qz);
    const rightZ = 2 * (qx * qz - qw * qy);
    const upX = 2 * (qx * qy - qw * qz);
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const upZ = 2 * (qy * qz + qw * qx);
    const forwardX = -2 * (qx * qz + qw * qy);
    const forwardY = -2 * (qy * qz - qw * qx);
    const forwardZ = -(1 - 2 * (qx * qx + qy * qy));
    const tangentV = Math.tan(camera.fov * DEG * 0.5) / camera.zoom;
    const tangentH = tangentV * camera.aspect;
    // Left, right, bottom, top: inward normal = (+-side + tangent * forward), through the camera.
    for (let plane = 0; plane < 4; plane++) {
      const horizontal = plane < 2;
      const sign = (plane & 1) === 0 ? 1 : -1;
      const tangent = horizontal ? tangentH : tangentV;
      const inverseLength = 1 / Math.sqrt(1 + tangent * tangent);
      const nx = (sign * (horizontal ? rightX : upX) + forwardX * tangent) * inverseLength;
      const ny = (sign * (horizontal ? rightY : upY) + forwardY * tangent) * inverseLength;
      const nz = (sign * (horizontal ? rightZ : upZ) + forwardZ * tangent) * inverseLength;
      const offset = plane * 4;
      sidePlanes[offset] = nx;
      sidePlanes[offset + 1] = ny;
      sidePlanes[offset + 2] = nz;
      sidePlanes[offset + 3] = -(nx * cameraPosition.x + ny * cameraPosition.y + nz * cameraPosition.z);
    }
  }

  /** The general case: w + x, w - x, w + y and w - y of the view-projection matrix, normalised. */
  function refreshCameraFromMatrix() {
    camera.updateMatrixWorld();
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = viewProjection.elements;
    for (let plane = 0; plane < 4; plane++) {
      const row = plane >> 1;
      const sign = (plane & 1) === 0 ? 1 : -1;
      const nx = m[3] + sign * m[row];
      const ny = m[7] + sign * m[4 + row];
      const nz = m[11] + sign * m[8 + row];
      const d = m[15] + sign * m[12 + row];
      const inverseLength = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      sidePlanes[plane * 4] = nx * inverseLength;
      sidePlanes[plane * 4 + 1] = ny * inverseLength;
      sidePlanes[plane * 4 + 2] = nz * inverseLength;
      sidePlanes[plane * 4 + 3] = d * inverseLength;
    }
  }

  /** True when the sphere reaches inside all four side planes (in the view cone, at any distance ahead). */
  function sphereInViewCone(sphere) {
    const center = sphere.center;
    for (let plane = 0; plane < 4; plane++) {
      const offset = plane * 4;
      const distance = sidePlanes[offset] * center.x + sidePlanes[offset + 1] * center.y + sidePlanes[offset + 2] * center.z + sidePlanes[offset + 3];
      if (distance < -sphere.radius) return false;
    }
    return true;
  }

  /** The height above a spawn's anchor where the player looks for it (its lure's middle, or its body). */
  function sightLift(record) {
    const lure = record.preset.lure;
    if (lure) return (lure.altitude ?? 0) + lure.height * 0.5;
    return Math.min(300, Math.max(5, record.radius * 0.5));
  }

  /**
   * True when terrain rises above the straight sight line from the camera to target (a Vector3).
   * Only terrain the player can see counts: the line is sampled out to the fog's far distance (the
   * terrain behind it is fully fogged, and a lure is drawn over it).
   */
  function occludedByTerrain(target) {
    const startX = cameraPosition.x;
    const startY = cameraPosition.y;
    const startZ = cameraPosition.z;
    const offsetX = target.x - startX;
    const offsetY = target.y - startY;
    const offsetZ = target.z - startZ;
    const length = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
    const fogFar = scene.fog ? scene.fog.far : camera.far;
    const reach = length > fogFar ? fogFar / length : 1;
    for (let sample = 1; sample <= OCCLUSION_SAMPLES; sample++) {
      // Skip the ends: the camera's own spot and the ground right under the target.
      const t = (0.04 + 0.92 * (sample / (OCCLUSION_SAMPLES + 1))) * reach;
      const pointY = startY + (target.y - startY) * t;
      const ground = world.groundHeight(Math.round(startX + (target.x - startX) * t), Math.round(startZ + (target.z - startZ) * t));
      if (ground > pointY + OCCLUSION_MARGIN) return true;
    }
    return false;
  }

  function isInView(record) {
    const lift = sightLift(record);
    const anchor = record.anchor;
    visibilitySphere.center.set(anchor.x, anchor.y + lift, anchor.z);
    visibilitySphere.radius = Math.max(record.radius, lift);
    if (!sphereInViewCone(visibilitySphere)) return false;
    return !occludedByTerrain(visibilitySphere.center);
  }

  // ---- Engine ctx -----------------------------------------------------------------------------------
  const lightPool = createLightPool({ THREE, scene });

  /** Grows the light pool to the lights the registered engines declare, up to maxLights. */
  function sizeLightPool() {
    let wanted = 0;
    for (const engine of registry.list()) wanted += engine.budget?.lights ?? 0;
    lightPool.ensure(Math.min(maxLights, wanted));
  }
  const lures = createLureSystem({ THREE, TSL, scene, camera, sky, uniforms, viewPosition: cameraPosition });
  if (typeof registerPrewarm === 'function') registerPrewarm(lures.mesh);

  function countersFor(name) {
    let entry = engineCounters.get(name);
    if (!entry) {
      const engine = registry.get(name);
      const budget = engine?.budget ?? engineBudgets?.[name] ?? DEFAULT_ENGINE_BUDGET;
      entry = { budget: { instances: budget.instances, particles: budget.particles }, instances: 0, particles: 0, lights: 0, failed: false, initialized: false };
      engineCounters.set(name, entry);
      engineCaps[name] = entry.budget;
    }
    return entry;
  }

  // The budgets as engines (ctx.budgets) and the director read them: the director gets this same
  // view, so both always agree on the caps.
  const budgets = Object.freeze({
    get heavyLimit() { return heavyLimit; },
    get maxHeavy() { return heavyLimit; },
    get maxRealLights() { return maxLights; },
    /** { [engine]: { instances, particles } }: every known engine's caps (live; read only). */
    engines: engineCaps,
    get heavyActive() { return heavyActive; },
    get lightsLimit() { return lightPool.size; },
    get lightsActive() { return lightPool.active; },
    instanceLimit(name) { return countersFor(name).budget.instances; },
    instances(name) { return countersFor(name).instances; },
    particleLimit(name) { return countersFor(name).budget.particles; },
    particles(name) { return countersFor(name).particles; },
  });

  const engineCtx = {
    scene, camera, renderer, backend, THREE, TSL,
    wind,
    audio,
    terrain: Object.freeze({
      heightAt: (x, z) => world.heightAt(x, z),
      groundHeight: (x, z) => world.groundHeight(x, z),
      biomeAt: (x, z) => world.biomeAt(x, z),
      waterLevel: world.WATER_LEVEL,
    }),
    time: state.time,
    sky,
    bus, perf, settings, state, uniforms,
    budgets,
    lights: lightPool,
    /** The extra ground surfaces (landable tops that are not terrain), or null. */
    surfaces,
    /** () => the player's regional weather state or null (allocates: call it at create, not per frame). */
    weatherState: typeof weatherState === 'function' ? weatherState : () => null,
    /** Registers an object for the pipeline prewarm behind the loading fade (engines call it in init). */
    registerPrewarm: typeof registerPrewarm === 'function' ? registerPrewarm : null,
    pools: Object.freeze({
      scratch: createScratch(THREE, 64),
      createSlotAllocator,
      createObjectPool,
      createInstancedPool: (poolOptions) => createInstancedPool(THREE, poolOptions),
      createMeshPool: (poolOptions) => createMeshPool(THREE, poolOptions),
    }),
    spawns: null,
    /**
     * Registers an object an engine builds in init() for the pipeline prewarm behind the loading fade, so
     * the first spawn does not hitch on a shader compile. Null in the labs; engines check before calling.
     */
    registerPrewarm: typeof registerPrewarm === 'function' ? registerPrewarm : null,
    /** The water effects layer (disturbances, trails, splashes, spray, vortices, glow, pools), or null. */
    water,
  };

  function initEngine(engine) {
    const entry = countersFor(engine.name);
    if (entry.initialized || entry.failed) return;
    try {
      engine.init(engineCtx);
      entry.initialized = true;
    } catch (error) {
      entry.failed = true;
      console.error(`[DRIFTWING] spawn engine "${engine.name}" failed to initialise; its presets will not spawn`, error);
    }
  }

  // ---- Activation -----------------------------------------------------------------------------------
  function refuse(reason) {
    refusals[reason]++;
    lastRefusal = reason;
    return null;
  }

  /**
   * Why an activation of presetId would be refused now ('preset', 'engine', 'capacity', 'heavy',
   * 'instances', 'particles'), or null when it would be admitted. source 'site' is never refused for heavy
   * (sites are persistent places; the director decides their active state).
   */
  function refusalFor(preset, source) {
    if (!preset) return 'preset';
    for (let index = 0; index < preset.engines.length; index++) {
      const name = preset.engines[index].engine;
      const engine = registry.get(name);
      if (!engine || !countersFor(name).initialized) return 'engine';
    }
    if (spawnSlots.available === 0) return 'capacity';
    if (preset.heavy && source !== 'site' && heavyActive >= heavyLimit) return 'heavy';
    for (let index = 0; index < preset.engines.length; index++) {
      const entry = preset.engines[index];
      const counts = countersFor(entry.engine);
      if (counts.instances + 1 > counts.budget.instances) return 'instances';
      const estimate = entry.params && Number.isFinite(entry.params.particles) ? entry.params.particles : 0;
      if (counts.particles + estimate > counts.budget.particles) return 'particles';
    }
    return null;
  }

  function nextMemoryEntry(id, presetId, serial) {
    const entry = memoryLog[memoryCursor];
    memoryCursor = (memoryCursor + 1) % MEMORY_LOG_SIZE;
    entry.id = id;
    entry.presetId = presetId;
    entry.serial = serial;
    entry.disposed = false;
    return entry;
  }

  /**
   * Records a spawn's memory after its dispose. The log is a ring: a long-lived spawn's entry may
   * have been handed to a newer spawn meanwhile (the serial tells), and then it is left alone.
   */
  function recordDisposed(record) {
    const entry = record.memory;
    if (entry.serial !== record.serial) return;
    readMemory(entry.afterDispose);
    entry.disposed = true;
  }

  function disposeParts(record) {
    lightPool.currentOwner = record;
    for (let index = record.parts.length - 1; index >= 0; index--) {
      const part = record.parts[index];
      try {
        part.engine.dispose(part.instance);
      } catch (error) {
        console.error(`[DRIFTWING] spawn engine "${part.engine.name}" failed to dispose ${record.id}`, error);
      }
      const windIds = Array.isArray(part.instance.windSourceIds) ? part.instance.windSourceIds : [];
      for (let windIndex = 0; windIndex < windIds.length; windIndex++) {
        if (wind && wind.removeSource(windIds[windIndex])) {
          leaks.windSources++;
          console.error(`[DRIFTWING] spawn engine "${part.engine.name}" left wind source "${windIds[windIndex]}" of ${record.id} behind; the manager removed it`);
        }
      }
    }
    lightPool.currentOwner = null;
    const leakedLights = lightPool.releaseOwner(record);
    if (leakedLights > 0) {
      leaks.lights += leakedLights;
      console.error(`[DRIFTWING] ${record.id} was disposed holding ${leakedLights} real light(s); the manager released them`);
    }
  }

  /**
   * preset.anchor (events): seek 'peak' moves the activation point to the highest ground within
   * anchor.radius (a coarse grid over the disc, then a finer one around its best sample); align
   * 'downwind' turns the heading downwind of the prevailing wind. Writes the result into out
   * ({ x, y, z, heading }); without an anchor rule it is the activation itself. Runs once per
   * activation, so it may allocate.
   */
  function applyAnchorRule(preset, position, heading, out) {
    out.x = position.x;
    out.y = position.y;
    out.z = position.z;
    out.heading = heading;
    const rule = preset.anchor;
    if (!rule) return out;
    if (rule.seek === 'peak') {
      const radiusSquared = rule.radius * rule.radius;
      const inside = (x, z) => (x - position.x) * (x - position.x) + (z - position.z) * (z - position.z) <= radiusSquared;
      // A coarse grid over the disc; its highest few samples then climb to their own summits (a
      // peak narrower than the grid lies between samples), and the highest summit wins.
      const step = (2 * rule.radius) / (PEAK_SEEK_GRID - 1);
      const samples = [];
      for (let row = 0; row < PEAK_SEEK_GRID; row++) {
        for (let column = 0; column < PEAK_SEEK_GRID; column++) {
          const x = position.x - rule.radius + column * step;
          const z = position.z - rule.radius + row * step;
          if (inside(x, z)) samples.push({ x, z, y: world.groundHeight(x, z) });
        }
      }
      samples.sort((first, second) => second.y - first.y);
      let best = samples.length > 0 ? samples[0] : { x: position.x, z: position.z, y: world.groundHeight(position.x, position.z) };
      for (let index = 0; index < Math.min(PEAK_CLIMBS, samples.length); index++) {
        const summit = { ...samples[index] };
        for (let stride = step; stride >= PEAK_MIN_STRIDE; stride /= 2) {
          let moved = true;
          while (moved) {
            moved = false;
            for (let direction = 0; direction < 8; direction++) {
              const angle = (direction / 8) * Math.PI * 2;
              const x = summit.x + Math.cos(angle) * stride;
              const z = summit.z + Math.sin(angle) * stride;
              if (!inside(x, z)) continue;
              const y = world.groundHeight(x, z);
              if (y > summit.y) {
                summit.x = x;
                summit.z = z;
                summit.y = y;
                moved = true;
              }
            }
          }
        }
        if (summit.y > best.y) best = summit;
      }
      out.x = best.x;
      out.z = best.z;
      out.y = Math.max(best.y, world.WATER_LEVEL);
    }
    if (rule.align === 'downwind') {
      const direction = uniforms.windDirection.value;
      const compass = Math.atan2(direction.x, -direction.y) / DEG;
      out.heading = compass < 0 ? compass + 360 : compass;
    }
    return out;
  }

  /** Whether the spawn's FAR lure shows: at the far tier, and for a dormant site (activeState) not at all. */
  function lureShown(record, rank) {
    return rank === 2 && !(record.dormantStart && !record.active);
  }

  /**
   * Activates presetId. opts: { position: {x, y, z} (required), heading (compass degrees),
   * source: 'site' | 'director' | 'debug', site?, seed?, scale?, force? (debug only: ignore the
   * budgets), duration?, params? ({ [engine name]: { ...overrides } } merged over that engine
   * entry's preset params: the set-piece engine places and tunes its children this way) }.
   * Returns the spawn id, or null when a budget (or a missing preset or engine) refuses, or when a
   * director activation is declined because every engine ended its instance at create ('declined').
   */
  function activate(presetId, opts = {}) {
    const preset = presetById.get(presetId) ?? null;
    const source = opts.source ?? 'director';
    const site = opts.site ?? null;
    if (site && recordBySite.has(site.id)) return recordBySite.get(site.id).id;
    const position = opts.position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      throw new TypeError(`[DRIFTWING] activate("${presetId}") needs a finite position`);
    }
    const reason = refusalFor(preset, source);
    const forced = opts.force === true && source === 'debug';
    if (reason && !(forced && reason !== 'preset' && reason !== 'engine' && reason !== 'capacity')) return refuse(reason);

    const serial = nextSerial++;
    const id = site ? `spawn:${site.id}` : `spawn:${presetId}:${serial}`;
    const spawnSeed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : site && Number.isFinite(site.seed) ? site.seed >>> 0 : hashString(`${worldSeedHash}:${presetId}:${serial}`);
    const random = createSeededRandom(spawnSeed);
    const requestedHeading = Number.isFinite(opts.heading) ? opts.heading : site && Number.isFinite(site.rotation) ? site.rotation / DEG : 0;
    const placed = applyAnchorRule(preset, position, requestedHeading, { x: 0, y: 0, z: 0, heading: 0 });
    const heading = placed.heading;
    // The director draws an event's duration itself and passes it, so both keep the same number.
    const duration = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration
      : preset.lifetime.duration ? preset.lifetime.duration[0] + random() * (preset.lifetime.duration[1] - preset.lifetime.duration[0]) : null;
    const siteId = site ? site.id : preset.kind === 'site' ? `debug:${presetId}:${serial}` : null;
    const record = {
      id,
      presetId,
      preset,
      source,
      site,
      siteId,
      discoveryKey: siteId ?? presetId,
      seed: spawnSeed,
      heading,
      parts: [],
      anchor: null,
      radius: 0,
      tierRank: 0,
      active: source !== 'site',
      /** A site with a director-driven active state (preset.activeState) starts dormant. */
      dormantStart: source === 'site' && Boolean(preset.activeState),
      startTime: state.time.elapsed,
      duration,
      ended: false,
      slot: -1,
      inView: false,
      seenInView: false,
      lureSlot: -1,
      serial,
      memory: nextMemoryEntry(id, presetId, serial),
    };
    readMemory(record.memory.before);
    lightPool.currentOwner = record;
    try {
      for (let index = 0; index < preset.engines.length; index++) {
        const entry = preset.engines[index];
        const engine = registry.get(entry.engine);
        const overrides = opts.params && typeof opts.params === 'object' ? opts.params[entry.engine] : null;
        const params = {
          ...(entry.params ?? {}),
          ...(overrides && typeof overrides === 'object' ? overrides : {}),
          position: new THREE.Vector3(placed.x, placed.y, placed.z),
          heading,
          site,
          startTime: record.startTime,
          scale: Number.isFinite(opts.scale) ? opts.scale : site && Number.isFinite(site.scale) ? site.scale : 1,
          duration,
          seed: spawnSeed,
        };
        const instance = engine.create(preset, params, createSeededRandom((spawnSeed + Math.imul(index + 1, 0x9e3779b1)) >>> 0));
        if (instance && typeof instance === 'object') {
          instance.id = id;
          instance.presetId = presetId;
          instance.engine = engine.name;
          instance.heavy = preset.heavy;
          if (instance.ended === undefined) instance.ended = false;
          if (record.dormantStart) instance.active = false;
        }
        record.parts.push({ engine, instance });
        validateInstance(engine.name, instance);
      }
    } catch (error) {
      lightPool.currentOwner = null;
      refusals.error++;
      lastRefusal = 'error';
      console.error(`[DRIFTWING] spawn "${presetId}" failed to create`, error);
      record.parts = record.parts.filter((part) => part.instance && typeof part.instance === 'object');
      disposeParts(record);
      recordDisposed(record);
      return null;
    }
    lightPool.currentOwner = null;

    // Every engine ended its instance at create (thermal hawks that found no working thermal, a pod
    // with no open water in reach): nothing would ever be drawn. A director activation is declined,
    // so the director neither counts it as something notable nor spends the preset's cooldown and
    // the tier's turn on it; it tries that candidate again in its next bucket. Other sources keep
    // the spawn, which the manager removes as ended on its next frame.
    if (source === 'director' && record.parts.every((part) => part.instance.ended === true)) {
      disposeParts(record);
      recordDisposed(record);
      return refuse('declined');
    }

    // Actual particles against the caps (an engine may create more than its params estimated).
    if (!forced) {
      for (let index = 0; index < record.parts.length; index++) {
        const part = record.parts[index];
        const counts = countersFor(part.engine.name);
        if (counts.particles + part.instance.particles > counts.budget.particles) {
          disposeParts(record);
          recordDisposed(record);
          return refuse('particles');
        }
      }
    }
    readMemory(record.memory.afterCreate);
    memoryCreated++;

    const first = record.parts[0].instance;
    record.anchor = first.anchor;
    record.radius = first.radius;
    record.slot = spawnSlots.alloc();
    refreshCamera();
    distances[record.slot] = cameraPosition.distanceTo(record.anchor);
    outOfView[record.slot] = 0;
    nextVisibilityFrame[record.slot] = 0;
    record.tierRank = tierRankFor(distances[record.slot] / lodScale[0], preset.lod);
    const tier = LOD_TIERS[record.tierRank];
    for (let index = 0; index < record.parts.length; index++) {
      const part = record.parts[index];
      part.instance.tier = tier;
      const counts = countersFor(part.engine.name);
      counts.instances++;
      counts.particles += part.instance.particles;
      setPartLOD(part, tier, id);
    }
    if (preset.heavy && preset.lure) {
      record.lureSlot = lures.acquire(preset.lure, spawnSeed, record.anchor, heading * DEG);
      if (record.lureSlot < 0) counters.lureRefused++;
      else lures.setVisible(record.lureSlot, lureShown(record, record.tierRank));
    }
    records.push(record);
    recordById.set(id, record);
    if (site) recordBySite.set(site.id, record);
    if (preset.heavy && record.active) heavyActive++;
    counters.activated++;
    lastRefusal = null;
    bus.emitTyped('spawnActivated', {
      id, presetId, category: preset.category, kind: preset.kind,
      position: { x: record.anchor.x, y: record.anchor.y, z: record.anchor.z },
    });
    return id;
  }

  /**
   * Tells a part its tier. An engine may change instance.particles in setLOD (an emitter's ring share
   * follows the tier), so the engine's particle count is moved with it: otherwise every tier change
   * would leave the difference in the count, and the drift would end up refusing spawns as 'particles'.
   */
  function setPartLOD(part, tier, id) {
    const counts = countersFor(part.engine.name);
    counts.particles -= part.instance.particles;
    try {
      part.engine.setLOD(part.instance, tier);
    } catch (error) {
      console.error(`[DRIFTWING] spawn engine "${part.engine.name}" setLOD failed for ${id}`, error);
    }
    counts.particles += part.instance.particles;
  }

  function removeRecordAt(index, reason) {
    const record = records[index];
    const last = records.length - 1;
    if (index !== last) records[index] = records[last];
    records.pop();
    if (visibilityCursor > records.length) visibilityCursor = 0;
    recordById.delete(record.id);
    if (record.site) recordBySite.delete(record.site.id);
    if (record.preset.heavy && record.active) heavyActive--;
    for (let partIndex = 0; partIndex < record.parts.length; partIndex++) {
      const part = record.parts[partIndex];
      const counts = countersFor(part.engine.name);
      counts.instances--;
      counts.particles -= part.instance.particles;
    }
    if (record.lureSlot >= 0) lures.release(record.lureSlot);
    record.lureSlot = -1;
    spawnSlots.free(record.slot);
    disposeParts(record);
    recordDisposed(record);
    memoryDisposed++;
    counters.ended++;
    bus.emitTyped('spawnEnded', { id: record.id, presetId: record.presetId, reason });
  }

  /** Ends a spawn now (its engines dispose). Returns false when no spawn has that id. */
  function deactivate(id, reason = 'deactivated') {
    const record = recordById.get(id);
    if (!record) return false;
    removeRecordAt(records.indexOf(record), reason);
    return true;
  }

  // ---- Site feed --------------------------------------------------------------------------------------
  const siteScan = { radiusCells: 0, centerX: 0, centerZ: 0, cursor: 0, total: 0, sweeps: 0, sitesSeen: 0, maxFar: 0 };

  function maxSiteFar() {
    let far = 0;
    for (const preset of presetById.values()) if (preset.kind === 'site' && preset.lod.far > far) far = preset.lod.far;
    return far;
  }

  /**
   * Whether a site preset is open now: one with filters.timeOfDay (a night-only bay) exists only in
   * those hours (the director's own time-of-day classes); every other site always.
   */
  function siteHoursOpen(preset) {
    const hours = preset.filters ? preset.filters.timeOfDay : null;
    return !hours || matchesTimeOfDay(hours, state.time.sunElevation, state.time.dayTime);
  }

  function considerSite(site, player) {
    siteScan.sitesSeen++;
    if (recordBySite.has(site.id)) return;
    const preset = presetById.get(site.presetId);
    if (!preset) return;
    if (!siteHoursOpen(preset)) return;
    const offsetX = site.x - player.x;
    const offsetZ = site.z - player.z;
    if (offsetX * offsetX + offsetZ * offsetZ >= preset.lod.far * preset.lod.far) return;
    if (refusalFor(preset, 'site')) return;
    activate(preset.id, { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
  }

  /** Scans the next slice of the site feed's cells around the player (time-sliced sweep). */
  function scanSites() {
    if (!siteFeed || siteScan.maxFar <= 0) return;
    const player = state.player.position;
    if (siteScan.cursor >= siteScan.total) {
      siteScan.radiusCells = Math.ceil(siteScan.maxFar / SITE_CELL);
      siteScan.centerX = Math.floor(player.x / SITE_CELL);
      siteScan.centerZ = Math.floor(player.z / SITE_CELL);
      const side = siteScan.radiusCells * 2 + 1;
      siteScan.total = side * side;
      siteScan.cursor = 0;
      siteScan.sweeps++;
      if (typeof siteFeed.sitesInCell !== 'function' && typeof siteFeed.sitesNear === 'function') {
        // A feed without the per-cell cache is read once per sweep.
        const sites = siteFeed.sitesNear(player.x, player.z, siteScan.maxFar);
        for (let index = 0; index < sites.length; index++) considerSite(sites[index], player);
        siteScan.cursor = siteScan.total;
        return;
      }
    }
    if (typeof siteFeed.sitesInCell !== 'function') return;
    const side = siteScan.radiusCells * 2 + 1;
    const end = Math.min(siteScan.total, siteScan.cursor + SITE_CELLS_PER_FRAME);
    for (let cell = siteScan.cursor; cell < end; cell++) {
      const cellX = siteScan.centerX - siteScan.radiusCells + (cell % side);
      const cellZ = siteScan.centerZ - siteScan.radiusCells + Math.floor(cell / side);
      const sites = siteFeed.sitesInCell(cellX, cellZ);
      if (!sites) continue;
      for (let index = 0; index < sites.length; index++) considerSite(sites[index], player);
    }
    siteScan.cursor = end;
  }

  // ---- Discovery -------------------------------------------------------------------------------------
  function discover(record) {
    discovered.add(record.discoveryKey);
    counters.discoveries++;
    const anchor = record.anchor;
    bus.emitTyped('discovery', {
      id: record.discoveryKey,
      name: record.preset.name,
      kind: record.preset.category,
      position: { x: anchor.x, y: anchor.y, z: anchor.z },
      presetId: record.presetId,
    });
  }

  /**
   * True while a spawn still needs a visibility answer: its first sighting, its discovery once it is
   * within the discovery radius, or (a director event past its despawn distance) the out-of-view time
   * of the despawn rule.
   */
  function needsVisibility(record) {
    if (view.frame < nextVisibilityFrame[record.slot]) return false;
    if (!record.seenInView) return true;
    const preset = record.preset;
    const distance = distances[record.slot];
    if (distance <= preset.discovery.radius && !discovered.has(record.discoveryKey)) return true;
    // A site past its hours waits out of view before it goes (updateRecord), so keep its view current.
    if (record.source === 'site' && !siteHoursOpen(preset)) return true;
    return record.source === 'director' && distance > preset.lifetime.despawn.distance;
  }

  /** Frustum and terrain-occlusion check of one spawn; fires the in-view notice and discovery. */
  function checkVisibility(record) {
    counters.visibilityChecks++;
    const preset = record.preset;
    const range = preset.heavy ? preset.lod.far : preset.lod.mid;
    const distance = distances[record.slot];
    record.inView = distance <= range && isInView(record);
    if (!record.inView) nextVisibilityFrame[record.slot] = view.frame + VISIBILITY_RETRY_FRAMES;
    if (record.inView && !record.seenInView) {
      record.seenInView = true;
      bus.emit('spawns:inView', { id: record.id, presetId: record.presetId, siteId: record.siteId, kind: preset.kind, distance });
    }
    if (discovered.has(record.discoveryKey) || distance > preset.discovery.radius) return;
    if (preset.discovery.requireInView && !record.inView) return;
    discover(record);
  }

  // ---- Frame update ------------------------------------------------------------------------------------
  function updateRecord(record, index, simDt, realDt) {
    const preset = record.preset;
    const anchor = record.anchor;
    const offsetX = anchor.x - cameraPosition.x;
    const offsetY = anchor.y - cameraPosition.y;
    const offsetZ = anchor.z - cameraPosition.z;
    const slot = record.slot;
    const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ);
    distances[slot] = distance;
    const rank = nextTierRank(record, distances, lodScale);
    if (rank !== record.tierRank) {
      record.tierRank = rank;
      counters.tierChanges++;
      if (record.lureSlot >= 0) lures.setVisible(record.lureSlot, lureShown(record, rank));
      const tier = LOD_TIERS[rank];
      for (let partIndex = 0; partIndex < record.parts.length; partIndex++) {
        const part = record.parts[partIndex];
        part.instance.tier = tier;
        setPartLOD(part, tier, record.id);
      }
    }

    lightPool.currentOwner = record;
    for (let partIndex = 0; partIndex < record.parts.length; partIndex++) {
      const part = record.parts[partIndex];
      const instance = part.instance;
      const counts = countersFor(part.engine.name);
      counts.particles -= instance.particles;
      try {
        part.engine.update(instance, simDt, engineCtx);
      } catch (error) {
        lightPool.currentOwner = null;
        console.error(`[DRIFTWING] spawn engine "${part.engine.name}" failed to update ${record.id}; the spawn was ended`, error);
        counts.particles += instance.particles;
        removeRecordAt(index, 'error');
        return false;
      }
      counts.particles += instance.particles;
      if (instance.ended) record.ended = true;
    }
    lightPool.currentOwner = null;
    record.radius = record.parts[0].instance.radius;

    outOfView[slot] = record.inView ? 0 : outOfView[slot] + realDt;
    if (record.source === 'site') {
      const hysteresis = preset.lifetime.despawn.hysteresis;
      if (distance > preset.lod.far + hysteresis) {
        removeRecordAt(index, 'range');
        return false;
      }
      // Out of its hours (a night-only bay at dawn): gone once the player looks away, back at nightfall.
      if (!record.inView && outOfView[slot] >= preset.lifetime.despawn.outOfViewSeconds && !siteHoursOpen(preset)) {
        removeRecordAt(index, 'hours');
        return false;
      }
      return true;
    }
    if (record.ended) {
      removeRecordAt(index, 'ended');
      return false;
    }
    if (record.duration !== null && state.time.elapsed - record.startTime > record.duration + EVENT_GRACE_SECONDS) {
      removeRecordAt(index, 'expired');
      return false;
    }
    if (record.source === 'debug') return true;
    const despawn = preset.lifetime.despawn;
    if (distance > preset.lod.far * (1 + LOD_HYSTERESIS)) {
      removeRecordAt(index, 'range');
      return false;
    }
    if (distance > despawn.distance + despawn.hysteresis && outOfView[slot] >= despawn.outOfViewSeconds) {
      removeRecordAt(index, 'despawn');
      return false;
    }
    return true;
  }

  function update(simDt, realDt) {
    if (!initialized) return;
    view.frame++;
    scanSites();
    if (records.length > 0) {
      refreshCamera();
      // Backwards: a record removed during the pass swaps in one already updated.
      for (let index = records.length - 1; index >= 0; index--) updateRecord(records[index], index, simDt, realDt);
      let checks = 0;
      for (let visited = 0; visited < records.length && checks < VISIBILITY_CHECKS_PER_FRAME; visited++) {
        if (visibilityCursor >= records.length) visibilityCursor = 0;
        const record = records[visibilityCursor];
        visibilityCursor++;
        if (!needsVisibility(record)) continue;
        checkVisibility(record);
        checks++;
      }
    }
    tierCounts[0] = 0;
    tierCounts[1] = 0;
    tierCounts[2] = 0;
    for (let index = 0; index < records.length; index++) tierCounts[records[index].tierRank]++;
    lures.update(realDt);
  }

  // ---- Stats --------------------------------------------------------------------------------------------
  function describeRecord(record) {
    return {
      id: record.id,
      presetId: record.presetId,
      name: record.preset.name,
      category: record.preset.category,
      kind: record.preset.kind,
      source: record.source,
      siteId: record.siteId,
      heavy: record.preset.heavy,
      active: record.active,
      tier: LOD_TIERS[record.tierRank],
      distance: Math.round(distances[record.slot]),
      inView: record.inView,
      discovered: discovered.has(record.discoveryKey),
      position: { x: record.anchor.x, y: record.anchor.y, z: record.anchor.z },
      age: state.time.elapsed - record.startTime,
      duration: record.duration,
      lure: record.lureSlot >= 0 ? Math.round(lures.weightOf(record.lureSlot) * 100) / 100 : null,
      engines: record.parts.map((part) => part.engine.name),
    };
  }

  function getStats() {
    const engines = {};
    const totals = { instances: 0, particles: 0, lights: 0, buffers: 0, drawCalls: 0 };
    for (const engine of registry.list()) {
      const counts = countersFor(engine.name);
      let own = null;
      try {
        own = engine.stats();
      } catch (error) {
        console.error(`[DRIFTWING] spawn engine "${engine.name}" stats() failed`, error);
      }
      const entry = {
        instances: own?.instances ?? counts.instances,
        particles: own?.particles ?? counts.particles,
        lights: own?.lights ?? 0,
        buffers: own?.buffers ?? 0,
        drawCalls: own?.drawCalls ?? 0,
        active: counts.instances,
        budget: { ...counts.budget },
        failed: counts.failed,
      };
      engines[engine.name] = entry;
      totals.instances += entry.instances;
      totals.particles += entry.particles;
      totals.lights += entry.lights;
      totals.buffers += entry.buffers;
      totals.drawCalls += entry.drawCalls;
    }
    let sites = 0;
    for (let index = 0; index < records.length; index++) if (records[index].source === 'site') sites++;
    const log = [];
    for (let offset = 0; offset < MEMORY_LOG_SIZE; offset++) {
      const entry = memoryLog[(memoryCursor + offset) % MEMORY_LOG_SIZE];
      if (!entry.id) continue;
      log.push({
        id: entry.id, presetId: entry.presetId, serial: entry.serial, disposed: entry.disposed,
        before: { ...entry.before }, afterCreate: { ...entry.afterCreate }, afterDispose: entry.disposed ? { ...entry.afterDispose } : null,
      });
    }
    return {
      spawns: records.length,
      sites,
      events: records.length - sites,
      heavy: heavyActive,
      heavyLimit,
      lodBias: lodScale[0],
      tiers: { near: tierCounts[0], mid: tierCounts[1], far: tierCounts[2] },
      engines,
      totals,
      lights: lightPool.getStats(),
      lures: lures.getStats(),
      discovered: discovered.size,
      counters: { ...counters },
      refusals: { ...refusals },
      lastRefusal,
      leaks: { ...leaks },
      memory: {
        baseline: { ...memoryBaseline },
        current: { ...readMemory(memoryScratch) },
        created: memoryCreated,
        disposed: memoryDisposed,
        log,
      },
      siteFeed: { attached: Boolean(siteFeed), sweeps: siteScan.sweeps, sitesSeen: siteScan.sitesSeen, radius: siteScan.maxFar },
    };
  }

  // ---- Public API -----------------------------------------------------------------------------------------
  const manager = {
    /** Adds an engine to the registry (initialised at once when the manager already runs). */
    register(engine) {
      registry.register(engine);
      countersFor(engine.name);
      if (initialized) {
        sizeLightPool();
        initEngine(engine);
      }
      return engine;
    },
    /** Initialises every registered engine and records the memory baseline. */
    init() {
      if (initialized) return;
      initialized = true;
      sizeLightPool();
      for (const engine of registry.list()) initEngine(engine);
      siteScan.maxFar = maxSiteFar();
      readMemory(memoryBaseline);
    },
    activate,
    deactivate,
    update,
    /** Why activating presetId from source would be refused now, or null. */
    canActivate(presetId, source = 'director') {
      return refusalFor(presetById.get(presetId) ?? null, source);
    },
    getActive() {
      return records.map(describeRecord);
    },
    getInstance(id) {
      const record = recordById.get(id);
      return record ? describeRecord(record) : null;
    },
    /** The engine instances of a spawn (dev inspection and the test kits), or an empty array. */
    getParts(id) {
      const record = recordById.get(id);
      return record ? record.parts.map((part) => part.instance) : [];
    },
    /** The spawn created for a site id, or null. */
    getSiteSpawn(siteId) {
      const record = recordBySite.get(siteId);
      return record ? record.id : null;
    },
    getStats,
    getPreset(presetId) {
      return presetById.get(presetId) ?? null;
    },
    listPresets() {
      return [...presetById.values()];
    },
    /** Dev only (the debugger and test kits): adds a validated preset. */
    addPreset(preset) {
      if (presetById.has(preset.id)) throw new Error(`[DRIFTWING] preset "${preset.id}" already exists`);
      presetById.set(preset.id, preset);
      siteScan.maxFar = maxSiteFar();
    },
    /** Dev only: removes a preset added with addPreset (its spawns end first). */
    removePreset(presetId) {
      for (let index = records.length - 1; index >= 0; index--) if (records[index].presetId === presetId) removeRecordAt(index, 'removed');
      const removed = presetById.delete(presetId);
      siteScan.maxFar = maxSiteFar();
      return removed;
    },
    /** Replaces the site feed ({ sitesInCell } and/or { sitesNear }); null detaches it. */
    setSiteFeed(feed) {
      if (feed !== null && typeof feed?.sitesInCell !== 'function' && typeof feed?.sitesNear !== 'function') {
        throw new TypeError('[DRIFTWING] a site feed needs sitesInCell(cellX, cellZ) or sitesNear(x, z, radius)');
      }
      siteFeed = feed;
      siteScan.cursor = siteScan.total;
    },
    getSiteFeed() {
      return siteFeed;
    },
    /** The nearest site of presetId within maxRadius of (x, z), from the site feed, or null. */
    findNearestSite(presetId, x, z, maxRadius = 60000) {
      if (!siteFeed || typeof siteFeed.sitesNear !== 'function') return null;
      for (let radius = Math.min(16000, maxRadius); ; radius = Math.min(maxRadius, radius * 2)) {
        const sites = siteFeed.sitesNear(x, z, radius);
        let best = null;
        let bestDistance = Infinity;
        for (const site of sites) {
          if (site.presetId !== presetId) continue;
          const distance = Math.hypot(site.x - x, site.z - z);
          if (distance < bestDistance) {
            best = site;
            bestDistance = distance;
          }
        }
        if (best || radius >= maxRadius) return best;
      }
    },
    /** A site's ACTIVE state (for example an erupting volcano): a director decision. */
    setSiteActive(id, active) {
      const record = recordById.get(id);
      if (!record || record.source !== 'site') return false;
      const next = Boolean(active);
      if (next === record.active) return true;
      if (record.preset.heavy) heavyActive += next ? 1 : -1;
      record.active = next;
      for (let index = 0; index < record.parts.length; index++) record.parts[index].instance.active = next;
      if (record.lureSlot >= 0) lures.setVisible(record.lureSlot, lureShown(record, record.tierRank));
      return true;
    },
    /** Changes an engine's caps. */
    setBudget(engineName, { instances, particles }) {
      const counts = countersFor(engineName);
      if (Number.isFinite(instances) && instances >= 0) counts.budget.instances = instances;
      if (Number.isFinite(particles) && particles >= 0) counts.budget.particles = particles;
    },
    setHeavyLimit(limit) {
      if (Number.isInteger(limit) && limit >= 0) heavyLimit = limit;
    },
    /**
     * Multiplies every preset's LOD distances (lod.near and lod.mid) by bias, in (0, 1]: below 1
     * spawns step to their cheaper tiers sooner. The director's load shedder sets 0.7 and 0.5.
     */
    setLodBias(bias) {
      if (!Number.isFinite(bias) || bias <= 0 || bias > 1) throw new RangeError(`[DRIFTWING] setLodBias expects a bias in (0, 1], got ${bias}`);
      lodScale[0] = bias;
    },
    getLodBias() {
      return lodScale[0];
    },
    /** The number of live spawns (sites and events). */
    spawnCount() {
      return records.length;
    },
    budgets,
    isDiscovered(key) {
      return discovered.has(key);
    },
    /** Marks keys (site ids, event preset ids) discovered, for example from the saved journal. */
    markDiscovered(keys) {
      for (const key of keys) discovered.add(key);
    },
    getDiscovered() {
      return [...discovered];
    },
    /** Reads renderer.info.memory and the heap now: { geometries, textures, attributes, programs, bytes, heap }. */
    readMemory() {
      return readMemory(createMemoryReading());
    },
    /** Records the memory baseline now (the harness calls it before a create/dispose cycle). */
    resetMemoryBaseline() {
      copyReading(memoryBaseline, readMemory(memoryScratch));
      return { ...memoryBaseline };
    },
    lures,
    lights: lightPool,
    engineCtx,
    registry,
    /** Ends every spawn and frees the lures and lights. */
    dispose() {
      for (let index = records.length - 1; index >= 0; index--) removeRecordAt(index, 'disposed');
      lures.dispose();
      lightPool.dispose();
      initialized = false;
    },
  };
  engineCtx.spawns = manager;
  return manager;
}
