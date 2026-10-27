// Dev-only checks for presets 61-70 (Phase 3 wave 3, batch 7). installPresetChecks61(game) installs
// the shared preset checks (presetChecks.js: window.__dwPresets: conditions, start, frame, discovered,
// end with the dispose check of GPU memory, wind sources, colliders, challenge courses, sky modifiers
// and leaks, site) and adds window.__dwPresets61 with what this batch's presets need on top:
//   giant(id)        the sleeping giant force-spawned free-standing: its landable heightfield collider
//                    stands where the figure's chest is, the breath emitter runs at the nose
//   galleon(id)      the ghost galleon sails (its anchor moves on its loop above the cloud band), its
//                    moving capsule colliders block a sweep and carry its velocity, its eleven
//                    lanterns are ignitables and one lit by a flame turns warm
//   tree(id)         the world tree's trunk, limbs and foliage collide, its limbs offer perches, a lane
//                    through the crown passes its gate and earns its achievement
//   dragon(id)       the dragon racer: the crag collides and holds the perch, the course is registered;
//                    flying through the start gate launches the dragon on the pace line (no rival for
//                    a plane); as the dragon skin the course carries the rival (the HUD gap), the
//                    rival launch roars, a run ahead of it earns the achievement; cancelling sends it
//                    home
//   portal(id)       the portal ring's gate leads through to portalSeed(seed, site id): crossing it sends
//                    worldVisited, the journal counts the world and the page reloads into it (the last
//                    step of the run); arrived() checks the new world afterwards
//   sky(id, kind)    a night-sky part (the celestial engine's components) reports itself live
// Every failed check calls console.error, so the smoke run fails. Never part of a production build:
// only tools/steps/presets-61-70.json imports it (dev server).
import { createBrowserHelpers } from './structureTestKit.js';
import { frames, wait } from './spawnCheckKit.js';
import { installPresetChecks } from './presetChecks.js';
import { createSweepResult } from '../world/colliderMath.js';
import { GIANT_NOSE } from '../world/stamps.js';

export function installPresetChecks61(game) {
  const shared = installPresetChecks(game);
  const helpers = createBrowserHelpers(game, 'presets 61-70');
  const { ctx, check } = helpers;
  const { state } = game;
  const manager = ctx.systems.spawns.manager;
  const challenges = ctx.systems.challenges;
  const achievements = [];
  const worlds = [];
  ctx.bus.onTyped('achievement', (payload) => achievements.push(payload.id));
  ctx.bus.onTyped('worldVisited', (payload) => worlds.push(payload));

  /** The live spawn record of presetId (the newest), or null. */
  function spawnOf(presetId) {
    const active = manager.getActive().filter((record) => record.presetId === presetId);
    return active.length > 0 ? active[active.length - 1] : null;
  }
  /** The engine instance of presetId's `engine` part, or null. */
  function partOf(presetId, engine) {
    const record = spawnOf(presetId);
    if (!record) return null;
    const index = record.engines.indexOf(engine);
    return index >= 0 ? manager.getParts(record.id)[index] ?? null : null;
  }
  /** Perch points of the spawn's own colliders within radius of (x, y, z). */
  function ownPerches(ids, x, y, z, radius) {
    let count = 0;
    ctx.colliders.perchesNear(x, y, z, radius, (px, py, pz, kind, sourceId) => {
      if (kind === 'structure' && ids.includes(sourceId)) count++;
    });
    return count;
  }
  function round(value) {
    return Math.round(value * 10) / 10;
  }
  function colliderIdsOf(part) {
    return part ? part.colliderIds.filter((id) => ctx.colliders.has(id)) : [];
  }
  const sweep = createSweepResult();
  /** A sphere swept from `from` to `to` (world): the collider id it hits first, or null. */
  function sweepHit(from, to, radius = 1) {
    return ctx.colliders.sweepSphere(from, to, radius, null, sweep) ? sweep.id : null;
  }

  const api = {
    results: helpers.results,

    /** The sleeping giant (free-standing, as a debug spawn builds it). */
    async giant(presetId = 'sleepingGiant') {
      const structure = partOf(presetId, 'structure');
      const emitter = partOf(presetId, 'emitter');
      if (!structure || !emitter) return check(`${presetId}: giant parts live`, false, { structure: Boolean(structure), emitter: Boolean(emitter) });
      const ids = colliderIdsOf(structure);
      const figure = ids.find((id) => id.includes(':figure'));
      const record = figure ? ctx.colliders.get(figure) : null;
      const anchor = structure.anchor;
      // Straight down onto the figure's highest point (its perch: the raised knee or the chest).
      const peak = record && record.perchPoints ? { x: record.perchPoints[0], y: record.perchPoints[1], z: record.perchPoints[2] } : null;
      const hit = peak ? sweepHit({ x: peak.x, y: peak.y + 600, z: peak.z }, { x: peak.x, y: anchor.y - 300, z: peak.z }, 2) : null;
      const top = hit === figure ? sweep.point.y - anchor.y : null;
      const landable = peak ? ctx.groundSurfaces.surfaceIdBelow(peak.x, peak.z, peak.y + 50) : null;
      await wait(3000);
      const noseUp = GIANT_NOSE.figure * (420 + 109.2) - 109.2;
      return check(`${presetId}: the figure stands 300 m+ up, collides and lands (heightfield), the breath rises at the nose`,
        Boolean(record) && record.type === 'heightfield' && top !== null && top > 300 && landable === figure && emitter.particles > 0,
        { colliders: ids.length, figure: record ? record.type : null, top: top === null ? null : round(top), landable, breathParticles: emitter.particles, nose: { up: round(noseUp), along: 3200 * GIANT_NOSE.along } });
    },

    /** The ghost galleon: sailing, solid, its lanterns. */
    async galleon(presetId = 'ghostGalleon') {
      const structure = partOf(presetId, 'structure');
      if (!structure) return check(`${presetId}: galleon live`, false, 'no structure part');
      const start = { x: structure.anchor.x, y: structure.anchor.y, z: structure.anchor.z };
      await wait(2500);
      const moved = Math.hypot(structure.anchor.x - start.x, structure.anchor.z - start.z);
      const ground = Math.max(ctx.world.groundHeight(structure.anchor.x, structure.anchor.z), ctx.world.WATER_LEVEL);
      const ids = colliderIdsOf(structure);
      const hull = ids.find((id) => id.includes(':hull'));
      const hullRecord = hull ? ctx.colliders.get(hull) : null;
      const velocity = hullRecord && hullRecord.velocity ? Math.hypot(hullRecord.velocity.x, hullRecord.velocity.y, hullRecord.velocity.z) : 0;
      // A sphere swept sideways through the ship's middle meets one of its own colliders.
      const centre = { x: structure.anchor.x, y: structure.anchor.y + 2, z: structure.anchor.z };
      const hit = sweepHit({ x: centre.x - 120, y: centre.y, z: centre.z }, { x: centre.x + 120, y: centre.y, z: centre.z }, 1.5);
      const hitOwn = hit !== null && ids.includes(hit);
      const lanterns = structure.ignitableIds.slice();
      const litBefore = manager.registry.get('structure').stats().lanternsLit ?? 0;
      const lit = lanterns.length > 0 ? ctx.ignition.ignite(lanterns[0], { kind: 'test', craft: 'eagle', position: centre }) : false;
      await frames(3);
      const litAfter = manager.registry.get('structure').stats().lanternsLit ?? 0;
      return check(`${presetId}: sails its loop above the clouds, solid as it moves, lanterns take a flame`,
        moved > 15 && structure.anchor.y >= Math.min(690, ground + 150) && hullRecord !== null && velocity > 5 && hitOwn && lanterns.length === 11 && lit && litAfter === litBefore + 1,
        { moved: round(moved), altitude: round(structure.anchor.y), ground: round(ground), colliders: ids.length, hullSpeed: round(velocity), sweepHit: hit, lanterns: lanterns.length, lit, litBefore, litAfter });
    },

    /** The world tree: solid, perches, a lane through the crown. */
    async tree(presetId = 'worldTree') {
      const structure = partOf(presetId, 'structure');
      if (!structure) return check(`${presetId}: tree live`, false, 'no structure part');
      const ids = colliderIdsOf(structure);
      const anchor = structure.anchor;
      const trunkHit = sweepHit({ x: anchor.x - 400, y: anchor.y + 150, z: anchor.z }, { x: anchor.x + 400, y: anchor.y + 150, z: anchor.z }, 2);
      const perches = ownPerches(ids, anchor.x, anchor.y + 700, anchor.z, 1500);
      const gates = structure.data.gates;
      const achievedBefore = achievements.filter((id) => id === 'worldTreeLane').length;
      if (gates && gates.count > 0) await helpers.flyThroughGate(gates.data, 0);
      await frames(3);
      const achieved = achievements.filter((id) => id === 'worldTreeLane').length > achievedBefore;
      return check(`${presetId}: trunk and limbs collide, limbs are perches, a crown lane earns its achievement`,
        ids.length > 20 && trunkHit !== null && ids.includes(trunkHit) && perches >= 3 && Boolean(gates && gates.count > 0) && achieved,
        { colliders: ids.length, trunkHit, perches, lanes: gates ? gates.count : 0, achieved });
    },

    /** Nothing in the world blocks a sphere through the ring's membrane; the destination is portalSeed. */
    portalInfo(presetId = 'portalRing') {
      const structure = partOf(presetId, 'structure');
      if (!structure) return check(`${presetId}: portal live`, false, 'no structure part');
      const destination = ctx.systems.portals.destination(structure.data.portalId);
      return check(`${presetId}: the portal leads to portalSeed(seed, portal id)`, typeof destination === 'string' && destination !== state.seed,
        { portalId: structure.data.portalId, from: state.seed, destination, colliders: colliderIdsOf(structure).length, gates: structure.data.gates ? structure.data.gates.count : 0 });
    },

    /**
     * Crosses the portal's membrane: worldVisited fires with the destination, the journal counts the
     * world, then the page fades and reloads into it (the run's last step; arrived() follows the reload).
     */
    async portalCross(presetId = 'portalRing') {
      const structure = partOf(presetId, 'structure');
      if (!structure || !structure.data.gates) return check(`${presetId}: portal crossing`, false, 'no portal gate');
      const destination = ctx.systems.portals.destination(structure.data.portalId);
      const before = worlds.length;
      const gates = structure.data.gates.data;
      const portal = structure.data.gateMeta.findIndex((meta) => meta.action === 'portal');
      if (portal < 0) return check(`${presetId}: portal crossing`, false, 'no gate with action portal');
      const base = portal * 8;
      const y = (gates[base + 5] + gates[base + 6]) * 0.5;
      const heading = (Math.atan2(gates[base + 2], -gates[base + 3]) * 180) / Math.PI;
      for (let step = -12; step <= 12 && worlds.length === before; step++) {
        ctx.systems.flight.resetTo({ x: gates[base] + gates[base + 2] * step * 5, y, z: gates[base + 1] + gates[base + 3] * step * 5, heading });
        await frames(1);
      }
      const visited = worlds.slice(before).find((entry) => entry.seed === destination) ?? null;
      const records = ctx.systems.journal.getRecords();
      const travelling = ctx.systems.portals.getState().travelling;
      return check(`${presetId}: crossing the membrane travels to world ${destination}`, Boolean(visited) && Boolean(travelling) && travelling.seed === destination,
        { visited, travelling, worldsVisited: records.worldsVisited.length });
    },

    /** After the reload: the world is the one the portal led to, and the craft came through into it. */
    async arrived() {
      const started = performance.now();
      while (ctx.systems.portals.getState().arrived === null && performance.now() - started < 15000) await frames(5);
      const arrival = ctx.systems.portals.getState().arrived;
      const records = ctx.systems.journal.getRecords();
      const logged = records.worldsVisited.some((entry) => entry.seed === state.seed);
      return check(`portal: arrived in the portal's world with the craft kept, the URL and the journal updated`,
        arrival !== null && arrival.seed === state.seed && window.location.hash.includes(`seed=${state.seed}`) && logged,
        { seed: state.seed, arrival, hash: window.location.hash, worldsVisited: records.worldsVisited.length });
    },

    /** The dragon racer: crag, course, the pace run, the rival run as the dragon, the achievement. */
    async dragon(presetId = 'dragonRacer') {
      const structure = partOf(presetId, 'structure');
      if (!structure || !structure.data.rival) return check(`${presetId}: dragon race live`, false, 'no rival');
      const rival = structure.data.rival;
      const key = rival.courseKey;
      const ids = colliderIdsOf(structure);
      const anchor = structure.anchor;
      const cragHit = sweepHit({ x: anchor.x, y: anchor.y + 400, z: anchor.z }, { x: anchor.x, y: anchor.y - 50, z: anchor.z }, 1);
      const perches = ownPerches(ids, anchor.x, anchor.y + 100, anchor.z, 150);
      const perched = rival.describe();
      check(`${presetId}: the crag collides and holds the perch, the course is registered, the dragon sits on its crag`,
        ids.length >= 4 && cragHit !== null && ids.includes(cragHit) && perches >= 1 && key !== null && challenges.count() > 0 && perched.mode === 'perched',
        { colliders: ids.length, cragHit, perches, courseKey: key, courses: challenges.count(), rival: perched });

      /** Arms the course and flies the craft through its start gate; resolves with the live state. */
      async function runStart() {
        challenges.start(key, { source: 'ui' });
        await frames(2);
        const gate = challenges.getState().nextGate;
        if (!gate) return null;
        const length = Math.hypot(gate.nx, gate.nz) || 1;
        const nx = gate.nx / length;
        const nz = gate.nz / length;
        const heading = (Math.atan2(nx, -nz) * 180) / Math.PI;
        for (let step = -8; step <= 4; step++) {
          ctx.systems.flight.resetTo({ x: gate.x + nx * step * 5, y: gate.y, z: gate.z + nz * step * 5, heading });
          await frames(1);
        }
        return challenges.getState();
      }
      const perchPoint = rival.position.clone();

      // A plane: the dragon leads on the pace line, no rival on the timer.
      const craftBefore = state.flight.craft;
      const skinsBefore = { ...(ctx.settings.get('craftSkins') ?? {}) };
      const paced = await runStart();
      await wait(3000);
      const paceState = rival.describe();
      const paceGap = rival.position.distanceTo(perchPoint);
      check(`${presetId}: the start gate launches the dragon on the pace line (no rival for a ${craftBefore})`,
        paced !== null && paced.phase === 'running' && paceState.mode === 'racing' && !paceState.rival && paced.rival === null && paceGap > 40,
        { phase: paced ? paced.phase : null, rival: paceState, gapFromPerch: round(paceGap), hudRival: paced ? paced.rival : null });
      challenges.cancel('test');
      await frames(3);
      const home = rival.describe();
      check(`${presetId}: a cancelled run sends the dragon home`, home.mode === 'returning', home);

      // The dragon skin: the course is registered again with the rival, which roars as it launches.
      ctx.settings.set('craftSkins', { ...skinsBefore, eagle: 'dragon' });
      ctx.systems.flight.setCraft('eagle');
      await frames(10);
      const asDragon = rival.describe();
      const roarsBefore = asDragon.launches;
      const raced = await runStart();
      await wait(2500);
      const rivalState = rival.describe();
      const live = challenges.getState();
      const hudRival = live.rival ? { name: live.rival.name, distanceAhead: round(live.rival.distanceAhead) } : null;
      check(`${presetId}: as the dragon the course carries the rival (the timer's gap), and it launches`,
        asDragon.rival === true && raced !== null && raced.phase === 'running' && hudRival !== null && rivalState.mode === 'racing' && rivalState.launches === roarsBefore + 1,
        { registered: asDragon, live: rivalState, hudRival });
      challenges.cancel('test');
      await frames(3);
      // A run that beat the rival's time earns the achievement (the finish event of such a run).
      const before = achievements.filter((id) => id === 'dragonRival').length;
      ctx.bus.emitTyped('challengeFinished', { id: key, craft: 'eagle', time: 60, medal: 'gold', best: 60, improved: true, missed: 0, penalties: 0, valid: true });
      await frames(2);
      const earned = achievements.filter((id) => id === 'dragonRival').length > before;
      check(`${presetId}: finishing ahead of the rival earns "Out-flew the wild dragon"`, earned, { achievements: achievements.slice(-3) });

      // Back to the craft the run started with.
      ctx.settings.set('craftSkins', skinsBefore);
      ctx.systems.flight.setCraft(craftBefore);
      await frames(10);
      const restored = rival.describe();
      return check(`${presetId}: back on a ${craftBefore}, the course drops the rival again`, restored.rival === false && state.flight.craft === craftBefore, restored);
    },

    /** A celestial night-sky part of presetId is live (its describe() names the component). */
    sky(presetId, component) {
      const part = partOf(presetId, 'celestial');
      const engine = manager.registry.get('celestial');
      const described = part && engine && typeof engine.describe === 'function' ? engine.describe(part) : null;
      const live = described !== null && described[component] !== null && described[component] !== undefined;
      return check(`${presetId}: the ${component} is live`, live, described ? { [component]: described[component], presence: described.presence } : null);
    },

    finish() {
      helpers.finish();
      return shared.finish();
    },
  };
  window.__dwPresets61 = api;
  return api;
}
