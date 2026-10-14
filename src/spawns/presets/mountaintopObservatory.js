// Preset 55: Mountaintop observatory (uncommon site). A white telescope building on a level pad cut into
// a summit (a flatten stamp): a drum under a silver dome, a second small dome, a control building and
// an antenna mast with a dish, red lamps glowing at night. At dusk the dome's shutter slides back, the
// dome turns its slit to the target and the telescope rises to it: a comet when one is in the sky,
// else a meteor shower's radiant, else the moon, else a slow survey; at dawn it parks and closes. The
// motors whir and the latch clunks. The dome and the mast are perches, the control roof landable.
// Docs: docs/engines/structure.md (recipe observatory).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'mountaintopObservatory',
  name: 'Mountaintop observatory',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['perch', 'night', 'celestial', 'snow'],
  placement: {
    chance: 0.08,
    minSpacing: 20000,
    biomes: ['snow', 'pine', 'dunes', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 650, relief: 'peak' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('observatory'),
  engines: [
    { engine: 'structure', params: { recipe: 'observatory', radius: [8, 10], drum: [7, 9], slewRate: 3, openSeconds: 22, voice: true, audioIntensity: 'recipe' } },
  ],
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: { recipe: 'observatory', params: {} },
  journal: { title: 'Mountaintop observatory', description: 'A telescope dome on a summit that opens at night and turns to whatever is worth watching in the sky.' },
  discovery: { radius: 2000, requireInView: true },
  callouts: [
    'Observatory on the summit {direction}, {distance} out.',
    'Look {direction}: the {name}. At night the dome opens and the telescope finds the best thing in the sky.',
    'The {name} is about {eta} away, {direction}. The dome top makes a fine perch.',
  ],
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
