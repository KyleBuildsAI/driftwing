// Flight lab: flies SimFixedWing headless (node, no renderer) with scripted controls through the
// same control stages the game runs every physics tick (the PID autopilot and the assists), and
// prints each craft's measured performance against the spec targets.
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3) with no wind or turbulence unless
// a test sets them, over flat ground at sea level. Physics runs at the game's fixed 120 Hz.
//
// Tests (per craft where they apply):
//   stall        power-off stall entry at 0.5 m/s^2 deceleration, wings level: airspeed at CLmax
//   polar        glider: steady glides from 19 to 40 m/s -> best L/D and min sink (and their speeds)
//   cruise       bush plane: level flight at 75 % power -> airspeed
//   climb        bush plane: full power at the best climb speed -> climb rate
//   vne          dive behaviour: overspeed warning and flutter past Vne; spoilers hold a 45 deg dive
//   handsOff     0 % assists, stick free: pitch and roll disturbances, return toward trim
//   autoLevel    100 % assists: roll disturbance, wings level again
//   spin         0 % assists: full aft stick and rudder -> spin; opposite rudder, stick forward -> recovery
//   noSpin       100 % assists: the same inputs do not spin (AoA limiter)
//   takeoff      bush plane: ground roll and distance to 15 m
//   landing      approach, flare, touchdown grade (the landed event), roll to a stop with brakes
//   crosswind    bush plane: taxi 30 s in a 6 m/s crosswind with rudder and differential brakes
//   autopilot    heading, altitude and speed hold through the flight model; engagement from a dive;
//                ring following through a 16 m ring off the track
//   rest         parked on its gear for 10 s: settles without bouncing, creeping or striking
//   systems      glider: spoilers on both toe brakes / the airbrake action, no-flaps and no-engine
//                notices; bush plane: flap notches and travel, the flap lever with hysteresis, engine
//                off (windmilling) and restart, and a retractable-gear variant of its profile (the
//                path the jet takes: stays down on the ground, transit, drag, wheels-up belly strike)
//
// Handling at 100 % / 50 % assists (from trimmed states, see src/flight/trim.js):
//   protections  100 %: full aileron held (bank protection about 65 deg, springs back to 30 or less on
//                release), full aft and forward stick (pitch protection +30 / -20, no stall)
//   autoTrim     50 %: after a pull and release, the hold never trims into more than 1.3 g
// Through the FlightController itself (headless, flat ground, calm air, 60 Hz frames):
//   conversions  CLASSIC -> SIM from cruise, slow, fast, climbing, diving and banked CLASSIC states,
//                20 s hands off: 0.8-1.3 g at 100 % (<= 1.3 g at 50 %), no stall, no zoom, no Vne
//   toClassic    SIM -> CLASSIC at SIM cruise: smooth rendered pose, no arcade stall
//   pathHold     SIM boot at the craft's SIM cruise, 60 s hands off at 100 %: small altitude change
//   respawn      soft crash -> 300 m AGL at SIM cruise, then calm hands-off flight
//   relaunch     glider aerotow to release / bush plane airstart at SIM cruise, then calm flight
//   craftSwitch  SIM glider -> bush plane -> glider mid-flight, calm hands-off flight after each
//   groundStart  bush plane "Start on ground" take-off at 100 %: no pitch-up or stall after lift-off
//
// Usage: node tools/flight-lab.mjs [--craft glider|bushplane|shared|all] [--verbose]
// (shared: only the tests through the FlightController that involve both craft or none in particular)
// Prints a table (measured vs target, tolerance about 10 %) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import glider from '../src/craft/glider.js';
import bushplane from '../src/craft/bushplane.js';
import { craftRegistry } from '../src/craft/index.js';
import { flightModels } from '../src/flight/models.js';
import { createFlightController } from '../src/flight/FlightController.js';
import { createControlState, copyControlState } from '../src/input/controlState.js';
import { createFlightTelemetry } from '../src/flight/telemetry.js';
import { EventBus } from '../src/core/eventBus.js';
import { attachTypedEvents } from '../src/core/events.js';
import { groundPose, restPitch } from '../src/flight/placement.js';
import { describeAssists, primeAssists } from '../src/flight/assists.js';
import { trimModel } from '../src/flight/trim.js';
import { CONFIG } from '../src/core/config.js';
import { DEG, clamp, vectorFromHeading } from '../src/core/util.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
const KMH = 3.6;
const TOLERANCE = 0.1;
const CRAFT = { glider, bushplane };

function parseArgs(argv) {
  const options = { craft: 'all', verbose: false };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--craft') options.craft = argv[++index];
    else if (flag === '--verbose') options.verbose = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (options.craft !== 'all' && options.craft !== 'shared' && !CRAFT[options.craft]) throw new Error(`Unknown craft ${options.craft}`);
  return options;
}
const OPTIONS = parseArgs(process.argv);

function log(...parts) {
  if (OPTIONS.verbose) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
/** Flat ground at `ground` m with the shared-height-function interface the model and autopilot use. */
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/**
 * One craft in the lab: the model, the pilot's ControlState (what the scripted pilot writes), the tick
 * copy the control stages shape, and the environment. assists 0..1 like settings.assists[craft].
 */
function createRig(craft, { ballast = 0, assists = 0, ground = 0 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  if ('ballast' in craftState) craftState.ballast = ballast;
  const world = createFlatWorld(ground);
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, input: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, autopilot, env, context, events, telemetry, time: 0, world, craftState };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    if (craft.inputProfile.throttle === 'none') controls.throttle = 0;
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    rig.time += DT;
  };
  /** Runs `seconds` of flight, calling script(rig) before each tick; stops early when it returns true. */
  rig.run = (seconds, script) => {
    const ticks = Math.round(seconds / DT);
    for (let tick = 0; tick < ticks; tick++) {
      if (script && script(rig) === true) return true;
      rig.tick();
    }
    return false;
  };
  rig.setAssists = (level) => {
    env.assists = level;
    context.assists = level;
    telemetry.assists = level;
  };
  /** Level flight at `speed` m/s heading `heading`, `altitude` m up (engine at `throttle`). */
  rig.airborne = ({ speed, heading = 0, altitude = 1200, throttle = 0, pitch = 0, bank = 0 }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  /** At rest on the gear on the flat ground, heading `heading`. */
  rig.parked = ({ heading = 0 } = {}) => {
    const profile = craft.simProfile;
    const pose = groundPose(world, profile.contacts, 0, 0, heading, profile.centerOfMass[2]);
    model.reset({ position: pose.position, quaternion: pose.quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = 0;
  };
  rig.selectFlaps = (notch) => {
    for (let step = 0; step < 4; step++) pilot.actions.add('flapsUp');
    rig.tick();
    for (let step = 0; step < notch; step++) {
      pilot.actions.add('flapsDown');
      rig.tick();
    }
  };
  rig.groundDistance = (from) => Math.hypot(model.state.position.x - from.x, model.state.position.z - from.z);
  return rig;
}

// ============================================================================================
// TEST PILOT (scripted closed loops on the stick, rudder and throttle, 0 % assists unless stated)
// ============================================================================================
function createPid(kp, ki, kd, min = -1, max = 1) {
  let integral = 0;
  let previous = NaN;
  return {
    reset(value = 0) {
      integral = value;
      previous = NaN;
    },
    set integral(value) {
      integral = value;
    },
    update(error, dt, measuredRate = NaN) {
      const derivative = Number.isFinite(measuredRate) ? measuredRate : Number.isFinite(previous) ? (error - previous) / dt : 0;
      previous = error;
      const output = integral + kp * error + kd * derivative;
      if ((output < max || error < 0) && (output > min || error > 0)) integral = clamp(integral + ki * error * dt, min, max);
      return clamp(integral + kp * error + kd * derivative, min, max);
    },
  };
}

/** Wings level (or a bank target) with the ailerons, the ball centred with the rudder. */
function createLateralPilot({ bankGain = 1.6, rateGain = 0.35, sideslipGain = 4 } = {}) {
  return {
    bank: 0,
    fly(rig) {
      const data = rig.data;
      rig.pilot.roll = clamp(bankGain * (this.bank * DEG - data.bank) - rateGain * data.rollRate, -1, 1);
      rig.pilot.yaw = clamp(sideslipGain * data.sideslip, -1, 1);
    },
  };
}

/** Holds an airspeed with the elevator (PI on the speed error, damped by the acceleration). */
function createSpeedPilot(target) {
  const pid = createPid(0.05, 0.02, 0.1);
  let lastSpeed = NaN;
  return {
    target,
    fly(rig) {
      const speed = rig.data.airspeed;
      const acceleration = Number.isFinite(lastSpeed) ? (speed - lastSpeed) / DT : 0;
      lastSpeed = speed;
      rig.pilot.pitch = clamp(pid.update(speed - this.target, DT, acceleration) - 0.25 * rig.data.pitchRate, -1, 1);
    },
  };
}

/** Holds an altitude with the elevator (vertical speed loop). */
function createAltitudePilot(target) {
  const pid = createPid(0.12, 0.08, 0.02);
  return {
    target,
    fly(rig) {
      const desiredClimb = clamp((this.target - rig.model.state.position.y) * 0.15, -4, 4);
      rig.pilot.pitch = clamp(pid.update(desiredClimb - rig.data.verticalSpeed, DT) - 0.25 * rig.data.pitchRate, -1, 1);
    },
  };
}

/** Holds a pitch attitude (degrees) with the elevator. */
function createAttitudePilot(target) {
  const pid = createPid(2.2, 1.2, 0);
  return {
    target,
    fly(rig) {
      rig.pilot.pitch = clamp(pid.update(this.target * DEG - rig.data.pitch, DT) - 0.6 * rig.data.pitchRate, -1, 1);
    },
  };
}

/** Holds a vertical speed (m/s) with the elevator. */
function createSinkPilot() {
  const pid = createPid(0.14, 0.12, 0);
  return {
    target: 0,
    reset(value) {
      pid.reset(value);
    },
    fly(rig) {
      rig.pilot.pitch = clamp(pid.update(this.target - rig.data.verticalSpeed, DT) - 0.3 * rig.data.pitchRate, -1, 1);
    },
  };
}

/** Steers a heading on the ground: tail-wheel rudder plus differential braking when the rudder runs out. */
function createTaxiPilot(heading) {
  return {
    heading,
    brakes: true,
    fly(rig) {
      const data = rig.data;
      const error = ((((this.heading - data.heading + 180) % 360) + 360) % 360) - 180;
      const command = clamp(error * 0.12 - data.yawRate * 1.2, -1.6, 1.6);
      rig.pilot.yaw = clamp(command, -1, 1);
      const extra = Math.abs(command) > 1 && this.brakes ? Math.min(1, Math.abs(command) - 1) : 0;
      rig.pilot.brakeL = command < 0 ? extra : 0;
      rig.pilot.brakeR = command > 0 ? extra : 0;
      rig.pilot.roll = clamp(-2 * data.bank - 0.3 * data.rollRate, -1, 1);
    },
  };
}

/** Keeps the fastest body strike seen: { part, speed } or null. */
function strongestStrike(current, strike) {
  if (!strike || (current && current.speed >= strike.speed)) return current;
  return { part: strike.part, speed: strike.speed };
}

function describeStrike(strike) {
  return strike ? `${strike.part} touched at ${strike.speed.toFixed(1)} m/s` : 'no strikes';
}

function headingError(target, heading) {
  return ((((target - heading + 180) % 360) + 360) % 360) - 180;
}

// ============================================================================================
// TESTS
// ============================================================================================
const results = [];
function record(craft, test, measured, target, { unit = '', tolerance = TOLERANCE, compare = 'within', note = '', decimals = 1 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  results.push({
    craft,
    test,
    measured: `${format(measured)}${unit ? ` ${unit}` : ''}`,
    target: compare === 'within' ? `${format(target)}${unit ? ` ${unit}` : ''} +/-${Math.round(tolerance * 100)}%` : compare === 'max' ? `<= ${format(target)}${unit ? ` ${unit}` : ''}` : compare === 'min' ? `>= ${format(target)}${unit ? ` ${unit}` : ''}` : String(target),
    pass,
    note,
  });
}

/**
 * Power-off stall, wings level: settle at 26 m/s, then hold the altitude with the elevator so the
 * speed bleeds off (about 0.3 to 1.5 m/s^2) until the wing reaches its critical angle of attack.
 */
function stallSpeed(craft, { flaps = 0, ballast = 0 } = {}) {
  const rig = createRig(craft, { ballast });
  rig.airborne({ speed: 26, altitude: 1500, throttle: 0 });
  if (flaps) rig.selectFlaps(flaps);
  const lateral = createLateralPilot();
  const settle = createSpeedPilot(26);
  rig.run(25, (lab) => {
    lateral.fly(lab);
    settle.fly(lab);
  });
  const level = createSinkPilot();
  level.reset(rig.pilot.pitch);
  let stall = null;
  let minimum = Infinity;
  let saturatedSeconds = 0;
  rig.run(90, (lab) => {
    lateral.fly(lab);
    level.target = 0;
    level.fly(lab);
    const speed = lab.data.airspeed;
    minimum = Math.min(minimum, speed);
    saturatedSeconds = lab.data.elevator > 0.99 ? saturatedSeconds + DT : 0;
    if (lab.data.aoa >= lab.data.aoaCritical || lab.data.stalled) {
      stall = { speed, aoa: lab.data.aoa / DEG };
      return true;
    }
    return saturatedSeconds > 3;
  });
  return { speed: stall ? stall.speed : minimum, stalled: Boolean(stall), elevator: rig.data.elevator, minimum };
}

/** Steady glide (sea level) at a held airspeed: sink rate and glide ratio over the last 20 s. */
function steadyGlide(craft, speed, { ballast = 0, spoilers = 0 } = {}) {
  const rig = createRig(craft, { ballast });
  rig.airborne({ speed, altitude: 2000, throttle: 0 });
  const lateral = createLateralPilot();
  const pilot = createSpeedPilot(speed);
  let sink = 0;
  let horizontal = 0;
  let samples = 0;
  rig.run(70, (lab) => {
    lateral.fly(lab);
    pilot.fly(lab);
    lab.pilot.brakeL = spoilers;
    lab.pilot.brakeR = spoilers;
    if (lab.time > 50) {
      sink += -lab.model.state.velocity.y;
      horizontal += Math.hypot(lab.model.state.velocity.x, lab.model.state.velocity.z);
      samples++;
    }
  });
  return { speed, sink: sink / samples, ratio: horizontal / sink, airspeed: rig.data.airspeed };
}

function gliderPolar(ballast) {
  let best = { ratio: 0 };
  let minimum = { sink: Infinity };
  for (let speed = 19; speed <= 40; speed += 1) {
    const glide = steadyGlide(glider, speed, { ballast });
    if (Math.abs(glide.airspeed - speed) > 0.5) continue;
    log(`  glider polar ballast ${ballast}: ${speed} m/s sink ${glide.sink.toFixed(3)} L/D ${glide.ratio.toFixed(1)}`);
    if (glide.ratio > best.ratio) best = glide;
    if (glide.sink < minimum.sink) minimum = glide;
  }
  return { best, minimum };
}

/** Level flight at a fixed throttle holding altitude: the airspeed it settles at. */
function levelCruise(craft, throttle) {
  const rig = createRig(craft);
  rig.airborne({ speed: 45, altitude: 600, throttle });
  const lateral = createLateralPilot();
  const altitude = createAltitudePilot(600);
  rig.run(150, (lab) => {
    lateral.fly(lab);
    altitude.fly(lab);
    lab.pilot.throttle = throttle;
  });
  return { speed: rig.data.airspeed, altitudeError: rig.model.state.position.y - 600 };
}

/** Full-power climb rate at a held airspeed. */
function climbAt(craft, speed) {
  const rig = createRig(craft);
  rig.airborne({ speed, altitude: 300, throttle: 1 });
  const lateral = createLateralPilot();
  const pilot = createSpeedPilot(speed);
  let climb = 0;
  let samples = 0;
  rig.run(60, (lab) => {
    lateral.fly(lab);
    pilot.fly(lab);
    lab.pilot.throttle = 1;
    if (lab.time > 45) {
      climb += lab.model.state.velocity.y;
      samples++;
    }
  });
  return { speed, climb: climb / samples, airspeed: rig.data.airspeed };
}

/** Dive at a held pitch attitude: top speed, overspeed warning, flutter buffet. */
function dive(craft, { pitch, spoilers = 0, seconds = 40 }) {
  const rig = createRig(craft);
  rig.airborne({ speed: craft === glider ? 30 : 45, altitude: 3500, throttle: 0 });
  const lateral = createLateralPilot();
  const attitude = createAttitudePilot(pitch);
  let top = 0;
  let overspeed = false;
  let buffet = 0;
  rig.run(seconds, (lab) => {
    lateral.fly(lab);
    attitude.fly(lab);
    lab.pilot.brakeL = spoilers;
    lab.pilot.brakeR = spoilers;
    lab.pilot.throttle = 0;
    top = Math.max(top, lab.data.airspeed);
    if (lab.data.overspeed) overspeed = true;
    buffet = Math.max(buffet, lab.data.buffet);
    lab.model.writeTelemetry(lab.telemetry);
  });
  return { top, overspeed, telemetryOverspeed: rig.telemetry.overspeed, finalSpeed: rig.data.airspeed };
}

/**
 * Stick-free stability at 0 % assists. From the natural trim: a 1 s pitch pulse (30 % aft stick),
 * then hands off: how fast the angle of attack settles (short period) and whether the speed swing
 * (phugoid) shrinks or at least does not grow; then a 20 degree bank released with all controls
 * free (spiral mode).
 */
function handsOff(craft) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists: 0 });
  rig.airborne({ speed: powered ? 40 : 28, altitude: 2500, throttle: powered ? 0.6 : 0 });
  const lateral = createLateralPilot();
  rig.run(120, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 0;
    lab.pilot.throttle = powered ? 0.6 : 0;
  });
  const trimAoa = rig.data.aoa;
  const trimSpeed = rig.data.airspeed;
  let peakAoa = 0;
  rig.run(1, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 0.3;
    peakAoa = Math.max(peakAoa, lab.data.aoa);
  });
  const released = rig.time;
  let settledAt = NaN;
  const swing = [{ low: Infinity, high: -Infinity }, { low: Infinity, high: -Infinity }];
  rig.run(90, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 0;
    const since = lab.time - released;
    if (!Number.isFinite(settledAt) && since > 0.2 && Math.abs(lab.data.aoa - trimAoa) <= 1 * DEG) settledAt = since;
    const window = since < 45 ? swing[0] : swing[1];
    window.low = Math.min(window.low, lab.data.airspeed);
    window.high = Math.max(window.high, lab.data.airspeed);
  });
  const banker = createLateralPilot();
  banker.bank = 20;
  rig.run(6, (lab) => {
    banker.fly(lab);
    lab.pilot.pitch = 0;
  });
  const bankStart = rig.data.bank / DEG;
  rig.run(20, (lab) => {
    lab.pilot.roll = 0;
    lab.pilot.yaw = 0;
    lab.pilot.pitch = 0;
  });
  const bankAfter = rig.data.bank / DEG;
  return {
    trimAoa: trimAoa / DEG,
    trimSpeed,
    peakAoa: peakAoa / DEG,
    aoaSettleSeconds: settledAt,
    phugoidFirst: swing[0].high - swing[0].low,
    phugoidSecond: swing[1].high - swing[1].low,
    bankStart,
    bankAfter,
  };
}

/** 100 % assists: bank 30 degrees, let go of the stick, time until the wings are level (within 3 degrees). */
function autoLevel(craft) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists: 1 });
  rig.airborne({ speed: powered ? 42 : 28, altitude: 2000, throttle: powered ? 0.6 : 0, bank: 30 });
  rig.pilot.throttle = powered ? 0.6 : 0;
  let levelAt = NaN;
  rig.run(15, (lab) => {
    lab.pilot.roll = 0;
    lab.pilot.pitch = 0;
    lab.pilot.yaw = 0;
    if (!Number.isFinite(levelAt) && Math.abs(lab.data.bank) < 3 * DEG) levelAt = lab.time;
  });
  return { levelSeconds: levelAt, bankAfter: rig.data.bank / DEG, active: describeAssists(1, 'fixedWing') };
}

/**
 * Spin at a given assist level: slow to near the stall, then full aft stick and full left rudder for
 * `holdSeconds`; recover with neutral aileron, full right rudder and the stick forward.
 */
function spin(craft, { assists = 0, holdSeconds = 10 } = {}) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists });
  const entrySpeed = powered ? 24 : 21;
  rig.airborne({ speed: entrySpeed, altitude: 2500, throttle: 0 });
  const lateral = createLateralPilot();
  const speed = createSpeedPilot(entrySpeed);
  rig.run(8, (lab) => {
    lateral.fly(lab);
    speed.fly(lab);
    lab.pilot.throttle = 0;
  });
  const startAltitude = rig.model.state.position.y;
  let maxAoa = 0;
  let turns = 0;
  let developedTurns = 0;
  let lastHeading = rig.data.heading;
  const holdStart = rig.time;
  rig.run(holdSeconds, (lab) => {
    lab.pilot.pitch = 1;
    lab.pilot.yaw = -1;
    lab.pilot.roll = 0;
    lab.pilot.throttle = 0;
    const change = headingError(lab.data.heading, lastHeading) / 360;
    lastHeading = lab.data.heading;
    turns += change;
    if (lab.time - holdStart > holdSeconds / 2) developedTurns += change;
    maxAoa = Math.max(maxAoa, lab.data.aoa);
  });
  // Rotation rate about the vertical in the developed half of the spin (deg/s, negative = left).
  const spinRate = (developedTurns * 360) / (holdSeconds / 2);
  const spinning = Math.abs(spinRate) > 50 && maxAoa > rig.data.aoaCritical;
  const recoveryStart = rig.time;
  let stoppedAt = NaN;
  rig.run(12, (lab) => {
    lab.pilot.roll = 0;
    lab.pilot.throttle = 0;
    lab.pilot.yaw = lab.data.yawRate < 0 ? 1 : 0;
    lab.pilot.pitch = -0.6;
    if (Math.abs(lab.data.yawRate) < 10 * DEG && lab.data.aoa < lab.data.aoaCritical) {
      stoppedAt = lab.time;
      return true;
    }
    return false;
  });
  // Pull out of the dive with wings level.
  const pullOut = createAttitudePilot(0);
  const pullLateral = createLateralPilot();
  let bottom = rig.model.state.position.y;
  rig.run(15, (lab) => {
    pullLateral.fly(lab);
    pullOut.fly(lab);
    bottom = Math.min(bottom, lab.model.state.position.y);
  });
  return {
    spinning,
    spinRate,
    turns: Math.abs(turns),
    maxAoa: maxAoa / DEG,
    critical: rig.data.aoaCritical / DEG,
    recoverySeconds: Number.isFinite(stoppedAt) ? stoppedAt - recoveryStart : Infinity,
    altitudeLost: startAltitude - bottom,
    levelAfter: Math.abs(rig.data.flightPath / DEG) < 10,
  };
}

/** Bush plane take-off: flaps one notch, full power, tail up at 12 m/s, rotate at 21 m/s. */
function takeoff() {
  const rig = createRig(bushplane, { assists: 0 });
  rig.parked({ heading: 0 });
  rig.run(2, () => false);
  rig.selectFlaps(1);
  const start = rig.model.state.position.clone();
  const taxi = createTaxiPilot(0);
  taxi.brakes = false;
  const lateral = createLateralPilot();
  const attitude = createAttitudePilot(10);
  let liftoff = null;
  let clear = null;
  let airborneTime = 0;
  let strike = null;
  rig.run(40, (lab) => {
    lab.pilot.throttle = 1;
    const speed = lab.data.airspeed;
    if (lab.data.onGround) {
      taxi.fly(lab);
      if (speed < 12) lab.pilot.pitch = 0;
      else if (speed < 21) {
        attitude.target = 1;
        attitude.fly(lab);
      } else {
        attitude.target = 9;
        attitude.fly(lab);
      }
    } else {
      lateral.fly(lab);
      attitude.target = 8;
      attitude.fly(lab);
    }
    strike = strongestStrike(strike, lab.model.contact.bodyStrike);
    airborneTime = lab.data.onGround ? 0 : airborneTime + DT;
    if (!liftoff && airborneTime > 0.5) liftoff = { distance: lab.groundDistance(start), speed, time: lab.time };
    if (!clear && lab.data.agl > 15 + 1.4) {
      clear = { distance: lab.groundDistance(start), time: lab.time };
      return true;
    }
    return false;
  });
  return { liftoff, clear, strike };
}

/**
 * Approach, flare and landing roll. Bush plane: full flaps at 21 m/s, power for a 2 m/s sink, flare
 * from 5 m; glider: 25 m/s with half spoilers. After touchdown: stick back, full brakes, rudder on the
 * centreline. Returns the graded landing and the roll distance to a stop.
 */
function landing(craft) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists: 0 });
  const approachSpeed = powered ? 21 : 25;
  rig.airborne({ speed: approachSpeed, altitude: 45, throttle: powered ? 0.3 : 0 });
  if (powered) rig.selectFlaps(3);
  const lateral = createLateralPilot();
  const speed = createSpeedPilot(approachSpeed);
  const sink = createSinkPilot();
  const throttle = createPid(0.12, 0.08, 0, 0, 1);
  throttle.integral = 0.3;
  const gearHeight = powered ? 1.4 : 0.7;
  const restAttitude = restPitch(craft.simProfile.contacts, craft.simProfile.centerOfMass[2]) / DEG - 1;
  let phase = 'approach';
  let touchdownAt = null;
  let rollHeading = 0;
  let stopped = null;
  let strike = null;
  let traceTimer = 0;
  rig.run(120, (lab) => {
    const data = lab.data;
    const height = data.agl - gearHeight;
    strike = strongestStrike(strike, lab.model.contact.bodyStrike);
    traceTimer -= DT;
    if (traceTimer <= 0 && phase !== 'approach') {
      traceTimer = 0.25;
      log(`  ${craft.id} landing ${phase} t=${lab.time.toFixed(2)} height=${height.toFixed(2)} ias=${data.airspeed.toFixed(1)} vs=${data.verticalSpeed.toFixed(2)} pitch=${(data.pitch / DEG).toFixed(1)} bank=${(data.bank / DEG).toFixed(1)} heading=${data.heading.toFixed(1)} yaw=${lab.pilot.yaw.toFixed(2)} brakes=${lab.pilot.brakeL.toFixed(2)}/${lab.pilot.brakeR.toFixed(2)} contacts=${lab.model.contact.contacts}${lab.model.contact.bodyStrike ? ` strike=${lab.model.contact.bodyStrike.part}` : ''}`);
    }
    if (phase === 'approach') {
      lateral.fly(lab);
      speed.fly(lab);
      if (powered) lab.pilot.throttle = throttle.update(-2 - data.verticalSpeed, DT);
      else {
        const spoiler = clamp(0.5 + (data.verticalSpeed + 1.8) * -0.4, 0, 1);
        lab.pilot.brakeL = spoiler;
        lab.pilot.brakeR = spoiler;
      }
      if (height < 5) {
        phase = 'flare';
        sink.reset(lab.pilot.pitch);
      }
    } else if (phase === 'flare') {
      lateral.fly(lab);
      lab.pilot.throttle = 0;
      lab.pilot.brakeL = powered ? 0 : 0.3;
      lab.pilot.brakeR = powered ? 0 : 0.3;
      sink.target = -clamp(height * 0.35, 0.25, 2);
      sink.fly(lab);
      if (data.onGround) {
        phase = 'roll';
        touchdownAt = lab.model.state.position.clone();
        rollHeading = data.heading;
      }
    } else {
      lab.pilot.throttle = 0;
      lab.pilot.pitch = powered ? 1 : 0.4;
      lab.pilot.roll = clamp(-2 * data.bank - 0.3 * data.rollRate, -1, 1);
      // Keep straight along the touchdown heading (gentle rudder: a taildragger swings if you stamp on it).
      lab.pilot.yaw = clamp(headingError(rollHeading, data.heading) * 0.05 - data.yawRate * 0.8, -1, 1);
      if (powered) {
        // Taildragger braking: firm, eased off as soon as the tail starts to lift (nose-over).
        const tailLift = clamp((restAttitude - data.pitch / DEG) / 3, 0, 1);
        lab.pilot.brakeL = (data.airspeed < 16 ? 0.9 : 0.5) * (1 - tailLift);
        lab.pilot.brakeR = lab.pilot.brakeL;
      } else lab.pilot.held.add('airbrake');
      if (Math.hypot(lab.model.state.velocity.x, lab.model.state.velocity.z) < 0.3) {
        stopped = lab.groundDistance(touchdownAt);
        return true;
      }
    }
    return false;
  });
  rig.pilot.held.clear();
  return { landed: rig.events.landed[0] ?? null, toast: rig.events.notify.find((text) => /landing/.test(text)) ?? null, roll: stopped, strike };
}

/** Taxi 30 s at 6 m/s ground speed in a 6 m/s crosswind from the right, holding the heading. */
function crosswindTaxi() {
  const rig = createRig(bushplane, { assists: 0 });
  rig.parked({ heading: 0 });
  rig.env.wind.vel.set(-6, 0, 0);
  const taxi = createTaxiPilot(0);
  const throttle = createPid(0.15, 0.1, 0, 0, 1);
  let maxError = 0;
  let strike = null;
  rig.run(35, (lab) => {
    taxi.fly(lab);
    const groundSpeed = Math.hypot(lab.model.state.velocity.x, lab.model.state.velocity.z);
    lab.pilot.throttle = throttle.update(6 - groundSpeed, DT);
    lab.pilot.pitch = 1;
    if (lab.time > 5) maxError = Math.max(maxError, Math.abs(headingError(0, lab.data.heading)));
    strike = strongestStrike(strike, lab.model.contact.bodyStrike);
  });
  return { maxError, strike, onGround: rig.data.onGround, speed: Math.hypot(rig.model.state.velocity.x, rig.model.state.velocity.z) };
}

/** Autopilot: heading +90, altitude +150 m (powered) and speed hold, through the flight model. */
function autopilotHold(craft) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists: 1 });
  const cruise = powered ? 45 : 27;
  rig.airborne({ speed: powered ? 47 : 30, altitude: 1200, throttle: powered ? 0.7 : 0 });
  const autopilot = rig.autopilot;
  Object.assign(autopilot, { enabled: true, heading: 90, altitude: powered ? 1350 : 1200, speed: cruise, followWaypoint: false });
  let maxBank = 0;
  let maxLoad = 0;
  rig.run(powered ? 120 : 90, (lab) => {
    lab.pilot.roll = 0;
    lab.pilot.pitch = 0;
    lab.pilot.yaw = 0;
    maxBank = Math.max(maxBank, Math.abs(lab.data.bank / DEG));
    maxLoad = Math.max(maxLoad, lab.data.gLoad);
  });
  const settled = { heading: Math.abs(headingError(90, rig.data.heading)), altitude: rig.model.state.position.y - autopilot.altitude, speed: rig.data.airspeed - cruise, maxBank, maxLoad };
  // Engage from a spiral dive: 60 degrees of bank, nose 20 degrees down, fast.
  const dive = createRig(craft, { assists: 1 });
  dive.airborne({ speed: powered ? 55 : 45, altitude: 1500, throttle: powered ? 0.7 : 0, pitch: -20, bank: 60 });
  Object.assign(dive.autopilot, { enabled: true, heading: dive.data.heading, altitude: 1400, speed: cruise, followWaypoint: false });
  let levelAt = NaN;
  let diveLoad = 0;
  let minimumLoad = Infinity;
  dive.run(30, (lab) => {
    diveLoad = Math.max(diveLoad, lab.data.gLoad);
    minimumLoad = Math.min(minimumLoad, lab.data.gLoad);
    // Recovered: back inside the autopilot's own envelope (normal bank, no longer descending steeply).
    if (!Number.isFinite(levelAt) && Math.abs(lab.data.bank) < 35 * DEG && lab.data.flightPath > -5 * DEG) levelAt = lab.time;
  });
  return { settled, recovery: { levelSeconds: levelAt, maxLoad: diveLoad, minLoad: minimumLoad, gLimit: craft.limits.gLimit } };
}

/**
 * Autopilot ring following (v1 behaviour, through the flight model): a ring 900 m ahead, 150 m to
 * the right and above (below for the glider), facing along the original heading. Returns the miss
 * distance from the ring's centre where the craft crosses the ring's plane (rings are 16 m radius).
 */
function ringFollowing(craft) {
  const powered = craft === bushplane;
  const rig = createRig(craft, { assists: 1 });
  rig.airborne({ speed: powered ? 45 : 30, altitude: 1000, throttle: powered ? 0.7 : 0 });
  const ring = { x: 150, y: powered ? 1040 : 975, z: -900 };
  const normal = { x: 0, y: 0, z: -1 };
  rig.context.game = { ringCourse: { active: true, nextRingPosition: ring, nextRingNormal: normal }, waypoint: null };
  Object.assign(rig.autopilot, { enabled: true, heading: 0, altitude: 1000, speed: powered ? 45 : 28, followWaypoint: true });
  let miss = Infinity;
  let previousSide = null;
  rig.run(90, (lab) => {
    const position = lab.model.state.position;
    const side = (position.z - ring.z) * normal.z > 0;
    if (previousSide === false && side === true) {
      miss = Math.hypot(position.x - ring.x, position.y - ring.y);
      log(`  ${craft.id} ring pass: dx ${(position.x - ring.x).toFixed(1)} dy ${(position.y - ring.y).toFixed(1)} heading ${lab.data.heading.toFixed(1)} bank ${(lab.data.bank / DEG).toFixed(1)} at ${lab.time.toFixed(1)} s`);
      return true;
    }
    previousSide = side;
    return false;
  });
  return { miss };
}

/** Parked for 10 s: how far it creeps, how much it bounces, and no body strike. */
function rest(craft) {
  const rig = createRig(craft);
  rig.parked({ heading: 30 });
  const start = rig.model.state.position.clone();
  let strike = null;
  let maxVertical = 0;
  rig.run(10, (lab) => {
    if (lab.time > 2) maxVertical = Math.max(maxVertical, Math.abs(lab.model.state.velocity.y));
    strike = strongestStrike(strike, lab.model.contact.bodyStrike);
  });
  return { moved: rig.model.state.position.distanceTo(start), maxVertical, strike, contacts: rig.model.contact.contacts, onGround: rig.data.onGround };
}

/**
 * Bush plane systems: three flapsDown presses select notch 3 and the flaps travel there in their
 * deploy time; the flap lever picks notches with hysteresis; the engine switch cuts the power
 * (the prop windmills) and restarts it.
 */
function bushSystems() {
  const rig = createRig(bushplane);
  rig.airborne({ speed: 30, altitude: 900, throttle: 0.6 });
  const lateral = createLateralPilot();
  const speed = createSpeedPilot(30);
  const fly = (lab) => {
    lateral.fly(lab);
    speed.fly(lab);
    lab.pilot.throttle = 0.6;
  };
  const telemetry = () => {
    rig.model.writeTelemetry(rig.telemetry);
    return rig.telemetry;
  };
  for (let press = 0; press < 3; press++) {
    rig.pilot.actions.add('flapsDown');
    rig.tick();
  }
  const notch = telemetry().flapNotch;
  rig.run(1.5, fly);
  const halfway = telemetry().flaps;
  rig.run(2, fly);
  const deployed = telemetry().flaps;
  // Flap lever: a baseline reading, then positions near, between and past the notches.
  const lever = [];
  for (const position of [1, 0.36, 0.45, 0.62, 0.02]) {
    rig.pilot.flaps = position;
    rig.run(0.1, fly);
    lever.push(telemetry().flapNotch);
  }
  rig.pilot.actions.add('engineToggle');
  rig.run(4, fly);
  const off = { running: telemetry().engineOn, rpm: telemetry().rpm, notify: rig.events.notify.includes('Engine off.') };
  rig.pilot.actions.add('engineToggle');
  rig.run(3, fly);
  const on = { running: telemetry().engineOn, rpm: telemetry().rpm };
  return { notch, halfway, deployed, lever, off, on };
}

/** Glider systems: spoilers on the airbrake action and on both toe brakes in the air (not one). */
function gliderSystems() {
  const rig = createRig(glider);
  rig.airborne({ speed: 28, altitude: 900 });
  const lateral = createLateralPilot();
  const telemetry = () => {
    rig.model.writeTelemetry(rig.telemetry);
    return rig.telemetry.airbrake;
  };
  rig.pilot.brakeL = 1;
  rig.run(1, (lab) => lateral.fly(lab));
  const oneToe = telemetry();
  rig.pilot.brakeR = 1;
  rig.run(1, (lab) => lateral.fly(lab));
  const bothToes = telemetry();
  rig.pilot.brakeL = 0;
  rig.pilot.brakeR = 0;
  rig.run(1.5, (lab) => lateral.fly(lab));
  const released = telemetry();
  rig.pilot.held.add('airbrake');
  rig.run(1, (lab) => lateral.fly(lab));
  const held = telemetry();
  rig.pilot.held.clear();
  rig.pilot.actions.add('flapsDown');
  rig.pilot.actions.add('engineToggle');
  rig.tick();
  return { oneToe, bothToes, released, held, notices: rig.events.notify.slice(-2) };
}

/**
 * Retractable gear, the path the jet will take: the bush plane's profile with retracting wheels. The
 * gear stays down on the ground, travels in its transit time in the air, lowers the drag, and a
 * wheels-up touchdown is a body strike.
 */
function retractableGear() {
  const base = bushplane.simProfile;
  const profile = { ...base, gear: { retractable: true, transitSeconds: 4, cdIncrement: 0.02 }, contacts: base.contacts.map((contact) => (contact.gear ? { ...contact, retracts: true } : contact)) };
  const craft = { ...bushplane, simProfile: profile };
  const rig = createRig(craft);
  const gear = () => {
    rig.model.writeTelemetry(rig.telemetry);
    return { ...rig.telemetry.gear };
  };
  rig.parked();
  rig.run(1, () => false);
  rig.pilot.actions.add('gearToggle');
  rig.run(1, () => false);
  const onGround = { gear: gear(), refused: rig.events.notify.includes('The gear stays down on the ground.') };
  rig.airborne({ speed: 45, altitude: 600, throttle: 0.7 });
  const lateral = createLateralPilot();
  const altitude = createAltitudePilot(600);
  const fly = (lab) => {
    lateral.fly(lab);
    altitude.fly(lab);
    lab.pilot.throttle = 0.7;
  };
  rig.run(20, fly);
  const speedDown = rig.data.airspeed;
  rig.pilot.actions.add('gearToggle');
  rig.run(2, fly);
  const inTransit = gear();
  rig.run(3, fly);
  const retracted = gear();
  rig.run(40, fly);
  const speedUp = rig.data.airspeed;
  // Wheels-up touchdown: settle onto flat ground at about 1 m/s sink.
  rig.airborne({ speed: 25, altitude: 4, throttle: 0 });
  const sink = createSinkPilot();
  sink.target = -1;
  let strike = null;
  rig.run(8, (lab) => {
    lateral.fly(lab);
    sink.fly(lab);
    lab.pilot.throttle = 0;
    strike = strongestStrike(strike, lab.model.contact.bodyStrike);
    return strike !== null;
  });
  return { onGround, inTransit, retracted, speedDown, speedUp, strike };
}

// ============================================================================================
// HANDLING AT 100 % / 50 % (model rig, started from a trimmed state)
// ============================================================================================
/** Level flight at `speed`, trimmed (trim.js) with the assists primed, as the controller spawns it. */
function trimmedRig(craft, { speed, assists = 1, throttle = 0, altitude = 1500 }) {
  const rig = createRig(craft, { assists });
  rig.airborne({ speed, altitude, throttle });
  const trim = trimModel(rig.model, { env: rig.env, dt: DT, throttle, trim: 0 });
  primeAssists(rig.model, trim);
  rig.pilot.throttle = throttle;
  return rig;
}

function neutralStick(rig) {
  rig.pilot.roll = 0;
  rig.pilot.pitch = 0;
  rig.pilot.yaw = 0;
}

/**
 * 100 % protections from trimmed cruise: full aileron held 4 s (bank protection), then released 8 s
 * (springs back); full aft stick 8 s and full forward stick 6 s (pitch attitude protection, AoA and G
 * limiters: no stall).
 */
function protections(craft) {
  const powered = craft === bushplane;
  const cruise = craft.spawn.cruise;
  const throttle = powered ? craft.spawn.cruiseThrottle : 0;
  const rig = trimmedRig(craft, { speed: cruise, throttle });
  rig.run(3, neutralStick);
  let maxBank = 0;
  let bankAt1500 = 0;
  const rollStart = rig.time;
  rig.run(4, (lab) => {
    lab.pilot.roll = 1;
    lab.pilot.pitch = 0;
    maxBank = Math.max(maxBank, Math.abs(lab.data.bank / DEG));
    if (lab.time - rollStart <= 1.5) bankAt1500 = Math.abs(lab.data.bank / DEG);
  });
  const heldBank = Math.abs(rig.data.bank / DEG);
  let springBack = NaN;
  const releaseStart = rig.time;
  rig.run(8, (lab) => {
    neutralStick(lab);
    if (!Number.isFinite(springBack) && Math.abs(lab.data.bank) <= 30 * DEG) springBack = lab.time - releaseStart;
  });
  const bankAfter = Math.abs(rig.data.bank / DEG);

  const pull = trimmedRig(craft, { speed: cruise, throttle });
  pull.run(2, neutralStick);
  let maxPitch = -Infinity;
  let maxAoaMargin = Infinity;
  let pullStalled = false;
  let maxLoad = 0;
  pull.run(8, (lab) => {
    lab.pilot.pitch = 1;
    lab.pilot.roll = 0;
    maxPitch = Math.max(maxPitch, lab.data.pitch / DEG);
    maxAoaMargin = Math.min(maxAoaMargin, (lab.data.aoaCritical - lab.data.aoa) / DEG);
    maxLoad = Math.max(maxLoad, lab.data.gLoad);
    if (lab.data.stalled) pullStalled = true;
  });
  const push = trimmedRig(craft, { speed: cruise, throttle });
  push.run(2, neutralStick);
  let minPitch = Infinity;
  let minLoad = Infinity;
  push.run(6, (lab) => {
    lab.pilot.pitch = -1;
    lab.pilot.roll = 0;
    minPitch = Math.min(minPitch, lab.data.pitch / DEG);
    minLoad = Math.min(minLoad, lab.data.gLoad);
  });
  return { maxBank, bankAt1500, heldBank, springBack, bankAfter, maxPitch, maxAoaMargin, pullStalled, maxLoad, minPitch, minLoad };
}

/**
 * 50 % auto-trim: from trimmed cruise, a 1 s pull at 12 % stick (a gentle pitch change), then hands
 * off for 40 s. The hold keeps the angle of attack at release and never trims into more than 1.3 g.
 */
function autoTrimHold(craft) {
  const powered = craft === bushplane;
  const throttle = powered ? craft.spawn.cruiseThrottle : 0;
  const rig = trimmedRig(craft, { speed: craft.spawn.cruise, assists: 0.5, throttle });
  rig.run(3, neutralStick);
  rig.run(1, (lab) => {
    neutralStick(lab);
    lab.pilot.pitch = 0.12;
  });
  let maxLoad = 0;
  let minLoad = Infinity;
  const window = { low: Infinity, high: -Infinity };
  const releaseStart = rig.time;
  let traceTimer = 0;
  rig.run(40, (lab) => {
    neutralStick(lab);
    const since = lab.time - releaseStart;
    traceTimer -= DT;
    if (traceTimer <= 0) {
      traceTimer = 0.5;
      log(`  ${craft.id} 50 % hold t=${since.toFixed(1)} ias=${(lab.data.airspeed * KMH).toFixed(0)} aoa=${(lab.data.aoa / DEG).toFixed(2)} g=${lab.data.gLoad.toFixed(2)} pitch=${(lab.data.pitch / DEG).toFixed(1)} elevator=${lab.data.elevator.toFixed(3)}`);
    }
    // From 1 s after the release (before that it is the pull itself dying away).
    if (since > 1) {
      maxLoad = Math.max(maxLoad, lab.data.gLoad);
      minLoad = Math.min(minLoad, lab.data.gLoad);
    }
    if (since > 30) {
      window.low = Math.min(window.low, lab.data.airspeed);
      window.high = Math.max(window.high, lab.data.airspeed);
    }
  });
  return { maxLoad, minLoad, speedSwing: window.high - window.low, speed: rig.data.airspeed, stalled: rig.data.stalled };
}

// ============================================================================================
// CONTROLLER RIG: the FlightController headless (mode switches, spawns, respawn, relaunch)
// ============================================================================================
const CONTROLLER_GROUND = 200;
const FRAME = 1 / 60;

/** The soft-crash fade draws a DOM overlay; headless it gets a stand-in element. */
function ensureDocumentStandIn() {
  if (typeof globalThis.document !== 'undefined') return;
  const element = { style: {}, setAttribute() {} };
  globalThis.document = { body: { appendChild() {} }, getElementById: () => null, createElement: () => element };
}

/**
 * The FlightController on flat ground at CONTROLLER_GROUND m (calm, or a steady `wind` vector), fed like the game: the v1
 * input struct for CLASSIC, the ControlState for SIM, 60 Hz frames. The craft start at `altitude`
 * heading 30 at CLASSIC cruise (the controller boots SIM at the craft's SIM cruise).
 */
function createControllerRig({ craft = 'glider', mode = 'classic', assists = 1, altitude = 1500, startOnGround = false, wind = null } = {}) {
  ensureDocumentStandIn();
  const world = { groundHeight: () => CONTROLLER_GROUND, heightAt: () => CONTROLLER_GROUND, WATER_LEVEL: 0 };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], stall: 0, softCrash: [], relaunched: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.on('stall', () => events.stall++);
  bus.onTyped('softCrash', (payload) => events.softCrash.push(payload));
  bus.onTyped('relaunched', (payload) => events.relaunched.push(payload));
  const heading = 30;
  const player = {
    position: new THREE.Vector3(0, altitude, 0),
    velocity: vectorFromHeading(heading).multiplyScalar(CONFIG.SPEED.CRUISE),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG),
    forward: vectorFromHeading(heading),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    speed: CONFIG.SPEED.CRUISE,
    throttle: 0.55,
    heading,
    pitch: 0,
    roll: 0,
    yawRate: 0,
    verticalSpeed: 0,
    gForce: 1,
    altitude,
    groundHeight: CONTROLLER_GROUND,
    agl: altitude - CONTROLLER_GROUND,
    stalled: false,
    boost: { active: false, remaining: 0, cooldown: 0, cooldownTotal: 6 },
    barrelRoll: { active: false, direction: 0, progress: 0 },
    autopilot: { enabled: false, heading, altitude, followWaypoint: false },
    inCloud: 0,
  };
  const state = {
    frame: 0,
    paused: false,
    photoMode: false,
    seed: 'LAB',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 14 },
    player,
    flight: createFlightTelemetry(),
    waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const input = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, throttleTarget: null, boost: false, fineControl: false, mouseActive: false, lastActivity: 0, touch: { active: false, x: 0, y: 0, throttle: null, boost: false } };
  const settingsValues = { mode, craft, startOnGround, assists: { glider: assists, bushplane: assists } };
  const controls = createControlState();
  const { uniform } = TSL;
  const ctx = {
    THREE,
    TSL,
    scene: new THREE.Scene(),
    state,
    input,
    controls,
    bus,
    world,
    uniforms: { time: uniform(0), sunDirection: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)), skyHorizonColor: uniform(new THREE.Color(1, 1, 1)), skyZenithColor: uniform(new THREE.Color(1, 1, 1)), nightFactor: uniform(0) },
    craftRegistry,
    flightModels,
    settings: {
      get: (key) => settingsValues[key],
      set(key, value) {
        settingsValues[key] = value;
        bus.emit('settings:changed', { key, value, settings: { ...settingsValues } });
        return true;
      },
    },
    wind: {
      sample(pos, t, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
        if (wind) out.vel.copy(wind);
        else out.vel.set(0, 0, 0);
        out.turbulence = 0;
        return out;
      },
      ambientAt: () => ({ speed: 0, fromDegrees: 0 }),
      lastLayers: { gust: new THREE.Vector3() },
    },
    systems: { camera: { snap() {} } },
    registerPrewarm() {},
  };
  const flight = createFlightController(ctx);
  ctx.systems.flight = flight;
  const telemetry = state.flight;
  const rig = { flight, state, input, controls, settings: settingsValues, events, telemetry, bus, time: 0 };
  rig.frame = () => {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.frameDt = FRAME;
    flight.update(FRAME, FRAME);
    flight.publishTelemetry(FRAME);
    rig.time += FRAME;
  };
  /** Runs `seconds` of frames, calling script(rig) before each; stops early when it returns true. */
  rig.run = (seconds, script) => {
    const frames = Math.round(seconds / FRAME);
    for (let frame = 0; frame < frames; frame++) {
      if (script && script(rig) === true) return true;
      rig.frame();
    }
    return false;
  };
  rig.handsOff = () => {
    Object.assign(input, { pitch: 0, roll: 0, yaw: 0 });
    Object.assign(controls, { pitch: 0, roll: 0, yaw: 0 });
  };
  rig.model = () => flight.getModel();
  return rig;
}

/**
 * Watches a SIM stretch after a switch or spawn: load factor range (after `settle` s), stall (flag
 * or the angle of attack at the critical angle), zoom (vertical speed rising more than 3 m/s above
 * its value at the start, or above 3 m/s when it started descending), overspeed past Vne and the
 * speed range (after `speedSettle` s), and the largest per-frame rotation of the rendered craft (the
 * blend keeps it smooth).
 */
function watchSim(rig, seconds, { settle = 0.1, speedSettle = 0.6 } = {}) {
  const telemetry = rig.telemetry;
  const startVertical = telemetry.verticalSpeed;
  const startAltitude = rig.state.player.position.y;
  const result = { minLoad: Infinity, maxLoad: -Infinity, stalled: false, zoom: false, maxVertical: -Infinity, maxSpeed: 0, minSpeed: Infinity, overspeed: false, maxFrameRotation: 0, altitudeChange: 0, minAoaMargin: Infinity };
  const previous = rig.flight.planeMesh.quaternion.clone();
  const start = rig.time;
  rig.run(seconds, (lab) => {
    lab.handsOff();
    const model = lab.model();
    const data = model.flightData;
    const since = lab.time - start;
    const root = lab.flight.planeMesh;
    result.maxFrameRotation = Math.max(result.maxFrameRotation, previous.angleTo(root.quaternion) / DEG);
    previous.copy(root.quaternion);
    if (since < settle || !data) return false;
    result.minLoad = Math.min(result.minLoad, telemetry.gLoad);
    result.maxLoad = Math.max(result.maxLoad, telemetry.gLoad);
    result.minAoaMargin = Math.min(result.minAoaMargin, (data.aoaCritical - data.aoa) / DEG);
    if (data.stalled || data.aoa >= data.aoaCritical) result.stalled = true;
    result.maxVertical = Math.max(result.maxVertical, telemetry.verticalSpeed);
    if (telemetry.verticalSpeed > Math.max(startVertical, 0) + 3) result.zoom = true;
    // Speeds from after the 0.5 s blend (a conversion eases an out-of-range speed during it).
    if (since < speedSettle) return false;
    result.maxSpeed = Math.max(result.maxSpeed, telemetry.airspeed);
    result.minSpeed = Math.min(result.minSpeed, telemetry.airspeed);
    if (telemetry.airspeed > data.vne * 1.02) result.overspeed = true;
    return false;
  });
  result.altitudeChange = rig.state.player.position.y - startAltitude;
  result.startVertical = startVertical;
  return result;
}

/** CLASSIC states to switch from: scripted v1 inputs from CLASSIC cruise. */
const CLASSIC_STATES = Object.freeze([
  { id: 'cruise', fly: (rig) => rig.run(3) },
  { id: 'slow', fly: (rig) => { rig.input.throttleTarget = 0; rig.run(25); } },
  { id: 'fast', fly: (rig) => { rig.input.throttleTarget = 1; rig.run(25); } },
  { id: 'climbing', fly: (rig) => { rig.run(2); rig.input.pitch = 0.35; rig.run(0.6); rig.input.pitch = 0; rig.run(0.3); } },
  { id: 'diving', fly: (rig) => { rig.run(2); rig.input.pitch = -0.35; rig.run(0.6); rig.input.pitch = 0; rig.run(0.3); } },
  { id: 'banked', fly: (rig) => { rig.run(2); rig.input.roll = 0.8; rig.run(2.5); } },
]);

/** CLASSIC -> SIM from each CLASSIC state, hands off for 20 s at an assist level. */
function conversionMatrix(craft, assists) {
  const rows = [];
  for (const classicState of CLASSIC_STATES) {
    const rig = createControllerRig({ craft: craft.id, assists });
    classicState.fly(rig);
    const before = { speed: rig.telemetry.airspeed, pitch: rig.telemetry.pitch, roll: rig.telemetry.roll, vertical: rig.telemetry.verticalSpeed };
    rig.input.throttleTarget = null;
    rig.handsOff();
    rig.flight.setMode('sim');
    const watch = watchSim(rig, 20);
    log(`  ${craft.id} ${classicState.id} (${(before.speed * KMH).toFixed(0)} km/h, pitch ${before.pitch.toFixed(1)}, bank ${before.roll.toFixed(1)}, vs ${before.vertical.toFixed(1)}) -> SIM ${Math.round(assists * 100)} %: ${watch.minLoad.toFixed(2)}..${watch.maxLoad.toFixed(2)} g, ${(watch.minSpeed * KMH).toFixed(0)}..${(watch.maxSpeed * KMH).toFixed(0)} km/h, max vs ${watch.maxVertical.toFixed(1)}, aoa margin ${watch.minAoaMargin.toFixed(1)} deg, frame rotation ${watch.maxFrameRotation.toFixed(2)} deg, ${watch.altitudeChange.toFixed(0)} m`);
    rows.push({ state: classicState.id, before, watch });
  }
  return rows;
}

/** SIM (booted at cruise) -> CLASSIC: no arcade stall, smooth rendered pose, speed in the arcade range. */
function toClassic(craft) {
  const rig = createControllerRig({ craft: craft.id, mode: 'sim' });
  if (craft.inputProfile.throttle !== 'none') rig.controls.throttle = craft.spawn.cruiseThrottle ?? 0.6;
  rig.run(5, (lab) => lab.handsOff());
  const before = rig.telemetry.airspeed;
  rig.flight.setMode('classic');
  const previous = rig.flight.planeMesh.quaternion.clone();
  const previousPosition = rig.flight.planeMesh.position.clone();
  let maxRotation = 0;
  let maxStep = 0;
  let stalled = false;
  rig.run(3, (lab) => {
    lab.handsOff();
    const root = lab.flight.planeMesh;
    maxRotation = Math.max(maxRotation, previous.angleTo(root.quaternion) / DEG);
    maxStep = Math.max(maxStep, root.position.distanceTo(previousPosition));
    previous.copy(root.quaternion);
    previousPosition.copy(root.position);
    if (lab.state.player.stalled) stalled = true;
  });
  return { before, after: rig.state.player.speed, stalled: stalled || rig.events.stall > 0, maxRotation, maxStep };
}

/** 100 %, SIM boot at cruise, hands off 60 s in calm air: altitude change, zooms, speed. */
function pathHold(craft) {
  const rig = createControllerRig({ craft: craft.id, mode: 'sim' });
  if (craft.inputProfile.throttle !== 'none') rig.controls.throttle = craft.spawn.cruiseThrottle;
  const bootSpeed = rig.telemetry.airspeed || rig.model().flightData.airspeed;
  rig.run(1, (lab) => lab.handsOff());
  const watch = watchSim(rig, 60, { settle: 0 });
  return { bootSpeed, watch };
}

/** Soft crash respawn in SIM (optionally in a steady wind): airspeed and height after the fade, then 10 s hands off. */
function respawn(craft, wind = null) {
  const rig = createControllerRig({ craft: craft.id, mode: 'sim', wind });
  if (craft.inputProfile.throttle !== 'none') rig.controls.throttle = craft.spawn.cruiseThrottle;
  rig.run(2, (lab) => lab.handsOff());
  rig.flight.triggerSoftCrash('lab');
  rig.run(0.45, (lab) => lab.handsOff());
  const speed = rig.model().flightData.airspeed;
  const agl = rig.state.player.position.y - CONTROLLER_GROUND;
  rig.run(0.5, (lab) => lab.handsOff());
  const watch = watchSim(rig, 10);
  return { speed, agl, watch, crashes: rig.events.softCrash.length };
}

/** Relaunch in SIM: the glider's aerotow to release, the bush plane's airstart; then 10 s hands off. */
function relaunchTest(craft) {
  const rig = createControllerRig({ craft: craft.id, mode: 'sim', altitude: CONTROLLER_GROUND + 400 });
  if (craft.inputProfile.throttle !== 'none') rig.controls.throttle = craft.spawn.cruiseThrottle;
  rig.run(1, (lab) => lab.handsOff());
  rig.flight.relaunch();
  let released = false;
  rig.run(600, (lab) => {
    lab.handsOff();
    released = lab.events.relaunched.length > 0 && !lab.flight.isTowing();
    return released;
  });
  const speed = rig.model().flightData.airspeed;
  const method = rig.events.relaunched[0] ? rig.events.relaunched[0].method : 'none';
  const watch = watchSim(rig, 10);
  return { released, method, speed, watch };
}

/** SIM craft switch mid-flight at 100 %: glider -> bush plane -> glider, 10 s hands off after each. */
function craftSwitch() {
  const rig = createControllerRig({ craft: 'glider', mode: 'sim' });
  rig.controls.throttle = bushplane.spawn.cruiseThrottle;
  rig.run(3, (lab) => lab.handsOff());
  rig.flight.setCraft('bushplane');
  const toBush = { speed: rig.model().flightData.airspeed, watch: watchSim(rig, 10) };
  rig.flight.setCraft('glider');
  const toGlider = { speed: rig.model().flightData.airspeed, watch: watchSim(rig, 10) };
  return { toBush, toGlider };
}

/**
 * Start on ground at 100 %: full power, stick neutral to 24 m/s, 30 % aft stick until 30 m above
 * the ground, then hands off 15 s. Load, pitch and angle of attack from lift-off on.
 */
function groundTakeoff() {
  const rig = createControllerRig({ craft: 'bushplane', mode: 'sim', startOnGround: true });
  const model = rig.model();
  const startedOnGround = model.contact.onGround;
  let liftoff = NaN;
  let maxPitch = -Infinity;
  let maxLoad = 0;
  let minMargin = Infinity;
  let maxPitchRate = 0;
  let stalled = false;
  let released = NaN;
  let traceTimer = 0;
  rig.run(60, (lab) => {
    const data = lab.model().flightData;
    traceTimer -= FRAME;
    if (traceTimer <= 0) {
      traceTimer = 1;
      log(`  bushplane ground start t=${lab.time.toFixed(1)} onGround=${data.onGround} ias=${(data.airspeed * KMH).toFixed(0)} agl=${data.agl.toFixed(1)} pitch=${(data.pitch / DEG).toFixed(1)} g=${data.gLoad.toFixed(2)} stick=${lab.controls.pitch.toFixed(2)}`);
    }
    lab.controls.throttle = 1;
    lab.controls.roll = 0;
    lab.controls.yaw = 0;
    if (Number.isFinite(released)) lab.controls.pitch = 0;
    else lab.controls.pitch = data.airspeed > 24 ? 0.3 : 0;
    if (!data.onGround && !Number.isFinite(liftoff)) liftoff = lab.time;
    if (Number.isFinite(liftoff)) {
      maxPitch = Math.max(maxPitch, data.pitch / DEG);
      maxLoad = Math.max(maxLoad, data.gLoad);
      minMargin = Math.min(minMargin, (data.aoaCritical - data.aoa) / DEG);
      maxPitchRate = Math.max(maxPitchRate, Math.abs(data.pitchRate / DEG));
      if (data.stalled) stalled = true;
    }
    if (!Number.isFinite(released) && Number.isFinite(liftoff) && data.agl > 30) released = lab.time;
    return Number.isFinite(released) && lab.time - released > 15;
  });
  return { startedOnGround, liftoff, released, maxPitch, maxLoad, minMargin, maxPitchRate, stalled, crashes: rig.events.softCrash.length };
}

// ============================================================================================
// HOT-PLUG: the hands-off hold engages for the controller that was flying, only in the air
// ============================================================================================
const STICK = Object.freeze({ deviceKey: '044f-b10a', kind: 'hotas-stick', name: 'T.16000M' });
const THROTTLE_QUADRANT = Object.freeze({ deviceKey: '044f-b687', kind: 'hotas-throttle', name: 'TWCS Throttle' });
const OTHER_PAD = Object.freeze({ deviceKey: '045e-028e', kind: 'gamepad', name: 'Xbox 360 Controller' });

/** The live ControlState as the input system leaves it after a controller moved the axes. */
function flyWith(controls, device, axes) {
  const source = device.kind === 'gamepad' ? 'gamepad' : 'hotas';
  for (const axis of axes) {
    controls.sources[axis] = source;
    controls.sourceDevices[axis] = device.deviceKey;
  }
}

/**
 * SIM bush plane in the air flown by a HOTAS (stick on roll / pitch / yaw, TWCS on the throttle), at
 * full power so it flies faster than its cruise: an unrelated gamepad dropping out changes nothing;
 * the stick dropping out engages the hands-off hold at the speed flown, and its return releases it.
 * Then with the pilot's own autopilot on: the hold and its release keep the pilot's speed target.
 */
function hotPlugInFlight() {
  const rig = createControllerRig({ craft: 'bushplane', mode: 'sim' });
  rig.controls.throttle = 1;
  flyWith(rig.controls, STICK, ['roll', 'pitch', 'yaw']);
  flyWith(rig.controls, THROTTLE_QUADRANT, ['throttle']);
  rig.run(20, (lab) => lab.handsOff());
  rig.bus.emitTyped('deviceDisconnected', OTHER_PAD);
  const otherPad = rig.flight.isAssistOverridden();
  const speedBefore = rig.telemetry.airspeed;
  rig.bus.emitTyped('deviceDisconnected', STICK);
  const engaged = rig.flight.isAssistOverridden();
  const holdSpeed = rig.state.player.autopilot.speed;
  rig.run(5, (lab) => lab.handsOff());
  const holding = rig.flight.isAssistOverridden() && rig.state.player.autopilot.enabled;
  rig.bus.emitTyped('deviceConnected', STICK);
  const released = !rig.flight.isAssistOverridden() && !rig.state.player.autopilot.enabled;

  const pilotSpeed = 42;
  rig.flight.setAutopilot({ enabled: true, speed: pilotSpeed });
  rig.run(1, (lab) => lab.handsOff());
  rig.bus.emitTyped('deviceDisconnected', STICK);
  rig.run(1, (lab) => lab.handsOff());
  rig.bus.emitTyped('deviceConnected', STICK);
  const restored = rig.state.player.autopilot.enabled && rig.state.player.autopilot.speed === pilotSpeed;
  return { otherPad, engaged, speedBefore, holdSpeed, cruise: bushplane.spawn.cruise, holding, released, restored };
}

/**
 * SIM craft started on the ground and taxiing (or sitting) with the TWCS lever at `lever`: the stick
 * dropping out must not engage the autopilot (which would release the brake or lift off); the lever
 * above idle sets the parking brake instead, and the craft is still on the ground `seconds` later.
 */
function hotPlugOnGround(craftId, lever, seconds = 15) {
  const rig = createControllerRig({ craft: craftId, mode: 'sim', startOnGround: true });
  rig.controls.throttle = lever;
  flyWith(rig.controls, STICK, ['roll', 'pitch', 'yaw']);
  flyWith(rig.controls, THROTTLE_QUADRANT, ['throttle', 'collective']);
  // Moving the lever off its boot position releases the brake set at the ground start.
  rig.run(4, (lab) => lab.handsOff());
  const onGroundBefore = rig.telemetry.onGround;
  const taxiSpeed = rig.telemetry.groundSpeed;
  const startAgl = rig.telemetry.agl;
  rig.bus.emitTyped('deviceDisconnected', STICK);
  rig.frame();
  const overridden = rig.flight.isAssistOverridden();
  const autopilot = rig.state.player.autopilot.enabled;
  const braked = rig.telemetry.parkingBrake;
  let maxAgl = 0;
  rig.run(seconds, (lab) => {
    lab.handsOff();
    maxAgl = Math.max(maxAgl, lab.telemetry.agl - startAgl);
  });
  return { onGroundBefore, taxiSpeed, overridden, autopilot, braked, maxAgl, onGround: rig.telemetry.onGround, groundSpeed: rig.telemetry.groundSpeed };
}

// ============================================================================================
// HOVER CRAFT SIM -> CLASSIC: the CLASSIC hover model keeps hovering
// ============================================================================================
/** A hovering (or landed) SIM rotorcraft switched to CLASSIC: height change and speed over `seconds`. */
function hoverToClassic(craftId, { startOnGround = false, seconds = 5 } = {}) {
  const rig = createControllerRig({ craft: craftId, mode: 'sim', startOnGround });
  rig.run(3, (lab) => lab.handsOff());
  const simThrottle = rig.telemetry.throttle;
  rig.flight.setMode('classic');
  rig.run(0.6, (lab) => lab.handsOff());
  const start = rig.state.player.position.y;
  let maxSpeed = 0;
  rig.run(seconds, (lab) => {
    lab.handsOff();
    maxSpeed = Math.max(maxSpeed, lab.state.player.velocity.length());
  });
  const hover = craftRegistry.get(craftId).arcadeProfile.hover;
  return { simThrottle, classicThrottle: rig.state.player.throttle, heightChange: rig.state.player.position.y - start, maxSpeed, agl: rig.state.player.position.y - CONTROLLER_GROUND, minAgl: hover.MIN_AGL };
}

function describeLoads(watch) {
  return `${watch.minLoad.toFixed(2)}..${watch.maxLoad.toFixed(2)} g`;
}

function calmFlight(watch, { minLoad = 0.8, maxLoad = 1.3 } = {}) {
  return watch.minLoad >= minLoad && watch.maxLoad <= maxLoad && !watch.stalled && !watch.zoom && !watch.overspeed;
}

function handlingTests(name, craft) {
  const guard = protections(craft);
  record(name, '100 %: full aileron 4 s (bank protection)', guard.maxBank, 67, { unit: 'deg', compare: guard.maxBank <= 67 && guard.maxBank >= 55, note: `${guard.bankAt1500.toFixed(0)} deg after 1.5 s, holds ${guard.heldBank.toFixed(0)} deg` });
  record(name, '100 %: aileron released: springs back', guard.springBack, 4, { unit: 's', compare: 'max', note: `to 30 deg or less; ${guard.bankAfter.toFixed(1)} deg after 8 s` });
  record(name, '100 %: full aft stick 8 s (pitch protection)', guard.maxPitch, 31, { unit: 'deg', compare: guard.maxPitch <= 31 && !guard.pullStalled && guard.maxAoaMargin > 0, note: `max ${guard.maxLoad.toFixed(2)} g, AoA margin ${guard.maxAoaMargin.toFixed(1)} deg, ${guard.pullStalled ? 'STALLED' : 'no stall'}` });
  record(name, '100 %: full forward stick 6 s', guard.minPitch, -21, { unit: 'deg', compare: 'min', note: `min ${guard.minLoad.toFixed(2)} g` });
  const trimHold = autoTrimHold(craft);
  record(name, '50 %: auto-trim hold after a pull', trimHold.maxLoad, 1.3, { unit: 'g', compare: trimHold.maxLoad <= 1.3 && !trimHold.stalled, decimals: 2, note: `${trimHold.minLoad.toFixed(2)}..${trimHold.maxLoad.toFixed(2)} g after release; speed ${(trimHold.speed * KMH).toFixed(0)} km/h, phugoid swing ${(trimHold.speedSwing * KMH).toFixed(1)} km/h in 30-40 s (AoA hold, as at 0 %)` });

  for (const assists of [1, 0.75, 0.5]) {
    const rows = conversionMatrix(craft, assists);
    for (const row of rows) {
      const { watch, before } = row;
      // 50 % has no auto-level or speed protection (a banked switch spirals as the pilot left it); what
      // it promises is that the auto-trim never trims the converted state into more than 1.3 g. 75 %
      // blends the two and is held to the 50 % promise.
      const pass = assists === 1 ? calmFlight(watch) : watch.maxLoad <= 1.3 && !watch.stalled;
      const from = `${(before.speed * KMH).toFixed(0)} km/h, pitch ${before.pitch.toFixed(0)}, bank ${before.roll.toFixed(0)}`;
      record(name, `CLASSIC -> SIM ${Math.round(assists * 100)} %, ${row.state}`, describeLoads(watch), assists === 1 ? '0.8..1.3 g' : '<= 1.3 g', { compare: pass, note: `from ${from}: ${(watch.minSpeed * KMH).toFixed(0)}..${(watch.maxSpeed * KMH).toFixed(0)} km/h, ${watch.stalled ? 'STALL' : 'no stall'}, ${watch.zoom ? 'ZOOM' : 'no zoom'} (max vs ${watch.maxVertical.toFixed(1)} m/s), max ${watch.maxFrameRotation.toFixed(1)} deg/frame` });
    }
  }
  const back = toClassic(craft);
  record(name, 'SIM -> CLASSIC at SIM cruise', back.maxRotation, 3, { unit: 'deg/frame', compare: back.maxRotation <= 3 && !back.stalled, decimals: 2, note: `${(back.before * KMH).toFixed(0)} -> ${(back.after * KMH).toFixed(0)} km/h, ${back.stalled ? 'arcade STALL' : 'no arcade stall'}, max step ${back.maxStep.toFixed(2)} m/frame` });

  const hold = pathHold(craft);
  const cruiseKmh = craft.spawn.cruise * KMH;
  record(name, 'SIM boot speed', hold.bootSpeed * KMH, cruiseKmh, { unit: 'km/h', tolerance: 0.03, note: 'spawn.cruise, not CLASSIC 223 km/h' });
  const altitudeLimit = craft === glider ? 45 : 15;
  record(name, '100 % hands off 60 s: altitude change', Math.abs(hold.watch.altitudeChange), altitudeLimit, { unit: 'm', compare: Math.abs(hold.watch.altitudeChange) <= altitudeLimit && calmFlight(hold.watch), note: `${hold.watch.altitudeChange.toFixed(1)} m, ${describeLoads(hold.watch)}, max vs ${hold.watch.maxVertical.toFixed(2)} m/s, ${(hold.watch.minSpeed * KMH).toFixed(0)}..${(hold.watch.maxSpeed * KMH).toFixed(0)} km/h` });
  const again = respawn(craft);
  record(name, 'SIM respawn after a soft crash', again.speed * KMH, cruiseKmh, { unit: 'km/h', tolerance: 0.03, note: `${again.agl.toFixed(0)} m AGL; next 10 s ${describeLoads(again.watch)}, ${calmFlight(again.watch) ? 'calm' : 'NOT CALM'}` });
  record(name, 'SIM respawn: hands off 10 s', describeLoads(again.watch), '0.8..1.3 g', { compare: again.crashes === 1 && Math.abs(again.agl - 300) < 5 && calmFlight(again.watch), note: `${again.crashes} soft crash` });
  const windy = respawn(craft, new THREE.Vector3(6, 0, 5));
  record(name, 'SIM respawn in a 7.8 m/s wind: airspeed', windy.speed * KMH, `${cruiseKmh.toFixed(0)} km/h +/-3%`, { unit: 'km/h', compare: Math.abs(windy.speed - craft.spawn.cruise) <= craft.spawn.cruise * 0.03 && calmFlight(windy.watch), note: `cruise is an airspeed; next 10 s ${describeLoads(windy.watch)}` });
  const relaunched = relaunchTest(craft);
  record(name, `SIM relaunch (${relaunched.method})`, relaunched.speed * KMH, `${cruiseKmh.toFixed(0)} km/h +/-5%`, { unit: 'km/h', compare: relaunched.released && Math.abs(relaunched.speed - craft.spawn.cruise) <= craft.spawn.cruise * 0.05 && calmFlight(relaunched.watch), note: `then 10 s hands off: ${describeLoads(relaunched.watch)}, ${relaunched.watch.stalled ? 'STALL' : 'no stall'}` });
}

// ============================================================================================
// SUITES
// ============================================================================================
function runGlider() {
  const name = 'glider';
  const targets = glider.simProfile.targets;
  const mass = glider.simProfile.mass;
  const dryMass = mass.empty + mass.pilot;
  const fullMass = dryMass + glider.simProfile.ballast.capacity;
  const dryStall = stallSpeed(glider, { ballast: 0 });
  record(name, `stall speed, dry (${dryMass} kg)`, dryStall.speed * KMH, targets.stallSpeed * KMH, { unit: 'km/h', note: dryStall.stalled ? 'CLmax reached' : 'elevator limited' });
  const fullStall = stallSpeed(glider, { ballast: 1 });
  record(name, `stall speed, full ballast (${fullMass} kg)`, fullStall.speed * KMH, targets.stallSpeed * KMH, { unit: 'km/h', note: fullStall.stalled ? 'CLmax reached' : 'elevator limited' });
  const polar = gliderPolar(0);
  record(name, 'best L/D, dry', polar.best.ratio, targets.liftToDrag, { note: `at ${(polar.best.speed * KMH).toFixed(0)} km/h` });
  record(name, 'min sink, dry', polar.minimum.sink, targets.minSink, { unit: 'm/s', decimals: 2, note: `at ${(polar.minimum.speed * KMH).toFixed(0)} km/h` });
  const heavy = gliderPolar(1);
  record(name, 'best L/D, full ballast', heavy.best.ratio, targets.liftToDrag, { note: `at ${(heavy.best.speed * KMH).toFixed(0)} km/h` });
  record(name, 'min sink, full ballast', heavy.minimum.sink, targets.minSink, { unit: 'm/s', decimals: 2, note: `at ${(heavy.minimum.speed * KMH).toFixed(0)} km/h` });
  const spoilers = steadyGlide(glider, 28, { spoilers: 1 });
  record(name, 'glide ratio, full spoilers', spoilers.ratio, 12, { compare: 'max', note: 'at 101 km/h' });
  const clean = dive(glider, { pitch: -45 });
  record(name, 'Vne: 45 deg dive, clean', clean.top * KMH, targets.vne * KMH, { unit: 'km/h', compare: clean.overspeed && clean.telemetryOverspeed, note: `exceeds Vne ${(targets.vne * KMH).toFixed(0)} km/h -> overspeed warning ${clean.overspeed ? 'on' : 'off'}, flutter buffet` });
  const braked = dive(glider, { pitch: -45, spoilers: 1 });
  record(name, 'Vne: 45 deg dive, spoilers out', braked.top * KMH, targets.vne * KMH, { unit: 'km/h', compare: 'max', note: 'spoilers hold it below Vne' });
  const systems = gliderSystems();
  record(name, 'spoilers: both toe brakes in the air', systems.bothToes, 'one toe 0, both 1, released 0, airbrake 1', { decimals: 2, compare: systems.oneToe === 0 && systems.bothToes > 0.99 && systems.released === 0 && systems.held > 0.99, note: `one toe ${systems.oneToe}, released ${systems.released}, airbrake held ${systems.held.toFixed(2)}` });
  record(name, 'no flaps / no engine notices', systems.notices.length, 2, { decimals: 0, compare: systems.notices.length === 2, note: systems.notices.join(' | ') });
  commonTests(name, glider);
  handlingTests(name, glider);
}

function runBushplane() {
  const name = 'bushplane';
  const targets = bushplane.simProfile.targets;
  const flapped = stallSpeed(bushplane, { flaps: 3 });
  record(name, 'stall speed, full flaps', flapped.speed * KMH, targets.stallSpeedFullFlaps * KMH, { unit: 'km/h', note: flapped.stalled ? 'CLmax reached' : 'elevator limited (min speed)' });
  const clean = stallSpeed(bushplane, { flaps: 0 });
  record(name, 'stall speed, clean', clean.speed * KMH, targets.stallSpeedClean * KMH, { unit: 'km/h', note: clean.stalled ? 'CLmax reached (profile target)' : 'elevator limited (min speed)' });
  const cruise = levelCruise(bushplane, 0.75);
  record(name, 'cruise, 75 % power, level', cruise.speed * KMH, targets.cruiseSpeed * KMH, { unit: 'km/h', note: `altitude held within ${Math.abs(cruise.altitudeError).toFixed(1)} m` });
  let best = { climb: -Infinity };
  for (let speed = 26; speed <= 40; speed += 2) {
    const climb = climbAt(bushplane, speed);
    log(`  bush plane climb ${speed} m/s: ${climb.climb.toFixed(2)} m/s`);
    if (climb.climb > best.climb) best = climb;
  }
  record(name, 'climb, full power', best.climb, targets.climbRate, { unit: 'm/s', decimals: 2, note: `best at ${(best.speed * KMH).toFixed(0)} km/h` });
  const diveResult = dive(bushplane, { pitch: -35 });
  record(name, 'Vne: 35 deg dive, idle', diveResult.top * KMH, targets.vne * KMH, { unit: 'km/h', compare: diveResult.overspeed, note: `overspeed warning ${diveResult.overspeed ? 'on' : 'off'} past ${(targets.vne * KMH).toFixed(0)} km/h` });
  const systems = bushSystems();
  record(name, 'flaps: 3 presses -> notch 3, travel', systems.deployed, 1, { decimals: 2, compare: systems.notch === 3 && systems.halfway > 0.3 && systems.halfway < 0.7 && systems.deployed > 0.99, note: `notch ${systems.notch}, ${systems.halfway.toFixed(2)} after 1.5 s, ${systems.deployed.toFixed(2)} after 3.5 s (3 s travel)` });
  record(name, 'flap lever with notch hysteresis', systems.lever.join(' '), '3 1 1 2 0', { compare: systems.lever.join(' ') === '3 1 1 2 0', note: 'lever at 1, 0.36, 0.45 (held), 0.62, 0.02' });
  record(name, 'engine off / restart', systems.on.rpm, 'off: windmill, on: power', { decimals: 2, compare: !systems.off.running && systems.off.rpm < 0.4 && systems.off.notify && systems.on.running && systems.on.rpm > 0.6, note: `off: rpm ${systems.off.rpm.toFixed(2)} (windmilling), on: rpm ${systems.on.rpm.toFixed(2)}` });
  const retract = retractableGear();
  record(name, 'retractable gear variant: transit, drag, belly', retract.speedUp * KMH, 'faster with the gear up', { unit: 'km/h', compare: retract.onGround.gear.down && retract.onGround.refused && retract.inTransit.transit > 0.5 && !retract.retracted.down && retract.retracted.transit === 0 && retract.speedUp > retract.speedDown && retract.strike !== null, note: `stays down on the ground; ${retract.inTransit.transit.toFixed(2)} transit at 2 s, up at 5 s; cruise ${(retract.speedDown * KMH).toFixed(0)} -> ${(retract.speedUp * KMH).toFixed(0)} km/h; wheels-up: ${describeStrike(retract.strike)}` });
  const departure = takeoff();
  record(name, 'take-off ground roll (flaps 1)', departure.liftoff ? departure.liftoff.distance : Infinity, 130, { unit: 'm', compare: 'max', decimals: 0, note: departure.liftoff ? `lift-off at ${(departure.liftoff.speed * KMH).toFixed(0)} km/h` : 'no lift-off' });
  record(name, 'take-off distance to 15 m', departure.clear ? departure.clear.distance : Infinity, 300, { unit: 'm', compare: 'max', decimals: 0, note: describeStrike(departure.strike) });
  const taxi = crosswindTaxi();
  record(name, 'crosswind taxi, 6 m/s from the right', taxi.maxError, 5, { unit: 'deg', compare: 'max', note: `rudder + differential brakes, ${describeStrike(taxi.strike)}, ${taxi.speed.toFixed(1)} m/s` });
  commonTests(name, bushplane);
  handlingTests(name, bushplane);
  const start = groundTakeoff();
  record(name, 'start on ground, 100 %: take-off', start.maxPitch, 30.5, { unit: 'deg', compare: start.startedOnGround && Number.isFinite(start.liftoff) && start.maxPitch <= 30.5 && start.maxLoad <= 2 && !start.stalled && start.minMargin > 0 && start.crashes === 0, note: `lift-off at ${start.liftoff.toFixed(1)} s; after it max ${start.maxLoad.toFixed(2)} g, pitch rate ${start.maxPitchRate.toFixed(1)} deg/s, AoA margin ${start.minMargin.toFixed(1)} deg, ${start.stalled ? 'STALL' : 'no stall'}` });
}

function runShared() {
  const name = 'both';
  const plug = hotPlugInFlight();
  for (const [craftId, lever] of [['bushplane', 0.6], ['helicopter', 0.3]]) {
    const parked = hotPlugOnGround(craftId, lever);
    record(name, `hot-plug on the ground: ${craftId}, lever ${lever}`, parked.overridden || parked.autopilot ? 'autopilot' : parked.braked ? 'parking brake' : 'no brake', 'parking brake, stays down', { compare: parked.onGroundBefore && !parked.overridden && !parked.autopilot && parked.braked && parked.onGround && parked.maxAgl < 1 && parked.groundSpeed < 1, note: `taxiing at ${parked.taxiSpeed.toFixed(1)} m/s; 15 s later: ${parked.onGround ? 'on the ground' : 'AIRBORNE'}, rose ${parked.maxAgl.toFixed(2)} m, ${parked.groundSpeed.toFixed(1)} m/s` });
  }
  const fpvHover = hoverToClassic('fpv');
  record(name, 'SIM -> CLASSIC: FPV hovering', Math.abs(fpvHover.heightChange), 1, { unit: 'm', compare: 'max', decimals: 2, note: `SIM motor throttle ${fpvHover.simThrottle.toFixed(2)} -> CLASSIC ${fpvHover.classicThrottle.toFixed(2)}; ${fpvHover.heightChange.toFixed(2)} m in 5 s, max ${fpvHover.maxSpeed.toFixed(1)} m/s` });
  const heliParked = hoverToClassic('helicopter', { startOnGround: true });
  record(name, 'SIM -> CLASSIC: helicopter on the ground', heliParked.maxSpeed, '<= 1 m/s, near the hover floor', { unit: 'm/s', compare: heliParked.maxSpeed <= 1 && heliParked.agl >= heliParked.minAgl && heliParked.agl <= heliParked.minAgl + 3, decimals: 2, note: `hovers ${heliParked.agl.toFixed(1)} m above the ground (floor ${heliParked.minAgl} m), max ${heliParked.maxSpeed.toFixed(2)} m/s` });
  record(name, 'hot-plug hold: speed target', plug.holdSpeed * KMH, `${(plug.speedBefore * KMH).toFixed(1)} km/h +/-1%, pilot's kept`, { unit: 'km/h', note: `flying ${(plug.speedBefore * KMH).toFixed(0)} km/h (cruise ${(plug.cruise * KMH).toFixed(0)}); the pilot's own autopilot speed ${plug.restored ? 'kept' : 'LOST'} after a hold`, compare: Math.abs(plug.holdSpeed - plug.speedBefore) <= plug.speedBefore * 0.01 && plug.restored });
  record(name, 'hot-plug: HOTAS stick unplugged in flight', plug.engaged ? 'hold' : 'no hold', 'hold; other pad: no hold; release on reconnect', { compare: !plug.otherPad && plug.engaged && plug.holding && plug.released, note: `other gamepad ${plug.otherPad ? 'ENGAGED' : 'ignored'}, stick: ${plug.engaged ? 'hands-off hold' : 'NOTHING'}, ${plug.holding ? 'held 5 s' : 'NOT HELD'}, reconnect ${plug.released ? 'released' : 'NOT RELEASED'}` });
  const swap = craftSwitch();
  record(name, 'SIM craft switch glider -> bush plane', swap.toBush.speed * KMH, `${(bushplane.spawn.cruise * KMH).toFixed(0)} km/h, calm`, { unit: 'km/h', compare: calmFlight(swap.toBush.watch), note: `10 s hands off: ${describeLoads(swap.toBush.watch)}, ${swap.toBush.watch.stalled ? 'STALL' : 'no stall'}` });
  record(name, 'SIM craft switch bush plane -> glider', swap.toGlider.speed * KMH, `${(glider.spawn.cruise * KMH).toFixed(0)} km/h, calm`, { unit: 'km/h', compare: calmFlight(swap.toGlider.watch), note: `10 s hands off: ${describeLoads(swap.toGlider.watch)}, ${swap.toGlider.watch.stalled ? 'STALL' : 'no stall'}` });
}

function commonTests(name, craft) {
  const stability = handsOff(craft);
  record(name, 'hands-off: AoA settles after a pitch pulse', stability.aoaSettleSeconds, 5, { unit: 's', compare: 'max', note: `within 1 deg of trim ${stability.trimAoa.toFixed(1)} deg (${(stability.trimSpeed * KMH).toFixed(0)} km/h); pulse peak ${stability.peakAoa.toFixed(1)} deg` });
  record(name, 'hands-off: phugoid speed swing, 45-90 s', stability.phugoidSecond * KMH, stability.phugoidFirst * KMH * 1.1, { unit: 'km/h', compare: 'max', note: `0-45 s swing ${(stability.phugoidFirst * KMH).toFixed(1)} km/h: ${stability.phugoidSecond < stability.phugoidFirst * 0.9 ? 'damped' : 'lightly damped / neutral'}` });
  record(name, 'hands-off: bank 20 s after release', Math.abs(stability.bankAfter), Math.abs(stability.bankStart), { unit: 'deg', compare: 'max', note: `released at ${stability.bankStart.toFixed(1)} deg: spiral ${Math.abs(stability.bankAfter) < Math.abs(stability.bankStart) ? 'stable' : 'unstable'}` });
  const levelling = autoLevel(craft);
  record(name, '100 % assists: auto-level from 30 deg', levelling.levelSeconds, 8, { unit: 's', compare: 'max', note: `bank after 15 s ${levelling.bankAfter.toFixed(1)} deg` });
  const spinResult = spin(craft, { assists: 0 });
  record(name, 'spin at 0 % assists (turn rate)', Math.abs(spinResult.spinRate), 50, { unit: 'deg/s', compare: spinResult.spinning, decimals: 0, note: `${spinResult.turns.toFixed(1)} turns in 10 s, AoA up to ${spinResult.maxAoa.toFixed(0)} deg (critical ${spinResult.critical.toFixed(0)})` });
  record(name, 'spin recovery (opposite rudder, stick forward)', spinResult.recoverySeconds, 5, { unit: 's', compare: 'max', note: `${spinResult.altitudeLost.toFixed(0)} m lost incl. pull-out, level after: ${spinResult.levelAfter}` });
  const protectedSpin = spin(craft, { assists: 1 });
  record(name, 'same inputs at 100 % assists', protectedSpin.maxAoa, protectedSpin.critical, { unit: 'deg', compare: 'max', note: protectedSpin.spinning ? 'spun!' : `AoA limiter: no spin (${protectedSpin.turns.toFixed(1)} turns)` });
  const arrival = landing(craft);
  record(name, 'landing: touchdown grade', arrival.landed ? arrival.landed.sinkRate : Infinity, 1.2, { unit: 'm/s', compare: 'max', decimals: 2, note: arrival.landed ? `${arrival.landed.grade}, toast "${arrival.toast}"` : 'no landed event' });
  record(name, 'landing roll with brakes', arrival.roll ?? Infinity, craft === bushplane ? 120 : 200, { unit: 'm', compare: 'max', decimals: 0, note: describeStrike(arrival.strike) });
  const hold = autopilotHold(craft);
  record(name, 'autopilot heading +90 deg', hold.settled.heading, 2, { unit: 'deg', compare: 'max', decimals: 2, note: `max bank ${hold.settled.maxBank.toFixed(0)} deg, max ${hold.settled.maxLoad.toFixed(2)} g` });
  if (craft === bushplane) record(name, 'autopilot altitude +150 m', Math.abs(hold.settled.altitude), 10, { unit: 'm', compare: 'max', decimals: 1 });
  record(name, 'autopilot speed hold', Math.abs(hold.settled.speed), 2, { unit: 'm/s', compare: 'max', decimals: 2, note: craft === glider ? 'pitch holds speed (no engine)' : 'throttle PI' });
  record(name, 'autopilot engage in a 60 deg spiral dive', hold.recovery.levelSeconds, 8, { unit: 's', compare: 'max', note: `to bank < 35 deg and path > -5 deg; ${hold.recovery.minLoad.toFixed(2)}..${hold.recovery.maxLoad.toFixed(2)} g (limit ${hold.recovery.gLimit})` });
  const ringPass = ringFollowing(craft);
  record(name, 'autopilot ring following', ringPass.miss, 16, { unit: 'm', compare: 'max', note: 'through a 16 m ring 900 m ahead, 150 m off the track' });
  const parked = rest(craft);
  record(name, 'parked 10 s: creep', parked.moved, 0.3, { unit: 'm', compare: 'max', decimals: 3, note: `${parked.contacts} contacts, max bounce ${parked.maxVertical.toFixed(3)} m/s, ${describeStrike(parked.strike)}` });
}

// ============================================================================================
// REPORT
// ============================================================================================
function printTable() {
  const columns = [
    { key: 'craft', title: 'craft' },
    { key: 'test', title: 'test' },
    { key: 'measured', title: 'measured' },
    { key: 'target', title: 'target' },
    { key: 'status', title: 'result' },
    { key: 'note', title: 'notes' },
  ];
  const rows = results.map((row) => ({ ...row, status: row.pass ? 'PASS' : 'FAIL' }));
  const widths = columns.map((column) => Math.max(column.title.length, ...rows.map((row) => String(row[column.key]).length)));
  const line = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join(' | ');
  process.stdout.write(`${line(columns.map((column) => column.title))}\n`);
  process.stdout.write(`${widths.map((width) => '-'.repeat(width)).join('-|-')}\n`);
  for (const row of rows) process.stdout.write(`${line(columns.map((column) => row[column.key]))}\n`);
  const failed = rows.filter((row) => !row.pass).length;
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} checks within target (sea-level standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
if (OPTIONS.craft === 'all' || OPTIONS.craft === 'glider') runGlider();
if (OPTIONS.craft === 'all' || OPTIONS.craft === 'bushplane') runBushplane();
if (OPTIONS.craft === 'all' || OPTIONS.craft === 'shared') runShared();
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
