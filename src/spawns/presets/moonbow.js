// Preset 65: Moonbow (uncommon event). On a clear night under the bright moon, a pale, nearly white
// rainbow stands in the spray of a mega-waterfall (preset 10), with a little silver colour at its
// edges and a faint secondary bow, while an extra veil of moonlit mist rises from the plunge pool.
// filters.near moves each candidate onto the nearest placed mega-waterfall within 15 km, facing the
// way the falls do (no waterfall in reach, no moonbow); the bow needs the moon up and behind the
// viewer, so it is seen looking at the falls with the moon at your back. A soft night shimmer goes
// with it (the falls keep their own roar). Docs: docs/engines/celestial.md (rainbow, light 'moon'),
// emitter.md.
export default Object.freeze({
  id: 'moonbow',
  name: 'Moonbow',
  category: 'celestial',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'water', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 6000, bucketSeconds: 900, chance: 0.6 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['night']),
    altitude: Object.freeze({ min: 0, max: 5000 }),
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'any',
    minDistance: 1500,
    maxDistance: 12000,
    near: Object.freeze({ sites: Object.freeze(['megaWaterfall']), radius: 15000 }),
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        fadeIn: 12,
        fadeOut: 15,
        rainbow: Object.freeze({ radius: 240, height: -70, offset: Object.freeze([0, 75]), strength: 1.7, secondary: 0.3, light: 'moon' }),
      }),
    }),
    Object.freeze({
      engine: 'emitter',
      params: Object.freeze({
        particles: 3000, hugGround: true, offset: Object.freeze([0, 3, 75]), shape: Object.freeze({ type: 'box', size: Object.freeze([170, 14, 70]) }), speed: Object.freeze([2, 7]), spread: 60,
        gravity: 0, buoyancy: 1.2, buoyancyDecay: 25, drag: 0.6, turbulence: Object.freeze({ spread: 3, wobble: 4, frequency: 0.1 }), life: Object.freeze([10, 18]),
        size: Object.freeze([14, 60]), sizeCurve: 0.7, colors: Object.freeze([0xdfe8f4, 0xd2deee, 0xe8eef6]), opacity: 0.22, fog: 0.6, sound: false,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1800, mid: 6000, far: 16000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'skyShimmer', params: Object.freeze({ baseHz: 392, brightness: 0.55, refDistance: 400 }) }),
  journal: Object.freeze({
    title: 'Moonbow',
    description: 'A pale rainbow made of moonlight, standing in the spray of a great waterfall at night.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'The moon is bright enough for a moonbow at the waterfall {direction}. Keep the moon behind you.',
    'There is a moonbow in the falls {direction}, {distance} out. It looks almost white.',
    'Moonbow {direction}: a rainbow by moonlight. Approach with the moon at your back.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([480, 720]), despawn: Object.freeze({ distance: 16000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
