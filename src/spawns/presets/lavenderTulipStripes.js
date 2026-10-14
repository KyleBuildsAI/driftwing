// Preset 84: Lavender and tulip stripes (uncommon site). Two striped fields side by side on flat open
// country, laid out in rows that read from the air like a ruled page: a lavender field of purple rows
// (6 m stripes of the lavender species) and a tulip field of red, yellow, pink and white bands (14 m
// stripes of tulips), both region overlays. Pollen drifts over the rows in the breeze and the bees
// hum, swelling as the breeze rises. Docs: docs/engines/emitter.md (gusts); the overlay:
// src/world/overlays.js (stripes).
export default Object.freeze({
  id: 'lavenderTulipStripes',
  name: 'Lavender and tulip stripes',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['calm', 'slow', 'spectacle'],
  placement: {
    chance: 0.12,
    minSpacing: 16000,
    biomes: ['meadows', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 6, maxHeight: 450, relief: 'flat' },
    clearance: 400,
    align: 'random',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  stamps: [],
  overlays: [
    {
      // The lavender field, behind the site centre along its heading.
      shape: { kind: 'ellipse', radius: [520, 640], aspect: 0.62, angle: 90, falloff: 90, offset: { along: -400, across: 0 } },
      palette: 'lavenderFields',
      stripes: { width: 6, angle: 'ridge', colors: [0xa184d6, 0x76678c, 0x9a7fd0, 0x6f6a7e], species: ['lavender'] },
      priority: 1,
    },
    {
      // The tulip field ahead of it, its bands across the same rows.
      shape: { kind: 'ellipse', radius: [460, 580], aspect: 0.6, angle: 90, falloff: 90, offset: { along: 400, across: 0 } },
      palette: 'tulipFields',
      stripes: { width: 14, angle: 'ridge', colors: [0xd8443a, 0xf2c94c, 0xf08ab0, 0xf6efe2], species: ['tulip'] },
      priority: 1,
    },
  ],
  engines: [
    // Pollen drifting over the rows, thicker in the breeze (owns the bees' voice).
    {
      engine: 'emitter',
      params: {
        particles: 4000, style: 'droplet', shape: { type: 'disc', radius: 520, height: 2.5 }, hugGround: true, offset: [0, 0.8, 0],
        direction: 'wind', speed: [0.3, 1.2], spread: 60, gravity: 0, buoyancy: 0.12, drag: 1.2, windFollow: 1,
        turbulence: { spread: 0.8, wobble: 1.4, frequency: 0.3 }, life: [7, 12], size: 0.22, sizeJitter: 0.5,
        colors: [0xfff0a8, 0xffe27a, 0xf6f2dc], opacity: 0.8, rate: 260,
        gusts: { threshold: 0.6, count: [500, 900], cooldown: 4, follow: 0.45 },
        lod: { near: 1, mid: 0.3, far: 0 }, sound: true,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'meadowHum', params: {} },
  journal: {
    title: 'Lavender and Tulip Stripes',
    description: 'Fields ruled in rows of lavender and tulips, purple beside red, yellow, pink and white, humming with bees.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Striped fields {direction}, {distance} out: lavender and tulips in rows.',
    'Look {direction}: {name}. They read best from a few hundred metres up.',
    'The {name} are about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
