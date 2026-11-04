// Preset 33: Hurricane eye (heavy, rare event; affects flight). A hurricane over the open ocean, fifty
// kilometres across: spiral rain bands sweep in toward a towering eyewall, and its cloud canopy stands
// on the horizon 60 km away (the anvil lure). Fly in through the bands' squalls and the violent,
// dark eyewall, with its roaring 40 m/s winds, heavy rain on the canopy and the sea whipped white
// below, and punch through into the calm eye: still air, the stadium wall of cloud curving up all
// around, and blue sky above. Docs: docs/engines/weatherVolume.md (the 'ring' form), windModifier.md
// (the 'cyclone' source), emitter.md.
export default Object.freeze({
  id: 'hurricaneEye',
  name: 'Hurricane eye',
  category: 'weather',
  kind: 'event',
  rarity: 'rare',
  heavy: true,
  tags: ['water', 'spectacle', 'farLure'],
  candidates: { cellSize: 30000, bucketSeconds: 1800, chance: 0.4 },
  filters: {
    biomes: null,
    timeOfDay: ['day', 'dawn', 'dusk'],
    altitude: { min: 0, max: 14000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'water',
    minDistance: 18000,
    maxDistance: 34000,
  },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'ring', base: 250, radius: 4200, height: 11000, flare: 1700, puffs: 380, spin: 0.004, storm: 0.6, tint: 0xe9edf1,
        bands: { count: 4, turns: 1.1, reach: 26000, width: 2400, height: 4200, puffs: 340 },
        canopy: { reach: 2.6, thickness: 1600, puffs: 150 },
        // Rain at the foot of the eyewall, around the eye.
        rain: [
          { offset: [4900, 0], radius: 1500, density: 0.8, top: 5000 },
          { offset: [2450, 4244], radius: 1500, density: 0.8, top: 5000 },
          { offset: [-2450, 4244], radius: 1500, density: 0.8, top: 5000 },
          { offset: [-4900, 0], radius: 1500, density: 0.8, top: 5000 },
          { offset: [-2450, -4244], radius: 1500, density: 0.8, top: 5000 },
          { offset: [2450, -4244], radius: 1500, density: 0.8, top: 5000 },
        ],
        canopyRain: 1,
        insideFog: { density: 7, color: 0x6f7782, darkness: 0.4 },
        // The cyclone source carries all the wind: the volume's own stays off, so the eye is calm.
        wind: { turbulence: 0 },
        haze: { near: 6000, far: 90000, max: 0.6 },
        drift: { speed: 5 },
        formSeconds: 40,
        dissipateSeconds: 90,
        ownsAudio: true,
      },
    },
    {
      engine: 'windModifier',
      params: {
        follow: 'weatherVolume',
        sources: [
          // The bands' spin and geometry match the volume's (its bands turn at 0.4 x its spin).
          {
            type: 'cyclone', eyeRadius: 3600, wallRadius: 4900, wallWidth: 1400, outerRadius: 28000, flare: 1700, maxTangential: 42, decay: 0.6,
            inflow: 8, inflowTop: 1500, updraft: 8, subsidence: 1, top: 12000, bands: 4, bandTurns: 1.1, bandSpin: 0.0016,
            turbulence: 0.95, bandTurbulence: 0.5, eyeTurbulence: 0.04, gust: 9, rotation: 1, fadeIn: 40,
          },
        ],
      },
    },
    {
      // The sea whipped into spray under the eyewall, swept around with the wind.
      engine: 'emitter',
      params: {
        particles: 8000, style: 'puff', shape: { type: 'ring', radius: 5200, innerRadius: 4300 }, hugGround: true, offset: [0, 3, 0],
        travel: [0, 0, 5], swirl: 26, speed: [2, 6], spread: 40, gravity: 0, buoyancy: 0.5, buoyancyDecay: 8, drag: 0.5, windFollow: 0.6,
        turbulence: { spread: 4, wobble: 8, frequency: 0.2 }, life: [6, 12], size: [20, 70], sizeCurve: 0.6,
        colors: [0xf2f5f7, 0xe3e9ee, 0xcfd8de], opacity: 0.4, fadeOut: 1.4, fog: 0.9, lod: { near: 1, mid: 0.3, far: 0 },
        sound: false,
      },
    },
  ],
  lod: { near: 9000, mid: 30000, far: 70000 },
  lure: { type: 'anvil', height: 12000, width: 42000, color: 0xe1e5ea },
  wind: [],
  audio: { recipe: 'gale', params: { grit: 0.35, howl: 0.8, depth: 0.95, refDistance: 900 } },
  journal: { title: 'Hurricane eye', description: 'Through the eyewall of a hurricane into its calm eye, with a stadium of cloud all around and blue sky above.' },
  discovery: { radius: 25000, requireInView: true },
  callouts: [
    'Hurricane {distance} {direction}. Its canopy fills that whole horizon.',
    'Spiral rain bands {direction}, {distance} out. The eyewall winds are over 40 metres a second.',
    'The {name} is about {eta} away, {direction}. Punch through the wall and the eye is calm.',
    'Hold on through the eyewall. Inside, the air goes still and the sky opens up.',
  ],
  lifetime: { duration: [600, 780], despawn: { distance: 60000, hysteresis: 8000, outOfViewSeconds: 45 } },
});
