// Preset 45: Sea stacks and sea arches (uncommon site). Off a rocky coast, four to six rock columns
// 40-70 m tall stand out of the sea on wave-cut shelves, and one or two great arches span between
// pairs of legs, high enough to fly through (the seaStacks stamp raises the stacks and the arch legs
// as terrain, painted wet rock; the seaArches recipe lays the wave-bitten lintel across each pair).
// The lintels are solid, with a perch on top of each, and every opening is a fly-through gate: the
// first pass through sends the typed achievement. Surf booms against the rock (the surf recipe). No
// wind effect. Docs: docs/engines/structure.md (recipe seaArches).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'seaStacks',
  name: 'Sea stacks and arches',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['coast', 'water', 'perch', 'spectacle']),
  placement: Object.freeze({
    chance: 0.1,
    minSpacing: 14000,
    biomes: Object.freeze(['pine', 'meadows', 'archipelago', 'snow']),
    surface: 'coast',
    clearance: 900,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'coast' }),
  stamps: structureStamps('seaArches'),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'seaArches',
        thickness: Object.freeze([9, 13]),
        rise: Object.freeze([6, 10]),
        gate: Object.freeze({ id: 'arch', achievement: Object.freeze({ id: 'seaArch', title: 'Through the Sea Arch' }) }),
        audioIntensity: 'constant',
        audioLevel: 0.7,
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 5000, far: 11000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'surf', params: Object.freeze({ size: 260 }) }),
  journal: Object.freeze({
    title: 'Sea stacks and arches',
    description: 'Towers of rock standing in the surf off a wild coast, with a great stone arch you can fly straight through.',
  }),
  discovery: Object.freeze({ radius: 2200, requireInView: true }),
  callouts: Object.freeze([
    'Sea stacks {direction}, {distance} out, and there is an arch among them big enough to fly through.',
    'Rock arch in the surf {distance} {direction}. Line up low and thread it.',
    'The {name} are about {eta} away, {direction}. The arch tops make a fine perch.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 11000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
  achievements: Object.freeze([Object.freeze({ id: 'seaArch', title: 'Through the Sea Arch', description: 'Flew through a sea arch.' })]),
});
