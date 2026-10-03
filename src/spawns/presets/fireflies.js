// Fireflies (Phase 2 preset 17): a common night event over meadows.
//
// Thousands of soft yellow-green lights drift and blink a few metres over the ground (lightEffect
// swarm, partly in step), with a sparser, wider and higher scatter of slower blinkers around them
// for depth. Everything is emissive points in the shared glow pool (one draw call, bloom picks them
// up) with no real light; they only show at night and fade out with the event. Silent, no wind
// effect. Fly low over the meadow to see them. Pure data (contract section 1).
export default Object.freeze({
  id: 'fireflies',
  name: 'Fireflies',
  category: 'wildlife',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 4000, bucketSeconds: 300, chance: 0.55 },
  filters: {
    biomes: ['meadows', 'archipelago'],
    timeOfDay: ['night'],
    altitude: { min: 0, max: 1500 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 7000,
  },
  engines: [
    {
      engine: 'lightEffect',
      params: {
        swarm: {
          count: 3600,
          radius: 190,
          height: [0.5, 5],
          size: [0.8, 1.4],
          colors: [0xd8ff6a, 0xfff08a, 0xb8ff8a],
          intensity: 5,
          blink: { period: [2, 4.5], duty: 0.3 },
          sync: 0.35,
          wander: { radius: 1.8, speed: 0.35, vertical: 0.5 },
        },
        glows: [
          {
            layout: 'scatter',
            count: 700,
            radius: 360,
            onGround: true,
            height: [1, 9],
            size: [1, 1.7],
            colors: [0xe4ff7a, 0xc8ff90],
            intensity: 4,
            blink: { period: [3, 6.5], duty: 0.25 },
            wander: { radius: 3, speed: 0.22, vertical: 0.4 },
            shape: 'firefly',
          },
        ],
        visibility: { day: 0, night: 1 },
        lod: { near: 1, mid: 1, far: 0.7 },
        endRamp: 8,
      },
    },
  ],
  lod: { near: 1200, mid: 3000, far: 6000 },
  lure: null,
  wind: [],
  audio: null,
  journal: { title: 'Fireflies', description: 'A meadow full of drifting, blinking lights on a warm night.' },
  discovery: { radius: 1000, requireInView: true },
  callouts: [
    'Lights over the meadow {direction}, {distance} out. Fireflies.',
    'Fireflies {direction}. Come down low to see them, {distance}.',
    'A swarm of fireflies about {eta} away, {direction}.',
    'Something is glittering in the grass {direction}. {distance}.',
  ],
  lifetime: { duration: [240, 400], despawn: { distance: 8000, hysteresis: 2000, outOfViewSeconds: 20 } },
});
