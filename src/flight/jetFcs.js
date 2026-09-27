// Jet flight control system: the assists of the 'jet' model kind (SimFixedWing flying the jet's
// airframe), registered through the assists' public API as their catalog and handler, the fixed-wing
// autopilot reused for the jet, and the jet's trim (trim.js) for resets and conversions. It runs as
// part of the assists control stage every physics tick, after the autopilot, so it shapes the pilot's
// (or the autopilot's) stick like a fighter's flight control computer:
//   0 -> 50 %    auto-coordination (rudder nulls the sideslip), yaw damper, a roll damper at high
//                angle of attack (suppresses wing rock), auto-trim (hands off, the flight path holds)
//   50 -> 100 %  fly-by-wire G command (the stick commands a load factor: neutral holds the 1 g load
//                along the flight path, bank-corrected like the fixed-wing load law, full aft = 9 g,
//                full forward = the negative limit) with its AoA limiter and G limiter built in,
//                auto-level when hands off, and overspeed protection (near Vne or the Mach limit the
//                speed brakes open and the power comes back, afterburner first)
//   0 %          raw physics: direct stabilators, no dampers (wing rock near the critical AoA)
// A fighter keeps its whole attitude envelope: no bank or pitch attitude protection (the fixed-wing
// catalog's), since loops and rolls are what it is for; the G and AoA limiters are its protections.
// Each part has a weight that ramps with the assist level; the fly-by-wire blends from the direct
// stick at 50 % to the full G command at 100 %.
//
// Power limit: the overspeed protection writes controls.powerLimit (0..1, a cap on the effective
// throttle lever: the afterburner range is the top of it) every tick; the jet engine (jetAero.js)
// applies it without moving the pilot's lever, so the burner is not cancelled and comes back when
// the speed does.
import { DEG, clamp } from '../core/util.js';
import { SEA_LEVEL_DENSITY, smoothstep, speedOfSound } from './aero.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { autopilotHandlerFor, registerAutopilotHandler } from './autopilot.js';
import { neutralLoad, registerTrimHandler, trimHandlerFor } from './trim.js';

export const JET_MODEL_KIND = 'jet';

const IDLE = 0.05;

registerAssistCatalog(JET_MODEL_KIND, [
  { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
  { key: 'dampers', name: 'yaw and roll dampers', from: 0, full: 0.5 },
  { key: 'autoTrim', name: 'auto-trim', from: 0, full: 0.5 },
  { key: 'stallWarning', name: 'stall warning', from: 0, full: 0 },
  { key: 'flyByWire', name: 'fly-by-wire G command', from: 0.5, full: 1 },
  { key: 'aoaLimiter', name: 'AoA limiter', from: 0.5, full: 1 },
  { key: 'gLimiter', name: 'G limiter', from: 0.5, full: 1 },
  { key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 },
  { key: 'overspeedProtection', name: 'overspeed protection', from: 0.5, full: 1 },
]);

function createMemory() {
  return {
    resetCount: -1,
    integral: 0,
    trim: 0,
    pitchIdleSeconds: 0,
    rollIdleSeconds: 0,
    holdingPath: false,
    pathHold: 0,
    lastAoa: NaN,
    aoaRate: 0,
    lastSideslip: NaN,
    command: 1,
    steadyRate: 0,
    lastLimitRatio: NaN,
    limitRate: 0,
    /** A trimmed state (primeAssists) to start the loops from on the next airborne tick. */
    primed: null,
  };
}

/** Starts from a trimmed state (trim.js): the loops are seeded on the next tick, when the air data is at hand. */
function primeMemory(memory, trim) {
  memory.primed = trim;
}

/**
 * Seeds the loops from a trimmed state: the stabilator integrator at the trimmed deflection (less the
 * feed-forward the trimmed load adds), the auto-trim at it, the flight path hold captured, the idle
 * timers run out and the rate filters at the current air data, as if the pilot had let go a while ago.
 */
function applyPrime(memory, trim, data, tuning) {
  const elevator = clamp(Number.isFinite(trim.elevator) ? trim.elevator : 0, -1, 1);
  const load = Number.isFinite(trim.load) ? trim.load : 1;
  const scale = clamp(tuning.referencePressure / Math.max(data.dynamicPressure, 500), 0.05, tuning.maxScale);
  memory.integral = clamp(elevator - tuning.feedForward * scale * (load - 1), -1, 1);
  memory.trim = clamp(elevator, -tuning.trimLimit, tuning.trimLimit);
  memory.command = load;
  memory.holdingPath = Number.isFinite(trim.flightPath);
  memory.pathHold = memory.holdingPath ? trim.flightPath : 0;
  memory.pitchIdleSeconds = tuning.trimIdleDelay;
  memory.rollIdleSeconds = tuning.autoLevelDelay;
  memory.steadyRate = data.pitchRate;
  memory.lastAoa = data.aoa;
  memory.aoaRate = 0;
  memory.lastSideslip = NaN;
  memory.lastLimitRatio = NaN;
  memory.limitRate = 0;
}

/**
 * How close the jet is to its speed limit: the larger of equivalent airspeed / Vne and Mach / the
 * Mach limit (1 = at the limit).
 */
function speedLimitRatio(data) {
  const equivalent = Math.sqrt((2 * Math.max(data.dynamicPressure, 0)) / SEA_LEVEL_DENSITY);
  const byEquivalent = data.vne > 0 ? equivalent / data.vne : 0;
  const byMach = data.vneMach > 0 && Number.isFinite(data.mach) ? data.mach / data.vneMach : 0;
  return Math.max(byEquivalent, byMach);
}

/**
 * Overspeed protection: as the speed (predicted from its rate) nears the limit, the speed brakes open
 * (both toe brakes, which is how the model deploys them in the air) and the power limit comes down:
 * the afterburner range first, then the dry power.
 */
function protectOverspeed(controls, data, weight, memory, dt, tuning) {
  const ratio = speedLimitRatio(data);
  const rawRate = Number.isFinite(memory.lastLimitRatio) ? (ratio - memory.lastLimitRatio) / dt : 0;
  memory.lastLimitRatio = ratio;
  memory.limitRate += (clamp(rawRate, -0.5, 0.5) - memory.limitRate) * (1 - Math.exp(-4 * dt));
  const predicted = ratio + tuning.overspeedLead * Math.max(memory.limitRate, 0);
  const share = weight * smoothstep(tuning.overspeedStart, 1, predicted);
  if (!(share > 0)) return;
  controls.brakeL = Math.max(Number.isFinite(controls.brakeL) ? controls.brakeL : 0, share);
  controls.brakeR = Math.max(Number.isFinite(controls.brakeR) ? controls.brakeR : 0, share);
  const detent = clamp(Number.isFinite(controls.afterburnerDetent) ? controls.afterburnerDetent : 0.95, 0.8, 1);
  // Over the first half the burner range closes; over the second half the dry power comes back to idle.
  const burnerClosing = clamp(share * 2, 0, 1);
  const dryClosing = clamp(share * 2 - 1, 0, 1);
  controls.powerLimit = Math.min(1 - (1 - detent) * burnerClosing, detent * (1 - dryClosing));
}

/** Rudder toward zero sideslip, with a little aileron feed-forward; the pilot's rudder takes over. */
function coordinate(controls, data, weight, memory, dt, tuning) {
  const sideslipRate = Number.isFinite(memory.lastSideslip) ? clamp((data.sideslip - memory.lastSideslip) / dt, -2, 2) : 0;
  memory.lastSideslip = data.sideslip;
  const command = clamp(tuning.coordinationGain * data.sideslip + tuning.coordinationRateGain * sideslipRate, -0.6, 0.6);
  const share = weight * (1 - Math.min(1, Math.abs(controls.yaw)));
  controls.yaw = clamp(controls.yaw + share * command, -1, 1);
}

/** Yaw damper, and a roll damper that comes in near the critical angle of attack (wing rock). */
function damp(controls, data, weight, tuning) {
  const highAoa = clamp((data.aoa - tuning.rollDamperFrom * DEG) / ((tuning.rollDamperFull - tuning.rollDamperFrom) * DEG), 0, 1);
  controls.yaw = clamp(controls.yaw - weight * tuning.yawDamper * data.yawRate, -1, 1);
  controls.roll = clamp(controls.roll - weight * highAoa * tuning.rollDamper * data.rollRate, -1, 1);
}

/** Hands off the roll axis, the wings come back level. */
function autoLevel(controls, data, weight, memory, dt, tuning) {
  const idle = Math.abs(controls.roll) < IDLE;
  memory.rollIdleSeconds = idle ? memory.rollIdleSeconds + dt : 0;
  if (!idle || memory.rollIdleSeconds < tuning.autoLevelDelay) return;
  const command = clamp(-tuning.autoLevelBank * data.bank - tuning.autoLevelRate * data.rollRate, -0.5, 0.5);
  controls.roll = clamp(controls.roll + weight * command, -1, 1);
}

/**
 * Auto-trim on the direct (non fly-by-wire) path: while the stick is held the trim creeps toward it;
 * hands off, a PI loop holds the flight path captured at release, inside the hands-off load band.
 * Returns the trimmed stick.
 */
function autoTrim(stick, data, weight, memory, dt, tuning) {
  const idle = Math.abs(stick) < IDLE;
  memory.pitchIdleSeconds = idle ? memory.pitchIdleSeconds + dt : 0;
  const scale = clamp(tuning.referencePressure / Math.max(data.dynamicPressure, 500), 0.05, tuning.maxScale);
  if (!idle) {
    memory.holdingPath = false;
    memory.trim += (weight * stick * dt) / tuning.trimFollowSeconds;
  } else if (memory.pitchIdleSeconds >= tuning.trimIdleDelay) {
    if (!memory.holdingPath) {
      memory.holdingPath = true;
      memory.pathHold = data.flightPath;
    }
    // Hands off the hold never trims past the neutral load band: in a steep bank the path gives way
    // (it is recaptured where the load is back inside) instead of the trim pulling a hard turn.
    const excess = Math.max(0, data.gLoad - tuning.handsOffMaxLoad) + Math.min(0, data.gLoad - tuning.handsOffMinLoad);
    if (excess !== 0) memory.pathHold = data.flightPath;
    const error = memory.pathHold - data.flightPath;
    memory.trim += weight * scale * (tuning.trimHoldIntegral * error - tuning.trimHoldDamping * data.pitchRate - tuning.trimHoldLoad * excess) * dt;
  }
  memory.trim = clamp(memory.trim, -tuning.trimLimit, tuning.trimLimit);
  return clamp(stick + memory.trim, -1, 1);
}

/**
 * The fly-by-wire pitch law: stick -> load-factor command, capped by the G limiter and, with the
 * angle of attack predicted a moment ahead, by the load the wing can make at its AoA limit; a PI loop
 * on the measured load (feed-forward, gains scaled by q_ref / q, pitch-rate damping) moves the
 * stabilators. Returns the stabilator command.
 */
function flyByWire(stick, data, weights, memory, dt, tuning) {
  const gLimit = data.gLimit;
  const negativeLimit = -gLimit * tuning.negativeShare;
  // Neutral stick holds the 1 g load along the flight path (bank-corrected, as the trim solves it),
  // within a band: steep climbs and dives still curve gently back toward the horizon.
  const pathLoad = neutralLoad(Number.isFinite(data.flightPath) ? data.flightPath : 0, Number.isFinite(data.bank) ? data.bank : 0);
  const neutral = clamp(pathLoad, tuning.neutralMinLoad, tuning.neutralMaxLoad);
  let command = stick >= 0 ? neutral + stick * (gLimit - neutral) : neutral + stick * (neutral - negativeLimit);
  // G limiter: past the limit the command itself never goes (it blends in with its weight).
  const gCap = gLimit + (1 - weights.gLimiter) * gLimit;
  command = clamp(command, negativeLimit * (1 + (1 - weights.gLimiter)), gCap);
  // AoA limiter: the load available at the AoA limit, from the lift slope through zero lift, and past
  // the limit a direct push on the stabilators (below, aoaExcess).
  let aoaExcess = 0;
  if (weights.aoaLimiter > 0) {
    const predicted = data.aoa + tuning.aoaLead * memory.aoaRate;
    const limit = data.aoaCritical - tuning.aoaMargin * DEG;
    aoaExcess = weights.aoaLimiter * (Math.max(0, predicted - limit) + Math.min(0, predicted - tuning.negativeAoa * DEG));
    if (predicted > 4 * DEG) {
      const available = Math.max(data.gLoad, 0.2) * (limit / predicted);
      command = Math.min(command, command + weights.aoaLimiter * (available - command));
    }
    const negativeLimitAoa = tuning.negativeAoa * DEG;
    if (predicted < -4 * DEG) {
      const available = Math.min(data.gLoad, -0.2) * (negativeLimitAoa / predicted);
      command = Math.max(command, command + weights.aoaLimiter * (available - command));
    }
  }
  memory.command = command;
  const error = command - data.gLoad;
  const scale = clamp(tuning.referencePressure / Math.max(data.dynamicPressure, 500), 0.05, tuning.maxScale);
  const feedForward = tuning.feedForward * scale * (command - 1);
  const proportional = tuning.gain * scale * error;
  // Pitch-rate damping through a washout: it damps the short period without fighting a steady pull.
  memory.steadyRate += (data.pitchRate - memory.steadyRate) * (1 - Math.exp(-dt / tuning.rateWashoutSeconds));
  const damping = tuning.rateDamping * scale * (data.pitchRate - memory.steadyRate);
  const protection = tuning.aoaFeedback * scale * aoaExcess;
  const output = memory.integral + feedForward + proportional - damping - protection;
  const saturated = (output >= 1 && error > 0) || (output <= -1 && error < 0);
  if (!saturated) memory.integral = clamp(memory.integral + tuning.integral * Math.pow(scale, tuning.integralExponent) * (error - tuning.aoaBleed * aoaExcess) * dt, -1, 1);
  return clamp(memory.integral + feedForward + proportional - damping - protection, -1, 1);
}

registerAssistHandler(JET_MODEL_KIND, Object.freeze({
  createMemory,
  prime: primeMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const tuning = model.profile.jet.fcs;
    const dt = context.dt;
    // The power limit is rewritten every tick (the controls object is reused between ticks).
    controls.powerLimit = 1;
    const rawRate = Number.isFinite(memory.lastAoa) ? (data.aoa - memory.lastAoa) / dt : 0;
    memory.lastAoa = data.aoa;
    memory.aoaRate += (clamp(rawRate, -3, 3) - memory.aoaRate) * (1 - Math.exp(-tuning.aoaRateSmoothing * dt));
    if (data.onGround || data.airspeed < tuning.minAirspeed) {
      // On the ground the stick is direct and the rudder steers; the loops stand by at the stick.
      memory.trim -= memory.trim * Math.min(1, dt / tuning.trimGroundDecaySeconds);
      memory.integral = clamp(controls.pitch, -1, 1);
      memory.lastSideslip = NaN;
      memory.holdingPath = false;
      memory.lastLimitRatio = NaN;
      return;
    }
    if (memory.primed) {
      applyPrime(memory, memory.primed, data, tuning);
      memory.primed = null;
    }
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (weights.autoLevel > 0 && !autopilotFlying) autoLevel(controls, data, weights.autoLevel, memory, dt, tuning);
    if (weights.coordination > 0 && !autopilotFlying) coordinate(controls, data, weights.coordination, memory, dt, tuning);
    if (weights.dampers > 0) damp(controls, data, weights.dampers, tuning);
    if (weights.overspeedProtection > 0) protectOverspeed(controls, data, weights.overspeedProtection, memory, dt, tuning);

    const stick = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    // The autopilot's loops are tuned for direct stabilators (they close their own load loop), so it
    // flies with the direct law and the dampers.
    const fbw = autopilotFlying ? 0 : weights.flyByWire;
    const direct = weights.autoTrim > 0 && !autopilotFlying ? autoTrim(stick, data, weights.autoTrim * (1 - fbw), memory, dt, tuning) : stick;
    if (fbw > 0) {
      const stabilator = flyByWire(stick, data, weights, memory, dt, tuning);
      controls.pitch = direct + fbw * (stabilator - direct);
    } else {
      memory.integral = direct;
      controls.pitch = direct;
    }
  },
}));

// The jet flies the fixed-wing autopilot (heading, altitude and speed hold, waypoints, rings, terrain);
// its stick output goes through the flight control system like the pilot's.
const fixedWingAutopilot = autopilotHandlerFor('fixedWing');
if (fixedWingAutopilot) registerAutopilotHandler(JET_MODEL_KIND, fixedWingAutopilot);

// The jet's trim is the fixed-wing trim (the same airframe model), with the speed range after a
// conversion bounded by the jet's own limit at the altitude: its equivalent-airspeed Vne as a true
// airspeed there, or the Mach limit, whichever comes first.
const fixedWingTrim = trimHandlerFor('fixedWing');
if (fixedWingTrim) {
  registerTrimHandler(JET_MODEL_KIND, Object.freeze({
    trim(model, request = {}) {
      const result = fixedWingTrim.trim(model, request);
      if (!result) return null;
      const data = model.flightData;
      const rho = request.env && Number.isFinite(request.env.rho) ? request.env.rho : SEA_LEVEL_DENSITY;
      const byEquivalent = data.vne > 0 ? data.vne * Math.sqrt(SEA_LEVEL_DENSITY / Math.max(rho, 0.01)) : Infinity;
      const byMach = data.vneMach > 0 ? data.vneMach * speedOfSound(model.state.position.y) : Infinity;
      const limit = Math.min(byEquivalent, byMach);
      if (!Number.isFinite(limit)) return result;
      const share = model.profile.jet.fcs.safeSpeedShare;
      result.vne = limit;
      result.safeSpeed = { min: result.safeSpeed.min, max: Math.max(limit * share, result.safeSpeed.min) };
      return result;
    },
  }));
}
