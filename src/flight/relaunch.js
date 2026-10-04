// Relaunch helpers: the nearest high peak (wingsuit launches), a peak launch pose, and the aerotow:
// a tug (the bush plane mesh) tows the craft on a visible rope in a brisk, time-compressed climb to
// release height, releases, banks away and is removed.
import * as THREE from 'three/webgpu';
import { DEG, clamp, vectorFromHeading, headingFromVector, wrapDegrees } from '../core/util.js';

// ============================================================================================
// PEAKS
// ============================================================================================
const PEAK = Object.freeze({
  /** A "high" peak stands at least this high above sea level and this far above the start ground. */
  MIN_HEIGHT: 420,
  MIN_RISE: 250,
  RING_STEP: 300,
  SAMPLE_SPACING: 250,
  MAX_RADIUS: 16000,
  CLIMB_STEPS: Object.freeze([80, 40, 20, 10]),
  CLIMB_ITERATIONS: 80,
  LAUNCH_HEIGHT: 35,
  DOWNHILL_PROBE: 180,
  /** Dive launches: the edge is where the ground has dropped EDGE_DROP below the summit (within EDGE_MAX). */
  EDGE_STEP: 10,
  EDGE_MAX: 140,
  EDGE_DROP: 12,
  DIVE_PROBE_STEP: 20,
  DIVE_PROBE_DISTANCE: 400,
  DIVE_CLEARANCE: 25,
});

/** Walks uphill on heightAt from (x, z) to the local summit. */
function climbToSummit(world, x, z) {
  let bestX = x;
  let bestZ = z;
  let bestHeight = world.heightAt(x, z);
  for (const step of PEAK.CLIMB_STEPS) {
    for (let iteration = 0; iteration < PEAK.CLIMB_ITERATIONS; iteration++) {
      let improved = false;
      let nextX = bestX;
      let nextZ = bestZ;
      let nextHeight = bestHeight;
      for (let direction = 0; direction < 8; direction++) {
        const angle = (direction / 8) * Math.PI * 2;
        const probeX = bestX + Math.cos(angle) * step;
        const probeZ = bestZ + Math.sin(angle) * step;
        const height = world.heightAt(probeX, probeZ);
        if (height > nextHeight) {
          nextX = probeX;
          nextZ = probeZ;
          nextHeight = height;
          improved = true;
        }
      }
      if (!improved) break;
      bestX = nextX;
      bestZ = nextZ;
      bestHeight = nextHeight;
    }
  }
  return { x: bestX, z: bestZ, height: bestHeight };
}

/**
 * The nearest high peak to (x, z): searches outward in rings on the shared height function, climbs
 * each promising sample to its summit and returns the closest summit that is high enough
 * ({ x, z, height, distance }). Falls back to the highest summit found, or null on flat worlds.
 * options.waterHeight(x, z): the water surface (the shared water query; a flat sea at
 * world.WATER_LEVEL without it).
 */
export function findNearestPeak(world, x, z, options = {}) {
  const water = typeof options.waterHeight === 'function' ? options.waterHeight(x, z) : world.WATER_LEVEL ?? 0;
  const startGround = Math.max(world.heightAt(x, z), water);
  const threshold = Math.max(options.minHeight ?? PEAK.MIN_HEIGHT, startGround + (options.minRise ?? PEAK.MIN_RISE));
  const maxRadius = options.maxRadius ?? PEAK.MAX_RADIUS;
  let highest = null;
  for (let radius = PEAK.RING_STEP; radius <= maxRadius; radius += PEAK.RING_STEP) {
    const samples = Math.max(16, Math.ceil((2 * Math.PI * radius) / PEAK.SAMPLE_SPACING));
    let ringBest = null;
    for (let sample = 0; sample < samples; sample++) {
      const angle = (sample / samples) * Math.PI * 2;
      const sampleX = x + Math.cos(angle) * radius;
      const sampleZ = z + Math.sin(angle) * radius;
      if (world.heightAt(sampleX, sampleZ) < threshold * 0.75) continue;
      const summit = climbToSummit(world, sampleX, sampleZ);
      const distance = Math.hypot(summit.x - x, summit.z - z);
      if (!highest || summit.height > highest.height) highest = { ...summit, distance };
      if (summit.height < threshold) continue;
      if (!ringBest || distance < ringBest.distance) ringBest = { ...summit, distance };
    }
    if (ringBest) return ringBest;
  }
  return highest && highest.height > startGround + 100 ? highest : null;
}

/**
 * Launch pose over a summit: just above it, facing the steepest way down. With options.diveAngle
 * (degrees) the launch moves out to the edge of the summit (where the ground has started to fall
 * away) and also returns `pitch` (degrees, negative = nose down): the dive angle, made shallower where
 * the slope below would not clear a straight dive by DIVE_CLEARANCE.
 */
export function planPeakLaunch(world, peak, options = {}) {
  let heading = 0;
  let lowest = Infinity;
  for (let direction = 0; direction < 16; direction++) {
    const candidate = direction * 22.5;
    const forward = vectorFromHeading(candidate);
    const height = world.heightAt(peak.x + forward.x * PEAK.DOWNHILL_PROBE, peak.z + forward.z * PEAK.DOWNHILL_PROBE);
    if (height < lowest) {
      lowest = height;
      heading = candidate;
    }
  }
  const ground = Math.max(world.groundHeight(peak.x, peak.z), peak.height);
  if (!Number.isFinite(options.diveAngle)) return { position: new THREE.Vector3(peak.x, ground + PEAK.LAUNCH_HEIGHT, peak.z), heading };
  const waterHeight = typeof options.waterHeight === 'function' ? options.waterHeight : () => world.WATER_LEVEL ?? -Infinity;
  return planDive(world, peak, heading, ground, options.diveAngle, waterHeight);
}

/** The edge of the summit along `heading` and the steepest dive (up to diveAngle) that clears the slope. */
function planDive(world, peak, heading, summitGround, diveAngle, waterHeight) {
  const forward = vectorFromHeading(heading);
  let edge = 0;
  for (let distance = PEAK.EDGE_STEP; distance <= PEAK.EDGE_MAX; distance += PEAK.EDGE_STEP) {
    edge = distance;
    if (world.heightAt(peak.x + forward.x * distance, peak.z + forward.z * distance) < summitGround - PEAK.EDGE_DROP) break;
  }
  const x = peak.x + forward.x * edge;
  const z = peak.z + forward.z * edge;
  const startY = Math.max(world.groundHeight(x, z), waterHeight(x, z)) + PEAK.LAUNCH_HEIGHT;
  // Steepest straight path that stays DIVE_CLEARANCE above the ground ahead.
  let slope = Math.tan(diveAngle * DEG);
  for (let distance = PEAK.DIVE_PROBE_STEP; distance <= PEAK.DIVE_PROBE_DISTANCE; distance += PEAK.DIVE_PROBE_STEP) {
    const probeX = x + forward.x * distance;
    const probeZ = z + forward.z * distance;
    const ground = Math.max(world.groundHeight(probeX, probeZ), waterHeight(probeX, probeZ));
    slope = Math.min(slope, (startY - ground - PEAK.DIVE_CLEARANCE) / distance);
  }
  const pitch = -Math.atan(Math.max(0, slope)) / DEG;
  return { position: new THREE.Vector3(x, startY, z), heading, pitch };
}

// ============================================================================================
// AEROTOW
// ============================================================================================
const TOW = Object.freeze({
  SAMPLES: 360,
  /** Tow duration: a brisk climb, never more than about 10 s. */
  BASE_SECONDS: 2.5,
  SECONDS_PER_METRE: 1 / 110,
  MIN_SECONDS: 4.5,
  MAX_SECONDS: 9.8,
  /** Shares of the tow spent ramping the climb (and speed) in and out. */
  RAMP_IN: 0.22,
  RAMP_OUT: 0.28,
  /** The climb angle the horizontal speed aims for, and its limits (m/s). */
  CLIMB_ANGLE: 40 * DEG,
  MIN_SPEED: 60,
  MAX_SPEED: 150,
  CLEARANCE: 25,
  /** How steeply the path may rise to get over terrain ahead (m per m). */
  OBSTACLE_SLOPE: 0.75,
  SMOOTHING_PASSES: 6,
  /** From the ground (below this height) the pair rolls and lifts off before the climb starts. */
  GROUND_START_AGL: 12,
  TAKEOFF_SECONDS: 1.4,
  ATTITUDE_BLEND_SECONDS: 0.7,
  ROPE_LENGTH: 45,
  ROPE_SAG: 0.9,
  ROPE_RADIUS: 0.1,
  ROPE_RINGS: 14,
  ROPE_SIDES: 5,
  ROPE_DROP_SECONDS: 1.6,
  ROPE_DROP_DISTANCE: 14,
  /** After release the tug banks left, turns away, sinks and is removed. */
  TUG_EXIT_SECONDS: 4.5,
  TUG_TURN_RATE: 16 * DEG,
  TUG_BANK: 38 * DEG,
  TUG_SINK: 3,
  TUG_EXIT_SPEEDUP: 1.12,
  HEADING_CANDIDATES: Object.freeze([0, -25, 25, -50, 50, -90, 90, 180]),
});

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/** The rope's material (v1 orange so it reads against sky and ground); one per controller. */
export function createRopeMaterial() {
  return new THREE.MeshStandardNodeMaterial({ color: 0xe0703a, roughness: 0.75, metalness: 0, flatShading: true });
}

/** A short rope segment for core's pipeline prewarm (so the first tow does not hitch). */
export function createRopeStandIn(material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(TOW.ROPE_RADIUS, TOW.ROPE_RADIUS, 1, TOW.ROPE_SIDES), material);
  mesh.name = 'tow-rope-prewarm';
  mesh.visible = false;
  return mesh;
}

/** Ramp profile 0 -> 1 -> 0 over [0, 1]: smooth rise over rampIn, plateau, smooth fall over rampOut. */
function plateau(u, rampIn, rampOut) {
  if (u < rampIn) return smooth01(u / rampIn);
  if (u > 1 - rampOut) return 1 - smooth01((u - (1 - rampOut)) / rampOut);
  return 1;
}

/**
 * Plans the tow path along a heading: horizontal speed ramps from the start speed to a brisk peak
 * and down to the release speed; the climb rate ramps in and out so the path starts and ends level
 * (from the ground it first rolls and lifts off). The path never descends, and terrain ahead raises
 * it early enough to clear it by TOW.CLEARANCE, rising no steeper than TOW.OBSTACLE_SLOPE.
 * Returns sampled arrays plus how much the terrain forced it up (lower is a clearer heading).
 */
function planTowPath(world, waterHeight, start, heading, startSpeed, releaseSpeed, releaseAgl) {
  const direction = vectorFromHeading(heading);
  const surface = (x, z) => Math.max(world.groundHeight(x, z), waterHeight(x, z));
  const startAgl = Math.max(0, start.y - surface(start.x, start.z));
  const takeoff = startAgl < TOW.GROUND_START_AGL ? TOW.TAKEOFF_SECONDS : 0;
  const climbShare = 1 - 0.5 * TOW.RAMP_IN - 0.5 * TOW.RAMP_OUT;
  // Duration and climb: iterate so the release ground is where the path actually ends.
  let duration = TOW.MAX_SECONDS;
  let climb = 0;
  let horizontalPeak = TOW.MIN_SPEED;
  let distance = 0;
  for (let iteration = 0; iteration < 3; iteration++) {
    const releaseGround = surface(start.x + direction.x * distance, start.z + direction.z * distance);
    climb = Math.max(0, releaseGround + releaseAgl - start.y);
    duration = clamp(TOW.BASE_SECONDS + takeoff + climb * TOW.SECONDS_PER_METRE, TOW.MIN_SECONDS, TOW.MAX_SECONDS);
    const verticalPeak = climb / ((duration - takeoff) * climbShare);
    horizontalPeak = clamp(verticalPeak / Math.tan(TOW.CLIMB_ANGLE), TOW.MIN_SPEED, TOW.MAX_SPEED);
    distance = horizontalPeak * duration * climbShare + 0.5 * (startSpeed * TOW.RAMP_IN + releaseSpeed * TOW.RAMP_OUT) * duration;
  }
  const count = TOW.SAMPLES + 1;
  const time = new Float64Array(count);
  const along = new Float64Array(count);
  const height = new Float64Array(count);
  const horizontal = new Float64Array(count);
  const vertical = new Float64Array(count);
  const climbShape = new Float64Array(count);
  const step = duration / TOW.SAMPLES;
  let distanceSoFar = 0;
  let rise = 0;
  for (let index = 0; index < count; index++) {
    const u = index / TOW.SAMPLES;
    let speed;
    if (u < TOW.RAMP_IN) speed = startSpeed + (horizontalPeak - startSpeed) * smooth01(u / TOW.RAMP_IN);
    else if (u > 1 - TOW.RAMP_OUT) speed = horizontalPeak + (releaseSpeed - horizontalPeak) * smooth01((u - (1 - TOW.RAMP_OUT)) / TOW.RAMP_OUT);
    else speed = horizontalPeak;
    const climbTime = (index * step - takeoff) / (duration - takeoff);
    climbShape[index] = climbTime <= 0 ? 0 : plateau(climbTime, TOW.RAMP_IN, TOW.RAMP_OUT);
    if (index > 0) {
      distanceSoFar += 0.5 * (speed + horizontal[index - 1]) * step;
      rise += 0.5 * (climbShape[index] + climbShape[index - 1]) * step;
    }
    time[index] = index * step;
    along[index] = distanceSoFar;
    horizontal[index] = speed;
  }
  // Scale the climb shape so the nominal path rises by exactly `climb`.
  const climbScale = rise > 0 ? climb / rise : 0;
  const nominal = new Float64Array(count);
  let accumulated = 0;
  for (let index = 0; index < count; index++) {
    if (index > 0) accumulated += 0.5 * (climbShape[index] + climbShape[index - 1]) * step * climbScale;
    nominal[index] = start.y + accumulated;
  }
  // Terrain: the clearance needed at each sample (from the start height above ground up to
  // TOW.CLEARANCE over the first two seconds), carried back along the path at OBSTACLE_SLOPE so the
  // climb starts early; the path takes the higher of that and the nominal climb, and never sinks.
  const required = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const ground = surface(start.x + direction.x * along[index], start.z + direction.z * along[index]);
    const clearance = startAgl >= TOW.CLEARANCE ? TOW.CLEARANCE : startAgl + (TOW.CLEARANCE - startAgl) * smooth01(time[index] / 2);
    required[index] = ground + clearance;
  }
  let envelope = -Infinity;
  for (let index = count - 1; index >= 0; index--) {
    const back = index < count - 1 ? (along[index + 1] - along[index]) * TOW.OBSTACLE_SLOPE : 0;
    envelope = Math.max(required[index], envelope - back);
    height[index] = Math.max(nominal[index], envelope);
  }
  height[0] = start.y;
  for (let index = 1; index < count; index++) height[index] = Math.max(height[index], height[index - 1]);
  // Soften the corners the envelope leaves (the start and end stay put).
  const scratch = new Float64Array(count);
  for (let pass = 0; pass < TOW.SMOOTHING_PASSES; pass++) {
    scratch.set(height);
    for (let index = 1; index < count - 1; index++) height[index] = Math.max(required[index] - TOW.CLEARANCE * 0.4, (scratch[index - 1] + scratch[index] + scratch[index + 1]) / 3);
  }
  let forcedUp = 0;
  for (let index = 0; index < count; index++) {
    forcedUp += Math.max(0, height[index] - nominal[index]) * step * (1 + 3 * (1 - index / TOW.SAMPLES));
  }
  for (let index = 1; index < count; index++) vertical[index] = (height[index] - height[index - 1]) / step;
  vertical[0] = 0;
  return { direction, heading, duration, step, time, along, height, horizontal, vertical, count, forcedUp, releaseSpeed };
}

/** A tow path along a heading and how hard the terrain pushed it up: the tow picks the clearest. */
function pathObstruction(world, waterHeight, start, heading, startSpeed, releaseSpeed, releaseAgl) {
  const path = planTowPath(world, waterHeight, start, heading, startSpeed, releaseSpeed, releaseAgl);
  return { path, obstruction: path.forcedUp };
}

/**
 * Starts an aerotow. Returns { update(dt), release(reason), finished, dispose() }. update(dt) moves
 * the tug and rope and returns the towed craft's pose { position, quaternion, velocity, released };
 * released is true exactly once, on the frame the rope lets go (then the craft flies on its own and
 * the tug keeps animating until finished). waterHeight(x, z) is the water surface the path clears
 * (the shared water query); without it, a flat sea at waterLevel.
 */
export function createAerotow({ scene, world, waterLevel = 0, waterHeight = () => waterLevel, start, startQuaternion, heading, startSpeed, releaseSpeed, releaseAgl, tug, gliderHook, ropeMaterial, time }) {
  const origin = start.clone();
  const initialAttitude = startQuaternion ? startQuaternion.clone() : null;
  const pathAttitude = new THREE.Quaternion();
  const initialSpeed = clamp(Number.isFinite(startSpeed) ? startSpeed : 0, 0, TOW.MAX_SPEED);
  let chosen = null;
  for (const offset of TOW.HEADING_CANDIDATES) {
    const candidate = pathObstruction(world, waterHeight, origin, wrapDegrees(heading + offset), initialSpeed, releaseSpeed, releaseAgl);
    if (!chosen || candidate.obstruction < chosen.obstruction - 1e-6) chosen = candidate;
    if (offset === 0 && candidate.obstruction === 0) break;
  }
  const path = chosen.path;

  const tugRoot = tug.root;
  tugRoot.name = 'tow-plane';
  scene.add(tugRoot);
  const tugHitch = tug.anchors?.towHitch ?? new THREE.Vector3(0, 0.3, 4.5);

  // Rope: a small tube re-skinned every frame along a sagging curve.
  const ringCount = TOW.ROPE_RINGS;
  const sides = TOW.ROPE_SIDES;
  const ropePositions = new Float32Array(ringCount * sides * 3);
  const ropeIndices = [];
  for (let ring = 0; ring < ringCount - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const current = ring * sides + side;
      const next = ring * sides + ((side + 1) % sides);
      ropeIndices.push(current, current + sides, next, next, current + sides, next + sides);
    }
  }
  const ropeGeometry = new THREE.BufferGeometry();
  const ropePositionAttribute = new THREE.BufferAttribute(ropePositions, 3).setUsage(THREE.DynamicDrawUsage);
  ropeGeometry.setAttribute('position', ropePositionAttribute);
  ropeGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(ringCount * sides * 3), 3).setUsage(THREE.DynamicDrawUsage));
  ropeGeometry.setIndex(ropeIndices);
  const rope = new THREE.Mesh(ropeGeometry, ropeMaterial);
  rope.name = 'tow-rope';
  rope.frustumCulled = false;
  rope.castShadow = true;
  scene.add(rope);

  const tugVisual = { aileron: 0, elevator: 0, rudder: 0, flaps: 0, throttle: 1, propSpeed: NaN, engineOn: true, onGround: false, gearDown: true, airbrake: 0, time: time ?? { elapsed: 0, nightFactor: 0, sunElevation: 30 } };
  const status = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), released: false };
  const tugState = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), heading: path.heading, bank: 0, speed: 0 };
  const scratchForward = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion();
  const hookWorld = new THREE.Vector3();
  const hitchWorld = new THREE.Vector3();
  const ropeEnd = new THREE.Vector3();
  const ropeTangent = new THREE.Vector3();
  const ropeNormal = new THREE.Vector3();
  const ropeBinormal = new THREE.Vector3();
  const ropePoint = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const finalLength = path.along[path.count - 1];
  const finalHeight = path.height[path.count - 1];

  let elapsed = 0;
  let phase = 'towing';
  let departElapsed = 0;
  let finished = false;

  /** Path sample at arc length s along the heading (level flight beyond the release point). */
  function sampleAtDistance(distance, position, velocity) {
    if (distance >= finalLength) {
      const beyond = distance - finalLength;
      position.set(origin.x + path.direction.x * (finalLength + beyond), finalHeight, origin.z + path.direction.z * (finalLength + beyond));
      velocity.copy(path.direction).multiplyScalar(path.releaseSpeed);
      return;
    }
    let low = 0;
    let high = path.count - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (path.along[middle] <= distance) low = middle;
      else high = middle;
    }
    const span = path.along[high] - path.along[low];
    const fraction = span > 1e-9 ? (distance - path.along[low]) / span : 0;
    const along = path.along[low] + span * fraction;
    const height = path.height[low] + (path.height[high] - path.height[low]) * fraction;
    const horizontal = path.horizontal[low] + (path.horizontal[high] - path.horizontal[low]) * fraction;
    const vertical = path.vertical[low] + (path.vertical[high] - path.vertical[low]) * fraction;
    position.set(origin.x + path.direction.x * along, height, origin.z + path.direction.z * along);
    velocity.copy(path.direction).multiplyScalar(horizontal);
    velocity.y = vertical;
  }

  function distanceAtTime(time) {
    if (time >= path.duration) return finalLength + (time - path.duration) * path.releaseSpeed;
    const index = Math.min(path.count - 2, Math.floor(time / path.step));
    const fraction = (time - path.time[index]) / path.step;
    return path.along[index] + (path.along[index + 1] - path.along[index]) * fraction;
  }

  /** Attitude along a velocity: heading from its horizontal part, pitch from the climb, bank given. */
  function attitudeAlong(velocity, bank, target) {
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const yaw = horizontalSpeed > 0.5 ? headingFromVector(velocity.x, velocity.z) : path.heading;
    const pitch = Math.atan2(velocity.y, Math.max(horizontalSpeed, 1));
    target.setFromAxisAngle(WORLD_UP, -yaw * DEG);
    target.multiply(scratchQuaternion.setFromAxisAngle(X_AXIS, pitch));
    if (bank !== 0) target.multiply(scratchQuaternion.setFromAxisAngle(Z_AXIS, -bank));
    return target;
  }

  function placeTug(dt) {
    if (phase === 'towing') {
      const tugDistance = distanceAtTime(elapsed) + TOW.ROPE_LENGTH;
      sampleAtDistance(tugDistance, tugState.position, tugState.velocity);
      attitudeAlong(tugState.velocity, 0, tugState.quaternion);
      tugState.heading = headingFromVector(tugState.velocity.x, tugState.velocity.z);
      tugState.speed = Math.hypot(tugState.velocity.x, tugState.velocity.z);
      return;
    }
    // Departing: bank left, turn away, sink gently, speed up a touch.
    const bankProgress = smooth01(departElapsed / 1.2);
    tugState.bank = -TOW.TUG_BANK * bankProgress;
    tugState.heading = wrapDegrees(tugState.heading - (TOW.TUG_TURN_RATE / DEG) * bankProgress * dt);
    tugState.speed += (path.releaseSpeed * TOW.TUG_EXIT_SPEEDUP - tugState.speed) * Math.min(1, dt * 1.5);
    vectorFromHeading(tugState.heading, tugState.velocity).multiplyScalar(tugState.speed);
    tugState.velocity.y = -TOW.TUG_SINK * bankProgress;
    tugState.position.addScaledVector(tugState.velocity, dt);
    attitudeAlong(tugState.velocity, tugState.bank, tugState.quaternion);
  }

  /** Re-skins the rope from the craft's hook to the tug's hitch (or trailing free after release). */
  function updateRope() {
    hitchWorld.copy(tugHitch).applyQuaternion(tugState.quaternion).add(tugState.position);
    if (phase === 'towing') {
      ropeEnd.copy(hookWorld);
    } else {
      const drop = smooth01(departElapsed / TOW.ROPE_DROP_SECONDS) * TOW.ROPE_DROP_DISTANCE;
      scratchForward.set(0, 0, -1).applyQuaternion(tugState.quaternion);
      ropeEnd.copy(hitchWorld).addScaledVector(scratchForward, -TOW.ROPE_LENGTH * 0.92);
      ropeEnd.y -= drop;
    }
    const sag = phase === 'towing' ? TOW.ROPE_SAG : TOW.ROPE_SAG * 3;
    for (let ring = 0; ring < ringCount; ring++) {
      const u = ring / (ringCount - 1);
      ropePoint.lerpVectors(ropeEnd, hitchWorld, u);
      ropePoint.y -= 4 * sag * u * (1 - u);
      const nextU = Math.min(1, u + 1 / (ringCount - 1));
      const previousU = Math.max(0, u - 1 / (ringCount - 1));
      ropeTangent.lerpVectors(ropeEnd, hitchWorld, nextU);
      ropeTangent.y -= 4 * sag * nextU * (1 - nextU);
      scratchForward.lerpVectors(ropeEnd, hitchWorld, previousU);
      scratchForward.y -= 4 * sag * previousU * (1 - previousU);
      ropeTangent.sub(scratchForward).normalize();
      ropeNormal.crossVectors(ropeTangent, Math.abs(ropeTangent.y) < 0.95 ? WORLD_UP : X_AXIS).normalize();
      ropeBinormal.crossVectors(ropeTangent, ropeNormal).normalize();
      for (let side = 0; side < sides; side++) {
        const angle = (side / sides) * Math.PI * 2;
        const cosine = Math.cos(angle) * TOW.ROPE_RADIUS;
        const sine = Math.sin(angle) * TOW.ROPE_RADIUS;
        const offset = (ring * sides + side) * 3;
        ropePositions[offset] = ropePoint.x + ropeNormal.x * cosine + ropeBinormal.x * sine;
        ropePositions[offset + 1] = ropePoint.y + ropeNormal.y * cosine + ropeBinormal.y * sine;
        ropePositions[offset + 2] = ropePoint.z + ropeNormal.z * cosine + ropeBinormal.z * sine;
      }
    }
    // Vertices are world positions: keep them near the origin of the rope mesh for float precision.
    rope.position.copy(hitchWorld);
    for (let index = 0; index < ropePositions.length; index += 3) {
      ropePositions[index] -= hitchWorld.x;
      ropePositions[index + 1] -= hitchWorld.y;
      ropePositions[index + 2] -= hitchWorld.z;
    }
    ropePositionAttribute.needsUpdate = true;
    ropeGeometry.computeVertexNormals();
    ropeGeometry.computeBoundingSphere();
  }

  function applyTugVisual(dt) {
    tugRoot.position.copy(tugState.position);
    tugRoot.quaternion.copy(tugState.quaternion);
    tugVisual.aileron = phase === 'towing' ? 0 : clamp(tugState.bank / TOW.TUG_BANK, -1, 1) * (1 - smooth01(departElapsed / 1.5)) * 0.8;
    tugVisual.rudder = phase === 'towing' ? 0 : -0.3 * (1 - smooth01(departElapsed / 2));
    tug.update(tugVisual, dt);
  }

  return {
    get finished() { return finished; },
    get phase() { return phase; },
    get duration() { return path.duration; },
    get tug() { return tugRoot; },

    /** Advances the tow by dt; returns the towed craft's pose (see above). */
    update(dt) {
      status.released = false;
      if (finished) return status;
      const step = Math.max(0, dt);
      if (phase === 'towing') {
        elapsed = Math.min(path.duration, elapsed + step);
        sampleAtDistance(distanceAtTime(elapsed), status.position, status.velocity);
        attitudeAlong(status.velocity, 0, status.quaternion);
        // Ease from the craft's own attitude (resting nose-high, or banked) onto the tow line.
        if (initialAttitude && elapsed < TOW.ATTITUDE_BLEND_SECONDS) {
          pathAttitude.copy(status.quaternion);
          status.quaternion.slerpQuaternions(initialAttitude, pathAttitude, smooth01(elapsed / TOW.ATTITUDE_BLEND_SECONDS));
        }
        hookWorld.copy(gliderHook).applyQuaternion(status.quaternion).add(status.position);
        placeTug(step);
        if (elapsed >= path.duration) {
          phase = 'departing';
          status.released = true;
        }
      } else {
        departElapsed += step;
        placeTug(step);
        if (departElapsed >= TOW.TUG_EXIT_SECONDS) finished = true;
      }
      updateRope();
      applyTugVisual(step);
      return status;
    },

    /** Lets go early (mode or craft change); the tug departs as after a normal release. */
    release() {
      if (phase === 'towing') phase = 'departing';
    },

    dispose() {
      finished = true;
      scene.remove(rope);
      ropeGeometry.dispose();
      tug.dispose();
      tugRoot.removeFromParent();
    },
  };
}
