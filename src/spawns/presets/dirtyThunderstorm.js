// Preset 35: Dirty thunderstorm (rare event). Over an erupting volcano in storm weather the ash plume
// builds into a towering, ash-dark thunderhead with a spreading anvil, and lightning crackles inside
// the plume itself: violet-white bolts and flickering in-cloud flashes, thunder rolling down the
// mountain, ash falling from the cloud and grit hissing on the canopy inside it. The director brings
// it only where a volcano's eruption runs (filters.near with active sites). Docs:
// docs/engines/weatherVolume.md, lightEffect.md, emitter.md.
export default Object.freeze({
  id: 'dirtyThunderstorm',
  name: 'Dirty thunderstorm',
  category: 'geo',
  kind: 'event',
  rarity: 'rare',
  heavy: false,
  tags: ['spectacle'],
  candidates: { cellSize: 8000, bucketSeconds: 600, chance: 0.6 },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 12000 },
    weather: ['storm'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 30000,
    near: { sites: ['volcano'], active: true, radius: 8000 },
  },
  engines: [
    {
      // The pyrocumulonimbus: the plume built into an ash-dark thunderhead, ash falling under it.
      engine: 'weatherVolume',
      params: {
        form: 'tower', base: 2000, height: 7500, radius: 1800, puffs: 120, storm: 0.95, tint: 0x5f5852, brightness: 0.62,
        anvil: { radius: 5200, thickness: 1100, lean: 2400, puffs: 70, storm: 0.85 },
        overshoot: 0.3,
        rain: [{ radius: 1400, kind: 'dust', density: 0.55, fallSpeed: 2 }],
        insideFog: { density: 8, color: 0x3e3935, darkness: 0.6 },
        canopyGrit: 0.5,
        wind: { turbulence: 0.6, updraft: 6 },
        haze: { near: 4000, far: 50000, max: 0.6 },
        formSeconds: 40,
        dissipateSeconds: 50,
        ownsAudio: false,
      },
    },
    {
      // Lightning inside the ash: mostly in-cloud spider flashes, some bolts to the mountain.
      engine: 'lightEffect',
      params: {
        lightning: {
          rate: 26, radius: 900, cloudBase: 2200, groundShare: 0.3, color: 0xe2d4ff, width: 2.5, branches: 6, flash: 0.5,
          thunder: 0.85, minCameraDistance: 450, cloudGlow: { radius: 1400, intensity: 1.6 },
        },
        visibility: { day: 1, night: 1 },
        sound: true,
      },
    },
    {
      // The ash column feeding the cloud (it stands in for the volcano's own plume where none erupts).
      engine: 'emitter',
      params: {
        particles: 2500, snapToGround: true, style: 'puff', shape: { type: 'disc', radius: 120 }, speed: [18, 32], spread: 12,
        gravity: 0, buoyancy: 4, buoyancyDecay: 45, drag: 0.08, turbulence: { spread: 12, wobble: 16, frequency: 0.05 },
        life: [45, 70], size: [120, 600], sizeCurve: 0.6, sizeJitter: 0.45, brightnessJitter: 0.2,
        colors: [0x55504b, 0x48433f, 0x6f6a65], opacity: 0.85, softness: 1.2, fadeOut: 1.3, fog: 0.35,
        underglow: { color: 0xff5a1e, intensity: 1.6, height: 600 },
        lod: { near: 1, mid: 0.5, far: 0 },
        sound: false,
      },
    },
  ],
  lod: { near: 6000, mid: 20000, far: 45000 },
  lure: null,
  wind: [],
  audio: { recipe: 'thunder', params: {} },
  journal: { title: 'Dirty thunderstorm', description: 'Lightning crackling inside the ash plume of an erupting volcano.' },
  discovery: { radius: 9000, requireInView: true },
  callouts: [
    'Lightning in the ash plume {direction}, {distance} off. That is a dirty thunderstorm.',
    'Dirty thunderstorm over the volcano {direction}, {distance} out. Stay out of the ash.',
    'The {name} is about {eta} away, {direction}. Watch the bolts inside the plume.',
  ],
  lifetime: { duration: [300, 420], despawn: { distance: 30000, hysteresis: 5000, outOfViewSeconds: 30 } },
});
