// Preset 48: Bats at dusk (uncommon event). As the light goes, a stream of two thousand bats pours out
// of a cave mouth high on a mountain face: a dark ribbon that dips as they drop out of the opening,
// then climbs away over the valley in a slow, meandering curve and spreads into the night at its end.
// Fly through it and the bats burst aside, then fold back into the ribbon. The cave mouth is a hood
// of broken rock around a black opening on the steepest high face near a peak (structure caveMouth,
// solid), the same face the stream pours from (fauna stream, cliffFace.js); with no such face in
// reach the activation is declined. The wing rush swells as you close in (the murmuration recipe).
// No wind effect. Docs: docs/engines/fauna.md (behaviour stream, species bat), structure.md (recipe
// caveMouth).
export default Object.freeze({
  id: 'batsAtDusk',
  name: 'Bats at dusk',
  category: 'wildlife',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['murmuration', 'night', 'spectacle']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.45 }),
  filters: Object.freeze({
    biomes: Object.freeze(['pine', 'snow', 'dunes', 'meadows']),
    timeOfDay: Object.freeze(['dusk']),
    altitude: Object.freeze({ min: 0, max: 3500 }),
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'land',
    minDistance: 2500,
    maxDistance: 7000,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'caveMouth', search: 1500, requireFace: true, voice: false }),
    }),
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'bat',
        behavior: 'stream',
        count: Object.freeze([1800, 2600]),
        fadeIn: 2,
        fadeOut: 15,
        stream: Object.freeze({ source: 'cliff', faceSearch: 1500, length: 1700, climb: 260, width: Object.freeze([6, 34]), meander: 90, turn: 35 }),
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2200, mid: 5000, far: 10000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'murmuration', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Bats at dusk',
    description: 'A river of bats pouring out of a cave high on a mountain face as the light fails, streaming away over the valley.',
  }),
  discovery: Object.freeze({ radius: 2200, requireInView: true }),
  callouts: Object.freeze([
    'Something streaming off the mountain {direction}, {distance} out. Bats, leaving their cave for the night.',
    'Bat stream {distance} {direction}. Look for the dark ribbon against the sky.',
    'The {name} is about {eta} away, {direction}. The cave mouth is high on the face.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([300, 480]), despawn: Object.freeze({ distance: 10000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
  anchor: Object.freeze({ seek: 'peak', radius: 6000 }),
});
