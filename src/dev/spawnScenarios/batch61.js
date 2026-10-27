// ?test=spawns scenarios of presets 61-70 (Phase 3 wave 3, batch 7), in spec order; the fields are
// described in src/dev/spawnScenarios.js. The staging follows tools/steps/presets-61-70.json: the night
// sky at the hours each part of it belongs to, the fantasy sites from where they read best.
export const BATCH61_SCENARIOS = Object.freeze([
  // ---- Night and celestial (61-65) ----
  {
    id: 'bloodMoon', why: 'a clear night, the eclipsed moon in view', sun: -32, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 8,
    view: { mode: 'sky' },
  },
  {
    id: 'greenFlash', why: 'the evening sun on the horizon', sun: 0.4, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 3,
    view: { mode: 'sun' },
  },
  {
    id: 'noctilucentClouds', why: 'deep dusk, the sun 9 degrees down', sun: -9, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 5,
    view: { mode: 'sky' },
  },
  {
    id: 'milkyWayCore', why: 'a clear, dark night', sun: -38, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 5,
    view: { mode: 'sky' },
  },
  {
    id: 'moonbow', why: 'a clear night under the moon', sun: -30, weather: 'clear',
    anchor: 'land', distance: 1500, runSeconds: 5,
    view: { distance: 900, height: 80, bearing: 180, lift: 120 },
  },
  // ---- Fantasy (66-70) ----
  {
    id: 'worldTree', why: 'a clear afternoon, the tree from inside the haze range', sun: 22, weather: 'clear',
    anchor: 'land', distance: 3000, runSeconds: 3,
    view: { distance: 1400, height: 250, bearing: 200, lift: 550 },
  },
  {
    id: 'portalRing', why: 'a clear afternoon, the membrane head on', sun: 18, weather: 'clear',
    anchor: 'land', distance: 1200, runSeconds: 3,
    view: { distance: 230, height: 25, bearing: 200, lift: 50 },
  },
  {
    id: 'sleepingGiant', why: 'a clear midday, the figure seen from high above', sun: 35, weather: 'clear',
    anchor: 'site', distance: 4000, altitude: 900, runSeconds: 4,
    view: { distance: 2000, height: 2500, bearing: 120, lift: -200 },
  },
  {
    id: 'ghostGalleon', why: 'a night with clouds about, at their tops', sun: -24, weather: 'clearing',
    anchor: 'land', distance: 2500, runSeconds: 3,
    view: { distance: 230, height: 40, bearing: 120, lift: 20 },
  },
  {
    id: 'dragonRacer', why: 'a clear afternoon, the dragon on its crag', sun: 24, weather: 'clear',
    anchor: 'land', distance: 1500, runSeconds: 3,
    view: { distance: 260, height: 40, bearing: 200, lift: 90 },
  },
]);
