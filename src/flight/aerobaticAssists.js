// Aerobatic assists: the assists of the 'aerobatic' model kind (SimFixedWing flying the aerobatic
// airframe with its extension, aerobaticAero.js), registered through the assists' public API as their
// catalog and handler, with the fixed-wing autopilot and trim reused. An aerobatic aircraft keeps its
// whole attitude envelope at every level: no bank or pitch attitude protection (the fixed-wing
// catalog's), since loops, rolls and inverted flight are what it is for. The forgiveness is in the
// limiters, the dampers and the hands-off holds instead:
//   0 -> 50 %    auto-coordination (rudder toward zero sideslip; the pilot's rudder takes over as it is
//                pushed, so a snap roll's or a knife-edge's rudder is never fought), a yaw damper (also
//                yielding to the pedals), auto-trim (the trim follows a gentle stick in near-level
//                flight, never a figure's pull; hands off it holds the flight path inside a gentle load
//                band, upright), stall warning
//   50 -> 100 %  AoA limiter (both signs: the symmetric wing stalls inverted at the same angle, so no
//                stall, no snap, no spin), G limiter (+8.5 / -6 g of the +-10 g airframe), auto-level
//                when every axis is hands off (it also rolls an inverted craft back upright), overspeed
//                protection (the power comes back near Vne)
//   0 %          raw physics: snap rolls, spins, tumbles (the lomcevak is credited only at 25 % or less)
// Below MIN_AIRSPEED (the top of a hammerhead or a tailslide, the ground roll) the air assists stand down
// and the controls are the pilot's.
import { DEG, clamp } from '../core/util.js';
import { smoothstep } from './aero.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { autopilotHandlerFor, registerAutopilotHandler } from './autopilot.js';
import { registerTrimHandler, trimHandlerFor } from './trim.js';

export const AEROBATIC_MODEL_KIND = 'aerobatic';

/** Assist tuning (SI, radians). */
const TUNING = Object.freeze({
  IDLE: 0.05,
  MIN_AIRSPEED: 15,
  COORDINATION: Object.freeze({ GAIN: 3.5, RATE_GAIN: 0.6, LIMIT: 0.6 }),
  YAW_DAMPER: 0.35,
  AUTO_LEVEL: Object.freeze({ DELAY: 1, BANK_GAIN: 1.1, RATE_GAIN: 0.18, LIMIT: 0.45 }),
  AUTO_TRIM: Object.freeze({
    IDLE_DELAY: 0.3,
    /** While a gentle stick (under FOLLOW_STICK, within FOLLOW_ATTITUDE of level) is held the trim creeps toward it over this many seconds. */
    FOLLOW_SECONDS: 4,
    FOLLOW_STICK: 0.3,
    FOLLOW_ATTITUDE: 35 * DEG,
    /** Hands off: a path hold (trim per rad s of path error, per rad/s of pitch rate, per g s past the band). */
    HOLD_INTEGRAL: 0.5,
    HOLD_DAMPING: 0.25,
    HOLD_LOAD: 0.2,
    MIN_LOAD: 0.8,
    MAX_LOAD: 1.2,
    /** The hold's gains scale with REFERENCE_PRESSURE / q (Pa), at most MAX_SCALE. */
    REFERENCE_PRESSURE: 4000,
    MAX_SCALE: 6,
    LIMIT: 0.6,
    GROUND_DECAY_SECONDS: 5,
    /** Upside down the hold rests (auto-level rolls the craft upright first, when it is on). */
    INVERTED_BANK: 100 * DEG,
  }),
  LIMITER: Object.freeze({
    AOA_MARGIN: 2.5 * DEG,
    AOA_BAND: 5 * DEG,
    AOA_LEAD: 0.12,
    /** Inside the band the elevator may move toward the limit at GAIN x the margin per second; past it, back at OVERSHOOT. */
    AOA_GAIN: 9,
    AOA_OVERSHOOT_GAIN: 50,
    G_POSITIVE_SHARE: 0.85,
    G_NEGATIVE_SHARE: 0.6,
    G_BAND: 1.2,
    G_LEAD: 0.08,
    G_GAIN: 1.2,
    G_OVERSHOOT_GAIN: 3,
    RATE_SMOOTHING: 18,
  }),
  OVERSPEED: Object.freeze({ START: 0.88, FULL: 1, LEAD: 1.5 }),
});

registerAssistCatalog(AEROBATIC_MODEL_KIND, [
  { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
  { key: 'yawDamper', name: 'yaw damper', from: 0, full: 0.5 },
  { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
  { key: 'stallWarning', name: 'stall warning', from: 0, full: 0 },
  { key: 'aoaLimiter', name: 'AoA limiter', from: 0.5, full: 1 },
  { key: 'gLimiter', name: 'G limiter', from: 0.5, full: 1 },
  { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
  { key: 'overspeedProtection', name: 'overspeed protection', from: 0.5, full: 1 },
]);

function createMemory() {
  return {
    resetCount: -1,
    trim: 0,
    pitchIdleSeconds: 0,
    allIdleSeconds: 0,
    holdingPath: false,
    pathHold: 0,
    lastSideslip: NaN,
    lastAoa: NaN,
    aoaRate: 0,
    lastLoad: NaN,
    loadRate: 0,
    lastSpeed: NaN,
    acceleration: 0,
    /** The final elevator of the last tick (the limiters move from it). */
    lastPitch: 0,
    primed: null,
  };
}

/** Starts from a trimmed state (trim.js): seeded on the next airborne tick. */
function primeMemory(memory, trim) {
  memory.primed = trim;
}

function applyPrime(memory, trim, data) {
  const elevator = clamp(Number.isFinite(trim.elevator) ? trim.elevator : 0, -1, 1);
  memory.trim = clamp(elevator, -TUNING.AUTO_TRIM.LIMIT, TUNING.AUTO_TRIM.LIMIT);
  memory.lastPitch = elevator;
  memory.holdingPath = Number.isFinite(trim.flightPath);
  memory.pathHold = memory.holdingPath ? trim.flightPath : 0;
  memory.pitchIdleSeconds = TUNING.AUTO_TRIM.IDLE_DELAY;
  memory.allIdleSeconds = TUNING.AUTO_LEVEL.DELAY;
  memory.lastAoa = data.aoa;
  memory.aoaRate = 0;
  memory.lastLoad = data.gLoad;
  memory.loadRate = 0;
  memory.lastSpeed = data.airspeed;
  memory.acceleration = 0;
  memory.lastSideslip = NaN;
}

/** Smoothed rates the limiters lead with: angle of attack (rad/s), load (g/s), airspeed (m/s^2). */
function updateRates(data, memory, dt) {
  const smoothing = 1 - Math.exp(-TUNING.LIMITER.RATE_SMOOTHING * dt);
  const aoaRate = Number.isFinite(memory.lastAoa) ? clamp((data.aoa - memory.lastAoa) / dt, -3, 3) : 0;
  memory.lastAoa = data.aoa;
  memory.aoaRate += (aoaRate - memory.aoaRate) * smoothing;
  const loadRate = Number.isFinite(memory.lastLoad) ? clamp((data.gLoad - memory.lastLoad) / dt, -60, 60) : 0;
  memory.lastLoad = data.gLoad;
  memory.loadRate += (loadRate - memory.loadRate) * smoothing;
  const acceleration = Number.isFinite(memory.lastSpeed) ? clamp((data.airspeed - memory.lastSpeed) / dt, -20, 20) : 0;
  memory.lastSpeed = data.airspeed;
  memory.acceleration += (acceleration - memory.acceleration) * (1 - Math.exp(-4 * dt));
}

/** Rudder toward zero sideslip; the pilot's rudder takes over as it is pushed. */
function coordinate(controls, data, weight, memory, dt) {
  const tuning = TUNING.COORDINATION;
  const sideslipRate = Number.isFinite(memory.lastSideslip) ? clamp((data.sideslip - memory.lastSideslip) / dt, -2, 2) : 0;
  memory.lastSideslip = data.sideslip;
  const command = clamp(tuning.GAIN * data.sideslip + tuning.RATE_GAIN * sideslipRate, -tuning.LIMIT, tuning.LIMIT);
  const share = weight * (1 - Math.min(1, Math.abs(controls.yaw)));
  controls.yaw = clamp(controls.yaw + share * command, -1, 1);
}

/** Yaw damper, yielding to the pilot's pedals like the coordination. */
function dampYaw(controls, data, weight, pilotYaw) {
  const share = weight * (1 - Math.min(1, Math.abs(pilotYaw)));
  controls.yaw = clamp(controls.yaw - share * TUNING.YAW_DAMPER * data.yawRate, -1, 1);
}

/** Hands off every axis for DELAY seconds, the wings come back level (the shorter way round). */
function autoLevel(controls, data, weight, memory, dt) {
  const tuning = TUNING.AUTO_LEVEL;
  const idle = Math.abs(controls.roll) < TUNING.IDLE && Math.abs(controls.pitch) < TUNING.IDLE && Math.abs(controls.yaw) < TUNING.IDLE;
  memory.allIdleSeconds = idle ? memory.allIdleSeconds + dt : 0;
  if (!idle || memory.allIdleSeconds < tuning.DELAY) return;
  const command = clamp(-tuning.BANK_GAIN * data.bank - tuning.RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT);
  controls.roll = clamp(controls.roll + weight * command, -1, 1);
}

/** The power comes back as the airspeed (predicted from its acceleration) nears Vne. */
function protectOverspeed(controls, data, weight, memory) {
  const tuning = TUNING.OVERSPEED;
  if (!(data.vne > 0) || !Number.isFinite(controls.throttle)) return;
  const predicted = data.airspeed + tuning.LEAD * Math.max(memory.acceleration, 0);
  const share = weight * smoothstep(tuning.START * data.vne, tuning.FULL * data.vne, predicted);
  if (share > 0) controls.throttle *= 1 - share;
}

/**
 * Auto-trim: while the stick is held the trim creeps toward it; hands off (and upright) a PI loop
 * holds the flight path captured at release, inside the hands-off load band. Returns the trimmed stick.
 */
function autoTrim(stick, data, weight, memory, dt) {
  const tuning = TUNING.AUTO_TRIM;
  const idle = Math.abs(stick) < TUNING.IDLE;
  memory.pitchIdleSeconds = idle ? memory.pitchIdleSeconds + dt : 0;
  const upright = Math.abs(data.bank) < tuning.INVERTED_BANK;
  if (!idle) {
    // Only a gentle stick in near-level flight is relieved: the pull of a figure is never trimmed in,
    // so letting go after a loop leaves no stored pull behind.
    memory.holdingPath = false;
    const cruising = Math.abs(stick) < tuning.FOLLOW_STICK && Math.abs(data.bank) < tuning.FOLLOW_ATTITUDE && Math.abs(data.pitch) < tuning.FOLLOW_ATTITUDE;
    if (cruising) memory.trim += (weight * stick * dt) / tuning.FOLLOW_SECONDS;
  } else if (memory.pitchIdleSeconds >= tuning.IDLE_DELAY && upright) {
    if (!memory.holdingPath) {
      memory.holdingPath = true;
      memory.pathHold = data.flightPath;
    }
    const excess = Math.max(0, data.gLoad - tuning.MAX_LOAD) + Math.min(0, data.gLoad - tuning.MIN_LOAD);
    if (excess !== 0) memory.pathHold = data.flightPath;
    const scale = clamp(tuning.REFERENCE_PRESSURE / Math.max(data.dynamicPressure, 200), 0.05, tuning.MAX_SCALE);
    const error = memory.pathHold - data.flightPath;
    memory.trim += weight * scale * (tuning.HOLD_INTEGRAL * error - tuning.HOLD_DAMPING * data.pitchRate - tuning.HOLD_LOAD * excess) * dt;
  } else if (!upright) {
    memory.holdingPath = false;
  }
  memory.trim = clamp(memory.trim, -tuning.LIMIT, tuning.LIMIT);
  return clamp(stick + memory.trim, -1, 1);
}

/**
 * One limit on the elevator, as a ceiling (upper) or floor: outside `band` of the limit none; inside it
 * the elevator may only move toward the limit at gain x margin per second, and comes back past it at
 * overshoot x the excess.
 */
function limitStep(lastPitch, margin, band, gain, overshoot, dt, upper) {
  if (margin >= band) return upper ? Infinity : -Infinity;
  const allowed = (gain * margin + overshoot * Math.min(margin, 0)) * dt;
  return upper ? lastPitch + allowed : lastPitch - allowed;
}

/** The AoA and G limiters on the final elevator, each weighted. Returns the change they made. */
function applyLimiters(controls, data, weights, memory, dt) {
  const tuning = TUNING.LIMITER;
  const desired = controls.pitch;
  let ceiling = Infinity;
  let floor = -Infinity;
  const weigh = (limit, weight, upper) => {
    if (!(weight > 0) || !Number.isFinite(limit)) return;
    if (upper && limit < desired) ceiling = Math.min(ceiling, desired + weight * (limit - desired));
    if (!upper && limit > desired) floor = Math.max(floor, desired + weight * (limit - desired));
  };
  if (weights.aoaLimiter > 0) {
    // The wing is symmetric: the negative stall sits at minus the positive one.
    const predicted = data.aoa + tuning.AOA_LEAD * memory.aoaRate;
    const limit = data.aoaCritical - tuning.AOA_MARGIN;
    const panelMargin = Number.isFinite(data.panelMargin) ? data.panelMargin - tuning.AOA_MARGIN - tuning.AOA_LEAD * memory.aoaRate : Infinity;
    weigh(limitStep(memory.lastPitch, Math.min(limit - predicted, panelMargin), tuning.AOA_BAND, tuning.AOA_GAIN, tuning.AOA_OVERSHOOT_GAIN, dt, true), weights.aoaLimiter, true);
    weigh(limitStep(memory.lastPitch, predicted + limit, tuning.AOA_BAND, tuning.AOA_GAIN, tuning.AOA_OVERSHOOT_GAIN, dt, false), weights.aoaLimiter, false);
  }
  if (weights.gLimiter > 0) {
    const predicted = data.gLoad + tuning.G_LEAD * memory.loadRate;
    weigh(limitStep(memory.lastPitch, tuning.G_POSITIVE_SHARE * data.gLimit - predicted, tuning.G_BAND, tuning.G_GAIN, tuning.G_OVERSHOOT_GAIN, dt, true), weights.gLimiter, true);
    weigh(limitStep(memory.lastPitch, predicted + tuning.G_NEGATIVE_SHARE * data.gLimit, tuning.G_BAND, tuning.G_GAIN, tuning.G_OVERSHOOT_GAIN, dt, false), weights.gLimiter, false);
  }
  controls.pitch = clamp(clamp(desired, Math.min(floor, ceiling), ceiling), -1, 1);
  return controls.pitch - desired;
}

registerAssistHandler(AEROBATIC_MODEL_KIND, Object.freeze({
  createMemory,
  prime: primeMemory,

  apply(controls, context, weights, memory) {
    const data = context.model.flightData;
    const dt = context.dt;
    updateRates(data, memory, dt);
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (data.onGround || data.airspeed < TUNING.MIN_AIRSPEED) {
      // On the ground (and at the top of a vertical line) the controls are the pilot's; the trim
      // creeps back to neutral on the ground.
      if (data.onGround) memory.trim -= memory.trim * Math.min(1, dt / TUNING.AUTO_TRIM.GROUND_DECAY_SECONDS);
      memory.holdingPath = false;
      memory.lastSideslip = NaN;
      memory.allIdleSeconds = 0;
      memory.lastPitch = controls.pitch;
      return;
    }
    if (memory.primed) {
      applyPrime(memory, memory.primed, data);
      memory.primed = null;
    }
    const pilotYaw = controls.yaw;
    if (!autopilotFlying) {
      if (weights.autoLevel > 0) autoLevel(controls, data, weights.autoLevel, memory, dt);
      if (weights.coordination > 0) coordinate(controls, data, weights.coordination, memory, dt);
    }
    if (weights.yawDamper > 0) dampYaw(controls, data, weights.yawDamper, pilotYaw);
    if (weights.overspeedProtection > 0) protectOverspeed(controls, data, weights.overspeedProtection, memory);

    const stick = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    const handsOff = Math.abs(stick) < TUNING.IDLE;
    if (weights.autoTrim > 0 && !autopilotFlying) controls.pitch = autoTrim(stick, data, weights.autoTrim, memory, dt);
    else if (autopilotFlying) memory.trim = clamp(stick, -TUNING.AUTO_TRIM.LIMIT, TUNING.AUTO_TRIM.LIMIT);
    if (weights.aoaLimiter > 0 || weights.gLimiter > 0) {
      const change = applyLimiters(controls, data, weights, memory, dt);
      // Anti-windup: hands off, the trim follows a limited elevator, so letting go stores no pull.
      if (change !== 0 && handsOff && !autopilotFlying) memory.trim = clamp(memory.trim + change, -TUNING.AUTO_TRIM.LIMIT, TUNING.AUTO_TRIM.LIMIT);
    }
    memory.lastPitch = controls.pitch;
  },
}));

// The aerobatic craft flies the fixed-wing autopilot (heading, altitude and speed hold, waypoints,
// rings, terrain) and the fixed-wing trim (the same airframe model).
const fixedWingAutopilot = autopilotHandlerFor('fixedWing');
if (fixedWingAutopilot) registerAutopilotHandler(AEROBATIC_MODEL_KIND, fixedWingAutopilot);
const fixedWingTrim = trimHandlerFor('fixedWing');
if (fixedWingTrim) registerTrimHandler(AEROBATIC_MODEL_KIND, fixedWingTrim);
