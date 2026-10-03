// Preset 24: Comet (rare heavy event, one full night). A nucleus and coma with a curved dust tail
// pointing away from the sun and a straight blue ion tail, fixed among the stars (celestial engine,
// comet). It is a sky object, so it is sky-anchored: the spawn rides 1500 m from the camera toward the
// comet and stays at the NEAR tier, and the comet itself is the far silhouette, above the fog from
// anywhere. It lasts the rest of the night: untilDawn ends it as the morning sun climbs past -6
// degrees (lifetime.duration is the cap for a frozen night clock). Its comet lure only draws if the
// spawn ever reaches the FAR tier.
export default Object.freeze({
  id: 'comet',
  name: 'Comet',
  category: 'celestial',
  kind: 'event',
  rarity: 'rare',
  heavy: true,
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 1200, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['dusk', 'night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing', 'building']),
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
        fadeIn: 20,
        fadeOut: 25,
        untilDawn: true,
        dawnElevation: -6,
        comet: Object.freeze({
          tailLength: 30,
          tailWidth: 5,
          curvature: 0.35,
          headSize: 0.95,
          ionTail: 0.7,
          brightness: 1.3,
        }),
      }),
    }),
  ]),
  lod: Object.freeze({ near: 4000, mid: 12000, far: 40000 }),
  lure: Object.freeze({ type: 'comet', height: 2600, width: 9000, altitude: 6000, color: 0xfff0d2 }),
  wind: Object.freeze([]),
  audio: null,
  journal: Object.freeze({
    title: 'Comet',
    description: 'A visitor from the outer dark that hung among the stars all night, its dust tail streaming away from the hidden sun.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'There is a comet tonight, {direction}. Look for the tail.',
    'See that smudge with the tail, {direction}? That is a comet. It will be up all night.',
    'Comet {direction}. The tail always points away from the sun, even below the horizon.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([900, 1200]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
});
