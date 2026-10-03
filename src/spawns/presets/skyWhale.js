// Preset 27: Sky whale* (rare heavy event). A colossal whale, sometimes with a calf, drifts through the
// top of the cloud layer with slow tail beats, a gentle bob and its song (fauna engine, drift; its
// luminous spots glow at night). Its slipstream is a free speed and lift lane trailing behind it
// (windModifier slipstream from this preset's `wind` entry, following the fauna part and facing its
// travel). Beyond the terrain's view distance the whale lure swims on the horizon. The group fades
// out over its last seconds (fauna fadeOut) as the lane fades with it.
export default Object.freeze({
  id: 'skyWhale',
  name: 'Sky whale',
  category: 'fantasy',
  kind: 'event',
  rarity: 'rare',
  heavy: true,
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 1200, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: null,
    altitude: Object.freeze({ min: 120, max: 6000 }),
    weather: Object.freeze(['clear', 'building', 'clearing']),
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'skyWhale',
        behavior: 'drift',
        count: Object.freeze([1, 2]),
        size: 230,
        sizeJitter: 0.05,
        speed: 11,
        altitude: Object.freeze({ mode: 'msl', value: 680, spread: 0 }),
        floor: 160,
        wander: 0.03,
        fadeIn: 10,
        fadeOut: 12,
        drift: Object.freeze({ bob: 26, bobPeriod: 52, lane: 0.7 }),
        calls: Object.freeze({ interval: Object.freeze([22, 45]) }),
        voice: true,
      }),
    }),
    Object.freeze({ engine: 'windModifier', params: Object.freeze({ follow: 'fauna', endWithDuration: false }) }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 7000, far: 40000 }),
  lure: Object.freeze({ type: 'whale', height: 120, width: 360, color: 0x5d6f86 }),
  wind: Object.freeze([
    Object.freeze({
      type: 'slipstream',
      params: Object.freeze({
        behind: 90,
        length: 1900,
        width: 190,
        height: 95,
        spread: 0.05,
        centerHeight: 0,
        boost: 10,
        lift: 3.2,
        turbulence: 0.3,
        gust: 2,
        fadeIn: 10,
        fadeOut: 12,
      }),
    }),
  ]),
  audio: Object.freeze({ recipe: 'skyWhale', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Sky whale',
    description: 'A whale the size of a ship swimming through the cloud tops, singing; behind it the air ran fast and rising, a free lane to ride.',
  }),
  discovery: Object.freeze({ radius: 4500, requireInView: true }),
  callouts: Object.freeze([
    'Something enormous in the clouds {direction}, {distance} out. It is a sky whale.',
    'Sky whale {direction}. Tuck in behind it: its slipstream will carry us and lift us.',
    'Hear that song? The {name} is {direction}, about {eta} away.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([480, 720]), despawn: Object.freeze({ distance: 14000, hysteresis: 3000, outOfViewSeconds: 25 }) }),
});
