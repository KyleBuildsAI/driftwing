// Dev-only StructureEngine test kit: preset-like objects for every recipe (valid against
// src/spawns/schema.js) and a helper that resolves a preset's stamps into a site record, the way
// placement.js does, for a chosen spot. tools/lab/structure.mjs builds real stamped sites with it,
// and tools/steps/engine-structure.json force-spawns the presets ahead of the craft through the dev
// hook (spawns.debug.addPreset). Never part of a production build: only the lab and dev-server step
// files import it. The real presets arrive with Milestone E in src/spawns/presets/.
import { resolveStamp } from '../world/stamps.js';
import { structureStamps } from '../spawns/engines/structure/stamps.js';

const SITE_FILTERS = Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null });
const SITE_LIFETIME = Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 }) });
const CALLOUTS = Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Structure check: {name}.']);

function testSite(id, name, { category = 'structure', heavy = false, lure = null, stamps = [], engines, lod, audio = null, radius = 1500 }) {
  return Object.freeze({
    id,
    name,
    category,
    kind: 'site',
    rarity: 'common',
    heavy,
    // Never placed by a world (worlds place only src/spawns/presets); the kit's tests place them by hand.
    placement: Object.freeze({ chance: 0.01, minSpacing: 0, biomes: null, surface: 'any', clearance: 0 }),
    filters: SITE_FILTERS,
    stamps: Object.freeze(stamps.map((stamp) => Object.freeze(stamp))),
    engines: Object.freeze(engines.map((entry) => Object.freeze(entry))),
    lod: Object.freeze(lod),
    lure,
    wind: [],
    audio,
    journal: Object.freeze({ title: name, description: 'A StructureEngine test fixture.' }),
    discovery: Object.freeze({ radius, requireInView: true }),
    callouts: CALLOUTS,
    lifetime: SITE_LIFETIME,
  });
}

/** The kit's presets, one per recipe (ids prefixed 'dev'). */
export function createStructureTestPresets() {
  return Object.freeze([
    testSite('devWindFarm', 'Dev wind farm', {
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'windFarm', count: 6, rows: 2, spacing: 240 }) }],
      lod: { near: 1800, mid: 6000, far: 14000 },
      audio: Object.freeze({ recipe: 'turbine', params: Object.freeze({}) }),
      radius: 2500,
    }),
    testSite('devRopeBridge', 'Dev rope bridge', {
      stamps: structureStamps('ropeBridge'),
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'ropeBridge', span: 150, gate: Object.freeze({ id: 'under', achievement: Object.freeze({ id: 'threadTheNeedle', title: 'Thread the Needle' }) }) }) }],
      lod: { near: 1200, mid: 4000, far: 9000 },
    }),
    testSite('devAirfield', 'Dev airfield', {
      stamps: structureStamps('airfield'),
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'airfield', length: 1100, width: 45, hangars: Object.freeze({ count: 3, ruin: 0.6 }) }) }],
      lod: { near: 1800, mid: 6000, far: 12000 },
      radius: 2000,
    }),
    testSite('devIslands', 'Dev floating islands', {
      category: 'fantasy',
      heavy: true,
      lure: Object.freeze({ type: 'islands', height: 600, width: 1200, altitude: 250, color: 0x7d705f }),
      stamps: structureStamps('islands'),
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'islands', count: 3, altitude: [160, 260], spread: 420 }) }],
      lod: { near: 2000, mid: 8000, far: 30000 },
      audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({}) }),
      radius: 3000,
    }),
    testSite('devSpires', 'Dev crystal spires', {
      category: 'fantasy',
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'spires', count: 7 }) }],
      lod: { near: 1500, mid: 5000, far: 12000 },
      audio: Object.freeze({ recipe: 'crystal', params: Object.freeze({}) }),
    }),
    testSite('devCanyonGates', 'Dev canyon run', {
      category: 'geo',
      stamps: structureStamps('gates'),
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'gates', course: 'devCanyonRun', journal: 'devCanyonRun' }) }],
      lod: { near: 1500, mid: 5000, far: 12000 },
    }),
  ]);
}

/** A seeded mulberry32 generator. */
function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A site record for preset at (x, z) facing rotation (radians), its stamps resolved against the
 * unstamped height baseHeight(x, z) as placement does. Returns the frozen site.
 */
export function buildTestSite(preset, { x, z, rotation = 0, seed = 12345, cellX = Math.floor(x / 2000), cellZ = Math.floor(z / 2000) }, { baseHeight, waterLevel }) {
  const site = { id: `${preset.id}:${cellX}:${cellZ}`, presetId: preset.id, cellX, cellZ, x, z, rotation, scale: 1, seed };
  const stamps = (preset.stamps ?? []).map((spec, index) => resolveStamp(spec, site, index, mulberry32(seed + index * 7919), { baseHeight, waterLevel }));
  return Object.freeze({ ...site, groundY: Math.max(baseHeight(x, z), waterLevel), biome: 'meadows', stamps: Object.freeze(stamps) });
}

/**
 * ?test=sites (dev builds; main.js loads it): the terrain test's fixture site presets reach worldgen
 * on both threads, so the world has real stamped sites (an airfield strip, a gorge, islets, a canyon),
 * and no harness runs. tools/steps/engine-structure-sites.json shows the structure recipes on them.
 */
export async function prepareSiteWorld() {
  const { TERRAIN_FIXTURES } = await import('./terrainFixtures.js');
  return {
    databaseName: 'driftwing-v2-test-sites',
    worldPresets: TERRAIN_FIXTURES,
    createSystem: () => ({ update() {} }),
  };
}

// ---- Browser checks (tools/steps/engine-structure*.json) ---------------------------------------------
/** Resolves after `count` animation frames. */
function frames(count) {
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

/** The camera, terrain and check helpers both browser check sets use. */
function createBrowserHelpers(game, label) {
  const { ctx } = game;
  const THREE = ctx.THREE;
  const results = [];
  /** Where the craft waits while the photo camera frames a structure. */
  const park = { x: 0, y: 0, z: 0, heading: 0 };
  const ground = (x, z) => Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL);

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    results.push(line);
    if (!ok) console.error(`[${label} check] ${line}`);
    return line;
  }

  /** True when the terrain stays below the sight line from position to target. */
  function clearSight(position, target) {
    for (let sample = 1; sample < 32; sample++) {
      const t = sample / 32;
      const y = position.y + (target.y - position.y) * t;
      if (ground(position.x + (target.x - position.x) * t, position.z + (target.z - position.z) * t) > y - 4) return false;
    }
    return true;
  }

  /** A camera position `distance` m from target with a clear view of it, trying bearings around it. */
  function viewpoint(target, distance, height, bearing) {
    for (let lift = 0; lift < 6; lift++) {
      for (const offset of [0, 40, -40, 80, -80, 120, -120, 160, -160]) {
        const toward = (bearing + offset) * (Math.PI / 180);
        const x = target.x + Math.sin(toward) * distance;
        const z = target.z - Math.cos(toward) * distance;
        const position = { x, y: Math.max(ground(x, z) + height * (1 + lift * 0.6), target.y + height * 0.2), z };
        if (clearSight(position, target)) return position;
      }
    }
    const toward = bearing * (Math.PI / 180);
    return { x: target.x + Math.sin(toward) * distance, y: target.y + distance, z: target.z - Math.cos(toward) * distance };
  }

  /** Parks the craft behind the camera and frames target from position; waits for the terrain. */
  async function frameView(position, target) {
    const lookX = target.x - position.x;
    const lookZ = target.z - position.z;
    const length = Math.hypot(lookX, lookZ) || 1;
    park.x = position.x - (lookX / length) * 300;
    park.z = position.z - (lookZ / length) * 300;
    park.y = Math.max(position.y, ctx.world.groundHeight(park.x, park.z) + 200);
    park.heading = (Math.atan2(lookX, -lookZ) * 180) / Math.PI;
    ctx.systems.flight.resetTo(park);
    await frames(2);
    ctx.setPhotoMode(true);
    await frames(2);
    ctx.systems.camera.setFreeCameraPose({ position: new THREE.Vector3(position.x, position.y, position.z), target: new THREE.Vector3(target.x, target.y, target.z) });
    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < 120000 && quiet < 6) {
      await frames(1);
      quiet = ctx.systems.terrain.isReadyAround(position.x, position.z) ? quiet + 1 : 0;
    }
    await frames(20);
    return quiet >= 6;
  }

  /**
   * Waits (up to two minutes) until the terrain has nothing queued, in flight, awaiting upload or
   * fading for 20 frames in a row, so the GPU counters move only with the structure under test.
   */
  async function terrainIdle() {
    const started = performance.now();
    let quiet = 0;
    while (performance.now() - started < 120000 && quiet < 20) {
      await frames(1);
      const stats = ctx.systems.terrain.getStats();
      quiet = stats.queued === 0 && stats.inFlight === 0 && stats.awaitingUpload === 0 && stats.fading === 0 ? quiet + 1 : 0;
    }
    return quiet >= 20;
  }

  /** Moves the craft through a gate (placed with flight.resetTo, a few metres a frame). */
  async function flyThroughGate(gates, index) {
    const base = index * 8;
    const y = (gates[base + 5] + gates[base + 6]) * 0.5;
    const heading = (Math.atan2(gates[base + 2], -gates[base + 3]) * 180) / Math.PI;
    for (let step = -20; step <= 20; step++) {
      ctx.systems.flight.resetTo({ x: gates[base] + gates[base + 2] * step * 6, y, z: gates[base + 1] + gates[base + 3] * step * 6, heading });
      await frames(1);
    }
    // Back to the parking spot, so the terrain around the craft is what it was before.
    ctx.systems.flight.resetTo(park);
    await terrainIdle();
  }

  function finish() {
    ctx.setPhotoMode(false);
    const failed = results.filter((line) => line.startsWith('FAIL'));
    return check(`${label} checks`, failed.length === 0, `${results.length - failed.length}/${results.length} passed`);
  }

  return { ctx, THREE, results, park, ground, check, viewpoint, frameView, terrainIdle, flyThroughGate, finish };
}

/**
 * Installs window.__dwStructure on a running V2 (dev server, tools/steps/engine-structure.json): the
 * kit's presets through the dev hook, force-spawned ahead of the craft, framed, and proven: GPU
 * memory back to its level and wind sources gone after every dispose, the bridge's gate. Every failed
 * check calls console.error, so the smoke test fails.
 */
export function installStructureChecks(game) {
  const helpers = createBrowserHelpers(game, 'structure');
  const { ctx, check, ground, viewpoint, frameView, terrainIdle, flyThroughGate } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const spawned = new Map();

  /**
   * GPU memory and the terrain's chunk meshes. A flight under the bridge can make the terrain's mesh
   * pools grow by a chunk mesh (a pooled mesh keeps its geometry by design), so the dispose check
   * allows the geometry count to move by exactly the chunk meshes the terrain created meanwhile.
   */
  function memory() {
    const info = ctx.renderer.info.memory;
    const terrainMeshes = ctx.systems.terrain.getStats().meshesCreated.reduce((sum, count) => sum + count, 0);
    return { geometries: info.geometries, textures: info.textures, terrainMeshes };
  }

  /**
   * The gentlest open ground about `distance` m ahead of the craft (within 50 degrees of its
   * heading): the spot whose ring of samples `reach` m out varies least.
   */
  function openGroundAhead(distance, reach) {
    let best = null;
    for (let bearing = -50; bearing <= 50; bearing += 10) {
      for (const share of [0.7, 0.85, 1, 1.15, 1.3]) {
        const heading = (state.player.heading + bearing) * (Math.PI / 180);
        const x = state.player.position.x + Math.sin(heading) * distance * share;
        const z = state.player.position.z - Math.cos(heading) * distance * share;
        const centre = ground(x, z);
        let spread = 0;
        for (let sample = 0; sample < 8; sample++) {
          const angle = (sample / 8) * Math.PI * 2;
          spread = Math.max(spread, Math.abs(ground(x + Math.sin(angle) * reach, z - Math.cos(angle) * reach) - centre));
        }
        if (!best || spread < best.spread) best = { x, y: centre, z, spread };
      }
    }
    return best;
  }

  const api = {
    results: helpers.results,
    /** Adds the kit's presets through the dev hook. */
    setup() {
      const added = [];
      for (const preset of createStructureTestPresets()) {
        if (manager.getPreset(preset.id)) continue;
        added.push(system.debug.addPreset(preset));
      }
      return check('kit presets added through the dev hook', manager.getPreset('devWindFarm') !== null, added.join(', '));
    },
    /**
     * Spawns presetId on open ground ahead of the craft (the craft first flies back to the start, so
     * every structure stands in the same country), frames it from `view` { distance, height, bearing,
     * lift, spawnDistance, reach } and records GPU memory before and after the create.
     */
    async show(presetId, view = {}) {
      const { distance = 700, height = 140, bearing = 25, lift = 30, spawnDistance = 1200, reach = 300 } = view;
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: state.spawn.x, y: state.spawn.y + 120, z: state.spawn.z, heading: state.spawn.heading });
      await frames(3);
      const anchor = openGroundAhead(spawnDistance, reach);
      const heading = state.player.heading;
      const target = { x: anchor.x, y: anchor.y + lift, z: anchor.z };
      const settled = await frameView(viewpoint(target, distance, height, heading + 180 + bearing), target);
      const idle = await terrainIdle();
      const before = memory();
      const id = manager.activate(presetId, { position: anchor, heading, source: 'debug', force: true });
      await frames(12);
      const during = memory();
      spawned.set(presetId, { id, before, during, idle });
      // The terrain settling is reported, not judged: under heavy machine load it can take minutes.
      return check(`${presetId}: spawned`, Boolean(id) && during.geometries > before.geometries, { id, terrainSettled: settled, terrainIdle: idle, tier: id ? manager.getInstance(id).tier : null, geometriesAdded: during.geometries - before.geometries, engine: manager.getStats().engines.structure });
    },
    /** Ends presetId's spawn: GPU memory back to its level before the create, wind sources removed. */
    async end(presetId) {
      const record = spawned.get(presetId);
      if (!record) return check(`${presetId}: ended`, false, 'never spawned');
      const windBefore = ctx.wind.sourceCount;
      const instance = manager.getParts(record.id)[0];
      const ownSources = instance ? instance.windSourceIds.length : 0;
      manager.deactivate(record.id, 'test');
      await frames(4);
      const after = memory();
      spawned.delete(presetId);
      return check(`${presetId}: dispose returns GPU memory and removes its wind sources`,
        after.geometries - record.before.geometries === after.terrainMeshes - record.before.terrainMeshes && after.textures === record.before.textures && ctx.wind.sourceCount === windBefore - ownSources && record.during.geometries > record.before.geometries,
        { terrainIdle: record.idle, before: record.before, during: record.during, after, windSources: `${windBefore} -> ${ctx.wind.sourceCount} (own ${ownSources})`, leaks: manager.getStats().leaks });
    },
    /** Sets the time of day (0..1) at once. */
    setTime(dayTime) {
      ctx.systems.sky.setDayTime(dayTime, { transition: 0 });
      return `dayTime ${dayTime}`;
    },
    /** Moves the craft under the rope bridge and expects the bridge's gate and its achievement. */
    async gateUnderBridge() {
      const record = spawned.get('devRopeBridge');
      if (!record) return check('bridge gate', false, 'no bridge');
      const instance = manager.getParts(record.id)[0];
      const events = [];
      const off = ctx.bus.on('structure:gate', (payload) => events.push(payload));
      const achievements = [];
      const offAchievement = ctx.bus.onTyped('achievement', (payload) => achievements.push(payload));
      await flyThroughGate(instance.data.gates.data, 0);
      off();
      offAchievement();
      return check('flying under the bridge fires its gate and achievement', events.length === 1 && events[0].kind === 'under' && achievements.length === 1, { events, achievements });
    },
    /** The structure engine's stats as the debugger shows them. */
    stats() {
      return manager.getStats().engines.structure;
    },
    finish: helpers.finish,
  };
  window.__dwStructure = api;
  return api;
}

/**
 * Installs window.__dwSites on V2 opened with ?test=sites (tools/steps/engine-structure-sites.json):
 * the structure fixtures of the terrain test (airfield, rope bridge, floating islands, canyon run) on
 * their REAL stamped sites, through the site feed. Checks each build against its stamp: the runway
 * zone is the flatten strip and offers ground starts, the bridge gate spans the gorge under the deck
 * (and fires), the island tops are extra ground surfaces, the course gates span the canyon ends.
 */
export function installSiteChecks(game) {
  const helpers = createBrowserHelpers(game, 'sites');
  const { ctx, check, viewpoint, frameView, terrainIdle, flyThroughGate } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const found = new Map();

  function nearestSite(presetId) {
    return ctx.world.sitesNear(state.spawn.x, state.spawn.z, 60000).find((site) => site.presetId === presetId) ?? null;
  }

  /** Activates the site's spawn (the feed may already have) and returns its engine instance. */
  function siteInstance(site) {
    const id = manager.activate(site.presetId, { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
    return id ? { id, instance: manager.getParts(id)[0] } : null;
  }

  const api = {
    results: helpers.results,
    /** Adds the fixtures whose engines are all registered (the structure ones). */
    async setup() {
      const { TERRAIN_FIXTURES } = await import('./terrainFixtures.js');
      const registered = manager.registry.names();
      const added = [];
      for (const preset of TERRAIN_FIXTURES) {
        if (!preset.engines.every((entry) => registered.includes(entry.engine)) || manager.getPreset(preset.id)) continue;
        added.push(system.debug.addPreset(preset));
        const site = nearestSite(preset.id);
        if (site) found.set(preset.id, site);
      }
      return check('structure fixtures added; their stamped sites found', added.length === 4 && found.size === 4, { added, sites: [...found.values()].map((site) => site.id) });
    },
    /** Frames the site of presetId from `view` { distance, height, bearing, lift }. */
    async show(presetId, view = {}) {
      const site = found.get(presetId);
      if (!site) return check(`${presetId}: site`, false, 'not found');
      const { distance = 800, height = 160, bearing = 200, lift = 20 } = view;
      let target = { x: site.x, y: site.groundY + lift, z: site.z };
      const spawn = siteInstance(site);
      const stamp = site.stamps[0];
      if (presetId === 'fixtureRopeBridge') target = { x: stamp.x, y: stamp.rimY + lift, z: stamp.z };
      if (presetId === 'fixtureSlotCanyon') target = { x: stamp.entry.x, y: stamp.entry.rimY + lift, z: stamp.entry.z };
      if (presetId === 'fixtureFloatingIslands' && spawn) {
        const own = ctx.groundSurfaces.list().filter((surface) => spawn.instance.data.surfaceIds.includes(surface.id));
        if (own.length > 0) target = { x: (own[0].minX + own[0].maxX) / 2, y: own[0].top - 40, z: (own[0].minZ + own[0].maxZ) / 2 };
      }
      const settled = await frameView(viewpoint(target, distance, height, bearing + (site.rotation * 180) / Math.PI), target);
      await terrainIdle();
      return check(`${presetId}: built on its site`, Boolean(spawn), { siteId: site.id, spawn: spawn ? spawn.id : null, terrainSettled: settled });
    },
    /** The recipe's own proofs against its stamp. */
    async prove(presetId) {
      const site = found.get(presetId);
      const spawn = site ? siteInstance(site) : null;
      if (!spawn) return check(`${presetId}: proofs`, false, 'no spawn');
      const { instance } = spawn;
      const data = instance.data;
      const stamp = site.stamps[0];
      if (presetId === 'fixtureAirfield') {
        const zone = data.zones[0];
        const onStamp = Math.hypot(zone.x - stamp.x, zone.z - stamp.z) < 0.01 && Math.abs(zone.halfLength * 2 - stamp.length) < 0.01 && Math.abs(zone.y - stamp.y) < 0.01;
        manager.markDiscovered([site.id]);
        const start = system.findGroundStart(state.spawn.x, state.spawn.z);
        return check('airfield: the runway zone is the flatten strip, and a discovered airfield offers its ground start', onStamp && start !== null && start.siteId === site.id && Math.abs(start.y - stamp.y) < 0.01, { zone: { length: zone.halfLength * 2, y: zone.y }, stamp: { length: stamp.length, y: stamp.y }, start });
      }
      if (presetId === 'fixtureRopeBridge') {
        const gates = data.gates.data;
        const spans = gates[5] < stamp.floorY && gates[6] < stamp.rimY && gates[6] > stamp.floorY + 20;
        const events = [];
        const off = ctx.bus.on('structure:gate', (payload) => events.push(payload));
        await flyThroughGate(gates, 0);
        off();
        return check('rope bridge: the gate spans the gorge under the deck and fires', spans && events.length === 1, { floorY: stamp.floorY, rimY: stamp.rimY, gate: [gates[5], gates[6]], events: events.length });
      }
      if (presetId === 'fixtureFloatingIslands') {
        // Other island sites the feed has built nearby register their own tops too: look at this one's.
        const surfaces = ctx.groundSurfaces.list();
        const own = surfaces.filter((surface) => data.surfaceIds.includes(surface.id));
        const top = own[0];
        const x = top ? (top.minX + top.maxX) / 2 : 0;
        const z = top ? (top.minZ + top.maxZ) / 2 : 0;
        const standing = ctx.groundSurfaces.surfaceBelow(x, z, Infinity);
        const under = ctx.groundSurfaces.surfaceBelow(x, z, standing - 50);
        return check('floating islands: the tops are extra ground surfaces a craft stands on and flies under', own.length === data.surfaceIds.length && own.length > 0 && standing > ctx.world.groundHeight(x, z) + 50 && under === -Infinity, { own: own.length, all: surfaces.length, standing, terrain: ctx.world.groundHeight(x, z) });
      }
      const gates = data.gates.data;
      const entry = stamp.entry;
      const exit = stamp.exit;
      return check('canyon course: start and finish gates span the carve ends', data.gates.count === 2 && Math.hypot(gates[0] - entry.x, gates[1] - entry.z) < 0.01 && Math.hypot(gates[8] - exit.x, gates[9] - exit.z) < 0.01, { entry, exit });
    },
    finish: helpers.finish,
  };
  window.__dwSites = api;
  return api;
}

