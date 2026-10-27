// Presets 71-80 lab (wave 3, batch 8): the batch's real presets headless in node, on a stub world of
// gentle hills with each site's real stamps resolved and applied, through the real SpawnManager and
// engines (structure, windModifier, weatherVolume, emitter, waterEffect, lightEffect, fauna), the real
// WindField, collider service and challenge system.
//
// Tests:
//   schema       every preset validates with the game's presets; tags, challenge blocks and audio
//                recipes are known; every preset has its journal entry and 3+ callouts
//   sites        each site preset builds on its stamped test site: colliders registered with the
//                instance, the challenge course registered with its gates, the same site builds the
//                same geometry twice
//   reverse      the reverse waterfall: rising water ribbons and mist, an updraft column at the water
//                column (>= 8 m/s at mid height), none away from it
//   wisps        the forest wisps wait, trail the craft once it comes near, then lead toward the
//                nearest undiscovered site, hold while the craft lags, gather there, and their frame
//                update allocates nothing
//   ridge        the band's own lift along the crest (the field less the same field before it), none
//                well off the axis
//   shear        the shear line: across the cloud edge the wind veers 40+ degrees and speeds up 1.5x
//   street       the thermal street: lift under every cloud of both rows, sink or calm between rows
//   canyon       the canyon gauntlet's gates stand on the carve's floor path, inside its walls, framed
//                by pillar hulls; the opening is clear of every collider
//   cave         the cave tunnel's mountain is one closed mesh collider (three-mesh-bvh): the gates lie
//                in the bore with room for their radius, a sphere swept down the bore's centre line
//                hits nothing, one flown into the flank or the bore wall hits the mesh
//   falls        the waterfall wall's gap gates stand between the falls; the sinking air is in the
//                falls (<= -4 m/s) and the gates are clear (|w| < 1.5 m/s)
//   balloons     thirty balloons with envelope hulls, baskets and tethers; every gate opening is clear
//   kites        the kite strings are sensors tagged kiteString; every gate opening is clear of them;
//                a sweep across a string meets its sensor and nothing solid; every leg of the course
//                clears the hill by the gates' height
//   challenge    a scripted run through every course's gates (the challenge system's crossings):
//                started, every gate passed, finished with a medal and a stored best; a kite run
//                that brushes a string counts a miss and its penalty and still finishes
//   dispose      every spawn ends with no collider, wind source, challenge course or leak left
//
// Usage: node --expose-gc tools/lab/presets-71-80.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import inspector from 'node:inspector/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { PRESETS, PRESET_BY_ID } from '../../src/spawns/presets/index.js';
import { PRESET_TAGS, validatePresets } from '../../src/spawns/schema.js';
import { ENGINE_NAMES, createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { applyStampHeight } from '../../src/world/stamps.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createColliderWorld } from '../../src/world/colliders.js';
import { createChallengeSystem } from '../../src/gameplay/challenges.js';
import { createWaterQuery } from '../../src/world/waterQuery.js';
import { createWaterEffects } from '../../src/render/waterEffects.js';
import { RECIPE_NAMES } from '../../src/audio/recipes/index.js';
import { buildTestSite } from '../../src/dev/structureTestKit.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { createWindModifierEngine } from '../../src/spawns/engines/windModifierEngine.js';
import { createWeatherVolumeEngine } from '../../src/spawns/engines/weatherVolumeEngine.js';
import { createEmitterEngine } from '../../src/spawns/engines/emitterEngine.js';
import { createWaterEffectEngine } from '../../src/spawns/engines/waterEffectEngine.js';
import { createLightEffectEngine } from '../../src/spawns/engines/lightEffectEngine.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const BATCH = Object.freeze(['reverseWaterfall', 'forestWisps', 'ridgeLiftBand', 'windShearLine', 'thermalStreet', 'canyonGauntlet', 'caveTunnel', 'waterfallWall', 'balloonFestival', 'kiteSlalom']);
const SITE_PRESETS = Object.freeze(['reverseWaterfall', 'ridgeLiftBand', 'canyonGauntlet', 'caveTunnel', 'waterfallWall', 'balloonFestival', 'kiteSlalom']);

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${test.padEnd(9)} ${name}${detail ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}\n`);
}
const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};
const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;

// ---- Stub world: gentle hills at about 300 m with a ridge, the test sites' stamps applied -------------
const WATER_LEVEL = 0;
const stamps = [];
function baseHeight(x, z) {
  return 300 + 18 * Math.sin(x * 0.0013) * Math.cos(z * 0.0011) + 6 * Math.sin((x + z) * 0.0041);
}
function groundHeight(x, z) {
  let height = baseHeight(x, z);
  for (let index = 0; index < stamps.length; index++) {
    const stamp = stamps[index];
    if (x < stamp.minX || x > stamp.maxX || z < stamp.minZ || z > stamp.maxZ) continue;
    height = applyStampHeight(stamp, x, z, height);
  }
  return height;
}
const BIOME = Object.freeze({ key: 'meadows', name: 'Meadows' });
/** Each site preset's test site, 9 km apart along x, its stamps applied to the stub world. */
const SITES = new Map();
SITE_PRESETS.forEach((presetId, index) => {
  const site = buildTestSite(PRESET_BY_ID[presetId], { x: index * 9000, z: 0, rotation: 0.35 + index * 0.4, seed: 7100 + index }, { baseHeight, waterLevel: WATER_LEVEL });
  SITES.set(presetId, site);
  for (const stamp of site.stamps) stamps.push(stamp);
});
/** The undiscovered site the wisps lead to (a fixture the stub world's site feed reports). */
const GUIDE_SITE = Object.freeze({ id: 'canyonGauntlet:31:1', presetId: 'canyonGauntlet', x: 63500, z: 2500 });
const world = {
  seedHash: 71,
  WATER_LEVEL,
  heightAt: groundHeight,
  groundHeight,
  biomeAt: () => BIOME,
  hash2(x, z, salt) {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  },
  sitesNear(x, z, radius) {
    return Math.hypot(GUIDE_SITE.x - x, GUIDE_SITE.z - z) <= radius ? [GUIDE_SITE] : [];
  },
};

function createLab() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 20000);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 30000);
  camera.position.set(0, 600, 3000);
  camera.updateMatrixWorld();
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    skyZenithColor: uniform(new THREE.Color(0x4f6fa8)),
    skyHorizonColor: uniform(new THREE.Color(0xf2c48e)),
    nightFactor: uniform(0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1.2),
    renderOrigin: uniform(new THREE.Vector3()),
    cloudGlory: uniform(0),
    cloudBow: uniform(0),
  };
  const state = {
    seed: 'LAB71',
    frame: 0,
    time: { elapsed: 0, frameDt: 0, sunElevation: 30, dayTime: 0.45, nightFactor: 0, goldenFactor: 0, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(), moonDirection: new THREE.Vector3(-0.3, -0.5, 0.8).normalize() },
    player: {
      position: new THREE.Vector3(0, 600, 3000), velocity: new THREE.Vector3(0, 0, -50), quaternion: new THREE.Quaternion(),
      forward: new THREE.Vector3(0, 0, -1), heading: 0, speed: 50,
    },
    flight: { craft: 'glider' },
  };
  const storageMap = new Map();
  const surfaces = createGroundSurfaces();
  const colliders = createColliderWorld({ groundSurfaces: surfaces, bus });
  const game = { colliders, world, systems: {} };
  game.systems.challenges = createChallengeSystem({
    bus,
    state,
    systems: game.systems,
    storage: { read: (key, fallback) => (storageMap.has(key) ? storageMap.get(key) : fallback), write: (key, value) => { storageMap.set(key, value); return true; }, remove: (key) => storageMap.delete(key) },
  });
  const wind = createWindField({ world, uniforms, state, bus });
  const waterQuery = createWaterQuery({ world, windDirection: uniforms.windDirection.value, clock: state.time });
  const water = createWaterEffects({ THREE, TSL, scene, camera, state, uniforms, world, waterQuery, systems: {}, registerPrewarm() {} });
  waterQuery.attachEffects(water);
  game.waterQuery = waterQuery;
  // The sky's modifier API (the weather volumes' inside fog), recording what is live.
  const modifiers = new Set();
  const sky = {
    addModifier(id) {
      if (modifiers.has(id)) throw new Error(`sky modifier "${id}" already exists`);
      modifiers.add(id);
      return { set() {}, remove() { modifiers.delete(id); } };
    },
    getModifierLevels: () => ({ active: false, overcast: 0 }),
  };
  const memory = { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 };
  const voices = [];
  const audio = {
    spawnVoice(recipe) {
      const levels = new Float64Array(2);
      const voice = {
        recipe, disposed: false,
        setPosition(point) { levels[1] = point.x; },
        setIntensity(value) { levels[0] = value; },
        trigger() { return true; },
        dispose() { voice.disposed = true; },
      };
      voices.push(voice);
      return voice;
    },
  };
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    // backend WebGL2: the emitter runs its closed-form particles in node (no compute pass to submit).
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGL2', wind, audio, world, state, sky,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB71', surfaces, game, water,
  });
  for (const create of [createStructureEngine, createWindModifierEngine, createWeatherVolumeEngine, createEmitterEngine, createWaterEffectEngine, createLightEffectEngine, createFaunaEngine]) manager.register(create());
  for (const id of BATCH) manager.addPreset(PRESET_BY_ID[id]);
  manager.init();
  game.systems.spawns = { manager: { isDiscovered: (id) => manager.isDiscovered(id), getPreset: (id) => manager.getPreset(id) } };
  const events = { notify: [], guide: [], started: [], gates: [], finished: [], sensors: [] };
  bus.on('notify', (payload) => events.notify.push(payload));
  bus.on('lightEffect:guide', (payload) => events.guide.push(payload));
  bus.onTyped('challengeStarted', (payload) => events.started.push(payload));
  bus.onTyped('challengeGate', (payload) => events.gates.push(payload));
  bus.onTyped('challengeFinished', (payload) => events.finished.push(payload));
  function step(frames = 1, dt = 1 / 60) {
    for (let frame = 0; frame < frames; frame++) {
      state.frame++;
      state.time.elapsed += dt;
      state.time.frameDt = dt;
      camera.position.copy(state.player.position);
      manager.update(dt, dt);
      game.systems.challenges.update(dt, dt);
    }
  }
  function moveTo(x, y, z) {
    state.player.position.set(x, y, z);
    camera.position.set(x, y, z);
  }
  function spawnSite(presetId) {
    const site = SITES.get(presetId);
    moveTo(site.x + 400, site.groundY + 300, site.z + 400);
    return manager.activate(presetId, { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
  }
  function spawnEvent(presetId, position, heading) {
    return manager.activate(presetId, { position, heading, source: 'debug', force: true });
  }
  const sample = { vel: new THREE.Vector3(), turbulence: 0 };
  function windAt(x, y, z, time = state.time.elapsed) {
    wind.sample(new THREE.Vector3(x, y, z), time, sample);
    return { x: sample.vel.x, y: sample.vel.y, z: sample.vel.z, turbulence: sample.turbulence };
  }
  return { bus, scene, camera, uniforms, state, wind, colliders, surfaces, voices, manager, events, step, moveTo, spawnSite, spawnEvent, windAt, challenges: game.systems.challenges, storageMap, modifiers };
}

const lab = createLab();
const { manager, colliders } = lab;
/** The compass heading an activation with anchor.align 'downwind' takes (spawnManager applyAnchorRule). */
function downwindHeading() {
  const direction = lab.uniforms.windDirection.value;
  const compass = (Math.atan2(direction.x, -direction.y) * 180) / Math.PI;
  return compass < 0 ? compass + 360 : compass;
}
function partsOf(id) {
  return manager.getParts(id) ?? [];
}
function structureOf(id) {
  return partsOf(id).find((part) => part.engine === 'structure') ?? null;
}
function geometryHash(mesh) {
  if (!mesh) return 'none';
  const array = mesh.geometry.attributes.position.array;
  let hash = 2166136261;
  for (let index = 0; index < array.length; index += 5) hash = Math.imul(hash ^ Math.round(array[index] * 100), 16777619) >>> 0;
  return `${array.length}:${hash.toString(16)}`;
}
const sweepOut = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null };
/** A sphere swept from a to b ({ x, y, z }): the hit record's id, or null. */
function sweep(a, b, radius, sensors = false) {
  const hit = colliders.sweepSphere(a, b, radius, { sensors, landableTops: true }, sweepOut);
  return hit ? { id: sweepOut.id, sensor: Boolean(sweepOut.tags && sweepOut.tags.sensor) } : null;
}
/** A point offset from a gate centre along its normal. */
function alongGate(gate, distance) {
  return { x: gate.center.x + gate.normal.x * distance, y: gate.center.y + gate.normal.y * distance, z: gate.center.z + gate.normal.z * distance };
}

// ---- schema ------------------------------------------------------------------------------------------------
{
  let message = '';
  try {
    validatePresets(PRESETS, { engineNames: ENGINE_NAMES });
  } catch (error) {
    message = error.message;
  }
  check('schema', `the game's ${PRESETS.length} presets validate, the batch's ten among them`, message === '' && BATCH.every((id) => PRESET_BY_ID[id]), message);
  for (const id of BATCH) {
    const preset = PRESET_BY_ID[id];
    const tagsOk = (preset.tags ?? []).every((tag) => PRESET_TAGS.includes(tag));
    const audioOk = preset.audio === null || RECIPE_NAMES.includes(preset.audio.recipe);
    check('schema', `${id}: journal, ${preset.callouts.length} callouts, tags and audio`, preset.journal.title && preset.journal.description && preset.callouts.length >= 3 && tagsOk && audioOk && preset.audio !== null, preset.audio ? preset.audio.recipe : 'silent');
  }
}

// ---- sites ---------------------------------------------------------------------------------------------------
const siteSpawns = new Map();
/**
 * The live spawn of a site preset, with the craft moved next to it: sites 9 km apart do not all stay
 * within range, so a site the craft left behind is built again on its own test site (the same seed).
 */
function site(presetId) {
  const live = siteSpawns.get(presetId);
  if (live && manager.getInstance(live)) {
    const where = SITES.get(presetId);
    lab.moveTo(where.x + 400, where.groundY + 300, where.z + 400);
    lab.step(1);
    return live;
  }
  const id = lab.spawnSite(presetId);
  lab.step(2);
  siteSpawns.set(presetId, id);
  return id;
}
for (const presetId of SITE_PRESETS) {
  let id = null;
  let error = '';
  try {
    id = lab.spawnSite(presetId);
  } catch (caught) {
    error = caught.message;
  }
  lab.step(2);
  const part = id ? structureOf(id) : null;
  const instance = id ? manager.getInstance(id) : null;
  siteSpawns.set(presetId, id);
  const colliderIds = partsOf(id).reduce((sum, entry) => sum + (entry.colliderIds ? entry.colliderIds.length : 0), 0);
  check('sites', `${presetId}: builds on its stamped site`, Boolean(instance) && error === '' && consoleErrors.length === 0, error || `${partsOf(id).length} parts, ${colliderIds} colliders, structure ${part ? part.data.recipe : 'none'}`);
}
{
  // The same site twice: the same geometry (the canyon, with its stamped path and seeded rock).
  const first = geometryHash(structureOf(site('canyonGauntlet')).data.meshes.body);
  manager.deactivate(site('canyonGauntlet'), 'test');
  lab.step(1);
  site('canyonGauntlet');
  const second = geometryHash(structureOf(site('canyonGauntlet')).data.meshes.body);
  check('sites', 'the same site builds the same geometry', first === second && first !== 'none', `${first} / ${second}`);
}
for (const presetId of ['canyonGauntlet', 'caveTunnel', 'waterfallWall', 'balloonFestival', 'kiteSlalom']) {
  const part = structureOf(site(presetId));
  const definition = part ? part.data.challengeDefinitions[0] : null;
  const preset = PRESET_BY_ID[presetId];
  const registered = lab.challenges.list().find((entry) => entry.presetId === presetId);
  check('sites', `${presetId}: its course is registered with ${preset.challenge.gates.length} gates`, Boolean(definition) && Boolean(registered) && registered.gates === preset.challenge.gates.length && part.data.challengeKeys.length === 1, registered ? registered.courseKey : 'none');
}

// ---- reverse waterfall --------------------------------------------------------------------------------------------
{
  const id = site('reverseWaterfall');
  const part = structureOf(id);
  const where = SITES.get('reverseWaterfall');
  const stamp = where.stamps[0];
  const water = part.data.meshes.water;
  // The water ribbons climb: the highest water vertex stands far above the lip.
  let top = -Infinity;
  const positions = water.geometry.attributes.position.array;
  for (let index = 1; index < positions.length; index += 3) top = Math.max(top, positions[index] + water.position.y);
  check('reverse', 'water ribbons climb hundreds of metres above the lip', top > stamp.topY + 300, `top ${round(top, 0)} m, lip ${round(stamp.topY, 0)} m`);
  check('reverse', 'mist puffs at the pool and at the top of the column', part.data.puffSlots.length >= 20, `${part.data.puffSlots.length} puffs`);
  lab.step(300);
  const heading = (where.rotation * 180) / Math.PI;
  const dirX = Math.sin(where.rotation);
  const dirZ = -Math.cos(where.rotation);
  const columnX = where.x + dirX * 42;
  const columnZ = where.z + dirZ * 42;
  const inColumn = lab.windAt(columnX, stamp.topY + 120, columnZ);
  const away = lab.windAt(where.x - dirX * 900, stamp.topY + 120, where.z - dirZ * 900);
  check('reverse', 'an updraft column rises at the water column (>= 8 m/s), none 900 m upstream', inColumn.y >= 8 && Math.abs(away.y) < 1.5, `column ${round(inColumn.y)} m/s, upstream ${round(away.y)} m/s (heading ${round(heading, 0)})`);
}

// ---- wisps --------------------------------------------------------------------------------------------------------
{
  lab.state.time.nightFactor = 1;
  lab.uniforms.nightFactor.value = 1;
  lab.moveTo(60000, 900, 3000);
  lab.step(1);
  const start = { x: 60000, y: groundHeight(60000, 0), z: 0 };
  const id = lab.spawnEvent('forestWisps', start, 0);
  lab.step(30);
  const part = partsOf(id).find((entry) => entry.engine === 'lightEffect');
  const engine = manager.registry.get('lightEffect');
  const phase = () => engine.describe(part).guide.phase;
  check('wisps', 'they wait at the anchor while the craft is far', phase() === 'waiting' && Math.hypot(part.anchor.x - start.x, part.anchor.z - start.z) < 0.01, phase());
  // The craft flies past, heading east at 40 m/s, 150 m up.
  const player = lab.state.player;
  player.velocity.set(40, 0, 0);
  player.heading = 90;
  player.speed = 40;
  let x = 59700;
  for (let frame = 0; frame < 60 * 20; frame++) {
    x += 40 / 60;
    lab.moveTo(x, groundHeight(x, 0) + 150, 0);
    lab.step(1);
  }
  const behind = player.position.x - part.anchor.x;
  check('wisps', 'they trail the craft once it comes near', phase() === 'trailing' && behind > 10 && behind < 120 && Math.abs(part.anchor.z) < 20, `${phase()}, ${round(behind, 1)} m behind`);
  // Allocation of the guide's frame update (trailing, the craft moving): a warm-up first, so the
  // optimising compiler has run, then the measurement with collections watched. The guide's clock
  // (state slot 1) is held at the trail's start, so the wisps keep trailing through the measurement
  // (they would otherwise set off for the site, a search that allocates as event work), its ground
  // sample (slot 7, four times a second: event work through the terrain's call) is held off, so the
  // measurement is the per-frame path, and the spawn's age is held too (the direct updates would run
  // it past its lifetime); the anchor, the clocks and the craft go back where they were afterwards.
  const frameCtx = { time: lab.state.time, camera: lab.camera };
  const trailFrom = x;
  const anchorFrom = { x: part.anchor.x, y: part.anchor.y, z: part.anchor.z };
  const clockFrom = part.data.guide[1];
  const ageFrom = part.data.age[0];
  // The craft's x lives in a typed array: a double captured and reassigned in a closure is boxed.
  const track = new Float64Array([x]);
  const runTrail = (frames) => {
    for (let frame = 0; frame < frames; frame++) {
      track[0] += 40 / 60;
      player.position.x = track[0];
      part.data.guide[1] = 0;
      part.data.guide[7] = 1;
      part.data.age[0] = ageFrom;
      engine.update(part, 1 / 60, frameCtx);
    }
  };
  runTrail(90000);
  // V8's sampling heap profiler (every object the minor and major collections take included) counts
  // what engine.update allocates itself, apart from the loop's own stores; collections are watched
  // too. The observer is set up before the measurement, so its own allocation is not counted.
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const session = new inspector.Session();
  session.connect();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  collections = 0;
  const frames = 30000;
  await session.post('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
  runTrail(frames);
  const { profile } = await session.post('HeapProfiler.stopSampling');
  const trailCollections = collections;
  observer.disconnect();
  session.disconnect();
  const engineFile = /lightEffectEngine\.js$/;
  const underEngine = (node, inside) => {
    const here = inside || engineFile.test(node.callFrame.url);
    return (here ? node.selfSize : 0) + node.children.reduce((sum, child) => sum + underEngine(child, here), 0);
  };
  const grown = underEngine(profile.head, false);
  // Back to where the trail was, the wisps behind the craft again.
  x = trailFrom;
  part.anchor.x = anchorFrom.x;
  part.anchor.y = anchorFrom.y;
  part.anchor.z = anchorFrom.z;
  part.data.guide[1] = clockFrom;
  part.data.age[0] = ageFrom;
  lab.moveTo(x, groundHeight(x, 0) + 150, 0);
  check('wisps', 'the guide frame update allocates nothing (between its 4 Hz ground samples)', trailCollections === 0 && grown / frames < 1, `${round(grown / frames, 3)} B/frame, ${trailCollections} collections`);
  // After the trail, they set off toward the undiscovered site; the craft keeps pace a while.
  for (let frame = 0; frame < 60 * 30 && phase() === 'trailing'; frame++) {
    x += 40 / 60;
    lab.moveTo(x, groundHeight(x, 0) + 150, 0);
    lab.step(1);
  }
  const led = events => events.some((event) => event.phase === 'leading' && event.siteId === GUIDE_SITE.id);
  check('wisps', 'after the trail they lead toward the nearest undiscovered site, with a notice', phase() === 'leading' && led(lab.events.guide) && lab.events.notify.some((note) => /wisps drift away/.test(note.text)), phase());
  // The craft stops (hovering): the wisps move off, then hold once it is more than `lead` behind.
  player.velocity.set(0, 0, 0);
  player.speed = 0;
  lab.step(60 * 60);
  const held = part.anchor.x;
  lab.step(60 * 10);
  const lead = PRESET_BY_ID.forestWisps.engines[0].params.guide.lead;
  const gap = Math.hypot(part.anchor.x - player.position.x, part.anchor.z - player.position.z);
  check('wisps', 'they hold while the craft lags', Math.abs(part.anchor.x - held) < 0.5 && gap > lead && gap < lead + 60, `${round(gap, 0)} m ahead, moved ${round(part.anchor.x - held, 2)} m in 10 s`);
  // The craft follows them, 150 m behind at up to 30 m/s: they lead it to the site and gather there.
  player.speed = 30;
  for (let frame = 0; frame < 60 * 400 && phase() !== 'arrived'; frame++) {
    const dx = part.anchor.x - player.position.x;
    const dz = part.anchor.z - player.position.z;
    const distance = Math.hypot(dx, dz);
    const stepLength = Math.min(30 / 60, Math.max(0, distance - 150));
    player.velocity.set((dx / distance) * 30, 0, (dz / distance) * 30);
    const px = player.position.x + (dx / distance) * stepLength;
    const pz = player.position.z + (dz / distance) * stepLength;
    lab.moveTo(px, groundHeight(px, pz) + 150, pz);
    lab.step(1);
  }
  check('wisps', 'they gather over the site when the craft arrives', phase() === 'arrived' && Math.hypot(part.anchor.x - GUIDE_SITE.x, part.anchor.z - GUIDE_SITE.z) < 160, `${phase()}, ${round(Math.hypot(part.anchor.x - GUIDE_SITE.x, part.anchor.z - GUIDE_SITE.z), 0)} m from it`);
  manager.deactivate(id, 'test');
  lab.step(1);
  lab.state.time.nightFactor = 0;
  lab.uniforms.nightFactor.value = 0;
  player.velocity.set(0, 0, -50);
  player.heading = 0;
  player.speed = 50;
}

// ---- ridge band ----------------------------------------------------------------------------------------------------
{
  const where = SITES.get('ridgeLiftBand');
  const dirX = Math.sin(where.rotation);
  const dirZ = -Math.cos(where.rotation);
  const crest = where.groundY;
  // The band's own lift: the field with the band, less the same field (same points, same time)
  // before it: the stub hills' slope lift and lee sink and the gusts are taken off.
  const time = lab.state.time.elapsed + 1;
  const points = [-1800, -900, -600, 0, 600, 1200, 1800].map((offset) => [where.x + dirX * offset, crest + 200, where.z + dirZ * offset]);
  const offAxis = [where.x - dirZ * 1500, crest + 200, where.z + dirX * 1500];
  const before = points.map((point) => lab.windAt(...point, time).y);
  const offBefore = lab.windAt(...offAxis, time).y;
  site('ridgeLiftBand');
  lab.step(60);
  const along = points.map((point, index) => lab.windAt(...point, time).y - before[index]);
  const off = lab.windAt(...offAxis, time).y - offBefore;
  check('ridge', 'the band lifts along the crest (>= 2 m/s more), not 1.5 km off the axis', along.every((value) => value >= 2) && Math.abs(off) < 0.6, `along +${along.map((value) => round(value, 1)).join(', +')} m/s, off-axis ${round(off, 2)}`);
}

// ---- shear line -----------------------------------------------------------------------------------------------------
{
  lab.moveTo(120000, 900, 3000);
  const position = { x: 120000, y: groundHeight(120000, 0), z: 0 };
  // The activation turns downwind (anchor.align); the front faces 90 degrees right of it.
  const id = lab.spawnEvent('windShearLine', position, 0);
  lab.step(60 * 30);
  const turn = ((downwindHeading() + 90) * Math.PI) / 180;
  const frontX = Math.sin(turn);
  const frontZ = -Math.cos(turn);
  const at = (distance) => lab.windAt(position.x + frontX * (550 + distance), position.y + 300, position.z + frontZ * (550 + distance));
  const ahead = at(400);
  const behind = at(-600);
  const angle = (vector) => Math.atan2(vector.x, -vector.z) * (180 / Math.PI);
  const veer = Math.abs(((angle(behind) - angle(ahead) + 540) % 360) - 180);
  const ratio = Math.hypot(behind.x, behind.z) / Math.max(0.1, Math.hypot(ahead.x, ahead.z));
  const edge = at(0);
  check('shear', 'across the cloud edge the wind veers 40+ degrees and speeds up 1.5x, chop at the edge', veer >= 40 && ratio >= 1.5 && edge.turbulence > 0.3, `veer ${round(veer, 0)} deg, x${round(ratio, 2)}, edge turbulence ${round(edge.turbulence, 2)}`);
  siteSpawns.set('windShearLine', id);
}

// ---- thermal street ---------------------------------------------------------------------------------------------------
{
  lab.moveTo(160000, 900, 3000);
  const position = { x: 160000, y: groundHeight(160000, 0), z: 0 };
  const id = lab.spawnEvent('thermalStreet', position, 0);
  lab.step(60 * 30);
  const heading = (downwindHeading() * Math.PI) / 180;
  const forwardX = Math.sin(heading);
  const forwardZ = -Math.cos(heading);
  const lifts = [];
  for (const side of [900, -900]) {
    for (const along of [-2625, 525, 2625]) lifts.push(lab.windAt(position.x + forwardX * along - forwardZ * side, position.y + 700, position.z + forwardZ * along + forwardX * side).y);
  }
  const between = lab.windAt(position.x, position.y + 700, position.z).y;
  check('street', 'lift under the clouds of both rows (>= 2.5 m/s), none between the rows', lifts.every((value) => value >= 2.5) && between < 0.5, `rows ${lifts.map((value) => round(value, 1)).join(', ')} m/s, between ${round(between, 2)}`);
  const cloud = partsOf(id).filter((part) => part.engine === 'weatherVolume');
  check('street', 'two rows of eight cumulus clumps along the wind', cloud.length === 2 && cloud.every((part) => part.data.layout.groupCount === 8), cloud.map((part) => part.data.layout.groupCount).join(', '));
  siteSpawns.set('thermalStreet', id);
}

// ---- courses -------------------------------------------------------------------------------------------------------
function courseOf(presetId) {
  return structureOf(site(presetId)).data.challengeDefinitions[0];
}
/** Every gate opening clear: a sphere through the centre along the normal, 80 m either side. */
function openingsClear(definition, radius, sensors = false) {
  const blocked = [];
  for (const gate of definition.gates) {
    const hit = sweep(alongGate(gate, -80), alongGate(gate, 80), radius, sensors);
    if (hit) blocked.push(`${gate.id}:${hit.id}`);
  }
  return blocked;
}
{
  const where = SITES.get('canyonGauntlet');
  const carve = where.stamps[0];
  const definition = courseOf('canyonGauntlet');
  const misplaced = [];
  for (const gate of definition.gates) {
    let nearest = Infinity;
    let halfWidth = 0;
    for (let index = 1; index < carve.path.length; index++) {
      const a = carve.path[index - 1];
      const b = carve.path[index];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const t = Math.min(1, Math.max(0, ((gate.center.x - a.x) * abx + (gate.center.z - a.z) * abz) / (abx * abx + abz * abz)));
      const distance = Math.hypot(gate.center.x - a.x - abx * t, gate.center.z - a.z - abz * t);
      if (distance < nearest) {
        nearest = distance;
        halfWidth = a.halfWidth + (b.halfWidth - a.halfWidth) * t;
      }
    }
    const floor = groundHeight(gate.center.x, gate.center.z);
    if (nearest > halfWidth || gate.center.y - floor < 8) misplaced.push(`${gate.id}: ${round(nearest, 0)} m off the path, ${round(gate.center.y - floor, 0)} m up`);
  }
  check('canyon', 'every gate stands on the canyon floor path, inside its walls', misplaced.length === 0, misplaced.join('; ') || `${definition.gates.length} gates`);
  const pillars = structureOf(site('canyonGauntlet')).colliderIds.filter((id) => /:pillar/.test(id)).length;
  check('canyon', 'two pillar hulls frame every gate', pillars === definition.gates.length * 2, `${pillars} pillars`);
  const blocked = openingsClear(definition, 2);
  check('canyon', 'every gate opening is clear of colliders', blocked.length === 0, blocked.join(', '));
}
{
  const part = structureOf(site('caveTunnel'));
  const mesh = part.data.meshColliders ? part.data.meshColliders[0] : null;
  const definition = courseOf('caveTunnel');
  check('cave', 'the mountain is one mesh collider (three-mesh-bvh) with a summit perch', Boolean(mesh) && part.colliderIds.length === 1 && typeof mesh.bvh.shapecast === 'function', `${part.colliderIds.length} collider(s)`);
  const tight = definition.gates.filter((gate) => -mesh.depth(gate.center.x, gate.center.y, gate.center.z) < gate.radius + 2).map((gate) => `${gate.id} ${round(-mesh.depth(gate.center.x, gate.center.y, gate.center.z), 1)} m`);
  check('cave', 'every gate lies in the bore with room for its radius', tight.length === 0, tight.join(', ') || definition.gates.map((gate) => round(-mesh.depth(gate.center.x, gate.center.y, gate.center.z), 1)).join(' '));
  // Down the centre line: through every gate centre in turn, extended out of both portals.
  const hits = [];
  const gates = definition.gates;
  const route = [alongGate(gates[0], -60), ...gates.map((gate) => gate.center), alongGate(gates[gates.length - 1], 60)];
  for (let index = 1; index < route.length; index++) {
    const from = route[index - 1];
    const to = route[index];
    for (let step = 0; step < 20; step++) {
      const a = { x: from.x + (to.x - from.x) * (step / 20), y: from.y + (to.y - from.y) * (step / 20), z: from.z + (to.z - from.z) * (step / 20) };
      const b = { x: from.x + (to.x - from.x) * ((step + 1) / 20), y: from.y + (to.y - from.y) * ((step + 1) / 20), z: from.z + (to.z - from.z) * ((step + 1) / 20) };
      const hit = sweep(a, b, 1.5);
      if (hit) hits.push(hit.id);
    }
  }
  check('cave', 'a sphere swept down the bore through every gate hits nothing', hits.length === 0, hits.slice(0, 3).join(', ') || `${route.length - 1} legs`);
  const middle = gates[Math.floor(gates.length / 2)];
  const side = { x: middle.normal.z, z: -middle.normal.x };
  const flank = sweep({ x: middle.center.x + side.x * 600, y: middle.center.y + 40, z: middle.center.z + side.z * 600 }, { x: middle.center.x, y: middle.center.y + 40, z: middle.center.z }, 1.5);
  const wall = sweep(middle.center, { x: middle.center.x + side.x * 60, y: middle.center.y, z: middle.center.z + side.z * 60 }, 1.5);
  check('cave', 'flying into the flank or the bore wall hits the mesh', Boolean(flank) && Boolean(wall) && /mountain/.test(flank.id) && /mountain/.test(wall.id), `${flank ? flank.id : 'none'} / ${wall ? wall.id : 'none'}`);
}
{
  const definition = courseOf('waterfallWall');
  const where = SITES.get('waterfallWall');
  const preset = PRESET_BY_ID.waterfallWall;
  const params = preset.engines[0].params;
  const dirX = Math.sin(where.rotation);
  const dirZ = -Math.cos(where.rotation);
  const rightX = -dirZ;
  const rightZ = dirX;
  lab.step(120);
  const stamp = where.stamps[0];
  const lipY = stamp.topY - 0.8;
  const midY = lipY - 60;
  // 60 m below the lip a fall is launch x sqrt(2 x 60 / g) out from where it left the lip.
  const out = params.launch * Math.sqrt((2 * 60) / 9.81) + 1 - stamp.face / 2;
  const falls = [];
  for (let fall = 0; fall < params.falls; fall++) {
    const across = (fall - (params.falls - 1) / 2) * params.spacing;
    falls.push(lab.windAt(where.x + dirX * out + rightX * across, midY, where.z + dirZ * out + rightZ * across).y);
  }
  const gaps = definition.gates.filter((gate) => /^gap/.test(gate.id)).map((gate) => lab.windAt(gate.center.x, gate.center.y, gate.center.z).y);
  check('falls', 'the air sinks in the falls (<= -4 m/s) and the gap gates are clear (|w| < 1.5)', falls.every((value) => value <= -4) && gaps.every((value) => Math.abs(value) < 1.5), `falls ${falls.map((value) => round(value, 1)).join(' ')}; gaps ${gaps.map((value) => round(value, 2)).join(' ')}`);
  const between = definition.gates.filter((gate) => /^gap/.test(gate.id)).every((gate) => {
    const across = (gate.center.x - where.x) * rightX + (gate.center.z - where.z) * rightZ;
    const nearestFall = Math.min(...Array.from({ length: params.falls }, (unused, fall) => Math.abs(across - (fall - (params.falls - 1) / 2) * params.spacing)));
    return nearestFall > 30;
  });
  check('falls', 'every gap gate stands between two falls', between);
}
{
  const part = structureOf(site('balloonFestival'));
  const envelopes = part.colliderIds.filter((id) => /:envelope/.test(id)).length;
  const tethers = part.colliderIds.filter((id) => /:tether/.test(id)).length;
  const baskets = part.colliderIds.filter((id) => /:basket/.test(id)).length;
  check('balloons', 'thirty balloons: envelope and crown hulls, baskets and tethers', envelopes === 30 && baskets === 30 && tethers === 30, `${envelopes} envelopes, ${baskets} baskets, ${tethers} tethers`);
  const blocked = openingsClear(courseOf('balloonFestival'), 2);
  check('balloons', 'every gate opening is clear', blocked.length === 0, blocked.join(', '));
}
{
  const part = structureOf(site('kiteSlalom'));
  const strings = part.colliderIds.filter((id) => /:string/.test(id));
  const records = colliders.list().filter((record) => strings.includes(record.id));
  const sensorsOk = records.length === strings.length && records.every((record) => record.tags.sensor === true && record.tags.miss === 'kiteString');
  const checkpoints = PRESET_BY_ID.kiteSlalom.challenge.gates.filter((gate) => gate.role === 'checkpoint').length;
  check('kites', 'every string is a sensor tagged kiteString (one per checkpoint, plus the extras)', sensorsOk && strings.length === checkpoints + PRESET_BY_ID.kiteSlalom.engines[0].params.extra, `${strings.length} strings`);
  const definition = courseOf('kiteSlalom');
  const blocked = openingsClear(definition, 2, true);
  check('kites', 'every gate opening is clear of the strings', blocked.length === 0, blocked.join(', '));
  // Across the first checkpoint's string at 15 % of its height: the string's ground track is one of its
  // bounds' diagonals, so one of the two horizontal sweeps along them meets it. Its sensor, nothing solid.
  const { min, max } = records[0].bounds;
  const y = min.y + (max.y - min.y) * 0.15;
  const diagonals = [[{ x: min.x - 20, y, z: min.z - 20 }, { x: max.x + 20, y, z: max.z + 20 }], [{ x: min.x - 20, y, z: max.z + 20 }, { x: max.x + 20, y, z: min.z - 20 }]];
  const across = diagonals.map(([a, b]) => sweep(a, b, 0.6, true)).find((hit) => hit !== null) ?? null;
  const solid = diagonals.map(([a, b]) => sweep(a, b, 0.6, false)).find((hit) => hit !== null) ?? null;
  check('kites', 'a sweep across a string meets its sensor and nothing solid', Boolean(across) && across.sensor && solid === null, across ? across.id : 'none');
  // Over the hill: every leg from gate to gate clears the ground under it by its gates' height.
  let lowest = Infinity;
  definition.gates.forEach((gate, index) => {
    if (index === 0) return;
    const from = definition.gates[index - 1].center;
    const to = gate.center;
    for (let step = 0; step <= 40; step++) {
      const share = step / 40;
      const x = from.x + (to.x - from.x) * share;
      const z = from.z + (to.z - from.z) * share;
      lowest = Math.min(lowest, from.y + (to.y - from.y) * share - groundHeight(x, z));
    }
  });
  const leastHeight = Math.min(...PRESET_BY_ID.kiteSlalom.challenge.gates.map((gate) => gate.height));
  check('kites', 'every leg of the course clears the hill by its gates\' height',lowest >= leastHeight - 0.5, `lowest ${round(lowest, 1)} m over the ground, gates ${leastHeight}+ m`);
}

// ---- challenge runs ----------------------------------------------------------------------------------------------------
/**
 * Flies a course gate after gate: from 60 m before each gate through its centre to 30 m beyond it, at
 * 40 m/s. afterGate(index) runs once the craft is through gate `index`.
 */
function flyCourse(definition, afterGate = null) {
  definition.gates.forEach((gate, index) => {
    const from = alongGate(gate, -60);
    const to = alongGate(gate, 30);
    lab.moveTo(from.x, from.y, from.z);
    lab.step(1);
    const frames = Math.ceil(90 / (40 / 60));
    for (let frame = 1; frame <= frames; frame++) {
      const t = frame / frames;
      lab.moveTo(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      lab.step(1);
    }
    if (afterGate) afterGate(index);
  });
}
for (const presetId of ['canyonGauntlet', 'caveTunnel', 'waterfallWall', 'balloonFestival', 'kiteSlalom']) {
  const definition = courseOf(presetId);
  const finishedBefore = lab.events.finished.length;
  const gatesBefore = lab.events.gates.length;
  flyCourse(definition);
  const finished = lab.events.finished.slice(finishedBefore).find((payload) => payload.id.includes(presetId)) ?? null;
  const passed = lab.events.gates.slice(gatesBefore).filter((payload) => !payload.missed).length;
  const best = finished ? lab.challenges.getBest(lab.challenges.list().find((entry) => entry.presetId === presetId).courseKey, 'glider') : null;
  check('challenge', `${presetId}: a run through every gate finishes with a medal and a stored best`, Boolean(finished) && finished.valid && finished.missed === 0 && passed === definition.gates.length && finished.medal !== 'none' && Boolean(best), finished ? `${round(finished.time, 1)} s, ${finished.medal}, ${passed}/${definition.gates.length} gates` : `${passed} gates, not finished`);
  lab.step(60 * 7);
}
{
  // A kite run that brushes a string after the first checkpoint: the flight controller's sensor
  // event (colliderSensor, with the string's miss tag) counts a miss and its penalty, and the run
  // still finishes (a string is never a crash).
  const definition = courseOf('kiteSlalom');
  const string = colliders.list().find((record) => record.tags.miss === 'kiteString');
  const finishedBefore = lab.events.finished.length;
  const misses = [];
  const offMiss = lab.bus.on('challenge:sensorMiss', (payload) => misses.push(payload));
  flyCourse(definition, (index) => {
    if (index !== 1 || !string) return;
    lab.bus.emitTyped('colliderSensor', { id: string.id, owner: string.owner, tag: string.tags.miss, craft: 'glider', position: { x: lab.state.player.position.x, y: lab.state.player.position.y, z: lab.state.player.position.z } });
  });
  offMiss();
  const finished = lab.events.finished.slice(finishedBefore).find((payload) => payload.id.includes('kiteSlalom')) ?? null;
  const penalty = PRESET_BY_ID.kiteSlalom.challenge.sensors.kiteString.penaltySeconds;
  check('challenge', `kiteSlalom: touching a string counts a miss and its ${penalty} s penalty, and the run still finishes`, Boolean(string) && misses.length === 1 && misses[0].penaltySeconds === penalty && Boolean(finished) && finished.missed === 1, finished ? `${misses.length} sensor miss(es), finished in ${round(finished.time, 1)} s with ${finished.missed} missed, ${finished.medal}` : `${misses.length} sensor miss(es), not finished`);
  lab.step(60 * 7);
}

// ---- dispose --------------------------------------------------------------------------------------------------------------
{
  for (const id of siteSpawns.values()) if (id && manager.getInstance(id)) manager.deactivate(id, 'test');
  lab.step(2);
  const stats = manager.getStats();
  const leaks = stats.leaks ?? {};
  const leakCount = Object.values(leaks).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  check('dispose', 'every spawn ends: no collider, wind source, challenge course or leak left', colliders.count === 0 && lab.wind.sourceCount === 0 && lab.challenges.count() === 0 && leakCount === 0, `${colliders.count} colliders, ${lab.wind.sourceCount} sources, ${lab.challenges.count()} courses, leaks ${JSON.stringify(leaks)}`);
  check('dispose', 'every voice was disposed with its spawn', lab.voices.every((voice) => voice.disposed), `${lab.voices.filter((voice) => !voice.disposed).length} left of ${lab.voices.length}`);
  check('dispose', 'no console error during the lab', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
}

const failed = results.filter((result) => !result.pass);
process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed.length}/${results.length} presets 71-80 checks\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
