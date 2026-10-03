// Spawn framework lab: runs the preset validator, the engine registry, the pooling helpers and the
// SpawnManager headless (node, three's node materials without a renderer) against the dev test kit's
// engines and presets (src/dev/spawnTestKit.js) on a stub world with one ridge.
//
// Tests:
//   schema       the test presets validate; each broken copy is refused with an error naming the
//                preset and the field (lod order, callouts, tokens, lure rules, frozen, unknown fields,
//                site and event rules, unregistered engines, duplicate ids)
//   registry     engines missing a method, badly named or registered twice are refused
//   pools        slot allocator order, reuse and high-water mark; object pool reuse; scratch rings
//   lod          a spawn walked out from 300 m to 12 km and back changes tier at boundary * (1 + H)
//                going out and boundary * (1 - H) coming in, and holds its tier while it jitters
//                around a boundary
//   budgets      the heavy limit, per-engine instance caps and particle estimates refuse activations;
//                debug force spawns pass; refusals are counted; a director activation whose engines
//                all end at create is declined (no spawn, no spawnActivated), a debug one still spawns
//   lure         a heavy spawn 30 km out is FAR with its lure faded in, drawn at the projection limit
//                with its angular size kept; it fades out when the spawn comes within mid range
//   discovery    fires once when in range and in view; not while a ridge hides the sight line; a
//                respawned event and a re-created site do not fire again
//   sites        the site feed creates a site within lod.far and removes it past far + hysteresis
//   wind         a wind engine's source is live while its spawn runs and gone after dispose (with
//                windSourceRemoved); its real light returns to the pool, which holds exactly the
//                lights the engines declare
//   leaks        an engine that forgets its wind source and light is cleaned up and reported
//   lifetime     ended events end, expired events end, director events despawn out of range and view
//   memory       every create and dispose is logged with its readings; a long-lived spawn whose log
//                entry was reused by 64 newer spawns does not overwrite the newer entry
//   couplings    the real celestial, weatherVolume and fauna engines with no audio service create their
//                audio-owning presets silently; with an audio service that refuses the recipe the
//                spawn is refused as 'error' and leaves no sky modifier and no fauna agent range behind
//   allocation   after a JIT warm-up, 100 000 manager frames with 40 spawns (markers, lures, a wind
//                column, a moving camera) allocate nothing: no garbage collection runs and the young
//                generation grows by under 0.1 byte per frame (the camera alone measures about 0.03)
//
// Usage: node --expose-gc tools/lab/spawns.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { validatePreset, validatePresets } from '../../src/spawns/schema.js';
import { createEngineRegistry, validateEngine } from '../../src/spawns/engineRegistry.js';
import { createObjectPool, createScratch, createSlotAllocator } from '../../src/spawns/pools.js';
import { LOD_HYSTERESIS, createSpawnManager } from '../../src/spawns/spawnManager.js';
import { createTestMarkerEngine, createTestPresets, createTestSiteFeed, createTestWindEngine } from '../../src/dev/spawnTestKit.js';
import { createCelestialEngine } from '../../src/spawns/engines/celestialEngine.js';
import { createWeatherVolumeEngine } from '../../src/spawns/engines/weatherVolumeEngine.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';
import { PRESET_BY_ID } from '../../src/spawns/presets/index.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}

// Console errors are part of the contract (leaks and bad payloads report through them): count them.
const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
  if (VERBOSE) originalError(...args);
};

// ---- Stub world: flat ground at 0 m with one east-west ridge 800 m high at z = -1500 (inside the fog) --
const RIDGE_Z = -1500;
const RIDGE_HALF_WIDTH = 150;
const RIDGE_HEIGHT = 800;
function groundHeight(x, z) {
  return Math.abs(z - RIDGE_Z) < RIDGE_HALF_WIDTH && Math.abs(x) < 2000 ? RIDGE_HEIGHT : 0;
}
const BIOME = Object.freeze({ key: 'meadows', name: 'Meadows' });
const world = {
  seedHash: 1234,
  WATER_LEVEL: -10,
  heightAt: groundHeight,
  groundHeight,
  biomeAt: () => BIOME,
  hash2(x, z, salt) {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  },
};

function createLab() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 2400);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 5000);
  camera.position.set(0, 300, 0);
  camera.lookAt(0, 300, -1000);
  camera.updateMatrixWorld();
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    nightFactor: uniform(0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1),
  };
  const state = {
    seed: 'LAB',
    time: { elapsed: 0, sunElevation: 30, dayTime: 0.4, nightFactor: 0, goldenFactor: 0 },
    player: { position: new THREE.Vector3(0, 300, 0), forward: new THREE.Vector3(0, 0, -1), heading: 0 },
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const memory = { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 };
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGPU', wind, audio: null, world, state, sky: null,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB',
  });
  manager.register(createTestMarkerEngine());
  manager.register(createTestWindEngine());
  for (const preset of createTestPresets()) manager.addPreset(preset);
  manager.init();
  const events = { activated: [], ended: [], discovery: [], windAdded: [], windRemoved: [], inView: [] };
  bus.onTyped('spawnActivated', (payload) => events.activated.push(payload));
  bus.onTyped('spawnEnded', (payload) => events.ended.push(payload));
  bus.onTyped('discovery', (payload) => events.discovery.push(payload));
  bus.onTyped('windSourceAdded', (payload) => events.windAdded.push(payload));
  bus.onTyped('windSourceRemoved', (payload) => events.windRemoved.push(payload));
  bus.on('spawns:inView', (payload) => events.inView.push(payload));
  function step(frames = 1, dt = 1 / 60) {
    for (let frame = 0; frame < frames; frame++) {
      state.time.elapsed += dt;
      manager.update(dt, dt);
    }
  }
  /** Activates presetId distance metres north of the camera (straight ahead), at height y. */
  function spawnAhead(presetId, distance, { source = 'debug', force = source === 'debug', y = 0, x = 0 } = {}) {
    return manager.activate(presetId, { position: { x, y, z: camera.position.z - distance }, heading: 0, source, force });
  }
  return { bus, scene, camera, uniforms, state, wind, memory, registry, manager, events, step, spawnAhead };
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    return pattern.test(error.message) ? '' : `wrong message: ${error.message}`;
  }
  return 'did not throw';
}

// ---- schema ---------------------------------------------------------------------------------------------
function testSchema() {
  const presets = createTestPresets();
  const engineNames = ['testMarker', 'testWind'];
  let valid = '';
  try {
    validatePresets(presets, { engineNames });
  } catch (error) {
    valid = error.message;
  }
  check('schema', `${presets.length} test presets validate`, valid === '', valid);
  const base = presets.find((preset) => preset.id === 'testMarker');
  const site = presets.find((preset) => preset.id === 'testSite');
  const heavy = presets.find((preset) => preset.id === 'testLurePlume');
  const mutate = (source, patch) => Object.freeze({ ...source, ...patch });
  const cases = [
    ['lod order', mutate(base, { lod: { near: 1500, mid: 900, far: 9000 } }), /"testMarker": field "lod\.mid" must be greater than 1500/],
    ['two callouts', mutate(base, { callouts: ['One.', 'Two.'] }), /field "callouts" must have at least 3 lines/],
    ['unknown token', mutate(base, { callouts: ['A {speed}.', 'B.', 'C.'] }), /field "callouts\[0\]" uses an unknown token \{speed\}/],
    ['heavy without lure', mutate(heavy, { lure: null }), /field "lure" must be an object/],
    ['light with lure', mutate(base, { lure: heavy.lure }), /field "lure" must be null for a preset that is not heavy/],
    ['bad lure type', mutate(heavy, { lure: { ...heavy.lure, type: 'cube' } }), /field "lure\.type" must be one of plume/],
    ['not frozen', { ...base }, /must be frozen/],
    ['unknown field', mutate(base, { colour: 1 }), /field "\(preset\)\.colour" is not a known field/],
    ['site with duration', mutate(site, { lifetime: { duration: [1, 2], despawn: site.lifetime.despawn } }), /"testSite": field "lifetime\.duration" must be null for a site/],
    ['event with stamps', mutate(base, { stamps: [{ type: 'cone' }] }), /field "stamps" must be empty for an event/],
    ['bad stamp type', mutate(site, { stamps: [{ type: 'crater' }] }), /field "stamps\[0\]\.type" must be one of cone/],
    ['unregistered engine', mutate(base, { engines: [{ engine: 'vortex', params: {} }] }), /field "engines\[0\]\.engine" names an engine that is not registered: "vortex"/],
    ['camelCase id', mutate(base, { id: 'Test-marker' }), /field "id" must be camelCase/],
    ['bad time of day', mutate(base, { filters: { ...base.filters, timeOfDay: ['noon'] } }), /field "filters\.timeOfDay\[0\]" must be one of dawn/],
    ['event without candidates', mutate(base, { candidates: undefined }), /field "candidates" must be an object/],
  ];
  for (const [name, preset, pattern] of cases) check('schema', `refused: ${name}`, expectThrow(() => validatePreset(preset, { engineNames }), pattern) === '', expectThrow(() => validatePreset(preset, { engineNames }), pattern));
  check('schema', 'refused: duplicate ids', expectThrow(() => validatePresets([base, base], { engineNames }), /"testMarker": field "id" is used by another preset/) === '');
}

// ---- registry ---------------------------------------------------------------------------------------------
function testRegistry() {
  const registry = createEngineRegistry();
  const engine = createTestMarkerEngine();
  registry.register(engine);
  check('registry', 'register and look up', registry.get('testMarker') === engine && registry.names().join() === 'testMarker');
  check('registry', 'duplicate refused', expectThrow(() => registry.register(createTestMarkerEngine()), /already registered/) === '');
  const missing = { ...createTestWindEngine(), setLOD: undefined };
  check('registry', 'missing method refused', expectThrow(() => validateEngine(missing), /setLOD\(\) is missing/) === '');
  check('registry', 'bad name refused', expectThrow(() => validateEngine({ ...createTestWindEngine(), name: 'Wind Engine' }), /name must be a camelCase string/) === '');
  check('registry', 'bad budget refused', expectThrow(() => validateEngine({ ...createTestWindEngine(), budget: { instances: -1, particles: 0 } }), /budget must be/) === '');
}

// ---- pools ---------------------------------------------------------------------------------------------------
function testPools() {
  const slots = createSlotAllocator(4);
  const first = [slots.alloc(), slots.alloc(), slots.alloc()];
  check('pools', 'slots hand out 0, 1, 2 first', first.join() === '0,1,2', first.join());
  slots.free(1);
  const reused = slots.alloc();
  check('pools', 'a freed slot is reused', reused === 1, String(reused));
  slots.alloc();
  check('pools', 'full allocator returns -1', slots.alloc() === -1);
  slots.free(3);
  slots.free(2);
  check('pools', 'high-water mark trims after frees', slots.highWater === 2, String(slots.highWater));
  check('pools', 'double free refused', slots.free(2) === false);
  let built = 0;
  const pool = createObjectPool(() => ({ value: built++ }), { prefill: 2, reset: (object) => { object.value = -1; } });
  const a = pool.acquire();
  pool.release(a);
  const b = pool.acquire();
  check('pools', 'object pool reuses released objects', a === b && built === 2 && b.value === -1, `built ${built}`);
  const scratch = createScratch(THREE, 4);
  const vectors = [scratch.vec3(), scratch.vec3(), scratch.vec3(), scratch.vec3(), scratch.vec3()];
  check('pools', 'scratch ring wraps after its size', vectors[0] === vectors[4] && vectors[0] !== vectors[1]);
}

// ---- lod --------------------------------------------------------------------------------------------------------
function testLod() {
  const lab = createLab();
  const id = lab.spawnAhead('testMarker', 300, { y: 300 });
  const parts = lab.manager.getParts(id);
  const lod = lab.manager.getPreset('testMarker').lod;
  const transitions = [];
  let last = lab.manager.getInstance(id).tier;
  const walk = (distance) => {
    for (const part of parts) part.anchor.set(0, 300, -distance);
    lab.step(1);
    const tier = lab.manager.getInstance(id).tier;
    if (tier !== last) transitions.push({ from: last, to: tier, distance });
    last = tier;
  };
  for (let distance = 300; distance <= 8800; distance += 10) walk(distance);
  for (let distance = 8800; distance >= 300; distance -= 10) walk(distance);
  const outNear = transitions.find((entry) => entry.from === 'near' && entry.to === 'mid');
  const outMid = transitions.find((entry) => entry.from === 'mid' && entry.to === 'far');
  const inMid = transitions.find((entry) => entry.from === 'far' && entry.to === 'mid');
  const inNear = transitions.find((entry) => entry.from === 'mid' && entry.to === 'near');
  const within = (value, target) => value !== undefined && Math.abs(value - target) <= 10;
  check('lod', `near -> mid at ${lod.near} * (1 + ${LOD_HYSTERESIS})`, within(outNear?.distance, lod.near * (1 + LOD_HYSTERESIS)), `at ${outNear?.distance} m`);
  check('lod', `mid -> far at ${lod.mid} * (1 + H)`, within(outMid?.distance, lod.mid * (1 + LOD_HYSTERESIS)), `at ${outMid?.distance} m`);
  check('lod', 'far -> mid at mid * (1 - H)', within(inMid?.distance, lod.mid * (1 - LOD_HYSTERESIS)), `at ${inMid?.distance} m`);
  check('lod', 'mid -> near at near * (1 - H)', within(inNear?.distance, lod.near * (1 - LOD_HYSTERESIS)), `at ${inNear?.distance} m`);
  check('lod', 'exactly four transitions on the round trip', transitions.length === 4, JSON.stringify(transitions));
  const changesBefore = parts[0].data.tierChanges;
  for (let index = 0; index < 400; index++) walk(lod.near * (1 + (index % 2 === 0 ? 0.05 : -0.05)));
  check('lod', 'no flapping while jittering 5 % around a boundary', parts[0].data.tierChanges - changesBefore <= 1, `${parts[0].data.tierChanges - changesBefore} changes`);
  check('lod', 'engine setLOD saw every change', parts[0].data.tierChanges >= 4);
}

// ---- budgets ------------------------------------------------------------------------------------------------------
function testBudgets() {
  const lab = createLab();
  const first = lab.spawnAhead('testLurePlume', 20000, { source: 'director' });
  const second = lab.spawnAhead('testLureAnvil', 22000, { source: 'director' });
  const third = lab.spawnAhead('testLureFunnel', 24000, { source: 'director' });
  check('budgets', 'two heavy spawns admitted, the third refused', first && second && third === null, `${first} ${second} ${third}`);
  check('budgets', 'the refusal says heavy', lab.manager.getStats().lastRefusal === 'heavy' && lab.manager.canActivate('testLureFunnel') === 'heavy');
  const forced = lab.spawnAhead('testLureFunnel', 24000, { source: 'debug', force: true });
  check('budgets', 'a debug force spawn passes the heavy limit', Boolean(forced) && lab.manager.getStats().heavy === 3);
  lab.manager.setBudget('testMarker', { instances: 5 });
  const markers = [];
  for (let index = 0; index < 6; index++) markers.push(lab.spawnAhead('testMarker', 400 + index * 50, { source: 'director' }));
  check('budgets', 'per-engine instance cap refuses the next marker', markers.filter(Boolean).length === 2 && lab.manager.getStats().lastRefusal === 'instances', `${markers.filter(Boolean).length} admitted (3 lure markers already count)`);
  lab.manager.setBudget('testMarker', { instances: 256, particles: 0 });
  lab.manager.addPreset(Object.freeze({ ...createTestPresets()[0], id: 'testParticles', engines: [{ engine: 'testMarker', params: { particles: 10 } }] }));
  check('budgets', 'a particle estimate over the cap is refused', lab.spawnAhead('testParticles', 500, { source: 'director' }) === null && lab.manager.getStats().lastRefusal === 'particles');
  const stats = lab.manager.getStats();
  check('budgets', 'refusals are counted', stats.refusals.heavy === 1 && stats.refusals.instances === 4 && stats.refusals.particles === 1, JSON.stringify(stats.refusals));
  lab.manager.addPreset(Object.freeze({ ...createTestPresets()[0], id: 'testDeclines', engines: [{ engine: 'testMarker', params: { declines: true } }] }));
  const activatedBefore = lab.events.activated.length;
  const declined = lab.spawnAhead('testDeclines', 500, { source: 'director' });
  const declinedStats = lab.manager.getStats();
  check('budgets', 'a director activation that ends at create is declined', declined === null && declinedStats.lastRefusal === 'declined' && declinedStats.refusals.declined === 1 && lab.events.activated.length === activatedBefore, `${declined}, ${JSON.stringify(declinedStats.refusals)}`);
  const kept = lab.spawnAhead('testDeclines', 500, { source: 'debug' });
  lab.step(1);
  check('budgets', 'a debug activation that ends at create still spawns, and ends on the next frame', Boolean(kept) && lab.events.ended.some((event) => event.id === kept && event.reason === 'ended'), String(kept));
}

// ---- lure --------------------------------------------------------------------------------------------------------
function testLure() {
  const lab = createLab();
  const id = lab.spawnAhead('testLurePlume', 30000);
  lab.step(90);
  const spawn = lab.manager.getInstance(id);
  check('lure', 'a heavy spawn 30 km out is FAR', spawn.tier === 'far', spawn.tier);
  check('lure', 'its lure faded in over 1.2 s', spawn.lure === 1, String(spawn.lure));
  const lureStats = lab.manager.lures.getStats();
  check('lure', 'the lure is drawn and projected', lureStats.drawn === 1 && lureStats.projected === 1, JSON.stringify(lureStats));
  const matrix = new THREE.Matrix4().fromArray(lab.manager.lures.mesh.instanceMatrix.array, 0);
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  const limit = lab.scene.fog.far * 0.92;
  const drawnDistance = position.distanceTo(lab.camera.position);
  check('lure', 'drawn at the projection limit (inside the fog far and camera far)', Math.abs(drawnDistance - limit) < 1 && drawnDistance < lab.camera.far, `${drawnDistance.toFixed(1)} m, limit ${limit.toFixed(1)} m`);
  const width = new THREE.Vector3(matrix.elements[0], matrix.elements[1], matrix.elements[2]).length();
  const trueDistance = Math.hypot(30000, 300);
  const angularTrue = 2 * Math.atan(3400 / 2 / trueDistance);
  const angularDrawn = 2 * Math.atan(width / 2 / drawnDistance);
  check('lure', 'angular size preserved', Math.abs(angularTrue - angularDrawn) < 1e-4, `${(angularTrue * 180 / Math.PI).toFixed(3)} vs ${(angularDrawn * 180 / Math.PI).toFixed(3)} deg`);
  for (const part of lab.manager.getParts(id)) part.anchor.set(0, 0, -3000);
  lab.step(90);
  const near = lab.manager.getInstance(id);
  check('lure', 'the lure fades out at mid range', near.tier === 'mid' && near.lure === 0, `${near.tier} ${near.lure}`);
  check('lure', 'a hidden lure is not drawn', lab.manager.lures.getStats().drawn === 0);
  lab.manager.deactivate(id);
  check('lure', 'deactivation frees the lure slot', lab.manager.lures.getStats().highWater === 0);
}

// ---- discovery ------------------------------------------------------------------------------------------------------
function testDiscovery() {
  const lab = createLab();
  // Behind the ridge (z = -1500, 800 m high, inside the 2400 m fog): the sight line from 300 m passes through it.
  const hidden = lab.manager.activate('testLurePlume', { position: { x: 0, y: 0, z: -3600 }, heading: 0, source: 'debug', force: true });
  const plume = createTestPresets().find((preset) => preset.id === 'testLurePlume');
  const wide = Object.freeze({ radius: 5000, requireInView: true });
  lab.manager.addPreset(Object.freeze({ ...plume, id: 'testLureTall', discovery: wide }));
  lab.manager.addPreset(Object.freeze({ ...plume, id: 'testLureLow', lure: Object.freeze({ type: 'plume', height: 300, width: 300, color: 0x555555 }), discovery: wide }));
  const low = lab.manager.activate('testLureLow', { position: { x: 0, y: 0, z: -3600 }, heading: 0, source: 'debug', force: true });
  const tall = lab.manager.activate('testLureTall', { position: { x: 300, y: 0, z: -3600 }, heading: 0, source: 'debug', force: true });
  lab.step(60);
  check('discovery', 'a spawn hidden behind the ridge is not discovered', !lab.events.discovery.some((event) => event.presetId === 'testLureLow'), JSON.stringify(lab.events.discovery));
  check('discovery', 'a plume towering over the ridge is (its middle clears it)', lab.events.discovery.some((event) => event.presetId === 'testLureTall'));
  check('discovery', 'a spawn beyond its discovery radius is not', !lab.events.discovery.some((event) => event.presetId === 'testLurePlume'));
  lab.manager.deactivate(tall);
  // With the fog closing in at 1200 m the ridge (1500 m) is fully fogged: it no longer hides anything.
  lab.scene.fog.far = 1200;
  lab.step(60);
  check('discovery', 'terrain beyond the fog does not hide a spawn', lab.events.discovery.some((event) => event.presetId === 'testLureLow'));
  lab.scene.fog.far = 2400;
  lab.manager.deactivate(hidden);
  lab.manager.deactivate(low);
  const id = lab.spawnAhead('testMarker', 600);
  lab.step(30);
  const first = lab.events.discovery.filter((event) => event.presetId === 'testMarker');
  check('discovery', 'an event in range and in view is discovered once', first.length === 1 && first[0].id === 'testMarker' && first[0].kind === 'flightplay', JSON.stringify(first));
  lab.manager.deactivate(id);
  lab.spawnAhead('testMarker', 500);
  lab.step(60);
  check('discovery', 'the same event preset does not fire again', lab.events.discovery.filter((event) => event.presetId === 'testMarker').length === 1);
  const behind = lab.manager.activate('testUpdraft', { position: { x: 0, y: 0, z: 600 }, heading: 0, source: 'debug', force: true });
  lab.step(60);
  check('discovery', 'a spawn behind the camera (out of the frustum) is not discovered', !lab.events.discovery.some((event) => event.presetId === 'testUpdraft'));
  lab.manager.deactivate(behind);
  const site = { id: 'testSite:0:-1', presetId: 'testSite', x: 0, z: -700, groundY: 0, rotation: 0, scale: 1, seed: 99, stamps: [] };
  lab.manager.setSiteFeed(createTestSiteFeed([site]));
  lab.step(60);
  const siteSpawn = lab.manager.getSiteSpawn(site.id);
  const siteDiscoveries = () => lab.events.discovery.filter((event) => event.id === site.id);
  check('discovery', 'a site from the feed is discovered once, by site id', Boolean(siteSpawn) && siteDiscoveries().length === 1, JSON.stringify(siteDiscoveries()));
  lab.manager.deactivate(siteSpawn, 'test');
  lab.step(60);
  check('discovery', 'the re-created site does not fire again', Boolean(lab.manager.getSiteSpawn(site.id)) && siteDiscoveries().length === 1);
  check('discovery', 'in-view notices fire once per spawn', lab.events.inView.filter((event) => event.siteId === site.id).length === 2, `${lab.events.inView.length} notices`);
}

// ---- sites -------------------------------------------------------------------------------------------------------------
function testSites() {
  const lab = createLab();
  const near = { id: 'testSite:0:-3', presetId: 'testSite', x: 0, z: -5000, groundY: 0, rotation: 0, scale: 1, seed: 7, stamps: [] };
  const far = { id: 'testSite:5:0', presetId: 'testSite', x: 9000, z: 0, groundY: 0, rotation: 0, scale: 1, seed: 8, stamps: [] };
  lab.manager.setSiteFeed(createTestSiteFeed([near, far]));
  lab.step(60);
  check('sites', 'a site within lod.far (6 km) is created', Boolean(lab.manager.getSiteSpawn(near.id)));
  check('sites', 'a site beyond lod.far is not', lab.manager.getSiteSpawn(far.id) === null);
  lab.camera.position.set(0, 300, 1500);
  lab.camera.updateMatrixWorld();
  lab.state.player.position.set(0, 300, 1500);
  lab.step(10);
  check('sites', 'kept inside far + hysteresis (6.5 km of 7 km)', Boolean(lab.manager.getSiteSpawn(near.id)));
  lab.camera.position.set(0, 300, 2300);
  lab.camera.updateMatrixWorld();
  lab.state.player.position.set(0, 300, 2300);
  lab.step(10);
  check('sites', 'removed past far + hysteresis (7.3 km)', lab.manager.getSiteSpawn(near.id) === null && lab.events.ended.some((event) => event.reason === 'range'));
  check('sites', 'site spawns are kind site in spawnActivated', lab.events.activated.some((event) => event.kind === 'site' && event.presetId === 'testSite'));
}

// ---- wind -------------------------------------------------------------------------------------------------------------------
function testWind() {
  const lab = createLab();
  const probe = new THREE.Vector3(0, 400, -800);
  const PROBE_TIME = 100;
  const before = lab.wind.probe(probe, PROBE_TIME).vel.y;
  const id = lab.spawnAhead('testUpdraft', 800);
  lab.step(5);
  const during = lab.wind.probe(probe, PROBE_TIME).vel.y;
  check('wind', 'the wind engine registered its source', lab.wind.sourceCount === 1 && lab.events.windAdded.length === 1);
  check('wind', 'the column lifts the air', during - before > 3, `${before.toFixed(2)} -> ${during.toFixed(2)} m/s`);
  check('wind', 'the light pool holds exactly the lights the engines declare (testWind: 1)', lab.manager.lights.size === 1 && lab.scene.children.filter((child) => child.isPointLight).length === 1);
  check('wind', 'the spawn holds one real light', lab.manager.lights.active === 1);
  lab.manager.deactivate(id, 'test');
  const after = lab.wind.probe(probe, PROBE_TIME).vel.y;
  check('wind', 'dispose removed the source (windSourceRemoved)', lab.wind.sourceCount === 0 && lab.events.windRemoved.length === 1);
  check('wind', 'the lift is gone', Math.abs(after - before) < 1e-9, `${after.toFixed(2)} m/s`);
  check('wind', 'the light is back in the pool', lab.manager.lights.active === 0);
  check('wind', 'no leak reported', lab.manager.getStats().leaks.windSources === 0 && lab.manager.getStats().leaks.lights === 0);
}

// ---- leaks -----------------------------------------------------------------------------------------------------------------------
function testLeaks() {
  const lab = createLab();
  const leaky = {
    name: 'testLeaky',
    init(ctx) { this.ctx = ctx; },
    create(preset, params) {
      const id = `leaky:${params.seed}`;
      this.ctx.wind.addSource({ id, kind: 'leaky', bounds: { center: params.position, radius: 100 }, sample: () => null });
      this.ctx.lights.acquire(0);
      return { anchor: params.position, radius: 50, windSourceIds: [id], lights: 1, particles: 0, data: null };
    },
    update() {},
    setLOD() {},
    dispose() {},
    stats() { return { instances: 0, particles: 0, lights: 0, buffers: 0, drawCalls: 0 }; },
  };
  lab.manager.register(leaky);
  lab.manager.addPreset(Object.freeze({ ...createTestPresets()[0], id: 'testLeak', engines: [{ engine: 'testLeaky' }] }));
  const errorsBefore = consoleErrors.length;
  const id = lab.spawnAhead('testLeak', 500);
  lab.manager.deactivate(id);
  const stats = lab.manager.getStats();
  check('leaks', 'a forgotten wind source is removed and reported', lab.wind.sourceCount === 0 && stats.leaks.windSources === 1);
  check('leaks', 'a forgotten light is released and reported', lab.manager.lights.active === 0 && stats.leaks.lights === 1);
  check('leaks', 'both leaks reach the console as errors', consoleErrors.length - errorsBefore === 2, consoleErrors.slice(errorsBefore).join(' | '));
}

// ---- lifetime -----------------------------------------------------------------------------------------------------------------------
function testLifetime() {
  const lab = createLab();
  const endedId = lab.spawnAhead('testMarker', 500, { source: 'director' });
  for (const part of lab.manager.getParts(endedId)) part.ended = true;
  lab.step(1);
  check('lifetime', 'instance.ended ends the spawn', lab.events.ended.some((event) => event.id === endedId && event.reason === 'ended'));
  const expiring = lab.spawnAhead('testMarker', 500, { source: 'director' });
  const duration = lab.manager.getInstance(expiring).duration;
  lab.step(Math.ceil((duration + 46) * 10), 0.1);
  check('lifetime', 'an event past its duration plus grace expires', lab.events.ended.some((event) => event.id === expiring && event.reason === 'expired'), `duration ${duration.toFixed(0)} s`);
  // Behind the camera, past despawn distance + hysteresis (9.5 km) but inside lod.far * (1 + H) (9.72 km).
  const wanderer = lab.manager.activate('testMarker', { position: { x: 0, y: 300, z: 9600 }, heading: 0, source: 'director' });
  lab.step(60 * 25);
  check('lifetime', 'a director event beyond despawn distance and out of view for 20 s despawns', lab.events.ended.some((event) => event.id === wanderer && event.reason === 'despawn'));
  const debugId = lab.manager.activate('testMarker', { position: { x: 0, y: 0, z: 8500 }, heading: 0, source: 'debug', force: true });
  lab.step(60 * 25);
  check('lifetime', 'a debug spawn is exempt from the despawn rule', Boolean(lab.manager.getInstance(debugId)));
}

// ---- memory ---------------------------------------------------------------------------------------------------------------------
function testMemoryLog() {
  const lab = createLab();
  const longLived = lab.spawnAhead('testMarker', 500);
  const newer = [];
  for (let index = 0; index < 70; index++) {
    const id = lab.spawnAhead('testMarker', 600 + index);
    newer.push(id);
    lab.manager.deactivate(id, 'test');
  }
  // The long-lived spawn's entry now belongs to a newer spawn; its dispose must leave that alone.
  // The ring holds 64 entries: the long-lived spawn took the first, the 64th newer spawn took it over.
  const reused = lab.manager.getStats().memory.log.find((entry) => entry.id === newer[63]);
  lab.memory.geometries = 99;
  lab.manager.deactivate(longLived, 'test');
  lab.memory.geometries = 0;
  const memory = lab.manager.getStats().memory;
  const after = memory.log.find((entry) => entry.id === reused?.id);
  check('memory', 'every create and dispose is counted', memory.created === 71 && memory.disposed === 71, `${memory.created} created, ${memory.disposed} disposed`);
  check('memory', 'the log keeps the last 64 spawns, each disposed with its readings', memory.log.length === 64 && memory.log.every((entry) => entry.disposed && entry.afterDispose !== null && entry.afterCreate !== null));
  check('memory', 'the long-lived spawn did not overwrite the newer entry it lost', Boolean(after) && !memory.log.some((entry) => entry.id === longLived) && after.afterDispose.geometries === 0, after ? `newer entry ${after.id} still reads ${after.afterDispose.geometries} geometries after dispose` : 'entry missing');
}

// ---- allocation ---------------------------------------------------------------------------------------------------------------------
async function testAllocation() {
  const lab = createLab();
  for (let index = 0; index < 34; index++) lab.manager.activate('testMarker', { position: { x: (index % 7 - 3) * 150, y: 0, z: -300 - index * 40 }, heading: 0, source: 'debug', force: true });
  lab.spawnAhead('testLurePlume', 30000);
  lab.spawnAhead('testLureAnvil', 26000);
  lab.spawnAhead('testLureWhale', 4000);
  lab.spawnAhead('testLureComet', 20000);
  lab.spawnAhead('testUpdraft', 900);
  lab.spawnAhead('testLureIslands', 1200);
  check('allocation', '40 spawns active', lab.manager.getStats().spawns === 40, String(lab.manager.getStats().spawns));
  const orbit = { angle: 0 };
  const frame = () => {
    // The camera circles slowly, so tiers, lures and visibility keep changing.
    orbit.angle += 0.0005;
    lab.camera.position.set(Math.sin(orbit.angle) * 900, 300, Math.cos(orbit.angle) * 900 - 900);
    lab.camera.rotation.set(0, orbit.angle, 0);
    lab.camera.updateMatrixWorld();
    // The world clock stands still so no event reaches its end during the measurement.
    lab.manager.update(1 / 60, 1 / 60);
  };
  // Warm-up: V8 tiers the code up (interpreter, baseline, optimised) over the first frames, and the
  // lower tiers box doubles. The measurement starts once the code is optimised.
  for (let index = 0; index < 150000; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const youngBefore = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const youngAfter = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const perFrame = (youngAfter - youngBefore) / frames;
  check('allocation', `no garbage collection during ${frames} frames`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(3)} B/frame, ${youngAfter - youngBefore} B in all`);
  const counters = lab.manager.getStats().counters;
  check('allocation', 'the frames saw tier changes and visibility checks, and every spawn stayed', counters.tierChanges > 0 && counters.visibilityChecks > 0 && counters.ended === 0, JSON.stringify(counters));
}

// ---- couplings ------------------------------------------------------------------------------------------------------
/**
 * A manager running the real celestial, weatherVolume and fauna engines, with a stub sky that tracks
 * its modifiers and the given audio service (null: the spawn system allows a game without audio).
 */
function createCouplingLab(audio) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 9000);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 30000);
  camera.position.set(0, 300, 0);
  camera.lookAt(0, 300, -1000);
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
    windStrength: uniform(1),
    cloudGlory: uniform(0),
    cloudBow: uniform(0),
  };
  const state = {
    seed: 'LAB',
    frame: 0,
    time: { elapsed: 0, frameDt: 1 / 60, sunElevation: 30, dayTime: 0.4, nightFactor: 0, goldenFactor: 0, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize() },
    player: { position: new THREE.Vector3(0, 300, 0), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(), heading: 0, speed: 0 },
  };
  const modifiers = new Set();
  const sky = {
    addModifier(id) {
      if (modifiers.has(id)) throw new Error(`sky modifier "${id}" already exists`);
      modifiers.add(id);
      return { set() {}, remove() { modifiers.delete(id); } };
    },
    getModifierLevels: () => ({ active: false, overcast: 0 }),
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory: { geometries: 0, textures: 0 } } }, backend: 'WebGPU', wind, audio, world, state, sky,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB',
  });
  const fauna = createFaunaEngine();
  for (const engine of [createCelestialEngine(), createWeatherVolumeEngine(), fauna]) manager.register(engine);
  // Each audio-owning preset trimmed to its first engine entry, which owns the voice (the microburst's weatherVolume).
  const trimmed = (id) => Object.freeze({ ...PRESET_BY_ID[id], engines: Object.freeze([PRESET_BY_ID[id].engines[0]]) });
  for (const id of ['meteorShower', 'microburst', 'geeseFormation']) manager.addPreset(trimmed(id));
  manager.init();
  const spawn = (presetId) => manager.activate(presetId, { position: { x: 0, y: 0, z: -3000 }, heading: 0, source: 'debug', force: true });
  return { manager, modifiers, spawn, fauna };
}

function testCouplings() {
  const silent = createCouplingLab(null);
  const initialized = ['celestial', 'weatherVolume', 'fauna'].every((name) => silent.manager.getStats().engines[name]?.failed === false);
  const ids = ['meteorShower', 'microburst', 'geeseFormation'].map((presetId) => silent.spawn(presetId));
  const silentStats = silent.manager.getStats();
  check('couplings', 'no audio service: the meteor shower, microburst and geese create silently', initialized && ids.every(Boolean) && silentStats.refusals.error === 0, `${ids.join(', ')}; refusals ${JSON.stringify(silentStats.refusals)}`);
  for (const id of ids) if (id) silent.manager.deactivate(id);
  check('couplings', 'no audio service: their sky modifiers go with them', silent.modifiers.size === 0, [...silent.modifiers].join(', '));

  const refusing = { spawnVoice(recipe) { throw new Error(`unknown spawn audio recipe "${recipe}"`); } };
  const lab = createCouplingLab(refusing);
  const errorsBefore = consoleErrors.length;
  const meteors = lab.spawn('meteorShower');
  check('couplings', 'a refused celestial voice refuses the spawn and removes its sky modifier', meteors === null && lab.manager.getStats().lastRefusal === 'error' && lab.modifiers.size === 0, `${meteors}; modifiers ${[...lab.modifiers].join(', ') || 'none'}`);
  const geese = lab.spawn('geeseFormation');
  const gooseAgents = lab.fauna.stats().species.goose ?? 0;
  check('couplings', 'a refused fauna voice refuses the spawn and frees its agent range', geese === null && gooseAgents === 0, `${geese}; goose agents in use ${gooseAgents}`);
  const storm = lab.spawn('microburst');
  check('couplings', 'a refused weatherVolume voice refuses the spawn', storm === null && lab.manager.getStats().refusals.error === 3, `${storm}; refusals ${JSON.stringify(lab.manager.getStats().refusals)}`);
  const refusals = consoleErrors.slice(errorsBefore);
  check('couplings', 'each refusal reaches the console once as a create failure', refusals.length === 3 && refusals.every((line) => /failed to create/.test(line)), refusals.join(' | '));
}

// The allocation test runs first, on freshly compiled code: the other tests exercise error paths and
// many preset shapes, and the deoptimisations they cause would be measured as the manager's garbage.
await testAllocation();
testSchema();
testRegistry();
testPools();
testLod();
testBudgets();
testLure();
testDiscovery();
testSites();
testWind();
testLeaks();
testLifetime();
testMemoryLog();
testCouplings();

const unexpectedErrors = consoleErrors.filter((line) => !/left wind source|holding \d+ real light|unknown spawn audio recipe/.test(line));
check('console', 'no unexpected console errors (event payloads valid)', unexpectedErrors.length === 0, unexpectedErrors.join(' | '));
console.error = originalError;

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(10)} ${result.name}${result.detail && (VERBOSE || !result.pass) ? `  (${result.detail})` : result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
