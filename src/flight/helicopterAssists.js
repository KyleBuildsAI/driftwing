// Helicopter assists and autopilot: the control laws between the pilot's ControlState and
// SimHelicopter, registered for model kind 'helicopter' with the shared assist stage
// (assists.js: registerAssistCatalog / registerAssistHandler) and the PID autopilot stage
// (autopilot.js: registerAutopilotHandler). Everything flies through the model's controls (cyclic,
// collective, pedals); nothing ever sets the attitude.
//
// Assist levels (settings.assists.helicopter, 0..1; each assist's weight ramps over its range):
//   100 %  auto-hover: hands off the cyclic the helicopter stops and holds its position, and the
//          collective lever becomes a climb / descent command around its centre detent (centred holds
//          the height, touchdowns are cushioned); attitude limits (the cyclic commands pitch and bank
//          up to a limit); heading hold; torque auto-compensation (pedal feed-forward from the torque).
//          Engine off, it holds the rotor rpm with the collective, glides at the best autorotation
//          speed and flares for a cushioned touchdown.
//    50 %  heading hold plus trim / stability augmentation (rate damping, attitude hold hands off)
//     0 %  raw controls
//
// The craft ability "hover hold" (craftState.hoverHold) locks position, height and heading at any
// level; the stick and pedals then move the hold point slowly.
//
// A lever that sits away from the hover setting after a respawn is picked up: the model keeps the
// collective it spawned with until the lever moves, then slews to the lever (no jump).
import { DEG, clamp } from '../core/util.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';

export const HELICOPTER_ASSISTS = Object.freeze([
  Object.freeze({ key: 'stability', name: 'trim and stability augmentation', from: 0, full: 0.5 }),
  Object.freeze({ key: 'headingHold', name: 'heading hold', from: 0, full: 0.5 }),
  Object.freeze({ key: 'attitudeLimits', name: 'attitude limits', from: 0.5, full: 1 }),
  Object.freeze({ key: 'torqueCompensation', name: 'torque auto-compensation', from: 0.5, full: 1 }),
  Object.freeze({ key: 'autoHover', name: 'auto-hover', from: 0.5, full: 1 }),
]);

export const HELI_TUNING = Object.freeze({
  /** Stick inside this is "hands off" for that axis; hands off counts after IDLE_DELAY seconds. */
  IDLE: 0.06,
  IDLE_DELAY: 0.4,
  STABILITY: Object.freeze({ PITCH_DAMPING: 0.5, ROLL_DAMPING: 0.3, HOLD_P: 1.8, HOLD_I: 0.6, TRIM_LIMIT: 0.6 }),
  ATTITUDE: Object.freeze({
    PITCH_LIMIT: 18 * DEG,
    BANK_HOVER: 25 * DEG,
    BANK_CRUISE: 45 * DEG,
    /** Bank limit opens from BANK_HOVER to BANK_CRUISE between these airspeeds (m/s). */
    CRUISE_SPEEDS: Object.freeze([12, 30]),
    PITCH_P: 2.6,
    PITCH_D: 1.1,
    PITCH_I: 0.9,
    ROLL_P: 2.6,
    ROLL_D: 0.75,
    ROLL_I: 0.9,
    INTEGRAL_LIMIT: 0.7,
  }),
  HOVER: Object.freeze({
    /** Attitude (rad) per m/s of velocity error, its integral, and the position loop (m/s per m). */
    VELOCITY_P: 0.045,
    VELOCITY_I: 0.012,
    POSITION_P: 0.3,
    MAX_TILT: 12 * DEG,
    TILT_INTEGRAL_LIMIT: 8 * DEG,
    /** The position is captured once the groundspeed falls below this (m/s). */
    CAPTURE_SPEED: 1.5,
    MAX_RECOVERY_SPEED: 6,
    /** Forward groundspeed (m/s) the auto-hover flies to clear a vortex ring. */
    RING_ESCAPE_SPEED: 12,
  }),
  VERTICAL: Object.freeze({
    DETENT: 0.5,
    DEADBAND: 0.07,
    MAX_CLIMB: 7,
    MAX_DESCENT: 5,
    P: 0.055,
    I: 0.05,
    INTEGRAL_LIMIT: 0.35,
    ALTITUDE_P: 0.5,
    ALTITUDE_RATE: 3,
    /** Near the ground the descent is limited to LAND_BASE + LAND_SLOPE * skid height (m/s). */
    LAND_BASE: 0.35,
    LAND_SLOPE: 0.35,
    /** On the ground with the lever at or below the detent the collective runs down at this rate (1/s). */
    GROUND_RUNDOWN: 0.45,
    /** Engine protection: the collective is held back above this torque or below this rotor rpm. */
    TORQUE_LIMIT: 1,
    RPM_FLOOR: 0.975,
    LIMITER_GAIN: 3,
    LIMITER_RECOVERY: 0.25,
    /** Collective slew in the air and lifting off the ground (share per s). */
    COLLECTIVE_RATE: 1.2,
    GROUND_RATE: 0.6,
    /** At low airspeed the descent is limited to this share of the hover induced velocity. */
    RING_SAFE_SHARE: 0.2,
  }),
  HEADING: Object.freeze({ P: 1.3, I: 0.45, D: 0.7, RATE_P: 0.9, MAX_RATE: 45 * DEG, INTEGRAL_LIMIT: 0.8, COORDINATION_SPEEDS: Object.freeze([14, 24]), SIDESLIP_GAIN: 1.6 }),
  /**
   * Engine-off assist: glide at GLIDE_SPEED holding the rotor rpm with the collective; flare nose-up
   * below FLARE_BASE + FLARE_PER_DESCENT * descent rate (m); level and cushion below LEVEL_AGL.
   */
  AUTOROTATION: Object.freeze({
    RPM_P: 1.2,
    RPM_I: 0.5,
    /** The collective moves at most this fast (1/s) while it holds the rpm. */
    COLLECTIVE_RATE: 0.35,
    GLIDE_SPEED: 28,
    GLIDE_TILT: 8 * DEG,
    FLARE_BASE: 6,
    FLARE_PER_DESCENT: 1.6,
    FLARE_PITCH: 25 * DEG,
    /** Flare pitch (rad): a base plus a gain per m/s of descent above FLARE_DESCENT_PER_METRE x height. */
    FLARE_BASE_PITCH: 6 * DEG,
    FLARE_PITCH_GAIN: 4 * DEG,
    FLARE_DESCENT_PER_METRE: 0.3,
    /** ...and at least FLARE_SPEED_GAIN per m/s of ground speed above FLARE_SPEED_BASE + FLARE_SPEED_PER_METRE x height. */
    FLARE_SPEED_GAIN: 0.6 * DEG,
    FLARE_SPEED_BASE: 5,
    FLARE_SPEED_PER_METRE: 1,
    FLARE_RPM: 1.05,
    LEVEL_AGL: 3.5,
    LEVEL_PITCH: 4 * DEG,
    CUSHION_P: 0.12,
    /** The flare keeps the tail stinger this far (m) above the ground. */
    TAIL_MARGIN: 0.8,
  }),
  HOVER_HOLD: Object.freeze({ STICK_SPEED: 5, LEVER_RATE: 2.5, PEDAL_RATE: 25 * DEG }),
  /**
   * Terrain awareness at full assists: the auto-hover will not set the skids down on a slope steeper
   * than SLOPE_LIMIT or on water (it holds GUARD_HEIGHT above it); the autorotation flare looks
   * LOOKAHEAD_SECONDS ahead along the track for rising ground.
   */
  TERRAIN: Object.freeze({ SLOPE_PROBE: 3, SLOPE_LIMIT: 14 * DEG, GUARD_HEIGHT: 2.5, LOOKAHEAD_SECONDS: Object.freeze([1, 2, 3]) }),
  PICKUP: Object.freeze({ MOVE: 0.03, SLEW: 0.6 }),
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
/** Per-loop memory: integrators, captured targets and the collective pickup. */
export function createLoopMemory() {
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
    cyclicIdle: 0,
    pedalIdle: 0,
    headingTarget: 0,
    headingIntegral: 0,
    tiltIntegralForward: 0,
    tiltIntegralRight: 0,
    positionCaptured: false,
    holdX: 0,
    holdZ: 0,
    hoverActive: false,
    altitudeTarget: 0,
    altitudeCaptured: false,
    verticalIntegral: 0,
    collective: 0.5,
    collectiveCeiling: 1,
    autoCollective: 0.5,
    autoIntegral: 0,
    flaring: false,
    ringEscape: false,
    pickupArmed: true,
    pickupReference: NaN,
    pickupValue: 0.5,
    pickupDone: false,
    hoverHoldActive: false,
    holdLever: 0.5,
    autopilotWasFlying: false,
  };
}

/** Starts every loop from the helicopter's current state (engagement, respawn, hand-back). */
function initializeLoops(memory, data, controls) {
  memory.initialized = true;
  // Airborne, the attitude loops start from the hover trim cyclic (the stick a pilot would hold).
  const trimPitch = data.onGround ? 0 : data.hoverCyclicPitch;
  const trimRoll = data.onGround ? 0 : data.hoverCyclicRoll;
  memory.pitchIntegral = clamp(controls.pitch + trimPitch, -HELI_TUNING.ATTITUDE.INTEGRAL_LIMIT, HELI_TUNING.ATTITUDE.INTEGRAL_LIMIT);
  memory.rollIntegral = clamp(controls.roll + trimRoll, -HELI_TUNING.ATTITUDE.INTEGRAL_LIMIT, HELI_TUNING.ATTITUDE.INTEGRAL_LIMIT);
  memory.trimPitch = trimPitch;
  memory.trimRoll = trimRoll;
  memory.holdPitch = data.pitch;
  memory.holdBank = data.bank;
  memory.holdCaptured = false;
  memory.headingTarget = data.heading * DEG;
  memory.headingIntegral = 0;
  memory.tiltIntegralForward = 0;
  memory.tiltIntegralRight = 0;
  memory.positionCaptured = false;
  memory.hoverActive = false;
  memory.altitudeCaptured = false;
  memory.verticalIntegral = 0;
  memory.collective = data.collective;
  memory.autoCollective = data.collective;
  memory.autoIntegral = 0;
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

/** Bank limit for the airspeed: tighter in the hover, wider in cruise. */
function bankLimit(data) {
  const [low, high] = HELI_TUNING.ATTITUDE.CRUISE_SPEEDS;
  const share = smooth01((data.airspeed - low) / (high - low));
  return HELI_TUNING.ATTITUDE.BANK_HOVER + (HELI_TUNING.ATTITUDE.BANK_CRUISE - HELI_TUNING.ATTITUDE.BANK_HOVER) * share;
}

/** Attitude command / attitude hold: pitch and bank targets (rad) to cyclic, PID with rate damping. */
function attitudeToCyclic(memory, data, pitchTarget, bankTarget, dt, out) {
  const tuning = HELI_TUNING.ATTITUDE;
  const pitchError = pitchTarget - data.pitch;
  const bankError = wrapSignedRadians(bankTarget - data.bank);
  const pitch = memory.pitchIntegral + tuning.PITCH_P * pitchError - tuning.PITCH_D * data.pitchRate;
  const roll = memory.rollIntegral + tuning.ROLL_P * bankError - tuning.ROLL_D * data.rollRate;
  if (!data.onGround) {
    if (Math.abs(pitch) < 1 || pitch * pitchError < 0) memory.pitchIntegral = clamp(memory.pitchIntegral + tuning.PITCH_I * pitchError * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
    if (Math.abs(roll) < 1 || roll * bankError < 0) memory.rollIntegral = clamp(memory.rollIntegral + tuning.ROLL_I * bankError * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
  } else {
    // On the skids the cyclic stays near neutral: the integrators relax.
    memory.pitchIntegral -= memory.pitchIntegral * Math.min(1, dt / 2);
    memory.rollIntegral -= memory.rollIntegral * Math.min(1, dt / 2);
  }
  out.pitch = clamp(pitch, -1, 1);
  out.roll = clamp(roll, -1, 1);
  return out;
}

/**
 * Hover hold: velocity (and, once slow, position) hold in the heading frame -> pitch / bank targets.
 * targetForward / targetRight are commanded groundspeeds (m/s); when both are 0 and the helicopter is
 * slow, the position is captured and held.
 */
function velocityToAttitude(memory, data, position, targetForward, targetRight, dt, out, maxTilt = HELI_TUNING.HOVER.MAX_TILT) {
  const tuning = HELI_TUNING.HOVER;
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
    const forwardError = errorX * Math.sin(heading) - errorZ * Math.cos(heading);
    const rightError = errorX * Math.cos(heading) + errorZ * Math.sin(heading);
    wantForward = clamp(forwardError * tuning.POSITION_P, -tuning.MAX_RECOVERY_SPEED, tuning.MAX_RECOVERY_SPEED);
    wantRight = clamp(rightError * tuning.POSITION_P, -tuning.MAX_RECOVERY_SPEED, tuning.MAX_RECOVERY_SPEED);
  }
  const forwardError = wantForward - frame.forward;
  const rightError = wantRight - frame.right;
  if (!data.onGround) {
    memory.tiltIntegralForward = clamp(memory.tiltIntegralForward + tuning.VELOCITY_I * forwardError * dt, -tuning.TILT_INTEGRAL_LIMIT, tuning.TILT_INTEGRAL_LIMIT);
    memory.tiltIntegralRight = clamp(memory.tiltIntegralRight + tuning.VELOCITY_I * rightError * dt, -tuning.TILT_INTEGRAL_LIMIT, tuning.TILT_INTEGRAL_LIMIT);
  }
  // Forward acceleration needs the nose down (negative pitch); to the right needs right bank.
  out.pitch = clamp(-(tuning.VELOCITY_P * forwardError + memory.tiltIntegralForward), -maxTilt, maxTilt);
  out.bank = clamp(tuning.VELOCITY_P * rightError + memory.tiltIntegralRight, -maxTilt, maxTilt);
  return out;
}
const velocityScratch = { forward: 0, right: 0 };

/**
 * Engine protection: a collective ceiling that closes while the torque is over the limit or the rotor
 * rpm droops below the floor (over-pitching), and reopens slowly once they recover.
 */
function updateCollectiveCeiling(memory, data, dt) {
  const tuning = HELI_TUNING.VERTICAL;
  if (!data.engineRunning) {
    memory.collectiveCeiling = 1;
    return 1;
  }
  const over = Math.max(data.torque - tuning.TORQUE_LIMIT, (tuning.RPM_FLOOR - data.rotorRpm) * 3);
  if (over > 0) memory.collectiveCeiling = Math.min(memory.collectiveCeiling, data.collective + 0.02) - over * tuning.LIMITER_GAIN * dt;
  else memory.collectiveCeiling += tuning.LIMITER_RECOVERY * dt;
  // It never closes below what holds the height (short of a real shortage of power, which then sinks slowly).
  const floor = data.onGround ? 0 : Math.min(data.trimCollective - 0.03, 0.9);
  memory.collectiveCeiling = clamp(memory.collectiveCeiling, Math.max(0, floor), 1);
  return memory.collectiveCeiling;
}

/** Vertical speed command (m/s) -> collective, with the model's trim collective as feed-forward. */
function verticalSpeedToCollective(memory, data, verticalSpeedTarget, dt) {
  const tuning = HELI_TUNING.VERTICAL;
  if (data.onGround && verticalSpeedTarget <= 0.05) {
    // Settled on the skids: run the collective down and forget the integrator.
    memory.verticalIntegral = 0;
    memory.collective = moveToward(memory.collective, 0, tuning.GROUND_RUNDOWN * dt);
    return memory.collective;
  }
  const ceiling = updateCollectiveCeiling(memory, data, dt);
  const error = verticalSpeedTarget - data.verticalSpeed;
  const unclamped = data.trimCollective + tuning.P * error + memory.verticalIntegral;
  if ((unclamped < ceiling || error < 0) && (unclamped > 0 || error > 0)) {
    memory.verticalIntegral = clamp(memory.verticalIntegral + tuning.I * error * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
  }
  // The collective moves smoothly (no yank that droops the rotor), from where it rests on the ground.
  const target = clamp(unclamped, 0, ceiling);
  memory.collective = moveToward(memory.collective, target, (data.onGround ? tuning.GROUND_RATE : tuning.COLLECTIVE_RATE) * dt);
  return memory.collective;
}

/**
 * The ground around the helicopter from the shared height function: the slope under it (rad),
 * whether it is over water, and the skids' height above the highest surface along the track over the
 * next few seconds (m; at most the height above the ground below).
 */
function terrainAround(env, position, data, out) {
  const tuning = HELI_TUNING.TERRAIN;
  const ground = env.groundHeight;
  const water = Number.isFinite(env.waterLevel) ? env.waterLevel : -Infinity;
  const probe = tuning.SLOPE_PROBE;
  const eastWest = ground(position.x + probe, position.z) - ground(position.x - probe, position.z);
  const northSouth = ground(position.x, position.z + probe) - ground(position.x, position.z - probe);
  const here = ground(position.x, position.z);
  out.slope = Math.atan(Math.hypot(eastWest, northSouth) / (2 * probe));
  out.water = here < water;
  const agl = Number.isFinite(data.agl) ? data.agl : Infinity;
  const skids = Math.max(here, water) + agl;
  let ahead = agl;
  const velocity = data.velocity;
  for (const seconds of tuning.LOOKAHEAD_SECONDS) {
    const surface = Math.max(ground(position.x + velocity.x * seconds, position.z + velocity.z * seconds), water);
    ahead = Math.min(ahead, skids - surface);
  }
  out.heightAhead = ahead;
  return out;
}
const terrainScratch = { slope: 0, water: false, heightAhead: Infinity };

/**
 * Descent limit at low airspeed (m/s, negative): the auto-hover never descends into its own wake
 * fast enough to settle into the vortex ring; with airspeed the full descent rate returns.
 */
function ringSafeDescent(data) {
  const tuning = HELI_TUNING.VERTICAL;
  const induced = Math.max(data.hoverInduced, 1);
  const slow = tuning.RING_SAFE_SHARE * induced;
  return -(slow + (tuning.MAX_DESCENT - slow) * smooth01(data.airspeed / (1.5 * induced)));
}

/** Descent limit near the ground (m/s, negative): touchdowns are cushioned. */
function landingDescentLimit(data) {
  const tuning = HELI_TUNING.VERTICAL;
  const height = Number.isFinite(data.agl) ? Math.max(0, data.agl) : Infinity;
  return -(tuning.LAND_BASE + tuning.LAND_SLOPE * height);
}

/** Altitude hold: altitude target (m) -> vertical speed target (m/s). */
function altitudeToVerticalSpeed(target, altitude) {
  const tuning = HELI_TUNING.VERTICAL;
  return clamp((target - altitude) * tuning.ALTITUDE_P, -tuning.ALTITUDE_RATE, tuning.ALTITUDE_RATE);
}

/**
 * Heading hold with the pedals: hold memory.headingTarget (rad) while hands off, a yaw-rate command
 * while the pedals are pushed, turn coordination (sideslip to zero) at speed. feedForward is the
 * torque compensation pedal.
 */
function headingToPedal(memory, data, pedal, feedForward, dt) {
  const tuning = HELI_TUNING.HEADING;
  const heading = data.heading * DEG;
  const [low, high] = tuning.COORDINATION_SPEEDS;
  const coordination = smooth01((data.airspeed - low) / (high - low));
  const idle = Math.abs(pedal) < HELI_TUNING.IDLE;
  let hold;
  if (idle && !data.onGround) {
    const error = wrapSignedRadians(memory.headingTarget - heading);
    hold = tuning.P * error - tuning.D * data.yawRate;
    if (Math.abs(hold + memory.headingIntegral + feedForward) < 1 || hold * error < 0) {
      memory.headingIntegral = clamp(memory.headingIntegral + tuning.I * error * dt, -tuning.INTEGRAL_LIMIT, tuning.INTEGRAL_LIMIT);
    }
  } else {
    // A pushed pedal commands a yaw rate; the target follows the nose.
    memory.headingTarget = heading;
    hold = tuning.RATE_P * (pedal * tuning.MAX_RATE - data.yawRate);
  }
  const hover = feedForward + memory.headingIntegral + hold;
  // At speed the pedals keep the ball centred (sideslip to zero); the heading follows the turn.
  const coordinated = feedForward + memory.headingIntegral * 0.5 + pedal + tuning.SIDESLIP_GAIN * data.sideslip;
  if (coordination > 0.5) memory.headingTarget = heading;
  if (data.onGround) memory.headingTarget = heading;
  return clamp(hover + (coordinated - hover) * coordination, -1, 1);
}

/** Collective lever -> vertical speed command around the centre detent (m/s). */
function leverToVerticalSpeed(lever) {
  const tuning = HELI_TUNING.VERTICAL;
  const offset = lever - tuning.DETENT;
  if (Math.abs(offset) <= tuning.DEADBAND) return 0;
  const span = 1 - tuning.DETENT - tuning.DEADBAND;
  if (offset > 0) return ((offset - tuning.DEADBAND) / span) * tuning.MAX_CLIMB;
  return ((offset + tuning.DEADBAND) / span) * tuning.MAX_DESCENT;
}

/**
 * The collective pickup: after a respawn the lever may sit anywhere. Until it moves, the collective
 * stays where the model spawned it; then it slews to the lever. Returns the effective lever.
 */
function pickupLever(memory, lever, data, dt) {
  const tuning = HELI_TUNING.PICKUP;
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
const attitudeOut = { pitch: 0, roll: 0 };
const tiltOut = { pitch: 0, bank: 0 };

/**
 * Engine off at full assists, three phases: glide at the best autorotation speed with the rotor rpm
 * held by the collective; the flare (nose up) turns the forward speed into rotor thrust and rpm; then
 * level the skids and cushion the touchdown with the rotor's stored energy.
 */
function autorotationAssist(memory, data, position, dt, cyclicIdle, controls, out, env) {
  const tuning = HELI_TUNING.AUTOROTATION;
  // Height for the flare: the lower of the height above the ground here and the ground ahead.
  const height = terrainAround(env, position, data, terrainScratch).heightAhead;
  const descent = Math.max(0, -data.verticalSpeed);
  const flareHeight = tuning.FLARE_BASE + tuning.FLARE_PER_DESCENT * descent;
  const levelling = height < tuning.LEVEL_AGL || data.onGround;
  // The flare latches once started (it slows the descent, which would otherwise lower the gate).
  if (!memory.flaring && height < flareHeight) memory.flaring = true;
  else if (memory.flaring && height > flareHeight + 25) memory.flaring = false;
  const flaring = !levelling && memory.flaring;
  const rpmTarget = flaring ? tuning.FLARE_RPM : 1;
  const rpmError = data.rotorRpm - rpmTarget;
  memory.autoIntegral = clamp(memory.autoIntegral + tuning.RPM_I * rpmError * dt, -0.6, 0.6);
  let collective = moveToward(memory.collective, clamp(0.2 + memory.autoIntegral + tuning.RPM_P * rpmError, 0, 1), tuning.COLLECTIVE_RATE * dt);
  if (levelling) {
    // Cushion: trade the rotor's stored energy for a soft touchdown.
    const cushionTarget = landingDescentLimit(data);
    collective = Math.max(collective, clamp(data.trimCollective + tuning.CUSHION_P * (cushionTarget - data.verticalSpeed), 0, 1));
    if (data.onGround) collective = moveToward(memory.collective, 0, HELI_TUNING.VERTICAL.GROUND_RUNDOWN * dt);
  }
  memory.collective = collective;
  let pitchTarget;
  let bankTarget = 0;
  if (!cyclicIdle) {
    pitchTarget = controls.pitch * HELI_TUNING.ATTITUDE.PITCH_LIMIT;
    bankTarget = controls.roll * bankLimit(data);
  } else if (levelling) {
    // On the skids the cyclic stays neutral; just above them the skids come level.
    pitchTarget = data.onGround ? data.pitch : tuning.LEVEL_PITCH;
    bankTarget = data.onGround ? data.bank : 0;
  } else if (flaring) {
    // The nose comes up as far as it takes to bring the descent down with the height (no balloon),
    // and eases as the forward speed runs out.
    const descentTarget = tuning.FLARE_DESCENT_PER_METRE * height;
    const speedTarget = tuning.FLARE_SPEED_BASE + tuning.FLARE_SPEED_PER_METRE * height;
    const flare = tuning.FLARE_BASE_PITCH + Math.max(tuning.FLARE_PITCH_GAIN * (descent - descentTarget), tuning.FLARE_SPEED_GAIN * (data.groundSpeed - speedTarget));
    pitchTarget = clamp(flare, 0, tuning.FLARE_PITCH) * smooth01(data.groundSpeed / 8);
    memory.positionCaptured = false;
  } else {
    velocityToAttitude(memory, data, position, tuning.GLIDE_SPEED, 0, dt, tiltOut, tuning.GLIDE_TILT);
    pitchTarget = tiltOut.pitch;
    bankTarget = tiltOut.bank;
  }
  // Near the ground the nose may only come up as far as the tail stinger clears the surface.
  if (cyclicIdle && data.tailArm > 0) {
    const clearance = (Math.max(0, height) + data.tailHeight - tuning.TAIL_MARGIN) / data.tailArm;
    pitchTarget = Math.min(pitchTarget, Math.asin(clamp(clearance, 0, 0.7)));
  }
  attitudeToCyclic(memory, data, pitchTarget, bankTarget, dt, attitudeOut);
  out.pitch = attitudeOut.pitch;
  out.roll = attitudeOut.roll;
  out.collective = collective;
}

const autorotationOut = { pitch: 0, roll: 0, collective: 0 };

/** The locked hover of the craft ability: the stick and pedals move the hold point slowly. */
function hoverHoldAssist(memory, data, position, controls, lever, dt) {
  const tuning = HELI_TUNING.HOVER_HOLD;
  if (!memory.hoverHoldActive) {
    memory.hoverHoldActive = true;
    memory.holdLever = lever;
    memory.altitudeTarget = position.y;
    memory.altitudeCaptured = true;
    memory.headingTarget = data.heading * DEG;
    memory.positionCaptured = false;
  }
  const forward = -controls.pitch * tuning.STICK_SPEED;
  const right = controls.roll * tuning.STICK_SPEED;
  velocityToAttitude(memory, data, position, Math.abs(forward) > 0.3 ? forward : 0, Math.abs(right) > 0.3 ? right : 0, dt, tiltOut);
  attitudeToCyclic(memory, data, tiltOut.pitch, tiltOut.bank, dt, attitudeOut);
  const leverOffset = lever - memory.holdLever;
  if (Math.abs(leverOffset) > 0.05) memory.altitudeTarget += clamp(leverOffset * 10, -1, 1) * tuning.LEVER_RATE * dt;
  const verticalTarget = Math.max(altitudeToVerticalSpeed(memory.altitudeTarget, position.y), landingDescentLimit(data));
  controls.collective = verticalSpeedToCollective(memory, data, verticalTarget, dt);
  if (Math.abs(controls.yaw) > HELI_TUNING.IDLE) memory.headingTarget += controls.yaw * tuning.PEDAL_RATE * dt;
  const heading = data.heading * DEG;
  const error = wrapSignedRadians(memory.headingTarget - heading);
  memory.headingIntegral = clamp(memory.headingIntegral + HELI_TUNING.HEADING.I * error * dt, -HELI_TUNING.HEADING.INTEGRAL_LIMIT, HELI_TUNING.HEADING.INTEGRAL_LIMIT);
  controls.yaw = clamp(data.antiTorquePedal + memory.headingIntegral + HELI_TUNING.HEADING.P * error - HELI_TUNING.HEADING.D * data.yawRate, -1, 1);
  controls.pitch = attitudeOut.pitch;
  controls.roll = attitudeOut.roll;
}

const helicopterAssistHandler = Object.freeze({
  createMemory: createLoopMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const position = model.state.position;
    const craftState = context.env && context.env.craftState ? context.env.craftState : {};
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    if (!memory.initialized) initializeLoops(memory, data, controls);

    const rawLever = clamp(Number.isFinite(controls.collective) ? controls.collective : 0.5, 0, 1);
    const lever = pickupLever(memory, rawLever, data, dt);
    if (autopilotFlying) {
      // The autopilot stage already flies every control; hand back smoothly when it lets go.
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
    if (craftState.hoverHold && data.engineRunning) {
      hoverHoldAssist(memory, data, position, controls, lever, dt);
      return;
    }
    memory.hoverHoldActive = false;

    const stability = weights.stability ?? 0;
    const headingWeight = weights.headingHold ?? 0;
    const limits = weights.attitudeLimits ?? 0;
    const torque = weights.torqueCompensation ?? 0;
    const hover = weights.autoHover ?? 0;
    const tuning = HELI_TUNING;

    const cyclicIdleNow = Math.abs(controls.pitch) < tuning.IDLE && Math.abs(controls.roll) < tuning.IDLE;
    memory.cyclicIdle = cyclicIdleNow ? memory.cyclicIdle + dt : 0;
    const cyclicIdle = memory.cyclicIdle >= tuning.IDLE_DELAY;

    // ---- Engine off at full assists: autorotation assist ----------------------------------------------
    if (!data.engineRunning && hover > 0 && (!data.onGround || data.rotorRpm > 0.3)) {
      autorotationAssist(memory, data, position, dt, cyclicIdle, controls, autorotationOut, context.env);
      controls.pitch = clamp(controls.pitch + (autorotationOut.pitch - controls.pitch) * hover, -1, 1);
      controls.roll = clamp(controls.roll + (autorotationOut.roll - controls.roll) * hover, -1, 1);
      controls.collective = lever + (autorotationOut.collective - lever) * hover;
      if (headingWeight > 0) controls.yaw = controls.yaw + (headingToPedal(memory, data, controls.yaw, 0, dt) - controls.yaw) * headingWeight;
      return;
    }

    // ---- Cyclic: raw -> trim / stability augmentation -> attitude command with hover hold ------------------
    let pitch = controls.pitch;
    let roll = controls.roll;
    if (stability > 0) {
      const sas = tuning.STABILITY;
      if (cyclicIdle && !data.onGround) {
        if (!memory.holdCaptured) {
          memory.holdCaptured = true;
          memory.holdPitch = data.pitch;
          memory.holdBank = Math.abs(data.bank) < 5 * DEG ? 0 : data.bank;
        }
        const pitchError = memory.holdPitch - data.pitch;
        const bankError = wrapSignedRadians(memory.holdBank - data.bank);
        memory.trimPitch = clamp(memory.trimPitch + sas.HOLD_I * pitchError * dt, -sas.TRIM_LIMIT, sas.TRIM_LIMIT);
        memory.trimRoll = clamp(memory.trimRoll + sas.HOLD_I * bankError * dt, -sas.TRIM_LIMIT, sas.TRIM_LIMIT);
        pitch += sas.HOLD_P * pitchError;
        roll += sas.HOLD_P * bankError;
      } else {
        memory.holdCaptured = false;
      }
      const assisted = clamp(pitch + memory.trimPitch - sas.PITCH_DAMPING * data.pitchRate, -1, 1);
      const assistedRoll = clamp(roll + memory.trimRoll - sas.ROLL_DAMPING * data.rollRate, -1, 1);
      pitch = controls.pitch + (assisted - controls.pitch) * stability;
      roll = controls.roll + (assistedRoll - controls.roll) * stability;
    }
    if (limits > 0) {
      let pitchTarget;
      let bankTarget;
      if (cyclicIdle && hover > 0) {
        // Hands off: hover. Caught in the vortex ring, fly forward out of it first.
        if (data.vortexRing > 0.5) memory.ringEscape = true;
        else if (data.vortexRing < 0.05) memory.ringEscape = false;
        velocityToAttitude(memory, data, position, memory.ringEscape ? tuning.HOVER.RING_ESCAPE_SPEED : 0, 0, dt, tiltOut);
        memory.hoverActive = true;
        pitchTarget = tiltOut.pitch * hover;
        bankTarget = tiltOut.bank * hover;
      } else {
        if (memory.hoverActive) {
          memory.hoverActive = false;
          memory.positionCaptured = false;
        }
        // Hands on: the stick commands pitch and bank; the velocity integrators follow the attitude.
        pitchTarget = controls.pitch * tuning.ATTITUDE.PITCH_LIMIT;
        bankTarget = controls.roll * bankLimit(data);
        memory.tiltIntegralForward = clamp(-data.pitch, -tuning.HOVER.TILT_INTEGRAL_LIMIT, tuning.HOVER.TILT_INTEGRAL_LIMIT);
        memory.tiltIntegralRight = clamp(data.bank, -tuning.HOVER.TILT_INTEGRAL_LIMIT, tuning.HOVER.TILT_INTEGRAL_LIMIT);
      }
      attitudeToCyclic(memory, data, pitchTarget, bankTarget, dt, attitudeOut);
      pitch += (attitudeOut.pitch - pitch) * limits;
      roll += (attitudeOut.roll - roll) * limits;
    } else {
      memory.pitchIntegral = clamp(pitch, -tuning.ATTITUDE.INTEGRAL_LIMIT, tuning.ATTITUDE.INTEGRAL_LIMIT);
      memory.rollIntegral = clamp(roll, -tuning.ATTITUDE.INTEGRAL_LIMIT, tuning.ATTITUDE.INTEGRAL_LIMIT);
    }
    controls.pitch = clamp(pitch, -1, 1);
    controls.roll = clamp(roll, -1, 1);

    // ---- Collective: the lever, or a vertical speed command around the detent (auto-hover) ---------------
    if (hover > 0) {
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
      verticalTarget = Math.max(verticalTarget, landingDescentLimit(data), ringSafeDescent(data));
      // No touchdown on a steep slope or on water: hold a low hover above it instead.
      const guard = tuning.TERRAIN.GUARD_HEIGHT;
      if (!data.onGround && data.agl < guard + 2) {
        const terrain = terrainAround(context.env, position, data, terrainScratch);
        if (terrain.water || terrain.slope > tuning.TERRAIN.SLOPE_LIMIT) verticalTarget = Math.max(verticalTarget, (guard - data.agl) * 0.8);
      }
      const collective = verticalSpeedToCollective(memory, data, verticalTarget, dt);
      controls.collective = lever + (collective - lever) * hover;
    } else {
      controls.collective = lever;
      memory.collective = lever;
      memory.verticalIntegral = 0;
      memory.altitudeCaptured = false;
    }

    // ---- Pedals: heading hold with torque feed-forward -------------------------------------------------------
    if (headingWeight > 0 || torque > 0) {
      const feedForward = torque * data.antiTorquePedal;
      const held = headingToPedal(memory, data, controls.yaw, feedForward, dt);
      controls.yaw = clamp(controls.yaw + feedForward * (1 - headingWeight) + (held - controls.yaw - feedForward * (1 - headingWeight)) * headingWeight, -1, 1);
    } else {
      memory.headingTarget = data.heading * DEG;
      memory.headingIntegral = 0;
    }
  },
});

registerAssistCatalog('helicopter', HELICOPTER_ASSISTS);
registerAssistHandler('helicopter', helicopterAssistHandler);

// ============================================================================================
// AUTOPILOT: heading, altitude and speed hold through the cyclic, collective and pedals
// ============================================================================================
const AUTOPILOT = Object.freeze({
  /** Hover below this commanded speed; cruise at the commanded speed otherwise (m/s). */
  HOVER_SPEED: 3,
  MAX_SPEED_SHARE: 0.8,
  SPEED_P: 0.03,
  SPEED_I: 0.006,
  MAX_PITCH: 12 * DEG,
  BANK_PER_HEADING: 1.1,
  MAX_BANK: 25 * DEG,
  /** Below this airspeed the pedals turn the nose; above it the helicopter banks into turns. */
  TURN_SPEED: 16,
  /** Accelerate only once the nose points within this of the target heading. */
  ALIGN_ANGLE: 35 * DEG,
  CLIMB_PER_METRE: 0.25,
  MAX_CLIMB: 5,
  MAX_DESCENT: 4,
  LOOKAHEAD: Object.freeze([0, 150, 300, 600, 1000, 1500]),
  LOOKAHEAD_REFRESH: 0.5,
  CLEARANCE: 70,
});

function createAutopilotMemory() {
  return { ...createLoopMemory(), engaged: false, speedIntegral: 0, lookaheadAge: Infinity, terrainFloor: -Infinity };
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
    const surface = Math.max(world.groundHeight(position.x + directionX * distance, position.z + directionZ * distance), env.waterLevel);
    floor = Math.max(floor, surface + AUTOPILOT.CLEARANCE);
  }
  memory.terrainFloor = floor;
}

const helicopterAutopilot = Object.freeze({
  createMemory: createAutopilotMemory,

  apply(controls, context, memory) {
    const autopilot = context.autopilot;
    if (!autopilot || !autopilot.enabled) {
      memory.engaged = false;
      return false;
    }
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    const position = model.state.position;
    const env = context.env;
    if (!memory.engaged) {
      memory.engaged = true;
      initializeLoops(memory, data, controls);
      memory.speedIntegral = 0;
      memory.lookaheadAge = Infinity;
    }
    const vne = Number.isFinite(data.vne) ? data.vne : 70;
    const commanded = Number.isFinite(autopilot.speed) ? autopilot.speed : 0;
    const hovering = context.handsOff || commanded < AUTOPILOT.HOVER_SPEED;
    const speedTarget = hovering ? 0 : clamp(commanded, 0, vne * AUTOPILOT.MAX_SPEED_SHARE);
    const headingTarget = Number.isFinite(autopilot.heading) ? autopilot.heading : data.heading;
    refreshTerrainFloor(memory, env, position, headingTarget, dt);
    const altitudeTarget = Math.max(Number.isFinite(autopilot.altitude) ? autopilot.altitude : position.y, memory.terrainFloor);

    // ---- Collective: altitude -> vertical speed -> collective ------------------------------------------------
    const verticalTarget = Math.max(clamp((altitudeTarget - position.y) * AUTOPILOT.CLIMB_PER_METRE, -AUTOPILOT.MAX_DESCENT, AUTOPILOT.MAX_CLIMB), landingDescentLimit(data));
    controls.collective = data.engineRunning ? verticalSpeedToCollective(memory, data, verticalTarget, dt) : controls.collective;

    // ---- Cyclic and pedals ---------------------------------------------------------------------------------------
    const headingError = wrapSignedRadians((headingTarget - data.heading) * DEG);
    let pitchTarget;
    let bankTarget;
    if (hovering) {
      velocityToAttitude(memory, data, position, 0, 0, dt, tiltOut);
      pitchTarget = tiltOut.pitch;
      bankTarget = tiltOut.bank;
      memory.headingTarget = headingTarget * DEG;
      controls.yaw = headingToPedal(memory, data, 0, data.antiTorquePedal, dt);
    } else {
      const frame = headingFrameVelocity(data, velocityScratch);
      const aligned = Math.abs(headingError) < AUTOPILOT.ALIGN_ANGLE || data.airspeed > AUTOPILOT.TURN_SPEED;
      const forwardTarget = aligned ? speedTarget : 0;
      const speedError = forwardTarget - frame.forward;
      memory.speedIntegral = clamp(memory.speedIntegral + AUTOPILOT.SPEED_I * speedError * dt, -6 * DEG, 6 * DEG);
      pitchTarget = clamp(-(AUTOPILOT.SPEED_P * speedError + memory.speedIntegral), -AUTOPILOT.MAX_PITCH, AUTOPILOT.MAX_PITCH);
      const turning = smooth01((data.airspeed - AUTOPILOT.TURN_SPEED * 0.6) / (AUTOPILOT.TURN_SPEED * 0.6));
      const turnBank = clamp(headingError * AUTOPILOT.BANK_PER_HEADING, -AUTOPILOT.MAX_BANK, AUTOPILOT.MAX_BANK);
      // Slow: keep the lateral drift at zero and turn with the pedals; fast: bank into the turn.
      const driftBank = clamp(-0.05 * frame.right, -8 * DEG, 8 * DEG);
      bankTarget = turnBank * turning + driftBank * (1 - turning);
      memory.headingTarget = headingTarget * DEG;
      controls.yaw = headingToPedal(memory, data, 0, data.antiTorquePedal, dt);
    }
    attitudeToCyclic(memory, data, pitchTarget, bankTarget, dt, attitudeOut);
    controls.pitch = attitudeOut.pitch;
    controls.roll = attitudeOut.roll;
    return true;
  },
});

registerAutopilotHandler('helicopter', helicopterAutopilot);
