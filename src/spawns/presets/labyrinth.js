// Preset 59: Labyrinth (rare site). A hedge maze on a levelled square of pale gravel (a flatten stamp):
// a perfect maze grown from the site's seed, its hedges tall dark-green walls (instanced blocks) with
// an entrance and an exit on opposite sides and a clearing at the heart around a fountain and a
// gilded obelisk. From the ground it is only green walls; from a few hundred metres up the whole
// pattern reads, and you can trace the way in. The fountain splashes softly at the heart. The hedges
// are solid; flying low through the heart earns "Heart of the Maze", and the obelisk is a perch. Docs: docs/engines/structure.md (recipe
// labyrinth).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'labyrinth',
  name: 'Labyrinth',
  category: 'structure',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: ['calm', 'perch', 'spectacle'],
  placement: {
    chance: 0.1,
    minSpacing: 20000,
    biomes: ['meadows', 'pine'],
    surface: 'land',
    terrain: { minHeight: 10, maxHeight: 700, relief: 'any' },
    clearance: 500,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('labyrinth'),
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'labyrinth', cells: [17, 21], hedge: 3.4, thickness: 1.5, achievement: { id: 'heartOfTheMaze', title: 'Heart of the Maze' },
        voice: true, audioIntensity: 'constant', audioLevel: 0.3,
      },
    },
  ],
  lod: { near: 1500, mid: 5000, far: 11000 },
  lure: null,
  wind: [],
  // The fountain at the heart, splashing softly (heard only close by, over the hedges).
  audio: { recipe: 'waterfall', params: { refDistance: 25, rolloffFactor: 1.6, reverb: 0.2 } },
  journal: { title: 'Labyrinth', description: 'A hedge maze on a gravel square, only green walls from the ground and a perfect pattern from the air.' },
  discovery: { radius: 1800, requireInView: true },
  callouts: [
    'Something drawn on the ground {direction}, {distance} out. A hedge maze: climb to read it.',
    'There is a {name} {direction}. From up high you can trace the way to its heart.',
    'The {name} is about {eta} away, {direction}. Fly low through the clearing at the centre if you dare.',
  ],
  lifetime: { duration: null, despawn: { distance: 11000, hysteresis: 2000, outOfViewSeconds: 20 } },
  achievements: [{ id: 'heartOfTheMaze', title: 'Heart of the Maze', description: 'Flew low through the clearing at the heart of the hedge labyrinth.' }],
});
