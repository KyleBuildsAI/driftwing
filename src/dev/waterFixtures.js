// Water-body and region-overlay FIXTURE presets for the terrain test (?test=terrain), the water
// bodies step file (tools/steps/water-bodies.json, through ?test=sites) and tools/lab/water.mjs only.
//
// One site per new stamp type (basin, crater, terraces) holding local water (a lake, a crater lake,
// terraced pools, a frozen lake, a salt-flat film on a flatten strip), and overlay sites covering
// every overlay kind (palette, vegetation species, the ice material, a tint sweep, stripes) and
// every Phase 3 species (cherry, redwood, bamboo, saguaro, mangrove, lavender, tulip). Shaped like
// the wave 3 presets they stand in for (crater lake 38, hot spring terraces 39, salt flat 40,
// cherry valley 82, autumn wave 83, lavender and tulip stripes 84, redwoods 86, mangrove delta 88,
// cactus forest 89, bamboo 90, frozen lake 91). They are NOT game content: they reach the world only
// through the dev-only hook (worldgen's options.presets), and their chances are far above a real
// preset's so each lies within a short flight of any spawn.
//
// Pure data, like every preset: the terrain worker receives them through its init message.

const LIFETIME_SITE = Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 }) });
const FILTERS = Object.freeze({ biomes: null, timeOfDay: null, altitude: Object.freeze({ min: 0, max: 5000 }), weather: null, surface: 'land', minDistance: 0, maxDistance: 40000 });
const QUIET_ENGINE = Object.freeze([Object.freeze({ engine: 'lightEffect', params: Object.freeze({ effect: 'glowPoints', count: 1, radius: 1, intensity: 0 }) })]);

/** Shared preset fields of a fixture site (everything but its own placement, stamps, waters and overlays). */
function fixture(id, name, category, fields) {
  return Object.freeze({
    id,
    name,
    category,
    kind: 'site',
    rarity: 'uncommon',
    heavy: false,
    filters: FILTERS,
    engines: QUIET_ENGINE,
    lod: Object.freeze({ near: 1500, mid: 5000, far: 12000 }),
    lure: null,
    wind: Object.freeze([]),
    audio: null,
    journal: Object.freeze({ title: name, description: `A ${name.toLowerCase()} for the terrain and water tests.` }),
    discovery: Object.freeze({ radius: 2000, requireInView: true }),
    callouts: Object.freeze([`${name} {distance} {direction}.`, `${name} ahead, {eta}.`, `${name} {distance} out.`]),
    lifetime: LIFETIME_SITE,
    ...fields,
  });
}

export const FIXTURE_LAKE = fixture('fixtureLake', 'Fixture lake', 'geo', {
  placement: Object.freeze({ chance: 0.6, minSpacing: 8000, biomes: Object.freeze(['meadows', 'pine', 'dunes']), surface: 'land', terrain: Object.freeze({ minHeight: 10, maxHeight: 400, relief: 'any' }), clearance: 300 }),
  stamps: Object.freeze([Object.freeze({ type: 'basin', radius: [200, 280], depth: [14, 20], rim: [30, 45], falloff: [80, 110], paint: 'sand' })]),
  waters: Object.freeze([Object.freeze({ kind: 'lake', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.82 }), material: 'water', waves: 0.3 })]),
  overlays: Object.freeze([Object.freeze({
    shape: Object.freeze({ kind: 'disc', radius: [700, 900], falloff: 220 }),
    palette: 'cherryBlossom',
    vegetation: Object.freeze({ species: Object.freeze(['cherry']), density: 0.55, mode: 'replace' }),
  })]),
});

export const FIXTURE_CRATER_LAKE = fixture('fixtureCraterLake', 'Fixture crater lake', 'geo', {
  placement: Object.freeze({ chance: 0.35, minSpacing: 9000, biomes: Object.freeze(['dunes', 'meadows', 'pine', 'snow']), surface: 'land', terrain: Object.freeze({ minHeight: 15, maxHeight: 500, relief: 'any' }), clearance: 300 }),
  stamps: Object.freeze([Object.freeze({ type: 'crater', radius: [320, 420], depth: [60, 90], rimHeight: [25, 40], rimWidth: [180, 260], floor: [0.3, 0.42], paint: 'ash' })]),
  waters: Object.freeze([Object.freeze({ kind: 'lake', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.4 }), material: 'water', tint: 0x2a7f8f, waves: 0.2 })]),
});

export const FIXTURE_TERRACES = fixture('fixtureTerraces', 'Fixture hot spring terraces', 'geo', {
  placement: Object.freeze({ chance: 0.45, minSpacing: 8000, biomes: Object.freeze(['meadows', 'pine', 'dunes', 'snow']), surface: 'land', terrain: Object.freeze({ minHeight: 20, relief: 'any' }), clearance: 300, align: 'downhill' }),
  stamps: Object.freeze([Object.freeze({ type: 'terraces', length: [320, 440], width: [150, 210], steps: [5, 7], lip: [1.4, 2.2], falloff: [60, 90], paint: 'travertine' })]),
  waters: Object.freeze([Object.freeze({ kind: 'pool', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.85 }), material: 'water', tint: 0x40c4c0, waves: 0.05, foam: 0.4 })]),
});

export const FIXTURE_FROZEN_LAKE = fixture('fixtureFrozenLake', 'Fixture frozen lake', 'geo', {
  placement: Object.freeze({ chance: 0.6, minSpacing: 8000, biomes: Object.freeze(['snow', 'pine']), surface: 'land', terrain: Object.freeze({ minHeight: 10, relief: 'any' }), clearance: 300 }),
  stamps: Object.freeze([Object.freeze({ type: 'basin', radius: [180, 250], depth: [10, 16], rim: [30, 40], falloff: [70, 100], paint: 'ice' })]),
  waters: Object.freeze([Object.freeze({ kind: 'lake', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.8 }), material: 'ice' })]),
  overlays: Object.freeze([Object.freeze({ shape: Object.freeze({ kind: 'stamp', stamp: 0, grow: 160, falloff: 120 }), palette: 'frozen', material: 'ice' })]),
});

export const FIXTURE_SALT_FLAT = fixture('fixtureSaltFlat', 'Fixture salt flat', 'geo', {
  placement: Object.freeze({ chance: 0.4, minSpacing: 9000, biomes: Object.freeze(['dunes', 'meadows']), surface: 'land', terrain: Object.freeze({ minHeight: 8, relief: 'flat' }), clearance: 300 }),
  stamps: Object.freeze([Object.freeze({ type: 'flatten', length: [700, 900], width: [260, 340], margin: [20, 30], shoulder: [120, 160], paint: 'salt' })]),
  waters: Object.freeze([Object.freeze({ kind: 'thin', stamp: 0, level: Object.freeze({ mode: 'aboveGround', height: 0.12 }), material: 'water', tint: 0xd6e2e6, waves: 0.02, foam: 0, mirror: 1 })]),
  overlays: Object.freeze([Object.freeze({ shape: Object.freeze({ kind: 'stamp', stamp: 0, grow: 60, falloff: 120 }), palette: 'saltFlat' })]),
});

export const FIXTURE_AUTUMN = fixture('fixtureAutumn', 'Fixture autumn wave', 'geo', {
  placement: Object.freeze({ chance: 0.35, minSpacing: 9000, biomes: Object.freeze(['pine', 'meadows']), surface: 'land', terrain: Object.freeze({ minHeight: 10, relief: 'any' }), clearance: 200 }),
  overlays: Object.freeze([Object.freeze({
    shape: Object.freeze({ kind: 'disc', radius: [1100, 1400], falloff: 300 }),
    palette: 'autumnForest',
    tintSweep: Object.freeze({ colors: Object.freeze([0xc0392b, 0xe67e22]), periodSeconds: 240, direction: 'downwind', width: 500 }),
  })]),
});

export const FIXTURE_FIELDS = fixture('fixtureFields', 'Fixture flower stripes', 'geo', {
  placement: Object.freeze({ chance: 0.35, minSpacing: 9000, biomes: Object.freeze(['meadows', 'pine', 'dunes']), surface: 'land', terrain: Object.freeze({ minHeight: 8, relief: 'flat' }), clearance: 200 }),
  overlays: Object.freeze([Object.freeze({
    shape: Object.freeze({ kind: 'ellipse', radius: [600, 760], aspect: 0.6, angle: 20, falloff: 140 }),
    palette: 'lavenderFields',
    stripes: Object.freeze({ width: 16, angle: 'ridge', colors: Object.freeze([0x9b7fd0, 0xd8443a, 0x8f74c4, 0xf2c94c]), species: Object.freeze(['lavender', 'tulip']) }),
    priority: 1,
  })]),
});

export const FIXTURE_REDWOODS = fixture('fixtureRedwoods', 'Fixture redwood giants', 'geo', {
  placement: Object.freeze({ chance: 0.35, minSpacing: 9000, biomes: Object.freeze(['pine', 'meadows']), surface: 'land', terrain: Object.freeze({ minHeight: 15, relief: 'any' }), clearance: 200 }),
  overlays: Object.freeze([Object.freeze({
    shape: Object.freeze({ kind: 'disc', radius: [650, 850], falloff: 180 }),
    palette: 'redwoodForest',
    vegetation: Object.freeze({ species: Object.freeze(['redwood']), density: 0.45, mode: 'replace' }),
  })]),
});

export const FIXTURE_GROVES = fixture('fixtureGroves', 'Fixture groves', 'geo', {
  placement: Object.freeze({ chance: 0.35, minSpacing: 9000, biomes: Object.freeze(['dunes', 'meadows', 'pine']), surface: 'land', terrain: Object.freeze({ minHeight: 10, relief: 'any' }), clearance: 200 }),
  overlays: Object.freeze([
    Object.freeze({
      shape: Object.freeze({ kind: 'disc', radius: [600, 760], falloff: 160 }),
      palette: 'saguaroDesert',
      vegetation: Object.freeze({ species: Object.freeze(['saguaro']), density: 0.35, mode: 'add' }),
    }),
    Object.freeze({
      shape: Object.freeze({ kind: 'disc', radius: [340, 420], falloff: 100, offset: Object.freeze({ along: 900, across: 0 }) }),
      palette: 'bambooGrove',
      vegetation: Object.freeze({ species: Object.freeze(['bamboo']), density: 0.8, mode: 'replace' }),
      priority: 1,
    }),
  ]),
});

export const FIXTURE_MANGROVE = fixture('fixtureMangrove', 'Fixture mangrove delta', 'geo', {
  placement: Object.freeze({ chance: 0.5, minSpacing: 8000, biomes: Object.freeze(['archipelago', 'meadows', 'pine']), surface: 'coast', clearance: 200 }),
  overlays: Object.freeze([Object.freeze({
    shape: Object.freeze({ kind: 'disc', radius: [600, 800], falloff: 160 }),
    palette: 'mangrove',
    vegetation: Object.freeze({ species: Object.freeze(['mangrove']), density: 0.6, mode: 'replace' }),
  })]),
});

/** Every water and overlay fixture. */
export const WATER_FIXTURES = Object.freeze([
  FIXTURE_LAKE,
  FIXTURE_CRATER_LAKE,
  FIXTURE_TERRACES,
  FIXTURE_FROZEN_LAKE,
  FIXTURE_SALT_FLAT,
  FIXTURE_AUTUMN,
  FIXTURE_FIELDS,
  FIXTURE_REDWOODS,
  FIXTURE_GROVES,
  FIXTURE_MANGROVE,
]);

/** The stamp type each stamped water fixture exercises. */
export const WATER_FIXTURE_STAMP_TYPE = Object.freeze({
  fixtureLake: 'basin',
  fixtureCraterLake: 'crater',
  fixtureTerraces: 'terraces',
  fixtureFrozenLake: 'basin',
  fixtureSaltFlat: 'flatten',
});

/** The overlay kinds each overlay fixture exercises (palette, vegetation, material, tintSweep, stripes). */
export const OVERLAY_FIXTURE_KINDS = Object.freeze({
  fixtureLake: Object.freeze(['palette', 'vegetation']),
  fixtureFrozenLake: Object.freeze(['palette', 'material']),
  fixtureSaltFlat: Object.freeze(['palette']),
  fixtureAutumn: Object.freeze(['palette', 'tintSweep']),
  fixtureFields: Object.freeze(['palette', 'stripes']),
  fixtureRedwoods: Object.freeze(['palette', 'vegetation']),
  fixtureGroves: Object.freeze(['palette', 'vegetation']),
  fixtureMangrove: Object.freeze(['palette', 'vegetation']),
});
