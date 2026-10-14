// SimTiltrotor: the SIM flight model for tiltrotor VTOL craft (the Osprey-style tiltrotor).
//
// A 6-DOF rigid body in SI units (centre-of-mass position and velocity in the world, attitude
// quaternion body to world, body angular velocity) integrated semi-implicitly at the controller's
// fixed 120 Hz, plus the craft's own states: the nacelle angle, the common rotor speed, each disc's
// flapping and induced velocity. Components:
//   nacelles      both nacelles tilt together about the wingtip pivots from 0 (airplane mode) to the
//                 97 degree aft stop at a fixed actuator rate. The pilot selects an angle (detent
//                 buttons, the HOTAS antenna lever, the copilot); the auto-nacelle schedule
//                 (craftState.autoNacelle) holds the selection inside the conversion corridor
//                 (tiltrotorCorridor.js). On the wheels the nacelles stay at 60 degrees or above so the
//                 discs clear the ground.
//   proprotors    two counter-rotating three-blade proprotors at the nacelle tips, each a blade-element
//                 disc (CT = sigma a / 2 (theta (1/3 + mu^2 / 2) - lambda / 2)) with SimHelicopter's
//                 dynamic induced velocity (momentum theory, the vortex ring and windmill-brake
//                 branches, Glauert's forward-flight solution, ground effect) along the disc normal.
//                 The flight control computer schedules the blade pitch: the thrust lever's collective
//                 range blends from the helicopter range to the airplane range as the nacelles come
//                 down, a pitch bias follows the axial inflow (as a constant-speed propeller's
//                 governor would), and a governor trim holds the scheduled rotor speed (100 % in
//                 helicopter mode, 84 % in airplane mode) when the engines run out of power or the
//                 airflow drives the rotors.
//   flapping      each disc follows its cyclic with a short lag, blows back in edgewise flow (beta =
//                 f (8/3 theta - 2 lambda) mu) and lags body pitch rates. In edgewise flow beyond the
//                 corridor the blowback tilts the discs aft past the cyclic: the upflow windmills the
//                 rotors past their governed speed (rotor overspeed), the thrust tilts back and the
//                 retreating blades stall (thrust loss, nose-up pitch, vibration). No damage: the
//                 consequences are the flight path and the rotor rpm.
//   mixing        helicopter mode: the stick is longitudinal cyclic (pitch) and differential
//                 collective (roll), the pedals differential longitudinal cyclic (yaw); these fade out
//                 with the nacelle angle, while the flaperons, elevator and rudders follow the stick in
//                 every mode (they only bite with airspeed). Airplane mode is a conventional airplane.
//   wing          two wing halves (lift curves that carry on past the stall), immersed in the rotor
//                 wash: download in the hover, prop wash over the wing in airplane mode. Lift builds
//                 with airspeed; below the corridor's lower edge the wing must fly past its stall
//                 (lift loss, sink, a wing drop from the rolling stall). The flaperons droop by schedule
//                 below FLAP_SPEEDS.
//   airframe      fuselage and nacelle flat-plate drag, retractable gear drag, the H tail
//   drivetrain    two turboshafts on a cross-shaft (one rotor speed) behind an N2 governor, with a
//                 freewheel; the torque reactions of the counter-rotating rotors cancel, and a
//                 differential collective leaves an adverse yaw
//   ground        tricycle gear and body points through the shared ground contact (groundContact.js);
//                 a turning proprotor touching the ground or water is a body strike
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (mesh animation), flightData
// (read by the tiltrotor assists and autopilot) and dispose(). craftState carries the tiltrotor
// fields of contract h.3: nacelleAngle, nacelleTarget, autoNacelle, corridor { min, max, state },
// plus mode, nacelleCommand and proprotorRpm.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, createSurface, createSurfaceInput, createSurfaceResult, surfaceForce, liftSlope, smoothstep } from './aero.js';
import { axialInflowRatio, forwardInflowRatio, glauertInflow, groundEffectShare } from './SimHelicopter.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { surfaceHeightAt } from './waterSurface.js';
import { NACELLE, corridorParameters, conversionCorridor, corridorState, scheduledNacelle, stepNacelle, leverToNacelle, nacelleMode } from './tiltrotorCorridor.js';
import './tiltrotorAssists.js';

const MAX_ANGULAR_SPEED = 6;
const MAX_SPEED = 220;
const LOAD_SMOOTHING = 25;
const TAIL_CL_MAX = 1.15;
const INFLOW_SECONDS = 0.1;
const MIN_INDUCED = 0.1;
const LOW_SPEED_TORQUE = 3;
const ROTOR_SPEED_MAX = 1.25;
const LOW_RPM_WARNING = 0.92;
/** The rotor counts as overspeeding above this share of its governed speed (the corridor warning). */
const OVERSPEED_SHARE = 1.05;
const COLLECTIVE_SERVO = 1.6;
const PEDAL_SERVO = 3;
const CYCLIC_SERVO = 4;
const SURFACE_SERVO = 3;
/** The antenna lever takes over the nacelle selection once it moves this far (share of travel). */
const LEVER_MOVE = 0.01;
/** Governor trim on the blade pitch (rad): integral gain per share of rpm error per second, and its band. */
const GOVERNOR_TRIM = Object.freeze({ GAIN: 1.6, PROPORTIONAL: 0.6, DEADBAND: 0.008, DOWN: -12 * DEG, UP_HOVER: 1 * DEG, UP_AIRPLANE: 14 * DEG, BLEED: 0.4 });
/** The flaperons droop fully below the first airspeed and are up above the second (m/s). */
const FLAP_SPEEDS = Object.freeze([72, 92]);
/** The governed rotor speed follows the nacelle schedule at this share of 100 % per second. */
const GOVERNED_SLEW = 0.015;
/** Mixing: the rotor controls fade in between these nacelle angles (deg). */
const HOVER_MIX = Object.freeze([5, 60]);
/** The rotor speed schedule moves from the airplane share to 100 % between these nacelle angles (deg). */
const RPM_SCHEDULE = Object.freeze([5, 45]);
/** The lever's collective range turns to the airplane range as the wing, at this share of its usable CL, carries the weight. */
const LEVER_LIFT_SHARE = 1;
/** Conversion journal: from the hover band (at or above) to airplane mode (at or below), and back. */
const CONVERSION = Object.freeze({ HOVER: 85, AIRPLANE: 1 });

function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

function bump(value, start, rise, fall, end) {
  return smoothstep(start, rise, value) * (1 - smoothstep(fall, end, value));
}

/** The shaft direction (body axes) for a nacelle angle (rad): forward at 0, up at 90 degrees. */
function shaftDirection(angle, target) {
  return target.set(0, Math.sin(angle), -Math.cos(angle));
}

function createSurfaceEntry(definition) {
  return { surface: createSurface(definition), input: createSurfaceInput(), result: createSurfaceResult() };
}

/** Airframe, rotor, wing and tail constants from a simProfile (body axes, relative to the CG). */
function buildTiltrotor(profile) {
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass ?? [0, 0, 0]);
  const rotor = profile.rotor;
  const radius = rotor.radius;
  const discArea = Math.PI * radius * radius;
  const solidity = (rotor.blades * rotor.chord) / (Math.PI * radius);
  const governedSpeed = (rotor.rpm * Math.PI) / 30;
  const wing = profile.wing;
  const tail = profile.tail;
  const engine = profile.engine;
  const nacelles = profile.nacelles;

  const wingAspect = (wing.span * wing.span) / wing.area;
  const wingSlope = liftSlope(wingAspect);
  const wingCurve = createLiftCurve({ clAlpha: wingSlope, clMax: wing.clMax, alphaCritical: wing.alphaCritical, postStallDrop: wing.postStallDrop ?? 0.45 });
  const wingHalves = [-1, 1].map((side) => createSurfaceEntry({
    id: side < 0 ? 'wingLeft' : 'wingRight',
    position: new THREE.Vector3(side * wing.span / 4, wing.position[1], wing.position[2]).sub(centerOfMass),
    normal: new THREE.Vector3(0, 1, 0),
    area: wing.area / 2,
    meanChord: wing.chord,
    curve: wingCurve,
    inducedFactor: 1 / (Math.PI * (wing.oswald ?? 0.8) * wingAspect),
    incidence: wing.incidence * DEG,
    cm0: wing.cm0 ?? 0,
  }));

  const horizontal = tail.horizontal;
  const horizontalSlope = liftSlope(horizontal.aspectRatio);
  const stabilizer = createSurfaceEntry({
    id: 'horizontalStabilizer',
    position: new THREE.Vector3().fromArray(horizontal.position).sub(centerOfMass),
    normal: new THREE.Vector3(0, 1, 0),
    area: horizontal.area,
    meanChord: Math.sqrt(horizontal.area / horizontal.aspectRatio),
    curve: createLiftCurve({ clAlpha: horizontalSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / horizontalSlope / DEG, postStallDrop: 0.3 }),
    inducedFactor: 1 / (Math.PI * 0.8 * horizontal.aspectRatio),
    incidence: (horizontal.incidence ?? 0) * DEG,
  });
  const vertical = tail.vertical;
  const finSlope = liftSlope(vertical.aspectRatio * 1.3);
  const fins = vertical.positions.map((position, index) => createSurfaceEntry({
    id: index === 0 ? 'finLeft' : 'finRight',
    position: new THREE.Vector3().fromArray(position).sub(centerOfMass),
    normal: new THREE.Vector3(1, 0, 0),
    area: vertical.area,
    meanChord: Math.sqrt(vertical.area / vertical.aspectRatio),
    curve: createLiftCurve({ clAlpha: finSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / finSlope / DEG, postStallDrop: 0.3 }),
    inducedFactor: 1 / (Math.PI * 0.8 * vertical.aspectRatio * 1.3),
    incidence: 0,
  }));

  return {
    centerOfMass,
    radius,
    discArea,
    solidity,
    thrustSlope: (solidity * rotor.liftSlope) / 2,
    profileDrag: rotor.profileDrag,
    governedSpeed,
    airplaneShare: rotor.airplaneRpm ?? 0.84,
    inertia: rotor.inertia,
    helicopterPitch: [rotor.helicopterPitch[0] * DEG, rotor.helicopterPitch[1] * DEG],
    airplanePitch: [rotor.airplanePitch[0] * DEG, rotor.airplanePitch[1] * DEG],
    maxBias: (rotor.maxBias ?? 62) * DEG,
    cyclic: rotor.cyclic * DEG,
    differentialCollective: rotor.differentialCollective * DEG,
    differentialCyclic: rotor.differentialCyclic * DEG,
    flapLag: rotor.flapLag,
    flapDamping: rotor.flapDamping,
    flapback: rotor.flapback,
    flapLimit: (rotor.flapLimit ?? 12) * DEG,
    hubStiffness: rotor.hubStiffness ?? 0,
    inducedPowerFactor: rotor.inducedPowerFactor ?? 1.15,
    coningPerLoad: (rotor.coning ?? 2.5) * DEG,
    washFactor: rotor.washFactor ?? 1.4,
    hubOffset: rotor.hubOffset,
    pivots: nacelles.pivots.map((pivot) => new THREE.Vector3().fromArray(pivot).sub(centerOfMass)),
    /** Rotation seen from above in helicopter mode: the left rotor +1 (counterclockwise), the right -1. */
    rotations: [1, -1],
    nacelleRate: nacelles.rate * DEG,
    groundMinimum: nacelles.groundMinimum ?? 60,
    nacelleAxialArea: nacelles.dragAreas[0],
    nacelleSideArea: nacelles.dragAreas[1],
    engine: {
      ratedPower: engine.powerKw * 1000,
      spoolSeconds: engine.spoolSeconds,
      startSeconds: engine.startSeconds,
      rundownSeconds: engine.rundownSeconds,
      governorGain: engine.governorGain,
      governorIntegral: engine.governorIntegral,
      lapse: engine.densityLapse,
      accessoryPower: engine.accessoryKw * 1000,
    },
    wingHalves,
    downwashFactor: 2 / (Math.PI * wingAspect),
    wingWashShare: wing.washShare ?? 0.8,
    flaperon: (wing.flaperon ?? 15) * DEG,
    flapCl: wing.flapCl ?? 0.5,
    flapClMax: wing.flapClMax ?? 0.6,
    flapDroop: (wing.droop ?? 40) * DEG,
    stabilizer,
    elevator: (horizontal.elevator ?? 20) * DEG * (horizontal.effect ?? 0.5),
    trimRange: horizontal.trimRange ?? 0.3,
    fins,
    rudder: (vertical.rudder ?? 22) * DEG * (vertical.effect ?? 0.45),
    drag: new THREE.Vector3().fromArray(profile.fuselage.dragAreas),
    dragCenter: new THREE.Vector3().fromArray(profile.fuselage.dragCenter).sub(centerOfMass),
    gear: profile.gear,
    vrs: profile.vortexRing,
    bladeStall: profile.bladeStall,
    corridor: corridorParameters(profile),
    wheelDepth: -Math.min(...profile.contacts.filter((contact) => contact.gear).map((contact) => contact.position[1])),
  };
}

/** One proprotor's live state and its per-tick scratch (never reallocated). */
function createRotorState(index, tilt, weight) {
  return {
    index,
    side: index === 0 ? -1 : 1,
    hub: new THREE.Vector3(),
    shaft: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    /** Disc tilt relative to the shaft (rad, aft positive): flapping plus cyclic. */
    flap: 0,
    induced: Math.sqrt(weight / 2 / (2 * SEA_LEVEL_DENSITY * tilt.discArea)),
    thrust: weight / 2,
    torque: 0,
    pitch: 0,
    advance: 0,
    inflow: 0,
    bias: 0,
    climb: 0,
    edgewise: 0,
    hoverInduced: 0,
    vortexRing: 0,
    bladeStall: 0,
    groundEffect: 0,
    coning: tilt.coningPerLoad,
    angle: index * 0.7,
  };
}

export function createSimTiltrotorModel({ profile, craft, bus, craftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'tiltrotor';
  const craftName = craft && craft.name ? craft.name.toLowerCase() : 'tiltrotor';
  const tilt = buildTiltrotor(profile);
  const mass = profile.mass.empty + profile.mass.pilot + (profile.mass.fuel ?? 0) + (profile.mass.payload ?? 0);
  const weight = mass * GRAVITY;
  const vne = Number.isFinite(limits.vne) ? limits.vne : 150;
  const gLimit = Number.isFinite(limits.gLimit) ? limits.gLimit : 3;
  const inertia = new THREE.Matrix3().set(
    profile.inertia.pitch, 0, 0,
    0, profile.inertia.yaw, 0,
    0, 0, profile.inertia.roll,
  );
  const inverseInertia = inertia.clone().invert();

  // ---- Rigid-body state (centre of mass) --------------------------------------------------------------
  const centerPosition = new THREE.Vector3();
  const state = {
    /** Mesh origin (world): the centre of mass minus the rotated centre-of-mass offset. */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x nose up, y nose left, z right wing up. */
    angularVelocity: new THREE.Vector3(),
  };

  const contact = createGroundContact(profile.contacts, { centerOfMass: tilt.centerOfMass, floats: limits.floats === true, mass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  const contactReport = contact.report;
  const rotorStrike = { part: '', speed: 0 };
  const rotors = [createRotorState(0, tilt, weight), createRotorState(1, tilt, weight)];

  // ---- Nacelles, drivetrain, controls ------------------------------------------------------------------
  const nacelle = {
    /** Actual angle (deg), the pilot's selection (deg) and the commanded angle after the schedule. */
    angle: NACELLE.HOVER,
    selection: NACELLE.HOVER,
    command: NACELLE.HOVER,
    /** The antenna lever's last reading (it takes over the selection only when it moves). */
    lever: NaN,
    /** The craftState values this model wrote last tick (a different value there is an outside command). */
    writtenAngle: NaN,
    writtenTarget: NaN,
    corridorMin: 0,
    corridorMax: NACELLE.MAX,
    corridorState: 'ok',
  };
  const corridor = { min: 0, max: NACELLE.MAX };
  const engine = {
    mode: 'running',
    startElapsed: 0,
    power: 0,
    speed: 1,
    integral: 0,
    announceRunning: true,
  };
  const rotor = {
    /** The common rotor speed (rad/s) on the cross-shaft, the governed speed it is held to (rad/s, slewing
     * toward the nacelle schedule) and the governor's blade-pitch trim (rad). */
    speed: tilt.governedSpeed,
    governed: tilt.governedSpeed,
    governorTrim: 0,
  };
  const controlsActual = { collective: 0.5, pitch: 0, roll: 0, pedal: 0, trim: 0, elevator: 0, aileron: 0, rudder: 0, brakeLeft: 0, brakeRight: 0 };
  const systems = { gearDown: true, gearPosition: 1, flaps: 1 };
  /** Mesh animation: surfaces (-1..1), rotor speed (rad/s), disc tilts, nacelle angle (rad). */
  const surfaces = {
    aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0,
    discLeft: 0, discRight: 0, coning: tilt.coningPerLoad, rotorShare: 1, nacelle: Math.PI / 2, flaps: 1, gearPosition: 1,
  };
  let resetCount = 0;
  /**
   * Per-tick scalars, kept as fields (a double stored in a closure variable is boxed on every write):
   * the model time (s), the smoothed load factor and the lever blend (1: the lever spans the helicopter
   * collective range; 0: the airplane range, updateLeverBlend).
   */
  const scalars = { time: 0, smoothedLoad: 1, leverBlend: 1 };
  const warnings = { overspeed: false, wingStall: false, lowRpm: false, groundLimit: false, scheduleHold: false };
  /** Conversion tracking for the journal: where the current conversion started and when. */
  const conversion = { from: '', startTime: 0, lastMode: '' };

  // ---- Live flight data (the assists, autopilot and telemetry read it; SI, radians) ------------------------
  const flightData = {
    airspeed: 0,
    groundSpeed: 0,
    velocity: state.velocity,
    verticalSpeed: 0,
    aoa: 0,
    sideslip: 0,
    heading: 0,
    pitch: 0,
    bank: 0,
    rollRate: 0,
    pitchRate: 0,
    yawRate: 0,
    gLoad: 1,
    onGround: false,
    agl: Infinity,
    rotorRpm: 1,
    torque: 0,
    engineRunning: true,
    engineMode: 'running',
    collective: 0.5,
    trimCollective: 0.5,
    /** 1 in helicopter mode, 0 in airplane mode: how much the rotor controls fly the craft. */
    hoverShare: 1,
    nacelle: NACELLE.HOVER * DEG,
    nacelleCommand: NACELLE.HOVER * DEG,
    corridorMin: 0,
    corridorMax: NACELLE.MAX * DEG,
    corridorState: 'ok',
    hoverInduced: 0,
    vortexRing: 0,
    bladeStall: 0,
    wingStall: 0,
    stallMargin: 1,
    flaps: 1,
    overspeed: false,
    vne,
    gLimit,
    mass,
    weight,
    resetCount: 0,
  };

  // ---- Scratch ----------------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const airVelocityWorld = new THREE.Vector3();
  const bodyAir = new THREE.Vector3();
  const hubAir = new THREE.Vector3();
  const localVelocity = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const inPlane = new THREE.Vector3();
  const discForward = new THREE.Vector3();
  const forceBody = new THREE.Vector3();
  const momentBody = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const lever = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const angularAcceleration = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const bodyAxis = new THREE.Vector3();
  const originOffset = new THREE.Vector3();
  const nonGravity = new THREE.Vector3();
  const worldPoint = new THREE.Vector3();
  const tipOffset = new THREE.Vector3();
  const discU = new THREE.Vector3();
  const discV = new THREE.Vector3();
  const washVelocity = new THREE.Vector3();
  const contactBody = { position: centerPosition, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };
  const wingStallScratch = { left: 0, right: 0 };
  /** The landing monitor's per-tick sample (reused). */
  const landingSample = { dt: 0, agl: Infinity, position: state.position };

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // CRAFT STATE (contract h.3)
  // ============================================================================================
  function ensureCraftState() {
    if (typeof craftState.autoNacelle !== 'boolean') craftState.autoNacelle = true;
    if (!craftState.corridor || typeof craftState.corridor !== 'object') craftState.corridor = { min: 0, max: NACELLE.MAX, state: 'ok' };
  }

  /** An angle or selection written into craftState from outside (a placement, a command, a test) takes over. */
  function adoptOutsideCommands() {
    const angle = craftState.nacelleAngle;
    if (Number.isFinite(angle) && angle !== nacelle.writtenAngle) {
      nacelle.angle = clamp(angle, NACELLE.MIN, NACELLE.MAX);
      nacelle.command = nacelle.angle;
      if (!(Number.isFinite(craftState.nacelleTarget) && craftState.nacelleTarget !== nacelle.writtenTarget)) nacelle.selection = nacelle.angle;
    }
    const target = craftState.nacelleTarget;
    if (Number.isFinite(target) && target !== nacelle.writtenTarget) nacelle.selection = clamp(target, NACELLE.MIN, NACELLE.MAX);
  }

  function writeCraftState() {
    craftState.nacelleAngle = Math.round(nacelle.angle * 100) / 100;
    craftState.nacelleTarget = Math.round(nacelle.selection * 100) / 100;
    craftState.nacelleCommand = Math.round(nacelle.command * 100) / 100;
    craftState.mode = nacelleMode(nacelle.angle);
    craftState.corridor.min = Math.round(nacelle.corridorMin * 10) / 10;
    craftState.corridor.max = Math.round(nacelle.corridorMax * 10) / 10;
    craftState.corridor.state = nacelle.corridorState;
    craftState.proprotorRpm = Math.round((rotor.speed * 30) / Math.PI);
    nacelle.writtenAngle = craftState.nacelleAngle;
    nacelle.writtenTarget = craftState.nacelleTarget;
  }

  // ============================================================================================
  // PILOT INPUTS -> ACTUATORS
  // ============================================================================================
  function handleActions(actions, quiet) {
    if (!actions || actions.size === 0) return;
    for (const action of actions) {
      const announce = !quiet || !quiet.has(action);
      switch (action) {
        case 'engineToggle': {
          if (engine.mode === 'off') {
            engine.mode = 'starting';
            engine.startElapsed = 0;
            engine.announceRunning = announce;
            if (announce) notify('Engines start: both turboshafts spooling up.', 'info');
          } else {
            engine.mode = 'off';
            if (announce) notify('Engines off: lower the thrust lever and hold the proprotor rpm.', 'warning');
          }
          break;
        }
        case 'gearToggle':
          if (systems.gearDown && contactReport.onGround) {
            if (announce) notify('The gear stays down on the ground.', 'warning');
          } else {
            systems.gearDown = !systems.gearDown;
          }
          break;
        // The flap buttons tilt the nacelles one detent: flaps down toward the hover, flaps up toward airplane mode.
        case 'flapsDown':
          selectNacelle(stepNacelle(nacelle.selection, 1), announce);
          break;
        case 'flapsUp':
          selectNacelle(stepNacelle(nacelle.selection, -1), announce);
          break;
        case 'chuteDeploy':
          if (announce) notify(`The ${craftName} has no parachute.`);
          break;
        default:
          break;
      }
    }
  }

  /** A new nacelle selection from a detent button (announced as a short toast). */
  function selectNacelle(angle, announce) {
    nacelle.selection = clamp(angle, NACELLE.MIN, NACELLE.MAX);
    warnings.scheduleHold = false;
    if (announce) notify(`Nacelles to ${Math.round(nacelle.selection)} degrees.`, 'info');
  }

  /** The antenna lever (HOTAS): absolute, but it takes over the selection only when it moves. */
  function readNacelleLever(value) {
    if (!Number.isFinite(value)) return;
    if (!Number.isFinite(nacelle.lever)) {
      nacelle.lever = value;
      return;
    }
    if (Math.abs(value - nacelle.lever) < LEVER_MOVE) return;
    nacelle.lever = value;
    nacelle.selection = leverToNacelle(value);
    warnings.scheduleHold = false;
  }

  function updateActuators(controls, dt, airspeed, rho) {
    handleActions(controls.actions, controls.quietActions);
    readNacelleLever(controls.antenna);
    const collective = clamp(Number.isFinite(controls.collective) ? controls.collective : controlsActual.collective, 0, 1);
    controlsActual.collective = moveToward(controlsActual.collective, collective, COLLECTIVE_SERVO * dt);
    controlsActual.trim = clamp(Number.isFinite(controls.trim) ? controls.trim : 0, -1, 1);
    const pitch = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    const roll = clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1);
    const yaw = clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1);
    controlsActual.pitch = moveToward(controlsActual.pitch, pitch, CYCLIC_SERVO * dt);
    controlsActual.roll = moveToward(controlsActual.roll, roll, CYCLIC_SERVO * dt);
    controlsActual.pedal = moveToward(controlsActual.pedal, yaw, PEDAL_SERVO * dt);
    controlsActual.elevator = moveToward(controlsActual.elevator, clamp(pitch + controlsActual.trim * tilt.trimRange, -1, 1), SURFACE_SERVO * dt);
    controlsActual.aileron = moveToward(controlsActual.aileron, roll, SURFACE_SERVO * dt);
    controlsActual.rudder = moveToward(controlsActual.rudder, yaw, SURFACE_SERVO * dt);
    controlsActual.brakeLeft = clamp(Number.isFinite(controls.brakeL) ? controls.brakeL : 0, 0, 1);
    controlsActual.brakeRight = clamp(Number.isFinite(controls.brakeR) ? controls.brakeR : 0, 0, 1);

    // Gear transit and the flaperon droop schedule.
    const gear = tilt.gear;
    if (gear && gear.retractable) systems.gearPosition = moveToward(systems.gearPosition, systems.gearDown ? 1 : 0, dt / gear.transitSeconds);
    contactInputs.gearDown = systems.gearPosition > 0.98;
    const flapTarget = 1 - smoothstep(FLAP_SPEEDS[0], FLAP_SPEEDS[1], airspeed);
    systems.flaps = moveToward(systems.flaps, flapTarget, dt / 4);

    updateNacelle(dt, airspeed, rho);
  }

  /** The nacelle actuator: the selection, the auto-nacelle schedule, the weight-on-wheels limit. */
  function updateNacelle(dt, airspeed, rho) {
    conversionCorridor(airspeed, rho, tilt.corridor, corridor);
    nacelle.corridorMin = corridor.min;
    nacelle.corridorMax = corridor.max;
    let command = nacelle.selection;
    if (craftState.autoNacelle === true && !contactReport.onGround) {
      command = scheduledNacelle(nacelle.selection, corridor, tilt.corridor.margin);
      // Tell the pilot once when the schedule holds a selection back (the airspeed has to catch up).
      if (Math.abs(command - nacelle.selection) > 10 && !warnings.scheduleHold) {
        warnings.scheduleHold = true;
        notify(nacelle.selection < command ? 'Auto-nacelle: converting as the airspeed builds.' : 'Auto-nacelle: the nacelles come up as the airspeed bleeds off.', 'info');
      }
    }
    if (contactReport.onGround && command < tilt.groundMinimum) {
      command = tilt.groundMinimum;
      if (!warnings.groundLimit && nacelle.selection < tilt.groundMinimum - 1) {
        warnings.groundLimit = true;
        notify(`On the wheels the nacelles stay at ${tilt.groundMinimum} degrees or above (proprotor ground clearance).`, 'warning');
      }
    } else if (!contactReport.onGround) {
      warnings.groundLimit = false;
    }
    nacelle.command = command;
    nacelle.angle = moveToward(nacelle.angle, command, (tilt.nacelleRate / DEG) * dt);
    nacelle.corridorState = corridorState(nacelle.angle, corridor, tilt.corridor.tolerance);
  }

  // ============================================================================================
  // PROPROTORS
  // ============================================================================================
  /** Places a rotor's hub and shaft for the nacelle angle; the disc normal adds its flapping. */
  function placeRotor(entry, angle) {
    shaftDirection(angle, entry.shaft);
    entry.hub.copy(tilt.pivots[entry.index]).addScaledVector(entry.shaft, tilt.hubOffset);
    shaftDirection(angle + entry.flap, entry.normal);
  }

  /** Blade pitch at 3/4 radius from the thrust lever: the helicopter range blending to the airplane range. */
  function leverPitch(lever, hoverShare) {
    const heli = tilt.helicopterPitch;
    const plane = tilt.airplanePitch;
    const low = plane[0] + (heli[0] - plane[0]) * hoverShare;
    const high = plane[1] + (heli[1] - plane[1]) * hoverShare;
    return low + (high - low) * lever;
  }

  /** Helicopter-mode share of the nacelle travel (1 at 75+ degrees, 0 in airplane mode): the governor trim's authority. */
  function helicopterShare(angle) {
    return smoothstep(0, 75 * DEG, angle);
  }

  /**
   * The lever's collective range follows the wing: the helicopter range while the rotors carry the
   * weight, the airplane range once the airspeed lets the wing carry it (dynamic pressure x wing area x
   * LEVER_LIFT_SHARE of the corridor's usable CL against the weight).
   */
  function updateLeverBlend(airspeed, rho) {
    const capacity = (0.5 * rho * airspeed * airspeed * tilt.corridor.wingArea * tilt.corridor.clUse * LEVER_LIFT_SHARE) / weight;
    scalars.leverBlend = 1 - smoothstep(0, 1, capacity);
  }

  function proprotorForces(entry, rho, hubHeight, hoverShare, angle, dt) {
    const tip = Math.max(rotor.speed * tilt.radius, 1);
    // Hub velocity relative to the air (body axes) split along and across the disc.
    spin.crossVectors(state.angularVelocity, entry.hub);
    hubAir.copy(bodyAir).add(spin);
    // Flapping: the cyclic (pitch stick, pedals), the blowback in edgewise flow, the body pitch rate lag.
    // The blowback follows the blade loading: the pitch above the inflow bias, against the induced inflow.
    discForward.set(0, Math.cos(angle + entry.flap), Math.sin(angle + entry.flap));
    const forwardEdgewise = -hubAir.dot(discForward);
    const loadingPitch = entry.pitch - entry.bias;
    const flapGain = tilt.flapback * Math.max(0, 2 * ((4 * loadingPitch) / 3 - entry.induced / tip));
    const cyclic = (controlsActual.pitch * tilt.cyclic + entry.side * controlsActual.pedal * tilt.differentialCyclic) * hoverShare;
    const targetFlap = flapGain * (forwardEdgewise / tip) / Math.max(1 - (entry.advance * entry.advance) / 2, 0.5)
      + cyclic - tilt.flapDamping * state.angularVelocity.x * Math.sin(angle);
    const share = clamp(rotor.speed / tilt.governedSpeed, 0.2, 1.3);
    entry.flap += (clamp(targetFlap, -tilt.flapLimit, tilt.flapLimit) - entry.flap) * (1 - Math.exp(-dt / (tilt.flapLag / share)));
    shaftDirection(angle + entry.flap, entry.normal);

    const climb = hubAir.dot(entry.normal);
    inPlane.copy(hubAir).addScaledVector(entry.normal, -climb);
    const edgewise = inPlane.length();
    entry.climb = climb;
    entry.edgewise = edgewise;

    const thrustScale = rho * tilt.discArea * tip * tip;
    const direction = entry.thrust >= 0 ? 1 : -1;
    const hoverInduced = Math.max(Math.sqrt(Math.abs(entry.thrust) / (2 * rho * tilt.discArea)), MIN_INDUCED);
    const axialRatio = (direction * climb) / hoverInduced;
    const edgewiseRatio = edgewise / hoverInduced;
    // Ground effect only with the disc facing the ground.
    const facing = Math.max(0, Math.sin(angle));
    const groundShare = groundEffectShare(hubHeight, tilt.radius, edgewiseRatio) * facing * facing;
    let freeInduced = hoverInduced * axialInflowRatio(axialRatio) * forwardInflowRatio(edgewiseRatio);
    const sweptWake = smoothstep(0.6, 1.6, edgewiseRatio);
    if (sweptWake > 0) freeInduced += (glauertInflow(hoverInduced, edgewise, direction * climb) - freeInduced) * sweptWake;
    const targetInduced = direction * freeInduced * (1 - groundShare);
    entry.induced += (targetInduced - entry.induced) * (1 - Math.exp(-dt / INFLOW_SECONDS));
    const advance = edgewise / tip;
    const inflow = (climb + entry.induced) / tip;

    // Blade pitch: the lever, the bias for the axial inflow through the disc, the governor trim and the
    // differential collective. The bias is scheduled for the governed tip speed (like a slow
    // constant-speed governor, so a rotor running fast meets the air at a higher blade angle and slows
    // itself) and comes in with the airplane range of the lever (in the hover a climb's inflow is the
    // pilot's to answer with the collective, as in a helicopter); an upflow (the disc tilted back into
    // the airflow) gets none. Like the blades' built-in twist, it is not amplified by the edgewise flow.
    const governedTip = rotor.governed * tilt.radius;
    const bias = Math.min(tilt.maxBias, (1.5 * Math.max(0, climb)) / governedTip) * (1 - scalars.leverBlend);
    entry.bias = bias;
    const pitch = leverPitch(controlsActual.collective, scalars.leverBlend) + bias + rotor.governorTrim
      - entry.side * controlsActual.roll * tilt.differentialCollective * hoverShare;
    entry.pitch = pitch;

    // Vortex ring state (each rotor on its own: an asymmetric ring rolls the craft).
    const vrs = tilt.vrs;
    const descentRatio = -axialRatio;
    const ringTarget = bump(descentRatio, vrs.start, vrs.full, vrs.fade, vrs.end) * (1 - smoothstep(vrs.clearSpeed * 0.4, vrs.clearSpeed, edgewiseRatio));
    const ringSeconds = ringTarget > entry.vortexRing ? vrs.buildSeconds : vrs.clearSeconds / (1 + 3 * edgewiseRatio);
    entry.vortexRing += (ringTarget - entry.vortexRing) * (1 - Math.exp(-dt / ringSeconds));
    const hoverCoefficient = weight / 2 / thrustScale;
    const hoverPitch = 3 * (hoverCoefficient / tilt.thrustSlope + Math.sqrt(hoverCoefficient / 2) / 2);
    const effectivePitch = pitch - entry.vortexRing * vrs.collectiveLoss * Math.max(0, pitch - bias - hoverPitch);
    let thrustCoefficient = tilt.thrustSlope * ((effectivePitch - bias) * (1 / 3 + (advance * advance) / 2) + bias / 3 - inflow / 2);

    // Retreating blade stall in edgewise flow (earlier when heavily loaded); low rpm stalls the disc.
    const stall = tilt.bladeStall;
    const bladeLoading = Math.abs(entry.thrust) / thrustScale / tilt.solidity;
    const onset = stall.onsetAdvance - stall.loadingSensitivity * Math.max(0, bladeLoading - stall.referenceLoading);
    const bladeStall = smoothstep(onset, onset + stall.width, advance);
    const rotorShare = rotor.speed / rotor.governed;
    const lowRpmStall = smoothstep(0.84, 0.68, rotorShare);

    let thrust = thrustCoefficient * thrustScale;
    thrust *= 1 - vrs.thrustLoss * entry.vortexRing - stall.thrustLoss * bladeStall - 0.55 * lowRpmStall;
    thrust += entry.vortexRing * vrs.roughness * (weight / 2) * noise(scalars.time, 0.7 + entry.index * 2.1, 2.3);
    thrust = clamp(thrust, -0.4 * weight, 1.6 * weight);
    thrustCoefficient = thrust / thrustScale;
    entry.thrust = thrust;

    const inducedInflow = entry.induced / tip;
    const profileCoefficient = ((tilt.solidity * tilt.profileDrag) / 8) * (1 + 4.65 * advance * advance) * (1 + 1.5 * bladeStall + 0.8 * lowRpmStall);
    const torqueCoefficient = thrustCoefficient * (climb / tip + tilt.inducedPowerFactor * inducedInflow) + profileCoefficient;
    entry.torque = torqueCoefficient * thrustScale * tilt.radius;

    // Forces at the hub: thrust along the disc normal and the profile H-force against the edgewise flow.
    forceBody.addScaledVector(entry.normal, thrust);
    lever.crossVectors(entry.hub, entry.normal).multiplyScalar(thrust);
    momentBody.add(lever);
    if (edgewise > 0.1) {
      const hForce = thrustScale * ((tilt.solidity * tilt.profileDrag) / 4) * advance * (1 + 2 * bladeStall);
      localVelocity.copy(inPlane).multiplyScalar(-hForce / edgewise);
      forceBody.add(localVelocity);
      momentBody.add(lever.crossVectors(entry.hub, localVelocity));
    }
    // Gimbal spring moment about the pivot axis (body x) from the disc tilt; blade stall pitches the nose up.
    const stiffShare = Math.min(rotorShare * rotorShare, 1.5);
    momentBody.x += tilt.hubStiffness * entry.flap * stiffShare;
    if (bladeStall > 0) {
      const stallMoment = bladeStall * Math.abs(thrust) * tilt.radius;
      momentBody.x += stall.pitchMoment * stallMoment * (1 + 0.3 * noise(scalars.time, 1.9 + entry.index, 6));
      momentBody.z += entry.side * stall.rollMoment * 0.3 * stallMoment * noise(scalars.time, 3.1 + entry.index, 5);
    }
    // The rotor's torque reacts on the airframe about its shaft.
    momentBody.addScaledVector(entry.shaft, -tilt.rotations[entry.index] * entry.torque);

    entry.advance = advance;
    entry.inflow = inflow;
    entry.hoverInduced = hoverInduced;
    entry.bladeStall = Math.max(bladeStall, lowRpmStall);
    entry.groundEffect = groundShare;
    entry.coning = clamp((tilt.coningPerLoad * thrust) / (weight / 2) / Math.max(rotorShare * rotorShare, 0.25), -0.02, 0.18);
  }

  /** The governed rotor speed (rad/s) for a nacelle angle (rad): 100 % in helicopter mode, the airplane share at 0. */
  function scheduledSpeed(angle) {
    const share = tilt.airplaneShare + (1 - tilt.airplaneShare) * smoothstep(RPM_SCHEDULE[0] * DEG, RPM_SCHEDULE[1] * DEG, angle);
    return tilt.governedSpeed * share;
  }

  // ============================================================================================
  // WING, TAIL, AIRFRAME
  // ============================================================================================
  function wingForces(rho) {
    // The rotor wash over each half: the disc's induced velocity along its normal, scaled to the wing.
    for (let index = 0; index < 2; index++) {
      const entry = tilt.wingHalves[index];
      const rotorEntry = rotors[index];
      const { surface, input, result } = entry;
      spin.crossVectors(state.angularVelocity, surface.position);
      localVelocity.copy(bodyAir).add(spin);
      const wash = Math.max(rotorEntry.induced, 0) * tilt.washFactor * tilt.wingWashShare;
      washVelocity.copy(rotorEntry.normal).multiplyScalar(wash);
      localVelocity.add(washVelocity);
      const side = index === 0 ? -1 : 1;
      // Flaperons: the scheduled droop (lift, and less download in the wash) plus the roll command.
      input.alphaOffset = -side * controlsActual.aileron * tilt.flaperon;
      input.deltaCl = systems.flaps * tilt.flapCl;
      input.deltaClMax = systems.flaps * tilt.flapClMax;
      input.inducedScale = 1;
      input.extraDrag = 0;
      surfaceForce(surface, localVelocity, rho, input, result);
      // Drooped flaperons shed part of the download in a vertical wash.
      const downwash = clamp(-Math.sin(result.alpha), 0, 1);
      const shed = 1 - 0.35 * systems.flaps * downwash;
      forceBody.addScaledVector(result.force, shed);
      lever.crossVectors(surface.position, result.force).multiplyScalar(shed);
      momentBody.add(lever).add(result.moment);
      if (index === 0) wingStallScratch.left = result.alpha > 0 ? result.stall : 0;
      else wingStallScratch.right = result.alpha > 0 ? result.stall : 0;
    }
  }

  function tailForces(rho, airspeed) {
    const { surface, input, result } = tilt.stabilizer;
    spin.crossVectors(state.angularVelocity, surface.position);
    localVelocity.copy(bodyAir).add(spin);
    // The wing's downwash at the tail (2 CL / (pi AR)), once the wing flies.
    const wingCl = (tilt.wingHalves[0].result.cl + tilt.wingHalves[1].result.cl) / 2;
    const downwash = clamp(tilt.downwashFactor * wingCl, -0.15, 0.25) * smoothstep(8, 20, airspeed);
    input.alphaOffset = -controlsActual.elevator * tilt.elevator - downwash;
    input.inducedScale = 1;
    surfaceForce(surface, localVelocity, rho, input, result);
    forceBody.add(result.force);
    momentBody.add(lever.crossVectors(surface.position, result.force));
    for (const fin of tilt.fins) {
      spin.crossVectors(state.angularVelocity, fin.surface.position);
      localVelocity.copy(bodyAir).add(spin);
      fin.input.alphaOffset = -controlsActual.rudder * tilt.rudder;
      fin.input.inducedScale = 1;
      surfaceForce(fin.surface, localVelocity, rho, fin.input, fin.result);
      forceBody.add(fin.result.force);
      momentBody.add(lever.crossVectors(fin.surface.position, fin.result.force));
    }
  }

  function airframeForces(rho) {
    const airspeed = bodyAir.length();
    if (airspeed < 0.05) return;
    // Fuselage: anisotropic flat-plate drag at the drag centre, plus the gear while it is out.
    spin.crossVectors(state.angularVelocity, tilt.dragCenter);
    localVelocity.copy(bodyAir).add(spin);
    const speed = localVelocity.length();
    const gearArea = tilt.gear ? (tilt.gear.dragArea ?? 0) * systems.gearPosition : 0;
    const scale = -0.5 * rho * speed;
    lever.set(localVelocity.x * tilt.drag.x * scale, localVelocity.y * tilt.drag.y * scale, localVelocity.z * (tilt.drag.z + gearArea) * scale);
    forceBody.add(lever);
    momentBody.add(spin.crossVectors(tilt.dragCenter, lever));
    // Nacelles: slim along the shaft, broad across it (a raised nacelle at speed is a big air brake).
    for (const entry of rotors) {
      const pivot = tilt.pivots[entry.index];
      spin.crossVectors(state.angularVelocity, pivot);
      localVelocity.copy(bodyAir).add(spin);
      const along = localVelocity.dot(entry.shaft);
      const nacelleSpeed = localVelocity.length();
      const crossX = localVelocity.x - entry.shaft.x * along;
      const crossY = localVelocity.y - entry.shaft.y * along;
      const crossZ = localVelocity.z - entry.shaft.z * along;
      const factor = -0.5 * rho * nacelleSpeed;
      lever.set(
        (entry.shaft.x * along * tilt.nacelleAxialArea + crossX * tilt.nacelleSideArea) * factor,
        (entry.shaft.y * along * tilt.nacelleAxialArea + crossY * tilt.nacelleSideArea) * factor,
        (entry.shaft.z * along * tilt.nacelleAxialArea + crossZ * tilt.nacelleSideArea) * factor,
      );
      forceBody.add(lever);
      momentBody.add(spin.crossVectors(pivot, lever));
    }
  }

  // ============================================================================================
  // DRIVETRAIN: engines, N2 governor, freewheel, the governor's blade-pitch trim
  // ============================================================================================
  const drivetrainState = { engineTorque: 0, loadTorque: 0, available: 0, saturated: false };

  function availablePower(rho) {
    return tilt.engine.ratedPower * Math.pow(rho / SEA_LEVEL_DENSITY, tilt.engine.lapse);
  }

  function updateDrivetrain(rho, angle, dt) {
    const engineProfile = tilt.engine;
    const governed = rotor.governed;
    const speed = Math.max(rotor.speed, 0);
    const share = speed / governed;
    const aeroTorque = rotors[0].torque + rotors[1].torque;
    const loadTorque = aeroTorque + (engineProfile.accessoryPower * Math.min(share, 1.3) ** 3) / Math.max(speed, 1);
    let available = availablePower(rho);
    if (engine.mode === 'starting') {
      engine.startElapsed += dt;
      const progress = clamp(engine.startElapsed / engineProfile.startSeconds, 0, 1);
      available *= progress;
      if (progress >= 1) {
        engine.mode = 'running';
        if (engine.announceRunning) notify('Engines running: proprotor rpm governed.', 'success');
      }
    } else if (engine.mode === 'off') {
      available = 0;
    }
    const error = (governed - speed) / governed;
    let command = 0;
    let saturated = false;
    let idle = engine.mode === 'off';
    if (engine.mode !== 'off') {
      const unclamped = loadTorque * governed + engineProfile.governorGain * error * engineProfile.ratedPower + engine.integral;
      command = clamp(unclamped, 0, available);
      saturated = (unclamped > available && error > 0) || (unclamped < 0 && error < 0);
      idle = unclamped <= 0 && error < 0;
      if (!saturated) engine.integral = clamp(engine.integral + engineProfile.governorIntegral * error * engineProfile.ratedPower * dt, -0.5 * engineProfile.ratedPower, engineProfile.ratedPower);
      engine.power += (command - engine.power) * (1 - Math.exp(-dt / engineProfile.spoolSeconds));
      engine.speed += (Math.max(share, engine.mode === 'starting' ? clamp(engine.startElapsed / engineProfile.startSeconds, 0, 1) : share) - engine.speed) * (1 - Math.exp(-dt / 0.3));
    } else {
      engine.integral = 0;
      engine.power += (0 - engine.power) * (1 - Math.exp(-dt / 0.6));
      engine.speed += (0 - engine.speed) * (1 - Math.exp(-dt / engineProfile.rundownSeconds));
    }
    const driving = engine.mode !== 'off' || engine.speed >= share - 0.01;
    const engineTorque = driving ? Math.min(engine.power / Math.max(speed, 0.3 * governed), (LOW_SPEED_TORQUE * engineProfile.ratedPower) / governed) : 0;
    rotor.speed = clamp(speed + ((engineTorque - loadTorque) / tilt.inertia) * dt, 0, ROTOR_SPEED_MAX * tilt.governedSpeed);
    updateGovernorTrim(share, (saturated && !idle) || engine.mode === 'off', idle, angle, dt);
    drivetrainState.engineTorque = engineTorque;
    drivetrainState.loadTorque = loadTorque;
    drivetrainState.available = available;
    drivetrainState.saturated = saturated;
  }

  /**
   * The flight control computer's rotor-speed trim on the blade pitch, for when the engines' governor
   * runs out of authority: a droop with the engines at full power (or off) flattens the pitch to unload
   * the rotors; an overspeed with the engines already at zero power coarsens it to absorb the airflow,
   * with little authority in helicopter mode (the collective is the pilot's) and plenty in airplane
   * mode (a constant-speed proprotor). Otherwise it bleeds back toward zero.
   */
  function updateGovernorTrim(share, starved, idle, angle, dt) {
    const error = share - 1;
    const up = GOVERNOR_TRIM.UP_AIRPLANE + (GOVERNOR_TRIM.UP_HOVER - GOVERNOR_TRIM.UP_AIRPLANE) * helicopterShare(angle);
    if (error < -GOVERNOR_TRIM.DEADBAND && starved) {
      rotor.governorTrim += GOVERNOR_TRIM.GAIN * (error + GOVERNOR_TRIM.DEADBAND) * dt;
    } else if (error > GOVERNOR_TRIM.DEADBAND && idle) {
      rotor.governorTrim += GOVERNOR_TRIM.GAIN * (error - GOVERNOR_TRIM.DEADBAND) * dt + GOVERNOR_TRIM.PROPORTIONAL * (error - GOVERNOR_TRIM.DEADBAND) * dt * 10;
    } else {
      rotor.governorTrim -= rotor.governorTrim * Math.min(1, GOVERNOR_TRIM.BLEED * dt);
    }
    rotor.governorTrim = clamp(rotor.governorTrim, GOVERNOR_TRIM.DOWN, up);
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
    bodyAxis.set(1, 0, 0).applyQuaternion(state.quaternion);
    const rightY = bodyAxis.y;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.bank = Math.atan2(-rightY, bodyAxis.y);
  }

  /** Height of the lowest wheel above the surface (m). */
  function wheelHeight(surfaceHeight) {
    let lowest = Infinity;
    for (const point of contact.contacts) {
      if (!point.gear) continue;
      worldPoint.copy(point.relative).applyQuaternion(state.quaternion).add(centerPosition);
      lowest = Math.min(lowest, worldPoint.y);
    }
    return Number.isFinite(lowest) ? lowest - surfaceHeight : centerPosition.y - tilt.wheelDepth - surfaceHeight;
  }

  /** A turning proprotor whose disc rim (with coning) touches the ground or water is a body strike at its tip speed. */
  function checkRotorStrike(env) {
    const share = rotor.speed / tilt.governedSpeed;
    if (share < 0.12) return;
    for (const entry of rotors) {
      worldPoint.copy(entry.hub).applyQuaternion(state.quaternion).add(centerPosition);
      const hubX = worldPoint.x;
      const hubY = worldPoint.y;
      const hubZ = worldPoint.z;
      if (hubY - surfaceHeightAt(env, hubX, hubZ) > tilt.radius * 1.2 + 2) continue;
      discU.set(1, 0, 0).addScaledVector(entry.normal, -entry.normal.x).normalize();
      discV.crossVectors(entry.normal, discU).normalize();
      const rise = tilt.radius * Math.sin(entry.coning);
      for (let index = 0; index < 16; index++) {
        const bladeAngle = (index / 16) * Math.PI * 2;
        tipOffset.copy(discU).multiplyScalar(Math.cos(bladeAngle) * tilt.radius).addScaledVector(discV, Math.sin(bladeAngle) * tilt.radius).addScaledVector(entry.normal, rise);
        tipOffset.applyQuaternion(state.quaternion);
        if (hubY + tipOffset.y < surfaceHeightAt(env, hubX + tipOffset.x, hubZ + tipOffset.z)) {
          rotorStrike.part = entry.side < 0 ? 'left proprotor' : 'right proprotor';
          rotorStrike.speed = rotor.speed * tilt.radius;
          contactReport.bodyStrike = rotorStrike;
          return;
        }
      }
    }
  }

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    scalars.time += dt;
    ensureCraftState();
    adoptOutsideCommands();
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;

    inverseQuaternion.copy(state.quaternion).invert();
    airVelocityWorld.copy(state.velocity);
    if (env.wind && env.wind.vel) airVelocityWorld.sub(env.wind.vel);
    bodyAir.copy(airVelocityWorld).applyQuaternion(inverseQuaternion);
    const airspeed = bodyAir.length();

    updateActuators(controls, dt, airspeed, rho);
    updateLeverBlend(airspeed, rho);
    const angle = nacelle.angle * DEG;
    rotor.governed = moveToward(rotor.governed, scheduledSpeed(angle), GOVERNED_SLEW * tilt.governedSpeed * dt);
    const hoverShare = smoothstep(HOVER_MIX[0] * DEG, HOVER_MIX[1] * DEG, angle);

    const surfaceHeight = surfaceHeightAt(env, centerPosition.x, centerPosition.z);
    forceBody.set(0, 0, 0);
    momentBody.set(0, 0, 0);
    for (const entry of rotors) {
      placeRotor(entry, angle);
      worldPoint.copy(entry.hub).applyQuaternion(state.quaternion).add(centerPosition);
      const hubHeight = worldPoint.y - surfaceHeightAt(env, worldPoint.x, worldPoint.z);
      proprotorForces(entry, rho, hubHeight, hoverShare, angle, dt);
    }
    wingForces(rho);
    tailForces(rho, airspeed);
    airframeForces(rho);
    updateDrivetrain(rho, angle, dt);
    surfaces.nacelle = angle;

    // Vibration: the vortex ring, blade stall, a stalled wing's buffet and turbulence.
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    const ring = Math.max(rotors[0].vortexRing, rotors[1].vortexRing);
    const bladeStall = Math.max(rotors[0].bladeStall, rotors[1].bladeStall);
    const wingStall = Math.max(wingStallScratch.left, wingStallScratch.right) * smoothstep(15, 25, airspeed);
    const shake = weight * 0.04 * (ring + 1.2 * bladeStall + 0.8 * wingStall + 0.2 * turbulence);
    if (shake > 0) {
      momentBody.x += shake * noise(scalars.time, 0.3, 4.5);
      momentBody.z += shake * 0.6 * noise(scalars.time, 4.2, 5.5);
      momentBody.y += shake * 0.3 * noise(scalars.time, 2.1, 3.1);
    }

    contactInputs.brakeLeft = controlsActual.brakeLeft;
    contactInputs.brakeRight = controlsActual.brakeRight;
    contactInputs.steering = controlsActual.rudder;
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    momentBody.add(groundMoment);

    forceWorld.copy(forceBody).applyQuaternion(state.quaternion).add(groundForce);
    nonGravity.copy(forceWorld);
    forceWorld.y -= weight;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    const load = nonGravity.dot(bodyAxis) / weight;
    scalars.smoothedLoad += (load - scalars.smoothedLoad) * (1 - Math.exp(-LOAD_SMOOTHING * dt));

    angularMomentum.copy(state.angularVelocity).applyMatrix3(inertia);
    gyro.crossVectors(state.angularVelocity, angularMomentum);
    angularAcceleration.copy(momentBody).sub(gyro).applyMatrix3(inverseInertia);

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
    checkRotorStrike(env);

    updateFlightData(env, surfaceHeight, airspeed, hoverShare, wingStall);
    updateWarnings(airspeed);
    trackConversion();
    writeCraftState();
    for (const entry of rotors) entry.angle = (entry.angle + tilt.rotations[entry.index] * rotor.speed * dt) % (Math.PI * 2);
    surfaces.aileron = controlsActual.aileron;
    surfaces.elevator = controlsActual.elevator;
    surfaces.rudder = controlsActual.rudder;
    surfaces.propSpeed = rotor.speed;
    surfaces.rotorShare = rotor.speed / tilt.governedSpeed;
    surfaces.discLeft = rotors[0].flap;
    surfaces.discRight = rotors[1].flap;
    surfaces.coning = (rotors[0].coning + rotors[1].coning) / 2;
    surfaces.flaps = systems.flaps;
    surfaces.gearPosition = systems.gearPosition;
    surfaces.groundSpeed = contactReport.onGround ? flightData.groundSpeed : 0;
    landingSample.dt = dt;
    landingSample.agl = flightData.agl;
    landing.observe(contactReport, landingSample);
  }

  function updateFlightData(env, surfaceHeight, airspeed, hoverShare, wingStall) {
    computeAttitude();
    const governed = rotor.governed;
    flightData.airspeed = airspeed;
    flightData.groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.verticalSpeed = state.velocity.y;
    flightData.aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    flightData.sideslip = airspeed > 0.5 ? Math.asin(clamp(bodyAir.x / airspeed, -1, 1)) : 0;
    flightData.gLoad = scalars.smoothedLoad;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.onGround = contactReport.onGround;
    flightData.agl = wheelHeight(surfaceHeight);
    flightData.rotorRpm = rotor.speed / governed;
    flightData.torque = (drivetrainState.engineTorque * governed) / tilt.engine.ratedPower;
    flightData.engineRunning = engine.mode === 'running';
    flightData.engineMode = engine.mode;
    flightData.collective = controlsActual.collective;
    flightData.hoverShare = hoverShare;
    flightData.nacelle = nacelle.angle * DEG;
    flightData.nacelleCommand = nacelle.command * DEG;
    flightData.corridorMin = nacelle.corridorMin * DEG;
    flightData.corridorMax = nacelle.corridorMax * DEG;
    flightData.corridorState = nacelle.corridorState;
    flightData.hoverInduced = (rotors[0].hoverInduced + rotors[1].hoverInduced) / 2;
    flightData.vortexRing = Math.max(rotors[0].vortexRing, rotors[1].vortexRing);
    flightData.bladeStall = Math.max(rotors[0].bladeStall, rotors[1].bladeStall);
    flightData.wingStall = wingStall;
    flightData.flaps = systems.flaps;
    const wing = tilt.wingHalves[0].result;
    flightData.stallMargin = Number.isFinite(wing.stallAngle) ? wing.stallAngle - Math.max(tilt.wingHalves[0].result.alpha, tilt.wingHalves[1].result.alpha) : 1;
    flightData.overspeed = airspeed > vne || flightData.rotorRpm > OVERSPEED_SHARE;
    flightData.trimCollective = trimCollective(env);
  }

  /**
   * The thrust lever that makes the rotors' vertical thrust hold the weight the wing does not carry,
   * at the current inflow (the assists' feed-forward).
   */
  function trimCollective(env) {
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const tip = Math.max(rotor.speed * tilt.radius, 1);
    let wingLift = 0;
    for (const entry of tilt.wingHalves) {
      bodyAxis.copy(entry.result.force).applyQuaternion(state.quaternion);
      wingLift += bodyAxis.y;
    }
    bodyAxis.copy(rotors[0].normal).applyQuaternion(state.quaternion);
    const verticalShare = Math.max(bodyAxis.y, 0.35);
    const required = Math.max(weight - Math.max(wingLift, 0), 0.05 * weight) * (1 + 0.5 * flightData.vortexRing * tilt.vrs.thrustLoss) / verticalShare / 2;
    const coefficient = required / (rho * tilt.discArea * tip * tip);
    const entry = rotors[0];
    const advance = entry.advance;
    // The pitch above the bias that gives that coefficient (the bias is not amplified by the edgewise flow).
    const loadingPitch = (coefficient / tilt.thrustSlope + entry.inflow / 2 - entry.bias / 3) / (1 / 3 + (advance * advance) / 2);
    const zero = leverPitch(0, scalars.leverBlend);
    const span = leverPitch(1, scalars.leverBlend) - zero;
    return clamp((loadingPitch - rotor.governorTrim - zero) / span, 0, 1);
  }

  function updateWarnings(airspeed) {
    const airborne = !contactReport.onGround;
    const corridorNow = nacelle.corridorState;
    const overspeed = airborne && (corridorNow === 'overspeed' || flightData.rotorRpm > OVERSPEED_SHARE);
    if (overspeed && !warnings.overspeed) {
      warnings.overspeed = true;
      notify('Rotor overspeed: too fast for this nacelle angle. The discs blow back and the blades stall. Tilt the nacelles forward or slow down.', 'warning');
    } else if (!overspeed && corridorNow === 'ok' && flightData.rotorRpm < OVERSPEED_SHARE - 0.02) {
      warnings.overspeed = false;
    }
    const wingStall = airborne && airspeed > 8 && (corridorNow === 'wingStall' || flightData.wingStall > 0.3);
    if (wingStall && !warnings.wingStall) {
      warnings.wingStall = true;
      notify('Wing stall: too slow for this nacelle angle. Tilt the nacelles up or add speed.', 'warning');
    } else if (!wingStall && corridorNow === 'ok' && flightData.wingStall < 0.05) {
      warnings.wingStall = false;
    }
    if (airborne && flightData.rotorRpm < LOW_RPM_WARNING - 0.02 && !warnings.lowRpm) {
      warnings.lowRpm = true;
      notify('Low proprotor rpm: lower the thrust lever.', 'warning');
    } else if (flightData.rotorRpm > LOW_RPM_WARNING + 0.02) {
      warnings.lowRpm = false;
    }
  }

  /** A full conversion (hover band to airplane mode, or back) counts in the journal, with its time. */
  function trackConversion() {
    const angle = nacelle.angle;
    const band = angle >= CONVERSION.HOVER ? 'hover' : angle <= CONVERSION.AIRPLANE ? 'airplane' : '';
    if (band === '') {
      if (conversion.lastMode !== '' && conversion.from === '') {
        conversion.from = conversion.lastMode;
        conversion.startTime = scalars.time;
      }
      return;
    }
    if (conversion.from !== '' && band !== conversion.from && !contactReport.onGround) {
      const seconds = scalars.time - conversion.startTime;
      bus.emitTyped('journalStat', { key: 'tiltrotorConversions', value: 1, op: 'add' });
      if (band === 'airplane') bus.emitTyped('journalStat', { key: 'tiltrotorFastestConversion', value: Math.round(seconds * 10) / 10, op: 'min' });
      notify(band === 'airplane' ? 'Conversion complete: airplane mode.' : 'Conversion complete: helicopter mode.', 'success');
    }
    conversion.from = '';
    conversion.lastMode = band;
  }

  function syncOrigin() {
    originOffset.copy(tilt.centerOfMass).applyQuaternion(state.quaternion);
    state.position.copy(centerPosition).sub(originOffset);
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  /**
   * Takes over a pose. The nacelles start where the pose's airspeed puts them: in the hover (90)
   * when slow, else on the auto-nacelle schedule for airplane mode at that speed (0 at cruise); on the
   * ground at the hover detent. Airborne the engines run at the governed rpm with the thrust lever at
   * the pose's throttle; on the ground the lever is down. A placement's craftState may set the angle.
   */
  function reset(pose = {}) {
    ensureCraftState();
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) {
      originOffset.copy(tilt.centerOfMass).applyQuaternion(state.quaternion);
      centerPosition.copy(pose.position).add(originOffset);
    }
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    syncOrigin();
    const onGround = pose.onGround === true;
    const engineOn = pose.engineOn !== false;
    const speed = state.velocity.length();
    conversionCorridor(speed, SEA_LEVEL_DENSITY, tilt.corridor, corridor);
    const angle = onGround || speed < 15 ? NACELLE.HOVER : scheduledNacelle(NACELLE.MIN, corridor, tilt.corridor.margin);
    nacelle.angle = angle;
    nacelle.selection = onGround || speed < 15 ? NACELLE.HOVER : NACELLE.MIN;
    nacelle.command = angle;
    nacelle.lever = NaN;
    nacelle.corridorMin = corridor.min;
    nacelle.corridorMax = corridor.max;
    nacelle.corridorState = 'ok';
    engine.mode = engineOn ? 'running' : 'off';
    engine.startElapsed = 0;
    engine.announceRunning = true;
    engine.integral = 0;
    engine.speed = engineOn ? 1 : 0;
    rotor.governed = scheduledSpeed(angle * DEG);
    rotor.speed = engineOn || !onGround ? rotor.governed : 0;
    rotor.governorTrim = 0;
    const hoverShare = smoothstep(HOVER_MIX[0] * DEG, HOVER_MIX[1] * DEG, angle * DEG);
    for (const entry of rotors) {
      entry.flap = 0;
      entry.vortexRing = 0;
      entry.thrust = onGround ? 0 : (weight / 2) * hoverShare;
      entry.induced = onGround ? 0 : Math.sqrt(Math.max(entry.thrust, 1) / (2 * SEA_LEVEL_DENSITY * tilt.discArea));
      entry.inflow = 0;
      entry.advance = 0;
      entry.pitch = 0;
      entry.bias = 0;
      placeRotor(entry, angle * DEG);
    }
    controlsActual.collective = onGround ? 0 : clamp(Number.isFinite(pose.throttle) ? pose.throttle : 0.5, 0, 1);
    controlsActual.pitch = 0;
    controlsActual.roll = 0;
    controlsActual.pedal = 0;
    controlsActual.elevator = 0;
    controlsActual.aileron = 0;
    controlsActual.rudder = 0;
    systems.gearDown = onGround || speed < 40;
    systems.gearPosition = systems.gearDown ? 1 : 0;
    systems.flaps = 1 - smoothstep(FLAP_SPEEDS[0], FLAP_SPEEDS[1], speed);
    engine.power = onGround ? tilt.engine.accessoryPower : 0.6 * tilt.engine.ratedPower;
    scalars.smoothedLoad = 1;
    updateLeverBlend(speed, SEA_LEVEL_DENSITY);
    warnings.overspeed = false;
    warnings.wingStall = false;
    warnings.lowRpm = false;
    warnings.groundLimit = false;
    warnings.scheduleHold = false;
    conversion.from = '';
    conversion.lastMode = angle >= CONVERSION.HOVER ? 'hover' : angle <= CONVERSION.AIRPLANE ? 'airplane' : '';
    contact.reset(onGround);
    landing.reset(onGround);
    contactReport.onGround = onGround;
    flightData.onGround = onGround;
    resetCount++;
    flightData.resetCount = resetCount;
    computeAttitude();
    flightData.airspeed = speed;
    flightData.collective = controlsActual.collective;
    flightData.rotorRpm = 1;
    flightData.nacelle = angle * DEG;
    flightData.hoverShare = hoverShare;
    writeCraftState();
    return true;
  }

  function writeTelemetry(flight) {
    flight.aoa = flightData.aoa / DEG;
    flight.sideslip = flightData.sideslip / DEG;
    flight.gLoad = flightData.gLoad;
    // The throttle instrument shows the thrust control lever (the collective).
    flight.throttle = controlsActual.collective;
    flight.afterburner = false;
    flight.engineOn = engine.mode !== 'off';
    flight.rpm = clamp(engine.speed, 0, ROTOR_SPEED_MAX);
    // 1 = the scheduled governed speed (100 % in helicopter mode, 84 % of it in airplane mode).
    flight.rotorRpm = flightData.rotorRpm;
    flight.torque = Math.max(0, flightData.torque);
    flight.flaps = systems.flaps;
    flight.flapNotch = 0;
    flight.gear.retractable = Boolean(tilt.gear && tilt.gear.retractable);
    flight.gear.down = systems.gearDown;
    flight.gear.transit = Math.min(systems.gearPosition, 1 - systems.gearPosition) * 2;
    flight.airbrake = 0;
    flight.brakes = Math.max(controlsActual.brakeLeft, controlsActual.brakeRight);
    flight.trim = controlsActual.trim;
    flight.contacts = contactReport.contacts;
    if (Number.isFinite(flightData.agl)) flight.radarAltitude = Math.max(0, flightData.agl);
    // The stall lamp is the wing's (with airspeed) and the corridor's lower edge; the rotors' blade
    // stall and vortex ring buffet too.
    const wingStalled = flightData.wingStall > 0.3;
    flight.stall.stalled = wingStalled || flightData.vortexRing > 0.6;
    flight.stall.warning = !contactReport.onGround && (warnings.wingStall || (flightData.airspeed > 20 && flightData.stallMargin < 3 * DEG && flightData.hoverShare < 0.9));
    flight.stall.buffet = Math.round(clamp(Math.max(flightData.vortexRing, flightData.bladeStall, flightData.wingStall), 0, 1) * 1000) / 1000;
    flight.overspeed = flightData.overspeed;
  }

  function snapshot() {
    return {
      kind: 'tiltrotor',
      center: [centerPosition.x, centerPosition.y, centerPosition.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      rotor: { ...rotor },
      rotors: rotors.map((entry) => ({ flap: entry.flap, induced: entry.induced, thrust: entry.thrust, vortexRing: entry.vortexRing, inflow: entry.inflow, advance: entry.advance, pitch: entry.pitch, bias: entry.bias, angle: entry.angle })),
      nacelle: { angle: nacelle.angle, selection: nacelle.selection, command: nacelle.command, lever: Number.isFinite(nacelle.lever) ? nacelle.lever : null },
      engine: { ...engine },
      controls: { ...controlsActual },
      systems: { ...systems },
      load: scalars.smoothedLoad,
      time: scalars.time,
      contact: contact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'tiltrotor') return false;
    centerPosition.fromArray(data.center);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    Object.assign(rotor, data.rotor);
    data.rotors.forEach((saved, index) => Object.assign(rotors[index], saved));
    nacelle.angle = data.nacelle.angle;
    nacelle.selection = data.nacelle.selection;
    nacelle.command = data.nacelle.command;
    nacelle.lever = data.nacelle.lever === null ? NaN : data.nacelle.lever;
    Object.assign(engine, data.engine);
    Object.assign(controlsActual, data.controls);
    Object.assign(systems, data.systems);
    scalars.smoothedLoad = Number.isFinite(data.load) ? data.load : 1;
    scalars.time = Number.isFinite(data.time) ? data.time : scalars.time;
    contact.restore(data.contact);
    landing.restore(data.landing);
    syncOrigin();
    computeAttitude();
    for (const entry of rotors) placeRotor(entry, nacelle.angle * DEG);
    writeCraftState();
    return true;
  }

  return {
    kind: 'tiltrotor',
    profile,
    state,
    contact: contactReport,
    surfaces,
    flightData,
    reset,
    step,
    writeTelemetry,
    snapshot,
    restore,

    get resetCount() {
      return resetCount;
    },
    get centerOfMass() {
      return centerPosition;
    },
    get landings() {
      return landing.landings;
    },
    /** The corridor constants (tiltrotorCorridor.js) for the assists, the autopilot and the labs. */
    get corridorParameters() {
      return tilt.corridor;
    },
    /** Rotor and nacelle internals for the lab and the dev tools (N, N m, rad, deg). */
    get rotor() {
      return {
        thrustLeft: rotors[0].thrust,
        thrustRight: rotors[1].thrust,
        torque: rotors[0].torque + rotors[1].torque,
        flapLeft: rotors[0].flap,
        flapRight: rotors[1].flap,
        inducedLeft: rotors[0].induced,
        advance: rotors[0].advance,
        pitch: rotors[0].pitch,
        speed: rotor.speed,
        governedSpeed: rotor.governed,
        governorTrim: rotor.governorTrim,
        enginePower: engine.power,
        availablePower: drivetrainState.available,
        nacelle: nacelle.angle,
        nacelleCommand: nacelle.command,
        selection: nacelle.selection,
        wingLift: tilt.wingHalves[0].result.force.y + tilt.wingHalves[1].result.force.y,
      };
    },

    dispose() {
      contactReport.touchdown = null;
      contactReport.bodyStrike = null;
    },
  };
}
