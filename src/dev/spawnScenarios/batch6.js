// How ?test=spawns shows the batch 6 presets (51-60), in spec order: the same scenario fields as
// src/dev/spawnScenarios.js (its header lists them). Dev builds only. The staging follows the batch's
// step file (tools/steps/presets-51-60.json): each preset at a time of day and in weather that suit it.

export const BATCH6_SCENARIOS = Object.freeze([
  // ---- Wildlife (51-52) ----
  {
    id: 'butterflyMigration', why: 'a bright day over open land, the cloud low and orange', sun: 35, weather: 'clear',
    anchor: 'land', distance: 900, altitude: 60, runSeconds: 6,
    view: { distance: 140, height: 25, bearing: 200, lift: 20 },
  },
  {
    id: 'caribouMigration', why: 'low morning sun along the column on the tundra', sun: 16, morning: true, weather: 'clear',
    anchor: 'land', distance: 1800, altitude: 150, runSeconds: 6,
    view: { distance: 420, height: 130, bearing: 160, lift: 0 },
  },
  // ---- Structures (53-59) ----
  {
    id: 'cliffsideMonastery', why: 'a clear afternoon, the flags lit against the cliff', sun: 22, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 300, runSeconds: 5,
    view: { distance: 380, height: 60, bearing: 200, lift: 40 },
  },
  {
    id: 'seaCliffCastle', why: 'a low evening sun on the keep and the sea', sun: 12, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 200, runSeconds: 5,
    view: { distance: 260, height: 50, bearing: 200, lift: 25 },
  },
  {
    id: 'mountaintopObservatory', why: 'night: the dome open and the telescope raised', sun: -14, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 300, runSeconds: 6, params: { structure: { openSeconds: 3, slewRate: 20 } },
    view: { distance: 140, height: 30, bearing: 200, lift: 12 },
  },
  {
    id: 'steamTrainViaduct', why: 'a clear afternoon, the train out on the viaduct', sun: 26, weather: 'clear',
    anchor: 'site', distance: 2200, altitude: 250, runSeconds: 6, params: { structure: { start: 0.42 } },
    view: { distance: 420, height: 40, bearing: 200, lift: 20 },
  },
  {
    id: 'damSpillway', why: 'afternoon sun behind the camera, the rainbow in the spray', sun: 30, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 250, runSeconds: 5,
    view: { distance: 330, height: 40, bearing: 200, lift: 10 },
  },
  {
    id: 'desertOasisCaravan', why: 'a clear late afternoon in the dunes', sun: 25, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 200, runSeconds: 6,
    view: { distance: 300, height: 90, bearing: 200, lift: 0 },
  },
  {
    id: 'labyrinth', why: 'a high sun, seen from above so the maze reads', sun: 45, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 350, runSeconds: 4,
    view: { distance: 120, height: 280, bearing: 200, lift: 0, fov: 60 },
  },
  // ---- Night and celestial (60) ----
  {
    id: 'fireballImpact', why: 'a clear night, a few seconds after the impact', sun: -20, weather: 'clear',
    anchor: 'land', distance: 4000, altitude: 300, runSeconds: 9,
    params: { structure: { delay: 0.5, fall: 3 }, emitter: { startDelay: 3.5 } },
    view: { distance: 700, height: 150, bearing: 200, lift: 20 },
  },
]);
