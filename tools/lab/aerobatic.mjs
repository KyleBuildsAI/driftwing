// Aerobatic lab: flies the aerobatic craft's flight model (SimFixedWing under the 'aerobatic' kind, with
// the aerobaticAero extension and the aerobatic assists) headless in node with scripted controls through
// the same control stages the game runs every physics tick, and checks the manoeuvre recognizer, the
// smoke ribbon, the instruments and the craft through the real FlightController.
//
// The air is still and at sea-level density by altitude (the game's atmosphere), over flat ground far
// below. Physics runs at 120 Hz.
//
// Tests:
//   stall        power-off stall speed upright and inverted (the symmetric wing: the same speed)
//   inverted     level flight at 70 m/s upright and inverted: the same angle of attack (mirrored)
//   roll         full aileron at 80 m/s, 0 % assists: about 400 deg/s both ways
//   cruise       level at 75 % power: about 85 m/s; full power stays under Vne
//   climb        full power at 55 m/s: about 15 m/s
//   g            0 % assists at 100 m/s: full aft reaches the +10 g envelope and full forward mirrors
//                it; 100 % assists: the G limiter holds +8.5 / -6 g; the AoA limiter never stalls
//   handsOff     100 % assists, trimmed at cruise, 60 s hands off: holds its height and wings level
//   hang         vertical at zero airspeed on full power: climbs (thrust over weight) and torque-rolls left
//   snap         0 % assists at 55 m/s: full aft stick and rudder stall one wing into a snap roll
//   knifeEdge    90 degrees of bank held on the rudder at 85 m/s: height held, rudder not at its stop
//   figures      the recognizer through the flight model, every figure flown by a scripted pilot:
//                loop and aileron roll (100 % assists), Immelmann, split-S, barrel roll, hammerhead,
//                inverted pass, knife-edge pass, snap roll, plus the figure's toast and journal stat
//   synthetic    the recognizer on generated trajectories of all 12 figures (Cuban eight, tailslide and
//                lomcevak included), the lomcevak refused above 25 % assists, and turns and half rolls
//                that are no figure
//   controller   the FlightController headless: boot at cruise, 30 s hands off; a switch from the bush
//                plane in flight (situate); Space / Shift+Space smoke and colour; the copilot commands
//                and status; the ribbon laid, re-anchored past 2 km, fading out, disposed with the craft
//   instruments  the smoke and figure displays draw in both themes
//   allocation   the recognizer allocates nothing per sample (run with --expose-gc)
//
// Usage: node --expose-gc tools/lab/aerobatic.mjs [--verbose] [--only=name,name]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import aerobatic from '../../src/craft/aerobatic.js';
import bushplane from '../../src/craft/bushplane.js';
import { createCraftRegistry, craftRegistry } from '../../src/craft/registry.js';
import '../../src/craft/index.js';
import { flightModels } from '../../src/flight/models.js';
import { createFlightController } from '../../src/flight/FlightController.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { primeAssists } from '../../src/flight/assists.js';
import { trimModel } from '../../src/flight/trim.js';
import { createManeuverRecognizer, createRecognizerInput, FIGURE_IDS, LOMCEVAK_MAX_ASSISTS } from '../../src/flight/maneuverRecognizer.js';
import { SMOKE_RIBBON } from '../../src/render/smokeRibbon.js';
import { INSTRUMENTS } from '../../src/ui/instruments/index.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { CRAFT_IDS, DEFAULT_CRAFT_FAVORITES } from '../../src/core/settings.js';
import { CONFIG } from '../../src/core/config.js';
import { DEG, clamp, headingFromVector, vectorFromHeading } from '../../src/core/util.js';

const DT = 1 / 120;
const VERBOSE = process.argv.includes('--verbose');
const ONLY = (process.argv.find((flag) => flag.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose' && !flag.startsWith('--only=')) throw new Error(`Unknown flag ${flag}`);
}
const profile = aerobatic.simProfile;
const targets = profile.targets;

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

function wrap180(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// ============================================================================================
// RIG
// ============================================================================================
/** The aerobatic craft in the lab: model, the pilot's ControlState, the tick copy the stages shape. */
function createRig({ assists = 0 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], figures: [], stats: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('figureFlown', (payload) => events.figures.push(payload));
  bus.onTyped('journalStat', (payload) => events.stats.push(payload));
  const craftState = { ...aerobatic.abilities.craftAbility.initialState(), ...aerobatic.abilities.craftAbilityAlt.initialState() };
  const ground = -3000;
  const world = { groundHeight: () => ground, heightAt: () => ground };
  const model = flightModels.create(profile.model, { profile, craft: aerobatic, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: ground - 100, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft: aerobatic, craftId: aerobatic.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [] };
  const rig = { model, data: model.flightData, pilot, controls, env, context, events, telemetry, craftState, time: 0 };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    telemetry.position.copy(model.state.position);
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
  rig.airborne = ({ speed, altitude = 1500, throttle = 0.7, heading = 0, pitch = 0, bank = 0 }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  /** Airborne, trimmed and with the assists primed from the trim (as the controller does). */
  rig.trimmed = ({ speed, altitude = 1500, throttle = 0.7, heading = 0 }) => {
    rig.airborne({ speed, altitude, throttle, heading });
    const trim = trimModel(model, { env, dt: DT, throttle, trim: 0 });
    primeAssists(model, trim);
    pilot.throttle = throttle;
    return trim;
  };
  rig.altitude = () => model.state.position.y;
  rig.figure = (id) => events.figures.filter((event) => event.figure === id);
  rig.neutral = () => {
    pilot.roll = 0;
    pilot.pitch = 0;
    pilot.yaw = 0;
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

/** A bank target (deg, -180..180) with the ailerons, the shorter way round. */
function createBankPilot(bank = 0, { gain = 0.9, rateGain = 0.12 } = {}) {
  return {
    bank,
    fly(rig) {
      const error = wrap180(this.bank - rig.data.bank / DEG) * DEG;
      rig.pilot.roll = clamp(gain * error - rateGain * rig.data.rollRate, -1, 1);
    },
  };
}

/**
 * Holds an altitude with the elevator through the flight path, upright or inverted (inverted, the
 * stick is reversed: forward raises the nose toward the sky).
 */
function createAltitudePilot(target, { inverted = false } = {}) {
  const pid = createPid(0, 0.3, 0);
  return {
    target,
    fly(rig) {
      const data = rig.data;
      const speed = Math.max(data.airspeed, 25);
      const desiredPath = clamp((this.target - rig.altitude()) / (speed * 4), -0.1, 0.1);
      const pathError = desiredPath - data.flightPath;
      const gain = clamp(4000 / Math.max(data.dynamicPressure, 400), 0.1, 3);
      const sign = inverted ? -1 : 1;
      const command = pid.update(pathError * gain, DT) + gain * (2.5 * pathError) - 0.3 * sign * data.pitchRate;
      rig.pilot.pitch = clamp(sign * command, -1, 1);
    },
  };
}

/** Holds an airspeed with the elevator (a climb at a speed): speed error -> flight path -> elevator. */
function createSpeedPilot(target) {
  const pid = createPid(0, 0.3, 0);
  return {
    target,
    fly(rig) {
      const data = rig.data;
      const desiredPath = clamp(0.2 + 0.02 * (data.airspeed - this.target), -0.1, 0.6);
      const pathError = desiredPath - data.flightPath;
      const gain = clamp(4000 / Math.max(data.dynamicPressure, 400), 0.1, 3);
      rig.pilot.pitch = clamp(pid.update(pathError * gain, DT) + gain * 2.5 * pathError - 0.3 * data.pitchRate, -1, 1);
    },
  };
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function record(test, name, measured, target, { unit = '', tolerance = 0.1, compare = 'within', decimals = 1 } = {}) {
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
  results.push({ test, name, measured: typeof measured === 'number' ? withUnit(measured) : String(measured), target: targetText, pass });
}
function check(test, name, pass, detail = '') {
  results.push({ test, name, measured: detail, target: 'true', pass: Boolean(pass) });
}

// ============================================================================================
// PHYSICS
// ============================================================================================
/** Power off, height held until the wing reaches its critical angle: the airspeed there. */
function stallSpeed(inverted) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 45, altitude: 2000, throttle: 0, bank: inverted ? 180 : 0 });
  const level = createAltitudePilot(2000, { inverted });
  const wings = createBankPilot(inverted ? 180 : 0);
  let speed = NaN;
  rig.run(40, (lab) => {
    wings.fly(lab);
    level.fly(lab);
    lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    const aoa = inverted ? -lab.data.aoa : lab.data.aoa;
    if (aoa >= lab.data.aoaCritical) {
      speed = lab.data.airspeed;
      return true;
    }
    return false;
  });
  return speed;
}

function testStall() {
  const upright = stallSpeed(false);
  const inverted = stallSpeed(true);
  log(`  stall upright ${upright.toFixed(2)} m/s, inverted ${inverted.toFixed(2)} m/s`);
  record('stall', 'power-off stall speed upright', upright, targets.stallSpeed, { unit: 'm/s', tolerance: 0.1 });
  record('stall', 'inverted stall speed / upright', inverted / upright, 1, { tolerance: 0.05, decimals: 3 });
}

/** Level at a speed for 15 s; mean angle of attack (deg) and elevator. */
function levelFlight(inverted) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 70, altitude: 1500, throttle: 0.55, bank: inverted ? 180 : 0 });
  const level = createAltitudePilot(1500, { inverted });
  const wings = createBankPilot(inverted ? 180 : 0);
  let aoa = 0;
  let elevator = 0;
  let samples = 0;
  rig.run(20, (lab) => {
    wings.fly(lab);
    level.fly(lab);
    lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    lab.pilot.throttle = clamp(0.55 + 0.05 * (70 - lab.data.airspeed), 0, 1);
    if (lab.time > 12) {
      aoa += lab.data.aoa / DEG;
      elevator += lab.data.elevator;
      samples++;
    }
    return false;
  });
  return { aoa: aoa / samples, elevator: elevator / samples, altitude: rig.altitude() };
}

function testInverted() {
  const upright = levelFlight(false);
  const inverted = levelFlight(true);
  log(`  70 m/s level: upright aoa ${upright.aoa.toFixed(2)} elev ${upright.elevator.toFixed(3)}; inverted aoa ${inverted.aoa.toFixed(2)} elev ${inverted.elevator.toFixed(3)}`);
  record('inverted', 'inverted angle of attack mirrors upright (|inv| / up)', Math.abs(inverted.aoa) / upright.aoa, 1, { tolerance: 0.08, decimals: 3 });
  check('inverted', 'inverted flight needs forward stick (negative AoA)', inverted.aoa < 0 && upright.aoa > 0, `${upright.aoa.toFixed(2)} / ${inverted.aoa.toFixed(2)} deg`);
}

function rollRate(direction) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 80, altitude: 1500, throttle: 0.75 });
  let peak = 0;
  rig.run(1.6, (lab) => {
    lab.pilot.roll = direction;
    peak = Math.max(peak, direction * lab.data.rollRate / DEG);
    return false;
  });
  return peak;
}

function testRoll() {
  const right = rollRate(1);
  const left = rollRate(-1);
  log(`  roll rate right ${right.toFixed(0)} deg/s, left ${left.toFixed(0)} deg/s`);
  record('roll', 'full aileron at 80 m/s, right', right, targets.rollRate, { unit: 'deg/s', tolerance: 0.12, decimals: 0 });
  record('roll', 'full aileron at 80 m/s, left', left, targets.rollRate, { unit: 'deg/s', tolerance: 0.12, decimals: 0 });
}

/** Level at a throttle until the speed settles; the speed. */
function levelSpeed(throttle) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 80, altitude: 1000, throttle });
  const level = createAltitudePilot(1000);
  const wings = createBankPilot(0);
  rig.run(120, (lab) => {
    wings.fly(lab);
    level.fly(lab);
    lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    return false;
  });
  return rig.data.airspeed;
}

function testCruise() {
  const cruise = levelSpeed(0.75);
  const top = levelSpeed(1);
  log(`  cruise ${cruise.toFixed(1)} m/s, top ${top.toFixed(1)} m/s`);
  record('cruise', 'level at 75 % power', cruise, targets.cruiseSpeed, { unit: 'm/s', tolerance: 0.1 });
  record('cruise', 'full power level stays under Vne', top, aerobatic.limits.vne, { unit: 'm/s', compare: 'max' });
}

function testClimb() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 55, altitude: 500, throttle: 1 });
  const speed = createSpeedPilot(55);
  const wings = createBankPilot(0);
  let start = NaN;
  let startTime = NaN;
  rig.run(40, (lab) => {
    wings.fly(lab);
    speed.fly(lab);
    lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    if (lab.time >= 20 && !Number.isFinite(start)) {
      start = lab.altitude();
      startTime = lab.time;
    }
    return false;
  });
  const climb = (rig.altitude() - start) / (rig.time - startTime);
  log(`  climb ${climb.toFixed(2)} m/s at ${rig.data.airspeed.toFixed(1)} m/s`);
  record('climb', 'full power at 55 m/s', climb, targets.climbRate, { unit: 'm/s', tolerance: 0.15 });
}

/** Peak load factor (g) with the stick held at `stick` for `seconds` from 100 m/s level. */
function peakLoad(assists, stick, seconds = 1.5) {
  const rig = assists > 0 ? createRig({ assists }) : createRig({ assists: 0 });
  if (assists > 0) rig.trimmed({ speed: 100, altitude: 2500, throttle: 1 });
  else rig.airborne({ speed: 100, altitude: 2500, throttle: 1 });
  let peak = stick > 0 ? -Infinity : Infinity;
  let stalled = false;
  rig.run(seconds, (lab) => {
    lab.pilot.pitch = stick;
    peak = stick > 0 ? Math.max(peak, lab.data.gLoad) : Math.min(peak, lab.data.gLoad);
    stalled = stalled || lab.data.stalled;
    return false;
  });
  return { peak, stalled };
}

/** 0 % assists at 100 m/s: the load at an angle of attack held half a degree short of the stall (either sign). */
function envelopeLoad(sign) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 100, altitude: 2500, throttle: 1 });
  const pid = createPid(2, 4, 0);
  let peak = 0;
  rig.run(1.2, (lab) => {
    const target = sign * (lab.data.aoaCritical - 0.5 * DEG);
    lab.pilot.pitch = clamp(1.5 * target + pid.update(target - lab.data.aoa, DT) - 0.15 * lab.data.pitchRate, -1, 1);
    peak = sign > 0 ? Math.max(peak, lab.data.gLoad) : Math.min(peak, lab.data.gLoad);
    return false;
  });
  return peak;
}

function testLoads() {
  const positive = envelopeLoad(1);
  const negative = envelopeLoad(-1);
  log(`  0 %: +${positive.toFixed(2)} / ${negative.toFixed(2)} g`);
  record('g', '0 %: at the edge of the stall at 100 m/s it reaches the +10 g envelope', positive, [9.5, 13], { unit: 'g', compare: 'range', decimals: 2 });
  record('g', '0 %: pushing mirrors it (|neg| / pos)', Math.abs(negative) / positive, 0.85, { compare: 'min', decimals: 3 });
  const limited = peakLoad(1, 1, 2.5);
  const limitedNegative = peakLoad(1, -1, 2.5);
  log(`  100 %: +${limited.peak.toFixed(2)} / ${limitedNegative.peak.toFixed(2)} g`);
  const gLimit = aerobatic.limits.gLimit;
  record('g', '100 %: the G limiter holds +8.5 g', limited.peak, [7, 0.85 * gLimit * 1.06], { unit: 'g', compare: 'range', decimals: 2 });
  record('g', '100 %: the G limiter holds -6 g', limitedNegative.peak, -0.6 * gLimit * 1.08, { unit: 'g', compare: 'min', decimals: 2 });

  // AoA limiter: full aft and full forward at 55 m/s, 100 % assists: never stalled.
  for (const stick of [1, -1]) {
    const rig = createRig({ assists: 1 });
    rig.trimmed({ speed: 55, altitude: 2500, throttle: 0.6 });
    let stalled = false;
    let maxAoa = 0;
    rig.run(4, (lab) => {
      lab.pilot.pitch = stick;
      stalled = stalled || lab.data.stalled;
      maxAoa = Math.max(maxAoa, Math.abs(lab.data.aoa / DEG));
      return false;
    });
    check('g', `100 %: the AoA limiter keeps a ${stick > 0 ? 'pull' : 'push'} at 55 m/s out of the stall`, !stalled, `max |aoa| ${maxAoa.toFixed(1)} deg`);
  }
}

function testHandsOff() {
  const rig = createRig({ assists: 1 });
  rig.trimmed({ speed: aerobatic.spawn.cruise, altitude: 1500, throttle: aerobatic.spawn.cruiseThrottle });
  const start = rig.altitude();
  let maxBank = 0;
  rig.run(60, (lab) => {
    lab.neutral();
    maxBank = Math.max(maxBank, Math.abs(lab.data.bank / DEG));
    return false;
  });
  const drift = Math.abs(rig.altitude() - start);
  log(`  hands off 60 s: height change ${drift.toFixed(1)} m, max bank ${maxBank.toFixed(1)}`);
  record('handsOff', '100 %: height change over 60 s', drift, 60, { unit: 'm', compare: 'max' });
  record('handsOff', '100 %: wings stay level', maxBank, 5, { unit: 'deg', compare: 'max' });
}

function testHang() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 0.5, altitude: 1500, throttle: 1, pitch: 89.5 });
  const start = rig.altitude();
  let rollAt3 = 0;
  // The pilot keeps the nose up with rudder and elevator in the slipstream (right rudder against the
  // swirl and the P-factor), and leaves the ailerons alone: the torque rolls the craft.
  const held = { pitch: 0, yaw: 0 };
  rig.run(3, (lab) => {
    held.pitch += lab.data.pitchRate * DT;
    held.yaw += lab.data.yawRate * DT;
    lab.pilot.pitch = clamp(-(2 * held.pitch + 0.5 * lab.data.pitchRate), -1, 1);
    lab.pilot.yaw = clamp(-(2 * held.yaw + 0.5 * lab.data.yawRate), -1, 1);
    lab.pilot.roll = 0;
    rollAt3 = lab.data.rollRate / DEG;
    return false;
  });
  const climbed = rig.altitude() - start;
  log(`  hang: climbed ${climbed.toFixed(1)} m in 3 s, roll rate ${rollAt3.toFixed(1)} deg/s, pitch ${(rig.data.pitch / DEG).toFixed(1)}`);
  record('hang', 'full power vertical from a standstill climbs (thrust over weight)', climbed, 2, { unit: 'm', compare: 'min' });
  record('hang', 'the torque rolls it left (deg/s, negative = left)', rollAt3, -15, { unit: 'deg/s', compare: 'max' });
}

function testSnap() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 55, altitude: 1500, throttle: 0.7 });
  const wings = createBankPilot(0);
  const level = createAltitudePilot(1500);
  rig.run(1.5, (lab) => {
    wings.fly(lab);
    level.fly(lab);
    return false;
  });
  let rolled = 0;
  let peakRate = 0;
  let stalled = false;
  let phase = 'snap';
  let recovered = NaN;
  rig.run(12, (lab) => {
    const rate = lab.data.rollRate / DEG;
    rolled += rate * DT;
    peakRate = Math.max(peakRate, rate);
    stalled = stalled || lab.data.stalled;
    if (phase === 'snap') {
      lab.pilot.pitch = 1;
      lab.pilot.yaw = 1;
      lab.pilot.roll = 0;
      if (rolled >= 240) phase = 'stop';
    } else if (phase === 'stop') {
      lab.pilot.pitch = -0.2;
      lab.pilot.yaw = -1;
      lab.pilot.roll = -0.3;
      if (rate < 60) {
        phase = 'level';
        recovered = rolled;
      }
    } else {
      wings.fly(lab);
      level.fly(lab);
      lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    }
    return false;
  });
  log(`  snap: rolled ${recovered.toFixed(0)} deg at the stop, peak ${peakRate.toFixed(0)} deg/s, stalled ${stalled}, figures ${rig.events.figures.map((event) => event.figure).join(',')}`);
  check('snap', 'one wing stalls (the autorotation)', stalled);
  record('snap', 'peak roll rate of the snap', peakRate, 200, { unit: 'deg/s', compare: 'min', decimals: 0 });
  record('snap', 'roll at the stop', recovered, [270, 470], { unit: 'deg', compare: 'range', decimals: 0 });
  check('snap', 'recognized as a snap roll', rig.figure('snapRoll').length === 1, rig.events.figures.map((event) => `${event.figure} ${event.score}`).join(', '));
}

/** Knife-edge at 85 m/s: bank held at 90 on the ailerons, height on the rudder, heading on the elevator. */
function flyKnifeEdge(rig, seconds) {
  const wings = createBankPilot(90);
  const startHeading = rig.data.heading;
  const rudder = createPid(0.12, 0.08, 0);
  let maxError = 0;
  let rudderSum = 0;
  let sideslipSum = 0;
  let samples = 0;
  const start = rig.altitude();
  rig.run(seconds, (lab) => {
    wings.fly(lab);
    // Nose toward the sky at 90 degrees right bank is left rudder.
    lab.pilot.yaw = -rudder.update(-lab.data.verticalSpeed + 0.3 * (start - lab.altitude()), DT);
    lab.pilot.pitch = clamp(-0.03 * wrap180(lab.data.heading - startHeading), -0.3, 0.3);
    if (lab.time > 0) {
      maxError = Math.max(maxError, Math.abs(lab.altitude() - start));
      rudderSum += Math.abs(lab.pilot.yaw);
      sideslipSum += Math.abs(lab.data.sideslip / DEG);
      samples++;
    }
    return false;
  });
  return { maxError, rudder: rudderSum / samples, sideslip: sideslipSum / samples };
}

function testKnifeEdge() {
  const rig = createRig({ assists: 0.3 });
  rig.trimmed({ speed: 85, altitude: 1500, throttle: 1 });
  rig.run(1, (lab) => {
    lab.neutral();
    return false;
  });
  const roll = createBankPilot(90, { gain: 1.4 });
  rig.run(1.2, (lab) => {
    roll.fly(lab);
    return false;
  });
  const held = flyKnifeEdge(rig, 6);
  log(`  knife-edge: height error ${held.maxError.toFixed(1)} m, mean |rudder| ${held.rudder.toFixed(2)}, mean sideslip ${held.sideslip.toFixed(1)} deg, speed ${rig.data.airspeed.toFixed(1)}`);
  record('knifeEdge', 'height held within (6 s at 90 degrees of bank)', held.maxError, 20, { unit: 'm', compare: 'max' });
  record('knifeEdge', 'mean rudder (not at the stop)', held.rudder, 0.95, { compare: 'max', decimals: 2 });
}

// ============================================================================================
// FIGURES THROUGH THE FLIGHT MODEL
// ============================================================================================
/** Straight and level for `seconds` with the assists' hands-off hold (or a test pilot at low assists). */
function settle(rig, seconds, altitude = NaN) {
  const level = Number.isFinite(altitude) ? createAltitudePilot(altitude) : null;
  const wings = createBankPilot(0);
  rig.run(seconds, (lab) => {
    if (level) {
      level.fly(lab);
      wings.fly(lab);
      lab.pilot.yaw = clamp(3 * lab.data.sideslip, -1, 1);
    } else {
      lab.neutral();
    }
    return false;
  });
}

/** Rolls (deg, signed) accumulated by a script step; tracks the total in memo.roll. */
function trackRoll(rig, memo) {
  memo.roll = (memo.roll ?? 0) + (rig.data.rollRate / DEG) * DT;
}

function flyFigure(id, assists, start, script, { after = 6, settleAltitude = NaN } = {}) {
  const rig = createRig({ assists });
  rig.trimmed(start);
  settle(rig, 2, settleAltitude);
  const memo = {};
  rig.run(40, (lab) => {
    trackRoll(lab, memo);
    return script(lab, memo) === true;
  });
  settle(rig, after, settleAltitude);
  const figures = rig.events.figures.map((event) => `${event.figure} ${event.score}`).join(', ') || 'none';
  log(`  ${id}: ${figures}`);
  check('figures', `${id} recognized`, rig.figure(id).length === 1 && rig.events.figures.length === 1, figures);
  return rig;
}

function testFigures() {
  // Loop, 100 %: pull until over the top and back to the horizon.
  const loop = flyFigure('loop', 1, { speed: 85, altitude: 1200, throttle: 1 }, (lab, memo) => {
    const pitch = lab.data.pitch / DEG;
    if (pitch > 70) memo.up = true;
    if (memo.up && Math.abs(lab.data.bank / DEG) > 150) memo.top = true;
    if (memo.top && pitch < -60) memo.down = true;
    lab.pilot.pitch = 0.8;
    lab.pilot.roll = 0;
    lab.pilot.yaw = 0;
    if (memo.down && pitch > -8) {
      lab.neutral();
      return true;
    }
    return false;
  });
  const loopEvent = loop.figure('loop')[0];
  check('figures', 'the figure toasts with its score', loop.events.notify.some((text) => /^Loop: \d+ points$/.test(text)), loop.events.notify.join(' | '));
  check('figures', 'the journal keeps the best loop score (journalStat aerobaticLoop, max)', loop.events.stats.some((stat) => stat.key === 'aerobaticLoop' && stat.op === 'max' && stat.value === (loopEvent ? loopEvent.score : NaN)));
  check('figures', 'figureFlown carries the craft and a position', Boolean(loopEvent) && loopEvent.craft === 'aerobatic' && Number.isFinite(loopEvent.position.y) && loopEvent.position.y > 1000, JSON.stringify(loopEvent ?? null));
  check('figures', 'craftState.lastFigure follows the figure', loop.craftState.lastFigure && loop.craftState.lastFigure.figure === 'loop');

  // Aileron roll, 100 %: full aileron until 340 degrees, then let go.
  flyFigure('aileronRoll', 1, { speed: 80, altitude: 1200, throttle: 0.8 }, (lab, memo) => {
    lab.pilot.roll = memo.roll < 330 ? 1 : 0;
    lab.pilot.pitch = 0;
    lab.pilot.yaw = 0;
    return memo.roll >= 330;
  });

  // Immelmann, 100 %: half a loop, then half a roll at the top.
  flyFigure('immelmann', 1, { speed: 90, altitude: 1200, throttle: 1 }, (lab, memo) => {
    const pitch = lab.data.pitch / DEG;
    if (pitch > 70) memo.up = true;
    if (!memo.rolling) {
      lab.pilot.pitch = 0.85;
      lab.pilot.roll = 0;
      if (memo.up && Math.abs(lab.data.bank / DEG) > 150 && pitch < 12) {
        memo.rolling = true;
        memo.roll = 0;
      }
      return false;
    }
    lab.pilot.pitch = 0;
    lab.pilot.roll = memo.roll < 165 ? 1 : 0;
    return memo.roll >= 165;
  });

  // Split-S, 100 %: half a roll to inverted, then pull through the bottom.
  flyFigure('splitS', 1, { speed: 60, altitude: 2000, throttle: 0.3 }, (lab, memo) => {
    const pitch = lab.data.pitch / DEG;
    if (!memo.pulling) {
      lab.pilot.roll = memo.roll < 172 ? 1 : 0;
      lab.pilot.pitch = 0;
      if (memo.roll >= 172) memo.pulling = true;
      return false;
    }
    lab.pilot.roll = 0;
    lab.pilot.pitch = 0.85;
    if (pitch < -70) memo.down = true;
    if (memo.down && pitch > -5) {
      lab.neutral();
      return true;
    }
    return false;
  });

  // Barrel roll, 100 %: pull and roll together all the way round.
  flyFigure('barrelRoll', 1, { speed: 85, altitude: 1200, throttle: 1 }, (lab, memo) => {
    lab.pilot.pitch = 0.4;
    lab.pilot.roll = memo.roll < 345 ? 0.28 : 0;
    if (memo.roll >= 345) {
      lab.neutral();
      return true;
    }
    return false;
  });

  // Hammerhead, 50 %: up a vertical line, full rudder as the speed dies, down the line, pull out.
  flyFigure('hammerhead', 0.5, { speed: 95, altitude: 1200, throttle: 1 }, (lab, memo) => {
    const pitch = lab.data.pitch / DEG;
    if (!memo.vertical) {
      lab.pilot.pitch = 0.8;
      if (pitch > 84) memo.vertical = true;
      return false;
    }
    if (!memo.pivot) {
      lab.pilot.pitch = clamp(0.05 * (90 - pitch), -0.5, 0.5);
      lab.pilot.roll = clamp(-0.02 * wrap180(lab.data.bank / DEG), -0.3, 0.3);
      if (lab.data.airspeed < 24) memo.pivot = true;
      return false;
    }
    if (!memo.down) {
      lab.pilot.yaw = -1;
      lab.pilot.pitch = 0;
      lab.pilot.roll = 0.3;
      if (pitch < -70) memo.down = true;
      return false;
    }
    lab.pilot.yaw = 0;
    lab.pilot.roll = 0;
    lab.pilot.pitch = 0.7;
    if (pitch > -5) {
      lab.neutral();
      return true;
    }
    return false;
  });

  // Inverted pass, 50 %: half a roll, 5 s upside down holding the height, half a roll back.
  flyFigure('invertedPass', 0.5, { speed: 80, altitude: 1200, throttle: 0.8 }, (lab, memo) => {
    memo.time = (memo.time ?? 0) + DT;
    if (!memo.inverted) {
      lab.pilot.roll = memo.roll < 175 ? 1 : 0;
      if (memo.roll >= 175) {
        memo.inverted = true;
        memo.level = createAltitudePilot(lab.altitude(), { inverted: true });
        memo.wings = createBankPilot(180);
        memo.start = memo.time;
      }
      return false;
    }
    if (memo.time - memo.start < 5) {
      memo.level.fly(lab);
      memo.wings.fly(lab);
      return false;
    }
    lab.pilot.pitch = 0;
    lab.pilot.roll = memo.roll < 355 ? 1 : 0;
    return memo.roll >= 355;
  });

  // Knife-edge pass, 30 %: roll to 90, 5 s on the rudder, roll back.
  const knife = createRig({ assists: 0.3 });
  knife.trimmed({ speed: 88, altitude: 1200, throttle: 1 });
  settle(knife, 2);
  const roll = createBankPilot(90, { gain: 1.4 });
  knife.run(1.2, (lab) => {
    roll.fly(lab);
    return false;
  });
  flyKnifeEdge(knife, 5);
  const back = createBankPilot(0, { gain: 1.4 });
  knife.run(1.5, (lab) => {
    back.fly(lab);
    lab.pilot.yaw = 0;
    lab.pilot.pitch = 0;
    return false;
  });
  settle(knife, 4);
  const knifeFigures = knife.events.figures.map((event) => `${event.figure} ${event.score}`).join(', ') || 'none';
  log(`  knifeEdge: ${knifeFigures}`);
  check('figures', 'knifeEdge recognized', knife.figure('knifeEdge').length === 1, knifeFigures);

  // Plain flying is no figure: a 60-degree turn through 90 degrees of heading, and back level.
  const turn = createRig({ assists: 1 });
  turn.trimmed({ speed: 80, altitude: 1200, throttle: 0.75 });
  settle(turn, 2);
  const bank = createBankPilot(60);
  const startHeading = turn.data.heading;
  turn.run(30, (lab) => {
    bank.fly(lab);
    lab.pilot.pitch = 0.25;
    return Math.abs(wrap180(lab.data.heading - startHeading)) > 90;
  });
  settle(turn, 6);
  check('figures', 'a 60-degree turn is no figure', turn.events.figures.length === 0, turn.events.figures.map((event) => event.figure).join(','));
}

// ============================================================================================
// SYNTHETIC TRAJECTORIES
// ============================================================================================
/**
 * Generates a flight from phases of body rates (deg/s: roll right, pitch up, yaw right), each
 * { seconds, roll, pitch, yaw, speed? (m/s, ramps from the previous), slide? (tail-first), stalled? }
 * and feeds the recognizer at 120 Hz. Starts straight and level at 80 m/s for 2 s, ends with 3 s.
 */
function synthesize(phases, { assists = 1, startSpeed = 80 } = {}) {
  const figures = [];
  const recognizer = createManeuverRecognizer({ onFigure: (figure, score) => figures.push({ figure, score }) });
  const input = createRecognizerInput();
  const attitude = new THREE.Quaternion();
  const step = new THREE.Quaternion();
  const omega = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const right = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let altitude = 1500;
  let speed = startSpeed;
  const all = [{ seconds: 2, roll: 0, pitch: 0, yaw: 0, speed: startSpeed }, ...phases, { seconds: 3, roll: 0, pitch: 0, yaw: 0 }];
  for (const phase of all) {
    const ticks = Math.round(phase.seconds / DT);
    const fromSpeed = speed;
    const toSpeed = Number.isFinite(phase.speed) ? phase.speed : speed;
    for (let tick = 0; tick < ticks; tick++) {
      speed = fromSpeed + (toSpeed - fromSpeed) * ((tick + 1) / ticks);
      omega.set(phase.pitch * DEG, -phase.yaw * DEG, -phase.roll * DEG);
      const rate = omega.length();
      if (rate > 1e-9) attitude.multiply(step.setFromAxisAngle(omega.clone().divideScalar(rate), rate * DT)).normalize();
      forward.set(0, 0, -1).applyQuaternion(attitude);
      up.set(0, 1, 0).applyQuaternion(attitude);
      right.set(1, 0, 0).applyQuaternion(attitude);
      velocity.copy(forward).multiplyScalar(phase.slide ? -speed : speed);
      altitude += velocity.y * DT;
      input.dt = DT;
      input.pitch = Math.asin(clamp(forward.y, -1, 1));
      input.bank = Math.atan2(-right.y, up.y);
      if (Math.hypot(forward.x, forward.z) > 0.05) input.heading = headingFromVector(forward.x, forward.z);
      input.rollRate = phase.roll * DEG;
      input.pitchRate = phase.pitch * DEG;
      input.yawRate = phase.yaw * DEG;
      input.gLoad = Number.isFinite(phase.g) ? phase.g : 1 + (speed * phase.pitch * DEG) / 9.81;
      input.stalled = phase.stalled === true;
      input.airspeed = speed;
      input.verticalSpeed = velocity.y;
      input.flightPath = Math.atan2(velocity.y, Math.max(Math.hypot(velocity.x, velocity.z), 0.1));
      input.altitude = altitude;
      input.onGround = false;
      input.assists = assists;
      recognizer.sample(input);
    }
  }
  return figures;
}

function testSynthetic() {
  const cases = [
    { id: 'loop', phases: [{ seconds: 6, roll: 0, pitch: 60, yaw: 0 }] },
    { id: 'aileronRoll', phases: [{ seconds: 0.9, roll: 400, pitch: 0, yaw: 0 }] },
    { id: 'barrelRoll', phases: [{ seconds: 4, roll: 90, pitch: 55, yaw: 0, g: 3 }] },
    { id: 'immelmann', phases: [{ seconds: 3, roll: 0, pitch: 60, yaw: 0, speed: 45 }, { seconds: 0.5, roll: 360, pitch: 0, yaw: 0 }] },
    { id: 'splitS', phases: [{ seconds: 0.5, roll: 360, pitch: 0, yaw: 0 }, { seconds: 3, roll: 0, pitch: 60, yaw: 0, speed: 95 }] },
    {
      id: 'cubanEight',
      phases: [
        { seconds: 3.75, roll: 0, pitch: 60, yaw: 0 }, { seconds: 0.5, roll: 360, pitch: 0, yaw: 0 },
        { seconds: 4.5, roll: 0, pitch: 60, yaw: 0 }, { seconds: 0.5, roll: 360, pitch: 0, yaw: 0 }, { seconds: 0.75, roll: 0, pitch: 60, yaw: 0 },
      ],
    },
    {
      id: 'hammerhead',
      phases: [
        { seconds: 1.5, roll: 0, pitch: 60, yaw: 0, speed: 60 }, { seconds: 2, roll: 0, pitch: 0, yaw: 0, speed: 8 },
        { seconds: 2, roll: 0, pitch: 0, yaw: 90, speed: 6 }, { seconds: 2, roll: 0, pitch: 0, yaw: 0, speed: 50 }, { seconds: 1.5, roll: 0, pitch: 60, yaw: 0, speed: 70 },
      ],
    },
    {
      id: 'tailslide',
      phases: [
        { seconds: 1.5, roll: 0, pitch: 60, yaw: 0, speed: 50 }, { seconds: 2.5, roll: 0, pitch: 0, yaw: 0, speed: 1 },
        { seconds: 1.5, roll: 0, pitch: 0, yaw: 0, speed: 8, slide: true }, { seconds: 1, roll: 0, pitch: -180, yaw: 0, speed: 3 },
        { seconds: 2, roll: 0, pitch: 0, yaw: 0, speed: 50 }, { seconds: 1.5, roll: 0, pitch: 60, yaw: 0, speed: 70 },
      ],
    },
    { id: 'snapRoll', phases: [{ seconds: 0.25, roll: 0, pitch: 40, yaw: 0, speed: 50 }, { seconds: 1.2, roll: 300, pitch: 10, yaw: 60, stalled: true }, { seconds: 0.2, roll: 0, pitch: -50, yaw: 0, speed: 55 }] },
    { id: 'lomcevak', assists: 0, phases: [{ seconds: 0.5, roll: 120, pitch: 60, yaw: 0, speed: 45 }, { seconds: 2.2, roll: 60, pitch: 250, yaw: 160, stalled: true, speed: 25 }, { seconds: 3, roll: 0, pitch: 0, yaw: 0, speed: 60 }, { seconds: 0.6, roll: 0, pitch: wrap180Rate(), yaw: 0 }] },
    { id: 'knifeEdge', phases: [{ seconds: 0.3, roll: 300, pitch: 0, yaw: 0 }, { seconds: 4, roll: 0, pitch: 0, yaw: 0 }, { seconds: 0.3, roll: -300, pitch: 0, yaw: 0 }] },
    { id: 'invertedPass', phases: [{ seconds: 0.5, roll: 360, pitch: 0, yaw: 0 }, { seconds: 4, roll: 0, pitch: 0, yaw: 0 }, { seconds: 0.5, roll: -360, pitch: 0, yaw: 0 }] },
  ];
  const covered = new Set();
  for (const { id, phases, assists = 1 } of cases) {
    const figures = synthesize(phases, { assists });
    const names = figures.map((entry) => `${entry.figure} ${entry.score}`).join(', ') || 'none';
    log(`  synthetic ${id}: ${names}`);
    const pass = figures.length === 1 && figures[0].figure === id && figures[0].score >= 0 && figures[0].score <= 100;
    if (pass) covered.add(id);
    check('synthetic', `${id} recognized`, pass, names);
  }
  check('synthetic', 'every one of the 12 figures recognized', FIGURE_IDS.every((id) => covered.has(id)), [...covered].join(', '));
  const tumble = cases.find((entry) => entry.id === 'lomcevak');
  const assisted = synthesize(tumble.phases, { assists: LOMCEVAK_MAX_ASSISTS + 0.25 });
  check('synthetic', `a tumble at ${Math.round((LOMCEVAK_MAX_ASSISTS + 0.25) * 100)} % assists is not credited as a lomcevak`, assisted.length === 0, assisted.map((entry) => entry.figure).join(','));
  const halfRoll = synthesize([{ seconds: 0.5, roll: 360, pitch: 0, yaw: 0 }, { seconds: 1, roll: 0, pitch: 0, yaw: 0 }, { seconds: 0.5, roll: -360, pitch: 0, yaw: 0 }]);
  check('synthetic', 'a half roll and back is no figure', halfRoll.length === 0, halfRoll.map((entry) => entry.figure).join(','));
  const sloppy = synthesize([{ seconds: 0.9, roll: 400, pitch: 0, yaw: 18 }]);
  const clean = synthesize([{ seconds: 0.9, roll: 400, pitch: 0, yaw: 0 }]);
  check('synthetic', 'a roll that wanders off heading scores lower than a clean one', sloppy.length === 1 && clean.length === 1 && sloppy[0].score < clean[0].score, `${sloppy[0]?.score} < ${clean[0]?.score}`);
}

/** The lomcevak's last pitch phase: brings the tumble's body pitch back to the horizon. */
function wrap180Rate() {
  // 250 deg/s for 2.2 s = 550 deg of tumble pitch plus 30 of the entry: 580; -220 brings it to 360.
  return -220 / 0.6;
}

// ============================================================================================
// THE FLIGHT CONTROLLER
// ============================================================================================
function ensureDocumentStandIn() {
  if (typeof globalThis.document !== 'undefined') return;
  const element = { style: {}, setAttribute() {} };
  globalThis.document = { body: { appendChild() {} }, getElementById: () => null, createElement: () => element };
}

const FRAME = 1 / 60;
const GROUND = 200;

function createControllerRig({ craft = 'aerobatic' } = {}) {
  ensureDocumentStandIn();
  const registry = createCraftRegistry();
  registry.register(bushplane);
  registry.register(aerobatic);
  const world = { groundHeight: () => GROUND, heightAt: () => GROUND, WATER_LEVEL: CONFIG.WATER_LEVEL };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], softCrash: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('softCrash', (payload) => events.softCrash.push(payload));
  const heading = 30;
  const altitude = 1500;
  const player = {
    position: new THREE.Vector3(0, altitude, 0),
    velocity: vectorFromHeading(heading).multiplyScalar(70),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG),
    forward: vectorFromHeading(heading),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(1, 0, 0),
    speed: 70, throttle: 0.7, heading, pitch: 0, roll: 0, yawRate: 0, verticalSpeed: 0, gForce: 1,
    altitude, groundHeight: GROUND, agl: altitude - GROUND, stalled: false,
    autopilot: { enabled: false, heading, altitude, followWaypoint: false }, inCloud: 0,
  };
  const state = {
    frame: 0, paused: false, photoMode: false, seed: 'AEROBATIC-LAB',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 30, dayTime: 0.45 },
    player, flight: createFlightTelemetry(), waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const settingsValues = { craft, startOnGround: false, assists: Object.fromEntries(CRAFT_IDS.map((id) => [id, 1])), craftFavorites: DEFAULT_CRAFT_FAVORITES.slice(), craftSkins: {} };
  const controls = createControlState();
  const { uniform } = TSL;
  const windField = {
    sample(pos, t, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
      out.vel.set(0, 0, 0);
      out.turbulence = 0;
      return out;
    },
    ambientAt: () => ({ speed: 0, fromDegrees: 0 }),
    lastLayers: { gust: new THREE.Vector3() },
  };
  const scene = new THREE.Scene();
  const ctx = {
    THREE, TSL, scene, camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 50000), state, controls, bus, world,
    uniforms: { time: uniform(0), sunDirection: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)), skyHorizonColor: uniform(new THREE.Color(1, 1, 1)), skyZenithColor: uniform(new THREE.Color(1, 1, 1)), nightFactor: uniform(0) },
    craftRegistry: registry,
    flightModels,
    settings: {
      get: (key) => {
        const value = settingsValues[key];
        if (Array.isArray(value)) return value.slice();
        return value && typeof value === 'object' ? { ...value } : value;
      },
      set(key, value) {
        settingsValues[key] = value;
        bus.emit('settings:changed', { key, value, settings: { ...settingsValues } });
        return true;
      },
      update(key, patch) {
        settingsValues[key] = { ...settingsValues[key], ...patch };
        bus.emit('settings:changed', { key, value: settingsValues[key], settings: { ...settingsValues } });
        return true;
      },
    },
    wind: windField,
    systems: { camera: { snap() {} }, input: { presetThrottle: (value) => { controls.throttle = value; return true; } } },
    registerPrewarm() {},
  };
  const flight = createFlightController(ctx);
  ctx.systems.flight = flight;
  const rig = { flight, state, controls, events, ctx, scene };
  rig.frame = () => {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.frameDt = FRAME;
    flight.update(FRAME, FRAME);
    flight.publishTelemetry(FRAME);
  };
  rig.run = (seconds, script) => {
    for (let frame = 0; frame < Math.round(seconds / FRAME); frame++) {
      if (script) script(rig);
      rig.frame();
    }
  };
  rig.press = (id) => {
    controls.actions.add(id);
    rig.frame();
  };
  rig.ribbon = () => flight.planeMesh.userData.smokeRibbon;
  return rig;
}

function testController() {
  const rig = createControllerRig();
  const start = rig.state.flight.altitude;
  rig.run(30);
  const flight = rig.state.flight;
  check('controller', 'boots the aerobatic at cruise on its own model kind', flight.craft === 'aerobatic' && rig.flight.getModel().kind === 'aerobatic', `${flight.craft} / ${rig.flight.getModel().kind}`);
  record('controller', '30 s hands off at 100 %: height change', Math.abs(flight.altitude - start), 60, { unit: 'm', compare: 'max' });
  check('controller', 'no soft crash', rig.events.softCrash.length === 0);
  check('controller', 'state.flight.craftState has the h.3 fields', ['smoke', 'smokeColor', 'figureInProgress', 'lastFigure'].every((field) => field in flight.craftState), JSON.stringify(flight.craftState));

  // Space: smoke on; the ribbon follows the nozzle and the puffs stream.
  rig.press('craftAbility');
  check('controller', 'Space switches the smoke on', flight.craftState.smoke === true, rig.events.notify.at(-1));
  rig.run(3);
  const laid = rig.ribbon().getStats();
  check('controller', 'the ribbon is laid behind the craft', laid.liveSamples > 40 && laid.emitting, JSON.stringify(laid));
  check('controller', 'the puffs stream from the nozzle too', rig.flight.getStats().trailParticles > 20, `${rig.flight.getStats().trailParticles}`);
  rig.press('craftAbilityAlt');
  check('controller', 'Shift+Space cycles the colour', flight.craftState.smokeColor === 1, rig.events.notify.at(-1));
  // 30 s at 80 m/s is 2.4 km: the anchor follows and the buffer stays small.
  rig.run(30);
  const ribbon = rig.ribbon();
  const positions = ribbon.mesh.geometry.getAttribute('position').array;
  let largest = 0;
  for (let index = 0; index < positions.length; index++) largest = Math.max(largest, Math.abs(positions[index]));
  const afterFlight = ribbon.getStats();
  check('controller', 'the ribbon re-anchors past 2 km (origin rule a.7)', afterFlight.reanchors >= 2, JSON.stringify(afterFlight));
  record('controller', 'largest float32 ribbon coordinate', largest, SMOKE_RIBBON.REANCHOR + 1500, { unit: 'm', compare: 'max', decimals: 0 });
  check('controller', 'the ring stays within its capacity', afterFlight.liveSamples <= SMOKE_RIBBON.CAPACITY, `${afterFlight.liveSamples}`);

  // The copilot's commands and status.
  const blue = rig.flight.runCraftCommand('smokeColor', 'blue');
  check('controller', '"blue smoke" picks blue', blue.ok && flight.craftState.smokeColor === 2, blue.text);
  const off = rig.flight.runCraftCommand('smoke', 'off');
  check('controller', '"smoke off" switches it off', off.ok && flight.craftState.smoke === false, off.text);
  const listed = rig.flight.getCraftCommands().map((command) => command.id).join(',');
  check('controller', 'the commands reach the copilot', listed === 'smoke,smokeColor,lastFigure,figures', listed);
  const status = rig.flight.getCraftStatus();
  check('controller', 'the status speaks the smoke and the last figure', /Smoke off/.test(status) && /Last figure/.test(status), status);
  const phrase = aerobatic.copilot.commands.find((command) => command.id === 'smokeColor').phrases.map((source) => new RegExp(source, 'i'));
  check('controller', 'the colour phrases capture the colour', phrase[0].exec('red smoke please')?.[1] === 'red' && phrase[1].exec('smoke colour yellow')?.[1] === 'yellow' && phrase[2].test('next colour'));

  // The smoke fades out over 30 s and the ribbon hides.
  rig.run(SMOKE_RIBBON.LIFE + 1);
  const faded = ribbon.getStats();
  check('controller', 'the ribbon fades out over 30 s and hides', faded.liveSamples === 0 && ribbon.mesh.visible === false, JSON.stringify(faded));

  // A switch away disposes the ribbon with the craft; a switch back from the bush plane flying situates it.
  const sceneChildren = rig.scene.children.length;
  rig.ctx.settings.set('craft', 'bushplane');
  rig.run(1);
  check('controller', 'the ribbon leaves the scene with the craft', !rig.scene.children.includes(ribbon.mesh) && rig.scene.children.length < sceneChildren, `${sceneChildren} -> ${rig.scene.children.length}`);
  rig.run(5);
  rig.ctx.settings.set('craft', 'aerobatic');
  rig.run(1);
  const airspeed = rig.state.flight.airspeed;
  check('controller', 'from the bush plane in flight it flies on at a figure speed (situate)', rig.state.flight.craft === 'aerobatic' && !rig.state.flight.onGround && airspeed >= 50 && airspeed <= 90, `${airspeed.toFixed(1)} m/s`);
  rig.run(10);
  check('controller', 'no soft crash after the switch', rig.events.softCrash.length === 0);

  // The journal knows the figure stats (module journal.stats).
  check('controller', 'every figure has a max-score journal stat', aerobatic.journal.stats.length === 12 && aerobatic.journal.stats.every((stat) => stat.op === 'max' && stat.unit === 'points'));
  check('controller', 'the game registry has the aerobatic module', craftRegistry.has('aerobatic'));
}

// ============================================================================================
// INSTRUMENTS
// ============================================================================================
function createPenStandIn() {
  const calls = { count: 0 };
  const pen = new Proxy({}, {
    get(target, property) {
      if (property in target) return target[property];
      if (property === 'measureText') return () => ({ width: 10 });
      return () => {
        calls.count++;
      };
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
  return { pen, calls };
}

async function testInstruments() {
  const { THEMES } = await import('../../src/ui/instruments/gaugeKit.js');
  const states = [
    { smoke: false, smokeColor: 0, figureInProgress: null, lastFigure: null },
    { smoke: true, smokeColor: 4, figureInProgress: 'loop', lastFigure: null },
    { smoke: true, smokeColor: 9, figureInProgress: null, lastFigure: { figure: 'cubanEight', score: 87 } },
  ];
  let drawn = 0;
  let problem = '';
  for (const id of ['smoke', 'figure']) {
    for (const theme of Object.values(THEMES)) {
      for (const craftState of states) {
        const { pen, calls } = createPenStandIn();
        const flight = createFlightTelemetry();
        flight.craftState = craftState;
        flight.gLoad = 4.2;
        try {
          INSTRUMENTS[id].draw(pen, { flight, craft: aerobatic, units: null }, theme, null);
          if (calls.count > 0) drawn++;
        } catch (error) {
          problem = `${id} ${theme.id}: ${error.message}`;
        }
      }
    }
  }
  check('instruments', 'smoke and figure draw in both themes and every state', drawn === 2 * Object.keys(THEMES).length * states.length && !problem, problem || `${drawn} draws`);
  check('instruments', 'the craft lists both, and its panel shows them', ['smoke', 'figure'].every((id) => aerobatic.instruments.includes(id) && aerobatic.cameraRig.cockpit.panel.layout.flat().includes(id)));
}

// ============================================================================================
// ALLOCATION
// ============================================================================================
function testAllocation() {
  if (typeof globalThis.gc !== 'function') {
    check('allocation', 'recognizer allocation (run with --expose-gc to measure)', true, 'skipped: no --expose-gc');
    return;
  }
  const recognizer = createManeuverRecognizer();
  const input = createRecognizerInput();
  input.dt = DT;
  input.airspeed = 80;
  input.altitude = 1500;
  const feed = (count) => {
    for (let index = 0; index < count; index++) {
      const t = index * DT;
      input.bank = Math.sin(t * 0.7) * 2;
      input.pitch = Math.sin(t * 0.3) * 0.8;
      input.rollRate = Math.cos(t * 0.7) * 1.4;
      input.pitchRate = Math.cos(t * 0.3) * 0.24;
      input.heading = (t * 20) % 360;
      recognizer.sample(input);
    }
  };
  feed(20000);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  feed(200000);
  globalThis.gc();
  const growth = process.memoryUsage().heapUsed - before;
  record('allocation', 'heap growth over 200 000 recognizer samples', growth / 1024, 64, { unit: 'KB', compare: 'max', decimals: 1 });
}

// ============================================================================================
// RUN
// ============================================================================================
const TESTS = [
  ['stall', testStall], ['inverted', testInverted], ['roll', testRoll], ['cruise', testCruise], ['climb', testClimb],
  ['g', testLoads], ['handsOff', testHandsOff], ['hang', testHang], ['snap', testSnap], ['knifeEdge', testKnifeEdge],
  ['figures', testFigures], ['synthetic', testSynthetic], ['controller', testController], ['instruments', testInstruments],
  ['allocation', testAllocation],
];
for (const [name, test] of TESTS) {
  if (ONLY.length > 0 && !ONLY.includes(name)) continue;
  log(`${name}:`);
  await test();
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (VERBOSE || !result.pass) process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(12)} ${result.name}: ${result.measured} (target ${result.target})\n`);
}
process.stdout.write(`\naerobatic lab: ${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed > 0 ? 1 : 0);
