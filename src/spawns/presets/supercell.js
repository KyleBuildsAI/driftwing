// Preset 2: Supercell (heavy, uncommon event; affects flight). A rotating thunderstorm tower with a
// spreading anvil that stands on the horizon 30+ km away (its FAR lure flickers with lightning), a
// lowered wall cloud at its rear flank, rain shafts under the forward flank, lightning with thunder
// delayed by distance, and the air of a storm: an updraft under the base, downdrafts in the shafts, a
// gust front sweeping out ahead and a rear-flank downdraft. The storm drifts with the steering wind.
// Docs: docs/engines/weatherVolume.md, lightEffect.md, windModifier.md.
export default Object.freeze({
  id: 'supercell',
  name: 'Supercell',
  category: 'weather',
  kind: 'event',
  rarity: 'uncommon',
  heavy: true,
  candidates: { cellSize: 12000, bucketSeconds: 450, chance: 0.5 },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 9000 },
    weather: ['building', 'storm'],
    surface: 'any',
    minDistance: 8000,
    maxDistance: 22000,
  },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'tower', base: 1100, height: 10500, radius: 2800, storm: 0.75, puffs: 170,
        anvil: { radius: 9000, thickness: 1600, lean: 3200, storm: 0.45, puffs: 120 },
        overshoot: 0.6,
        wallCloud: { radius: 950, drop: 380, offset: -900, rotation: 8 },
        rain: [
          { offset: [800, 1600], radius: 1500, density: 0.8, downdraft: 7, outflow: 11 },
          { offset: [-700, 2700], radius: 900, density: 0.55, downdraft: 4, outflow: 6 },
        ],
        wind: { updraft: 6, turbulence: 0.55 },
        drift: { speed: 9 },
        formSeconds: 45,
        dissipateSeconds: 60,
        ownsAudio: false,
        journal: [{ key: 'stormsChased', value: 1, op: 'add', max: 6000 }],
      },
    },
    {
      engine: 'lightEffect',
      params: {
        lightning: { rate: 9, radius: 4500, cloudBase: 1100, groundShare: 0.6, branches: 8, flash: 0.7, thunder: 1 },
        visibility: { day: 1, night: 1 },
        sound: true,
      },
    },
    {
      engine: 'windModifier',
      params: {
        drift: 9,
        driftTerrain: false,
        sources: [
          { type: 'gustFront', offset: [2800, 0, 0], arcRadius: 7000, length: 10000, frontWidth: 400, depth: 3500, outflow: 15, lift: 5, fadeIn: 40 },
          { type: 'downburst', offset: [-1400, 0, 0], coreRadius: 900, downdraft: 10, outflow: 12, depth: 300, top: 2200, expand: 0, maxRadius: 2400, fadeIn: 40 },
        ],
      },
    },
  ],
  lod: { near: 6000, mid: 22000, far: 60000 },
  lure: { type: 'anvil', height: 11000, width: 17000, color: 0xdfe3ea, flash: 1.2 },
  wind: [],
  audio: { recipe: 'thunder', params: {} },
  journal: { title: 'Supercell', description: 'A rotating thunderstorm whose anvil spreads across the sky, seen from 30 km away.' },
  discovery: { radius: 14000, requireInView: true },
  callouts: [
    'Supercell building {distance} {direction}. That anvil is huge.',
    'Thunderstorm {direction}, {distance} out. Expect a gust front ahead of it.',
    '{name} {distance} {direction}, about {eta} away. Lightning in the core.',
    'Big storm {direction}. Watch the rain shafts, they hide downdrafts.',
  ],
  lifetime: { duration: [420, 600], despawn: { distance: 30000, hysteresis: 5000, outOfViewSeconds: 30 } },
});
