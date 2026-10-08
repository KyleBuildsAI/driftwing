// SimBalloon: the flight model of the hot air balloon (kind 'balloon').
//
// The balloon is a buoyant envelope of hot air with the basket hanging below it, integrated at the
// controller's fixed 120 Hz in SI units. Body axes: x right, y up, z aft (the basket's facing); the
// body origin is the envelope's centre of buoyancy (the pivot the whole rig swings about), and the
// basket hangs profile.rig.basketFloorY metres below it.
//
//   buoyancy     lift = (rho_ambient - rho_hot) x envelope volume x g. rho_ambient is the shared air
//                density model (env.rho = airDensity(y), src/env/atmosphere.js); the hot air inside
//                is at the ambient pressure, so rho_hot = rho_ambient x T_ambient / T_envelope, with
//                the ISA temperature profile for T_ambient (ambientTemperature below). The weight is
//                the structure's (envelope fabric, basket, burner, tanks, crew): the air inside is
//                counted in the lift. The envelope volume, centroid and areas come from the v1
//                balloon profile (src/world/balloonFamily.js)
//   envelope     one temperature state: the burner's heat reaches it through the plume (the flame's
//                gases rising to the crown and mixing, a few seconds), and it loses heat by natural
//                and forced convection, radiation, the parachute vent and the rotation vents (hot air
//                out of the crown, cold air in at the mouth), plus the adiabatic cooling of the
//                envelope gas as it climbs (9.8 K/km against the air's 6.5). The heat capacity is the
//                air inside plus the fabric, so the envelope responds slowly: with the 4-6 t that move
//                with the balloon (the structure, the air inside and the air it pushes aside), the
//                thermal lag from a burn to the climb is 20-30 s (tools/lab/balloon.mjs measures it)
//   motion       a point mass at the pivot under buoyancy, weight, the envelope's drag in the air
//                (horizontal: the side silhouette; vertical: the top view, blunter going down) and the
//                basket's ground contact. Horizontally the drag pulls the balloon to the wind's
//                speed at its height within a few tens of seconds: it drifts with the WindField
//   rotation     a rigid body about the pivot: the rotation vents (stick X and the pedals) yaw it
//                with jets of hot air at the equator; the structure hanging below swings as a pendulum
//                (about 9 s) when the pivot accelerates or the basket drags on the ground; air damping
//                on both, and a little turbulent yaw
//   ground       the basket's corners are skids on the shared height function (and float on water:
//                limits.waterLanding 'basket'); touchdowns bounce (the whole moving mass on a stiff
//                wicker and ground spring) and drag (the wind on the envelope against the basket's
//                friction) until the pilot vents. On the ground a held vent deflates the envelope
//                (lift and drag fade, the envelope collapses) and the burner inflates it again. A
//                ground start is tied down by its quick-release line (a spring to the anchor at the
//                basket), which lets go once the envelope carries TETHER.RELEASE_LIFT kg of lift
//
// Controls (ControlState, shaped by the control stages): throttle = the burner valve (0..1, the HOTAS
// lever or the keyboard's soft lever), roll + yaw = the rotation vents. After any reset the lever
// lights nothing until the pilot moves it (or it sits at idle): a lever left open by another craft,
// or the boot default, never opens the burner by itself (model.pilotLever). The craft abilities set
// craftState.burnerHeld (Space: full burner) and craftState.ventHeld (Shift+Space: the parachute
// vent). The balloon's assists and autopilot (below) command the burner, the vent and a burner limit
// through model.autoControls (read once per tick, then cleared); the flame is the strongest of the
// lever, the held burner and the automatic one, under the limit.
//
// FlightModel contract (docs/architecture.md) plus surfaces, flightData (the assists and autopilot
// read it), autoControls and dispose(). craftState (contract h.3): envelopeTemperature (deg C),
// ambientTemperature (deg C), burner (0..1, the flame), vent (0..1), altitudeHold (m or null, the
// assist's), windColumn (the craft ability's); additive: equilibriumTemperature (deg C, null when
// the balloon cannot float at this height), redLine (deg C), overTemperature, tempFlag (the envelope
// passed its red line this flight), rotationVent (-1..1), inflation (0..1), lift (net lift, kg),
// tethered (a ground start still on its quick-release line), landing (the copilot's assisted landing). A finite envelopeTemperature written from outside
// (a placement's or a test's craftState) is adopted on the next tick.
import * as THREE from 'three/webgpu';
import { DEG, clamp, headingFromVector, wrapDegrees } from '../core/util.js';
import { GRAVITY, SEA_LEVEL_DENSITY } from './aero.js';
import { airDensity } from './telemetry.js';
import { createGroundContact } from './groundContact.js';
import { createLandingMonitor } from './landing.js';
import { registerAssistCatalog, registerAssistHandler } from './assists.js';
import { registerAutopilotHandler } from './autopilot.js';
import { surfaceHeightAt } from './waterSurface.js';
import { envelopeGeometry } from '../world/balloonFamily.js';

/** Specific heat of air at constant pressure (J/(kg K)). */
export const AIR_CP = 1005;
export const KELVIN = 273.15;
const STEFAN_BOLTZMANN = 5.670374e-8;
/** The ISA temperature profile: sea level (K), lapse rate (K/m), and the tropopause (m) above which it stays. */
const ISA = Object.freeze({ SEA_LEVEL: 288.15, LAPSE: 0.0065, TROPOPAUSE: 11000 });
/** A ground placement starts this much below the equilibrium temperature (K): heavy enough to sit in a breeze. */
const GROUND_START_DEFICIT = 25;
/** The envelope never cools below the air by more than this (K, numerical floor). */
const BELOW_AMBIENT_LIMIT = 2;
const MAX_SPEED = 70;
/**
 * The collapse on the ground: the fabric's contacts drop out below CONTACTS_OFF inflation (back above
 * CONTACTS_ON), and below UPRIGHT_FROM an upright spring (N m/rad) and damper (N m s/rad) take over
 * from the buoyancy that held the rig up.
 */
const COLLAPSE = Object.freeze({ CONTACTS_OFF: 0.4, CONTACTS_ON: 0.6, UPRIGHT_FROM: 0.7, UPRIGHT_STIFFNESS: 400000, UPRIGHT_DAMPING: 250000 });
/** The quick-release line of a ground start: spring (N/m) and damping (N s/m) at the basket, released at this net lift (kg). */
const TETHER = Object.freeze({ SPRING: 20000, DAMPING: 9000, RELEASE_LIFT: 10 });
/** The burner lever counts after a reset once it moves this far, or when it sits at or below LEVER_IDLE. */
const LEVER_ARM_TRAVEL = 0.03;
const LEVER_IDLE = 0.02;
const MAX_ANGULAR_SPEED = 3;
/** On the ground the envelope can collapse completely (no volume, no lift). */
const MIN_INFLATION = 0;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** The ISA air temperature (K) at an altitude (m). */
export function ambientTemperature(altitude) {
  const height = Math.min(Math.max(Number.isFinite(altitude) ? altitude : 0, -500), ISA.TROPOPAUSE);
  return ISA.SEA_LEVEL - ISA.LAPSE * height;
}

/**
 * The envelope temperature (K) at which a balloon of `mass` kg (the structure) floats with an
 * envelope of `volume` m^3 in air of density rho and temperature ambient (K): lift = weight when
 * rho_hot = rho - mass / volume. Infinity when even infinitely hot air could not lift it.
 */
export function equilibriumTemperature(rho, ambient, volume, mass) {
  const displaced = rho * volume;
  if (!(displaced > mass)) return Infinity;
  return ambient / (1 - mass / displaced);
}

/**
 * The highest altitude (m) at which a balloon profile floats with its envelope `margin` K below the
 * red line (the ISA temperature and the shared density model), by bisection: Teq grows with height.
 */
export function floatCeiling(profile, margin = 5) {
  const volume = envelopeGeometry(profile.envelope.height).volume;
  const limit = profile.envelope.redLine + KELVIN - margin;
  const floats = (altitude) => equilibriumTemperature(airDensity(altitude), ambientTemperature(altitude), volume, profile.mass) <= limit;
  if (!floats(0)) return 0;
  let low = 0;
  let high = 30000;
  for (let iteration = 0; iteration < 40; iteration++) {
    const middle = (low + high) / 2;
    if (floats(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** Mass flow (kg/s) of hot air out of an opening of `area` m^2 at `height` m above the mouth (the stack pressure drives it). */
export function ventMassFlow(area, height, rhoAmbient, rhoHot, discharge) {
  const pressure = (rhoAmbient - rhoHot) * GRAVITY * height;
  if (!(pressure > 0) || !(area > 0) || !(rhoHot > 0)) return 0;
  return rhoHot * area * discharge * Math.sqrt((2 * pressure) / rhoHot);
}

/** Smooth deterministic noise in about [-1, 1] (turbulent yaw). */
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

function smooth01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapSignedDegrees(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// ============================================================================================
// THE ALTITUDE CONTROLLER (shared by the altitude-hold assist, the autopilot and the assisted
// landing). It knows the envelope's lag: from the vertical speed it wants it works out the envelope
// temperature that sustains it (the equilibrium plus the excess lift that balances the vertical
// drag, plus a share to accelerate), counts the heat still in the plume, and asks the burner for the
// power that reaches that temperature in a few seconds on top of the current losses, or the vent
// for heat it must shed faster than the envelope cools by itself. The burner then fires in blasts
// (a sigma-delta of the demand), as a pilot does, so it is quiet between them.
// ============================================================================================
export const HOLD = Object.freeze({
  /** Vertical speed (m/s) asked per metre of altitude error, and its limits. */
  ALTITUDE_GAIN: 0.03,
  MAX_CLIMB: 3,
  MAX_DESCENT: 2.5,
  /** The share of the vertical speed error closed by acceleration, per second. */
  ACCELERATION_SECONDS: 14,
  /** The burner closes the temperature error over this time (s). */
  TEMPERATURE_SECONDS: 8,
  /** The controller keeps the envelope this far (K) below its red line. */
  RED_LINE_MARGIN: 4,
  /** Only an excess this large (K) is vented; less is left to cool. */
  VENT_DEADBAND: 1.2,
  /** A blast starts once this much burner time (s at full flame) is owed. */
  BLAST_SECONDS: 2.5,
  /**
   * On release the hold captures where the balloon can stop (stoppingAltitude) plus this share of
   * the stopping distance (it brakes more gently than the full vent or burner), within LEAD_LIMIT m.
   */
  LEAD_SHARE: 0.25,
  LEAD_LIMIT: 400,
  /** The pilot is commanding the burner above this lever position. */
  LEVER_DEADBAND: 0.04,
  /** Hands off this long (s) before the hold captures. */
  CAPTURE_DELAY: 1,
  /** Arms once the basket is this high (m above the surface); no capture when descending below LANDING_RADAR. */
  ARM_RADAR: 25,
  LANDING_RADAR: 15,
  /** Terrain floor: the surface under the drift for the next FLOOR_SECONDS (every FLOOR_STEP), plus FLOOR_CLEARANCE (m, below the basket). */
  FLOOR_SECONDS: 30,
  FLOOR_STEP: 5,
  FLOOR_CLEARANCE: 35,
  FLOOR_REFRESH: 0.5,
  /** Rotation damping: full counter-vent at this yaw rate (deg/s). */
  ROTATION_DAMPING_RATE: 2.5,
  /** Autopilot heading: full rotation vent at this heading error (deg), braked by the yaw rate (per deg/s). */
  HEADING_ERROR_FULL: 35,
  HEADING_RATE_GAIN: 0.3,
  /** Over-temperature protection fades the burner out over this band (K) below the red line. */
  PROTECTION_BAND: 6,
});

/** Assisted landing (the copilot's "land"): descent rate (m/s, negative) by the basket's height above the surface. */
const LANDING = Object.freeze({ HIGH: 80, LOW: 15, HIGH_RATE: -2, LOW_RATE: -0.7, FINAL_RATE: -0.45, DEFLATE_SECONDS: 20, DEFLATED: 0.2 });

/** The vertical speed (m/s) toward an altitude target. */
export function verticalSpeedFor(target, data) {
  return clamp((target - data.altitude) * HOLD.ALTITUDE_GAIN, -HOLD.MAX_DESCENT, HOLD.MAX_CLIMB);
}

/**
 * The burner fraction (0..1, before the blasts) and the vent (0..1) that hold a vertical speed:
 * written into out { burner, vent, targetTemperature }.
 */
export function heatForVerticalSpeed(speed, data, out) {
  const drag = (speed >= 0 ? data.verticalDragUp : data.verticalDragDown) * speed * Math.abs(speed);
  const acceleration = (data.effectiveMass * (speed - data.verticalSpeed)) / HOLD.ACCELERATION_SECONDS;
  const lift = data.liftPerKelvin > 0 ? (drag + acceleration) / data.liftPerKelvin : 0;
  const target = clamp(data.equilibrium + lift, data.ambient + 2, data.redLine - HOLD.RED_LINE_MARGIN);
  const current = data.temperature + (data.heatCapacity > 0 ? data.plumeHeat / data.heatCapacity : 0);
  const power = (data.heatCapacity * (target - current)) / HOLD.TEMPERATURE_SECONDS + data.heatLoss + data.heatCapacity * (GRAVITY / AIR_CP) * data.verticalSpeed;
  out.targetTemperature = target;
  if (power >= 0) {
    out.burner = data.burnerPower > 0 ? clamp(power / data.burnerPower, 0, 1) : 0;
    out.vent = 0;
  } else {
    out.burner = 0;
    out.vent = current - target > HOLD.VENT_DEADBAND && data.ventPower > 0 ? clamp(-power / data.ventPower, 0, 1) : 0;
  }
  return out;
}

const STOP_STEP = 0.5;
const STOP_HORIZON = 240;

/**
 * Where the vertical motion can be stopped soonest (m): the altitude at which the vertical speed
 * reaches zero with the vent wide open (climbing) or the burner full on (descending), integrated
 * forward from the envelope's state (the heat still in the plume counts) in STOP_STEP steps.
 */
export function stoppingAltitude(data) {
  let altitude = data.altitude;
  let speed = data.verticalSpeed;
  if (!(Math.abs(speed) > 0.05) || !(data.heatCapacity > 0) || !(data.effectiveMass > 0)) return altitude;
  const climbing = speed > 0;
  const equilibrium = Math.min(data.equilibrium, data.redLine + 50);
  let temperature = data.temperature + data.plumeHeat / data.heatCapacity;
  const heating = (climbing ? -(data.heatLoss + data.ventPower) : data.burnerPower - data.heatLoss) / data.heatCapacity;
  for (let elapsed = 0; elapsed < STOP_HORIZON; elapsed += STOP_STEP) {
    const lift = data.liftPerKelvin * (temperature - equilibrium);
    const drag = (speed >= 0 ? data.verticalDragUp : data.verticalDragDown) * speed * Math.abs(speed);
    const next = speed + ((lift - drag) / data.effectiveMass) * STOP_STEP;
    altitude += 0.5 * (speed + next) * STOP_STEP;
    if (climbing ? next <= 0 : next >= 0) return altitude;
    speed = next;
    temperature = clamp(temperature + (heating - (GRAVITY / AIR_CP) * speed) * STOP_STEP, data.ambient, data.redLine);
  }
  return altitude;
}

/** The burner in blasts: demand (0..1) accumulates as owed burner time; a blast pays it back at full flame. */
export function burnerBlast(memory, demand, dt) {
  memory.owed = clamp(memory.owed + clamp(demand, 0, 1) * dt, -1, HOLD.BLAST_SECONDS * 3);
  if (!memory.firing && memory.owed >= HOLD.BLAST_SECONDS) memory.firing = true;
  if (memory.firing) {
    memory.owed -= dt;
    if (memory.owed <= 0) memory.firing = false;
  }
  return memory.firing ? 1 : 0;
}

/** The lowest pivot altitude (m) that keeps the basket FLOOR_CLEARANCE above the surface under the drift. */
function terrainFloor(env, data, position, velocity) {
  let highest = -Infinity;
  for (let seconds = 0; seconds <= HOLD.FLOOR_SECONDS + 1e-6; seconds += HOLD.FLOOR_STEP) {
    highest = Math.max(highest, surfaceHeightAt(env, position.x + velocity.x * seconds, position.z + velocity.z * seconds));
  }
  return highest + HOLD.FLOOR_CLEARANCE - data.basketFloorY;
}

function createHoldMemory() {
  return { resetCount: -1, target: null, quiet: 0, armed: false, owed: 0, firing: false, floor: -Infinity, floorTimer: 0, landedSeconds: 0, touchedDown: false };
}

const holdScratch = { burner: 0, vent: 0, targetTemperature: 0 };

/** Refreshes memory.floor (every FLOOR_REFRESH s) when the environment can answer. */
function refreshFloor(memory, model, env, dt) {
  memory.floorTimer -= dt;
  if (memory.floorTimer > 0 || !env || typeof env.groundHeight !== 'function') return;
  memory.floorTimer = HOLD.FLOOR_REFRESH;
  memory.floor = terrainFloor(env, model.flightData, model.state.position, model.state.velocity);
}

/** Flies a vertical speed: the burner (in blasts) and the vent, weighted, into model.autoControls. */
function flyVerticalSpeed(speed, model, memory, dt, weight) {
  heatForVerticalSpeed(speed, model.flightData, holdScratch);
  const blast = burnerBlast(memory, holdScratch.burner * weight, dt);
  model.autoControls.burner = Math.max(model.autoControls.burner, blast);
  model.autoControls.vent = Math.max(model.autoControls.vent, holdScratch.vent * weight);
}

// ============================================================================================
// ASSISTS (kind 'balloon'): registered with the shared assist stage (src/flight/assists.js)
//   100 %  over-temperature protection, rotation damping, altitude hold (auto-burner)
//    50 %  over-temperature protection and rotation damping
//     0 %  raw: the envelope can pass its red line (the temperature flag drops), nothing damps the
//          rotation and nothing holds the height
// The assisted landing (craftState.landing, the copilot's "land") is a command, flown at any level.
// ============================================================================================
export const BALLOON_ASSIST_CATALOG = Object.freeze([
  Object.freeze({ key: 'temperatureProtection', name: 'envelope over-temperature protection', from: 0, full: 0.5 }),
  Object.freeze({ key: 'rotationDamping', name: 'rotation damping', from: 0, full: 0.5 }),
  Object.freeze({ key: 'altitudeHold', name: 'altitude hold (auto-burner)', from: 0.5, full: 0.75 }),
]);

const balloonAssistHandler = Object.freeze({
  createMemory: createHoldMemory,

  apply(controls, context, weights, memory) {
    const model = context.model;
    const data = model.flightData;
    const env = context.env;
    const craftState = env && env.craftState ? env.craftState : null;
    const dt = context.dt;
    if (!craftState) return;
    const autopilotFlying = Boolean(context.autopilot && context.autopilot.enabled);
    const pilotBurning = craftState.burnerHeld === true || model.pilotLever(controls.throttle) > HOLD.LEVER_DEADBAND;
    const pilotVenting = craftState.ventHeld === true;
    const pilotRotating = Math.abs(finiteOr(controls.roll, 0) + finiteOr(controls.yaw, 0)) > 0.05;
    refreshFloor(memory, model, env, dt);

    if (weights.temperatureProtection > 0) {
      const band = HOLD.PROTECTION_BAND;
      const limit = 1 - weights.temperatureProtection * smooth01((data.temperature - (data.redLine - band)) / band);
      model.autoControls.burnerLimit = Math.min(model.autoControls.burnerLimit, limit);
    }
    if (weights.rotationDamping > 0 && !pilotRotating && !autopilotFlying) {
      controls.roll = clamp(finiteOr(controls.roll, 0) - weights.rotationDamping * clamp(data.yawRate / HOLD.ROTATION_DAMPING_RATE, -1, 1), -1, 1);
    }

    // The assisted landing: a descent schedule by height, then the vent until the envelope is down.
    if (craftState.landing === true) {
      if (pilotBurning || pilotVenting || autopilotFlying) {
        craftState.landing = false;
      } else {
        memory.target = null;
        craftState.altitudeHold = null;
        flyLanding(model, memory, dt, craftState);
        return;
      }
    }

    if (autopilotFlying) {
      memory.target = null;
      craftState.altitudeHold = null;
      return;
    }
    if (data.onGround) {
      memory.target = null;
      memory.armed = false;
    } else if (data.radarAltitude > HOLD.ARM_RADAR) {
      memory.armed = true;
    }
    const hold = weights.altitudeHold;
    if (!(hold > 0) || pilotBurning || pilotVenting) {
      memory.target = null;
      memory.quiet = 0;
    } else if (memory.target === null) {
      memory.quiet += dt;
      const landingApproach = data.radarAltitude < HOLD.LANDING_RADAR && data.verticalSpeed < 0;
      if (memory.armed && memory.quiet >= HOLD.CAPTURE_DELAY && !data.onGround && !landingApproach) {
        const stop = stoppingAltitude(data);
        memory.target = data.altitude + clamp((stop - data.altitude) * (1 + HOLD.LEAD_SHARE), -HOLD.LEAD_LIMIT, HOLD.LEAD_LIMIT);
        memory.owed = 0;
        memory.firing = false;
      }
    }
    if (memory.target !== null) {
      // Rising ground under the drift raises the hold with it.
      const target = Math.max(memory.target, memory.floor);
      flyVerticalSpeed(verticalSpeedFor(target, data), model, memory, dt, hold);
    }
    craftState.altitudeHold = memory.target === null ? null : Math.max(memory.target, memory.floor);
  },
});

function flyLanding(model, memory, dt, craftState) {
  const data = model.flightData;
  if (data.onGround || memory.touchedDown) {
    // Down (hops included): the vent wide open until the envelope has collapsed, or DEFLATE_SECONDS on the ground.
    memory.touchedDown = true;
    if (data.onGround) memory.landedSeconds += dt;
    model.autoControls.vent = 1;
    if (data.inflation <= LANDING.DEFLATED || memory.landedSeconds >= LANDING.DEFLATE_SECONDS) {
      craftState.landing = false;
      memory.touchedDown = false;
      memory.landedSeconds = 0;
    }
    return;
  }
  memory.landedSeconds = 0;
  const radar = data.radarAltitude;
  const rate = radar > LANDING.HIGH ? LANDING.HIGH_RATE
    : radar > LANDING.LOW ? LANDING.LOW_RATE + ((LANDING.HIGH_RATE - LANDING.LOW_RATE) * (radar - LANDING.LOW)) / (LANDING.HIGH - LANDING.LOW)
      : LANDING.FINAL_RATE;
  flyVerticalSpeed(rate, model, memory, dt, 1);
}

registerAssistCatalog('balloon', BALLOON_ASSIST_CATALOG);
registerAssistHandler('balloon', balloonAssistHandler);

// ============================================================================================
// AUTOPILOT (kind 'balloon'): the autopilot's altitude through the same controller (raised over the
// terrain under the drift), and its heading as the basket's facing through the rotation vents. A
// balloon goes where the wind at its height goes, so the heading turns the basket, not the track; the
// copilot's layer steering picks the height whose wind goes the right way.
// ============================================================================================
const balloonAutopilot = Object.freeze({
  createMemory: createHoldMemory,

  apply(controls, context, memory) {
    const autopilot = context.autopilot;
    if (!autopilot || !autopilot.enabled) return false;
    const model = context.model;
    const data = model.flightData;
    const dt = context.dt;
    refreshFloor(memory, model, context.env, dt);
    const target = Math.max(finiteOr(autopilot.altitude, data.altitude), memory.floor);
    flyVerticalSpeed(verticalSpeedFor(target, data), model, memory, dt, 1);
    const error = wrapSignedDegrees(finiteOr(autopilot.heading, data.heading) - data.heading);
    controls.roll = clamp(error / HOLD.HEADING_ERROR_FULL - HOLD.HEADING_RATE_GAIN * data.yawRate, -1, 1);
    controls.yaw = 0;
    return true;
  },
});

registerAutopilotHandler('balloon', balloonAutopilot);

// ============================================================================================
// MODEL
// ============================================================================================
export function createSimBalloonModel({ profile, craft, bus, craftState: initialCraftState = {} }) {
  const limits = craft && craft.limits ? craft.limits : {};
  const craftId = craft && craft.id ? craft.id : 'balloon';
  const envelopeProfile = profile.envelope;
  const burnerProfile = profile.burner;
  const ventProfile = profile.vent;
  const rotationProfile = profile.rotationVents;
  const rig = profile.rig;
  const geometry = envelopeGeometry(envelopeProfile.height);
  const structureMass = profile.mass;
  const redLine = envelopeProfile.redLine + KELVIN;
  const maxTemperature = envelopeProfile.maxModelTemperature + KELVIN;
  const burnerPower = burnerProfile.power * burnerProfile.efficiency;
  /** The structure's centre of mass below the pivot (body), for the pendulum. */
  const structureCentre = new THREE.Vector3().fromArray(profile.structureCentre);
  const inertia = new THREE.Vector3(profile.inertia.tilt, profile.inertia.yaw, profile.inertia.tilt);
  /** Height of the parachute vent and of the rotation vents above the mouth (m), and the vents' arm about the axis. */
  const crownHeight = envelopeProfile.height;
  const rotationHeight = envelopeProfile.height * rotationProfile.heightShare;
  const rotationArm = profile.rotationVents.arm;
  const origin = new THREE.Vector3();

  let craftState = initialCraftState;

  // ---- State ---------------------------------------------------------------------------------------
  const state = {
    /** The pivot (the envelope's centre of buoyancy) = the mesh origin (world). */
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    /** Body rates (rad/s): x tilt forward, y yaw left, z tilt right. */
    angularVelocity: new THREE.Vector3(),
  };
  const envelope = {
    temperature: ambientTemperature(0) + 60,
    /** Burner heat on its way to the envelope (J). */
    plumeHeat: 0,
    /** 1 = fully inflated; falls on the ground with the vent open. */
    inflation: 1,
    /** The flame (0..1) and the valve that feeds it. */
    burner: 0,
    valve: 0,
    vent: 0,
    rotation: 0,
  };
  const contactMass = structureMass + geometry.volume;
  const inflatedContact = createGroundContact(profile.contacts, { centerOfMass: origin, floats: true, mass: contactMass });
  // A collapsed envelope lies on the ground as loose fabric: only the basket's points touch then.
  const collapsedContact = createGroundContact(profile.contacts.filter((contact) => contact.kind !== 'body'), { centerOfMass: origin, floats: true, mass: contactMass });
  let groundContact = inflatedContact;
  const landing = createLandingMonitor({ bus, craftId, limits });
  /** What the assists and the autopilot command this tick (cleared after every step). */
  const autoControls = { burner: 0, vent: 0, burnerLimit: 1 };
  /** This flight: where it left the ground and how high it went (journal stats at the touchdown). */
  const flight = { launchX: 0, launchZ: 0, maxAltitude: -Infinity, airborneSeconds: 0 };
  let time = 0;
  let resetCount = 0;
  let alignToAir = false;
  let writtenTemperature = NaN;
  let tempFlag = false;
  /** The quick-release line: active on a ground start until the envelope lifts; anchored at (x, z). */
  const tether = { active: false, x: 0, z: 0 };
  /** The lever's position at the first tick after a reset, and whether the pilot has taken it since. */
  let leverBaseline = NaN;
  let leverArmed = false;

  const surfaces = { aileron: 0, elevator: 0, rudder: 0, propSpeed: 0, groundSpeed: 0 };

  const flightData = {
    altitude: 0,
    /** The basket floor above the ground or water below it (m). */
    radarAltitude: Infinity,
    basketFloorY: rig.basketFloorY,
    verticalSpeed: 0,
    groundSpeed: 0,
    airspeed: 0,
    heading: 0,
    /** deg/s, positive turning right (heading increasing). */
    yawRate: 0,
    tilt: 0,
    onGround: false,
    /** Envelope state (K, W, J/K, N/K, kg). */
    temperature: envelope.temperature,
    ambient: ambientTemperature(0),
    equilibrium: Infinity,
    redLine,
    heatCapacity: 1,
    heatLoss: 0,
    plumeHeat: 0,
    burnerPower,
    ventPower: 0,
    liftPerKelvin: 0,
    effectiveMass: structureMass,
    verticalDragUp: 0,
    verticalDragDown: 0,
    inflation: 1,
    netLift: 0,
    resetCount: 0,
    mass: structureMass,
    // Read by the shared stages (fixed-wing fields they look for), so they degrade gracefully.
    hasEngine: true,
    engineRunning: true,
    gLimit: Number.isFinite(limits.gLimit) ? limits.gLimit : 3,
    vne: Number.isFinite(limits.vne) ? limits.vne : 60,
  };

  // ---- Scratch ------------------------------------------------------------------------------------------
  const relativeAir = new THREE.Vector3();
  const forceWorld = new THREE.Vector3();
  const groundForce = new THREE.Vector3();
  const groundMoment = new THREE.Vector3();
  const acceleration = new THREE.Vector3();
  const torque = new THREE.Vector3();
  const torqueWorld = new THREE.Vector3();
  const lever = new THREE.Vector3();
  const pendulumForce = new THREE.Vector3();
  const angularMomentum = new THREE.Vector3();
  const gyro = new THREE.Vector3();
  const rotationStep = new THREE.Quaternion();
  const inverseQuaternion = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const levelEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const contactBody = { position: state.position, velocity: state.velocity, quaternion: state.quaternion, angularVelocity: state.angularVelocity };
  const contactInputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };

  // ---- Envelope physics ------------------------------------------------------------------------------
  /** Fabric area exposed (m^2): the full envelope inflated, shrinking as it collapses. */
  function fabricArea() {
    return geometry.surfaceArea * Math.cbrt(envelope.inflation * envelope.inflation);
  }

  /** Convective (natural plus forced by the relative air) and radiative loss through the fabric (W). */
  function fabricLoss(temperature, ambient, airSpeed) {
    const area = fabricArea();
    const coefficient = envelopeProfile.heatTransfer + envelopeProfile.forcedConvection * airSpeed;
    const convection = coefficient * area * (temperature - ambient);
    const radiation = envelopeProfile.emissivity * STEFAN_BOLTZMANN * area * (temperature ** 4 - ambient ** 4);
    return convection + radiation;
  }

  /**
   * The burner lever the pilot is really using (0..1): after a reset it counts only once it has
   * moved LEVER_ARM_TRAVEL from where it was, or when it starts at idle.
   */
  function pilotLever(value) {
    const lever = clamp(finiteOr(value, 0), 0, 1);
    if (!leverArmed) {
      if (!Number.isFinite(leverBaseline)) leverBaseline = lever;
      if (lever <= LEVER_IDLE || Math.abs(lever - leverBaseline) > LEVER_ARM_TRAVEL) leverArmed = true;
    }
    return leverArmed ? lever : 0;
  }

  /** Reads the commands of this tick: the burner valve and flame, the vent, the rotation vents. */
  function updateCommands(controls, dt) {
    const lever = pilotLever(controls.throttle);
    const held = craftState && craftState.burnerHeld === true ? 1 : 0;
    const automatic = clamp(finiteOr(autoControls.burner, 0), 0, 1);
    envelope.valve = Math.min(Math.max(lever, held, automatic), clamp(finiteOr(autoControls.burnerLimit, 1), 0, 1));
    const lag = envelope.valve > envelope.burner ? burnerProfile.ignition : burnerProfile.ignition * 0.6;
    envelope.burner += (envelope.valve - envelope.burner) * (1 - Math.exp(-dt / lag));
    if (envelope.burner < 1e-4) envelope.burner = 0;
    const vent = Math.max(craftState && craftState.ventHeld === true ? 1 : 0, clamp(finiteOr(autoControls.vent, 0), 0, 1));
    envelope.vent = moveToward(envelope.vent, vent, ventProfile.rate * dt);
    const rotation = clamp(finiteOr(controls.roll, 0) + finiteOr(controls.yaw, 0), -1, 1);
    envelope.rotation = moveToward(envelope.rotation, rotation, rotationProfile.rate * dt);
  }

  /**
   * One tick of the envelope's heat: the burner through the plume, the losses, the adiabatic
   * cooling with the climb; and the inflation on the ground. Returns nothing; fills flightData.
   */
  function updateEnvelope(dt, rho, ambient, airSpeed) {
    const volume = geometry.volume * envelope.inflation;
    const rhoHot = (rho * ambient) / envelope.temperature;
    const capacity = rhoHot * volume * AIR_CP + envelopeProfile.fabricHeatCapacity;
    envelope.plumeHeat += envelope.burner * burnerPower * dt;
    const arriving = envelope.plumeHeat * (1 - Math.exp(-dt / burnerProfile.plumeSeconds));
    envelope.plumeHeat -= arriving;
    const excess = envelope.temperature - ambient;
    const ventFlow = ventMassFlow(ventProfile.area * envelope.vent, crownHeight, rho, rhoHot, ventProfile.discharge);
    const rotationFlow = ventMassFlow(rotationProfile.area * Math.abs(envelope.rotation), rotationHeight, rho, rhoHot, rotationProfile.discharge);
    const loss = fabricLoss(envelope.temperature, ambient, airSpeed) + (ventFlow + rotationFlow) * AIR_CP * excess;
    const adiabatic = envelope.inflation > 0.5 ? (GRAVITY / AIR_CP) * state.velocity.y * dt : 0;
    envelope.temperature += (arriving - loss * dt) / capacity - adiabatic;
    envelope.temperature = clamp(envelope.temperature, ambient - BELOW_AMBIENT_LIMIT, maxTemperature);
    if (envelope.temperature > redLine) tempFlag = true;

    // On the ground a held vent lets the envelope collapse; the burner (or a hop) fills it again.
    const grounded = groundContact.report.onGround;
    if (grounded && envelope.vent > 0.5) envelope.inflation -= (envelope.vent * dt) / profile.deflation.ventSeconds;
    if (envelope.burner > 0.2) envelope.inflation += (envelope.burner * dt) / profile.deflation.inflateSeconds;
    else if (!grounded) envelope.inflation += dt / profile.deflation.inflateSeconds;
    envelope.inflation = clamp(envelope.inflation, MIN_INFLATION, 1);
    // The fabric's contact points count only while the envelope stands (with some hysteresis).
    const collapsed = groundContact === collapsedContact;
    if (!collapsed && envelope.inflation < COLLAPSE.CONTACTS_OFF) switchContact(collapsedContact);
    else if (collapsed && envelope.inflation > COLLAPSE.CONTACTS_ON) switchContact(inflatedContact);

    // What the controllers need: the full-vent loss, the lift per kelvin, the equilibrium.
    flightData.heatCapacity = capacity;
    flightData.heatLoss = loss;
    flightData.plumeHeat = envelope.plumeHeat;
    flightData.ventPower = ventMassFlow(ventProfile.area, crownHeight, rho, rhoHot, ventProfile.discharge) * AIR_CP * Math.max(excess, 0);
    flightData.liftPerKelvin = volume > 0 ? (rho * ambient * volume * GRAVITY) / (envelope.temperature * envelope.temperature) : 0;
    flightData.equilibrium = volume > 0 ? equilibriumTemperature(rho, ambient, volume, structureMass) : Infinity;
  }

  /** Swaps the contact set (the basket stays where it is: no touchdown is reported for the swap). */
  function switchContact(next) {
    const onGround = groundContact.report.onGround;
    groundContact = next;
    groundContact.reset(onGround);
  }

  // ---- Rotation ------------------------------------------------------------------------------------
  function integrateRotation(dt, rho, rhoHot, turbulence) {
    const omega = state.angularVelocity;
    // The structure swings about the pivot: gravity less the pivot's own acceleration, at its centre.
    lever.copy(structureCentre).applyQuaternion(state.quaternion);
    pendulumForce.set(-acceleration.x, -GRAVITY - acceleration.y, -acceleration.z).multiplyScalar(structureMass);
    torqueWorld.crossVectors(lever, pendulumForce);
    inverseQuaternion.copy(state.quaternion).invert();
    torque.copy(torqueWorld).applyQuaternion(inverseQuaternion).add(groundMoment);
    // Rotation vents: two jets at the equator, thrust 2 Cd A dp each pair; positive turns right (-y).
    const pressure = Math.max(0, (rho - rhoHot) * GRAVITY * rotationHeight) * envelope.inflation;
    const jet = 2 * rotationProfile.discharge * rotationProfile.area * pressure;
    torque.y -= envelope.rotation * jet * rotationArm;
    torque.y += turbulence * profile.damping.turbulentYaw * noise(time, 0.7, 0.05);
    // A collapsing envelope no longer holds the rig up from above: the basket stands on its own
    // (an upright spring and damper growing as the envelope empties), the fabric lies around it.
    const slack = 1 - smooth01(envelope.inflation / COLLAPSE.UPRIGHT_FROM);
    if (slack > 0) {
      up.set(0, 1, 0).applyQuaternion(state.quaternion);
      torqueWorld.crossVectors(up, WORLD_UP).multiplyScalar(COLLAPSE.UPRIGHT_STIFFNESS * slack);
      torque.add(torqueWorld.applyQuaternion(inverseQuaternion));
      torque.x -= COLLAPSE.UPRIGHT_DAMPING * slack * omega.x;
      torque.z -= COLLAPSE.UPRIGHT_DAMPING * slack * omega.z;
    }
    // Air damping.
    const damping = profile.damping;
    torque.x -= damping.tilt * omega.x;
    torque.z -= damping.tilt * omega.z;
    torque.y -= (damping.yawLinear + damping.yawQuadratic * Math.abs(omega.y)) * omega.y;
    angularMomentum.set(inertia.x * omega.x, inertia.y * omega.y, inertia.z * omega.z);
    gyro.crossVectors(omega, angularMomentum);
    torque.sub(gyro);
    omega.x += (torque.x / inertia.x) * dt;
    omega.y += (torque.y / inertia.y) * dt;
    omega.z += (torque.z / inertia.z) * dt;
    if (omega.lengthSq() > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) omega.setLength(MAX_ANGULAR_SPEED);
    const angle = omega.length() * dt;
    if (angle > 1e-12) {
      rotationStep.setFromAxisAngle(lever.copy(omega).normalize(), angle);
      state.quaternion.multiply(rotationStep).normalize();
    }
  }

  /**
   * The quick-release line holds the basket over its anchor (a horizontal spring and damper at the
   * basket, into groundForce and groundMoment) until the envelope lifts RELEASE_LIFT kg.
   */
  function applyTether(lift) {
    if (lift / GRAVITY - structureMass > TETHER.RELEASE_LIFT) {
      tether.active = false;
      if (bus) bus.emit('notify', { text: 'Quick release away. We are flying.', kind: 'info' });
      return;
    }
    lever.set(0, rig.basketFloorY, 0).applyQuaternion(state.quaternion);
    // The basket's velocity: the pivot's plus the swing.
    pendulumForce.set(0, 0, 0).crossVectors(state.angularVelocity, torqueWorld.set(0, rig.basketFloorY, 0)).applyQuaternion(state.quaternion).add(state.velocity);
    const pullX = -TETHER.SPRING * (state.position.x + lever.x - tether.x) - TETHER.DAMPING * pendulumForce.x;
    const pullZ = -TETHER.SPRING * (state.position.z + lever.z - tether.z) - TETHER.DAMPING * pendulumForce.z;
    groundForce.x += pullX;
    groundForce.z += pullZ;
    // Its moment about the pivot (body axes).
    torqueWorld.crossVectors(lever, pendulumForce.set(pullX, 0, pullZ));
    inverseQuaternion.copy(state.quaternion).invert();
    groundMoment.add(torqueWorld.applyQuaternion(inverseQuaternion));
  }

  // ---- The tick ------------------------------------------------------------------------------------
  /** A finite envelopeTemperature written into craftState from outside (a placement, a test) is adopted. */
  function adoptExternalTemperature(ambient) {
    if (!craftState) return;
    const written = craftState.envelopeTemperature;
    if (!Number.isFinite(written) || Math.abs(written - writtenTemperature) < 1e-9) return;
    envelope.temperature = clamp(written + KELVIN, ambient - BELOW_AMBIENT_LIMIT, maxTemperature);
    envelope.plumeHeat = 0;
  }

  function step(dt, controls, env) {
    if (!(dt > 0)) return;
    time += dt;
    if (env.craftState && env.craftState !== craftState) craftState = env.craftState;
    const rho = Number.isFinite(env.rho) ? env.rho : SEA_LEVEL_DENSITY;
    const ambient = ambientTemperature(state.position.y);
    adoptExternalTemperature(ambient);
    const wind = env.wind && env.wind.vel ? env.wind.vel : null;
    const turbulence = env.wind && Number.isFinite(env.wind.turbulence) ? env.wind.turbulence : 0;
    if (alignToAir) {
      // An airborne reset starts drifting with the air at its height.
      alignToAir = false;
      if (wind) {
        state.velocity.x = wind.x;
        state.velocity.z = wind.z;
      }
    }
    relativeAir.copy(state.velocity);
    if (wind) relativeAir.sub(wind);
    const airSpeed = relativeAir.length();

    updateCommands(controls, dt);
    updateEnvelope(dt, rho, ambient, airSpeed);

    // Forces on the pivot (world): net buoyancy, the structure's weight, the drag, the ground.
    const volume = geometry.volume * envelope.inflation;
    const rhoHot = (rho * ambient) / envelope.temperature;
    const airMass = rhoHot * volume;
    const lift = (rho - rhoHot) * volume * GRAVITY;
    const effectiveMass = structureMass + airMass + envelopeProfile.addedMass * rho * volume;
    const areaShare = Math.cbrt(envelope.inflation * envelope.inflation);
    const sideArea = geometry.sideArea * areaShare + rig.basketSideArea;
    const topArea = geometry.topArea * areaShare + rig.basketTopArea;
    const horizontalSpeed = Math.hypot(relativeAir.x, relativeAir.z);
    const horizontalDrag = 0.5 * rho * envelopeProfile.cdSide * sideArea * horizontalSpeed;
    const verticalCd = relativeAir.y > 0 ? envelopeProfile.cdUp : envelopeProfile.cdDown;
    forceWorld.set(-horizontalDrag * relativeAir.x, lift - structureMass * GRAVITY - 0.5 * rho * verticalCd * topArea * Math.abs(relativeAir.y) * relativeAir.y, -horizontalDrag * relativeAir.z);
    groundForce.set(0, 0, 0);
    groundMoment.set(0, 0, 0);
    groundContact.evaluate(contactBody, contactInputs, env, dt, groundForce, groundMoment);
    const report = groundContact.report;
    if (tether.active) applyTether(lift);
    forceWorld.add(groundForce);
    acceleration.copy(forceWorld).divideScalar(effectiveMass);

    // Translation (semi-implicit Euler), then the rotation about the pivot.
    state.velocity.addScaledVector(acceleration, dt);
    if (state.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) state.velocity.setLength(MAX_SPEED);
    state.position.addScaledVector(state.velocity, dt);
    integrateRotation(dt, rho, rhoHot, turbulence);

    updateFlightData(env, dt, rho, ambient, effectiveMass, lift, airSpeed);
    const landed = landing.observe(report, { dt, agl: flightData.radarAltitude, position: state.position });
    updateFlightRecord(report, landed, dt);
    writeCraftState(ambient, lift);
    autoControls.burner = 0;
    autoControls.vent = 0;
    autoControls.burnerLimit = 1;
  }

  function updateFlightData(env, dt, rho, ambient, effectiveMass, lift, airSpeed) {
    forward.set(0, 0, -1).applyQuaternion(state.quaternion);
    up.set(0, 1, 0).applyQuaternion(state.quaternion);
    const basketY = state.position.y + rig.basketFloorY * up.y;
    flightData.altitude = state.position.y;
    flightData.radarAltitude = basketY - surfaceHeightAt(env, state.position.x, state.position.z);
    flightData.verticalSpeed = state.velocity.y;
    flightData.groundSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    flightData.airspeed = airSpeed;
    if (Math.hypot(forward.x, forward.z) > 1e-4) flightData.heading = headingFromVector(forward.x, forward.z);
    flightData.yawRate = -state.angularVelocity.y / DEG;
    flightData.tilt = Math.acos(clamp(up.dot(WORLD_UP), -1, 1)) / DEG;
    flightData.onGround = groundContact.report.onGround;
    flightData.temperature = envelope.temperature;
    flightData.ambient = ambient;
    flightData.effectiveMass = effectiveMass;
    const areaShare = Math.cbrt(envelope.inflation * envelope.inflation);
    const topArea = geometry.topArea * areaShare + rig.basketTopArea;
    flightData.verticalDragUp = 0.5 * rho * envelopeProfile.cdUp * topArea;
    flightData.verticalDragDown = 0.5 * rho * envelopeProfile.cdDown * topArea;
    flightData.inflation = envelope.inflation;
    flightData.netLift = lift / GRAVITY - structureMass;
    surfaces.aileron = envelope.rotation;
    surfaces.elevator = 0;
    surfaces.rudder = 0;
    surfaces.propSpeed = 0;
    surfaces.groundSpeed = groundContact.report.onGround ? flightData.groundSpeed : 0;
  }

  /** The flight's journal stats: emitted at every graded touchdown (and when the craft is put away mid-flight). */
  function updateFlightRecord(report, landed, dt) {
    if (!report.onGround) {
      if (flight.airborneSeconds === 0 && !Number.isFinite(flight.maxAltitude)) {
        flight.launchX = state.position.x;
        flight.launchZ = state.position.z;
      }
      flight.airborneSeconds += dt;
      flight.maxAltitude = Math.max(flight.maxAltitude, state.position.y);
    }
    if (landed) {
      emitFlightStats(true);
      startFlightRecord();
    }
  }

  function startFlightRecord() {
    flight.launchX = state.position.x;
    flight.launchZ = state.position.z;
    flight.maxAltitude = -Infinity;
    flight.airborneSeconds = 0;
  }

  function emitFlightStats(landed) {
    if (!bus || typeof bus.emitTyped !== 'function') return;
    if (landed) bus.emitTyped('journalStat', { key: 'balloonLandings', value: 1, op: 'add' });
    if (!(flight.airborneSeconds > 0) || !Number.isFinite(flight.maxAltitude)) return;
    bus.emitTyped('journalStat', { key: 'balloonMaxAltitude', value: Math.round(flight.maxAltitude), op: 'max' });
    bus.emitTyped('journalStat', { key: 'balloonLongestDrift', value: Math.round(Math.hypot(state.position.x - flight.launchX, state.position.z - flight.launchZ)), op: 'max' });
  }

  function writeCraftState(ambient, lift) {
    if (!craftState) return;
    craftState.envelopeTemperature = envelope.temperature - KELVIN;
    writtenTemperature = craftState.envelopeTemperature;
    craftState.ambientTemperature = ambient - KELVIN;
    craftState.equilibriumTemperature = Number.isFinite(flightData.equilibrium) ? flightData.equilibrium - KELVIN : null;
    craftState.redLine = envelopeProfile.redLine;
    craftState.overTemperature = envelope.temperature > redLine;
    craftState.tempFlag = tempFlag;
    craftState.burner = envelope.burner;
    craftState.vent = envelope.vent;
    craftState.rotationVent = envelope.rotation;
    craftState.inflation = envelope.inflation;
    craftState.lift = Number.isFinite(lift) ? lift / GRAVITY - structureMass : 0;
    craftState.tethered = tether.active;
  }

  // ============================================================================================
  // RESET / TELEMETRY / SNAPSHOTS
  // ============================================================================================
  /**
   * Any teleport: upright on the pose's heading, at rest in the air or on the ground. An airborne
   * reset floats at the equilibrium temperature for its height and drifts with the air from its
   * first tick; a ground reset sits GROUND_START_DEFICIT below it, inflated and ready to burn.
   */
  function reset(pose = {}) {
    if (pose.position) state.position.copy(pose.position);
    if (pose.velocity) state.velocity.copy(pose.velocity);
    else state.velocity.set(0, 0, 0);
    let heading = flightData.heading;
    if (pose.quaternion) {
      forward.set(0, 0, -1).applyQuaternion(pose.quaternion);
      if (Math.hypot(forward.x, forward.z) > 1e-4) heading = headingFromVector(forward.x, forward.z);
    }
    state.quaternion.setFromEuler(levelEuler.set(0, -wrapDegrees(heading) * DEG, 0, 'YXZ'));
    state.angularVelocity.set(0, 0, 0);
    const onGround = pose.onGround === true;
    const ambient = ambientTemperature(state.position.y);
    const rho = airDensity(state.position.y);
    const equilibrium = equilibriumTemperature(rho, ambient, geometry.volume, structureMass);
    const neutral = Math.min(equilibrium, redLine);
    envelope.temperature = onGround ? Math.max(ambient, neutral - GROUND_START_DEFICIT) : neutral;
    envelope.plumeHeat = 0;
    envelope.inflation = 1;
    envelope.burner = 0;
    envelope.valve = 0;
    envelope.vent = 0;
    envelope.rotation = 0;
    tempFlag = false;
    tether.active = onGround;
    tether.x = state.position.x;
    tether.z = state.position.z;
    alignToAir = !onGround;
    leverBaseline = NaN;
    leverArmed = false;
    autoControls.burner = 0;
    autoControls.vent = 0;
    autoControls.burnerLimit = 1;
    groundContact = inflatedContact;
    groundContact.reset(onGround);
    collapsedContact.reset(onGround);
    landing.reset(onGround);
    startFlightRecord();
    if (!onGround) flight.maxAltitude = state.position.y;
    resetCount++;
    flightData.resetCount = resetCount;
    flightData.heading = wrapDegrees(heading);
    flightData.onGround = onGround;
    flightData.temperature = envelope.temperature;
    flightData.ambient = ambient;
    flightData.equilibrium = equilibrium;
    if (craftState) {
      craftState.burnerHeld = false;
      craftState.ventHeld = false;
      craftState.landing = false;
      craftState.altitudeHold = null;
    }
    flightData.inflation = 1;
    writeCraftState(ambient, (rho - (rho * ambient) / envelope.temperature) * geometry.volume * GRAVITY);
    return true;
  }

  /** Fills the state.flight fields this model owns (the controller writes pose, wind and speeds). */
  function writeTelemetry(telemetry) {
    telemetry.aoa = 0;
    telemetry.sideslip = 0;
    telemetry.throttle = envelope.burner;
    telemetry.afterburner = false;
    telemetry.engineOn = true;
    telemetry.rpm = envelope.burner;
    telemetry.rotorRpm = 0;
    telemetry.torque = 0;
    telemetry.flaps = 0;
    telemetry.flapNotch = 0;
    telemetry.gear.retractable = false;
    telemetry.gear.down = true;
    telemetry.gear.transit = 0;
    telemetry.airbrake = envelope.vent;
    telemetry.brakes = 0;
    telemetry.trim = 0;
    telemetry.contacts = groundContact.report.contacts;
    telemetry.stall.stalled = false;
    telemetry.stall.buffet = 0;
    telemetry.stall.warning = false;
    telemetry.overspeed = false;
    telemetry.glideRatio = 0;
    // Radar altitude: the basket floor above the ground or water.
    if (Number.isFinite(telemetry.agl)) telemetry.radarAltitude = Math.max(0, telemetry.agl + rig.basketFloorY);
  }

  function snapshot() {
    return {
      kind: 'balloon',
      position: [state.position.x, state.position.y, state.position.z],
      velocity: [state.velocity.x, state.velocity.y, state.velocity.z],
      quaternion: [state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w],
      angularVelocity: [state.angularVelocity.x, state.angularVelocity.y, state.angularVelocity.z],
      envelope: { ...envelope },
      flight: { ...flight },
      time,
      alignToAir,
      tempFlag,
      tether: { ...tether },
      lever: [leverBaseline, leverArmed ? 1 : 0],
      contact: groundContact.snapshot(),
      collapsed: groundContact === collapsedContact,
      landing: landing.snapshot(),
    };
  }

  function restore(data) {
    if (!data || data.kind !== 'balloon') return false;
    state.position.fromArray(data.position);
    state.velocity.fromArray(data.velocity);
    state.quaternion.fromArray(data.quaternion).normalize();
    state.angularVelocity.fromArray(data.angularVelocity);
    Object.assign(envelope, data.envelope);
    Object.assign(flight, data.flight);
    time = finiteOr(data.time, time);
    alignToAir = data.alignToAir === true;
    tempFlag = data.tempFlag === true;
    if (data.tether) Object.assign(tether, data.tether);
    if (Array.isArray(data.lever)) {
      leverBaseline = data.lever[0];
      leverArmed = data.lever[1] === 1;
    }
    groundContact = data.collapsed === true ? collapsedContact : inflatedContact;
    groundContact.restore(data.contact);
    landing.restore(data.landing);
    writtenTemperature = NaN;
    if (craftState) {
      craftState.envelopeTemperature = envelope.temperature - KELVIN;
      writtenTemperature = craftState.envelopeTemperature;
    }
    return true;
  }

  return {
    kind: 'balloon',
    profile,
    state,
    surfaces,
    flightData,
    autoControls,
    /** The envelope as built: { volume, centroid, maxRadius, sideArea, topArea, surfaceArea }. */
    geometry,
    reset,
    step,
    pilotLever,
    writeTelemetry,
    snapshot,
    restore,

    get contact() {
      return groundContact.report;
    },
    /** Number of resets so far (control stages re-initialize when it changes). */
    get resetCount() {
      return resetCount;
    },
    get landings() {
      return landing.landings;
    },
    /** The envelope's internal state (K, J, 0..1), for the labs. */
    get envelope() {
      return envelope;
    },

    dispose() {
      // Put away mid-flight: the flight so far still counts in the journal.
      if (!groundContact.report.onGround && flight.airborneSeconds > 60) emitFlightStats(false);
      for (const contact of [inflatedContact, collapsedContact]) {
        contact.report.touchdown = null;
        contact.report.bodyStrike = null;
      }
      if (craftState) {
        craftState.burnerHeld = false;
        craftState.ventHeld = false;
        craftState.landing = false;
        craftState.altitudeHold = null;
      }
    },
  };
}
