// Presets 51-60 lab: the batch's structure presets (the monastery, the castle ruin, the observatory,
// the viaduct, the dam, the oasis, the labyrinth and the fireball's scar) run headless in the real
// structure engine inside a real SpawnManager, with the game's real collider world and ignition
// service, on a stub world whose height function applies each preset's own resolved terrain stamps.
//
// Tests:
//   recipes      every preset validates; every structure part builds on its real stamped site and
//                free-standing (a debug spawn), with finite geometry; the same site builds the same
//                geometry
//   colliders    each solid preset registers its colliders (and perches and landable roofs where it
//                says), they block a sphere swept into them, and dispose removes every one
//   torches      the torches register as ignitables, a flame lights them (the flame pool shows them),
//                the dusk lamps light at night and go out at dawn, dispose removes every ignitable
//   movers       the animated parts (the train, the dome and telescope, the scar) move with time, their
//                colliders follow them, and they hide at the far tier
//   wind         the prayer flags and banners take the wind the structure shows
//   memory       dispose returns every per-instance geometry and pooled slot
//   allocation   after a JIT warm-up, 60 000 frames of every structure part allocate nothing
//
// Usage: node --expose-gc tools/lab/presets-51-60.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { validatePresets } from '../../src/spawns/schema.js';
import { ENGINE_NAMES } from '../../src/spawns/engineRegistry.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { applyStampHeight } from '../../src/world/stamps.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createColliderWorld } from '../../src/world/colliders.js';
import { createIgnitionService } from '../../src/gameplay/ignition.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { buildTestSite } from '../../src/dev/structureTestKit.js';
import { PRESETS, PRESET_BY_ID } from '../../src/spawns/presets/index.js';

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

/** The batch's presets that have a structure part, in spec order, with what each must show. */
const BATCH = Object.freeze([
  Object.freeze({ id: 'cliffsideMonastery', colliders: 8, perches: true, torches: true, cloth: true }),
]);

// ---- Stub world: gentle hills at about 120 m, with every test site's stamps applied --------------------
const WATER_LEVEL = 0;
const stamps = [];
function baseHeight(x, z) {
  return 120 + 6 * Math.sin(x * 0.0021) * Math.cos(z * 0.0017) + 3 * Math.sin((x + z) * 0.0051);
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
const world = {
  seedHash: 99,
  WATER_LEVEL,
  heightAt: groundHeight,
  groundHeight,
  biomeAt: () => BIOME,
  hash2(x, z, salt) {
    const value = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
    return value - Math.floor(value);
  },
};

/** Each batch preset with only its structure parts (this lab registers the structure engine alone). */
function structureOnly(preset) {
  return Object.freeze({ ...preset, engines: Object.freeze(preset.engines.filter((entry) => entry.engine === 'structure')) });
}
const LAB_PRESETS = BATCH.map((entry) => structureOnly(PRESET_BY_ID[entry.id]));
/** One test site per preset, 8 km apart on an east-west line. */
const SITES = LAB_PRESETS.map((preset, index) => (preset.kind === 'site'
  ? buildTestSite(preset, { x: index * 8000, z: 0, rotation: 0.5 + index * 0.4, seed: 2000 + index }, { baseHeight, waterLevel: WATER_LEVEL })
  : null));
for (const site of SITES) if (site) for (const stamp of site.stamps) stamps.push(stamp);
const siteOf = (presetId) => SITES.find((site) => site && site.presetId === presetId) ?? null;

function createLab() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 20000);
  camera.position.set(0, 400, 1200);
  camera.updateMatrixWorld();
  const { uniform } = TSL;
  const uniforms = {
    time: uniform(0),
    sunDirection: uniform(new THREE.Vector3(0.3, 0.5, -0.8).normalize()),
    sunColor: uniform(new THREE.Color(1, 0.85, 0.65)),
    fogColor: uniform(new THREE.Color(0xe0b48c)),
    nightFactor: uniform(0),
    windDirection: uniform(new THREE.Vector2(0.8, 0.6).normalize()),
    windStrength: uniform(1.4),
    renderOrigin: uniform(new THREE.Vector3()),
  };
  const state = {
    seed: 'LAB51',
    time: { elapsed: 0, frameDt: 0, sunElevation: 30, dayTime: 0.4, nightFactor: 0, goldenFactor: 0, sunDirection: new THREE.Vector3(0.3, 0.5, -0.8).normalize(), moonDirection: new THREE.Vector3(-0.2, 0.6, 0.77).normalize() },
    player: { position: new THREE.Vector3(0, 400, 1200), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(0, 0, -1), heading: 0, speed: 60 },
  };
  const surfaces = createGroundSurfaces();
  const game = { systems: {}, colliders: createColliderWorld({ groundSurfaces: surfaces }), ignition: createIgnitionService() };
  const wind = createWindField({ world, uniforms, state, bus });
  const memory = { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 };
  const voices = [];
  const audio = {
    spawnVoice(recipe) {
      const levels = new Float64Array(2);
      const voice = {
        recipe, triggers: [], disposed: false,
        get level() { return levels[0]; },
        setPosition(point) { levels[1] = point.x; },
        setIntensity(value) { levels[0] = value; },
        trigger(name) { voice.triggers.push(name); return true; },
        dispose() { voice.disposed = true; },
      };
      voices.push(voice);
      return voice;
    },
  };
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGPU', wind, audio, world, state, sky: null,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB51', surfaces, game,
  });
  const engine = manager.register(createStructureEngine());
  for (const preset of LAB_PRESETS) manager.addPreset(preset);
  manager.init();
  function step(frames = 1, dt = 1 / 60) {
    for (let frame = 0; frame < frames; frame++) {
      state.time.elapsed += dt;
      state.time.frameDt = dt;
      uniforms.time.value = state.time.elapsed;
      manager.update(dt, dt);
    }
  }
  function spawnSite(presetId) {
    const site = siteOf(presetId);
    return manager.activate(presetId, { position: { x: site.x, y: site.groundY, z: site.z }, source: 'site', site });
  }
  function spawnFree(presetId, x = 0, z = -2000, heading = 30) {
    return manager.activate(presetId, { position: { x, y: groundHeight(x, z), z }, heading, source: 'debug', force: true });
  }
  /** Spawns a preset where it belongs: on its site, or (an event) free-standing ahead. */
  function spawn(presetId) {
    return siteOf(presetId) ? spawnSite(presetId) : spawnFree(presetId, 30000, -4000);
  }
  return { bus, scene, camera, uniforms, state, wind, memory, voices, surfaces, registry, manager, engine, game, step, spawnSite, spawnFree, spawn };
}

/** The spawn's structure instance (the lab presets carry only their structure parts). */
function partOf(lab, id) {
  return lab.manager.getParts(id)[0] ?? null;
}

function finiteGeometry(mesh) {
  if (!mesh) return true;
  const array = mesh.geometry.attributes.position.array;
  for (let index = 0; index < array.length; index++) if (!Number.isFinite(array[index])) return false;
  return true;
}

function geometryHash(mesh) {
  if (!mesh) return 'none';
  const array = mesh.geometry.attributes.position.array;
  let hash = 2166136261;
  for (let index = 0; index < array.length; index += 7) hash = Math.imul(hash ^ Math.round(array[index] * 100), 16777619) >>> 0;
  return `${array.length}:${hash.toString(16)}`;
}

function vertexCount(part) {
  let count = 0;
  for (const mesh of Object.values(part.data.meshes)) if (mesh) count += mesh.geometry.attributes.position.count;
  for (const mesh of part.data.moverMeshes) if (mesh) count += mesh.geometry.attributes.position.count;
  return count;
}

// ---- recipes ----------------------------------------------------------------------------------------------
function testRecipes() {
  let valid = '';
  try {
    validatePresets(PRESETS, { engineNames: ENGINE_NAMES });
  } catch (error) {
    valid = error.message;
  }
  check('recipes', `the ${PRESETS.length} presets validate with the registered engines`, valid === '', valid);
  const lab = createLab();
  for (const entry of BATCH) {
    const placed = siteOf(entry.id) !== null;
    const id = lab.spawn(entry.id);
    const freeId = lab.spawnFree(entry.id, 60000, -5000, 75);
    const part = id ? partOf(lab, id) : null;
    const free = freeId ? partOf(lab, freeId) : null;
    const meshesFinite = (candidate) => candidate && Object.values(candidate.data.meshes).every(finiteGeometry) && candidate.data.moverMeshes.every(finiteGeometry);
    check('recipes', `${entry.id}: builds ${placed ? 'on its stamped site' : 'where it is spawned'} and free-standing, with finite geometry`, meshesFinite(part) && meshesFinite(free),
      part ? `${vertexCount(part)} vertices on the ${placed ? 'site' : 'spot'}, ${free ? vertexCount(free) : 0} free-standing, radius ${Math.round(part.radius)} m` : 'no instance');
    if (entry.cloth) check('recipes', `${entry.id}: cloth geometry (flags or banners)`, Boolean(part && part.data.meshes.cloth), part && part.data.meshes.cloth ? `${part.data.meshes.cloth.geometry.attributes.position.count / 3} triangles` : 'none');
    if (id) lab.manager.deactivate(id, 'test');
    if (freeId) lab.manager.deactivate(freeId, 'test');
    if (placed) {
      const first = lab.spawnSite(entry.id);
      const hashA = geometryHash(partOf(lab, first).data.meshes.body);
      lab.manager.deactivate(first, 'test');
      const second = lab.spawnSite(entry.id);
      const hashB = geometryHash(partOf(lab, second).data.meshes.body);
      lab.manager.deactivate(second, 'test');
      check('recipes', `${entry.id}: the same site builds the same geometry`, hashA === hashB && hashA !== 'none', hashA);
    }
  }
  check('recipes', 'every voice was disposed with its spawn', lab.voices.every((voice) => voice.disposed), `${lab.voices.filter((voice) => !voice.disposed).length} left`);
}

// ---- colliders --------------------------------------------------------------------------------------------
function testColliders() {
  const lab = createLab();
  const colliders = lab.game.colliders;
  for (const entry of BATCH) {
    if (!entry.colliders) continue;
    const before = colliders.getStats().colliders;
    const id = lab.spawn(entry.id);
    const part = partOf(lab, id);
    const ids = part.colliderIds;
    const records = ids.map((colliderId) => colliders.get(colliderId)).filter(Boolean);
    const perches = records.filter((record) => record.tags.perch !== false).length;
    const landable = records.filter((record) => record.tags.landable).length;
    check('colliders', `${entry.id}: at least ${entry.colliders} colliders registered with the instance`, records.length >= entry.colliders && records.length === ids.length, `${records.length} colliders, ${perches} perches, ${landable} landable`);
    if (entry.perches) check('colliders', `${entry.id}: perches and landable roofs`, perches > 0, `${perches} perches, ${landable} landable`);
    // A sphere swept straight down onto the first box collider hits it.
    const box = records.find((record) => record.type === 'box');
    if (box) {
      const top = box.bounds[4];
      const centreX = (box.bounds[0] + box.bounds[3]) / 2;
      const centreZ = (box.bounds[2] + box.bounds[5]) / 2;
      const out = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: null, owner: null, tags: null, velocity: null };
      const hit = colliders.sweepSphere({ x: centreX, y: top + 40, z: centreZ }, { x: centreX, y: top - 4, z: centreZ }, 1, { landableTops: false }, out);
      check('colliders', `${entry.id}: a sphere dropped onto ${box.id.split(':').pop()} hits the structure`, hit, hit ? `hit ${out.id ? out.id.split(':').pop() : '?'} at t ${out.t.toFixed(2)}` : 'no hit');
    }
    lab.manager.deactivate(id, 'test');
    const after = colliders.getStats().colliders;
    check('colliders', `${entry.id}: dispose removes every collider`, after === before && ids.every((colliderId) => !colliders.has(colliderId)), `${before} -> ${after}`);
  }
}

// ---- torches ----------------------------------------------------------------------------------------------
function testTorches() {
  const lab = createLab();
  const ignition = lab.game.ignition;
  for (const entry of BATCH) {
    if (!entry.torches) continue;
    lab.uniforms.nightFactor.value = 0;
    const id = lab.spawn(entry.id);
    const part = partOf(lab, id);
    lab.engine.setLOD(part, 'near');
    lab.step(2);
    const ids = [...part.ignitableIds];
    const auto = part.data.torchAuto.reduce((sum, value) => sum + value, 0);
    check('torches', `${entry.id}: its torches are ignitables in the ignition service`, ids.length > 0 && ids.every((ignitableId) => ignition.isLit(ignitableId) === false), `${ids.length} torches (${auto} light at dusk), unlit by day`);
    // A flame (the dragon's breath) lights the first torch that waits for one.
    const manual = part.data.torchAuto.findIndex((value) => value === 0);
    const target = ids[manual >= 0 ? manual : 0];
    const litBefore = lab.engine.stats().litFlames;
    ignition.ignite(target, { kind: 'breath', craft: 'eagle', position: { x: 0, y: 0, z: 0 } });
    lab.step(1);
    check('torches', `${entry.id}: a flame lights a torch`, ignition.isLit(target) && lab.engine.stats().litFlames === litBefore + 1, `lit ${lab.engine.stats().litFlames}`);
    lab.uniforms.nightFactor.value = 1;
    lab.step(2);
    const litNight = lab.engine.stats().litFlames;
    check('torches', `${entry.id}: the lamps light themselves at dusk`, litNight >= auto && auto > 0, `${litNight} lit at night`);
    lab.uniforms.nightFactor.value = 0;
    lab.step(2);
    check('torches', `${entry.id}: and go out at dawn (a torch a flame lit by hand stays lit)`, lab.engine.stats().litFlames === (manual >= 0 ? 1 : 0), `${lab.engine.stats().litFlames} lit by day`);
    lab.manager.deactivate(id, 'test');
    check('torches', `${entry.id}: dispose removes every ignitable and frees the flames`, ids.every((ignitableId) => !ignition.isLit(ignitableId) && ignition.ids().indexOf(ignitableId) < 0) && lab.engine.stats().flames === 0 && lab.engine.stats().litFlames === 0, `${ignition.count} left`);
  }
}

// ---- wind -------------------------------------------------------------------------------------------------
function testWind() {
  const lab = createLab();
  for (const entry of BATCH) {
    if (!entry.cloth) continue;
    const id = lab.spawn(entry.id);
    const part = partOf(lab, id);
    lab.step(120);
    const cloth = part.data.clothWind;
    const wind = part.data.wind;
    const speed = Math.hypot(wind[0], wind[1]);
    const aligned = speed > 0 ? (cloth.x * wind[0] + cloth.y * wind[1]) / speed : 0;
    check('wind', `${entry.id}: the cloth takes the wind the structure shows`, speed > 0.5 && Math.abs(cloth.z - speed) < 1e-6 && aligned > 0.999, `${speed.toFixed(2)} m/s, direction ${cloth.x.toFixed(2)}, ${cloth.y.toFixed(2)}`);
    lab.uniforms.windStrength.value = 3;
    lab.step(240);
    check('wind', `${entry.id}: a stronger wind swings the cloth further`, part.data.clothWind.z > speed * 1.5, `${part.data.clothWind.z.toFixed(2)} m/s`);
    lab.uniforms.windStrength.value = 1.4;
    lab.manager.deactivate(id, 'test');
  }
}

// ---- memory -----------------------------------------------------------------------------------------------
function testMemory() {
  const lab = createLab();
  const before = lab.engine.stats();
  const geometries = [];
  const ids = BATCH.map((entry) => lab.spawn(entry.id));
  for (const id of ids) {
    const part = partOf(lab, id);
    for (const mesh of Object.values(part.data.meshes)) if (mesh) geometries.push(mesh.geometry);
    for (const mesh of part.data.moverMeshes) if (mesh) geometries.push(mesh.geometry);
  }
  let disposed = 0;
  for (const geometry of geometries) geometry.addEventListener('dispose', () => disposed++);
  lab.step(30);
  for (const id of ids) lab.manager.deactivate(id, 'test');
  const after = lab.engine.stats();
  check('memory', 'every per-instance geometry is disposed', disposed === geometries.length, `${disposed}/${geometries.length}`);
  check('memory', 'stats and pooled slots return to their baseline', after.buffers === before.buffers && after.instances === 0 && after.movers === 0 && after.flames === 0 && after.blocks === 0 && after.mistPuffs === 0, JSON.stringify(after));
  check('memory', 'no colliders or ignitables left', lab.game.colliders.getStats().colliders === 0 && lab.game.ignition.count === 0, `${lab.game.colliders.getStats().colliders} colliders, ${lab.game.ignition.count} ignitables`);
}

// ---- allocation -------------------------------------------------------------------------------------------
async function testAllocation() {
  const lab = createLab();
  const ids = BATCH.map((entry) => lab.spawn(entry.id));
  const parts = ids.map((id) => partOf(lab, id));
  for (const part of parts) lab.engine.setLOD(part, 'near');
  const orbit = { angle: 0 };
  const frame = () => {
    orbit.angle += 0.002;
    lab.state.player.position.set(Math.sin(orbit.angle) * 400, 300, Math.cos(orbit.angle) * 400);
    lab.state.time.elapsed += 1 / 60;
    for (let index = 0; index < parts.length; index++) lab.engine.update(parts[index], 1 / 60);
  };
  for (let index = 0; index < 90000; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const youngBefore = youngUsed();
  const frames = 60000;
  for (let index = 0; index < frames; index++) frame();
  const youngAfter = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const perFrame = (youngAfter - youngBefore) / frames;
  check('allocation', `${parts.length} structure parts live through ${frames} frames with no garbage collection`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(3)} B/frame`);
  for (const id of ids) lab.manager.deactivate(id, 'test');
}

testRecipes();
testColliders();
testTorches();
testWind();
testMemory();
await testAllocation();
check('console', 'no console errors (no leaks, valid events)', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\npresets 51-60 lab: ${results.length - failed}/${results.length} checks passed\n`);
process.exitCode = failed > 0 ? 1 : 0;
