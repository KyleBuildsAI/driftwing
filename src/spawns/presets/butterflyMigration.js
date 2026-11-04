// Preset 51: Butterfly migration (uncommon event). A loose orange cloud of a couple of thousand
// monarch butterflies flutters low over open country, riding the real WindField wind: the whole cloud
// drifts downwind (gusts and other spawns' air carry it too) while each butterfly flits and glides on
// its own. From a distance it reads as an orange haze; fly through and they scatter softly around the
// craft. A papery wing rush swells as you close in. Docs: docs/engines/fauna.md (species butterfly,
// behaviour flock with windDrift).
export default Object.freeze({
  id: 'butterflyMigration',
  name: 'Butterfly migration',
  category: 'wildlife',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: ['calm', 'slow', 'spectacle'],
  candidates: { cellSize: 5000, bucketSeconds: 450, chance: 0.45 },
  filters: {
    biomes: ['meadows', 'pine', 'dunes'],
    timeOfDay: ['day'],
    altitude: { min: 0, max: 2500 },
    weather: ['clear', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 7000,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'butterfly', behavior: 'flock', count: [1600, 2400], size: 1.4, sizeJitter: 0.2, speed: 3, windDrift: 1,
        altitude: { mode: 'agl', value: 35, spread: 20, ceiling: 400 }, floor: 3, wander: 0.12, leash: 260,
        flocking: { separation: 1.6, separationRadius: 4, alignment: 0.25, cohesion: 0.05, neighborRadius: 10, maxNeighbors: 5 },
        scatter: { radius: 35, burst: 6, recover: 3, spread: 0.55, trigger: 'scatter', cooldown: 8 },
        fadeIn: 4, fadeOut: 12, voiceIntensity: 0.5,
      },
    },
  ],
  lod: { near: 1200, mid: 3500, far: 9000 },
  lure: null,
  wind: [],
  audio: { recipe: 'murmuration', params: { refDistance: 40 } },
  journal: { title: 'Butterfly migration', description: 'A drifting orange cloud of monarch butterflies riding the wind across the land, thousands of wings at once.' },
  discovery: { radius: 1200, requireInView: true },
  callouts: [
    'An orange haze {distance} {direction}. That is a butterfly migration, riding the wind.',
    'Butterflies {direction}, {distance} out: thousands of them, drifting downwind.',
    'The {name} is about {eta} away, {direction}. Fly low and slow through it.',
  ],
  lifetime: { duration: [240, 360], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
