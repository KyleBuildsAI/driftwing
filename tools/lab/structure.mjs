// StructureEngine lab: runs the structure engine headless (node, three's node materials without a
// renderer) inside a real SpawnManager, on a stub world whose height function applies the test
// sites' resolved terrain stamps (src/world/stamps.js), as worldgen does.
//
// Tests:
//   recipes      every recipe builds on its real stamped site and free-standing (a debug spawn), with
//                finite geometry, the expected parts and the same geometry for the same seed
//   params       bad params are refused with an error naming the preset and the param
//   stamps       the airfield strip lies on its flatten stamp, the bridge spans its gorge between the
//                lips above the floor, the canyon course gates span the carve's ends; structureStamps
//                names each recipe's stamps, refuses bad options, and islands hover over their islets
//   gates        flying under the bridge fires the gate and the achievement once; over it and a
//                teleport do not; flying between two spires rings a chime
//   course       start -> finish reports the time; a soft crash in between spoils a clean run
//   landing      a touchdown on the runway is graded (score, centreline, threshold distance); one
//                beside it is not
//   surfaces     island tops are registered, stand on exactly the rendered top mesh (within 0.3 m),
//                count only from above, and are removed on dispose
//   groundStart  a discovered airfield offers its thresholds, facing down the runway
//   wind         the wind farm's wake is a WindField source at the near and mid tiers (slower, turbulent
//                air downwind of a rotor), gone at the far tier and after dispose
//   lod          detail shows only near; heavy islands hide at far (the lure takes over)
//   memory       every per-instance geometry is disposed and every pooled slot returned
//   cost         per recipe: update() CPU time per instance, triangles, instanced parts, draw calls
//   allocation   after a JIT warm-up, 100 000 frames of six structures (turbines turning, windsock,
//                sway, gates, audio) allocate nothing
//
// Usage: node --expose-gc tools/lab/structure.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';
import { createWindField } from '../../src/env/WindField.js';
import { validatePresets } from '../../src/spawns/schema.js';
import { createEngineRegistry } from '../../src/spawns/engineRegistry.js';
import { createSpawnManager } from '../../src/spawns/spawnManager.js';
import { applyStampHeight } from '../../src/world/stamps.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { createStructureEngine } from '../../src/spawns/engines/structureEngine.js';
import { buildTestSite, createStructureTestPresets } from '../../src/dev/structureTestKit.js';
import { RECIPE_STAMP_TYPES, structureStamps } from '../../src/spawns/engines/structure/stamps.js';

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

// ---- Stub world: gentle hills at about 120 m, with the test sites' stamps applied --------------------
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

const PRESETS = createStructureTestPresets();
const presetById = new Map(PRESETS.map((preset) => [preset.id, preset]));
/** The test sites: one per preset, 6 km apart on an east-west line. */
const SITES = PRESETS.map((preset, index) => buildTestSite(preset, { x: index * 6000, z: 0, rotation: 0.4 + index * 0.3, seed: 1000 + index }, { baseHeight, waterLevel: WATER_LEVEL }));
for (const site of SITES) for (const stamp of site.stamps) stamps.push(stamp);
const siteOf = (presetId) => SITES.find((site) => site.presetId === presetId);

function createLab() {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xe0b48c, 400, 9000);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 9000);
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
  };
  const state = {
    seed: 'LAB',
    time: { elapsed: 0, sunElevation: 30, dayTime: 0.4, nightFactor: 0, goldenFactor: 0 },
    player: { position: new THREE.Vector3(0, 400, 1200), forward: new THREE.Vector3(0, 0, -1), heading: 0, speed: 60 },
  };
  const wind = createWindField({ world, uniforms, state, bus });
  const memory = { geometries: 0, textures: 0, attributes: 0, programs: 0, total: 0 };
  const voices = [];
  const audio = {
    spawnVoice(recipe) {
      // Numbers land in a typed array, so the mock itself allocates nothing per call.
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
  const surfaces = createGroundSurfaces();
  const registry = createEngineRegistry();
  const manager = createSpawnManager({
    THREE, TSL, scene, camera, renderer: { info: { memory } }, backend: 'WebGPU', wind, audio, world, state, sky: null,
    bus, perf: null, settings: null, uniforms, registry, presets: [], seed: 'LAB', surfaces,
  });
  const engine = manager.register(createStructureEngine());
  for (const preset of PRESETS) manager.addPreset(preset);
  manager.init();
  const events = { gates: [], achievements: [], courses: [], landings: [], notify: [], windAdded: [], windRemoved: [], journal: [] };
  bus.on('structure:gate', (payload) => events.gates.push(payload));
  bus.onTyped('achievement', (payload) => events.achievements.push(payload));
  bus.onTyped('journalStat', (payload) => events.journal.push(payload));
  bus.on('structure:course', (payload) => events.courses.push(payload));
  bus.on('structure:landing', (payload) => events.landings.push(payload));
  bus.on('notify', (payload) => events.notify.push(payload));
  bus.onTyped('windSourceAdded', (payload) => events.windAdded.push(payload));
  bus.onTyped('windSourceRemoved', (payload) => events.windRemoved.push(payload));
  function step(frames = 1, dt = 1 / 60) {
    for (let frame = 0; frame < frames; frame++) {
      state.time.elapsed += dt;
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
  /** Flies the player (and camera) along a straight line in `frames` frames. */
  function fly(from, to, frames = 60) {
    for (let frame = 0; frame <= frames; frame++) {
      const t = frame / frames;
      state.player.position.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      camera.position.copy(state.player.position);
      step(1);
    }
  }
  function teleport(point) {
    state.player.position.set(point.x, point.y, point.z);
    camera.position.set(point.x, point.y, point.z);
    step(1);
  }
  return { bus, scene, camera, uniforms, state, wind, memory, voices, surfaces, registry, manager, engine, events, step, spawnSite, spawnFree, fly, teleport };
}

function expectThrow(fn, pattern) {
  try {
    fn();
  } catch (error) {
    return pattern.test(error.message) ? '' : `wrong message: ${error.message}`;
  }
  return 'did not throw';
}

function partsOf(lab, id) {
  return lab.manager.getParts(id)[0];
}

function geometryHash(mesh) {
  if (!mesh) return 'none';
  const array = mesh.geometry.attributes.position.array;
  let hash = 2166136261;
  for (let index = 0; index < array.length; index += 7) hash = Math.imul(hash ^ Math.round(array[index] * 100), 16777619) >>> 0;
  return `${array.length}:${hash.toString(16)}`;
}

function finiteGeometry(mesh) {
  if (!mesh) return true;
  const array = mesh.geometry.attributes.position.array;
  for (let index = 0; index < array.length; index++) if (!Number.isFinite(array[index])) return false;
  return true;
}

// ---- recipes ----------------------------------------------------------------------------------------------
function testRecipes() {
  let valid = '';
  try {
    validatePresets(PRESETS, { engineNames: ['structure'] });
  } catch (error) {
    valid = error.message;
  }
  check('recipes', `${PRESETS.length} kit presets validate`, valid === '', valid);
  const lab = createLab();
  for (const preset of PRESETS) {
    const siteId = lab.spawnSite(preset.id);
    const freeId = lab.spawnFree(preset.id, 40000, -3000);
    const site = partsOf(lab, siteId);
    const free = partsOf(lab, freeId);
    const ok = site && free && finiteGeometry(site.data.meshes.body) && finiteGeometry(free.data.meshes.body) && site.data.meshes.body && free.data.meshes.body;
    check('recipes', `${preset.id}: builds on its site and free-standing`, ok, site ? `body ${site.data.meshes.body.geometry.attributes.position.count} vertices, radius ${Math.round(site.radius)} m` : 'no instance');
    const again = lab.manager.activate(preset.id, { position: { x: 80000, y: 0, z: 0 }, heading: 30, source: 'debug', force: true, seed: free.data.serial });
    lab.manager.deactivate(again, 'test');
    lab.manager.deactivate(siteId, 'test');
    lab.manager.deactivate(freeId, 'test');
  }
  // Determinism: the same site and seed build the same geometry.
  const first = lab.spawnSite('devIslands');
  const hashA = geometryHash(partsOf(lab, first).data.meshes.body);
  lab.manager.deactivate(first, 'test');
  const second = lab.spawnSite('devIslands');
  const hashB = geometryHash(partsOf(lab, second).data.meshes.body);
  lab.manager.deactivate(second, 'test');
  check('recipes', 'the same site builds the same geometry', hashA === hashB && hashA !== 'none', `${hashA} / ${hashB}`);
  const farm = lab.spawnSite('devWindFarm');
  const farmData = partsOf(lab, farm).data;
  check('recipes', 'wind farm: six turbines on nacelle and rotor slots, a turbine voice', farmData.turbineCount === 6 && farmData.rotorSlots.length === 6 && lab.voices.at(-1).recipe === 'turbine', `${farmData.turbineCount} turbines`);
  lab.manager.deactivate(farm, 'test');
  const airfield = lab.spawnSite('devAirfield');
  const airfieldData = partsOf(lab, airfield).data;
  check('recipes', 'airfield: runway zone, windsock, decal paint and hangars', airfieldData.zones.length === 1 && airfieldData.sockCount === 1 && airfieldData.meshes.decal && airfieldData.meshes.body, `${airfieldData.zones.length} zones, ${airfieldData.sockCount} socks`);
  lab.manager.deactivate(airfield, 'test');
  const spires = lab.spawnSite('devSpires');
  const spireData = partsOf(lab, spires).data;
  check('recipes', 'spires: glowing crystal geometry, chime gates, a crystal voice', spireData.meshes.glow && spireData.gateMeta.some((gate) => gate.action === 'chime') && lab.voices.at(-1).recipe === 'crystal', `${spireData.gateMeta.length} gates`);
  lab.manager.deactivate(spires, 'test');
  const islands = lab.spawnSite('devIslands');
  const islandData = partsOf(lab, islands).data;
  check('recipes', 'islands: water ribbons, mist puffs, three landable tops', islandData.meshes.water && islandData.puffSlots.length > 0 && islandData.surfaceIds.length === 3, `${islandData.puffSlots.length} puffs, ${islandData.surfaceIds.length} surfaces`);
  lab.manager.deactivate(islands, 'test');
  check('recipes', 'every voice was disposed with its spawn', lab.voices.every((voice) => voice.disposed), `${lab.voices.filter((voice) => !voice.disposed).length} left`);
}

// ---- params -----------------------------------------------------------------------------------------------
function testParams() {
  const lab = createLab();
  const base = presetById.get('devWindFarm');
  const variant = (id, params) => Object.freeze({ ...base, id, engines: Object.freeze([Object.freeze({ engine: 'structure', params: Object.freeze(params) })]) });
  const cases = [
    ['missing recipe', variant('badRecipeA', {}), /structure preset "badRecipeA": param "params\.recipe" is required/],
    ['unknown recipe', variant('badRecipeB', { recipe: 'castle' }), /param "params\.recipe" must be one of windFarm/],
    ['count out of range', variant('badCount', { recipe: 'windFarm', count: 40 }), /"badCount": param "params\.count" must be within 1\.\.16, got 40/],
    ['rated wind under cut-in', variant('badRated', { recipe: 'windFarm', cutIn: 8, ratedWind: 6 }), /param "params\.ratedWind" must be above cutIn/],
    ['nested wake param', variant('badWake', { recipe: 'windFarm', wake: { length: 90 } }), /"badWake": param "params\.wake\.length" must be within 1\.\.30/],
    ['gate list entry', variant('badGate', { recipe: 'windFarm', gates: [{ id: 'g', halfWidth: -1 }] }), /param "params\.gates\[0\]\.halfWidth" must be within/],
    ['journal statistic name', variant('badJournal', { recipe: 'gates', journal: 'Best run' }), /"badJournal": param "params\.journal" must be a camelCase journal statistic name/],
  ];
  for (const [name, preset, pattern] of cases) {
    const detail = expectThrow(() => lab.engine.create(preset, { ...preset.engines[0].params, position: new THREE.Vector3(), heading: 0, site: null }, () => 0.5), pattern);
    check('params', `refused: ${name}`, detail === '', detail);
  }
}

// ---- stamps -----------------------------------------------------------------------------------------------
function testStamps() {
  const lab = createLab();
  const airfieldSite = siteOf('devAirfield');
  const flatten = airfieldSite.stamps[0];
  const airfield = lab.spawnSite('devAirfield');
  const zone = partsOf(lab, airfield).data.zones[0];
  check('stamps', 'the runway zone is the flatten stamp (centre, direction, length, level)',
    Math.hypot(zone.x - flatten.x, zone.z - flatten.z) < 0.01 && Math.abs(zone.dirX - flatten.dirX) < 1e-9 && Math.abs(zone.halfLength * 2 - flatten.length) < 0.01 && Math.abs(zone.y - flatten.y) < 0.01,
    `${zone.halfLength * 2} m at ${zone.y.toFixed(1)} m`);
  const decal = partsOf(lab, airfield).data.meshes.decal.geometry.attributes.position;
  let maxLift = 0;
  let minLift = Infinity;
  for (let index = 0; index < decal.count; index++) {
    const lift = decal.getY(index) + airfieldSite.groundY - flatten.y;
    maxLift = Math.max(maxLift, lift);
    minLift = Math.min(minLift, lift);
  }
  check('stamps', 'the tarmac and markings lie 0.1-0.2 m over the flattened strip', minLift > 0.05 && maxLift < 0.25, `${minLift.toFixed(3)}..${maxLift.toFixed(3)} m`);
  lab.manager.deactivate(airfield, 'test');

  const bridgeSite = siteOf('devRopeBridge');
  const gorge = bridgeSite.stamps[0];
  const bridge = lab.spawnSite('devRopeBridge');
  const data = partsOf(lab, bridge).data;
  const gate = data.gates.data;
  const middleDeck = data.gates.data[6];
  check('stamps', 'the gorge fits and the bridge gate spans its floor to the deck',
    gorge.fits && Math.abs(gate[5] - (gorge.floorY - 5)) < 0.5 && middleDeck < gorge.rimY && middleDeck > gorge.floorY + 20,
    `floor ${gorge.floorY.toFixed(1)}, rim ${gorge.rimY.toFixed(1)}, gate top ${middleDeck.toFixed(1)}`);
  const halfWidth = gate[4];
  check('stamps', 'the bridge spans the gorge between its lips (span within the anchor span)', halfWidth * 2 > gorge.halfWidth * 2 * 0.8 && halfWidth * 2 <= gorge.span, `span ${(halfWidth * 2).toFixed(1)} m, gorge ${(gorge.halfWidth * 2).toFixed(1)} m, anchors ${gorge.span.toFixed(1)} m`);
  lab.manager.deactivate(bridge, 'test');

  const canyonSite = siteOf('devCanyonGates');
  const carve = canyonSite.stamps[0];
  const canyon = lab.spawnSite('devCanyonGates');
  const gates = partsOf(lab, canyon).data.gates.data;
  check('stamps', 'the course gates stand at the canyon entry and exit',
    Math.hypot(gates[0] - carve.entry.x, gates[1] - carve.entry.z) < 0.01 && Math.hypot(gates[8] - carve.exit.x, gates[9] - carve.exit.z) < 0.01,
    `entry ${carve.entry.x.toFixed(0)},${carve.entry.z.toFixed(0)}`);
  lab.manager.deactivate(canyon, 'test');

  // structureStamps: the stamps a recipe needs, as preset data placement resolves on both threads.
  const types = Object.fromEntries(Object.keys(RECIPE_STAMP_TYPES).map((recipe) => [recipe, structureStamps(recipe).map((spec) => spec.type).join('+') || 'none']));
  check('stamps', 'structureStamps names the stamp each recipe reads (none for the wind farm and the spires)',
    types.windFarm === 'none' && types.spires === 'none' && types.ropeBridge === 'gorge' && types.airfield === 'flatten' && types.islands === 'islandBase' && types.gates === 'carve', JSON.stringify(types));
  const custom = structureStamps('airfield', { length: [1500, 1600], paint: null });
  check('stamps', 'options override the preferred sizes of a recipe', custom[0].length[0] === 1500 && custom[0].paint === null && Object.isFrozen(custom), JSON.stringify(custom[0]));
  const refusals = [
    expectThrow(() => structureStamps('castle'), /unknown recipe "castle"/),
    expectThrow(() => structureStamps('airfield', { width: [60, 40] }), /stamps\[0\]\.width/),
    expectThrow(() => structureStamps('islands', { islets: 9 }), /islets/),
  ].filter(Boolean);
  check('stamps', 'structureStamps refuses an unknown recipe, a bad size and too many islets', refusals.length === 0, refusals.join('; '));
  // Three islets: the first three floating islands hover over them (the islets' resolved tops).
  const isletPreset = { ...presetById.get('devIslands'), id: 'devIslets', stamps: structureStamps('islands', { islets: 3, spread: 520 }) };
  const isletSite = buildTestSite(isletPreset, { x: 60000, z: 9000, rotation: 1.1, seed: 4242 }, { baseHeight, waterLevel: WATER_LEVEL });
  lab.manager.addPreset(isletPreset);
  const islets = lab.manager.activate('devIslets', { position: { x: isletSite.x, y: isletSite.groundY, z: isletSite.z }, source: 'site', site: isletSite });
  const centres = lab.surfaces.list().map((surface) => ({ x: (surface.minX + surface.maxX) / 2, z: (surface.minZ + surface.maxZ) / 2 }));
  const hovering = isletSite.stamps.filter((islet) => centres.some((centre) => Math.hypot(centre.x - islet.x, centre.z - islet.z) < 0.01));
  check('stamps', 'three islet stamps: an island hovers over each', isletSite.stamps.length === 3 && hovering.length === 3, `${hovering.length}/${isletSite.stamps.length} islets under an island`);
  lab.manager.deactivate(islets, 'test');
}

// ---- gates ------------------------------------------------------------------------------------------------
function testGates() {
  const lab = createLab();
  const site = siteOf('devRopeBridge');
  const gorge = site.stamps[0];
  const id = lab.spawnSite('devRopeBridge');
  const data = partsOf(lab, id).data;
  const g = data.gates.data;
  const centre = { x: g[0], z: g[1] };
  const normal = { x: g[2], z: g[3] };
  const under = (gorge.floorY + g[6]) * 0.5;
  const before = { x: centre.x - normal.x * 300, y: under, z: centre.z - normal.z * 300 };
  const after = { x: centre.x + normal.x * 300, y: under, z: centre.z + normal.z * 300 };
  lab.teleport(before);
  lab.fly(before, after, 120);
  check('gates', 'flying under the bridge fires the gate', lab.events.gates.length === 1 && lab.events.gates[0].gate === 'under' && lab.events.gates[0].kind === 'under', JSON.stringify(lab.events.gates));
  check('gates', 'and earns its achievement', lab.events.achievements.length === 1 && lab.events.achievements[0].id === 'threadTheNeedle', JSON.stringify(lab.events.achievements));
  lab.fly(after, before, 120);
  check('gates', 'the way back fires again (direction -1) without a second achievement', lab.events.gates.length === 2 && lab.events.gates[1].direction === -1 && lab.events.achievements.length === 1);
  const over = { ...before, y: gorge.rimY + 60 };
  lab.teleport(over);
  lab.fly(over, { ...after, y: gorge.rimY + 60 }, 120);
  check('gates', 'flying over the bridge does not fire', lab.events.gates.length === 2, String(lab.events.gates.length));
  lab.teleport(before);
  lab.teleport(after);
  check('gates', 'a teleport across the gate does not fire', lab.events.gates.length === 2, String(lab.events.gates.length));
  lab.manager.deactivate(id, 'test');

  const spireId = lab.spawnSite('devSpires');
  const spireData = partsOf(lab, spireId).data;
  const chimeIndex = spireData.gateMeta.findIndex((gate) => gate.action === 'chime');
  const s = spireData.gates.data;
  const base = chimeIndex * 8;
  const low = (s[base + 5] + s[base + 6]) * 0.5;
  const start = { x: s[base] - s[base + 2] * 200, y: low, z: s[base + 1] - s[base + 3] * 200 };
  const end = { x: s[base] + s[base + 2] * 200, y: low, z: s[base + 1] + s[base + 3] * 200 };
  lab.teleport(start);
  lab.fly(start, end, 100);
  const voice = spireData.voice;
  check('gates', 'flying between two spires rings the crystal chimes', voice.triggers.includes('chime'), JSON.stringify(voice.triggers));
  check('gates', 'the hum level rises on approach', voice.level > 0.5, voice.level.toFixed(2));
  lab.manager.deactivate(spireId, 'test');
}

// ---- course -----------------------------------------------------------------------------------------------
function testCourse() {
  const lab = createLab();
  const id = lab.spawnSite('devCanyonGates');
  const gates = partsOf(lab, id).data.gates.data;
  const point = (index, offset) => ({ x: gates[index * 8] + gates[index * 8 + 2] * offset, y: (gates[index * 8 + 5] + gates[index * 8 + 6]) * 0.5, z: gates[index * 8 + 1] + gates[index * 8 + 3] * offset });
  lab.teleport(point(0, -60));
  lab.fly(point(0, -60), point(0, 60), 30);
  lab.teleport(point(1, -60));
  lab.fly(point(1, -60), point(1, 60), 30);
  check('course', 'start -> finish reports the course time', lab.events.courses.length === 1 && lab.events.courses[0].course === 'devCanyonRun' && lab.events.courses[0].time > 0 && lab.events.courses[0].clean, JSON.stringify(lab.events.courses));
  lab.teleport(point(0, -60));
  lab.fly(point(0, -60), point(0, 60), 30);
  lab.bus.emitTyped('softCrash', { craft: 'glider', reason: 'terrain', impactSpeed: 30, position: point(0, 0) });
  lab.teleport(point(1, -60));
  lab.fly(point(1, -60), point(1, 60), 30);
  check('course', 'a soft crash between the gates spoils a clean run', lab.events.courses.length === 1, String(lab.events.courses.length));
  const run = lab.events.journal;
  check('course', 'the clean run alone reaches the journal (op min, seconds)', run.length === 1 && run[0].key === 'devCanyonRun' && run[0].op === 'min' && Math.abs(run[0].value - lab.events.courses[0].time) < 0.01 && run[0].presetId === 'devCanyonGates', JSON.stringify(run));
  lab.manager.deactivate(id, 'test');
}

// ---- landing ----------------------------------------------------------------------------------------------
function testLanding() {
  const lab = createLab();
  const id = lab.spawnSite('devAirfield');
  const zone = partsOf(lab, id).data.zones[0];
  const heading = (Math.atan2(zone.dirX, -zone.dirZ) * 180) / Math.PI;
  lab.state.player.heading = heading;
  const along = -zone.halfLength + 300;
  const position = { x: zone.x + zone.dirX * along - zone.dirZ * 3, y: zone.y, z: zone.z + zone.dirZ * along + zone.dirX * 3 };
  lab.bus.emitTyped('landed', { grade: 'smooth', craft: 'bushplane', sinkRate: 0.9, groundSpeed: 28, position });
  const landing = lab.events.landings[0];
  check('landing', 'a touchdown on the runway is graded', landing && landing.grade === 'smooth' && Math.abs(landing.fromThreshold - 300) < 1 && Math.abs(Math.abs(landing.centreline) - 3) < 0.05 && landing.score >= 80, JSON.stringify(landing));
  check('landing', 'the pilot hears the runway number and score', lab.events.notify.some((entry) => /^Runway \d\d: smooth touchdown, 3\.0 m off the centreline, 300 m past the threshold\. Score \d+\.$/.test(entry.text)), JSON.stringify(lab.events.notify.at(-1)));
  lab.bus.emitTyped('landed', { grade: 'firm', craft: 'bushplane', sinkRate: 1.9, groundSpeed: 25, position: { x: zone.x - zone.dirZ * 200, y: zone.y, z: zone.z + zone.dirX * 200 } });
  check('landing', 'a touchdown beside the runway is not graded', lab.events.landings.length === 1, String(lab.events.landings.length));
  lab.manager.deactivate(id, 'test');
}

// ---- surfaces ---------------------------------------------------------------------------------------------
function testSurfaces() {
  const lab = createLab();
  const id = lab.spawnSite('devIslands');
  const instance = partsOf(lab, id);
  check('surfaces', 'three island tops are registered', lab.surfaces.count === 3, String(lab.surfaces.count));
  const [first] = lab.surfaces.list();
  const centreX = (first.minX + first.maxX) / 2;
  const centreZ = (first.minZ + first.maxZ) / 2;
  const top = lab.surfaces.surfaceBelow(centreX, centreZ, Infinity);
  check('surfaces', 'the top counts for a craft above it', Number.isFinite(top) && top > 150, top.toFixed(1));
  check('surfaces', 'but not for a craft flying beneath the island', lab.surfaces.surfaceBelow(centreX, centreZ, top - 60) === -Infinity);
  // The surface stands on the rendered top mesh: interpolate the up-facing body triangles.
  const geometry = instance.data.meshes.body.geometry;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const anchor = instance.anchor;
  let worst = 0;
  let samples = 0;
  for (let sample = 0; sample < 400; sample++) {
    const angle = sample * 2.39996;
    const reach = Math.sqrt((sample % 97) / 97) * (first.maxX - first.minX) * 0.3;
    const x = centreX + Math.sin(angle) * reach;
    const z = centreZ - Math.cos(angle) * reach;
    const surface = lab.surfaces.surfaceBelow(x, z, Infinity);
    if (!Number.isFinite(surface)) continue;
    const localX = x - anchor.x;
    const localZ = z - anchor.z;
    let meshHeight = -Infinity;
    for (let vertex = 0; vertex < positions.count; vertex += 3) {
      if (normals.getY(vertex) < 0.9) continue;
      const ax = positions.getX(vertex); const az = positions.getZ(vertex);
      const bx = positions.getX(vertex + 1); const bz = positions.getZ(vertex + 1);
      const cx = positions.getX(vertex + 2); const cz = positions.getZ(vertex + 2);
      const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(denominator) < 1e-9) continue;
      const wa = ((bz - cz) * (localX - cx) + (cx - bx) * (localZ - cz)) / denominator;
      const wb = ((cz - az) * (localX - cx) + (ax - cx) * (localZ - cz)) / denominator;
      const wc = 1 - wa - wb;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      const y = wa * positions.getY(vertex) + wb * positions.getY(vertex + 1) + wc * positions.getY(vertex + 2) + anchor.y;
      if (y > meshHeight && y < surface + 5) meshHeight = y;
    }
    if (!Number.isFinite(meshHeight)) continue;
    samples++;
    worst = Math.max(worst, Math.abs(meshHeight - surface));
  }
  check('surfaces', 'the landable top matches the rendered mesh within 0.3 m', samples > 100 && worst < 0.3, `${samples} samples, worst ${worst.toFixed(3)} m`);
  lab.manager.deactivate(id, 'test');
  check('surfaces', 'dispose removes every surface', lab.surfaces.count === 0, String(lab.surfaces.count));
}

// ---- groundStart --------------------------------------------------------------------------------------------
function testGroundStart() {
  const lab = createLab();
  const preset = presetById.get('devAirfield');
  const site = siteOf('devAirfield');
  const flatten = site.stamps[0];
  const spots = lab.engine.groundStart(preset, preset.engines[0].params, site);
  const heading = (Math.atan2(flatten.dirX, -flatten.dirZ) * 180) / Math.PI;
  const wrap = (value) => ((value % 360) + 360) % 360;
  const ok = Array.isArray(spots) && spots.length === 2
    && Math.hypot(spots[0].x - flatten.thresholds[0].x, spots[0].z - flatten.thresholds[0].z) < 70
    && Math.abs(wrap(spots[0].heading - heading)) < 0.01 && Math.abs(wrap(spots[1].heading - heading - 180)) < 0.01
    && spots.every((spot) => Math.abs(spot.y - flatten.y) < 1e-6);
  check('groundStart', 'the airfield offers both thresholds, facing down the runway', ok, JSON.stringify(spots));
  check('groundStart', 'a site without its stamp offers nothing', lab.engine.groundStart(preset, preset.engines[0].params, { ...site, stamps: [] }) === null);
  check('groundStart', 'recipes without the hook offer nothing', lab.engine.groundStart(presetById.get('devSpires'), { recipe: 'spires' }, site) === null);
}

// ---- wind -------------------------------------------------------------------------------------------------
function testWind() {
  const lab = createLab();
  const site = siteOf('devWindFarm');
  lab.teleport({ x: site.x, y: 500, z: site.z + 800 });
  const id = lab.spawnSite('devWindFarm');
  const instance = partsOf(lab, id);
  lab.step(30);
  check('wind', 'the wake is a WindField source at the near tier', instance.windSourceIds.length === 1 && lab.wind.sourceCount === 1 && lab.events.windAdded.some((entry) => entry.kind === 'structure-wake'), `${lab.wind.sourceCount} sources`);
  const data = instance.data;
  const windX = data.wind[0] / data.wind[2];
  const windZ = data.wind[1] / data.wind[2];
  const hub = { x: data.turbinePositions[0], y: data.turbinePositions[1], z: data.turbinePositions[2] };
  const probe = (distance) => lab.wind.probe(new THREE.Vector3(hub.x + windX * distance, hub.y, hub.z + windZ * distance), lab.state.time.elapsed);
  const upwind = probe(-3 * data.turbineRadii[0]);
  const downwind = probe(3 * data.turbineRadii[0]);
  const along = (sample) => sample.vel.x * windX + sample.vel.z * windZ;
  check('wind', 'the air downwind of a rotor is slower and turbulent', along(downwind) < along(upwind) - 0.5 && downwind.turbulence > 0.2, `upwind ${along(upwind).toFixed(2)} m/s, downwind ${along(downwind).toFixed(2)} m/s, turbulence ${downwind.turbulence.toFixed(2)}`);
  const yawError = Math.abs(((data.turbineState[0] - (Math.atan2(-data.wind[0], data.wind[1]) * 180) / Math.PI + 540) % 360) - 180);
  check('wind', 'the rotors face into the wind and turn', yawError < 6 && data.turbineState[2] > 1, `yaw error ${yawError.toFixed(1)} deg, ${data.turbineState[2].toFixed(1)} rpm`);
  lab.teleport({ x: site.x, y: 500, z: site.z + 13000 });
  lab.step(5);
  check('wind', 'the wake is removed at the far tier', lab.manager.getInstance(id).tier === 'far' && lab.wind.sourceCount === 0 && instance.windSourceIds.length === 0, `${lab.manager.getInstance(id).tier}, ${lab.wind.sourceCount} sources`);
  lab.teleport({ x: site.x, y: 500, z: site.z + 800 });
  lab.step(5);
  check('wind', 'and returns when the player comes back', lab.wind.sourceCount === 1);
  lab.manager.deactivate(id, 'test');
  check('wind', 'dispose removes it, with no leak reported', lab.wind.sourceCount === 0 && lab.manager.getStats().leaks.windSources === 0);
}

// ---- lod --------------------------------------------------------------------------------------------------
function testLod() {
  const lab = createLab();
  const site = siteOf('devIslands');
  lab.teleport({ x: site.x, y: 600, z: site.z + 500 });
  const id = lab.spawnSite('devIslands');
  const meshes = partsOf(lab, id).data.meshes;
  check('lod', 'near: body, detail and water shown', meshes.body.visible && meshes.detail.visible && meshes.water.visible && meshes.body.castShadow);
  lab.teleport({ x: site.x, y: 600, z: site.z + 5000 });
  lab.step(2);
  check('lod', 'mid: detail hidden, no shadows', meshes.body.visible && !meshes.detail.visible && !meshes.body.castShadow, lab.manager.getInstance(id).tier);
  lab.teleport({ x: site.x, y: 600, z: site.z + 20000 });
  lab.step(2);
  check('lod', 'far: a heavy structure hides (its lure takes over)', !meshes.body.visible && !meshes.water.visible && lab.manager.getInstance(id).lure !== null, lab.manager.getInstance(id).tier);
  lab.manager.deactivate(id, 'test');
  const farm = siteOf('devWindFarm');
  lab.teleport({ x: farm.x, y: 600, z: farm.z + 9000 });
  const farmId = lab.spawnSite('devWindFarm');
  lab.step(2);
  const farmMeshes = partsOf(lab, farmId).data.meshes;
  check('lod', 'far: a light structure keeps its silhouette', lab.manager.getInstance(farmId).tier === 'far' && farmMeshes.body.visible && !farmMeshes.detail.visible);
  lab.manager.deactivate(farmId, 'test');
}

// ---- memory -----------------------------------------------------------------------------------------------
function testMemory() {
  const lab = createLab();
  const before = lab.engine.stats();
  const disposed = [];
  const ids = PRESETS.map((preset) => lab.spawnSite(preset.id));
  for (const id of ids) {
    const meshes = partsOf(lab, id).data.meshes;
    for (const mesh of Object.values(meshes)) if (mesh) mesh.geometry.addEventListener('dispose', () => disposed.push(mesh.name));
  }
  const during = lab.engine.stats();
  const geometries = during.buffers - before.buffers;
  for (const id of ids) lab.manager.deactivate(id, 'test');
  const after = lab.engine.stats();
  check('memory', 'every per-instance geometry is disposed', geometries > 0 && disposed.length === geometries, `${disposed.length}/${geometries}`);
  check('memory', 'stats return to their baseline', after.buffers === before.buffers && after.instances === 0 && after.turbines === 0 && after.mistPuffs === 0 && after.surfaces === 0, JSON.stringify(after));
  check('memory', 'no console errors (no leaks, valid events)', consoleErrors.length === 0, consoleErrors.join(' | '));
}

// ---- allocation -------------------------------------------------------------------------------------------
// The engine's own frames: its update() for six live structures, called directly as the manager would
// (the manager's own frame is proven in tools/lab/spawns.mjs; its occlusion rays sample this stub's
// stamped terrain, which boxes numbers in the stamp functions and would be counted here otherwise).
async function testAllocation() {
  const lab = createLab();
  for (const preset of PRESETS) lab.spawnSite(preset.id);
  const parts = lab.manager.getActive().map((record) => partsOf(lab, record.id));
  const bridge = siteOf('devRopeBridge');
  const gorge = bridge.stamps[0];
  const pass = lab.engine.stats().gatesPassed;
  const orbit = { angle: 0 };
  const frame = () => {
    // The player flies a slow figure through the gorge, under the bridge twice per lap, so the gates,
    // the approach audio, the windsock and the turbines all work.
    orbit.angle += 0.004;
    lab.state.player.position.set(gorge.x + Math.sin(orbit.angle) * 30 + gorge.dirX * Math.sin(orbit.angle * 0.5) * 300, gorge.floorY + 30, gorge.z + gorge.dirZ * Math.sin(orbit.angle * 0.5) * 300);
    lab.state.time.elapsed += 1 / 60;
    for (let index = 0; index < parts.length; index++) lab.engine.update(parts[index], 1 / 60);
  };
  for (let index = 0; index < 150000; index++) frame();
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  let collections = 0;
  const observer = new PerformanceObserver((list) => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ['gc'] });
  const gatesBefore = lab.engine.stats().gatesPassed;
  const youngBefore = youngUsed();
  const frames = 100000;
  for (let index = 0; index < frames; index++) frame();
  const youngAfter = youngUsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();
  const passes = lab.engine.stats().gatesPassed - gatesBefore;
  const perFrame = (youngAfter - youngBefore) / frames;
  // A gate pass emits its event objects (a few hundred bytes); frames without one allocate nothing.
  const allowance = (passes * 600) / frames;
  check('allocation', `${parts.length} structures live, ${passes} gate passes in the measurement`, parts.length === PRESETS.length && passes > 0 && pass >= 0, `${passes} passes`);
  check('allocation', `no garbage collection during ${frames} frames`, collections === 0, `${collections} collections`);
  check('allocation', 'young generation grows under 0.1 byte per frame beyond the gate events', collections === 0 && perFrame < 0.1 + allowance, `${perFrame.toFixed(3)} B/frame (gate events allow ${allowance.toFixed(3)})`);
}

// ---- cost -------------------------------------------------------------------------------------------------
// Per-instance cost of every recipe: the CPU time of its update() (after a JIT warm-up, the player
// flying past, turbines and windsocks animating at the near tier) and what it asks of the GPU: the
// triangles of its own geometry, its pooled instanced parts and its draw calls at the near tier.
const COST_BUDGET_MICROSECONDS = 50;
function testCost() {
  const lab = createLab();
  const lines = [];
  let worst = 0;
  for (const preset of PRESETS) {
    const id = lab.spawnSite(preset.id);
    const part = partsOf(lab, id);
    lab.engine.setLOD(part, 'near');
    const site = siteOf(preset.id);
    const frame = (index) => {
      lab.state.player.position.set(site.x + Math.sin(index * 0.001) * 400, site.groundY + 120, site.z - 600);
      lab.state.time.elapsed += 1 / 60;
      lab.engine.update(part, 1 / 60);
    };
    for (let index = 0; index < 20000; index++) frame(index);
    const frames = 40000;
    const started = process.hrtime.bigint();
    for (let index = 0; index < frames; index++) frame(index);
    const microseconds = Number(process.hrtime.bigint() - started) / 1000 / frames;
    worst = Math.max(worst, microseconds);
    let triangles = 0;
    for (const mesh of Object.values(part.data.meshes)) if (mesh) triangles += mesh.geometry.attributes.position.count / 3;
    const stats = lab.engine.stats();
    lines.push(`${preset.id} ${microseconds.toFixed(2)} us, ${triangles} tris, ${part.data.turbineCount} turbines, ${part.data.puffSlots.length} puffs, ${stats.drawCalls} draws`);
    lab.manager.deactivate(id, 'test');
  }
  check('cost', `update() under ${COST_BUDGET_MICROSECONDS} us per instance for every recipe`, worst < COST_BUDGET_MICROSECONDS, lines.join('; '));
}

await testAllocation();
testCost();
testRecipes();
testParams();
testStamps();
testGates();
testCourse();
testLanding();
testSurfaces();
testGroundStart();
testWind();
testLod();
testMemory();

console.error = originalError;
let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  ${result.test.padEnd(11)} ${result.name}${result.detail ? `  (${result.detail})` : ''}\n`);
}
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
