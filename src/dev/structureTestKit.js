// Dev-only StructureEngine test kit: preset-like objects for every recipe (valid against
// src/spawns/schema.js) and a helper that resolves a preset's stamps into a site record, the way
// placement.js does, for a chosen spot. tools/lab/structure.mjs builds real stamped sites with it,
// and tools/steps/engine-structure.json force-spawns the presets ahead of the craft through the dev
// hook (spawns.debug.addPreset). Never part of a production build: only the lab and dev-server step
// files import it. The real presets arrive with Milestone E in src/spawns/presets/.
import { resolveStamp } from '../world/stamps.js';

const SITE_FILTERS = Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null });
const SITE_LIFETIME = Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 }) });
const CALLOUTS = Object.freeze(['{name} {distance} {direction}.', '{name} ahead, {eta}.', 'Structure check: {name}.']);

function testSite(id, name, { category = 'structure', heavy = false, lure = null, stamps = [], engines, lod, audio = null, radius = 1500 }) {
  return Object.freeze({
    id,
    name,
    category,
    kind: 'site',
    rarity: 'common',
    heavy,
    // Never placed by a world (worlds place only src/spawns/presets); the kit's tests place them by hand.
    placement: Object.freeze({ chance: 0.01, minSpacing: 0, biomes: null, surface: 'any', clearance: 0 }),
    filters: SITE_FILTERS,
    stamps: Object.freeze(stamps.map((stamp) => Object.freeze(stamp))),
    engines: Object.freeze(engines.map((entry) => Object.freeze(entry))),
    lod: Object.freeze(lod),
    lure,
    wind: [],
    audio,
    journal: Object.freeze({ title: name, description: 'A StructureEngine test fixture.' }),
    discovery: Object.freeze({ radius, requireInView: true }),
    callouts: CALLOUTS,
    lifetime: SITE_LIFETIME,
  });
}

/** The kit's presets, one per recipe (ids prefixed 'dev'). */
export function createStructureTestPresets() {
  return Object.freeze([
    testSite('devWindFarm', 'Dev wind farm', {
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'windFarm', count: 6, rows: 2, spacing: 240 }) }],
      lod: { near: 1800, mid: 6000, far: 14000 },
      audio: Object.freeze({ recipe: 'turbine', params: Object.freeze({}) }),
      radius: 2500,
    }),
    testSite('devRopeBridge', 'Dev rope bridge', {
      stamps: [{ type: 'gorge', length: [800, 1000], width: [90, 120], depth: [80, 110], falloff: [160, 200], pad: [60, 80], paint: 'riverbed' }],
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'ropeBridge', span: 150, gate: Object.freeze({ id: 'under', achievement: Object.freeze({ id: 'threadTheNeedle', title: 'Thread the Needle' }) }) }) }],
      lod: { near: 1200, mid: 4000, far: 9000 },
    }),
    testSite('devAirfield', 'Dev airfield', {
      stamps: [{ type: 'flatten', length: [1100, 1300], width: [42, 50], margin: [36, 48], shoulder: [110, 150], paint: 'tarmac' }],
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'airfield', length: 1100, width: 45, hangars: Object.freeze({ count: 3, ruin: 0.6 }) }) }],
      lod: { near: 1800, mid: 6000, far: 12000 },
      radius: 2000,
    }),
    testSite('devIslands', 'Dev floating islands', {
      category: 'fantasy',
      heavy: true,
      lure: Object.freeze({ type: 'islands', height: 600, width: 1200, altitude: 250, color: 0x7d705f }),
      stamps: [{ type: 'islandBase', radius: [170, 230], height: [24, 40], falloff: [90, 120], paint: 'basalt' }],
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'islands', count: 3, altitude: [160, 260], spread: 420 }) }],
      lod: { near: 2000, mid: 8000, far: 30000 },
      audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({}) }),
      radius: 3000,
    }),
    testSite('devSpires', 'Dev crystal spires', {
      category: 'fantasy',
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'spires', count: 7 }) }],
      lod: { near: 1500, mid: 5000, far: 12000 },
      audio: Object.freeze({ recipe: 'crystal', params: Object.freeze({}) }),
    }),
    testSite('devCanyonGates', 'Dev canyon run', {
      category: 'geo',
      stamps: [{ type: 'carve', length: [2200, 2600], width: [36, 50], depth: [75, 95], wallWidth: [18, 26], twist: [180, 260], plateau: [40, 60], shoulder: [110, 140], paint: 'riverbed' }],
      engines: [{ engine: 'structure', params: Object.freeze({ recipe: 'gates', course: 'devCanyonRun' }) }],
      lod: { near: 1500, mid: 5000, far: 12000 },
    }),
  ]);
}

/** A seeded mulberry32 generator. */
function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A site record for preset at (x, z) facing rotation (radians), its stamps resolved against the
 * unstamped height baseHeight(x, z) as placement does. Returns the frozen site.
 */
export function buildTestSite(preset, { x, z, rotation = 0, seed = 12345, cellX = Math.floor(x / 2000), cellZ = Math.floor(z / 2000) }, { baseHeight, waterLevel }) {
  const site = { id: `${preset.id}:${cellX}:${cellZ}`, presetId: preset.id, cellX, cellZ, x, z, rotation, scale: 1, seed };
  const stamps = (preset.stamps ?? []).map((spec, index) => resolveStamp(spec, site, index, mulberry32(seed + index * 7919), { baseHeight, waterLevel }));
  return Object.freeze({ ...site, groundY: Math.max(baseHeight(x, z), waterLevel), biome: 'meadows', stamps: Object.freeze(stamps) });
}
