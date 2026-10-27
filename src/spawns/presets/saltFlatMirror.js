// Preset 40: Salt flat mirror lake (uncommon site). A dead-flat white salt pan (a wide, shallow basin
// stamp painted salt, inside a salt-white region overlay) under a thin film of still water that
// mirrors the whole sky: clouds, the sunset and the stars lie at your feet, and a craft flying low
// flies with its own reflection. Rows of harvested salt cones stand at the water's edge. A faint
// breeze. The mirror is the water material's budgeted sky reflection (no extra render pass). Docs:
// docs/engines/structure.md (the 'saltPiles' recipe); the film: src/world/waters.js (mirror),
// src/render/waterMaterial.js.
export default Object.freeze({
  id: 'saltFlatMirror',
  name: 'Salt flat mirror lake',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['water', 'lake', 'calm', 'desert', 'spectacle'],
  placement: {
    chance: 0.6,
    minSpacing: 20000,
    biomes: ['dunes', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 8, maxHeight: 600, relief: 'flat' },
    clearance: 150,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  // A wide pan with a low berm (big enough to mirror the sky, small enough to find flat ground for).
  stamps: [{ type: 'basin', radius: [500, 600], depth: [2.5, 3.5], rim: [40, 60], falloff: [100, 140], paint: 'salt' }],
  waters: [{ kind: 'thin', stamp: 0, level: { mode: 'basin', fill: 0.7 }, material: 'water', tint: 0xd6e2e6, waves: 0.02, glint: 1.4, foam: 0, mirror: 1 }],
  overlays: [{ shape: { kind: 'stamp', stamp: 0, grow: 160, falloff: 220 }, palette: 'saltFlat' }],
  engines: [
    {
      engine: 'structure',
      params: { recipe: 'saltPiles', rows: [3, 5], perRow: [24, 40], edge: 0.62, audioLevel: 0.4, voice: true },
    },
  ],
  lod: { near: 1500, mid: 5000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'gale', params: { grit: 0.05, howl: 0.15, depth: 0.1, refDistance: 500 } },
  journal: { title: 'Salt flat mirror lake', description: 'A film of water over a white salt pan, mirroring the whole sky.' },
  discovery: { radius: 3500, requireInView: true },
  callouts: [
    'Salt flat {direction}, {distance} off. The water on it is a perfect mirror.',
    'Mirror lake {direction}, {distance} out. Fly low and watch your reflection.',
    'The {name} is about {eta} away, {direction}. It is best at sunset or under the stars.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
