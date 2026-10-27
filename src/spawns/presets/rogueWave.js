// Preset 46: Rogue wave (uncommon event). Out over open ocean a single wall of water 14 m high and
// nearly two kilometres long rolls across the sea at 16 m/s, steeper on its front face, white water
// breaking along the crest with spray blowing off it (waterEffect wave: a travelling sech-squared crest
// with tapered ends, lifting the surface the water query reports, so a seaplane on the water rides up
// and over it). It crosses the player's view broadside, grows in over its first few hundred metres
// and dies away after three and a half kilometres. The surf recipe roars along the crest, with one big
// breaker as it reaches full height. No wind effect. Docs: docs/engines/waterEffect.md (wave).
export default Object.freeze({
  id: 'rogueWave',
  name: 'Rogue wave',
  category: 'ocean',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['water', 'spectacle']),
  candidates: Object.freeze({ cellSize: 8000, bucketSeconds: 600, chance: 0.35 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day', 'golden', 'dawn', 'dusk']),
    altitude: Object.freeze({ min: 0, max: 3000 }),
    weather: null,
    surface: 'water',
    minDistance: 3000,
    maxDistance: 7000,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'waterEffect',
      params: Object.freeze({
        effect: 'wave',
        mode: 'front',
        height: 14,
        width: 48,
        lean: 0.5,
        crestLength: 900,
        taper: 320,
        speed: 16,
        travelHeading: 90,
        start: 1800,
        travel: 3600,
        spray: 340,
        sprayHeight: 10,
        foam: 0.9,
        fadeIn: 0,
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 6000, far: 12000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'surf', params: Object.freeze({ refDistance: 220, size: 900 }) }),
  journal: Object.freeze({
    title: 'Rogue wave',
    description: 'A lone wall of water three times the height of the swell, rolling across the open ocean with its crest breaking white.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Big wave {direction}, {distance} out. A rogue, well above the swell.',
    'White water {distance} {direction}: a rogue wave rolling across the sea.',
    'Rogue wave about {eta} away, {direction}. If you are on the water, face into it.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([250, 270]), despawn: Object.freeze({ distance: 12000, hysteresis: 2500, outOfViewSeconds: 30 }) }),
});
