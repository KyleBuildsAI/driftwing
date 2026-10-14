// SimAirship: the SIM flight model for the airship (a semi-rigid, vectored-thrust airship of the
// Zeppelin NT class).
//
// A 6-DOF rigid body in SI units: centre-of-mass position and velocity (world), attitude quaternion
// (body to world) and body angular velocity, integrated semi-implicitly at the controller's fixed
// 120 Hz. What makes it an airship:
//   buoyancy      Archimedes on the envelope: a fixed mass of helium lifts m_He (rho_air / rho_He)
//                 whatever the altitude, as long as the ballonets can make room for it to expand; above
//                 the pressure height the helium fills the envelope and the lift falls with the air
//                 density (the natural ceiling). The ballonet trim (the HOTAS antenna, or the flap keys
//                 held) pumps air into the ballonets while the helium it displaces goes into the
//                 compression tanks, as the static-heaviness control of the Aeroscraft does: half way
//                 is exactly neutral, full is heavy and empty is light (envelope.storage of the helium,
//                 about 4 % of the weight either way). The blowers take envelope.blowerSeconds to move
//                 the ballonets end to end, so the trim lags the lever.
//   inertia       the air the hull pushes aside moves with it: added mass along each body axis (k1 axial,
//                 k2 lateral and vertical, shares of the displaced air) and the added inertia folded into
//                 the profile's moments of inertia. Huge inertia, slow to start and slow to stop.
//   pendulum      the gondola hangs the centre of mass below the centre of buoyancy, so pitch and roll
//                 swing back to level on their own (a long, damped pendulum).
//   hull          axial drag on the volume^(2/3) reference area, viscous crossflow drag on the plan
//                 area (the big vertical and sideways damping: a light airship rises at about 3 m/s, not
//                 faster), linear viscous hull lift, and the destabilising Munk moment that turns a
//                 slender body broadside to the flow (reduced by the crossflow lift on the tail cone).
//   fins          four tail fins (+ layout), each a lifting surface in its own local flow (rotation
//                 included, so they stabilise and damp), with elevators and rudders. Their authority
//                 grows with the dynamic pressure: almost none at walking pace.
//   props         two vectored propellers on outriggers: the throttle sets their thrust (falling with
//                 the inflow), the rocker swivels both pods from 45 degrees down through forward to
//                 120 degrees up and back (vertical take-off, hover and braking), and the rudder input
//                 splits their thrust for a little yaw. A lateral stern thruster turns the airship at
//                 low speed and fades out as the fins take over.
//   wind          every aerodynamic force works on the air-relative velocity, so the whole airship
//                 drifts with the air mass, and gusts shove its enormous side area around.
//   ground        the gondola and tail wheels plus body points on the envelope and fins through the
//                 shared ground contact (groundContact.js); brushing the terrain fast is a body strike.
//
// The control inputs it reads (the craft inputProfile: antenna 'ballonet', rocker 'vector'): pitch
// -> elevators; yaw and stick X -> rudders, differential thrust and the stern thruster (an airship
// cannot roll on command); throttle -> the props; trim (the rocker) -> the vector angle; antenna or
// the flapsDown / flapsUp actions held -> the ballonet trim; engineToggle -> engines. The vector and
// ballonet targets live in craftState (vectorTarget, ballonetTarget), so a placement or a copilot
// command can set them; the levers move them relatively and snap at their end stops.
//
// FlightModel contract (docs/architecture.md): reset(pose), step(dt, controls, env), state, contact,
// writeTelemetry(flight), snapshot(), restore(snapshot), plus surfaces (mesh animation), flightData
// (read by the airship assists and autopilot registered below), craftState and dispose().
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY } from './aero.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';
import { surfaceHeightAt, waterHeightAt } from './waterSurface.js';

const MAX_ANGULAR_SPEED = 2;
const MAX_SPEED = 90;
const LOAD_SMOOTHING = 10;
/** A lever counts as moved when it changes by more than this between ticks. */
const LEVER_EPSILON = 1e-4;
/** A lever this close to an end stop snaps its target to that end. */
const LEVER_END = 0.999;
/** Engine spool time constant (s): the props follow the throttle this fast. */
const SPOOL_SECONDS = 1.2;
const ENGINE_START_SECONDS = 3;
/** Fins stall gently: the crossflow normal force takes over past the linear range. */
const FIN_CROSSFLOW = 1.2;
const DENSITY_SCALE = 8500;
/** Slots of the model's clock array. */
const TIME = 0;
const LOAD = 1;
/** Slots of the model's per-tick array. */
const RHO = 0;
const STEP = 1;
const ELEVATOR = 2;
const RUDDER = 3;
const THRUST = 4;
const LIFT = 5;

/** Smooth deterministic noise in about [-1, 1] at clock[TIME] (the time never crosses a call as a double). */
function noise(clock, phase, frequency) {
  const time = clock[TIME];
  return 0.55 * Math.sin(time * frequency * 6.2832 + phase)
    + 0.3 * Math.sin(time * frequency * 2.71 * 6.2832 + phase * 1.7)
    + 0.15 * Math.sin(time * frequency * 5.93 * 6.2832 + phase * 2.3);
}

/**
 * The airship's static numbers from its profile: the dry mass, the helium mass that makes the
 * half-filled ballonets exactly neutral, the gross lift capacity, the neutral pressure height (m) and
 * the static heaviness range (kg either way). Shared with the craft module (situate) and the labs.
 */
export function airshipBuoyancy(profile) {
  const envelope = profile.envelope;
  const mass = profile.mass;
  const dryMass = Object.values(mass).reduce((sum, part) => sum + part, 0);
  const neutralFree = 1 - envelope.storage / 2;
  // Neutral: the free helium lifts the dry mass plus all the helium (the stored share still weighs).
  const heliumMass = dryMass / (neutralFree / envelope.gasRatio - 1);
  const grossLift = (heliumMass * neutralFree) / envelope.gasRatio;
  const pressureDensity = grossLift / envelope.volume;
  const pressureHeight = -Math.log(pressureDensity / SEA_LEVEL_DENSITY) * DENSITY_SCALE;
  const heavinessRange = (heliumMass * envelope.storage) / 2 / envelope.gasRatio;
  // The ballonet air at sea level moves with the ship (inertial mass, never weight: it displaces itself).
  const ballonetAir = Math.max(0, SEA_LEVEL_DENSITY * envelope.volume - grossLift);
  return { dryMass, heliumMass, grossLift, pressureHeight, heavinessRange, inertialMass: dryMass + heliumMass + ballonetAir };
}

/** The vector angle (deg) a rocker position (-1..1) stands for: down below centre, up and back above. */
export function vectorForLever(lever, vector) {
  return lever >= 0 ? lever * vector.up : -lever * vector.down;
}

/**
 * Creates the airship model. craftState carries the ballonet and vector targets (craftState
 * .ballonetTarget 0..1, .vectorTarget deg) and receives the live values: ballonet, vectorAngle,
 * heaviness (kg, positive heavy), pressureHeight (m), propShare, sternThrust (-1..1), engineOn.
 */
export function createSimAirshipModel({ profile, craft, bus, craftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'airship';
  const envelope = profile.envelope;
  const hull = profile.hull;
  const props = profile.props;
  const stern = profile.sternThruster;
  const vector = props.vector;
  const statics = airshipBuoyancy(profile);
  const weightMass = statics.dryMass + statics.heliumMass;
  const inertialMass = statics.inertialMass;
  const centerOfMass = new THREE.Vector3().fromArray(profile.centerOfMass);
  const inertia = new THREE.Vector3(profile.inertia.pitch, profile.inertia.yaw, profile.inertia.roll);
  const referenceArea = Math.pow(envelope.volume, 2 / 3);
  const vne = Number.isFinite(limits.vne) ? limits.vne : 35;
  /** Every point the forces act at, relative to the centre of mass (body axes). */
  const buoyancyArm = new THREE.Vector3(0, 0, 0).sub(centerOfMass);
  const fins = profile.fins.map((fin) => ({
    id: fin.id,
    vertical: fin.normal === 'x',
    area: fin.area,
    liftSlope: fin.liftSlope,
    controlSlope: fin.controlSlope,
    arm: new THREE.Vector3().fromArray(fin.position).sub(centerOfMass),
    maxDeflection: fin.maxDeflection * DEG,
    force: 0.5,
  }));
  const propArms = props.positions.map((position) => new THREE.Vector3().fromArray(position).sub(centerOfMass));
  const sternArm = new THREE.Vector3().fromArray(stern.position).sub(centerOfMass);

  // ---- Rigid-body state (centre of mass) --------------------------------------------------------------
  const centerPosition = new THREE.Vector3();
  const state = {
    /** Mesh origin (world): the centre of the envelope (buoyancy). */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x nose up, y nose left, z right side up. */
    angularVelocity: new THREE.Vector3(),
  };

  const contact = createGroundContact(profile.contacts, { centerOfMass, floats: false, mass: inertialMass });
  const landing = createLandingMonitor({ bus, craftId, limits });
  const contactReport = contact.report;
  const contactBody = { position: centerPosition, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };

  /** Engines, props and levers. */
  const systems = {
    engineOn: true,
    throttle: 0,
    /** Prop speed share (0..1): follows the throttle with the spool lag. */
    propShare: 0,
    /** Engine start progress (0..1) after an engine-on. */
    starting: 1,
    thrustLeft: 0,
    thrustRight: 0,
    sternThrust: 0,
    vectorAngle: 0,
    ballonet: 0.5,
  };
  /** The rocker and antenna as last seen (relative lever moves): [0] trim, [1] antenna. */
  const levers = new Float64Array([NaN, NaN]);
  /**
   * This tick's doubles (slots RHO, STEP, ELEVATOR, RUDDER, THRUST, LIFT): the force functions read
   * and write them here, so no double crosses a call (a double argument or return value is boxed).
   */
  const tick = new Float64Array(6);
  /** The landing monitor's per-tick sample (reused). */
  const landingSample = { dt: 0, agl: 0, position: null };
  /**
   * Doubles written every tick live in a typed array (a closure variable holding a double is boxed
   * on every write): [0] the model's own clock (s), [1] the smoothed load factor.
   */
  const clock = new Float64Array([0, 1]);
  let resetCount = 0;

  /** Mesh animation: elevator and rudder deflections (shares), prop spin (visual rad/s). */
  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  // ---- Live flight data (control stages and telemetry read it; SI, radians) ---------------------------
  const flightData = {
    airspeed: 0,
    forwardAirspeed: 0,
    groundSpeed: 0,
    verticalSpeed: 0,
    dynamicPressure: 0,
    pitch: 0,
    bank: 0,
    heading: 0,
    track: 0,
    pitchRate: 0,
    yawRate: 0,
    rollRate: 0,
    gLoad: 1,
    onGround: false,
    agl: Infinity,
    throttle: 0,
    thrust: 0,
    heaviness: 0,
    pressureHeight: statics.pressureHeight,
    ballonet: 0.5,
    vectorAngle: 0,
    engineOn: true,
    vne,
    /** Dynamic pressure at the cruise: the reference the assists scale their gains to. */
    referencePressure: 0.5 * SEA_LEVEL_DENSITY * (craft && craft.spawn ? craft.spawn.cruise : 22) ** 2,
    resetCount: 0,
  };

  // ---- Scratch -------------------------------------------------------------------------------------------
  const inverseQuaternion = new THREE.Quaternion();
  const airBody = new THREE.Vector3();
  const windVelocity = new THREE.Vector3();
  const localAir = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const forceBody = new THREE.Vector3();
  const momentBody = new THREE.Vector3();
  const pointForce = new THREE.Vector3();
  const pointMoment = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const accelerationBody = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const angularAcceleration = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const originOffset = new THREE.Vector3();
  const upBody = new THREE.Vector3();
  const forwardWorld = new THREE.Vector3();
  const rightWorld = new THREE.Vector3();
  const upWorld = new THREE.Vector3();

  function notify(text, kind = 'info') {
    if (bus) bus.emit('notify', { text, kind });
  }

  // ============================================================================================
  // PILOT ACTIONS AND LEVERS
  // ============================================================================================
  function handleActions(actions, quiet) {
    if (!actions || actions.size === 0) return;
    for (const action of actions) {
      if (action !== 'engineToggle') continue;
      systems.engineOn = !systems.engineOn;
      if (systems.engineOn) systems.starting = 0;
      if (!quiet || !quiet.has(action)) notify(systems.engineOn ? 'Engines starting.' : 'Engines off: the airship drifts with the wind.', systems.engineOn ? 'success' : 'warning');
    }
  }

  /**
   * The rocker and the antenna move their targets relatively (a stale lever position never jumps a
   * target) and snap them at the end stops; the flap keys held work the ballonet blowers. The pods
   * then swivel on their servos and the ballonets fill as fast as the blowers and valves go.
   */
  function readLevers(controls) {
    const dt = tick[STEP];
    const trim = clamp(Number.isFinite(controls.trim) ? controls.trim : 0, -1, 1);
    let vectorTarget = Number.isFinite(craftState.vectorTarget) ? clamp(craftState.vectorTarget, -vector.down, vector.up) : 0;
    const previousTrim = levers[0];
    levers[0] = trim;
    if (Number.isFinite(previousTrim) && Math.abs(trim - previousTrim) > LEVER_EPSILON) {
      if (trim >= LEVER_END) vectorTarget = vector.up;
      else if (trim <= -LEVER_END) vectorTarget = -vector.down;
      else {
        const now = trim >= 0 ? trim * vector.up : trim * vector.down;
        const before = previousTrim >= 0 ? previousTrim * vector.up : previousTrim * vector.down;
        vectorTarget = clamp(vectorTarget + now - before, -vector.down, vector.up);
      }
    }
    if (craftState.vectorTarget !== vectorTarget) craftState.vectorTarget = vectorTarget;

    const antenna = clamp(Number.isFinite(controls.antenna) ? controls.antenna : 0, 0, 1);
    let ballonetTarget = Number.isFinite(craftState.ballonetTarget) ? clamp(craftState.ballonetTarget, 0, 1) : 0.5;
    const previousAntenna = levers[1];
    levers[1] = antenna;
    if (Number.isFinite(previousAntenna) && Math.abs(antenna - previousAntenna) > LEVER_EPSILON) {
      if (antenna >= LEVER_END) ballonetTarget = 1;
      else if (antenna <= 1 - LEVER_END) ballonetTarget = 0;
      else ballonetTarget = clamp(ballonetTarget + antenna - previousAntenna, 0, 1);
    }
    // The flap keys / buttons work the ballonet valves and blowers while held: down fills (heavier).
    const held = controls.held;
    if (held && held.has('flapsDown')) ballonetTarget = Math.min(1, ballonetTarget + envelope.leverRate * dt);
    if (held && held.has('flapsUp')) ballonetTarget = Math.max(0, ballonetTarget - envelope.leverRate * dt);
    if (craftState.ballonetTarget !== ballonetTarget) craftState.ballonetTarget = ballonetTarget;

    const swivel = vector.rate * dt;
    systems.vectorAngle += clamp(vectorTarget - systems.vectorAngle, -swivel, swivel);
    const blow = dt / envelope.blowerSeconds;
    systems.ballonet += clamp(ballonetTarget - systems.ballonet, -blow, blow);
  }

  // ============================================================================================
  // FORCES
  // ============================================================================================
  /** Adds a body force at an arm (relative to the centre of mass) to the tick's force and moment. */
  function applyAt(arm, force) {
    forceBody.add(force);
    pointMoment.crossVectors(arm, force);
    momentBody.add(pointMoment);
  }

  /** The net static lift (N, up) into tick[LIFT]: the free helium's displacement against the weight. */
  function staticLift() {
    const free = statics.heliumMass * (1 - envelope.storage * systems.ballonet);
    const gross = Math.min(free / envelope.gasRatio, tick[RHO] * envelope.volume);
    flightData.heaviness = weightMass - gross;
    flightData.pressureHeight = -Math.log(free / envelope.gasRatio / envelope.volume / SEA_LEVEL_DENSITY) * DENSITY_SCALE;
    tick[LIFT] = gross * GRAVITY;
  }

  /** Hull: axial drag, crossflow drag, viscous lift and the Munk moment, at the centre of buoyancy. */
  function hullForces() {
    const rho = tick[RHO];
    spin.crossVectors(state.angularVelocity, buoyancyArm);
    localAir.copy(airBody).add(spin);
    const u = localAir.z;
    const crossflow = Math.sqrt(localAir.x * localAir.x + localAir.y * localAir.y);
    const half = 0.5 * rho;
    pointForce.set(
      -half * (hull.crossflowDrag * hull.planArea * crossflow + hull.liftSlope * referenceArea * Math.abs(u)) * localAir.x,
      -half * (hull.crossflowDrag * hull.planArea * crossflow + hull.liftSlope * referenceArea * Math.abs(u)) * localAir.y,
      -half * hull.dragCoefficient * referenceArea * u * Math.abs(u),
    );
    applyAt(buoyancyArm, pointForce);
    // Munk: rho V (k2 - k1) u w turns the hull broadside to the flow (pitch and yaw).
    const munk = hull.munk * rho * envelope.volume;
    momentBody.x += munk * localAir.z * localAir.y;
    momentBody.y -= munk * localAir.z * localAir.x;
    // Rotational crossflow drag of the long hull (keeps a spinning, slow airship from spinning on).
    const rates = state.angularVelocity;
    momentBody.x -= hull.rotationalDamping * rho * rates.x * Math.abs(rates.x) + hull.pitchDamping * rates.x;
    momentBody.y -= hull.rotationalDamping * rho * rates.y * Math.abs(rates.y) + hull.yawDamping * rates.y;
    momentBody.z -= hull.rollDamping * rates.z;
  }

  /** The four fins in their own local flow; elevators on the horizontal pair, rudders on the vertical pair. */
  function finForces() {
    const rho = tick[RHO];
    for (let index = 0; index < fins.length; index++) {
      const fin = fins[index];
      spin.crossVectors(state.angularVelocity, fin.arm);
      localAir.copy(airBody).add(spin);
      const speedSquared = localAir.lengthSq();
      if (speedSquared < 1e-6) {
        fin.force = 0;
        continue;
      }
      const q = 0.5 * rho * speedSquared;
      // Horizontal fins: the flow from below (the tail sinking) lifts them. Vertical fins: the flow
      // from the right pushes them left. Lift slope, the crossflow normal force past the linear
      // range, and the control surface (fading as the fin stalls).
      const across = fin.vertical ? localAir.x : -localAir.y;
      const angle = Math.atan2(across, Math.max(-localAir.z, 1e-3));
      const deflection = (fin.vertical ? tick[RUDDER] : -tick[ELEVATOR]) * fin.maxDeflection;
      const sine = Math.sin(angle);
      const cosine = Math.cos(angle);
      const coefficient = fin.liftSlope * sine * cosine + FIN_CROSSFLOW * sine * Math.abs(sine) + fin.controlSlope * deflection * cosine * cosine;
      if (fin.vertical) {
        fin.force = -q * fin.area * coefficient;
        pointForce.set(fin.force, 0, 0);
      } else {
        fin.force = q * fin.area * coefficient;
        pointForce.set(0, fin.force, 0);
      }
      applyAt(fin.arm, pointForce);
    }
  }

  /** The two vectored props and the stern thruster; the total prop thrust (N) into tick[THRUST]. */
  function thrustForces() {
    const rho = tick[RHO];
    const rudder = tick[RUDDER];
    const dt = tick[STEP];
    const running = systems.engineOn;
    if (running && systems.starting < 1) systems.starting = Math.min(1, systems.starting + dt / ENGINE_START_SECONDS);
    const target = running ? systems.throttle * systems.starting : 0;
    systems.propShare += (target - systems.propShare) * (1 - Math.exp(-dt / SPOOL_SECONDS));
    const angle = systems.vectorAngle * DEG;
    const directionY = Math.sin(angle);
    const directionZ = -Math.cos(angle);
    // Thrust falls with the inflow through the disc (the airspeed along the thrust line).
    const inflow = airBody.y * directionY + airBody.z * directionZ;
    const lapse = clamp(1 - inflow / props.zeroThrustSpeed, 0, 1.25) * (rho / SEA_LEVEL_DENSITY);
    const each = 0.5 * props.staticThrust * systems.propShare * lapse;
    const split = clamp(rudder, -1, 1) * props.differential;
    systems.thrustLeft = each * (1 + split);
    systems.thrustRight = each * (1 - split);
    pointForce.set(0, systems.thrustLeft * directionY, systems.thrustLeft * directionZ);
    applyAt(propArms[0], pointForce);
    pointForce.set(0, systems.thrustRight * directionY, systems.thrustRight * directionZ);
    applyAt(propArms[1], pointForce);
    // The stern thruster pushes the tail sideways at low speed (right rudder: the tail goes left).
    const fade = 1 - clamp((flightData.forwardAirspeed - stern.fadeSpeed[0]) / (stern.fadeSpeed[1] - stern.fadeSpeed[0]), 0, 1);
    systems.sternThrust = running ? -clamp(rudder, -1, 1) * fade * systems.starting : 0;
    pointForce.set(systems.sternThrust * stern.thrust * (rho / SEA_LEVEL_DENSITY), 0, 0);
    applyAt(sternArm, pointForce);
    tick[THRUST] = systems.thrustLeft + systems.thrustRight;
  }

  /** Gusts shove the big hull around: small shaking moments that scale with the turbulence and the air. */
  function gustForces(env) {
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    if (!(turbulence > 0)) return;
    const shake = hull.gustMoment * turbulence * (tick[RHO] / SEA_LEVEL_DENSITY) * (0.4 + Math.min(1, airBody.lengthSq() / 400));
    momentBody.x += shake * 0.5 * noise(clock, 0.7, 0.21);
    momentBody.y += shake * noise(clock, 2.3, 0.17);
    momentBody.z += shake * 0.3 * noise(clock, 4.1, 0.26);
    forceBody.x += shake * 0.02 * noise(clock, 5.3, 0.13);
    forceBody.y += shake * 0.015 * noise(clock, 6.1, 0.11);
  }

  // ============================================================================================
  // STEP
  // ============================================================================================
  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    clock[TIME] += dt;
    tick[STEP] = dt;
    handleActions(controls.actions, controls.quietActions);
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    tick[RHO] = rho;
    readLevers(controls);
    systems.throttle = clamp(Number.isFinite(controls.throttle) ? controls.throttle : 0, 0, 1);
    tick[ELEVATOR] = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    // An airship cannot roll on command: the stick's X axis works the rudders with the pedals.
    tick[RUDDER] = clamp((Number.isFinite(controls.yaw) ? controls.yaw : 0) + (Number.isFinite(controls.roll) ? controls.roll : 0), -1, 1);

    // Air data in body axes (the craft's velocity through the air).
    if (env.wind && env.wind.vel) windVelocity.copy(env.wind.vel);
    else windVelocity.set(0, 0, 0);
    inverseQuaternion.copy(state.quaternion).invert();
    airBody.copy(state.velocity).sub(windVelocity).applyQuaternion(inverseQuaternion);
    flightData.forwardAirspeed = Math.max(0, -airBody.z);

    forceBody.set(0, 0, 0);
    momentBody.set(0, 0, 0);
    hullForces();
    finForces();
    thrustForces();
    gustForces(env);

    // Static lift at the centre of buoyancy and the weight at the centre of mass (world up).
    staticLift();
    upBody.set(0, 1, 0).applyQuaternion(inverseQuaternion);
    pointForce.copy(upBody).multiplyScalar(tick[LIFT]);
    applyAt(buoyancyArm, pointForce);

    integrate(dt, env);

    // Flight data for the control stages and telemetry.
    computeAttitude();
    const airspeed = Math.sqrt(airBody.lengthSq());
    flightData.airspeed = airspeed;
    flightData.groundSpeed = Math.sqrt(state.velocity.x * state.velocity.x + state.velocity.z * state.velocity.z);
    flightData.track = flightData.groundSpeed > 0.5 ? headingFromVector(state.velocity.x, state.velocity.z) : flightData.heading;
    flightData.verticalSpeed = state.velocity.y;
    flightData.dynamicPressure = 0.5 * rho * airspeed * airspeed;
    flightData.pitchRate = state.angularVelocity.x;
    flightData.yawRate = -state.angularVelocity.y;
    flightData.rollRate = -state.angularVelocity.z;
    flightData.gLoad = clock[LOAD];
    flightData.onGround = contactReport.onGround;
    flightData.agl = centerPosition.y - surfaceHeightAt(env, centerPosition.x, centerPosition.z);
    flightData.throttle = systems.throttle;
    flightData.thrust = tick[THRUST];
    flightData.ballonet = systems.ballonet;
    flightData.vectorAngle = systems.vectorAngle;
    flightData.engineOn = systems.engineOn;
    writeCraftState();
    writeSurfaces();
    landingSample.dt = dt;
    landingSample.agl = flightData.agl;
    landingSample.position = state.position;
    landing.observe(contactReport, landingSample);
  }

  /** One semi-implicit Euler step: ground contact, added mass per body axis, Euler's equations. */
  function integrate(dt, env) {
    const rho = tick[RHO];
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    contact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    momentBody.add(groundMoment);

    // World force: aero, thrust and lift (body), the contact (world) and the weight.
    forceWorld.copy(forceBody).applyQuaternion(state.quaternion).add(groundForce);
    forceWorld.y -= weightMass * GRAVITY;
    upWorld.set(0, 1, 0).applyQuaternion(state.quaternion);
    const load = (forceWorld.dot(upWorld) + weightMass * GRAVITY * upWorld.y) / (weightMass * GRAVITY);
    clock[LOAD] += (load - clock[LOAD]) * (1 - Math.exp(-LOAD_SMOOTHING * dt));

    // Added mass: the displaced air moves with the hull, a little along it and a lot across it.
    const displaced = rho * envelope.volume;
    accelerationBody.copy(forceWorld).applyQuaternion(inverseQuaternion);
    accelerationBody.set(
      accelerationBody.x / (inertialMass + envelope.lateralAddedMass * displaced),
      accelerationBody.y / (inertialMass + envelope.lateralAddedMass * displaced),
      accelerationBody.z / (inertialMass + envelope.axialAddedMass * displaced),
    );
    accelerationBody.applyQuaternion(state.quaternion);

    // Euler's equations (principal axes, added inertia included): I w' = M - w x (I w).
    angularMomentum.set(state.angularVelocity.x * inertia.x, state.angularVelocity.y * inertia.y, state.angularVelocity.z * inertia.z);
    gyro.crossVectors(state.angularVelocity, angularMomentum);
    angularAcceleration.copy(momentBody).sub(gyro);
    angularAcceleration.set(angularAcceleration.x / inertia.x, angularAcceleration.y / inertia.y, angularAcceleration.z / inertia.z);

    state.velocity.addScaledVector(accelerationBody, dt);
    if (state.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) state.velocity.setLength(MAX_SPEED);
    state.angularVelocity.addScaledVector(angularAcceleration, dt);
    if (state.angularVelocity.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) state.angularVelocity.setLength(MAX_ANGULAR_SPEED);
    centerPosition.addScaledVector(state.velocity, dt);
    // The body-rate rotation over the step (axis-angle written out, so no double crosses a call).
    const rates = state.angularVelocity;
    const rate = Math.sqrt(rates.x * rates.x + rates.y * rates.y + rates.z * rates.z);
    if (rate > 1e-12) {
      const half = 0.5 * rate * dt;
      const share = Math.sin(half) / rate;
      rotationStep.set(rates.x * share, rates.y * share, rates.z * share, Math.cos(half));
      state.quaternion.multiply(rotationStep).normalize();
    }
    syncOrigin();
  }

  function syncOrigin() {
    originOffset.copy(centerOfMass).applyQuaternion(state.quaternion);
    state.position.copy(centerPosition).sub(originOffset);
  }

  function computeAttitude() {
    forwardWorld.set(0, 0, -1).applyQuaternion(state.quaternion);
    rightWorld.set(1, 0, 0).applyQuaternion(state.quaternion);
    upWorld.set(0, 1, 0).applyQuaternion(state.quaternion);
    flightData.pitch = Math.asin(clamp(forwardWorld.y, -1, 1));
    flightData.bank = Math.atan2(-rightWorld.y, upWorld.y);
    if (forwardWorld.x * forwardWorld.x + forwardWorld.z * forwardWorld.z > 0.0025) flightData.heading = headingFromVector(forwardWorld.x, forwardWorld.z);
  }

  /** The live values into craftState (rounded; a field is written only when it changes). */
  function writeCraftState() {
    const ballonet = Math.round(systems.ballonet * 10000) / 10000;
    if (craftState.ballonet !== ballonet) craftState.ballonet = ballonet;
    const vectorAngle = Math.round(systems.vectorAngle * 100) / 100;
    if (craftState.vectorAngle !== vectorAngle) craftState.vectorAngle = vectorAngle;
    const heaviness = Math.round(flightData.heaviness);
    if (craftState.heaviness !== heaviness) craftState.heaviness = heaviness;
    const pressureHeight = Math.round(flightData.pressureHeight);
    if (craftState.pressureHeight !== pressureHeight) craftState.pressureHeight = pressureHeight;
    const propShare = Math.round(systems.propShare * 1000) / 1000;
    if (craftState.propShare !== propShare) craftState.propShare = propShare;
    const sternThrust = Math.round(systems.sternThrust * 1000) / 1000;
    if (craftState.sternThrust !== sternThrust) craftState.sternThrust = sternThrust;
    if (craftState.engineOn !== systems.engineOn) craftState.engineOn = systems.engineOn;
  }

  /** Elevator and rudder shares and the prop spin for the mesh. */
  function writeSurfaces() {
    surfaces.elevator = tick[ELEVATOR];
    surfaces.rudder = tick[RUDDER];
    surfaces.aileron = 0;
    surfaces.propSpeed = systems.propShare * props.visualSpeed;
    surfaces.groundSpeed = contactReport.onGround ? flightData.groundSpeed : 0;
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  function reset(pose = {}) {
    if (pose.quaternion) state.quaternion.copy(pose.quaternion).normalize();
    if (pose.position) {
      originOffset.copy(centerOfMass).applyQuaternion(state.quaternion);
      centerPosition.copy(pose.position).add(originOffset);
    }
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    if (pose.angularVelocity) state.angularVelocity.copy(pose.angularVelocity);
    else state.angularVelocity.set(0, 0, 0);
    syncOrigin();
    const onGround = pose.onGround === true;
    systems.engineOn = pose.engineOn !== false;
    systems.starting = 1;
    systems.throttle = Number.isFinite(pose.throttle) ? clamp(pose.throttle, 0, 1) : 0;
    systems.propShare = systems.engineOn ? systems.throttle : 0;
    // A reset keeps the targets a placement set, and starts the pods and ballonets on them.
    if (!Number.isFinite(craftState.vectorTarget)) craftState.vectorTarget = 0;
    if (!Number.isFinite(craftState.ballonetTarget)) craftState.ballonetTarget = 0.5;
    craftState.vectorTarget = clamp(craftState.vectorTarget, -vector.down, vector.up);
    craftState.ballonetTarget = clamp(craftState.ballonetTarget, 0, 1);
    systems.vectorAngle = craftState.vectorTarget;
    systems.ballonet = craftState.ballonetTarget;
    systems.sternThrust = 0;
    levers[0] = NaN;
    levers[1] = NaN;
    clock[LOAD] = 1;
    contact.reset(onGround);
    landing.reset(onGround);
    contactReport.onGround = onGround;
    flightData.onGround = onGround;
    resetCount++;
    flightData.resetCount = resetCount;
    computeAttitude();
    tick[RHO] = SEA_LEVEL_DENSITY * Math.exp(-Math.max(state.position.y, -500) / DENSITY_SCALE);
    staticLift();
    flightData.airspeed = state.velocity.length();
    flightData.forwardAirspeed = flightData.airspeed;
    writeCraftState();
    tick[ELEVATOR] = 0;
    tick[RUDDER] = 0;
    writeSurfaces();
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(flight) {
    flight.gLoad = flightData.gLoad;
    flight.throttle = systems.throttle;
    flight.afterburner = false;
    flight.engineOn = systems.engineOn;
    flight.rpm = systems.propShare;
    flight.rotorRpm = 0;
    flight.torque = 0;
    flight.flaps = 0;
    flight.flapNotch = 0;
    flight.gear.retractable = false;
    flight.gear.down = true;
    flight.gear.transit = 0;
    flight.airbrake = 0;
    flight.brakes = 0;
    flight.trim = clamp(systems.vectorAngle / vector.up, -1, 1);
    flight.contacts = contactReport.contacts;
    // Nothing to stall: an airship flies on buoyancy.
    flight.stall.stalled = false;
    flight.stall.warning = false;
    flight.stall.buffet = 0;
    flight.overspeed = flightData.airspeed > vne;
  }

  function snapshot() {
    return {
      kind: 'airship',
      center: [centerPosition.x, centerPosition.y, centerPosition.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      systems: {
        engineOn: systems.engineOn,
        throttle: systems.throttle,
        propShare: systems.propShare,
        starting: systems.starting,
        vectorAngle: systems.vectorAngle,
        ballonet: systems.ballonet,
      },
      targets: { vector: craftState.vectorTarget, ballonet: craftState.ballonetTarget },
      levers: { trim: levers[0], antenna: levers[1] },
      load: clock[LOAD],
      time: clock[TIME],
      contact: contact.snapshot(),
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'airship') return false;
    centerPosition.fromArray(data.center);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    Object.assign(systems, data.systems);
    if (data.targets) {
      craftState.vectorTarget = data.targets.vector;
      craftState.ballonetTarget = data.targets.ballonet;
    }
    if (data.levers) {
      levers[0] = Number.isFinite(data.levers.trim) ? data.levers.trim : NaN;
      levers[1] = Number.isFinite(data.levers.antenna) ? data.levers.antenna : NaN;
    }
    clock[LOAD] = Number.isFinite(data.load) ? data.load : 1;
    if (Number.isFinite(data.time)) clock[TIME] = data.time;
    contact.restore(data.contact);
    landing.restore(data.landing);
    syncOrigin();
    computeAttitude();
    return true;
  }

  return {
    kind: 'airship',
    profile,
    state,
    contact: contactReport,
    surfaces,
    flightData,
    craftState,
    statics,
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
    /** Each fin's normal force (N) last tick, and each prop's thrust. */
    get forces() {
      return { fins: fins.map((fin) => ({ id: fin.id, force: fin.force })), thrustLeft: systems.thrustLeft, thrustRight: systems.thrustRight, stern: systems.sternThrust * stern.thrust };
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
// AIRSHIP ASSISTS
//   from 0 to 50 %   pitch damper (the stick commands a pitch attitude), yaw damper (the rudder
//                    commands a turn rate; centred, it stops the turn)
//   from 50 to 100 % heading hold (centred rudder holds the heading)
//   from 75 to 100 % altitude hold (centred stick holds the height through the elevators: dynamic
//                    lift, so only with way on)
// The autopilot flies through the same surfaces; while it flies, the assists leave it alone.
// ============================================================================================
const AIRSHIP_ASSISTS = Object.freeze({
  /** Pitch attitude at full stick (deg) and the attitude loop gains (per degree, per deg/s). */
  PITCH_COMMAND: 12,
  PITCH_P: 0.08,
  PITCH_D: 0.9,
  /** Turn rate at full rudder (deg/s: what the rudders give at the cruise) and the rate loop gain (per deg/s). */
  YAW_RATE: 2.5,
  YAW_P: 1.5,
  HEADING_P: 0.3,
  HEADING_MAX_RATE: 2,
  /** Altitude hold: pitch (deg) per metre of error and per m/s of climb, and its limits. */
  ALTITUDE_P: 0.12,
  ALTITUDE_D: 1.6,
  ALTITUDE_MAX_PITCH: 8,
  /** The holds capture once the pilot is off the controls and the motion has settled. */
  CENTRED: 0.05,
  SETTLED_YAW_RATE: 0.6,
  /** Gains scale with the reference dynamic pressure over the actual one, within these limits. */
  GAIN_SCALE: Object.freeze([0.5, 6]),
  MIN_HOLD_SPEED: 6,
});

const AIRSHIP_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'pitchDamper', name: 'pitch damper', from: 0, full: 0.5 }),
  Object.freeze({ key: 'yawDamper', name: 'yaw damper', from: 0, full: 0.5 }),
  Object.freeze({ key: 'headingHold', name: 'heading hold', from: 0.5, full: 1 }),
  Object.freeze({ key: 'altitudeHold', name: 'altitude hold', from: 0.75, full: 1 }),
]);

function wrapSigned(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/** The control-gain scale for the current dynamic pressure (the surfaces' authority falls with q). */
function gainScale(data) {
  const pressure = Math.max(data.dynamicPressure, 1);
  return clamp(data.referencePressure / pressure, AIRSHIP_ASSISTS.GAIN_SCALE[0], AIRSHIP_ASSISTS.GAIN_SCALE[1]);
}

/** Elevator share for a pitch attitude target (deg). */
export function airshipPitchCommand(data, targetPitch) {
  const pitch = data.pitch / DEG;
  const rate = data.pitchRate / DEG;
  return clamp((AIRSHIP_ASSISTS.PITCH_P * (targetPitch - pitch) - AIRSHIP_ASSISTS.PITCH_D * AIRSHIP_ASSISTS.PITCH_P * rate) * gainScale(data), -1, 1);
}

/** Rudder share for a turn rate target (deg/s, positive right). */
export function airshipYawCommand(data, targetRate) {
  const rate = data.yawRate / DEG;
  return clamp(AIRSHIP_ASSISTS.YAW_P * (targetRate - rate) * gainScale(data), -1, 1);
}

export const airshipAssistHandler = Object.freeze({
  createMemory() {
    return { resetCount: -1, heading: NaN, altitude: NaN };
  },

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model && model.flightData;
    if (!data) return;
    if (context.autopilot && context.autopilot.enabled) {
      memory.heading = NaN;
      memory.altitude = NaN;
      return;
    }
    const pilotPitch = clamp(Number.isFinite(controls.pitch) ? controls.pitch : 0, -1, 1);
    const pilotRudder = clamp((Number.isFinite(controls.yaw) ? controls.yaw : 0) + (Number.isFinite(controls.roll) ? controls.roll : 0), -1, 1);
    const position = model.state.position;
    const flying = !data.onGround;

    // Pitch: attitude command, or the altitude hold's attitude while the stick is centred.
    if (weights.pitchDamper > 0 && flying) {
      let targetPitch = pilotPitch * AIRSHIP_ASSISTS.PITCH_COMMAND;
      const holding = weights.altitudeHold > 0 && Math.abs(pilotPitch) < AIRSHIP_ASSISTS.CENTRED && data.forwardAirspeed > AIRSHIP_ASSISTS.MIN_HOLD_SPEED;
      if (holding) {
        if (!Number.isFinite(memory.altitude)) memory.altitude = position.y;
        const hold = clamp(AIRSHIP_ASSISTS.ALTITUDE_P * (memory.altitude - position.y) - AIRSHIP_ASSISTS.ALTITUDE_D * data.verticalSpeed, -AIRSHIP_ASSISTS.ALTITUDE_MAX_PITCH, AIRSHIP_ASSISTS.ALTITUDE_MAX_PITCH);
        targetPitch = hold * weights.altitudeHold;
      } else {
        memory.altitude = NaN;
      }
      const command = airshipPitchCommand(data, targetPitch);
      controls.pitch = pilotPitch + (command - pilotPitch) * weights.pitchDamper;
    }

    // Yaw: rate command, plus the heading hold once the rudder is centred and the turn has stopped.
    if (weights.yawDamper > 0 && flying) {
      let targetRate = pilotRudder * AIRSHIP_ASSISTS.YAW_RATE;
      const centred = Math.abs(pilotRudder) < AIRSHIP_ASSISTS.CENTRED;
      if (weights.headingHold > 0 && centred) {
        if (!Number.isFinite(memory.heading) && Math.abs(data.yawRate / DEG) < AIRSHIP_ASSISTS.SETTLED_YAW_RATE) memory.heading = data.heading;
        if (Number.isFinite(memory.heading)) {
          const error = wrapSigned(memory.heading - data.heading);
          targetRate += clamp(error * AIRSHIP_ASSISTS.HEADING_P, -AIRSHIP_ASSISTS.HEADING_MAX_RATE, AIRSHIP_ASSISTS.HEADING_MAX_RATE) * weights.headingHold;
        }
      } else {
        memory.heading = NaN;
      }
      const command = airshipYawCommand(data, targetRate);
      controls.yaw = pilotRudder + (command - pilotRudder) * weights.yawDamper;
      controls.roll = 0;
    }
  },
});

registerAssistCatalog('airship', AIRSHIP_ASSIST_CATALOG);
registerAssistHandler('airship', airshipAssistHandler);

// ============================================================================================
// AIRSHIP AUTOPILOT: heading (or a ground track), altitude and speed through the elevators, rudders
// and throttle, with a long terrain look-ahead (an airship climbs slowly). While the scenic cruise
// flies (craftState.scenicCruise with a target), the heading is the one that keeps the ground track
// on the target in the wind (the crab angle), and in photo mode it slows to a photo pace.
// ============================================================================================
export const AIRSHIP_AUTOPILOT = Object.freeze({
  /** Turn rate (deg/s) per degree of heading error, and its limit. */
  TURN_PER_DEGREE: 0.2,
  MAX_TURN_RATE: 3,
  /** Climb rate (m/s) per metre of altitude error, its limits, and the pitch limits (deg). */
  CLIMB_PER_METRE: 0.05,
  MAX_CLIMB: 3,
  MAX_DESCENT: 2.5,
  MAX_PITCH: 10,
  MIN_PITCH: -8,
  /** Extra pitch (deg) per m/s the climb rate falls short of the wanted one. */
  PITCH_PER_CLIMB_ERROR: 1.5,
  /** Throttle per m/s of speed error, the integral gain and its limit. */
  SPEED_P: 0.12,
  SPEED_I: 0.03,
  SPEED_INTEGRAL_LIMIT: 0.6,
  /** Clearance kept above the highest surface ahead (m, from the envelope's centre). */
  CLEARANCE: 140,
  LOOKAHEAD_SECONDS: Object.freeze([0, 5, 10, 20, 30, 45, 60]),
  LOOKAHEAD_REFRESH: 0.5,
  /** The crab angle is limited to this sine of the drift (a gale beats any airship). */
  MAX_CRAB_SINE: 0.8,
  /** The scenic cruise's photo pace: this share of its speed while photo mode is open. */
  PHOTO_PACE: 0.65,
});

/**
 * memory.floor = the highest surface along the ground track and the nose over the next minute, plus
 * the clearance (refreshed every LOOKAHEAD_REFRESH s; no double crosses the call).
 */
function refreshTerrainFloor(memory, context, data, position, velocity) {
  memory.lookaheadAge += context.dt;
  if (memory.lookaheadAge < AIRSHIP_AUTOPILOT.LOOKAHEAD_REFRESH) return;
  memory.lookaheadAge = 0;
  const env = context.env;
  const world = env.world;
  const speed = Math.max(data.forwardAirspeed, 5);
  const headingRadians = data.heading * DEG;
  const noseX = Math.sin(headingRadians) * speed;
  const noseZ = -Math.cos(headingRadians) * speed;
  let floor = -Infinity;
  const lookahead = AIRSHIP_AUTOPILOT.LOOKAHEAD_SECONDS;
  for (let index = 0; index < lookahead.length; index++) {
    const seconds = lookahead[index];
    for (let path = 0; path < 2; path++) {
      const x = position.x + (path === 0 ? velocity.x : noseX) * seconds;
      const z = position.z + (path === 0 ? velocity.z : noseZ) * seconds;
      const ground = world ? world.groundHeight(x, z) : env.groundHeight(x, z);
      floor = Math.max(floor, Math.max(ground, waterHeightAt(env, x, z)) + AIRSHIP_AUTOPILOT.CLEARANCE);
    }
  }
  memory.floor = floor;
}

/**
 * The heading (deg) that flies a ground track (deg) at an airspeed through a wind (x, z m/s): the
 * crab angle into the crosswind, limited to MAX_CRAB_SINE.
 */
export function crabHeading(track, airspeed, windX, windZ) {
  if (!(airspeed > 2)) return track;
  const radians = track * DEG;
  // The crosswind component: the wind across the track (positive from the left, pushing right).
  const cross = windX * Math.cos(radians) + windZ * Math.sin(radians);
  const sine = clamp(-cross / airspeed, -AIRSHIP_AUTOPILOT.MAX_CRAB_SINE, AIRSHIP_AUTOPILOT.MAX_CRAB_SINE);
  return (((track + Math.asin(sine) / DEG) % 360) + 360) % 360;
}

/** The throttle that holds an airspeed in level flight: the hull drag over the props' thrust there. */
export function levelThrottle(profile, speed, rho = SEA_LEVEL_DENSITY) {
  const density = Number.isFinite(rho) ? rho : SEA_LEVEL_DENSITY;
  const drag = 0.5 * density * profile.hull.dragCoefficient * Math.pow(profile.envelope.volume, 2 / 3) * speed * speed;
  const available = profile.props.staticThrust * clamp(1 - speed / profile.props.zeroThrustSpeed, 0.05, 1) * (density / SEA_LEVEL_DENSITY);
  return clamp(drag / available, 0, 1);
}

export const airshipAutopilot = Object.freeze({
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
    const env = context.env;
    const dt = context.dt;
    const position = model.state.position;
    const velocity = model.state.velocity;
    if (!memory.engaged) {
      memory.engaged = true;
      memory.speedIntegral = 0;
      memory.lookaheadAge = Infinity;
    }
    const cruise = model.craftState ? model.craftState.scenicCruise : null;
    const cruising = Boolean(cruise && cruise.active && cruise.target && Number.isFinite(cruise.target.x) && Number.isFinite(cruise.target.z));
    const wind = env.wind && env.wind.vel ? env.wind.vel : null;
    let heading = autopilot.heading;
    if (cruising) {
      const track = headingFromVector(cruise.target.x - position.x, cruise.target.z - position.z);
      heading = wind ? crabHeading(track, data.forwardAirspeed, wind.x, wind.z) : track;
    } else if (autopilot.followWaypoint && wind) {
      // The controller points autopilot.heading at the marker: hold that as a track.
      heading = crabHeading(autopilot.heading, data.forwardAirspeed, wind.x, wind.z);
    }

    // Heading: a turn rate toward it through the rudders (and the stern thruster at low speed).
    const error = wrapSigned(heading - data.heading);
    const turnRate = clamp(error * AIRSHIP_AUTOPILOT.TURN_PER_DEGREE, -AIRSHIP_AUTOPILOT.MAX_TURN_RATE, AIRSHIP_AUTOPILOT.MAX_TURN_RATE);
    controls.yaw = airshipYawCommand(data, turnRate);
    controls.roll = 0;

    // Altitude through the pitch attitude (dynamic lift and the thrust line), clear of the terrain ahead.
    refreshTerrainFloor(memory, context, data, position, velocity);
    const wanted = cruising && Number.isFinite(cruise.altitude) ? cruise.altitude : autopilot.altitude;
    const target = Math.max(Number.isFinite(wanted) ? wanted : position.y, memory.floor);
    const climb = clamp((target - position.y) * AIRSHIP_AUTOPILOT.CLIMB_PER_METRE, -AIRSHIP_AUTOPILOT.MAX_DESCENT, AIRSHIP_AUTOPILOT.MAX_CLIMB);
    const speed = Math.max(data.forwardAirspeed, 4);
    const pitch = clamp(Math.asin(clamp(climb / speed, -0.5, 0.5)) / DEG + AIRSHIP_AUTOPILOT.PITCH_PER_CLIMB_ERROR * (climb - data.verticalSpeed), AIRSHIP_AUTOPILOT.MIN_PITCH, AIRSHIP_AUTOPILOT.MAX_PITCH);
    controls.pitch = airshipPitchCommand(data, pitch);

    // Speed through the throttle.
    const photo = cruising && context.game && context.game.photoMode === true;
    const wantedSpeed = (cruising && Number.isFinite(cruise.speed) ? cruise.speed : Number.isFinite(autopilot.speed) ? autopilot.speed : 0) * (photo ? AIRSHIP_AUTOPILOT.PHOTO_PACE : 1);
    const speedError = wantedSpeed - data.forwardAirspeed;
    memory.speedIntegral = clamp(memory.speedIntegral + speedError * AIRSHIP_AUTOPILOT.SPEED_I * dt, -AIRSHIP_AUTOPILOT.SPEED_INTEGRAL_LIMIT, AIRSHIP_AUTOPILOT.SPEED_INTEGRAL_LIMIT);
    controls.throttle = clamp(levelThrottle(model.profile, wantedSpeed, env.rho) + AIRSHIP_AUTOPILOT.SPEED_P * speedError + memory.speedIntegral, 0, 1);
    return true;
  },
});

registerAutopilotHandler('airship', airshipAutopilot);
