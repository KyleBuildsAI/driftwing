// How ?test=spawns shows presets 41-50 (the ocean set and the first wildlife presets), in spec order.
// Dev builds only; src/dev/spawnScenarios.js holds the field reference. The staging follows
// tools/steps/presets-41-50.json. The sites stand on their real sites where the seed has one within
// reach (the step file's seed P3-B5-37 has all six), else on a spot of their surface.

export const BATCH41_SCENARIOS = Object.freeze([
  {
    id: 'calvingGlacier', why: 'afternoon light on the ice front and the bergs', sun: 24, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 300, runSeconds: 5,
    view: { distance: 1400, height: 260, bearing: 200, lift: 20 },
  },
  {
    id: 'coralAtoll', why: 'a high sun into the clear lagoon', sun: 55, weather: 'clear',
    anchor: 'site', distance: 2000, altitude: 500, runSeconds: 5,
    view: { distance: 1500, height: 900, bearing: 200, lift: 0 },
  },
  {
    id: 'reefShipwreck', why: 'a high sun through the clear shallows onto the wreck', sun: 55, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 250, runSeconds: 5,
    view: { distance: 120, height: 90, bearing: 200, lift: -8 },
  },
  {
    id: 'dolphinPod', why: 'a bright afternoon on a coastal sea', sun: 35, weather: 'clear',
    anchor: 'coast', distance: 1200, altitude: 120, runSeconds: 8,
    view: { distance: 90, height: 22, bearing: 200, lift: 0 },
  },
  {
    id: 'seaStacks', why: 'the afternoon sun on the rock', sun: 28, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 200, runSeconds: 4,
    view: { distance: 800, height: 160, bearing: 200, lift: 30 },
  },
  {
    id: 'rogueWave', why: 'open ocean in the afternoon, the wave crossing broadside', sun: 30, weather: 'clear',
    anchor: 'water', distance: 2500, altitude: 200, runSeconds: 12,
    view: { distance: 1600, height: 120, bearing: 200, lift: 5 },
  },
  {
    id: 'tidalBore', why: 'the afternoon light up the estuary', sun: 30, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 300, runSeconds: 6,
    view: { distance: 1400, height: 500, bearing: 200, lift: 0 },
  },
  {
    id: 'batsAtDusk', why: 'dusk over the mountains, the bats against the afterglow', sun: 1, weather: 'clear',
    anchor: 'land', distance: 2500, altitude: 300, runSeconds: 10,
    view: { distance: 1600, height: 200, bearing: 200, lift: 300 },
  },
  {
    id: 'herdStampede', why: 'the plains in the afternoon', sun: 30, weather: 'clear',
    anchor: 'land', distance: 1500, altitude: 150, runSeconds: 5,
    view: { distance: 220, height: 50, bearing: 200, lift: 0 },
  },
  {
    id: 'flamingoLake', why: 'low afternoon sun on the pink water', sun: 18, weather: 'clear',
    anchor: 'site', distance: 1500, altitude: 150, runSeconds: 5,
    view: { distance: 650, height: 140, bearing: 200, lift: 0 },
  },
]);
