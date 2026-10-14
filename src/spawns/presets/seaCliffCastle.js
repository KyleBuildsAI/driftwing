// Preset 54: Sea-cliff castle ruin (uncommon site). A ruined stone castle on the edge of a sea cliff (a
// cliffStep stamp dropping toward the shore): curtain walls with battlements, broken through in
// places, round corner towers (some fallen to stumps), a gatehouse with an arched passage and a
// roofless hall in the bailey. On the cliff edge the keep rises 34-42 m with banners streaming in the
// wind: the tower to fly around. Every wall and tower is solid, the keep's top a landable perch, and the
// braziers on the gate, the keep and in the bailey wait for a dragon's breath. The surf booms at the
// cliff foot. Docs: docs/engines/structure.md (recipe castleRuin).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'seaCliffCastle',
  name: 'Sea-cliff castle ruin',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['coast', 'perch', 'spectacle'],
  placement: {
    chance: 0.16,
    minSpacing: 16000,
    biomes: ['archipelago', 'meadows', 'pine'],
    surface: 'coast',
    terrain: { minHeight: 2, maxHeight: 160, relief: 'any' },
    clearance: 500,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'coast' },
  stamps: structureStamps('castleRuin'),
  engines: [
    { engine: 'structure', params: { recipe: 'castleRuin', towers: [5, 7], radius: [30, 40], keepHeight: [34, 42], ruin: 0.35, voice: true, audioIntensity: 'constant', audioLevel: 0.45 } },
  ],
  lod: { near: 1500, mid: 5000, far: 12000 },
  lure: null,
  wind: [],
  audio: { recipe: 'waterfall', params: { refDistance: 120, reverb: 0.55 } },
  journal: { title: 'Sea-cliff castle', description: 'A ruined castle on the edge of a sea cliff, its keep still standing with banners in the wind.' },
  discovery: { radius: 2200, requireInView: true },
  callouts: [
    'Castle ruin on the sea cliff {direction}, {distance} out.',
    'There is a {name} {direction}. The keep is a fine tower to fly around.',
    'The {name} is about {eta} away, {direction}. Watch the walls, they are solid stone.',
  ],
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
