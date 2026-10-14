// Preset 62: Green flash (uncommon event). At sunset over the sea, as the sun's top limb sinks to the
// ocean horizon, a thin green rim and a detached green sliver show on it, and in the moment it
// vanishes a brief green flash fires, with a glassy bell. It only shows toward an open-ocean horizon
// (the celestial engine samples the terrain toward the sun once a second) and only for an evening sun
// still above the horizon: an activation in the morning or after sunset ends at create (declined),
// and once the sun is well down the event ends a few seconds later. Sky-anchored at the sun.
// Docs: docs/engines/celestial.md (greenFlash).
export default Object.freeze({
  id: 'greenFlash',
  name: 'Green flash',
  category: 'celestial',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['celestial', 'coast', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.5 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['dusk']),
    altitude: Object.freeze({ min: 0, max: 3000 }),
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'water',
    minDistance: 2000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 3,
        fadeOut: 6,
        greenFlash: Object.freeze({ strength: 1.2, flashSeconds: 1.6, afterSeconds: 8 }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'skyShimmer', params: Object.freeze({ baseHz: 523, brightness: 0.8 }) }),
  journal: Object.freeze({
    title: 'Green flash',
    description: 'The last sliver of the setting sun turned green over the sea, and flashed for a heartbeat as it went.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Clear horizon over the sea {direction}. Watch the very last of the sun: you might catch the green flash.',
    'The sun is about to touch the ocean {direction}. Keep your eyes on the top edge.',
    'Green flash conditions {direction}: open sea and a clean sunset. Do not blink.',
  ]),
  // The engine ends it a few seconds after sunset; the duration caps a slow (long day) sunset.
  lifetime: Object.freeze({ duration: Object.freeze([600, 900]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  cooldown: 1800,
});
