// Preset 52: Caribou migration (uncommon event). A long column of several hundred caribou walks four
// abreast across the open tundra on a route the PathFollower plans around steep ground and water, a
// grey-brown ribbon kilometres long with pale manes and antlers, kicking up snow dust. Its rumble of
// hooves, the clicking of their ankles and their grunts carry up to a low pass. The column is a pure
// function of flight time (the same column on two clients). Docs: docs/engines/fauna.md (species
// caribou, behaviour column).
export default Object.freeze({
  id: 'caribouMigration',
  name: 'Caribou migration',
  category: 'wildlife',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: ['snow', 'slow', 'spectacle'],
  candidates: { cellSize: 6000, bucketSeconds: 600, chance: 0.5 },
  filters: {
    biomes: ['snow', 'pine'],
    timeOfDay: ['dawn', 'day', 'dusk'],
    altitude: { min: 0, max: 3000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'caribou', behavior: 'column', count: [320, 520], size: 1, voiceIntensity: 0.9, fadeOut: 10,
        column: {
          path: 'auto', length: 3600, lanes: 4, laneWidth: 3.4, spacing: 4.5, speed: 1.7, jitter: 0.9, mode: 'pingpong',
          maxSlope: 0.4, dust: { rate: 1.5, size: 4, color: 0xd9d6cc },
        },
      },
    },
  ],
  lod: { near: 1500, mid: 4500, far: 10000 },
  lure: null,
  wind: [],
  audio: { recipe: 'caribou', params: {} },
  journal: { title: 'Caribou migration', description: 'Hundreds of caribou walking four abreast across the tundra, a column kilometres long.' },
  discovery: { radius: 1800, requireInView: true },
  callouts: [
    'A long dark line on the tundra {direction}, {distance} out. Caribou on the move.',
    'Caribou migration {direction}: hundreds of them in one column, {distance} away.',
    'The {name} is about {eta} away, {direction}. Fly along the column, not over the leaders.',
  ],
  lifetime: { duration: [360, 540], despawn: { distance: 10000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
