// Collision test (?test=collision, dev builds only; main.js never loads it in production). Phase 3
// contract k.2 and spec Milestone P item 4, for the parts that exist now.
//
// A fixture of one collider of every type (box, cylinder, capsule, hull, heightfield and a mesh BVH
// "tunnel mountain": a winding ridge with a bore through it) high above the terrain near the spawn,
// a kite-string slalom of sensor capsules, every retrofitted v1-derived landmark (the nearest arch,
// monolith circle, lighthouse and balloon fair, streamed in by the real landmark system) and every
// Phase 2 structure preset (wind farm, rope bridge, airfield, crystal spires, floating islands,
// force-spawned by the real SpawnManager). Then:
//   - strikes: the jet and the bush plane (and the spaceplane once it is registered) fly a scripted
//     straight line into each target at 60, 250 and 1500 m/s: every run must end in a soft crash with
//     reason 'structure strike' and never pass through; with the real flight model, the bush plane
//     and the jet at cruise into the box and the tunnel mountain's flank do the same;
//   - penetration: no collision probe ever ends a tick inside a solid collider (checked every tick
//     and at the crash pose);
//   - a slow bump: the bush plane at 3 m/s into the box resolves (colliderHit, no crash);
//   - the tunnel: a centreline run through the bore (a path sampled along its curve) at 60 m/s
//     completes with no hit;
//   - the arch: a run through its opening along the threading line touches nothing and threads it;
//   - kite strings: every string crossed at 60, 250 and 1500 m/s registers one miss (colliderSensor
//     with tag 'kiteString'), and nothing crashes;
//   - the single three.js core: the tunnel's three-mesh-bvh raycast answers with the game's own
//     THREE.Vector3.
// A scripted run drives the model kinematically: its step() is replaced for the run by a constant
// velocity and attitude, so the controller's own sweep, strike and crash code is what is tested; the
// real-model runs keep the model. Reports per target type, on either backend (tools/run-harness.mjs
// --test collision). The test runs in its own IndexedDB database and changes no player setting.
import { MeshBVH } from 'three-mesh-bvh';
import { createMeshCollider } from '../world/colliderMesh.js';
import { installConsoleCapture } from './testConsole.js';
import { createTestPanel } from './testPanel.js';
import { PRESETS } from '../spawns/presets/index.js';

export const TEST_DATABASE = 'driftwing-v2-test-collision';
const REPORT_KIND = 'driftwing-collision-test';
const REPORT_VERSION = 1;
const SPEEDS = Object.freeze([60, 250, 1500]);
const STRIKE_CRAFT = Object.freeze(['jet', 'bushplane', 'spaceplane']);
const STRIKE_REASON = 'structure strike';
const FIXTURE_OWNER = 'test:collision';
/** The fixture floats this far above the highest terrain around it (m), well above every respawn. */
const FIXTURE_CLEARANCE = 1400;
/** A probe deeper than this (m) inside a solid collider is a penetration. */
const PENETRATION_TOLERANCE = 0.05;
const LANDMARK_TYPES = Object.freeze(['arch', 'monoliths', 'lighthouse', 'balloons']);
const LANDMARK_SEARCH = Object.freeze([12000, 30000, 60000, 120000]);
const STRUCTURE_PRESETS = Object.freeze(['windFarm', 'ropeBridge', 'abandonedAirfield', 'crystalSpires', 'floatingIslands']);
const TUNNEL_BORE = 16;
const TUNNEL_OUTER = 70;
const KITE_STRINGS = 5;
const TIMEOUT_FRAMES = 900;

export function prepareCollisionTest() {
  const capture = installConsoleCapture();
  return {
    databaseName: TEST_DATABASE,
    createSystem: (ctx) => createCollisionTestSystem(ctx, { capture }),
  };
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function createCollisionTestSystem(ctx, { capture }) {
  const { THREE, bus, state, world, settings, scene } = ctx;
  const colliders = ctx.colliders;
  const panel = createTestPanel({ title: 'Collision test' });
  const report = {};
  const runs = [];
  const special = {};
  const harnessErrors = [];
  const frameWaiters = [];
  const fixtureObjects = [];
  const fixtureGeometries = [];
  const fixtureMaterials = [];
  const startedAt = new Date().toISOString();
  let finishedAt = null;
  let status = 'running';
  let phase = 'waiting for the game';
  let step = '';
  let done = 0;
  let total = 0;
  let singleCore = null;
  let tunnel = null;

  // Events of the current run.
  const events = { crashes: [], hits: [], sensors: [], threaded: [] };
  bus.onTyped('softCrash', (payload) => events.crashes.push(payload));
  bus.onTyped('colliderHit', (payload) => events.hits.push(payload));
  bus.onTyped('colliderSensor', (payload) => events.sensors.push(payload));
  bus.on('landmark:threaded', (payload) => events.threaded.push(payload));
  function clearEvents() {
    events.crashes.length = 0;
    events.hits.length = 0;
    events.sensors.length = 0;
    events.threaded.length = 0;
  }

  // ---- Frames ----------------------------------------------------------------------------------
  function nextFrame() {
    return new Promise((resolve) => { frameWaiters.push(resolve); });
  }
  async function waitFrames(count) {
    for (let index = 0; index < count; index++) await nextFrame();
  }

  const flight = () => ctx.systems.flight;

  // ---- Report ------------------------------------------------------------------------------------
  function criteria() {
    const strikes = runs.filter((run) => run.expect === 'crash');
    const struck = strikes.filter((run) => run.crashed && run.reason === STRIKE_REASON);
    const through = runs.filter((run) => run.passedThrough);
    const penetrations = runs.reduce((sum, run) => sum + run.penetrations, 0);
    const counts = capture.counts;
    const types = new Set(strikes.map((run) => run.kind));
    const expectedTypes = ['box', 'cylinder', 'capsule', 'hull', 'heightfield', 'mesh', ...LANDMARK_TYPES.map((type) => `landmark ${type}`), ...STRUCTURE_PRESETS.map((id) => `structure ${id}`)];
    const kite = special.kite;
    const bump = special.bump;
    return [
      { id: 'strikes', label: 'Strikes end in a soft crash (structure strike)', value: `${struck.length} / ${strikes.length}`, status: strikes.length > 0 && struck.length === strikes.length ? 'pass' : 'fail' },
      { id: 'coverage', label: 'Every collider type, landmark and structure flown into', value: `${expectedTypes.filter((type) => types.has(type)).length} / ${expectedTypes.length}${expectedTypes.some((type) => !types.has(type)) ? ` (missing ${expectedTypes.filter((type) => !types.has(type)).join(', ')})` : ''}`, status: expectedTypes.every((type) => types.has(type)) ? 'pass' : 'fail' },
      { id: 'through', label: 'Never passed through', value: `${through.length} pass-throughs`, status: runs.length > 0 && through.length === 0 ? 'pass' : 'fail' },
      { id: 'penetration', label: `Probes inside a solid collider at a tick's end (> ${PENETRATION_TOLERANCE} m)`, value: `${penetrations}`, status: runs.length > 0 && penetrations === 0 ? 'pass' : 'fail' },
      { id: 'bump', label: 'A 3 m/s bump resolves without a crash', value: bump ? `${bump.contacts} contacts, ${bump.crashed ? 'crashed' : 'no crash'}` : 'not run', status: bump && bump.contacts > 0 && !bump.crashed && bump.penetrations === 0 ? 'pass' : 'fail' },
      { id: 'tunnel', label: 'Tunnel centreline run completes with 0 hits', value: special.tunnel ? `${special.tunnel.completed ? 'completed' : 'stopped'}, ${special.tunnel.hits} hits` : 'not run', status: special.tunnel && special.tunnel.completed && special.tunnel.hits === 0 ? 'pass' : 'fail' },
      { id: 'arch', label: 'Through the arch: no hit, threaded', value: special.arch ? `${special.arch.hits} hits, ${special.arch.threaded ? 'threaded' : 'not threaded'}` : 'not run', status: special.arch && special.arch.hits === 0 && special.arch.threaded && !special.arch.crashed ? 'pass' : 'fail' },
      { id: 'kite', label: 'Kite strings register misses and never crash', value: kite ? `${kite.misses} / ${kite.expected} misses, ${kite.crashes} crashes, ${kite.hits} hits` : 'not run', status: kite && kite.misses === kite.expected && kite.crashes === 0 && kite.hits === 0 ? 'pass' : 'fail' },
      { id: 'core', label: 'One three.js core (three-mesh-bvh answers with the game\'s Vector3)', value: singleCore === null ? 'not run' : singleCore ? 'yes' : 'NO', status: singleCore ? 'pass' : 'fail' },
      { id: 'console', label: 'Console errors / warnings', value: `${counts.errors} / ${counts.warnings}`, status: counts.errors === 0 && counts.warnings === 0 ? 'pass' : 'fail' },
    ];
  }

  function byType() {
    const rows = new Map();
    for (const run of runs) {
      const row = rows.get(run.kind) ?? { kind: run.kind, runs: 0, crashes: 0, through: 0, penetrations: 0, speeds: new Set(), crafts: new Set(), impact: 0 };
      row.runs++;
      if (run.crashed && run.reason === STRIKE_REASON) row.crashes++;
      if (run.passedThrough) row.through++;
      row.penetrations += run.penetrations;
      row.speeds.add(run.speed);
      row.crafts.add(run.craft);
      row.impact = Math.max(row.impact, run.impactSpeed ?? 0);
      rows.set(run.kind, row);
    }
    return [...rows.values()].map((row) => ({ ...row, speeds: [...row.speeds].join(' '), crafts: [...row.crafts].join(' ') }));
  }

  function publish() {
    const list = criteria();
    const failed = list.some((criterion) => criterion.status === 'fail') || harnessErrors.length > 0;
    Object.assign(report, {
      kind: REPORT_KIND,
      version: REPORT_VERSION,
      status,
      result: status === 'complete' ? (failed ? 'FAIL' : 'PASS') : null,
      startedAt,
      finishedAt,
      progress: { done, total, phase, step },
      environment: { backend: ctx.backend, backends: [ctx.backend], revision: THREE.REVISION, userAgent: navigator.userAgent, seed: state.seed },
      criteria: list,
      types: byType(),
      runs,
      special,
      colliderStats: colliders.getStats(),
      console: capture.entries.slice(0, 200),
      harnessErrors: harnessErrors.slice(),
    });
    if (window.DRIFTWING) window.DRIFTWING.testReport = report;
  }

  function progress(label, detail) {
    step = detail;
    capture.setContext(`collision ${phase}: ${detail}`);
    panel.setProgress({ label, detail, fraction: total > 0 ? done / total : 0 });
    publish();
  }

  // ---- Fixture -----------------------------------------------------------------------------------
  const fixtureMaterial = () => {
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x8c8274, roughness: 0.85 });
    fixtureMaterials.push(material);
    return material;
  };

  function show(geometry, position, quaternion = null) {
    const mesh = new THREE.Mesh(geometry, fixtureMaterial());
    mesh.position.copy(position);
    if (quaternion) mesh.quaternion.copy(quaternion);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    fixtureObjects.push(mesh);
    fixtureGeometries.push(geometry);
    return mesh;
  }

  /** The tunnel mountain: a fat winding tube (rock, jagged outside) with a bore along its centre line. */
  function buildTunnelGeometry(curve) {
    const segments = 64;
    const sides = 24;
    const frames = curve.computeFrenetFrames(segments, false);
    const positions = [];
    const indices = [];
    const ring = (radius, jag) => {
      const start = positions.length / 3;
      for (let segment = 0; segment <= segments; segment++) {
        const point = curve.getPointAt(segment / segments);
        for (let side = 0; side < sides; side++) {
          const angle = (side / sides) * Math.PI * 2;
          const wobble = jag ? 1 + 0.12 * Math.sin(side * 2.7 + segment * 1.3) + 0.08 * Math.sin(side * 5.1 - segment * 0.7) : 1;
          const normal = frames.normals[segment].clone().multiplyScalar(Math.cos(angle) * radius * wobble);
          const binormal = frames.binormals[segment].clone().multiplyScalar(Math.sin(angle) * radius * wobble);
          positions.push(point.x + normal.x + binormal.x, point.y + normal.y + binormal.y, point.z + normal.z + binormal.z);
        }
      }
      return start;
    };
    const outer = ring(TUNNEL_OUTER, true);
    const inner = ring(TUNNEL_BORE, false);
    const vertex = (base, segment, side) => base + segment * sides + (side % sides);
    for (let segment = 0; segment < segments; segment++) {
      for (let side = 0; side < sides; side++) {
        // Outward faces outside, faces toward the axis (outward of the solid) inside.
        indices.push(vertex(outer, segment, side), vertex(outer, segment + 1, side), vertex(outer, segment, side + 1));
        indices.push(vertex(outer, segment + 1, side), vertex(outer, segment + 1, side + 1), vertex(outer, segment, side + 1));
        indices.push(vertex(inner, segment, side), vertex(inner, segment, side + 1), vertex(inner, segment + 1, side));
        indices.push(vertex(inner, segment + 1, side), vertex(inner, segment, side + 1), vertex(inner, segment + 1, side + 1));
      }
    }
    // The end walls: rings joining the outer and inner circles.
    for (const segment of [0, segments]) {
      for (let side = 0; side < sides; side++) {
        const a = vertex(outer, segment, side);
        const b = vertex(outer, segment, side + 1);
        const c = vertex(inner, segment, side);
        const d = vertex(inner, segment, side + 1);
        if (segment === 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  /** Builds the fixture over the area east of the spawn; returns the target list for it. */
  function buildFixture() {
    const originX = state.spawn.x + 2500;
    const originZ = state.spawn.z - 2500;
    let highest = -Infinity;
    for (let x = -1200; x <= 4200; x += 100) for (let z = -1500; z <= 1500; z += 100) highest = Math.max(highest, world.groundHeight(originX + x, originZ + z));
    const base = Math.max(highest, world.WATER_LEVEL) + FIXTURE_CLEARANCE;
    const tags = { surface: 'stone' };
    const spot = (index) => new THREE.Vector3(originX + index * 600, base, originZ);
    const add = (spec) => colliders.add({ owner: FIXTURE_OWNER, tags, ...spec });
    const targets = [];

    const boxCentre = spot(0);
    add({ id: 'test:box', type: 'box', center: boxCentre, halfExtents: { x: 15, y: 15, z: 15 }, quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4) });
    show(new THREE.BoxGeometry(30, 30, 30), boxCentre, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4));
    targets.push({ kind: 'box', id: 'test:box', owner: FIXTURE_OWNER });

    const mastCentre = spot(1);
    add({ id: 'test:cylinder', type: 'cylinder', center: mastCentre, radius: 4, halfHeight: 40 });
    show(new THREE.CylinderGeometry(4, 4, 80, 24), mastCentre);
    targets.push({ kind: 'cylinder', id: 'test:cylinder', owner: FIXTURE_OWNER });

    const capsuleCentre = spot(2);
    const capsuleA = capsuleCentre.clone().add(new THREE.Vector3(-8, -35, 0));
    const capsuleB = capsuleCentre.clone().add(new THREE.Vector3(8, 35, 0));
    add({ id: 'test:capsule', type: 'capsule', a: capsuleA, b: capsuleB, radius: 2.5 });
    const capsuleMesh = show(new THREE.CapsuleGeometry(2.5, capsuleA.distanceTo(capsuleB), 6, 16), capsuleCentre);
    capsuleMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), capsuleB.clone().sub(capsuleA).normalize());
    targets.push({ kind: 'capsule', id: 'test:capsule', owner: FIXTURE_OWNER });

    const hullCentre = spot(3);
    const hullPoints = [];
    for (let index = 0; index < 24; index++) {
      const theta = index * 2.399963;
      const y = 1 - (index / 23) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const reach = 18 * (0.8 + 0.25 * Math.sin(index * 1.7));
      hullPoints.push(new THREE.Vector3(Math.cos(theta) * ring * reach, y * reach * 0.7, Math.sin(theta) * ring * reach).add(hullCentre));
    }
    add({ id: 'test:hull', type: 'hull', points: Float64Array.from(hullPoints.flatMap((point) => [point.x, point.y, point.z])) });
    show(convexDisplayGeometry(THREE, hullPoints.map((point) => point.clone().sub(hullCentre))), hullCentre);
    targets.push({ kind: 'hull', id: 'test:hull', owner: FIXTURE_OWNER });

    const fieldCorner = spot(4).add(new THREE.Vector3(-30, 0, -30));
    const cols = 31;
    const heights = new Float32Array(cols * cols);
    for (let row = 0; row < cols; row++) for (let column = 0; column < cols; column++) heights[row * cols + column] = base + 12 + 2 * Math.sin(column * 0.4) * Math.cos(row * 0.3);
    add({ id: 'test:heightfield', type: 'heightfield', x0: fieldCorner.x, z0: fieldCorner.z, cell: 2, cols, rows: cols, heights, bottom: base, tags: { surface: 'stone', landable: true } });
    const fieldGeometry = new THREE.PlaneGeometry(60, 60, cols - 1, cols - 1).rotateX(-Math.PI / 2);
    const fieldPositions = fieldGeometry.attributes.position;
    for (let index = 0; index < fieldPositions.count; index++) {
      const column = Math.round((fieldPositions.getX(index) + 30) / 2);
      const row = Math.round((fieldPositions.getZ(index) + 30) / 2);
      fieldPositions.setY(index, heights[row * cols + column] - base);
    }
    fieldGeometry.computeVertexNormals();
    show(fieldGeometry, new THREE.Vector3(fieldCorner.x + 30, base, fieldCorner.z + 30));
    targets.push({ kind: 'heightfield', id: 'test:heightfield', owner: FIXTURE_OWNER });
    targets.push({ kind: 'heightfield', id: 'test:heightfield', owner: FIXTURE_OWNER, dive: true });

    // The tunnel mountain (mesh BVH), farther east along a winding curve.
    const tunnelStart = spot(6);
    const curve = new THREE.CatmullRomCurve3([
      tunnelStart.clone(), tunnelStart.clone().add(new THREE.Vector3(150, 25, 90)), tunnelStart.clone().add(new THREE.Vector3(320, -10, -60)),
      tunnelStart.clone().add(new THREE.Vector3(480, 20, 40)), tunnelStart.clone().add(new THREE.Vector3(650, 0, 0)),
    ].map((point) => point.sub(tunnelStart)));
    const tunnelGeometry = buildTunnelGeometry(curve);
    const matrix = new THREE.Matrix4().makeTranslation(tunnelStart.x, tunnelStart.y, tunnelStart.z);
    const meshCollider = createMeshCollider(tunnelGeometry, Float64Array.from(matrix.elements));
    add({ id: 'test:mesh', type: 'mesh', mesh: meshCollider });
    show(tunnelGeometry, tunnelStart);
    tunnel = { curve, origin: tunnelStart, collider: meshCollider };
    targets.push({ kind: 'mesh', id: 'test:mesh', owner: FIXTURE_OWNER, aim: curve.getPointAt(0.5).add(tunnelStart).add(new THREE.Vector3(0, TUNNEL_OUTER * 0.4, 0)) });

    // The kite-string slalom: sensor capsules across a lane south of the fixture.
    const laneStart = new THREE.Vector3(originX, base, originZ + 700);
    const strings = [];
    for (let index = 0; index < KITE_STRINGS; index++) {
      const anchor = laneStart.clone().add(new THREE.Vector3(80 + index * 60, -120, (index % 2 === 0 ? -6 : 6)));
      const kite = anchor.clone().add(new THREE.Vector3(10, 240, 0));
      add({ id: `test:kite${index}`, type: 'capsule', a: anchor, b: kite, radius: 0.08, tags: { surface: 'rope', sensor: true, miss: 'kiteString' } });
      const length = anchor.distanceTo(kite);
      const stringMesh = show(new THREE.CylinderGeometry(0.08, 0.08, length, 6), anchor.clone().lerp(kite, 0.5));
      stringMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), kite.clone().sub(anchor).normalize());
      strings.push(`test:kite${index}`);
    }
    return { targets, laneStart, strings, base };
  }

  // ---- Runs -------------------------------------------------------------------------------------
  /** The probes' world positions for the model's current pose. */
  function probePositions(model, probes) {
    const points = [];
    const offset = new THREE.Vector3();
    for (let probe = 0; probe < probes.count; probe++) {
      offset.set(probes.offsets[probe * 3], probes.offsets[probe * 3 + 1], probes.offsets[probe * 3 + 2]).applyQuaternion(model.state.quaternion).add(model.state.position);
      points.push(offset.clone());
    }
    return points;
  }

  function countPenetrations(model, probes) {
    let count = 0;
    for (const point of probePositions(model, probes)) if (colliders.insideSolid(point.x, point.y, point.z, PENETRATION_TOLERANCE) !== null) count++;
    return count;
  }

  async function useCraft(craft) {
    if (flight().getCraft() !== craft) {
      settings.set('craft', craft);
      await waitFrames(3);
    }
    return flight().getCraft() === craft;
  }

  async function waitForCrashToEnd() {
    for (let frame = 0; frame < 240 && state.flight.crash.active; frame++) await nextFrame();
  }

  /** Heading (degrees) and pitch (radians) of a direction. */
  function attitudeOf(direction) {
    return { heading: (Math.atan2(direction.x, -direction.z) * 180) / Math.PI, pitch: Math.asin(Math.max(-1, Math.min(1, direction.y))) };
  }

  /**
   * One run: the craft placed at start facing along direction, then flown (kinematic: at a constant
   * speed and attitude; real: by its flight model) until it crashes, passes `beyond` metres past the
   * aim, or times out. path: an optional (seconds) -> { position, direction } for a curved run.
   */
  async function flyRun({ craft, speed, start, direction, kinematic = true, aim = null, beyond = 200, path = null, seconds = null }) {
    const result = { craft, speed, crashed: false, reason: null, impactSpeed: null, penetrations: 0, passedThrough: false, hits: 0, contacts: 0, sensors: [], threaded: 0, ticks: 0, timedOut: false, craftOk: true };
    if (!(await useCraft(craft))) {
      result.craftOk = false;
      return result;
    }
    await waitForCrashToEnd();
    const { heading, pitch } = attitudeOf(direction);
    flight().resetTo({ x: start.x, y: start.y, z: start.z, heading });
    await waitFrames(1);
    const model = flight().getModel();
    const probes = flight().getCollisionProbes();
    const velocity = direction.clone().normalize().multiplyScalar(speed);
    const attitude = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, (-heading * Math.PI) / 180, 0, 'YXZ'));
    const original = model.step;
    let elapsed = 0;
    model.state.position.copy(start);
    model.state.quaternion.copy(attitude);
    model.state.velocity.copy(velocity);
    model.step = (dt, controls, env) => {
      result.penetrations += countPenetrations(model, probes);
      result.ticks++;
      if (!kinematic) return original.call(model, dt, controls, env);
      elapsed += dt;
      if (path) {
        const pose = path(elapsed);
        model.state.position.copy(pose.position);
        const turn = attitudeOf(pose.direction);
        model.state.quaternion.setFromEuler(new THREE.Euler(turn.pitch, (-turn.heading * Math.PI) / 180, 0, 'YXZ'));
        model.state.velocity.copy(pose.direction).multiplyScalar(speed);
      } else {
        model.state.position.addScaledVector(velocity, dt);
        model.state.velocity.copy(velocity);
        model.state.quaternion.copy(attitude);
      }
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
    clearEvents();
    const aimPoint = aim ?? start.clone().addScaledVector(direction, 1e6);
    const forward = direction.clone().normalize();
    try {
      for (let frame = 0; frame < TIMEOUT_FRAMES; frame++) {
        await nextFrame();
        if (events.crashes.length > 0) break;
        if (seconds !== null && elapsed >= seconds) break;
        if (seconds === null && model.state.position.clone().sub(aimPoint).dot(forward) > beyond) break;
        if (frame === TIMEOUT_FRAMES - 1) result.timedOut = true;
      }
    } finally {
      model.step = original;
    }
    const crash = events.crashes.find((entry) => entry.craft === craft) ?? null;
    result.crashed = crash !== null;
    result.reason = crash ? crash.reason : null;
    result.impactSpeed = crash ? round(crash.impactSpeed, 1) : null;
    // At the crash the controller holds the craft at its contact point: no probe may be inside there.
    if (crash) result.penetrations += countPenetrations(model, probes);
    result.hits = events.hits.filter((hit) => hit.crashed).length;
    result.contacts = events.hits.filter((hit) => !hit.crashed).length;
    result.hitIds = [...new Set(events.hits.map((hit) => hit.id))].slice(0, 4);
    result.sensors = events.sensors.map((sensor) => `${sensor.id}:${sensor.tag}`);
    result.threaded = events.threaded.length;
    await waitForCrashToEnd();
    return result;
  }

  /**
   * A straight approach into the target: from a bearing where the line to the aim point meets the
   * target's own owner first and stays clear of the terrain.
   */
  function approachFor(target, speed) {
    const record = colliders.get(target.id);
    if (!record) return null;
    const bounds = record.bounds;
    const centre = target.aim ? target.aim.clone() : new THREE.Vector3((bounds[0] + bounds[3]) / 2, (bounds[1] + bounds[4]) / 2, (bounds[2] + bounds[5]) / 2);
    // A low target (a hangar, a stone) is aimed near its top, so the approach clears the ground.
    const height = bounds[4] - bounds[1];
    if (!target.aim && height < 15) centre.y = Math.max(centre.y, bounds[4] - Math.min(3, height * 0.3));
    const size = Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) * 0.5;
    const distance = Math.max(180, speed * 0.35) + size;
    const out = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null, distance: 0 };
    const pitches = target.dive ? [-0.9] : [0, 0.12, -0.12];
    for (const pitch of pitches) {
      for (let bearing = 0; bearing < 16; bearing++) {
        const angle = (bearing / 16) * Math.PI * 2 + 0.2;
        const direction = new THREE.Vector3(Math.sin(angle) * Math.cos(pitch), Math.sin(pitch), -Math.cos(angle) * Math.cos(pitch));
        const start = centre.clone().addScaledVector(direction, -distance);
        let clear = true;
        for (let sample = 0; sample <= 40 && clear; sample++) {
          const point = start.clone().lerp(centre, sample / 40);
          if (point.y < Math.max(world.groundHeight(point.x, point.z), world.WATER_LEVEL) + 4) clear = false;
        }
        if (!clear || colliders.insideSolid(start.x, start.y, start.z) !== null) continue;
        if (!colliders.raycast(start, direction, distance + size, null, out) || out.owner !== record.owner) continue;
        return { start, direction, aim: centre };
      }
    }
    return null;
  }

  async function strikeRuns(target, crafts) {
    for (const craft of crafts) {
      for (const speed of SPEEDS) {
        done++;
        progress(`Strike ${target.kind}`, `${craft} at ${speed} m/s`);
        const approach = approachFor(target, speed);
        if (!approach) {
          harnessErrors.push(`no clear approach to ${target.kind} (${target.id})`);
          continue;
        }
        const result = await flyRun({ craft, speed, start: approach.start, direction: approach.direction, aim: approach.aim, beyond: 60 });
        result.kind = target.kind;
        result.target = target.id;
        result.expect = 'crash';
        result.passedThrough = !result.crashed && !result.timedOut;
        runs.push(result);
      }
    }
  }

  // ---- Landmarks and structures ---------------------------------------------------------------------
  async function streamLandmark(site) {
    const ground = Math.max(world.groundHeight(site.x, site.z), world.WATER_LEVEL);
    flight().resetTo({ x: site.x + 300, y: ground + 350, z: site.z + 300, heading: 0 });
    for (let frame = 0; frame < 1200; frame++) {
      await nextFrame();
      if (ctx.systems.landmarks.getBuilt().some((entry) => entry.id === site.id)) return ctx.systems.landmarks.getBuilt().find((entry) => entry.id === site.id);
      // The craft keeps flying: put it back over the site now and then.
      if (frame % 120 === 119) flight().resetTo({ x: site.x + 300, y: ground + 350, z: site.z + 300, heading: 0 });
    }
    return null;
  }

  function nearestSites() {
    const found = {};
    for (const radius of LANDMARK_SEARCH) {
      for (const site of world.landmarkSitesNear(state.spawn.x, state.spawn.z, radius)) {
        const distance = Math.hypot(site.x - state.spawn.x, site.z - state.spawn.z);
        if (!found[site.type] || distance < found[site.type].distance) found[site.type] = { site, distance };
      }
      if (LANDMARK_TYPES.every((type) => found[type])) break;
    }
    return found;
  }

  /** The landmark's target colliders: its biggest solid pieces of the parts that matter. */
  function landmarkTarget(type, site) {
    const own = colliders.list().filter((entry) => entry.owner === `landmark:${site.id}` && !entry.tags.sensor);
    // The arch's highest rib (its legs reach far underground), the tallest stone, the tower, an envelope.
    const part = { arch: ':rib', monoliths: ':stone', lighthouse: ':tower', balloons: ':envelope' }[type];
    const pieces = own.filter((entry) => entry.id.includes(part));
    const measure = type === 'arch' ? (entry) => entry.bounds.max.y : (entry) => entry.bounds.max.y - entry.bounds.min.y;
    const pick = (pieces.length > 0 ? pieces : own).sort((first, second) => measure(second) - measure(first))[0];
    return pick ? { kind: `landmark ${type}`, id: pick.id, owner: pick.owner } : null;
  }

  async function landmarkRuns(crafts) {
    const sites = nearestSites();
    for (const type of LANDMARK_TYPES) {
      if (!sites[type]) {
        harnessErrors.push(`no ${type} landmark within ${LANDMARK_SEARCH[LANDMARK_SEARCH.length - 1] / 1000} km of the spawn`);
        continue;
      }
      phase = `landmark ${type}`;
      progress('Streaming', `${type} ${sites[type].site.id} at ${round(sites[type].distance / 1000, 1)} km`);
      const built = await streamLandmark(sites[type].site);
      if (!built) {
        harnessErrors.push(`the ${type} landmark ${sites[type].site.id} did not build`);
        continue;
      }
      const target = landmarkTarget(type, sites[type].site);
      if (!target) {
        harnessErrors.push(`the ${type} landmark registered no colliders`);
        continue;
      }
      await strikeRuns(target, crafts);
      if (type === 'arch') await archRun(built);
    }
  }

  /** Through the arch's opening along its threading line (bush plane, 60 m/s, kinematic). */
  async function archRun(built) {
    done++;
    progress('Arch', 'through the opening');
    const along = new THREE.Vector3(Math.sin(built.rotation), 0, Math.cos(built.rotation));
    const aim = new THREE.Vector3(built.aim.x, built.aim.y, built.aim.z);
    const start = aim.clone().addScaledVector(along, -250);
    const result = await flyRun({ craft: 'bushplane', speed: 60, start, direction: along, aim, beyond: 150 });
    special.arch = { hits: result.hits + result.contacts, threaded: result.threaded > 0, crashed: result.crashed, penetrations: result.penetrations, hitIds: result.hitIds };
    runs.push({ ...result, kind: 'arch opening', target: built.id, expect: 'clear', passedThrough: false });
  }

  async function structureRuns(crafts) {
    const manager = ctx.systems.spawns.manager;
    const ahead = new THREE.Vector3(state.spawn.x - 4000, 0, state.spawn.z + 4000);
    for (const [index, presetId] of STRUCTURE_PRESETS.entries()) {
      phase = `structure ${presetId}`;
      const preset = PRESETS.find((entry) => entry.id === presetId);
      if (!preset) {
        harnessErrors.push(`preset ${presetId} is missing`);
        continue;
      }
      if (!manager.getPreset(presetId)) manager.addPreset(preset);
      const x = ahead.x + index * 5000;
      const z = ahead.z;
      const ground = Math.max(world.groundHeight(x, z), world.WATER_LEVEL);
      flight().resetTo({ x: x - 900, y: ground + 500, z, heading: 90 });
      await waitFrames(2);
      const spawnId = manager.activate(presetId, { position: { x, y: world.groundHeight(x, z), z }, heading: 90, source: 'debug', force: true });
      if (!spawnId) {
        harnessErrors.push(`the ${presetId} spawn was refused`);
        continue;
      }
      await waitFrames(4);
      const own = colliders.list().filter((entry) => entry.owner.startsWith(`${presetId}:`) && !entry.tags.sensor);
      const part = { windFarm: ':mast', ropeBridge: ':deck', abandonedAirfield: ':hangar', crystalSpires: ':spire', floatingIslands: ':rock' }[presetId];
      const pieces = own.filter((entry) => entry.id.includes(part));
      const pick = pieces.sort((first, second) => (second.bounds.max.y - second.bounds.min.y) - (first.bounds.max.y - first.bounds.min.y))[0];
      if (!pick) harnessErrors.push(`${presetId} registered no ${part.slice(1)} collider`);
      else await strikeRuns({ kind: `structure ${presetId}`, id: pick.id, owner: pick.owner }, crafts);
      manager.deactivate(spawnId, 'collision test');
      await waitFrames(4);
      const left = colliders.list().filter((entry) => entry.owner.startsWith(`${presetId}:`));
      if (left.length > 0) harnessErrors.push(`${presetId} left ${left.length} colliders after dispose`);
    }
  }

  // ---- Special runs ------------------------------------------------------------------------------
  async function bumpRun() {
    done++;
    progress('Bump', 'bush plane at 3 m/s into the box');
    const record = colliders.get('test:box');
    const centre = new THREE.Vector3((record.bounds[0] + record.bounds[3]) / 2, (record.bounds[1] + record.bounds[4]) / 2, (record.bounds[2] + record.bounds[5]) / 2);
    const approach = approachFor({ id: 'test:box' }, 3);
    const start = centre.clone().addScaledVector(approach.direction, -(Math.hypot(record.bounds[3] - record.bounds[0], record.bounds[5] - record.bounds[2]) * 0.5 + 12));
    const result = await flyRun({ craft: 'bushplane', speed: 3, start, direction: approach.direction, seconds: 6 });
    special.bump = { contacts: result.contacts, crashed: result.crashed, penetrations: result.penetrations };
    runs.push({ ...result, kind: 'box bump', target: 'test:box', expect: 'contact', passedThrough: false });
  }

  async function tunnelRun() {
    done++;
    progress('Tunnel', 'centreline run at 60 m/s');
    const length = tunnel.curve.getLength();
    const speed = 60;
    const path = (seconds) => {
      const share = Math.min(1, (seconds * speed) / (length + 400));
      const along = share * (length + 400) - 200;
      const u = Math.max(0, Math.min(1, along / length));
      const tangent = tunnel.curve.getTangentAt(u);
      const position = tunnel.curve.getPointAt(u).add(tunnel.origin).addScaledVector(tangent, along < 0 ? along : along > length ? along - length : 0);
      return { position, direction: tangent };
    };
    const first = path(0);
    const result = await flyRun({ craft: 'bushplane', speed, start: first.position, direction: first.direction, path, seconds: (length + 400) / speed });
    special.tunnel = { completed: !result.crashed && !result.timedOut, hits: result.hits + result.contacts, crashed: result.crashed, penetrations: result.penetrations, hitIds: result.hitIds, length: round(length, 1) };
    runs.push({ ...result, kind: 'tunnel centreline', target: 'test:mesh', expect: 'clear', passedThrough: false });
  }

  async function kiteRuns(fixture) {
    const record = colliders.get(fixture.strings[0]);
    const y = fixture.laneStart.y;
    let misses = 0;
    let expected = 0;
    let crashes = 0;
    let hits = 0;
    for (const speed of SPEEDS) {
      done++;
      progress('Kite strings', `jet at ${speed} m/s through ${fixture.strings.length} strings`);
      const start = new THREE.Vector3(fixture.laneStart.x - 200, y, fixture.laneStart.z);
      const direction = new THREE.Vector3(1, 0, 0);
      const result = await flyRun({ craft: 'jet', speed, start, direction, aim: new THREE.Vector3(fixture.laneStart.x + 80 + KITE_STRINGS * 60, y, fixture.laneStart.z), beyond: 100 });
      expected += fixture.strings.length;
      misses += new Set(result.sensors.filter((entry) => entry.endsWith(':kiteString'))).size;
      if (result.crashed) crashes++;
      hits += result.hits + result.contacts;
      runs.push({ ...result, kind: 'kite strings', target: record ? record.id : 'none', expect: 'sensor', passedThrough: false });
    }
    special.kite = { misses, expected, crashes, hits };
  }

  async function realModelRuns(fixture) {
    for (const [craft, targetId, kind] of [['bushplane', 'test:box', 'box'], ['jet', 'test:mesh', 'mesh']]) {
      done++;
      progress('Real flight model', `${craft} at cruise into the ${kind}`);
      const module = ctx.craftRegistry.get(craft);
      const speed = module.spawn.cruise;
      const target = fixture.targets.find((entry) => entry.id === targetId && !entry.dive);
      const approach = approachFor({ ...target, aim: target.aim }, speed);
      if (!approach) {
        harnessErrors.push(`no clear real-model approach to ${kind}`);
        continue;
      }
      // Level flight at cruise: the model flies itself (assists hold it level).
      const level = new THREE.Vector3(approach.direction.x, 0, approach.direction.z).normalize();
      const start = approach.aim.clone().addScaledVector(level, -Math.max(250, speed * 3));
      const result = await flyRun({ craft, speed, start, direction: level, aim: approach.aim, kinematic: false, beyond: 80 });
      runs.push({ ...result, kind, target: targetId, expect: 'crash', model: 'real', passedThrough: !result.crashed && !result.timedOut });
    }
  }

  /** The single-core check: three-mesh-bvh imported by this module builds over the game's geometry. */
  function checkSingleCore() {
    const geometry = new ctx.THREE.BoxGeometry(10, 10, 10);
    const bvh = new MeshBVH(geometry);
    const ray = new ctx.THREE.Ray(new ctx.THREE.Vector3(0, 0, -50), new ctx.THREE.Vector3(0, 0, 1));
    const hit = bvh.raycastFirst(ray, ctx.THREE.DoubleSide);
    const tunnelHit = tunnel ? tunnel.collider.bvh.raycastFirst(new ctx.THREE.Ray(new ctx.THREE.Vector3(0, TUNNEL_OUTER * 3, 0), new ctx.THREE.Vector3(0, -1, 0)), ctx.THREE.DoubleSide) : null;
    singleCore = Boolean(hit && hit.point instanceof ctx.THREE.Vector3 && Math.abs(hit.distance - 45) < 1e-6 && (tunnelHit === null || tunnelHit.point instanceof ctx.THREE.Vector3));
    special.core = { hitDistance: hit ? round(hit.distance, 4) : null, vectorClass: hit ? hit.point.constructor.name : null, revision: ctx.THREE.REVISION };
    geometry.dispose();
  }

  // ---- The run --------------------------------------------------------------------------------------
  function teardownFixture() {
    colliders.removeOwner(FIXTURE_OWNER);
    for (const object of fixtureObjects) scene.remove(object);
    for (const geometry of fixtureGeometries) geometry.dispose();
    for (const material of fixtureMaterials) material.dispose();
    if (tunnel) tunnel.collider.dispose();
    fixtureObjects.length = 0;
  }

  async function run() {
    colliders.profile(true);
    settings.set('timeFrozen', true);
    ctx.systems.spawns.debug.holdGamePresets();
    const crafts = STRIKE_CRAFT.filter((id) => ctx.craftRegistry.has(id));
    const fixture = buildFixture();
    total = fixture.targets.length * crafts.length * SPEEDS.length + (LANDMARK_TYPES.length + STRUCTURE_PRESETS.length) * crafts.length * SPEEDS.length + SPEEDS.length + 5;
    if (!crafts.includes('spaceplane')) special.notes = ['the spaceplane is not registered yet (wave 2): its strike runs join automatically once it is'];
    checkSingleCore();
    phase = 'fixture';
    for (const target of fixture.targets) await strikeRuns(target, crafts);
    await bumpRun();
    await tunnelRun();
    await kiteRuns(fixture);
    await realModelRuns(fixture);
    teardownFixture();
    await landmarkRuns(crafts);
    await structureRuns(crafts);
    ctx.systems.spawns.debug.releaseGamePresets();
  }

  function showSummary() {
    publish();
    const list = report.criteria;
    panel.showSummary({
      result: report.result,
      subtitle: `${ctx.backend}, seed ${state.seed}, ${runs.length} runs`,
      meta: [['Backend', ctx.backend], ['Runs', String(runs.length)], ['Sweeps', String(report.colliderStats.sweeps)], ['Sweep time', `${report.colliderStats.ms ?? '-'} ms`]],
      criteria: list,
      sections: [
        {
          title: 'Per target type',
          table: {
            columns: [
              { key: 'kind', label: 'Target' },
              { key: 'crafts', label: 'Craft' },
              { key: 'speeds', label: 'm/s' },
              { key: 'runs', label: 'Runs', numeric: true },
              { key: 'crashes', label: 'Strikes', numeric: true },
              { key: 'through', label: 'Through', numeric: true },
              { key: 'penetrations', label: 'Inside', numeric: true },
              { key: 'impact', label: 'Max impact', numeric: true },
            ],
            rows: report.types.map((row) => ({ ...row, through: { text: row.through, status: row.through === 0 ? 'pass' : 'fail' }, penetrations: { text: row.penetrations, status: row.penetrations === 0 ? 'pass' : 'fail' } })),
          },
        },
        ...(capture.entries.length > 0 ? [{ title: 'Console errors and warnings', notes: capture.entries.slice(0, 30).map((entry) => `[${entry.level}] ${entry.context}: ${entry.text}`) }] : []),
        ...(harnessErrors.length > 0 ? [{ title: 'Harness problems', notes: harnessErrors.slice() }] : []),
        ...(special.notes ? [{ title: 'Notes', notes: special.notes }] : []),
      ],
      report,
      filename: `driftwing-collision-test-${ctx.backend.toLowerCase()}.json`,
      actions: [{ label: 'Run again', onClick: () => window.location.reload() }],
    });
  }

  function finish() {
    status = 'complete';
    finishedAt = new Date().toISOString();
    phase = 'complete';
    step = '';
    capture.setContext('collision complete');
    showSummary();
  }

  function abort(error) {
    const message = `collision test stopped during ${phase} (${step}): ${error && error.message ? error.message : error}`;
    harnessErrors.push(message);
    console.error(`[DRIFTWING test] ${message}`, error);
    teardownFixture();
    finish();
  }

  bus.on('game:ready', () => {
    publish();
    run().then(finish, abort);
  });
  panel.setProgress({ label: 'Collision test', detail: 'waiting for the game', fraction: 0 });

  return {
    update() {
      const waiters = frameWaiters.splice(0, frameWaiters.length);
      for (const resolve of waiters) resolve();
    },
    getReport() {
      return report;
    },
  };
}

/** A convex hull's display geometry (fan triangles over the hull's points), for the fixture only. */
function convexDisplayGeometry(THREE, points) {
  const geometry = new THREE.BufferGeometry();
  const positions = [];
  const count = points.length;
  // Every triangle whose plane has all points on one side is a hull face (24 points: cheap enough).
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      for (let c = b + 1; c < count; c++) {
        const normal = new THREE.Vector3().subVectors(points[b], points[a]).cross(new THREE.Vector3().subVectors(points[c], points[a]));
        if (normal.lengthSq() < 1e-9) continue;
        let above = 0;
        let below = 0;
        for (let d = 0; d < count; d++) {
          const side = normal.dot(new THREE.Vector3().subVectors(points[d], points[a]));
          if (side > 1e-6) above++;
          else if (side < -1e-6) below++;
        }
        if (above > 0 && below > 0) continue;
        const [first, second] = below === 0 && above > 0 ? [points[c], points[b]] : [points[b], points[c]];
        positions.push(points[a].x, points[a].y, points[a].z, first.x, first.y, first.z, second.x, second.y, second.z);
      }
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
