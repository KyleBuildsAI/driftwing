// Preset 23: Total solar eclipse (legendary event, day). The moon's disc crosses the sun over about
// 90 s; through totality the corona, the chromosphere and Baily's beads show, the stars come out, and
// the eclipse's sky modifier dims the sun light, darkens and tints the sky and the fog and dims the
// clouds (celestial engine, eclipse). Wildlife goes quiet through totality (the typed wildlifeQuiet:
// the v1 birds settle, the bird cues stop, fauna fall silent). The darkening world announces it, so
// it is discovered without having to face the sun.
export default Object.freeze({
  id: 'totalSolarEclipse',
  name: 'Total solar eclipse',
  category: 'celestial',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.35 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing', 'building']),
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 0,
        fadeOut: 0,
        eclipse: Object.freeze({
          crossingSeconds: 92,
          totalitySeconds: 16,
          darkness: 0.82,
          stars: 0.95,
          corona: 1.25,
          quietWildlife: true,
        }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: null,
  journal: Object.freeze({
    title: 'Total solar eclipse',
    description: 'The moon slid across the sun; day turned to dusk, the stars came out around the corona and every bird fell silent.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: false }),
  callouts: Object.freeze([
    'The light is going strange. Look at the sun, {direction}: the moon is crossing it.',
    'Total eclipse coming. Totality in about a minute. Watch the horizon glow all the way round.',
    'Here comes totality. Look for the corona, and listen: the birds have gone quiet.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([150, 170]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
