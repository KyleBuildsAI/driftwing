// Fauna modes lab (contract e.3): the FaunaEngine's ground and water-surface behaviours (herd,
// column, surface) headless in node, inside a real SpawnManager, on a stub world: a plain with a
// steep ridge to the east and a lake behind a steep bank to the west, a shallow lagoon, and the open
// sea with a swell (a stub ctx.game.waterQuery, as the water engineer's query will provide).
//
// Tests:
//   herd         a bison herd grazing for two minutes, through timer stampedes toward the lake and the
//                ridge: no animal ever stands on ground steeper than the slope limit or in water
//   stampede     the player buzzing the herd starts a stampede (fauna:stampede): the herd runs, raises
//                dust, and settles back to a walk after its duration; the cooldown holds; setParam
//                'stampede' (the event trigger) starts one; an eagle (faunaThreat 2.5) starts one from
//                farther away than a glider does
//   column       a caribou column on an 'auto' path walks the planned route (around the ridge and the
//                lake), in its lanes, standing on the ground, moving with flight time; the same flight
//                time gives the same column in another manager (determinism)
//   flamingos    wading in the lagoon's shallows; buzzed, they take off in a wave (later the farther
//                from the craft), fly as a flock and settle back into the shallows
//   dolphins     swimming on the swell (the water query's height at their position), porpoising with
//                splashes, and racing toward the craft's shadow when it flies low over the water
//   validation   bad params are refused naming the field (species and behaviour kinds, altitude mode,
//                slope limit, column path, surface params)
//   allocation   after a warm-up, 100 000 frames of a herd, a column, dolphins and flamingos allocate
//                nothing
//
// Usage: node --expose-gc tools/lab/fauna-modes.mjs [--verbose]
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';
import { validatePreset } from '../../src/spawns/schema.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};

// ---- Stub world -------------------------------------------------------------------------------------
const SLOPE_LIMIT = 0.45;
const LAGOON = Object.freeze({ x: 6000, z: 0, radius: 320 });
const SEA_Z = 9000;
function smooth(edge0, edge1, value) {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
function groundHeight(x, z) {
  // The open sea to the north (z beyond SEA_Z - 400 falls to -40).
  if (z > SEA_Z - 600) return 40 - smooth(SEA_Z - 600, SEA_Z - 200, z) * 80;
  // The lagoon: a flat bottom 0.3 m under the water, deeper rim.
  const lagoonX = x - LAGOON.x;
  const lagoonZ = z - LAGOON.z;
  const lagoonDistance = Math.sqrt(lagoonX * lagoonX + lagoonZ * lagoonZ);
  if (lagoonDistance < LAGOON.radius + 200) {
    if (lagoonDistance < LAGOON.radius) return -0.3;
    return -0.3 + smooth(LAGOON.radius, LAGOON.radius + 200, lagoonDistance) * 40.3;
  }
  // The plain at 40 m with gentle swells, a steep ridge east (x 300..360) and a steep bank down to
  // a lake west (x < -260).
  let height = 40 + 3 * Math.sin(x * 0.011) * Math.cos(z * 0.009);
  height += smooth(300, 360, x) * 90;
  if (x < -200) height -= smooth(-200, -260, x) * 45;
  return height;
}
const BIOME = Object.freeze({ key: 'meadows', name: 'Meadows' });
const world = {
  seedHash: 4321,
  WATER_LEVEL: 0,
  heightAt: groundHeight,
  groundHeight,
  biomeAt: () => BIOME,
  hash2(x, z, salt) {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  },
};

/** The true slope at (x, z): the steeper of the x and z rises over 6 m. */
function trueSlope(x, z) {
  return Math.max(Math.abs(groundHeight(x + 3, z) - groundHeight(x - 3, z)) / 6, Math.abs(groundHeight(x, z + 3) - groundHeight(x, z - 3)) / 6);
}

function createLab({ craft = 'glider' } = {}) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 9000);
  camera.position.set(0, 300, 600);
  camera.updateMatrixWorld();
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.8, -0.5).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    nightFactor: uniform(0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1),
  };
  const state = {
    seed: 'LAB',
    frame: 0,
    time: { elapsed: 0, sunElevation: 40, dayTime: 0.4, nightFactor: 0, goldenFactor: 0, sunDirection: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
    player: { position: new THREE.Vector3(0, 300, 600), velocity: new THREE.Vector3(0, 0, -40), forward: new THREE.Vector3(0, 0, -1), heading: 0 },
    flight: { craft },
  };
  // The shared water query: sea level with a swell over the open sea, still elsewhere.
  const swellAt = (x, z, time) => 0.6 * Math.sin(x * 0.05 + time * 0.8) + 0.4 * Math.sin(z * 0.07 - time * 0.6);
  const waterQuery = {
    heightAt(x, z, time = state.time.elapsed) {
      if (groundHeight(x, z) >= 0) return -Infinity;
      return z > SEA_Z - 600 ? swellAt(x, z, time) : 0;
    },
    isWater(x, z) {
      return groundHeight(x, z) < 0;
    },
  };
  const craftRegistry = { get: (id) => (id === 'eagle' ? { faunaThreat: 2.5 } : { faunaThreat: undefined }) };
  // A water effects layer that counts what the animals send it.
  const splashes = { splash: 0, trail: 0, spray: 0 };
  const water = {
    activeVortices: 0,
    createMark: () => ({ x: 0, z: 0, x1: 0, z1: 0, radius: 0, foam: 0, glow: 0, strength: 0 }),
    createSpray: () => ({ x: 0, y: 0, z: 0, count: 0, speed: 0, inheritX: 0, inheritZ: 0 }),
    splashMark: () => { splashes.splash++; },
    trail: () => { splashes.trail++; },
    emitSpray: () => { splashes.spray++; },
    surfaceHeightAt: () => 0,
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const memory = { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 };
  const registry = createEngineRegistry();
  const game = { waterQuery, craftRegistry, systems: {} };
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGPU', wind, audio: null, world, state, sky: null,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB', water, game,
  });
  const fauna = manager.register(createFaunaEngine());
  manager.init();
  const events = { stampede: [], flush: [], race: [] };
  bus.on('fauna:stampede', (payload) => events.stampede.push({ ...payload, time: state.time.elapsed }));
  bus.on('fauna:flush', (payload) => events.flush.push({ ...payload, time: state.time.elapsed }));
  bus.on('fauna:race', (payload) => events.race.push({ ...payload, time: state.time.elapsed }));
  // The fixed clock lives in typed arrays (a closure variable holding a double boxes on every write).
  const clock = new Float64Array(1);
  function step(frames = 1, dt = 1 / 60, after = null) {
    for (let frame = 0; frame < frames; frame++) {
      state.frame++;
      state.time.elapsed += dt;
      manager.update(dt, dt);
      if (after) after(frame);
    }
  }
  function addPreset(id, params, extra = {}) {
    const preset = Object.freeze({
      id, name: id, category: 'wildlife', kind: 'event', rarity: 'common', heavy: false,
      candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.1 }),
      filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
      engines: Object.freeze([Object.freeze({ engine: 'fauna', params: Object.freeze(params) })]),
      lod: Object.freeze({ near: 2500, mid: 6000, far: 14000 }), lure: null, wind: Object.freeze([]), audio: null,
      journal: Object.freeze({ title: id, description: 'A fauna modes lab fixture.' }),
      discovery: Object.freeze({ radius: 800, requireInView: true }),
      callouts: Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Lab: {name}.']),
      lifetime: Object.freeze({ duration: Object.freeze([extra.duration ?? 3000, extra.duration ?? 3000]), despawn: Object.freeze({ distance: 30000, hysteresis: 2000, outOfViewSeconds: 3000 }) }),
      achievements: Object.freeze([]),
    });
    validatePreset(preset);
    manager.addPreset(preset);
    return preset;
  }
  function spawn(id, params, position, heading = 0, extra = {}) {
    if (!manager.getPreset(id)) addPreset(id, params, extra);
    const spawnId = manager.activate(id, { position, heading, source: 'debug', force: true });
    if (!spawnId) throw new Error(`fauna-modes lab: ${id} was refused (${JSON.stringify(manager.getStats().refusals)})`);
    return spawnId;
  }
  function data(spawnId) {
    return manager.getParts(spawnId)[0].data;
  }
  /** Keeps the camera (the LOD and the agents' floating origin) with the player. */
  function follow() {
    camera.position.copy(state.player.position);
    camera.updateMatrixWorld();
  }
  return { bus, scene, camera, state, manager, fauna, events, splashes, waterQuery, step, spawn, addPreset, data, follow, clock, game };
}

function agents(lab, spawnId) {
  const data = lab.data(spawnId);
  const list = [];
  for (let index = data.start; index < data.start + data.count; index++) {
    list.push({ index, x: data.pool.px[index], y: data.pool.py[index], z: data.pool.pz[index], mode: data.pool.mode[index], scale: data.pool.scale[index] });
  }
  return list;
}

// ---- herd -------------------------------------------------------------------------------------------
function testHerd() {
  const lab = createLab();
  lab.state.player.position.set(0, 600, 300);
  lab.follow();
  const id = lab.spawn('labHerd', {
    species: 'bison', behavior: 'herd', count: 40, leash: 250,
    herd: { slopeLimit: SLOPE_LIMIT, waterMargin: 8, stampede: { trigger: 'timer', interval: 25, duration: 14, cooldown: 2 } },
  }, { x: -110, y: 0, z: 0 }, 270);
  let worstSlope = 0;
  let wet = 0;
  let samples = 0;
  let worstFloat = 0;
  let westmost = Infinity;
  let eastmost = -Infinity;
  const frames = 60 * 130;
  lab.step(frames, 1 / 60, (frame) => {
    if (frame % 6 !== 0) return;
    for (const agent of agents(lab, id)) {
      samples++;
      worstSlope = Math.max(worstSlope, trueSlope(agent.x, agent.z));
      if (groundHeight(agent.x, agent.z) < 0) wet++;
      worstFloat = Math.max(worstFloat, Math.abs(agent.y - groundHeight(agent.x, agent.z)));
      westmost = Math.min(westmost, agent.x);
      eastmost = Math.max(eastmost, agent.x);
    }
  });
  const description = lab.fauna.describe(id);
  check('herd', 'the herd lives on (no refusal) and spans the plain', description && description.count === 40 && !description.hidden, JSON.stringify(description?.center));
  check('herd', `two minutes and ${lab.events.stampede.length} timer stampedes: never on a slope over the limit`, lab.events.stampede.length >= 3 && worstSlope <= SLOPE_LIMIT + 0.05, `worst ${worstSlope.toFixed(3)} (limit ${SLOPE_LIMIT}), ${samples} samples`);
  check('herd', 'the herd came up to the steep bank above the lake (its top at x = -200) and kept off it', westmost < -170, `westmost animal x = ${westmost.toFixed(1)}, eastmost ${eastmost.toFixed(1)}`);
  check('herd', 'never in water', wet === 0, `${wet} wet samples`);
  check('herd', 'every animal stands on the ground (fine grid within 0.6 m of the terrain)', worstFloat < 0.6, `worst ${worstFloat.toFixed(3)} m`);
  lab.manager.deactivate(id, 'lab');
}

// ---- stampede -----------------------------------------------------------------------------------------
function testStampede() {
  const lab = createLab();
  lab.state.player.position.set(0, 900, 2000);
  lab.follow();
  const id = lab.spawn('labStampede', {
    species: 'bison', behavior: 'herd', count: 30,
    herd: { stampede: { trigger: 'player', radius: 260, duration: 12, cooldown: 30, maxAltitude: 300 } },
  }, { x: 60, y: 0, z: 0 }, 0);
  lab.step(360);
  check('stampede', 'calm at first: walking pace, no stampede', !lab.fauna.describe(id).stampede && lab.events.stampede.length === 0, JSON.stringify(lab.fauna.describe(id)));
  // The player buzzes the herd low from the south.
  const center = lab.fauna.describe(id).center;
  lab.state.player.position.set(center.x, center.y + 60, center.z + 200);
  lab.follow();
  lab.step(3);
  check('stampede', 'buzzing the herd starts a stampede (fauna:stampede, trigger player)', lab.events.stampede.length === 1 && lab.events.stampede[0].trigger === 'player' && lab.fauna.describe(id).stampede, JSON.stringify(lab.events.stampede));
  lab.state.player.position.set(center.x, center.y + 900, center.z + 1500);
  lab.follow();
  let topGait = 0;
  let topDust = 0;
  lab.step(60 * 6, 1 / 60, () => {
    const now = lab.fauna.describe(id);
    topGait = Math.max(topGait, now.gait);
    topDust = Math.max(topDust, now.dust);
  });
  check('stampede', 'the herd runs and raises dust', topGait > 0.7 && topDust > 20, `gait ${topGait.toFixed(2)}, dust puffs ${topDust}`);
  lab.step(60 * 20);
  const settled = lab.fauna.describe(id);
  check('stampede', 'after its duration the herd settles back to a walk', !settled.stampede && settled.gait < 0.12, JSON.stringify({ stampede: settled.stampede, gait: settled.gait }));
  const afterCenter = settled.center;
  lab.state.player.position.set(afterCenter.x, afterCenter.y + 60, afterCenter.z + 150);
  lab.follow();
  lab.step(30);
  check('stampede', 'the cooldown holds a second buzz off', lab.events.stampede.length === 1, String(lab.events.stampede.length));
  const parts = lab.manager.getParts(id)[0];
  check('stampede', "setParam 'stampede' (the event trigger) starts one; unknown params are refused", lab.fauna.setParam(parts, 'stampede', 1) && lab.events.stampede.at(-1).trigger === 'event' && !lab.fauna.setParam(parts, 'flush', 1), JSON.stringify(lab.events.stampede.at(-1)));
  lab.manager.deactivate(id, 'lab');
  // Predators: an eagle starts a stampede from farther away (radius x sqrt(2.5)).
  const reaches = {};
  for (const craft of ['glider', 'eagle']) {
    const test = createLab({ craft });
    test.state.player.position.set(0, 900, 2000);
    test.follow();
    const herd = test.spawn('labThreat', { species: 'bison', behavior: 'herd', count: 12, herd: { stampede: { trigger: 'player', radius: 200, maxAltitude: 300 } } }, { x: 60, y: 0, z: 0 }, 0);
    test.step(360);
    const c = test.fauna.describe(herd).center;
    test.state.player.position.set(c.x, c.y + 50, c.z + 260);
    test.follow();
    test.step(3);
    reaches[craft] = test.events.stampede.length;
    reaches[`${craft}Threat`] = test.fauna.stats().threat;
  }
  check('stampede', 'faunaThreat: an eagle (2.5) at 260 m starts the herd, a glider does not', reaches.eagle === 1 && reaches.glider === 0 && reaches.eagleThreat === 2.5 && reaches.gliderThreat === 1, JSON.stringify(reaches));
}

// ---- column ---------------------------------------------------------------------------------------------
function runColumn(lab) {
  lab.state.player.position.set(0, 800, 900);
  lab.follow();
  return lab.spawn('labColumn', { species: 'caribou', behavior: 'column', count: 80, column: { path: 'auto', length: 1800, lanes: 2, spacing: 5, laneWidth: 3 } }, { x: 0, y: 0, z: 200 }, 0);
}

function testColumn() {
  const lab = createLab();
  const id = runColumn(lab);
  const data = lab.data(id);
  check('column', "an 'auto' path is planned across the plain (between the ridge and the lake)", data.path && data.path.length > 1500, `path ${data.path ? data.path.length.toFixed(0) : 'none'} m`);
  const before = { ...lab.fauna.describe(id).center };
  let worstOffPath = 0;
  let worstGround = 0;
  let wet = 0;
  let worstSlope = 0;
  lab.step(60 * 40, 1 / 60, (frame) => {
    if (frame % 30 !== 0) return;
    for (const agent of agents(lab, id)) {
      const along = data.path.nearestDistance(agent.x, agent.y, agent.z);
      const point = data.path.sampleAt(along, { x: 0, y: 0, z: 0 });
      worstOffPath = Math.max(worstOffPath, Math.hypot(agent.x - point.x, agent.z - point.z));
      worstGround = Math.max(worstGround, Math.abs(agent.y - groundHeight(agent.x, agent.z)));
      worstSlope = Math.max(worstSlope, trueSlope(agent.x, agent.z));
      if (groundHeight(agent.x, agent.z) < 0) wet++;
    }
  });
  const after = lab.fauna.describe(id).center;
  check('column', 'the walkers keep to their lanes along the path', worstOffPath < 3 * 0.5 + 0.6 * 1.5 + 0.6, `worst ${worstOffPath.toFixed(2)} m off the path`);
  check('column', 'they stand on the ground, never in water, never on steep ground', worstGround < 1.2 && wet === 0 && worstSlope <= SLOPE_LIMIT + 0.08, `ground ${worstGround.toFixed(2)} m, ${wet} wet, slope ${worstSlope.toFixed(3)}`);
  check('column', 'the column moves along with flight time', Math.hypot(after.x - before.x, after.z - before.z) > 30, `${Math.hypot(after.x - before.x, after.z - before.z).toFixed(1)} m in 40 s`);
  // Determinism: another manager at the same flight time places the same column.
  const twin = createLab();
  const twinId = runColumn(twin);
  twin.step(60 * 40);
  const first = agents(lab, id);
  const second = agents(twin, twinId);
  const same = first.length === second.length && first.every((agent, index) => agent.x === second[index].x && agent.z === second[index].z);
  check('column', 'the same flight time gives the same column (determinism)', same, `${first.length} walkers`);
}

// ---- flamingos ---------------------------------------------------------------------------------------------
function testFlamingos() {
  const lab = createLab();
  lab.state.player.position.set(LAGOON.x, 700, LAGOON.z + 1500);
  lab.follow();
  const id = lab.spawn('labFlamingos', {
    species: 'flamingo', behavior: 'surface', count: 30,
    surface: { wade: { depthMax: 0.6, flushRadius: 140, flySeconds: [28, 34], takeoffWave: { delay: 0.5, spread: 0.3 } } },
  }, { x: LAGOON.x + 40, y: 0, z: LAGOON.z }, 0);
  lab.step(120);
  const standing = agents(lab, id);
  const shallow = standing.every((agent) => {
    const ground = groundHeight(agent.x, agent.z);
    return ground < 0 && -ground < 0.6;
  });
  check('flamingos', 'they wade: all standing in the shallows', lab.fauna.describe(id).airborne === 0 && shallow, JSON.stringify(lab.fauna.describe(id)));
  // The craft comes in low from the south and passes over the flock.
  const center = lab.fauna.describe(id).center;
  const takeoff = new Map();
  const data = lab.data(id);
  let flushedAt = null;
  for (let frame = 0; frame < 60 * 14; frame++) {
    const t = frame / 60;
    lab.state.player.position.set(center.x, center.y + 25, center.z + 400 - t * 45);
    lab.follow();
    lab.step(1);
    if (lab.events.flush.length > 0 && flushedAt === null) flushedAt = { x: lab.state.player.position.x, z: lab.state.player.position.z };
    for (let index = data.start; index < data.start + data.count; index++) {
      if (!takeoff.has(index) && data.pool.mode[index] !== 0) takeoff.set(index, lab.state.time.elapsed);
    }
  }
  check('flamingos', 'buzzed: fauna:flush and every bird takes off', lab.events.flush.length === 1 && takeoff.size === 30, `${takeoff.size} took off, ${lab.events.flush.length} flush events`);
  // The wave: take-off time grows with the distance from the craft at the flush.
  const pairs = [...takeoff.entries()].map(([index, time]) => ({ time, distance: Math.hypot(standing[index - data.start].x - flushedAt.x, standing[index - data.start].z - flushedAt.z) }));
  const meanTime = pairs.reduce((sum, pair) => sum + pair.time, 0) / pairs.length;
  const meanDistance = pairs.reduce((sum, pair) => sum + pair.distance, 0) / pairs.length;
  let covariance = 0;
  let varianceTime = 0;
  let varianceDistance = 0;
  for (const pair of pairs) {
    covariance += (pair.time - meanTime) * (pair.distance - meanDistance);
    varianceTime += (pair.time - meanTime) ** 2;
    varianceDistance += (pair.distance - meanDistance) ** 2;
  }
  const correlation = covariance / Math.sqrt(varianceTime * varianceDistance);
  const spreadSeconds = Math.max(...pairs.map((pair) => pair.time)) - Math.min(...pairs.map((pair) => pair.time));
  check('flamingos', 'they take off in a wave: later the farther from the craft', correlation > 0.6 && spreadSeconds > 0.8, `correlation ${correlation.toFixed(2)}, wave ${spreadSeconds.toFixed(2)} s`);
  check('flamingos', 'the take-off runs splash the water', lab.splashes.trail > 10, `${lab.splashes.trail} trail marks`);
  lab.state.player.position.set(center.x + 3000, 900, center.z + 3000);
  lab.follow();
  let topAltitude = 0;
  lab.step(60 * 8, 1 / 60, () => {
    for (const agent of agents(lab, id)) topAltitude = Math.max(topAltitude, agent.y);
  });
  check('flamingos', 'they fly as a flock over the water', lab.fauna.describe(id).airborne === 30 && topAltitude > 25, `aloft ${lab.fauna.describe(id).airborne}, top ${topAltitude.toFixed(1)} m`);
  lab.step(60 * 90);
  const back = agents(lab, id);
  const backShallow = back.every((agent) => groundHeight(agent.x, agent.z) < 0 && groundHeight(agent.x, agent.z) > -0.6);
  check('flamingos', 'and settle back into the shallows', lab.fauna.describe(id).airborne === 0 && backShallow, JSON.stringify(lab.fauna.describe(id)));
  lab.manager.deactivate(id, 'lab');
}

// ---- dolphins -------------------------------------------------------------------------------------------------
function testDolphins() {
  const lab = createLab();
  lab.state.player.position.set(0, 600, SEA_Z + 1500);
  lab.follow();
  const id = lab.spawn('labDolphins', {
    species: 'dolphin', behavior: 'surface', count: 6,
    surface: { porpoise: { height: 2, interval: [2, 4] }, raceShadow: { radius: 900, boost: 1.8, maxAltitude: 200 } },
  }, { x: 0, y: 0, z: SEA_Z + 600 }, 90);
  let worstSwell = 0;
  let swimSamples = 0;
  let leaps = 0;
  const data = lab.data(id);
  lab.step(60 * 30, 1 / 60, (frame) => {
    leaps = Math.max(leaps, lab.fauna.describe(id).leaping);
    if (frame % 5 !== 0) return;
    for (let index = data.start; index < data.start + data.count; index++) {
      // Swimming, and past the dive after a splash-down (aux2: seconds since it).
      if (data.pool.mode[index] !== 0 || data.pool.aux2[index] < 1.5) continue;
      const surface = lab.waterQuery.heightAt(data.pool.px[index], data.pool.pz[index]);
      const expected = surface - 0.25 * data.pool.scale[index] * data.g[49];
      worstSwell = Math.max(worstSwell, Math.abs(data.pool.py[index] - expected));
      swimSamples++;
    }
  });
  check('dolphins', 'they swim on the swell (within 0.45 m of the water query surface)', swimSamples > 100 && worstSwell < 0.45, `worst ${worstSwell.toFixed(3)} m over ${swimSamples} samples`);
  check('dolphins', 'they porpoise, splashing', leaps > 0 && lab.splashes.splash > 4, `up to ${leaps} in the air, ${lab.splashes.splash} splashes`);
  // The craft flies low over the sea 400 m from the pod, slowly: the pod races its shadow.
  const center = lab.fauna.describe(id).center;
  const shadowGap = () => {
    const now = lab.fauna.describe(id).center;
    return Math.hypot(now.x - lab.data(id).g[63], now.z - lab.data(id).g[64]);
  };
  lab.state.player.position.set(center.x + 400, 60, center.z);
  lab.follow();
  lab.step(30);
  const gapBefore = shadowGap();
  lab.step(60 * 40, 1 / 60, () => {
    lab.state.player.position.x += 0.01;
    lab.follow();
  });
  const gapAfter = shadowGap();
  check('dolphins', 'flying low over the water, the pod races toward the craft\'s shadow', lab.events.race.some((event) => event.racing) && lab.fauna.describe(id).racing && gapAfter < gapBefore * 0.5, `gap ${gapBefore.toFixed(0)} m -> ${gapAfter.toFixed(0)} m, events ${JSON.stringify(lab.events.race.map((event) => event.racing))}`);
  lab.manager.deactivate(id, 'lab');
}

// ---- validation -------------------------------------------------------------------------------------------------
function testValidation() {
  const lab = createLab();
  const cases = [
    ['a bird in a herd', { species: 'goose', behavior: 'herd' }, /params\.species must be a quadruped/],
    ['a quadruped in a flock', { species: 'bison', behavior: 'flock' }, /params\.behavior must be herd or column/],
    ['the ground mode for a flock', { species: 'starling', behavior: 'flock', altitude: { mode: 'ground' } }, /altitude\.mode ground is for herd and column/],
    ['an unknown altitude mode', { species: 'starling', behavior: 'flock', altitude: { mode: 'orbit' } }, /altitude\.mode must be one of/],
    ['a negative slope limit', { species: 'bison', behavior: 'herd', herd: { slopeLimit: -1 } }, /herd\.slopeLimit/],
    ['gaits out of order', { species: 'bison', behavior: 'herd', herd: { gaits: { walk: 5, trot: 3, run: 9 } } }, /herd\.gaits/],
    ['an unknown stampede trigger', { species: 'bison', behavior: 'herd', herd: { stampede: { trigger: 'noise' } } }, /herd\.stampede\.trigger/],
    ['a bad column path', { species: 'caribou', behavior: 'column', column: { path: { points: [[0, 0]] } } }, /column\.path/],
    ['a bison on the surface', { species: 'bison', behavior: 'surface' }, /params\.(species|behavior)/],
    ['a dolphin race boost below 1', { species: 'dolphin', behavior: 'surface', surface: { raceShadow: { boost: 0.5 } } }, /surface\.raceShadow\.boost/],
  ];
  cases.forEach(([label, params, pattern], index) => {
    const id = `labBad${index}`;
    const before = consoleErrors.length;
    lab.addPreset(id, params);
    const spawnId = lab.manager.activate(id, { position: { x: 0, y: 0, z: 0 }, heading: 0, source: 'debug', force: true });
    const refused = spawnId === null;
    const message = consoleErrors.slice(before).join(' ');
    check('validation', `refused: ${label}`, refused && pattern.test(message), message.slice(0, 160));
  });
}

// ---- allocation ---------------------------------------------------------------------------------------------------
/** Young-generation bytes per frame over 100 000 frames after a 150 000-frame warm-up, and the GCs seen. */
async function measureFrames(lab) {
  const frame = () => lab.step(1);
  for (let index = 0; index < 150000; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const before = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const after = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  return { perFrame: (after - before) / frames, collections };
}

async function testAllocation() {
  // The baseline: the Phase 2 engine's own per-group cost (its rationed ground probes and the
  // SpawnManager's bookkeeping) with one wandering flock.
  const baselineLab = createLab();
  baselineLab.state.player.position.set(2000, 1500, 4000);
  baselineLab.follow();
  baselineLab.spawn('allocFlock', { species: 'starling', behavior: 'flock', count: 40 }, { x: 0, y: 0, z: 0 }, 0);
  const baseline = await measureFrames(baselineLab);
  const lab = createLab();
  lab.state.player.position.set(2000, 1500, 4000);
  lab.follow();
  lab.spawn('allocHerd', { species: 'bison', behavior: 'herd', count: 40, herd: { stampede: { trigger: 'event' } } }, { x: 0, y: 0, z: 0 }, 0);
  lab.spawn('allocColumn', { species: 'caribou', behavior: 'column', count: 60, column: { path: 'auto', length: 1500, mode: 'pingpong' } }, { x: 0, y: 0, z: 600 }, 0);
  lab.spawn('allocDolphins', { species: 'dolphin', behavior: 'surface', count: 6, surface: { raceShadow: { radius: 1 } } }, { x: 0, y: 0, z: SEA_Z + 600 }, 90);
  lab.spawn('allocWaders', { species: 'flamingo', behavior: 'surface', count: 24, surface: { wade: { flushRadius: 1 } } }, { x: LAGOON.x, y: 0, z: LAGOON.z }, 0);
  check('allocation', 'four groups live (herd, column, dolphins, flamingos)', lab.manager.getStats().spawns === 4, String(lab.manager.getStats().spawns));
  // Warm-up covers every branch the measure takes (leaps, the column's turn-around, grazing and walking).
  const measured = await measureFrames(lab);
  check('allocation', `no garbage collection during 100 000 frames of the four groups`, measured.collections === 0 && baseline.collections === 0, `${measured.collections} collections (baseline ${baseline.collections})`);
  // Per group, the new modes cost no more than a Phase 2 group (its rationed probes: a terrain or
  // water height comes back as a double), within half a byte a frame.
  const perGroup = measured.perFrame / 4;
  check('allocation', 'per group and frame, the new modes allocate no more than a Phase 2 group (within 0.5 B)', perGroup <= baseline.perFrame + 0.5, `${perGroup.toFixed(3)} B per group per frame, Phase 2 flock ${baseline.perFrame.toFixed(3)} B`);
}

await testAllocation();
testHerd();
testStampede();
testColumn();
testFlamingos();
testDolphins();
testValidation();

const unexpected = consoleErrors.filter((line) => !/failed to create|params\./.test(line));
check('console', 'no unexpected console errors', unexpected.length === 0, unexpected.join(' | ').slice(0, 400));
console.error = originalError;

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
