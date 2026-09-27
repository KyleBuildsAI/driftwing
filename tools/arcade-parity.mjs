// Arcade parity proof: drives the original v1 flight system (a verbatim copy of
// src/flight/arcadeFlight.js from commit c571506, kept in tools/parity/v1) and the v2 code with
// identical scripted inputs and identical frame-time sequences, and asserts bit-identical results
// every frame.
//
// Suites (both run by default):
//   model       v1 createFlightSystem vs ArcadeModel + the glider craft mesh (src/craft/glider.js)
//   controller  v1 createFlightSystem vs the FlightController in CLASSIC (wind disabled, since v1
//               had none), including the craft mesh pose the camera reads
//
// Compared every frame, with Object.is on every number: position, quaternion, velocity, speed,
// throttle, heading, pitch, roll, verticalSpeed, yawRate, gForce, stalled, boost, barrelRoll,
// autopilot, the forward / up / right axes, the chase-camera base quaternion, the rendered mesh
// pose (wobble and barrel-roll corkscrew), every control-surface pivot and the prop, and the
// sequence of bus events (stall, boost, barrelroll, autopilot:changed).
//
// The script is 75 s long at mixed frame rates (60, 144, 30 Hz, jitter, 80 ms spikes that hit
// v1's 50 ms clamp, 1 ms frames and paused frames) and covers pitch / roll / yaw, fine control,
// throttle keys and wheel targets, boost, barrel rolls both ways, a stall and its recovery, the
// terrain assist in a dive at rising ground, heading / altitude autopilot, waypoint following, ring
// following, the manual-override disengage, the soft ceiling, photo mode refusals, non-finite input
// and a non-finite shared quaternion.
//
// Usage: node tools/arcade-parity.mjs [--suite model|controller|all] [--seed PARITY] [--verbose]
// Prints PASS or FAIL per suite and exits non-zero on any mismatch.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlightSystem as createV1FlightSystem } from './parity/v1/flight/arcadeFlight.js';
import { createArcadeModel } from '../src/flight/ArcadeModel.js';
import glider from '../src/craft/glider.js';
import { CONFIG, WORLD_OPTIONS } from '../src/core/config.js';
import { DEG, vectorFromHeading, isFiniteVector, isFiniteQuaternion } from '../src/core/util.js';
import { EventBus } from '../src/core/eventBus.js';
import { attachTypedEvents } from '../src/core/events.js';
import { createWorldGen } from '../src/world/worldgen.js';
import { createFlightTelemetry } from '../src/flight/telemetry.js';
import { createControlState } from '../src/input/controlState.js';

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const V1_REFERENCE = join(TOOL_DIRECTORY, 'parity', 'v1', 'flight', 'arcadeFlight.js');
/** git blob id of src/flight/arcadeFlight.js at c571506 (the v1 port that passed v1 parity). */
const V1_BLOB_ID = '152e9803ce9387d34917a01e6995233ed3d62bad';

function parseArgs(argv) {
  const options = { suite: 'all', seed: 'PARITY', verbose: false };
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--suite') options.suite = argv[++index];
    else if (flag === '--seed') options.seed = argv[++index];
    else if (flag === '--verbose') options.verbose = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  if (!['model', 'controller', 'all'].includes(options.suite)) throw new Error(`Unknown suite ${options.suite}`);
  return options;
}

/** git's blob id (sha1 of "blob <size>\0<content>") so the check needs no git install. */
function gitBlobId(path) {
  const content = readFileSync(path);
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

// ---- Deterministic randomness -----------------------------------------------------------------
function mulberry32(seed) {
  let value = seed >>> 0;
  return function next() {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Frame times (s) for about `seconds` of play: steady, fast, slow, jittery, spiky and paused runs. */
function buildFrameTimes(seconds) {
  const random = mulberry32(0x5eed);
  const frames = [];
  let total = 0;
  const patterns = [
    () => 1 / 60,
    () => 1 / 144,
    () => 1 / 30,
    () => 1 / 40 + random() * (1 / 120 - 1 / 40),
    () => (random() < 0.08 ? 0.08 : 1 / 60),
    () => (random() < 0.2 ? 0.001 : 1 / 90),
    () => (random() < 0.05 ? 0 : 1 / 75),
  ];
  let patternIndex = 0;
  while (total < seconds) {
    const pattern = patterns[patternIndex % patterns.length];
    patternIndex++;
    const runLength = 60 + Math.floor(random() * 240);
    for (let frame = 0; frame < runLength && total < seconds; frame++) {
      const dt = pattern();
      frames.push(dt);
      total += dt;
    }
  }
  return frames;
}

// ---- Shared world and state stubs ----------------------------------------------------------------
function createUniforms() {
  const { uniform } = TSL;
  return {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.4, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    skyHorizonColor: uniform(new THREE.Color(0xf2c48e)),
    skyZenithColor: uniform(new THREE.Color(0x4f6fa8)),
    nightFactor: uniform(0),
  };
}

function createPlayer(spawn, world) {
  const player = {
    position: new THREE.Vector3(spawn.x, spawn.y, spawn.z),
    velocity: vectorFromHeading(spawn.heading).multiplyScalar(CONFIG.SPEED.CRUISE),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -spawn.heading * DEG),
    forward: vectorFromHeading(spawn.heading),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(),
    speed: CONFIG.SPEED.CRUISE,
    throttle: 0.55,
    heading: spawn.heading,
    pitch: 0,
    roll: 0,
    yawRate: 0,
    verticalSpeed: 0,
    gForce: 1,
    altitude: spawn.y,
    groundHeight: world.groundHeight(spawn.x, spawn.z),
    agl: spawn.y - world.groundHeight(spawn.x, spawn.z),
    stalled: false,
    boost: { active: false, remaining: 0, cooldown: 0, cooldownTotal: 6 },
    barrelRoll: { active: false, direction: 0, progress: 0 },
    autopilot: { enabled: false, heading: spawn.heading, altitude: spawn.y, followWaypoint: false },
    inCloud: 0,
  };
  player.right.set(1, 0, 0).applyQuaternion(player.quaternion);
  return player;
}

function createInput() {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttleDelta: 0,
    throttleTarget: null,
    boost: false,
    fineControl: false,
    mouseActive: false,
    lastActivity: 0,
    touch: { active: false, x: 0, y: 0, throttle: null, boost: false },
  };
}

/** One side of the comparison: its own world, state, input, bus and event log. */
function createSide(seed, spawn) {
  const world = createWorldGen(seed, WORLD_OPTIONS);
  const events = [];
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const originalEmit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    if (['stall', 'boost', 'barrelroll', 'autopilot:changed'].includes(type)) events.push(`${type} ${JSON.stringify(payload)}`);
    originalEmit(type, payload);
  };
  const state = {
    frame: 0,
    paused: false,
    photoMode: false,
    seed,
    time: { elapsed: 0, realElapsed: 0, frameDt: 0, nightFactor: 0, sunElevation: 14 },
    player: createPlayer(spawn, world),
    flight: createFlightTelemetry(),
    waypoint: null,
    ringCourse: { active: false, total: 0, passed: 0, streak: 0, bestStreak: 0, elapsed: 0, nextIndex: 0 },
  };
  const input = createInput();
  const cameraSnaps = { count: 0 };
  return { world, bus, events, state, input, uniforms: createUniforms(), scene: new THREE.Scene(), cameraSnaps };
}

/** v1 main.js enforceSafety: NaN recovery, terrain clamp and ceiling after every flight update. */
function createSafetyNet(side, flightSystem) {
  const { state, world } = side;
  const lastGood = {
    position: state.player.position.clone(),
    quaternion: state.player.quaternion.clone(),
    velocity: state.player.velocity.clone(),
    heading: state.player.heading,
  };
  return function enforceSafety() {
    const player = state.player;
    if (!isFiniteVector(player.position) || !isFiniteQuaternion(player.quaternion) || !isFiniteVector(player.velocity) || !Number.isFinite(player.speed)) {
      player.position.copy(lastGood.position);
      player.quaternion.copy(lastGood.quaternion);
      player.velocity.copy(lastGood.velocity);
      player.speed = Math.max(CONFIG.SPEED.STALL, lastGood.velocity.length());
      flightSystem.resetTo({ x: player.position.x, y: player.position.y, z: player.position.z, heading: lastGood.heading });
    } else {
      player.quaternion.normalize();
    }
    const ground = world.groundHeight(player.position.x, player.position.z);
    const floor = Math.max(ground + CONFIG.GROUND_CLEARANCE, CONFIG.WATER_LEVEL + CONFIG.WATER_CLEARANCE);
    if (player.position.y < floor) {
      player.position.y = floor;
      if (player.velocity.y < 0) player.velocity.y = 0;
    }
    if (player.position.y > CONFIG.MAX_ALTITUDE) {
      player.position.y = CONFIG.MAX_ALTITUDE;
      if (player.velocity.y > 0) player.velocity.y = 0;
    }
    player.groundHeight = ground;
    player.altitude = player.position.y;
    player.agl = player.position.y - Math.max(ground, CONFIG.WATER_LEVEL);
    lastGood.position.copy(player.position);
    lastGood.quaternion.copy(player.quaternion);
    lastGood.velocity.copy(player.velocity);
    if (Number.isFinite(player.heading)) lastGood.heading = player.heading;
  };
}

// ---- The script -------------------------------------------------------------------------------------
/**
 * Finds a start point for the terrain-assist dive: a spot about 40 m above ground with ground rising
 * steeply ahead (so urgency, cushion, rising-terrain and evade all engage).
 */
function findTerrainRun(world) {
  let best = null;
  for (let ring = 1; ring < 40; ring++) {
    for (let sample = 0; sample < 24; sample++) {
      const angle = (sample / 24) * Math.PI * 2;
      const x = Math.cos(angle) * ring * 600;
      const z = Math.sin(angle) * ring * 600;
      const here = world.groundHeight(x, z);
      if (here < 20) continue;
      for (let headingIndex = 0; headingIndex < 8; headingIndex++) {
        const heading = headingIndex * 45;
        const forward = vectorFromHeading(heading);
        const ahead = world.groundHeight(x + forward.x * 250, z + forward.z * 250);
        const rise = ahead - here;
        if (!best || rise > best.rise) best = { x, z, heading, rise, ground: here };
      }
    }
    if (best && best.rise > 160) break;
  }
  return best;
}

/**
 * Builds the timeline: returns apply(time, frameIndex, dt, sides, actions) which sets the input
 * struct for this frame on every side and runs one-shot actions through `actions` (called once per
 * side so both receive identical calls).
 */
function createScript(world, spawn) {
  const terrainRun = findTerrainRun(world);
  const random = mulberry32(0xc0ffee);
  const noiseTable = Array.from({ length: 4096 }, () => random() * 2 - 1);
  const oneShots = [];
  const at = (time, run) => oneShots.push({ time, run, done: false });

  // Controls by time window (seconds).
  function axesAt(time, frameIndex) {
    const controls = { pitch: 0, roll: 0, yaw: 0, throttleDelta: 0, fineControl: false };
    if (time >= 3 && time < 6) controls.pitch = 0.6;
    if (time >= 6 && time < 9) controls.roll = 1;
    if (time >= 9 && time < 11) {
      controls.roll = -0.7;
      controls.yaw = 1;
    }
    if (time >= 11 && time < 12.5) {
      controls.fineControl = true;
      controls.roll = 0.8;
      controls.pitch = -0.3;
    }
    if (time >= 16 && time < 18.5) controls.throttleDelta = -1;
    if (time >= 16.5 && time < 21) controls.pitch = 1;
    if (time >= 24 && time < 26) controls.throttleDelta = 1;
    if (time >= 26.2 && time < 33) controls.pitch = -1;
    if (time >= 30 && time < 31) controls.roll = 0.4;
    if (time >= 40 && time < 41) controls.pitch = 0.2;
    if (time >= 58 && time < 58.6) controls.roll = 1;
    if (time >= 59.2 && time < 63) controls.pitch = 1;
    if (time >= 66 && time < 75) {
      controls.pitch = noiseTable[frameIndex % 4096] * 0.9;
      controls.roll = noiseTable[(frameIndex * 7 + 13) % 4096];
      controls.yaw = noiseTable[(frameIndex * 3 + 101) % 4096] * 0.5;
      controls.fineControl = noiseTable[(frameIndex * 5 + 7) % 4096] > 0.6;
      controls.throttleDelta = noiseTable[(frameIndex * 11 + 3) % 4096] > 0.7 ? 1 : 0;
    }
    return controls;
  }

  at(12, (side, flight) => { side.input.boost = true; });
  at(13, (side, flight) => flight.barrelRoll(1));
  at(13.4, (side, flight) => flight.barrelRoll(-1));
  at(15, (side, flight) => flight.barrelRoll('left'));
  at(19.5, (side, flight) => { side.input.boost = true; });
  at(21, (side) => { side.input.throttleTarget = 0.8; });
  at(22, (side) => { side.input.pitch = Number.NaN; });
  at(26, (side, flight) => flight.resetTo({ x: terrainRun.x, y: terrainRun.ground + 40, z: terrainRun.z, heading: terrainRun.heading }));
  at(33.5, (side) => { side.state.player.quaternion.set(Number.NaN, 0, 0, 1); });
  at(34, (side, flight) => flight.setAutopilot({ enabled: true, heading: 120, altitude: 900 }));
  at(37, (side, flight) => flight.setAutopilot({ heading: 300 }));
  at(44, (side, flight) => {
    const player = side.state.player;
    side.state.waypoint = { x: player.position.x + 2500, z: player.position.z - 1800, label: 'parity waypoint' };
    flight.setAutopilot({ followWaypoint: true });
  });
  at(52, (side) => {
    const player = side.state.player;
    side.state.ringCourse = {
      active: true,
      total: 5,
      passed: 0,
      nextRingPosition: { x: player.position.x - 900, y: player.position.y + 60, z: player.position.z - 700 },
      nextRingNormal: { x: -0.8, y: 0, z: -0.6 },
    };
  });
  at(55, (side) => { side.input.throttleTarget = 0.35; });
  at(59, (side, flight) => {
    side.state.ringCourse = { active: false, total: 0, passed: 0 };
    side.state.waypoint = null;
    const player = side.state.player;
    flight.resetTo({ x: player.position.x, y: 2480, z: player.position.z, heading: 45 });
  });
  at(63.5, (side) => { side.state.photoMode = true; });
  at(64, (side, flight) => { side.results.push(`photo boost ${flight.boost()} roll ${flight.barrelRoll(1)}`); });
  at(64.5, (side) => { side.state.photoMode = false; });
  at(65, (side, flight) => flight.setAutopilot({ enabled: true }));
  at(66.5, (side) => { side.input.throttleTarget = 0.1; });
  at(70, (side, flight) => { side.input.boost = true; flight.barrelRoll(1); });

  return {
    terrainRun,
    /** Sets this frame's inputs and fires due one-shots on every side (identically). */
    apply(time, frameIndex, sides) {
      const axes = axesAt(time, frameIndex);
      for (const side of sides) {
        side.input.boost = false;
        side.input.pitch = axes.pitch;
        side.input.roll = axes.roll;
        side.input.yaw = axes.yaw;
        side.input.throttleDelta = axes.throttleDelta;
        side.input.fineControl = axes.fineControl;
        if (axes.throttleDelta !== 0) side.input.throttleTarget = null;
        side.state.player.inCloud = time > 45 && time < 50 ? 0.8 : 0;
      }
      for (const shot of oneShots) {
        if (shot.done || time < shot.time) continue;
        shot.done = true;
        for (const side of sides) shot.run(side, side.flight);
      }
    },
  };
}

// ---- Comparison ----------------------------------------------------------------------------------
function vectorFields(prefix, vector, out) {
  out[`${prefix}.x`] = vector.x;
  out[`${prefix}.y`] = vector.y;
  out[`${prefix}.z`] = vector.z;
  if ('w' in vector) out[`${prefix}.w`] = vector.w;
}

/** Every compared number / flag of one side at the end of a frame. */
function captureSide(side, pose) {
  const player = side.state.player;
  const out = {};
  vectorFields('position', player.position, out);
  vectorFields('quaternion', player.quaternion, out);
  vectorFields('velocity', player.velocity, out);
  vectorFields('forward', player.forward, out);
  vectorFields('up', player.up, out);
  vectorFields('right', player.right, out);
  for (const key of ['speed', 'throttle', 'heading', 'pitch', 'roll', 'verticalSpeed', 'yawRate', 'gForce', 'stalled']) out[key] = player[key];
  for (const key of ['active', 'remaining', 'cooldown', 'cooldownTotal']) out[`boost.${key}`] = player.boost[key];
  for (const key of ['active', 'direction', 'progress']) out[`barrelRoll.${key}`] = player.barrelRoll[key];
  for (const key of ['enabled', 'heading', 'altitude', 'followWaypoint']) out[`autopilot.${key}`] = player.autopilot[key];
  vectorFields('baseQuaternion', side.flight.getBaseQuaternion(), out);
  vectorFields('mesh.position', pose.root.position, out);
  vectorFields('mesh.quaternion', pose.root.quaternion, out);
  pose.surfaces.forEach((surface, index) => vectorFields(`surface${index}.quaternion`, surface.quaternion, out));
  out['prop.rotation'] = pose.prop.rotation.z;
  out.events = side.events.join('\n');
  out.results = side.results.join('\n');
  return out;
}

/** The control-surface pivots and prop of a glider mesh root, in build order. */
function meshParts(root) {
  const pivots = root.children.filter((child) => child.isGroup && child.userData.axis);
  const prop = root.children.find((child) => child.isGroup && !child.userData.axis);
  return { root, surfaces: pivots, prop };
}

function compareFrames(reference, candidate) {
  const mismatches = [];
  for (const [key, value] of Object.entries(reference)) {
    if (!Object.is(value, candidate[key])) mismatches.push({ key, v1: value, v2: candidate[key] });
  }
  return mismatches;
}

// ---- Suites ------------------------------------------------------------------------------------------
const SCRIPT_SECONDS = 75;

function createV1Side(seed, spawn) {
  const side = createSide(seed, spawn);
  side.results = [];
  const ctx = {
    THREE,
    TSL,
    scene: side.scene,
    state: side.state,
    input: side.input,
    bus: side.bus,
    world: side.world,
    uniforms: side.uniforms,
    systems: { camera: { snap() { side.cameraSnaps.count++; } } },
  };
  side.flight = createV1FlightSystem(ctx);
  side.safety = createSafetyNet(side, side.flight);
  side.parts = meshParts(side.flight.planeMesh);
  side.frame = (dt) => {
    side.flight.update(dt);
    side.safety();
    side.flight.syncVisual();
  };
  return side;
}

function createModelSide(seed, spawn) {
  const side = createSide(seed, spawn);
  side.results = [];
  const model = createArcadeModel({ profile: glider.arcadeProfile, world: side.world, bus: side.bus, state: side.state, input: side.input });
  const mesh = glider.buildMesh({ uniforms: side.uniforms });
  side.scene.add(mesh.root);
  const syncVisual = () => {
    mesh.root.position.copy(side.state.player.position).add(model.corkscrewOffset);
    mesh.root.quaternion.copy(side.state.player.quaternion).multiply(model.wobbleQuaternion);
  };
  side.flight = {
    barrelRoll: model.barrelRoll,
    boost: model.boost,
    setAutopilot: model.setAutopilot,
    getBaseQuaternion: model.getBaseQuaternion,
    resetTo(target) {
      const done = model.resetTo(target);
      if (done) {
        syncVisual();
        side.cameraSnaps.count++;
      }
      return done;
    },
  };
  side.safety = createSafetyNet(side, side.flight);
  side.parts = meshParts(mesh.root);
  syncVisual();
  side.frame = (dt) => {
    if (dt > 0) {
      model.step(dt, side.input);
      mesh.update(model.visual, Math.min(dt, 0.05));
      syncVisual();
    }
    side.safety();
    syncVisual();
  };
  return side;
}

/** Loaded on demand so the model suite runs on its own. */
const controllerModules = {};

function createControllerSide(seed, spawn) {
  const { createFlightController, flightModels, craftRegistry } = controllerModules;
  const side = createSide(seed, spawn);
  side.results = [];
  const zeroWind = { vel: new THREE.Vector3(), turbulence: 0 };
  const settingsValues = { mode: 'classic', craft: 'glider', startOnGround: false, assists: { glider: 1, bushplane: 1 } };
  const ctx = {
    THREE,
    TSL,
    scene: side.scene,
    state: side.state,
    input: side.input,
    controls: createControlState(),
    bus: side.bus,
    world: side.world,
    uniforms: side.uniforms,
    craftRegistry,
    flightModels,
    settings: {
      get: (key) => settingsValues[key],
      set(key, value) {
        settingsValues[key] = value;
        side.bus.emit('settings:changed', { key, value, settings: { ...settingsValues } });
        return true;
      },
    },
    wind: {
      sample(pos, t, out = { vel: new THREE.Vector3(), turbulence: 0 }) {
        out.vel.copy(zeroWind.vel);
        out.turbulence = 0;
        return out;
      },
      ambientAt: () => ({ speed: 0, fromDegrees: 0 }),
      lastLayers: { gust: new THREE.Vector3() },
    },
    systems: { camera: { snap() { side.cameraSnaps.count++; } } },
    registerPrewarm() {},
  };
  side.flight = createFlightController(ctx);
  ctx.systems.flight = side.flight;
  side.safety = createSafetyNet(side, side.flight);
  side.parts = meshParts(side.flight.planeMesh);
  side.frame = (dt) => {
    side.state.time.frameDt = dt;
    side.flight.update(dt, dt);
    side.safety();
    side.flight.publishTelemetry(dt);
    side.flight.syncVisual();
  };
  return side;
}

function runSuite(name, createCandidate, options) {
  const probeWorld = createWorldGen(options.seed, WORLD_OPTIONS);
  const spawn = { x: 0, y: Math.max(probeWorld.groundHeight(0, 0), 0) + 420, z: 0, heading: 30 };
  const reference = createV1Side(options.seed, spawn);
  const candidate = createCandidate(options.seed, spawn);
  const sides = [reference, candidate];
  const script = createScript(probeWorld, spawn);
  const frameTimes = buildFrameTimes(SCRIPT_SECONDS);
  const coverage = { stalled: 0, cushion: 0, evade: 0, ceiling: 0, barrelRoll: 0, boost: 0, autopilot: 0, pausedFrames: 0, clampedFrames: 0 };
  let time = 0;
  let firstFailure = null;
  let comparedValues = 0;
  for (let frameIndex = 0; frameIndex < frameTimes.length; frameIndex++) {
    const dt = frameTimes[frameIndex];
    script.apply(time, frameIndex, sides);
    for (const side of sides) {
      side.state.frame++;
      side.state.time.elapsed += dt;
      side.frame(dt);
    }
    time += dt;
    const referenceFrame = captureSide(reference, reference.parts);
    const candidateFrame = captureSide(candidate, candidate.parts);
    comparedValues += Object.keys(referenceFrame).length;
    const mismatches = compareFrames(referenceFrame, candidateFrame);
    if (mismatches.length > 0) {
      firstFailure = { frameIndex, time, dt, mismatches: mismatches.slice(0, 12) };
      break;
    }
    const player = reference.state.player;
    const stats = reference.flight.getStats();
    if (player.stalled) coverage.stalled++;
    if (stats.cushion > 0) coverage.cushion++;
    if (player.barrelRoll.active) coverage.barrelRoll++;
    if (player.boost.active) coverage.boost++;
    if (player.autopilot.enabled) coverage.autopilot++;
    if (player.position.y > CONFIG.MAX_ALTITUDE - 260) coverage.ceiling++;
    if (Math.abs(stats.baseBank) > 40 && stats.cushion > 0.2) coverage.evade++;
    if (dt === 0) coverage.pausedFrames++;
    if (dt > 0.05) coverage.clampedFrames++;
  }
  const events = reference.events.length;
  return { name, passed: firstFailure === null && reference.events.length > 0, frames: frameTimes.length, seconds: time, comparedValues, events, coverage, firstFailure, cameraSnaps: [reference.cameraSnaps.count, candidate.cameraSnaps.count], terrainRun: script.terrainRun };
}

async function main() {
  const options = parseArgs(process.argv);
  const blobId = gitBlobId(V1_REFERENCE);
  const referenceIntact = blobId === V1_BLOB_ID;
  process.stdout.write(`v1 reference ${V1_REFERENCE}\n  blob ${blobId} ${referenceIntact ? 'matches' : 'DOES NOT MATCH'} src/flight/arcadeFlight.js@c571506 (${V1_BLOB_ID})\n`);
  const suites = options.suite === 'all' ? ['model', 'controller'] : [options.suite];
  const factories = { model: createModelSide, controller: createControllerSide };
  if (suites.includes('controller')) {
    await import('../src/craft/index.js');
    Object.assign(controllerModules, await import('../src/flight/FlightController.js'), await import('../src/flight/models.js'), await import('../src/craft/registry.js'));
  }
  let allPassed = referenceIntact;
  for (const suite of suites) {
    const result = runSuite(suite, factories[suite], options);
    allPassed = allPassed && result.passed;
    process.stdout.write(`\n[${suite}] ${result.passed ? 'PASS' : 'FAIL'}: ${result.frames} frames, ${result.seconds.toFixed(2)} s of flight, ${result.comparedValues} values compared bit for bit, ${result.events} bus events matched\n`);
    process.stdout.write(`  coverage (frames): ${JSON.stringify(result.coverage)}\n`);
    process.stdout.write(`  camera snaps v1/v2: ${result.cameraSnaps.join('/')}\n`);
    if (options.verbose) process.stdout.write(`  terrain run: ${JSON.stringify(result.terrainRun)}\n`);
    if (result.firstFailure) {
      process.stdout.write(`  first mismatch at frame ${result.firstFailure.frameIndex} (t=${result.firstFailure.time.toFixed(3)} s, dt=${result.firstFailure.dt}):\n`);
      for (const mismatch of result.firstFailure.mismatches) process.stdout.write(`    ${mismatch.key}: v1=${mismatch.v1} v2=${mismatch.v2}\n`);
    }
  }
  process.stdout.write(`\n${allPassed ? 'PASS' : 'FAIL'}: arcade parity (${suites.join(', ')})\n`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`arcade parity failed to run: ${error.stack ?? error}
`);
  process.exit(2);
});
