// Preset flight lab: flies the SIM glider and jet with scripted inputs through the REAL wind-affecting
// presets of src/spawns/presets (the * presets of Milestone E), headless in node, and logs what the
// craft feels: vertical speed, load factor (g), airspeed, ground speed, drift and the turbulence
// reading, against the same path flown in the same world without the spawn.
//
// The world is the real world generator (real terrain, real site placement, the real WindField with
// its thermals); the spawns go through the real SpawnManager with the real engines, exactly as the
// game builds them (a site preset at its real placed site, an event at a real candidate-like point).
// The craft run the game's own SIM flight models through the same control stages as the game:
//   the glider at 0 % assists holds wings level on the ailerons (or a bank angle when circling), the
//   ball centred on the rudder and its trim pitch attitude on the elevator;
//   the jet at 100 % assists (its fly-by-wire holds 1 g on a centred stick) holds wings level and the
//   ball.
//
// Scenarios (each one names what the craft must feel):
//   maelstrom      the glider across the eye at 400 m: tossed up over the eye, its airspeed swung by
//                  the swirl, rough air; 700 m abeam at 300 m: the swirl and the inflow still swing
//                  and bump it and draw it toward the eye; the jet across the eye: load bumps and rough
//                  air, no tumble
//   wind farm      both craft across the wakes downwind of the turbines at hub height: the glider
//                  feels bumps (load factor spread) and rough air; the jet, through in under a second,
//                  a brief jolt at most and never out of control
//   thermal hawks  the glider circling at 45 degrees of bank where the hawks circle (their group
//                  centre and height), at midday: it climbs with the hawks, against the same circle at
//                  night when the thermals are off; the jet straight through the column: a load bump
//
// Usage: node tools/lab/preset-flight.mjs [--verbose]
// Prints one line per check and the flight log, and exits non-zero if any check fails.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CONFIG, WORLD_OPTIONS } from '../../src/core/config.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { DEG, clamp } from '../../src/core/util.js';
import { createWindField } from '../../src/env/WindField.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createWaterEffects } from '../../src/render/waterEffects.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { createVortexEngine } from '../../src/spawns/engines/vortexEngine.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { createWaterEffectEngine } from '../../src/spawns/engines/waterEffectEngine.js';
import { PRESET_BY_ID } from '../../src/spawns/presets/index.js';
import glider from '../../src/craft/glider.js';
import jet from '../../src/craft/jet.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const DT = 1 / 120;
const FRAME = 1 / 60;
const SEEDS = Object.freeze(['HARNESS-1', 'DRIFTWING', 'P2-TERRAIN', 'INTEG-A', 'INTEG-B', 'PRESETS-2']);
const SEARCH_RADIUS = 60000;

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(13)} ${name}${detail ? `  (${detail})` : ''}\n`);
}
function log(line) {
  if (VERBOSE) process.stdout.write(`${line}\n`);
}
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};

// ============================================================================================
// WORLD, WIND AND SPAWNS
// ============================================================================================
/** A real world with the WindField, the water effects layer and a SpawnManager running the presets. */
function createLab(seed, { sunElevation = 50 } = {}) {
  const world = createWorldGen(seed, WORLD_OPTIONS);
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 9000);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 30000);
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    skyZenithColor: uniform(new THREE.Color(0x4f6fa8)),
    skyHorizonColor: uniform(new THREE.Color(0xf2c48e)),
    nightFactor: uniform(sunElevation < 0 ? 1 : 0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1),
  };
  const state = {
    seed,
    frame: 0,
    time: { elapsed: 0, sunElevation, dayTime: 0.4, nightFactor: sunElevation < 0 ? 1 : 0, goldenFactor: 0 },
    player: { position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(), heading: 0, speed: 0 },
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const water = createWaterEffects({ THREE, TSL, scene, camera, state, uniforms, world, systems: {}, registerPrewarm() {} });
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory: { geometries: 0, textures: 0 } } }, backend: 'WebGPU', wind, audio: null, world, state,
    sky: null, bus, perf: null, settings: null, uniforms, registry, presets: [], seed, water, surfaces: createGroundSurfaces(),
  });
  for (const createEngine of [createVortexEngine, createFaunaEngine, createStructureEngine, createWaterEffectEngine]) manager.register(createEngine());
  for (const id of ['maelstrom', 'windFarm', 'thermalHawks']) manager.addPreset(PRESET_BY_ID[id]);
  manager.init();
  const ground = (x, z) => Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  /** Advances the world one frame with the camera (LOD, view) at the craft. */
  function frame(position, velocity) {
    state.frame++;
    state.time.elapsed += FRAME;
    state.player.position.copy(position);
    state.player.velocity.copy(velocity);
    camera.position.copy(position);
    camera.updateMatrixWorld();
    manager.update(FRAME, FRAME);
  }
  /** The nearest placed site of presetId to the origin, or null. */
  function nearestSite(presetId) {
    return world.sitesNear(0, 0, SEARCH_RADIUS).find((site) => site.presetId === presetId) ?? null;
  }
  return { world, wind, state, manager, water, ground, frame, nearestSite, bus };
}

/** The first seed with a placed site of presetId. Returns { seed, site } or null. */
function findSite(presetId) {
  for (const seed of SEEDS) {
    const site = createLab(seed).nearestSite(presetId);
    if (site) return { seed, site };
  }
  return null;
}

// ============================================================================================
// FLIGHT
// ============================================================================================
/** A craft's SIM model in the lab's air: env.wind is the WindField at the craft every tick. */
function createFlightRig(craft, lab, assists) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const craftState = craft.abilities.craftAbility.initialState();
  const world = { groundHeight: lab.ground, heightAt: lab.ground, WATER_LEVEL: CONFIG.WATER_LEVEL };
  const model = flightModels.create(craft.simProfile.model, { profile: craft.simProfile, craft, world, bus, state: null, craftState });
  const pilot = createControlState();
  pilot.sources.throttle = 'keyboard';
  const controls = createControlState();
  const autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  const telemetry = createFlightTelemetry();
  telemetry.assists = assists;
  telemetry.craftState = craftState;
  const env = { time: 0, wind: { vel: new THREE.Vector3(), turbulence: 0 }, groundHeight: lab.ground, waterLevel: CONFIG.WATER_LEVEL, rho: 1.225, world, craftState, assists, handsOff: false, autopilot, telemetry };
  const context = { dt: DT, model, craft, craftId: craft.id, env, autopilot, assists, handsOff: false, telemetry, activeAssists: [], game: { ringCourse: { active: false }, waypoint: null } };
  const rig = { model, data: model.flightData, pilot, env };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    lab.wind.sample(model.state.position, lab.state.time.elapsed, env.wind);
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
 * Flies craft from start on heading for seconds (straight, or circling at bank degrees), advancing the
 * lab's world and spawns every frame with the camera at the craft. With centre(lab) -> { x, z } the
 * circling glider centres its turn on that point the way a pilot centres a thermal: it banks steeper
 * while the point lies more than CIRCLE_RADIUS away and shallower inside. With target { x, z } the log
 * keeps the closest horizontal approach to it. Returns the log.
 */
function fly(craft, lab, { speed, altitude, heading, start, seconds, throttle, bank = 0, skip = 0.5, centre = null, target = null }) {
  const flyByWire = craft === jet;
  const rig = createFlightRig(craft, lab, flyByWire ? 1 : 0);
  const bankGain = flyByWire ? 1.2 : 1.6;
  const rateGain = flyByWire ? 0.25 : 0.35;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  // Settle the trim first (in place: the position is reset afterwards).
  let trimPitch = 0;
  for (let tick = 0; tick < 240; tick++) {
    rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
    rig.pilot.pitch = flyByWire ? 0 : clamp(-0.12 * rig.data.verticalSpeed - 0.25 * rig.data.pitchRate, -1, 1);
    rig.tick();
    trimPitch = rig.data.pitch;
  }
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  let integral = 0;
  const entry = { minVertical: Infinity, maxVertical: -Infinity, meanVertical: 0, minLoad: Infinity, maxLoad: -Infinity, minAirspeed: Infinity, maxAirspeed: -Infinity, maxTurbulence: 0, meanTurbulence: 0, groundSpeed: 0, drift: 0, altitudeChange: 0, crashed: false, closest: Infinity };
  const across = { x: Math.cos(heading * DEG), z: Math.sin(heading * DEG) };
  let samples = 0;
  let loadSum = 0;
  let loadSquares = 0;
  let verticalSum = 0;
  let turbulenceSum = 0;
  let crosswind = 0;
  let travelled = 0;
  const frames = Math.round(seconds / FRAME);
  const velocity = rig.model.state.velocity;
  const position = rig.model.state.position;
  let bankTarget = bank;
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    lab.frame(position, velocity);
    if (centre && bank !== 0) {
      const point = centre(lab);
      const distance = Math.hypot(point.x - position.x, point.z - position.z);
      bankTarget = Math.sign(bank) * clamp(Math.abs(bank) + 0.25 * (distance - CIRCLE_RADIUS), 20, 60);
    }
    for (let tick = 0; tick < 2; tick++) {
      if (flyByWire) {
        rig.pilot.pitch = 0;
      } else {
        // Circling glides at a slightly raised attitude, so the turn does not trade height for speed.
        const target = trimPitch + (bank !== 0 ? 0.06 : 0);
        const error = target - rig.data.pitch;
        integral = clamp(integral + error * DT * 1.2, -0.6, 0.6);
        rig.pilot.pitch = clamp(2.2 * error + integral - 0.6 * rig.data.pitchRate, -1, 1);
      }
      rig.pilot.roll = clamp(bankGain * (bankTarget * DEG - rig.data.bank) - rateGain * rig.data.rollRate, -1, 1);
      rig.pilot.yaw = clamp((flyByWire ? 3 : 4) * rig.data.sideslip, -1, 1);
      rig.tick();
    }
    if (position.y < lab.ground(position.x, position.z) + 2) {
      entry.crashed = true;
      break;
    }
    if (frameIndex < skip / FRAME) continue;
    const data = rig.data;
    entry.minVertical = Math.min(entry.minVertical, data.verticalSpeed);
    entry.maxVertical = Math.max(entry.maxVertical, data.verticalSpeed);
    entry.minLoad = Math.min(entry.minLoad, data.gLoad);
    entry.maxLoad = Math.max(entry.maxLoad, data.gLoad);
    entry.minAirspeed = Math.min(entry.minAirspeed, data.airspeed);
    entry.maxAirspeed = Math.max(entry.maxAirspeed, data.airspeed);
    entry.maxTurbulence = Math.max(entry.maxTurbulence, rig.env.wind.turbulence);
    turbulenceSum += rig.env.wind.turbulence;
    crosswind += (rig.env.wind.vel.x * across.x + rig.env.wind.vel.z * across.z) * FRAME;
    if (target) entry.closest = Math.min(entry.closest, Math.hypot(position.x - target.x, position.z - target.z));
    loadSum += data.gLoad;
    loadSquares += data.gLoad * data.gLoad;
    verticalSum += data.verticalSpeed;
    travelled += Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z) * FRAME;
    samples++;
  }
  entry.samples = samples;
  entry.meanVertical = samples > 0 ? verticalSum / samples : 0;
  entry.meanTurbulence = samples > 0 ? turbulenceSum / samples : 0;
  entry.groundSpeed = samples > 0 ? travelled / (samples * FRAME) : 0;
  entry.drift = (position.x - start.x) * across.x + (position.z - start.z) * across.z;
  entry.crosswind = crosswind;
  entry.altitudeChange = position.y - altitude;
  const mean = samples > 0 ? loadSum / samples : 1;
  entry.loadDeviation = samples > 0 ? Math.sqrt(Math.max(0, loadSquares / samples - mean * mean)) : 0;
  entry.end = { x: position.x, y: position.y, z: position.z };
  return entry;
}

/** The turn radius a centring pilot aims for (m): a 45 degree turn at 30 m/s is about 92 m. */
const CIRCLE_RADIUS = 80;

const flightTable = [];
function record(scenario, craft, calm, air) {
  const row = {
    scenario,
    craft,
    vertical: `${round(calm.minVertical, 1)}..${round(calm.maxVertical, 1)} (mean ${round(calm.meanVertical, 2)}) -> ${round(air.minVertical, 1)}..${round(air.maxVertical, 1)} (mean ${round(air.meanVertical, 2)})`,
    load: `${round(calm.minLoad)}..${round(calm.maxLoad)} (sd ${round(calm.loadDeviation, 3)}) -> ${round(air.minLoad)}..${round(air.maxLoad)} (sd ${round(air.loadDeviation, 3)})`,
    airspeed: `${round(calm.minAirspeed, 1)}..${round(calm.maxAirspeed, 1)} -> ${round(air.minAirspeed, 1)}..${round(air.maxAirspeed, 1)}`,
    drift: `${round(calm.drift, 0)} -> ${round(air.drift, 0)}`,
    turbulence: `mean ${round(calm.meanTurbulence)} -> ${round(air.meanTurbulence)}, max ${round(calm.maxTurbulence)} -> ${round(air.maxTurbulence)}`,
  };
  flightTable.push(row);
  log(`  ${scenario} ${craft}: calm ${JSON.stringify({ samples: calm.samples, crashed: calm.crashed, end: calm.end, crosswind: round(calm.crosswind, 1) })}; air ${JSON.stringify({ samples: air.samples, crashed: air.crashed, end: air.end, crosswind: round(air.crosswind, 1) })}`);
  return `vs ${row.vertical} m/s; g ${row.load}; airspeed ${row.airspeed} m/s; drift ${row.drift} m; turbulence ${row.turbulence}`;
}

const GLIDER = Object.freeze({ craft: glider, label: 'glider', speed: 30, throttle: 0 });
const JET = Object.freeze({ craft: jet, label: 'jet', speed: 220, throttle: 0.34 });
const bumped = (calm, air, factor = 2) => air.loadDeviation > calm.loadDeviation * factor + 0.005;
const swing = (entry) => entry.maxAirspeed - entry.minAirspeed;
const rougher = (calm, air, by) => air.meanTurbulence > calm.meanTurbulence + by;

/** Compass point at distance along bearing from (x, z). */
function offset(x, z, bearing, distance) {
  return { x: x + Math.sin(bearing * DEG) * distance, z: z - Math.cos(bearing * DEG) * distance };
}

/**
 * Flies one craft along the same path twice: once in the plain world (calm: the preset is not
 * active) and once with the spawn activated by spawn(lab). Returns { calm, air, lab }.
 */
function compare(seed, entry, plan, spawn, { sunElevation = 50 } = {}) {
  const calmLab = createLab(seed, { sunElevation });
  const calm = fly(entry.craft, calmLab, { ...plan, speed: entry.speed, throttle: entry.throttle });
  const lab = createLab(seed, { sunElevation });
  spawn(lab);
  const air = fly(entry.craft, lab, { ...plan, speed: entry.speed, throttle: entry.throttle });
  return { calm, air, lab };
}

// ============================================================================================
// SCENARIOS
// ============================================================================================
function testMaelstrom() {
  const found = findSite('maelstrom');
  check('maelstrom', 'a maelstrom is placed within 60 km on one of the lab seeds', found !== null, found ? `${found.seed}: ${found.site.id}` : 'none');
  if (!found) return;
  const { seed, site } = found;
  const activate = (lab) => {
    const id = lab.manager.activate('maelstrom', { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
    if (!id) throw new Error('the maelstrom was refused');
    return id;
  };
  const water = CONFIG.WATER_LEVEL;
  {
    // The air the vortex blows (verbose): the wind at points around the eye, with and without it.
    const lab = createLab(seed);
    const plain = createLab(seed);
    activate(lab);
    lab.frame(new THREE.Vector3(site.x, water + 300, site.z + 1500), new THREE.Vector3());
    const out = { vel: new THREE.Vector3(), turbulence: 0 };
    for (const [bearing, distance, height] of [[180, 700, 300], [180, 300, 300], [180, 150, 300], [90, 700, 300], [0, 60, 400]]) {
      const point = offset(site.x, site.z, bearing, distance);
      const where = new THREE.Vector3(point.x, water + height, point.z);
      const air = lab.wind.probe(where, lab.state.time.elapsed, out).vel.clone();
      const calm = plain.wind.probe(where, plain.state.time.elapsed, out).vel.clone();
      log(`  maelstrom wind ${distance} m at ${bearing} deg, ${height} m: ${round(air.x - calm.x, 1)}, ${round(air.y - calm.y, 1)}, ${round(air.z - calm.z, 1)} m/s over the plain field`);
    }
  }
  // Across the eye, west to east, high enough to stay out of the sea's own low-level chop.
  for (const entry of [GLIDER, JET]) {
    const plan = entry === JET
      ? { altitude: water + 400, heading: 90, start: offset(site.x, site.z, 270, 3500), seconds: 32 }
      : { altitude: water + 400, heading: 90, start: offset(site.x, site.z, 270, 1200), seconds: 80 };
    const { calm, air } = compare(seed, entry, plan, activate);
    const detail = record('maelstrom: across the eye', entry.label, calm, air);
    if (entry === GLIDER) {
      check('maelstrom', 'glider across the eye at 400 m: tossed up over the eye, the swirl swings its airspeed, rough air', air.maxVertical > calm.maxVertical + 3 && swing(air) > swing(calm) + 5 && rougher(calm, air, 0.1) && !air.crashed, detail);
    } else {
      check('maelstrom', 'jet across the eye at 400 m: load bumps and rough air, no tumble', bumped(calm, air, 1.3) && rougher(calm, air, 0.05) && air.minLoad > -0.5 && air.maxLoad < 3.5 && !air.crashed, detail);
    }
  }
  // 700 m abeam (south of the eye), in the inflow layer: the swirl and the inflow pull the glider.
  const abeam = offset(site.x, site.z, 180, 700);
  const plan = { altitude: water + 300, heading: 90, start: offset(abeam.x, abeam.z, 270, 1200), seconds: 70, target: { x: site.x, z: site.z } };
  const { calm, air } = compare(seed, GLIDER, plan, activate);
  const detail = record('maelstrom: 700 m abeam', GLIDER.label, calm, air);
  check('maelstrom', 'glider 700 m abeam at 300 m: the swirl swings its airspeed and bumps it, drawn toward the eye', swing(air) > swing(calm) + 4 && bumped(calm, air, 1.3) && air.drift < calm.drift && !air.crashed, `closest approach ${Math.round(calm.closest)} -> ${Math.round(air.closest)} m; ${detail}`);
}

function testWindFarm() {
  const found = findSite('windFarm');
  check('wind farm', 'a wind farm is placed within 60 km on one of the lab seeds', found !== null, found ? `${found.seed}: ${found.site.id}` : 'none');
  if (!found) return;
  const { seed, site } = found;
  const activate = (lab) => {
    const id = lab.manager.activate('windFarm', { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
    if (!id) throw new Error('the wind farm was refused');
    // Let the rotors spin up and the wake ease in.
    for (let frame = 0; frame < 240; frame++) lab.frame(new THREE.Vector3(site.x, site.groundY + 300, site.z + 1500), new THREE.Vector3());
    return id;
  };
  // Find the wake: where the spawn adds the most turbulence at hub height, against the same world
  // without it (the terrain's own lee rotors are left out that way).
  const probeLab = createLab(seed);
  const plainLab = createLab(seed);
  activate(probeLab);
  plainLab.state.time.elapsed = probeLab.state.time.elapsed;
  const out = { vel: new THREE.Vector3(), turbulence: 0 };
  const point = new THREE.Vector3();
  let best = null;
  for (let dz = -1600; dz <= 1600; dz += 40) {
    for (let dx = -1600; dx <= 1600; dx += 40) {
      const x = site.x + dx;
      const z = site.z + dz;
      point.set(x, probeLab.ground(x, z) + 80, z);
      const turbulence = probeLab.wind.probe(point, probeLab.state.time.elapsed, out).turbulence;
      const added = turbulence - plainLab.wind.probe(point, plainLab.state.time.elapsed, out).turbulence;
      if (!best || added > best.added) best = { x, z, y: point.y, turbulence, added };
    }
  }
  const ambient = probeLab.wind.ambientAt({ x: site.x, y: site.groundY + 80, z: site.z });
  const sources = probeLab.wind.listSources().filter((source) => source.kind === 'structure-wake').length;
  check('wind farm', 'the wake is a structure-wake WindField source with rough air downwind', sources === 1 && best.added > 0.2, `${sources} wake source; the wake adds ${round(best.added)} turbulence (to ${round(best.turbulence)}) at ${Math.round(best.x - site.x)}, ${Math.round(best.z - site.z)} m from the site, wind from ${Math.round(ambient.fromDegrees)} deg at ${round(ambient.speed, 1)} m/s`);
  // Cross the wake perpendicular to the wind, through the roughest point, at its height (or above the
  // ground on the way).
  const crossHeading = (ambient.fromDegrees + 90) % 360;
  for (const entry of [GLIDER, JET]) {
    const span = entry === JET ? 2000 : 600;
    const start = offset(best.x, best.z, crossHeading + 180, span * 0.5);
    let highest = best.y;
    for (let step = 0; step <= 20; step++) {
      const sample = offset(start.x, start.z, crossHeading, (span * step) / 20);
      highest = Math.max(highest, probeLab.ground(sample.x, sample.z) + 40);
    }
    const plan = { altitude: highest, heading: crossHeading, start, seconds: span / entry.speed };
    const { calm, air } = compare(seed, entry, plan, activate);
    const detail = record('wind farm: across the wakes', entry.label, calm, air);
    if (entry === GLIDER) {
      check('wind farm', 'glider across the wakes at hub height: bumps and rough air', bumped(calm, air, 1.2) && rougher(calm, air, 0.03) && !air.crashed, detail);
    } else {
      // At 220 m/s the jet is through a wake a few rotors wide in under a second, low over terrain
      // whose own chop is already rough: a brief jolt at most, and never out of control.
      check('wind farm', 'jet across the wakes at hub height: a brief jolt at most, no tumble', air.minLoad > 0 && air.maxLoad < 2.5 && !air.crashed, detail);
    }
  }
}

function testThermalHawks() {
  // A meadow thermal at midday on one of the seeds, where the hawks are activated.
  let found = null;
  for (const seed of SEEDS) {
    const lab = createLab(seed);
    for (let ring = 0; ring < 12 && !found; ring++) {
      const point = offset(0, 0, ring * 47, 3000 + ring * 1500);
      const thermal = lab.wind.nearestThermal({ x: point.x, y: 0, z: point.z }, 2);
      if (thermal && lab.world.biomeAt(thermal.x, thermal.z).key === 'meadows') found = { seed, thermal };
    }
    if (found) break;
  }
  check('hawks', 'a working meadow thermal at midday on one of the lab seeds', found !== null, found ? `${found.seed}: ${found.thermal.id}, ${round(found.thermal.strength, 2)} m/s core` : 'none');
  if (!found) return;
  const { seed, thermal } = found;
  let hawksAt = null;
  let hawksId = null;
  const activate = (lab) => {
    const groundY = lab.ground(thermal.x + 300, thermal.z + 300);
    const id = lab.manager.activate('thermalHawks', { position: { x: thermal.x + 300, y: groundY, z: thermal.z + 300 }, heading: 0, source: 'debug', force: true, duration: 900 });
    if (!id) throw new Error('the thermal hawks were refused');
    // Let the hawks find the thermal and climb into it.
    for (let frame = 0; frame < 60 * 40; frame++) lab.frame(new THREE.Vector3(thermal.x + 900, thermal.ground + 500, thermal.z), new THREE.Vector3());
    const fauna = lab.manager.registry.get('fauna');
    const description = fauna.describe(id);
    hawksAt = { x: description.center.x, y: description.center.y, z: description.center.z, ended: lab.manager.getInstance(id) === null };
    hawksId = id;
    return id;
  };
  // Where the hawks circle (from a first activation), then the glider circles there.
  const probe = createLab(seed);
  activate(probe);
  const distance = Math.hypot(hawksAt.x - thermal.x, hawksAt.z - thermal.z);
  check('hawks', 'the hawks circle in the thermal (group centre within the lean of the column)', !hawksAt.ended && distance < thermal.radius + 300 && hawksAt.y > thermal.ground + 100, `centre ${Math.round(distance)} m from the thermal's base, ${Math.round(hawksAt.y - thermal.ground)} m above its ground; core radius ${Math.round(thermal.radius)} m`);
  // A 45 degree turn at 30 m/s has a radius of about 92 m: start on that circle, flying tangentially.
  const radius = (GLIDER.speed * GLIDER.speed) / (9.81 * Math.tan(45 * DEG));
  const start = offset(hawksAt.x, hawksAt.z, 270, radius);
  // The glider centres its circle on the live hawks (at night, on where they were: the same circle).
  const fixed = { x: hawksAt.x, z: hawksAt.z };
  const liveHawks = (lab) => {
    const instance = hawksId ? lab.manager.getInstance(hawksId) : null;
    return instance ? { x: instance.position.x, z: instance.position.z } : fixed;
  };
  const plan = { altitude: hawksAt.y, heading: 0, start, seconds: 60, bank: 45, skip: 8, centre: liveHawks };
  const midday = compare(seed, GLIDER, plan, activate);
  const night = createLab(seed, { sunElevation: -10 });
  const nightLog = fly(GLIDER.craft, night, { ...plan, centre: () => fixed, speed: GLIDER.speed, throttle: GLIDER.throttle });
  const detail = record('hawks: circling with them', GLIDER.label, nightLog, midday.air);
  check('hawks', 'glider circling where the hawks circle: it climbs (against the same circle at night)', midday.air.meanVertical > nightLog.meanVertical + 0.8 && !midday.air.crashed, `${detail}; the thermal alone without the hawks: mean ${round(midday.calm.meanVertical, 2)} m/s`);
  const jetPlan = { altitude: hawksAt.y, heading: 90, start: offset(hawksAt.x, hawksAt.z, 270, 2000), seconds: 18 };
  const jetMidday = compare(seed, JET, jetPlan, activate);
  const jetNight = fly(JET.craft, createLab(seed, { sunElevation: -10 }), { ...jetPlan, speed: JET.speed, throttle: JET.throttle });
  const jetDetail = record('hawks: straight through', JET.label, jetNight, jetMidday.air);
  check('hawks', 'jet straight through the hawks\' column: a load bump against the night', jetMidday.air.maxLoad - jetMidday.air.minLoad > jetNight.maxLoad - jetNight.minLoad + 0.05 && !jetMidday.air.crashed, jetDetail);
}

// ============================================================================================
// RUN
// ============================================================================================
const started = Date.now();
testMaelstrom();
testWindFarm();
testThermalHawks();
check('console', 'no console errors from the engines and the manager', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

process.stdout.write('\nflight log (calm -> with the preset)\n');
for (const row of flightTable) {
  process.stdout.write(`  ${row.scenario.padEnd(28)} ${row.craft.padEnd(7)} vs ${row.vertical.padEnd(52)} g ${row.load.padEnd(40)} airspeed ${row.airspeed.padEnd(24)} drift ${row.drift.padEnd(12)} turb ${row.turbulence}\n`);
}
const failed = results.filter((result) => !result.pass).length;
process.stdout.write(`\npreset flight lab: ${results.length - failed}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(failed === 0 ? 0 : 1);
