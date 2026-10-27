// Preset 44: Dolphin pod (common event). Six to twelve dolphins ride the swell off a coast, porpoising
// clear of the water in turns with a splash each time. Fly low over the sea (under 260 m) and they
// turn for your shadow on the water and race it, leaping alongside at nearly twice their cruising
// speed, until you climb away. Whistles and click trains are the dolphin recipe. No wind effect.
// Docs: docs/engines/fauna.md (behaviour surface, raceShadow).
export default Object.freeze({
  id: 'dolphinPod',
  name: 'Dolphin pod',
  category: 'ocean',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  tags: Object.freeze(['water', 'coast', 'spectacle']),
  candidates: Object.freeze({ cellSize: 5000, bucketSeconds: 300, chance: 0.45 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day', 'golden', 'dawn', 'dusk']),
    altitude: Object.freeze({ min: 0, max: 2000 }),
    weather: Object.freeze(['clear', 'building', 'clearing']),
    surface: 'coast',
    minDistance: 2500,
    maxDistance: 7000,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'fauna',
      params: Object.freeze({
        species: 'dolphin',
        behavior: 'surface',
        count: Object.freeze([6, 12]),
        fadeIn: 3,
        fadeOut: 8,
        surface: Object.freeze({
          spread: 14,
          porpoise: Object.freeze({ height: 2.2, interval: Object.freeze([2.5, 6]) }),
          raceShadow: Object.freeze({ radius: 900, boost: 1.9, maxAltitude: 260 }),
        }),
        calls: Object.freeze({ trigger: 'call', interval: Object.freeze([3, 8]) }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 4000, far: 8000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'dolphin', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Dolphin pod',
    description: 'A pod of dolphins leaping through the swell, racing the shadow of anything that flies low over them.',
  }),
  discovery: Object.freeze({ radius: 1500, requireInView: true }),
  callouts: Object.freeze([
    'Dolphins {direction}, {distance} out. Get down low over the water and they will race your shadow.',
    'Splashes on the water {distance} {direction}: a dolphin pod.',
    'Dolphin pod about {eta} away, {direction}. Keep it under 250 metres when you get there.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([240, 400]), despawn: Object.freeze({ distance: 8000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
