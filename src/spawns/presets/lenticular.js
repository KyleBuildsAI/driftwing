// Preset 4: Lenticular clouds (common event; affects flight). A stack of smooth lens clouds parked
// over a peak in the prevailing wind: the activation seeks the highest ground nearby and turns
// downwind (preset.anchor). The air is a lee wave train: smooth lift upwind of each crest and gentle
// sink downwind, with rotor turbulence and reversed flow in the layer beneath the crests. A glider
// can climb kilometres in the wave. Docs: docs/engines/weatherVolume.md, windModifier.md.
export default Object.freeze({
  id: 'lenticular',
  name: 'Lenticular clouds',
  category: 'weather',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 4500, bucketSeconds: 480, chance: 0.5 },
  filters: {
    biomes: ['snow', 'pine', 'meadows', 'dunes'],
    timeOfDay: null,
    altitude: { min: 0, max: 8000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 9000,
  },
  anchor: { seek: 'peak', radius: 2500, align: 'downwind' },
  engines: [
    {
      engine: 'weatherVolume',
      params: {
        form: 'lens', base: 1150, radius: 2000, aspect: 0.45, layers: 4, gap: 150, thickness: 170, puffs: 18,
        brightness: 1.05, billow: 0.08,
        wind: { turbulence: 0.04, wave: { lift: 3, sink: 2, rotor: 0.55 } },
        formSeconds: 60,
        dissipateSeconds: 60,
      },
    },
    {
      engine: 'windModifier',
      params: {
        type: 'waveLift', direction: 'heading', wavelength: 6500, amplitude: 2.8, crests: 3, startOffset: 2600, width: 9000,
        base: 250, top: 5200, rotorTop: 900, rotorTurbulence: 0.8, rotorReverse: 5, smoothTurbulence: 0.04, gust: 4, fadeIn: 30,
      },
    },
  ],
  lod: { near: 4000, mid: 14000, far: 40000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Lenticular clouds', description: 'Smooth lens clouds stacked over a peak, riding a standing wave of air.' },
  discovery: { radius: 9000, requireInView: true },
  callouts: [
    'Lenticular clouds over the peak {direction}, {distance} out. There is wave lift there.',
    'Lens clouds {direction}. Climb on the upwind side of the stack, stay out of the rotor below.',
    '{name} {distance} {direction}, about {eta} away. Smooth lift if you ride the wave.',
  ],
  lifetime: { duration: [600, 900], despawn: { distance: 20000, hysteresis: 4000, outOfViewSeconds: 30 } },
});
