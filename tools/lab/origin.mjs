// Render origin lab: runs src/core/origin.js headless (node) against a real three.js scene and the
// typed event bus, and checks the floating origin's contract (Phase 3 contract a.2, a.8).
//
// Tests:
//   quantization   every rebase lands on the 4096 m lattice on all three axes (negative and halfway
//                  values included), and offset is the nearest lattice point to the focus
//   threshold      no rebase at 5000 m or less from the origin (3D distance), a rebase just beyond;
//                  after any rebase the focus is inside the threshold, so a second update never
//                  rebases again (no thrash) over a 2000-point random flight
//   order          a rebase moves offset, then scene.position (= -offset, matrixWorld refreshed), then
//                  uniforms.renderOrigin, then the onRebase listeners in registration order with delta,
//                  then 'originRebased' with a valid payload; unsubscribe stops a listener
//   frames         an object's matrixWorld is world - offset after a rebase (matrixAutoUpdate false
//                  included); the camera's render position minus the craft's render position is the
//                  same before and after (exact in float64)
//   roundTrip      toRender then toWorld returns the exact input for points within 8 km of a focus
//                  anywhere out to 10 000 km (every point farther from the offset than from 0 on no
//                  axis; the rest, beside the world origin, within 10^-12 m), within nanometres for
//                  any point in the world, and both accept out === input
//   rebaseTo       forces a rebase inside the threshold (quantized), is a no-op on the same lattice
//                  point and throws on a non-finite point; update ignores a non-finite focus
//   allocation     100 000 update() calls (the focus wandering inside the threshold) and 1000 rebases
//                  with a listener allocate nothing: no garbage collection, young generation flat
//
// Usage: node --expose-gc tools/lab/origin.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { ORIGIN_QUANTUM, ORIGIN_REBASE_DISTANCE, createRenderOrigin, quantizeOrigin } from '../../src/core/origin.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass, detail });
  if (VERBOSE) process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}${detail ? `: ${detail}` : ''}\n`);
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(' '));
};

/** mulberry32: a seeded stream, so every run of the lab checks the same points. */
function createRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh origin with a scene, the shared uniform and a validating typed bus. */
function createLab() {
  const scene = new THREE.Scene();
  const uniforms = { renderOrigin: { value: new THREE.Vector3() } };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const origin = createRenderOrigin({ THREE, scene, uniforms, bus });
  return { scene, uniforms, bus, origin };
}

const onLattice = (vector) => [vector.x, vector.y, vector.z].every((value) => Number.isInteger(value / ORIGIN_QUANTUM));

// ---- quantization -------------------------------------------------------------------------------------
function testQuantization() {
  const cases = [
    [0, 0], [2047, 0], [2048, 4096], [-2048, -0], [-2049, -4096], [6000, 4096], [6145, 8192],
    [-123456.7, -122880], [1e6, 999424], [100000, 98304], [102401, 102400],
  ];
  const wrong = cases.filter(([value, expected]) => quantizeOrigin(value) !== expected && !(expected === 0 && quantizeOrigin(value) === 0));
  check('quantization', 'quantizeOrigin rounds to the nearest multiple of 4096 m', wrong.length === 0, wrong.length ? JSON.stringify(wrong) : `${cases.length} values`);
  const { origin } = createLab();
  const random = createRandom(31);
  let offLattice = 0;
  let notNearest = 0;
  for (let index = 0; index < 500; index++) {
    const focus = new THREE.Vector3((random() - 0.5) * 4e6, random() * 120000 - 2000, (random() - 0.5) * 4e6);
    origin.update(focus);
    if (!onLattice(origin.offset)) offLattice++;
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(focus[axis] - origin.offset[axis]) > ORIGIN_QUANTUM / 2 + 1e-9) notNearest++;
    }
  }
  check('quantization', 'every rebase lands on the lattice on all three axes', offLattice === 0, `${offLattice} off-lattice offsets in 500 jumps`);
  check('quantization', 'the offset is the lattice point nearest the focus', notNearest === 0, `${notNearest} axes farther than 2048 m`);
}

// ---- threshold ----------------------------------------------------------------------------------------
function testThreshold() {
  const { origin } = createLab();
  const direction = new THREE.Vector3(3, 1, -2).normalize();
  const inside = direction.clone().multiplyScalar(ORIGIN_REBASE_DISTANCE);
  const beyond = direction.clone().multiplyScalar(ORIGIN_REBASE_DISTANCE + 0.01);
  const insideRebased = origin.update(inside);
  check('threshold', 'no rebase at exactly 5000 m (3D)', insideRebased === false && origin.version === 0, `version ${origin.version}`);
  const beyondRebased = origin.update(beyond);
  check('threshold', 'a rebase just beyond 5000 m (3D)', beyondRebased === true && origin.version === 1,
    `offset ${origin.offset.x}, ${origin.offset.y}, ${origin.offset.z}`);
  check('threshold', 'the 3D distance counts (a 3600 m climb with a 3600 m run rebases)', (() => {
    const lab = createLab();
    return lab.origin.update({ x: 3600, y: 3600, z: 0 }) === true;
  })());

  const flight = createLab().origin;
  const random = createRandom(7);
  const position = new THREE.Vector3();
  let thrash = 0;
  let farthest = 0;
  let rebases = 0;
  for (let index = 0; index < 2000; index++) {
    position.x += (random() - 0.3) * 1800;
    position.y = Math.max(0, position.y + (random() - 0.45) * 900);
    position.z += (random() - 0.6) * 1800;
    if (flight.update(position)) rebases++;
    farthest = Math.max(farthest, position.distanceTo(flight.offset));
    if (flight.update(position)) thrash++;
  }
  check('threshold', 'after a rebase the focus is within half the cube diagonal (3547 m)', farthest <= ORIGIN_REBASE_DISTANCE && rebases > 50,
    `${rebases} rebases over 2000 steps, farthest ${farthest.toFixed(0)} m after an update`);
  check('threshold', 'a second update at the same focus never rebases again', thrash === 0, `${thrash} thrashes`);
}

// ---- order --------------------------------------------------------------------------------------------
function testOrder() {
  const { scene, uniforms, bus, origin } = createLab();
  const log = [];
  const child = new THREE.Object3D();
  child.position.set(9000, 120, -3000);
  scene.add(child);
  scene.updateMatrixWorld();
  const unsubscribeA = origin.onRebase((delta, source) => {
    log.push({
      who: 'A',
      delta: delta.clone(),
      offset: source.offset.clone(),
      scene: scene.position.clone(),
      uniform: uniforms.renderOrigin.value.clone(),
      childRender: new THREE.Vector3().setFromMatrixPosition(child.matrixWorld),
    });
  });
  origin.onRebase(() => log.push({ who: 'B' }));
  bus.onTyped('originRebased', (payload) => {
    log.push({ who: 'event', offset: { ...payload.offset }, previous: { ...payload.previous }, delta: { ...payload.delta }, version: payload.version });
  });
  origin.update({ x: 9000, y: 120, z: -3000 });
  const first = log[0];
  const expectedOffset = new THREE.Vector3(8192, 0, -4096);
  check('order', 'listeners then the event, in registration order', log.map((entry) => entry.who).join(',') === 'A,B,event', log.map((entry) => entry.who).join(','));
  check('order', 'offset, scene.position and the uniform are set before the listeners',
    first.offset.equals(expectedOffset) && first.scene.equals(expectedOffset.clone().negate()) && first.uniform.equals(expectedOffset));
  check('order', 'matrixWorld is refreshed before the listeners (render = world - offset)',
    first.childRender.equals(new THREE.Vector3(9000 - 8192, 120, -3000 + 4096)), `${first.childRender.x}, ${first.childRender.y}, ${first.childRender.z}`);
  check('order', 'the listener delta is the origin move', first.delta.equals(expectedOffset));
  const event = log[2];
  check('order', "'originRebased' carries offset, previous, delta and version",
    event.offset.x === 8192 && event.offset.z === -4096 && event.previous.x === 0 && event.delta.x === 8192 && event.version === 1, JSON.stringify(event));
  unsubscribeA();
  log.length = 0;
  origin.update({ x: 30000, y: 0, z: 0 });
  check('order', 'an unsubscribed listener no longer runs', log.map((entry) => entry.who).join(',') === 'B,event' && origin.listenerCount === 1, log.map((entry) => entry.who).join(','));
  const stats = origin.getStats();
  check('order', 'getStats reports offset, version, rebases and the frame', stats.version === 2 && stats.rebases === 2 && stats.offset.x === 28672 && stats.lastRebaseFrame === 2, JSON.stringify(stats));
}

// ---- frames -------------------------------------------------------------------------------------------
function testFrames() {
  const { scene, origin } = createLab();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 9000);
  scene.add(camera);
  const frozen = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  frozen.matrixAutoUpdate = false;
  frozen.position.set(80000.25, 512.5, -44000.75);
  frozen.updateMatrix();
  scene.add(frozen);
  const craft = new THREE.Vector3(79990.123456, 500.654321, -43980.987654);
  camera.position.set(craft.x - 12.5, craft.y + 3.25, craft.z + 20.75);
  camera.lookAt(craft);
  scene.updateMatrixWorld();
  const renderCraft = new THREE.Vector3();
  const cameraRender = new THREE.Vector3();
  const relative = (target) => {
    origin.toRender(craft, renderCraft);
    cameraRender.setFromMatrixPosition(camera.matrixWorld);
    return target.subVectors(renderCraft, cameraRender);
  };
  const before = relative(new THREE.Vector3());
  origin.update(craft);
  scene.updateMatrixWorld();
  const after = relative(new THREE.Vector3());
  check('frames', 'the camera-relative craft position is continuous across a rebase', before.distanceTo(after) < 1e-9, `${before.distanceTo(after).toExponential(2)} m`);
  const frozenRender = new THREE.Vector3().setFromMatrixPosition(frozen.matrixWorld);
  const expected = origin.toRender(frozen.position, new THREE.Vector3());
  check('frames', 'a matrixAutoUpdate = false object follows the rebase', frozenRender.distanceTo(expected) < 1e-9 && origin.offset.x === 81920,
    `render ${frozenRender.x.toFixed(3)}, ${frozenRender.y.toFixed(3)}, ${frozenRender.z.toFixed(3)}`);
  const cameraWorld = camera.position.clone();
  check('frames', 'camera.position stays world', cameraWorld.equals(new THREE.Vector3(craft.x - 12.5, craft.y + 3.25, craft.z + 20.75)));
  check('frames', 'the camera stays near the render origin', cameraRender.length() < ORIGIN_REBASE_DISTANCE, `${cameraRender.length().toFixed(0)} m`);
}

// ---- roundTrip ----------------------------------------------------------------------------------------
/** A full 53-bit random double in [0, 1) (two 32-bit draws), so no point is accidentally coarse. */
function fullRandom(random) {
  return (Math.floor(random() * 2 ** 21) * 2 ** 32 + Math.floor(random() * 2 ** 32)) / 2 ** 53;
}

function testRoundTrip() {
  const { origin } = createLab();
  const random = createRandom(99);
  const focus = new THREE.Vector3();
  const world = new THREE.Vector3();
  const render = new THREE.Vector3();
  const back = new THREE.Vector3();
  let mismatches = 0;
  let exactPoints = 0;
  let worstNear = 0;
  let worstFar = 0;
  for (let index = 0; index < 20000; index++) {
    // A focus anywhere out to 10 000 km and 200 km up, and points within 8 km of it: everything the
    // game converts lives near the camera.
    if (index % 100 === 0) {
      focus.set((fullRandom(random) - 0.5) * 2e7, fullRandom(random) * 2e5, (fullRandom(random) - 0.5) * 2e7);
      origin.update(focus);
    }
    world.set(focus.x + (fullRandom(random) - 0.5) * 16000, focus.y + (fullRandom(random) - 0.5) * 16000, focus.z + (fullRandom(random) - 0.5) * 16000);
    origin.toRender(world, render);
    origin.toWorld(render, back);
    // Exact by construction whenever |p - offset| <= |p| on every axis (the lattice offset's bits all
    // sit above p's last bit); next to the world origin a point can sit closer to 0 than to the
    // offset, and the subtraction may round by half an ulp of the render value (10^-13 m).
    const exactCase = ['x', 'y', 'z'].every((axis) => Math.abs(render[axis]) <= Math.abs(world[axis]));
    if (exactCase) exactPoints++;
    if (exactCase && !back.equals(world)) mismatches++;
    worstNear = Math.max(worstNear, back.distanceTo(world));
    // A point anywhere in the world (far from the origin): the round trip is within one ulp.
    world.set((fullRandom(random) - 0.5) * 2e7, fullRandom(random) * 2e5, (fullRandom(random) - 0.5) * 2e7);
    origin.toWorld(origin.toRender(world, render), back);
    worstFar = Math.max(worstFar, back.distanceTo(world));
  }
  check('roundTrip', 'toWorld(toRender(p)) === p exactly near the focus, out to 10 000 km', mismatches === 0 && exactPoints > 19000,
    `${mismatches} of ${exactPoints} points differ; worst of all 20000 near points ${worstNear.toExponential(2)} m`);
  check('roundTrip', 'anywhere in the world the round trip is within a few nanometres', worstFar < 1e-8, `worst ${worstFar.toExponential(2)} m`);
  origin.rebaseTo({ x: 122880, y: 4096, z: -98304 });
  const point = new THREE.Vector3(123456.789, 4321.5, -98765.4321);
  const copy = point.clone();
  origin.toWorld(origin.toRender(point, point), point);
  check('roundTrip', 'in place (out === input) works both ways', point.equals(copy));
}

// ---- rebaseTo -----------------------------------------------------------------------------------------
function testRebaseTo() {
  const { origin } = createLab();
  const moved = origin.rebaseTo({ x: 3000, y: 2100, z: -2100 });
  check('rebaseTo', 'forces a quantized rebase inside the threshold', moved === true && origin.offset.equals(new THREE.Vector3(4096, 4096, -4096)));
  const again = origin.rebaseTo({ x: 4500, y: 4000, z: -5000 });
  check('rebaseTo', 'the same lattice point is a no-op', again === false && origin.version === 1);
  let threw = false;
  try {
    origin.rebaseTo({ x: Number.NaN, y: 0, z: 0 });
  } catch (error) {
    threw = /finite/.test(error.message);
  }
  check('rebaseTo', 'a non-finite point throws', threw && origin.version === 1);
  const ignored = origin.update({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 });
  check('rebaseTo', 'update ignores a non-finite focus (the safety net restores the pose)', ignored === false && origin.version === 1);
}

// ---- allocation ---------------------------------------------------------------------------------------
async function testAllocation() {
  const { origin } = createLab();
  const focus = new THREE.Vector3();
  const wander = (index) => {
    const angle = index * 0.001;
    focus.set(Math.cos(angle) * 3000, 800 + Math.sin(angle * 3) * 600, Math.sin(angle) * 3000);
    origin.update(focus);
  };
  // Rebases: the focus hops 8 km east and back, with a listener and the scene refresh. The bus is
  // left out (EventBus.emit copies its listener set), so this measures the origin itself.
  const bare = createRenderOrigin({ THREE, scene: new THREE.Scene(), uniforms: { renderOrigin: { value: new THREE.Vector3() } } });
  let listenerCalls = 0;
  bare.onRebase((delta) => {
    listenerCalls += delta.x === 0 ? 0 : 1;
  });
  const hop = (index) => {
    focus.set(index % 2 === 0 ? 8192 : 0, 0, 0);
    bare.update(focus);
  };
  for (let index = 0; index < 150000; index++) wander(index);
  for (let index = 0; index < 4000; index++) hop(index);
  // Reading the heap statistics allocates their own result: measured once and subtracted.
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const probeA = youngUsed();
  const probeB = youngUsed();
  const probeCost = probeB - probeA;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const calls = 100000;
  const rebaseCount = 1000;
  const before = youngUsed();
  for (let index = 0; index < calls; index++) wander(index);
  const middle = youngUsed();
  for (let index = 0; index < rebaseCount; index++) hop(index);
  const after = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const updateBytes = Math.max(0, middle - before - probeCost);
  const rebaseBytes = Math.max(0, after - middle - probeCost);
  const started = process.hrtime.bigint();
  for (let index = 0; index < calls; index++) wander(index);
  const nanoseconds = Number(process.hrtime.bigint() - started) / calls;
  const gcAvailable = typeof globalThis.gc === 'function';
  check('allocation', `no garbage collection during ${calls} update() calls and ${rebaseCount} rebases`, gcAvailable && collections === 0,
    `${collections} collections${gcAvailable ? '' : ' (run with --expose-gc)'}`);
  check('allocation', `update() allocates nothing over ${calls} calls (young generation flat)`, updateBytes < 256,
    `${updateBytes} B in all, after the ${probeCost} B the heap probe itself costs`);
  check('allocation', `${rebaseCount} rebases with a listener allocate nothing (without the bus)`, rebaseBytes < 256, `${rebaseBytes} B in all`);
  check('allocation', 'update() costs under 1 us', nanoseconds < 1000, `${nanoseconds.toFixed(1)} ns per call`);
  check('allocation', 'the listener ran on every rebase', bare.getStats().rebases === 5000 && listenerCalls === 5000, `${bare.getStats().rebases} rebases`);
}

testQuantization();
testThreshold();
testOrder();
testFrames();
testRoundTrip();
testRebaseTo();
await testAllocation();
check('console', 'no console errors (valid payloads, no listener failures)', consoleErrors.length === 0, consoleErrors.join(' | '));

console.error = originalError;
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(12)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
