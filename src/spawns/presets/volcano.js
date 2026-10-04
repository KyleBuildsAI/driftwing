// Preset 7: Erupting volcano (heavy site; its active state is rare; affects flight). An ash cone with
// a crater (the cone stamp, painted ash) that is usually quiet: a faint plume, a glowing lava lake.
// Its eruption is a director decision (activeState): the plume pulses up kilometres high and stands on
// the horizon 40 km away (the plume lure, shown only while it erupts), lava bombs arc out of the
// crater and boom, the lava glow lights the plume from below at night, lightning flickers in the ash,
// and inside the column the air is turbulent, rising and dark. Docs: docs/engines/emitter.md,
// lightEffect.md, windModifier.md.
export default Object.freeze({
  id: 'volcano',
  name: 'Erupting volcano',
  category: 'geo',
  kind: 'site',
  rarity: 'rare',
  heavy: true,
  placement: {
    chance: 0.05,
    minSpacing: 40000,
    biomes: ['snow', 'pine', 'dunes', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 30, maxHeight: 600, relief: 'any' },
    clearance: 800,
    scale: [0.95, 1.15],
  },
  activeState: { duration: [240, 420] },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 9000 },
    weather: null,
    surface: 'land',
    minDistance: 3000,
    maxDistance: 30000,
  },
  stamps: [{ type: 'cone', radius: [1100, 1400], height: [380, 520], craterRadius: [170, 230], craterDepth: [80, 120], gullies: [7, 10], paint: 'ash' }],
  engines: [
    {
      engine: 'emitter',
      params: {
        particles: 3500, snapToGround: true, style: 'puff', shape: { type: 'disc', radius: 110 }, speed: [24, 42], spread: 12,
        gravity: 0, buoyancy: 5, buoyancyDecay: 50, drag: 0.07, turbulence: { spread: 14, wobble: 18, frequency: 0.05 },
        life: [50, 80], size: [130, 700], sizeCurve: 0.6, sizeJitter: 0.45, brightnessJitter: 0.22,
        colors: [0x6e6660, 0x5c5550, 0x9c968f], opacity: 0.82, softness: 1.2, fadeOut: 1.3, fog: 0.3,
        inactiveIntensity: 0.1, pulse: { period: 14, depth: 0.35 },
        underglow: { color: 0xff5a1e, intensity: 2.4, height: 700 },
        light: { color: 0xff7030, intensity: 3e6, range: 5000, offset: [0, 160, 0] },
        immersion: { radius: 950, height: 4500, base: 120, fogColor: 0x4a4440, darkness: 0.35 },
        lod: { near: 1, mid: 0.5, far: 0 },
        sound: false,
      },
    },
    {
      engine: 'emitter',
      params: {
        particles: 1500, snapToGround: true, style: 'spark', blend: 'additive', shape: { type: 'disc', radius: 70 }, speed: [55, 110],
        spread: 30, gravity: 1, drag: 0.04, windFollow: 0.1, life: [7, 12], size: [7, 4], stretch: 0.07,
        colors: [0xffe0a0, 0xff6a20, 0x3a0c04], emissive: 7, emissiveDecay: 1.6, ground: 'settle', fog: 0.5,
        rate: 4, bursts: { interval: [3, 7], count: [25, 60] }, inactiveIntensity: 0,
        soundTriggers: { burst: 'boom' }, sound: true,
      },
    },
    {
      engine: 'lightEffect',
      params: {
        glows: [
          { layout: 'scatter', count: 16, radius: 90, onGround: true, height: [2, 8], size: [30, 70], colors: [0xff5a1e, 0xff7a2a], intensity: 1.8, flicker: 0.35 },
          { layout: 'scatter', count: 70, radius: 120, onGround: true, height: [1, 3], size: [4, 9], colors: [0xffb040], intensity: 3, flicker: 0.6, wander: { radius: 2, speed: 0.6 } },
        ],
        lightning: {
          rate: 5, radius: 600, cloudBase: 1900, groundShare: 0.25, color: 0xe8d8ff, width: 2.5, branches: 5, flash: 0.4,
          thunder: 0.7, inactiveIntensity: 0, minCameraDistance: 500,
        },
        visibility: { day: 0.6, night: 1 },
        sound: false,
      },
    },
    { engine: 'windModifier', params: { endWithDuration: false } },
  ],
  // The plume's particles sit in the scene fog and the camera's far plane (a few km at golden hour),
  // so the plume lure takes over from about 4 km out.
  lod: { near: 1500, mid: 4000, far: 45000 },
  lure: { type: 'plume', height: 6000, width: 3800, color: 0x5d5754, glow: 0xff5a1e },
  wind: [{ type: 'updraft', params: { radius: 300, updraft: 10, base: 0, top: 4500, sinkRing: 0.1, swirl: 2, turbulence: 0.75, gust: 6, fadeIn: 8 } }],
  audio: { recipe: 'volcano', params: {} },
  journal: { title: 'Erupting volcano', description: 'An ash cone that wakes now and then, throwing lava bombs under a plume seen 40 km away.' },
  discovery: { radius: 8000, requireInView: true },
  callouts: [
    'Volcano erupting {distance} {direction}. Stay out of the ash column.',
    'Ash plume {direction}, {distance} out. Lava bombs are flying.',
    'The {name} {direction} is awake, about {eta} away. Expect rough air in the plume.',
    'Crater glowing {direction}, {distance} away. Keep upwind of the ash.',
  ],
  lifetime: { duration: null, despawn: { distance: 40000, hysteresis: 5000, outOfViewSeconds: 30 } },
});
