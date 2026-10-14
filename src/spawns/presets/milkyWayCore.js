// Preset 64: Milky Way core (uncommon event, the rest of the night). On a clear, dark night the
// galaxy's bright core rises on the star field's own milky way band: a warm bulge, star clouds and
// grain along the band, split by the dark dust lanes of the Great Rift. It is strongest over the
// desert (the engine samples the dune share around the camera every 2 s) and fades under bright
// moonlight and cloud; the stars come out fully with it. It lasts until dawn. A deep, slow shimmer
// goes with it. Sky-anchored at the core. Docs: docs/engines/celestial.md (galaxy, sky).
export default Object.freeze({
  id: 'milkyWayCore',
  name: 'Milky Way core',
  category: 'celestial',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'desert', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 900, chance: 0.5 }),
  filters: Object.freeze({
    biomes: Object.freeze(['dunes', 'meadows', 'snow', 'pine']),
    timeOfDay: Object.freeze(['night']),
    altitude: null,
    weather: Object.freeze(['clear']),
    surface: 'any',
    minDistance: 2000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 20,
        fadeOut: 25,
        untilDawn: true,
        dawnElevation: -8,
        galaxy: Object.freeze({ strength: 1.2, dust: 0.8, core: 1.1, desert: 0.45, moonFade: 0.35 }),
        sky: Object.freeze({ stars: 1, darkness: 0.08, when: 'night' }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'skyShimmer', params: Object.freeze({ baseHz: 196, brightness: 0.35 }) }),
  journal: Object.freeze({
    title: 'Milky Way core',
    description: 'The bright heart of the galaxy over a dark land, split by rivers of dust, brightest over the desert.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Dark skies tonight. The core of the Milky Way is up {direction}: look for the dust lanes.',
    'The galaxy is putting on a show {direction}. Out over the desert it is brighter still.',
    'See the glow {direction}, split down the middle? That is the heart of our galaxy.',
  ]),
  // untilDawn ends it as the morning sun climbs past -8 degrees; the duration caps a frozen night.
  lifetime: Object.freeze({ duration: Object.freeze([600, 900]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
