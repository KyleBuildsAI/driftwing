// Preset 10: Mega-waterfall (uncommon site; affects flight). A river spills over a cliff step 110-160 m
// high (the cliffStep stamp, painted wet rock) as a wide curtain of water into a churning plunge pool.
// A mist cloud boils up from the foot with a rainbow in it by day, the roar carries for kilometres,
// and the falling water drags a curtain of sinking air down the cliff that spills outward over the
// pool. Docs: docs/engines/structure.md (recipe waterfall), emitter.md, weatherVolume.md,
// celestial.md, waterEffect.md, windModifier.md.
export default Object.freeze({
  id: 'megaWaterfall',
  name: 'Mega-waterfall',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.035,
    minSpacing: 16000,
    biomes: ['pine', 'snow', 'meadows', 'archipelago'],
    surface: 'land',
    terrain: { minHeight: 60, relief: 'any' },
    clearance: 400,
    align: 'downhill',
  },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 5000 },
    weather: null,
    surface: 'land',
    minDistance: 0,
    maxDistance: 20000,
  },
  stamps: [{ type: 'cliffStep', width: [380, 520], drop: [110, 160], length: [520, 680], face: [8, 12], falloff: [140, 180], pool: [55, 75], paint: 'wetRock' }],
  engines: [
    { engine: 'structure', params: { recipe: 'waterfall', spill: 0.34, strands: [7, 10], launch: 4.5, voice: true, audioIntensity: 'constant', audioLevel: 0.9 } },
    {
      engine: 'emitter',
      params: {
        particles: 4000, hugGround: true, offset: [0, 3, 80], shape: { type: 'box', size: [180, 16, 70] }, speed: [3, 9], spread: 60,
        gravity: 0, buoyancy: 0.9, drag: 0.6, turbulence: { spread: 2, wobble: 3, frequency: 0.12 }, life: [8, 14], size: [10, 52],
        colors: [0xf6f9fc, 0xeef3f7, 0xe8eef3], opacity: 0.32, sound: false,
      },
    },
    {
      engine: 'weatherVolume',
      params: { form: 'mist', baseMode: 'anchor', base: -105, radius: 190, height: 430, rise: 6, puffs: 44, ownsAudio: false },
    },
    { engine: 'celestial', params: { rainbow: { radius: 230, height: -30, offset: [0, 70], strength: 1.15, secondary: 0.4 }, ownsAudio: false } },
    { engine: 'waterEffect', params: { effect: 'plungePool', churn: 0.9, mistRate: 160, voice: false } },
    {
      engine: 'windModifier',
      params: { type: 'curtain', offset: [18, 0, -110], length: 220, thickness: 120, top: 180, downdraft: 9, outflow: 7, depth: 50, reach: 450, turbulence: 0.6, gust: 4 },
    },
  ],
  lod: { near: 1800, mid: 6000, far: 16000 },
  lure: null,
  wind: [],
  audio: { recipe: 'waterfall', params: {} },
  journal: { title: 'Mega-waterfall', description: 'A river thrown off a cliff in a roaring curtain, with a rainbow in its mist.' },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'Huge waterfall {distance} {direction}. Mind the sinking air at the curtain.',
    'Waterfall {direction}, {distance} out. There should be a rainbow in the mist.',
    'The {name} is about {eta} away, {direction}. You will hear it before you see the pool.',
  ],
  lifetime: { duration: null, despawn: { distance: 16000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
