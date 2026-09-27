// SimWingsuit: the SIM flight model for the wingsuit, with its parachute (canopy mode).
//
// Wingsuit flight is a 6-DOF rigid body in SI units (centre of mass = mesh origin; body axes x right,
// y up (the flyer's back), z aft (the feet)) integrated at the controller's fixed 120 Hz:
//   suit       one low aspect-ratio lifting surface (arm wings, leg wing and body together): a lift
//              curve with a post-stall drop into a flat plate, parasitic plus lift-dependent drag
//              (the speed-vs-glide polar: about 2.7 : 1 near 150 km/h, 2.5 : 1 at 180, 2 : 1 at 220),
//              a side force from sideslip and ground effect within a span of the terrain
//   pitch      body shape sets the trim angle of attack: arching (pull) raises it toward the flare
//              and the stall, de-arching (push) lowers it and dives; the suit's aerodynamic centre
//              behind the centre of mass brings the body back toward that trim (stable, damped)
//   roll/yaw   limb asymmetry rolls the body (authority scales with dynamic pressure), the banked
//              lift turns it and weathervane stability follows the turn; dihedral-like roll
//              stability from the swept-back arm wings
//   stall      past the critical angle of attack the suit's lift breaks, a stall break pitches the
//              body further up while the pilot keeps arching, roll damping turns into autorotation
//              and the dihedral effect reverses: full pull with roll at 0 % assists tumbles the
//              flyer. Relaxing the body restores the pitch stability, the dive builds speed and the
//              suit flies again (always recoverable with altitude)
// Wind (air-relative velocity) and turbulence (small shaking moments) apply throughout.
//
// chuteDeploy (or the craft ability) pulls the pilot chute: the canopy inflates over about 2.8 s with
// an opening shock (drag capped at about 3.8 g), the flyer swings under it and the model becomes a
// point mass under a ram-air canopy: glide about 2 : 1 at about 36 km/h and 5 m/s down, the
// toggles (stick roll, rudder pedals, toe brakes) bank and turn it, pulling the stick flares it
// (the brakes raise the angle of attack: a lift spike that stops the sink while the speed bleeds).
// The feet are gear: touchdowns are graded, and after landing the craft ability relaunches from the
// nearest peak after a short pause.
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (limb and toggle positions for
// the mesh), flightData (read by the wingsuit assists) and dispose(). craftState (shared with the
// craft ability, the mesh, audio and the copilot): canopy, phase ('flight' | 'deploying' | 'canopy' |
// 'landed'), deploy (0..1), brakeLeft / brakeRight (0..1), landedSeconds, openingG, and the
// assists' proximityWarning / impactSeconds / clearance.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, evaluateLift, groundEffectFactor, smoothstep } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler, stallWarningActive } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';

const MAX_ANGULAR_SPEED = 14;
const MAX_SPEED = 120;
const LOAD_SMOOTHING = 20;
/** Limbs move at this rate (full travel per second fraction). */
const LIMB_RATE = 4.5;
/** Flat-plate drag of the suit broadside to the flow (CD at 90 degrees of angle of attack). */
const BROADSIDE_DRAG = 1.2;
/** The stall break acts between the stall and this many radians past it. */
const STALL_BREAK_SPAN = 40 * DEG;
const STALLED_DEPTH = 0.5;
/** Glide-ratio readout smoothing (1/s). */
const GLIDE_SMOOTHING = 1.5;
/** Seconds without canopy tension before the phase counts as landed; slow-slide limits. */
const LANDED_SPEED = 2.5;
const FLIGHT_REST_SPEED = 3;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** What the pilot holds while the canopy deploys: relaxed limbs, toggles stowed. */
const RELAXED_CONTROLS = Object.freeze({ roll: 0, pitch: 0, yaw: 0, brakeL: 0, brakeR: 0 });

/** Smooth deterministic noise in about [-1, 1] (turbulence moments and luffing). */
function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

// ============================================================================================
// ASSISTS (kind 'wingsuit'): registered with the shared assist stage (src/flight/assists.js)
//   100 %  stability, auto-level, stall protection, terrain proximity warning
//    50 %  stability plus the warning
//     0 %  raw
// ============================================================================================
export const WINGSUIT_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'stability', name: 'stability', from: 0, full: 0.5 }),
  Object.freeze({ key: 'proximityWarning', name: 'terrain proximity warning', from: 0, full: 0 }),
  Object.freeze({ key: 'autoLevel', name: 'auto-level', from: 0.5, full: 1 }),
  Object.freeze({ key: 'stallProtection', name: 'stall protection', from: 0.5, full: 1 }),
]);

const ASSIST = Object.freeze({
  IDLE: 0.05,
  /** Stability: rate damping on all three axes and sideslip coordination through the legs. */
  STABILITY: Object.freeze({ ROLL_RATE_GAIN: 0.22, PITCH_RATE_GAIN: 0.3, YAW_RATE_GAIN: 0.25, SIDESLIP_GAIN: 2.2, LIMIT: 0.45 }),
  AUTO_LEVEL: Object.freeze({ DELAY: 0.4, BANK_GAIN: 1.3, RATE_GAIN: 0.35, LIMIT: 0.55 }),
  /** Stall protection keeps the trim this far below the critical angle of attack. */
  STALL: Object.freeze({ MARGIN: 3 * DEG, AOA_GAIN: 6, ROLL_SHARE: 0.5 }),
  /** Proximity warning: the path over the next LOOKAHEAD seconds, re-checked every INTERVAL. */
  PROXIMITY: Object.freeze({ LOOKAHEAD: 6, SAMPLE: 0.5, INTERVAL: 0.1, WARN_SECONDS: 4, MIN_SPEED: 12 }),
});

function createWingsuitAssistMemory() {
  return { resetCount: -1, rollIdleSeconds: 0, proximityTimer: 0 };
}

/** Time until the straight-line path meets the terrain (s, Infinity when clear) and the lowest gap. */
function probePath(position, velocity, env, result) {
  const tuning = ASSIST.PROXIMITY;
  let clearance = Infinity;
  let impactSeconds = Infinity;
  for (let time = tuning.SAMPLE; time <= tuning.LOOKAHEAD + 1e-6; time += tuning.SAMPLE) {
    const x = position.x + velocity.x * time;
    const z = position.z + velocity.z * time;
    const floor = Math.max(env.groundHeight(x, z), env.waterLevel);
    const gap = position.y + velocity.y * time - floor;
    if (gap < clearance) clearance = gap;
    if (gap <= 0 && time < impactSeconds) impactSeconds = time;
  }
  result.clearance = clearance;
  result.impactSeconds = impactSeconds;
  return result;
}

const probeResult = { clearance: Infinity, impactSeconds: Infinity };

const wingsuitAssistHandler = Object.freeze({
  createMemory: createWingsuitAssistMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const env = context.env;
    const craftState = env && env.craftState ? env.craftState : null;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);

    // Terrain proximity warning (every INTERVAL): the path ahead meets the ground within WARN_SECONDS.
    memory.proximityTimer -= dt;
    if (craftState && memory.proximityTimer <= 0 && env && typeof env.groundHeight === 'function') {
      memory.proximityTimer = ASSIST.PROXIMITY.INTERVAL;
      const flying = data.phase === 'flight' && !data.onGround && data.airspeed > ASSIST.PROXIMITY.MIN_SPEED;
      if (flying) {
        probePath(model.state.position, model.state.velocity, env, probeResult);
        craftState.clearance = probeResult.clearance;
        craftState.impactSeconds = probeResult.impactSeconds;
      } else {
        craftState.clearance = Infinity;
        craftState.impactSeconds = Infinity;
      }
      craftState.proximityWarning = flying && weights.proximityWarning > 0 && craftState.impactSeconds <= ASSIST.PROXIMITY.WARN_SECONDS;
    }

    if (data.phase !== 'flight' || data.onGround || data.airspeed < 8) {
      memory.rollIdleSeconds = 0;
      return;
    }
    if (weights.stability > 0) {
      const tuning = ASSIST.STABILITY;
      const weight = weights.stability;
      controls.roll = clamp(controls.roll + weight * clamp(-tuning.ROLL_RATE_GAIN * data.rollRate, -tuning.LIMIT, tuning.LIMIT), -1, 1);
      if (!autopilotFlying) controls.pitch = clamp(controls.pitch + weight * clamp(-tuning.PITCH_RATE_GAIN * data.pitchRate, -tuning.LIMIT, tuning.LIMIT), -1, 1);
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
      // The pull that trims the suit at the limit, less the overshoot already there.
      let ceiling = data.pullRange > 0 ? (limit - data.trimAoa) / data.pullRange : 1;
      if (data.aoa > limit) ceiling -= tuning.AOA_GAIN * (data.aoa - limit);
      ceiling = clamp(ceiling, -1, 1);
      if (controls.pitch > ceiling) controls.pitch += weights.stallProtection * (ceiling - controls.pitch);
      if (data.stallDepth > 0) controls.roll *= 1 - weights.stallProtection * tuning.ROLL_SHARE * data.stallDepth;
    }
  },
});

registerAssistCatalog('wingsuit', WINGSUIT_ASSIST_CATALOG);
registerAssistHandler('wingsuit', wingsuitAssistHandler);

// ============================================================================================
// AUTOPILOT (kind 'wingsuit'): flies through the model like the fixed-wing one. A wingsuit cannot
// hold altitude, so it holds the heading (bank through the arms), a glide speed (body pitch) and turns
// away from terrain its path would meet; under the canopy it steers the heading with the toggles.
// ============================================================================================
const AUTOPILOT = Object.freeze({
  MAX_BANK: 30 * DEG,
  BANK_PER_DEGREE: 1.1 * DEG,
  BANK_GAIN: 1.6,
  ROLL_RATE_GAIN: 0.4,
  ROLL_LIMIT: 0.7,
  SPEED_MIN: 42,
  SPEED_MAX: 60,
  SPEED_P: 0.05,
  SPEED_I: 0.02,
  PITCH_LIMIT: 0.6,
  SIDESLIP_GAIN: 2,
  YAW_LIMIT: 0.5,
  OUTPUT_SLEW: 2.5,
  EVADE_SECONDS: 6,
  EVADE_HEADING: 60,
  EVADE_PULL: 0.35,
  CANOPY_TURN_GAIN: 0.025,
  CANOPY_TURN_LIMIT: 0.6,
});

function wrapSignedDegrees(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** +1 when the terrain to the right (about 600-1200 m out) is lower than to the left, else -1. */
function lowerSideOf(env, position, headingDegrees) {
  let left = -Infinity;
  let right = -Infinity;
  for (const distance of [600, 1200]) {
    for (const side of [-1, 1]) {
      const direction = (headingDegrees + side * AUTOPILOT.EVADE_HEADING) * DEG;
      const height = Math.max(env.groundHeight(position.x + Math.sin(direction) * distance, position.z - Math.cos(direction) * distance), env.waterLevel);
      if (side < 0) left = Math.max(left, height);
      else right = Math.max(right, height);
    }
  }
  return right <= left ? 1 : -1;
}

const wingsuitAutopilot = Object.freeze({
  createMemory() {
    return { resetCount: -1, engaged: false, speedIntegral: 0, roll: 0, pitch: 0, yaw: 0, evadeSide: 0 };
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
    if (data.phase === 'landed' || data.onGround) return false;
    if (!memory.engaged) {
      memory.engaged = true;
      memory.speedIntegral = clamp(controls.pitch, -AUTOPILOT.PITCH_LIMIT, AUTOPILOT.PITCH_LIMIT);
      memory.roll = clamp(controls.roll, -1, 1);
      memory.pitch = memory.speedIntegral;
      memory.yaw = clamp(controls.yaw, -1, 1);
      memory.evadeSide = 0;
    }
    const craftState = env && env.craftState ? env.craftState : {};
    const impactSeconds = Number.isFinite(craftState.impactSeconds) ? craftState.impactSeconds : Infinity;
    const threatened = impactSeconds <= AUTOPILOT.EVADE_SECONDS;
    if (threatened && memory.evadeSide === 0 && env) memory.evadeSide = lowerSideOf(env, model.state.position, data.heading);
    if (!threatened) memory.evadeSide = 0;
    const heading = memory.evadeSide !== 0 ? data.heading + memory.evadeSide * AUTOPILOT.EVADE_HEADING : autopilot.heading;
    const headingError = wrapSignedDegrees(heading - data.heading);
    const slew = AUTOPILOT.OUTPUT_SLEW * dt;

    if (data.canopy) {
      // Under the canopy: toggles toward the heading, hands off the flare.
      memory.roll = moveToward(memory.roll, clamp(headingError * AUTOPILOT.CANOPY_TURN_GAIN, -AUTOPILOT.CANOPY_TURN_LIMIT, AUTOPILOT.CANOPY_TURN_LIMIT), slew);
      controls.roll = memory.roll;
      controls.pitch = 0;
      controls.yaw = 0;
      return true;
    }
    const bankTarget = clamp(headingError * AUTOPILOT.BANK_PER_DEGREE, -AUTOPILOT.MAX_BANK, AUTOPILOT.MAX_BANK);
    const rollTarget = clamp(AUTOPILOT.BANK_GAIN * (bankTarget - data.bank) - AUTOPILOT.ROLL_RATE_GAIN * data.rollRate, -AUTOPILOT.ROLL_LIMIT, AUTOPILOT.ROLL_LIMIT);
    // Speed by pitch: too slow -> de-arch (push), too fast -> arch (pull).
    const targetSpeed = clamp(Number.isFinite(autopilot.speed) && autopilot.speed > 0 ? autopilot.speed : 50, AUTOPILOT.SPEED_MIN, AUTOPILOT.SPEED_MAX);
    const speedError = data.airspeed - targetSpeed;
    const pitchUnclamped = memory.speedIntegral + AUTOPILOT.SPEED_P * speedError;
    const saturated = (pitchUnclamped >= AUTOPILOT.PITCH_LIMIT && speedError > 0) || (pitchUnclamped <= -AUTOPILOT.PITCH_LIMIT && speedError < 0);
    if (!saturated) memory.speedIntegral = clamp(memory.speedIntegral + AUTOPILOT.SPEED_I * speedError * dt, -AUTOPILOT.PITCH_LIMIT, AUTOPILOT.PITCH_LIMIT);
    let pitchTarget = clamp(pitchUnclamped, -AUTOPILOT.PITCH_LIMIT, AUTOPILOT.PITCH_LIMIT);
    if (threatened) pitchTarget = Math.max(pitchTarget, AUTOPILOT.EVADE_PULL);
    memory.roll = moveToward(memory.roll, rollTarget, slew);
    memory.pitch = moveToward(memory.pitch, pitchTarget, slew);
    memory.yaw = moveToward(memory.yaw, clamp(AUTOPILOT.SIDESLIP_GAIN * data.sideslip, -AUTOPILOT.YAW_LIMIT, AUTOPILOT.YAW_LIMIT), slew);
    controls.roll = memory.roll;
    controls.pitch = memory.pitch;
    controls.yaw = memory.yaw;
    return true;
  },
});

registerAutopilotHandler('wingsuit', wingsuitAutopilot);

// ============================================================================================
// MODEL
// ============================================================================================
export function createSimWingsuitModel({ profile, craft, bus, craftState: initialCraftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'wingsuit';
  const suit = profile.suit;
  const pitchProfile = profile.pitch;
  const rollProfile = profile.roll;
  const yawProfile = profile.yaw;
  const canopyProfile = profile.canopy;
  const deployProfile = profile.deploy;
  const mass = profile.mass;
  const weight = mass * GRAVITY;
  const inertia = new THREE.Vector3(profile.inertia.pitch, profile.inertia.yaw, profile.inertia.roll);
  const curve = createLiftCurve({
    clAlpha: suit.clAlpha,
    clMax: suit.clMax,
    clMin: suit.clMin,
    alphaCritical: suit.alphaCritical,
    postStallDrop: suit.postStallDrop,
    dropWidth: suit.stallDropWidth,
    blendWidth: suit.stallBlendWidth,
  });
  const trimAoa = pitchProfile.trimAoa * DEG;
  const pullRange = pitchProfile.pullRange * DEG;
  const pushRange = pitchProfile.pushRange * DEG;
  const canopyTrim = canopyProfile.trimAoa * DEG;
  const canopyBrakeAoa = canopyProfile.brakeAoa * DEG;
  const canopyRiserAoa = canopyProfile.riserAoa * DEG;
  const canopyBank = canopyProfile.maxBank * DEG;
  const origin = new THREE.Vector3();

  let craftState = initialCraftState;

  // ---- State ---------------------------------------------------------------------------------------
  const state = {
    /** Mesh origin = centre of mass (world). */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x nose up, y nose left, z right wing up. */
    angularVelocity: new THREE.Vector3(),
  };
  const flightContact = createGroundContact(profile.contacts.flight, { centerOfMass: origin, floats: false, mass });
  const canopyContact = createGroundContact(profile.contacts.canopy, { centerOfMass: origin, floats: false, mass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  let activeContact = flightContact;

  /** Limb positions (-1..1): arm asymmetry (roll), body arch (pitch), leg twist (yaw). */
  const limbs = { roll: 0, pitch: 0, yaw: 0 };
  /** Canopy toggles and the canopy's own state. */
  const canopy = {
    phase: 'flight',
    deployTime: 0,
    brakeLeft: 0,
    brakeRight: 0,
    riser: 0,
    aoa: canopyTrim,
    bank: 0,
    heading: 0,
    swing: 0,
    swingRate: 0,
    previousForward: 0,
    openingG: 0,
    landedSeconds: 0,
    restSeconds: 0,
  };
  const deployStart = new THREE.Quaternion();
  let time = 0;
  let resetCount = 0;
  let smoothedLoad = 1;
  let smoothedHorizontal = 0;
  let smoothedSink = 0;
  let deployRequested = false;

  /** Mesh animation: limb deflections and the canopy toggles (the controller passes these to the mesh). */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  const flightData = {
    phase: 'flight',
    canopy: false,
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
    mass,
    resetCount: 0,
    // Read by the autopilot stage (fixed-wing fields it looks for) so it degrades gracefully.
    hasEngine: false,
    engineRunning: false,
    gLimit: Number.isFinite(limits.gLimit) ? limits.gLimit : 5,
    vne: Number.isFinite(limits.vne) ? limits.vne : 80,
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
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const previousQuaternion = new THREE.Quaternion();
  const deltaQuaternion = new THREE.Quaternion();
  const targetQuaternion = new THREE.Quaternion();
  const swingQuaternion = new THREE.Quaternion();
  const bankQuaternion = new THREE.Quaternion();
  const liftResult = { cl: 0, stall: 0, stallAngle: 0 };
  const contactBody = { position: state.position, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };
  const X_AXIS = new THREE.Vector3(1, 0, 0);
  const Z_AXIS = new THREE.Vector3(0, 0, 1);

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  function setPhase(phase) {
    canopy.phase = phase;
    flightData.phase = phase;
    flightData.canopy = phase !== 'flight';
    activeContact = phase === 'flight' || (phase === 'deploying' && canopy.deployTime < deployProfile.contactSwitch) ? flightContact : canopyContact;
  }

  // ============================================================================================
  // ACTIONS AND INPUTS
  // ============================================================================================
  function requestDeploy() {
    if (canopy.phase !== 'flight') {
      notify(canopy.phase === 'landed' ? 'Already down. Relaunch to fly again.' : 'The canopy is already out.');
      return;
    }
    if (activeContact.report.onGround) {
      notify('Get airborne before pulling the chute.');
      return;
    }
    canopy.deployTime = 0;
    canopy.openingG = 0;
    canopy.heading = headingOfAir();
    deployStart.copy(state.quaternion);
    setPhase('deploying');
    notify('Pilot chute out!', 'info');
  }

  function handleActions(controls) {
    if (craftState && craftState.deployRequested) {
      craftState.deployRequested = false;
      deployRequested = true;
    }
    if (controls.actions && controls.actions.size > 0) {
      for (const action of controls.actions) {
        switch (action) {
          case 'chuteDeploy':
            deployRequested = true;
            break;
          case 'engineToggle':
            notify('The wingsuit has no engine: you fly on the ground far below.');
            break;
          case 'gearToggle':
            notify('No landing gear on a wingsuit: your legs are the gear under the canopy.');
            break;
          case 'flapsUp':
          case 'flapsDown':
            notify('No flaps: arch (pull) to flare, de-arch (push) to dive.');
            break;
          default:
            break;
        }
      }
    }
    if (deployRequested) {
      deployRequested = false;
      requestDeploy();
    }
  }

  function axisValue(value) {
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  function updateLimbs(controls, dt) {
    const step = LIMB_RATE * dt;
    limbs.roll = moveToward(limbs.roll, axisValue(controls.roll), step);
    limbs.pitch = moveToward(limbs.pitch, axisValue(controls.pitch), step);
    limbs.yaw = moveToward(limbs.yaw, axisValue(controls.yaw), step);
  }

  /** Toggles: pull flares (both), stick roll and the rudder pedals turn (one side), toe brakes act directly. */
  function updateToggles(controls, dt) {
    const toeLeft = clamp(finiteOr(controls.brakeL, 0), 0, 1);
    const toeRight = clamp(finiteOr(controls.brakeR, 0), 0, 1);
    const symmetric = Math.max(0, axisValue(controls.pitch));
    const turn = clamp(axisValue(controls.roll) + axisValue(controls.yaw) * canopyProfile.pedalShare, -1, 1);
    const leftTarget = clamp(Math.max(symmetric + Math.max(0, -turn), toeLeft), 0, 1);
    const rightTarget = clamp(Math.max(symmetric + Math.max(0, turn), toeRight), 0, 1);
    const step = canopyProfile.toggleRate * dt;
    canopy.brakeLeft = moveToward(canopy.brakeLeft, leftTarget, step);
    canopy.brakeRight = moveToward(canopy.brakeRight, rightTarget, step);
    // Pushing the stick pulls the front risers (a steeper, faster dive).
    canopy.riser = moveToward(canopy.riser, Math.max(0, -axisValue(controls.pitch)), step);
  }

  // ============================================================================================
  // ATTITUDE HELPERS
  // ============================================================================================
  function computeAttitude() {
    bodyAxis.set(0, 0, -1).applyQuaternion(state.quaternion);
    flightData.pitch = Math.asin(clamp(bodyAxis.y, -1, 1));
    if (Math.hypot(bodyAxis.x, bodyAxis.z) > 0.05) flightData.heading = headingFromVector(bodyAxis.x, bodyAxis.z);
    const forwardY = bodyAxis.y;
    bodyAxis.set(1, 0, 0).applyQuaternion(state.quaternion);
    const rightY = bodyAxis.y;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.bank = Math.abs(forwardY) > 0.995 ? 0 : Math.atan2(-rightY, bodyAxis.y);
  }

  /** Heading (deg) the air carries the flyer toward, or the body heading when there is little of it. */
  function headingOfAir() {
    const horizontal = Math.hypot(airWorld.x, airWorld.z);
    if (horizontal > 1) return headingFromVector(airWorld.x, airWorld.z);
    return flightData.heading;
  }

  /** Canopy attitude: heading, pendulum swing (nose up +) and bank (right +). */
  function canopyQuaternion(heading, swing, bank, target) {
    target.setFromAxisAngle(WORLD_UP, -heading * DEG);
    target.multiply(swingQuaternion.setFromAxisAngle(X_AXIS, swing));
    target.multiply(bankQuaternion.setFromAxisAngle(Z_AXIS, -bank));
    return target;
  }

  // ============================================================================================
  // WINGSUIT FLIGHT (rigid body)
  // ============================================================================================
  const suitData = { cl: 0, cd: 0, stall: 0, aoa: 0, sideslip: 0, airspeed: 0, dynamicPressure: 0 };

  /** Suit forces and moments (body axes) scaled by `share` (1 in flight, fading while deploying). */
  function suitForces(rho, agl, turbulence, share) {
    const airspeed = bodyAir.length();
    suitData.airspeed = airspeed;
    if (airspeed < 0.5 || share <= 0) {
      suitData.cl = 0;
      suitData.cd = 0;
      suitData.stall = 0;
      suitData.dynamicPressure = 0;
      return;
    }
    airDirection.copy(bodyAir).divideScalar(airspeed);
    const aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    const sideslip = Math.asin(clamp(airDirection.x, -1, 1));
    evaluateLift(curve, aoa, 0, 0, liftResult);
    const cl = liftResult.cl;
    const stall = liftResult.stall;
    const groundEffect = groundEffectFactor(agl, suit.span);
    const sine = Math.sin(aoa);
    const broadside = smoothstep(curve.alphaZero + curve.clMax / curve.clAlpha, 50 * DEG, Math.abs(aoa)) * BROADSIDE_DRAG * sine * sine;
    const cd = suit.cd0 + suit.inducedDrag * cl * cl * groundEffect * (1 - stall * 0.5) + broadside;
    const dynamicPressure = 0.5 * rho * airspeed * airspeed;
    const load = dynamicPressure * suit.area * share;
    // Lift perpendicular to the airflow in the body's symmetry plane; drag along it; side force.
    liftDirection.set(0, -airDirection.z, airDirection.y);
    const planar = liftDirection.length();
    if (planar > 1e-6) forceBody.addScaledVector(liftDirection, (load * cl) / planar);
    forceBody.addScaledVector(airDirection, -load * cd);
    forceBody.x -= dynamicPressure * suit.sideArea * suit.sideForceSlope * Math.sin(sideslip) * share;

    // Moments: pitch toward the trim the body shape sets, with damping and the stall break.
    const reference = Math.max(airspeed, 4);
    const pitchInput = limbs.pitch;
    const trim = trimAoa + (pitchInput >= 0 ? pitchInput * pullRange : pitchInput * pushRange);
    const stallAngle = liftResult.stallAngle;
    const pastStall = aoa - stallAngle;
    const breakWindow = pastStall > 0 ? 1 - smoothstep(STALL_BREAK_SPAN * 0.5, STALL_BREAK_SPAN, pastStall) : 0;
    const stallBreak = pitchProfile.stallBreak * stall * breakWindow * (0.3 + 0.7 * Math.max(0, pitchInput));
    const pitchDamping = pitchProfile.damping * (1 - 0.6 * stall);
    const cm = -pitchProfile.stiffness * Math.sin(aoa - trim) + stallBreak - pitchDamping * (suit.chord / (2 * reference)) * state.angularVelocity.x;
    momentBody.x += load * suit.chord * cm;

    // Roll (+z right wing up): arm asymmetry, damping (autorotation past the stall), dihedral effect
    // (reversing in the stall: the wing drop follows the sideslip).
    const rollDamping = rollProfile.damping * (1 - rollProfile.autorotation * stall);
    const dihedral = rollProfile.dihedral * (1 - rollProfile.stallReversal * stall);
    const clRoll = -rollProfile.authority * limbs.roll * (1 - 0.5 * stall)
      - rollDamping * (suit.span / (2 * reference)) * state.angularVelocity.z
      + dihedral * Math.sin(sideslip);
    momentBody.z += load * suit.span * clRoll;

    // Yaw (+y nose left): weathervane into the sideslip, damping, leg twist and adverse yaw.
    const cn = -yawProfile.weathervane * Math.sin(sideslip)
      - yawProfile.authority * limbs.yaw
      + yawProfile.adverse * limbs.roll
      - yawProfile.damping * (suit.span / (2 * reference)) * state.angularVelocity.y;
    momentBody.y += load * suit.span * cn;

    // Turbulence: small shaking moments that scale with dynamic pressure.
    if (turbulence > 0) {
      const shake = load * suit.chord * 0.01 * turbulence;
      momentBody.x += shake * noise(time, 0.7, 1.1);
      momentBody.y += shake * 0.6 * noise(time, 2.3, 0.8);
      momentBody.z += shake * 1.5 * noise(time, 4.1, 1.3);
    }

    suitData.cl = cl;
    suitData.cd = cd;
    suitData.stall = stall;
    suitData.aoa = aoa;
    suitData.sideslip = sideslip;
    suitData.dynamicPressure = dynamicPressure;
    flightData.aoaCritical = stallAngle;
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

  /** Body rates from a kinematic attitude change (canopy and deployment). */
  function ratesFromAttitude(dt) {
    deltaQuaternion.copy(previousQuaternion).invert().multiply(state.quaternion).normalize();
    if (deltaQuaternion.w < 0) deltaQuaternion.set(-deltaQuaternion.x, -deltaQuaternion.y, -deltaQuaternion.z, -deltaQuaternion.w);
    const angle = 2 * Math.acos(clamp(deltaQuaternion.w, -1, 1));
    const sine = Math.sqrt(Math.max(0, 1 - deltaQuaternion.w * deltaQuaternion.w));
    if (sine > 1e-7 && dt > 0) state.angularVelocity.set(deltaQuaternion.x / sine, deltaQuaternion.y / sine, deltaQuaternion.z / sine).multiplyScalar(angle / dt);
    else state.angularVelocity.set(0, 0, 0);
  }

  // ============================================================================================
  // CANOPY (point mass under a ram-air canopy)
  // ============================================================================================
  const canopyData = { airspeed: 0, forward: 0, cl: 0, cd: 0, aoa: 0, dynamicPressure: 0 };

  /** Canopy lift and drag (world force), inflation share 0..1 (the opening grows it). */
  function canopyForces(rho, dt, share) {
    const horizontal = Math.hypot(airWorld.x, airWorld.z);
    if (horizontal > 0.4) canopy.heading = headingFromVector(airWorld.x, airWorld.z);
    forward.set(Math.sin(canopy.heading * DEG), 0, -Math.cos(canopy.heading * DEG));
    right.set(-forward.z, 0, forward.x);
    const alongForward = airWorld.x * forward.x + airWorld.z * forward.z;
    const vertical = airWorld.y;
    const planeSpeed = Math.hypot(alongForward, vertical);
    // Both toggles together flare; one toggle mostly banks the canopy into a diving turn.
    const differential = canopy.brakeRight - canopy.brakeLeft;
    const symmetric = Math.min(canopy.brakeLeft, canopy.brakeRight) + 0.2 * Math.abs(differential);
    // Angle of attack: trim plus the brakes (lagging, which is what makes the flare), front risers.
    const targetAoa = canopyTrim + canopyBrakeAoa * symmetric - canopyRiserAoa * canopy.riser;
    canopy.aoa += (targetAoa - canopy.aoa) * (1 - Math.exp(-dt / canopyProfile.aoaLag));
    const bankTarget = canopyBank * clamp(differential, -1, 1);
    canopy.bank += (bankTarget - canopy.bank) * (1 - Math.exp(-dt / canopyProfile.bankLag));
    const cl = canopyProfile.clAlpha * canopy.aoa;
    const cd = canopyProfile.cd0 + canopyProfile.inducedDrag * cl * cl + canopyProfile.brakeDrag * symmetric;
    canopyData.airspeed = airWorld.length();
    canopyData.forward = alongForward;
    canopyData.cl = cl;
    canopyData.cd = cd;
    canopyData.aoa = canopy.aoa;
    if (planeSpeed < 0.3 || share <= 0) {
      canopyData.dynamicPressure = 0;
      return;
    }
    const dynamicPressure = 0.5 * rho * planeSpeed * planeSpeed;
    canopyData.dynamicPressure = dynamicPressure;
    const load = dynamicPressure * canopyProfile.area * share;
    // In the vertical plane along the heading: drag against the airflow, lift perpendicular to it
    // (tilted forward while descending), banked toward the lower toggle.
    const dragScale = (-load * cd) / planeSpeed;
    forceWorld.x += (forward.x * alongForward) * dragScale;
    forceWorld.z += (forward.z * alongForward) * dragScale;
    forceWorld.y += vertical * dragScale;
    const liftScale = (load * cl) / planeSpeed;
    const cosine = Math.cos(canopy.bank);
    const sine = Math.sin(canopy.bank);
    forceWorld.x += (-vertical * forward.x * cosine) * liftScale + right.x * sine * load * cl;
    forceWorld.z += (-vertical * forward.z * cosine) * liftScale + right.z * sine * load * cl;
    forceWorld.y += alongForward * cosine * liftScale;
    // The lines keep the canopy flying along its heading: sideways air is damped out quickly.
    const sideways = airWorld.x * right.x + airWorld.z * right.z;
    forceWorld.x -= right.x * sideways * mass * canopyProfile.sideDamping * share;
    forceWorld.z -= right.z * sideways * mass * canopyProfile.sideDamping * share;
  }

  /** The pendulum swing of the pilot under the canopy, driven by the along-track acceleration. */
  function updateSwing(dt) {
    const acceleration = dt > 0 ? (canopyData.forward - canopy.previousForward) / dt : 0;
    canopy.previousForward = canopyData.forward;
    const omega = Math.sqrt(GRAVITY / canopyProfile.lineLength);
    const accelerationShare = clamp(acceleration, -12, 12) / canopyProfile.lineLength;
    canopy.swingRate += (-omega * omega * canopy.swing - 2 * canopyProfile.swingDamping * omega * canopy.swingRate - accelerationShare) * dt;
    canopy.swing = clamp(canopy.swing + canopy.swingRate * dt, -0.6, 0.6);
  }

  // ============================================================================================
  // STEP
  // ============================================================================================
  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    time += dt;
    if (env.craftState && env.craftState !== craftState) craftState = env.craftState;
    handleActions(controls);
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    airWorld.copy(state.velocity);
    if (env.wind && env.wind.vel) airWorld.sub(env.wind.vel);
    const surface = Math.max(env.groundHeight(state.position.x, state.position.z), env.waterLevel);
    const agl = state.position.y - surface;
    previousQuaternion.copy(state.quaternion);
    forceBody.set(0, 0, 0);
    forceWorld.set(0, 0, 0);
    momentBody.set(0, 0, 0);

    const phase = canopy.phase;
    if (phase === 'flight') {
      updateLimbs(controls, dt);
      inverseQuaternion.copy(state.quaternion).invert();
      bodyAir.copy(airWorld).applyQuaternion(inverseQuaternion);
      suitForces(rho, agl, turbulence, 1);
      forceWorld.copy(forceBody).applyQuaternion(state.quaternion);
    } else if (phase === 'deploying') {
      canopy.deployTime += dt;
      updateLimbs(RELAXED_CONTROLS, dt);
      updateToggles(RELAXED_CONTROLS, dt);
      inverseQuaternion.copy(state.quaternion).invert();
      bodyAir.copy(airWorld).applyQuaternion(inverseQuaternion);
      const suitShare = 1 - smoothstep(0, deployProfile.suitFadeSeconds, canopy.deployTime);
      suitForces(rho, agl, 0, suitShare);
      forceWorld.copy(forceBody).applyQuaternion(state.quaternion);
      addOpeningForce(rho);
      if (canopy.deployTime >= deployProfile.seconds) finishDeployment();
    } else if (phase === 'canopy') {
      updateToggles(controls, dt);
      canopyForces(rho, dt, 1);
      updateSwing(dt);
    } else {
      // Landed: the canopy has collapsed; the pilot stands on the ground.
      updateToggles(controls, dt);
      canopy.bank *= Math.exp(-4 * dt);
      canopy.swing *= Math.exp(-4 * dt);
      canopy.swingRate = 0;
    }
    if (phase === 'deploying' && canopy.deployTime >= deployProfile.contactSwitch && activeContact !== canopyContact) {
      activeContact = canopyContact;
      canopyContact.reset(false);
    }

    // Ground contact against the shared height function.
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    activeContact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    const report = activeContact.report;

    // Translation (semi-implicit Euler).
    forceWorld.add(groundForce);
    const loadForce = forceWorld.length();
    forceWorld.y -= weight;
    state.velocity.addScaledVector(forceWorld, dt / mass);
    if (state.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) state.velocity.setLength(MAX_SPEED);
    state.position.addScaledVector(state.velocity, dt);

    // Rotation: a rigid body in flight, the canopy's kinematic attitude otherwise.
    if (phase === 'flight') {
      momentBody.add(groundMoment);
      integrateRotation(dt);
    } else if (canopy.phase === 'deploying') {
      const progress = smoothstep(0, deployProfile.seconds * 0.8, canopy.deployTime);
      canopyQuaternion(canopy.heading, 0, 0, targetQuaternion);
      state.quaternion.slerpQuaternions(deployStart, targetQuaternion, progress).normalize();
      ratesFromAttitude(dt);
    } else {
      const onGround = report.onGround;
      canopyQuaternion(canopy.heading, onGround ? 0 : canopy.swing, onGround ? canopy.bank * 0.3 : canopy.bank, state.quaternion);
      ratesFromAttitude(dt);
    }

    // Specific force along body up (what the pilot feels), smoothed; the opening shock peak.
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    const specificUp = forceWorld.x * bodyAxis.x + (forceWorld.y + weight) * bodyAxis.y + forceWorld.z * bodyAxis.z;
    const load = canopy.phase === 'flight' ? specificUp / weight : loadForce / weight;
    smoothedLoad += (load - smoothedLoad) * (1 - Math.exp(-LOAD_SMOOTHING * dt));
    if (canopy.phase === 'deploying') canopy.openingG = Math.max(canopy.openingG, smoothedLoad);

    updateGroundPhase(report, dt);
    updateFlightData(dt, agl, report);
    landing.observe(report, { dt, agl: flightData.agl, position: state.position });
    writeCraftState();
  }

  /** Pilot chute, bag and inflation: drag growing with the canopy, capped at the opening shock. */
  function addOpeningForce(rho) {
    const airspeed = airWorld.length();
    if (airspeed < 0.3) return;
    const pilotChute = deployProfile.pilotChuteArea;
    const inflation = smoothstep(deployProfile.bagSeconds, deployProfile.seconds * 0.93, canopy.deployTime);
    const dragArea = pilotChute + canopyProfile.area * deployProfile.inflatedDrag * inflation * inflation;
    const dynamicPressure = 0.5 * rho * airspeed * airspeed;
    const force = Math.min(dynamicPressure * dragArea, deployProfile.shockG * weight);
    forceWorld.addScaledVector(airWorld, -force / airspeed);
  }

  function finishDeployment() {
    setPhase('canopy');
    canopy.aoa = canopyTrim;
    canopy.bank = 0;
    canopy.swing = 0;
    canopy.swingRate = 0;
    const horizontal = Math.hypot(airWorld.x, airWorld.z);
    if (horizontal > 0.4) canopy.heading = headingFromVector(airWorld.x, airWorld.z);
    canopy.previousForward = horizontal;
    notify(`Canopy open (${canopy.openingG.toFixed(1)} g opening). Steer with the toggles, flare before the ground.`, 'success');
  }

  /** Landing under canopy (feet on the ground) and coming to rest on the ground in the suit. */
  function updateGroundPhase(report, dt) {
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    if (canopy.phase === 'canopy' && report.onGround && report.gearContacts > 0) {
      setPhase('landed');
      canopy.landedSeconds = 0;
    }
    if (canopy.phase === 'landed') {
      if (report.onGround && groundSpeed < LANDED_SPEED) canopy.landedSeconds += dt;
      // Blown off the ground again (a gust on a slope): keep flying the canopy.
      if (!report.onGround && canopy.landedSeconds === 0) setPhase('canopy');
    } else if (canopy.phase === 'flight') {
      // A slow slide to rest in the suit (a skim that bled all its speed) also counts as down.
      canopy.restSeconds = report.onGround && state.velocity.length() < FLIGHT_REST_SPEED ? canopy.restSeconds + dt : 0;
      if (canopy.restSeconds > 0.5) {
        setPhase('landed');
        canopy.landedSeconds = canopy.restSeconds;
      }
    }
  }

  function updateFlightData(dt, agl, report) {
    computeAttitude();
    const airspeed = airWorld.length();
    flightData.airspeed = airspeed;
    if (canopy.phase === 'flight' || canopy.phase === 'deploying') {
      flightData.aoa = suitData.aoa;
      flightData.sideslip = suitData.sideslip;
      flightData.stallDepth = suitData.stall;
      flightData.dynamicPressure = suitData.dynamicPressure;
      flightData.liftToDrag = suitData.cd > 0 ? suitData.cl / suitData.cd : 0;
    } else {
      flightData.aoa = canopyData.aoa;
      flightData.sideslip = 0;
      flightData.stallDepth = 0;
      flightData.dynamicPressure = canopyData.dynamicPressure;
      flightData.liftToDrag = canopyData.cd > 0 ? canopyData.cl / canopyData.cd : 0;
    }
    flightData.stallMargin = flightData.aoaCritical - flightData.aoa;
    flightData.stalled = canopy.phase === 'flight' && flightData.stallDepth > STALLED_DEPTH;
    flightData.verticalSpeed = state.velocity.y;
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.flightPath = Math.atan2(state.velocity.y, Math.max(groundSpeed, 0.1));
    flightData.gLoad = smoothedLoad;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.onGround = report.onGround;
    flightData.agl = agl;
    const glideStep = 1 - Math.exp(-GLIDE_SMOOTHING * dt);
    smoothedHorizontal += (groundSpeed - smoothedHorizontal) * glideStep;
    smoothedSink += (-state.velocity.y - smoothedSink) * glideStep;
    flightData.glideRatio = smoothedSink > 0.3 ? smoothedHorizontal / smoothedSink : 0;

    surfaces.aileron = canopy.phase === 'flight' ? limbs.roll : canopy.brakeRight - canopy.brakeLeft;
    surfaces.elevator = canopy.phase === 'flight' ? limbs.pitch : 0.5 * (canopy.brakeLeft + canopy.brakeRight);
    surfaces.rudder = limbs.yaw;
    surfaces.propSpeed = 0;
    surfaces.groundSpeed = report.onGround ? groundSpeed : 0;
  }

  function writeCraftState() {
    if (!craftState) return;
    craftState.phase = canopy.phase;
    craftState.canopy = canopy.phase !== 'flight';
    craftState.deploy = canopy.phase === 'flight' ? 0 : canopy.phase === 'deploying' ? clamp(canopy.deployTime / deployProfile.seconds, 0, 1) : 1;
    craftState.brakeLeft = canopy.brakeLeft;
    craftState.brakeRight = canopy.brakeRight;
    craftState.landedSeconds = canopy.phase === 'landed' ? canopy.landedSeconds : 0;
    craftState.openingG = canopy.openingG;
    craftState.swing = canopy.swing;
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
    // Any teleport (relaunch, respawn, craft or mode switch) starts a fresh flight in the suit.
    limbs.roll = 0;
    limbs.pitch = 0;
    limbs.yaw = 0;
    canopy.deployTime = 0;
    canopy.brakeLeft = 0;
    canopy.brakeRight = 0;
    canopy.riser = 0;
    canopy.aoa = canopyTrim;
    canopy.bank = 0;
    canopy.swing = 0;
    canopy.swingRate = 0;
    canopy.previousForward = 0;
    canopy.openingG = 0;
    canopy.landedSeconds = 0;
    canopy.restSeconds = 0;
    deployRequested = false;
    if (craftState) craftState.deployRequested = false;
    setPhase('flight');
    smoothedLoad = 1;
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    smoothedHorizontal = groundSpeed;
    smoothedSink = Math.max(0, -state.velocity.y);
    flightContact.reset(false);
    canopyContact.reset(false);
    landing.reset(false);
    resetCount++;
    flightData.resetCount = resetCount;
    airWorld.copy(state.velocity);
    computeAttitude();
    canopy.heading = flightData.heading;
    flightData.airspeed = state.velocity.length();
    flightData.onGround = false;
    writeCraftState();
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.aoa = flightData.aoa / DEG;
    flight.sideslip = flightData.sideslip / DEG;
    flight.gLoad = flightData.gLoad;
    flight.throttle = 0;
    flight.afterburner = false;
    flight.engineOn = false;
    flight.rpm = 0;
    flight.rotorRpm = 0;
    flight.torque = 0;
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.gear.retractable = false;
    flight.gear.down = true;
    flight.gear.transit = 0;
    flight.airbrake = canopy.phase === 'flight' ? 0 : 0.5 * (canopy.brakeLeft + canopy.brakeRight);
    flight.brakes = Math.max(canopy.brakeLeft, canopy.brakeRight);
    flight.trim = 0;
    flight.contacts = activeContact.report.contacts;
    flight.stall.stalled = flightData.stalled;
    flight.stall.buffet = Math.round(clamp(flightData.stallDepth, 0, 1) * 1000) / 1000;
    flight.stall.warning = stallWarningActive(flight.assists, flightData.stallMargin, flightData.stalled, canopy.phase !== 'flight' || flightData.onGround || flightData.airspeed < 5);
    flight.overspeed = false;
    flight.glideRatio = flightData.glideRatio;
    // Radar altitude: the lowest point of the flyer (the feet under the canopy) above the ground.
    const lowest = canopy.phase === 'flight' ? profile.radarOffset.flight : profile.radarOffset.canopy;
    flight.radarAltitude = Math.max(0, flight.agl - lowest);
  }

  function snapshot() {
    return {
      kind: 'wingsuit',
      position: [state.position.x, state.position.y, state.position.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      limbs: [limbs.roll, limbs.pitch, limbs.yaw],
      canopy: { ...canopy },
      deployStart: [deployStart.x, deployStart.y, deployStart.z, deployStart.w],
      load: smoothedLoad,
      glide: [smoothedHorizontal, smoothedSink],
      time,
      flightContact: flightContact.snapshot(),
      canopyContact: canopyContact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'wingsuit') return false;
    state.position.fromArray(data.position);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    [limbs.roll, limbs.pitch, limbs.yaw] = data.limbs;
    Object.assign(canopy, data.canopy);
    deployStart.fromArray(data.deployStart);
    smoothedLoad = finiteOr(data.load, 1);
    [smoothedHorizontal, smoothedSink] = data.glide;
    time = finiteOr(data.time, time);
    flightContact.restore(data.flightContact);
    canopyContact.restore(data.canopyContact);
    landing.restore(data.landing);
    setPhase(canopy.phase);
    computeAttitude();
    writeCraftState();
    return true;
  }

  setPhase('flight');

  return {
    kind: 'wingsuit',
    profile,
    state,
    surfaces,
    flightData,
    reset,
    step,
    writeTelemetry,
    snapshot,
    restore,

    /** The active contact report (the suit's body points in flight, the feet under the canopy). */
    get contact() {
      return activeContact.report;
    },
    /** Number of resets so far (control stages re-initialize when it changes). */
    get resetCount() {
      return resetCount;
    },
    get phase() {
      return canopy.phase;
    },
    get landings() {
      return landing.landings;
    },
    /** Opens the canopy (the same as the chuteDeploy action). */
    deploy() {
      requestDeploy();
      return canopy.phase === 'deploying';
    },

    dispose() {
      flightContact.report.touchdown = null;
      flightContact.report.bodyStrike = null;
      canopyContact.report.touchdown = null;
      canopyContact.report.bodyStrike = null;
      if (craftState) {
        craftState.canopy = false;
        craftState.phase = 'flight';
        craftState.deploy = 0;
        craftState.landedSeconds = 0;
        craftState.proximityWarning = null;
        craftState.deployRequested = false;
      }
    },
  };
}
