// Preset 72: Forest wisps (uncommon event, night, pine forests). A knot of pale blue-green lights
// hangs over the trees. Come close and they fall in behind you, trailing your craft for a while; then
// they drift away toward the nearest place you have not discovered yet, waiting for you whenever you
// fall behind, and gather over it when you arrive. They shimmer and ting softly and light the
// treetops around them. No wind effect. Docs: docs/engines/lightEffect.md (glows, guide, light).
export default Object.freeze({
  id: 'forestWisps',
  name: 'Forest wisps',
  category: 'fantasy',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['night', 'forest', 'spectacle', 'slow']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 600, chance: 0.45 }),
  filters: Object.freeze({
    biomes: Object.freeze(['pine']),
    timeOfDay: Object.freeze(['night']),
    altitude: Object.freeze({ min: 0, max: 2500 }),
    weather: Object.freeze(['clear', 'clearing', 'building']),
    surface: 'land',
    minDistance: 1500,
    maxDistance: 4000,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          // The wisps themselves: a few bright orbs breathing slowly, drifting round each other.
          Object.freeze({
            layout: 'scatter', count: 9, radius: 12, height: Object.freeze([3, 13]), size: Object.freeze([2.2, 3.4]),
            colors: Object.freeze([0xa8fff0, 0x9fd8ff, 0xd4ffb0]), intensity: 6.5, pulse: Object.freeze({ period: 3.5, depth: 0.5 }),
            wander: Object.freeze({ radius: 6, speed: 0.35, vertical: 0.6 }), shape: 'orb',
          }),
          // Motes trailing round them, blinking.
          Object.freeze({
            layout: 'scatter', count: 64, radius: 18, height: Object.freeze([1, 15]), size: Object.freeze([0.45, 0.85]),
            colors: Object.freeze([0xb8fff2, 0xc8e8ff]), intensity: 4, blink: Object.freeze({ period: Object.freeze([1.5, 3]), duty: 0.45 }),
            wander: Object.freeze({ radius: 8, speed: 0.6, vertical: 0.5 }), shape: 'firefly',
          }),
        ]),
        guide: Object.freeze({ joinRadius: 500, trailDistance: 35, trailSeconds: 35, speed: 14, height: 12, ceiling: 300, lead: 280, search: 16000, arrive: 140, retarget: 5 }),
        light: Object.freeze({ color: 0x9fffe8, intensity: 6000, range: 220, offset: Object.freeze([0, 8, 0]), pulse: Object.freeze({ period: 3.5, depth: 0.4 }), priority: 1, night: 1 }),
        visibility: Object.freeze({ day: 0, night: 1 }),
        lod: Object.freeze({ near: 1, mid: 1, far: 0.9 }),
        sound: true,
        soundIntensity: 'approach',
        endRamp: 8,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 800, mid: 3000, far: 9000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'wisps', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Forest wisps',
    description: 'Lights over the night forest that trail behind you, then lead you somewhere new.',
  }),
  discovery: Object.freeze({ radius: 700, requireInView: true }),
  callouts: Object.freeze([
    'Lights over the trees {direction}, {distance} out. Wisps, I think.',
    'Wisps {direction}. Get close and they might show you something.',
    'The {name} are about {eta} away, {direction}. Follow them when they move off.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([420, 600]), despawn: Object.freeze({ distance: 9000, hysteresis: 2000, outOfViewSeconds: 30 }) }),
  cooldown: 1500,
});
