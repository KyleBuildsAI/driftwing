// Preset 70: Dragon racer (rare site, a challenge). On a peak stands a basalt crag, and on the crag a
// wild dragon, wings folded, watching. Below it a course of stone gates winds 2.6 km down the
// mountain. Fly through the start gate (or press Y nearby) and the dragon launches from its crag and
// races you through every gate to the finish (the challenge system: start prompt, splits, medals,
// bests per craft). Flying anything else, it leads you round on the gold line; fly the dragon yourself
// and it becomes your rival: it roars and breathes fire as it launches, the timer shows the gap to it,
// and beating it to the finish earns "Out-flew the wild dragon". Its wingbeats follow it round the
// course. Docs: docs/engines/structure.md (recipe dragonRace, rival), src/gameplay/challenges.js.
export default Object.freeze({
  id: 'dragonRacer',
  name: 'Dragon racer',
  category: 'fantasy',
  kind: 'site',
  rarity: 'rare',
  heavy: false,
  tags: Object.freeze(['challenge', 'spectacle', 'perch']),
  placement: Object.freeze({
    chance: 0.1,
    minSpacing: 30000,
    biomes: Object.freeze(['pine', 'meadows', 'snow', 'dunes']),
    surface: 'land',
    terrain: Object.freeze({ minHeight: 120, maxHeight: 1400, relief: 'peak' }),
    clearance: 400,
    align: 'random',
  }),
  filters: Object.freeze({ biomes: null, timeOfDay: null, altitude: null, weather: null, surface: 'land' }),
  stamps: Object.freeze([]),
  challenge: Object.freeze({
    name: 'Dragon Race',
    gates: Object.freeze([
      Object.freeze({ role: 'start', along: 140, height: 32, pitch: -8, shape: 'rect', halfWidth: 26, halfHeight: 18 }),
      Object.freeze({ role: 'checkpoint', along: 600, across: 180, height: 40, heading: 20, shape: 'circle', radius: 24 }),
      Object.freeze({ role: 'checkpoint', along: 1100, across: 420, height: 36, heading: 10, shape: 'circle', radius: 24 }),
      Object.freeze({ role: 'checkpoint', along: 1550, across: 260, height: 32, heading: -35, shape: 'circle', radius: 22 }),
      Object.freeze({ role: 'checkpoint', along: 1950, across: -100, height: 40, heading: -50, shape: 'circle', radius: 22 }),
      Object.freeze({ role: 'finish', along: 2400, across: -260, height: 36, heading: -20, shape: 'rect', halfWidth: 30, halfHeight: 20 }),
    ]),
    medals: Object.freeze({ gold: 70, silver: 95, bronze: 130 }),
    missed: Object.freeze({ mode: 'penalty', penaltySeconds: 5 }),
    start: Object.freeze({ mode: 'gate', promptRadius: 1200 }),
    abandonDistance: 3500,
  }),
  engines: Object.freeze([
    Object.freeze({
      engine: 'structure',
      params: Object.freeze({
        recipe: 'dragonRace',
        style: 'stone',
        paceTime: 70,
        rivalTime: 84,
        achievement: Object.freeze({ id: 'dragonRival', title: 'Out-flew the wild dragon' }),
        voice: true,
        audioIntensity: 'approach',
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 8000, far: 16000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'dragon', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Dragon racer',
    description: 'A wild dragon on a crag above a gate course. It races anyone who starts, and a dragon most of all.',
  }),
  discovery: Object.freeze({ radius: 3500, requireInView: true }),
  callouts: Object.freeze([
    'There is a dragon on that crag {direction}, {distance} out. It races anyone who takes its course.',
    'Dragon race {direction}, about {eta} away. Fly the start gate and it will launch after you.',
    'The {name} course is {direction}. If you are flying the dragon, that one will take it personally.',
  ]),
  lifetime: Object.freeze({ duration: null, despawn: Object.freeze({ distance: 16000, hysteresis: 2500, outOfViewSeconds: 30 }) }),
  achievements: Object.freeze([
    Object.freeze({ id: 'dragonRival', title: 'Out-flew the wild dragon', description: 'Beat the wild dragon to the finish of its race, flying a dragon yourself.' }),
  ]),
});
