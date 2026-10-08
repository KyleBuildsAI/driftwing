// Challenge lab (contract f.5): the challenge core (src/gameplay/challenges.js) and the ring course
// on it (src/gameplay/rings.js), headless in node.
//
// Tests:
//   rings        the six golden flights recorded from the Phase 2 rings (tools/lab/ringsGolden.mjs,
//                fixtures/rings-golden.json) replay identically on the migrated code: every bus event
//                (type, payload, frame), state.ringCourse and lastCrossing on every frame, the journal
//                calls; the ring course emits no typed challenge event and writes no record; a
//                perturbed golden is caught (the comparison is not vacuous)
//   crossing     crossing times are interpolated inside the frame: the same flight at three frame
//                rates (and with paused frames) gives the same gate times to 1e-9 s, equal to
//                distance / speed
//   splits       a second, faster run reports splits with negative deltas against the first, a slower
//                one positive deltas; the payloads carry split and delta
//   medals       gold, silver, bronze and none from the thresholds (penalties included)
//   misses       outside crossings and skipped gates: 'penalty' adds seconds, 'void' finishes with
//                valid false and stores no best, 'count' only counts; outsideCrossing 'ignore' lets the
//                pilot come back for the gate
//   sensors      a colliderSensor with a course's sensor tag counts a miss and its penalty
//   bests        best time per craft, improved only by a faster valid run; records survive a new
//                system on the same storage; the storage key, version and shape match the contract
//   path         the best run's path: 10 Hz frames from the start crossing (t = 0, 0.1, ...) plus the
//                finish frame, positions on the flown line, saved only when the best improves, and a
//                storage round trip (key prefix, version, hz) gives the same frames
//   lifecycle    flying the start gate starts a course; the key arms it and the start gate starts the
//                clock; immediate courses start at once; Y (input:action challengeStart) starts the
//                nearest course in its prompt radius and cancels a run; abandon, time limit, a soft
//                crash and unregister cancel with their reasons; a teleport segment is skipped; a
//                second register replaces the gates and keeps the records; the prompt and nextGate
//   validation   bad course definitions and preset challenge blocks are refused naming the field;
//                buildSiteCourse places gates in the site frame
//   determinism  two identical flights give identical event logs and records
//   allocation   100 000 frames of a running course (detection, live state, the prompt, the path
//                recorder) allocate nothing
//
// Usage: node --expose-gc tools/lab/challenges.mjs [--verbose]
import { readFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import {
  BEST_PATH_HZ, CHALLENGE_PATH_KEY_PREFIX, CHALLENGE_STORAGE_KEY, PATH_FRAME_STRIDE,
  buildSiteCourse, createChallengeSystem, medalFor, validateChallengeBlock, validateCourseDefinition,
} from '../../src/gameplay/challenges.js';
import { createRingCourseSystem } from '../../src/gameplay/rings.js';
import { validatePreset } from '../../src/spawns/schema.js';
import { PRESETS } from '../../src/spawns/presets/index.js';
import { RING_GOLDEN_FIXTURE, RING_GOLDEN_VERSION, compareFlight, runRingFlights, summarizeFlight } from './ringsGolden.mjs';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};

// ---- A headless game for the challenge core -------------------------------------------------------------
function createStorage(initial = null) {
  const map = initial ?? new Map();
  const writes = [];
  return {
    map,
    writes,
    read(key, fallback) {
      return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : fallback;
    },
    write(key, value) {
      if (!key.startsWith('driftwing-v2.')) throw new Error(`key ${key} outside V2's namespace`);
      map.set(key, JSON.parse(JSON.stringify(value)));
      writes.push(key);
      return true;
    },
    remove(key) {
      return map.delete(key);
    },
  };
}

function createLab({ storage = createStorage(), craft = 'glider', seed = 'LAB-1' } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = [];
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    events.push({ type, payload: payload === undefined ? null : JSON.parse(JSON.stringify(payload)) });
    emit(type, payload);
  };
  const state = {
    seed,
    paused: false,
    photoMode: false,
    time: { elapsed: 0, frameDt: 0 },
    player: { position: new THREE.Vector3(0, 100, 200), quaternion: new THREE.Quaternion(), heading: 0, speed: 0 },
    flight: { craft },
  };
  const ctx = { bus, state, storage, systems: {} };
  const challenges = createChallengeSystem(ctx);
  ctx.systems.challenges = challenges;
  return {
    ctx,
    bus,
    state,
    storage,
    events,
    challenges,
    /** One frame of dt seconds (0 = paused). */
    step(dt) {
      state.time.frameDt = dt;
      state.time.elapsed += dt;
      challenges.update(dt, dt === 0 ? 1 / 60 : dt);
    },
    typed(type) {
      return events.filter((event) => event.type === type).map((event) => event.payload);
    },
  };
}

/** A straight course north (-z) at y = 100: gates at the given distances from z = 0, the last the finish. */
function straightCourse(id, distances, extra = {}) {
  const gates = distances.map((distance, index) => ({
    id: `g${index}`,
    role: index === 0 ? 'start' : index === distances.length - 1 ? 'finish' : 'checkpoint',
    center: { x: 0, y: 100, z: -distance },
    normal: { x: 0, y: 0, z: -1 },
    shape: index % 2 ? 'rect' : 'circle',
    radius: 20,
    halfWidth: 25,
    halfHeight: 15,
  }));
  return { id, name: `Course ${id}`, gates, medals: { gold: 20, silver: 25, bronze: 30 }, ...extra };
}

/**
 * Flies north from z = startZ at `speed` m/s with the frame times `frames` (cycled) until z <= endZ;
 * `offsetAt(z)` gives the lateral (x) and vertical (y) offset to fly at.
 */
function flyNorth(lab, { startZ = 50, endZ, speed, frames, offsetAt = null, maxFrames = 200000 }) {
  const position = lab.state.player.position;
  position.set(0, 100, startZ);
  let count = 0;
  let traveled = 0;
  while (position.z > endZ && count < maxFrames) {
    const dt = frames[count % frames.length];
    traveled += speed * dt;
    const z = startZ - traveled;
    const offset = offsetAt ? offsetAt(z) : null;
    position.set(offset ? offset.x : 0, 100 + (offset ? offset.y : 0), z);
    lab.step(dt);
    count++;
  }
  return count;
}

// ---- rings ---------------------------------------------------------------------------------------------
function testRings() {
  const fixture = JSON.parse(readFileSync(RING_GOLDEN_FIXTURE, 'utf8'));
  check('rings', 'golden fixture version and six flights', fixture.version === RING_GOLDEN_VERSION && fixture.flights.length === 6, `${fixture.version}, ${fixture.flights.length} flights`);
  const storages = [];
  const logs = runRingFlights((ctx) => {
    const storage = createStorage();
    storages.push(storage);
    ctx.storage = storage;
    const challenges = createChallengeSystem(ctx);
    ctx.systems.challenges = challenges;
    const rings = createRingCourseSystem(ctx);
    ctx.systems.rings = rings;
    return { rings, order: [rings, challenges] };
  });
  logs.forEach((log, index) => {
    const difference = compareFlight(fixture.flights[index], log);
    check('rings', `golden flight "${log.flight}" replays identically`, difference === null, difference ?? summarizeFlight(log));
  });
  const typedChallengeEvents = logs.flatMap((log) => log.events).filter((event) => event.type.startsWith('challenge'));
  check('rings', 'the ring course emits no typed challenge event', typedChallengeEvents.length === 0, `${typedChallengeEvents.length}`);
  const writes = storages.flatMap((storage) => storage.writes);
  check('rings', 'the ring course stores no challenge record or path', writes.length === 0, writes.join(', '));
  // Negative controls: a changed event payload, a changed digest and a changed journal entry are caught.
  const golden = fixture.flights[0];
  const replay = logs[0];
  const tamperedEvent = JSON.parse(JSON.stringify(golden));
  tamperedEvent.events[2].payload.streak += 1;
  const tamperedDigest = JSON.parse(JSON.stringify(golden));
  tamperedDigest.digests[500] = '00000000';
  const tamperedJournal = JSON.parse(JSON.stringify(golden));
  tamperedJournal.journal[0].result.time += 0.1;
  check('rings', 'the comparison catches a changed event, a changed state frame and a changed journal call', compareFlight(tamperedEvent, replay) !== null && compareFlight(tamperedDigest, replay) !== null && compareFlight(tamperedJournal, replay) !== null);
}

// ---- crossing ------------------------------------------------------------------------------------------
function runCourseTimes(frames, { pauseEvery = 0 } = {}) {
  const lab = createLab();
  const key = lab.challenges.register(straightCourse('timing', [100, 400, 700, 1100]), { owner: 'lab' });
  const position = lab.state.player.position;
  position.set(0, 100, 50);
  let traveled = 0;
  let count = 0;
  while (position.z > -1200 && count < 100000) {
    const dt = frames[count % frames.length];
    if (pauseEvery && count % pauseEvery === 0) lab.step(0);
    traveled += 40 * dt;
    position.set(0, 100, 50 - traveled);
    lab.step(dt);
    count++;
  }
  return { key, gates: lab.typed('challengeGate'), finished: lab.typed('challengeFinished')[0] ?? null, started: lab.typed('challengeStarted')[0] ?? null };
}

function testCrossing() {
  const runs = [
    runCourseTimes([1 / 60]),
    runCourseTimes([1 / 144, 1 / 30, 1 / 75, 1 / 20]),
    runCourseTimes([1 / 23], { pauseEvery: 7 }),
  ];
  const expected = [0, 300 / 40, 600 / 40, 1000 / 40];
  const worst = Math.max(...runs.flatMap((run) => run.gates.map((gate, index) => Math.abs(gate.time - expected[index]))));
  check('crossing', 'gate times equal distance / speed at three frame rates and with paused frames', runs.every((run) => run.gates.length === 4 && run.finished) && worst < 1e-9, `worst error ${worst.toExponential(2)} s; finish ${runs.map((run) => run.finished?.time.toFixed(9)).join(', ')}`);
  check('crossing', 'challengeStarted names the course, craft and gate count', runs[0].started && runs[0].started.id === runs[0].key && runs[0].started.craft === 'glider' && runs[0].started.gates === 4 && runs[0].started.name === 'Course timing', JSON.stringify(runs[0].started));
  check('crossing', 'roles and indices in order; the start reports no split', runs[0].gates.map((gate) => `${gate.index}:${gate.role}`).join(' ') === '0:start 1:checkpoint 2:checkpoint 3:finish' && runs[0].gates[0].split === undefined && Math.abs(runs[0].gates[1].split - 7.5) < 1e-9, JSON.stringify(runs[0].gates.map((gate) => ({ index: gate.index, role: gate.role, split: gate.split }))));
}

// ---- splits, medals ----------------------------------------------------------------------------------------
function testSplitsAndMedals() {
  const storage = createStorage();
  const lab = createLab({ storage });
  const key = lab.challenges.register(straightCourse('splits', [100, 500, 900]), { owner: 'lab' });
  flyNorth(lab, { endZ: -950, speed: 30, frames: [1 / 60] });
  const first = lab.typed('challengeFinished')[0];
  lab.events.length = 0;
  flyNorth(lab, { endZ: -950, speed: 40, frames: [1 / 60] });
  const faster = lab.typed('challengeGate');
  const second = lab.typed('challengeFinished')[0];
  lab.events.length = 0;
  flyNorth(lab, { endZ: -950, speed: 35, frames: [1 / 60] });
  const slower = lab.typed('challengeGate');
  const third = lab.typed('challengeFinished')[0];
  check('splits', 'a faster run shows negative deltas at every checkpoint and the finish', faster.filter((gate) => gate.role !== 'start').every((gate) => gate.delta < 0) && Math.abs(faster[1].delta - (400 / 40 - 400 / 30)) < 1e-9, JSON.stringify(faster.map((gate) => gate.delta)));
  check('splits', 'a slower run than the best shows positive deltas; the best stays', slower.filter((gate) => gate.role !== 'start').every((gate) => gate.delta > 0) && !third.improved && third.best === second.time, JSON.stringify({ deltas: slower.map((gate) => gate.delta), best: third.best }));
  check('splits', 'the first run is a new best with no deltas', first.improved && lab.challenges.getBest(key, 'glider').time === second.time && first.time > second.time, JSON.stringify({ first, second }));
  const medals = { gold: 20, silver: 25, bronze: 30 };
  check('medals', 'thresholds: 19 gold, 20 gold, 24 silver, 29.9 bronze, 31 none, no medals none', medalFor(medals, 19) === 'gold' && medalFor(medals, 20) === 'gold' && medalFor(medals, 24) === 'silver' && medalFor(medals, 29.9) === 'bronze' && medalFor(medals, 31) === 'none' && medalFor(null, 5) === 'none');
  check('medals', 'finished runs carry the medal of their time (800 m at 40 m/s = 20 s: gold; 30 m/s = 26.7 s: bronze)', second.medal === 'gold' && first.medal === 'bronze', `${second.time.toFixed(2)} ${second.medal}, ${first.time.toFixed(2)} ${first.medal}`);
}

// ---- misses ------------------------------------------------------------------------------------------------
function missRun(mode, extra = {}) {
  const lab = createLab();
  lab.challenges.register(straightCourse(`miss-${mode}`, [100, 400, 700, 1000], { missed: { mode, penaltySeconds: 4, ...extra } }), { owner: 'lab' });
  // Through the start, beside the first checkpoint (outside crossing), through the second, through the finish.
  flyNorth(lab, { endZ: -1050, speed: 50, frames: [1 / 60], offsetAt: (z) => (z < -300 && z > -500 ? { x: 60, y: 0 } : null) });
  return { lab, gates: lab.typed('challengeGate'), finished: lab.typed('challengeFinished')[0] ?? null };
}

function testMisses() {
  const penalty = missRun('penalty');
  check('misses', "'penalty': an outside crossing misses the gate and adds its seconds to the time", penalty.gates[1].missed && penalty.finished && penalty.finished.missed === 1 && penalty.finished.penalties === 4 && Math.abs(penalty.finished.time - (900 / 50 + 4)) < 1e-6 && penalty.finished.valid, JSON.stringify(penalty.finished));
  const voided = missRun('void');
  check('misses', "'void': the run finishes, valid false, medal none, no best stored", voided.finished && !voided.finished.valid && voided.finished.medal === 'none' && !voided.finished.improved && voided.finished.best === null && voided.lab.storage.writes.length === 0, JSON.stringify(voided.finished));
  const counted = missRun('count');
  check('misses', "'count': the miss is counted, no time added", counted.finished && counted.finished.missed === 1 && counted.finished.penalties === 0 && counted.finished.valid, JSON.stringify(counted.finished));
  // Skipped gate: the pilot passes 150 m beyond the plane... by flying around it (no crossing): from
  // beside the course, past the plane, then back onto the line.
  const lab = createLab();
  lab.challenges.register(straightCourse('skip', [100, 400, 1000], { missed: { mode: 'penalty', penaltySeconds: 3, skipDistance: 150 } }), { owner: 'lab' });
  const position = lab.state.player.position;
  position.set(0, 100, 50);
  for (let z = 50; z > -250; z -= 1) {
    position.set(0, 100, z);
    lab.step(1 / 50);
  }
  // A teleport-sized jump past the plane is skipped as a segment, then the overshoot is a miss.
  position.set(0, 100, -700);
  lab.step(1 / 50);
  lab.step(1 / 50);
  const skipped = lab.typed('challengeGate');
  check('misses', 'a gate left 150 m behind without a crossing (after a skipped jump) is missed', skipped.length === 2 && skipped[1].index === 1 && skipped[1].missed && lab.challenges.getState().penalties === 3, JSON.stringify(skipped));
  const ignoring = createLab();
  ignoring.challenges.register(straightCourse('ignore', [100, 400, 1000], { missed: { mode: 'penalty', penaltySeconds: 3, outsideCrossing: 'ignore', skipDistance: 5000 } }), { owner: 'lab' });
  flyNorth(ignoring, { endZ: -450, speed: 50, frames: [1 / 60], offsetAt: (z) => (z < -300 ? { x: 60, y: 0 } : null) });
  const afterBeside = ignoring.challenges.getState().gateIndex;
  // Back south of the gate and through it this time.
  ignoring.state.player.position.set(0, 100, -380);
  ignoring.step(1 / 60);
  for (let z = -380; z > -1050; z -= 1) {
    ignoring.state.player.position.set(0, 100, z);
    ignoring.step(1 / 50);
  }
  const ignoredFinish = ignoring.typed('challengeFinished')[0];
  check('misses', "outsideCrossing 'ignore': flying beside the gate does nothing; coming back through it passes", afterBeside === 1 && ignoredFinish && ignoredFinish.missed === 0, JSON.stringify({ afterBeside, finish: ignoredFinish }));
}

function testSensors() {
  const lab = createLab();
  lab.challenges.register(straightCourse('kites', [100, 500, 900], { sensors: { kiteString: { penaltySeconds: 2 } } }), { owner: 'lab' });
  let touched = false;
  const position = lab.state.player.position;
  position.set(0, 100, 50);
  for (let z = 50; z > -950; z -= 1) {
    position.set(0, 100, z);
    lab.step(1 / 50);
    if (!touched && z < -300) {
      touched = true;
      lab.bus.emit('colliderSensor', { id: 'kite:1', owner: 'lab', tag: 'kiteString', craft: 'glider', position: { x: 0, y: 100, z } });
      lab.bus.emit('colliderSensor', { id: 'other:1', owner: 'lab', tag: 'unrelated', craft: 'glider', position: { x: 0, y: 100, z } });
    }
  }
  const finished = lab.typed('challengeFinished')[0];
  const sensorEvents = lab.events.filter((event) => event.type === 'challenge:sensorMiss');
  check('sensors', 'a course sensor tag counts a miss and its penalty; other tags are ignored', finished && finished.missed === 1 && finished.penalties === 2 && sensorEvents.length === 1, JSON.stringify({ finished, sensorEvents }));
}

// ---- bests and storage ----------------------------------------------------------------------------------------
function testBests() {
  const storage = createStorage();
  const lab = createLab({ storage });
  const key = lab.challenges.register(straightCourse('bests', [100, 600]), { owner: 'lab' });
  flyNorth(lab, { endZ: -650, speed: 40, frames: [1 / 60] });
  lab.state.flight.craft = 'jet';
  flyNorth(lab, { endZ: -650, speed: 100, frames: [1 / 60] });
  lab.state.flight.craft = 'glider';
  flyNorth(lab, { endZ: -650, speed: 30, frames: [1 / 60] });
  const glider = lab.challenges.getBest(key, 'glider');
  const jet = lab.challenges.getBest(key, 'jet');
  check('bests', 'one best per craft; a slower run does not replace it', Math.abs(glider.time - 12.5) < 1e-6 && Math.abs(jet.time - 5) < 1e-6, JSON.stringify({ glider: glider.time, jet: jet.time }));
  const stored = storage.map.get(CHALLENGE_STORAGE_KEY);
  const entry = stored?.courses?.[key];
  check('bests', `records under ${CHALLENGE_STORAGE_KEY}: { version: 1, courses: { key: { name, presetId, best: { craft: { time, medal, splits, missed, date } } } } }`, stored && stored.version === 1 && key === 'LAB-1:bests' && entry.name === 'Course bests' && entry.presetId === null && Object.keys(entry.best).sort().join(',') === 'glider,jet' && Object.keys(entry.best.glider).sort().join(',') === 'date,medal,missed,splits,time' && entry.best.glider.splits.length === 2 && entry.best.glider.splits[0] === null, JSON.stringify(stored));
  const reopened = createLab({ storage: createStorage(storage.map) });
  reopened.challenges.register(straightCourse('bests', [100, 600]), { owner: 'lab' });
  check('bests', 'a new system on the same storage reads the bests back', reopened.challenges.getBest(key, 'jet')?.time === jet.time && reopened.challenges.getRecords().courses[key].best.glider.time === glider.time);
  const damaged = createStorage(new Map([[CHALLENGE_STORAGE_KEY, { version: 1, courses: { a: { name: 7, best: { glider: { time: -3 }, jet: { time: 9, medal: 'platinum', splits: 'x' } } }, b: null } }]]));
  const repaired = createLab({ storage: damaged }).challenges.getRecords();
  check('bests', 'damaged records are repaired (bad times dropped, unknown medals none)', repaired.version === 1 && !repaired.courses.b && !repaired.courses.a.best.glider && repaired.courses.a.best.jet.medal === 'none' && repaired.courses.a.best.jet.splits.length === 0, JSON.stringify(repaired));
  const otherVersion = createLab({ storage: createStorage(new Map([[CHALLENGE_STORAGE_KEY, { version: 9, courses: { a: {} } }]])) }).challenges.getRecords();
  check('bests', 'another storage version is not read', Object.keys(otherVersion.courses).length === 0);
}

function testPath() {
  const storage = createStorage();
  const lab = createLab({ storage });
  const key = lab.challenges.register(straightCourse('path', [100, 340, 640]), { owner: 'lab' });
  flyNorth(lab, { endZ: -700, speed: 37, frames: [1 / 60, 1 / 47, 1 / 90] });
  const finish = lab.typed('challengeFinished')[0];
  const path = lab.challenges.getBestPath(key, 'glider');
  const frames = path?.frames;
  const count = frames ? frames.length / PATH_FRAME_STRIDE : 0;
  const duration = 540 / 37;
  const expectedLattice = Math.floor(duration * BEST_PATH_HZ) + 1;
  let ordered = true;
  let worstPosition = 0;
  for (let index = 0; index < count; index++) {
    const t = frames[index * PATH_FRAME_STRIDE];
    if (index > 0 && !(t > frames[(index - 1) * PATH_FRAME_STRIDE])) ordered = false;
    if (index < expectedLattice && Math.abs(t - Math.fround(index / BEST_PATH_HZ)) > 1e-6) ordered = false;
    const expectedZ = -100 - 37 * t;
    worstPosition = Math.max(worstPosition, Math.abs(frames[index * PATH_FRAME_STRIDE + 3] - expectedZ), Math.abs(frames[index * PATH_FRAME_STRIDE + 2] - 100));
  }
  check('path', `10 Hz frames from the start crossing plus the finish frame (${expectedLattice} + 1)`, path && path.hz === 10 && count === expectedLattice + 1 && ordered && Math.abs(frames[(count - 1) * PATH_FRAME_STRIDE] - duration) < 1e-4 && Math.abs(finish.time - duration) < 1e-9, `${count} frames, last t ${frames ? frames[(count - 1) * PATH_FRAME_STRIDE] : 'none'}`);
  check('path', 'each frame lies on the flown line at its time (float32)', worstPosition < 0.01, `worst ${worstPosition.toFixed(5)} m`);
  const storedKey = `${CHALLENGE_PATH_KEY_PREFIX}${key}.glider`;
  const stored = storage.map.get(storedKey);
  check('path', `stored under ${CHALLENGE_PATH_KEY_PREFIX}<courseKey>.<craft> as { version: 1, hz: 10, frames: [...] }`, stored && stored.version === 1 && stored.hz === 10 && Array.isArray(stored.frames) && stored.frames.length === count * PATH_FRAME_STRIDE, storedKey);
  const reopened = createLab({ storage: createStorage(storage.map) });
  const back = reopened.challenges.getBestPath(key, 'glider');
  check('path', 'the storage round trip gives the same frames', back && back.frames.length === frames.length && back.frames.every((value, index) => value === frames[index]));
  const writesBefore = storage.writes.length;
  flyNorth(lab, { endZ: -700, speed: 20, frames: [1 / 60] });
  check('path', 'a slower run stores no path (only an improved best does)', storage.writes.length === writesBefore && lab.challenges.getBestPath(key, 'glider').frames.length === frames.length, `${storage.writes.length - writesBefore} writes`);
  check('path', 'no path for a craft without a best', lab.challenges.getBestPath(key, 'jet') === null);
}

// ---- lifecycle -------------------------------------------------------------------------------------------------
function testLifecycle() {
  const lab = createLab();
  const key = lab.challenges.register(straightCourse('life', [100, 400, 700]), { owner: 'lab' });
  lab.state.player.position.set(0, 100, 300);
  lab.step(1 / 60);
  const prompt = lab.challenges.getState().prompt;
  check('lifecycle', 'near a start gate the prompt names the course, distance and bearing', prompt && prompt.courseKey === key && prompt.name === 'Course life' && Math.abs(prompt.distance - 400) < 1e-6 && Math.abs(prompt.bearing) < 1e-6, JSON.stringify(prompt));
  check('lifecycle', 'nearest(radius) finds the start gate; count() counts courses', lab.challenges.nearest(5000)?.courseKey === key && lab.challenges.nearest(100) === null && lab.challenges.count() === 1);
  // Y: arms the course (the clock waits for the start gate).
  lab.bus.emit('input:action', { id: 'challengeStart', phase: 'press', source: 'keyboard' });
  const armed = lab.challenges.getState();
  check('lifecycle', 'Y near a course arms it: phase armed, nextGate is the start', armed.phase === 'armed' && armed.active && armed.nextGate && armed.nextGate.z === -100 && lab.typed('challengeStarted').length === 0, JSON.stringify({ phase: armed.phase, nextGate: armed.nextGate }));
  flyNorth(lab, { startZ: 300, endZ: -200, speed: 50, frames: [1 / 60] });
  check('lifecycle', 'flying the start gate starts the clock', lab.challenges.getState().phase === 'running' && lab.typed('challengeStarted').length === 1 && lab.challenges.getState().gateIndex === 1);
  lab.bus.emit('input:action', { id: 'challengeStart', phase: 'press', source: 'keyboard' });
  check('lifecycle', 'Y during a run cancels it (reason cancelled)', lab.typed('challengeCancelled')[0]?.reason === 'cancelled' && !lab.challenges.getState().active);
  // Flying through a start gate with nothing armed starts the course.
  lab.events.length = 0;
  flyNorth(lab, { startZ: 50, endZ: -200, speed: 50, frames: [1 / 60] });
  check('lifecycle', 'flying a start gate with nothing armed starts that course', lab.typed('challengeStarted').length === 1 && lab.challenges.getState().phase === 'running');
  // Abandon: fly 5 km east.
  for (let index = 0; index < 400; index++) {
    lab.state.player.position.x += 15;
    lab.step(1 / 60);
  }
  check('lifecycle', 'flying away past abandonDistance cancels (reason abandoned)', lab.typed('challengeCancelled').at(-1)?.reason === 'abandoned' && !lab.challenges.getState().active);
  // A soft crash ends the run.
  lab.events.length = 0;
  flyNorth(lab, { startZ: 50, endZ: -200, speed: 50, frames: [1 / 60] });
  lab.bus.emitTyped('softCrash', { craft: 'glider', reason: 'terrain', impactSpeed: 20, position: { x: 0, y: 0, z: 0 } });
  check('lifecycle', 'a soft crash cancels the run (reason crash)', lab.typed('challengeCancelled').at(-1)?.reason === 'crash');
  // Time limit.
  const timed = createLab();
  timed.challenges.register(straightCourse('timed', [100, 400, 700], { timeLimit: 3 }), { owner: 'lab' });
  flyNorth(timed, { startZ: 50, endZ: -400, speed: 50, frames: [1 / 60] });
  for (let index = 0; index < 300; index++) timed.step(1 / 60);
  check('lifecycle', 'a run over its timeLimit is cancelled (reason timeLimit)', timed.typed('challengeCancelled')[0]?.reason === 'timeLimit');
  // Immediate courses start at once.
  const immediate = createLab();
  const immediateKey = immediate.challenges.register({ ...straightCourse('now', [100, 400]), start: { mode: 'immediate' } }, { owner: 'lab' });
  immediate.challenges.start(immediateKey, { source: 'copilot' });
  check('lifecycle', 'an immediate start runs the clock at once, the first gate next', immediate.challenges.getState().phase === 'running' && immediate.challenges.getState().gateIndex === 1 && immediate.typed('challengeStarted').length === 1);
  // A teleport segment is never a crossing.
  const teleport = createLab();
  teleport.challenges.register(straightCourse('tp', [100, 400, 700]), { owner: 'lab' });
  teleport.state.player.position.set(0, 100, 50);
  teleport.step(1 / 60);
  teleport.state.player.position.set(0, 100, -600);
  teleport.step(1 / 60);
  check('lifecycle', 'a teleport across a start gate does not start the course', teleport.typed('challengeStarted').length === 0);
  // Register again (a re-created site): gates replaced, records kept; unregister cancels a run.
  const again = createLab();
  const againKey = again.challenges.register(straightCourse('again', [100, 400]), { owner: 'lab' });
  flyNorth(again, { startZ: 50, endZ: -450, speed: 50, frames: [1 / 60] });
  const keyAgain = again.challenges.register(straightCourse('again', [100, 400]), { owner: 'lab' });
  check('lifecycle', 'a second register of a course key replaces it and keeps its records', keyAgain === againKey && again.challenges.count() === 1 && again.challenges.getBest(againKey, 'glider') !== null);
  again.events.length = 0;
  flyNorth(again, { startZ: 50, endZ: -200, speed: 50, frames: [1 / 60] });
  again.challenges.unregister(againKey);
  check('lifecycle', 'unregister cancels an active run (reason removed) and removes the course', again.typed('challengeCancelled')[0]?.reason === 'removed' && again.challenges.count() === 0 && !again.challenges.getState().active);
  const idle = createLab();
  const idleKey = idle.challenges.register(straightCourse('idle', [100, 400]), { owner: 'lab' });
  idle.state.player.position.set(0, 100, 600);
  idle.step(1 / 60);
  const promptBefore = idle.challenges.getState().prompt?.courseKey ?? null;
  idle.challenges.unregister(idleKey);
  check('lifecycle', 'unregister drops the course from the start prompt at once (not on the next frame)', promptBefore === idleKey && idle.challenges.getState().prompt === null, String(promptBefore));
  const lonely = createLab();
  lonely.bus.emit('input:action', { id: 'challengeStart', phase: 'press', source: 'keyboard' });
  check('lifecycle', 'Y with no course nearby only says so', lonely.events.some((event) => event.type === 'notify') && !lonely.challenges.getState().active);
}

// ---- validation ------------------------------------------------------------------------------------------------
function refused(fn, pattern) {
  try {
    fn();
  } catch (error) {
    return pattern.test(error.message);
  }
  return false;
}

function testValidation() {
  const good = straightCourse('v', [100, 400]);
  const cases = [
    ['no gates', { ...good, gates: [] }, /gates/],
    ['finish not last', { ...good, gates: [good.gates[0], { ...good.gates[1], role: 'finish' }, { ...good.gates[1], id: 'x', role: 'checkpoint' }] }, /finish|last/],
    ['zero normal', { ...good, gates: [good.gates[0], { ...good.gates[1], normal: { x: 0, y: 0, z: 0 } }] }, /normal/],
    ['circle without radius', { ...good, gates: [{ ...good.gates[0], radius: undefined }, good.gates[1]] }, /radius/],
    ['medals out of order', { ...good, medals: { gold: 30, silver: 20, bronze: 40 } }, /medals/],
    ['unknown miss mode', { ...good, missed: { mode: 'forgive' } }, /missed\.mode/],
    ['gate start without a start gate', { ...good, gates: [{ ...good.gates[0], role: 'checkpoint' }, good.gates[1]] }, /start/],
    ['bad sensor rule', { ...good, sensors: { kiteString: { penaltySeconds: -1 } } }, /sensors\.kiteString/],
  ];
  for (const [label, definition, pattern] of cases) check('validation', `refused: ${label}`, refused(() => validateCourseDefinition(definition), pattern) && refused(() => validateCourseDefinition(definition), /challenge course "v"/));
  const block = {
    name: 'Lab Gauntlet',
    gates: [{ role: 'start', along: 0, height: 30, shape: 'rect', halfWidth: 40, halfHeight: 20 }, { role: 'checkpoint', along: 500, across: 50, height: 40, heading: 20, radius: 25 }, { role: 'finish', along: 1000, height: 30, radius: 30 }],
    medals: { gold: 30, silver: 40, bronze: 55 },
  };
  check('validation', 'a valid preset challenge block passes', validateChallengeBlock(block, 'labPreset') === true);
  check('validation', 'a block with an unknown field is refused naming the preset and field', refused(() => validateChallengeBlock({ ...block, colour: 1 }, 'labPreset'), /preset "labPreset": challenge\.colour/));
  check('validation', 'a block whose gates break the course rules is refused', refused(() => validateChallengeBlock({ ...block, gates: block.gates.slice(1) }, 'labPreset'), /preset "labPreset": challenge/));
  const course = buildSiteCourse(block, { presetId: 'labPreset', siteId: 'labPreset:3:-2', presetName: 'Lab', anchor: { x: 1000, y: 50, z: 2000 }, heading: 90, ground: () => 70 });
  const normalized = validateCourseDefinition(course);
  const second = normalized.gates[1];
  check('validation', 'buildSiteCourse: id, the site heading (90 = east), across to the right, height above the ground', normalized.id === 'labPreset:labPreset:3:-2' && Math.abs(second.cx - 1500) < 1e-9 && Math.abs(second.cz - 2050) < 1e-9 && second.cy === 110 && Math.abs(second.nx - Math.cos(20 * Math.PI / 180)) < 1e-9, JSON.stringify({ id: normalized.id, cx: second.cx, cz: second.cz, cy: second.cy, nx: second.nx, nz: second.nz }));
  // A real site preset of the game with a challenge block added.
  const site = PRESETS.find((candidate) => candidate.kind === 'site');
  const preset = { ...JSON.parse(JSON.stringify(site)), id: 'labGauntlet', challenge: block };
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };
  let presetError = null;
  try {
    validatePreset(deepFreeze(preset));
  } catch (error) {
    presetError = error.message;
  }
  check('validation', 'the preset schema accepts a challenge block and refuses a broken one', presetError === null && refused(() => validatePreset(deepFreeze({ ...preset, challenge: { gates: [] } })), /labGauntlet.*challenge/), presetError ?? '');
}

function testDeterminism() {
  const flight = () => {
    const lab = createLab();
    lab.challenges.register(straightCourse('det', [100, 330, 610, 900], { sensors: { kiteString: { penaltySeconds: 1.5 } } }), { owner: 'lab' });
    flyNorth(lab, { endZ: -950, speed: 44, frames: [1 / 61, 1 / 37, 1 / 83], offsetAt: (z) => ({ x: 5 * Math.sin(z / 40), y: 3 * Math.cos(z / 55) }) });
    return JSON.stringify({ events: lab.events.map((event) => ({ ...event, payload: event.type === 'challengeFinished' ? { ...event.payload } : event.payload })).filter((event) => event.type !== 'notify'), records: lab.challenges.getRecords().courses['LAB-1:det'].best.glider.splits, path: Array.from(lab.challenges.getBestPath('LAB-1:det', 'glider').frames) });
  };
  check('determinism', 'two identical flights give identical events, splits and paths', flight() === flight());
}

// ---- allocation ----------------------------------------------------------------------------------------------
async function testAllocation() {
  const lab = createLab();
  // A long course flown slowly: every frame detects against the current gate, writes the live state
  // (the medal pace), the prompt (a second course nearby) and the path recorder, with no crossing for
  // the whole measure. The warm-up flies far enough for every branch the measure takes to run first
  // (the pace projection starts at a tenth of the course): a branch first seen during the measure
  // deoptimises, and the interpreter boxes doubles until the code is optimised again.
  const key = lab.challenges.register(straightCourse('long', [100, 20000], { abandonDistance: 200000 }), { owner: 'lab' });
  lab.challenges.register(straightCourse('near', [-300, 400]), { owner: 'lab' });
  void key;
  const position = lab.state.player.position;
  position.set(0, 100, 50);
  for (let z = 50; z > -150; z -= 2) {
    position.set(0, 100, z);
    lab.step(1 / 60);
  }
  const live = lab.challenges.getState();
  check('allocation', 'the long course is running', live.phase === 'running' && live.courseKey === 'LAB-1:long', live.phase);
  const clock = new Float64Array(1);
  clock[0] = -150;
  const frame = () => {
    clock[0] -= 0.05;
    position.z = clock[0];
    lab.step(1 / 60);
  };
  for (let index = 0; index < 150000; index++) frame();
  // The path recorder fills at 10 Hz: start the measured stretch with an empty recorder slot budget.
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const before = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const after = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const perFrame = (after - before) / frames;
  check('allocation', `no garbage collection during ${frames} running frames`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(4)} B/frame`);
  check('allocation', 'the run stayed live through the measure', lab.challenges.getState().phase === 'running', lab.challenges.getState().phase);
}

await testAllocation();
testRings();
testCrossing();
testSplitsAndMedals();
testMisses();
testSensors();
testBests();
testPath();
testLifecycle();
testValidation();
testDeterminism();

check('console', 'no console errors (typed event payloads valid)', consoleErrors.length === 0, consoleErrors.join(' | '));
console.error = originalError;

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(12)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
