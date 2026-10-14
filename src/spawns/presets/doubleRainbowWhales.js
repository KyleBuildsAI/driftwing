// Preset 94: Double rainbow over a whale pod (legendary combo, low sun, a passing shower at sea). A
// shower cloud trails a grey rain curtain over the sea (weatherVolume cumulus with a rain shaft, its
// hiss on the voice) and the low sun behind you throws a double rainbow across it, the bright primary
// and a full secondary bow outside it, its colours reversed (celestial rainbow in a 2.4 km sphere of
// mist around the pod, so the bows stand wherever you look away from the sun), while a whale pod
// surfaces, spouts and breaches beneath it (combo scheduling, contract i.3: the Phase 2 whale pod is
// the anchor member; the preconditions want the golden light and showery weather). The shower has no
// wind of its own. Docs: docs/engines/celestial.md, weatherVolume.md, fauna.md.
export default Object.freeze({
  id: 'doubleRainbowWhales',
  name: 'Double rainbow over whales',
  category: 'ocean',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['water', 'coast', 'calm', 'slow', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['golden']),
    altitude: Object.freeze({ min: 0, max: 2500 }),
    weather: Object.freeze(['clearing', 'building']),
    surface: 'coast',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'world',
        fadeIn: 12,
        fadeOut: 18,
        rainbow: Object.freeze({ radius: 2400, height: 250, offset: Object.freeze([0, 300]), strength: 1.7, secondary: 1, light: 'sun' }),
        ownsAudio: false,
      }),
    }),
    Object.freeze({
      engine: 'weatherVolume',
      params: Object.freeze({
        form: 'cumulus',
        base: 1100,
        radius: 1300,
        height: 1500,
        puffs: 46,
        storm: 0.35,
        brightness: 0.95,
        rain: Object.freeze([Object.freeze({ offset: Object.freeze([0, 1500]), radius: 900, density: 0.42 })]),
        wind: Object.freeze({ turbulence: 0, updraft: 0, downdraft: 0, outflow: 0 }),
        formSeconds: 0,
        dissipateSeconds: 25,
        ownsAudio: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 30000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({ refDistance: 500, size: 600 }) }),
  journal: Object.freeze({
    title: 'Double rainbow over whales',
    description: 'A passing shower at sea, a double rainbow thrown across it by the low sun, and a whale pod spouting and breaching underneath.',
  }),
  discovery: Object.freeze({ radius: 5000, requireInView: true }),
  callouts: Object.freeze([
    'Turn your back to the sun and look {direction}. Double rainbow, and there are whales under it.',
    'Whales spouting {distance} {direction}, right under a double rainbow. You could not paint it better.',
    'The {name} is about {eta} away. Keep the sun behind you and the bows stay in front.',
    'See the second bow outside the first? Its colours run backwards. Whales below, {direction}.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([300, 420]), despawn: Object.freeze({ distance: 14000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({ timeOfDay: Object.freeze(['golden']), weather: Object.freeze(['clearing', 'building']) }),
    members: Object.freeze([Object.freeze({ presetId: 'whalePod', role: 'anchor' })]),
    exclusive: true,
  }),
});
