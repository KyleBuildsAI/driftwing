import * as THREE from 'three/webgpu';
import { CONFIG } from '../core/config.js';
import { DEG, clamp, damp, wrapDegrees, headingFromVector, vectorFromHeading, bearingTo, isFiniteVector, isFiniteQuaternion } from '../core/util.js';

/**
 * ARCADE MODEL: the v1 flight model, extracted without behaviour change and parameterised by a
 * craft's arcadeProfile (the glider's profile is v1's constants, so CLASSIC glider flight is v1).
 * Bank-to-turn handling with coordinated turns, energy trade in climbs and dives, soft stall, boost
 * with cooldown, auto-level, ground cushion, soft ceiling, terrain-aware autopilot with manual
 * override and the canned barrel roll; the stick alone can never leave the craft inverted.
 *
 * Like v1 it owns the state.player motion fields (position, quaternion, velocity, speed, throttle,
 * heading / pitch / roll, forward / up / right, yawRate, gForce, stalled, boost, barrelRoll,
 * autopilot) and reads them back at the start of every step, because core clamps the pose after
 * the flight update. Non-finite state (shared or internal) is repaired at the start of every step,
 * keeping the last good pose, so the craft never freezes.
 *
 * FlightModel interface (docs/architecture.md): kind 'arcade', step(dt, controls, env) is one v1
 * variable step (controls is the v1 input struct), reset(pose), state, contact, writeTelemetry,
 * snapshot / restore. `visual` carries what the craft mesh animates from (control-surface
 * deflections, throttle, boost) plus the v1 wobble and barrel-roll corkscrew offset.
 */
export function createArcadeModel({ profile, world, bus, state, input: initialInput }) {
  const player = state.player;
  const SPEED = profile.SPEED;

  // ---- Tuning (the craft's arcadeProfile; names match v1's constants) --------------------
  const GRAVITY = profile.GRAVITY;
  const DRAG_COEFFICIENT = profile.DRAG_COEFFICIENT;
  const THROTTLE_SPEED_EXPONENT = profile.THROTTLE_SPEED_EXPONENT;
  const THROTTLE_RATE = profile.THROTTLE_RATE;
  const INDUCED_DRAG = profile.INDUCED_DRAG;
  const INDUCED_MAX_EXTRA_G = profile.INDUCED_MAX_EXTRA_G;
  const MAX_PITCH_RATE = profile.MAX_PITCH_RATE;
  const MAX_ROLL_RATE = profile.MAX_ROLL_RATE;
  const MAX_YAW_RATE = profile.MAX_YAW_RATE;
  const MAX_BANK = profile.MAX_BANK;
  const BANK_GAIN = profile.BANK_GAIN;
  const FINE_BANK_SCALE = profile.FINE_BANK_SCALE;
  const YAW_BANK = profile.YAW_BANK;
  const PITCH_LIMIT_START = profile.PITCH_LIMIT_START;
  const PITCH_LIMIT_RANGE = profile.PITCH_LIMIT_RANGE;
  const TURN_GAIN = profile.TURN_GAIN;
  const MAX_TURN_RATE = profile.MAX_TURN_RATE;
  const BANK_NOSE_DROP = profile.BANK_NOSE_DROP;
  const BANK_SETTLE_PITCH = profile.BANK_SETTLE_PITCH;
  const FINE_CONTROL_SCALE = profile.FINE_CONTROL_SCALE;
  const AUTO_LEVEL_DELAY = profile.AUTO_LEVEL_DELAY;
  const STALL_EXIT_MARGIN = profile.STALL_EXIT_MARGIN;
  const STALL_NOSE_TARGET = profile.STALL_NOSE_TARGET;
  const HIGH_SPEED_PITCH_START = profile.HIGH_SPEED_PITCH_START;
  const CUSHION_HEIGHT = profile.CUSHION_HEIGHT;
  const IMPACT_WARNING_SECONDS = profile.IMPACT_WARNING_SECONDS;
  const IMPACT_FULL_SECONDS = profile.IMPACT_FULL_SECONDS;
  const CUSHION_PULL_RATE = profile.CUSHION_PULL_RATE;
  const GUARD_PROBE_SECONDS = profile.GUARD_PROBE_SECONDS;
  const GUARD_MARGIN = profile.GUARD_MARGIN;
  const GUARD_MIN_SPEED = profile.GUARD_MIN_SPEED;
  const GUARD_EVADE_GRADIENT = profile.GUARD_EVADE_GRADIENT;
  const GUARD_EVADE_BANK = profile.GUARD_EVADE_BANK;
  const CEILING_BAND = profile.CEILING_BAND;
  const BOOST_DURATION = profile.BOOST_DURATION;
  const BOOST_COOLDOWN = profile.BOOST_COOLDOWN;
  const BARREL_ROLL_DURATION = profile.BARREL_ROLL_DURATION;
  const BARREL_ROLL_RADIUS = profile.BARREL_ROLL_RADIUS;
  const AUTOPILOT = profile.AUTOPILOT;
  const LOAD = profile.LOAD;
  const SURFACE_TURN_SHARE = profile.SURFACE_TURN_SHARE;

  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const LOCAL_RIGHT = new THREE.Vector3(1, 0, 0);
  const LOCAL_UP = new THREE.Vector3(0, 1, 0);
  const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

  // ---- Simulation state ------------------------------------------------------------------
  const attitude = player.quaternion.clone();
  const pathDirection = player.forward.clone().normalize();
  const bodyForward = new THREE.Vector3();
  const bodyUp = new THREE.Vector3();
  const bodyRight = new THREE.Vector3();
  const horizontalRight = new THREE.Vector3();
  const rollOffset = new THREE.Quaternion();
  const corkscrewOffset = new THREE.Vector3();
  const scratchQuaternion = new THREE.Quaternion();
  const wobbleQuaternion = new THREE.Quaternion();
  const wobbleEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  const rates = { pitch: 0, roll: 0, yaw: 0, worldPitch: 0, turn: 0 };
  const frame = { pitch: 0, bank: 0, horizontalLength: 1, liftFactor: 1 };
  const assist = { cushion: 0, proximity: 0, urgency: 0, risingTerrain: 0, ceiling: 0, evade: 0, evadeDirection: 0 };
  const barrel = { active: false, direction: 0, elapsed: 0, angle: 0 };
  const autopilotState = {
    overrideSeconds: 0,
    commandedBank: 0,
    throttleOverride: false,
    rollRate: 0,
    worldPitchRate: 0,
    throttle: AUTOPILOT.CRUISE_THROTTLE,
  };
  const LOOKAHEAD_SAMPLE_COUNT = AUTOPILOT.LOOKAHEAD_DISTANCES.length + AUTOPILOT.PATH_LOOKAHEAD_DISTANCES.length;
  const lookahead = {
    x: NaN,
    z: NaN,
    heading: NaN,
    age: Infinity,
    heights: new Float64Array(LOOKAHEAD_SAMPLE_COUNT),
    distances: new Float64Array(LOOKAHEAD_SAMPLE_COUNT),
    count: 0,
    limit: Infinity,
    floor: 0,
    gradient: 0,
  };
  const autopilotTarget = {
    heading: 0,
    altitude: 0,
    clearance: 0,
    ring: false,
    ringDistance: 0,
    lookaheadHeading: 0,
    lookaheadLimit: Infinity,
  };
  let input = initialInput;
  let speed = player.speed;
  let stalled = false;
  let idleSeconds = 0;
  let pitchIdleSeconds = 0;
  let throttleGoal = null;
  let lastThrottleTarget = input.throttleTarget;
  let previousHeading = player.heading;
  let lastFiniteHeading = Number.isFinite(player.heading) ? player.heading : 0;
  const lastFinitePosition = player.position.clone();
  let smoothedYawRate = 0;
  let smoothedGForce = 1;
  const controlSurfaces = { aileron: 0, elevator: 0, rudder: 0 };

  /** What the craft mesh animates from; refreshed every step (see animateModel). */
  const visual = {
    aileron: 0,
    elevator: 0,
    rudder: 0,
    flaps: 0,
    throttle: player.throttle,
    boost: false,
    propSpeed: NaN,
    engineOn: true,
    onGround: false,
    time: state.time,
  };
  const modelState = {
    position: player.position,
    velocity: player.velocity,
    quaternion: player.quaternion,
    angularVelocity: new THREE.Vector3(),
  };
  const contact = Object.freeze({ onGround: false, touchdown: null, bodyStrike: null, water: false, penetration: 0 });

  player.boost.cooldownTotal = BOOST_COOLDOWN;

  // ---- Small math helpers ------------------------------------------------------------------
  function smooth01(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function wrapSignedDegrees(degrees) {
    return ((((degrees + 180) % 360) + 360) % 360) - 180;
  }
  function wrapSignedRadians(radians) {
    return Math.atan2(Math.sin(radians), Math.cos(radians));
  }
  function easeRollProgress(progress) {
    return 0.35 * progress + 0.65 * (0.5 - 0.5 * Math.cos(Math.PI * progress));
  }

  // ============================================================================================
  // FLIGHT MODEL
  // ============================================================================================
  /**
   * Reads the shared pose back (core may have clamped it). A non-finite or zero-length shared
   * quaternion keeps last frame's attitude; if that is unusable too, the wings are levelled on
   * the last finite heading. Any non-finite integrator resets the transient flight state.
   */
  function syncFromState() {
    if (isFiniteVector(player.position)) lastFinitePosition.copy(player.position);
    else player.position.copy(lastFinitePosition);
    if (Number.isFinite(player.heading)) lastFiniteHeading = player.heading;
    const sharedAttitudeValid = isFiniteQuaternion(player.quaternion);
    if (!barrel.active && sharedAttitudeValid) attitude.copy(player.quaternion);
    let attitudeRebuilt = false;
    if (!isFiniteQuaternion(attitude)) {
      if (sharedAttitudeValid) attitude.copy(player.quaternion);
      else attitude.setFromAxisAngle(WORLD_UP, -lastFiniteHeading * DEG);
      attitudeRebuilt = true;
    }
    attitude.normalize();
    if (Number.isFinite(player.speed)) speed = clamp(player.speed, SPEED.MIN, SPEED.BOOST_MAX);
    else if (!Number.isFinite(speed)) speed = SPEED.CRUISE;
    const velocityLength = player.velocity.length();
    if (velocityLength > 1 && Number.isFinite(velocityLength)) pathDirection.copy(player.velocity).divideScalar(velocityLength);
    else pathDirection.set(0, 0, -1).applyQuaternion(attitude);
    if (attitudeRebuilt || !internalsAreFinite()) resetInternals(lastFiniteHeading);
  }

  /** NaN or Infinity in any integrator makes the sum non-finite (one check per frame). */
  function internalsAreFinite() {
    const sum = rates.pitch + rates.roll + rates.yaw + rates.worldPitch + rates.turn
      + speed + pathDirection.x + pathDirection.y + pathDirection.z
      + assist.cushion + assist.proximity + assist.urgency + assist.risingTerrain + assist.ceiling + assist.evade + assist.evadeDirection
      + autopilotState.commandedBank + autopilotState.rollRate + autopilotState.worldPitchRate + autopilotState.throttle + autopilotState.overrideSeconds
      + controlSurfaces.aileron + controlSurfaces.elevator + controlSurfaces.rudder
      + barrel.elapsed + barrel.angle + corkscrewOffset.x + corkscrewOffset.y + corkscrewOffset.z
      + smoothedYawRate + smoothedGForce + previousHeading + idleSeconds + pitchIdleSeconds;
    return Number.isFinite(sum);
  }

  /** Clears rates, smoothers, assists and the canned roll; keeps attitude, speed and position. */
  function resetInternals(heading) {
    rates.pitch = 0;
    rates.roll = 0;
    rates.yaw = 0;
    rates.worldPitch = 0;
    rates.turn = 0;
    assist.cushion = 0;
    assist.proximity = 0;
    assist.urgency = 0;
    assist.risingTerrain = 0;
    assist.ceiling = 0;
    assist.evade = 0;
    assist.evadeDirection = 0;
    barrel.active = false;
    barrel.elapsed = 0;
    barrel.angle = 0;
    player.barrelRoll.active = false;
    player.barrelRoll.progress = 0;
    autopilotState.commandedBank = 0;
    autopilotState.rollRate = 0;
    autopilotState.worldPitchRate = 0;
    autopilotState.overrideSeconds = 0;
    if (!Number.isFinite(autopilotState.throttle)) autopilotState.throttle = AUTOPILOT.CRUISE_THROTTLE;
    if (!Number.isFinite(player.throttle)) player.throttle = AUTOPILOT.CRUISE_THROTTLE;
    controlSurfaces.aileron = 0;
    controlSurfaces.elevator = 0;
    controlSurfaces.rudder = 0;
    corkscrewOffset.set(0, 0, 0);
    stalled = false;
    idleSeconds = 0;
    pitchIdleSeconds = 0;
    smoothedYawRate = 0;
    smoothedGForce = 1;
    lookahead.age = Infinity;
    previousHeading = heading;
  }

  /** Stick axes as finite values in [-1, 1] (a bad input value reads as centred). */
  function axisValue(value) {
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  function computeAttitudeFrame() {
    bodyForward.set(0, 0, -1).applyQuaternion(attitude);
    bodyUp.set(0, 1, 0).applyQuaternion(attitude);
    bodyRight.set(1, 0, 0).applyQuaternion(attitude);
    frame.pitch = Math.asin(clamp(bodyForward.y, -1, 1));
    frame.bank = Math.atan2(-bodyRight.y, bodyUp.y);
    frame.horizontalLength = Math.hypot(bodyForward.x, bodyForward.z);
    if (frame.horizontalLength > 1e-4) horizontalRight.set(-bodyForward.z / frame.horizontalLength, 0, bodyForward.x / frame.horizontalLength);
    else horizontalRight.copy(bodyRight);
    frame.liftFactor = smooth01((speed - SPEED.MIN) / (SPEED.CRUISE * 0.8 - SPEED.MIN));
  }

  function updateThrottle(step) {
    if (input.throttleTarget !== lastThrottleTarget) {
      lastThrottleTarget = input.throttleTarget;
      if (input.throttleTarget !== null && Number.isFinite(input.throttleTarget)) {
        throttleGoal = clamp(input.throttleTarget, 0, 1);
        autopilotState.throttleOverride = true;
      }
    }
    let throttle = Number.isFinite(player.throttle) ? player.throttle : AUTOPILOT.CRUISE_THROTTLE;
    const throttleDelta = axisValue(input.throttleDelta);
    if (throttleDelta !== 0) {
      throttleGoal = null;
      throttle += throttleDelta * THROTTLE_RATE * step;
      autopilotState.throttleOverride = true;
    } else if (throttleGoal !== null) {
      throttle = damp(throttle, throttleGoal, 5, step);
      if (Math.abs(throttle - throttleGoal) < 0.003) {
        throttle = throttleGoal;
        throttleGoal = null;
      }
    } else if (player.autopilot.enabled && !autopilotState.throttleOverride) {
      throttle = damp(throttle, autopilotState.throttle, 0.8, step);
    }
    player.throttle = clamp(throttle, 0, 1);
  }

  function updateBoost(step) {
    const boostState = player.boost;
    if (boostState.active) {
      boostState.remaining = Math.max(0, boostState.remaining - step);
      if (boostState.remaining <= 0) boostState.active = false;
    } else if (boostState.cooldown > 0) {
      boostState.cooldown = Math.max(0, boostState.cooldown - step);
    }
  }

  function updateStall() {
    if (!stalled && speed < SPEED.STALL) {
      stalled = true;
      bus.emit('stall', {});
    } else if (stalled && speed > SPEED.STALL + STALL_EXIT_MARGIN) {
      stalled = false;
    }
  }

  /**
   * Ground / water guard and the soft ceiling (no crash state, ever).
   * - `urgency` rises as the time to reach the surface drops below 2.5 s, or as the climb
   *   gradient needed to clear terrain 1-3.4 s ahead exceeds the current path gradient;
   *   it drives a firm nose-up pull and blocks further nose-down input.
   * - `proximity` flattens the path in the last 25 m.
   * - `evade` banks toward the lower side when the terrain ahead is too steep to out-climb.
   */
  function updateTerrainAssist(step) {
    const position = player.position;
    const groundHere = groundFloor(position.x, position.z);
    const clearanceHere = position.y - groundHere;
    const horizontalLength = Math.hypot(pathDirection.x, pathDirection.z);
    const headingX = horizontalLength > 1e-3 ? pathDirection.x / horizontalLength : bodyForward.x;
    const headingZ = horizontalLength > 1e-3 ? pathDirection.z / horizontalLength : bodyForward.z;
    const horizontalSpeed = Math.max(speed * horizontalLength, GUARD_MIN_SPEED);
    let requiredGradient = -Infinity;
    let highestAhead = groundHere;
    for (const seconds of GUARD_PROBE_SECONDS) {
      const distance = horizontalSpeed * seconds;
      const ground = groundFloor(position.x + headingX * distance, position.z + headingZ * distance);
      highestAhead = Math.max(highestAhead, ground);
      requiredGradient = Math.max(requiredGradient, (ground + GUARD_MARGIN - position.y) / distance);
    }
    const pathGradient = pathDirection.y / Math.max(horizontalLength, 0.05);
    const terrainUrgency = clamp((requiredGradient - pathGradient) / 0.35, 0, 1);
    const descentRate = -pathDirection.y * speed;
    const timeToGround = descentRate > 0.5 ? Math.max(0, clearanceHere) / descentRate : Infinity;
    const descentUrgency = clamp(1 - (timeToGround - IMPACT_FULL_SECONDS) / (IMPACT_WARNING_SECONDS - IMPACT_FULL_SECONDS), 0, 1);
    assist.urgency = Math.max(descentUrgency, terrainUrgency);
    const descending = pathDirection.y < 0.02;
    assist.proximity = clamp(1 - clearanceHere / CUSHION_HEIGHT, 0, 1) * (descending ? 1 : 0.3);
    assist.cushion = Math.max(assist.urgency, assist.proximity);
    assist.risingTerrain = highestAhead > groundHere + 1 ? clamp(1 - (position.y - highestAhead) / CUSHION_HEIGHT, 0, 1) : 0;

    const evadeTarget = smooth01((requiredGradient - GUARD_EVADE_GRADIENT) / 0.35);
    if (evadeTarget > 0.05 && assist.evadeDirection === 0) assist.evadeDirection = chooseEvadeSide(position, headingX, headingZ, horizontalSpeed);
    assist.evade = damp(assist.evade, evadeTarget, 4, step);
    if (assist.evade < 0.02 && evadeTarget === 0) {
      assist.evade = 0;
      assist.evadeDirection = 0;
    }
    const ceilingStart = CONFIG.MAX_ALTITUDE - CEILING_BAND;
    assist.ceiling = smooth01((position.y - ceilingStart) / CEILING_BAND);
  }

  function groundFloor(x, z) {
    return Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  }

  /** +1 = bank right, -1 = bank left: whichever side is lower ~2 s ahead (current bank breaks ties). */
  function chooseEvadeSide(position, headingX, headingZ, horizontalSpeed) {
    const distance = horizontalSpeed * 2;
    const diagonal = Math.SQRT1_2;
    const rightX = headingX * diagonal - headingZ * diagonal;
    const rightZ = headingZ * diagonal + headingX * diagonal;
    const leftX = headingX * diagonal + headingZ * diagonal;
    const leftZ = headingZ * diagonal - headingX * diagonal;
    const rightGround = groundFloor(position.x + rightX * distance, position.z + rightZ * distance);
    const leftGround = groundFloor(position.x + leftX * distance, position.z + leftZ * distance);
    if (Math.abs(rightGround - leftGround) < 8) return frame.bank < 0 ? -1 : 1;
    return rightGround < leftGround ? 1 : -1;
  }

  /**
   * Samples world.heightAt along `headingDegrees` and the current path (cached), ignoring
   * points farther than `maxDistance` (ring following stops just past the ring).
   */
  function refreshLookahead(headingDegrees, maxDistance) {
    const position = player.position;
    const moved = Math.hypot(position.x - lookahead.x, position.z - lookahead.z);
    const turned = Math.abs(wrapSignedDegrees(headingDegrees - lookahead.heading));
    const limitChanged = Number.isFinite(maxDistance) !== Number.isFinite(lookahead.limit)
      || (Number.isFinite(maxDistance) && Math.abs(lookahead.limit - moved - maxDistance) > 40);
    if (moved < 80 && turned < 6 && lookahead.age <= 0.6 && !limitChanged) return;
    const directionX = Math.sin(headingDegrees * DEG);
    const directionZ = -Math.cos(headingDegrees * DEG);
    let sample = 0;
    for (const distance of AUTOPILOT.LOOKAHEAD_DISTANCES) {
      if (distance > maxDistance) break;
      lookahead.heights[sample] = world.heightAt(position.x + directionX * distance, position.z + directionZ * distance);
      lookahead.distances[sample] = distance;
      sample++;
    }
    // Also along the current flight path, which differs from the target heading mid-turn.
    const pathLength = Math.max(Math.hypot(pathDirection.x, pathDirection.z), 1e-3);
    for (const distance of AUTOPILOT.PATH_LOOKAHEAD_DISTANCES) {
      if (distance > maxDistance) break;
      lookahead.heights[sample] = world.heightAt(position.x + (pathDirection.x / pathLength) * distance, position.z + (pathDirection.z / pathLength) * distance);
      lookahead.distances[sample] = distance;
      sample++;
    }
    lookahead.count = sample;
    lookahead.limit = maxDistance;
    lookahead.x = position.x;
    lookahead.z = position.z;
    lookahead.heading = headingDegrees;
    lookahead.age = 0;
  }

  /** Required floor altitude and the steepest climb gradient needed to clear it. */
  function evaluateTerrainClearance(clearance) {
    const altitude = player.position.y;
    let floor = CONFIG.WATER_LEVEL + clearance;
    let gradient = -Infinity;
    for (let sample = 0; sample < lookahead.count; sample++) {
      const needed = Math.max(lookahead.heights[sample], CONFIG.WATER_LEVEL) + clearance;
      floor = Math.max(floor, needed);
      const distance = lookahead.distances[sample];
      if (distance > 50) gradient = Math.max(gradient, (needed - altitude) / distance);
    }
    lookahead.floor = floor;
    lookahead.gradient = gradient;
  }

  /**
   * Ring target: steer for a point on the ring's axis a couple of seconds ahead of the
   * craft's projection onto that axis (cross-track correction), so it arrives on the axis
   * instead of merely pointing at the centre. Terrain is sampled on the direct line to the
   * ring and at most RING_LOOKAHEAD_MARGIN past it.
   */
  function aimAtRing(target, ringPosition, ringNormal) {
    const position = player.position;
    const toRingX = ringPosition.x - position.x;
    const toRingZ = ringPosition.z - position.z;
    const distance = Math.hypot(toRingX, toRingZ);
    target.ring = true;
    target.ringDistance = distance;
    target.heading = headingFromVector(toRingX, toRingZ);
    target.lookaheadHeading = target.heading;
    target.lookaheadLimit = distance + AUTOPILOT.RING_LOOKAHEAD_MARGIN;
    target.clearance = AUTOPILOT.RING_CLEARANCE;
    if (Number.isFinite(ringPosition.y)) target.altitude = ringPosition.y;
    const axisLength = ringNormal ? Math.hypot(ringNormal.x, ringNormal.z) : 0;
    if (!(axisLength > 0.2)) return;
    const axisX = ringNormal.x / axisLength;
    const axisZ = ringNormal.z / axisLength;
    const alongAxis = toRingX * axisX + toRingZ * axisZ;
    const lead = clamp(speed * AUTOPILOT.RING_TRACK_LEAD_SECONDS, AUTOPILOT.RING_TRACK_LEAD_MIN, AUTOPILOT.RING_TRACK_LEAD_MAX);
    target.heading = headingFromVector(toRingX + axisX * (lead - alongAxis), toRingZ + axisZ * (lead - alongAxis));
  }

  function resolveAutopilotTarget(autopilot) {
    const target = autopilotTarget;
    target.heading = autopilot.heading;
    target.altitude = autopilot.altitude;
    target.clearance = AUTOPILOT.CLEARANCE;
    target.ring = false;
    target.ringDistance = 0;
    target.lookaheadLimit = Infinity;
    if (autopilot.followWaypoint) {
      const course = state.ringCourse;
      const ringPosition = course && course.active ? course.nextRingPosition : null;
      const waypoint = state.waypoint;
      if (ringPosition && Number.isFinite(ringPosition.x) && Number.isFinite(ringPosition.z)) {
        aimAtRing(target, ringPosition, course.nextRingNormal);
      } else if (waypoint && Number.isFinite(waypoint.x) && Number.isFinite(waypoint.z)) {
        target.heading = bearingTo(player.position.x, player.position.z, waypoint.x, waypoint.z);
      }
      autopilot.heading = target.heading;
    }
    if (!target.ring) target.lookaheadHeading = target.heading;
    return target;
  }

  function computeAutopilot(step) {
    const target = resolveAutopilotTarget(player.autopilot);
    lookahead.age += step;
    refreshLookahead(target.lookaheadHeading, target.lookaheadLimit);
    evaluateTerrainClearance(target.clearance);
    const terrainLimited = lookahead.floor > target.altitude + 5;
    updateAutopilotBank(target, step);
    const altitudeError = updateAutopilotPitch(target, Math.max(target.altitude, lookahead.floor), terrainLimited);
    const climbing = (altitudeError > 40 && terrainLimited) || lookahead.gradient > 0.08 ? 0.3 : 0;
    autopilotState.throttle = clamp(AUTOPILOT.CRUISE_THROTTLE + (SPEED.CRUISE - speed) * 0.02 + climbing, 0.3, 0.95);
  }

  function updateAutopilotBank(target, step) {
    const steering = target.ring ? AUTOPILOT.RING_STEERING : AUTOPILOT.WAYPOINT_STEERING;
    const headingError = wrapSignedDegrees(target.heading - player.heading);
    const desiredBank = clamp(headingError * steering.BANK_PER_DEGREE * DEG, -steering.MAX_BANK, steering.MAX_BANK);
    autopilotState.commandedBank = damp(autopilotState.commandedBank, desiredBank, steering.DAMPING, step);
    autopilotState.rollRate = clamp(wrapSignedRadians(autopilotState.commandedBank - frame.bank) * 2.8, -steering.MAX_ROLL_RATE, steering.MAX_ROLL_RATE);
  }

  /**
   * Pitch toward the desired altitude. Following a ring, the vertical speed is fed forward so
   * the craft reaches the ring's height as it arrives (time to ring >= 1.5 s), up to 12 deg,
   * and the model's nose drop in banks is cancelled so turns do not sag under the ring.
   * Returns the altitude error (m).
   */
  function updateAutopilotPitch(target, desiredAltitude, terrainLimited) {
    const altitudeError = desiredAltitude - player.position.y;
    const ringTracking = target.ring && !terrainLimited;
    let pitchLimit = AUTOPILOT.MAX_PITCH;
    if (terrainLimited && altitudeError > 0) pitchLimit = AUTOPILOT.TERRAIN_PITCH;
    else if (ringTracking) pitchLimit = AUTOPILOT.RING_MAX_PITCH;
    const maxVerticalSpeed = speed * Math.sin(pitchLimit);
    const closureRate = ringTracking ? 1 / Math.max(target.ringDistance / Math.max(speed, 1), AUTOPILOT.RING_MIN_TIME_TO_RING) : 0.12;
    const desiredVerticalSpeed = clamp(altitudeError * closureRate, -maxVerticalSpeed, maxVerticalSpeed);
    const verticalSpeed = pathDirection.y * speed;
    const verticalSpeedGain = ringTracking ? AUTOPILOT.RING_VERTICAL_SPEED_GAIN : 0.006;
    const verticalTrim = ringTracking ? 0.06 : 0.05;
    let desiredPitch = clamp(
      Math.asin(clamp(desiredVerticalSpeed / Math.max(speed, 1), -1, 1)) + clamp((desiredVerticalSpeed - verticalSpeed) * verticalSpeedGain, -verticalTrim, verticalTrim),
      -pitchLimit,
      pitchLimit,
    );
    // Rising terrain ahead: climb at the gradient it needs (with margin), up to 20 degrees.
    const terrainClimb = lookahead.gradient > 0;
    if (terrainClimb) {
      const terrainPitch = Math.min(Math.atan(lookahead.gradient * 1.25), AUTOPILOT.TERRAIN_MAX_PITCH);
      if (terrainPitch > desiredPitch) desiredPitch = terrainPitch;
    }
    const pitchGain = terrainClimb || ringTracking ? 3 : 2.2;
    let worldPitchRate = clamp((desiredPitch - frame.pitch) * pitchGain, -25 * DEG, 25 * DEG);
    if (ringTracking) worldPitchRate += BANK_NOSE_DROP * Math.sin(frame.bank) ** 2;
    autopilotState.worldPitchRate = worldPitchRate;
    return altitudeError;
  }

  function updateAutopilotOverride(step) {
    if (!player.autopilot.enabled) {
      autopilotState.overrideSeconds = 0;
      return;
    }
    const manual = Math.max(Math.abs(input.pitch), Math.abs(input.roll), Math.abs(input.yaw));
    if (manual > AUTOPILOT.OVERRIDE_INPUT) {
      autopilotState.overrideSeconds += step;
      if (autopilotState.overrideSeconds >= AUTOPILOT.OVERRIDE_SECONDS) setAutopilot({ enabled: false, reason: 'manual override' });
    } else {
      autopilotState.overrideSeconds = 0;
    }
  }

  function coordinatedTurnRate() {
    const bankSin = -bodyRight.y;
    const bankCos = bodyUp.y;
    const rate = (TURN_GAIN * GRAVITY * bankSin) / (Math.max(speed, SPEED.MIN) * Math.max(Math.abs(bankCos), 0.3));
    return clamp(rate * (0.5 + 0.5 * frame.liftFactor), -MAX_TURN_RATE, MAX_TURN_RATE);
  }

  /**
   * Bank-to-turn: roll / yaw input sets a target bank (eased by the rate limit and the rate
   * damping); zero input means wings level. Near vertical the bank angle is undefined, so
   * the stick blends over to a plain roll rate there.
   */
  function manualBankRollRate(rollCommand, yawCommand, authority, verticalWeight) {
    const bankLimit = MAX_BANK * (input.fineControl ? FINE_BANK_SCALE : 1);
    const targetBank = clamp(rollCommand * bankLimit + yawCommand * YAW_BANK, -MAX_BANK, MAX_BANK);
    const rateLimit = MAX_ROLL_RATE * authority;
    const holdRate = clamp(wrapSignedRadians(targetBank - frame.bank) * BANK_GAIN, -rateLimit, rateLimit);
    return holdRate * verticalWeight + rollCommand * rateLimit * (1 - verticalWeight);
  }

  function updateRotation(step) {
    const autopilotActive = player.autopilot.enabled;
    let pitchCommand = 0;
    let rollCommand = 0;
    let yawCommand = 0;
    if (autopilotActive) computeAutopilot(step);
    else {
      pitchCommand = axisValue(input.pitch);
      // Near the surface the pilot cannot push the nose further down: there is no crash state.
      if (pitchCommand < 0) pitchCommand *= 1 - assist.cushion;
      rollCommand = barrel.active ? 0 : axisValue(input.roll);
      yawCommand = axisValue(input.yaw);
    }
    const hasInput = Math.abs(pitchCommand) > 0.05 || Math.abs(rollCommand) > 0.05 || Math.abs(yawCommand) > 0.05;
    idleSeconds = hasInput || barrel.active ? 0 : idleSeconds + step;
    pitchIdleSeconds = Math.abs(pitchCommand) > 0.05 || barrel.active ? 0 : pitchIdleSeconds + step;

    let authority = 0.45 + 0.55 * frame.liftFactor;
    if (stalled) authority *= 0.55;
    if (input.fineControl) authority *= FINE_CONTROL_SCALE;
    const highSpeedPitch = 1 - 0.42 * smooth01((speed - HIGH_SPEED_PITCH_START) / (SPEED.MAX - HIGH_SPEED_PITCH_START));
    // Nose elevation changes by pitchRate * cos(bank): taper only input that steepens the attitude.
    const steepening = pitchCommand !== 0 && Math.sign(pitchCommand * Math.cos(frame.bank)) === Math.sign(frame.pitch);
    const pitchTaper = steepening ? 1 - smooth01((Math.abs(frame.pitch) - PITCH_LIMIT_START) / PITCH_LIMIT_RANGE) : 1;

    const targetPitchRate = pitchCommand * MAX_PITCH_RATE * authority * highSpeedPitch * pitchTaper;
    const targetYawRate = yawCommand * MAX_YAW_RATE * authority;
    let targetRollRate = 0;
    let worldPitchRate = 0;
    const verticalWeight = Math.min(1, frame.horizontalLength * 2);

    if (barrel.active) {
      // The canned roll overlays the base attitude, which simply holds its bank meanwhile.
      if (autopilotActive) worldPitchRate += autopilotState.worldPitchRate;
    } else if (autopilotActive) {
      targetRollRate = autopilotState.rollRate;
      worldPitchRate += autopilotState.worldPitchRate;
    } else {
      targetRollRate = manualBankRollRate(rollCommand, yawCommand, authority, verticalWeight);
    }

    if (assist.evade > 0 && !barrel.active) {
      const evadeRollRate = clamp(wrapSignedRadians(assist.evadeDirection * GUARD_EVADE_BANK - frame.bank) * 3, -90 * DEG, 90 * DEG);
      targetRollRate = targetRollRate * (1 - assist.evade) + evadeRollRate * assist.evade;
    }

    // Gentle pitch auto-level once the pitch axis has been idle for AUTO_LEVEL_DELAY: the nose
    // settles level, or a touch nose-down in a bank (a slow, calm descending turn).
    const bankSin = Math.sin(frame.bank);
    let levelBlend = 0;
    if (!autopilotActive && !barrel.active) {
      levelBlend = smooth01((pitchIdleSeconds - AUTO_LEVEL_DELAY) / 0.8) * verticalWeight;
      const settlePitch = -BANK_SETTLE_PITCH * bankSin * bankSin;
      worldPitchRate += clamp((settlePitch - frame.pitch) * 0.7, -15 * DEG, 15 * DEG) * levelBlend;
    }
    if (Math.abs(frame.bank) < 100 * DEG) worldPitchRate -= BANK_NOSE_DROP * bankSin * bankSin * verticalWeight * (1 - levelBlend);
    if (stalled) worldPitchRate += clamp((STALL_NOSE_TARGET - frame.pitch) * 1.8, -40 * DEG, 0);
    if (assist.cushion > 0 && frame.pitch < 12 * DEG) {
      worldPitchRate += assist.cushion * CUSHION_PULL_RATE * clamp((12 * DEG - frame.pitch) / (20 * DEG), 0.25, 1);
    }
    if (assist.ceiling > 0 && frame.pitch > -5 * DEG) worldPitchRate -= assist.ceiling * 30 * DEG;

    rates.pitch = damp(rates.pitch, targetPitchRate, 10, step);
    rates.roll = damp(rates.roll, targetRollRate, 12, step);
    rates.yaw = damp(rates.yaw, targetYawRate, 4, step);
    rates.worldPitch = damp(rates.worldPitch, worldPitchRate, 6, step);
    rates.turn = coordinatedTurnRate();

    if (rates.pitch !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_RIGHT, rates.pitch * step));
    if (rates.roll !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_FORWARD, rates.roll * step));
    if (rates.yaw !== 0) attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_UP, -rates.yaw * step));
    if (rates.worldPitch !== 0) attitude.premultiply(scratchQuaternion.setFromAxisAngle(horizontalRight, rates.worldPitch * step));
    if (rates.turn !== 0) attitude.premultiply(scratchQuaternion.setFromAxisAngle(WORLD_UP, -rates.turn * step));
    attitude.normalize();
  }

  function updateEnergy(step) {
    const terminalSpeed = SPEED.MAX * Math.pow(player.throttle, THROTTLE_SPEED_EXPONENT);
    let thrust = DRAG_COEFFICIENT * terminalSpeed * terminalSpeed;
    if (player.boost.active) thrust = Math.max(thrust, DRAG_COEFFICIENT * SPEED.BOOST_MAX * SPEED.BOOST_MAX);
    thrust *= 1 - 0.6 * assist.ceiling;
    const drag = DRAG_COEFFICIENT * speed * speed;
    const induced = INDUCED_DRAG * clamp(smoothedGForce - 1, 0, INDUCED_MAX_EXTRA_G);
    const gravityAlongPath = GRAVITY * pathDirection.y;
    speed += (thrust - drag - induced - gravityAlongPath) * step;
    if (!player.boost.active && speed > SPEED.MAX) speed = damp(speed, SPEED.MAX, 1.4, step);
    speed = clamp(speed, SPEED.MIN, SPEED.BOOST_MAX);
  }

  function updatePath(step) {
    bodyForward.set(0, 0, -1).applyQuaternion(attitude);
    const alignRate = 1.2 + 4.6 * frame.liftFactor;
    pathDirection.lerp(bodyForward, 1 - Math.exp(-alignRate * step));
    const mush = (1 - frame.liftFactor) * (1 - frame.liftFactor);
    pathDirection.y -= mush * 0.55 * step;
    pathDirection.normalize();
    if (assist.proximity > 0 || assist.risingTerrain > 0) {
      if (pathDirection.y < 0) pathDirection.y *= Math.exp(-assist.proximity * 7 * step);
      if (assist.risingTerrain > 0) pathDirection.y = Math.min(0.35, pathDirection.y + assist.risingTerrain * 0.9 * step);
      pathDirection.normalize();
    }
    if (assist.ceiling > 0 && pathDirection.y > 0) {
      pathDirection.y *= Math.exp(-assist.ceiling * 3 * step);
      pathDirection.normalize();
    }
  }

  function updateBarrelRoll(step) {
    if (!barrel.active) {
      barrel.angle = 0;
      player.barrelRoll.active = false;
      player.barrelRoll.progress = 0;
      return;
    }
    barrel.elapsed += step;
    const progress = Math.min(1, barrel.elapsed / BARREL_ROLL_DURATION);
    barrel.angle = Math.PI * 2 * easeRollProgress(progress) * barrel.direction;
    player.barrelRoll.progress = progress;
    if (progress >= 1) {
      barrel.active = false;
      barrel.angle = 0;
      player.barrelRoll.active = false;
      player.barrelRoll.progress = 1;
    }
  }

  function writeDerivedState(step) {
    player.quaternion.copy(attitude);
    if (barrel.active && barrel.angle !== 0) player.quaternion.multiply(rollOffset.setFromAxisAngle(LOCAL_FORWARD, barrel.angle));
    player.forward.set(0, 0, -1).applyQuaternion(player.quaternion);
    player.up.set(0, 1, 0).applyQuaternion(player.quaternion);
    player.right.set(1, 0, 0).applyQuaternion(player.quaternion);
    player.speed = speed;
    player.velocity.copy(pathDirection).multiplyScalar(speed);
    const horizontal = Math.hypot(player.forward.x, player.forward.z);
    if (horizontal > 0.05) player.heading = headingFromVector(player.forward.x, player.forward.z);
    else if (!Number.isFinite(player.heading)) player.heading = lastFiniteHeading;
    if (Number.isFinite(player.heading)) lastFiniteHeading = player.heading;
    player.pitch = Math.asin(clamp(player.forward.y, -1, 1)) / DEG;
    player.roll = Math.atan2(-player.right.y, player.up.y) / DEG;
    player.verticalSpeed = player.velocity.y;
    player.stalled = stalled;
    if (step > 0) {
      const headingChange = wrapSignedDegrees(player.heading - previousHeading) / step;
      smoothedYawRate = damp(smoothedYawRate, headingChange, 10, step);
      const loadFactor = computeLoadFactor();
      if (Number.isFinite(loadFactor)) smoothedGForce = damp(smoothedGForce, loadFactor, LOAD.SMOOTHING, step);
    }
    player.yawRate = smoothedYawRate;
    player.gForce = smoothedGForce;
    previousHeading = player.heading;
  }

  /**
   * Plausible load factor for this arcade model: cos(path pitch) / cos(bank) for the turn
   * (the model's exaggerated turn gain does not inflate it), plus a modest share of the
   * pitch-rate pull (v * q / g), both weaker on a slow wing, soft-capped toward LOAD.CAP.
   */
  function computeLoadFactor() {
    const liftShare = 0.35 + 0.65 * frame.liftFactor;
    const bankCos = Math.max(Math.abs(Math.cos(frame.bank)), LOAD.MIN_BANK_COS);
    const pathPitchCos = Math.sqrt(Math.max(0, 1 - pathDirection.y * pathDirection.y));
    const turnLoad = 1 + (pathPitchCos / bankCos - 1) * liftShare;
    const pitchRate = rates.pitch + rates.worldPitch * Math.cos(frame.bank);
    const pullLoad = ((speed * pitchRate) / GRAVITY) * LOAD.PULL_SHARE * liftShare;
    const rollLoad = barrel.active ? LOAD.BARREL_ROLL_EXTRA * Math.sin(Math.PI * player.barrelRoll.progress) : 0;
    const load = turnLoad + pullLoad + rollLoad;
    if (load <= LOAD.KNEE) return Math.max(load, LOAD.MIN);
    const headroom = LOAD.CAP - LOAD.KNEE;
    return LOAD.KNEE + headroom * Math.tanh((load - LOAD.KNEE) / headroom);
  }

  // ---- Visual animation state ------------------------------------------------------------------
  /**
   * v1's animateModel minus the mesh writes: damped control-surface deflections (normalized, the
   * craft mesh turns them into angles), the gentle air wobble and the barrel-roll corkscrew offset.
   */
  function animateModel(step) {
    const elevatorTarget = clamp(rates.pitch / MAX_PITCH_RATE + (rates.worldPitch / MAX_PITCH_RATE) * 0.6, -1, 1);
    const aileronTarget = barrel.active ? barrel.direction : clamp((rates.roll / MAX_ROLL_RATE) * 1.3, -1, 1);
    const rudderTarget = clamp(rates.yaw / MAX_YAW_RATE + (rates.turn / MAX_TURN_RATE) * SURFACE_TURN_SHARE, -1, 1);
    controlSurfaces.elevator = damp(controlSurfaces.elevator, elevatorTarget, 12, step);
    controlSurfaces.aileron = damp(controlSurfaces.aileron, aileronTarget, 12, step);
    controlSurfaces.rudder = damp(controlSurfaces.rudder, rudderTarget, 10, step);
    writeVisual();

    const elapsed = state.time.elapsed;
    const turbulence = 0.35 + 0.65 * clamp(player.inCloud ?? 0, 0, 1) + 0.4 * smooth01((speed - SPEED.CRUISE) / (SPEED.MAX - SPEED.CRUISE));
    wobbleEuler.set(
      (Math.sin(elapsed * 1.31) * 0.6 + Math.sin(elapsed * 2.73 + 1.2) * 0.4) * 0.3 * DEG * turbulence,
      Math.sin(elapsed * 0.97 + 0.4) * 0.15 * DEG * turbulence,
      (Math.sin(elapsed * 1.07 + 2.1) * 0.6 + Math.sin(elapsed * 2.21) * 0.4) * 0.55 * DEG * turbulence,
      'YXZ',
    );
    wobbleQuaternion.setFromEuler(wobbleEuler);

    if (barrel.active) {
      const theta = Math.abs(barrel.angle);
      bodyUp.set(0, 1, 0).applyQuaternion(attitude);
      bodyRight.set(1, 0, 0).applyQuaternion(attitude);
      corkscrewOffset.copy(bodyUp).multiplyScalar(Math.sin(theta) * BARREL_ROLL_RADIUS)
        .addScaledVector(bodyRight, barrel.direction * (1 - Math.cos(theta)) * BARREL_ROLL_RADIUS);
    } else {
      corkscrewOffset.set(0, 0, 0);
    }
  }

  function writeVisual() {
    visual.aileron = controlSurfaces.aileron;
    visual.elevator = controlSurfaces.elevator;
    visual.rudder = controlSurfaces.rudder;
    visual.throttle = player.throttle;
    visual.boost = player.boost.active;
    visual.time = state.time;
  }

  // ---- Public actions -----------------------------------------------------------------------------
  function boost() {
    const boostState = player.boost;
    if (state.photoMode || boostState.active || boostState.cooldown > 0) return false;
    boostState.active = true;
    boostState.remaining = BOOST_DURATION;
    boostState.cooldown = BOOST_COOLDOWN;
    boostState.cooldownTotal = BOOST_COOLDOWN;
    bus.emit('boost', {});
    return true;
  }

  function barrelRoll(direction) {
    if (barrel.active || state.photoMode) return false;
    const rollDirection = direction === 'left' || direction < 0 ? -1 : 1;
    attitude.copy(player.quaternion);
    barrel.active = true;
    barrel.direction = rollDirection;
    barrel.elapsed = 0;
    barrel.angle = 0;
    player.barrelRoll.active = true;
    player.barrelRoll.direction = rollDirection;
    player.barrelRoll.progress = 0;
    bus.emit('barrelroll', { direction: rollDirection });
    return true;
  }

  function setAutopilot(options = {}) {
    const autopilot = player.autopilot;
    const wasEnabled = autopilot.enabled;
    if (typeof options.enabled === 'boolean') autopilot.enabled = options.enabled;
    const engaging = autopilot.enabled && !wasEnabled;
    if (Number.isFinite(options.heading)) autopilot.heading = wrapDegrees(options.heading);
    else if (engaging) autopilot.heading = player.heading;
    if (Number.isFinite(options.altitude)) autopilot.altitude = clamp(options.altitude, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    else if (engaging) autopilot.altitude = clamp(player.position.y, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    if (typeof options.followWaypoint === 'boolean') autopilot.followWaypoint = options.followWaypoint;
    if (engaging) {
      autopilotState.throttleOverride = false;
      autopilotState.overrideSeconds = 0;
      autopilotState.commandedBank = frame.bank;
      lookahead.age = Infinity;
    }
    const reason = typeof options.reason === 'string' && options.reason ? options.reason : 'command';
    bus.emit('autopilot:changed', {
      enabled: autopilot.enabled,
      heading: autopilot.heading,
      altitude: autopilot.altitude,
      followWaypoint: autopilot.followWaypoint,
      reason,
    });
    return { ...autopilot };
  }

  /** Level flight at cruise from (x, y, z); also core's recovery path after a non-finite pose. */
  function resetTo(target = {}) {
    const { x, y, z } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    let heading = lastFiniteHeading;
    if (Number.isFinite(target.heading)) heading = wrapDegrees(target.heading);
    else if (Number.isFinite(player.heading)) heading = player.heading;
    player.position.set(x, y, z);
    lastFinitePosition.set(x, y, z);
    attitude.setFromAxisAngle(WORLD_UP, -heading * DEG);
    vectorFromHeading(heading, pathDirection);
    speed = SPEED.CRUISE;
    resetInternals(heading);
    player.boost.active = false;
    player.boost.remaining = 0;
    player.boost.cooldown = 0;
    player.heading = heading;
    lastFiniteHeading = heading;
    if (player.autopilot.enabled) {
      player.autopilot.heading = heading;
      player.autopilot.altitude = clamp(y, AUTOPILOT.MIN_ALTITUDE, CONFIG.MAX_ALTITUDE - 150);
    }
    computeAttitudeFrame();
    writeDerivedState(0);
    writeVisual();
    return true;
  }

  /**
   * Takes over a pose from another model (mode switch, craft switch, respawn): position, attitude
   * and velocity carry over. The arcade speed scalar and path direction come from the velocity
   * vector (speed clamped to this craft's arcade range); the bank is limited to the arcade stick's
   * MAX_BANK so the v1 rule "the stick alone never leaves the craft inverted" holds from the start.
   */
  function reset(pose = {}) {
    const position = pose.position ?? player.position;
    if (!isFiniteVector(position)) return false;
    player.position.copy(position);
    lastFinitePosition.copy(position);
    if (pose.quaternion && isFiniteQuaternion(pose.quaternion)) attitude.copy(pose.quaternion).normalize();
    computeAttitudeFrame();
    if (Math.abs(frame.bank) > MAX_BANK) {
      const correction = Math.sign(frame.bank) * MAX_BANK - frame.bank;
      attitude.multiply(scratchQuaternion.setFromAxisAngle(LOCAL_FORWARD, correction));
      attitude.normalize();
    }
    const velocity = pose.velocity;
    const velocityLength = velocity && isFiniteVector(velocity) ? velocity.length() : 0;
    if (velocityLength > 1) pathDirection.copy(velocity).divideScalar(velocityLength);
    else pathDirection.set(0, 0, -1).applyQuaternion(attitude);
    speed = clamp(velocityLength > 1 ? velocityLength : SPEED.CRUISE, SPEED.MIN, SPEED.BOOST_MAX);
    if (Number.isFinite(pose.throttle)) player.throttle = clamp(pose.throttle, 0, 1);
    bodyForward.set(0, 0, -1).applyQuaternion(attitude);
    const heading = Math.hypot(bodyForward.x, bodyForward.z) > 0.05 ? headingFromVector(bodyForward.x, bodyForward.z) : lastFiniteHeading;
    throttleGoal = null;
    lastThrottleTarget = input.throttleTarget;
    resetInternals(heading);
    player.boost.active = false;
    player.boost.remaining = 0;
    player.heading = heading;
    lastFiniteHeading = heading;
    computeAttitudeFrame();
    writeDerivedState(0);
    writeVisual();
    return true;
  }

  // ---- Telemetry and snapshots -------------------------------------------------------------------
  const bodyAir = new THREE.Vector3();
  const inverseAttitude = new THREE.Quaternion();

  /** Fills the state.flight fields this model knows (the controller writes pose and environment). */
  function writeTelemetry(flight) {
    inverseAttitude.copy(player.quaternion).invert();
    bodyAir.copy(pathDirection).applyQuaternion(inverseAttitude);
    flight.aoa = Math.atan2(-bodyAir.y, -bodyAir.z) / DEG;
    flight.sideslip = Math.asin(clamp(bodyAir.x, -1, 1)) / DEG;
    flight.gLoad = player.gForce;
    flight.throttle = player.throttle;
    flight.rpm = player.throttle;
    flight.engineOn = true;
    flight.afterburner = player.boost.active;
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.airbrake = 0;
    flight.brakes = 0;
    flight.trim = 0;
    flight.onGround = false;
    flight.contacts = 0;
    flight.stall.stalled = stalled;
    flight.stall.warning = stalled || speed < SPEED.STALL + STALL_EXIT_MARGIN;
    flight.stall.buffet = stalled ? 1 : smooth01((SPEED.STALL + STALL_EXIT_MARGIN - speed) / STALL_EXIT_MARGIN);
  }

  /** Full internal state as plain data (restore() puts it back exactly). */
  function snapshot() {
    return {
      kind: 'arcade',
      attitude: attitude.toArray(),
      pathDirection: pathDirection.toArray(),
      speed,
      stalled,
      idleSeconds,
      pitchIdleSeconds,
      throttleGoal,
      lastThrottleTarget,
      previousHeading,
      lastFiniteHeading,
      lastFinitePosition: lastFinitePosition.toArray(),
      smoothedYawRate,
      smoothedGForce,
      rates: { ...rates },
      assist: { ...assist },
      barrel: { ...barrel },
      autopilotState: { ...autopilotState },
      controlSurfaces: { ...controlSurfaces },
      corkscrewOffset: corkscrewOffset.toArray(),
      player: {
        position: player.position.toArray(),
        velocity: player.velocity.toArray(),
        quaternion: player.quaternion.toArray(),
        speed: player.speed,
        throttle: player.throttle,
        heading: player.heading,
        boost: { ...player.boost },
        barrelRoll: { ...player.barrelRoll },
      },
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'arcade') return false;
    attitude.fromArray(data.attitude);
    pathDirection.fromArray(data.pathDirection);
    speed = data.speed;
    stalled = data.stalled;
    idleSeconds = data.idleSeconds;
    pitchIdleSeconds = data.pitchIdleSeconds;
    throttleGoal = data.throttleGoal;
    lastThrottleTarget = data.lastThrottleTarget;
    previousHeading = data.previousHeading;
    lastFiniteHeading = data.lastFiniteHeading;
    lastFinitePosition.fromArray(data.lastFinitePosition);
    smoothedYawRate = data.smoothedYawRate;
    smoothedGForce = data.smoothedGForce;
    Object.assign(rates, data.rates);
    Object.assign(assist, data.assist);
    Object.assign(barrel, data.barrel);
    Object.assign(autopilotState, data.autopilotState);
    Object.assign(controlSurfaces, data.controlSurfaces);
    corkscrewOffset.fromArray(data.corkscrewOffset);
    player.position.fromArray(data.player.position);
    player.velocity.fromArray(data.player.velocity);
    player.quaternion.fromArray(data.player.quaternion);
    player.speed = data.player.speed;
    player.throttle = data.player.throttle;
    player.heading = data.player.heading;
    Object.assign(player.boost, data.player.boost);
    Object.assign(player.barrelRoll, data.player.barrelRoll);
    computeAttitudeFrame();
    writeVisual();
    return true;
  }

  computeAttitudeFrame();
  writeDerivedState(0);
  writeVisual();

  return {
    kind: 'arcade',
    profile,
    state: modelState,
    contact,
    visual,
    corkscrewOffset,
    wobbleQuaternion,

    /** One v1 variable step: controls is the v1 input struct (ctx.input); env is unused (no wind in v1). */
    step(dt, controls) {
      if (!(dt > 0)) return;
      if (controls) input = controls;
      const step = Math.min(dt, 0.05);
      syncFromState();
      updateThrottle(step);
      if (input.boost) boost();
      updateBoost(step);
      updateAutopilotOverride(step);
      computeAttitudeFrame();
      updateStall();
      updateTerrainAssist(step);
      updateRotation(step);
      updateEnergy(step);
      updatePath(step);
      player.position.addScaledVector(pathDirection, speed * step);
      if (isFiniteVector(player.position)) lastFinitePosition.copy(player.position);
      updateBarrelRoll(step);
      writeDerivedState(step);
      animateModel(step);
    },

    reset,
    resetTo,
    setAutopilot,
    barrelRoll,
    boost,
    writeTelemetry,
    snapshot,
    restore,

    /** Attitude without the canned barrel-roll offset (keeps the chase camera steady). */
    getBaseQuaternion() {
      return attitude;
    },

    /** Air-path direction (unit) and speed scalar: what a mode switch converts to a velocity vector. */
    getPath(target = new THREE.Vector3()) {
      return target.copy(pathDirection).multiplyScalar(speed);
    },

    getStats() {
      return {
        stalled,
        cushion: Math.round(assist.cushion * 100) / 100,
        idleSeconds: Math.round(idleSeconds * 10) / 10,
        baseBank: Math.round(frame.bank / DEG),
        turnRate: Math.round((rates.turn / DEG) * 10) / 10,
        barrelRoll: barrel.active,
      };
    },
  };
}
