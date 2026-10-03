// Thermal hawks* (Phase 2 preset 16): a common daytime event over open land.
//
// Three to six hawks circle inside the Phase 1 thermals (WindField.thermalsNear), climbing with the
// column's lean and gliding on to the next one: the visual marker for lift. Their flight effect is
// the thermal itself, so the preset authors no wind source of its own (wind is []): circle where the
// hawks circle and the WindField's thermal carries you up with them. circling.requireThermal keeps
// them honest: a group that finds no working thermal ends before it is drawn, and a fading thermal is
// ridden out rather than swapped for empty air. Only in the thermal hours (filters.timeOfDay
// 'midday': the sun at least 14 degrees up). They scream now and then (raptor recipe). Pure data.
export default Object.freeze({
  id: 'thermalHawks',
  name: 'Thermal hawks',
  category: 'wildlife',
  kind: 'event',
  rarity: 'common',
  heavy: false,
  candidates: { cellSize: 4500, bucketSeconds: 300, chance: 0.5 },
  filters: {
    biomes: ['meadows', 'dunes', 'pine'],
    timeOfDay: ['midday'],
    altitude: { min: 0, max: 3000 },
    weather: ['clear', 'building', 'clearing'],
    surface: 'land',
    minDistance: 3000,
    maxDistance: 7500,
  },
  engines: [
    {
      engine: 'fauna',
      params: {
        species: 'hawk',
        behavior: 'circling',
        count: [3, 6],
        size: 1.4,
        fadeIn: 3,
        fadeOut: 10,
        voiceIntensity: 0.8,
        circling: {
          radius: [45, 80],
          climb: 1.4,
          bottom: 120,
          top: 1100,
          thermals: 2,
          thermalSearch: 2600,
          thermalRefresh: 12,
          requireThermal: true,
        },
        calls: { trigger: 'call', interval: [18, 45] },
      },
    },
  ],
  lod: { near: 1500, mid: 4000, far: 8000 },
  lure: null,
  wind: [],
  audio: { recipe: 'raptor', params: { pitch: 1 } },
  journal: { title: 'Thermal hawks', description: 'Hawks wheeling in a thermal: where they circle, the air is rising.' },
  discovery: { radius: 1500, requireInView: true },
  callouts: [
    'Hawks circling {direction}, {distance} out. That is a thermal.',
    'Birds wheeling {distance} {direction}: free lift under them.',
    'Thermal marked by hawks about {eta} away, {direction}. Circle where they circle.',
    'Hawks climbing {direction}. Want the lift? {distance}.',
  ],
  lifetime: { duration: [300, 480], despawn: { distance: 9000, hysteresis: 2500, outOfViewSeconds: 20 } },
});
