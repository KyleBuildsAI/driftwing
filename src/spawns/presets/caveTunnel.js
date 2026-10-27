// Preset 77: Cave tunnel (rare site, challenge). A lone rock mountain stands on a flattened plain (the
// flatten stamp), and a winding tunnel is bored clean through it, portal to portal, lit by lanterns
// along its walls. The run threads the bore against the clock: start at the entry portal, gates in
// the bore, finish at the exit. The mountain is one rock mesh with mesh collision inside and out
// (three-mesh-bvh, the one preset that needs it: contract b.6), so the bore's walls are as solid as
// its flanks; the summit is a perch. A low moan sounds in the bore. Docs: docs/engines/structure.md
// (recipe caveTunnel), the challenge block in src/gameplay/challenges.js.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'caveTunnel',
  name: 'Cave tunnel',
  category: 'flightplay',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['challenge', 'perch']),
  placement: Object.freeze({
    chance: 0.035,
    minSpacing: 30000,
    biomes: Object.freeze(['meadows', 'pine', 'dunes', 'snow']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 20, maxHeight: 900, relief: 'flat' }),
    clearance: 500,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('caveTunnel'),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'caveTunnel', length: 640, bore: 22, width: 170, height: 230, meander: 55, climb: 16, lanterns: true, voice: true, audioIntensity: 'approach' }),
    }),
  ]),
  // The run: `along` is metres along the mountain from its middle, placed on the bore's centre line
  // (`height` and `across` offset a gate from it); every gate faces along the bore.
  challenge: Object.freeze({
    name: 'Cave Tunnel',
    gates: Object.freeze([
      Object.freeze({ id: 'portalIn', role: 'start', along: -312, height: 0, shape: 'circle', radius: 18 }),
      Object.freeze({ id: 'g1', role: 'checkpoint', along: -190, height: 0, shape: 'circle', radius: 17 }),
      Object.freeze({ id: 'g2', role: 'checkpoint', along: -70, height: 0, shape: 'circle', radius: 17 }),
      Object.freeze({ id: 'g3', role: 'checkpoint', along: 50, height: 0, shape: 'circle', radius: 17 }),
      Object.freeze({ id: 'g4', role: 'checkpoint', along: 170, height: 0, shape: 'circle', radius: 17 }),
      Object.freeze({ id: 'portalOut', role: 'finish', along: 312, height: 0, shape: 'circle', radius: 18 }),
    ]),
    medals: Object.freeze({ gold: 15, silver: 21, bronze: 30 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 4, outsideCrossing: 'miss', skipDistance: 120 }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1400 }),
    abandonDistance: 3000,
    teleportDistance: 300,
    record: true,
  }),
  lod: Object.freeze({ near: 2500, mid: 7000, far: 16000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'windRush', params: Object.freeze({ howlHz: 72, howl: 1, gust: 0.4, refDistance: 160 }) }),
  journal: Object.freeze({
    title: 'Cave tunnel',
    description: 'A lone rock mountain with a winding tunnel bored clean through it. Thread the bore against the clock.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'A mountain with a hole through it {direction}, {distance} out. There is a tunnel run.',
    'Cave tunnel {direction}. The bore winds, so line up on the lanterns.',
    'The {name} is about {eta} away, {direction}. Slow down before the entry portal.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 16000, hysteresis: 3000, outOfViewSeconds: 20 }) }),
});
