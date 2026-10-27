// Dev-only browser checks for presets 71-80 (wave 3, batch 8), beside the shared preset kit
// (presetChecks.js: conditions, the real site, the force spawn, framing, discovery and the dispose
// check). installBatch8Checks(game) puts window.__dwBatch8 on a running V2 on a dev server;
// tools/steps/presets-71-80.json drives both. For a live spawn of a batch preset it proves, in the
// running game:
//   - wind:      the air the preset promises, read from the real WindField (probe): the reverse
//                waterfall's column and the ridge band's and the thermal street's lift columns rise,
//                the shear line veers and speeds up the wind across its front, the falls' arcs sink;
//   - colliders: the solid parts registered with the collider service (the cave's one mesh BVH, the
//                kite strings as sensors tagged kiteString);
//   - strike:    the craft flown into a solid part (a pillar, the mountain's flank, an envelope, a
//                boulder) meets that part's collider (the typed colliderHit event);
//   - run:       the challenge flow on the course the spawn registered: the craft flown (the real
//                flight model, reset short of each gate on its line) through every gate starts the
//                clock, passes every gate, finishes with a medal toast and stores a best time, with no
//                collider touched on the way;
//   - kiteTouch: on a kite run the craft flown through a string: the flight controller reports the
//                sensor, the run counts a miss with its penalty, and nothing crashes.
// Every failed check calls console.error, so the smoke run fails. Never part of a production build:
// only dev-server step files import it.
import { frames, wait } from './spawnCheckKit.js';

const DEG = Math.PI / 180;
/** How far short of a gate (m) the craft is reset on the gate's line for a course run. */
const GATE_RUN_IN = 80;
/** How long (ms) a gate may take to register, and a strike or a sensor to happen. */
const GATE_TIMEOUT_MS = 15000;
const CONTACT_TIMEOUT_MS = 9000;
/** Time (ms) for a crash fade and respawn to finish before the next check. */
const RESPAWN_MS = 6000;

/** The compass heading (deg) of a horizontal direction. */
function compass(x, z) {
  return ((Math.atan2(x, -z) / DEG) + 360) % 360;
}

/**
 * Installs window.__dwBatch8 on a running V2 (dev server). Returns the API; see the file header.
 */
export function installBatch8Checks(game) {
  const { ctx, state } = game;
  const THREE = ctx.THREE;
  const manager = ctx.systems.spawns.manager;
  const challenges = ctx.systems.challenges;
  const results = [];
  const hits = [];
  const sensors = [];
  const crashes = [];
  const misses = [];
  const finished = [];
  const started = [];
  const offs = [
    ctx.bus.onTyped('colliderHit', (payload) => hits.push(payload)),
    ctx.bus.onTyped('colliderSensor', (payload) => sensors.push(payload)),
    ctx.bus.onTyped('softCrash', (payload) => crashes.push(payload)),
    ctx.bus.onTyped('challengeStarted', (payload) => started.push(payload)),
    ctx.bus.onTyped('challengeFinished', (payload) => finished.push(payload)),
    ctx.bus.on('challenge:sensorMiss', (payload) => misses.push(payload)),
  ];
  const probeOut = { vel: new THREE.Vector3(), turbulence: 0 };
  const probePoint = new THREE.Vector3();

  function check(name, ok, detail) {
    const line = `${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    results.push(line);
    if (!ok) console.error(`[batch 8 check] ${line}`);
    return line;
  }

  /** The newest live spawn of presetId (a real site or a force spawn), or null. */
  function liveSpawn(presetId) {
    const live = manager.getActive().filter((record) => record.presetId === presetId);
    return live.length > 0 ? live[live.length - 1] : null;
  }
  function partsOf(spawn, engine = null) {
    const parts = spawn ? manager.getParts(spawn.id) : [];
    return engine ? parts.filter((part) => part.engine === engine) : parts;
  }
  function colliderIdsOf(spawn) {
    return partsOf(spawn).flatMap((part) => part.colliderIds ?? []);
  }
  /** The collider service's records of the spawn ({ id, owner, type, tags, bounds: { min, max } }). */
  function collidersOf(spawn) {
    const ids = new Set(colliderIdsOf(spawn));
    return ctx.colliders.list().filter((record) => ids.has(record.id));
  }
  function windIdsOf(spawn) {
    return partsOf(spawn).flatMap((part) => part.windSourceIds ?? []);
  }
  /** The WindField's air at (x, y, z) now: { x, y, z, speed }. */
  function airAt(x, y, z) {
    probePoint.set(x, y, z);
    ctx.wind.probe(probePoint, state.time.elapsed, probeOut);
    const vel = probeOut.vel;
    return { x: vel.x, y: vel.y, z: vel.z, speed: Math.hypot(vel.x, vel.z) };
  }
  /** The compass heading an activation with anchor.align 'downwind' takes (spawnManager applyAnchorRule). */
  function downwindHeading() {
    const direction = ctx.uniforms.windDirection.value;
    return compass(direction.x, direction.y);
  }
  /** Lift (m/s) at the centres of the spawn's updraft sources, each at its own height. */
  function updraftLifts(spawn) {
    const own = new Set(windIdsOf(spawn));
    return ctx.wind.listSources().filter((source) => own.has(source.id) && source.kind === 'spawn-updraft').map((source) => airAt(source.position.x, source.position.y, source.position.z).y);
  }
  /** The registered course of a spawn: its structure part's definition (world frame) and course key. */
  function courseOf(spawn) {
    const part = partsOf(spawn, 'structure')[0];
    const definition = part && part.data.challengeDefinitions ? part.data.challengeDefinitions[0] : null;
    const entry = definition ? challenges.list().find((course) => course.courseKey.endsWith(definition.id) || course.courseKey === definition.id) : null;
    return { part, definition, entry };
  }
  /** Removes a course's stored best and path, so a run starts from a clean record. */
  function clearRecords(courseKey) {
    const stored = ctx.storage.read('driftwing-v2.challenges', null);
    if (stored && stored.courses && stored.courses[courseKey]) {
      delete stored.courses[courseKey];
      ctx.storage.write('driftwing-v2.challenges', stored);
    }
    ctx.storage.remove(`driftwing-v2.challengePath.${courseKey}.${state.flight.craft}`);
    challenges.reloadRecords();
  }
  /** Resets the craft `before` m short of a gate on its line, heading through it (level, at its centre). */
  function toGate(gate, before) {
    const n = gate.normal;
    const flat = Math.hypot(n.x, n.z) || 1;
    ctx.systems.flight.resetTo({ x: gate.center.x - (n.x / flat) * before, y: gate.center.y, z: gate.center.z - (n.z / flat) * before, heading: compass(n.x, n.z) });
  }
  /** Resets the craft `distance` m from a point, heading at it from `bearing` (deg), at its height. */
  function aimAt(point, bearing, distance) {
    const radians = bearing * DEG;
    ctx.systems.flight.resetTo({ x: point.x - Math.sin(radians) * distance, y: point.y, z: point.z + Math.cos(radians) * distance, heading: bearing });
  }
  /** Waits (up to timeout) until predicate() holds, frame by frame. */
  async function until(predicate, timeout) {
    const begun = performance.now();
    while (performance.now() - begun < timeout) {
      if (predicate()) return true;
      await frames(2);
    }
    return predicate();
  }

  const api = {
    results,

    setup() {
      ctx.setPhotoMode(false);
      return check('setup: batch 8 checks installed', Boolean(challenges) && typeof ctx.wind.probe === 'function', { craft: state.flight.craft, backend: game.backend });
    },

    /** The air the live spawn of presetId promises (see the file header). */
    wind(presetId) {
      const spawn = liveSpawn(presetId);
      if (!spawn) return check(`${presetId}: wind`, false, 'no live spawn');
      const sources = windIdsOf(spawn).length;
      if (presetId === 'reverseWaterfall' || presetId === 'ridgeLiftBand' || presetId === 'thermalStreet') {
        const lifts = updraftLifts(spawn);
        const need = { reverseWaterfall: [1, 5], ridgeLiftBand: [8, 1.5], thermalStreet: [16, 2] }[presetId];
        return check(`${presetId}: ${need[0]} rising column(s) in the WindField, each lifting ${need[1]}+ m/s at its centre`, lifts.length === need[0] && lifts.every((lift) => lift >= need[1]), { sources, lifts: lifts.map((lift) => Math.round(lift * 10) / 10) });
      }
      if (presetId === 'windShearLine') {
        // The front faces 90 degrees right of the downwind activation heading, 550 m out.
        const facing = (downwindHeading() + 90) * DEG;
        const anchor = spawn.position;
        const at = (offset) => airAt(anchor.x + Math.sin(facing) * (550 + offset), anchor.y + 300, anchor.z - Math.cos(facing) * (550 + offset));
        const ahead = at(400);
        const behind = at(-600);
        const veer = Math.abs(((compass(behind.x, behind.z) - compass(ahead.x, ahead.z) + 540) % 360) - 180);
        const ratio = behind.speed / Math.max(0.1, ahead.speed);
        return check('windShearLine: across the front the wind veers 30+ degrees and speeds up 1.3x', sources > 0 && veer >= 30 && ratio >= 1.3, { sources, veer: Math.round(veer), ratio: Math.round(ratio * 100) / 100, ahead: Math.round(ahead.speed * 10) / 10, behind: Math.round(behind.speed * 10) / 10 });
      }
      if (presetId === 'waterfallWall') {
        const part = partsOf(spawn, 'structure')[0];
        const falls = part ? part.data.falls : null;
        if (!falls) return check('waterfallWall: sinking air in the falls', false, 'no falls on the structure');
        // 60 m below the lip the water has flown out speed * t from it.
        const seconds = Math.sqrt((2 * 60) / falls.gravity);
        const sinks = [];
        for (let index = 0; index < falls.count; index++) {
          const out = falls.table[index * 3 + 2] * seconds;
          sinks.push(airAt(falls.table[index * 3] + falls.dirX * out, falls.lipY - 60, falls.table[index * 3 + 1] + falls.dirZ * out).y);
        }
        const live = ctx.wind.listSources().some((source) => source.id === part.data.fallsId && source.kind === 'structure-falls');
        return check(`waterfallWall: every one of the ${falls.count} falls sinks (<= -3 m/s on its arc)`, live && sinks.every((value) => value <= -3), { source: part.data.fallsId, sinks: sinks.map((value) => Math.round(value * 10) / 10) });
      }
      return check(`${presetId}: wind`, sources === 0, { sources, note: 'no wind expected' });
    },

    /** The solid parts of the live spawn of presetId, registered with the collider service. */
    colliders(presetId) {
      const spawn = liveSpawn(presetId);
      if (!spawn) return check(`${presetId}: colliders`, false, 'no live spawn');
      const ids = colliderIdsOf(spawn);
      const records = collidersOf(spawn);
      const detail = { colliders: ids.length, registered: records.length };
      if (presetId === 'caveTunnel') {
        return check('caveTunnel: the mountain is one mesh collider (three-mesh-bvh) with a summit perch', ids.length === 1 && records.length === 1 && records[0].type === 'mesh', { ...detail, type: records[0] ? records[0].type : null });
      }
      if (presetId === 'kiteSlalom') {
        const strings = records.filter((record) => /:string/.test(record.id));
        return check('kiteSlalom: every string is a sensor tagged kiteString', strings.length >= 6 && strings.every((record) => record.tags.sensor === true && record.tags.miss === 'kiteString'), { ...detail, strings: strings.length });
      }
      const least = { canyonGauntlet: 16, waterfallWall: 10, balloonFestival: 90 }[presetId] ?? 1;
      return check(`${presetId}: ${least}+ colliders registered with the spawn`, records.length === ids.length && ids.length >= least, detail);
    },

    /**
     * Flies the craft into a solid part of the live spawn of presetId (`part`: a collider id fragment)
     * from `distance` m and waits for its colliderHit.
     */
    async strike(presetId, part, { distance = 140, rise = 0 } = {}) {
      const spawn = liveSpawn(presetId);
      if (!spawn) return check(`${presetId}: strike`, false, 'no live spawn');
      const ids = colliderIdsOf(spawn);
      const record = collidersOf(spawn).find((entry) => entry.id.includes(`:${part}`) && !entry.tags.sensor) ?? null;
      if (!record) return check(`${presetId}: strike ${part}`, false, { colliders: ids.length, note: 'no such solid part' });
      const { min, max } = record.bounds;
      const target = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 + rise, z: (min.z + max.z) / 2 };
      // From the side of the spawn's anchor, so the run-in crosses open air.
      const bearing = compass(target.x - spawn.position.x, target.z - spawn.position.z);
      ctx.setPhotoMode(false);
      const since = hits.length;
      aimAt(target, bearing, distance + Math.max(max.x - min.x, max.z - min.z) * 0.5);
      const met = await until(() => hits.slice(since).some((hit) => ids.includes(hit.id)), CONTACT_TIMEOUT_MS);
      const hit = hits.slice(since).find((entry) => ids.includes(entry.id)) ?? null;
      await wait(RESPAWN_MS);
      return check(`${presetId}: flown into its ${part}, the craft meets the collider`, met, hit ? { id: hit.id, speed: Math.round(hit.speed * 10) / 10, crashed: hit.crashed, surface: hit.surface } : { target, others: hits.slice(since).map((entry) => entry.id) });
    },

    /**
     * The forest wisps fall in behind the craft: it is reset 260 m short of them, flying over them,
     * and within 12 s the guide is trailing it.
     */
    async wispsTrail() {
      const spawn = liveSpawn('forestWisps');
      const part = partsOf(spawn, 'lightEffect')[0];
      if (!part) return check('forestWisps: trailing', false, 'no live wisps');
      const engine = manager.registry.get('lightEffect');
      const before = engine.describe(part).guide.phase;
      ctx.setPhotoMode(false);
      const anchor = part.anchor;
      aimAt({ x: anchor.x, y: Math.max(anchor.y + 40, ctx.world.groundHeight(anchor.x, anchor.z) + 120), z: anchor.z }, state.player.heading, 260);
      const trailing = await until(() => engine.describe(part).guide.phase === 'trailing', 12000);
      const guide = engine.describe(part).guide;
      const behind = Math.hypot(guide.anchor.x - state.player.position.x, guide.anchor.z - state.player.position.z);
      return check('forestWisps: as the craft passes over them they fall in behind it', trailing && behind < 200, { before, phase: guide.phase, behind: Math.round(behind) });
    },

    /** The challenge flow on the live spawn's course (see the file header). */
    async run(presetId) {
      const spawn = liveSpawn(presetId);
      const { definition, entry } = courseOf(spawn);
      if (!definition || !entry) return check(`${presetId}: challenge run`, false, { spawn: spawn ? spawn.id : null, note: 'no registered course' });
      challenges.cancel('test');
      clearRecords(entry.courseKey);
      const solid = new Set(colliderIdsOf(spawn));
      const hitsBefore = hits.length;
      const crashesBefore = crashes.length;
      const finishedBefore = finished.length;
      const startedBefore = started.length;
      const log = [];
      ctx.setPhotoMode(false);
      for (let index = 0; index < definition.gates.length; index++) {
        toGate(definition.gates[index], GATE_RUN_IN);
        const last = index === definition.gates.length - 1;
        await until(() => {
          const live = challenges.getState();
          return last ? finished.length > finishedBefore : live.phase === 'running' && live.gateIndex > index;
        }, GATE_TIMEOUT_MS);
        const live = challenges.getState();
        log.push(`${definition.gates[index].id}:${live.phase}/${live.gateIndex}`);
      }
      const result = finished.slice(finishedBefore).find((payload) => payload.id === entry.courseKey) ?? null;
      await wait(400);
      const toast = document.querySelector('.dw-challenge-toast');
      const best = challenges.getBest(entry.courseKey, state.flight.craft);
      const touched = hits.slice(hitsBefore).filter((hit) => solid.has(hit.id)).map((hit) => hit.id);
      const ok = started.length > startedBefore && Boolean(result) && result.valid && result.missed === 0 && result.medal !== 'none' && Boolean(best) && touched.length === 0 && crashes.length === crashesBefore && toast && toast.dataset.state === 'shown';
      return check(`${presetId}: the course runs start to finish (clock, every gate, medal toast, stored best), no collider touched`, ok, {
        course: entry.courseKey, gates: definition.gates.length, log, time: result ? Math.round(result.time * 100) / 100 : null, medal: result ? result.medal : null,
        missed: result ? result.missed : null, best: best ? Math.round(best.time * 100) / 100 : null, toast: toast ? toast.dataset.state : null, touched, crashes: crashes.length - crashesBefore,
      });
    },

    /** A kite run that flies through a string: a sensor miss with its penalty, no crash. */
    async kiteTouch() {
      const spawn = liveSpawn('kiteSlalom');
      const { definition, entry } = courseOf(spawn);
      const string = collidersOf(spawn).find((record) => record.tags.miss === 'kiteString') ?? null;
      if (!definition || !entry || !string) return check('kiteSlalom: string touch', false, 'no course or string');
      challenges.cancel('test');
      ctx.setPhotoMode(false);
      // Start a run through the start gate.
      const startedBefore = started.length;
      toGate(definition.gates[0], GATE_RUN_IN);
      await until(() => started.length > startedBefore, GATE_TIMEOUT_MS);
      // Then through the string at a fifth of its height: its ground track is a diagonal of its bounds.
      const { min, max } = string.bounds;
      const share = 0.2;
      const point = { x: min.x + (max.x - min.x) * share, y: min.y + (max.y - min.y) * share, z: min.z + (max.z - min.z) * share };
      const along = compass(max.x - min.x, max.z - min.z);
      const sensorsBefore = sensors.length;
      const missesBefore = misses.length;
      const crashesBefore = crashes.length;
      aimAt(point, (along + 90) % 360, 90);
      const met = await until(() => sensors.slice(sensorsBefore).some((payload) => payload.id === string.id), CONTACT_TIMEOUT_MS);
      await wait(500);
      const live = challenges.getState();
      const miss = misses.slice(missesBefore)[0] ?? null;
      const ok = met && Boolean(miss) && miss.tag === 'kiteString' && miss.penaltySeconds === 2 && crashes.length === crashesBefore && live.phase === 'running';
      challenges.cancel('test');
      return check('kiteSlalom: flying through a string counts a miss with its 2 s penalty, no crash, the run goes on', ok, {
        string: string.id, sensor: met, miss, crashes: crashes.length - crashesBefore, phase: live.phase,
      });
    },

    finish() {
      for (const off of offs) off();
      const failed = results.filter((line) => line.startsWith('FAIL'));
      return check('batch 8 checks', failed.length === 0, `${results.length - failed.length}/${results.length} passed`);
    },
  };
  window.__dwBatch8 = api;
  return api;
}
