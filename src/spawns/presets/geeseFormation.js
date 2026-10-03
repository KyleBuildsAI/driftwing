// Geese V-formation (Phase 2 preset 15): a common event, anywhere and at any hour.
//
// A V of nine to thirteen geese crosses the sky at about your own height (fauna formation, altitude
// mode 'player'). Come up behind it and slide into the open slot past the end of the shorter leg:
// the flock then follows your gentle turns and matches your speed within its own (11-32 m/s, a
// glider's pace). Hold the slot for 10 s and it sends the typed achievement
// { id: 'vFormation', title: 'V-Formation' }; brief wobbles keep the timer. The flock honks in
// bouts (goose recipe) and fades out with its duration.
//
// This is the director's pacing floor: dense candidates (3.5 km cells, 0.6 chance, 5-minute buckets)
// that no biome, surface, hour or weather rules out, so a drought almost always finds one ahead.
// No wind effect. Pure data (contract section 1).
export default Object.freeze({
  id: 'geeseFormation',
  name: 'Geese V-formation',
  category: 'wildlife',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 3500, bucketSeconds: 300, chance: 0.6 },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 3500 },
    weather: null,
    surface: 'any',
    minDistance: 3000,
    maxDistance: 7500,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'goose',
        behavior: 'formation',
        count: [9, 13],
        size: 1.6,
        speed: 18,
        floor: 60,
        altitude: { mode: 'player', value: -15, spread: 25, ceiling: 1800 },
        fadeIn: 2.5,
        fadeOut: 10,
        voiceIntensity: 0.75,
        formation: {
          shape: 'v',
          spacing: 3.6,
          angle: 32,
          followRadius: 450,
          followTurnRate: 6,
          maxHeadingGap: 60,
          playerSpacing: 26,
          tolerance: 16,
          heightTolerance: 10,
          headingTolerance: 30,
          holdSeconds: 10,
          achievement: 'vFormation',
        },
      },
    },
  ],
  lod: { near: 1500, mid: 4000, far: 8000 },
  lure: null,
  wind: [],
  audio: { recipe: 'goose', params: {} },
  journal: { title: 'Geese V-formation', description: 'A V of geese crossing the sky that lets you join the end of the line.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: [
    'Geese {direction}, {distance} out, in a V. There is room on the end.',
    'Flight of geese {distance} {direction}. Join up behind them.',
    'V-formation {direction}, about {eta} away. Hold the slot and they will follow you.',
    'Geese crossing {direction}. {distance}. Ease in from behind.',
  ],
  lifetime: { duration: [300, 420], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
  achievements: [{ id: 'vFormation', title: 'V-Formation', description: 'Held the slot in a V of geese for 10 seconds.' }],
});
