import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { clamp, vectorFromHeading } from '../core/util.js';
import { CONFIG } from '../core/config.js';

/**
 * RING COURSES: a smooth course of glowing low-poly tori laid out ahead of the
 * glider. The path picks lively turns that favour low ground (so it threads
 * valleys), keeps every ring >= 60 m above the rendered ground sampled along the
 * path and above the autopilot's terrain look-ahead floor, limits climbs and
 * dives to moderate grades (so "follow the rings" can fly it), and orients each
 * ring along the path tangent. Pass detection tests the segment flown this frame against
 * the current ring's plane. Sound comes from the audio system's own listeners
 * for ring:passed (pitch rising with streak, panned), ring:missed and
 * rings:finished; calling audio.chime() directly here would suppress those
 * richer cues through its direct-cue guard. Rendering is two InstancedMeshes (solid flat-shaded
 * body + additive halo) sharing one per-instance tint attribute, plus a faint
 * additive "gate film" inside the current ring that flashes when flown through.
 */
export function createRingCourseSystem(ctx) {
  const { THREE: T, TSL: N, scene, state, bus, world, uniforms } = ctx;
  const {
    instancedBufferAttribute, positionWorld, positionLocal, cameraPosition, normalWorld, uniform,
    normalize, dot, abs, pow, length, mix, color, smoothstep, oneMinus, fract,
  } = N;

  const CAPACITY = 24;
  const MIN_RINGS = 3;
  const DEFAULT_RINGS = 10;
  const RING_RADIUS = 16;
  const PASS_RADIUS = RING_RADIUS + 1.5;
  const MISS_DISTANCE_PAST = 150;
  const ABANDON_DISTANCE = 4500;
  const TELEPORT_DISTANCE = 400;
  const CLEARANCE = 60;
  // Courses must be flyable by WREN's autopilot ("follow the rings"), which tracks onto each
  // ring's axis banking up to 40 deg, times its climb / descent (up to 12 deg) to reach the
  // ring's height on arrival, and keeps ~45 m above the terrain on its line to the ring and up
  // to 150 m past it. So: turns up to 14 deg per ring, grades up to 6 % (steeper, <= 15 %, only
  // where terrain ahead demands it, spread over the course), and every ring above
  // that look-ahead floor (sampled to AUTOPILOT_LOOKAHEAD past the ring, with some slack).
  const SPACING_MIN = 320;
  const SPACING_MAX = 420;
  const MAX_TURN = 14;
  const FIRST_TURN = 6;
  const TURN_CANDIDATES = [0, -7, 7, -14, 14];
  const TURN_WANDER = 9;
  const MAX_GRADE = 0.06;
  const MAX_TERRAIN_GRADE = 0.15;
  const ENTRY_MAX_GRADE = 0.12;
  const ENTRY_STRETCH = [1, 1.5, 2, 2.6, 3.3];
  const ALTITUDE_WAVE = 22;
  const AUTOPILOT_LOOKAHEAD = 220;
  const AUTOPILOT_FLOOR_CLEARANCE = 58;
  const LOOKAHEAD_SAMPLES = 9;
  const INTRO_SECONDS = 0.55;
  const PASSED_SECONDS = 1.1;
  const MISSED_SECONDS = 1.6;
  const RETIRE_SECONDS = 0.7;
  const GATE_FLASH_SECONDS = 0.45;

  const TINTS = {
    current: new T.Color(0xffb13d),
    upcoming: new T.Color(0x5cc8dc),
    passed: new T.Color(0xffd98a),
    missed: new T.Color(0x9a8cc0),
  };

  // ---- Materials: one tint attribute (rgb = linear tint, a = glow intensity) ----------
  const tintArray = new Float32Array(CAPACITY * 4);
  const tintAttribute = new T.InstancedBufferAttribute(tintArray, 4);
  tintAttribute.setUsage(T.DynamicDrawUsage);
  const tint = instancedBufferAttribute(tintAttribute);

  const bodyMaterial = new T.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.42, metalness: 0.1 });
  bodyMaterial.colorNode = mix(color(0xf3e6d0), tint.rgb, 0.5);
  bodyMaterial.emissiveNode = tint.rgb.mul(tint.w);

  const haloMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    fog: false,
  });
  const viewDirection = normalize(cameraPosition.sub(positionWorld));
  const facing = pow(abs(dot(normalWorld, viewDirection)), 2.2);
  const distanceFade = oneMinus(smoothstep(1300, 3400, length(cameraPosition.sub(positionWorld))));
  haloMaterial.colorNode = tint.rgb.mul(1.3);
  haloMaterial.opacityNode = facing.mul(tint.w.mul(0.22).clamp(0, 1)).mul(distanceFade);

  // Gate film: a faint additive disc inside the current ring with ripples drawn inward.
  const gateStrength = uniform(0);
  const gateColor = uniform(new T.Color(0xffc86a));
  const gateMaterial = new T.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.AdditiveBlending,
    side: T.DoubleSide,
    forceSinglePass: true,
    fog: false,
  });
  const gateRadial = length(positionLocal.xy).div(RING_RADIUS - 0.6);
  const gateRim = smoothstep(0.35, 1, gateRadial);
  const ripplePhase = fract(gateRadial.mul(2.2).add(uniforms.time.mul(0.85)));
  const ripple = smoothstep(0, 0.12, ripplePhase).mul(oneMinus(smoothstep(0.12, 0.45, ripplePhase))).mul(gateRadial);
  gateMaterial.colorNode = gateColor.mul(1.4);
  gateMaterial.opacityNode = gateRim.mul(0.32).add(ripple.mul(0.26)).mul(gateStrength);
  const gateMesh = new T.Mesh(new T.CircleGeometry(RING_RADIUS - 0.6, 48), gateMaterial);
  gateMesh.name = 'ring-course-gate';
  gateMesh.renderOrder = 3;
  gateMesh.visible = false;
  const gate = { flashIndex: -1, flashAge: GATE_FLASH_SECONDS };
  const lastCrossing = { index: -1, offset: 0, vertical: 0, result: 'none' };

  const bodyMesh = new T.InstancedMesh(new T.TorusGeometry(RING_RADIUS, 1.3, 5, 22), bodyMaterial, CAPACITY);
  const haloMesh = new T.InstancedMesh(new T.TorusGeometry(RING_RADIUS, 3.8, 8, 40), haloMaterial, CAPACITY);
  const courseBounds = new T.Sphere(new T.Vector3(), 1);
  for (const mesh of [bodyMesh, haloMesh]) {
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    mesh.boundingSphere = courseBounds;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.visible = false;
    mesh.count = 0;
  }
  bodyMesh.name = 'ring-course-bodies';
  haloMesh.name = 'ring-course-halos';
  haloMesh.renderOrder = 3;
  scene.add(bodyMesh, haloMesh, gateMesh);
  // First shown long after boot: let core compile their pipelines behind the loading fade.
  for (const mesh of [bodyMesh, haloMesh, gateMesh]) ctx.registerPrewarm?.(mesh);

  // ---- Course state -----------------------------------------------------------------------------
  const rings = Array.from({ length: CAPACITY }, () => ({
    center: new T.Vector3(),
    normal: new T.Vector3(),
    quaternion: new T.Quaternion(),
    status: 'hidden',
    age: 0,
  }));
  const course = {
    active: false,
    total: 0,
    passed: 0,
    missed: 0,
    streak: 0,
    bestStreak: 0,
    elapsed: 0,
    nextIndex: 0,
    age: 0,
    visible: false,
  };
  const origin = new T.Vector3();
  const previousPosition = new T.Vector3().copy(state.player.position);
  const nextRingPosition = { x: 0, y: 0, z: 0 };
  const nextRingNormal = { x: 0, y: 0, z: 1 };
  const forwardZ = new T.Vector3(0, 0, 1);
  const scratchDirection = new T.Vector3();
  const scratchSide = new T.Vector3();
  const scratchPosition = new T.Vector3();
  const scratchScale = new T.Vector3();
  const scratchMatrix = new T.Matrix4();
  const scratchHit = new T.Vector3();
  const scratchOffset = new T.Vector3();

  const ringCourse = state.ringCourse;
  Object.assign(ringCourse, {
    active: false,
    total: 0,
    passed: 0,
    missed: 0,
    streak: 0,
    bestStreak: 0,
    elapsed: 0,
    nextIndex: 0,
    nextRingPosition: null,
    nextRingNormal: null,
    nextRingDistance: 0,
  });

  // ---- Course planning ---------------------------------------------------------------------------
  function groundAlong(fromX, fromZ, toX, toZ, samples) {
    let highest = CONFIG.WATER_LEVEL;
    for (let step = 1; step <= samples; step++) {
      const t = step / samples;
      highest = Math.max(highest, world.heightAt(fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t));
    }
    return highest;
  }

  /** Rendered ground (world.groundHeight) at the ring and under both sides of it. */
  function groundAroundRing(x, z, headingDegrees) {
    const side = vectorFromHeading(headingDegrees + 90, scratchSide);
    const reach = RING_RADIUS * 1.6;
    return Math.max(
      world.groundHeight(x, z),
      world.groundHeight(x + side.x * reach, z + side.z * reach),
      world.groundHeight(x - side.x * reach, z - side.z * reach),
      CONFIG.WATER_LEVEL,
    );
  }

  /** Highest terrain the autopilot will see ahead while it homes on a ring along this direction. */
  function groundAhead(x, z, direction, from, to) {
    let highest = CONFIG.WATER_LEVEL;
    for (let sample = 0; sample < LOOKAHEAD_SAMPLES; sample++) {
      const distance = from + ((to - from) * sample) / (LOOKAHEAD_SAMPLES - 1);
      highest = Math.max(highest, world.heightAt(x + direction.x * distance, z + direction.z * distance));
    }
    return highest;
  }

  /** A ring `spacing` metres from (x, z) along `candidateHeading`, with its terrain floor. */
  function placeCandidate(x, z, candidateHeading, spacing) {
    const direction = vectorFromHeading(candidateHeading, scratchDirection);
    const endX = x + direction.x * spacing;
    const endZ = z + direction.z * spacing;
    const alongSamples = Math.max(6, Math.round(spacing / 60));
    const local = Math.max(groundAlong(x, z, endX, endZ, alongSamples), groundAroundRing(endX, endZ, candidateHeading));
    const ahead = groundAhead(x, z, direction, spacing, spacing + AUTOPILOT_LOOKAHEAD);
    return { x: endX, z: endZ, ground: local, floor: Math.max(local + CLEARANCE, ahead + AUTOPILOT_FLOOR_CLEARANCE), spacing };
  }

  /**
   * The first ring moves farther out (up to the last ENTRY_STRETCH factor) until the climb to
   * it from the glider's altitude is <= ENTRY_MAX_GRADE: starting low near rising ground, a
   * ring 60 m over the ridge ahead would otherwise be out of reach.
   */
  function placeFirstCandidate(x, z, candidateHeading, spacing, startAltitude) {
    let placement = null;
    for (const stretch of ENTRY_STRETCH) {
      placement = placeCandidate(x, z, candidateHeading, spacing * stretch);
      if ((placement.floor - startAltitude) / placement.spacing <= ENTRY_MAX_GRADE) break;
    }
    return placement;
  }

  function planHeadings(total) {
    const player = state.player;
    const startAltitude = player.position.y;
    const plan = [];
    let heading = player.heading;
    let x = player.position.x;
    let z = player.position.z;
    let wander = 0;
    for (let index = 0; index < total; index++) {
      const first = index === 0;
      const spacing = first ? 340 + Math.random() * 60 : SPACING_MIN + Math.random() * (SPACING_MAX - SPACING_MIN);
      wander = wander * 0.7 + (Math.random() * 2 - 1) * TURN_WANDER;
      const turnLimit = first ? FIRST_TURN : MAX_TURN;
      let best = null;
      for (const offset of TURN_CANDIDATES) {
        const turn = clamp(wander + offset, -turnLimit, turnLimit);
        const candidateHeading = heading + turn;
        const placement = first
          ? placeFirstCandidate(x, z, candidateHeading, spacing, startAltitude)
          : placeCandidate(x, z, candidateHeading, spacing);
        const steepEntry = first ? Math.max(0, (placement.floor - startAltitude) / placement.spacing - ENTRY_MAX_GRADE) : 0;
        const score = placement.floor + Math.abs(turn) * 2.5 + Math.abs(turn - wander) * 1.5 + steepEntry * 2000;
        if (!best || score < best.score) best = { score, heading: candidateHeading, ...placement, y: 0 };
      }
      heading = best.heading;
      x = best.x;
      z = best.z;
      plan.push(best);
    }
    return plan;
  }

  /**
   * The grade the course may use: MAX_GRADE, steepened (up to MAX_TERRAIN_GRADE) only as much
   * as terrain ahead demands, measured from the glider's entry altitude so that the climb to a
   * high ring later in the course is spread over the whole course, entry leg included.
   */
  function courseGrade(plan, startAltitude) {
    let travelled = 0;
    let required = MAX_GRADE;
    for (const entry of plan) {
      travelled += entry.spacing;
      required = Math.max(required, (entry.floor - startAltitude) / travelled);
    }
    return Math.min(required, MAX_TERRAIN_GRADE);
  }

  /** Altitudes: a rolling wave near the entry altitude, never under the floor, grades <= courseGrade (entry leg included). */
  function planAltitudes(plan) {
    const startAltitude = state.player.position.y;
    const wavePhase = Math.random() * Math.PI * 2;
    // Courses stay in the low, scenic band every craft reaches comfortably (v1's ceiling, 2600 m).
    const ceiling = CONFIG.MAX_ALTITUDE - 300;
    const grade = courseGrade(plan, startAltitude);
    for (let index = 0; index < plan.length; index++) {
      const entry = plan[index];
      const wave = ALTITUDE_WAVE * Math.sin(index * 0.9 + wavePhase) + (Math.random() - 0.5) * 10;
      const target = startAltitude + wave;
      entry.y = Math.max(target, entry.floor);
    }
    const first = plan[0];
    first.y = Math.max(first.floor, startAltitude);
    for (let index = 1; index < plan.length; index++) {
      const entry = plan[index];
      const previous = plan[index - 1];
      const band = entry.spacing * grade;
      entry.y = Math.max(entry.floor, clamp(entry.y, previous.y - band, previous.y + band));
    }
    // Raise earlier rings toward later high ones, but never above what the glider can reach
    // from its entry at `grade` (or the ring's own floor): if the terrain demands more, the
    // steep leg stays next to that terrain instead of turning the first rings into a wall.
    let travelled = 0;
    const reachable = plan.map((entry) => {
      travelled += entry.spacing;
      return startAltitude + travelled * grade;
    });
    for (let index = plan.length - 2; index >= 0; index--) {
      const entry = plan[index];
      const needed = plan[index + 1].y - plan[index + 1].spacing * grade;
      entry.y = Math.max(entry.y, Math.min(needed, Math.max(reachable[index], entry.floor)));
    }
    for (const entry of plan) entry.y = Math.min(entry.y, ceiling);
  }

  function buildCourse(plan) {
    const total = plan.length;
    origin.set(plan[0].x, plan[0].y, plan[0].z);
    for (let index = 0; index < total; index++) {
      const ring = rings[index];
      ring.center.set(plan[index].x, plan[index].y, plan[index].z);
    }
    let radius = 0;
    scratchOffset.set(0, 0, 0);
    for (let index = 0; index < total; index++) {
      const ring = rings[index];
      if (index === 0) scratchPosition.copy(state.player.position);
      else scratchPosition.copy(rings[index - 1].center);
      if (index === total - 1) scratchDirection.subVectors(ring.center, rings[index - 1].center).add(ring.center);
      else scratchDirection.copy(rings[index + 1].center);
      ring.normal.subVectors(scratchDirection, scratchPosition).normalize();
      ring.quaternion.setFromUnitVectors(forwardZ, ring.normal);
      ring.status = index === 0 ? 'current' : 'upcoming';
      ring.age = 0;
      scratchOffset.add(ring.center);
    }
    scratchOffset.divideScalar(total).sub(origin);
    for (let index = 0; index < total; index++) {
      scratchPosition.subVectors(rings[index].center, origin);
      radius = Math.max(radius, scratchPosition.distanceTo(scratchOffset));
    }
    courseBounds.center.copy(scratchOffset);
    courseBounds.radius = radius + RING_RADIUS * 2;
    for (let index = total; index < CAPACITY; index++) rings[index].status = 'hidden';
    bodyMesh.position.copy(origin);
    haloMesh.position.copy(origin);
    bodyMesh.count = total;
    haloMesh.count = total;
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------
  function resetCounters(total) {
    course.total = total;
    course.passed = 0;
    course.missed = 0;
    course.streak = 0;
    course.bestStreak = 0;
    course.elapsed = 0;
    course.nextIndex = 0;
    course.age = 0;
    gate.flashIndex = -1;
    gate.flashAge = GATE_FLASH_SECONDS;
  }

  function start(options = {}) {
    const requested = Number(options?.count);
    const total = clamp(Math.round(Number.isFinite(requested) ? requested : DEFAULT_RINGS), MIN_RINGS, CAPACITY);
    if (course.active) cancel();
    const plan = planHeadings(total);
    planAltitudes(plan);
    resetCounters(total);
    buildCourse(plan);
    course.active = true;
    course.visible = true;
    previousPosition.copy(state.player.position);
    bus.emit('rings:started', { total });
    writeState();
    return total;
  }

  function retireRemaining(fromIndex) {
    for (let index = fromIndex; index < course.total; index++) {
      const ring = rings[index];
      if (ring.status === 'current' || ring.status === 'upcoming') {
        ring.status = 'retired';
        ring.age = 0;
      }
    }
  }

  function cancel() {
    if (!course.active) return false;
    course.active = false;
    retireRemaining(course.nextIndex);
    writeState();
    bus.emit('rings:cancelled', {});
    return true;
  }

  function finish() {
    course.active = false;
    const time = Math.round(course.elapsed * 10) / 10;
    const result = { time, passed: course.passed, total: course.total, bestStreak: course.bestStreak };
    ctx.systems.journal?.recordRingCourse?.({ ...result });
    writeState();
    bus.emit('rings:finished', result);
  }

  /**
   * Moves to the next ring, publishes state, emits the per-ring event, then
   * finishes the course when that was the last ring (so listeners always see
   * ring:passed / ring:missed before rings:finished, with fresh state).
   */
  function advance(eventType, payload) {
    course.nextIndex++;
    const finished = course.nextIndex >= course.total;
    if (!finished) {
      rings[course.nextIndex].status = 'current';
      rings[course.nextIndex].age = 0;
    }
    writeState();
    bus.emit(eventType, payload);
    if (finished) finish();
  }

  function passRing(index) {
    const ring = rings[index];
    ring.status = 'passed';
    ring.age = 0;
    course.passed++;
    course.streak++;
    course.bestStreak = Math.max(course.bestStreak, course.streak);
    gate.flashIndex = index;
    gate.flashAge = 0;
    advance('ring:passed', {
      index,
      streak: course.streak,
      position: { x: ring.center.x, y: ring.center.y, z: ring.center.z },
    });
  }

  function missRing(index) {
    const ring = rings[index];
    ring.status = 'missed';
    ring.age = 0;
    course.missed++;
    course.streak = 0;
    advance('ring:missed', { index });
  }

  /** Tests the segment flown this frame against the current ring's plane. */
  function detectPass(from, to) {
    const index = course.nextIndex;
    const ring = rings[index];
    const before = scratchOffset.subVectors(from, ring.center).dot(ring.normal);
    const after = scratchPosition.subVectors(to, ring.center).dot(ring.normal);
    if (before < 0 && after >= 0) {
      const t = before / (before - after);
      scratchHit.lerpVectors(from, to, t);
      const offset = scratchHit.distanceTo(ring.center);
      lastCrossing.index = index;
      lastCrossing.offset = Math.round(offset * 10) / 10;
      lastCrossing.vertical = Math.round((scratchHit.y - ring.center.y) * 10) / 10;
      lastCrossing.result = offset <= PASS_RADIUS ? 'passed' : 'missed';
      if (offset <= PASS_RADIUS) passRing(index);
      else missRing(index);
      return;
    }
    if (after > MISS_DISTANCE_PAST) {
      lastCrossing.index = index;
      lastCrossing.result = 'overshot';
      missRing(index);
      return;
    }
    if (to.distanceTo(ring.center) > ABANDON_DISTANCE) {
      cancel();
    }
  }

  // ---- Visuals ---------------------------------------------------------------------------------------
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function easeInCubic(t) {
    return t * t * t;
  }

  function easeOutBack(t) {
    const overshoot = 1.70158;
    const shifted = t - 1;
    return 1 + (overshoot + 1) * shifted * shifted * shifted + overshoot * shifted * shifted;
  }

  /** Writes tint + returns scale for one ring. */
  function styleRing(ring, index, time, out) {
    let tintColor = TINTS.upcoming;
    let intensity = 0.45;
    let scale = 1;
    switch (ring.status) {
      case 'current': {
        const pulse = 0.5 + 0.5 * Math.sin(time * 4.2);
        tintColor = TINTS.current;
        intensity = 0.95 + 0.75 * pulse;
        scale = 1 + 0.03 * pulse;
        break;
      }
      case 'upcoming':
        intensity = index === course.nextIndex + 1 ? 0.75 : 0.5;
        break;
      case 'passed': {
        const progress = ring.age / PASSED_SECONDS;
        tintColor = TINTS.passed;
        intensity = 3.6 * Math.exp(-ring.age * 2.6) + 0.3;
        scale = progress < 0.68
          ? 1 + 0.4 * easeOutCubic(progress / 0.68)
          : 1.4 * (1 - easeInCubic(Math.min(1, (progress - 0.68) / 0.32)));
        if (progress >= 1) ring.status = 'hidden';
        break;
      }
      case 'missed': {
        const progress = ring.age / MISSED_SECONDS;
        tintColor = TINTS.missed;
        intensity = 0.35 * (1 - progress);
        scale = 1 - easeInCubic(Math.min(1, progress));
        if (progress >= 1) ring.status = 'hidden';
        break;
      }
      case 'retired': {
        const progress = ring.age / RETIRE_SECONDS;
        intensity = 0.6 * (1 - progress);
        scale = 1 - easeInCubic(Math.min(1, progress));
        if (progress >= 1) ring.status = 'hidden';
        break;
      }
      default:
        scale = 0;
        intensity = 0;
    }
    if (ring.status === 'hidden') scale = 0;
    const intro = clamp((course.age - index * 0.07) / INTRO_SECONDS, 0, 1);
    scale *= intro >= 1 ? 1 : Math.max(0, easeOutBack(intro));
    const offset = index * 4;
    tintArray[offset] = tintColor.r;
    tintArray[offset + 1] = tintColor.g;
    tintArray[offset + 2] = tintColor.b;
    tintArray[offset + 3] = intensity;
    out.setScalar(Math.max(scale, 0));
    return scale > 0.0001;
  }

  function updateVisuals(dt) {
    course.age += dt;
    const time = state.time.elapsed;
    let anyVisible = false;
    for (let index = 0; index < course.total; index++) {
      const ring = rings[index];
      ring.age += dt;
      const visible = styleRing(ring, index, time, scratchScale);
      anyVisible = anyVisible || visible;
      scratchPosition.subVectors(ring.center, origin);
      scratchMatrix.compose(scratchPosition, ring.quaternion, scratchScale);
      bodyMesh.setMatrixAt(index, scratchMatrix);
      haloMesh.setMatrixAt(index, scratchMatrix);
    }
    bodyMesh.instanceMatrix.needsUpdate = true;
    haloMesh.instanceMatrix.needsUpdate = true;
    tintAttribute.needsUpdate = true;
    updateGate(dt, time);
    course.visible = anyVisible || course.active || gateMesh.visible;
    bodyMesh.visible = course.visible;
    haloMesh.visible = course.visible;
  }

  /** The gate film sits in the current ring; on a pass it flashes in the ring just flown through. */
  function updateGate(dt, time) {
    gate.flashAge += dt;
    let ring = null;
    let strength = 0;
    if (gate.flashAge < GATE_FLASH_SECONDS && gate.flashIndex >= 0) {
      ring = rings[gate.flashIndex];
      strength = 1.8 * (1 - gate.flashAge / GATE_FLASH_SECONDS);
    } else if (course.active) {
      ring = rings[course.nextIndex];
      const intro = clamp((course.age - course.nextIndex * 0.07 - INTRO_SECONDS * 0.5) / INTRO_SECONDS, 0, 1);
      strength = intro * (0.45 + 0.25 * (0.5 + 0.5 * Math.sin(time * 4.2)));
    }
    gateMesh.visible = ring !== null && strength > 0.001;
    if (!gateMesh.visible) return;
    gateMesh.position.copy(ring.center);
    gateMesh.quaternion.copy(ring.quaternion);
    gateStrength.value = strength;
  }

  function writeState() {
    ringCourse.active = course.active;
    ringCourse.total = course.total;
    ringCourse.passed = course.passed;
    ringCourse.missed = course.missed;
    ringCourse.streak = course.streak;
    ringCourse.bestStreak = course.bestStreak;
    ringCourse.elapsed = course.elapsed;
    ringCourse.nextIndex = course.nextIndex;
    if (course.active && course.nextIndex < course.total) {
      const center = rings[course.nextIndex].center;
      nextRingPosition.x = center.x;
      nextRingPosition.y = center.y;
      nextRingPosition.z = center.z;
      ringCourse.nextRingPosition = nextRingPosition;
      // The ring's facing (its axis, along the course): the autopilot tracks onto this line.
      const normal = rings[course.nextIndex].normal;
      nextRingNormal.x = normal.x;
      nextRingNormal.y = normal.y;
      nextRingNormal.z = normal.z;
      ringCourse.nextRingNormal = nextRingNormal;
      ringCourse.nextRingDistance = state.player.position.distanceTo(center);
    } else {
      ringCourse.nextRingPosition = null;
      ringCourse.nextRingNormal = null;
      ringCourse.nextRingDistance = 0;
    }
  }

  return {
    update(dt) {
      const player = state.player.position;
      if (course.active && dt > 0) {
        course.elapsed += dt;
        if (previousPosition.distanceTo(player) < TELEPORT_DISTANCE) detectPass(previousPosition, player);
      }
      previousPosition.copy(player);
      if (course.visible) updateVisuals(dt);
      writeState();
    },
    start,
    cancel,
    isActive() {
      return course.active;
    },
    getStats() {
      return { active: course.active, total: course.total, visible: course.visible, nextIndex: course.nextIndex, lastCrossing: { ...lastCrossing } };
    },
  };
}
