// Starling murmuration (Phase 2 preset 14): a dusk event over meadows and farmland.
//
// Three thousand-odd starlings stream through a morphing, folding shape that breathes between a
// ball and a sheet (fauna murmuration). Fly through it and the birds burst away from your path in a
// wave that spreads through the flock, with a rush of wings, then re-form behind you. The wing rush
// swells as you close in (murmuration recipe). The flock fades out with its duration as the light
// goes. No wind effect. Pure data (contract section 1).
export default Object.freeze({
  id: 'starlingMurmuration',
  name: 'Starling murmuration',
  category: 'wildlife',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  candidates: { cellSize: 5000, bucketSeconds: 240, chance: 0.5 },
  filters: {
    biomes: ['meadows'],
    timeOfDay: ['dusk'],
    altitude: { min: 0, max: 2500 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 7000,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'starling',
        behavior: 'murmuration',
        count: [2800, 3600],
        altitude: { mode: 'agl', value: 150, spread: 20 },
        leash: 500,
        fadeIn: 3,
        fadeOut: 12,
        murmuration: { radius: 120, flatten: 0.42, morphSeconds: 12, fold: 0.42, wave: 0.22, seek: 0.95 },
        scatter: { radius: 85, burst: 27, recover: 4.5, spread: 0.93, cooldown: 5 },
      },
    },
  ],
  lod: { near: 2500, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'murmuration', params: {} },
  journal: { title: 'Starling murmuration', description: 'Thousands of starlings folding through the dusk as one shape, scattering as you fly through.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Murmuration {direction}, {distance} out. Thousands of starlings.',
    'Look {direction}: starlings, a whole cloud of them, {distance} away.',
    'Starling murmuration about {eta} away. Fly through and watch them scatter.',
    'That dark cloud {direction} is a murmuration. {distance}.',
  ],
  lifetime: { duration: [140, 220], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
