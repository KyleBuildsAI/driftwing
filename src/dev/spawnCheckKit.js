// The one kit of the dev spawn checks: ?test=spawns (spawnsTest.js), the preset step-file kits
// (presetChecks.js for presets 21-30, presetChecksBatch2.js for presets 11-20) and the structure
// checks (structureTestKit.js createBrowserHelpers) share it. Dev builds only: nothing in a
// production bundle imports it.
//   - frames(count), wait(ms): waits that keep the game's frames running;
//   - holdConditions(ctx, { sun, morning, weather }): the time of day held (sun elevation on the
//     morning or evening side) and the regional weather forced;
//   - createFraming(ctx): photo-camera framing over the terrain (a viewpoint with a clear sight line,
//     the craft parked behind the camera, the terrain let settle);
//   - createDisposeCheck(ctx, framing): what a spawn must give back. baseline() reads everything
//     before a create and starts the geometry tracker; compare(baseline, options) after the dispose
//     proves GPU memory back (no geometry an engine created still alive, the count moved by no more
//     than the world's own first draws, textures exactly back), every wind source added since the
//     baseline removed, every collider a spawn added since the baseline removed (landmark colliders
//     stream with the craft and are not a spawn's), the sky modifiers and the real lights back to their
//     counts, the SpawnManager's leak counters unchanged, and on request the JS heap within a tolerance.
import { createGeometryTracker, splitFresh } from './geometryTracker.js';
import { heapAvailable, readHeapMB, round } from './testStats.js';

/**
 * Owner-name prefixes of pooled meshes that carry per-instance geometry (the structure engine's mesh
 * pools): a geometry still alive under one after dispose is a leak. Every other engine draws its
 * spawns in fixed shared buffers, and an object an engine adds to the scene during create, update,
 * setLOD or dispose is attributed to the spawns by the tracker itself.
 */
export const SPAWN_OWNERS = Object.freeze(['structure-']);
/** Frames waited after a dispose before the memory is read (pending GPU frees land). */
const SETTLE_FRAMES = 8;
const TERRAIN_IDLE_FRAMES = 20;
const TERRAIN_TIMEOUT_MS = 120000;
/** The craft waits this far behind the photo camera (its tether is 900 m). */
const PARK_BEHIND_M = 300;

/** Resolves after `count` animation frames. */
export function frames(count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left--;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Resolves after `ms` of wall time, while the frames keep running. */
export function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The JS heap (MB) after two forced collections a frame apart (weak references and finalizers settle). */
export async function settledHeapMB() {
  readHeapMB();
  await frames(2);
  return readHeapMB();
}

/**
 * Holds the time of day (the sun `sun` degrees up, on the morning side with morning: true) and forces
 * the regional weather. Returns a line describing it.
 */
export function holdConditions(ctx, { sun = 20, morning = false, weather = 'clear' } = {}) {
  ctx.settings.set('timeFrozen', true);
  ctx.systems.weather.forceState(weather, 0.5);
  ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(sun, !morning), { transition: 0 });
  return `sun ${sun} deg (${morning ? 'morning' : 'evening'}), weather ${weather}`;
}

/**
 * Photo-camera framing over the terrain. Returns { park, ground, clearSight, viewpoint, terrainIdle,
 * frameView }.
 */
export function createFraming(ctx) {
  const THREE = ctx.THREE;
  /** Where the craft waits while the photo camera frames something. */
  const park = { x: 0, y: 0, z: 0, heading: 0 };
  const ground = (x, z) => Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL);

  /** True when the terrain stays below the sight line from position to target. */
  function clearSight(position, target) {
    for (let sample = 1; sample < 32; sample++) {
      const share = sample / 32;
      const y = position.y + (target.y - position.y) * share;
      if (ground(position.x + (target.x - position.x) * share, position.z + (target.z - position.z) * share) > y - 4) return false;
    }
    return true;
  }

  /** A camera position `distance` m from target with a clear view of it, trying bearings around it. */
  function viewpoint(target, distance, height, bearing) {
    for (let lift = 0; lift < 6; lift++) {
      for (const turn of [0, 40, -40, 80, -80, 120, -120, 160, -160]) {
        const toward = (bearing + turn) * (Math.PI / 180);
        const x = target.x + Math.sin(toward) * distance;
        const z = target.z - Math.cos(toward) * distance;
        const position = { x, y: Math.max(ground(x, z) + height * (1 + lift * 0.6), target.y + height * 0.2), z };
        if (clearSight(position, target)) return position;
      }
    }
    const toward = bearing * (Math.PI / 180);
    return { x: target.x + Math.sin(toward) * distance, y: target.y + distance, z: target.z - Math.cos(toward) * distance };
  }

  /**
   * Waits (up to two minutes) until the terrain has nothing queued, in flight, awaiting upload or
   * fading for 20 frames in a row, so the GPU counters move only with what is under test.
   */
  async function terrainIdle() {
    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < TERRAIN_TIMEOUT_MS && quiet < TERRAIN_IDLE_FRAMES) {
      await frames(1);
      const stats = ctx.systems.terrain.getStats();
      quiet = stats.queued === 0 && stats.inFlight === 0 && stats.awaitingUpload === 0 && stats.fading === 0 ? quiet + 1 : 0;
    }
    return quiet >= TERRAIN_IDLE_FRAMES;
  }

  /**
   * Parks the craft behind the camera and frames target from position in photo mode, then waits for
   * the terrain around the camera. The photo camera takes the pose once photo mode is live (a frame or
   * two after the switch), so the pose is retried until it holds. Returns true when it held and the
   * terrain settled.
   */
  async function frameView(position, target, { fov } = {}) {
    const lookX = target.x - position.x;
    const lookZ = target.z - position.z;
    const length = Math.hypot(lookX, lookZ) || 1;
    park.x = position.x - (lookX / length) * PARK_BEHIND_M;
    park.z = position.z - (lookZ / length) * PARK_BEHIND_M;
    park.y = Math.max(position.y, ctx.world.groundHeight(park.x, park.z) + 200);
    park.heading = (Math.atan2(lookX, -lookZ) * 180) / Math.PI;
    ctx.systems.flight.resetTo(park);
    await frames(2);
    ctx.setPhotoMode(true);
    const pose = { position: new THREE.Vector3(position.x, position.y, position.z), target: new THREE.Vector3(target.x, target.y, target.z), fov };
    let posed = false;
    for (let attempt = 0; attempt < 60 && !posed; attempt++) {
      await frames(1);
      posed = ctx.systems.camera.setFreeCameraPose(pose);
    }
    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < TERRAIN_TIMEOUT_MS && quiet < 6) {
      await frames(1);
      quiet = ctx.systems.terrain.isReadyAround(position.x, position.z) ? quiet + 1 : 0;
    }
    await frames(20);
    return posed && quiet >= 6;
  }

  return { park, ground, clearSight, viewpoint, terrainIdle, frameView };
}

/**
 * The dispose check (see the file header). framing: createFraming(ctx), for terrainIdle. Returns
 * { tracker, baseline(options), compare(baseline, options), restore() }; tracker is null where the
 * renderer internals it wraps are missing, and the GPU check then falls back to the plain counts.
 */
export function createDisposeCheck(ctx, framing) {
  const manager = ctx.systems.spawns.manager;
  const tracker = createGeometryTracker(ctx.renderer, ctx.scene);
  if (tracker) tracker.attribute(manager.registry.names().map((name) => manager.registry.get(name)));

  function gpuMemory() {
    const memory = ctx.renderer.info.memory;
    return { geometries: memory.geometries, textures: memory.textures };
  }

  /** Collider ids (ctx.colliders) that are not the streaming landmarks'. */
  function spawnColliderIds() {
    if (!ctx.colliders) return [];
    return ctx.colliders.list().filter((entry) => !entry.owner.startsWith('landmark:')).map((entry) => entry.id);
  }

  function lightsInUse() {
    const lights = manager.getStats().lights;
    return lights ? lights.active : 0;
  }

  /** The geometries live structure spawns still show (a site built meanwhile is not the spawn under test's). */
  function heldStructureGeometries() {
    const held = new Set();
    for (const spawn of manager.getActive()) {
      for (const part of manager.getParts(spawn.id)) {
        if (part.engine !== 'structure' || !part.data.meshes) continue;
        for (const mesh of Object.values(part.data.meshes)) if (mesh && mesh.geometry) held.add(mesh.geometry.uuid);
      }
    }
    return held;
  }

  return {
    tracker,

    /**
     * Reads everything a dispose must give back, after the terrain has gone quiet (waitTerrain), and
     * starts the geometry tracker. options: { heap (read the JS heap too), waitTerrain = true }.
     */
    async baseline({ heap = false, waitTerrain = true } = {}) {
      if (waitTerrain) await framing.terrainIdle();
      await frames(2);
      const record = {
        heapMB: heap ? await settledHeapMB() : null,
        memory: gpuMemory(),
        windIds: new Set(ctx.wind.listSources().map((source) => source.id)),
        windCount: ctx.wind.sourceCount,
        colliderIds: new Set(spawnColliderIds()),
        sky: ctx.systems.sky.getModifierState().count,
        lights: lightsInUse(),
        leaks: { ...manager.getStats().leaks },
      };
      if (tracker) tracker.start();
      return record;
    },

    /**
     * Compares the state after a dispose with its baseline. options: { presetIds (the presets under
     * test: a structure geometry can only be theirs when one has a structure part), heapToleranceMB
     * (judge the heap; the baseline must have read it), waitTerrain = true }. Returns the readings
     * with gpuOk, windOk, collidersOk, skyOk, lightsOk, leaksOk, heapOk and ok (all of them).
     */
    async compare(baseline, { presetIds = [], heapToleranceMB = null, waitTerrain = true } = {}) {
      await frames(SETTLE_FRAMES);
      if (waitTerrain) await framing.terrainIdle();
      const memory = gpuMemory();
      const fresh = tracker ? tracker.stop() : [];
      const split = splitFresh(fresh, SPAWN_OWNERS);
      const held = heldStructureGeometries();
      const ownsStructure = presetIds.some((id) => (manager.getPreset(id)?.engines ?? []).some((entry) => entry.engine === 'structure'));
      const leftBehind = split.leftBehind.filter((entry) => !held.has(entry.uuid) && (ownsStructure || !entry.owner.startsWith('structure-')));
      // The count may also drop by what the world freed meanwhile (a far site or terrain chunk), so a
      // spawn's leftovers show as leftBehind or as a count above the world's first draws.
      const worldFresh = split.world + (split.leftBehind.length - leftBehind.length);
      const windLeft = ctx.wind.listSources().filter((source) => !baseline.windIds.has(source.id)).map((source) => source.id);
      const collidersLeft = spawnColliderIds().filter((id) => !baseline.colliderIds.has(id));
      const sky = ctx.systems.sky.getModifierState().count;
      const lights = lightsInUse();
      const leaks = manager.getStats().leaks;
      const judgeHeap = Number.isFinite(heapToleranceMB);
      const heapMB = judgeHeap ? await settledHeapMB() : null;
      const geometryDelta = memory.geometries - baseline.memory.geometries;
      const textureDelta = memory.textures - baseline.memory.textures;
      const heapDeltaMB = Number.isFinite(heapMB) && Number.isFinite(baseline.heapMB) ? round(heapMB - baseline.heapMB, 2) : null;
      const result = {
        before: baseline.memory,
        after: memory,
        geometryDelta,
        textureDelta,
        worldFirstDrawn: worldFresh,
        leftBehind: leftBehind.map((entry) => `${entry.owner}/${entry.object} ${entry.type}`),
        gpuOk: tracker !== null ? leftBehind.length === 0 && geometryDelta <= worldFresh && textureDelta === 0 : geometryDelta <= 0 && textureDelta === 0,
        windSources: `${baseline.windCount} -> ${ctx.wind.sourceCount}`,
        windLeft,
        windOk: windLeft.length === 0,
        colliders: `${baseline.colliderIds.size} -> ${baseline.colliderIds.size + collidersLeft.length}`,
        collidersLeft,
        collidersOk: collidersLeft.length === 0,
        skyModifiers: `${baseline.sky} -> ${sky}`,
        skyOk: sky === baseline.sky,
        lights: `${baseline.lights} -> ${lights}`,
        lightsOk: lights === baseline.lights,
        leaks,
        leaksOk: leaks.windSources === baseline.leaks.windSources && leaks.lights === baseline.leaks.lights && (leaks.colliders ?? 0) === (baseline.leaks.colliders ?? 0),
        heapBeforeMB: baseline.heapMB,
        heapAfterMB: heapMB,
        heapDeltaMB,
        heapOk: !judgeHeap || (heapDeltaMB === null ? !heapAvailable() : heapDeltaMB <= heapToleranceMB),
      };
      result.ok = result.gpuOk && result.windOk && result.collidersOk && result.skyOk && result.lightsOk && result.leaksOk && result.heapOk;
      return result;
    },

    /** Abandons a check after its baseline (the create was refused): the tracker stops recording. */
    cancel() {
      if (tracker) tracker.stop();
    },

    /** Stops tracking and puts the renderer's, the scene's and the engines' own methods back. */
    restore() {
      if (tracker) tracker.restore();
    },
  };
}
