// Maelstrom* (Phase 2 preset 12): a rare ocean site in deep water.
//
// A whirlpool sinks a spinning funnel into the sea, with spiral ridges, flow-mapped foam arms and
// mist over its eye (waterEffect), under a wide, pale air vortex rising from the eye to a lowered
// collar of cloud (vortex). Both turn counter-clockwise seen from above. The air vortex blows a
// Rankine source (the wind entry): a slow swirl that pulls you in at low level within about 2 km,
// with lift and rough air over the eye, strong enough to toss a glider and shake a jet. The vortex
// voice is the deep roar (tornado recipe, at reduced intensity). It is not heavy: at the far tier the
// pale column still stands on the horizon with a quarter of its puffs. Pure data (contract section 1).
export default Object.freeze({
  id: 'maelstrom',
  name: 'Maelstrom',
  category: 'ocean',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  placement: {
    chance: 0.035,
    minSpacing: 30000,
    biomes: null,
    surface: 'water',
    terrain: { maxHeight: -25, relief: 'any' },
    clearance: 1500,
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'water' },
  stamps: [],
  engines: [
    {
      engine: 'waterEffect',
      params: {
        effect: 'whirlpool',
        radius: 320,
        eyeShare: 0.1,
        depth: 20,
        spin: 0.75,
        arms: 5,
        twist: 8.5,
        ridge: 0.85,
        foam: 0.95,
        direction: 1,
        spinUp: 12,
        mistRate: 50,
        mistSize: 8,
        voice: false,
      },
    },
    {
      engine: 'vortex',
      params: {
        startStage: 'mature',
        surface: 'water',
        coreRadius: 70,
        topRadius: 520,
        cloudBase: 1300,
        taper: 1.5,
        twist: 0.35,
        wobble: 30,
        wobblePeriod: 14,
        collar: 1.1,
        opacity: 0.42,
        striation: 0.8,
        color: 0xd5dde2,
        shadeColor: 0x56606b,
        sprayColor: 0xe8f2f6,
        puffs: 600,
        puffSize: 120,
        groundParticles: 2600,
        debrisRadius: 2.2,
        sprayHeight: 80,
        particleSize: 4.5,
        windCoreRadius: 110,
        voice: true,
        audioIntensity: 0.6,
      },
    },
  ],
  lod: { near: 2500, mid: 5000, far: 14000 },
  lure: null,
  wind: [
    {
      type: 'rankine',
      params: {
        rotation: 1,
        maxTangential: 24,
        inflowRadius: 2200,
        inflowSpeed: 8,
        updraft: 14,
        sinkRing: 0.15,
        turbulence: 0.7,
        gust: 5,
      },
    },
  ],
  audio: { recipe: 'tornado', params: { refDistance: 260 } },
  journal: { title: 'Maelstrom', description: 'A whirlpool that swallows the sea, with a pale vortex spinning over its eye.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'Maelstrom {distance} {direction}. Mind the pull near the water.',
    'There is a whirlpool turning {direction}, {distance} out.',
    'The sea is spinning {direction}. Maelstrom about {eta} away.',
    'Rough air ahead: the maelstrom is {distance} {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
