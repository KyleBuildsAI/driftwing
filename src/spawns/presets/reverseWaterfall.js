// Preset 71: Reverse waterfall (rare site, heavy; affects flight). A river that runs the wrong way:
// its strands rise out of the plunge pool, climb the cliff face, leave the lip and twist into a
// column of water that climbs hundreds of metres into the sky before it frays into a cloud of mist.
// Spray boils up the column, the falls roar, and the air goes up with the water: an updraft column
// strong enough to loft a glider. Seen from far off as a pale plume on the horizon. Docs:
// docs/engines/structure.md (recipe waterfall, reverse), emitter.md, waterEffect.md, windModifier.md.
import { structureStamps } from '../engines/structure/stamps.js';

export default Object.freeze({
  id: 'reverseWaterfall',
  name: 'Reverse waterfall',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  tags: Object.freeze(['water', 'thermal', 'spectacle', 'farLure']),
  placement: Object.freeze({
    chance: 0.03,
    minSpacing: 26000,
    biomes: Object.freeze(['pine', 'snow', 'meadows', 'archipelago']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 60, relief: 'any' }),
    clearance: 400,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null }),
  stamps: structureStamps('waterfall', { width: [300, 380], drop: [120, 150], pool: [50, 65] }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'waterfall', reverse: true, spill: 0.3, strands: Object.freeze([7, 9]), launch: 3, rise: 460, column: 46, columnRadius: 16,
        voice: true, audioIntensity: 'constant', audioLevel: 0.85,
      }),
    }),
    // Spray boiling up the column from the lip, lit like cloud.
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 6000, offset: Object.freeze([0, -10, 42]), shape: Object.freeze({ type: 'disc', radius: 20 }), direction: 'up', speed: Object.freeze([7, 13]), spread: 14,
        gravity: 0, buoyancy: 1.6, buoyancyDecay: 40, drag: 0.12, windFollow: 0.4, turbulence: Object.freeze({ spread: 2, wobble: 4, frequency: 0.12 }),
        life: Object.freeze([16, 24]), size: Object.freeze([5, 34]), sizeCurve: 0.65, colors: Object.freeze([0xf3f8fc, 0xe9f1f7, 0xdde8f0]), opacity: 0.3, fog: 0.5,
        lod: Object.freeze({ near: 1, mid: 0.5, far: 0 }), sound: false,
      }),
    }),
    Object.freeze({ engine: 'waterEffect', params: Object.freeze({ effect: 'plungePool', churn: 0.7, mistRate: 120, voice: false }) }),
    // The column of rising air: from below the pool to well above the mist cloud.
    Object.freeze({
      engine: 'windModifier',
      params: Object.freeze({
        type: 'updraft', offset: Object.freeze([42, 0, -100]), radius: 75, updraft: 13, base: 0, top: 720, sinkRing: 0.15, ringWidth: 1.2, swirl: 3,
        turbulence: 0.5, gust: 3.5, endWithDuration: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2200, mid: 7000, far: 32000 }),
  lure: Object.freeze({ type: 'plume', height: 640, width: 200, color: 0xdce8f1 }),
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'waterfall', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Reverse waterfall',
    description: 'A river that climbs its cliff and pours up into the sky, and takes the air up with it.',
  }),
  discovery: Object.freeze({ radius: 3500, requireInView: true }),
  callouts: Object.freeze([
    'Is that water going up? A reverse waterfall {direction}, {distance} out.',
    'Reverse waterfall {direction}. The air rises with the column, so you can ride it up.',
    'The {name} is about {eta} away, {direction}. Follow the pale plume.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 32000, hysteresis: 4000, outOfViewSeconds: 20 }) }),
});
