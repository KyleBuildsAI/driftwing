// Water lab: the shared water-height query (src/world/waterQuery.js), the local water bodies
// (src/world/waters.js) and the vegetation colliders (src/world/vegetationColliders.js), headless in
// node, on the water and overlay fixture presets of src/dev/waterFixtures.js (contract c.5, d.4).
//
// Tests:
//   table        the quantised wave table equals the Phase 2 ocean's (water.js before Phase 3,
//                re-derived here from its own formulas) for several wind directions; the swell scale
//                is the clouds' ambient wind formula, clamped
//   ocean        oceanHeight equals the ocean shader's vertex displacement (its Gerstner formulas,
//                written out independently here) at 2000 sampled points and times, within 3 cm;
//                the sample's normal is a unit vector and its velocity the displacement's derivative
//   clipping     every fixture water body: the query covers its centre at exactly its level, never
//                reports it above its level, never outside its basin's outline or where the basin
//                ground is above the level (a grid over its bounds plus a margin), and ice is ice
//   contact      ground contact through the query: ice is solid ground (no water, surface 'ice', low
//                friction), a thin film is wet ground, a lake and the ocean are water; a glider
//                sinking into a lake reports water (the soft crash), and far from water the model
//                flies bit-identically with the query and with the flat Phase 1 sea
//   determinism  waterBodyAt agrees between two worlds (the second built from structured-cloned
//                options, as the terrain worker is) at 5000 points asked in a different order; the
//                prevailing wind angle equals the WindField's
//   maptiles     the map tiles colour every local water body (lake, pool, film, ice) in its tint at every
//                sample waterBodyAt covers, and the cache tag of presets without waters or overlays
//                is the Phase 2 tag (cached tiles of such worlds stay valid)
//   vegetation   the vegetation provider emits a cylinder per redwood trunk, deterministically, each
//                under a tree the scatter draws at the lowest quality density; perches come from the
//                redwood tops and the tallest pines; vegetationNear equals the chunk scatter
//   cost         heightAt and sample along a 120 Hz flight path: median under 1 us over the open
//                ocean (no body in reach), under 3 us with a lake in reach
//   allocation   heightAt and sample create no objects and retain nothing: after 1 000 000 queries and a
//                full collection the heap is back within 64 KB (the short-lived churn, doubles V8
//                boxes at calls it does not inline, is printed)
//
// Usage: node --expose-gc tools/lab/water.mjs [--verbose]
// Prints one line per check (failures and the numbers always) and exits non-zero if any check fails.
import v8 from 'node:v8';
import * as THREE from 'three/webgpu';
import { WORLD_OPTIONS } from '../../src/core/config.js';
import { createWorldGen } from '../../src/world/worldgen.js';
import { createWaterQuery, createOceanWaves, oceanHeight, oceanSample, oceanSwellScale, OCEAN_WAVES, WAVE_TILE } from '../../src/world/waterQuery.js';
import { waterOutlineContains } from '../../src/world/waters.js';
import { createVegetationColliders, registerVegetationColliders } from '../../src/world/vegetationColliders.js';
import { createColliderWorld } from '../../src/world/colliders.js';
import { createGroundSurfaces } from '../../src/world/groundSurfaces.js';
import { VEGETATION_IDS } from '../../src/world/vegetationSpecies.js';
import { WATER_FIXTURES } from '../../src/dev/waterFixtures.js';
import { createMapTileGenerator, mapTileCacheTag, MAP_TILE_VERSION } from '../../src/world/mapTileGen.js';
import { PRESETS } from '../../src/spawns/presets/index.js';
import { prevailingWindDirection } from '../../src/env/WindField.js';
import { createGroundContact } from '../../src/flight/groundContact.js';
import { flightModels } from '../../src/flight/models.js';
import glider from '../../src/craft/glider.js';
import { createControlState } from '../../src/input/controlState.js';
import { createFlightTelemetry } from '../../src/flight/telemetry.js';
import { EventBus } from '../../src/core/eventBus.js';
import { attachTypedEvents } from '../../src/core/events.js';

const VERBOSE = process.argv.includes('--verbose');
for (const flag of process.argv.slice(2)) {
  if (flag !== '--verbose') throw new Error(`Unknown flag ${flag}`);
}
const SEED = 'HARNESS-1';
const DEG = Math.PI / 180;
const started = Date.now();
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

const fixtureOptions = { ...WORLD_OPTIONS, presets: WATER_FIXTURES };
const world = createWorldGen(SEED, fixtureOptions);
const wind = { x: 0.8, y: 0.6 };
const clock = { elapsed: 0 };
const query = createWaterQuery({ world, windDirection: wind, clock });
const sites = world.sitesNear(0, 0, 30000);
const bodies = sites.flatMap((site) => site.waters);

// ---- table -------------------------------------------------------------------------------------
/** The Phase 2 ocean's wave set exactly as water.js built it before Phase 3. */
function phase2Waves(windX, windZ) {
  const windAngle = Math.atan2(windZ, windX);
  const quantise = (angleDegrees, wavelength) => {
    const angle = windAngle + angleDegrees * DEG;
    const cyclesX = Math.round((4096 * Math.cos(angle)) / wavelength);
    const cyclesZ = Math.round((4096 * Math.sin(angle)) / wavelength);
    const frequencyX = cyclesX / 4096;
    const frequencyZ = cyclesZ / 4096;
    const frequency = Math.hypot(frequencyX, frequencyZ);
    const waveNumber = 2 * Math.PI * frequency;
    return { frequencyX, frequencyZ, waveNumber, angularSpeed: Math.sqrt(9.81 * waveNumber) * 0.9 };
  };
  const swell = [[0, 84, 0.26], [-31, 51, 0.19], [27, 33, 0.13], [-9, 21, 0.08]].map(([angle, wavelength, amplitude], index) => ({ ...quantise(angle, wavelength), amplitude, phaseSeed: (index * 0.618034) % 1 }));
  const detail = [[22, 14.3, 0.06], [-31, 10.4, 0.066], [6, 7.6, 0.072], [-12, 5.7, 0.072], [47, 4.4, 0.066], [-58, 3.5, 0.062], [104, 2.8, 0.048], [-117, 2.2, 0.044], [31, 1.7, 0.04]]
    .map(([angle, wavelength, slope], index) => {
      const wave = quantise(angle, wavelength);
      return { ...wave, amplitude: slope / wave.waveNumber, phaseSeed: ((index + 4) * 0.618034) % 1 };
    });
  return [...swell, ...detail];
}

function testTable() {
  let worst = 0;
  for (const [x, z] of [[0.8, 0.6], [1, 0], [-0.3, 0.95], [-0.7, -0.7], [0.1, -1]]) {
    const ours = createOceanWaves(x, z);
    const all = [...ours.swell, ...ours.detail];
    const reference = phase2Waves(x, z);
    for (let index = 0; index < reference.length; index++) {
      for (const field of ['frequencyX', 'frequencyZ', 'waveNumber', 'angularSpeed', 'amplitude', 'phaseSeed']) {
        worst = Math.max(worst, Math.abs(all[index][field] - reference[index][field]));
      }
    }
  }
  check('table', 'the quantised wave table equals the Phase 2 ocean (5 wind directions, 13 waves, every field)', worst === 0, `worst difference ${worst}`);
  check('table', `${OCEAN_WAVES.swell.length} swell and ${OCEAN_WAVES.detail.length} detail waves, whole cycles over the ${WAVE_TILE} m tile`, createOceanWaves(0.8, 0.6).swell.every((wave) => Number.isInteger(Math.round(wave.frequencyX * WAVE_TILE * 1e6) / 1e6)));
  let swellWorst = 0;
  for (let t = 0; t < 4000; t += 7.3) {
    const strength = 1 + 0.1 * Math.sin(t * 0.011) + 0.05 * Math.sin(t * 0.037 + 1.7);
    const expected = Math.min(1.2, Math.max(0.7, 0.75 + 0.35 * strength));
    swellWorst = Math.max(swellWorst, Math.abs(oceanSwellScale(t) - expected));
  }
  check('table', 'the swell scale is the ambient wind formula of src/render/clouds.js, clamped 0.7..1.2', swellWorst === 0, `worst ${swellWorst}`);
}

// ---- ocean -------------------------------------------------------------------------------------
/** The ocean shader's vertex displacement at surface parameter (px, pz): written out from its node graph. */
function shaderVertex(waves, px, pz, t, swellScale) {
  let x = px;
  let y = 0;
  let z = pz;
  for (const wave of waves.swell) {
    const cycles = ((wave.angularSpeed * t) / (2 * Math.PI) + wave.phaseSeed) % 1;
    const dot = px * wave.frequencyX + pz * wave.frequencyZ - cycles;
    const theta = (dot - Math.floor(dot)) * 2 * Math.PI;
    const amplitude = swellScale * wave.amplitude;
    const horizontal = Math.cos(theta) * amplitude * wave.steepness;
    x += horizontal * wave.directionX;
    z += horizontal * wave.directionZ;
    y += Math.sin(theta) * amplitude;
  }
  return { x, y, z };
}

function testOcean() {
  const waves = query.waves;
  const random = mulberry32(7);
  let worst = 0;
  let worstNormal = 0;
  let worstVelocity = 0;
  const out = {};
  for (let sample = 0; sample < 2000; sample++) {
    const px = (random() - 0.5) * 200000;
    const pz = (random() - 0.5) * 200000;
    const t = random() * 3000;
    const scale = oceanSwellScale(t);
    const vertex = shaderVertex(waves, px, pz, t, scale);
    worst = Math.max(worst, Math.abs(oceanHeight(vertex.x, vertex.z, t, scale, waves) - vertex.y));
    oceanSample(vertex.x, vertex.z, t, scale, waves, out);
    worstNormal = Math.max(worstNormal, Math.abs(Math.hypot(out.normalX, out.normalY, out.normalZ) - 1));
    // The vertical velocity is the height's time derivative at a fixed horizontal point (plus the
    // horizontal drift term, small): a central difference of the shader's own vertex over 1 ms.
    const before = shaderVertex(waves, px, pz, t - 0.0005, scale);
    const after = shaderVertex(waves, px, pz, t + 0.0005, scale);
    worstVelocity = Math.max(worstVelocity, Math.abs((after.y - before.y) / 0.001 - out.velocityY));
  }
  check('ocean', 'oceanHeight equals the shader\'s vertex height at 2000 sampled points and times (3 cm)', worst < 0.03, `worst ${round(worst, 4)} m`);
  check('ocean', 'the sample normal is a unit vector', worstNormal < 1e-9, `worst ${worstNormal}`);
  check('ocean', 'the sample\'s vertical orbital velocity follows the vertex (0.05 m/s)', worstVelocity < 0.05, `worst ${round(worstVelocity, 4)} m/s`);
}

// ---- clipping ----------------------------------------------------------------------------------
function testClipping() {
  const kinds = new Set(bodies.map((body) => `${body.basin.type}/${body.kind}/${body.material}`));
  check('clipping', 'the fixtures give water bodies of every host and kind within 30 km (basin, crater, terraces, flatten; lake, pool, thin; water, ice)', ['basin', 'crater', 'terraces', 'flatten'].every((type) => [...kinds].some((kind) => kind.startsWith(type))) && bodies.some((body) => body.material === 'ice'), [...kinds].join(', '));
  let centreFailures = 0;
  let spills = 0;
  let above = 0;
  let covered = 0;
  let iceWrong = 0;
  const sample = {};
  for (const body of bodies) {
    query.sample(body.x, body.z, 100, sample);
    if (!(sample.bodyId === body.id && sample.height === body.level && sample.material === body.material)) centreFailures++;
    if (body.material === 'ice' && !(sample.material === 'ice' && query.heightAt(body.x, body.z, 100) === body.level)) iceWrong++;
    const b = body.bounds;
    for (let row = 0; row <= 40; row++) {
      for (let column = 0; column <= 40; column++) {
        const x = b.minX - 40 + ((b.maxX - b.minX + 80) * column) / 40;
        const z = b.minZ - 40 + ((b.maxZ - b.minZ + 80) * row) / 40;
        query.sample(x, z, 100, sample);
        if (sample.bodyId !== body.id) continue;
        covered++;
        if (sample.height > body.level) above++;
        if (!waterOutlineContains(body, x, z) || world.groundHeight(x, z) >= body.level) spills++;
      }
    }
  }
  check('clipping', `every body (${bodies.length}) is covered at its centre at exactly its level and material`, centreFailures === 0 && bodies.length > 0, `${centreFailures} failures`);
  check('clipping', 'no water outside a basin\'s outline or over basin ground above the level', spills === 0 && covered > 0, `${covered} covered samples, ${spills} spills`);
  check('clipping', 'no body is ever reported above its level', above === 0, `${above}`);
  check('clipping', 'ice bodies are solid ice at their level', iceWrong === 0, `${iceWrong}`);
  // Dry land with no body: none; deep ocean: the ocean.
  const dry = sites.find((site) => site.presetId === 'fixtureAutumn');
  check('clipping', 'dry land without a body has no water (-Infinity, kind none)', query.heightAt(dry.x, dry.z, 0) === -Infinity && query.sample(dry.x, dry.z, 0, sample).kind === 'none');
  const ocean = world.findNearest(0, 0, 'ocean', 30000);
  query.sample(ocean.x, ocean.z, 50, sample);
  check('clipping', 'deep water is the ocean (sea level plus the swell)', sample.kind === 'ocean' && Math.abs(sample.height) < 1 && sample.depth > 5, `${sample.kind} ${round(sample.height)} m, depth ${round(sample.depth)} m`);
}

// ---- contact -----------------------------------------------------------------------------------
function envWith(useQuery) {
  return {
    time: 100,
    wind: { vel: new THREE.Vector3(), turbulence: 0 },
    groundHeight: world.groundHeight,
    waterLevel: 0,
    waterHeight: useQuery ? (x, z) => query.heightAt(x, z, 100) : null,
    waterSample: useQuery ? (x, z, out) => query.sample(x, z, 100, out) : null,
    rho: 1.225,
    world,
  };
}

/** One contact point (a skid) touching at (x, z), `depth` metres below `surface`. */
function probeContact(x, z, surface, depth) {
  const contact = createGroundContact([{ id: 'skid', position: [0, -0.5, 0], kind: 'skid', spring: 40000, damping: 4000, friction: 0.6, gear: true }], { centerOfMass: new THREE.Vector3(), floats: false, mass: 400 });
  const body = { position: new THREE.Vector3(x, surface + 0.5 - depth, z), velocity: new THREE.Vector3(3, -1, 0), quaternion: new THREE.Quaternion(), angularVelocity: new THREE.Vector3() };
  const force = new THREE.Vector3();
  const moment = new THREE.Vector3();
  const report = contact.evaluate(body, { brakeLeft: 0, brakeRight: 0, steering: 0, gearDown: true }, envWith(true), 1 / 120, force, moment);
  return { onGround: report.onGround, water: report.water, surface: report.surface, horizontal: Math.hypot(force.x, force.z), vertical: force.y };
}

function createGliderRig(env) {
  const bus = attachTypedEvents(new EventBus(), { validate: true });
  const craftState = glider.abilities.craftAbility.initialState();
  const model = flightModels.create(glider.simProfile.model, { profile: glider.simProfile, craft: glider, world, bus, state: null, craftState });
  env.craftState = craftState;
  env.assists = 0;
  env.handsOff = false;
  env.autopilot = { enabled: false, heading: 0, altitude: 0, speed: 0, followWaypoint: false };
  env.telemetry = createFlightTelemetry();
  return { model, controls: createControlState(), env };
}

function sinkInto(x, z, surface) {
  const rig = createGliderRig(envWith(true));
  rig.model.reset({ position: new THREE.Vector3(x, surface + 3, z), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(0, -3, -22), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: false, engineOn: true });
  for (let tick = 0; tick < 240; tick++) {
    rig.env.time += 1 / 120;
    rig.model.step(1 / 120, rig.controls, rig.env);
    if (rig.model.contact.water || rig.model.contact.onGround) break;
  }
  return { water: Boolean(rig.model.contact.water), onGround: Boolean(rig.model.contact.onGround) };
}

function testContact() {
  const ice = bodies.find((body) => body.material === 'ice');
  const iceContact = probeContact(ice.x, ice.z, ice.level, 0.05);
  check('contact', 'ice is solid ground: on the ground, no water, surface ice', iceContact.onGround && !iceContact.water && iceContact.surface === 'ice', JSON.stringify(iceContact));
  check('contact', 'ice friction is low (horizontal force at most 0.06 of the normal force)', iceContact.horizontal <= 0.06 * iceContact.vertical + 1e-6, `${round(iceContact.horizontal)} N vs ${round(iceContact.vertical)} N`);
  const film = bodies.find((body) => body.kind === 'thin');
  const filmContact = probeContact(film.x, film.z, film.floorY, 0.05);
  check('contact', 'a thin film is wet ground: on the ground under it, no water', filmContact.onGround && !filmContact.water, JSON.stringify(filmContact));
  const lake = bodies.find((body) => body.basin.type === 'basin' && body.material === 'water');
  const lakeContact = probeContact(lake.x, lake.z, lake.level, 0.05);
  check('contact', 'a lake is water for a craft that cannot float', lakeContact.water, JSON.stringify(lakeContact));
  const lakeSink = sinkInto(lake.x, lake.z, lake.level);
  check('contact', 'a glider sinking into a lake reports water (the flight controller\'s water soft crash)', lakeSink.water, JSON.stringify(lakeSink));
  const ocean = world.findNearest(0, 0, 'ocean', 30000);
  const oceanSink = sinkInto(ocean.x, ocean.z, query.heightAt(ocean.x, ocean.z, 100));
  check('contact', 'a glider sinking into the ocean reports water', oceanSink.water, JSON.stringify(oceanSink));
  // Far from any water the query changes nothing: the same flight, bit for bit, with the flat sea.
  const dry = sites.find((site) => site.presetId === 'fixtureAutumn');
  const runs = [true, false].map((useQuery) => {
    const rig = createGliderRig(envWith(useQuery));
    rig.model.reset({ position: new THREE.Vector3(dry.x, world.groundHeight(dry.x, dry.z) + 6, dry.z), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(0, -2, -24), angularVelocity: new THREE.Vector3(), throttle: 0, onGround: false, engineOn: true });
    for (let tick = 0; tick < 600; tick++) {
      rig.env.time += 1 / 120;
      rig.model.step(1 / 120, rig.controls, rig.env);
    }
    const state = rig.model.state;
    return [state.position.x, state.position.y, state.position.z, state.velocity.x, state.velocity.y, state.velocity.z].join(',');
  });
  check('contact', 'over dry land the flight (touchdown and roll, 5 s) is bit-identical with the query and with the flat sea', runs[0] === runs[1], runs[0].slice(0, 60));
}

// ---- determinism -------------------------------------------------------------------------------
function testDeterminism() {
  const clone = createWorldGen(SEED, structuredClone(fixtureOptions));
  const random = mulberry32(3);
  const points = [];
  for (const body of bodies) {
    for (let index = 0; index < 60; index++) points.push([body.x + (random() - 0.5) * 900, body.z + (random() - 0.5) * 900]);
  }
  while (points.length < 5000) points.push([(random() - 0.5) * 50000, (random() - 0.5) * 50000]);
  const first = points.map(([x, z]) => {
    const body = world.waterBodyAt(x, z);
    return body ? `${body.id}@${body.level}` : '-';
  });
  const second = points.slice().reverse().map(([x, z]) => {
    const body = clone.waterBodyAt(x, z);
    return body ? `${body.id}@${body.level}` : '-';
  }).reverse();
  const wet = first.filter((entry) => entry !== '-').length;
  check('determinism', 'waterBodyAt agrees between the main thread and a worker-cloned world (5000 points, reverse order)', first.every((entry, index) => entry === second[index]) && wet > 100, `${wet} wet points`);
  const direction = prevailingWindDirection(world, new THREE.Vector2());
  check('determinism', 'the prevailing wind angle overlays follow equals the WindField\'s', Math.abs(Math.cos(world.prevailingWindAngle) - direction.x) < 1e-12 && Math.abs(Math.sin(world.prevailingWindAngle) - direction.y) < 1e-12);
}

// ---- map tiles -----------------------------------------------------------------------------------
/** The Phase 2 map tile cache tag (placement and stamps only), written out. */
function phase2TileTag(seed, presets) {
  const text = JSON.stringify(presets.map((preset) => [preset.id, preset.kind, preset.placement ?? null, preset.stamps ?? null]));
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${String(seed).toUpperCase()}|v${MAP_TILE_VERSION}|${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function testMapTiles() {
  const generator = createMapTileGenerator(world);
  let covered = 0;
  let wrong = 0;
  const kinds = new Set();
  for (const body of bodies) {
    const size = Math.max(body.bounds.maxX - body.bounds.minX, body.bounds.maxZ - body.bounds.minZ) + 200;
    const resolution = 48;
    const minX = (body.bounds.minX + body.bounds.maxX) / 2 - size / 2;
    const minZ = (body.bounds.minZ + body.bounds.maxZ) / 2 - size / 2;
    const { color } = generator.generate({ x: minX, z: minZ, size, resolution, fields: ['color'] });
    const step = size / resolution;
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const covering = world.waterBodyAt(minX + (column + 0.5) * step, minZ + (row + 0.5) * step);
        if (covering === null || covering.level <= world.WATER_LEVEL) continue;
        covered++;
        kinds.add(`${covering.kind}/${covering.material}`);
        const out = (row * resolution + column) * 4;
        const tint = covering.tint ?? null;
        // A body pixel is its tint scaled by one depth factor (0.62..1.12) on all three channels.
        if (tint !== null) {
          const scales = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255].map((channel, index) => (channel > 24 ? color[out + index] / channel : null)).filter((scale) => scale !== null);
          if (scales.some((scale) => scale < 0.6 || scale > 1.14) || Math.max(...scales) - Math.min(...scales) > 0.08) wrong++;
        }
      }
    }
  }
  check('maptiles', 'map tiles colour every water body sample in its own tint (lakes, pools, films and ice)', covered > 200 && wrong === 0, `${covered} body samples over ${bodies.length} bodies (${[...kinds].join(', ')}), ${wrong} off-tint`);
  check('maptiles', 'the cache tag of presets without waters or overlays is the Phase 2 tag', mapTileCacheTag('HARNESS-1', PRESETS) === phase2TileTag('HARNESS-1', PRESETS));
  check('maptiles', 'the cache tag changes with the waters and overlays of the fixture presets', mapTileCacheTag('HARNESS-1', WATER_FIXTURES) !== phase2TileTag('HARNESS-1', WATER_FIXTURES));
}

// ---- vegetation ----------------------------------------------------------------------------------
function testVegetation() {
  const redwoods = sites.find((site) => site.presetId === 'fixtureRedwoods');
  const providers = [createVegetationColliders(world), createVegetationColliders(createWorldGen(SEED, structuredClone(fixtureOptions)))];
  const emitted = providers.map(({ provider }) => {
    const list = [];
    provider.query(redwoods.x - 600, redwoods.z - 600, redwoods.x + 600, redwoods.z + 600, (spec) => list.push(spec));
    return list;
  });
  const lines = emitted.map((list) => list.map((spec) => `${spec.id}:${spec.center.y.toFixed(3)}:${spec.radius.toFixed(3)}`).join('|'));
  const trunks = emitted[0];
  check('vegetation', 'the provider emits a cylinder per redwood trunk, the same from two worlds', trunks.length > 20 && trunks.every((spec) => spec.type === 'cylinder' && spec.owner === 'vegetation' && spec.radius > 1.5 && spec.halfHeight > 20) && lines[0] === lines[1], `${trunks.length} trunks`);
  // Every trunk stands under a redwood the scatter draws at the lowest quality density (0.45).
  const drawn = new Set();
  const minChunkX = Math.floor((redwoods.x - 650) / 256);
  const maxChunkX = Math.floor((redwoods.x + 650) / 256);
  const minChunkZ = Math.floor((redwoods.z - 650) / 256);
  const maxChunkZ = Math.floor((redwoods.z + 650) / 256);
  for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
    for (let cx = minChunkX; cx <= maxChunkX; cx++) {
      const raw = world.scatterChunk(cx, cz, 0.45);
      for (let index = 0; index < raw.length; index += 7) {
        if (raw[index + 5] === VEGETATION_IDS.REDWOOD) drawn.add(`${Math.round((cx * 256 + raw[index]) * 10)}:${Math.round((cz * 256 + raw[index + 2]) * 10)}`);
      }
    }
  }
  // Matched within 5 cm (the scatter stores chunk-local float32 positions).
  const drawnPoints = [...drawn].map((key) => key.split(':').map((value) => Number(value) / 10));
  const orphans = trunks.filter((spec) => !drawnPoints.some(([x, z]) => Math.abs(x - spec.center.x) < 0.15 && Math.abs(z - spec.center.z) < 0.15)).length;
  check('vegetation', 'every trunk collider stands under a drawn redwood, even at the lowest vegetation density', orphans === 0, `${orphans} without a tree`);
  const perches = [];
  providers[0].perchProvider.near(redwoods.x, 80, redwoods.z, 700, (x, y, z, kind, id) => perches.push({ x, y, z, kind, id }));
  check('vegetation', 'perches: the redwood tops (60-110 m above their base)', perches.some((point) => point.id.startsWith('perch:redwood') && point.y - world.groundHeight(point.x, point.z) > 55), `${perches.length} perches`);
  // The same providers registered with the real collider service (contract b.2, d.4).
  const service = createColliderWorld({ groundSurfaces: createGroundSurfaces() });
  const unregister = registerVegetationColliders(service, world);
  const trunk = trunks[0];
  const servicePerches = [];
  service.perchesNear(redwoods.x, 80, redwoods.z, 700, (x, y, z, kind, id) => servicePerches.push({ x, y, z, kind, id }));
  const from = { x: trunk.center.x - 40, y: trunk.center.y, z: trunk.center.z };
  const to = { x: trunk.center.x + 40, y: trunk.center.y, z: trunk.center.z };
  const hit = { t: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, id: '', owner: '', tags: null, velocity: null };
  const struck = service.sweepSphere(from, to, 0.5, { sensors: false }, hit);
  check('vegetation', 'with the real collider service: a sweep into a redwood hits its trunk, and perchesNear lists the tree tops', struck && hit.owner === 'vegetation' && hit.id === trunk.id && servicePerches.some((point) => point.kind === 'tree' && point.id.startsWith('perch:redwood')), `hit ${struck ? hit.id : 'none'}, ${servicePerches.length} perches`);
  unregister();
  check('vegetation', 'unregistering removes the trunk provider and the perch provider', service.providerCount === 0 && service.getStats().perchProviders === 0, `${service.providerCount} providers, ${service.getStats().perchProviders} perch providers`);
  // vegetationNear equals the chunk scatter (full density) in one chunk.
  const cx = Math.floor(redwoods.x / 256);
  const cz = Math.floor(redwoods.z / 256);
  const raw = world.scatterChunk(cx, cz, 1);
  const fromChunk = [];
  for (let index = 0; index < raw.length; index += 7) fromChunk.push(`${raw[index + 5]}:${Math.fround(raw[index]).toFixed(2)}:${Math.fround(raw[index + 2]).toFixed(2)}`);
  const fromNear = [];
  world.vegetationNear(cx * 256 + 128, cz * 256 + 128, 200, (instance) => {
    const localX = instance.x - cx * 256;
    const localZ = instance.z - cz * 256;
    if (localX >= 0 && localX < 256 && localZ >= 0 && localZ < 256) fromNear.push(`${instance.type}:${Math.fround(localX).toFixed(2)}:${Math.fround(localZ).toFixed(2)}`);
  });
  const chunkSet = new Set(fromChunk);
  check('vegetation', 'vegetationNear returns the chunk scatter\'s instances (no build needed)', fromNear.length > 30 && fromNear.every((entry) => chunkSet.has(entry)), `${fromNear.length} near, ${fromChunk.length} in the chunk`);
}

// ---- cost and allocation -------------------------------------------------------------------------
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Median cost (us per call) of fn along a 120 Hz path from (x, z) heading along (dx, dz) at 60 m/s. */
function pathCost(fn, x, z, dx, dz) {
  const slices = [];
  for (let slice = 0; slice < 61; slice++) {
    const startedAt = process.hrtime.bigint();
    for (let tick = 0; tick < 1200; tick++) {
      const along = (slice * 1200 + tick) * 0.5;
      fn(x + dx * along, z + dz * along, (slice * 1200 + tick) / 120);
    }
    slices.push(Number(process.hrtime.bigint() - startedAt) / 1000 / 1200);
  }
  return median(slices.slice(1));
}

function testCost() {
  const oceanWorld = createWorldGen(SEED, { ...WORLD_OPTIONS, presets: [] });
  const oceanQuery = createWaterQuery({ world: oceanWorld, windDirection: wind, clock });
  const ocean = oceanWorld.findNearest(0, 0, 'ocean', 30000);
  const sampleOut = {};
  for (let warm = 0; warm < 50000; warm++) oceanQuery.heightAt(ocean.x + warm * 0.01, ocean.z, warm / 120);
  const oceanHeightCost = pathCost((x, z, t) => oceanQuery.heightAt(x, z, t), ocean.x, ocean.z, 0.6, 0.8);
  const oceanSampleCost = pathCost((x, z, t) => oceanQuery.sample(x, z, t, sampleOut), ocean.x, ocean.z, 0.6, 0.8);
  check('cost', 'heightAt over the open ocean (no body in reach): median under 1 us', oceanHeightCost < 1, `${round(oceanHeightCost, 3)} us per call (sample: ${round(oceanSampleCost, 3)} us)`);
  const lake = bodies.find((body) => body.basin.type === 'basin');
  for (let warm = 0; warm < 50000; warm++) query.heightAt(lake.x - 200 + warm * 0.004, lake.z, warm / 120);
  const lakeHeightCost = pathCost((x, z, t) => query.heightAt(x, z, t), lake.x - 300, lake.z, 1, 0);
  const lakeSampleCost = pathCost((x, z, t) => query.sample(x, z, t, sampleOut), lake.x - 300, lake.z, 1, 0);
  check('cost', 'heightAt and sample with a lake in reach: median under 3 us', lakeHeightCost < 3 && lakeSampleCost < 3, `heightAt ${round(lakeHeightCost, 3)} us, sample ${round(lakeSampleCost, 3)} us per call`);
}

async function testAllocation() {
  const lake = bodies.find((body) => body.basin.type === 'basin');
  const sampleOut = {};
  const run = (count) => {
    for (let index = 0; index < count; index++) {
      const x = lake.x - 300 + (index % 6000) * 0.1;
      query.heightAt(x, lake.z, index / 120);
      query.sample(x, lake.z + 3, index / 120, sampleOut);
    }
  };
  run(300000);
  const youngUsed = () => v8.getHeapSpaceStatistics().find((space) => space.space_name === 'new_space').space_used_size;
  // The short-lived churn: one window of 10 000 calls (20 000 queries) after a forced collection.
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const youngBefore = youngUsed();
  run(10000);
  const churn = Math.max(0, youngUsed() - youngBefore) / 20000;
  // Nothing is retained: 1 000 000 more queries leave the heap where it was after a full collection.
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  run(500000);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const retained = process.memoryUsage().heapUsed - heapBefore;
  check('allocation', 'heightAt and sample retain nothing: the heap after 1 000 000 queries and a full collection is back within 64 KB', typeof globalThis.gc === 'function' && retained < 65536,
    `${round(retained / 1024, 1)} KB retained; short-lived churn ${round(churn, 1)} B per query (V8 boxes the doubles passed to and returned from calls it does not inline; the query creates no objects)`);
}

testTable();
testOcean();
testClipping();
testContact();
testDeterminism();
testVegetation();
testCost();
await testAllocation();
// Last: the tiles' bulk worldgen work would warm and churn the heap the cost and allocation checks measure.
testMapTiles();

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  if (VERBOSE || !result.pass || result.test === 'cost' || result.test === 'allocation') {
    process.stdout.write(`${result.pass ? 'PASS' : 'FAIL'}  [${result.test}] ${result.name}${result.detail ? `: ${result.detail}` : ''}\n`);
  }
}
process.stdout.write(`water lab: ${results.length - failed}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s\n`);
process.exit(failed === 0 ? 0 : 1);
