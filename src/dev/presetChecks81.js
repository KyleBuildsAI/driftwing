// Dev-only checks for presets 81-90 (Phase 3 wave 3, batch 9). installBatch81Checks(game) installs the
// shared preset checks (src/dev/presetChecks.js: force-spawn, framing, discovery, the real stamped
// site and the dispose check of GPU memory, wind sources, colliders and challenge courses) and adds the
// batch's own, each on the preset's REAL site the step before built (tools/steps/presets-81-90.json):
//   - strikes: a craft flown straight (kinematically, so the controller's own sweep, strike and crash
//     code is what is tested) into an arch leg, a hoodoo shaft or a redwood trunk ends in the soft
//     crash 'structure strike', never passes through, and no collision probe ever ends a tick inside
//     a solid collider;
//   - the five-arch run: the course the site registered is the one its challenge block describes; a
//     straight line through the five openings starts the clock at the first arch, takes the three
//     splits, finishes with a medal and touches no stone;
//   - gusts: the WindField's gusts fire the emitters' bursts (petal storms, leaf flurries, the bamboo's
//     shaken leaves) and lift their level;
//   - hours: a morning mist lies thick at dawn and thin by day;
//   - the dust devils: both vortices are wind sources with a rising, spinning core, wandering on their
//     paths;
//   - water: the rice terraces' flooded flats are local water bodies, the mangrove delta's channels
//     are open sea;
//   - the redwood grove: its trunks are colliders (the vegetation provider) and its crowns perches.
// Every failed check calls console.error, so the smoke run fails. Never part of a production build:
// only dev-server step files import it.
import { installPresetChecks } from './presetChecks.js';
import { frames, holdConditions, wait } from './spawnCheckKit.js';
import { buildSiteCourse } from '../gameplay/challenges.js';
import { createWaterSample } from '../world/waterQuery.js';

const DEG = Math.PI / 180;
const STRIKE_REASON = 'structure strike';
/** A probe deeper than this inside a solid collider is a penetration (m, as the collision test). */
const PENETRATION_TOLERANCE = 0.05;
/** A probe this little under a landable top stands on it (the ground contact's), not inside it. */
const LANDABLE_SINK = 0.5;
/** A strike run starts this far (m) from the target's surface, plus a third of a second of flight. */
const STRIKE_RUN_IN = 180;
/** Frames a run may take at most (a stuck run fails rather than hangs the step). */
const MAX_RUN_FRAMES = 2400;
/** The arch run starts this far (m) before the first arch and ends this far past the last. */
const ARCH_RUN_IN = 400;
const ARCH_RUN_OUT = 120;
/** The stored challenge records (src/gameplay/challenges.js). */
const RECORDS_KEY = 'driftwing-v2.challenges';

function round(value, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function installBatch81Checks(game) {
  const api = installPresetChecks(game);
  const { ctx, state } = game;
  const THREE = ctx.THREE;
  const manager = ctx.systems.spawns.manager;
  const colliders = ctx.colliders;
  const flight = () => ctx.systems.flight;
  const results = api.results;
  const events = { crashes: [], hits: [], started: [], gates: [], finished: [] };
  ctx.bus.onTyped('softCrash', (payload) => events.crashes.push(payload));
  ctx.bus.on('colliderHit', (payload) => events.hits.push(payload));
  ctx.bus.onTyped('challengeStarted', (payload) => events.started.push(payload));
  ctx.bus.onTyped('challengeGate', (payload) => events.gates.push(payload));
  ctx.bus.onTyped('challengeFinished', (payload) => events.finished.push(payload));
  const craftBefore = ctx.settings.get('craft');

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    results.push(line);
    if (!ok) console.error(`[presets check] ${line}`);
    return line;
  }

  function clearEvents() {
    for (const list of Object.values(events)) list.length = 0;
  }

  /** The preset's nearest real site to the start and the live spawn the site feed built for it. */
  function liveSite(presetId) {
    const site = manager.findNearestSite(presetId, state.spawn.x, state.spawn.z, 90000);
    const spawnId = site ? manager.getSiteSpawn(site.id) : null;
    return { site, spawnId, parts: spawnId ? manager.getParts(spawnId) : [] };
  }

  /** Puts the craft `height` m over the site's centre, heading `heading`, and lets the world settle. */
  async function hover(site, height = 400, heading = 0) {
    ctx.setPhotoMode(false);
    flight().resetTo({ x: site.x, y: site.groundY + height, z: site.z, heading });
    await frames(4);
  }

  // ---- Strike runs ----------------------------------------------------------------------------------
  /** The probes' world positions for the model's current pose. */
  function probePositions(model, probes) {
    const points = [];
    for (let probe = 0; probe < probes.count; probe++) {
      const offset = new THREE.Vector3(probes.offsets[probe * 3], probes.offsets[probe * 3 + 1], probes.offsets[probe * 3 + 2]);
      points.push(offset.applyQuaternion(model.state.quaternion).add(model.state.position));
    }
    return points;
  }

  /** Probes inside a solid collider (a probe just under a landable top stands on ground, as the collision test). */
  function countPenetrations(model, probes) {
    let count = 0;
    const surfaces = ctx.groundSurfaces;
    for (const point of probePositions(model, probes)) {
      const id = colliders.insideSolid(point.x, point.y, point.z, PENETRATION_TOLERANCE);
      if (id === null) continue;
      const record = colliders.get(id);
      if (record && record.tags && record.tags.landable && surfaces && surfaces.surfaceIdBelow(point.x, point.z, point.y + LANDABLE_SINK) === id) continue;
      count++;
    }
    return count;
  }

  async function useCraft(craft) {
    if (flight().getCraft() !== craft) {
      ctx.settings.set('craft', craft);
      await frames(3);
    }
    return flight().getCraft() === craft;
  }

  async function waitForCrashToEnd() {
    for (let frame = 0; frame < MAX_RUN_FRAMES && state.flight.crash.active; frame++) await frames(1);
  }

  /**
   * One kinematic run: the craft placed at start, then moved at `speed` along direction (level
   * attitude along it) by its own controller each tick, until it crashes, passes `beyond` m past aim,
   * or runs out of frames. onFrame(position) runs after every frame. Returns the run's result.
   */
  async function flyRun({ craft, speed, start, direction, aim, beyond, onFrame = null }) {
    const result = { craft, speed, crashed: false, reason: null, impactSpeed: null, penetrations: 0, hits: 0, contacts: 0, hitIds: [], timedOut: false, seconds: 0 };
    if (!(await useCraft(craft))) return { ...result, craftMissing: true };
    await waitForCrashToEnd();
    ctx.setPhotoMode(false);
    clearEvents();
    const forward = direction.clone().normalize();
    const heading = Math.atan2(forward.x, -forward.z) / DEG;
    const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    flight().resetTo({ x: start.x, y: start.y, z: start.z, heading });
    const model = flight().getModel();
    const probes = flight().getCollisionProbes();
    const velocity = forward.clone().multiplyScalar(speed);
    const attitude = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, -heading * DEG, 0, 'YXZ'));
    model.state.position.copy(start);
    model.state.quaternion.copy(attitude);
    model.state.velocity.copy(velocity);
    if (model.state.angularVelocity) model.state.angularVelocity.set(0, 0, 0);
    const original = model.step;
    let elapsed = 0;
    model.step = (dt) => {
      result.penetrations += countPenetrations(model, probes);
      elapsed += dt;
      model.state.position.addScaledVector(velocity, dt);
      model.state.velocity.copy(velocity);
      model.state.quaternion.copy(attitude);
      if (model.state.angularVelocity) model.state.angularVelocity.set(0, 0, 0);
      const contact = model.contact;
      if (contact) {
        contact.onGround = false;
        contact.touchdown = null;
        contact.bodyStrike = null;
        contact.water = false;
        contact.penetration = 0;
      }
      return undefined;
    };
    const reached = new THREE.Vector3();
    try {
      for (let frame = 0; frame < MAX_RUN_FRAMES; frame++) {
        await frames(1);
        if (onFrame) onFrame(state.player.position);
        if (events.crashes.length > 0) break;
        if (reached.copy(model.state.position).sub(aim).dot(forward) > beyond) break;
        if (frame === MAX_RUN_FRAMES - 1) result.timedOut = true;
      }
    } finally {
      model.step = original;
    }
    const crash = events.crashes.find((entry) => entry.craft === craft) ?? null;
    result.crashed = crash !== null;
    result.reason = crash ? crash.reason : null;
    result.impactSpeed = crash ? round(crash.impactSpeed) : null;
    if (crash) result.penetrations += countPenetrations(model, probes);
    result.hits = events.hits.filter((hit) => hit.crashed).length;
    result.contacts = events.hits.filter((hit) => !hit.crashed).length;
    result.hitIds = [...new Set(events.hits.map((hit) => hit.id))].slice(0, 3);
    result.seconds = round(elapsed, 2);
    await waitForCrashToEnd();
    return result;
  }

  /** A point inside the collider: its bounds' centre when that is inside, else a grid point that is. */
  function interiorPoint(record) {
    const bounds = record.bounds;
    const centre = new THREE.Vector3((bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2);
    if (colliders.insideSolid(centre.x, centre.y, centre.z) === record.id) return centre;
    const steps = 8;
    for (let column = 1; column < steps; column++) {
      for (let layer = 1; layer < steps; layer++) {
        for (let row = 1; row < steps; row++) {
          const x = bounds[0] + ((bounds[3] - bounds[0]) * column) / steps;
          const y = bounds[1] + ((bounds[4] - bounds[1]) * layer) / steps;
          const z = bounds[2] + ((bounds[5] - bounds[2]) * row) / steps;
          if (colliders.insideSolid(x, y, z) === record.id) return new THREE.Vector3(x, y, z);
        }
      }
    }
    return centre;
  }

  /**
   * A level (or gently climbing) approach into the collider whose line stays clear of the terrain and
   * meets this collider first. Returns { start, direction, aim } or null.
   */
  function approachFor(record, speed) {
    const bounds = record.bounds;
    const centre = interiorPoint(record);
    const size = Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) * 0.5;
    const distance = STRIKE_RUN_IN + speed * 0.35 + size;
    const out = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null, distance: 0 };
    for (const pitch of [0, -0.1, 0.1, -0.25]) {
      for (let bearing = 0; bearing < 24; bearing++) {
        const angle = (bearing / 24) * Math.PI * 2 + 0.2;
        const direction = new THREE.Vector3(Math.sin(angle) * Math.cos(pitch), Math.sin(pitch), -Math.cos(angle) * Math.cos(pitch));
        const start = centre.clone().addScaledVector(direction, -distance);
        let clear = true;
        for (let sample = 0; sample <= 40 && clear; sample++) {
          const point = start.clone().lerp(centre, sample / 40);
          if (point.y < Math.max(ctx.world.groundHeight(point.x, point.z), ctx.world.WATER_LEVEL) + 4) clear = false;
        }
        if (!clear || colliders.insideSolid(start.x, start.y, start.z) !== null) continue;
        if (!colliders.raycast(start, direction, distance + size, null, out) || out.id !== record.id) continue;
        return { start, direction, aim: new THREE.Vector3(out.point.x, out.point.y, out.point.z) };
      }
    }
    return null;
  }

  /** This spawn's own solid colliders (instance.colliderIds of its engine parts). */
  function ownSolids(parts) {
    const ids = new Set(parts.flatMap((part) => (Array.isArray(part.colliderIds) ? part.colliderIds : [])));
    return colliders.list().filter((entry) => ids.has(entry.id) && !entry.tags.sensor);
  }

  /** The tallest of the records whose id contains `piece`. */
  function tallest(records, piece) {
    const height = (record) => record.bounds.max.y - record.bounds.min.y;
    return records.filter((record) => record.id.includes(piece)).sort((first, second) => height(second) - height(first))[0] ?? null;
  }

  /** Vegetation trunk colliders (the provider's, contract d.4) within radius of the site at trunk height. */
  function trunksNear(site, radius) {
    const found = [];
    const centre = { x: site.x, y: site.groundY + 25, z: site.z };
    colliders.overlapSphere(centre, radius, (record) => {
      if (record.owner === 'vegetation' && !(record.tags && record.tags.sensor)) found.push(record);
    });
    return found;
  }

  async function strikeAll(presetId, record, crafts, speeds) {
    const runs = [];
    for (const craft of crafts) {
      for (const speed of speeds) {
        const full = colliders.get(record.id) ?? record;
        const approach = approachFor(full, speed);
        if (!approach) {
          runs.push({ craft, speed, approach: 'none clear' });
          continue;
        }
        runs.push(await flyRun({ craft, speed, start: approach.start, direction: approach.direction, aim: approach.aim, beyond: 60 }));
      }
    }
    await useCraft(craftBefore);
    const ok = runs.length > 0 && runs.every((run) => run.crashed && run.reason === STRIKE_REASON && run.penetrations === 0 && !run.timedOut);
    return check(`${presetId}: strikes into ${record.id} end in a structure strike, no pass-through, no probe inside`, ok, { target: record.id, runs });
  }

  // ---- The five-arch run ----------------------------------------------------------------------------
  /** The course the preset's challenge block describes on this site (what its challengeGates part registered). */
  function siteCourse(preset, site, parts) {
    const gatesPart = parts.find((part) => part.engine === 'structure' && Array.isArray(part.data.challengeKeys) && part.data.challengeKeys.length > 0);
    if (!gatesPart) return null;
    const anchor = gatesPart.anchor;
    const course = buildSiteCourse(preset.challenge, {
      presetId: preset.id,
      siteId: site.id,
      presetName: preset.name,
      anchor,
      heading: site.rotation / DEG,
      ground: (x, z) => Math.max(ctx.terrain.groundHeight(x, z), ctx.terrain.waterLevel),
    });
    return { course, keys: gatesPart.data.challengeKeys.slice() };
  }

  function clearRecords(courseKey, craft) {
    const stored = ctx.storage.read(RECORDS_KEY, null);
    if (stored && stored.courses && stored.courses[courseKey]) {
      delete stored.courses[courseKey];
      ctx.storage.write(RECORDS_KEY, stored);
    }
    ctx.storage.remove(`driftwing-v2.challengePath.${courseKey}.${craft}`);
    ctx.systems.challenges.reloadRecords();
  }

  Object.assign(api, {
    /**
     * Collision for a solid site: strikes into the tallest `piece` collider of the live site (the
     * structure parts' own colliders), or into a redwood trunk (piece 'trunk': the vegetation
     * provider's colliders). Each craft at each speed must end in a structure strike.
     */
    async strikes(presetId, { piece, crafts = ['bushplane', 'jet'], speeds = [60, 250] } = {}) {
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: strikes`, false, 'no live site spawn (run site() first)');
      await hover(site);
      let target = null;
      let available = 0;
      if (piece === 'trunk') {
        const trunks = trunksNear(site, 400);
        available = trunks.length;
        // The service's own records (bounds [minX, minY, minZ, maxX, maxY, maxZ]): the tallest trunk.
        target = trunks.sort((first, second) => (second.bounds[4] - second.bounds[1]) - (first.bounds[4] - first.bounds[1]))[0] ?? null;
      } else {
        const solids = ownSolids(parts);
        available = solids.length;
        target = tallest(solids, `:${piece}`);
      }
      if (!target) return check(`${presetId}: strikes`, false, { piece, available });
      return strikeAll(presetId, target, crafts, speeds);
    },

    /** The live site's colliders and perches: `min` solids of its own (or trunks of the grove), each with a perch. */
    async solids(presetId, { min = 1, trunks = false, perches = 1 } = {}) {
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: colliders`, false, 'no live site spawn');
      await hover(site);
      const records = trunks ? trunksNear(site, 600) : ownSolids(parts);
      let perchCount = 0;
      colliders.perchesNear(site.x, site.groundY + 60, site.z, 700, () => {
        perchCount++;
      });
      const byPiece = {};
      for (const record of records) {
        // Ids end in the recipe's part name and its index ('<prefix>:leg12').
        const piece = record.id.split(':').pop().replace(/[0-9]+$/, '');
        byPiece[piece] = (byPiece[piece] ?? 0) + 1;
      }
      return check(`${presetId}: ${records.length} solid colliders (at least ${min}) and ${perchCount} perches (at least ${perches})`, records.length >= min && perchCount >= perches, { colliders: records.length, byPiece: trunks ? { trunk: records.length } : byPiece, perches: perchCount });
    },

    /**
     * The five-arch run: the registered course matches the preset's challenge block on this site;
     * the craft flies (kinematically, `speed` m/s) a straight line through the five openings, starts
     * the clock at the first, takes three splits, finishes with a medal and touches no stone.
     */
    async archRun(presetId, { craft = 'bushplane', speed = 60 } = {}) {
      const preset = manager.getPreset(presetId);
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: arch run`, false, 'no live site spawn');
      const built = siteCourse(preset, site, parts);
      if (!built) return check(`${presetId}: arch run`, false, 'no registered course');
      const challenges = ctx.systems.challenges;
      const listed = challenges.list().filter((entry) => built.keys.includes(entry.courseKey));
      const courseKey = built.keys[0];
      const registered = listed.length === 1 && courseKey.endsWith(`:${built.course.id}`) && listed[0].gates === 5;
      const gates = built.course.gates;
      const first = gates[0];
      const last = gates[gates.length - 1];
      const direction = new THREE.Vector3(first.normal.x, first.normal.y, first.normal.z).normalize();
      const start = new THREE.Vector3(first.center.x, first.center.y, first.center.z).addScaledVector(direction, -ARCH_RUN_IN);
      const aim = new THREE.Vector3(last.center.x, last.center.y, last.center.z);
      if (!(await useCraft(craft))) return check(`${presetId}: arch run`, false, `no ${craft}`);
      clearRecords(courseKey, craft);
      // Out of any earlier run's reach first, so the start is a fresh crossing.
      await hover(site, 600);
      const run = await flyRun({ craft, speed, start, direction, aim, beyond: ARCH_RUN_OUT });
      await wait(300);
      const started = events.started.find((event) => event.id === courseKey) ?? null;
      const splits = events.gates.filter((event) => event.id === courseKey && event.role === 'checkpoint');
      const finished = events.finished.find((event) => event.id === courseKey) ?? null;
      const best = challenges.getBest(courseKey, craft);
      clearRecords(courseKey, craft);
      await useCraft(craftBefore);
      const flown = finished !== null && splits.length === 3 && splits.every((event) => !event.missed) && finished.missed === 0 && ['gold', 'silver', 'bronze'].includes(finished.medal);
      return check(`${presetId}: the course is registered, a line through the five arches starts, splits, finishes with a medal and touches no stone`, registered && Boolean(started) && flown && !run.crashed && run.hits + run.contacts === 0 && run.penetrations === 0, {
        courseKey, registered, gateY: round(first.center.y - site.groundY), started: Boolean(started), splits: splits.map((event) => round(event.split ?? event.time ?? 0, 2)),
        finished: finished ? { time: round(finished.time, 2), medal: finished.medal, missed: finished.missed } : null, best: best ? round(best.time, 2) : null,
        run: { crashed: run.crashed, reason: run.reason, hits: run.hits, contacts: run.contacts, hitIds: run.hitIds, penetrations: run.penetrations, seconds: run.seconds },
      });
    },

    /**
     * The emitters with `gusts` on the live site: within `seconds` of flight time each fires at least
     * one gust burst, and the level rises over its base while a gust blows.
     */
    async gusts(presetId, { seconds = 60 } = {}) {
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: gusts`, false, 'no live site spawn');
      const engine = manager.registry.get('emitter');
      const emitters = parts.filter((part) => part.engine === 'emitter' && engine.describe(part).gusts !== null);
      if (emitters.length === 0) return check(`${presetId}: gusts`, false, 'no gust emitter');
      await hover(site, 250);
      const before = emitters.map((part) => engine.describe(part).gusts.fired);
      const peak = emitters.map(() => 0);
      const started = state.time.elapsed;
      const allFired = () => emitters.every((part, index) => engine.describe(part).gusts.fired > before[index]);
      while (state.time.elapsed - started < seconds && !allFired()) {
        await frames(5);
        emitters.forEach((part, index) => {
          peak[index] = Math.max(peak[index], engine.describe(part).gusts.level);
        });
        // The craft circles back over the grove (a minute of straight flight would leave its near tier).
        if (Math.hypot(state.player.position.x - site.x, state.player.position.z - site.z) > 1200) await hover(site, 250);
      }
      const after = emitters.map((part) => engine.describe(part));
      return check(`${presetId}: the WindField's gusts fire every gust emitter's burst`, allFired(), {
        flightSeconds: round(state.time.elapsed - started), emitters: after.map((described, index) => ({ fired: described.gusts.fired - before[index], peakLevel: round(peak[index], 2), gustIndex: round(described.gusts.index, 2), emitted: described.emitted, tier: described.tier })),
      });
    },

    /** A weather volume with `hours` on the live site: its shown share at dawn, by day and at night. */
    async hours(presetId, expected) {
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: hours`, false, 'no live site spawn');
      const mist = parts.find((part) => part.engine === 'weatherVolume');
      if (!mist) return check(`${presetId}: hours`, false, 'no weather volume');
      await hover(site, 300);
      const shown = {};
      for (const [hour, sun, morning] of [['dawn', 3, true], ['day', 40, true], ['night', -25, false]]) {
        holdConditions(ctx, { sun, morning, weather: 'clear' });
        await wait(600);
        shown[hour] = round(mist.data.shown, 3);
      }
      const near = (hour) => Math.abs(shown[hour] - expected[hour] * mist.data.growth) < 0.05;
      return check(`${presetId}: the mist shows its share of the hour (dawn ${expected.dawn}, day ${expected.day}, night ${expected.night})`, near('dawn') && near('day') && near('night') && shown.dawn > shown.day * 3, { shown, growth: mist.data.growth });
    },

    /** The dust devils: two vortices, each a wind source with a rising, spinning core, wandering on its path. */
    async devils(presetId, { seconds = 6 } = {}) {
      const { site, spawnId, parts } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: dust devils`, false, 'no live site spawn');
      const vortices = parts.filter((part) => part.engine === 'vortex');
      if (vortices.length !== 2) return check(`${presetId}: dust devils`, false, `${vortices.length} vortex parts`);
      await hover(site, 500);
      await wait(1000);
      const from = vortices.map((part) => ({ x: part.anchor.x, z: part.anchor.z }));
      await wait(seconds * 1000);
      const sample = { vel: new THREE.Vector3(), turbulence: 0 };
      const devils = vortices.map((part, index) => {
        const engine = manager.registry.get('vortex');
        const described = engine.describe(part);
        const ground = ctx.world.groundHeight(part.anchor.x, part.anchor.z);
        // The updraft at the core, 25 m up; the swirl a core radius and a half out.
        ctx.wind.probe({ x: part.anchor.x, y: ground + 25, z: part.anchor.z }, state.time.elapsed, sample);
        const updraft = sample.vel.y;
        let swirl = 0;
        for (let side = 0; side < 4; side++) {
          const angle = (side / 4) * Math.PI * 2;
          const reach = 9;
          ctx.wind.probe({ x: part.anchor.x + Math.cos(angle) * reach, y: ground + 15, z: part.anchor.z + Math.sin(angle) * reach }, state.time.elapsed, sample);
          // Tangential component (counter-clockwise seen from above is +).
          swirl += -sample.vel.x * Math.sin(angle) + sample.vel.z * Math.cos(angle);
        }
        return {
          windOn: described.windOn, windSources: part.windSourceIds.length, updraft: round(updraft), swirl: round(Math.abs(swirl / 4)),
          moved: round(Math.hypot(part.anchor.x - from[index].x, part.anchor.z - from[index].z)), stage: described.stage,
        };
      });
      const ok = devils.every((devil) => devil.windOn && devil.windSources > 0 && devil.updraft > 1.5 && devil.swirl > 3 && devil.moved > 3);
      return check(`${presetId}: two dust devils, each a rising, spinning wind source wandering on its path`, ok, { devils, flightSeconds: seconds });
    },

    /**
     * Water on the live site: `bodies` local water bodies within its reach (the paddies) and, with
     * ocean: true, open sea in its channels (the delta). Samples a 40 x 40 grid over `reach` m.
     */
    async water(presetId, { bodies = 0, ocean = false, reach = 700 } = {}) {
      const { site, spawnId } = liveSite(presetId);
      if (!spawnId) return check(`${presetId}: water`, false, 'no live site spawn');
      let found = 0;
      ctx.waterQuery.bodiesNear(site.x, site.z, reach, () => {
        found++;
      });
      const sample = createWaterSample();
      const counts = { lake: 0, ocean: 0, none: 0 };
      for (let row = 0; row < 40; row++) {
        for (let column = 0; column < 40; column++) {
          const x = site.x + ((column + 0.5) / 40 - 0.5) * 2 * reach;
          const z = site.z + ((row + 0.5) / 40 - 0.5) * 2 * reach;
          ctx.waterQuery.sample(x, z, state.time.elapsed, sample);
          counts[sample.kind] = (counts[sample.kind] ?? 0) + 1;
        }
      }
      const ok = found >= bodies && (bodies === 0 || counts.lake > 10) && (!ocean || counts.ocean > 40);
      return check(`${presetId}: water on the site (${bodies} local bodies or more${ocean ? ', open sea in its channels' : ''})`, ok, { bodies: found, grid: counts, stamps: site.stamps.map((stamp) => stamp.type) });
    },

    /** Puts the craft back on its craft and the stored records as they were, then the shared finish. */
    finishBatch() {
      ctx.settings.set('craft', craftBefore);
      return api.finish();
    },
  });
  return api;
}
