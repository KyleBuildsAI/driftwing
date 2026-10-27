// Dev-only checks for presets 41-50 (the ocean set and the first wildlife presets), driven by
// tools/steps/presets-41-50.json on a dev server (it imports this module by URL; never part of a
// production build). installPresetChecks41(game) puts window.__dwPresets41 on a running V2.
//
// The game's own presets are held out of the SpawnManager for the whole run (spawns.debug.
// holdGamePresets: the director's own events never move a baseline); each check puts back only the
// preset it shows and removes it again after. Per preset:
//   - sites (the calving glacier, the coral atoll, the reef shipwreck, the sea stacks, the tidal bore,
//     the flamingo lake) on their REAL placed sites (the step file's seed holds all six within 40 km
//     of the start): built by the site feed as the craft nears, every stamp of the preset on the site,
//     discovered (the typed event, the journal entry and its card);
//   - events (the dolphin pod, the rogue wave, the bats at dusk, the herd stampede) force-spawned on a
//     spot of their surface (open water, a coast, open land), the craft flying in at them, discovered;
//   - each one's own behaviour: a slab calving with its splash and ring wave, the bergs drifting with
//     their colliders, the shallows' clear water, the wreck shaded underwater, a pass through a sea
//     arch (its gate and achievement), the wave lifting the water query's surface, the bore running up
//     its estuary, the dolphins racing the craft's shadow, the bats out of their cave, a stampede, the
//     flamingos flushed off their pink lake;
//   - every solid part solid: a swept sphere hits its colliders, and a craft flown into the glacier's
//     ice front, a drifting berg and a sea arch's lintel soft-crashes with 'structure strike' and never
//     passes through;
//   - after each: GPU memory, wind sources, colliders, sky modifiers, lights and leaks back to the
//     baseline (spawnCheckKit.js, the one dispose check of the spawn checks).
// Every failed check calls console.error, so the smoke run fails.
import { createBrowserHelpers } from './structureTestKit.js';
import { createDisposeCheck, frames, holdConditions, wait } from './spawnCheckKit.js';
import { PRESETS } from '../spawns/presets/index.js';

/** How far (m) from the start the checks look for a real site, and for a spot of a surface. */
const SITE_SEARCH_RADIUS = 60000;
const SPOT_SEARCH_RADIUS = 30000;
const SPOT_RING_STEP = 500;

/** Resolves after `seconds` of wall time, frame by frame. */
async function seconds(duration) {
  const until = performance.now() + duration * 1000;
  while (performance.now() < until) await frames(1);
}

/** Resolves once test() is true (checked every frame) or `limit` seconds have passed; returns test(). */
async function until(test, limit) {
  const started = performance.now();
  while (!test() && performance.now() - started < limit * 1000) await frames(1);
  return test();
}

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function installPresetChecks41(game) {
  const helpers = createBrowserHelpers(game, 'presets 41-50');
  const { ctx, THREE, check, viewpoint, frameView, terrainIdle, flyThroughGate } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const dispose = createDisposeCheck(ctx, helpers);
  const presetById = new Map(PRESETS.map((preset) => [preset.id, preset]));
  const sea = ctx.world.WATER_LEVEL;
  const events = { discovery: [], cards: [], crashes: [], achievements: [], gates: [], calves: [], race: [], stampede: [], flush: [], scatter: [] };
  ctx.bus.onTyped('discovery', (payload) => events.discovery.push(payload));
  ctx.bus.on('journal:discovery', (payload) => events.cards.push(payload));
  ctx.bus.onTyped('softCrash', (payload) => events.crashes.push(payload));
  ctx.bus.onTyped('achievement', (payload) => events.achievements.push(payload));
  ctx.bus.on('structure:gate', (payload) => events.gates.push(payload));
  ctx.bus.on('structure:calve', (payload) => events.calves.push(payload));
  ctx.bus.on('fauna:race', (payload) => events.race.push(payload));
  ctx.bus.on('fauna:stampede', (payload) => events.stampede.push(payload));
  ctx.bus.on('fauna:flush', (payload) => events.flush.push(payload));
  ctx.bus.on('fauna:scatter', (payload) => events.scatter.push(payload));
  const timeFrozenBefore = ctx.settings.get('timeFrozen');
  /** The open check of each preset: { presetId, spawnId, baseline, discoveriesBefore, cardsBefore, site }. */
  const open = new Map();
  const spotCache = new Map();

  const groundAt = (x, z) => ctx.world.groundHeight(x, z);
  const surfaceAt = (x, z) => Math.max(groundAt(x, z), sea);
  const isWater = (x, z, depth) => groundAt(x, z) < sea - depth;
  const isLand = (x, z, height) => groundAt(x, z) > sea + height;
  function ring(x, z, radius, test, every) {
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const result = test(x + Math.sin(angle) * radius, z - Math.cos(angle) * radius);
      if (every && !result) return false;
      if (!every && result) return true;
    }
    return every;
  }
  /** Open lowland: a gentle 8-point ring 400 m out, all of it land. */
  function isOpenLand(x, z) {
    const centre = groundAt(x, z);
    if (!(centre > sea + 8 && centre < sea + 600)) return false;
    return ring(x, z, 400, (px, pz) => Math.abs(groundAt(px, pz) - centre) < 25 && isLand(px, pz, 4), true);
  }
  const SURFACE_TESTS = Object.freeze({
    water: (x, z) => isWater(x, z, 8) && ring(x, z, 900, (px, pz) => isWater(px, pz, 3), true),
    coast: (x, z) => isWater(x, z, 4) && ring(x, z, 300, (px, pz) => isWater(px, pz, 1.5), true) && ring(x, z, 1400, (px, pz) => isLand(px, pz, 5), false),
    land: isOpenLand,
    mountain: (x, z) => isLand(x, z, 500),
  });

  /** The nearest spot of a surface kind to the start ({ x, z }), searched ring by ring; cached. */
  function surfaceSpot(kind) {
    if (spotCache.has(kind)) return spotCache.get(kind);
    const test = SURFACE_TESTS[kind];
    const origin = state.spawn;
    for (let radius = 0; radius <= SPOT_SEARCH_RADIUS; radius += SPOT_RING_STEP) {
      const steps = Math.max(1, Math.round((2 * Math.PI * radius) / SPOT_RING_STEP));
      for (let index = 0; index < steps; index++) {
        const angle = (index / steps) * Math.PI * 2;
        const x = origin.x + Math.sin(angle) * radius;
        const z = origin.z - Math.cos(angle) * radius;
        if (!test(x, z)) continue;
        const spot = { x, z };
        spotCache.set(kind, spot);
        return spot;
      }
    }
    throw new Error(`no ${kind} spot within ${SPOT_SEARCH_RADIUS / 1000} km of the start`);
  }

  function partOf(spawnId, engine) {
    return spawnId ? (manager.getParts(spawnId) ?? []).find((part) => part.engine === engine) ?? null : null;
  }
  function partsOf(spawnId, engine) {
    return spawnId ? (manager.getParts(spawnId) ?? []).filter((part) => part.engine === engine) : [];
  }
  function describe(part) {
    if (!part) return null;
    const engine = manager.registry.get(part.engine);
    return engine && typeof engine.describe === 'function' ? engine.describe(part.engine === 'fauna' ? part.id : part) : null;
  }
  function spawnOf(presetId) {
    const record = open.get(presetId);
    return record ? record.spawnId : null;
  }

  /** The discovery of presetId since its check opened: the typed event, the journal entry and its card. */
  async function discoveredSince(record, limit = 25) {
    const matches = (payload) => payload.presetId === record.presetId || (record.site && payload.id === record.site.id);
    let event = null;
    await until(() => {
      event = events.discovery.slice(record.discoveriesBefore).find(matches) ?? null;
      return Boolean(event) && events.cards.slice(record.cardsBefore).some((card) => card.entry && card.entry.id === event.id);
    }, limit);
    const card = event ? events.cards.slice(record.cardsBefore).find((entry) => entry.entry && entry.entry.id === event.id) : null;
    return { event, card, inJournal: event ? ctx.systems.journal.hasDiscovered(event.id) : false };
  }

  /**
   * The craft flown into a collider: a direction (of 8) whose start, `approach` m short of `target`, lies in
   * open air with nothing solid between it and the collider (a swept sphere hits the collider first).
   * The craft, out of photo mode, starts there heading at it; it must soft-crash with 'structure strike'
   * and stop short of the target. Returns the check line.
   */
  async function strike(label, colliderId, target, ownIds = [colliderId], approach = 70) {
    const hit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), id: null, owner: null, tags: null, velocity: new THREE.Vector3() };
    let chosen = null;
    for (let index = 0; index < 8 && !chosen; index++) {
      const angle = (index / 8) * Math.PI * 2;
      const dirX = Math.sin(angle);
      const dirZ = -Math.cos(angle);
      const from = new THREE.Vector3(target.x - dirX * approach, target.y, target.z - dirZ * approach);
      if (ctx.colliders.insideSolid(from.x, from.y, from.z, 2)) continue;
      // The terrain stays well under the approach all the way to the target, and the approach clear of
      // the water (a berg is struck a few metres over the sea).
      let clear = from.y > sea + 3;
      for (let along = 0; along <= approach && clear; along += 5) if (groundAt(from.x + dirX * along, from.z + dirZ * along) > from.y - 6) clear = false;
      if (!clear) continue;
      const to = new THREE.Vector3(target.x + dirX * 20, target.y, target.z + dirZ * 20);
      if (ctx.colliders.sweepSphere(from, to, 0.5, { sensors: false, landableTops: true }, hit) && ownIds.includes(hit.id) && withinBounds(colliderId, hit.point, 2)) chosen = { dirX, dirZ, from };
    }
    if (!chosen) return check(`${label}: solid (a swept sphere hits it; a craft flown into it soft-crashes)`, false, { collider: colliderId, reason: 'no clear approach from any of 8 directions' });
    ctx.setPhotoMode(false);
    // A soft crash still fading (an earlier strike) would respawn the craft mid-run: let it finish.
    await until(() => !ctx.systems.flight.getStats().crash, 15);
    const crashesBefore = events.crashes.length;
    const heading = (Math.atan2(chosen.dirX, -chosen.dirZ) * 180) / Math.PI;
    ctx.systems.flight.resetTo({ x: chosen.from.x, y: chosen.from.y, z: chosen.from.z, heading });
    // The craft's centre is never inside a solid on the way (it stops at the surface or is stopped).
    let insideFrames = 0;
    let frame = 0;
    const track = [];
    await until(() => {
      const position = state.player.position;
      if (ctx.colliders.insideSolid(position.x, position.y, position.z, 0)) insideFrames++;
      if (frame++ % 8 === 0 && track.length < 12) track.push([round((position.x - target.x) * chosen.dirX + (position.z - target.z) * chosen.dirZ), round(position.y - sea)]);
      return events.crashes.length > crashesBefore;
    }, 8);
    const crash = events.crashes.slice(crashesBefore)[0] ?? null;
    const player = state.player.position;
    const beyond = (player.x - target.x) * chosen.dirX + (player.z - target.z) * chosen.dirZ;
    return check(`${label}: solid (a swept sphere hits it; a craft flown into it soft-crashes 'structure strike', never through)`,
      crash !== null && crash.reason === 'structure strike' && beyond < 0 && insideFrames === 0, {
        collider: colliderId, targetAboveSea: round(target.y - sea), insideFrames, track, crash: crash ? { reason: crash.reason, speed: Math.round(crash.impactSpeed) } : null, beyondTarget: round(beyond),
      });
  }

  /** Whether a point lies within a collider's bounds grown by `margin` metres. */
  function withinBounds(id, point, margin) {
    const record = ctx.colliders.get(id);
    if (!record) return false;
    const bounds = record.bounds;
    return point.x >= bounds[0] - margin && point.y >= bounds[1] - margin && point.z >= bounds[2] - margin
      && point.x <= bounds[3] + margin && point.y <= bounds[4] + margin && point.z <= bounds[5] + margin;
  }

  /**
   * A swept sphere through the middle of each of `ids` (horizontally from four sides, or down from
   * above) is stopped there: by the collider itself, or by another of `ids` touching it within its
   * bounds (the glacier's front boxes share their face with the tongue's heightfield).
   */
  function sweepAll(label, ids) {
    const hit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), id: null, owner: null, tags: null, velocity: new THREE.Vector3() };
    const missed = [];
    for (const id of ids) {
      const record = ctx.colliders.get(id);
      if (!record) {
        missed.push(`${id} (not registered)`);
        continue;
      }
      const bounds = record.bounds;
      const centre = { x: (bounds[0] + bounds[3]) / 2, y: (bounds[1] + bounds[4]) / 2, z: (bounds[2] + bounds[5]) / 2 };
      const reach = Math.max(bounds[3] - bounds[0], bounds[5] - bounds[2]) + 20;
      let found = false;
      for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const from = new THREE.Vector3(centre.x - dx * reach, centre.y, centre.z - dz * reach);
        const to = new THREE.Vector3(centre.x + dx * reach, centre.y, centre.z + dz * reach);
        // Another collider of the same spawn may lie in front: any hit on this id along the line counts.
        if (ctx.colliders.sweepSphere(from, to, 0.5, { sensors: false, landableTops: true }, hit) && ids.includes(hit.id) && withinBounds(id, hit.point, 1)) found = true;
        if (!found) {
          const down = new THREE.Vector3(centre.x, bounds[4] + 30, centre.z);
          const below = new THREE.Vector3(centre.x, bounds[1] - 5, centre.z);
          if (ctx.colliders.sweepSphere(down, below, 0.5, { sensors: false, landableTops: true }, hit) && ids.includes(hit.id) && withinBounds(id, hit.point, 1)) found = true;
        }
        if (found) break;
      }
      if (!found) missed.push(id);
    }
    return check(`${label}: every collider is solid to a swept sphere`, ids.length > 0 && missed.length === 0, { colliders: ids.length, missed });
  }

  const api = {
    results: helpers.results,

    /** Holds the game's presets for the whole run (each check puts back only its own). */
    setup() {
      const held = system.debug.holdGamePresets();
      return check('setup: game presets held', manager.listPresets().length === 0, { held: held.length, tracked: dispose.tracker !== null });
    },

    /** The time of day (sun elevation in degrees, morning or evening, held there) and the regional weather. */
    async conditions({ sun = 20, morning = false, weather = 'clear' } = {}) {
      const line = holdConditions(ctx, { sun, morning, weather });
      await frames(8);
      return line;
    },

    /**
     * A site preset on its nearest REAL site: the craft flies there (the preset still held), the
     * baseline is read, the preset goes back in and the site feed builds its spawn; the view frames it
     * and the discovery must follow.
     */
    async site(presetId, view = {}) {
      const preset = presetById.get(presetId);
      const site = ctx.world.sitesNear(state.spawn.x, state.spawn.z, SITE_SEARCH_RADIUS).filter((entry) => entry.presetId === presetId)
        .sort((a, b) => Math.hypot(a.x - state.spawn.x, a.z - state.spawn.z) - Math.hypot(b.x - state.spawn.x, b.z - state.spawn.z))[0] ?? null;
      if (!preset || !site) return check(`${presetId}: real site`, false, `no site within ${SITE_SEARCH_RADIUS / 1000} km of the start`);
      ctx.setPhotoMode(false);
      // 1 km out to the north-west, heading at the site, high enough over both the site and the ground there.
      const startX = site.x - 700;
      const startZ = site.z - 700;
      ctx.systems.flight.resetTo({ x: startX, y: Math.max(surfaceAt(startX, startZ), site.groundY, sea) + 300, z: startZ, heading: 135 });
      ctx.systems.flight.setAutopilot({ enabled: true, heading: 135, altitude: state.player.position.y, speed: 30, followWaypoint: false, reason: 'presets 41-50 check' });
      await frames(3);
      await terrainIdle();
      const record = {
        presetId, site, spawnId: null, baseline: await dispose.baseline({ waitTerrain: false }), discoveriesBefore: events.discovery.length, cardsBefore: events.cards.length,
      };
      open.set(presetId, record);
      // A site near the start may have been found in the moments before setup held the presets: the
      // journal keeps it, and a site is announced only once.
      const knownBefore = ctx.systems.journal.hasDiscovered(site.id);
      system.debug.addPreset(preset);
      await until(() => {
        record.spawnId = manager.getSiteSpawn(site.id);
        return Boolean(record.spawnId);
      }, 60);
      const { x = 0, y = 0, z = 0 } = view.focus ?? {};
      const target = { x: site.x + x, y: (view.focusY === 'sea' ? sea : site.groundY) + y, z: site.z + z };
      const { distance = 900, height = 180, bearing = 200, fov } = view;
      const settled = await frameView(viewpoint(target, distance, height, bearing + (site.rotation * 180) / Math.PI), target, { fov });
      const found = knownBefore ? { event: null, card: null, inJournal: ctx.systems.journal.hasDiscovered(site.id) } : await discoveredSince(record);
      const discovered = knownBefore ? found.inJournal : Boolean(found.event && found.card && found.inJournal);
      const stamps = site.stamps.map((stamp) => stamp.type);
      const stampsOk = stamps.length === (preset.stamps ?? []).length && stamps.every((type, index) => type === preset.stamps[index].type);
      return check(`${presetId}: built on its real site with its stamps, discovered (toast and journal entry)`, Boolean(record.spawnId) && stampsOk && discovered, {
        site: { id: site.id, x: Math.round(site.x), z: Math.round(site.z), groundY: Math.round(site.groundY), stamps }, spawnId: record.spawnId, terrainSettled: settled, knownBefore,
        discovered: found.event ? found.event.name : null, journal: found.card ? { name: found.card.entry.name, found: found.card.found, total: found.card.total } : null,
      });
    },

    /**
     * An event preset force-spawned on the nearest spot of `anchor` (water, coast, land or mountain)
     * through the debug path, the craft `distance` m short of it flying in at `altitude` m on the
     * autopilot, running `runSeconds`; then its discovery.
     */
    async spawn(presetId, { anchor = 'land', distance = 1500, altitude = 150, runSeconds = 3, speed = 40, params = null } = {}) {
      const preset = presetById.get(presetId);
      let spot;
      try {
        spot = surfaceSpot(anchor);
      } catch (error) {
        return check(`${presetId}: force-spawned`, false, error.message);
      }
      const heading = state.spawn.heading;
      const radians = (heading * Math.PI) / 180;
      const x = spot.x - Math.sin(radians) * distance;
      const z = spot.z + Math.cos(radians) * distance;
      const y = Math.max(surfaceAt(x, z), surfaceAt(spot.x, spot.z)) + altitude;
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x, y, z, heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: y, speed, followWaypoint: false, reason: 'presets 41-50 check' });
      await frames(3);
      await terrainIdle();
      const record = {
        presetId, site: null, spawnId: null, baseline: await dispose.baseline({ waitTerrain: false }), discoveriesBefore: events.discovery.length, cardsBefore: events.cards.length,
      };
      open.set(presetId, record);
      system.debug.addPreset(preset);
      const options = { position: { x: spot.x, y: surfaceAt(spot.x, spot.z), z: spot.z }, heading, source: 'debug', force: true };
      if (params) options.params = params;
      record.spawnId = manager.activate(presetId, options);
      // An anchor rule (the bats' seek 'peak') may move the activation: fly in at where it stands now.
      const parts = record.spawnId ? manager.getParts(record.spawnId) ?? [] : [];
      if (parts.length > 0 && Math.hypot(parts[0].anchor.x - spot.x, parts[0].anchor.z - spot.z) > 100) {
        const anchorPoint = parts[0].anchor;
        const placedX = anchorPoint.x - Math.sin(radians) * distance;
        const placedZ = anchorPoint.z + Math.cos(radians) * distance;
        const placedY = Math.max(surfaceAt(placedX, placedZ), anchorPoint.y) + altitude;
        ctx.systems.flight.resetTo({ x: placedX, y: placedY, z: placedZ, heading });
        ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: placedY, speed, followWaypoint: false, reason: 'presets 41-50 check' });
      }
      await seconds(runSeconds);
      const instance = record.spawnId ? manager.getInstance(record.spawnId) : null;
      const found = await discoveredSince(record);
      return check(`${presetId}: force-spawned on a ${anchor} spot, discovered (toast and journal entry)`, Boolean(instance) && Boolean(found.event && found.card && found.inJournal), {
        spawnId: record.spawnId, spot: { x: Math.round(spot.x), z: Math.round(spot.z) }, discovered: found.event ? found.event.name : null,
        parts: (manager.getParts(record.spawnId) ?? []).map((part) => ({ engine: part.engine, tier: part.tier, colliders: part.colliderIds ? part.colliderIds.length : 0 })),
      });
    },

    /**
     * Frames presetId's spawn in photo mode: `target` is its first part's anchor (or, with view.at
     * 'glacier', 'wreck', 'arch', 'pod', 'bat', 'herd' or 'flock', the point that check left) plus
     * `lift`, seen from `distance` and `height` at `bearing` degrees from the craft's heading.
     */
    async frame(presetId, view = {}) {
      const spawnId = spawnOf(presetId);
      const parts = spawnId ? manager.getParts(spawnId) ?? [] : [];
      const point = typeof view.at === 'string' ? api[`${view.at}View`] ?? null : parts.length > 0 ? parts[0].anchor : null;
      if (!point) return check(`${presetId}: framed`, false, 'no live spawn');
      const { distance = 600, height = 120, bearing = 200, lift = 10, fov } = view;
      const target = { x: point.x, y: point.y + lift, z: point.z };
      const settled = await frameView(viewpoint(target, distance, height, state.player.heading + bearing), target, { fov });
      await frames(20);
      return check(`${presetId}: framed`, true, { terrainSettled: settled, target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) } });
    },

    /** Removes presetId (its spawn ends): GPU memory, wind sources, colliders, sky modifiers and lights back, no leaks. */
    async end(presetId) {
      const record = open.get(presetId);
      if (!record) return check(`${presetId}: ended`, false, 'never opened');
      ctx.setPhotoMode(false);
      ctx.systems.flight.setAutopilot({ enabled: false, reason: 'presets 41-50 check' });
      manager.removePreset(presetId);
      open.delete(presetId);
      const result = await dispose.compare(record.baseline, { presetIds: [presetId] });
      return check(`${presetId}: dispose returns GPU memory, removes its colliders, wind sources and sky modifiers`, result.ok, {
        before: result.before, after: result.after, worldFirstDrawn: result.worldFirstDrawn, leftBehind: result.leftBehind, windSources: result.windSources, windLeft: result.windLeft,
        colliders: result.colliders, collidersLeft: result.collidersLeft, skyModifiers: result.skyModifiers, lights: result.lights, leaks: result.leaks,
      });
    },

    // ---- 41: the calving glacier -------------------------------------------------------------------
    /**
     * The glacier's parts: its colliders (the heightfield top, the ice front, a hull per slab and berg)
     * solid; a calving forced now cracks a slab, topples it and plunges it (structure:calve 'crack' then
     * 'splash'), with a ring wave in the water layer that lifts the water query's surface near it; the
     * bergs drift (their colliders move with them). Leaves view.at on the splash for the frame.
     */
    async glacier() {
      const spawnId = spawnOf('calvingGlacier');
      const part = partOf(spawnId, 'structure');
      const engine = manager.registry.get('structure');
      if (!part) return check('calvingGlacier: calving', false, 'no structure part');
      const before = describe(part);
      const ids = part.colliderIds.slice();
      const sweep = sweepAll('calvingGlacier', ids);
      const top = ids.find((id) => /glacier-top/.test(id));
      const topRecord = top ? ctx.colliders.get(top) : null;
      const bergs = before.movers.list.map((mover, index) => ({ ...mover, index })).filter((mover) => mover.motion === 'drift');
      const bergStart = bergs.map((berg) => {
        const record = ctx.colliders.get(berg.collider);
        return record ? { x: record.center[0], z: record.center[2] } : null;
      });
      const calvesBefore = events.calves.length;
      ctx.setPhotoMode(false);
      const forced = engine.setParam(part, 'calve', 1);
      const cracked = await until(() => events.calves.slice(calvesBefore).some((event) => event.stage === 'crack'), 15);
      const splashed = await until(() => events.calves.slice(calvesBefore).some((event) => event.stage === 'splash'), 25);
      const splash = events.calves.slice(calvesBefore).find((event) => event.stage === 'splash') ?? null;
      await seconds(3);
      const during = describe(part);
      const layer = ctx.systems.water.effects.stats();
      // The ring wave lifts the surface at its crest: the highest lift of the water layer around the splash
      // (the water query adds it to the swell).
      const layerSurface = ctx.systems.water.effects;
      let lift = 0;
      if (splash) {
        for (let radius = 5; radius <= 80; radius += 2.5) {
          for (let index = 0; index < 16; index++) {
            const angle = (index / 16) * Math.PI * 2;
            const x = splash.position.x + Math.sin(angle) * radius;
            const z = splash.position.z - Math.cos(angle) * radius;
            lift = Math.max(lift, layerSurface.surfaceHeightAt(x, z) - sea);
          }
        }
      }
      const bergMoved = bergs.map((berg, index) => {
        const record = ctx.colliders.get(berg.collider);
        const start = bergStart[index];
        return record && start ? Math.hypot(record.center[0] - start.x, record.center[2] - start.z) : 0;
      });
      api.glacierView = splash ? { x: splash.position.x, y: sea, z: splash.position.z } : null;
      const slabs = before.movers.list.filter((mover) => mover.motion === 'calve').length;
      return [sweep, check('calvingGlacier: a slab cracks, topples and plunges with a splash and a ring wave; the bergs drift with their colliders',
        forced && cracked && splashed && during.movers.ringWave && layer.waves >= 1 && lift > 0.3 && slabs >= 3 && bergs.length >= 1 && Boolean(topRecord) && topRecord.tags.landable === true
          && bergMoved.filter((moved) => moved > 0.5).length >= Math.ceil(bergs.length / 2), {
          colliders: ids.length, landableTop: Boolean(topRecord), slabs, bergs: bergs.length, forced, cracked, splashed, ringWave: during.movers.ringWave,
          layerWaves: layer.waves, waterLiftNearSplash: round(lift, 2), calvings: during.movers.calvings, bergMovedM: bergMoved.map((moved) => round(moved)),
          statuses: during.movers.list.filter((mover) => mover.motion === 'calve').map((mover) => mover.status),
        })].join('\n');
    },

    /** A craft flown into the glacier's ice front (a front box) and into a drifting berg. */
    async glacierStrikes() {
      const part = partOf(spawnOf('calvingGlacier'), 'structure');
      if (!part) return check('calvingGlacier: strikes', false, 'no structure part');
      const front = part.colliderIds.filter((id) => /ice-front/.test(id)).map((id) => ctx.colliders.get(id)).filter(Boolean);
      const middle = front[Math.floor(front.length / 2)];
      const lines = [];
      if (middle) {
        const bounds = middle.bounds;
        lines.push(await strike('calvingGlacier: the ice front', middle.id, { x: middle.center[0], y: Math.max(sea + 14, (bounds[1] + bounds[4]) / 2), z: middle.center[2] }, part.colliderIds));
      } else {
        lines.push(check('calvingGlacier: the ice front', false, 'no ice-front collider'));
      }
      const described = describe(part);
      const berg = described.movers.list.filter((mover) => mover.motion === 'drift').map((mover) => ctx.colliders.get(mover.collider)).filter(Boolean)
        .sort((a, b) => b.bounds[4] - a.bounds[4])[0];
      if (berg && berg.bounds[4] - sea > 6) {
        lines.push(await strike('calvingGlacier: a drifting berg', berg.id, { x: berg.center[0], y: sea + Math.max(3, Math.min((berg.bounds[4] - sea) * 0.4, 8)), z: berg.center[2] }, part.colliderIds, 50));
      } else {
        lines.push(check('calvingGlacier: a drifting berg', false, berg ? `the tallest berg stands only ${round(berg.bounds[4] - sea)} m out of the water` : 'no berg collider'));
      }
      return lines.join('\n');
    },

    // ---- 42 and 43: the shallows -------------------------------------------------------------------
    /** The clear water: a shallows slot in the layer, fitted to the site's stamp, at full weight. */
    async shallows(presetId) {
      const part = partsOf(spawnOf(presetId), 'waterEffect').find((entry) => entry.data.kind === 'shallows') ?? null;
      if (!part) return check(`${presetId}: clear shallows`, false, 'no shallows part');
      // Photo mode pauses the simulation: the engines run again for the check.
      ctx.setPhotoMode(false);
      await until(() => describe(part).shallows.weight > 0.95, 10);
      const described = describe(part);
      const stamp = open.get(presetId).site.stamps.find((entry) => entry.shallows);
      const fitted = stamp ? Math.hypot(described.shallows.x - stamp.shallows.x, described.shallows.z - stamp.shallows.z) < 1 && Math.abs(described.shallows.radius - stamp.shallows.radius) < 1 : false;
      const layer = ctx.systems.water.effects.stats();
      return check(`${presetId}: clear shallows fitted to its stamp, surf on the reef`, described.slots.shallows >= 0 && described.shallows.weight > 0.95 && fitted && described.shallows.surfRadius > 0 && layer.shallows >= 1, {
        shallows: { radius: Math.round(described.shallows.radius), surfRadius: Math.round(described.shallows.surfRadius), clarity: described.shallows.clarity, weight: round(described.shallows.weight, 2) },
        fitted, layerShallows: layer.shallows,
      });
    },

    /** The atoll's ring: islets above the sea on the rim, the lagoon under it, the open sea outside. */
    atoll() {
      const site = open.get('coralAtoll').site;
      const stamp = site.stamps[0];
      const isletHeights = stamp.islets.map((islet) => round(groundAt(islet.x, islet.z) - sea));
      const lagoon = groundAt(stamp.x, stamp.z) - sea;
      return check('coralAtoll: the ring of islets stands out of the sea around a lagoon under it', isletHeights.every((height) => height > 0.5) && lagoon < -3, {
        islets: isletHeights, lagoonDepth: round(-lagoon), radius: Math.round(stamp.radius),
      });
    },

    /** The wreck: on the reef's sand floor, shaded underwater, every collider solid. View.at on the wreck. */
    wreck() {
      const part = partOf(spawnOf('reefShipwreck'), 'structure');
      if (!part) return check('reefShipwreck: wreck', false, 'no structure part');
      const described = describe(part);
      const stamp = open.get('reefShipwreck').site.stamps[0];
      api.wreckView = { x: stamp.x, y: stamp.pocketY, z: stamp.z };
      const sweep = sweepAll('reefShipwreck', part.colliderIds);
      const hulls = part.colliderIds.filter((id) => /:(bow|stern)\d*$/.test(id)).map((id) => ctx.colliders.get(id)).filter(Boolean);
      const underwater = hulls.every((record) => record.bounds[1] < sea - 3);
      return [sweep, check('reefShipwreck: the wreck lies on the reef under clear water, shaded underwater', described.underwater && hulls.length === 2 && underwater && stamp.pocketY < sea - 6, {
        underwater: described.underwater, colliders: described.colliders, hulls: hulls.length, pocketDepth: round(sea - stamp.pocketY),
      })].join('\n');
    },

    // ---- 45: the sea stacks and arches -------------------------------------------------------------
    /** Every collider solid; a pass through the first arch sends its gate and the achievement once. */
    async arches() {
      const part = partOf(spawnOf('seaStacks'), 'structure');
      if (!part) return check('seaStacks: arches', false, 'no structure part');
      const sweep = sweepAll('seaStacks', part.colliderIds);
      const gates = part.data.gates.data;
      const gatesBefore = events.gates.length;
      const achievementsBefore = events.achievements.length;
      ctx.setPhotoMode(false);
      await flyThroughGate(gates, 0);
      await frames(5);
      const passed = events.gates.slice(gatesBefore).filter((event) => event.spawnId === spawnOf('seaStacks'));
      const earned = events.achievements.slice(achievementsBefore).filter((event) => event.id === 'seaArch');
      const stamp = open.get('seaStacks').site.stamps[0];
      const stacks = stamp.stacks.map((stack) => round(groundAt(stack.x, stack.z) - sea));
      const arch = stamp.arches[0];
      api.archView = arch ? { x: arch.x, y: sea + 10, z: arch.z } : null;
      return [sweep, check('seaStacks: the stacks stand out of the sea; a pass through the arch sends its gate and the achievement', passed.length >= 1 && earned.length === 1
        && stacks.every((height) => height > 20) && stamp.arches.length >= 1, {
        stacks, arches: stamp.arches.length, gate: passed[0] ? passed[0].gate : null, achievement: earned.length,
      })].join('\n');
    },

    /** A craft flown into the middle of an arch's lintel. */
    async archStrike() {
      const part = partOf(spawnOf('seaStacks'), 'structure');
      const lintel = part ? part.colliderIds.filter((id) => /lintel/.test(id)).map((id) => ctx.colliders.get(id)).filter(Boolean) : [];
      const middle = lintel.find((record) => record.tags && record.tags.perch) ?? null;
      if (!middle) return check('seaStacks: a lintel', false, 'no lintel collider');
      return strike('seaStacks: an arch lintel', middle.id, { x: middle.center[0], y: middle.center[1], z: middle.center[2] }, part.colliderIds);
    },

    // ---- 46 and 47: the travelling waves ------------------------------------------------------------
    /**
     * A wave part running: its crest moves on, it lifts the water query's surface at its crest by most
     * of its height, and the layer counts it. It leaves the crest's centre for frameWave.
     */
    async wave(presetId, { waitRun = 25 } = {}) {
      const part = partsOf(spawnOf(presetId), 'waterEffect').find((entry) => entry.data.kind === 'wave') ?? null;
      if (!part) return check(`${presetId}: wave`, false, 'no wave part');
      ctx.setPhotoMode(false);
      await until(() => describe(part).wave.running && describe(part).wave.weight > 0.9, waitRun);
      const first = describe(part).wave;
      await seconds(2);
      const second = describe(part).wave;
      const crestX = second.originX + second.dirX * second.front;
      const crestZ = second.originZ + second.dirZ * second.front;
      // The layer's lift at the crest's peak (a few metres either side of its centre), and the water
      // query there: the swell plus that lift, so it stays within the swell's reach of sea level + lift.
      const layerSurface = ctx.systems.water.effects;
      let lift = -Infinity;
      let queried = NaN;
      for (let offset = -6; offset <= 6; offset += 1.5) {
        const x = crestX + second.dirX * offset;
        const z = crestZ + second.dirZ * offset;
        if (!isWater(x, z, 0.3)) continue;
        const layerLift = layerSurface.surfaceHeightAt(x, z) - sea;
        if (layerLift > lift) {
          lift = layerLift;
          queried = ctx.waterQuery.heightAt(x, z) - sea;
        }
      }
      const layer = ctx.systems.water.effects.stats();
      api.waveView = { x: crestX, y: sea, z: crestZ, dirX: second.dirX, dirZ: second.dirZ };
      return check(`${presetId}: the wave runs, its crest lifting the water query's surface`,
        second.running && second.front > first.front && lift > second.height * second.weight * 0.6 && Math.abs(queried - lift) < 3 && layer.waves >= 1, {
        runs: second.runs, front: [Math.round(first.front), Math.round(second.front)], height: round(second.height), weight: round(second.weight, 2), liftAtCrest: round(lift, 2), waterQueryAtCrest: round(queried, 2),
        estuary: second.estuary, crestLength: Math.round(second.crestLength), layerWaves: layer.waves,
      });
    },

    /** The bore's estuary: its channel carved below the sea from the mouth to the head, on land. */
    estuary() {
      const stamp = open.get('tidalBore').site.stamps[0];
      const samples = [];
      for (let share = 0.05; share <= 0.95; share += 0.15) {
        const x = stamp.mouthX + stamp.inlandX * stamp.channelLength * share;
        const z = stamp.mouthZ + stamp.inlandZ * stamp.channelLength * share;
        samples.push(round(groundAt(x, z) - sea));
      }
      const levee = groundAt(stamp.mouthX + stamp.inlandX * stamp.channelLength * 0.5 + -stamp.inlandZ * (stamp.mouthHalfWidth + 20), stamp.mouthZ + stamp.inlandZ * stamp.channelLength * 0.5 + stamp.inlandX * (stamp.mouthHalfWidth + 20)) - sea;
      return check('tidalBore: the channel is carved below the sea from its mouth to its head', samples.every((depth) => depth < -0.5), {
        channel: samples, length: Math.round(stamp.channelLength), mouthWidth: Math.round(stamp.mouthHalfWidth * 2), levee: round(levee),
      });
    },

    /** The camera on a wave's crest from the side it travels toward (the face), `distance` m off. */
    async frameWave(presetId, { distance = 450, height = 60, side = 0.6, lift = 5, fov } = {}) {
      const at = api.waveView;
      if (!at) return check(`${presetId}: wave framed`, false, 'no wave view');
      const target = { x: at.x, y: at.y + lift, z: at.z };
      const position = new THREE.Vector3(at.x + at.dirX * distance - at.dirZ * distance * side, at.y + height, at.z + at.dirZ * distance + at.dirX * distance * side);
      const settled = await frameView(position, new THREE.Vector3(target.x, target.y, target.z), { fov });
      await frames(10);
      return check(`${presetId}: wave framed`, true, { terrainSettled: settled });
    },

    // ---- 44, 48, 49, 50: the wildlife ----------------------------------------------------------------
    /** The craft flown low over the water past the pod: the dolphins race its shadow (fauna:race). */
    async dolphinRace() {
      const spawnId = spawnOf('dolphinPod');
      const part = partOf(spawnId, 'fauna');
      if (!part) return check('dolphinPod: race', false, 'no fauna part');
      const centre = describe(part).center;
      ctx.setPhotoMode(false);
      const raceBefore = events.race.length;
      const heading = state.player.heading;
      const radians = (heading * Math.PI) / 180;
      const x = centre.x - Math.sin(radians) * 350;
      const z = centre.z + Math.cos(radians) * 350;
      ctx.systems.flight.resetTo({ x, y: sea + 60, z, heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: sea + 60, speed: 32, followWaypoint: false, reason: 'presets 41-50 check' });
      const raced = await until(() => events.race.slice(raceBefore).some((event) => event.racing === true) || describe(part).racing, 20);
      const described = describe(part);
      api.podView = described.center;
      return check('dolphinPod: the pod races the shadow of a craft flying low over the water', raced, {
        racing: described.racing, leaping: described.leaping, count: described.count, events: events.race.slice(raceBefore).length,
      });
    },

    /** The bats out of their cave: the stream's mouth on a cliff face by the cave mouth part, bats out. */
    async bats() {
      const spawnId = spawnOf('batsAtDusk');
      const fauna = partOf(spawnId, 'fauna');
      const cave = partOf(spawnId, 'structure');
      if (!fauna || !cave) return check('batsAtDusk: stream', false, 'missing a part');
      await until(() => describe(fauna).emerged > 300, 30);
      const described = describe(fauna);
      const mouth = described.mouth;
      const hood = cave.colliderIds.map((id) => ctx.colliders.get(id)).filter(Boolean)[0];
      const hoodDistance = hood ? Math.hypot(hood.center[0] - mouth.x, hood.center[2] - mouth.z) : Infinity;
      const sweep = sweepAll('batsAtDusk', cave.colliderIds);
      api.batView = described.center;
      return [sweep, check('batsAtDusk: the bats pour out of the cave mouth on a cliff face', described.emerged > 300 && hoodDistance < 40 && mouth.y > sea + 25, {
        emerged: described.emerged, count: described.count, mouth: { x: Math.round(mouth.x), y: Math.round(mouth.y), z: Math.round(mouth.z) }, hoodFromMouth: round(hoodDistance), centre: described.center,
      })].join('\n');
    },

    /** The craft flown through the middle of the stream: the bats scatter (fauna:scatter). */
    async batScatter() {
      const fauna = partOf(spawnOf('batsAtDusk'), 'fauna');
      if (!fauna) return check('batsAtDusk: scatter', false, 'no fauna part');
      // A point a third of the way along the stream's tabled path, and the path's direction there.
      const path = fauna.data.streamPath;
      const point = Math.floor(path.length / 9);
      const px = path[point * 3];
      const py = path[point * 3 + 1];
      const pz = path[point * 3 + 2];
      const alongX = path[point * 3 + 3] - path[point * 3 - 3];
      const alongZ = path[point * 3 + 5] - path[point * 3 - 1];
      const length = Math.hypot(alongX, alongZ) || 1;
      const acrossX = -alongZ / length;
      const acrossZ = alongX / length;
      ctx.setPhotoMode(false);
      const before = events.scatter.length;
      const heading = (Math.atan2(acrossX, -acrossZ) * 180) / Math.PI;
      ctx.systems.flight.resetTo({ x: px - acrossX * 220, y: py, z: pz - acrossZ * 220, heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: py, speed: 35, followWaypoint: false, reason: 'presets 41-50 check' });
      const scattered = await until(() => events.scatter.length > before, 15);
      return check('batsAtDusk: a craft flown through the stream scatters the bats', scattered, { scatters: events.scatter.length - before });
    },

    /** The craft buzzing the herd low: it stampedes (fauna:stampede), raising dust. View.at on the herd. */
    async stampede() {
      const part = partOf(spawnOf('herdStampede'), 'fauna');
      if (!part) return check('herdStampede: stampede', false, 'no fauna part');
      const centre = describe(part).center;
      ctx.setPhotoMode(false);
      const before = events.stampede.length;
      const heading = state.player.heading;
      const radians = (heading * Math.PI) / 180;
      const x = centre.x - Math.sin(radians) * 500;
      const z = centre.z + Math.cos(radians) * 500;
      const y = Math.max(surfaceAt(x, z), centre.y) + 70;
      ctx.systems.flight.resetTo({ x, y, z, heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: y, speed: 35, followWaypoint: false, reason: 'presets 41-50 check' });
      const ran = await until(() => events.stampede.length > before, 25);
      await seconds(4);
      const described = describe(part);
      api.herdView = described.center;
      return check('herdStampede: buzzed low, the herd stampedes and raises dust', ran && described.gait > 0.5 && described.dust > 0, {
        trigger: events.stampede[before] ? events.stampede[before].trigger : null, gait: round(described.gait, 2), dust: described.dust, count: described.count,
      });
    },

    /** The flamingos on their pink lake: the lake a tinted body at the site; buzzed, the flock flushes. */
    async flamingos() {
      const record = open.get('flamingoLake');
      const part = partOf(record.spawnId, 'fauna');
      if (!part) return check('flamingoLake: flush', false, 'no fauna part');
      const site = record.site;
      const lake = site.waters[0] ?? null;
      const surface = ctx.waterQuery.heightAt(site.x, site.z);
      const centre = describe(part).center;
      ctx.setPhotoMode(false);
      const before = events.flush.length;
      const heading = state.player.heading;
      const radians = (heading * Math.PI) / 180;
      const x = centre.x - Math.sin(radians) * 300;
      const z = centre.z + Math.cos(radians) * 300;
      const y = centre.y + 35;
      ctx.systems.flight.resetTo({ x, y, z, heading });
      ctx.systems.flight.setAutopilot({ enabled: true, heading, altitude: y, speed: 30, followWaypoint: false, reason: 'presets 41-50 check' });
      let closest = Infinity;
      const flushed = await until(() => {
        const player = state.player.position;
        closest = Math.min(closest, Math.hypot(player.x - centre.x, player.y - centre.y, player.z - centre.z));
        return events.flush.length > before;
      }, 25);
      await until(() => describe(part).airborne > 0, 15);
      await seconds(2);
      const described = describe(part);
      api.flockView = described.center;
      return check('flamingoLake: a pink lake in the basin; buzzed, the flamingos take off in a wave', Boolean(lake) && lake.tint === 0xf2a6b8 && Math.abs(surface - lake.level) < 0.5 && flushed && described.airborne > 0, {
        lake: lake ? { level: round(lake.level), tint: lake.tint.toString(16) } : null, surfaceAtCentre: round(surface), flushed, closestApproach: round(closest), airborne: described.airborne, count: described.count,
      });
    },

    /** The summary check; puts the game's presets, the weather and the clock back. */
    finish() {
      for (const presetId of [...open.keys()]) manager.removePreset(presetId);
      open.clear();
      system.debug.releaseGamePresets();
      dispose.restore();
      ctx.systems.flight.setAutopilot({ enabled: false, reason: 'presets 41-50 check' });
      ctx.systems.weather.forceState(null);
      ctx.settings.set('timeFrozen', timeFrozenBefore);
      return helpers.finish();
    },
  };
  window.__dwPresets41 = api;
  return api;
}
