// Preset 50: Flamingo lake (uncommon site). A broad, shallow soda lake on the flats (a basin stamp
// 3-5 m deep, its shore crusted with salt) whose water is tinted pink, with sixty to a hundred and
// twenty flamingos wading in its shallows, each on its own spot. Buzz them (within about 160 m) and
// they take off in a wave that runs out from the bird nearest you, splash along the water, circle
// the lake as a pink flock and glide back down to settle. Honking calls (the goose recipe). No wind
// effect. Docs: docs/engines/fauna.md (behaviour surface, wade).
export default Object.freeze({
  id: 'flamingoLake',
  name: 'Flamingo lake',
  category: 'wildlife',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['lake', 'calm', 'slow', 'spectacle']),
  placement: Object.freeze({
    chance: 0.08,
    minSpacing: 16000,
    biomes: Object.freeze(['meadows', 'dunes', 'archipelago']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 5, maxHeight: 600, relief: 'flat' }),
    clearance: 600,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([
    Object.freeze({ type: 'basin', radius: Object.freeze([260, 360]), depth: Object.freeze([3, 5]), rim: Object.freeze([20, 35]), falloff: Object.freeze([90, 140]), paint: 'salt' }),
  ]),
  waters: Object.freeze([
    Object.freeze({ kind: 'lake', stamp: 0, level: Object.freeze({ mode: 'basin', fill: 0.75 }), tint: 0xf2a6b8, waves: 0.12, glint: 1, foam: 0.6 }),
  ]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'flamingo',
        behavior: 'surface',
        count: Object.freeze([60, 120]),
        fadeIn: 2,
        surface: Object.freeze({
          wade: Object.freeze({
            depthMax: 0.6, flushRadius: 160, takeoffWave: Object.freeze({ delay: 0.35, spread: 0.6 }), flySeconds: Object.freeze([25, 45]),
            flyAltitude: 45, flyRadius: 240, spacing: 2.2, searchRadius: 1200,
          }),
        }),
        calls: Object.freeze({ trigger: 'call', interval: Object.freeze([4, 10]) }),
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 4500, far: 9000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'goose', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Flamingo lake',
    description: 'A shallow pink soda lake crowded with wading flamingos that lift off in a wave when you fly over them.',
  }),
  discovery: Object.freeze({ radius: 2000, requireInView: true }),
  callouts: Object.freeze([
    'Pink water {direction}, {distance} out. A flamingo lake.',
    'Flamingos wading {distance} {direction}. Fly over them low and they will lift off in a wave.',
    'The {name} is about {eta} away, {direction}. Calm water there too.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 9000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
