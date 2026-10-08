// PathFollower lab (contract e.3): src/world/pathFollower.js in node.
//
// Tests:
//   arclength    the tabulated length of smooth paths (a closed circle of 8 points, an open wavy
//                line) is within 0.5 % of a fine polyline of the same curve; straight paths are exact;
//                sampleAt walks the path at the distances it reports
//   continuity   at() over whole periods at 120 Hz never moves more than speed x dt between ticks
//                (loop on a closed path, ping-pong, once, with waits), and the tangent turns smoothly
//   modes        loop wraps (distance = start + speed t, modulo the length), ping-pong comes back to
//                its start after one period and runs backwards on the way back, once stops at the end
//                with done set and stays there
//   waits        a stop holds the follower (speed 0) for its seconds, on every pass, both ways on a
//                ping-pong; the period grows by the waits
//   cars         a trailing car is `offset` metres behind the head along the track, and stops with it
//   ground       a follower with a ground function stands on it (plus the offset) and pitches with it
//   determinism  two followers with the same inputs agree exactly, and the answer for a time does not
//                depend on the times asked before it (a pure function of flight time)
//   groundpath   buildGroundPath across a ridge with one pass and past a lake: the route arrives,
//                never steps on water and never climbs a slope over the limit; the same seed gives the
//                same route; no allowed route reports reached false
//   allocation   100 000 at() and carAt() calls allocate nothing
//
// Usage: node --expose-gc tools/lab/path.mjs [--verbose]
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { SLOPE_RUN, buildGroundPath, createPath, createPathFollower } from '../../src/world/pathFollower.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

function circlePoints(count, radius, y = 100) {
  const points = new Float64Array(count * 3);
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    points[index * 3] = Math.cos(angle) * radius;
    points[index * 3 + 1] = y;
    points[index * 3 + 2] = Math.sin(angle) * radius;
  }
  return points;
}

function wavyPoints() {
  const points = [];
  for (let index = 0; index < 9; index++) points.push(index * 220, 50 + 30 * Math.sin(index * 1.3), 140 * Math.sin(index * 0.9));
  return new Float64Array(points);
}

/** The length of a path's own curve measured with a much finer tabulation. */
function fineLength(points, closed) {
  return createPath({ points, closed, samplesPerSegment: 256 }).length;
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// ---- arclength ---------------------------------------------------------------------------------------
function testArcLength() {
  const circle = circlePoints(8, 500);
  const circlePath = createPath({ points: circle, closed: true });
  const circleFine = fineLength(circle, true);
  const circleError = Math.abs(circlePath.length - circleFine) / circleFine;
  check('arclength', 'closed circle (8 points): within 0.5 % of a fine polyline', circleError < 0.005, `${circlePath.length.toFixed(2)} m vs ${circleFine.toFixed(2)} m (${(circleError * 100).toFixed(3)} %); true circle ${(Math.PI * 1000).toFixed(2)} m`);
  const wavy = wavyPoints();
  const wavyPath = createPath({ points: wavy });
  const wavyFine = fineLength(wavy, false);
  const wavyError = Math.abs(wavyPath.length - wavyFine) / wavyFine;
  check('arclength', 'open wavy line (9 points): within 0.5 % of a fine polyline', wavyError < 0.005, `${wavyPath.length.toFixed(2)} m vs ${wavyFine.toFixed(2)} m (${(wavyError * 100).toFixed(3)} %)`);
  const straight = createPath({ points: new Float64Array([0, 0, 0, 300, 0, 400, 300, 0, 1400]), smoothing: 'linear' });
  check('arclength', 'straight segments: exact length', straight.length === 1500, String(straight.length));
  const out = { x: 0, y: 0, z: 0 };
  straight.sampleAt(750, out);
  check('arclength', 'sampleAt on straight segments lands at the measured distance', Math.abs(out.x - 300) < 1e-9 && Math.abs(out.z - 650) < 1e-9, JSON.stringify(out));
  const start = wavyPath.sampleAt(0, { x: 0, y: 0, z: 0 });
  const end = wavyPath.sampleAt(wavyPath.length, { x: 0, y: 0, z: 0 });
  check('arclength', 'an open path starts and ends at its first and last points; distances clamp', start.x === wavy[0] && start.z === wavy[2] && end.x === wavy[24] && end.z === wavy[26] && wavyPath.sampleAt(-50, { x: 0, y: 0, z: 0 }).x === wavy[0], `${JSON.stringify(start)} ${JSON.stringify(end)}`);
  // Walking the table in 1 m steps covers 1 m of chord each (the parametrisation is by arc length).
  let worst = 0;
  const previous = { x: 0, y: 0, z: 0 };
  const current = { x: 0, y: 0, z: 0 };
  circlePath.sampleAt(0, previous);
  for (let along = 1; along <= circlePath.length; along += 1) {
    circlePath.sampleAt(along, current);
    worst = Math.max(worst, Math.abs(distance3(previous, current) - 1));
    previous.x = current.x;
    previous.y = current.y;
    previous.z = current.z;
  }
  check('arclength', 'sampleAt is parametrised by arc length (1 m steps cover 1 m)', worst < 0.002, `worst ${worst.toFixed(5)} m`);
  const nearest = circlePath.nearestDistance(0, 100, 520);
  const atNearest = circlePath.sampleAt(nearest, { x: 0, y: 0, z: 0 });
  check('arclength', 'nearestDistance finds the closest point on the path', Math.abs(atNearest.x) < 2 && Math.abs(atNearest.z - 500) < 3, `${nearest.toFixed(1)} m -> ${JSON.stringify(atNearest)}`);
  let refused = 0;
  for (const bad of [{ points: new Float64Array([0, 0, 0]) }, { points: [0, 0] }, { points: new Float64Array([0, 0, 0, NaN, 0, 0]) }, { points: new Float64Array([0, 0, 0, 1, 0, 0]), smoothing: 'bezier' }]) {
    try {
      createPath(bad);
    } catch (error) {
      if (/pathFollower/.test(error.message)) refused++;
    }
  }
  check('arclength', 'bad paths are refused with an error naming the module', refused === 4, `${refused}/4`);
}

// ---- continuity, modes, waits -------------------------------------------------------------------------------
function walk(follower, from, to, dt, visit) {
  const out = {};
  for (let time = from; time <= to + 1e-9; time += dt) visit(time, follower.at(time, out));
}

function testContinuity() {
  const circlePath = createPath({ points: circlePoints(8, 500), closed: true });
  const wavyPath = createPath({ points: wavyPoints() });
  const cases = [
    ['loop (closed, waits)', createPathFollower({ path: circlePath, speed: 30, mode: 'loop', startTime: 3, startDistance: 400, waits: [{ distance: 100, seconds: 4 }, { distance: 2000, seconds: 2 }] })],
    ['pingpong (waits at an end and midway)', createPathFollower({ path: wavyPath, speed: 25, mode: 'pingpong', waits: [{ distance: wavyPath.length, seconds: 3 }, { distance: 500, seconds: 1.5 }] })],
    ['once', createPathFollower({ path: wavyPath, speed: 40, mode: 'once', startTime: 10 })],
  ];
  for (const [label, follower] of cases) {
    const dt = 1 / 120;
    const span = Number.isFinite(follower.duration) ? follower.duration + 20 : follower.period * 2;
    let worstStep = 0;
    let worstTurn = 0;
    let previous = null;
    walk(follower, 0, span, dt, (time, out) => {
      if (previous) {
        worstStep = Math.max(worstStep, Math.hypot(out.x - previous.x, out.y - previous.y, out.z - previous.z));
        worstTurn = Math.max(worstTurn, Math.acos(Math.min(1, out.tx * previous.tx + out.ty * previous.ty + out.tz * previous.tz)));
      }
      previous = { ...out };
    });
    const limit = (follower === cases[0][1] ? 30 : follower === cases[1][1] ? 25 : 40) * dt * 1.001;
    check('continuity', `${label}: never moves more than speed x dt between 120 Hz ticks`, worstStep <= limit, `worst ${worstStep.toFixed(4)} m, limit ${limit.toFixed(4)} m`);
    // A ping-pong reverses at its ends (a half turn in one tick there, by design); elsewhere the
    // tangent turns gently.
    if (follower !== cases[1][1]) check('continuity', `${label}: the tangent turns smoothly`, worstTurn < 0.05, `worst ${(worstTurn * 180 / Math.PI).toFixed(3)} deg per tick`);
  }
}

function testModes() {
  const circlePath = createPath({ points: circlePoints(8, 500), closed: true });
  const loop = createPathFollower({ path: circlePath, speed: 30, mode: 'loop', startTime: 5, startDistance: 250 });
  const out = {};
  let worst = 0;
  for (let time = 5; time < 400; time += 7.3) {
    loop.at(time, out);
    const expected = (250 + 30 * (time - 5)) % circlePath.length;
    worst = Math.max(worst, Math.abs(out.distance - expected));
  }
  check('modes', 'loop: distance = start + speed x t, modulo the length', worst < 1e-6 && loop.duration === Infinity, `worst ${worst}`);
  loop.at(4, out);
  check('modes', 'loop: before its start time the follower is where it would have been', Math.abs(out.distance - (250 - 30 + circlePath.length) % circlePath.length) < 1e-6, String(out.distance));

  const wavyPath = createPath({ points: wavyPoints() });
  const pingpong = createPathFollower({ path: wavyPath, speed: 20, mode: 'pingpong' });
  const period = (wavyPath.length * 2) / 20;
  pingpong.at(period * 0.75, out);
  const backward = { ...out };
  const tangent = wavyPath.tangentAt(backward.distance, { x: 0, y: 0, z: 0 });
  pingpong.at(period, out);
  check('modes', 'pingpong: back at its start after one period', Math.abs(out.distance) < 1e-6 && Math.abs(pingpong.period - period) < 1e-9, `${out.distance} at ${period.toFixed(2)} s`);
  check('modes', 'pingpong: on the way back the tangent points backwards', Math.abs(backward.distance - wavyPath.length * 0.5) < 1e-6 && backward.tx * tangent.x + backward.tz * tangent.z < -0.99, JSON.stringify({ distance: backward.distance, tx: backward.tx, pathTx: tangent.x }));

  const once = createPathFollower({ path: wavyPath, speed: 40, mode: 'once', startTime: 2, startDistance: 100 });
  once.at(1, out);
  const before = { ...out };
  once.at(2 + (wavyPath.length - 100) / 40 - 0.5, out);
  const nearlyDone = { ...out };
  once.at(1000, out);
  check('modes', 'once: waits at its start before startTime, runs, then stops at the end with done set', before.distance === 100 && before.speed === 0 && !nearlyDone.done && Math.abs(nearlyDone.distance - (wavyPath.length - 20)) < 1e-6 && out.done && out.distance === wavyPath.length && out.speed === 0, JSON.stringify({ before: before.distance, nearlyDone: nearlyDone.distance, end: out.distance, done: out.done, duration: once.duration }));
  check('modes', 'once: duration is the travel time from the start distance', Math.abs(once.duration - (wavyPath.length - 100) / 40) < 1e-9, String(once.duration));
}

function testWaits() {
  const straight = createPath({ points: new Float64Array([0, 0, 0, 1000, 0, 0]), smoothing: 'linear' });
  const follower = createPathFollower({ path: straight, speed: 10, mode: 'loop', waits: [{ distance: 300, seconds: 5 }] });
  const out = {};
  follower.at(29.99, out);
  const arriving = { ...out };
  follower.at(32, out);
  const waiting = { ...out };
  follower.at(35.5, out);
  const leaving = { ...out };
  check('waits', 'a stop holds the follower at its distance for its seconds (speed 0)', Math.abs(arriving.distance - 299.9) < 1e-6 && waiting.distance === 300 && waiting.speed === 0 && Math.abs(leaving.distance - 305) < 1e-6 && leaving.speed === 10, JSON.stringify({ arriving: arriving.distance, waiting, leaving: leaving.distance }));
  check('waits', 'the period grows by the waits', Math.abs(follower.period - 105) < 1e-9, String(follower.period));
  follower.at(105 + 32, out);
  check('waits', 'the stop holds again on the next pass', out.distance === 300 && out.speed === 0, JSON.stringify(out));
  const pingpong = createPathFollower({ path: straight, speed: 10, mode: 'pingpong', waits: [{ distance: 300, seconds: 5 }, { distance: 1000, seconds: 2 }] });
  // Out: 0..300 (30 s), wait 5, 300..1000 (70 s), wait 2 at the end, back 1000..300 (70 s), wait 5, back to 0 (30 s).
  pingpong.at(30 + 5 + 70 + 1, out);
  const atEnd = { ...out };
  pingpong.at(30 + 5 + 70 + 2 + 70 + 2, out);
  check('waits', 'ping-pong: stops at the end and at the midway stop on the way back too', atEnd.distance === 1000 && atEnd.speed === 0 && out.distance === 300 && out.speed === 0 && Math.abs(pingpong.period - 212) < 1e-9, JSON.stringify({ atEnd: atEnd.distance, back: out.distance, period: pingpong.period }));
  const fromStop = createPathFollower({ path: straight, speed: 10, mode: 'once', startDistance: 300, waits: [{ distance: 300, seconds: 4 }] });
  fromStop.at(3, out);
  const held = { ...out };
  fromStop.at(5, out);
  check('waits', 'once from a stop: waits there first, then runs', held.distance === 300 && held.speed === 0 && Math.abs(out.distance - 310) < 1e-6 && Math.abs(fromStop.duration - 74) < 1e-9, JSON.stringify({ held: held.distance, then: out.distance, duration: fromStop.duration }));
}

function testCars() {
  const wavyPath = createPath({ points: wavyPoints() });
  const train = createPathFollower({ path: wavyPath, speed: 22, mode: 'once', waits: [{ distance: 900, seconds: 6 }] });
  const head = {};
  const car = {};
  let worst = 0;
  for (let time = 30; time < 80; time += 0.37) {
    train.at(time, head);
    train.carAt(time, 45, car);
    if (head.distance > 45) worst = Math.max(worst, Math.abs(head.distance - car.distance - 45));
  }
  check('cars', 'a trailing car is offset metres behind the head along the track', worst < 1e-6, `worst ${worst}`);
  train.at(900 / 22 + 2, head);
  train.carAt(900 / 22 + 2, 45, car);
  check('cars', 'cars stop with the head at a station', head.speed === 0 && car.speed === 0 && Math.abs(car.distance - 855) < 1e-6, JSON.stringify({ head: head.distance, car: car.distance }));
  const loopPath = createPath({ points: circlePoints(8, 300), closed: true });
  const caravan = createPathFollower({ path: loopPath, speed: 4, startDistance: 10 });
  caravan.carAt(0, 30, car);
  check('cars', 'on a closed loop a car behind the start wraps to the end of the loop', Math.abs(car.distance - (loopPath.length - 20)) < 1e-6, String(car.distance));
}

function testGround() {
  const ground = (x, z) => 0.1 * x + 3 * Math.sin(z / 50);
  const straight = createPath({ points: new Float64Array([0, 0, 0, 0, 0, -1000]), smoothing: 'linear' });
  const climbing = createPath({ points: new Float64Array([0, 0, 0, 1000, 0, 0]), smoothing: 'linear' });
  const walker = createPathFollower({ path: straight, speed: 2, mode: 'once', ground, groundOffset: 1.2 });
  const climber = createPathFollower({ path: climbing, speed: 2, mode: 'once', ground });
  const out = {};
  walker.at(100, out);
  const onGround = Math.abs(out.y - (ground(out.x, out.z) + 1.2)) < 1e-9;
  climber.at(100, out);
  check('ground', 'a ground follower stands on the ground plus its offset and pitches with the slope', onGround && Math.abs(out.ty - 0.1 / Math.sqrt(1.01)) < 1e-6 && Math.abs(out.heading - 90) < 1e-6, JSON.stringify(out));
}

function testDeterminism() {
  const circlePath = createPath({ points: circlePoints(8, 500), closed: true });
  const options = { path: circlePath, speed: 17, mode: 'pingpong', startTime: 12.5, startDistance: 333, waits: [{ distance: 1200, seconds: 3.25 }] };
  const first = createPathFollower(options);
  const second = createPathFollower(options);
  const times = [];
  for (let index = 0; index < 500; index++) times.push(12.5 + index * 1.618);
  const forward = times.map((time) => JSON.stringify(first.at(time, {})));
  const shuffled = [...times].reverse().map((time) => JSON.stringify(second.at(time, {}))).reverse();
  check('determinism', 'same inputs, same answers, whatever order the times are asked in', forward.every((line, index) => line === shuffled[index]), `${forward.length} times`);
}

// ---- groundpath ----------------------------------------------------------------------------------------
/** A world: flat plain at 20 m, a ridge (300 m high, steep flanks) across z = -1500 with one pass, a lake. */
function createRidgeWorld() {
  const groundHeight = (x, z) => {
    const ridgeDistance = Math.abs(z + 1500);
    const flank = Math.max(0, 1 - ridgeDistance / 140);
    const passOpen = Math.min(1, Math.max(0, (220 - Math.abs(x - 900)) / 60));
    const ridge = 300 * flank * flank * (1 - passOpen * 0.97);
    const lake = Math.max(0, 1 - Math.hypot(x - 150, z + 600) / 260) * 40;
    return 20 + ridge - lake;
  };
  return { groundHeight, heightAt: groundHeight };
}

function testGroundPath() {
  const world = createRidgeWorld();
  const waterQuery = { isWater: (x, z) => world.groundHeight(x, z) < 0 };
  const options = { from: { x: 0, z: 0 }, to: { x: 0, z: -3000 }, maxSlope: 0.35, seed: 'caravan', spacing: 40 };
  const route = buildGroundPath(world, waterQuery, options);
  check('groundpath', 'the route arrives across the ridge', route.reached && route.points.length >= 6, `${route.points.length / 3} points, ${route.length.toFixed(0)} m`);
  const path = createPath({ points: route.points, smoothing: 'linear' });
  let worstSlope = 0;
  let wet = 0;
  let throughPass = false;
  const here = { x: 0, y: 0, z: 0 };
  const ahead = { x: 0, y: 0, z: 0 };
  for (let along = 0; along <= path.length; along += 2) {
    path.sampleAt(along, here);
    if (along + SLOPE_RUN <= path.length) {
      path.sampleAt(along + SLOPE_RUN, ahead);
      const run = Math.hypot(ahead.x - here.x, ahead.z - here.z);
      if (run > 1) worstSlope = Math.max(worstSlope, Math.abs(world.groundHeight(ahead.x, ahead.z) - world.groundHeight(here.x, here.z)) / run);
    }
    if (waterQuery.isWater(here.x, here.z)) wet++;
    if (Math.abs(here.z + 1500) < 20 && Math.abs(here.x - 900) < 230) throughPass = true;
  }
  check('groundpath', 'never on water', wet === 0, `${wet} wet samples`);
  check('groundpath', 'never climbs a slope over the limit (rise over 6 m)', worstSlope <= options.maxSlope * 1.02, `worst ${worstSlope.toFixed(3)}, limit ${options.maxSlope}`);
  check('groundpath', 'the route uses the pass', throughPass);
  const again = buildGroundPath(world, waterQuery, options);
  check('groundpath', 'the same seed gives the same route', again.points.length === route.points.length && again.points.every((value, index) => value === route.points[index]));
  const blocked = buildGroundPath(world, waterQuery, { ...options, maxSlope: 0.02, to: { x: 0, z: -2500 } });
  check('groundpath', 'with no allowed route, reached is false and the route ends short', !blocked.reached && blocked.points.length >= 3, `${blocked.points.length / 3} points`);
}

// ---- allocation -----------------------------------------------------------------------------------------
async function testAllocation() {
  const path = createPath({ points: circlePoints(16, 900), closed: true });
  const follower = createPathFollower({ path, speed: 25, mode: 'pingpong', waits: [{ distance: 1000, seconds: 3 }], ground: (x, z) => 0.01 * x + 0.02 * z, groundOffset: 2 });
  const out = { x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, heading: 0, distance: 0, speed: 0, done: false };
  // The clock lives in a typed array: a closure variable holding a double would box on every write.
  const clock = new Float64Array(1);
  const frame = () => {
    clock[0] += 1 / 120;
    follower.at(clock[0], out);
    follower.carAt(clock[0], 30, out);
  };
  for (let index = 0; index < 200000; index++) frame();
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
  check('allocation', `no garbage collection during ${frames} at() + carAt() pairs`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per call pair', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(4)} B per pair`);
}

await testAllocation();
testArcLength();
testContinuity();
testModes();
testWaits();
testCars();
testGround();
testDeterminism();
testGroundPath();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(12)} ${result.name}${result.detail && (VERBOSE || !result.pass || result.detail) ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
