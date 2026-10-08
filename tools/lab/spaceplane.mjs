// Spaceplane flight lab: flies the spaceplane's flight model (SimFixedWing plus the spaceplane extension)
// headless in node with scripted controls through the same control stages the game runs every physics
// tick (the PID autopilot and the assists, here the spaceplane's flight control system), and prints its
// measured performance against the spec (Milestone E item 14) and the contract (h.3, h.4, h.8).
//
// The air follows the game's atmosphere (rho = 1.225 exp(-h / 8500), standard speed of sound) with no
// wind, over flat ground far below. Physics runs at 120 Hz.
//
// Tests:
//   engine         full-power thrust at sea level (standing) and in vacuum (the core alone, short of
//                  1 g), the air augmentation fading with Mach and density, the ignition lag
//   apogee         a full-power climb from the 'climb' placement (45 degrees, 250 m/s, 2 km), pulled up
//                  to 65 degrees and left on the hold: the apogee lands in 100-120 km, the craft crosses
//                  100 km, the ballistic apogee prediction tracks the real one, 0 NaN
//   RCS blend      the blend is 1 in vacuum and 0 in the dense air; at 80 km a raw pitch stick
//                  accelerates the craft on the jets alone; the pedals fire the yaw jets
//   attitude hold  at 90 km (0 % assists, the pilot's switch on): a disturbed attitude returns to the
//                  held one and the rates settle
//   re-entry       from the apogee of the climb, auto re-entry (armed by the assists): the guidance
//                  holds 40 degrees angle of attack, the heating peaks (rho V^3), the load stays inside
//                  the G limit, the glide hands back once subsonic or low, and the craft is flying under
//                  3 km at the end with 0 NaN
//   trim at 40     the elevator the guidance needs at 40 degrees angle of attack in the entry has
//                  margin left (the surfaces can hold the entry attitude on their own)
//   low speed      the clean stall speed at sea level; hands off at cruise (100 %) holds its altitude
//   controller     the FlightController headless: a craft switch from the jet climbs at 45 degrees on
//                  full thrust (situate), hands off for 10 s with no soft crash
//
// Usage: node tools/lab/spaceplane.mjs [--verbose] [--only=name]
// Prints a table (measured vs target) and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import spaceplane from '../../src/craft/spaceplane.js';
import jet from '../../src/craft/jet.js';
import { craftRegistry } from '../../src/craft/index.js';
import { flightModels } from '../../src/flight/models.js';
import { createFlightController } from '../../src/flight/FlightController.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity, speedOfSound, SEA_LEVEL_DENSITY } from '../../src/flight/telemetry.js';
import { rocketThrust, rcsBlendAt } from '../../src/flight/spaceplaneAero.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp, vectorFromHeading } from '../../src/core/util.js';

const DT = 1 / 120;
const KMH = 3.6;
const GRAVITY = 9.81;
const VERBOSE = process.argv.includes('--verbose');
const profile = spaceplane.simProfile;
const space = profile.space;
const weight = (profile.mass.empty + profile.mass.pilot + profile.mass.fuel) * GRAVITY;

function log(...parts) {
  if (VERBOSE) process.stdout.write(`${parts.join(' ')}\n`);
}

// ============================================================================================
// RIG
// ============================================================================================
/** The spaceplane in the lab: model, the pilot's ControlState, the tick copy the stages shape and the env. */
function createRig({ assists = 0, ground = -3000 } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const craftState = { ...spaceplane.abilities.craftAbility.initialState(), ...spaceplane.abilities.craftAbilityAlt.initialState() };
  const world = { groundHeight: () => ground, heightAt: () => ground };
  const model = flightModels.create(profile.model, { profile, craft: spaceplane, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.throttle = 0;
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: ground - 100, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft: spaceplane, craftId: spaceplane.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [] };
  const rig = { model, data: model.flightData, pilot, controls, env, context, craftState, telemetry, time: 0, nan: 0 };

  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    model.step(DT, controls, env);
    const state = model.state;
    if (!Number.isFinite(state.position.x + state.position.y + state.position.z + state.velocity.x + state.velocity.y + state.velocity.z + state.quaternion.w)) rig.nan++;
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
  rig.airborne = ({ speed, altitude, throttle = 0, heading = 0, pitch = 0, path = pitch, bank = 0 }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * DEG, -heading * DEG, -bank * DEG, 'YXZ'));
    const pathQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(path * DEG, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(pathQuaternion);
    model.reset({ position: new THREE.Vector3(0, altitude, 0), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  rig.altitude = () => model.state.position.y;
  rig.handsOff = () => {
    pilot.roll = 0;
    pilot.pitch = 0;
    pilot.yaw = 0;
  };
  return rig;
}

// ============================================================================================
// RESULTS
// ============================================================================================
const results = [];
function record(test, measured, target, { unit = '', tolerance = 0.1, compare = 'within', note = '', decimals = 1 } = {}) {
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
function testEngine() {
  const engine = space.engine;
  const standing = rocketThrust(engine, SEA_LEVEL_DENSITY, 0, 0);
  record('engine: full power standing at sea level, thrust / weight', standing.total / weight, [2.2, 3.2], { compare: 'range', decimals: 2, note: `${(standing.total / 1000).toFixed(0)} kN (core ${(standing.core / 1000).toFixed(0)}, air ${(standing.air / 1000).toFixed(0)})` });
  const vacuum = rocketThrust(engine, airDensity(100000), 1200, 4);
  record('engine: in vacuum the core alone, thrust / weight', vacuum.total / weight, [0.55, 0.7], { compare: 'range', decimals: 3, note: `${(vacuum.total / 1000).toFixed(1)} kN, air ${vacuum.air.toFixed(0)} N` });
  const hypersonic = rocketThrust(engine, airDensity(30000), 1800, 6.1);
  record('engine: the air augmentation is gone past Mach 6', hypersonic.air, 0, { compare: hypersonic.air < 1, note: `${hypersonic.air.toFixed(1)} N at 30 km Mach 6.1` });
  // Ignition lag: thrust from the lever at 0 to 1.
  const rig = createRig();
  rig.airborne({ speed: 250, altitude: 5000, throttle: 0 });
  rig.pilot.throttle = 1;
  let reached = null;
  rig.run(2, (lab) => {
    if (reached === null && lab.craftState.thrustLevel >= 0.9) reached = lab.time;
  });
  record('engine: ignition to 90 % thrust', reached ?? 99, [0.3, 0.9], { compare: 'range', unit: 's', decimals: 2 });
}

/**
 * The full-power climb: the 'climb' placement (2 km, 45 degrees, 250 m/s, full thrust) at 100 %
 * assists, pulled up to `pitch` degrees, then hands off on the hold. Returns the climb's numbers and
 * leaves the rig at the apogee.
 */
function fullPowerClimb(rig, pitch = 65) {
  rig.airborne({ speed: 250, altitude: 2000, throttle: 1, pitch: 45 });
  const result = { apogee: 0, apogeeTime: 0, predicted: [], crossed100At: null, maxMach: 0, maxQ: 0, maxLoad: 0 };
  let peaked = false;
  rig.run(400, (lab) => {
    const data = lab.data;
    const altitude = lab.altitude();
    lab.pilot.throttle = 1;
    lab.pilot.roll = 0;
    lab.pilot.yaw = 0;
    lab.pilot.pitch = data.pitch < pitch * DEG - 0.5 * DEG && altitude < 20000 ? clamp((pitch * DEG - data.pitch) * 3, 0, 0.6) : 0;
    result.maxMach = Math.max(result.maxMach, data.mach);
    result.maxQ = Math.max(result.maxQ, data.dynamicPressure);
    if (altitude < 30000) result.maxLoad = Math.max(result.maxLoad, data.gLoad);
    if (altitude > 100000 && result.crossed100At === null) result.crossed100At = lab.time;
    if (Number.isFinite(lab.craftState.apogee) && Math.round(lab.time * 120) % 1200 === 0 && altitude > 40000) result.predicted.push({ t: lab.time, predicted: lab.craftState.apogee });
    if (altitude > result.apogee) {
      result.apogee = altitude;
      result.apogeeTime = lab.time;
    } else if (data.verticalSpeed < 0 && altitude > 30000) {
      peaked = true;
    }
    if (VERBOSE && Math.round(lab.time * 120) % 2400 === 0) log(`  climb t ${lab.time.toFixed(0)} h ${(altitude / 1000).toFixed(1)} km M ${data.mach.toFixed(2)} q ${data.dynamicPressure.toFixed(0)} pitch ${(data.pitch / DEG).toFixed(0)} path ${(data.flightPath / DEG).toFixed(0)} rcs ${data.rcsBlend.toFixed(2)} thrust ${(lab.craftState.thrust / 1000).toFixed(0)} kN apogee ${lab.craftState.apogee === null ? '-' : (lab.craftState.apogee / 1000).toFixed(1)}`);
    return peaked;
  });
  return result;
}

function testApogee() {
  const rig = createRig({ assists: 1 });
  rig.setAssists(1);
  const climb = fullPowerClimb(rig, 65);
  record('apogee: full-power climb (65 degrees)', climb.apogee / 1000, [100, 120], { compare: 'range', unit: 'km', note: `top at ${climb.apogeeTime.toFixed(0)} s, 100 km at ${climb.crossed100At === null ? 'never' : `${climb.crossed100At.toFixed(0)} s`}, Mach ${climb.maxMach.toFixed(1)}, max q ${(climb.maxQ / 1000).toFixed(1)} kPa, max ${climb.maxLoad.toFixed(1)} g low` });
  const late = climb.predicted.filter((sample) => climb.apogeeTime - sample.t < 60);
  const error = late.length > 0 ? Math.max(...late.map((sample) => Math.abs(sample.predicted - climb.apogee))) : Infinity;
  record('apogee: the prediction in the last minute', error / 1000, 3, { compare: 'max', unit: 'km', decimals: 2, note: `${late.length} samples` });
  record('apogee: 0 NaN', rig.nan, 0, { compare: rig.nan === 0, decimals: 0 });
  for (const pitch of [50, 80]) {
    const other = createRig({ assists: 1 });
    other.setAssists(1);
    const result = fullPowerClimb(other, pitch);
    record(`apogee: full-power climb (${pitch} degrees)`, result.apogee / 1000, [85, 140], { compare: 'range', unit: 'km', note: `top at ${result.apogeeTime.toFixed(0)} s` });
  }
}

function testRcsBlend() {
  record('RCS blend: vacuum (100 km)', rcsBlendAt(space.rcs, 0.5 * airDensity(100000) * 1200 ** 2), 0.99, { compare: 'min', decimals: 3 });
  record('RCS blend: dense air (5 km, 250 m/s)', rcsBlendAt(space.rcs, 0.5 * airDensity(5000) * 250 ** 2), 0.01, { compare: 'max', decimals: 3 });
  const rig = createRig({ assists: 0 });
  rig.airborne({ speed: 1000, altitude: 80000, throttle: 0, pitch: 0 });
  rig.pilot.pitch = 1;
  rig.run(0.5);
  const pitchRate = rig.data.pitchRate;
  const expected = rig.data.rcsPower[0] * 0.5;
  record('RCS: raw pitch stick at 80 km (0.5 s)', pitchRate / DEG, expected / DEG, { unit: 'deg/s', tolerance: 0.25, note: `blend ${rig.data.rcsBlend.toFixed(3)}, jet ${rig.craftState.rcsPitch.toFixed(2)}` });
  rig.pilot.pitch = 0;
  rig.pilot.yaw = 1;
  const yawBefore = rig.data.yawRate;
  rig.run(0.5);
  record('RCS: the pedals fire the yaw jets at 80 km', (rig.data.yawRate - yawBefore) / DEG, 1, { compare: 'min', unit: 'deg/s', note: `jet ${rig.craftState.rcsYaw.toFixed(2)}` });
}

function testAttitudeHold() {
  const rig = createRig({ assists: 0 });
  rig.setAssists(0);
  rig.airborne({ speed: 900, altitude: 90000, throttle: 0, pitch: 20, path: 20 });
  rig.craftState.attitudeHold = true;
  rig.run(2, (lab) => lab.handsOff());
  const held = rig.model.state.quaternion.clone();
  rig.pilot.roll = 0.8;
  rig.pilot.pitch = 0.6;
  rig.run(1.2);
  const disturbed = held.angleTo(rig.model.state.quaternion) / DEG;
  rig.run(12, (lab) => lab.handsOff());
  const rates = Math.max(Math.abs(rig.data.pitchRate), Math.abs(rig.data.rollRate), Math.abs(rig.data.yawRate)) / DEG;
  record('attitude hold at 90 km: settles after a disturbance', rates, 0.5, { compare: 'max', unit: 'deg/s', decimals: 2, note: `disturbed by ${disturbed.toFixed(1)} deg, then hands off 12 s; holding at ${rig.data.pitch / DEG > -90 ? (rig.data.pitch / DEG).toFixed(1) : '-'} deg pitch` });
}

function testReentry() {
  const rig = createRig({ assists: 1 });
  rig.setAssists(1);
  const climb = fullPowerClimb(rig, 65);
  const result = { maxHeating: 0, maxLoad: 0, aoaSamples: [], phases: new Set(), handBack: null, minAltitude: Infinity, maxQ: 0, elevator: [], blackoutAltitudes: [] };
  rig.run(600, (lab) => {
    const data = lab.data;
    const altitude = lab.altitude();
    lab.handsOff();
    lab.pilot.throttle = 0;
    const phase = lab.craftState.reentryPhase;
    // Handed back: the pilot dives for home at 30 degrees, then rounds out near 3 km.
    if (result.handBack !== null) {
      const targetPath = (altitude > 3800 ? -30 : -8) * DEG;
      lab.pilot.pitch = clamp((targetPath - data.flightPath) * 2.5, -0.6, 0.6);
    }
    result.phases.add(phase);
    result.maxHeating = Math.max(result.maxHeating, lab.craftState.heating);
    result.maxLoad = Math.max(result.maxLoad, data.gLoad);
    result.maxQ = Math.max(result.maxQ, data.dynamicPressure);
    if (phase === 'entry' && altitude < 70000) result.aoaSamples.push(data.aoa / DEG);
    if (phase === 'entry' && data.dynamicPressure > 3000) result.elevator.push(data.elevator);
    if (result.handBack === null && result.phases.has('glide') && phase === 'off') result.handBack = { altitude, mach: data.mach };
    result.minAltitude = Math.min(result.minAltitude, altitude);
    if (VERBOSE && Math.round(lab.time * 120) % 1200 === 0) log(`  entry t ${lab.time.toFixed(0)} h ${(altitude / 1000).toFixed(1)} km M ${data.mach.toFixed(2)} q ${data.dynamicPressure.toFixed(0)} aoa ${(data.aoa / DEG).toFixed(1)} bank ${(data.bank / DEG).toFixed(0)} g ${data.gLoad.toFixed(2)} heat ${lab.craftState.heating.toFixed(2)} phase ${phase} elev ${data.elevator.toFixed(2)} rcs ${data.rcsBlend.toFixed(2)}`);
    return altitude < 2800;
  });
  const aoa = result.aoaSamples;
  const meanAoa = aoa.length > 0 ? aoa.reduce((sum, value) => sum + value, 0) / aoa.length : 0;
  const worst = aoa.length > 0 ? Math.max(...aoa.map((value) => Math.abs(value - 40))) : Infinity;
  record('re-entry: the guidance holds 40 degrees AoA (below 70 km)', meanAoa, 40, { unit: 'deg', tolerance: 0.08, note: `worst ${worst.toFixed(1)} deg off over ${aoa.length} ticks; apogee ${(climb.apogee / 1000).toFixed(0)} km` });
  record('re-entry: heating peak (rho V^3)', result.maxHeating, [0.6, 1], { compare: 'range', decimals: 2, note: `phases ${[...result.phases].join(' > ')}` });
  record('re-entry: peak load inside the G limit', result.maxLoad, spaceplane.limits.gLimit, { compare: 'max', unit: 'g', decimals: 2, note: `max q ${(result.maxQ / 1000).toFixed(1)} kPa` });
  record('re-entry: glide hands back', result.handBack ? result.handBack.altitude / 1000 : 0, [3, 25], { compare: 'range', unit: 'km', note: result.handBack ? `Mach ${result.handBack.mach.toFixed(2)}` : 'never' });
  record('re-entry: down to 3 km, flying, 0 NaN', result.minAltitude / 1000, 3, { compare: result.minAltitude < 3000 && rig.nan === 0, unit: 'km', note: `${rig.nan} NaN ticks, ${rig.data.airspeed.toFixed(0)} m/s at the end, ${(rig.time - climb.apogeeTime).toFixed(0)} s from the apogee` });
  const elevator = result.elevator.length > 0 ? Math.max(...result.elevator.map(Math.abs)) : 1;
  record('trim at 40: elevator margin in the dense entry', elevator, 0.95, { compare: 'max', decimals: 2, note: `${result.elevator.length} ticks above 3 kPa` });
}

function testLowSpeed() {
  const rig = createRig({ assists: 0, ground: -3000 });
  rig.airborne({ speed: 150, altitude: 0, throttle: 0 });
  rig.tick();
  record('low speed: clean stall at sea level', rig.data.stallSpeed, profile.targets.stallSpeed, { unit: 'm/s', tolerance: 0.12 });
  const hold = createRig({ assists: 1 });
  hold.setAssists(1);
  hold.airborne({ speed: spaceplane.spawn.cruise, altitude: 3000, throttle: spaceplane.spawn.cruiseThrottle });
  hold.run(30, (lab) => {
    lab.handsOff();
    lab.pilot.throttle = spaceplane.spawn.cruiseThrottle;
  });
  record('low speed: hands off at cruise holds the height (30 s, 100 %)', Math.abs(hold.altitude() - 3000), 150, { compare: 'max', unit: 'm', decimals: 0, note: `${hold.data.airspeed.toFixed(0)} m/s at the end` });
}

// ============================================================================================
// CONTROLLER: the FlightController headless (a craft switch into the spaceplane)
// ============================================================================================
const CONTROLLER_GROUND = 200;
const FRAME = 1 / 60;

function ensureDocumentStandIn() {
  if (typeof globalThis.document !== 'undefined') return;
  const element = { style: {}, setAttribute() {} };
  globalThis.document = { body: { appendChild() {} }, getElementById: () => null, createElement: () => element };
}

function createControllerRig({ craft = 'jet', altitude = 1500 } = {}) {
  ensureDocumentStandIn();
  const groundHeight = () => CONTROLLER_GROUND;
  const world = { groundHeight, heightAt: groundHeight, WATER_LEVEL: 0 };
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const events = { softCrash: [] };
  bus.onTyped('softCrash', (payload) => events.softCrash.push(payload));
  const heading = 30;
  const cruise = craftRegistry.get(craft).spawn.cruise;
  const player = {
    position: new THREE.Vector3(0, altitude, 0), velocity: vectorFromHeading(heading).multiplyScalar(cruise),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading * DEG), forward: vectorFromHeading(heading),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0), speed: cruise, throttle: 0.55, heading, pitch: 0, roll: 0, yawRate: 0,
    verticalSpeed: 0, gForce: 1, altitude, groundHeight: CONTROLLER_GROUND, agl: altitude - CONTROLLER_GROUND, stalled: false,
    autopilot: { enabled: false, heading, altitude, followWaypoint: false }, inCloud: 0,
  };
  const state = {
    frame: 0, paused: false, photoMode: false, seed: 'LAB',
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 14 },
    player, flight: createFlightTelemetry(), waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const settingsValues = { craft, startOnGround: false, assists: { jet: 1, spaceplane: 1 } };
  const controls = createControlState();
  controls.sources.throttle = 'keyboard';
  const presets = [];
  const { uniform } = TSL;
  const ctx = {
    THREE, TSL, scene: new THREE.Scene(), state, controls, bus, world,
    uniforms: { time: uniform(0), sunDirection: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)), skyHorizonColor: uniform(new THREE.Color(1, 1, 1)), skyZenithColor: uniform(new THREE.Color(1, 1, 1)), nightFactor: uniform(0) },
    craftRegistry, flightModels,
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
        out.vel.set(0, 0, 0);
        out.turbulence = 0;
        return out;
      },
      ambientAt: () => ({ speed: 0, fromDegrees: 0 }),
      lastLayers: { gust: new THREE.Vector3() },
    },
    systems: { camera: { snap() {} }, input: { presetThrottle: (value) => presets.push(value) } },
    registerPrewarm() {},
  };
  const flight = createFlightController(ctx);
  ctx.systems.flight = flight;
  const rig = { flight, state, controls, events, presets, telemetry: state.flight, time: 0 };
  rig.frame = () => {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.frameDt = FRAME;
    flight.update(FRAME, FRAME);
    flight.publishTelemetry(FRAME);
    rig.time += FRAME;
  };
  rig.run = (seconds, script) => {
    const frames = Math.round(seconds / FRAME);
    for (let frame = 0; frame < frames; frame++) {
      if (script && script(rig) === true) return true;
      rig.frame();
    }
    return false;
  };
  rig.model = () => flight.getModel();
  return rig;
}

function testCraftSwitch() {
  const rig = createControllerRig({ craft: 'jet' });
  rig.controls.throttle = jet.spawn.cruiseThrottle;
  rig.run(2, (lab) => Object.assign(lab.controls, { pitch: 0, roll: 0, yaw: 0 }));
  rig.flight.setCraft('spaceplane');
  rig.controls.throttle = 1;
  const model = rig.model();
  const start = { kind: model.kind, pitch: model.flightData.pitch / DEG, speed: model.flightData.airspeed, presets: rig.presets.slice() };
  const altitude = rig.state.player.position.y;
  rig.run(10, (lab) => Object.assign(lab.controls, { pitch: 0, roll: 0, yaw: 0 }));
  const climbed = rig.state.player.position.y - altitude;
  record('controller: jet -> spaceplane climbs at 45 degrees', start.pitch, 45, { tolerance: 0.15, unit: 'deg', note: `model ${start.kind}, ${start.speed.toFixed(0)} m/s, throttle preset ${start.presets.join(',') || 'none'}` });
  record('controller: 10 s hands off after the switch', climbed, 1000, { compare: climbed > 1000 && rig.events.softCrash.length === 0, unit: 'm', decimals: 0, note: `climbed, ${rig.events.softCrash.length} soft crashes, ceiling ${rig.flight.getCeiling()} m` });
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
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} spaceplane checks within target (game atmosphere, 120 Hz)\n`);
  return failed === 0;
}

const started = Date.now();
const only = process.argv.find((argument) => argument.startsWith('--only='));
const tests = { testEngine, testApogee, testRcsBlend, testAttitudeHold, testReentry, testLowSpeed, testCraftSwitch };
for (const [name, test] of Object.entries(tests)) {
  if (only && !name.toLowerCase().includes(only.slice(7).toLowerCase())) continue;
  test();
}
const passed = printTable();
process.stdout.write(`(${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
process.exitCode = passed ? 0 : 1;
