// Preset 56: Steam train on a stone viaduct (rare site). A line of tall semicircular stone arches
// carries a railway across a deep gorge (a gorge stamp), between two tunnel portals cut into wooded
// hillocks on its rims. A steam train (a black locomotive, its tender and a few coaches) runs on a
// PathFollower as a pure function of flight time: it bursts out of one tunnel whistling, crosses at
// speed trailing steam puffs, and disappears into the other tunnel, where it waits before coming back.
// The piers, arches, deck, portals and the train itself are solid; fly under the arches (each opening
// is a gate, and the first pass earns "Under the Arches"). Its chuff and whistle ride on the engine.
// Docs: docs/engines/structure.md (recipe viaduct).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'steamTrainViaduct',
  name: 'Steam train viaduct',
  category: 'structure',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: ['spectacle', 'perch'],
  placement: {
    chance: 0.07,
    minSpacing: 20000,
    biomes: ['pine', 'meadows', 'snow'],
    surface: 'land',
    terrain: { minHeight: 110, relief: 'any' },
    clearance: 600,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('viaduct'),
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'viaduct', span: [20, 26], coaches: [2, 4], speed: [11, 15], wait: [35, 60],
        achievement: { id: 'underTheArches', title: 'Under the Arches' }, voice: true, audioIntensity: 'recipe',
      },
    },
  ],
  lod: { near: 1800, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'train', params: {} },
  journal: { title: 'Steam train viaduct', description: 'A stone viaduct across a gorge, and the steam train that crosses it between two tunnels.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Stone viaduct {direction}, {distance} out. Listen for the whistle: the train runs between the tunnels.',
    'There is a {name} {direction}. The arches are wide enough to fly under.',
    'The {name} is about {eta} away, {direction}. Watch for steam over the gorge.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2500, outOfViewSeconds: 20 } },
  achievements: [{ id: 'underTheArches', title: 'Under the Arches', description: 'Flew under an arch of the stone viaduct.' }],
});
