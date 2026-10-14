// Preset 86: Redwood giants (uncommon site). A grove of giant redwoods 60-110 m tall stands over a dark
// forest floor (a region overlay planting the redwood species, palette redwoodForest), far enough apart
// to slalom between: every trunk is a cylinder collider (the vegetation collider provider) and every
// crown a perch. Needles drift down through the light, in flurries when the wind gusts through the
// crowns, and the great trunks creak. Docs: docs/engines/emitter.md (gusts); the overlay and the
// trunk colliders: src/world/overlays.js, src/world/vegetationColliders.js.
export default Object.freeze({
  id: 'redwoodGiants',
  name: 'Redwood giants',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['forest', 'perch', 'spectacle'],
  placement: {
    chance: 0.12,
    minSpacing: 18000,
    biomes: ['pine'],
    surface: 'land',
    terrain: { minHeight: 30, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [1300, 1700], falloff: 300 },
    palette: 'redwoodForest',
    // About one giant per 40 m square: room to slalom between the trunks.
    vegetation: { species: ['redwood'], density: 0.075, mode: 'replace' },
    priority: 1,
  }],
  engines: [
    // Needles and motes drifting down through the light under the crowns (owns the voice).
    {
      engine: 'emitter',
      params: {
        particles: 5000, style: 'droplet', shape: { type: 'disc', radius: 500, height: 50 }, hugGround: true, offset: [0, 20, 0],
        direction: 'wind', speed: [0.2, 1], spread: 70, gravity: 0.02, drag: 1.4, windFollow: 0.8,
        turbulence: { spread: 0.8, wobble: 1.8, frequency: 0.25 }, life: [14, 22], size: 0.3, sizeJitter: 0.4,
        colors: [0x8a6a3e, 0xb08a52, 0x6f7a3a], opacity: 0.85, rate: 160,
        gusts: { threshold: 0.6, count: [700, 1200], cooldown: 6, follow: 0.6 },
        soundTriggers: { gust: 'burst' }, lod: { near: 1, mid: 0.3, far: 0 }, sound: true,
      },
    },
  ],
  lod: { near: 2500, mid: 7000, far: 16000 },
  lure: null,
  wind: [],
  audio: { recipe: 'rustle', params: { creaks: 0.8, chirps: 0.15 } },
  journal: {
    title: 'Redwood Giants',
    description: 'A grove of giant redwoods taller than a cathedral, spaced just wide enough to slalom between the trunks.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Giant redwoods {direction}, {distance} out. Room to fly between the trunks, if you are careful.',
    'The {name} are {direction}. Their crowns make good perches.',
    'The {name} are about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 16000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
