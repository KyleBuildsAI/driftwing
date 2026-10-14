// Dev-only checks for presets 91-100 (the frozen lake and the legendary combos), driven by
// tools/steps/presets-91-100.json on a dev server (it imports this module by URL; never part of a
// production build). installPresetChecks91(game) puts window.__dwPresets91 on a running V2.
//
// The game's own presets are held out of the SpawnManager for the whole run (spawns.debug.
// holdGamePresets: the director's own events never move a baseline); each check puts back only what
// it shows: the preset, a combo's members, and the site presets its place needs (the site feed then
// builds those sites as the craft nears them). The butterfly and caribou presets (51, 52) of the
// migration convergence belong to another batch: until they are in the build, dev fixtures of those
// ids stand in, given to a restarted director, so the combo's optional members can be proven.
//
// Every combo is staged through the F9 debugger's own path (comboStaging.js: prepareCombo, then
// forceCombo after the baselines), so the owner's manual check is the one proven here. Per preset:
//   - the frozen lake on its REAL site: stamps, the ice body (the water query's solid ice at the
//     centre), the ridges' colliders (a sphere swept through a ridge hits it), a craft flown into a
//     ridge soft-crashes with 'structure strike' and never passes through, discovery;
//   - every combo: comboStarted with its members in order, each member live with the combo as its
//     parent, and its own behaviour (the aurora's strength, the volcano's lightning, the eclipse's
//     totality over the stones, the comet's fragments and debris, the valley and the late caribou,
//     the arcs and the spires' resonance, the beacon chain over several lighthouses);
//   - the midnight sun: the sun above the horizon at midnight at full weight, and below it again once
//     the forced night is released;
//   - after each: GPU memory, wind sources, colliders, sky modifiers, lights and leaks back to the
//     baseline (spawnCheckKit.js, the one dispose check of the spawn checks).
// Every failed check calls console.error, so the smoke run fails.
import { createBrowserHelpers } from './structureTestKit.js';
import { createDisposeCheck, frames, holdConditions, wait } from './spawnCheckKit.js';
import { COMBO_STAGING, forceCombo, prepareCombo } from './comboStaging.js';
import { PRESETS } from '../spawns/presets/index.js';

const FIXTURE_CALLOUTS = Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Dev fixture: {name}.']);

/** Dev fixtures of the migration convergence's optional members, used only while their presets are missing. */
function memberFixture(id) {
  const base = {
    id,
    kind: 'event',
    rarity: 'uncommon',
    heavy: false,
    candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 900, chance: 0.05 }),
    filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
    lod: Object.freeze({ near: 2000, mid: 5000, far: 10000 }),
    lure: null,
    wind: Object.freeze([]),
    audio: null,
    discovery: Object.freeze({ radius: 1500, requireInView: true }),
    callouts: FIXTURE_CALLOUTS,
    lifetime: Object.freeze({ duration: Object.freeze([300, 420]), despawn: Object.freeze({ distance: 9000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
  };
  if (id === 'butterflyMigration') {
    return Object.freeze({
      ...base,
      name: 'Butterfly migration (dev fixture)',
      category: 'wildlife',
      engines: Object.freeze([Object.freeze({ engine: 'lightEffect', params: Object.freeze({ swarm: Object.freeze({ count: 1200, radius: 260, height: Object.freeze([2, 30]), size: Object.freeze([0.6, 1]), colors: Object.freeze([0xffb347, 0xff8c1a, 0xfff07a]), intensity: 3, blink: Object.freeze({ period: Object.freeze([3, 6]), duty: 0.9 }), sync: 0, wander: Object.freeze({ radius: 8, speed: 0.3, vertical: 0.6 }) }), visibility: Object.freeze({ day: 1, night: 1 }) }) })]),
      journal: Object.freeze({ title: 'Butterfly migration (dev fixture)', description: 'A dev fixture until the batch 51-60 presets are merged.' }),
    });
  }
  return Object.freeze({
    ...base,
    name: 'Caribou migration (dev fixture)',
    category: 'wildlife',
    engines: Object.freeze([Object.freeze({ engine: 'fauna', params: Object.freeze({ species: 'caribou', behavior: 'herd', count: 18 }) })]),
    journal: Object.freeze({ title: 'Caribou migration (dev fixture)', description: 'A dev fixture until the batch 51-60 presets are merged.' }),
  });
}

/** Resolves after `seconds` of wall time, frame by frame. */
async function seconds(duration) {
  const until = performance.now() + duration * 1000;
  while (performance.now() < until) await frames(1);
}

export function installPresetChecks91(game) {
  const helpers = createBrowserHelpers(game, 'presets 91-100');
  const { ctx, THREE, check, viewpoint, frameView, terrainIdle } = helpers;
  const { state } = game;
  const system = ctx.systems.spawns;
  const manager = system.manager;
  const dispose = createDisposeCheck(ctx, helpers);
  const presetById = new Map(PRESETS.map((preset) => [preset.id, preset]));
  const events = { discovery: [], combos: [], crashes: [], overrides: [] };
  ctx.bus.onTyped('discovery', (payload) => events.discovery.push(payload));
  ctx.bus.onTyped('comboStarted', (payload) => events.combos.push(payload));
  ctx.bus.onTyped('softCrash', (payload) => events.crashes.push(payload));
  ctx.bus.onTyped('globalOverride', (payload) => events.overrides.push(payload));
  const timeFrozenBefore = ctx.settings.get('timeFrozen');
  /** The open check of each preset: { presetId, family, baseline, comboId, mainId, prepared }. */
  const open = new Map();
  const fixtures = [];

  const ground = (x, z) => Math.max(ctx.world.groundHeight(x, z), ctx.world.WATER_LEVEL);

  /** The preset, a combo's members this build has (or the fixtures stand in for) and the sites its place needs. */
  function familyOf(presetId) {
    const preset = presetById.get(presetId) ?? manager.getPreset(presetId);
    const family = [preset];
    for (const member of preset.combo ? preset.combo.members : []) {
      const memberPreset = presetById.get(member.presetId) ?? fixtures.find((fixture) => fixture.id === member.presetId) ?? null;
      if (memberPreset && !family.includes(memberPreset)) family.push(memberPreset);
    }
    const staging = COMBO_STAGING[presetId];
    if (staging && staging.place.kind === 'site') family.push(presetById.get(staging.place.presetId));
    if (preset.combo && preset.combo.members.some((member) => member.presetId === 'supercell')) {
      if (!family.includes(presetById.get('supercell'))) family.push(presetById.get('supercell'));
    }
    return family;
  }

  function addFamily(family) {
    for (const preset of family) if (!manager.getPreset(preset.id)) manager.addPreset(preset);
  }

  function removeFamily(family) {
    for (const preset of family) if (!fixtures.includes(preset)) manager.removePreset(preset.id);
  }

  /** The live spawns of a combo (its own and its members'), by parent. */
  function comboSpawns(comboId) {
    return manager.getActive().filter((spawn) => spawn.parent === comboId);
  }

  function partOf(spawnId, engine) {
    return (manager.getParts(spawnId) ?? []).find((part) => part.engine === engine) ?? null;
  }

  const api = {
    results: helpers.results,

    /** Holds the game's presets and puts in the member fixtures this build lacks (a restarted director knows them). */
    setup() {
      system.debug.holdGamePresets();
      for (const id of ['butterflyMigration', 'caribouMigration']) {
        if (presetById.has(id)) continue;
        const fixture = memberFixture(id);
        system.debug.addPreset(fixture);
        fixtures.push(fixture);
      }
      if (fixtures.length > 0) system.debug.restartSpawns({ extraPresets: fixtures });
      return check('setup: game presets held, member fixtures in place', Boolean(system.director), { fixtures: fixtures.map((fixture) => fixture.id), tracked: dispose.tracker !== null });
    },

    /** The time of day (sun elevation, or a dayTime) and the regional weather, held. */
    async conditions({ sun = 20, morning = false, weather = 'clear', dayTime = null } = {}) {
      const line = holdConditions(ctx, { sun, morning, weather });
      if (Number.isFinite(dayTime)) ctx.systems.sky.setDayTime(dayTime, { transition: 0 });
      await frames(8);
      return line;
    },

    /**
     * The frozen lake on its nearest REAL site: the craft flies there, the site feed builds it; the
     * baseline is read before the site exists, so the end check proves its dispose.
     */
    async frozenLake(view = {}) {
      const presetId = 'frozenLake';
      const family = familyOf(presetId);
      const site = manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, 120000);
      if (!site) return check('frozenLake: a real site', false, 'no frozen lake within 120 km of the start');
      ctx.setPhotoMode(false);
      ctx.systems.flight.resetTo({ x: site.x - 2400, y: site.groundY + 600, z: site.z - 2400, heading: 45 });
      await frames(3);
      await terrainIdle();
      const baseline = await dispose.baseline({ waitTerrain: false });
      const discoveriesBefore = events.discovery.length;
      addFamily(family);
      ctx.systems.flight.resetTo({ x: site.x - 600, y: site.groundY + 300, z: site.z - 600, heading: 45 });
      let spawnId = null;
      const started = performance.now();
      while (!spawnId && performance.now() - started < 60000) {
        await frames(5);
        spawnId = manager.getSiteSpawn(site.id);
      }
      open.set(presetId, { presetId, family, baseline, mainId: spawnId, site });
      const body = site.waters[0];
      const sample = { height: 0, normalX: 0, normalY: 0, normalZ: 0, velocityX: 0, velocityY: 0, velocityZ: 0, kind: 'none', bodyId: null, material: 'water', depth: 0 };
      ctx.waterQuery.sample(site.stamps[0].x, site.stamps[0].z, state.time.elapsed, sample);
      const part = spawnId ? partOf(spawnId, 'structure') : null;
      const colliders = part ? part.colliderIds.length : 0;
      const target = { x: site.stamps[0].x, y: body.level + (view.lift ?? 2), z: site.stamps[0].z };
      const settled = await frameView(viewpoint(target, view.distance ?? 380, view.height ?? 70, view.bearing ?? 200), target);
      let discovery = null;
      const waitStarted = performance.now();
      while (!discovery && performance.now() - waitStarted < 20000) {
        discovery = events.discovery.slice(discoveriesBefore).find((payload) => payload.id === site.id) ?? null;
        await frames(5);
      }
      return check('frozenLake: built on its real site, an ice body solid at its centre, ridge colliders, discovered',
        Boolean(spawnId) && body.material === 'ice' && sample.material === 'ice' && Math.abs(sample.height - body.level) < 0.05 && colliders >= 6 && Boolean(discovery),
        { site: site.id, stamps: site.stamps.map((stamp) => stamp.type), level: Math.round(body.level * 10) / 10, sample: { kind: sample.kind, material: sample.material, height: Math.round(sample.height * 10) / 10 }, colliders, terrainSettled: settled, discovered: discovery ? discovery.name : null });
    },

    /**
     * The frozen lake's ridges are solid: a sphere swept across a ridge's middle hits its collider, and
     * the bush plane flown into it at speed soft-crashes with 'structure strike' instead of passing.
     */
    async ridgeStrike() {
      const record = open.get('frozenLake');
      const part = record && record.mainId ? partOf(record.mainId, 'structure') : null;
      if (!part || part.colliderIds.length === 0) return check('frozenLake: ridge strike', false, 'no ridge colliders');
      // The longest ridge stretch (a capsule's ends, world space).
      let ridge = null;
      let longest = 0;
      for (const id of part.colliderIds) {
        const record = ctx.colliders.get(id);
        if (!record || record.type !== 'capsule') continue;
        const ends = record.ends;
        const span = Math.hypot(ends[3] - ends[0], ends[5] - ends[2]);
        if (span > longest) {
          longest = span;
          ridge = record;
        }
      }
      if (!ridge || longest < 4) return check('frozenLake: ridge strike', false, 'no ridge stretch longer than 4 m');
      const a = { x: ridge.ends[0], y: ridge.ends[1], z: ridge.ends[2] };
      const b = { x: ridge.ends[3], y: ridge.ends[4], z: ridge.ends[5] };
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      const alongX = b.x - a.x;
      const alongZ = b.z - a.z;
      const length = Math.hypot(alongX, alongZ) || 1;
      const acrossX = -alongZ / length;
      const acrossZ = alongX / length;
      const hit = { t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), id: null, owner: null, tags: null, velocity: new THREE.Vector3() };
      const from = new THREE.Vector3(middle.x - acrossX * 40, middle.y, middle.z - acrossZ * 40);
      const to = new THREE.Vector3(middle.x + acrossX * 40, middle.y, middle.z + acrossZ * 40);
      const swept = ctx.colliders.sweepSphere(from, to, 0.5, { sensors: false, landableTops: true }, hit);
      // The craft, out of photo mode, 90 m short of the ridge, heading across it, its body just over the
      // ridge's crest so its landing gear (contact probes) meets the ridge clear of the ice.
      ctx.setPhotoMode(false);
      const crashesBefore = events.crashes.length;
      const heading = (Math.atan2(acrossX, -acrossZ) * 180) / Math.PI;
      ctx.systems.flight.resetTo({ x: from.x - acrossX * 50, y: middle.y + ridge.shape[0] + 0.3, z: from.z - acrossZ * 50, heading });
      const started = performance.now();
      while (events.crashes.length === crashesBefore && performance.now() - started < 8000) await frames(1);
      const crash = events.crashes.slice(crashesBefore)[0] ?? null;
      const player = state.player.position;
      const passed = (player.x - middle.x) * acrossX + (player.z - middle.z) * acrossZ;
      return check("frozenLake: a ridge is solid (a swept sphere hits it; a craft flown into it soft-crashes 'structure strike', never through)",
        swept && hit.id === ridge.id && crash !== null && crash.reason === 'structure strike' && passed < 5,
        { swept, hitId: hit.id, ridge: ridge.id, crash: crash ? { reason: crash.reason, speed: Math.round(crash.impactSpeed) } : null, beyondRidge: Math.round(passed * 10) / 10 });
    },

    /**
     * Stages a combo (or the midnight sun) through the F9 debugger's path: its conditions, place,
     * viewpoint and wake-ups, then the baselines, then the force. Runs `runSeconds` after it.
     */
    async combo(presetId, { runSeconds = 3 } = {}) {
      const family = familyOf(presetId);
      addFamily(family);
      let prepared = null;
      try {
        prepared = await prepareCombo(ctx, presetId);
      } catch (error) {
        removeFamily(family);
        return check(`${presetId}: staged`, false, error && error.message ? error.message : String(error));
      }
      await terrainIdle();
      const baseline = await dispose.baseline({ waitTerrain: false });
      const combosBefore = events.combos.length;
      const comboId = forceCombo(ctx, prepared);
      const record = { presetId, family, baseline, comboId, prepared, mainId: null };
      open.set(presetId, record);
      await seconds(runSeconds);
      const preset = presetById.get(presetId);
      if (preset.override) {
        const instances = manager.getActive().filter((spawn) => spawn.presetId === presetId);
        record.mainId = instances.length > 0 ? instances[0].id : null;
        return check(`${presetId}: the override is scheduled on this night`, comboId === `override:${presetId}`, { id: comboId, place: prepared.place.label, view: prepared.view });
      }
      const started = events.combos.slice(combosBefore).find((event) => event.id === comboId) ?? null;
      const spawns = comboSpawns(comboId);
      const main = spawns.find((spawn) => spawn.presetId === presetId) ?? null;
      record.mainId = main ? main.id : null;
      const expected = preset.combo.members.filter((member) => manager.getPreset(member.presetId)).map((member) => member.presetId);
      return check(`${presetId}: staged at ${prepared.place.label} and forced; comboStarted lists its members in order`,
        Boolean(main) && Boolean(started) && JSON.stringify(started.members) === JSON.stringify(expected),
        { id: comboId, members: started ? started.members : null, expected, live: spawns.map((spawn) => spawn.presetId), view: prepared.view, woke: prepared.woke });
    },

    /** Waits (up to `seconds`) for every member a combo names (that this build has) to be live with the combo as parent. */
    async members(presetId, { wait: waitSeconds = 20 } = {}) {
      const record = open.get(presetId);
      const preset = presetById.get(presetId);
      const expected = preset.combo.members.filter((member) => manager.getPreset(member.presetId)).map((member) => member.presetId);
      const started = performance.now();
      let live = [];
      while (performance.now() - started < waitSeconds * 1000) {
        live = comboSpawns(record.comboId).map((spawn) => spawn.presetId);
        if (expected.every((id) => live.includes(id))) break;
        await frames(5);
      }
      return check(`${presetId}: every member live with the combo as its parent`, expected.every((id) => live.includes(id)), { expected, live, delayed: preset.combo.members.filter((member) => member.delay).map((member) => `${member.presetId} ${member.delay} s`) });
    },

    /** The aurora night: the sky modifier's aurora at full and the curtains strong where it is dark. */
    async aurora(presetId) {
      await seconds(2);
      const record = open.get(presetId);
      const part = record.mainId ? partOf(record.mainId, 'celestial') : null;
      if (part) part.data.startTime -= 40;
      await seconds(2);
      const sky = ctx.systems.sky.getModifierState();
      return check(`${presetId}: the aurora at full strength`, sky.aurora > 0.9 && sky.auroraStrength > 0.6, { aurora: Math.round(sky.aurora * 100) / 100, auroraStrength: Math.round(sky.auroraStrength * 100) / 100, sun: Math.round(state.time.sunElevation) });
    },

    /** The volcano's eruption is on, and the combo's lightning strikes in its ash. */
    async volcanoLightning(presetId) {
      const record = open.get(presetId);
      const site = record.prepared.woke ? manager.getInstance(record.prepared.woke) : null;
      const part = record.mainId ? partOf(record.mainId, 'lightEffect') : null;
      const engine = manager.registry.get('lightEffect');
      const before = part ? engine.describe(part).strikes.strikes : 0;
      const started = performance.now();
      while (part && engine.describe(part).strikes.strikes - before < 2 && performance.now() - started < 20000) await frames(2);
      const strikes = part ? engine.describe(part).strikes.strikes - before : 0;
      return check(`${presetId}: the volcano erupting, lightning in its ash`, Boolean(site) && site.active === true && strikes >= 2, { volcano: site ? { id: site.id, active: site.active } : null, strikes });
    },

    /** The eclipse member at totality over the stones: the world dark, the stones' ring of lights read bright. */
    async totality(presetId) {
      const record = open.get(presetId);
      const member = comboSpawns(record.comboId).find((spawn) => spawn.presetId === 'totalSolarEclipse') ?? null;
      const eclipse = member ? partOf(member.id, 'celestial') : null;
      if (!eclipse) return check(`${presetId}: totality`, false, 'no eclipse member');
      const data = eclipse.data;
      const params = data.params.eclipse;
      const lead = (data.duration - params.crossingSeconds) * 0.5;
      data.startTime = state.time.elapsed - (lead + params.crossingSeconds * 0.5);
      await frames(30);
      const described = manager.registry.get('celestial').describe(eclipse);
      const glows = record.mainId ? manager.registry.get('lightEffect').describe(partOf(record.mainId, 'lightEffect')) : null;
      const sky = ctx.systems.sky.getModifierState();
      return check(`${presetId}: totality over the stones, their ring of lights lit`, described.eclipse.uncovered < 0.05 && sky.darkness > 0.5 && glows !== null && glows.points >= 13 && glows.level > 0.6,
        { uncovered: Math.round(described.eclipse.uncovered * 1000) / 1000, darkness: Math.round(sky.darkness * 100) / 100, glows: glows ? { points: glows.points, level: Math.round(glows.level * 100) / 100 } : null });
    },

    /** The comet breakup moved past its split: the nucleus flared, the fragments drifting, debris streaking. */
    async breakup(presetId) {
      const record = open.get(presetId);
      const part = record.mainId ? partOf(record.mainId, 'celestial') : null;
      if (!part) return check(`${presetId}: breakup`, false, 'no celestial part');
      part.data.startTime -= part.data.params.comet.breakup.start + 45;
      const engine = manager.registry.get('celestial');
      const started = performance.now();
      while (engine.describe(part).meteorsActive < 2 && performance.now() - started < 20000) await frames(2);
      const described = engine.describe(part);
      return check(`${presetId}: the comet split, its fragments drifting, debris streaking from it`, described.comet.fragmentsShown >= 5 && described.comet.split > 0 && described.meteorsSpawned > 0,
        { comet: described.comet, meteorsActive: described.meteorsActive, meteorsSpawned: described.meteorsSpawned });
    },

    /** The migration met in a valley: the combo's spot is the lowest dry ground near it, its members around it. */
    valley(presetId) {
      const record = open.get(presetId);
      const main = record.mainId ? manager.getInstance(record.mainId) : null;
      if (!main) return check(`${presetId}: valley`, false, 'no live spawn');
      const anchor = main.anchor;
      const anchorY = ctx.world.groundHeight(anchor.x, anchor.z);
      let lower = 0;
      for (let index = 0; index < 16; index++) {
        const angle = (index / 16) * Math.PI * 2;
        const y = ctx.world.groundHeight(anchor.x + Math.sin(angle) * 400, anchor.z - Math.cos(angle) * 400);
        if (y < anchorY - 1 && y > ctx.world.WATER_LEVEL + 4) lower++;
      }
      const members = comboSpawns(record.comboId).filter((spawn) => spawn.id !== record.mainId).map((spawn) => {
        const memberAnchor = manager.getInstance(spawn.id).anchor;
        return { presetId: spawn.presetId, distance: Math.round(Math.hypot(memberAnchor.x - anchor.x, memberAnchor.z - anchor.z)) };
      });
      return check(`${presetId}: the combo stands in a valley (no dry ground 400 m round it lower), its members around it`, lower <= 3 && members.every((member) => member.distance < 1600),
        { anchorY: Math.round(anchorY), lowerAround: lower, members });
    },

    /** The arcs found the spires' tips and leap, and the spires' glow resonates. */
    async arcs(presetId) {
      const record = open.get(presetId);
      const part = record.mainId ? partOf(record.mainId, 'lightEffect') : null;
      if (!part) return check(`${presetId}: arcs`, false, 'no light effect');
      const engine = manager.registry.get('lightEffect');
      const before = engine.describe(part).strikes.arcs;
      const started = performance.now();
      while (engine.describe(part).strikes.arcs - before < 3 && performance.now() - started < 20000) await frames(2);
      const described = engine.describe(part);
      const target = part.data.arcTarget;
      return check(`${presetId}: arcs leap between the spires' tips and the spires resonate`, described.arcTarget >= 3 && described.strikes.arcs - before >= 3 && described.resonance > 1.5 && target !== null && target.params.glow > 1.5,
        { arcPoints: described.arcTarget, arcs: described.strikes.arcs - before, resonance: Math.round(described.resonance * 100) / 100, spiresGlow: target ? Math.round(target.params.glow * 100) / 100 : null });
    },

    /** The beacon chain stands on several lighthouses and lights them one after another. */
    async chain(presetId) {
      const record = open.get(presetId);
      const part = record.mainId ? partOf(record.mainId, 'lightEffect') : null;
      if (!part) return check(`${presetId}: chain`, false, 'no light effect');
      const glow = part.data.config.glows.find((entry) => entry.chain);
      const lit = part.data.chainStart + glow.chain.delay + glow.chain.interval * 2.5;
      const started = performance.now();
      while (state.time.elapsed < lit && performance.now() - started < 20000) await frames(2);
      const described = manager.registry.get('lightEffect').describe(part);
      const lighthouses = described.landmarks.find((count) => count !== null) ?? 0;
      const steps = part.data.chainFired[part.data.config.glows.indexOf(glow)];
      return check(`${presetId}: the beacon chain stands on the lighthouses in sight and lights them in turn`, lighthouses >= 2 && described.beam === true && (steps >= 2 || !part.data.voice),
        { lighthouses, beam: described.beam, chainSteps: steps, voice: part.data.voice !== null });
    },

    /** The midnight sun at full weight: the sun up at midnight; released, it sets again. */
    async midnightSun(presetId) {
      const started = performance.now();
      let entry = null;
      while (performance.now() - started < 20000) {
        entry = system.director.getOverrides().find((candidate) => candidate.presetId === presetId) ?? null;
        if (entry && entry.weight >= 0.95) break;
        await frames(5);
      }
      await frames(10);
      const bent = state.time.sunElevation;
      const dayTime = state.time.dayTime;
      const released = system.director.releaseOverride(presetId);
      const releasedAt = performance.now();
      while (state.time.sunElevation > -5 && performance.now() - releasedAt < 10000) await frames(5);
      const after = state.time.sunElevation;
      return check(`${presetId}: the sun skims the horizon at midnight (above it at full weight), and sets again once released`, entry !== null && entry.weight >= 0.95 && bent > 0.5 && bent < 4 && released && after < -5,
        { weight: entry ? Math.round(entry.weight * 100) / 100 : null, dayTime: Math.round(dayTime * 1000) / 1000, sunBent: Math.round(bent * 10) / 10, sunReleased: Math.round(after * 10) / 10, globalOverride: events.overrides.length });
    },

    /**
     * Frames an open check: view.mode 'sky' (from the craft toward view.direction { azimuth, elevation },
     * or the main spawn's sky anchor), 'sun' (toward the sun), 'antisolar' (down-sun from beside the
     * craft), or the world (target = the place plus lift, from distance and height at bearing).
     */
    async frame(presetId, view = {}) {
      const record = open.get(presetId);
      if (!record) return check(`${presetId}: framed`, false, 'not open');
      const player = state.player.position;
      const mode = view.mode ?? 'world';
      if (mode === 'sky' || mode === 'sun' || mode === 'antisolar') {
        ctx.setPhotoMode(true);
        await frames(2);
        const position = new THREE.Vector3(player.x, player.y + 20, player.z);
        let direction;
        if (view.direction) {
          const azimuth = (view.direction.azimuth * Math.PI) / 180;
          const elevation = (view.direction.elevation * Math.PI) / 180;
          direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
        } else if (mode === 'sun') {
          direction = state.time.sunDirection.clone();
        } else if (mode === 'antisolar') {
          direction = state.time.sunDirection.clone().multiplyScalar(-1);
          direction.y = Math.max(direction.y + 0.12, 0.05);
          direction.normalize();
        } else {
          const anchor = record.mainId ? manager.getInstance(record.mainId).anchor : null;
          direction = anchor ? new THREE.Vector3(anchor.x - position.x, anchor.y - position.y, anchor.z - position.z).normalize() : new THREE.Vector3(0, 1, 0);
        }
        const target = position.clone().addScaledVector(direction, 1000);
        ctx.systems.camera.setFreeCameraPose({ position, target, fov: view.fov });
        await frames(30);
        return check(`${presetId}: framed (${mode})`, true, { direction: { x: Math.round(direction.x * 100) / 100, y: Math.round(direction.y * 100) / 100, z: Math.round(direction.z * 100) / 100 } });
      }
      const place = record.prepared ? record.prepared.place : record.site;
      const target = { x: place.x, y: ground(place.x, place.z) + (view.lift ?? 40), z: place.z };
      const settled = await frameView(viewpoint(target, view.distance ?? 900, view.height ?? 160, state.player.heading + (view.bearing ?? 200)), target, { fov: view.fov });
      return check(`${presetId}: framed`, true, { terrainSettled: settled, target: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) } });
    },

    /**
     * Ends an open check: the combo's spawns (or the site's, or the override's preset) end, the family
     * leaves the manager, and the dispose check proves GPU memory, wind sources, colliders, sky
     * modifiers, lights and leaks back to the baseline.
     */
    async end(presetId) {
      const record = open.get(presetId);
      if (!record) return check(`${presetId}: ended`, false, 'not open');
      open.delete(presetId);
      ctx.setPhotoMode(false);
      if (record.comboId && !record.comboId.startsWith('override:')) {
        for (const spawn of comboSpawns(record.comboId)) manager.deactivate(spawn.id, 'test');
      }
      if (presetById.get(presetId).override) {
        system.director.releaseOverride(presetId);
        for (const spawn of manager.getActive()) if (spawn.presetId === presetId) manager.deactivate(spawn.id, 'test');
      }
      if (record.prepared && record.prepared.woke && manager.getInstance(record.prepared.woke)) manager.setSiteActive(record.prepared.woke, false);
      removeFamily(record.family);
      await wait(500);
      const result = await dispose.compare(record.baseline, { presetIds: record.family.map((preset) => preset.id) });
      return check(`${presetId}: dispose returns GPU memory, removes its wind sources, colliders and sky modifiers`, result.ok, {
        before: result.before, after: result.after, worldFirstDrawn: result.worldFirstDrawn, leftBehind: result.leftBehind,
        windSources: result.windSources, windLeft: result.windLeft, colliders: result.colliders, collidersLeft: result.collidersLeft,
        skyModifiers: result.skyModifiers, lights: result.lights, leaks: result.leaks,
      });
    },

    /** The summary check; gives the presets, the weather, the clock and the renderer's geometry manager back. */
    finish() {
      dispose.restore();
      for (const fixture of fixtures) manager.removePreset(fixture.id);
      system.debug.releaseGamePresets();
      ctx.systems.weather.forceState(null);
      ctx.settings.set('timeFrozen', timeFrozenBefore);
      return helpers.finish();
    },
  };
  window.__dwPresets91 = api;
  return api;
}
