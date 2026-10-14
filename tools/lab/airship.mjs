// Airship flight lab: flies SimAirship headless (node, no renderer) through the airship's own assist
// and autopilot handlers as the game's control stages call them, plus the scenic cruise over a lab
// director, and prints the measured handling against the spec (contract h.8).
//
// The air is the game's exponential atmosphere (rho 1.225 kg/m^3 at sea level, 8500 m scale height)
// over flat ground at sea level, with no wind unless a test sets one. Physics runs at the game's fixed
// 120 Hz.
//
// Tests:
//   statics       the neutral pressure height and the heaviness range from the profile; half-filled
//                 ballonets float neutral (hands off, no way on, 60 s); light ballonets climb at the
//                 static climb rate, heavy ones sink; light from 2 km the airship stops near its
//                 pressure height (the natural ceiling)
//   speeds        the cruise at the cruise throttle, the top speed at full throttle, the huge inertia
//                 (the time to 15 m/s from rest), the engines-off run-down from the cruise
//   vector        full throttle vectored straight up climbs without airspeed; vectored 120 degrees
//                 it brakes; the pods follow the rocker (relative moves, end stops snap) and the
//                 servo rate
//   ballonet      the antenna lever and the flap keys held trim the ballonets; the blowers lag
//   fins          full rudder at the cruise turns at the target rate; the fins' authority at walking
//                 pace is a few percent of the cruise's; the stern thruster still turns the airship
//                 with no way on and fades out as the fins take over
//   wind          engines off in a 10 m/s wind the airship drifts with the air: slow to pick it up
//                 (added mass), all of it in a minute
//   pendulum      released at 10 degrees of pitch and of roll at rest it swings back to level
//   stability     0 % assists hands off at the cruise after a 5 degree pitch kick: no divergence
//   assists       100 % assists hands off at the cruise: altitude and heading held; the catalog
//   autopilot     heading +90 deg, altitude +100 m, speed hold; the crab angle holds a ground track
//                 in a crosswind; the terrain look-ahead climbs over a ridge
//   cruise        the scenic cruise over the lab director's sites: plans a chain of three, visits
//                 all three, chains on; photo mode slows it to the photo pace; the stick ends it
//   landing       a slow, slightly heavy descent onto the gondola wheel: graded, no crash, at rest
//   copilot       scenicCruise, ballonet and vector commands; the status line
//   situate       from a jet at 8 km and 250 m/s: under the pressure height at no more than the
//                 cruise; from a hovering helicopter low down: drifting, clear of the ground
//   allocation    the model's step and the airship's assist and autopilot handlers allocate nothing
//
// Usage: node --expose-gc tools/lab/airship.mjs [--verbose]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import v8 from 'node:v8';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three/webgpu';
import airship, { AIRSHIP_STATICS, SCENIC_CRUISE } from '../../src/craft/airship.js';
import { gatherCruiseSites } from '../../src/craft/airshipCruise.js';
import { flightModels } from '../../src/flight/models.js';
import { airshipAssistHandler, airshipAutopilot, levelThrottle, crabHeading } from '../../src/flight/SimAirship.js';
import { assistWeights, describeAssists } from '../../src/flight/assists.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { createGroundContact } from '../../src/flight/groundContact.js';
import { createLandingMonitor } from '../../src/flight/landing.js';
import { surfaceHeightAt } from '../../src/flight/waterSurface.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, headingFromVector } from '../../src/core/util.js';

const DT = 1 / 120;
const WATER_LEVEL = -60;
const OPTIONS = { verbose: process.argv.includes('--verbose'), allocation: process.argv.includes('--allocation') };
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose' && flag !== '--allocation') throw new Error(`Unknown flag ${flag}`);
}

function log(...parts) {
  if (OPTIONS.verbose) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createWorld(heightAt = () => 0) {
  return { groundHeight: heightAt, heightAt, WATER_LEVEL };
}

/**
 * One airship in the lab: the model, the pilot's ControlState, the tick copy the airship's autopilot
 * and assist handlers shape (in the game's stage order: autopilot, then assists), the environment
 * with the game's density at the craft's height. override(controls, rig) runs after the handlers.
 */
function createRig({ assists = 0, heightAt, wind = null } = {}) {
  const craft = airship;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const world = createWorld(heightAt);
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  pilot.trim = 0;
  pilot.antenna = 0;
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  const env = {
    time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: 1.225, world,
    craftState, assists, handsOff: false, autopilot, telemetry,
  };
  if (wind) env.wind.vel.copy(wind);
  const game = { ringCourse: { active: false }, waypoint: null, photoMode: false };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game };
  const memories = { assists: airshipAssistHandler.createMemory(), autopilot: airshipAutopilot.createMemory() };
  const weights = {};
  const rig = { craft, model, data: model.flightData, pilot, controls, autopilot, env, context, events, telemetry, craftState, world, game, time: 0, override: null, bus };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    airshipAutopilot.apply(controls, context, memories.autopilot);
    assistWeights(context.assists, 'airship', weights);
    airshipAssistHandler.apply(controls, context, weights, memories.assists);
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
  /** Airborne at `altitude` m, heading, airspeed along the nose (riding the wind), the throttle. */
  rig.airborne = ({ altitude = 600, heading = 0, speed = 0, throttle = 0, ballonet = 0.5, vector = 0, pitch = 0, roll = 0 } = {}) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -roll * DEG, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG));
    velocity.add(env.wind.vel);
    craftState.ballonetTarget = ballonet;
    craftState.vectorTarget = vector;
    memories.assists = airshipAssistHandler.createMemory();
    memories.autopilot = airshipAutopilot.createMemory();
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  rig.position = () => model.state.position;
  return rig;
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
  results.push({ test, measured: `${format(measured)}${suffix}`, target: targetText, pass: Boolean(pass), note });
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function wrapSigned(degrees) {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

const targets = airship.simProfile.targets;
const profile = airship.simProfile;

// ============================================================================================
// TESTS
// ============================================================================================
function testStatics() {
  record('neutral pressure height', AIRSHIP_STATICS.pressureHeight, targets.pressureHeight, { unit: 'm', tolerance: 0.05, decimals: 0, note: `helium ${AIRSHIP_STATICS.heliumMass.toFixed(0)} kg, dry ${AIRSHIP_STATICS.dryMass} kg` });
  record('static heaviness range', AIRSHIP_STATICS.heavinessRange, targets.heavinessRange, { unit: 'kg', tolerance: 0.1, decimals: 0 });

  const neutral = createRig();
  neutral.airborne({ altitude: 800 });
  neutral.run(60);
  record('half-filled ballonets: neutral (60 s, no way on)', Math.abs(neutral.position().y - 800), 5, { unit: 'm', compare: 'max', decimals: 1, note: `vs ${neutral.data.verticalSpeed.toFixed(3)} m/s, heaviness ${neutral.data.heaviness.toFixed(1)} kg` });

  const light = createRig();
  light.airborne({ altitude: 500, ballonet: 0 });
  light.run(90);
  record('light ballonets: static climb', light.data.verticalSpeed, targets.staticClimb, { unit: 'm/s', tolerance: 0.3, note: `heaviness ${light.data.heaviness.toFixed(0)} kg` });
  const heavy = createRig();
  heavy.airborne({ altitude: 1500, ballonet: 1 });
  heavy.run(90);
  record('heavy ballonets: static sink', -heavy.data.verticalSpeed, targets.staticClimb, { unit: 'm/s', tolerance: 0.3, note: `heaviness ${heavy.data.heaviness.toFixed(0)} kg` });

  // Light from 2 km: past its pressure height the helium fills the envelope and the lift falls with the
  // density, so it stops where the displaced air weighs as much as the airship (its static ceiling).
  const ceiling = createRig();
  ceiling.airborne({ altitude: 2000, ballonet: 0 });
  const weight = AIRSHIP_STATICS.dryMass + AIRSHIP_STATICS.heliumMass;
  const staticCeiling = -Math.log(weight / profile.envelope.volume / 1.225) * 8500;
  ceiling.run(900);
  record('light: stops at its static ceiling (900 s)', ceiling.position().y - staticCeiling, [-60, 60], { unit: 'm', compare: 'range', decimals: 0, note: `at ${ceiling.position().y.toFixed(0)} m, ceiling ${staticCeiling.toFixed(0)} m (its pressure height ${ceiling.craftState.pressureHeight} m), vs ${ceiling.data.verticalSpeed.toFixed(2)} m/s` });
}

function testSpeeds() {
  const cruise = createRig({ assists: 1 });
  cruise.airborne({ altitude: 600, speed: 10, throttle: airship.spawn.cruiseThrottle });
  cruise.run(240);
  record('cruise at the cruise throttle', cruise.data.forwardAirspeed, targets.cruise, { unit: 'm/s', tolerance: 0.08, note: `throttle ${airship.spawn.cruiseThrottle}, altitude ${cruise.position().y.toFixed(0)} m` });

  const top = createRig({ assists: 1 });
  top.airborne({ altitude: 600, speed: 22, throttle: 1 });
  top.run(240);
  record('top speed at full throttle', top.data.forwardAirspeed, targets.topSpeed, { unit: 'm/s', tolerance: 0.08 });

  const start = createRig({ assists: 1 });
  start.airborne({ altitude: 600, throttle: 1 });
  let reached = NaN;
  start.run(180, (lab) => {
    if (lab.data.forwardAirspeed >= 15) {
      reached = lab.time;
      return true;
    }
    return false;
  });
  record('huge inertia: rest to 15 m/s at full throttle', reached, 15, { unit: 's', compare: 'min', decimals: 1 });

  const rundown = createRig({ assists: 1 });
  rundown.airborne({ altitude: 600, speed: 22, throttle: airship.spawn.cruiseThrottle });
  rundown.run(5);
  rundown.pilot.actions.add('engineToggle');
  let slowed = NaN;
  rundown.run(400, (lab) => {
    if (lab.data.forwardAirspeed < 5) {
      slowed = lab.time - 5;
      return true;
    }
    return false;
  });
  record('engines off at the cruise: coasts under 5 m/s', slowed, targets.stopTime, { unit: 's', tolerance: 0.25, decimals: 0, note: rundown.events.notify.slice(-1)[0] ?? '' });
}

function testVector() {
  const up = createRig({ assists: 1 });
  up.airborne({ altitude: 400, throttle: 1, vector: 90 });
  up.run(60);
  record('full throttle vectored 90 deg: climb with no way on', up.data.verticalSpeed, targets.vectorClimb, { unit: 'm/s', tolerance: 0.3, note: `airspeed ${up.data.airspeed.toFixed(1)} m/s` });

  const brake = createRig({ assists: 1 });
  brake.airborne({ altitude: 600, speed: 20, throttle: 0, vector: 120 });
  brake.pilot.throttle = 1;
  brake.run(30);
  const free = createRig({ assists: 1 });
  free.airborne({ altitude: 600, speed: 20, throttle: 0 });
  free.run(30);
  record('vectored 120 deg: brakes harder than idle (30 s)', free.data.forwardAirspeed - brake.data.forwardAirspeed, 2, { unit: 'm/s', compare: 'min', note: `${brake.data.forwardAirspeed.toFixed(1)} vs ${free.data.forwardAirspeed.toFixed(1)} m/s` });

  // The rocker: relative moves, the servo lag and the end stops.
  const rocker = createRig();
  rocker.airborne({ altitude: 600 });
  rocker.pilot.trim = 0.3;
  rocker.run(0.5);
  const untouched = rocker.craftState.vectorTarget;
  rocker.pilot.trim = 0.55;
  rocker.run(0.5);
  const moved = rocker.craftState.vectorTarget;
  const angleNow = rocker.craftState.vectorAngle;
  rocker.run(3);
  const settled = rocker.craftState.vectorAngle;
  rocker.pilot.trim = 1;
  rocker.run(0.1);
  const topStop = rocker.craftState.vectorTarget;
  rocker.pilot.trim = -1;
  rocker.run(0.1);
  const bottomStop = rocker.craftState.vectorTarget;
  const servoOk = angleNow < moved && Math.abs(settled - moved) < 0.01;
  const relativeOk = untouched === 0 && Math.abs(moved - 0.25 * profile.props.vector.up) < 0.01;
  const stopsOk = topStop === profile.props.vector.up && bottomStop === -profile.props.vector.down;
  record('rocker: relative moves, servo lag, end stops snap', relativeOk && servoOk && stopsOk ? 1 : 0, 1, {
    compare: relativeOk && servoOk && stopsOk,
    note: `a stale lever leaves ${untouched}; +0.25 -> ${moved.toFixed(1)} deg (pods ${angleNow.toFixed(1)} after 0.5 s, ${settled.toFixed(1)} after 3.5 s); stops ${topStop} / ${bottomStop}`,
  });
}

function testBallonet() {
  const rig = createRig();
  rig.airborne({ altitude: 600 });
  rig.pilot.antenna = 0.2;
  rig.run(0.2);
  rig.pilot.antenna = 0.4;
  rig.run(0.2);
  const afterAntenna = rig.craftState.ballonetTarget;
  rig.pilot.held.add('flapsUp');
  rig.run(2);
  rig.pilot.held.delete('flapsUp');
  const afterKeys = rig.craftState.ballonetTarget;
  const lagging = rig.craftState.ballonet;
  rig.run(30);
  const caught = rig.craftState.ballonet;
  const antennaOk = Math.abs(afterAntenna - 0.7) < 0.01;
  const keysOk = Math.abs(afterKeys - (0.7 - 2 * profile.envelope.leverRate)) < 0.02;
  const lagOk = lagging > afterKeys + 0.05 && Math.abs(caught - afterKeys) < 0.005;
  record('ballonet: antenna moves, flap keys held, blowers lag', antennaOk && keysOk && lagOk ? 1 : 0, 1, {
    compare: antennaOk && keysOk && lagOk,
    note: `antenna +0.2 -> ${afterAntenna.toFixed(3)}; 2 s of flaps up -> ${afterKeys.toFixed(3)} (ballonets at ${lagging.toFixed(3)}, ${caught.toFixed(3)} after 30 s)`,
  });
}

function testFins() {
  const turn = createRig();
  turn.airborne({ altitude: 600, speed: 22, throttle: airship.spawn.cruiseThrottle });
  turn.override = (controls) => {
    controls.yaw = 1;
  };
  turn.run(40);
  const rates = [];
  turn.run(10, (lab) => {
    rates.push(lab.data.yawRate / DEG);
  });
  record('full rudder at the cruise: turn rate', average(rates), targets.turnRate, { unit: 'deg/s', tolerance: 0.25, note: `airspeed ${turn.data.forwardAirspeed.toFixed(1)} m/s, roll ${(turn.data.bank / DEG).toFixed(1)} deg outward` });

  // Fin authority with speed: the rudder's fin force at walking pace against the cruise.
  const finForce = (speed) => {
    const rig = createRig();
    rig.airborne({ altitude: 600, speed });
    rig.override = (controls) => {
      controls.yaw = 1;
    };
    rig.run(DT);
    return Math.abs(rig.model.forces.fins.find((fin) => fin.id === 'finTop').force);
  };
  const slow = finForce(3);
  const fast = finForce(22);
  record('fin authority at 3 m/s vs the cruise', (slow / fast) * 100, 3, { unit: '%', compare: 'max', decimals: 1, note: `${slow.toFixed(0)} N vs ${fast.toFixed(0)} N` });

  const hover = createRig();
  hover.airborne({ altitude: 600, throttle: 0.2 });
  hover.override = (controls) => {
    controls.yaw = 1;
  };
  hover.run(30);
  const sternAtRest = hover.data.yawRate / DEG;
  const fade = createRig();
  fade.airborne({ altitude: 600, speed: 22, throttle: airship.spawn.cruiseThrottle });
  fade.override = (controls) => {
    controls.yaw = 1;
  };
  fade.run(1);
  record('stern thruster turns it with no way on (30 s)', sternAtRest, 1.5, { unit: 'deg/s', compare: 'min', note: `faded out at the cruise: ${fade.craftState.sternThrust}` });
  record('stern thruster fades out at the cruise', Math.abs(fade.craftState.sternThrust), 0.001, { compare: 'max', decimals: 3 });
}

function testWind() {
  const rig = createRig({ wind: new THREE.Vector3(10, 0, 0) });
  // At rest over the ground in a 10 m/s wind, engines off.
  rig.airborne({ altitude: 600 });
  rig.model.state.velocity.set(0, 0, 0);
  rig.pilot.actions.add('engineToggle');
  rig.run(5);
  const early = rig.data.groundSpeed;
  rig.run(295);
  const late = rig.data.groundSpeed;
  record('drifts with the air: ground speed after 5 s (10 m/s crosswind)', early, 6, { unit: 'm/s', compare: 'max', note: 'added mass: slow to pick the wind up' });
  record('drifts with the air: ground speed after 300 s', late, [8.5, 10.5], { unit: 'm/s', compare: 'range', note: `track ${headingFromVector(rig.model.state.velocity.x, rig.model.state.velocity.z).toFixed(0)} deg` });
}

function testPendulum() {
  const pitched = createRig();
  pitched.airborne({ altitude: 600, pitch: 10 });
  let peakAfter = 0;
  pitched.run(60, (lab) => {
    if (lab.time > 30) peakAfter = Math.max(peakAfter, Math.abs(lab.data.pitch / DEG));
  });
  record('pendulum: 10 deg pitch released at rest, after 30 s', peakAfter, 2, { unit: 'deg', compare: 'max', decimals: 2 });
  const rolled = createRig();
  rolled.airborne({ altitude: 600, roll: 10 });
  let crossings = 0;
  let side = 1;
  let rollPeak = 0;
  rolled.run(60, (lab) => {
    const roll = lab.data.bank / DEG;
    if (Math.abs(roll) > 0.05 && Math.sign(roll) !== side) {
      crossings++;
      side = Math.sign(roll);
    }
    if (lab.time > 40) rollPeak = Math.max(rollPeak, Math.abs(roll));
  });
  record('pendulum: 10 deg roll released, after 40 s', rollPeak, 2, { unit: 'deg', compare: 'max', decimals: 2, note: `${crossings} level crossings in 60 s (a damped swing)` });
}

function testStability() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 900, speed: 22, throttle: airship.spawn.cruiseThrottle, pitch: 5 });
  let maxPitch = 0;
  let maxRate = 0;
  rig.run(120, (lab) => {
    maxPitch = Math.max(maxPitch, Math.abs(lab.data.pitch / DEG));
    maxRate = Math.max(maxRate, Math.abs(lab.data.yawRate / DEG));
  });
  record('0 % assists hands off after a 5 deg kick: pitch bounded (120 s)', maxPitch, 12, { unit: 'deg', compare: 'max', decimals: 1, note: `max yaw rate ${maxRate.toFixed(2)} deg/s, altitude ${rig.position().y.toFixed(0)} m` });
}

function testAssists() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 700, speed: 22, throttle: airship.spawn.cruiseThrottle, heading: 40 });
  rig.run(20);
  const altitude0 = rig.position().y;
  const heading0 = rig.data.heading;
  let altitudeError = 0;
  let headingError = 0;
  rig.run(120, (lab) => {
    altitudeError = Math.max(altitudeError, Math.abs(lab.position().y - altitude0));
    headingError = Math.max(headingError, Math.abs(wrapSigned(lab.data.heading - heading0)));
  });
  record('100 % hands off at the cruise: altitude held (120 s)', altitudeError, 10, { unit: 'm', compare: 'max', decimals: 1 });
  record('100 % hands off at the cruise: heading held (120 s)', headingError, 2, { unit: 'deg', compare: 'max', decimals: 2 });

  // The stick commands an attitude; the rudder a turn rate.
  rig.pilot.pitch = 0.5;
  rig.run(25);
  const pitch = rig.data.pitch / DEG;
  rig.pilot.pitch = 0;
  rig.run(20);
  rig.pilot.roll = 1;
  rig.run(30);
  const rate = rig.data.yawRate / DEG;
  rig.pilot.roll = 0;
  record('100 %: half stick back commands ~6 deg pitch', pitch, 6, { unit: 'deg', tolerance: 0.35, decimals: 1 });
  record('100 %: full stick right turns at the commanded rate', rate, 2.5, { unit: 'deg/s', tolerance: 0.25, decimals: 2 });

  const full = describeAssists(1, 'airship');
  const half = describeAssists(0.5, 'airship');
  const none = describeAssists(0, 'airship');
  const catalogOk = ['pitch damper', 'yaw damper', 'heading hold', 'altitude hold'].every((name) => full.includes(name)) && half.includes('pitch damper') && !half.includes('altitude hold') && none.length === 0;
  record('assist catalog 100 / 50 / 0 %', catalogOk ? 1 : 0, 1, { compare: catalogOk, note: `100: ${full.join(', ')} | 50: ${half.join(', ')}` });
}

function testAutopilot() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 500, speed: 20, throttle: 0.4 });
  Object.assign(rig.autopilot, { enabled: true, heading: 90, altitude: 600, speed: 18 });
  rig.run(150);
  record('autopilot heading +90 deg (150 s)', Math.abs(wrapSigned(rig.data.heading - 90)), 3, { unit: 'deg', compare: 'max', decimals: 1 });
  record('autopilot altitude +100 m (150 s)', Math.abs(rig.position().y - 600), 12, { unit: 'm', compare: 'max', decimals: 1 });
  record('autopilot speed hold 18 m/s', Math.abs(rig.data.forwardAirspeed - 18), 1.5, { unit: 'm/s', compare: 'max', decimals: 2 });

  // The crab angle: a ground track north through a 7 m/s wind from the west.
  const crab = createRig({ assists: 1, wind: new THREE.Vector3(7, 0, 0) });
  crab.airborne({ altitude: 600, speed: 20, throttle: 0.4 });
  crab.craftState.scenicCruise.active = true;
  crab.craftState.scenicCruise.target.x = 0;
  crab.craftState.scenicCruise.target.z = -200000;
  crab.craftState.scenicCruise.altitude = 600;
  crab.craftState.scenicCruise.speed = 20;
  Object.assign(crab.autopilot, { enabled: true, heading: 0, altitude: 600, speed: 20 });
  crab.run(150);
  const velocity = crab.model.state.velocity;
  const track = headingFromVector(velocity.x, velocity.z);
  const expectedHeading = crabHeading(0, 20, 7, 0);
  record('crab angle holds the ground track in a crosswind', Math.abs(wrapSigned(track)) + Math.abs(crab.position().x) / 200, 3, { unit: 'deg', compare: 'max', decimals: 2, note: `heading ${crab.data.heading.toFixed(1)} (expected ${expectedHeading.toFixed(1)}), drift ${crab.position().x.toFixed(0)} m` });

  // Terrain ahead: a 300 m ridge 2 km north; the look-ahead climbs over it.
  const ridge = (x, z) => 300 * Math.exp(-(((z + 2000) / 400) ** 2));
  const hill = createRig({ assists: 1, heightAt: ridge });
  hill.airborne({ altitude: 250, speed: 20, throttle: 0.4 });
  Object.assign(hill.autopilot, { enabled: true, heading: 0, altitude: 250, speed: 20 });
  let clearance = Infinity;
  hill.run(160, (lab) => {
    const position = lab.position();
    clearance = Math.min(clearance, position.y - 10.3 - ridge(position.x, position.z));
  });
  record('autopilot climbs over a 300 m ridge', clearance, 40, { unit: 'm', compare: 'min', decimals: 0, note: `gondola wheel clearance, passed at ${hill.position().z.toFixed(0)} m` });
}

/** A lab ability api over a rig: what the controller hands the ability and the copilot commands. */
function createAbilityApi(rig, systems) {
  const player = { position: rig.model.state.position, autopilot: rig.autopilot };
  const state = { time: { elapsed: 0 } };
  const api = {
    get craftState() { return rig.craftState; },
    craft: 'airship',
    module: airship,
    telemetry: rig.telemetry,
    player,
    state,
    systems,
    bus: rig.bus,
    world: rig.world,
    waterQuery: null,
    notify(text) {
      rig.events.notify.push(text);
    },
    setCraftState(field, value) {
      rig.craftState[field] = value;
    },
    setAutopilot(options) {
      if (typeof options.enabled === 'boolean') rig.autopilot.enabled = options.enabled;
      if (Number.isFinite(options.heading)) rig.autopilot.heading = options.heading;
      if (Number.isFinite(options.altitude)) rig.autopilot.altitude = options.altitude;
      if (Number.isFinite(options.speed)) rig.autopilot.speed = options.speed;
      return { ...rig.autopilot };
    },
    sync() {
      state.time.elapsed = rig.time;
      rig.telemetry.heading = rig.data.heading;
      rig.telemetry.onGround = rig.data.onGround;
      rig.telemetry.altitude = rig.position().y;
      rig.telemetry.position.copy(rig.position());
    },
  };
  return api;
}

/** The lab director: sites around the origin, answered as getNearby does (distance and bearing). */
function createLabSystems(rig, sites) {
  const journal = { stats: [] };
  rig.bus.onTyped('journalStat', (payload) => journal.stats.push(payload));
  return {
    journal: { list: journal.stats },
    spawns: {
      director: {
        getNearby(radiusKm) {
          const position = rig.position();
          return sites
            .map((site) => ({ id: site.id, name: site.name, category: 'scenic', state: 'site', distance: Math.round(Math.hypot(site.x - position.x, site.z - position.z)), bearing: Math.round(headingFromVector(site.x - position.x, site.z - position.z)) % 360, etaSeconds: null }))
            .filter((entry) => entry.distance <= radiusKm * 1000)
            .sort((first, second) => first.distance - second.distance);
        },
      },
    },
    landmarks: null,
  };
}

function testCruise() {
  const sites = [
    { id: 'siteA', name: 'Crater Lake', x: 1400, z: -2200 },
    { id: 'siteB', name: 'Sea Stack', x: 3400, z: -3600 },
    { id: 'siteC', name: 'Monolith', x: 2600, z: -6000 },
    { id: 'siteD', name: 'Lighthouse', x: -900, z: -7200 },
    { id: 'siteE', name: 'Old Tower', x: -2600, z: -4600 },
  ];
  const rig = createRig({ assists: 1, wind: new THREE.Vector3(3, 0, 1) });
  rig.airborne({ altitude: 300, speed: 18, throttle: 0.4 });
  const systems = createLabSystems(rig, sites);
  const api = createAbilityApi(rig, systems);
  api.sync();
  const reply = airship.abilities.craftAbility.run(api) && rig.events.notify[rig.events.notify.length - 1];
  const cruise = rig.craftState.scenicCruise;
  const planned = cruise.waypoints.map((waypoint) => waypoint.name).join(', ');
  record('scenic cruise plans a chain of three', cruise.waypoints.length, 3, { compare: cruise.active && cruise.waypoints.length === 3 && rig.autopilot.enabled, note: `${planned}; altitude ${cruise.altitude} m; "${reply}"` });
  let closest = Infinity;
  let visitedAt = NaN;
  let photoSpeed = NaN;
  rig.run(900, (lab) => {
    if (Math.round(lab.time * 120) % 12 === 0) {
      api.sync();
      airship.abilities.craftAbility.update(api, 0.1);
    }
    const waypoint = cruise.waypoints[cruise.index];
    if (waypoint) closest = Math.min(closest, Math.hypot(lab.position().x - waypoint.x, lab.position().z - waypoint.z));
    if (cruise.visited >= 3 && !Number.isFinite(visitedAt)) {
      visitedAt = lab.time;
      lab.game.photoMode = true;
    }
    if (Number.isFinite(visitedAt) && lab.time > visitedAt + 60) {
      photoSpeed = lab.data.forwardAirspeed;
      return true;
    }
    return false;
  });
  const stats = systems.journal.list.filter((stat) => stat.key === 'airshipCruiseSites').length;
  record('scenic cruise visits 3 sites', cruise.visited, 3, { compare: cruise.visited >= 3, note: `after ${visitedAt.toFixed(0)} s, ${stats} journal stats, legs planned ${cruise.legs}, chained on: ${cruise.active}` });
  record('photo mode slows the cruise to the photo pace', photoSpeed, SCENIC_CRUISE.SPEED * 0.65, { unit: 'm/s', tolerance: 0.15, note: rig.events.notify.slice(-2).join(' | ') });
  // The stick takes over: the autopilot drops, the cruise ends with it.
  rig.autopilot.enabled = false;
  api.sync();
  airship.abilities.craftAbility.update(api, 0.1);
  record('the autopilot off ends the cruise', cruise.active ? 1 : 0, 0, { compare: !cruise.active, note: rig.events.notify[rig.events.notify.length - 1] });
}

/** Which places the cruise tours: live spawns and sites, landmarks; not dormant candidates or sky-wide events. */
function testCruiseSites() {
  const entry = (id, state, category, distance, bearing) => ({ id, name: id, state, category, distance, bearing, etaSeconds: null });
  const systems = {
    spawns: {
      director: {
        getNearby: () => [
          entry('liveHerd', 'active', 'wildlife', 1500, 90),
          entry('waterfall', 'site', 'geo', 3000, 0),
          entry('maybeGeese', 'dormant', 'wildlife', 1200, 180),
          entry('aurora', 'active', 'celestial', 800, 45),
          entry('storm', 'active', 'weather', 2000, 270),
        ],
      },
    },
    landmarks: { getNearby: () => [{ id: 'fair', type: 'balloons', name: 'Balloon Fair', x: 1600, z: 100 }, { id: 'arch', type: 'arch', name: 'Old Arch', x: -2500, z: 900 }] },
  };
  const sites = gatherCruiseSites(systems, 0, 0, 9, new Set(['arch']));
  const ids = sites.map((site) => site.id).join(',');
  const herd = sites.find((site) => site.id === 'liveHerd');
  const ok = ids === 'liveHerd,waterfall' && herd && herd.live && herd.clearance === SCENIC_CRUISE.CLEARANCE_BALLOONS;
  record('cruise sites: live spawns and sites, landmarks merged; no dormant or sky-wide events', ok ? 1 : 0, 1, { compare: ok, note: `${ids}; the herd beside the balloon fair keeps the fair's clearance (${herd ? herd.clearance : '-'} m); a skipped id stays out` });
}

function testLanding() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 40, ballonet: 0.62 });
  rig.run(120);
  const landing = rig.events.landed[0];
  record('slightly heavy, no way on: lands on the gondola wheel', landing ? landing.sinkRate : NaN, airship.limits.crashSinkRate, { unit: 'm/s', compare: 'max', note: landing ? `${landing.grade}, ${rig.model.contact.contacts} contacts, at rest ${rig.data.groundSpeed.toFixed(2)} m/s` : 'no landing' });
  record('on the ground: no body strike, no penetration', rig.model.contact.penetration, 0.5, { unit: 'm', compare: 'max', note: rig.model.contact.bodyStrike ? `strike ${rig.model.contact.bodyStrike.part}` : 'no strike' });
}

function testCopilot() {
  const rig = createRig();
  rig.airborne({ altitude: 600 });
  const systems = createLabSystems(rig, [{ id: 'siteA', name: 'Crater Lake', x: 1200, z: -2500 }, { id: 'siteB', name: 'Sea Stack', x: 2500, z: -4500 }]);
  const api = createAbilityApi(rig, systems);
  api.sync();
  const command = (id, value) => airship.copilot.commands.find((entry) => entry.id === id).run(api, value);
  const ballonet = command('ballonet', 60);
  const ballonetOk = rig.craftState.ballonetTarget === 0.6;
  const lighter = command('ballonet', 'lighter');
  const lighterOk = Math.abs(rig.craftState.ballonetTarget - 0.35) < 1e-9;
  const vector = command('vector', 90);
  const vectorOk = rig.craftState.vectorTarget === 90;
  const down = command('vector', 'down');
  const downOk = rig.craftState.vectorTarget === -profile.props.vector.down;
  const start = command('scenicCruise', 'on');
  const startedOk = rig.craftState.scenicCruise.active && rig.autopilot.enabled;
  const stop = command('scenicCruise', 'off');
  const stoppedOk = !rig.craftState.scenicCruise.active && !rig.autopilot.enabled;
  const phrasesOk = airship.copilot.commands.every((entry) => entry.phrases.every((phrase) => new RegExp(phrase, 'i') instanceof RegExp))
    && new RegExp(airship.copilot.commands[0].phrases[0], 'i').test('scenic cruise')
    && /60/.test('ballonets to 60 percent'.match(new RegExp(airship.copilot.commands[1].phrases[0], 'i'))[1]);
  rig.run(1);
  const status = airship.copilot.status(rig.craftState, rig.telemetry);
  const ok = ballonetOk && lighterOk && vectorOk && downOk && startedOk && stoppedOk && phrasesOk && /pressure height/.test(status);
  record('copilot: scenic cruise, ballonet, vector, status', ok ? 1 : 0, 1, { compare: ok, note: `"${ballonet}" "${lighter}" "${vector}" "${down}" "${start}" "${stop}" | ${status}` });
}

function testSituate() {
  const api = { ceiling: airship.limits.ceiling };
  const fromJet = airship.situate({
    position: new THREE.Vector3(0, 8000, 0), heading: 30, trackHeading: 30, groundSpeed: 250, velocity: new THREE.Vector3(), airspeed: 250, agl: 7800,
    surfaceHeight: 200, overWater: false, waterBody: null, waterHeight: null, wasOnGround: false, wasOnWater: false, previousCraft: 'jet', wind: { vel: new THREE.Vector3(), turbulence: 0 }, time: 0, dayTime: 0.4,
  }, api);
  const jetOk = fromJet.mode === 'air' && fromJet.position.y <= AIRSHIP_STATICS.pressureHeight - 80 && fromJet.speed <= targets.cruise && fromJet.craftState.ballonetTarget === 0.5;
  record('situate from a jet at 8 km: under the pressure height, cruise speed', fromJet.position.y, AIRSHIP_STATICS.pressureHeight - 80, { unit: 'm', compare: jetOk, decimals: 0, note: `${fromJet.mode} at ${fromJet.speed} m/s, throttle ${fromJet.throttle}` });
  const fromHeli = airship.situate({
    position: new THREE.Vector3(0, 230, 0), heading: 120, trackHeading: 120, groundSpeed: 0, velocity: new THREE.Vector3(), airspeed: 0.5, agl: 30,
    surfaceHeight: 200, overWater: false, waterBody: null, waterHeight: null, wasOnGround: false, wasOnWater: false, previousCraft: 'helicopter', wind: { vel: new THREE.Vector3(), turbulence: 0 }, time: 0, dayTime: 0.4,
  }, api);
  const heliOk = fromHeli.mode === 'drift' && fromHeli.position.y >= 290 && fromHeli.heading === 120;
  record('situate from a low hover: drifting, clear of the ground', fromHeli.position.y, 290, { unit: 'm', compare: heliOk, decimals: 0, note: fromHeli.mode });

  // The placement flies: drift at neutral trim keeps its height.
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: fromHeli.position.y - 200, ballonet: fromHeli.craftState.ballonetTarget });
  rig.run(30);
  record('a drift placement floats (30 s)', Math.abs(rig.position().y - (fromHeli.position.y - 200)), 3, { unit: 'm', compare: 'max', decimals: 2 });
}

/**
 * Young-generation bytes `fn` allocates over `count` calls, after a warm-up (TurboFan has optimised
 * it): the least of three windows, so a background compile landing in one window does not count.
 */
function youngBytes(fn, count) {
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  for (let index = 0; index < 60000; index++) fn();
  let least = Infinity;
  for (let window = 0; window < 3; window++) {
    if (typeof globalThis.gc === 'function') globalThis.gc();
    const probeA = youngUsed();
    const probeB = youngUsed();
    const before = youngUsed();
    for (let index = 0; index < count; index++) fn();
    least = Math.min(least, Math.max(0, youngUsed() - before - (probeB - probeA)));
  }
  return least;
}

/**
 * The model's step against a baseline of the shared code it calls every tick with the same inputs
 * (the ground contact, the surface height through env.groundHeight, the landing monitor: a double
 * passed to them is boxed); the airship's assist and autopilot handlers on their own (the autopilot's
 * terrain look-ahead asks the world for 14 heights every 0.5 s).
 */
function testAllocation() {
  const ticks = 6000;
  const rig = createRig({ assists: 1, wind: new THREE.Vector3(4, 0, 2) });
  rig.env.wind.turbulence = 0.3;
  rig.airborne({ altitude: 600, speed: 20, throttle: 0.5 });
  Object.assign(rig.autopilot, { enabled: true, heading: 70, altitude: 650, speed: 20 });
  rig.craftState.scenicCruise.active = true;
  rig.craftState.scenicCruise.target.x = 4000;
  rig.craftState.scenicCruise.target.z = -3000;
  rig.craftState.scenicCruise.altitude = 650;
  rig.controls.throttle = 0.5;
  const step = youngBytes(() => rig.model.step(DT, rig.controls, rig.env), ticks);
  const contact = createGroundContact(profile.contacts, { centerOfMass: new THREE.Vector3().fromArray(profile.centerOfMass), floats: false, mass: AIRSHIP_STATICS.inertialMass });
  const landing = createLandingMonitor({ bus: rig.bus, craftId: 'airship', limits: airship.limits });
  const body = { position: new THREE.Vector3(10.5, 600.5, 3.5), velocity: new THREE.Vector3(1.5, 0.5, -20.5), quaternion: new THREE.Quaternion(), angularVelocity: new THREE.Vector3() };
  const inputs = { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true };
  const force = new THREE.Vector3();
  const moment = new THREE.Vector3();
  const sample = { dt: DT, agl: 600.5, position: body.position };
  contact.reset(false);
  landing.reset(false);
  const shared = youngBytes(() => {
    body.position.x += 0.01;
    contact.evaluate(body, inputs, rig.env, DT, force, moment);
    sample.agl = body.position.y - surfaceHeightAt(rig.env, body.position.x, body.position.z);
    landing.observe(contact.report, sample);
  }, ticks);
  const weights = assistWeights(1, 'airship', {});
  const assistMemory = airshipAssistHandler.createMemory();
  rig.autopilot.enabled = false;
  const assists = youngBytes(() => airshipAssistHandler.apply(rig.controls, rig.context, weights, assistMemory), ticks);
  rig.autopilot.enabled = true;
  const autopilotMemory = airshipAutopilot.createMemory();
  const autopilot = youngBytes(() => airshipAutopilot.apply(rig.controls, rig.context, autopilotMemory), ticks);
  return { ticks, step, shared, assists, autopilot, gc: typeof globalThis.gc === 'function' };
}

/**
 * The allocation check runs in a fresh node process (this file with --allocation): after the other
 * tests have flown many rigs, the inline caches are polymorphic and the measurement would reflect
 * the lab, not the game's single airship.
 */
function recordAllocation() {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--allocation'], { encoding: 'utf8' });
  let measured = null;
  try {
    measured = JSON.parse(child.stdout.trim().split('\n').pop());
  } catch (error) {
    record('allocation check ran', 0, 1, { compare: false, note: `the child process failed: ${error.message} ${child.stderr.slice(0, 200)}` });
    return;
  }
  const { ticks, step, shared, assists, autopilot } = measured;
  record(`step beyond the shared calls (${ticks} ticks)`, Math.max(0, step - shared) / ticks, 20, { unit: 'B/tick', compare: 'max', decimals: 1, note: `step ${step} B, shared contact / surface / landing ${shared} B (one boxed double is 16 B)` });
  record(`assist handler allocates nothing (${ticks} ticks)`, assists, 1024, { unit: 'B', compare: 'max', decimals: 0 });
  record(`autopilot handler: only the look-ahead's height queries (${ticks} ticks)`, autopilot / ticks, 40, { unit: 'B/tick', compare: 'max', decimals: 1, note: `${autopilot} B: 28 surface queries every 0.5 s, their arguments boxed` });
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} airship checks within target (exponential atmosphere, 120 Hz)\n`);
  return failed === 0;
}

if (OPTIONS.allocation) {
  process.stdout.write(`${JSON.stringify(testAllocation())}\n`);
  process.exit(0);
}
const started = performance.now();
testStatics();
testSpeeds();
testVector();
testBallonet();
testFins();
testWind();
testPendulum();
testStability();
testAssists();
testAutopilot();
testCruise();
testCruiseSites();
testLanding();
testCopilot();
testSituate();
recordAllocation();
log('level throttle at the cruise', levelThrottle(profile, targets.cruise).toFixed(3));
const passed = printTable();
process.stdout.write(`(${((performance.now() - started) / 1000).toFixed(1)} s)\n`);
process.exit(passed ? 0 : 1);
