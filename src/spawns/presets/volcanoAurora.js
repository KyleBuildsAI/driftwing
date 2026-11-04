// Preset 93: Volcano, lightning and aurora (legendary combo, night, at a volcano in the snow). When a
// volcano standing in the snow country erupts at night, its ash plume turns into a dirty thunderstorm,
// lightning crawling and forking through the ash (lightEffect lightning high in the column, thunder
// rolling in after it), while the aurora flares overhead (celestial sky component: the curtains at
// full wherever the sky is dark). Combo scheduling (contract i.3): its preconditions move the
// candidate onto the volcano site and need its eruption (siteActive), the night and the snow there; it
// brings no member preset, the volcano's own eruption and these two parts are the event. The aurora
// shimmers over the volcano's rumble (aurora). Docs: docs/engines/lightEffect.md, celestial.md.
export default Object.freeze({
  id: 'volcanoAurora',
  name: 'Volcano, lightning and aurora',
  category: 'geo',
  kind: 'event',
  rarity: 'legendary',
  heavy: false,
  tags: Object.freeze(['snow', 'night', 'spectacle']),
  candidates: Object.freeze({ cellSize: 9000, bucketSeconds: 600, chance: 0.6 }),
  filters: Object.freeze({
    biomes: Object.freeze(['snow']),
    timeOfDay: Object.freeze(['night']),
    altitude: Object.freeze({ min: 0, max: 9000 }),
    weather: Object.freeze(['clear', 'clearing', 'building']),
    surface: 'land',
    minDistance: 3000,
    maxDistance: 30000,
  }),
  stamps: Object.freeze([]),
  engines: Object.freeze([
    Object.freeze({
      engine: 'lightEffect',
      params: Object.freeze({
        lightning: Object.freeze({
          rate: 24,
          radius: 650,
          cloudBase: 2300,
          groundShare: 0.3,
          color: 0xe6d6ff,
          width: 3,
          brightness: 7,
          branches: 7,
          flash: 0.55,
          cloudGlow: Object.freeze({ radius: 1300, intensity: 1.6, color: 0xffb28a }),
          light: Object.freeze({ intensity: 2e7, range: 8000, priority: 3 }),
          thunder: 0.9,
          minCameraDistance: 600,
        }),
        visibility: Object.freeze({ day: 1, night: 1 }),
        sound: false,
      }),
    }),
    Object.freeze({
      engine: 'celestial',
      params: Object.freeze({
        anchor: 'sky',
        fadeIn: 25,
        fadeOut: 25,
        sky: Object.freeze({ aurora: 1, stars: 0.9, when: 'night' }),
        ownsAudio: true,
      }),
    }),
  ]),
  lod: Object.freeze({ near: 3000, mid: 12000, far: 45000 }),
  lure: null,
  wind: Object.freeze([]),
  audio: Object.freeze({ recipe: 'aurora', params: Object.freeze({}) }),
  journal: Object.freeze({
    title: 'Volcano, lightning and aurora',
    description: 'A volcano erupting at the edge of the snow, lightning crawling through its ash plume while the aurora burned overhead.',
  }),
  discovery: Object.freeze({ radius: 12000, requireInView: true }),
  callouts: Object.freeze([
    'Look {direction}. The volcano is erupting, there is lightning in the ash, and the aurora is up over all of it.',
    'Fire, lightning and the northern lights, {distance} {direction}. I have never seen the three together.',
    'The {name} is about {eta} away. Keep clear of the plume, the lightning is inside it.',
    'Dirty thunderstorm in the ash {direction}, under the aurora. Stay upwind.',
  ]),
  lifetime: Object.freeze({ duration: Object.freeze([300, 400]), despawn: Object.freeze({ distance: 40000, hysteresis: 5000, outOfViewSeconds: 30 }) }),
  combo: Object.freeze({
    preconditions: Object.freeze({
      biomes: Object.freeze(['snow']),
      timeOfDay: Object.freeze(['night']),
      siteActive: Object.freeze(['volcano']),
      near: Object.freeze({ sites: Object.freeze(['volcano']), radius: 12000 }),
    }),
    members: Object.freeze([]),
    exclusive: true,
  }),
});
