// Preset 39: Hot spring terraces (uncommon site). A hillside of white travertine stepping down in
// shelves (the terraces stamp, painted travertine), each shelf holding a pool of hot turquoise water
// behind its lip, steam curling off the pools and drifting downhill with the breeze. The warm air
// rising off the pools makes a gentle thermal. It bubbles and hisses softly. Docs:
// docs/engines/emitter.md; the terraces stamp and its pools: src/world/stamps.js, waters.js.
export default Object.freeze({
  id: 'hotSpringTerraces',
  name: 'Hot spring terraces',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['thermal', 'calm', 'slow'],
  // Downhill-aligned, so the shelves step down the real slope.
  placement: {
    chance: 0.06,
    minSpacing: 22000,
    biomes: ['meadows', 'pine', 'snow', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 30, maxHeight: 1400, relief: 'any' },
    clearance: 350,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [{ type: 'terraces', length: [340, 460], width: [160, 220], steps: [5, 7], lip: [1.4, 2.2], falloff: [60, 90], paint: 'travertine' }],
  waters: [{ kind: 'pool', stamp: 0, level: { mode: 'basin', fill: 0.85 }, material: 'water', tint: 0x40c8c4, waves: 0.04, glint: 1.2, foam: 0.3 }],
  engines: [
    {
      // Steam off the pools, drifting with the breeze, and the warm air's gentle thermal.
      engine: 'emitter',
      params: {
        particles: 3000, style: 'puff', shape: { type: 'box', size: [180, 0, 400] }, hugGround: true, offset: [0, 1, 0],
        speed: [0.5, 1.6], spread: 25, gravity: 0, buoyancy: 0.8, buoyancyDecay: 12, drag: 0.6, windFollow: 0.9,
        turbulence: { spread: 1.5, wobble: 3, frequency: 0.15 }, life: [10, 18], size: [6, 34], sizeCurve: 0.7, sizeJitter: 0.4,
        colors: [0xf4f7f8, 0xeef2f4, 0xe2e8ec], opacity: 0.32, softness: 1.8, fadeOut: 1.6, fog: 0.8,
        windSource: { type: 'updraft', strength: 1.6, radius: 200, height: 450, turbulence: 0.15 },
        lod: { near: 1, mid: 0.4, far: 0 },
        sound: true,
      },
    },
  ],
  lod: { near: 1500, mid: 4500, far: 10000 },
  lure: null,
  wind: [],
  audio: { recipe: 'geyser', params: { refDistance: 90 } },
  journal: { title: 'Hot spring terraces', description: 'White travertine shelves stepping down a hillside, each holding a steaming turquoise pool.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Hot spring terraces {direction}, {distance} off. See the turquoise pools?',
    'Steam on the hillside {direction}, {distance} out. Those are hot springs.',
    'The {name} is about {eta} away, {direction}. The warm air over them gives a little lift.',
  ],
  lifetime: { duration: null, despawn: { distance: 10000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
