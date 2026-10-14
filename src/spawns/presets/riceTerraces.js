// Preset 85: Rice terraces (uncommon site). Two flights of paddies step down a green hillside side by
// side (terraces stamps aligned downhill, seven to nine shelves each behind low mud bunds), every flat
// flooded with still water that mirrors the sky (pool water bodies with the sky mirror), the banks
// between them bright with young rice (palette riceTerraces). At dawn a mist lies in the steps and
// thins as the sun climbs (a weather-volume bank with hours); water trickles from paddy to paddy and
// frogs call. Docs: docs/engines/weatherVolume.md (hours); the stamps, waters and overlays:
// src/world/stamps.js, waters.js, overlays.js.

/** One flight of paddies: long and narrow down the slope, many low shelves. */
const FLIGHT = Object.freeze({ type: 'terraces', length: [380, 460], width: [150, 170], steps: [7, 9], lip: [0.7, 1], falloff: [40, 60], paint: 'mud' });
/** Its flooded flats: shallow, almost still, a sky mirror with a little glint. */
const PADDIES = Object.freeze({ kind: 'pool', level: Object.freeze({ mode: 'basin', fill: 0.72 }), material: 'water', tint: 0x6f8f74, waves: 0.03, glint: 1.4, foam: 0.15, mirror: 0.7 });

export default Object.freeze({
  id: 'riceTerraces',
  name: 'Rice terraces',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: ['calm', 'slow', 'spectacle'],
  placement: {
    chance: 0.14,
    minSpacing: 16000,
    biomes: ['archipelago', 'meadows', 'pine'],
    surface: 'land',
    terrain: { minHeight: 40, maxHeight: 900, relief: 'any' },
    clearance: 400,
    align: 'downhill',
  },
  filters: { biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' },
  // Side by side with a strip of the natural slope between them (their falloffs never meet, so every
  // shelf stays level).
  stamps: [
    { ...FLIGHT, offset: { along: 0, across: -165 } },
    { ...FLIGHT, offset: { along: 30, across: 165 } },
  ],
  waters: [
    { ...PADDIES, stamp: 0 },
    { ...PADDIES, stamp: 1 },
  ],
  overlays: [{
    shape: { kind: 'disc', radius: [620, 760], falloff: 200 },
    palette: 'riceTerraces',
  }],
  engines: [
    // The morning mist in the steps (and the paddies' voice).
    {
      engine: 'weatherVolume',
      params: {
        form: 'bank', base: 2, length: 660, width: 620, height: 28, puffs: 90, detail: 0.2, tint: 0xf2f5f3, brightness: 1.05,
        billow: 0.25, hours: { dawn: 1, day: 0.1, dusk: 0.35, night: 0.5 },
        insideFog: { density: 3.5, color: 0xe6ebe8, darkness: 0 }, wind: { turbulence: 0.04 }, ownsAudio: true,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'marsh', params: { lap: 0.25, frogs: 0.7, insects: 0.5, trickle: 0.6 } },
  journal: {
    title: 'Rice Terraces',
    description: 'Flooded paddies stepping down a hillside, each one a mirror of the sky, with mist in the steps at dawn.',
  },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Terraced paddies {direction}, {distance} out. The water mirrors the sky.',
    'I see {name} on the hillside {direction}. Best seen low and slow, early in the morning.',
    'The {name} are about {eta} away, {direction}.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
