// Preset 97: Migration convergence (legendary combo, day, in a valley). Three migrations meet in one
// valley: the combo seeks the lowest dry ground within 2.5 km (anchor seek 'valley') and the director
// places its members around it (contract i.3): the butterfly migration cloud on the valley floor (the
// anchor), a V of geese 500 m on, and the caribou column 700 m off to the side ten seconds later. Its own
// part is the haze the gathering raises: warm dust and seed fluff hanging over the valley floor in the
// low light, drifting on the real wind (emitter), with the rush of many wings (murmuration voice). The
// butterflies (51) and the caribou (52) are another batch's presets: they are optional members, so the
// combo starts with what this build has. Docs: docs/engines/emitter.md, fauna.md.
export default Object.freeze({
  id: 'migrationConvergence',
  name: 'Migration convergence',
  category: 'wildlife',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['murmuration', 'calm', 'slow', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.4 }),
  filters: Object.freeze({
    biomes: Object.freeze(['meadows', 'pine']),
    timeOfDay: Object.freeze(['day', 'golden']),
    altitude: Object.freeze({ min: 0, max: 3000 }),
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 3000,
        shape: Object.freeze({ type: 'disc', radius: 650, height: 30 }),
        hugGround: true,
        offset: Object.freeze([0, 4, 0]),
        speed: Object.freeze([0.2, 0.8]),
        spread: 70,
        gravity: 0,
        buoyancy: 0.08,
        drag: 0.6,
        windFollow: 0.8,
        turbulence: Object.freeze({ spread: 1.5, wobble: 3, frequency: 0.15 }),
        life: Object.freeze([24, 40]),
        size: Object.freeze([3, 7]),
        sizeJitter: 0.4,
        colors: Object.freeze([0xe9d6a8, 0xf3e3bd, 0xd9c08f]),
        opacity: 0.22,
        fadeIn: 0.2,
        fog: 0.8,
        sound: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2000, mid: 5000, far: 10000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'murmuration', params: Object.freeze({ refDistance: 150 }) }),
  journal: Object.freeze({
    title: 'Migration convergence',
    description: 'Butterflies, geese and a caribou column all meeting in one valley, the air hazy with the dust and fluff they stirred up.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Look at that valley {direction}. Butterflies, geese and a herd, all converging at once.',
    'Everything is migrating through the same valley today, {distance} {direction}.',
    'The {name} is about {eta} away. Go low and slow; the geese will let you join.',
    'Three migrations in one valley {direction}. I have only read about this.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([360, 480]), despawn: Object.freeze({ distance: 12000, hysteresis: 3000, outOfViewSeconds: 25 }) }),
  anchor: Object.freeze({ seek: 'valley', radius: 2500 }),
  combo: Object.freeze({
    preconditions: Object.freeze({
      biomes: Object.freeze(['meadows', 'pine']),
      timeOfDay: Object.freeze(['day', 'golden']),
      weather: Object.freeze(['clear', 'clearing']),
    }),
    members: Object.freeze([
      Object.freeze({ presetId: 'butterflyMigration', role: 'anchor', optional: true }),
      Object.freeze({ presetId: 'geeseFormation', place: Object.freeze({ bearing: 0, distance: 500, jitter: 150 }) }),
      Object.freeze({ presetId: 'caribouMigration', place: Object.freeze({ bearing: 70, distance: 700, jitter: 200 }), delay: 10, optional: true }),
    ]),
    exclusive: true,
  }),
});
