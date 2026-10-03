// Preset 6: Glory and full-circle rainbow (common day event). With the craft above a sea of cloud and
// the sun behind it, the craft's own shadow falls on the cloud tops ringed by the glory's coloured
// rings, inside a full-circle rainbow at 42 degrees. The celestial entry keeps the spawn at the
// antisolar point (a sky anchor), so the glory follows the player; the weatherVolume sheet lays the
// cloud sea under the flight path. Docs: docs/engines/celestial.md, weatherVolume.md.
export default Object.freeze({
  id: 'glory',
  name: 'Glory',
  category: 'weather',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 5000, bucketSeconds: 600, chance: 0.45 },
  filters: {
    biomes: ['meadows', 'pine', 'dunes', 'archipelago'],
    timeOfDay: ['day'],
    altitude: { min: 1150, max: 6000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'any',
    minDistance: 1500,
    maxDistance: 6000,
  },
  engines: [
    {
      engine: 'celestial',
      params: { anchor: 'sky', anchorDistance: 1500, fadeIn: 10, fadeOut: 14, glory: { strength: 1.1, bow: 0.8, minSunElevation: 4, maxSunElevation: 62 } },
    },
    {
      engine: 'weatherVolume',
      params: {
        form: 'sheet', baseMode: 'msl', base: 700, radius: 7000, thickness: 170, puffs: 420, brightness: 1.08, billow: 0.12,
        wind: { turbulence: 0.08 },
        formSeconds: 30,
        dissipateSeconds: 40,
      },
    },
  ],
  lod: { near: 2500, mid: 9000, far: 30000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Glory', description: 'Your own shadow on the clouds, ringed by a glory inside a full-circle rainbow.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Cloud sea below us. Put the sun behind you and look down for the glory.',
    'Look down {direction}: our shadow on the clouds has a rainbow ring around it.',
    'A {name} on the cloud tops. Fly away from the sun to see the full circle.',
  ],
  lifetime: { duration: [300, 480], despawn: { distance: 12000, hysteresis: 3000, outOfViewSeconds: 30 } },
});
