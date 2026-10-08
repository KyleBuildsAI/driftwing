// SimFlapper: the SIM flight model of the flapping creature (the eagle and its dragon skin; model
// kind 'flapper', contract h.1), with its perch.
//
// A 6-DOF rigid body in SI units (centre of mass = mesh origin; body axes x right, y up, z aft)
// integrated at the controller's fixed 120 Hz:
//   wing       one cambered, moderate aspect-ratio wing (the arm and hand wings together): a lift curve
//              with a post-stall drop, profile plus induced drag (best glide about 12 : 1 near 45 km/h,
//              the least sink about 0.9 m/s), a side force from sideslip and ground effect within a
//              span of the surface
//   flapping   the throttle axis is flap power (0 = glide). The wingbeat turns muscle power into
//              thrust (efficiency x power / speed, so it pushes hardest when slow) along a stroke plane
//              that tilts up at low speed, raises the wing's maximum lift at low speed (the unsteady
//              lift of a flapping wing) and keeps control authority when the air alone is too slow for
//              it. Full power climbs at about 3 m/s; it cannot hover.
//   tuck       pushing the stick past PUSH_START (or holding the tuck ability) folds the wings: the
//              area and span shrink, the trim angle of attack falls and the bird stoops at up to about
//              70 m/s; folded wings cannot flap and roll less
//   pitch      body and tail set the trim angle of attack: pull raises it toward the slow, high-lift
//              end and the stall, push lowers it; the bird's pitch stability brings the body back to
//              that trim (stable, damped)
//   roll/yaw   wing twist rolls the body (authority scales with dynamic pressure), the banked lift
//              turns it, the tail weathervanes it into the turn
//   stall      past the critical angle of attack the lift breaks and the body pitches up a little
//              more while the pilot keeps pulling; easing the stick recovers (always, with height)
// Wind (air-relative velocity) and turbulence (small shaking moments) apply throughout, so thermals,
// ridge lift and wave in the WindField carry the bird like the glider: it soars on them with the
// flap power at zero.
//
// PERCH. While flying slowly (below perch.captureSpeed) the model looks for a perch every
// SCAN_SECONDS: tagged perch points of the collider service (structure tops, tree tops from the
// vegetation perch provider: env.colliders.perchesNear) and terrain peaks (a local top higher than
// two rings around it) within perch.captureRadius ahead and a few metres around the bird's height,
// with a clear line of flight to it. Then the auto-landing flies a smooth kinematic curve from the
// bird's position and velocity to the perch, flaring the body, and the bird stands there (phase
// 'perched'): held still, it turns on the spot with the stick or pedals, and flap power raised past
// where it was when the bird settled (or the takeoffRequest of the copilot) takes off with a hop.
// A slow touchdown on its feet anywhere on the ground ends standing the same way; a fast one is the
// Phase 1 soft crash (the controller reads the contact report). The typed perched event announces
// both ends of a perch (peaks, structures and trees; standing on plain ground is a landing).
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces, flightData (read by the
// flapper assists and autopilot) and dispose(). craftState (contract h.3, shared with the abilities,
// the mesh, audio, the instruments and the copilot): perched, perchId, perchKind, flapPower,
// wingTuck, landing (0..1 through the auto-landing), flapPhase, flapAmplitude, flapCount,
// perchedSeconds, soarGain; the abilities write tuckRequest, takeoffRequest, perchTarget (the
// copilot's "find a perch": the autopilot flies the approach) and lanternsLit.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector, bearingTo } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, evaluateLift, groundEffectFactor, smoothstep } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler, stallWarningActive } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';
import { surfaceHeightAt, waterHeightAt } from './waterSurface.js';

const MAX_ANGULAR_SPEED = 9;
const MAX_SPEED = 110;
const LOAD_SMOOTHING = 20;
/** Limbs (wing twist, body and tail) move at this rate (full travel per second fraction). */
const LIMB_RATE = 6;
/** Flat-plate drag of the wing broadside to the flow (CD at 90 degrees of angle of attack). */
const BROADSIDE_DRAG = 1.2;
const STALL_BREAK_SPAN = 30 * DEG;
const STALLED_DEPTH = 0.5;
const GLIDE_SMOOTHING = 1.5;
/** Stick push past this folds the wings progressively (to full at full push). */
const PUSH_START = 0.45;
/** Flap power under this is a glide (no wingbeat). */
const GLIDE_POWER = 0.03;
/** Perch search period while slow (s), and the line-of-flight margin short of the perch (m). */
const SCAN_SECONDS = 0.1;
const SIGHT_MARGIN = 0.4;
/** A perch the bird took off from cannot catch it again for this long or until this far away. */
const RECAPTURE_DISTANCE = 20;
/** Standing on the ground: slower than this over the ground for STAND_SECONDS (from any contact). */
const STAND_SECONDS = 0.25;
/** The perch check while perched (s): a perch that vanished (a despawned structure) lets the bird go. */
const PERCH_CHECK_SECONDS = 0.5;
/** Stick or pedal past this turns the perched bird on the spot. */
const PERCH_TURN_DEADBAND = 0.15;
/** Soaring: a climb with the flap power at zero this many metres above its lowest point is reported. */
const SOAR_REPORT_GAIN = 25;
const SOAR_REPORT_SECONDS = 5;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const PERCH_KINDS = Object.freeze(['peak', 'structure', 'tree']);

/** Smooth deterministic noise in about [-1, 1] (turbulence moments). */
function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

/** The length of a planar vector (Math.hypot, without its boxed result in optimized code). */
function planar(x, z) {
  return Math.sqrt(x * x + z * z);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function wrapSignedDegrees(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// ============================================================================================
// ASSISTS (kind 'flapper'): registered with the shared assist stage (src/flight/assists.js)
//   100 %  stability (rate damping, turn coordination, phugoid damping), auto-level, stall protection
//    50 %  stability and the stall warning
//     0 %  raw
// ============================================================================================
export const FLAPPER_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'stability', name: 'stability', from: 0, full: 0.5 }),
  Object.freeze({ key: 'stallWarning', name: 'stall warning', from: 0, full: 0 }),
  Object.freeze({ key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 }),
  Object.freeze({ key: 'stallProtection', name: 'stall protection', from: 0.5, full: 1 }),
]);

const ASSIST = Object.freeze({
  IDLE: 0.05,
  /** Rate damping on all three axes, sideslip coordination through the tail, and the phugoid damper. */
  STABILITY: Object.freeze({ ROLL_RATE_GAIN: 0.18, PITCH_RATE_GAIN: 0.12, YAW_RATE_GAIN: 0.2, SIDESLIP_GAIN: 2, PATH_RATE_GAIN: 1.1, LIMIT: 0.45 }),
  AUTO_LEVEL: Object.freeze({ DELAY: 0.4, BANK_GAIN: 1.2, RATE_GAIN: 0.3, LIMIT: 0.5 }),
  /** Stall protection keeps the trim this far below the critical angle of attack. */
  STALL: Object.freeze({ MARGIN: 2.5 * DEG, AOA_GAIN: 6, ROLL_SHARE: 0.5 }),
});

const flapperAssistHandler = Object.freeze({
  createMemory() {
    return { resetCount: -1, rollIdleSeconds: 0 };
  },

  apply(controls, context, weights, memory) {
    const data = context.model.flightData;
    const dt = context.dt;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (data.phase !== 'flight' || data.onGround || data.airspeed < 4) {
      memory.rollIdleSeconds = 0;
      return;
    }
    if (weights.stability > 0) {
      const tuning = ASSIST.STABILITY;
      const weight = weights.stability;
      controls.roll = clamp(controls.roll + weight * clamp(-tuning.ROLL_RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT), -1, 1);
      if (!autopilotFlying) {
        const damping = -tuning.PITCH_RATE_GAIN * data.pitchRate - tuning.PATH_RATE_GAIN * data.flightPathRate;
        controls.pitch = clamp(controls.pitch + weight * clamp(damping, -tuning.LIMIT, tuning.LIMIT), -1, 1);
      }
      const share = weight * (1 - Math.min(1, Math.abs(controls.yaw)));
      controls.yaw = clamp(controls.yaw + share * clamp(tuning.SIDESLIP_GAIN * data.sideslip - tuning.YAW_RATE_GAIN * data.yawRate * 0.1, -tuning.LIMIT, tuning.LIMIT), -1, 1);
    }
    if (weights.autoLevel > 0 && !autopilotFlying) {
      const tuning = ASSIST.AUTO_LEVEL;
      const idle = Math.abs(controls.roll) < ASSIST.IDLE;
      memory.rollIdleSeconds = idle ? memory.rollIdleSeconds + dt : 0;
      if (memory.rollIdleSeconds >= tuning.DELAY) {
        const command = clamp(-tuning.BANK_GAIN * data.bank - tuning.RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT);
        controls.roll = clamp(controls.roll + weights.autoLevel * command, -1, 1);
      }
    }
    if (weights.stallProtection > 0) {
      const tuning = ASSIST.STALL;
      const limit = data.aoaCritical - tuning.MARGIN;
      let ceiling = data.pullRange > 0 ? (limit - data.trimAoa) / data.pullRange : 1;
      if (data.aoa > limit) ceiling -= tuning.AOA_GAIN * (data.aoa - limit);
      ceiling = clamp(ceiling, -1, 1);
      if (controls.pitch > ceiling) controls.pitch += weights.stallProtection * (ceiling - controls.pitch);
      if (data.stallDepth > 0) controls.roll *= 1 - weights.stallProtection * tuning.ROLL_SHARE * data.stallDepth;
    }
  },
});

registerAssistCatalog('flapper', FLAPPER_ASSIST_CATALOG);
registerAssistHandler('flapper', flapperAssistHandler);

// ============================================================================================
// AUTOPILOT (kind 'flapper'): flies through the controls like the others. Heading by bank (wing
// twist); the energy way for the rest: flap power holds the total energy rate (climb plus the height
// the speed error is worth), body pitch splits it into speed, with a phugoid damper on the flight
// path; a terrain look-ahead. With a perch target in the craft state (the copilot's "find a perch") it
// flies the approach: toward the perch down a shallow glide slope to a little above it, slowing to the
// perch speed, so the model's auto-landing catches it. Too high for the slope, it circles down beside
// the perch first; past the perch it turns back for another pass.
// ============================================================================================
const AUTOPILOT = Object.freeze({
  MAX_BANK: 30 * DEG,
  BANK_PER_DEGREE: 1 * DEG,
  BANK_GAIN: 1.5,
  ROLL_RATE_GAIN: 0.3,
  ROLL_LIMIT: 0.7,
  SPEED_P: 0.1,
  SPEED_I: 0.03,
  PATH_DAMPING: 1.2,
  PITCH_MIN: -0.4,
  PITCH_MAX: 0.7,
  /** Below this height over the ground (m, the feet) the push for speed fades out. */
  PUSH_HEIGHT: 40,
  CLIMB_PER_METRE: 0.08,
  MAX_CLIMB: 2.5,
  MAX_DESCENT: 2,
  /** Total energy rate (m/s) worth one m/s of speed error. */
  ENERGY_SPEED: 0.35,
  FLAP_P: 0.12,
  FLAP_I: 0.06,
  SIDESLIP_GAIN: 2,
  YAW_LIMIT: 0.5,
  OUTPUT_SLEW: 2.5,
  LOOKAHEAD: Object.freeze([2, 4, 7, 10]),
  CLEARANCE: 40,
  /** Ground ahead within this (less the climb the wingbeat manages by then) turns it EVADE_HEADING aside. */
  EVADE_CLEARANCE: 12,
  EVADE_HEADING: 70,
  /**
   * The perch approach: speeds far and near, the glide slope (height per metre of distance) and the
   * band above it, the final height over the perch, the holding circle flown to lose height (its
   * speed, radius, offset from the perch, how far under the reachable height it holds, the
   * hysteresis, and the ground samples that choose its side), the glide ratio the reachable height
   * assumes, when to turn in from the circle, and the go-around distance past the perch.
   */
  /** Holding circle law: degrees of turn toward the circle per metre off it, at most HOLD_CORRECTION. */
  HOLD_GAIN: 1.5,
  HOLD_CORRECTION: 60,
  APPROACH: Object.freeze({ FAR: 140, NEAR: 35, SPEED_FAR: 12.5, SPEED_NEAR: 9.5, SLOPE: 0.06, MIN_ABOVE: 2, MAX_ABOVE: 60, FINAL_ABOVE: 1.5, SPEED_HOLD: 13.5, CIRCLE: 45, HOLD_OFFSET: 85, HOLD_BELOW_REACH: 3, HOLD_HYSTERESIS: 4, GLIDE: 12, INBOUND_ANGLE: 40, INBOUND_MARGIN: 2, GO_AROUND: 15, FINAL_FLAP: 0.4, HOLD_SAMPLES: Object.freeze([40, 80, 120]), TERRAIN_CLEARANCE: 10 }),
});

/** +1 when the ground to the right (150-300 m out, 60 degrees aside) is lower than to the left, else -1. */
function lowerSide(env, position, headingDegrees) {
  let left = -Infinity;
  let right = -Infinity;
  for (let step = 1; step <= 2; step++) {
    const distance = step * 150;
    for (let side = -1; side <= 1; side += 2) {
      const direction = (headingDegrees + side * 60) * DEG;
      const height = surfaceHeightAt(env, position.x + Math.sin(direction) * distance, position.z - Math.cos(direction) * distance);
      if (side < 0) left = Math.max(left, height);
      else right = Math.max(right, height);
    }
  }
  return right <= left ? 1 : -1;
}

/** The holding point of a perch approach: HOLD_OFFSET out on the side whose ground stays lowest. */
function chooseHoldingPoint(env, target, memory) {
  const tuning = AUTOPILOT.APPROACH;
  let best = Infinity;
  for (let side = 0; side < 8; side++) {
    const angle = (side / 8) * Math.PI * 2;
    const dx = Math.sin(angle);
    const dz = -Math.cos(angle);
    let highest = -Infinity;
    for (let index = 0; index < tuning.HOLD_SAMPLES.length; index++) {
      const out = tuning.HOLD_SAMPLES[index];
      highest = Math.max(highest, surfaceHeightAt(env, target.x + dx * out, target.z + dz * out));
    }
    if (highest < best) {
      best = highest;
      memory.holdX = target.x + dx * tuning.HOLD_OFFSET;
      memory.holdZ = target.z + dz * tuning.HOLD_OFFSET;
    }
  }
  // The highest ground under the holding circle (sampled round it).
  let floor = -Infinity;
  for (let sample = 0; sample < 12; sample++) {
    const angle = (sample / 12) * Math.PI * 2;
    for (const radius of [0, tuning.CIRCLE]) floor = Math.max(floor, surfaceHeightAt(env, memory.holdX + Math.sin(angle) * radius, memory.holdZ - Math.cos(angle) * radius));
  }
  memory.holdFloor = floor;
  memory.holdFor = target;
}

const flapperAutopilot = Object.freeze({
  createMemory() {
    return { resetCount: -1, engaged: false, speedIntegral: 0, flapIntegral: 0, roll: 0, pitch: 0, yaw: 0, flap: 0, evadeSide: 0, circling: false, holdFor: null, holdX: 0, holdZ: 0, holdFloor: -Infinity, closest: Infinity };
  },

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
    if (data.phase !== 'flight') return false;
    const position = model.state.position;
    if (!memory.engaged) {
      memory.engaged = true;
      memory.speedIntegral = clamp(controls.pitch, AUTOPILOT.PITCH_MIN, AUTOPILOT.PITCH_MAX);
      memory.flapIntegral = clamp(Number.isFinite(controls.throttle) ? controls.throttle : data.flapPower, 0, 1);
      memory.roll = clamp(controls.roll, -1, 1);
      memory.pitch = memory.speedIntegral;
      memory.yaw = clamp(controls.yaw, -1, 1);
      memory.flap = memory.flapIntegral;
    }
    const craftState = env && env.craftState ? env.craftState : null;
    const target = craftState && craftState.perchTarget && Number.isFinite(craftState.perchTarget.x) ? craftState.perchTarget : null;
    let heading = autopilot.heading;
    let speed = Number.isFinite(autopilot.speed) && autopilot.speed > 0 ? clamp(autopilot.speed, 9, 20) : data.cruise;
    let climb;
    if (target) {
      const tuning = AUTOPILOT.APPROACH;
      const distance = planar(target.x - position.x, target.z - position.z);
      heading = bearingTo(position.x, position.z, target.x, target.z);
      const feet = target.y + data.feetHeight;
      const above = distance <= tuning.NEAR ? tuning.FINAL_ABOVE : clamp(distance * tuning.SLOPE, tuning.MIN_ABOVE, tuning.MAX_ABOVE);
      const share = clamp((distance - tuning.NEAR) / (tuning.FAR - tuning.NEAR), 0, 1);
      speed = tuning.SPEED_NEAR + (tuning.SPEED_FAR - tuning.SPEED_NEAR) * share;
      const heightError = feet + above - position.y;
      // The ground ahead: never below TERRAIN_CLEARANCE over it short of the final.
      let terrainBelow = -Infinity;
      if (env && distance > tuning.NEAR) {
        // Only the ground short of the perch: what lies beyond it is the go-around's business.
        const velocity = model.state.velocity;
        const horizontalSpeed = Math.max(planar(velocity.x, velocity.z), 1);
        const reach = (distance - tuning.NEAR) / horizontalSpeed;
        let floor = -Infinity;
        for (let index = 0; index < AUTOPILOT.LOOKAHEAD.length; index++) {
          const seconds = Math.min(AUTOPILOT.LOOKAHEAD[index], reach);
          floor = Math.max(floor, surfaceHeightAt(env, position.x + velocity.x * seconds, position.z + velocity.z * seconds));
        }
        terrainBelow = floor + tuning.TERRAIN_CLEARANCE - position.y;
      }
      if (memory.holdFor !== target && env) {
        chooseHoldingPoint(env, target, memory);
        memory.closest = Infinity;
      }
      // Hold (a circle of radius CIRCLE round a point HOLD_OFFSET out where the ground is lowest)
      // when too high for the slope, after passing the perch without catching it (a go-around), or
      // when the ground ahead rises into the approach; back inbound once on the slope and facing the
      // perch, so the approach comes in from the low side.
      memory.closest = Math.min(memory.closest, distance);
      const passed = memory.closest < tuning.NEAR && distance > memory.closest + tuning.GO_AROUND;
      // The most height (over the perch's top) the bird can still lose gliding in before the
      // auto-landing's capture box: the box's own height plus a glide from here to the final.
      const reachable = data.captureAbove - tuning.INBOUND_MARGIN + Math.max(0, distance - tuning.NEAR) / tuning.GLIDE;
      const tooHigh = position.y - feet > reachable + tuning.HOLD_HYSTERESIS && distance < tuning.FAR * 1.5;
      if (!memory.circling && (tooHigh || passed || terrainBelow > 0)) memory.circling = true;
      if (memory.circling) {
        // The circle's height: low enough to go in from it, and clear of the ground under it.
        const holdReach = data.captureAbove - tuning.INBOUND_MARGIN + (tuning.HOLD_OFFSET - tuning.NEAR) / tuning.GLIDE;
        const holdHeight = Math.max(feet + holdReach - tuning.HOLD_BELOW_REACH, memory.holdFloor + tuning.TERRAIN_CLEARANCE);
        const lowEnough = position.y - feet < reachable;
        const toPerch = wrapSignedDegrees(heading - data.heading);
        if (lowEnough && Math.abs(toPerch) < tuning.INBOUND_ANGLE && terrainBelow <= 0 && distance > tuning.NEAR * 1.5) {
          memory.circling = false;
          memory.closest = distance;
        } else {
          const centre = planar(memory.holdX - position.x, memory.holdZ - position.z);
          const correction = clamp((centre - tuning.CIRCLE) * AUTOPILOT.HOLD_GAIN, -AUTOPILOT.HOLD_CORRECTION, AUTOPILOT.HOLD_CORRECTION);
          heading = bearingTo(position.x, position.z, memory.holdX, memory.holdZ) - 90 + correction;
          speed = tuning.SPEED_HOLD;
          climb = clamp((holdHeight - position.y) * AUTOPILOT.CLIMB_PER_METRE, -AUTOPILOT.MAX_DESCENT, AUTOPILOT.MAX_CLIMB);
        }
      }
      // Inbound: down the slope at the rate that arrives there with the remaining distance.
      if (!memory.circling) climb = clamp(heightError * Math.max(speed / Math.max(distance, 8), AUTOPILOT.CLIMB_PER_METRE), -AUTOPILOT.MAX_DESCENT, AUTOPILOT.MAX_CLIMB);
      if (terrainBelow > 0) climb = Math.max(climb, Math.min(AUTOPILOT.MAX_CLIMB, terrainBelow * AUTOPILOT.CLIMB_PER_METRE * 3));
    } else {
      let altitude = Number.isFinite(autopilot.altitude) ? autopilot.altitude : position.y;
      // Terrain look-ahead: keep CLEARANCE above the ground or water along the next few seconds;
      // ground rising faster than the wingbeat can climb (within EVADE_CLEARANCE ahead) turns it
      // toward the lower side until the way ahead is clear again.
      let threatened = false;
      if (env) {
        const velocity = model.state.velocity;
        for (let index = 0; index < AUTOPILOT.LOOKAHEAD.length; index++) {
          const seconds = AUTOPILOT.LOOKAHEAD[index];
          const floor = surfaceHeightAt(env, position.x + velocity.x * seconds, position.z + velocity.z * seconds);
          altitude = Math.max(altitude, floor + AUTOPILOT.CLEARANCE);
          if (floor + AUTOPILOT.EVADE_CLEARANCE - AUTOPILOT.MAX_CLIMB * seconds > position.y) threatened = true;
        }
        if (threatened && memory.evadeSide === 0) memory.evadeSide = lowerSide(env, position, data.heading);
      }
      if (!threatened) memory.evadeSide = 0;
      if (memory.evadeSide !== 0) heading = data.heading + memory.evadeSide * AUTOPILOT.EVADE_HEADING;
      climb = clamp((altitude - position.y) * AUTOPILOT.CLIMB_PER_METRE, -AUTOPILOT.MAX_DESCENT, AUTOPILOT.MAX_CLIMB);
    }
    const slew = AUTOPILOT.OUTPUT_SLEW * dt;
    const headingError = wrapSignedDegrees(heading - data.heading);
    const bankTarget = clamp(headingError * AUTOPILOT.BANK_PER_DEGREE, -AUTOPILOT.MAX_BANK, AUTOPILOT.MAX_BANK);
    const rollTarget = clamp(AUTOPILOT.BANK_GAIN * (bankTarget - data.bank) - AUTOPILOT.ROLL_RATE_GAIN * data.rollRate, -AUTOPILOT.ROLL_LIMIT, AUTOPILOT.ROLL_LIMIT);
    // Speed by pitch: too slow -> push, too fast -> pull; the flight path rate damps the phugoid.
    // Close to the ground it never pushes for speed (the wingbeat gains it instead).
    const pitchMin = AUTOPILOT.PITCH_MIN * clamp(data.agl / AUTOPILOT.PUSH_HEIGHT, 0, 1);
    const speedError = data.airspeed - speed;
    const pitchUnclamped = memory.speedIntegral + AUTOPILOT.SPEED_P * speedError - AUTOPILOT.PATH_DAMPING * data.flightPathRate;
    const pitchSaturated = (pitchUnclamped >= AUTOPILOT.PITCH_MAX && speedError > 0) || (pitchUnclamped <= pitchMin && speedError < 0);
    if (!pitchSaturated) memory.speedIntegral = clamp(memory.speedIntegral + AUTOPILOT.SPEED_I * speedError * dt, pitchMin, AUTOPILOT.PITCH_MAX);
    const pitchTarget = clamp(pitchUnclamped, pitchMin, AUTOPILOT.PITCH_MAX);
    // Total energy by flap power: the climb rate error plus the height the speed error is worth.
    const climbError = climb - data.verticalSpeed - AUTOPILOT.ENERGY_SPEED * speedError;
    const flapUnclamped = memory.flapIntegral + AUTOPILOT.FLAP_P * climbError;
    const flapSaturated = (flapUnclamped >= 1 && climbError > 0) || (flapUnclamped <= 0 && climbError < 0);
    if (!flapSaturated) memory.flapIntegral = clamp(memory.flapIntegral + AUTOPILOT.FLAP_I * climbError * dt, 0, 1);
    // On the final of a perch approach the wingbeat stays light, so the auto-landing can catch it.
    const flapCap = target && planar(target.x - position.x, target.z - position.z) < AUTOPILOT.APPROACH.NEAR * 1.5 ? AUTOPILOT.APPROACH.FINAL_FLAP : 1;
    const flapTarget = clamp(flapUnclamped, 0, flapCap);
    memory.roll = moveToward(memory.roll, rollTarget, slew);
    memory.pitch = moveToward(memory.pitch, pitchTarget, slew);
    memory.yaw = moveToward(memory.yaw, clamp(AUTOPILOT.SIDESLIP_GAIN * data.sideslip, -AUTOPILOT.YAW_LIMIT, AUTOPILOT.YAW_LIMIT), slew);
    memory.flap = moveToward(memory.flap, flapTarget, slew);
    controls.roll = memory.roll;
    controls.pitch = memory.pitch;
    controls.yaw = memory.yaw;
    controls.throttle = memory.flap;
    return true;
  },
});

registerAutopilotHandler('flapper', flapperAutopilot);

// ============================================================================================
// MODEL
// ============================================================================================
export function createSimFlapperModel({ profile, craft, world, bus, craftState: initialCraftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'eagle';
  const cruise = craft && craft.spawn && Number.isFinite(craft.spawn.cruise) ? craft.spawn.cruise : 12.5;
  const wing = profile.wing;
  const tuckProfile = profile.tuck;
  const flapProfile = profile.flap;
  const pitchProfile = profile.pitch;
  const rollProfile = profile.roll;
  const yawProfile = profile.yaw;
  const perchProfile = profile.perch;
  const mass = profile.mass;
  const weight = mass * GRAVITY;
  const inertia = new THREE.Vector3(profile.inertia.pitch, profile.inertia.yaw, profile.inertia.roll);
  const curve = createLiftCurve({
    clAlpha: wing.clAlpha,
    clMax: wing.clMax,
    clMin: wing.clMin,
    alphaCritical: wing.alphaCritical,
    postStallDrop: wing.postStallDrop,
    dropWidth: wing.stallDropWidth,
    blendWidth: wing.stallBlendWidth,
  });
  const trimAoa = pitchProfile.trimAoa * DEG;
  const pullRange = pitchProfile.pullRange * DEG;
  const pushRange = pitchProfile.pushRange * DEG;
  const tuckTrim = tuckProfile.trimAoa * DEG;
  const strokeTiltSlow = flapProfile.strokeTilt[0] * DEG;
  const strokeTiltFast = flapProfile.strokeTilt[1] * DEG;
  const feetHeight = perchProfile.feet;
  const flareAngle = perchProfile.flare * DEG;
  const origin = new THREE.Vector3();

  let craftState = initialCraftState;

  // ---- State ---------------------------------------------------------------------------------------
  const state = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x nose up, y nose left, z right wing up. */
    angularVelocity: new THREE.Vector3(),
  };
  const groundContact = createGroundContact(profile.contacts, { centerOfMass: origin, floats: false, mass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  /** The contact report while landing or perched (the bird holds itself; nothing strikes). */
  const restReport = {
    onGround: false, touchdown: null, bodyStrike: null, water: false, floating: false, surface: 'ground', penetration: 0, contacts: 0, gearContacts: 0, wheelSpeed: 0,
  };
  let activeReport = groundContact.report;

  /** Wing twist (roll), body and tail (pitch), tail twist (yaw), -1..1. */
  const limbs = { roll: 0, pitch: 0, yaw: 0 };
  /** The wingbeat: smoothed flap power, the fold, the stroke phase (cycles) and the beat count. */
  const wings = { power: 0, tuck: 0, phase: 0, amplitude: 0, count: 0, frequency: 0 };
  /**
   * The perch: phase 'flight' | 'landing' | 'perched'; kind 'peak' | 'structure' | 'tree' | 'ground';
   * the feet point (x, y, z) and the heading; the landing curve; the takeoff gate.
   */
  const perch = {
    phase: 'flight',
    kind: '',
    id: '',
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    elapsed: 0,
    duration: 1,
    startHeading: 0,
    scanTimer: 0,
    checkTimer: 0,
    standSeconds: 0,
    perchedSeconds: 0,
    minThrottle: 1,
    lastThrottle: 0,
    cooldownId: '',
    cooldownSeconds: 0,
    cooldownX: 0,
    cooldownZ: 0,
  };
  const landingStart = new THREE.Vector3();
  const landingVelocity = new THREE.Vector3();
  const landingEnd = new THREE.Vector3();
  const landingQuaternion = new THREE.Quaternion();
  let resetCount = 0;
  /**
   * The doubles every tick rewrites, as fields of one object: a closure variable holding a double
   * would box a new number on every write, an object field keeps its box (no allocation per tick).
   */
  const tick = { time: 0.5, load: 1.5, horizontal: 0.5, sink: 0.5, flightPath: 0.5 };
  tick.time = 0;
  tick.load = 1;
  tick.horizontal = 0;
  tick.sink = 0;
  tick.flightPath = 0;
  let pendingRest = false;
  let lastEnv = null;
  /** Soaring: the lowest height since the flap power last went to zero, and what was reported. */
  const soar = { low: Infinity, reported: 0, timer: 0 };
  let reportedLanterns = 0;

  /** Mesh animation: wing twist, body pitch, tail yaw (the controller passes these to the mesh). */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  const flightData = {
    phase: 'flight',
    perched: false,
    airspeed: 0,
    aoa: 0,
    aoaCritical: curve.alphaZero + curve.clMax / curve.clAlpha,
    trimAoa,
    pullRange,
    stallMargin: 0,
    stallDepth: 0,
    stalled: false,
    sideslip: 0,
    bank: 0,
    pitch: 0,
    heading: 0,
    flightPath: 0,
    flightPathRate: 0,
    verticalSpeed: 0,
    gLoad: 1,
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    onGround: false,
    agl: Infinity,
    glideRatio: 0,
    dynamicPressure: 0,
    liftToDrag: 0,
    flapPower: 0,
    tuck: 0,
    mass,
    cruise,
    feetHeight,
    /** How far above a perch's top the auto-landing still catches the bird (m, its feet). */
    captureAbove: perchProfile.captureAbove,
    resetCount: 0,
    // Read by the shared autopilot and HUD paths that look for fixed-wing fields.
    hasEngine: true,
    engineRunning: true,
    gLimit: Number.isFinite(limits.gLimit) ? limits.gLimit : 6,
    vne: Number.isFinite(limits.vne) ? limits.vne : 85,
  };

  // ---- Scratch ------------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const airWorld = new THREE.Vector3();
  const bodyAir = new THREE.Vector3();
  const airDirection = new THREE.Vector3();
  const liftDirection = new THREE.Vector3();
  const forceBody = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const momentBody = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const angularAcceleration = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const bodyAxis = new THREE.Vector3();
  const previousQuaternion = new THREE.Quaternion();
  const deltaQuaternion = new THREE.Quaternion();
  const targetQuaternion = new THREE.Quaternion();
  const pitchQuaternion = new THREE.Quaternion();
  const liftResult = { cl: 0, stall: 0, stallAngle: 0 };
  const contactBody = { position: state.position, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };
  const sightHit = { t: 0, distance: 0, normal: new THREE.Vector3(), point: new THREE.Vector3(), velocity: null, id: '', owner: '', tags: null };
  const sightOrigin = new THREE.Vector3();
  const sightDirection = new THREE.Vector3();
  const perchedPayload = { craft: craftId, perchId: '', kind: 'peak', position: { x: 0, y: 0, z: 0 }, perched: true };
  const statPayload = { key: '', value: 0, op: 'add' };
  /** The best perch candidate of a scan (filled by visitPerch, a persistent function: no closures per scan). */
  const candidate = { found: false, x: 0, y: 0, z: 0, kind: '', id: '', score: Infinity };
  const scanFrom = { x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0 };
  const peakScratch = { x: 0, z: 0, height: 0 };
  const landingObservation = { dt: 0, agl: 0, position: state.position };

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  function emitStat(key, value, op) {
    statPayload.key = key;
    statPayload.value = value;
    statPayload.op = op;
    bus.emitTyped('journalStat', statPayload);
  }

  function setPhase(phase) {
    perch.phase = phase;
    flightData.phase = phase;
    flightData.perched = phase === 'perched';
    activeReport = phase === 'flight' ? groundContact.report : restReport;
  }

  // ============================================================================================
  // INPUTS
  // ============================================================================================
  function axisValue(value) {
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  function handleActions(controls) {
    if (!controls.actions || controls.actions.size === 0) return;
    for (const action of controls.actions) {
      switch (action) {
        case 'engineToggle':
          notify('No engine: the throttle is your flap power, and zero is a glide.');
          break;
        case 'gearToggle':
          notify('Your legs come down by themselves for a perch: fly slowly at it.');
          break;
        case 'flapsUp':
        case 'flapsDown':
          notify('Push the stick hard (or hold the tuck) to fold the wings into a dive.');
          break;
        default:
          break;
      }
    }
  }

  function updateLimbs(controls, dt) {
    const step = LIMB_RATE * dt;
    limbs.roll = moveToward(limbs.roll, axisValue(controls.roll), step);
    limbs.pitch = moveToward(limbs.pitch, axisValue(controls.pitch), step);
    limbs.yaw = moveToward(limbs.yaw, axisValue(controls.yaw), step);
  }

  /** Flap power (spooled), the fold and the wingbeat phase. */
  function updateWings(controls, dt, flying) {
    const command = flying ? clamp(finiteOr(controls.throttle, 0), 0, 1) : 0;
    const tuckRequest = craftState && craftState.tuckRequest === true ? 1 : 0;
    const pushTuck = smoothstep(PUSH_START, 1, -axisValue(controls.pitch));
    const tuckTarget = flying ? Math.max(tuckRequest, pushTuck) : 0;
    wings.tuck = moveToward(wings.tuck, tuckTarget, tuckProfile.rate * dt);
    // Folded wings cannot beat.
    const powerTarget = command * (1 - wings.tuck);
    wings.power += (powerTarget - wings.power) * (1 - Math.exp(-flapProfile.spool * dt));
    const beating = wings.power > GLIDE_POWER;
    const amplitudeTarget = beating ? 0.35 + 0.65 * Math.sqrt(wings.power) : 0;
    wings.amplitude = moveToward(wings.amplitude, amplitudeTarget, 2.5 * dt);
    wings.frequency = flapProfile.frequency[0] + (flapProfile.frequency[1] - flapProfile.frequency[0]) * wings.power;
    if (wings.amplitude > 0.01) {
      const previous = wings.phase;
      wings.phase += wings.frequency * dt;
      if (Math.floor(wings.phase) !== Math.floor(previous)) wings.count++;
      if (wings.phase > 1e6) wings.phase -= Math.floor(wings.phase);
    }
  }

  // ============================================================================================
  // ATTITUDE HELPERS
  // ============================================================================================
  function computeAttitude() {
    bodyAxis.set(0, 0, -1).applyQuaternion(state.quaternion);
    flightData.pitch = Math.asin(clamp(bodyAxis.y, -1, 1));
    if (planar(bodyAxis.x, bodyAxis.z) > 0.05) flightData.heading = headingFromVector(bodyAxis.x, bodyAxis.z);
    const forwardY = bodyAxis.y;
    bodyAxis.set(1, 0, 0).applyQuaternion(state.quaternion);
    const rightY = bodyAxis.y;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.bank = Math.abs(forwardY) > 0.995 ? 0 : Math.atan2(-rightY, bodyAxis.y);
  }

  /** A level attitude at heading, pitched up by pitch (rad), into target. */
  function levelAttitude(heading, pitch, target) {
    target.setFromAxisAngle(WORLD_UP, -heading * DEG);
    if (pitch !== 0) target.multiply(pitchQuaternion.setFromAxisAngle(X_AXIS, pitch));
    return target;
  }

  /** Body rates from a kinematic attitude change (the auto-landing and the perch). */
  function ratesFromAttitude(dt) {
    deltaQuaternion.copy(previousQuaternion).invert().multiply(state.quaternion).normalize();
    if (deltaQuaternion.w < 0) deltaQuaternion.set(-deltaQuaternion.x, -deltaQuaternion.y, -deltaQuaternion.z, -deltaQuaternion.w);
    const angle = 2 * Math.acos(clamp(deltaQuaternion.w, -1, 1));
    const sine = Math.sqrt(Math.max(0, 1 - deltaQuaternion.w * deltaQuaternion.w));
    if (sine > 1e-7 && dt > 0) state.angularVelocity.set(deltaQuaternion.x / sine, deltaQuaternion.y / sine, deltaQuaternion.z / sine).multiplyScalar(angle / dt);
    else state.angularVelocity.set(0, 0, 0);
  }

  // ============================================================================================
  // FLIGHT (rigid body)
  // ============================================================================================
  const wingData = { cl: 0, cd: 0, stall: 0, aoa: 0, sideslip: 0, airspeed: 0, dynamicPressure: 0 };

  /** Wing, body and wingbeat forces and moments (body axes). */
  function flightForces(rho, agl, turbulence) {
    const airspeed = bodyAir.length();
    wingData.airspeed = airspeed;
    const tuck = wings.tuck;
    const areaShare = 1 - (1 - tuckProfile.area) * tuck;
    const spanShare = 1 - (1 - tuckProfile.span) * tuck;
    const area = wing.area * areaShare;
    const span = wing.span * spanShare;
    const aspect = (span * span) / area;
    const induced = 1 / (Math.PI * wing.oswald * aspect);
    const cd0 = wing.cd0 + (tuckProfile.cd0 - wing.cd0) * tuck;
    // Flapping: thrust along the stroke plane (tilted up when slow), extra lift at low speed and control.
    const power = wings.power;
    const forwardAir = Math.max(-bodyAir.z, 0);
    const thrust = (flapProfile.efficiency * flapProfile.power * power) / Math.max(forwardAir, flapProfile.referenceSpeed);
    const tilt = strokeTiltSlow + (strokeTiltFast - strokeTiltSlow) * smoothstep(0, flapProfile.tiltSpeed, forwardAir);
    forceBody.y += thrust * Math.sin(tilt);
    forceBody.z -= thrust * Math.cos(tilt);
    const deltaClMax = flapProfile.liftBoost * power * (1 - smoothstep(0, flapProfile.boostSpeed, airspeed));

    if (airspeed < 0.5) {
      wingData.cl = 0;
      wingData.cd = 0;
      wingData.stall = 0;
      wingData.dynamicPressure = 0;
      return;
    }
    airDirection.copy(bodyAir).divideScalar(airspeed);
    const aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    const sideslip = Math.asin(clamp(airDirection.x, -1, 1));
    evaluateLift(curve, aoa, 0, deltaClMax, liftResult);
    const cl = liftResult.cl;
    const stall = liftResult.stall;
    const groundEffect = groundEffectFactor(agl, span);
    const sine = Math.sin(aoa);
    const broadside = smoothstep(liftResult.stallAngle, 50 * DEG, Math.abs(aoa)) * BROADSIDE_DRAG * sine * sine;
    const cd = cd0 + induced * cl * cl * groundEffect * (1 - stall * 0.5) + broadside;
    const dynamicPressure = 0.5 * rho * airspeed * airspeed;
    const load = dynamicPressure * area;
    liftDirection.set(0, -airDirection.z, airDirection.y);
    const planar = liftDirection.length();
    if (planar > 1e-6) forceBody.addScaledVector(liftDirection, (load * cl) / planar);
    forceBody.addScaledVector(airDirection, -(load * cd + dynamicPressure * profile.body.dragArea));
    forceBody.x -= dynamicPressure * wing.sideArea * wing.sideForceSlope * Math.sin(sideslip);

    // Moments act on the control pressure: the air's, or the wingbeat's at low speed.
    const control = Math.max(dynamicPressure, flapProfile.controlPressure * wings.amplitude) * area;
    const reference = Math.max(airspeed, 4);
    const pitchInput = limbs.pitch;
    const shapeTrim = trimAoa + (pitchInput >= 0 ? pitchInput * pullRange : pitchInput * pushRange);
    const trim = shapeTrim + (tuckTrim - shapeTrim) * tuck;
    const pastStall = aoa - liftResult.stallAngle;
    const breakWindow = pastStall > 0 ? 1 - smoothstep(STALL_BREAK_SPAN * 0.5, STALL_BREAK_SPAN, pastStall) : 0;
    const stallBreak = pitchProfile.stallBreak * stall * breakWindow * (0.3 + 0.7 * Math.max(0, pitchInput));
    const pitchDamping = pitchProfile.damping * (1 - 0.5 * stall);
    const cm = -pitchProfile.stiffness * Math.sin(aoa - trim) + stallBreak - pitchDamping * (wing.chord / (2 * reference)) * state.angularVelocity.x;
    momentBody.x += control * wing.chord * cm;

    const authority = rollProfile.authority * (1 - rollProfile.tuckLoss * tuck) * (1 - 0.5 * stall);
    const clRoll = -authority * limbs.roll
      - rollProfile.damping * (span / (2 * reference)) * state.angularVelocity.z
      + rollProfile.dihedral * Math.sin(sideslip);
    momentBody.z += control * span * clRoll;

    const cn = -yawProfile.weathervane * Math.sin(sideslip)
      - yawProfile.authority * limbs.yaw
      + yawProfile.adverse * limbs.roll
      - yawProfile.damping * (span / (2 * reference)) * state.angularVelocity.y;
    momentBody.y += control * span * cn;

    if (turbulence > 0) {
      const shake = load * wing.chord * 0.015 * turbulence;
      momentBody.x += shake * noise(tick.time, 0.7, 1.3);
      momentBody.y += shake * 0.6 * noise(tick.time, 2.3, 0.9);
      momentBody.z += shake * 1.6 * noise(tick.time, 4.1, 1.5);
    }

    wingData.cl = cl;
    wingData.cd = cd;
    wingData.stall = stall;
    wingData.aoa = aoa;
    wingData.sideslip = sideslip;
    wingData.dynamicPressure = dynamicPressure;
    flightData.aoaCritical = liftResult.stallAngle;
  }

  /** Euler's equations with a diagonal inertia, then the attitude update. */
  function integrateRotation(dt) {
    angularMomentum.set(state.angularVelocity.x * inertia.x, state.angularVelocity.y * inertia.y, state.angularVelocity.z * inertia.z);
    gyro.crossVectors(state.angularVelocity, angularMomentum);
    angularAcceleration.copy(momentBody).sub(gyro);
    angularAcceleration.set(angularAcceleration.x / inertia.x, angularAcceleration.y / inertia.y, angularAcceleration.z / inertia.z);
    state.angularVelocity.addScaledVector(angularAcceleration, dt);
    if (state.angularVelocity.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) state.angularVelocity.setLength(MAX_ANGULAR_SPEED);
    const rate = state.angularVelocity.length();
    if (rate > 1e-9) {
      axis.copy(state.angularVelocity).divideScalar(rate);
      state.quaternion.multiply(rotationStep.setFromAxisAngle(axis, rate * dt)).normalize();
    }
  }

  // ============================================================================================
  // PERCH: finding one, the auto-landing, standing, taking off
  // ============================================================================================
  /** Records the perch closest to the bird's path among the ones it may catch (colliders.perchesNear). */
  function visitPerch(x, y, z, kind, sourceId) {
    if (!PERCH_KINDS.includes(kind)) return;
    considerPerch(x, y, z, kind, typeof sourceId === 'string' ? sourceId : '');
  }

  /** True while (x, z) is the perch the bird just left (time and distance cooldown). */
  function coolingDown(x, z) {
    return perch.cooldownSeconds > 0 && Math.abs(x - perch.cooldownX) < perchProfile.standRadius && Math.abs(z - perch.cooldownZ) < perchProfile.standRadius;
  }

  /** A perch's id: its source id, or a name from its kind and place (peaks, unnamed points). */
  function perchIdFor(kind, sourceId, x, z) {
    return sourceId ? sourceId : `${kind}:${Math.round(x)}:${Math.round(z)}`;
  }

  function considerPerch(x, y, z, kind, id) {
    if (coolingDown(x, z)) return;
    const above = scanFrom.y - feetHeight - y;
    if (above > perchProfile.captureAbove || above < -perchProfile.captureBelow) return;
    const dx = x - scanFrom.x;
    const dz = z - scanFrom.z;
    const distance = planar(dx, dz);
    if (distance > perchProfile.captureRadius) return;
    // Ahead of the bird (or almost under it): never one it has already passed.
    if (distance > perchProfile.underRadius && scanFrom.speed > 1 && (dx * scanFrom.vx + dz * scanFrom.vz) / (distance * scanFrom.speed) < perchProfile.aheadCosine) return;
    const score = distance + Math.abs(above) * 0.5;
    if (score >= candidate.score) return;
    candidate.found = true;
    candidate.x = x;
    candidate.y = y;
    candidate.z = z;
    candidate.kind = kind;
    candidate.id = id;
    candidate.score = score;
  }

  /**
   * The local top of the terrain uphill from (x, z) by gradient steps, into peakScratch; true when it
   * is a peak: higher than every sample of two rings around it, and standing out of the outer ring.
   */
  function findPeak(env, x, z) {
    let px = x;
    let pz = z;
    let height = env.groundHeight(px, pz);
    const step = perchProfile.peakStep;
    for (let iteration = 0; iteration < perchProfile.peakSteps; iteration++) {
      const east = env.groundHeight(px + step, pz);
      const west = env.groundHeight(px - step, pz);
      const south = env.groundHeight(px, pz + step);
      const north = env.groundHeight(px, pz - step);
      const best = Math.max(east, west, south, north);
      if (best <= height) break;
      if (best === east) px += step;
      else if (best === west) px -= step;
      else if (best === south) pz += step;
      else pz -= step;
      height = best;
    }
    if (waterHeightAt(env, px, pz) >= height) return false;
    let outerSum = 0;
    for (let ring = 0; ring < perchProfile.peakRings.length; ring++) {
      const radius = perchProfile.peakRings[ring];
      for (let sample = 0; sample < 8; sample++) {
        const angle = (sample / 8) * Math.PI * 2;
        const ground = env.groundHeight(px + Math.sin(angle) * radius, pz - Math.cos(angle) * radius);
        if (ground > height - perchProfile.peakTolerance) return false;
        if (ring === perchProfile.peakRings.length - 1) outerSum += ground;
      }
    }
    if (height - outerSum / 8 < perchProfile.peakProminence) return false;
    peakScratch.x = px;
    peakScratch.z = pz;
    peakScratch.height = height;
    return true;
  }

  /** True when the line of flight from the bird to a point is clear of solid colliders. */
  function clearLineTo(env, x, y, z) {
    const colliders = env.colliders;
    if (!colliders || typeof colliders.raycast !== 'function') return true;
    sightOrigin.copy(state.position);
    sightDirection.set(x - sightOrigin.x, y - sightOrigin.y, z - sightOrigin.z);
    const distance = sightDirection.length();
    if (distance <= SIGHT_MARGIN * 2) return true;
    return !colliders.raycast(sightOrigin, sightDirection, distance - SIGHT_MARGIN, null, sightHit);
  }

  /** One perch search (while slow): the best catchable perch, or none. */
  function scanForPerch(env, agl) {
    const position = state.position;
    candidate.found = false;
    candidate.score = Infinity;
    scanFrom.x = position.x;
    scanFrom.y = position.y;
    scanFrom.z = position.z;
    scanFrom.vx = state.velocity.x;
    scanFrom.vz = state.velocity.z;
    scanFrom.speed = planar(state.velocity.x, state.velocity.z);
    const radius = planar(perchProfile.captureRadius, perchProfile.captureAbove + feetHeight);
    if (env.colliders && typeof env.colliders.perchesNear === 'function') env.colliders.perchesNear(position.x, position.y, position.z, radius, visitPerch);
    if (agl < perchProfile.captureAbove + feetHeight && findPeak(env, position.x, position.z)) {
      considerPerch(peakScratch.x, peakScratch.height, peakScratch.z, 'peak', '');
    }
    if (!candidate.found) return false;
    let feetY = candidate.y;
    const colliders = env.colliders;
    // A perch point inside a solid (a railing's volume) moves up onto its top.
    if (colliders && typeof colliders.insideSolid === 'function' && colliders.insideSolid(candidate.x, feetY + 0.05, candidate.z, 0.02) !== null) {
      feetY = colliders.liftClear(candidate.x, feetY + 0.05, candidate.z);
    }
    if (!clearLineTo(env, candidate.x, feetY + feetHeight + 0.2, candidate.z)) return false;
    beginLanding(candidate.x, feetY, candidate.z, candidate.kind, perchIdFor(candidate.kind, candidate.id, candidate.x, candidate.z));
    return true;
  }

  /** Starts the auto-landing toward a perch's feet point. */
  function beginLanding(x, y, z, kind, id) {
    perch.kind = kind;
    perch.id = id;
    perch.x = x;
    perch.y = y;
    perch.z = z;
    landingStart.copy(state.position);
    landingEnd.set(x, y + feetHeight, z);
    const horizontal = planar(state.velocity.x, state.velocity.z);
    perch.heading = horizontal > 1 ? headingFromVector(state.velocity.x, state.velocity.z) : flightData.heading;
    perch.startHeading = perch.heading;
    const distance = landingStart.distanceTo(landingEnd);
    const speed = Math.max(state.velocity.length(), 1);
    perch.duration = clamp((1.5 * distance) / speed, perchProfile.landSeconds[0], perchProfile.landSeconds[1]);
    // The curve's start velocity: never so long that it loops past the perch, never diving under it.
    landingVelocity.copy(state.velocity);
    const reach = landingVelocity.length() * perch.duration;
    const maxReach = 2 * Math.max(distance, 1);
    if (reach > maxReach) landingVelocity.multiplyScalar(maxReach / reach);
    const drop = landingStart.y - landingEnd.y;
    if (landingVelocity.y < 0) landingVelocity.y = Math.max(landingVelocity.y, (-2.5 * Math.max(drop, 0.5)) / perch.duration);
    else if (drop > 0) landingVelocity.y = Math.min(landingVelocity.y, 0);
    landingQuaternion.copy(state.quaternion);
    perch.elapsed = 0;
    setPhase('landing');
    restReport.onGround = false;
    restReport.contacts = 0;
    restReport.gearContacts = 0;
  }

  /** The auto-landing's kinematic step: a cubic from the start to the perch, flaring on the way. */
  function stepLanding(dt) {
    perch.elapsed += dt;
    const duration = perch.duration;
    const u = clamp(perch.elapsed / duration, 0, 1);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const d00 = (6 * u2 - 6 * u) / duration;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = (-6 * u2 + 6 * u) / duration;
    state.position.set(
      h00 * landingStart.x + h10 * duration * landingVelocity.x + h01 * landingEnd.x,
      h00 * landingStart.y + h10 * duration * landingVelocity.y + h01 * landingEnd.y,
      h00 * landingStart.z + h10 * duration * landingVelocity.z + h01 * landingEnd.z,
    );
    state.velocity.set(
      d00 * landingStart.x + d10 * landingVelocity.x + d01 * landingEnd.x,
      d00 * landingStart.y + d10 * landingVelocity.y + d01 * landingEnd.y,
      d00 * landingStart.z + d10 * landingVelocity.z + d01 * landingEnd.z,
    );
    // Turn toward the perch, flare (nose up, then level), wings level.
    const horizontal = planar(state.velocity.x, state.velocity.z);
    if (horizontal > 0.8 && u < 0.85) perch.heading = headingFromVector(state.velocity.x, state.velocity.z);
    levelAttitude(perch.heading, flareAngle * Math.sin(Math.PI * Math.min(u * 1.15, 1)), targetQuaternion);
    state.quaternion.slerpQuaternions(landingQuaternion, targetQuaternion, smoothstep(0, 0.45, u)).normalize();
    if (u >= 1) settleOnPerch();
  }

  /** The bird stands on the perch: held still, announced. */
  function settleOnPerch() {
    state.position.set(perch.x, perch.y + feetHeight, perch.z);
    state.velocity.set(0, 0, 0);
    levelAttitude(perch.heading, 0, state.quaternion);
    state.angularVelocity.set(0, 0, 0);
    perch.perchedSeconds = 0;
    perch.checkTimer = PERCH_CHECK_SECONDS;
    perch.minThrottle = 1;
    perch.standSeconds = 0;
    setPhase('perched');
    restReport.onGround = true;
    restReport.contacts = 2;
    restReport.gearContacts = 2;
    landing.reset(true);
    groundContact.reset(true);
    if (PERCH_KINDS.includes(perch.kind)) {
      announcePerch(true);
      emitStat('eaglePerches', 1, 'add');
    }
  }

  function announcePerch(perched) {
    perchedPayload.perchId = perch.id;
    perchedPayload.kind = perch.kind;
    perchedPayload.position.x = perch.x;
    perchedPayload.position.y = perch.y;
    perchedPayload.position.z = perch.z;
    perchedPayload.perched = perched;
    bus.emitTyped('perched', perchedPayload);
  }

  /** What the bird is standing on at (x, z) after a touchdown: a perch point, a peak or plain ground. */
  function classifyStand(env, x, y, z) {
    candidate.found = false;
    candidate.score = Infinity;
    scanFrom.x = x;
    scanFrom.y = y + feetHeight;
    scanFrom.z = z;
    scanFrom.speed = 0;
    if (env.colliders && typeof env.colliders.perchesNear === 'function') env.colliders.perchesNear(x, y, z, perchProfile.standRadius, visitPerch);
    if (candidate.found && Math.abs(candidate.y - y) < 1) {
      perch.kind = candidate.kind;
      perch.id = perchIdFor(candidate.kind, candidate.id, candidate.x, candidate.z);
      return;
    }
    if (findPeak(env, x, z) && planar(peakScratch.x - x, peakScratch.z - z) < perchProfile.standRadius) {
      perch.kind = 'peak';
      perch.id = `peak:${Math.round(peakScratch.x)}:${Math.round(peakScratch.z)}`;
      return;
    }
    perch.kind = 'ground';
    perch.id = '';
  }

  /** Standing still on the perch: turn on the spot, take off on a flap. */
  function stepPerched(controls, env, dt) {
    // The structure sweep may have eased the bird out of a collider: it stands where it was put.
    if (Math.abs(state.position.x - perch.x) + Math.abs(state.position.y - perch.y - feetHeight) + Math.abs(state.position.z - perch.z) > 1e-6) {
      perch.x = state.position.x;
      perch.y = state.position.y - feetHeight;
      perch.z = state.position.z;
    }
    perch.perchedSeconds += dt;
    const turn = axisValue(controls.yaw) + 0.5 * axisValue(controls.roll);
    if (Math.abs(turn) > PERCH_TURN_DEADBAND) perch.heading = ((perch.heading + perchProfile.turnRate * (turn - Math.sign(turn) * PERCH_TURN_DEADBAND) * dt) % 360 + 360) % 360;
    state.position.set(perch.x, perch.y + feetHeight, perch.z);
    state.velocity.set(0, 0, 0);
    levelAttitude(perch.heading, 0, state.quaternion);
    // Flap to take off: the flap power raised past where it has been since the bird settled.
    const throttle = clamp(finiteOr(controls.throttle, 0), 0, 1);
    perch.lastThrottle = throttle;
    perch.minThrottle = Math.min(perch.minThrottle, throttle);
    const flapped = throttle >= Math.max(perchProfile.takeoffThrottle, perch.minThrottle + perchProfile.takeoffRaise);
    const requested = craftState && craftState.takeoffRequest === true;
    if (requested) craftState.takeoffRequest = false;
    perch.checkTimer -= dt;
    let vanished = false;
    if (perch.checkTimer <= 0) {
      perch.checkTimer = PERCH_CHECK_SECONDS;
      vanished = !perchStillThere(env);
    }
    if (flapped || requested || vanished) {
      if (vanished) notify('The perch is gone. Back into the air.');
      takeOff();
    }
  }

  /** True while the perch the bird stands on still exists (a despawned structure takes its perch away). */
  function perchStillThere(env) {
    if (perch.kind === 'ground' || perch.kind === 'peak') return Math.abs(env.groundHeight(perch.x, perch.z) - perch.y) < 1.5;
    candidate.found = false;
    candidate.score = Infinity;
    scanFrom.x = perch.x;
    scanFrom.y = perch.y + feetHeight;
    scanFrom.z = perch.z;
    scanFrom.speed = 0;
    const cooldown = perch.cooldownSeconds;
    perch.cooldownSeconds = 0;
    if (env.colliders && typeof env.colliders.perchesNear === 'function') env.colliders.perchesNear(perch.x, perch.y, perch.z, perchProfile.standRadius, visitPerch);
    perch.cooldownSeconds = cooldown;
    return candidate.found || (env.colliders && typeof env.colliders.insideSolid === 'function' && env.colliders.insideSolid(perch.x, perch.y - 0.1, perch.z, 0) !== null);
  }

  /** A hop forward and up, wings out: the flight model takes over. */
  function takeOff() {
    const wasPerch = PERCH_KINDS.includes(perch.kind);
    const heading = perch.heading;
    const forwardX = Math.sin(heading * DEG);
    const forwardZ = -Math.cos(heading * DEG);
    state.position.y += perchProfile.takeoffRise;
    state.velocity.set(forwardX * perchProfile.takeoffSpeed, perchProfile.takeoffUp, forwardZ * perchProfile.takeoffSpeed);
    levelAttitude(heading, perchProfile.takeoffPitch * DEG, state.quaternion);
    state.angularVelocity.set(0, 0, 0);
    perch.cooldownId = perch.id;
    perch.cooldownSeconds = perchProfile.retakeSeconds;
    perch.cooldownX = perch.x;
    perch.cooldownZ = perch.z;
    perch.perchedSeconds = 0;
    perch.standSeconds = 0;
    perch.scanTimer = SCAN_SECONDS;
    // Wings start beating at once: the hop is a full stroke at the flap power that asked for it.
    wings.amplitude = Math.max(wings.amplitude, 0.8);
    wings.power = Math.max(wings.power, perch.lastThrottle);
    setPhase('flight');
    groundContact.reset(false);
    landing.reset(false);
    if (wasPerch) announcePerch(false);
    perch.kind = '';
  }

  /** The cooldown on the perch just left runs out with time and distance. */
  function updateCooldown(dt) {
    if (perch.cooldownSeconds <= 0) return;
    perch.cooldownSeconds -= dt;
    if (planar(state.position.x - perch.cooldownX, state.position.z - perch.cooldownZ) > RECAPTURE_DISTANCE) perch.cooldownSeconds = Math.min(perch.cooldownSeconds, 0.5);
    if (perch.cooldownSeconds <= 0) perch.cooldownId = '';
  }

  // ============================================================================================
  // STEP
  // ============================================================================================
  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    tick.time += dt;
    lastEnv = env;
    if (env.craftState && env.craftState !== craftState) craftState = env.craftState;
    handleActions(controls);
    if (pendingRest) settleFromReset(env);
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    airWorld.copy(state.velocity);
    if (env.wind && env.wind.vel) airWorld.sub(env.wind.vel);
    const surface = surfaceHeightAt(env, state.position.x, state.position.z);
    const agl = state.position.y - feetHeight - surface;
    previousQuaternion.copy(state.quaternion);
    updateCooldown(dt);

    const phase = perch.phase;
    if (phase === 'flight') {
      updateLimbs(controls, dt);
      updateWings(controls, dt, true);
      forceBody.set(0, 0, 0);
      momentBody.set(0, 0, 0);
      inverseQuaternion.copy(state.quaternion).invert();
      bodyAir.copy(airWorld).applyQuaternion(inverseQuaternion);
      flightForces(rho, agl, turbulence);
      forceWorld.copy(forceBody).applyQuaternion(state.quaternion);

      groundForce.set(0, 0, 0);
      groundMoment.set(0, 0, 0);
      groundContact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
      forceWorld.add(groundForce);
      const loadForce = forceWorld.length();
      forceWorld.y -= weight;
      state.velocity.addScaledVector(forceWorld, dt / mass);
      if (state.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) state.velocity.setLength(MAX_SPEED);
      state.position.addScaledVector(state.velocity, dt);
      momentBody.add(groundMoment);
      integrateRotation(dt);
      bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
      const specificUp = forceWorld.x * bodyAxis.x + (forceWorld.y + weight) * bodyAxis.y + forceWorld.z * bodyAxis.z;
      const load = Number.isFinite(specificUp) ? specificUp / weight : loadForce / weight;
      tick.load += (load - tick.load) * (1 - Math.exp(-LOAD_SMOOTHING * dt));
      updateGroundStand(env, dt);
      if (perch.phase === 'flight') {
        perch.scanTimer -= dt;
        if (perch.scanTimer <= 0) {
          perch.scanTimer = SCAN_SECONDS;
          const report = groundContact.report;
          // A slow bird that is not flapping hard is coming in to land; a climbing one is not.
          if (!report.onGround && wingData.airspeed < perchProfile.captureSpeed && wings.power < perchProfile.captureFlap) scanForPerch(env, agl);
        }
      }
    } else if (phase === 'landing') {
      updateLimbs(controls, dt);
      updateWings(controls, dt, false);
      stepLanding(dt);
      ratesFromAttitude(dt);
      tick.load += (1 - tick.load) * (1 - Math.exp(-LOAD_SMOOTHING * dt));
    } else {
      updateLimbs(controls, dt);
      updateWings(controls, dt, false);
      stepPerched(controls, env, dt);
      ratesFromAttitude(dt);
      tick.load += (1 - tick.load) * (1 - Math.exp(-LOAD_SMOOTHING * dt));
    }
    if (perch.phase !== 'perched' && craftState) craftState.takeoffRequest = false;

    const report = activeReport;
    updateFlightData(dt, agl, report);
    landingObservation.dt = dt;
    landingObservation.agl = flightData.agl;
    landing.observe(report, landingObservation);
    updateSoaring(dt);
    writeCraftState();
  }

  /** After a touchdown on its feet: slow enough over the ground for a moment -> standing (perched). */
  function updateGroundStand(env, dt) {
    const report = groundContact.report;
    const groundSpeed = planar(state.velocity.x, state.velocity.z);
    if (report.onGround && report.contacts > 0 && !report.water && groundSpeed < perchProfile.settleSpeed && wingData.airspeed < perchProfile.captureSpeed && !coolingDown(state.position.x, state.position.z)) {
      perch.standSeconds += dt;
      if (perch.standSeconds >= STAND_SECONDS) {
        const x = state.position.x;
        const z = state.position.z;
        const ground = env.groundHeight(x, z);
        perch.x = x;
        perch.y = ground;
        perch.z = z;
        perch.heading = flightData.heading;
        classifyStand(env, x, ground, z);
        settleOnPerch();
      }
    } else {
      perch.standSeconds = 0;
    }
  }

  /**
   * A resting reset (a perch placement, a ground start): standing on the surface when the pose is at
   * most a leg above it, else with its feet on the given point (a perch point well above the ground).
   */
  function settleFromReset(env) {
    pendingRest = false;
    const x = state.position.x;
    const z = state.position.z;
    const support = surfaceHeightAt(env, x, z);
    const ground = env.groundHeight(x, z);
    const feetY = state.position.y - support <= feetHeight + perchProfile.restSnap ? Math.max(support, ground) : state.position.y;
    perch.x = x;
    perch.y = feetY;
    perch.z = z;
    perch.heading = flightData.heading;
    classifyStand(env, x, feetY, z);
    settleOnPerch();
  }

  /** The soaring climb (flap power at zero) above its lowest point; reported to the journal. */
  function updateSoaring(dt) {
    const soaring = perch.phase === 'flight' && wings.power < GLIDE_POWER && !groundContact.report.onGround;
    if (!soaring) {
      soar.low = Infinity;
      if (craftState) craftState.soarGain = 0;
      return;
    }
    soar.low = Math.min(soar.low, state.position.y);
    const gain = state.position.y - soar.low;
    if (craftState) craftState.soarGain = gain;
    soar.timer -= dt;
    if (gain >= SOAR_REPORT_GAIN && gain > soar.reported + 5 && soar.timer <= 0) {
      soar.reported = gain;
      soar.timer = SOAR_REPORT_SECONDS;
      emitStat('eagleBestSoar', Math.round(gain), 'max');
    }
  }

  function updateFlightData(dt, agl, report) {
    computeAttitude();
    const airspeed = perch.phase === 'perched' ? 0 : airWorld.length();
    flightData.airspeed = airspeed;
    const flying = perch.phase === 'flight';
    flightData.aoa = flying ? wingData.aoa : 0;
    flightData.sideslip = flying ? wingData.sideslip : 0;
    flightData.stallDepth = flying ? wingData.stall : 0;
    flightData.dynamicPressure = flying ? wingData.dynamicPressure : 0;
    flightData.liftToDrag = flying && wingData.cd > 0 ? wingData.cl / wingData.cd : 0;
    flightData.stallMargin = flightData.aoaCritical - flightData.aoa;
    flightData.stalled = flying && flightData.stallDepth > STALLED_DEPTH;
    flightData.verticalSpeed = state.velocity.y;
    const groundSpeed = planar(state.velocity.x, state.velocity.z);
    const flightPath = Math.atan2(state.velocity.y, Math.max(groundSpeed, 0.1));
    flightData.flightPathRate = dt > 0 && flying ? (flightPath - tick.flightPath) / dt : 0;
    tick.flightPath = flightPath;
    flightData.flightPath = flightPath;
    flightData.gLoad = tick.load;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.onGround = report.onGround;
    flightData.agl = agl;
    flightData.flapPower = wings.power;
    flightData.tuck = wings.tuck;
    const glideStep = 1 - Math.exp(-GLIDE_SMOOTHING * dt);
    tick.horizontal += (groundSpeed - tick.horizontal) * glideStep;
    tick.sink += (-state.velocity.y - tick.sink) * glideStep;
    flightData.glideRatio = tick.sink > 0.3 ? tick.horizontal / tick.sink : 0;
    surfaces.aileron = limbs.roll;
    surfaces.elevator = limbs.pitch;
    surfaces.rudder = limbs.yaw;
    surfaces.propSpeed = 0;
    surfaces.groundSpeed = report.onGround ? groundSpeed : 0;
  }

  function writeCraftState() {
    if (!craftState) return;
    craftState.perched = perch.phase === 'perched';
    craftState.perchId = perch.phase === 'perched' && perch.id ? perch.id : null;
    craftState.perchKind = perch.phase === 'flight' ? null : perch.kind || null;
    craftState.flapPower = wings.power;
    craftState.wingTuck = wings.tuck;
    craftState.landing = perch.phase === 'landing' ? clamp(perch.elapsed / perch.duration, 0, 1) : perch.phase === 'perched' ? 1 : 0;
    craftState.perchedSeconds = perch.phase === 'perched' ? perch.perchedSeconds : 0;
    craftState.flapPhase = wings.phase - Math.floor(wings.phase);
    craftState.flapAmplitude = wings.amplitude;
    craftState.flapCount = wings.count;
    craftState.flapFrequency = wings.frequency;
    // The dragon's fire lights lanterns (the ability counts them); the journal hears it here.
    const lit = Number.isFinite(craftState.lanternsLit) ? craftState.lanternsLit : 0;
    if (lit > reportedLanterns) {
      emitStat('dragonLanternsLit', lit - reportedLanterns, 'add');
      reportedLanterns = lit;
    }
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) state.position.copy(pose.position);
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    limbs.roll = 0;
    limbs.pitch = 0;
    limbs.yaw = 0;
    wings.tuck = 0;
    wings.power = clamp(finiteOr(pose.throttle, 0), 0, 1);
    wings.amplitude = wings.power > GLIDE_POWER ? 0.35 + 0.65 * Math.sqrt(wings.power) : 0;
    perch.cooldownId = '';
    perch.cooldownSeconds = 0;
    perch.standSeconds = 0;
    perch.scanTimer = SCAN_SECONDS;
    tick.load = 1;
    soar.low = Infinity;
    soar.timer = 0;
    computeAttitude();
    if (craftState) {
      craftState.takeoffRequest = false;
      craftState.perchTarget = null;
    }
    groundContact.reset(Boolean(pose.onGround));
    landing.reset(Boolean(pose.onGround));
    resetCount++;
    flightData.resetCount = resetCount;
    if (pose.onGround) {
      // A resting pose stands still where it was put; the first step decides on what (settleFromReset).
      state.velocity.set(0, 0, 0);
      state.angularVelocity.set(0, 0, 0);
      levelAttitude(flightData.heading, 0, state.quaternion);
      perch.x = state.position.x;
      perch.y = state.position.y - feetHeight;
      perch.z = state.position.z;
      perch.heading = flightData.heading;
      perch.kind = 'ground';
      perch.id = '';
      perch.perchedSeconds = 0;
      perch.minThrottle = 1;
      perch.checkTimer = PERCH_CHECK_SECONDS;
      setPhase('perched');
      restReport.onGround = true;
      restReport.contacts = 2;
      restReport.gearContacts = 2;
      pendingRest = true;
      if (lastEnv) settleFromReset(lastEnv);
    } else {
      pendingRest = false;
      perch.kind = '';
      perch.id = '';
      setPhase('flight');
      // Airborne: pitch the body to the glide's trim angle of attack on the flight path it was given.
      const speed = state.velocity.length();
      if (speed > 3) {
        const horizontal = planar(state.velocity.x, state.velocity.z);
        const heading = horizontal > 0.5 ? headingFromVector(state.velocity.x, state.velocity.z) : flightData.heading;
        const path = Math.atan2(state.velocity.y, Math.max(horizontal, 0.1));
        levelAttitude(heading, clamp(path + trimAoa, -80 * DEG, 80 * DEG), state.quaternion);
      }
    }
    tick.horizontal = planar(state.velocity.x, state.velocity.z);
    tick.sink = Math.max(0, -state.velocity.y);
    tick.flightPath = Math.atan2(state.velocity.y, Math.max(tick.horizontal, 0.1));
    airWorld.copy(state.velocity);
    computeAttitude();
    flightData.airspeed = state.velocity.length();
    flightData.onGround = Boolean(pose.onGround);
    writeCraftState();
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    const flying = perch.phase === 'flight';
    flight.aoa = flying ? flightData.aoa / DEG : 0;
    flight.sideslip = flying ? flightData.sideslip / DEG : 0;
    flight.gLoad = flightData.gLoad;
    flight.throttle = wings.power;
    flight.afterburner = false;
    flight.engineOn = true;
    flight.rpm = wings.amplitude > 0.01 ? wings.frequency / flapProfile.frequency[1] : 0;
    flight.rotorRpm = 0;
    flight.torque = 0;
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.gear.retractable = false;
    flight.gear.down = perch.phase !== 'flight';
    flight.gear.transit = 0;
    flight.airbrake = 0;
    flight.brakes = 0;
    flight.trim = 0;
    flight.contacts = activeReport.contacts;
    flight.stall.stalled = flightData.stalled;
    flight.stall.buffet = Math.round(clamp(flightData.stallDepth, 0, 1) * 1000) / 1000;
    flight.stall.warning = stallWarningActive(flight.assists, flightData.stallMargin, flightData.stalled, !flying || flightData.onGround || flightData.airspeed < 4);
    flight.overspeed = flightData.airspeed > flightData.vne;
    if (flying) flight.glideRatio = flightData.glideRatio;
    flight.radarAltitude = Math.max(0, flight.agl - feetHeight);
  }

  function snapshot() {
    return {
      kind: 'flapper',
      position: [state.position.x, state.position.y, state.position.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      limbs: [limbs.roll, limbs.pitch, limbs.yaw],
      wings: { ...wings },
      perch: { ...perch },
      landingCurve: [landingStart.x, landingStart.y, landingStart.z, landingVelocity.x, landingVelocity.y, landingVelocity.z, landingEnd.x, landingEnd.y, landingEnd.z],
      landingQuaternion: [landingQuaternion.x, landingQuaternion.y, landingQuaternion.z, landingQuaternion.w],
      load: tick.load,
      glide: [tick.horizontal, tick.sink],
      time: tick.time,
      contact: groundContact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'flapper') return false;
    state.position.fromArray(data.position);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    [limbs.roll, limbs.pitch, limbs.yaw] = data.limbs;
    Object.assign(wings, data.wings);
    Object.assign(perch, data.perch);
    landingStart.fromArray(data.landingCurve, 0);
    landingVelocity.fromArray(data.landingCurve, 3);
    landingEnd.fromArray(data.landingCurve, 6);
    landingQuaternion.fromArray(data.landingQuaternion).normalize();
    tick.load = finiteOr(data.load, 1);
    tick.horizontal = finiteOr(data.glide[0], 0);
    tick.sink = finiteOr(data.glide[1], 0);
    tick.time = finiteOr(data.time, tick.time);
    groundContact.restore(data.contact);
    landing.restore(data.landing);
    setPhase(perch.phase);
    restReport.onGround = perch.phase === 'perched';
    restReport.contacts = restReport.onGround ? 2 : 0;
    restReport.gearContacts = restReport.contacts;
    computeAttitude();
    writeCraftState();
    return true;
  }

  setPhase('flight');

  return {
    kind: 'flapper',
    profile,
    state,
    surfaces,
    flightData,
    reset,
    step,
    writeTelemetry,
    snapshot,
    restore,

    /** The contact report: the bird's ground contact in flight, its own resting report on a perch. */
    get contact() {
      return activeReport;
    },
    get resetCount() {
      return resetCount;
    },
    get phase() {
      return perch.phase;
    },
    get landings() {
      return landing.landings;
    },
    /** The perch the bird stands on or is landing on ({ phase, kind, id, x, y, z, heading }). */
    get perch() {
      return { phase: perch.phase, kind: perch.kind, id: perch.id, x: perch.x, y: perch.y, z: perch.z, heading: perch.heading };
    },
    /** Takes off from the perch now (the copilot's "take off"); false when not perched. */
    takeOff() {
      if (perch.phase !== 'perched') return false;
      takeOff();
      return true;
    },

    dispose() {
      groundContact.report.touchdown = null;
      groundContact.report.bodyStrike = null;
      if (craftState) {
        craftState.perched = false;
        craftState.perchId = null;
        craftState.landing = 0;
        craftState.takeoffRequest = false;
        craftState.perchTarget = null;
      }
    },
  };
}
