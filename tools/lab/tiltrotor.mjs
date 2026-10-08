// Tiltrotor flight lab: flies SimTiltrotor headless (node, no renderer) through the same control
// stages the game runs every physics tick (the tiltrotor autopilot and assists), and prints the
// measured handling against the craft's targets (src/craft/tiltrotor.js simProfile.targets).
//
// The air is the standard atmosphere over flat ground at sea level, with no wind. Physics runs at the
// game's fixed 120 Hz.
//
// Tests:
//   corridor      the conversion corridor's edges, the auto-nacelle schedule, the detent steps and the
//                 HOTAS lever's detents (tiltrotorCorridor.js)
//   hover         100 % assists hands off: hover lever, power, the wing's download, drift
//   climb         full lever at 50 % assists: vertical climb rate, the proprotor rpm held by the FCS
//   level         a lab pilot holds level flight in airplane mode: the cruise lever at 110 m/s, the
//                 elevator to trim from 70 to 140 m/s, the maximum level speed at full lever
//   stall         decelerating level in airplane mode: the wing reaches its critical angle at the
//                 stall speed (flaperons drooped)
//   conversion    100 % assists: hover to airplane mode with the auto-nacelle schedule and back, both
//                 inside the corridor; both conversions in the journal
//   schedule      auto-nacelle: airplane mode selected in a hover tilts the nacelles only to the
//                 corridor's edge; auto-nacelle off: straight through it (the wing-stall state)
//   overspeed     auto-nacelle off at 120 m/s, nacelles to the hover: the rotor-overspeed state, blade
//                 stall buffet, a hard deceleration; at 0 % assists the nose pitches up
//   wingStall     auto-nacelle off in airplane mode, the lever at idle: the wing-stall state and
//                 warning, the craft sinks
//   controls      0 % assists: the stick and pedals in helicopter mode (cyclic, differential collective
//                 and cyclic) and in airplane mode (flaperons, elevator, rudders) move the craft the
//                 right way
//   ground        on the wheels the nacelles stop at 60 degrees; a proprotor touching the ground is
//                 a body strike; a 100 % assists landing from a hover is graded and parks
//   pickup        a respawn with the lever at full: the thrust holds until the lever moves
//   autopilot     from a hover to 110 m/s in airplane mode at 800 m, heading 90; hands-off hover hold
//   catalog       the assist catalog the UI lists at 100 / 50 / 0 %
//   craftState    the h.3 fields (nacelleAngle, nacelleTarget, autoNacelle, corridor)
//   allocation    the model step allocates no per-tick objects (bytes per tick against the helicopter
//                 model, V8's number boxing aside)
//
// Usage: node tools/lab/tiltrotor.mjs [--verbose]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import inspector from 'node:inspector/promises';
import * as THREE from 'three/webgpu';
import tiltrotor from '../../src/craft/tiltrotor.js';
import helicopter from '../../src/craft/helicopter.js';
import { flightModels } from '../../src/flight/models.js';
import { describeAssists } from '../../src/flight/assists.js';
import { trimModel } from '../../src/flight/trim.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { groundPose } from '../../src/flight/placement.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp } from '../../src/core/util.js';
import { NACELLE, corridorParameters, conversionCorridor, scheduledNacelle, stepNacelle, leverToNacelle } from '../../src/flight/tiltrotorCorridor.js';

const DT = 1 / 120;
const WATER_LEVEL = -60;
const OPTIONS = { verbose: process.argv.includes('--verbose') };
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const targets = tiltrotor.simProfile.targets;
const PARAMETERS = corridorParameters(tiltrotor.simProfile);

function log(...parts) {
  if (OPTIONS.verbose) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/**
 * One tiltrotor in the lab: the model, the pilot's ControlState (the throttle axis is the thrust
 * lever, mapped to the collective as the input profile says), the tick copy the control stages
 * shape, the environment and the craft state. override(controls, rig) runs after the stages.
 */
function createRig({ assists = 0, ground = 0 } = {}) {
  const craft = tiltrotor;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [], stats: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  bus.onTyped('journalStat', (payload) => events.stats.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const world = createFlatWorld(ground);
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0.5;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, autopilot, env, context, events, telemetry, craftState, world, time: 0, override: null };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    controls.collective = controls.throttle;
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    if (rig.override) rig.override(controls, rig);
    env.time += DT;
    env.rho = airDensity(model.state.position.y);
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
  };
  /** Airborne at `altitude` m, heading, forward speed, the lever at `lever`, trimmed as the game trims a reset. */
  rig.airborne = ({ altitude = 600, heading = 0, speed = 0, lever = 0.5 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG);
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle: lever, onGround: false, engineOn: true });
    env.rho = airDensity(altitude);
    trimModel(model, { env, dt: DT, throttle: lever, trim: 0 });
    pilot.throttle = lever;
  };
  /** At rest on the wheels on the flat ground, nacelles at the hover detent. */
  rig.parked = ({ heading = 0, lever = 0 } = {}) => {
    const profile = craft.simProfile;
    const pose = groundPose(world, profile.contacts, 0, 0, heading, profile.centerOfMass[2]);
    model.reset({ position: pose.position, quaternion: pose.quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = lever;
  };
  rig.press = (action) => pilot.actions.add(action);
  rig.position = () => model.state.position;
  return rig;
}

/** A lab pilot holding level flight in airplane mode: elevator on the vertical speed, lever on the speed. */
function createLevelPilot(rig, speed, { lever = null } = {}) {
  const data = rig.data;
  let pitchIntegral = data.pitch;
  let leverIntegral = 0.5;
  let elevatorIntegral = 0;
  return (controls) => {
    const verticalError = -data.verticalSpeed;
    pitchIntegral = clamp(pitchIntegral + (0.004 * verticalError) / 120, -0.25, 0.35);
    const pitchError = pitchIntegral + 0.006 * verticalError - data.pitch;
    elevatorIntegral = clamp(elevatorIntegral + (1.0 * pitchError) / 120, -1, 1);
    controls.pitch = clamp(elevatorIntegral + 2.5 * pitchError - 2.0 * data.pitchRate, -1, 1);
    controls.roll = clamp(-1.5 * data.bank - 0.5 * data.rollRate, -1, 1);
    controls.yaw = 0;
    if (lever !== null) {
      controls.collective = lever;
    } else {
      const speedError = speed - data.airspeed;
      leverIntegral = clamp(leverIntegral + (0.004 * speedError) / 120, 0, 1);
      controls.collective = clamp(leverIntegral + 0.02 * speedError, 0, 1);
    }
  };
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = 0.1, compare = 'within', note = '', decimals = 2 } = {}) {
  let pass;
  if (compare === 'within') pass = Math.abs(measured - target) <= Math.abs(target) * tolerance;
  else if (compare === 'max') pass = measured <= target;
  else if (compare === 'min') pass = measured >= target;
  else if (compare === 'range') pass = measured >= target[0] && measured <= target[1];
  else pass = Boolean(compare);
  const format = (value) => (typeof value === 'number' ? value.toFixed(decimals) : String(value));
  const suffix = unit ? ` ${unit}` : '';
  let targetText;
  if (compare === 'within') targetText = `${format(target)}${suffix} +/-${Math.round(tolerance * 100)}%`;
  else if (compare === 'max') targetText = `<= ${format(target)}${suffix}`;
  else if (compare === 'min') targetText = `>= ${format(target)}${suffix}`;
  else if (compare === 'range') targetText = `${format(target[0])}..${format(target[1])}${suffix}`;
  else targetText = String(target);
  results.push({ test, measured: `${format(measured)}${suffix}`, target: targetText, pass, note });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

// ============================================================================================
// TESTS
// ============================================================================================
/** The corridor maths: edges at sea level, the schedule, the detents and the lever. */
function testCorridor() {
  const out = { min: 0, max: 0 };
  conversionCorridor(0, 1.225, PARAMETERS, out);
  record('corridor at 0 m/s: lower edge (rotor thrust margin)', out.min, 60.4, { unit: 'deg', tolerance: 0.03, note: `upper ${out.max.toFixed(1)} deg (the aft stop)` });
  record('corridor at 0 m/s: upper edge', out.max, NACELLE.MAX, { unit: 'deg', tolerance: 0.001 });
  let lowerZero = NaN;
  for (let speed = 0; speed <= 120; speed += 0.5) {
    conversionCorridor(speed, 1.225, PARAMETERS, out);
    if (out.min <= 0) {
      lowerZero = speed;
      break;
    }
  }
  record('corridor lower edge reaches airplane mode', lowerZero, targets.stallSpeed, { unit: 'm/s', tolerance: 0.05, note: 'wing at 0.9 x flapped CLmax carries 1 g' });
  conversionCorridor(110, 1.225, PARAMETERS, out);
  record('corridor upper edge at 110 m/s (edgewise limit)', out.max, Math.asin(55 / 110) / DEG, { unit: 'deg', tolerance: 0.01 });
  conversionCorridor(0, 1.225, PARAMETERS, out);
  const hoverSchedule = scheduledNacelle(NACELLE.MIN, out, PARAMETERS.margin);
  const hoverHeld = scheduledNacelle(NACELLE.HOVER, out, PARAMETERS.margin);
  record('auto-nacelle: airplane mode selected at 0 m/s', hoverSchedule, out.min + PARAMETERS.margin, { unit: 'deg', tolerance: 0.01, note: `the hover detent stays at ${hoverHeld} deg` });
  const forward = [stepNacelle(90, -1), stepNacelle(60, -1), stepNacelle(0, -1)];
  const up = [stepNacelle(0, 1), stepNacelle(60, 1), stepNacelle(90, 1), stepNacelle(97, 1)];
  const stepsOk = forward.join() === '60,0,0' && up.join() === '60,90,97,97' && stepNacelle(45, 1) === 60 && stepNacelle(45, -1) === 0;
  record('detent steps (flap buttons)', stepsOk ? 1 : 0, 1, { compare: stepsOk, note: `forward ${forward.join(' > ')}, up ${up.join(' > ')}` });
  const lever = [leverToNacelle(0), leverToNacelle(60 / 97 + 0.02), leverToNacelle(90 / 97 - 0.02), leverToNacelle(1), leverToNacelle(0.4)];
  const leverOk = lever[0] === 0 && lever[1] === 60 && lever[2] === 90 && lever[3] === 97 && Math.abs(lever[4] - 38.8) < 0.01;
  record('antenna lever: detents snap, travel 0-97', leverOk ? 1 : 0, 1, { compare: leverOk, note: lever.map((value) => value.toFixed(1)).join(', ') });
}

/** Out-of-ground-effect hover at 100 % assists, hands off. */
function testHover() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 600 });
  rig.run(20);
  const lever = [];
  const power = [];
  const download = [];
  const drift = [];
  rig.run(10, (lab) => {
    lever.push(lab.data.collective);
    power.push(lab.model.rotor.enginePower / (tiltrotor.simProfile.engine.powerKw * 1000));
    download.push(-lab.model.rotor.wingLift / lab.data.weight);
    drift.push(lab.data.groundSpeed);
  });
  record('hover OGE thrust lever', average(lever), targets.hoverCollective, { tolerance: 0.1, note: `${(rig.data.mass / 1000).toFixed(0)} t, nacelles ${rig.craftState.nacelleAngle} deg` });
  record('hover OGE power', average(power) * 100, targets.hoverPower * 100, { unit: '%', tolerance: 0.15, decimals: 1 });
  record('hover download on the wing', average(download) * 100, [5, 15], { unit: '% of weight', compare: 'range', decimals: 1, note: 'flaperons drooped' });
  record('hover drift hands off', Math.max(...drift), 1, { unit: 'm/s', compare: 'max' });
}

/** Full lever from a hover at 50 % assists (attitude held): vertical climb, rpm held by the FCS. */
function testClimb() {
  const rig = createRig({ assists: 0.5 });
  rig.airborne({ altitude: 300 });
  rig.run(3);
  rig.pilot.throttle = 1;
  rig.run(8);
  const climbs = [];
  const rpm = [];
  rig.run(4, (lab) => {
    climbs.push(lab.data.verticalSpeed);
    rpm.push(lab.data.rotorRpm);
  });
  record('vertical climb at full lever', average(climbs), targets.verticalClimb, { unit: 'm/s', tolerance: 0.25, note: `proprotors ${(average(rpm) * 100).toFixed(1)} %, power limited` });
  record('proprotor rpm held at full lever (FCS droop protection)', Math.min(...rpm) * 100, 95, { unit: '%', compare: 'min', decimals: 1 });
}

/** Level flight in airplane mode: cruise lever, trim across the speeds, maximum level speed. */
function testLevel() {
  const elevators = [];
  let cruiseLever = NaN;
  for (const speed of [70, 90, 110, 140]) {
    const rig = createRig({ assists: 0 });
    rig.airborne({ altitude: 1000, speed, lever: 0.55 });
    rig.override = createLevelPilot(rig, speed);
    rig.run(90);
    elevators.push(`${speed}: ${rig.controls.pitch.toFixed(2)}`);
    if (speed === 110) cruiseLever = rig.controls.collective;
    if (Math.abs(rig.controls.pitch) > 0.3) record(`trim elevator at ${speed} m/s`, rig.controls.pitch, 0.3, { compare: 'max' });
  }
  record('cruise lever at 110 m/s (airplane mode, 1000 m)', cruiseLever, targets.cruiseLever, { tolerance: 0.25, note: `elevator to trim ${elevators.join(', ')}` });
  const fast = createRig({ assists: 0 });
  fast.airborne({ altitude: 300, speed: 125, lever: 0.6 });
  fast.override = createLevelPilot(fast, 0, { lever: 1 });
  fast.run(150);
  record('maximum level speed at full lever', fast.data.airspeed, targets.maxLevelSpeed, { unit: 'm/s', tolerance: 0.1, note: `${(fast.data.airspeed * 3.6).toFixed(0)} km/h at 300 m, torque ${(fast.data.torque * 100).toFixed(0)} %` });
}

/** Decelerating level in airplane mode until the wing reaches its critical angle. */
function testStall() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 600, speed: 80, lever: 0.55 });
  rig.craftState.autoNacelle = false;
  rig.craftState.nacelleTarget = 0;
  const level = createLevelPilot(rig, 0, { lever: 0.15 });
  rig.override = level;
  let stallSpeed = NaN;
  rig.run(60, (lab) => {
    if (lab.data.stallMargin <= 0) {
      stallSpeed = lab.data.airspeed * Math.sqrt(lab.env.rho / 1.225);
      return true;
    }
    return false;
  });
  record('wing stall speed (equivalent, flaperons drooped)', stallSpeed, targets.stallSpeed * Math.sqrt(0.9), { unit: 'm/s', tolerance: 0.1, note: 'the critical angle reached while holding level; the corridor edge sits 10 % of CL earlier' });
}

/** Hover to airplane mode and back at 100 % assists with the auto-nacelle schedule. */
function testConversion() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500 });
  rig.run(2);
  const startY = rig.position().y;
  rig.press('flapsUp');
  rig.tick();
  rig.press('flapsUp');
  rig.tick();
  rig.pilot.throttle = 0.8;
  let toAirplane = NaN;
  let corridorOk = true;
  let minY = Infinity;
  let maxY = -Infinity;
  rig.run(60, (lab) => {
    if (lab.craftState.corridor.state !== 'ok') corridorOk = false;
    minY = Math.min(minY, lab.position().y);
    maxY = Math.max(maxY, lab.position().y);
    if (lab.craftState.nacelleAngle <= 1) {
      toAirplane = lab.time - 2;
      return true;
    }
    return false;
  });
  record('conversion to airplane mode (auto-nacelle, lever 0.8)', toAirplane, targets.conversionSeconds, { unit: 's', compare: 'max', note: `at ${rig.data.airspeed.toFixed(0)} m/s, height ${(minY - startY).toFixed(0)}..${(maxY - startY).toFixed(0)} m` });
  record('conversion to airplane mode: inside the corridor', corridorOk ? 1 : 0, 1, { compare: corridorOk });
  rig.pilot.throttle = 0.62;
  rig.run(10);
  rig.press('flapsDown');
  rig.tick();
  rig.press('flapsDown');
  rig.tick();
  rig.pilot.throttle = 0.15;
  rig.pilot.pitch = 0.25;
  const backStart = rig.time;
  let toHover = NaN;
  let backCorridorOk = true;
  rig.run(60, (lab) => {
    if (lab.craftState.corridor.state !== 'ok') backCorridorOk = false;
    if (lab.craftState.nacelleAngle >= 75) {
      lab.pilot.throttle = 0.5;
      lab.pilot.pitch = 0;
    }
    if (lab.craftState.nacelleAngle >= 85) {
      toHover = lab.time - backStart;
      return true;
    }
    return false;
  });
  record('conversion back to helicopter mode (lever idle, gentle pull)', toHover, targets.conversionSeconds, { unit: 's', compare: 'max', note: `at ${rig.data.airspeed.toFixed(0)} m/s` });
  record('conversion back: inside the corridor', backCorridorOk ? 1 : 0, 1, { compare: backCorridorOk });
  const conversions = rig.events.stats.filter((stat) => stat.key === 'tiltrotorConversions').length;
  const fastest = rig.events.stats.find((stat) => stat.key === 'tiltrotorFastestConversion');
  record('journal: both conversions, the fastest to airplane mode', conversions, 2, { tolerance: 0, decimals: 0, note: fastest ? `fastest ${fastest.value} s` : 'no fastest conversion' });
}

/** Auto-nacelle in a hover holds the nacelles at the corridor's edge; off, they go straight through. */
function testSchedule() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500 });
  rig.run(1);
  rig.craftState.nacelleTarget = 0;
  rig.run(4);
  record('auto-nacelle: airplane mode selected in a hover', rig.craftState.nacelleAngle, [60, 70], { unit: 'deg', compare: 'range', decimals: 1, note: `corridor ${rig.craftState.corridor.min}..${rig.craftState.corridor.max} at ${rig.data.airspeed.toFixed(1)} m/s` });
  const manual = createRig({ assists: 1 });
  manual.airborne({ altitude: 500 });
  manual.run(1);
  manual.craftState.autoNacelle = false;
  manual.craftState.nacelleTarget = 0;
  let wingStall = false;
  manual.run(8, (lab) => {
    if (lab.craftState.corridor.state === 'wingStall') wingStall = true;
  });
  const warned = manual.events.notify.some((text) => /Wing stall/.test(text));
  record('auto-nacelle off: through the corridor (wing-stall state, warning)', wingStall && warned ? 1 : 0, 1, { compare: wingStall && warned, note: `nacelles ${manual.craftState.nacelleAngle} deg at ${manual.data.airspeed.toFixed(1)} m/s` });
}

/** Above the corridor: nacelles raised at 120 m/s with auto-nacelle off. */
function testOverspeed() {
  for (const assists of [1, 0]) {
    const rig = createRig({ assists });
    rig.airborne({ altitude: 1000, speed: 120, lever: 0.6 });
    rig.run(2);
    const startSpeed = rig.data.airspeed;
    const startPitch = rig.data.pitch;
    rig.craftState.autoNacelle = false;
    rig.craftState.nacelleTarget = 90;
    let overspeed = false;
    let buffet = 0;
    let maxPitch = -Infinity;
    rig.run(10, (lab) => {
      if (lab.craftState.corridor.state === 'overspeed') overspeed = true;
      lab.model.writeTelemetry(lab.telemetry);
      buffet = Math.max(buffet, lab.telemetry.stall.buffet);
      maxPitch = Math.max(maxPitch, lab.data.pitch);
    });
    const warned = rig.events.notify.some((text) => /Rotor overspeed/.test(text));
    const slowed = startSpeed - rig.data.airspeed;
    if (assists === 1) {
      record('overspeed: state and warning (100 %)', overspeed && warned ? 1 : 0, 1, { compare: overspeed && warned });
      record('overspeed: blade-stall buffet', buffet, 0.3, { compare: 'min' });
      record('overspeed: the raised discs slow the craft in 10 s', slowed, 20, { unit: 'm/s', compare: 'min' });
    } else {
      record('overspeed at 0 %: the nose pitches up', (maxPitch - startPitch) / DEG, 10, { unit: 'deg', compare: 'min', note: `slowed ${slowed.toFixed(0)} m/s` });
    }
  }
}

/** Below the corridor in airplane mode with the lever at idle. */
function testWingStall() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 1200, speed: 85, lever: 0.55 });
  rig.craftState.autoNacelle = false;
  rig.craftState.nacelleTarget = 0;
  rig.run(1);
  rig.pilot.throttle = 0.1;
  let state = false;
  let warning = false;
  let sink = 0;
  rig.run(30, (lab) => {
    if (lab.craftState.corridor.state === 'wingStall') state = true;
    lab.model.writeTelemetry(lab.telemetry);
    if (lab.telemetry.stall.warning) warning = true;
    sink = Math.max(sink, -lab.data.verticalSpeed);
  });
  record('wing stall: corridor state and stall warning', state && warning ? 1 : 0, 1, { compare: state && warning, note: `slowed to ${rig.data.airspeed.toFixed(0)} m/s` });
  record('wing stall: the craft sinks', sink, 8, { unit: 'm/s', compare: 'min' });
}

/** The stick and pedals move the craft the right way in both modes (0 % assists). */
function testControls() {
  const response = (speed, axis, value) => {
    const rig = createRig({ assists: 0 });
    rig.airborne({ altitude: 800, speed, lever: speed > 0 ? 0.56 : 0.5 });
    rig.run(0.5);
    rig.pilot[axis] = value;
    rig.run(1.5);
    return { roll: rig.data.rollRate, pitch: rig.data.pitchRate, yaw: rig.data.yawRate };
  };
  const hoverRoll = response(0, 'roll', 0.5).roll;
  const hoverPitch = response(0, 'pitch', 0.5).pitch;
  const hoverYaw = response(0, 'yaw', 0.5).yaw;
  const planeRoll = response(110, 'roll', 0.5).roll;
  const planePitch = response(110, 'pitch', 0.3).pitch;
  const planeYaw = response(110, 'yaw', 0.5).yaw;
  const hoverOk = hoverRoll > 0.05 && hoverPitch > 0.03 && hoverYaw > 0.03;
  const planeOk = planeRoll > 0.2 && planePitch > 0.03 && planeYaw > 0.02;
  record('helicopter mode: right stick rolls right, pull pitches up, right pedal yaws right', hoverOk ? 1 : 0, 1, { compare: hoverOk, note: `rad/s roll ${hoverRoll.toFixed(2)}, pitch ${hoverPitch.toFixed(2)}, yaw ${hoverYaw.toFixed(2)}` });
  record('airplane mode: the same through the flaperons, elevator and rudders', planeOk ? 1 : 0, 1, { compare: planeOk, note: `rad/s roll ${planeRoll.toFixed(2)}, pitch ${planePitch.toFixed(2)}, yaw ${planeYaw.toFixed(2)}` });
}

/** On the wheels: the nacelle limit, a proprotor strike near the ground, a 100 % assists landing. */
function testGround() {
  const parked = createRig({ assists: 1 });
  parked.parked();
  parked.press('flapsUp');
  parked.tick();
  parked.press('flapsUp');
  parked.run(10);
  const limited = parked.craftState.nacelleAngle;
  const told = parked.events.notify.some((text) => /stay at 60 degrees/.test(text));
  record('on the wheels the nacelles stop at 60 degrees', limited, 60, { unit: 'deg', tolerance: 0.01, decimals: 1, note: told ? 'the pilot is told' : 'no notice' });

  const strike = createRig({ assists: 0 });
  strike.airborne({ altitude: 4.5, lever: 0.5 });
  strike.craftState.autoNacelle = false;
  strike.craftState.nacelleAngle = 0;
  strike.craftState.nacelleTarget = 0;
  let part = '';
  strike.run(0.5, (lab) => {
    if (lab.model.contact.bodyStrike) {
      part = lab.model.contact.bodyStrike.part;
      return true;
    }
    return false;
  });
  record('a proprotor touching the ground is a body strike', /proprotor/.test(part) ? 1 : 0, 1, { compare: /proprotor/.test(part), note: part || 'no strike' });

  const landing = createRig({ assists: 1 });
  landing.airborne({ altitude: 25, lever: 0.5 });
  landing.run(4);
  landing.pilot.throttle = 0.2;
  let struck = false;
  landing.run(40, (lab) => {
    if (lab.model.contact.bodyStrike) struck = true;
  });
  landing.run(10);
  const graded = landing.events.landed.length > 0 ? landing.events.landed[0].grade : 'none';
  const parkedStill = landing.data.onGround && landing.data.groundSpeed < 0.3;
  record('100 % assists landing from a hover: graded, parked', parkedStill && !struck && graded !== 'none' ? 1 : 0, 1, { compare: parkedStill && !struck && graded !== 'none', note: `grade ${graded}, ground speed ${landing.data.groundSpeed.toFixed(2)} m/s` });
}

/** A respawn with the lever at full: the thrust stays at the spawn's until the lever moves. */
function testPickup() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500, lever: 0.5 });
  rig.pilot.throttle = 1;
  rig.run(3);
  const held = Math.abs(rig.position().y - 500) < 15;
  rig.pilot.throttle = 0.9;
  rig.run(3);
  record('respawn with the lever at full: held until the lever moves', held && rig.data.verticalSpeed > 1 ? 1 : 0, 1, { compare: held && rig.data.verticalSpeed > 1, note: `climbing ${rig.data.verticalSpeed.toFixed(1)} m/s once moved` });
}

/** The autopilot converts and cruises; its hover hold stays put. */
function testAutopilot() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 600 });
  Object.assign(rig.autopilot, { enabled: true, heading: 90, altitude: 800, speed: 110, followWaypoint: false });
  rig.run(100);
  const ok = rig.craftState.nacelleAngle <= 1 && Math.abs(rig.data.airspeed - 110) < 12 && Math.abs(rig.position().y - 800) < 60 && Math.abs(((rig.data.heading - 90 + 540) % 360) - 180) < 6;
  record('autopilot: hover to 110 m/s in airplane mode, 800 m, heading 90', ok ? 1 : 0, 1, { compare: ok, note: `${rig.data.airspeed.toFixed(0)} m/s, ${rig.position().y.toFixed(0)} m, heading ${rig.data.heading.toFixed(0)}, nacelles ${rig.craftState.nacelleAngle}` });
  const hold = createRig({ assists: 1 });
  hold.airborne({ altitude: 400 });
  Object.assign(hold.autopilot, { enabled: true, heading: 0, altitude: 400, speed: 0, followWaypoint: false });
  hold.run(30);
  record('autopilot hover hold', hold.data.groundSpeed, 1, { unit: 'm/s', compare: 'max', note: `${hold.position().y.toFixed(1)} m` });
}

function testCatalog() {
  const full = describeAssists(1, 'tiltrotor');
  const half = describeAssists(0.5, 'tiltrotor');
  const none = describeAssists(0, 'tiltrotor');
  const ok = full.includes('auto-hover') && full.includes('attitude command and limits') && half.includes('stability augmentation') && !half.includes('auto-hover') && none.length === 0;
  record('assist catalog 100 / 50 / 0 %', ok ? 1 : 0, 1, { compare: ok, note: `100: ${full.join(', ')} | 50: ${half.join(', ')}` });
}

function testCraftState() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500 });
  rig.run(1);
  const state = rig.craftState;
  const ok = Number.isFinite(state.nacelleAngle) && Number.isFinite(state.nacelleTarget) && typeof state.autoNacelle === 'boolean'
    && state.corridor && Number.isFinite(state.corridor.min) && Number.isFinite(state.corridor.max) && ['ok', 'wingStall', 'overspeed'].includes(state.corridor.state);
  record('craftState carries the h.3 fields', ok ? 1 : 0, 1, { compare: ok, note: JSON.stringify({ nacelleAngle: state.nacelleAngle, nacelleTarget: state.nacelleTarget, autoNacelle: state.autoNacelle, corridor: state.corridor }) });
}

/** Bytes the given tick function allocates per call, sampled with V8's heap profiler (collected objects included). */
async function sampleAllocation(session, tick, ticks) {
  for (let index = 0; index < ticks; index++) tick();
  await session.post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let index = 0; index < ticks; index++) tick();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  let bytes = 0;
  const visit = (node) => {
    bytes += node.selfSize;
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  return bytes / ticks;
}

/**
 * The model step allocates no objects per tick: it reuses every vector, scratch and sample. V8 still
 * boxes doubles passed across calls it does not inline, as in every flight model, so the measure is
 * the bytes per tick against the Phase 1 helicopter model (one rotor) flown in the same process: the
 * tiltrotor (two proprotors, a wing, a tail) stays within twice the helicopter's.
 */
async function testAllocation() {
  const session = new inspector.Session();
  session.connect();
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 600, speed: 60, lever: 0.6 });
  rig.craftState.nacelleTarget = 0;
  const tiltTick = () => {
    rig.model.step(DT, rig.controls, rig.env);
    if (rig.position().y < 200) rig.airborne({ altitude: 600, speed: 60, lever: 0.6 });
  };
  const heliBus = attachTypedEvents(new EventBus(), { validate: true });
  const heliState = helicopter.abilities.craftAbility.initialState();
  const heliWorld = createFlatWorld(0);
  const heli = flightModels.create('helicopter', { profile: helicopter.simProfile, craft: helicopter, world: heliWorld, bus: heliBus, state: null, craftState: heliState });
  const heliControls = createControlState();
  heliControls.collective = 0.5;
  const heliEnv = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: heliWorld.groundHeight, waterLevel: WATER_LEVEL, rho: 1.225, world: heliWorld, craftState: heliState, assists: 0 };
  const heliPose = () => ({ position: new THREE.Vector3(0, 600, 0), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(0, 0, -30), angularVelocity: new THREE.Vector3(), throttle: 0.5, onGround: false, engineOn: true });
  heli.reset(heliPose());
  const heliTick = () => {
    heli.step(DT, heliControls, heliEnv);
    if (heli.state.position.y < 200 || heli.state.position.y > 1500) heli.reset(heliPose());
  };
  const ticks = 20000;
  const tiltBytes = await sampleAllocation(session, tiltTick, ticks);
  const heliBytes = await sampleAllocation(session, heliTick, ticks);
  session.disconnect();
  record('model step: per-tick allocation against the helicopter model', tiltBytes, 2 * heliBytes, { unit: 'B/tick', compare: 'max', decimals: 0, note: `helicopter ${heliBytes.toFixed(0)} B/tick: V8 number boxing across calls; no per-tick objects` });
}

// ============================================================================================
// REPORT
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} tiltrotor checks within target (standard air, 120 Hz)\n`);
  return failed === 0;
}

const started = performance.now();
await testAllocation();
testCorridor();
testHover();
testClimb();
testLevel();
testStall();
testConversion();
testSchedule();
testOverspeed();
testWingStall();
testControls();
testGround();
testPickup();
testAutopilot();
testCatalog();
testCraftState();
log(`ran ${results.length} checks`);
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
