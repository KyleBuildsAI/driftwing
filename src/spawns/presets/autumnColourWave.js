// Preset 83: Autumn colour wave (uncommon site). Over a forest region the season turns as you watch:
// a tint sweep (region overlay, palette autumnForest) rolls slowly downwind across the ground and the
// broadleaf crowns, green to gold to crimson and back, the wave front moving at about 6 m/s, while
// leaves twist down from the canopy and gusts send them spinning (an emitter following the WindField's
// gusts) and the woods rustle. The pines stay green. Docs: docs/engines/emitter.md (gusts); the
// overlay: src/world/overlays.js (tintSweep).
export default Object.freeze({
  id: 'autumnColourWave',
  name: 'Autumn colour wave',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['forest', 'spectacle', 'calm'],
  placement: {
    chance: 0.12,
    minSpacing: 18000,
    biomes: ['pine', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [2200, 2800], falloff: 450 },
    palette: 'autumnForest',
    // A 3.6 km colour wave (the sweep's wave length is four times its width) every 10 minutes.
    tintSweep: { colors: [0xe0a030, 0xb8402a], periodSeconds: 600, direction: 'downwind', width: 900 },
  }],
  engines: [
    // Leaves twisting down from the crowns, a flurry on every gust (owns the voice).
    {
      engine: 'emitter',
      params: {
        particles: 7000, style: 'droplet', shape: { type: 'disc', radius: 420, height: 8 }, hugGround: true, offset: [0, 9, 0],
        direction: 'wind', speed: [0.5, 2.5], spread: 50, swirl: 1.2, gravity: 0.06, drag: 1.1, windFollow: 1,
        turbulence: { spread: 1.2, wobble: 3, frequency: 0.45, vertical: 0.7 }, life: [9, 15], size: 0.55, sizeJitter: 0.4,
        colors: [0xe0a030, 0xc9542a, 0x9c3a22], brightnessJitter: 0.25, opacity: 0.95, fadeOut: 2, rate: 110,
        ground: 'settle', groundOffset: 0.3,
        gusts: { threshold: 0.6, count: [1000, 1800], speedScale: 1.4, cooldown: 5, follow: 0.7 },
        soundTriggers: { gust: 'burst' }, lod: { near: 1, mid: 0.35, far: 0 }, sound: true,
      },
    },
  ],
  lod: { near: 2500, mid: 7000, far: 18000 },
  lure: null,
  wind: [],
  audio: { recipe: 'rustle', params: { creaks: 0.2, chirps: 0.25 } },
  journal: {
    title: 'Autumn Colour Wave',
    description: 'A forest changing colour before your eyes, a slow wave of gold and crimson rolling downwind across the trees.',
  },
  discovery: { radius: 3500, requireInView: true },
  callouts: [
    'Look {direction}: the forest is turning gold and red, {distance} out.',
    'There is an {name} rolling across the woods {direction}. Watch the trees change.',
    'The {name} is about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 18000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
