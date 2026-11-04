// Preset 60: Fireball impact (rare event). At night a bolide tears down the sky from kilometres up, a
// white-hot head with a long orange tail, its roar rising as it comes; it strikes the ground ahead in
// a blinding flash. Seconds later the sonic boom and the thud arrive (sound at 343 m/s). It leaves a
// glowing scorched scar draped on the terrain (the ground's height never changes), embers flickering
// and cooling over a couple of minutes, sparks spitting up and a column of smoke lit orange from below
// drifting off on the wind. Docs: docs/engines/structure.md (recipe fireball), emitter.md (startDelay).
//
// The impact comes `delay` + `fall` seconds after the activation (4 + 7 = 11 s): both emitters start
// then (their startDelay is 11).
export default Object.freeze({
  id: 'fireballImpact',
  name: 'Fireball impact',
  category: 'celestial',
  kind: 'event',
  rarity: 'rare',
  heavy: false,
  tags: ['night', 'celestial', 'spectacle'],
  candidates: { cellSize: 8000, bucketSeconds: 900, chance: 0.25 },
  filters: {
    biomes: null,
    timeOfDay: ['night', 'dusk'],
    altitude: { min: 0, max: 8000 },
    weather: ['clear', 'clearing'],
    surface: 'land',
    minDistance: 3500,
    maxDistance: 8000,
  },
  engines: [
    { engine: 'structure', params: { recipe: 'fireball', delay: 4, fall: 7, altitude: [11000, 14000], angle: [24, 38], scar: [34, 48], cool: 120, voice: true, audioIntensity: 'recipe' } },
    {
      engine: 'emitter',
      params: {
        particles: 2500, style: 'puff', shape: { type: 'disc', radius: 18 }, offset: [0, 2, 0], speed: [3, 7], spread: 18,
        gravity: 0, buoyancy: 2.2, buoyancyDecay: 40, drag: 0.15, windFollow: 0.6, turbulence: { spread: 5, wobble: 6, frequency: 0.08 },
        life: [30, 50], size: [10, 110], sizeCurve: 0.6, sizeJitter: 0.35, colors: [0x3a3632, 0x4a4540, 0x2c2926], opacity: 0.7,
        underglow: { color: 0xff5a1e, intensity: 2.5, height: 140, flicker: 0.3, night: 0.5 },
        startDelay: 11, startRamp: 3, warmStart: false, sound: false,
      },
    },
    {
      engine: 'emitter',
      params: {
        particles: 1200, style: 'spark', blend: 'additive', shape: { type: 'disc', radius: 22 }, hugGround: true, speed: [3, 9], spread: 35,
        gravity: 0.3, buoyancy: 1.2, drag: 0.3, life: [1.5, 4], size: [1.4, 0.4], stretch: 0.06, colors: [0xffd080, 0xff6a20, 0x501004],
        emissive: 6, emissiveDecay: 1.4, bursts: { interval: [1.5, 4], count: [60, 140], minLevel: 0.2 },
        light: { color: 0xff5a1e, intensity: 6e4, range: 700, offset: [0, 12, 0], flicker: 0.45, night: 0 },
        startDelay: 11, sound: false,
      },
    },
  ],
  lod: { near: 4000, mid: 14000, far: 30000 },
  lure: null,
  wind: [],
  audio: { recipe: 'fireball', params: {} },
  journal: { title: 'Fireball impact', description: 'A bolide that tore down the night sky and struck the ground, leaving a glowing scar and a column of smoke.' },
  discovery: { radius: 9000, requireInView: true },
  callouts: [
    'Fireball {direction}! It is coming down, {distance} out.',
    'Something just hit the ground {direction}, {distance} away. Look for the glow and the smoke.',
    'The {name} site is about {eta} away, {direction}. The scar will glow for a while yet.',
  ],
  lifetime: { duration: [150, 210], despawn: { distance: 30000, hysteresis: 4000, outOfViewSeconds: 30 } },
  cooldown: 3600,
});
