// FPV drone flight lab: flies SimQuad headless (node, no renderer) with scripted sticks through the
// same control stages the game runs every physics tick (the quad autopilot and the quad assists),
// and prints the measured numbers against the spec targets.
//
// The air is the sea-level standard atmosphere (rho 1.225 kg/m^3) with no wind or turbulence, over
// flat ground at sea level. Physics runs at the game's fixed 120 Hz.
//
// Tests:
//   thrust       thrust-to-weight on a test stand (tethered, full throttle): about 8:1
//   hover        hover throttle on the stand, and free hover at it (rate mode, hands off)
//   acroThrottle rate mode: a centred throttle stick is not a hover hold (it climbs hard)
//   topSpeed     level flight at full throttle, pitch flown by a scripted altitude loop: about 150 km/h
//   rates        full-stick roll, pitch and yaw rates (670 deg/s setpoint) and the rate curve shape
//                (Betaflight RC rate / super rate / expo at 1/4, 1/2, 3/4 stick; half stick in flight)
//   flips        acro flip and roll: time for 360 degrees and the height they cost
//   angleMode    50 % assists: self-levelling from 60 degrees and from inverted, the 55 degree tilt limit
//   altitudeHold 100 % assists: holds through a full-tilt dash, climbs and descends on the throttle,
//                ignores a lever left off-centre at spawn, and lands gently on a pulled throttle
//   hover        spawn hover at 100 %, and below the hold level (50 % angle, 0 % rate) the throttle
//                pickup ignores a stale lever until it moves
//   modes        the craft ability toggles rate / angle at any level; a new assist level resets it,
//                the hands-off hold of a controller dropout does not
//   ground       light drop on the feet bounces and settles, hard hits exceed the crash limits, a
//                touch-and-go at speed keeps flying, parked with hold it idles and takes off on throttle
//   terrain      idle drops at 3 m/s onto gentle real terrain (the game's world generator, three seeds):
//                uneven feet must not kick the frame into a prop strike
//   turtle       upside down on the ground: the ability flips it back onto its feet
//   propWash     a fast vertical descent into the props' own wake costs thrust and shakes the frame
//   autopilot    heading, altitude and speed hold through angle mode; the hands-off hold hovers
//   settings     the player's settings.fpv rate and expo reshape the rate curve, live on a change
//
// Usage: node tools/lab/fpv.mjs [--verbose]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import fpv from '../../src/craft/fpv.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { groundPose } from '../../src/flight/placement.js';
import { describeAssists } from '../../src/flight/assists.js';
import { betaflightRate, maxRate, stickForRate, climbForThrottle, ratesForFpvSetting } from '../../src/flight/SimQuad.js';
import { DEG, clamp } from '../../src/core/util.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { WORLD_OPTIONS } from '../../src/core/config.js';

const DT = 1 / 120;
const SEA_LEVEL_RHO = 1.225;
const WATER_LEVEL = -60;
const GRAVITY = 9.81;
const KMH = 3.6;
const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
function createFlatWorld(ground = 0) {
  return { groundHeight: () => ground, heightAt: () => ground, WATER_LEVEL };
}

/** The quad in the lab: model, the pilot's ControlState, the tick copy the stages shape, the env. */
function createRig({ assists = 0, world = createFlatWorld(0), settings = null } = {}) {
  const craft = fpv;
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { notify: [], landed: [] };
  bus.on('notify', (payload) => events.notify.push(payload.text));
  bus.onTyped('landed', (payload) => events.landed.push(payload));
  const craftState = craft.abilities.craftAbility.initialState();
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, input: null, craftState, settings });
  const pilot = createControlState();
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: SEA_LEVEL_RHO, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { craft, model, data: model.flightData, pilot, controls, autopilot, env, context, events, craftState, bus, time: 0, tether: null };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    rig.time += DT;
    if (rig.tether) {
      model.centerOfMass.copy(rig.tether);
      model.state.velocity.set(0, 0, 0);
      model.state.angularVelocity.set(0, 0, 0);
      model.state.quaternion.identity();
    }
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
  rig.setHandsOff = (active) => {
    env.handsOff = active;
    context.handsOff = active;
  };
  /** Airborne at `altitude` with a velocity, attitude from pitch / bank (deg), motors at `throttle`. */
  rig.airborne = ({ altitude = 300, velocity = [0, 0, 0], heading = 0, pitch = 0, bank = 0, throttle = craft.spawn.cruiseThrottle } = {}) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity: new THREE.Vector3().fromArray(velocity), angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
    pilot.roll = 0;
    pilot.pitch = 0;
    pilot.yaw = 0;
  };
  /** At rest on the feet (or upside down on the battery with inverted: true). */
  rig.parked = ({ inverted = false } = {}) => {
    const profile = craft.simProfile;
    const pose = groundPose(world, profile.contacts, 0, 0, 0, profile.centerOfMass[2]);
    const quaternion = pose.quaternion.clone();
    let position = pose.position.clone();
    if (inverted) {
      quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
      let height = -Infinity;
      const offset = new THREE.Vector3();
      for (const point of profile.contacts) {
        offset.fromArray(point.position).applyQuaternion(quaternion);
        height = Math.max(height, -offset.y);
      }
      position = new THREE.Vector3(0, height, 0);
    }
    model.reset({ position, quaternion, velocity: new THREE.Vector3(), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: true, engineOn: true });
    pilot.throttle = 0;
    pilot.roll = 0;
    pilot.pitch = 0;
    pilot.yaw = 0;
  };
  /** Runs the craft ability the way the flight controller does in SIM. */
  rig.ability = () => craft.abilities.craftAbility.run({
    craftState,
    mode: 'sim',
    craft: craft.id,
    telemetry: { onGround: model.contact.onGround, quaternion: model.state.quaternion },
    notify: (text) => events.notify.push(text),
  });
  rig.altitude = () => model.centerOfMass.y;
  rig.tilt = () => Math.acos(clamp(new THREE.Vector3(0, 1, 0).applyQuaternion(model.state.quaternion).y, -1, 1)) / DEG;
  return rig;
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function check(test, name, measured, target, pass, unit = '') {
  results.push({ test, name, measured, target, unit, pass: Boolean(pass) });
  log(`  ${pass ? 'ok  ' : 'FAIL'} ${test} / ${name}: ${measured} ${unit} (target ${target})`);
}
function within(value, target, tolerance) {
  return Math.abs(value - target) <= Math.abs(target) * tolerance;
}
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const TARGETS = fpv.simProfile.targets;
const LIMITS = fpv.limits;

// ============================================================================================
// TESTS
// ============================================================================================
function testThrust() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 100, throttle: 1 });
  rig.tether = new THREE.Vector3(0, 100, 0);
  rig.pilot.throttle = 1;
  rig.run(0.5);
  const ratio = rig.data.thrust / (rig.data.mass * GRAVITY);
  check('thrust', 'thrust-to-weight (stand)', round(ratio), `${TARGETS.thrustToWeight} +-5%`, within(ratio, TARGETS.thrustToWeight, 0.05));
  const spoolRig = createRig({ assists: 0 });
  spoolRig.airborne({ altitude: 100, throttle: 0 });
  spoolRig.tether = new THREE.Vector3(0, 100, 0);
  // One tick with the lever where the reset left it (the throttle pickup meets it there), then slam it.
  spoolRig.tick();
  spoolRig.pilot.throttle = 1;
  const slammed = spoolRig.time;
  let spoolTime = NaN;
  spoolRig.run(0.5, (rig) => {
    if (!Number.isFinite(spoolTime) && rig.data.motorSpeed >= 0.9) spoolTime = rig.time - slammed;
  });
  check('thrust', 'spool idle -> 90 % speed', round(spoolTime * 1000, 0), '40-120 ms', spoolTime >= 0.04 && spoolTime <= 0.12, 'ms');
}

function testHover() {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration++) {
    const middle = (low + high) / 2;
    const rig = createRig({ assists: 0 });
    rig.airborne({ altitude: 100, throttle: middle });
    rig.tether = new THREE.Vector3(0, 100, 0);
    rig.run(0.4);
    if (rig.data.thrust > rig.data.mass * GRAVITY) high = middle;
    else low = middle;
  }
  const hoverThrottle = (low + high) / 2;
  check('hover', 'hover throttle (stand)', round(hoverThrottle, 3), `${TARGETS.hoverThrottle} +-0.04`, Math.abs(hoverThrottle - TARGETS.hoverThrottle) <= 0.04);
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 200, throttle: hoverThrottle });
  const start = rig.altitude();
  rig.run(4);
  const drift = rig.altitude() - start;
  check('hover', 'free hover at it, 4 s (acro)', round(drift), '|dh| < 1.5 m', Math.abs(drift) < 1.5, 'm');
  return hoverThrottle;
}

function testAcroThrottle() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 200, throttle: 0.5 });
  rig.run(2);
  check('acroThrottle', 'centred throttle climbs (2 s)', round(rig.data.verticalSpeed, 1), '> 8 m/s up (no hover hold)', rig.data.verticalSpeed > 8, 'm/s');
  check('acroThrottle', 'rate mode active at 0 %', rig.craftState.droneMode, 'rate', rig.craftState.droneMode === 'rate' && rig.craftState.altitudeHold === false);
}

/** Rate mode with a scripted outer loop holding altitude with pitch, wings level, full throttle. */
function testTopSpeed() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 1000, throttle: 1, pitch: -60, velocity: [0, 0, -15] });
  const rates = rig.data.rates;
  let integral = 0;
  const speeds = [];
  let minimum = Infinity;
  let maximum = -Infinity;
  rig.run(30, (current) => {
    const data = current.data;
    const climbWanted = clamp(0.4 * (1000 - current.altitude()), -3, 3);
    const climbError = climbWanted - data.verticalSpeed;
    integral = clamp(integral + climbError * DT, -40, 40);
    const pitchTarget = clamp(-72 + 2.5 * climbError + 1.2 * integral, -88, -20);
    const pitchRate = clamp(5 * (pitchTarget - data.pitch / DEG), -200, 200);
    current.pilot.pitch = stickForRate(pitchRate, rates.pitch);
    current.pilot.roll = stickForRate(clamp(-5 * (data.bank / DEG), -200, 200), rates.roll);
    current.pilot.throttle = 1;
    if (current.time > 26) {
      speeds.push(Math.hypot(current.model.state.velocity.x, current.model.state.velocity.z));
      minimum = Math.min(minimum, current.altitude());
      maximum = Math.max(maximum, current.altitude());
    }
    return false;
  });
  const topSpeed = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
  check('topSpeed', 'level, full throttle', round(topSpeed * KMH, 1), `${round(TARGETS.topSpeed * KMH, 0)} km/h +-10%`, within(topSpeed, TARGETS.topSpeed, 0.1), 'km/h');
  check('topSpeed', 'altitude held while measuring', round(maximum - minimum, 1), '< 6 m band', maximum - minimum < 6, 'm');
  check('topSpeed', 'forward tilt at top speed', round(-rig.data.pitch / DEG, 1), '60-88 deg nose down', -rig.data.pitch / DEG > 60 && -rig.data.pitch / DEG < 88, 'deg');
}

function steadyRate(axis, stick, rig = createRig({ assists: 0 })) {
  rig.airborne({ altitude: 500, throttle: 0.45 });
  rig.pilot[axis] = stick;
  let peak = 0;
  const samples = [];
  rig.run(1.2, (current) => {
    const data = current.data;
    const rate = axis === 'roll' ? data.rollRate : axis === 'pitch' ? data.pitchRate : data.yawRate;
    peak = Math.max(peak, Math.abs(rate));
    if (current.time > 0.8) samples.push(Math.abs(rate));
    return false;
  });
  return { steady: samples.reduce((sum, value) => sum + value, 0) / samples.length / DEG, peak: peak / DEG };
}

/** The Betaflight formula written out independently of the model's implementation. */
function referenceRate(stick, { rcRate, superRate, expo }) {
  const absolute = Math.abs(stick);
  const shaped = stick * absolute ** 3 * expo + stick * (1 - expo);
  return (200 * rcRate * shaped) / (1 - absolute * superRate);
}

function testRates() {
  const rates = fpv.inputProfile.rates;
  const fullStick = maxRate(rates.roll);
  check('rates', 'rate curve at full stick', round(fullStick, 1), `${TARGETS.maxRate} deg/s +-2%`, within(fullStick, TARGETS.maxRate, 0.02), 'deg/s');
  for (const stick of [0.25, 0.5, 0.75]) {
    const model = betaflightRate(stick, rates.roll);
    const reference = referenceRate(stick, rates.roll);
    check('rates', `curve at ${stick * 100} % stick`, round(model, 1), `${round(reference, 1)} (Betaflight formula)`, Math.abs(model - reference) < 0.05, 'deg/s');
  }
  const inverse = stickForRate(betaflightRate(0.6, rates.roll), rates.roll);
  check('rates', 'stick for rate (inverse) at 60 %', round(inverse, 4), '0.6', Math.abs(inverse - 0.6) < 1e-3);
  const roll = steadyRate('roll', 1);
  check('rates', 'roll rate, full stick (in flight)', round(roll.steady, 0), `${TARGETS.maxRate} deg/s +-5%`, within(roll.steady, TARGETS.maxRate, 0.05), 'deg/s');
  const pitch = steadyRate('pitch', 1);
  check('rates', 'pitch rate, full stick (in flight)', round(pitch.steady, 0), `${TARGETS.maxRate} deg/s +-5%`, within(pitch.steady, TARGETS.maxRate, 0.05), 'deg/s');
  const yaw = steadyRate('yaw', 1);
  check('rates', 'yaw rate, full stick (in flight)', round(yaw.steady, 0), `${TARGETS.maxRate} deg/s +-10% (prop torque)`, within(yaw.steady, TARGETS.maxRate, 0.1), 'deg/s');
  const half = steadyRate('roll', 0.5);
  const halfSetpoint = betaflightRate(0.5, rates.roll);
  check('rates', 'roll rate, half stick (in flight)', round(half.steady, 1), `${round(halfSetpoint, 1)} deg/s +-5%`, within(half.steady, halfSetpoint, 0.05), 'deg/s');
  check('rates', 'no overshoot, full roll', round(roll.peak, 0), `< ${round(TARGETS.maxRate * 1.1, 0)} deg/s`, roll.peak < TARGETS.maxRate * 1.1, 'deg/s');
}

/**
 * A full-stick flip on one axis with the throttle cut to 15 %, the stick centred at 360 degrees:
 * the time it took, how quickly the rotation stops (acro holds whatever attitude it stops at), how far
 * it carries on past 360 and the height it cost.
 */
function flip(axis, hoverThrottle) {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 500, throttle: hoverThrottle });
  rig.run(0.5);
  const start = rig.altitude();
  let turned = 0;
  let flipTime = NaN;
  rig.pilot[axis] = 1;
  rig.pilot.throttle = 0.15;
  rig.run(3, (current) => {
    const data = current.data;
    const rate = axis === 'roll' ? data.rollRate : data.pitchRate;
    turned += Math.abs(rate) * DT;
    if (turned >= 2 * Math.PI) {
      flipTime = current.time - 0.5;
      return true;
    }
    return false;
  });
  rig.pilot[axis] = 0;
  rig.pilot.throttle = hoverThrottle + 0.15;
  let lowest = rig.altitude();
  let stopTime = NaN;
  let carried = 0;
  const released = rig.time;
  rig.run(1, (current) => {
    lowest = Math.min(lowest, current.altitude());
    const rate = Math.abs(axis === 'roll' ? current.data.rollRate : current.data.pitchRate);
    if (!Number.isFinite(stopTime)) {
      carried += rate * DT;
      if (rate < 30 * DEG) stopTime = current.time - released;
    }
    return false;
  });
  return { flipTime, heightLost: start - lowest, stopTime, carried: carried / DEG };
}

function testFlips(hoverThrottle) {
  const pitchFlip = flip('pitch', hoverThrottle);
  check('flips', 'pitch flip 360 deg (full stick)', round(pitchFlip.flipTime, 2), '0.5-0.8 s', pitchFlip.flipTime >= 0.5 && pitchFlip.flipTime <= 0.8, 's');
  check('flips', 'pitch flip height lost', round(pitchFlip.heightLost, 1), '< 5 m', pitchFlip.heightLost < 5, 'm');
  check('flips', 'rotation stops, stick centred', round(pitchFlip.stopTime * 1000, 0), '< 120 ms to 30 deg/s', pitchFlip.stopTime < 0.12, 'ms');
  check('flips', 'carries on past 360 deg', round(pitchFlip.carried, 1), '< 30 deg', pitchFlip.carried < 30, 'deg');
  const rollFlip = flip('roll', hoverThrottle);
  check('flips', 'roll 360 deg (full stick)', round(rollFlip.flipTime, 2), '0.5-0.8 s', rollFlip.flipTime >= 0.5 && rollFlip.flipTime <= 0.8, 's');
  check('flips', 'roll height lost', round(rollFlip.heightLost, 1), '< 5 m', rollFlip.heightLost < 5, 'm');
}

function levelTime(bank, pitch) {
  const rig = createRig({ assists: 0.5 });
  rig.airborne({ altitude: 500, bank, pitch, throttle: 0.4 });
  let settled = NaN;
  let overshoot = 0;
  let crossed = false;
  rig.run(3, (current) => {
    const tilt = current.tilt();
    if (!Number.isFinite(settled) && tilt < 3) settled = current.time;
    if (Number.isFinite(settled)) {
      crossed = true;
      overshoot = Math.max(overshoot, tilt);
    }
    return false;
  });
  return { settled, overshoot: crossed ? overshoot : NaN, mode: rig.craftState.droneMode, hold: rig.craftState.altitudeHold };
}

function testAngleMode() {
  const tilted = levelTime(60, -30);
  check('angleMode', '50 %: angle mode, no altitude hold', `${tilted.mode}/${tilted.hold ? 'hold' : 'no hold'}`, 'angle/no hold', tilted.mode === 'angle' && !tilted.hold);
  check('angleMode', 'self-level from 60 deg bank', round(tilted.settled, 2), '< 0.8 s to 3 deg', tilted.settled < 0.8, 's');
  check('angleMode', 'overshoot after levelling', round(tilted.overshoot, 1), '< 5 deg', tilted.overshoot < 5, 'deg');
  const inverted = levelTime(175, 0);
  check('angleMode', 'self-level from inverted', round(inverted.settled, 2), '< 1.3 s to 3 deg', inverted.settled < 1.3, 's');
  const rig = createRig({ assists: 0.5 });
  rig.airborne({ altitude: 500, throttle: 0.5 });
  rig.pilot.pitch = -1;
  rig.run(2);
  const tilt = rig.tilt();
  check('angleMode', 'full stick tilt limit', round(tilt, 1), '55 deg +-2', Math.abs(tilt - 55) <= 2, 'deg');
  rig.pilot.pitch = 0;
  rig.pilot.roll = 0.5;
  rig.run(1.5);
  const bank = rig.data.bank / DEG;
  check('angleMode', 'half stick bank', round(bank, 1), '27.5 deg +-2', Math.abs(bank - 27.5) <= 2, 'deg');
}

function testAltitudeHold() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 300, throttle: 0.32 });
  rig.pilot.throttle = 0.5;
  rig.run(0.2);
  check('altitudeHold', '100 %: angle mode + altitude hold', `${rig.craftState.droneMode}/${rig.craftState.altitudeHold ? 'hold' : 'no hold'}`, 'angle/hold', rig.craftState.droneMode === 'angle' && rig.craftState.altitudeHold);
  const start = rig.altitude();
  rig.run(5);
  check('altitudeHold', 'hover, stick centred 5 s', round(rig.altitude() - start, 2), '|dh| < 0.3 m', Math.abs(rig.altitude() - start) < 0.3, 'm');
  let worst = 0;
  rig.pilot.pitch = -1;
  rig.run(4, (current) => {
    worst = Math.max(worst, Math.abs(current.altitude() - start));
    return false;
  });
  rig.pilot.pitch = 0;
  rig.run(4, (current) => {
    worst = Math.max(worst, Math.abs(current.altitude() - start));
    return false;
  });
  check('altitudeHold', 'full-tilt dash 4 s and stop', round(worst, 2), '|dh| < 2 m', worst < 2, 'm');
  rig.pilot.throttle = 1;
  rig.run(3);
  const climb = rig.data.verticalSpeed;
  const expectedClimb = climbForThrottle(1, rig.data.altitudeHoldTuning);
  check('altitudeHold', 'full throttle climb rate', round(climb, 2), `${expectedClimb} m/s +-10%`, within(climb, expectedClimb, 0.1), 'm/s');
  rig.pilot.throttle = 0;
  rig.run(3);
  const descent = rig.data.verticalSpeed;
  const expectedDescent = climbForThrottle(0, rig.data.altitudeHoldTuning);
  check('altitudeHold', 'zero throttle descent rate', round(descent, 2), `${expectedDescent} m/s +-10%`, within(descent, expectedDescent, 0.1), 'm/s');

  // A lever left high (another craft's cruise setting) does not climb until it moves.
  const latched = createRig({ assists: 1 });
  latched.airborne({ altitude: 300, throttle: 0.32 });
  latched.pilot.throttle = 0.8;
  const latchStart = latched.altitude();
  latched.run(4);
  check('altitudeHold', 'spawn with lever at 80 % holds', round(latched.altitude() - latchStart, 2), '|dh| < 0.3 m', Math.abs(latched.altitude() - latchStart) < 0.3, 'm');
  latched.pilot.throttle = 0.9;
  latched.run(2);
  check('altitudeHold', 'moving the lever then climbs', round(latched.data.verticalSpeed, 2), '> 2 m/s', latched.data.verticalSpeed > 2, 'm/s');

  // Pulled throttle all the way to the ground: a gentle touchdown, then the motors idle.
  const landing = createRig({ assists: 1 });
  landing.airborne({ altitude: 12, throttle: 0.32 });
  landing.pilot.throttle = 0.5;
  landing.run(0.2);
  landing.pilot.throttle = 0;
  let sinkRate = NaN;
  landing.run(15, (current) => {
    const touchdown = current.model.contact.touchdown;
    if (touchdown && !Number.isFinite(sinkRate)) sinkRate = touchdown.sinkRate;
    return false;
  });
  check('altitudeHold', 'auto-land touchdown sink', round(sinkRate, 2), '< 1.3 m/s', sinkRate < 1.3, 'm/s');
  check('altitudeHold', 'motors idle after landing', round(landing.data.motorSpeed, 3), `idle ${fpv.simProfile.motor.idle}`, landing.data.motorSpeed < fpv.simProfile.motor.idle + 0.01 && landing.data.onGround);
}

function testModes() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 300 });
  rig.pilot.throttle = 0.5;
  rig.run(0.2);
  rig.ability();
  rig.run(1);
  check('modes', 'ability at 100 %: rate mode', `${rig.craftState.droneMode}/${rig.craftState.altitudeHold ? 'hold' : 'no hold'}`, 'rate/no hold', rig.craftState.droneMode === 'rate' && !rig.craftState.altitudeHold);
  rig.ability();
  rig.run(0.2);
  check('modes', 'ability again: angle + hold', `${rig.craftState.droneMode}/${rig.craftState.altitudeHold ? 'hold' : 'no hold'}`, 'angle/hold', rig.craftState.droneMode === 'angle' && rig.craftState.altitudeHold);
  const acro = createRig({ assists: 0 });
  acro.airborne({ altitude: 300 });
  acro.run(0.2);
  acro.ability();
  acro.run(0.5);
  check('modes', 'ability at 0 %: angle, no hold', `${acro.craftState.droneMode}/${acro.craftState.altitudeHold ? 'hold' : 'no hold'}`, 'angle/no hold', acro.craftState.droneMode === 'angle' && !acro.craftState.altitudeHold);
  acro.setAssists(0.2);
  acro.run(0.2);
  check('modes', 'new assist level resets the choice', acro.craftState.droneMode, 'rate', acro.craftState.droneMode === 'rate');
  // A controller unplugged and plugged back: the hands-off hold forces 100 % for a while, then the
  // pilot's level returns; the rate mode the pilot picked with the ability survives it.
  const plugged = createRig({ assists: 0.9 });
  plugged.airborne({ altitude: 300 });
  plugged.run(0.2);
  plugged.ability();
  plugged.run(0.2);
  plugged.setAssists(1);
  plugged.setHandsOff(true);
  plugged.run(1);
  const held = `${plugged.craftState.droneMode}/${plugged.craftState.altitudeHold ? 'hold' : 'no hold'}`;
  plugged.setHandsOff(false);
  plugged.setAssists(0.9);
  plugged.run(0.2);
  check('modes', 'choice survives a hands-off hold', `${held} -> ${plugged.craftState.droneMode}`, 'angle/hold -> rate', held === 'angle/hold' && plugged.craftState.droneMode === 'rate' && plugged.craftState.modeOverride === 'rate');
  const tooltip = [0, 0.5, 1].map((level) => describeAssists(level, 'quad').join(' + ') || 'none').join(' | ');
  check('modes', 'assist tooltip 0 | 50 | 100 %', tooltip, 'none | angle mode | angle mode + altitude hold', tooltip === 'none | angle mode | angle mode + altitude hold');
}

/** The flight controller's contact rules (FlightController.contactOutcome) for a crash verdict. */
function crashVerdict(model) {
  const contact = model.contact;
  if (contact.bodyStrike && contact.bodyStrike.speed > LIMITS.bodyStrikeSpeed) return `${contact.bodyStrike.part} strike`;
  if (contact.touchdown && contact.touchdown.sinkRate > LIMITS.crashSinkRate) return 'hard landing';
  if (contact.penetration > 1) return 'terrain';
  return null;
}

function drop({ sinkRate, inverted = false, throttle = 0, seconds = 3 }) {
  const rig = createRig({ assists: 0 });
  const quaternion = inverted ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI) : new THREE.Quaternion();
  rig.model.reset({ position: new THREE.Vector3(0, 0.25, 0), quaternion, velocity: new THREE.Vector3(0, -sinkRate, 0), angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
  rig.pilot.throttle = throttle;
  let verdict = null;
  let touchdown = NaN;
  let touched = false;
  let apex = -Infinity;
  let settledAt = NaN;
  rig.run(seconds, (current) => {
    const model = current.model;
    verdict = verdict ?? crashVerdict(model);
    if (model.contact.touchdown && !Number.isFinite(touchdown)) touchdown = model.contact.touchdown.sinkRate;
    if (model.contact.onGround) touched = true;
    if (touched && !model.contact.onGround) apex = Math.max(apex, model.state.position.y);
    if (touched && model.contact.onGround && model.state.velocity.length() < 0.05 && !Number.isFinite(settledAt)) settledAt = current.time;
    return false;
  });
  return { rig, verdict, touchdown, apex, settledAt, upright: rig.data.upright };
}

function testGround() {
  const light = drop({ sinkRate: 3 });
  check('ground', 'light drop on the feet (3 m/s)', light.verdict ?? 'no crash', 'no crash', light.verdict === null);
  check('ground', 'bounces off the ground', round(light.apex * 100, 1), '> 1 cm hop', light.apex > 0.01, 'cm');
  check('ground', 'settles upright on its feet', round(light.settledAt, 2), '< 2.5 s, upright', light.settledAt < 2.5 && light.upright > 0.95, 's');
  const firm = drop({ sinkRate: 5.5 });
  check('ground', 'firm drop (5.5 m/s) survives', firm.verdict ?? 'no crash', 'no crash', firm.verdict === null);
  const hard = drop({ sinkRate: 9 });
  check('ground', 'hard hit (9 m/s)', hard.verdict ?? 'no crash', 'soft crash', hard.verdict !== null);
  const invertedHit = drop({ sinkRate: 7, inverted: true });
  check('ground', 'inverted hit (7 m/s)', invertedHit.verdict ?? 'no crash', 'soft crash (strike)', invertedHit.verdict !== null && invertedHit.verdict.includes('strike'));
  const graze = drop({ sinkRate: 1.5, inverted: true });
  check('ground', 'light inverted touch (1.5 m/s)', graze.verdict ?? 'no crash', 'no crash', graze.verdict === null);
  // Skimming: a foot brushes the ground at 8 m/s with altitude hold on; the motors keep flying.
  const skim = createRig({ assists: 1 });
  skim.airborne({ altitude: 0.1, velocity: [0, -1.5, -8], throttle: fpv.spawn.cruiseThrottle });
  skim.pilot.throttle = 0.5;
  let brushed = false;
  let lowestMotor = Infinity;
  skim.run(1.5, (current) => {
    if (current.model.contact.onGround) brushed = true;
    if (brushed) lowestMotor = Math.min(lowestMotor, current.data.motorSpeed);
    return false;
  });
  check('ground', 'touch-and-go at 8 m/s (100 %)', `${brushed ? 'brushed' : 'missed'}, ${round(skim.altitude(), 2)} m`, 'brushes, flies on (motors > 0.2)', brushed && lowestMotor > 0.2 && !skim.data.onGround, 'up');
  const parked = createRig({ assists: 1 });
  parked.parked();
  parked.pilot.throttle = 0.5;
  parked.run(3);
  check('ground', 'parked, hold engaged, stick centred', round(parked.altitude(), 3), 'stays on the ground', parked.data.onGround && parked.data.motorSpeed < 0.07);
  parked.pilot.throttle = 0.85;
  parked.run(3);
  check('ground', 'takes off on throttle (100 %)', round(parked.altitude(), 1), '> 5 m after 3 s', parked.altitude() > 5, 'm');
}

/** Flat-ish spots (the browser smoke test's criterion: under 0.3 m of rise over 2 m) on a seeded world. */
function gentleSpots(world, count) {
  const spots = [];
  for (let index = 0; index < count; index++) {
    let best = null;
    for (let radius = 0; radius <= 1500 && !best; radius += 40) {
      for (let angle = 0; angle < 16 && !best; angle++) {
        const x = index * 700 + Math.cos((angle / 16) * Math.PI * 2) * radius;
        const z = Math.sin((angle / 16) * Math.PI * 2) * radius;
        const ground = world.groundHeight(x, z);
        const rise = Math.abs(world.groundHeight(x + 2, z) - ground) + Math.abs(world.groundHeight(x, z + 2) - ground);
        if (ground > 5 && rise < 0.3) best = { x, z, ground };
      }
    }
    if (best) spots.push(best);
  }
  return spots;
}

function testTerrain() {
  let drops = 0;
  const crashes = [];
  let worstTilt = 0;
  for (const seed of ['2KWZZ3', 'A7A7VX', 'CYRYGP']) {
    const world = createWorldGen(seed, WORLD_OPTIONS);
    world.WATER_LEVEL = WATER_LEVEL;
    for (const spot of gentleSpots(world, 8)) {
      const rig = createRig({ assists: 0.5, world });
      rig.model.reset({ position: new THREE.Vector3(spot.x, spot.ground + 0.6, spot.z), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(0, -3, 0), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: false, engineOn: true });
      rig.pilot.throttle = 0;
      drops++;
      let verdict = null;
      rig.run(3, (current) => {
        verdict = verdict ?? crashVerdict(current.model);
        return verdict !== null;
      });
      if (verdict) {
        crashes.push(`${seed}:${verdict}`);
        const w = rig.model.state.angularVelocity;
        log(`    ${seed} (${round(spot.x, 1)}, ${round(spot.z, 1)}): ${verdict} at ${round(rig.model.contact.bodyStrike ? rig.model.contact.bodyStrike.speed : NaN, 2)} m/s, t ${round(rig.time, 3)} s, w ${round(w.x, 1)}/${round(w.y, 1)}/${round(w.z, 1)} rad/s, tilt ${round(rig.tilt(), 1)} deg`);
      }
      else worstTilt = Math.max(worstTilt, rig.tilt());
    }
  }
  check('terrain', `idle 3 m/s drops on real terrain (${drops})`, crashes.length ? crashes.join(', ') : 'no crash', 'no crash', crashes.length === 0);
  check('terrain', 'resting tilt after the drops', round(worstTilt, 1), '< 10 deg (on its feet)', worstTilt < 10, 'deg');
}

function testTurtle() {
  const rig = createRig({ assists: 1 });
  rig.parked({ inverted: true });
  rig.run(1);
  const notice = rig.events.notify.some((text) => text.includes('turtle'));
  check('turtle', 'upside-down notice', notice ? 'shown' : 'missing', 'shown', notice);
  const before = rig.data.upright;
  rig.ability();
  let flipped = NaN;
  rig.run(4, (current) => {
    if (!Number.isFinite(flipped) && current.data.upright > 0.95 && current.model.contact.onGround && !current.craftState.turtle) flipped = current.time - 1;
    return false;
  });
  check('turtle', 'flips back onto its feet', round(flipped, 2), `< 3 s (from up ${round(before, 2)})`, flipped < 3 && rig.data.upright > 0.95, 's');
  check('turtle', 'turtle mode ends by itself', rig.craftState.turtle ? 'active' : 'ended', 'ended', !rig.craftState.turtle);
  const upright = createRig({ assists: 1 });
  upright.parked();
  upright.ability();
  check('turtle', 'ability upright on the ground', upright.craftState.turtle ? 'turtle' : upright.craftState.droneMode, 'mode toggle (rate)', !upright.craftState.turtle && upright.craftState.droneMode === 'rate');
}

function testPropWash() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 400, velocity: [0, -10, 0], throttle: 0.05 });
  let wash = 0;
  let thrustShare = Infinity;
  let shake = 0;
  rig.tick();
  rig.pilot.throttle = 0.6;
  rig.run(1.2, (current) => {
    wash = Math.max(wash, current.data.propWash);
    if (current.data.propWash > 0.3) {
      thrustShare = Math.min(thrustShare, current.data.thrust / (current.data.maxThrust * current.data.motorSpeed * current.data.motorSpeed + 1e-6));
      shake = Math.max(shake, Math.hypot(current.data.rollRate, current.data.pitchRate) / DEG);
    }
    return false;
  });
  check('propWash', 'descending 10 m/s into the wake', round(wash, 2), 'wash > 0.5', wash > 0.5);
  check('propWash', 'thrust lost in the wake', round(1 - thrustShare, 2), '> 10 %', 1 - thrustShare > 0.1);
  check('propWash', 'frame shakes (sticks centred)', round(shake, 1), '> 3 deg/s', shake > 3, 'deg/s');
  const clean = createRig({ assists: 0 });
  clean.airborne({ altitude: 400, velocity: [0, -10, -20], throttle: 0.4 });
  clean.run(0.3);
  check('propWash', 'no wash moving forward at 20 m/s', round(clean.data.propWash, 2), '< 0.1', clean.data.propWash < 0.1);
}

function testAutopilot() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 300, throttle: 0.32 });
  rig.pilot.throttle = 0.2;
  Object.assign(rig.autopilot, { enabled: true, heading: 90, altitude: 340, speed: fpv.spawn.cruise });
  rig.run(30);
  const velocity = rig.model.state.velocity;
  const speed = Math.hypot(velocity.x, velocity.z);
  const headingError = Math.abs(((rig.data.heading - 90 + 540) % 360) - 180);
  check('autopilot', 'heading hold (target 090)', round(rig.data.heading, 1), '090 +-5', headingError < 5, 'deg');
  check('autopilot', 'altitude hold (target 340 m)', round(rig.altitude(), 1), '340 +-5 m', Math.abs(rig.altitude() - 340) < 5, 'm');
  check('autopilot', 'speed hold (cruise)', round(speed, 1), `${fpv.spawn.cruise} m/s +-2`, Math.abs(speed - fpv.spawn.cruise) < 2, 'm/s');
  check('autopilot', 'flies in angle mode + hold', `${rig.craftState.droneMode}/${rig.craftState.altitudeHold ? 'hold' : 'no hold'}`, 'angle/hold', rig.craftState.droneMode === 'angle' && rig.craftState.altitudeHold);
  rig.setHandsOff(true);
  Object.assign(rig.autopilot, { heading: rig.data.heading, altitude: rig.altitude() });
  rig.pilot.roll = 0;
  rig.pilot.pitch = 0;
  rig.run(10);
  const hoverSpeed = rig.model.state.velocity.length();
  check('autopilot', 'hands-off hold stops and hovers', round(hoverSpeed, 2), '< 1 m/s after 10 s', hoverSpeed < 1, 'm/s');
}

function testSpawnHover() {
  const rig = createRig({ assists: 1 });
  rig.airborne({ altitude: 300, throttle: fpv.spawn.cruiseThrottle });
  rig.pilot.throttle = 0.75;
  const start = rig.altitude();
  rig.run(10);
  const position = rig.model.state.position;
  check('hover', 'spawn hover at 100 % (lever 75 %), 10 s', `${round(rig.altitude() - start, 2)} m / ${round(Math.hypot(position.x, position.z), 2)} m`, '|dh| < 0.5, drift < 0.5 m', Math.abs(rig.altitude() - start) < 0.5 && Math.hypot(position.x, position.z) < 0.5);
}

/**
 * Below the altitude-hold level (angle mode at 50 %, rate mode at 0 %) an airborne reset still hovers:
 * a lever left elsewhere by the previous craft waits for the pickup; once the pilot moves it, the
 * throttle follows it.
 */
function testSpawnPickup() {
  for (const [assists, lever] of [[0.5, 0.75], [0.5, 0], [0, 0.75]]) {
    const rig = createRig({ assists });
    rig.airborne({ altitude: 300, throttle: fpv.spawn.cruiseThrottle });
    rig.pilot.throttle = lever;
    const start = rig.altitude();
    rig.run(2);
    const drift = rig.altitude() - start;
    check('hover', `spawn at ${Math.round(assists * 100)} %, lever ${lever}: 2 s`, round(drift, 2), '|dh| < 1 m', Math.abs(drift) < 1, 'm');
    if (lever === 0) continue;
    rig.pilot.throttle = lever + 0.05;
    rig.run(1);
    check('hover', `spawn at ${Math.round(assists * 100)} %: lever moved, followed`, round(rig.data.throttle, 3), `${lever + 0.05} (the lever)`, Math.abs(rig.data.throttle - (lever + 0.05)) < 1e-9);
  }
}

function testSnapshot() {
  const rig = createRig({ assists: 0 });
  rig.airborne({ altitude: 300, throttle: 0.5 });
  rig.pilot.roll = 0.4;
  rig.run(0.5);
  const saved = rig.model.snapshot();
  rig.run(0.5);
  const after = rig.model.state.position.clone();
  rig.model.restore(JSON.parse(JSON.stringify(saved)));
  rig.run(0.5);
  const replayed = rig.model.state.position;
  check('snapshot', 'restore replays the same flight', round(after.distanceTo(replayed), 5), '< 1e-6 m', after.distanceTo(replayed) < 1e-6, 'm');
}

/**
 * A settings store holding only the FPV setup; change() announces on the rig's bus the way the real
 * store does (holder.rig is set once the rig that reads the store exists).
 */
function createFpvSettings(holder, initial) {
  let value = { ...initial };
  return {
    get: (key) => (key === 'fpv' ? { ...value } : undefined),
    change(patch) {
      value = { ...value, ...patch };
      holder.rig.bus.emit('settings:changed', { key: 'fpv', value: { ...value }, settings: { fpv: { ...value } } });
    },
  };
}

function testSettings() {
  const initial = { uptilt: 25, expo: 0.3, rate: 670 };
  const holder = { rig: null };
  const settings = createFpvSettings(holder, initial);
  const rig = createRig({ assists: 0, settings });
  holder.rig = rig;
  const rates = rig.data.rates;
  check('settings', 'default setting: full-stick rate', round(maxRate(rates.roll), 1), '670 deg/s +-0.5', Math.abs(maxRate(rates.roll) - 670) <= 0.5, 'deg/s');
  const defaultHalf = betaflightRate(0.5, fpv.inputProfile.rates.roll);
  check('settings', 'default setting: curve unchanged at 1/2', round(betaflightRate(0.5, rates.roll), 2), `${round(defaultHalf, 2)} +-0.1`, Math.abs(betaflightRate(0.5, rates.roll) - defaultHalf) <= 0.1, 'deg/s');

  settings.change({ rate: 1000, expo: 0.6 });
  check('settings', 'live change: full-stick rate (curve)', round(maxRate(rates.roll), 1), '1000 deg/s +-0.5', Math.abs(maxRate(rates.roll) - 1000) <= 0.5 && Math.abs(maxRate(rates.yaw) - 1000) <= 0.5, 'deg/s');
  const reference = referenceRate(0.5, rates.pitch);
  check('settings', 'live change: expo 0.6 at 1/2 stick', round(betaflightRate(0.5, rates.pitch), 1), `${round(reference, 1)} (Betaflight formula)`, Math.abs(betaflightRate(0.5, rates.pitch) - reference) < 0.05 && rates.pitch.expo === 0.6, 'deg/s');
  const fast = steadyRate('roll', 1, rig);
  check('settings', 'live change: roll rate, full stick', round(fast.steady, 0), '1000 deg/s +-5%', within(fast.steady, 1000, 0.05), 'deg/s');

  settings.change({ rate: 200, expo: 0 });
  check('settings', 'slowest setting: 200 deg/s, linear', `${round(maxRate(rates.roll), 1)} (super ${rates.roll.superRate})`, '200 deg/s, no super rate', Math.abs(maxRate(rates.roll) - 200) <= 0.5 && rates.roll.superRate === 0);
  const linear = steadyRate('roll', 0.5, rig);
  check('settings', 'expo 0: half stick in flight', round(linear.steady, 1), '100 deg/s +-5%', within(linear.steady, 100, 0.05), 'deg/s');
  const below = ratesForFpvSetting({ rate: 150, expo: 0.3 }, fpv.inputProfile.rates.roll);
  check('settings', 'rate below the RC rate lowers it', `rc ${round(below.rcRate, 3)}, ${round(maxRate(below), 1)} deg/s`, 'rc 0.75, 150 deg/s', Math.abs(maxRate(below) - 150) <= 0.5 && below.superRate === 0);

  rig.model.dispose();
  settings.change({ rate: 800 });
  check('settings', 'disposed model stops listening', round(maxRate(rates.roll), 1), '200 deg/s (unchanged)', Math.abs(maxRate(rates.roll) - 200) <= 0.5, 'deg/s');
}

// ============================================================================================
// RUN
// ============================================================================================
testThrust();
const hoverThrottle = testHover();
testSpawnHover();
testSpawnPickup();
testAcroThrottle();
testTopSpeed();
testRates();
testFlips(hoverThrottle);
testAngleMode();
testAltitudeHold();
testModes();
testGround();
testTerrain();
testTurtle();
testPropWash();
testAutopilot();
testSnapshot();
testSettings();

const widths = { test: 13, name: 40, measured: 34, target: 42 };
const pad = (text, width) => String(text).padEnd(width).slice(0, width);
process.stdout.write(`${pad('test', widths.test)} ${pad('check', widths.name)} ${pad('measured', widths.measured)} ${pad('target', widths.target)} result\n`);
process.stdout.write(`${'-'.repeat(widths.test + widths.name + widths.measured + widths.target + 10)}\n`);
for (const result of results) {
  const measured = `${result.measured}${result.unit ? ` ${result.unit}` : ''}`;
  process.stdout.write(`${pad(result.test, widths.test)} ${pad(result.name, widths.name)} ${pad(measured, widths.measured)} ${pad(result.target, widths.target)} ${result.pass ? 'PASS' : 'FAIL'}\n`);
}
const failures = results.filter((result) => !result.pass);
process.stdout.write(`\n${results.length - failures.length}/${results.length} checks passed${failures.length ? `; ${failures.length} FAILED` : ''}\n`);
process.exit(failures.length ? 1 : 0);
