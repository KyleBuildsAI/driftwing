// ?test=spawns scenarios for presets 71-80 (wave 3, batch 8), in spec order; src/dev/spawnScenarios.js
// lists them after the Phase 2 presets and documents every field. The staging follows
// tools/steps/presets-71-80.json: the clouds of the weather events show formed at once
// (formSeconds 0), the wisps at night over the forest, the challenge courses in the light that shows
// their scenery best. A site preset without a real site within reach is built on land ahead, where
// its recipe raises its own cliff, canyon line or mountain.

/** The weather volumes of an event shown formed (the shear line's cloud edge, the cloud street). */
const FORMED_CLOUDS = Object.freeze({ weatherVolume: Object.freeze({ formSeconds: 0 }) });

export const BATCH8_SCENARIOS = Object.freeze([
  // ---- Fantasy (71-72) ----
  {
    id: 'reverseWaterfall', why: 'afternoon sun on the rising column and its mist cloud', sun: 30, weather: 'clear',
    anchor: 'site', distance: 2500, runSeconds: 6,
    view: { distance: 1100, height: 120, bearing: 200, lift: 280, fov: 60 },
  },
  {
    id: 'forestWisps', why: 'night over the forest, the wisps lighting the treetops', sun: -25, weather: 'clear',
    anchor: 'land', distance: 1200, runSeconds: 5,
    view: { distance: 90, height: 25, bearing: 200, lift: 10 },
  },
  // ---- Flight-play (73-80) ----
  {
    id: 'ridgeLiftBand', why: 'a clear afternoon, the cap cloud bright along the crest', sun: 30, weather: 'clear',
    anchor: 'site', distance: 3000, runSeconds: 5,
    view: { distance: 2600, height: 260, bearing: 160, lift: 120, fov: 65 },
  },
  {
    id: 'windShearLine', why: 'a clear afternoon, the sharp cloud edge seen from below and beside it', sun: 25, weather: 'clear',
    anchor: 'land', distance: 5000, runSeconds: 5, params: FORMED_CLOUDS,
    view: { distance: 7000, height: 300, bearing: 200, lift: 850, fov: 70 },
  },
  {
    id: 'thermalStreet', why: 'midday, the cumulus rows lined up with the wind', sun: 55, weather: 'clear',
    anchor: 'land', distance: 5000, runSeconds: 5, params: FORMED_CLOUDS,
    view: { distance: 7500, height: 700, bearing: 180, lift: 1500, fov: 70 },
  },
  {
    id: 'canyonGauntlet', why: 'high sun, so light reaches the canyon floor and its rock gates', sun: 50, weather: 'clear',
    anchor: 'site', distance: 2000, runSeconds: 4,
    view: { distance: 700, height: 220, bearing: 200, lift: 20 },
  },
  {
    id: 'caveTunnel', why: 'a clear afternoon on the rock mountain and its portal', sun: 35, weather: 'clear',
    anchor: 'site', distance: 2000, runSeconds: 4,
    view: { distance: 950, height: 120, bearing: 200, lift: 90 },
  },
  {
    id: 'waterfallWall', why: 'afternoon sun across the falls and the mist at their foot', sun: 30, weather: 'clear',
    anchor: 'site', distance: 2000, runSeconds: 5,
    view: { distance: 1000, height: 90, bearing: 200, lift: 70 },
  },
  {
    id: 'balloonFestival', why: 'a clear morning over the field, the balloons lit from the side', sun: 18, morning: true, weather: 'clear',
    anchor: 'site', distance: 2000, runSeconds: 4,
    view: { distance: 650, height: 90, bearing: 200, lift: 50 },
  },
  {
    id: 'kiteSlalom', why: 'a breezy afternoon on the hilltop, the kites up', sun: 30, weather: 'clear',
    anchor: 'site', distance: 1800, runSeconds: 4,
    view: { distance: 380, height: 60, bearing: 200, lift: 70 },
  },
]);
