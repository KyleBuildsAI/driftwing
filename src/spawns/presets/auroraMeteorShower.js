// Preset 92: Aurora and meteor shower (legendary combo, night, snow). On a clear night over the snow
// the aurora flares to its full strength, green curtains fringed with magenta rippling across the
// whole sky (celestial sky component: the sky modifier's aurora raises the curtains wherever the sky
// is dark, the stars at full), and the director starts the Phase 2 meteor shower with it, so the
// streaks rain through the curtains (combo scheduling, contract i.3: the shower is the combo's anchor
// member, its preconditions night, snow and clear weather). The aurora hums its airy shimmer
// (aurora). It lasts until dawn, or 300-420 s. Docs: docs/engines/celestial.md.
export default Object.freeze({
  id: 'auroraMeteorShower',
  name: 'Aurora and meteor shower',
  category: 'celestial',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'snow', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.4 }),
  filters: Object.freeze({
    biomes: Object.freeze(['snow']),
    timeOfDay: Object.freeze(['night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
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
        fadeIn: 20,
        fadeOut: 25,
        untilDawn: true,
        dawnElevation: -8,
        sky: Object.freeze({ aurora: 1, stars: 1, when: 'night' }),
        ownsAudio: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'aurora', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Aurora and meteor shower',
    description: 'Green curtains rippling over the snow while a meteor shower rained straight through them, on the same clear night.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: false }),
  callouts: Object.freeze([
    'Look up. The aurora is out in full, and there are meteors falling through it.',
    'Curtains of green over the snow, and shooting stars {direction}. Nights like this come once in a long while.',
    'Aurora and a meteor shower together. Cut the panel lights and just look.',
    'That {name} is right overhead. Watch for a fireball through the curtains.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([300, 420]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({ biomes: Object.freeze(['snow']), timeOfDay: Object.freeze(['night']), weather: Object.freeze(['clear', 'clearing']) }),
    members: Object.freeze([Object.freeze({ presetId: 'meteorShower', role: 'anchor' })]),
    exclusive: true,
  }),
});
