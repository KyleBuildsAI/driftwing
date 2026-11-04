// Preset 49: Herd stampede (common event). A herd of forty to eighty bison grazes its way across open
// plains, following the ground and keeping off steep slopes and water. Buzz it low (within about
// 320 m and under 350 m above it) and the whole herd bolts away from you at a gallop, bending
// downhill, under a rolling plume of dust that hangs over the plain behind it; after half a minute it
// settles back to a walk, ready to run again. Drumming hooves and the bellow of a bull are the herd
// recipe, loudest in the stampede. No wind effect. Docs: docs/engines/fauna.md (behaviour herd).
export default Object.freeze({
  id: 'herdStampede',
  name: 'Herd stampede',
  category: 'wildlife',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  tags: Object.freeze(['spectacle', 'slow']),
  candidates: Object.freeze({ cellSize: 5000, bucketSeconds: 360, chance: 0.4 }),
  filters: Object.freeze({
    biomes: Object.freeze(['meadows', 'dunes']),
    timeOfDay: Object.freeze(['day', 'golden', 'dawn', 'dusk']),
    altitude: Object.freeze({ min: 0, max: 2500 }),
    weather: Object.freeze(['clear', 'building', 'clearing']),
    surface: 'land',
    minDistance: 2500,
    maxDistance: 7000,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'bison',
        behavior: 'herd',
        count: Object.freeze([40, 80]),
        fadeOut: 10,
        herd: Object.freeze({
          spacing: 6.5,
          graze: 0.5,
          stampede: Object.freeze({ trigger: 'player', radius: 320, duration: 28, cooldown: 40, downhill: 0.6, maxAltitude: 350 }),
          dust: Object.freeze({ rate: 9, size: 7, color: 0xb39876 }),
        }),
        calls: Object.freeze({ trigger: 'bellow', interval: Object.freeze([10, 24]) }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2000, mid: 4500, far: 9000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'herd', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Herd stampede',
    description: 'A bison herd on the open plains that bolts at a gallop under a rolling plume of dust when you fly low over it.',
  }),
  discovery: Object.freeze({ radius: 1800, requireInView: true }),
  callouts: Object.freeze([
    'Bison herd {direction}, {distance} out. Buzz them low and watch them run.',
    'Dark shapes on the plain {distance} {direction}: a herd of bison.',
    'Bison herd about {eta} away, {direction}. Come in low to start a stampede.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([300, 480]), despawn: Object.freeze({ distance: 9000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
