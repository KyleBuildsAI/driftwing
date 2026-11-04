// Preset 38: Meteor crater lake (uncommon site). A near-perfect bowl punched into the plain by an
// ancient impact (the crater stamp: a raised rim, steep inner walls, a flat floor), with a still, deep
// teal lake on its floor and blocks of shattered rock strewn over the rim and down its outer flank, the
// biggest of them perches. The wind sighs over the rim. Docs: docs/engines/structure.md (the
// 'ejecta' recipe); the crater stamp and its lake: src/world/stamps.js, waters.js.
export default Object.freeze({
  id: 'meteorCraterLake',
  name: 'Meteor crater lake',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['lake', 'water', 'perch', 'calm'],
  placement: {
    chance: 0.1,
    minSpacing: 22000,
    biomes: ['dunes', 'meadows', 'pine', 'snow'],
    surface: 'land',
    terrain: { minHeight: 15, maxHeight: 700, relief: 'any' },
    clearance: 400,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [{ type: 'crater', radius: [380, 480], depth: [70, 100], rimHeight: [30, 45], rimWidth: [200, 280], floor: [0.32, 0.45], paint: 'ash' }],
  waters: [{ kind: 'lake', stamp: 0, level: { mode: 'basin', fill: 0.38 }, material: 'water', tint: 0x2a7f8f, waves: 0.15 }],
  engines: [
    {
      engine: 'structure',
      params: { recipe: 'ejecta', count: [100, 140], size: [1.5, 7], inner: 0.12, perches: 4, audioLevel: 0.5, voice: true },
    },
  ],
  lod: { near: 1800, mid: 5000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'gale', params: { grit: 0.1, howl: 0.3, depth: 0.15, refDistance: 500 } },
  journal: { title: 'Meteor crater lake', description: 'A lake in the bowl an ancient meteorite punched into the plain, its rim strewn with shattered rock.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'Crater {direction}, {distance} off, with a lake in the bottom. A meteorite made that.',
    'Look {direction}. That round bowl {distance} out is an impact crater.',
    'The {name} is about {eta} away, {direction}. The big blocks on the rim make good perches.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
