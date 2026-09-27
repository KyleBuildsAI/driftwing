// SIM autopilot: flies THROUGH the flight model. It never sets the attitude; it moves the stick,
// rudder and throttle with PID loops, as one control stage (flightModels.registerControlStage) that
// runs before the assists (whose limiters then protect its commands).
//
// Targets come from player.autopilot (v1's options: enabled, heading, altitude, followWaypoint, plus
// speed): waypoint and ring following steer toward the waypoint, or to a lead point on the next
// ring's axis at the ring's height (as v1 does), and a terrain look-ahead raises the altitude target
// to clear the ground ahead, turning away from terrain it cannot out-climb.
//
// Loops (fixed-wing):
//   heading  -> bank angle (rate-limited)       -> aileron   (PD on bank with roll-rate damping)
//   altitude -> vertical speed -> flight path   -> load factor -> elevator (PI with pitch damping)
//   speed    -> throttle (PI) on powered craft; engineless craft hold speed with pitch instead
//   yaw      -> rudder nulls sideslip (turn coordination)
// Integrators are clamped and stop winding while their output saturates, the outputs are rate
// limited, and on engagement every loop starts from the current stick, bank and flight path, so the
// autopilot takes over smoothly from any attitude.
import { DEG, clamp, bearingTo, headingFromVector } from '../core/util.js';

export const AUTOPILOT_STAGE_ORDER = 20;

const GRAVITY = 9.81;
const FIXED_WING = Object.freeze({
  MAX_BANK: 28 * DEG,
  RING_MAX_BANK: 38 * DEG,
  BANK_PER_HEADING: 1.1,
  BANK_SLEW: 12 * DEG,
  BANK_GAIN: 1.8,
  ROLL_RATE_GAIN: 0.55,
  ROLL_LIMIT: 0.7,
  CLIMB_PER_METRE: 0.06,
  MAX_CLIMB: 6,
  MAX_DESCENT: 6,
  FLIGHT_PATH_GAIN: 0.9,
  LOAD_MIN: 0.4,
  LOAD_MAX: 1.9,
  LOAD_P: 0.55,
  LOAD_I: 0.9,
  PITCH_DAMPING: 0.35,
  PITCH_LIMIT: 0.85,
  /** Engineless craft trade height for speed: flight-path rate (rad/s) per m/s of speed error and per m/s^2. */
  GLIDE_SPEED_GAIN: 0.02,
  GLIDE_ACCELERATION_GAIN: 0.06,
  GLIDE_PATH_MAX: 12 * DEG,
  GLIDE_PATH_MIN: -25 * DEG,
  THROTTLE_P: 0.06,
  THROTTLE_I: 0.03,
  THROTTLE_SLEW: 0.6,
  /** Speed protection: below MIN_SPEED_FACTOR x stall speed the climb demand is traded for speed. */
  MIN_SPEED_FACTOR: 1.35,
  SPEED_PROTECTION_GAIN: 0.8,
  YAW_SIDESLIP_GAIN: 4,
  YAW_LIMIT: 0.6,
  OUTPUT_SLEW: 2.5,
  /** Gains are tuned at this multiple of the stall speed and scaled by dynamic pressure elsewhere (clamped). */
  SCHEDULE_REFERENCE: 1.5,
  SCHEDULE_MIN: 0.12,
  SCHEDULE_MAX: 2,
  GROUND_STEER_GAIN: 0.05,
  // Terrain look-ahead (seconds of flight ahead) and clearance above ground or water.
  LOOKAHEAD_SECONDS: Object.freeze([0, 4, 8, 14, 22, 32, 45]),
  LOOKAHEAD_MAX_DISTANCE: 2600,
  LOOKAHEAD_REFRESH: 0.5,
  CLEARANCE: 120,
  RING_CLEARANCE: 45,
  CLIMB_GRADIENT_POWERED: 0.1,
  EVADE_HEADING: 55,
  RING_LEAD_SECONDS: 2.4,
  RING_LEAD_MIN: 80,
  RING_LEAD_MAX: 200,
  RING_LOOKAHEAD_MARGIN: 150,
  RING_MIN_TIME: 1.5,
});

function wrapSigned(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function createFixedWingMemory() {
  return {
    resetCount: -1,
    engaged: false,
    bankCommand: 0,
    loadIntegral: 0,
    throttleIntegral: 0,
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    lastSpeed: NaN,
    lookaheadAge: Infinity,
    lookaheadX: NaN,
    lookaheadZ: NaN,
    lookaheadHeading: NaN,
    terrainFloor: -Infinity,
    terrainGradient: -Infinity,
    evadeOffset: 0,
    target: { heading: 0, altitude: 0, clearance: FIXED_WING.CLEARANCE, ring: false, ringDistance: 0, lookaheadLimit: Infinity },
  };
}

/** Surface height (ground or water) at a point from the shared height function. */
function surfaceAt(world, waterLevel, x, z) {
  return Math.max(world.groundHeight(x, z), waterLevel);
}

/** Heading and altitude targets: the autopilot's, a waypoint, or a lead point on the next ring's axis (v1). */
function resolveTarget(memory, autopilot, game, position, speed) {
  const target = memory.target;
  target.heading = autopilot.heading;
  target.altitude = autopilot.altitude;
  target.clearance = FIXED_WING.CLEARANCE;
  target.ring = false;
  target.ringDistance = 0;
  target.lookaheadLimit = Infinity;
  if (!autopilot.followWaypoint || !game) return target;
  const course = game.ringCourse;
  const ring = course && course.active ? course.nextRingPosition : null;
  if (ring && Number.isFinite(ring.x) && Number.isFinite(ring.z)) {
    const toRingX = ring.x - position.x;
    const toRingZ = ring.z - position.z;
    const distance = Math.hypot(toRingX, toRingZ);
    target.ring = true;
    target.ringDistance = distance;
    target.clearance = FIXED_WING.RING_CLEARANCE;
    target.lookaheadLimit = distance + FIXED_WING.RING_LOOKAHEAD_MARGIN;
    target.heading = headingFromVector(toRingX, toRingZ);
    if (Number.isFinite(ring.y)) target.altitude = ring.y;
    const normal = course.nextRingNormal;
    const axisLength = normal ? Math.hypot(normal.x, normal.z) : 0;
    if (axisLength > 0.2) {
      const axisX = normal.x / axisLength;
      const axisZ = normal.z / axisLength;
      const along = toRingX * axisX + toRingZ * axisZ;
      const lead = clamp(speed * FIXED_WING.RING_LEAD_SECONDS, FIXED_WING.RING_LEAD_MIN, FIXED_WING.RING_LEAD_MAX);
      target.heading = headingFromVector(toRingX + axisX * (lead - along), toRingZ + axisZ * (lead - along));
    }
  } else if (game.waypoint && Number.isFinite(game.waypoint.x) && Number.isFinite(game.waypoint.z)) {
    target.heading = bearingTo(position.x, position.z, game.waypoint.x, game.waypoint.z);
  }
  autopilot.heading = target.heading;
  if (target.ring) autopilot.altitude = target.altitude;
  return target;
}

/**
 * Terrain look-ahead along the target heading and the current track (refreshed twice a second):
 * the altitude floor (highest surface ahead plus clearance) and the steepest climb gradient needed.
 */
function refreshTerrain(memory, env, position, headingDegrees, trackDegrees, speed, clearance, limit, dt) {
  memory.lookaheadAge += dt;
  const moved = Math.hypot(position.x - memory.lookaheadX, position.z - memory.lookaheadZ);
  const turned = Math.abs(wrapSigned(headingDegrees - memory.lookaheadHeading));
  if (memory.lookaheadAge < FIXED_WING.LOOKAHEAD_REFRESH && moved < 60 && turned < 5) return;
  memory.lookaheadAge = 0;
  memory.lookaheadX = position.x;
  memory.lookaheadZ = position.z;
  memory.lookaheadHeading = headingDegrees;
  const world = env.world;
  let floor = env.waterLevel + clearance;
  let gradient = -Infinity;
  const groundSpeed = Math.max(speed, 15);
  for (const direction of [headingDegrees, trackDegrees]) {
    const directionX = Math.sin(direction * DEG);
    const directionZ = -Math.cos(direction * DEG);
    for (const seconds of FIXED_WING.LOOKAHEAD_SECONDS) {
      const distance = Math.min(seconds * groundSpeed, FIXED_WING.LOOKAHEAD_MAX_DISTANCE);
      if (distance > limit) break;
      const needed = surfaceAt(world, env.waterLevel, position.x + directionX * distance, position.z + directionZ * distance) + clearance;
      floor = Math.max(floor, needed);
      if (distance > 60) gradient = Math.max(gradient, (needed - position.y) / distance);
    }
  }
  memory.terrainFloor = floor;
  memory.terrainGradient = gradient;
}

/** Which side (+1 right, -1 left) is lower about 2 km ahead, for turning away from terrain. */
function lowerSide(env, position, headingDegrees) {
  let left = 0;
  let right = 0;
  for (const distance of [600, 1200, 2000]) {
    for (const side of [-1, 1]) {
      const direction = (headingDegrees + side * FIXED_WING.EVADE_HEADING) * DEG;
      const height = surfaceAt(env.world, env.waterLevel, position.x + Math.sin(direction) * distance, position.z - Math.cos(direction) * distance);
      if (side < 0) left = Math.max(left, height);
      else right = Math.max(right, height);
    }
  }
  return right <= left ? 1 : -1;
}

function engage(memory, controls, data) {
  memory.engaged = true;
  memory.bankCommand = data.bank;
  // The load loop's integrator starts at the stick the model is flying with now (auto-trim included).
  memory.loadIntegral = clamp(data.pitchCommand, -FIXED_WING.PITCH_LIMIT, FIXED_WING.PITCH_LIMIT);
  memory.pitch = memory.loadIntegral;
  memory.roll = clamp(controls.roll, -1, 1);
  memory.yaw = clamp(controls.yaw, -1, 1);
  memory.throttle = data.throttle;
  memory.throttleIntegral = data.throttle;
  memory.lookaheadAge = Infinity;
  memory.evadeOffset = 0;
  memory.lastSpeed = NaN;
}

const fixedWingAutopilot = Object.freeze({
  createMemory: createFixedWingMemory,

  apply(controls, context, memory) {
    const autopilot = context.autopilot;
    if (!autopilot || !autopilot.enabled) {
      memory.engaged = false;
      return false;
    }
    const model = context.model;
    const data = model.flightData;
    const env = context.env;
    const dt = context.dt;
    const position = model.state.position;
    if (!memory.engaged) engage(memory, controls, data);

    const speed = Math.max(data.airspeed, 1);
    const target = resolveTarget(memory, autopilot, context.game, position, speed);

    if (data.onGround) {
      // On the ground it only keeps the wings level and steers the heading with the rudder; take-off is the pilot's.
      const headingError = wrapSigned(target.heading - data.heading);
      memory.roll = moveToward(memory.roll, clamp(-FIXED_WING.BANK_GAIN * data.bank, -0.5, 0.5), FIXED_WING.OUTPUT_SLEW * dt);
      memory.yaw = moveToward(memory.yaw, clamp(headingError * FIXED_WING.GROUND_STEER_GAIN, -1, 1), FIXED_WING.OUTPUT_SLEW * dt);
      controls.roll = memory.roll;
      controls.yaw = memory.yaw;
      memory.loadIntegral = data.pitchCommand;
      return true;
    }

    // ---- Terrain and targets -------------------------------------------------------------------------
    const velocity = model.state.velocity;
    const track = Math.hypot(velocity.x, velocity.z) > 2 ? headingFromVector(velocity.x, velocity.z) : data.heading;
    refreshTerrain(memory, env, position, target.heading, track, Math.hypot(velocity.x, velocity.z), target.clearance, target.lookaheadLimit, dt);
    const powered = data.hasEngine && data.engineRunning;
    const achievable = powered ? FIXED_WING.CLIMB_GRADIENT_POWERED : -0.02;
    const blocked = memory.terrainGradient > achievable && memory.terrainFloor > position.y;
    if (blocked && memory.evadeOffset === 0) memory.evadeOffset = lowerSide(env, position, data.heading) * FIXED_WING.EVADE_HEADING;
    else if (!blocked && memory.terrainGradient < achievable - 0.05) memory.evadeOffset = 0;
    const headingTarget = target.heading + memory.evadeOffset;
    const altitudeTarget = Math.max(target.altitude, memory.terrainFloor);

    // Gain schedule: the stick's authority grows with dynamic pressure, so the loop gains shrink as the
    // speed rises (they are tuned at 1.5 x the stall speed).
    const referenceSpeed = Math.max(data.stallSpeed * FIXED_WING.SCHEDULE_REFERENCE, 5);
    const pitchSchedule = clamp((referenceSpeed * referenceSpeed) / (speed * speed), FIXED_WING.SCHEDULE_MIN, FIXED_WING.SCHEDULE_MAX);
    const rollSchedule = clamp(referenceSpeed / speed, Math.sqrt(FIXED_WING.SCHEDULE_MIN), Math.sqrt(FIXED_WING.SCHEDULE_MAX));

    // ---- Lateral: heading -> bank -> aileron; rudder coordinates ------------------------------------------
    const maxBank = target.ring ? FIXED_WING.RING_MAX_BANK : FIXED_WING.MAX_BANK;
    const headingError = wrapSigned(headingTarget - data.heading);
    const desiredBank = clamp(headingError * FIXED_WING.BANK_PER_HEADING * DEG, -maxBank, maxBank);
    memory.bankCommand = moveToward(memory.bankCommand, desiredBank, FIXED_WING.BANK_SLEW * dt);
    const rollTarget = clamp(rollSchedule * (FIXED_WING.BANK_GAIN * (memory.bankCommand - data.bank) - FIXED_WING.ROLL_RATE_GAIN * data.rollRate), -FIXED_WING.ROLL_LIMIT, FIXED_WING.ROLL_LIMIT);
    memory.roll = moveToward(memory.roll, rollTarget, FIXED_WING.OUTPUT_SLEW * dt);
    const yawTarget = clamp(FIXED_WING.YAW_SIDESLIP_GAIN * data.sideslip, -FIXED_WING.YAW_LIMIT, FIXED_WING.YAW_LIMIT);
    memory.yaw = moveToward(memory.yaw, yawTarget, FIXED_WING.OUTPUT_SLEW * dt);

    // ---- Vertical: altitude (or speed, without an engine) -> flight path -> load factor -> elevator --------
    const targetSpeed = clamp(Number.isFinite(autopilot.speed) && autopilot.speed > 0 ? autopilot.speed : speed, data.stallSpeed * FIXED_WING.MIN_SPEED_FACTOR, data.vne * 0.85);
    const cosBank = Math.max(Math.cos(clamp(data.bank, -1.3, 1.3)), 0.3);
    let flightPathRate;
    if (powered) {
      let climb = clamp((altitudeTarget - position.y) * FIXED_WING.CLIMB_PER_METRE, -FIXED_WING.MAX_DESCENT, FIXED_WING.MAX_CLIMB);
      if (target.ring && target.ringDistance > 0) {
        const timeToRing = Math.max(target.ringDistance / speed, FIXED_WING.RING_MIN_TIME);
        climb = clamp((altitudeTarget - position.y) / timeToRing, -FIXED_WING.MAX_DESCENT, FIXED_WING.MAX_CLIMB);
      }
      // Speed protection: when slow, give up climb for speed before the stall gets close.
      const minimumSpeed = data.stallSpeed * FIXED_WING.MIN_SPEED_FACTOR;
      if (speed < minimumSpeed) climb = Math.min(climb, -(minimumSpeed - speed) * FIXED_WING.SPEED_PROTECTION_GAIN);
      const desiredPath = Math.asin(clamp(climb / speed, -0.5, 0.5));
      flightPathRate = FIXED_WING.FLIGHT_PATH_GAIN * (desiredPath - data.flightPath);
    } else {
      // Without an engine the pitch holds speed: too fast -> raise the flight path, too slow -> lower
      // it, damped by the acceleration so the phugoid settles.
      const acceleration = Number.isFinite(memory.lastSpeed) ? clamp((speed - memory.lastSpeed) / dt, -8, 8) : 0;
      flightPathRate = FIXED_WING.GLIDE_SPEED_GAIN * (speed - targetSpeed) + FIXED_WING.GLIDE_ACCELERATION_GAIN * acceleration;
      // Bleed off excess speed in a gentle zoom, and give speed back in a moderate dive at most.
      if (data.flightPath > FIXED_WING.GLIDE_PATH_MAX) flightPathRate = Math.min(flightPathRate, FIXED_WING.FLIGHT_PATH_GAIN * (FIXED_WING.GLIDE_PATH_MAX - data.flightPath));
      if (data.flightPath < FIXED_WING.GLIDE_PATH_MIN) flightPathRate = Math.max(flightPathRate, FIXED_WING.FLIGHT_PATH_GAIN * (FIXED_WING.GLIDE_PATH_MIN - data.flightPath));
    }
    memory.lastSpeed = speed;
    const loadTarget = clamp((Math.cos(data.flightPath) + (speed * flightPathRate) / GRAVITY) / cosBank, FIXED_WING.LOAD_MIN, FIXED_WING.LOAD_MAX);
    const loadError = loadTarget - data.gLoad;
    const pitchUnclamped = memory.loadIntegral + pitchSchedule * (FIXED_WING.LOAD_P * loadError - FIXED_WING.PITCH_DAMPING * data.pitchRate);
    const saturated = (pitchUnclamped >= FIXED_WING.PITCH_LIMIT && loadError > 0) || (pitchUnclamped <= -FIXED_WING.PITCH_LIMIT && loadError < 0);
    if (!saturated) memory.loadIntegral = clamp(memory.loadIntegral + pitchSchedule * FIXED_WING.LOAD_I * loadError * dt, -FIXED_WING.PITCH_LIMIT, FIXED_WING.PITCH_LIMIT);
    memory.pitch = moveToward(memory.pitch, clamp(pitchUnclamped, -FIXED_WING.PITCH_LIMIT, FIXED_WING.PITCH_LIMIT), FIXED_WING.OUTPUT_SLEW * dt);

    // ---- Speed -> throttle (powered) ------------------------------------------------------------------------
    if (powered) {
      const speedError = targetSpeed - speed;
      const throttleUnclamped = memory.throttleIntegral + FIXED_WING.THROTTLE_P * speedError;
      const throttleSaturated = (throttleUnclamped >= 1 && speedError > 0) || (throttleUnclamped <= 0 && speedError < 0);
      if (!throttleSaturated) memory.throttleIntegral = clamp(memory.throttleIntegral + FIXED_WING.THROTTLE_I * speedError * dt, 0, 1);
      memory.throttle = moveToward(memory.throttle, clamp(throttleUnclamped, 0, 1), FIXED_WING.THROTTLE_SLEW * dt);
      controls.throttle = memory.throttle;
    }

    controls.roll = memory.roll;
    controls.pitch = memory.pitch;
    controls.yaw = memory.yaw;
    return true;
  },
});

const handlers = new Map([['fixedWing', fixedWingAutopilot]]);

/** Registers the autopilot of another model kind: { createMemory(), apply(controls, context, memory) -> flying }. */
export function registerAutopilotHandler(kind, handler) {
  if (!handler || typeof handler.apply !== 'function') throw new TypeError(`autopilot handler for "${kind}" needs apply()`);
  handlers.set(kind, handler);
}

/** The autopilot control stage (per-model memory, re-created when the model is reset). */
export function createAutopilotStage() {
  const memories = new WeakMap();
  return {
    id: 'autopilot',
    order: AUTOPILOT_STAGE_ORDER,
    apply(controls, context) {
      const model = context.model;
      if (!model || !(context.dt > 0)) return;
      const handler = handlers.get(model.kind);
      if (!handler) return;
      let memory = memories.get(model);
      const resetCount = Number.isFinite(model.resetCount) ? model.resetCount : 0;
      if (!memory || memory.resetCount !== resetCount) {
        memory = handler.createMemory();
        memory.resetCount = resetCount;
        memories.set(model, memory);
      }
      if (handler.apply(controls, context, memory)) context.activeAssists.push('autopilot');
    },
  };
}
