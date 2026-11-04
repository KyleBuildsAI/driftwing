// Presets 51-60 lab: the batch's structure presets (the monastery, the castle ruin, the observatory,
// the viaduct, the dam, the oasis, the labyrinth and the fireball's scar) run headless in the real
// structure engine inside a real SpawnManager, with the game's real collider world and ignition
// service, on a stub world whose height function applies each preset's own resolved terrain stamps.
// The batch's fauna (the butterflies, the caribou and the oasis camels) run in the real fauna engine
// in the same manager.
//
// Tests:
//   fauna        the butterfly cloud rides the WindField wind (its centre drifts downwind at about the
//                wind speed) as a loose cloud above its floor, and scatters from the craft; the caribou
//                column walks its planned route on the ground, moving with flight time, the same in a
//                second manager
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
// Usage: node --expose-gc tools/lab/presets-51-60.mjs [--verbose] [--only <presetId,presetId,...>]
// --only runs the checks for the named presets alone. Prints one line per check and exits non-zero if
// any check fails.
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
import { applyStampHeight, basinReach } from '../../src/world/stamps.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createColliderWorld } from '../../src/world/colliders.js';
import { createIgnitionService } from '../../src/gameplay/ignition.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { createFaunaEngine } from '../../src/spawns/engines/faunaEngine.js';
import { buildTestSite } from '../../src/dev/structureTestKit.js';
import { PRESETS, PRESET_BY_ID } from '../../src/spawns/presets/index.js';

const VERBOSE = process.argv.includes('--verbose');
let ONLY = null;
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--verbose') continue;
  if (flag === '--only') {
    ONLY = (process.argv[++index] ?? '').split(',').filter(Boolean);
    continue;
  }
  throw new Error(`Unknown flag ${flag}`);
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

/** The batch's presets, in spec order, with what each must show (fauna: its fauna check). */
const ALL_ENTRIES = Object.freeze([
  Object.freeze({ id: 'butterflyMigration', fauna: 'drift' }),
  Object.freeze({ id: 'caribouMigration', fauna: 'column' }),
  Object.freeze({ id: 'cliffsideMonastery', colliders: 8, perches: true, torches: true, cloth: true }),
  Object.freeze({ id: 'seaCliffCastle', colliders: 16, perches: true, torches: true, cloth: true }),
  Object.freeze({ id: 'mountaintopObservatory', colliders: 6, perches: true, movers: 3 }),
  Object.freeze({ id: 'steamTrainViaduct', colliders: 30, perches: true, movers: 4, gates: true }),
  Object.freeze({ id: 'damSpillway', colliders: 10, perches: true }),
]);
const BATCH = ONLY ? ALL_ENTRIES.filter((entry) => ONLY.includes(entry.id)) : ALL_ENTRIES;

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

/** Each batch preset with only its structure and fauna parts (the engines this lab registers). */
function labParts(preset) {
  return Object.freeze({ ...preset, engines: Object.freeze(preset.engines.filter((entry) => entry.engine === 'structure' || entry.engine === 'fauna')) });
}
const LAB_PRESETS = BATCH.map((entry) => labParts(PRESET_BY_ID[entry.id]));
/** Whether a batch entry has a structure part (the structure checks run on those). */
const hasStructure = (entry) => PRESET_BY_ID[entry.id].engines.some((part) => part.engine === 'structure');
/** One test site per preset, 8 km apart on an east-west line. */
const SITES = LAB_PRESETS.map((preset, index) => (preset.kind === 'site'
  ? buildTestSite(preset, { x: index * 8000, z: 0, rotation: 0.5 + index * 0.4, seed: 2000 + index }, { baseHeight, waterLevel: WATER_LEVEL })
  : null));
for (const site of SITES) if (site) for (const stamp of site.stamps) stamps.push(stamp);
const siteOf = (presetId) => SITES.find((site) => site && site.presetId === presetId) ?? null;

/** The lab: a SpawnManager with the structure and fauna engines; withAudio: false runs it without voices. */
function createLab({ withAudio = true } = {}) {
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
    player: { position: new THREE.Vector3(0, 400, 1200), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(0, 0, -1), heading: 0, speed: 60, velocity: new THREE.Vector3(0, 0, -60) },
    flight: { craft: 'glider' },
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
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGPU', wind, audio: withAudio ? audio : null, world, state, sky: null,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB51', surfaces, game,
  });
  const engine = manager.register(createStructureEngine());
  const fauna = manager.register(createFaunaEngine());
  // A stand-in for the celestial engine's skyTarget (the observatory aims at it): sky.direction while
  // sky.kind is 1 (a comet) or 2 (a radiant), nothing while it is 0.
  const sky = { kind: 0, direction: [0, 1, 0] };
  manager.register({
    name: 'celestial',
    budget: { instances: 0, particles: 0 },
    init() {},
    create() { throw new Error('the lab celestial stand-in creates nothing'); },
    update() {},
    setLOD() {},
    dispose() {},
    stats() { return { instances: 0, particles: 0, lights: 0, buffers: 0, drawCalls: 0 }; },
    skyTarget(out) {
      if (sky.kind === 0) return 0;
      out[0] = sky.direction[0];
      out[1] = sky.direction[1];
      out[2] = sky.direction[2];
      return sky.kind;
    },
  });
  for (const preset of LAB_PRESETS) manager.addPreset(preset);
  // The fauna allocation baseline runs on the butterfly preset, so it is there under --only too.
  if (!LAB_PRESETS.some((preset) => preset.id === 'butterflyMigration')) manager.addPreset(labParts(PRESET_BY_ID.butterflyMigration));
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
  /** Puts the player and the camera 600 m from a point, 300 m up (so the manager keeps a site there). */
  function visit(x, z) {
    state.player.position.set(x + 400, groundHeight(x, z) + 300, z + 450);
    camera.position.copy(state.player.position);
    camera.updateMatrixWorld();
  }
  /** Spawns a preset where it belongs (on its site, or an event free-standing ahead), the player near it. */
  function spawn(presetId) {
    const site = siteOf(presetId);
    if (site) {
      visit(site.x, site.z);
      return spawnSite(presetId);
    }
    visit(30000, -4000);
    return spawnFree(presetId, 30000, -4000);
  }
  return { bus, scene, camera, uniforms, state, wind, memory, voices, surfaces, registry, manager, engine, fauna, game, sky, step, spawnSite, spawnFree, spawn, visit };
}

/** The spawn's structure instance (its part with movers), or null. */
function partOf(lab, id) {
  return lab.manager.getParts(id).find((part) => part.data && part.data.moverMeshes !== undefined) ?? null;
}

/** The spawn's fauna instance (its part with an agent pool), or null. */
function faunaOf(lab, id) {
  return lab.manager.getParts(id).find((part) => part.data && part.data.pool !== undefined) ?? null;
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
    if (!hasStructure(entry)) continue;
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
      const hit = colliders.sweepSphere({ x: centreX, y: top + 40, z: centreZ }, { x: centreX, y: top - 4, z: centreZ }, 1, {}, out);
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
    if (auto > 0) {
      check('torches', `${entry.id}: the lamps light themselves at dusk`, litNight >= auto, `${litNight} lit at night`);
    } else {
      check('torches', `${entry.id}: its torches wait for a flame (none light themselves at night)`, litNight === 1, `${litNight} lit at night`);
    }
    lab.uniforms.nightFactor.value = 0;
    lab.step(2);
    check('torches', `${entry.id}: by day only the torch a flame lit burns`, lab.engine.stats().litFlames === 1, `${lab.engine.stats().litFlames} lit by day`);
    lab.manager.deactivate(id, 'test');
    check('torches', `${entry.id}: dispose removes every ignitable and frees the flames`, ids.every((ignitableId) => !ignition.isLit(ignitableId) && ignition.ids().indexOf(ignitableId) < 0) && lab.engine.stats().flames === 0 && lab.engine.stats().litFlames === 0, `${ignition.count} left`);
  }
}

// ---- movers -----------------------------------------------------------------------------------------------
/** The pose of a spawn's mover by name: { x, y, z, yaw, pitch, roll, scale, visible } (local). */
function moverPose(part, name, movers) {
  const index = movers.indexOf(name);
  const poses = part.data.moverState.poses;
  const base = index * 8;
  return { x: poses[base], y: poses[base + 1], z: poses[base + 2], yaw: poses[base + 3], pitch: poses[base + 4], roll: poses[base + 5], scale: poses[base + 6], visible: poses[base + 7] };
}

/** Wrapped angle difference (rad) in [-pi, pi]. */
function angleGap(a, b) {
  let gap = a - b;
  gap -= Math.PI * 2 * Math.floor((gap + Math.PI) / (Math.PI * 2));
  return gap;
}

function testObservatory() {
  const lab = createLab();
  const id = lab.spawn('mountaintopObservatory');
  const part = partOf(lab, id);
  lab.engine.setLOD(part, 'near');
  const movers = ['dome', 'shutter', 'telescope'];
  check('movers', 'observatory: the dome, its shutter and the telescope are movers on pooled meshes', part.data.moverMeshes.length === 3 && part.data.moverMeshes.every(Boolean), `${part.data.moverMeshes.length} movers`);
  lab.uniforms.nightFactor.value = 0;
  lab.step(120);
  check('movers', 'observatory: by day the shutter stays closed', moverPose(part, 'shutter', movers).pitch === 0, `shutter ${moverPose(part, 'shutter', movers).pitch.toFixed(3)} rad`);
  // A comet 40 degrees up in the north-east: the dome opens, turns and the telescope rises to it.
  const azimuth = 50 * Math.PI / 180;
  const elevation = 40 * Math.PI / 180;
  lab.sky.kind = 1;
  lab.sky.direction = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation)];
  lab.uniforms.nightFactor.value = 1;
  const triggers = lab.voices.at(-1).triggers.length;
  lab.step(60 * 90);
  const telescope = moverPose(part, 'telescope', movers);
  const dome = moverPose(part, 'dome', movers);
  const shutter = moverPose(part, 'shutter', movers);
  check('movers', 'observatory: at night the shutter slides open and the latch clunks', shutter.pitch > 1.2 && lab.voices.at(-1).triggers.length > triggers && lab.voices.at(-1).triggers.includes('clunk'), `shutter ${shutter.pitch.toFixed(2)} rad, triggers ${lab.voices.at(-1).triggers.join(', ')}`);
  check('movers', 'observatory: the dome turns its slit and the telescope rises to the comet', Math.abs(angleGap(dome.yaw, azimuth)) < 0.02 && Math.abs(angleGap(telescope.yaw, azimuth)) < 0.02 && Math.abs(telescope.pitch - elevation) < 0.02,
    `dome ${(dome.yaw * 180 / Math.PI).toFixed(1)} deg, telescope ${(telescope.yaw * 180 / Math.PI).toFixed(1)} / ${(telescope.pitch * 180 / Math.PI).toFixed(1)} deg`);
  // The meteor radiant when there is no comet.
  const radiantAzimuth = -100 * Math.PI / 180;
  lab.sky.kind = 2;
  lab.sky.direction = [Math.sin(radiantAzimuth) * Math.cos(0.9), Math.sin(0.9), -Math.cos(radiantAzimuth) * Math.cos(0.9)];
  lab.step(60 * 90);
  const toRadiant = moverPose(part, 'telescope', movers);
  check('movers', 'observatory: with no comet it follows the meteor radiant', Math.abs(angleGap(toRadiant.yaw, radiantAzimuth)) < 0.02 && Math.abs(toRadiant.pitch - 0.9) < 0.02, `${(toRadiant.yaw * 180 / Math.PI).toFixed(1)} / ${(toRadiant.pitch * 180 / Math.PI).toFixed(1)} deg`);
  check('movers', 'observatory: the mover meshes carry the pose (anchor + local, turned)', part.data.moverMeshes[2].matrix.elements[12] !== 0 && part.data.moverMeshes.every((mesh) => mesh.visible), `x ${part.data.moverMeshes[2].matrix.elements[12].toFixed(1)}`);
  lab.engine.setLOD(part, 'far');
  check('movers', 'observatory: the movers hide at the far tier', part.data.moverMeshes.every((mesh) => !mesh.visible), '');
  lab.engine.setLOD(part, 'mid');
  lab.step(2);
  check('movers', 'observatory: and show again at mid', part.data.moverMeshes.every((mesh) => mesh.visible), '');
  lab.uniforms.nightFactor.value = 0;
  lab.step(60 * 30);
  check('movers', 'observatory: at dawn it parks and closes', moverPose(part, 'shutter', movers).pitch === 0, `shutter ${moverPose(part, 'shutter', movers).pitch.toFixed(3)} rad`);
  lab.sky.kind = 0;
  lab.manager.deactivate(id, 'test');
}

/** The train's cars (its movers, in order: locomotive, tender, coaches) on a viaduct spawn. */
function trainPoses(part) {
  const count = part.data.moverMeshes.length;
  const poses = [];
  for (let index = 0; index < count; index++) {
    const base = index * 8;
    const list = part.data.moverState.poses;
    poses.push({ x: list[base], y: list[base + 1], z: list[base + 2], yaw: list[base + 3], visible: list[base + 7] });
  }
  return poses;
}

function testViaduct() {
  const lab = createLab();
  const id = lab.spawn('steamTrainViaduct');
  const part = partOf(lab, id);
  lab.engine.setLOD(part, 'near');
  const custom = part.data.moverState.custom;
  const cars = part.data.moverMeshes.length;
  check('movers', 'viaduct: the locomotive, tender and coaches are movers with colliders that follow them', cars >= 4 && part.data.moverColliderIds.length === cars, `${cars} cars, ${part.data.moverColliderIds.length} car colliders`);
  check('movers', 'viaduct: every arch with headroom is a pass-under gate with the achievement', part.data.gates !== null && part.data.gateMeta.length >= 3 && part.data.gateMeta.every((gate) => gate.kind === 'under' && gate.achievement && gate.achievement.id === 'underTheArches'), `${part.data.gateMeta.length} arch gates`);
  // A full cycle at 10 Hz: the train shows on the viaduct, hides in each tunnel, and whistles out.
  const voice = lab.voices.at(-1);
  const period = custom.follower.period;
  let shownFrames = 0;
  let hiddenFrames = 0;
  let maxPuffs = 0;
  let maxLevel = 0;
  const loco = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const steps = Math.ceil(period * 10) + 20;
  for (let step = 0; step < steps; step++) {
    lab.step(6, 1 / 60);
    const pose = trainPoses(part)[0];
    if (pose.visible === 1) {
      shownFrames++;
      loco.minX = Math.min(loco.minX, pose.x);
      loco.maxX = Math.max(loco.maxX, pose.x);
      loco.minZ = Math.min(loco.minZ, pose.z);
      loco.maxZ = Math.max(loco.maxZ, pose.z);
    } else {
      hiddenFrames++;
    }
    const steam = part.data.moverState.steam;
    let puffs = 0;
    for (let index = 3; index < steam.length; index += 4) if (steam[index] > 0) puffs++;
    maxPuffs = Math.max(maxPuffs, puffs);
    maxLevel = Math.max(maxLevel, part.data.moverState.level[0]);
  }
  const crossed = Math.hypot(loco.maxX - loco.minX, loco.maxZ - loco.minZ);
  check('movers', 'viaduct: over one cycle the train crosses in the open and waits hidden in the tunnels', shownFrames > 0 && hiddenFrames > 0 && crossed > 100, `period ${period.toFixed(0)} s, shown ${shownFrames}, hidden ${hiddenFrames} samples, crossed ${crossed.toFixed(0)} m`);
  const whistles = voice.triggers.filter((name) => name === 'whistle').length;
  check('movers', 'viaduct: it whistles as it leaves a tunnel, steams in the open and the chuff follows its speed', whistles >= 1 && maxPuffs >= 6 && maxLevel > 0.9, `${whistles} whistles, up to ${maxPuffs} steam puffs, level up to ${maxLevel.toFixed(2)}`);
  // The car colliders follow the cars.
  const colliders = lab.game.colliders;
  const first = colliders.get(part.data.moverColliderIds[0]);
  const pose = trainPoses(part)[0];
  const centreX = (first.bounds[0] + first.bounds[3]) / 2;
  const centreZ = (first.bounds[2] + first.bounds[5]) / 2;
  check('movers', 'viaduct: the locomotive collider rides with the locomotive', Math.hypot(centreX - (part.anchor.x + pose.x), centreZ - (part.anchor.z + pose.z)) < 1, `collider ${centreX.toFixed(1)}, ${centreZ.toFixed(1)} vs ${(part.anchor.x + pose.x).toFixed(1)}, ${(part.anchor.z + pose.z).toFixed(1)}`);
  // Determinism: a second manager at the same flight time puts the train in the same place.
  const other = createLab();
  other.state.time.elapsed = lab.state.time.elapsed - 1 / 60;
  const otherId = other.spawn('steamTrainViaduct');
  const otherPart = partOf(other, otherId);
  other.engine.setLOD(otherPart, 'near');
  other.step(1, 1 / 60);
  const a = trainPoses(part)[1];
  const b = trainPoses(otherPart)[1];
  check('movers', 'viaduct: the same flight time gives the same train in a second manager', Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6, `${a.x.toFixed(2)}, ${a.z.toFixed(2)} vs ${b.x.toFixed(2)}, ${b.z.toFixed(2)}`);
  other.manager.deactivate(otherId, 'test');
  lab.engine.setLOD(part, 'far');
  check('movers', 'viaduct: the train hides at the far tier', part.data.moverMeshes.every((mesh) => !mesh.visible), '');
  lab.manager.deactivate(id, 'test');
}

function testDam() {
  const lab = createLab();
  const id = lab.spawn('damSpillway');
  const part = partOf(lab, id);
  const site = siteOf('damSpillway');
  const basin = site.stamps[0];
  const colliders = lab.game.colliders;
  const walls = part.colliderIds.map((colliderId) => colliders.get(colliderId)).filter((record) => record.id.includes(':wall'));
  // Every wall hull stands outside the reservoir's shoreline (no lake water below the dam).
  let inside = 0;
  for (const wall of walls) {
    const [minX, , minZ, maxX, , maxZ] = wall.bounds;
    for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ], [(minX + maxX) / 2, (minZ + maxZ) / 2]]) {
      if (basinReach(basin, x, z) < basin.radius - 30) inside++;
    }
  }
  check('recipes', 'dam: the wall stands on the down-valley rim of the reservoir, outside its shoreline', walls.length >= 3 && inside === 0, `${walls.length} wall hulls, ${inside} points inside the shoreline`);
  const water = part.data.meshes.water;
  check('recipes', 'dam: the spillway chute and the river are water, the spray mist puffs at its foot', Boolean(water) && water.geometry.attributes.position.count >= 60 && part.data.puffSlots.length >= 8, `${water ? water.geometry.attributes.position.count : 0} water vertices, ${part.data.puffSlots.length} mist puffs`);
  const crest = walls.reduce((high, wall) => Math.max(high, wall.bounds[4]), -Infinity) - part.anchor.y;
  const toe = walls.reduce((low, wall) => Math.min(low, wall.bounds[1]), Infinity) - part.anchor.y;
  check('recipes', 'dam: the crest stands above the rim and the face reaches down to the valley', crest > basin.rimY - part.anchor.y && crest - toe > 4, `crest ${crest.toFixed(1)} m, toe ${toe.toFixed(1)} m, rim ${(basin.rimY - part.anchor.y).toFixed(1)} m (local)`);
  lab.manager.deactivate(id, 'test');
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
  const ids = BATCH.filter(hasStructure).map((entry) => lab.spawn(entry.id));
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
/**
 * The young generation's growth per frame over `frames` frames of `frame`, after `warm` frames of JIT
 * warm-up and a full collection, and the collections seen meanwhile.
 */
async function measureAllocation(frame, warm, frames) {
  for (let index = 0; index < warm; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const youngBefore = youngUsed();
  for (let index = 0; index < frames; index++) frame();
  const youngAfter = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  return { collections, perFrame: (youngAfter - youngBefore) / frames };
}

async function testAllocation() {
  const lab = createLab();
  const ids = BATCH.filter(hasStructure).map((entry) => lab.spawn(entry.id));
  const parts = ids.map((id) => partOf(lab, id));
  for (const part of parts) lab.engine.setLOD(part, 'near');
  const orbit = { angle: 0 };
  const frame = () => {
    orbit.angle += 0.002;
    lab.state.player.position.set(Math.sin(orbit.angle) * 400, 300, Math.cos(orbit.angle) * 400);
    lab.state.time.elapsed += 1 / 60;
    for (let index = 0; index < parts.length; index++) lab.engine.update(parts[index], 1 / 60);
  };
  if (parts.length > 0) {
    const frames = 60000;
    const { collections, perFrame } = await measureAllocation(frame, 90000, frames);
    check('allocation', `${parts.length} structure parts live through ${frames} frames with no garbage collection`, collections === 0, `${collections} collections`);
    check('allocation', 'structure: the young generation grows under 0.1 byte per frame', collections === 0 && perFrame < 0.1, `${perFrame.toFixed(3)} B/frame`);
  }
  for (const id of ids) lab.manager.deactivate(id, 'test');
}

/**
 * The batch's fauna groups (the butterflies, the caribou, the camels) at a few dozen agents each,
 * through the fauna engine's own update (as the structure parts are measured), against a
 * baseline: the butterfly preset as a plain Phase 2 starling flock (no wind drift). Runs first, on a
 * fresh heap. A drifting group reads the field's ambient layer once at create and the craft's gusts
 * per frame, so it adds nothing.
 */
async function testFaunaAllocation() {
  const faunaEntries = BATCH.filter((entry) => PRESET_BY_ID[entry.id].engines.some((part) => part.engine === 'fauna'));
  const measureHerds = async (overrides) => {
    const herdLab = createLab({ withAudio: false });
    herdLab.visit(70000, 0);
    const spawned = overrides.map(({ presetId, params }, index) => {
      const x = 70000 + index * 300;
      return herdLab.manager.activate(presetId, { position: { x, y: groundHeight(x, 0), z: 0 }, heading: 40, source: 'debug', force: true, duration: 1e6, params: { fauna: params } });
    });
    // The camera follows the first group (the butterflies drift kilometres downwind), in whole metres.
    const lead = faunaOf(herdLab, spawned[0]);
    const counter = new Int32Array(1);
    const groups = spawned.map((id) => faunaOf(herdLab, id));
    const herdFrame = () => {
      herdLab.state.time.elapsed += 1 / 60;
      for (let index = 0; index < groups.length; index++) herdLab.fauna.update(groups[index], 1 / 60);
      counter[0]++;
      if (counter[0] % 600 !== 0) return;
      herdLab.state.player.position.set(lead.anchor.x, lead.anchor.y + 150, lead.anchor.z + 300);
      herdLab.camera.position.copy(herdLab.state.player.position);
    };
    // The median of three windows after one warm-up (single windows swing with V8's own work).
    const windows = [await measureAllocation(herdFrame, 150000, 50000)];
    windows.push(await measureAllocation(herdFrame, 0, 50000), await measureAllocation(herdFrame, 0, 50000));
    windows.sort((first, second) => first.perFrame - second.perFrame);
    const measured = { perFrame: windows[1].perFrame, collections: windows.reduce((sum, window) => sum + window.collections, 0) };
    const agents = spawned.reduce((sum, id) => sum + faunaOf(herdLab, id).data.count, 0);
    for (const id of spawned) herdLab.manager.deactivate(id, 'test');
    return { ...measured, groups: spawned.length, agents };
  };
  if (faunaEntries.length > 0) {
    const baseline = await measureHerds([{ presetId: 'butterflyMigration', params: { species: 'starling', windDrift: 0, count: 48 } }]);
    const measured = await measureHerds(faunaEntries.map((entry) => ({ presetId: entry.id, params: { count: 48 } })));
    const perGroup = measured.perFrame / measured.groups;
    check('allocation', `fauna: ${measured.groups} groups (${measured.agents} agents) allocate per group and frame no more than a Phase 2 flock`, perGroup <= baseline.perFrame + 0.5,
      `${perGroup.toFixed(3)} B per group and frame (median of 3 windows), Phase 2 flock ${baseline.perFrame.toFixed(3)} B; ${measured.collections} collections over 150 000 frames`);
  }
}

// ---- fauna ------------------------------------------------------------------------------------------------
/** Puts the player and the camera at a fauna group's centre, 120 m up (the group stays near). */
function followGroup(lab, id) {
  const centre = lab.fauna.describe(id).center;
  lab.state.player.position.set(Math.round(centre.x), Math.round(centre.y + 120), Math.round(centre.z + 200));
  lab.camera.position.copy(lab.state.player.position);
  lab.camera.updateMatrixWorld();
}

function testButterflies() {
  const lab = createLab();
  const x = 40000;
  const z = -3000;
  lab.visit(x, z);
  const id = lab.spawnFree('butterflyMigration', x, z, 0);
  const part = faunaOf(lab, id);
  lab.fauna.setLOD(part, 'near');
  for (let second = 0; second < 20; second++) {
    lab.step(60);
    followGroup(lab, id);
  }
  const before = lab.fauna.describe(id).center;
  const ambient = lab.wind.ambientAt({ x: before.x, y: before.y, z: before.z });
  const toward = (ambient.fromDegrees + 180) * Math.PI / 180;
  const downX = Math.sin(toward);
  const downZ = -Math.cos(toward);
  const seconds = 60;
  for (let second = 0; second < seconds; second++) {
    lab.step(60);
    followGroup(lab, id);
  }
  const after = lab.fauna.describe(id);
  const along = (after.center.x - before.x) * downX + (after.center.z - before.z) * downZ;
  const across = Math.abs((after.center.x - before.x) * -downZ + (after.center.z - before.z) * downX);
  const expected = ambient.speed * seconds;
  check('fauna', 'butterflies: the cloud drifts downwind with the WindField wind', along > expected * 0.5 && along < expected * 1.6 + 200, `${along.toFixed(0)} m downwind in ${seconds} s (wind ${ambient.speed.toFixed(1)} m/s: ${expected.toFixed(0)} m), ${across.toFixed(0)} m across`);
  check('fauna', 'butterflies: a loose cloud, not a ball nor a scatter', after.radius > 8 && after.radius < 260, `radius ${after.radius.toFixed(1)} m, ${after.count} butterflies`);
  const pool = part.data.pool;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let index = part.data.start; index < part.data.start + part.data.count; index++) {
    const above = pool.py[index] - groundHeight(pool.px[index], pool.pz[index]);
    lowest = Math.min(lowest, above);
    highest = Math.max(highest, above);
  }
  check('fauna', 'butterflies: they flutter low over the land, above their floor', lowest >= 2.5 && highest < 160, `${lowest.toFixed(1)}..${highest.toFixed(1)} m above the ground`);
  const scatters = [];
  lab.bus.on('fauna:scatter', (payload) => scatters.push(payload));
  const centre = lab.fauna.describe(id).center;
  for (let frame = 0; frame < 180; frame++) {
    const share = frame / 180;
    lab.state.player.position.set(centre.x - 200 + 400 * share, centre.y, centre.z);
    lab.state.player.velocity.set(133, 0, 0);
    lab.camera.position.copy(lab.state.player.position);
    lab.camera.updateMatrixWorld();
    lab.step(1);
  }
  check('fauna', 'butterflies: a craft flying through scatters them', scatters.length > 0, `${scatters.length} scatter events, ${scatters[0] ? scatters[0].count : 0} butterflies`);
  lab.manager.deactivate(id, 'test');
  check('fauna', 'butterflies: dispose frees the group and its voice', lab.fauna.stats().instances === 0 && lab.voices.every((voice) => voice.disposed), `${lab.fauna.stats().instances} groups left`);
}

/** A caribou column spawned free-standing and walked for `seconds` of flight time. */
function walkCaribou(seconds) {
  const lab = createLab();
  const x = 52000;
  const z = 6000;
  lab.visit(x, z);
  const id = lab.spawnFree('caribouMigration', x, z, 70);
  const part = faunaOf(lab, id);
  lab.fauna.setLOD(part, 'near');
  lab.step(60 * seconds);
  return { lab, id, part };
}

function testCaribou() {
  const first = walkCaribou(30);
  const describe = first.lab.fauna.describe(first.id);
  const pool = first.part.data.pool;
  let offGround = 0;
  for (let index = first.part.data.start; index < first.part.data.start + first.part.data.count; index++) {
    if (Math.abs(pool.py[index] - groundHeight(pool.px[index], pool.pz[index])) > 0.5) offGround++;
  }
  check('fauna', 'caribou: a long column walks its planned route on the ground', describe.count >= 320 && describe.pathLength > 2500 && offGround === 0, `${describe.count} caribou, route ${describe.pathLength.toFixed(0)} m, ${offGround} off the ground`);
  const centreBefore = { ...describe.center };
  first.lab.step(60 * 30);
  const centreAfter = first.lab.fauna.describe(first.id).center;
  const moved = Math.hypot(centreAfter.x - centreBefore.x, centreAfter.z - centreBefore.z);
  check('fauna', 'caribou: the column moves on with flight time', moved > 20, `${moved.toFixed(0)} m in 30 s`);
  const second = walkCaribou(60);
  const other = second.lab.fauna.describe(second.id).center;
  check('fauna', 'caribou: the same flight time gives the same column in a second manager', Math.abs(centreAfter.x - other.x) < 1e-6 && Math.abs(centreAfter.z - other.z) < 1e-6, `${centreAfter.x.toFixed(2)}, ${centreAfter.z.toFixed(2)} vs ${other.x.toFixed(2)}, ${other.z.toFixed(2)}`);
  first.lab.manager.deactivate(first.id, 'test');
  check('fauna', 'caribou: dispose frees the column and its voice', first.lab.voices.every((voice) => voice.disposed) && first.lab.fauna.stats().instances === 0, `${first.lab.fauna.stats().instances} groups left`);
  second.lab.manager.deactivate(second.id, 'test');
}

await testFaunaAllocation();
if (BATCH.some((entry) => entry.fauna === 'drift')) testButterflies();
if (BATCH.some((entry) => entry.fauna === 'column')) testCaribou();
testRecipes();
testColliders();
testTorches();
if (BATCH.some((entry) => entry.id === 'mountaintopObservatory')) testObservatory();
if (BATCH.some((entry) => entry.id === 'steamTrainViaduct')) testViaduct();
if (BATCH.some((entry) => entry.id === 'damSpillway')) testDam();
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
