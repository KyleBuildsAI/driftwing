// Dev-only checks for the game's real spawn presets (Phase 2 Milestone E). installPresetChecks(game)
// puts window.__dwPresets on a running V2 on a dev server; tools/steps/presets-21-30.json drives it.
// For each preset it:
//   - sets the time of day and the regional weather the preset belongs to;
//   - force-spawns it ahead of the craft through the director's debug path (spawns.forceSpawn);
//   - frames it for a screenshot (photo mode, the free camera on its anchor, or on its part of the sky);
//   - waits for its discovery: the typed discovery event, the journal entry and the journal's
//     'journal:discovery' (the glass discovery card follows it);
//   - after dispose, proves GPU memory back to its level (the geometry tracker tells the world's first
//     draws, a terrain chunk or a landmark, from anything a spawn left behind), the wind sources and
//     the sky modifiers back to their counts, and no leaks reported by the SpawnManager.
// Site presets are also shown on their REAL stamped sites from the site feed, and their placement is
// checked against a freshly built world (the same site-list hash twice).
//
// A set piece's child presets that are not in this tree yet (the storm chase's supercell and tornado
// before the batch 1 presets are merged) get dev stand-ins through the dev hook, only when missing.
//
// Every failed check calls console.error, so the smoke run fails. Never part of a production build:
// only dev-server step files import it.
import { createBrowserHelpers } from './structureTestKit.js';
import { createGeometryTracker, splitFresh } from './geometryTracker.js';
import { createWorldGen } from '../world/worldgen.js';
import { hashSiteList } from '../world/placement.js';

/**
 * Owner-name prefixes of pooled meshes that carry per-instance geometry (the structure engine's mesh
 * pools): a geometry still alive under one after dispose is a leak. Every other engine draws its
 * spawns in fixed shared buffers, and an object an engine adds to the scene during create, update,
 * setLOD or dispose is attributed to the spawns by the tracker itself.
 */
const SPAWN_OWNERS = Object.freeze(['structure-']);
const STAND_IN_CALLOUTS = Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Dev stand-in: {name}.']);

/** Dev stand-ins for child presets a set piece names that are not in this tree yet. */
function standInPreset(id) {
  const base = {
    id,
    kind: 'event',
    candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 900, chance: 0.1 }),
    filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
    discovery: Object.freeze({ radius: 6000, requireInView: true }),
    callouts: STAND_IN_CALLOUTS,
    wind: Object.freeze([]),
  };
  if (id === 'supercell') {
    return Object.freeze({
      ...base,
      name: 'Supercell (dev stand-in)',
      category: 'weather',
      rarity: 'uncommon',
      heavy: true,
      engines: Object.freeze([
        Object.freeze({ engine: 'weatherVolume', params: Object.freeze({ form: 'tower', base: 900, height: 9000, radius: 2600, storm: 0.7, anvil: Object.freeze({ radius: 8500, thickness: 1500, lean: 2600 }), overshoot: 0.6, rain: Object.freeze([Object.freeze({ offset: Object.freeze([700, 1400]), radius: 1500, density: 0.8, downdraft: 6, outflow: 10 })]), wind: Object.freeze({ updraft: 6, turbulence: 0.5 }) }) }),
        Object.freeze({ engine: 'lightEffect', params: Object.freeze({ lightning: Object.freeze({ rate: 8, radius: 4000, cloudBase: 1500, groundShare: 0.6, branches: 8, flash: 0.7 }), visibility: Object.freeze({ day: 1, night: 1 }) }) }),
      ]),
      lod: Object.freeze({ near: 6000, mid: 22000, far: 60000 }),
      lure: Object.freeze({ type: 'anvil', height: 9000, width: 17000, color: 0x6f7682 }),
      audio: null,
      journal: Object.freeze({ title: 'Supercell (dev stand-in)', description: 'A dev stand-in until the batch 1 presets are merged.' }),
      lifetime: Object.freeze({ duration: Object.freeze([300, 480]), despawn: Object.freeze({ distance: 30000, hysteresis: 5000, outOfViewSeconds: 30 }) }),
    });
  }
  if (id === 'tornado') {
    return Object.freeze({
      ...base,
      name: 'Tornado (dev stand-in)',
      category: 'weather',
      rarity: 'rare',
      heavy: true,
      engines: Object.freeze([Object.freeze({ engine: 'vortex', params: Object.freeze({ trackSpeed: 9 }) })]),
      lod: Object.freeze({ near: 2500, mid: 8000, far: 40000 }),
      lure: Object.freeze({ type: 'funnel', height: 1800, width: 500, color: 0x5a5f6a }),
      audio: Object.freeze({ recipe: 'tornado', params: Object.freeze({}) }),
      journal: Object.freeze({ title: 'Tornado (dev stand-in)', description: 'A dev stand-in until the batch 1 presets are merged.' }),
      lifetime: Object.freeze({ duration: Object.freeze([240, 360]), despawn: Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 }) }),
    });
  }
  return null;
}

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

/** Resolves after `ms` of wall time, while the frames keep running. */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function installPresetChecks(game) {
  const helpers = createBrowserHelpers(game, 'presets');
  const { ctx, THREE, check, viewpoint, frameView, terrainIdle } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const tracker = createGeometryTracker(ctx.renderer, ctx.scene);
  const spawned = new Map();
  const discoveries = [];
  const journalCards = [];
  ctx.bus.onTyped('discovery', (payload) => discoveries.push(payload));
  ctx.bus.on('journal:discovery', (payload) => journalCards.push(payload));
  const journalStats = [];
  ctx.bus.onTyped('journalStat', (payload) => journalStats.push(payload));
  // The day clock is held while the checks run (a night lasts seconds at the default day length), and
  // given back by finish().
  const timeFrozenBefore = ctx.settings.get('timeFrozen');

  function memory() {
    const info = ctx.renderer.info.memory;
    return { geometries: info.geometries, textures: info.textures };
  }
  /**
   * Waits (up to 30 s) for two full sweeps of the site feed, so every site within range of where the
   * craft now is has been built before a memory baseline (a site the craft left behind earlier is
   * rebuilt as it comes back, and that is the world's, not the spawn under test's).
   */
  async function siteSweeps() {
    const feed = () => manager.getStats().siteFeed;
    const start = feed() ? feed().sweeps : 0;
    const started = performance.now();
    while (feed() && feed().sweeps < start + 2 && performance.now() - started < 30000) await frames(5);
  }

  /** The live anchor of a spawn: its first part's (the SpawnManager's LOD, lure and discovery read it). */
  function anchorOfSpawn(spawnId) {
    const parts = spawnId ? manager.getParts(spawnId) : [];
    return parts.length > 0 ? parts[0].anchor : null;
  }
  function anchorOf(record) {
    return anchorOfSpawn(record.id);
  }
  function partsOf(record) {
    return manager.getParts(record.id) ?? [];
  }
  /** What each part's engine reports about it (describe, where the engine has one). */
  function describeParts(record) {
    return partsOf(record).map((part) => {
      const engine = manager.registry.get(part.engine);
      let described = null;
      if (engine && typeof engine.describe === 'function') {
        try {
          described = engine.describe(part.engine === 'fauna' ? part.id : part);
        } catch (error) {
          described = `describe failed: ${error && error.message}`;
        }
      }
      return { engine: part.engine, tier: part.tier, particles: part.particles, lights: part.lights, windSources: part.windSourceIds.length, described };
    });
  }

  const api = {
    results: helpers.results,

    /** Attributes the engines for the memory checks and adds dev stand-ins for missing set-piece children. */
    setup() {
      if (tracker) tracker.attribute(manager.registry.names().map((name) => manager.registry.get(name)));
      const added = [];
      for (const preset of manager.listPresets()) {
        for (const entry of preset.engines) {
          if (entry.engine !== 'setPiece') continue;
          for (const child of Object.values(entry.params.children)) {
            if (manager.getPreset(child.preset)) continue;
            const standIn = standInPreset(child.preset);
            if (standIn) added.push(system.debug.addPreset(standIn));
          }
        }
      }
      return check('setup: engines attributed, set-piece children present', manager.listPresets().every((preset) => preset.engines.every((entry) => entry.engine !== 'setPiece' || Object.values(entry.params.children).every((child) => manager.getPreset(child.preset)))), { tracked: tracker !== null, standIns: added, presets: manager.listPresets().length });
    },

    /** The time of day (sun elevation in degrees, morning or evening, held there) and the regional weather. */
    async conditions({ sun = 20, morning = false, weather = 'clear' } = {}) {
      ctx.settings.set('timeFrozen', true);
      ctx.systems.weather.forceState(weather, 0.5);
      ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(sun, !morning), { transition: 0 });
      await frames(8);
      return `sun ${sun} deg (${morning ? 'morning' : 'evening'}), weather ${weather}`;
    },

    /**
     * Force-spawns presetId `distance` m ahead of the craft (back at the start, 120 m up, so every
     * preset is seen over the same country), records the GPU memory, wind sources and sky modifiers
     * before it, then lets the simulation run `runSeconds` (fades, first meteors, a whale swimming in).
     */
    async start(presetId, { distance = 1500, runSeconds = 2, altitude = 120 } = {}) {
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: state.spawn.x, y: state.spawn.y + altitude, z: state.spawn.z, heading: state.spawn.heading });
      await frames(3);
      const idle = await terrainIdle();
      await siteSweeps();
      const record = {
        presetId,
        id: null,
        idle,
        before: memory(),
        windBefore: ctx.wind.sourceCount,
        skyBefore: ctx.systems.sky.getModifierState().count,
        leaksBefore: { ...manager.getStats().leaks },
        discoveriesBefore: discoveries.length,
        cardsBefore: journalCards.length,
      };
      if (tracker) tracker.start();
      record.id = system.forceSpawn(presetId, { distance, force: true });
      spawned.set(presetId, record);
      await wait(runSeconds * 1000);
      record.during = memory();
      const instance = record.id ? manager.getInstance(record.id) : null;
      return check(`${presetId}: force-spawned ${distance} m ahead`, Boolean(instance), { id: record.id, terrainIdle: idle, tier: instance ? instance.tier : null, parts: record.id ? describeParts(record) : null });
    },

    /**
     * Frames presetId's spawn in photo mode. view.mode 'sky' looks from the craft toward the spawn's
     * sky anchor (a celestial event); 'world' frames target (the anchor plus lift, or `offset`
     * [right, up, forward] in the activation heading's frame) from `distance` and `height` at `bearing`
     * degrees from the craft's heading (180 looks back at it from beyond).
     */
    async frame(presetId, view = {}) {
      const record = spawned.get(presetId);
      let anchor = record ? anchorOf(record) : null;
      if (anchor && view.child) {
        // A set piece's child (the storm chase's tornado): frame its own anchor.
        const child = api.setPieceState(presetId).children.find((entry) => entry.key === view.child);
        anchor = child ? anchorOfSpawn(child.id) : null;
      }
      if (!anchor) return check(`${presetId}: framed`, false, 'no live spawn');
      const { mode = 'world', distance = 900, height = 160, bearing = 200, lift = 40, offset = null, lookUp = 0, meteors = 0 } = view;
      if (mode === 'sky') {
        // Photo mode freezes the sky: wait (up to 20 s) for meteors in flight, so the still shows some.
        const celestial = partsOf(record).find((part) => part.engine === 'celestial');
        const engine = manager.registry.get('celestial');
        const started = performance.now();
        while (meteors > 0 && celestial && engine.describe(celestial).meteorsActive < meteors && performance.now() - started < 20000) await frames(1);
        ctx.setPhotoMode(true);
        await frames(2);
        const player = state.player.position;
        const position = new THREE.Vector3(player.x, player.y + 30, player.z);
        const target = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
        if (lookUp !== 0) target.y += lookUp;
        ctx.systems.camera.setFreeCameraPose({ position, target });
        await frames(30);
        return check(`${presetId}: framed in its part of the sky`, true, { anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y), z: Math.round(anchor.z) }, parts: describeParts(record) });
      }
      const heading = (state.player.heading * Math.PI) / 180;
      let target = { x: anchor.x, y: anchor.y + lift, z: anchor.z };
      if (offset) {
        const [right, up, forward] = offset;
        target = {
          x: anchor.x + Math.cos(heading) * right + Math.sin(heading) * forward,
          y: anchor.y + up,
          z: anchor.z + Math.sin(heading) * right - Math.cos(heading) * forward,
        };
      }
      const settled = await frameView(viewpoint(target, distance, height, state.player.heading + bearing), target);
      await frames(20);
      return check(`${presetId}: framed`, true, { terrainSettled: settled, target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) }, parts: describeParts(record) });
    },

    /** Waits (up to `seconds`) for presetId's discovery: the typed event, the journal entry and its card. */
    async discovered(presetId, { seconds = 20 } = {}) {
      const record = spawned.get(presetId);
      const since = record ? record.discoveriesBefore : 0;
      const cardsSince = record ? record.cardsBefore : 0;
      const started = performance.now();
      let event = null;
      while (performance.now() - started < seconds * 1000) {
        event = discoveries.slice(since).find((payload) => payload.presetId === presetId) ?? null;
        if (event && journalCards.slice(cardsSince).some((card) => card.entry && card.entry.id === event.id)) break;
        await frames(5);
      }
      const journal = ctx.systems.journal;
      const card = event ? journalCards.slice(cardsSince).find((entry) => entry.entry && entry.entry.id === event.id) : null;
      const inJournal = event ? journal.hasDiscovered(event.id) : false;
      return check(`${presetId}: discovered (toast and journal entry)`, Boolean(event && card && inJournal), {
        event: event ? { id: event.id, name: event.name, kind: event.kind } : null,
        journal: card ? { name: card.entry.name, description: card.entry.description, found: card.found, total: card.total } : null,
      });
    },

    /**
     * untilDawn: puts the sun `elevation` degrees up on the morning side after the night the spawn has
     * seen, runs the simulation a moment and expects the celestial part to have reached its dawn (its
     * duration cut to its fade-out).
     */
    async dawn(presetId, elevation = 2) {
      const record = spawned.get(presetId);
      const part = record ? partsOf(record).find((candidate) => candidate.engine === 'celestial') : null;
      if (!part) return check(`${presetId}: dawn`, false, 'no celestial part');
      ctx.setPhotoMode(false);
      ctx.systems.sky.setDayTime(ctx.util.dayTimeForSunElevation(elevation, false), { transition: 0 });
      await wait(1500);
      const described = manager.registry.get('celestial').describe(part);
      return check(`${presetId}: the night ends at dawn`, described.dawnReached === true && Number.isFinite(described.duration), { dawnReached: described.dawnReached, duration: described.duration, presence: described.presence });
    },

    /**
     * A graded landing on the nearest real site's runway: the craft is placed rolling down the runway,
     * a smooth touchdown 300 m past the threshold on the centreline is announced (the typed 'landed'),
     * and the structure engine must grade it (structure:landing, a good score).
     */
    async landing(presetId) {
      const site = manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, 90000);
      const spawnId = site ? manager.getSiteSpawn(site.id) : null;
      const part = spawnId ? (manager.getParts(spawnId) ?? []).find((entry) => entry.engine === 'structure') : null;
      const zone = part && part.data.zones ? part.data.zones.find((entry) => entry.graded) : null;
      if (!zone) return check(`${presetId}: graded landing`, false, 'no graded runway on a live site');
      const graded = [];
      const off = ctx.bus.on('structure:landing', (payload) => graded.push(payload));
      ctx.setPhotoMode(false);
      const along = 300 - zone.halfLength;
      const x = zone.x + zone.dirX * along;
      const z = zone.z + zone.dirZ * along;
      const heading = (Math.atan2(zone.dirX, -zone.dirZ) * 180) / Math.PI;
      ctx.systems.flight.resetTo({ x, y: zone.y + 2, z, heading });
      await frames(3);
      ctx.bus.emitTyped('landed', { grade: 'smooth', craft: 'glider', sinkRate: 1.1, groundSpeed: 26, position: { x, y: zone.y, z } });
      await frames(3);
      off();
      const result = graded.find((entry) => entry.spawnId === spawnId) ?? null;
      return check(`${presetId}: landings on its runway are graded`, Boolean(result) && result.score >= 70 && Math.abs(result.fromThreshold - 300) < 2, result);
    },

    /** "Start on ground": the nearest discovered site with a ground-start spot (an airfield's threshold). */
    groundStart(presetId) {
      const spot = system.findGroundStart(state.spawn.x, state.spawn.z);
      return check(`${presetId}: start on ground prefers the discovered site`, Boolean(spot) && spot.presetId === presetId, spot);
    },

    /** The typed journalStat events a preset sent, each key expected once. */
    journalStats(presetId, keys) {
      const sent = journalStats.filter((stat) => stat.presetId === presetId);
      return check(`${presetId}: journal statistics sent (${keys.join(', ')})`, keys.every((key) => sent.some((stat) => stat.key === key)), sent);
    },

    /**
     * Grows a set piece child's weather volumes to `growth` (0..1) at once: the supercell's build takes
     * three minutes of real time, which the still of its lowering wall cloud does not wait for.
     */
    growChild(presetId, childKey, growth) {
      const child = api.setPieceState(presetId).children.find((entry) => entry.key === childKey);
      const parts = child && child.id ? manager.getParts(child.id) : [];
      let grown = 0;
      for (const part of parts) {
        if (part.engine !== 'weatherVolume') continue;
        part.data.growth = growth;
        grown++;
      }
      return check(`${presetId}: ${childKey} grown to ${growth}`, grown > 0, { grown });
    },

    /** Moves a celestial spawn's presence ramps on by `seconds` (a comet's slow fade-in). */
    fastForward(presetId, seconds) {
      const record = spawned.get(presetId);
      for (const part of record ? partsOf(record) : []) {
        if (part.engine === 'celestial' && Number.isFinite(part.data.startTime)) part.data.startTime -= seconds;
      }
      return `${presetId}: ${seconds} s on`;
    },

    /**
     * Puts an eclipse spawn's crossing at `separation` sun radii from the centre (0: totality) and
     * frames the sun. Returns the eclipse state with the sky and the bird checks.
     */
    async eclipseAt(presetId, separation) {
      const record = spawned.get(presetId);
      const part = record ? partsOf(record).find((candidate) => candidate.engine === 'celestial') : null;
      if (!part) return check(`${presetId}: eclipse`, false, 'no celestial part');
      const data = part.data;
      const params = data.params.eclipse;
      const lead = (data.duration - params.crossingSeconds) * 0.5;
      const magnitude = Math.pow(Math.max(0, separation) / 2.3, 1 / data.eclipsePower);
      data.startTime = ctx.state.time.elapsed - (lead + params.crossingSeconds * (1 - magnitude) * 0.5);
      ctx.setPhotoMode(true);
      const player = state.player.position;
      const position = new THREE.Vector3(player.x, player.y + 30, player.z);
      const sun = ctx.state.time.sunDirection;
      ctx.systems.camera.setFreeCameraPose({ position, target: new THREE.Vector3(position.x + sun.x * 1000, position.y + sun.y * 1000, position.z + sun.z * 1000) });
      await frames(40);
      const engine = manager.registry.get('celestial');
      const described = engine.describe(part);
      const sky = ctx.systems.sky.getModifierState();
      const birds = ctx.systems.birds && typeof ctx.systems.birds.getStats === 'function' ? ctx.systems.birds.getStats() : null;
      const totality = separation === 0;
      return check(`${presetId}: eclipse at ${separation} sun radii`, totality ? described.eclipse.uncovered < 0.05 && sky.darkness > 0.5 && sky.stars > 0.5 && described.eclipse.quiet : described.eclipse.uncovered > 0.1, { eclipse: described.eclipse, sky: { darkness: sky.darkness, stars: sky.stars, sunIntensity: sky.sunIntensity }, birdsQuiet: birds ? birds.quiet : null });
    },

    /** Skips a set piece's current stage (its clock jumps to the stage's end; the simulation must run). */
    async skipStage(presetId) {
      const record = spawned.get(presetId);
      const part = record ? partsOf(record).find((candidate) => candidate.engine === 'setPiece') : null;
      if (!part) return check(`${presetId}: skip stage`, false, 'no set piece');
      ctx.setPhotoMode(false);
      const data = part.data;
      const stage = data.plan.stages[data.stageIndex];
      const from = stage ? stage.id : null;
      if (stage && Number.isFinite(stage.duration)) data.stageClock[0] = Math.max(data.stageClock[0], stage.duration - 0.05);
      // Wait (up to 10 s) for the timeline to leave the stage: a slow frame may not have run it yet.
      const engine = manager.registry.get('setPiece');
      const started = performance.now();
      await frames(2);
      while (performance.now() - started < 10000 && !data.finished && engine.describe(part).stage === from) await frames(2);
      return `${presetId}: ${from} -> ${data.finished ? 'finished' : engine.describe(part).stage}`;
    },

    /** The set piece's timeline and its children (describe), with the journal statistics sent so far. */
    setPieceState(presetId) {
      const record = spawned.get(presetId);
      const part = record ? partsOf(record).find((candidate) => candidate.engine === 'setPiece') : null;
      if (!part) return { error: 'no set piece' };
      const described = manager.registry.get('setPiece').describe(part);
      const children = described.children.map((child) => {
        const parts = child.id ? manager.getParts(child.id) ?? [] : [];
        return { ...child, control: parts.map((entry) => (entry.control ? { engine: entry.engine, ...entry.control } : null)).filter(Boolean) };
      });
      return { ...described, children, journalStats: journalStats.filter((stat) => stat.presetId === presetId) };
    },

    /**
     * Flies the craft (out of photo mode) to `distance` m from a set piece child's anchor and parks
     * it there `seconds` (the closest-distance record measures it).
     */
    async approachChild(presetId, childKey, { distance = 2500, seconds = 3 } = {}) {
      const state1 = api.setPieceState(presetId);
      const child = state1.children ? state1.children.find((entry) => entry.key === childKey) : null;
      const anchor = child ? anchorOfSpawn(child.id) : null;
      if (!anchor) return check(`${presetId}: approach ${childKey}`, false, 'child not running');
      ctx.setPhotoMode(false);
      const heading = state.player.heading * (Math.PI / 180);
      const x = anchor.x - Math.sin(heading) * distance;
      const z = anchor.z + Math.cos(heading) * distance;
      ctx.systems.flight.resetTo({ x, y: Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL) + 300, z, heading: state.player.heading });
      await wait(seconds * 1000);
      return check(`${presetId}: craft ${distance} m from the ${childKey}`, true, api.setPieceState(presetId).records);
    },

    /** Ends presetId's spawn: GPU memory, wind sources and sky modifiers back to their levels, no leaks. */
    async end(presetId) {
      const record = spawned.get(presetId);
      if (!record) return check(`${presetId}: ended`, false, 'never spawned');
      const active = manager.getInstance(record.id) !== null;
      if (active) manager.deactivate(record.id, 'test');
      ctx.setPhotoMode(false);
      await frames(8);
      const after = memory();
      spawned.delete(presetId);
      const fresh = tracker ? tracker.stop() : [];
      const split = splitFresh(fresh, SPAWN_OWNERS);
      // Geometries a LIVE structure spawn still shows are not this disposed spawn's (a site the site feed
      // built meanwhile, as the camera moved); and a structure geometry can only be this preset's when it
      // has a structure part.
      const held = new Set();
      for (const spawn of manager.getActive()) {
        for (const part of manager.getParts(spawn.id)) {
          if (part.engine !== 'structure' || !part.data.meshes) continue;
          for (const mesh of Object.values(part.data.meshes)) if (mesh && mesh.geometry) held.add(mesh.geometry.uuid);
        }
      }
      const ownsStructure = (manager.getPreset(presetId)?.engines ?? []).some((entry) => entry.engine === 'structure');
      const leftBehind = split.leftBehind.filter((entry) => !held.has(entry.uuid) && (ownsStructure || !entry.owner.startsWith('structure-')));
      const worldFresh = split.world + (split.leftBehind.length - leftBehind.length);
      const leaks = manager.getStats().leaks;
      const windAfter = ctx.wind.sourceCount;
      const skyAfter = ctx.systems.sky.getModifierState().count;
      // The count may also drop by what the world freed meanwhile (a far site the craft left behind is
      // removed with its geometry); a spawn's leftovers show as leftBehind or as a count above the
      // world's first draws.
      const ok = leftBehind.length === 0 && after.geometries - record.before.geometries <= worldFresh && after.textures === record.before.textures
        && windAfter === record.windBefore && skyAfter === record.skyBefore
        && leaks.windSources === record.leaksBefore.windSources && leaks.lights === record.leaksBefore.lights;
      return check(`${presetId}: dispose returns GPU memory, removes its wind sources and sky modifiers`, ok, {
        endedNaturally: !active, before: record.before, during: record.during, after, worldFirstDrawn: worldFresh, leftBehind,
        windSources: `${record.windBefore} -> ${windAfter}`, skyModifiers: `${record.skyBefore} -> ${skyAfter}`, leaks,
      });
    },

    /**
     * A site preset on its nearest REAL site (the site feed's placement, with its stamps): the craft
     * flies there, the SpawnManager builds the site as the craft nears it, and the view frames it.
     * Also checks the site list against a freshly built world (the same hash) and that the site
     * carries every stamp its preset lists.
     */
    async site(presetId, view = {}) {
      const preset = manager.getPreset(presetId);
      const site = manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, 90000);
      if (!preset || !site) return check(`${presetId}: real site`, false, 'no site within 90 km of the start');
      const { distance = 900, height = 180, bearing = 200, lift = 30 } = view;
      const sinceDiscoveries = discoveries.length;
      const sinceCards = journalCards.length;
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: site.x - 600, y: site.groundY + 300, z: site.z - 600, heading: 135 });
      let spawnId = null;
      const started = performance.now();
      while (!spawnId && performance.now() - started < 60000) {
        await frames(5);
        spawnId = manager.getSiteSpawn(site.id);
      }
      let target = { x: site.x, y: site.groundY + lift, z: site.z };
      if (spawnId && Number.isFinite(view.surfaceTop)) {
        const parts = manager.getParts(spawnId) ?? [];
        const ids = parts.length > 0 && parts[0].data.surfaceIds ? parts[0].data.surfaceIds : [];
        const own = ctx.groundSurfaces.list().filter((surface) => ids.includes(surface.id));
        if (own.length > 0) target = { x: (own[0].minX + own[0].maxX) / 2, y: own[0].top + view.surfaceTop, z: (own[0].minZ + own[0].maxZ) / 2 };
      }
      const settled = await frameView(viewpoint(target, distance, height, bearing + (site.rotation * 180) / Math.PI), target);
      await terrainIdle();
      const radius = 30000;
      const live = hashSiteList(ctx.world.sitesNear(state.spawn.x, state.spawn.z, radius));
      const fresh = createWorldGen(state.seed, ctx.worldOptions);
      const rebuilt = hashSiteList(fresh.sitesNear(state.spawn.x, state.spawn.z, radius));
      const rebuiltAgain = hashSiteList(fresh.sitesNear(state.spawn.x, state.spawn.z, radius));
      const stampsOk = site.stamps.length === (preset.stamps ?? []).length;
      let discovery = null;
      const waitStarted = performance.now();
      while (performance.now() - waitStarted < 20000) {
        discovery = discoveries.slice(sinceDiscoveries).find((payload) => payload.id === site.id) ?? null;
        if (discovery && journalCards.slice(sinceCards).some((card) => card.entry && card.entry.id === site.id)) break;
        await frames(5);
      }
      const inJournal = ctx.systems.journal.hasDiscovered(site.id);
      return check(`${presetId}: built on its real site, placed deterministically, discovered`, Boolean(spawnId) && stampsOk && live === rebuilt && rebuilt === rebuiltAgain && Boolean(discovery) && inJournal, {
        site: { id: site.id, x: Math.round(site.x), z: Math.round(site.z), groundY: Math.round(site.groundY), stamps: site.stamps.map((stamp) => stamp.type) },
        spawnId, terrainSettled: settled, siteListHash: { live, rebuilt, rebuiltAgain }, discovered: discovery ? discovery.name : null, inJournal,
        parts: spawnId ? describeParts({ id: spawnId }) : null,
      });
    },

    /** The summary check; puts the renderer's geometry manager back. */
    finish() {
      if (tracker) tracker.restore();
      ctx.systems.weather.forceState(null);
      ctx.settings.set('timeFrozen', timeFrozenBefore);
      return helpers.finish();
    },
  };
  window.__dwPresets = api;
  return api;
}
