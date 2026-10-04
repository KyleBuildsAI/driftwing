// Dev-only spawn framework test kit: two TEST engines and the presets that drive them. It proves the
// SpawnManager, the lures, the light pool and the memory accounting before the real engines exist.
// It is never part of a production build: the spawns system loads it only through
// spawns.debug.loadTestKit() in dev builds (import.meta.env.DEV), and tools/lab/spawns.mjs imports it
// in node.
//
//   testMarker  instanced diamond markers (one shared InstancedMesh, a slot per instance) plus a
//               per-instance halo ring with its own geometry on a pooled mesh (pools.js explains why),
//               shown only at the near tier, so each instance really takes and returns GPU memory.
//               Heavy presets hide the marker at the far tier, where their lure takes over. With
//               `declines: true` an instance ends at create, as thermal hawks with no thermal do.
//   testWind    a rising column registered in the WindField per instance (and, when asked, one real
//               light from the pool); dispose() removes both.
//
// installSpawnTestKit(system) registers both engines and the test presets, and publishes proof
// helpers as system.debug.testKit for tools/spawn-check.mjs.

const MARKER_CAPACITY = 256;
const MARKER_BOB_METRES = 0.6;
const HALO_SEGMENTS_MIN = 24;
const HALO_SEGMENTS_SPAN = 16;

/** The test engine that draws instanced markers (see the file header). */
export function createTestMarkerEngine() {
  let ctx = null;
  let pool = null;
  let halos = null;
  let haloMaterial = null;
  let position = null;
  let rotation = null;
  let scale = null;
  let color = null;
  let visibleHalos = 0;
  let live = 0;

  /**
   * Picks a marker's matrix for its tier (both are composed once on create; frames only write the
   * translation, so no double crosses a call).
   */
  function showMarker(instance) {
    const data = instance.data;
    data.matrix = instance.tier === 'far' && instance.heavy ? data.hiddenMatrix : data.shownMatrix;
    pool.setMatrix(data.slot, data.matrix);
  }

  return {
    name: 'testMarker',
    budget: { instances: MARKER_CAPACITY, particles: 0 },
    init(engineCtx) {
      ctx = engineCtx;
      const { THREE } = ctx;
      position = new THREE.Vector3();
      rotation = new THREE.Quaternion();
      scale = new THREE.Vector3();
      color = new THREE.Color();
      const markerMaterial = new THREE.MeshBasicNodeMaterial();
      pool = ctx.pools.createInstancedPool({
        geometry: new THREE.OctahedronGeometry(1, 0),
        material: markerMaterial,
        capacity: MARKER_CAPACITY,
        name: 'test-markers',
        parent: ctx.scene,
        colors: true,
      });
      haloMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
      haloMaterial.color.set(0xfff1c8);
      haloMaterial.opacity = 0.7;
      halos = ctx.pools.createMeshPool({ material: haloMaterial, capacity: MARKER_CAPACITY, parent: ctx.scene, name: 'test-marker-halo' });
    },
    create(preset, params, rng) {
      const { THREE } = ctx;
      const slot = pool.alloc();
      if (slot < 0) throw new Error('testMarker: every marker slot is taken');
      const size = Number.isFinite(params.size) ? params.size : 24;
      const segments = HALO_SEGMENTS_MIN + Math.floor(rng() * HALO_SEGMENTS_SPAN);
      const haloGeometry = new THREE.RingGeometry(size * 0.9, size * 1.25, segments, 1);
      haloGeometry.rotateX(-Math.PI / 2);
      const halo = halos.acquire(haloGeometry);
      if (!halo) {
        haloGeometry.dispose();
        pool.free(slot);
        throw new Error('testMarker: every halo mesh is taken');
      }
      // Always drawn at the near tier (never frustum-culled), so each instance's geometry reaches
      // the GPU and the memory check sees it come and go.
      halo.frustumCulled = false;
      halo.position.set(params.position.x, params.position.y + 1.5, params.position.z);
      halo.visible = false;
      live++;
      pool.setColor(slot, color.set(Number.isInteger(params.color) ? params.color : 0xffc36b));
      const instance = {
        anchor: params.position,
        radius: size,
        windSourceIds: [],
        lights: 0,
        particles: 0,
        tier: 'near',
        heavy: preset.heavy,
        ended: params.declines === true,
        data: { slot, halo, size, phase: rng() * Math.PI * 2, bob: MARKER_BOB_METRES * (size / 24), shownMatrix: new THREE.Matrix4(), hiddenMatrix: new THREE.Matrix4(), matrix: null, tierChanges: 0, lastTier: null },
      };
      position.set(params.position.x, params.position.y + size * 0.5, params.position.z);
      rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rng() * Math.PI * 2);
      instance.data.shownMatrix.compose(position, rotation, scale.set(size * 0.35, size * 0.5, size * 0.35));
      instance.data.hiddenMatrix.compose(position, rotation, scale.set(0, 0, 0));
      showMarker(instance);
      pool.flush();
      return instance;
    },
    update(instance, dt, engineCtx) {
      const data = instance.data;
      const anchor = instance.anchor;
      data.halo.position.copy(anchor);
      data.halo.position.y += 1.5;
      // Follow the anchor and bob, writing the translation in place.
      const elements = data.matrix.elements;
      elements[12] = anchor.x;
      elements[13] = anchor.y + data.size * 0.5 + Math.sin(engineCtx.time.elapsed * 1.3 + data.phase) * data.bob;
      elements[14] = anchor.z;
      pool.setMatrix(data.slot, data.matrix);
      pool.flush();
    },
    setLOD(instance, tier) {
      const data = instance.data;
      if (data.lastTier !== null && data.lastTier !== tier) data.tierChanges++;
      data.lastTier = tier;
      instance.tier = tier;
      const showHalo = tier === 'near';
      if (data.halo.visible !== showHalo) visibleHalos += showHalo ? 1 : -1;
      data.halo.visible = showHalo;
      showMarker(instance);
      pool.flush();
    },
    dispose(instance) {
      const data = instance.data;
      if (data.halo.visible) visibleHalos--;
      const haloGeometry = data.halo.geometry;
      halos.release(data.halo);
      haloGeometry.dispose();
      data.halo = null;
      pool.free(data.slot);
      pool.flush();
      live--;
    },
    stats() {
      return { instances: live, particles: 0, lights: 0, buffers: live + 1, drawCalls: (pool && pool.used > 0 ? 1 : 0) + visibleHalos };
    },
  };
}

/** The test engine that registers a WindField column per instance (see the file header). */
export function createTestWindEngine() {
  let ctx = null;
  let serial = 0;
  let live = 0;
  let lightsHeld = 0;

  return {
    name: 'testWind',
    budget: { instances: 16, particles: 0, lights: 1 },
    init(engineCtx) {
      ctx = engineCtx;
    },
    create(preset, params) {
      const { THREE } = ctx;
      const radius = Number.isFinite(params.radius) ? params.radius : 250;
      const height = Number.isFinite(params.height) ? params.height : 1500;
      const strength = Number.isFinite(params.strength) ? params.strength : 6;
      const centre = params.position;
      const id = `test-wind:${params.seed}:${serial++}`;
      const result = { vel: new THREE.Vector3(), turbulence: 0 };
      ctx.wind.addSource({
        id,
        kind: 'test-updraft',
        bounds: { min: { x: centre.x - radius, y: centre.y - 50, z: centre.z - radius }, max: { x: centre.x + radius, y: centre.y + height, z: centre.z + radius } },
        sample(point) {
          const offsetX = point.x - centre.x;
          const offsetZ = point.z - centre.z;
          const across = Math.sqrt(offsetX * offsetX + offsetZ * offsetZ) / radius;
          const up = (point.y - centre.y) / height;
          const falloff = Math.max(0, 1 - across * across) * Math.max(0, Math.min(1, up * 8)) * Math.max(0, 1 - up * up);
          result.vel.set(0, strength * falloff, 0);
          result.turbulence = 0.3 * falloff;
          return result;
        },
      });
      live++;
      const instance = { anchor: centre, radius, windSourceIds: [id], lights: 0, particles: 0, data: { id, light: null } };
      if (params.light === true) {
        const light = ctx.lights.acquire(1);
        if (light) {
          light.position.set(centre.x, centre.y + 40, centre.z);
          light.color.set(0x9fe4ff);
          light.distance = radius * 2;
          light.intensity = 4000;
          instance.data.light = light;
          instance.lights = 1;
          lightsHeld++;
        }
      }
      return instance;
    },
    update() {},
    setLOD() {},
    dispose(instance) {
      ctx.wind.removeSource(instance.data.id);
      if (instance.data.light) {
        ctx.lights.release(instance.data.light);
        instance.data.light = null;
        instance.lights = 0;
        lightsHeld--;
      }
      live--;
    },
    stats() {
      return { instances: live, particles: 0, lights: lightsHeld, buffers: 0, drawCalls: 0 };
    },
  };
}

const TEST_FILTERS = Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null });
const TEST_CANDIDATES = Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.1 });
const TEST_CALLOUTS = Object.freeze(['Test spawn {distance} {direction}.', '{name} ahead, {eta}.', 'Framework check: {name}.']);

function testEvent(id, name, { engines, heavy = false, lure = null, lod, discoveryRadius = 1200, wind = [] }) {
  return Object.freeze({
    id,
    name,
    category: 'flightplay',
    kind: 'event',
    rarity: 'common',
    heavy,
    candidates: TEST_CANDIDATES,
    filters: TEST_FILTERS,
    engines,
    lod,
    lure,
    wind,
    audio: null,
    journal: Object.freeze({ title: name, description: 'A spawn framework test fixture.' }),
    discovery: Object.freeze({ radius: discoveryRadius, requireInView: true }),
    callouts: TEST_CALLOUTS,
    lifetime: Object.freeze({ duration: [600, 900], despawn: Object.freeze({ distance: 8000, hysteresis: 1500, outOfViewSeconds: 20 }) }),
  });
}

const LURE_LOD = Object.freeze({ near: 1500, mid: 6000, far: 45000 });

/** One heavy test preset per lure silhouette: [presetId, lure]. */
export const TEST_LURES = Object.freeze([
  ['testLurePlume', Object.freeze({ type: 'plume', height: 5200, width: 3400, color: 0x5d5754 })],
  ['testLureAnvil', Object.freeze({ type: 'anvil', height: 11000, width: 17000, color: 0xdfe3ea })],
  ['testLureFunnel', Object.freeze({ type: 'funnel', height: 1900, width: 1100, color: 0x5f646e })],
  ['testLureWhale', Object.freeze({ type: 'whale', height: 420, width: 1500, altitude: 1400, color: 0x5f6d80 })],
  ['testLureIslands', Object.freeze({ type: 'islands', height: 1900, width: 4600, altitude: 650, color: 0x7d705f })],
  ['testLureComet', Object.freeze({ type: 'comet', height: 2600, width: 14000, altitude: 9000, color: 0xcfe6ff })],
]);

/** The test presets (frozen, valid against src/spawns/schema.js with the two test engines). */
export function createTestPresets() {
  const presets = [
    testEvent('testMarker', 'Test marker', {
      engines: [Object.freeze({ engine: 'testMarker', params: Object.freeze({ size: 24, color: 0xffc36b }) })],
      lod: Object.freeze({ near: 900, mid: 3500, far: 9000 }),
    }),
    testEvent('testUpdraft', 'Test updraft', {
      engines: [
        Object.freeze({ engine: 'testWind', params: Object.freeze({ strength: 7, radius: 260, height: 1600, light: true }) }),
        Object.freeze({ engine: 'testMarker', params: Object.freeze({ size: 16, color: 0x8fd3d6 }) }),
      ],
      lod: Object.freeze({ near: 900, mid: 3500, far: 9000 }),
      wind: [Object.freeze({ type: 'updraft', params: Object.freeze({ strength: 7, radius: 260 }) })],
    }),
    Object.freeze({
      id: 'testSite',
      name: 'Test site',
      category: 'structure',
      kind: 'site',
      rarity: 'common',
      heavy: false,
      placement: Object.freeze({ chance: 1, minSpacing: 0, biomes: null, surface: 'any', clearance: 0 }),
      filters: TEST_FILTERS,
      stamps: [],
      engines: [Object.freeze({ engine: 'testMarker', params: Object.freeze({ size: 30, color: 0xb9f0cf }) })],
      lod: Object.freeze({ near: 900, mid: 3000, far: 6000 }),
      lure: null,
      wind: [],
      audio: null,
      journal: Object.freeze({ title: 'Test site', description: 'A persistent spawn framework test fixture.' }),
      discovery: Object.freeze({ radius: 1500, requireInView: true }),
      callouts: TEST_CALLOUTS,
      lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 6000, hysteresis: 1000, outOfViewSeconds: 0 }) }),
    }),
  ];
  for (const [id, lure] of TEST_LURES) {
    presets.push(testEvent(id, `Test lure (${lure.type})`, {
      heavy: true,
      lure,
      engines: [Object.freeze({ engine: 'testMarker', params: Object.freeze({ size: 60, color: lure.color }) })],
      lod: LURE_LOD,
      discoveryRadius: 2500,
    }));
  }
  return Object.freeze(presets);
}

/**
 * A site feed over a fixed list of sites ({ id, presetId, x, z, groundY, rotation, scale, seed,
 * stamps }), with the contract 2.1 queries: sitesInCell (cached arrays) and sitesNear (sorted).
 */
export function createTestSiteFeed(sites, cellSize = 2000) {
  const cells = new Map();
  for (const site of sites) {
    const key = `${Math.floor(site.x / cellSize)}:${Math.floor(site.z / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(site);
  }
  const empty = Object.freeze([]);
  return {
    sitesInCell(cellX, cellZ) {
      return cells.get(`${cellX}:${cellZ}`) ?? empty;
    },
    sitesNear(x, z, radius) {
      return sites
        .map((site) => ({ site, distance: Math.hypot(site.x - x, site.z - z) }))
        .filter((entry) => entry.distance <= radius)
        .sort((first, second) => first.distance - second.distance)
        .map((entry) => entry.site);
    },
  };
}

/** Rounds a number for reports. */
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Registers the test engines and presets on a spawns system (dev builds) and publishes the proof
 * helpers as system.debug.testKit. Returns { engines, presets }.
 */
export function installSpawnTestKit(system) {
  const manager = system.manager;
  const engines = [];
  if (!manager.registry.has('testMarker')) engines.push(system.debug.registerEngine(createTestMarkerEngine()).name);
  if (!manager.registry.has('testWind')) engines.push(system.debug.registerEngine(createTestWindEngine()).name);
  const presets = [];
  for (const preset of createTestPresets()) {
    if (manager.getPreset(preset.id)) continue;
    presets.push(system.debug.addPreset(preset));
  }
  const ctx = manager.engineCtx;
  const discoveries = [];
  const ended = [];
  ctx.bus.onTyped('discovery', (payload) => {
    if (payload.presetId) discoveries.push({ id: payload.id, presetId: payload.presetId, time: round(ctx.state.time.elapsed, 2) });
  });
  ctx.bus.onTyped('spawnEnded', (payload) => ended.push({ ...payload }));
  const windEvents = [];
  ctx.bus.onTyped('windSourceAdded', (payload) => { if (payload.kind === 'test-updraft') windEvents.push({ type: 'added', id: payload.id }); });
  ctx.bus.onTyped('windSourceRemoved', (payload) => { if (payload.kind === 'test-updraft') windEvents.push({ type: 'removed', id: payload.id }); });

  /** A point distance metres from the camera, bearing degrees right of its horizontal forward. */
  function pointFromCamera(distance, bearing = 0, height = null) {
    const camera = ctx.camera;
    const origin = camera.getWorldPosition(new ctx.THREE.Vector3());
    const forward = camera.getWorldDirection(new ctx.THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    forward.applyAxisAngle(ctx.THREE.Object3D.DEFAULT_UP, -bearing * Math.PI / 180);
    const x = origin.x + forward.x * distance;
    const z = origin.z + forward.z * distance;
    const ground = Math.max(ctx.terrain.groundHeight(x, z), ctx.terrain.waterLevel);
    return { x, y: height === null ? ground : height, z };
  }

  /**
   * A ground point minDistance..maxDistance ahead of the camera (within 16 degrees of its heading and
   * 24 degrees below its level) whose spot lift metres above the ground the camera can see over the
   * terrain, or null. The discovery proofs place their spawns there.
   */
  function visiblePointAhead({ minDistance = 350, maxDistance = 1400, lift = 15 } = {}) {
    const origin = ctx.camera.getWorldPosition(new ctx.THREE.Vector3());
    for (let distance = minDistance; distance <= maxDistance; distance += 50) {
      for (const bearing of [0, -8, 8, -16, 16]) {
        const point = pointFromCamera(distance, bearing);
        const targetY = point.y + lift;
        const drop = Math.atan2(origin.y - targetY, distance) * 180 / Math.PI;
        if (drop > 24) continue;
        let clear = true;
        for (let sample = 1; sample < 24 && clear; sample++) {
          const t = sample / 24;
          const x = origin.x + (point.x - origin.x) * t;
          const z = origin.z + (point.z - origin.z) * t;
          if (ctx.terrain.groundHeight(x, z) > origin.y + (targetY - origin.y) * t - 2) clear = false;
        }
        if (clear) return { ...point, distance, bearing };
      }
    }
    return null;
  }

  const api = {
    presets: createTestPresets().map((preset) => preset.id),
    visiblePointAhead,
    discoveries,
    ended,
    windEvents,
    /** Force-spawns presetId distance metres from the camera, bearing degrees right of its heading. */
    spawnAt(presetId, { distance = 1000, bearing = 0, height = null } = {}) {
      const position = pointFromCamera(distance, bearing, height);
      return manager.activate(presetId, { position, heading: ctx.state.player.heading, source: 'debug', force: true });
    },
    /** count markers spread over a fan ahead of the camera, minDistance..maxDistance out. */
    createMany(count, { presetId = 'testMarker', minDistance = 250, maxDistance = 900, spread = 70 } = {}) {
      const ids = [];
      for (let index = 0; index < count; index++) {
        const along = minDistance + (maxDistance - minDistance) * ((index * 0.618034) % 1);
        const bearing = -spread / 2 + spread * (index / Math.max(1, count - 1));
        const id = api.spawnAt(presetId, { distance: along, bearing });
        if (id) ids.push(id);
      }
      return ids;
    },
    deactivateAll(ids, reason = 'test') {
      let count = 0;
      for (const id of ids) if (manager.deactivate(id, reason)) count++;
      return count;
    },
    /** Moves a spawn's anchor to distance metres straight ahead of the camera, at the camera's height. */
    moveAhead(id, distance) {
      const position = pointFromCamera(distance, 0, ctx.camera.getWorldPosition(new ctx.THREE.Vector3()).y);
      const parts = api.parts(id);
      for (const part of parts) part.anchor.set(position.x, position.y, position.z);
      return parts.length;
    },
    /** The engine instances of a spawn (dev inspection). */
    parts(id) {
      const record = manager.getInstance(id);
      if (!record) return [];
      return manager.getParts(id);
    },
    /** Vertical wind (m/s) at a point, probed without disturbing the craft's reading. */
    windUp(point) {
      const sample = ctx.wind.probe(new ctx.THREE.Vector3(point.x, point.y, point.z));
      return round(sample.vel.y, 3);
    },
    windSourceCount() {
      return ctx.wind.sourceCount;
    },
    /** Force-spawns presetId at a point ({ x, y, z }). */
    spawnAtPoint(presetId, point) {
      return manager.activate(presetId, { position: { x: point.x, y: point.y, z: point.z }, heading: ctx.state.player.heading, source: 'debug', force: true });
    },
    /**
     * Attaches a site feed with one testSite at point (default: distance metres ahead of the camera);
     * returns the site.
     */
    placeTestSite(distance = 700, point = pointFromCamera(distance)) {
      const site = Object.freeze({
        id: `testSite:${Math.floor(point.x / 2000)}:${Math.floor(point.z / 2000)}`,
        presetId: 'testSite',
        x: point.x,
        z: point.z,
        groundY: point.y,
        rotation: 0,
        scale: 1,
        seed: 1234567,
        stamps: Object.freeze([]),
      });
      system.setSiteFeed(createTestSiteFeed([site]));
      return site;
    },
    detachSiteFeed() {
      system.setSiteFeed(null);
    },
    memory() {
      return manager.readMemory();
    },
  };
  system.debug.testKit = api;
  return { engines, presets };
}
