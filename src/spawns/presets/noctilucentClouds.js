// Preset 63: Noctilucent clouds (uncommon event). After dusk, when the ground is already dark, thin
// rippled sheets of electric-blue cloud glow low over the sun's azimuth: ice at the edge of space,
// still in sunlight while the sun is 6-16 degrees below the horizon. They foreshorten toward the
// horizon like a real layer and drift slowly; the event waits for the window if it starts early and
// ends once the sun has sunk past it. A glassy, high shimmer goes with them. Sky-anchored over the
// sun's azimuth. Docs: docs/engines/celestial.md (noctilucent).
export default Object.freeze({
  id: 'noctilucentClouds',
  name: 'Noctilucent clouds',
  category: 'celestial',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.45 }),
  filters: Object.freeze({
    biomes: Object.freeze(['snow', 'pine', 'meadows', 'archipelago']),
    timeOfDay: Object.freeze(['dusk']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
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
        fadeIn: 15,
        fadeOut: 20,
        noctilucent: Object.freeze({ strength: 1.2, spread: 70, top: 22, sunWindow: Object.freeze([-16, -6]), drift: 1 }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'skyShimmer', params: Object.freeze({ baseHz: 660, brightness: 0.95 }) }),
  journal: Object.freeze({
    title: 'Noctilucent clouds',
    description: 'Electric-blue ripples of ice cloud glowing at the edge of space, long after the sun had set.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Look low {direction}, toward where the sun went down: those blue ripples are noctilucent clouds.',
    'Night-shining clouds {direction}. They are eighty kilometres up, still catching the sun.',
    'See the electric blue {direction}? Ice clouds at the edge of space. They will not last long.',
  ]),
  // The engine ends it once the sun has sunk past the window; the duration caps a frozen dusk.
  lifetime: Object.freeze({ duration: Object.freeze([600, 900]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
