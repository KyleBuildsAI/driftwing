// Preset 58: Desert oasis caravan (uncommon site). A ring of date palms round a turquoise spring pool
// in the dunes (a basin stamp with its own pool), reeds at the water's edge, a stone well, black
// goat-hair tents with rugs, a shade shelter and a fire pit whose lamps light at dusk. A caravan of
// laden camels walks single file out of the oasis and across the dunes and back on a PathFollower
// route (a pure function of flight time), raising a little sand; their copper bells clonk out of step.
// Palm trunks, the well and the tents are solid, the palm crowns perches.
// Docs: docs/engines/structure.md (recipe oasis), fauna.md (species camel, behaviour column).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'desertOasisCaravan',
  name: 'Desert oasis caravan',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['desert', 'calm', 'slow', 'perch'],
  placement: {
    chance: 0.14,
    minSpacing: 16000,
    biomes: ['dunes'],
    surface: 'land',
    terrain: { minHeight: 8, maxHeight: 500, relief: 'any' },
    clearance: 500,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('oasis'),
  waters: [{ kind: 'pool', stamp: 0, level: { mode: 'basin', fill: 0.78 }, tint: 0x2fa9a2, waves: 0.08 }],
  engines: [
    { engine: 'structure', params: { recipe: 'oasis', palms: [20, 30], tents: [2, 4], voice: false } },
    {
      engine: 'fauna',
      params: {
        species: 'camel', behavior: 'column', count: [12, 18], size: 1, voice: true, voiceIntensity: 0.9,
        column: {
          path: { points: [[115, 8], [420, 90], [820, -40], [1260, 70], [1800, -30], [2300, 40]] },
          lanes: 1, spacing: 4.8, speed: 1.3, jitter: 0.3, mode: 'pingpong', dust: { rate: 0.5, size: 3, color: 0xd8bf8e },
        },
      },
    },
  ],
  lod: { near: 1500, mid: 4500, far: 11000 },
  lure: null,
  wind: [],
  audio: { recipe: 'caravan', params: {} },
  journal: { title: 'Desert oasis', description: 'Date palms round a turquoise pool in the dunes, and a camel caravan walking in across the sand.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: [
    'Palms in the dunes {direction}, {distance} out. An oasis, with a caravan on the move.',
    'There is a {name} {direction}. Follow the line of camels across the sand.',
    'The {name} is about {eta} away, {direction}. The palm crowns make soft perches.',
  ],
  lifetime: { duration: null, despawn: { distance: 11000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
