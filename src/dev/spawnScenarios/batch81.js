// How ?test=spawns (src/dev/spawnsTest.js) shows presets 81-90: one scenario per preset, in spec order,
// in the shape src/dev/spawnScenarios.js documents. Dev builds only. Every one of them is a site, shown
// on its nearest REAL placed site (its stamps, waters and region overlay are in the terrain), at an hour
// and in weather that suit it; the staging matches tools/steps/presets-81-90.json.

export const BATCH81_SCENARIOS = Object.freeze([
  // ---- Flight-play (81) ----
  {
    id: 'fiveArchChain', why: 'low afternoon sun across the strata of the arches', sun: 16, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 120, runSeconds: 4,
    view: { distance: 900, height: 140, bearing: 160, lift: 25 },
  },
  // ---- Biome set pieces (82-90) ----
  {
    id: 'cherryBlossomValley', why: 'a bright spring afternoon, the canopy pink in the sun', sun: 32, weather: 'clear',
    anchor: 'site', distance: 1800, runSeconds: 6,
    view: { distance: 420, height: 70, bearing: 200, lift: 10 },
  },
  {
    id: 'autumnColourWave', why: 'golden afternoon light on the turning woods', sun: 14, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 200, runSeconds: 5,
    view: { distance: 1500, height: 420, bearing: 200, lift: 0 },
  },
  {
    id: 'lavenderTulipStripes', why: 'a clear midday sun, the rows bright from above', sun: 45, weather: 'clear',
    anchor: 'site', distance: 1800, altitude: 250, runSeconds: 4,
    view: { distance: 700, height: 260, bearing: 200, lift: 0 },
  },
  {
    id: 'riceTerraces', why: 'just after sunrise: the mist in the steps, the flooded paddies mirroring the sky', sun: 4, morning: true, weather: 'clear',
    anchor: 'site', distance: 1800, altitude: 180, runSeconds: 5,
    view: { distance: 650, height: 220, bearing: 180, lift: 0 },
  },
  {
    id: 'redwoodGiants', why: 'a high sun reaching between the giant trunks', sun: 50, weather: 'clear',
    anchor: 'site', distance: 1800, altitude: 180, runSeconds: 5,
    view: { distance: 260, height: 60, bearing: 200, lift: 20 },
  },
  {
    id: 'badlandsHoodoos', why: 'low evening sun on the banded pillars', sun: 12, weather: 'clear',
    anchor: 'site', distance: 1800, runSeconds: 4,
    view: { distance: 650, height: 110, bearing: 200, lift: 15 },
  },
  {
    id: 'mangroveDelta', why: 'dawn: the mist lying over the channels and the roots', sun: 3, morning: true, weather: 'clear',
    anchor: 'site', distance: 2200, altitude: 200, runSeconds: 6,
    view: { distance: 480, height: 110, bearing: 180, lift: 0 },
  },
  {
    id: 'cactusDustDevils', why: 'a hot afternoon, the dust devils lit against the desert', sun: 38, weather: 'clear',
    anchor: 'site', distance: 1800, runSeconds: 6,
    view: { distance: 520, height: 70, bearing: 200, lift: 40 },
  },
  {
    id: 'bambooForest', why: 'a breezy late morning, the grove swaying in the sun', sun: 30, morning: true, weather: 'clear',
    anchor: 'site', distance: 1800, runSeconds: 5,
    view: { distance: 260, height: 60, bearing: 200, lift: 6 },
  },
]);
