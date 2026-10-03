// Preset 9: Slot canyon run (uncommon site). A canyon 2.4-3.6 km long carved down the slope (the
// carve stamp) with twisting walls and a river on its floor. Cairns with white pennants mark the
// entry and red ones the exit; flying in through one end starts the clock, out through the other
// stops it. A run is clean without a soft crash and without climbing out above the rim (the course
// corridor), and the journal keeps the best clean time (journalStat bestCanyonRun, op min). Either
// end may be the start. Docs: docs/engines/structure.md (recipe gates).
export default Object.freeze({
  id: 'slotCanyon',
  name: 'Slot canyon',
  category: 'geo',
  kind: 'site',
  rarity: 'uncommon',
  heavy: false,
  placement: {
    chance: 0.14,
    minSpacing: 16000,
    biomes: ['dunes', 'pine', 'meadows'],
    surface: 'land',
    terrain: { minHeight: 60, relief: 'any' },
    clearance: 400,
    align: 'downhill',
  },
  filters: {
    biomes: null,
    timeOfDay: null,
    altitude: { min: 0, max: 4000 },
    weather: null,
    surface: 'land',
    minDistance: 0,
    maxDistance: 20000,
  },
  stamps: [{ type: 'carve', length: [2400, 3600], width: [38, 54], depth: [80, 110], wallWidth: [18, 28], twist: [200, 340], plateau: [40, 70], shoulder: [110, 150], segments: 16, paint: 'riverbed' }],
  engines: [
    {
      engine: 'structure',
      params: {
        recipe: 'gates', journal: 'bestCanyonRun', corridor: true, river: true, riverWidth: 0.55, ceiling: 20, margin: 6, markerHeight: 5,
        audioIntensity: 'constant', audioLevel: 0.35,
      },
    },
  ],
  lod: { near: 2000, mid: 6000, far: 14000 },
  lure: null,
  wind: [],
  audio: { recipe: 'waterfall', params: { refDistance: 60, size: 40 } },
  journal: { title: 'Slot canyon', description: 'A twisting canyon with a river at its floor; the journal keeps your best clean run.' },
  discovery: { radius: 2500, requireInView: true },
  callouts: [
    'Slot canyon {distance} {direction}. Fly it end to end for a timed run.',
    'Canyon entrance {direction}, {distance} out. Stay below the rim for a clean run.',
    'The {name} is about {eta} away, {direction}. The cairns mark the start and finish.',
  ],
  lifetime: { duration: null, despawn: { distance: 14000, hysteresis: 3000, outOfViewSeconds: 20 } },
});
