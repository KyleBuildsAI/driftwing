// Tiltrotor assists, autopilot and trim: the control laws between the pilot's ControlState and
// SimTiltrotor, registered for model kind 'tiltrotor' with the shared assist stage (assists.js), the
// PID autopilot stage (autopilot.js) and the trim (trim.js). Everything flies through the model's
// controls (stick, pedals, thrust lever); nothing ever sets the attitude.
//
// Every law blends between its helicopter-mode and airplane-mode form with the model's hover share
// (flightData.hoverShare: 1 with the nacelles up, 0 in airplane mode), so a conversion never switches
// control laws abruptly.
//
// Assist levels (settings.assists.tiltrotor, 0..1; each assist's weight ramps over its range):
//   100 %  attitude command with limits (the stick commands pitch and bank; hands off it holds the
//          attitude, wings level in airplane mode); auto-hover in helicopter mode (hands off the
//          stick the craft stops and holds its position, and the thrust lever becomes a climb /
//          descent command around its centre detent, touchdowns cushioned); stall protection in
//          airplane mode (the pitch command eases off near the wing's critical angle)
//    50 %  stability augmentation (rate damping, attitude hold hands off) and heading hold in the
//          hover / turn coordination at speed
//     0 %  raw controls
// The auto-nacelle schedule (craftState.autoNacelle, the craft ability) works at every level: it is
// part of the flight control computer, not an assist.
import { DEG, clamp } from '../core/util.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';
import { registerTrimHandler } from './trim.js';
import { waterHeightAt } from './waterSurface.js';
import { NACELLE, conversionCorridor, scheduledNacelle } from './tiltrotorCorridor.js';

export const TILTROTOR_ASSISTS = Object.freeze([
  Object.freeze({ key: 'stability', name: 'stability augmentation', from: 0, full: 0.5 }),
  Object.freeze({ key: 'headingHold', name: 'heading hold and turn coordination', from: 0, full: 0.5 }),
  Object.freeze({ key: 'attitudeLimits', name: 'attitude command and limits', from: 0.5, full: 1 }),
  Object.freeze({ key: 'autoHover', name: 'auto-hover', from: 0.5, full: 1 }),
]);

export const TILTROTOR_TUNING = Object.freeze({
  /** Stick inside this is "hands off" for that axis; hands off counts after IDLE_DELAY seconds. */
  IDLE: 0.06,
  IDLE_DELAY: 0.4,
  STABILITY: Object.freeze({ PITCH_DAMPING: 0.9, ROLL_DAMPING: 0.5, YAW_DAMPING: 0.8, HOLD_P: 1.6, HOLD_I: 0.5, TRIM_LIMIT: 0.6 }),
  ATTITUDE: Object.freeze({
    PITCH_HOVER: 15 * DEG,
    PITCH_PLANE: 22 * DEG,
    BANK_HOVER: 20 * DEG,
    BANK_PLANE: 50 * DEG,
    PITCH_P: 2.8,
    PITCH_D: 1.6,
    PITCH_I: 1.2,
    ROLL_P: 2.4,
    ROLL_D: 0.9,
    ROLL_I: 0.8,
    INTEGRAL_LIMIT: 0.7,
    /** Control power falls with airspeed in airplane mode: gains scale by (REFERENCE_SPEED / airspeed)^2, clamped. */
    REFERENCE_SPEED: 70,
    MIN_SCALE: 0.25,
    /** Airplane mode: the pitch command eases off within this of the wing's critical angle (rad). */
    STALL_MARGIN: 3 * DEG,
  }),
  HOVER: Object.freeze({
    VELOCITY_P: 0.035,
    VELOCITY_I: 0.01,
    POSITION_P: 0.25,
    MAX_TILT: 10 * DEG,
    TILT_INTEGRAL_LIMIT: 6 * DEG,
    CAPTURE_SPEED: 1.5,
    MAX_RECOVERY_SPEED: 6,
    /** Hands-off position hold works below this airspeed (m/s); faster it only levels the wings. */
    MAX_SPEED: 25,
  }),
  VERTICAL: Object.freeze({
    DETENT: 0.5,
    DEADBAND: 0.07,
    MAX_CLIMB: 8,
    MAX_DESCENT: 5,
    P: 0.05,
    I: 0.05,
    INTEGRAL_LIMIT: 0.35,
    ALTITUDE_P: 0.5,
    ALTITUDE_RATE: 3,
    LAND_BASE: 0.4,
    LAND_SLOPE: 0.35,
    GROUND_RUNDOWN: 0.4,
    COLLECTIVE_RATE: 0.8,
    GROUND_RATE: 0.5,
    RING_SAFE_SHARE: 0.2,
  }),
  /** Heading: rad/s of yaw rate per rad of error, the rate loop (pedal per rad/s) and its integral. */
  HEADING: Object.freeze({ P: 0.8, RATE_P: 4, I: 1.5, MAX_RATE: 15 * DEG, INTEGRAL_LIMIT: 0.5, COORDINATION_SPEEDS: Object.freeze([20, 35]), SIDESLIP_GAIN: 2, YAW_DAMPER: 3 }),
  PICKUP: Object.freeze({ MOVE: 0.03, SLEW: 0.5 }),
});

function wrapSignedRadians(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

// ============================================================================================
// CONTROL LOOPS (shared by the assists and the autopilot)
// ============================================================================================
function createLoopMemory() {
  return {
    resetCount: -1,
    initialized: false,
    pitchIntegral: 0,
    rollIntegral: 0,
    trimPitch: 0,
    trimRoll: 0,
    holdPitch: 0,
    holdBank: 0,
    holdCaptured: false,
    stickIdle: 0,
    headingTarget: 0,
    headingIntegral: 0,
    tiltIntegralForward: 0,
    tiltIntegralRight: 0,
    positionCaptured: false,
    holdX: 0,
    holdZ: 0,
    altitudeTarget: 0,
    altitudeCaptured: false,
    verticalIntegral: 0,
    collective: 0.5,
    pickupReference: NaN,
    pickupValue: 0.5,
    pickupArmed: true,
    pickupDone: false,
    autopilotWasFlying: false,
  };
}

function initializeLoops(memory, data, controls) {
  memory.initialized = true;
  memory.pitchIntegral = clamp(controls.pitch, -TILTROTOR_TUNING.ATTITUDE.INTEGRAL_LIMIT, TILTROTOR_TUNING.ATTITUDE.INTEGRAL_LIMIT);
  memory.rollIntegral = clamp(controls.roll, -TILTROTOR_TUNING.ATTITUDE.INTEGRAL_LIMIT, TILTROTOR_TUNING.ATTITUDE.INTEGRAL_LIMIT);
  memory.trimPitch = 0;
  memory.trimRoll = 0;
  memory.holdPitch = data.pitch;
  memory.holdBank = data.bank;
  memory.holdCaptured = false;
  memory.headingTarget = data.heading * DEG;
  memory.headingIntegral = 0;
  memory.tiltIntegralForward = 0;
  memory.tiltIntegralRight = 0;
  memory.positionCaptured = false;
  memory.altitudeCaptured = false;
  memory.verticalIntegral = 0;
  memory.collective = data.collective;
}

/** Groundspeed in the heading frame: forward and to the right (m/s). */
function headingFrameVelocity(data, target) {
  const heading = data.heading * DEG;
  const sine = Math.sin(heading);
  const cosine = Math.cos(heading);
  const velocity = data.velocity;
  target.forward = velocity.x * sine - velocity.z * cosine;
  target.right = velocity.x * cosine + velocity.z * sine;
  return target;
}
const velocityScratch = { forward: 0, right: 0 };

/** Control power scale: 1 in the hover, falling as the square of the airspeed in airplane mode. */
function gainScale(data) {
  const tuning = TILTROTOR_TUNING.ATTITUDE;
  const speed = Math.max(data.airspeed, 1);
  const plane = clamp((tuning.REFERENCE_SPEED / speed) ** 2, tuning.MIN_SCALE, 1);
  return data.hoverShare + (1 - data.hoverShare) * plane;
}

/** Pitch and bank limits for the current mode (rad). */
function attitudeLimits(data, out) {
  const tuning = TILTROTOR_TUNING.ATTITUDE;
  const hover = data.hoverShare * (1 - smooth01((data.airspeed - 20) / 25));
  out.pitch = tuning.PITCH_PLANE + (tuning.PITCH_HOVER - tuning.PITCH_PLANE) * hover;
  out.bank = tuning.BANK_PLANE + (tuning.BANK_HOVER - tuning.BANK_PLANE) * hover;
  return out;
}
const limitScratch = { pitch: 0, bank: 0 };

/** Attitude targets (rad) to stick: PID with rate damping, gain-scheduled with airspeed. */
function attitudeToStick(memory, data, pitchTarget, bankTarget, dt, out) {
  const tuning = TILTROTOR_TUNING.ATTITUDE;
  const scale = gainScale(data);
  const pitchError = pitchTarget - data.pitch;
  const bankError = wrapSignedRadians(bankTarget - data.bank);
  const pitch = memory.pitchIntegral + scale * (tuning.PITCH_P * pitchError - tuning.PITCH_D * data.pitchRate);
  const roll = memory.rollIntegral + scale * (tuning.ROLL_P * bankError - tuning.ROLL_D * data.rollRate);
  if (!data.onGround) {
    if (Math.abs(pitch) < 1 || pitch * pitchError < 0) memory.pitchIntegral = clamp(memory.pitchIntegral + scale * tuning.PITCH_I * pitchError * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
    if (Math.abs(roll) < 1 || roll * bankError < 0) memory.rollIntegral = clamp(memory.rollIntegral + scale * tuning.ROLL_I * bankError * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
  } else {
    memory.pitchIntegral -= memory.pitchIntegral * Math.min(1, dt / 2);
    memory.rollIntegral -= memory.rollIntegral * Math.min(1, dt / 2);
  }
  out.pitch = clamp(pitch, -1, 1);
  out.roll = clamp(roll, -1, 1);
  return out;
}
const attitudeOut = { pitch: 0, roll: 0 };

/** Hover hold: commanded groundspeeds (heading frame) or the captured position -> pitch / bank targets. */
function velocityToAttitude(memory, data, position, targetForward, targetRight, dt, out) {
  const tuning = TILTROTOR_TUNING.HOVER;
  const frame = headingFrameVelocity(data, velocityScratch);
  const holding = targetForward === 0 && targetRight === 0;
  if (!holding) memory.positionCaptured = false;
  else if (!memory.positionCaptured && data.groundSpeed < tuning.CAPTURE_SPEED) {
    memory.positionCaptured = true;
    memory.holdX = position.x;
    memory.holdZ = position.z;
  }
  let wantForward = targetForward;
  let wantRight = targetRight;
  if (holding && memory.positionCaptured) {
    const heading = data.heading * DEG;
    const errorX = memory.holdX - position.x;
    const errorZ = memory.holdZ - position.z;
    wantForward = clamp((errorX * Math.sin(heading) - errorZ * Math.cos(heading)) * tuning.POSITION_P, -tuning.MAX_RECOVERY_SPEED, tuning.MAX_RECOVERY_SPEED);
    wantRight = clamp((errorX * Math.cos(heading) + errorZ * Math.sin(heading)) * tuning.POSITION_P, -tuning.MAX_RECOVERY_SPEED, tuning.MAX_RECOVERY_SPEED);
  }
  const forwardError = wantForward - frame.forward;
  const rightError = wantRight - frame.right;
  if (!data.onGround) {
    memory.tiltIntegralForward = clamp(memory.tiltIntegralForward + tuning.VELOCITY_I * forwardError * dt, -tuning.TILT_INTEGRAL_LIMIT, tuning.TILT_INTEGRAL_LIMIT);
    memory.tiltIntegralRight = clamp(memory.tiltIntegralRight + tuning.VELOCITY_I * rightError * dt, -tuning.TILT_INTEGRAL_LIMIT, tuning.TILT_INTEGRAL_LIMIT);
  }
  out.pitch = clamp(-(tuning.VELOCITY_P * forwardError + memory.tiltIntegralForward), -tuning.MAX_TILT, tuning.MAX_TILT);
  out.bank = clamp(tuning.VELOCITY_P * rightError + memory.tiltIntegralRight, -tuning.MAX_TILT, tuning.MAX_TILT);
  return out;
}
const tiltOut = { pitch: 0, bank: 0 };

/** Vertical speed command (m/s) -> thrust lever, with the model's trim lever as feed-forward. */
function verticalSpeedToCollective(memory, data, verticalSpeedTarget, dt) {
  const tuning = TILTROTOR_TUNING.VERTICAL;
  if (data.onGround && verticalSpeedTarget <= 0.05) {
    memory.verticalIntegral = 0;
    memory.collective = moveToward(memory.collective, 0, tuning.GROUND_RUNDOWN * dt);
    return memory.collective;
  }
  const error = verticalSpeedTarget - data.verticalSpeed;
  const unclamped = data.trimCollective + tuning.P * error + memory.verticalIntegral;
  if ((unclamped < 1 || error < 0) && (unclamped > 0 || error > 0)) {
    memory.verticalIntegral = clamp(memory.verticalIntegral + tuning.I * error * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
  }
  memory.collective = moveToward(memory.collective, clamp(unclamped, 0, 1), (data.onGround ? tuning.GROUND_RATE : tuning.COLLECTIVE_RATE) * dt);
  return memory.collective;
}

/** Descent limits (m/s, negative): out of the vortex ring at low airspeed, cushioned near the ground. */
function descentLimit(data) {
  const tuning = TILTROTOR_TUNING.VERTICAL;
  const induced = Math.max(data.hoverInduced, 1);
  const slow = tuning.RING_SAFE_SHARE * induced;
  const ring = -(slow + (tuning.MAX_DESCENT - slow) * smooth01(data.airspeed / (1.5 * induced)));
  const height = Number.isFinite(data.agl) ? Math.max(0, data.agl) : Infinity;
  return Math.max(ring, -(tuning.LAND_BASE + tuning.LAND_SLOPE * height));
}

function altitudeToVerticalSpeed(target, altitude) {
  const tuning = TILTROTOR_TUNING.VERTICAL;
  return clamp((target - altitude) * tuning.ALTITUDE_P, -tuning.ALTITUDE_RATE, tuning.ALTITUDE_RATE);
}

/** Thrust lever -> vertical speed command around the centre detent (m/s). */
function leverToVerticalSpeed(lever) {
  const tuning = TILTROTOR_TUNING.VERTICAL;
  const offset = lever - tuning.DETENT;
  if (Math.abs(offset) <= tuning.DEADBAND) return 0;
  const span = 1 - tuning.DETENT - tuning.DEADBAND;
  if (offset > 0) return ((offset - tuning.DEADBAND) / span) * tuning.MAX_CLIMB;
  return ((offset + tuning.DEADBAND) / span) * tuning.MAX_DESCENT;
}

/**
 * Heading hold in the hover through a yaw-rate loop (the craft's big yaw inertia needs the damping):
 * hands off the heading error becomes a limited yaw-rate command, pushed pedals command a yaw rate;
 * turn coordination at speed (the pedals keep the sideslip at zero).
 */
function headingToPedal(memory, data, pedal, dt) {
  const tuning = TILTROTOR_TUNING.HEADING;
  const heading = data.heading * DEG;
  const [low, high] = tuning.COORDINATION_SPEEDS;
  const coordination = smooth01((data.airspeed - low) / (high - low));
  const idle = Math.abs(pedal) < TILTROTOR_TUNING.IDLE;
  let rateCommand;
  if (idle && !data.onGround) {
    rateCommand = clamp(tuning.P * wrapSignedRadians(memory.headingTarget - heading), -tuning.MAX_RATE, tuning.MAX_RATE);
  } else {
    memory.headingTarget = heading;
    rateCommand = pedal * tuning.MAX_RATE;
  }
  const rateError = rateCommand - data.yawRate;
  const hold = tuning.RATE_P * rateError;
  if (!data.onGround && (Math.abs(hold + memory.headingIntegral) < 1 || hold * rateError < 0)) {
    memory.headingIntegral = clamp(memory.headingIntegral + tuning.I * rateError * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
  }
  const hover = memory.headingIntegral + hold;
  // At speed: the ball centred, and a yaw damper against the yaw rate the bank does not explain (the
  // Dutch roll of a big, lightly damped airframe).
  const turnRate = (9.81 * Math.tan(clamp(data.bank, -1.2, 1.2))) / Math.max(data.airspeed, 20);
  const coordinated = pedal + tuning.SIDESLIP_GAIN * data.sideslip - tuning.YAW_DAMPER * (data.yawRate - turnRate);
  if (coordination > 0.5 || data.onGround) memory.headingTarget = heading;
  return clamp(hover + (coordinated - hover) * coordination, -1, 1);
}

/** After a respawn the lever may sit anywhere: until it moves, the thrust stays where the model spawned it. */
function pickupLever(memory, lever, data, dt) {
  const tuning = TILTROTOR_TUNING.PICKUP;
  if (!Number.isFinite(memory.pickupReference)) {
    memory.pickupReference = lever;
    memory.pickupValue = data.collective;
    memory.pickupArmed = Math.abs(lever - data.collective) > tuning.MOVE;
    memory.pickupDone = !memory.pickupArmed;
  }
  if (memory.pickupDone) return lever;
  if (memory.pickupArmed) {
    if (Math.abs(lever - memory.pickupReference) <= tuning.MOVE) return memory.pickupValue;
    memory.pickupArmed = false;
  }
  memory.pickupValue = moveToward(memory.pickupValue, lever, tuning.SLEW * dt);
  if (memory.pickupValue === lever) memory.pickupDone = true;
  return memory.pickupValue;
}

// ============================================================================================
// ASSIST HANDLER
// ============================================================================================
const tiltrotorAssistHandler = Object.freeze({
  createMemory: createLoopMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const position = model.state.position;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled) && data.engineRunning;
    if (!memory.initialized) initializeLoops(memory, data, controls);
    const rawLever = clamp(Number.isFinite(controls.collective) ? controls.collective : 0.5, 0, 1);
    const lever = pickupLever(memory, rawLever, data, dt);
    if (autopilotFlying) {
      memory.autopilotWasFlying = true;
      return;
    }
    if (memory.autopilotWasFlying) {
      memory.autopilotWasFlying = false;
      initializeLoops(memory, data, controls);
      memory.pickupReference = rawLever;
      memory.pickupValue = data.collective;
      memory.pickupArmed = true;
      memory.pickupDone = false;
    }
    const tuning = TILTROTOR_TUNING;
    const stability = weights.stability ?? 0;
    const headingWeight = weights.headingHold ?? 0;
    const limitsWeight = weights.attitudeLimits ?? 0;
    const hoverWeight = weights.autoHover ?? 0;
    // Auto-hover belongs to helicopter mode at low airspeed. Its hands-off position hold stands aside
    // while the pilot has selected the nacelles forward (a conversion: the nacelles accelerate the craft).
    const hoverRegime = data.hoverShare * (1 - smooth01((data.airspeed - tuning.HOVER.MAX_SPEED * 0.6) / (tuning.HOVER.MAX_SPEED * 0.4)));
    const craftState = context.env && context.env.craftState ? context.env.craftState : null;
    const converting = craftState !== null && Number.isFinite(craftState.nacelleTarget) && craftState.nacelleTarget < NACELLE.HOVER_MODE;
    const positionHold = converting ? 0 : hoverRegime;

    const idleNow = Math.abs(controls.pitch) < tuning.IDLE && Math.abs(controls.roll) < tuning.IDLE;
    memory.stickIdle = idleNow ? memory.stickIdle + dt : 0;
    const stickIdle = memory.stickIdle >= tuning.IDLE_DELAY;

    // ---- Stick: raw -> stability augmentation -> attitude command with the hover hold --------------------
    let pitch = controls.pitch;
    let roll = controls.roll;
    if (stability > 0) {
      const sas = tuning.STABILITY;
      const scale = gainScale(data);
      if (stickIdle && !data.onGround) {
        if (!memory.holdCaptured) {
          memory.holdCaptured = true;
          memory.holdPitch = data.pitch;
          memory.holdBank = Math.abs(data.bank) < 5 * DEG ? 0 : data.bank;
        }
        const pitchError = memory.holdPitch - data.pitch;
        const bankError = wrapSignedRadians(memory.holdBank - data.bank);
        memory.trimPitch = clamp(memory.trimPitch + sas.HOLD_I * scale * pitchError * dt, -sas.TRIM_LIMIT, sas.TRIM_LIMIT);
        memory.trimRoll = clamp(memory.trimRoll + sas.HOLD_I * scale * bankError * dt, -sas.TRIM_LIMIT, sas.TRIM_LIMIT);
        pitch += sas.HOLD_P * scale * pitchError;
        roll += sas.HOLD_P * scale * bankError;
      } else {
        memory.holdCaptured = false;
      }
      const assisted = clamp(pitch + memory.trimPitch - sas.PITCH_DAMPING * scale * data.pitchRate, -1, 1);
      const assistedRoll = clamp(roll + memory.trimRoll - sas.ROLL_DAMPING * scale * data.rollRate, -1, 1);
      pitch = controls.pitch + (assisted - controls.pitch) * stability;
      roll = controls.roll + (assistedRoll - controls.roll) * stability;
    }
    if (limitsWeight > 0) {
      attitudeLimits(data, limitScratch);
      let pitchTarget = controls.pitch * limitScratch.pitch;
      let bankTarget = controls.roll * limitScratch.bank;
      if (stickIdle && hoverWeight > 0 && positionHold > 0) {
        velocityToAttitude(memory, data, position, 0, 0, dt, tiltOut);
        // Faster than the hover hold works, hands off holds the wings level and the pitch it had.
        pitchTarget = tiltOut.pitch * hoverWeight * positionHold + memory.holdPitch * (1 - hoverWeight * positionHold);
        bankTarget = tiltOut.bank * hoverWeight * positionHold;
      } else if (stickIdle) {
        memory.positionCaptured = false;
        // Hands off: wings level, and the pitch it had (level in a conversion from the hover).
        pitchTarget = converting && hoverRegime > 0.5 ? 0 : memory.holdCaptured ? memory.holdPitch : data.pitch;
        bankTarget = 0;
      } else {
        memory.positionCaptured = false;
        memory.tiltIntegralForward = clamp(-data.pitch, -tuning.HOVER.TILT_INTEGRAL_LIMIT, tuning.HOVER.TILT_INTEGRAL_LIMIT);
        memory.tiltIntegralRight = clamp(data.bank, -tuning.HOVER.TILT_INTEGRAL_LIMIT, tuning.HOVER.TILT_INTEGRAL_LIMIT);
      }
      if (!memory.holdCaptured) memory.holdPitch = data.pitch;
      // Stall protection in airplane mode: no more nose-up command near the wing's critical angle.
      const plane = 1 - data.hoverShare;
      if (plane > 0.3 && data.airspeed > 25 && data.stallMargin < tuning.ATTITUDE.STALL_MARGIN) {
        pitchTarget = Math.min(pitchTarget, data.pitch - (tuning.ATTITUDE.STALL_MARGIN - data.stallMargin) * plane);
      }
      attitudeToStick(memory, data, pitchTarget, bankTarget, dt, attitudeOut);
      pitch += (attitudeOut.pitch - pitch) * limitsWeight;
      roll += (attitudeOut.roll - roll) * limitsWeight;
    } else {
      memory.pitchIntegral = clamp(pitch, -tuning.ATTITUDE.INTEGRAL_LIMIT, tuning.ATTITUDE.INTEGRAL_LIMIT);
      memory.rollIntegral = clamp(roll, -tuning.ATTITUDE.INTEGRAL_LIMIT, tuning.ATTITUDE.INTEGRAL_LIMIT);
    }
    controls.pitch = clamp(pitch, -1, 1);
    controls.roll = clamp(roll, -1, 1);

    // ---- Thrust lever: direct, or a vertical speed command around the detent in the hover -------------
    const vertical = hoverWeight * hoverRegime;
    if (vertical > 0) {
      let verticalTarget = leverToVerticalSpeed(lever);
      if (verticalTarget === 0 && !data.onGround) {
        if (!memory.altitudeCaptured) {
          memory.altitudeCaptured = true;
          memory.altitudeTarget = position.y + data.verticalSpeed * 0.6;
        }
        verticalTarget = altitudeToVerticalSpeed(memory.altitudeTarget, position.y);
      } else {
        memory.altitudeCaptured = false;
      }
      verticalTarget = Math.max(verticalTarget, descentLimit(data));
      const collective = verticalSpeedToCollective(memory, data, verticalTarget, dt);
      controls.collective = lever + (collective - lever) * vertical;
    } else {
      controls.collective = lever;
      memory.collective = lever;
      memory.verticalIntegral = 0;
      memory.altitudeCaptured = false;
    }

    // ---- Pedals: heading hold in the hover, coordination at speed, yaw damping -------------------------------
    let yaw = controls.yaw;
    // Yaw damping in every mode (scheduled with the control power).
    if (stability > 0) yaw = clamp(yaw - tuning.STABILITY.YAW_DAMPING * stability * gainScale(data) * data.yawRate, -1, 1);
    if (headingWeight > 0) {
      const held = headingToPedal(memory, data, controls.yaw, dt);
      yaw = yaw + (held - yaw) * headingWeight;
    } else {
      memory.headingTarget = data.heading * DEG;
      memory.headingIntegral = 0;
    }
    controls.yaw = clamp(yaw, -1, 1);
  },
});

registerAssistCatalog('tiltrotor', TILTROTOR_ASSISTS);
registerAssistHandler('tiltrotor', tiltrotorAssistHandler);

// ============================================================================================
// AUTOPILOT: heading, altitude and speed hold; it selects the nacelles itself (on the schedule)
// ============================================================================================
const AUTOPILOT = Object.freeze({
  /** Below this commanded speed the autopilot hovers (m/s); above AIRPLANE_SPEED it flies airplane mode. */
  HOVER_SPEED: 3,
  AIRPLANE_SPEED: 45,
  MAX_SPEED_SHARE: 0.85,
  /** Helicopter mode: pitch attitude per m/s of speed error (rad). */
  SPEED_P: 0.025,
  SPEED_I: 0.005,
  MAX_PITCH: 10 * DEG,
  /** Airplane mode: the thrust lever per m/s of speed error, and the flight path per m of height error. */
  LEVER_P: 0.02,
  LEVER_I: 0.005,
  PATH_PER_METRE: 0.0025,
  MAX_PATH: 8 * DEG,
  PATH_P: 1,
  PATH_I: 0.35,
  BANK_PER_HEADING: 1.1,
  MAX_BANK: 30 * DEG,
  TURN_SPEED: 20,
  ALIGN_ANGLE: 35 * DEG,
  CLIMB_PER_METRE: 0.25,
  MAX_CLIMB: 5,
  /** Climb limit (m/s) while the nacelles come down: the thrust goes into the acceleration. */
  CONVERSION_CLIMB: 1.5,
  /** A conversion waits while the terrain floor ahead (clearance included) is more than this above the craft (m). */
  CONVERSION_MARGIN: 20,
  MAX_DESCENT: 4,
  LOOKAHEAD: Object.freeze([0, 200, 400, 800, 1400, 2200]),
  LOOKAHEAD_REFRESH: 0.5,
  CLEARANCE: 90,
});

function createAutopilotMemory() {
  return { ...createLoopMemory(), engaged: false, speedIntegral: 0, leverIntegral: 0.4, pathPitch: 0, lookaheadAge: Infinity, terrainFloor: -Infinity, corridor: { min: 0, max: NACELLE.MAX } };
}

function refreshTerrainFloor(memory, env, position, headingDegrees, dt) {
  memory.lookaheadAge += dt;
  if (memory.lookaheadAge < AUTOPILOT.LOOKAHEAD_REFRESH) return;
  memory.lookaheadAge = 0;
  const world = env.world;
  if (!world || typeof world.groundHeight !== 'function') {
    memory.terrainFloor = -Infinity;
    return;
  }
  const directionX = Math.sin(headingDegrees * DEG);
  const directionZ = -Math.cos(headingDegrees * DEG);
  let floor = -Infinity;
  for (const distance of AUTOPILOT.LOOKAHEAD) {
    const aheadX = position.x + directionX * distance;
    const aheadZ = position.z + directionZ * distance;
    floor = Math.max(floor, Math.max(world.groundHeight(aheadX, aheadZ), waterHeightAt(env, aheadX, aheadZ)) + AUTOPILOT.CLEARANCE);
  }
  memory.terrainFloor = floor;
}

const tiltrotorAutopilot = Object.freeze({
  createMemory: createAutopilotMemory,

  apply(controls, context, memory) {
    const autopilot = context.autopilot;
    if (!autopilot || !autopilot.enabled) {
      memory.engaged = false;
      return false;
    }
    const model = context.model;
    const data = model.flightData;
    if (!data.engineRunning) {
      memory.engaged = false;
      return false;
    }
    const dt = context.dt;
    const position = model.state.position;
    const env = context.env;
    if (!memory.engaged) {
      memory.engaged = true;
      initializeLoops(memory, data, controls);
      memory.speedIntegral = 0;
      memory.leverIntegral = data.collective;
      memory.pathPitch = data.pitch;
      memory.lookaheadAge = Infinity;
    }
    const vne = Number.isFinite(data.vne) ? data.vne : 150;
    const commanded = Number.isFinite(autopilot.speed) ? autopilot.speed : 0;
    const hovering = context.handsOff ? data.airspeed < AUTOPILOT.AIRPLANE_SPEED : commanded < AUTOPILOT.HOVER_SPEED;
    const speedTarget = hovering ? 0 : clamp(context.handsOff ? data.airspeed : commanded, 0, vne * AUTOPILOT.MAX_SPEED_SHARE);
    const headingTarget = Number.isFinite(autopilot.heading) ? autopilot.heading : data.heading;
    refreshTerrainFloor(memory, env, position, headingTarget, dt);
    const altitudeTarget = Math.max(Number.isFinite(autopilot.altitude) ? autopilot.altitude : position.y, memory.terrainFloor);

    const headingError = wrapSignedRadians((headingTarget - data.heading) * DEG);
    const frame = headingFrameVelocity(data, velocityScratch);
    // Airplane mode only once the nose points the way to go (a hover turns on the spot first) and, still
    // in helicopter mode, once the craft is above the terrain ahead (it climbs out vertically first).
    const wantAirplane = speedTarget >= AUTOPILOT.AIRPLANE_SPEED;
    const aligned = Math.abs(headingError) < AUTOPILOT.ALIGN_ANGLE || data.airspeed > AUTOPILOT.TURN_SPEED * 2;
    const terrainAhead = memory.terrainFloor > position.y + AUTOPILOT.CONVERSION_MARGIN && data.hoverShare > 0.5;
    const converting = wantAirplane && aligned && !terrainAhead;

    // ---- Nacelles: hover, or airplane mode on the auto-nacelle schedule ----------------------------------
    const craftState = env && env.craftState ? env.craftState : null;
    if (craftState) {
      conversionCorridor(data.airspeed, env.rho, model.corridorParameters, memory.corridor);
      const selection = scheduledNacelle(converting ? NACELLE.MIN : NACELLE.HOVER, memory.corridor, model.corridorParameters.margin);
      if (Math.abs((craftState.nacelleTarget ?? selection) - selection) > 0.5) craftState.nacelleTarget = Math.round(selection);
    }

    const hover = data.hoverShare * (1 - smooth01((data.airspeed - 30) / 20));

    // ---- Helicopter form: altitude -> collective; hold position, fly slow speeds with the pitch, or
    // keep the attitude level while the nacelles accelerate the craft through a conversion ---------------
    const climbLimit = converting ? AUTOPILOT.CONVERSION_CLIMB : AUTOPILOT.MAX_CLIMB;
    const verticalTarget = Math.max(clamp((altitudeTarget - position.y) * AUTOPILOT.CLIMB_PER_METRE, -AUTOPILOT.MAX_DESCENT, climbLimit), descentLimit(data));
    const heliCollective = verticalSpeedToCollective(memory, data, verticalTarget, dt);
    let heliPitch;
    let heliBank;
    if (hovering || (wantAirplane && !converting)) {
      velocityToAttitude(memory, data, position, 0, 0, dt, tiltOut);
      heliPitch = tiltOut.pitch;
      heliBank = tiltOut.bank;
    } else if (converting) {
      memory.positionCaptured = false;
      heliPitch = 0;
      heliBank = clamp(-0.05 * frame.right, -6 * DEG, 6 * DEG);
    } else {
      memory.positionCaptured = false;
      const speedError = (aligned ? speedTarget : 0) - frame.forward;
      memory.speedIntegral = clamp(memory.speedIntegral + AUTOPILOT.SPEED_I * speedError * dt, -5 * DEG, 5 * DEG);
      heliPitch = clamp(-(AUTOPILOT.SPEED_P * speedError + memory.speedIntegral), -AUTOPILOT.MAX_PITCH, AUTOPILOT.MAX_PITCH);
      heliBank = clamp(-0.05 * frame.right, -8 * DEG, 8 * DEG);
    }

    // ---- Airplane form: altitude -> flight path -> pitch, speed -> thrust lever, heading -> bank ------------
    const path = clamp((altitudeTarget - position.y) * AUTOPILOT.PATH_PER_METRE, -AUTOPILOT.MAX_PATH, AUTOPILOT.MAX_PATH);
    const currentPath = Math.asin(clamp(data.verticalSpeed / Math.max(data.airspeed, 1), -1, 1));
    const pathError = path - currentPath;
    if (hover > 0.6) memory.pathPitch = data.pitch;
    else memory.pathPitch = clamp(memory.pathPitch + AUTOPILOT.PATH_I * pathError * dt, -AUTOPILOT.MAX_PITCH, AUTOPILOT.MAX_PITCH * 1.5);
    const planePitch = clamp(memory.pathPitch + AUTOPILOT.PATH_P * pathError, -AUTOPILOT.MAX_PITCH, AUTOPILOT.MAX_PITCH * 1.5);
    const leverError = speedTarget - data.airspeed;
    const leverOut = memory.leverIntegral + AUTOPILOT.LEVER_P * leverError;
    if ((leverOut < 1 || leverError < 0) && (leverOut > 0 || leverError > 0)) memory.leverIntegral = clamp(memory.leverIntegral + AUTOPILOT.LEVER_I * leverError * dt, 0, 1);
    const planeLever = clamp(leverOut, 0, 1);
    const turning = smooth01((data.airspeed - AUTOPILOT.TURN_SPEED) / AUTOPILOT.TURN_SPEED);
    const turnBank = clamp(headingError * AUTOPILOT.BANK_PER_HEADING, -AUTOPILOT.MAX_BANK, AUTOPILOT.MAX_BANK);

    const pitchTarget = heliPitch * hover + planePitch * (1 - hover);
    // Slow: hold the drift at zero and turn with the pedals; fast: bank into the turn.
    const bankTarget = heliBank + (turnBank - heliBank) * turning;
    controls.collective = heliCollective * hover + planeLever * (1 - hover);
    if (hover < 0.5) memory.collective = controls.collective;
    else memory.leverIntegral = controls.collective;
    memory.headingTarget = headingTarget * DEG;
    controls.yaw = headingToPedal(memory, data, 0, dt);
    attitudeToStick(memory, data, pitchTarget, bankTarget, dt, attitudeOut);
    controls.pitch = attitudeOut.pitch;
    controls.roll = attitudeOut.roll;
    return true;
  },
});

registerAutopilotHandler('tiltrotor', tiltrotorAutopilot);

// ============================================================================================
// TRIM: an airborne reset in airplane mode starts at the angle of attack for 1 g
// ============================================================================================
const TRIM = Object.freeze({ MIN_SPEED: 30, MAX_AOA: 10 * DEG, MIN_AOA: -4 * DEG });

registerTrimHandler('tiltrotor', Object.freeze({
  /**
   * Keeps the position, the velocity vector and the heading; pitches the body up by the angle of
   * attack at which the wing (flaps as scheduled for the speed) carries the weight the rotors' lift
   * component does not, then resets the model in that attitude. Hover and slow poses stay as reset.
   */
  trim(model, request) {
    const data = model.flightData;
    const velocity = model.state.velocity;
    const wind = request.env && request.env.wind ? request.env.wind.vel : null;
    const airX = velocity.x - (wind ? wind.x : 0);
    const airY = velocity.y - (wind ? wind.y : 0);
    const airZ = velocity.z - (wind ? wind.z : 0);
    const speed = Math.hypot(airX, airY, airZ);
    if (speed < TRIM.MIN_SPEED || data.onGround) return null;
    const profile = model.profile;
    const wing = profile.wing;
    const rho = Number.isFinite(request.env?.rho) ? request.env.rho : 1.225;
    const aspect = (wing.span * wing.span) / wing.area;
    const slope = (2 * Math.PI * aspect) / (2 + Math.sqrt(aspect * aspect + 4));
    const alphaZero = wing.alphaCritical * DEG - wing.clMax / slope;
    const flaps = 1 - smooth01((speed - 72) / 20);
    const rotorLift = data.weight * data.hoverShare * Math.sin(data.nacelle);
    const required = Math.max(0, data.weight - rotorLift) / (0.5 * rho * speed * speed * wing.area);
    const wingAlpha = alphaZero + (required - flaps * (wing.flapCl ?? 0.5)) / slope;
    const aoa = clamp(wingAlpha - wing.incidence * DEG, TRIM.MIN_AOA, TRIM.MAX_AOA);
    const flightPath = Math.asin(clamp(airY / speed, -1, 1));
    const heading = Math.atan2(airX, -airZ);
    return applyTrimPose(model, model.state.quaternion.clone(), heading, flightPath + aoa, speed, aoa, flightPath);
  },
}));

/** Resets the model at its position and velocity with the trimmed pitch attitude; returns the trim result. */
function applyTrimPose(model, quaternion, heading, pitch, speed, aoa, flightPath) {
  const state = model.state;
  const halfYaw = -heading / 2;
  const halfPitch = pitch / 2;
  // Yaw about world up, then pitch about the body's right axis (no roll).
  const cy = Math.cos(halfYaw);
  const sy = Math.sin(halfYaw);
  const cp = Math.cos(halfPitch);
  const sp = Math.sin(halfPitch);
  quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  model.reset({
    position: state.position.clone(),
    quaternion,
    velocity: state.velocity.clone(),
    angularVelocity: state.angularVelocity.clone(),
    throttle: model.flightData.collective,
    onGround: false,
    engineOn: model.flightData.engineMode !== 'off',
  });
  const vne = model.flightData.vne;
  return { aoa, elevator: 0, load: 1, flightPath, bank: 0, speed, stallSpeed: 0, vne, safeSpeed: { min: 0, max: 0.9 * vne }, aoaLimited: false };
}
