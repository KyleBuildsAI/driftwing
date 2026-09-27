// Jet flight lab: flies the jet's SIM model (SimFixedWing plus the jet extension) headless in node
// with scripted controls through the same control stages the game runs every physics tick (the PID
// autopilot and the assists), and prints its measured performance against the spec.
//
// The air follows the game's atmosphere (rho = 1.225 exp(-h / 8500), standard speed of sound) with
// no wind, over flat ground far below unless a test takes off or lands. Physics runs at 120 Hz.
//
// Tests:
//   top speed      afterburner, level: about 1300 km/h at sea level, about Mach 1.6 at 10 km
//   acceleration   sea level 400 -> 1000 km/h and 10 km Mach 0.9 -> 1.4, afterburner
//   spool          idle to 95 % military thrust (engine spool lag)
//   drag rise      the transonic drag-rise curve (zero-lift drag against Mach) and level-flight drag
//   turns          sustained turn rate (afterburner, sea level, Mach 0.8) and instantaneous turn rate
//                  at corner speed
//   G limit        100 % assists: the G limiter holds 9 g; 0 % assists: over 9 g buffets and warns
//   high AoA       critical angle of attack; 100 % assists keep it below; wing rock at 0 %
//   takeoff        lift-off speed and roll (half flaps, afterburner)
//   landing        touchdown speed and grade (full flaps, 13 degrees angle of attack)
//   ground         parked on the gear without creeping; nose-wheel steering on the rudder
//   gear           transit time, stays down on the ground, gear drag
//   speed brake    extra drag on the airbrake
//   AB detent      keyboard stops at the detent; the ability pushes through and pulling back cancels;
//                  a HOTAS lever lights it past the detent; the click state and notices
//   autopilot      heading, altitude and speed hold through the flight control system
//   limits         overspeed past 410 m/s equivalent or Mach 1.7
//
// Usage: node tools/lab/jet.mjs [--verbose]
// Prints a table (measured vs target, tolerance about 10 %) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import jet from '../../src/craft/jet.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity, speedOfSound } from '../../src/flight/telemetry.js';
import { waveDrag, thrustFactor } from '../../src/flight/jetAero.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { groundPose } from '../../src/flight/placement.js';
import { DEG, clamp } from '../../src/core/util.js';

const DT = 1 / 120;
const KMH = 3.6;
const TOLERANCE = 0.1;
const VERBOSE = process.argv.includes('--verbose');
const profile = jet.simProfile;

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
/**
 * The jet in the lab: model, the pilot's ControlState, the tick copy the control stages shape and the
 * environment. `ground` is the flat ground height (far below for air tests).
 */
function createRig({ assists = 0, ground = -3000 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = jet.abilities.craftAbility.initialState();
  const world = { groundHeight: () => ground, heightAt: () => ground };
  const model = flightModels.create(profile.model, { profile, craft: jet, world, bus, state: null, input: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: ground - 100, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft: jet, craftId: jet.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { model, data: model.flightData, pilot, controls, env, context, events, telemetry, craftState, time: 0 };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    rig.time += DT;
  };
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
  rig.airborne = ({ speed, altitude, throttle = 0.6, heading = 0, pitch = 0, bank = 0 }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  rig.parked = () => {
    const pose = groundPose(world, profile.contacts, 0, 0, 0, profile.centerOfMass[2]);
    model.reset({ position: pose.position, quaternion: pose.quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = 0;
  };
  rig.selectFlaps = (notch) => {
    for (let step = 0; step < 3; step++) {
      pilot.actions.add('flapsUp');
      rig.tick();
    }
    for (let step = 0; step < notch; step++) {
      pilot.actions.add('flapsDown');
      rig.tick();
    }
  };
  /** Full afterburner the way a keyboard pilot gets it: lever to the stop, Space through the detent. */
  rig.afterburner = () => {
    pilot.throttle = 1;
    craftState.abRequest = 'toggle';
  };
  rig.mach = () => rig.data.airspeed / speedOfSound(model.state.position.y);
  rig.writeTelemetry = () => {
    model.writeTelemetry(telemetry);
    return telemetry;
  };
  return rig;
}

// ============================================================================================
// TEST PILOT
// ============================================================================================
function createPid(kp, ki, kd, min = -1, max = 1) {
  let integral = 0;
  let previous = NaN;
  return {
    reset(value = 0) {
      integral = value;
      previous = NaN;
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

/** Wings level (or a bank target) with the flaperons, the ball centred with the rudder. */
function createLateralPilot({ bankGain = 1.2, rateGain = 0.25, sideslipGain = 3 } = {}) {
  return {
    bank: 0,
    fly(rig) {
      const data = rig.data;
      rig.pilot.roll = clamp(bankGain * (this.bank * DEG - data.bank) - rateGain * data.rollRate, -1, 1);
      rig.pilot.yaw = clamp(sideslipGain * data.sideslip, -1, 1);
    },
  };
}

/**
 * Holds an altitude with the elevator: altitude error -> flight path -> pitch rate, scaled by the
 * dynamic pressure so it stays calm from take-off speed to Mach 1.6.
 */
function createAltitudePilot(target) {
  const pid = createPid(0.0, 0.25, 0);
  return {
    target,
    fly(rig) {
      const data = rig.data;
      const speed = Math.max(data.airspeed, 50);
      const desiredPath = clamp((this.target - rig.model.state.position.y) / (speed * 6), -0.08, 0.08);
      const pathError = desiredPath - data.flightPath;
      const q = Math.max(data.dynamicPressure, 2000);
      const gain = clamp(20000 / q, 0.05, 1.5);
      const trim = pid.update(pathError * gain, DT);
      rig.pilot.pitch = clamp(trim + gain * (2.5 * pathError - 0.6 * data.pitchRate), -1, 1);
    },
  };
}

/** Holds an angle of attack (degrees) with the elevator. */
function createAoaPilot(target) {
  const pid = createPid(1.5, 2.5, 0);
  return {
    target,
    fly(rig) {
      rig.pilot.pitch = pid.update((this.target - rig.data.aoa / DEG) * DEG, DT, NaN) - 0.3 * rig.data.pitchRate;
    },
  };
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = TOLERANCE, compare = 'within', note = '', decimals = 1 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else if (compare === 'range') pass = measured >= target[0] && measured <= target[1];
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  const withUnit = (value) => `${format(value)}${unit ? ` ${unit}` : ''}`;
  let targetText;
  if (compare === 'within') targetText = `${withUnit(target)} +/-${Math.round(tolerance * 100)}%`;
  else if (compare === 'max') targetText = `<= ${withUnit(target)}`;
  else if (compare === 'min') targetText = `>= ${withUnit(target)}`;
  else if (compare === 'range') targetText = `${format(target[0])}..${withUnit(target[1])}`;
  else targetText = String(target);
  results.push({ test, measured: withUnit(measured), target: targetText, pass, note });
}

// ============================================================================================
// TESTS
// ============================================================================================
/** Level flight in afterburner until the speed stops rising: returns { airspeed, mach, seconds }. */
function topSpeed(altitude, startSpeed) {
  const rig = createRig();
  rig.airborne({ speed: startSpeed, altitude, throttle: 1 });
  rig.afterburner();
  const lateral = createLateralPilot();
  const level = createAltitudePilot(altitude);
  let lastCheck = 0;
  let lastSpeed = 0;
  let seconds = 0;
  rig.run(600, (lab) => {
    lateral.fly(lab);
    level.fly(lab);
    seconds = lab.time;
    if (lab.time - lastCheck >= 10) {
      const gained = lab.data.airspeed - lastSpeed;
      lastSpeed = lab.data.airspeed;
      lastCheck = lab.time;
      log(`  top speed ${altitude} m: t ${lab.time.toFixed(0)} s, ${lab.data.airspeed.toFixed(1)} m/s, M ${lab.mach().toFixed(3)}, alt ${lab.model.state.position.y.toFixed(0)}`);
      if (lab.time > 30 && Math.abs(gained) < 0.3) return true;
    }
    return false;
  });
  return { airspeed: rig.data.airspeed, mach: rig.mach(), seconds, altitude: rig.model.state.position.y, afterburner: rig.writeTelemetry().afterburner };
}

function testTopSpeeds() {
  const seaLevel = topSpeed(0, 300);
  record('top speed, sea level, afterburner', seaLevel.airspeed * KMH, 1300, { unit: 'km/h', decimals: 0, note: `Mach ${seaLevel.mach.toFixed(2)}, afterburner lit ${seaLevel.afterburner}, settled after ${seaLevel.seconds.toFixed(0)} s` });
  const high = topSpeed(10000, 400);
  record('top speed at 10 km, afterburner', high.mach, 1.6, { unit: 'Mach', decimals: 2, note: `${(high.airspeed * KMH).toFixed(0)} km/h true at ${high.altitude.toFixed(0)} m` });
  const eleven = topSpeed(11000, 400);
  record('top speed at 11 km, afterburner', eleven.mach, 1.6, { unit: 'Mach', decimals: 2, note: `${(eleven.airspeed * KMH).toFixed(0)} km/h true` });
}

/** Seconds from `from` to `to` m/s in level flight with afterburner at `altitude`. */
function accelerationTime(altitude, from, to) {
  const rig = createRig();
  rig.airborne({ speed: from, altitude, throttle: 1 });
  rig.afterburner();
  const lateral = createLateralPilot();
  const level = createAltitudePilot(altitude);
  let time = NaN;
  rig.run(300, (lab) => {
    lateral.fly(lab);
    level.fly(lab);
    if (lab.data.airspeed >= to) {
      time = lab.time;
      return true;
    }
    return false;
  });
  return time;
}

function testAcceleration() {
  const seaLevel = accelerationTime(0, 400 / KMH, 1000 / KMH);
  record('acceleration 400 -> 1000 km/h, sea level', seaLevel, [16, 30], { unit: 's', compare: 'range', note: 'afterburner, level (F-16 class about 20 s)' });
  const a10 = speedOfSound(10000);
  const high = accelerationTime(10000, 0.9 * a10, 1.3 * a10);
  record('acceleration Mach 0.9 -> 1.3, 10 km', high, [40, 110], { unit: 's', compare: 'range', note: 'afterburner, level, through the drag rise (a Mach 1.6 jet: little excess thrust up there)' });
}

function testSpool() {
  const rig = createRig();
  rig.airborne({ speed: 150, altitude: 3000, throttle: 0 });
  rig.run(8);
  const idleShare = rig.model.flightData.throttle;
  rig.pilot.throttle = 1;
  let reached = NaN;
  rig.run(20, (lab) => {
    const thrust = lab.craftState.thrust;
    const military = profile.jet.engine.dryThrust * thrustFactor(profile.jet.engine, airDensity(lab.model.state.position.y), lab.mach());
    if (thrust >= 0.95 * military) {
      reached = lab.time - 8;
      return true;
    }
    return false;
  });
  record('engine spool idle -> 95 % military thrust', reached, 4, { unit: 's', note: `lever ${idleShare.toFixed(2)} -> 0.95 (the detent)` });
  // Afterburner light-off after the core is at speed.
  rig.afterburner();
  const start = rig.time;
  let lit = NaN;
  rig.run(5, (lab) => {
    if (lab.writeTelemetry().afterburner) {
      lit = lab.time - start;
      return true;
    }
    return false;
  });
  record('afterburner light-off delay', lit, [0.2, 0.8], { unit: 's', compare: 'range', decimals: 2 });
}

function testDragRise() {
  const cd0 = profile.aero.cd0;
  const machs = [0.6, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0];
  const curve = machs.map((mach) => `${mach.toFixed(2)}:${(cd0 + waveDrag(profile.jet.transonic, mach)).toFixed(4)}`).join(' ');
  const rise = (cd0 + waveDrag(profile.jet.transonic, 1.1)) / (cd0 + waveDrag(profile.jet.transonic, 0.8));
  record('transonic drag rise (CD0 peak / subsonic)', rise, [2, 3], { compare: 'range', decimals: 2, note: `CD0 by Mach ${curve}` });
  // Divergence Mach: where CD0 has risen by 0.002 (the classic definition is a slope of 0.1 per Mach).
  let divergence = NaN;
  for (let mach = 0.7; mach < 1.1; mach += 0.005) {
    const slope = (waveDrag(profile.jet.transonic, mach + 0.005) - waveDrag(profile.jet.transonic, mach)) / 0.005;
    if (slope >= 0.1) {
      divergence = mach;
      break;
    }
  }
  record('drag-divergence Mach', divergence, [0.85, 0.95], { unit: 'Mach', compare: 'range', decimals: 3 });
  // In flight: the level-flight drag (thrust needed) at Mach 0.8 and 1.05 at sea level.
  const drag = (mach) => {
    const rig = createRig({ assists: 1 });
    rig.setAssists(1);
    const speed = mach * speedOfSound(0);
    rig.airborne({ speed, altitude: 0, throttle: 0.5 });
    const lateral = createLateralPilot();
    const level = createAltitudePilot(0);
    const speedHold = createPid(0.02, 0.05, 0, 0, 1);
    speedHold.reset(0.5);
    let dragSum = 0;
    let count = 0;
    rig.run(60, (lab) => {
      lateral.fly(lab);
      level.fly(lab);
      if (mach > 0.95) {
        if (lab.time < DT * 2) lab.afterburner();
        lab.pilot.throttle = 1;
      } else lab.pilot.throttle = speedHold.update((speed - lab.data.airspeed) / 10, DT);
      if (lab.time > 45) {
        // Steady, level and unaccelerated: the thrust is the drag.
        dragSum += lab.craftState.thrust;
        count++;
      }
    });
    return { drag: dragSum / Math.max(count, 1), speed: rig.data.airspeed };
  };
  const subsonic = drag(0.8);
  record('level-flight drag, Mach 0.8 sea level', subsonic.drag / 1000, [22, 36], { unit: 'kN', compare: 'range', note: `holding ${(subsonic.speed * KMH).toFixed(0)} km/h (CD0 0.021: about 28 kN)` });
}

/** Rate (deg/s) at which the velocity vector turns between two ticks. */
function pathTurnRate(previous, velocity) {
  const cosine = clamp(previous.dot(velocity) / Math.max(previous.length() * velocity.length(), 1e-6), -1, 1);
  return Math.acos(cosine) / DEG / DT;
}

/**
 * Sustained turn: afterburner at 100 % assists (the stick commands load through the fly-by-wire).
 * The load holds the speed (more load when fast), the bank holds the altitude (the level-turn bank for
 * the load, corrected by the altitude error). The rate is the velocity vector's turn rate.
 */
function testSustainedTurn() {
  const rig = createRig({ assists: 1 });
  rig.setAssists(1);
  const speed = 0.8 * speedOfSound(0);
  const altitude = 1000;
  rig.airborne({ speed, altitude, throttle: 1, bank: 82 });
  rig.afterburner();
  const loadPid = createPid(0.15, 0.25, 0, 1, 9);
  loadPid.reset(7);
  const altitudePid = createPid(0.012, 0.002, 0, -0.5, 0.5);
  const lateral = createLateralPilot();
  const previous = rig.model.state.velocity.clone();
  const rates = [];
  const loads = [];
  const speeds = [];
  rig.run(60, (lab) => {
    const load = loadPid.update(lab.data.airspeed - speed, DT);
    lab.pilot.pitch = clamp((load - 1) / (profile.targets.gLimit - 1), -1, 1);
    const levelBank = Math.acos(clamp(1 / Math.max(load, 1.01), -1, 1));
    const climb = altitudePid.update(altitude - lab.model.state.position.y - 2 * lab.data.verticalSpeed, DT);
    lateral.bank = clamp(levelBank - climb, 0, 88 * DEG) / DEG;
    lateral.fly(lab);
    const rate = pathTurnRate(previous, lab.model.state.velocity);
    previous.copy(lab.model.state.velocity);
    if (lab.time > 40) {
      rates.push(rate);
      loads.push(lab.data.gLoad);
      speeds.push(lab.data.airspeed);
    }
  });
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  record('sustained turn rate, Mach 0.8 sea level, AB', average(rates), 17, { unit: 'deg/s', note: `${average(loads).toFixed(1)} g at ${(average(speeds) * KMH).toFixed(0)} km/h, altitude ${rig.model.state.position.y.toFixed(0)} m` });
}

/** Instantaneous turn at corner speed: 100 % assists, full aft stick in an 80 degree bank. */
function testInstantaneousTurn() {
  const rig = createRig({ assists: 1, ground: -3000 });
  rig.setAssists(1);
  rig.airborne({ speed: 205, altitude: 400, throttle: 1, bank: 80 });
  rig.afterburner();
  const lateral = createLateralPilot();
  lateral.bank = 80;
  const previous = rig.model.state.velocity.clone();
  let best = 0;
  let bestLoad = 0;
  rig.run(4, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 1;
    const rate = pathTurnRate(previous, lab.model.state.velocity);
    previous.copy(lab.model.state.velocity);
    if (lab.time > 0.5 && rate > best) {
      best = rate;
      bestLoad = lab.data.gLoad;
    }
  });
  record('instantaneous turn rate, corner speed (740 km/h)', best, 26, { unit: 'deg/s', note: `${bestLoad.toFixed(1)} g, AoA ${(rig.data.aoa / DEG).toFixed(1)} deg, 100 % assists` });
}

function testGLimit() {
  // 100 % assists: full aft stick at 1080 km/h, low level (well above corner speed).
  const held = createRig({ assists: 1 });
  held.setAssists(1);
  held.airborne({ speed: 300, altitude: 500, throttle: 1 });
  const lateral = createLateralPilot();
  lateral.bank = 75;
  let peak = 0;
  const loads = [];
  held.run(6, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 1;
    peak = Math.max(peak, lab.data.gLoad);
    if (lab.time > 3) loads.push(lab.data.gLoad);
  });
  const average = loads.reduce((sum, value) => sum + value, 0) / loads.length;
  record('G limiter at 100 % assists (held load)', average, 9, { unit: 'g', decimals: 2, note: `peak ${peak.toFixed(2)} g, over-G warnings ${held.events.notify.filter((text) => text.startsWith('Over-G')).length}` });
  record('G limiter overshoot', peak, 9.6, { unit: 'g', compare: 'max', decimals: 2 });

  // 0 % assists: the same pull goes past 9 g, buffets and warns.
  const raw = createRig({ assists: 0 });
  raw.airborne({ speed: 300, altitude: 500, throttle: 1 });
  let rawPeak = 0;
  let overG = false;
  const rawLoads = [];
  raw.run(4, (lab) => {
    lateral.fly(lab);
    lab.pilot.pitch = 1;
    rawPeak = Math.max(rawPeak, lab.data.gLoad);
    if (lab.craftState.overG) overG = true;
    if (lab.time > 2) rawLoads.push(lab.data.gLoad);
  });
  const rawSteady = rawLoads.reduce((sum, value) => sum + value, 0) / rawLoads.length;
  const warned = raw.events.notify.some((text) => text.startsWith('Over-G'));
  record('0 % assists: past 9 g warns (craftState.overG, notice)', overG && warned ? 'yes' : 'no', 'yes', { compare: overG && warned, note: `peak ${rawPeak.toFixed(1)} g` });
  record('0 % assists: full aft stick load at 1080 km/h', rawSteady, [9.5, 14], { unit: 'g', compare: 'range', note: `held after 2 s (hinge-moment limit of the stabilators); peak ${rawPeak.toFixed(1)} g` });
}

function testHighAoa() {
  const rig = createRig();
  record('critical angle of attack', rig.data.aoaCritical / DEG, 25, { unit: 'deg' });
  // 100 % assists: full aft stick from slow flight stays below the critical angle (departure resistance).
  const guarded = createRig({ assists: 1 });
  guarded.setAssists(1);
  guarded.airborne({ speed: 110, altitude: 5000, throttle: 1 });
  let maxAoa = 0;
  let maxBank = 0;
  guarded.run(15, (lab) => {
    lab.pilot.pitch = 1;
    lab.pilot.roll = 0;
    lab.pilot.yaw = 0;
    maxAoa = Math.max(maxAoa, lab.data.aoa / DEG);
    if (lab.time > 2) maxBank = Math.max(maxBank, Math.abs(lab.data.bank / DEG));
  });
  record('100 % assists: full aft stick, max AoA', maxAoa, 25, { unit: 'deg', compare: 'max', note: `bank stayed within ${maxBank.toFixed(0)} deg` });
  // Holding 22 degrees (approached at 4 deg/s): at 0 % assists the wings rock; the dampers stop it.
  const rollRateRms = (assists) => {
    const rig = createRig({ assists });
    rig.setAssists(assists);
    rig.airborne({ speed: 140, altitude: 5000, throttle: 1 });
    const pid = createPid(1.5, 2.5, 0);
    let sum = 0;
    let count = 0;
    let bankSpan = [Infinity, -Infinity];
    rig.run(14, (lab) => {
      const target = Math.min(22, lab.time * 4) * DEG;
      lab.pilot.pitch = pid.update(target - lab.data.aoa, DT) - 0.3 * lab.data.pitchRate;
      lab.pilot.roll = 0;
      lab.pilot.yaw = 0;
      if (lab.time > 8) {
        sum += (lab.data.rollRate / DEG) ** 2;
        count++;
        bankSpan = [Math.min(bankSpan[0], lab.data.bank / DEG), Math.max(bankSpan[1], lab.data.bank / DEG)];
      }
    });
    return { rms: Math.sqrt(sum / count), bank: (bankSpan[1] - bankSpan[0]) / 2, aoa: rig.data.aoa / DEG };
  };
  const rocking = rollRateRms(0);
  record('0 % assists: wing rock at 22 deg AoA (roll rate RMS)', rocking.rms, 6, { unit: 'deg/s', compare: 'min', note: `bank swings +/-${rocking.bank.toFixed(0)} deg, AoA ${rocking.aoa.toFixed(1)} deg` });
  const damped = rollRateRms(0.6);
  record('60 % assists: dampers stop it (roll rate RMS)', damped.rms, 2, { unit: 'deg/s', compare: 'max', note: `bank swings +/-${damped.bank.toFixed(1)} deg` });
}

function testTakeoff() {
  const rig = createRig({ ground: 0, assists: 1 });
  rig.setAssists(1);
  rig.parked();
  rig.selectFlaps(1);
  rig.run(2);
  rig.afterburner();
  const start = rig.model.state.position.clone();
  let liftOff = NaN;
  let rotateAt = 0;
  let airborneSeconds = 0;
  let distance = NaN;
  let tailStrike = null;
  const aoaPilot = createAoaPilot(12);
  rig.run(60, (lab) => {
    const speed = lab.data.airspeed;
    lab.pilot.yaw = clamp(-0.02 * lab.data.heading + (lab.data.heading > 180 ? 0.02 * 360 : 0), -1, 1);
    if (speed >= 250 / KMH) {
      if (!rotateAt) rotateAt = lab.time;
      aoaPilot.fly(lab);
    } else lab.pilot.pitch = 0;
    if (lab.model.contact.bodyStrike) tailStrike = lab.model.contact.bodyStrike.part;
    airborneSeconds = lab.model.contact.onGround ? 0 : airborneSeconds + DT;
    if (airborneSeconds > 0.5 && !Number.isFinite(liftOff)) {
      liftOff = speed;
      distance = Math.hypot(lab.model.state.position.x - start.x, lab.model.state.position.z - start.z);
      return true;
    }
    return false;
  });
  record('lift-off speed (half flaps, AB, 12 deg)', liftOff * KMH, 290, { unit: 'km/h', decimals: 0, note: `ground roll ${distance.toFixed(0)} m, ${tailStrike ? `strike: ${tailStrike}` : 'no strikes'}` });
}

function testLanding() {
  const rig = createRig({ ground: 0, assists: 1 });
  rig.setAssists(1);
  rig.airborne({ speed: 76, altitude: 60, throttle: 0.6 });
  // Gear down (airborne starts fly clean) and full flaps on final.
  rig.pilot.actions.add('gearToggle');
  rig.tick();
  rig.selectFlaps(2);
  // Front-side approach through the fly-by-wire: the stick flies a 3 degree glide path and flares,
  // the throttle holds 265 km/h.
  const lateral = createLateralPilot();
  const speedPid = createPid(0.08, 0.04, 0, 0, 0.95);
  speedPid.reset(0.55);
  const approachSpeed = 265 / KMH;
  let touchdown = null;
  let aoaAtTouchdown = NaN;
  rig.run(90, (lab) => {
    lateral.fly(lab);
    const agl = lab.model.state.position.y;
    // Glide path, then an exponential flare over the last 10 m of wheel height.
    const wheelHeight = agl - 2.1;
    const targetSink = clamp(0.35 + 0.34 * wheelHeight, 0.35, 3.8);
    const targetPath = -Math.asin(Math.min(targetSink / Math.max(lab.data.airspeed, 30), 0.3));
    // The fly-by-wire flies load factor: ask for the load that bends the path onto the target.
    const load = Math.cos(lab.data.flightPath) + (lab.data.airspeed / 9.81) * 1.0 * (targetPath - lab.data.flightPath);
    lab.pilot.pitch = clamp((load - 1) / (profile.targets.gLimit - 1), -0.3, 0.5);
    lab.pilot.throttle = wheelHeight > 0.5 ? speedPid.update((approachSpeed - lab.data.airspeed) / 5, DT) : 0;
    if (Math.round(lab.time * 120) % 120 === 0) log(`  landing t ${lab.time.toFixed(1)} agl ${agl.toFixed(1)} V ${(lab.data.airspeed * KMH).toFixed(0)} vs ${lab.data.verticalSpeed.toFixed(1)} aoa ${(lab.data.aoa / DEG).toFixed(1)} thr ${lab.pilot.throttle.toFixed(2)} gear ${lab.writeTelemetry().gear.down} flaps ${lab.telemetry.flaps.toFixed(2)}`);
    if (lab.model.contact.touchdown && !touchdown) {
      touchdown = { speed: lab.data.airspeed, sink: lab.model.contact.touchdown.sinkRate };
      aoaAtTouchdown = lab.data.aoa / DEG;
      return true;
    }
    return false;
  });
  rig.pilot.throttle = 0;
  rig.pilot.pitch = 0;
  rig.pilot.brakeL = 1;
  rig.pilot.brakeR = 1;
  rig.run(3);
  const grade = rig.events.landed[0] ? rig.events.landed[0].grade : 'none';
  record('touchdown speed (full flaps, gear down)', touchdown ? touchdown.speed * KMH : NaN, 265, { unit: 'km/h', decimals: 0, note: `sink ${touchdown ? touchdown.sink.toFixed(2) : '-'} m/s, AoA ${aoaAtTouchdown.toFixed(1)} deg, grade ${grade}` });
  record('landing grade', grade, 'butter/smooth/firm', { compare: ['butter', 'smooth', 'firm'].includes(grade) });
}

/** Parked on the tricycle gear, and taxiing with nose-wheel steering on the rudder. */
function testGround() {
  const parked = createRig({ ground: 0, assists: 1 });
  parked.setAssists(1);
  parked.parked();
  const start = parked.model.state.position.clone();
  let strike = null;
  parked.run(10, (lab) => {
    if (lab.model.contact.bodyStrike) strike = lab.model.contact.bodyStrike.part;
  });
  const creep = Math.hypot(parked.model.state.position.x - start.x, parked.model.state.position.z - start.z);
  record('parked 10 s: creep', creep, 0.3, { unit: 'm', compare: 'max', decimals: 3, note: `${strike ? `strike: ${strike}` : 'no strikes'}, pitch ${(parked.data.pitch / DEG).toFixed(1)} deg` });

  const taxi = createRig({ ground: 0, assists: 1 });
  taxi.setAssists(1);
  taxi.parked();
  taxi.pilot.throttle = 0.35;
  taxi.run(12, (lab) => {
    lab.pilot.throttle = lab.data.airspeed > 5 ? 0.02 : 0.3;
  });
  const headingBefore = taxi.data.heading;
  let taxiStrike = null;
  taxi.run(6, (lab) => {
    lab.pilot.yaw = 1;
    lab.pilot.throttle = lab.data.airspeed > 5 ? 0.02 : 0.3;
    if (lab.model.contact.bodyStrike) taxiStrike = lab.model.contact.bodyStrike.part;
  });
  const turned = ((((taxi.data.heading - headingBefore + 180) % 360) + 360) % 360) - 180;
  record('nose-wheel steering: full right rudder, 6 s taxi at 18 km/h', turned, 30, { unit: 'deg', compare: taxiStrike === null && turned >= 30 ? true : false, note: `${(taxi.data.airspeed * KMH).toFixed(0)} km/h, ${taxiStrike ? `strike: ${taxiStrike}` : 'no strikes'}` });
}

function testGear() {
  const rig = createRig();
  rig.airborne({ speed: 120, altitude: 2000, throttle: 0.7 });
  const telemetry = rig.writeTelemetry();
  const startsUp = telemetry.gear.down === false;
  rig.pilot.actions.add('gearToggle');
  let transitStart = NaN;
  let transitEnd = NaN;
  rig.run(6, (lab) => {
    const gear = lab.writeTelemetry().gear;
    if (gear.transit > 0 && !Number.isFinite(transitStart)) transitStart = lab.time;
    if (Number.isFinite(transitStart) && gear.transit === 0 && gear.down && !Number.isFinite(transitEnd)) transitEnd = lab.time;
  });
  record('gear transit (up -> down)', transitEnd - transitStart + DT, profile.gear.transitSeconds, { unit: 's', decimals: 2, note: `airborne start with gear up: ${startsUp}` });
  // Gear drag: level-flight thrust with the gear down against up at 300 km/h.
  const gearDownRig = createRig();
  gearDownRig.airborne({ speed: 83, altitude: 1000, throttle: 0.7 });
  gearDownRig.pilot.actions.add('gearToggle');
  gearDownRig.run(5);
  const downTelemetry = gearDownRig.writeTelemetry();
  record('gear down in the air', downTelemetry.gear.down ? 'down' : 'up', 'down', { compare: downTelemetry.gear.down === true, note: `retractable ${downTelemetry.gear.retractable}` });
  // On the ground the gear stays down.
  const parked = createRig({ ground: 0 });
  parked.parked();
  parked.run(1);
  parked.pilot.actions.add('gearToggle');
  parked.run(1);
  const refused = parked.writeTelemetry().gear.down === true && parked.events.notify.some((text) => text.includes('stays down'));
  record('gear stays down on the ground', refused ? 'yes' : 'no', 'yes', { compare: refused });
}

function testSpeedBrake() {
  const deceleration = (airbrake) => {
    const rig = createRig();
    rig.airborne({ speed: 250, altitude: 3000, throttle: 0 });
    const level = createAltitudePilot(3000);
    const lateral = createLateralPilot();
    if (airbrake) rig.pilot.held.add('airbrake');
    const start = rig.data.airspeed;
    rig.run(10, (lab) => {
      level.fly(lab);
      lateral.fly(lab);
    });
    return { lost: start - rig.data.airspeed, deployed: rig.writeTelemetry().airbrake };
  };
  const clean = deceleration(false);
  const braked = deceleration(true);
  record('speed brake: extra speed lost in 10 s from 900 km/h', (braked.lost - clean.lost) * KMH, [30, 250], { unit: 'km/h', compare: 'range', decimals: 0, note: `clean ${(clean.lost * KMH).toFixed(0)}, brakes ${(braked.lost * KMH).toFixed(0)} km/h, deployed ${braked.deployed.toFixed(2)}` });
}

function testDetent() {
  const rig = createRig();
  rig.airborne({ speed: 200, altitude: 3000, throttle: 0.5 });
  const telemetry = () => rig.writeTelemetry();
  // Keyboard lever at the stop: the throttle sits at the detent, no burner.
  rig.pilot.throttle = 1;
  rig.run(5);
  const atStop = telemetry();
  record('keyboard lever at the stop: throttle', atStop.throttle, 0.95, { decimals: 3, tolerance: 0.001, note: `afterburner ${atStop.afterburner}, abDetent ${rig.craftState.abDetent}` });
  const noBurner = atStop.afterburner === false && rig.craftState.abDetent === false;
  record('keyboard lever alone does not pass the detent', noBurner ? 'yes' : 'no', 'yes', { compare: noBurner });
  // Space (the ability) pushes it through.
  rig.craftState.abRequest = 'toggle';
  rig.tick();
  const detentAfterAbility = rig.craftState.abDetent === true;
  rig.run(2);
  const lit = telemetry();
  const engagedNotice = rig.events.notify.includes('Afterburner.');
  record('ability pushes through the detent (abDetent, lit, notice)', detentAfterAbility && lit.afterburner && engagedNotice ? 'yes' : 'no', 'yes', { compare: detentAfterAbility && lit.afterburner && engagedNotice, note: `throttle ${lit.throttle.toFixed(2)}` });
  // Pulling the lever back cancels it.
  rig.run(1, (lab) => {
    lab.pilot.throttle = Math.max(0.9, lab.pilot.throttle - 0.5 * DT);
  });
  rig.run(1.5);
  const cancelled = telemetry();
  const offNotice = rig.events.notify.includes('Afterburner off.');
  record('pulling the lever back cancels it', !cancelled.afterburner && rig.craftState.abDetent === false && offNotice ? 'yes' : 'no', 'yes', { compare: !cancelled.afterburner && rig.craftState.abDetent === false && offNotice, note: `throttle ${cancelled.throttle.toFixed(2)}` });
  // A HOTAS lever lights it past the detent and stages it.
  rig.pilot.sources.throttle = 'hotas';
  rig.pilot.throttle = 0.975;
  rig.run(2);
  const hotas = telemetry();
  record('HOTAS lever past the detent lights it', hotas.afterburner && rig.craftState.abDetent ? 'yes' : 'no', 'yes', { compare: hotas.afterburner && rig.craftState.abDetent, note: `stage ${(rig.model.snapshot().extension.spool.abCommand).toFixed(2)}` });
  rig.pilot.throttle = 0.93;
  rig.run(1.5);
  const hotasOff = telemetry();
  record('HOTAS lever back below the detent', !hotasOff.afterburner && !rig.craftState.abDetent ? 'yes' : 'no', 'yes', { compare: !hotasOff.afterburner && !rig.craftState.abDetent });
  // Afterburner thrust gain at 10 km / Mach 0.9 against military power.
  const military = profile.jet.engine.dryThrust;
  const full = profile.jet.engine.abThrust;
  record('afterburner / military static thrust', full / military, [1.45, 1.75], { compare: 'range', decimals: 2 });
}

/** The fixed-wing autopilot flying the jet through its flight control system (100 % assists). */
function testAutopilot() {
  const rig = createRig({ assists: 1 });
  rig.setAssists(1);
  rig.airborne({ speed: 222, altitude: 3000, throttle: 0.4 });
  Object.assign(rig.env.autopilot, { enabled: true, heading: 90, altitude: 3300, speed: 222, followWaypoint: false });
  let maxLoad = 0;
  let maxBank = 0;
  rig.run(120, (lab) => {
    maxLoad = Math.max(maxLoad, lab.data.gLoad);
    maxBank = Math.max(maxBank, Math.abs(lab.data.bank / DEG));
  });
  const headingError = Math.abs(((((90 - rig.data.heading + 180) % 360) + 360) % 360) - 180);
  record('autopilot heading +90 deg', headingError, 2, { unit: 'deg', compare: 'max', decimals: 2, note: `max bank ${maxBank.toFixed(0)} deg, max ${maxLoad.toFixed(2)} g` });
  record('autopilot altitude +300 m', Math.abs(3300 - rig.model.state.position.y), 15, { unit: 'm', compare: 'max' });
  record('autopilot speed hold 800 km/h', Math.abs(222 - rig.data.airspeed), 3, { unit: 'm/s', compare: 'max', decimals: 2, note: `throttle ${rig.data.throttle.toFixed(2)}` });
}

function testLimits() {
  const rig = createRig();
  const a10 = speedOfSound(10000);
  rig.airborne({ speed: 1.72 * a10, altitude: 10000, throttle: 1 });
  rig.run(0.2);
  const machOver = rig.data.overspeed;
  const seaLevel = createRig();
  seaLevel.airborne({ speed: 380, altitude: 0, throttle: 1 });
  seaLevel.run(0.2);
  const inside = !seaLevel.data.overspeed;
  seaLevel.airborne({ speed: 420, altitude: 0, throttle: 1 });
  seaLevel.run(0.2);
  const easOver = seaLevel.data.overspeed;
  const high = createRig();
  high.airborne({ speed: 1.6 * a10, altitude: 10000, throttle: 1 });
  high.run(0.2);
  const highInside = !high.data.overspeed;
  const ok = machOver && inside && easOver && highInside;
  record('Vne: 410 m/s EAS or Mach 1.7', ok ? 'yes' : 'no', 'yes', { compare: ok, note: `M1.72@10km over ${machOver}, M1.6@10km inside ${highInside}, 380 m/s SL inside ${inside}, 420 m/s SL over ${easOver}` });
}

// ============================================================================================
// RUN
// ============================================================================================
function printTable() {
  const columns = [
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} jet checks within target (game atmosphere, 120 Hz)\n`);
  return failed === 0;
}

const started = Date.now();
const only = process.argv.find((argument) => argument.startsWith('--only='));
const tests = { testTopSpeeds, testAcceleration, testSpool, testDragRise, testSustainedTurn, testInstantaneousTurn, testGLimit, testHighAoa, testTakeoff, testLanding, testGround, testGear, testSpeedBrake, testDetent, testAutopilot, testLimits };
for (const [name, test] of Object.entries(tests)) {
  if (only && !name.toLowerCase().includes(only.slice(7).toLowerCase())) continue;
  test();
}
const passed = printTable();
process.stdout.write(`(${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
process.exitCode = passed ? 0 : 1;
