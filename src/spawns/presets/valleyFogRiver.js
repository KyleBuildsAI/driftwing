// Preset 34: Valley fog river (common event). At dawn, cold fog fills the valley floors around the
// activation to a fixed depth above the lowest ground: a white river winding between the ridges,
// streaming slowly down the valleys and pouring over the low saddles into the next valley like a slow
// waterfall, with the peaks standing clear above it in the low sun. A soft ambient voice hangs over it.
// Docs: docs/engines/weatherVolume.md (the 'river' form).
export default Object.freeze({
  id: 'valleyFogRiver',
  name: 'Valley fog river',
  category: 'weather',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  tags: ['calm', 'slow', 'spectacle'],
  candidates: { cellSize: 5000, bucketSeconds: 600, chance: 0.5 },
  filters: {
    biomes: ['pine', 'meadows', 'snow'],
    timeOfDay: ['dawn'],
    altitude: { min: 0, max: 3500 },
    weather: ['clear', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'river', radius: 3200, height: 80, puffs: 260, flow: 2.2, pours: 3, tint: 0xf1f4f7, brightness: 1.05, storm: 0.04,
        insideFog: { density: 7, color: 0xdfe5ea, darkness: 0.04 },
        formSeconds: 60,
        dissipateSeconds: 120,
        ownsAudio: true,
      },
    },
  ],
  lod: { near: 3000, mid: 8000, far: 18000 },
  lure: null,
  wind: [],
  audio: { recipe: 'lantern', params: { refDistance: 600 } },
  journal: { title: 'Valley fog river', description: 'Dawn fog flowing down the valleys like a white river and pouring over the saddles.' },
  discovery: { radius: 5000, requireInView: true },
  callouts: [
    'Fog river in the valleys {direction}, {distance} off. Look at it pour over the saddle.',
    'Dawn fog {direction}, {distance} out, filling the valley floors.',
    'The {name} is about {eta} away, {direction}. Fly low over it while the sun is up.',
  ],
  lifetime: { duration: [420, 600], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 30 } },
});
