// Preset 79: Balloon festival (uncommon site, daytime, challenge). Thirty tethered hot-air balloons of
// the v1 family float over a flat field at different heights, burners roaring by turns. Pairs of them
// frame the gates of a weave course that zigzags across the field: fly the start pair and the clock
// runs, splits at every pair, a medal at the finish. Every envelope, basket and tether is solid. The
// festival is there from dawn to golden hour. Docs: docs/engines/structure.md (recipe balloonCourse),
// the challenge block in src/gameplay/challenges.js.
export default Object.freeze({
  id: 'balloonFestival',
  name: 'Balloon festival',
  category: 'flightplay',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  tags: Object.freeze(['challenge', 'spectacle', 'calm', 'slow']),
  placement: Object.freeze({
    chance: 0.07,
    minSpacing: 22000,
    biomes: Object.freeze(['meadows', 'pine', 'dunes']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 10, maxHeight: 700, relief: 'flat' }),
    clearance: 500,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: Object.freeze(['dawn', 'day', 'golden']), altitude: null, weather: null }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({ recipe: 'balloonCourse', count: 30, height: Object.freeze([19, 24]), tethers: true, spread: 300, gap: 3, voice: true, audioIntensity: 'approach' }),
    }),
  ]),
  // The weave across the field, in the site frame; each gate is framed by two balloons.
  challenge: Object.freeze({
    name: 'Balloon Festival',
    gates: Object.freeze([
      Object.freeze({ id: 'start', role: 'start', along: -700, across: 0, height: 45, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
      Object.freeze({ id: 'b1', role: 'checkpoint', along: -480, across: 60, height: 70, heading: 15, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'b2', role: 'checkpoint', along: -260, across: -60, height: 55, heading: -25, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'b3', role: 'checkpoint', along: -40, across: 70, height: 85, heading: 25, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'b4', role: 'checkpoint', along: 180, across: -60, height: 60, heading: -25, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'b5', role: 'checkpoint', along: 400, across: 60, height: 75, heading: 25, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'b6', role: 'checkpoint', along: 610, across: -40, height: 50, heading: -20, shape: 'rect', halfWidth: 14, halfHeight: 12 }),
      Object.freeze({ id: 'finish', role: 'finish', along: 820, across: 0, height: 45, heading: 10, shape: 'rect', halfWidth: 15, halfHeight: 12 }),
    ]),
    medals: Object.freeze({ gold: 40, silver: 55, bronze: 80 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5, outsideCrossing: 'miss', skipDistance: 150 }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1500 }),
    abandonDistance: 3500,
    teleportDistance: 400,
    record: true,
  }),
  lod: Object.freeze({ near: 2000, mid: 6000, far: 14000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'burner', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Balloon festival',
    description: 'Dozens of tethered balloons over a morning field, set out as a weave course against the clock.',
  }),
  discovery: Object.freeze({ radius: 3000, requireInView: true }),
  callouts: Object.freeze([
    'Balloons {direction}, {distance} out. A whole festival of them, and a weave course.',
    'Balloon festival {direction}. Fly between each pair; the tethers are solid, mind them.',
    'The {name} is about {eta} away, {direction}. Start between the first pair.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 14000, hysteresis: 2500, outOfViewSeconds: 20 }) }),
});
