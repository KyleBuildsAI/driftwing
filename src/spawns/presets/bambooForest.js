// Preset 90: Bamboo forest (uncommon site). A dense grove of tall bamboo (a region overlay planting the
// bamboo species, palette bambooGrove) whose culms bend with the WindField's near-ground wind: each gust
// runs across the grove as a visible ripple (the vegetation sway reads the wind-sway texture, and
// bamboo answers gusts more strongly than any other plant). Leaves shake loose on the gusts, and the
// grove whispers and knocks, hollow culm against culm, in cascades when a gust comes through. Docs:
// docs/engines/emitter.md (gusts); the overlay and the sway: src/world/overlays.js,
// src/render/windSway.js.
export default Object.freeze({
  id: 'bambooForest',
  name: 'Bamboo forest',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['forest', 'calm'],
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['meadows', 'archipelago', 'pine'],
    surface: 'land',
    terrain: { minHeight: 10, maxHeight: 800, relief: 'any' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [{
    shape: { kind: 'disc', radius: [800, 1100], falloff: 220 },
    palette: 'bambooGrove',
    vegetation: { species: ['bamboo'], density: 0.85, mode: 'replace' },
    priority: 1,
  }],
  engines: [
    // Leaves shaken loose by the gusts (owns the voice: the knocks cascade on every gust).
    {
      engine: 'emitter',
      params: {
        particles: 6000, style: 'droplet', shape: { type: 'disc', radius: 360, height: 8 }, hugGround: true, offset: [0, 9, 0],
        direction: 'wind', speed: [1, 3], spread: 45, swirl: 0.8, gravity: 0.05, drag: 1, windFollow: 1,
        turbulence: { spread: 1.4, wobble: 2.2, frequency: 0.4, vertical: 0.7 }, life: [8, 13], size: 0.4, sizeJitter: 0.4,
        colors: [0xa8c060, 0xc8c46a, 0x7fa048], opacity: 0.9, rate: 40,
        gusts: { threshold: 0.58, count: [900, 1600], speedScale: 1.5, cooldown: 4, follow: 0.85 },
        soundTriggers: { gust: 'burst' }, lod: { near: 1, mid: 0.3, far: 0 }, sound: true,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'rustle', params: { knocks: 0.85, chirps: 0.2 } },
  journal: {
    title: 'Bamboo Forest',
    description: 'A dense grove of tall bamboo where every gust runs through the culms as a ripple, knocking hollow wood against wood.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'A bamboo forest {direction}, {distance} out. Watch the gusts ripple through it.',
    'The {name} is {direction}. Listen for the culms knocking when the wind gets up.',
    'The {name} is about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
