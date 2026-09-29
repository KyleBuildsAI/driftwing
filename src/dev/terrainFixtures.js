// Terrain-stamp FIXTURE presets for the terrain test (?test=terrain) and tools/lab/terrain.mjs only.
//
// Six site presets in the preset schema (docs/specs/phase2-contract.md, section 1), one per stamp
// type, shaped like the real sites they stand in for (volcano, slot canyon, mega-waterfall, rope
// bridge, abandoned airfield, floating islands). They are NOT game content: the real presets live in
// src/spawns/presets/, and these only reach the world through the dev-only hook (the harness passes
// them as worldgen's options.presets). Their chances are far above a real preset's so that every
// stamp type sits within a short flight of any spawn, which the tests need.
//
// Pure data, like every preset: the terrain worker receives them through its init message.

const LIFETIME_SITE = Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 }) });

export const FIXTURE_VOLCANO = Object.freeze({
  id: 'fixtureVolcano',
  name: 'Fixture volcano',
  category: 'geo',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  placement: {
    chance: 0.3,
    minSpacing: 9000,
    biomes: ['snow', 'pine', 'dunes', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 700, relief: 'any' },
    clearance: 400,
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 5000 }, weather: null, surface: 'land', minDistance: 0, maxDistance: 40000 },
  stamps: [{ type: 'cone', radius: [900, 1200], height: [300, 420], craterRadius: [150, 200], craterDepth: [70, 110], paint: 'ash' }],
  engines: [{ engine: 'emitter', params: { kind: 'plume', rate: 40 } }],
  lod: { near: 2000, mid: 8000, far: 40000 },
  lure: { type: 'plume', height: 2400, width: 900, color: 0x4a4644 },
  wind: [{ type: 'updraft', params: { radius: 400, speed: 12 } }],
  audio: { recipe: 'volcano', params: {} },
  journal: { title: 'Volcano', description: 'A fixture cone and crater for the terrain test.' },
  discovery: { radius: 4000, requireInView: true },
  callouts: ['Volcano {distance} {direction}.', 'Ash cone {distance} out.', 'Crater ahead, {eta}.'],
  lifetime: LIFETIME_SITE,
});

export const FIXTURE_SLOT_CANYON = Object.freeze({
  id: 'fixtureSlotCanyon',
  name: 'Fixture slot canyon',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.35,
    minSpacing: 8000,
    biomes: ['dunes', 'pine', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 40, relief: 'any' },
    clearance: 300,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 3000 }, weather: null, surface: 'land', minDistance: 0, maxDistance: 20000 },
  stamps: [{ type: 'carve', length: [2200, 3000], width: [36, 54], depth: [75, 105], wallWidth: [18, 28], twist: [180, 320], plateau: [40, 70], shoulder: [110, 150], paint: 'riverbed' }],
  engines: [{ engine: 'structure', params: { recipe: 'gates' } }],
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Slot canyon', description: 'A fixture canyon carve for the terrain test.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: ['Canyon entrance {distance} {direction}.', 'Slot canyon ahead.', 'Canyon run {eta} out.'],
  lifetime: LIFETIME_SITE,
});

export const FIXTURE_WATERFALL = Object.freeze({
  id: 'fixtureWaterfall',
  name: 'Fixture waterfall',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.35,
    minSpacing: 8000,
    biomes: ['pine', 'snow', 'meadows', 'archipelago'],
    surface: 'land',
    terrain: { minHeight: 30, relief: 'any' },
    clearance: 300,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 3000 }, weather: null, surface: 'land', minDistance: 0, maxDistance: 20000 },
  stamps: [{ type: 'cliffStep', width: [300, 400], drop: [90, 130], length: [420, 560], face: [8, 12], falloff: [120, 160], pool: [45, 65], paint: 'wetRock' }],
  engines: [{ engine: 'emitter', params: { kind: 'spray', rate: 60 } }],
  lod: { near: 1500, mid: 6000, far: 15000 },
  lure: null,
  wind: [{ type: 'downburst', params: { radius: 120, speed: 6 } }],
  audio: { recipe: 'waterfall', params: {} },
  journal: { title: 'Waterfall', description: 'A fixture cliff step for the terrain test.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: ['Waterfall {distance} {direction}.', 'Falls ahead, {eta}.', 'Cliff and falls {distance} out.'],
  lifetime: LIFETIME_SITE,
});

export const FIXTURE_ROPE_BRIDGE = Object.freeze({
  id: 'fixtureRopeBridge',
  name: 'Fixture rope bridge',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.35,
    minSpacing: 8000,
    biomes: ['meadows', 'pine', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 40, relief: 'any' },
    clearance: 300,
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 3000 }, weather: null, surface: 'land', minDistance: 0, maxDistance: 20000 },
  stamps: [{ type: 'gorge', length: [800, 1000], width: [90, 120], depth: [80, 110], falloff: [160, 200], pad: [60, 80], paint: 'riverbed' }],
  engines: [{ engine: 'structure', params: { recipe: 'ropeBridge' } }],
  lod: { near: 1200, mid: 4000, far: 10000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Rope bridge', description: 'A fixture gorge for the terrain test.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: ['Bridge {distance} {direction}.', 'Gorge ahead, {eta}.', 'Rope bridge {distance} out.'],
  lifetime: LIFETIME_SITE,
});

export const FIXTURE_AIRFIELD = Object.freeze({
  id: 'fixtureAirfield',
  name: 'Fixture airfield',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.35,
    minSpacing: 10000,
    biomes: ['meadows', 'dunes', 'pine'],
    surface: 'land',
    terrain: { minHeight: 8, maxHeight: 300, relief: 'flat' },
    clearance: 400,
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 3000 }, weather: null, surface: 'land', minDistance: 0, maxDistance: 20000 },
  stamps: [{ type: 'flatten', length: [1100, 1400], width: [40, 55], margin: [30, 50], shoulder: [110, 160], paint: 'tarmac' }],
  engines: [{ engine: 'structure', params: { recipe: 'airfield' } }],
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Airfield', description: 'A fixture runway strip for the terrain test.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: ['Airfield {distance} {direction}.', 'Runway ahead, {eta}.', 'Old strip {distance} out.'],
  lifetime: LIFETIME_SITE,
});

export const FIXTURE_FLOATING_ISLANDS = Object.freeze({
  id: 'fixtureFloatingIslands',
  name: 'Fixture floating islands',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  placement: {
    chance: 0.4,
    minSpacing: 8000,
    biomes: ['archipelago'],
    surface: 'water',
    clearance: 300,
  },
  filters: { biomes: null, timeOfDay: null, altitude: { min: 0, max: 5000 }, weather: null, surface: 'water', minDistance: 0, maxDistance: 40000 },
  stamps: [
    { type: 'islandBase', radius: [170, 230], height: [24, 40], falloff: [90, 120], paint: 'basalt' },
    { type: 'islandBase', radius: [90, 130], height: [14, 24], falloff: [60, 80], paint: 'basalt', offset: { along: 520, across: 180 } },
  ],
  engines: [{ engine: 'structure', params: { recipe: 'islands' } }],
  lod: { near: 2000, mid: 8000, far: 30000 },
  lure: { type: 'islands', height: 600, width: 900, color: 0x6a6f60 },
  wind: [],
  audio: null,
  journal: { title: 'Floating islands', description: 'Fixture islet bases for the terrain test.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: ['Islands {distance} {direction}.', 'Floating rocks ahead, {eta}.', 'Islands {distance} out.'],
  lifetime: LIFETIME_SITE,
});

/** The six fixtures, one per stamp type, in STAMP_TYPES order. */
export const TERRAIN_FIXTURES = Object.freeze([
  FIXTURE_VOLCANO,
  FIXTURE_SLOT_CANYON,
  FIXTURE_WATERFALL,
  FIXTURE_ROPE_BRIDGE,
  FIXTURE_AIRFIELD,
  FIXTURE_FLOATING_ISLANDS,
]);

/** The stamp type each fixture exercises. */
export const FIXTURE_STAMP_TYPE = Object.freeze({
  fixtureVolcano: 'cone',
  fixtureSlotCanyon: 'carve',
  fixtureWaterfall: 'cliffStep',
  fixtureRopeBridge: 'gorge',
  fixtureAirfield: 'flatten',
  fixtureFloatingIslands: 'islandBase',
});
