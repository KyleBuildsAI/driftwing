// Preset 32: Snow squall (common event; affects flight). A squall line sweeps downwind over the snow
// country: a low, dark-bellied cloud deck dragging curtains of heavy snow, a white wall of blowing snow at
// its foot and spindrift smoking off the ground ahead of it. Inside it is a whiteout: the world closes
// to a few hundred metres of white, snow streams past the canopy, and the gusts of its front shove the
// craft about. Docs: docs/engines/weatherVolume.md, windModifier.md, emitter.md.
export default Object.freeze({
  id: 'snowSquall',
  name: 'Snow squall',
  category: 'weather',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  tags: ['snow'],
  candidates: { cellSize: 5000, bucketSeconds: 360, chance: 0.5 },
  filters: {
    biomes: ['snow'],
    timeOfDay: null,
    altitude: { min: 0, max: 5000 },
    weather: ['building', 'storm', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      // The squall line: a low, dark-bellied cloud deck dragging three curtains of heavy snow.
      engine: 'weatherVolume',
      params: {
        form: 'bank', base: 1000, followTerrain: false, length: 5000, width: 1600, height: 700, puffs: 140, wall: 0.3,
        storm: 0.7, tint: 0xd6dee8, brightness: 0.8,
        rain: [
          { offset: [-1600, 0], radius: 850, kind: 'snow', density: 0.95, fallSpeed: 2.2, lean: 200 },
          { offset: [0, 0], radius: 900, kind: 'snow', density: 0.95, fallSpeed: 2.2, lean: 200 },
          { offset: [1600, 0], radius: 850, kind: 'snow', density: 0.95, fallSpeed: 2.2, lean: 200 },
        ],
        canopyRain: 0.4,
        insideFog: { density: 8, color: 0xe8edf2, darkness: 0.12 },
        wind: { turbulence: 0.45, downdraft: 3, outflow: 10 },
        haze: { near: 2000, far: 30000, max: 0.85 },
        drift: { speed: 9 },
        formSeconds: 30,
        dissipateSeconds: 45,
        ownsAudio: true,
      },
    },
    {
      // The whiteout: a low wall of blowing snow under the squall, marching with it.
      engine: 'weatherVolume',
      params: {
        form: 'bank', length: 3600, width: 1800, height: 240, puffs: 160, wall: 0.45, followTerrain: true,
        tint: 0xf2f5f8, storm: 0.15, brightness: 1.02, billow: 0.4,
        insideFog: { density: 8, color: 0xeef2f6, darkness: 0.05 },
        canopyGrit: 0.35,
        wind: { turbulence: 0.5 },
        drift: { speed: 9 },
        formSeconds: 30,
        dissipateSeconds: 45,
        ownsAudio: false,
      },
    },
    {
      engine: 'windModifier',
      params: {
        follow: 'weatherVolume',
        sources: [
          // The squall's gust front, sweeping just ahead of the snow.
          { type: 'gustFront', offset: [900, 0, 0], length: 5000, frontWidth: 300, depth: 2200, outflow: 13, outflowTop: 600, lift: 2, liftTop: 900, turbulence: 0.75, gust: 8, fadeIn: 20 },
          // The cold downdraft under the snow core, spreading at the ground.
          { type: 'downburst', coreRadius: 700, downdraft: 4, outflow: 8, depth: 200, top: 1200, expand: 0, maxRadius: 1600, frontLift: 1, turbulence: 0.6, gust: 5, fadeIn: 20 },
        ],
      },
    },
    {
      // Spindrift smoking off the snow along the gust front.
      engine: 'emitter',
      params: {
        particles: 4000, style: 'puff', shape: { type: 'line', length: 3600 }, offset: [0, 4, 950], hugGround: true,
        travel: [0, 0, 9], direction: 'wind', speed: [4, 9], spread: 35, gravity: 0, buoyancy: 0.4, buoyancyDecay: 6, drag: 0.6, windFollow: 1,
        turbulence: { spread: 3, wobble: 6, frequency: 0.2 }, life: [6, 11], size: [8, 45], sizeCurve: 0.7,
        colors: [0xf7f9fb, 0xeef2f6, 0xe2e8ee], opacity: 0.45, fadeOut: 1.6, fog: 0.9, lod: { near: 1, mid: 0.4, far: 0 },
        sound: false,
      },
    },
  ],
  lod: { near: 2500, mid: 9000, far: 20000 },
  lure: null,
  wind: [],
  audio: { recipe: 'gale', params: { grit: 0.6, howl: 0.7, depth: 0.25 } },
  journal: { title: 'Snow squall', description: 'A squall line of heavy snow and gusts that turned the world white for a minute.' },
  discovery: { radius: 4500, requireInView: true },
  callouts: [
    'Snow squall {distance} {direction}. It is a whiteout under that cloud.',
    'Squall line {direction}, {distance} out. Gusts ahead of it, then heavy snow.',
    'The {name} is about {eta} away, {direction}. Fly around it if you want to see.',
    'Look {direction}: a curtain of snow is coming across, {distance} off.',
  ],
  lifetime: { duration: [240, 360], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 } },
  anchor: { align: 'downwind' },
});
