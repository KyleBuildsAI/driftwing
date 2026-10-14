// Preset 82: Cherry blossom valley (uncommon site). A valley floor turned pink: a region overlay plants
// cherry trees in bloom over blossom-strewn grass (palette cherryBlossom, species cherry), and every
// gust that comes down the valley tears petals off the canopy in a swirling pink storm (two emitters
// following the WindField's gusts: single petals and a soft pink haze), while the leaves rustle and
// small birds sing in the branches. Docs: docs/engines/emitter.md (gusts); the overlay:
// src/world/overlays.js.
export default Object.freeze({
  id: 'cherryBlossomValley',
  name: 'Cherry blossom valley',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['spectacle', 'calm', 'forest'],
  placement: {
    chance: 0.12,
    minSpacing: 18000,
    biomes: ['meadows', 'pine'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 700, relief: 'valley' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [1500, 1900], falloff: 350 },
    palette: 'cherryBlossom',
    vegetation: { species: ['cherry'], density: 0.72, mode: 'replace' },
    priority: 1,
  }],
  engines: [
    // Petals: a light fall from the canopy all the time, a storm of them on every gust (owns the voice).
    {
      engine: 'emitter',
      params: {
        particles: 9000, style: 'droplet', shape: { type: 'disc', radius: 380, height: 6 }, hugGround: true, offset: [0, 5, 0],
        direction: 'wind', speed: [1, 3.5], spread: 40, gravity: 0.035, drag: 0.9, windFollow: 1,
        turbulence: { spread: 1.6, wobble: 2.4, frequency: 0.35, vertical: 0.8 }, life: [10, 16], size: 0.45, sizeJitter: 0.35,
        colors: [0xffc6da, 0xffe2ec, 0xf7a8c4], opacity: 0.9, fadeOut: 2.5, rate: 90,
        gusts: { threshold: 0.62, count: [1600, 2600], speedScale: 1.6, cooldown: 6, follow: 0.75 },
        soundTriggers: { gust: 'burst' }, lod: { near: 1, mid: 0.35, far: 0 }, sound: true,
      },
    },
    // The storm's pink haze: soft drifting veils torn off the trees, only on the gusts.
    {
      engine: 'emitter',
      params: {
        particles: 2048, style: 'puff', shape: { type: 'disc', radius: 650, height: 10 }, hugGround: true, offset: [0, 4, 0],
        direction: 'wind', speed: [2, 4], spread: 50, gravity: 0, buoyancy: 0.25, buoyancyDecay: 6, drag: 0.7,
        turbulence: { spread: 2.5, wobble: 4, frequency: 0.12 }, life: [9, 14], size: [5, 22], sizeCurve: 0.6,
        colors: [0xf9d3e0, 0xf5bfd2, 0xf3e4eb], opacity: 0.2, rate: 0,
        gusts: { threshold: 0.62, count: [140, 240], cooldown: 6, follow: 0 }, lod: { near: 1, mid: 0.5, far: 0 }, sound: false,
      },
    },
  ],
  lod: { near: 2500, mid: 7000, far: 16000 },
  lure: null,
  wind: [],
  audio: { recipe: 'rustle', params: { chirps: 0.6 } },
  journal: {
    title: 'Cherry Blossom Valley',
    description: 'A valley of cherry trees in full bloom, where every gust throws a storm of petals into the air.',
  },
  discovery: { radius: 3000, requireInView: true },
  callouts: [
    'The valley {direction} has gone pink: cherry blossom, {distance} out.',
    'Cherry trees in bloom {direction}. Fly low when a gust comes through and you will be in a storm of petals.',
    'The {name} is about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 16000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
