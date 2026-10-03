// How ?test=spawns (src/dev/spawnsTest.js) shows each of the 30 Phase 2 presets: one scenario per
// preset, in spec order. Dev builds only. The staging comes from the preset step files
// (tools/steps/presets-batch1.json, presets-batch2.json and presets-21-30.json), so every preset is
// seen at a time of day and in weather that suit it.
//
// A scenario:
//   id          the preset id
//   why         one line: why this time and weather suit it (shown in the report)
//   sun         sun elevation in degrees; morning: true puts it on the morning side (default evening)
//   weather     the regional weather held during the show: clear | building | storm | clearing
//   anchor      where the spawn stands:
//                 'site'    the preset's nearest REAL placed site (with its terrain stamps), when one
//                           lies within reach; otherwise land (or water for a water site) ahead
//                 'land' | 'water' | 'coast'   a spot of that surface near the start, ahead of the craft
//                           (land is open lowland: fields and meadows, not the mountains)
//                 'thermal' 200 m from the nearest working thermal (the hawks circle in it)
//                 'sky'     a sky-anchored event: the spawn stands at the craft (distance 0)
//   distance    metres from the craft to the anchor when the spawn is created
//   altitude    the craft's height above the ground (m) while it approaches (default 150);
//               altitudeMsl replaces it with a height above sea level
//   speed       the craft's autopilot airspeed (m/s; default 55)
//   heading     'downSun' flies away from the sun (default: the spawn's heading)
//   runSeconds  seconds of live flight toward the spawn before the screenshot (fps measured here)
//   params      activation overrides per engine ({ [engine]: { ...params } }), like a set piece child
//   stage       a named staging step before the screenshot (spawnsTest.js STAGES)
//   view        the screenshot: mode 'world' (default: the free camera `distance` m from the anchor,
//               `height` m up, at `bearing` degrees from the craft's heading, aimed `lift` m above the
//               anchor, or at `offset` [right, up, forward] in the heading's frame; `child` frames a set
//               piece child's anchor instead; a flying flock's anchor is its live centre, so a short
//               distance puts the camera inside a circling flock), 'sky' (from the craft toward the spawn's sky anchor,
//               `lookUp` m higher), 'sun' (from the craft at the sun), 'player' (the free camera
//               `distance` m from the craft at `bearing`, `height` up, looking at the craft, or with
//               look 'antisolar' down-sun at the craft's shadow, or look 'pair' between the craft and
//               the spawn, a wingman off the wing); fov in degrees

/** Activation overrides the batch 1 step file used to show a storm at its mature stage at once. */
const MATURE_VORTEX = Object.freeze({
  vortex: Object.freeze({ startStage: 'mature', trackSpeed: 0 }),
  weatherVolume: Object.freeze({ formSeconds: 0, drift: Object.freeze({ speed: 0 }) }),
});

export const SPAWN_SCENARIOS = Object.freeze([
  // ---- Weather and sky (1-6) ----
  {
    id: 'tornado', why: 'a storm in the late afternoon light', sun: 28, weather: 'storm',
    anchor: 'land', distance: 2500, runSeconds: 5, params: MATURE_VORTEX,
    view: { distance: 1700, height: 40, bearing: 200, lift: 380 },
  },
  {
    id: 'supercell', why: 'a building storm in the afternoon, the anvil seen from far off', sun: 18, weather: 'building',
    anchor: 'land', distance: 9000, runSeconds: 5,
    params: { weatherVolume: { formSeconds: 0, drift: { speed: 0 } }, windModifier: { drift: 0 } },
    view: { distance: 20000, height: 1500, bearing: 200, lift: 5000, fov: 70 },
  },
  {
    id: 'waterspout', why: 'building weather over open water', sun: 22, weather: 'building',
    anchor: 'water', distance: 2000, runSeconds: 5, params: MATURE_VORTEX,
    view: { distance: 1800, height: 120, bearing: 200, lift: 330 },
  },
  {
    id: 'lenticular', why: 'a clear, windy morning over the peaks, low sun on the lenses', sun: 12, morning: true, weather: 'clear',
    anchor: 'land', distance: 6000, runSeconds: 4,
    params: { weatherVolume: { formSeconds: 0 }, windModifier: { fadeIn: 0 } },
    view: { distance: 9000, height: 500, bearing: 200, lift: 1400, fov: 55 },
  },
  {
    id: 'microburst', why: 'building weather in the afternoon', sun: 30, weather: 'building',
    anchor: 'land', distance: 2500, runSeconds: 5, params: { weatherVolume: { formSeconds: 0 } },
    view: { distance: 2600, height: 150, bearing: 200, lift: 500 },
  },
  {
    id: 'glory', why: 'above the cloud sea with the sun behind the craft', sun: 28, weather: 'clear',
    anchor: 'sky', distance: 2500, altitudeMsl: 1450, heading: 'downSun', runSeconds: 6,
    params: { weatherVolume: { formSeconds: 0 }, celestial: { fadeIn: 0 } },
    view: { mode: 'player', look: 'antisolar', distance: 60, height: 25, bearing: 180, fov: 75 },
  },
  // ---- Volcanic and geo (7-10) ----
  {
    id: 'volcano', why: 'twilight, so the lava glow lights the ash plume', sun: -3, weather: 'clear',
    anchor: 'site', distance: 5000, altitude: 500, runSeconds: 8,
    view: { distance: 3200, height: 900, bearing: 200, lift: 350 },
  },
  {
    id: 'geyserField', why: 'a clear late morning, steam bright against the ground', sun: 35, morning: true, weather: 'clear',
    anchor: 'site', distance: 1500, runSeconds: 10,
    view: { distance: 650, height: 120, bearing: 200, lift: 50 },
  },
  {
    id: 'slotCanyon', why: 'high sun, so light reaches the canyon floor', sun: 55, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 300, runSeconds: 4,
    view: { distance: 1100, height: 380, bearing: 200, lift: 0 },
  },
  {
    id: 'megaWaterfall', why: 'afternoon sun on the spray, the daytime rainbow in the mist', sun: 30, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 250, runSeconds: 5,
    view: { distance: 1000, height: 180, bearing: 200, lift: 100 },
  },
  // ---- Ocean (11-13) ----
  {
    id: 'whalePod', why: 'a bright day on a coastal sea', sun: 35, weather: 'clear',
    anchor: 'coast', distance: 1200, runSeconds: 8,
    view: { distance: 130, height: 30, bearing: 200, lift: 2 },
  },
  {
    id: 'maelstrom', why: 'afternoon light on the foam arms', sun: 25, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 300, runSeconds: 5,
    view: { distance: 750, height: 480, bearing: 200, lift: 60 },
  },
  {
    id: 'bioluminescentBay', why: 'night: the surf glows', sun: -25, weather: 'clear',
    anchor: 'site', distance: 1500, runSeconds: 6,
    view: { distance: 350, height: 60, bearing: 180, lift: 0 },
  },
  // ---- Wildlife (14-18) ----
  {
    id: 'starlingMurmuration', why: 'dusk over open land', sun: 4, weather: 'clear',
    anchor: 'land', distance: 900, runSeconds: 6,
    view: { distance: 650, height: 60, bearing: 200, lift: 20 },
  },
  {
    id: 'geeseFormation', why: 'a clear afternoon', sun: 30, weather: 'clear',
    anchor: 'land', distance: 400, runSeconds: 5,
    view: { distance: 150, height: 15, bearing: 200, lift: 0 },
  },
  {
    id: 'thermalHawks', why: 'midday, when the thermals work', sun: 50, weather: 'clear',
    anchor: 'thermal', distance: 1500, runSeconds: 6,
    view: { distance: 25, height: 15, bearing: 200, lift: 0, fov: 80 },
  },
  {
    id: 'fireflies', why: 'night over a meadow', sun: -25, weather: 'clear',
    anchor: 'land', distance: 900, altitude: 120, runSeconds: 5,
    view: { distance: 60, height: 5, bearing: 200, lift: 2 },
  },
  {
    id: 'eagleWingman', why: 'a clear afternoon, flying slowly enough for the eagle to join', sun: 30, weather: 'clear',
    anchor: 'land', distance: 1200, speed: 30, runSeconds: 6, stage: 'wingman',
    view: { mode: 'player', look: 'pair', distance: 28, height: 7, bearing: 192 },
  },
  // ---- Structures (19-21) ----
  {
    id: 'windFarm', why: 'an afternoon wind under a clear sky', sun: 30, weather: 'clear',
    anchor: 'site', distance: 2500, runSeconds: 5,
    view: { distance: 1300, height: 160, bearing: 200, lift: 60 },
  },
  {
    id: 'ropeBridge', why: 'afternoon light across the gorge', sun: 30, weather: 'clear',
    anchor: 'site', distance: 1500, runSeconds: 4,
    view: { distance: 260, height: 30, bearing: 90, lift: -30 },
  },
  {
    id: 'abandonedAirfield', why: 'low evening sun on the worn tarmac', sun: 12, weather: 'clear',
    anchor: 'site', distance: 1500, runSeconds: 4,
    view: { distance: 650, height: 110, bearing: 150, lift: 5 },
  },
  // ---- Night and celestial (22-25) ----
  {
    id: 'meteorShower', why: 'a clear night', sun: -32, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 8, stage: 'meteors',
    view: { mode: 'sky' },
  },
  {
    id: 'totalSolarEclipse', why: 'a clear morning, framed at totality', sun: 32, morning: true, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 3, stage: 'totality',
    view: { mode: 'sun' },
  },
  {
    id: 'comet', why: 'a clear night, the tail streaming away from the sun below the horizon', sun: -30, weather: 'clear',
    anchor: 'sky', distance: 0, runSeconds: 3, stage: 'cometFadeIn',
    view: { mode: 'sky' },
  },
  {
    id: 'skyLanternFestival', why: 'a clear night', sun: -22, weather: 'clear',
    anchor: 'land', distance: 1200, runSeconds: 8,
    view: { distance: 520, height: 60, bearing: 200, lift: 140 },
  },
  // ---- Fantasy (26-28) ----
  {
    id: 'floatingIslands', why: 'a clear afternoon over the sea', sun: 30, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 400, runSeconds: 5,
    view: { distance: 1500, height: 260, bearing: 200, lift: 250 },
  },
  {
    id: 'skyWhale', why: 'a clear afternoon at the cloud layer', sun: 35, weather: 'clear',
    anchor: 'land', distance: 1500, altitude: 500, runSeconds: 12,
    view: { distance: 750, height: 120, bearing: 130, lift: 0 },
  },
  {
    id: 'crystalSpires', why: 'twilight, so the spires glow', sun: -7, weather: 'clear',
    anchor: 'site', distance: 1500, runSeconds: 4,
    view: { distance: 420, height: 70, bearing: 200, lift: 45 },
  },
  // ---- Flight-play (29) ----
  {
    id: 'jetStream', why: 'a clear day high up', sun: 40, weather: 'clear',
    anchor: 'land', distance: 4000, altitude: 1800, runSeconds: 5,
    view: { distance: 2600, height: 450, bearing: 140, offset: [0, 2200, 0] },
  },
  // ---- Legendary set piece (30) ----
  {
    id: 'stormChase', why: 'a stormy afternoon, framed as the wall cloud lowers', sun: 28, weather: 'storm',
    anchor: 'land', distance: 9000, runSeconds: 8, stage: 'wallCloud',
    view: { child: 'supercell', distance: 9000, height: 250, bearing: 180, lift: 900 },
  },
]);
