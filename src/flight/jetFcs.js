// Jet flight control system: the assists of the 'jet' model kind (SimFixedWing flying the jet's
// airframe), registered through the assists' public API as their catalog and handler, and the
// fixed-wing autopilot reused for the jet. It runs as part of the assists control stage every physics
// tick, after the autopilot, so it shapes the pilot's (or the autopilot's) stick like a fighter's
// flight control computer:
//   0 -> 50 %    auto-coordination (rudder nulls the sideslip), yaw damper, a roll damper at high
//                angle of attack (suppresses wing rock), auto-trim (hands off, the flight path holds)
//   50 -> 100 %  fly-by-wire G command (the stick commands a load factor: full aft = 9 g, neutral =
//                1 g, full forward = the negative limit) with its AoA limiter and G limiter built in,
//                auto-level when hands off
//   0 %          raw physics: direct stabilators, no dampers (wing rock near the critical AoA)
// Each part has a weight that ramps with the assist level; the fly-by-wire blends from the direct
// stick at 50 % to the full G command at 100 %.
import { DEG, clamp } from '../core/util.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { autopilotHandlerFor, registerAutopilotHandler } from './autopilot.js';

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
  };
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
 * hands off, a PI loop holds the flight path captured at release. Returns the trimmed stick.
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
    const error = memory.pathHold - data.flightPath;
    memory.trim += weight * scale * (tuning.trimHoldIntegral * error - tuning.trimHoldDamping * data.pitchRate) * dt;
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
  let command = stick >= 0 ? 1 + stick * (gLimit - 1) : 1 + stick * (1 - negativeLimit);
  // G limiter: past the limit the command itself never goes (it blends in with its weight).
  const gCap = gLimit + (1 - weights.gLimiter) * gLimit;
  command = clamp(command, negativeLimit * (1 + (1 - weights.gLimiter)), gCap);
  // AoA limiter: the load available at the AoA limit, from the lift slope through zero lift.
  if (weights.aoaLimiter > 0) {
    const predicted = data.aoa + tuning.aoaLead * memory.aoaRate;
    const limit = data.aoaCritical - tuning.aoaMargin * DEG;
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
  const output = memory.integral + feedForward + proportional;
  const saturated = (output >= 1 && error > 0) || (output <= -1 && error < 0);
  if (!saturated) memory.integral = clamp(memory.integral + tuning.integral * scale * error * dt, -1, 1);
  return clamp(memory.integral + feedForward + proportional - tuning.rateDamping * scale * data.pitchRate, -1, 1);
}

registerAssistHandler(JET_MODEL_KIND, Object.freeze({
  createMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const tuning = model.profile.jet.fcs;
    const dt = context.dt;
    const rawRate = Number.isFinite(memory.lastAoa) ? (data.aoa - memory.lastAoa) / dt : 0;
    memory.lastAoa = data.aoa;
    memory.aoaRate += (clamp(rawRate, -3, 3) - memory.aoaRate) * (1 - Math.exp(-tuning.aoaRateSmoothing * dt));
    if (data.onGround || data.airspeed < tuning.minAirspeed) {
      // On the ground the stick is direct and the rudder steers; the loops stand by at the stick.
      memory.trim -= memory.trim * Math.min(1, dt / tuning.trimGroundDecaySeconds);
      memory.integral = clamp(controls.pitch, -1, 1);
      memory.lastSideslip = NaN;
      memory.holdingPath = false;
      return;
    }
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (weights.autoLevel > 0 && !autopilotFlying) autoLevel(controls, data, weights.autoLevel, memory, dt, tuning);
    if (weights.coordination > 0 && !autopilotFlying) coordinate(controls, data, weights.coordination, memory, dt, tuning);
    if (weights.dampers > 0) damp(controls, data, weights.dampers, tuning);

    const stick = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    const fbw = weights.flyByWire;
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
