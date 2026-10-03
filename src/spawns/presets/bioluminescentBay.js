// Bioluminescent bay (Phase 2 preset 13): a coastal site that is there at night only.
//
// A glow region over the bay (waterEffect bioluminescence): the surf glows blue on the swell crests,
// plankton flash around the camera, and everything that touches the water leaves a blue trail in
// it: the craft skimming or hovering low, the two whales that feed in the bay (their wakes, spouts
// and breaches), and the fish jumping in the shallows (splashes kept to the water). The site is
// placed on the shore line, so the glow lines the beach.
//
// Night only: filters.timeOfDay ['night'] keeps the site to its hours (the SpawnManager creates it
// after dusk and removes it once dawn comes and it is out of view), so it is only discovered at
// night. The surf hiss is the waterfall recipe at a low flow. No wind effect. Pure data.
export default Object.freeze({
  id: 'bioluminescentBay',
  name: 'Bioluminescent bay',
  category: 'ocean',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.06,
    minSpacing: 14000,
    biomes: ['archipelago', 'meadows', 'pine'],
    surface: 'coast',
    clearance: 800,
  },
  filters: { biomes: null, timeOfDay: ['night'], altitude: null, weather: null, surface: 'coast' },
  stamps: [],
  engines: [
    {
      engine: 'waterEffect',
      params: {
        effect: 'bioluminescence',
        radius: 1100,
        strength: 1.4,
        surf: 1.2,
        color: 0x1f9dff,
        flashRate: 18,
        flashRadius: 5,
        fadeIn: 6,
        voice: true,
        voiceIntensity: 0.3,
      },
    },
    {
      engine: 'waterEffect',
      params: { effect: 'splash', interval: [1.5, 4], scatter: 700, strength: 0.2, glow: 1, waterOnly: true, voice: false },
    },
    {
      engine: 'fauna',
      params: {
        species: 'whale',
        behavior: 'pod',
        count: [1, 2],
        size: 0.85,
        fadeIn: 4,
        voice: false,
        pod: { seekWater: 1500, spread: 30, breachChance: 0.25, surfaceSeconds: [16, 28], diveSeconds: [8, 16], wake: 0.7, glow: 1 },
      },
    },
  ],
  lod: { near: 2000, mid: 4000, far: 9000 },
  lure: null,
  wind: [],
  audio: { recipe: 'waterfall', params: { refDistance: 200, size: 600, reverb: 0.5 } },
  journal: { title: 'Bioluminescent bay', description: 'A night bay where the surf glows blue and every touch on the water leaves a trail of light.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: [
    'The water is glowing {direction}, {distance} out. A bioluminescent bay.',
    'Blue light along the shore {direction}. Skim the water there and watch your wake.',
    'Bioluminescent bay about {eta} away, {direction}.',
    'Glowing surf {distance} {direction}. Get down low over it.',
  ],
  lifetime: { duration: null, despawn: { distance: 9000, hysteresis: 2000, outOfViewSeconds: 10 } },
});
