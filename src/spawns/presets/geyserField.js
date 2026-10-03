// Preset 8: Geyser field (common site; affects flight). A flat basin (placement relief 'flat'; the
// field needs no terrain stamp) steaming gently, with three geysers on seeded, out-of-step eruption
// schedules. Each eruption is a brief steam jet that hisses and lifts a strong, narrow updraft column
// (the emitter's own wind source, which follows the eruption): fly through one and it kicks a glider
// upward. Docs: docs/engines/emitter.md.

/** One geyser: a scheduled steam jet at offset [right, up, forward] with its updraft column. */
function geyser(offset, size, schedule, sound) {
  return {
    engine: 'emitter',
    params: {
      particles: Math.round(2600 * size), hugGround: true, offset, shape: { type: 'disc', radius: 4 * size },
      speed: [30 * size, 46 * size], spread: 6, gravity: 0.4, buoyancy: 3, buoyancyDecay: 6, drag: 0.35,
      turbulence: { spread: 3, wobble: 2.5, frequency: 0.3 }, life: [6, 10], size: [4 * size, 42 * size],
      colors: [0xffffff, 0xf3f5f7, 0xe4e8ec], opacity: 0.72,
      schedule: { ...schedule, idle: 0.05 },
      windSource: { type: 'updraft', strength: 13 * size, radius: 26 * size, height: 300 * size, turbulence: 0.6 },
      soundTriggers: { schedule: 'burst' },
      sound,
    },
  };
}

export default Object.freeze({
  id: 'geyserField',
  name: 'Geyser field',
  category: 'geo',
  kind: 'site',
  rarity: 'common',
  heavy: false,
  placement: {
    chance: 0.14,
    minSpacing: 14000,
    biomes: ['snow', 'pine', 'meadows', 'dunes'],
    surface: 'land',
    terrain: { minHeight: 20, maxHeight: 900, relief: 'flat' },
    clearance: 400,
  },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 6000 },
    weather: null,
    surface: 'land',
    minDistance: 0,
    maxDistance: 20000,
  },
  stamps: [],
  engines: [
    geyser([0, 0, 0], 1.25, { period: [55, 75], active: [10, 14], rampUp: 1.2, rampDown: 3.5 }, true),
    geyser([-140, 0, 120], 1, { period: [35, 50], active: [7, 10], rampUp: 1, rampDown: 3 }, true),
    geyser([120, 0, -150], 0.9, { period: [25, 40], active: [6, 9], rampUp: 1, rampDown: 2.5 }, true),
    {
      engine: 'emitter',
      params: {
        particles: 1500, hugGround: true, shape: { type: 'box', size: [420, 6, 360] }, speed: [0.4, 1.2], spread: 25,
        gravity: 0, buoyancy: 0.6, buoyancyDecay: 20, drag: 0.6, turbulence: { spread: 1.5, wobble: 2, frequency: 0.1 },
        life: [12, 20], size: [6, 30], colors: [0xf6f8fa, 0xeef2f5, 0xe6ebef], opacity: 0.22, sound: false,
      },
    },
  ],
  lod: { near: 1500, mid: 5000, far: 9000 },
  lure: null,
  wind: [],
  audio: { recipe: 'geyser', params: {} },
  journal: { title: 'Geyser field', description: 'A steaming basin where geysers erupt on their own clocks, each one a column of lift.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Geyser field {distance} {direction}. Each eruption is a column of lift.',
    'Steam {direction}, {distance} out. Time a pass over a geyser as it blows.',
    '{name} about {eta} away, {direction}. Watch for the next jet.',
  ],
  lifetime: { duration: null, despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
