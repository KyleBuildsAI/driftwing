// Whale pod (Phase 2 preset 11): an ocean event, common near coasts.
//
// Three to six whales cruise at the surface, spouting, diving fluke-up and now and then breaching in
// full with a splash. Their wakes, spouts and splashes go into the water effects layer, so they glow
// in a bioluminescent bay. A candidate on a coast moves its pod to the nearest open water
// (pod.seekWater); the pod turns away from land on its own and fades out with its duration.
// No wind effect. Pure data (contract section 1).
export default Object.freeze({
  id: 'whalePod',
  name: 'Whale pod',
  category: 'ocean',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 5000, bucketSeconds: 300, chance: 0.5 },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 2500 },
    weather: null,
    surface: 'coast',
    minDistance: 3000,
    maxDistance: 8000,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'whale',
        behavior: 'pod',
        count: [3, 6],
        sizeJitter: 0.2,
        fadeIn: 4,
        fadeOut: 10,
        pod: {
          seekWater: 3000,
          spread: 55,
          breachChance: 0.35,
          surfaceSeconds: [14, 26],
          diveSeconds: [10, 20],
          spoutInterval: [3.5, 6.5],
          spoutHeight: 9,
          callInterval: [14, 32],
        },
      },
    },
  ],
  lod: { near: 2000, mid: 4500, far: 9000 },
  lure: null,
  wind: [],
  audio: { recipe: 'whale', params: {} },
  journal: { title: 'Whale pod', description: 'Whales rolling at the surface, spouting, and now and then a full breach.' },
  discovery: { radius: 1600, requireInView: true },
  callouts: [
    'Whales {direction}, {distance} out. Watch for the spouts.',
    'Pod of whales surfacing {distance} {direction}.',
    'Spouts on the water {direction}, about {eta} away.',
    'Whales breaching {distance} {direction}. Come down low and slow for a look.',
  ],
  lifetime: { duration: [240, 420], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
