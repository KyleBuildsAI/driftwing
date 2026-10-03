// Preset wind lab: flies the SIM glider and jet with scripted inputs through the wind of the game's own
// wind-affecting presets (src/spawns/presets/, the * presets of the Phase 2 spec), headless in node on
// a real WindField over flat, calm ground, and through the same path in calm air. Each flight logs the
// vertical speed, the load factor (g), the airspeed, the ground speed and the turbulence, and each
// preset must move the craft the way the spec says it does. The wind comes from the presets' real
// data: their windModifier entries and `wind` lists, built by the real WindModifierEngine exactly as
// the SpawnManager builds them (entry params merged with the activation).
//
// Scenarios (add one per wind-affecting preset):
//   jetStream    along the core of the ribbon: a strong tailwind (ground speed far above airspeed),
//                calm loads; across its edge: shear turbulence and load bumps
//   skyWhale     in the slipstream lane behind the whale (its fauna anchor moving ahead at the
//                preset's cruise): a speed and lift lane, the glider climbing
// Every scenario also proves that dispose removes the preset's wind sources.
//
// Usage: node tools/lab/preset-wind.mjs [--verbose]
// Prints one line per check and the flight table, and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import glider from '../../src/craft/glider.js';
import jet from '../../src/craft/jet.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp } from '../../src/core/util.js';
import { createWindField } from '../../src/env/WindField.js';
import { createScratch, createSlotAllocator, createObjectPool, createInstancedPool, createMeshPool } from '../../src/spawns/pools.js';
import { createWindModifierEngine } from '../../src/spawns/engines/windModifierEngine.js';
import { PRESET_BY_ID } from '../../src/spawns/presets/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const DT = 1 / 120;
const FRAME = 1 / 60;
const GROUND = 0;
const WATER_LEVEL = -60;

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(10)} ${name}${detail ? `  (${detail})` : ''}\n`);
}
function log(line) {
  if (VERBOSE) process.stdout.write(`${line}\n`);
}
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================================
// WORLD: flat calm ground, a real WindField and the real WindModifierEngine
// ============================================================================================
function createWorld() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const world = {
    seedHash: 7,
    hash2: () => 0.99,
    groundHeight: () => GROUND,
    heightAt: () => GROUND,
    biomeAt: () => ({ key: 'meadows' }),
    WATER_LEVEL,
  };
  const uniforms = {
    time: TSL.uniform(0),
    windDirection: TSL.uniform(new THREE.Vector2(1, 0)),
    windStrength: TSL.uniform(0),
  };
  const state = { frame: 0, time: { elapsed: 0, sunElevation: -10 }, player: { position: new THREE.Vector3() } };
  const wind = createWindField({ world, uniforms, state, bus });
  const parts = new Map();
  const ctx = {
    THREE, TSL, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null, backend: 'node',
    wind, audio: null,
    terrain: { heightAt: world.heightAt, groundHeight: world.groundHeight, biomeAt: world.biomeAt, waterLevel: WATER_LEVEL },
    time: state.time, sky: null, bus, perf: null, settings: null, state, uniforms, budgets: null, lights: null,
    pools: {
      scratch: createScratch(THREE, 64),
      createSlotAllocator,
      createObjectPool,
      createInstancedPool: (options) => createInstancedPool(THREE, options),
      createMeshPool: (options) => createMeshPool(THREE, options),
    },
    spawns: { getParts: (id) => parts.get(id) ?? [] },
    registerPrewarm() {},
  };
  const modifier = createWindModifierEngine();
  modifier.init(ctx);
  let serial = 0;
  /**
   * The preset's windModifier part, created the way the SpawnManager creates it: the entry's params
   * merged with the activation. siblings are the spawn's other parts (a followed fauna anchor).
   */
  function spawnPreset(preset, { position, heading, duration, siblings = [] }) {
    const entry = preset.engines.find((candidate) => candidate.engine === 'windModifier');
    serial++;
    const spawnId = `lab:${preset.id}:${serial}`;
    const instance = modifier.create(preset, {
      ...(entry.params ?? {}),
      position: new THREE.Vector3(position.x, position.y, position.z),
      heading,
      site: null,
      startTime: state.time.elapsed,
      scale: 1,
      duration,
      seed: 1000 + serial,
    }, seeded(serial));
    instance.id = spawnId;
    instance.presetId = preset.id;
    instance.engine = 'windModifier';
    instance.heavy = preset.heavy;
    if (instance.ended === undefined) instance.ended = false;
    parts.set(spawnId, [...siblings, instance]);
    modifier.setLOD(instance, 'near');
    return instance;
  }
  function frame(dt = FRAME) {
    state.frame++;
    state.time.elapsed += dt;
  }
  return { ctx, wind, state, modifier, spawnPreset, frame };
}

// ============================================================================================
// FLIGHT: the SIM model in the lab's air, flown with scripted inputs
// ============================================================================================
function createFlightRig(craft, lab, assists) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const craftState = craft.abilities.craftAbility.initialState();
  const world = { groundHeight: () => GROUND, heightAt: () => GROUND, WATER_LEVEL };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: world.groundHeight, waterLevel: WATER_LEVEL, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { model, data: model.flightData, pilot, env, calm: false };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    if (rig.calm) {
      env.wind.vel.set(0, 0, 0);
      env.wind.turbulence = 0;
    } else {
      lab.wind.sample(model.state.position, lab.state.time.elapsed, env.wind);
    }
    model.step(DT, controls, env);
  };
  rig.airborne = ({ speed, altitude, heading, x, z, throttle }) => {
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading * DEG, 0, 'YXZ'));
    const velocity = new THREE.Vector3(0, 0, -speed).applyQuaternion(quaternion);
    model.reset({ position: new THREE.Vector3(x, altitude, z), quaternion, velocity, angularVelocity: new THREE.Vector3(), throttle, onGround: false, engineOn: true });
    pilot.throttle = throttle;
  };
  return rig;
}

/**
 * Flies craft on a straight scripted line: the glider at 0 % assists holds wings level on the
 * ailerons, the ball on the rudder and its trimmed pitch attitude on the elevator; the jet at 100 %
 * assists (its fly-by-wire holds 1 g on a centred stick) holds wings level and the ball. onFrame runs
 * before each frame (moving a followed body). Returns the flight log.
 */
function fly(craft, lab, { speed, altitude, heading, start, seconds, throttle, instance = null, onFrame = null }) {
  const flyByWire = craft === jet;
  const rig = createFlightRig(craft, lab, flyByWire ? 1 : 0);
  const bankGain = flyByWire ? 1.2 : 1.6;
  const rateGain = flyByWire ? 0.25 : 0.35;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  // Trim in calm air first (the preset's wind is held off), then restart at the same point.
  let trimPitch = 0;
  rig.calm = true;
  for (let tick = 0; tick < 240; tick++) {
    rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
    rig.pilot.pitch = flyByWire ? 0 : clamp(-0.12 * rig.data.verticalSpeed - 0.25 * rig.data.pitchRate, -1, 1);
    rig.tick();
    trimPitch = rig.data.pitch;
  }
  rig.calm = false;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  let integral = 0;
  const result = {
    minVertical: Infinity, maxVertical: -Infinity, minLoad: Infinity, maxLoad: -Infinity, minAirspeed: Infinity, maxAirspeed: -Infinity,
    groundSpeed: 0, samples: 0, maxTurbulence: 0, altitudeChange: 0, meanAirspeed: 0, lateGroundSpeed: 0, lateAirspeed: 0, drift: 0, maxSideslip: 0,
  };
  let loadSquares = 0;
  let loadSum = 0;
  let airspeedSum = 0;
  let travelled = 0;
  let lateTravelled = 0;
  let lateAirspeedSum = 0;
  let lateSamples = 0;
  const frames = Math.round(seconds / FRAME);
  // The last 40 % of the flight: the steady state once the craft is in the air mass.
  const lateFrom = Math.round(frames * 0.6);
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    lab.frame();
    if (onFrame) onFrame();
    if (instance) lab.modifier.update(instance, FRAME, lab.ctx);
    for (let tick = 0; tick < 2; tick++) {
      if (flyByWire) {
        rig.pilot.pitch = 0;
      } else {
        const error = trimPitch - rig.data.pitch;
        integral = clamp(integral + error * DT * 1.2, -0.6, 0.6);
        rig.pilot.pitch = clamp(2.2 * error + integral - 0.6 * rig.data.pitchRate, -1, 1);
      }
      rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
      rig.pilot.yaw = clamp((flyByWire ? 3 : 4) * rig.data.sideslip, -1, 1);
      rig.tick();
    }
    if (frameIndex < 30) continue;
    const data = rig.data;
    const velocity = rig.model.state.velocity;
    result.minVertical = Math.min(result.minVertical, data.verticalSpeed);
    result.maxVertical = Math.max(result.maxVertical, data.verticalSpeed);
    result.minLoad = Math.min(result.minLoad, data.gLoad);
    result.maxLoad = Math.max(result.maxLoad, data.gLoad);
    result.minAirspeed = Math.min(result.minAirspeed, data.airspeed);
    result.maxAirspeed = Math.max(result.maxAirspeed, data.airspeed);
    result.maxTurbulence = Math.max(result.maxTurbulence, rig.env.wind.turbulence);
    result.maxSideslip = Math.max(result.maxSideslip, Math.abs(data.sideslip) / DEG);
    loadSquares += data.gLoad * data.gLoad;
    loadSum += data.gLoad;
    airspeedSum += data.airspeed;
    const step = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z) * FRAME;
    travelled += step;
    result.samples++;
    if (frameIndex >= lateFrom) {
      lateTravelled += step;
      lateAirspeedSum += data.airspeed;
      lateSamples++;
    }
  }
  const position = rig.model.state.position;
  result.drift = (position.x - start.x) * Math.cos(heading * DEG) + (position.z - start.z) * Math.sin(heading * DEG);
  result.lateGroundSpeed = lateTravelled / (lateSamples * FRAME);
  result.lateAirspeed = lateAirspeedSum / lateSamples;
  result.groundSpeed = travelled / (result.samples * FRAME);
  result.meanAirspeed = airspeedSum / result.samples;
  result.altitudeChange = rig.model.state.position.y - altitude;
  const mean = loadSum / result.samples;
  result.loadDeviation = Math.sqrt(Math.max(0, loadSquares / result.samples - mean * mean));
  return result;
}

const FLIGHT_CRAFT = Object.freeze([
  Object.freeze({ craft: glider, label: 'glider', speed: 30, throttle: 0 }),
  Object.freeze({ craft: jet, label: 'jet', speed: 220, throttle: 0.34 }),
]);
const flightTable = [];

/** Advances the lab's clock and the instance (its sources fade in) without flying. */
function settle(lab, instance, seconds, onFrame = null) {
  const frames = Math.round(seconds / FRAME);
  for (let index = 0; index < frames; index++) {
    lab.frame();
    if (onFrame) onFrame();
    lab.modifier.update(instance, FRAME, lab.ctx);
  }
}

/**
 * One scenario: each craft flies plan(entry) through a fresh spawn of the preset (built by build(lab),
 * which returns { instance, onFrame }) and the same path in calm air; expect(entry, calm, air) judges.
 */
function scenario(presetId, label, build, plan, expect) {
  const preset = PRESET_BY_ID[presetId];
  if (!preset) {
    check('flight', `${presetId}: the preset exists`, false, 'missing from src/spawns/presets');
    return;
  }
  for (const entry of FLIGHT_CRAFT) {
    const path = plan(entry);
    const calm = fly(entry.craft, createWorld(), { ...path, speed: entry.speed, throttle: entry.throttle });
    const lab = createWorld();
    const spawn = build(lab, preset, entry);
    const air = fly(entry.craft, lab, { ...path, speed: entry.speed, throttle: entry.throttle, instance: spawn.instance, onFrame: spawn.onFrame });
    const row = {
      vertical: `${round(calm.minVertical, 1)}..${round(calm.maxVertical, 1)} -> ${round(air.minVertical, 1)}..${round(air.maxVertical, 1)}`,
      load: `${round(calm.minLoad)}..${round(calm.maxLoad)} -> ${round(air.minLoad)}..${round(air.maxLoad)} (sd ${round(calm.loadDeviation, 3)} -> ${round(air.loadDeviation, 3)})`,
      airspeed: `${round(calm.meanAirspeed, 1)} -> ${round(air.meanAirspeed, 1)}`,
      ground: `${round(calm.groundSpeed, 1)} -> ${round(air.groundSpeed, 1)}`,
      climb: `${round(calm.altitudeChange, 0)} -> ${round(air.altitudeChange, 0)}`,
      late: `${round(calm.lateGroundSpeed, 1)}/${round(calm.lateAirspeed, 1)} -> ${round(air.lateGroundSpeed, 1)}/${round(air.lateAirspeed, 1)}`,
      drift: `${round(calm.drift, 0)} -> ${round(air.drift, 0)}`,
      sideslip: `${round(calm.maxSideslip, 1)} -> ${round(air.maxSideslip, 1)}`,
      turbulence: round(air.maxTurbulence),
    };
    flightTable.push({ scenario: `${presetId} ${label}`, craft: entry.label, ...row });
    const verdict = expect(entry, calm, air);
    check('flight', `${entry.label}, ${presetId} ${label}: ${verdict.what}`, verdict.pass, `vs ${row.vertical} m/s; g ${row.load}; airspeed ${row.airspeed}; ground ${row.ground} m/s (late ground/air ${row.late}); height ${row.climb} m; drift ${row.drift} m; sideslip ${row.sideslip} deg; turbulence ${row.turbulence}`);
    const sources = lab.wind.sourceCount;
    lab.modifier.dispose(spawn.instance);
    check('dispose', `${entry.label}, ${presetId} ${label}: dispose removes the preset's wind sources`, sources > 0 && lab.wind.sourceCount === 0 && spawn.instance.windSourceIds.length === 0, `${sources} -> ${lab.wind.sourceCount}`);
  }
}

// ============================================================================================
// SCENARIOS
// ============================================================================================
function jetStreamScenarios() {
  const tube = PRESET_BY_ID.jetStream.wind.find((entry) => entry.type === 'jetStream').params;
  // The ribbon runs east (heading 90) through the origin at its altitude above the flat ground.
  const build = (lab, preset) => {
    const instance = lab.spawnPreset(preset, { position: { x: 0, y: GROUND, z: 0 }, heading: 90, duration: 600 });
    settle(lab, instance, tube.fadeIn + 2);
    return { instance, onFrame: null };
  };
  // Joining along the axis from just upwind of the tube: the taper eases the tailwind in, as a pilot
  // joining the ribbon from behind meets it (an abrupt start inside a 38 m/s core is a shear no
  // glider at 30 m/s survives).
  scenario('jetStream', 'joined from behind, along the core', build, (entry) => ({
    altitude: GROUND + tube.altitude, heading: 90, start: { x: -0.5 * tube.length - 200, z: 0 }, seconds: entry.label === 'jet' ? 40 : 150,
  }), (entry, calm, air) => ({
    // A tailwind is ground speed over airspeed. The glider keeps its airspeed and gains ground speed
    // (it slowly sinks below the axis, where the core is weaker); the jet on a fixed throttle keeps its
    // ground speed and flies slower through the air.
    what: 'a strong tailwind in the core: ground speed well above airspeed, loads within 0.5 g of 1',
    pass: air.lateGroundSpeed - air.lateAirspeed > (entry.label === 'jet' ? 0.85 : 0.7) * tube.speed && air.minLoad > 0.5 && air.maxLoad < 1.5,
  }));
  // Across the tube: in through one edge, out of the other.
  scenario('jetStream', 'across the edge', build, (entry) => ({
    altitude: GROUND + tube.altitude, heading: 0, start: { x: 0, z: entry.label === 'jet' ? 2200 : 700 }, seconds: entry.label === 'jet' ? 20 : 47,
  }), (entry, calm, air) => (entry.label === 'jet'
    ? { what: 'shear turbulence at the edge and a load bump crossing the flow (its fly-by-wire holds the slip)', pass: air.maxTurbulence > 0.2 && air.maxLoad - air.minLoad > calm.maxLoad - calm.minLoad + 0.08 }
    : { what: 'shear turbulence and load bumps crossing the edge, carried downstream', pass: air.maxTurbulence > 0.2 && air.loadDeviation > calm.loadDeviation * 2 && Math.abs(air.drift - calm.drift) > 100 }));
}

function skyWhaleScenarios() {
  const whale = PRESET_BY_ID.skyWhale;
  const fauna = whale.engines.find((entry) => entry.engine === 'fauna').params;
  const lane = whale.wind.find((entry) => entry.type === 'slipstream').params;
  const cruise = fauna.speed;
  const altitude = fauna.altitude.value;
  // The whale swims east at its cruise from x = 0; the craft enters its lane from behind.
  const build = (lab, preset) => {
    const body = { anchor: new THREE.Vector3(0, altitude, 0), engine: 'fauna' };
    const instance = lab.spawnPreset(preset, { position: { x: 0, y: altitude, z: 0 }, heading: 90, duration: 600, siblings: [body] });
    const onFrame = () => {
      body.anchor.x += cruise * FRAME;
    };
    settle(lab, instance, lane.fadeIn + 4, onFrame);
    return { instance, onFrame };
  };
  scenario('skyWhale', 'in the slipstream lane', build, (entry) => {
    // Start just inside the lane's far end behind the whale, where it is after settling.
    const whaleX = cruise * (lane.fadeIn + 4);
    const startX = whaleX - lane.behind - 0.9 * lane.length;
    const closing = entry.speed - cruise;
    return { altitude: altitude + lane.centerHeight, heading: 90, start: { x: startX, z: 0 }, seconds: Math.min(0.85 * lane.length / closing, 60) };
  }, (entry, calm, air) => (entry.label === 'jet'
    ? { what: 'a speed lane: ground speed above airspeed', pass: air.groundSpeed - air.meanAirspeed > calm.groundSpeed - calm.meanAirspeed + 0.5 * lane.boost }
    : { what: 'a speed and lift lane: ground speed up and a climb', pass: air.groundSpeed > calm.groundSpeed + 0.4 * lane.boost && air.altitudeChange > calm.altitudeChange + 60 }));
}

jetStreamScenarios();
skyWhaleScenarios();

process.stdout.write('\nflight log (calm -> through the preset\'s wind)\n');
for (const row of flightTable) {
  process.stdout.write(`  ${row.scenario.padEnd(32)} ${row.craft.padEnd(7)} vs ${row.vertical.padEnd(24)} g ${row.load.padEnd(44)} airspeed ${row.airspeed.padEnd(14)} ground ${row.ground.padEnd(14)} height ${row.climb.padEnd(12)} turb ${row.turbulence}\n`);
}
log(`\n${results.length} checks`);
const failed = results.filter((result) => !result.pass);
process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} preset wind checks\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
