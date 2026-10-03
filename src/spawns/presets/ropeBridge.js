// Rope bridge (Phase 2 preset 20): a site over a gorge in the hills.
//
// The site's gorge stamp carves a steep gorge with a riverbed floor and two level anchor pads into
// the shared height function (structureStamps('ropeBridge'): terrain meshes, every LOD and ground
// collision agree). A timber-plank rope bridge hangs between the lips, with a few planks missing,
// swaying in the wind (structure ropeBridge). Under it is a pass-under gate from 5 m below the gorge
// floor to 2 m under the deck: fly under the bridge and it sends the typed achievement
// { id: 'threadTheNeedle', title: 'Thread the Needle' } once per spawn. A clipped wall ends in the
// Phase 1 soft crash. Silent, no wind effect. Pure data: the stamp helper is terrain-worker safe.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'ropeBridge',
  name: 'Rope bridge',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.14,
    minSpacing: 12000,
    biomes: ['pine', 'meadows', 'snow'],
    surface: 'land',
    terrain: { minHeight: 90, relief: 'any' },
    clearance: 600,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('ropeBridge'),
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'ropeBridge',
        deckWidth: 2.4,
        sag: 0.07,
        plankSpacing: 1.05,
        missingPlanks: 0.06,
        postHeight: 4.6,
        handRail: 1.15,
        swayAmplitude: 0.5,
        gate: { id: 'under', achievement: { id: 'threadTheNeedle', title: 'Thread the Needle' }, clearance: 2 },
      },
    },
  ],
  lod: { near: 1200, mid: 4000, far: 10000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Rope bridge', description: 'A swaying plank bridge strung across a gorge. There is room to fly under it.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: [
    'Rope bridge {direction}, {distance} out, over a gorge.',
    'There is a gorge {direction} with a bridge across it. Think you can fly under it?',
    'Rope bridge about {eta} away. Thread the needle if you dare.',
    'Bridge over the gorge {distance} {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 10000, hysteresis: 2000, outOfViewSeconds: 20 } },
  achievements: [{ id: 'threadTheNeedle', title: 'Thread the Needle', description: 'Flew under the rope bridge.' }],
});
