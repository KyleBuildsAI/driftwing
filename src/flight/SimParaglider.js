// SimParaglider: the SIM flight model for the paraglider, a two-body pendulum (canopy + pilot).
//
// Two point masses joined by the suspension lines, integrated at the controller's fixed 120 Hz (two
// substeps per tick) in SI units:
//   pilot      the pilot, harness and gear (the mesh origin, the ground contact and the state the
//              controller reads): weight, the pilot's own drag, the ground (feet, seat), the run
//   canopy     the ram-air wing at the end of the lines: its weight and the inertia of the fabric and
//              the air inside it, and the aerodynamic force of each half of the wing in the air at
//              the canopy (the WindField probed up there, so the canopy meets a thermal or a gust a
//              moment before the pilot does)
//   lines      inextensible but able to go slack: an impulse removes any separating velocity and a
//              projection keeps the length, so the line tension is whatever holds the two together.
//              The canopy swings fore and aft and side to side over the pilot: brakes, surges, the
//              swing out in a turn and the pendulum after a thermal entry are the lines and masses,
//              not scripted motion
//   heading    the canopy's yaw is its own degree of freedom: the drag of the braked half yaws it,
//              weathervane stability turns it into the relative wind, rate damping slows it
//   pitch      the canopy's incidence to the lines (the rigging angle, raised by the brakes and lowered
//              by the speed bar) follows its target with a short lag; the angle of attack comes from
//              the canopy's own airflow in that frame. The trim (about 38 km/h, 9 : 1) is where the
//              wing's force lines up with the lines: rigging plus the polar
// Controls (src/craft/paraglider.js, inputProfile):
//   brakes     left and right (toe brakes, the rudder pedals or yaw keys as a differential pair, the
//              stick pulled back as both): camber, lift and drag on that half; one side turns, both
//              slow down and flare; held deep, the wing stalls (released, it surges and flies again)
//   speed bar  the throttle axis (and the stick pushed forward, or released trimmers on the rocker):
//              the incidence falls, the wing flies faster and steeper (about 50 km/h, 7 : 1) and
//              closer to a collapse; the bar engages once the lever has moved after a reset
//   weight     stick X: the pilot shifts weight, the canopy rolls a little toward it and turns gently
//   big ears   craftState.bigEars (the craft ability, held; B toggles a latched pair): the outer cells
//              fold under, the flying area shrinks and the folded tips flap: the sink triples
// Collapses: turbulence (the WindField's) varies the angle of attack across the span; when one half's
// pressure angle (its angle of attack plus the brake pressure on it) falls below the collapse angle,
// that half folds under: its lift goes, its folded fabric drags, the wing yaws and rolls toward it.
// The fabric reinflates on its own (faster with airspeed and with the brake on that side pumped).
// The assists (kind 'paraglider') pilot actively to prevent collapses, recover them automatically,
// coordinate turns, damp surges and protect the stall; at 0 % everything is the pilot's.
// Ground: the feet roll like a braked wheel, the seat slides; a slow touchdown lands (the wing is
// killed and lies down behind the pilot), and from the ground a push forward, the speed bar or
// craftState.launchRequested inflates the wing and runs: on any slope (or in a stiff breeze) the pilot
// is lifted off. A touchdown on water floats (a graded landing); the craft module relaunches from there.
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces, flightData (read by the
// paraglider assists and autopilot) and dispose(). craftState (shared with the craft ability, the
// mesh, audio, the instruments and the copilot; contract h.3): brakeLeft, brakeRight, speedBar,
// bigEars (read), earsFold, collapse { left, right }, pendulum (deg), weightShift, phase ('flight' |
// 'landed' | 'launch'), inflation, canopyOffset [x, y, z] and canopyPitch (the canopy in body axes,
// for the mesh), stalled, climb { active, gain, average }, landedSeconds, collapses, launchRequested.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, smoothstep } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler, stallWarningActive } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';
import { surfaceHeightAt } from './waterSurface.js';

const SUBSTEPS = 2;
const MAX_SPEED = 60;
const MAX_YAW_RATE = 4;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Below this airspeed (m/s) a body makes no aerodynamic force. */
const MIN_AIRSPEED = 0.4;
/** Line tension (share of the weight) from which the pilot hangs along the lines instead of standing. */
const HANG_TENSION = Object.freeze({ FROM: 0.12, FULL: 0.55 });
/** The pilot's flight-to-ground transitions. */
const LANDED_SPEED = 4;
const LANDED_SECONDS = 0.6;
/** On the feet this long after a touchdown, the pilot kills the wing (both brakes down). */
const KILL_SECONDS = 0.25;
const FLOAT_LANDED_SECONDS = 0.4;
/** A landed wing lifted off the ground again (a gust on a ridge) flies again after this long. */
const RELIFT_SECONDS = 1;
/** Push or speed bar held this long on the ground starts a launch run. */
const LAUNCH_INPUT = Object.freeze({ PUSH: 0.5, BAR: 0.6, SECONDS: 0.3 });
/** Airborne this long during a launch run counts as flying. */
const LAUNCH_AIRBORNE_SECONDS = 0.4;
/** The canopy rests this high (m) above the surface below it. */
const CANOPY_REST_HEIGHT = 0.25;
/** The speed bar engages once the lever has moved this far from where it was at a reset (or sits at idle). */
const BAR_ARM_TRAVEL = 0.08;
const BAR_IDLE = 0.05;
/** Readout smoothing (1/s): load factor, glide ratio, the climb tracker's vertical speed. */
const LOAD_SMOOTHING = 8;
const GLIDE_SMOOTHING = 1.5;
const CLIMB_SMOOTHING = 1 / 6;
/** Climb tracking: a climb starts above START m/s held for HOLD s and ends below END m/s held for EXIT s. */
const CLIMB = Object.freeze({ START: 0.35, HOLD: 8, END: -0.25, EXIT: 10, WINDOW: 20, MIN_GAIN: 30 });
const NOTIFY_INTERVAL = 6;
/** The surface under the pilot is re-read every this many ticks, and every tick below SURFACE_PROBE_AGL. */
const SURFACE_PROBE_TICKS = 4;
const SURFACE_PROBE_AGL = 40;
/** The flat-plate lift peak past the stall (aero.js's deep-stall regime). */
const FLAT_PLATE_LIFT = 1.05;

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function axisValue(value) {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function unitValue(value) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

function wrapSignedRadians(angle) {
  const turn = Math.PI * 2;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}

function wrapSignedDegrees(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// ============================================================================================
// ASSISTS (kind 'paraglider'): registered with the shared assist stage (src/flight/assists.js)
//   100 %  active piloting (no collapses), auto recovery, turn coordination, surge damping, stall
//          protection, spiral exit
//    50 %  auto recovery, turn coordination, surge damping
//     0 %  raw: collapses happen in strong turbulence and reopen on their own, slowly
// ============================================================================================
export const PARAGLIDER_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'autoRecover', name: 'collapse recovery', from: 0, full: 0.5 }),
  Object.freeze({ key: 'surgeDamping', name: 'surge damping', from: 0, full: 0.5 }),
  Object.freeze({ key: 'turnCoordination', name: 'turn coordination', from: 0.25, full: 0.75 }),
  Object.freeze({ key: 'activePiloting', name: 'active piloting', from: 0.5, full: 1 }),
  Object.freeze({ key: 'stallProtection', name: 'stall protection', from: 0.5, full: 1 }),
  Object.freeze({ key: 'spiralExit', name: 'spiral exit', from: 0.6, full: 1 }),
]);

const ASSIST = Object.freeze({
  IDLE: 0.05,
  /** Turn coordination: the inner brake that goes with a full weight shift. */
  TURN_BRAKE: 0.42,
  /** Surge damping: symmetric brake per rad/s of the canopy swinging ahead of the pilot. */
  SURGE: Object.freeze({ GAIN: 0.9, LIMIT: 0.35 }),
  /**
   * Active piloting: the pilot feels each half's pressure angle and its trend (LEAD seconds ahead),
   * comes off the speed bar as it nears the collapse angle plus BAR_MARGIN, and brakes that side
   * before it reaches the collapse angle plus MARGIN.
   */
  ACTIVE: Object.freeze({ LEAD: 0.25, MARGIN: 3.2 * DEG, LIMIT: 0.85, BAR_MARGIN: 7 * DEG }),
  /** Collapse recovery: counter-brake the open side, weight shift away, pump the collapsed side. */
  RECOVER: Object.freeze({ COUNTER: 0.7, SHIFT: 0.8, PUMP_BASE: 0.35, PUMP_DEPTH: 0.4, PUMP_HZ: 1.3 }),
  /** Stall protection keeps the angle of attack this far below the stall (not in the flare: below FLARE_AGL). */
  STALL: Object.freeze({ MARGIN: 2 * DEG, GAIN: 6, FLARE_AGL: 5 }),
  /** Spiral exit: past BANK with the pilot's hands off, the outer brake opens the spiral. */
  SPIRAL: Object.freeze({ BANK: 48 * DEG, GAIN: 1.2, LIMIT: 0.6 }),
});

function createParagliderAssistMemory() {
  return { resetCount: -1, pumpPhase: 0 };
}

const paragliderAssistHandler = Object.freeze({
  createMemory: createParagliderAssistMemory,

  apply(controls, context, weights, memory) {
    const data = context.model.flightData;
    if (data.phase !== 'flight' || data.onGround) return;
    const pilotRoll = axisValue(controls.roll);
    const pilotDifferential = unitValue(controls.brakeR) - unitValue(controls.brakeL) + axisValue(controls.yaw);
    const handsOff = Math.abs(pilotRoll) < ASSIST.IDLE && Math.abs(pilotDifferential) < ASSIST.IDLE;
    // The least brake each side should have after the assists (the pilot's own toe brakes still count).
    let leftBrake = 0;
    let rightBrake = 0;

    if (weights.turnCoordination > 0 && Math.abs(pilotRoll) >= ASSIST.IDLE) {
      const inner = weights.turnCoordination * ASSIST.TURN_BRAKE * Math.abs(pilotRoll);
      if (pilotRoll > 0) rightBrake = Math.max(rightBrake, inner);
      else leftBrake = Math.max(leftBrake, inner);
    }
    if (weights.surgeDamping > 0 && data.pendulumRate > 0) {
      const brake = weights.surgeDamping * Math.min(ASSIST.SURGE.LIMIT, ASSIST.SURGE.GAIN * data.pendulumRate);
      leftBrake = Math.max(leftBrake, brake);
      rightBrake = Math.max(rightBrake, brake);
    }
    if (weights.activePiloting > 0) {
      const tuning = ASSIST.ACTIVE;
      const floor = data.collapseAoa + tuning.MARGIN;
      const predictedLeft = data.pressureLeft + Math.min(0, data.pressureTrendLeft) * tuning.LEAD;
      const predictedRight = data.pressureRight + Math.min(0, data.pressureTrendRight) * tuning.LEAD;
      const barFloor = data.collapseAoa + tuning.BAR_MARGIN;
      const lowest = Math.min(predictedLeft, predictedRight);
      if (lowest < barFloor) {
        const ease = 1 - weights.activePiloting * Math.min(1, (barFloor - lowest) / (tuning.BAR_MARGIN - tuning.MARGIN));
        controls.throttle = unitValue(controls.throttle) * ease;
        if (controls.pitch < 0) controls.pitch *= ease;
        if (controls.trim < 0) controls.trim *= ease;
      }
      if (data.brakePressureAoa > 0) {
        if (predictedLeft < floor) leftBrake = Math.max(leftBrake, weights.activePiloting * Math.min(tuning.LIMIT, (floor - predictedLeft) / data.brakePressureAoa));
        if (predictedRight < floor) rightBrake = Math.max(rightBrake, weights.activePiloting * Math.min(tuning.LIMIT, (floor - predictedRight) / data.brakePressureAoa));
      }
    }
    if (weights.autoRecover > 0 && (data.collapseLeft > 0.02 || data.collapseRight > 0.02)) {
      const tuning = ASSIST.RECOVER;
      memory.pumpPhase = (memory.pumpPhase + context.dt * tuning.PUMP_HZ) % 1;
      const pump = tuning.PUMP_BASE + tuning.PUMP_DEPTH * (0.5 + 0.5 * Math.sin(memory.pumpPhase * Math.PI * 2));
      const asymmetry = data.collapseLeft - data.collapseRight;
      const depth = Math.max(data.collapseLeft, data.collapseRight);
      // Keep the wing flying straight on its open half and pump the collapsed half open.
      const counter = weights.autoRecover * tuning.COUNTER * Math.min(1, Math.abs(asymmetry) * 1.6);
      const pumped = weights.autoRecover * pump * Math.min(1, depth * 2);
      const shift = weights.autoRecover * tuning.SHIFT * Math.min(1, Math.abs(asymmetry) * 2);
      if (asymmetry >= 0) {
        rightBrake = Math.max(rightBrake, counter);
        leftBrake = Math.max(leftBrake, pumped);
        controls.roll = Math.min(1, pilotRoll + shift);
      } else {
        leftBrake = Math.max(leftBrake, counter);
        rightBrake = Math.max(rightBrake, pumped);
        controls.roll = Math.max(-1, pilotRoll - shift);
      }
    } else {
      memory.pumpPhase = 0;
    }
    if (weights.spiralExit > 0 && handsOff && Math.abs(data.bank) > ASSIST.SPIRAL.BANK) {
      // The outer brake (the high side) slows that half and yaws the wing out of the turn.
      const outer = weights.spiralExit * Math.min(ASSIST.SPIRAL.LIMIT, ASSIST.SPIRAL.GAIN * (Math.abs(data.bank) - ASSIST.SPIRAL.BANK) * 4);
      if (data.bank > 0) leftBrake = Math.max(leftBrake, outer);
      else rightBrake = Math.max(rightBrake, outer);
    }
    controls.brakeL = Math.max(unitValue(controls.brakeL), Math.min(1, leftBrake));
    controls.brakeR = Math.max(unitValue(controls.brakeR), Math.min(1, rightBrake));
    if (weights.stallProtection > 0 && data.agl > ASSIST.STALL.FLARE_AGL) {
      const tuning = ASSIST.STALL;
      const over = data.aoa - (data.aoaCritical - tuning.MARGIN);
      if (over > 0) {
        // Ease every brake channel back toward the incidence that keeps the margin.
        const scale = 1 - weights.stallProtection * Math.min(0.9, over * tuning.GAIN);
        controls.brakeL *= scale;
        controls.brakeR *= scale;
        if (controls.pitch > 0) controls.pitch *= scale;
        controls.yaw = axisValue(controls.yaw) * scale;
      }
    }
  },
});

registerAssistCatalog('paraglider', PARAGLIDER_ASSIST_CATALOG);
registerAssistHandler('paraglider', paragliderAssistHandler);

// ============================================================================================
// AUTOPILOT (kind 'paraglider'): holds a heading with weight shift and the inner brake, and a speed
// above trim with the speed bar. A paraglider cannot hold an altitude: it glides toward the heading.
// ============================================================================================
const AUTOPILOT = Object.freeze({
  TURN_GAIN: 0.022,
  RATE_GAIN: 0.35,
  TURN_LIMIT: 0.7,
  BRAKE_SHARE: 0.55,
  OUTPUT_SLEW: 2,
});

const paragliderAutopilot = Object.freeze({
  createMemory() {
    return { resetCount: -1, engaged: false, turn: 0 };
  },

  apply(controls, context, memory) {
    const autopilot = context.autopilot;
    if (!autopilot || !autopilot.enabled) {
      memory.engaged = false;
      return false;
    }
    const data = context.model.flightData;
    if (data.phase !== 'flight' || data.onGround) return false;
    if (!memory.engaged) {
      memory.engaged = true;
      memory.turn = 0;
    }
    const headingError = wrapSignedDegrees(autopilot.heading - data.heading);
    const command = clamp(AUTOPILOT.TURN_GAIN * headingError - AUTOPILOT.RATE_GAIN * data.yawRate, -AUTOPILOT.TURN_LIMIT, AUTOPILOT.TURN_LIMIT);
    memory.turn = moveToward(memory.turn, command, AUTOPILOT.OUTPUT_SLEW * context.dt);
    controls.roll = memory.turn;
    controls.pitch = 0;
    controls.yaw = 0;
    controls.brakeL = memory.turn < 0 ? -memory.turn * AUTOPILOT.BRAKE_SHARE : 0;
    controls.brakeR = memory.turn > 0 ? memory.turn * AUTOPILOT.BRAKE_SHARE : 0;
    const speed = Number.isFinite(autopilot.speed) ? autopilot.speed : 0;
    controls.throttle = speed > data.trimSpeed * 1.05 ? clamp((speed - data.trimSpeed) / Math.max(1, data.fullBarSpeed - data.trimSpeed), 0, 1) : 0;
    return true;
  },
});

registerAutopilotHandler('paraglider', paragliderAutopilot);

// ============================================================================================
// MODEL
// ============================================================================================
export function createSimParagliderModel({ profile, craft, bus, craftState: initialCraftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'paraglider';
  const pilotProfile = profile.pilot;
  const canopyProfile = profile.canopy;
  const wing = profile.wing;
  const controlProfile = profile.controls;
  const yawProfile = profile.yaw;
  const earsProfile = profile.bigEars;
  const collapseProfile = profile.collapse;
  const launchProfile = profile.launch;
  const pilotMass = pilotProfile.mass;
  const canopyGravityMass = canopyProfile.mass;
  const canopyMass = canopyProfile.mass + canopyProfile.airMass;
  const totalWeight = (pilotMass + canopyGravityMass) * GRAVITY;
  const lineLength = profile.lines.length;
  const inversePilot = 1 / pilotMass;
  const inverseCanopy = 1 / canopyMass;
  const inverseSum = 1 / (inversePilot + inverseCanopy);
  const halfArea = wing.area / 2;
  const span = wing.span;
  const curve = createLiftCurve({
    clAlpha: wing.clAlpha,
    clMax: wing.clMax,
    clMin: wing.clMin,
    alphaCritical: wing.alphaCritical,
    postStallDrop: wing.postStallDrop,
    dropWidth: wing.stallDropWidth,
    blendWidth: wing.stallBlendWidth,
  });
  const incidenceTrim = wing.incidence * DEG;
  const incidenceBrake = controlProfile.brakeIncidence * DEG;
  const incidenceBar = controlProfile.barIncidence * DEG;
  const incidenceEars = earsProfile.incidence * DEG;
  const brakePressureAoa = controlProfile.brakePressure * DEG;
  const weightShiftTilt = controlProfile.weightShiftTilt * DEG;
  const collapseAoa = collapseProfile.angle * DEG;
  const collapseSpan = collapseProfile.span * DEG;
  const gustAoa = collapseProfile.gust * DEG;
  const surgePitch = wing.surgePitch * DEG;
  const lyingAngle = launchProfile.lyingAngle * DEG;
  const origin = new THREE.Vector3();
  const targets = profile.targets;

  let craftState = initialCraftState;

  // ---- State ---------------------------------------------------------------------------------------
  const state = {
    /** Mesh origin = the pilot (world). */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    /** Body axes: up along the lines (upright while standing), forward along the canopy's heading. */
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s) from the attitude change: x nose up, y nose left, z right side up. */
    angularVelocity: new THREE.Vector3(),
  };
  /** The canopy (world): its aerodynamic centre and velocity. */
  const canopy = { position: new THREE.Vector3(), velocity: new THREE.Vector3() };
  const contact = createGroundContact(profile.contacts, { centerOfMass: origin, floats: limits.floats === true, mass: pilotMass });
  const landing = createLandingMonitor({ bus, craftId, limits });

  /** Everything else the wing and the pilot carry between ticks. */
  const wingState = {
    phase: 'flight',
    /** Canopy heading (rad, compass: 0 north, clockwise) and its yaw rate (rad/s). */
    heading: 0,
    yawRate: 0,
    /** Canopy incidence to the lines (rad) and the inflation (0 lying on the ground .. 1 flying). */
    incidence: incidenceTrim,
    inflation: 1,
    brakeLeft: 0,
    brakeRight: 0,
    speedBar: 0,
    weightShift: 0,
    earsFold: 0,
    collapseLeft: 0,
    collapseRight: 0,
    collapseCounted: false,
    collapses: 0,
    stallDepth: 0,
    tension: 0,
    barArmed: false,
    barBaseline: 0,
    landedSeconds: 0,
    groundSeconds: 0,
    slowSeconds: 0,
    offGroundSeconds: 0,
    launchInputSeconds: 0,
    launchSeconds: 0,
    launchAirborne: 0,
    pendulum: 0,
    pendulumRate: 0,
    pressureLeft: 0,
    pressureRight: 0,
    pressureTrendLeft: 0,
    pressureTrendRight: 0,
    previousPressureLeft: 0,
    previousPressureRight: 0,
    previousBrakeLeft: 0,
    previousBrakeRight: 0,
    bigEarsLatched: false,
    lastNotify: -Infinity,
  };
  const climb = { active: false, holdSeconds: 0, exitSeconds: 0, lowest: 0, highest: 0, bestAverage: 0, smoothed: 0, sampleTimer: 0, samples: new Float64Array(CLIMB.WINDOW + 1), sampleCount: 0, sampleHead: 0, average: 0 };
  /**
   * Doubles written every tick live in object fields: a double closure variable would be boxed on
   * every write (an allocation per tick).
   */
  const clock = { time: 0, load: 1, horizontal: 0, sink: 0 };
  /**
   * This tick's inputs, shared by the step's parts through fields rather than arguments (a double
   * passed to or returned from a call that is not inlined is boxed: an allocation per call).
   */
  const tick = {
    dt: 1 / 120,
    subDt: 1 / (120 * SUBSTEPS),
    rho: SEA_LEVEL_DENSITY,
    turbulence: 0,
    canopyTurbulence: 0,
    gustScale: 0,
    aeroShare: 1,
    inducedScale: 1,
    kinematic: false,
    tensionImpulse: 0,
    lineSpan: lineLength,
    agl: 0,
    surface: 0,
    surfaceAge: 0,
  };
  /** The span-scale gusts this tick (rad): the common part and each half's. */
  const gusts = { common: 0, left: 0, right: 0 };
  const observeArgs = { dt: 1 / 120, agl: 0, position: null };
  let resetCount = 0;

  /** Mesh animation (the controller passes these to the mesh as visual.aileron / elevator / rudder). */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  const flightData = {
    phase: 'flight',
    airspeed: 0,
    aoa: 0,
    aoaCritical: curve.alphaZero + curve.clMax / curve.clAlpha,
    stallMargin: 0,
    stallDepth: 0,
    stalled: false,
    sideslip: 0,
    bank: 0,
    pitch: 0,
    heading: 0,
    yawRate: 0,
    verticalSpeed: 0,
    flightPath: 0,
    gLoad: 1,
    onGround: false,
    agl: Infinity,
    glideRatio: 0,
    liftToDrag: 0,
    dynamicPressure: 0,
    pendulum: 0,
    pendulumRate: 0,
    collapseLeft: 0,
    collapseRight: 0,
    collapseAoa,
    brakePressureAoa,
    pressureLeft: 0,
    pressureRight: 0,
    pressureTrendLeft: 0,
    pressureTrendRight: 0,
    brakeLeft: 0,
    brakeRight: 0,
    speedBar: 0,
    earsFold: 0,
    inflation: 1,
    lineTension: 0,
    trimSpeed: targets.trimSpeed,
    fullBarSpeed: targets.fullBarSpeed,
    mass: pilotMass + canopyGravityMass,
    resetCount: 0,
    // Read by the shared autopilot stage (fixed-wing fields it looks for) so it degrades gracefully.
    hasEngine: false,
    engineRunning: false,
    gLimit: Number.isFinite(limits.gLimit) ? limits.gLimit : 5,
    vne: Number.isFinite(limits.vne) ? limits.vne : 22,
  };

  // ---- Scratch ------------------------------------------------------------------------------------------
  const pilotAir = new THREE.Vector3();
  const canopyAir = new THREE.Vector3();
  const canopyWind = { vel: new THREE.Vector3(), turbulence: 0 };
  const probePoint = new THREE.Vector3();
  const lineDirection = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const headingVector = new THREE.Vector3();
  const canopyForce = new THREE.Vector3();
  const pilotForce = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const runForce = new THREE.Vector3();
  const upVector = new THREE.Vector3();
  const bodyRight = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const previousQuaternion = new THREE.Quaternion();
  const deltaQuaternion = new THREE.Quaternion();
  const inverseQuaternion = new THREE.Quaternion();
  const offsetScratch = new THREE.Vector3();
  const previousCanopy = new THREE.Vector3();
  const contactBody = { position: state.position, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 1, brakeRight: 1, steering: 0, gearDown: true };
  /** One wing half's aerodynamics this substep (index 0 left, 1 right). */
  const halves = [
    { side: -1, brake: 0, alpha: 0, pressure: 0, cl: 0, cd: 0, lift: 0, drag: 0, open: 1, stall: 0, stallAngle: 0, deficitSeconds: 0 },
    { side: 1, brake: 0, alpha: 0, pressure: 0, cl: 0, cd: 0, lift: 0, drag: 0, open: 1, stall: 0, stallAngle: 0, deficitSeconds: 0 },
  ];
  const aero = { airspeed: 0, alpha: 0, sideslip: 0, dynamicPressure: 0, lift: 0, drag: 0, yawMoment: 0 };
  const canopyOffsetOut = [0, lineLength, 0];

  function notify(text, kind = 'info', throttle = false) {
    if (throttle && clock.time - wingState.lastNotify < NOTIFY_INTERVAL) return;
    wingState.lastNotify = clock.time;
    bus.emit('notify', { text, kind });
  }

  function setPhase(phase) {
    wingState.phase = phase;
    flightData.phase = phase;
  }

  // ============================================================================================
  // INPUTS
  // ============================================================================================
  function handleActions(controls) {
    if (!controls.actions || controls.actions.size === 0) return;
    for (const action of controls.actions) {
      switch (action) {
        case 'airbrake':
          wingState.bigEarsLatched = !wingState.bigEarsLatched;
          if (!controls.quietActions || !controls.quietActions.has(action)) notify(wingState.bigEarsLatched ? 'Big ears in: steer with your weight, the speed bar keeps the wing flying.' : 'Big ears out.');
          break;
        case 'engineToggle':
          notify('No engine on a paraglider: thermals and ridges carry you.');
          break;
        case 'gearToggle':
          notify('No gear: your legs are the gear. Stand up in the harness before you land.');
          break;
        case 'flapsUp':
        case 'flapsDown':
          notify('No flaps: both brakes slow the wing down, the speed bar speeds it up.');
          break;
        case 'chuteDeploy':
          notify('No reserve on this rig: release the brakes and let the wing fly itself out of trouble.');
          break;
        default:
          break;
      }
    }
  }

  /**
   * The pilot's brakes, speed bar and weight shift (lagged: arms and legs take time). Toe brakes act
   * directly; the pedals (yaw) pull one side; the stick pulled back pulls both; pushing it presses the
   * bar, as do the throttle lever and released trimmers (the rocker forward). On the ground after a
   * touchdown the pilot holds both brakes down: the wing is killed and drops behind.
   */
  function updatePilotInputs(controls) {
    const dt = tick.dt;
    const toeLeft = unitValue(controls.brakeL);
    const toeRight = unitValue(controls.brakeR);
    const pitch = axisValue(controls.pitch);
    const yaw = axisValue(controls.yaw);
    const both = Math.max(0, pitch);
    const killed = wingState.phase === 'landed' || (wingState.phase === 'flight' && wingState.groundSeconds > KILL_SECONDS) ? 1 : 0;
    const leftTarget = Math.min(1, Math.max(toeLeft, both + Math.max(0, -yaw), killed));
    const rightTarget = Math.min(1, Math.max(toeRight, both + Math.max(0, yaw), killed));
    const brakeStep = controlProfile.brakeRate * dt;
    wingState.brakeLeft = moveToward(wingState.brakeLeft, leftTarget, brakeStep);
    wingState.brakeRight = moveToward(wingState.brakeRight, rightTarget, brakeStep);
    const lever = unitValue(controls.throttle);
    if (!wingState.barArmed && (lever <= BAR_IDLE || Math.abs(lever - wingState.barBaseline) > BAR_ARM_TRAVEL)) wingState.barArmed = true;
    const trimmers = Math.max(0, -axisValue(controls.trim)) * controlProfile.trimmerShare;
    const barTarget = Math.min(1, Math.max(wingState.barArmed ? lever : 0, Math.max(0, -pitch), trimmers));
    wingState.speedBar = moveToward(wingState.speedBar, barTarget, controlProfile.barRate * dt);
    wingState.weightShift = moveToward(wingState.weightShift, axisValue(controls.roll), controlProfile.weightShiftRate * dt);
    const ears = Boolean(craftState && craftState.bigEars) || wingState.bigEarsLatched;
    wingState.earsFold = moveToward(wingState.earsFold, ears && wingState.phase === 'flight' ? 1 : 0, dt / (ears ? earsProfile.foldSeconds : earsProfile.openSeconds));
  }

  // ============================================================================================
  // CANOPY FRAME AND AERODYNAMICS
  // ============================================================================================
  /**
   * Line direction, canopy forward and right (world), and the line span (tick.lineSpan). Written out
   * by component, like the other per-substep vector math here, so nothing is boxed.
   */
  function computeCanopyFrame() {
    let lineX = canopy.position.x - state.position.x;
    let lineY = canopy.position.y - state.position.y;
    let lineZ = canopy.position.z - state.position.z;
    const length = Math.sqrt(lineX * lineX + lineY * lineY + lineZ * lineZ);
    tick.lineSpan = length;
    if (length > 0.3) {
      lineX /= length;
      lineY /= length;
      lineZ /= length;
    } else {
      lineX = 0;
      lineY = 1;
      lineZ = 0;
    }
    lineDirection.x = lineX;
    lineDirection.y = lineY;
    lineDirection.z = lineZ;
    const headingX = Math.sin(wingState.heading);
    const headingZ = -Math.cos(wingState.heading);
    const along = headingX * lineX + headingZ * lineZ;
    let forwardX = headingX - along * lineX;
    let forwardY = -along * lineY;
    let forwardZ = headingZ - along * lineZ;
    const forwardLength = Math.sqrt(forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ);
    if (forwardLength < 1e-3) {
      forwardX = 0;
      forwardY = 0;
      forwardZ = -1;
    } else {
      forwardX /= forwardLength;
      forwardY /= forwardLength;
      forwardZ /= forwardLength;
    }
    forward.x = forwardX;
    forward.y = forwardY;
    forward.z = forwardZ;
    // right = forward x line
    let rightX = forwardY * lineZ - forwardZ * lineY;
    let rightY = forwardZ * lineX - forwardX * lineZ;
    let rightZ = forwardX * lineY - forwardY * lineX;
    const rightLength = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ) || 1;
    rightX /= rightLength;
    rightY /= rightLength;
    rightZ /= rightLength;
    right.x = rightX;
    right.y = rightY;
    right.z = rightZ;
  }

  /**
   * The span-scale gusts the WindField does not resolve (once per tick): a common part and one per
   * half, smooth deterministic noise scaled by the turbulence at the canopy.
   */
  function updateGusts() {
    const scale = tick.gustScale;
    if (scale <= 0) {
      gusts.common = 0;
      gusts.left = 0;
      gusts.right = 0;
      return;
    }
    const phase = clock.time * collapseProfile.frequency * 6.2832;
    const common = phase * 0.7;
    gusts.common = scale * 0.5 * (0.55 * Math.sin(common + 5.1) + 0.3 * Math.sin(common * 2.37 + 8.67) + 0.15 * Math.sin(common * 4.91 + 14.79));
    gusts.left = gusts.common + scale * (0.55 * Math.sin(phase + 0.4) + 0.3 * Math.sin(phase * 2.37 + 0.68) + 0.15 * Math.sin(phase * 4.91 + 1.16));
    const rightPhase = phase * 1.13;
    gusts.right = gusts.common + scale * (0.55 * Math.sin(rightPhase + 2.9) + 0.3 * Math.sin(rightPhase * 2.37 + 4.93) + 0.15 * Math.sin(rightPhase * 4.91 + 8.41));
  }

  /**
   * The lift curve of a half (createLiftCurve's shape: linear up to the stall, a post-stall drop, then
   * a flat plate), written into the half's fields: the brake's camber shifts the curve and its stall.
   */
  function halfLift(half) {
    const deltaCl = controlProfile.brakeCl * half.brake;
    const clMax = curve.clMax + controlProfile.brakeClMax * half.brake;
    const stallPositive = curve.alphaZero + (clMax - deltaCl) / curve.clAlpha;
    const stallNegative = curve.alphaZero + (curve.clMin - deltaCl) / curve.clAlpha;
    const alpha = half.alpha;
    half.stallAngle = stallPositive;
    if (alpha >= stallNegative && alpha <= stallPositive) {
      half.cl = curve.clAlpha * (alpha - curve.alphaZero) + deltaCl;
      half.stall = 0;
      return;
    }
    const plate = FLAT_PLATE_LIFT * Math.sin(2 * alpha);
    const beyond = alpha > stallPositive ? alpha - stallPositive : stallNegative - alpha;
    const depth = smoothstep(0, curve.dropWidth, beyond);
    const toPlate = smoothstep(curve.dropWidth, curve.dropWidth + curve.blendWidth, beyond);
    const dropped = alpha > stallPositive ? clMax - curve.postStallDrop * depth : curve.clMin + curve.postStallDrop * 0.8 * depth;
    half.cl = dropped + (plate - dropped) * toPlate;
    half.stall = depth;
  }

  /** One half's angle of attack, open share, polar, lift and drag (aero.alpha and aero.dynamicPressure set). */
  function halfAerodynamics(half) {
    const left = half.side < 0;
    const brake = left ? wingState.brakeLeft : wingState.brakeRight;
    const collapse = left ? wingState.collapseLeft : wingState.collapseRight;
    half.brake = brake;
    half.alpha = aero.alpha + (left ? gusts.left : gusts.right);
    half.pressure = half.alpha + brakePressureAoa * brake;
    halfLift(half);
    const open = Math.min(1, Math.max(0.05, 1 - earsProfile.share * wingState.earsFold - collapseProfile.share * collapse));
    const folded = 1 - open;
    const cl = half.cl;
    const tangent = Math.tan(Math.min(1.4, Math.max(-1.4, half.alpha)));
    const separated = Math.min(1.3, Math.abs(cl * tangent) + 0.02);
    const induced = wing.inducedDrag * cl * cl * tick.inducedScale;
    const cd = wing.cd0 + induced + half.stall * Math.max(0, separated - induced) + controlProfile.brakeDrag * brake * brake;
    const load = aero.dynamicPressure * halfArea * tick.aeroShare;
    half.open = open;
    half.cd = cd;
    half.lift = load * open * cl;
    half.drag = load * (open * cd + folded * (collapse > 0 ? collapseProfile.foldDrag : earsProfile.foldDrag));
  }

  /**
   * Aerodynamic force on the canopy (world, into canopyForce) and its yaw moment (aero.yawMoment),
   * from the canopy's airflow canopyAir (canopy velocity minus the wind there). Each half has its own
   * angle of attack (gusts, brake), open share (big ears, collapse) and polar.
   */
  function canopyAerodynamics() {
    const airX = canopyAir.x;
    const airY = canopyAir.y;
    const airZ = canopyAir.z;
    const airspeed = Math.sqrt(airX * airX + airY * airY + airZ * airZ);
    aero.airspeed = airspeed;
    aero.yawMoment = 0;
    canopyForce.x = 0;
    canopyForce.y = 0;
    canopyForce.z = 0;
    if (airspeed < MIN_AIRSPEED || tick.aeroShare <= 0) {
      aero.alpha = wingState.incidence;
      aero.sideslip = 0;
      aero.dynamicPressure = 0;
      aero.lift = 0;
      aero.drag = 0;
      for (let index = 0; index < 2; index++) {
        const half = halves[index];
        half.alpha = aero.alpha;
        half.pressure = aero.alpha;
        half.lift = 0;
        half.drag = 0;
        half.stall = 0;
      }
      return;
    }
    // The chord leans nose up from the line-perpendicular by the incidence; the normal is the canopy's up.
    const cosine = Math.cos(wingState.incidence);
    const sine = Math.sin(wingState.incidence);
    const chordX = forward.x * cosine + lineDirection.x * sine;
    const chordY = forward.y * cosine + lineDirection.y * sine;
    const chordZ = forward.z * cosine + lineDirection.z * sine;
    const normalX = lineDirection.x * cosine - forward.x * sine;
    const normalY = lineDirection.y * cosine - forward.y * sine;
    const normalZ = lineDirection.z * cosine - forward.z * sine;
    const directionX = airX / airspeed;
    const directionY = airY / airspeed;
    const directionZ = airZ / airspeed;
    const rightX = right.x;
    const rightY = right.y;
    const rightZ = right.z;
    const sideslip = Math.asin(Math.min(1, Math.max(-1, directionX * rightX + directionY * rightY + directionZ * rightZ)));
    const dynamicPressure = 0.5 * tick.rho * airspeed * airspeed;
    aero.alpha = Math.atan2(-(airX * normalX + airY * normalY + airZ * normalZ), airX * chordX + airY * chordY + airZ * chordZ);
    aero.sideslip = sideslip;
    aero.dynamicPressure = dynamicPressure;
    // Lift: perpendicular to the airflow and the span (right x airflow).
    let liftX = rightY * directionZ - rightZ * directionY;
    let liftY = rightZ * directionX - rightX * directionZ;
    let liftZ = rightX * directionY - rightY * directionX;
    const liftLength = Math.sqrt(liftX * liftX + liftY * liftY + liftZ * liftZ);
    if (liftLength > 1e-6) {
      liftX /= liftLength;
      liftY /= liftLength;
      liftZ /= liftLength;
    } else {
      liftX = lineDirection.x;
      liftY = lineDirection.y;
      liftZ = lineDirection.z;
    }
    const openAverage = 1 - earsProfile.share * wingState.earsFold - 0.5 * collapseProfile.share * (wingState.collapseLeft + wingState.collapseRight);
    tick.inducedScale = 1 / Math.max(0.35, openAverage * openAverage);
    const leftHalf = halves[0];
    const rightHalf = halves[1];
    halfAerodynamics(leftHalf);
    halfAerodynamics(rightHalf);
    const liftTotal = leftHalf.lift + rightHalf.lift;
    const dragTotal = leftHalf.drag + rightHalf.drag;
    aero.lift = liftTotal;
    aero.drag = dragTotal;
    const share = tick.aeroShare;
    // Sideways: the arched wing's side force against the sideslip, and the roll of the canopy over the
    // pilot from a lift difference between the halves and from the pilot's weight shift (which loads
    // one riser group and warps the wing).
    const sideForce = -dynamicPressure * wing.area * wing.sideForce * Math.sin(sideslip) * share
      + (leftHalf.lift - rightHalf.lift) * (wing.rollArm / lineLength)
      + liftTotal * Math.sin(weightShiftTilt * wingState.weightShift);
    canopyForce.x = liftX * liftTotal - directionX * dragTotal + rightX * sideForce;
    canopyForce.y = liftY * liftTotal - directionY * dragTotal + rightY * sideForce;
    canopyForce.z = liftZ * liftTotal - directionZ * dragTotal + rightZ * sideForce;
    // Yaw: the drag difference between the halves, weathervane into the relative wind, rate damping,
    // and the warp of a weight shift.
    const reference = Math.max(airspeed, 4);
    const qSb = dynamicPressure * wing.area * span * share;
    aero.yawMoment = wing.yawArm * (rightHalf.drag - leftHalf.drag)
      + qSb * (yawProfile.weathervane * Math.sin(sideslip) - yawProfile.damping * (span / (2 * reference)) * wingState.yawRate + yawProfile.weightShift * wingState.weightShift);
  }

  /** One half's collapse: onset below the collapse angle (in turbulence), reinflation otherwise. */
  function halfCollapse(half) {
    const dt = tick.dt;
    const left = half.side < 0;
    let collapse = left ? wingState.collapseLeft : wingState.collapseRight;
    const brake = left ? wingState.brakeLeft : wingState.brakeRight;
    const previousBrake = left ? wingState.previousBrakeLeft : wingState.previousBrakeRight;
    const airspeed = aero.airspeed;
    const deficit = collapseAoa - half.pressure;
    half.deficitSeconds = deficit > 0 ? half.deficitSeconds + dt : 0;
    if (deficit > 0 && half.deficitSeconds >= collapseProfile.onsetDelay && airspeed > collapseProfile.minAirspeed) {
      const depth = Math.min(collapseProfile.maxDepth, deficit / collapseSpan) * Math.min(1, 0.4 + tick.canopyTurbulence);
      if (depth > collapse) collapse = moveToward(collapse, depth, collapseProfile.onsetRate * dt);
    } else if (collapse > 0) {
      const pumping = Math.abs(brake - previousBrake) / dt;
      const held = brake > 0.25 && brake < 0.8 ? collapseProfile.brakeRecover : 0;
      const rate = collapseProfile.recoverRate * Math.min(1.3, Math.max(0.3, airspeed / targets.trimSpeed)) + collapseProfile.pumpRecover * Math.min(1, pumping / 2) + held;
      collapse = Math.max(0, collapse - rate * dt);
    }
    if (left) wingState.collapseLeft = collapse;
    else wingState.collapseRight = collapse;
  }

  /** Both halves' collapses, and the count, the warning and the journal entry once one is flown out. */
  function updateCollapses() {
    halfCollapse(halves[0]);
    halfCollapse(halves[1]);
    wingState.previousBrakeLeft = wingState.brakeLeft;
    wingState.previousBrakeRight = wingState.brakeRight;
    const deepest = Math.max(wingState.collapseLeft, wingState.collapseRight);
    if (!wingState.collapseCounted && deepest > collapseProfile.countDepth) {
      wingState.collapseCounted = true;
      wingState.collapses++;
      const leftSide = wingState.collapseLeft >= wingState.collapseRight;
      notify(leftSide ? 'Left side collapse! Weight shift and brake right to fly straight, pump the left brake.' : 'Right side collapse! Weight shift and brake left to fly straight, pump the right brake.', 'warning', true);
    } else if (wingState.collapseCounted && deepest <= 0) {
      wingState.collapseCounted = false;
      bus.emitTyped('journalStat', { key: 'paragliderCollapses', value: 1, op: 'add' });
    }
  }

  /**
   * The incidence target (rigging, brakes, bar, ears, the canopy's pitch inertia against the swing,
   * the surge out of a stall) and its lag.
   */
  function updateIncidence() {
    const symmetric = Math.min(wingState.brakeLeft, wingState.brakeRight) + 0.25 * Math.abs(wingState.brakeRight - wingState.brakeLeft);
    let target = incidenceTrim + incidenceBrake * symmetric - incidenceBar * wingState.speedBar + incidenceEars * wingState.earsFold;
    // The canopy's own pitch inertia: as the lines swing forward the wing lags nose up against them.
    target += wing.pitchInertia * Math.max(-1.5, Math.min(1.5, wingState.pendulumRate));
    // Out of a stall with the brakes coming up the canopy falls forward and dives to fly again.
    if (wingState.stallDepth > 0 && symmetric < wing.surgeBrake) target -= surgePitch * wingState.stallDepth * (1 - symmetric / wing.surgeBrake);
    wingState.incidence += (target - wingState.incidence) * (1 - Math.exp(-tick.dt / wing.incidenceLag));
  }

  /** Probes the air at the canopy (the WindField when the environment has it). */
  function sampleCanopyWind(env) {
    const field = env.windField;
    if (field && typeof field.probe === 'function') {
      probePoint.copy(canopy.position);
      // At the field's own flight-clock time (the frame's, within a tick of env.time): a time passed
      // in would be boxed every tick, and the air changes far more slowly than that.
      field.probe(probePoint, undefined, canopyWind);
      // Finite in every component (a NaN or an infinity anywhere makes the difference NaN).
      const sum = canopyWind.vel.x + canopyWind.vel.y + canopyWind.vel.z;
      if (sum - sum === 0) return;
    }
    if (env.wind && env.wind.vel) canopyWind.vel.copy(env.wind.vel);
    else canopyWind.vel.set(0, 0, 0);
    canopyWind.turbulence = tick.turbulence;
  }

  // ============================================================================================
  // LAUNCH (inflating the wing and running)
  // ============================================================================================
  /** Starts a launch run from the ground: the pilot faces downhill (or keeps the heading on the flat). */
  function beginLaunch(env) {
    if (contact.report.floating || contact.report.water) {
      notify('You cannot launch from the water. A relaunch takes you back to a slope.', 'info');
      return;
    }
    const x = state.position.x;
    const z = state.position.z;
    const probe = 6;
    const gradientX = (env.groundHeight(x + probe, z) - env.groundHeight(x - probe, z)) / (2 * probe);
    const gradientZ = (env.groundHeight(x, z + probe) - env.groundHeight(x, z - probe)) / (2 * probe);
    const grade = Math.sqrt(gradientX * gradientX + gradientZ * gradientZ);
    if (grade > launchProfile.minGrade) wingState.heading = wrapSignedRadians(headingFromVector(-gradientX, -gradientZ) * DEG);
    setPhase('launch');
    wingState.inflation = 0;
    wingState.launchSeconds = 0;
    wingState.launchAirborne = 0;
    wingState.launchInputSeconds = 0;
    wingState.yawRate = 0;
    placeCanopyForInflation();
    canopy.velocity.copy(state.velocity);
    notify(grade > launchProfile.minGrade ? 'Inflating: run down the slope!' : 'Inflating on the flat: it needs a breeze to lift you.', 'info');
  }

  /** The canopy on its inflation arc (wingState.inflation): lying behind the pilot (0) to over the pilot at the trim (1). */
  function placeCanopyForInflation() {
    const eased = smoothstep(0, 1, wingState.inflation);
    const angle = lyingAngle * (1 - eased) - launchProfile.trimTilt * DEG * eased;
    headingVector.set(Math.sin(wingState.heading), 0, -Math.cos(wingState.heading));
    canopy.position.copy(state.position)
      .addScaledVector(headingVector, -Math.sin(angle) * lineLength)
      .addScaledVector(WORLD_UP, Math.cos(angle) * lineLength);
  }

  /** The run: the pilot's legs push along the heading over the ground up to the running speed. */
  function addRunForce(env) {
    runForce.set(0, 0, 0);
    if (wingState.phase !== 'launch' || !contact.report.onGround) return;
    headingVector.set(Math.sin(wingState.heading), 0, -Math.cos(wingState.heading));
    const x = state.position.x;
    const z = state.position.z;
    const rise = env.groundHeight(x + headingVector.x * 2, z + headingVector.z * 2) - env.groundHeight(x - headingVector.x * 2, z - headingVector.z * 2);
    runForce.set(headingVector.x * 4, rise, headingVector.z * 4).normalize();
    const along = state.velocity.dot(runForce);
    runForce.multiplyScalar(pilotMass * launchProfile.runAccel * Math.min(1, Math.max(0, (launchProfile.runSpeed - along) / 1.5)));
    // The rising wing pulls back on the pilot until it is overhead.
    const pull = launchProfile.inflationPull * Math.sin(Math.PI * Math.min(1, Math.max(0, wingState.inflation)));
    runForce.addScaledVector(headingVector, -pull);
  }

  function updateLaunch() {
    const dt = tick.dt;
    wingState.launchSeconds += dt;
    if (wingState.inflation < 1) {
      const airspeed = pilotAir.length();
      const airborne = !contact.report.onGround;
      const rate = (0.35 + 0.65 * smoothstep(0, launchProfile.inflateAirspeed, airspeed)) * (airborne ? 4 : 1) / launchProfile.inflateSeconds;
      previousCanopy.copy(canopy.position);
      wingState.inflation = Math.min(1, wingState.inflation + rate * dt);
      placeCanopyForInflation();
      if (wingState.inflation >= 1) canopy.velocity.copy(state.velocity);
      else canopy.velocity.copy(canopy.position).sub(previousCanopy).divideScalar(dt);
    }
    if (!contact.report.onGround) wingState.launchAirborne += dt;
    else wingState.launchAirborne = 0;
    if (wingState.inflation >= 1 && wingState.launchAirborne >= LAUNCH_AIRBORNE_SECONDS) {
      setPhase('flight');
      landing.reset(false);
      bus.emitTyped('journalStat', { key: 'paragliderSlopeLaunches', value: 1, op: 'add' });
      notify('Airborne! Hands up, let the wing fly.', 'success');
    } else if (wingState.launchSeconds > launchProfile.abortSeconds && contact.report.onGround) {
      setPhase('landed');
      wingState.landedSeconds = 0;
      notify('Not enough slope or wind to launch here. Find a slope, or relaunch for the nearest peak.', 'warning');
    }
  }

  // ============================================================================================
  // STEP
  // ============================================================================================
  /** Launch requests and the pilot's own launch input (push or bar held) while landed. */
  function checkLaunchRequest(controls, env) {
    if (wingState.phase !== 'landed') {
      if (craftState && craftState.launchRequested) craftState.launchRequested = false;
      return;
    }
    const requested = Boolean(craftState && craftState.launchRequested);
    if (craftState) craftState.launchRequested = false;
    const pushing = axisValue(controls.pitch) < -LAUNCH_INPUT.PUSH || (wingState.barArmed && unitValue(controls.throttle) > LAUNCH_INPUT.BAR);
    wingState.launchInputSeconds = pushing ? wingState.launchInputSeconds + tick.dt : 0;
    if ((requested || wingState.launchInputSeconds >= LAUNCH_INPUT.SECONDS) && contact.report.onGround) beginLaunch(env);
  }

  /** The pilot's forces this substep: weight, drag, the ground, the run (into pilotForce). */
  function pilotForces() {
    const pilotAirspeed = Math.sqrt(pilotAir.x * pilotAir.x + pilotAir.y * pilotAir.y + pilotAir.z * pilotAir.z);
    const drag = -0.5 * tick.rho * pilotProfile.dragArea * pilotAirspeed;
    pilotForce.x = pilotAir.x * drag + groundForce.x + runForce.x;
    pilotForce.y = pilotAir.y * drag + groundForce.y + runForce.y - pilotMass * GRAVITY;
    pilotForce.z = pilotAir.z * drag + groundForce.z + runForce.z;
  }

  /** The lines in this substep: no separating velocity along them (an impulse shared by mass). */
  function lineImpulse() {
    const subDt = tick.subDt;
    let separationX = canopy.position.x + canopy.velocity.x * subDt - state.position.x - state.velocity.x * subDt;
    let separationY = canopy.position.y + canopy.velocity.y * subDt - state.position.y - state.velocity.y * subDt;
    let separationZ = canopy.position.z + canopy.velocity.z * subDt - state.position.z - state.velocity.z * subDt;
    const distance = Math.sqrt(separationX * separationX + separationY * separationY + separationZ * separationZ);
    if (distance <= lineLength) return;
    separationX /= distance;
    separationY /= distance;
    separationZ /= distance;
    const separating = (canopy.velocity.x - state.velocity.x) * separationX + (canopy.velocity.y - state.velocity.y) * separationY + (canopy.velocity.z - state.velocity.z) * separationZ;
    if (separating <= 0) return;
    const impulse = separating * inverseSum;
    const pilotShare = impulse * inversePilot;
    const canopyShare = impulse * inverseCanopy;
    state.velocity.x += separationX * pilotShare;
    state.velocity.y += separationY * pilotShare;
    state.velocity.z += separationZ * pilotShare;
    canopy.velocity.x -= separationX * canopyShare;
    canopy.velocity.y -= separationY * canopyShare;
    canopy.velocity.z -= separationZ * canopyShare;
    tick.tensionImpulse += impulse;
  }

  /** The canopy's yaw: its heading integrated with this substep's moment (frozen while it is not flying). */
  function integrateYaw() {
    if (tick.kinematic || wingState.inflation <= 0.5) {
      wingState.yawRate = 0;
      return;
    }
    const subDt = tick.subDt;
    wingState.yawRate = Math.min(MAX_YAW_RATE, Math.max(-MAX_YAW_RATE, wingState.yawRate + (aero.yawMoment / yawProfile.inertia) * subDt));
    wingState.heading = wrapSignedRadians(wingState.heading + wingState.yawRate * subDt);
  }

  /** Caps a velocity at MAX_SPEED and moves a position along it for one substep. */
  function advance(position, velocity) {
    const speedSquared = velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
    if (speedSquared > MAX_SPEED * MAX_SPEED) {
      const scale = MAX_SPEED / Math.sqrt(speedSquared);
      velocity.x *= scale;
      velocity.y *= scale;
      velocity.z *= scale;
    }
    const subDt = tick.subDt;
    position.x += velocity.x * subDt;
    position.y += velocity.y * subDt;
    position.z += velocity.z * subDt;
  }

  /** One substep of both bodies, the lines and the canopy's yaw. */
  function integrateSubstep(env, first) {
    const subDt = tick.subDt;
    pilotAir.copy(state.velocity);
    if (env.wind && env.wind.vel) pilotAir.sub(env.wind.vel);
    canopyAir.copy(canopy.velocity).sub(canopyWind.vel);
    computeCanopyFrame();
    if (first) updateIncidence();
    canopyAerodynamics();
    pilotForces();
    const pilotScale = subDt * inversePilot;
    state.velocity.x += pilotForce.x * pilotScale;
    state.velocity.y += pilotForce.y * pilotScale;
    state.velocity.z += pilotForce.z * pilotScale;
    if (!tick.kinematic) {
      canopyForce.y -= canopyGravityMass * GRAVITY;
      const canopyScale = subDt * inverseCanopy;
      canopy.velocity.x += canopyForce.x * canopyScale;
      canopy.velocity.y += canopyForce.y * canopyScale;
      canopy.velocity.z += canopyForce.z * canopyScale;
      lineImpulse();
    }
    advance(state.position, state.velocity);
    if (!tick.kinematic) {
      advance(canopy.position, canopy.velocity);
      projectLines();
      restCanopyOnSurface(env);
    }
    integrateYaw();
  }

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    tick.dt = dt;
    tick.subDt = dt / SUBSTEPS;
    tick.rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    tick.turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    clock.time += dt;
    if (env.craftState && env.craftState !== craftState) craftState = env.craftState;
    handleActions(controls);
    updatePilotInputs(controls);
    previousQuaternion.copy(state.quaternion);
    checkLaunchRequest(controls, env);

    // Ground contact (once per tick): the feet are a braked wheel while standing, free while running.
    const running = wingState.phase === 'launch' || (wingState.phase === 'flight' && state.velocity.lengthSq() > LANDED_SPEED * LANDED_SPEED);
    contactInputs.brakeLeft = running ? 0 : wingState.phase === 'flight' ? 0.6 : 1;
    contactInputs.brakeRight = contactInputs.brakeLeft;
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    const report = contact.report;

    // The air at both bodies, the gusts across the span, the launch run.
    sampleCanopyWind(env);
    tick.canopyTurbulence = Math.max(tick.turbulence, canopyWind.turbulence);
    if (wingState.phase === 'launch') updateLaunch();
    addRunForce(env);
    tick.kinematic = wingState.phase === 'launch' && wingState.inflation < 1;
    tick.aeroShare = tick.kinematic ? 0 : wingState.phase === 'landed' ? wingState.inflation * wingState.inflation : 1;
    tick.gustScale = tick.kinematic ? 0 : gustAoa * tick.canopyTurbulence;
    updateGusts();
    tick.tensionImpulse = 0;
    for (let substep = 0; substep < SUBSTEPS; substep++) integrateSubstep(env, substep === 0);
    if (tick.kinematic) placeCanopyForInflation();
    wingState.tension = tick.tensionImpulse / dt;

    updateCollapses();
    updateStall();
    updateAttitude();
    updateGroundPhase(report, env);
    // The surface under the pilot: every tick near the ground, every SURFACE_PROBE_TICKS ticks higher up.
    tick.surfaceAge++;
    if (tick.surfaceAge >= SURFACE_PROBE_TICKS || tick.agl < SURFACE_PROBE_AGL) {
      tick.surfaceAge = 0;
      tick.surface = surfaceHeightAt(env, state.position.x, state.position.z);
    }
    tick.agl = state.position.y - tick.surface;
    updateFlightData(report);
    updateClimb();
    observeArgs.dt = dt;
    observeArgs.agl = tick.agl;
    observeArgs.position = state.position;
    landing.observe(report, observeArgs);
    writeCraftState();
  }

  /** Keeps the lines at most their length (a projection shared by mass; slack lines are left alone). */
  function projectLines() {
    let separationX = canopy.position.x - state.position.x;
    let separationY = canopy.position.y - state.position.y;
    let separationZ = canopy.position.z - state.position.z;
    const distance = Math.sqrt(separationX * separationX + separationY * separationY + separationZ * separationZ);
    if (distance <= lineLength) return;
    const excess = distance - lineLength;
    separationX /= distance;
    separationY /= distance;
    separationZ /= distance;
    const pilotShare = excess * inversePilot * inverseSum;
    const canopyShare = excess * inverseCanopy * inverseSum;
    state.position.x += separationX * pilotShare;
    state.position.y += separationY * pilotShare;
    state.position.z += separationZ * pilotShare;
    canopy.position.x -= separationX * canopyShare;
    canopy.position.y -= separationY * canopyShare;
    canopy.position.z -= separationZ * canopyShare;
  }

  /** A canopy that comes down (landed, killed, deep in a stall near the ground) lies on the surface. */
  function restCanopyOnSurface(env) {
    if (canopy.position.y - state.position.y > lineLength * 0.6 && tick.agl > 3) return;
    const floor = surfaceHeightAt(env, canopy.position.x, canopy.position.z) + CANOPY_REST_HEIGHT;
    if (canopy.position.y >= floor) return;
    canopy.position.y = floor;
    if (canopy.velocity.y < 0) canopy.velocity.y = 0;
    const friction = Math.exp(-launchProfile.groundFriction * tick.subDt);
    canopy.velocity.x *= friction;
    canopy.velocity.z *= friction;
  }

  function updateStall() {
    const depth = Math.max(halves[0].stall, halves[1].stall);
    wingState.stallDepth = wingState.phase === 'flight' && wingState.inflation >= 1 ? depth : 0;
  }

  /**
   * The body attitude: up along the lines once they carry the pilot (upright while standing), forward
   * along the canopy heading; the body rates from the change since the last tick.
   */
  function updateAttitude() {
    const dt = tick.dt;
    computeCanopyFrame();
    const ramp = Math.min(1, Math.max(0, (wingState.tension / totalWeight - HANG_TENSION.FROM) / (HANG_TENSION.FULL - HANG_TENSION.FROM)));
    const hang = tick.lineSpan > lineLength * 0.5 ? ramp * ramp * (3 - 2 * ramp) : 0;
    let upX = lineDirection.x * hang;
    let upY = 1 + (lineDirection.y - 1) * hang;
    let upZ = lineDirection.z * hang;
    const upLength = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
    if (upLength < 1e-3) {
      upX = 0;
      upY = 1;
      upZ = 0;
    } else {
      upX /= upLength;
      upY /= upLength;
      upZ /= upLength;
    }
    const headingX = Math.sin(wingState.heading);
    const headingZ = -Math.cos(wingState.heading);
    const along = headingX * upX + headingZ * upZ;
    let forwardX = headingX - along * upX;
    let forwardY = -along * upY;
    let forwardZ = headingZ - along * upZ;
    const forwardLength = Math.sqrt(forwardX * forwardX + forwardY * forwardY + forwardZ * forwardZ);
    if (forwardLength < 1e-3) {
      forwardX = 0;
      forwardY = 0;
      forwardZ = -1;
    } else {
      forwardX /= forwardLength;
      forwardY /= forwardLength;
      forwardZ /= forwardLength;
    }
    let rightX = forwardY * upZ - forwardZ * upY;
    let rightY = forwardZ * upX - forwardX * upZ;
    let rightZ = forwardX * upY - forwardY * upX;
    const rightLength = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ) || 1;
    rightX /= rightLength;
    rightY /= rightLength;
    rightZ /= rightLength;
    // Columns: right, up, back (column-major elements).
    const elements = basis.elements;
    elements[0] = rightX;
    elements[1] = rightY;
    elements[2] = rightZ;
    elements[4] = upX;
    elements[5] = upY;
    elements[6] = upZ;
    elements[8] = -forwardX;
    elements[9] = -forwardY;
    elements[10] = -forwardZ;
    state.quaternion.setFromRotationMatrix(basis).normalize();
    deltaQuaternion.copy(previousQuaternion).invert().multiply(state.quaternion).normalize();
    const sign = deltaQuaternion.w < 0 ? -1 : 1;
    const w = deltaQuaternion.w * sign;
    const angle = 2 * Math.acos(Math.min(1, w));
    const sine = Math.sqrt(Math.max(0, 1 - w * w));
    if (sine > 1e-7) {
      const rate = (sign * angle) / (sine * dt);
      state.angularVelocity.x = deltaQuaternion.x * rate;
      state.angularVelocity.y = deltaQuaternion.y * rate;
      state.angularVelocity.z = deltaQuaternion.z * rate;
    } else {
      state.angularVelocity.x = 0;
      state.angularVelocity.y = 0;
      state.angularVelocity.z = 0;
    }
    // The fore-aft swing of the lines from the vertical (canopy ahead positive) and its rate.
    const pendulum = Math.atan2(lineDirection.x * headingX + lineDirection.z * headingZ, lineDirection.y);
    wingState.pendulumRate = (pendulum - wingState.pendulum) / dt;
    wingState.pendulum = pendulum;
  }

  /** Touchdowns, landing (the wing is killed), relift, and the landed timer. */
  function updateGroundPhase(report, env) {
    const dt = tick.dt;
    const groundSpeed = Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z);
    if (wingState.phase === 'flight') {
      const onFeet = report.onGround && report.gearContacts > 0;
      wingState.groundSeconds = onFeet ? wingState.groundSeconds + dt : 0;
      wingState.slowSeconds = onFeet && (groundSpeed < LANDED_SPEED || report.floating) ? wingState.slowSeconds + dt : 0;
      if (wingState.slowSeconds >= (report.floating ? FLOAT_LANDED_SECONDS : LANDED_SECONDS)) {
        setPhase('landed');
        wingState.landedSeconds = 0;
        wingState.offGroundSeconds = 0;
        wingState.launchInputSeconds = 0;
        wingState.collapseLeft = 0;
        wingState.collapseRight = 0;
        notify(report.floating ? 'Splashdown. Hold on, back to a slope in a moment.' : 'Landed. Push forward or press the speed bar to launch again from a slope.', 'info', true);
      }
    } else if (wingState.phase === 'landed') {
      wingState.inflation = moveToward(wingState.inflation, 0, dt / launchProfile.deflateSeconds);
      if (report.onGround) {
        wingState.landedSeconds += dt;
        wingState.offGroundSeconds = 0;
      } else {
        wingState.offGroundSeconds += dt;
        if (wingState.offGroundSeconds > RELIFT_SECONDS && wingState.inflation > 0.5 && state.position.y - surfaceHeightAt(env, state.position.x, state.position.z) > 2) {
          setPhase('flight');
          wingState.inflation = 1;
        }
      }
    }
  }

  function updateFlightData(report) {
    const dt = tick.dt;
    flightData.airspeed = aero.airspeed > 0 ? aero.airspeed : pilotAir.length();
    flightData.aoa = aero.alpha;
    flightData.sideslip = aero.sideslip;
    const stallAngle = Math.min(halves[0].stallAngle, halves[1].stallAngle);
    if (stallAngle - stallAngle === 0 && stallAngle !== 0) flightData.aoaCritical = stallAngle;
    flightData.stallMargin = flightData.aoaCritical - flightData.aoa;
    flightData.stallDepth = wingState.stallDepth;
    flightData.stalled = wingState.stallDepth > 0.5;
    flightData.dynamicPressure = aero.dynamicPressure;
    flightData.liftToDrag = aero.drag > 0 ? aero.lift / aero.drag : 0;
    // Attitude from the body axes.
    forward.set(0, 0, -1).applyQuaternion(state.quaternion);
    flightData.pitch = Math.asin(Math.min(1, Math.max(-1, forward.y)));
    const headingDegrees = wingState.heading / DEG;
    flightData.heading = headingDegrees < 0 ? headingDegrees + 360 : headingDegrees;
    const forwardY = forward.y;
    bodyRight.set(1, 0, 0).applyQuaternion(state.quaternion);
    upVector.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.bank = Math.abs(forwardY) > 0.995 ? 0 : Math.atan2(-bodyRight.y, upVector.y);
    flightData.yawRate = wingState.yawRate;
    flightData.verticalSpeed = state.velocity.y;
    const groundSpeed = Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z);
    flightData.flightPath = Math.atan2(state.velocity.y, Math.max(groundSpeed, 0.1));
    const load = wingState.tension / (pilotMass * GRAVITY);
    clock.load += (load - clock.load) * (1 - Math.exp(-LOAD_SMOOTHING * dt));
    flightData.gLoad = report.onGround && wingState.phase !== 'flight' ? 1 : clock.load;
    flightData.onGround = report.onGround;
    flightData.agl = tick.agl;
    const glideStep = 1 - Math.exp(-GLIDE_SMOOTHING * dt);
    clock.horizontal += (groundSpeed - clock.horizontal) * glideStep;
    clock.sink += (-state.velocity.y - clock.sink) * glideStep;
    flightData.glideRatio = clock.sink > 0.2 ? clock.horizontal / clock.sink : 0;
    flightData.pendulum = wingState.pendulum;
    flightData.pendulumRate = wingState.pendulumRate;
    flightData.collapseLeft = wingState.collapseLeft;
    flightData.collapseRight = wingState.collapseRight;
    const pressureStep = 1 - Math.exp(-12 * dt);
    wingState.pressureLeft += (halves[0].pressure - wingState.pressureLeft) * pressureStep;
    wingState.pressureRight += (halves[1].pressure - wingState.pressureRight) * pressureStep;
    wingState.pressureTrendLeft = (wingState.pressureLeft - wingState.previousPressureLeft) / dt;
    wingState.pressureTrendRight = (wingState.pressureRight - wingState.previousPressureRight) / dt;
    wingState.previousPressureLeft = wingState.pressureLeft;
    wingState.previousPressureRight = wingState.pressureRight;
    flightData.pressureLeft = wingState.pressureLeft;
    flightData.pressureRight = wingState.pressureRight;
    flightData.pressureTrendLeft = wingState.pressureTrendLeft;
    flightData.pressureTrendRight = wingState.pressureTrendRight;
    flightData.brakeLeft = wingState.brakeLeft;
    flightData.brakeRight = wingState.brakeRight;
    flightData.speedBar = wingState.speedBar;
    flightData.earsFold = wingState.earsFold;
    flightData.inflation = wingState.inflation;
    flightData.lineTension = wingState.tension;

    surfaces.aileron = wingState.weightShift;
    surfaces.elevator = 0.5 * (wingState.brakeLeft + wingState.brakeRight);
    surfaces.rudder = wingState.brakeRight - wingState.brakeLeft;
    surfaces.propSpeed = 0;
    surfaces.groundSpeed = report.onGround ? groundSpeed : 0;
  }

  /**
   * Climb tracking for the journal and the copilot: a climb starts once the smoothed climb rate holds
   * above CLIMB.START, its best 20-second average and its height gain are kept, and when it ends the
   * journal hears paragliderBestClimb and paragliderBestGain.
   */
  function updateClimb() {
    const dt = tick.dt;
    climb.smoothed += (state.velocity.y - climb.smoothed) * (1 - Math.exp(-CLIMB_SMOOTHING * dt));
    climb.sampleTimer += dt;
    if (climb.sampleTimer >= 1) {
      climb.sampleTimer -= 1;
      climb.samples[climb.sampleHead] = state.position.y;
      climb.sampleHead = (climb.sampleHead + 1) % climb.samples.length;
      climb.sampleCount = Math.min(climb.samples.length, climb.sampleCount + 1);
      if (climb.sampleCount === climb.samples.length) {
        const oldest = climb.samples[climb.sampleHead];
        climb.average = (state.position.y - oldest) / CLIMB.WINDOW;
      }
    }
    const flying = wingState.phase === 'flight';
    if (!climb.active) {
      climb.holdSeconds = flying && climb.smoothed > CLIMB.START ? climb.holdSeconds + dt : 0;
      if (climb.holdSeconds >= CLIMB.HOLD) {
        climb.active = true;
        climb.exitSeconds = 0;
        climb.lowest = state.position.y - climb.smoothed * CLIMB.HOLD;
        climb.highest = state.position.y;
        climb.bestAverage = 0;
      }
      return;
    }
    climb.highest = Math.max(climb.highest, state.position.y);
    if (climb.sampleCount === climb.samples.length) climb.bestAverage = Math.max(climb.bestAverage, climb.average);
    climb.exitSeconds = flying && climb.smoothed < CLIMB.END ? climb.exitSeconds + dt : flying ? 0 : CLIMB.EXIT;
    if (climb.exitSeconds >= CLIMB.EXIT) finishClimb();
  }

  function finishClimb() {
    const gain = climb.highest - climb.lowest;
    climb.active = false;
    climb.holdSeconds = 0;
    if (gain < CLIMB.MIN_GAIN) return;
    bus.emitTyped('journalStat', { key: 'paragliderBestGain', value: Math.round(gain), op: 'max' });
    if (climb.bestAverage > 0) bus.emitTyped('journalStat', { key: 'paragliderBestClimb', value: Math.round(climb.bestAverage * 100) / 100, op: 'max' });
  }

  function writeCraftState() {
    if (!craftState) return;
    craftState.phase = wingState.phase;
    craftState.brakeLeft = wingState.brakeLeft;
    craftState.brakeRight = wingState.brakeRight;
    craftState.speedBar = wingState.speedBar;
    craftState.weightShift = wingState.weightShift;
    craftState.earsFold = wingState.earsFold;
    craftState.bigEarsLatched = wingState.bigEarsLatched;
    if (!craftState.collapse || typeof craftState.collapse !== 'object') craftState.collapse = { left: 0, right: 0 };
    craftState.collapse.left = wingState.collapseLeft;
    craftState.collapse.right = wingState.collapseRight;
    craftState.collapses = wingState.collapses;
    craftState.pendulum = wingState.pendulum / DEG;
    craftState.inflation = wingState.inflation;
    craftState.stalled = wingState.stallDepth > 0.5;
    craftState.landedSeconds = wingState.phase === 'landed' ? wingState.landedSeconds : 0;
    craftState.onWater = contact.report.floating;
    // The canopy in body axes, for the mesh (the lines, the inflation arc, the wing lying down).
    inverseQuaternion.copy(state.quaternion).invert();
    offsetScratch.copy(canopy.position).sub(state.position).applyQuaternion(inverseQuaternion);
    canopyOffsetOut[0] = offsetScratch.x;
    canopyOffsetOut[1] = offsetScratch.y;
    canopyOffsetOut[2] = offsetScratch.z;
    craftState.canopyOffset = canopyOffsetOut;
    craftState.canopyPitch = wingState.incidence;
    if (!craftState.climb || typeof craftState.climb !== 'object') craftState.climb = { active: false, gain: 0, average: 0 };
    craftState.climb.active = climb.active;
    craftState.climb.gain = climb.active ? climb.highest - climb.lowest : 0;
    craftState.climb.average = climb.sampleCount === climb.samples.length ? climb.average : 0;
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  /** The canopy over the pilot at the trim, moving with the pilot. */
  function placeCanopyFlying() {
    const tilt = launchProfile.trimTilt * DEG;
    headingVector.set(Math.sin(wingState.heading), 0, -Math.cos(wingState.heading));
    canopy.position.copy(state.position).addScaledVector(headingVector, Math.sin(tilt) * lineLength).addScaledVector(WORLD_UP, Math.cos(tilt) * lineLength);
    canopy.velocity.copy(state.velocity);
  }

  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) state.position.copy(pose.position);
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    state.angularVelocity.set(0, 0, 0);
    forward.set(0, 0, -1).applyQuaternion(state.quaternion);
    const bodyHeading = Math.hypot(forward.x, forward.z) > 0.05 ? headingFromVector(forward.x, forward.z) : 0;
    wingState.heading = wrapSignedRadians(bodyHeading * DEG);
    wingState.yawRate = 0;
    wingState.brakeLeft = 0;
    wingState.brakeRight = 0;
    wingState.previousBrakeLeft = 0;
    wingState.previousBrakeRight = 0;
    wingState.speedBar = 0;
    wingState.weightShift = 0;
    wingState.earsFold = 0;
    wingState.collapseLeft = 0;
    wingState.collapseRight = 0;
    wingState.collapseCounted = false;
    wingState.stallDepth = 0;
    wingState.incidence = incidenceTrim;
    wingState.barArmed = false;
    wingState.barBaseline = finiteOr(pose.throttle, 0);
    wingState.landedSeconds = 0;
    wingState.groundSeconds = 0;
    wingState.slowSeconds = 0;
    wingState.offGroundSeconds = 0;
    wingState.launchInputSeconds = 0;
    wingState.launchSeconds = 0;
    wingState.launchAirborne = 0;
    wingState.bigEarsLatched = false;
    if (pose.onGround) {
      setPhase('landed');
      wingState.inflation = 0;
      wingState.tension = 0;
      placeCanopyForInflation();
      canopy.position.y = state.position.y - 0.6;
      canopy.velocity.set(0, 0, 0);
    } else {
      setPhase('flight');
      wingState.inflation = 1;
      wingState.tension = totalWeight;
      placeCanopyFlying();
    }
    climb.active = false;
    climb.holdSeconds = 0;
    climb.sampleCount = 0;
    climb.sampleHead = 0;
    climb.sampleTimer = 0;
    climb.average = 0;
    climb.smoothed = state.velocity.y;
    tick.surfaceAge = SURFACE_PROBE_TICKS;
    tick.agl = 0;
    clock.load = 1;
    clock.horizontal = Math.hypot(state.velocity.x, state.velocity.z);
    clock.sink = Math.max(0, -state.velocity.y);
    contact.reset(Boolean(pose.onGround));
    landing.reset(Boolean(pose.onGround));
    resetCount++;
    flightData.resetCount = resetCount;
    previousQuaternion.copy(state.quaternion);
    tick.dt = 1 / 120;
    updateAttitude();
    state.angularVelocity.set(0, 0, 0);
    wingState.pendulumRate = 0;
    pilotAir.copy(state.velocity);
    canopyAir.copy(canopy.velocity);
    flightData.airspeed = state.velocity.length();
    flightData.onGround = Boolean(pose.onGround);
    flightData.inflation = wingState.inflation;
    flightData.phase = wingState.phase;
    if (craftState) craftState.launchRequested = false;
    writeCraftState();
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.aoa = flightData.aoa / DEG;
    flight.sideslip = flightData.sideslip / DEG;
    flight.gLoad = flightData.gLoad;
    flight.throttle = wingState.speedBar;
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
    flight.airbrake = wingState.earsFold;
    flight.brakes = Math.max(wingState.brakeLeft, wingState.brakeRight);
    flight.trim = 0;
    flight.contacts = contact.report.contacts;
    flight.stall.stalled = flightData.stalled;
    flight.stall.buffet = Math.round(clamp(flightData.stallDepth, 0, 1) * 1000) / 1000;
    flight.stall.warning = stallWarningActive(flight.assists, flightData.stallMargin, flightData.stalled, wingState.phase !== 'flight' || flightData.onGround || flightData.airspeed < 3);
    flight.overspeed = false;
    flight.glideRatio = flightData.glideRatio;
    // Radar altitude: the pilot's feet above the ground.
    flight.radarAltitude = Math.max(0, flight.agl - profile.radarOffset);
  }

  function snapshot() {
    return {
      kind: 'paraglider',
      position: [state.position.x, state.position.y, state.position.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      canopyPosition: [canopy.position.x, canopy.position.y, canopy.position.z],
      canopyVelocity: [canopy.velocity.x, canopy.velocity.y, canopy.velocity.z],
      wing: { ...wingState },
      climb: { ...climb, samples: Array.from(climb.samples) },
      load: clock.load,
      glide: [clock.horizontal, clock.sink],
      time: clock.time,
      contact: contact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'paraglider') return false;
    state.position.fromArray(data.position);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    canopy.position.fromArray(data.canopyPosition);
    canopy.velocity.fromArray(data.canopyVelocity);
    Object.assign(wingState, data.wing);
    if (data.climb) {
      const { samples, ...fields } = data.climb;
      Object.assign(climb, fields);
      climb.samples = new Float64Array(CLIMB.WINDOW + 1);
      if (Array.isArray(samples)) climb.samples.set(samples.slice(0, climb.samples.length));
    }
    clock.load = finiteOr(data.load, 1);
    [clock.horizontal, clock.sink] = data.glide;
    clock.time = finiteOr(data.time, clock.time);
    contact.restore(data.contact);
    landing.restore(data.landing);
    tick.surfaceAge = SURFACE_PROBE_TICKS;
    tick.agl = 0;
    setPhase(wingState.phase);
    writeCraftState();
    return true;
  }

  setPhase('flight');
  placeCanopyFlying();

  return {
    kind: 'paraglider',
    profile,
    state,
    surfaces,
    flightData,
    reset,
    step,
    writeTelemetry,
    snapshot,
    restore,

    /** The pilot's ground contact report (feet and seat). */
    get contact() {
      return contact.report;
    },
    /** Number of resets so far (control stages re-initialize when it changes). */
    get resetCount() {
      return resetCount;
    },
    get phase() {
      return wingState.phase;
    },
    get landings() {
      return landing.landings;
    },
    /** The canopy's world position and velocity (labs and tests). */
    get canopy() {
      return canopy;
    },
    /** Starts a launch run when landed on the ground (the copilot's "launch" and tests). */
    requestLaunch() {
      if (craftState) craftState.launchRequested = true;
    },

    dispose() {
      contact.report.touchdown = null;
      contact.report.bodyStrike = null;
      if (craftState) {
        craftState.launchRequested = false;
        craftState.bigEars = false;
      }
    },
  };
}
