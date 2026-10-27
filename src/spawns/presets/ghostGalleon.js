// Preset 69: Ghost galleon (rare event). On a night with clouds about, a three-masted galleon of pale
// green light sails the cloud tops (700 m above the sea, or higher over high ground) on a slow loop 3-4
// km across, rocking in a swell that is not there, its tattered sails bellied, its lanterns burning a
// cold green. It is translucent, with a glowing rim and a shimmer drifting up through it, and the
// moonlight shows through its sails; the hull, castles and masts are solid all the same (the sails
// are not). Its bell tolls now and then, the wind whistles in its rigging, and a faint choir sings. A
// flame (the dragon's breath) lights its lanterns warm, one by one. Docs: docs/engines/structure.md
// (recipe ghostGalleon, motion, lanterns), docs/specs/phase3-contract.md e.2 (PathFollower).
export default Object.freeze({
  id: 'ghostGalleon',
  name: 'Ghost galleon',
  category: 'fantasy',
  kind: 'event',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['night', 'slow', 'spectacle']),
  candidates: Object.freeze({ cellSize: 8000, bucketSeconds: 1200, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['night']),
    altitude: Object.freeze({ min: 100, max: 4000 }),
    // A night with clouds about (building or clearing weather): it sails their tops.
    weather: Object.freeze(['building', 'clearing']),
    surface: 'any',
    minDistance: 2500,
    maxDistance: 7000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'ghostGalleon', voice: true, audioIntensity: 'approach' }),
    }),
  ]),
  lod: Object.freeze({ near: 2500, mid: 8000, far: 20000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'galleon', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Ghost galleon',
    description: 'A sailing ship of green light crossing the cloud tops at night, its bell tolling and its lanterns cold.',
  }),
  discovery: Object.freeze({ radius: 3500, requireInView: true }),
  callouts: Object.freeze([
    'There is a ship {direction}. Sailing on the clouds, {distance} out. I can see through it.',
    'Ghost galleon {direction}, about {eta} away. Listen for its bell.',
    'The {name} is {direction}, {distance} out. If you are the dragon, see if its lanterns will take a flame.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([480, 720]), despawn: Object.freeze({ distance: 14000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
