// Ring course golden logs (contract f.4): six scripted flights through the ring course, run headless
// (node, three's node materials without a renderer) on a stub world, recording everything the ring
// course promises to the rest of the game:
//   - every event emitted on the bus (type, payload, frame), in order;
//   - state.ringCourse (every field) and getStats().lastCrossing, as a float64 digest per frame plus a
//     full snapshot on every frame that emitted an event;
//   - every journal.recordRingCourse call.
// The ring planner draws on Math.random, so each flight replaces it with a seeded mulberry32 stream
// for its duration: the courses are the same on every run.
//
// The fixture tools/lab/fixtures/rings-golden.json was recorded from the Phase 2 rings (before the
// migration onto the challenge core) with `node tools/lab/ringsGolden.mjs --record`. The challenges
// lab (tools/lab/challenges.mjs) replays the same flights on the current code and needs equality.
//
// Flights: clean (every ring flown through, a paused stretch), misses (horizontal and vertical
// outside crossings, an edge pass, an overshoot after a skipped segment, a missed last ring), abandon
// (flown away past the abandon distance), teleport (a skipped jump, a jump back and a paused pass
// that becomes an overshoot), cancel (the R key mid-course, then a second cancel that does nothing)
// and restart (a start over a live course, a clamped ring count, the default count).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { CONFIG } from '../../src/core/config.js';

export const RING_GOLDEN_FIXTURE = fileURLToPath(new URL('./fixtures/rings-golden.json', import.meta.url));
export const RING_GOLDEN_VERSION = 1;
export const RING_GOLDEN_FLIGHTS = Object.freeze(['clean', 'misses', 'abandon', 'teleport', 'cancel', 'restart']);

/** A seeded mulberry32 generator (the game's deterministic stream). */
function mulberry32(seed) {
  let value = seed >>> 0;
  return function next() {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rolling hills a few hundred metres high: the planner's terrain floor and grades get exercised. */
function createStubWorld() {
  const heightAt = (x, z) => 90 * Math.sin(x / 700) * Math.cos(z / 900) + 60 + 35 * Math.sin((x + z) / 260);
  return { heightAt, groundHeight: heightAt };
}

/** FNV-1a over the float64 bytes of the numbers pushed in; returns 8 hex digits. */
function createDigest() {
  const scratch = new Float64Array(1);
  const bytes = new Uint8Array(scratch.buffer);
  let hash = 0x811c9dc5;
  return {
    number(value) {
      scratch[0] = value;
      for (let index = 0; index < 8; index++) hash = Math.imul(hash ^ bytes[index], 0x01000193);
    },
    text(value) {
      for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    },
    hex() {
      return (hash >>> 0).toString(16).padStart(8, '0');
    },
  };
}

function snapshotState(ringCourse, lastCrossing, active) {
  const point = (value) => (value ? { x: value.x, y: value.y, z: value.z } : null);
  return {
    active: ringCourse.active,
    total: ringCourse.total,
    passed: ringCourse.passed,
    missed: ringCourse.missed,
    streak: ringCourse.streak,
    bestStreak: ringCourse.bestStreak,
    elapsed: ringCourse.elapsed,
    nextIndex: ringCourse.nextIndex,
    nextRingPosition: point(ringCourse.nextRingPosition),
    nextRingNormal: point(ringCourse.nextRingNormal),
    nextRingDistance: ringCourse.nextRingDistance,
    lastCrossing: { ...lastCrossing },
    isActive: active,
  };
}

function digestState(snapshot) {
  const digest = createDigest();
  const flag = (value) => digest.number(value === true ? 1 : value === false ? 0 : -1);
  flag(snapshot.active);
  for (const field of ['total', 'passed', 'missed', 'streak', 'bestStreak', 'elapsed', 'nextIndex', 'nextRingDistance']) digest.number(snapshot[field]);
  for (const field of ['nextRingPosition', 'nextRingNormal']) {
    const point = snapshot[field];
    if (point) {
      digest.number(point.x);
      digest.number(point.y);
      digest.number(point.z);
    } else {
      digest.text('null');
    }
  }
  digest.number(snapshot.lastCrossing.index);
  digest.number(snapshot.lastCrossing.offset);
  digest.number(snapshot.lastCrossing.vertical);
  digest.text(snapshot.lastCrossing.result);
  flag(snapshot.isActive);
  return digest.hex();
}

/** Deep plain copy of an event payload (vectors become { x, y, z }). */
function clonePayload(payload) {
  return payload === undefined ? null : JSON.parse(JSON.stringify(payload));
}

/**
 * The headless game for one flight: the stub world, the state the ring course reads and writes, a
 * typed bus whose every emit is logged, and a journal that logs recordRingCourse. `createSystems(ctx)`
 * returns { rings, order }: the ring course handle and the systems updated each frame, in order.
 */
function createFlightLab(createSystems) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const log = { events: [], journal: [], digests: [], snapshots: [] };
  const lab = { frame: 0 };
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    log.events.push({ frame: lab.frame, type, payload: clonePayload(payload) });
    emit(type, payload);
  };
  const state = {
    frame: 0,
    paused: false,
    photoMode: false,
    seed: 'RINGS-GOLDEN',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0 },
    player: {
      position: new THREE.Vector3(0, 320, 0),
      velocity: new THREE.Vector3(0, 0, -40),
      quaternion: new THREE.Quaternion(),
      heading: 0,
      speed: 40,
    },
    flight: { craft: 'glider' },
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const ctx = {
    THREE,
    TSL,
    CONFIG,
    scene: new THREE.Scene(),
    bus,
    state,
    world: createStubWorld(),
    uniforms: { time: TSL.uniform(0), playerPosition: TSL.uniform(new THREE.Vector3()) },
    settings: { get: () => undefined, set: () => {} },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    systems: {
      journal: {
        recordRingCourse(result) {
          log.journal.push({ frame: lab.frame, result: clonePayload(result) });
        },
      },
    },
    registerPrewarm() {},
  };
  const { rings, order } = createSystems(ctx);
  lab.ctx = ctx;
  lab.rings = rings;
  lab.log = log;
  /** One frame of `dt` seconds (0: paused), the systems in order, then the frame's record. */
  lab.step = (dt) => {
    lab.frame++;
    state.frame = lab.frame;
    state.paused = dt === 0;
    state.time.frameDt = dt;
    state.time.elapsed += dt;
    ctx.uniforms.time.value = state.time.elapsed;
    const eventsBefore = log.events.length;
    for (const system of order) system.update(dt, dt === 0 ? 1 / 60 : dt);
    const snapshot = snapshotState(state.ringCourse, rings.getStats().lastCrossing, rings.isActive());
    log.digests.push(digestState(snapshot));
    if (log.events.length > eventsBefore) log.snapshots.push({ frame: lab.frame, state: snapshot });
  };
  return lab;
}

// ---- The pilot ----------------------------------------------------------------------------------------
const scratchTarget = new THREE.Vector3();
const scratchSide = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Flies toward the current ring: the aim point is `beyond` metres past the ring centre along its
 * axis, shifted `lateral` metres to the ring's right and `vertical` metres up, at `speed` m/s.
 */
function flyTowardRing(lab, dt, { speed = 55, lateral = 0, vertical = 0, beyond = 60 } = {}) {
  const course = lab.ctx.state.ringCourse;
  const position = lab.ctx.state.player.position;
  if (course.nextRingPosition) {
    const normal = course.nextRingNormal;
    scratchSide.set(normal.x, normal.y, normal.z).cross(WORLD_UP).normalize();
    const center = course.nextRingPosition;
    scratchTarget.set(center.x + normal.x * beyond, center.y + normal.y * beyond, center.z + normal.z * beyond)
      .addScaledVector(scratchSide, lateral);
    scratchTarget.y += vertical;
    scratchTarget.sub(position);
    const distance = scratchTarget.length();
    if (distance > 1e-6) position.addScaledVector(scratchTarget, Math.min(1, (speed * dt) / distance));
  } else {
    position.z -= speed * dt;
  }
  lab.step(dt);
}

/** Flies along a fixed world direction. */
function flyDirection(lab, dt, x, y, z, speed = 55) {
  lab.ctx.state.player.position.x += x * speed * dt;
  lab.ctx.state.player.position.y += y * speed * dt;
  lab.ctx.state.player.position.z += z * speed * dt;
  lab.step(dt);
}

/** The frame time sequence: a busy machine's frames, deterministic per flight. */
function createFrameClock(seed) {
  const random = mulberry32(seed);
  return () => (1 / 60) * (0.75 + random() * 0.9);
}

/** Flies toward the current ring until its index changes (or the course ends); returns frames flown. */
function flyRing(lab, clock, options = {}, limit = 4000) {
  const course = lab.ctx.state.ringCourse;
  const index = course.nextIndex;
  let frames = 0;
  while (course.active && course.nextIndex === index && frames < limit) {
    flyTowardRing(lab, clock(), options);
    frames++;
  }
  return frames;
}

function coast(lab, clock, frames) {
  for (let index = 0; index < frames; index++) flyTowardRing(lab, clock());
}

/** Distance (m) from the player to the current ring's plane (negative before it). */
function planeDistance(lab) {
  const course = lab.ctx.state.ringCourse;
  const position = lab.ctx.state.player.position;
  const normal = course.nextRingNormal;
  const center = course.nextRingPosition;
  return (position.x - center.x) * normal.x + (position.y - center.y) * normal.y + (position.z - center.z) * normal.z;
}

/** Moves the player along the current ring's axis until it is `distance` metres from the plane. */
function approachPlane(lab, clock, distance, options = {}) {
  let frames = 0;
  while (lab.ctx.state.ringCourse.active && planeDistance(lab) < distance && frames < 4000) {
    flyTowardRing(lab, clock(), options);
    frames++;
  }
}

const FLIGHTS = {
  clean(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 10 });
    for (let ring = 0; ring < 10; ring++) {
      if (ring === 4) {
        // A paused stretch (photo mode): no time passes and nothing is detected.
        for (let frame = 0; frame < 20; frame++) lab.step(0);
      }
      flyRing(lab, clock, { lateral: ring % 2 ? 3 : -2, vertical: ring % 3 - 1 });
    }
    coast(lab, clock, 150);
  },
  misses(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 8 });
    flyRing(lab, clock);
    flyRing(lab, clock, { lateral: 30 });
    flyRing(lab, clock, { vertical: -26 });
    flyRing(lab, clock, { lateral: 12.2, vertical: 12.2 });
    // Overshoot: a skipped segment (a jump of 420 m) carries the player past the plane, so the next
    // frame finds it beyond MISS_DISTANCE_PAST without a crossing.
    approachPlane(lab, clock, -110);
    const course = lab.ctx.state.ringCourse;
    const normal = course.nextRingNormal;
    lab.ctx.state.player.position.addScaledVector(scratchTarget.set(normal.x, normal.y, normal.z), 420);
    lab.step(clock());
    lab.step(clock());
    flyRing(lab, clock, { lateral: -40 });
    flyRing(lab, clock, { speed: 80 });
    flyRing(lab, clock, { vertical: 45 });
    coast(lab, clock, 150);
  },
  abandon(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 6 });
    flyRing(lab, clock);
    flyRing(lab, clock);
    // Away to the east until the current ring is out of the abandon distance.
    let frames = 0;
    while (lab.ctx.state.ringCourse.active && frames < 20000) {
      flyDirection(lab, clock(), 1, 0, 0, 160);
      frames++;
    }
    for (let frame = 0; frame < 120; frame++) flyDirection(lab, clock(), 1, 0, 0, 160);
  },
  teleport(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 6 });
    flyRing(lab, clock);
    const position = lab.ctx.state.player.position;
    const home = position.clone();
    // A teleport 3 km sideways (the segment is skipped), some flying there, then a jump back.
    position.x += 3000;
    lab.step(clock());
    for (let frame = 0; frame < 90; frame++) flyDirection(lab, clock(), 0, 0, -1, 60);
    position.copy(home);
    lab.step(clock());
    flyRing(lab, clock);
    // Paused frames carry the player through the next ring: the pause hides the crossing, so the
    // ring is overshot once time runs again.
    approachPlane(lab, clock, -30);
    const normal = lab.ctx.state.ringCourse.nextRingNormal;
    for (let frame = 0; frame < 12; frame++) {
      position.addScaledVector(scratchTarget.set(normal.x, normal.y, normal.z), 16);
      lab.step(0);
    }
    let frames = 0;
    const index = lab.ctx.state.ringCourse.nextIndex;
    while (lab.ctx.state.ringCourse.nextIndex === index && frames < 2000) {
      flyDirection(lab, clock(), normal.x, normal.y, normal.z, 55);
      frames++;
    }
    flyRing(lab, clock);
    flyRing(lab, clock);
    flyRing(lab, clock);
    coast(lab, clock, 120);
  },
  cancel(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 8 });
    flyRing(lab, clock);
    flyRing(lab, clock, { lateral: 25 });
    flyRing(lab, clock);
    coast(lab, clock, 30);
    lab.rings.cancel();
    coast(lab, clock, 60);
    lab.rings.cancel();
    coast(lab, clock, 60);
  },
  restart(lab, clock) {
    lab.step(clock());
    lab.rings.start({ count: 5 });
    flyRing(lab, clock);
    coast(lab, clock, 20);
    lab.rings.start({ count: 2 });
    for (let ring = 0; ring < 3; ring++) flyRing(lab, clock);
    coast(lab, clock, 40);
    lab.rings.start({});
    flyRing(lab, clock, { lateral: -35 });
    coast(lab, clock, 20);
    lab.rings.start({ count: 'many' });
    flyRing(lab, clock);
    lab.rings.cancel();
    coast(lab, clock, 60);
  },
};

/**
 * Runs one flight and returns its log: { flight, frames, events, journal, digests, snapshots }.
 * `createSystems(ctx)` builds the systems under test (see createFlightLab).
 */
export function runRingFlight(flight, createSystems, seed) {
  const originalRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const lab = createFlightLab(createSystems);
    FLIGHTS[flight](lab, createFrameClock(seed ^ 0x5bd1e995));
    return { flight, seed, frames: lab.frame, ...lab.log };
  } finally {
    Math.random = originalRandom;
  }
}

/** Seeds per flight (fixed: the fixture depends on them). */
export const RING_GOLDEN_SEEDS = Object.freeze({ clean: 101, misses: 202, abandon: 303, teleport: 404, cancel: 505, restart: 606 });

/** Runs every flight. */
export function runRingFlights(createSystems) {
  return RING_GOLDEN_FLIGHTS.map((flight) => runRingFlight(flight, createSystems, RING_GOLDEN_SEEDS[flight]));
}

/** A one-line summary of a flight log, for reports. */
export function summarizeFlight(log) {
  const counts = {};
  for (const event of log.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return `${log.flight}: ${log.frames} frames, ${Object.entries(counts).map(([type, count]) => `${type} x${count}`).join(', ')}`;
}

/**
 * Compares a replayed flight with its golden log; returns null when identical, else the first
 * difference as a sentence.
 */
export function compareFlight(golden, replay) {
  if (golden.frames !== replay.frames) return `${golden.flight}: ${replay.frames} frames, golden ${golden.frames}`;
  const length = Math.max(golden.events.length, replay.events.length);
  for (let index = 0; index < length; index++) {
    const expected = JSON.stringify(golden.events[index] ?? null);
    const actual = JSON.stringify(replay.events[index] ?? null);
    if (expected !== actual) return `${golden.flight}: event ${index} is ${actual}, golden ${expected}`;
  }
  for (let index = 0; index < golden.digests.length; index++) {
    if (golden.digests[index] !== replay.digests[index]) {
      const frame = index + 1;
      const snapshot = replay.snapshots.find((entry) => entry.frame === frame);
      return `${golden.flight}: state differs first on frame ${frame}${snapshot ? ` (${JSON.stringify(snapshot.state)})` : ''}`;
    }
  }
  if (JSON.stringify(golden.snapshots) !== JSON.stringify(replay.snapshots)) return `${golden.flight}: event-frame snapshots differ`;
  if (JSON.stringify(golden.journal) !== JSON.stringify(replay.journal)) return `${golden.flight}: journal ${JSON.stringify(replay.journal)}, golden ${JSON.stringify(golden.journal)}`;
  return null;
}

// ---- CLI: --record writes the fixture from the code as it is now ----------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flags = process.argv.slice(2);
  for (const flag of flags) {
    if (flag !== '--record') throw new Error(`Unknown flag ${flag}`);
  }
  const { createRingCourseSystem } = await import('../../src/gameplay/rings.js');
  const createSystems = (ctx) => {
    const rings = createRingCourseSystem(ctx);
    ctx.systems.rings = rings;
    return { rings, order: [rings] };
  };
  const logs = runRingFlights(createSystems);
  for (const log of logs) process.stdout.write(`${summarizeFlight(log)}\n`);
  if (flags.includes('--record')) {
    const fixture = { version: RING_GOLDEN_VERSION, recordedFrom: 'Phase 2 rings.js (before the challenge migration)', flights: logs };
    writeFileSync(RING_GOLDEN_FIXTURE, `${JSON.stringify(fixture)}\n`);
    process.stdout.write(`wrote ${RING_GOLDEN_FIXTURE}\n`);
  }
}
