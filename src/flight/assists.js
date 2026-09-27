// SIM assists: the helpers between the pilot's ControlState and the flight model. They run as one
// control stage (flightModels.registerControlStage) every physics tick, after the autopilot stage, so
// the limiters protect autopilot commands too. The level is 0..1 per craft (settings.assists[craftId],
// forced to 1 by the controller's hands-off hold):
//   100 %  auto-coordination, AoA / stall limiter, auto-level when hands off, G limiter, flight-path
//          hold, bank and pitch protection (helicopter: auto-hover and heading hold; drone: angle
//          mode with altitude hold)
//    50 %  auto-coordination, auto-trim, stall warning only
//     0 %  raw physics
// In between, every assist has a weight that ramps with the level: coordination, auto-trim and the
// stall warning come in over 0-50 %, the limiters, protections, auto-level and the flight-path hold
// over 50-100 %.
//
// Each model kind has a catalog (what describeAssists lists for the UI tooltip and what fills
// state.flight.activeAssists) and a handler that applies the assists to its controls. The fixed-wing
// handler lives here; later models register theirs:
//   registerAssistCatalog('helicopter', [...entries]);   // optional: replaces the default entries
//   registerAssistHandler('helicopter', { createMemory(), apply(controls, context, weights, memory), prime?(memory, trim) });
//
// A handler may also take a prime: after the controller trims a model (mode switch, respawn, craft
// switch, tow release; see trim.js) it calls primeAssists(model, trim) and the handler's memory starts
// from the trimmed state (trim, holds and timers) instead of from scratch, so nothing jumps.
import { DEG, clamp } from '../core/util.js';
import { smoothstep } from './aero.js';
import { neutralLoad } from './trim.js';

export const ASSIST_STAGE_ORDER = 40;
const GRAVITY = 9.81;

/**
 * Catalog entries: { key, name, from, full }: the weight ramps from 0 at level `from` to 1 at level
 * `full` (from === full means "on above that level").
 */
const DEFAULT_CATALOGS = {
  fixedWing: [
    { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
    { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
    { key: 'stallWarning', name: 'stall warning', from: 0, full: 0 },
    { key: 'aoaLimiter', name: 'AoA limiter', from: 0.5, full: 1 },
    { key: 'gLimiter', name: 'G limiter', from: 0.5, full: 1 },
    { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
    { key: 'pathHold', name: 'flight-path hold', from: 0.5, full: 1 },
    { key: 'bankProtection', name: 'bank protection', from: 0.5, full: 1 },
    { key: 'pitchProtection', name: 'pitch protection', from: 0.5, full: 1 },
    { key: 'overspeedProtection', name: 'overspeed protection', from: 0.5, full: 1 },
  ],
  helicopter: [
    { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
    { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
    { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
    { key: 'autoHover', name: 'auto-hover', from: 0.5, full: 1 },
    { key: 'headingHold', name: 'heading hold', from: 0.5, full: 1 },
  ],
  quad: [
    { key: 'angleMode', name: 'angle mode', from: 0.5, full: 1 },
    { key: 'altitudeHold', name: 'altitude hold', from: 0.5, full: 1 },
  ],
};

const catalogs = new Map(Object.entries(DEFAULT_CATALOGS).map(([kind, entries]) => [kind, Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))]));
const handlers = new Map();
/** Trimmed states waiting for their model's next assist tick (primeAssists). */
const pendingPrimes = new WeakMap();

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function entryWeight(entry, level) {
  if (entry.full <= entry.from) return level > entry.from ? 1 : 0;
  return clamp((level - entry.from) / (entry.full - entry.from), 0, 1);
}

/** Replaces the assist catalog of a model kind (entries as above). */
export function registerAssistCatalog(kind, entries) {
  if (!Array.isArray(entries)) throw new TypeError(`assist catalog for "${kind}" must be an array`);
  catalogs.set(kind, Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))));
}

/** Registers the handler that applies a model kind's assists: { createMemory(), apply(controls, context, weights, memory), prime?(memory, trim) }. */
export function registerAssistHandler(kind, handler) {
  if (!handler || typeof handler.apply !== 'function') throw new TypeError(`assist handler for "${kind}" needs apply()`);
  handlers.set(kind, handler);
}

export function hasAssistHandler(kind) {
  return handlers.has(kind);
}

/**
 * Starts a model's assist memory from a trimmed state (a trimModel result) on its next assist tick:
 * the trim, the holds and the idle timers, as if the pilot had let go in that state a while ago.
 */
export function primeAssists(model, trim) {
  if (!model || !trim) return false;
  const handler = handlers.get(model.kind);
  if (!handler || typeof handler.prime !== 'function') return false;
  pendingPrimes.set(model, trim);
  return true;
}

/** { key: weight 0..1 } of every assist of a model kind at a level (0..1). */
export function assistWeights(level, modelKind, target = {}) {
  const catalog = catalogs.get(modelKind) ?? [];
  const clamped = clamp(Number.isFinite(level) ? level : 1, 0, 1);
  for (const entry of catalog) target[entry.key] = entryWeight(entry, clamped);
  return target;
}

/** Names of the assists active at a level (0..1) for a model kind, for the UI tooltip. */
export function describeAssists(level, modelKind) {
  const catalog = catalogs.get(modelKind) ?? [];
  const clamped = clamp(Number.isFinite(level) ? level : 1, 0, 1);
  return catalog.filter((entry) => entryWeight(entry, clamped) > 0).map((entry) => entry.name);
}

/** The stall warning (horn and HUD cue): any assist level above 0, within the margin, airborne. */
export const STALL_WARNING_MARGIN = 3.5 * DEG;
export function stallWarningActive(level, stallMargin, stalled, suppressed) {
  if (suppressed || !(level > 0)) return false;
  return stalled || stallMargin < STALL_WARNING_MARGIN;
}

// ============================================================================================
// FIXED-WING ASSISTS
// ============================================================================================
//
// Pitch: one elevator loop whose law blends with the level (fbw = the flight-path hold weight, 0 at
// 50 % and below, 1 at 100 %, faded in over FBW_FADE_SECONDS after take-off so the rotation stays on
// the pilot's direct stick):
//   direct law (50 %)   the stick moves the elevator; the trim follows a held stick over a few seconds,
//                       and hands off a PI loop holds the angle of attack at release (so the speed).
//   load law (100 %)    the stick commands a load factor: neutral holds the 1 g load for the path and
//                       bank (bank-corrected up to NEUTRAL_BANK), full aft adds PULL_LOAD, full forward
//                       takes PUSH_LOAD away. Hands off it holds the flight path at release (clamped to
//                       +-PATH_LIMIT), within a comfort band of load factors, and trades path for speed
//                       near the minimum and maximum speeds; so the speed changes along the path and the
//                       pilot trims it with the stick, which returns to the path hold on release.
// Both laws integrate into the same trim (memory.trimBase), with their error rates blended by the
// weight, so moving the slider never jumps the elevator and the loops never fight each other.
// Hands off, neither law ever trims into more than HANDS_OFF_MAX_LOAD: the direct law's hold lowers
// its angle of attack instead, the load law clamps its command.
//
// Roll: auto-level when the roll axis is idle, bank protection (the roll command toward more bank
// fades out before BANK_LIMIT and reverses past it, so full stick holds about 65 degrees), and
// auto-coordination on the rudder.
//
// Overspeed protection: near Vne the spoilers come out and the power comes back.
//
// Limiters on the final elevator (they also protect the autopilot): the AoA and G limiters and the
// pitch attitude protection (+PITCH_UP_LIMIT / PITCH_DOWN_LIMIT): an elevator ceiling (and floor)
// that, inside a band near the limit, may only move toward the limit as fast as the remaining margin
// allows and pushes back past it. Hands off the integrator is kept consistent with a limited output
// (anti-windup), so letting go never leaves a stored pull behind.
const FIXED_WING = Object.freeze({
  /** Stick inside this is "hands off" for that axis. */
  IDLE: 0.05,
  /** Below this airspeed (m/s) or on the ground the air assists stand down (the rudder steers). */
  MIN_AIRSPEED: 9,
  COORDINATION: Object.freeze({ SIDESLIP_GAIN: 4.5, SIDESLIP_RATE_GAIN: 0.9, AILERON_FEED: 0.1, LIMIT: 0.7 }),
  AUTO_LEVEL: Object.freeze({ DELAY: 0.5, BANK_GAIN: 1.4, RATE_GAIN: 0.45, LIMIT: 0.5 }),
  BANK_PROTECTION: Object.freeze({
    BANK_LIMIT: 66 * DEG,
    /** Bank predicted this many seconds ahead from the roll rate (roll inertia). */
    LEAD: 0.5,
    /** Roll command allowed toward more bank per rad of margin left. */
    GAIN: 2.5,
  }),
  AUTO_TRIM: Object.freeze({
    IDLE_DELAY: 0.25,
    /** While the stick is held, the trim creeps toward it over this many seconds (relieving the pilot). */
    FOLLOW_SECONDS: 3,
    /** Hands off, a PI loop holds the angle of attack captured at release (elevator per rad, per rad s). */
    HOLD_P: 1.6,
    HOLD_I: 2.4,
    /** The hold never trims closer to the critical angle of attack than this, nor below LOW_SPAN under it. */
    STALL_MARGIN: 4 * DEG,
    LOW_SPAN: 15 * DEG,
    MAX_OFFSET: 0.8,
    GROUND_DECAY_SECONDS: 6,
  }),
  LOAD_LAW: Object.freeze({
    PULL_LOAD: 2.5,
    PUSH_LOAD: 1.5,
    /** Load loop (elevator per g and per g s, pitch damping per rad/s), scheduled by dynamic pressure. */
    LOAD_P: 0.55,
    LOAD_I: 0.9,
    PITCH_DAMPING: 0.35,
    SCHEDULE_REFERENCE: 1.5,
    SCHEDULE_MIN: 0.12,
    SCHEDULE_MAX: 2,
    /** After take-off (or a stand-down) the load law fades in over this long. */
    FBW_FADE_SECONDS: 3,
    /** Hands off, the load command moves at most this fast (g/s). */
    HANDS_OFF_SLEW: 2,
  }),
  PATH_HOLD: Object.freeze({
    /** The held flight path is captured at release, clamped to +-PATH_LIMIT. */
    PATH_LIMIT: 10 * DEG,
    /** Load factor per rad of path error, per m/s of speed (the path loop: v * gain * error / g). */
    PATH_GAIN: 0.9,
    /** Speed protection: below MIN_SPEED_FACTOR x stall speed and above MAX_SPEED_FACTOR x Vne the path gives way. */
    MIN_SPEED_FACTOR: 1.3,
    MAX_SPEED_FACTOR: 0.88,
    /** Path change (rad) per m/s of speed beyond the protection speed, and per m/s^2 of acceleration. */
    SPEED_GAIN: 1.2 * DEG,
    ACCELERATION_GAIN: 2 * DEG,
    PROTECTED_PATH_MIN: -15 * DEG,
    PROTECTED_PATH_MAX: 12 * DEG,
    ACCELERATION_SMOOTHING: 4,
  }),
  /** Hands-off comfort band of load factors (both laws; a little inside 0.8-1.3 g for the loop's overshoot). */
  HANDS_OFF_MIN_LOAD: 0.85,
  HANDS_OFF_MAX_LOAD: 1.25,
  /** Overspeed protection: spoilers out and power back from START to FULL x Vne, predicted LEAD seconds ahead. */
  OVERSPEED: Object.freeze({ START: 0.9, FULL: 1, LEAD: 1.5 }),
  /** Pitch attitude protection in the load law (rad; attitude rate per rad of margin). */
  PITCH_PROTECTION: Object.freeze({
    PITCH_UP_LIMIT: 30 * DEG,
    PITCH_DOWN_LIMIT: -20 * DEG,
    PITCH_RATE_GAIN: 0.5,
    PUSH_MARGIN: 0.2,
  }),
  LIMITER: Object.freeze({
    AOA_MARGIN: 2 * DEG,
    /** The limiter acts inside this band below the limit, predicting the angle of attack LEAD seconds ahead. */
    AOA_BAND: 5 * DEG,
    AOA_LEAD: 0.35,
    AOA_GAIN: 7,
    /** Past the limit the elevator comes back faster (stick per second per rad, per g of overshoot). */
    AOA_OVERSHOOT_GAIN: 60,
    G_OVERSHOOT_GAIN: 4,
    NEGATIVE_AOA: -8 * DEG,
    G_SHARE: 0.9,
    NEGATIVE_G_SHARE: 0.4,
    G_BAND: 0.9,
    G_GAIN: 0.9,
    RATE_SMOOTHING: 18,
    /** Direct law, hands off: the comfort ceiling, a narrower band below HANDS_OFF_MAX_LOAD. */
    COMFORT_BAND: 0.25,
    COMFORT_GAIN: 1.2,
    COMFORT_OVERSHOOT_GAIN: 2,
    /** Direct law: the pitch attitude protection as an elevator limit, predicted PITCH_LEAD seconds ahead. */
    PITCH_BAND: 6 * DEG,
    PITCH_LEAD: 0.6,
    PITCH_GAIN: 5,
    PITCH_OVERSHOOT_GAIN: 4,
  }),
});

function createFixedWingMemory() {
  return {
    resetCount: -1,
    pitchIdleSeconds: 0,
    rollIdleSeconds: 0,
    trimBase: 0,
    holding: false,
    holdAoa: 0,
    pathHolding: false,
    pathHold: 0,
    /** The load law's hands-off command (g), slewed; NaN until the stick goes idle. */
    handsOffLoad: NaN,
    /** Seconds the air assists have been flying since the last stand-down (the load law fades in). */
    airborneSeconds: 0,
    lastSideslip: NaN,
    lastAoa: NaN,
    aoaRate: 0,
    lastAttitude: NaN,
    attitudeRate: 0,
    lastSpeed: NaN,
    acceleration: 0,
    lastPitch: 0,
  };
}

/** Starts the memory from a trimmed state: trim at the trimmed elevator, holds captured, timers run out. */
function primeFixedWingMemory(memory, trim) {
  const autoTrim = FIXED_WING.AUTO_TRIM;
  if (Number.isFinite(trim.elevator)) {
    memory.trimBase = clamp(trim.elevator, -1, 1);
    memory.lastPitch = memory.trimBase;
  }
  if (Number.isFinite(trim.aoa)) {
    memory.holding = true;
    memory.holdAoa = trim.aoa;
    memory.lastAoa = trim.aoa;
  }
  if (Number.isFinite(trim.flightPath)) {
    memory.pathHolding = true;
    memory.pathHold = clamp(trim.flightPath, -FIXED_WING.PATH_HOLD.PATH_LIMIT, FIXED_WING.PATH_HOLD.PATH_LIMIT);
  }
  memory.handsOffLoad = Number.isFinite(trim.load) ? trim.load : NaN;
  memory.pitchIdleSeconds = autoTrim.IDLE_DELAY;
  memory.rollIdleSeconds = FIXED_WING.AUTO_LEVEL.DELAY;
  memory.airborneSeconds = FIXED_WING.LOAD_LAW.FBW_FADE_SECONDS;
  memory.aoaRate = 0;
  memory.attitudeRate = 0;
  memory.acceleration = 0;
  memory.lastAttitude = NaN;
  memory.lastSpeed = NaN;
  memory.lastSideslip = NaN;
}

/** Smoothed rates the loops read: airspeed change (m/s^2) and pitch attitude change (rad/s). */
function updateRates(data, memory, dt) {
  const speedRate = Number.isFinite(memory.lastSpeed) ? clamp((data.airspeed - memory.lastSpeed) / dt, -15, 15) : 0;
  memory.lastSpeed = data.airspeed;
  memory.acceleration += (speedRate - memory.acceleration) * (1 - Math.exp(-FIXED_WING.PATH_HOLD.ACCELERATION_SMOOTHING * dt));
  const attitudeRate = Number.isFinite(memory.lastAttitude) ? clamp((data.pitch - memory.lastAttitude) / dt, -3, 3) : 0;
  memory.lastAttitude = data.pitch;
  memory.attitudeRate += (attitudeRate - memory.attitudeRate) * (1 - Math.exp(-FIXED_WING.LIMITER.RATE_SMOOTHING * dt));
}

/**
 * The flight path the hands-off load law steers to: the held path, lowered when the speed falls
 * toward the minimum (1.3 x stall) and raised when it climbs toward Vne, damped by the acceleration.
 */
function protectedPath(data, memory) {
  const tuning = FIXED_WING.PATH_HOLD;
  const speed = data.airspeed;
  let target = memory.pathHold;
  if (Number.isFinite(data.stallSpeed) && data.stallSpeed > 0) {
    const slow = tuning.SPEED_GAIN * (tuning.MIN_SPEED_FACTOR * data.stallSpeed - speed) - tuning.ACCELERATION_GAIN * memory.acceleration;
    if (slow > 0) target -= slow;
  }
  if (Number.isFinite(data.vne) && data.vne > 0) {
    const fast = tuning.SPEED_GAIN * (speed - tuning.MAX_SPEED_FACTOR * data.vne) + tuning.ACCELERATION_GAIN * memory.acceleration;
    if (fast > 0) target += fast;
  }
  return clamp(target, tuning.PROTECTED_PATH_MIN, tuning.PROTECTED_PATH_MAX);
}

/**
 * Bounds of the load law's command: the pitch attitude protection (the attitude may approach
 * PITCH_UP_LIMIT / PITCH_DOWN_LIMIT at PITCH_RATE_GAIN x the margin left, and comes back past them),
 * weighted by its assist weight; hands off, then the comfort band. In climbs steeper than about 35
 * degrees 0.8 g would still curve the path up, so there the floor sits PUSH_MARGIN below the 1 g path
 * load instead: the nose comes down without a zoom.
 */
function protectLoad(loadCommand, data, speed, weight, handsOff) {
  const tuning = FIXED_WING.PITCH_PROTECTION;
  let command = loadCommand;
  if (weight > 0) {
    const cosBank = Math.max(Math.cos(data.bank), 0.3);
    const pathLoad = Math.cos(data.flightPath);
    const upper = (pathLoad + (speed * tuning.PITCH_RATE_GAIN * (tuning.PITCH_UP_LIMIT - data.pitch)) / GRAVITY) / cosBank;
    const lower = (pathLoad + (speed * tuning.PITCH_RATE_GAIN * (tuning.PITCH_DOWN_LIMIT - data.pitch)) / GRAVITY) / cosBank;
    const bounded = clamp(command, Math.min(lower, upper), upper);
    command += weight * (bounded - command);
  }
  if (handsOff) {
    const floor = Math.min(FIXED_WING.HANDS_OFF_MIN_LOAD, Math.cos(data.flightPath) - tuning.PUSH_MARGIN);
    command = clamp(command, floor, FIXED_WING.HANDS_OFF_MAX_LOAD);
  }
  return command;
}

/**
 * Pitch: the direct law (auto-trim) and the load law (flight-path hold), blended by fbw (see above).
 * trimWeight scales the direct law's trim (it comes in over 0-50 %); pitchProtection bounds the load
 * law's command.
 */
function applyPitchAssist(controls, data, trimWeight, fbw, pitchProtection, memory, dt) {
  const autoTrim = FIXED_WING.AUTO_TRIM;
  const law = FIXED_WING.LOAD_LAW;
  const stick = controls.pitch;
  const idle = Math.abs(stick) < FIXED_WING.IDLE;
  memory.pitchIdleSeconds = idle ? memory.pitchIdleSeconds + dt : 0;
  const settled = memory.pitchIdleSeconds >= autoTrim.IDLE_DELAY;
  const highest = data.aoaCritical - autoTrim.STALL_MARGIN;
  const direct = 1 - fbw;

  // Direct law: the trim follows a held stick; hands off, a PI loop holds the angle of attack at release.
  let directRate = 0;
  let directOffset = 0;
  if (!idle) {
    memory.holding = false;
    const nearStall = data.aoa > highest && stick > 0;
    if (!nearStall) directRate = (trimWeight * stick) / autoTrim.FOLLOW_SECONDS;
    directOffset = stick;
  } else if (settled) {
    if (!memory.holding) {
      memory.holding = true;
      memory.holdAoa = clamp(data.aoa, data.aoaCritical - autoTrim.LOW_SPAN, highest);
    }
    const error = memory.holdAoa - data.aoa;
    directRate = trimWeight * autoTrim.HOLD_I * error;
    directOffset = trimWeight * autoTrim.HOLD_P * error;
  }

  // Load law: the stick commands a load factor; hands off, the path at release is held.
  let loadRate = 0;
  let loadOffset = 0;
  if (fbw > 0) {
    const speed = Math.max(data.airspeed, 1);
    const referenceSpeed = Math.max(data.stallSpeed * law.SCHEDULE_REFERENCE, 5);
    const schedule = clamp((referenceSpeed * referenceSpeed) / (speed * speed), law.SCHEDULE_MIN, law.SCHEDULE_MAX);
    const neutral = neutralLoad(data.flightPath, data.bank);
    let loadCommand;
    if (!idle) {
      memory.pathHolding = false;
      memory.handsOffLoad = NaN;
      loadCommand = protectLoad(neutral + stick * (stick > 0 ? law.PULL_LOAD : law.PUSH_LOAD), data, speed, pitchProtection, false);
    } else {
      // The path is tracked until the stick has been idle for IDLE_DELAY, then held.
      if (!memory.pathHolding) {
        memory.pathHold = clamp(data.flightPath, -FIXED_WING.PATH_HOLD.PATH_LIMIT, FIXED_WING.PATH_HOLD.PATH_LIMIT);
        if (settled) memory.pathHolding = true;
      }
      const pathError = protectedPath(data, memory) - data.flightPath;
      const target = protectLoad(neutral + (speed * FIXED_WING.PATH_HOLD.PATH_GAIN * pathError) / GRAVITY, data, speed, pitchProtection, true);
      // Hands off the command moves at most HANDS_OFF_SLEW (from the load flown at release), so a
      // new hold eases in instead of stepping the elevator.
      if (!Number.isFinite(memory.handsOffLoad)) memory.handsOffLoad = clamp(data.gLoad, FIXED_WING.HANDS_OFF_MIN_LOAD, FIXED_WING.HANDS_OFF_MAX_LOAD);
      memory.handsOffLoad = moveToward(memory.handsOffLoad, target, law.HANDS_OFF_SLEW * dt);
      loadCommand = memory.handsOffLoad;
    }
    const loadError = loadCommand - data.gLoad;
    loadRate = schedule * law.LOAD_I * loadError;
    loadOffset = schedule * (law.LOAD_P * loadError - law.PITCH_DAMPING * data.pitchRate);
  }

  memory.trimBase += dt * (direct * directRate + fbw * loadRate);
  const trimLimit = autoTrim.MAX_OFFSET + fbw * (1 - autoTrim.MAX_OFFSET);
  memory.trimBase = clamp(memory.trimBase, -trimLimit, trimLimit);
  controls.pitch = clamp(memory.trimBase + direct * directOffset + fbw * loadOffset, -1, 1);
  return idle;
}

/** Auto-level: hands off the roll axis, the wings come back level. */
function applyAutoLevel(controls, data, weight, memory, dt) {
  const tuning = FIXED_WING.AUTO_LEVEL;
  const idle = Math.abs(controls.roll) < FIXED_WING.IDLE;
  memory.rollIdleSeconds = idle ? memory.rollIdleSeconds + dt : 0;
  if (!idle || memory.rollIdleSeconds < tuning.DELAY) return;
  const command = clamp(-tuning.BANK_GAIN * data.bank - tuning.RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT);
  controls.roll = clamp(controls.roll + weight * command, -1, 1);
}

/**
 * Bank protection: the roll command toward more bank may not exceed GAIN x the margin left to
 * BANK_LIMIT (predicted LEAD seconds ahead), so it fades out as the limit nears and rolls back past it.
 */
function applyBankProtection(controls, data, weight) {
  const tuning = FIXED_WING.BANK_PROTECTION;
  const predicted = data.bank + tuning.LEAD * data.rollRate;
  const side = predicted >= 0 ? 1 : -1;
  const toward = controls.roll * side;
  const allowed = tuning.GAIN * (tuning.BANK_LIMIT - Math.abs(predicted));
  if (toward <= allowed) return;
  controls.roll = clamp(controls.roll + weight * (allowed - toward) * side, -1, 1);
}

/**
 * Overspeed protection: as the airspeed (predicted from its acceleration) nears Vne the spoilers come
 * out (both toe brakes, which is how the models deploy them in the air) and the power comes back.
 */
function applyOverspeedProtection(controls, data, weight, memory) {
  const tuning = FIXED_WING.OVERSPEED;
  if (!(data.vne > 0)) return;
  const predicted = data.airspeed + tuning.LEAD * Math.max(memory.acceleration, 0);
  const share = weight * smoothstep(tuning.START * data.vne, tuning.FULL * data.vne, predicted);
  if (!(share > 0)) return;
  if (data.hasSpoilers) {
    controls.brakeL = Math.max(Number.isFinite(controls.brakeL) ? controls.brakeL : 0, share);
    controls.brakeR = Math.max(Number.isFinite(controls.brakeR) ? controls.brakeR : 0, share);
  }
  if (data.hasEngine && Number.isFinite(controls.throttle)) controls.throttle *= 1 - share;
}

/** Auto-coordination: rudder to null the sideslip, with aileron feed-forward against adverse yaw. */
function applyCoordination(controls, data, weight, memory, dt) {
  const tuning = FIXED_WING.COORDINATION;
  const sideslipRate = Number.isFinite(memory.lastSideslip) ? (data.sideslip - memory.lastSideslip) / dt : 0;
  memory.lastSideslip = data.sideslip;
  const command = clamp(tuning.SIDESLIP_GAIN * data.sideslip + tuning.SIDESLIP_RATE_GAIN * clamp(sideslipRate, -2, 2) + tuning.AILERON_FEED * controls.roll, -tuning.LIMIT, tuning.LIMIT);
  // The pilot's own rudder takes over as it is pushed.
  const share = weight * (1 - Math.min(1, Math.abs(controls.yaw)));
  controls.yaw = clamp(controls.yaw + share * command, -1, 1);
}

/**
 * A ceiling (upper) or floor (lower) on the elevator for one limit: inside `band` of the limit it may
 * only move toward the limit at `gain` x the margin per second, and comes back past it at `overshoot`.
 */
function limitStep(memory, margin, band, gain, overshoot, dt, upper) {
  if (margin >= band) return upper ? Infinity : -Infinity;
  const allowed = (gain * margin + overshoot * Math.min(margin, 0)) * dt;
  return upper ? memory.lastPitch + allowed : memory.lastPitch - allowed;
}

/**
 * Limiters on the final elevator: AoA, G, and for the direct law's share (1 - fbw) the pitch attitude
 * protection and, hands off (directHandsOff: the auto-trim weight while its hold flies), the comfort
 * ceiling; each weighted. Returns the elevator change they made (for the anti-windup).
 */
function applyLimiters(controls, data, weights, memory, dt, fbw, directHandsOff) {
  const tuning = FIXED_WING.LIMITER;
  const rawRate = Number.isFinite(memory.lastAoa) ? (data.aoa - memory.lastAoa) / dt : 0;
  memory.lastAoa = data.aoa;
  memory.aoaRate += (clamp(rawRate, -3, 3) - memory.aoaRate) * (1 - Math.exp(-tuning.RATE_SMOOTHING * dt));
  const predicted = data.aoa + tuning.AOA_LEAD * memory.aoaRate;
  const desired = controls.pitch;
  let ceiling = Infinity;
  let floor = -Infinity;
  const weigh = (limit, weight, upper) => {
    if (!(weight > 0) || !Number.isFinite(limit)) return;
    if (upper && limit < desired) ceiling = Math.min(ceiling, desired + weight * (limit - desired));
    if (!upper && limit > desired) floor = Math.max(floor, desired + weight * (limit - desired));
  };
  if (weights.aoaLimiter > 0) {
    // The worst wing panel counts too: in a skid or a roll one wing reaches its stall first.
    const aoaLimit = data.aoaCritical - tuning.AOA_MARGIN;
    const panelMargin = Number.isFinite(data.panelMargin) ? data.panelMargin - tuning.AOA_MARGIN - tuning.AOA_LEAD * memory.aoaRate : Infinity;
    const margin = Math.min(aoaLimit - predicted, panelMargin);
    weigh(limitStep(memory, margin, tuning.AOA_BAND, tuning.AOA_GAIN, tuning.AOA_OVERSHOOT_GAIN, dt, true), weights.aoaLimiter, true);
    weigh(limitStep(memory, predicted - tuning.NEGATIVE_AOA, tuning.AOA_BAND, tuning.AOA_GAIN, tuning.AOA_OVERSHOOT_GAIN, dt, false), weights.aoaLimiter, false);
  }
  if (weights.gLimiter > 0) {
    weigh(limitStep(memory, tuning.G_SHARE * data.gLimit - data.gLoad, tuning.G_BAND, tuning.G_GAIN, tuning.G_OVERSHOOT_GAIN, dt, true), weights.gLimiter, true);
    weigh(limitStep(memory, data.gLoad + tuning.NEGATIVE_G_SHARE * data.gLimit, tuning.G_BAND, tuning.G_GAIN, tuning.G_OVERSHOOT_GAIN, dt, false), weights.gLimiter, false);
  }
  // The load law bounds its own command (protectLoad); these elevator limits carry the direct law's share.
  const directPitchProtection = weights.pitchProtection * (1 - fbw);
  if (directPitchProtection > 0) {
    const limits = FIXED_WING.PITCH_PROTECTION;
    const predictedPitch = data.pitch + tuning.PITCH_LEAD * memory.attitudeRate;
    weigh(limitStep(memory, limits.PITCH_UP_LIMIT - predictedPitch, tuning.PITCH_BAND, tuning.PITCH_GAIN, tuning.PITCH_OVERSHOOT_GAIN, dt, true), directPitchProtection, true);
    weigh(limitStep(memory, predictedPitch - limits.PITCH_DOWN_LIMIT, tuning.PITCH_BAND, tuning.PITCH_GAIN, tuning.PITCH_OVERSHOOT_GAIN, dt, false), directPitchProtection, false);
  }
  const comfort = directHandsOff * (1 - fbw);
  if (comfort > 0) {
    weigh(limitStep(memory, FIXED_WING.HANDS_OFF_MAX_LOAD - data.gLoad, tuning.COMFORT_BAND, tuning.COMFORT_GAIN, tuning.COMFORT_OVERSHOOT_GAIN, dt, true), comfort, true);
  }
  const limited = clamp(desired, Math.min(floor, ceiling), ceiling);
  controls.pitch = clamp(limited, -1, 1);
  return controls.pitch - desired;
}

const fixedWingHandler = Object.freeze({
  createMemory: createFixedWingMemory,
  prime: primeFixedWingMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    updateRates(data, memory, dt);
    if (data.onGround || data.airspeed < FIXED_WING.MIN_AIRSPEED) {
      // On the ground the trim creeps back to neutral and the rudder is the pilot's (it steers).
      memory.trimBase -= memory.trimBase * Math.min(1, dt / FIXED_WING.AUTO_TRIM.GROUND_DECAY_SECONDS);
      memory.holding = false;
      memory.pathHolding = false;
      memory.airborneSeconds = 0;
      memory.lastSideslip = NaN;
      memory.lastAoa = NaN;
      if (weights.autoTrim > 0 && !autopilotFlying) controls.pitch = clamp(controls.pitch + memory.trimBase, -1, 1);
      memory.lastPitch = controls.pitch;
      return;
    }
    memory.airborneSeconds += dt;
    const fbw = (weights.pathHold ?? 0) * smoothstep(0, FIXED_WING.LOAD_LAW.FBW_FADE_SECONDS, memory.airborneSeconds);
    let handsOff = 0;
    let pitchAssisted = false;
    if (!autopilotFlying) {
      if (weights.autoTrim > 0 || fbw > 0) {
        const idle = applyPitchAssist(controls, data, weights.autoTrim, fbw, weights.pitchProtection ?? 0, memory, dt);
        pitchAssisted = true;
        if (idle && memory.pitchIdleSeconds >= FIXED_WING.AUTO_TRIM.IDLE_DELAY) handsOff = weights.autoTrim;
      }
      if (weights.autoLevel > 0) applyAutoLevel(controls, data, weights.autoLevel, memory, dt);
      if (weights.coordination > 0) applyCoordination(controls, data, weights.coordination, memory, dt);
    } else {
      // The autopilot flies pitch itself; keep the trim where it is so hand-back is smooth.
      memory.pitchIdleSeconds = 0;
      memory.holding = false;
      memory.pathHolding = false;
      memory.trimBase = clamp(controls.pitch, -FIXED_WING.AUTO_TRIM.MAX_OFFSET, FIXED_WING.AUTO_TRIM.MAX_OFFSET);
    }
    if (weights.bankProtection > 0) applyBankProtection(controls, data, weights.bankProtection);
    if (weights.overspeedProtection > 0) applyOverspeedProtection(controls, data, weights.overspeedProtection, memory);
    const limiting = weights.aoaLimiter > 0 || weights.gLimiter > 0 || weights.pitchProtection > 0 || handsOff > 0;
    if (limiting) {
      const change = applyLimiters(controls, data, weights, memory, dt, pitchAssisted ? fbw : 0, handsOff);
      if (pitchAssisted && change !== 0) {
        // Anti-windup: the integrator follows a limited elevator (all of it hands off, the load law's
        // share with the stick held), and a hold that a ceiling stops lowers its angle of attack
        // instead of pulling harder.
        memory.trimBase += (handsOff > 0 ? 1 : fbw) * change;
        if (handsOff > 0 && change < 0 && memory.holding) memory.holdAoa = Math.min(memory.holdAoa, data.aoa);
      }
    } else {
      memory.lastAoa = data.aoa;
      memory.aoaRate = 0;
    }
    memory.lastPitch = controls.pitch;
  },
});

registerAssistHandler('fixedWing', fixedWingHandler);

/**
 * The assists control stage. Per model it keeps the handler's memory (re-created when the model is
 * reset, primed from a pending trim), lists the active assists into context.activeAssists and applies
 * the handler.
 */
export function createAssistStage() {
  const memories = new WeakMap();
  const weights = {};
  return {
    id: 'assists',
    order: ASSIST_STAGE_ORDER,
    apply(controls, context) {
      const model = context.model;
      if (!model) return;
      const level = clamp(Number.isFinite(context.assists) ? context.assists : 1, 0, 1);
      const catalog = catalogs.get(model.kind) ?? [];
      for (const key of Object.keys(weights)) weights[key] = 0;
      for (const entry of catalog) {
        const weight = entryWeight(entry, level);
        weights[entry.key] = weight;
        if (weight > 0) context.activeAssists.push(entry.name);
      }
      const handler = handlers.get(model.kind);
      if (!handler || !(context.dt > 0)) return;
      let memory = memories.get(model);
      const resetCount = Number.isFinite(model.resetCount) ? model.resetCount : 0;
      if (!memory || memory.resetCount !== resetCount) {
        memory = handler.createMemory();
        memory.resetCount = resetCount;
        memories.set(model, memory);
      }
      const prime = pendingPrimes.get(model);
      if (prime) {
        pendingPrimes.delete(model);
        if (typeof handler.prime === 'function') handler.prime(memory, prime);
      }
      handler.apply(controls, context, weights, memory);
    },
  };
}
