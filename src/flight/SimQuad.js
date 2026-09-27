// SimQuad: the SIM flight model for multirotors (the FPV racing quad).
//
// A 6-DOF rigid body in SI units: centre-of-mass position and velocity (world), attitude quaternion
// (body to world) and body angular velocity, integrated semi-implicitly at the controller's fixed
// 120 Hz. The craft's flight-controller firmware lives inside the model, as it does on a real quad:
//
//   motors        four brushless motors with first-order spool dynamics (faster up than down). Thrust
//                 grows with the square of motor speed along the body up axis and falls with axial
//                 inflow (climbing, fast forward flight at steep tilt). Descending into the rotors' own
//                 wake (prop wash) costs thrust and shakes the frame. Each prop's drag torque yaws the
//                 frame the other way, so yaw comes from speeding up one diagonal pair and slowing the
//                 other (weaker than roll and pitch, as on a real quad).
//   aero          body drag with its own area along each body axis (at the steep forward tilt of full
//                 speed the air meets the flat top of the quad, which limits top speed), rotor in-plane
//                 drag (H-force) and a little rotational damping.
//   controller    Betaflight-style: sticks -> rate setpoints (RC rate, super rate, expo) in rate (acro)
//                 mode, or sticks -> tilt angles (self-levelling, limited tilt) in angle mode; a rate PID
//                 with feed-forward on each axis; a thrust mixer with airmode (full authority at zero
//                 throttle in the air); altitude hold in angle mode, where the throttle becomes a climb
//                 rate command around a centred deadband. In acro the throttle is thrust, nothing more:
//                 a centred stick climbs hard.
//   ground        feet (gear) and body points against the shared height function (groundContact.js):
//                 the quad bounces off light touches, landing on its feet is fine, a hard hit
//                 soft-crashes (limits.crashSinkRate, limits.bodyStrikeSpeed), and turtle mode (the
//                 motors on one side run reversed) flips it back over when it lands upside down.
//
// The flight mode comes from craftState.droneMode ('rate' | 'angle') and craftState.altitudeHold,
// which the quad assist handler (registered below) sets from the assist level and the craft ability.
// The quad autopilot handler flies through the same sticks: angle mode, altitude hold, yaw rate.
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (mesh animation), flightData
// (read by the assist and autopilot stages), craftState and dispose().
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, smoothstep } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';

const MAX_ANGULAR_SPEED = 35;
const MAX_SPEED = 120;
const LOAD_SMOOTHING = 25;
/** Betaflight's RC rate increment above an RC rate of 2. */
const RC_RATE_INCREMENTAL = 14.54;
/** A prop spinning backwards (turtle mode) makes only this share of its forward thrust. */
const REVERSE_EFFICIENCY = 0.6;
/** Turtle mode ends once the frame has rolled this far toward upright (world up in body y). */
const TURTLE_DONE_UP = 0.6;
/** Turtle mode gives up once the frame is this high above the ground (centre of mass, m). */
const TURTLE_MAX_AGL = 0.6;
/** After turtle mode, altitude hold aims this far below standing height (m) so the quad sets down. */
const TURTLE_SETTLE_DEPTH = 0.3;
/** Upside down on the ground: body up pointing below this. */
const INVERTED_UP = -0.3;
/** Altitude hold counts the quad as landed after resting this long (s) slower than LANDED_SPEED (m/s). */
const LANDED_SECONDS = 0.25;
const LANDED_SPEED = 0.6;
/** The throttle below which the quad counts as idling on the ground (airmode and I-term held off). */
const GROUND_IDLE_THROTTLE = 0.08;
/**
 * Ground-contact substeps: near the ground (within the craft's reach plus a tick of travel and MARGIN
 * m) a tick is split so no contact point moves more than TRAVEL m per substep, at most MAX substeps.
 */
const CONTACT_SUBSTEPS = Object.freeze({ TRAVEL: 0.006, MAX: 8, MARGIN: 0.3 });
/** Mesh prop animation: visual prop speed (rad/s) at full motor speed. */
export const QUAD_VISUAL_PROP_SPEED = 30;

/** Default rates: RC rate 1, super rate 0.7015, expo 0.3 -> 670 deg/s at full stick. */
export const DEFAULT_QUAD_RATES = Object.freeze({ rcRate: 1, superRate: 0.7015, expo: 0.3 });

/** Smooth deterministic noise in about [-1, 1] (prop wash and turbulence moments). */
function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function resolveRates(rates) {
  const source = rates && typeof rates === 'object' ? rates : DEFAULT_QUAD_RATES;
  return {
    rcRate: Number.isFinite(source.rcRate) ? source.rcRate : DEFAULT_QUAD_RATES.rcRate,
    superRate: Number.isFinite(source.superRate) ? clamp(source.superRate, 0, 0.99) : DEFAULT_QUAD_RATES.superRate,
    expo: Number.isFinite(source.expo) ? clamp(source.expo, 0, 1) : DEFAULT_QUAD_RATES.expo,
  };
}

/**
 * Betaflight rates: the rate setpoint (deg/s, signed) for a stick deflection (-1..1). rates:
 * { rcRate, superRate (0..0.99), expo (0..1) }, Betaflight's values divided by 100.
 */
export function betaflightRate(stick, rates = DEFAULT_QUAD_RATES) {
  const command = clamp(Number.isFinite(stick) ? stick : 0, -1, 1);
  const magnitude = Math.abs(command);
  const shaped = command * magnitude * magnitude * magnitude * rates.expo + command * (1 - rates.expo);
  const rcRate = rates.rcRate > 2 ? rates.rcRate + RC_RATE_INCREMENTAL * (rates.rcRate - 2) : rates.rcRate;
  let rate = 200 * rcRate * shaped;
  if (rates.superRate > 0) rate /= clamp(1 - magnitude * rates.superRate, 0.01, 1);
  return rate;
}

/** The rate at full stick (deg/s). */
export function maxRate(rates = DEFAULT_QUAD_RATES) {
  return betaflightRate(1, rates);
}

/** The stick deflection (-1..1) that asks for `rate` deg/s (inverse of betaflightRate, by bisection). */
export function stickForRate(rate, rates = DEFAULT_QUAD_RATES) {
  const wanted = Math.abs(Number.isFinite(rate) ? rate : 0);
  if (wanted >= maxRate(rates)) return Math.sign(rate);
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 30; iteration++) {
    const middle = (low + high) / 2;
    if (betaflightRate(middle, rates) < wanted) low = middle;
    else high = middle;
  }
  return Math.sign(rate) * (low + high) / 2;
}

/**
 * Altitude-hold throttle mapping: the throttle stick around its centre (inside the deadband) holds
 * the altitude; above it climbs up to maxClimb at full throttle, below it descends up to maxDescent
 * at zero. Returns the climb rate (m/s) a stick position asks for (0 inside the deadband).
 */
export function climbForThrottle(throttle, hold) {
  const lever = clamp(Number.isFinite(throttle) ? throttle : 0.5, 0, 1);
  const upper = 0.5 + hold.deadband;
  const lower = 0.5 - hold.deadband;
  if (lever > upper) return ((lever - upper) / (1 - upper)) * hold.maxClimb;
  if (lever < lower) return -((lower - lever) / lower) * hold.maxDescent;
  return 0;
}

/** The throttle stick position that asks altitude hold for `climb` m/s (inverse of climbForThrottle). */
export function throttleForClimb(climb, hold) {
  const upper = 0.5 + hold.deadband;
  const lower = 0.5 - hold.deadband;
  if (climb > 1e-3) return upper + (1 - upper) * clamp(climb / hold.maxClimb, 0, 1) + 1e-4;
  if (climb < -1e-3) return lower - lower * clamp(-climb / hold.maxDescent, 0, 1) - 1e-4;
  return 0.5;
}

/** Motor layout and derived mixer constants from a simProfile (body axes, relative to the CG). */
function buildFrame(profile) {
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass ?? [0, 0, 0]);
  const motorProfile = profile.motor;
  const maxThrust = (profile.mass * GRAVITY * profile.thrustToWeight) / profile.motors.length;
  const motors = profile.motors.map((definition) => {
    const position = new THREE.Vector3().fromArray(definition.position).sub(centerOfMass);
    return {
      id: definition.id,
      position,
      /** CW props (seen from above) push the frame nose left (+y moment), CCW nose right. */
      spin: definition.spin === 'ccw' ? -1 : 1,
      side: position.x >= 0 ? 1 : -1,
      front: position.z <= 0 ? 1 : -1,
    };
  });
  const sumX2 = motors.reduce((sum, motor) => sum + motor.position.x * motor.position.x, 0);
  const sumZ2 = motors.reduce((sum, motor) => sum + motor.position.z * motor.position.z, 0);
  const propRadius = motorProfile.propDiameter / 2;
  const discArea = Math.PI * propRadius * propRadius;
  const hoverThrust = (profile.mass * GRAVITY) / motors.length;
  const lowestFoot = profile.contacts.filter((point) => point.gear).reduce((lowest, point) => Math.min(lowest, point.position[1]), Infinity);
  return {
    centerOfMass,
    /** Height of the centre of mass above flat ground when the quad stands on its feet (m). */
    restHeight: centerOfMass.y - (Number.isFinite(lowestFoot) ? lowestFoot : 0),
    motors,
    maxThrust,
    sumX2,
    sumZ2,
    discArea,
    /** Induced velocity through one prop at hover (m/s): the scale of prop wash. */
    hoverInflow: Math.sqrt(hoverThrust / (2 * SEA_LEVEL_DENSITY * discArea)),
    hoverThrust,
    /** Motor speed (0..1) that hovers at sea level, and the throttle stick that gives it. */
    hoverSpeed: Math.sqrt(1 / profile.thrustToWeight),
    hoverThrottle: (Math.sqrt(1 / profile.thrustToWeight) - motorProfile.idle) / (1 - motorProfile.idle),
    /** Axial inflow speed (m/s) at which a prop at full speed stops making thrust (pitch speed). */
    pitchSpeed: motorProfile.pitchSpeed,
  };
}

export function createSimQuadModel({ profile, craft, bus, craftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'craft';
  const craftName = craft && craft.name ? craft.name : 'craft';
  const inputProfile = (craft && craft.inputProfile) || {};
  const rateProfile = inputProfile.rates || {};
  const rates = {
    roll: resolveRates(rateProfile.roll ?? rateProfile),
    pitch: resolveRates(rateProfile.pitch ?? rateProfile),
    yaw: resolveRates(rateProfile.yaw ?? rateProfile),
  };
  const frame = buildFrame(profile);
  const motorProfile = profile.motor;
  const aero = profile.aero;
  const controller = profile.controller;
  const hold = controller.altitudeHold;
  const mass = profile.mass;
  const idle = motorProfile.idle;
  const inertia = new THREE.Vector3(profile.inertia.pitch, profile.inertia.yaw, profile.inertia.roll);
  const dragArea = new THREE.Vector3().fromArray(aero.dragArea);
  const damping = new THREE.Vector3().fromArray(aero.rotationalDamping);
  const angleLimit = controller.angleLimit * DEG;
  const angleRateLimit = controller.angleRateLimit * DEG;
  const vne = Number.isFinite(limits.vne) ? limits.vne : 45;

  // ---- Rigid-body state (centre of mass) --------------------------------------------------------------
  const centerPosition = new THREE.Vector3();
  const state = {
    /** Mesh origin (world): the centre of mass minus the rotated centre-of-mass offset. */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x nose up, y nose left, z right side up. */
    angularVelocity: new THREE.Vector3(),
  };

  const contact = createGroundContact(profile.contacts, { centerOfMass: frame.centerOfMass, floats: limits.floats === true, mass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  /**
   * Contact report the controller reads (FlightModel.contact): the substeps of a tick merged into one
   * (any contact, the first touchdown, the fastest strike, the deepest penetration).
   */
  const contactReport = { onGround: false, touchdown: null, bodyStrike: null, water: false, penetration: 0, contacts: 0, gearContacts: 0, wheelSpeed: 0 };
  const mergedTouchdown = { sinkRate: 0, part: '', groundSpeed: 0 };
  const mergedStrike = { part: '', speed: 0 };

  // ---- Flight controller and motors --------------------------------------------------------------------
  const motorSpeeds = frame.motors.map(() => 0);
  const motorCommands = frame.motors.map(() => 0);
  const motorThrusts = frame.motors.map(() => 0);
  const pid = {
    integral: new THREE.Vector3(),
    previousRate: new THREE.Vector3(),
    previousSetpoint: new THREE.Vector3(),
    setpointLowPass: new THREE.Vector3(),
    primed: false,
  };
  const altitude = { engaged: false, target: 0, integral: 0, latched: false, latchValue: 0.5, landed: false, guided: false, groundSeconds: 0 };
  const systems = {
    armed: true,
    throttle: 0,
    /** Motor command the throttle (or altitude hold) asks of every motor before mixing (0..1). */
    baseCommand: 0,
    mode: 'rate',
    holding: false,
    airmode: false,
    propWash: 0,
    inflowFactor: 1,
    turtle: false,
    turtleSide: 1,
    /** Set on the tick turtle mode ends: altitude hold sets the quad down instead of holding its hop. */
    turtleEnded: false,
    upsideDownNoticed: false,
  };
  let time = 0;
  let resetCount = 0;
  let smoothedLoad = 1;

  /** Mesh animation: orthogonal motor-speed patterns (see writeSurfaces) and the mean visual prop speed. */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  // ---- Live flight data (control stages and telemetry read it; SI, radians) ---------------------------
  const flightData = {
    airspeed: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    bank: 0,
    pitch: 0,
    heading: 0,
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    gLoad: 1,
    onGround: false,
    agl: Infinity,
    upright: 1,
    throttle: 0,
    thrust: 0,
    motorSpeed: 0,
    armed: true,
    mode: 'rate',
    altitudeHold: false,
    propWash: 0,
    hoverThrottle: frame.hoverThrottle,
    maxThrust: frame.maxThrust * frame.motors.length,
    angleLimit,
    mass,
    vne,
    rates,
    altitudeHoldTuning: hold,
    resetCount: 0,
  };

  // ---- Scratch -------------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const bodyAir = new THREE.Vector3();
  const worldUpBody = new THREE.Vector3();
  const desiredUp = new THREE.Vector3();
  const levelAxis = new THREE.Vector3();
  const setpoint = new THREE.Vector3();
  const rateError = new THREE.Vector3();
  const angularCommand = new THREE.Vector3();
  const torqueCommand = new THREE.Vector3();
  const forceBody = new THREE.Vector3();
  const momentBody = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const totalMoment = new THREE.Vector3();
  const lever = new THREE.Vector3();
  const pointForce = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const angularAcceleration = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const bodyAxis = new THREE.Vector3();
  const originOffset = new THREE.Vector3();
  const nonGravity = new THREE.Vector3();
  /** Mixer scratch per motor (N): roll + pitch share, yaw share and the final differential thrust. */
  const mix = { tilt: frame.motors.map(() => 0), yaw: frame.motors.map(() => 0), total: frame.motors.map(() => 0) };
  const contactBody = { position: centerPosition, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // PILOT ACTIONS
  // ============================================================================================
  function handleActions(actions) {
    if (!actions || actions.size === 0) return;
    for (const action of actions) {
      switch (action) {
        case 'engineToggle':
          systems.armed = !systems.armed;
          notify(systems.armed ? 'Armed: motors spinning.' : 'Disarmed: motors stopped.', systems.armed ? 'success' : 'warning');
          break;
        case 'gearToggle':
          notify(`The ${craftName.toLowerCase()} has no retractable gear.`);
          break;
        case 'flapsUp':
        case 'flapsDown':
          notify(`The ${craftName.toLowerCase()} has no flaps.`);
          break;
        case 'chuteDeploy':
          notify(`The ${craftName.toLowerCase()} has no parachute.`);
          break;
        default:
          break;
      }
    }
  }

  // ============================================================================================
  // FLIGHT CONTROLLER
  // ============================================================================================
  /** World up expressed in body axes (level: 0, 1, 0). */
  function updateWorldUp() {
    inverseQuaternion.copy(state.quaternion).invert();
    worldUpBody.set(0, 1, 0).applyQuaternion(inverseQuaternion);
  }

  /**
   * Angle mode: the sticks ask for a bank and pitch (up to the angle limit, heading-free); the level
   * loop turns the tilt error into roll and pitch rate setpoints (x, z).
   */
  function angleSetpoint(controls, target) {
    const bank = clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1) * angleLimit;
    const pitch = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1) * angleLimit;
    // World up as seen from a quad banked right by `bank` and pitched up by `pitch`.
    desiredUp.set(-Math.sin(bank) * Math.cos(pitch), Math.cos(bank) * Math.cos(pitch), -Math.sin(pitch)).normalize();
    levelAxis.crossVectors(desiredUp, worldUpBody);
    const sine = levelAxis.length();
    const cosine = desiredUp.dot(worldUpBody);
    const error = Math.atan2(sine, cosine);
    if (sine > 1e-6) levelAxis.divideScalar(sine);
    else if (cosine < 0) levelAxis.set(0, 0, 1);
    else levelAxis.set(0, 0, 0);
    const rate = Math.min(controller.angleStrength * error, angleRateLimit);
    target.x = levelAxis.x * rate;
    target.z = levelAxis.z * rate;
  }

  /** Rate setpoints (body rad/s) from the sticks in the active mode. */
  function computeSetpoint(controls, target) {
    const yaw = clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1);
    target.y = -betaflightRate(yaw, rates.yaw) * DEG;
    if (systems.mode === 'angle') {
      angleSetpoint(controls, target);
      return;
    }
    target.x = betaflightRate(clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1), rates.pitch) * DEG;
    target.z = -betaflightRate(clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1), rates.roll) * DEG;
  }

  /** I-term relax (Betaflight): the I-term only learns while the setpoint is steady, not during flips. */
  function relaxShare(component, dt) {
    const smoothing = 1 - Math.exp(-dt / controller.rate.relaxSeconds);
    pid.setpointLowPass[component] += (setpoint[component] - pid.setpointLowPass[component]) * smoothing;
    const moving = Math.abs(setpoint[component] - pid.setpointLowPass[component]);
    return Math.max(0, 1 - moving / (controller.rate.relaxThreshold * DEG));
  }

  /**
   * Rate PID with feed-forward on each axis: the desired angular acceleration, times the inertia, is
   * the torque the mixer is asked for. The I-term is held at zero while idling on the ground.
   */
  function ratePid(dt, groundIdle) {
    const gains = controller.rate;
    rateError.copy(setpoint).sub(state.angularVelocity);
    const relaxX = relaxShare('x', dt);
    const relaxY = relaxShare('y', dt);
    const relaxZ = relaxShare('z', dt);
    if (groundIdle) pid.integral.set(0, 0, 0);
    else {
      pid.integral.x += gains.i * rateError.x * relaxX * dt;
      pid.integral.y += gains.i * rateError.y * relaxY * dt;
      pid.integral.z += gains.i * rateError.z * relaxZ * dt;
      pid.integral.clampScalar(-gains.integralLimit, gains.integralLimit);
    }
    angularCommand.copy(rateError).multiplyScalar(gains.p).add(pid.integral);
    if (pid.primed) {
      angularCommand.x += gains.feedForward * (setpoint.x - pid.previousSetpoint.x) / dt - gains.d * (state.angularVelocity.x - pid.previousRate.x) / dt;
      angularCommand.y += gains.feedForward * (setpoint.y - pid.previousSetpoint.y) / dt - gains.d * (state.angularVelocity.y - pid.previousRate.y) / dt;
      angularCommand.z += gains.feedForward * (setpoint.z - pid.previousSetpoint.z) / dt - gains.d * (state.angularVelocity.z - pid.previousRate.z) / dt;
    }
    angularCommand.clampScalar(-gains.accelerationLimit, gains.accelerationLimit);
    pid.previousSetpoint.copy(setpoint);
    pid.previousRate.copy(state.angularVelocity);
    pid.primed = true;
    torqueCommand.set(angularCommand.x * inertia.x, angularCommand.y * inertia.y, angularCommand.z * inertia.z);
  }

  /**
   * Altitude hold (angle mode): the throttle stick asks for a climb rate (centre holds); a velocity loop
   * with an integrator turns it into total thrust, tilt-compensated. Returns thrust in newtons.
   */
  function altitudeHoldThrust(controls, dt, agl, available, guided) {
    const lever = clamp(Number.isFinite(controls.throttle) ? controls.throttle : 0.5, 0, 1);
    const verticalSpeed = state.velocity.y;
    if (!altitude.engaged) {
      altitude.engaged = true;
      altitude.target = centerPosition.y;
      altitude.integral = 0;
      // Until the stick moves, keep holding (the lever may sit anywhere when hold engages).
      altitude.latched = true;
      altitude.latchValue = lever;
    }
    // The autopilot's throttle is always meant; when it lets go, the pilot's lever is latched again.
    if (guided) altitude.latched = false;
    else if (altitude.guided) {
      altitude.latched = true;
      altitude.latchValue = lever;
    }
    altitude.guided = guided;
    if (altitude.latched && (Math.abs(lever - altitude.latchValue) > hold.latchMove || climbForThrottle(lever, hold) === 0)) altitude.latched = false;
    const commanded = altitude.latched ? 0 : climbForThrottle(lever, hold);
    // Landed (resting on the ground for a moment, not a touch-and-go): the motors idle until the stick
    // asks for a climb, so hold never lifts off by itself.
    altitude.groundSeconds = contactReport.onGround ? altitude.groundSeconds + dt : 0;
    const settled = altitude.groundSeconds >= LANDED_SECONDS && Math.abs(verticalSpeed) < LANDED_SPEED && Math.hypot(state.velocity.x, state.velocity.z) < LANDED_SPEED;
    altitude.landed = contactReport.onGround && commanded <= 0 && (altitude.landed || settled);
    if (altitude.landed) {
      altitude.target = centerPosition.y;
      altitude.integral = 0;
      return 0;
    }
    let climb;
    if (commanded === 0) {
      climb = clamp(hold.positionGain * (altitude.target - centerPosition.y), -hold.maxDescent, hold.maxClimb);
    } else {
      climb = commanded;
      altitude.target = centerPosition.y;
    }
    // Close to the ground the descent slows to a gentle touchdown.
    if (climb < 0 && Number.isFinite(agl)) climb = Math.max(climb, -Math.max(hold.landingDescent, hold.maxDescent * smoothstep(0, hold.landingHeight, agl)));
    const error = climb - verticalSpeed;
    altitude.integral = clamp(altitude.integral + hold.integralGain * error * dt, -hold.integralLimit, hold.integralLimit);
    const acceleration = clamp(hold.velocityGain * error + altitude.integral, -hold.accelerationLimit, hold.accelerationLimit);
    const tilt = Math.max(worldUpBody.y, 0.45);
    return clamp((mass * (GRAVITY + acceleration)) / tilt, 0, available);
  }

  function releaseAltitudeHold() {
    altitude.engaged = false;
    altitude.integral = 0;
    altitude.latched = false;
    altitude.landed = false;
    altitude.guided = false;
    altitude.groundSeconds = 0;
  }

  /**
   * Thrust mixer: the collective thrust shared by all motors plus the roll, pitch and yaw torques.
   * Roll and pitch keep priority over yaw; airmode shifts the whole set inside the motors' range so
   * the torques stay available at zero or full throttle. Fills motorCommands (motor speed 0..1).
   */
  function mixMotors(collective, inflowFactor, airmode) {
    const count = frame.motors.length;
    const peak = frame.maxThrust * inflowFactor;
    const floor = peak * idle * idle;
    const span = peak - floor;
    let tiltLow = Infinity;
    let tiltHigh = -Infinity;
    let yawLow = Infinity;
    let yawHigh = -Infinity;
    for (let index = 0; index < count; index++) {
      const motor = frame.motors[index];
      mix.tilt[index] = (torqueCommand.z * motor.position.x) / frame.sumX2 + (torqueCommand.x * -motor.position.z) / frame.sumZ2;
      mix.yaw[index] = (torqueCommand.y * motor.spin) / (count * motorProfile.torqueRatio);
      tiltLow = Math.min(tiltLow, mix.tilt[index]);
      tiltHigh = Math.max(tiltHigh, mix.tilt[index]);
      yawLow = Math.min(yawLow, mix.yaw[index]);
      yawHigh = Math.max(yawHigh, mix.yaw[index]);
    }
    const tiltRange = tiltHigh - tiltLow;
    const tiltScale = tiltRange > span ? span / tiltRange : 1;
    const yawRange = yawHigh - yawLow;
    const yawRoom = Math.max(0, span - tiltRange * tiltScale);
    const yawScale = yawRange > yawRoom ? yawRoom / yawRange : 1;
    let low = Infinity;
    let high = -Infinity;
    for (let index = 0; index < count; index++) {
      mix.total[index] = mix.tilt[index] * tiltScale + mix.yaw[index] * yawScale;
      low = Math.min(low, mix.total[index]);
      high = Math.max(high, mix.total[index]);
    }
    let base = clamp(collective / count, floor, peak);
    if (airmode) {
      if (base + high > peak) base = peak - high;
      if (base + low < floor) base = floor - low;
    }
    for (let index = 0; index < count; index++) {
      const thrust = clamp(base + mix.total[index], floor, peak);
      motorCommands[index] = clamp(Math.sqrt(thrust / Math.max(peak, 1e-6)), idle, 1);
    }
  }

  // ============================================================================================
  // FORCES
  // ============================================================================================
  /** Thrust lapse from axial inflow (air entering the props from above slows their bite). */
  function inflowFactorFor(axialInflow, meanSpeed) {
    const pitchSpeed = frame.pitchSpeed * Math.max(meanSpeed, 0.25);
    return clamp(1 - motorProfile.inflowLapse * (axialInflow / pitchSpeed), motorProfile.inflowMin, motorProfile.inflowMax);
  }

  /** Prop wash (0..1): descending along the thrust axis into the rotors' own wake at low in-plane speed. */
  function propWashFor(axialInflow, inPlaneSpeed) {
    const wake = frame.hoverInflow;
    const descending = smoothstep(aero.propWash.onset * wake, aero.propWash.full * wake, -axialInflow);
    const clean = smoothstep(aero.propWash.clearSpeed * 0.4, aero.propWash.clearSpeed, inPlaneSpeed);
    return descending * (1 - clean);
  }

  function motorForces(rho, turtleActive) {
    const densityShare = rho / SEA_LEVEL_DENSITY;
    const washLoss = 1 - aero.propWash.loss * systems.propWash;
    let total = 0;
    for (let index = 0; index < frame.motors.length; index++) {
      const motor = frame.motors[index];
      const speed = motorSpeeds[index];
      let thrust = frame.maxThrust * speed * speed * densityShare * systems.inflowFactor * washLoss;
      if (turtleActive) thrust = motor.side === systems.turtleSide ? -frame.maxThrust * speed * speed * densityShare * REVERSE_EFFICIENCY : 0;
      motorThrusts[index] = thrust;
      total += thrust;
      pointForce.set(0, thrust, 0);
      forceBody.add(pointForce);
      lever.crossVectors(motor.position, pointForce);
      momentBody.add(lever);
      // Prop drag torque: the frame turns against the prop.
      momentBody.y += motor.spin * motorProfile.torqueRatio * thrust;
    }
    return total;
  }

  function aeroForces(rho, meanSpeed) {
    const airspeed = bodyAir.length();
    if (airspeed > 0.05) {
      const scale = -0.5 * rho * airspeed;
      forceBody.x += scale * dragArea.x * bodyAir.x;
      forceBody.y += scale * dragArea.y * bodyAir.y;
      forceBody.z += scale * dragArea.z * bodyAir.z;
    }
    // Rotor H-force: the spinning props resist air sliding across their discs.
    const rotorDrag = aero.rotorDrag * meanSpeed;
    forceBody.x -= rotorDrag * bodyAir.x;
    forceBody.z -= rotorDrag * bodyAir.z;
    momentBody.x -= damping.x * state.angularVelocity.x;
    momentBody.y -= damping.y * state.angularVelocity.y;
    momentBody.z -= damping.z * state.angularVelocity.z;
  }

  // ============================================================================================
  // STEP
  // ============================================================================================
  function computeAttitude() {
    bodyAxis.set(0, 0, -1).applyQuaternion(state.quaternion);
    const forwardX = bodyAxis.x;
    const forwardY = bodyAxis.y;
    const forwardZ = bodyAxis.z;
    flightData.pitch = Math.asin(clamp(forwardY, -1, 1));
    if (Math.hypot(forwardX, forwardZ) > 0.05) flightData.heading = headingFromVector(forwardX, forwardZ);
    else {
      // Pointing straight up or down: the heading follows the top of the frame instead.
      bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
      if (Math.hypot(bodyAxis.x, bodyAxis.z) > 0.05) flightData.heading = headingFromVector(bodyAxis.x * Math.sign(-forwardY), bodyAxis.z * Math.sign(-forwardY));
    }
    bodyAxis.set(1, 0, 0).applyQuaternion(state.quaternion);
    const rightY = bodyAxis.y;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.bank = Math.atan2(-rightY, bodyAxis.y);
    flightData.upright = bodyAxis.y;
  }

  /**
   * Turtle mode runs while craftState.turtle is set and the quad is still upside down near the ground
   * (it may hop off the ground as it rolls); it ends once the frame has rolled past TURTLE_DONE_UP.
   */
  function updateTurtle(controls, agl) {
    if (!craftState.turtle) {
      systems.turtle = false;
      return false;
    }
    const nearGround = contactReport.onGround || agl < TURTLE_MAX_AGL;
    if (!systems.turtle) {
      systems.turtle = true;
      systems.armed = true;
      // Roll stick picks the side to flip over; by default the right side lifts.
      const roll = Number.isFinite(controls.roll) ? controls.roll : 0;
      systems.turtleSide = roll < -0.2 ? 1 : roll > 0.2 ? -1 : 1;
    }
    if (!nearGround || worldUpBody.y > TURTLE_DONE_UP) {
      craftState.turtle = false;
      systems.turtle = false;
      systems.turtleEnded = true;
      return false;
    }
    return true;
  }

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    time += dt;
    handleActions(controls.actions);
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    updateWorldUp();

    // Air data in body axes.
    bodyAir.copy(state.velocity);
    if (env.wind && env.wind.vel) bodyAir.sub(env.wind.vel);
    bodyAir.applyQuaternion(inverseQuaternion);
    const axialInflow = bodyAir.y;
    const inPlaneSpeed = Math.hypot(bodyAir.x, bodyAir.z);
    let meanSpeed = 0;
    for (const speed of motorSpeeds) meanSpeed += speed;
    meanSpeed /= motorSpeeds.length;
    systems.inflowFactor = inflowFactorFor(axialInflow, meanSpeed);
    systems.propWash = systems.armed ? propWashFor(axialInflow, inPlaneSpeed) * smoothstep(0.15, 0.35, meanSpeed) : 0;

    const surfaceHeight = Math.max(env.groundHeight(centerPosition.x, centerPosition.z), env.waterLevel);
    const agl = centerPosition.y - surfaceHeight;

    // Flight mode (set by the quad assist handler; rate mode when nothing set it).
    systems.mode = craftState.droneMode === 'angle' ? 'angle' : 'rate';
    const holdWanted = systems.mode === 'angle' && craftState.altitudeHold === true;
    const turtleActive = updateTurtle(controls, agl);

    // Throttle and collective.
    const lever = clamp(Number.isFinite(controls.throttle) ? controls.throttle : 0, 0, 1);
    if (systems.turtleEnded) {
      systems.turtleEnded = false;
      if (holdWanted) {
        releaseAltitudeHold();
        altitude.engaged = true;
        // Aim a little below the feet so it settles onto them (the hold then idles on the ground).
        altitude.target = surfaceHeight + frame.restHeight - TURTLE_SETTLE_DEPTH;
        altitude.latched = true;
        altitude.latchValue = lever;
      }
    }
    const onGround = contactReport.onGround;
    const peak = frame.maxThrust * systems.inflowFactor * (rho / SEA_LEVEL_DENSITY) * (1 - aero.propWash.loss * systems.propWash);
    let collective;
    if (holdWanted && systems.armed && !turtleActive) {
      collective = altitudeHoldThrust(controls, dt, agl, peak * frame.motors.length, Boolean(env.autopilot && env.autopilot.enabled));
      systems.holding = true;
      const perMotor = collective / frame.motors.length;
      systems.baseCommand = clamp(Math.sqrt(perMotor / Math.max(peak, 1e-6)), idle, 1);
      systems.throttle = clamp((systems.baseCommand - idle) / (1 - idle), 0, 1);
    } else {
      if (systems.holding) releaseAltitudeHold();
      systems.holding = false;
      systems.throttle = lever;
      systems.baseCommand = idle + (1 - idle) * lever;
      collective = peak * systems.baseCommand * systems.baseCommand * frame.motors.length;
    }
    if (!holdWanted && altitude.engaged) releaseAltitudeHold();

    // Rate PID and mixer; on the ground at idle the I-term and airmode stay off.
    const groundIdle = onGround && (systems.holding ? altitude.landed : lever < GROUND_IDLE_THROTTLE);
    systems.airmode = systems.armed && !groundIdle;
    computeSetpoint(controls, setpoint);
    ratePid(dt, groundIdle || !systems.armed);
    if (!systems.armed) {
      for (let index = 0; index < motorCommands.length; index++) motorCommands[index] = 0;
    } else if (turtleActive) {
      for (let index = 0; index < motorCommands.length; index++) motorCommands[index] = frame.motors[index].side === systems.turtleSide ? controller.turtlePower : 0;
    } else {
      mixMotors(collective, systems.inflowFactor * (rho / SEA_LEVEL_DENSITY) * (1 - aero.propWash.loss * systems.propWash), systems.airmode);
    }

    // Motor spool: first order toward the command, faster up than down.
    for (let index = 0; index < motorSpeeds.length; index++) {
      const command = motorCommands[index];
      const timeConstant = command > motorSpeeds[index] ? motorProfile.spoolUpSeconds : motorProfile.spoolDownSeconds;
      motorSpeeds[index] += (command - motorSpeeds[index]) * (1 - Math.exp(-dt / timeConstant));
    }

    forceBody.set(0, 0, 0);
    momentBody.set(0, 0, 0);
    const totalThrust = motorForces(rho, turtleActive);
    aeroForces(rho, meanSpeed);

    // Prop wash and turbulence shake the frame.
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    const washShake = aero.propWash.shake * systems.propWash;
    const gustShake = aero.turbulenceShake * turbulence * Math.min(1, bodyAir.lengthSq() / 400 + 0.3);
    if (washShake > 0 || gustShake > 0) {
      momentBody.x += washShake * noise(time, 0.4, 11) + gustShake * noise(time, 1.3, 2.1);
      momentBody.y += washShake * 0.4 * noise(time, 2.2, 9) + gustShake * 0.5 * noise(time, 2.7, 1.7);
      momentBody.z += washShake * noise(time, 4.1, 13) + gustShake * noise(time, 3.9, 2.4);
    }

    // Near the ground the contact and the integration run in substeps: a 650 g quad falling a few m/s
    // covers the few centimetres between its feet and its prop tips in one 120 Hz tick.
    const substeps = contactSubsteps(agl, dt);
    const substep = dt / substeps;
    beginContactReport();
    for (let index = 0; index < substeps; index++) integrate(substep, env);

    // Flight data for the control stages and telemetry.
    computeAttitude();
    let motorMean = 0;
    for (const speed of motorSpeeds) motorMean += speed;
    motorMean /= motorSpeeds.length;
    flightData.airspeed = bodyAir.length();
    flightData.groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.verticalSpeed = state.velocity.y;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.gLoad = smoothedLoad;
    flightData.onGround = contactReport.onGround;
    flightData.agl = centerPosition.y - surfaceHeight;
    flightData.throttle = systems.throttle;
    flightData.thrust = totalThrust;
    flightData.motorSpeed = motorMean;
    flightData.armed = systems.armed;
    flightData.mode = systems.mode;
    flightData.altitudeHold = systems.holding;
    flightData.propWash = systems.propWash;
    writeSurfaces(motorMean);
    watchUpsideDown();

    landing.observe(contactReport, { dt, agl: flightData.agl, position: state.position });
  }

  /**
   * The four motor speeds as orthogonal patterns for the mesh: mean (propSpeed, visual rad/s), roll
   * (right minus left), pitch (front minus rear) and yaw (CW minus CCW pair), each a half-difference,
   * so the mesh rebuilds every motor's speed exactly: mean + roll * side + pitch * front + yaw * spin.
   */
  function writeSurfaces(motorMean) {
    let roll = 0;
    let pitch = 0;
    let yaw = 0;
    for (let index = 0; index < frame.motors.length; index++) {
      const motor = frame.motors[index];
      roll += motorSpeeds[index] * motor.side;
      pitch += motorSpeeds[index] * motor.front;
      yaw += motorSpeeds[index] * motor.spin;
    }
    const count = frame.motors.length;
    surfaces.aileron = clamp((2 * roll) / count, -1, 1);
    surfaces.elevator = clamp((2 * pitch) / count, -1, 1);
    surfaces.rudder = clamp((2 * yaw) / count, -1, 1);
    surfaces.propSpeed = systems.turtle ? -motorMean * QUAD_VISUAL_PROP_SPEED : motorMean * QUAD_VISUAL_PROP_SPEED;
    surfaces.groundSpeed = 0;
  }

  /** Upside down and at rest on the ground: point the pilot at turtle mode once per landing. */
  function watchUpsideDown() {
    if (!contactReport.onGround) {
      systems.upsideDownNoticed = false;
      return;
    }
    if (systems.upsideDownNoticed || systems.turtle || flightData.upright > INVERTED_UP || state.velocity.lengthSq() > 0.25) return;
    systems.upsideDownNoticed = true;
    notify('Upside down: use the craft ability for turtle mode to flip back over.', 'info');
  }

  /** Substeps for this tick: 1 in the air, up to CONTACT_SUBSTEPS.MAX near the ground at speed. */
  function contactSubsteps(agl, dt) {
    const reach = contact.boundingRadius + state.velocity.length() * dt + CONTACT_SUBSTEPS.MARGIN;
    if (!(agl < reach)) return 1;
    const travel = (state.velocity.length() + state.angularVelocity.length() * contact.boundingRadius) * dt;
    return clamp(Math.ceil(travel / CONTACT_SUBSTEPS.TRAVEL), 1, CONTACT_SUBSTEPS.MAX);
  }

  /** Clears the tick's merged contact report (substeps merge into it). */
  function beginContactReport() {
    contactReport.onGround = false;
    contactReport.touchdown = null;
    contactReport.bodyStrike = null;
    contactReport.water = false;
    contactReport.penetration = 0;
    contactReport.contacts = 0;
    contactReport.gearContacts = 0;
    contactReport.wheelSpeed = 0;
  }

  /** Merges one substep's contact result into the tick's report (worst case of each field). */
  function mergeContactReport(result) {
    contactReport.onGround = contactReport.onGround || result.onGround;
    contactReport.water = contactReport.water || result.water;
    contactReport.penetration = Math.max(contactReport.penetration, result.penetration);
    contactReport.contacts = Math.max(contactReport.contacts, result.contacts);
    contactReport.gearContacts = Math.max(contactReport.gearContacts, result.gearContacts);
    if (result.touchdown && !contactReport.touchdown) contactReport.touchdown = Object.assign(mergedTouchdown, result.touchdown);
    if (result.bodyStrike && (!contactReport.bodyStrike || result.bodyStrike.speed > contactReport.bodyStrike.speed)) {
      contactReport.bodyStrike = Object.assign(mergedStrike, result.bodyStrike);
    }
  }

  /** One integration step of `dt`: ground contact, then semi-implicit Euler on the rigid body. */
  function integrate(dt, env) {
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    mergeContactReport(contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment));
    totalMoment.copy(momentBody).add(groundMoment);

    forceWorld.copy(forceBody).applyQuaternion(state.quaternion).add(groundForce);
    nonGravity.copy(forceWorld);
    forceWorld.y -= mass * GRAVITY;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    const load = nonGravity.dot(bodyAxis) / (mass * GRAVITY);
    smoothedLoad += (load - smoothedLoad) * (1 - Math.exp(-LOAD_SMOOTHING * dt));

    // Euler's equations (principal axes): I w' = M - w x (I w).
    angularMomentum.set(state.angularVelocity.x * inertia.x, state.angularVelocity.y * inertia.y, state.angularVelocity.z * inertia.z);
    gyro.crossVectors(state.angularVelocity, angularMomentum);
    angularAcceleration.copy(totalMoment).sub(gyro);
    angularAcceleration.set(angularAcceleration.x / inertia.x, angularAcceleration.y / inertia.y, angularAcceleration.z / inertia.z);

    // Semi-implicit Euler: velocities first, then positions and attitude from the new velocities.
    state.velocity.addScaledVector(forceWorld, dt / mass);
    if (state.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) state.velocity.setLength(MAX_SPEED);
    state.angularVelocity.addScaledVector(angularAcceleration, dt);
    if (state.angularVelocity.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) state.angularVelocity.setLength(MAX_ANGULAR_SPEED);
    centerPosition.addScaledVector(state.velocity, dt);
    const rate = state.angularVelocity.length();
    if (rate > 1e-9) {
      axis.copy(state.angularVelocity).divideScalar(rate);
      state.quaternion.multiply(rotationStep.setFromAxisAngle(axis, rate * dt)).normalize();
    }
    syncOrigin();
  }

  /** The mesh origin from the centre of mass. */
  function syncOrigin() {
    originOffset.copy(frame.centerOfMass).applyQuaternion(state.quaternion);
    state.position.copy(centerPosition).sub(originOffset);
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) {
      originOffset.copy(frame.centerOfMass).applyQuaternion(state.quaternion);
      centerPosition.copy(pose.position).add(originOffset);
    }
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    syncOrigin();
    const onGround = pose.onGround === true;
    systems.armed = pose.engineOn !== false;
    systems.throttle = Number.isFinite(pose.throttle) ? clamp(pose.throttle, 0, 1) : frame.hoverThrottle;
    // In the air the motors carry on at the pose's throttle (a spawn hovers from the first tick).
    const spin = systems.armed ? (onGround ? idle : idle + (1 - idle) * systems.throttle) : 0;
    for (let index = 0; index < motorSpeeds.length; index++) {
      motorSpeeds[index] = spin;
      motorCommands[index] = spin;
      motorThrusts[index] = 0;
    }
    systems.baseCommand = spin;
    systems.propWash = 0;
    systems.inflowFactor = 1;
    systems.turtle = false;
    systems.upsideDownNoticed = false;
    craftState.turtle = false;
    pid.integral.set(0, 0, 0);
    pid.previousRate.copy(state.angularVelocity);
    pid.previousSetpoint.set(0, 0, 0);
    pid.setpointLowPass.set(0, 0, 0);
    pid.primed = false;
    releaseAltitudeHold();
    smoothedLoad = 1;
    contact.reset(onGround);
    landing.reset(onGround);
    beginContactReport();
    contactReport.onGround = onGround;
    flightData.onGround = onGround;
    resetCount++;
    flightData.resetCount = resetCount;
    computeAttitude();
    flightData.airspeed = state.velocity.length();
    writeSurfaces(spin);
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.gLoad = flightData.gLoad;
    flight.throttle = systems.throttle;
    flight.afterburner = false;
    flight.engineOn = systems.armed;
    flight.rpm = flightData.motorSpeed;
    flight.torque = 0;
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.gear.retractable = false;
    flight.gear.down = true;
    flight.gear.transit = 0;
    flight.airbrake = 0;
    flight.brakes = 0;
    flight.trim = 0;
    flight.contacts = contactReport.contacts;
    // A quad has no wing to stall; prop wash is its buffet.
    flight.stall.stalled = false;
    flight.stall.warning = false;
    flight.stall.buffet = Math.round(systems.propWash * 1000) / 1000;
    flight.overspeed = flightData.airspeed > vne;
  }

  function snapshot() {
    return {
      kind: 'quad',
      center: [centerPosition.x, centerPosition.y, centerPosition.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      motors: [...motorSpeeds],
      pid: {
        integral: [pid.integral.x, pid.integral.y, pid.integral.z],
        previousRate: [pid.previousRate.x, pid.previousRate.y, pid.previousRate.z],
        previousSetpoint: [pid.previousSetpoint.x, pid.previousSetpoint.y, pid.previousSetpoint.z],
        setpointLowPass: [pid.setpointLowPass.x, pid.setpointLowPass.y, pid.setpointLowPass.z],
        primed: pid.primed,
      },
      altitude: { ...altitude },
      systems: {
        armed: systems.armed,
        throttle: systems.throttle,
        baseCommand: systems.baseCommand,
        holding: systems.holding,
        turtle: systems.turtle,
        turtleSide: systems.turtleSide,
      },
      load: smoothedLoad,
      time,
      contact: contact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'quad') return false;
    centerPosition.fromArray(data.center);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    for (let index = 0; index < motorSpeeds.length; index++) motorSpeeds[index] = Number.isFinite(data.motors[index]) ? data.motors[index] : 0;
    pid.integral.fromArray(data.pid.integral);
    pid.previousRate.fromArray(data.pid.previousRate);
    pid.previousSetpoint.fromArray(data.pid.previousSetpoint);
    pid.setpointLowPass.fromArray(data.pid.setpointLowPass);
    pid.primed = data.pid.primed === true;
    Object.assign(altitude, data.altitude);
    Object.assign(systems, data.systems);
    smoothedLoad = Number.isFinite(data.load) ? data.load : 1;
    time = Number.isFinite(data.time) ? data.time : time;
    contact.restore(data.contact);
    landing.restore(data.landing);
    syncOrigin();
    computeAttitude();
    return true;
  }

  return {
    kind: 'quad',
    profile,
    state,
    contact: contactReport,
    surfaces,
    flightData,
    craftState,
    reset,
    step,
    writeTelemetry,
    snapshot,
    restore,

    /** Number of resets so far (control stages re-initialize when it changes). */
    get resetCount() {
      return resetCount;
    },
    /** Centre of mass (world). */
    get centerOfMass() {
      return centerPosition;
    },
    /** Each motor's speed (0..1 of rated) and thrust (N, negative when reversed in turtle mode). */
    get motors() {
      return frame.motors.map((motor, index) => ({ id: motor.id, speed: motorSpeeds[index], thrust: motorThrusts[index] }));
    },
    get landings() {
      return landing.landings;
    },

    dispose() {
      contactReport.touchdown = null;
      contactReport.bodyStrike = null;
    },
  };
}

// ============================================================================================
// QUAD ASSISTS: the flight-controller mode follows the assist level
//   100 %  angle mode with altitude hold
//    50 %  angle mode (self-levelling) without altitude hold
//     0 %  rate (acro) mode
// The craft ability toggles rate / angle at any level; the choice holds until the assist level
// changes. The autopilot and the hands-off hold always fly in angle mode with altitude hold.
// ============================================================================================
export const QUAD_ASSIST_LEVELS = Object.freeze({ ANGLE_MODE: 0.35, ALTITUDE_HOLD: 0.85 });

const QUAD_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'angleMode', name: 'angle mode', from: QUAD_ASSIST_LEVELS.ANGLE_MODE, full: QUAD_ASSIST_LEVELS.ANGLE_MODE }),
  Object.freeze({ key: 'altitudeHold', name: 'altitude hold', from: QUAD_ASSIST_LEVELS.ALTITUDE_HOLD, full: QUAD_ASSIST_LEVELS.ALTITUDE_HOLD }),
]);
const QUAD_ASSIST_NAMES = new Set(QUAD_ASSIST_CATALOG.map((entry) => entry.name));

/** The flight mode an assist level (0..1) selects: { mode: 'rate' | 'angle', altitudeHold }. */
export function quadModeForLevel(level) {
  const clamped = clamp(Number.isFinite(level) ? level : 1, 0, 1);
  const angle = clamped > QUAD_ASSIST_LEVELS.ANGLE_MODE;
  return { mode: angle ? 'angle' : 'rate', altitudeHold: angle && clamped > QUAD_ASSIST_LEVELS.ALTITUDE_HOLD };
}

const quadAssistHandler = Object.freeze({
  createMemory() {
    return { resetCount: -1 };
  },

  apply(controls, context, weights) {
    const craftState = context.model && context.model.craftState;
    if (!craftState) return;
    const level = clamp(Number.isFinite(context.assists) ? context.assists : 1, 0, 1);
    if (craftState.assistLevel !== level) {
      craftState.assistLevel = level;
      craftState.modeOverride = null;
    }
    const byLevel = weights.angleMode > 0 ? 'angle' : 'rate';
    const guided = Boolean(context.autopilot && context.autopilot.enabled) || context.handsOff === true;
    const mode = guided ? 'angle' : craftState.modeOverride === 'rate' || craftState.modeOverride === 'angle' ? craftState.modeOverride : byLevel;
    const altitudeHold = mode === 'angle' && (guided || weights.altitudeHold > 0);
    craftState.droneMode = mode;
    craftState.altitudeHold = altitudeHold;
    // The tooltip lists what the level gives; state.flight.activeAssists lists what is really flying.
    const active = context.activeAssists;
    for (let index = active.length - 1; index >= 0; index--) {
      if (QUAD_ASSIST_NAMES.has(active[index])) active.splice(index, 1);
    }
    if (mode === 'angle') active.push('angle mode');
    if (altitudeHold) active.push('altitude hold');
  },
});

registerAssistCatalog('quad', QUAD_ASSIST_CATALOG);
registerAssistHandler('quad', quadAssistHandler);

// ============================================================================================
// QUAD AUTOPILOT: heading, altitude and speed hold through the flight controller's own modes
// (angle mode sticks, altitude-hold throttle, yaw rate stick). The hands-off hold hovers in place.
// ============================================================================================
const QUAD_AUTOPILOT = Object.freeze({
  YAW_RATE_PER_DEGREE: 2.5,
  MAX_YAW_RATE: 120,
  /** Forward speed loop: nose-down tilt (deg) per m/s of speed error, and its integral. */
  SPEED_P: 3,
  SPEED_I: 0.8,
  SPEED_INTEGRAL_LIMIT: 30,
  MAX_TILT: 45,
  /** Lateral drift: bank (deg) per m/s of sideways velocity. */
  DRIFT_GAIN: 4,
  MAX_BANK: 35,
  /** Heading errors past this slow the quad down until it points the right way (deg). */
  TURN_SLOWDOWN: 60,
  MAX_CRUISE: 38,
  CLIMB_PER_METRE: 0.8,
  MAX_CLIMB: 5,
  MAX_DESCENT: 3.5,
  CLEARANCE: 35,
  LOOKAHEAD_SECONDS: Object.freeze([0, 1, 2, 4, 6]),
  LOOKAHEAD_REFRESH: 0.25,
});

function wrapSigned(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** Highest surface (ground or water) along the velocity over the next few seconds, plus clearance. */
function terrainFloor(memory, env, position, velocity, dt) {
  memory.lookaheadAge += dt;
  if (memory.lookaheadAge < QUAD_AUTOPILOT.LOOKAHEAD_REFRESH) return memory.floor;
  memory.lookaheadAge = 0;
  const world = env.world;
  let floor = -Infinity;
  for (const seconds of QUAD_AUTOPILOT.LOOKAHEAD_SECONDS) {
    const x = position.x + velocity.x * seconds;
    const z = position.z + velocity.z * seconds;
    const ground = world ? world.groundHeight(x, z) : env.groundHeight(x, z);
    floor = Math.max(floor, Math.max(ground, env.waterLevel) + QUAD_AUTOPILOT.CLEARANCE);
  }
  memory.floor = floor;
  return floor;
}

const quadAutopilot = Object.freeze({
  createMemory() {
    return { resetCount: -1, engaged: false, speedIntegral: 0, lookaheadAge: Infinity, floor: -Infinity };
  },

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
    const velocity = model.state.velocity;
    if (!memory.engaged) {
      memory.engaged = true;
      memory.speedIntegral = 0;
      memory.lookaheadAge = Infinity;
    }
    const angleLimitDegrees = data.angleLimit / DEG;

    // Heading: a yaw rate toward the target through the craft's own rate curve.
    const headingError = wrapSigned(autopilot.heading - data.heading);
    const yawRate = clamp(headingError * QUAD_AUTOPILOT.YAW_RATE_PER_DEGREE, -QUAD_AUTOPILOT.MAX_YAW_RATE, QUAD_AUTOPILOT.MAX_YAW_RATE);
    controls.yaw = stickForRate(yawRate, data.rates.yaw);

    // Speed along the nose, and no sideways drift (the hands-off hold stops and hovers).
    const hover = context.handsOff === true;
    const cruise = hover ? 0 : clamp(Number.isFinite(autopilot.speed) ? autopilot.speed : 0, 0, QUAD_AUTOPILOT.MAX_CRUISE);
    const wanted = cruise * clamp(1 - Math.abs(headingError) / QUAD_AUTOPILOT.TURN_SLOWDOWN, 0.15, 1);
    const headingRadians = data.heading * DEG;
    const forwardX = Math.sin(headingRadians);
    const forwardZ = -Math.cos(headingRadians);
    const forwardSpeed = velocity.x * forwardX + velocity.z * forwardZ;
    const sideSpeed = velocity.x * -forwardZ + velocity.z * forwardX;
    const speedError = wanted - forwardSpeed;
    memory.speedIntegral = clamp(memory.speedIntegral + speedError * dt, -QUAD_AUTOPILOT.SPEED_INTEGRAL_LIMIT, QUAD_AUTOPILOT.SPEED_INTEGRAL_LIMIT);
    const tilt = clamp(QUAD_AUTOPILOT.SPEED_P * speedError + QUAD_AUTOPILOT.SPEED_I * memory.speedIntegral, -QUAD_AUTOPILOT.MAX_TILT, QUAD_AUTOPILOT.MAX_TILT);
    const bank = clamp(-QUAD_AUTOPILOT.DRIFT_GAIN * sideSpeed, -QUAD_AUTOPILOT.MAX_BANK, QUAD_AUTOPILOT.MAX_BANK);
    controls.pitch = clamp(-tilt / angleLimitDegrees, -1, 1);
    controls.roll = clamp(bank / angleLimitDegrees, -1, 1);

    // Altitude through the altitude-hold throttle, kept clear of the terrain ahead.
    const floor = terrainFloor(memory, context.env, position, velocity, dt);
    const target = Math.max(Number.isFinite(autopilot.altitude) ? autopilot.altitude : position.y, floor);
    const climb = clamp((target - position.y) * QUAD_AUTOPILOT.CLIMB_PER_METRE, -QUAD_AUTOPILOT.MAX_DESCENT, QUAD_AUTOPILOT.MAX_CLIMB);
    controls.throttle = throttleForClimb(Math.abs(climb) < 0.05 ? 0 : climb, data.altitudeHoldTuning);
    return true;
  },
});

registerAutopilotHandler('quad', quadAutopilot);
