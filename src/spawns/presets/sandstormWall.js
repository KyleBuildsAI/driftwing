// Preset 31: Sandstorm wall (uncommon event; affects flight). A haboob: a rolling orange wall of dust
// a kilometre and a half tall and fourteen wide marches downwind across the dunes, its foot churning.
// Ahead of it the gust front hits as a sudden headwind and rough air; inside, the visibility drops to
// a few hundred metres of ochre gloom, the air is turbulent and grit streaks race across the canopy.
// Docs: docs/engines/weatherVolume.md, windModifier.md, emitter.md.
export default Object.freeze({
  id: 'sandstormWall',
  name: 'Sandstorm wall',
  category: 'weather',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: ['desert', 'spectacle'],
  candidates: { cellSize: 9000, bucketSeconds: 600, chance: 0.45 },
  filters: {
    biomes: ['dunes'],
    timeOfDay: ['day', 'dawn', 'dusk'],
    altitude: { min: 0, max: 4500 },
    weather: ['clear', 'building'],
    surface: 'land',
    minDistance: 5000,
    maxDistance: 12000,
  },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'bank', length: 14000, width: 2200, height: 420, puffs: 420, wall: 0.85, followTerrain: true,
        tint: 0xd08a4a, storm: 0.35, brightness: 0.92, billow: 0.35,
        rain: [
          { offset: [-4600, -300], radius: 2400, kind: 'dust', density: 0.7, top: 1100, fallSpeed: 3 },
          { offset: [0, -300], radius: 2400, kind: 'dust', density: 0.75, top: 1100, fallSpeed: 3 },
          { offset: [4600, -300], radius: 2400, kind: 'dust', density: 0.7, top: 1100, fallSpeed: 3 },
        ],
        insideFog: { density: 8, color: 0xa8743f, darkness: 0.35 },
        canopyGrit: 0.9,
        wind: { turbulence: 0.6 },
        // The wall reads across tens of kilometres of desert air, not the bank's default few.
        haze: { near: 3000, far: 32000, max: 0.75 },
        drift: { speed: 11 },
        formSeconds: 40,
        dissipateSeconds: 60,
        ownsAudio: true,
      },
    },
    {
      engine: 'windModifier',
      params: {
        follow: 'weatherVolume',
        sources: [
          // The haboob's gust front, just ahead of the wall, moving with it.
          { type: 'gustFront', offset: [1150, 0, 0], length: 14000, frontWidth: 500, depth: 2600, outflow: 15, outflowTop: 900, lift: 3, liftTop: 1500, turbulence: 0.8, gust: 7, fadeIn: 30 },
        ],
      },
    },
    {
      // Dust boiling up along the wall's foot, marching with it.
      engine: 'emitter',
      params: {
        particles: 6000, style: 'puff', shape: { type: 'line', length: 13000 }, offset: [0, 10, 1000], hugGround: true,
        travel: [0, 0, 11], speed: [1, 4], spread: 50, gravity: 0, buoyancy: 0.6, buoyancyDecay: 20, drag: 0.4, windFollow: 0.6,
        turbulence: { spread: 6, wobble: 20, frequency: 0.06 }, life: [10, 18], size: [60, 260], sizeCurve: 0.6,
        colors: [0xc98a4c, 0xb87a40, 0x9a6a3c], opacity: 0.5, fadeOut: 1.4, fog: 0.8, lod: { near: 1, mid: 0.4, far: 0 },
        sound: false,
      },
    },
  ],
  lod: { near: 4000, mid: 12000, far: 30000 },
  lure: null,
  wind: [],
  audio: { recipe: 'gale', params: { grit: 0.9, howl: 0.45, depth: 0.45 } },
  journal: { title: 'Sandstorm wall', description: 'A wall of dust a kilometre and a half tall that rolled across the dunes and swallowed the sun.' },
  discovery: { radius: 9000, requireInView: true },
  callouts: [
    'Sandstorm wall {distance} {direction}. That is a haboob, and it is moving.',
    'Dust wall {direction}, {distance} out. Expect a gust front and almost no visibility inside.',
    'The {name} is about {eta} away, {direction}. Climb over it or keep clear.',
    'Look {direction}: the horizon is turning orange. Sandstorm, {distance} off.',
  ],
  lifetime: { duration: [360, 480], despawn: { distance: 25000, hysteresis: 5000, outOfViewSeconds: 30 } },
  anchor: { align: 'downwind' },
});
