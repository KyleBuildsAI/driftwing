// Preset 100: Lighthouse beacons (legendary combo, dusk or night, at a lighthouse). The v1-derived
// lighthouse nearest the candidate fires its beacon: a bright beam swings up into the sky above its
// lantern and a flare blazes in the lamp room, and then every lighthouse within sight (18 km) answers
// in turn, a flare blazing in each lantern one after another outward along the coast, nearest first,
// the chain running round again every 36 s (lightEffect: a beam, a lamp light, and a glow group on the
// world's lighthouse landmarks blinking in a chain). Each answer sounds a foghorn, louder for the near
// ones and each a different note (foghorn voice, its horn triggered as each flare lights, over the wash
// of the sea). Combo scheduling (contract i.3): its preconditions move the candidate onto the nearest
// lighthouse within 8 km at dusk or night; it brings no member, the landmarks are the event.
// Docs: docs/engines/lightEffect.md.
export default Object.freeze({
  id: 'lighthouseBeacons',
  name: 'Lighthouse beacons',
  category: 'structure',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['coast', 'night', 'spectacle']),
  candidates: Object.freeze({ cellSize: 7000, bucketSeconds: 900, chance: 0.5 }),
  filters: Object.freeze({
    biomes: null,
    timeOfDay: Object.freeze(['dusk', 'night']),
    altitude: null,
    weather: Object.freeze(['clear', 'clearing', 'building']),
    surface: 'any',
    minDistance: 2000,
    maxDistance: 12000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        beam: Object.freeze({ offset: Object.freeze([0, 37, 0]), count: 1, length: 4000, width: Object.freeze([3, 150]), color: 0xfff2d0, intensity: 2.4, period: 8, tilt: 58, night: 0.8 }),
        glows: Object.freeze([
          Object.freeze({
            layout: 'landmarks',
            landmark: 'lighthouse',
            radius: 18000,
            count: 10,
            offset: Object.freeze([0, 37, 0]),
            size: Object.freeze([70, 90]),
            colors: Object.freeze([0xfff0c8, 0xffe6b4]),
            intensity: 14,
            shape: 'flare',
            chain: Object.freeze({ interval: 2.8, period: 36, duty: 0.14, delay: 2, trigger: 'horn' }),
          }),
        ]),
        light: Object.freeze({ color: 0xfff0d0, intensity: 3e5, range: 1500, offset: Object.freeze([0, 37, 0]), night: 0.8 }),
        visibility: Object.freeze({ day: 0.3, night: 1 }),
        fog: 0.4,
        lod: Object.freeze({ near: 1, mid: 1, far: 1 }),
        sound: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 10000, far: 30000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'foghorn', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Lighthouse beacons',
    description: 'A lighthouse fired its beacon into the night and every lighthouse in sight answered, one after another down the coast, horns calling.',
  }),
  discovery: Object.freeze({ radius: 6000, requireInView: true }),
  callouts: Object.freeze([
    'The lighthouse {direction} just fired its beacon. Watch the coast.',
    'There, and there: every lighthouse in sight is answering, one after another.',
    'Hear the horns? The {name} are calling down the coast, {distance} {direction}.',
    'The light runs from lighthouse to lighthouse, {direction}. Count them as they answer.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([240, 360]), despawn: Object.freeze({ distance: 30000, hysteresis: 4000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({
      timeOfDay: Object.freeze(['dusk', 'night']),
      near: Object.freeze({ landmarks: Object.freeze(['lighthouse']), radius: 8000 }),
    }),
    members: Object.freeze([]),
    exclusive: true,
  }),
});
