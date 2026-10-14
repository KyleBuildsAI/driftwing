// Preset 87: Badlands hoodoos (uncommon site). A field of hoodoos in banded clay country: forty-odd
// pillars of red, ochre and cream rock up to 36 m tall, each balancing a dark capstone, gathered in
// clusters with lanes between them for a low slalom (the structure recipe hoodoos), over bare badland
// ground (palette badlands, a rare saguaro). Every shaft and capstone is a collider and every top a
// perch; the wind moans and hisses through the pillars. Docs: docs/engines/structure.md (hoodoos).
export default Object.freeze({
  id: 'badlandsHoodoos',
  name: 'Badlands hoodoos',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['desert', 'perch', 'spectacle'],
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['dunes', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 30, maxHeight: 900, relief: 'any' },
    clearance: 500,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [900, 1100], falloff: 250 },
    palette: 'badlands',
    // Bare clay: the biome's own plants give way to a rare saguaro.
    vegetation: { species: ['saguaro'], density: 0.015, mode: 'replace' },
    priority: 1,
  }],
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'hoodoos', count: [44, 64], spread: 400, height: [12, 36], radius: [2.2, 4.2], clusters: [3, 5],
        capChance: 0.85, boulders: [12, 20], audioIntensity: 'wind', voice: true,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'stoneWind', params: { pitch: 1.25 } },
  journal: {
    title: 'Badlands Hoodoos',
    description: 'A forest of banded rock pillars in the badlands, each balancing a dark capstone, with lanes to weave between them.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Rock pillars {direction}, {distance} out: a field of hoodoos.',
    'The {name} are {direction}. There are lanes between the clusters if you want a slalom.',
    'The {name} are about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
