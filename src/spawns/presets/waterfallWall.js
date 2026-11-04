// Preset 78: Waterfall wall (rare site, challenge; affects flight). A long cliff (the cliffStep stamp)
// hung with ten thin waterfalls 75 m apart, each dragging a column of sinking air down its arc. The
// run weaves through the gaps: in behind the falls at one gap, out again at the next but one, and so
// on along the wall, with splits and medals; a wing through a fall's curtain drops you (the recipe's
// sinking air follows every fall's arc). Mist rises along the foot and the falls roar. Docs:
// docs/engines/structure.md (recipe fallsWall), emitter.md, the challenge block in
// src/gameplay/challenges.js.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'waterfallWall',
  name: 'Waterfall wall',
  category: 'flightplay',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['challenge', 'water', 'spectacle']),
  placement: Object.freeze({
    chance: 0.035,
    minSpacing: 26000,
    biomes: Object.freeze(['pine', 'snow', 'meadows', 'archipelago']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 80, relief: 'any' }),
    clearance: 400,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('fallsWall'),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'fallsWall', falls: 10, spacing: 75, fallWidth: Object.freeze([11, 15]), launch: 15, sink: 9, curtain: 18,
        voice: true, audioIntensity: 'constant', audioLevel: 0.9,
      }),
    }),
    // Mist along the foot of the wall.
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 5000, hugGround: true, offset: Object.freeze([0, 3, 70]), shape: Object.freeze({ type: 'box', size: Object.freeze([760, 12, 50]) }), speed: Object.freeze([2, 6]), spread: 60,
        gravity: 0, buoyancy: 1.2, buoyancyDecay: 25, drag: 0.6, turbulence: Object.freeze({ spread: 3, wobble: 4, frequency: 0.1 }), life: Object.freeze([10, 16]),
        size: Object.freeze([10, 50]), sizeCurve: 0.7, colors: Object.freeze([0xf6f9fc, 0xeef3f7, 0xe8eef3]), opacity: 0.26, fog: 0.6, sound: false,
      }),
    }),
  ]),
  // The weave, in the site frame (along: out from the lip; across: along the wall). The gap gates sit
  // on the falls' line at their height, crossing in (heading 180, toward the cliff) and out (0) in
  // turn; start and finish lie off the wall's ends, flown along it.
  challenge: Object.freeze({
    name: 'Waterfall Wall',
    gates: Object.freeze([
      Object.freeze({ id: 'start', role: 'start', along: 120, across: -420, height: 60, heading: 90, shape: 'rect', halfWidth: 22, halfHeight: 18 }),
      Object.freeze({ id: 'gap1', role: 'checkpoint', along: 52, across: -300, height: 60, heading: 180, shape: 'rect', halfWidth: 14, halfHeight: 15 }),
      Object.freeze({ id: 'gap2', role: 'checkpoint', along: 52, across: -150, height: 60, heading: 0, shape: 'rect', halfWidth: 14, halfHeight: 15 }),
      Object.freeze({ id: 'gap3', role: 'checkpoint', along: 52, across: 0, height: 60, heading: 180, shape: 'rect', halfWidth: 14, halfHeight: 15 }),
      Object.freeze({ id: 'gap4', role: 'checkpoint', along: 52, across: 150, height: 60, heading: 0, shape: 'rect', halfWidth: 14, halfHeight: 15 }),
      Object.freeze({ id: 'gap5', role: 'checkpoint', along: 52, across: 300, height: 60, heading: 180, shape: 'rect', halfWidth: 14, halfHeight: 15 }),
      Object.freeze({ id: 'finish', role: 'finish', along: 26, across: 420, height: 60, heading: 90, shape: 'rect', halfWidth: 20, halfHeight: 18 }),
    ]),
    medals: Object.freeze({ gold: 30, silver: 40, bronze: 58 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 120 }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1500 }),
    abandonDistance: 3500,
    teleportDistance: 400,
    record: true,
  }),
  lod: Object.freeze({ near: 2000, mid: 6500, far: 16000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({ refDistance: 220 }) }),
  journal: Object.freeze({
    title: 'Waterfall wall',
    description: 'A long cliff hung with thin falls and their sinking curtains: weave through the gaps, behind and out.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'A cliff of waterfalls {direction}, {distance} out. There is a weave run through the gaps.',
    'Waterfall wall {direction}. Keep out of the falls themselves, the air sinks hard in them.',
    'The {name} is about {eta} away, {direction}. In behind the falls, out again, all the way along.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 16000, hysteresis: 3000, outOfViewSeconds: 20 }) }),
});
