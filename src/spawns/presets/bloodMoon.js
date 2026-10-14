// Preset 61: Blood moon (rare global override; never a director candidate). A total eclipse of the
// moon lasting the night. The director's global override (contract i.4, src/spawns/overrides.js)
// schedules it on about one night in twenty-five of the seed, everywhere at once (region null): from
// the evening it reddens the moon disc, its halo and the moon light and darkens the night (the sky
// modifier of createSkyOverrideSink). This preset's own celestial part starts from the override's half
// weight (its discovery and journal entry) and ends with it: the copper glow around the disc, the
// bright limb on the side leaving the earth's shadow, the stars brightening in the darker sky, and a
// low shimmer. F9's Spawn schedules it on the current night (set the time to night to see it).
// Docs: docs/engines/celestial.md (lunarEclipse, sky), docs/spawns.md (Global overrides).
export default Object.freeze({
  id: 'bloodMoon',
  name: 'Blood moon',
  category: 'celestial',
  kind: 'event',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'spectacle', 'calm']),
  // Required of every event; an override preset is scheduled per night instead and never rolled.
  candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 1800, chance: 0.3 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['dusk', 'night']),
    altitude: null,
    weather: null,
    surface: 'any',
    minDistance: 2000,
    maxDistance: 6000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 30,
        fadeOut: 30,
        lunarEclipse: Object.freeze({ glow: 1.1, rim: 0.9, haloRadius: 6 }),
        sky: Object.freeze({ stars: 0.85, when: 'night' }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'skyShimmer', params: Object.freeze({ baseHz: 98, brightness: 0.15 }) }),
  journal: Object.freeze({
    title: 'Blood moon',
    description: "A total eclipse of the moon: the earth's shadow turned it copper-red and the whole night darkened around it.",
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Look at the moon, {direction}. It has gone copper-red: a total lunar eclipse.',
    "That is a blood moon {direction}. The earth's shadow is right across it tonight.",
    'The night just got darker. Find the moon {direction} and you will see why.',
  ]),
  // The override ends the spawn with the night; the duration only caps a frozen night clock.
  lifetime: Object.freeze({ duration: Object.freeze([1500, 2100]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 60 }) }),
  override: Object.freeze({ kind: 'bloodMoon', nightChance: 0.04, region: null }),
});
