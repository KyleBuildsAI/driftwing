// Preset 22: Meteor shower (event, night). Streaks fan out from a radiant fixed among the stars, with
// an occasional fireball that flashes the sky and the land (celestial engine, meteors). It belongs to
// the whole sky, so it is sky-anchored (the spawn rides 1500 m from the camera toward the radiant)
// and it is discovered as soon as it starts overhead. A dense night candidate grid makes it the
// night's "anywhere" common event for the director's pacing; it ends at dawn if the night does.
export default Object.freeze({
  id: 'meteorShower',
  name: 'Meteor shower',
  category: 'celestial',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: Object.freeze({ cellSize: 3500, bucketSeconds: 300, chance: 0.6 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'any',
    minDistance: 3000,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 8,
        fadeOut: 15,
        untilDawn: true,
        dawnElevation: -8,
        meteors: Object.freeze({
          rate: 40,
          fireballChance: 0.07,
          fireballFlash: 0.6,
          speed: 26,
          length: Object.freeze([6, 16]),
          spread: 60,
          maxActive: 40,
          brightness: 1.3,
        }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'meteor', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Meteor shower',
    description: 'Streaks of light raining from one point among the stars, and now and then a fireball bright enough to light the ground.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: false }),
  callouts: Object.freeze([
    'Look up. Meteor shower tonight, radiating from {direction}.',
    'Shooting stars all over the sky. Keep an eye out for a fireball.',
    'That is a proper {name}. Dim the panel lights and enjoy it.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([180, 300]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
