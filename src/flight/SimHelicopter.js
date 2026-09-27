// SimHelicopter: the SIM flight model for single-main-rotor helicopters (the light utility
// helicopter).
//
// A 6-DOF rigid body in SI units (centre-of-mass position and velocity in the world, attitude
// quaternion body to world, body angular velocity) integrated semi-implicitly at the controller's
// fixed 120 Hz, plus the rotor's own states: rotor speed, the tip-path-plane tilt and the induced
// velocity. Components:
//   main rotor    blade-element thrust along the tip-path-plane normal from collective pitch, inflow
//                 and advance ratio (CT = sigma a / 2 (theta (1/3 + mu^2 / 2) - lambda / 2)) with a
//                 dynamic induced velocity: momentum theory in climb, the empirical curve through the
//                 vortex ring and windmill-brake states in descent, Glauert's reduction in forward
//                 flight (which is where translational lift comes from) and Cheeseman-Bennett ground
//                 effect within one rotor diameter. Cyclic tilts the disc with a short flapping lag;
//                 the disc also blows back with airspeed and lags body rates (speed stability and rate
//                 damping). Torque from induced, climb and profile power.
//   settling      vortex ring state when descending at 0.3 - 1.7 induced velocities with little
//                 airspeed: thrust loss and roughness until forward cyclic (or a much faster descent)
//                 flies the rotor out of its own wake
//   blade stall   retreating blade stall approaching Vne (earlier when heavily loaded): thrust loss,
//                 nose-up pitch, a roll toward the retreating side and vibration; low rotor rpm stalls
//                 the whole disc
//   drivetrain    turboshaft engine with a spool lag behind an N2 governor that holds the rotor rpm
//                 (droops when the demand exceeds the power available), a freewheel clutch (engine off:
//                 the rotor keeps turning on its own inertia, sustained by the upflow in autorotation)
//   tail rotor    anti-torque thrust from the pedals, scaled by rotor speed and density, with inflow
//                 damping; the main rotor's torque reaction yaws the body the other way
//   airframe      anisotropic fuselage drag, rotor-wash download in the hover, horizontal stabilizer
//                 and a cambered fin that unloads the tail rotor in cruise
//   ground        skids and body points through the shared ground contact (groundContact.js); a main
//                 or tail rotor touching the terrain while turning is a body strike
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (mesh animation: disc tilt as
// aileron / elevator, pedals as rudder, rotor speed as propSpeed, coning), flightData (read by the
// helicopter assists and autopilot) and dispose().
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY, createLiftCurve, createSurface, createSurfaceInput, createSurfaceResult, surfaceForce, liftSlope, smoothstep } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import './helicopterAssists.js';

const MAX_ANGULAR_SPEED = 8;
const MAX_SPEED = 160;
const LOAD_SMOOTHING = 25;
const TAIL_CL_MAX = 1.1;
/** Induced velocity follows its target with this time constant (dynamic inflow). */
const INFLOW_SECONDS = 0.1;
/** Minimum hover-induced velocity used to normalize the inflow curves (m/s). */
const MIN_INDUCED = 0.5;
/** The empirical axial-descent inflow polynomial (vortex ring and turbulent wake states). */
const DESCENT_INFLOW = Object.freeze([1, -1.125, -1.372, -1.718, -0.655]);
/** The turbine delivers at most this multiple of its rated torque at low shaft speed. */
const LOW_SPEED_TORQUE = 3.3;
/** Rotor speed limits (share of governed) and the low-rpm warning. */
const ROTOR_SPEED_MAX = 1.2;
const LOW_RPM_WARNING = 0.9;
const OVERSPEED_WARNING = 1.08;
/** Collective and pedal servos (share of travel per second): hydraulically boosted, fast. */
const COLLECTIVE_SERVO = 2.5;
const PEDAL_SERVO = 4;
const CYCLIC_SERVO = 5;

/** Smooth deterministic noise in about [-1, 1] (roughness, vibration and turbulence moments). */
function noise(time, phase, frequency) {
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

function moveToward(current, target, maxStep) {
  if (target > current) return Math.min(target, current + maxStep);
  return Math.max(target, current - maxStep);
}

/** Smooth bump: 0 outside [start, end], 1 between rise and fall. */
function bump(value, start, rise, fall, end) {
  return smoothstep(start, rise, value) * (1 - smoothstep(fall, end, value));
}

/**
 * Induced velocity ratio vi / vh for an axial rotor velocity ratio x = Vc / vh (positive climbing):
 * momentum theory in climb, the empirical curve through the vortex ring state (-2 < x < 0) and the
 * windmill-brake branch below it.
 */
export function axialInflowRatio(x) {
  if (x >= 0) return -x / 2 + Math.sqrt((x * x) / 4 + 1);
  if (x <= -2) return -x / 2 - Math.sqrt(Math.max(0, (x * x) / 4 - 1));
  const [k0, k1, k2, k3, k4] = DESCENT_INFLOW;
  const curve = k0 + x * (k1 + x * (k2 + x * (k3 + x * k4)));
  // The polynomial ends 2.6 % above the windmill branch at x = -2: blend the last 0.25 across.
  const windmill = -x / 2 - Math.sqrt(Math.max(0, (x * x) / 4 - 1));
  return curve + (windmill - curve) * smoothstep(-1.75, -2, x);
}

/** Glauert's forward-flight reduction of the induced velocity for an edgewise ratio m = V / vh. */
export function forwardInflowRatio(m) {
  const squared = m * m;
  return Math.sqrt(Math.max(0, Math.sqrt((squared * squared) / 4 + 1) - squared / 2));
}

/**
 * Ground effect (Cheeseman-Bennett) as the share of induced velocity removed at hub height `height`
 * over the surface for a rotor of radius `radius`, weakened by edgewise flow (ratio of airspeed to the
 * induced velocity) and faded to nothing at one rotor diameter.
 */
export function groundEffectShare(height, radius, edgewiseRatio) {
  if (!Number.isFinite(height) || height > radius * 2) return 0;
  const ratio = radius / (4 * Math.max(height, radius * 0.3));
  const share = (ratio * ratio) / (1 + edgewiseRatio * edgewiseRatio);
  return Math.min(0.35, share) * (1 - smoothstep(radius * 1.6, radius * 2, height));
}

/** Rotor, tail rotor, engine and airframe constants from a simProfile (body axes, relative to the CG). */
function buildHelicopter(profile) {
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass ?? [0, 0, 0]);
  const rotor = profile.rotor;
  const radius = rotor.radius;
  const discArea = Math.PI * radius * radius;
  const solidity = (rotor.blades * rotor.chord) / (Math.PI * radius);
  const governedSpeed = (rotor.rpm * Math.PI) / 30;
  const tail = profile.tailRotor;
  const engine = profile.engine;
  const stab = profile.stabilizers;

  const horizontalSlope = liftSlope(stab.horizontal.aspectRatio);
  const horizontal = {
    surface: createSurface({
      id: 'horizontalStabilizer',
      position: new THREE.Vector3().fromArray(stab.horizontal.position).sub(centerOfMass),
      normal: new THREE.Vector3(0, 1, 0),
      area: stab.horizontal.area,
      meanChord: Math.sqrt(stab.horizontal.area / stab.horizontal.aspectRatio),
      curve: createLiftCurve({ clAlpha: horizontalSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / horizontalSlope / DEG, postStallDrop: 0.3 }),
      inducedFactor: 1 / (Math.PI * 0.8 * stab.horizontal.aspectRatio),
      incidence: (stab.horizontal.incidence ?? 0) * DEG,
    }),
    input: createSurfaceInput(),
    result: createSurfaceResult(),
  };
  const rotation = rotor.rotation === 'clockwise-from-above' ? -1 : 1;
  const finSlope = liftSlope(stab.vertical.aspectRatio * 1.3);
  const fin = {
    surface: createSurface({
      id: 'fin',
      position: new THREE.Vector3().fromArray(stab.vertical.position).sub(centerOfMass),
      normal: new THREE.Vector3(1, 0, 0),
      area: stab.vertical.area,
      meanChord: Math.sqrt(stab.vertical.area / stab.vertical.aspectRatio),
      curve: createLiftCurve({ clAlpha: finSlope, clMax: TAIL_CL_MAX, clMin: -TAIL_CL_MAX, alphaCritical: TAIL_CL_MAX / finSlope / DEG, postStallDrop: 0.3 }),
      inducedFactor: 1 / (Math.PI * 0.8 * stab.vertical.aspectRatio * 1.3),
      // The fin's camber pushes the tail the same way as the tail rotor once there is airspeed.
      incidence: rotation * (stab.vertical.offset ?? 0) * DEG,
    }),
    input: createSurfaceInput(),
    result: createSurfaceResult(),
  };

  return {
    centerOfMass,
    radius,
    discArea,
    solidity,
    /** sigma * a / 2: thrust coefficient per unit (theta / 3 - lambda / 2). */
    thrustSlope: (solidity * rotor.liftSlope) / 2,
    profileDrag: rotor.profileDrag,
    governedSpeed,
    tipSpeed: governedSpeed * radius,
    inertia: rotor.inertia,
    hub: new THREE.Vector3().fromArray(rotor.hub).sub(centerOfMass),
    shaftTilt: (rotor.shaftTilt ?? 0) * DEG,
    collectiveMin: rotor.collectivePitch[0] * DEG,
    collectiveMax: rotor.collectivePitch[1] * DEG,
    cyclicLongitudinal: rotor.cyclic.longitudinal * DEG,
    cyclicLateral: rotor.cyclic.lateral * DEG,
    trimRange: rotor.cyclic.trim ?? 0.3,
    flapLag: rotor.flapLag,
    flapDamping: rotor.flapDamping,
    flapback: rotor.flapback,
    hubStiffness: rotor.hubStiffness ?? 0,
    inducedPowerFactor: rotor.inducedPowerFactor ?? 1.15,
    coningPerLoad: (rotor.coning ?? 3.5) * DEG,
    rotation,
    download: profile.fuselage.download,
    tail: {
      position: new THREE.Vector3().fromArray(tail.position).sub(centerOfMass),
      radius: tail.radius,
      discArea: Math.PI * tail.radius * tail.radius,
      ratio: tail.ratio,
      thrustNeutral: tail.thrustNeutral,
      thrustRange: tail.thrustRange,
      inflowDamping: tail.inflowDamping,
      profilePower: tail.profilePowerKw * 1000,
    },
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
    drag: new THREE.Vector3().fromArray(profile.fuselage.dragAreas),
    dragCenter: new THREE.Vector3().fromArray(profile.fuselage.dragCenter).sub(centerOfMass),
    horizontal,
    fin,
    vrs: profile.vortexRing,
    bladeStall: profile.bladeStall,
    skidDepth: -Math.min(...profile.contacts.filter((contact) => contact.gear).map((contact) => contact.position[1])),
  };
}

export function createSimHelicopterModel({ profile, craft, bus, craftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'helicopter';
  const craftName = craft && craft.name ? craft.name.toLowerCase() : 'helicopter';
  const heli = buildHelicopter(profile);
  const mass = profile.mass.empty + profile.mass.pilot + (profile.mass.fuel ?? 0) + (profile.mass.payload ?? 0);
  const weight = mass * GRAVITY;
  const vne = Number.isFinite(limits.vne) ? limits.vne : 70;
  const gLimit = Number.isFinite(limits.gLimit) ? limits.gLimit : 3.5;
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

  const contact = createGroundContact(profile.contacts, { centerOfMass: heli.centerOfMass, floats: limits.floats === true, mass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  /** Contact report the controller reads (FlightModel.contact); aliases the evaluator's live report. */
  const contactReport = contact.report;
  const rotorStrike = { part: '', speed: 0 };

  // ---- Rotor, drivetrain and controls ------------------------------------------------------------------
  const rotor = {
    /** Rotor speed (rad/s) and the tip-path-plane tilt relative to the shaft (rad, aft and right positive). */
    speed: heli.governedSpeed,
    discPitch: 0,
    discRoll: 0,
    /** Induced velocity (m/s, through the disc) and thrust (N) from the last tick. */
    induced: 0,
    thrust: weight,
    coning: heli.coningPerLoad,
    angle: 0,
  };
  const engine = {
    /** 'running' | 'starting' | 'off' */
    mode: 'running',
    startElapsed: 0,
    power: 0,
    /** N2 speed as a share of governed (the tachometer's E needle). */
    speed: 1,
    integral: 0,
  };
  const controlsActual = { collective: 0.5, pitch: 0, roll: 0, pedal: 0, trim: 0 };
  /** Deflections for the mesh: disc tilt (-1..1) as aileron / elevator, pedals as rudder, rotor speed (rad/s). */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0, coning: heli.coningPerLoad, rotorShare: 1 };
  let time = 0;
  let resetCount = 0;
  let smoothedLoad = 1;
  let overspeedWarned = false;
  let lowRpmWarned = false;

  // ---- Live flight data (the assists, autopilot and telemetry read it; SI, radians) ------------------------
  const flightData = {
    airspeed: 0,
    groundSpeed: 0,
    /** Ground velocity (world); the assists fly it in the heading frame. */
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
    /** Height of the skids above the ground or water (m). */
    agl: Infinity,
    hubAgl: Infinity,
    rotorRpm: 1,
    torque: 0,
    engineRunning: true,
    engineMode: 'running',
    collective: 0.5,
    /** Collective that makes the thrust hold the weight at the current inflow (assist feed-forward). */
    trimCollective: 0.5,
    /** Pedal that balances the current torque reaction at zero yaw rate. */
    antiTorquePedal: 0,
    /** Cyclic (-1..1) that levels the disc in a hover: aft against the shaft tilt, left against the tail rotor's drift. */
    hoverCyclicPitch: 0,
    hoverCyclicRoll: 0,
    hoverInduced: 0,
    vortexRing: 0,
    bladeStall: 0,
    translationalLift: 0,
    groundEffect: 0,
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
  const discNormal = new THREE.Vector3();
  const inPlane = new THREE.Vector3();
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
  const contactBody = { position: centerPosition, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };

  function notify(text, kind = 'info') {
    bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // PILOT INPUTS -> ACTUATORS
  // ============================================================================================
  function handleActions(actions) {
    if (!actions || actions.size === 0) return;
    for (const action of actions) {
      switch (action) {
        case 'engineToggle':
          if (engine.mode === 'off') {
            engine.mode = 'starting';
            engine.startElapsed = 0;
            notify('Engine start: turbine spooling up.', 'info');
          } else {
            engine.mode = 'off';
            notify('Engine off: lower the collective and hold the rotor rpm.', 'warning');
          }
          break;
        case 'gearToggle':
          notify(`The ${craftName} lands on fixed skids.`);
          break;
        case 'flapsUp':
        case 'flapsDown':
          notify(`The ${craftName} has no flaps.`);
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
    handleActions(controls.actions);
    const collective = clamp(Number.isFinite(controls.collective) ? controls.collective : controlsActual.collective, 0, 1);
    controlsActual.collective = moveToward(controlsActual.collective, collective, COLLECTIVE_SERVO * dt);
    controlsActual.trim = clamp(Number.isFinite(controls.trim) ? controls.trim : 0, -1, 1);
    const pitch = clamp((Number.isFinite(controls.pitch) ? controls.pitch : 0) + controlsActual.trim * heli.trimRange, -1, 1);
    controlsActual.pitch = moveToward(controlsActual.pitch, pitch, CYCLIC_SERVO * dt);
    controlsActual.roll = moveToward(controlsActual.roll, clamp(Number.isFinite(controls.roll) ? controls.roll : 0, -1, 1), CYCLIC_SERVO * dt);
    controlsActual.pedal = moveToward(controlsActual.pedal, clamp(Number.isFinite(controls.yaw) ? controls.yaw : 0, -1, 1), PEDAL_SERVO * dt);
  }

  // ============================================================================================
  // MAIN ROTOR
  // ============================================================================================
  const rotorState = {
    tipSpeed: heli.tipSpeed,
    advance: 0,
    climb: 0,
    edgewise: 0,
    inflow: 0,
    thrust: 0,
    torque: 0,
    hoverInduced: 0,
    vortexRing: 0,
    bladeStall: 0,
    groundEffect: 0,
    translational: 0,
    pitch: 0,
  };

  /** Tip-path-plane normal in body axes from the shaft tilt and the disc's tilt relative to the shaft. */
  function computeDiscNormal(target) {
    const aft = rotor.discPitch - heli.shaftTilt;
    const right = rotor.discRoll;
    return target.set(Math.sin(right), Math.cos(aft) * Math.cos(right), Math.sin(aft) * Math.cos(right)).normalize();
  }

  /** Flapping: the disc follows the cyclic with a short lag, blows back from the airflow and lags body rates. */
  function updateDisc(dt) {
    const tip = Math.max(rotorState.tipSpeed, 20);
    const flapGain = heli.flapback * Math.max(0, 2 * ((4 * rotorState.pitch) / 3 - rotorState.inflow));
    const forward = -inPlane.z / tip;
    const sideways = inPlane.x / tip;
    const targetPitch = controlsActual.pitch * heli.cyclicLongitudinal + flapGain * forward - heli.flapDamping * state.angularVelocity.x;
    const targetRoll = controlsActual.roll * heli.cyclicLateral - flapGain * sideways + heli.flapDamping * state.angularVelocity.z;
    // A slow rotor flaps sluggishly (the lag grows as the centrifugal stiffness drops).
    const share = clamp(rotor.speed / heli.governedSpeed, 0.2, 1.2);
    const blend = 1 - Math.exp(-dt / (heli.flapLag / share));
    rotor.discPitch += (clamp(targetPitch, -0.35, 0.35) - rotor.discPitch) * blend;
    rotor.discRoll += (clamp(targetRoll, -0.35, 0.35) - rotor.discRoll) * blend;
  }

  /**
   * Thrust, in-plane drag and torque of the main rotor (body axes, at the hub) with the dynamic
   * induced velocity, vortex ring state, retreating blade and low-rpm stall, ground effect.
   */
  function mainRotorForces(rho, hubHeight, dt) {
    const tip = rotor.speed * heli.radius;
    rotorState.tipSpeed = tip;
    computeDiscNormal(discNormal);
    // Hub velocity relative to the air (body axes) split along and across the disc.
    spin.crossVectors(state.angularVelocity, heli.hub);
    hubAir.copy(bodyAir).add(spin);
    const climb = hubAir.dot(discNormal);
    inPlane.copy(hubAir).addScaledVector(discNormal, -climb);
    const edgewise = inPlane.length();
    rotorState.climb = climb;
    rotorState.edgewise = edgewise;
    updateDisc(dt);
    computeDiscNormal(discNormal);

    const thrustScale = rho * heli.discArea * Math.max(tip, 1) * Math.max(tip, 1);
    const hoverInduced = Math.max(Math.sqrt(Math.abs(rotor.thrust) / (2 * rho * heli.discArea)), MIN_INDUCED);
    const axialRatio = climb / hoverInduced;
    const edgewiseRatio = edgewise / hoverInduced;
    const groundShare = groundEffectShare(hubHeight, heli.radius, edgewiseRatio);
    const targetInduced = hoverInduced * axialInflowRatio(axialRatio) * forwardInflowRatio(edgewiseRatio) * (1 - groundShare);
    rotor.induced += (targetInduced - rotor.induced) * (1 - Math.exp(-dt / INFLOW_SECONDS));
    const inducedSigned = rotor.thrust >= 0 ? rotor.induced : -rotor.induced;
    const advance = edgewise / Math.max(tip, 1);
    const inflow = (climb + inducedSigned) / Math.max(tip, 1);
    const pitch = heli.collectiveMin + controlsActual.collective * (heli.collectiveMax - heli.collectiveMin);
    let thrustCoefficient = heli.thrustSlope * (pitch * (1 / 3 + (advance * advance) / 2) - inflow / 2);

    // Vortex ring state: descending into the rotor's own wake with little edgewise flow.
    const descentRatio = -axialRatio;
    const vrs = heli.vrs;
    const vortexRing = bump(descentRatio, vrs.start, vrs.full, vrs.fade, vrs.end) * (1 - smoothstep(vrs.clearSpeed * 0.4, vrs.clearSpeed, edgewiseRatio));
    // Retreating blade stall: onset advance ratio falls as the blade loading rises.
    const stall = heli.bladeStall;
    const bladeLoading = Math.abs(rotor.thrust) / thrustScale / heli.solidity;
    const onset = stall.onsetAdvance - stall.loadingSensitivity * Math.max(0, bladeLoading - stall.referenceLoading);
    const bladeStall = smoothstep(onset, onset + stall.width, advance);
    // Low rotor rpm: the whole disc stalls as the blades run out of speed.
    const rotorShare = rotor.speed / heli.governedSpeed;
    const lowRpmStall = smoothstep(0.84, 0.68, rotorShare);

    let thrust = thrustCoefficient * thrustScale;
    thrust *= 1 - vrs.thrustLoss * vortexRing - stall.thrustLoss * bladeStall - 0.55 * lowRpmStall * clamp(pitch / heli.collectiveMax, 0, 1);
    thrust += vortexRing * vrs.roughness * weight * noise(time, 0.7, 2.3);
    thrust = clamp(thrust, -0.5 * weight, 3.5 * weight);
    thrustCoefficient = thrust / thrustScale;
    rotor.thrust = thrust;

    // Power: induced (with the non-ideal factor), climb and profile, plus the stall's drag rise.
    const inducedInflow = inducedSigned / Math.max(tip, 1);
    const profileCoefficient = ((heli.solidity * heli.profileDrag) / 8) * (1 + 4.65 * advance * advance) * (1 + 1.5 * bladeStall + 0.8 * lowRpmStall);
    const torqueCoefficient = thrustCoefficient * (climb / Math.max(tip, 1) + heli.inducedPowerFactor * inducedInflow) + profileCoefficient;
    rotorState.torque = torqueCoefficient * thrustScale * heli.radius;

    // Forces at the hub: thrust along the disc normal and the profile H-force against the edgewise flow.
    forceBody.addScaledVector(discNormal, thrust);
    lever.crossVectors(heli.hub, discNormal).multiplyScalar(thrust);
    momentBody.add(lever);
    if (edgewise > 0.1) {
      const hForce = thrustScale * ((heli.solidity * heli.profileDrag) / 4) * advance;
      localVelocity.copy(inPlane).multiplyScalar(-hForce / edgewise);
      forceBody.add(localVelocity);
      momentBody.add(lever.crossVectors(heli.hub, localVelocity));
    }
    // Hub moment from the effective flapping hinge offset; retreating blade stall pitches the nose up
    // and rolls toward the retreating side.
    momentBody.x += heli.hubStiffness * rotor.discPitch * rotorShare * rotorShare;
    momentBody.z -= heli.hubStiffness * rotor.discRoll * rotorShare * rotorShare;
    if (bladeStall > 0) {
      const stallMoment = bladeStall * Math.abs(thrust) * heli.radius;
      momentBody.x += stall.pitchMoment * stallMoment * (1 + 0.3 * noise(time, 1.9, 6));
      momentBody.z += heli.rotation * stall.rollMoment * stallMoment * (1 + 0.3 * noise(time, 3.1, 5));
    }
    // Rotor-wash download on the fuselage in the hover, fading with airspeed.
    const wash = 2 * rotor.induced;
    const washShare = 1 - smoothstep(0.5 * hoverInduced, 2.2 * hoverInduced, edgewise);
    forceBody.y -= 0.5 * rho * wash * wash * heli.download * washShare;

    rotorState.advance = advance;
    rotorState.inflow = inflow;
    rotorState.thrust = thrust;
    rotorState.hoverInduced = hoverInduced;
    rotorState.vortexRing = vortexRing;
    rotorState.bladeStall = Math.max(bladeStall, lowRpmStall);
    rotorState.groundEffect = groundShare;
    rotorState.translational = 1 - forwardInflowRatio(edgewiseRatio);
    rotorState.pitch = pitch;

    // Coning rises with thrust and falls with the centrifugal stiffening of a fast rotor.
    rotor.coning = clamp((heli.coningPerLoad * thrust) / weight / Math.max(rotorShare * rotorShare, 0.25), -0.02, 0.2);
  }

  // ============================================================================================
  // TAIL ROTOR, AIRFRAME
  // ============================================================================================
  const tailState = { thrust: 0, power: 0 };

  function tailRotorForces(rho) {
    const tail = heli.tail;
    const share = rotor.speed / heli.governedSpeed;
    const densityShare = rho / SEA_LEVEL_DENSITY;
    spin.crossVectors(state.angularVelocity, tail.position);
    localVelocity.copy(bodyAir).add(spin);
    // The tail rotor pushes the tail toward +x for a counterclockwise main rotor; motion that way is its inflow.
    const axial = heli.rotation * localVelocity.x;
    const command = tail.thrustNeutral - controlsActual.pedal * tail.thrustRange;
    const thrust = share * share * densityShare * command - tail.inflowDamping * axial * Math.min(share, 1);
    lever.set(heli.rotation * thrust, 0, 0);
    forceBody.add(lever);
    momentBody.add(spin.crossVectors(tail.position, lever));
    const inducedPower = 1.2 * Math.pow(Math.abs(thrust), 1.5) / Math.sqrt(2 * rho * tail.discArea);
    tailState.thrust = thrust;
    tailState.power = inducedPower + tail.profilePower * share * share * share;
  }

  function airframeForces(rho) {
    const airspeed = bodyAir.length();
    if (airspeed > 0.05) {
      // Anisotropic flat-plate drag at the drag centre (sideways and vertical areas are large).
      spin.crossVectors(state.angularVelocity, heli.dragCenter);
      localVelocity.copy(bodyAir).add(spin);
      const speed = localVelocity.length();
      const scale = -0.5 * rho * speed;
      lever.set(localVelocity.x * heli.drag.x * scale, localVelocity.y * heli.drag.y * scale, localVelocity.z * heli.drag.z * scale);
      forceBody.add(lever);
      momentBody.add(spin.crossVectors(heli.dragCenter, lever));
    }
    for (const surfaceEntry of [heli.horizontal, heli.fin]) {
      const { surface, input, result } = surfaceEntry;
      spin.crossVectors(state.angularVelocity, surface.position);
      localVelocity.copy(bodyAir).add(spin);
      input.alphaOffset = 0;
      input.inducedScale = 1;
      surfaceForce(surface, localVelocity, rho, input, result);
      forceBody.add(result.force);
      lever.crossVectors(surface.position, result.force);
      momentBody.add(lever).add(result.moment);
    }
  }

  // ============================================================================================
  // DRIVETRAIN: engine, governor, freewheel, rotor speed
  // ============================================================================================
  function availablePower(rho) {
    return heli.engine.ratedPower * Math.pow(rho / SEA_LEVEL_DENSITY, heli.engine.lapse);
  }

  function updateDrivetrain(rho, dt) {
    const engineProfile = heli.engine;
    const governed = heli.governedSpeed;
    const speed = Math.max(rotor.speed, 0);
    const share = speed / governed;
    const loadTorque = rotorState.torque + (tailState.power + engineProfile.accessoryPower * share * share * share) / Math.max(speed, 1);
    let available = availablePower(rho);
    if (engine.mode === 'starting') {
      engine.startElapsed += dt;
      const progress = clamp(engine.startElapsed / engineProfile.startSeconds, 0, 1);
      available *= progress;
      if (progress >= 1) {
        engine.mode = 'running';
        notify('Engine running: rotor rpm governed.', 'success');
      }
    } else if (engine.mode === 'off') {
      available = 0;
    }
    // N2 governor (isochronous): collective anticipation (the load at governed speed) plus PI on rpm.
    const error = (governed - speed) / governed;
    let command = 0;
    if (engine.mode !== 'off') {
      const unclamped = loadTorque * governed + engineProfile.governorGain * error * engineProfile.ratedPower + engine.integral;
      command = clamp(unclamped, 0, available);
      const saturated = (unclamped > available && error > 0) || (unclamped < 0 && error < 0);
      if (!saturated) engine.integral = clamp(engine.integral + engineProfile.governorIntegral * error * engineProfile.ratedPower * dt, -0.5 * engineProfile.ratedPower, engineProfile.ratedPower);
      engine.power += (command - engine.power) * (1 - Math.exp(-dt / engineProfile.spoolSeconds));
      engine.speed += (Math.max(share, engine.mode === 'starting' ? clamp(engine.startElapsed / engineProfile.startSeconds, 0, 1) : share) - engine.speed) * (1 - Math.exp(-dt / 0.3));
    } else {
      engine.integral = 0;
      engine.power += (0 - engine.power) * (1 - Math.exp(-dt / 0.6));
      engine.speed += (0 - engine.speed) * (1 - Math.exp(-dt / engineProfile.rundownSeconds));
    }
    // Freewheel: the engine drives the rotor only while its N2 keeps up with it.
    const driving = engine.mode !== 'off' || engine.speed >= share - 0.01;
    const engineTorque = driving ? Math.min(engine.power / Math.max(speed, 0.3 * governed), LOW_SPEED_TORQUE * engineProfile.ratedPower / governed) : 0;
    rotor.speed = clamp(speed + ((engineTorque - loadTorque) / heli.inertia) * dt, 0, ROTOR_SPEED_MAX * governed);
    // The engine's drive torque reacts on the airframe about the mast (a counterclockwise rotor yaws the nose right).
    const mainShare = rotorState.torque > 0 ? clamp(rotorState.torque / Math.max(loadTorque, 1e-6), 0, 1) : 0;
    momentBody.y -= heli.rotation * engineTorque * mainShare;
    drivetrainState.engineTorque = engineTorque;
    drivetrainState.loadTorque = loadTorque;
    drivetrainState.available = available;
  }
  const drivetrainState = { engineTorque: 0, loadTorque: 0, available: 0 };

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

  /** Height of the lowest skid point above the surface (m). */
  function skidHeight(surfaceHeight) {
    let lowest = Infinity;
    for (const point of contact.contacts) {
      if (!point.gear) continue;
      worldPoint.copy(point.relative).applyQuaternion(state.quaternion).add(centerPosition);
      lowest = Math.min(lowest, worldPoint.y);
    }
    return Number.isFinite(lowest) ? lowest - surfaceHeight : centerPosition.y - heli.skidDepth - surfaceHeight;
  }

  /**
   * A turning main or tail rotor that touches the ground (or water) is a body strike at the blade's
   * tip speed: the controller soft-crashes on it. Checks the disc rim (with coning) and the tail disc.
   */
  function checkRotorStrike(env) {
    const share = rotor.speed / heli.governedSpeed;
    if (share < 0.12) return;
    const hubWorld = worldPoint.copy(heli.hub).applyQuaternion(state.quaternion).add(centerPosition);
    const surfaceBelow = Math.max(env.groundHeight(hubWorld.x, hubWorld.z), env.waterLevel);
    if (hubWorld.y - surfaceBelow > heli.radius * 1.2 + 2) return;
    computeDiscNormal(discNormal);
    discU.set(1, 0, 0).addScaledVector(discNormal, -discNormal.x).normalize();
    discV.crossVectors(discNormal, discU).normalize();
    const hubX = hubWorld.x;
    const hubY = hubWorld.y;
    const hubZ = hubWorld.z;
    const rise = heli.radius * Math.sin(rotor.coning);
    for (let index = 0; index < 12; index++) {
      const angle = (index / 12) * Math.PI * 2;
      tipOffset.copy(discU).multiplyScalar(Math.cos(angle) * heli.radius).addScaledVector(discV, Math.sin(angle) * heli.radius).addScaledVector(discNormal, rise);
      tipOffset.applyQuaternion(state.quaternion);
      const x = hubX + tipOffset.x;
      const z = hubZ + tipOffset.z;
      if (hubY + tipOffset.y < Math.max(env.groundHeight(x, z), env.waterLevel)) {
        reportStrike('main rotor', rotor.speed * heli.radius);
        return;
      }
    }
    const tail = heli.tail;
    for (let index = 0; index < 8; index++) {
      const angle = (index / 8) * Math.PI * 2;
      tipOffset.set(0, Math.cos(angle) * tail.radius, Math.sin(angle) * tail.radius).add(tail.position).applyQuaternion(state.quaternion).add(centerPosition);
      if (tipOffset.y < Math.max(env.groundHeight(tipOffset.x, tipOffset.z), env.waterLevel)) {
        reportStrike('tail rotor', rotor.speed * tail.ratio * tail.radius);
        return;
      }
    }
  }

  function reportStrike(part, speed) {
    rotorStrike.part = part;
    rotorStrike.speed = speed;
    contactReport.bodyStrike = rotorStrike;
  }

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    time += dt;
    updateActuators(controls, dt);
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;

    inverseQuaternion.copy(state.quaternion).invert();
    airVelocityWorld.copy(state.velocity);
    if (env.wind && env.wind.vel) airVelocityWorld.sub(env.wind.vel);
    bodyAir.copy(airVelocityWorld).applyQuaternion(inverseQuaternion);

    const surfaceHeight = Math.max(env.groundHeight(centerPosition.x, centerPosition.z), env.waterLevel);
    worldPoint.copy(heli.hub).applyQuaternion(state.quaternion).add(centerPosition);
    const hubHeight = worldPoint.y - Math.max(env.groundHeight(worldPoint.x, worldPoint.z), env.waterLevel);

    forceBody.set(0, 0, 0);
    momentBody.set(0, 0, 0);
    mainRotorForces(rho, hubHeight, dt);
    tailRotorForces(rho);
    airframeForces(rho);
    updateDrivetrain(rho, dt);

    // Vibration: vortex ring roughness, the transverse-flow shudder through translational lift, blade
    // stall and turbulence, as small moments scaling with the rotor's thrust.
    const airspeed = bodyAir.length();
    const hoverInduced = rotorState.hoverInduced;
    const shudder = bump(rotorState.edgewise / hoverInduced, 0.5, 0.9, 1.5, 2.1) * 0.35;
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    const shake = Math.abs(rotor.thrust) * 0.05 * (rotorState.vortexRing + shudder + 1.2 * rotorState.bladeStall + 0.25 * turbulence);
    if (shake > 0) {
      momentBody.x += shake * noise(time, 0.3, 4.5);
      momentBody.z += shake * noise(time, 4.2, 5.5);
      momentBody.y += shake * 0.4 * noise(time, 2.1, 3.1);
    }

    // Ground contact against the shared height function (world force, body moment).
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    momentBody.add(groundMoment);

    forceWorld.copy(forceBody).applyQuaternion(state.quaternion).add(groundForce);
    nonGravity.copy(forceWorld);
    forceWorld.y -= weight;
    bodyAxis.set(0, 1, 0).applyQuaternion(state.quaternion);
    const load = nonGravity.dot(bodyAxis) / weight;
    smoothedLoad += (load - smoothedLoad) * (1 - Math.exp(-LOAD_SMOOTHING * dt));

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

    updateFlightData(env, surfaceHeight, airspeed, hubHeight);
    updateWarnings();
    const share = rotor.speed / heli.governedSpeed;
    rotor.angle = (rotor.angle + rotor.speed * dt) % (Math.PI * 2);
    surfaces.aileron = clamp(rotor.discRoll / heli.cyclicLateral, -1.5, 1.5);
    surfaces.elevator = clamp(rotor.discPitch / heli.cyclicLongitudinal, -1.5, 1.5);
    surfaces.rudder = controlsActual.pedal;
    surfaces.propSpeed = rotor.speed;
    surfaces.rotorShare = share;
    surfaces.coning = rotor.coning;
    surfaces.groundSpeed = 0;
    landing.observe(contactReport, { dt, agl: flightData.agl, position: state.position });
  }

  function updateFlightData(env, surfaceHeight, airspeed, hubHeight) {
    computeAttitude();
    const share = rotor.speed / heli.governedSpeed;
    flightData.airspeed = airspeed;
    flightData.groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.verticalSpeed = state.velocity.y;
    flightData.aoa = Math.atan2(-bodyAir.y, -bodyAir.z);
    flightData.sideslip = airspeed > 0.5 ? Math.asin(clamp(bodyAir.x / airspeed, -1, 1)) : 0;
    flightData.gLoad = smoothedLoad;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.onGround = contactReport.onGround;
    flightData.agl = skidHeight(surfaceHeight);
    flightData.hubAgl = hubHeight;
    flightData.rotorRpm = share;
    flightData.torque = (drivetrainState.engineTorque * heli.governedSpeed) / heli.engine.ratedPower;
    flightData.engineRunning = engine.mode === 'running';
    flightData.engineMode = engine.mode;
    flightData.collective = controlsActual.collective;
    flightData.hoverInduced = rotorState.hoverInduced;
    flightData.vortexRing = rotorState.vortexRing;
    flightData.bladeStall = rotorState.bladeStall;
    flightData.translationalLift = rotorState.translational;
    flightData.groundEffect = rotorState.groundEffect;
    flightData.overspeed = airspeed > vne;
    flightData.trimCollective = trimCollective(env);
    flightData.antiTorquePedal = antiTorquePedal(env);
    updateHoverCyclic();
  }

  function updateHoverCyclic() {
    const thrust = Math.max(Math.abs(rotor.thrust), 0.2 * weight);
    flightData.hoverCyclicPitch = clamp(heli.shaftTilt / heli.cyclicLongitudinal, -1, 1);
    flightData.hoverCyclicRoll = clamp(-(heli.rotation * tailState.thrust) / thrust / heli.cyclicLateral, -1, 1);
  }

  /** Collective that makes the rotor's vertical thrust hold the weight at the current inflow. */
  function trimCollective(env) {
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const tip = Math.max(rotorState.tipSpeed, 1);
    computeDiscNormal(discNormal);
    bodyAxis.copy(discNormal).applyQuaternion(state.quaternion);
    const verticalShare = Math.max(bodyAxis.y, 0.5);
    const required = (weight * (1 + 0.5 * rotorState.vortexRing * heli.vrs.thrustLoss)) / verticalShare;
    const coefficient = required / (rho * heli.discArea * tip * tip);
    const advance = rotorState.advance;
    const pitch = (coefficient / heli.thrustSlope + rotorState.inflow / 2) / (1 / 3 + (advance * advance) / 2);
    return clamp((pitch - heli.collectiveMin) / (heli.collectiveMax - heli.collectiveMin), 0, 1);
  }

  /** Pedal (-1..1) whose tail-rotor thrust balances the current torque reaction at zero yaw rate. */
  function antiTorquePedal(env) {
    const tail = heli.tail;
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const share = rotor.speed / heli.governedSpeed;
    const scale = share * share * (rho / SEA_LEVEL_DENSITY);
    if (scale < 0.05) return 0;
    const mainShare = rotorState.torque > 0 ? clamp(rotorState.torque / Math.max(drivetrainState.loadTorque, 1e-6), 0, 1) : 0;
    const needed = (drivetrainState.engineTorque * mainShare) / Math.abs(tail.position.z);
    return clamp((tail.thrustNeutral - needed / scale) / tail.thrustRange, -1, 1);
  }

  function updateWarnings() {
    const share = rotor.speed / heli.governedSpeed;
    if (share > OVERSPEED_WARNING && !overspeedWarned) {
      overspeedWarned = true;
      notify('Rotor overspeed: raise the collective.', 'warning');
    } else if (share < OVERSPEED_WARNING - 0.03) {
      overspeedWarned = false;
    }
    const airborne = !contactReport.onGround;
    if (airborne && share < LOW_RPM_WARNING - 0.02 && !lowRpmWarned) {
      lowRpmWarned = true;
      notify('Low rotor rpm: lower the collective.', 'warning');
    } else if (share > LOW_RPM_WARNING + 0.02) {
      lowRpmWarned = false;
    }
  }

  /** The mesh origin from the centre of mass. */
  function syncOrigin() {
    originOffset.copy(heli.centerOfMass).applyQuaternion(state.quaternion);
    state.position.copy(centerPosition).sub(originOffset);
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  /**
   * Takes over a pose. Airborne: engine running at governed rpm, the collective at the pose's throttle
   * (a hover spawn passes 0.5) and the inflow settled for the weight, so a hover spawn starts steady.
   * On the ground: rotor turning at flight idle, collective down.
   */
  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) {
      originOffset.copy(heli.centerOfMass).applyQuaternion(state.quaternion);
      centerPosition.copy(pose.position).add(originOffset);
    }
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    syncOrigin();
    const onGround = pose.onGround === true;
    const engineOn = pose.engineOn !== false;
    engine.mode = engineOn ? 'running' : 'off';
    engine.startElapsed = 0;
    engine.integral = 0;
    engine.speed = engineOn ? 1 : 0;
    rotor.speed = engineOn || !onGround ? heli.governedSpeed : 0;
    rotor.thrust = onGround ? 0 : weight;
    tailState.thrust = onGround ? 0 : heli.tail.thrustNeutral;
    updateHoverCyclic();
    // Airborne, the disc starts level (in hover trim); on the ground it rests on the shaft.
    rotor.discPitch = onGround ? 0 : flightData.hoverCyclicPitch * heli.cyclicLongitudinal;
    rotor.discRoll = onGround ? 0 : flightData.hoverCyclicRoll * heli.cyclicLateral;
    rotor.induced = onGround ? 0 : Math.sqrt(weight / (2 * SEA_LEVEL_DENSITY * heli.discArea));
    controlsActual.collective = onGround ? 0 : clamp(Number.isFinite(pose.throttle) ? pose.throttle : 0.5, 0, 1);
    controlsActual.pitch = 0;
    controlsActual.roll = 0;
    controlsActual.pedal = 0;
    engine.power = onGround ? heli.engine.accessoryPower : 0.8 * heli.engine.ratedPower;
    smoothedLoad = 1;
    overspeedWarned = false;
    lowRpmWarned = false;
    contact.reset(onGround);
    landing.reset(onGround);
    contactReport.onGround = onGround;
    flightData.onGround = onGround;
    resetCount++;
    flightData.resetCount = resetCount;
    computeAttitude();
    flightData.airspeed = state.velocity.length();
    flightData.collective = controlsActual.collective;
    flightData.rotorRpm = rotor.speed / heli.governedSpeed;
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.aoa = flightData.aoa / DEG;
    flight.sideslip = flightData.sideslip / DEG;
    flight.gLoad = flightData.gLoad;
    // The throttle instrument shows the collective lever on a helicopter.
    flight.throttle = controlsActual.collective;
    flight.afterburner = false;
    flight.engineOn = engine.mode !== 'off';
    flight.rpm = clamp(engine.speed, 0, ROTOR_SPEED_MAX);
    flight.rotorRpm = rotor.speed / heli.governedSpeed;
    flight.torque = Math.max(0, flightData.torque);
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.gear.retractable = false;
    flight.gear.down = true;
    flight.gear.transit = 0;
    flight.airbrake = 0;
    flight.brakes = 0;
    flight.trim = controlsActual.trim;
    flight.contacts = contactReport.contacts;
    // Radar altitude from the skids (the controller's default is the mesh origin's height).
    if (Number.isFinite(flightData.agl)) flight.radarAltitude = Math.max(0, flightData.agl);
    flight.stall.stalled = rotorState.bladeStall > 0.5 || rotorState.vortexRing > 0.6;
    flight.stall.buffet = Math.round(clamp(Math.max(rotorState.vortexRing, rotorState.bladeStall), 0, 1) * 1000) / 1000;
    // The low rotor rpm horn (a turbine helicopter's warning horn) sounds in the air below 90 %.
    flight.stall.warning = !contactReport.onGround && flight.rotorRpm < LOW_RPM_WARNING;
    flight.overspeed = flightData.overspeed;
  }

  function snapshot() {
    return {
      kind: 'helicopter',
      center: [centerPosition.x, centerPosition.y, centerPosition.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      rotor: { ...rotor },
      engine: { ...engine },
      controls: { ...controlsActual },
      load: smoothedLoad,
      time,
      contact: contact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'helicopter') return false;
    centerPosition.fromArray(data.center);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    Object.assign(rotor, data.rotor);
    Object.assign(engine, data.engine);
    Object.assign(controlsActual, data.controls);
    smoothedLoad = Number.isFinite(data.load) ? data.load : 1;
    time = Number.isFinite(data.time) ? data.time : time;
    contact.restore(data.contact);
    landing.restore(data.landing);
    syncOrigin();
    computeAttitude();
    return true;
  }

  return {
    kind: 'helicopter',
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
    /** Centre of mass (world). */
    get centerOfMass() {
      return centerPosition;
    },
    get landings() {
      return landing.landings;
    },
    /** Rotor internals for the lab and the dev tools (thrust N, torque N m, inflow, disc tilt rad). */
    get rotor() {
      return {
        thrust: rotorState.thrust,
        torque: rotorState.torque,
        induced: rotor.induced,
        inflow: rotorState.inflow,
        advance: rotorState.advance,
        climb: rotorState.climb,
        discPitch: rotor.discPitch,
        discRoll: rotor.discRoll,
        coning: rotor.coning,
        speed: rotor.speed,
        tailThrust: tailState.thrust,
        enginePower: engine.power,
        availablePower: drivetrainState.available,
      };
    },

    dispose() {
      contactReport.touchdown = null;
      contactReport.bodyStrike = null;
    },
  };
}
