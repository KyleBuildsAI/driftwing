// Preset 80: Kite-string slalom (uncommon site, daytime, challenge). Kites fly from a hilltop, their
// strings rising steeply downwind from stakes along the summit. The strings are the poles of a slalom
// over the hill: each gate stands to one side of a string, so the run weaves left and right of them.
// The strings are thin sensors: brushing one counts as a miss (a two-second penalty), never a crash.
// Kites, tails and streamers flutter in the wind. Docs: docs/engines/structure.md (recipe
// kiteSlalom), the challenge block in src/gameplay/challenges.js.
export default Object.freeze({
  id: 'kiteSlalom',
  name: 'Kite-string slalom',
  category: 'flightplay',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['challenge', 'spectacle']),
  placement: Object.freeze({
    chance: 0.08,
    minSpacing: 22000,
    // Rolling country: a grassy or sandy hilltop, not a crag beside a taller mountain.
    biomes: Object.freeze(['meadows', 'dunes']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 60, maxHeight: 600, relief: 'peak' }),
    clearance: 300,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: Object.freeze(['dawn', 'day', 'golden']), altitude: null, weather: null }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'kiteSlalom', lineHeight: Object.freeze([110, 165]), lean: 12, offset: 12, extra: 4, streamers: true, kiteSize: Object.freeze([2.6, 3.6]),
        sensorRadius: 0.35, voice: true, audioIntensity: 'approach',
      }),
    }),
  ]),
  // The slalom over the summit, in the site frame: the checkpoints alternate right and left of the
  // line, each beside its kite's string (the recipe stakes it toward the line, past the inner edge).
  challenge: Object.freeze({
    name: 'Kite-String Slalom',
    gates: Object.freeze([
      Object.freeze({ id: 'start', role: 'start', along: -420, across: 0, height: 28, shape: 'rect', halfWidth: 20, halfHeight: 14 }),
      Object.freeze({ id: 'k1', role: 'checkpoint', along: -280, across: 26, height: 26, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'k2', role: 'checkpoint', along: -160, across: -26, height: 28, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'k3', role: 'checkpoint', along: -40, across: 26, height: 30, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'k4', role: 'checkpoint', along: 80, across: -26, height: 30, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'k5', role: 'checkpoint', along: 200, across: 26, height: 28, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'k6', role: 'checkpoint', along: 320, across: -26, height: 26, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'finish', role: 'finish', along: 440, across: 0, height: 28, shape: 'rect', halfWidth: 20, halfHeight: 14 }),
    ]),
    medals: Object.freeze({ gold: 26, silver: 35, bronze: 50 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 120 }),
    sensors: Object.freeze({ kiteString: Object.freeze({ penaltySeconds: 2 }) }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1400 }),
    abandonDistance: 3000,
    teleportDistance: 400,
    record: true,
  }),
  lod: Object.freeze({ near: 1800, mid: 5000, far: 12000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'windRush', params: Object.freeze({ flutter: 1, gust: 0.5, refDistance: 140 }) }),
  journal: Object.freeze({
    title: 'Kite-string slalom',
    description: 'Kites flying from a hilltop, their strings the poles of a slalom. Touch one and it costs you.',
  }),
  discovery: Object.freeze({ radius: 2500, requireInView: true }),
  callouts: Object.freeze([
    'Kites over the hill {direction}, {distance} out. Their strings make a slalom.',
    'Kite-string slalom {direction}. Weave past each string; brushing one costs two seconds.',
    'The {name} is about {eta} away, {direction}. Start low over the summit.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 12000, hysteresis: 2500, outOfViewSeconds: 20 }) }),
});
