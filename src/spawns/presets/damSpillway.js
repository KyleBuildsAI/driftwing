// Preset 57: Dam with an open spillway (uncommon site). A concrete gravity dam closes a slope; behind
// it lies a reservoir (a basin stamp uphill with its own lake, which the seaplane can land on), in
// front of it the ground far below. In the middle of the crest the spillway is open: the lake
// pours over the lip and down a white chute between training walls into a stilling basin, throwing
// up spray with a rainbow in it on a sunny day, and a river runs on down the valley. Intake towers
// stand in the lake, a valve house on the crest, lamps along it at night. The roar and the surging
// rumble carry down the valley. The wall, towers and basin are solid; the crest is landable.
// Docs: docs/engines/structure.md (recipe dam), emitter.md, celestial.md.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'damSpillway',
  name: 'Dam spillway',
  category: 'structure',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['water', 'lake', 'spectacle', 'perch'],
  placement: {
    chance: 0.12,
    minSpacing: 20000,
    biomes: ['pine', 'meadows', 'snow'],
    surface: 'land',
    terrain: { minHeight: 90, maxHeight: 1600, relief: 'any' },
    clearance: 700,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: structureStamps('dam'),
  waters: [{ kind: 'lake', stamp: 0, level: { mode: 'basin', fill: 0.97 }, tint: 0x3f6f74, waves: 0.2 }],
  engines: [
    { engine: 'structure', params: { recipe: 'dam', spillway: [26, 34], freeboard: 2.5, voice: true, audioIntensity: 'constant', audioLevel: 0.9 } },
    {
      engine: 'emitter',
      params: {
        particles: 3500, hugGround: true, offset: [0, 3, 58], shape: { type: 'box', size: [60, 12, 56] }, speed: [3, 8], spread: 55,
        gravity: 0, buoyancy: 1.3, buoyancyDecay: 20, drag: 0.6, turbulence: { spread: 3, wobble: 4, frequency: 0.12 }, life: [8, 14],
        size: [8, 44], sizeCurve: 0.7, colors: [0xf6f9fc, 0xeef3f7, 0xe8eef3], opacity: 0.28, fog: 0.5, sound: false,
      },
    },
    { engine: 'celestial', params: { rainbow: { radius: 120, height: -8, offset: [0, 80], strength: 1.05, secondary: 0.35 }, ownsAudio: false } },
  ],
  lod: { near: 1800, mid: 6000, far: 15000 },
  lure: null,
  wind: [],
  audio: { recipe: 'dam', params: {} },
  journal: { title: 'Dam spillway', description: 'A concrete dam holding back a mountain lake, its spillway roaring white into the valley below.' },
  discovery: { radius: 2800, requireInView: true },
  callouts: [
    'A dam {direction}, {distance} out, with the spillway open. Look for the spray.',
    'There is a {name} {direction}. The reservoir behind it is calm enough to land on.',
    'The {name} is about {eta} away, {direction}. With the sun behind you there should be a rainbow in the spray.',
  ],
  lifetime: { duration: null, despawn: { distance: 15000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
