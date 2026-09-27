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
//   autopilot    heading, altitude and speed hold through the flight model; engagement from a dive
//   rest         parked on its gear for 10 s: settles without bouncing, creeping or striking
//
// Usage: node tools/flight-lab.mjs [--craft glider|bushplane|all] [--verbose]
// Prints a table (measured vs target, tolerance about 10 %) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import glider from '../src/craft/glider.js';
import bushplane from '../src/craft/bushplane.js';
import { flightModels } from '../src/flight/models.js';
import { createControlState, copyControlState } from '../src/input/controlState.js';
import { createFlightTelemetry } from '../src/flight/telemetry.js';
import { EventBus } from '../src/core/eventBus.js';
import { attachTypedEvents } from '../src/core/events.js';
import { groundPose, restPitch } from '../src/flight/placement.js';
import { describeAssists } from '../src/flight/assists.js';
import { DEG, clamp } from '../src/core/util.js';

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
  if (options.craft !== 'all' && !CRAFT[options.craft]) throw new Error(`Unknown craft ${options.craft}`);
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
  commonTests(name, glider);
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
  const departure = takeoff();
  record(name, 'take-off ground roll (flaps 1)', departure.liftoff ? departure.liftoff.distance : Infinity, 130, { unit: 'm', compare: 'max', decimals: 0, note: departure.liftoff ? `lift-off at ${(departure.liftoff.speed * KMH).toFixed(0)} km/h` : 'no lift-off' });
  record(name, 'take-off distance to 15 m', departure.clear ? departure.clear.distance : Infinity, 300, { unit: 'm', compare: 'max', decimals: 0, note: describeStrike(departure.strike) });
  const taxi = crosswindTaxi();
  record(name, 'crosswind taxi, 6 m/s from the right', taxi.maxError, 5, { unit: 'deg', compare: 'max', note: `rudder + differential brakes, ${describeStrike(taxi.strike)}, ${taxi.speed.toFixed(1)} m/s` });
  commonTests(name, bushplane);
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
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
