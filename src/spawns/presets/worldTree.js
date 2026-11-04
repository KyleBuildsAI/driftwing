// Preset 66: World tree (rare heavy site). A colossal tree taller than any mountain, 1.1-1.35 km to
// the crown, its trunk ninety metres thick at the buttressed foot. Great limbs branch off in tiers and
// hold up a crown 1-1.4 km across with open lanes between them: fly through a lane for the
// achievement. The trunk, limbs, roots and foliage are solid (capsules and spheres), the top of every
// limb's first bend and the crown are perches, golden motes drift in the canopy at night, the leaves
// rustle and the limbs groan. Its tree lure stands on the horizon 50 km away.
// Docs: docs/engines/structure.md (recipe worldTree), lightEffect.md.
export default Object.freeze({
  id: 'worldTree',
  name: 'World tree',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  tags: Object.freeze(['perch', 'forest', 'spectacle', 'farLure']),
  placement: Object.freeze({
    chance: 0.06,
    minSpacing: 60000,
    biomes: Object.freeze(['pine', 'meadows', 'snow']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 30, maxHeight: 600, relief: 'any' }),
    clearance: 1500,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'worldTree',
        height: Object.freeze([1100, 1350]),
        trunkRadius: Object.freeze([70, 90]),
        limbs: Object.freeze([9, 12]),
        crown: Object.freeze([520, 680]),
        laneAchievement: Object.freeze({ id: 'worldTreeLane', title: 'Through the World Tree' }),
        voice: true,
        audioIntensity: 'approach',
      }),
    }),
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          Object.freeze({
            layout: 'scatter', count: 220, radius: 650, height: Object.freeze([520, 1300]), size: Object.freeze([3, 7]),
            colors: Object.freeze([0xffd98a, 0xfff0c0]), intensity: 2.6, flicker: 0.3, wander: Object.freeze({ radius: 12, speed: 0.25 }),
          }),
        ]),
        visibility: Object.freeze({ day: 0.04, night: 1 }),
        lod: Object.freeze({ near: 1, mid: 1, far: 0 }),
        sound: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 12000, far: 50000 }),
  lure: Object.freeze({ type: 'tree', height: 1400, width: 1500, color: 0x4a6a3c }),
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'canopy', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'World tree',
    description: 'A tree taller than the mountains, its crown a forest in the sky with lanes to fly through and limbs to land on.',
  }),
  discovery: Object.freeze({ radius: 6000, requireInView: true }),
  callouts: Object.freeze([
    'Is that a tree {direction}? It is taller than the mountains, {distance} out.',
    'The world tree stands {direction}. There are lanes through the crown, and the limbs make good perches.',
    'The {name} is about {eta} away, {direction}. Mind the trunk: it is ninety metres thick.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 50000, hysteresis: 4000, outOfViewSeconds: 30 }) }),
  achievements: Object.freeze([
    Object.freeze({ id: 'worldTreeLane', title: 'Through the World Tree', description: 'Flew through a lane in the world tree\'s crown.' }),
  ]),
});
