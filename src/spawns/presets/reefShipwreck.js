// Preset 43: Reef shipwreck (uncommon site). An old wooden sailing ship lies broken in two on a coral
// reef in shallow water (the reef stamp, painted coral: a flat 2 m under the surface studded with coral
// heads, around a sand hollow 8-10 m deep where the wreck lies). Its halves list hard over, ribs bare
// at the break, cannon and barrels scattered on the sand; the mainmast still stands at a slant with
// its top breaking the surface. The water over the reef turns clear (waterEffect shallows fitted to
// the stamp) and the wreck's planks shade toward the water's depth colour, so the ship reads through
// it from the air; surf breaks along the reef's edge. The hull halves and the masts are solid. The
// surf recipe rolls breakers onto the reef. No wind effect. Docs: docs/engines/structure.md (recipe
// shipwreck), waterEffect.md (shallows).
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'reefShipwreck',
  name: 'Reef shipwreck',
  category: 'ocean',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['water', 'calm', 'slow', 'spectacle']),
  placement: Object.freeze({
    chance: 0.1,
    minSpacing: 16000,
    biomes: Object.freeze(['archipelago', 'dunes', 'meadows']),
    surface: 'water',
    terrain: Object.freeze({ minHeight: -70, maxHeight: -9, relief: 'any' }),
    clearance: 900,
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'water' }),
  stamps: structureStamps('shipwreck'),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'shipwreck',
        length: Object.freeze([34, 46]),
        beam: Object.freeze([9, 12]),
        list: Object.freeze([18, 32]),
        voice: false,
      }),
    }),
    Object.freeze({
      engine: 'waterEffect',
      params: Object.freeze({
        effect: 'shallows',
        color: 0x49d8c6,
        clarity: 0.9,
        surf: 0.55,
        fadeIn: 3,
        voice: true,
        voiceIntensity: 0.55,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 4500, far: 10000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'surf', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Reef shipwreck',
    description: 'An old sailing ship broken in two on a coral reef, its masts and ribs plain to see through the clear shallows.',
  }),
  discovery: Object.freeze({ radius: 1800, requireInView: true }),
  callouts: Object.freeze([
    'Something dark under the water {direction}, {distance} out. A shipwreck on the reef.',
    'Clear shallows {direction}, {distance}. Come in low and slow: there is a wreck in there.',
    'The {name} is about {eta} away, {direction}. Watch for the mast breaking the surface.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 10000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
