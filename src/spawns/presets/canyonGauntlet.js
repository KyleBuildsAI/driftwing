// Preset 76: Canyon gauntlet (uncommon site, challenge). A wide, winding canyon cut into the land
// (the carve stamp) with a timed run down its floor through natural rock gates: weathered pillars
// either side of each opening, some bridged by rock arches. Fly through the start gate and the
// clock runs; every gate gives a split against your best, a missed gate costs five seconds, and the
// time at the finish earns a medal (best times per craft in the journal). The wind moans through
// the canyon as you close in. Docs: docs/engines/structure.md (recipe canyonGates), the challenge
// block in src/gameplay/challenges.js.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'canyonGauntlet',
  name: 'Canyon gauntlet',
  category: 'flightplay',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['challenge', 'desert']),
  placement: Object.freeze({
    chance: 0.07,
    minSpacing: 22000,
    biomes: Object.freeze(['dunes', 'pine', 'meadows']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 80, relief: 'any' }),
    clearance: 400,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('canyonGates'),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'canyonGates', arches: 0.5, pillarRadius: Object.freeze([5, 8]), span: Object.freeze([7, 11]), rubble: Object.freeze([16, 26]), voice: true, audioIntensity: 'approach' }),
    }),
  ]),
  // The run: `along` is metres along the canyon from its middle, placed on the floor path; `height`
  // above the floor there.
  challenge: Object.freeze({
    name: 'Canyon Gauntlet',
    gates: Object.freeze([
      Object.freeze({ id: 'start', role: 'start', along: -1150, height: 16, shape: 'rect', halfWidth: 24, halfHeight: 14 }),
      Object.freeze({ id: 'g1', role: 'checkpoint', along: -800, height: 14, shape: 'rect', halfWidth: 20, halfHeight: 13 }),
      Object.freeze({ id: 'g2', role: 'checkpoint', along: -450, height: 18, shape: 'rect', halfWidth: 21, halfHeight: 14 }),
      Object.freeze({ id: 'g3', role: 'checkpoint', along: -100, height: 13, shape: 'rect', halfWidth: 19, halfHeight: 12 }),
      Object.freeze({ id: 'g4', role: 'checkpoint', along: 250, height: 20, shape: 'rect', halfWidth: 21, halfHeight: 14 }),
      Object.freeze({ id: 'g5', role: 'checkpoint', along: 600, height: 15, shape: 'rect', halfWidth: 20, halfHeight: 13 }),
      Object.freeze({ id: 'g6', role: 'checkpoint', along: 900, height: 17, shape: 'rect', halfWidth: 21, halfHeight: 13 }),
      Object.freeze({ id: 'finish', role: 'finish', along: 1150, height: 16, shape: 'rect', halfWidth: 24, halfHeight: 14 }),
    ]),
    medals: Object.freeze({ gold: 46, silver: 62, bronze: 88 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 150 }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1600 }),
    abandonDistance: 4000,
    teleportDistance: 400,
    record: true,
  }),
  lod: Object.freeze({ near: 2000, mid: 7000, far: 15000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'windRush', params: Object.freeze({ howlHz: 240, howl: 0.7, gust: 0.7 }) }),
  journal: Object.freeze({
    title: 'Canyon gauntlet',
    description: 'A wide canyon run through natural rock gates against the clock, with splits and medals.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Canyon with rock gates {direction}, {distance} out. It is a timed run.',
    'Canyon gauntlet {direction}. Fly the start gate and the clock runs; splits at every gate.',
    'The {name} is about {eta} away, {direction}. Press Y near the start for the prompt.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 15000, hysteresis: 3000, outOfViewSeconds: 20 }) }),
});
