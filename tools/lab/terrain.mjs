// Terrain lab: runs site placement (src/world/placement.js), the terrain stamps (src/world/stamps.js),
// worldgen and the chunk builder headless in node, with the fixture site presets of
// src/dev/terrainFixtures.js (one per stamp type), and checks Milestone A.
//
// Tests:
//   phase1        the unstamped world (an empty preset list: worldgen's Phase 1 code path) is bit-identical
//                 to Phase 1: 20,000 heights and 20,000 collision heights per seed, every LOD mesh of
//                 five chunks per seed (positions, normals, colours) and their vegetation scatter hash
//                 to the digests recorded from the Phase 1 code (tag v2-structure, before any Phase 2
//                 change), on three seeds. The real preset list (src/spawns/presets/index.js) places
//                 stamped sites since preset batch 1 (volcano, geyser field, slot canyon, waterfall), so
//                 its world differs from Phase 1 by design inside the stamps; outside every stamp's
//                 bounds its 20,000 heights and collision heights must still equal Phase 1's exactly
//   validation    the fixtures validate; a broken preset throws an error naming the preset and field
//   placement     per seed, every site passes its own filters again when re-checked here (dominant biome
//                 through worldgen.biomeAt, the terrain's own biome function; surface; relief), sites of
//                 one preset keep minSpacing, ids are unique, and every stamp type is placed
//   determinism   the same seed twice, the second world asked in the reverse order (far cells first),
//                 gives the same site list, site-list hash and stamped heights; the options the terrain
//                 worker receives (structured-cloned) build bit-identical chunk meshes; other seeds
//                 give other site lists
//   shapes        the crater is lower than its rim and the cone stands above its base; the canyon
//                 floor lies below its walls, only runs downhill and the canyon is 2-4 km long; the
//                 cliff drops; the gorge floor lies below its rims and the bridge pads are level; the
//                 airfield strip is flat (heightAt and groundHeight); the islet stands above the sea
//   falloff       outside its bounds a stamp changes nothing (exactly the unstamped height), and lines
//                 crossing every stamp at 0.5 m steps show no discontinuity (every steep step, refined
//                 tenfold, must spread its change instead of keeping it in one sub-step)
//   paint         the stamp paint at each type's characteristic place (ash, wet rock, tarmac, riverbed,
//                 basalt) and the face colours there differ from the unstamped world's
//   seams         near every stamp type, for every pair of LODs (0-3) of neighbouring chunks built by the
//                 chunk builder: shared edge vertices agree, skirts hang from the surface edge and cover
//                 every T-junction gap (no cracks). Every pair on edges a stamp touches; on untouched
//                 Phase 1 edges the pairs the ring layout makes (LODs at most one apart)
//   collision     groundHeight against the rendered LOD0 mesh (its own triangles) near every stamp
//                 type: within 0.5 m
//   real presets  the real preset list's stamped sites (src/spawns/presets/): the same seed twice, asked in
//                 another order, gives the same site-list hash; every site passes its preset's biome,
//                 height and minSpacing rules; and near the nearest site of every stamped preset (on
//                 the first seed that has one) the falloff, seam and collision checks above pass too
//   benchmark     heightAt and groundHeight on fixed point sets with no stamps nearby and with stamps
//                 dense nearby, against the Phase 1 baseline measured from the same code with stamps
//                 disabled (the empty preset list): within 10 %. After a JIT warmup, each slice of
//                 800 points (about a millisecond) is timed 31 times per side, alternating which side runs first; each
//                 side's cost is the sum of its fastest pass per slice (the passes least disturbed by
//                 other programs on a shared machine), and the median pass ratio is printed as well
//
// Usage: node tools/lab/terrain.mjs [--verbose]
// Prints one line per check and exits non-zero if any check fails.
import { createHash } from 'node:crypto';
import { CONFIG, WORLD_OPTIONS } from '../../src/core/config.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createChunkBuilder } from '../../src/world/chunkBuilder.js';
import { hashSiteList, validateSitePreset } from '../../src/world/placement.js';
import { STAMP_TYPES, stampReach } from '../../src/world/stamps.js';
import { PRESETS } from '../../src/spawns/presets/index.js';
import { FIXTURE_STAMP_TYPE, TERRAIN_FIXTURES } from '../../src/dev/terrainFixtures.js';
import {
  buildChunkMesh, checkSeam, checkSkirtAttachment, compareMeshBuffers, drainSteps, extractEdges, meshHeightAt, seamPairApplies, terrainBuilderConfig,
} from '../../src/dev/terrainChecks.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}

const SEEDS = ['DRIFTWING', 'HARNESS-1', 'P2-TERRAIN'];
/** The seed the stamp checks run on (every stamp type lies within 13 km of its origin). */
const STAMP_SEED = 'P2-TERRAIN';
const SEARCH_RADIUS = 30000;
/** Stamp checks run on this many sites of each fixture (nearest first). */
const SITES_PER_TYPE = 2;
const WATER = CONFIG.WATER_LEVEL;
/** Digests of the Phase 1 world (tag v2-structure code), recorded with phase1Digest() below. */
const PHASE1_DIGESTS = Object.freeze({
  DRIFTWING: {
    heights: '0030fc223da603cf68d934360ff17ee5d90dbd39609343f27661dd8448e2be75',
    ground: 'fb4ca17ea8582cb5005008f6bad62cfec537c6e016a37c01e84fa30ae8306038',
    meshes: '6ed5b1611e59c76e07139c9071ff2f3f8bdffd390893c65d37c71251a024d76a',
  },
  'HARNESS-1': {
    heights: '23e937d6eb76c12d77d9054600cc6668377639a4bb11f7a176af0009701ee74b',
    ground: '68265829dd0677e832ce6d0cbf1e22289def49d27516b56411c6d35c912fd68e',
    meshes: '36ced5da362098cb79a9a3d9344c078c41588e998a2d60f817b5afebb471809c',
  },
  'P2-TERRAIN': {
    heights: '637c30c25ede7f916e2f85cc1f430380afa83218a3244bddd1598f63f65af21c',
    ground: '38f15b74faa27f597adeb125f9f0b5af66effc25dfb2482e95905a4f868a3bca',
    meshes: '317c9f84e9424a1bd449b84cd12c1c6da40055ecef31ce9ce416e5fe7907c1b5',
  },
});
const COLLISION_LIMIT_M = 0.5;
const COST_LIMIT = 1.1;
const BENCH_PASSES = 31;
const BENCH_WARMUP = 4;
/** Points per timed pass: short passes (a few ms) so some of them run undisturbed on a loaded machine. */
const BENCH_SLICE = 800;
/**
 * Discontinuity test: every 0.5 m step that changes the height by more than STEEP_STEP_M is sampled
 * again in 10 sub-steps. A continuous surface, however steep, then changes about 10 times less per
 * sub-step; a jump does not. A sub-step keeping more than JUMP_SHARE of the step's change is a jump.
 * The Phase 1 surface has small jumps of its own (a biome whose weight crosses the 0.003 cut-off in
 * worldgen's baseHeight), which a stamp carries along: a step where the UNSTAMPED height jumps as well
 * is counted as a Phase 1 jump, not a stamp one.
 */
const STEEP_STEP_M = 2;
const JUMP_SHARE = 0.35;
const BUILDER_CONFIG = terrainBuilderConfig(CONFIG);
const CHUNK = CONFIG.CHUNK_SIZE;

const results = [];
function check(test, name, pass, detail = '') {
  results.push({ test, name, pass: Boolean(pass), detail });
}
function round(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}
function mulberry32(state) {
  let a = state | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fixtureWorld(seed) {
  return createWorldGen(seed, { ...WORLD_OPTIONS, presets: TERRAIN_FIXTURES });
}

// ---- phase1 ------------------------------------------------------------------------------------------
/** Heights, collision heights, meshes of every LOD and scatter of one world, hashed (sha256 hex). */
function phase1Digest(world) {
  const random = mulberry32(12345);
  const heights = new Float64Array(20000);
  const ground = new Float64Array(20000);
  for (let index = 0; index < 20000; index++) {
    const x = (random() - 0.5) * 120000;
    const z = (random() - 0.5) * 120000;
    heights[index] = world.heightAt(x, z);
    ground[index] = world.groundHeight(x + 1.37, z - 2.11);
  }
  const hash = (array) => createHash('sha256').update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
  const builder = createChunkBuilder(world, BUILDER_CONFIG);
  const meshHash = createHash('sha256');
  for (const [cx, cz] of [[0, 0], [3, -2], [-7, 5], [40, 11], [-23, -31]]) {
    for (let lod = 0; lod < 4; lod++) {
      const floats = builder.vertexCount(lod) * 3;
      const output = { positions: new Float32Array(floats), normals: new Float32Array(floats), colors: new Float32Array(floats), minY: 0, maxY: 0, vertexCount: 0 };
      drainSteps(builder.buildMesh({ cx, cz, lod }, output));
      meshHash.update(Buffer.from(output.positions.buffer)).update(Buffer.from(output.normals.buffer)).update(Buffer.from(output.colors.buffer));
      meshHash.update(`${output.minY},${output.maxY},${output.vertexCount}`);
    }
    meshHash.update(Buffer.from(world.scatterChunk(cx, cz, 1).buffer));
  }
  return { heights: hash(heights), ground: hash(ground), meshes: meshHash.digest('hex') };
}

/** Whether (x, z) lies inside the bounds of any stamp of the world's real preset list. */
function insideAnyStamp(world, x, z) {
  const stamps = world.stampsInCell(Math.floor(x / 2000), Math.floor(z / 2000));
  for (const stamp of stamps) if (x >= stamp.minX && x <= stamp.maxX && z >= stamp.minZ && z <= stamp.maxZ) return true;
  return false;
}

function testPhase1() {
  for (const seed of SEEDS) {
    const world = createWorldGen(seed, { ...WORLD_OPTIONS, presets: [] });
    const digest = phase1Digest(world);
    const golden = PHASE1_DIGESTS[seed];
    check('phase1', `${seed}: unstamped world: 20,000 heights bit-identical to Phase 1`, digest.heights === golden.heights, digest.heights.slice(0, 16));
    check('phase1', `${seed}: unstamped world: 20,000 collision heights bit-identical to Phase 1`, digest.ground === golden.ground, digest.ground.slice(0, 16));
    check('phase1', `${seed}: unstamped world: meshes of every LOD and the scatter bit-identical to Phase 1`, digest.meshes === golden.meshes, digest.meshes.slice(0, 16));
  }
  const stamped = PRESETS.filter((preset) => preset.kind === 'site' && (preset.stamps ?? []).length > 0).map((preset) => preset.id);
  check('phase1', 'the real preset list places stamped sites', stamped.length > 0, stamped.join(', '));
  for (const seed of SEEDS) {
    const world = createWorldGen(seed, WORLD_OPTIONS);
    const phase1 = createWorldGen(seed, { ...WORLD_OPTIONS, presets: [] });
    const random = mulberry32(12345);
    let inside = 0;
    let failures = 0;
    for (let index = 0; index < 20000; index++) {
      const x = (random() - 0.5) * 120000;
      const z = (random() - 0.5) * 120000;
      const groundX = x + 1.37;
      const groundZ = z - 2.11;
      const heightInside = insideAnyStamp(world, x, z);
      const groundInside = insideAnyStamp(world, groundX, groundZ);
      if (heightInside) inside++;
      if (!heightInside && world.heightAt(x, z) !== phase1.heightAt(x, z)) failures++;
      if (!groundInside && world.groundHeight(groundX, groundZ) !== phase1.groundHeight(groundX, groundZ)) failures++;
    }
    check('phase1', `${seed}: real presets: outside every stamp, 20,000 heights and collision heights equal Phase 1`, failures === 0, `${failures} differ; ${inside} of the points lie inside a stamp`);
  }
}

// ---- validation ----------------------------------------------------------------------------------------
function expectThrow(label, build, fragments) {
  try {
    build();
    check('validation', label, false, 'no error was thrown');
  } catch (error) {
    const message = String(error && error.message);
    check('validation', label, fragments.every((fragment) => message.includes(fragment)), message);
  }
}

function testValidation() {
  for (const preset of TERRAIN_FIXTURES) {
    let problem = '';
    try {
      validateSitePreset(preset);
    } catch (error) {
      problem = error.message;
    }
    check('validation', `fixture ${preset.id} validates`, problem === '', problem);
  }
  const volcano = TERRAIN_FIXTURES[0];
  expectThrow('a chance above 1 names the preset and placement.chance', () => createWorldGen('X', { ...WORLD_OPTIONS, presets: [{ ...volcano, placement: { ...volcano.placement, chance: 2 } }] }), ['fixtureVolcano', 'placement.chance']);
  expectThrow('an unknown biome names the field', () => createWorldGen('X', { ...WORLD_OPTIONS, presets: [{ ...volcano, placement: { ...volcano.placement, biomes: ['jungle'] } }] }), ['fixtureVolcano', 'placement.biomes', 'jungle']);
  expectThrow('an unknown stamp type names stamps[0].type', () => createWorldGen('X', { ...WORLD_OPTIONS, presets: [{ ...volcano, stamps: [{ type: 'crater' }] }] }), ['fixtureVolcano', 'stamps[0].type']);
  expectThrow('a descending size range names the field', () => createWorldGen('X', { ...WORLD_OPTIONS, presets: [{ ...volcano, stamps: [{ type: 'cone', radius: [900, 500] }] }] }), ['fixtureVolcano', 'stamps[0].radius']);
  expectThrow('an unknown paint names the field', () => createWorldGen('X', { ...WORLD_OPTIONS, presets: [{ ...volcano, stamps: [{ type: 'cone', paint: 'lava' }] }] }), ['stamps[0].paint', 'lava']);
}

// ---- placement ----------------------------------------------------------------------------------------------
function surfaceOk(world, site, preset) {
  const surface = preset.placement.surface ?? 'any';
  if (surface === 'any') return true;
  const reach = Math.max(...(preset.stamps ?? []).map(stampReach), 0);
  const radius = Math.min(Math.max(reach * 0.5, 200), 1200);
  const centre = world.unstampedHeightAt(site.x, site.z);
  let land = 0;
  let water = 0;
  for (let index = 0; index < 8; index++) {
    const angle = (index / 8) * Math.PI * 2;
    const height = world.unstampedHeightAt(site.x + Math.sin(angle) * radius, site.z - Math.cos(angle) * radius);
    if (height > WATER + 1) land++;
    else if (height < WATER - 2) water++;
  }
  if (surface === 'land') return centre > WATER + 3 && land === 8;
  if (surface === 'water') return centre < WATER - 6 && water === 8;
  return centre > WATER - 10 && centre < WATER + 14 && land >= 2 && water >= 2;
}

function testPlacement() {
  const presetsById = new Map(TERRAIN_FIXTURES.map((preset) => [preset.id, preset]));
  const typesPlaced = new Set();
  for (const seed of SEEDS) {
    const world = fixtureWorld(seed);
    const sites = world.sitesNear(0, 0, SEARCH_RADIUS);
    const ids = new Set(sites.map((site) => site.id));
    check('placement', `${seed}: ${sites.length} sites within ${SEARCH_RADIUS / 1000} km, ids unique`, ids.size === sites.length && sites.length > 0, `${sites.length} sites`);
    let biomeFailures = 0;
    let surfaceFailures = 0;
    let terrainFailures = 0;
    let groundFailures = 0;
    for (const site of sites) {
      const preset = presetsById.get(site.presetId);
      const biome = world.biomeAt(site.x, site.z).key;
      if (site.biome !== biome || (preset.placement.biomes && !preset.placement.biomes.includes(biome))) biomeFailures++;
      if (!surfaceOk(world, site, preset)) surfaceFailures++;
      const terrain = preset.placement.terrain ?? {};
      if ((Number.isFinite(terrain.minHeight) && site.groundY < terrain.minHeight) || (Number.isFinite(terrain.maxHeight) && site.groundY > terrain.maxHeight)) terrainFailures++;
      if (site.groundY !== world.unstampedHeightAt(site.x, site.z)) groundFailures++;
      for (const stamp of site.stamps) typesPlaced.add(stamp.type);
    }
    check('placement', `${seed}: every site's dominant biome (worldgen.biomeAt) is one its preset allows`, biomeFailures === 0, `${biomeFailures} failures`);
    check('placement', `${seed}: every site's surface matches its preset`, surfaceFailures === 0, `${surfaceFailures} failures`);
    check('placement', `${seed}: every site's height is inside its preset's band`, terrainFailures === 0, `${terrainFailures} failures`);
    check('placement', `${seed}: groundY is the unstamped height at the site`, groundFailures === 0, `${groundFailures} failures`);
    let spacingFailures = 0;
    let closest = Infinity;
    for (const first of sites) {
      for (const second of sites) {
        if (first === second || first.presetId !== second.presetId) continue;
        const distance = Math.hypot(first.x - second.x, first.z - second.z);
        closest = Math.min(closest, distance / presetsById.get(first.presetId).placement.minSpacing);
        if (distance < presetsById.get(first.presetId).placement.minSpacing) spacingFailures++;
      }
    }
    check('placement', `${seed}: sites of one preset keep minSpacing`, spacingFailures === 0, `closest pair at ${round(closest, 2)} x minSpacing`);
    let landmarkFailures = 0;
    for (const site of sites) {
      for (const landmark of world.landmarkSitesNear(site.x, site.z, 6000)) {
        for (const stamp of site.stamps) {
          const inside = landmark.x >= stamp.minX && landmark.x <= stamp.maxX && landmark.z >= stamp.minZ && landmark.z <= stamp.maxZ;
          if (inside && world.heightAt(landmark.x, landmark.z) !== world.unstampedHeightAt(landmark.x, landmark.z)) landmarkFailures++;
        }
      }
    }
    check('placement', `${seed}: no stamp changes the ground at a Phase 1 landmark`, landmarkFailures === 0, `${landmarkFailures} failures`);
  }
  for (const type of STAMP_TYPES) check('placement', `stamp type ${type} is placed on some seed`, typesPlaced.has(type));
}

// ---- determinism ---------------------------------------------------------------------------------------------
function testDeterminism() {
  const first = fixtureWorld(STAMP_SEED);
  const second = fixtureWorld(STAMP_SEED);
  // The second world is asked far away first, then from the outside in: caches fill in another order.
  second.sitesNear(90000, -70000, 8000);
  for (let ring = 3; ring >= 0; ring--) second.sitesNear(ring * 7000, -ring * 5000, 6000);
  const firstSites = first.sitesNear(0, 0, SEARCH_RADIUS);
  const secondSites = second.sitesNear(0, 0, SEARCH_RADIUS);
  const firstHash = hashSiteList(firstSites);
  const secondHash = hashSiteList(secondSites);
  check('determinism', 'same seed, other query order: same site list and hash', firstHash === secondHash && firstSites.length === secondSites.length, `${firstHash} / ${secondHash}`);
  const random = mulberry32(99);
  let heightMismatches = 0;
  const stamped = firstSites.flatMap((site) => site.stamps);
  for (let index = 0; index < 20000; index++) {
    const stamp = stamped[index % stamped.length];
    const x = stamp.minX + (stamp.maxX - stamp.minX) * random();
    const z = stamp.minZ + (stamp.maxZ - stamp.minZ) * random();
    if (first.heightAt(x, z) !== second.heightAt(x, z) || first.groundHeight(x, z) !== second.groundHeight(x, z)) heightMismatches++;
  }
  check('determinism', 'same seed: 20,000 stamped heights and collision heights identical', heightMismatches === 0, `${heightMismatches} mismatches`);
  const otherHashes = ['DRIFTWING', 'HARNESS-1'].map((seed) => hashSiteList(fixtureWorld(seed).sitesNear(0, 0, SEARCH_RADIUS)));
  check('determinism', 'other seeds give other site lists', otherHashes.every((hash) => hash !== firstHash), otherHashes.join(', '));
  // The terrain worker receives the options through postMessage (a structured clone).
  const workerWorld = createWorldGen(STAMP_SEED, structuredClone({ ...WORLD_OPTIONS, presets: TERRAIN_FIXTURES }));
  const mainBuilder = createChunkBuilder(first, BUILDER_CONFIG);
  const workerBuilder = createChunkBuilder(workerWorld, BUILDER_CONFIG);
  let worstBuffer = 0;
  let builds = 0;
  for (const site of firstSites.slice(0, 12)) {
    for (const stamp of site.stamps) {
      const point = stamp.keyPoints[0];
      const cx = Math.floor(point.x / CHUNK);
      const cz = Math.floor(point.z / CHUNK);
      for (let lod = 0; lod < 4; lod++) {
        worstBuffer = Math.max(worstBuffer, compareMeshBuffers(buildChunkMesh(mainBuilder, BUILDER_CONFIG, cx, cz, lod), buildChunkMesh(workerBuilder, BUILDER_CONFIG, cx, cz, lod)));
        builds++;
      }
    }
  }
  check('determinism', `worker-cloned options: ${builds} stamped chunk meshes bit-identical`, worstBuffer === 0, `max difference ${worstBuffer}`);
}

// ---- stamp checks -----------------------------------------------------------------------------------------------
/** The SITES_PER_TYPE sites of each fixture nearest to the stamp seed's origin. */
function stampSites(world) {
  const near = world.sitesNear(0, 0, SEARCH_RADIUS);
  return TERRAIN_FIXTURES.flatMap((preset) => near.filter((site) => site.presetId === preset.id).slice(0, SITES_PER_TYPE));
}

function sampleAround(world, x, z, radius, count) {
  let sum = 0;
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    sum += world.heightAt(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
  }
  return sum / count;
}

function localPoint(stamp, along, across) {
  return { x: stamp.x + stamp.dirX * along - stamp.dirZ * across, z: stamp.z + stamp.dirZ * along + stamp.dirX * across };
}

function testShapes(world, sites) {
  for (const site of sites) {
    for (const stamp of site.stamps) {
      const label = `${stamp.type} (${site.id})`;
      if (stamp.type === 'cone') {
        const floor = world.heightAt(stamp.x, stamp.z);
        const rim = sampleAround(world, stamp.x, stamp.z, stamp.craterRadius, 16);
        check('shapes', `${label}: the crater floor lies at least half the crater depth below the rim`, rim - floor >= stamp.craterDepth * 0.5, `rim ${round(rim, 1)} m, floor ${round(floor, 1)} m, depth ${round(stamp.craterDepth, 1)} m`);
        check('shapes', `${label}: the rim stands at least 60 % of the cone height above its base`, rim - stamp.baseY >= stamp.height * 0.6, `rim ${round(rim - stamp.baseY, 1)} m above the base, height ${round(stamp.height, 1)} m`);
      } else if (stamp.type === 'carve') {
        const path = stamp.path;
        let worstWall = Infinity;
        let checked = 0;
        for (let index = 2; index <= path.length - 3; index++) {
          const point = path[index];
          const next = path[index + 1];
          const length = Math.hypot(next.x - point.x, next.z - point.z);
          const acrossX = -(next.z - point.z) / length;
          const acrossZ = (next.x - point.x) / length;
          const reach = point.halfWidth + point.wallWidth + 14;
          const floor = world.heightAt(point.x, point.z);
          const wallA = world.heightAt(point.x + acrossX * reach, point.z + acrossZ * reach);
          const wallB = world.heightAt(point.x - acrossX * reach, point.z - acrossZ * reach);
          worstWall = Math.min(worstWall, Math.min(wallA, wallB) - floor);
          checked++;
        }
        check('shapes', `${label}: the canyon floor lies at least 40 % of its depth below both walls`, checked > 0 && worstWall >= stamp.depth * 0.4, `${checked} cross-sections, lowest wall ${round(worstWall, 1)} m above the floor, depth ${round(stamp.depth, 1)} m`);
        const downhill = path.every((point, index) => index === 0 || point.floorY <= path[index - 1].floorY);
        check('shapes', `${label}: the river floor only runs downhill`, downhill, `${round(path[0].floorY, 1)} m -> ${round(path[path.length - 1].floorY, 1)} m`);
        check('shapes', `${label}: the canyon is 2-4 km long`, stamp.length >= 2000 && stamp.length <= 4000, `${round(stamp.length, 0)} m`);
      } else if (stamp.type === 'cliffStep') {
        const side = stamp.channelWidth + 25;
        const top = localPoint(stamp, -70, side);
        const bottom = localPoint(stamp, stamp.poolAlong + stamp.pool + 30, side);
        const drop = world.heightAt(top.x, top.z) - world.heightAt(bottom.x, bottom.z);
        check('shapes', `${label}: the cliff drops at least 75 % of its step`, drop >= stamp.drop * 0.75, `drop ${round(drop, 1)} m of ${round(stamp.drop, 1)} m`);
      } else if (stamp.type === 'gorge') {
        const floor = world.heightAt(stamp.x, stamp.z);
        check('shapes', `${label}: the gorge floor lies at least 70 % of its depth below the rim`, stamp.rimY - floor >= stamp.depth * 0.7, `rim ${round(stamp.rimY, 1)} m, floor ${round(floor, 1)} m`);
        const [anchorA, anchorB] = stamp.anchors;
        const padA = world.heightAt(anchorA.x, anchorA.z);
        const padB = world.heightAt(anchorB.x, anchorB.z);
        check('shapes', `${label}: both bridge pads are level with the rim`, Math.abs(padA - stamp.rimY) < 0.01 && Math.abs(padB - stamp.rimY) < 0.01, `${round(padA, 2)} m and ${round(padB, 2)} m, rim ${round(stamp.rimY, 2)} m`);
      } else if (stamp.type === 'flatten') {
        let low = Infinity;
        let high = -Infinity;
        let groundLow = Infinity;
        let groundHigh = -Infinity;
        for (let along = -stamp.length / 2; along <= stamp.length / 2; along += stamp.length / 40) {
          for (let across = -stamp.width / 2; across <= stamp.width / 2; across += stamp.width / 6) {
            const point = localPoint(stamp, along, across);
            const height = world.heightAt(point.x, point.z);
            const ground = world.groundHeight(point.x, point.z);
            low = Math.min(low, height);
            high = Math.max(high, height);
            groundLow = Math.min(groundLow, ground);
            groundHigh = Math.max(groundHigh, ground);
          }
        }
        check('shapes', `${label}: the strip is flat (heightAt within 1 cm)`, high - low <= 0.01, `${round(high - low, 4)} m over the strip`);
        check('shapes', `${label}: the strip is flat for collision (groundHeight within 1 cm)`, groundHigh - groundLow <= 0.01, `${round(groundHigh - groundLow, 4)} m over the strip`);
      } else {
        const top = world.heightAt(stamp.x, stamp.z);
        check('shapes', `${label}: the islet stands at least 70 % of its height above the sea`, top - WATER >= stamp.height * 0.7, `${round(top, 1)} m, height ${round(stamp.height, 1)} m`);
      }
    }
  }
}

function coveredByOther(stamps, stamp, x, z) {
  return stamps.some((other) => other !== stamp && x >= other.minX && x <= other.maxX && z >= other.minZ && z <= other.maxZ);
}

function testFalloff(world, sites) {
  const allStamps = world.sitesNear(0, 0, SEARCH_RADIUS + 10000).flatMap((site) => site.stamps);
  for (const site of sites) {
    for (const stamp of site.stamps) {
      let outsideChanged = 0;
      let outsideChecked = 0;
      for (let index = 0; index < 400; index++) {
        const share = index / 400;
        const perimeter = [
          [stamp.minX - 1 + (stamp.maxX - stamp.minX + 2) * share, stamp.minZ - 1],
          [stamp.minX - 1 + (stamp.maxX - stamp.minX + 2) * share, stamp.maxZ + 1],
          [stamp.minX - 1, stamp.minZ - 1 + (stamp.maxZ - stamp.minZ + 2) * share],
          [stamp.maxX + 1, stamp.minZ - 1 + (stamp.maxZ - stamp.minZ + 2) * share],
        ];
        for (const [x, z] of perimeter) {
          if (coveredByOther(allStamps, stamp, x, z)) continue;
          outsideChecked++;
          if (world.heightAt(x, z) !== world.unstampedHeightAt(x, z)) outsideChanged++;
        }
      }
      check('falloff', `${stamp.type} (${site.id}): outside its bounds nothing changes`, outsideChanged === 0 && outsideChecked > 0, `${outsideChecked} points, ${outsideChanged} changed`);
      let worstStep = 0;
      let worstShare = 0;
      let steepSteps = 0;
      let phase1Jumps = 0;
      const centres = stamp.keyPoints;
      for (const centre of centres) {
        for (const angle of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
          const dirX = Math.cos(angle);
          const dirZ = Math.sin(angle);
          const span = 1600;
          const heightAlong = (travelled) => world.heightAt(centre.x + dirX * travelled, centre.z + dirZ * travelled);
          const unstampedAlong = (travelled) => world.unstampedHeightAt(centre.x + dirX * travelled, centre.z + dirZ * travelled);
          /** The largest share of a 0.5 m step's change that one of its ten 5 cm sub-steps holds. */
          const jumpShare = (sample, end) => {
            const start = sample(end - 0.5);
            const change = Math.abs(sample(end) - start);
            let fine = 0;
            let before = start;
            for (let sub = 1; sub <= 10; sub++) {
              const at = sample(end - 0.5 + sub * 0.05);
              fine = Math.max(fine, Math.abs(at - before));
              before = at;
            }
            return change > 0 ? fine / change : 0;
          };
          let previous = heightAlong(-span);
          for (let travelled = -span + 0.5; travelled <= span; travelled += 0.5) {
            const height = heightAlong(travelled);
            const change = Math.abs(height - previous);
            if (change > worstStep) worstStep = change;
            if (change > STEEP_STEP_M) {
              steepSteps++;
              const share = jumpShare(heightAlong, travelled);
              if (share > JUMP_SHARE && jumpShare(unstampedAlong, travelled) > JUMP_SHARE) phase1Jumps++;
              else worstShare = Math.max(worstShare, share);
            }
            previous = height;
          }
        }
      }
      check('falloff', `${stamp.type} (${site.id}): no discontinuity across the stamp`, worstShare <= JUMP_SHARE,
        `largest 0.5 m step ${round(worstStep, 2)} m (slope ${round(worstStep / 0.5, 1)}); ${steepSteps} steps over ${STEEP_STEP_M} m refined, the worst keeping ${round(worstShare * 100, 1)} % of its change in one 5 cm sub-step (a jump keeps ~100 %); ${phase1Jumps} jumps already in the unstamped Phase 1 surface`);
    }
  }
}

function testPaint(world, sites) {
  const plain = createWorldGen(STAMP_SEED, WORLD_OPTIONS);
  const colour = new Float32Array(3);
  const plainColour = new Float32Array(3);
  const expected = {
    cone: (stamp) => [{ x: stamp.x, z: stamp.z }, 'ash'],
    carve: (stamp) => [stamp.path[Math.floor(stamp.path.length / 2)], 'riverbed'],
    cliffStep: (stamp) => [{ x: stamp.poolX, z: stamp.poolZ }, 'wetRock'],
    gorge: (stamp) => [{ x: stamp.x, z: stamp.z }, 'riverbed'],
    flatten: (stamp) => [{ x: stamp.x, z: stamp.z }, 'tarmac'],
    islandBase: (stamp) => [{ x: stamp.x + stamp.dirX * stamp.radius * 0.8, z: stamp.z + stamp.dirZ * stamp.radius * 0.8 }, 'basalt'],
  };
  for (const site of sites) {
    const stamp = site.stamps[0];
    const [point, paint] = expected[stamp.type](stamp);
    const influence = world.stampInfluence(point.x, point.z);
    check('paint', `${stamp.type} (${site.id}): ${paint} paint at its place`, influence.paint === paint && influence.weight >= 0.6, `${influence.paint} ${round(influence.weight, 2)}`);
    const height = world.heightAt(point.x, point.z);
    world.faceColor(point.x, point.z, height, 0.05, 0, 0, 0.5, colour, 0);
    plain.faceColor(point.x, point.z, height, 0.05, 0, 0, 0.5, plainColour, 0);
    const difference = Math.abs(colour[0] - plainColour[0]) + Math.abs(colour[1] - plainColour[1]) + Math.abs(colour[2] - plainColour[2]);
    check('paint', `${stamp.type} (${site.id}): the face colour there is the paint, not the biome`, difference > 0.01, `colour change ${round(difference, 3)}`);
  }
}

/** Chunk coordinates around every key point of a stamp (3 x 3 each). */
function chunksNear(stamp) {
  const keys = new Map();
  for (const point of stamp.keyPoints) {
    const cx = Math.floor(point.x / CHUNK);
    const cz = Math.floor(point.z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) keys.set(`${cx + dx}:${cz + dz}`, [cx + dx, cz + dz]);
  }
  return [...keys.values()];
}

function testSeamsAndCollision(world, sites) {
  const builder = createChunkBuilder(world, BUILDER_CONFIG);
  const cache = new Map();
  const edgesOf = (cx, cz, lod) => {
    const key = `${cx}:${cz}:${lod}`;
    if (!cache.has(key)) {
      const mesh = buildChunkMesh(builder, BUILDER_CONFIG, cx, cz, lod);
      cache.set(key, { mesh, edges: extractEdges(mesh, CHUNK) });
    }
    return cache.get(key);
  };
  for (const site of sites) {
    for (const stamp of site.stamps) {
      const chunks = chunksNear(stamp);
      let seams = 0;
      let violations = 0;
      let worstCoverage = Infinity;
      let maxShared = 0;
      let maxGap = 0;
      let worstAttachment = 0;
      let phase1Skipped = 0;
      for (const [cx, cz] of chunks) {
        for (const [ncx, ncz, direction] of [[cx + 1, cz, 'east'], [cx, cz + 1, 'south']]) {
          for (let lod = 0; lod < 4; lod++) {
            for (let neighbourLod = 0; neighbourLod < 4; neighbourLod++) {
              if (!seamPairApplies(world, CHUNK, cx, cz, direction, lod, neighbourLod)) {
                phase1Skipped++;
                continue;
              }
              const own = edgesOf(cx, cz, lod);
              const other = edgesOf(ncx, ncz, neighbourLod);
              const seam = checkSeam(own.edges, other.edges, direction);
              seams++;
              violations += seam.violations;
              maxShared = Math.max(maxShared, seam.maxSharedDiff);
              maxGap = Math.max(maxGap, seam.maxGap);
              if (seam.worstCoverage !== null) worstCoverage = Math.min(worstCoverage, seam.worstCoverage);
              worstAttachment = Math.max(worstAttachment, checkSkirtAttachment(own.edges), checkSkirtAttachment(other.edges));
            }
          }
        }
      }
      check('seams', `${stamp.type} (${site.id}): ${seams} seams over ${chunks.length} chunks, every LOD pair on stamped edges, no cracks`, violations === 0 && worstAttachment <= 1e-3, `shared vertices within ${round(maxShared, 5)} m, largest T-junction gap ${round(maxGap, 1)} m, skirt margin at least ${round(worstCoverage, 2)} m, skirt attachment ${round(worstAttachment, 5)} m; ${phase1Skipped} pairs two or more LODs apart on untouched Phase 1 edges left to the ring layout`);
      const random = mulberry32(7);
      let worstCollision = 0;
      let samples = 0;
      for (const [cx, cz] of chunks) {
        const { mesh } = edgesOf(cx, cz, 0);
        for (let index = 0; index < 150; index++) {
          const localX = random() * CHUNK;
          const localZ = random() * CHUNK;
          const rendered = meshHeightAt(mesh, CHUNK, localX, localZ);
          const collision = world.groundHeight(cx * CHUNK + localX, cz * CHUNK + localZ);
          worstCollision = Math.max(worstCollision, Math.abs(rendered - collision));
          samples++;
        }
      }
      check('collision', `${stamp.type} (${site.id}): groundHeight matches the LOD0 mesh within ${COLLISION_LIMIT_M} m`, worstCollision <= COLLISION_LIMIT_M, `${samples} samples, worst ${round(worstCollision, 5)} m`);
    }
  }
}

// ---- real presets ---------------------------------------------------------------------------------------------
const REAL_SEARCH_RADIUS = 60000;

function testRealPresets() {
  const stamped = PRESETS.filter((preset) => preset.kind === 'site' && (preset.stamps ?? []).length > 0);
  const presetsById = new Map(PRESETS.map((preset) => [preset.id, preset]));
  const nearest = new Map();
  for (const seed of SEEDS) {
    const first = createWorldGen(seed, WORLD_OPTIONS);
    const second = createWorldGen(seed, WORLD_OPTIONS);
    second.sitesNear(90000, -70000, 8000);
    for (let ring = 3; ring >= 0; ring--) second.sitesNear(ring * 9000, -ring * 7000, 9000);
    const sites = first.sitesNear(0, 0, REAL_SEARCH_RADIUS);
    const again = second.sitesNear(0, 0, REAL_SEARCH_RADIUS);
    const hash = hashSiteList(sites);
    check('real presets', `${seed}: the same site-list hash twice (${sites.length} sites within ${REAL_SEARCH_RADIUS / 1000} km)`, sites.length > 0 && hash === hashSiteList(again), hash);
    let failures = 0;
    for (const site of sites) {
      const preset = presetsById.get(site.presetId);
      const placement = preset.placement;
      const terrain = placement.terrain ?? {};
      if (placement.biomes && !placement.biomes.includes(first.biomeAt(site.x, site.z).key)) failures++;
      if ((Number.isFinite(terrain.minHeight) && site.groundY < terrain.minHeight) || (Number.isFinite(terrain.maxHeight) && site.groundY > terrain.maxHeight)) failures++;
      for (const other of sites) {
        if (other !== site && other.presetId === site.presetId && Math.hypot(other.x - site.x, other.z - site.z) < placement.minSpacing) failures++;
      }
      if (!nearest.has(site.presetId) && site.stamps.length > 0) nearest.set(site.presetId, { world: first, site });
    }
    check('real presets', `${seed}: every site keeps its preset's biome, height band and minSpacing`, failures === 0, `${failures} failures`);
  }
  for (const preset of stamped) {
    const found = nearest.get(preset.id);
    check('real presets', `${preset.id}: a site within ${REAL_SEARCH_RADIUS / 1000} km on some seed`, Boolean(found), found ? `${found.site.id}, ${round(Math.hypot(found.site.x, found.site.z) / 1000, 1)} km` : 'none');
    if (!found) continue;
    testFalloff(found.world, [found.site]);
    testSeamsAndCollision(found.world, [found.site]);
  }
}

// ---- benchmark --------------------------------------------------------------------------------------------------
function timePass(fn, xs, zs) {
  const started = process.hrtime.bigint();
  let sum = 0;
  for (let index = 0; index < xs.length; index++) sum += fn(xs[index], zs[index]);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  if (!Number.isFinite(sum)) throw new Error('benchmark produced a non-finite height');
  return elapsed;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Times both functions over the same points: BENCH_WARMUP passes each first (the JIT settles), then
 * BENCH_PASSES short passes each over one slice of the points in turn, alternating which side goes first.
 * Each side's cost is the sum over the slices of its fastest pass there.
 */
function bench(label, baselineFn, stampedFn, xs, zs) {
  const slices = [];
  for (let start = 0; start < xs.length; start += BENCH_SLICE) slices.push([xs.subarray(start, start + BENCH_SLICE), zs.subarray(start, start + BENCH_SLICE)]);
  for (let pass = 0; pass < BENCH_WARMUP; pass++) {
    for (const [sliceX, sliceZ] of slices) {
      timePass(baselineFn, sliceX, sliceZ);
      timePass(stampedFn, sliceX, sliceZ);
    }
  }
  let baselineBest = 0;
  let stampedBest = 0;
  const ratios = [];
  for (const [sliceX, sliceZ] of slices) {
    let baseline = Infinity;
    let stamped = Infinity;
    for (let pass = 0; pass < BENCH_PASSES; pass++) {
      const stampedFirst = pass % 2 === 0;
      const first = timePass(stampedFirst ? stampedFn : baselineFn, sliceX, sliceZ);
      const second = timePass(stampedFirst ? baselineFn : stampedFn, sliceX, sliceZ);
      const baseMs = stampedFirst ? second : first;
      const stampMs = stampedFirst ? first : second;
      baseline = Math.min(baseline, baseMs);
      stamped = Math.min(stamped, stampMs);
      ratios.push(stampMs / baseMs);
    }
    baselineBest += baseline;
    stampedBest += stamped;
  }
  const best = stampedBest / baselineBest;
  const perCall = (ms) => round((ms * 1000) / xs.length, 3);
  check('benchmark', `${label}: within ${Math.round((COST_LIMIT - 1) * 100)} % of the Phase 1 cost`, best <= COST_LIMIT,
    `${perCall(stampedBest)} us vs ${perCall(baselineBest)} us per call (fastest passes, ratio ${round(best, 3)}); median pass ratio ${round(median(ratios), 3)}; ${xs.length} points in ${slices.length} slices x ${BENCH_PASSES} passes`);
}

function testBenchmark() {
  const stampedWorld = fixtureWorld(STAMP_SEED);
  const baselineWorld = createWorldGen(STAMP_SEED, WORLD_OPTIONS);
  const sites = stampedWorld.sitesNear(0, 0, SEARCH_RADIUS);
  const stamps = sites.flatMap((site) => site.stamps);
  const random = mulberry32(4242);
  const count = 60000;
  const clearX = new Float64Array(count);
  const clearZ = new Float64Array(count);
  for (let filled = 0; filled < count;) {
    const x = (random() - 0.5) * 2 * SEARCH_RADIUS;
    const z = (random() - 0.5) * 2 * SEARCH_RADIUS;
    if (stampedWorld.stampsInCell(Math.floor(x / stampedWorld.SITE_CELL), Math.floor(z / stampedWorld.SITE_CELL)).length > 0) continue;
    clearX[filled] = x;
    clearZ[filled] = z;
    filled++;
  }
  // Dense: every point inside some stamp's bounds, taken stamp by stamp (the way chunk rows sample).
  const denseX = new Float64Array(count);
  const denseZ = new Float64Array(count);
  const perStamp = Math.ceil(count / stamps.length);
  for (let index = 0; index < count; index++) {
    const stamp = stamps[Math.floor(index / perStamp) % stamps.length];
    denseX[index] = stamp.minX + (stamp.maxX - stamp.minX) * random();
    denseZ[index] = stamp.minZ + (stamp.maxZ - stamp.minZ) * random();
  }
  const coldWorld = fixtureWorld(STAMP_SEED);
  const coldStarted = process.hrtime.bigint();
  coldWorld.heightAt(stamps[0].x, stamps[0].z);
  const coldMs = Number(process.hrtime.bigint() - coldStarted) / 1e6;
  check('benchmark', 'first query of a stamped cell (placement and stamp resolution, cached afterwards)', coldMs < 1000, `${round(coldMs, 1)} ms once per 2 km cell`);
  bench('heightAt, no stamps nearby', baselineWorld.heightAt, stampedWorld.heightAt, clearX, clearZ);
  bench('heightAt, stamps dense nearby', baselineWorld.heightAt, stampedWorld.heightAt, denseX, denseZ);
  bench('groundHeight, no stamps nearby', baselineWorld.groundHeight, stampedWorld.groundHeight, clearX.subarray(0, 20000), clearZ.subarray(0, 20000));
  bench('groundHeight, stamps dense nearby', baselineWorld.groundHeight, stampedWorld.groundHeight, denseX.subarray(0, 20000), denseZ.subarray(0, 20000));
}

// ---- run ---------------------------------------------------------------------------------------------------------
const started = Date.now();
testPhase1();
testValidation();
testPlacement();
testDeterminism();
const stampWorld = fixtureWorld(STAMP_SEED);
const sites = stampSites(stampWorld);
check('shapes', `every stamp type has ${SITES_PER_TYPE} sites on ${STAMP_SEED}`, TERRAIN_FIXTURES.every((preset) => sites.filter((site) => site.presetId === preset.id).length === SITES_PER_TYPE),
  sites.map((site) => `${FIXTURE_STAMP_TYPE[site.presetId]} ${round(Math.hypot(site.x, site.z) / 1000, 1)} km`).join(', '));
testShapes(stampWorld, sites);
testFalloff(stampWorld, sites);
testPaint(stampWorld, sites);
testSeamsAndCollision(stampWorld, sites);
testRealPresets();
testBenchmark();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (VERBOSE || !result.pass || result.test === 'benchmark') {
    process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  [${result.test}] ${result.name}${result.detail ? `: ${result.detail}` : ''}\n`);
  }
}
process.stdout.write(`terrain lab: ${results.length - failed}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(failed === 0 ? 0 : 1);
