// Dev-only browser checks for presets 51-60 (Phase 3 batch 6). installBatch6Checks(game) puts
// window.__dwBatch6 on a running V2 on a dev server; tools/steps/presets-51-60.json drives it, on both
// backends (?renderer=webgl). For each preset it:
//   - sets the time of day and the regional weather the preset belongs to;
//   - shows a site preset on its nearest REAL placed site (with its stamps and waters) when one lies
//     within reach, and checks its discovery and journal entry;
//   - force-spawns the preset ahead of the craft through the SpawnManager's debug path (with the
//     scenario's activation overrides: the viaduct's train out on the deck, the fireball's short fuse),
//     frames it in photo mode for a screenshot and runs its own checks: the butterflies drifting with
//     the wind, the caribou and the camels walking their routes, the flags in the wind, the
//     observatory opening at night, the train crossing with its colliders, the real sites' reservoir
//     and oasis pool in the shared water query, the maze's hedges, the fireball's timeline and its emitters
//     starting at the impact, and a sphere swept at speed into every solid preset's colliders;
//   - after dispose, proves through the shared dispose check (spawnCheckKit.js) GPU memory back to its
//     level, its wind sources, colliders, ignitables, sky modifiers and lights gone, and no leaks.
// Every failed check calls console.error, so the smoke run fails. Never part of a production build:
// only dev-server step files import it.
import { createBrowserHelpers } from './structureTestKit.js';
import { createDisposeCheck, frames, holdConditions } from './spawnCheckKit.js';
import { createWaterSample } from '../world/waterQuery.js';

/** The structure part of a spawn (the part whose data has movers), or null. */
function structurePart(manager, spawnId) {
  return (manager.getParts(spawnId) ?? []).find((part) => part.engine === 'structure') ?? null;
}

export function installBatch6Checks(game) {
  const helpers = createBrowserHelpers(game, 'presets 51-60');
  const { ctx, check, viewpoint, frameView, terrainIdle } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const dispose = createDisposeCheck(ctx, helpers);
  const spawned = new Map();
  const discoveries = [];
  ctx.bus.onTyped('discovery', (payload) => discoveries.push(payload));
  const timeFrozenBefore = ctx.settings.get('timeFrozen');

  function memory() {
    const info = ctx.renderer.info.memory;
    return { geometries: info.geometries, textures: info.textures };
  }
  function partsOf(presetId) {
    const record = spawned.get(presetId);
    return record && record.id ? manager.getParts(record.id) ?? [] : [];
  }
  function engineOf(name) {
    return manager.registry.get(name);
  }
  /** The live anchor of a spawn: its first part's. */
  function anchorOf(presetId) {
    const parts = partsOf(presetId);
    return parts.length > 0 ? parts[0].anchor : null;
  }
  /** Seconds of wall time, frame by frame. */
  async function seconds(duration) {
    const until = performance.now() + duration * 1000;
    while (performance.now() < until) await frames(1);
  }

  const api = {
    results: helpers.results,

    setup() {
      // The load shedder must not demote the checks' spawns on a busy machine.
      system.debug.pinLodBias(1);
      return check('setup: the batch presets are registered', ['butterflyMigration', 'caribouMigration', 'cliffsideMonastery', 'seaCliffCastle', 'mountaintopObservatory', 'steamTrainViaduct', 'damSpillway', 'desertOasisCaravan', 'labyrinth', 'fireballImpact'].every((id) => manager.getPreset(id)), { tracked: dispose.tracker !== null, presets: manager.listPresets().length });
    },

    /** The time of day (sun elevation in degrees, held there) and the regional weather. */
    async conditions({ sun = 20, morning = false, weather = 'clear' } = {}) {
      const line = holdConditions(ctx, { sun, morning, weather });
      await frames(8);
      return line;
    },

    /**
     * A site preset on its nearest REAL site within 90 km (the site feed's placement, with its stamps
     * and waters): the craft flies there, the manager builds the site and the view frames it; then
     * its discovery and journal entry. Reports (does not fail) when the world has none in reach: the
     * debug spawn that follows shows the recipe anyway.
     */
    async site(presetId, view = {}) {
      const preset = manager.getPreset(presetId);
      const site = manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, 90000);
      if (!preset || !site) return check(`${presetId}: real site`, true, 'no site within 90 km of the start (shown as a debug spawn instead)');
      const { distance = 600, height = 160, bearing = 200, lift = 30 } = view;
      const since = discoveries.length;
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: site.x - 600, y: site.groundY + 300, z: site.z - 600, heading: 135 });
      let spawnId = null;
      const started = performance.now();
      while (!spawnId && performance.now() - started < 60000) {
        await frames(5);
        spawnId = manager.getSiteSpawn(site.id);
      }
      const target = { x: site.x, y: site.groundY + lift, z: site.z };
      const settled = await frameView(viewpoint(target, distance, height, bearing + (site.rotation * 180) / Math.PI), target);
      await terrainIdle();
      let discovery = null;
      const waitStarted = performance.now();
      while (!discovery && performance.now() - waitStarted < 20000) {
        discovery = discoveries.slice(since).find((payload) => payload.id === site.id) ?? null;
        await frames(5);
      }
      const waters = (site.waters ?? []).map((water) => ({ id: water.id, level: Math.round(water.level * 10) / 10 }));
      return check(`${presetId}: built on its real site and discovered`, Boolean(spawnId) && site.stamps.length === (preset.stamps ?? []).length && Boolean(discovery) && ctx.systems.journal.hasDiscovered(site.id), {
        site: { id: site.id, x: Math.round(site.x), z: Math.round(site.z), groundY: Math.round(site.groundY), stamps: site.stamps.map((stamp) => stamp.type), waters },
        spawnId, terrainSettled: settled, discovered: discovery ? discovery.name : null,
      });
    },

    /**
     * Spawns presetId `distance` m ahead of the craft (back at the start, `altitude` m up) through the
     * SpawnManager's debug path with the activation overrides `params` ({ [engine]: { ... } }), after
     * the dispose baseline, then lets it run `runSeconds`.
     */
    async start(presetId, { distance = 1500, runSeconds = 2, altitude = 150, params = null } = {}) {
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: state.spawn.x, y: state.spawn.y + altitude, z: state.spawn.z, heading: state.spawn.heading });
      await frames(3);
      const idle = await terrainIdle();
      const record = { presetId, id: null, baseline: await dispose.baseline({ waitTerrain: false }), during: null };
      const preset = manager.getPreset(presetId);
      const heading = state.player.heading;
      const radians = (heading * Math.PI) / 180;
      const x = state.player.position.x + Math.sin(radians) * distance;
      const z = state.player.position.z - Math.cos(radians) * distance;
      const duration = preset.lifetime.duration ? preset.lifetime.duration[1] : null;
      record.id = manager.activate(presetId, {
        position: { x, y: helpers.ground(x, z), z }, heading, source: 'debug', force: true, seed: 5100 + spawned.size, duration,
        params: params ?? undefined,
      });
      spawned.set(presetId, record);
      await seconds(runSeconds);
      record.during = memory();
      const instance = record.id ? manager.getInstance(record.id) : null;
      return check(`${presetId}: force-spawned ${distance} m ahead`, Boolean(instance), { id: record.id, terrainIdle: idle, tier: instance ? instance.tier : null, parts: partsOf(presetId).map((part) => part.engine) });
    },

    /** Frames presetId's spawn in photo mode from `distance` and `height` at `bearing` from the heading. */
    async frame(presetId, view = {}) {
      const anchor = anchorOf(presetId);
      if (!anchor) return check(`${presetId}: framed`, false, 'no live spawn');
      const { distance = 600, height = 120, bearing = 200, lift = 30 } = view;
      const target = { x: anchor.x, y: anchor.y + lift, z: anchor.z };
      const settled = await frameView(viewpoint(target, distance, height, state.player.heading + bearing), target);
      await frames(20);
      return check(`${presetId}: framed`, true, { terrainSettled: settled, target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) } });
    },

    /** Leaves photo mode (the simulation runs on), `duration` seconds. */
    async run(duration) {
      ctx.setPhotoMode(false);
      await seconds(duration);
      return `ran ${duration} s`;
    },

    /** Disposes presetId's spawn and proves it gave back what it took. */
    async end(presetId) {
      const record = spawned.get(presetId);
      if (!record) return check(`${presetId}: ended`, false, 'never spawned');
      const active = manager.getInstance(record.id) !== null;
      if (active) manager.deactivate(record.id, 'test');
      ctx.setPhotoMode(false);
      spawned.delete(presetId);
      const result = await dispose.compare(record.baseline, { presetIds: [presetId] });
      return check(`${presetId}: dispose returns GPU memory and removes its wind sources, colliders and ignitables`, result.ok, {
        endedNaturally: !active, before: result.before, during: record.during, after: result.after, leftBehind: result.leftBehind,
        windLeft: result.windLeft, colliders: result.colliders, collidersLeft: result.collidersLeft, skyModifiers: result.skyModifiers, lights: result.lights, leaks: result.leaks,
      });
    },

    // ---- The presets' own behaviour ----------------------------------------------------------------
    /** The butterfly cloud drifts downwind with the WindField's ambient wind. */
    async butterflies() {
      const part = partsOf('butterflyMigration').find((entry) => entry.engine === 'fauna');
      if (!part) return check('butterflyMigration: drifts with the wind', false, 'no fauna part');
      const fauna = engineOf('fauna');
      const before = { ...fauna.describe(part.id).center };
      const ambient = ctx.wind.ambientAt(before);
      await seconds(8);
      const after = fauna.describe(part.id);
      const toward = ((ambient.fromDegrees + 180) * Math.PI) / 180;
      const along = (after.center.x - before.x) * Math.sin(toward) - (after.center.z - before.z) * Math.cos(toward);
      return check('butterflyMigration: the cloud drifts downwind, a loose cloud of butterflies', along > 0 && after.count >= 1000 && after.radius > 5, { downwind: Math.round(along), wind: Math.round(ambient.speed * 10) / 10, count: after.count, radius: Math.round(after.radius) });
    },

    /** A column (caribou, camels) walks its route on the ground and moves on. */
    async column(presetId, { minCount = 10 } = {}) {
      const part = partsOf(presetId).find((entry) => entry.engine === 'fauna');
      if (!part) return check(`${presetId}: the column walks`, false, 'no fauna part');
      const fauna = engineOf('fauna');
      const before = { ...fauna.describe(part.id).center };
      await seconds(8);
      const after = fauna.describe(part.id);
      const moved = Math.hypot(after.center.x - before.x, after.center.z - before.z);
      const onGround = Math.abs(after.center.y - helpers.ground(after.center.x, after.center.z)) < 6;
      return check(`${presetId}: the column walks its route on the ground`, after.count >= minCount && moved > 3 && onGround && after.pathLength > 500, { count: after.count, moved: Math.round(moved), route: Math.round(after.pathLength) });
    },

    /** The cloth (flags, banners) takes the wind the structure shows. */
    cloth(presetId) {
      const part = structurePart(manager, spawned.get(presetId)?.id);
      if (!part) return check(`${presetId}: cloth in the wind`, false, 'no structure part');
      const cloth = part.data.clothWind;
      const wind = part.data.wind;
      const speed = Math.hypot(wind[0], wind[1]);
      const aligned = speed > 0.1 ? (cloth.x * wind[0] + cloth.y * wind[1]) / speed : 1;
      return check(`${presetId}: the cloth swings with the wind the structure shows`, Boolean(part.data.meshes.cloth) && aligned > 0.99 && Math.abs(cloth.z - speed) < 0.01, { speed: Math.round(speed * 10) / 10, aligned: Math.round(aligned * 1000) / 1000 });
    },

    /** At night the observatory's shutter opens and the telescope leaves its park. */
    observatory() {
      const part = structurePart(manager, spawned.get('mountaintopObservatory')?.id);
      if (!part) return check('mountaintopObservatory: opens at night', false, 'no structure part');
      const motion = part.data.moverState.custom.motion;
      return check('mountaintopObservatory: at night the shutter is open and the telescope aimed', motion[3] === 1 && motion[1] > 0.5, { open: motion[3], shutter: Math.round(motion[1] * 100) / 100, elevation: Math.round((motion[2] * 180) / Math.PI) });
    },

    /** The train runs along the viaduct and its colliders follow it. */
    async train() {
      const part = structurePart(manager, spawned.get('steamTrainViaduct')?.id);
      if (!part) return check('steamTrainViaduct: the train crosses', false, 'no structure part');
      const poses = part.data.moverState.poses;
      const before = { x: poses[0], z: poses[2], visible: poses[7] };
      await seconds(3);
      const after = { x: poses[0], z: poses[2], visible: poses[7] };
      const moved = Math.hypot(after.x - before.x, after.z - before.z);
      const collider = ctx.colliders ? ctx.colliders.get(part.data.moverColliderIds[0]) : null;
      const centreX = collider ? (collider.bounds[0] + collider.bounds[3]) / 2 - part.anchor.x : NaN;
      const centreZ = collider ? (collider.bounds[2] + collider.bounds[5]) / 2 - part.anchor.z : NaN;
      const follows = Math.hypot(centreX - after.x, centreZ - after.z) < 2;
      let puffs = 0;
      const steam = part.data.moverState.steam;
      for (let index = 3; index < steam.length; index += 4) if (steam[index] > 0) puffs++;
      return check('steamTrainViaduct: the train crosses in the open, steaming, its colliders with it', after.visible === 1 && moved > 10 && follows && puffs > 3, { moved: Math.round(moved), follows, puffs, cars: part.data.moverMeshes.length });
    },

    /** The lake of a real site in reach (its basin centre) is in the shared water query. */
    siteLake(presetId) {
      const site = manager.findNearestSite(presetId, state.player.position.x, state.player.position.z, 20000);
      const record = site && site.waters && site.waters[0] ? site.waters[0] : null;
      if (!record) return check(`${presetId}: the real site's lake is in the water query`, true, 'no real site with waters in reach');
      const sample = ctx.waterQuery.sample(record.x, record.z, undefined, createWaterSample());
      return check(`${presetId}: the real site's lake is in the water query`, sample.kind === 'lake' && Math.abs(sample.height - record.level) < 0.5, { kind: sample.kind, height: Math.round(sample.height * 10) / 10, level: Math.round(record.level * 10) / 10 });
    },

    /** The labyrinth's hedges are instanced blocks, each run a collider. */
    labyrinth() {
      const part = structurePart(manager, spawned.get('labyrinth')?.id);
      if (!part) return check('labyrinth: hedges', false, 'no structure part');
      const hedges = part.colliderIds.filter((id) => id.includes(':hedge')).length;
      return check('labyrinth: the hedges are instanced blocks with one collider per run', part.data.blockSlots.length >= 60 && hedges === part.data.blockSlots.length, { blocks: part.data.blockSlots.length, hedges });
    },

    /** The fireball has struck: the scar shows and glows, and its emitters have started. */
    fireball() {
      const record = spawned.get('fireballImpact');
      const part = structurePart(manager, record?.id);
      if (!part) return check('fireballImpact: impact', false, 'no structure part');
      const poses = part.data.moverState.poses;
      const timeline = part.data.moverState.custom.timeline;
      const emitters = (manager.getParts(record.id) ?? []).filter((entry) => entry.engine === 'emitter').map((entry) => engineOf('emitter').describe(entry).level);
      const scar = poses[timeline[7] * 8 + 7];
      return check('fireballImpact: the scar glows on the ground and the smoke and sparks have started', timeline[8] === 1 && scar === 1 && emitters.length === 2 && emitters.every((level) => level > 0), { impacted: timeline[8], scar, glow: Math.round(part.data.moverState.glow[0] * 100) / 100, emitterLevels: emitters.map((level) => Math.round(level * 100) / 100) });
    },

    /** Before the impact: the emitters wait at level 0. */
    fireballWaiting() {
      const record = spawned.get('fireballImpact');
      const emitters = (manager.getParts(record?.id) ?? []).filter((entry) => entry.engine === 'emitter').map((entry) => engineOf('emitter').describe(entry).level);
      return check('fireballImpact: before the impact the smoke and sparks wait (startDelay)', emitters.length === 2 && emitters.every((level) => level === 0), { emitterLevels: emitters });
    },

    /**
     * Sweeps a 1.5 m sphere at 60 m/s (one frame) into the middle of each solid collider type of the
     * spawn's structure part, from above: every sweep must hit (a soft crash in flight).
     */
    colliders(presetId) {
      const part = structurePart(manager, spawned.get(presetId)?.id);
      const colliders = ctx.colliders;
      if (!part || !colliders) return check(`${presetId}: colliders`, false, 'no structure part or collider service');
      const records = part.colliderIds.map((id) => colliders.get(id)).filter(Boolean);
      const byType = new Map();
      for (const record of records) if (!byType.has(record.type)) byType.set(record.type, record);
      const out = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null };
      const sweeps = [];
      for (const [type, record] of byType) {
        const x = (record.bounds[0] + record.bounds[3]) / 2;
        const z = (record.bounds[2] + record.bounds[5]) / 2;
        const top = record.bounds[4];
        const hit = colliders.sweepSphere({ x, y: top + 1.5, z }, { x, y: top - 1, z }, 1.5, {}, out);
        sweeps.push({ type, hit });
      }
      const perches = records.filter((record) => record.tags && record.tags.perch).length;
      return check(`${presetId}: its colliders are registered and a sweep into each type hits`, records.length === part.colliderIds.length && records.length > 0 && sweeps.every((sweep) => sweep.hit), { colliders: records.length, perches, sweeps });
    },

    /** The summary check; puts the clock and the weather back. */
    finish() {
      dispose.restore();
      ctx.systems.weather.forceState(null);
      ctx.settings.set('timeFrozen', timeFrozenBefore);
      return helpers.finish();
    },
  };
  window.__dwBatch6 = api;
  return api;
}

