// Spaceplane flight control system: the assists of the 'spaceplane' model kind (SimFixedWing flying the
// spaceplane's airframe with its extension, spaceplaneAero.js), registered through the assists' public
// API, the fixed-wing autopilot reused for the kind, and a trim that leaves ballistic states alone.
//
// Every loop works in body rates and turns a wanted rate into stick through the craft's control power,
// which is the RCS jets' (rcsBlend x jet torque / inertia) plus the surfaces' (dynamic pressure x the
// profile's aerodynamic power): the same law flies the craft in vacuum on the jets and in the air on
// the elevons and rudder, with nothing to retune across the 100 000 : 1 range of dynamic pressure.
//
//   0 -> 50 %    rate damping (hands off, the jets and surfaces null the body rates) and
//                auto-coordination in the air (the rudder nulls the sideslip)
//   50 -> 100 %  rate command (the stick commands body rates; hands off, the attitude is held: the
//                whole attitude on the jets, the flight path and bank once the air carries the craft),
//                the AoA and G limiters in the air, and auto re-entry arming itself on a descent from
//                space
//   0 %          raw physics: the stick drives the jets and the surfaces directly
// At any level the pilot's own switches act: attitude hold (craftAbilityAlt; hands off holds the
// attitude) and auto re-entry (craftAbility; arms the entry guidance).
//
// Auto re-entry (craftState.reentryPhase): 'armed' waits for the descent; 'entry' holds 40 degrees
// angle of attack (the pitch stick trims it by up to +-10 degrees), the wings at the bank the pilot
// sets (level by default) and zero sideslip, belly first into the air, until the craft is below 25 km
// (or below Mach 3 in dense air); 'glide' eases the angle of attack down to the hypersonic glide's and
// hands the craft back below Mach 1.5 or 20 km (the hold then keeps its flight path). The phase machine runs here,
// every physics tick; the craft's ability update announces the phases.
import * as THREE from 'three/webgpu';
import { DEG, clamp } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, smoothstep } from './aero.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { autopilotHandlerFor, registerAutopilotHandler } from './autopilot.js';
import { registerTrimHandler, trimHandlerFor } from './trim.js';

export const SPACEPLANE_MODEL_KIND = 'spaceplane';

/** Re-entry guidance phases (craftState.reentryPhase). */
export const REENTRY_PHASES = Object.freeze(['off', 'armed', 'entry', 'glide']);

const IDLE = 0.05;
const AXES = 3;
const PITCH = 0;
const YAW = 1;
const ROLL = 2;

registerAssistCatalog(SPACEPLANE_MODEL_KIND, [
  { key: 'rateDamping', name: 'rate damping', from: 0, full: 0.5 },
  { key: 'coordination', name: 'auto-coordination', from: 0, full: 0.5 },
  { key: 'rateCommand', name: 'rate command and attitude hold', from: 0.5, full: 1 },
  { key: 'limiters', name: 'AoA and G limiters', from: 0.5, full: 1 },
  { key: 'autoReentry', name: 'auto re-entry arming', from: 0.5, full: 1 },
]);

function createMemory() {
  return {
    resetCount: -1,
    /** The held attitude (world), the flight path and bank once the air carries the craft. */
    holdQuaternion: new THREE.Quaternion(),
    holding: false,
    idleSeconds: 0,
    pathHold: 0,
    bankHold: 0,
    /** The pilot's bank target during the entry guidance (rad). */
    entryBank: 0,
    /** Seconds into the glide phase (the angle of attack eases down over the glide ramp). */
    glideSeconds: 0,
    /** Highest altitude of this arc and whether auto re-entry armed itself on it. */
    arcPeak: 0,
    autoArmed: false,
    primed: null,
    power: new Float64Array(AXES),
    rates: new Float64Array(AXES),
    sticks: new Float64Array(AXES),
    wanted: new Float64Array(AXES),
    /** The rate loops' integrators (stick units): the elevator a steady pull or an entry attitude needs. */
    integral: new Float64Array(AXES),
    error: new THREE.Vector3(),
    inverse: new THREE.Quaternion(),
    delta: new THREE.Quaternion(),
  };
}

/** Starts from a trimmed state (trim.js): the hold captures the trimmed attitude on the next tick. */
function primeMemory(memory, trim) {
  memory.primed = trim;
}

/**
 * How much the air carries the craft (0 ballistic .. 1 flying): the lift the wing could make at the
 * dynamic pressure against the weight. The hold flies the flight path once it is flying, the whole
 * attitude while ballistic; the coordination and the limiters need the air too.
 */
function airborneShare(data, model, tuning) {
  const q = Number.isFinite(data.dynamicPressure) ? data.dynamicPressure : 0;
  const capacity = (q * data.wingArea * tuning.liftCapacity) / (data.mass * GRAVITY);
  return smoothstep(0.25, 0.75, capacity);
}

/** Control power (rad/s^2 per unit stick) per axis: the RCS share plus the surfaces' with the air. */
function controlPower(data, tuning, out) {
  const blend = Number.isFinite(data.rcsBlend) ? data.rcsBlend : 1;
  const q = Math.max(Number.isFinite(data.dynamicPressure) ? data.dynamicPressure : 0, 0);
  const rcs = data.rcsPower;
  for (let axis = 0; axis < AXES; axis++) {
    out[axis] = Math.max(blend * rcs[axis] + q * tuning.aeroPower[axis], tuning.minPower);
  }
  return out;
}

/** Pure rate damping on one axis (rates in the stick's sense), through its control power. */
function stickFor(wanted, rate, power, tuning) {
  return clamp((tuning.rateGain * (wanted - rate)) / power, -1, 1);
}

/**
 * The rate loop of one axis: proportional through the control power plus an integrator, so a steady
 * pull (the airframe's own stiffness) or the entry attitude gets the stick it needs. Anti-windup: the
 * integrator stops while the stick is saturated the same way.
 */
function commandAxis(memory, axis, wanted, rate, power, tuning, dt) {
  const error = (wanted - rate) / power;
  const output = memory.integral[axis] + tuning.rateGain * error;
  if (!((output >= 1 && error > 0) || (output <= -1 && error < 0))) memory.integral[axis] = clamp(memory.integral[axis] + tuning.rateIntegral * error * dt, -1, 1);
  return clamp(memory.integral[axis] + tuning.rateGain * error, -1, 1);
}

/** An axis flown open loop lets its integrator go (no jump when the loop closes again). */
function bleedIntegral(memory, axis, dt) {
  memory.integral[axis] -= memory.integral[axis] * Math.min(1, dt / 0.5);
}

/**
 * The body-frame rotation (rad, x pitch up, y nose left, z right wing up) from the current attitude to
 * the held one, into memory.error.
 */
function attitudeError(model, memory) {
  memory.inverse.copy(model.state.quaternion).invert();
  memory.delta.copy(memory.inverse).multiply(memory.holdQuaternion);
  if (memory.delta.w < 0) memory.delta.set(-memory.delta.x, -memory.delta.y, -memory.delta.z, -memory.delta.w);
  const sine = Math.sqrt(Math.max(0, 1 - memory.delta.w * memory.delta.w));
  const angle = 2 * Math.atan2(sine, memory.delta.w);
  if (sine < 1e-9) return memory.error.set(0, 0, 0);
  return memory.error.set(memory.delta.x, memory.delta.y, memory.delta.z).multiplyScalar(angle / sine);
}

function captureHold(model, data, memory, tuning) {
  memory.holdQuaternion.copy(model.state.quaternion);
  memory.pathHold = data.flightPath;
  memory.bankHold = Math.abs(data.bank) < tuning.levelBank * DEG ? 0 : data.bank;
  memory.holding = true;
}

/**
 * The arc and the re-entry phases: auto re-entry arms itself past an apogee above space (with the
 * assist), the guidance starts on the descent, eases into the glide and hands back below the hand-back Mach or altitude.
 */
function updateReentry(data, model, craftState, weights, memory, dt, tuning) {
  const altitude = model.state.position.y;
  const climbing = data.verticalSpeed > 0;
  const guidance = tuning.reentry;
  memory.arcPeak = climbing && altitude < guidance.rearmBelow ? altitude : Math.max(memory.arcPeak, altitude);
  if (climbing && altitude < guidance.rearmBelow) memory.autoArmed = false;
  if (weights.autoReentry > 0 && !memory.autoArmed && !climbing && memory.arcPeak > guidance.autoArmAbove && altitude > guidance.glideAltitude) {
    memory.autoArmed = true;
    craftState.autoReentry = true;
  }
  const armed = craftState.autoReentry === true;
  let phase = REENTRY_PHASES.includes(craftState.reentryPhase) ? craftState.reentryPhase : 'off';
  if (!armed) phase = 'off';
  else if (phase === 'off') phase = 'armed';
  if (phase === 'armed' && !climbing && altitude > guidance.glideAltitude && data.verticalSpeed < -guidance.descentRate) {
    phase = 'entry';
    memory.entryBank = 0;
  }
  if (phase === 'entry' && (altitude < guidance.glideAltitude || (data.mach < guidance.glideMach && data.dynamicPressure > guidance.glidePressure))) {
    phase = 'glide';
    memory.glideSeconds = 0;
  }
  if (phase === 'glide') {
    memory.glideSeconds += dt;
    if (data.mach < guidance.handBackMach || altitude < guidance.handBackAltitude || data.onGround) {
      phase = 'off';
      craftState.autoReentry = false;
      // The hold takes the craft from here (the attitude hold or the rate command's flight path).
      memory.holding = false;
      memory.idleSeconds = 0;
    }
  }
  craftState.reentryPhase = phase;
  return phase;
}

registerAssistHandler(SPACEPLANE_MODEL_KIND, Object.freeze({
  createMemory,
  prime: primeMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const tuning = model.profile.space.fcs;
    const dt = context.dt;
    const craftState = context.env && context.env.craftState ? context.env.craftState : {};
    const phase = updateReentry(data, model, craftState, weights, memory, dt, tuning);
    if (data.onGround) {
      memory.holding = false;
      memory.idleSeconds = 0;
      return;
    }

    const power = controlPower(data, tuning, memory.power);
    const rates = memory.rates;
    rates[PITCH] = data.pitchRate;
    rates[YAW] = data.yawRate;
    rates[ROLL] = data.rollRate;
    const sticks = memory.sticks;
    sticks[PITCH] = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    sticks[YAW] = clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1);
    sticks[ROLL] = clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1);
    const wanted = memory.wanted;
    const inAir = airborneShare(data, model, tuning);
    const maxRate = tuning.maxRate;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);

    if (memory.primed) {
      captureHold(model, data, memory, tuning);
      memory.idleSeconds = tuning.captureDelay;
      memory.primed = null;
    }

    // ---- Entry guidance: angle of attack, bank and sideslip ---------------------------------------
    if (phase === 'entry' || phase === 'glide') {
      const guidance = tuning.reentry;
      const ramp = phase === 'glide' ? smoothstep(0, guidance.glideRampSeconds, memory.glideSeconds) : 0;
      const aoaTarget = (guidance.entryAoa + (guidance.glideAoa - guidance.entryAoa) * ramp) * DEG + sticks[PITCH] * guidance.aoaTrim * DEG;
      memory.entryBank = clamp(memory.entryBank + sticks[ROLL] * maxRate[ROLL] * DEG * dt, -guidance.maxBank * DEG, guidance.maxBank * DEG);
      wanted[PITCH] = clamp(tuning.aoaGain * (aoaTarget - data.aoa), -maxRate[PITCH] * DEG, maxRate[PITCH] * DEG);
      wanted[ROLL] = clamp(tuning.bankGain * (memory.entryBank - data.bank), -maxRate[ROLL] * DEG, maxRate[ROLL] * DEG);
      wanted[YAW] = clamp(tuning.sideslipGain * data.sideslip + sticks[YAW] * maxRate[YAW] * DEG, -maxRate[YAW] * DEG, maxRate[YAW] * DEG);
      for (let axis = 0; axis < AXES; axis++) memory.sticks[axis] = commandAxis(memory, axis, wanted[axis], rates[axis], power[axis], tuning, dt);
      controls.pitch = memory.sticks[PITCH];
      controls.roll = memory.sticks[ROLL];
      controls.yaw = memory.sticks[YAW];
      context.activeAssists.push('auto re-entry');
      memory.holding = false;
      memory.idleSeconds = 0;
      return;
    }

    const idle = Math.abs(sticks[PITCH]) < IDLE && Math.abs(sticks[YAW]) < IDLE && Math.abs(sticks[ROLL]) < IDLE;
    const holdWeight = autopilotFlying ? 0 : Math.max(craftState.attitudeHold === true ? 1 : 0, weights.rateCommand);
    const commandWeight = autopilotFlying ? 0 : weights.rateCommand;

    // ---- Hands off: rates nulled, then the attitude held ------------------------------------------
    if (idle && holdWeight > 0) {
      memory.idleSeconds += dt;
      const calm = Math.abs(rates[PITCH]) < tuning.captureRate * DEG && Math.abs(rates[YAW]) < tuning.captureRate * DEG && Math.abs(rates[ROLL]) < tuning.captureRate * DEG;
      if (!memory.holding && memory.idleSeconds >= tuning.captureDelay && (calm || memory.idleSeconds >= tuning.captureTimeout)) captureHold(model, data, memory, tuning);
      if (!memory.holding) {
        wanted[PITCH] = 0;
        wanted[YAW] = 0;
        wanted[ROLL] = 0;
      } else if (craftState.attitudeHold === true || inAir < 0.5) {
        // The whole attitude, on the jets (or wherever the pilot asked for it).
        const error = attitudeError(model, memory);
        wanted[PITCH] = clamp(tuning.attitudeGain * error.x, -maxRate[PITCH] * DEG, maxRate[PITCH] * DEG);
        wanted[YAW] = clamp(-tuning.attitudeGain * error.y, -maxRate[YAW] * DEG, maxRate[YAW] * DEG);
        wanted[ROLL] = clamp(-tuning.attitudeGain * error.z, -maxRate[ROLL] * DEG, maxRate[ROLL] * DEG);
      } else {
        // In the air: the flight path and the bank, the rudder coordinating.
        wanted[PITCH] = clamp(tuning.pathGain * (memory.pathHold - data.flightPath) * Math.cos(data.bank), -maxRate[PITCH] * DEG, maxRate[PITCH] * DEG);
        wanted[ROLL] = clamp(tuning.bankGain * (memory.bankHold - data.bank), -maxRate[ROLL] * DEG, maxRate[ROLL] * DEG);
        wanted[YAW] = clamp(tuning.sideslipGain * data.sideslip, -maxRate[YAW] * DEG, maxRate[YAW] * DEG);
      }
      limitPitch(data, weights, inAir, tuning, wanted);
      for (let axis = 0; axis < AXES; axis++) {
        const hold = commandAxis(memory, axis, wanted[axis], rates[axis], power[axis], tuning, dt);
        const damped = weights.rateDamping > 0 ? weights.rateDamping * stickFor(0, rates[axis], power[axis], tuning) : 0;
        sticks[axis] = damped + holdWeight * (hold - damped);
      }
      writeSticks(controls, sticks);
      if (craftState.attitudeHold === true && memory.holding) context.activeAssists.push('attitude hold');
      return;
    }
    memory.idleSeconds = 0;
    memory.holding = false;

    // ---- Stick in hand: rate command (blended with the direct stick) -------------------------------
    if (commandWeight > 0) {
      wanted[PITCH] = sticks[PITCH] * maxRate[PITCH] * DEG;
      wanted[ROLL] = sticks[ROLL] * maxRate[ROLL] * DEG;
      wanted[YAW] = sticks[YAW] * maxRate[YAW] * DEG + (Math.abs(sticks[YAW]) < IDLE ? tuning.sideslipGain * data.sideslip * inAir * weights.coordination : 0);
      limitPitch(data, weights, inAir, tuning, wanted);
      for (let axis = 0; axis < AXES; axis++) {
        const commanded = commandAxis(memory, axis, wanted[axis], rates[axis], power[axis], tuning, dt);
        sticks[axis] += commandWeight * (commanded - sticks[axis]);
      }
    }
    // ---- Below the rate command: dampers on the idle axes, the rudder coordinating -----------------
    const directShare = 1 - commandWeight;
    if (commandWeight === 0) for (let axis = 0; axis < AXES; axis++) bleedIntegral(memory, axis, dt);
    if (directShare > 0) {
      for (let axis = 0; axis < AXES; axis++) {
        if (Math.abs(sticks[axis]) >= IDLE || !(weights.rateDamping > 0)) continue;
        sticks[axis] += directShare * weights.rateDamping * stickFor(0, rates[axis], power[axis], tuning);
      }
      if (weights.coordination > 0 && inAir > 0 && Math.abs(controls.yaw) < IDLE) {
        const coordinated = stickFor(tuning.sideslipGain * data.sideslip, rates[YAW], power[YAW], tuning);
        sticks[YAW] += directShare * weights.coordination * inAir * (coordinated - sticks[YAW]);
      }
    }
    writeSticks(controls, sticks);
  },
}));

/**
 * The AoA and G limiters on a wanted pitch rate, once the air carries the craft (their share grows
 * with it): the rate that would pull past the G limit or the critical angle of attack is not asked for.
 */
function limitPitch(data, weights, inAir, tuning, wanted) {
  const share = weights.limiters * inAir;
  if (!(share > 0) || !(data.airspeed > tuning.minAirspeed)) return;
  const gLimit = Number.isFinite(data.gLimit) ? data.gLimit : 4;
  const gravityShare = Math.cos(data.flightPath) * Math.cos(data.bank);
  const byLoad = ((gLimit - gravityShare) * GRAVITY) / data.airspeed;
  const byAoa = tuning.aoaGain * (data.aoaCritical - tuning.aoaMargin * DEG - data.aoa);
  const ceiling = Math.min(byLoad, byAoa);
  if (wanted[PITCH] > ceiling) wanted[PITCH] += share * (ceiling - wanted[PITCH]);
}

function writeSticks(controls, sticks) {
  controls.pitch = clamp(sticks[PITCH], -1, 1);
  controls.yaw = clamp(sticks[YAW], -1, 1);
  controls.roll = clamp(sticks[ROLL], -1, 1);
}

// The spaceplane flies the fixed-wing autopilot (heading, altitude and speed hold, waypoints, rings,
// terrain) in the air; its stick output goes through the dampers here.
const fixedWingAutopilot = autopilotHandlerFor('fixedWing');
if (fixedWingAutopilot) registerAutopilotHandler(SPACEPLANE_MODEL_KIND, fixedWingAutopilot);

// The spaceplane's trim is the fixed-wing trim (the same airframe model) where the air can carry it:
// below the profile's trim pressure the craft is ballistic, so a reset keeps its attitude and speed
// (no attitude solve, no speed blend toward a "safe" speed that would mean kilometres per second up
// there). The speed range after a conversion is bounded by the equivalent-airspeed Vne at the altitude.
const fixedWingTrim = trimHandlerFor('fixedWing');
if (fixedWingTrim) {
  registerTrimHandler(SPACEPLANE_MODEL_KIND, Object.freeze({
    trim(model, request = {}) {
      const rho = request.env && Number.isFinite(request.env.rho) ? request.env.rho : SEA_LEVEL_DENSITY;
      const wind = request.env && request.env.wind && request.env.wind.vel ? request.env.wind.vel : null;
      const velocity = model.state.velocity;
      const airX = velocity.x - (wind ? wind.x : 0);
      const airY = velocity.y - (wind ? wind.y : 0);
      const airZ = velocity.z - (wind ? wind.z : 0);
      const dynamicPressure = 0.5 * rho * (airX * airX + airY * airY + airZ * airZ);
      if (dynamicPressure < model.profile.space.fcs.trimPressure) return null;
      const result = fixedWingTrim.trim(model, request);
      if (!result) return null;
      const data = model.flightData;
      const limit = data.vne > 0 ? data.vne * Math.sqrt(SEA_LEVEL_DENSITY / Math.max(rho, 1e-6)) : Infinity;
      if (!Number.isFinite(limit)) return result;
      result.vne = limit;
      result.safeSpeed = { min: result.safeSpeed.min, max: Math.max(limit * 0.9, result.safeSpeed.min) };
      return result;
    },
  }));
}
