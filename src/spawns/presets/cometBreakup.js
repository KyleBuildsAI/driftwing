// Preset 96: Comet breakup (legendary combo, night, over the ocean). A bright comet hangs low over the
// sea ahead (celestial comet aimed along the activation heading, 16 degrees up); some 25 s later its
// nucleus flares and splits, and five to seven fragments drift apart along its orbit, each trailing a
// short tail of its own, while debris streaks away from it across the sky, now and then a fireball
// (celestial comet breakup, meteors fromComet: the stream starts at the split). Combo scheduling
// (contract i.3): its preconditions want a clear night and its filters open water; it brings no member,
// the comet and its debris are the event, and nothing else legendary may run with it. The debris
// sizzles and booms (meteor voice). Docs: docs/engines/celestial.md.
export default Object.freeze({
  id: 'cometBreakup',
  name: 'Comet breakup',
  category: 'celestial',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['celestial', 'night', 'water', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'water',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 15,
        fadeOut: 25,
        comet: Object.freeze({
          aim: 'heading',
          position: Object.freeze({ azimuth: 0, elevation: 16 }),
          tailLength: 30,
          tailWidth: 5,
          curvature: 0.4,
          headSize: 1.1,
          ionTail: 0.75,
          brightness: 1.4,
          breakup: Object.freeze({ start: 25, fragments: Object.freeze([5, 7]), stagger: 7, drift: 0.06, spread: 0.9, flare: 2.8, remain: 0.5 }),
        }),
        meteors: Object.freeze({
          fromComet: true,
          rate: 30,
          fireballChance: 0.14,
          fireballFlash: 0.5,
          speed: 18,
          length: Object.freeze([8, 20]),
          spread: 38,
          maxActive: 32,
          brightness: 1.4,
          color: 0xfff2d8,
          trail: 0xffb46e,
        }),
        ownsAudio: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'meteor', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Comet breakup',
    description: 'A comet low over the sea flared and broke apart, its fragments drifting away on their own tails while the debris streaked across the night.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Comet low over the sea, {direction}. Keep watching it.',
    'It is breaking up. See the pieces drifting apart {direction}? Each one has its own tail.',
    'The {name} is shedding debris all over the sky. Watch for fireballs.',
    'A comet coming apart over the ocean, {direction}. Nobody will believe us.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([360, 480]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({ timeOfDay: Object.freeze(['night']), weather: Object.freeze(['clear', 'clearing']) }),
    members: Object.freeze([]),
    exclusive: true,
  }),
});
