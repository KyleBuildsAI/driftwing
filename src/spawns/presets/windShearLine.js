// Preset 74: Wind shear line (uncommon event; affects flight). A long, ruler-straight cloud edge
// stands across the sky, its leading side a sharp wall. Underneath it two air masses meet: cross the
// line and within a hundred metres the wind swings round by forty-five degrees or more and nearly doubles,
// with a band of chop right at the edge. The activation turns downwind; the new air mass blows across
// the prevailing wind, square to the line. Docs: docs/engines/weatherVolume.md (turn, wall), windModifier.md (gustFront).
export default Object.freeze({
  id: 'windShearLine',
  name: 'Wind shear line',
  category: 'weather',
  kind: 'event',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['spectacle']),
  candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 600, chance: 0.4 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day', 'dawn', 'dusk']),
    altitude: Object.freeze({ min: 0, max: 6000 }),
    weather: Object.freeze(['clear', 'building', 'clearing']),
    surface: 'any',
    minDistance: 3500,
    maxDistance: 9000,
  }),
  anchor: Object.freeze({ align: 'downwind' }),
  engines: Object.freeze([
    // The cloud line: a long elevated bank with a tall, sharp leading wall over the shear.
    Object.freeze({
      engine: 'weatherVolume',
      params: Object.freeze({
        form: 'bank', turn: 90, base: 650, baseMode: 'agl', followTerrain: false, length: 14000, width: 1100, height: 420, wall: 0.7,
        puffs: 240, detail: 0.25, storm: 0.22, tint: 0xe9edf1, brightness: 1, billow: 0.12, formSeconds: 40, dissipateSeconds: 45,
        haze: Object.freeze({ near: 3000, far: 40000, max: 0.88 }),
        insideFog: Object.freeze({ density: 4, color: 0xd9dee4, darkness: 0.08 }),
        wind: Object.freeze({ turbulence: 0.25 }),
        ownsAudio: true,
      }),
    }),
    // The shear: a straight front along the cloud's leading edge, the new air mass behind it.
    Object.freeze({
      engine: 'windModifier',
      params: Object.freeze({
        type: 'gustFront', turn: 90, offset: Object.freeze([550, 0, 0]), length: 14000, frontWidth: 140, depth: 9000, outflow: 16, outflowTop: 2600,
        lift: 1.5, liftTop: 1800, turbulence: 0.55, gust: 4, fadeIn: 20,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 6000, mid: 16000, far: 40000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'windRush', params: Object.freeze({ gust: 0.9, refDistance: 600 }) }),
  journal: Object.freeze({
    title: 'Wind shear line',
    description: 'A razor-straight cloud edge where the wind swings round and doubles in a few hundred metres.',
  }),
  discovery: Object.freeze({ radius: 7000, requireInView: true }),
  callouts: Object.freeze([
    'Straight cloud edge {direction}, {distance} out. That is a shear line: expect the wind to change.',
    'Shear line {direction}. Hold your airspeed as you cross, the wind swings round under it.',
    'The {name} is about {eta} away, {direction}. A bump at the edge, then new wind.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([480, 660]), despawn: Object.freeze({ distance: 25000, hysteresis: 4000, outOfViewSeconds: 30 }) }),
});
