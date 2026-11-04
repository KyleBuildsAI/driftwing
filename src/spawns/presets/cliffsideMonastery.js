// Preset 53: Cliffside monastery (rare site). A whitewashed Himalayan monastery on the lip of a sheer
// cliff (a cliffStep stamp, painted basalt): a main hall with a gilded lantern roof, a chorten, a bell
// pavilion and a tall prayer pole on the plateau, smaller halls clinging to the face below on masonry
// buttresses. Strings of prayer flags in the five colours swing out and ripple in the real WindField
// wind; the temple bell rings across the valley and small bells tinkle in the gusts. The butter lamps
// light themselves at dusk, and the braziers wait for a dragon's breath (they are ignitables). The
// roofs are landable perches. Docs: docs/engines/structure.md (recipe monastery), lightEffect.md.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'cliffsideMonastery',
  name: 'Cliffside monastery',
  category: 'structure',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: ['perch', 'spectacle', 'snow', 'calm'],
  placement: {
    chance: 0.05,
    minSpacing: 22000,
    biomes: ['snow', 'pine'],
    surface: 'land',
    terrain: { minHeight: 280, relief: 'any' },
    clearance: 500,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('monastery'),
  engines: [
    { engine: 'structure', params: { recipe: 'monastery', halls: [2, 3], strings: [11, 15], flags: [18, 26], voice: true, audioIntensity: 'wind' } },
    {
      engine: 'lightEffect',
      params: {
        glows: [
          { layout: 'scatter', count: 26, radius: 34, offset: [0, 0, -18], onGround: true, height: [2, 9], size: [1.2, 2.4], colors: [0xffc46a, 0xffb050], intensity: 1.6, flicker: 0.35, shape: 'orb' },
        ],
        visibility: { day: 0, night: 1 },
        sound: false,
      },
    },
  ],
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: { recipe: 'bells', params: {} },
  journal: { title: 'Cliffside monastery', description: 'White halls clinging to a sheer cliff, prayer flags snapping in the wind and a bell ringing across the valley.' },
  discovery: { radius: 2200, requireInView: true },
  callouts: [
    'Monastery on the cliff {direction}, {distance} out. Listen for the bell.',
    'There is a {name} {direction}. Look at the prayer flags: they show you the wind.',
    'The {name} is about {eta} away, {direction}. The roofs are good perches.',
  ],
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
