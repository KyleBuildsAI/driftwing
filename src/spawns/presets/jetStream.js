// Preset 29: Jet stream ribbon* (uncommon event, high altitude). A straight 24 km tube of fast air
// 2200 m above the ground, a 38 m/s tailwind along its core with shear turbulence at its edge
// (windModifier jetStream, from this preset's `wind` entry), made visible as a streak tube of cirrus
// wisps racing along it (emitter puffs stretched along their flight). The tube runs along the
// activation heading, and the wisps are born in a box laid along that same axis, so streaks and air
// agree. Both fade out together: the wisps stop forming for good after one seeded 6-7 minute stretch
// (a single long schedule cycle) and the source fades from the same moment, so nothing vanishes in
// view when the event ends.
export default Object.freeze({
  id: 'jetStream',
  name: 'Jet stream ribbon',
  category: 'flightplay',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.45 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: null,
    altitude: Object.freeze({ min: 1200, max: 9000 }),
    weather: Object.freeze(['clear', 'building', 'clearing']),
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 20000,
        style: 'puff',
        shape: Object.freeze({ type: 'box', size: Object.freeze([560, 200, 22000]) }),
        offset: Object.freeze([0, 2200, -1300]),
        direction: Object.freeze([0, 0, 1]),
        speed: Object.freeze([33, 41]),
        spread: 2,
        gravity: 0,
        drag: 0.02,
        windFollow: 0,
        turbulence: Object.freeze({ spread: 4, wobble: 14, frequency: 0.04, vertical: 0.3 }),
        life: Object.freeze([40, 70]),
        size: Object.freeze([26, 64]),
        sizeCurve: 0.7,
        sizeJitter: 0.4,
        stretch: 6,
        colors: Object.freeze([0xffffff, 0xf7faff, 0xeef4fc]),
        brightnessJitter: 0.12,
        opacity: 0.42,
        fadeIn: 0.15,
        fadeOut: 1.2,
        lit: 0.35,
        softness: 2,
        fog: 0.55,
        schedule: Object.freeze({ period: Object.freeze([86400, 86400]), active: Object.freeze([380, 440]), rampUp: 4, rampDown: 25, idle: 0, startActive: true }),
        lod: Object.freeze({ near: 1, mid: 0.6, far: 0.25 }),
      }),
    }),
    Object.freeze({ engine: 'windModifier', params: Object.freeze({ endWithDuration: false }) }),
  ]),
  lod: Object.freeze({ near: 15000, mid: 30000, far: 50000 }),
  lure: null,
  wind: Object.freeze([
    Object.freeze({
      type: 'jetStream',
      params: Object.freeze({
        direction: 'heading',
        radius: 450,
        speed: 38,
        length: 24000,
        altitude: 2200,
        bend: 0,
        climb: 0,
        turbulence: 0.4,
        gust: 4,
        fadeIn: 6,
        stop: 410,
        fadeOut: 25,
      }),
    }),
  ]),
  audio: null,
  journal: Object.freeze({
    title: 'Jet stream ribbon',
    description: 'A river of fast air high above the land, drawn out in racing cirrus streaks; ride its core for a roaring tailwind.',
  }),
  discovery: Object.freeze({ radius: 9000, requireInView: true }),
  callouts: Object.freeze([
    'See those racing streaks {direction}? That is a jet stream ribbon, {distance} out.',
    'Jet stream {direction}. Get into the core and it will throw us along at forty metres a second.',
    'The {name} is about {eta} away. Expect some shear at the edges.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([540, 600]), despawn: Object.freeze({ distance: 20000, hysteresis: 4000, outOfViewSeconds: 25 }) }),
});
