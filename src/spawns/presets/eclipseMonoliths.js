// Preset 95: Eclipse over the monolith circle (legendary combo, day, at a stone circle). The Phase 2
// total solar eclipse comes over one of the world's monolith circles (the v1-derived landmark in V2):
// the combo's near precondition moves the candidate onto the nearest circle within 6 km, the eclipse is
// its anchor member (contract i.3), and as the light fails a ring of pale gold lights kindles among the
// standing stones with a glow on the altar (lightEffect glows on a ring the size of the circle,
// breathing, read brightest through totality) while the stones hum a low drone that swells as you
// close in (crystal voice tuned down to E2, the approach driving it). The eclipse silences the birds.
// Docs: docs/engines/celestial.md, lightEffect.md.
export default Object.freeze({
  id: 'eclipseMonoliths',
  name: 'Eclipse over the monoliths',
  category: 'celestial',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['celestial', 'calm', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.45 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['day']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing']),
    surface: 'land',
    minDistance: 1500,
    maxDistance: 8000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        glows: Object.freeze([
          Object.freeze({
            layout: 'ring',
            count: 13,
            radius: 34,
            onGround: true,
            height: Object.freeze([4.5, 6]),
            size: Object.freeze([7, 10]),
            colors: Object.freeze([0xffe6b0, 0xfff1d0]),
            intensity: 5,
            pulse: Object.freeze({ period: 7, depth: 0.45 }),
            shape: 'orb',
          }),
          Object.freeze({
            layout: 'point',
            count: 1,
            offset: Object.freeze([0, 2.5, 0]),
            onGround: true,
            size: Object.freeze([16, 16]),
            colors: Object.freeze([0xfff4dc]),
            intensity: 4,
            pulse: Object.freeze({ period: 7, depth: 0.3 }),
            shape: 'flare',
          }),
        ]),
        visibility: Object.freeze({ day: 0.75, night: 1 }),
        fog: 0.5,
        soundIntensity: 'approach',
        sound: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 1500, mid: 4000, far: 12000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'crystal', params: Object.freeze({ baseHz: 82.4, rangeSemitones: 7, refDistance: 90 }) }),
  journal: Object.freeze({
    title: 'Eclipse over the monoliths',
    description: 'The moon swallowed the sun over a circle of standing stones, and a ring of pale lights woke among the stones as the day went dark.',
  }),
  discovery: Object.freeze({ radius: 4000, requireInView: false }),
  callouts: Object.freeze([
    'The light is going strange over the stone circle {direction}. The moon is crossing the sun.',
    'Eclipse coming, right over the monoliths {distance} {direction}. Get there for totality.',
    'The {name} is about {eta} away. Watch the stones as it goes dark.',
    'Hear that hum from the circle? The stones are lighting up as the sun goes.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([160, 180]), despawn: Object.freeze({ distance: 20000, hysteresis: 3000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({
      timeOfDay: Object.freeze(['day']),
      weather: Object.freeze(['clear', 'clearing']),
      near: Object.freeze({ landmarks: Object.freeze(['monoliths']), radius: 6000 }),
    }),
    members: Object.freeze([Object.freeze({ presetId: 'totalSolarEclipse', role: 'anchor' })]),
    exclusive: true,
  }),
});
