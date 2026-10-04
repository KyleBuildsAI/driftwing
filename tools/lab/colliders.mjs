// The collider service headless (Phase 3 contract b.9): src/world/colliders.js and its narrow phase
// (colliderMath.js), plus the mesh colliders of src/world/colliderMesh.js (three-mesh-bvh in node).
//
//   shapes       every shape against sweepSphere, overlapSphere and raycast with analytic answers:
//                the time of first contact, the normal and the contact point
//   tunnelling   spheres flown at 10, 300 and 2000 m/s in 120 Hz ticks at every shape, at normal and
//                grazing incidence: every path that crosses a solid stops at its surface, never inside
//                and never through, thin 5 cm strings included
//   rules        the earliest hit wins, ties go to the lower id, sensors report and never block,
//                landable tops are ignored by gear probes only
//   surfaces     landable tops published to the ground surfaces (box, cylinder, hull, heightfield,
//                surfaceHeightAt), moving with their collider and removed with it
//   providers    procedural colliders on demand (compiled once per spec), perch points and providers
//   service      validation, update and refiling, removeOwner, insideSolid, liftClear, boundsOccupied
//   determinism  a shuffled insertion order gives bit-identical results over a sweep battery
//   cost         a sweep of 30 probes against 2000 colliders under 0.1 ms
//   allocation   100 000 sweeps, overlaps, raycasts and updates allocate nothing
//
// Usage: node --expose-gc tools/lab/colliders.mjs [--verbose]
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import { createColliderWorld, createProbeSet, LANDABLE_NORMAL_Y } from '../../src/world/colliders.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createMeshCollider } from '../../src/world/colliderMesh.js';
import { RIM_OVERREACH } from '../../src/world/colliderMath.js';

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

const TICK = 1 / 120;
const near = (value, expected, tolerance = 1e-6) => Math.abs(value - expected) <= tolerance;
const fmt = (value) => (Number.isFinite(value) ? value.toFixed(4) : String(value));

function createOut() {
  return { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null, distance: 0 };
}

function mulberry32(seed) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quaternionY(angle) {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}

function octahedron(center, size) {
  const points = [];
  for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) points.push(center.x + x * size, center.y + y * size, center.z + z * size);
  return Float64Array.from(points);
}

function flatField(id, x0, z0, cols, rows, cell, height, bottom, extra = {}) {
  return { id, owner: 'lab', type: 'heightfield', x0, z0, cell, cols, rows, heights: new Float32Array(cols * rows).fill(height), bottom, ...extra };
}

/** A closed box mesh (BoxGeometry) as a mesh collider at a world position. */
function boxMesh(size, position) {
  const geometry = new THREE.BoxGeometry(size, size, size);
  const matrix = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, position.x, position.y, position.z, 1]);
  return { geometry, collider: createMeshCollider(geometry, matrix) };
}

// ---- shapes ---------------------------------------------------------------------------------------------
function testShapes() {
  const world = createColliderWorld({});
  const out = createOut();
  const sweep = (from, to, radius, filter = null) => (world.sweepSphere(from, to, radius, filter, out) ? out : null);

  world.add({ id: 'box', owner: 'lab', type: 'box', center: { x: 0, y: 10, z: 0 }, halfExtents: { x: 5, y: 5, z: 5 } });
  let result = sweep({ x: -20, y: 10, z: 0 }, { x: 20, y: 10, z: 0 }, 1);
  check('shapes', 'box: face hit time, normal and contact point', result && near(result.t, 0.35) && near(result.normal.x, -1) && near(result.point.x, -5) && result.id === 'box', result ? `t ${fmt(result.t)} n.x ${fmt(result.normal.x)} p.x ${fmt(result.point.x)}` : 'miss');
  result = sweep({ x: -20, y: 16.5, z: 0 }, { x: 20, y: 16.5, z: 0 }, 1);
  check('shapes', 'box: a path 0.5 m above the swept top misses', result === null);
  result = sweep({ x: -20, y: 15.5, z: 5.5 }, { x: 20, y: 15.5, z: 5.5 }, 1);
  // Parallel to the top edge at y = 15, z = 5 and 0.707 m from its line: first contact is the corner.
  const cornerReach = Math.sqrt(1 - 0.5);
  check('shapes', 'box: the corner rounds the swept volume', result && near(result.t, (20 - 5 - cornerReach) / 40) && near(result.normal.x, -cornerReach) && near(result.normal.y, 0.5) && near(result.normal.z, 0.5), result ? `t ${fmt(result.t)} n (${fmt(result.normal.x)}, ${fmt(result.normal.y)}, ${fmt(result.normal.z)})` : 'miss');
  world.remove('box');

  world.add({ id: 'turned', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 5, y: 5, z: 5 }, quaternion: quaternionY(Math.PI / 4) });
  result = sweep({ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 1);
  const cornerX = -5 * Math.SQRT2 - 1;
  check('shapes', 'turned box: the vertical edge at 45 degrees', result && near(result.point.x + result.normal.x, cornerX, 1e-6) && near(result.normal.x, -1, 1e-6), result ? `centre x at contact ${fmt(-20 + 40 * result.t)} (expected ${fmt(cornerX)})` : 'miss');
  world.remove('turned');

  world.add({ id: 'cylinder', owner: 'lab', type: 'cylinder', center: { x: 0, y: 0, z: 0 }, radius: 3, halfHeight: 10 });
  result = sweep({ x: -20, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }, 1);
  check('shapes', 'cylinder: side', result && near(result.t, 0.4) && near(result.normal.x, -1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: 1, y: 30, z: 0 }, { x: 1, y: -30, z: 0 }, 1);
  check('shapes', 'cylinder: cap', result && near(result.t, 19 / 60) && near(result.normal.y, 1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: -20, y: 10.5, z: 0 }, { x: 20, y: 10.5, z: 0 }, 1);
  const rimX = -3 - Math.sqrt(1 - 0.25);
  const rimCentre = result ? -20 + 40 * result.t : NaN;
  check('shapes', 'cylinder: rim within RIM_OVERREACH (0.86 %) of R, never late', result && rimCentre <= rimX + 1e-9 && rimX - rimCentre <= RIM_OVERREACH * 3 + 1e-9, `centre x ${fmt(rimCentre)} vs exact ${fmt(rimX)}`);
  world.remove('cylinder');

  world.add({ id: 'disc', owner: 'lab', type: 'cylinder', center: { x: 0, y: 50, z: 0 }, radius: 40, halfHeight: 0.6, quaternion: { x: Math.sin(Math.PI / 4), y: 0, z: 0, w: Math.cos(Math.PI / 4) } });
  result = sweep({ x: 10, y: 60, z: -30 }, { x: 10, y: 60, z: 30 }, 0.35);
  check('shapes', 'turned disc (a rotor): face-on hit', result && near(result.t, (30 - 0.95) / 60) && near(result.normal.z, -1), result ? `t ${fmt(result.t)} n.z ${fmt(result.normal.z)}` : 'miss');
  world.remove('disc');

  world.add({ id: 'capsule', owner: 'lab', type: 'capsule', a: { x: 0, y: 0, z: -10 }, b: { x: 0, y: 0, z: 10 }, radius: 0.5 });
  result = sweep({ x: -10, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.35);
  check('shapes', 'capsule: side', result && near(result.t, 9.15 / 20) && near(result.normal.x, -1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: 0, y: 0, z: 30 }, { x: 0, y: 0, z: 10 }, 0.35);
  check('shapes', 'capsule: end cap', result && near(result.t, (30 - 10.85) / 20) && near(result.normal.z, 1), result ? `t ${fmt(result.t)}` : 'miss');
  world.remove('capsule');

  world.add({ id: 'hull', owner: 'lab', type: 'hull', points: octahedron({ x: 100, y: 0, z: 0 }, 5) });
  result = sweep({ x: 80, y: 0, z: 0 }, { x: 120, y: 0, z: 0 }, 1);
  check('shapes', 'hull: vertex first', result && near(result.t, 0.35) && near(result.normal.x, -1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: 100 + 10, y: 10, z: 10 }, { x: 100 - 10, y: -10, z: -10 }, 0.5);
  const faceDistance = 5 / Math.sqrt(3);
  check('shapes', 'hull: face along its normal', result && near(result.normal.x, 1 / Math.sqrt(3), 1e-6) && near(Math.hypot(10, 10, 10) * (1 - 2 * result.t), faceDistance + 0.5, 1e-6), result ? `t ${fmt(result.t)}` : 'miss');
  world.remove('hull');

  world.add(flatField('field', 0, 0, 11, 11, 2, 10, 0));
  result = sweep({ x: 10, y: 30, z: 10 }, { x: 10, y: -10, z: 10 }, 1);
  check('shapes', 'heightfield: top', result && near(result.t, 19 / 40) && near(result.normal.y, 1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: -10, y: 5, z: 10 }, { x: 30, y: 5, z: 10 }, 1);
  check('shapes', 'heightfield: side wall', result && near(result.t, 9 / 40) && near(result.normal.x, -1), result ? `t ${fmt(result.t)}` : 'miss');
  result = sweep({ x: 10, y: -20, z: 10 }, { x: 10, y: 20, z: 10 }, 1);
  check('shapes', 'heightfield: bottom', result && near(result.t, 19 / 40) && near(result.normal.y, -1), result ? `t ${fmt(result.t)}` : 'miss');
  world.remove('field');

  const holed = flatField('holed', 0, 0, 11, 11, 2, 10, 0);
  holed.heights[5 * 11 + 5] = NaN;
  world.add(holed);
  result = sweep({ x: 8.1, y: 30, z: 10 }, { x: 8.1, y: -10, z: 10 }, 0.2);
  check('shapes', 'heightfield: a NaN height is a hole (the walls around it are solid)', result && result.normal.y < 0.99, result ? `t ${fmt(result.t)} n (${fmt(result.normal.x)}, ${fmt(result.normal.y)}, ${fmt(result.normal.z)})` : 'miss');
  world.remove('holed');

  const mesh = boxMesh(10, { x: 0, y: 200, z: 0 });
  world.add({ id: 'mesh', owner: 'lab', type: 'mesh', mesh: mesh.collider });
  result = sweep({ x: -20, y: 200, z: 0 }, { x: 20, y: 200, z: 0 }, 1);
  check('shapes', 'mesh (three-mesh-bvh): face hit', result && near(result.t, 0.35, 1e-6) && near(result.normal.x, -1, 1e-6), result ? `t ${fmt(result.t)}` : 'miss');
  check('shapes', 'mesh: depth inside and outside', mesh.collider.depth(0, 200, 0) > 4.9 && mesh.collider.depth(0, 200, 8) < 0, `${fmt(mesh.collider.depth(0, 200, 0))} / ${fmt(mesh.collider.depth(0, 200, 8))}`);
  world.remove('mesh');
  mesh.collider.dispose();
  mesh.geometry.dispose();

  // Raycast and overlap.
  world.add({ id: 'target', owner: 'lab', type: 'box', center: { x: 0, y: 10, z: 0 }, halfExtents: { x: 5, y: 5, z: 5 } });
  const ray = createOut();
  const rayHit = world.raycast({ x: -20, y: 10, z: 0 }, { x: 2, y: 0, z: 0 }, 40, null, ray);
  check('shapes', 'raycast: distance to the face', rayHit && near(ray.distance, 15) && ray.id === 'target', rayHit ? `${fmt(ray.distance)} m` : 'miss');
  check('shapes', 'raycast: stops at maxDistance', !world.raycast({ x: -20, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 14, null, ray));
  const overlapped = [];
  world.overlapSphere({ x: 0, y: 10, z: 6 }, 1.5, (record) => overlapped.push(record.id));
  const missed = [];
  world.overlapSphere({ x: 0, y: 10, z: 7 }, 1.5, (record) => missed.push(record.id));
  check('shapes', 'overlapSphere: touching and clear', overlapped.join() === 'target' && missed.length === 0, `${overlapped.join()} / ${missed.join()}`);
  world.dispose();
}

// ---- tunnelling ------------------------------------------------------------------------------------------
/**
 * Flies a sphere in 120 Hz ticks from start along velocity until it hits or has flown `seconds`.
 * Returns { hit, endInside, crossedWithoutHit } like the flight controller would see it.
 */
function flyTicks(world, start, velocity, radius, seconds, out) {
  const position = { ...start };
  const next = { x: 0, y: 0, z: 0 };
  for (let tick = 0; tick < seconds / TICK; tick++) {
    next.x = position.x + velocity.x * TICK;
    next.y = position.y + velocity.y * TICK;
    next.z = position.z + velocity.z * TICK;
    if (world.sweepSphere(position, next, radius, null, out)) {
      // The controller puts the probe at the hit point plus 0.05 m along the normal.
      const stopX = position.x + (next.x - position.x) * out.t + out.normal.x * 0.05;
      const stopY = position.y + (next.y - position.y) * out.t + out.normal.y * 0.05;
      const stopZ = position.z + (next.z - position.z) * out.t + out.normal.z * 0.05;
      return { hit: out.id, endInside: world.insideSolid(stopX, stopY, stopZ) !== null, clearance: clearanceOf(world, stopX, stopY, stopZ, radius) };
    }
    position.x = next.x;
    position.y = next.y;
    position.z = next.z;
    if (world.insideSolid(position.x, position.y, position.z) !== null) return { hit: null, endInside: true, clearance: -1 };
  }
  return { hit: null, endInside: false, clearance: Infinity };
}

/** Whether a sphere at the point touches anything (it should not after a hit's 0.05 m back-off). */
function clearanceOf(world, x, y, z, radius) {
  let touching = 0;
  world.overlapSphere({ x, y, z }, radius * 0.99, () => { touching++; });
  return touching;
}

function testTunnelling() {
  const world = createColliderWorld({});
  const out = createOut();
  const targets = [
    { id: 'box', spec: { type: 'box', center: { x: 0, y: 100, z: 0 }, halfExtents: { x: 0.3, y: 20, z: 20 } } },
    { id: 'cylinder', spec: { type: 'cylinder', center: { x: 0, y: 100, z: 0 }, radius: 1.6, halfHeight: 40 } },
    { id: 'disc', spec: { type: 'cylinder', center: { x: 0, y: 100, z: 0 }, radius: 30, halfHeight: 0.2, quaternion: { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) } } },
    { id: 'string', spec: { type: 'capsule', a: { x: 0, y: 60, z: -2 }, b: { x: 0, y: 140, z: 2 }, radius: 0.05 } },
    { id: 'hull', spec: { type: 'hull', points: octahedron({ x: 0, y: 100, z: 0 }, 4) } },
    { id: 'field', spec: { type: 'heightfield', x0: -1, z0: -15, cell: 1, cols: 3, rows: 31, heights: new Float32Array(93).fill(100.5), bottom: 99.5 } },
  ];
  const lines = [];
  let allStopped = true;
  for (const target of targets) {
    world.add({ id: target.id, owner: 'lab', ...target.spec });
    for (const speed of [10, 300, 2000]) {
      for (const incidence of ['normal', 'grazing']) {
        const angle = incidence === 'normal' ? 0 : (80 * Math.PI) / 180;
        // From 3 s of flight away (at least 60 m), aimed at the target's middle, rising slightly so
        // the field is approached across its thin top edge as well.
        const reach = Math.max(60, speed * 0.5);
        const direction = { x: Math.cos(angle), y: target.id === 'field' ? -0.002 : 0.004, z: Math.sin(angle) };
        const length = Math.hypot(direction.x, direction.y, direction.z);
        const start = { x: -direction.x / length * reach, y: 100 - direction.y / length * reach, z: -direction.z / length * reach };
        const velocity = { x: (direction.x / length) * speed, y: (direction.y / length) * speed, z: (direction.z / length) * speed };
        const flight = flyTicks(world, start, velocity, 0.35, (reach * 2) / speed, out);
        const stopped = flight.hit === target.id && !flight.endInside && flight.clearance === 0;
        if (!stopped) allStopped = false;
        if (!stopped || VERBOSE) lines.push(`${target.id} ${speed} m/s ${incidence}: ${flight.hit ?? 'through'}${flight.endInside ? ' inside' : ''}${flight.clearance > 0 ? ' touching' : ''}`);
      }
    }
    world.remove(target.id);
  }
  check('tunnelling', 'every shape stops every path at 10, 300 and 2000 m/s, normal and grazing (never inside, never through)', allStopped, lines.join('; ') || '36 flights');
  // A thin string flown at 2000 m/s by a 0.35 m probe whose path misses the string's line by 0.39 m.
  world.add({ id: 'kite', owner: 'lab', type: 'capsule', a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 200, z: 0 }, radius: 0.05, tags: { sensor: true, miss: 'kiteString' } });
  // Counted the flight controller's way: once on entry, re-armed when the probe has left the sensor.
  let sensed = 0;
  let inside = false;
  const filter = { sensors: true, onSensor: () => { if (!inside) sensed++; inside = true; } };
  const position = { x: -50, y: 100, z: 0.39 };
  const next = { x: 0, y: 100, z: 0.39 };
  let solid = false;
  for (let tick = 0; tick < 6; tick++) {
    next.x = position.x + 2000 * TICK;
    if (world.sweepSphere(position, next, 0.35, filter, out)) solid = true;
    position.x = next.x;
    if (inside && !world.touches('kite', position, 0.35)) inside = false;
  }
  check('tunnelling', 'a 5 cm sensor string is sensed at 2000 m/s by a probe passing 0.39 m from its line, and never blocks', sensed === 1 && !solid, `${sensed} sensed, solid ${solid}`);
  world.dispose();
}

// ---- rules ---------------------------------------------------------------------------------------------
function testRules() {
  const surfaces = createGroundSurfaces();
  const world = createColliderWorld({ groundSurfaces: surfaces });
  const out = createOut();
  world.add({ id: 'far', owner: 'lab', type: 'box', center: { x: 20, y: 0, z: 0 }, halfExtents: { x: 1, y: 5, z: 5 } });
  world.add({ id: 'near', owner: 'lab', type: 'box', center: { x: 10, y: 0, z: 0 }, halfExtents: { x: 1, y: 5, z: 5 } });
  world.sweepSphere({ x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }, 0.5, null, out);
  check('rules', 'the earliest hit wins', out.id === 'near', out.id);
  world.add({ id: 'twin-b', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 30 }, halfExtents: { x: 5, y: 5, z: 1 } });
  world.add({ id: 'twin-a', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 30 }, halfExtents: { x: 5, y: 5, z: 1 } });
  world.sweepSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 60 }, 0.5, null, out);
  check('rules', 'a tie goes to the lower id', out.id === 'twin-a', out.id);

  world.add({ id: 'sensor', owner: 'lab', type: 'capsule', a: { x: 5, y: -10, z: -20 }, b: { x: 5, y: 10, z: -20 }, radius: 0.1, tags: { sensor: true, miss: 'kiteString' } });
  const from = { x: 0, y: 0, z: -20 };
  const to = { x: 30, y: 0, z: -20 };
  check('rules', 'sensors are ignored without filter.sensors', !world.sweepSphere(from, to, 0.5, null, out));
  const sensed = [];
  const blocked = world.sweepSphere(from, to, 0.5, { sensors: true, onSensor: (record) => sensed.push(`${record.id}:${record.tags.miss}`) }, out);
  check('rules', 'with onSensor a sensor reports and never blocks', !blocked && sensed.length === 1 && sensed[0] === 'sensor:kiteString', sensed.join());
  check('rules', 'without onSensor a sensor is a hit with its tags', world.sweepSphere(from, to, 0.5, { sensors: true }, out) && out.tags.sensor && out.tags.miss === 'kiteString');
  world.add({ id: 'wall', owner: 'lab', type: 'box', center: { x: 2, y: 0, z: -20 }, halfExtents: { x: 0.5, y: 5, z: 5 } });
  sensed.length = 0;
  world.sweepSphere(from, to, 0.5, { sensors: true, onSensor: (record) => sensed.push(record.id) }, out);
  check('rules', 'a sensor behind the first solid hit is not reached', out.id === 'wall' && sensed.length === 0, `${out.id} ${sensed.join()}`);
  check('rules', 'touches() follows a sensor until the probe leaves it', world.touches('sensor', { x: 5.3, y: 0, z: -20 }, 0.35) && !world.touches('sensor', { x: 6, y: 0, z: -20 }, 0.35));

  world.add({ id: 'roof', owner: 'lab', type: 'box', center: { x: 0, y: 5, z: 100 }, halfExtents: { x: 10, y: 5, z: 10 }, tags: { landable: true } });
  const gear = { landableTops: false };
  check('rules', 'a gear probe ignores a landable top', !world.sweepSphere({ x: 0, y: 12, z: 100 }, { x: 0, y: 9, z: 100 }, 0.35, gear, out));
  check('rules', 'a body probe strikes it', world.sweepSphere({ x: 0, y: 12, z: 100 }, { x: 0, y: 9, z: 100 }, 0.35, null, out) && out.id === 'roof' && out.normal.y > LANDABLE_NORMAL_Y);
  check('rules', 'a gear probe still strikes a landable wall', world.sweepSphere({ x: -20, y: 5, z: 100 }, { x: 0, y: 5, z: 100 }, 0.35, gear, out) && out.id === 'roof' && near(out.normal.x, -1));
  world.dispose();
}

// ---- surfaces ------------------------------------------------------------------------------------------
function testSurfaces() {
  const surfaces = createGroundSurfaces();
  const world = createColliderWorld({ groundSurfaces: surfaces });
  world.add({ id: 'deck', owner: 'lab', type: 'box', center: { x: 0, y: 40, z: 0 }, halfExtents: { x: 10, y: 1, z: 4 }, quaternion: quaternionY(0.3), tags: { landable: true, surface: 'wood' } });
  check('surfaces', 'a landable box publishes its top under its own id', surfaces.count === 1 && surfaces.list()[0].id === 'deck' && near(surfaces.surfaceBelow(0, 0, Infinity), 41), fmt(surfaces.surfaceBelow(0, 0, Infinity)));
  check('surfaces', 'surfaceIdBelow names it; nothing beside it', surfaces.surfaceIdBelow(0, 0, Infinity) === 'deck' && surfaces.surfaceBelow(0, 30, Infinity) === -Infinity);
  check('surfaces', 'a craft below the deck does not stand on it', surfaces.surfaceBelow(0, 0, 30) === -Infinity);
  world.add({ id: 'tower', owner: 'lab', type: 'cylinder', center: { x: 100, y: 20, z: 0 }, radius: 3, halfHeight: 20, tags: { landable: true } });
  check('surfaces', 'a landable cylinder publishes its top disc', near(surfaces.surfaceBelow(101, 1, Infinity), 40) && surfaces.surfaceBelow(104, 0, Infinity) === -Infinity);
  world.add({ id: 'roof', owner: 'lab', type: 'hull', points: Float64Array.from([190, 0, -5, 210, 0, -5, 190, 0, 5, 210, 0, 5, 190, 8, -1, 210, 8, -1, 190, 8, 1, 210, 8, 1]), tags: { landable: true } });
  check('surfaces', 'a landable hull publishes only faces pointing up more than 0.7', near(surfaces.surfaceBelow(200, 0, Infinity), 8) && surfaces.surfaceBelow(200, 4, Infinity) === -Infinity, `${fmt(surfaces.surfaceBelow(200, 0, Infinity))} / ${fmt(surfaces.surfaceBelow(200, 4, Infinity))}`);
  const field = flatField('island', 300, 0, 9, 9, 5, 0, -5, { tags: { landable: true } });
  for (let index = 0; index < field.heights.length; index++) field.heights[index] = 120 + (index % 9);
  world.add({ ...field, heights: field.heights.map((value) => value), bottom: 110 });
  check('surfaces', 'a landable heightfield publishes its triangulated top', near(surfaces.surfaceBelow(302.5, 2, Infinity), 120.5), fmt(surfaces.surfaceBelow(302.5, 2, Infinity)));
  world.add({ ...flatField('exact', 400, 0, 5, 5, 10, 50, 40), tags: { landable: true }, surfaceHeightAt: (x) => 50 + (x - 400) * 0.01 });
  check('surfaces', 'surfaceHeightAt overrides the published top', near(surfaces.surfaceBelow(420, 20, Infinity), 50.2), fmt(surfaces.surfaceBelow(420, 20, Infinity)));
  world.add({ id: 'raft', owner: 'lab', type: 'box', center: { x: 0, y: 10, z: 500 }, halfExtents: { x: 4, y: 0.5, z: 4 }, tags: { landable: true } });
  world.update('raft', { center: { x: 600, y: 12, z: 500 } });
  check('surfaces', 'a moving landable collider moves its surface (and refiles it)', surfaces.surfaceBelow(0, 500, Infinity) === -Infinity && near(surfaces.surfaceBelow(600, 500, Infinity), 12.5));
  world.remove('deck');
  check('surfaces', 'remove takes the surface with it', surfaces.surfaceBelow(0, 0, Infinity) === -Infinity && surfaces.count === 5);
  world.dispose();
  check('surfaces', 'dispose removes every surface', surfaces.count === 0);
}

// ---- providers ------------------------------------------------------------------------------------------
function testProviders() {
  const world = createColliderWorld({});
  const out = createOut();
  // Trunks on a 100 m lattice, one cached spec per lattice point, created the first time it is asked for.
  const cache = new Map();
  let created = 0;
  world.addProvider({
    id: 'trunks',
    query(minX, minZ, maxX, maxZ, emit) {
      for (let gridX = Math.floor(minX / 100); gridX <= Math.floor(maxX / 100); gridX++) {
        for (let gridZ = Math.floor(minZ / 100); gridZ <= Math.floor(maxZ / 100); gridZ++) {
          const key = gridX * 100000 + gridZ;
          let spec = cache.get(key);
          if (!spec) {
            created++;
            spec = { id: `trunk:${gridX}:${gridZ}`, type: 'cylinder', center: { x: gridX * 100, y: 20, z: gridZ * 100 }, radius: 2, halfHeight: 20, tags: { surface: 'wood', perch: true } };
            cache.set(key, spec);
          }
          emit(spec);
        }
      }
    },
  });
  const hitTrunk = world.sweepSphere({ x: 280, y: 10, z: 300 }, { x: 320, y: 10, z: 300 }, 0.5, null, out);
  check('providers', 'a provided collider is hit like a registered one (owner = provider id)', hitTrunk && out.id === 'trunk:3:3' && out.owner === 'trunks' && near(out.normal.x, -1), `${out.id} ${out.owner}`);
  const createdOnce = created;
  for (let index = 0; index < 50; index++) world.sweepSphere({ x: 280, y: 10, z: 300 }, { x: 320, y: 10, z: 300 }, 0.5, null, out);
  check('providers', 'the provider is asked only for the swept box and its specs are reused', createdOnce <= 4 && created === createdOnce, `${created} specs`);
  const perches = [];
  world.addPerchProvider({ id: 'peaks', near: (x, y, z, radius, visit) => visit(x + 1, 900, z, 'peak', 'peaks') });
  world.add({ id: 'stone', owner: 'lab', type: 'box', center: { x: 305, y: 5, z: 305 }, halfExtents: { x: 1, y: 5, z: 1 }, tags: { perch: true } });
  world.add({ id: 'lintel', owner: 'lab', type: 'box', center: { x: 310, y: 12, z: 300 }, halfExtents: { x: 3, y: 0.5, z: 1 }, tags: { perch: [{ x: 309, y: 12.5, z: 300 }, { x: 311, y: 12.5, z: 300 }] } });
  world.perchesNear(305, 20, 300, 30, (x, y, z, kind, source) => perches.push(`${kind}:${source}:${Math.round(y * 10) / 10}`));
  const expected = ['structure:stone:10', 'structure:lintel:12.5', 'structure:lintel:12.5', 'peak:peaks:900'];
  check('providers', 'perchesNear: top centres, given points, provided trunks and perch providers', expected.every((entry) => perches.includes(entry)) && perches.some((entry) => entry.startsWith('structure:trunk:3:3:40')), perches.join(', '));
  world.removeProvider('trunks');
  check('providers', 'a removed provider adds nothing', !world.sweepSphere({ x: 280, y: 10, z: 300 }, { x: 299, y: 10, z: 300 }, 0.5, null, out));
  world.addProvider({ id: 'broken', query: (minX, minZ, maxX, maxZ, emit) => emit({ id: 'bad', type: 'box' }) });
  const errorsBefore = consoleErrors.length;
  world.sweepSphere({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5, null, out);
  world.sweepSphere({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5, null, out);
  check('providers', 'an invalid provided collider is logged once and skipped', consoleErrors.length === errorsBefore + 1, consoleErrors.slice(errorsBefore).join(' | '));
  consoleErrors.length = errorsBefore;
  world.dispose();
}

// ---- service ------------------------------------------------------------------------------------------
function testService() {
  const world = createColliderWorld({});
  world.profile(true);
  const out = createOut();
  const throws = (spec, fragment) => {
    try {
      world.add(spec);
    } catch (error) {
      return error.message.includes(fragment);
    }
    return false;
  };
  world.add({ id: 'one', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } });
  check('service', 'a duplicate id throws', throws({ id: 'one', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } }, 'already exists'));
  check('service', 'validation names the id and the field', throws({ id: 'two', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: -1, z: 1 } }, 'collider "two": halfExtents')
    && throws({ id: 'three', owner: 'lab', type: 'capsule', a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 }, radius: 0.1, tags: { landable: true } }, 'tags.landable')
    && throws({ id: 'four', owner: 'lab', type: 'hull', points: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]) }, 'coplanar')
    && throws({ id: 'five', owner: 'lab', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 }, tags: { surface: 'glass' } }, 'tags.surface')
    && throws({ id: 'six', type: 'box', center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } }, 'owner'));
  world.add({ id: 'mover', owner: 'balloons', type: 'hull', points: octahedron({ x: 0, y: 0, z: 0 }, 3), center: { x: 0, y: 50, z: 0 } });
  world.update('mover', { center: { x: 1000, y: 50, z: 1000 }, quaternion: quaternionY(0.5), velocity: { x: 3, y: 0, z: 1 } });
  const moved = world.sweepSphere({ x: 990, y: 50, z: 1000 }, { x: 1010, y: 50, z: 1000 }, 0.5, null, out);
  check('service', 'update moves and refiles a kinematic collider, with its velocity in hits', moved && out.id === 'mover' && out.velocity && out.velocity.x === 3 && !world.sweepSphere({ x: -10, y: 50, z: 0 }, { x: 10, y: 50, z: 0 }, 0.5, null, out));
  check('service', 'insideSolid finds the holder (and nothing outside)', world.insideSolid(1000, 50, 1000) === 'mover' && world.insideSolid(1000, 60, 1000) === null);
  world.add({ id: 'base', owner: 'balloons', type: 'box', center: { x: 1000, y: 40, z: 1000 }, halfExtents: { x: 5, y: 10, z: 5 } });
  check('service', 'liftClear climbs above stacked colliders', near(world.liftClear(1000, 35, 1000), 53) && world.liftClear(1000, 80, 1000) === 80, fmt(world.liftClear(1000, 35, 1000)));
  check('service', 'boundsOccupied is a cheap broad phase', world.boundsOccupied(990, 40, 990, 1010, 60, 1010) && !world.boundsOccupied(0, 0, 500, 10, 10, 510));
  check('service', 'removeOwner removes every collider of an owner', world.removeOwner('balloons') === 2 && world.count === 1);
  check('service', 'remove reports whether the id was there', world.remove('one') && !world.remove('one') && world.count === 0);
  const stats = world.getStats();
  check('service', 'getStats reports colliders, cells, sweeps, hits and (profiling) time', stats.colliders === 0 && stats.sweeps > 0 && stats.hits > 0 && Number.isFinite(stats.ms), JSON.stringify(stats));
  world.dispose();
}

// ---- determinism --------------------------------------------------------------------------------------
function randomSpecs(seed, count) {
  const random = mulberry32(seed);
  const specs = [];
  for (let index = 0; index < count; index++) {
    const x = (random() - 0.5) * 2000;
    const z = (random() - 0.5) * 2000;
    const y = random() * 200;
    const kind = index % 5;
    const id = `c${String(index).padStart(4, '0')}`;
    if (kind === 0) specs.push({ id, owner: 'lab', type: 'box', center: { x, y, z }, halfExtents: { x: 2 + random() * 10, y: 2 + random() * 10, z: 2 + random() * 10 }, quaternion: quaternionY(random() * 6) });
    else if (kind === 1) specs.push({ id, owner: 'lab', type: 'cylinder', center: { x, y, z }, radius: 1 + random() * 5, halfHeight: 3 + random() * 30 });
    else if (kind === 2) specs.push({ id, owner: 'lab', type: 'capsule', a: { x, y, z }, b: { x: x + random() * 20, y: y + random() * 40, z: z + random() * 20 }, radius: 0.1 + random() });
    else if (kind === 3) specs.push({ id, owner: 'lab', type: 'hull', points: octahedron({ x, y, z }, 2 + random() * 8) });
    else specs.push({ id, owner: 'lab', type: 'box', center: { x, y, z }, halfExtents: { x: 1, y: 1, z: 1 }, tags: { sensor: random() < 0.5, landable: false } });
  }
  return specs;
}

function batteryDigest(world, seed) {
  const random = mulberry32(seed);
  const out = createOut();
  const from = { x: 0, y: 0, z: 0 };
  const to = { x: 0, y: 0, z: 0 };
  let digest = '';
  for (let index = 0; index < 4000; index++) {
    from.x = (random() - 0.5) * 2000;
    from.y = random() * 220;
    from.z = (random() - 0.5) * 2000;
    to.x = from.x + (random() - 0.5) * 600;
    to.y = from.y + (random() - 0.5) * 100;
    to.z = from.z + (random() - 0.5) * 600;
    if (world.sweepSphere(from, to, 0.35 + random(), { sensors: true }, out)) digest += `${out.id}:${out.t.toFixed(12)}:${out.normal.x.toFixed(9)};`;
    else digest += '-;';
  }
  return digest;
}

function testDeterminism() {
  const specs = randomSpecs(17, 1500);
  const ordered = createColliderWorld({});
  for (const spec of specs) ordered.add(spec);
  const shuffled = createColliderWorld({});
  const random = mulberry32(99);
  const order = specs.map((spec, index) => [random(), index]).sort((first, second) => first[0] - second[0]).map(([, index]) => specs[index]);
  for (const spec of order) shuffled.add(spec);
  const first = batteryDigest(ordered, 5);
  const second = batteryDigest(shuffled, 5);
  const hits = first.split(';').filter((entry) => entry && entry !== '-').length;
  check('determinism', 'a shuffled insertion order gives identical results over 4000 sweeps', first === second && hits > 200, `${hits} hits, digests ${first === second ? 'identical' : 'DIFFERENT'}`);
}

// ---- cost and allocation ----------------------------------------------------------------------------------
function costWorld() {
  const world = createColliderWorld({});
  for (const spec of randomSpecs(23, 2000)) world.add(spec);
  return world;
}

function probeBatch(world, out, frame, probes) {
  // 30 probes of a craft flying at 300 m/s through the densest part of the field.
  const baseX = -600 + (frame % 400) * 2.5;
  let hits = 0;
  for (let probe = 0; probe < 30; probe++) {
    probes.from.x = baseX + (probe % 10) * 0.8;
    probes.from.y = 60 + Math.floor(probe / 10) * 0.6;
    probes.from.z = -200 + (probe % 3) * 0.7;
    probes.to.x = probes.from.x + 2.5;
    probes.to.y = probes.from.y;
    probes.to.z = probes.from.z;
    if (world.sweepSphere(probes.from, probes.to, 0.35, probes.filter, out)) hits++;
  }
  return hits;
}

function testCost() {
  const world = costWorld();
  const out = createOut();
  const probes = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 0 }, filter: { sensors: true, onSensor: () => {} } };
  for (let frame = 0; frame < 20000; frame++) probeBatch(world, out, frame, probes);
  const frames = 20000;
  const started = process.hrtime.bigint();
  for (let frame = 0; frame < frames; frame++) probeBatch(world, out, frame, probes);
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6 / frames;
  check('cost', 'a sweep of 30 probes against 2000 colliders under 0.1 ms', milliseconds < 0.1, `${(milliseconds * 1000).toFixed(1)} us per 30 probes, ${world.getStats().cells} cells`);
}

/**
 * The flight controller's per-tick path and the per-frame updates: sweepProbes over 30 probes (a
 * craft at 300 m/s, sensors reported), probesTouch, a moving hull (setPose), an overlap, a raycast and perch
 * points, after a JIT warm-up, measured over three rounds (the last is the steady state). The single
 * queries take number arguments, which the JIT may box at the call; the controller uses the batch.
 */
async function testAllocation() {
  const world = costWorld();
  const landable = createColliderWorld({ groundSurfaces: createGroundSurfaces() });
  landable.add({ id: 'balloon', owner: 'lab', type: 'hull', points: octahedron({ x: 0, y: 0, z: 0 }, 8), center: { x: 0, y: 200, z: 0 } });
  const probes = createProbeSet(30);
  probes.count = 30;
  for (let probe = 0; probe < 30; probe++) probes.radii[probe] = probe === 0 ? 0.6 : 0.35;
  let sensed = 0;
  const onSensor = () => { sensed++; };
  const pose = new Float64Array([0, 200, 0, 0, 0, 0, 1]);
  const origin = { x: 0, y: 60, z: -200 };
  const direction = { x: 1, y: -0.1, z: 0 };
  let visits = 0;
  let hits = 0;
  const visit = () => { visits++; };
  const frame = (index) => {
    // A craft at 300 m/s on a different lane through the field every 400 frames.
    const baseX = -600 + (index % 400) * 2.5;
    const lane = Math.floor(index / 400);
    const laneY = 10 + (lane % 19) * 10;
    const laneZ = ((lane * 137) % 1600) - 800;
    for (let probe = 0; probe < 30; probe++) {
      probes.from[probe * 3] = baseX + (probe % 10) * 0.8;
      probes.from[probe * 3 + 1] = laneY + Math.floor(probe / 10) * 0.6;
      probes.from[probe * 3 + 2] = laneZ + (probe % 3) * 0.7;
      probes.to[probe * 3] = probes.from[probe * 3] + 2.5;
      probes.to[probe * 3 + 1] = probes.from[probe * 3 + 1];
      probes.to[probe * 3 + 2] = probes.from[probe * 3 + 2];
    }
    if (world.sweepProbes(probes, onSensor) >= 0) hits++;
    world.probesTouch('c0004', probes);
    pose[0] = Math.sin(index * 0.001) * 300;
    pose[2] = Math.cos(index * 0.001) * 300;
    pose[4] = Math.sin(index * 0.0005);
    pose[6] = Math.cos(index * 0.0005);
    landable.setPose('balloon', pose);
    origin.x = baseX;
    world.overlapSphere(origin, 3, visit);
    world.raycast(origin, direction, 500, null, probes.hit);
    world.perchesNear(index % 1000 - 500, 60, -200, 50, visit);
  };
  // A long warm-up: rare paths (a lane meeting a hull or a cylinder rim) keep teaching the JIT for a while.
  for (let index = 0; index < 450000; index++) frame(index);
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  const frames = 100000;
  const rounds = [];
  let collections = 0;
  for (let round = 0; round < 3; round++) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    // The forced collection's own performance entry arrives asynchronously: let it pass first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    let roundCollections = 0;
    const observer = new PerformanceObserver((list) => { roundCollections += list.getEntries().length; });
    observer.observe({ entryTypes: ['gc'] });
    const before = youngUsed();
    for (let index = 0; index < frames; index++) frame(index);
    const after = youngUsed();
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    rounds.push((after - before) / frames);
    collections = roundCollections;
  }
  const perFrame = rounds[rounds.length - 1];
  check('allocation', `no garbage collection during ${frames} frames of sweepProbes (30 probes), probesTouch, a moving hull, an overlap, a raycast and perches`, collections === 0, `${collections} collections, ${hits} probe hits, ${sensed} sensor reports, ${visits} visits`);
  check('allocation', 'young generation grows under 0.1 byte per frame (steady state)', collections === 0 && perFrame < 0.1, `rounds ${rounds.map((value) => value.toFixed(3)).join(' / ')} B/frame`);
}

// The allocation measurement first, before the other tests leave garbage for the collector.
await testAllocation();
testShapes();
testTunnelling();
testRules();
testSurfaces();
testProviders();
testService();
testDeterminism();
testCost();

console.error = originalError;
check('console', 'no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
