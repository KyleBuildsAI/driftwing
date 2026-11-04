// How ?test=spawns (src/dev/spawnsTest.js) shows presets 31-40: one scenario per preset, in spec order,
// in the shape src/dev/spawnScenarios.js documents. Dev builds only. The weather events stand ahead of
// the craft at an hour and in weather that suit them, their volumes grown at once; the volcanic and
// geo sites stand on their nearest REAL placed site (their stamps, waters and overlays are in the
// terrain). The staging matches tools/steps/presets-31-40.json.

/** Weather volumes shown grown and parked (a still does not wait minutes for a front to form). */
const GROWN_STILL = Object.freeze({
  weatherVolume: Object.freeze({ formSeconds: 0, drift: Object.freeze({ speed: 0 }) }),
});

export const BATCH31_SCENARIOS = Object.freeze([
  // ---- Weather and sky (31-34) ----
  {
    id: 'sandstormWall', why: 'late afternoon over the dunes, the low sun on the rolling wall', sun: 18, weather: 'clear',
    anchor: 'land', distance: 6000, runSeconds: 5, params: GROWN_STILL,
    view: { distance: 7000, height: 300, bearing: 200, lift: 600, fov: 65 },
  },
  {
    id: 'snowSquall', why: 'a grey afternoon in the snow country, the squall line marching in', sun: 14, weather: 'building',
    anchor: 'land', distance: 4000, runSeconds: 5, params: GROWN_STILL,
    view: { distance: 4500, height: 250, bearing: 200, lift: 600 },
  },
  {
    id: 'hurricaneEye', why: 'a clear day high over the ocean, the eyewall seen from inside the eye', sun: 40, weather: 'clear',
    anchor: 'water', distance: 20000, altitudeMsl: 3000, runSeconds: 5, params: GROWN_STILL,
    view: { distance: 1500, height: 3500, bearing: 180, lift: 3500, fov: 80 },
  },
  {
    id: 'valleyFogRiver', why: 'just after sunrise: the fog in the valleys lit gold, the peaks clear above it', sun: 4, morning: true, weather: 'clear',
    anchor: 'land', distance: 4000, altitude: 400, runSeconds: 6, params: GROWN_STILL,
    view: { distance: 3500, height: 700, bearing: 200, lift: 0, fov: 70 },
  },
  // ---- Volcanic and geo (35-40) ----
  {
    id: 'dirtyThunderstorm', why: 'a stormy dusk, so the lightning inside the ash cloud reads', sun: -2, weather: 'storm',
    anchor: 'land', distance: 8000, altitude: 600, runSeconds: 8, params: GROWN_STILL,
    view: { distance: 9000, height: 600, bearing: 200, lift: 3500, fov: 70 },
  },
  {
    id: 'lavaRiversToSea', why: 'twilight, so the lava glows and lights the steam over the sea entries', sun: -4, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 300, runSeconds: 8,
    view: { distance: 1100, height: 320, bearing: 200, lift: 20 },
  },
  {
    id: 'fissureEruption', why: 'night, so the curtain of fire lights the gas and the cloud deck above', sun: -14, weather: 'clear',
    anchor: 'site', distance: 4000, altitude: 400, runSeconds: 8, params: Object.freeze({ weatherVolume: Object.freeze({ formSeconds: 0 }) }),
    view: { distance: 2400, height: 300, bearing: 200, lift: 150, fov: 65 },
  },
  {
    id: 'meteorCraterLake', why: 'a low afternoon sun raking across the rim and the ejecta', sun: 18, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 300, runSeconds: 4,
    view: { distance: 1300, height: 420, bearing: 200, lift: 0 },
  },
  {
    id: 'hotSpringTerraces', why: 'a cool clear morning, the steam bright over the turquoise pools', sun: 14, morning: true, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 200, runSeconds: 6,
    view: { distance: 650, height: 200, bearing: 200, lift: 0 },
  },
  {
    id: 'saltFlatMirror', why: 'sunset, the sky glowing in the mirror', sun: 3, weather: 'clear',
    anchor: 'site', distance: 2500, altitude: 120, runSeconds: 4,
    view: { distance: 900, height: 60, bearing: 200, lift: 0, fov: 70 },
  },
]);
