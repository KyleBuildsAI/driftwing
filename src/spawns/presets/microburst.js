// Preset 5: Microburst (uncommon event; affects flight). A dark shower cloud lets go: its rain shaft
// slams a downdraft into the ground, which bursts outward as a ring gust that throws a ring of dust
// across the land. Flying through it is the classic windshear trap: a headwind, then a violent sink,
// then a tailwind. Docs: docs/engines/weatherVolume.md, windModifier.md, emitter.md.
export default Object.freeze({
  id: 'microburst',
  name: 'Microburst',
  category: 'weather',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  candidates: { cellSize: 8000, bucketSeconds: 450, chance: 0.4 },
  filters: {
    biomes: ['meadows', 'dunes', 'pine', 'snow'],
    timeOfDay: ['day', 'dawn', 'dusk'],
    altitude: { min: 0, max: 5000 },
    weather: ['building', 'storm'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'cumulus', base: 1300, height: 2600, radius: 1300, storm: 0.85, puffs: 52, brightness: 0.72, tint: 0xc4c9d1,
        rain: [{ radius: 750, density: 0.92, fallSpeed: 14 }],
        wind: { turbulence: 0.3 },
        canopyRain: 0.4,
        formSeconds: 25,
        dissipateSeconds: 40,
        ownsAudio: true,
      },
    },
    {
      engine: 'windModifier',
      params: {
        sources: [
          { type: 'downburst', coreRadius: 520, downdraft: 18, outflow: 18, depth: 260, top: 2000, expand: 16, maxRadius: 3200, frontLift: 4, turbulence: 0.85, gust: 6, start: 12, fadeIn: 3 },
          { type: 'curtain', length: 1100, thickness: 500, top: 1300, downdraft: 6, outflow: 3, depth: 120, reach: 600, start: 12, fadeIn: 3 },
        ],
      },
    },
    {
      engine: 'emitter',
      params: {
        particles: 5000, shape: { type: 'ring', radius: 190, innerRadius: 120 }, hugGround: true, radial: 26,
        speed: [1, 3], spread: 20, gravity: 0.15, drag: 0.3, ground: 'settle', groundOffset: 2,
        turbulence: { spread: 4, wobble: 3, frequency: 0.15 }, life: [6, 11], size: [10, 62],
        colors: [0xbca47e, 0xa48c6a, 0x8f7c64], opacity: 0.55, sound: false,
      },
    },
  ],
  lod: { near: 2500, mid: 9000, far: 22000 },
  lure: null,
  wind: [],
  audio: { recipe: 'waterfall', params: { refDistance: 260 } },
  journal: { title: 'Microburst', description: 'A shower that slams into the ground and bursts outward as a ring of wind and dust.' },
  discovery: { radius: 4000, requireInView: true },
  callouts: [
    'Microburst {distance} {direction}. Do not fly under that shaft.',
    'Heavy shaft {direction}, {distance} out. Expect a headwind, then sink, then a tailwind.',
    '{name} {direction}, about {eta} away. See the dust ring spreading on the ground.',
  ],
  lifetime: { duration: [150, 240], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
