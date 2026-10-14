// Preset 91: Frozen lake (uncommon site). A mountain tarn in the snow country frozen hard: a basin stamp
// (small and deep, so it fits the steep snow and pine country) holds an ice body (the water query's
// solid ice, so craft land and skid on it), shaded by the ice material with its white rime and its web
// of cracks, the shore around it rimed in the 'frozen' overlay. Long
// pressure ridges of tilted ice slabs buckle up across the ice (structure recipe iceRidges), each a
// solid collider. Up close the ice sings: falling chirps, twangs and booms as it strains (iceSing,
// louder as you approach). Docs: docs/engines/structure.md.
export default Object.freeze({
  id: 'frozenLake',
  name: 'Frozen lake',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['lake', 'snow', 'calm', 'spectacle']),
  placement: Object.freeze({
    chance: 0.6,
    minSpacing: 14000,
    biomes: Object.freeze(['snow', 'pine']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 30, maxHeight: 2400, relief: 'any' }),
    clearance: 500,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([
    Object.freeze({ type: 'basin', radius: Object.freeze([110, 170]), depth: Object.freeze([16, 22]), rim: Object.freeze([30, 45]), falloff: Object.freeze([80, 120]), paint: 'ice' }),
  ]),
  waters: Object.freeze([
    Object.freeze({ kind: 'lake', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.8 }), material: 'ice', tint: 0x9cc9dc }),
  ]),
  overlays: Object.freeze([
    Object.freeze({ shape: Object.freeze({ kind: 'stamp', stamp: 0, grow: 180, falloff: 120 }), palette: 'frozen', material: 'ice' }),
  ]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'iceRidges',
        water: 0,
        ridges: Object.freeze([3, 5]),
        length: Object.freeze([120, 280]),
        height: Object.freeze([1.4, 3.4]),
        slab: Object.freeze([2.6, 5.8]),
        wander: 16,
        colors: Object.freeze([0xe8f3f8, 0xc6dcea, 0xa3c6db, 0x86b2cc]),
        approach: 1600,
        audioIntensity: 'approach',
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1500, mid: 5000, far: 12000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'iceSing', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Frozen lake',
    description: 'A lake frozen hard among the snows, its ice webbed with cracks and buckled into pressure ridges that chirp and boom with the cold.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Frozen lake {direction}, {distance} out. The ice is thick enough to land on.',
    'See the ridges on that lake {direction}? The ice has buckled right up into walls.',
    'There is a {name} about {eta} away, {direction}. Get low over it and listen to the ice sing.',
    'Ice {direction}, {distance}. Mind the pressure ridges if you put down on it.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
