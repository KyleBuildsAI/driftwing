// Preset 47: Tidal bore (uncommon site). A broad estuary is carved below sea level into a low coast
// (the estuary stamp: a channel 1.6-2.2 km long, wide at its mouth and narrowing inland between mud
// levees, painted mud). Every minute or two the incoming tide piles up into a bore: a wave front
// that spans the channel at the mouth and surges inland up it at 8 m/s, growing as the channel
// narrows, foaming and throwing spray off its crest (waterEffect wave in estuary mode, repeating; the
// water query lifts the surface with it, so a seaplane in the channel rides it). The surf recipe
// churns along the front, with a big breaker as it rises. No wind effect. Docs:
// docs/engines/waterEffect.md (wave, estuary).
export default Object.freeze({
  id: 'tidalBore',
  name: 'Tidal bore',
  category: 'ocean',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['water', 'coast', 'spectacle']),
  placement: Object.freeze({
    chance: 0.6,
    minSpacing: 18000,
    biomes: null,
    surface: 'coast',
    terrain: Object.freeze({ maxHeight: 10, relief: 'any' }),
    clearance: 300,
    align: 'downhill',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'coast' }),
  stamps: Object.freeze([
    Object.freeze({
      type: 'estuary',
      length: Object.freeze([1600, 2200]),
      mouthWidth: Object.freeze([260, 380]),
      headWidth: Object.freeze([45, 70]),
      depth: Object.freeze([3.5, 5.5]),
      bank: Object.freeze([5, 8]),
      bankWidth: Object.freeze([40, 70]),
      falloff: Object.freeze([120, 180]),
      paint: 'mud',
    }),
  ]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'waterEffect',
      params: Object.freeze({
        effect: 'wave',
        mode: 'front',
        estuary: true,
        height: 2.4,
        width: 18,
        lean: 0.65,
        growth: 1.5,
        speed: 8,
        interval: Object.freeze([45, 90]),
        spray: 140,
        sprayHeight: 4,
        foam: 1,
        voice: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 2000, mid: 5000, far: 11000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'surf', params: Object.freeze({ refDistance: 150 }) }),
  journal: Object.freeze({
    title: 'Tidal bore',
    description: 'A muddy estuary where the incoming tide rears up into a single breaking wave and surges inland up the channel.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Estuary {direction}, {distance} out. The tide comes up it as a bore every minute or two.',
    'A wave running up the river {distance} {direction}. That is a tidal bore.',
    'The {name} is about {eta} away, {direction}. Fly up the channel with the front.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 11000, hysteresis: 2000, outOfViewSeconds: 20 }) }),
});
