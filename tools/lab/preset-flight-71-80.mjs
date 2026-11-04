// Preset flight lab, presets 71-80: flies the SIM glider, bush plane and jet with scripted inputs through the
// wind-affecting presets of batch 8 (the * presets: reverse waterfall, ridge lift band, wind shear
// line, thermal street, waterfall wall), headless in node, against the same path flown in the same
// world without the spawn, as tools/lab/preset-flight.mjs does for the Phase 2 presets.
//
// The world is the real world generator (real terrain, the real WindField with its thermals); the
// spawns go through the real SpawnManager with the real engines, activated on open lowland the way the
// dev debugger's force spawn does (a site preset then raises its own cliff instead of a stamped one).
// The craft run the game's own SIM flight models through the same control stages as the game: the
// glider at 0 % assists holds its ground track on the ailerons (15 degrees of bank at most), the ball
// centred on the rudder and its trim pitch attitude on the elevator; the jet at 100 % assists (its
// fly-by-wire holds 1 g on a centred stick) holds its track and the ball.
//
// The bush plane (0 % assists, cruise power) holds its attitude like the glider. The jet's fly-by-wire
// holds 1 g, so a smooth band of rising air only tilts its wing (its path stays inertial): the jet is
// flown where the air changes sharply (a narrow column, a shear, the falls), the bush plane where a
// slower powered craft rides the lift.
//
// Scenarios (each one names what the craft must feel):
//   reverse   the glider through the updraft column beside the rising water is carried up; the jet
//             straight through it: a load bump, no tumble
//   ridge     the glider along the lift band climbs (or sinks far less) than on the same line
//             without it; so does the bush plane holding its attitude
//   shear     crossing the shear line into the new air mass, the glider's airspeed swings and its
//             headwind costs it ground on the same flight; the jet across it: a jolt at most, never
//             out of control
//   street    the glider running a cloud row climbs under the clouds; so does the bush plane
//   falls     the glider flown along the waterfall wall through the falls drops in each one; the
//             jet along the same line: load bumps, no tumble
//
// Usage: node tools/lab/preset-flight-71-80.mjs [--verbose]
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
import { createWaterQuery } from '../../src/world/waterQuery.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { createWindModifierEngine } from '../../src/spawns/engines/windModifierEngine.js';
import { createWeatherVolumeEngine } from '../../src/spawns/engines/weatherVolumeEngine.js';
import { createEmitterEngine } from '../../src/spawns/engines/emitterEngine.js';
import { createWaterEffectEngine } from '../../src/spawns/engines/waterEffectEngine.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';
import { PRESET_BY_ID } from '../../src/spawns/presets/index.js';
import glider from '../../src/craft/glider.js';
import jet from '../../src/craft/jet.js';
import bushplane from '../../src/craft/bushplane.js';
import { flightModels } from '../../src/flight/models.js';
import { createControlState, copyControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry, airDensity } from '../../src/flight/telemetry.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const DT = 1 / 120;
const FRAME = 1 / 60;
const SEED = 'HARNESS-1';
const PRESET_IDS = Object.freeze(['reverseWaterfall', 'ridgeLiftBand', 'windShearLine', 'thermalStreet', 'waterfallWall']);
/** Land for the activations: the land point of LOWLAND_CANDIDATES with the least relief over LOWLAND_REACH. */
const LOWLAND_CANDIDATES = 160;
const LOWLAND_REACH = 2500;
/** A straight flight clears the highest ground under its path by this much at least (m). */
const PATH_CLEARANCE = 120;

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(8)} ${name}${detail ? `  (${detail})` : ''}\n`);
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
/** A real world with the WindField, the water effects layer and a SpawnManager running the batch. */
function createLab({ sunElevation = 50 } = {}) {
  const world = createWorldGen(SEED, WORLD_OPTIONS);
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
    renderOrigin: uniform(new THREE.Vector3()),
    cloudGlory: uniform(0),
    cloudBow: uniform(0),
  };
  const state = {
    seed: SEED,
    frame: 0,
    time: { elapsed: 0, frameDt: 0, sunElevation, dayTime: 0.5, nightFactor: sunElevation < 0 ? 1 : 0, goldenFactor: 0, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(), moonDirection: new THREE.Vector3(-0.3, -0.5, 0.8).normalize() },
    player: { position: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(), quaternion: new THREE.Quaternion(), heading: 0, speed: 0 },
    flight: { craft: 'glider' },
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const waterQuery = createWaterQuery({ world, windDirection: uniforms.windDirection.value, clock: state.time });
  const water = createWaterEffects({ THREE, TSL, scene, camera, state, uniforms, world, waterQuery, systems: {}, registerPrewarm() {} });
  waterQuery.attachEffects(water);
  // The sky's modifier API (the weather volumes' inside fog).
  const sky = {
    addModifier() {
      return { set() {}, remove() {} };
    },
    getModifierLevels: () => ({ active: false, overcast: 0 }),
  };
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    // backend WebGL2: the emitter runs its closed-form particles in node (no compute pass to submit).
    THREE, TSL, scene, camera, renderer: { info: { memory: { geometries: 0, textures: 0 } } }, backend: 'WebGL2', wind, audio: null, world, state,
    sky, bus, perf: null, settings: null, uniforms, registry, presets: [], seed: SEED, water, surfaces: createGroundSurfaces(),
  });
  for (const createEngine of [createStructureEngine, createWindModifierEngine, createWeatherVolumeEngine, createEmitterEngine, createWaterEffectEngine, createFaunaEngine]) manager.register(createEngine());
  for (const id of PRESET_IDS) manager.addPreset(PRESET_BY_ID[id]);
  manager.init();
  const ground = (x, z) => Math.max(world.groundHeight(x, z), CONFIG.WATER_LEVEL);
  /** Advances the world one frame with the camera (LOD, view) at the craft. */
  function frame(position, velocity) {
    state.frame++;
    state.time.elapsed += FRAME;
    state.time.frameDt = FRAME;
    state.player.position.copy(position);
    state.player.velocity.copy(velocity);
    camera.position.copy(position);
    camera.updateMatrixWorld();
    manager.update(FRAME, FRAME);
  }
  /** Activates presetId at (x, z) on heading as the dev debugger's force spawn does, settled a second. */
  function activate(presetId, x, z, heading) {
    const position = { x, y: ground(x, z), z };
    camera.position.set(x, position.y + 400, z + 600);
    state.player.position.copy(camera.position);
    const id = manager.activate(presetId, { position, heading, source: 'debug', force: true });
    for (let index = 0; index < 60; index++) frame(state.player.position, state.player.velocity);
    return id;
  }
  return { world, wind, state, uniforms, manager, ground, frame, activate };
}

/** The compass heading an activation with anchor.align 'downwind' takes (spawnManager applyAnchorRule). */
function downwindHeading(lab) {
  const direction = lab.uniforms.windDirection.value;
  const compass = (Math.atan2(direction.x, -direction.y) * 180) / Math.PI;
  return compass < 0 ? compass + 360 : compass;
}

/**
 * The flattest land near the seed's origin: of the first LOWLAND_CANDIDATES land points on a spiral
 * (1 km apart), the one with the least relief over a ring of 16 points LOWLAND_REACH out, all of them
 * above the sea. Ground samples cost about a millisecond each on the real world, so the search is
 * kept to a few thousand of them.
 */
function findLowland(world) {
  let best = null;
  let tried = 0;
  for (let index = 1; index < 4000 && tried < LOWLAND_CANDIDATES; index++) {
    const angle = index * 2.399963;
    const reach = 1000 * Math.sqrt(index);
    const x = Math.sin(angle) * reach;
    const z = -Math.cos(angle) * reach;
    const centre = world.groundHeight(x, z);
    if (centre < CONFIG.WATER_LEVEL + 15) continue;
    tried++;
    let low = centre;
    let high = centre;
    for (let spoke = 0; spoke < 16; spoke++) {
      const height = world.groundHeight(x + Math.sin(spoke * 22.5 * DEG) * LOWLAND_REACH, z - Math.cos(spoke * 22.5 * DEG) * LOWLAND_REACH);
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
    if (low < CONFIG.WATER_LEVEL + 5) continue;
    if (!best || high - low < best.relief) best = { x, z, ground: centre, relief: high - low };
  }
  return best;
}

/** The highest ground (m) under a straight path of `length` m from start on heading, every 150 m. */
function pathTop(lab, start, heading, length) {
  let top = -Infinity;
  for (let along = 0; along <= length; along += 150) {
    const point = offset(start.x, start.z, heading, along);
    top = Math.max(top, lab.ground(point.x, point.z));
  }
  return top;
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
  const rig = { model, data: model.flightData, pilot, env, stillAir: false };
  rig.tick = () => {
    copyControlState(controls, pilot);
    pilot.actions.clear();
    context.activeAssists.length = 0;
    env.rho = airDensity(model.state.position.y);
    for (const stage of flightModels.controlStages()) stage.apply(controls, context);
    env.time += DT;
    if (rig.stillAir) {
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
 * Flies craft from start along heading for seconds, its ground track held on the line, advancing the
 * lab's world and spawns every frame with the camera at the craft.
 * Returns the log: vertical speed, load factor, airspeed, turbulence, drift across the track, the
 * height change.
 */
function fly(craft, lab, { speed, altitude, heading, start, seconds, throttle, skip = 0.5 }) {
  const flyByWire = craft === jet;
  const rig = createFlightRig(craft, lab, flyByWire ? 1 : 0);
  const bankGain = flyByWire ? 1.2 : 1.6;
  const rateGain = flyByWire ? 0.25 : 0.35;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  // Settle the trim first, in still air (in place: the position is reset afterwards), so a start
  // inside the spawn's lift does not trim the nose down to hold level flight in rising air.
  let trimPitch = 0;
  rig.stillAir = true;
  for (let tick = 0; tick < 240; tick++) {
    rig.pilot.roll = clamp(-bankGain * rig.data.bank - rateGain * rig.data.rollRate, -1, 1);
    rig.pilot.pitch = flyByWire ? 0 : clamp(-0.12 * rig.data.verticalSpeed - 0.25 * rig.data.pitchRate, -1, 1);
    rig.tick();
    trimPitch = rig.data.pitch;
  }
  rig.stillAir = false;
  rig.airborne({ speed, altitude, heading, x: start.x, z: start.z, throttle });
  let integral = 0;
  const entry = { minVertical: Infinity, maxVertical: -Infinity, meanVertical: 0, minLoad: Infinity, maxLoad: -Infinity, minAirspeed: Infinity, maxAirspeed: -Infinity, maxTurbulence: 0, meanTurbulence: 0, drift: 0, altitudeChange: 0, crashed: false };
  const across = { x: Math.cos(heading * DEG), z: Math.sin(heading * DEG) };
  let samples = 0;
  let loadSum = 0;
  let loadSquares = 0;
  let verticalSum = 0;
  let turbulenceSum = 0;
  const frames = Math.round(seconds / FRAME);
  const velocity = rig.model.state.velocity;
  const position = rig.model.state.position;
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    lab.frame(position, velocity);
    // Track hold: a few degrees of bank toward the line flown from the start, crabbing into a
    // crosswind as a pilot running a ridge or a cloud row does.
    const track = Math.atan2(velocity.x, -velocity.z) / DEG;
    const trackError = Math.atan2(Math.sin((heading - track) * DEG), Math.cos((heading - track) * DEG)) / DEG;
    const bankTarget = clamp(1.2 * trackError, -15, 15);
    for (let tick = 0; tick < 2; tick++) {
      if (flyByWire) {
        rig.pilot.pitch = 0;
      } else {
        const error = trimPitch - rig.data.pitch;
        integral = clamp(integral + error * DT * 1.2, -0.6, 0.6);
        rig.pilot.pitch = clamp(2.2 * error + integral - 0.6 * rig.data.pitchRate, -1, 1);
      }
      rig.pilot.roll = clamp(bankGain * (bankTarget * DEG - rig.data.bank) - rateGain * rig.data.rollRate, -1, 1);
      rig.pilot.yaw = clamp((flyByWire ? 3 : 4) * rig.data.sideslip, -1, 1);
      rig.tick();
    }
    if (VERBOSE && frameIndex % 600 === 0) {
      const data = rig.data;
      log(`      t ${round(frameIndex * FRAME, 0)} s: ${Math.round(position.x - start.x)}, ${Math.round(position.z - start.z)} m, ${Math.round(position.y - lab.ground(position.x, position.z))} m up, airspeed ${round(data.airspeed, 1)}, vs ${round(data.verticalSpeed, 1)}, bank ${round(data.bank / DEG, 0)}, pitch ${round(data.pitch / DEG, 1)}, wind ${round(rig.env.wind.vel.x, 1)} ${round(rig.env.wind.vel.y, 1)} ${round(rig.env.wind.vel.z, 1)}`);
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
    loadSum += data.gLoad;
    loadSquares += data.gLoad * data.gLoad;
    verticalSum += data.verticalSpeed;
    samples++;
  }
  entry.samples = samples;
  entry.meanVertical = samples > 0 ? verticalSum / samples : 0;
  entry.meanTurbulence = samples > 0 ? turbulenceSum / samples : 0;
  entry.drift = (position.x - start.x) * across.x + (position.z - start.z) * across.z;
  entry.progress = (position.x - start.x) * Math.sin(heading * DEG) - (position.z - start.z) * Math.cos(heading * DEG);
  entry.altitudeChange = position.y - altitude;
  const mean = samples > 0 ? loadSum / samples : 1;
  entry.loadDeviation = samples > 0 ? Math.sqrt(Math.max(0, loadSquares / samples - mean * mean)) : 0;
  entry.end = { x: position.x, y: position.y, z: position.z };
  return entry;
}

function summary(calm, air) {
  const line = (entry) => `vs ${round(entry.minVertical, 1)}..${round(entry.maxVertical, 1)} (mean ${round(entry.meanVertical, 2)}), g ${round(entry.minLoad)}..${round(entry.maxLoad)} (sd ${round(entry.loadDeviation, 3)}), airspeed ${round(entry.minAirspeed, 1)}..${round(entry.maxAirspeed, 1)}, drift ${round(entry.drift, 0)} m, height ${round(entry.altitudeChange, 0)} m${entry.crashed ? ', CRASHED' : ''}`;
  log(`    calm: ${line(calm)}`);
  log(`    air:  ${line(air)}`);
  return `calm ${round(calm.meanVertical, 2)} m/s mean, ${round(calm.altitudeChange, 0)} m, g sd ${round(calm.loadDeviation, 3)}, airspeed swing ${round(calm.maxAirspeed - calm.minAirspeed, 1)}, drift ${round(calm.drift, 0)}; spawn ${round(air.meanVertical, 2)} m/s mean, ${round(air.altitudeChange, 0)} m, g sd ${round(air.loadDeviation, 3)}, airspeed swing ${round(air.maxAirspeed - air.minAirspeed, 1)}, drift ${round(air.drift, 0)}`;
}

const GLIDER = Object.freeze({ craft: glider, label: 'glider', speed: 30, throttle: 0 });
const JET = Object.freeze({ craft: jet, label: 'jet', speed: 220, throttle: 0.34 });
const BUSH = Object.freeze({ craft: bushplane, label: 'bush plane', speed: 47, throttle: 0.75 });
const bumped = (calm, air, factor = 2) => air.loadDeviation > calm.loadDeviation * factor + 0.005;
const swing = (entry) => entry.maxAirspeed - entry.minAirspeed;
const sane = (entry) => !entry.crashed && entry.minLoad > -1 && entry.maxLoad < 5;

/** Compass point at distance along bearing from (x, z). */
function offset(x, z, bearing, distance) {
  return { x: x + Math.sin(bearing * DEG) * distance, z: z - Math.cos(bearing * DEG) * distance };
}

/**
 * Flies one craft along the same path twice: once in the plain world (calm) and once with the spawn
 * activated by spawn(lab) (which returns what the plan needs from it). plan(info, lab) gives the
 * flight. Returns { calm, air, info }.
 */
function compare(entry, spawn, plan, options = {}) {
  const lab = createLab(options);
  const info = spawn(lab);
  const flight = plan(info, lab);
  log(`  ${entry.label}: from ${Math.round(flight.start.x - SITE.x)}, ${Math.round(flight.start.z - SITE.z)} m of the site on ${Math.round(flight.heading)} deg at ${Math.round(flight.altitude - SITE.ground)} m above its ground (${Math.round(SITE.ground)} m)`);
  const calmLab = createLab(options);
  const calm = fly(entry.craft, calmLab, { ...flight, speed: entry.speed, throttle: entry.throttle });
  const air = fly(entry.craft, lab, { ...flight, speed: entry.speed, throttle: entry.throttle });
  return { calm, air, info };
}

/** The wind sources of a kind (their box centres), logged (with --verbose) in the frame of `heading` at the site. */
function sourcesOf(lab, kind, heading = HEADING) {
  const sources = lab.wind.listSources().filter((source) => source.kind === kind);
  const forward = offset(0, 0, heading, 1);
  const frame = sources.map((source) => {
    const dx = source.position.x - SITE.x;
    const dz = source.position.z - SITE.z;
    return `[${Math.round(dx * forward.x + dz * forward.z)} along, ${Math.round(dx * -forward.z + dz * forward.x)} right, ${Math.round(source.position.y - SITE.ground)} up]`;
  });
  log(`    ${kind}: ${frame.join(' ')}`);
  return sources;
}

// ============================================================================================
// SCENARIOS
// ============================================================================================
const probe = createLab();
const lowland = findLowland(probe.world);
check('world', `land on ${SEED} for the activations`, lowland !== null, lowland ? `${Math.round(lowland.x)}, ${Math.round(lowland.z)}: ${Math.round(lowland.ground)} m, relief ${Math.round(lowland.relief)} m over ${LOWLAND_REACH} m` : 'no land found');
const SITE = lowland ?? { x: 0, z: 0, ground: probe.ground(0, 0) };
const HEADING = 30;

function testReverse() {
  const spawn = (lab) => {
    lab.activate('reverseWaterfall', SITE.x, SITE.z, HEADING);
    const column = sourcesOf(lab, 'spawn-updraft')[0] ?? null;
    return { column };
  };
  log('reverse waterfall');
  // Straight through the column's axis at the glider's best glide speed, 250 m above the pool.
  const plan = ({ column }, lab) => {
    const start = offset(column.position.x, column.position.z, HEADING + 90, -600);
    return { altitude: Math.max(SITE.ground + 250, pathTop(lab, start, HEADING + 90, 1200) + PATH_CLEARANCE), heading: HEADING + 90, start, seconds: 40 };
  };
  const glide = compare(GLIDER, spawn, plan);
  check('reverse', 'the updraft column stands beside the rising water', glide.info.column !== null, glide.info.column ? `${Math.round(glide.info.column.position.x - SITE.x)}, ${Math.round(glide.info.column.position.z - SITE.z)} m from the anchor` : 'no updraft source');
  check('reverse', 'glider through the column: it is carried up (6+ m/s at best, 40+ m higher after the pass)', glide.air.maxVertical > glide.calm.maxVertical + 6 && glide.air.altitudeChange > glide.calm.altitudeChange + 40 && !glide.air.crashed, summary(glide.calm, glide.air));
  const fast = compare(JET, spawn, ({ column }, lab) => {
    const start = offset(column.position.x, column.position.z, HEADING + 90, -1800);
    return { altitude: Math.max(SITE.ground + 300, pathTop(lab, start, HEADING + 90, 3600) + PATH_CLEARANCE), heading: HEADING + 90, start, seconds: 14 };
  });
  check('reverse', 'jet straight through the column: a load bump, no tumble', bumped(fast.calm, fast.air, 1.3) && sane(fast.air), summary(fast.calm, fast.air));
}

function testRidge() {
  const spawn = (lab) => {
    lab.activate('ridgeLiftBand', SITE.x, SITE.z, HEADING);
    return { sources: sourcesOf(lab, 'spawn-updraft').length };
  };
  log('ridge lift band');
  const start = offset(SITE.x, SITE.z, HEADING, -2200);
  const altitude = (lab) => Math.max(SITE.ground + 200, pathTop(lab, start, HEADING, 4400) + PATH_CLEARANCE);
  const glide = compare(GLIDER, spawn, (info, lab) => ({ altitude: altitude(lab), heading: HEADING, start, seconds: 130 }));
  check('ridge', 'the band is eight lift columns along the ridge axis', glide.info.sources === 8, `${glide.info.sources} updraft sources`);
  check('ridge', 'glider along the band: 1.5+ m/s better than the same line without it', glide.air.meanVertical > glide.calm.meanVertical + 1.5 && !glide.air.crashed, summary(glide.calm, glide.air));
  const powered = compare(BUSH, spawn, (info, lab) => ({ altitude: altitude(lab), heading: HEADING, start, seconds: 85 }));
  check('ridge', 'bush plane along the band, attitude held: 1.5+ m/s better than the same line without it', powered.air.meanVertical > powered.calm.meanVertical + 1.5 && sane(powered.air), summary(powered.calm, powered.air));
}

function testShear() {
  let front = null;
  const spawn = (lab) => {
    const id = lab.activate('windShearLine', SITE.x, SITE.z, 0);
    // The activation turns downwind; the front faces 90 degrees right of it, 550 m out.
    const heading = lab.manager.getInstance(id) ? downwindHeading(lab) : 0;
    const facing = heading + 90;
    front = { facing, point: offset(SITE.x, SITE.z, facing, 550) };
    return front;
  };
  log('wind shear line');
  // Across the line from ahead of it (the old air) to behind it (the new air mass), 600 m up.
  const plan = (info, lab) => {
    const start = offset(info.point.x, info.point.z, info.facing, 900);
    return { altitude: Math.max(SITE.ground + 600, pathTop(lab, start, info.facing + 180, 2000) + PATH_CLEARANCE), heading: info.facing + 180, start, seconds: 60 };
  };
  const glide = compare(GLIDER, spawn, plan);
  check('shear', 'glider across the line: its airspeed swings (5+ m/s more) and the new air mass costs it 120+ m along the track', swing(glide.air) > swing(glide.calm) + 5 && glide.calm.progress - glide.air.progress > 120 && !glide.air.crashed, `${summary(glide.calm, glide.air)}; along the track ${round(glide.calm.progress, 0)} -> ${round(glide.air.progress, 0)} m`);
  const fast = compare(JET, spawn, (info, lab) => ({ ...plan(info, lab), seconds: 12 }));
  check('shear', 'jet across the line: a jolt at most, never out of control', bumped(fast.calm, fast.air, 1.2) && sane(fast.air), summary(fast.calm, fast.air));
}

function testStreet() {
  const spawn = (lab) => {
    const id = lab.activate('thermalStreet', SITE.x, SITE.z, 0);
    const heading = lab.manager.getInstance(id) ? downwindHeading(lab) : 0;
    return { heading, thermals: sourcesOf(lab, 'spawn-updraft', heading) };
  };
  log('thermal street');
  // Up the row 900 m right of the wind line, from its upwind end, under the cloud bases (800 m up).
  const plan = (info, lab) => {
    const row = offset(SITE.x, SITE.z, info.heading + 90, 900);
    const start = offset(row.x, row.z, info.heading, -3900);
    return { altitude: Math.max(SITE.ground + 800, pathTop(lab, start, info.heading, 7800) + PATH_CLEARANCE), heading: info.heading, start, seconds: 240 };
  };
  const glide = compare(GLIDER, spawn, plan);
  check('street', 'two rows of eight thermals under the clouds', glide.info.thermals.length === 16, `${glide.info.thermals.length} updraft sources`);
  check('street', 'glider running the row: it holds its height (where it sinks without the street) and ends 150+ m higher', glide.air.meanVertical >= 0 && glide.air.altitudeChange > glide.calm.altitudeChange + 150 && !glide.air.crashed, summary(glide.calm, glide.air));
  const powered = compare(BUSH, spawn, (info, lab) => ({ ...plan(info, lab), seconds: 170 }));
  check('street', 'bush plane running the row, attitude held: 0.6+ m/s better than the same line without it', powered.air.meanVertical > powered.calm.meanVertical + 0.6 && sane(powered.air), summary(powered.calm, powered.air));
}

function testFalls() {
  const spawn = (lab) => {
    const id = lab.activate('waterfallWall', SITE.x, SITE.z, HEADING);
    const part = lab.manager.getParts(id).find((entry) => entry.engine === 'structure');
    const falls = part.data.falls;
    // The falls' line at 60 m below the lip, where the water has flown out `speed * t` from it.
    const seconds = Math.sqrt((2 * 60) / falls.gravity);
    const points = [];
    for (let index = 0; index < falls.count; index++) {
      const out = falls.table[index * 3 + 2] * seconds;
      points.push({ x: falls.table[index * 3] + falls.dirX * out, z: falls.table[index * 3 + 1] + falls.dirZ * out });
    }
    return { y: falls.lipY - 60, points, sources: lab.wind.listSources().filter((source) => source.kind === 'structure-falls').length };
  };
  log('waterfall wall');
  // Along the wall through every fall, from beyond its first to beyond its last.
  const plan = (info) => {
    const first = info.points[0];
    const last = info.points[info.points.length - 1];
    const bearing = Math.atan2(last.x - first.x, -(last.z - first.z)) / DEG;
    return { altitude: info.y, heading: bearing, start: offset(first.x, first.z, bearing, -200) };
  };
  const glide = compare(GLIDER, spawn, (info) => ({ ...plan(info), seconds: 36 }));
  check('falls', 'the falls drag their sinking air (a structure-falls WindField source)', glide.info.sources === 1, `${glide.info.sources} source(s), ${glide.info.points.length} falls`);
  check('falls', 'glider along the wall through the falls: it drops in each (1.5+ m/s more at worst) and loses 8+ m more', glide.air.minVertical < glide.calm.minVertical - 1.5 && glide.air.altitudeChange < glide.calm.altitudeChange - 8 && !glide.air.crashed, summary(glide.calm, glide.air));
  const fast = compare(JET, spawn, (info) => ({ ...plan(info), seconds: 6 }));
  check('falls', 'jet along the wall through the falls: load bumps, no tumble', bumped(fast.calm, fast.air, 1.3) && sane(fast.air), summary(fast.calm, fast.air));
}

testReverse();
testRidge();
testShear();
testStreet();
testFalls();
check('console', 'no console errors from the engines and the manager', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const failed = results.filter((result) => !result.pass);
process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} preset flight checks (presets 71-80)\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
