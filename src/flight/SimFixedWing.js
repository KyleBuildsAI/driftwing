// SimFixedWing: the SIM flight model for fixed-wing craft (glider, bush plane, and the jet later).
//
// A 6-DOF rigid body in SI units: centre-of-mass position and velocity (world), attitude quaternion
// (body to world) and body angular velocity, integrated semi-implicitly at the controller's fixed
// 120 Hz with a full inertia tensor (including the yaw-roll product of inertia) and the propeller's
// angular momentum in Euler's equations.
//
// Aerodynamics are built up from components, each flying in its own local airflow (the air-relative
// velocity plus rotation, prop slipstream and downwash), which is where the handling comes from:
//   wing          four panels (inboard and outboard, left and right) with dihedral, washout and the
//                 craft's lift curve (linear to the critical angle of attack, then a post-stall drop).
//                 Roll damping, dihedral effect, adverse yaw (induced drag and lift tilt), the stall
//                 wing drop that follows sideslip, and spin autorotation all emerge from the panels.
//                 Ailerons shift the outboard panels' angle of attack; flaps and spoilers add lift,
//                 lift-limit and drag increments across the wing (spoilers across the inboard panels)
//                 Past the stall a section loses its leading-edge suction (force normal to the chord)
//   h. tail       downwash from the wing's lift, elevator plus pitch trim; pitch stability and damping;
//                 a stalled wing's wake takes some of its dynamic pressure
//   fin           rudder; weathervane stability and yaw damping; slipstream swirl on prop craft; the
//                 stabilizer's wake shadows part of it at high angles of attack (spins)
//   fuselage      parasitic drag (cd0 plus retractable gear) at the profile's drag centre, a
//                 slender-body side force and cross-flow drag at two stations (damping in spins)
//   propeller     thrust from engine power and efficiency against airspeed, torque roll, P-factor,
//                 gyroscopic precession and a slipstream over the tail and wing roots
//   ground        spring-damper gear, brakes and steering against the shared height function
//                 (groundContact.js); ground effect reduces induced drag within about a span
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state,
// contact, writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (mesh animation),
// flightData (read by the assist and autopilot control stages) and dispose().
//
// Craft extension (optional): profile.extension({ profile, craft, bus, craftState, limits, flightData })
// returns hooks for physics the generic airframe does not cover (the jet: turbofan, transonic drag,
// flight control system). Every hook is optional and receives the live `tick` (see createTick):
//   shapeControls(controls, tick)             before the actuators (gain schedules, detents)
//   engine: { update(controls, tick), forces(tick, forceBody, momentBody), reset(pose, systems) }
//                                             replaces the propeller engine (spool, thrust, telemetry)
//   dragCoefficient(tick) -> number           added to cd0 (wave drag)
//   moments(tick, momentBody)                 extra body moments (dampers, buffet, wing rock)
//   afterStep(tick)                           after flightData is written
//   reset(pose, systems), writeTelemetry(flight), snapshot(), restore(data)
// profile.vneBasis 'equivalent' compares equivalent airspeed with Vne; profile.maxSpeed raises the
// speed guard for fast craft. The model's kind is profile.model, so an airframe registered under its
// own kind (flightModels.register('jet', createSimFixedWingModel)) gets its own assists and autopilot.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import {
  GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, createSurface, createSurfaceInput, createSurfaceResult, surfaceForce, liftSlope,
  groundEffectFactor, pistonPowerLapse, propellerThrust, slipstreamIncrement, smoothstep,
} from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { stallWarningActive } from './assists.js';

const DEFAULT_SERVO_RATE = 5;
const TAIL_CL_MAX = 1.1;
const FIN_END_PLATE = 1.55;
const CROSSFLOW_DRAG = 1.1;
/** The fin starts to sit in the stabilizer's wake past this body angle of attack, fully by the second. */
const FIN_SHADOW_START = 14 * DEG;
const FIN_SHADOW_FULL = 32 * DEG;
/** Flap lever: a move this large picks a notch; notch changes need half a notch plus this hysteresis. */
const LEVER_MOVE = 0.03;
const LEVER_HYSTERESIS = 0.3;
const MAX_ANGULAR_SPEED = 12;
const MAX_SPEED = 400;
const LOAD_SMOOTHING = 25;
/** Buffet begins this far (rad) below the critical angle of attack. */
const BUFFET_ONSET = 3 * DEG;
const STALLED_DEPTH = 0.3;

/** Smooth deterministic noise in about [-1, 1] (buffet, flutter and turbulence moments). */
function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

/** Geometry and derived constants of the airframe from a simProfile (body axes, relative to the CG). */
function buildAirframe(profile) {
  const { wing, aero, tail, fuselage } = profile;
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass ?? [0, 0, 0]);
  const aspectRatio = (wing.span * wing.span) / wing.area;
  const inducedFactor = 1 / (Math.PI * wing.oswald * aspectRatio);
  const curve = createLiftCurve({
    clAlpha: aero.clAlpha,
    clMax: aero.clMax,
    clMin: aero.clMin,
    alphaCritical: aero.alphaCritical,
    postStallDrop: aero.postStallClDrop,
    dropWidth: aero.stallDropWidth,
    blendWidth: aero.stallBlendWidth,
  });
  const semiSpan = wing.span / 2;
  const taper = Number.isFinite(wing.taper) ? wing.taper : 1;
  const rootChord = (2 * wing.area) / (wing.span * (1 + taper));
  const midChord = (rootChord * (1 + taper)) / 2;
  const tipChord = rootChord * taper;
  const dihedral = wing.dihedral * DEG;
  const center = new THREE.Vector3().fromArray(wing.aerodynamicCenter);
  const segments = [
    { outer: false, from: 0, to: 0.5, chordFrom: rootChord, chordTo: midChord },
    { outer: true, from: 0.5, to: 1, chordFrom: midChord, chordTo: tipChord },
  ];
  const panels = [];
  for (const side of [-1, 1]) {
    for (const segment of segments) {
      const width = (segment.to - segment.from) * semiSpan;
      const area = 0.5 * (segment.chordFrom + segment.chordTo) * width;
      const centroid = segment.from * semiSpan + (width * (segment.chordFrom + 2 * segment.chordTo)) / (3 * (segment.chordFrom + segment.chordTo));
      const position = new THREE.Vector3(side * centroid, center.y + centroid * Math.tan(dihedral), center.z).sub(centerOfMass);
      const normal = new THREE.Vector3(-side * Math.sin(dihedral), Math.cos(dihedral), 0);
      const incidence = wing.incidence - (segment.outer ? wing.washout ?? 0 : 0);
      panels.push({
        side,
        outer: segment.outer,
        area,
        surface: createSurface({ id: `${side < 0 ? 'left' : 'right'}${segment.outer ? 'Outer' : 'Inner'}`, position, normal, area, meanChord: area / width, curve, inducedFactor, incidence: incidence * DEG, cm0: wing.cm0 ?? 0 }),
        input: createSurfaceInput(),
        result: createSurfaceResult(),
      });
    }
  }
  const innerArea = panels.filter((panel) => !panel.outer).reduce((sum, panel) => sum + panel.area, 0);

  const horizontal = tail.horizontal;
  const horizontalSlope = liftSlope(horizontal.aspectRatio);
  const horizontalCurve = createLiftCurve({ clAlpha: horizontalSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / horizontalSlope / DEG, postStallDrop: 0.3 });
  const horizontalTail = {
    surface: createSurface({
      id: 'horizontalTail',
      position: new THREE.Vector3().fromArray(horizontal.position).sub(centerOfMass),
      normal: new THREE.Vector3(0, 1, 0),
      area: horizontal.area,
      meanChord: Math.sqrt(horizontal.area / horizontal.aspectRatio),
      curve: horizontalCurve,
      inducedFactor: 1 / (Math.PI * 0.8 * horizontal.aspectRatio),
      incidence: (horizontal.incidence ?? 0) * DEG,
    }),
    input: createSurfaceInput(),
    result: createSurfaceResult(),
    downwash: Number.isFinite(horizontal.downwash) ? horizontal.downwash : 1,
    /** Share of dynamic pressure lost in a fully stalled wing's wake. */
    wake: Number.isFinite(horizontal.wake) ? horizontal.wake : 0.4,
  };
  const vertical = tail.vertical;
  const finAspect = vertical.aspectRatio * FIN_END_PLATE;
  const finSlope = liftSlope(finAspect);
  const finCurve = createLiftCurve({ clAlpha: finSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / finSlope / DEG, postStallDrop: 0.3 });
  const fin = {
    surface: createSurface({
      id: 'fin',
      position: new THREE.Vector3().fromArray(vertical.position).sub(centerOfMass),
      normal: new THREE.Vector3(1, 0, 0),
      area: vertical.area,
      meanChord: Math.sqrt(vertical.area / vertical.aspectRatio),
      curve: finCurve,
      inducedFactor: 1 / (Math.PI * 0.8 * finAspect),
      incidence: (vertical.offset ?? 0) * DEG,
    }),
    input: createSurfaceInput(),
    result: createSurfaceResult(),
    /** Share of dynamic pressure the stabilizer's wake takes from the fin at high angles of attack. */
    shadow: Number.isFinite(vertical.shadow) ? vertical.shadow : 0.4,
  };

  const crossflowStations = fuselage.crossflowStations.map((z) => ({ position: new THREE.Vector3(0, 0, z).sub(centerOfMass), area: fuselage.sideArea / fuselage.crossflowStations.length }));
  return {
    centerOfMass,
    /** Where the parasitic drag acts (relative to the centre of mass); the centre of mass by default. */
    dragCenter: aero.dragCenter ? new THREE.Vector3().fromArray(aero.dragCenter).sub(centerOfMass) : new THREE.Vector3(),
    aspectRatio,
    inducedFactor,
    curve,
    panels,
    innerArea,
    horizontalTail,
    fin,
    sideForce: { position: new THREE.Vector3(0, 0, fuselage.sideForceZ).sub(centerOfMass), area: fuselage.sideArea, slope: fuselage.sideForceSlope },
    crossflowStations,
    wingHeight: center.y - centerOfMass.y,
  };
}

/** Engine constants from a simProfile engine block, or null for engineless craft. */
function buildEngine(engine, centerOfMass) {
  if (!engine) return null;
  const radius = engine.propDiameter / 2;
  return {
    ratedPower: engine.powerKw * 1000,
    staticThrust: engine.staticThrustN,
    efficiency: engine.propEfficiency,
    designSpeed: engine.designSpeed,
    staticFade: engine.staticFade,
    idleShare: engine.idlePower,
    spoolSeconds: engine.spoolSeconds,
    idleRpm: engine.idleRpm,
    maxRpm: engine.maxRpm,
    discArea: Math.PI * radius * radius,
    position: new THREE.Vector3().fromArray(engine.position).sub(centerOfMass),
    propInertia: engine.propInertia,
    rotation: engine.rotation === 'counterclockwise-from-cockpit' ? -1 : 1,
    pFactorArm: engine.pFactorArm,
    swirl: engine.swirl,
    slipstreamTail: engine.slipstreamTail,
    slipstreamWing: engine.slipstreamWing,
    windmillDrag: engine.windmillDrag,
  };
}

export function createSimFixedWingModel({ profile, craft, bus, craftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'craft';
  const craftName = craft && craft.name ? craft.name.toLowerCase() : 'craft';
  const inputProfile = (craft && craft.inputProfile) || {};
  const airframe = buildAirframe(profile);
  const engine = buildEngine(profile.engine, airframe.centerOfMass);
  const flapsProfile = profile.flaps ?? null;
  const spoilerProfile = profile.spoilers ?? null;
  const gearProfile = profile.gear ?? { retractable: false };
  const controlLimits = profile.controls;
  const effectiveness = controlLimits.effectiveness;
  const trimRange = controlLimits.trimRange;
  const servoRate = Number.isFinite(controlLimits.servoRate) ? controlLimits.servoRate : DEFAULT_SERVO_RATE;
  const wingArea = profile.wing.area;
  const wingSpan = profile.wing.span;
  const meanChord = profile.wing.area / profile.wing.span;
  const dryMass = profile.mass.empty + profile.mass.pilot + (profile.mass.fuel ?? 0);
  const ballastProfile = profile.ballast ?? null;
  const vne = Number.isFinite(limits.vne) ? limits.vne : profile.targets?.vne ?? 80;
  const gLimit = Number.isFinite(limits.gLimit) ? limits.gLimit : 4;
  const flapNotches = flapsProfile ? flapsProfile.notches : [0];
  const notchSpacing = flapNotches.length > 1 ? (flapNotches[flapNotches.length - 1] - flapNotches[0]) / (flapNotches.length - 1) : 1;
  const tiltedAileron = controlLimits.aileron * DEG * effectiveness.aileron;
  const elevatorShift = controlLimits.elevator * DEG * effectiveness.elevator;
  const rudderShift = controlLimits.rudder * DEG * effectiveness.rudder;
  const wingIncidence = profile.wing.incidence * DEG;
  const maxSpeed = Number.isFinite(profile.maxSpeed) ? profile.maxSpeed : MAX_SPEED;
  /** The model kind: 'fixedWing', or the profile's own kind for an airframe with its own assists (the jet). */
  const modelKind = typeof profile.model === 'string' && profile.model ? profile.model : 'fixedWing';
  const equivalentVne = profile.vneBasis === 'equivalent';

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
  let mass = dryMass;
  const inertia = new THREE.Matrix3();
  const inverseInertia = new THREE.Matrix3();
  let inertiaMass = NaN;

  const contact = createGroundContact(profile.contacts, { centerOfMass: airframe.centerOfMass, floats: limits.floats === true, mass: dryMass + (ballastProfile ? ballastProfile.capacity : 0) });
  const landing = createLandingMonitor({ bus, craftId, limits });
  /** Contact report the controller reads (FlightModel.contact); aliases the evaluator's live report. */
  const contactReport = contact.report;

  // ---- Systems ------------------------------------------------------------------------------------------
  const surfacesActual = { aileron: 0, elevator: 0, rudder: 0 };
  /** Deflections (-1..1) and visual prop speed (rad/s) for the mesh; groundSpeed rolls the wheels. */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };
  const systems = {
    throttle: 0,
    running: Boolean(engine),
    powerShare: 0,
    rpmShare: 0,
    flapNotch: 0,
    flapPosition: 0,
    spoilers: 0,
    gearDown: true,
    gearPosition: 1,
    brakeLeft: 0,
    brakeRight: 0,
    trim: 0,
    pitchCommand: 0,
    flapLever: NaN,
    antennaLever: NaN,
  };
  let time = 0;
  let resetCount = 0;
  let smoothedLoad = 1;
  let wingStallDepth = 0;

  // ---- Live flight data (control stages and telemetry read it; SI, radians) ---------------------------
  const flightData = {
    airspeed: 0,
    aoa: 0,
    aoaCritical: airframe.curve.alphaZero + airframe.curve.clMax / airframe.curve.clAlpha - wingIncidence,
    stallMargin: 0,
    /** Smallest stall margin (rad) of any wing panel: sideslip, roll rate and ailerons included. */
    panelMargin: 0,
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
    stallSpeed: 0,
    stalled: false,
    buffet: 0,
    overspeed: false,
    vne,
    gLimit,
    hasEngine: Boolean(engine),
    engineRunning: Boolean(engine),
    hasSpoilers: Boolean(spoilerProfile),
    throttle: 0,
    pitchCommand: 0,
    elevator: 0,
    dynamicPressure: 0,
    mass,
    wingArea,
    resetCount: 0,
  };

  // ---- Craft extension (see the header) -------------------------------------------------------------------
  const extension = typeof profile.extension === 'function' ? profile.extension({ profile, craft, bus, craftState, limits, flightData }) : null;
  const extensionEngine = extension && extension.engine ? extension.engine : null;
  /** Any engine at all: the propeller engine or an extension's (thrust, throttle, engine toggle). */
  const powered = Boolean(engine || extensionEngine);
  systems.running = powered;
  flightData.hasEngine = powered;
  flightData.engineRunning = powered;

  // ---- Scratch -------------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const airVelocityWorld = new THREE.Vector3();
  const bodyAir = new THREE.Vector3();
  const localVelocity = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const forceBody = new THREE.Vector3();
  const momentBody = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const lever = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const propMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const angularAcceleration = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const bodyAxis = new THREE.Vector3();
  const originOffset = new THREE.Vector3();
  const nonGravity = new THREE.Vector3();
  const contactBody = { position: centerPosition, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };
  /**
   * What an extension sees each tick (live, reused): SI units, radians. Air data is this tick's once
   * the forces run and last tick's in shapeControls / engine.update; wingCl is last tick's.
   */
  const tick = {
    dt: 0,
    time: 0,
    controls: null,
    env: null,
    assists: 1,
    rho: SEA_LEVEL_DENSITY,
    altitude: 0,
    airspeed: 0,
    dynamicPressure: 0,
    aoa: 0,
    sideslip: 0,
    wingCl: 0,
    gLoad: 1,
    onGround: false,
    mass: dryMass,
    wingArea,
    wingSpan,
    meanChord,
    bodyAir,
    angularVelocity: state.angularVelocity,
    systems,
    surfaces: surfacesActual,
    flightData,
  };

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // MASS AND INERTIA
  // ============================================================================================
  function ballastMass() {
    if (!ballastProfile) return 0;
    const fill = Number.isFinite(craftState.ballast) ? clamp(craftState.ballast, 0, 1) : 0;
    return fill * ballastProfile.capacity;
  }

  /** Mass and the inertia tensor (water ballast sits in the wings, raising roll and yaw inertia). */
  function updateMass() {
    const ballast = ballastMass();
    mass = dryMass + ballast;
    flightData.mass = mass;
    if (mass === inertiaMass) return;
    inertiaMass = mass;
    const spanwise = ballast * (ballastProfile ? ballastProfile.arm * ballastProfile.arm : 0);
    const { pitch, yaw, roll, yawRoll = 0 } = profile.inertia;
    inertia.set(
      pitch, 0, 0,
      0, yaw + spanwise, yawRoll,
      0, yawRoll, roll + spanwise,
    );
    inverseInertia.copy(inertia).invert();
  }

  // ============================================================================================
  // PILOT INPUTS -> ACTUATORS
  // ============================================================================================
  function nearestNotchIndex(position) {
    let best = 0;
    for (let index = 1; index < flapNotches.length; index++) {
      if (Math.abs(flapNotches[index] - position) < Math.abs(flapNotches[best] - position)) best = index;
    }
    return best;
  }

  /** A flap lever (the flaps axis or a HOTAS antenna) picks a notch when it moves, with hysteresis. */
  function readFlapLever(value, key) {
    if (!Number.isFinite(value)) return;
    const previous = systems[key];
    if (!Number.isFinite(previous)) {
      systems[key] = value;
      return;
    }
    if (Math.abs(value - previous) < LEVER_MOVE) return;
    systems[key] = value;
    if (!flapsProfile) return;
    const target = nearestNotchIndex(value);
    const current = systems.flapNotch;
    if (target !== current && Math.abs(value - flapNotches[current]) > notchSpacing * (0.5 + LEVER_HYSTERESIS)) systems.flapNotch = target;
  }

  function handleActions(actions) {
    if (!actions || actions.size === 0) return;
    for (const action of actions) {
      switch (action) {
        case 'flapsDown':
          if (flapsProfile) systems.flapNotch = Math.min(flapNotches.length - 1, systems.flapNotch + 1);
          else notify(spoilerProfile ? `The ${craftName} has no flaps: hold the airbrake for the spoilers.` : `The ${craftName} has no flaps.`);
          break;
        case 'flapsUp':
          if (flapsProfile) systems.flapNotch = Math.max(0, systems.flapNotch - 1);
          else notify(`The ${craftName} has no flaps.`);
          break;
        case 'gearToggle':
          if (gearProfile.retractable) {
            if (systems.gearDown && contactReport.onGround) notify('The gear stays down on the ground.', 'warning');
            else systems.gearDown = !systems.gearDown;
          } else {
            notify(`The ${craftName} has fixed landing gear.`);
          }
          break;
        case 'engineToggle':
          if (powered) {
            systems.running = !systems.running;
            notify(systems.running ? 'Engine running.' : 'Engine off.', systems.running ? 'success' : 'warning');
          } else {
            notify(`The ${craftName} has no engine.`);
          }
          break;
        case 'chuteDeploy':
          notify(`The ${craftName} has no parachute.`);
          break;
        default:
          break;
      }
    }
  }

  function updateActuators(controls, dt) {
    if (extension && extension.shapeControls) extension.shapeControls(controls, tick);
    handleActions(controls.actions);
    readFlapLever(controls.flaps, 'flapLever');
    readFlapLever(controls.antenna, 'antennaLever');
    const onGround = contactReport.onGround;
    const airbrakeHeld = Boolean(controls.held && controls.held.has('airbrake'));
    const brakeLeft = clamp(Number.isFinite(controls.brakeL) ? controls.brakeL : 0, 0, 1);
    const brakeRight = clamp(Number.isFinite(controls.brakeR) ? controls.brakeR : 0, 0, 1);

    // Flight controls: servos with a rate limit; the trim tab adds to the elevator.
    const servoStep = servoRate * dt;
    const pitchCommand = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    systems.pitchCommand = pitchCommand;
    systems.trim = clamp(Number.isFinite(controls.trim) ? controls.trim : 0, -1, 1);
    surfacesActual.aileron = moveToward(surfacesActual.aileron, clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1), servoStep);
    surfacesActual.elevator = moveToward(surfacesActual.elevator, clamp(pitchCommand + systems.trim * trimRange, -1, 1), servoStep);
    surfacesActual.rudder = moveToward(surfacesActual.rudder, clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1), servoStep);

    // Flaps travel toward the selected notch.
    if (flapsProfile) {
      const flapTarget = flapNotches[systems.flapNotch];
      systems.flapPosition = moveToward(systems.flapPosition, flapTarget, dt / flapsProfile.deploySeconds);
    }
    // Spoilers: the airbrake action, or both toe brakes in the air.
    if (spoilerProfile) {
      const symmetricToe = Math.min(brakeLeft, brakeRight);
      const spoilerTarget = Math.max(airbrakeHeld ? 1 : 0, onGround ? 0 : symmetricToe);
      systems.spoilers = moveToward(systems.spoilers, spoilerTarget, dt / spoilerProfile.deploySeconds);
    }
    // Wheel brakes: toe brakes (differential steers); the airbrake action brakes both on the ground.
    systems.brakeLeft = Math.max(brakeLeft, airbrakeHeld ? 1 : 0);
    systems.brakeRight = Math.max(brakeRight, airbrakeHeld ? 1 : 0);
    // Retractable gear travels; fixed gear is always down.
    if (gearProfile.retractable) {
      systems.gearPosition = moveToward(systems.gearPosition, systems.gearDown ? 1 : 0, dt / gearProfile.transitSeconds);
    }

    // Throttle and engine spool.
    systems.throttle = powered ? clamp(Number.isFinite(controls.throttle) ? controls.throttle : 0, 0, 1) : 0;
    if (extensionEngine) extensionEngine.update(controls, tick);
    else if (engine) {
      const target = systems.running ? engine.idleShare + (1 - engine.idleShare) * systems.throttle : 0;
      const spool = 1 - Math.exp(-dt / engine.spoolSeconds);
      systems.powerShare += (target - systems.powerShare) * spool;
    }

    contactInputs.brakeLeft = systems.brakeLeft;
    contactInputs.brakeRight = systems.brakeRight;
    contactInputs.steering = inputProfile.rudderSteersTailwheel ? surfacesActual.rudder : 0;
    contactInputs.gearDown = systems.gearPosition > 0.98;
  }

  // ============================================================================================
  // FORCES
  // ============================================================================================
  const aeroState = { wingLift: 0, stallDepth: 0, maxStall: 0, aoaCritical: 0, minMargin: Infinity };

  /** Velocity of a body point relative to the air (body axes): the air velocity plus rotation. */
  function pointAirVelocity(position, target) {
    spin.crossVectors(state.angularVelocity, position);
    return target.copy(bodyAir).add(spin);
  }

  function addSurface(surfaceEntry) {
    const { surface, result } = surfaceEntry;
    forceBody.add(result.force);
    lever.crossVectors(surface.position, result.force);
    momentBody.add(lever).add(result.moment);
  }

  function wingIncrements(panel, input, groundEffect) {
    const flap = systems.flapPosition;
    // Right stick raises the right aileron (less lift on the right wing) and lowers the left one.
    input.alphaOffset = panel.outer ? -panel.side * surfacesActual.aileron * tiltedAileron : 0;
    input.deltaCl = 0;
    input.deltaClMax = 0;
    input.extraDrag = 0;
    input.cm = 0;
    input.inducedScale = groundEffect;
    if (flapsProfile && flap > 0) {
      input.deltaCl += flapsProfile.clIncrement * flap;
      input.deltaClMax += flapsProfile.clMaxIncrement * flap;
      input.extraDrag += flapsProfile.cdIncrement * flap;
      input.cm += flapsProfile.pitchMoment * flap;
    }
    if (spoilerProfile && systems.spoilers > 0 && !panel.outer) {
      const scale = wingArea / airframe.innerArea;
      input.deltaCl -= spoilerProfile.clLoss * systems.spoilers * scale;
      input.deltaClMax -= spoilerProfile.clLoss * systems.spoilers * scale;
      input.extraDrag += spoilerProfile.cdIncrement * systems.spoilers * scale;
    }
  }

  /**
   * Aerodynamic forces and moments (body axes) for the current state. slipstream: the propeller's
   * slipstream speed increment (m/s) and swirl, from engineForces.
   */
  function aeroForces(rho, groundEffect, slipstream) {
    aeroState.wingLift = 0;
    aeroState.stallDepth = 0;
    aeroState.maxStall = 0;
    aeroState.minMargin = Infinity;
    let innerStallAngle = Infinity;
    for (const panel of airframe.panels) {
      pointAirVelocity(panel.surface.position, localVelocity);
      if (!panel.outer && engine) localVelocity.z -= slipstream.speed * engine.slipstreamWing;
      wingIncrements(panel, panel.input, groundEffect);
      surfaceForce(panel.surface, localVelocity, rho, panel.input, panel.result);
      addSurface(panel);
      aeroState.wingLift += panel.result.cl * panel.area;
      aeroState.stallDepth += panel.result.stall * panel.area;
      aeroState.maxStall = Math.max(aeroState.maxStall, panel.result.stall);
      aeroState.minMargin = Math.min(aeroState.minMargin, panel.result.stallAngle - panel.result.alpha);
      if (!panel.outer) innerStallAngle = Math.min(innerStallAngle, panel.result.stallAngle);
    }
    const wingCl = aeroState.wingLift / wingArea;
    aeroState.stallDepth /= wingArea;
    aeroState.aoaCritical = innerStallAngle - wingIncidence;
    const bodyAoa = Math.atan2(-bodyAir.y, -bodyAir.z);

    // Horizontal tail: downwash from the wing's lift, elevator (nose up lowers the tail's angle). A
    // stalled wing's wake robs it of dynamic pressure (scaling the local velocity by sqrt(share)
    // scales its force by the share and keeps its angle of attack).
    const horizontal = airframe.horizontalTail;
    pointAirVelocity(horizontal.surface.position, localVelocity);
    if (engine) localVelocity.z -= slipstream.speed * engine.slipstreamTail;
    localVelocity.multiplyScalar(Math.sqrt(1 - horizontal.wake * aeroState.stallDepth));
    const downwash = (2 * wingCl * horizontal.downwash) / (Math.PI * airframe.aspectRatio);
    horizontal.input.alphaOffset = -downwash - surfacesActual.elevator * elevatorShift;
    horizontal.input.inducedScale = 1;
    surfaceForce(horizontal.surface, localVelocity, rho, horizontal.input, horizontal.result);
    addSurface(horizontal);

    // Fin: rudder right lowers its angle (force to the left, nose right); slipstream swirl on prop
    // craft. At high angles of attack the stabilizer's wake shadows part of it (spins).
    const fin = airframe.fin;
    pointAirVelocity(fin.surface.position, localVelocity);
    if (engine) {
      localVelocity.z -= slipstream.speed * engine.slipstreamTail;
      localVelocity.x -= slipstream.swirl;
    }
    localVelocity.multiplyScalar(Math.sqrt(1 - fin.shadow * smoothstep(FIN_SHADOW_START, FIN_SHADOW_FULL, Math.abs(bodyAoa))));
    fin.input.alphaOffset = -surfacesActual.rudder * rudderShift;
    fin.input.inducedScale = 1;
    surfaceForce(fin.surface, localVelocity, rho, fin.input, fin.result);
    addSurface(fin);

    // Parasitic drag at the drag centre (the wing's and fuselage's share together), slender-body
    // side force, cross-flow drag.
    const airspeed = bodyAir.length();
    if (airspeed > 0.1) {
      const dynamicPressure = 0.5 * rho * airspeed * airspeed;
      const gearDrag = gearProfile.retractable ? (gearProfile.cdIncrement ?? 0) * systems.gearPosition : 0;
      const extraDrag = extension && extension.dragCoefficient ? extension.dragCoefficient(tick) : 0;
      const parasitic = dynamicPressure * wingArea * (profile.aero.cd0 + gearDrag + extraDrag);
      lever.copy(bodyAir).multiplyScalar(-parasitic / airspeed);
      forceBody.add(lever);
      momentBody.add(spin.crossVectors(airframe.dragCenter, lever));
      const side = airframe.sideForce;
      pointAirVelocity(side.position, localVelocity);
      const sideForce = -0.5 * rho * localVelocity.length() * localVelocity.x * side.area * side.slope;
      lever.set(sideForce, 0, 0);
      forceBody.add(lever);
      momentBody.add(spin.crossVectors(side.position, lever));
    }
    for (const station of airframe.crossflowStations) {
      pointAirVelocity(station.position, localVelocity);
      const crossSpeed = Math.hypot(localVelocity.x, localVelocity.y);
      if (crossSpeed < 0.05) continue;
      const scale = -0.5 * rho * crossSpeed * station.area * CROSSFLOW_DRAG;
      lever.set(localVelocity.x * scale, localVelocity.y * scale, 0);
      forceBody.add(lever);
      momentBody.add(spin.crossVectors(station.position, lever));
    }
  }

  const slipstreamState = { speed: 0, swirl: 0, thrust: 0, propSpeed: 0 };

  /** Propeller thrust, windmilling drag, torque, P-factor and the slipstream for the tail. */
  function engineForces(rho) {
    slipstreamState.speed = 0;
    slipstreamState.swirl = 0;
    slipstreamState.thrust = 0;
    if (extensionEngine) {
      slipstreamState.thrust = extensionEngine.forces(tick, forceBody, momentBody);
      return slipstreamState;
    }
    if (!engine) return slipstreamState;
    const axial = -bodyAir.z;
    const power = engine.ratedPower * pistonPowerLapse(rho) * systems.powerShare;
    const thrust = propellerThrust(engine, power, axial, rho);
    const windmilling = axial > 0 ? engine.windmillDrag * 0.5 * rho * axial * axial * engine.discArea * (1 - systems.powerShare) ** 2 : 0;
    lever.set(0, 0, -(thrust - windmilling));
    forceBody.add(lever);
    momentBody.add(spin.crossVectors(engine.position, lever));
    // Engine speed: governed by power at low speed, windmilling with airspeed when off.
    const running = systems.running ? engine.idleRpm / engine.maxRpm + (1 - engine.idleRpm / engine.maxRpm) * Math.sqrt(Math.max(0, systems.powerShare - engine.idleShare) / (1 - engine.idleShare)) : 0;
    const windmill = clamp(axial / 90, 0, 0.35);
    systems.rpmShare = Math.max(running, windmill);
    const propSpeed = Math.max(systems.rpmShare * engine.maxRpm * 0.10472, 1);
    slipstreamState.propSpeed = propSpeed;
    // Torque reaction rolls the craft against the prop (a right-hand prop rolls it left).
    momentBody.z += (engine.rotation * power) / Math.max(propSpeed, 50);
    // P-factor: the descending blade bites harder at high angle of attack (right-hand prop: yaw left).
    const discAngle = Math.atan2(-bodyAir.y, Math.max(axial, 1));
    momentBody.y += engine.rotation * thrust * engine.pFactorArm * Math.sin(clamp(discAngle, -0.6, 0.6));
    const increment = slipstreamIncrement(thrust, axial, rho, engine.discArea);
    slipstreamState.speed = increment;
    slipstreamState.swirl = engine.rotation * engine.swirl * increment;
    slipstreamState.thrust = thrust;
    return slipstreamState;
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

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    time += dt;
    updateMass();
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    tick.dt = dt;
    tick.time = time;
    tick.controls = controls;
    tick.env = env;
    tick.assists = Number.isFinite(env.assists) ? env.assists : 1;
    tick.rho = rho;
    tick.mass = mass;
    updateActuators(controls, dt);

    inverseQuaternion.copy(state.quaternion).invert();
    airVelocityWorld.copy(state.velocity);
    if (env.wind && env.wind.vel) airVelocityWorld.sub(env.wind.vel);
    bodyAir.copy(airVelocityWorld).applyQuaternion(inverseQuaternion);
    tick.airspeed = bodyAir.length();
    tick.dynamicPressure = 0.5 * rho * tick.airspeed * tick.airspeed;
    tick.altitude = centerPosition.y;
    tick.aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    tick.sideslip = tick.airspeed > 0.5 ? Math.asin(clamp(bodyAir.x / tick.airspeed, -1, 1)) : 0;

    const surfaceHeight = Math.max(env.groundHeight(centerPosition.x, centerPosition.z), env.waterLevel);
    const wingAgl = centerPosition.y + airframe.wingHeight - surfaceHeight;
    const groundEffect = groundEffectFactor(wingAgl, wingSpan);

    forceBody.set(0, 0, 0);
    momentBody.set(0, 0, 0);
    const slipstream = engineForces(rho);
    aeroForces(rho, groundEffect, slipstream);
    tick.wingCl = aeroState.wingLift / wingArea;

    // Buffet near the stall, flutter past Vne and turbulence: small shaking moments that scale with q.
    const airspeed = bodyAir.length();
    const dynamicPressure = 0.5 * rho * airspeed * airspeed;
    const stallMargin = aeroState.aoaCritical - Math.atan2(-bodyAir.y, -bodyAir.z);
    const buffet = airspeed > 5 ? Math.max(smoothstep(BUFFET_ONSET, 0, stallMargin), aeroState.maxStall) : 0;
    // Vne as true airspeed, or as equivalent airspeed for craft that fly high (the jet).
    const limitSpeed = equivalentVne ? airspeed * Math.sqrt(rho / SEA_LEVEL_DENSITY) : airspeed;
    const flutter = smoothstep(vne, vne * 1.15, limitSpeed);
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    const shake = dynamicPressure * wingArea * meanChord;
    if (shake > 0 && (buffet > 0 || flutter > 0 || turbulence > 0)) {
      const buffetScale = shake * (0.012 * buffet + 0.02 * flutter);
      const turbulenceScale = shake * 0.004 * turbulence;
      momentBody.x += buffetScale * noise(time, 0.3, 7) + turbulenceScale * noise(time, 1.1, 0.9);
      momentBody.y += buffetScale * 0.5 * noise(time, 2.1, 6) + turbulenceScale * 0.6 * noise(time, 2.9, 0.7);
      momentBody.z += buffetScale * noise(time, 4.2, 8) + turbulenceScale * 1.4 * noise(time, 3.7, 1.1);
    }
    if (extension && extension.moments) extension.moments(tick, momentBody);

    // Ground contact against the shared height function (world force, body moment).
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    momentBody.add(groundMoment);

    // Total force (world) and the specific force the pilot feels (load factor along body up).
    forceWorld.copy(forceBody).applyQuaternion(state.quaternion).add(groundForce);
    nonGravity.copy(forceWorld);
    forceWorld.y -= mass * GRAVITY;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    const load = nonGravity.dot(bodyAxis) / (mass * GRAVITY);
    smoothedLoad += (load - smoothedLoad) * (1 - Math.exp(-LOAD_SMOOTHING * dt));

    // Euler's equations with the propeller's angular momentum: I w' = M - w x (I w + h).
    angularMomentum.copy(state.angularVelocity).applyMatrix3(inertia);
    if (engine) {
      propMomentum.set(0, 0, -engine.rotation * engine.propInertia * slipstream.propSpeed);
      angularMomentum.add(propMomentum);
    }
    gyro.crossVectors(state.angularVelocity, angularMomentum);
    angularAcceleration.copy(momentBody).sub(gyro).applyMatrix3(inverseInertia);

    // Semi-implicit Euler: velocities first, then positions and attitude from the new velocities.
    state.velocity.addScaledVector(forceWorld, dt / mass);
    if (state.velocity.lengthSq() > maxSpeed * maxSpeed) state.velocity.setLength(maxSpeed);
    state.angularVelocity.addScaledVector(angularAcceleration, dt);
    if (state.angularVelocity.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) state.angularVelocity.setLength(MAX_ANGULAR_SPEED);
    centerPosition.addScaledVector(state.velocity, dt);
    const rate = state.angularVelocity.length();
    if (rate > 1e-9) {
      axis.copy(state.angularVelocity).divideScalar(rate);
      state.quaternion.multiply(rotationStep.setFromAxisAngle(axis, rate * dt)).normalize();
    }
    syncOrigin();

    // Flight data for the control stages and telemetry (from this tick's aerodynamics).
    computeAttitude();
    flightData.airspeed = airspeed;
    flightData.aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    flightData.sideslip = airspeed > 0.5 ? Math.asin(clamp(bodyAir.x / airspeed, -1, 1)) : 0;
    flightData.aoaCritical = aeroState.aoaCritical;
    flightData.stallMargin = stallMargin;
    flightData.panelMargin = aeroState.minMargin;
    flightData.verticalSpeed = state.velocity.y;
    const groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.flightPath = Math.atan2(state.velocity.y, Math.max(groundSpeed, 0.1));
    flightData.gLoad = smoothedLoad;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.onGround = contactReport.onGround;
    flightData.agl = centerPosition.y - surfaceHeight;
    const clMaxNow = airframe.curve.clMax + (flapsProfile ? flapsProfile.clMaxIncrement * systems.flapPosition : 0) - (spoilerProfile ? spoilerProfile.clLoss * systems.spoilers * 0.5 : 0);
    flightData.stallSpeed = Math.sqrt((2 * mass * GRAVITY) / (rho * wingArea * Math.max(clMaxNow, 0.3)));
    flightData.stalled = aeroState.stallDepth > STALLED_DEPTH || aeroState.maxStall > 0.85;
    flightData.buffet = buffet;
    flightData.overspeed = limitSpeed > vne;
    flightData.throttle = systems.throttle;
    flightData.engineRunning = powered && systems.running;
    flightData.pitchCommand = systems.pitchCommand;
    flightData.elevator = surfacesActual.elevator;
    flightData.dynamicPressure = dynamicPressure;
    wingStallDepth = aeroState.stallDepth;

    surfaces.aileron = surfacesActual.aileron;
    surfaces.elevator = surfacesActual.elevator;
    surfaces.rudder = surfacesActual.rudder;
    surfaces.propSpeed = engine && systems.rpmShare > 0.02 ? 6 + 27 * systems.rpmShare : 0;
    surfaces.groundSpeed = contactReport.onGround ? contactReport.wheelSpeed : 0;
    tick.gLoad = smoothedLoad;
    tick.onGround = contactReport.onGround;
    if (extension && extension.afterStep) extension.afterStep(tick);

    landing.observe(contactReport, { dt, agl: flightData.agl, position: state.position });
  }

  /** The mesh origin from the centre of mass. */
  function syncOrigin() {
    originOffset.copy(airframe.centerOfMass).applyQuaternion(state.quaternion);
    state.position.copy(centerPosition).sub(originOffset);
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) {
      originOffset.copy(airframe.centerOfMass).applyQuaternion(state.quaternion);
      centerPosition.copy(pose.position).add(originOffset);
    }
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    syncOrigin();
    const onGround = pose.onGround === true;
    systems.throttle = powered && Number.isFinite(pose.throttle) ? clamp(pose.throttle, 0, 1) : 0;
    systems.running = powered && pose.engineOn !== false;
    systems.powerShare = engine && systems.running ? (onGround ? engine.idleShare : engine.idleShare + (1 - engine.idleShare) * systems.throttle) : 0;
    systems.flapNotch = 0;
    systems.flapPosition = 0;
    systems.spoilers = 0;
    systems.gearDown = true;
    systems.gearPosition = 1;
    surfacesActual.aileron = 0;
    surfacesActual.elevator = 0;
    surfacesActual.rudder = 0;
    smoothedLoad = 1;
    if (extensionEngine) extensionEngine.reset(pose, systems);
    if (extension && extension.reset) extension.reset(pose, systems);
    contact.reset(onGround);
    landing.reset(onGround);
    contactReport.onGround = onGround;
    flightData.onGround = onGround;
    resetCount++;
    flightData.resetCount = resetCount;
    updateMass();
    computeAttitude();
    flightData.airspeed = state.velocity.length();
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.aoa = flightData.aoa / DEG;
    flight.sideslip = flightData.sideslip / DEG;
    flight.gLoad = flightData.gLoad;
    flight.throttle = systems.throttle;
    flight.afterburner = false;
    flight.engineOn = powered && systems.running;
    flight.rpm = powered ? systems.rpmShare : 0;
    flight.flaps = systems.flapPosition;
    flight.flapNotch = systems.flapNotch;
    flight.gear.retractable = gearProfile.retractable === true;
    flight.gear.down = gearProfile.retractable ? systems.gearDown : true;
    flight.gear.transit = gearProfile.retractable ? Math.min(systems.gearPosition, 1 - systems.gearPosition) * 2 : 0;
    flight.airbrake = systems.spoilers;
    flight.brakes = Math.max(systems.brakeLeft, systems.brakeRight);
    flight.trim = systems.trim;
    flight.contacts = contactReport.contacts;
    flight.stall.stalled = flightData.stalled;
    flight.stall.buffet = Math.round(flightData.buffet * 1000) / 1000;
    flight.stall.warning = stallWarningActive(flight.assists, flightData.stallMargin, flightData.stalled, flightData.onGround || flightData.airspeed < 5);
    flight.overspeed = flightData.overspeed;
    if (extension && extension.writeTelemetry) extension.writeTelemetry(flight);
  }

  function snapshot() {
    return {
      kind: modelKind,
      center: [centerPosition.x, centerPosition.y, centerPosition.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      surfaces: [surfacesActual.aileron, surfacesActual.elevator, surfacesActual.rudder],
      systems: {
        throttle: systems.throttle,
        running: systems.running,
        powerShare: systems.powerShare,
        rpmShare: systems.rpmShare,
        flapNotch: systems.flapNotch,
        flapPosition: systems.flapPosition,
        spoilers: systems.spoilers,
        gearDown: systems.gearDown,
        gearPosition: systems.gearPosition,
        trim: systems.trim,
      },
      load: smoothedLoad,
      time,
      contact: contact.snapshot(),
      landing: landing.snapshot(),
      extension: extension && extension.snapshot ? extension.snapshot() : null,
    };
  }

  function restore(data) {
    if (!data || data.kind !== modelKind) return false;
    centerPosition.fromArray(data.center);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    [surfacesActual.aileron, surfacesActual.elevator, surfacesActual.rudder] = data.surfaces;
    Object.assign(systems, data.systems);
    smoothedLoad = Number.isFinite(data.load) ? data.load : 1;
    time = Number.isFinite(data.time) ? data.time : time;
    contact.restore(data.contact);
    landing.restore(data.landing);
    if (extension && extension.restore && data.extension) extension.restore(data.extension);
    syncOrigin();
    computeAttitude();
    return true;
  }

  updateMass();

  return {
    kind: modelKind,
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

    /** Number of resets so far (control stages re-initialize when it changes). */
    get resetCount() {
      return resetCount;
    },
    /** Stall depth of the wing last tick (0..1, area weighted). */
    get stallDepth() {
      return wingStallDepth;
    },
    /** Centre of mass (world). */
    get centerOfMass() {
      return centerPosition;
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
